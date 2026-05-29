# Design — Fase B: Selector canal global + cards etiquetadas

> [!danger] OBSOLETO desde 2026-05-28 (SES-20260528-0844 / TODO 1 re-encuadre canales)
> Este diseño quedó superado por el **re-encuadre conceptual** documentado en
> [[TODO-RE-ENCUADRE-CANALES.md]] (cerrado 2026-05-27 SES-20260527-1700).
>
> Cambios clave respecto a este doc:
> - El filtro `zd` **NO** es "Zendesk (correo)" — pasa a ser **universo total de tickets Zendesk** (todos los canales). Resuelve el reporte "los números de Zendesk no calzan" (filtraba 41% del universo).
> - Selector renombrado a: `Todos · Zendesk · Teléfono (Aircall) · Chat (Wotnot)`.
> - Correo / Whatsapp / Otros eliminados del modelo (sin métrica propia / volumen anecdótico / cero tickets).
> - Nueva vista "Todos los canales" hero ejecutiva (KPI hero · tendencia multistream · donut · tabla resumen) — TODO 2.
> - Nueva columna "Canal" en tablas de vista Zendesk — TODO 3.
> - KPI "% conversión Aircall→Zendesk" en vista Aircall — TODO 4.
>
> **Conservado de este doc**: estructura del selector como elemento global a la izquierda de los tabs, mutación de tabs según selector, badge global del canal activo. La implementación del Fase B en `cs-view.render.js` quedó productiva al 2026-05-27; el re-encuadre del 2026-05-28 cambia semántica + labels sin tocar la arquitectura.

> Estado original: borrador previo a implementación. Para discutir con Alvaro tras validar Fase A.
> Fuente de decisiones: SES-20260526-1120, turno 2 de la conversación arquitectónica.

## Objetivos

1. Selector dropdown **a la izquierda de los tabs actuales** con: `Todos los canales` · `Zendesk (correo)` · `Aircall (llamadas)` · `WotNot (chat)`.
2. Los tabs actuales (`En vivo`, `Análisis semanal`, `Análisis`, `Clientes`) **mutan según el selector** — no se crea tab nuevo.
3. Cada card muestra **a qué canal refiere** (badge/etiqueta).
4. Slim Zendesk se extiende con `chat_subtype` (de `via.source.rel`) para drill Sodexo/SN1/ended/missed cuando el filtro está en WotNot.
5. Loader `index.html` extendido para bajar `aircall-seed` + `aircall-data` además del Zendesk.

## Mapping canal por fuente y campo del slim

| Canal UI | Fuente | Filtro shape del slim |
|---|---|---|
| Zendesk (correo) | cs-seed (slim_ticket) | `canal_normalizado === 'Correo'` |
| Aircall (llamadas) | aircall-seed (slim_call) — fuente nueva en data.calls | toda la lista, sin filtro |
| WotNot (chat) | cs-seed (slim_ticket) | `canal_normalizado === 'Chat'` |
| Todos los canales | Unión cross | render combina tickets + calls |

> Nota: hay tickets `canal_normalizado === 'Teléfono'` (12.044) que vienen de Aircall vía Zendesk webhook (`via.channel='api'`). Para el filtro **Aircall** primamos la fuente Aircall real; para **Zendesk (correo)** los `Teléfono` no aplican. Cross-link cubre Fase D.

## Cambios concretos por archivo

### 1. `outputs/cs-panel/scripts/carga_inicial.py` + `cs-build.py`

Extender `slim_ticket()` con:

```python
"chat_subtype": ((t.get("via") or {}).get("source") or {}).get("rel") or None,
# valores esperados: zopim_chat_ended | zopim_chat_missed | chat_sodexo | chat_sn1 | None
```

Si Fase A está validada, basta editar `slim_ticket` → correr `cs-build.py` (30s) → publicar. No requiere refetch.

### 2. `outputs/cs-panel/index.html` (loader)

Agregar fetch paralelo de `aircall-seed`:

```javascript
async function bajarSeedAircall() {
  const r = await fetch(WH + '/aircall-seed?t=' + Date.now(), { cache:'no-store' });
  if (!r.ok) throw new Error('aircall-seed HTTP ' + r.status);
  const j = await r.json();
  const seed = JSON.parse(await gunzipB64(j.gz));
  CALLS = seed.calls || [];  // store global, similar a T
  localStorage.setItem(LS.cursorAircall, ...);
}
```

Y modificar el dispatch a `render(data, ctx)`:

```javascript
const data = {
  tickets: T,
  calls: CALLS,                     // ← nuevo
  agents_by_id, groups_by_id, orgs_by_id, meta
};
```

### 3. `outputs/cs-panel/n8n/cs-view.render.js`

#### 3.a Estructura del selector

Reemplazar `buildTabs()`:

```javascript
function buildChannelSelect(){
  var options = [
    { id:'all',   label:'Todos los canales' },
    { id:'zd',    label:'Zendesk (correo)' },
    { id:'ac',    label:'Aircall (llamadas)' },
    { id:'wn',    label:'WotNot (chat)' }
  ];
  var opts = options.map(o =>
    '<option value="'+o.id+'"'+(S.channel===o.id?' selected':'')+'>'+o.label+'</option>'
  ).join('');
  return '<select class="cs-channel" id="csChannel">'+opts+'</select>';
}

function buildTabs(){
  // ... lógica existente ...
  return '<div class="cs-toolbar">' +
    buildChannelSelect() +
    '<div class="cs-tabs">' + ...tabs... + '</div>' +
  '</div>';
}
```

Default state: `S.channel = S.channel || 'all'`.

#### 3.b Universo filtrado por canal

Función central que aplica el filtro a cualquier consumer:

```javascript
function ticketsByChannel(){
  if (S.channel === 'all' || S.channel === 'zd') return T.filter(t => t.canal_normalizado === 'Correo');
  if (S.channel === 'wn') return T.filter(t => t.canal_normalizado === 'Chat');
  if (S.channel === 'ac') return [];  // Aircall vive en CALLS, no en tickets
  return T;
}

function callsByChannel(){
  if (S.channel === 'all' || S.channel === 'ac') return data.calls || [];
  return [];
}
```

#### 3.c Cards etiquetadas

Cada card existente recibe un badge:

```javascript
function channelBadge(ch){
  var map = { zd:'CORREO', ac:'LLAMADAS', wn:'CHAT', mixed:'MULTI' };
  return '<span class="cs-badge cs-badge-'+ch+'">'+map[ch]+'</span>';
}
```

Y se inserta en el header de cada card de KPI/tabla/chart.

#### 3.d Render condicional Aircall

Cuando `S.channel === 'ac'` o `'all'`, agregar secciones Aircall en cada tab donde aplica:

- **En Vivo**: KPIs Aircall del día (calls, % atendido, FRT mediana) + heatmap hora/día + ranking IVRs del día + ranking agentes
- **Análisis Semanal**: distribución calls por día · FRT mediana semanal · razones pérdida
- **Análisis**: histograma duración · % grabación · voicemail rate · evolución mensual
- **Clientes**: cuando hay cross-link Aircall↔Zendesk (Fase D), drill desde org a sus calls

### 4. `outputs/cs-panel/n8n/cs-view.styles.css`

```css
.cs-toolbar { display:flex; gap:12px; align-items:center; }
.cs-channel {
  background: var(--bg-2); color: var(--fg);
  border: 1px solid var(--border); border-radius: 6px;
  padding: 6px 10px; font-size: 13px;
}
.cs-badge {
  display:inline-block; padding:2px 8px; border-radius:10px;
  font-size:10px; font-weight:600; letter-spacing:0.5px;
  margin-left: 8px; vertical-align: middle;
}
.cs-badge-zd { background:#1e40af; color:white; }
.cs-badge-ac { background:#16a34a; color:white; }
.cs-badge-wn { background:#a16207; color:white; }
.cs-badge-mixed { background:#7c3aed; color:white; }
```

## Hipótesis técnicas a validar antes/durante la implementación

1. **`via.source.rel` siempre presente para chat?** — verificar contra muestra de tickets `via.channel=chat`. Si no, fallback a `null` y badge "Chat" sin subtype.
2. **El loader actual tiene espacio en IndexedDB para Aircall**? — 17.824 calls × ~500 bytes slim = ~9 MB. Cabe sin problema.
3. **`/webhook/aircall-seed` ya está activo en n8n y devuelve gzip+base64**? — sí, según SES-20260525-1602 cierre.
4. **Pause/reload del seed Aircall** — `aircall-data` workflow ya hace deltas Schedule cada 5min. El loader debe consumir igual que `cs-data`.

## Orden de implementación sugerido

1. Extender `slim_ticket` con `chat_subtype` → `cs-build.py` → republish (5 min).
2. Modificar `index.html` para bajar aircall-seed → testear con consola del navegador (15 min).
3. Refactor `cs-view.render.js`: separar `T_FILTERED` / `CALLS_FILTERED` como derivado de `S.channel` (20 min).
4. Implementar `buildChannelSelect` + badges en cards existentes (30 min).
5. Implementar secciones Aircall en cada tab (60-90 min, lo más grueso).
6. Deploy via `deploy_cs_view.py` + recachear → demo con Alvaro.

Total estimado: **2.5 - 3.5 h** una vez Fase A validada.

## Bloqueantes para arrancar Fase B

- [ ] Fase A validada (`cs-fetch` + `cs-build` corren OK y producen seed equivalente al v7 actual)
- [ ] Verificar `via.source.rel` presente en chat tickets (15 min · 1 query Zendesk API)
- [ ] Confirmar con Alvaro que el orden de implementación es OK (a revisar al cierre de A)
