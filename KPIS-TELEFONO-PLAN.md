# Plan de KPIs por TAB — Vista Teléfono (Aircall) del Panel CS

> Origen: feedback VP Paulina (2026-05-29) sobre semántica de tabs + catálogo de 67 KPIs (`inputs/ivr_kpis.jsonl`).
> Validado por workflow multi-agente (estándares de industria vía web + calculabilidad vs BD viva + crítica foco-VP).
> **Regla rectora**: solo se construye lo CALCULABLE con los datos reales de Aircall. No inventar métricas con cara de KPI.

## Constraint duro del panel

- **NO es tiempo real**: sincroniza cada ~5 min llamadas YA TERMINADAS. NO hay estado de cola ni presencia de agentes. → "En vivo" = el DÍA de hoy hasta el último sync, NO un wallboard.
- Solo Teléfono (Aircall). Chat (Wotnot) = gap de datos.

## Campos reales que el endpoint entrega al cliente (snake_case)

`id, direction, status, started_at (unix), answered_at (unix|null), ended_at (unix), duration (seg), frt_sec (seg), missed_reason, raw_digits, user_name, number_name, contact_name (casi siempre null), tags, archived`

Relaciones verificadas (seed + BD): `frt_sec = answered_at − started_at` (espera/ASA, exacto), `duration = ended_at − started_at` (incluye ring), **talk time = `ended_at − answered_at`**. En perdidas, `duration` = tiempo hasta abandono.

## Matriz de calculabilidad (verificada contra BD viva)

| Calculable y valioso | Métrica/campo |
|---|---|
| Recibidas / Contestadas / Perdidas | `direction` + `answered_at` |
| Tasa contestación / abandono | derivadas (denom = recibidas inbound) |
| **ASA** (velocidad de respuesta) | `avg(frt_sec)` contestadas = **40.9s** (cobertura 90.2%) |
| **Nivel de Servicio / SLA** | % `frt_sec`≤N: ≤20s=**13.3%**, ≤30s=51.4%, ≤60s=90.4% (denom = contestadas con frt_sec) |
| Percentiles de espera | p50/p90/p95/max de `frt_sec` (el promedio esconde la cola) |
| Abandono ajustado | excluir perdidas con `duration`≤10s (parámetro, no nativo Aircall) |
| Tiempo hasta abandono | `duration` de perdidas (avg/mediana/p90/histograma) |
| Talk time | `ended_at − answered_at` (NO `duration`, que incluye ring) |
| Rellamadas / perdidas sin reintento | `raw_digits` (54% repiten; excluir troncales >P99=36) |
| Off-hours / heatmap hora×día | hora de `started_at` (requiere horario oficial CS) |
| Concurrencia máx (sustituto honesto de occupancy) | overlap `[started_at, started_at+duration]` |
| Abandono por mesa | `number_name` (CURADO vía MAPPING-MESAS.md) |
| inbound/outbound ratio, estacionalidad | `direction`, serie `started_at` |

| NO calculable (rechazado) | Razón |
|---|---|
| Tiempo real (cola, presencia agentes, longest wait) | panel no es tiempo real |
| WFM (occupancy real, adherencia, ausentismo, productividad) | sin tiempo logueado ni turnos |
| IVR profundo (flujo nodos, opciones, transfer, containment) | solo `number_name`, sin árbol |
| CSAT / NPS / CES | sin encuestas |
| Costo por llamada / de perdidas | sin datos de costo (gap roadmap — lo más valioso para VP) |
| FCR exacto, escalation | solo proxy por rellamada (nunca llamarlo "FCR") |
| Tipificación por motivo (`tags`) | 11% cobertura, débil |
| Desglose `missed_reason` en vivo | solo en seed (≤14-may); ingesta viva 0% |

## Set final por TAB

### Tab "En vivo" (HOY hasta el último sync, intradía acumulado) — 4 cards + 1 gráfico
Sello: "Datos hasta hace N min — no es estado de cola en vivo". Comparaciones **same-hour cutoff** (recortar ayer y mismo-día-semana-pasada a la hora actual). Guard día atípico (recibidas espejo <10 → no mostrar delta).
- **EV-1** Recibidas hoy + delta vs ayer-recortado y vs mismo-día-sem-pasada-recortado.
- **EV-2** Tasa de contestación / abandono hoy (semáforo abandono: verde<5 / ámbar 5-10 / rojo>10).
- **EV-3** ASA hoy = `avg(frt_sec)` (subtítulo con n y cobertura).
- **EV-4** % contestadas en <20s hoy (meta 80% referencia) — **color por TENDENCIA, no nivel** (evita alarm fatigue).
- **EV-5 (gráfico)** Curva intradía por hora: recibidas/contestadas/perdidas + línea del mismo día semana pasada.

### Tab "Análisis Semanal" (semana actual vs anterior) — 5 KPIs
- **SE-1** Volumen semana vs anterior + sparkline 6-8 semanas.
- **SE-2** Nivel de Servicio semanal (% <20s y <30s vs meta 80/20, gap explícito).
- **SE-3** Abandono semanal BRUTO y AJUSTADO (banda industria).
- **SE-4** ASA semanal vs benchmark ~28s.
- **SE-5** **Perdidas SIN reintento** (daño real) — el número que justifica dotación.

### Tab "Análisis" (rango configurable, profundo) — 6 KPIs
- **AN-1** Curva de Nivel de Servicio (15/20/30/60s) + percentiles p50/p90/p95.
- **AN-2** Abandono profundo: bruto vs ajustado + por mesa + distribución tiempo-a-abandono.
- **AN-3** Rellamada del mismo número (proxy, 24h/7d; reintento <15min aparte). Excluye troncales.
- **AN-4** Off-hours + heatmap hora×día (REQUIERE horario oficial CS).
- **AN-5** Concurrencia máxima por franja (sustituto de occupancy, dotación).
- **AN-6** Evolución/estacionalidad de volumen + ratio in/out.

### Tab "Clientes" → re-etiquetar **"Por Mesa / Línea"**
- **CL-1** Aviso honesto: el análisis por cliente del canal Teléfono no está disponible (Aircall no entrega organización; `contact_name` null, `zendesk_ticket_id` 0%). El análisis por cliente real vive en Zendesk.
- **CL-2** Proxy por mesa/línea (`number_name`) CURADO: solo líneas cliente-real (Sodexo, TocToc, CasinoExpress, SALFA, Portal Proveedores, OC Segura) y mesas funcionales. EXCLUIR nodos IVR genéricos, nombres de agentes (PII), números crudos, "Libre".

## Decisiones de negocio pendientes (VP/Alvaro)

1. **Meta SLA**: real 13.3% a 20s vs estándar 80/20. Fijar meta operativa propia. Card por tendencia.
2. **Parámetro abandono corto**: 10s sobre `duration` (heurístico). Confirmar 5s vs 10s.
3. **Horario laboral CS**: BLOQUEANTE para off-hours/heatmap. Pedir horario oficial.
4. **Tab Clientes**: confirmar re-etiquetado "Por Mesa/Línea".
5. **`archived`**: 3208 inbound archivados — decidir excluir/incluir uniforme.

## Datos a pedir a Tecnología (roadmap de ingesta n8n)
1. Poblar `missedReason` en vivo (hoy 0% post-14-may) → desbloquea "por qué pierdo".
2. Poblar `endedAtUnix` (hoy null) → talk time sin parsear.
3. Poblar `zendeskTicketId` (hoy 0%) → cross-link a cliente real.
4. Inyectar costo/hora-agente → KPIs de costo (lo más valioso para VP).
5. Normalizar `startedAt/answeredAt/endedAt` a Date (hoy string ISO en vivo → tipo mixto).
