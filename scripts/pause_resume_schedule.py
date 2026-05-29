#!/usr/bin/env python3
"""
pause_resume_schedule.py - pausa/reanuda los workflows con Schedule del Panel CS.

Evita el solapamiento entre una carga manual (carga_inicial.py / cs-fetch.py) y el
Schedule cada 5min, que satura la cuota de incremental export de Zendesk
(10 req/min a nivel cuenta) y dispara HTTP 429.

Uso:
    set -a; source .env.credentials; set +a
    python outputs/cs-panel/scripts/pause_resume_schedule.py status
    python outputs/cs-panel/scripts/pause_resume_schedule.py pause     # antes de una carga
    python outputs/cs-panel/scripts/pause_resume_schedule.py resume    # al terminar

Por defecto opera sobre: "CS Data v2 (Mongo)" y "Aircall Data v2 (Mongo)".
Pasar nombres explicitos como args adicionales para override.

Portabilidad Mac/W11: usa el CA bundle de certifi si esta disponible (Mac no trae
CA del sistema para Python); fallback al default. No imprime unicode (W11 cp1252).
"""
import json
import os
import ssl
import sys
import urllib.error
import urllib.request

DEFAULT_WF = ["CS Data v2 (Mongo)", "Aircall Data v2 (Mongo)"]


def _ctx():
    c = ssl.create_default_context()
    try:
        import certifi
        c.load_verify_locations(certifi.where())
    except Exception:
        pass
    return c


def _api_base():
    return os.environ["N8N_API_URL"].rstrip("/")


def _req(method, path):
    url = _api_base() + path
    r = urllib.request.Request(url, method=method)
    r.add_header("X-N8N-API-KEY", os.environ["N8N_API_KEY"])
    r.add_header("Accept", "application/json")
    with urllib.request.urlopen(r, context=_ctx(), timeout=30) as resp:
        body = resp.read().decode("utf-8")
        return json.loads(body) if body else {}


def _list_workflows():
    out, cursor = [], None
    while True:
        path = "/workflows?limit=100" + (f"&cursor={cursor}" if cursor else "")
        j = _req("GET", path)
        out.extend(j.get("data", []))
        cursor = j.get("nextCursor")
        if not cursor:
            break
    return out


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("pause", "resume", "status"):
        sys.exit("uso: pause_resume_schedule.py pause|resume|status [nombre wf ...]")
    action = sys.argv[1]
    names = sys.argv[2:] or DEFAULT_WF
    by_name = {w["name"]: w for w in _list_workflows()}
    rc = 0
    for name in names:
        w = by_name.get(name)
        if not w:
            print(f"  [SKIP] no encontrado: {name}")
            rc = 1
            continue
        wid, cur = w["id"], w.get("active")
        if action == "status":
            print(f"  {name}: active={cur}")
            continue
        verb = "deactivate" if action == "pause" else "activate"
        try:
            _req("POST", f"/workflows/{wid}/{verb}")
            new = _req("GET", f"/workflows/{wid}").get("active")
            print(f"  {name}: {cur} -> {new}")
        except urllib.error.HTTPError as e:
            print(f"  [ERROR] {name}: HTTP {e.code} {e.read().decode()[:160]}")
            rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
