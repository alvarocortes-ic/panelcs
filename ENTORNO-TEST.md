# Entorno de test paralelo Panel CS (`_test`)

> Creado 2026-05-28 (SES-20260528-2114). Réplica completa y aislada del Panel CS para
> probar cambios sin tocar producción. Todo elemento lleva sufijo `_test`.

## Mongo (cluster 2 `devqa-mongodb-atlas`, BD `automatizaciones`)

| Productivo | Test | Copia |
|---|---|---|
| `PanelCSTickets` | `PanelCSTickets_test` | 39.108 docs |
| `PanelCSCalls` | `PanelCSCalls_test` | 17.955 docs |
| `PanelCSMeta` | `PanelCSMeta_test` | 5 docs (cursores) |

Re-copiar desde prod: `MONGO_CLUSTER=2 bash tools/dbmapping/scripts/mongo-query.sh automatizaciones -f outputs/cs-panel/clone_mongo_test.js`

## Workflows n8n `_test` (todos activos, sin Schedule, accionados a voluntad)

| Workflow | ID | Endpoint(s) |
|---|---|---|
| CS Seed - Dataset del panel _test | `2zhpA5Yex8CoL4Hk` | GET `/cs-seed-test` |
| Aircall Seed - Llamadas del panel CS _test | `XZZfJO2G9yRHkZxQ` | GET `/aircall-seed-test` |
| CS Data v2 (Mongo) _test | `rnkWtHsAwtr2Bzhs` | GET `/cs-data-test?since=` · **sync** POST `/cs-data-v2-mongo-run-test` |
| Aircall Data v2 (Mongo) _test | `uwYQQwTlykVXZSLu` | GET `/aircall-data-test?since=` · **sync** POST `/aircall-data-v2-mongo-run-test` |
| CS Export _test | `I2BNaChz4jp9ZwY1` | GET `/cs-export-test?org=` |
| CS View - Presentacion del panel _test | `RE84Ce0KMNzpaoMs` | GET `/cs-view-test` |

- **NO se clonó** `CS DTE Health` (decisión usuario): el HTML de `CS View _test` lo llama al endpoint **productivo** (`/cs-dte-health`), no a `-test`.
- El `Schedule Trigger` de los workflows Data fue reemplazado por un `Webhook Trigger` (`*-run-test`) → el sync se dispara con `POST`, no corre solo.
- Colecciones Mongo de los `_test` apuntan a las `_test`. Credencial Mongo: la misma (mismo cluster).

## Cómo accionar el sync de test

```bash
set -a; source .env.credentials; set +a
# (opcional) liberar cuota Zendesk pausando los Schedule productivos durante la prueba:
python outputs/cs-panel/scripts/pause_resume_schedule.py pause
curl -X POST "${N8N_WEBHOOK_BASE%/}/cs-data-v2-mongo-run-test"
python outputs/cs-panel/scripts/pause_resume_schedule.py resume
```

## Loader local (index.html)

El render (`CS View _test`) ya apunta a los endpoints `-test`. Para probar el **panel completo**
local apuntando a test, el `index.html` (loader, `file://`) debe usar `/cs-seed-test` y
`/cs-data-test` en vez de los productivos (ajuste del lado cliente).

## Scripts

- `outputs/cs-panel/scripts/clone_to_test.py` — clona los workflows del panel a `_test` (idempotente: salta los que ya existen; borra el `_test` para recrear). `--dry-run` para ver el plan.
- `outputs/cs-panel/scripts/pause_resume_schedule.py` — `status|pause|resume` de los Schedule productivos.
- `outputs/cs-panel/clone_mongo_test.js` — copia colecciones a `_test`.

## Estado verificado (2026-05-28)

- GET `/cs-data-test` → 200, 16 tickets (lee `PanelCSTickets_test`).
- POST `/cs-data-v2-mongo-run-test` → 200, 5.2s, cursor `_test` avanzó (flujo sync completo OK).
- GET `/cs-view-test` → 200, HTML cableado a `-test` (DTE Health → productivo).
