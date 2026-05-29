"""
list_workflows.py — lista todos los workflows en n8n con estado y carpeta.

Uso:
    set -a; source .env.credentials; set +a
    python scripts/list_workflows.py [filtro_substring]

Sin filtro: lista todos.
Con filtro: solo los que contengan el substring (case-insensitive) en name o tags.
"""
import json
import os
import sys
import urllib.error
import urllib.request
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


def main():
    env = load_env()
    filt = sys.argv[1].lower() if len(sys.argv) > 1 else None

    data = api(env, "GET", "/workflows?limit=250").get("data", [])

    # Filtrar
    if filt:
        rows = [w for w in data if filt in w.get("name", "").lower()
                or any(filt in t.get("name", "").lower() for t in (w.get("tags") or []))]
    else:
        rows = data

    # Ordenar por active desc, name asc
    rows.sort(key=lambda w: (not w.get("active"), w.get("name", "").lower()))

    # Header
    print(f"{'ACTIVE':<8} {'ID':<20} {'TAGS':<30} NAME")
    print("-" * 100)
    for w in rows:
        active = "ON" if w.get("active") else "off"
        wid = w.get("id", "")
        tags = ",".join(t.get("name", "") for t in (w.get("tags") or [])) or "-"
        if len(tags) > 28:
            tags = tags[:25] + "..."
        name = w.get("name", "")
        print(f"{active:<8} {wid:<20} {tags:<30} {name}")

    print(f"\nTotal: {len(rows)} workflows")
    print(f"  activos:  {sum(1 for w in rows if w.get('active'))}")
    print(f"  inactivos: {sum(1 for w in rows if not w.get('active'))}")


if __name__ == "__main__":
    main()
