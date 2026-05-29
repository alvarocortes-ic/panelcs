#!/usr/bin/env python3
"""
deploy_cs_view.py - despliega el render de cs-view a n8n.

Toma los archivos fuente versionados:
    n8n/cs-view.styles.css   -> assignment "css"
    n8n/cs-view.render.js    -> assignment "js"
y los escribe en el nodo "Construir Vista" del workflow CS View.

n8n es el backend que sirve el panel a todos los equipos; este script
es el paso de "deploy". La fuente de verdad del codigo es el repo.

Uso:
    set -a; source .env.credentials; set +a
    python scripts/deploy_cs_view.py [version]          # PROD
    python scripts/deploy_cs_view.py --test [version]   # entorno _test

--test: despliega al workflow "CS View - Presentacion del panel _test" y reescribe
los endpoints a sus variantes -test (excepto cs-dte-health, que el panel llama al
productivo por decision de diseno).

Requiere N8N_API_URL y N8N_API_KEY. Portabilidad Mac: usa certifi si esta disponible.
"""
import os
import sys
import ssl
import json
import datetime
import urllib.request
import urllib.error

NODE = "Construir Vista"
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CSS_FILE = os.path.join(REPO, "n8n/cs-view.styles.css")
JS_FILE = os.path.join(REPO, "n8n/cs-view.render.js")

WF_NAME_PROD = "CS View - Presentacion del panel"
WF_NAME_TEST = "CS View - Presentacion del panel _test"

# Endpoints a reescribir a -test (NO incluye cs-dte-health: el panel test lo llama
# al productivo). Mas largo primero para evitar solapamientos.
TEST_REPLACEMENTS = [
    "aircall-seed", "aircall-data", "cs-export", "cs-data", "cs-seed", "cs-view",
]


def _ctx():
    c = ssl.create_default_context()
    try:
        import certifi
        c.load_verify_locations(certifi.where())
    except Exception:
        pass
    return c


def api_base():
    url = os.environ.get("N8N_API_URL") or os.environ.get("N8N_BASE_URL")
    if not url:
        sys.exit("ERROR: falta N8N_API_URL (o N8N_BASE_URL) en el entorno.")
    url = url.rstrip("/")
    if "/api/" not in url:
        url += "/api/v1"
    return url


def api(method, path, body=None):
    key = os.environ.get("N8N_API_KEY")
    if not key:
        sys.exit("ERROR: falta N8N_API_KEY en el entorno.")
    req = urllib.request.Request(
        api_base() + path, method=method,
        headers={"X-N8N-API-KEY": key, "Content-Type": "application/json"},
        data=json.dumps(body).encode("utf-8") if body is not None else None,
    )
    try:
        with urllib.request.urlopen(req, timeout=30, context=_ctx()) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        sys.exit("ERROR HTTP %s en %s %s:\n%s" % (e.code, method, path, e.read().decode("utf-8", "ignore")))


def to_test(text):
    for ep in sorted(TEST_REPLACEMENTS, key=len, reverse=True):
        text = text.replace("/" + ep + "-test", "\x00K\x00")
        text = text.replace("/" + ep, "/" + ep + "-test")
        text = text.replace("\x00K\x00", "/" + ep + "-test")
    return text


def find_wf_id(name):
    cursor = None
    while True:
        p = "/workflows?limit=100" + ("&cursor=" + cursor if cursor else "")
        j = api("GET", p)
        for w in j.get("data", []):
            if w["name"] == name:
                return w["id"]
        cursor = j.get("nextCursor")
        if not cursor:
            break
    sys.exit("ERROR: no se encontro el workflow '%s'." % name)


def main():
    args = [a for a in sys.argv[1:]]
    is_test = "--test" in args
    args = [a for a in args if a != "--test"]
    version = args[0] if args else "dev-" + datetime.datetime.now().strftime("%Y%m%d-%H%M")
    if is_test:
        version += "-test"

    with open(CSS_FILE, encoding="utf-8") as f:
        css = f.read()
    with open(JS_FILE, encoding="utf-8") as f:
        js = f.read()
    if is_test:
        css = to_test(css)
        js = to_test(js)

    wf_name = WF_NAME_TEST if is_test else WF_NAME_PROD
    wf_id = find_wf_id(wf_name)
    wf = api("GET", "/workflows/%s" % wf_id)

    node = next((n for n in wf["nodes"] if n["name"] == NODE), None)
    if not node:
        sys.exit('ERROR: no se encontro el nodo "%s" en %s.' % (NODE, wf_name))

    found = set()
    for a in node["parameters"]["assignments"]["assignments"]:
        if a["name"] == "css":
            a["value"] = css; found.add("css")
        elif a["name"] == "js":
            a["value"] = js; found.add("js")
        elif a["name"] == "version":
            a["value"] = version; found.add("version")
    missing = {"css", "js", "version"} - found
    if missing:
        sys.exit("ERROR: faltan assignments en el nodo: %s" % ", ".join(sorted(missing)))

    SETTINGS_WHITELIST = {
        "executionOrder", "saveManualExecutions", "saveExecutionProgress",
        "saveDataErrorExecution", "saveDataSuccessExecution",
        "executionTimeout", "timezone", "errorWorkflow",
    }
    settings = {k: v for k, v in wf.get("settings", {}).items() if k in SETTINGS_WHITELIST}

    payload = {"name": wf["name"], "nodes": wf["nodes"], "connections": wf["connections"], "settings": settings}
    api("PUT", "/workflows/%s" % wf_id, payload)

    print("deploy OK -> %s  version=%s" % (wf_name, version))
    print("  css: %d bytes   js: %d bytes" % (len(css), len(js)))
    print("  endpoint: /cs-view%s" % ("-test" if is_test else ""))


if __name__ == "__main__":
    main()
