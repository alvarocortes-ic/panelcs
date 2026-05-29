#!/usr/bin/env python3
"""
cs-fetch.py — fetch incremental Zendesk + Aircall al raw cache local.

Orquesta:
  - Zendesk: incremental tickets + active enrichment + ticket_events
  - Aircall: incremental calls

Mantiene cursor en state/cursor.json (versionado en git) para
que otra máquina pueda retomar sin refetchear desde 2026-01-01.

Uso:
  set -a; source .env.credentials; set +a
  python scripts/cs-fetch.py [--source zendesk|aircall|all]
                                              [--since 2026-01-01]
                                              [--solved-pass]
                                              [--stats]

Opciones:
  --source     qué fuente fetchear (default: all).
  --since      fecha base si no hay cursor (default: 2026-01-01).
  --solved-pass enriquecer también tickets cerrados que falten solved_at (más lento).
  --stats      no fetchea — solo imprime stats del raw.

Requiere en .env.credentials:
  Zendesk: ZENDESK_USER, ZENDESK_TOKEN, ZENDESK_BASE_URL, N8N_API_URL, N8N_API_KEY
  Aircall: AIRCALL_API_ID, AIRCALL_API_TOKEN, AIRCALL_API_BASE_URL
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from lib import cursor as cur  # noqa: E402
from lib import raw_cache as rc  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]
RAW_ROOT = REPO_ROOT / "data" / "raw"


def _validate_since_and_cursor(since: str, c: dict) -> None:
    """Hard guardrail — protege contra arrastrar tickets pre-`min_allowed_since`
    al raw cache. El panel CS se entrega a VPs y la integridad del rango temporal
    es crítica para la reputación del análisis.

    Falla con mensaje accionable si:
      - `--since` es anterior a `min_allowed_since` en cursor.json
      - el cursor tiene un timestamp ya guardado anterior a `min_allowed_since`
    """
    min_allowed = c.get("meta", {}).get("min_allowed_since", "2026-01-01")
    try:
        min_dt = datetime.strptime(min_allowed, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        min_unix = int(min_dt.timestamp())
        since_dt = datetime.strptime(since, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError as e:
        sys.exit(f"ERROR: fecha inválida (formato esperado YYYY-MM-DD). detalle: {e}")

    if since_dt < min_dt:
        sys.exit(
            f"ERROR: --since={since} es anterior a min_allowed_since={min_allowed}\n"
            f"  Si esto es intencional, edita state/cursor.json\n"
            f"  y bajá meta.min_allowed_since a la fecha deseada.\n"
            f"  Si NO es intencional (default 2026-01-01), revisa el comando."
        )

    zd_unix = c.get("zendesk", {}).get("tickets_synced_until_unix")
    if zd_unix and int(zd_unix) < min_unix:
        zd_iso = datetime.fromtimestamp(int(zd_unix), tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        sys.exit(
            f"ERROR: cursor zendesk.tickets_synced_until_unix={zd_unix} ({zd_iso}) "
            f"es anterior a min_allowed_since={min_allowed}\n"
            f"  Esto sugiere que el cursor fue editado a mano con un epoch incorrecto.\n"
            f"  Limpiá el cursor con:\n"
            f"    echo '{{\"zendesk\":{{}},\"aircall\":{{}},\"meta\":{{\"schema_version\":1,\"min_allowed_since\":\"{min_allowed}\"}}}}' > state/cursor.json\n"
            f"  Y limpiá el raw cache con:\n"
            f"    rm -rf data/raw/zendesk data/raw/aircall"
        )

    ac_unix = c.get("aircall", {}).get("calls_from_unix")
    if ac_unix and int(ac_unix) < min_unix:
        ac_iso = datetime.fromtimestamp(int(ac_unix), tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        sys.exit(
            f"ERROR: cursor aircall.calls_from_unix={ac_unix} ({ac_iso}) "
            f"es anterior a min_allowed_since={min_allowed}"
        )


def cmd_stats() -> int:
    print("== cs-fetch.py --stats ==")
    print(f"raw root: {RAW_ROOT}")
    for source, kinds in [
        ("zendesk", ["tickets", "enrichment", "ticket_events", "sideloads"]),
        ("aircall", ["calls"]),
    ]:
        for kind in kinds:
            s = rc.stats(RAW_ROOT, source, kind)
            mb = s["total_bytes"] / 1048576
            print(f"  {source}/{kind:15s} → {s['total_records']:>7} records, {mb:.2f} MB, {len(s['months'])} meses {s['months']}")

    c = cur.load(REPO_ROOT)
    print("\ncursor.json:")
    print(f"  zendesk: tickets_synced_until_unix={c['zendesk'].get('tickets_synced_until_unix')}")
    print(f"           ticket_events_start_time={c['zendesk'].get('ticket_events_start_time')}")
    print(f"           last_fetch_iso={c['zendesk'].get('last_fetch_iso')}")
    print(f"  aircall: calls_from_unix={c['aircall'].get('calls_from_unix')}")
    print(f"           last_fetch_iso={c['aircall'].get('last_fetch_iso')}")
    return 0


def cmd_fetch_zendesk(since_iso: str, solved_pass: bool) -> dict:
    """Cada paso guarda el cursor al terminar para que un fallo posterior no obligue
    a refetchear desde cero. Pasos pendientes pueden retomarse con un nuevo cs-fetch.
    """
    from lib import fetch_zendesk as fz  # import lazy — carga ci.py solo si lo necesita
    env = fz.ci.load_env()
    c = cur.load(REPO_ROOT)

    r_tk = fz.fetch_incremental_to_raw(env, RAW_ROOT, c, since_iso)
    cur.save(REPO_ROOT, c)
    print(f"[zd-fetch] cursor guardado tras tickets")

    r_ac = fz.fetch_active_enrichment_to_raw(env, RAW_ROOT, c)
    cur.save(REPO_ROOT, c)
    print(f"[zd-fetch] cursor guardado tras active_enrichment")

    r_ev = fz.fetch_ticket_events_to_raw(env, RAW_ROOT, c, since_iso)
    cur.save(REPO_ROOT, c)
    print(f"[zd-fetch] cursor guardado tras ticket_events")

    r_sv = {"solved_count": 0, "elapsed_sec": 0.0}
    if solved_pass:
        solved_ids = _find_missing_solved_ids(c)
        if solved_ids:
            r_sv = fz.fetch_solved_enrichment_to_raw(env, RAW_ROOT, c, solved_ids)
            cur.save(REPO_ROOT, c)
            print(f"[zd-fetch] cursor guardado tras solved_enrichment")

    return {"zendesk": {"tickets": r_tk, "active": r_ac, "events": r_ev, "solved": r_sv}}


def _find_missing_solved_ids(_c: dict) -> list[int]:
    """Lee enrichment raw + tickets raw, identifica IDs de tickets solved/closed
    cuyo enrichment más reciente no trae metric.solved_at. Devuelve esa lista.

    Lazy: solo se llama cuando --solved-pass está activo.
    """
    # tickets más recientes por id
    tickets_iter = rc.iter_records(RAW_ROOT, "zendesk", "tickets")
    tickets_latest = rc.dedup_last(
        tickets_iter,
        key_fn=lambda r: r.get("id"),
        ts_fn=lambda r: r.get("updated_at") or "",
    )
    # enrichment más reciente por id
    enr_iter = rc.iter_records(RAW_ROOT, "zendesk", "enrichment")
    enr_latest = rc.dedup_last(
        enr_iter,
        key_fn=lambda r: r.get("_id"),
        ts_fn=lambda r: r.get("_fetched_iso") or "",
    )
    missing = []
    for tid, t in tickets_latest.items():
        st = t.get("status")
        if st not in ("solved", "closed"):
            continue
        e = enr_latest.get(tid)
        if not e or not ((e.get("metric") or {}).get("solved_at")):
            missing.append(tid)
    return missing


def cmd_fetch_aircall(since_iso: str) -> dict:
    from lib import fetch_aircall as fa
    env = fa.ca.load_env()
    c = cur.load(REPO_ROOT)
    r = fa.fetch_calls_to_raw(env, RAW_ROOT, c, since_iso)
    cur.save(REPO_ROOT, c)
    return {"aircall": {"calls": r}}


def main() -> int:
    ap = argparse.ArgumentParser(description="Fetch incremental al raw cache del Panel CS")
    ap.add_argument("--source", choices=["zendesk", "aircall", "all"], default="all")
    ap.add_argument("--since", default="2026-01-01",
                    help="fecha base si no hay cursor (default 2026-01-01)")
    ap.add_argument("--solved-pass", action=argparse.BooleanOptionalAction, default=True,
                    help="enriquecer tickets cerrados que falten solved_at (default ON — "
                         "necesario para frt_min/solved_at/sla_breached históricos). "
                         "Usar --no-solved-pass para skipear cuando solo se quiere refrescar el queue activo.")
    ap.add_argument("--stats", action="store_true",
                    help="solo imprime stats del raw, no fetchea")
    args = ap.parse_args()

    if args.stats:
        return cmd_stats()

    # Guardrail anti-bug-epoch: validar ANTES de tocar nada.
    c_for_check = cur.load(REPO_ROOT)
    _validate_since_and_cursor(args.since, c_for_check)
    print(f"[guardrail] --since={args.since} ≥ min_allowed_since=" \
          f"{c_for_check.get('meta', {}).get('min_allowed_since', '2026-01-01')} OK")

    print(f"== cs-fetch.py source={args.source} since={args.since} solved_pass={args.solved_pass} ==")
    print(f"raw root: {RAW_ROOT}")

    started = time.time()
    summary: dict = {}
    if args.source in ("zendesk", "all"):
        summary.update(cmd_fetch_zendesk(args.since, args.solved_pass))
    if args.source in ("aircall", "all"):
        summary.update(cmd_fetch_aircall(args.since))

    elapsed = time.time() - started
    print(f"\nDONE en {elapsed:.1f}s")
    print(f"summary: {summary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
