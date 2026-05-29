"""
check_schedule_health.py — diagnostica si el Schedule de CS Data v2 está corriendo.

Verifica:
  1. Cursor csDataCursor en PanelCSMeta — si avanzó desde un timestamp dado.
  2. Executions recientes del workflow CS Data v2 vía API n8n.
  3. Conteo de docs en PanelCSTickets con _syncSource='cs-data-v2-schedule' recientes.

Uso:
    set -a; source .env.credentials; set +a
    python outputs/cs-panel/scripts/check_schedule_health.py
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import pymongo
except ImportError:
    sys.exit("ERROR: pymongo no instalado.")

REPO = Path(__file__).resolve().parents[3]
DB_NAME = "automatizaciones"


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


def api(env, method, path):
    url = env["N8N_API_URL"].rstrip("/") + path
    req = urllib.request.Request(
        url, method=method,
        headers={"X-N8N-API-KEY": env["N8N_API_KEY"], "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:500]


def main():
    env = load_env()

    # 1) Cursor csDataCursor
    print("=== 1. csDataCursor en PanelCSMeta ===")
    host = env["MONGO_HOST2"]
    user = env["MONGO_USER2"]
    pwd = urllib.parse.quote_plus(env["MONGO_PASS2"])
    client = pymongo.MongoClient(
        f"mongodb+srv://{user}:{pwd}@{host}/?retryWrites=true&w=majority",
        serverSelectionTimeoutMS=10000,
    )
    meta = client[DB_NAME]["PanelCSMeta"]
    cur = meta.find_one({"key": "csDataCursor"})
    if not cur:
        print("  csDataCursor NO existe.")
    else:
        v = cur.get("value")
        dt = datetime.fromtimestamp(v, tz=timezone.utc) if isinstance(v, int) else None
        ago = (datetime.now(timezone.utc) - dt).total_seconds() / 60 if dt else None
        print(f"  value: {v} ({dt.isoformat() if dt else '?'})")
        print(f"  updatedAt: {cur.get('updatedAt')}")
        print(f"  notes: {cur.get('notes')}")
        print(f"  edad cursor: {ago:.1f} min" if ago is not None else "")

    # 2) Workflow CS Data v2 — meta
    print()
    print("=== 2. Workflow CS Data v2 (Mongo) ===")
    code, data = api(env, "GET", "/workflows?limit=250")
    wf = next((w for w in data.get("data", []) if w.get("name") == "CS Data v2 (Mongo)"), None)
    if not wf:
        print("  No se encontró workflow.")
        return
    wf_id = wf["id"]
    print(f"  id: {wf_id}")
    print(f"  active: {wf.get('active')}")

    # GET completo para contar nodes
    code, full = api(env, "GET", f"/workflows/{wf_id}")
    if code == 200:
        print(f"  nodes: {len(full.get('nodes', []))}")
        node_names = [n["name"] for n in full.get("nodes", [])]
        enrich = [n for n in node_names if n in ("Collect Enrich Chunks", "Zendesk show_many", "Enrich Merge")]
        print(f"  nodos enrich presentes: {enrich}")

    # 3) Executions recientes del workflow
    print()
    print("=== 3. Executions recientes del workflow ===")
    code, execs = api(env, "GET", f"/executions?workflowId={wf_id}&limit=15")
    if code != 200:
        print(f"  ERROR GET executions: {code} {execs}")
        return

    items = execs.get("data", []) if isinstance(execs, dict) else []
    if not items:
        print(f"  Sin executions recientes (la API devolvió {len(items)} items).")
    else:
        print(f"  Total devuelto: {len(items)}")
        print(f"  {'STATUS':<12} {'MODE':<12} {'STARTED':<28} {'STOPPED':<28} {'FINISHED':<10}")
        for e in items[:15]:
            status = e.get("status") or ("success" if e.get("finished") else "?")
            mode = e.get("mode", "?")
            started = e.get("startedAt", "?")
            stopped = e.get("stoppedAt", "?")
            finished = "OK" if e.get("finished") else "no"
            print(f"  {status:<12} {mode:<12} {started:<28} {stopped:<28} {finished:<10}")

    # 4) Conteo Mongo
    print()
    print("=== 4. Conteo Mongo de actividad reciente ===")
    col = client[DB_NAME]["PanelCSTickets"]
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=30)
    n_schedule = col.count_documents({
        "_syncSource": "cs-data-v2-schedule",
        "_syncedAt": {"$gte": cutoff},
    })
    n_seed = col.count_documents({
        "_syncSource": "populate_mongo_from_seed.py",
        "_syncedAt": {"$gte": cutoff},
    })
    print(f"  Tocados por Schedule v2 en últimos 30 min: {n_schedule}")
    print(f"  Tocados por populate (carga inicial) en últimos 30 min: {n_seed}")


if __name__ == "__main__":
    main()
