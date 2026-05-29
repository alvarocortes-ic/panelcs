#!/usr/bin/env python3
"""
clone_to_test.py - clona el flujo completo del Panel CS a un entorno paralelo _test.

Para cada workflow productivo del panel crea un gemelo con sufijo " _test":
  - webhook paths += "-test" (unicos globalmente en n8n)
  - colecciones Mongo PanelCS{Tickets,Calls,Meta} += "_test"
  - Schedule Trigger -> Webhook Trigger (POST /<slug>-run-test) para accionar a voluntad
  - recablea referencias cruzadas: en TODO jsCode reemplaza los paths productivos
    por sus -test (ej. el HTML de CS View que hace fetch a /cs-seed, /cs-data)
  - misma credencial Mongo (mismo cluster/BD)

Crea los _test ACTIVOS (un webhook solo responde si el workflow esta activo; al no
tener Schedule, no corre solo -> se acciona por curl).

Uso:
    set -a; source .env.credentials; set +a
    python scripts/clone_to_test.py            # clona todos
    python scripts/clone_to_test.py --dry-run  # solo muestra plan
"""
import json
import os
import ssl
import sys
import urllib.error
import urllib.request

# Workflows del flujo del panel a clonar (nombres productivos exactos).
TARGETS = [
    "CS Seed - Dataset del panel",
    "Aircall Seed - Llamadas del panel CS",
    "CS Data v2 (Mongo)",
    "Aircall Data v2 (Mongo)",
    "CS Export - Exportador tickets para análisis IA",
    "CS View - Presentacion del panel",
]
MONGO_COLS = ["PanelCSTickets", "PanelCSCalls", "PanelCSMeta"]


def _ctx():
    c = ssl.create_default_context()
    try:
        import certifi
        c.load_verify_locations(certifi.where())
    except Exception:
        pass
    return c


def _api():
    return os.environ["N8N_API_URL"].rstrip("/")


def _req(method, path, body=None):
    url = _api() + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    r = urllib.request.Request(url, method=method, data=data)
    r.add_header("X-N8N-API-KEY", os.environ["N8N_API_KEY"])
    r.add_header("Accept", "application/json")
    if data:
        r.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(r, context=_ctx(), timeout=60) as resp:
        b = resp.read().decode("utf-8")
        return json.loads(b) if b else {}


def list_workflows():
    out, cursor = [], None
    while True:
        p = "/workflows?limit=100" + (f"&cursor={cursor}" if cursor else "")
        j = _req("GET", p)
        out.extend(j.get("data", []))
        cursor = j.get("nextCursor")
        if not cursor:
            break
    return out


def slugify(name):
    s = name.lower().split("-")[0].strip().replace(" ", "-")
    return "".join(ch for ch in s if ch.isalnum() or ch == "-").strip("-")


def collect_webhook_paths(full_wfs):
    """Mapa global {path_viejo: path_test} de todos los webhook nodes."""
    m = {}
    for wf in full_wfs:
        for n in wf.get("nodes", []):
            if n.get("type") == "n8n-nodes-base.webhook":
                p = (n.get("parameters") or {}).get("path")
                if p and not p.endswith("-test"):
                    m[p] = p + "-test"
    return m


def replace_paths_in_str(s, path_map):
    # Reemplaza paths mas largos primero para evitar solapamientos.
    # Evita doble sufijo: no toca lo que ya termina en -test.
    for old in sorted(path_map, key=len, reverse=True):
        s = s.replace("/" + old + "-test", "\x00KEEP\x00")  # proteger ya-test
        s = s.replace("/" + old, "/" + path_map[old])
        s = s.replace("\x00KEEP\x00", "/" + path_map[old])
    return s


def deep_replace(obj, path_map):
    """Recorre recursivamente dicts/lists/strings y reemplaza paths.
    Cubre el HTML embebido en nodos Set (params.assignments[].value)."""
    if isinstance(obj, str):
        return replace_paths_in_str(obj, path_map)
    if isinstance(obj, list):
        return [deep_replace(x, path_map) for x in obj]
    if isinstance(obj, dict):
        return {k: deep_replace(v, path_map) for k, v in obj.items()}
    return obj


def transform(wf, path_map):
    new_nodes = []
    for n in wf.get("nodes", []):
        nn = json.loads(json.dumps(n))  # copia profunda
        params = nn.get("parameters") or {}
        ntype = nn.get("type")

        # Webhook: path += -test, webhookId nuevo
        if ntype == "n8n-nodes-base.webhook":
            p = params.get("path")
            if p and not p.endswith("-test"):
                params["path"] = p + "-test"
            nn["webhookId"] = params.get("path")

        # Schedule Trigger -> Webhook Trigger (accionar a voluntad)
        elif ntype == "n8n-nodes-base.scheduleTrigger":
            run_path = slugify(wf["name"]) + "-run-test"
            nn["type"] = "n8n-nodes-base.webhook"
            nn["typeVersion"] = 2.1
            nn["parameters"] = {"httpMethod": "POST", "path": run_path, "responseMode": "lastNode"}
            nn["webhookId"] = run_path
            nn["notes"] = "TEST: reemplaza Schedule Trigger. Disparar con POST /" + run_path

        # MongoDB: colecciones -> _test
        elif ntype == "n8n-nodes-base.mongoDb":
            col = params.get("collection")
            if col in MONGO_COLS:
                params["collection"] = col + "_test"

        # Reemplazo recursivo de paths cruzados en TODA la estructura de params
        # (cubre jsCode y el HTML embebido en nodos Set: params.assignments[].value).
        # IMPORTANTE: usar nn["parameters"] (no la var params, que en el caso
        # scheduleTrigger quedo apuntando al dict viejo de la rule).
        # No toca params.path/webhookId (no llevan "/" prefijo) ni colecciones Mongo.
        nn["parameters"] = deep_replace(nn.get("parameters") or {}, path_map)
        new_nodes.append(nn)

    settings = wf.get("settings") or {}
    clean_settings = {
        "executionOrder": settings.get("executionOrder", "v1"),
        "saveDataSuccessExecution": settings.get("saveDataSuccessExecution", "none"),
        "saveDataErrorExecution": settings.get("saveDataErrorExecution", "all"),
        "executionTimeout": settings.get("executionTimeout", 240),
    }
    return {
        "name": wf["name"] + " _test",
        "nodes": new_nodes,
        "connections": wf.get("connections", {}),
        "settings": clean_settings,
    }


def main():
    dry = "--dry-run" in sys.argv
    all_wfs = list_workflows()
    by_name = {w["name"]: w for w in all_wfs}
    existing_test = {w["name"] for w in all_wfs}

    # 1) traer full de los targets
    fulls = []
    for name in TARGETS:
        w = by_name.get(name)
        if not w:
            print(f"  [SKIP] no encontrado: {name}")
            continue
        fulls.append(_req("GET", f"/workflows/{w['id']}"))

    # 2) mapa global de paths
    path_map = collect_webhook_paths(fulls)
    print("=== mapa de paths (viejo -> test) ===")
    for k, v in path_map.items():
        print(f"  {k} -> {v}")

    # 3) clonar
    print("\n=== clonando ===")
    created = []
    for wf in fulls:
        test_name = wf["name"] + " _test"
        if test_name in existing_test:
            print(f"  [YA EXISTE] {test_name} -> borra primero si quieres recrear")
            continue
        body = transform(wf, path_map)
        n_sched = sum(1 for n in wf["nodes"] if n.get("type") == "n8n-nodes-base.scheduleTrigger")
        if dry:
            print(f"  [DRY] {test_name}: {len(body['nodes'])} nodos · schedules->webhook: {n_sched}")
            continue
        res = _req("POST", "/workflows", body)
        wid = res.get("id")
        # activar
        act = ""
        try:
            _req("POST", f"/workflows/{wid}/activate")
            act = "active"
        except urllib.error.HTTPError as e:
            act = f"NO-ACTIVADO HTTP{e.code}: {e.read().decode()[:120]}"
        created.append((test_name, wid, act))
        print(f"  [OK] {test_name} id={wid} {act}")

    if created:
        print("\n=== resumen ===")
        for name, wid, act in created:
            print(f"  {name} | {wid} | {act}")


if __name__ == "__main__":
    main()
