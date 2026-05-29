"""
fetch_aircall.py — capa fina sobre carga_inicial_aircall.py para alimentar el raw.

Reusa fetch_calls / fetch_calls_chunked sin duplicar lógica.
"""

from __future__ import annotations

import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
import carga_inicial_aircall as ca  # noqa: E402

from lib import cursor as cur  # noqa: E402
from lib import raw_cache as rc  # noqa: E402

SOURCE = "aircall"


def _unix_to_month(unix_ts: int | None) -> str:
    if not unix_ts:
        return datetime.now(timezone.utc).strftime("%Y-%m")
    return datetime.fromtimestamp(unix_ts, tz=timezone.utc).strftime("%Y-%m")


def fetch_calls_to_raw(env: dict, raw_root: Path, cursor: dict, since_iso: str) -> dict:
    """Itera /v1/calls?from=<cursor> appendeando al raw.

    Estrategia:
    - Si hay `calls_from_unix` en cursor: fetch incremental (desde el último -1s).
    - Si no: fetch full chunked desde `since_iso` (~5 chunks calendario).

    El raw appendeado mantiene los call objects crudos. El build los slim.
    """
    now_unix = int(datetime.now(timezone.utc).timestamp())
    saved = cur.ac_get(cursor, "calls_from_unix")
    if saved:
        from_unix = int(saved) - 1  # overlap pequeño para no perder calls en límite
        to_unix = now_unix
        print(f"[ac-fetch] calls — incremental desde unix={from_unix} ({datetime.fromtimestamp(from_unix, timezone.utc).isoformat()})")
        t0 = time.time()
        calls = ca.fetch_calls(env, from_unix, to_unix=to_unix, label="delta")
    else:
        desde_dt = datetime.strptime(since_iso, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        from_unix = int(desde_dt.timestamp())
        to_unix = now_unix
        print(f"[ac-fetch] calls — full chunked desde {since_iso}")
        t0 = time.time()
        calls = ca.fetch_calls_chunked(env, from_unix, to_unix)

    counts = rc.append_records(
        raw_root, SOURCE, "calls", calls,
        partition_by=lambda r: _unix_to_month(r.get("started_at")),
    )
    elapsed = time.time() - t0
    print(f"[ac-fetch] calls appendeadas: {sum(counts.values())} en {elapsed:.1f}s — particiones: {counts}")

    cur.ac_set(cursor, "calls_from_unix", now_unix)
    cur.ac_set(cursor, "calls_synced_until_iso",
               datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"))
    cur.stamp_fetch(cursor, "aircall")
    return {"calls_count": len(calls), "elapsed_sec": round(elapsed, 1)}
