# Panel KPIs CS — Milestones · Issues · Sub-tareas

> Snapshot al **2026-05-28 19:30 chile**. Cubre la sesión anterior (SES-20260528-0844) + la sesión actual (SES-20260528-1810). Estructura jerárquica para mapear directo a Linear: cada `### Issue` se vuelve un Issue del proyecto, cada `- ☐` es una sub-tarea (checklist) de ese Issue. Los Milestones agrupan Issues con un mismo objetivo.

**Convenciones de estado**:
- ✅ done
- 🟡 in progress
- 🔴 pending
- ⏭️ diferido / movido a otro scope

---

## Milestone 1 — Re-encuadre conceptual de canales

> **Objetivo**: resolver el reporte "los números no calzan" del cliente del panel, redefiniendo el modelo mental de canales del Panel CS.

### Issue 1.1 — Diagnóstico de filtros y discrepancias ✅

- ✅ Mapear filtros actuales del Panel CS (`cs-view.render.js` 3.388 líneas).
- ✅ Identificar 8 fuentes mecánicas de discrepancia A-H.
- ✅ Verificar conteos sobre seed 38.144 tickets (Correo 59,1% · Teléfono 31,8% · Chat 9,1%).

### Issue 1.2 — Re-definir modelo de canales ✅

- ✅ Decidir nuevo modelo cerrado del selector: `Todos · Zendesk · Teléfono (Aircall) · Chat (Wotnot)`.
- ✅ Redefinir filtro `zd` = universo total Zendesk (no solo Correo).
- ✅ Deploy del re-encuadre (`deploy_cs_view.py rename-canales-univ-zendesk-2026-05-28`).

### Issue 1.3 — Vista global "Todos" ⏭️ (movida a Milestone 6)

- ⏭️ KPIs cross-canal con etiquetado por fuente (movida a `cs-panel-v2` HU 1).

---

## Milestone 2 — Tab Cliente: HUs 3+4+5

> **Objetivo**: enriquecer la vista por cliente con nuevas métricas operativas.

### Issue 2.1 — Top FRT con visibilidad de estado ✅

- ✅ HU 3 — Agregar columna Estado al Top FRT.

### Issue 2.2 — Top SLA reformulado por antigüedad real ✅

- ✅ HU 4 — Antigüedad = vida real del ticket.
- ✅ HU 4 — Ordenar por vida DESC (más viejos primero).
- ✅ HU 4 — Ventana 60d.
- ✅ HU 4 — Reemplazar "% cumplimiento" por "Tiempo de respuesta" como métrica primaria.

### Issue 2.3 — Exportador para análisis IA ✅

- ✅ HU 5 — Panel "Análisis / Exportador Tickets por Rango" en el cliente.
- ✅ HU 5 — Workflow `CS Export` en n8n.
- ✅ HU 5 — Output JSONL consumible por agentes IA.

---

## Milestone 3 — Migración crítica a MongoDB Atlas

> **Objetivo**: salir de Postgres n8n como persistencia tras el incidente del 28-may (69 GB en `execution_data` por staticData mutante en CS Data v1).

### Issue 3.1 — Diagnóstico y contención del incidente 69 GB ✅

- ✅ Identificar causa raíz: `staticData` mutante en `Actualizar Caché` cada 5 min generaba blobs gigantes.
- ✅ Devops (Marcelo) aplicar parche infra: auto-cleanup `execution_data` a 2 días.
- ✅ Devops desactivar workflows del Panel para frenar el sangrado.
- ✅ Documentar la lección aprendida.

### Issue 3.2 — Setup MongoDB Atlas ✅

- ✅ Crear BD `automatizaciones` en cluster devqa.
- ✅ Crear colección `PanelCSTickets`.
- ✅ Crear colección `PanelCSCalls`.
- ✅ Crear colección `PanelCSMeta`.
- ✅ Crear credencial `Mongo Atlas devqa - Panel CS` en n8n vault.
- ✅ Cargar inicial 38.144 tickets (Zendesk).
- ✅ Cargar inicial 17.955 calls (Aircall).

### Issue 3.3 — Workflows v2 con sync incremental ✅

- ✅ Migrar cursores desde `staticData` a `PanelCSMeta` (keys `csDataCursor`, `aircallDataCursor`).
- ✅ Crear workflow `CS Data v2 (Mongo)` (id `eOarJPeIeUPI45de`).
- ✅ Crear workflow `Aircall Data v2 (Mongo)` (id `HUE2XQ25uO5BuDw6`).
- ✅ Aplicar `saveDataSuccessExecution: 'none'` (garantía anti-bloating).
- ✅ Validar sync incremental Zendesk → Mongo cada 5 min.
- ✅ Validar sync incremental Aircall → Mongo cada 5 min.

### Issue 3.4 — Compatibilidad con cliente del panel ✅

- ✅ Mantener mismo path `/webhook/cs-data` (cero cambios en el cliente).
- ✅ Mantener mismo shape de response (snake_case con lookups vacíos).
- ✅ Cero distribución de archivo nuevo a usuarios.

---

## Milestone 4 — Paridad funcional v1 ↔ Mongo

> **Objetivo**: cerrar todas las brechas de fidelidad entre v1 y la implementación Mongo.

### Issue 4.1 — BRECHA 5: Cleanup del backlog (Plan B re-popular desde local) 🟡

- 🟡 Correr `carga_inicial.py --desde 2026-01-01` (fetch incremental + Search activos + enrich + ticket_events + publish seed).
- 🔴 Correr `populate_mongo_from_seed.py` con `PYTHONIOENCODING=utf-8` (upsert masivo Mongo).
- 🔴 Correr `update_cursor.py csDataCursor now` (evita reprocesado del Schedule).
- 🔴 Validar conteo final en `PanelCSTickets` ≈ 38.144 con todos los campos enrich poblados.

### Issue 4.2 — BRECHA 1: Enrich FRT/SLA en Schedule CS Data v2 🟡

- ✅ Snapshot del workflow guardado (`repos_github/panelcs/snapshots/20260528-180636-cs-data-v2-mongo-eOarJPeIeUPI45de.json`) para rollback.
- ✅ Pre-armar patch en `setup_v2_workflows.py`: 3 nodos nuevos (`Collect Enrich Chunks`, `Zendesk show_many`, `Enrich Merge`).
- ✅ Validación dry-run: 15 nodos generados (era 12), conexiones correctas, sintaxis Python OK.
- ✅ Fixes preventivos: `waitBetweenRequests: 60000`, `onError: continueRegularOutput`, JS tolera response con error.
- 🔴 Aplicar patch (correr `setup_v2_workflows.py`).
- 🔴 Validar workflow en UI n8n: 15 nodos, active=True.
- 🔴 Esperar 5-10 min para corrida real del Schedule.
- 🔴 Validar con `verify_brecha1.py`: tickets nuevos con `frtMin/slaBreached/slaActiveBreaches/solvedAt/reopens` no-null.

### Issue 4.3 — BRECHA 2: Lookups (groups/agents/orgs) en deltas 🔴

- 🔴 Implementar Opción C: persistir lookups en `PanelCSMeta` con keys `lookupsUsers`, `lookupsGroups`, `lookupsOrgs`.
- 🔴 Agregar nodos al branch Schedule de CS Data v2 que extraigan lookups del incremental (`include=users,groups,organizations`) y los upserten en PanelCSMeta.
- 🔴 Modificar branch GET de CS Data v2 (Code "Map to snake_case") para inyectar lookups desde PanelCSMeta en la respuesta.
- 🔴 Validar: tickets con assignee/group/org nuevo aparecen con nombre, no "Agente {id}".

### Issue 4.4 — BRECHA 3: Events / escalamientos en deltas (Fase 3b) 🔴

- 🔴 Agregar branch nuevo en CS Data v2 que consuma `ticket_events.json` incremental.
- 🔴 Persistir `transitionsHistory` por ticket en PanelCSTickets (schema nuevo).
- 🔴 Recomputar `pasoSn1`, `escSn2`, `escMo`, `devol` en cada delta basado en transitions.
- 🔴 Decidir: backfill histórico o solo cambios futuros.
- 🔴 Validar: ticket que escala SN1→SN2 después del seed se refleja en el panel.

### Issue 4.5 — BRECHA 6: Cleanup workflows v1 deprecated 🔴

- 🔴 Eliminar `akkbfUdsiXEg57LK` — CS Data v1 (causante incidente 69 GB).
- 🔴 Eliminar `xLoZ7zAJNaG5zZ64` — Aircall Data v1.
- 🔴 Eliminar `wyFkXiYJmwB9ARFg` — Aircall Seed v2 deprecated.
- 🔴 Eliminar `l4ycDRei3Toq9Y6z` — CS Seed v2 deprecated.
- 🔴 Decidir destino de `o89xKbjT6mKkjAmN` (CS Errores): reactivar con auto-cleanup o eliminar.

---

## Milestone 5 — Documentación + repo

> **Objetivo**: dejar el proyecto auto-contenido y portable para que cualquiera del equipo pueda retomarlo.

### Issue 5.1 — Docs Linear ✅

- ✅ Description del proyecto (`repos_github/panelcs/docs/linear/description.md`).
- ✅ ToDos + Milestones organizados (este archivo).

### Issue 5.2 — Docs Notion ✅

- ✅ Generar MD para Notion `Panel-CS-versi-n-n8n` (doc técnica).
- ✅ Generar MD para Notion `Panel-KPIs-Customer-Service` (estructura 1-7).
- ✅ Pegar/enriquecer contenido en Notion (2026-05-29): doc técnica actualizada (refs + changelog) + proyecto general con estructura híbrida.

### Issue 5.3 — Repo único en GitHub `panelcs` ✅

- ✅ Crear repo `panelcs` privado en cuenta personal `alvarocortes-ic`.
- ✅ Migrar contenido desde `outputs/cs-panel/` del workspace ICClaude a `repos_github/panelcs/` (al nivel de ICClaude).
- ✅ Refactor de rutas en 32 scripts: `parents[1]` como raíz + credenciales desde `../ICClaude/.env.credentials` (fuente única).
- ✅ Recrear `.venv` + validar script end-to-end (`list_workflows.py`).
- ✅ `git rm` de `outputs/cs-panel/` en ICClaude + actualizar refs del vault.
- ✅ Push del refactor (commit `21924ce`).
- 🔴 README.md de onboarding (revisar si el existente cubre).

---

## Milestone 6 — Forward (post-paridad 100%)

> **Objetivo**: evoluciones del panel después de alcanzar paridad funcional con v1.

### Issue 6.1 — Wotnot (chat) como stream propio 🔴

- 🔴 Decidir si va a `cs-panel` actual o a `cs-panel-v2` (migración tecnológica futura).
- 🔴 Diseñar sync incremental nativo desde Wotnot API.
- 🔴 Crear colección `PanelCSChats` o integrar al modelo actual.
- 🔴 Workflow `Wotnot Data v2 (Mongo)` análogo a CS Data v2.

### Issue 6.2 — Vista global "Todos" (cs-panel-v2 HU 1) 🔴

- 🔴 KPI hero (números grandes cross-canal).
- 🔴 Tendencia multistream (líneas por canal en el tiempo).
- 🔴 Donut por canal (% share del volumen).
- 🔴 Tabla resumen ordenable.

### Issue 6.3 — Performance del cliente 🔴

- 🔴 Lazy load del seed: abrir panel sin descargar 38k tickets de una.
- 🔴 Pagination / virtualización en listas largas.
- 🔴 Service Worker para cache offline.

### Issue 6.4 — KPIs derivados con líderes CS 🔴

- 🔴 Workshop con líderes (Paulina, Aldo, Mónica, Sebastián) para listar KPIs prioritarios.
- 🔴 Definir NPS, tiempo medio de cierre, distribución de complejidad, churn de tickets.
- 🔴 Implementar widgets/dashboards específicos.
- 🔴 Validar visualmente con cada líder antes de release.

---

## Milestone 7 — Deuda técnica acumulada

> **Objetivo**: limpiar deuda técnica conocida del cliente y workflows que afecta mantenibilidad y precisión.

### Issue 7.1 — Optimizar filtros del cliente 🔴

- 🔴 Filtro "Tipo" usa regex sobre `subject` (ineficiente) — convertir a campo indexado en Mongo.

### Issue 7.2 — Fix bug FRT enrich (tickets cerrados por merge) 🔴

- 🔴 Reproducir: tickets cerrados por merge llegan con `frtMin` null aunque exista `metric_set`.
- 🔴 Identificar causa: race condition entre `closed_by_merge` y el cálculo de `reply_time_in_minutes`.
- 🔴 Fix en la lógica de enrich (carga_inicial.py + nodo Enrich Merge del Schedule).

### Issue 7.3 — Eliminar hardcodeos del cliente 🔴

- 🔴 IDs grupos SN1 (4 IDs), SN2 (1 ID), MO (1 ID) hardcodeados en `cs-view.render.js`.
- 🔴 Mover a config del workflow (custom field o `PanelCSMeta` con key `groupClassification`).
- 🔴 Cliente lee de config en lugar de constantes.

### Issue 7.4 — Documentar workflows oscuros 🔴

- 🔴 Schedule de `CS DTE Health` (`p40WEmG8nXh1HhSD`): el cron real oscila ±2h vs ventana 24h, genera 90% de falsos positivos. Documentar comportamiento + decidir si recalibrar.
- 🔴 Workflow C2b "merge defensivo" — activo en `cs-view.render.js`, lógica no está documentada en el repo.

---

## Próxima acción inmediata (orden de ejecución)

1. Esperar a que termine `carga_inicial.py` (bg `bzoy3r2xh`).
2. Issue 4.1 → ejecutar `populate_mongo_from_seed.py` + `update_cursor.py`.
3. Issue 4.2 → aplicar `setup_v2_workflows.py` + `verify_brecha1.py`.
4. Cerrar sesión con commit semántico.
5. (próxima sesión) Issue 4.3 (lookups) + Issue 5.3 (crear repo único).
