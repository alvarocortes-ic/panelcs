# Incidente n8n CS View — Timeline 2026-05-26 → 2026-05-27

> [!danger] Documento de respaldo para rollback. Snapshots JSON completos en `snapshots/`.

## Resumen ejecutivo

El **workflow `kQmPeDgXA27mKQPj` "CS View"** (que sirve el panel CS productivo vía webhook `https://prod-low-code.iconstruye.dev/webhook/cs-view`) entró en estado corrupto a nivel BD de n8n después del último PUT del Mac el **2026-05-27 07:23 chile**. Síntomas:

1. **Webhook GET responde HTTP 500** con `{"code":0,"message":"There was a problem executing the workflow"}`.
2. Las llamadas al webhook **NO quedan registradas en `/executions`** (error pre-primer-nodo, antes del runtime).
3. **Cualquier PUT con cambios reales al contenido** del nodo Set (CSS+JS) devuelve `HTTP 400` con `insert or update on table "workflow_entity" violates foreign key constraint "FK_08d6c67b7f722b0039d9d5ed620"`.
4. PUT minimal (sin cambios al `nodes/connections`) sí pasa, pero no resuelve el 500.
5. Toggle deactivate+activate vía API no resuelve.

**Estado al cierre del Mac (commit `0aedf7db` 2026-05-27 07:29 chile)**:
- Panel CS funcionaba **con la versión vieja del JS** (~158KB con 22 mesas, NO los 35 mapeados localmente).
- El último deploy intentado (`4a5a0917` "pérdidas Aircall por mesa + KPI") quedó **parcial** — Mac dejó en n8n una versión sin el JS completo (162KB).
- El cierre de SES-20260526-1120 dice textual: *"Deploy del bloque completo bloqueado al cierre por n8n FK violation. Re-deploy en próxima sesión"*.

## Timeline detallado

### 2026-05-26 (Mac · SES-20260526-1120 · sprint Panel CS Fase A→D)

| Hora chile | Commit | Acción | Estado n8n |
|---|---|---|---|
| 11:20 | inicio sprint | takeover lock W11 SES-20260526-1001 | Workflow `kQmPeDgXA27mKQPj` activo, JS ~155KB |
| 11:58 | `56364b70` | feat Fase A — refactor raw/build | Sin cambio en n8n CS View |
| 12:55 | `24709beb` | fix _iso_to_month + cursor save per-step | Sin cambio en n8n |
| 13:26 | `f9992842` | fix guardrail anti bug-epoch + cursor.json | Sin cambio en n8n |
| 14:59 | `ceb84645` | feat Fase A validada — 5 bugs corregidos | Probable deploy a n8n (versionCounter creció) |
| 15:46 | `c8b862e3` | feat Fase B paso 1 — selector canal + Aircall | Probable deploy |
| 15:50 | `3efd837a` | feat Fase B paso 2 — filtros + vista Aircall mínima | Probable deploy |
| 15:57 | `8948bff2` | fix Aircall vive enteramente en cs-view | Probable deploy |
| 16:35 | `adbee517` | feat Fase B paso 3 — badge canal + filtros | Probable deploy |
| 16:37 | `33d920a6` | feat Fase B paso 4 — charts patrón temporal | Probable deploy |
| 16:48 | `35cfb935` | feat Fase C + Fase D cross-link Aircall↔Zendesk | Probable deploy |
| 17:45 | `cf143a5d` | feat Aircall persistente IDB + multicanal en tabs | Probable deploy |
| 17:47 | `c7da8179` | feat banner cache stale | Probable deploy |
| 18:40 | `8120abe4` | fix 3 bugs reportados (filtros pegados, etc) | Probable deploy |
| 19:56 | `6874ee95` | feat Resumen multicanal filtrable | Probable deploy |
| **22:55** | — | **última EXEC success del webhook cs-view** (`id=310911`) | n8n estable hasta aquí |

### 2026-05-27 (Mac)

| Hora chile | Commit | Acción | Estado n8n |
|---|---|---|---|
| **07:23** | `4a5a0917` | feat pérdidas Aircall por mesa + KPI agents_did_not_answer | **PUT del Mac → FK violation** · workflow queda en estado intermedio con webhook 500 |
| 07:29 | `0aedf7db` | docs mapping + cierre Mac | Cierre con bloqueante documentado |

### 2026-05-27 (W11 PF5S3Y04 · SES-20260527-0744)

| Hora chile | Acción | Resultado |
|---|---|---|
| 07:36 | apertura sesión + sync git (rebase + push) | W11 sincronizado con remoto Mac |
| 07:44 | takeover lock huérfano + open-session.sh | SES-20260527-0744 abierta |
| 07:50 | health check webhook cs-view | **HTTP 500** confirmado |
| 07:52 | PUT minimal sobre viejo `kQmPeDgXA27mKQPj` (sin cambios) | **OK** · versionCounter 120→121 · webhook sigue 500 |
| 07:55 | PUT con touch al `version` del nodo Set | **HTTP 400 FK violation** confirmado |
| 07:58 | toggle deactivate+activate sobre viejo | OK ambos · webhook sigue 500 |
| 08:00 | bisección tamaño POST → encontrado límite ~100-130KB | Confirmado: payloads >130KB rompen POST con 500 |
| 08:04 | POST `Pn7DahweauG5N7hC` con shell (CSS+JS vacíos) | OK · workflow nuevo creado |
| 08:06 | PUT sobre nuevo con contenido completo (CSS 23785 + JS 162110) | **OK · sin FK violation** (workflow fresh sin history corrupto) |
| 08:07 | activate nuevo | **HTTP 404** (bug n8n public API #21614 — no registra webhook) |
| 08:09 | unarchive (después de archive accidental) | Restaurado |
| 08:11 | sanity check: activate VIEJO + Dashboard VP + CS Queue Live | Los 3 OK 200 — pero **activé sin querer Dashboard VP y CS Queue Live** que estaban inactive → restaurado a inactive después |
| 08:13 | PUT nuevo con UUIDs como id + webhookId nuevo + path final cs-view + settings minimal | OK · viejo desactivado |
| 08:15 | usuario va a UI → save manual | **falla con "Version not found"** |

## Estado actual (2026-05-27 08:17 chile)

| Workflow | ID | active | Path webhook | Contenido | versionId | versionCounter |
|---|---|---|---|---|---|---|
| Viejo "CS View" | `kQmPeDgXA27mKQPj` | **False** ⚠️ | (none registered) | CSS+JS del Mac 4a5a0917 (deploy parcial) | adbbde4b-00d3-4320-9f41-a20b6c8f3c78 | 137 |
| **Nuevo "CS View v2"** | `Pn7DahweauG5N7hC` | **False** | `cs-view` (NO registered) | CSS 23785 + JS 162110 (local · 35 mesas) | bea36c1b-e220-421f-86a6-5c36a15c222d | 10 |
| CS Errores (errorWorkflow) | `o89xKbjT6mKkjAmN` | True | n/a | sin cambios | 75e07d8c-... | 163 (no toqué) |

## Snapshots de respaldo (rollback)

| Archivo | Contenido |
|---|---|
| `snapshots/20260527-081711-VIEJO-cs-view-kQmPeDgXA27mKQPj.json` | Workflow viejo completo (191KB) — estado pre-rollback |
| `snapshots/20260527-081711-NUEVO-v2-Pn7DahweauG5N7hC.json` | Workflow nuevo completo (195KB) — estado pre-rollback |
| `snapshots/20260527-081711-cs-errores-o89xKbjT6mKkjAmN.json` | errorWorkflow snapshot (sanity check, no se tocó) |

## Plan de rollback (si todo falla)

### Opción 1: Restaurar viejo al estado pre-mi-sesión (Mac 07:29)

```bash
# 1. Reactivar viejo (vuelve a estado activo de cuando cerró el Mac, AÚN devuelve 500)
set -a; source .env.credentials; set +a
curl -s -X POST -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "$N8N_API_URL/workflows/kQmPeDgXA27mKQPj/activate"
```

> [!warning] Esto NO arregla el webhook — sigue dando 500 como antes. Solo deja el workflow viejo en estado activo igual que cuando el Mac cerró. El panel queda igual de roto que estaba.

### Opción 2: Borrar nuevo + reactivar viejo

```bash
set -a; source .env.credentials; set +a
# Borrar Pn7DahweauG5N7hC
curl -s -X DELETE -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "$N8N_API_URL/workflows/Pn7DahweauG5N7hC"
# Reactivar kQmPeDgXA27mKQPj
curl -s -X POST -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "$N8N_API_URL/workflows/kQmPeDgXA27mKQPj/activate"
```

> [!warning] El panel sigue roto (500 del viejo). Pero el estado n8n queda igual que cuando cerró el Mac. Útil si se decide escalar a Aldo Carvajal en lugar de seguir intentando.

## Plan B' (POST shell + 1 ÚNICO PUT con todo, sin cascada de PUTs intermedios)

Lo que falló hoy fue la cascada de 4+ PUTs sobre el workflow nuevo (cambio webhookId, cambio ids, cambio name+path, etc.). Eso quizá dejó versions huérfanas en `workflow_version` que el "Publish" de la UI no puede resolver.

Mejor estrategia: en un solo POST + 1 PUT, dejar el workflow nuevo en su estado FINAL deseado (UUIDs correctos + path cs-view + nombre final + contenido completo). Sin tocar más.

```python
# Pseudocódigo:
# 1. POST workflow shell (CSS+JS vacíos, path TEMPORAL, UUIDs nuevos en id/webhookId)
# 2. PUT con cambios MÍNIMOS necesarios:
#    - css/js (contenido completo)
#    - path: cs-view (final)
#    NO cambiar nombre, NO cambiar ids, NO cambiar settings — todo lo final desde el POST
# 3. Usuario hace Save+Activate desde UI
```

## Causa raíz probable del FK violation

`FK_08d6c67b7f722b0039d9d5ed620` corresponde típicamente en n8n a un FK de `workflow_history` → `user` o `workflow_version` → `user`. Hipótesis: alguna fila del history del workflow viejo apunta a un `userId` que ya no existe (usuario removido del workspace), y eso bloquea cualquier insert nuevo en `workflow_history` cuando se hace PUT con cambios reales (n8n inserta una nueva fila cada vez).

**Solo el admin n8n (Aldo Carvajal) puede arreglar esto** con acceso directo a Postgres:
```sql
-- Identificar fila huérfana
SELECT * FROM workflow_history WHERE "userId" NOT IN (SELECT id FROM "user");
-- O bien borrar history del workflow problemático
DELETE FROM workflow_history WHERE "workflowId" = 'kQmPeDgXA27mKQPj';
```

## Próximos pasos sugeridos

1. **No tocar más el viejo** hasta confirmar con usuario que es ok descartar (preservar history para diagnóstico).
2. **Decidir con usuario**: opción B' (POST limpio sin cascada) vs camino A (escalar Aldo).
3. **Si B' falla también** → camino A definitivo.

## Cierre del incidente (2026-05-27 08:30 chile)

### Decisión del usuario y rollback puro

- Usuario optó por **rollback puro + escalar a Aldo**.
- Acciones de rollback (ejecutadas):
  1. `DELETE /workflows/Pn7DahweauG5N7hC` (workflow nuevo creado en B) → OK 200.
  2. `POST /workflows/kQmPeDgXA27mKQPj/activate` → **HTTP 404** (¡cambio respecto al inicio!).
  3. PUT minimal sobre viejo (versionCounter 139→140) + retry `/activate` → **HTTP 404 persistente**.
  4. Restauración de Dashboard VP + CS Queue Live a inactive (los activé por accidente 2 veces durante tests).

### Estado final n8n al cierre (~08:30 chile)

| Workflow | active | webhook |
|---|---|---|
| `kQmPeDgXA27mKQPj` "CS View" | **False** | path `cs-view` no registrado · `GET /webhook/cs-view` → **404** (antes era 500) · triggerCount=1 (config OK) pero handler runtime no lo registra |
| Otros workflows míos | sin cambios | sin afectación |

### Validación de "Version not found" en UI

Confirmado por el usuario: la UI también tira "Workflow could not be published / Version not found" al intentar publicar el viejo desde el toggle Active. **El bug no es solo de los workflows creados vía API — el viejo también lo tiene tras mis ops**. Ambos workflows están bloqueados a nivel BD.

### Conclusión final

- **El panel CS productivo está caído** y NO se puede recuperar sin intervención del admin n8n.
- **Único camino**: contactar a **Aldo Carvajal** con link a este `TIMELINE.md` + commit `ec05476e` para pedir:
  - Limpiar history huérfana del workflow `kQmPeDgXA27mKQPj` en Postgres.
  - O reset del worker n8n para purgar caché del handler.
  - Si nada de eso funciona, restaurar desde backup el workflow_entity.
- **Damage informe**:
  - Antes de mi sesión: panel caído (500). Workflow viejo en estado "FK violation persistente pero handler antes funcionaba parcialmente".
  - Después de mi sesión: panel caído (404). Workflow viejo en estado "no se puede /activate vía API, UI tira Version not found".
  - Net: cambio de 500 a 404, pero la causa raíz (FK violation en BD) es la misma. Ningún arreglo posible sin Aldo.

### Archivos del incidente (commits)

| Commit | Contenido |
|---|---|
| `ec05476e` | TIMELINE + snapshots JSON (vivos del cierre) + script migrate_v2 |
| `90ad4077` | RECIENTE.md actualizado con incidente + escalamiento |
| (este edit) | Cierre del TIMELINE con resultado del rollback |

---

## RESOLUCIÓN — 2026-05-27 12:49 chile (SES-20260527-1018 · workaround sin Aldo)

> [!success] Panel productivo VIVO con HEAD completo. Aldo NO intervino en BD. Workaround del usuario: duplicar el WF desde la UI (no API) + promover via PUT + Save+Activate manual.

### Por qué funcionó

- **Duplicar desde la UI** crea un `workflow_entity` fresh + history fresh, sin la fila huérfana que rompía el viejo. La API publica de n8n NO tiene endpoint `/workflows/{id}/copy` — solo la UI lo hace.
- El nuevo WF acepta PUT con cambios reales al contenido **sin tirar FK violation**, porque su history apunta solo a usuarios existentes.
- La activación tiene que ser por **UI**, no API, porque el [bug n8n #21614](https://github.com/n8n-io/n8n/issues/21614) no se ha solucionado en producción: `POST /workflows/{id}/activate` NO registra el webhook, solo `/rest/workflows` (endpoint interno UI) lo hace.

### Pasos efectivos

| Hora chile | Quién | Acción | Estado |
|---|---|---|---|
| 12:14 | usuario en UI | "Duplicate" sobre `kQmPeDgXA27mKQPj` → nace `qOIldhWyoeGMUa2p` con sufijo " copy" + path UUID auto | Duplicado fresh, sin contenido HEAD |
| 12:37 | Claude API | GET health webhook viejo → 404 "not registered" (`active=False`) → confirmado que devops/Aldo no actuó | — |
| 12:42 | Claude API | Sondeo: listar workflows → detectado el `qOIldhWyoeGMUa2p` recién creado por usuario | — |
| 12:45 | Claude API | PUT 1 (test inicial con todos los settings) → **HTTP 400** `must NOT have additional properties` (`availableInMCP`) | Schema strict |
| 12:46 | Claude API | PUT 2 con whitelist excluyendo `availableInMCP` → 400 (`binaryMode` también rechazado) | Schema strict |
| 12:48 | Claude API | Test incremental settings → confirmado: PUT rechaza `availableInMCP` Y `binaryMode`. Whitelist final = `{executionOrder, saveManualExecutions, saveExecutionProgress, errorWorkflow}` (+ otros opcionales) | Schema mapped |
| 12:49 | Claude API | PUT con whitelist + name="CS View - Presentacion del panel" + webhook.path="cs-view" + CSS+JS HEAD + version="mesa-mapping-completo" | **OK 200** sin FK violation |
| 12:50 | usuario en UI | Toggle Active en https://prod-low-code.iconstruye.dev/workflow/qOIldhWyoeGMUa2p → Save+Activate sin "Version not found" | active=True · triggerCount=1 · webhook registrado |
| 12:51 | Claude API | GET https://prod-low-code.iconstruye.dev/webhook/cs-view → **HTTP 200** · 192217 bytes · TTFB 370ms | Panel productivo VIVO con HEAD completo |
| 12:51 | Claude API | Markers HEAD presentes en HTML servido: `mesa-mapping-completo`, `MESA_BY_NUMBER` (35 mesas), `agents_did_not_answer` (KPI HEAD), `aircall_call_id` (Fase D), `cs-aircall` (IndexedDB) | Confirmado: panel sirve el código del repo HEAD, no el deploy parcial del Mac |

### Estado final n8n al cierre (12:51 chile)

| Workflow | ID | active | Path | Contenido | Comentario |
|---|---|---|---|---|---|
| **VIVO "CS View - Presentacion del panel"** | `qOIldhWyoeGMUa2p` | **True** | `cs-view` ✅ | CSS 23785 + JS 162110 + version `mesa-mapping-completo` (35 mesas mapping completo + KPI agents_did_not_answer + Fase D cross-link Aircall↔Zendesk + IndexedDB persistente) | Productivo |
| Viejo "CS View - Presentacion del panel" | `kQmPeDgXA27mKQPj` | False | `cs-view` (mismo path, pero `active=False` → no compite en runtime) | Deploy parcial 22 mesas (Mac 4a5a0917) · FK violation persistente en BD | **No tocar** — esperar limpieza Aldo o archivar después |

### Cambios al repo

- `outputs/cs-panel/scripts/deploy_cs_view.py`:
  - `WF_ID = "qOIldhWyoeGMUa2p"` (era `kQmPeDgXA27mKQPj`).
  - Agregado `SETTINGS_WHITELIST` para evitar 400 "must NOT have additional properties" en futuros deploys.
- `outputs/cs-panel/incident-2026-05-27/promote_v2_to_prod.py`: nuevo script del workaround (idempotente, commit del workaround para trazabilidad).

### Aprendizajes para futuros incidentes

1. **n8n API publica NO copia workflows** (no hay `POST /workflows/{id}/copy`). Para clonar limpio, **abrir UI y usar Duplicate**. Sin eso, intentar reconstruir via POST limpio puede fallar por bug #21614 + límite de payload ~130KB.
2. **El endpoint PUT de n8n tiene schema strict** sobre `settings`. El GET retorna campos que el PUT rechaza (`availableInMCP`, `binaryMode` confirmados). Whitelist obligatorio:
   ```python
   {"executionOrder", "saveManualExecutions", "saveExecutionProgress",
    "saveDataErrorExecution", "saveDataSuccessExecution",
    "executionTimeout", "timezone", "errorWorkflow"}
   ```
3. **Activación final SIEMPRE por UI** después de PUT vía API. Bug #21614 sigue vivo en producción 2026-05.
4. **Cuando un WF tiene FK violation persistente**: NO insistir desde API. Pedir al usuario que duplique en UI y promover el duplicado. Más rápido que esperar a Aldo.

### Cleanup pendiente

- Cuando Aldo limpie la FK del viejo en Postgres: decidir si archivar `kQmPeDgXA27mKQPj` (recomendado) o si volver a apuntar el productivo al ID original (no necesario — el panel funciona idéntico apuntando al nuevo).
- Si se borra el viejo: actualizar `outputs/cs-panel/incident-2026-05-27/snapshots/` quitando el JSON viejo de los snapshots vivos.
