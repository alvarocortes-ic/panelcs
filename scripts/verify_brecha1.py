"""
verify_brecha1.py — verifica que BRECHA 1 (enrich FRT/SLA en Schedule CS Data v2)
está funcionando: tickets recientemente sincronizados por el Schedule tienen
frtMin/slaBreached/slaActiveBreaches/solvedAt poblados (no null).

Si el Schedule aplicó el enrich correctamente, los tickets con
_syncSource='cs-data-v2-schedule' y _syncedAt reciente deberían tener métricas
no-null.

Uso:
    set -a; source .env.credentials; set +a
    python scripts/verify_brecha1.py [--minutes 15]

--minutes N: ventana hacia atrás desde now() (default 15).
"""
import argparse
import os
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import pymongo
except ImportError:
    sys.exit("ERROR: pymongo no instalado. python -m pip install pymongo")

REPO = Path(__file__).resolve().parents[1]
DB_NAME = "automatizaciones"
COLLECTION = "PanelCSTickets"


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
    ap.add_argument("--minutes", type=int, default=15, help="ventana hacia atrás (default 15 min)")
    args = ap.parse_args()

    env = load_env()
    client = connect(env)
    col = client[DB_NAME][COLLECTION]

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=args.minutes)

    print(f"=== Verificación BRECHA 1 — Schedule enrich ===")
    print(f"Ventana: tickets sincronizados desde {cutoff.isoformat()} (hace {args.minutes} min)")
    print()

    # Tickets sincronizados por el Schedule v2 en la ventana
    schedule_filter = {
        "_syncSource": "cs-data-v2-schedule",
        "_syncedAt": {"$gte": cutoff},
    }
    total = col.count_documents(schedule_filter)
    print(f"Total tickets tocados por Schedule v2: {total:,}")

    if total == 0:
        print()
        print("⚠️  Sin actividad del Schedule en esta ventana. Espera 5 min y reintenta.")
        return

    # Conteos por campo enrich
    enrich_fields = {
        "frtMin": "frtMin",
        "slaBreached": "slaBreached",
        "slaActiveBreaches no vacío": None,  # caso especial
        "solvedAt": "solvedAt",
        "reopens": "reopens",
    }

    print()
    print(f"Cobertura de enrich:")
    for label, field in enrich_fields.items():
        if field is None:
            # slaActiveBreaches no vacío
            f = {**schedule_filter, "slaActiveBreaches": {"$exists": True, "$ne": []}}
        else:
            f = {**schedule_filter, field: {"$ne": None, "$exists": True}}
        cnt = col.count_documents(f)
        pct = (cnt / total) * 100 if total else 0
        print(f"  {label:<32} {cnt:>6,} / {total:,}  ({pct:5.1f}%)")

    # Casos sospechosos: tickets con status=open pero frtMin null (debería tener)
    print()
    suspicious = col.count_documents({
        **schedule_filter,
        "status": {"$in": ["open", "pending", "hold"]},
        "frtMin": None,
    })
    print(f"Tickets activos (open/pending/hold) con frtMin=null: {suspicious:,}")
    if suspicious > 0:
        print(f"  ⚠️  Posibles fallos del enrich. Revisar n8n executions del Schedule.")

    # Sample de un ticket enrichado
    print()
    sample = col.find_one(
        {**schedule_filter, "frtMin": {"$ne": None}},
        sort=[("_syncedAt", -1)],
    )
    if sample:
        print(f"Sample (ticket {sample['ticketId']} más reciente con frtMin):")
        for k in ["ticketId", "status", "frtMin", "reopens", "slaBreached",
                 "slaActiveBreaches", "solvedAt", "_syncedAt"]:
            v = sample.get(k)
            if isinstance(v, list) and len(v) > 2:
                v = f"[{len(v)} items] {v[:2]}..."
            print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
