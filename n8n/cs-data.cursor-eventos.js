// CS Data — nodo "Cursor Eventos" (rama Schedule). C2b escalamientos.
// Calcula el start_time del incremental de ticket_events.
// Camino 2: el cursor arranca "ahora" en el primer run tras el deploy → cs-data solo
// computa escalamientos NUEVOS. El histórico (35.959 tickets) lo cubre el seed; el
// cliente preserva esos campos vía merge defensivo (dbMergeMany en index.html).
const sd = $getWorkflowStaticData('global');
const nowSec = Math.floor(Date.now() / 1000);
if (!sd.cache) sd.cache = {};
const cache = sd.cache;
let since;
if (typeof cache.events_cursor === 'number') {
  since = cache.events_cursor - 60;       // delta normal con solape de 60s
} else {
  since = nowSec - 90;                    // primer arranque = marca de despliegue
  cache.esc_since_unix = since;            // tickets creados >= esto: cs-data los computa entero
}
since = Math.min(since, nowSec - 90);      // Zendesk incremental exige start_time en el pasado
return [{ json: { events_since_unix: since } }];
