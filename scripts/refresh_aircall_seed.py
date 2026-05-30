#!/usr/bin/env python3
"""Reconstruye el seed Aircall _test desde Mongo (PanelCSCalls, con datos hasta hoy)
y lo publica a /webhook/aircall-seed-test. Shape = slim_call de carga_inicial_aircall.py.
Solo toca el seed _test (prod intacto; reversible con copy_seed_to_test.py)."""
import os, sys, json, gzip, base64, urllib.parse, urllib.request, ssl
from datetime import datetime, timezone
import pymongo

def to_unix(v):
    if v is None: return None
    if isinstance(v, (int, float)): return int(v)
    if isinstance(v, datetime):
        return int(v.replace(tzinfo=timezone.utc).timestamp()) if v.tzinfo is None else int(v.timestamp())
    if isinstance(v, str):
        try: return int(datetime.fromisoformat(v.replace('Z','+00:00')).timestamp())
        except Exception: return None
    return None

def slim(d):
    tags = []
    for t in (d.get("tags") or []):
        tags.append(t.get("name") if isinstance(t, dict) else t)
    return {
        "id": int(d["callId"]) if d.get("callId") is not None else None,
        "direction": d.get("direction"),
        "status": d.get("status"),
        "started_at": to_unix(d.get("startedAtUnix") if d.get("startedAtUnix") is not None else d.get("startedAt")),
        "answered_at": to_unix(d.get("answeredAtUnix") if d.get("answeredAtUnix") is not None else d.get("answeredAt")),
        "ended_at": to_unix(d.get("endedAtUnix") if d.get("endedAtUnix") is not None else d.get("endedAt")),
        "duration": d.get("duration"),
        "frt_sec": d.get("frtSec"),
        "missed_reason": d.get("missedReason"),
        "raw_digits": d.get("rawDigits"),
        "user_id": d.get("userId"),
        "user_name": d.get("userName"),
        "number_id": d.get("numberId"),
        "number_name": d.get("numberName"),
        "contact_id": d.get("contactId"),
        "contact_name": d.get("contactName"),
        "recording": d.get("recording"),
        "voicemail": d.get("voicemail"),
        "tags": tags,
        "archived": bool(d.get("archived", False)),
    }

def main():
    host=os.environ["MONGO_HOST2"]; user=os.environ["MONGO_USER2"]; pwd=urllib.parse.quote_plus(os.environ["MONGO_PASS2"])
    col=pymongo.MongoClient(f"mongodb+srv://{user}:{pwd}@{host}/?retryWrites=true&w=majority",serverSelectionTimeoutMS=20000)["automatizaciones"]["PanelCSCalls"]
    calls=[]
    proj={"callId":1,"direction":1,"status":1,"startedAtUnix":1,"startedAt":1,"answeredAtUnix":1,"answeredAt":1,
          "endedAtUnix":1,"endedAt":1,"duration":1,"frtSec":1,"missedReason":1,"rawDigits":1,"userId":1,"userName":1,
          "numberId":1,"numberName":1,"contactId":1,"contactName":1,"recording":1,"voicemail":1,"tags":1,"archived":1,"_id":0}
    for d in col.find({}, proj):
        s=slim(d)
        if s["id"] is None or s["started_at"] is None: continue
        calls.append(s)
    # sanity: rango de fechas
    sts=[c["started_at"] for c in calls]
    from datetime import timedelta
    TZ=timezone(timedelta(hours=-4))
    print(f"calls construidas: {len(calls)} | rango {datetime.fromtimestamp(min(sts),TZ):%Y-%m-%d} -> {datetime.fromtimestamp(max(sts),TZ):%Y-%m-%d}")
    # verificar keys coinciden con slim esperado
    print("keys:", sorted(calls[0].keys()))

    blob=json.dumps({"calls":calls,"generated_at":datetime.now(timezone.utc).isoformat(),
                     "meta":{"total_calls":len(calls),"fuente":"refresh_seed_test.py (Mongo)","build_version":"mongo-refresh-v1"}}, ensure_ascii=False)
    gz=base64.b64encode(gzip.compress(blob.encode("utf-8"),9)).decode("ascii")
    print(f"blob {len(blob)/1048576:.1f} MB → gz {len(gz)/1048576:.1f} MB")

    if "--dry-run" in sys.argv:
        print("DRY RUN — no publica."); return
    base=os.environ.get("N8N_BASE_URL","").rstrip("/")
    if not base:
        u=os.environ.get("N8N_API_URL","").rstrip("/"); base=u[:-len("/api/v1")] if u.endswith("/api/v1") else u
    token=os.environ["CS_SEED_TOKEN"]
    ep = "/webhook/aircall-seed" if "--prod" in sys.argv else "/webhook/aircall-seed-test"
    print("publicando a:", ep)
    ctx=ssl.create_default_context()
    try:
        import certifi; ctx.load_verify_locations(certifi.where())
    except Exception: pass
    req=urllib.request.Request(base+ep,
        data=json.dumps({"token":token,"gz":gz,"count":len(calls),"generated_at":datetime.now(timezone.utc).isoformat()}).encode(),
        headers={"Content-Type":"application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=180, context=ctx) as r:
        j=json.loads(r.read().decode())
    print("respuesta:", j.get("ok"), "count:", j.get("count"), j.get("error") or "")

if __name__=="__main__": main()
