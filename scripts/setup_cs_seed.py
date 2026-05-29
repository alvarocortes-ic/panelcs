"""
setup_cs_seed.py — crea o actualiza el workflow "CS Seed" en n8n.

CS Seed aloja el dataset del panel en su staticData y lo sirve por webhook, para que
el cascarón index.html no necesite el archivo data/seed.js local (HTML único).

  GET  /webhook/cs-seed  → { ok, gz, count, generated_at }   ← lo consume index.html
  POST /webhook/cs-seed  → guarda el seed (gzip+base64), valida token  ← carga_inicial.py

Idempotente: si el workflow ya existe (por nombre), lo actualiza.
El token se lee de .env.credentials en runtime — nunca se hardcodea en el repo.

Requiere en .env.credentials: N8N_API_URL, N8N_API_KEY, CS_SEED_TOKEN
Uso:  set -a; source .env.credentials; set +a   (o se leen del archivo directo)
      python outputs/cs-panel/scripts/setup_cs_seed.py
"""
import json
import sys
import urllib.request
import urllib.error
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
WF_NAME = "CS Seed - Dataset del panel"


def load_env() -> dict:
    env = {}
    f = REPO / ".env.credentials"
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def api(env: dict, method: str, path: str, body=None):
    url = env["N8N_API_URL"].rstrip("/") + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"X-N8N-API-KEY": env["N8N_API_KEY"], "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code} en {method} {path}: {e.read().decode()[:400]}", file=sys.stderr)
        raise


def main() -> int:
    env = load_env()
    for k in ("N8N_API_URL", "N8N_API_KEY", "CS_SEED_TOKEN"):
        if not env.get(k):
            print(f"falta {k} en .env.credentials", file=sys.stderr)
            return 2

    serve_js = (
        "// CS Seed — sirve el dataset alojado en staticData.\n"
        "const sd = $getWorkflowStaticData('global');\n"
        "return [{ json: { ok:true, gz: sd.seedGz || null,\n"
        "  count: sd.count || 0, generated_at: sd.generated_at || null } }];"
    )
    save_js = (
        "// CS Seed — guarda el dataset (gzip+base64). Valida token.\n"
        "const TOKEN = " + json.dumps(env["CS_SEED_TOKEN"]) + ";\n"
        "const j = $input.first().json || {};\n"
        "const b = j.body || j;\n"
        "if (!b || b.token !== TOKEN) return [{ json: { ok:false, error:'unauthorized' } }];\n"
        "if (!b.gz) return [{ json: { ok:false, error:'missing gz' } }];\n"
        "const sd = $getWorkflowStaticData('global');\n"
        "sd.seedGz = b.gz;\n"
        "sd.count = b.count || 0;\n"
        "sd.generated_at = b.generated_at || new Date().toISOString();\n"
        "return [{ json: { ok:true, count: sd.count, gz_chars: b.gz.length } }];"
    )

    nodes = [
        {"id": "csseed-wh-get", "name": "Webhook Servir",
         "type": "n8n-nodes-base.webhook", "typeVersion": 2.1, "position": [260, 200],
         "webhookId": "cs-seed-get",
         "parameters": {"httpMethod": "GET", "path": "cs-seed", "responseMode": "lastNode"}},
        {"id": "csseed-serve", "name": "Servir Seed",
         "type": "n8n-nodes-base.code", "typeVersion": 2, "position": [480, 200],
         "parameters": {"jsCode": serve_js}},
        {"id": "csseed-wh-post", "name": "Webhook Publicar",
         "type": "n8n-nodes-base.webhook", "typeVersion": 2.1, "position": [260, 400],
         "webhookId": "cs-seed-post",
         "parameters": {"httpMethod": "POST", "path": "cs-seed", "responseMode": "lastNode"}},
        {"id": "csseed-save", "name": "Guardar Seed",
         "type": "n8n-nodes-base.code", "typeVersion": 2, "position": [480, 400],
         "parameters": {"jsCode": save_js}},
    ]
    connections = {
        "Webhook Servir": {"main": [[{"node": "Servir Seed", "type": "main", "index": 0}]]},
        "Webhook Publicar": {"main": [[{"node": "Guardar Seed", "type": "main", "index": 0}]]},
    }
    wf = {"name": WF_NAME, "nodes": nodes, "connections": connections,
          "settings": {"executionOrder": "v1"}}

    existing = api(env, "GET", "/workflows?limit=250").get("data", [])
    match = [w for w in existing if w.get("name") == WF_NAME]
    if match:
        wid = match[0]["id"]
        api(env, "PUT", f"/workflows/{wid}", wf)
        print(f"workflow CS Seed actualizado (id={wid})")
    else:
        wid = api(env, "POST", "/workflows", wf)["id"]
        print(f"workflow CS Seed creado (id={wid})")

    try:
        api(env, "POST", f"/workflows/{wid}/activate")
        print("workflow activado")
    except urllib.error.HTTPError:
        print("⚠️  no se pudo activar por API — actívalo en la UI de n8n")

    base = env["N8N_API_URL"].rstrip("/")
    base = base[:-len("/api/v1")] if base.endswith("/api/v1") else base
    print(f"endpoint: GET/POST {base}/webhook/cs-seed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
