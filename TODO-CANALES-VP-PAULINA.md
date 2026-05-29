# TODO — Métricas de canales que pide la VP (Paulina Nazar)

> Origen: reporte de la VP de Customer Service (Paulina Nazar), 2026-05-29. Tras resolver el bug de sync (panel congelado), la VP planteó que las vistas de canales "extras" (Teléfono/Chat) **no dicen mucho** — el filtro no funciona y es solo un número. Lo que necesita de verdad:
>
> *"lo que yo necesito saber de los otros canales es la cantidad de **llamadas perdidas, llamadas recibidas** y la cantidad de **mensajes perdidos y contestados por días**."*

**Estado**: 🔴 NO implementado. Las vistas Teléfono/Chat hoy usan el modelo "queue de tickets" (movimientos de jornada, SLA, antigüedad) — que NO responde lo que la VP pide. Listo para investigar/desarrollar en **nueva sesión**.

**Regla de trabajo**: todo desarrollo se hace primero en **entorno `_test`** (workflows `*_test`, `index-test.html`, deploy `--test`), se valida con datos reales, y solo con GO + snapshot se porta a prod. (Misma metodología que usamos para el fix del upsert.)

---

## Diagnóstico de datos (verificado 2026-05-29 contra Mongo)

### Teléfono (Aircall) — ✅ datos DISPONIBLES, falta construir la vista

La colección `PanelCSCalls` tiene todo lo necesario. Criterios confirmados:

| Métrica VP | Cómo se calcula | Dato |
|---|---|---|
| **Llamadas recibidas** | `direction: "inbound"` | 16.091 histórico |
| **Llamadas perdidas** | `direction:"inbound"` + `answeredAt: null` | 5.954 histórico |
| **Llamadas contestadas** | `direction:"inbound"` + `answeredAt != null` | 10.137 histórico |
| **Por día** | agrupar por `startedAtUnix` (día) | ✅ |
| **Desglose de motivo de perdida** | `missedReason`: `no_available_agent` (2.074), `abandoned_in_ivr` (1.078), `short_abandoned` (1.076), `agents_did_not_answer` (663), `out_of_opening_hours` (232), `abandoned_in_classic` (175) | ✅ bonus |

> ⚠️ **OJO**: "perdida" NO está en el campo `status` (que solo trae `done`/`answered`). Se identifica por `answeredAt` vacío + `missedReason`. No usar `status` para esto.

**Plan sugerido (nueva sesión)**:
1. Diseñar una vista en `CS View _test` para el canal Teléfono que reemplace/complemente el modelo queue actual: serie por día con recibidas / contestadas / perdidas (+ opcional desglose de motivo).
2. Decidir el origen del cómputo: el cliente ya carga las calls en IndexedDB (`window.__CS_CALLS`); se puede computar client-side en `cs-view.render.js`, o agregar un endpoint que lo entregue agregado.
3. Validar con datos reales en `_test`, GO + snapshot, port a prod.

### Chat (Wotnot) — 🔴 GAP DE DATOS (requiere integración previa)

- **No existe** el stream de mensajes de Wotnot en la base. Solo hay tickets de canal "Chat" en Zendesk (`PanelCSTickets` con `canalNormalizado:"Chat"`), que **NO son** "mensajes perdidos/contestados".
- Para responder "mensajes perdidos y contestados por día" hay que **integrar Wotnot como fuente nueva**: workflow tipo `Wotnot Data v2` + colección (`PanelCSChats` o similar), análogo a Aircall/CS Data.
- Ya figuraba como **"Wotnot stream propio"** en el roadmap del proyecto (Milestone 6, fuera de alcance hasta ahora).
- **Es trabajo mayor** — primero la integración de datos, después la vista.

**Plan sugerido (nueva sesión, posterior a Teléfono)**:
1. Investigar la API de Wotnot (auth, endpoints de conversaciones/mensajes, qué marca "perdido" vs "contestado").
2. Diseñar workflow de sync incremental Wotnot → Mongo (mismo patrón cursor + upsert; **OJO al bug del upsert: `upsert` va en `parameters.upsert` raíz, no en `options`** — ver [[aprendizaje-n8n-mongodb-upsert]]).
3. Vista de Chat con mensajes perdidos/contestados por día.

---

## Resumen para retomar

| Canal | Datos | Esfuerzo | Orden sugerido |
|---|---|---|---|
| **Teléfono (Aircall)** | ✅ listos | Medio (solo vista) | **1º — entregable pronto a la VP** |
| **Chat (Wotnot)** | 🔴 no existen | Alto (integración + vista) | 2º — requiere integrar Wotnot primero |

**Otra mejora relacionada anotada aparte**: el KPI "Ingresos" por equipo mide `created_at` (creación), no entrada-al-equipo por escalamiento — para N2 eso subcuenta los escalados; requiere `ticket_events` (BRECHA 3, nunca implementada). No es lo que pide la VP acá, pero está en la misma familia de "lo que el panel mide vs lo que el negocio necesita".
