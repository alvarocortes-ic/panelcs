# Panel CS — Re-encuadre conceptual de canales

> Documento de continuidad creado al cierre de SES-20260527-1700.
> Detalle conversacional completo en `_index/SESIONES.md` SES-20260527-1700.

## Contexto

Hoy se detectó que el filtro global del Panel CS estaba mal conceptualizado: `Zendesk (correo)` filtraba `canal_normalizado === 'Correo'` y **escondía el 41% del universo de tickets** (12.135 Teléfono + 3.470 Chat + 6 Whatsapp). Eso explica el reporte "los números de Zendesk no calzan" — el panel mostraba un subset y el VP/líder comparaba contra el universo total.

Conversación re-orientada al modelo conceptual correcto: **Zendesk = universo de tickets**; los streams propios (Aircall, Wotnot) tienen tabs separados con métricas del sistema fuente.

## Datos de referencia (medidos contra seed productivo 2026-05-27, 38.144 tickets)

| `canal_normalizado` | tickets | % | `via.channel` raw |
|---|---:|---:|---|
| Correo | 22.533 | 59.1% | email (19.112) + web (3.421) |
| Teléfono | 12.135 | 31.8% | api (Aircall→Zendesk) |
| Chat | 3.470 | 9.1% | chat (Wotnot/Zopim→Zendesk) |
| Whatsapp | 6 | 0.0% | whatsapp |
| Otros | 0 | 0% | — |

Subtypes de Chat: general 2.015 · sodexo 1.166 · offline 208 · sn1 52 · portal_proveedores 29.

Stream Aircall directo: ~17.955 calls (de las cuales 12.135 generaron ticket, 32% no convirtió).

## Decisiones de diseño cerradas (no re-discutir)

### 1. Nuevo modelo del selector global

| Opción del selector | Universo | Fuente de datos |
|---|---|---|
| **Todos** | global cross-canal | tickets Zendesk + calls Aircall + (chats Wotnot futuro) |
| **Zendesk** | los 38.144 tickets (TODOS los canales) | cs-seed |
| **Teléfono (Aircall)** | ~17.955 calls Aircall | aircall-seed (ya existe) |
| **Chat (Wotnot)** | hoy: 3.470 tickets canal=Chat · futuro: stream Wotnot completo | tickets Zendesk hoy / Wotnot futuro |

**Removidos del modelo**:
- ~~Correo~~ → absorbido en Zendesk (no tiene métrica propia, entra directo)
- ~~Whatsapp~~ → 6 tickets en 4 meses, volumen anecdótico
- ~~Otros~~ → 0 tickets

### 2. Naming del selector

Texto del dropdown: `Todos · Zendesk · Teléfono (Aircall) · Chat (Wotnot)`.

### 3. Vista "Todos los canales" — diseño global (público: VP / líderes)

Decisión asumida por Claude (autorizado en turno): mirada ejecutiva, decisiones rápidas. Layout propuesto:

**Fila 1 — KPI hero (5 cards)**:
- Demanda total recibida (tickets + calls + chats) · *etiqueta: Aircall + Zendesk + Wotnot*
- Tickets Zendesk del período · *etiqueta: Zendesk*
- Llamados Aircall del período · *etiqueta: Aircall*
- Conversión Aircall → Zendesk (% de calls con `aircall_call_id` cruzado) · *etiqueta: Aircall ↔ Zendesk*
- Chats Wotnot del período · *etiqueta: Wotnot* (placeholder hasta deploy)

**Fila 2 — Tendencia diaria multistream**: line chart con 3 series (tickets Zendesk · calls Aircall · chats Wotnot), eje izq común si las escalas se parecen, doble eje si no. Filtro tiempo: hoy / semana / mes / rango.

**Fila 3 — Composición**: donut "share por canal" (tickets Zendesk con drill al `canal_normalizado` interno + calls Aircall + chats Wotnot).

**Fila 4 — Tabla resumen**: para cada stream, conteo + FRT mediana (Zendesk + Aircall que tienen ticket) + SLA cumplido (Zendesk only) + tiempo respuesta promedio (Aircall).

**Convención de etiquetado** (decisión del usuario): cada KPI/card lleva tag visible del contexto fuente. "Aircall" si es stream propio · "Aircall + Zendesk" si es cross-link · "Zendesk" si es solo tickets.

### 4. Vista "Zendesk" = universo total de tickets

- Sin filtro de `canal_normalizado` aplicado (a diferencia de hoy que filtra a Correo).
- Mantener todos los KPIs operativos actuales (queue, FRT, SLA, CSAT, escalamientos, etc.) calculados sobre los 38.144.
- **Nueva columna "Canal"** en la tabla de tickets (modal cliente, tab Clientes, vistas detalle) con `canal_normalizado`. Permite filtrar/drill sin esconder el universo.

### 5. Vista "Teléfono (Aircall)"

`buildAircallView()` ya existe — mantener. Agregar 1 KPI:
- **% conversión a Zendesk**: calls con `aircall_call_id` cruzado / total calls. Permite ver cuántas llamadas terminan en ticket vs cuáles quedan solo en Aircall (voicemail, llamadas cortas, etc.).

### 6. Vista "Chat (Wotnot)"

Mantener tal cual hoy (basada en tickets Zendesk canal=Chat) **hasta que se priorice el deploy Wotnot**. Ver TODO 5 abajo.

---

## TODOs de implementación (orden sugerido)

### TODO 1 — Renombrar selector + redefinir filtro `zd` para que sea universo total ✅ COMPLETADO 2026-05-28

**Estado**: deployado a prod (workflow `qOIldhWyoeGMUa2p`, version `rename-canales-univ-zendesk-2026-05-28`, commit local `6c2fc4d4`). Validado contra HTML servido productivo:
- `applyChannelFilter` rama zd: `T = T_ALL` (universo total) ✓
- Labels selector: `Todos · Zendesk · Teléfono (Aircall) · Chat (Wotnot)` ✓
- Badges: `ZENDESK · TELÉFONO · CHAT` ✓
- Único `'Correo'` remanente está en comentario explicativo (no funcional) ✓

---

### TODO 1 (original — referencia histórica)

**Archivos**:
- `outputs/cs-panel/n8n/cs-view.render.js`
  - L1048-1060 `buildChannelSelect()`: cambiar labels a `Todos · Zendesk · Teléfono (Aircall) · Chat (Wotnot)`. Quitar la etiqueta `(correo)` del label `zd`.
  - L3147-3163 `applyChannelFilter()`: cambiar la lógica:
    - `zd` → `T = T_ALL` (universo total Zendesk, sin filtrar canal_normalizado)
    - `ac` → `T = []` + CALLS_ALL (igual que hoy)
    - `wn` → `T = T_ALL.filter(canal_normalizado === 'Chat')` (mantener hasta deploy Wotnot)
    - `all` → `T = T_ALL` + CALLS (igual que hoy)
  - L1209-1221 `channelBadge()`: actualizar `zd: { label:'ZENDESK', tip:'Vista universo total de tickets (todos los canales).' }` y agregar `tel:{ label:'TELÉFONO', tip:'Stream de llamadas Aircall.' }`.
- `outputs/cs-panel/n8n/cs-view.styles.css` L343+: actualizar banner stale message (`canal_normalizado` ya no es necesario para zd, solo para wn).
- `outputs/cs-panel/DESIGN-FASE-B.md`: marcar como obsoleto (modelo nuevo en este archivo).

**Validación**: contar tickets con filtro `zd` debe dar 38.144 (no 22.533). Smoke local con preview.

**Deploy**: `python outputs/cs-panel/scripts/deploy_cs_view.py rename-canales-univ-zendesk-YYYY-MM-DD` (con autorización explícita del usuario, es prod).

---

### TODO 2 — Implementar vista "Todos los canales" (global) 📦 DIFERIDO A cs-panel-v2 (HU 1)

**Estado** (2026-05-28): movido al backlog del proyecto futuro [[cs-panel-v2]] como HU 1.

**Razón del diferimiento**: el panel actual va a ser migrado a otra tecnología. Implementar la vista global aquí significa codificar 200+ líneas que después hay que re-portar al stack nuevo. Más eficiente: documentar como HU formal en cs-panel-v2 + esperar discovery con stakeholder (Aldo + VP Paulina) para cerrar los 3 huecos de diseño (período, doble-conteo, comportamiento Paneles Extras en modo Todos).

**Decisiones cerradas que se conservan** (referencia para implementación futura): ver sección 3 de este doc arriba ("Vista Todos los canales — diseño global").

**Próximo paso**: discovery con stakeholder. NO implementar en panel actual.

---

### TODO 2 (original — referencia histórica)

**Archivos**:
- `outputs/cs-panel/n8n/cs-view.render.js`
  - `buildMulticanalSummary()` (L2814) → expandir a vista completa o crear `buildGlobalView()` que se invoca cuando `S.channel === 'all'`. Decisión: REEMPLAZAR el render actual de tabs cuando filtro=`all` por una vista hero (no aplicar tab=live/week/ana/org) — el VP/líder en modo "Todos" quiere panorama, no operativa.
  - Implementar las 4 filas descritas arriba (KPI hero · tendencia diaria · donut composición · tabla resumen).
- CSS: agregar layout `.cs-global-hero` con grid responsivo.

**Datos requeridos** (ya disponibles en cliente):
- Tickets Zendesk: `T_ALL` (38.144)
- Calls Aircall: `CALLS_ALL` (~17.955 via IndexedDB cs-aircall)
- Chats Wotnot: placeholder hasta deploy. Mientras tanto: usar count de tickets canal=Chat.

**Etiquetado**: cada KPI con badge `data-source="..."` y tooltip describiendo fuente.

---

### TODO 3 — Columna "Canal" en tablas de tickets de vista Zendesk ⏳

**Archivos**:
- `outputs/cs-panel/n8n/cs-view.render.js`:
  - Tabla tickets activos del cliente (L2167-2178): agregar columna entre Estado y Prioridad: "Canal" mostrando `canal_normalizado` con pill de color (Correo=azul · Teléfono=verde · Chat=naranjo · Whatsapp=morado).
  - Tabla detalle por categoría / top FRT / SLA vencido (mismo cliente): mismo agregado.
  - `orgExportActivos` (L3309): agregar `t.canal_normalizado` al export XLSX.

**Validación**: filtrar por canal en la tabla y ver que los conteos cuadran.

---

### TODO 4 — KPI "% conversión Aircall→Zendesk" en vista Aircall ⏳

**Archivos**:
- `outputs/cs-panel/n8n/cs-view.render.js` `buildAircallView()` (L2888):
  - Agregar en KPI hero (después de "% atendidas/perdidas"):
    - "Conversión a ticket Zendesk": `calls.filter(c => c.zendesk_ticket_id || cross_link).length / calls.length × 100`
  - El cross-link vive en `aircall_call_id` del lado Zendesk (Fase D). Necesitamos invertir el mapeo: `set(t.aircall_call_id for t in T_ALL if t.aircall_call_id)` y verificar si `c.id` está en ese set.

**Limitación conocida**: hoy solo ~40% de tickets Teléfono tienen `aircall_call_id` poblado (Zendesk no escribe el field en todos los flujos). Aclarar en tooltip que es lower bound.

---

### TODO 5 — Deploy Wotnot (stream propio) — OPCIONAL según prioridad ⏳

**Bloqueante hoy**: requiere autorización explícita del usuario + configuración en UI de Wotnot (webhook push hacia `/webhook/wotnot-events`).

**Pasos** (referencia `MEJORAS.md` § Fase D):
```bash
set -a; source .env.credentials; set +a
python outputs/cs-panel/scripts/setup_n8n_credentials.py  # idempotente
set -a; source .env.credentials; set +a                   # recargar con N8N_CRED_ID nuevos
python outputs/cs-panel/scripts/setup_wotnot_events.py    # crea workflow Wotnot Events
# Luego: en Wotnot UI, apuntar webhook → /webhook/wotnot-events
```

**Después del deploy**:
- Cliente del panel descarga vía `GET /webhook/wotnot-seed` (snapshot) + `/webhook/wotnot-data` (deltas).
- Trade-off conocido: sin histórico al deploy — acumula desde el primer push.

**Decisión usuario (SES-20260527-1700)**: priorizar después de TODO 1-4. La vista "Chat" puede vivir provisionalmente con tickets Zendesk canal=Chat.

---

## Deuda técnica colateral (revisar mientras se hace lo anterior)

### A — Filtro "Tipo" usa regex sobre subject, no `t.type` real

`cs-view.render.js:423-425` `inferType(subj) = /^(SOL)/i ? 'solicitud' : 'incidente'`. **No lee el campo `t.type` nativo de Zendesk**. Si los agentes no escriben `(SOL)` al inicio, todo termina clasificado como "Incidente".

**Decisión pendiente**: ¿es por diseño (convención editorial de los agentes) o queremos cambiar a `t.type`? Si se cambia, hay que pasar `type` al slim (ya está en `slim_ticket` L253) y leerlo. Riesgo: cambiar el comportamiento puede romper conteos históricos.

### B — Bug FRT en nodo `Enrich` de cs-data n8n

Documentado en `MEJORAS.md` línea 184-186: `carga_inicial.py` corrigió `first_reply_time_in_minutes` → `reply_time_in_minutes` (la key real), pero el nodo `Enrich` del workflow n8n `cs-data` (`akkbfUdsiXEg57LK`) **probablemente no se corrigió**.

**Consecuencia**: los deltas que llegan al cliente no traen FRT poblado → los tickets nuevos arrastran `frt_min: null` hasta el próximo seed completo.

**Validación**: abrir el workflow cs-data en n8n y verificar la línea exacta del nodo Enrich. Si tiene `first_reply_time_in_minutes` → corregir.

### C — C2b merge defensivo en cliente

`MEJORAS.md` L143-146: el cliente actualmente hace `put` (reemplazo) cuando recibe un delta vía cs-data. Si un ticket post-seed se actualiza, los campos `esc_sn2/esc_mo/devol/paso_sn1` se pierden porque cs-data no los computa.

**Fix**: cambiar el merge del cliente a `Object.assign(existing, delta)` para preservar campos que el delta no trae. Es cambio pequeño en `index.html` loader (función `dbMergeMany`).

### D — Hardcodeos: 3 ejecutivos + 4 equipos excluidos

`cs-view.render.js:555` `EXCL_EJEC = { 'Alberto Mercado':1, 'Edgar Bonomie':1, 'Karina Salinas':1 }`.
`cs-view.render.js:370-375` `EXCLUDED_GIDS = { ... 4 grupos iBuilder + Casos Sin Replicar }`.

**Consideración**: pasarlo a archivo config (`config.js` separado en n8n o constantes al inicio del render) para que cambios futuros no requieran tocar el render core. Bajo impacto, pero limpia el archivo.

### E — Doc inconsistente: schedule DTE Health

`RECIENTE.md` y `ICClaudeVault/aprendizajes/cs-panel-tab-data-externa.md` dicen "schedule cada 5min". Pero el workflow `p40WEmG8nXh1HhSD` real corre cada **15min** (`0 */15 7-20 * * 1-5`). Drift trivial pero anotar.

---

## Descartado / cerrado (no hacer)

- **DTE Health**: el usuario corrió la query original contra la BD productiva y los números coinciden con el panel. Caso cerrado. Audit en `outputs/cs-panel/incident-2026-05-27/audit_dte_health*.sql` queda como referencia.
- **Whatsapp como canal separado**: 6 tickets en 4 meses, volumen anecdótico, no priorizar.
- **"Otros" como canal**: 0 tickets en el seed. Si aparecen, agregar lógica explícita.
- **"Correo" como filtro propio**: entra directo a Zendesk, sin sistema intermedio que mida pre-ticket. Se absorbe en vista Zendesk.

---

## Cómo retomar en próxima sesión

1. Leer este archivo + `_index/SESIONES.md` entrada SES-20260527-1700.
2. Confirmar con el usuario que las decisiones de diseño siguen vigentes (sin re-discutir).
3. Empezar por **TODO 1** (cambio de semántica filtro `zd`). Es el cambio que más mueve la aguja para resolver el reporte "los números de Zendesk no calzan".
4. Después TODO 2 (vista global) — es la pieza nueva más visible para VP/líderes.
5. TODO 3 y TODO 4 son refinamientos pequeños.
6. TODO 5 (deploy Wotnot) según prioridad del usuario.
