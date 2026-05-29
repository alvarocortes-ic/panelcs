---
titulo: Análisis diferencias CS Panel vs Zendesk Explore — Tickets fuera de SLA
fecha: 2026-05-20
generado: 2026-05-20 14:20 CLT (17:20 UTC)
audiencia: Alvaro · VP CS · equipo CS
sesion: SES-20260520-1259
---

# Análisis — Diferencias entre CS Panel y Zendesk Explore en "Tickets abiertos fuera de SLA"

> Fuentes comparadas en esta sesión:
> - `inputs/Ticket_abiertos_fuera_de_SLA_05202026_1305.csv` (Zendesk Explore export, 13:05 CLT)
> - `inputs/diferencias.xlsx` Hoja "Hoja1" (export del CS Panel realizado por VP, mismo día)
> - API Zendesk en vivo (re-consultada a las 14:17 CLT)

---

## TL;DR

1. **Nuestra LÓGICA es la misma que la de Zendesk Explore**. Aplicando nuestra fórmula contra la API de Zendesk en vivo hoy 14:17 CLT obtenemos **139 tickets fuera de SLA** en los 6 equipos. Zendesk Explore export a las 13:05 dio **143**. Las 8 diferencias contra el export y las 4 inversas son todas explicables por latencia y casos límite documentados — **no hay diferencia de criterio**.

2. **El número del CS Panel (115) está STALE — no es un error de cómputo, es un error de actualización**. El render del panel SOLO lee el booleano `sla_breached` que viene del enrichment, y ese campo **no se recalcula con el paso del tiempo**. Si a un ticket "se le vencía el SLA" entre dos cargas y no tuvo otro cambio en Zendesk (comentario, status, etc.), su campo `sla_breached` quedó congelado en `false`.

3. **Zendesk Explore NO está erróneo**. Nuestra data tampoco es "errónea" en lógica — está incompleta porque depende del *cache* del cliente. La fix tiene 3 opciones (sección 8) y la más correcta es **re-evaluar `sla_breached` en runtime usando `breach_at`** (mismo cálculo que hace `carga_inicial.py`).

---

## 1. Los tres números en juego (mismos 6 equipos, mismo día 2026-05-20)

| Fuente | Total fuera de SLA | Hora medición | Diferencia vs Zendesk Explore |
|---|---:|---|---:|
| **Zendesk Explore** (CSV export) | 143 | 13:05 CLT | — |
| **CS Panel del usuario** (lo que ve la VP) | 115 | en momento de revisión | **−28** |
| **Recálculo en vivo con API Zendesk + nuestra fórmula** | 139 | 14:17 CLT | **−4** |

Lectura:
- Zendesk Explore (13:05) y nuestra fórmula aplicada en vivo (14:17) son **prácticamente idénticos**. 135 tickets están en ambos. Las 8 diferencias del export son por solved entre 13:05 y 14:17 (6), un cambio de grupo (1) y un SLA `paused` (1). Las 4 del recálculo son tickets fresca-mente vencidos entre 13:05 y 14:17.
- El **CS Panel marca 115**, que es **24 menos** de lo que debería marcar (139). Esos 24 tickets son los que **se vencieron por paso del tiempo** sin disparar otro cambio en Zendesk.

### Breakdown por equipo (recálculo en vivo, 14:17 CLT)

| Equipo | Activos | Fuera SLA (nuestra fórmula) | Fuera SLA (Zendesk Explore 13:05) |
|---|---:|---:|---:|
| Soporte Nivel 2 | 110 | 84 | 86 |
| Customer Success | 47 | 41 | 43 |
| Soporte Nivel 1 CICFIN | 59 | 7 | 7 |
| Configuraciones | 69 | 4 | 4 |
| Enrolamientos Pendientes | 9 | 2 | 2 |
| Adm. de plataforma | 1 | 1 | 1 |
| **TOTAL** | **295** | **139** | **143** |

---

## 2. Cómo mide cada fuente

### Lógica de "fuera de SLA" — CS Panel

`outputs/cs-panel/scripts/carga_inicial.py:238` define la función `sla_breached(ticket, now_iso, solved_at)`:

```python
def sla_breached(ticket, now_iso, solved_at=None):
    pms = (ticket.get("slas") or {}).get("policy_metrics") or []
    if solved_at:
        return any(p.get("breach_at") and p["breach_at"] < solved_at for p in pms)
    return any(p.get("stage") == "active" 
               and p.get("breach_at") 
               and p["breach_at"] < now_iso 
               for p in pms)
```

Para un ticket **activo** (status `new`/`open`/`pending`/`hold`):
- `sla_breached = True` ⟺ existe ≥1 `policy_metric` con **`stage == "active"`** Y **`breach_at < now`**.

Esto coincide con lo que Zendesk muestra en su dashboard nativo "SLA": un SLA activo vencido.

### Lógica del CS Panel cliente (render)

`outputs/cs-panel/n8n/cs-view.render.js:1490`:

```javascript
var nFueraSla = base.filter(function(t){ 
    return ACTIVE[t.status] && t.sla_breached === true; 
}).length;
```

**No re-evalúa**: solo lee el booleano que vino del enrichment. Si `sla_breached` quedó `false` en el seed/delta y nunca se actualizó, el panel reporta `false`.

### Cómo se construye `sla_breached` en el flujo de datos

| Paso | Quién | Cuándo | Qué hace |
|---|---|---|---|
| 1. Seed inicial | `carga_inicial.py` | una vez (último: 2026-05-16 18:30 UTC) | Trae `slas.policy_metrics` para todos los activos + cerrados del periodo, calcula `sla_breached` y lo guarda en `seed.js` |
| 2. Delta incremental | n8n workflow `cs-data` | cada N minutos | Trae tickets modificados desde el último cursor (`/api/v2/incremental/tickets`) y los enriquece con `slas` → recalcula `sla_breached` SOLO para esos |
| 3. Render cliente | `cs-view.render.js` | cuando el usuario abre/refresca | Lee `t.sla_breached` tal cual, sin recalcular |

### Lógica de Zendesk Explore

Sin acceso al modelo de datos exacto del dashboard, el comportamiento observado del export coincide con la métrica nativa de Zendesk **"Tickets with breached SLA"** evaluada **en el momento del export**. Por la coincidencia de 135/143 con nuestra fórmula y los 8 desencuentros completamente explicables, **Zendesk Explore mide lo mismo que nosotros, pero lo mide en vivo cada vez que se ejecuta el dashboard**.

---

## 3. Por qué el CS Panel marca 115 — la causa raíz

El campo `sla_breached` es un booleano calculado en el momento en que el ticket fue enriquecido (seed o delta). Una vez seteado, **solo se actualiza si el ticket cambia en Zendesk** (comentario, cambio de status, asignación, etc.). El paso del tiempo NO dispara recálculo.

Consecuencia: un ticket creado el 2026-05-18 con SLA `agent_work_time` = 12h:
- A las 14:00 del 18-may entró al panel con `sla_breached = false` (todavía dentro del SLA).
- A las 2:00 del 19-may se le venció el SLA en Zendesk.
- Si entre 14:00 del 18-may y hoy no tuvo otro cambio, el panel **sigue mostrando `sla_breached = false`**.
- Zendesk Explore, al recalcular cada vez, lo muestra como fuera de SLA.

Esto coincide exactamente con los 15 tickets que la VP marcó en `diferencias.xlsx` como "fuera de SLA en Zendesk pero OK en el panel".

---

## 4. Validación ticket por ticket — los 15 conflictivos de la VP

Tomamos los 15 IDs que en `diferencias.xlsx` aparecen como "fuera de SLA en Zendesk" pero "OK en el panel", consultamos la API de Zendesk en vivo y revisamos sus `policy_metrics`:

| Ticket | Status | Creado | SLA metric | Stage | breach_at | ¿Vencido ahora? | Conclusión |
|---:|:---:|---|---|---|---|:---:|---|
| 1814965 | open | 2026-05-14 | agent_work_time | **active** | 2026-05-19 18:17 | **SÍ** | Panel debió decir True |
| 1815202 | solved | 2026-05-15 | agent_work_time | achieved | 2026-05-18 16:19 | n/a | Ya cerrado |
| 1815353 | open | 2026-05-15 | agent_work_time | **active** | 2026-05-18 23:36 | **SÍ** | Panel debió decir True |
| 1815448 | open | 2026-05-18 | agent_work_time | **active** | 2026-05-19 20:41 | **SÍ** | Panel debió decir True |
| 1815476 | open | 2026-05-18 | agent_work_time | **active** | 2026-05-19 14:59 | **SÍ** | Panel debió decir True |
| 1815583 | open | 2026-05-18 | agent_work_time | **active** | 2026-05-19 17:27 | **SÍ** | Panel debió decir True |
| 1815624 | open | 2026-05-18 | agent_work_time | **active** | 2026-05-19 19:02 | **SÍ** | Panel debió decir True |
| 1815627 | open | 2026-05-18 | agent_work_time | **active** | 2026-05-19 22:54 | **SÍ** | Panel debió decir True |
| 1815641 | open | 2026-05-18 | agent_work_time | **active** | 2026-05-19 19:28 | **SÍ** | Panel debió decir True |
| 1815670 | open | 2026-05-18 | agent_work_time | **active** | 2026-05-19 21:56 | **SÍ** | Panel debió decir True |
| 1815703 | open | 2026-05-18 | agent_work_time | **active** | 2026-05-19 20:54 | **SÍ** | Panel debió decir True |
| 1815792 | open | 2026-05-19 | agent_work_time | **active** | 2026-05-20 14:01 | **SÍ** | Panel debió decir True |
| 1815828 | open | 2026-05-19 | agent_work_time | **active** | 2026-05-20 14:47 | **SÍ** | Panel debió decir True |
| 1815834 | open | 2026-05-19 | agent_work_time | **active** | 2026-05-20 14:56 | **SÍ** | Panel debió decir True |
| 1815880 | open | 2026-05-19 | agent_work_time | **active** | 2026-05-20 13:19 | **SÍ** | Panel debió decir True |

**14 de los 15 tickets que la VP marcó como diferencia están objetivamente fuera de SLA según la propia lógica de nuestro panel**. El 15º (1815202) ya está solved y por eso ahora no aplica, pero al momento del export Zendesk (13:05) estaba activo y vencido.

**Veredicto sobre la marca de la VP: 15/15 correctas. Las diferencias que detectó son reales y el problema está en nuestro panel, no en Zendesk.**

---

## 5. Las 8 diferencias entre Zendesk Explore export y recálculo en vivo

Esta es la comparación entre lo que mostró el CSV de Zendesk Explore a las 13:05 y lo que dice nuestra fórmula aplicada en vivo a las 14:17 (mismo método de cálculo, distinta hora):

| Ticket | Cliente | Status (14:17) | Razón de la diferencia |
|---:|---|:---:|---|
| 1802967 | CEGA LIFTING SPA | **solved** | Resolución entre 13:05 y 14:17 (updated 16:40) |
| 1807473 | CONPAX | **solved** | Resolución entre 13:05 y 14:17 (updated 17:14) |
| 1813032 | CARRAN | **pending** | SLA `agent_work_time` en stage `paused` — esperando respuesta cliente. Caso límite: Zendesk lo lista porque hubo breach; nuestra fórmula lo descarta porque el SLA no está active. |
| 1814638 | Vital | **solved** | Resolución entre 13:05 y 14:17 (updated 16:07) |
| 1814885 | VILICIC | **solved** | Resolución entre 13:05 y 14:17 (updated 15:21) |
| 1815174 | CONSTRUCTORAH | **solved** | Resolución entre 13:05 y 14:17 (updated 15:51) |
| 1815202 | EmpresasSocovesa | **solved** | Resolución entre 13:05 y 14:17 (updated 16:31) |
| 1815880 | SODEXO | open, **otro grupo** | Cambió del grupo Soporte N2 al grupo `4681656062107` (Mesa de Operaciones) entre 13:05 y 14:17 |

Las 8 diferencias se distribuyen así:
- **6 tickets** (75%) — resueltos entre el export y nuestro recálculo. Latencia natural, nada que arreglar.
- **1 ticket** — cambió de grupo, salió de los 6 equipos.
- **1 ticket** — SLA en stage `paused` (esperando cliente). Caso de diseño: si el ticket está `pending` esperando al cliente, *strictly speaking* el SLA del agente no está corriendo. Zendesk Explore lo lista igual; nuestra fórmula no. **Esto no es un bug nuestro; es una elección de diseño defendible (no contar como "fuera de SLA" tickets que dependen del cliente).** Es una conversación a tener con la VP si quiere igualar Zendesk Explore.

---

## 6. Validación cruzada — Hoja1 (export CS Panel de la VP) ES nuestro panel

Para confirmar que Hoja1 corresponde a nuestro CS Panel (y no a otra herramienta), cruzamos los campos contra el seed:

- **70 de 107 IDs** de Hoja1 están en el seed (los otros 37 fueron creados después del 16-may, vienen del delta n8n).
- De los 70: **68 tienen `linea_negocio` + `nivel` + `categoria` idénticos** entre Hoja1 y seed. Solo 2 mismatches menores (cambios de categoría/producto en producción).
- De los 70: la correspondencia entre seed.`sla_breached` y Hoja1.`sla_state` es:
  - 57 (seed True ↔ Hoja Vencido) ✓
  - 7 (seed False ↔ Hoja OK) ✓
  - 6 (seed False → Hoja Vencido) — actualizados por el delta n8n al cambiar el ticket
  - 0 (seed True → Hoja OK) — coherencia perfecta en esa dirección

**Conclusión**: Hoja1 = export literal del CS Panel. Lo que ve la VP es nuestro panel.

---

## 7. Por qué a veces el delta SÍ actualiza `sla_breached` y a veces no

Hay 6 tickets en Hoja1 que figuraban como `sla_breached=false` en el seed (16-may) y aparecen como **Vencido** en Hoja1 (panel actual). Esto significa que el delta de `cs-data` **sí los re-enriqueció**.

¿Por qué? Porque esos 6 tickets **tuvieron algún cambio en Zendesk entre el 16-may y hoy** (un comentario, un cambio de status, una reasignación). Ese cambio los hizo entrar al delta incremental, y al re-enriquecer con `slas` se recalculó `sla_breached`.

Los otros tickets que necesitan actualización pero NO tienen cambio recién en Zendesk quedan stale. Eso es exactamente lo que pasa con los 15 conflictivos de la VP.

---

## 8. Recomendaciones de fix

Tres opciones, de menor a mayor esfuerzo:

### Opción A — Re-evaluar `sla_breached` en runtime usando `breach_at` (recomendado)

**Esfuerzo**: bajo · 1-2 horas + deploy.

Cambio en dos lugares:

1. **Server (`carga_inicial.py` + workflow `cs-data` de n8n)**: guardar también la lista mínima `policy_metrics_active` por ticket — solo los `breach_at` de SLAs en stage `active`. Schema:
   ```json
   {
     "id": 1815448,
     "sla_breached": false,           // ← se mantiene para compat
     "sla_active_breaches": [          // ← NUEVO
       { "metric": "agent_work_time", "breach_at": "2026-05-19T20:41:38Z" }
     ]
   }
   ```

2. **Cliente (`cs-view.render.js`)**: agregar helper `isSlaBreachedLive(t)` que use:
   ```javascript
   function isSlaBreachedLive(t){
     if (!ACTIVE[t.status]) return false;
     if (Array.isArray(t.sla_active_breaches) && t.sla_active_breaches.length){
       var nowIso = new Date().toISOString();
       return t.sla_active_breaches.some(function(p){ return p.breach_at && p.breach_at < nowIso; });
     }
     return t.sla_breached === true;  // fallback al booleano viejo
   }
   ```
   Reemplazar todas las ocurrencias de `t.sla_breached === true` por `isSlaBreachedLive(t)`.

**Resultado**: el panel evalúa el SLA en cada paint, sin depender del cache. Los tickets cuyo SLA "se vence solo" se detectan al instante.

### Opción B — Refresh periódico server-side de los activos (alternativo)

**Esfuerzo**: medio · cambio en workflow n8n + costo de API calls.

Cada 30-60 min, el workflow n8n debe hacer un `show_many` con `include=slas` de TODOS los tickets activos (no solo los que cambiaron), recalcular `sla_breached` y publicar al delta.

Pro: cliente no cambia.
Contra: ~500 tickets × 1 call = 5 batches de `show_many` cada 30 min, gasto de API calls Zendesk constante. Es escalable pero menos elegante que A.

### Opción C — Recompute completo al cargar el panel (más simple, menos eficiente)

**Esfuerzo**: alto · el cliente hace un fetch a Zendesk en cada carga.

El cliente, al cargar, hace una llamada masiva para traer `slas` de todos sus tickets activos y los enriquece. Esto contradice la arquitectura "cache local + delta" del panel y multiplica el tiempo de boot.

**No recomendado.**

---

## 9. Lo que NO se pudo verificar

- El **modelo exacto** de cálculo del dashboard Zendesk Explore (no expusieron el query interno). Lo que sabemos es empírico: coincide al 94.4% con nuestra fórmula y las 8 diferencias son explicables. No hay evidencia de criterio distinto.
- La **periodicidad real** del workflow `cs-data` Schedule de n8n (cada cuántos minutos corre). Si corre cada 60 min en vez de cada 5, el problema de stale se acentúa pero no cambia de naturaleza.

---

## 10. Apéndice — archivos generados en esta carpeta

| Archivo | Contenido |
|---|---|
| `INFORME.md` | Este informe |
| `snapshot.json` | Datos en vivo de la API Zendesk al 2026-05-20 14:17 CLT |
| `cruce-detalle.csv` | Cruce ticket-por-ticket (export Zendesk + activos en vivo + nuestra fórmula + policy_metrics) |

---

## 11. Punto bottom-line para la VP

> **No estamos midiendo distinto. Estamos midiendo lo mismo pero con datos congelados.**
>
> Los 15 tickets que marcó como diferencia están objetivamente fuera de SLA hoy según la propia API de Zendesk. Nuestro panel los marca OK porque no re-evalúa el campo `sla_breached` cuando el SLA se vence únicamente por paso del tiempo. Zendesk Explore re-evalúa cada vez que se ejecuta y por eso sí los muestra.
>
> El fix correcto es la **Opción A** (re-eval en runtime con `breach_at`). Es local al panel, no requiere cambios mayores ni costo de API extra, y deja el panel y Zendesk Explore alineados en cualquier momento del día.
