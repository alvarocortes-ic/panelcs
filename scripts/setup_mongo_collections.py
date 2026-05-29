"""
setup_mongo_collections.py — Crea colecciones + índices del Panel CS en Mongo Atlas devqa.

Idempotente: si la colección ya existe, NO la borra ni la recrea — solo asegura que los
índices declarados estén presentes (createIndexes es idempotente por nombre).

Colecciones creadas:
  - PanelCSTickets : source of truth de tickets Zendesk (~38k docs)
  - PanelCSCalls   : source of truth de calls Aircall (~18k docs)
  - PanelCSMeta    : metadata sistema (cursors, last_sync, schema_version)

Plan completo en outputs/cs-panel/PLAN-MIGRACION-MONGO.md.

Uso:
    set -a; source .env.credentials; set +a
    python outputs/cs-panel/scripts/setup_mongo_collections.py [--dry-run]

--dry-run: imprime lo que haría sin tocar Mongo.

Requiere en .env.credentials: MONGO_HOST2, MONGO_USER2, MONGO_PASS2
"""
import argparse
import os
import sys
import urllib.parse

try:
    import pymongo
    from pymongo import ASCENDING, DESCENDING
except ImportError:
    sys.exit("ERROR: pymongo no instalado. Ejecuta: python -m pip install pymongo")


DB_NAME = "automatizaciones"

# Schema declarativo de las colecciones + índices.
# Las colecciones se crean con $jsonSchema validator suave (warning, no error) para
# documentar el shape esperado sin romper escrituras si falta algún campo opcional.
COLLECTIONS = {
    "PanelCSTickets": {
        "description": "Source of truth de tickets Zendesk del Panel CS. Un doc por ticket.",
        "indexes": [
            {"name": "uniq_ticketId", "keys": [("ticketId", ASCENDING)], "unique": True},
            {"name": "by_updatedAt", "keys": [("updatedAt", DESCENDING)]},
            {"name": "by_org_createdAt", "keys": [("organizationId", ASCENDING), ("createdAt", DESCENDING)]},
            {"name": "by_status_sla", "keys": [("status", ASCENDING), ("slaBreached", ASCENDING)]},
            {"name": "by_assignee_status", "keys": [("assigneeId", ASCENDING), ("status", ASCENDING)]},
        ],
        "validator": {
            "$jsonSchema": {
                "bsonType": "object",
                "required": ["ticketId"],
                "properties": {
                    "ticketId": {"bsonType": ["int", "long"], "description": "ID de Zendesk — requerido y único"},
                    "subject": {"bsonType": ["string", "null"]},
                    "status": {"enum": ["new", "open", "pending", "hold", "solved", "closed", None]},
                    "priority": {"enum": ["low", "normal", "high", "urgent", None]},
                    "createdAt": {"bsonType": ["date", "null"]},
                    "updatedAt": {"bsonType": ["date", "null"]},
                    "solvedAt": {"bsonType": ["date", "null"]},
                    "frtMin": {"bsonType": ["int", "long", "double", "null"]},
                    "organizationId": {"bsonType": ["string", "long", "int", "null"]},
                    "assigneeId": {"bsonType": ["string", "long", "int", "null"]},
                    "groupId": {"bsonType": ["string", "long", "int", "null"]},
                    "slaBreached": {"bsonType": ["bool", "null"]},
                    "tags": {"bsonType": ["array", "null"]},
                },
            }
        },
        "validation_level": "moderate",  # solo valida inserts, no updates parciales
        "validation_action": "warn",     # log pero permite escritura
    },
    "PanelCSCalls": {
        "description": "Source of truth de calls Aircall del Panel CS. Un doc por call.",
        "indexes": [
            {"name": "uniq_callId", "keys": [("callId", ASCENDING)], "unique": True},
            {"name": "by_startedAt", "keys": [("startedAt", DESCENDING)]},
            {"name": "by_user_startedAt", "keys": [("userId", ASCENDING), ("startedAt", DESCENDING)]},
            {"name": "by_direction_status", "keys": [("direction", ASCENDING), ("status", ASCENDING)]},
        ],
        "validator": {
            "$jsonSchema": {
                "bsonType": "object",
                "required": ["callId"],
                "properties": {
                    "callId": {"bsonType": ["int", "long"], "description": "ID de Aircall — requerido y único"},
                    "startedAt": {"bsonType": ["date", "null"]},
                    "endedAt": {"bsonType": ["date", "null"]},
                    "direction": {"enum": ["inbound", "outbound", None]},
                    "status": {"bsonType": ["string", "null"]},
                    "duration": {"bsonType": ["int", "long", "double", "null"]},
                    "userId": {"bsonType": ["string", "long", "int", "null"]},
                    "zendeskTicketId": {"bsonType": ["int", "long", "null"]},
                },
            }
        },
        "validation_level": "moderate",
        "validation_action": "warn",
    },
    "PanelCSMeta": {
        "description": "Metadata del sistema: cursors, last_sync, schema_version. Pocos docs.",
        "indexes": [
            {"name": "uniq_key", "keys": [("key", ASCENDING)], "unique": True},
        ],
        "validator": {
            "$jsonSchema": {
                "bsonType": "object",
                "required": ["key"],
                "properties": {
                    "key": {"bsonType": "string", "description": "Clave única del metadata item"},
                    "value": {},  # cualquier tipo
                    "updatedAt": {"bsonType": ["date", "null"]},
                    "notes": {"bsonType": ["string", "null"]},
                },
            }
        },
        "validation_level": "moderate",
        "validation_action": "warn",
    },
}


def connect():
    host = os.environ["MONGO_HOST2"]
    user = os.environ["MONGO_USER2"]
    pwd  = urllib.parse.quote_plus(os.environ["MONGO_PASS2"])
    uri = f"mongodb+srv://{user}:{pwd}@{host}/?retryWrites=true&w=majority"
    client = pymongo.MongoClient(uri, serverSelectionTimeoutMS=10000)
    client.server_info()  # forzar conexion
    return client


def ensure_collection(db, name: str, spec: dict, dry_run: bool) -> dict:
    """Crea la colección si no existe + asegura todos sus índices. Idempotente."""
    existing = name in db.list_collection_names()
    result = {"name": name, "created": False, "indexes_created": [], "indexes_existing": []}
    if not existing:
        if dry_run:
            print(f"  [DRY] crearia coleccion {name} con validator + {len(spec['indexes'])} indices")
        else:
            db.create_collection(
                name,
                validator=spec["validator"],
                validationLevel=spec["validation_level"],
                validationAction=spec["validation_action"],
            )
            result["created"] = True
            print(f"  CREADA coleccion {name}")
    else:
        print(f"  YA EXISTE coleccion {name} (no se recrea — solo aseguramos indices)")

    col = db[name]
    existing_idx_names = {ix["name"] for ix in col.list_indexes()}
    for ix in spec["indexes"]:
        if ix["name"] in existing_idx_names:
            result["indexes_existing"].append(ix["name"])
            print(f"    indice existente: {ix['name']}")
            continue
        if dry_run:
            print(f"    [DRY] crearia indice {ix['name']} keys={ix['keys']} unique={ix.get('unique', False)}")
            continue
        col.create_index(
            ix["keys"],
            name=ix["name"],
            unique=ix.get("unique", False),
            background=True,
        )
        result["indexes_created"].append(ix["name"])
        print(f"    CREADO indice {ix['name']} (unique={ix.get('unique', False)})")
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    print(f"=== Mongo Atlas devqa — BD: {DB_NAME} ===")
    client = connect()
    db = client[DB_NAME]
    print(f"  conectado. colecciones actuales: {len(db.list_collection_names())}")
    print()

    results = []
    for name, spec in COLLECTIONS.items():
        print(f"--- {name}: {spec['description']} ---")
        r = ensure_collection(db, name, spec, args.dry_run)
        results.append(r)
        print()

    print("=== Resumen ===")
    for r in results:
        flag = "CREADA" if r["created"] else "existente"
        n_new = len(r["indexes_created"])
        n_old = len(r["indexes_existing"])
        print(f"  {r['name']:<22} {flag} | indices: {n_new} nuevos, {n_old} ya existian")

    if args.dry_run:
        print("\n(DRY-RUN: nada se ejecutó en Mongo)")


if __name__ == "__main__":
    main()
