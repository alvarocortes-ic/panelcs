# Panel CS — iConstruye

Dashboard de Customer Service: estado del queue de Zendesk, movimientos de la jornada,
análisis semanal, análisis por período, escalamientos SN1→SN2→MO.

> Arquitectura **v2 (HTML único)** — 2026-05-16. La v1 (2 archivos) quedó en `_prev-v1/`.
> Ficha de contexto: `ICClaudeVault/proyectos/cs-panel.md`.

---

## 1. Arquitectura — "HTML único + n8n"

Se entrega **un solo `index.html`**. Es un loader mínimo: no contiene ni el diseño ni
los datos — los baja de n8n. Se entrega una vez y no se reenvía nunca más.

> **Panel online por diseño.** Es un dashboard en vivo: el primer arranque y los datos
> frescos requieren conexión a n8n. El uso offline no es un objetivo del producto — el
> fallback sin conexión solo evita una pantalla en blanco con datos ya cargados.

```mermaid
flowchart LR
  subgraph local["Equipo del usuario"]
    H["index.html\n(loader, ~14 KB, file://)"]
    IDB[("IndexedDB\nstore: tickets")]
  end
  subgraph n8n["n8n — prod-low-code.iconstruye.dev"]
    CV["cs-view\nCSS + render + header"]
    CS["cs-seed\nseed completo (gzip)"]
    CD["cs-data\ndeltas + sync"]
  end
  ZD["Zendesk API"]
  H -->|GET /cs-view| CV
  H -->|GET /cs-seed · 1ª vez| CS
  H -->|GET /cs-data?since=| CD
  CS -.poblado por carga_inicial.py.- ZD
  CD <-->|Schedule 5 min| ZD
  CS --> IDB
  CD --> IDB
```

| Capa | Qué es | Vive en |
|---|---|---|
| **Cascarón** | `index.html` — loader: IndexedDB, sync, login. Sin diseño ni datos. | repo `index.html` (se abre con `file://`) |
| **Presentación** | CSS + `render()` + **header** del panel | workflow n8n `cs-view` ← repo `n8n/cs-view.*` |
| **Datos — seed** | Dataset histórico completo, comprimido | workflow n8n `cs-seed` ← `carga_inicial.py` |
| **Datos — deltas** | Sync incremental con Zendesk | workflow n8n `cs-data` |

**Regla de oro:** todo cambio se hace **en el repo**, nunca a mano en el editor de n8n.

---

## 2. Archivos del repo

```
outputs/cs-panel/
├── index.html                    el HTML único que se entrega al usuario
├── data/seed.js                  respaldo local del seed (gitignored, regenerable)
├── n8n/
│   ├── cs-view.styles.css        CSS del panel (header incluido)  ─┐ fuente de cs-view
│   ├── cs-view.render.js         render(data,ctx) — dibuja todo   ─┘
│   ├── cs-data.cursor-eventos.js nodo de cs-data (referencia)
│   └── cs-data.merge-events.js   nodo de cs-data (referencia)
├── scripts/
│   ├── carga_inicial.py          genera el seed y lo publica a cs-seed
│   ├── deploy_cs_view.py         publica cs-view.* al workflow n8n
│   ├── build_preview.py          arma preview-panel.html local (validar sin n8n)
│   └── setup_cs_seed.py          crea/actualiza el workflow CS Seed
├── preview-panel.html             preview local (regenerable, gitignored)
├── _prev-v1/                     snapshot de la arquitectura previa (2 archivos)
├── MEJORAS.md                    backlog de mejoras
└── README.md                     este archivo
```

---

## 3. Workflows n8n

Instancia: `https://prod-low-code.iconstruye.dev` · API `…/api/v1`
(credenciales en `.env.credentials`: `N8N_API_URL`, `N8N_API_KEY`, `CS_SEED_TOKEN`).

| Workflow | ID | Webhook | Función |
|---|---|---|---|
| **CS View** | `kQmPeDgXA27mKQPj` | `GET /webhook/cs-view` | Presentación: `{version, css, js}` |
| **CS Seed** | `SXt8GRp5zjKKNfh6` | `GET /webhook/cs-seed` · `POST` | Sirve el dataset (GET) · lo recibe de `carga_inicial.py` (POST, con token) |
| **CS Data** | `akkbfUdsiXEg57LK` | `GET /webhook/cs-data?since=` | Deltas incrementales; `Schedule` cada 5 min |
| **CS Errores** | `o89xKbjT6mKkjAmN` | `GET /webhook/cs-errors` | Log de errores de ejecuciones n8n |
| **CS Auth / Email** | — | `…/cs-auth/*` | Login OTP — **en pausa** (correo Eclipse bloqueado) |

---

## 4. Cómo hacer cambios

### 4.1 Cambio visual o de contenido del panel — incluido el header

Header, KPIs, tablas, charts, colores, filtros, tabs, modales → todo es **cs-view**.

| Qué cambiar | Archivo |
|---|---|
| Colores, tipografía, layout, sticky, header (estilos) | `n8n/cs-view.styles.css` |
| Header (estructura), KPIs/tablas/charts, cálculos | `n8n/cs-view.render.js` |

```
1. Editar n8n/cs-view.styles.css y/o n8n/cs-view.render.js
2. node --check outputs/cs-panel/n8n/cs-view.render.js
2b. (opcional) python outputs/cs-panel/scripts/build_preview.py
    → abrir preview-panel.html para validar local antes de tocar n8n
3. set -a; source .env.credentials; set +a
   python outputs/cs-panel/scripts/deploy_cs_view.py
4. git commit
5. El usuario aprieta F5  ← el panel baja la versión nueva. Cero archivos.
```

> El **deploy a n8n es producción compartida** — se ejecuta solo con autorización
> explícita. Para iterar sin desplegar, usar `build_preview.py` (paso 2b).

### 4.2 Actualizar los datos

#### 4.2.a Flujo legacy (full refetch, ~25-40 min)

```
set -a; source .env.credentials; set +a
python outputs/cs-panel/scripts/carga_inicial.py     # regenera todo y PUBLICA a cs-seed
python outputs/cs-panel/scripts/carga_inicial_aircall.py
```

Refetchea desde Zendesk/Aircall y publica el seed gzipeado. Usar cuando hay drift
sospechado o el raw cache local no existe.

#### 4.2.b Flujo nuevo raw/build (incremental, 30s para reshape)

> Refactor de Fase A — 2026-05-26. Separa **fetch** (raw append-only) de **build**
> (dedup + slim + publish). Permite re-shape del slim sin refetchear desde la API.

```
set -a; source .env.credentials; set +a

# Primera vez (o si se borró el raw): refetch incremental al raw local — ~25-40 min
python outputs/cs-panel/scripts/cs-fetch.py --since 2026-01-01

# Build local + publish a n8n — ~30s
python outputs/cs-panel/scripts/cs-build.py

# Subsequent: fetch incremental (solo deltas desde el cursor, segundos) + build
python outputs/cs-panel/scripts/cs-fetch.py
python outputs/cs-panel/scripts/cs-build.py
```

**Estructura local**:

```
outputs/cs-panel/
├── data/raw/                          ← gitignored, cache de aceleración
│   ├── zendesk/tickets/2026-*.jsonl.gz
│   ├── zendesk/enrichment/...
│   ├── zendesk/ticket_events/...
│   ├── zendesk/sideloads/...
│   └── aircall/calls/2026-*.jsonl.gz
├── state/cursor.json                  ← TRACKED en git, ~2KB, deltas-from-here
└── scripts/
    ├── cs-fetch.py                    ← fetch incremental → raw
    ├── cs-build.py                    ← raw → dedup → slim → publish
    └── lib/
        ├── raw_cache.py               ← append/read/dedup jsonl.gz
        ├── cursor.py                  ← read/write state/cursor.json
        ├── fetch_zendesk.py           ← wrapper sobre carga_inicial.py
        └── fetch_aircall.py           ← wrapper sobre carga_inicial_aircall.py
```

**Por qué dos flujos paralelos**: el legacy queda intacto y soportado. El nuevo es opt-in
mientras se valida. Si cambia el shape de `slim_ticket()` (ej. nuevo custom field):

| Antes | Después |
|---|---|
| Editar `slim_ticket` → correr `carga_inicial.py` → 40 min | Editar `slim_ticket` → correr `cs-build.py` → 30s |

**Stats del raw**: `python outputs/cs-panel/scripts/cs-fetch.py --stats` (no toca API).

**Otra máquina**: clona el repo y corre `cs-fetch.py` sin `--since` → arranca desde el cursor
versionado, baja solo los deltas (no refetchea desde 2026-01-01).

### 4.3 Actualizar mapping de mesas Aircall

Cuando la líder de CS confirma/corrige a qué mesa pertenece cada número Aircall:

1. Leer guía completa en [`MAPPING-MESAS.md`](MAPPING-MESAS.md).
2. Editar `n8n/cs-view.render.js` → buscar el bloque `var MESA_BY_NUMBER = {`.
3. Validar: `node --check outputs/cs-panel/n8n/cs-view.render.js`
4. Deploy: `set -a; source .env.credentials; set +a` +
   `python outputs/cs-panel/scripts/deploy_cs_view.py mesa-update-$(date +%Y-%m-%d)`

El cambio aplica retroactivo a las ~18.000 calls históricas + a todas las futuras.
Los VPs lo ven en el próximo F5.

### 4.4 Cambio del workflow cs-data

Se mantiene en n8n vía API (MCP `n8n-mcp`). Los nodos de código se versionan como
referencia en `n8n/cs-data.*.js`.

### 4.5 Cambio del cascarón `index.html`

`index.html` es un loader mínimo y estable: IndexedDB, los 3 fetch, el ciclo de
arranque y el login. **Casi nunca se toca.** Si se toca, sí hay que reenviarlo —
pero ese es el único caso, y es excepcional.

### Resumen

| Cambio | Editar | Publicar | El usuario |
|---|---|---|---|
| Visual / contenido / **header** | `n8n/cs-view.*` | `deploy_cs_view.py` | F5 |
| Datos (refresco o campos nuevos) | — | `carga_inicial.py` | botón "Re-cachear" |
| Pipeline de deltas | workflow `cs-data` | — | — |
| Mecánica del loader | `index.html` | reenviar el archivo (raro) | reemplazar |

---

## 5. Flujo de datos

- **1ª vez:** `index.html` ve IndexedDB vacía → `GET /cs-seed` → descomprime (gzip) →
  vuelca a IndexedDB.
- **Sync:** `GET /cs-data?since=<cursor>` → delta → `dbMergeMany` (preserva campos que el
  delta no trae — C2b escalamientos).
- **Caché de cs-data:** `Schedule` cada 5 min trae el incremental de Zendesk.
- **Presentación:** `GET /cs-view` → `render()` ejecutado con `new Function`.
- IndexedDB es **persistente y acumulativa** — el panel nunca pierde lo ya cargado.

---

## 6. Entrega a usuarios finales (VP, Head of CS)

### Qué se les entrega

**Un solo archivo: `index.html`** (~14 KB). Se abre con doble-click. La 1ª vez baja los
datos de n8n (unos segundos) y queda operativo.

### Qué pasa cuando se actualiza algo

| Tipo de cambio | ¿Reenviar archivo? |
|---|---|
| Visual / contenido / header del panel | **No** — F5 |
| Datos (refresco, campos nuevos) | **No** — botón "Re-cachear" |
| Mecánica del loader (`index.html`) | Sí, pero es excepcional |

El `index.html` se entrega **una vez**. Las actualizaciones de diseño y de datos llegan
solas desde n8n. Solo un cambio en la mecánica interna del loader obligaría a reenviarlo.

---

## 7. Tab Análisis — modos de período

El control **Modo** del tab Análisis tiene 3 opciones:

| Modo | Período | Notas |
|---|---|---|
| **Día** | un día | gráficos por hora |
| **Rango Pred.** | últimos N días hábiles (10/15/30/60) | combo Recibidos/Atendidos/Bolsa |
| **Rango** | rango de fechas libre | granularidad día/semana/mes |

### Combo de flujo — Análisis semanal + Análisis

El gráfico de flujo de **ambos** tabs es el combo **Ingresos vs. atendidos vs.
bolsa al cierre del día**:

| Serie | Tipo | Eje | Cálculo |
|---|---|---|---|
| Ingresos | línea | izq. | tickets creados en el bucket |
| Atendidos (resueltos/cerrados) | línea | izq. | tickets que salieron de la bolsa |
| Cerrados (auto) | línea punteada | izq. | tickets con `closed_at` en el bucket |
| Bolsa al cierre del día | barra | der. | backlog abierto al cierre del bucket |

- Tab **Análisis semanal**: buckets = la semana en curso (Lun–Vie).
- Tab **Análisis**, modo **Rango Pred.** / **Rango**: buckets = días hábiles.
- Tab **Análisis**, modo **Día**: buckets = horas, sin bolsa.
- Solo días hábiles (Lun–Vie sin feriados), respeta el filtro Equipo/Tipo.
- Cálculo en `flujoBuckets()` + dibujo en `comboFlujoChart()` (`cs-view.render.js`).
- Paleta del design system iC: Azul `#0047BB` · Verde `#17A24F` · Gris `#425563` · Naranjo `#FF6A00`.

> Nomenclatura: todo KPI/serie de tickets que ingresan a la plataforma se llama **"Ingreso(s)"**.

## 8. Estado actual (2026-05-18)

- ✅ Arquitectura v2 — HTML único. `index.html` loader + `cs-view`/`cs-seed`/`cs-data`.
- ✅ Panel: tabs En vivo · Análisis semanal · Análisis. Seed = 35.959 tickets.
- ✅ C1 categorías · C2 escalamientos SN1→SN2→MO · C3 SLA histórico · FRT 64 %.
- ✅ Modo **Rango Pred.** en Análisis + combo de flujo 4 series en ambos tabs (2026-05-18).
- ⏸️ Login OTP en pausa — infra de correo Eclipse bloqueada (`REQUIRE_LOGIN=false`).
- Backlog: `MEJORAS.md`.
