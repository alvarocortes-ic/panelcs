# Plan — Tab nuevo "Análisis x Cliente" (CS Panel)

> Plan ejecutable por modelo Sonnet/Haiku. Lectura previa obligatoria:
> `outputs/cs-panel/README.md` (arquitectura) + `outputs/cs-panel/MEJORAS.md` (historial Fase A/B/C).
>
> **Autor del plan**: Claude Opus 4.7 (1M) · 2026-05-20 · sesión SES-20260520-0831 (W11).

---

## 0. TL;DR

- Tab nuevo `'org'` ("Análisis x Cliente") en `cs-view.render.js`. **Cero cambios al backend** en la versión base.
- Filtro principal = `organization_id` (la "empresa afectada" YA está en el seed como `data.tickets[*].organization_id` + `data.orgs_by_id`). No requiere traer datos nuevos de Zendesk en la versión base.
- Todas las métricas se calculan client-side sobre los 35.959 tickets ya cacheados en IndexedDB.
- 3 fases acotadas: **A1 mínimo viable** (filtro + KPIs + 2 tablas) → **A2 visualizaciones + comparativa vs panel** → **A3 recurrencia / top keywords subject**. Cada fase es deployable sola.
- Mapa de palabras: **se hace sin librería externa** usando barras horizontales de Chart.js (sin reenviar `index.html`). Si se prefiere visual de nube real, requiere agregar `wordcloud2.js` por CDN al loader → 1 reenvío del HTML.

---

## 1. Decisión clave — "empresa afectada"

> [!important] Esto es lo primero a confirmar con Alvaro antes de ejecutar.

El seed actual ya trae `organization_id` por ticket + `orgs_by_id` con el nombre. **Esa es la empresa del ticket en Zendesk** (la organización del requester).

| Opción | Implica | Backend |
|---|---|---|
| **A — usar `organization_id`** (recomendada) | El filtro es por organización Zendesk. 95%+ de cobertura esperada (un ticket sin org es minoría) | Cero cambios |
| **B — custom field "Empresa afectada"** | Si existe un custom field distinto (ej. para tickets internos donde un usuario @iconstruye reporta sobre un cliente externo) | Agregar `cf_empresa_afectada` al slim de `carga_inicial.py` + `cs-data` + regenerar seed (~25-30 min) |

**Recomendación**: arrancar con A. Si tras ver el tab Alvaro identifica casos donde el dato no calza (ticket interno → org propia en vez del cliente afectado), abrir un sub-plan para B.

**Pregunta para Alvaro antes de ejecutar**: ¿existe en Zendesk un custom field específico de "Empresa afectada" que necesitemos consolidar? Si no estás seguro, ejecutamos A y validamos con los primeros casos.

---

## 2. Alcance

### Qué SÍ entra en este plan

- Tab nuevo `org` con identificador "Análisis x Cliente" en la barra de tabs (después de "Análisis").
- Selector único de cliente (combobox con autocomplete sobre `orgs_by_id`, ordenado por volumen 2026).
- KPIs del cliente seleccionado: volumen total, activos, % SLA cumplido, FRT mediano, resolución mediana, reaperturas, CSAT, % escalado SN2.
- Tabla de tickets activos del cliente (con todas las columnas del modal — reordenables).
- Tabla histórica del cliente (resueltos + cerrados) con paginación / scroll.
- Top 10 tickets más lentos en respuesta (mayor `frt_min`) — solo resueltos.
- Top 10 tickets fuera de SLA — todos los `sla_breached === true`.
- Distribución por categoría / producto / línea de negocio (Pareto).
- Distribución por ejecutivo (qué SN1/SN2 atendió al cliente y cuánto).
- Comparativa cliente vs promedio del panel (banderas "sobre promedio" / "bajo promedio").
- Línea temporal mensual de ingresos vs resueltos (Chart.js).
- Top keywords del subject (Chart.js barras horizontales, con stop words ES).

### Qué NO entra

- Mapa de palabras visual (nube real con tamaños proporcionales): opcional Fase A3 alternativa — requiere reenviar `index.html`.
- NLP sobre descripción + comentarios del ticket (el seed solo trae `subject`): requiere endpoint nuevo en n8n.
- Comparativa cliente vs otro cliente (multi-select).
- Exportar Excel/CSV específico del cliente (extensión del botón "Exportar" actual — fuera del scope inicial).
- Reordenar/persistir un orden custom de clientes favoritos (nice-to-have post-deploy).

---

## 3. Arquitectura del cambio

```
outputs/cs-panel/n8n/
  cs-view.render.js     ← TODO el cambio vive acá (~250 líneas nuevas)
  cs-view.styles.css    ← +15 líneas (selector cliente, layout, comparativa pills)
```

**Nada más se toca**. `index.html` queda intacto (no reenvío). `carga_inicial.py` queda intacto (no regen). `cs-data` queda intacto (no reconfig n8n).

Deploy: `python outputs/cs-panel/scripts/deploy_cs_view.py` → usuario aprieta F5.

---

## 4. Helpers y datos disponibles (ya en el render)

Todos estos son **reutilizables tal cual** desde el código del nuevo tab:

### Estado UI persistido
- `S.tab` — agregar valor `'org'`
- `S.org` — id de la empresa seleccionada (nuevo)
- `S.orgTab` — sub-tab interna (`'resumen'` / `'activos'` / `'historico'` / `'analisis'`) (nuevo)

### Datos
- `T` = `data.tickets[]`
- `OR` = `data.orgs_by_id` — mapa `{id: nombre}`
- `AG` = `data.agents_by_id`
- `GR` = `data.groups_by_id`

### Helpers
| Helper | Uso |
|---|---|
| `applyFilters(T)` | universo respetando filtros globales equipo+tipo |
| `solvedMs(t)` / `salidaMs(t)` / `ms(s)` | timestamps |
| `fmtMin(m)` / `relTime(iso)` / `fmtDate(d)` | formato |
| `orgName(id)` / `agentName(id)` / `groupName(id)` | lookups |
| `kpiCard(value, label, sub, color, subClass)` | KPI card consistente |
| `chartCard(title, canvasId, height)` | wrapper canvas |
| `mkChart(id, cfg)` | Chart.js con cleanup automático |
| `comboFlujoChart(id, buckets, conBolsa, ejeY)` | combo Ingresos/Atendidos/Cerrados/Bolsa |
| `flujoBuckets(universe, buckets)` / `bucketsHora` / `diasHabilesEntre` / `bucketKey` | series temporales |
| `slaPill(v)` / `prioPill(p)` | pills de estado |
| `COL_DEFS` + `colOrder()` + `visibleCols()` | columnas del modal — reutilizables para tablas del tab |
| `triage(subj)` / `inferType(subj)` | derivados del subject |
| `EXCL_EJEC` | ejecutivos excluidos de rankings (Alberto Mercado, Edgar Bonomie, Karina Salinas) |

### Constantes
- `ACTIVE = { new:1, open:1, pending:1, hold:1 }`
- Paleta iC: `#0047BB` azul · `#17A24F` verde · `#FF6A00` naranjo · `#BB1A1A` rojo · `#CE8B00` ámbar · `#425563` gris medio · `#6B4FBB` violeta · `#2D7FF9` azul brillante

### Lo que NO existe (lo creo en este plan)

- Función `orgUniverse(orgId)` → tickets del cliente respetando filtros globales (equipo+tipo)
- Función `orgKPIs(universe, orgId)` → todos los KPIs del resumen
- Función `orgRecurrence(universe)` → agrupa subjects similares (algoritmo simple: prefijo + bigrama)
- Función `tokenizeSubject(text)` → tokeniza + filtra stop words ES + bigramas
- Función `panelBaseline()` → métricas promedio del panel (para comparar el cliente)
- Función `buildOrg()` (render del tab) + `drawOrgCharts()`

---

## 5. Layout propuesto (mockup ASCII)

```
┌─────────────────────────────────────────────────────────────────────┐
│ Header sticky: brand · stats · Actualizar · Re-cachear · Exportar   │
├─────────────────────────────────────────────────────────────────────┤
│ En vivo │ Análisis semanal │ Análisis │ ►Análisis x Cliente◄         │ ← tab nuevo
├─────────────────────────────────────────────────────────────────────┤
│ Cliente: [   selector con autocomplete   ▼]  Equipo: [▼]  Tipo: [▼] │
├─────────────────────────────────────────────────────────────────────┤
│ ┌─ Cabecera del cliente ────────────────────────────────────────┐   │
│ │ ECOLOGICA SOLUCIONES TIA SPA                                  │   │
│ │ 487 tickets 2026 · 12 activos · primer ticket: 2024-08 ·      │   │
│ │ último ticket: 2026-05-20 · 6 ejecutivos atendiendo           │   │
│ └───────────────────────────────────────────────────────────────┘   │
│                                                                       │
│ ┌── KPIs del cliente (sobre 2026) ────────────────────────────────┐ │
│ │ [Total] [Activos] [% SLA] [FRT med] [Res med] [Reapert] [CSAT]  │ │
│ │   487      12      87%     1.2 h      8.4 h    4.1%      91%    │ │
│ │ vs panel: −2%    ↓bajo  ↓bajo   alto↑   bajo↓     alto↑         │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│ ┌── Escalamientos del cliente ────────────────────────────────────┐ │
│ │ [Pasaron SN1] [→ SN2] [→ MO] [Devoluciones SN2→SN1]              │ │
│ │     201       18%      4%        3 rebotes                       │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│ ┌── Tendencia mensual ─────────────────────────────────────────────┐ │
│ │ Combo: Ingresos · Atendidos · Bolsa al cierre del mes            │ │
│ │ (Chart.js comboFlujoChart, granularidad mes)                     │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│ ┌── Distribución por categoría ──┐  ┌── Por producto ──────────────┐ │
│ │ Bar horizontal (Pareto)        │  │ Bar horizontal (Pareto)      │ │
│ └────────────────────────────────┘  └──────────────────────────────┘ │
│                                                                       │
│ ┌── Ejecutivos del cliente ─────────────────────────────────────────┐ │
│ │ Tabla: nombre · equipo · tickets · resueltos · % SLA · FRT med    │ │
│ └───────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│ ┌── Top keywords del subject (top 20) ──────────────────────────────┐ │
│ │ Bar horizontal con frecuencia · stop words ES filtradas           │ │
│ └───────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│ ┌── Tickets activos del cliente ────────────────────────────────────┐ │
│ │ Tabla COL_DEFS reordenable · 12 filas                              │ │
│ └───────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│ ┌── Top 10 más lentos en 1ª respuesta ─────────────────────────────┐ │
│ │ Tabla: #ID · Asunto · FRT · Ejecutivo · Apertura · SLA           │ │
│ └───────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│ ┌── Top 10 fuera de SLA (activos primero) ─────────────────────────┐ │
│ │ Tabla: #ID · Asunto · Vencido hace · Ejecutivo · Estado          │ │
│ └───────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│ ┌── Recurrencia detectada (Fase A3) ───────────────────────────────┐ │
│ │ 8 tickets con subject similar a "Error pago contado SAP"          │ │
│ │ 5 tickets con subject similar a "FC sin integrar"                 │ │
│ │ ... (top 5 grupos por tamaño)                                     │ │
│ └───────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│ ┌── Histórico completo ────────────────────────────────────────────┐ │
│ │ Tabla paginada (50/página) con COL_DEFS reordenable               │ │
│ └───────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

Estado vacío (sin cliente seleccionado): banner instructivo + Top 20 clientes por volumen 2026 como tabla clickeable que selecciona el cliente.

---

## 6. Fases

### Fase A1 — Mínimo viable (estimado: 2-3 h Sonnet)

> Goal: selector + KPIs + 2 tablas (activos + histórico). El tab ya es útil.

| # | Tarea | Archivo | Detalle |
|---|---|---|---|
| 1 | Agregar tab `'org'` al estado | `cs-view.render.js` | Línea 31: `S.tab = S.tab || 'live'` queda igual; agregar `if (S.org == null) S.org = '';` y `S.orgTab = S.orgTab || 'resumen';` |
| 2 | Sumar tab al renderizador de tabs | `cs-view.render.js` línea 429 | `tb('ana','Análisis') + tb('org','Análisis x Cliente')` |
| 3 | Sumar control en filter bar para `S.tab === 'org'` | `cs-view.render.js` línea ~507 | Crear `orgFilterControls()` — selector combobox con `<datalist>` para autocomplete sobre `Object.keys(OR)` ordenado por volumen 2026 |
| 4 | Función `orgUniverse(orgId)` | nueva | `return applyFilters(T).filter(t => String(t.organization_id || 0) === String(orgId));` |
| 5 | Función `orgKPIs(universe)` | nueva | Calcula: total, activos, % SLA cumplido (sobre evaluados), FRT mediana, resolución mediana, % reapertura, CSAT %, primer ticket, último ticket, ejecutivos únicos |
| 6 | Función `buildOrg()` | nueva | Renderiza cabecera + KPIs (k7) + Escalamientos (k4) + tabla activos (reusa estilo modal) + tabla más lentos (top 10) + tabla fuera SLA (top 10) |
| 7 | Estado vacío + Top 20 clientes 2026 clickeable | dentro de `buildOrg()` | Si `!S.org`: instructivo + tabla top 20 clickeable; click sobre fila → `S.org = id; saveState(); repaint();` |
| 8 | Switch en `repaint()` y `drawCharts()` | `cs-view.render.js` líneas 1297-1307 | `else if (S.tab === 'org') drawOrgCharts();` y `(S.tab === 'org') ? buildOrg() :` |
| 9 | CSS del selector + cabecera | `cs-view.styles.css` | `.cs-org-search`, `.cs-org-head`, `.cs-empty-org` — paleta consistente |
| 10 | Deploy + F5 | `scripts/deploy_cs_view.py` | después de `node --check` |

**Criterio de aceptación A1**:
- Click en tab → barra de filtros muestra "Cliente" con autocomplete.
- Sin cliente: tabla top 20 clientes ordenados por volumen 2026.
- Con cliente seleccionado: 7 KPIs + 4 KPIs escalamientos + tablas (activos + más lentos + fuera SLA).
- Cambiar de cliente actualiza todo el contenido. Persistencia en localStorage.
- Filtros globales (Equipo, Tipo) se aplican también al universo del cliente.

### Fase A2 — Visualizaciones y comparativa (estimado: 1.5-2 h Sonnet)

| # | Tarea | Detalle |
|---|---|---|
| 1 | `panelBaseline()` | Calcula sobre TODO `applyFilters(T)`: media de %SLA, FRT med, resolución med, reapertura, CSAT. Cachea por `tab+filter` mientras no cambia. |
| 2 | KPI comparativas | Sub-string del kpiCard: `↑/↓ N pts vs panel` con clase `up`/`down` (paleta verde/rojo). Verde si el cliente es mejor; rojo si es peor. Cuidado con métricas inversas (reapertura, % escalado a SN2/MO — más bajo es mejor). |
| 3 | Chart "Ingresos vs Atendidos vs Bolsa mensual" | `comboFlujoChart('cOrgFlujo', buckets, true, 'Tickets / mes')` con buckets mensuales (12 meses, hasta ahora). Reutilizar `bucketKey(iso,'month')`. |
| 4 | Chart "Distribución por categoría" (Pareto) | Igual al de tab Análisis: bar horizontal, ≥1%, "Otras (N)" agrupado. |
| 5 | Chart "Distribución por producto" (Pareto) | Idéntico al anterior pero sobre `t.producto`. |
| 6 | Tabla "Ejecutivos del cliente" | name · equipo · tickets · resueltos · % SLA · FRT med. Excluir `EXCL_EJEC`. |
| 7 | Histograma "Tiempos de resolución" | Bar chart con buckets `[<1h, 1-4h, 4-24h, 1-3d, 3-7d, 7-30d, >30d]` sobre `t.solved_at - t.created_at` de los resueltos. |
| 8 | Línea de tendencia "% SLA por mes" | Chart línea sobre los últimos 12 meses. |
| 9 | Deploy + F5 | — |

**Criterio de aceptación A2**:
- 5 charts nuevos renderizan correctamente en `drawOrgCharts()`.
- Comparativa vs panel muestra `+N pts` o `-N pts` con color correcto (mejor=verde / peor=rojo).
- Sin errores en consola del navegador.
- Funciona en modo claro y oscuro (paleta CSS variables).

### Fase A3 — Recurrencia + Top keywords (estimado: 2 h Sonnet)

| # | Tarea | Detalle |
|---|---|---|
| 1 | `STOP_WORDS_ES` constante | Lista de stop words español + tokens basura tipo `nro`, `oc`, `fc` que aparecen como prefijos no informativos. ~150 palabras. |
| 2 | `tokenizeSubject(text)` | Lowercase, strip diacríticos (opcional), split por non-alphanum, len≥3, no en STOP_WORDS_ES. Devuelve `[tokens]`. |
| 3 | Chart "Top 20 keywords del subject" | Acumular tokens sobre los subjects del cliente → top 20 → bar horizontal Chart.js. Cuidado: bigramas opcionales en una segunda iteración. |
| 4 | `orgRecurrence(universe)` | Algoritmo simple: para cada ticket, tokenizar subject; agrupar tickets cuyo top-3 keywords coincide en al menos 2; devolver grupos con tamaño ≥3. Listar top 5 grupos. |
| 5 | Componente "Recurrencia detectada" | Lista de grupos como tarjetas: "8 tickets parecidos sobre 'pago contado SAP'" — click expande la lista de IDs. |
| 6 | Modal histórico paginado | Si el cliente tiene >50 tickets, paginación de la tabla histórica (50/página, navegación simple). |
| 7 | Deploy + F5 | — |

**Criterio de aceptación A3**:
- Top 20 keywords ordenado por frecuencia descendente.
- Stop words bien filtradas (no aparece "que", "de", "el", "para", "con").
- Grupos de recurrencia con al menos 3 tickets cada uno y top-3 keywords con 2+ coincidencias.
- Cliente con >50 tickets en histórico → paginación funcional.

### Fase B (opcional) — Word cloud visual real

> Solo si Alvaro insiste en la visualización tipo nube en vez de barras. Costo: reenviar `index.html`.

1. Agregar `<script src="https://cdn.jsdelivr.net/npm/wordcloud@1.2.2/src/wordcloud2.min.js">` al `<head>` de `index.html`.
2. En `drawOrgCharts()`: reemplazar el bar chart de keywords por `WordCloud(canvasEl, { list: tokensWithCounts, ... })`.
3. Reenviar `index.html` a los usuarios (VP, Head of CS) — único archivo, doble-click.

**Recomendación**: no hacerlo. Las barras horizontales con número exacto son más útiles operativamente que una nube estética. El word cloud se ve bonito pero pierde precisión.

### Fase C (futura, NO incluida en esta entrega) — NLP sobre descripción + comments

Requiere endpoint nuevo en n8n que devuelva descripción + comments por ticket id. Mucho más pesado (50-100 KB por ticket × N tickets del cliente). Solo viable si se hace bajo demanda (1 ticket a la vez al expandir) o si se almacena un resumen pre-procesado en el backend. **Out of scope de este plan**.

---

## 7. Tareas detalladas — orden de ejecución para Sonnet/Haiku

> Cada fase deployable sola. Después de cada fase, validar con `node --check` + preview local (`build_preview.py`) antes de tocar n8n.

### Fase A1 — orden exacto

```
1. Read outputs/cs-panel/n8n/cs-view.render.js (líneas 27-40)  → entender estado UI
2. Edit cs-view.render.js (estado):
   - Después de `if (typeof S.workdays !== 'boolean') S.workdays = false;`
   - Agregar:
     if (S.org == null) S.org = '';
     S.orgTab = S.orgTab || 'resumen';
3. Edit cs-view.render.js línea 429 (buildTabs):
   - Cambiar `tb('ana','Análisis') + '</div>'`
   - Por:    `tb('ana','Análisis') + tb('org','Análisis x Cliente') + '</div>'`
4. Agregar al final del bloque "controles propios" (después de weekFilterControls):
   - Función orgFilterControls() — devuelve fld('Cliente', <input list>) con datalist
5. Edit buildFilterBar() línea 507:
   - Agregar `if (S.tab === 'org')  html += orgFilterControls();`
6. Agregar bloque CALCULOS — TAB ANALISIS X CLIENTE (después del tab ANALISIS):
   - orgUniverse(orgId)
   - orgKPIs(universe)
7. Agregar bloque ---- TAB ANALISIS X CLIENTE ---- (después de buildAna):
   - topClientes2026() — top 20 por volumen 2026 para el estado vacío
   - buildOrg() — render principal del tab
8. Edit repaint() línea 1307:
   - `(S.tab === 'live') ? buildLive() : (S.tab === 'week') ? buildWeek() : (S.tab === 'org') ? buildOrg() : buildAna()`
9. Edit drawCharts() línea 1297:
   - `else if (S.tab === 'org') drawOrgCharts();`
10. Stub vacío drawOrgCharts() — `function drawOrgCharts(){}` (se rellena en A2)
11. Edit cs-view.styles.css — agregar bloque /* ---- tab analisis x cliente ---- */:
    - .cs-org-search { ... }
    - .cs-org-head { ... }
    - .cs-org-empty { ... }
12. Validar: node --check outputs/cs-panel/n8n/cs-view.render.js
13. Preview local: python outputs/cs-panel/scripts/build_preview.py → abrir preview-panel.html
14. **PEDIR AUTORIZACIÓN ALVARO** antes de deploy a n8n
15. Deploy: source .env.credentials; python outputs/cs-panel/scripts/deploy_cs_view.py
16. Git commit con mensaje: "feat(cs-panel): tab Análisis x Cliente — fase A1 (selector + KPIs + activos)"
```

### Fase A2 — orden exacto

```
1. Agregar panelBaseline() cacheado en una variable módulo-local
2. Modificar kpiCard del tab org para sumar `vs panel: X` como subClass
3. Definir 5 chartCards en buildOrg() — cOrgFlujo · cOrgCat · cOrgProd · cOrgHist · cOrgSlaMes
4. Implementar drawOrgCharts() — 5 mkChart() calls
5. Tabla "Ejecutivos del cliente" — reutilizar patrón de tab live
6. node --check + preview + deploy + commit
```

### Fase A3 — orden exacto

```
1. Agregar STOP_WORDS_ES (constante con ~150 palabras)
2. Implementar tokenizeSubject(text)
3. Top 20 keywords como bar horizontal — cKwOrg en drawOrgCharts()
4. Implementar orgRecurrence(universe) — algoritmo top-3 keywords con 2+ coincidencias
5. Componente "Recurrencia detectada" en buildOrg() — lista expandible
6. Paginación de la tabla histórica si >50 tickets
7. node --check + preview + deploy + commit
```

---

## 8. Criterios de aceptación globales

- Cero errores en consola del navegador.
- Cambiar de cliente y volver al mismo → restablece exactamente la misma vista.
- Funciona en modo claro y oscuro.
- Filtros globales (Equipo + Tipo) afectan el universo del cliente.
- Persistencia `S.org` y `S.orgTab` en localStorage entre F5.
- Performance: render < 500ms para clientes con hasta 500 tickets (el top cliente de 2026 probablemente tiene ~600 max).
- No mete charts huérfanos al cambiar de tab (cleanup de `CHARTS[]` via `destroyCharts()` ya está).

---

## 9. Preguntas a confirmar con Alvaro ANTES de ejecutar

> Si la sesión de ejecución es **/auto** (Sonnet sin parar a preguntar), Sonnet ASUME las respuestas marcadas **(default)** abajo y declara cada SUPUESTO en el commit message.

| # | Pregunta | Default si /auto |
|---|---|---|
| 1 | "Empresa afectada" = `organization_id` (opción A)? ¿O hay custom field específico (opción B)? | A — usar `organization_id` |
| 2 | Tab nombre exacto: "Análisis x Cliente" / "Por Cliente" / "Cliente" | "Análisis x Cliente" |
| 3 | Orden del tab en la barra: ¿al final (después de Análisis) o intercalado? | Al final |
| 4 | Word cloud: barras horizontales (sin reenvío HTML) o nube visual (reenvío) | Barras horizontales |
| 5 | Paginación histórico: 50/página o sin paginar (tabla larga con scroll)? | 50/página si N>50 |
| 6 | Comparativa vs panel: ¿se compara con TODO el panel o con clientes del mismo equipo/tipo (filtros globales)? | Con TODO el panel (más estable) |
| 7 | Bigramas en keywords (top 20): solo unigramas (más rápido) o ambos? | Unigramas en A3, bigramas en iteración futura |
| 8 | Para el top "más lentos en respuesta": ordenar por `frt_min` (todos los resueltos con FRT) o por antigüedad de SLA vencido? | Dos tablas separadas (top 10 FRT más alto + top 10 SLA vencido más antiguo) |

---

## 10. Riesgos y cómo mitigarlos

| Riesgo | Mitigación |
|---|---|
| `organization_id` null para un % no trivial de tickets | Mostrar contador "Tickets sin organización: N" en el estado vacío. Si N>5% del panel, escalar a Opción B (custom field). |
| Cliente con muy pocos tickets (1-2) → KPIs ruidosos | Comparativa vs panel oculta si N<5. Mostrar "muestra pequeña" en sub-label. |
| Cliente con cientos de tickets → render lento del histórico | Paginación 50/página + lazy del histórico (solo monta cuando se hace click "ver histórico completo"). |
| Tokenizer mata palabras técnicas valiosas (ej. "SAP", "DTE") | Stop words MANUAL (no automática). Curar la lista por iteración. |
| Diacríticos rompen el match (`facturación` vs `facturacion`) | Normalizar con `.normalize('NFD').replace(/[̀-ͯ]/g, '')` antes de tokenizar. |
| Cambio de cliente con `S.tab='org'` no limpia charts viejos | `destroyCharts()` se llama en `repaint()` siempre — verificado. |

---

## 11. Cómo retomar el plan

Si la sesión de ejecución se interrumpe:

1. `git log --oneline` → identificar la última fase deployada (commit message lo dice).
2. Leer este archivo de nuevo.
3. Saltar a la sección "Tareas detalladas — orden de ejecución" de la fase incompleta.
4. Validar con `node --check` el estado actual del archivo antes de continuar editando.

---

## 12. Cross-references

- README del proyecto: `outputs/cs-panel/README.md`
- Backlog histórico: `outputs/cs-panel/MEJORAS.md`
- Ficha vault: `ICClaudeVault/proyectos/cs-panel.md`
- Reglas formato informes: `.claude/rules/format-rules.md`
- Reglas Comunicación con Alvaro: `.claude/rules/communication-rules.md`

---

**Fin del plan.** Listo para ejecutar con Sonnet/Haiku — empezar por Fase A1.
