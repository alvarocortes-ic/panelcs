"""
setup_mongo_n8n_credential.py — Crea credencial mongoDb en n8n apuntando a devqa Atlas.

n8n NO permite listar credentials por API ni leer su data (es write-only).
Para idempotencia: si POST devuelve 400/409 por nombre duplicado, lo reporta.

Si la crea OK, guarda el cred ID en .env.credentials como MONGO_N8N_CRED_ID.

Atlas SRV (mongodb+srv://) requiere connectionString — el n8n con `host` directo
NO resuelve SRV de Atlas. Por eso usamos configurationType=connectionString.

Uso:
    set -a; source .env.credentials; set +a
    python scripts/setup_mongo_n8n_credential.py
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
CRED_NAME = "Mongo Atlas devqa - Panel CS"


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
        return e.code, e.read().decode()[:600]


def append_env_if_missing(var_name, value):
    f = REPO.parent.parent / "ICClaude" / ".env.credentials"
    text = f.read_text(encoding="utf-8") if f.exists() else ""
    for ln in text.splitlines():
        s = ln.strip()
        if s.startswith(f"{var_name}=") and not s.startswith("#"):
            return False
    if text and not text.endswith("\n"):
        text += "\n"
    text += f"{var_name}={value}\n"
    f.write_text(text, encoding="utf-8")
    return True


def main():
    env = load_env()
    for k in ("N8N_API_URL", "N8N_API_KEY", "MONGO_HOST2", "MONGO_USER2", "MONGO_PASS2"):
        if not env.get(k):
            print(f"falta {k} en .env.credentials", file=sys.stderr)
            return 2

    # Atlas SRV connection string (host MONGO_HOST2 ya es SRV)
    pwd_enc = urllib.parse.quote_plus(env["MONGO_PASS2"])
    conn_str = f"mongodb+srv://{env['MONGO_USER2']}:{pwd_enc}@{env['MONGO_HOST2']}/automatizaciones?retryWrites=true&w=majority"

    body = {
        "name": CRED_NAME,
        "type": "mongoDb",
        "data": {
            "configurationType": "connectionString",
            "connectionString": conn_str,
            "tls": False,  # explicit false — TLS lo hace el +srv driver, no este flag
        },
    }

    print(f"=== Creando credencial mongoDb en n8n ===")
    print(f"  name: {CRED_NAME}")
    print(f"  host: {env['MONGO_HOST2']}")
    print(f"  database: automatizaciones")
    code, resp = api(env, "POST", "/credentials", body)
    if code == 200 or code == 201:
        cred_id = resp.get("id")
        print(f"  CREADA (id={cred_id})")
        if cred_id:
            added = append_env_if_missing("MONGO_N8N_CRED_ID", cred_id)
            print(f"  {'agregado' if added else 'ya estaba'} MONGO_N8N_CRED_ID en .env.credentials")
        return 0
    elif code == 400 and "already exists" in str(resp).lower():
        print(f"  EXISTE ya (n8n 400). Verificar en UI y copiar id manualmente a .env.credentials como MONGO_N8N_CRED_ID")
        return 0
    else:
        print(f"  ERROR HTTP {code}: {resp[:400]}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
