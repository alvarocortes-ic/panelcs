"""
fetch_zendesk.py — capa fina sobre carga_inicial.py para alimentar el raw cache.

Reutiliza las funciones de fetch del script monolítico sin duplicar lógica.
El raw que persiste captura los tickets crudos (no slim) para permitir re-shape
del slim sin refetchear desde Zendesk.
"""

from __future__ import annotations

import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# importar funciones del script monolítico existente sin modificarlo
SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
import carga_inicial as ci  # noqa: E402

from lib import cursor as cur  # noqa: E402
from lib import raw_cache as rc  # noqa: E402

SOURCE = "zendesk"


def _iso_to_month(value) -> str:
    """Devuelve 'YYYY-MM' a partir de un timestamp ISO string O Unix seconds (int/float).
    Si el valor es inválido, usa now (UTC). Los `ticket_events` de Zendesk usan int seconds;
    el resto (tickets / enrichment / sideloads) usa ISO strings.
    """
    if isinstance(value, (int, float)) and value:
        try:
            return datetime.fromtimestamp(value, tz=timezone.utc).strftime("%Y-%m")
        except (OSError, ValueError, OverflowError):
            pass
    if isinstance(value, str) and value:
        return value[:7]
    return datetime.now(timezone.utc).strftime("%Y-%m")


def fetch_incremental_to_raw(env: dict, raw_root: Path, cursor: dict, since_iso: str) -> dict:
    """Itera incremental tickets desde el cursor (o `since_iso` si no hay), appendea
    raw a `raw/zendesk/tickets/YYYY-MM.jsonl.gz`, devuelve resumen.

    El raw incluye además groups, organizations, users (vienen como sideloads).
    Esos sideloads se guardan en `raw/zendesk/sideloads/YYYY-MM.jsonl.gz` como
    snapshot del fetch (no son append puro — el build usa el más reciente).
    """
    saved_cursor = cur.zd_get(cursor, "tickets_cursor")
    saved_unix = cur.zd_get(cursor, "tickets_synced_until_unix")

    if saved_unix:
        start_time = int(saved_unix)
        mode = f"incremental desde cursor (unix={saved_unix})"
    else:
        desde_dt = datetime.strptime(since_iso, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        start_time = int(desde_dt.timestamp())
        mode = f"full desde {since_iso}"

    print(f"[zd-fetch] tickets — {mode}")
    t0 = time.time()
    data = ci.fetch_incremental(env, start_time)  # devuelve {tickets, users, groups, organizations}

    tickets = data.get("tickets") or []
    # Append tickets al raw, particionado por updated_at del ticket
    counts = rc.append_records(
        raw_root, SOURCE, "tickets", tickets,
        partition_by=lambda r: _iso_to_month(r.get("updated_at")),
    )
    print(f"[zd-fetch] tickets appendeados: {sum(counts.values())} (particiones: {counts})")

    # Sideloads — snapshot completo en el mes actual (el build usa el más reciente)
    now_month = datetime.now(timezone.utc).strftime("%Y-%m")
    sl_records = []
    for kind, items in (("users", data.get("users") or {}),
                         ("groups", data.get("groups") or {}),
                         ("organizations", data.get("organizations") or {})):
        for k, v in items.items():
            sl_records.append({"_kind": kind, "_id": k, "_fetched_iso": datetime.now(timezone.utc).isoformat(), **v})
    if sl_records:
        rc.append_records(
            raw_root, SOURCE, "sideloads", sl_records,
            partition_by=lambda r: now_month,
        )

    # Actualizar cursor (incremental Zendesk usa unix timestamp del último ticket)
    now_unix = int(datetime.now(timezone.utc).timestamp())
    cur.zd_set(cursor, "tickets_synced_until_unix", now_unix)
    cur.zd_set(cursor, "tickets_synced_until_iso",
               datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"))
    cur.stamp_fetch(cursor, "zendesk")

    elapsed = time.time() - t0
    return {
        "tickets_count": len(tickets),
        "sideloads_count": len(sl_records),
        "elapsed_sec": round(elapsed, 1),
    }


def fetch_active_enrichment_to_raw(env: dict, raw_root: Path, cursor: dict) -> dict:
    """Trae el queue activo (Search) + enrich show_many y appendea al raw.

    Crítico para tener SLA real y métricas frescas — el incremental tickets no
    incluye policy_metrics.
    """
    print("[zd-fetch] queue activo via Search…")
    t0 = time.time()
    active_ids = ci.fetch_active_ids(env)
    print(f"[zd-fetch] active queue: {len(active_ids)} ids")

    if not active_ids:
        return {"active_ids_count": 0, "enrichment_count": 0, "elapsed_sec": 0.0}

    enriched = ci.enrich_show_many(env, active_ids, "slas,metric_sets")
    records = []
    fetched_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    for tid, d in enriched.items():
        records.append({
            "_kind": "active_enrichment",
            "_id": tid,
            "_fetched_iso": fetched_iso,
            "ticket": d.get("ticket"),
            "metric": d.get("metric"),
        })
    counts = rc.append_records(
        raw_root, SOURCE, "enrichment", records,
        partition_by=lambda r: _iso_to_month(((r.get("ticket") or {}).get("updated_at")) or fetched_iso),
    )
    elapsed = time.time() - t0
    print(f"[zd-fetch] enrichment appendeados: {sum(counts.values())} en {elapsed:.1f}s")

    cur.zd_set(cursor, "active_enrichment_last_iso", fetched_iso)
    return {
        "active_ids_count": len(active_ids),
        "enrichment_count": len(records),
        "elapsed_sec": round(elapsed, 1),
    }


def fetch_solved_enrichment_to_raw(env: dict, raw_root: Path, cursor: dict, solved_ids: list[int]) -> dict:
    """Enriquece tickets cerrados para completar solved_at + sla histórico.
    `solved_ids` se calcula desde el raw existente (tickets con status solved/closed
    que no tienen `metric_set.solved_at` en su enrichment más reciente).
    """
    if not solved_ids:
        return {"solved_count": 0, "elapsed_sec": 0.0}
    print(f"[zd-fetch] enrich solved: {len(solved_ids)} ids")
    t0 = time.time()
    enriched = ci.enrich_show_many(env, solved_ids, "slas,metric_sets")
    records = []
    fetched_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    for tid, d in enriched.items():
        records.append({
            "_kind": "solved_enrichment",
            "_id": tid,
            "_fetched_iso": fetched_iso,
            "ticket": d.get("ticket"),
            "metric": d.get("metric"),
        })
    rc.append_records(
        raw_root, SOURCE, "enrichment", records,
        partition_by=lambda r: _iso_to_month(((r.get("ticket") or {}).get("updated_at")) or fetched_iso),
    )
    elapsed = time.time() - t0
    print(f"[zd-fetch] solved enrichment appendeados: {len(records)} en {elapsed:.1f}s")
    return {"solved_count": len(records), "elapsed_sec": round(elapsed, 1)}


def fetch_ticket_events_to_raw(env: dict, raw_root: Path, cursor: dict, since_iso: str) -> dict:
    """Itera incremental/ticket_events.json para escalamientos (C2). Append al raw."""
    saved = cur.zd_get(cursor, "ticket_events_start_time")
    if saved:
        start_time = int(saved)
        mode = f"desde cursor (unix={saved})"
    else:
        desde_dt = datetime.strptime(since_iso, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        start_time = int(desde_dt.timestamp())
        mode = f"full desde {since_iso}"

    print(f"[zd-fetch] ticket_events — {mode}")
    t0 = time.time()
    transitions = ci.fetch_ticket_events(env, start_time)
    # transitions: dict {ticket_id: [(ts, prev_group, new_group), ...]} — tuplas
    records = []
    for tid, trans in transitions.items():
        for ts, prev, new in trans:
            records.append({
                "_ticket_id": tid,
                "ts": ts,
                "prev_group": prev,
                "new_group": new,
            })
    counts = rc.append_records(
        raw_root, SOURCE, "ticket_events", records,
        partition_by=lambda r: _iso_to_month(r.get("ts")),
    )
    elapsed = time.time() - t0
    print(f"[zd-fetch] ticket_events appendeados: {sum(counts.values())} en {elapsed:.1f}s")

    cur.zd_set(cursor, "ticket_events_start_time", int(datetime.now(timezone.utc).timestamp()))
    return {"events_count": len(records), "elapsed_sec": round(elapsed, 1)}
