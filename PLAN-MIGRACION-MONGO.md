# Plan de migración Panel CS → MongoDB Atlas (devqa)

> Documento de plan creado 2026-05-28 tras incidente devops: workflow `akkbfUdsiXEg57LK` (CS Data) acumuló 69 GB en Postgres de n8n productivo causando saturación.

## 1. Diagnóstico del problema

### Causa raíz del bloating de n8n

| Workflow | Activo hoy | Schedule | Ejecuciones/24h | Patrón problemático |
|---|---|---|---|---|
| **CS Data** `akkbfUdsiXEg57LK` | **🔴 INACTIVO** (devops apagó) | cada 5 min | **244** | Procesa N tickets Zendesk + events en cada corrida, guarda en `staticData` del workflow + n8n persistía cada ejecución completa en `execution_data` |
| **Aircall Data** `xLoZ7zAJNaG5zZ64` | 🟢 activo | cada 5 min | 232 | Mismo patrón: fetch calls + Slim+Save en staticData |
| **CS Errores** `o89xKbjT6mKkjAmN` | 🔴 INACTIVO | error trigger | 122 | Cada error de cualquier workflow crea ejecución |
| **CS View** `qOIldhWyoeGMUa2p` | 🔴 INACTIVO | webhook | n/a | Solo sirve HTML estático (NO es problema, pero devops lo apagó por seguridad) |
| **CS Seed** `SXt8GRp5zjKKNfh6` | 🔴 INACTIVO | webhook | n/a | Sirve seed gzipped de staticData (NO es problema directo) |
| **DTE Health** `p40WEmG8nXh1HhSD` | 🟢 activo | cada 15 min | ~50 | Query MS-SQL → cache en staticData (chico, OK) |
| **CS Export** `VDRQnxqBumKPfiyC` | 🟢 activo | on-demand | bajo | Sin staticData |

### Síntoma específico de CS Data

- Cada 5 min: `Incremental Tickets` (Zendesk API) → `Batches IDs` → `Enrich` (~100 tickets con custom_fields completos) → `Actualizar Caché` (Code 5.6KB que escribe en `staticData`) → `Cursor Eventos` → `Incremental Events` → `Merge Events`.
- Cada ejecución mueve potencialmente **MBs de payload** entre nodos. n8n por defecto guardaba el snapshot de cada nodo en `execution_data` de Postgres.
- 244 ejecuciones × payloads grandes × días = **69 GB acumulados en 5-6 días**.

### Estado actual del panel productivo

- **5/5 probes de `cs-view` y `cs-seed` → HTTP 404** (workflows inactivos por devops).
- El cliente del panel no puede cargar el HTML ni el seed inicial.
- Los usuarios con el panel ya abierto en su browser pueden ver datos viejos del IndexedDB (cache local), pero al recargar → blanco.

### Impacto del modelo actual sobre el panel (ortogonal al bloating)

Aunque devops resolvió el bloating, el modelo `staticData en n8n` tiene problemas inherentes:

- **Seed completo (38k tickets)** se serializa/deserializa en cada GET `/webhook/cs-seed` → ~3.3 MB gzip+base64 por response.
- **Cualquier cambio en el shape del slim_ticket** requiere re-correr `carga_inicial.py` completo (~10 min) y re-publicar el seed.
- **Sin queries**: para filtrar/buscar, el cliente baja TODO y filtra en navegador. No escala más allá de N tickets.
- **Sin TTL ni expiración**: el seed se acumula indefinidamente.

## 2. Solución: MongoDB Atlas como source of truth

### Ventajas del cambio

| Aspecto | Hoy (n8n staticData) | Propuesto (Mongo Atlas) |
|---|---|---|
| Storage | Postgres n8n (compartido + frágil) | Mongo Atlas devqa (dedicado + escalable) |
| Tamaño max viable | ~5-10 MB por staticData (perf degrada) | TB sin problema |
| Queries | Cliente filtra todo (no scale) | Backend filtra con índices |
| Sync incremental | Lee seed + delta y mergea en cliente | Mongo upsert por ticket_id (atómico) |
| Saturación n8n | Sí (este incidente) | No: n8n solo hace insert + responde |
| Auditabilidad | Solo logs n8n (volátiles) | Histórico Mongo + change streams |
| Mantenimiento | Manual via Code nodes | Aggregations + indexes |

### Plan de creación de colecciones — PROPUESTA

> Nomenclatura: respeta la convención existente de la BD (PascalCase para colecciones, camelCase para campos). Prefijo `PanelCS` para identificar el dominio, similar a `AgentePersonal*`, `Index*`, `Registro*` ya presentes.

#### Colección `PanelCSTickets`

- **Propósito**: source of truth de tickets Zendesk del panel CS. Reemplaza el staticData de CS Seed + CS Data.
- **Documento por ticket Zendesk**.
- **Esquema** (camelCase, derivado del `slim_ticket` actual de `carga_inicial.py`):

```json
{
  "_id": "<ObjectId>",
  "ticketId": 1812947,          // único, índice unique
  "subject": "string",
  "status": "open|new|pending|hold|solved|closed",
  "priority": "low|normal|high|urgent|null",
  "type": "incident|question|task|null",
  "createdAt": ISODate("2026-05-01T..."),
  "updatedAt": ISODate("..."),
  "solvedAt": ISODate|null,
  "frtMin": 47,                 // First Reply Time en min
  "reopens": 0,
  "groupId": "4681557011739",
  "assigneeId": "12345",
  "organizationId": "4948711221787",
  "slaBreached": true,
  "slaActiveBreaches": [        // [{metric, stage, breach_at}]
    { "metric": "first_reply_time", "stage": "active", "breachAt": ISODate("...") }
  ],
  "nivel": "complejo|simple|null",
  "seguimiento": true,
  "merged": false,
  "csat": 5,
  "lineaNegocio": "Suministros",
  "categoria": "Integraciones",
  "producto": "Compra (OC)",
  "subproducto": "Comprasys",
  "pasoSn1": true,
  "escSn2": false,
  "escMo": false,
  "devol": 0,
  "viaChannel": "email",
  "canalNormalizado": "Correo",
  "chatSubtype": null,
  "aircallCallId": 123456789,
  "_syncedAt": ISODate(),       // metadata interna: cuándo el sistema lo trajo de Zendesk
  "_syncSource": "carga_inicial.py | cs-data-workflow"
}
```

- **Índices**:
  - `{ ticketId: 1 }` **unique** — clave de upsert
  - `{ updatedAt: -1 }` — para query de deltas (`updatedAt > lastSync`)
  - `{ organizationId: 1, createdAt: -1 }` — para vistas por cliente
  - `{ status: 1, slaBreached: 1 }` — para queue activo con SLA vencido
  - `{ assigneeId: 1, status: 1 }` — para vista por agente
  - TTL: **ninguno** (no expiramos tickets — son histórico de negocio)

#### Colección `PanelCSCalls`

- **Propósito**: source of truth de calls Aircall. Reemplaza staticData de Aircall Seed + Aircall Data.
- **Documento por call** (mismo shape que el actual de `setup_aircall_seed.py`).
- **Índices**:
  - `{ callId: 1 }` **unique**
  - `{ startedAt: -1 }`
  - `{ userId: 1, startedAt: -1 }` — para agente
  - `{ direction: 1, status: 1 }` — inbound/outbound × answered/missed

#### Colección `PanelCSMeta`

- **Propósito**: metadata del sistema (cursors, last_sync timestamps, schema_version, config). Reemplaza el `Cursor Caché` Code node.
- **Documento por key** (~5-10 docs en total).

```json
{
  "_id": "<ObjectId>",
  "key": "cs-data-cursor",      // key único
  "value": "<cursor opaco Zendesk>",
  "updatedAt": ISODate(),
  "notes": "Cursor de la API incremental/tickets de Zendesk"
}
```

- **Índices**: `{ key: 1 }` **unique**

#### Colección `PanelCSDteHealth`

- **Propósito**: health DTE por empresa (reemplaza staticData de DTE Health workflow).
- **Documento por empresa**.
- **Índices**: `{ empresaId: 1 }` unique, `{ estado: 1, ultimaConsultaAt: -1 }`.

### Lo que NO migra

- **CS Errores**: log de errores → ya existe `RegistroEjecucionesN8N` (3853 docs). Si el equipo lo expande para errores, no creamos otra colección. Por ahora dejamos este workflow inactivo.
- **CS View**: HTML estático, no necesita BD. Sigue sirviendo desde el nodo Set en n8n.
- **CS Export**: lee directo de Zendesk API on-demand. No toca seed.

## 3. Estrategia de bypass — pasos ordenados

### Fase 0 — restauración del panel (HOY, sin tocar Mongo)

> Objetivo: panel productivo arriba para usuarios con la data congelada del último seed. ~5 minutos.

1. Reactivar workflows **CS View** + **CS Seed** en n8n UI (activate). NO reactivar CS Data ni CS Errores.
2. Verificar `GET /webhook/cs-view` y `GET /webhook/cs-seed` responden 200.
3. **Costo**: el panel funciona pero sin deltas en tiempo real. La data tiene la antigüedad del último `carga_inicial.py`. Los usuarios verán los tickets activos hasta ese momento, no los nuevos.

### Fase 1 — creación + población de colecciones Mongo (HOY-MAÑANA)

> Una vez aprobado este plan.

1. **Crear colecciones + índices** (yo, después de tu OK):
   - `PanelCSTickets` con sus 5 índices
   - `PanelCSCalls` con sus 4 índices
   - `PanelCSMeta` con su índice único
   - (Más adelante) `PanelCSDteHealth`
2. **Poblar seed inicial**:
   - Modificar `carga_inicial.py` para que escriba a Mongo (bulk upsert) en vez de generar `seed.js`.
   - Correr el script una vez para llenar `PanelCSTickets` con los ~38k tickets actuales.
   - Modificar `setup_aircall_seed.py` similar para `PanelCSCalls`.
3. **Verificar índices funcionan** con queries de muestra (count, find por organizationId, etc.).

### Fase 2 — refactor de workflows n8n (MAÑANA)

> Cambia n8n de "guardar seed completo" a "insertar deltas a Mongo".

1. **CS Seed refactor**:
   - El `Webhook Servir` (GET /webhook/cs-seed) ahora ejecuta query Mongo (`db.PanelCSTickets.find({}).limit(...)`) y devuelve resultado.
   - Removemos el nodo `Servir Seed` (staticData) y `Guardar Seed` (POST).
   - Probablemente con el nodo `MongoDB` de n8n. Si no existe en esta versión, usamos `HTTP Request` al Atlas Data API.
2. **CS Data refactor**:
   - Mantiene `Incremental Tickets` + `Enrich` (igual).
   - Reemplaza `Actualizar Caché` (staticData) por nodo `MongoDB` con operación `Upsert` por `ticketId` en `PanelCSTickets`.
   - Quita lógica de cursors en staticData → guarda cursor en `PanelCSMeta`.
   - No genera response grande — solo `{ ok: true, upserted: N, elapsed_ms: X }` para health.
3. **Aircall Data refactor**: análogo a CS Data sobre `PanelCSCalls`.
4. **Settings de los workflows**: `saveDataSuccessExecution: 'none'`, `saveDataErrorExecution: 'all'`, `saveExecutionProgress: false` (alineado con auto-cleanup 2 días de devops).
5. **Reactivar CS Data y Aircall Data**.

### Fase 3 — refactor del cliente (panel HTML)

> Cambio mínimo en el cliente.

1. El cliente sigue haciendo `GET /webhook/cs-seed` → ahora recibe el seed desde Mongo (mismo shape, distinto origen).
2. El delta sync `GET /webhook/cs-data?since=...` ahora consulta Mongo `find({ updatedAt: { $gt: since } })`.
3. **Opción optimización (Fase 4 opcional)**: paginar el seed inicial (50k tickets en 1 response = 3MB sigue siendo aceptable, pero podríamos enviar en chunks con `?page=N`).
4. IndexedDB local del cliente sigue funcionando idéntico (mismo shape de doc).

### Fase 4 — observabilidad y cleanup

1. Monitor de tamaño de las colecciones Mongo (alerts si >10GB).
2. Eliminar workflow `CS Seed - Dataset del panel` (vacío post-refactor).
3. Eliminar el directorio `outputs/cs-panel/data/seed.js` (ya no se usa).

## 4. Riesgos y mitigaciones

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| Devqa Mongo Atlas no aguanta el volumen | Baja (38k+18k docs son nada) | El cluster ya tiene 11 colecciones con miles de docs |
| n8n no tiene nodo MongoDB en la versión actual | Media | Fallback: usar `HTTP Request` al Atlas Data API (REST) |
| El cliente del panel rompe por cambio en /cs-seed | Baja | Mantenemos exactamente el mismo shape de response |
| Latencia query Mongo desde n8n productivo | Baja (Atlas devqa accesible) | Test con 1 query antes de migrar |
| Race conditions al poblar inicial + activar incremental | Media | Migrar primero (Fase 1), reactivar incremental después (Fase 2). Usar upsert (no insert) en ambos para idempotencia |
| Datos sensibles en Atlas devqa con menos restricciones que prod | Media-Alta | NO hay PII real más allá de lo que ya circula. Los tickets Zendesk tienen IDs + assignees, no datos críticos. Validar con seguridad si llega a producción |

## 5. Costos en tiempo

| Fase | Tiempo estimado | Bloqueante para usuarios |
|---|---|---|
| Fase 0 (reactivar panel congelado) | 5 min | NO (panel arriba sin deltas) |
| Fase 1 (poblar Mongo) | 30-60 min | NO (cuál panel sigue arriba) |
| Fase 2 (refactor workflows) | 2-3 horas | Breve (~5 min al swap) |
| Fase 3 (cliente, si aplica) | 1 hora | NO (cambio backwards-compat) |

## 6. Próximos pasos — pido tu aprobación de:

1. **Fase 0 ahora** (reactivar CS View + CS Seed en UI n8n) — tú haces el click; yo no tengo permiso para tocar UI.
2. **Plan de colecciones**: nombres `PanelCSTickets`, `PanelCSCalls`, `PanelCSMeta` — ajustes si querés cambiar nomenclatura.
3. **Schema de campos**: revisar si querés sumar/sacar/renombrar algo del shape propuesto para `PanelCSTickets`.
4. **Orden de fases**: ejecutar 0 → 1 → 2 → 3 secuencial, o cambias prioridad.
5. **Autorización de creación**: yo creo las colecciones + índices via pymongo. **NO** populo nada hasta tu doble OK.

---

## Anexos — info técnica

### Credenciales Mongo verificadas

- Host: `devqa-mongodb-atlas.26bxl.mongodb.net`
- BD: `automatizaciones`
- Usuario: `acortes` (privilegios verificados: `createCollection`, `createIndex`, `insert`, `update`, `find`, `collStats`, `changeStream`)
- Mongo version: 8.0.23

### Volumen estimado en Mongo

- `PanelCSTickets`: ~38k docs × ~3KB c/u (slim_ticket promedio) = **~115 MB**
- `PanelCSCalls`: ~18k docs × ~1.5KB c/u = **~27 MB**
- `PanelCSMeta`: ~10 docs × <1KB = **<10 KB**
- Total estimado fase 1: **~142 MB** (BD actual 105 MB — duplicamos pero sigue siendo trivial para Atlas)
- Crecimiento: ~100 tickets/día Zendesk × 3KB = **~300 KB/día** = ~9 MB/mes

### Workflows que quedarán en n8n post-migración

- `CS View` — sirve HTML (sin cambios)
- `CS Data` — refactorizado (insert a Mongo, no staticData)
- `Aircall Data` — refactorizado (insert a Mongo)
- `DTE Health` — sin cambios fase 1, considerar migrar después
- `CS Export` — sin cambios (lee directo de Zendesk on-demand)
- `CS Errores` — sin uso por ahora (mantener inactivo)

### Workflows a eliminar post-migración

- `CS Seed` (POST + GET) — su rol lo cumple ahora la colección Mongo + un endpoint nuevo en CS Data o CS View
