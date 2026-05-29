"""
migrate_cursors_to_mongo.py — Extrae cursors actuales de staticData (n8n v1) y los
copia a PanelCSMeta para que los workflows v2 arranquen sin perder tickets/calls.

Lee:
  - CS Data v1 (akkbfUdsiXEg57LK) — cursor de incremental/tickets + de events
  - Aircall Data v1 (xLoZ7zAJNaG5zZ64) — cursor (timestamp UNIX seg)

Escribe en PanelCSMeta:
  - csDataCursor             (start_time unix sec para incremental/tickets)
  - csDataEventsCursor       (start_time unix sec para incremental/ticket_events)
  - aircallDataCursor        (timestamp unix sec para /calls Aircall)
"""
import os
import sys
import urllib.parse
import urllib.request
import json
from datetime import datetime, timezone
from pathlib import Path

try:
    import pymongo
except ImportError:
    sys.exit("ERROR: pymongo no instalado.")

REPO = Path(__file__).resolve().parents[1]


def load_env():
    env = {}
    f = REPO.parent.parent / "ICClaude" / ".env.credentials"
    for line in f.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def get_workflow(env, wf_id):
    """Trae el workflow completo. staticData NO siempre está expuesta por la API REST de n8n
    (depende de la versión). Esta función intenta leer; si no, devuelve None."""
    base = env["N8N_API_URL"].rstrip("/")
    url = f"{base}/workflows/{wf_id}"
    req = urllib.request.Request(url, headers={"X-N8N-API-KEY": env["N8N_API_KEY"]})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def main():
    env = load_env()
    mongo_uri = (
        f"mongodb+srv://{env['MONGO_USER2']}:{urllib.parse.quote_plus(env['MONGO_PASS2'])}"
        f"@{env['MONGO_HOST2']}/?retryWrites=true&w=majority"
    )
    client = pymongo.MongoClient(mongo_uri, serverSelectionTimeoutMS=10000)
    db = client["automatizaciones"]
    meta = db["PanelCSMeta"]

    # CS Data v1 — extraer cursors si están en staticData
    print("=== CS Data v1 (akkbfUdsiXEg57LK) ===")
    wf = get_workflow(env, "akkbfUdsiXEg57LK")
    static_data = wf.get("staticData") or {}
    print(f"  staticData keys: {list(static_data.keys()) if isinstance(static_data, dict) else 'N/A'}")
    cs_cursor = None
    cs_events_cursor = None
    if isinstance(static_data, dict):
        # Estructura n8n: staticData.global = {...}
        g = static_data.get("global", static_data)
        if isinstance(g, dict):
            cs_cursor = g.get("ticketsAfterCursor") or g.get("after_cursor") or g.get("cursor")
            cs_events_cursor = g.get("eventsAfterCursor") or g.get("events_after_cursor") or g.get("events_cursor")
            # imprimir todas las keys del staticData global para ver qué tiene
            for k, v in g.items():
                v_repr = repr(v)[:80]
                print(f"    g[{k!r}]: {v_repr}")

    # Fallback si no encontró cursor: usar timestamp de hoy hace 7 días
    # Eso garantiza que pulleamos los tickets de la última semana al activar v2
    if not cs_cursor:
        cs_cursor = str(int((datetime.now(timezone.utc).timestamp() - 7*86400)))
        print(f"  [FALLBACK] sin cursor en staticData, usando 7 dias atras: {cs_cursor}")
    if not cs_events_cursor:
        cs_events_cursor = str(int((datetime.now(timezone.utc).timestamp() - 7*86400)))
        print(f"  [FALLBACK] sin events cursor, usando 7 dias atras: {cs_events_cursor}")

    # Aircall Data v1
    print()
    print("=== Aircall Data v1 (xLoZ7zAJNaG5zZ64) ===")
    wf = get_workflow(env, "xLoZ7zAJNaG5zZ64")
    static_data = wf.get("staticData") or {}
    print(f"  staticData keys: {list(static_data.keys()) if isinstance(static_data, dict) else 'N/A'}")
    aircall_cursor = None
    if isinstance(static_data, dict):
        g = static_data.get("global", static_data)
        if isinstance(g, dict):
            # Aircall v1 guarda { cache: { calls_cursor: <unix>, synced_at: ... } }
            cache = g.get("cache") or {}
            aircall_cursor = (
                cache.get("calls_cursor")
                or g.get("lastCallId")
                or g.get("cursor")
                or g.get("from_unix")
            )
            for k, v in g.items():
                v_repr = repr(v)[:80]
                print(f"    g[{k!r}]: {v_repr}")

    if not aircall_cursor:
        aircall_cursor = int(datetime.now(timezone.utc).timestamp() - 86400)
        print(f"  [FALLBACK] sin cursor Aircall, usando 24h atras: {aircall_cursor}")
    else:
        print(f"  cursor Aircall encontrado en cache.calls_cursor: {aircall_cursor}")

    # Insertar en PanelCSMeta
    print()
    print("=== Insertando en PanelCSMeta ===")
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    for key, value, notes in [
        ("csDataCursor", cs_cursor, "Cursor para Zendesk incremental/tickets — migrado desde staticData v1"),
        ("csDataEventsCursor", cs_events_cursor, "Cursor para Zendesk incremental/ticket_events — migrado desde staticData v1"),
        ("aircallDataCursor", aircall_cursor, "Cursor para Aircall /calls — migrado desde staticData v1"),
    ]:
        meta.update_one(
            {"key": key},
            {"$set": {
                "key": key,
                "value": value,
                "updatedAt": now,
                "notes": notes,
            }},
            upsert=True,
        )
        print(f"  {key} = {value}")

    print()
    print("OK. Workflows v2 al activar leeran estos cursors y resumiran desde ahi.")


if __name__ == "__main__":
    main()
