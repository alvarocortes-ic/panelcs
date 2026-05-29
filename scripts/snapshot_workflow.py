"""
snapshot_workflow.py — GET de un workflow n8n por nombre y guarda JSON completo.

Útil para tener rollback antes de aplicar un patch al workflow productivo.

Uso:
    set -a; source .env.credentials; set +a
    python scripts/snapshot_workflow.py "CS Data v2 (Mongo)"

Salida: snapshots/{YYYYMMDD-HHMM}-{slug}.json
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

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


def api(env, method, path):
    url = env["N8N_API_URL"].rstrip("/") + path
    req = urllib.request.Request(
        url, method=method,
        headers={"X-N8N-API-KEY": env["N8N_API_KEY"], "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or "{}")


def slugify(s: str) -> str:
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "workflow"


def main():
    if len(sys.argv) < 2:
        sys.exit("uso: python snapshot_workflow.py \"Nombre exacto del workflow\"")
    target = sys.argv[1]
    env = load_env()
    for k in ("N8N_API_URL", "N8N_API_KEY"):
        if not env.get(k):
            sys.exit(f"falta {k} en .env.credentials")

    workflows = api(env, "GET", "/workflows?limit=250").get("data", [])
    wf_meta = next((w for w in workflows if w.get("name") == target), None)
    if not wf_meta:
        sys.exit(f"no se encontró workflow con nombre {target!r}")

    wf_id = wf_meta["id"]
    wf = api(env, "GET", f"/workflows/{wf_id}")

    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    slug = slugify(target)
    out_dir = REPO / "snapshots"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{ts}-{slug}-{wf_id}.json"
    out_path.write_text(json.dumps(wf, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"OK · snapshot guardado: {out_path}")
    print(f"  workflow id={wf_id} active={wf.get('active')} nodes={len(wf.get('nodes', []))}")


if __name__ == "__main__":
    main()
