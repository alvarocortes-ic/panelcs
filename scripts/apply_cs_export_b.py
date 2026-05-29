"""
apply_cs_export_b.py — Reescribe el workflow "CS Export _test" (I2BNaChz4jp9ZwY1)
con el diseno Fase B+D (Enfoque C hibrido): tickets+metricas de Mongo, enrich
(tags/description/nombres/rut) via Zendesk show_many con credencial, comments via
httpRequest con credencial Zendesk Prod (resuelve D: cero token en texto plano).

Los jsCode de los 5 Code nodes salen VERBATIM de DESIGN-B-FINAL.json (sintesis del
panel de diseno). Los params de los nodos no-Code se definen aqui limpios.

Uso:
    P=outputs/cs-panel/.venv/bin/python
    export SSL_CERT_FILE=$($P -c 'import certifi;print(certifi.where())')
    set -a; source .env.credentials; set +a
    $P outputs/cs-panel/scripts/apply_cs_export_b.py            # dry-run TEST: construye + escribe JSON
    $P outputs/cs-panel/scripts/apply_cs_export_b.py --apply    # PUT al workflow _test (I2BNaChz4jp9ZwY1)
    $P outputs/cs-panel/scripts/apply_cs_export_b.py --prod          # dry-run PROD (revisar antes)
    $P outputs/cs-panel/scripts/apply_cs_export_b.py --prod --apply  # PUT al workflow PROD (VDRQnxqBumKPfiyC) — SOLO con GO + snapshot previo

Diferencia test/prod: WF_ID, colección Mongo (PanelCSTickets vs _test) y path del webhook (cs-export vs cs-export-test).
"""
import json
import sys
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PROD = "--prod" in sys.argv
WF_ID = "VDRQnxqBumKPfiyC" if PROD else "I2BNaChz4jp9ZwY1"
COLLECTION = "PanelCSTickets" if PROD else "PanelCSTickets_test"
WH_PATH = "cs-export" if PROD else "cs-export-test"
DESIGN = REPO / "outputs/cs-panel/n8n/DESIGN-B-FINAL.json"
BUILT = REPO / ("outputs/cs-panel/n8n/cs-export-b-built-prod.json" if PROD else "outputs/cs-panel/n8n/cs-export-b-built.json")

MONGO_CRED = {"id": "lkBqIrVu74bzJva2", "name": "Mongo Atlas devqa - Panel CS"}
ZD_CRED = {"id": "68yjtB8sha7fDhHj", "name": "Zendesk Prod"}

# Caso 0 tickets: emite directo el _meta count:0 (binary JSONL) SIN llamar show_many/comments.
# Antes el empty pasaba por show_many con ids='' → fallaba (show_many_batches_failed:1) + ~15s de reintentos.
EMPTY_JSONL_JS = r"""
const t0 = $('Validate Query').first().json;
const meta = { _meta: true, org: t0.org, from: t0.from, to: t0.to, count: 0,
  generated_at: new Date().toISOString(), elapsed_ms: Date.now() - (t0.startedAt || Date.now()),
  errors: [], schema_version: 2 };
const ndjson = JSON.stringify(meta) + '\n';
const b64 = Buffer.from(ndjson, 'utf8').toString('base64');
const fname = `cs-export-${t0.org}-${t0.from}_${t0.to}.jsonl`;
return [{ json: { ok: true, count: 0, empty: true },
  binary: { data: { data: b64, mimeType: 'application/x-ndjson', fileName: fname, fileExtension: 'jsonl' } } }];
"""


def load_env():
    env = {}
    for line in (REPO / ".env.credentials").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def api(env, method, path, body=None):
    url = env["N8N_API_URL"].rstrip("/") + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url, method=method, data=data,
        headers={"X-N8N-API-KEY": env["N8N_API_KEY"], "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or "{}")


def js(design, name):
    for c in design["finalCodeNodes"]:
        if c["name"] == name:
            return c["jsCode"]
    raise SystemExit(f"jsCode no encontrado para nodo {name!r}")


def code_node(name, jscode, pos):
    return {
        "name": name, "type": "n8n-nodes-base.code", "typeVersion": 2,
        "position": pos,
        "parameters": {"jsCode": jscode, "mode": "runOnceForAllItems"},
    }


def build_nodes(design):
    return [
        {
            "name": "Webhook", "type": "n8n-nodes-base.webhook", "typeVersion": 2.1,
            "position": [0, 320], "webhookId": WH_PATH,
            "onError": "continueRegularOutput",
            "parameters": {"httpMethod": "GET", "path": WH_PATH,
                           "responseMode": "responseNode", "options": {}},
        },
        code_node("Validate Query", js(design, "Validate Query"), [200, 320]),
        {
            "name": "IF Valido", "type": "n8n-nodes-base.if", "typeVersion": 2.2,
            "position": [420, 320],
            "parameters": {"conditions": {
                "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
                "combinator": "and",
                "conditions": [{"id": "valid-ok", "leftValue": "={{ $json.ok }}", "rightValue": True,
                                "operator": {"type": "boolean", "operation": "true", "singleValue": True}}],
            }},
        },
        {
            "name": "Mongo Find Tickets", "type": "n8n-nodes-base.mongoDb", "typeVersion": 1.2,
            "position": [640, 200], "credentials": {"mongoDb": MONGO_CRED},
            "onError": "continueRegularOutput", "alwaysOutputData": True, "retryOnFail": True, "maxTries": 3,
            "parameters": {
                "operation": "find", "collection": COLLECTION,
                "query": "={{ JSON.stringify({ organizationId: $json.org, createdAtUnix: { '$gte': $json.fromUnix, '$lte': $json.toUnix } }) }}",
                "options": {"limit": 50000, "sort": "={\"createdAtUnix\":1}"},
            },
        },
        code_node("Build ID Batches", js(design, "Build ID Batches"), [860, 200]),
        {
            "name": "show_many Enrich", "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2,
            "position": [1080, 200], "credentials": {"zendeskApi": ZD_CRED},
            "onError": "continueRegularOutput", "alwaysOutputData": True,
            "retryOnFail": True, "maxTries": 3, "waitBetweenTries": 5000,
            "parameters": {
                "method": "GET",
                "url": "https://iconstruye.zendesk.com/api/v2/tickets/show_many.json",
                "authentication": "predefinedCredentialType", "nodeCredentialType": "zendeskApi",
                "sendQuery": True,
                "queryParameters": {"parameters": [
                    {"name": "ids", "value": "={{ $json.ids }}"},
                    {"name": "include", "value": "users,groups,organizations"},
                ]},
                "options": {"timeout": 60000, "response": {"response": {"responseFormat": "json"}}},
            },
        },
        code_node("Build Comment Tasks", js(design, "Build Comment Tasks"), [1300, 200]),
        {
            "name": "Comments", "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2,
            "position": [1520, 200], "credentials": {"zendeskApi": ZD_CRED},
            "onError": "continueRegularOutput", "alwaysOutputData": True,
            "retryOnFail": True, "maxTries": 2, "waitBetweenTries": 2000,
            "parameters": {
                "method": "GET",
                "url": "=https://iconstruye.zendesk.com/api/v2/tickets/{{ $json.ticketId }}/comments.json",
                "authentication": "predefinedCredentialType", "nodeCredentialType": "zendeskApi",
                "sendQuery": True,
                "queryParameters": {"parameters": [{"name": "include", "value": "users"}]},
                "options": {"timeout": 30000, "response": {"response": {"responseFormat": "json"}},
                            "batching": {"batch": {"batchSize": 10, "batchInterval": 200}}},
            },
        },
        code_node("Assemble JSONL", js(design, "Assemble JSONL"), [1740, 200]),
        {
            "name": "Respond OK", "type": "n8n-nodes-base.respondToWebhook", "typeVersion": 1.5,
            "position": [1960, 200],
            "parameters": {"respondWith": "binary", "responseDataSource": "set", "inputFieldName": "data",
                           "options": {"responseHeaders": {"entries": [
                               {"name": "Cache-Control", "value": "no-store"},
                               {"name": "Content-Type", "value": "application/x-ndjson"}]}}},
        },
        code_node("Error to JSONL", js(design, "Error to JSONL"), [640, 460]),
        {
            "name": "Respond Error", "type": "n8n-nodes-base.respondToWebhook", "typeVersion": 1.5,
            "position": [860, 460],
            "parameters": {"respondWith": "binary", "responseDataSource": "set", "inputFieldName": "data",
                           "options": {"responseCode": 400, "responseHeaders": {"entries": [
                               {"name": "Cache-Control", "value": "no-store"},
                               {"name": "Content-Type", "value": "application/x-ndjson"}]}}},
        },
        {
            "name": "IF Has Tickets", "type": "n8n-nodes-base.if", "typeVersion": 2.2,
            "position": [1080, 320],
            "parameters": {"conditions": {
                "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
                "combinator": "and",
                "conditions": [{"id": "is-empty", "leftValue": "={{ $json.empty }}", "rightValue": True,
                                "operator": {"type": "boolean", "operation": "true", "singleValue": True}}],
            }},
        },
        code_node("Empty JSONL", EMPTY_JSONL_JS, [1300, 460]),
    ]


def build_connections():
    def c(node, idx=0):
        return {"node": node, "type": "main", "index": 0} if idx == 0 else {"node": node, "type": "main", "index": 0}
    return {
        "Webhook": {"main": [[{"node": "Validate Query", "type": "main", "index": 0}]]},
        "Validate Query": {"main": [[{"node": "IF Valido", "type": "main", "index": 0}]]},
        "IF Valido": {"main": [
            [{"node": "Mongo Find Tickets", "type": "main", "index": 0}],
            [{"node": "Error to JSONL", "type": "main", "index": 0}],
        ]},
        "Mongo Find Tickets": {"main": [[{"node": "Build ID Batches", "type": "main", "index": 0}]]},
        "Build ID Batches": {"main": [[{"node": "IF Has Tickets", "type": "main", "index": 0}]]},
        "IF Has Tickets": {"main": [
            [{"node": "Empty JSONL", "type": "main", "index": 0}],
            [{"node": "show_many Enrich", "type": "main", "index": 0}],
        ]},
        "Empty JSONL": {"main": [[{"node": "Respond OK", "type": "main", "index": 0}]]},
        "show_many Enrich": {"main": [[{"node": "Build Comment Tasks", "type": "main", "index": 0}]]},
        "Build Comment Tasks": {"main": [[{"node": "Comments", "type": "main", "index": 0}]]},
        "Comments": {"main": [[{"node": "Assemble JSONL", "type": "main", "index": 0}]]},
        "Assemble JSONL": {"main": [[{"node": "Respond OK", "type": "main", "index": 0}]]},
        "Error to JSONL": {"main": [[{"node": "Respond Error", "type": "main", "index": 0}]]},
    }


def main():
    apply = "--apply" in sys.argv
    env = load_env()
    design = json.loads(DESIGN.read_text(encoding="utf-8"))
    nodes = build_nodes(design)
    connections = build_connections()

    # settings del workflow actual (conservar)
    current = api(env, "GET", f"/workflows/{WF_ID}")
    settings = current.get("settings", {"executionOrder": "v1"})
    name = current.get("name")

    body = {"name": name, "nodes": nodes, "connections": connections, "settings": settings}
    BUILT.write_text(json.dumps(body, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"construido: {len(nodes)} nodos, {len(connections)} fuentes de conexion -> {BUILT}")
    print("nodos:", ", ".join(n["name"] for n in nodes))

    if not apply:
        print("\nDRY-RUN. Revisa el JSON. Para aplicar: --apply")
        return

    res = api(env, "PUT", f"/workflows/{WF_ID}", body)
    print(f"\nPUT OK · id={res.get('id')} nodes={len(res.get('nodes', []))} active={res.get('active')} updatedAt={res.get('updatedAt')}")


if __name__ == "__main__":
    main()
