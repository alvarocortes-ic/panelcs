"""
setup_aircall_data.py — crea o actualiza el workflow "Aircall Data" en n8n.

Réplica del patrón cs-data sobre Aircall:
  - Rama Schedule cada 5 min: GET /v1/calls?from=<cursor> con cursor en staticData.
    Acumula deltas (slim) en sd.calls{} (key=id) → no se pierden llamadas.
  - Rama GET /webhook/aircall-data?since=<unix>: sirve los calls slim con id>=since.

Slim idéntico al de carga_inicial_aircall.py (mantener sincronía).

Idempotente. Reusa el patrón de setup_cs_seed.py para create/update + activate.
Requiere en .env.credentials:
  N8N_API_URL, N8N_API_KEY,
  AIRCALL_API_ID, AIRCALL_API_TOKEN, AIRCALL_API_BASE_URL

Uso:  set -a; source .env.credentials; set +a
      python outputs/cs-panel/scripts/setup_aircall_data.py
"""
import json
import sys
import urllib.request
import urllib.error
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
WF_NAME = "Aircall Data - Deltas del panel CS"
CRED_NAME = "Aircall Basic - iconstruye"
CRED_TYPE = "httpBasicAuth"


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


def ensure_credential(env: dict) -> str:
    """Devuelve el credential_id de la Basic Auth en n8n.

    Orden de resolución:
      1. Si AIRCALL_N8N_CRED_ID está en .env.credentials -> usa ese id.
      2. Sino, intenta crear la credencial (POST /credentials).
      3. Si la creación falla (típico: ya existe con ese nombre), pide id interactivo.

    El camino recomendado es ejecutar primero setup_n8n_credentials.py que crea
    la credencial y deja AIRCALL_N8N_CRED_ID en .env.credentials.
    """
    cid = env.get("AIRCALL_N8N_CRED_ID")
    if cid:
        print(f"credencial '{CRED_NAME}' -> reusando id={cid} desde .env.credentials")
        return cid

    body = {
        "name": CRED_NAME,
        "type": CRED_TYPE,
        "data": {
            "user": env["AIRCALL_API_ID"],
            "password": env["AIRCALL_API_TOKEN"],
        },
    }
    try:
        r = api(env, "POST", "/credentials", body)
        cid = r.get("id")
        print(f"credencial '{CRED_NAME}' creada (id={cid})")
        print(f"  TIP: agregá 'AIRCALL_N8N_CRED_ID={cid}' a .env.credentials para próximos runs.")
        return cid
    except urllib.error.HTTPError as e:
        print(f"credencial '{CRED_NAME}' parece ya existir. "
              f"Corré primero setup_n8n_credentials.py o copiá el id de la UI de n8n.",
              file=sys.stderr)
        cid = input(f"id de credencial existente (enter para abort): ").strip()
        if not cid:
            raise
        return cid


def main() -> int:
    env = load_env()
    for k in ("N8N_API_URL", "N8N_API_KEY", "AIRCALL_API_ID", "AIRCALL_API_TOKEN", "AIRCALL_API_BASE_URL"):
        if not env.get(k):
            print(f"falta {k} en .env.credentials", file=sys.stderr)
            return 2

    cred_id = ensure_credential(env)
    aircall_base = env["AIRCALL_API_BASE_URL"].rstrip("/")     # ya incluye /v1

    # === RAMA SCHEDULE — cursor + fetch + slim + save ===

    cursor_js = (
        "// Aircall Data - cursor cada 5 min.\n"
        "const sd = $getWorkflowStaticData('global');\n"
        "if (!sd.cache) sd.cache = {};\n"
        "const nowSec = Math.floor(Date.now()/1000);\n"
        "let since = sd.cache.calls_cursor;\n"
        "if (typeof since !== 'number') since = nowSec - 90;   // primer arranque\n"
        "since = Math.max(since - 60, 0);                       // solape 60s\n"
        "return [{ json: { from_unix: since, now_unix: nowSec } }];"
    )

    # nodo HTTP que llama a Aircall - auth via Credential nativa n8n (no hardcoded).
    http_fetch = {
        "id": "acd-fetch", "name": "Fetch Aircall",
        "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2, "position": [700, 200],
        "parameters": {
            "method": "GET",
            "url": f"{aircall_base}/calls",
            "authentication": "genericCredentialType",
            "genericAuthType": "httpBasicAuth",
            "sendQuery": True,
            "queryParameters": {"parameters": [
                {"name": "from", "value": "={{$json.from_unix}}"},
                {"name": "per_page", "value": "50"},
                {"name": "order", "value": "asc"},
            ]},
            "options": {"timeout": 60000, "retry": {"limit": 2, "maxRetryTimeout": 30000}},
        },
        "credentials": {
            "httpBasicAuth": {"id": cred_id, "name": CRED_NAME},
        },
    }

    slim_save_js = (
        "// Aircall Data - slim + acumula en sd.calls{} (key=id).\n"
        "const sd = $getWorkflowStaticData('global');\n"
        "if (!sd.calls) sd.calls = {};\n"
        "const body = $input.first().json || {};\n"
        "const arr = body.calls || [];\n"
        "let nuevos = 0, actualizados = 0;\n"
        "let maxStarted = sd.cache.calls_cursor || 0;\n"
        "for (const c of arr) {\n"
        "  const u = c.user || {}, n = c.number || {}, k = c.contact || {};\n"
        "  const started = c.started_at || 0, answered = c.answered_at || null;\n"
        "  const id = String(c.id);\n"
        "  if (sd.calls[id]) actualizados++; else nuevos++;\n"
        "  sd.calls[id] = {\n"
        "    id: c.id, direction: c.direction, status: c.status,\n"
        "    started_at: c.started_at, answered_at: c.answered_at, ended_at: c.ended_at,\n"
        "    duration: c.duration,\n"
        "    frt_sec: (answered && started) ? (answered - started) : null,\n"
        "    missed_reason: c.missed_call_reason, raw_digits: c.raw_digits,\n"
        "    user_id: u.id, user_name: u.name,\n"
        "    number_id: n.id, number_name: n.name,\n"
        "    contact_id: k.id || null, contact_name: k.name || null,\n"
        "    recording: c.recording_short_url || c.recording || null,\n"
        "    voicemail: c.voicemail_short_url || c.voicemail || null,\n"
        "    tags: (c.tags || []).map(t => t.name).filter(Boolean),\n"
        "    archived: !!c.archived,\n"
        "  };\n"
        "  if (started > maxStarted) maxStarted = started;\n"
        "}\n"
        "if (!sd.cache) sd.cache = {};\n"
        "sd.cache.calls_cursor = maxStarted || Math.floor(Date.now()/1000);\n"
        "sd.cache.synced_at = new Date().toISOString();\n"
        "return [{ json: { ok:true, nuevos, actualizados, total: Object.keys(sd.calls).length,\n"
        "  next_page: (body.meta || {}).next_page_link || null,\n"
        "  cursor: sd.cache.calls_cursor } }];"
    )

    # === RAMA GET — sirve los deltas con ?since= ===

    serve_js = (
        "// Aircall Data - sirve calls slim con id-since opcional.\n"
        "const sd = $getWorkflowStaticData('global');\n"
        "const since = Number(($input.first().json.query || {}).since || 0);\n"
        "const all = Object.values(sd.calls || {});\n"
        "const out = since ? all.filter(c => (c.started_at || 0) >= since) : all;\n"
        "return [{ json: { ok:true, calls: out, count: out.length,\n"
        "  synced_at: (sd.cache || {}).synced_at || null,\n"
        "  total: all.length } }];"
    )

    nodes = [
        # rama Schedule
        {"id": "acd-sched", "name": "Cada 5 min",
         "type": "n8n-nodes-base.scheduleTrigger", "typeVersion": 1.2, "position": [260, 200],
         "parameters": {"rule": {"interval": [{"field": "minutes", "minutesInterval": 5}]}}},
        {"id": "acd-cursor", "name": "Cursor",
         "type": "n8n-nodes-base.code", "typeVersion": 2, "position": [480, 200],
         "parameters": {"jsCode": cursor_js}},
        http_fetch,
        {"id": "acd-slim", "name": "Slim + Save",
         "type": "n8n-nodes-base.code", "typeVersion": 2, "position": [920, 200],
         "parameters": {"jsCode": slim_save_js}},
        # rama GET
        {"id": "acd-wh-get", "name": "Webhook /aircall-data",
         "type": "n8n-nodes-base.webhook", "typeVersion": 2.1, "position": [260, 480],
         "webhookId": "aircall-data-get",
         "parameters": {"httpMethod": "GET", "path": "aircall-data", "responseMode": "lastNode"}},
        {"id": "acd-serve", "name": "Servir Deltas",
         "type": "n8n-nodes-base.code", "typeVersion": 2, "position": [480, 480],
         "parameters": {"jsCode": serve_js}},
    ]
    connections = {
        "Cada 5 min": {"main": [[{"node": "Cursor", "type": "main", "index": 0}]]},
        "Cursor": {"main": [[{"node": "Fetch Aircall", "type": "main", "index": 0}]]},
        "Fetch Aircall": {"main": [[{"node": "Slim + Save", "type": "main", "index": 0}]]},
        "Webhook /aircall-data": {"main": [[{"node": "Servir Deltas", "type": "main", "index": 0}]]},
    }
    wf = {"name": WF_NAME, "nodes": nodes, "connections": connections,
          "settings": {"executionOrder": "v1"}}

    existing = api(env, "GET", "/workflows?limit=250").get("data", [])
    match = [w for w in existing if w.get("name") == WF_NAME]
    if match:
        wid = match[0]["id"]
        api(env, "PUT", f"/workflows/{wid}", wf)
        print(f"workflow Aircall Data actualizado (id={wid})")
    else:
        wid = api(env, "POST", "/workflows", wf)["id"]
        print(f"workflow Aircall Data creado (id={wid})")

    # IMPORTANTE: no activamos automáticamente - el Schedule corre solo desde la UI.
    # El usuario debe revisar el workflow en la UI antes de activarlo (deploy a producción).
    print("NOTA: workflow NO activado - revisalo en n8n UI y activalo manualmente.")
    print("Esto previene que el Schedule arranque sin tu visto bueno.")

    base = env["N8N_API_URL"].rstrip("/")
    base = base[:-len("/api/v1")] if base.endswith("/api/v1") else base
    print(f"endpoint GET deltas: {base}/webhook/aircall-data?since=<unix>")
    return 0


if __name__ == "__main__":
    sys.exit(main())
