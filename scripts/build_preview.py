#!/usr/bin/env python3
"""build_preview.py — arma un preview local del Panel CS sin n8n.

Ensambla en outputs/cs-panel/preview-panel.html:
  - Chart.js (CDN)
  - cs-view.styles.css   (embebido)
  - cs-view.render.js    (embebido y ejecutado como en el cascarón)
  - data/seed.js         (referenciado por <script src> — debe existir al lado)

Sirve para validar visualmente cambios de cs-view ANTES de desplegar a n8n.
NO reemplaza el deploy: el panel real baja cs-view del workflow.

Uso:  python outputs/cs-panel/scripts/build_preview.py
"""
import json
import pathlib

BASE = pathlib.Path(__file__).resolve().parent.parent
css = (BASE / "n8n" / "cs-view.styles.css").read_text(encoding="utf-8")
render = (BASE / "n8n" / "cs-view.render.js").read_text(encoding="utf-8")
out = BASE / "preview-panel.html"

if not (BASE / "data" / "seed.js").exists():
    raise SystemExit("falta outputs/cs-panel/data/seed.js — generalo con carga_inicial.py")

html = """<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Preview — Panel CS</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@600;700;800&display=swap" rel="stylesheet">
<style>
__CSS__
</style>
</head>
<body>
<div id="app" data-theme="light"><div id="cs-body"></div></div>
<script src="data/seed.js"></script>
<script>
/* preview local — abre directo en Análisis · modo "Rango Pred." para ver el combo chart */
try { localStorage.setItem('csv-state', JSON.stringify({ tab:'ana', mode:'pred', predDias:10 })); } catch (e) {}
var RENDER = __RENDER__;
var seed = window.__CS_SEED || {};
var data = {
  tickets: seed.tickets || [],
  agents_by_id: seed.agents_by_id || {},
  orgs_by_id: seed.orgs_by_id || {},
  groups_by_id: seed.groups_by_id || {},
  meta: seed.meta || {}
};
var ctx = {
  bodyEl: document.getElementById('cs-body'),
  Chart: window.Chart,
  statusText: 'preview local · seed ' + (data.meta.generated_at || ''),
  actions: {}
};
try { new Function('data', 'ctx', RENDER)(data, ctx); }
catch (e) { document.getElementById('cs-body').innerHTML =
  '<pre style="padding:20px;color:#BB1A1A">Error en render: ' + (e && e.stack || e) + '</pre>'; }
</script>
</body>
</html>
"""

html = html.replace("__CSS__", css).replace("__RENDER__", json.dumps(render))
out.write_text(html, encoding="utf-8")
print(f"[preview] escrito → {out}  ({out.stat().st_size // 1024} KB)")
print("[preview] abrir con doble-click · requiere data/seed.js al lado")
