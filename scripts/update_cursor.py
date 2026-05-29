"""
update_cursor.py — actualiza un cursor en PanelCSMeta a un valor unix específico (o a now).

Útil después de populate_mongo_from_seed.py: deja `csDataCursor` apuntando a now()
para que el Schedule v2 NO reprocese tickets ya cargados y empiece a tomar SOLO los
nuevos desde ese momento.

Uso:
    set -a; source .env.credentials; set +a

    # Setear csDataCursor a now()
    python outputs/cs-panel/scripts/update_cursor.py csDataCursor now

    # Setear aircallDataCursor a now() menos 60s de overlap
    python outputs/cs-panel/scripts/update_cursor.py aircallDataCursor now --overlap 60

    # Setear a un unix timestamp específico
    python outputs/cs-panel/scripts/update_cursor.py csDataCursor 1780000000
"""
import argparse
import os
import sys
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

try:
    import pymongo
except ImportError:
    sys.exit("ERROR: pymongo no instalado. python -m pip install pymongo")

REPO = Path(__file__).resolve().parents[3]
DB_NAME = "automatizaciones"
META_COLLECTION = "PanelCSMeta"


def load_env():
    env = {}
    f = REPO / ".env.credentials"
    for line in f.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def connect(env):
    host = env["MONGO_HOST2"]
    user = env["MONGO_USER2"]
    pwd  = urllib.parse.quote_plus(env["MONGO_PASS2"])
    uri = f"mongodb+srv://{user}:{pwd}@{host}/?retryWrites=true&w=majority"
    client = pymongo.MongoClient(uri, serverSelectionTimeoutMS=10000)
    client.server_info()
    return client


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("key", help="key del cursor en PanelCSMeta (ej. csDataCursor)")
    ap.add_argument("value", help="'now' o un unix timestamp int")
    ap.add_argument("--overlap", type=int, default=60,
                    help="segundos a restar (default 60). Solo aplica si value='now'.")
    ap.add_argument("--dry-run", action="store_true",
                    help="solo muestra el cambio sin escribir")
    args = ap.parse_args()

    env = load_env()
    client = connect(env)
    col = client[DB_NAME][META_COLLECTION]

    # Estado actual
    current = col.find_one({"key": args.key})
    if current:
        cur_val = current.get("value")
        cur_dt = datetime.fromtimestamp(cur_val, tz=timezone.utc) if isinstance(cur_val, int) else None
        print(f"Estado actual de '{args.key}':")
        print(f"  value: {cur_val} ({cur_dt.isoformat() if cur_dt else '?'})")
        print(f"  updatedAt: {current.get('updatedAt')}")
    else:
        print(f"'{args.key}' NO existe en PanelCSMeta (se va a crear).")

    # Calcular nuevo valor
    if args.value == "now":
        new_val = int(time.time()) - args.overlap
        new_label = f"now() - {args.overlap}s overlap"
    else:
        try:
            new_val = int(args.value)
            new_label = "valor explícito"
        except ValueError:
            sys.exit(f"ERROR: value debe ser 'now' o un int unix timestamp. Recibido: {args.value!r}")

    new_dt = datetime.fromtimestamp(new_val, tz=timezone.utc)
    print()
    print(f"Nuevo valor:")
    print(f"  value: {new_val} ({new_dt.isoformat()}) — {new_label}")

    if args.dry_run:
        print("\n[DRY-RUN] no se escribió nada en Mongo.")
        return

    col.update_one(
        {"key": args.key},
        {"$set": {
            "key": args.key,
            "value": new_val,
            "updatedAt": datetime.now(timezone.utc),
            "notes": f"Manual update via update_cursor.py ({new_label})",
        }},
        upsert=True,
    )
    print(f"\nOK · '{args.key}' actualizado en PanelCSMeta.")


if __name__ == "__main__":
    main()
