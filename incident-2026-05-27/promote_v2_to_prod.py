#!/usr/bin/env python3
"""
promote_v2_to_prod.py — workaround del incidente n8n CS View 2026-05-27.

Contexto: el workflow `kQmPeDgXA27mKQPj` "CS View - Presentacion del panel"
tiene FK violation persistente en BD n8n (FK_08d6c67b7f722b0039d9d5ed620
sobre workflow_history). Cualquier PUT con cambios reales al contenido tira
HTTP 400. Aldo Carvajal no ha resuelto a nivel infra.

Decision del usuario (2026-05-27 12:42 chile): duplicar el WF desde la UI
(que NO usa la API publica y genera un workflow_entity fresh sin history
corrupto), y promover el duplicado a productivo.

Estado al ejecutar este script:
  - VIEJO  kQmPeDgXA27mKQPj  active=False  (path="cs-view", contenido parcial 22 mesas)
  - NUEVO  qOIldhWyoeGMUa2p  active=False  (path=UUID auto, contenido = mismo del viejo)

Este script:
  1. GET workflow nuevo.
  2. Patch:
     - name = "CS View - Presentacion del panel" (sin sufijo " copy")
     - webhook node path = "cs-view" (libera del UUID auto)
     - "Construir Vista" assignments:
        version = "mesa-mapping-completo"
        css     = contenido HEAD outputs/cs-panel/n8n/cs-view.styles.css
        js      = contenido HEAD outputs/cs-panel/n8n/cs-view.render.js
  3. PUT.
  4. Imprime resumen para que el usuario active manualmente desde la UI
     (bug n8n public API #21614 obliga a Save+Activate en UI).

Idempotencia: si el WF nuevo ya tiene path="cs-view" y version=
"mesa-mapping-completo", el script igual hace PUT (no hay riesgo, es el mismo
contenido). Pero la activacion final solo puede hacerla el humano en UI.
"""
import os
import sys
import json
import datetime
import urllib.request
import urllib.error

NEW_WF_ID = "qOIldhWyoeGMUa2p"
OLD_WF_ID = "kQmPeDgXA27mKQPj"
NEW_NAME = "CS View - Presentacion del panel"
WEBHOOK_PATH = "cs-view"
NODE = "Construir Vista"
VERSION = "mesa-mapping-completo"
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
CSS_FILE = os.path.join(REPO, "outputs", "cs-panel", "n8n", "cs-view.styles.css")
JS_FILE = os.path.join(REPO, "outputs", "cs-panel", "n8n", "cs-view.render.js")


def api_base():
    url = os.environ.get("N8N_API_URL") or os.environ.get("N8N_BASE_URL")
    if not url:
        sys.exit("ERROR: falta N8N_API_URL en el entorno (source .env.credentials).")
    url = url.rstrip("/")
    if "/api/" not in url:
        url += "/api/v1"
    return url


def api(method, path, body=None, timeout=30):
    key = os.environ.get("N8N_API_KEY")
    if not key:
        sys.exit("ERROR: falta N8N_API_KEY en el entorno (source .env.credentials).")
    req = urllib.request.Request(
        api_base() + path,
        method=method,
        headers={"X-N8N-API-KEY": key, "Content-Type": "application/json"},
        data=json.dumps(body).encode("utf-8") if body is not None else None,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        body_err = e.read().decode("utf-8", "ignore")
        sys.exit("ERROR HTTP %s en %s %s:\n%s" % (e.code, method, path, body_err))


def main():
    # 1. Pre-flight: viejo debe estar inactive
    print("[1/4] Pre-flight check...")
    old = api("GET", "/workflows/%s" % OLD_WF_ID)
    if old.get("active"):
        sys.exit("ABORT: el WF viejo %s sigue active=True. Desactivalo primero." % OLD_WF_ID)
    print("    viejo %s active=False -> path 'cs-view' libre en runtime" % OLD_WF_ID)

    # 2. Leer contenido HEAD local
    print("[2/4] Leyendo HEAD local...")
    with open(CSS_FILE, encoding="utf-8") as f:
        css = f.read()
    with open(JS_FILE, encoding="utf-8") as f:
        js = f.read()
    print("    CSS: %d bytes  JS: %d bytes" % (len(css), len(js)))

    # 3. GET nuevo + patch
    print("[3/4] GET nuevo qOIldhWyoeGMUa2p + patch...")
    wf = api("GET", "/workflows/%s" % NEW_WF_ID)
    if wf.get("active"):
        sys.exit("ABORT: el WF nuevo %s ya esta active. Desactivalo en UI antes." % NEW_WF_ID)

    # Patch nombre
    wf["name"] = NEW_NAME

    # Patch webhook node
    webhook = next((n for n in wf["nodes"] if (n.get("type") or "").endswith(".webhook")), None)
    if not webhook:
        sys.exit("ABORT: no encontre webhook node en el workflow.")
    print("    webhook path: %s -> %s" % (webhook["parameters"].get("path"), WEBHOOK_PATH))
    webhook["parameters"]["path"] = WEBHOOK_PATH

    # Patch Construir Vista
    node = next((n for n in wf["nodes"] if n.get("name") == NODE), None)
    if not node:
        sys.exit('ABORT: no encontre el nodo "%s" en el workflow.' % NODE)
    found = set()
    for a in node["parameters"]["assignments"]["assignments"]:
        if a["name"] == "css":
            a["value"] = css
            found.add("css")
        elif a["name"] == "js":
            a["value"] = js
            found.add("js")
        elif a["name"] == "version":
            a["value"] = VERSION
            found.add("version")
    missing = {"css", "js", "version"} - found
    if missing:
        sys.exit("ABORT: faltan assignments en el nodo: %s" % ", ".join(sorted(missing)))

    # Whitelist settings: el GET devuelve campos que el endpoint PUT rechaza
    # con 400 "must NOT have additional properties". Confirmado por test
    # incremental 2026-05-27: `availableInMCP` y `binaryMode` no permitidos.
    # Mantener el resto.
    SETTINGS_WHITELIST = {
        "executionOrder",
        "saveManualExecutions",
        "saveExecutionProgress",
        "saveDataErrorExecution",
        "saveDataSuccessExecution",
        "executionTimeout",
        "timezone",
        "errorWorkflow",
    }
    raw_settings = wf.get("settings", {})
    settings = {k: v for k, v in raw_settings.items() if k in SETTINGS_WHITELIST}
    dropped = set(raw_settings) - set(settings)
    if dropped:
        print("    settings filtrados (no permitidos en PUT): %s" % ", ".join(sorted(dropped)))

    payload = {
        "name": wf["name"],
        "nodes": wf["nodes"],
        "connections": wf["connections"],
        "settings": settings,
    }
    payload_size = len(json.dumps(payload))
    print("    payload total: %d bytes" % payload_size)

    # 4. PUT
    print("[4/4] PUT /workflows/%s..." % NEW_WF_ID)
    result = api("PUT", "/workflows/%s" % NEW_WF_ID, payload)

    print("")
    print("=" * 60)
    print("PUT OK")
    print("=" * 60)
    print("name      : %s" % result.get("name"))
    print("active    : %s" % result.get("active"))
    print("versionId : %s" % (result.get("versionId") or "")[:8])
    print("updatedAt : %s" % result.get("updatedAt"))
    print("")
    print("SIGUIENTE PASO (manual en UI):")
    print("  1. Abrir: https://prod-low-code.iconstruye.dev/workflow/%s" % NEW_WF_ID)
    print("  2. Toggle Active (top-right) -> registra webhook en runtime")
    print("  3. Confirmar GET /webhook/cs-view responde 200")
    print("")


if __name__ == "__main__":
    main()
