"""
setup_v2_workflows.py — Crea los 4 workflows v2 del Panel CS en n8n (inactivos).

Workflows creados:
  1. CS Seed v2 (Mongo)        — sirve seed desde PanelCSTickets
  2. CS Data v2 (Mongo)        — sirve deltas + sync incremental desde Zendesk
  3. Aircall Seed v2 (Mongo)   — sirve seed desde PanelCSCalls
  4. Aircall Data v2 (Mongo)   — sirve deltas + sync incremental desde Aircall

Endpoints expuestos:
  - GET /webhook/cs-seed-v2
  - GET /webhook/cs-data-v2?since=<unix>
  - GET /webhook/aircall-seed-v2
  - GET /webhook/aircall-data-v2?since=<unix>

Todos los workflows se crean INACTIVOS. Activación + swap es manual desde UI n8n
o con script aparte después de validar.

Idempotente: actualiza por nombre si existen.

Requiere en .env.credentials:
  N8N_API_URL, N8N_API_KEY, MONGO_N8N_CRED_ID, ZENDESK_USER, ZENDESK_TOKEN
"""
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

ZENDESK_CRED_ID = "68yjtB8sha7fDhHj"
ZENDESK_CRED_NAME = "Zendesk Prod"
AIRCALL_CRED_ID = "621TBwMU0NWdnKNM"
AIRCALL_CRED_NAME = "Aircall Basic - iconstruye"


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


def api(env, method, path, body=None):
    url = env["N8N_API_URL"].rstrip("/") + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"X-N8N-API-KEY": env["N8N_API_KEY"], "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:1000]


# ============================================================
# JS code de los Code nodes (compartido entre workflows)
# ============================================================

# Mapeo camelCase (Mongo) → snake_case (cliente del panel) para tickets
JS_MAP_TICKETS_OUT = r"""
// Convierte docs Mongo (camelCase) a snake_case que espera el cliente del panel.
// También extrae lookups del staticData del workflow (groups/agents/orgs) si están,
// o devuelve dicts vacíos (el cliente los mergea con lo que ya tiene).
function isoToUnix(d) {
  if (!d) return null;
  if (typeof d === 'string') return Math.floor(new Date(d).getTime() / 1000);
  if (d instanceof Date) return Math.floor(d.getTime() / 1000);
  return null;
}
function dateToIso(d) {
  if (!d) return null;
  if (typeof d === 'string') return d;
  if (d instanceof Date) return d.toISOString();
  return null;
}
const docs = items.map(it => it.json);
const tickets = docs.map(d => ({
  id: d.ticketId,
  subject: d.subject || '',
  status: d.status,
  priority: d.priority,
  type: d.type,
  created_at: dateToIso(d.createdAt),
  updated_at: dateToIso(d.updatedAt),
  solved_at: dateToIso(d.solvedAt),
  closed_at: dateToIso(d.closedAt),
  frt_min: d.frtMin,
  reopens: d.reopens,
  group_id: d.groupId,
  assignee_id: d.assigneeId,
  organization_id: d.organizationId,
  sla_breached: d.slaBreached,
  sla_active_breaches: (d.slaActiveBreaches || []).map(b => ({
    metric: b.metric, stage: b.stage, breach_at: dateToIso(b.breachAt),
  })),
  nivel: d.nivel,
  seguimiento: d.seguimiento,
  merged: d.merged,
  csat: d.csat,
  linea_negocio: d.lineaNegocio,
  categoria: d.categoria,
  producto: d.producto,
  subproducto: d.subproducto,
  paso_sn1: d.pasoSn1,
  esc_sn2: d.escSn2,
  esc_mo: d.escMo,
  devol: d.devol,
  via_channel: d.viaChannel,
  canal_normalizado: d.canalNormalizado,
  chat_subtype: d.chatSubtype,
  aircall_call_id: d.aircallCallId,
}));
// max updatedAt como cursor para el próximo sync del cliente
let maxUpdated = 0;
docs.forEach(d => {
  const u = isoToUnix(d.updatedAt);
  if (u && u > maxUpdated) maxUpdated = u;
});
return [{ json: {
  tickets,
  groups_by_id: {},
  agents_by_id: {},
  orgs_by_id: {},
  synced_until_unix: maxUpdated || Math.floor(Date.now() / 1000),
  count: tickets.length,
} }];
""".strip()


JS_PARSE_SINCE = r"""
// Parsea ?since=<unix seconds> del webhook. Default: now - 1h.
// Devuelve sinceISO string — el query Mongo lo envuelve en Extended JSON {$date}.
const q = $input.first().json.query || {};
const sinceRaw = q.since;
let since;
if (sinceRaw && !isNaN(parseInt(sinceRaw, 10))) {
  since = parseInt(sinceRaw, 10);
} else {
  since = Math.floor(Date.now() / 1000) - 3600;
}
return [{ json: { since, sinceISO: new Date(since * 1000).toISOString() } }];
""".strip()


JS_MAP_CALLS_OUT = r"""
// Convierte calls Mongo (camelCase) -> snake_case para cliente.
function dtToUnix(d) {
  if (!d) return null;
  if (d instanceof Date) return Math.floor(d.getTime() / 1000);
  if (typeof d === 'string') return Math.floor(new Date(d).getTime() / 1000);
  return null;
}
const docs = items.map(it => it.json);
const calls = docs.map(d => ({
  id: d.callId,
  direction: d.direction,
  status: d.status,
  started_at: dtToUnix(d.startedAt),
  answered_at: dtToUnix(d.answeredAt),
  ended_at: dtToUnix(d.endedAt),
  duration: d.duration,
  frt_sec: d.frtSec,
  missed_reason: d.missedReason,
  raw_digits: d.rawDigits,
  user_id: d.userId ? parseInt(d.userId, 10) : null,
  user_name: d.userName,
  number_id: d.numberId ? parseInt(d.numberId, 10) : null,
  number_name: d.numberName,
  contact_id: d.contactId ? parseInt(d.contactId, 10) : null,
  contact_name: d.contactName,
  recording: d.recording,
  voicemail: d.voicemail,
  tags: d.tags || [],
  archived: d.archived,
}));
let maxStarted = 0;
docs.forEach(d => {
  const t = dtToUnix(d.startedAt);
  if (t && t > maxStarted) maxStarted = t;
});
return [{ json: {
  calls,
  synced_until_unix: maxStarted || Math.floor(Date.now() / 1000),
  count: calls.length,
} }];
""".strip()


# ============================================================
# Workflow 1: CS Seed v2 (Mongo)
# Sirve TODOS los tickets de PanelCSTickets como seed gzipped (compat con cliente).
# ============================================================

def build_cs_seed_v2(env):
    JS_SERIALIZE_SEED = r"""
// Devuelve JSON plano (sin gzip) — n8n Code node tiene zlib bloqueado y Blob no
// existe en el sandbox. El cliente del panel acepta ambos formatos:
//   - { ok, gz } (legado v1, gzip+base64)
//   - { ok, tickets, groups_by_id, agents_by_id, orgs_by_id, ... } (v2 directo)
const j = $input.first().json;
return [{ json: {
  ok: true,
  meta: {
    generated_at: new Date().toISOString(),
    synced_until_unix: j.synced_until_unix,
    total_tickets: j.count,
    fuente: "cs-seed-v2 (MongoDB)",
  },
  tickets: j.tickets,
  groups_by_id: j.groups_by_id || {},
  agents_by_id: j.agents_by_id || {},
  orgs_by_id: j.orgs_by_id || {},
  count: j.count,
  generated_at: new Date().toISOString(),
} }];
""".strip()

    nodes = [
        {
            "id": "csseedv2-wh", "name": "Webhook", "type": "n8n-nodes-base.webhook",
            "typeVersion": 2.1, "position": [200, 300], "webhookId": "cs-seed-v2-wh",
            "parameters": {"httpMethod": "GET", "path": "cs-seed-v2", "responseMode": "lastNode"},
        },
        {
            "id": "csseedv2-find", "name": "Find All Tickets", "type": "n8n-nodes-base.mongoDb",
            "typeVersion": 1.2, "position": [420, 300],
            "credentials": {"mongoDb": {"id": env["MONGO_N8N_CRED_ID"], "name": "Mongo Atlas devqa - Panel CS"}},
            "parameters": {
                "operation": "find",
                "collection": "PanelCSTickets",
                "query": "={}",
                "options": {"limit": 100000, "sort": "={\"updatedAt\":-1}"},
            },
        },
        {
            "id": "csseedv2-map", "name": "Map to snake_case", "type": "n8n-nodes-base.code",
            "typeVersion": 2, "position": [640, 300],
            "parameters": {"jsCode": JS_MAP_TICKETS_OUT, "mode": "runOnceForAllItems"},
        },
        {
            "id": "csseedv2-gz", "name": "Serialize + Gzip", "type": "n8n-nodes-base.code",
            "typeVersion": 2, "position": [860, 300],
            "parameters": {"jsCode": JS_SERIALIZE_SEED, "mode": "runOnceForAllItems"},
        },
    ]
    connections = {
        "Webhook": {"main": [[{"node": "Find All Tickets", "type": "main", "index": 0}]]},
        "Find All Tickets": {"main": [[{"node": "Map to snake_case", "type": "main", "index": 0}]]},
        "Map to snake_case": {"main": [[{"node": "Serialize + Gzip", "type": "main", "index": 0}]]},
    }
    return {
        "name": "CS Seed v2 (Mongo)",
        "nodes": nodes,
        "connections": connections,
        "settings": {
            "executionOrder": "v1",
            "saveDataSuccessExecution": "none",
            "saveDataErrorExecution": "all",
            "saveExecutionProgress": False,
        },
    }


# ============================================================
# Workflow 2: Aircall Seed v2 (Mongo)
# Mismo patrón que CS Seed v2 pero sobre PanelCSCalls.
# ============================================================

def build_aircall_seed_v2(env):
    JS_SERIALIZE_CALLS = r"""
// JSON plano (igual razón que cs-seed-v2: zlib y Blob no disponibles en Code node).
const j = $input.first().json;
return [{ json: {
  ok: true,
  meta: {
    generated_at: new Date().toISOString(),
    synced_until_unix: j.synced_until_unix,
    total_calls: j.count,
    fuente: "aircall-seed-v2 (MongoDB)",
  },
  calls: j.calls,
  count: j.count,
  generated_at: new Date().toISOString(),
} }];
""".strip()

    nodes = [
        {
            "id": "acseedv2-wh", "name": "Webhook", "type": "n8n-nodes-base.webhook",
            "typeVersion": 2.1, "position": [200, 300], "webhookId": "aircall-seed-v2-wh",
            "parameters": {"httpMethod": "GET", "path": "aircall-seed-v2", "responseMode": "lastNode"},
        },
        {
            "id": "acseedv2-find", "name": "Find All Calls", "type": "n8n-nodes-base.mongoDb",
            "typeVersion": 1.2, "position": [420, 300],
            "credentials": {"mongoDb": {"id": env["MONGO_N8N_CRED_ID"], "name": "Mongo Atlas devqa - Panel CS"}},
            "parameters": {
                "operation": "find",
                "collection": "PanelCSCalls",
                "query": "={}",
                "options": {"limit": 100000, "sort": "={\"startedAt\":-1}"},
            },
        },
        {
            "id": "acseedv2-map", "name": "Map to snake_case", "type": "n8n-nodes-base.code",
            "typeVersion": 2, "position": [640, 300],
            "parameters": {"jsCode": JS_MAP_CALLS_OUT, "mode": "runOnceForAllItems"},
        },
        {
            "id": "acseedv2-gz", "name": "Serialize + Gzip", "type": "n8n-nodes-base.code",
            "typeVersion": 2, "position": [860, 300],
            "parameters": {"jsCode": JS_SERIALIZE_CALLS, "mode": "runOnceForAllItems"},
        },
    ]
    connections = {
        "Webhook": {"main": [[{"node": "Find All Calls", "type": "main", "index": 0}]]},
        "Find All Calls": {"main": [[{"node": "Map to snake_case", "type": "main", "index": 0}]]},
        "Map to snake_case": {"main": [[{"node": "Serialize + Gzip", "type": "main", "index": 0}]]},
    }
    return {
        "name": "Aircall Seed v2 (Mongo)",
        "nodes": nodes,
        "connections": connections,
        "settings": {
            "executionOrder": "v1",
            "saveDataSuccessExecution": "none",
            "saveDataErrorExecution": "all",
            "saveExecutionProgress": False,
        },
    }


# ============================================================
# Workflow 3: CS Data v2 (Mongo) — branch GET (deltas) — branch Schedule postergado.
#
# Para mantener este script razonable, v2 sale con solo el branch GET implementado.
# El branch Schedule (sync incremental desde Zendesk) lo hace otro workflow separado
# o se agrega en una iteración posterior con setup_cs_data_sync_workflow.py.
# Por ahora, los tickets nuevos se sincronizan re-corriendo carga_inicial.py
# adaptado a Mongo. El branch GET sirve para que el cliente pueda hacer polling de
# deltas vs lo que YA está en Mongo (sin pasar por staticData).
# ============================================================

def _zendesk_basic_auth(env):
    """Construye 'Basic <base64>' header value desde ZENDESK_USER + ZENDESK_TOKEN."""
    import base64
    user = env["ZENDESK_USER"]
    token = env["ZENDESK_TOKEN"]
    raw = f"{user}/token:{token}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def build_cs_data_v2(env):
    # Path 'cs-data' (mismo que v1, no v2) para que el cliente del panel no requiera
    # cambios — el index.html ya llama a /webhook/cs-data. v1 está inactivo así que
    # no hay colisión.
    #
    # 2 branches independientes en el mismo workflow:
    #   BRANCH GET: Webhook -> Parse since -> Find Mongo -> Map -> Respond
    #   BRANCH SCHEDULE: cada 5min lee cursor de Mongo, fetch Zendesk incremental,
    #                    slim + map a camelCase, upsert a PanelCSTickets, save cursor.
    #
    # Escalamientos (pasoSn1/escSn2/escMo/devol) requieren ticket_events de Zendesk
    # + merge histórico de transitions. Eso es Fase 3b. En esta iteración solo
    # sincronizamos los campos del slim_ticket directamente (status, frt, asignación,
    # SLA, etc.) — cubre el 90% del valor para el panel.

    # JS del Code node "Slim+Map" del branch Schedule. Reproduce slim_ticket() de
    # carga_inicial.py pero mapeando directo a camelCase para Mongo.
    JS_SLIM_TICKETS = r"""
// Slim + map a camelCase. Replica slim_ticket() de carga_inicial.py.
// Input: items con { ticket: <Zendesk raw> } (vienen del paginado de incremental).
// Output: 1 item por ticket en formato Mongo camelCase listo para upsert.

// IDs custom fields (sincronizar con carga_inicial.py si cambian)
const NIVEL_FID = 4556868682267, SEG_FID = 4557078676251, LN_FID = 11490690310939;
const SUBPROD_FID = 4746276837787, AIRCALL_CALL_FID = 16444628344091;
const CAT_FIDS = [4557429365019, 4572814010395, 4573134023067, 4573299675035,
                  4573306776347, 4573320613787, 4573317518875];
const PROD_FIDS = [4704444587547, 4613114080283, 4620916990747, 4621021765275,
                   4632374902299, 4632877917083, 4672260597659];
const NORMALIZE_CHANNEL = { api:'Teléfono', chat:'Chat', email:'Correo', web:'Correo', whatsapp:'Whatsapp' };

function cf(t, fid) {
  for (const c of (t.custom_fields || [])) if (c.id === fid) return c.value;
  return null;
}
function cfFirst(t, fids) {
  for (const f of fids) { const v = cf(t, f); if (v) return v; }
  return null;
}
function parseIso(s) {
  if (!s) return null;
  return new Date(s);
}
function chatSubtype(via, tags, channel) {
  if (channel !== 'chat') return null;
  const tagsSet = new Set(tags || []);
  if (tagsSet.has('sodexo')) return 'sodexo';
  if (tagsSet.has('offline')) return 'offline';
  if (tagsSet.has('sn1')) return 'sn1';
  if (tagsSet.has('portal_proveedores')) return 'portal_proveedores';
  return 'general';
}

const tickets = $input.all().flatMap(i => (i.json.tickets || []));
const out = [];
const nowUnix = Math.floor(Date.now() / 1000);
for (const t of tickets) {
  if (t.status === 'deleted') continue;
  const viaChannel = ((t.via && t.via.channel) || '').toLowerCase();
  const tags = t.tags || [];
  const updatedAt = parseIso(t.updated_at);
  const createdAt = parseIso(t.created_at);
  const aircallRaw = cf(t, AIRCALL_CALL_FID);
  out.push({ json: {
    ticketId: t.id,
    subject: t.subject || '',
    status: t.status,
    priority: t.priority,
    type: t.type,
    createdAt,
    updatedAt,
    createdAtUnix: createdAt ? Math.floor(createdAt.getTime() / 1000) : null,
    updatedAtUnix: updatedAt ? Math.floor(updatedAt.getTime() / 1000) : null,
    solvedAt: null,    // se llena en enrich (no en incremental crudo)
    closedAt: null,
    frtMin: null,
    reopens: null,
    groupId: t.group_id != null ? String(t.group_id) : null,
    assigneeId: t.assignee_id != null ? String(t.assignee_id) : null,
    organizationId: t.organization_id != null ? String(t.organization_id) : null,
    slaBreached: null,         // se evalúa en enrich
    slaActiveBreaches: [],
    nivel: (function(){ const v = cf(t, NIVEL_FID); return v ? String(v).toLowerCase() : null; })(),
    seguimiento: !!cf(t, SEG_FID),
    merged: (tags || []).includes('closed_by_merge'),
    csat: (t.satisfaction_rating && t.satisfaction_rating.score) || null,
    lineaNegocio: cf(t, LN_FID),
    categoria: cfFirst(t, CAT_FIDS),
    producto: cfFirst(t, PROD_FIDS),
    subproducto: cf(t, SUBPROD_FID),
    pasoSn1: null,    // se computa en Fase 3b con ticket_events
    escSn2: null,
    escMo: null,
    devol: null,
    viaChannel: viaChannel || null,
    canalNormalizado: NORMALIZE_CHANNEL[viaChannel] || 'Otros',
    chatSubtype: chatSubtype(t.via, tags, viaChannel),
    aircallCallId: (function(){
      if (aircallRaw == null) return null;
      const s = String(aircallRaw).trim();
      return /^\d+$/.test(s) ? parseInt(s, 10) : null;
    })(),
    _syncedAt: new Date(),
    _syncSource: 'cs-data-v2-schedule',
  } });
}
return out;
""".strip()

    # JS del Code "Collect Enrich Chunks" — chunkea los ticketIds del Slim+Map en grupos
    # de 100 para que cada item dispare 1 request a Zendesk show_many. El HTTP node
    # corre en modo "runOnceForEachItem" (default), o sea 1 request por chunk.
    JS_COLLECT_ENRICH_CHUNKS = r"""
const tickets = $input.all().map(i => i.json);
const CHUNK = 100;
const out = [];
for (let i = 0; i < tickets.length; i += CHUNK) {
  const chunk = tickets.slice(i, i + CHUNK);
  const ids = chunk.map(t => t.ticketId).filter(id => id != null).join(',');
  if (ids) out.push({ json: { ids } });
}
return out;
""".strip()

    # JS del Code "Enrich Merge" — junta los responses del show_many con los tickets
    # originales del Slim+Map. Computa los 5 campos enrichados replicando la lógica
    # de carga_inicial.py:471-499 y funciones SLA L288-307.
    #
    # Edge cases manejados:
    #   - show_many no devolvió el ticketId → se emite el ticket tal cual (frtMin null).
    #   - policyMetrics vacíos → slaBreached=false, slaActiveBreaches=[].
    #   - ticket cerrado (solved_at) → sla_breached histórico contra solved_at.
    #   - ticket activo → sla_breached vs nowIso con stage='active'.
    JS_ENRICH_MERGE = r"""
const nowIso = new Date().toISOString();

// 1) Acumular metric_sets + policy_metrics de TODOS los chunks que llegaron.
//    Tolera items con error (onError=continueRegularOutput del HTTP node):
//    si un chunk falló, su item llega como { error: "...", ...} o sin tickets.
//    Esos chunks se ignoran y los tickets correspondientes se emiten sin enrich.
const enrichMap = new Map();
let chunksOk = 0, chunksErr = 0;
for (const item of $input.all()) {
  const resp = item.json || {};
  if (resp.error || (!resp.tickets && !resp.metric_sets)) {
    chunksErr++;
    continue;
  }
  const tks = resp.tickets || [];
  const ms  = resp.metric_sets || [];
  const msById = new Map();
  for (const m of ms) msById.set(m.ticket_id, m);
  for (const tk of tks) {
    const policyMetrics = (tk.slas && tk.slas.policy_metrics) || [];
    enrichMap.set(tk.id, { metric: msById.get(tk.id) || {}, policyMetrics });
  }
  chunksOk++;
}
console.log(`[enrich-merge] chunks ok=${chunksOk} err=${chunksErr} tickets_enriched=${enrichMap.size}`);

function slaBreachedFn(policyMetrics, nowIsoLocal, solvedAtIso) {
  if (!policyMetrics || policyMetrics.length === 0) return false;
  if (solvedAtIso) {
    return policyMetrics.some(p => p.breach_at && p.breach_at < solvedAtIso);
  }
  return policyMetrics.some(p => p.stage === 'active' && p.breach_at && p.breach_at < nowIsoLocal);
}

function slaActiveBreachesFn(policyMetrics) {
  return (policyMetrics || [])
    .filter(p => (p.stage === 'active' || p.stage === 'paused') && p.breach_at)
    .map(p => ({ metric: p.metric, stage: p.stage, breachAt: new Date(p.breach_at) }));
}

// 2) Aplicar enrich a los tickets originales del Slim+Map (referencia cross-node)
const originals = $('Slim + Map camelCase').all().map(i => i.json);
const out = [];
for (const t of originals) {
  const e = enrichMap.get(t.ticketId);
  if (e) {
    const m = e.metric || {};
    const solvedAtIso = m.solved_at || null;
    const rtm = m.reply_time_in_minutes;
    const frtMin = (rtm && rtm.calendar != null) ? rtm.calendar : null;
    out.push({ json: {
      ...t,
      frtMin: frtMin,
      reopens: m.reopens != null ? m.reopens : null,
      solvedAt: solvedAtIso ? new Date(solvedAtIso) : t.solvedAt,
      slaBreached: slaBreachedFn(e.policyMetrics, nowIso, solvedAtIso),
      slaActiveBreaches: slaActiveBreachesFn(e.policyMetrics),
    } });
  } else {
    // ticket no enriquecido (show_many no devolvió ese ID — raro). Lo emite sin enrich.
    out.push({ json: t });
  }
}
return out;
""".strip()

    nodes = [
        # ============ BRANCH 1: GET /webhook/cs-data (servir deltas a cliente) ============
        {
            "id": "csdatav2-wh", "name": "Webhook", "type": "n8n-nodes-base.webhook",
            "typeVersion": 2.1, "position": [200, 200], "webhookId": "cs-data-v2-wh",
            "parameters": {"httpMethod": "GET", "path": "cs-data", "responseMode": "lastNode"},
        },
        {
            "id": "csdatav2-parse", "name": "Parse since", "type": "n8n-nodes-base.code",
            "typeVersion": 2, "position": [420, 200],
            "parameters": {"jsCode": JS_PARSE_SINCE, "mode": "runOnceForAllItems"},
        },
        {
            "id": "csdatav2-find", "name": "Find Deltas Mongo", "type": "n8n-nodes-base.mongoDb",
            "typeVersion": 1.2, "position": [640, 200],
            "credentials": {"mongoDb": {"id": env["MONGO_N8N_CRED_ID"], "name": "Mongo Atlas devqa - Panel CS"}},
            "parameters": {
                "operation": "find",
                "collection": "PanelCSTickets",
                "query": "={{ JSON.stringify({ updatedAtUnix: { \"$gte\": $json.since } }) }}",
                "options": {"limit": 50000, "sort": "={\"updatedAtUnix\":1}"},
            },
        },
        {
            "id": "csdatav2-map", "name": "Map to snake_case", "type": "n8n-nodes-base.code",
            "typeVersion": 2, "position": [860, 200],
            "parameters": {"jsCode": JS_MAP_TICKETS_OUT, "mode": "runOnceForAllItems"},
        },
        # ============ BRANCH 2: SCHEDULE cada 5min (sync incremental Zendesk → Mongo) ============
        {
            "id": "csdatav2-sched", "name": "Cada 5 min", "type": "n8n-nodes-base.scheduleTrigger",
            "typeVersion": 1.2, "position": [200, 500],
            "parameters": {"rule": {"interval": [{"field": "minutes", "minutesInterval": 5}]}},
        },
        {
            "id": "csdatav2-readcursor", "name": "Read Cursor", "type": "n8n-nodes-base.mongoDb",
            "typeVersion": 1.2, "position": [420, 500],
            "credentials": {"mongoDb": {"id": env["MONGO_N8N_CRED_ID"], "name": "Mongo Atlas devqa - Panel CS"}},
            "parameters": {
                "operation": "find",
                "collection": "PanelCSMeta",
                "query": "={{ JSON.stringify({key:'csDataCursor'}) }}",
                "options": {"limit": 1},
            },
        },
        {
            "id": "csdatav2-fallback", "name": "Cursor or Fallback", "type": "n8n-nodes-base.code",
            "typeVersion": 2, "position": [530, 500],
            "parameters": {
                "jsCode": (
                    "// Si Read Cursor devolvio 0 items (primer run o cursor borrado), usar\n"
                    "// fallback = now - 1h. Si devolvio doc, extraer el value.\n"
                    "const items = $input.all();\n"
                    "let cursor;\n"
                    "if (items.length === 0 || !items[0].json || items[0].json.value == null) {\n"
                    "  cursor = Math.floor(Date.now() / 1000) - 3600;\n"
                    "} else {\n"
                    "  cursor = parseInt(items[0].json.value, 10) || Math.floor(Date.now() / 1000) - 3600;\n"
                    "}\n"
                    "return [{ json: { value: cursor, startTime: cursor } }];"
                ),
                "mode": "runOnceForAllItems",
            },
        },
        {
            "id": "csdatav2-zendesk", "name": "Zendesk Incremental", "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2, "position": [780, 500],
            "credentials": {"zendeskApi": {"id": ZENDESK_CRED_ID, "name": ZENDESK_CRED_NAME}},
            "parameters": {
                # Usa la credencial 'Zendesk Prod' (Predefined Credential Type, Zendesk API).
                # Misma config que CS Data v1 que ya funcionaba. CERO token hardcodeado en
                # el workflow — n8n inyecta el auth al ejecutar la request.
                "authentication": "predefinedCredentialType",
                "nodeCredentialType": "zendeskApi",
                "method": "GET",
                "url": "https://iconstruye.zendesk.com/api/v2/incremental/tickets/cursor.json",
                "sendQuery": True,
                "queryParameters": {
                    "parameters": [
                        {"name": "start_time", "value": "={{ $json.startTime }}"},
                        # include=users,groups,organizations es CRÍTICO: garantiza que el
                        # response del incremental traiga los lookups que el panel espera
                        # (groups_by_id, agents_by_id, orgs_by_id). Mismo include que v1.
                        {"name": "include", "value": "users,groups,organizations"},
                        {"name": "per_page", "value": "1000"},
                    ]
                },
                "options": {
                    "pagination": {
                        "pagination": {
                            "paginationMode": "responseContainsNextURL",
                            "nextURL": "={{ $response.body.after_url }}",
                            "paginationCompleteWhen": "other",
                            "completeExpression": "={{ $response.body.end_of_stream === true }}",
                            "limitPagesFetched": True,
                            "maxRequests": 5,
                        }
                    },
                },
            },
        },
        {
            "id": "csdatav2-slim", "name": "Slim + Map camelCase", "type": "n8n-nodes-base.code",
            "typeVersion": 2, "position": [860, 500],
            "parameters": {"jsCode": JS_SLIM_TICKETS, "mode": "runOnceForAllItems"},
        },
        # ENRICH CHAIN (BRECHA 1 — agrega frtMin/slaBreached/slaActiveBreaches/solvedAt/reopens
        # a los tickets antes del upsert. Replica carga_inicial.py:471-499 + L288-307).
        {
            "id": "csdatav2-collect-enrich", "name": "Collect Enrich Chunks", "type": "n8n-nodes-base.code",
            "typeVersion": 2, "position": [1000, 500],
            "parameters": {"jsCode": JS_COLLECT_ENRICH_CHUNKS, "mode": "runOnceForAllItems"},
        },
        {
            "id": "csdatav2-showmany", "name": "Zendesk show_many", "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2, "position": [1200, 500],
            "credentials": {"zendeskApi": {"id": ZENDESK_CRED_ID, "name": ZENDESK_CRED_NAME}},
            "parameters": {
                # 1 request por chunk de 100 IDs. include=slas,metric_sets trae policy_metrics
                # + metric_sets (frt, reopens, solved_at). Default mode "runOnceForEachItem".
                "authentication": "predefinedCredentialType",
                "nodeCredentialType": "zendeskApi",
                "method": "GET",
                "url": "https://iconstruye.zendesk.com/api/v2/tickets/show_many.json",
                "sendQuery": True,
                "queryParameters": {
                    "parameters": [
                        {"name": "ids", "value": "={{ $json.ids }}"},
                        {"name": "include", "value": "slas,metric_sets"},
                    ]
                },
                "options": {
                    "timeout": 60000,
                    # Zendesk rate limit típico devuelve Retry-After: 45-50s. n8n no
                    # honra ese header automáticamente, así que esperamos 60s entre
                    # reintentos para superar el 429. Si tras 3 intentos sigue fallando,
                    # onError=continueRegularOutput emite un item con { error: ... }
                    # que el "Enrich Merge" maneja sin romper la cadena.
                    "retry": {"retry": {"maxRequests": 3, "waitBetweenRequests": 60000}},
                },
            },
            # continueRegularOutput: si tras los 3 reintentos sigue fallando, el item
            # sigue downstream con el campo `error`. Enrich Merge lo detecta y emite
            # el ticket sin enrich (cursor avanza, no rompe el sync).
            "onError": "continueRegularOutput",
        },
        {
            "id": "csdatav2-enrich-merge", "name": "Enrich Merge", "type": "n8n-nodes-base.code",
            "typeVersion": 2, "position": [1400, 500],
            "parameters": {"jsCode": JS_ENRICH_MERGE, "mode": "runOnceForAllItems"},
        },
        {
            "id": "csdatav2-upsert", "name": "Upsert PanelCSTickets", "type": "n8n-nodes-base.mongoDb",
            "typeVersion": 1.2, "position": [1620, 500],
            "credentials": {"mongoDb": {"id": env["MONGO_N8N_CRED_ID"], "name": "Mongo Atlas devqa - Panel CS"}},
            "parameters": {
                "operation": "update",
                "collection": "PanelCSTickets",
                "updateKey": "ticketId",
                "fields": "ticketId,subject,status,priority,type,createdAt,updatedAt,createdAtUnix,updatedAtUnix,solvedAt,closedAt,frtMin,reopens,groupId,assigneeId,organizationId,slaBreached,slaActiveBreaches,nivel,seguimiento,merged,csat,lineaNegocio,categoria,producto,subproducto,pasoSn1,escSn2,escMo,devol,viaChannel,canalNormalizado,chatSubtype,aircallCallId,_syncedAt,_syncSource",
                "options": {"upsert": True},
            },
        },
        {
            "id": "csdatav2-savecursor", "name": "Save Cursor", "type": "n8n-nodes-base.mongoDb",
            "typeVersion": 1.2, "position": [1840, 500],
            "credentials": {"mongoDb": {"id": env["MONGO_N8N_CRED_ID"], "name": "Mongo Atlas devqa - Panel CS"}},
            "parameters": {
                "operation": "update",
                "collection": "PanelCSMeta",
                "updateKey": "key",
                "fields": "key,value,updatedAt,notes",
                "options": {"upsert": True},
            },
        },
        {
            "id": "csdatav2-cursorout", "name": "Prepare New Cursor", "type": "n8n-nodes-base.code",
            "typeVersion": 2, "position": [1620, 700],
            "parameters": {
                "jsCode": (
                    "// Toma el batch ya upserted y construye el doc del cursor nuevo.\n"
                    "// El cursor es el max updatedAtUnix del batch (o now - 60 si batch vacío).\n"
                    "let maxUnix = 0;\n"
                    "for (const it of $input.all()) {\n"
                    "  const u = it.json.updatedAtUnix;\n"
                    "  if (typeof u === 'number' && u > maxUnix) maxUnix = u;\n"
                    "}\n"
                    "if (!maxUnix) maxUnix = Math.floor(Date.now() / 1000) - 60;\n"
                    "// Restar 60s de overlap para no perder tickets que cruzaron el boundary\n"
                    "const newCursor = maxUnix - 60;\n"
                    "return [{ json: {\n"
                    "  key: 'csDataCursor',\n"
                    "  value: newCursor,\n"
                    "  updatedAt: new Date(),\n"
                    "  notes: 'Auto-updated by CS Data v2 schedule (max updatedAtUnix - 60s overlap)',\n"
                    "} }];"
                ),
                "mode": "runOnceForAllItems",
            },
        },
    ]
    connections = {
        # Branch GET
        "Webhook": {"main": [[{"node": "Parse since", "type": "main", "index": 0}]]},
        "Parse since": {"main": [[{"node": "Find Deltas Mongo", "type": "main", "index": 0}]]},
        "Find Deltas Mongo": {"main": [[{"node": "Map to snake_case", "type": "main", "index": 0}]]},
        # Branch Schedule
        "Cada 5 min": {"main": [[{"node": "Read Cursor", "type": "main", "index": 0}]]},
        "Read Cursor": {"main": [[{"node": "Cursor or Fallback", "type": "main", "index": 0}]]},
        "Cursor or Fallback": {"main": [[{"node": "Zendesk Incremental", "type": "main", "index": 0}]]},
        "Zendesk Incremental": {"main": [[{"node": "Slim + Map camelCase", "type": "main", "index": 0}]]},
        # BRECHA 1 enrich chain: Slim+Map → Collect → show_many → Merge → Upsert
        "Slim + Map camelCase": {"main": [[{"node": "Collect Enrich Chunks", "type": "main", "index": 0}]]},
        "Collect Enrich Chunks": {"main": [[{"node": "Zendesk show_many", "type": "main", "index": 0}]]},
        "Zendesk show_many": {"main": [[{"node": "Enrich Merge", "type": "main", "index": 0}]]},
        "Enrich Merge": {"main": [[{"node": "Upsert PanelCSTickets", "type": "main", "index": 0}]]},
        "Upsert PanelCSTickets": {"main": [[{"node": "Prepare New Cursor", "type": "main", "index": 0}]]},
        "Prepare New Cursor": {"main": [[{"node": "Save Cursor", "type": "main", "index": 0}]]},
    }
    return {
        "name": "CS Data v2 (Mongo)",
        "nodes": nodes,
        "connections": connections,
        "settings": {
            "executionOrder": "v1",
            # 'none' = CLAVE para evitar el bloating de Postgres n8n que causó el
            # incidente 28-may 69 GB. Errores SÍ se guardan (saveDataErrorExecution: all).
            "saveDataSuccessExecution": "none",
            "saveDataErrorExecution": "all",
            "saveExecutionProgress": False,
            "executionTimeout": 240,
        },
    }


# ============================================================
# Workflow 4: Aircall Data v2 (Mongo) — branch GET (deltas)
# ============================================================

def build_aircall_data_v2(env):
    # Mismo razón que CS Data v2: usar path 'aircall-data' (sin v2) para reemplazar a v1
    # sin tocar el cliente del panel. 2 branches: GET deltas a cliente + Schedule sync
    # incremental desde Aircall API a Mongo.

    JS_SLIM_CALLS = r"""
// Slim + map calls Aircall (snake_case API) a Mongo camelCase + startedAtUnix.
// Output: 1 item por call.
function unixToDt(ts) {
  if (ts == null || ts === 0) return null;
  return new Date(parseInt(ts, 10) * 1000);
}
const calls = $input.all().flatMap(i => (i.json.calls || []));
const out = [];
for (const c of calls) {
  const startedAt = unixToDt(c.started_at);
  const startedAtUnix = c.started_at ? parseInt(c.started_at, 10) : null;
  out.push({ json: {
    callId: parseInt(c.id, 10),
    direction: c.direction,
    status: c.status,
    startedAt,
    answeredAt: unixToDt(c.answered_at),
    endedAt: unixToDt(c.ended_at),
    startedAtUnix,
    answeredAtUnix: c.answered_at ? parseInt(c.answered_at, 10) : null,
    duration: c.duration,
    frtSec: c.frt_sec || null,
    missedReason: c.missed_reason,
    rawDigits: c.raw_digits,
    userId: (c.user && c.user.id != null) ? String(c.user.id) : null,
    userName: (c.user && c.user.name) || null,
    numberId: (c.number && c.number.id != null) ? String(c.number.id) : null,
    numberName: (c.number && c.number.name) || null,
    contactId: (c.contact && c.contact.id != null) ? String(c.contact.id) : null,
    contactName: (c.contact && c.contact.name) || null,
    recording: c.recording || null,
    voicemail: c.voicemail || null,
    tags: c.tags || [],
    archived: !!c.archived,
    zendeskTicketId: null,
    _syncedAt: new Date(),
    _syncSource: 'aircall-data-v2-schedule',
  } });
}
return out;
""".strip()

    nodes = [
        # ============ BRANCH 1: GET /webhook/aircall-data ============
        {
            "id": "acdatav2-wh", "name": "Webhook", "type": "n8n-nodes-base.webhook",
            "typeVersion": 2.1, "position": [200, 200], "webhookId": "aircall-data-v2-wh",
            "parameters": {"httpMethod": "GET", "path": "aircall-data", "responseMode": "lastNode"},
        },
        {
            "id": "acdatav2-parse", "name": "Parse since", "type": "n8n-nodes-base.code",
            "typeVersion": 2, "position": [420, 200],
            "parameters": {"jsCode": JS_PARSE_SINCE, "mode": "runOnceForAllItems"},
        },
        {
            "id": "acdatav2-find", "name": "Find Deltas Mongo", "type": "n8n-nodes-base.mongoDb",
            "typeVersion": 1.2, "position": [640, 200],
            "credentials": {"mongoDb": {"id": env["MONGO_N8N_CRED_ID"], "name": "Mongo Atlas devqa - Panel CS"}},
            "parameters": {
                "operation": "find",
                "collection": "PanelCSCalls",
                "query": "={{ JSON.stringify({ startedAtUnix: { \"$gte\": $json.since } }) }}",
                "options": {"limit": 50000, "sort": "={\"startedAtUnix\":1}"},
            },
        },
        {
            "id": "acdatav2-map", "name": "Map to snake_case", "type": "n8n-nodes-base.code",
            "typeVersion": 2, "position": [860, 200],
            "parameters": {"jsCode": JS_MAP_CALLS_OUT, "mode": "runOnceForAllItems"},
        },
        # ============ BRANCH 2: SCHEDULE cada 5min (sync Aircall → Mongo) ============
        {
            "id": "acdatav2-sched", "name": "Cada 5 min", "type": "n8n-nodes-base.scheduleTrigger",
            "typeVersion": 1.2, "position": [200, 500],
            "parameters": {"rule": {"interval": [{"field": "minutes", "minutesInterval": 5}]}},
        },
        {
            "id": "acdatav2-readcursor", "name": "Read Cursor", "type": "n8n-nodes-base.mongoDb",
            "typeVersion": 1.2, "position": [420, 500],
            "credentials": {"mongoDb": {"id": env["MONGO_N8N_CRED_ID"], "name": "Mongo Atlas devqa - Panel CS"}},
            "parameters": {
                "operation": "find",
                "collection": "PanelCSMeta",
                "query": "={{ JSON.stringify({key:'aircallDataCursor'}) }}",
                "options": {"limit": 1},
            },
        },
        {
            "id": "acdatav2-fallback", "name": "Cursor or Fallback", "type": "n8n-nodes-base.code",
            "typeVersion": 2, "position": [530, 500],
            "parameters": {
                "jsCode": (
                    "const items = $input.all();\n"
                    "let cursor;\n"
                    "if (items.length === 0 || !items[0].json || items[0].json.value == null) {\n"
                    "  cursor = Math.floor(Date.now() / 1000) - 3600;\n"
                    "} else {\n"
                    "  cursor = parseInt(items[0].json.value, 10) || Math.floor(Date.now() / 1000) - 3600;\n"
                    "}\n"
                    "return [{ json: { value: cursor, startTime: cursor, from: cursor } }];"
                ),
                "mode": "runOnceForAllItems",
            },
        },
        {
            "id": "acdatav2-aircall", "name": "Aircall Calls", "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2, "position": [780, 500],
            "credentials": {"httpBasicAuth": {"id": AIRCALL_CRED_ID, "name": AIRCALL_CRED_NAME}},
            "parameters": {
                # httpBasicAuth es credential GENÉRICO (no específico de un servicio como zendeskApi).
                # Por eso: authentication='genericCredentialType' + genericAuthType='httpBasicAuth'.
                # Mismo patrón que Aircall Data v1 que sí funcionaba.
                "authentication": "genericCredentialType",
                "genericAuthType": "httpBasicAuth",
                "method": "GET",
                "url": "https://api.aircall.io/v1/calls",
                "sendQuery": True,
                "queryParameters": {
                    "parameters": [
                        {"name": "from", "value": "={{ $json.from }}"},
                        {"name": "per_page", "value": "50"},
                        {"name": "order", "value": "asc"},
                    ]
                },
                "options": {
                    "timeout": 60000,
                    "pagination": {
                        "pagination": {
                            "paginationMode": "responseContainsNextURL",
                            "nextURL": "={{ $response.body.meta.next_page_link }}",
                            "paginationCompleteWhen": "other",
                            # Para cuando next_page_link es null/undefined (última pagina).
                            "completeExpression": "={{ !$response.body.meta || !$response.body.meta.next_page_link }}",
                            "limitPagesFetched": True,
                            "maxRequests": 5,
                        }
                    },
                },
            },
        },
        {
            "id": "acdatav2-slim", "name": "Slim Calls", "type": "n8n-nodes-base.code",
            "typeVersion": 2, "position": [1000, 500],
            "parameters": {"jsCode": JS_SLIM_CALLS, "mode": "runOnceForAllItems"},
        },
        {
            "id": "acdatav2-upsert", "name": "Upsert PanelCSCalls", "type": "n8n-nodes-base.mongoDb",
            "typeVersion": 1.2, "position": [1220, 500],
            "credentials": {"mongoDb": {"id": env["MONGO_N8N_CRED_ID"], "name": "Mongo Atlas devqa - Panel CS"}},
            "parameters": {
                "operation": "update",
                "collection": "PanelCSCalls",
                "updateKey": "callId",
                "fields": "callId,direction,status,startedAt,answeredAt,endedAt,startedAtUnix,answeredAtUnix,duration,frtSec,missedReason,rawDigits,userId,userName,numberId,numberName,contactId,contactName,recording,voicemail,tags,archived,zendeskTicketId,_syncedAt,_syncSource",
                "options": {"upsert": True},
            },
        },
        {
            "id": "acdatav2-newcursor", "name": "Prepare New Cursor", "type": "n8n-nodes-base.code",
            "typeVersion": 2, "position": [1000, 700],
            "parameters": {
                "jsCode": (
                    "let maxUnix = 0;\n"
                    "for (const it of $input.all()) {\n"
                    "  const u = it.json.startedAtUnix;\n"
                    "  if (typeof u === 'number' && u > maxUnix) maxUnix = u;\n"
                    "}\n"
                    "if (!maxUnix) maxUnix = Math.floor(Date.now() / 1000) - 60;\n"
                    "return [{ json: {\n"
                    "  key: 'aircallDataCursor',\n"
                    "  value: maxUnix - 60,\n"
                    "  updatedAt: new Date(),\n"
                    "  notes: 'Auto-updated by Aircall Data v2 schedule (max startedAtUnix - 60s overlap)',\n"
                    "} }];"
                ),
                "mode": "runOnceForAllItems",
            },
        },
        {
            "id": "acdatav2-savecursor", "name": "Save Cursor", "type": "n8n-nodes-base.mongoDb",
            "typeVersion": 1.2, "position": [1220, 700],
            "credentials": {"mongoDb": {"id": env["MONGO_N8N_CRED_ID"], "name": "Mongo Atlas devqa - Panel CS"}},
            "parameters": {
                "operation": "update",
                "collection": "PanelCSMeta",
                "updateKey": "key",
                "fields": "key,value,updatedAt,notes",
                "options": {"upsert": True},
            },
        },
    ]
    connections = {
        # Branch GET
        "Webhook": {"main": [[{"node": "Parse since", "type": "main", "index": 0}]]},
        "Parse since": {"main": [[{"node": "Find Deltas Mongo", "type": "main", "index": 0}]]},
        "Find Deltas Mongo": {"main": [[{"node": "Map to snake_case", "type": "main", "index": 0}]]},
        # Branch Schedule
        "Cada 5 min": {"main": [[{"node": "Read Cursor", "type": "main", "index": 0}]]},
        "Read Cursor": {"main": [[{"node": "Cursor or Fallback", "type": "main", "index": 0}]]},
        "Cursor or Fallback": {"main": [[{"node": "Aircall Calls", "type": "main", "index": 0}]]},
        "Aircall Calls": {"main": [[{"node": "Slim Calls", "type": "main", "index": 0}]]},
        "Slim Calls": {"main": [[{"node": "Upsert PanelCSCalls", "type": "main", "index": 0}]]},
        "Upsert PanelCSCalls": {"main": [[{"node": "Prepare New Cursor", "type": "main", "index": 0}]]},
        "Prepare New Cursor": {"main": [[{"node": "Save Cursor", "type": "main", "index": 0}]]},
    }
    return {
        "name": "Aircall Data v2 (Mongo)",
        "nodes": nodes,
        "connections": connections,
        "settings": {
            "executionOrder": "v1",
            "saveDataSuccessExecution": "none",  # evita bloating Postgres (incidente 28-may)
            "saveDataErrorExecution": "all",
            "saveExecutionProgress": False,
            "executionTimeout": 240,
        },
    }


# ============================================================
# Main
# ============================================================

# Decisión post-smoke test cs-seed-v2:
# - CS Seed v1 / Aircall Seed v1 se mantienen (gzip eficiente vs 30MB JSON plano).
# - Solo Data v2 reemplaza a v1 (que es lo que causó el incidente).
# - Los Seed v2 quedan como workflows creados pero NO se actualizan más (deprecated).
WORKFLOW_BUILDERS = [
    ("CS Data v2 (Mongo)", build_cs_data_v2),
    ("Aircall Data v2 (Mongo)", build_aircall_data_v2),
]


def main():
    env = load_env()
    for k in ("N8N_API_URL", "N8N_API_KEY", "MONGO_N8N_CRED_ID"):
        if not env.get(k):
            print(f"falta {k} en .env.credentials", file=sys.stderr)
            return 2

    existing = api(env, "GET", "/workflows?limit=250")[1].get("data", [])
    existing_by_name = {w.get("name"): w.get("id") for w in existing}

    print(f"=== Creando/actualizando 4 workflows v2 (inactivos) ===")
    for wf_name, builder in WORKFLOW_BUILDERS:
        wf = builder(env)
        if wf_name in existing_by_name:
            wid = existing_by_name[wf_name]
            code, resp = api(env, "PUT", f"/workflows/{wid}", wf)
            if code in (200, 201):
                print(f"  {wf_name}: ACTUALIZADO (id={wid})")
            else:
                print(f"  {wf_name}: ERROR PUT {code} — {str(resp)[:300]}", file=sys.stderr)
        else:
            code, resp = api(env, "POST", "/workflows", wf)
            if code in (200, 201):
                wid = resp.get("id")
                print(f"  {wf_name}: CREADO (id={wid})")
            else:
                print(f"  {wf_name}: ERROR POST {code} — {str(resp)[:300]}", file=sys.stderr)

    print()
    print("PUT idempotente: si el workflow ya existía, n8n preserva 'active' (no se desactiva).")
    print("Si fueron creados nuevos (POST), nacen INACTIVOS y requieren activación manual.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
