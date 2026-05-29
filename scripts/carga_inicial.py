"""
carga_inicial.py — Carga inicial de tickets Zendesk para el panel CS.

Genera el dataset seed que el cliente del panel importa a su IndexedDB local.

Dos fuentes combinadas para que el dataset sea correcto y completo:
  1. API Incremental (cursor) desde --desde (default 2026-01-01): todo el histórico
     del año — todo ticket creado o actualizado en el rango.
  2. Search API del queue activo (-status:solved -status:closed): garantiza que el
     queue activo esté completo, incluidos tickets abiertos desde antes del rango
     que el incremental no traería.

Enriquecimiento (datos reales, no proxy):
  - activos  → sla_breached real (policy_metrics.breach_at) + frt + reopens
  - cerrados → solved_at real (metric_set.solved_at)

synced_until = momento de la corrida → el cliente lo usa como ?since= para los deltas.

Uso:
  python outputs/cs-panel/scripts/carga_inicial.py [--desde 2026-01-01] [--salida <ruta>]

Requiere en .env.credentials (raíz del repo): ZENDESK_USER, ZENDESK_TOKEN, ZENDESK_BASE_URL
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
DEFAULT_OUT = REPO_ROOT / "outputs" / "cs-panel" / "data" / "seed.js"
ACTIVE_STATUSES = {"new", "open", "pending", "hold"}

# custom fields de Zendesk usados por el panel
NIVEL_FID = 4556868682267   # "Nivel" (Complejo / Simple)
SEG_FID = 4557078676251     # "Ticket en seguimiento"
LN_FID = 11490690310939     # "Línea de negocio"
SUBPROD_FID = 4746276837787 # "Subproducto (iConstruye)"
AIRCALL_CALL_FID = 16444628344091  # "Aircall Call ID" — cobertura ~40% reciente (Fase D)
# Categoría / Producto fragmentados por segmento — se consolida el 1er valor no vacío
CAT_FIDS = [4557429365019, 4572814010395, 4573134023067, 4573299675035,
            4573306776347, 4573320613787, 4573317518875]
PROD_FIDS = [4704444587547, 4613114080283, 4620916990747, 4621021765275,
             4632374902299, 4632877917083, 4672260597659]

# Grupos para clasificar escalamientos (C2 — ver MEJORAS.md § Fase C).
# SN1: Soporte Nivel 1 + B2B + CICFIN + PAP · SN2: Soporte Nivel 2
# MO: "Proyecto Producto y Tecnología" (Mantención Operativa).
SN1_GROUPS = {"4681557011739", "4681700491547", "4681682013083", "4681854804123"}
SN2_GROUP = "4681742537243"
MO_GROUP = "4681656062107"

# Mapping replicado del campo "Canal normalizado" del dataset Power BI 'tickets'
# (Fase D — incorporar módulos Chat (Wotnot) y Aircall al panel CS).
# Verificado contra el .pbix de iC el 2026-05-25 con 321.821 tickets:
#   api/Api -> Teléfono · chat/Chat -> Chat · email -> Correo · web -> Correo · whatsapp -> Whatsapp
NORMALIZE_CHANNEL = {
    "api": "Teléfono",
    "chat": "Chat",
    "email": "Correo",
    "web": "Correo",
    "whatsapp": "Whatsapp",
}


def _cf(t: dict, fid: int):
    """Valor de un custom field del ticket, por id."""
    for c in (t.get("custom_fields") or []):
        if c.get("id") == fid:
            return c.get("value")
    return None


def _cf_first(t: dict, fids: list):
    """Primer valor no vacío de una lista de custom fields (consolida segmentos)."""
    for f in fids:
        v = _cf(t, f)
        if v:
            return v
    return None


def load_env() -> dict:
    """Carga .env.credentials a un dict (sin imprimir valores)."""
    env: dict[str, str] = {}
    env_file = REPO_ROOT / ".env.credentials"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    missing = [k for k in ("ZENDESK_USER", "ZENDESK_TOKEN", "ZENDESK_BASE_URL") if not env.get(k)]
    if missing:
        print(f"faltan vars en .env.credentials: {missing}", file=sys.stderr)
        sys.exit(2)
    return env


def base_root(base_url: str) -> str:
    u = base_url.rstrip("/")
    return u[:-len("/api/v2")] if u.endswith("/api/v2") else u


def fetch_incremental(env: dict, start_time: int) -> dict:
    """Itera /api/v2/incremental/tickets/cursor.json hasta end_of_stream."""
    auth = (f"{env['ZENDESK_USER']}/token", env["ZENDESK_TOKEN"])
    root = base_root(env["ZENDESK_BASE_URL"])
    url = f"{root}/api/v2/incremental/tickets/cursor.json"

    all_tickets: list[dict] = []
    users_by_id: dict[int, dict] = {}
    groups_by_id: dict[int, dict] = {}
    orgs_by_id: dict[int, dict] = {}

    params = {"start_time": start_time, "include": "users,groups,organizations", "per_page": 1000}
    page = 0
    cursor = None
    started = time.time()

    while True:
        page += 1
        if cursor:
            params["cursor"] = cursor
        t0 = time.time()
        r = requests.get(url, auth=auth, params=params, timeout=120)
        if r.status_code == 429:
            retry = int(r.headers.get("Retry-After", "60"))
            print(f"  [pag {page}] rate limit, esperando {retry}s")
            time.sleep(retry)
            page -= 1
            continue
        r.raise_for_status()
        j = r.json()
        batch = j.get("tickets", [])
        all_tickets.extend(batch)
        for u in j.get("users", []):
            users_by_id[u["id"]] = u
        for g in j.get("groups", []):
            groups_by_id[g["id"]] = g
        for o in j.get("organizations", []):
            orgs_by_id[o["id"]] = o
        print(f"  [pag {page}] +{len(batch):>4} tickets · acum {len(all_tickets):>6} · {time.time()-t0:.1f}s")
        if j.get("end_of_stream"):
            break
        cursor = j.get("after_cursor")
        if not cursor:
            break
        params.pop("start_time", None)

    print(f"  total incremental: {len(all_tickets)} tickets en {time.time()-started:.1f}s ({page} págs)")
    return {
        "tickets": all_tickets,
        "users": users_by_id,
        "groups": groups_by_id,
        "organizations": orgs_by_id,
    }


def fetch_active_ids(env: dict) -> list[int]:
    """Search API: IDs de TODO el queue activo (new/open/pending/hold), sin importar antigüedad."""
    auth = (f"{env['ZENDESK_USER']}/token", env["ZENDESK_TOKEN"])
    root = base_root(env["ZENDESK_BASE_URL"])
    url = f"{root}/api/v2/search.json"
    ids: list[int] = []
    params = {"query": "type:ticket -status:solved -status:closed", "per_page": 100}
    page_url = url
    while page_url:
        r = requests.get(page_url, auth=auth, params=(params if page_url == url else None), timeout=60)
        r.raise_for_status()
        j = r.json()
        ids.extend(t["id"] for t in j.get("results", []))
        page_url = j.get("next_page")
        if page_url:
            time.sleep(0.3)
    return ids


def enrich_show_many(env: dict, ticket_ids: list[int], include: str) -> dict[int, dict]:
    """Llama /api/v2/tickets/show_many.json?include=... en batches de 100."""
    if not ticket_ids:
        return {}
    auth = (f"{env['ZENDESK_USER']}/token", env["ZENDESK_TOKEN"])
    root = base_root(env["ZENDESK_BASE_URL"])
    url = f"{root}/api/v2/tickets/show_many.json"
    out: dict[int, dict] = {}
    chunk = 100
    total = (len(ticket_ids) + chunk - 1) // chunk
    for i in range(0, len(ticket_ids), chunk):
        ids = ticket_ids[i:i + chunk]
        params = {"ids": ",".join(str(x) for x in ids), "include": include}
        t0 = time.time()
        r = requests.get(url, auth=auth, params=params, timeout=120)
        if r.status_code == 429:
            retry = int(r.headers.get("Retry-After", "60"))
            print(f"  [enrich {i//chunk+1}] rate limit, esperando {retry}s")
            time.sleep(retry)
            r = requests.get(url, auth=auth, params=params, timeout=120)
        r.raise_for_status()
        j = r.json()
        metric_by_tid = {m["ticket_id"]: m for m in (j.get("metric_sets") or []) if m.get("ticket_id")}
        for t in j.get("tickets", []):
            out[t["id"]] = {"ticket": t, "metric": metric_by_tid.get(t["id"], {})}
        print(f"  [enrich {i//chunk+1}/{total}] +{len(ids)} ({time.time()-t0:.1f}s)")
    return out


def _chat_subtype(via: dict, tags: list, via_channel: str) -> str | None:
    """Subtype de chat (Fase B) — categoriza el origen/tipo del chat.

    Análisis empírico sobre 3.641 chats del raw (2026-05-26):
      6%  offline             via.source.rel = chat_offline_message (no llegó a vivo)
      38% sodexo              tag chat_sodexo (cliente más grande)
      2%  sn1                 tag chat_soporte_nivel_1
      1%  portal_proveedores  tag chat_portal_proveedores
      53% general             resto (no tienen tag específico)
    Mutuamente excluyentes, evaluados en este orden.
    """
    if via_channel != "chat":
        return None
    rel = (via.get("source") or {}).get("rel")
    if rel == "chat_offline_message":
        return "offline"
    if "chat_sodexo" in tags:
        return "sodexo"
    if "chat_portal_proveedores" in tags:
        return "portal_proveedores"
    if "chat_soporte_nivel_1" in tags:
        return "sn1"
    return "general"


def slim_ticket(t: dict) -> dict:
    """Shape mínimo y estable que el panel consume."""
    via = t.get("via") or {}
    via_channel = (via.get("channel") or "").lower()
    tags = t.get("tags") or []
    return {
        "id": t["id"],
        "subject": t.get("subject") or "",
        "status": t.get("status"),
        "priority": t.get("priority"),
        "type": t.get("type"),
        "created_at": t.get("created_at"),
        "updated_at": t.get("updated_at"),
        "solved_at": None,        # ← enrich
        "closed_at": None,        # ← derivado
        "frt_min": None,          # ← enrich
        "reopens": None,          # ← enrich
        "group_id": t.get("group_id"),
        "assignee_id": t.get("assignee_id"),
        "organization_id": t.get("organization_id"),
        "sla_breached": None,            # ← enrich (booleano histórico — para cerrados estático contra solved_at)
        "sla_active_breaches": None,     # ← enrich (lista [{metric, breach_at}] de SLAs active vencidos — cliente re-evalúa en runtime)
        "nivel": (lambda v: str(v).lower() if v else None)(_cf(t, NIVEL_FID)),
        "seguimiento": bool(_cf(t, SEG_FID)),
        "merged": "closed_by_merge" in (t.get("tags") or []),
        "csat": (t.get("satisfaction_rating") or {}).get("score"),
        "linea_negocio": _cf(t, LN_FID),
        "categoria": _cf_first(t, CAT_FIDS),
        "producto": _cf_first(t, PROD_FIDS),
        "subproducto": _cf(t, SUBPROD_FID),
        "paso_sn1": False,        # ← enrich ticket_events (C2)
        "esc_sn2": False,         # ← enrich ticket_events (C2)
        "esc_mo": False,          # ← enrich ticket_events (C2)
        "devol": 0,               # ← enrich ticket_events (C2 — devoluciones SN2→SN1)
        # Fase D — clasificación por canal (módulos Chat + Aircall)
        "via_channel": via_channel or None,                                  # api / chat / email / web / whatsapp
        "canal_normalizado": NORMALIZE_CHANNEL.get(via_channel, "Otros"),    # Teléfono / Chat / Correo / Whatsapp / Otros
        # Fase B — subtipo de chat para drill (offline/sodexo/portal_proveedores/sn1/general)
        "chat_subtype": _chat_subtype(via, tags, via_channel),
        # Fase D — cross-link Aircall ↔ Zendesk. Solo poblado en ~40% de tickets con tag=aircall
        # (Zendesk no escribe el field en todos los flujos). Cuando está, permite saltar al call.
        "aircall_call_id": (lambda v: int(str(v).strip()) if v and str(v).strip().isdigit() else None)(_cf(t, AIRCALL_CALL_FID)),
    }


def sla_breached(ticket: dict, now_iso: str, solved_at: str = None) -> bool:
    pms = (ticket.get("slas") or {}).get("policy_metrics") or []
    if solved_at:
        # histórico: incumplido si algún SLA venció antes de resolverse el ticket
        return any(p.get("breach_at") and p["breach_at"] < solved_at for p in pms)
    return any(p.get("stage") == "active" and p.get("breach_at") and p["breach_at"] < now_iso for p in pms)


def sla_active_breaches(ticket: dict) -> list:
    """Lista de SLAs vivos con breach_at (active OR paused), para que el cliente evalúe
    en runtime contra now() en cada paint. Incluye paused porque Zendesk Explore los
    cuenta — el compromiso al cliente se vence aunque el ticket esté esperando respuesta.
    Independiza el panel del momento del enrichment.
    """
    pms = (ticket.get("slas") or {}).get("policy_metrics") or []
    return [
        {"metric": p.get("metric"), "stage": p.get("stage"), "breach_at": p["breach_at"]}
        for p in pms
        if p.get("stage") in ("active", "paused") and p.get("breach_at")
    ]


def fetch_ticket_events(env: dict, start_time: int) -> dict:
    """Itera /api/v2/incremental/ticket_events.json y extrae los cambios de grupo.

    Devuelve {ticket_id: [(timestamp, prev_group, new_group), ...]} — cada cambio de
    grupo es un child_event tipo Change con group_id (destino) + previous_value (origen).
    """
    auth = (f"{env['ZENDESK_USER']}/token", env["ZENDESK_TOKEN"])
    root = base_root(env["ZENDESK_BASE_URL"])
    url = f"{root}/api/v2/incremental/ticket_events.json"
    params = {"start_time": start_time}
    transitions: dict[int, list] = {}
    page = total_ev = 0
    started = time.time()

    while True:
        page += 1
        t0 = time.time()
        # Retry con backoff exponencial para timeouts / errores transitorios de red
        attempts = 0
        while True:
            try:
                r = requests.get(url, auth=auth, params=params, timeout=120)
                break
            except (requests.exceptions.ConnectTimeout,
                    requests.exceptions.ConnectionError,
                    requests.exceptions.ReadTimeout) as e:
                attempts += 1
                if attempts > 5:
                    raise
                wait = min(60, 5 * (2 ** (attempts - 1)))   # 5, 10, 20, 40, 60
                print(f"  [events pag {page}] timeout ({type(e).__name__}), retry {attempts}/5 en {wait}s")
                time.sleep(wait)
        if r.status_code == 429:
            retry = int(r.headers.get("Retry-After", "60"))
            print(f"  [events pag {page}] rate limit, esperando {retry}s")
            time.sleep(retry)
            page -= 1
            continue
        r.raise_for_status()
        j = r.json()
        evs = j.get("ticket_events", [])
        total_ev += len(evs)
        for e in evs:
            tid = e.get("ticket_id")
            ts = e.get("timestamp")
            for ce in (e.get("child_events") or []):
                if ce.get("event_type") == "Change" and "group_id" in ce:
                    prev, new = ce.get("previous_value"), ce.get("group_id")
                    transitions.setdefault(tid, []).append((
                        ts,
                        str(prev) if prev is not None else None,
                        str(new) if new is not None else None,
                    ))
        cambios = sum(len(v) for v in transitions.values())
        print(f"  [events pag {page}] +{len(evs):>4} ev · acum {total_ev:>7} · "
              f"cambios grupo {cambios:>5} · {time.time()-t0:.1f}s")
        if j.get("end_of_stream"):
            break
        nxt = j.get("next_page")
        if not nxt:
            break
        url, params = nxt, None        # next_page trae start_time/cursor en la URL

    print(f"  total ticket_events: {total_ev} · tickets con cambio de grupo: "
          f"{len(transitions)} · {time.time()-started:.1f}s")
    return transitions


def escalation_fields(transitions: list, current_group) -> dict:
    """Clasifica el historial de grupos de un ticket en paso_sn1 / esc_sn2 / esc_mo / devol.

    Reconstruye la secuencia de grupos a partir de las transiciones (origen del 1er
    cambio + destino de cada cambio) y la cierra con el grupo actual.
    """
    cg = str(current_group) if current_group is not None else None
    if transitions:
        trs = sorted(transitions, key=lambda x: x[0] or 0)
        seq = [trs[0][1]] + [t[2] for t in trs]
    else:
        seq = [cg]
    if cg and (not seq or seq[-1] != cg):
        seq.append(cg)
    seq = [g for g in seq if g]
    devol = sum(1 for i in range(len(seq) - 1)
                if seq[i] == SN2_GROUP and seq[i + 1] in SN1_GROUPS)
    return {
        "paso_sn1": any(g in SN1_GROUPS for g in seq),
        "esc_sn2": any(g == SN2_GROUP for g in seq),
        "esc_mo": any(g == MO_GROUP for g in seq),
        "devol": devol,
    }


def publish_seed(env: dict, blob: str, count: int) -> None:
    """Publica el dataset (gzip+base64) al workflow CS Seed de n8n.

    Así el cascarón index.html lo baja del webhook /cs-seed y no necesita el
    archivo data/seed.js local. Si faltan N8N_API_URL / CS_SEED_TOKEN, se omite.
    """
    n8n_url = env.get("N8N_API_URL", "")
    token = env.get("CS_SEED_TOKEN", "")
    if not n8n_url or not token:
        print("  (sin N8N_API_URL/CS_SEED_TOKEN — se omite la publicación a n8n)")
        return
    base = n8n_url.rstrip("/")
    if base.endswith("/api/v1"):
        base = base[:-len("/api/v1")]
    gz = base64.b64encode(gzip.compress(blob.encode("utf-8"), 9)).decode("ascii")
    print(f"  publicando seed a n8n… (gzip+base64 = {len(gz)/1048576:.1f} MB)")
    try:
        r = requests.post(base + "/webhook/cs-seed",
                          json={"token": token, "gz": gz, "count": count}, timeout=180)
        r.raise_for_status()
        j = r.json()
        if j.get("ok"):
            print(f"  ✅ seed publicado a n8n — count={j.get('count')}")
        else:
            print(f"  ⚠️  n8n rechazó la publicación: {j.get('error')}")
    except Exception as e:
        print(f"  ⚠️  error publicando a n8n: {e}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Carga inicial de tickets Zendesk 2026 para el panel CS")
    ap.add_argument("--desde", default="2026-01-01", help="fecha desde (YYYY-MM-DD, default 2026-01-01)")
    ap.add_argument("--salida", default=str(DEFAULT_OUT), help="ruta del JSON de salida")
    ap.add_argument("--publish-only", action="store_true",
                    help="no regenera: lee data/seed.js existente y solo lo publica a n8n")
    args = ap.parse_args()

    env = load_env()

    if args.publish_only:
        out_path = Path(args.salida)
        if not out_path.exists():
            print(f"no existe {out_path} — corre primero la generación", file=sys.stderr)
            return 2
        txt = out_path.read_text(encoding="utf-8")
        blob = txt[txt.index("=") + 1:].strip().rstrip(";").strip()
        payload = json.loads(blob)
        print("== carga_inicial.py --publish-only ==")
        publish_seed(env, blob, payload.get("meta", {}).get("total_tickets", 0))
        print("DONE (publish-only)")
        return 0
    desde_dt = datetime.strptime(args.desde, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    start_time = int(desde_dt.timestamp())
    now_dt = datetime.now(timezone.utc).replace(microsecond=0)
    now_iso = now_dt.isoformat().replace("+00:00", "Z")

    print("== carga_inicial.py ==")
    print(f"  desde: {args.desde} (start_time={start_time})")

    # 1 — Histórico del año vía API Incremental
    data = fetch_incremental(env, start_time)
    tickets = {t["id"]: slim_ticket(t) for t in data["tickets"]}
    print(f"  dataset tras incremental: {len(tickets)} tickets")

    # 2 — Queue activo completo vía Search (incluye activos viejos no traídos por el incremental)
    active_ids = fetch_active_ids(env)
    print(f"  queue activo real (Search): {len(active_ids)} tickets")

    # 3 — Enrich activos: trae ticket completo + SLA real + métricas; completa los faltantes
    sla_map = enrich_show_many(env, active_ids, "slas,metric_sets")
    agregados = sla_breach = 0
    for tid, d in sla_map.items():
        tk, m = d["ticket"], d["metric"]
        if tid not in tickets:
            tickets[tid] = slim_ticket(tk)
            agregados += 1
        breached = sla_breached(tk, now_iso)
        tickets[tid]["sla_breached"] = breached
        tickets[tid]["sla_active_breaches"] = sla_active_breaches(tk)
        tickets[tid]["frt_min"] = (m.get("reply_time_in_minutes") or {}).get("calendar")
        tickets[tid]["reopens"] = m.get("reopens")
        if breached:
            sla_breach += 1
    print(f"  activos: {len(active_ids)} · agregados (no estaban en {args.desde}+): {agregados} · fuera SLA: {sla_breach}")

    # 4 — Enrich cerrados: solved_at real
    cerrados = [tid for tid, t in tickets.items() if t["status"] in ("solved", "closed")]
    print(f"  enrich solved_at: {len(cerrados)} cerrados")
    solved_map = enrich_show_many(env, cerrados, "slas,metric_sets")
    for tid, d in solved_map.items():
        m, tk = d["metric"], d["ticket"]
        sa = m.get("solved_at")
        tickets[tid]["solved_at"] = sa
        tickets[tid]["closed_at"] = tk.get("updated_at") if tk.get("status") == "closed" else None
        tickets[tid]["frt_min"] = (m.get("reply_time_in_minutes") or {}).get("calendar")
        tickets[tid]["reopens"] = m.get("reopens")
        tickets[tid]["sla_breached"] = sla_breached(tk, now_iso, sa) if sa else None

    # 4.5 — Escalamientos: historial de grupos vía ticket_events (C2)
    print("  fetch ticket_events (escalamientos SN1/SN2/MO)…")
    transitions = fetch_ticket_events(env, start_time)
    for tid, t in tickets.items():
        t.update(escalation_fields(transitions.get(tid, []), t.get("group_id")))
    n_sn2 = sum(1 for t in tickets.values() if t["esc_sn2"])
    n_mo = sum(1 for t in tickets.values() if t["esc_mo"])
    n_dev = sum(t["devol"] for t in tickets.values())
    print(f"  escalamientos: {n_sn2} tickets tocaron SN2 · {n_mo} tocaron MO · "
          f"{n_dev} devoluciones SN2→SN1")

    # 5 — Depurar: solo lo relevante a 2026, sin deleted.
    # Mantener si: activo ahora · O creado en el rango · O resuelto en el rango
    # (un ticket viejo resuelto en 2026 cuenta como estadística del año).
    desde_iso = desde_dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")

    def relevante(t: dict) -> bool:
        if t["status"] == "deleted":
            return False
        if t["status"] in ACTIVE_STATUSES:
            return True
        return (t.get("created_at") or "") >= desde_iso or (t.get("solved_at") or "") >= desde_iso

    antes = len(tickets)
    tickets = {tid: t for tid, t in tickets.items() if relevante(t)}
    print(f"  depuración: {antes} → {len(tickets)} tickets ({antes - len(tickets)} descartados: deleted + cerrados pre-{args.desde})")

    # 6 — Lookups (solo los referenciados)
    tickets_list = list(tickets.values())
    used_groups = {t["group_id"] for t in tickets_list if t.get("group_id")}
    used_orgs = {t["organization_id"] for t in tickets_list if t.get("organization_id")}
    groups_by_id = {str(gid): data["groups"][gid]["name"] for gid in used_groups if gid in data["groups"]}
    orgs_by_id = {str(oid): data["organizations"][oid]["name"] for oid in used_orgs if oid in data["organizations"]}
    agents_by_id = {
        str(uid): {
            "name": u.get("name"), "email": u.get("email"),
            "gid": u.get("default_group_id"), "role": u.get("role"), "active": u.get("active", True),
        }
        for uid, u in data["users"].items() if u.get("role") in ("agent", "admin")
    }

    payload = {
        "meta": {
            "generated_at": now_iso,
            "rango_desde": args.desde,
            "synced_until_unix": int(now_dt.timestamp()),
            "synced_until_iso": now_iso,
            "total_tickets": len(tickets_list),
            "activos": len(active_ids),
            "fuente": "outputs/cs-panel/scripts/carga_inicial.py",
        },
        "tickets": tickets_list,
        "groups_by_id": groups_by_id,
        "agents_by_id": agents_by_id,
        "orgs_by_id": orgs_by_id,
    }

    out_path = Path(args.salida)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # Se escribe como .js (window.__CS_SEED) para que el cascarón lo cargue con
    # <script> desde file:// sin choque de CORS.
    blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    out_path.write_text("window.__CS_SEED = " + blob + ";\n", encoding="utf-8")
    size_mb = out_path.stat().st_size / 1048576
    print(f"\nescrito {out_path} ({size_mb:.1f} MB)")

    # publicar a n8n para que el cascarón lo baje por webhook (HTML único)
    publish_seed(env, blob, len(tickets_list))

    print(f"DONE | tickets:{len(tickets_list)} activos:{len(active_ids)} groups:{len(groups_by_id)} "
          f"agents:{len(agents_by_id)} orgs:{len(orgs_by_id)}")
    print(f"synced_until: {payload['meta']['synced_until_iso']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
