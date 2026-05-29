"""
setup_n8n_credentials.py — crea las 2 Credentials del Panel CS en n8n.

Aircall   : httpBasicAuth   - user=AIRCALL_API_ID, password=AIRCALL_API_TOKEN
Wotnot    : httpHeaderAuth  - name=Authorization, value="Bearer <WOTNOT_API_ACCESS_TOKEN>"

n8n NO permite listar credenciales por API ni leer su data. Para idempotencia:
si el POST falla por nombre duplicado (HTTP 400/409), reporta y sigue — el id
existente lo conseguís en la UI (URL del credential).

Uso:
  set -a; source .env.credentials; set +a
  python scripts/setup_n8n_credentials.py [--only aircall|wotnot]

Requiere en .env.credentials: N8N_API_URL, N8N_API_KEY,
  AIRCALL_API_ID, AIRCALL_API_TOKEN, WOTNOT_API_ACCESS_TOKEN
"""
import argparse
import json
import sys
import urllib.request
import urllib.error
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def load_env() -> dict:
    env = {}
    f = REPO.parent.parent / "ICClaude" / ".env.credentials"
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def api(env: dict, method: str, path: str, body=None):
    url = env["N8N_API_URL"].rstrip("/") + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"X-N8N-API-KEY": env["N8N_API_KEY"], "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return ("ok", json.loads(r.read() or "{}"))
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:600]
        return (f"http_{e.code}", body)


def upsert_credential(env: dict, name: str, cred_type: str, data: dict) -> str | None:
    """Crea la credencial. Devuelve el id si la creó, None si ya existía o falló."""
    body = {"name": name, "type": cred_type, "data": data}
    status, resp = api(env, "POST", "/credentials", body)
    if status == "ok":
        cid = resp.get("id")
        print(f"  CREADA  '{name}' (id={cid})")
        return cid
    elif status.startswith("http_"):
        # n8n responde 400 si hay conflicto de nombre. No expone LIST de creds.
        print(f"  EXISTE? '{name}' - n8n rechazó la creación: {resp[:200]}")
        print(f"           Verificá en UI: Credentials -> '{name}' (copia el id de la URL)")
        return None


def append_env_if_missing(var_name: str, value: str) -> bool:
    """Anexa VAR=value al final del .env.credentials si la var no está presente.

    Devuelve True si lo agregó, False si ya existía.
    """
    f = REPO.parent.parent / "ICClaude" / ".env.credentials"
    text = f.read_text(encoding="utf-8") if f.exists() else ""
    # match al inicio de línea (con o sin comentario) -> evitar falsos positivos
    for ln in text.splitlines():
        s = ln.strip()
        if s.startswith(f"{var_name}=") and not s.startswith("#"):
            return False
    if text and not text.endswith("\n"):
        text += "\n"
    text += f"{var_name}={value}\n"
    f.write_text(text, encoding="utf-8")
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["aircall", "wotnot"], default=None)
    args = ap.parse_args()
    env = load_env()
    for k in ("N8N_API_URL", "N8N_API_KEY"):
        if not env.get(k):
            print(f"falta {k} en .env.credentials", file=sys.stderr)
            return 2

    print(f"=== n8n: {env['N8N_API_URL']} ===")

    if args.only in (None, "aircall"):
        if not env.get("AIRCALL_API_ID") or not env.get("AIRCALL_API_TOKEN"):
            print("falta AIRCALL_API_ID/AIRCALL_API_TOKEN", file=sys.stderr)
        else:
            cid = upsert_credential(
                env,
                name="Aircall Basic - iconstruye",
                cred_type="httpBasicAuth",
                data={"user": env["AIRCALL_API_ID"], "password": env["AIRCALL_API_TOKEN"]},
            )
            if cid:
                added = append_env_if_missing("AIRCALL_N8N_CRED_ID", cid)
                print(f"    -> {'agregado' if added else 'ya estaba'} AIRCALL_N8N_CRED_ID en .env.credentials")

    if args.only in (None, "wotnot"):
        if not env.get("WOTNOT_API_ACCESS_TOKEN"):
            print("falta WOTNOT_API_ACCESS_TOKEN", file=sys.stderr)
        else:
            cid = upsert_credential(
                env,
                name="Wotnot Bearer - iconstruye",
                cred_type="httpHeaderAuth",
                data={"name": "Authorization", "value": f"Bearer {env['WOTNOT_API_ACCESS_TOKEN']}"},
            )
            if cid:
                added = append_env_if_missing("WOTNOT_N8N_CRED_ID", cid)
                print(f"    -> {'agregado' if added else 'ya estaba'} WOTNOT_N8N_CRED_ID en .env.credentials")

    print()
    print("Si alguna salió 'EXISTE?' chequeá la UI - probablemente ya estaba creada.")
    print("Si querés su id existente: abrila en la UI, copiá el id de la URL,")
    print("  y agregalo manualmente al .env.credentials como AIRCALL_N8N_CRED_ID o WOTNOT_N8N_CRED_ID.")
    print()
    print("Si las dos salieron CREADA, podés seguir con setup_aircall_data.py.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
