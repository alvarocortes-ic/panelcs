#!/usr/bin/env python3
"""
cs-build.py — lee raw cache, dedupa, aplica slim, publica a n8n.

Objetivo: re-shape del slim en 30s sin refetchear nada desde Zendesk/Aircall.

Pipeline:
  1. Lee raw/zendesk/tickets + sideloads + enrichment + ticket_events
  2. Dedup por id (último wins por updated_at o _fetched_iso)
  3. Aplica slim_ticket() / slim_call() — reutiliza la implementación existente
  4. Cruza enrichment para SLA real + frt + solved_at + reopens
  5. Cruza ticket_events para escalation_fields
  6. Filtra `relevante` (status != deleted; activo o en rango)
  7. Construye payload {meta, tickets, lookups}
  8. publish_seed() a n8n (cs-seed + aircall-seed)

Uso:
  set -a; source .env.credentials; set +a
  python scripts/cs-build.py [--source zendesk|aircall|all]
                                              [--desde 2026-01-01]
                                              [--no-publish]
                                              [--out <ruta>]

Opciones:
  --source      qué fuente buildear (default: all).
  --desde       rango mínimo para el filtro `relevante` (default 2026-01-01).
  --no-publish  no envía a n8n, solo deja el blob local.
  --out         ruta del seed local (default data/seed.js).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import carga_inicial as ci  # noqa: E402 — slim_ticket, escalation_fields, sla_breached, sla_active_breaches, publish_seed
import carga_inicial_aircall as ca  # noqa: E402 — slim_call, publish_seed (su versión)
from lib import raw_cache as rc  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]
RAW_ROOT = REPO_ROOT / "data" / "raw"
DEFAULT_OUT = REPO_ROOT / "data" / "seed.js"
AIRCALL_DEFAULT_OUT = REPO_ROOT / "data" / "aircall-seed.js"


def load_latest_tickets() -> dict[int, dict]:
    """Tickets crudos más recientes por id, desde raw/zendesk/tickets."""
    return rc.dedup_last(
        rc.iter_records(RAW_ROOT, "zendesk", "tickets"),
        key_fn=lambda r: r.get("id"),
        ts_fn=lambda r: r.get("updated_at") or "",
    )


def load_latest_enrichment() -> dict[int, dict]:
    """Enrichment más reciente por ticket_id, desde raw/zendesk/enrichment."""
    return rc.dedup_last(
        rc.iter_records(RAW_ROOT, "zendesk", "enrichment"),
        key_fn=lambda r: r.get("_id"),
        ts_fn=lambda r: r.get("_fetched_iso") or "",
    )


def load_latest_sideloads() -> dict:
    """Sideloads (users/groups/organizations) más recientes por id+kind.

    Normaliza el id a str porque el render JS consume las claves de
    groups_by_id / agents_by_id / orgs_by_id como strings (JSON keys son siempre
    strings). El raw guarda _id como int (lo que devuelve Zendesk) — sin esta
    normalización los lookups por str(t["group_id"]) quedan vacíos.
    """
    out: dict[str, dict[str, dict]] = {"users": {}, "groups": {}, "organizations": {}}
    for r in rc.iter_records(RAW_ROOT, "zendesk", "sideloads"):
        kind = r.get("_kind")
        rid = r.get("_id")
        if kind not in out or rid is None:
            continue
        rid = str(rid)  # normalizar a str para match con used_groups/used_orgs
        ts = r.get("_fetched_iso") or ""
        prev = out[kind].get(rid)
        if prev is None or (prev.get("_fetched_iso") or "") <= ts:
            out[kind][rid] = r
    return out


def load_ticket_events() -> dict[int, list[tuple]]:
    """Agrupa transitions por ticket_id como tuplas (ts, prev_group, new_group)
    para que `ci.escalation_fields` pueda consumirlas tal cual."""
    by_tid: dict[int, list[tuple]] = {}
    for r in rc.iter_records(RAW_ROOT, "zendesk", "ticket_events"):
        tid = r.get("_ticket_id")
        if tid is None:
            continue
        by_tid.setdefault(tid, []).append(
            (r.get("ts"), r.get("prev_group"), r.get("new_group"))
        )
    for tid in by_tid:
        by_tid[tid].sort(key=lambda x: x[0] or 0)
    return by_tid


def load_latest_calls() -> dict[int, dict]:
    """Calls crudas más recientes por id."""
    return rc.dedup_last(
        rc.iter_records(RAW_ROOT, "aircall", "calls"),
        key_fn=lambda r: r.get("id"),
        ts_fn=lambda r: r.get("ended_at") or r.get("answered_at") or r.get("started_at") or "",
    )


def build_zendesk(desde_iso: str, publish: bool, out_path: Path) -> dict:
    print("[build/zd] loading raw…")
    t0 = time.time()
    tickets_raw = load_latest_tickets()
    enrich = load_latest_enrichment()
    sideloads = load_latest_sideloads()
    events = load_ticket_events()
    print(f"[build/zd] raw cargado en {time.time()-t0:.1f}s — "
          f"tickets:{len(tickets_raw)} enrich:{len(enrich)} events:{len(events)} "
          f"users:{len(sideloads['users'])} groups:{len(sideloads['groups'])} orgs:{len(sideloads['organizations'])}")

    now_dt = datetime.now(timezone.utc).replace(microsecond=0)
    now_iso = now_dt.isoformat().replace("+00:00", "Z")

    # 1 — slim base desde tickets raw
    t1 = time.time()
    tickets: dict[int, dict] = {tid: ci.slim_ticket(t) for tid, t in tickets_raw.items()}
    print(f"[build/zd] slim base: {len(tickets)} en {time.time()-t1:.1f}s")

    # 2 — cruzar enrichment: solved_at, sla_breached, sla_active_breaches, frt, reopens
    sla_breach = 0
    for tid, e in enrich.items():
        if tid not in tickets:
            # ticket apareció solo en enrichment (raro pero posible)
            tk = e.get("ticket")
            if tk:
                tickets[tid] = ci.slim_ticket(tk)
        t = tickets.get(tid)
        if t is None:
            continue
        tk = e.get("ticket") or {}
        m = e.get("metric") or {}
        if tk.get("status") in ("solved", "closed"):
            sa = m.get("solved_at")
            t["solved_at"] = sa
            t["closed_at"] = tk.get("updated_at") if tk.get("status") == "closed" else None
            t["sla_breached"] = ci.sla_breached(tk, now_iso, sa) if sa else None
        else:
            breached = ci.sla_breached(tk, now_iso)
            t["sla_breached"] = breached
            t["sla_active_breaches"] = ci.sla_active_breaches(tk)
            if breached:
                sla_breach += 1
        t["frt_min"] = (m.get("reply_time_in_minutes") or {}).get("calendar")
        t["reopens"] = m.get("reopens")

    # 3 — escalation fields desde ticket_events
    for tid, transitions in events.items():
        if tid in tickets:
            tickets[tid].update(ci.escalation_fields(transitions, tickets[tid].get("group_id")))

    # 4 — Filtro `relevante` (igual al original)
    desde_dt = datetime.strptime(desde_iso, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    desde_full_iso = desde_dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")

    def relevante(t: dict) -> bool:
        if t.get("status") == "deleted":
            return False
        if t.get("status") in ci.ACTIVE_STATUSES:
            return True
        return (t.get("created_at") or "") >= desde_full_iso or (t.get("solved_at") or "") >= desde_full_iso

    antes = len(tickets)
    tickets = {tid: t for tid, t in tickets.items() if relevante(t)}
    print(f"[build/zd] depuración: {antes} → {len(tickets)} (relevantes)")

    # 5 — Lookups (solo los referenciados)
    tickets_list = list(tickets.values())
    used_groups = {str(t["group_id"]) for t in tickets_list if t.get("group_id")}
    used_orgs = {str(t["organization_id"]) for t in tickets_list if t.get("organization_id")}

    groups_by_id = {}
    for gid in used_groups:
        sl = sideloads["groups"].get(gid)
        if sl:
            groups_by_id[gid] = sl.get("name")

    orgs_by_id = {}
    for oid in used_orgs:
        sl = sideloads["organizations"].get(oid)
        if sl:
            orgs_by_id[oid] = sl.get("name")

    agents_by_id = {}
    for uid, u in sideloads["users"].items():
        if u.get("role") in ("agent", "admin"):
            agents_by_id[uid] = {
                "name": u.get("name"),
                "email": u.get("email"),
                "gid": u.get("default_group_id"),
                "role": u.get("role"),
                "active": u.get("active", True),
            }

    payload = {
        "meta": {
            "generated_at": now_iso,
            "rango_desde": desde_iso,
            "synced_until_unix": int(now_dt.timestamp()),
            "synced_until_iso": now_iso,
            "total_tickets": len(tickets_list),
            "fuente": "cs-build.py (raw/build incremental)",
            "build_version": "raw-build-v1",
        },
        "tickets": tickets_list,
        "groups_by_id": groups_by_id,
        "agents_by_id": agents_by_id,
        "orgs_by_id": orgs_by_id,
    }

    blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("window.__CS_SEED = " + blob + ";\n", encoding="utf-8")
    size_mb = out_path.stat().st_size / 1048576
    print(f"[build/zd] escrito {out_path} ({size_mb:.1f} MB)")

    if publish:
        env = ci.load_env()
        ci.publish_seed(env, blob, len(tickets_list))

    return {
        "tickets": len(tickets_list),
        "size_mb": round(size_mb, 2),
        "elapsed_sec": round(time.time() - t0, 1),
    }


def build_aircall(publish: bool, out_path: Path) -> dict:
    print("[build/ac] loading raw…")
    t0 = time.time()
    calls_raw = load_latest_calls()
    print(f"[build/ac] raw cargado: {len(calls_raw)} calls en {time.time()-t0:.1f}s")

    slim = [ca.slim_call(c) for c in calls_raw.values()]
    slim.sort(key=lambda x: x.get("started_at") or 0)

    now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    payload = {
        "meta": {
            "generated_at": now_iso,
            "total_calls": len(slim),
            "fuente": "cs-build.py (raw/build incremental)",
            "build_version": "raw-build-v1",
        },
        "calls": slim,
    }
    blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("window.__AC_SEED = " + blob + ";\n", encoding="utf-8")
    size_mb = out_path.stat().st_size / 1048576
    print(f"[build/ac] escrito {out_path} ({size_mb:.1f} MB)")

    if publish:
        env = ca.load_env()
        ca.publish_seed(env, blob, len(slim))

    return {
        "calls": len(slim),
        "size_mb": round(size_mb, 2),
        "elapsed_sec": round(time.time() - t0, 1),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Build slim desde raw cache y publica a n8n")
    ap.add_argument("--source", choices=["zendesk", "aircall", "all"], default="all")
    ap.add_argument("--desde", default="2026-01-01")
    ap.add_argument("--no-publish", action="store_true")
    ap.add_argument("--out", default=None, help="ruta del seed Zendesk (override)")
    ap.add_argument("--out-aircall", default=None, help="ruta del seed Aircall (override)")
    args = ap.parse_args()

    publish = not args.no_publish
    print(f"== cs-build.py source={args.source} publish={publish} ==")
    started = time.time()
    summary: dict = {}
    if args.source in ("zendesk", "all"):
        out = Path(args.out) if args.out else DEFAULT_OUT
        summary["zendesk"] = build_zendesk(args.desde, publish, out)
    if args.source in ("aircall", "all"):
        out = Path(args.out_aircall) if args.out_aircall else AIRCALL_DEFAULT_OUT
        summary["aircall"] = build_aircall(publish, out)

    elapsed = time.time() - started
    print(f"\nDONE en {elapsed:.1f}s")
    print(f"summary: {summary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
