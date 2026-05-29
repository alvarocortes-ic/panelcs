#!/usr/bin/env python3
"""
connect_eclipse_credential.py — asigna la credencial Eclipse al workflow CS Email.

Lee CS_ECLIPSE_CREDENTIAL_ID del entorno y la asigna al nodo HTTP
"Enviar Eclipse" del workflow CS Email en n8n.

Uso:
    set -a; source .env.credentials; set +a
    python scripts/connect_eclipse_credential.py

Requiere: N8N_API_URL, N8N_API_KEY, CS_ECLIPSE_CREDENTIAL_ID.
"""
import os
import sys
import json
import urllib.request
import urllib.error

WF_ID = "ARQJQmYpEl6Zd3sn"          # workflow "CS Email - Envío de correos (Eclipse)"
NODE = "Enviar Eclipse"
CRED_NAME = "Eclipse Email QA"


def api_base():
    url = os.environ.get("N8N_API_URL") or os.environ.get("N8N_BASE_URL")
    if not url:
        sys.exit("ERROR: falta N8N_API_URL (o N8N_BASE_URL).")
    url = url.rstrip("/")
    if "/api/" not in url:
        url += "/api/v1"
    return url


def api(method, path, body=None):
    key = os.environ.get("N8N_API_KEY")
    if not key:
        sys.exit("ERROR: falta N8N_API_KEY.")
    req = urllib.request.Request(
        api_base() + path,
        method=method,
        headers={"X-N8N-API-KEY": key, "Content-Type": "application/json"},
        data=json.dumps(body).encode("utf-8") if body is not None else None,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        sys.exit("ERROR HTTP %s en %s %s:\n%s"
                 % (e.code, method, path, e.read().decode("utf-8", "ignore")))


def main():
    cred_id = os.environ.get("CS_ECLIPSE_CREDENTIAL_ID")
    if not cred_id:
        sys.exit("ERROR: CS_ECLIPSE_CREDENTIAL_ID vacío. Rellénalo en .env.credentials.")

    wf = api("GET", "/workflows/%s" % WF_ID)
    node = next((n for n in wf["nodes"] if n["name"] == NODE), None)
    if not node:
        sys.exit('ERROR: no se encontró el nodo "%s".' % NODE)

    node["credentials"] = {"oAuth2Api": {"id": cred_id, "name": CRED_NAME}}

    payload = {
        "name": wf["name"],
        "nodes": wf["nodes"],
        "connections": wf["connections"],
        "settings": wf.get("settings", {}),
    }
    api("PUT", "/workflows/%s" % WF_ID, payload)
    print('credencial OAuth2 asignada al nodo "%s" de CS Email' % NODE)


if __name__ == "__main__":
    main()
