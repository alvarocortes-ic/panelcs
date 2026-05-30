# TODO — Documentar vista Teléfono (Aircall) en Notion + Linear

> Origen: sesión 2026-05-29/30. La vista Teléfono del Panel CS se rediseñó por completo
> (4 tabs + ~20 KPIs nuevos) y **está en producción**. La documentación del proyecto aún
> no lo refleja. Pendiente de subir.

## Notion — ACTUALIZAR (sí hay cambios)

Dos páginas del Panel CS (última actualización 2026-05-29, antes de esta vista):
- **Doc técnica** (`36e12e12...ab63f5cd`): agregar sección "Vista Teléfono (Aircall) v2".
- **Proyecto general** (`36e12e12...a3fd7c54`): changelog + estado.

Contenido a documentar:
- 4 tabs con semántica propia: En vivo (hoy vs ayer/sem.ant, same-hour) · Semanal (semana vs anterior, navegable) · Análisis (rango configurable + granularidad día/sem/mes) · Por Mesa/Línea (ex-Clientes, Aircall sin datos de cliente).
- KPIs: recibidas/contestadas/perdidas, **ASA** (frt_sec), abandono bruto+ajustado (≤10s), talk time (ended-answered), **rellamadas / perdidas sin reintento** (raw_digits sin troncales), off-hours (L-V 8:30-20 / Sáb 8:30-13:30), patrón temporal in/out, Top IVRs/agentes, razones de pérdida, mesa×razón, %ticket Zendesk, duración mediana.
- Decisiones VP: SLA % NO se muestra (solo ASA); archivadas se cuentan; abandono corto=10s; filtro ejecutivo por user_name.
- Calculabilidad: lo NO calculable (tiempo real, WFM, IVR profundo, CSAT/NPS, costos) — documentado en `KPIS-TELEFONO-PLAN.md`.
- Bugs resueltos: DST en gráficos de rango largo; seed estático (botón "Recargar llamadas" + `refresh_aircall_seed.py`); header "0 tickets" en canal Aircall.
- Roadmap ingesta (Tecnología): poblar missedReason en vivo, endedAtUnix, zendeskTicketId, costo/hora.

Fuente de verdad lista: `KPIS-TELEFONO-PLAN.md` (matriz de calculabilidad + KPIs por tab).

## Linear — ACTUALIZAR (sí hay cambios, aplicación MANUAL)

Sigue **bloqueado por credenciales**: la única `LINEAR_API_KEY` en `.env.credentials` es de
Verónica Calas y NO ve el proyecto "Panel KPIs CS". Aplicación manual por Alvaro (UI), o
conseguir API key con acceso al proyecto.

Issue/milestone a crear: "Rediseño vista Teléfono (Aircall) — 4 tabs + KPIs contact center".
- Estado: ✅ en producción (2026-05-30).
- Sub-tareas: workflow validación KPIs · 4 tabs · fixes DST/seed · refresh tool.
- Pendiente futuro: curación fina de mesas (con líder), iteración 2 (heatmap+concurrencia), canal Chat/Wotnot.

Docs base ya en `docs/linear/` (del trabajo previo) — actualizar con esta entrega.
