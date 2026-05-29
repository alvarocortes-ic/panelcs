# Panel CS — versión previa (v1, 2 archivos)

Snapshot del panel al **2026-05-16**, antes del refactor a **HTML único**.

## Arquitectura de esta versión (v1)

Entrega = **2 archivos**: `index.html` + `data/seed.js`.

- `index.html` — cascarón: header hardcodeado + login OTP + IndexedDB + sync.
- `cs-view.render.js` / `cs-view.styles.css` — presentación (workflow n8n `cs-view`).
- El seed se cargaba con `<script src="data/seed.js">` (archivo local aparte).

## Por qué se reemplazó

El objetivo era entregar **un solo HTML**. Esta versión tenía dos brechas:
1. El header vivía en `index.html` → cambiarlo obligaba a reenviar el archivo.
2. El seed era un archivo local aparte (`data/seed.js`).

El refactor v2 mueve el header a `cs-view` y unifica todo en un solo `index.html`.

> Restauración: estos archivos son la copia tal cual estaban. Git tag: `cs-panel-v1`.
