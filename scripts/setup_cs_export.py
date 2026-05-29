"""
setup_cs_export.py — crea o actualiza el workflow "CS Export" en n8n.

Workflow expuesto en GET /webhook/cs-export?org=X&from=YYYY-MM-DD&to=YYYY-MM-DD
que devuelve un .jsonl con tickets del cliente + comments fresh desde Zendesk.

Frontend: n8n/cs-view.render.js funciones
  buildOrgExportador / expExportar / showToast / expVerDatosModal.

Arquitectura del workflow (3 nodos):
  1. Webhook GET /cs-export
  2. Code "Process Export" — toda la lógica (validar + fetch Zendesk + ensamblar)
                              usando this.helpers.httpRequest con Basic Auth
                              construido desde ZENDESK_USER + ZENDESK_TOKEN
                              inyectados al setup-time (mismo patrón que
                              setup_cs_seed.py con CS_SEED_TOKEN).
                              [n8n Code Node NO soporta httpRequestWithAuthentication
                               — confirmado en exec 322736 del 2026-05-28]
  3. Respond to Webhook — devuelve binary .jsonl con headers de descarga

Idempotente: si el workflow ya existe por nombre, lo actualiza vía PUT.

Requiere en .env.credentials: N8N_API_URL, N8N_API_KEY,
                              ZENDESK_USER, ZENDESK_TOKEN, ZENDESK_BASE_URL
Uso:
    set -a; source .env.credentials; set +a
    python scripts/setup_cs_export.py [--dry-run]

--dry-run imprime el JSON del workflow sin tocar n8n (útil para revisar).
"""
import argparse
import json
import sys
import urllib.request
import urllib.error
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
WF_NAME = "CS Export - Exportador tickets para análisis IA"
MAX_DAYS = 93  # 3 meses


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
        print(f"HTTP {e.code} en {method} {path}: {e.read().decode()[:600]}", file=sys.stderr)
        raise


def build_process_export_js(env: dict) -> str:
    """Construye el JS del Code node 'Process Export' inyectando credenciales Zendesk.

    Las credenciales (ZENDESK_USER, ZENDESK_TOKEN, ZENDESK_BASE_URL) se hardcodean en el
    código del nodo al setup-time. Mismo patrón que setup_cs_seed.py con CS_SEED_TOKEN.
    Razón: n8n Code Node no soporta httpRequestWithAuthentication (confirmado runtime).
    """
    zd_user = env["ZENDESK_USER"]
    zd_token = env["ZENDESK_TOKEN"]
    # ZENDESK_BASE_URL viene con o sin /api/v2 sufijo — normalizar a root
    # para que el JS arme las URLs como `${ZD_BASE}/api/v2/...`.
    zd_base = env["ZENDESK_BASE_URL"].rstrip("/")
    if zd_base.endswith("/api/v2"):
        zd_base = zd_base[:-len("/api/v2")]
    # Zendesk usa Basic auth con "user/token:TOKEN"
    auth_user = f"{zd_user}/token"
    return r"""
// CS Export — exporta tickets de un cliente en rango como JSONL para análisis IA.
// Credenciales Zendesk inyectadas al setup-time desde .env.credentials.

const ZD_BASE = __ZD_BASE__;
const ZD_AUTH_USER = __ZD_USER__;
const ZD_AUTH_PASS = __ZD_TOKEN__;

const startedAt = Date.now();
const q = ($input.first().json.query) || {};
const org  = String(q.org  || '').trim();
const from = String(q.from || '').trim();
const to   = String(q.to   || '').trim();

function bail(code, errObj) {
  return [{ json: { ok:false, http_status: code, ...errObj } }];
}

// Validación
if (!org || !from || !to) {
  return bail(400, { error: 'missing_params', message: 'Required: org, from, to (YYYY-MM-DD)' });
}
const reDate = /^\d{4}-\d{2}-\d{2}$/;
if (!reDate.test(from) || !reDate.test(to)) {
  return bail(400, { error: 'invalid_date_format', message: 'from/to must be YYYY-MM-DD' });
}
const msFrom = Date.parse(from + 'T00:00:00Z');
const msTo   = Date.parse(to   + 'T23:59:59Z');
if (isNaN(msFrom) || isNaN(msTo) || msFrom > msTo) {
  return bail(400, { error: 'invalid_range', message: 'from must be <= to' });
}
const dias = Math.floor((msTo - msFrom) / 86400000);
if (dias > __MAX_DAYS__) {
  return bail(400, {
    error: 'range_exceeded',
    max_days: __MAX_DAYS__,
    requested_days: dias,
    message: `Range ${dias}d exceeds max ${__MAX_DAYS__}d. Use shorter ranges.`,
  });
}

// Helper: llamada autenticada a Zendesk con Basic auth manual
async function zd(pathOrUrl) {
  const isFull = pathOrUrl.startsWith('http');
  return this.helpers.httpRequest({
    method: 'GET',
    url: isFull ? pathOrUrl : (ZD_BASE + pathOrUrl),
    auth: { username: ZD_AUTH_USER, password: ZD_AUTH_PASS },
    json: true,
    timeout: 60000,
  });
}

// 1. Buscar tickets del cliente en el rango (paginado, max 10 páginas = 1000 tickets).
// Zendesk Search API limita a 1000 resultados totales — si el cliente tiene más en
// el rango, devolvemos error claro para que el usuario reduzca el rango.
const query = `organization:${org} created>=${from} created<=${to}`;
let tickets = [];
let next = `${ZD_BASE}/api/v2/search.json?query=${encodeURIComponent(query)}&per_page=100&sort_by=created_at&sort_order=desc`;
let pages = 0;
let searchCount = null;
while (next && pages < 10) {
  const data = await zd.call(this, next);
  if (searchCount === null && typeof data.count === 'number') searchCount = data.count;
  const batch = data.results || data.tickets || [];
  tickets = tickets.concat(batch);
  next = data.next_page || null;
  pages++;
}

if (searchCount !== null && searchCount > 1000) {
  return bail(400, {
    error: 'too_many_tickets',
    total_in_range: searchCount,
    max_supported: 1000,
    message: `El rango contiene ${searchCount} tickets. Zendesk Search limita a 1000 por consulta. Reduce el rango (intenta períodos más cortos).`,
  });
}

if (tickets.length === 0) {
  const empty = JSON.stringify({
    _meta: { org, from, to, count: 0, generated_at: new Date().toISOString(), elapsed_ms: Date.now()-startedAt }
  });
  return [{
    json: { ok:true, count:0, org, from, to },
    binary: {
      data: {
        data: Buffer.from(empty + '\n', 'utf-8').toString('base64'),
        mimeType: 'application/x-ndjson',
        fileName: `cs-export-${org}-${from}_${to}.jsonl`,
      }
    }
  }];
}

// 2. Comments por ticket — PARALELIZADO con allSettled (concurrencia 5) + retry simple.
// Medición real SODEXO secuencial: 107 tickets en 80s (0.75s/ticket).
// Medición real concurrencia 10: 39s pero con 1 falla por timeout de conexión.
// Concurrencia 5 + retry: balance entre velocidad y robustez frente a errores transient.
const CONCURRENCIA = 5;
const enriched = [];
const errors = [];

async function fetchCommentsWithRetry(t) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const cr = await zd.call(this, `${ZD_BASE}/api/v2/tickets/${t.id}/comments.json`);
      return (cr.comments || []).map(c => ({
        id: c.id,
        author_id: c.author_id,
        created_at: c.created_at,
        public: c.public,
        body: c.body,
        via_channel: c.via && c.via.channel,
      }));
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
  errors.push({ ticket_id: t.id, stage: 'comments', error: String(lastErr && lastErr.message || lastErr).slice(0, 200) });
  return [];
}

// Procesar tickets en batches paralelos usando allSettled (no aborta si uno falla)
for (let i = 0; i < tickets.length; i += CONCURRENCIA) {
  const batch = tickets.slice(i, i + CONCURRENCIA);
  const settled = await Promise.allSettled(batch.map(t => fetchCommentsWithRetry.call(this, t)));
  batch.forEach((t, idx) => {
    const cf = {};
    (t.custom_fields || []).forEach(f => { cf[f.id] = f.value; });
    const commentsForTicket = settled[idx].status === 'fulfilled' ? settled[idx].value : [];
    enriched.push({
      id: t.id,
      subject: t.subject || '',
      description: (t.description || '').slice(0, 4000),
      status: t.status,
      priority: t.priority,
      type: t.type,
      created_at: t.created_at,
      updated_at: t.updated_at,
      solved_at: t.solved_at || null,
      via_channel: (t.via && t.via.channel) || null,
      assignee_id: t.assignee_id || null,
      group_id: t.group_id || null,
      organization_id: t.organization_id || null,
      requester_id: t.requester_id || null,
      submitter_id: t.submitter_id || null,
      tags: t.tags || [],
      custom_fields: cf,
      satisfaction_rating: t.satisfaction_rating || null,
      comments: commentsForTicket,
    });
  });
}

const meta = {
  _meta: {
    org, from, to,
    count: enriched.length,
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - startedAt,
    errors: errors.length ? errors : undefined,
    schema_version: 1,
    notes: 'JSONL: 1 linea = 1 ticket. Primera linea es _meta. Comments incluye descripcion + respuestas.',
  }
};

const jsonl = [JSON.stringify(meta)]
  .concat(enriched.map(t => JSON.stringify(t)))
  .join('\n') + '\n';

return [{
  json: {
    ok: true,
    count: enriched.length,
    org, from, to,
    errors: errors.length,
    elapsed_ms: Date.now() - startedAt,
  },
  binary: {
    data: {
      data: Buffer.from(jsonl, 'utf-8').toString('base64'),
      mimeType: 'application/x-ndjson',
      fileName: `cs-export-${org}-${from}_${to}.jsonl`,
    }
  }
}];
""".replace("__MAX_DAYS__", str(MAX_DAYS)) \
   .replace("__ZD_BASE__", json.dumps(zd_base)) \
   .replace("__ZD_USER__", json.dumps(auth_user)) \
   .replace("__ZD_TOKEN__", json.dumps(zd_token))


def build_workflow(env: dict) -> dict:
    """Construye el JSON del workflow CS Export (3 nodos)."""
    js_code = build_process_export_js(env)
    nodes = [
        {
            "id": "csexp-webhook",
            "name": "Webhook",
            "type": "n8n-nodes-base.webhook",
            "typeVersion": 2.1,
            "position": [260, 300],
            "webhookId": "cs-export-webhook",
            "parameters": {
                "httpMethod": "GET",
                "path": "cs-export",
                "responseMode": "responseNode",
                "options": {},
            },
        },
        {
            "id": "csexp-process",
            "name": "Process Export",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [500, 300],
            "parameters": {
                "jsCode": js_code,
            },
        },
        {
            "id": "csexp-respond",
            "name": "Respond to Webhook",
            "type": "n8n-nodes-base.respondToWebhook",
            "typeVersion": 1.1,
            "position": [740, 300],
            "parameters": {
                # Responde con el binary del item (campo "data" por default).
                # n8n setea Content-Type desde binary.data.mimeType y Content-Disposition
                # desde binary.data.fileName automáticamente.
                "respondWith": "binary",
                "options": {
                    "responseHeaders": {
                        "entries": [
                            {"name": "Cache-Control", "value": "no-store"},
                        ]
                    }
                },
            },
        },
    ]
    connections = {
        "Webhook": {"main": [[{"node": "Process Export", "type": "main", "index": 0}]]},
        "Process Export": {"main": [[{"node": "Respond to Webhook", "type": "main", "index": 0}]]},
    }
    return {
        "name": WF_NAME,
        "nodes": nodes,
        "connections": connections,
        "settings": {
            "executionOrder": "v1",
            "saveExecutionProgress": True,
            "saveDataErrorExecution": "all",
            "saveDataSuccessExecution": "none",
            "executionTimeout": 300,  # 5 min
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="Imprime el JSON del workflow sin tocar n8n")
    args = ap.parse_args()

    env = load_env()
    for k in ("N8N_API_URL", "N8N_API_KEY", "ZENDESK_USER", "ZENDESK_TOKEN", "ZENDESK_BASE_URL"):
        if not env.get(k):
            print(f"falta {k} en .env.credentials", file=sys.stderr)
            return 2

    wf = build_workflow(env)

    if args.dry_run:
        # Redactar credenciales en el dry-run para no leakearlas
        sanitized = json.dumps(wf, indent=2, ensure_ascii=False)
        sanitized = sanitized.replace(env["ZENDESK_TOKEN"], "***REDACTED_TOKEN***")
        print(sanitized)
        return 0

    print(f"=== n8n: {env['N8N_API_URL']} ===")

    existing = api(env, "GET", "/workflows?limit=250").get("data", [])
    match = [w for w in existing if w.get("name") == WF_NAME]
    if match:
        wid = match[0]["id"]
        api(env, "PUT", f"/workflows/{wid}", wf)
        print(f"workflow CS Export actualizado (id={wid})")
    else:
        wid = api(env, "POST", "/workflows", wf)["id"]
        print(f"workflow CS Export creado (id={wid})")

    try:
        api(env, "POST", f"/workflows/{wid}/activate")
        print("workflow activado")
    except urllib.error.HTTPError:
        print("AVISO: no se pudo activar por API. Actívalo en la UI de n8n.")

    base = env["N8N_API_URL"].rstrip("/")
    base = base[:-len("/api/v1")] if base.endswith("/api/v1") else base
    print(f"endpoint: GET {base}/webhook/cs-export?org=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD")
    print(f"max rango: {MAX_DAYS} días (3 meses)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
