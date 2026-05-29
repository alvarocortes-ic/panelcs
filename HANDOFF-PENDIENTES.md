# Handoff Panel CS — pendientes B / D / A (retomar directo)

> SES-20260528-2114 (Mac). Documento para retomar SIN re-investigar. Todo lo de hoy
> está commiteado. Orden de retoma: **B → D → A**. A (port a prod) va al FINAL.

> [!success] Verificado en SES-20260529-0659 (Mac) — correcciones al handoff
> Sesión corta de verificación pre-arranque de B. Datos confirmados contra fuente viva
> (n8n MCP + Mongo Atlas). Cierre por reinicio de equipo (Bash tuvo cwd atascado por un
> `cd` — **lección: SIEMPRE rutas absolutas, nunca `cd` en Bash del harness**).
>
> **Correcciones a aplicar al leer este doc:**
> 1. **IDs CS Export CONFIRMADOS**: prod `VDRQnxqBumKPfiyC` | test `I2BNaChz4jp9ZwY1` (los del inventario están bien).
> 2. **Colecciones Mongo (BD `automatizaciones`, cluster 2)** — existen DOS familias en la MISMA BD:
>    - Prod: `PanelCSTickets` (39.108) · `PanelCSCalls` (17.955) · `PanelCSMeta` (5 docs)
>    - Test: `PanelCSTickets_test` (39.108) · `PanelCSCalls_test` (17.955) · `PanelCSMeta_test` (5 docs)
>    - ⚠️ El workflow **_test** debe leer de las colecciones **`*_test`**. El prod de las sin sufijo.
> 3. **CORRECCIÓN MAYOR — el export ES JSONL, NO JSON**: el front (`cs-view.render.js` → `expExportar()`)
>    hace `fetch` al endpoint, `r.blob()` y descarga el archivo `.jsonl` con `<a download>`. **NO parsea el
>    contenido** — solo lo baja para que el usuario lo suba a Gemini/Claude. La spec (`WORKFLOW-CS-EXPORT.md`)
>    confirma `application/x-ndjson`. → **B NO cambia el formato (mantiene JSONL) y NO toca el front.** El objetivo
>    de B es solo: (a) cumplir el ENRIQUECIMIENTO de la spec, (b) leer tickets de Mongo en vez de Zendesk Search.
>    (El resumen de cierre anterior decía "el panel espera JSON desde Mongo" — eso era FALSO.)
> 4. **Token hardcoded CONFIRMADO** en el `jsCode` del nodo `Process Export` (ver abajo) → D real.
> 5. **Shape de `PanelCSTickets_test` CONFIRMADO** (verificado vivo — ya NO hay query pendiente). Campos por doc:
>    `_id, ticketId, _seedGeneratedAt, _syncSource, _syncedAt, aircallCallId, assigneeId, canalNormalizado, categoria,`
>    `chatSubtype, closedAt, createdAt, csat, devol, escMo, escSn2, frtMin, groupId, lineaNegocio, merged, nivel,`
>    `organizationId, pasoSn1, priority, producto, reopens, seguimiento, slaActiveBreaches, slaBreached, solvedAt,`
>    `status, subject, subproducto, type, updatedAt, viaChannel, createdAtUnix, updatedAtUnix`.
>    - ✅ **YA en Mongo** (mapeo directo a la spec): métricas `frtMin/reopens/slaBreached/csat/slaActiveBreaches`;
>      categorización `categoria/producto/subproducto/lineaNegocio/canalNormalizado`; escalamientos `pasoSn1/escSn2/escMo/devol`
>      (+ `nivel`, `seguimiento`); IDs `assigneeId/groupId/organizationId`; fechas `createdAt/updatedAt/solvedAt/closedAt`
>      + `createdAtUnix/updatedAtUnix` (filtrar por rango con estos). `csat` viene como string Zendesk (ej. `"unoffered"`).
>    - ❌ **NO está en Mongo** (resolver aparte): **nombres** de agent/group/org (solo IDs); `description`; `comments[]`;
>      `requesterId/submitterId`; `comments[].author{name,role}`.
> 6. **`PanelCSMeta_test` (5 docs) CONFIRMADO** = solo sync/cursores: `lastFullSync, lastFullSyncCalls, csDataCursor,`
>    `csDataEventsCursor, aircallDataCursor`. **NO hay lookups de nombres** → BRECHA 2 sigue sin Mongo. Los nombres
>    salen del **seed `cs-seed`** (gz con `agents_by_id/groups_by_id/orgs_by_id`) — el front ya los usa (`OR[orgId]`, etc.).
> 7. **Decisión de diseño de B (lookups de nombres) — recomendada**: en el workflow de export, **traer el seed `cs-seed`**
>    (1 fetch al webhook, ya devuelve gz con los 3 lookups id→nombre) y resolver agent/group/org localmente. Evita N
>    requests a Zendesk. Para `comments[]` + `description` + `author{name,role}`: SIGUEN viniendo de Zendesk (no están en
>    Mongo) — mantener el fetch de comments en batches, vía el nodo httpRequest con credencial (eso resuelve D a la vez).
> 8. ⚠️ **El render apunta a `/cs-export` PROD** (`WH_BASE='https://prod-low-code.iconstruye.dev/webhook'`, `/cs-export-test`=0
>    ocurrencias en `cs-view.render.js`). Para probar B en _test: o se ajusta el path del render deployado a CS View _test
>    a `/cs-export-test`, o se prueba el endpoint `/cs-export-test` directo por curl/navegador sin pasar por el front.
>
> **`jsCode` actual del nodo `Process Export` (lo que hace HOY, para reescribir en B+D)**:
> - `ZD_BASE="https://iconstruye.zendesk.com"`, `ZD_AUTH_USER="paulina.nazar@iconstruye.com/token"`, `ZD_AUTH_PASS="Ksm6joGT49ztSVu2nbpHtF33yDO5feIXqDjFJvlC"` ← **token en texto plano (D)**.
> - Valida `org/from/to` + rango ≤93d → `bail(400,...)`.
> - Search Zendesk paginado (max 10 págs = 1000 tickets); si `count>1000` → error `too_many_tickets`.
> - Comments por ticket en batches de `CONCURRENCIA=10` vía `zd.call(this, .../comments.json)`.
> - Emite por ticket (CRUDO): `id, subject, description(≤4000), status, priority, type, created_at, updated_at, solved_at, via_channel, assignee_id, group_id, organization_id, requester_id, submitter_id, tags, custom_fields(cf{}), satisfaction_rating, comments[]`.
> - Primera línea del JSONL = `_meta` (org, from, to, count, generated_at, elapsed_ms, errors, schema_version:1).
> - Respond binary `application/x-ndjson`, filename `cs-export-<org>-<from>_<to>.jsonl`.
> - **Falta vs spec**: nombres agent/group/org, `frt_min/reopens/sla_breached/csat`, `category/product/subproduct/linea_negocio/canal_normalizado`, `escalamientos{}`, `comments[].author:{id,name,role}`.
>
> **Front `expExportar(orgId)`** (en `outputs/cs-panel/n8n/cs-view.render.js` ~L2551): construye
> `WH_BASE + '/cs-export?org=&from=&to=&t='`, AbortController 240s, `r.blob()` → `a.download='cs-export-<slug>-<from>_<to>.jsonl'`.
> ⚠️ **Verificar al retomar**: que el render **_test** apunte a `/cs-export-test` (no a `/cs-export` prod). Revisar `WH_BASE` y el path en el render deployado a CS View _test.

> [!success] B + D HECHOS y validados en `_test` (SES-20260529-0728, Mac)
> Workflow `CS Export _test` (`I2BNaChz4jp9ZwY1`) reescrito (12 nodos) y probado contra fuente viva. Implementación reproducible: `outputs/cs-panel/scripts/apply_cs_export_b.py --apply` (jsCode del diseño en `n8n/DESIGN-B-FINAL.json`; aplicado en `n8n/cs-export-b-built.json`). Snapshot rollback: `snapshots/20260529-073939-...-I2BNaChz4jp9ZwY1.json`.
>
> **Arquitectura final (Enfoque C híbrido, panel de diseño)** — DISTINTA al plan original (que era seed):
> - Tickets + métricas enriquecidas ← **Mongo** `PanelCSTickets_test` (find `{organizationId, createdAtUnix:{$gte,$lte}}`, sin límite 1000).
> - tags + description + nombres (agent/group/org) + **rut** ← **Zendesk `show_many`** (`include=users,groups,organizations`, batches de 100, ~3 reqs). **El SEED se DESCARTÓ**: descomprimir su gz necesita `zlib`, NO disponible en el Code node de n8n (solo crypto/Buffer/URL). `show_many` además trae tags/description/rut que el seed no tenía.
> - comments + author{id,name,role} (incl. end-users) ← **Zendesk `/tickets/{id}/comments.json?include=users`**.
> - **D resuelto**: `show_many` + comments por nodos httpRequest con credencial `Zendesk Prod` (`68yjtB8sha7fDhHj`). **Cero token en texto plano** (verificado en el workflow vivo: 0 ocurrencias de paulina/token/ZD_AUTH/password). Mongo con credencial `lkBqIrVu74bzJva2`.
> - **rut**: clave `organization_fields.rut` (confirmada vía Zendesk API, NO inferida). ICONSTRUYE = `77155175-0`.
> - Validación de params + rama de error → `Respond Error` JSONL binary (HTTP 200, `_meta.ok:false`), para no romper el front que hace `blob()` incondicional.
> - cap `MAX_TICKETS=800` defensivo.
>
> **Validación empírica** (`GET /cs-export-test`):
> - Rango 30d (284 tickets): **20.6s**, spec 100% (agent/group/org name + rut + tags + description + comments 284/284; 815 comments, autores agent/end-user/admin, 0 sin nombre). Perf ~14 tickets/s → cap 800 ≈ 58s, muy holgado vs timeout 300s.
> - Errores 400 (`missing_params`, `range_too_wide`) → `.jsonl` 1 línea `_meta.ok:false`.
> - Empty → `_meta count:0` (tarda ~15s por reintentos del `show_many` con ids vacío; **mejora opcional**: `IF hasTickets` antes de `Comments`).
>
> ⚠️ **El render `_test` apunta a `/cs-export` (prod), no `/cs-export-test`** — B se probó por curl directo al endpoint. Para probar B desde el front `_test` habría que apuntar el render a `/cs-export-test`.

## TL;DR del estado

- **6 fixes UI + fix Aircall** → YA aplicados y validados en el **entorno `_test`**. Faltan portar a prod (eso es **A**, al final).
- **B** (migrar CS Export a Mongo) y **D** (token Zendesk → credencial) → ✅ **HECHOS** en `_test` Y **EN PROD** (`apply_cs_export_b.py --prod --apply`, `/cs-export` probado OK, D cero token).
- **A (port a prod) → ✅ HECHO** (SES-20260529-0728, GO de Alvaro): render a prod + fix/cursor Aircall + B+D a CS Export prod. Snapshots `snapshots/20260529-083335-PREA-*`.
- **🐞 Bugfix IndexedDB** (prod): cascarón hacía downgrade v2→v1 → `VersionError`. Fix `openDB()` sin versión fija (validado `fake-indexeddb` 9/9). **Alvaro debe redistribuir `index.html`**.
- Pendiente: verificar backfill Aircall (Schedule cada 5 min) + comentarios de Alvaro sobre el panel.
- Probar visualmente: abrir `outputs/cs-panel/index-test.html` (entorno `_test`).

---

## Caveats técnicos (Mac) — para no tropezar de nuevo

| Tema | Regla |
|---|---|
| SSL en Mac (pymongo, urllib, requests → Mongo/n8n/Zendesk) | `export SSL_CERT_FILE="$(outputs/cs-panel/.venv/bin/python -c 'import certifi;print(certifi.where())')"` antes de correr scripts. Sin esto: `CERTIFICATE_VERIFY_FAILED`. |
| Venv del panel | `outputs/cs-panel/.venv` (tiene pymongo[srv]+certifi). Usar `outputs/cs-panel/.venv/bin/python`. |
| `ZENDESK_BASE_URL` | YA incluye `/api/v2` (NO duplicar). Auth: `-u "${ZENDESK_USER}/token:${ZENDESK_TOKEN}"`. Curl con coma en `include` → usar `--data-urlencode`. |
| Editar workflows n8n en Mac | Usar **MCP n8n** (`n8n_update_partial_workflow` con `updateNode`/`patchNodeField`), NO los scripts Python (SSL). Siempre `validateOnly:true` primero. |
| Mongo | `MONGO_CLUSTER=2 bash tools/dbmapping/scripts/mongo-query.sh automatizaciones '<js>'` (mongosh vía brew). Cluster 2 = devqa-mongodb-atlas, BD `automatizaciones`. |
| Toggle workflow activo | `/activate` y `/deactivate` REST funcionan (bug #21614 NO afecta workflows autocontenidos). Script: `pause_resume_schedule.py status|pause|resume`. |
| Validator MCP falso positivo | Marca "Query must be valid JSON" en nodos Mongo con `={{ JSON.stringify(...) }}` — es falso positivo SALVO que la expresión tenga `}}` pegadas (`]}}) }}`) que rompen el lexer → ahí SÍ es real. Para query Mongo estático usar JSON literal directo `{"key":{"$in":[...]}}` (sin `={{ }}`). |
| NO iterar en caliente sobre prod | Si un deploy a prod falla, ROLLBACK al snapshot, depurar en `_test`. (Lección del incidente que rompió el GET 7 min.) |

## Inventario de IDs (memorizar / no re-buscar)

**Workflows n8n** (prod | _test):
- CS View — `qOIldhWyoeGMUa2p` | `RE84Ce0KMNzpaoMs`
- CS Data v2 (Mongo) — `eOarJPeIeUPI45de` | `rnkWtHsAwtr2Bzhs`
- Aircall Data v2 (Mongo) — `HUE2XQ25uO5BuDw6` | `uwYQQwTlykVXZSLu`
- CS Seed — `SXt8GRp5zjKKNfh6` | `2zhpA5Yex8CoL4Hk`
- Aircall Seed — `dOwtLmTCONRJ48Ir` | `XZZfJO2G9yRHkZxQ`
- **CS Export — `VDRQnxqBumKPfiyC` | `I2BNaChz4jp9ZwY1`** (foco de B/D)

**Colecciones Mongo**: `PanelCSTickets`(_test) 39.108 · `PanelCSCalls`(_test) 17.955 · `PanelCSMeta`(_test) cursores.

**Endpoints webhook** (`${N8N_WEBHOOK_BASE}/...`): prod = `cs-view`,`cs-seed`,`cs-data`,`aircall-seed`,`aircall-data`,`cs-export`,`cs-dte-health`. test = mismos `+-test`. Sync triggers test (POST): `cs-data-v2-mongo-run-test`, `aircall-data-v2-mongo-run-test`.

**Credencial Zendesk n8n existente**: `Zendesk Prod` id `68yjtB8sha7fDhHj` (la usan CS Data v2 / show_many).

**Scripts** en `outputs/cs-panel/scripts/`: `deploy_cs_view.py [--test]`, `clone_to_test.py`, `pause_resume_schedule.py`, `copy_seed_to_test.py`. Y `outputs/cs-panel/clone_mongo_test.js`.

---

## B) Migrar CS Export a Mongo  (workflow `Process Export`, 1 nodo Code)

**Estado actual** (lo que hace HOY, mal):
- Webhook GET `/cs-export?org=&from=&to=` → nodo Code `Process Export` → Respond binary (JSONL).
- Pega DIRECTO a Zendesk: (1) `GET /api/v2/search.json?query=organization:{org} created>={from} created<={to}` (paginado, **máx 1000** tickets); (2) `GET /api/v2/tickets/{id}/comments.json` por ticket (batches de 10 concurrentes).
- Export real medido: 335 tickets, ~339 requests, ~23s.

**Problema 1 — NO cumple la spec** (`WORKFLOW-CS-EXPORT.md`). Entrega CRUDO; la spec pide ENRIQUECIDO:
| Spec pide | Hoy entrega | En Mongo `PanelCSTickets` (campo) |
|---|---|---|
| `agent:{id,name}` | `assignee_id` | `assigneeId` + lookup nombre |
| `group:{id,name}` | `group_id` | `groupId` + lookup nombre |
| `organization:{id,name,rut}` | `organization_id` | `organizationId` + lookup nombre |
| `frt_min`,`reopens`,`sla_breached`,`csat` | ausentes | `frtMin`,`reopens`,`slaBreached`,`csat` |
| `category`,`product`,`subproduct`,`linea_negocio`,`canal_normalizado` | `custom_fields` raw | `categoria`,`producto`,`subproducto`,`lineaNegocio`,`canalNormalizado` |
| `escalamientos:{paso_sn1,esc_sn2,esc_mo,devol}` | ausentes | `pasoSn1`,`escSn2`,`escMo`,`devol` |
| `comments[].author:{id,name,role}` | `author_id` | (comments NO están en Mongo) |

**Problema 2 — carga alta a Zendesk** (Search + N comments).

**Plan B (reescribir el nodo `Process Export`)**:
1. **Tickets**: en vez del Search a Zendesk → `find` en `PanelCSTickets` con `{ organizationId: org, createdAtUnix: {$gte: from, $lte: to} }` (campos `createdAtUnix`/`updatedAtUnix` ya existen). Elimina el Search Y el límite de 1000.
   - Mongo ya trae los campos enriquecidos → mapear a la estructura de la spec (snake_case con objetos `agent/group/organization`).
2. **Lookups de nombres** (agent/group/org → name): ⚠️ **NO están en `PanelCSMeta`** (la BRECHA 2 que poblaba lookups se REVIRTIÓ; ver más abajo). Opciones: (a) bajarlos del seed `cs-seed` (el blob trae `agents_by_id`/`groups_by_id`/`orgs_by_id`), o (b) resolver nombres con un find adicional, o (c) re-implementar BRECHA 2 bien (en `_test` con query Mongo literal, no `}}` pegadas) para tener lookups en `PanelCSMeta`. **Decisión pendiente.**
3. **Comments**: SIGUEN viniendo de Zendesk (`/tickets/{id}/comments.json`) — no están en Mongo. Mantener el fetch en batches. Resolver `author` a `{id,name,role}` requiere lookup de users (del seed o include).
4. **Nodo Mongo**: agregar un nodo `mongoDb find` (credencial `Mongo Atlas devqa - Panel CS` id `lkBqIrVu74bzJva2`) antes/dentro del flujo, o hacer el find vía `this.helpers` en el Code. Más limpio: nodo `Find Tickets Mongo` → Code que enriquece + fetch comments → Respond.
5. Probar en `CS Export _test` (`I2BNaChz4jp9ZwY1`, endpoint `/cs-export-test?org=&from=&to=`). Comparar el JSONL con la spec.

**Org de prueba**: `4849319836827` (= "iConstruye"), rango 2026-04-29..2026-05-29 → 335 tickets.

## D) Token Zendesk → credencial  (mismo nodo `Process Export`)

- El nodo Code tiene **hardcodeado** `ZD_AUTH_USER`/`ZD_AUTH_PASS` (token de `paulina.nazar@iconstruye.com`) en texto plano.
- Fix: usar la credencial n8n `Zendesk Prod` (`68yjtB8sha7fDhHj`). Pero es un **Code node** (no httpRequest), y `this.helpers.httpRequest` con `auth:{username,password}` manual. Para usar credencial desde Code node no es trivial.
- **Opción recomendada**: al reescribir B, separar el fetch de comments a un nodo `httpRequest` con `authentication: predefinedCredentialType / zendeskApi` (credencial `Zendesk Prod`), eliminando el token del Code. Así B y D se resuelven juntos.
- Si se mantiene el Code: mover el token a una variable de entorno/credencial accesible — menos limpio.

## A) Port a producción (AL FINAL, con GO del usuario + snapshots)

Aplicar TODO junto. Comandos exactos:

1. **Snapshot CS View prod**: `python outputs/cs-panel/scripts/snapshot_workflow.py "CS View - Presentacion del panel"`
2. **Deploy render a CS View prod** (6 fixes UI): `python outputs/cs-panel/scripts/deploy_cs_view.py panel-fixes-2026-05-29` (SIN `--test`). Verificar GET `/cs-view`: sin botón "Actualizar", "Imprimir PDF", endpoints PRODUCTIVOS (sin `-test`), timer auto-refresh.
3. **Fix paginación Aircall PROD** (mismo updateNode que se validó en test): al workflow `HUE2XQ25uO5BuDw6`, nodo `Aircall Calls`:
   `updates: {"parameters.options.pagination.pagination.paginationCompleteWhen":"other", "parameters.options.pagination.pagination.completeExpression":"={{ !$response.body || !$response.body.meta || !$response.body.meta.next_page_link }}"}`
4. **Retroceder cursor Aircall prod** para recuperar gap: `MONGO_CLUSTER=2 mongo-query.sh automatizaciones "db.PanelCSMeta.updateOne({key:'aircallDataCursor'},{\$set:{value: <epoch 26-may = 1779753600>}})"` (ajustar a la fecha del último dato bueno).
5. **CS Export prod** (`VDRQnxqBumKPfiyC`): aplicar la reescritura de B+D (ya validada en test).
6. **index.html (loader local)**: el usuario hace `git pull` y usa el nuevo `outputs/cs-panel/index.html` (auto-refresh vive en el render, pero el index nuevo agrega `syncAll` para que el auto-refresh también sincronice calls). Sin esto: degradación graceful (auto-refresh de tickets sí, calls solo al inicio).
7. Verificar cada paso; rollback al snapshot si algo falla.

## Cambios de HOY ya en `_test` (lista para A)

- **render.js** (`cs-view.render.js`, deploy a CS View _test): quitar "Actualizar" + exponer `window.__csSyncCalls`; auto-refresh 5min en el render (`window.__csAutoTimer`, dispara `CTX_ACTIONS.refresh`); "Exportar"→"Imprimir PDF"; `aircallRange()`+`callsInRange()` (Aircall filtra por tab, En vivo=hoy) + label de rango + mensaje "sin llamadas en rango"; click-fuera cierra multi-select Equipo (`window.__csMultiOutsideBound`); re-click tab "Paneles Extras" resetea `S.extraView`.
- **cs-view.styles.css**: grid `minmax(0,1fr)` (fix solapamiento) + media 1280px.
- **index.html**: `syncAll()` (tickets+calls), `doRefresh` usa syncAll, auto-refresh removido del loader (vive en render).
- **Aircall Data v2 _test**: fix paginación (updateNode, ver C).
- Todo verificado con `node --check` + deploy `--test` OK.

## Lecciones del proceso (para no repetir)

- El validator del MCP advirtió del bug de `}}` pegadas y lo descarté como falso positivo → rompí el GET prod. **Verificar advertencias del validator antes de descartarlas.**
- staticData (seeds) NO se clona al copiar workflows vía API → hay que re-publicar (`copy_seed_to_test.py`).
- El sync `_test` usa la MISMA credencial Zendesk/Aircall que prod → al dispararlo, **pausar el Schedule prod** (`pause_resume_schedule.py pause`) para no competir por cuota.
- Auto-refresh va en el RENDER (no en index.html) porque "el cascarón se entrega una sola vez".
