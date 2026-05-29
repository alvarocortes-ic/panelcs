"""
populate_mongo_calls.py — Poblar PanelCSCalls (Mongo) desde el seed Aircall servido por n8n.

Toma el seed que sirve /webhook/aircall-seed, deserializa, mapea snake_case → camelCase
y hace bulk upsert por callId en PanelCSCalls.

Conversiones clave:
  - started_at / answered_at / ended_at son timestamps UNIX en SEGUNDOS → Date object.
  - frt_sec → frtSec (no convertir a min, ya está en segundos por la API Aircall).

Uso:
    set -a; source .env.credentials; set +a
    python outputs/cs-panel/scripts/populate_mongo_calls.py [--dry-run] [--limit N]
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

SEED_URL = "https://prod-low-code.iconstruye.dev/webhook/aircall-seed"
DB_NAME = "automatizaciones"
COLLECTION = "PanelCSCalls"
META_COLLECTION = "PanelCSMeta"
BULK_BATCH = 500


def connect():
    host = os.environ["MONGO_HOST2"]
    user = os.environ["MONGO_USER2"]
    pwd  = urllib.parse.quote_plus(os.environ["MONGO_PASS2"])
    uri = f"mongodb+srv://{user}:{pwd}@{host}/?retryWrites=true&w=majority"
    client = pymongo.MongoClient(uri, serverSelectionTimeoutMS=10000)
    client.server_info()
    return client


def unix_to_dt(ts):
    """Aircall devuelve timestamps en segundos UNIX. None si inválido."""
    if ts is None or ts == 0:
        return None
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).replace(tzinfo=None)
    except Exception:
        return None


def map_call(c: dict, generated_at: str) -> dict:
    """Mapea call Aircall slim (snake_case) → schema Mongo (camelCase)."""
    return {
        "callId": int(c["id"]),
        "direction": c.get("direction"),     # inbound | outbound
        "status": c.get("status"),
        "startedAt": unix_to_dt(c.get("started_at")),
        "answeredAt": unix_to_dt(c.get("answered_at")),
        "endedAt": unix_to_dt(c.get("ended_at")),
        "duration": c.get("duration"),       # segundos
        "frtSec": c.get("frt_sec"),          # primera respuesta en segundos (Aircall)
        "missedReason": c.get("missed_reason"),
        "rawDigits": c.get("raw_digits"),
        "userId": str(c["user_id"]) if c.get("user_id") is not None else None,
        "userName": c.get("user_name"),
        "numberId": str(c["number_id"]) if c.get("number_id") is not None else None,
        "numberName": c.get("number_name"),  # la "mesa" Aircall
        "contactId": str(c["contact_id"]) if c.get("contact_id") is not None else None,
        "contactName": c.get("contact_name"),
        "recording": c.get("recording"),
        "voicemail": c.get("voicemail"),
        "tags": c.get("tags") or [],
        "archived": bool(c.get("archived", False)),
        # zendeskTicketId queda null aquí — se popula via cross-link en otro flow
        # (los tickets Zendesk tienen el campo aircallCallId que es la otra punta).
        "zendeskTicketId": None,
        "_syncedAt": datetime.now(timezone.utc).replace(tzinfo=None),
        "_syncSource": "populate_mongo_calls.py",
        "_seedGeneratedAt": (datetime.fromtimestamp(int(generated_at), tz=timezone.utc).replace(tzinfo=None)
                             if generated_at and str(generated_at).isdigit() else None),
    }


def fetch_seed():
    print(f"  bajando seed desde {SEED_URL}...")
    t0 = time.time()
    raw = urllib.request.urlopen(SEED_URL, timeout=120).read()
    j = json.loads(raw)
    if not j.get("gz"):
        sys.exit(f"ERROR: respuesta sin campo 'gz'. Keys: {list(j.keys())}")
    seed = json.loads(gzip.decompress(base64.b64decode(j["gz"])).decode("utf-8"))
    calls = seed.get("calls", [])
    print(f"  seed bajado en {time.time()-t0:.1f}s · {len(raw):,}b raw · {len(calls):,} calls")
    return seed, j.get("generated_at")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    seed, generated_at = fetch_seed()
    calls = seed.get("calls", [])
    if args.limit:
        calls = calls[: args.limit]
        print(f"  --limit {args.limit}: procesando solo {len(calls)} calls")

    print()
    print(f"=== Mapeo + upsert a {DB_NAME}.{COLLECTION} ===")

    if args.dry_run:
        for i, c in enumerate(calls[:3]):
            m = map_call(c, generated_at)
            print(f"\n--- doc {i+1} (callId={m['callId']}) ---")
            for k, v in m.items():
                v_repr = repr(v)[:80]
                print(f"  {k}: {v_repr}")
        print(f"\n[DRY-RUN] no se escribió. Total a procesar: {len(calls)}")
        return

    client = connect()
    col = client[DB_NAME][COLLECTION]

    total = 0
    upserted_new = 0
    modified = 0
    t0 = time.time()
    for batch_start in range(0, len(calls), BULK_BATCH):
        batch = calls[batch_start : batch_start + BULK_BATCH]
        ops = []
        for c in batch:
            mapped = map_call(c, generated_at)
            ops.append(UpdateOne(
                {"callId": mapped["callId"]},
                {"$set": mapped},
                upsert=True,
            ))
        result = col.bulk_write(ops, ordered=False)
        total += len(batch)
        upserted_new += len(result.upserted_ids)
        modified += result.modified_count
        if batch_start % (BULK_BATCH * 5) == 0 or batch_start + BULK_BATCH >= len(calls):
            print(f"  procesados={total:>6,}/{len(calls):,} · insertados={upserted_new:,} · "
                  f"modificados={modified:,} · elapsed={time.time()-t0:.1f}s")

    print()
    print(f"=== Resumen ===")
    print(f"  total procesados: {total:,}")
    print(f"  insertados nuevos: {upserted_new:,}")
    print(f"  modificados: {modified:,}")
    print(f"  elapsed: {time.time()-t0:.1f}s")

    meta_col = client[DB_NAME][META_COLLECTION]
    meta_col.update_one(
        {"key": "lastFullSyncCalls"},
        {"$set": {
            "key": "lastFullSyncCalls",
            "value": {"totalCalls": total, "source": "populate_mongo_calls.py"},
            "updatedAt": datetime.now(timezone.utc).replace(tzinfo=None),
            "notes": "Última carga masiva calls Aircall desde /webhook/aircall-seed",
        }},
        upsert=True,
    )
    print(f"  PanelCSMeta.lastFullSyncCalls actualizado")

    final_count = col.estimated_document_count()
    print(f"\n  conteo final en {COLLECTION}: {final_count:,} docs")


if __name__ == "__main__":
    main()
