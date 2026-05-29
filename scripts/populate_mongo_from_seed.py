"""
populate_mongo_from_seed.py — Poblar PanelCSTickets (Mongo Atlas) desde el seed servido por n8n.

Toma el seed que sirve /webhook/cs-seed (gzip+base64), lo deserializa, mapea cada
ticket de snake_case (formato carga_inicial.py) a camelCase (formato Mongo) y
hace bulk upsert por ticketId en PanelCSTickets.

Idempotente: usa updateOne con upsert. Re-correr es seguro — actualiza los docs
existentes, inserta los nuevos.

Uso:
    set -a; source .env.credentials; set +a
    python outputs/cs-panel/scripts/populate_mongo_from_seed.py [--dry-run] [--limit N]

--dry-run: muestra 3 docs mapeados sin escribir nada.
--limit N: limita a los primeros N tickets (para test).

Requiere en .env.credentials: MONGO_HOST2, MONGO_USER2, MONGO_PASS2
"""
import argparse
import base64
import gzip
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

try:
    import pymongo
    from pymongo import UpdateOne
except ImportError:
    sys.exit("ERROR: pymongo no instalado. Ejecuta: python -m pip install pymongo")

SEED_URL = "https://prod-low-code.iconstruye.dev/webhook/cs-seed"
DB_NAME = "automatizaciones"
COLLECTION = "PanelCSTickets"
META_COLLECTION = "PanelCSMeta"
BULK_BATCH = 500  # upsert en chunks de 500 para no saturar la conexión


def connect():
    host = os.environ["MONGO_HOST2"]
    user = os.environ["MONGO_USER2"]
    pwd  = urllib.parse.quote_plus(os.environ["MONGO_PASS2"])
    uri = f"mongodb+srv://{user}:{pwd}@{host}/?retryWrites=true&w=majority"
    client = pymongo.MongoClient(uri, serverSelectionTimeoutMS=10000)
    client.server_info()
    return client


def parse_iso(s):
    """Convierte ISO string a datetime UTC. None si no es válido."""
    if not s:
        return None
    if isinstance(s, datetime):
        return s
    try:
        # Zendesk usa 'Z' al final
        if s.endswith("Z"):
            s = s.replace("Z", "+00:00")
        return datetime.fromisoformat(s).astimezone(timezone.utc).replace(tzinfo=None)
    except Exception:
        return None


def map_ticket(t: dict, generated_at: str) -> dict:
    """Mapea slim_ticket (snake_case carga_inicial.py) → schema Mongo (camelCase)."""
    return {
        "ticketId": int(t["id"]),
        "subject": t.get("subject") or "",
        "status": t.get("status"),
        "priority": t.get("priority"),
        "type": t.get("type"),
        "createdAt": parse_iso(t.get("created_at")),
        "updatedAt": parse_iso(t.get("updated_at")),
        "solvedAt": parse_iso(t.get("solved_at")),
        "closedAt": parse_iso(t.get("closed_at")),
        "frtMin": t.get("frt_min"),
        "reopens": t.get("reopens"),
        "groupId": str(t["group_id"]) if t.get("group_id") is not None else None,
        "assigneeId": str(t["assignee_id"]) if t.get("assignee_id") is not None else None,
        "organizationId": str(t["organization_id"]) if t.get("organization_id") is not None else None,
        "slaBreached": t.get("sla_breached"),
        "slaActiveBreaches": [
            {
                "metric": b.get("metric"),
                "stage": b.get("stage"),
                "breachAt": parse_iso(b.get("breach_at")),
            }
            for b in (t.get("sla_active_breaches") or [])
        ],
        "nivel": t.get("nivel"),
        "seguimiento": t.get("seguimiento"),
        "merged": t.get("merged"),
        "csat": t.get("csat"),
        "lineaNegocio": t.get("linea_negocio"),
        "categoria": t.get("categoria"),
        "producto": t.get("producto"),
        "subproducto": t.get("subproducto"),
        "pasoSn1": t.get("paso_sn1"),
        "escSn2": t.get("esc_sn2"),
        "escMo": t.get("esc_mo"),
        "devol": t.get("devol"),
        "viaChannel": t.get("via_channel"),
        "canalNormalizado": t.get("canal_normalizado"),
        "chatSubtype": t.get("chat_subtype"),
        "aircallCallId": t.get("aircall_call_id"),
        "_syncedAt": datetime.utcnow(),
        "_syncSource": "populate_mongo_from_seed.py",
        "_seedGeneratedAt": parse_iso(generated_at),
    }


def fetch_seed():
    print(f"  bajando seed desde {SEED_URL}...")
    t0 = time.time()
    raw = urllib.request.urlopen(SEED_URL, timeout=120).read()
    j = json.loads(raw)
    if not j.get("gz"):
        sys.exit(f"ERROR: respuesta sin campo 'gz'. Keys: {list(j.keys())}")
    seed = json.loads(gzip.decompress(base64.b64decode(j["gz"])).decode("utf-8"))
    print(f"  seed bajado en {time.time()-t0:.1f}s · {len(raw):,}b raw · {len(seed.get('tickets', [])):,} tickets")
    return seed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=None, help="Limitar a N tickets")
    args = ap.parse_args()

    seed = fetch_seed()
    tickets = seed.get("tickets", [])
    meta = seed.get("meta") or {}
    generated_at = meta.get("generated_at")
    if args.limit:
        tickets = tickets[: args.limit]
        print(f"  --limit {args.limit}: procesando solo {len(tickets)} tickets")

    print()
    print(f"=== Mapeo + upsert a {DB_NAME}.{COLLECTION} ===")

    if args.dry_run:
        # Mostrar 3 docs mapeados
        for i, t in enumerate(tickets[:3]):
            m = map_ticket(t, generated_at)
            print(f"\n--- doc {i+1} (ticketId={m['ticketId']}) ---")
            for k, v in m.items():
                v_repr = repr(v)[:80]
                print(f"  {k}: {v_repr}")
        print(f"\n[DRY-RUN] no se escribió nada en Mongo. Total a procesar: {len(tickets)}")
        return

    client = connect()
    col = client[DB_NAME][COLLECTION]

    # Bulk upserts en batches
    total = 0
    upserted_new = 0
    modified = 0
    matched = 0
    t0 = time.time()
    for batch_start in range(0, len(tickets), BULK_BATCH):
        batch = tickets[batch_start : batch_start + BULK_BATCH]
        ops = []
        for t in batch:
            mapped = map_ticket(t, generated_at)
            ops.append(UpdateOne(
                {"ticketId": mapped["ticketId"]},
                {"$set": mapped},
                upsert=True,
            ))
        result = col.bulk_write(ops, ordered=False)
        total += len(batch)
        upserted_new += len(result.upserted_ids)
        modified += result.modified_count
        matched += result.matched_count
        print(f"  batch {batch_start//BULK_BATCH + 1:>3}: procesados={total:>6,}/{len(tickets):,} · "
              f"insertados={upserted_new:,} · modificados={modified:,} · elapsed={time.time()-t0:.1f}s")

    print()
    print(f"=== Resumen ===")
    print(f"  total procesados: {total:,}")
    print(f"  insertados nuevos: {upserted_new:,}")
    print(f"  modificados: {modified:,}")
    print(f"  matched (sin cambio): {matched - modified:,}")
    print(f"  elapsed: {time.time()-t0:.1f}s")

    # Actualizar meta en PanelCSMeta
    meta_col = client[DB_NAME][META_COLLECTION]
    meta_col.update_one(
        {"key": "lastFullSync"},
        {"$set": {
            "key": "lastFullSync",
            "value": {
                "totalTickets": total,
                "source": "populate_mongo_from_seed.py",
                "seedGeneratedAt": parse_iso(generated_at),
            },
            "updatedAt": datetime.utcnow(),
            "notes": "Última carga masiva desde el seed servido por /webhook/cs-seed",
        }},
        upsert=True,
    )
    print(f"  PanelCSMeta.lastFullSync actualizado")

    # Validar conteo final
    final_count = col.estimated_document_count()
    print(f"\n  conteo final en {COLLECTION}: {final_count:,} docs")


if __name__ == "__main__":
    main()
