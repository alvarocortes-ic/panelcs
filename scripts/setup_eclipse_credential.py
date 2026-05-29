#!/usr/bin/env python3
"""
setup_eclipse_credential.py — crea la credencial OAuth2 de Eclipse en n8n.

Lee ECLIPSE_AUTH_URL / ECLIPSE_CLIENT_ID / ECLIPSE_CLIENT_SECRET del
entorno y crea una credencial "oAuth2Api" (grant client_credentials)
en n8n. Los valores nunca se imprimen; solo se reporta el ID resultante.

Uso (una sola vez):
    set -a; source .env.credentials; set +a
    python outputs/cs-panel/scripts/setup_eclipse_credential.py

Requiere: N8N_API_URL, N8N_API_KEY, ECLIPSE_AUTH_URL,
          ECLIPSE_CLIENT_ID, ECLIPSE_CLIENT_SECRET.
"""
import os
import sys
import json
import urllib.request
import urllib.error

CRED_NAME = "Eclipse Email QA"


def api_base():
    url = os.environ.get("N8N_API_URL") or os.environ.get("N8N_BASE_URL")
    if not url:
        sys.exit("ERROR: falta N8N_API_URL (o N8N_BASE_URL).")
    url = url.rstrip("/")
    if "/api/" not in url:
        url += "/api/v1"
    return url


def main():
    auth = os.environ.get("ECLIPSE_AUTH_URL")
    cid = os.environ.get("ECLIPSE_CLIENT_ID")
    csec = os.environ.get("ECLIPSE_CLIENT_SECRET")
    key = os.environ.get("N8N_API_KEY")
    miss = [n for n, v in [
        ("ECLIPSE_AUTH_URL", auth), ("ECLIPSE_CLIENT_ID", cid),
        ("ECLIPSE_CLIENT_SECRET", csec), ("N8N_API_KEY", key)] if not v]
    if miss:
        sys.exit("ERROR: faltan variables en el entorno: " + ", ".join(miss))

    payload = {
        "name": CRED_NAME,
        "type": "oAuth2Api",
        "data": {
            "grantType": "clientCredentials",
            "accessTokenUrl": auth,
            "clientId": cid,
            "clientSecret": csec,
            "scope": "",
            "authentication": "body",
            "sendAdditionalBodyProperties": False,
            "additionalBodyProperties": "{}",
        },
    }
    req = urllib.request.Request(
        api_base() + "/credentials",
        method="POST",
        headers={"X-N8N-API-KEY": key, "Content-Type": "application/json"},
        data=json.dumps(payload).encode("utf-8"),
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            res = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        sys.exit("ERROR HTTP %s al crear credencial:\n%s"
                 % (e.code, e.read().decode("utf-8", "ignore")))

    print("credencial creada en n8n")
    print("  id:   %s" % res.get("id"))
    print("  name: %s" % res.get("name"))
    print("  type: %s" % res.get("type"))


if __name__ == "__main__":
    main()
