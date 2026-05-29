# Mapping de números Aircall → mesa de atención

> Documento de trabajo entre la **Líder de Customer Success** y el equipo del Panel CS.
> Última actualización del listado de números: **2026-05-27** (17.955 calls observadas).

## Para qué sirve este documento

El Panel CS muestra "Pérdidas por mesa y razón" cuando se filtra por **Aircall**. Esa tabla
agrupa las llamadas según a qué mesa pertenece cada número Aircall.

**Aircall no nos dice la mesa directamente** (el campo nativo `teams` viene vacío en todas
las calls — sería ideal que iC lo configurara en la consola Aircall, pero hoy no lo hace).
Por eso mantenemos manualmente esta tabla.

Cuando la líder revisa este doc y devuelve correcciones, se actualiza
[`outputs/cs-panel/n8n/cs-view.render.js`](n8n/cs-view.render.js) en el bloque
`MESA_BY_NUMBER` (buscar el comentario `Fase B — Mapping número Aircall → mesa`),
se hace deploy con `python scripts/deploy_cs_view.py mesa-update-YYYY-MM-DD` y los VPs
ven el cambio en el siguiente F5.

---

## Listado completo de números — clasificación actual

> Columna **#calls** = llamadas observadas en el seed Aircall del 2026-05-27 (rango 2026-01-01 al día).
> Columna **Mesa actual** = mapping vigente en el código.
> Columna **Confirmación líder** = espacio para que escribas la mesa correcta o ratifiques.

### IVRs principales (mayor volumen)

| Número en Aircall | #calls | Mesa actual | Confirmación líder |
|---|---:|---|---|
| `Soporte_IConstruye_IVR` | 6.779 | Soporte L1 | |
| `Soporte_Fact_Electrónica_IVR` | 3.357 | Fact. Electrónica | |
| `Sodexo` | 2.310 | Sodexo | |
| `Iconstruye` | 2.084 | Iconstruye (¿= Soporte L1?) | |
| `Portal Proveedores` | 850 | Portal Proveedores | |
| `Cobranzas_IVR` | 469 | Cobranzas | |
| `OC Segura` | 393 | OC Segura (¿mesa propia?) | |
| `TocToc` | 295 | TocToc | |
| `CasinoExpress` | 88 | CasinoExpress (¿mesa propia?) | |

### IVRs secundarios

| Número en Aircall | #calls | Mesa actual | Confirmación líder |
|---|---:|---|---|
| `Soporte Agilice` | 67 | Agilice | |
| `AdmPlataformas` | 31 | Adm Plataformas | |
| `SALFA` | 27 | SALFA (¿es cliente o mesa?) | |
| `PAP IC` | 17 | PAP | |
| `PAP DTE` | 12 | PAP | |
| `Soporte DTE Extendido` | 5 | DTE Extendido (¿se fusiona con FE?) | |
| `Financiamiento TocToc` | 4 | TocToc | |

### Internacional

| Número en Aircall | #calls | Mesa actual | Confirmación líder |
|---|---:|---|---|
| `IConstruye Colombia` | 23 | Internacional | |
| `IBuilder Perú` | 7 | Internacional | |
| `iBuilder México` | 4 | Internacional | |
| `IBuilder Colombia` | 1 | Internacional | |
| `Iconstruye Perú` | 3 | Internacional | |
| `Soporte SCM México` | 2 | Internacional | |

### Líneas directas a personas (atención personalizada, no IVR)

> **Pregunta abierta para la líder**: ¿cada persona pertenece a la mesa donde está asignada
> (ej. Jessica Vélez → Cobranzas) o todas van a una mesa única "Líneas directas"?

| Número en Aircall | #calls | Mesa actual | Confirmación líder |
|---|---:|---|---|
| `Jessica Vélez` | 364 | Líneas directas | |
| `Natalia Ruiz` | 279 | Líneas directas | |
| `Gloria Rebolledo` | 98 | Líneas directas | |
| `Alberto Mercado` | 45 | Líneas directas | |
| `Javiera Castro` | 15 | Líneas directas | |
| `Joel Campos` | 9 | Líneas directas | |
| `Monica Salas` | 7 | Líneas directas | |
| `Fernanda Lillo` | 4 | Líneas directas | |

### Sin clasificar — esperando definición

| Número en Aircall | #calls | Mesa actual | Confirmación líder |
|---|---:|---|---|
| `Libre 1` | 51 | Sin asignar | |
| `Libre 2` | 45 | Sin asignar | |
| `Libre 4` | 23 | Sin asignar | |
| `Libre  3` (doble espacio) | 4 | Sin asignar | |
| `56224861000` (número sin label en Aircall) | 183 | Sin asignar | |

---

## Mesas canónicas que el sistema reconoce

Si la líder propone una **mesa nueva** que no está en esta lista, agregar también en
`MESAS_CANONICAS` (mismo archivo render.js, justo encima de `MESA_BY_NUMBER`):

- Soporte L1
- Fact. Electrónica
- Sodexo
- Iconstruye
- Portal Proveedores
- Cobranzas
- OC Segura
- TocToc
- CasinoExpress
- Agilice
- DTE Extendido
- Adm Plataformas
- SALFA
- PAP
- Internacional
- Líneas directas
- Sin asignar *(fallback automático para números no listados)*

---

## Qué hace el sistema si Aircall agrega un número nuevo

Si un número aparece en Aircall pero NO está en `MESA_BY_NUMBER`, el sistema lo agrupa
automáticamente en **"Sin asignar"**. Aparecerá en la tabla "Pérdidas por mesa y razón" y será
detectable visualmente. Cuando eso pase:

1. Confirmar con la líder a qué mesa pertenece.
2. Agregar una línea nueva en `MESA_BY_NUMBER` siguiendo el formato existente.
3. Deploy.

---

## Cómo actualizar el mapping (procedimiento operativo)

Cuando la líder devuelva este doc con anotaciones:

1. Editar `outputs/cs-panel/n8n/cs-view.render.js` — buscar `var MESA_BY_NUMBER = {` y
   actualizar los valores. Cambiar también `MESAS_CANONICAS` si hay mesas nuevas.
2. Validar sintaxis: `node --check outputs/cs-panel/n8n/cs-view.render.js`
3. Deploy: `set -a; source .env.credentials; set +a` y
   `python outputs/cs-panel/scripts/deploy_cs_view.py mesa-update-$(date +%Y-%m-%d)`
4. Los VPs ven el cambio en el siguiente F5. Aplica retroactivo a TODAS las calls
   históricas + futuras automáticamente.

---

## Roadmap futuro: Teams nativos de Aircall (opcional)

Aircall tiene un concepto nativo de "Teams" que se configura en su consola — al
hacerlo, el campo `teams` de cada call viene poblado con el equipo del agente que
atendió. Hoy iC no usa esa funcionalidad (lista vacía en el 100% de las calls).

Si en algún momento iC decide configurarlos:
- Pros: mapping automático, sin mantenimiento manual.
- Contras: solo aplica a calls **futuras** (las históricas no se enriquecen).
- Migración recomendada: hacer el código usar `c.teams[0]` cuando está poblado,
  caer al `MESA_BY_NUMBER` como fallback para histórico y números no configurados.
