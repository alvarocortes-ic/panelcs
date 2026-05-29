# Panel CS — Auto-refresh 5 min + eliminar "Actualizar" (validado en _test)

> SES-20260528-2114. Enfoque del usuario: solo n8n toca Zendesk (Schedule 5 min);
> el cliente solo lee de Mongo (recachear N veces no pega a Zendesk).

## Modelo de datos (confirmado)

```
Zendesk  ──(incremental export, SOLO n8n, cada 5 min)──>  Mongo (PanelCSTickets/Calls)
                                                              │
Cliente (panel) ──(GET /cs-data, /cs-seed, /aircall-data)────┘   ← find en Mongo, NUNCA Zendesk
```

- **Única vía a Zendesk**: Schedule de `CS Data v2` / `Aircall Data v2` (n8n), cada 5 min.
- **El cliente** baja seed (1ª vez) + deltas. Todo desde Mongo vía webhooks n8n. Recachear/refrescar = más lecturas a Mongo, **cero** tráfico a Zendesk.

## Cambios implementados

### 1. `n8n/cs-view.render.js` (render del panel)
- **Eliminado** el botón "Actualizar" (`data-act="refresh"`) del header.
- **Expuesto** `window.__csSyncCalls = _acSync` para que el loader sincronice las calls Aircall en el auto-refresh.
- "Re-cachear", "Exportar", tema: se mantienen.

### 2. `index.html` (loader, cliente)
- **Auto-refresh cada 5 min** (`startAutoRefresh` + `setInterval`, idempotente): `syncAll()` = tickets (`/cs-data`) + calls (`/aircall-data`) + repaint. Silencioso, status "Auto-actualizado HH:MM".
- Sin botón manual de actualización. El usuario no fuerza fetch sobre Zendesk.

### 3. `scripts/deploy_cs_view.py`
- Soporta `--test`: despliega al `CS View _test` reescribiendo endpoints a `-test` (excepto `cs-dte-health` → productivo). Fix SSL certifi (Mac).

## Análisis del ritmo de 5 min (sostenibilidad)

| Aspecto | Resultado |
|---|---|
| Schedule incremental export | ≤5 req por corrida / cada 5 min ≈ **1 req/min** vs límite **10/min** → ~90% headroom |
| Cursor productivo | Avanza cada ~5 min (verificado: updatedAt sigue al reloj) → flujo completa OK |
| 429 cuándo aparece | Solo con consumo concurrente de la cuota: carga manual (`carga_inicial.py`) o el sync `_test` (misma credencial Zendesk) |
| Mitigación carga manual | `pause_resume_schedule.py pause` antes de cargar, `resume` al terminar |
| Cliente concurrente (Mongo) | 12 GET concurrentes a `/cs-data-test` → 200 en 2.2s total, count consistente → N usuarios sin tocar Zendesk |

**Veredicto**: 5 min como tope es viable. Pérdida de datos por 429 = nula (Save Cursor es el último nodo; si la corrida falla, reintenta el mismo rango la siguiente).

## Validado en `_test`

- `/cs-view-test`: HTML sin botón "Actualizar", con `__csSyncCalls`, endpoints `-test` (+ `cs-dte` productivo).
- `index-test.html`: loader con auto-refresh apuntando a `-test`.
- Carga concurrente OK; sync `_test` dispara y completa (200, cursor `_test` avanza).

## Port a producción (pendiente de GO — requiere coordinar el loader local)

1. `python outputs/cs-panel/scripts/deploy_cs_view.py panel-autorefresh-2026-05-28` (sin `--test`) → CS View prod pierde el botón "Actualizar".
2. El **loader `index.html` es local** (file:// del usuario). Para tener el auto-refresh, el usuario debe usar el `index.html` nuevo (git pull). 
   - **Orden seguro**: actualizar el `index.html` local Y desplegar el render juntos, para no dejar el panel sin "Actualizar" ni auto-refresh.
3. Snapshot del CS View prod antes del deploy; verificar GET `/cs-view` (HTML sirve, sin botón, endpoints **productivos**); rollback si falla.
