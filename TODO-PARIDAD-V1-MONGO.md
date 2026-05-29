# TODO — Paridad funcional 100% con Panel CS v1 (post-migración Mongo)

> Estado al **2026-05-28 22:00 chile** (cierre de SES-20260528-0844).
> El sistema **funciona** con sync incremental Zendesk + Aircall a Mongo cada 5 min.
> Lo que sigue son brechas de fidelidad respecto a v1 que no resolvimos en esta sesión.

## Estado actual del sistema

| Componente | Estado | Comentario |
|---|---|---|
| MongoDB Atlas devqa | ✅ poblado | `PanelCSTickets` 38.144 · `PanelCSCalls` 17.955 · `PanelCSMeta` con cursors |
| **CS Data v2** Schedule 5min | ✅ activo | Sync incremental Zendesk → upsert Mongo, validado |
| **Aircall Data v2** Schedule 5min | ✅ activo | Sync incremental Aircall → upsert Mongo, validado |
| Cliente del panel | ✅ funciona | Sin cambios en index.html; consume mismo `/cs-data` y `/aircall-data` |
| CS Seed v1 + Aircall Seed v1 | ✅ activos | Sirven seed gzip (no fueron culpables) |
| Bloating n8n Postgres | ✅ resuelto | `saveDataSuccessExecution: 'none'` en v2 + auto-cleanup 2 días devops |

---

## Brechas pendientes para paridad 100% con v1

### 🔴 BRECHA 1 — Enrich de tickets en cada sync (CRÍTICO para reliability)

**Problema**: el incremental crudo de Zendesk `/incremental/tickets/cursor.json` **NO trae** estos campos enrichados:

- `frt_min` (First Reply Time — viene en `metric_sets`, no en el ticket raw)
- `sla_breached` real (viene en `policy_metrics.breach_at` vs `now()`)
- `sla_active_breaches[]` (lista `[{metric, stage, breach_at}]` para evaluación live en cliente)
- `solved_at` real para tickets cerrados por merge/triggers
- `reopens` count

**Impacto en el panel hoy**: los tickets actualizados en los deltas tienen estos campos en `null`. El cliente del panel ve métricas degradadas para tickets recientes.

**Cómo lo resolvía v1**:
1. Después del incremental, hacer `GET /api/v2/tickets/show_many.json?ids=...&include=slas,metric_sets`
2. Por cada ticket: extraer `metric_sets[].reply_time_in_minutes.calendar` → `frt_min`
3. Calcular `sla_breached` evaluando `policy_metrics[].breach_at < now()`
4. Extraer `sla_active_breaches[]` desde `policy_metrics` filtrando `stage in (active, paused)`
5. `solved_at` real desde `metric_sets[].solved_at`
6. `reopens` desde `metric_sets[].reopens`

**Implementación propuesta**:

Agregar nodos al branch Schedule de **CS Data v2**, después de "Slim + Map":

```
... → Slim + Map camelCase
    → Code "Collect IDs" (junta ticketIds en chunks de 100)
    → HTTP Zendesk show_many (con include=slas,metric_sets, batch de 100)
    → Code "Enrich SLA+FRT" (computa frt_min, sla_breached, sla_active_breaches, solved_at)
    → Mongo Update PanelCSTickets ($set de los campos enriquecidos)
    → Upsert PanelCSTickets (igual que ahora)
```

**Estimación**: ~1 hora. Riesgo: que el batch de show_many con 100 tickets × N páginas exceda timeout en runs grandes.

---

### 🟠 BRECHA 2 — Lookups (groups_by_id, agents_by_id, orgs_by_id) en deltas

**Problema**: el response actual de `/cs-data?since=X` devuelve:
```json
{
  "tickets": [...],
  "groups_by_id": {},     // ← vacío
  "agents_by_id": {},     // ← vacío
  "orgs_by_id": {},       // ← vacío
  "synced_until_unix": ...
}
```

**Impacto**: cuando un ticket nuevo viene en delta con un `assignee_id` que el cliente no conoce, muestra "Agente {id}" en vez del nombre. Lo mismo con groups y orgs nuevas.

**Cómo lo hacía v1**: el incremental con `include=users,groups,organizations` traía esos lookups. v1 los pasaba al cliente.

**Implementación**:
1. En el branch GET de CS Data v2 (Code "Map to snake_case"), también extraer lookups de los docs Mongo. Pero **Mongo no tiene los lookups separados** — están implícitos en los IDs de los tickets.
2. Opción A: crear colecciones `PanelCSAgents`, `PanelCSGroups`, `PanelCSOrgs` en Mongo que se pueblan con el incremental + agregar nodos al Schedule que las actualicen.
3. Opción B (más simple): el cliente del panel ya tiene los lookups del seed inicial; solo necesita los NUEVOS agentes/groups/orgs que aparecieron post-seed. Hacer un endpoint `/cs-lookups?since=X` que devuelva solo nuevos. (Más cambios en cliente).
4. Opción C (más simple aún): en el Schedule de CS Data v2, después del incremental con `include=users,groups,organizations`, persistir esos lookups en `PanelCSMeta` con `key: 'lookupsUsers'`, etc. El branch GET los lee y los devuelve junto a los tickets.

**Estimación**: ~1 hora con Opción C.

---

### 🟠 BRECHA 3 — ticket_events / escalamientos (pasoSn1, escSn2, escMo, devol)

**Problema**: los 4 campos de escalamiento (`pasoSn1`, `escSn2`, `escMo`, `devol`) solo se calculan al correr `carga_inicial.py`. En los deltas no se actualizan.

**Impacto**: si un ticket escala SN1→SN2 después del seed, el panel sigue mostrándolo en SN1. Si vuelve a SN1 (devolución), no se incrementa el contador `devol`.

**Cómo lo hacía v1**: branch Schedule de cs-data tenía nodos "Cursor Eventos" → "Incremental Events" → "Merge Events" (ver `outputs/cs-panel/n8n/cs-data.merge-events.js`). Procesaba `ticket_events.json` y recomputaba escalamientos.

**Implementación propuesta** (Fase 3b):

Agregar al branch Schedule de CS Data v2 (después del Upsert):

```
Upsert PanelCSTickets
  → Code "Read Events Cursor" (lee csDataEventsCursor de PanelCSMeta)
  → HTTP Zendesk incremental/ticket_events.json (con paginación)
  → Code "Compute Escalations" (replica lógica de cs-data.merge-events.js):
      - Para cada ticket con events nuevos, append transitions a `transitionsHistory`
      - Recomputar pasoSn1/escSn2/escMo/devol desde transitionsHistory + groupId actual
  → Mongo bulk Update por ticketId
  → Mongo Update PanelCSMeta { key: 'csDataEventsCursor' }
```

**Reto técnico**: persistir `transitionsHistory` requiere agregar campo nuevo al schema de `PanelCSTickets`. Hay que decidir:
- Solo persistir cambios futuros (no histórico) — el seed inicial ya trae los valores correctos
- O backfill el `transitionsHistory` para tickets existentes (requiere fetchear events históricos masivos)

**Estimación**: 2-3 horas + cuidado con timeouts.

---

### 🟡 BRECHA 4 — Cliente del panel hoy lee deltas degradados

**Problema concreto en producción ahora**: cuando un usuario abre el panel y el cliente sincroniza deltas via `/cs-data?since=X`, los tickets nuevos llegan SIN frtMin/slaBreached/escalamientos. El cliente los mergea con `dbMergeMany` que **preserva campos que el delta no trae** (regla en `index.html` L117-130). Eso significa:

- Tickets que **ya estaban** en IndexedDB local: mantienen sus valores correctos del seed. ✓
- Tickets **nuevos** post-seed: llegan con campos null. Hasta que se aplique BRECHA 1, esos tickets se ven con métricas pobres.

**Mitigación temporal**: el cliente del panel hace `dbMergeMany` (no `dbPutMany`), así que el daño se limita a tickets totalmente nuevos. Para los que ya conoce, los datos del seed son válidos.

**Resolución definitiva**: aplicar BRECHA 1 (Enrich).

---

### 🟢 BRECHA 5 — Cleanup del backlog acumulado (one-shot)

**Estado**: el `csDataCursor` está en `1780002756` (~28-may 21:15 chile, hace ~1h al cierre de la sesión). Eso es porque lo adelanté manualmente durante debug.

**Pero v1 estuvo inactivo desde el incidente del 27-may madrugada hasta ahora (~36h sin sync)**. Hay tickets actualizados durante ese gap que el Schedule v2 NO traerá (porque el cursor saltó al adelantarlo).

**Cómo cerrar el gap** (elegir uno):

- **Opción A (limpia)**: correr `python outputs/cs-panel/scripts/populate_mongo_from_seed.py` ahora que el seed v1 está actualizado. Eso bulk-upserta los 38k tickets actuales (el seed se refresca con `carga_inicial.py` que hace incremental completo + enrich).
- **Opción B (relajar cursor)**: bajar `csDataCursor` a `now - 48h` en `PanelCSMeta` y dejar que el Schedule procese 5-10 batches grandes hasta cerrar el gap. Riesgo: timeout en runs grandes.

**Recomendado**: Opción A. Si se va a aplicar BRECHA 1 (enrich), eso también re-popula con valores correctos.

---

### 🟢 BRECHA 6 — Cleanup workflows deprecated

Workflows que quedan en n8n pero NO se usan:

| Workflow | ID | Estado | Acción sugerida |
|---|---|---|---|
| CS Data v1 (culpable 69 GB) | `akkbfUdsiXEg57LK` | inactive | **archivar/eliminar** (su rol lo cumple CS Data v2) |
| Aircall Data v1 | `xLoZ7zAJNaG5zZ64` | inactive | **archivar/eliminar** (su rol lo cumple Aircall Data v2) |
| CS Seed v2 (JSON plano 30MB) | `l4ycDRei3Toq9Y6z` | inactive | **eliminar** (no se usa, deprecated) |
| Aircall Seed v2 | `wyFkXiYJmwB9ARFg` | inactive | **eliminar** (no se usa) |
| CS Errores | `o89xKbjT6mKkjAmN` | inactive | **decidir**: si se reactiva ahora con auto-cleanup 2 días, no satura. Si lo dejamos inactivo permanente, también ok. |

Eliminar workflows libera carga de la BD Postgres y simplifica el inventario.

---

### 🟢 BRECHA 7 — Aircall enrich (zendeskTicketId, tags ampliados)

Análogo a BRECHA 1 pero para Aircall. La API `/v1/calls` devuelve campos básicos. Para el cross-link Aircall↔Zendesk (`zendeskTicketId`), v1 NO lo enriquece — viene poblado solo si Aircall lo escribe en el ticket Zendesk via `aircall_call_id` custom field.

**Estado**: el populate masivo ya seteó `zendeskTicketId: null` en todos los calls. v1 tampoco lo poblaba directamente. **No es una brecha real, está ok.**

---

## Cleanup de scripts auxiliares

Los siguientes scripts son **one-shot** (corridos para la migración inicial). Se mantienen en el repo como referencia/idempotencia, pero NO se vuelven a correr en operación normal:

- `setup_mongo_collections.py` — idempotente, OK reapplicar
- `populate_mongo_from_seed.py` — para re-sincronizar masivo si hace falta
- `populate_mongo_calls.py` — idem para calls
- `add_unix_timestamps.py` — solo si se cambia schema en el futuro
- `setup_mongo_n8n_credential.py` — solo si se borra la credencial
- `migrate_cursors_to_mongo.py` — solo si se borran los cursors de PanelCSMeta
- `setup_v2_workflows.py` — idempotente, OK reapplicar para cambios de schema en los workflows

---

## Orden de ataque sugerido (próxima sesión)

1. **BRECHA 5 (cleanup backlog)** — `python populate_mongo_from_seed.py` para re-sincronizar Mongo con datos frescos. ~1 min.
2. **BRECHA 1 (enrich)** — agregar nodos al Schedule de CS Data v2 para enriquecer FRT/SLA. ~1 hora.
3. **BRECHA 2 (lookups)** — Opción C en `PanelCSMeta` + Code en branch GET que los inyecta. ~1 hora.
4. **BRECHA 3 (events/escalamientos)** — branch nuevo. ~2-3 horas.
5. **BRECHA 6 (cleanup workflows)** — borrar v1, Seed v2 deprecated. ~10 min.
6. **Validar end-to-end con cliente del panel**: refresh hard + esperar 10 min + revisar que tickets nuevos tengan métricas correctas.

Tiempo total estimado para paridad 100%: **~5 horas** en una sesión sin interrupciones.

---

## Decisiones y trade-offs ya cerradas (no re-discutir)

- **CS Seed v1 se mantiene** (gzip eficiente, NO fue culpable del incidente). Sirve los 38k tickets como antes.
- **Cliente del panel sin cambios**: paths y shape de response idénticos. Eso evitó distribuir un index.html nuevo a usuarios.
- **camelCase en Mongo, snake_case al servir al cliente**. El mapeo lo hace n8n en el Code "Map to snake_case".
- **Credenciales en n8n vault**, cero token hardcodeado en workflows.
- **Cursors persistentes en `PanelCSMeta`** (no en `staticData` que fue el culpable).
- **`saveDataSuccessExecution: 'none'`** en workflows v2 (evita repetir incidente).
- **Migración a otra tecnología futura**: documentada como [[cs-panel-v2]] (HU 1 = vista global ejecutiva). Esta migración a Mongo es un puente para llegar bien preparados a esa migración mayor.

---

## Memoria persistente capturada

- `feedback_verificar_devops_antes_inferir_5xx.md` — ≥2 probes antes de declarar causa raíz en 5xx.
- `reference_n8n_contactos.md` — Marcelo Letelier (infra) vs Aldo Carvajal (workflows).
- `reference_n8n_node_quirks.md` — quirks del Code/MongoDB/HTTP nodes de n8n (zlib bloqueado, EJSON no interpretado, credentials predefined vs generic).

---

## Cross-link

- [`PLAN-MIGRACION-MONGO.md`](PLAN-MIGRACION-MONGO.md) — plan original
- [`PLAN-FASE-2-WORKFLOWS.md`](PLAN-FASE-2-WORKFLOWS.md) — plan detallado workflows
- [`WORKFLOW-CS-EXPORT.md`](WORKFLOW-CS-EXPORT.md) — patrón validado de export con Code monolítico
- [[cs-panel]] — proyecto vivo
- [[cs-panel-v2]] — proyecto migración tecnológica futura
