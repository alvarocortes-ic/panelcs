# Panel CS — Milestone de mejoras (analizado 2026-05-16)

Análisis de las ~25 mejoras pedidas por Alvaro. Clasificadas por **disponibilidad de datos**,
porque varias no dependen de UI sino de datos que el panel hoy no tiene.

## Hallazgos de la investigación a Zendesk

- **292 custom fields** en la instancia. Las categorías/subcategorías/productos están
  **fragmentados por segmento de negocio** (iConstruye, CLA, CE, PP, SI, IS, SDXO, B2B,
  Agilice, iB…): no hay UN campo "Categoría" — hay ~10 campos `Categoría (X)` y cientos
  de `Subcategoría - … (X)`. Consolidarlos a un dato legible requiere lógica de negocio.
- **CSAT sí existe** — endpoint `satisfaction_ratings` devuelve `score: good/bad` por ticket.
- Campos simples útiles que sí existen: `Nivel` (4556868682267), `Ticket en seguimiento`
  (4557078676251), `TRIAGE temp` (29785320928283), `Escalado correctamente a P&T y a Sn2`
  (4557027988379).
- El modelo de datos actual del ticket (`slim()` en cs-data + seed) solo tiene: id, subject,
  status, priority, type, created_at, updated_at, solved_at, closed_at, frt_min, reopens,
  group_id, assignee_id, organization_id, sla_breached.

## Clasificación de las mejoras

### Grupo 1 — UI / cálculo, datos ya disponibles → se hace sin dependencias

| # | Mejora |
|---|---|
| 1 | Fix modal transparente (bug CSS) |
| 2 | Desactivar equipos sin tickets en 2026 (aparecen solo si tienen data) |
| 3 | "Solo días hábiles" → consumir API de feriados (feriados-cl) |
| 5 | Modal de clientes (top 10 clientes → modal con sus tickets y stats) |
| 8 | Modal scrolleable horizontal |
| 9 | Reordenar columnas drag&drop — viable |
| 12 | Gráfico tickets por mes (barras verticales, según filtro) |
| 14 | Card "Neto Tickets" (entradas − resueltos) en composición del queue |
| 15 | Gráfico Ingresos vs Cierres por hora (En Vivo) |
| 17 | Barras Tickets/equipo y SLA/equipo más compactas + movidas debajo de Carga por Ejecutivo |
| 6a | Triage — número `(N)` del título, por regex |
| 6b | Prioridad — el ticket ya tiene `priority` (low/normal/high/urgent) |
| 11a | Card "Tickets gestionados" (Q según filtro, con rango desde-hasta) |
| 11b | Card "SLA cumplido" (% según filtro) |
| 4* | Tab "Análisis Semanal" — la mayor parte: prom diario recibido/atendido, día de mayor carga, día de mayor cierres, día de mayor conversión %, agente con mejor desempeño, top 10 empresas/día, gráfico líneas recibidos vs resueltos |

### Grupo 2 — necesita traer campos simples nuevos → toca el pipeline de datos

Requiere modificar `cs-data` (`slim`) + `carga_inicial.py` + **regenerar el seed**.

| Mejora | Fuente |
|---|---|
| Nivel (Complejo/Simple) | custom field `Nivel` (4556868682267) |
| Seguimiento (Sí/No) | custom field `Ticket en seguimiento` (4557078676251) |
| Merged (Sí/No) | tag de Zendesk `closed_by_merge` (requiere traer `tags`) |
| CSAT — card, gráfico % por mes | endpoint `satisfaction_ratings` (fuente nueva) |

### Grupo 3 — necesita modelado de negocio + decisiones de Alvaro

No se puede inferir; requiere que Alvaro explique la lógica.

| Mejora | Qué falta definir |
|---|---|
| Columnas Línea negocio / Producto / Módulo / Categoría / Subcategoría | Cómo consolidar los ~292 campos fragmentados por segmento a un set legible |
| Detalle por categoría · top 5 categorías por día | Depende de lo anterior |
| % escalados SN1→SN2 · % escalados a Mantención Operativa | Cómo se identifica un escalamiento: ¿cambio de grupo? ¿campo `Escalado correctamente…`? ¿historial? |

## Plan de fases

> Decisión Alvaro (2026-05-16): ejecutar **A y B completas de forma autónoma** (sin
> validación intermedia); **C se revisa entre los dos** antes de implementar.
>
> **Estado**: ✅ Fase A completa · ✅ Fase B completa · ⏸️ Fase C pendiente de modelado.

- **Fase A — Grupo 1** (sin dependencias). Todas las mejoras de UI y cálculo. Sub-fases
  A1 fixes/layout · A2 En Vivo · A3 tab Análisis Semanal · A4 Análisis · A5 drag&drop.
- **Fase B — Grupo 2**. Enriquecer el pipeline de datos (cs-data + seed) con Nivel,
  Seguimiento, Merged y CSAT. Nota: los 4 salen del objeto ticket que el Incremental API
  ya trae (`custom_fields`, `tags`, `satisfaction_rating`) — no requiere fuente nueva.
- **Fase C — Grupo 3**. Sesión de modelado con Alvaro sobre categorías y escalamientos;
  recién después, implementar.

## Decisiones de diseño (Fase A)

- **3 tabs**: `En vivo` · `Análisis semanal` (nuevo, intermedio) · `Análisis`.
- **En vivo** — orden por relevancia: KPIs jornada → Composición (con card *Neto Tickets*) →
  Antigüedad → Detalle por ejecutivo (tabla) → Carga por ejecutivo (chart) →
  Tickets/equipo + SLA/equipo (barras compactas, altura proporcional al nº de equipos) →
  Top clientes → Ingresos vs Cierres por hora.
- **Análisis semanal** — semana en curso (lunes→viernes): fila de KPIs (prom diario
  recibido/atendido, día de mayor carga/cierres, mejor agente) → gráfico de líneas
  recibidos vs resueltos → tablas (top empresas, conversión por día).
- **Modales** (ejecutivo y cliente): mismo patrón, scroll horizontal, columnas reordenables.
- Tablas de tickets: columnas base + Triage + Prioridad; el resto (categorías) entra en Fase C.

## Fase C — plan detallado (investigado 2026-05-16, respuestas de Alvaro)

Alvaro respondió: (1) usar solo campos comunes/transversales, autoriza a consolidar;
(2) escalamiento = derivación de grupo SN1↔SN2↔MO (Mantención Operativa, equipo
Sebastián Milla); (3) implementar SLA histórico.

### C1 — categorías y productos (campos transversales)
Análisis sobre muestra de 90 tickets — custom fields poblados transversalmente:
- `Línea de negocio` (id 11490690310939) — 97%
- `Categoría (iConstruye)` (4557429365019) — 84% · `Producto (iConstruye)` (4704444587547) — 84%
  · `Subproducto (iConstruye)` (4746276837787) — 84%
Plan: agregar al slim (`cs-data` + `carga_inicial.py`) 4 campos consolidados —
`linea_negocio`, `categoria`, `producto`, `subproducto`. Para categoría/producto/
subproducto: usar el campo `(iConstruye)` como principal y consolidar con los
equivalentes de otros segmentos (CLA, CE, PP, SI, IS, SDXO) tomando el primero con
valor. Regenerar el seed. En la vista: columnas en el modal + "Detalle por categoría"
(tab Análisis) + "top 5 categorías por día" (tab Semanal).

### C2 — escalamientos SN1 ↔ SN2 ↔ MO
Vía `/api/v2/incremental/ticket_events.json` (trae cambios de `group_id` masivos, como
el incremental de tickets — viable, no requiere 1 request por ticket).
- Grupos **SN1**: `4681557011739` (Soporte Nivel 1), `4681700491547` (SN1 B2B),
  `4681682013083` (SN1 CICFIN), `4681854804123` (SN1 PAP).
- Grupo **SN2**: `4681742537243` (Soporte Nivel 2).
- Estructura **PyT (Producto y Tecnología)** — área paraguas que engloba MO e Integraciones:
  · **MO** (Mantención Operativa, lidera Sebastián Milla) → grupo `Proyecto Producto y
    Tecnología` (`4681656062107`).
  · **Integraciones** (lidera Cristian García, antes Aldo Carvajal) → grupo
    `Proyecto Integraciones` (`4681846763803`).
  Al ejecutar C2 confirmar el mapeo grupo↔equipo contra Notion (estructura del equipo).
- Pipeline nuevo de datos (cs-data + carga_inicial.py) que cuente transiciones de grupo
  por ticket → `% escalado SN1→SN2`, `% SN2→MO`, devoluciones.

**Modelado cerrado con Alvaro (2026-05-16)**:
- Denominador del `% escalado SN1→SN2` = tickets que **pasaron por SN1** (su grupo fue
  SN1 en algún momento). No sobre todos los tickets.
- Un ticket cuenta como escalado a SN2 si **tocó SN2 alguna vez**, aunque después lo
  devuelvan. Las **devoluciones SN2→SN1** son una métrica propia y útil (rebote: mala
  gestión, resoluble en SN1, o faltaban datos).
- Las métricas van en el **tab Análisis**.

**C2a — implementado (código, sin desplegar)**:
- `carga_inicial.py`: fase nueva `fetch_ticket_events()` (itera `incremental/ticket_events`,
  extrae los `child_events` de cambio de grupo) + `escalation_fields()` (reconstruye la
  secuencia de grupos del ticket). Campos nuevos en el slim: `paso_sn1`, `esc_sn2`,
  `esc_mo`, `devol`.
- `cs-view`: sección "Escalamientos" en el tab Análisis — 4 KPIs (Pasaron por SN1,
  % Escalado a SN2, % Escalado a MO, Devoluciones SN2→SN1).
- **Pendiente para activar**: regenerar el seed (suma la fase ticket_events, ~25-30 min)
  + deploy de `cs-view`.

**C2b — pendiente**: el nodo `Enrich` de `cs-data` (n8n) no computa estos campos. Como
el cliente hace `put` (reemplazo) del ticket al recibir un delta, un ticket actualizado
post-seed perdería `esc_sn2`/etc. Opciones: (a) agregar `ticket_events` al pipeline de
`cs-data` en n8n; (b) cambiar el merge del cliente a `Object.assign` para preservar
campos que el delta no trae. Decidir antes de cerrar C2.

### C3 — SLA histórico
En el enrich (`cs-data` `Enrich` + `carga_inicial.py`), para tickets resueltos comparar
`solved_at` vs `breach_at` del policy_metric → guardar `sla_breached` también para no
activos (hoy el slim lo deja `null`). Habilita "SLA cumplido" real en el tab Análisis.

### Notas
- Triage: resuelto en Fase A — del título por regex (Alvaro confirmó).
- C es trabajo grande (regenerar seed otra vez + pipeline de ticket_events). Ejecutar
  en sesión dedicada con este plan.

## Feedback visual de Alvaro (2026-05-16)

✅ **Tanda 1 hecha** (cs-view v16-FaseC2): números/% y cabeceras centrados, modal +15%
(`max-width 1060px`), modal cierra solo con la X (sin click-fuera), scroll horizontal
siempre visible y notorio (naranjo), Triage marca "SOL" para solicitudes, excluidos
Alberto Mercado / Edgar Bonomie / Karina Salinas del chart "Resueltos por ejecutivo".

✅ **Tanda 2 hecha** (cs-view v17-tanda2, 2026-05-16) — tab Análisis Semanal:
- **Detalle por día**: + columnas "Empresa con más tickets" (empresa con más tickets
  creados ese día) y "Ejecutivo con más cierres" (más resueltos ese día), con conteo
  `(N)`. `weekData()` ahora acumula `byOrg` por día además de `byAgent`.
- **Top 10 empresas**: + columnas "% SLA", "Media resolución", "Media 1ª respuesta".
  Calculadas sobre los tickets creados lun-vie de cada empresa.
- **Filtro por ejecutivo**: select en barra propia del tab; `weekUniverse()` aplica el
  filtro a todo el tab (KPIs, gráfico, tablas). Con filtro activo se oculta el KPI
  "Mejor desempeño" (grid k5→k4) y el header indica el ejecutivo enfocado.

⚠️ **Bug del FRT detectado y corregido en `carga_inicial.py`** (2026-05-16):
- El seed tenía `frt_min` en **0%** (verificado: 0/35.952). Causa: `carga_inicial.py`
  leía `first_reply_time_in_minutes`, clave que NO existe en el objeto Ticket Metrics
  de Zendesk. El nombre real es `reply_time_in_minutes` (verificado contra Zendesk vivo:
  devuelve `{calendar: 266, business: 266}`). Corregido en las 2 líneas del enrich.
- ✅ **Seed regenerado 2026-05-16** con el fix: 35.956 tickets · `frt_min` poblado al
  **61%** (22.196 — el 39% restante son tickets sin 1ª respuesta registrada: merge,
  auto-close, resueltos sin interacción) · mediana 78 min · `categoria`/`linea_negocio`/
  `producto` 95% · `sla_breached` 100% · `reopens` 100%. Para verlo en el panel: botón
  **Re-cachear**.
- ⏳ **Pendiente**: el nodo `Enrich` de `cs-data` (n8n) probablemente tiene el mismo bug
  de nombre — los deltas no traerían FRT. Revisar al tocar C2.
- Alcance SN2: el FRT poblado es el de Zendesk crudo (1ª respuesta desde la apertura).
  Para SN2, el FRT "real" debería medir desde la derivación a SN2 → atado a C2.

## Fase D — Módulos nuevos: Aircall + Chat (Wotnot) [2026-05-25]

> Sesión SES-20260525-1602. Decisión del usuario: incorporar 2 fuentes nuevas al
> panel CS, con UX idéntico (recachear / F5 / botón actualizar).

### Hallazgo crítico sobre Wotnot

La API pública de Wotnot **no expone LIST/incremental** — solo POST/CREATE. Por
eso Wotnot **no puede** seguir el patrón pull `Schedule cada 5 min` de cs-data.

**Estrategia adoptada**: **webhook push Wotnot → n8n**. Wotnot envía cada evento
al workflow `Wotnot Events`, que normaliza y acumula en `staticData`. El panel
descarga vía GET `/webhook/wotnot-seed` (snapshot) y `/webhook/wotnot-data`
(deltas). Trade-off: sin histórico al deploy — acumula desde el primer push.

Detalle de la limitación + plan de webhook en [[wotnot-iconstruye]].

### Aircall — alcance confirmado

Decisión usuario: TODO el shape disponible.

- **Volumen + estado**: conteos por día/hora · % atendidas/perdidas · razón perdida
- **FRT + duración**: mediana `answered_at - started_at` · duración promedio · largas
- **Por número/IVR + agente**: ranking IVRs (Soporte FE / iC / Sodexo) · ranking agentes
- **Contacto + grabación**: cruzar contact con org Zendesk · link recording · marca voicemail

Ventana histórica del seed: **2026-01-01** (igual que Zendesk).

### Workflows nuevos en n8n (a desplegar con autorización)

| Workflow | Función | Setup script |
|---|---|---|
| **Aircall Seed** | Aloja seed histórico (gzip+base64) en staticData · GET/POST | `setup_aircall_seed.py` |
| **Aircall Data** | Schedule cada 5 min: fetch `/v1/calls?from=<cursor>` · slim + accumulate · GET deltas | `setup_aircall_data.py` |
| **Wotnot Events** | POST receiver Wotnot → normalize → staticData · GET seed/data | `setup_wotnot_events.py` |

### Scripts nuevos (ya creados, sin desplegar)

```
outputs/cs-panel/scripts/
├── setup_aircall_seed.py       ← workflow GET/POST (idéntico a setup_cs_seed.py)
├── setup_aircall_data.py       ← workflow Schedule + Slim + GET deltas
├── setup_wotnot_events.py      ← workflow webhook receiver + GET seed/data
└── carga_inicial_aircall.py    ← fetch histórico desde 2026-01-01 + publish a aircall-seed
```

### Estado al 2026-05-25 17:00 chile

- ✅ Smoke creds: Aircall HTTP 200 · Wotnot Bearer válido.
- ✅ Fichas vault: `aircall-iconstruye.md`, `wotnot-iconstruye.md`, `env-credentials.md` actualizado.
- ✅ 4 scripts locales creados + validados (`python -m py_compile` OK · dry-run Aircall OK).
- ⏸️ **PENDIENTE de autorización explícita**: deploy a n8n productivo (correr `setup_*.py`).
- ⏸️ Configurar push en Wotnot (UI o `POST /v1/accounts/<id>/webhook`) apuntando a `/webhook/wotnot-events`.
- ⏸️ Render multifuente en `cs-view`: cómo coexisten Zendesk + Aircall + Wotnot en el mismo panel — **conversación pendiente** (decisión del usuario).

### Pasos del deploy (cuando el usuario lo autorice)

```bash
set -a; source .env.credentials; set +a

# 1. Crear las Credentials nativas en n8n (idempotente)
#    Aircall (httpBasicAuth, OBLIGATORIA) + Wotnot (httpHeaderAuth, opcional)
#    Anexa AIRCALL_N8N_CRED_ID + WOTNOT_N8N_CRED_ID al .env.credentials
python outputs/cs-panel/scripts/setup_n8n_credentials.py

# 2. Re-cargar el entorno con las nuevas vars de cred id
set -a; source .env.credentials; set +a

# 3. Crear los 3 workflows en n8n (idempotente)
python outputs/cs-panel/scripts/setup_aircall_seed.py
python outputs/cs-panel/scripts/setup_aircall_data.py        # NO autoactiva el Schedule
python outputs/cs-panel/scripts/setup_wotnot_events.py

# 4. Cargar histórico Aircall (~5 meses desde 2026-01-01)
python outputs/cs-panel/scripts/carga_inicial_aircall.py     # 5-15 min según volumen

# 5. En la UI de n8n: revisar 'Aircall Data' y activar el Schedule manualmente
# 6. En Wotnot UI: configurar webhook hacia /webhook/wotnot-events
```

> [!info] Credentials en n8n (paso 1)
>
> Patrón establecido del repo (confirmado contra `cs-data` en producción): los
> nodos HTTP referencian credenciales nativas n8n (`authentication: genericCredentialType`),
> que viven encriptadas at rest y separadas del JSON del workflow.
>
> `setup_n8n_credentials.py` las crea vía `POST /api/v1/credentials`:
> - **`Aircall Basic - iconstruye`** (`httpBasicAuth`) — user/password = `$AIRCALL_API_ID` / `$AIRCALL_API_TOKEN`. Obligatoria (Aircall Data hace outbound).
> - **`Wotnot Bearer - iconstruye`** (`httpHeaderAuth`) — header `Authorization: Bearer $WOTNOT_API_ACCESS_TOKEN`. Opcional hoy (Wotnot Events solo recibe push), recomendable por si después hace outbound.
>
> Alternativa UI: Credentials → + Add credential → Basic Auth / Header Auth. Detalle en [[aircall-iconstruye]] / [[wotnot-iconstruye]].
