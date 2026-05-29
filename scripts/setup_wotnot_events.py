"""
setup_wotnot_events.py — crea o actualiza el workflow "Wotnot Events" en n8n.

Wotnot NO expone LIST/incremental en la API pública -> ingest = webhook push.
Wotnot envía cada evento (conversación abierta, cerrada, mensaje, asignación,
CSAT) al webhook nuestro. El workflow normaliza el evento y lo acumula en
staticData (sd.events[] + sd.conversations{}).

El panel CS consume:
  GET /webhook/wotnot-seed    -> { ok, gz, count, generated_at }   (dataset acumulado)
  GET /webhook/wotnot-data?since=<unix>  -> { ok, events, count }  (deltas)

  POST /webhook/wotnot-events -> recibe el push de Wotnot (sin token - se valida
                                  por origen/secret en header si Wotnot lo soporta).

Slim del evento Wotnot:
  - event_id (uuid si lo provee, sino timestamp+random)
  - event_type (conversation_created, message_received, agent_assigned, conversation_closed, csat_submitted, ...)
  - conversation_id, contact_id, contact_name
  - agent_id, agent_name
  - channel (whatsapp, sms, chat-live, instagram, ...)
  - created_at_unix
  - status, csat, message_text (truncated 200 chars)

Sin histórico al deploy -> el panel acumula desde el primer evento recibido.

Idempotente. Requiere en .env.credentials:
  N8N_API_URL, N8N_API_KEY

Uso:  set -a; source .env.credentials; set +a
      python scripts/setup_wotnot_events.py
"""
import json
import sys
import urllib.request
import urllib.error
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
WF_NAME = "Wotnot Events - Push receiver del panel CS"


def load_env() -> dict:
    env = {}
    f = REPO.parent.parent / "ICClaude" / ".env.credentials"
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
    for k in ("N8N_API_URL", "N8N_API_KEY"):
        if not env.get(k):
            print(f"falta {k} en .env.credentials", file=sys.stderr)
            return 2

    # === Receiver: normaliza el evento y lo persiste ===

    receive_js = (
        "// Wotnot Events - recibe el push de Wotnot, normaliza, persiste.\n"
        "// Tolerante al schema variable: Wotnot envía distintos shapes por event_type.\n"
        "const sd = $getWorkflowStaticData('global');\n"
        "if (!sd.events) sd.events = [];\n"
        "if (!sd.conversations) sd.conversations = {};\n"
        "if (!sd.cache) sd.cache = {};\n"
        "const raw = $input.first().json || {};\n"
        "const body = raw.body || raw;\n"
        "if (!body || typeof body !== 'object') return [{ json: { ok:false, error:'empty body' } }];\n"
        "\n"
        "// Normalización defensiva - intenta varios paths comunes.\n"
        "const eid = body.event_id || body.id || `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;\n"
        "const etype = body.event_type || body.event || body.type || 'unknown';\n"
        "const conv = body.conversation || {};\n"
        "const contact = body.contact || body.customer || conv.contact || {};\n"
        "const agent = body.agent || body.assignee || conv.agent || {};\n"
        "const msg = body.message || {};\n"
        "const created = body.created_at || body.timestamp || msg.created_at || Math.floor(Date.now()/1000);\n"
        "const createdUnix = (typeof created === 'string') ? Math.floor(new Date(created).getTime()/1000) : Number(created);\n"
        "const cid = String(conv.id || body.conversation_id || msg.conversation_id || '');\n"
        "\n"
        "const slim = {\n"
        "  event_id: String(eid),\n"
        "  event_type: etype,\n"
        "  conversation_id: cid || null,\n"
        "  contact_id: contact.id ? String(contact.id) : null,\n"
        "  contact_name: contact.name || contact.full_name || null,\n"
        "  agent_id: agent.id ? String(agent.id) : null,\n"
        "  agent_name: agent.name || agent.full_name || null,\n"
        "  channel: body.channel || conv.channel || null,\n"
        "  status: conv.status || body.status || null,\n"
        "  csat: body.csat || body.rating || null,\n"
        "  message_text: (msg.text || msg.content || '').toString().slice(0, 200) || null,\n"
        "  created_at: createdUnix,\n"
        "  received_at: Math.floor(Date.now()/1000),\n"
        "};\n"
        "\n"
        "// Persiste en events[] + actualiza sd.conversations[cid] con el último estado conocido\n"
        "sd.events.push(slim);\n"
        "if (cid) {\n"
        "  const prev = sd.conversations[cid] || {};\n"
        "  sd.conversations[cid] = {\n"
        "    ...prev,\n"
        "    id: cid,\n"
        "    contact_id: slim.contact_id || prev.contact_id || null,\n"
        "    contact_name: slim.contact_name || prev.contact_name || null,\n"
        "    agent_id: slim.agent_id || prev.agent_id || null,\n"
        "    agent_name: slim.agent_name || prev.agent_name || null,\n"
        "    channel: slim.channel || prev.channel || null,\n"
        "    status: slim.status || prev.status || null,\n"
        "    last_csat: slim.csat || prev.last_csat || null,\n"
        "    last_event_at: createdUnix,\n"
        "    last_event_type: etype,\n"
        "    first_event_at: prev.first_event_at || createdUnix,\n"
        "    event_count: (prev.event_count || 0) + 1,\n"
        "  };\n"
        "}\n"
        "\n"
        "// Cap defensivo - el array de eventos no debería crecer sin límite.\n"
        "if (sd.events.length > 50000) sd.events = sd.events.slice(-50000);\n"
        "sd.cache.last_received_at = new Date().toISOString();\n"
        "return [{ json: { ok:true, event_type: etype, conv_id: cid,\n"
        "  total_events: sd.events.length, total_convs: Object.keys(sd.conversations).length } }];"
    )

    # === Serve seed: snapshot completo (gzip+base64) ===

    serve_seed_js = (
        "// Wotnot Seed - snapshot completo (conversations + events) en gzip+base64.\n"
        "const zlib = require('zlib');\n"
        "const sd = $getWorkflowStaticData('global');\n"
        "const payload = {\n"
        "  events: sd.events || [],\n"
        "  conversations: Object.values(sd.conversations || {}),\n"
        "  generated_at: new Date().toISOString(),\n"
        "  count: (sd.events || []).length,\n"
        "};\n"
        "const blob = JSON.stringify(payload);\n"
        "const gz = zlib.gzipSync(blob, { level: 9 }).toString('base64');\n"
        "return [{ json: { ok:true, gz, count: payload.count,\n"
        "  conv_count: payload.conversations.length,\n"
        "  generated_at: payload.generated_at,\n"
        "  size_mb: +(gz.length/1048576).toFixed(2) } }];"
    )

    # === Serve data: deltas con ?since=<unix> ===

    serve_data_js = (
        "// Wotnot Data - deltas de eventos con id-since opcional.\n"
        "const sd = $getWorkflowStaticData('global');\n"
        "const since = Number(($input.first().json.query || {}).since || 0);\n"
        "const all = sd.events || [];\n"
        "const out = since ? all.filter(e => (e.received_at || e.created_at || 0) >= since) : all;\n"
        "return [{ json: { ok:true, events: out, count: out.length,\n"
        "  synced_at: (sd.cache || {}).last_received_at || null,\n"
        "  total: all.length } }];"
    )

    nodes = [
        # Receiver (POST de Wotnot)
        {"id": "wne-wh-post", "name": "Webhook Push",
         "type": "n8n-nodes-base.webhook", "typeVersion": 2.1, "position": [260, 200],
         "webhookId": "wotnot-events-post",
         "parameters": {"httpMethod": "POST", "path": "wotnot-events", "responseMode": "lastNode"}},
        {"id": "wne-recv", "name": "Recibir + Normalizar",
         "type": "n8n-nodes-base.code", "typeVersion": 2, "position": [480, 200],
         "parameters": {"jsCode": receive_js}},
        # Seed (GET dataset)
        {"id": "wns-wh-get", "name": "Webhook Seed",
         "type": "n8n-nodes-base.webhook", "typeVersion": 2.1, "position": [260, 400],
         "webhookId": "wotnot-seed-get",
         "parameters": {"httpMethod": "GET", "path": "wotnot-seed", "responseMode": "lastNode"}},
        {"id": "wns-serve", "name": "Servir Seed",
         "type": "n8n-nodes-base.code", "typeVersion": 2, "position": [480, 400],
         "parameters": {"jsCode": serve_seed_js}},
        # Data (GET deltas)
        {"id": "wnd-wh-get", "name": "Webhook Data",
         "type": "n8n-nodes-base.webhook", "typeVersion": 2.1, "position": [260, 580],
         "webhookId": "wotnot-data-get",
         "parameters": {"httpMethod": "GET", "path": "wotnot-data", "responseMode": "lastNode"}},
        {"id": "wnd-serve", "name": "Servir Deltas",
         "type": "n8n-nodes-base.code", "typeVersion": 2, "position": [480, 580],
         "parameters": {"jsCode": serve_data_js}},
    ]
    connections = {
        "Webhook Push": {"main": [[{"node": "Recibir + Normalizar", "type": "main", "index": 0}]]},
        "Webhook Seed": {"main": [[{"node": "Servir Seed", "type": "main", "index": 0}]]},
        "Webhook Data": {"main": [[{"node": "Servir Deltas", "type": "main", "index": 0}]]},
    }
    wf = {"name": WF_NAME, "nodes": nodes, "connections": connections,
          "settings": {"executionOrder": "v1"}}

    existing = api(env, "GET", "/workflows?limit=250").get("data", [])
    match = [w for w in existing if w.get("name") == WF_NAME]
    if match:
        wid = match[0]["id"]
        api(env, "PUT", f"/workflows/{wid}", wf)
        print(f"workflow Wotnot Events actualizado (id={wid})")
    else:
        wid = api(env, "POST", "/workflows", wf)["id"]
        print(f"workflow Wotnot Events creado (id={wid})")

    try:
        api(env, "POST", f"/workflows/{wid}/activate")
        print("workflow activado")
    except urllib.error.HTTPError:
        print("no se pudo activar por API - actívalo en la UI de n8n")

    base = env["N8N_API_URL"].rstrip("/")
    base = base[:-len("/api/v1")] if base.endswith("/api/v1") else base
    print(f"endpoint receiver Wotnot: POST {base}/webhook/wotnot-events")
    print(f"endpoint panel seed:      GET  {base}/webhook/wotnot-seed")
    print(f"endpoint panel deltas:    GET  {base}/webhook/wotnot-data?since=<unix>")
    print()
    print("PRÓXIMO PASO MANUAL: en Wotnot UI (Settings -> Webhooks o vía API):")
    print(f"  - URL = {base}/webhook/wotnot-events")
    print(f"  - eventos a suscribir: conversation_created, message_received, agent_assigned, conversation_closed, csat_submitted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
