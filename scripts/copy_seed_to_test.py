#!/usr/bin/env python3
"""
copy_seed_to_test.py - copia los blobs de seed (gzip+base64) de PROD a los
workflows _test. Necesario porque al clonar un workflow via API el staticData
(donde CS Seed / Aircall Seed guardan el blob) NO se copia.

Lee /cs-seed y /aircall-seed (prod), publica a /cs-seed-test y /aircall-seed-test.
Solo lee de prod (GET) y escribe a test (POST). No modifica nada productivo.

Uso:
    set -a; source .env.credentials; set +a
    python outputs/cs-panel/scripts/copy_seed_to_test.py
"""
import os
import ssl
import json
import sys
import urllib.request

PAIRS = [("cs-seed", "cs-seed-test"), ("aircall-seed", "aircall-seed-test")]


def _ctx():
    c = ssl.create_default_context()
    try:
        import certifi
        c.load_verify_locations(certifi.where())
    except Exception:
        pass
    return c


def _wb():
    return os.environ["N8N_WEBHOOK_BASE"].rstrip("/")


def get_json(path):
    r = urllib.request.Request(_wb() + "/" + path)
    with urllib.request.urlopen(r, context=_ctx(), timeout=180) as resp:
        return json.loads(resp.read().decode("utf-8"))


def post_json(path, body):
    data = json.dumps(body).encode("utf-8")
    r = urllib.request.Request(_wb() + "/" + path, data=data, method="POST")
    r.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(r, context=_ctx(), timeout=300) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    token = os.environ.get("CS_SEED_TOKEN")
    if not token:
        sys.exit("ERROR: falta CS_SEED_TOKEN en el entorno.")
    for src, dst in PAIRS:
        try:
            j = get_json(src + "?t=copy")
        except Exception as e:
            print(f"  [SKIP] no pude leer prod /{src}: {e}")
            continue
        gz = j.get("gz")
        count = j.get("count") or 0
        if not gz:
            print(f"  [SKIP] prod /{src} sin gz (count={count})")
            continue
        res = post_json(dst, {"token": token, "gz": gz, "count": count})
        ok = res.get("ok")
        # verificar
        chk = get_json(dst + "?t=verify")
        chk_bytes = len(chk.get("gz") or "")
        print(f"  /{src} ({len(gz)} b, count={count}) -> /{dst}: publish ok={ok} · verify gz={chk_bytes} b count={chk.get('count')}")


if __name__ == "__main__":
    main()
