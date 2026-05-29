"""
carga_inicial_aircall.py — Carga inicial de llamadas Aircall para el Panel CS.

Genera el dataset seed de llamadas Aircall que el cliente del panel importa.
Patrón paralelo a carga_inicial.py (Zendesk) — mismo shape de publicación:
gzip+base64 → POST a webhook /aircall-seed con token.

Fuente: GET /v1/calls?from=<unix>&page=N&per_page=50 (paginado).
  - 'from'/'to' son UNIX timestamps (segundos).
  - Default: from = 2026-01-01 00:00:00 UTC (decision SES-20260525-1602).
  - Pagina hasta agotar meta.next_page_link.
  - Respeta rate limit 120/min via headers X-AircallApi-Remaining.

Slim del Call (29 fields originales → 19 fields útiles para el panel):
  id, direction, status, started_at, answered_at, ended_at, duration, frt_sec,
  missed_reason, raw_digits, user_id, user_name, number_id, number_name (IVR),
  contact_name, contact_id, recording, voicemail, tags, archived

Uso:
  set -a; source .env.credentials; set +a
  python outputs/cs-panel/scripts/carga_inicial_aircall.py [--desde 2026-01-01] [--publish-only] [--dry-run]

Requiere en .env.credentials:
  AIRCALL_API_ID, AIRCALL_API_TOKEN, AIRCALL_API_BASE_URL
  CS_SEED_TOKEN (reusado), N8N_BASE_URL (o N8N_API_URL para inferirlo)
"""
import argparse
import base64
import gzip
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    import requests
except ImportError:
    print("requests no instalado. Usa: tools/zendesk-toolkit/.venv/bin/python", file=sys.stderr)
    sys.exit(1)

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUT = REPO_ROOT / "outputs" / "cs-panel" / "data" / "aircall-seed.json.gz.b64"


def load_env() -> dict:
    env: dict[str, str] = {}
    env_file = REPO_ROOT / ".env.credentials"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    missing = [k for k in ("AIRCALL_API_ID", "AIRCALL_API_TOKEN", "AIRCALL_API_BASE_URL") if not env.get(k)]
    if missing:
        print(f"faltan vars en .env.credentials: {missing}", file=sys.stderr)
        sys.exit(2)
    return env


def slim_call(c: dict) -> dict:
    """Shape mínimo y estable que el panel consume."""
    user = c.get("user") or {}
    number = c.get("number") or {}
    contact = c.get("contact") or {}
    started = c.get("started_at")
    answered = c.get("answered_at")
    return {
        "id": c["id"],
        "direction": c.get("direction"),                # inbound | outbound
        "status": c.get("status"),                       # initial | answered | done
        "started_at": started,
        "answered_at": answered,
        "ended_at": c.get("ended_at"),
        "duration": c.get("duration"),                   # seg
        "frt_sec": (answered - started) if (answered and started) else None,
        "missed_reason": c.get("missed_call_reason"),    # null si fue respondida
        "raw_digits": c.get("raw_digits"),               # E.164 o "anonymous"
        "user_id": user.get("id"),
        "user_name": user.get("name"),
        "number_id": number.get("id"),
        "number_name": number.get("name"),               # IVR (Soporte FE / iC / Sodexo)
        "contact_id": contact.get("id"),
        "contact_name": contact.get("name"),
        "recording": c.get("recording_short_url") or c.get("recording"),
        "voicemail": c.get("voicemail_short_url") or c.get("voicemail"),
        "tags": [t.get("name") for t in (c.get("tags") or []) if t.get("name")],
        "archived": bool(c.get("archived")),
    }


def fetch_calls(env: dict, from_unix: int, to_unix: int = None, label: str = "") -> list[dict]:
    """Itera /v1/calls?from=&to=&page=&per_page=50 hasta agotar next_page_link.

    OJO: el endpoint /v1/calls de Aircall tiene un cap implícito de ~10.000 results
    por request (incluso paginando). Para >10k calls totales hay que usar fetch_calls_chunked.
    """
    base = env["AIRCALL_API_BASE_URL"].rstrip("/")    # ya incluye /v1
    auth = (env["AIRCALL_API_ID"], env["AIRCALL_API_TOKEN"])
    all_calls: list[dict] = []
    params = {"from": from_unix, "per_page": 50, "order": "asc"}
    if to_unix:
        params["to"] = to_unix
    page = 0
    started = time.time()
    next_url = f"{base}/calls"
    while next_url:
        page += 1
        t0 = time.time()
        r = requests.get(next_url, auth=auth, params=(params if page == 1 else None), timeout=120)
        if r.status_code == 429:
            reset = int(r.headers.get("X-AircallApi-Reset", "60"))
            wait = max(1, reset - int(time.time()))
            print(f"  [{label} pag {page}] rate limit, esperando {wait}s")
            time.sleep(wait)
            page -= 1
            continue
        r.raise_for_status()
        j = r.json()
        batch = j.get("calls", [])
        all_calls.extend(batch)
        meta = j.get("meta") or {}
        rem = r.headers.get("X-AircallApi-Remaining", "?")
        print(f"  [{label} pag {page}] +{len(batch):>3} calls | acum {len(all_calls):>5} | "
              f"remaining={rem} | {time.time()-t0:.1f}s")
        next_url = meta.get("next_page_link")
        if next_url:
            time.sleep(0.5)
    print(f"  [{label}] total: {len(all_calls)} calls en {page} pags ({time.time()-started:.1f}s)")
    return all_calls


def fetch_calls_chunked(env: dict, from_unix: int, to_unix: int) -> list[dict]:
    """Fetchea calls dividiendo el rango total en chunks de 1 mes calendario.

    Cada chunk se queda muy por debajo del cap de 10.000 del endpoint /v1/calls
    (volumen real de iC ~3.500 calls/mes). Garantiza cobertura sin gaps.
    """
    from datetime import datetime, timezone
    from calendar import monthrange

    chunks: list[tuple[int, int, str]] = []
    cur = datetime.fromtimestamp(from_unix, tz=timezone.utc)
    end = datetime.fromtimestamp(to_unix, tz=timezone.utc)
    while cur < end:
        # primer día del mes siguiente
        if cur.month == 12:
            next_month = cur.replace(year=cur.year + 1, month=1, day=1, hour=0, minute=0, second=0)
        else:
            next_month = cur.replace(month=cur.month + 1, day=1, hour=0, minute=0, second=0)
        chunk_end = min(next_month, end)
        label = cur.strftime("%Y-%m")
        chunks.append((int(cur.timestamp()), int(chunk_end.timestamp()) - 1, label))
        cur = next_month

    print(f"== Fetching {len(chunks)} chunks (mensual): {chunks[0][2]} -> {chunks[-1][2]} ==")
    seen_ids: set = set()
    all_calls: list[dict] = []
    for c_from, c_to, label in chunks:
        chunk = fetch_calls(env, c_from, c_to, label=label)
        # dedup por id (defensivo — solape entre chunks no debería ocurrir pero por las dudas)
        new = 0
        for call in chunk:
            cid = call.get("id")
            if cid and cid not in seen_ids:
                seen_ids.add(cid)
                all_calls.append(call)
                new += 1
        dup = len(chunk) - new
        if dup:
            print(f"  [{label}] {dup} duplicados descartados")
    print(f"== TOTAL chunked: {len(all_calls)} calls únicas ==")
    return all_calls


def publish_seed(env: dict, blob: str, count: int) -> None:
    """Publica el dataset (gzip+base64) al workflow Aircall Seed."""
    base = env.get("N8N_BASE_URL", "").rstrip("/")
    if not base:
        n8n_url = env.get("N8N_API_URL", "").rstrip("/")
        base = n8n_url[:-len("/api/v1")] if n8n_url.endswith("/api/v1") else n8n_url
    token = env.get("CS_SEED_TOKEN", "")
    if not base or not token:
        print("  (sin N8N_BASE_URL/CS_SEED_TOKEN - se omite la publicación a n8n)")
        return
    gz = base64.b64encode(gzip.compress(blob.encode("utf-8"), 9)).decode("ascii")
    print(f"  publicando a n8n... (gzip+base64 = {len(gz)/1048576:.1f} MB)")
    try:
        r = requests.post(base + "/webhook/aircall-seed",
                          json={"token": token, "gz": gz, "count": count,
                                "generated_at": datetime.now(timezone.utc).isoformat()},
                          timeout=180)
        r.raise_for_status()
        j = r.json()
        if j.get("ok"):
            print(f"  ok - seed publicado a n8n - count={j.get('count')}")
        else:
            print(f"  WARN - n8n rechazó la publicación: {j.get('error')}")
    except Exception as e:
        print(f"  WARN - error publicando a n8n: {e}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--desde", default="2026-01-01",
                    help="Fecha de inicio del seed (YYYY-MM-DD UTC). Default: 2026-01-01.")
    ap.add_argument("--salida", default=str(DEFAULT_OUT))
    ap.add_argument("--publish-only", action="store_true",
                    help="Re-publica el .json.gz.b64 ya existente sin re-fetchear.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Solo cuenta cuántas llamadas trae la primera página y sale.")
    ap.add_argument("--chunked", action="store_true",
                    help="Fetch chunked por mes (recomendado >5k calls). Evita el cap ~10k del endpoint.")
    args = ap.parse_args()
    env = load_env()
    out = Path(args.salida)
    out.parent.mkdir(parents=True, exist_ok=True)

    if args.publish_only:
        if not out.exists():
            print(f"no existe {out} - corre sin --publish-only primero", file=sys.stderr)
            return 3
        gz_b64 = out.read_text(encoding="utf-8").strip()
        count = int((out.parent / "aircall-seed.count.txt").read_text().strip())
        # republicar sin re-fetchear
        base = env.get("N8N_BASE_URL", "").rstrip("/") or (env.get("N8N_API_URL", "").rstrip("/")[:-len("/api/v1")])
        token = env["CS_SEED_TOKEN"]
        r = requests.post(base + "/webhook/aircall-seed",
                          json={"token": token, "gz": gz_b64, "count": count,
                                "generated_at": datetime.now(timezone.utc).isoformat()},
                          timeout=180)
        r.raise_for_status()
        print(r.json())
        return 0

    dt = datetime.strptime(args.desde, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    from_unix = int(dt.timestamp())
    print(f"== Aircall seed - desde {args.desde} (unix {from_unix}) ==")

    if args.dry_run:
        # solo 1 página, sin slim, sin publish
        base = env["AIRCALL_API_BASE_URL"].rstrip("/")
        auth = (env["AIRCALL_API_ID"], env["AIRCALL_API_TOKEN"])
        r = requests.get(f"{base}/calls", auth=auth, timeout=60,
                         params={"from": from_unix, "per_page": 50, "order": "asc"})
        r.raise_for_status()
        j = r.json()
        meta = j.get("meta") or {}
        print(f"  meta: count={meta.get('count')} total={meta.get('total')} "
              f"next={bool(meta.get('next_page_link'))}")
        print(f"  primera pag: {len(j.get('calls', []))} calls")
        return 0

    if args.chunked:
        to_unix = int(datetime.now(timezone.utc).timestamp())
        calls = fetch_calls_chunked(env, from_unix, to_unix)
    else:
        calls = fetch_calls(env, from_unix, label="full")
    slim = [slim_call(c) for c in calls]
    print(f"== slim done: {len(slim)} calls ==")

    blob = json.dumps({"calls": slim, "generated_at": datetime.now(timezone.utc).isoformat(),
                       "from_unix": from_unix, "count": len(slim)}, ensure_ascii=False)
    gz_b64 = base64.b64encode(gzip.compress(blob.encode("utf-8"), 9)).decode("ascii")
    out.write_text(gz_b64, encoding="utf-8")
    (out.parent / "aircall-seed.count.txt").write_text(str(len(slim)))
    print(f"== escrito {out} ({len(gz_b64)/1048576:.2f} MB gzip+base64) ==")

    publish_seed(env, blob, len(slim))
    return 0


if __name__ == "__main__":
    sys.exit(main())
