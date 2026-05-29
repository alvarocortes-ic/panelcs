#!/usr/bin/env python3
"""
migrate_cs_view_v2.py — clona el workflow CS View viejo (corrupto a nivel BD n8n)
a un workflow nuevo `CS View v2`, con el CSS+JS local correcto.

Razón: el workflow viejo `kQmPeDgXA27mKQPj` tiene FK violation persistente
(FK_08d6c67b7f722b0039d9d5ed620) que impide cualquier PUT con cambios reales
al contenido. El webhook handler responde 500 por estado corrupto de caché
interna y no se arregla con toggle deactivate/activate.

Plan ejecutado:
  1. GET workflow viejo → base del payload nuevo.
  2. Leer cs-view.styles.css + cs-view.render.js del repo (versión correcta con 35 mesas).
  3. Desactivar workflow viejo (libera el webhook path "cs-view").
  4. POST workflow nuevo "CS View v2 - Presentación del panel".
  5. Activar nuevo.
  6. Verificar webhook GET → 200.
  7. Imprimir nuevo WF_ID para actualizar deploy_cs_view.py.

Uso:
    set -a; source .env.credentials; set +a
    python outputs/cs-panel/scripts/migrate_v2/migrate_cs_view_v2.py

Idempotencia: si encuentra ya un workflow llamado "CS View v2 - Presentación del panel",
aborta sin tocar nada (proteger contra doble corrida).
"""
import os
import sys
import json
import time
import datetime
import urllib.request
import urllib.error

OLD_WF_ID = "kQmPeDgXA27mKQPj"
NEW_NAME = "CS View v2 - Presentación del panel"
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
CSS_FILE = os.path.join(REPO, "outputs/cs-panel/n8n/cs-view.styles.css")
JS_FILE = os.path.join(REPO, "outputs/cs-panel/n8n/cs-view.render.js")


def api_base():
    url = os.environ.get("N8N_API_URL") or os.environ.get("N8N_BASE_URL")
    if not url:
        sys.exit("ERROR: falta N8N_API_URL en el entorno.")
    url = url.rstrip("/")
    if "/api/" not in url:
        url += "/api/v1"
    return url


def api(method, path, body=None):
    key = os.environ.get("N8N_API_KEY")
    if not key:
        sys.exit("ERROR: falta N8N_API_KEY en el entorno.")
    req = urllib.request.Request(
        api_base() + path,
        method=method,
        headers={"X-N8N-API-KEY": key, "Content-Type": "application/json"},
        data=json.dumps(body).encode("utf-8") if body is not None else None,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            text = r.read().decode("utf-8")
            return json.loads(text) if text else {}
    except urllib.error.HTTPError as e:
        body_err = e.read().decode("utf-8", "ignore")
        print(f"  ERROR HTTP {e.code} en {method} {path}:\n  {body_err[:500]}")
        raise


def find_existing_v2():
    """Listar workflows y ver si ya existe CS View v2."""
    data = api("GET", "/workflows?limit=200")
    for w in data.get("data", []):
        if w.get("name") == NEW_NAME:
            return w
    return None


def main():
    # 0. Idempotencia: si ya existe v2, abortar
    existing = find_existing_v2()
    if existing:
        print(f"[migrate] ⚠️  Ya existe '{NEW_NAME}' (id={existing['id']}, active={existing.get('active')}). Aborta sin tocar nada.")
        sys.exit(0)

    # 1. GET workflow viejo
    print(f"[migrate] GET workflow viejo {OLD_WF_ID}...")
    old = api("GET", f"/workflows/{OLD_WF_ID}")
    print(f"  name={old['name']!r} active={old['active']} versionCounter={old.get('versionCounter')}")

    # 2. Leer archivos locales
    with open(CSS_FILE, encoding="utf-8") as f:
        css = f.read()
    with open(JS_FILE, encoding="utf-8") as f:
        js = f.read()
    print(f"[migrate] local CSS={len(css)} bytes · JS={len(js)} bytes")

    # 3. Construir payload nuevo: copiar nodos+connections, reemplazar CSS+JS+version
    nodes = json.loads(json.dumps(old["nodes"]))  # deep copy
    construir = next((n for n in nodes if n["name"] == "Construir Vista"), None)
    if not construir:
        sys.exit("ERROR: nodo 'Construir Vista' no encontrado en el workflow viejo.")
    new_version = "v2-migration-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    new_generated = datetime.datetime.now(datetime.timezone.utc).isoformat()
    for a in construir["parameters"]["assignments"]["assignments"]:
        if a["name"] == "css":
            a["value"] = css
        elif a["name"] == "js":
            a["value"] = js
        elif a["name"] == "version":
            a["value"] = new_version
        elif a["name"] == "generated_at":
            a["value"] = new_generated

    payload = {
        "name": NEW_NAME,
        "nodes": nodes,
        "connections": old["connections"],
        "settings": old.get("settings", {}),
    }
    if old.get("staticData") is not None:
        payload["staticData"] = old["staticData"]

    # 4. Desactivar viejo
    print(f"[migrate] desactivando viejo {OLD_WF_ID}...")
    api("POST", f"/workflows/{OLD_WF_ID}/deactivate")
    time.sleep(1)

    # 5. POST workflow nuevo
    print(f"[migrate] POST nuevo workflow '{NEW_NAME}'...")
    new = api("POST", "/workflows", body=payload)
    new_id = new["id"]
    print(f"  ✅ creado: id={new_id}")

    # 6. Activar nuevo
    print(f"[migrate] activando nuevo {new_id}...")
    api("POST", f"/workflows/{new_id}/activate")
    time.sleep(3)

    # 7. Verificar webhook
    print(f"[migrate] probando webhook cs-view...")
    import requests
    r = requests.get("https://prod-low-code.iconstruye.dev/webhook/cs-view", timeout=30)
    print(f"  status={r.status_code} size={len(r.content)} bytes")
    if r.status_code == 200:
        print(f"  ✅ webhook OK")
        sample = r.text[:200]
        print(f"  body sample: {sample}")
    else:
        print(f"  ⚠️  webhook NO OK · body: {r.text[:500]}")
        print(f"  → revisar manualmente. Workflow viejo desactivado, nuevo creado pero falla.")

    print()
    print("=" * 60)
    print(f"WF_ID NUEVO: {new_id}")
    print(f"WF_ID VIEJO (desactivado): {OLD_WF_ID}")
    print("=" * 60)
    print()
    print("Próximos pasos manuales:")
    print(f"  1. Actualizar WF_ID en outputs/cs-panel/scripts/deploy_cs_view.py:")
    print(f'     WF_ID = "{new_id}"  # antes: kQmPeDgXA27mKQPj')
    print(f"  2. Verificar UI: https://prod-low-code.iconstruye.dev/workflow/{new_id}")
    print(f"  3. Si el panel CS productivo funciona OK, el viejo se puede archivar:")
    print(f'     bash -c "curl -s -X POST -H \\"X-N8N-API-KEY: $N8N_API_KEY\\" $N8N_API_URL/workflows/{OLD_WF_ID}/archive"')


if __name__ == "__main__":
    main()
