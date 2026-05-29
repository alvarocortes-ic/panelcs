"""
add_unix_timestamps.py — Agrega campos *Unix (int seconds) a PanelCSTickets/PanelCSCalls
para usarlos como cursor de queries Mongo desde n8n.

Razón: el query Mongo del nodo n8n MongoDB no interpreta Extended JSON {$date}.
Comparar int-vs-int (Unix seconds) es portable y confiable.

Campos agregados:
  PanelCSTickets:
    updatedAtUnix  (int)  — usado para deltas / cursor
    createdAtUnix  (int)
  PanelCSCalls:
    startedAtUnix  (int)
    answeredAtUnix (int)

Idempotente: usa $set con bulkWrite.

Uso:
    set -a; source .env.credentials; set +a
    python outputs/cs-panel/scripts/add_unix_timestamps.py [--dry-run]
"""
import os
import sys
import time
import urllib.parse
from datetime import datetime, timezone

import pymongo
from pymongo import UpdateOne


def connect():
    uri = (
        f"mongodb+srv://{os.environ['MONGO_USER2']}:"
        f"{urllib.parse.quote_plus(os.environ['MONGO_PASS2'])}"
        f"@{os.environ['MONGO_HOST2']}/?retryWrites=true&w=majority"
    )
    client = pymongo.MongoClient(uri, serverSelectionTimeoutMS=10000)
    client.server_info()
    return client


def dt_to_unix(dt):
    if not dt:
        return None
    if isinstance(dt, datetime):
        if dt.tzinfo is None:
            return int(dt.replace(tzinfo=timezone.utc).timestamp())
        return int(dt.timestamp())
    return None


def main():
    dry = "--dry-run" in sys.argv
    client = connect()
    db = client["automatizaciones"]

    # ---- PanelCSTickets ----
    print("=== PanelCSTickets ===")
    col = db["PanelCSTickets"]
    total = col.estimated_document_count()
    print(f"  total docs: {total:,}")
    cursor = col.find(
        {},
        projection={"_id": 1, "createdAt": 1, "updatedAt": 1},
    )
    ops = []
    processed = 0
    t0 = time.time()
    for doc in cursor:
        u = dt_to_unix(doc.get("updatedAt"))
        c = dt_to_unix(doc.get("createdAt"))
        ops.append(UpdateOne(
            {"_id": doc["_id"]},
            {"$set": {"updatedAtUnix": u, "createdAtUnix": c}},
        ))
        if len(ops) >= 500:
            if not dry:
                col.bulk_write(ops, ordered=False)
            processed += len(ops)
            ops = []
            if processed % 5000 == 0:
                print(f"  {processed:,}/{total:,} en {time.time()-t0:.1f}s")
    if ops:
        if not dry:
            col.bulk_write(ops, ordered=False)
        processed += len(ops)
    print(f"  PanelCSTickets: {processed:,} docs actualizados en {time.time()-t0:.1f}s")

    # Crear índice si no existe
    if not dry:
        existing = {ix["name"] for ix in col.list_indexes()}
        if "by_updatedAtUnix" not in existing:
            col.create_index([("updatedAtUnix", -1)], name="by_updatedAtUnix", background=True)
            print("  índice by_updatedAtUnix creado")
        else:
            print("  índice by_updatedAtUnix ya existía")

    # ---- PanelCSCalls ----
    print()
    print("=== PanelCSCalls ===")
    col = db["PanelCSCalls"]
    total = col.estimated_document_count()
    print(f"  total docs: {total:,}")
    cursor = col.find(
        {},
        projection={"_id": 1, "startedAt": 1, "answeredAt": 1},
    )
    ops = []
    processed = 0
    t0 = time.time()
    for doc in cursor:
        s = dt_to_unix(doc.get("startedAt"))
        a = dt_to_unix(doc.get("answeredAt"))
        ops.append(UpdateOne(
            {"_id": doc["_id"]},
            {"$set": {"startedAtUnix": s, "answeredAtUnix": a}},
        ))
        if len(ops) >= 500:
            if not dry:
                col.bulk_write(ops, ordered=False)
            processed += len(ops)
            ops = []
    if ops:
        if not dry:
            col.bulk_write(ops, ordered=False)
        processed += len(ops)
    print(f"  PanelCSCalls: {processed:,} docs actualizados en {time.time()-t0:.1f}s")

    if not dry:
        existing = {ix["name"] for ix in col.list_indexes()}
        if "by_startedAtUnix" not in existing:
            col.create_index([("startedAtUnix", -1)], name="by_startedAtUnix", background=True)
            print("  índice by_startedAtUnix creado")
        else:
            print("  índice by_startedAtUnix ya existía")


if __name__ == "__main__":
    main()
