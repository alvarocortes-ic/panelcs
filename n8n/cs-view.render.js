/* ============================================================
   cs-view — render(data, ctx) del Panel CS · iConstruye
   Fuente versionada. Deploy: assignment "js" del nodo
   "Construir Vista" (workflow CS View) vía deploy_cs_view.py

   Se ejecuta vía  new Function('data','ctx', <este archivo>)
   en el cascarón index.html.
     data: { tickets, agents_by_id, orgs_by_id, groups_by_id, meta }
     ctx:  { bodyEl, Chart }

   Tabs: En vivo · Análisis semanal · Análisis · Clientes.
   Milestone mejoras Fase A (ver outputs/cs-panel/MEJORAS.md).
   ============================================================ */
var BODY = ctx.bodyEl;
var CHART = ctx.Chart || (typeof window !== 'undefined' ? window.Chart : null);
var CTX_STATUS  = (ctx && ctx.statusText) || '';   /* texto de estado del cascarón */
var CTX_ACTIONS = (ctx && ctx.actions) || {};      /* refresh / recache / toggleTheme */
var T_ALL = data.tickets || [];               /* universo completo, no se filtra */
var AG = data.agents_by_id || {};
var GR = data.groups_by_id || {};
var OR = data.orgs_by_id || {};

/* Fase B — CALLS Aircall.
 * IMPORTANTE: el loader (index.html) NO baja aircall-seed/data. El render lo
 * hace por su cuenta para no requerir actualizar el HTML local de los VPs
 * (regla fundamental del README §1: "se entrega una vez y no se reenvía").
 * Persistencia: IndexedDB 'cs-aircall' abierta desde el render. Sobrevive a F5.
 * window.__CS_CALLS es solo cache de paint (se hidrata desde IDB al inicio). */
var CALLS_ALL = (typeof window !== 'undefined' && window.__CS_CALLS) ? window.__CS_CALLS : [];

/* T y CALLS se completan más abajo, después de leer S.channel del localStorage */
var T = T_ALL;
var CALLS = CALLS_ALL;
var GROUPS_ACTIVOS = {};

/* ---- estado de UI (persistido entre paints vía localStorage) ---- */
var SKEY = 'csv-state';
var S;
try { S = JSON.parse(localStorage.getItem(SKEY)) || {}; } catch (e) { S = {}; }
S.tab  = S.tab  || 'live';
/* Fase C — migración: el tab 'dte' (DTE Health) se renombró a 'extras' (Paneles
 * Extras). Si el usuario tenía guardado 'dte', migrar a 'extras' + auto-abrir
 * el panel DTE como herramienta activa. */
if (S.tab === 'dte') { S.tab = 'extras'; S.extraView = S.extraView || 'dte'; }
if (typeof S.extraView !== 'string') S.extraView = '';

/* Selector de canal global. Valores: 'all' | 'zd' | 'ac' | 'wn'
 *   all = Todos los canales · zd = Zendesk (universo total de tickets, todos los canales)
 *   ac  = Teléfono (Aircall) · wn = Chat (Wotnot vía Zendesk hasta deploy stream propio)
 * Re-encuadre 2026-05-28: 'zd' pasó de "Correo only" a "universo total Zendesk".
 * Aplica filtros transversales a todos los tabs. */
S.channel = S.channel || 'all';
if (!{all:1, zd:1, ac:1, wn:1}[S.channel]) S.channel = 'all';

/* Fase B — T/CALLS/GROUPS_ACTIVOS se derivan en applyChannelFilter() — definida
 * más abajo. Se invoca al inicio de cada repaint() para que el cambio de canal
 * surta efecto inmediato. El primer paint la llama vía repaint() al final del módulo. */
/* migración del legacy S.gid (single) → S.gids (array multi). undefined = todos. */
if (typeof S.gid !== 'undefined'){
  if (typeof S.gids === 'undefined') S.gids = S.gid ? [String(S.gid)] : undefined;
  delete S.gid;
}
if (typeof S.gidsOpen !== 'boolean') S.gidsOpen = false;
S.type = S.type || '';
S.mode = S.mode || 'day';
if (S.predDias == null) S.predDias = 10;            /* modo "Rango Pred." — días hábiles */
S.gran = S.gran || 'week';
S.weekAgent = S.weekAgent || '';                   /* filtro de ejecutivo del tab semanal */
if (typeof S.weekOffset !== 'number') S.weekOffset = 0;  /* 0=semana actual · -1=anterior … */
if (typeof S.workdays !== 'boolean') S.workdays = false;
if (S.org == null) S.org = '';
S.orgPage     = S.orgPage     || 0;   /* histórico paginado */
S.orgActPage  = S.orgActPage  || 0;   /* tickets activos paginados */
S.orgEjecPage = S.orgEjecPage || 0;   /* ejecutivos paginados */
S.orgTopPage  = S.orgTopPage  || 0;   /* top clientes paginado */
if (typeof S.orgHistVisible !== 'boolean') S.orgHistVisible = false;
if (!S.orgActSort || typeof S.orgActSort !== 'object') S.orgActSort = { key:'default', dir:1 };
/* Estado del panel "Análisis/Exportador Tickets por Rango" (HU 5 — Tab Cliente 2026-05-28).
 * from/to en formato YYYY-MM-DD. Default: últimos 30 días (calculado en buildOrgExportador). */
if (!S.orgExp || typeof S.orgExp !== 'object') S.orgExp = { from:'', to:'' };
/* Paginación del modal "Ver datos filtrados" (HU 5 — feedback v2 2026-05-28) */
if (typeof S.orgExpModalPage !== 'number') S.orgExpModalPage = 0;
/* Estado del tab DTE Health */
if (typeof S.dtePage !== 'number') S.dtePage = 0;
if (!S.dteSort || typeof S.dteSort !== 'object') S.dteSort = { key:'estado', dir:-1 }; /* Error primero */
if (!S.dteFilter || typeof S.dteFilter !== 'object') S.dteFilter = { id:'', rut:'', razon_social:'', estado:'' };
function saveState(){ try { localStorage.setItem(SKEY, JSON.stringify(S)); } catch (e) {} }

/* ============================================================
   Fase B — Mapping número Aircall → mesa
   ============================================================
   Tabla declarativa para clasificar llamadas por mesa de atención.

   ▶ DOCUMENTO COMPAÑERO: outputs/cs-panel/MAPPING-MESAS.md
     Lista completa de los 35 números con stats (total calls observadas) +
     guía paso a paso para actualizar este mapping con info de la líder.

   ▶ CÓMO ACTUALIZAR (3 pasos):
     1. Confirmar/corregir el valor de cada clave abajo.
        Si la mesa no existe en la lista MESAS_CANONICAS, agregarla ahí.
     2. Para números nuevos que Aircall agregue en el futuro: agregar línea
        nueva aquí (la izquierda es el `number.name` exacto que ves en Aircall).
     3. Deploy: `python outputs/cs-panel/scripts/deploy_cs_view.py mesa-update-YYYY-MM-DD`
        El cambio aplica retroactivo a TODAS las calls (históricas + futuras).

   ▶ FUNCIONAMIENTO:
     - Aircall NO viene poblando su campo nativo `teams` (lista vacía siempre).
     - Por eso el mapping vive aquí. Si en el futuro iC configura Teams en la
       consola Aircall y los llena, podemos deprecar este mapping y leer
       directo de c.teams[0].
     - Números sin entrada → caen a 'Sin asignar' (visible en la tabla).

   Última revisión: 2026-05-27. Pendiente confirmación con líder de CS. */

/* Lista canónica de mesas — sirve como referencia visual y validación.
 * Si agregas una mesa nueva aquí, debe haber al menos una entrada en
 * MESA_BY_NUMBER apuntando a ella. */
var MESAS_CANONICAS = [
  'Soporte L1',
  'Fact. Electrónica',
  'Sodexo',
  'Iconstruye',
  'Portal Proveedores',
  'Cobranzas',
  'OC Segura',
  'TocToc',
  'CasinoExpress',
  'Agilice',
  'DTE Extendido',
  'Adm Plataformas',
  'SALFA',
  'PAP',
  'Internacional',
  'Líneas directas',   /* atención personal directa, no IVR */
  'Sin asignar'        /* fallback para números no clasificados */
];

/* MESA_BY_NUMBER — la clave es el `number.name` EXACTO como aparece en Aircall.
 * El valor debe estar en MESAS_CANONICAS. Comentario al final de cada línea
 * indica el volumen observado en el seed actual (2026-05-27) para priorizar.
 * Los marcados ✅ son OBVIOS por nombre · ⚠️ requieren CONFIRMACIÓN líder. */
var MESA_BY_NUMBER = {
  /* ───── IVRs principales (volumen alto) ───── */
  'Soporte_IConstruye_IVR':       'Soporte L1',           // 6779 ✅
  'Soporte_Fact_Electrónica_IVR': 'Fact. Electrónica',    // 3357 ✅
  'Sodexo':                       'Sodexo',               // 2310 ✅
  'Iconstruye':                   'Iconstruye',           // 2084 ⚠️ ¿es la misma mesa que Soporte L1?
  'Portal Proveedores':           'Portal Proveedores',   //  850 ✅
  'Cobranzas_IVR':                'Cobranzas',            //  469 ✅
  'OC Segura':                    'OC Segura',            //  393 ⚠️ ¿mesa propia o pertenece a otra?
  'TocToc':                       'TocToc',               //  295 ✅
  'CasinoExpress':                'CasinoExpress',        //   88 ⚠️ ¿mesa propia?

  /* ───── IVRs secundarios ───── */
  'Soporte Agilice':              'Agilice',              //   67 ✅
  'Soporte DTE Extendido':        'DTE Extendido',        //    5 ⚠️ ¿se fusiona con Fact. Electrónica?
  'AdmPlataformas':               'Adm Plataformas',      //   31 ✅
  'SALFA':                        'SALFA',                //   27 ⚠️ ¿es cliente o mesa?
  'PAP IC':                       'PAP',                  //   17 ✅
  'PAP DTE':                      'PAP',                  //   12 ✅
  'Financiamiento TocToc':        'TocToc',               //    4 ✅ (cae dentro de TocToc)

  /* ───── Internacional ───── */
  'IConstruye Colombia':          'Internacional',        //   23 ✅
  'IBuilder Perú':                'Internacional',        //    7 ✅
  'iBuilder México':              'Internacional',        //    4 ✅
  'IBuilder Colombia':            'Internacional',        //    1 ✅
  'Iconstruye Perú':              'Internacional',        //    3 ✅
  'Soporte SCM México':           'Internacional',        //    2 ✅

  /* ───── Líneas directas a personas (atención personalizada, no IVR) ─────
     ⚠️ La líder debe definir: ¿cada persona pertenece a su mesa de origen
     (ej. Jessica Vélez → Cobranzas) o todas van a una mesa única 'Líneas
     directas'? Hoy default = 'Líneas directas'. */
  'Jessica Vélez':                'Líneas directas',      //  364 ⚠️
  'Natalia Ruiz':                 'Líneas directas',      //  279 ⚠️
  'Gloria Rebolledo':             'Líneas directas',      //   98 ⚠️
  'Alberto Mercado':              'Líneas directas',      //   45 ⚠️
  'Javiera Castro':               'Líneas directas',      //   15 ⚠️
  'Joel Campos':                  'Líneas directas',      //    9 ⚠️
  'Monica Salas':                 'Líneas directas',      //    7 ⚠️
  'Fernanda Lillo':               'Líneas directas',      //    4 ⚠️

  /* ───── Sin clasificar ─────
     ⚠️ Estos números aparecen en el raw pero no tienen mesa lógica derivable
     de su nombre. Esperando definición de la líder. */
  'Libre 1':                      'Sin asignar',          //   51 ⚠️
  'Libre 2':                      'Sin asignar',          //   45 ⚠️
  'Libre 4':                      'Sin asignar',          //   23 ⚠️
  'Libre  3':                     'Sin asignar',          //    4 ⚠️ (ojo: doble espacio en el nombre real)
  '56224861000':                  'Sin asignar'           //  183 ⚠️ número sin label en Aircall
};

function getMesa(numberName){
  if (!numberName) return 'Sin asignar';
  return MESA_BY_NUMBER[numberName] || 'Sin asignar';
}

/* ============================================================
   Fase B — Aircall: persistencia IndexedDB desde el render
   ============================================================
   El loader (index.html) NO sabe de Aircall. El render abre su propia DB
   `cs-aircall` (separada de `cs-panel` del loader) y gestiona allí el seed y
   los deltas, sobreviviendo a F5 / cierre del browser exactamente igual que
   los tickets Zendesk en la DB del loader.

   Flujo:
     1) Init: leer todas las calls de IDB → window.__CS_CALLS (cache de paint).
     2) Si vacío: fetch /aircall-seed → persistir + cursor inicial.
     3) Background: fetch /aircall-data?since=<cursor> → merge en IDB + cursor.
     4) Botón "Actualizar": _acSync() trae deltas y los persiste. */

var AC_LS_CURSOR = 'csv-ac-cursor';
var WH_BASE = 'https://prod-low-code.iconstruye.dev/webhook';
var AC_DB_NAME = 'cs-aircall', AC_STORE = 'calls';
var _acDB = null;            /* singleton de la conexión, válido entre paints */

function _acGunzipB64(b64){
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

function _acOpenDB(){
  if (_acDB) return Promise.resolve(_acDB);
  return new Promise(function(res, rej){
    // Sin versión explícita: usa la versión existente, nunca lanza VersionError
    // (mismo criterio que el openDB del cascarón — evita downgrades ilegales).
    var r = indexedDB.open(AC_DB_NAME);
    r.onupgradeneeded = function(e){
      var db = e.target.result;
      if (!db.objectStoreNames.contains(AC_STORE)) db.createObjectStore(AC_STORE, { keyPath:'id' });
    };
    r.onsuccess = function(e){
      var db = e.target.result;
      if (db.objectStoreNames.contains(AC_STORE)){ _acDB = db; return res(db); }
      var nextV = db.version + 1; db.close();
      var up = indexedDB.open(AC_DB_NAME, nextV);
      up.onupgradeneeded = function(ev){
        var d = ev.target.result;
        if (!d.objectStoreNames.contains(AC_STORE)) d.createObjectStore(AC_STORE, { keyPath:'id' });
      };
      up.onsuccess = function(ev){ _acDB = ev.target.result; res(_acDB); };
      up.onerror = function(ev){ rej(ev.target.error); };
    };
    r.onerror = function(e){ rej(e.target.error); };
  });
}

function _acDbCount(db){
  return new Promise(function(res, rej){
    var r = db.transaction(AC_STORE, 'readonly').objectStore(AC_STORE).count();
    r.onsuccess = function(){ res(r.result); };
    r.onerror = function(e){ rej(e.target.error); };
  });
}

function _acDbGetAll(db){
  return new Promise(function(res, rej){
    var r = db.transaction(AC_STORE, 'readonly').objectStore(AC_STORE).getAll();
    r.onsuccess = function(){ res(r.result || []); };
    r.onerror = function(e){ rej(e.target.error); };
  });
}

function _acDbPutMany(db, calls){
  return new Promise(function(res, rej){
    if (!calls || !calls.length) return res(0);
    var tx = db.transaction(AC_STORE, 'readwrite');
    var s = tx.objectStore(AC_STORE);
    for (var i = 0; i < calls.length; i++) s.put(calls[i]);
    tx.oncomplete = function(){ res(calls.length); };
    tx.onerror = function(e){ rej(e.target.error); };
  });
}

function _acFetchSeed(){
  return fetch(WH_BASE + '/aircall-seed?t=' + Date.now(), { cache:'no-store' })
    .then(function(r){ if (!r.ok) throw new Error('aircall-seed HTTP ' + r.status); return r.json(); })
    .then(function(j){
      if (!j || !j.gz) throw new Error('aircall-seed sin gz');
      return _acGunzipB64(j.gz);
    })
    .then(function(txt){ return JSON.parse(txt); });
}

function _acFetchDelta(since){
  var url = WH_BASE + '/aircall-data?since=' + (since || 0) + '&t=' + Date.now();
  return fetch(url, { cache:'no-store' })
    .then(function(r){ if (!r.ok) throw new Error('aircall-data HTTP ' + r.status); return r.json(); });
}

function _acMaxStartedAt(calls){
  var max = 0;
  for (var i = 0; i < calls.length; i++) {
    if (calls[i].started_at && calls[i].started_at > max) max = calls[i].started_at;
  }
  return max;
}

function _acTriggerRepaintIfAircall(){
  /* Repinta si la vista actual usa calls: Aircall puro o 'all' (que muestra
   * Resumen multicanal con conteo de calls). */
  if (S && typeof repaint === 'function' && (S.channel === 'ac' || S.channel === 'all' || !S.channel)) {
    CALLS_ALL = window.__CS_CALLS || [];
    setTimeout(repaint, 0);
  }
}

/* Ensure: hidrata window.__CS_CALLS desde IDB. Si IDB vacía, baja seed + persiste.
 * Llamado al inicio del módulo. Idempotente entre paints (no re-baja). */
function _acEnsure(){
  if (window.__CS_CALLS_LOADING) return;
  if (window.__CS_CALLS && window.__CS_CALLS.length > 0) return;
  window.__CS_CALLS_LOADING = true;
  _acOpenDB().then(function(db){
    return _acDbCount(db).then(function(n){
      if (n > 0) {
        /* IDB ya tiene calls — hidratar memoria y sincronizar deltas */
        return _acDbGetAll(db).then(function(calls){
          window.__CS_CALLS = calls;
          _acTriggerRepaintIfAircall();
          /* sync deltas en background (deltas son livianos) */
          return _acSyncFromCursor(db);
        });
      }
      /* IDB vacía — primera vez: bajar seed completo */
      return _acFetchSeed().then(function(seed){
        var calls = (seed && seed.calls) || [];
        window.__CS_CALLS = calls;
        return _acDbPutMany(db, calls).then(function(){
          var max = _acMaxStartedAt(calls);
          if (max) try { localStorage.setItem(AC_LS_CURSOR, String(max)); } catch(e){}
          _acTriggerRepaintIfAircall();
          /* después del seed, traer deltas (en caso de calls nuevas entre la
             generación del seed y este momento) */
          return _acSyncFromCursor(db);
        });
      });
    });
  }).then(function(){
    window.__CS_CALLS_LOADING = false;
  }).catch(function(e){
    console.warn('[cs-view aircall ensure] fallo:', e);
    window.__CS_CALLS_LOADING = false;
  });
}

/* Sync deltas con cursor desde IDB ya abierta — uso interno de _acEnsure.
 * ITERATIVO: el endpoint /aircall-data pagina por lotes; un solo fetch puede no
 * alcanzar el presente (deja días recientes sin traer). Sigue pidiendo mientras
 * el cursor avance, hasta agotar (delta vacío) o el guard. Resuelve el caso de
 * un cliente con seed viejo que se quedaba varios días atrás. */
function _acSyncFromCursor(db, _iter, _acc){
  _iter = _iter || 0; _acc = _acc || 0;
  if (_iter > 30) return Promise.resolve(_acc);   /* guard anti-loop */
  var cursor = localStorage.getItem(AC_LS_CURSOR) || '0';
  var prev = parseInt(cursor, 10) || 0;
  return _acFetchDelta(cursor).then(function(j){
    var delta = (j && j.calls) || [];
    if (!delta.length) return _acc;
    return _acDbPutMany(db, delta).then(function(){
      if (!window.__CS_CALLS) window.__CS_CALLS = [];
      var idx = {};
      for (var i = 0; i < window.__CS_CALLS.length; i++) idx[window.__CS_CALLS[i].id] = i;
      for (var d = 0; d < delta.length; d++) {
        var c = delta[d];
        if (idx[c.id] != null) window.__CS_CALLS[idx[c.id]] = c;
        else window.__CS_CALLS.push(c);
      }
      var newMax = _acMaxStartedAt(window.__CS_CALLS);
      if (newMax) try { localStorage.setItem(AC_LS_CURSOR, String(newMax)); } catch(e){}
      _acTriggerRepaintIfAircall();
      if (newMax > prev) return _acSyncFromCursor(db, _iter+1, _acc + delta.length);   /* paginar */
      return _acc + delta.length;
    });
  }).catch(function(e){
    console.warn('[cs-view aircall sync] fallo:', e);
    return _acc;
  });
}

/* Sync público de calls Aircall. Antes lo disparaba el click "Actualizar";
   ahora lo invoca el auto-refresh de 5 min del loader vía window.__csSyncCalls.
   Lee de Mongo (/aircall-data) — nunca pega a Aircall/Zendesk en runtime del cliente. */
function _acSync(){
  if (window.__CS_CALLS_LOADING) return Promise.resolve(0);
  return _acOpenDB().then(_acSyncFromCursor);
}
/* Exponer al loader para el auto-refresh (se re-asigna en cada paint → siempre fresco). */
window.__csSyncCalls = _acSync;

/* Recarga forzada de calls Aircall: limpia la IDB cs-aircall + cursor y re-baja el
 * seed completo. Para cuando el seed servidor se regeneró (datos nuevos) y el cliente
 * tiene una copia vieja en IDB. Lo dispara el botón "Recargar llamadas" de la vista. */
window.__acForceReload = function(){
  return _acOpenDB().then(function(db){
    return new Promise(function(res){
      var tx = db.transaction(AC_STORE, 'readwrite');
      tx.objectStore(AC_STORE).clear();
      tx.oncomplete = function(){ res(); };
      tx.onerror = function(){ res(); };
    });
  }).then(function(){
    try { localStorage.removeItem(AC_LS_CURSOR); } catch(e){}
    window.__CS_CALLS = []; window.__CS_CALLS_LOADING = false;
    _acEnsure();
  });
};

/* ---- constantes ---- */
var ACTIVE = { new:1, open:1, pending:1, hold:1 };

/* Grupos Zendesk que NO son CS — se ocultan del filtro Equipo y se descartan
 * de todos los cálculos del panel. El histórico sigue en cache pero no es visible.
 * Para limpiar también el seed, ejecutar carga_inicial.py con un patch que filtre estos gids. */
var EXCLUDED_GIDS = {
  '38071499327259': 'Agentes iBuilder',
  '40464691179803': 'Agentes Light iBuilder',
  '40275768323995': 'Supervisores iBuilder',
  '19278545629979': 'Casos Sin Replicar'
};
function isExcludedGid(gid){ return !!EXCLUDED_GIDS[String(gid)]; }

/* ---- SLA live: re-evalúa breach_at en cada paint (no depende del booleano cacheado) ----
 * sla_active_breaches viene como [{metric, breach_at}] poblado por el server para activos.
 * Si está, el SLA se evalúa en tiempo real contra now(). Si no, fallback al booleano cacheado
 * (compatibilidad con tickets cerrados — sla_breached es estático contra solved_at).
 */
function slaBreached(t){
  if (!t) return false;
  if (Array.isArray(t.sla_active_breaches)) {
    if (t.sla_active_breaches.length === 0) return false;
    var nowIso = new Date().toISOString();
    return t.sla_active_breaches.some(function(p){ return p && p.breach_at && p.breach_at < nowIso; });
  }
  return t.sla_breached === true;
}
function slaEvaluated(t){
  if (!t) return false;
  if (Array.isArray(t.sla_active_breaches)) return true;
  return t.sla_breached != null;
}
function slaOk(t){ return slaEvaluated(t) && !slaBreached(t); }
function slaState(t){
  if (!slaEvaluated(t)) return null;
  return slaBreached(t) ? true : false;
}
var DAY_CUTOFF_HOUR = 6;
var ZD = 'https://iconstruye.zendesk.com/agent/tickets/';
var STATUS_LBL = { new:'Nuevo', open:'Abierto', pending:'Pendiente', hold:'En espera', solved:'Resuelto', closed:'Cerrado' };
var PRIO_LBL = { low:'Baja', normal:'Normal', high:'Alta', urgent:'Urgente' };
var PRIO_CLS = { low:'', normal:'in', high:'alert', urgent:'err' };
var THEME = (function(){
  var a = document.getElementById('app');
  return (a && a.dataset && a.dataset.theme) || 'light';
})();
var AXIS = THEME === 'dark' ? '#8FA3AE' : '#5B6B76';
var GRID = THEME === 'dark' ? 'rgba(255,255,255,.07)' : 'rgba(0,38,58,.08)';
var CHARTS = [];

/* ---- helpers ---- */
function ms(s){ return s ? new Date(s).getTime() : 0; }
function num(n){ return (n == null ? 0 : n).toLocaleString('es-CL'); }
function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c];
  });
}
function inferType(subj){
  return /^\s*\(\s*sol\s*\)/i.test(subj || '') ? 'solicitud' : 'incidente';
}
function trunc(s, n){
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n).trim() + '…' : s;
}
function truncWords(s, n){
  s = String(s == null ? '' : s).trim();
  if (!s) return '';
  var parts = s.split(/\s+/);
  return parts.length > n ? parts.slice(0, n).join(' ') + '…' : s;
}
function slug(s){
  return String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'')
    .toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0, 60);
}
function loadExcelLib(cb){
  if (typeof window !== 'undefined' && window.ExcelJS) { cb(null); return; }
  var s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
  s.onload = function(){ cb(null); };
  s.onerror = function(){ cb(new Error('No se pudo cargar la librería de Excel. Verifica tu conexión.')); };
  document.head.appendChild(s);
}
/* Exporta a XLSX con formato de tabla, autofilter y header congelado.
   ticketCol = índice (0-based) de la columna con el ID de ticket; se
   convertirá en hipervínculo Zendesk. */
function exportTicketsXlsx(filename, sheetName, headers, rows, ticketCol){
  loadExcelLib(function(err){
    if (err){ alert(err.message); return; }
    var wb = new window.ExcelJS.Workbook();
    wb.creator = 'CS Panel iConstruye';
    wb.created = new Date();
    var ws = wb.addWorksheet(sheetName, {
      views: [{ state: 'frozen', ySplit: 1 }]
    });
    /* Tabla con estilo Excel — header row destacado, filas alternas, filterButton */
    ws.addTable({
      name: 'TablaTickets',
      ref: 'A1',
      headerRow: true,
      totalsRow: false,
      style: {
        theme: 'TableStyleMedium2',
        showFirstColumn: false,
        showLastColumn: false,
        showRowStripes: true,
        showColumnStripes: false
      },
      columns: headers.map(function(h){ return { name: h, filterButton: true }; }),
      rows: rows
    });
    /* Hipervínculo en columna ticket */
    if (ticketCol != null){
      var colLetter = String.fromCharCode(65 + ticketCol);
      for (var i = 0; i < rows.length; i++){
        var ticketId = rows[i][ticketCol];
        if (!ticketId) continue;
        var cell = ws.getCell(colLetter + (i + 2));
        cell.value = { text: '#' + ticketId, hyperlink: ZD + ticketId, tooltip: 'Abrir en Zendesk' };
        cell.font = { color: { argb: 'FF0047BB' }, underline: true, name: 'Calibri', size: 11 };
      }
    }
    /* Anchos dinámicos por contenido máximo */
    headers.forEach(function(h, idx){
      var maxLen = String(h||'').length;
      rows.forEach(function(row){
        var v = String(row[idx] == null ? '' : row[idx]);
        if (v.length > maxLen) maxLen = v.length;
      });
      ws.getColumn(idx + 1).width = Math.max(10, Math.min(52, maxLen + 2));
    });
    wb.xlsx.writeBuffer().then(function(buf){
      var blob = new Blob([buf], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(function(){ document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
    }).catch(function(e){ alert('Error al generar el Excel: ' + e.message); });
  });
}
/* Triage: número (N) al inicio del asunto — "(5) Error…" => 5 */
function triage(subj){
  var s = subj || '';
  var m = /^\s*\((\d+)\)/.exec(s);
  if (m) return m[1];
  if (/^\s*\(\s*sol\s*\)/i.test(s)) return 'SOL';
  return '';
}
function jornadaStartMs(){
  var n = new Date();
  var s = new Date(n.getFullYear(), n.getMonth(), n.getDate(), DAY_CUTOFF_HOUR, 0, 0, 0);
  if (n.getTime() < s.getTime()) s = new Date(s.getTime() - 86400000);
  return s.getTime();
}
/* Rango temporal para la vista Aircall según el tab activo. Antes la vista Aircall
   ignoraba el tab y mostraba TODO el histórico (bug: "En vivo" mostraba 18k calls).
   Ahora respeta: En vivo = hoy (06:00), Semanal = la semana, Análisis = su ventana,
   Clientes/otros = histórico completo. (fix 2026-05-28) */
function aircallRange(){
  var now = new Date(), nowMs = now.getTime();
  if (S.tab === 'live') return { startMs: jornadaStartMs(), endMs: nowMs, label: 'hoy desde las 06:00' };
  if (S.tab === 'ana')  { var w = computeAnaWindow(); return { startMs: w.startMs, endMs: w.endMs, label: w.label }; }
  if (S.tab === 'week') {
    var d = new Date(nowMs + (S.weekOffset || 0) * 7 * 86400000);
    var dow = (d.getDay() + 6) % 7;   /* 0 = lunes */
    var mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow, 0, 0, 0, 0);
    var sun = mon.getTime() + 7 * 86400000 - 1;
    return { startMs: mon.getTime(), endMs: Math.min(sun, nowMs), label: 'semana ' + fmtDate(mon) };
  }
  return { startMs: 0, endMs: nowMs, label: 'histórico completo' };
}
function callsInRange(){
  var rng = aircallRange();
  return CALLS_ALL.filter(function(c){
    var t = (c.started_at || 0) * 1000;
    return t >= rng.startMs && t <= rng.endMs;
  });
}
function fmtMin(m){
  if (m == null || isNaN(m)) return '—';
  if (m < 60) return Math.round(m) + ' min';
  var h = m / 60;
  if (h < 24) return (h % 1 ? h.toFixed(1) : h) + ' h';
  return (h / 24).toFixed(1) + ' d';
}
function fmtDate(d){
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')
    + '-' + String(d.getDate()).padStart(2,'0');
}
var MES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
function fmtDM(d){ return d.getDate() + ' ' + MES[d.getMonth()]; }
function relTime(iso){
  if (!iso) return '—';
  var diff = (Date.now() - new Date(iso).getTime()) / 60000;
  if (diff < 60) return 'hace ' + Math.round(diff) + ' min';
  if (diff < 1440) return 'hace ' + Math.round(diff/60) + ' h';
  return 'hace ' + Math.round(diff/1440) + ' d';
}
function agentName(id){ var a = AG[id]; return (a && a.name) || (id ? 'Agente ' + id : 'Sin asignar'); }
function groupName(id){ return GR[id] || (id ? 'Equipo ' + id : 'Sin equipo'); }
function orgName(id){ return OR[id] || (id ? 'Org ' + id : 'Sin cliente'); }
function solvedMs(t){
  if (t.status === 'solved') return ms(t.updated_at);
  if (t.status === 'closed' && t.solved_at) return ms(t.solved_at);
  return 0;
}
/* momento en que el ticket salió de la bolsa (resuelto/cerrado) — 0 si sigue activo.
   Más robusto que solvedMs para el flujo: cubre closed sin solved_at. */
function salidaMs(t){
  if (ACTIVE[t.status]) return 0;
  return ms(t.solved_at) || ms(t.closed_at) || ms(t.updated_at);
}
/* ejecutivos excluidos de los rankings por agente (cuentas de cierre masivo) */
var EXCL_EJEC = { 'Alberto Mercado':1, 'Edgar Bonomie':1, 'Karina Salinas':1 };
function agExcluido(id){ return !!EXCL_EJEC[agentName(id)]; }

/* ---- feriados chilenos (para el toggle "solo días hábiles") ---- */
var HKEY = 'csv-holidays';
var HOLIDAYS = {};
try { HOLIDAYS = JSON.parse(localStorage.getItem(HKEY)) || {}; } catch (e) { HOLIDAYS = {}; }
function loadHolidays(){
  var y = new Date().getFullYear();
  if (HOLIDAYS._year === y) return;                  /* ya cacheado este año */
  var acc = { _year: y };
  Promise.all([y-1, y, y+1].map(function (yr) {
    return fetch('https://api.boostr.cl/feriados/' + yr + '.json', { cache:'force-cache' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        (j.data || []).forEach(function (h) { if (h && h.date) acc[h.date] = h.title || true; });
      })
      .catch(function () {});
  })).then(function () {
    HOLIDAYS = acc;
    try { localStorage.setItem(HKEY, JSON.stringify(acc)); } catch (e) {}
    repaint();
  });
}
function isWorkday(d){
  var w = d.getDay();
  if (w === 0 || w === 6) return false;
  return !HOLIDAYS[fmtDate(d)];
}
/* ---- rangos predeterminados del tab Análisis (modo "Rango Pred.") ---- */
function predN(){ var n = parseInt(S.predDias, 10); return n > 0 ? n : 10; }
/* los últimos n días hábiles (lun-vie sin feriados), del más antiguo al más reciente */
function ultimosDiasHabiles(n){
  var out = [], d = new Date(), guard = 0;
  d.setHours(0,0,0,0);
  while (out.length < n && guard++ < 600) {
    if (isWorkday(d)) {
      var d0 = d.getTime();
      out.unshift({ d0:d0, d1:d0 + 86400000,
        label: String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') });
    }
    d = new Date(d.getTime() - 86400000);
  }
  return out;
}

/* ---- universo filtrado por equipo + tipo ----
   S.gids = undefined → todos los equipos (default)
   S.gids = []        → ninguno (filtra todo)
   S.gids = [ids…]    → solo esos equipos */
function applyFilters(list){
  return list.filter(function (t) {
    if (isExcludedGid(t.group_id)) return false;
    if (Array.isArray(S.gids) && S.gids.indexOf(String(t.group_id)) < 0) return false;
    if (S.type && inferType(t.subject) !== S.type) return false;
    return true;
  });
}

/* ============================================================
   CÁLCULOS — TAB CLIENTES
   ============================================================ */
function orgUniverse(orgId){
  return applyFilters(T).filter(function(t){
    return String(t.organization_id || 0) === String(orgId);
  });
}
/* KPIs sobre un universo de tickets (cliente o panel completo) */
function computeKPIs(universe){
  var total = universe.length;
  var activos = universe.filter(function(t){ return !!ACTIVE[t.status]; }).length;
  var brSla = universe.filter(function(t){ return slaBreached(t); }).length;
  var slaEvalArr = universe.filter(function(t){ return slaEvaluated(t); });
  var nSlaOk   = slaEvalArr.filter(function(t){ return slaOk(t); }).length;
  var pctSla  = slaEvalArr.length ? (nSlaOk / slaEvalArr.length * 100) : null;
  var frtVals = universe.filter(function(t){ return t.frt_min != null && t.frt_min > 0; })
    .map(function(t){ return t.frt_min; }).sort(function(a,b){ return a-b; });
  var frtMed  = frtVals.length ? frtVals[Math.floor(frtVals.length/2)] : null;
  var resVals = universe.filter(function(t){ return t.solved_at && t.created_at; })
    .map(function(t){ return (ms(t.solved_at)-ms(t.created_at))/60000; }).sort(function(a,b){ return a-b; });
  var resMed  = resVals.length ? resVals[Math.floor(resVals.length/2)] : null;
  var reaperTickets = universe.filter(function(t){ return (t.reopens||0) > 0; }).length;
  var pctReaper = total ? (reaperTickets/total*100) : null;
  var csatEval = universe.filter(function(t){ return t.csat === 'good' || t.csat === 'bad'; });
  var csatOk   = csatEval.filter(function(t){ return t.csat === 'good'; }).length;
  var pctCsat  = csatEval.length ? (csatOk/csatEval.length*100) : null;
  var sn2   = universe.filter(function(t){ return t.esc_sn2; }).length;
  var moEsc = universe.filter(function(t){ return t.esc_mo; }).length;
  var devol = universe.filter(function(t){ return t.devol; }).length;
  var pctSn2 = total ? (sn2/total*100) : null;
  var dates  = universe.map(function(t){ return t.created_at; }).filter(Boolean).sort();
  var agIds  = {};
  universe.forEach(function(t){ if (t.assignee_id && !agExcluido(t.assignee_id)) agIds[t.assignee_id]=1; });
  return {
    total:total, activos:activos, brSla:brSla,
    pctSla:pctSla, frtMed:frtMed, resMed:resMed,
    pctReaper:pctReaper, pctCsat:pctCsat, csatN:csatEval.length, slaEvalN:slaEvalArr.length,
    sn2:sn2, moEsc:moEsc, devol:devol, pctSn2:pctSn2,
    primerTicket:dates.length?dates[0].slice(0,10):null,
    ultimoTicket:dates.length?dates[dates.length-1].slice(0,10):null,
    numEjecutivos:Object.keys(agIds).length
  };
}
function orgKPIs(universe){ return computeKPIs(universe); }

/* Baseline del panel — KPIs sobre todo el universo filtrado (respeta equipo+tipo).
   Cacheado mientras los filtros globales no cambien. */
var _baselineCache = null, _baselineKey = '';
function panelBaseline(){
  var key = JSON.stringify(S.gids||null) + '|' + (S.type||'');
  if (_baselineCache && _baselineKey === key) return _baselineCache;
  _baselineCache = computeKPIs(applyFilters(T));
  _baselineKey = key;
  return _baselineCache;
}

/* Comparativa cliente vs panel — devuelve {txt, cls} para sub-label del kpiCard.
   type: 'pct' (más=mejor), 'pct-inv' (menos=mejor), 'min-inv' (menos=mejor, en minutos) */
function vsPanelSub(val, base, type){
  if (val == null || base == null) return { txt:'', cls:'' };
  if (type === 'pct'){
    var diff = val - base;
    if (Math.abs(diff) < 1) return { txt:'≈ promedio del panel', cls:'' };
    return { txt: (diff > 0 ? '+' : '') + Math.round(diff) + ' pts vs ' + Math.round(base) + '% panel',
             cls: diff > 0 ? 'up' : 'down' };
  }
  if (type === 'pct-inv'){
    var d2 = val - base;
    if (Math.abs(d2) < 1) return { txt:'≈ promedio del panel', cls:'' };
    return { txt: (d2 > 0 ? '+' : '') + d2.toFixed(1) + ' pts vs ' + base.toFixed(1) + '% panel',
             cls: d2 < 0 ? 'up' : 'down' };
  }
  if (type === 'min-inv'){
    var pct = base > 0 ? ((val - base) / base) * 100 : 0;
    if (Math.abs(pct) < 5) return { txt:'≈ panel (' + fmtMin(base) + ')', cls:'' };
    return { txt: (pct > 0 ? '+' : '') + Math.round(pct) + '% vs ' + fmtMin(base) + ' panel',
             cls: pct < 0 ? 'up' : 'down' };
  }
  return { txt:'', cls:'' };
}

/* Tokenizer de subject — para top keywords + recurrencia */
var STOP_WORDS_ES = {
  el:1, la:1, los:1, las:1, un:1, una:1, unos:1, unas:1, lo:1,
  de:1, del:1, al:1, con:1, sin:1, por:1, para:1, en:1, sobre:1, ante:1, entre:1, hacia:1, desde:1, hasta:1,
  y:1, o:1, u:1, e:1, ni:1, pero:1, sino:1, aunque:1,
  si:1, no:1, que:1, cual:1, quien:1, cuando:1, como:1, donde:1, porque:1,
  son:1, ser:1, sea:1, fue:1, fueron:1, era:1, estar:1, esta:1, este:1, estos:1, estas:1, esto:1,
  ese:1, esa:1, eso:1, aquel:1, aquella:1, aquello:1,
  ha:1, han:1, he:1, hemos:1, has:1, hay:1, habia:1, hace:1, hacer:1, hecho:1, hizo:1, hicieron:1,
  tiene:1, tener:1, tuvo:1, tienen:1, sera:1, seran:1, seria:1, serian:1,
  muy:1, mas:1, menos:1, poco:1, mucho:1, todo:1, todos:1, toda:1, todas:1, nada:1, algo:1, alguno:1, algunos:1,
  asi:1, aqui:1, alli:1, alla:1, hoy:1, ayer:1, manana:1, ahora:1, antes:1, despues:1, luego:1, pronto:1, tarde:1,
  me:1, te:1, se:1, le:1, les:1, nos:1, su:1, sus:1, mi:1, mis:1, tu:1, tus:1, suyo:1, nuestro:1, nuestros:1,
  re:1, fw:1, fwd:1, rv:1, sol:1, nro:1, num:1, numero:1,
  ticket:1, tickets:1, caso:1, casos:1, cliente:1, clientes:1, empresa:1, empresas:1,
  ayuda:1, favor:1, gracias:1, hola:1, buenas:1, buenos:1, dia:1, dias:1, tarde:1, tardes:1, noche:1, noches:1,
  cordial:1, cordiales:1, saludos:1, estimado:1, estimada:1, estimados:1, estimadas:1,
  ic:1, iconstruye:1
};
function stripDiacritics(s){
  return String(s||'').normalize ? s.normalize('NFD').replace(/[̀-ͯ]/g,'') : s;
}
function tokenizeSubject(text){
  var s = stripDiacritics(String(text||'')).toLowerCase();
  /* despoja prefijos (5), (sol), (15), etc. */
  s = s.replace(/^\s*\([^)]*\)\s*/, '');
  var raw = s.split(/[^a-z0-9]+/);
  var out = [];
  for (var i = 0; i < raw.length; i++){
    var w = raw[i];
    if (!w || w.length < 3) continue;
    if (/^\d+$/.test(w)) continue;           /* puros números */
    if (STOP_WORDS_ES[w]) continue;
    out.push(w);
  }
  return out;
}
/* Top N keywords (unigramas + bigramas) sobre los subjects */
function orgKeywords(universe, topN){
  var uni = {}, bi = {};
  universe.forEach(function(t){
    var tokens = tokenizeSubject(t.subject||'');
    var seenU = {};
    tokens.forEach(function(tk){ if (!seenU[tk]){ uni[tk] = (uni[tk]||0) + 1; seenU[tk] = 1; } });
    var seenB = {};
    for (var j = 0; j < tokens.length - 1; j++){
      var bg = tokens[j] + ' ' + tokens[j+1];
      if (!seenB[bg]){ bi[bg] = (bi[bg]||0) + 1; seenB[bg] = 1; }
    }
  });
  var unis = Object.keys(uni).map(function(k){ return { term:k, n:uni[k], type:'uni' }; })
    .filter(function(x){ return x.n >= 2; });
  var bis  = Object.keys(bi).map(function(k){ return { term:k, n:bi[k], type:'bi' }; })
    .filter(function(x){ return x.n >= 2; });
  return unis.concat(bis).sort(function(a,b){ return b.n - a.n; }).slice(0, topN || 20);
}
/* Recurrencia — grupos de tickets con bigrama en común. Top grupos por tamaño. */
function orgRecurrence(universe){
  var byBigram = {};
  universe.forEach(function(t){
    var tokens = tokenizeSubject(t.subject||'');
    var seen = {};
    for (var j = 0; j < tokens.length - 1; j++){
      var bg = tokens[j] + ' ' + tokens[j+1];
      if (seen[bg]) continue;
      seen[bg] = 1;
      if (!byBigram[bg]) byBigram[bg] = [];
      byBigram[bg].push(t);
    }
  });
  var groups = Object.keys(byBigram).map(function(b){
    return { bigram:b, tickets:byBigram[b], n:byBigram[b].length };
  }).filter(function(g){ return g.n >= 3; })
    .sort(function(a,b){ return b.n - a.n; });
  /* dedupe trivial: si dos grupos tienen exactamente los mismos tickets, quedarse con el primero */
  var seenSig = {};
  return groups.filter(function(g){
    var sig = g.tickets.map(function(t){ return t.id; }).sort().join(',');
    if (seenSig[sig]) return false;
    seenSig[sig] = 1;
    return true;
  }).slice(0, 8);
}
/* Histograma de tiempos de resolución — buckets fijos */
function resolutionBuckets(universe){
  var labels = ['<1h','1-4h','4-24h','1-3d','3-7d','7-30d','>30d'];
  var ums = [60, 240, 1440, 4320, 10080, 43200, Infinity];
  var data = [0,0,0,0,0,0,0];
  universe.forEach(function(t){
    if (!t.solved_at || !t.created_at) return;
    var min = (ms(t.solved_at)-ms(t.created_at))/60000;
    if (min < 0) return;
    for (var i = 0; i < ums.length; i++){ if (min < ums[i]){ data[i]++; break; } }
  });
  return { labels:labels, data:data };
}

/* ============================================================
   CÁLCULOS — TAB EN VIVO
   ============================================================ */
function kpisJornada(universe){
  var start = jornadaStartMs();
  var k = { init:0, in:0, res:0, clo:0, now:0 };
  universe.forEach(function (t) {
    var created = ms(t.created_at), activeNow = !!ACTIVE[t.status];
    if (created <= start) {
      if (activeNow) k.init++;
      else { var ref = ms(t.solved_at) || ms(t.updated_at); if (ref > start) k.init++; }
    }
    if (created >= start) k.in++;
    if (t.status === 'solved' && ms(t.updated_at) >= start) k.res++;
    else if (t.status === 'closed' && t.solved_at && ms(t.solved_at) >= start) k.res++;
    if (t.status === 'closed') { var rc = ms(t.closed_at) || ms(t.updated_at); if (rc >= start) k.clo++; }
    if (activeNow) k.now++;
  });
  return k;
}

function statsPorEjecutivo(universe){
  var start = jornadaStartMs();
  var by = {};
  function row(id){
    if (!by[id]) by[id] = { id:id, name:agentName(id), grp:'', total:0, op:0, pe:0,
      br:0, ev:0, init:0, in:0, res:0, clo:0 };
    return by[id];
  }
  universe.forEach(function (t) {
    var id = t.assignee_id || 0, r = row(id);
    if (t.group_id && !r.grp) r.grp = groupName(t.group_id);
    var created = ms(t.created_at), activeNow = !!ACTIVE[t.status];
    if (activeNow) {
      r.total++;
      if (t.status === 'new' || t.status === 'open') r.op++; else r.pe++;
      if (slaBreached(t)) r.br++;
      if (slaEvaluated(t)) r.ev++;
    }
    if (created <= start) {
      if (activeNow) r.init++;
      else { var ref = ms(t.solved_at) || ms(t.updated_at); if (ref > start) r.init++; }
    }
    if (created >= start) r.in++;
    if (t.status === 'solved' && ms(t.updated_at) >= start) r.res++;
    else if (t.status === 'closed' && t.solved_at && ms(t.solved_at) >= start) r.res++;
    if (t.status === 'closed') { var rc = ms(t.closed_at) || ms(t.updated_at); if (rc >= start) r.clo++; }
  });
  return Object.keys(by).map(function (k) { return by[k]; })
    .filter(function (r) { return r.total > 0 || r.init > 0 || r.in > 0 || r.res > 0 || r.clo > 0; })
    .sort(function (a, b) { return b.total - a.total || b.res - a.res; });
}

/* ============================================================
   CÁLCULOS — TAB ANÁLISIS SEMANAL (semana en curso, lun-vie)
   ============================================================ */
function semanaActual(){
  var now = new Date();
  var dw = now.getDay() || 7;                        /* 1=lun … 7=dom */
  var monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dw + 1, 0,0,0,0);
  if (S.weekOffset) monday = new Date(monday.getTime() + S.weekOffset * 604800000);
  return monday;
}
function weekData(universe){
  var monday = semanaActual();
  var now = Date.now();
  var dias = [];
  var nombres = ['Lunes','Martes','Miércoles','Jueves','Viernes'];
  for (var i = 0; i < 5; i++) {
    var d0 = monday.getTime() + i * 86400000;
    dias.push({ idx:i, nombre:nombres[i], d0:d0, d1:d0 + 86400000,
      ent:0, res:0, transcurrido: d0 <= now, byAgent:{}, byOrg:{} });
  }
  universe.forEach(function (t) {
    var c = ms(t.created_at), sv = solvedMs(t);
    for (var i = 0; i < 5; i++) {
      var d = dias[i];
      if (c >= d.d0 && c < d.d1) {
        d.ent++;
        var o = t.organization_id || 0;
        d.byOrg[o] = (d.byOrg[o] || 0) + 1;
      }
      if (sv >= d.d0 && sv < d.d1) {
        d.res++;
        var a = t.assignee_id || 0;
        if (!agExcluido(a)) d.byAgent[a] = (d.byAgent[a] || 0) + 1;
      }
    }
  });
  return { monday:monday, dias:dias };
}

/* ============================================================
   CÁLCULOS — TAB ANÁLISIS
   ============================================================ */
function computeAnaWindow(){
  var now = new Date(), start, end, label;
  if (S.mode === 'day') {
    var d = S.day ? new Date(S.day + 'T00:00:00') : now;
    start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0,0,0,0);
    var sameDay = d.toDateString() === now.toDateString();
    end = sameDay ? now : new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23,59,59,999);
    label = fmtDate(start) + (sameDay ? ' · hasta ahora' : ' · día completo');
  } else if (S.mode === 'pred') {
    var serie = ultimosDiasHabiles(predN());
    start = new Date(serie[0].d0);
    end = now;
    label = 'últimos ' + predN() + ' días hábiles (Lun–Vie) · '
      + serie[0].label + ' → ' + serie[serie.length-1].label;
  } else {
    var f = S.from ? new Date(S.from + 'T00:00:00') : new Date(now.getTime() - 30*86400000);
    var t = S.to   ? new Date(S.to   + 'T00:00:00') : now;
    start = new Date(f.getFullYear(), f.getMonth(), f.getDate(), 0,0,0,0);
    var toToday = t.toDateString() === now.toDateString();
    end = toToday ? now : new Date(t.getFullYear(), t.getMonth(), t.getDate(), 23,59,59,999);
    label = fmtDate(start) + ' → ' + fmtDate(end) + (S.workdays ? ' · solo hábiles' : '');
  }
  return { startMs: start.getTime(), endMs: end.getTime(), label: label, start: start, end: end };
}
function rangoCorto(w){
  var a = w.start, b = w.end;
  var ma = MES[a.getMonth()] + ' ' + a.getFullYear();
  var mb = MES[b.getMonth()] + ' ' + b.getFullYear();
  return ma === mb ? ma : ma + ' – ' + mb;
}
function anaSets(universe){
  var w = computeAnaWindow();
  var pass = function (t) {
    if (S.mode === 'pred') return isWorkday(new Date(t));   /* "Rango Pred." es solo días hábiles */
    if (!S.workdays || S.mode !== 'range') return true;
    return isWorkday(new Date(t));
  };
  var sets = { IN:[], RESOLVED:[], CLOSED:[], INIT:[], win:w };
  universe.forEach(function (t) {
    var created = ms(t.created_at);
    if (created >= w.startMs && created <= w.endMs && pass(created)) sets.IN.push(t);
    var sv = solvedMs(t);
    if (sv >= w.startMs && sv <= w.endMs && pass(sv)) sets.RESOLVED.push(t);
    if (t.status === 'closed') {
      var rc = ms(t.closed_at) || ms(t.updated_at);
      if (rc >= w.startMs && rc <= w.endMs && pass(rc)) sets.CLOSED.push(t);
    }
    if (created < w.startMs) {
      if (ACTIVE[t.status]) sets.INIT.push(t);
      else { var ref = ms(t.solved_at) || ms(t.updated_at); if (ref >= w.startMs) sets.INIT.push(t); }
    }
  });
  return sets;
}
/* días hábiles entre dos timestamps (inclusive) — buckets para el modo Rango */
function diasHabilesEntre(startMs, endMs){
  var out = [], d = new Date(startMs), guard = 0;
  d.setHours(0,0,0,0);
  while (d.getTime() <= endMs && guard++ < 800) {
    if (isWorkday(d)) {
      var d0 = d.getTime();
      out.push({ d0:d0, d1:d0 + 86400000,
        label: String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') });
    }
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}
/* buckets por hora de un día — para el modo Día */
function bucketsHora(dayStartMs, endMs){
  var out = [];
  for (var h = 0; h < 24; h++) {
    var d0 = dayStartMs + h * 3600000;
    if (d0 > endMs) break;
    out.push({ d0:d0, d1:d0 + 3600000, label: String(new Date(d0).getHours()).padStart(2,'0') + 'h' });
  }
  return out;
}
/* llena rec/att/clo/bolsa de cada bucket {d0,d1}:
   rec = ingresos (creados) · att = atendidos (salieron de la bolsa) ·
   clo = cerrados auto (closed_at) · bolsa = backlog abierto al cierre del bucket.
   Buckets futuros (d0 > ahora) quedan en null para no dibujarse. */
function flujoBuckets(universe, buckets){
  var now = Date.now();
  buckets.forEach(function (b) {
    if (b.d0 > now) { b.rec = b.att = b.clo = b.bolsa = null; }
    else { b.rec = 0; b.att = 0; b.clo = 0; b.bolsa = 0; }
  });
  universe.forEach(function (t) {
    var c = ms(t.created_at), sv = salidaMs(t);
    var cl = t.status === 'closed' ? (ms(t.closed_at) || ms(t.updated_at)) : 0;
    for (var i = 0; i < buckets.length; i++) {
      var b = buckets[i];
      if (b.rec === null) continue;
      if (c >= b.d0 && c < b.d1) b.rec++;
      if (sv > 0 && sv >= b.d0 && sv < b.d1) b.att++;
      if (cl > 0 && cl >= b.d0 && cl < b.d1) b.clo++;
      if (c < b.d1 && (sv === 0 || sv >= b.d1)) b.bolsa++;
    }
  });
  return buckets;
}

/* ============================================================
   COMPONENTES HTML
   ============================================================ */
function kpiCard(value, label, sub, color, subClass){
  return '<div class="cs-kpi">'
    + '<div class="bar" style="background:' + color + '"></div>'
    + '<div class="v">' + value + '</div>'
    + '<div class="l">' + esc(label) + '</div>'
    + '<div class="s' + (subClass ? ' ' + subClass : '') + '">' + (sub || '') + '</div>'
    + '</div>';
}
function chartCard(title, canvasId, height){
  var hs = height ? ' style="height:' + height + 'px"' : '';
  return '<div class="cs-card cs-chart"><div class="cs-ch-t">' + esc(title) + '</div>'
    + '<div class="cs-ch-wrap"' + hs + '><canvas id="' + canvasId + '"></canvas></div></div>';
}
function slaPill(v){
  return v === true ? '<span class="cs-pill err">Vencido</span>'
    : v === false ? '<span class="cs-pill ok">OK</span>'
    : '<span class="cs-pill">—</span>';
}
function prioPill(p){
  if (!p) return '<span class="cs-pill">—</span>';
  return '<span class="cs-pill ' + (PRIO_CLS[p] || '') + '">' + (PRIO_LBL[p] || p) + '</span>';
}

/* header del panel — lo dibuja el render para que sea actualizable sin reenviar el HTML */
function buildHeader(){
  var act = T.filter(function (t) { return ACTIVE[t.status]; }).length;
  /* En canal Teléfono (Aircall) T está vacío (las llamadas no son tickets) → mostrar
   * conteo de llamadas en vez de "0 tickets en memoria", que confunde. */
  var stats = (S.channel === 'ac')
    ? num((window.__CS_CALLS || []).length) + ' llamadas en memoria'
    : num(T.length) + ' tickets en memoria · ' + num(act) + ' activos';
  var moon = '<svg class="sun-and-moon" aria-hidden="true" viewBox="0 0 24 24">'
    + '<mask class="moon" id="csmoon"><rect x="0" y="0" width="100%" height="100%" fill="white"/>'
    + '<circle cx="24" cy="10" r="6" fill="black"/></mask>'
    + '<circle class="sun" cx="12" cy="12" r="6" mask="url(#csmoon)" fill="currentColor"/>'
    + '<g class="sun-beams" stroke="currentColor">'
    + '<line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>'
    + '<line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>'
    + '<line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>'
    + '<line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>'
    + '</g></svg>';
  return '<div class="csh">'
    + '<div class="csh-brand">'
    +   '<span class="csh-dot"></span>'
    +   '<span class="csh-title">Panel CS — iConstruye</span>'
    +   '<span class="csh-stats">' + stats + '</span>'
    + '</div>'
    + '<div class="csh-actions">'
    +   '<span class="csh-status" id="cs-status">' + esc(CTX_STATUS) + '</span>'
    /* Botón "Actualizar" eliminado (2026-05-28): el panel auto-actualiza cada 5 min
       desde Mongo (lo hace el loader). El usuario no fuerza fetch sobre Zendesk — eso
       es tarea exclusiva del Schedule de n8n. Re-cachear repuebla local desde Mongo. */
    +   '<button class="csh-btn" data-act="recache">Re-cachear</button>'
    +   '<button class="csh-btn" data-act="export">Imprimir PDF</button>'
    +   '<button class="csh-theme" data-act="theme" title="Cambiar tema" aria-label="Cambiar tema">'
    +     moon + '</button>'
    + '</div>'
    + '</div>';
}

function buildChannelSelect(){
  /* Re-encuadre 2026-05-28 — Zendesk pasa a ser universo total de tickets
   * (no solo Correo). Modelo cerrado del selector: Todos · Zendesk · Teléfono · Chat.
   * Resuelve el reporte "los números de Zendesk no calzan" — antes el filtro 'zd'
   * escondía el 41% del universo (12k Teléfono + 3.5k Chat). */
  var opts = [
    {id:'all', label:'Todos los canales'},
    {id:'zd',  label:'Zendesk'},
    {id:'ac',  label:'Teléfono (Aircall)'},
    {id:'wn',  label:'Chat (Wotnot)'}
  ];
  var inner = opts.map(function(o){
    return '<option value="' + o.id + '"' + (S.channel===o.id?' selected':'') + '>' + o.label + '</option>';
  }).join('');
  return '<select class="cs-channel" id="csChannel" title="Filtrar por canal">' + inner + '</select>';
}

function buildTabs(){
  function tb(id, txt){ return '<button class="cs-tab' + (S.tab===id?' on':'') + '" data-tab="' + id + '">' + txt + '</button>'; }
  return '<div class="cs-toolbar">'
    + buildChannelSelect()
    + '<div class="cs-tabs">'
    + tb('live','En vivo') + tb('week','Análisis semanal') + tb('ana','Análisis') + tb('org','Clientes') + tb('extras','Paneles Extras')
    + '</div>'
    + '</div>';
}

/* Fase B — detector de cache stale.
 * El loader sincroniza solo deltas (cs-data) — los tickets viejos en IndexedDB
 * conservan el shape original. Si el slim ganó campos nuevos (canal_normalizado,
 * chat_subtype, aircall_call_id), los tickets cacheados anteriormente NO los
 * tienen y los filtros por canal aparecerán parcialmente vacíos.
 * Detectamos: cuántos tickets faltan canal_normalizado. Si >100, banner. */
function buildStaleBanner(){
  if (!T_ALL || T_ALL.length === 0) return '';
  var stale = 0;
  for (var i = 0; i < T_ALL.length; i++) {
    if (!T_ALL[i].canal_normalizado) stale++;
  }
  if (stale < 100) return '';
  var pct = Math.round(stale * 100 / T_ALL.length);
  return '<div class="cs-stale-banner">'
    + '<span class="cs-stale-icon">⚠️</span>'
    + '<div class="cs-stale-msg">'
    + '<b>' + stale.toLocaleString('es-CL') + ' tickets (' + pct + '%) tienen info de canal incompleta</b> en tu cache local. '
    + 'Los filtros por canal (Zendesk/WotNot) van a mostrar números bajos hasta que actualices. '
    + 'Haz clic en <b>Re-cachear</b> en el header para sincronizar.'
    + '</div></div>';
}

function fld(label, inner){
  return '<div class="cs-fld"><label>' + label + '</label>' + inner + '</div>';
}
/* controles propios del tab Análisis — Modo + Día / Rango */
function anaFilterControls(){
  var now = new Date();
  var h = fld('Modo', '<select class="cs-sel" data-a="mode">'
    + '<option value="day"'   + (S.mode==='day'  ?' selected':'') + '>Día</option>'
    + '<option value="pred"'  + (S.mode==='pred' ?' selected':'') + '>Rango Pred.</option>'
    + '<option value="range"' + (S.mode==='range'?' selected':'') + '>Rango</option></select>');
  if (S.mode === 'day') {
    h += fld('Día', '<input type="date" class="cs-sel" data-a="day" value="'
      + esc(S.day || fmtDate(now)) + '">');
  } else if (S.mode === 'pred') {
    var predOpts = [10,15,30,60].map(function (n) {
      return '<option value="' + n + '"' + (predN()===n?' selected':'') + '>' + n + ' días hábiles</option>';
    }).join('');
    h += fld('Mostrar últimos', '<select class="cs-sel" data-a="predDias">' + predOpts + '</select>');
  } else {
    var defFrom = S.from || fmtDate(new Date(now.getTime() - 30*86400000));
    var defTo   = S.to   || fmtDate(now);
    h += fld('Desde', '<input type="date" class="cs-sel" data-a="from" value="' + esc(defFrom) + '">')
      + fld('Hasta', '<input type="date" class="cs-sel" data-a="to" value="' + esc(defTo) + '">')
      + fld('Gráficos por', '<select class="cs-sel" data-a="gran">'
        + '<option value="day"'   + (S.gran==='day'  ?' selected':'') + '>Por día</option>'
        + '<option value="week"'  + (S.gran==='week' ?' selected':'') + '>Por semana</option>'
        + '<option value="month"' + (S.gran==='month'?' selected':'') + '>Por mes</option></select>')
      + fld('&nbsp;', '<label class="cs-chk"><input type="checkbox" data-a="workdays"'
        + (S.workdays?' checked':'') + '> Solo días hábiles</label>');
  }
  return h;
}
/* controles propios del tab Análisis semanal — navegación de semana + ejecutivo */
function weekFilterControls(){
  var mon = semanaActual();
  var fri = new Date(mon.getTime() + 4*86400000);
  var nav = '<div class="cs-weeknav">'
    + '<button class="cs-wbtn" data-week="prev" title="Semana anterior">‹</button>'
    + '<span class="cs-wlbl">' + fmtDM(mon) + ' al ' + fmtDM(fri) + '</span>'
    + '<button class="cs-wbtn" data-week="next"' + (S.weekOffset >= 0 ? ' disabled' : '')
    + ' title="Semana siguiente">›</button></div>';
  var base = applyFilters(T);
  var agIds = {};
  base.forEach(function (t) { if (t.assignee_id) agIds[t.assignee_id] = 1; });
  var agentOpts = Object.keys(agIds).map(function (id) { return { id:id, name:agentName(id) }; })
    .filter(function (a) { return !EXCL_EJEC[a.name]; })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });
  if (S.weekAgent && !agentOpts.some(function (a) { return String(a.id) === String(S.weekAgent); }))
    S.weekAgent = '';
  var ejOpts = '<option value="">Todos los ejecutivos</option>';
  agentOpts.forEach(function (a) {
    ejOpts += '<option value="' + esc(a.id) + '"'
      + (String(S.weekAgent) === String(a.id) ? ' selected' : '') + '>' + esc(a.name) + '</option>';
  });
  return fld('Semana', nav)
    + fld('Ejecutivo', '<select class="cs-sel" data-f="weekAgent">' + ejOpts + '</select>');
}
function orgFilterControls(){
  var y2026s = '2026-01-01', y2026e = '2027-01-01';
  var vol = {};
  applyFilters(T).forEach(function(t){
    if (t.created_at && t.created_at >= y2026s && t.created_at < y2026e){
      var o = String(t.organization_id || 0);
      vol[o] = (vol[o] || 0) + 1;
    }
  });
  var orgs = Object.keys(OR).map(function(id){ return {id:id, name:OR[id]||('Org '+id), vol:vol[id]||0}; })
    .sort(function(a,b){ return (b.vol-a.vol) || a.name.localeCompare(b.name); });
  var opts = '<option value="">— Selecciona un cliente —</option>';
  orgs.forEach(function(o){
    opts += '<option value="' + esc(o.id) + '"' + (String(S.org)===String(o.id)?' selected':'') + '>'
      + esc(o.name) + (o.vol ? ' (' + o.vol + ')' : '') + '</option>';
  });
  return fld('Cliente', '<select class="cs-sel cs-org-sel" data-f="org">' + opts + '</select>');
}
/* Filtro multi-select de equipos — checkboxes + Todos/Ninguno.
   S.gids = undefined (default = todos) · [] (= ninguno) · [ids…] (selección parcial)
   S.gidsOpen persiste el estado abierto/cerrado entre repaints. */
function multiSelectGids(){
  var groups = Object.keys(GR).filter(function(id){ return GROUPS_ACTIVOS[id] && !isExcludedGid(id); })
    .map(function(id){ return { id:String(id), name:GR[id] || ('Equipo '+id) }; })
    .sort(function(a,b){ return a.name.localeCompare(b.name); });
  var total = groups.length;
  var sel = S.gids;
  /* sanea selecciones huérfanas (equipos que ya no están activos o que están excluidos) */
  if (Array.isArray(sel)){
    sel = sel.filter(function(id){ return groups.some(function(g){ return g.id === String(id); }); });
    S.gids = sel;
  }
  var label;
  if (!Array.isArray(sel))      label = 'Todos los equipos (' + total + ')';
  else if (sel.length === 0)    label = 'Ninguno seleccionado';
  else if (sel.length === total)label = 'Todos los equipos (' + total + ')';
  else if (sel.length === 1)    label = groups.filter(function(g){ return g.id === sel[0]; }).map(function(g){return g.name;})[0] || ('Equipo ' + sel[0]);
  else                          label = sel.length + ' de ' + total + ' equipos';

  var items = groups.map(function(g){
    var checked = !Array.isArray(sel) || sel.indexOf(g.id) >= 0;
    return '<label class="cs-multi-item">'
      + '<input type="checkbox" data-multi-id="gids" value="'+esc(g.id)+'"'+(checked?' checked':'')+'>'
      + '<span>'+esc(g.name)+'</span></label>';
  }).join('');

  return '<details class="cs-multi"' + (S.gidsOpen?' open':'') + '>'
    + '<summary class="cs-multi-summary">'+esc(label)+'</summary>'
    + '<div class="cs-multi-body">'
    +   '<div class="cs-multi-actions">'
    +     '<button type="button" class="cs-pbtn ghost" data-multi-all="gids">Todos</button>'
    +     '<button type="button" class="cs-pbtn ghost" data-multi-none="gids">Ninguno</button>'
    +   '</div>'
    +   '<div class="cs-multi-list">'+items+'</div>'
    + '</div></details>';
}

function channelBadge(ch){
  /* Re-encuadre 2026-05-28 — badge global del canal activo cuando no es 'all'.
   * 'zd' ya NO es "CORREO" sino "ZENDESK" (universo total de tickets, todos los canales). */
  if (!ch || ch === 'all') return '';
  var meta = {
    zd: { cls:'zd', label:'ZENDESK',  tip:'Vista universo total de tickets Zendesk (todos los canales).' },
    ac: { cls:'ac', label:'TELÉFONO', tip:'Stream de llamadas Aircall.' },
    wn: { cls:'wn', label:'CHAT',     tip:'Stream de chats Wotnot (vía Zendesk hasta deploy stream propio).' }
  }[ch];
  if (!meta) return '';
  return '<span class="cs-badge cs-badge-' + meta.cls + '" title="' + esc(meta.tip)
    + '" style="margin-left:0">' + meta.label + '</span>';
}

function buildFilterBar(){
  /* Tab Paneles Extras: query externa a Zendesk — no aplican filtros de equipo/tipo */
  if (S.tab === 'extras') return '';
  /* Vista Aircall (S.channel === 'ac'): los filtros Equipo/Tipo NO aplican (son de tickets),
   * pero los filtros de FECHA SÍ (las llamadas tienen fecha). Mostramos el badge + los
   * controles de rango del tab para que "Análisis" no quede pegado en "hoy" (copia de
   * En vivo): Análisis → Modo/Día/Rango (filtrar por mes, etc.); Semanal → navegación. */
  if (S.channel === 'ac') {
    var acBar = '<div class="cs-fbar"><div class="cs-fld" style="align-self:center">'
      + 'Vista actual: ' + channelBadge('ac') + '</div>';
    if (S.tab === 'ana')  acBar += anaFilterControls();
    if (S.tab === 'week') acBar += weekFilterControls();
    acBar += '</div>';
    return acBar;
  }
  var typeOpts = '';
  [['', 'Todos los tipos'], ['incidente', 'Incidentes'], ['solicitud', 'Solicitudes']]
    .forEach(function (o) {
      typeOpts += '<option value="' + o[0] + '"'
        + (S.type === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
    });
  var html = '<div class="cs-fbar">'
    + fld('Equipo', multiSelectGids())
    + fld('Tipo',   '<select class="cs-sel" data-f="type">' + typeOpts + '</select>');
  /* Badge canal activo (oculto cuando es 'all') */
  if (S.channel && S.channel !== 'all') {
    html += '<div class="cs-fld" style="align-self:center">'
      + 'Filtro canal: ' + channelBadge(S.channel)
      + '</div>';
  }
  if (S.tab === 'ana')  html += anaFilterControls();
  if (S.tab === 'week') html += weekFilterControls();
  if (S.tab === 'org')  html += orgFilterControls();
  html += '</div>';
  return html;
}

/* ---- TAB EN VIVO ---- */
function buildLive(){
  var universe = applyFilters(T);
  var actives  = universe.filter(function (t) { return ACTIVE[t.status]; });
  var j = kpisJornada(universe);
  var delta = j.now - j.init;
  var deltaTxt = (delta > 0 ? '+' : '') + delta + ' vs. inicio';
  var deltaCls = delta > 0 ? 'down' : (delta < 0 ? 'up' : '');
  var neto = j.in - j.res;
  var netoSub = neto > 0 ? 'el queue creció hoy' : (neto < 0 ? 'el queue bajó hoy' : 'sin cambio neto');

  var jor = '<div class="cs-kgrid k5">'
    + kpiCard(num(j.init), 'Queue al iniciar', 'a las 06:00',    '#0047BB')
    + kpiCard(num(j.in),   'Ingresos',         'desde el corte', '#2D7FF9')
    + kpiCard(num(j.res),  'Resueltos',        'por ejecutivo',  '#17A24F')
    + kpiCard((neto > 0 ? '+' : '') + neto, 'Neto tickets', netoSub, '#6B4FBB', neto > 0 ? 'down' : 'up')
    + kpiCard(num(j.now),  'Queue ahora',      deltaTxt,         '#FF6A00', deltaCls)
    + '</div>';

  var open = 0, pend = 0, breach = 0, evald = 0;
  actives.forEach(function (t) {
    if (t.status === 'new' || t.status === 'open') open++; else pend++;
    if (slaBreached(t)) breach++;
    if (slaEvaluated(t))  evald++;
  });
  var slaSub = evald ? Math.round(breach / evald * 100) + '% de los evaluados' : 'sin SLA evaluado';
  var comp = '<div class="cs-kgrid k5">'
    + kpiCard(num(actives.length), 'Tickets activos', 'new · open · pending · hold', '#FF6A00')
    + kpiCard(num(open),   'Abiertos',     'new + open',            '#0047BB')
    + kpiCard(num(pend),   'Pendientes',   'pending + hold',        '#CE8B00')
    + kpiCard(num(breach), 'Fuera de SLA', slaSub,                  '#BB1A1A', breach > 0 ? 'down' : '')
    + kpiCard(num(j.clo),  'Cerrados (auto)', 'auto-close de Zendesk', '#8895A0')
    + '</div>';

  var ages = [0,0,0,0,0], nowMs = Date.now();
  actives.forEach(function (t) {
    var d = (nowMs - ms(t.created_at)) / 86400000;
    if (d <= 1) ages[0]++; else if (d <= 5) ages[1]++;
    else if (d <= 10) ages[2]++; else if (d <= 20) ages[3]++; else ages[4]++;
  });
  var age = '<div class="cs-kgrid k5">'
    + kpiCard(num(ages[0]), '0 a 1 día',    '', '#17A24F')
    + kpiCard(num(ages[1]), '2 a 5 días',   '', '#2D7FF9')
    + kpiCard(num(ages[2]), '6 a 10 días',  '', '#FF6A00')
    + kpiCard(num(ages[3]), '10 a 20 días', '', '#E0590B')
    + kpiCard(num(ages[4]), '+20 días',     '', '#BB1A1A', ages[4] > 0 ? 'down' : '')
    + '</div>';

  /* tabla detalle por ejecutivo */
  var rows = statsPorEjecutivo(universe);
  var tb = '';
  if (!rows.length) tb = '<tr><td colspan="11" class="cs-empty">Sin tickets activos</td></tr>';
  else rows.forEach(function (r) {
    var sla = r.ev ? Math.round((r.ev - r.br) / r.ev * 100) : 100;
    tb += '<tr class="cs-clk" data-modal="agent" data-id="' + esc(r.id) + '">'
      + '<td class="name">' + esc(r.name) + '</td>'
      + '<td>' + esc(r.grp || '—') + '</td>'
      + '<td class="n">' + r.total + '</td><td class="n">' + r.op + '</td><td class="n">' + r.pe + '</td>'
      + '<td class="n dim">' + r.init + '</td><td class="n dim">' + r.in + '</td>'
      + '<td class="n dim">' + r.res + '</td><td class="n dim">' + r.clo + '</td>'
      + '<td class="n"><span class="cs-pill ' + (r.br > 0 ? 'err' : 'ok') + '">' + r.br + '</span></td>'
      + '<td class="n">' + sla + '%</td></tr>';
  });
  var tabla = '<div class="cs-h2">Detalle por ejecutivo'
    + '<span class="cs-h2s">click en una fila para ver sus tickets</span></div>'
    + '<div class="cs-card"><table class="cs-t"><thead><tr>'
    + '<th>Ejecutivo</th><th>Equipo</th><th>Total</th><th>Abiertos</th><th>Pendientes</th>'
    + '<th>Q.inicio</th><th>Ingresos</th><th>Resueltos</th><th>Cerr.auto</th>'
    + '<th>Fuera SLA</th><th>% SLA</th>'
    + '</tr></thead><tbody>' + tb + '</tbody></table></div>';

  /* top 10 clientes (click → modal) */
  var orgc = {};
  actives.forEach(function (t) {
    var id = t.organization_id || 0;
    orgc[id] = (orgc[id] || 0) + 1;
  });
  var orgRows = Object.keys(orgc).map(function (id) { return { id:id, name:orgName(id), n:orgc[id] }; })
    .sort(function (a, b) { return b.n - a.n; }).slice(0, 10);
  var maxOrg = orgRows.length ? orgRows[0].n : 1;
  var ob = '';
  if (!orgRows.length) ob = '<tr><td colspan="3" class="cs-empty">Sin datos</td></tr>';
  else orgRows.forEach(function (r) {
    var w = Math.round(r.n / maxOrg * 130);
    ob += '<tr class="cs-clk" data-modal="org" data-id="' + esc(r.id) + '">'
      + '<td class="name">' + esc(r.name) + '</td><td class="n">' + r.n + '</td>'
      + '<td><span class="cs-bar-mini" style="width:' + w + 'px"></span></td></tr>';
  });
  var clientes = '<div class="cs-h2">Top 10 clientes con tickets activos'
    + '<span class="cs-h2s">click en un cliente para ver sus tickets</span></div>'
    + '<div class="cs-card"><table class="cs-t"><thead><tr><th>Cliente</th><th>Activos</th><th></th>'
    + '</tr></thead><tbody>' + ob + '</tbody></table></div>';

  var nEq = Object.keys(actives.reduce(function (a, t) { if (t.group_id != null) a[t.group_id] = 1; return a; }, {})).length;
  var hEq = Math.min(Math.max(nEq, 1) * 32 + 64, 380);
  var hEj = Math.min(Math.max(Math.min(rows.length, 12), 1) * 30 + 64, 460);
  var charts = '<div class="cs-h2">Carga de trabajo</div>'
    + '<div class="cs-cgrid one">' + chartCard('Carga por ejecutivo', 'cCarga', hEj) + '</div>'
    + '<div class="cs-h2">Ritmo de la jornada</div>'
    + '<div class="cs-cgrid one">' + chartCard('Ingresos vs. cierres por hora', 'cHora') + '</div>'
    + '<div class="cs-h2">Distribución por equipo</div>'
    + '<div class="cs-cgrid">'
    + chartCard('Tickets por equipo', 'cTktEq', hEq)
    + chartCard('SLA por equipo', 'cSlaEq', hEq)
    + '</div>';

  return '<div class="cs-h2">Movimientos de la jornada'
    + '<span class="cs-h2s">desde las 06:00 hrs</span></div>' + jor
    + '<div class="cs-h2">Composición del queue actual</div>' + comp
    + '<div class="cs-h2">Antigüedad del queue activo</div>' + age
    + tabla + charts + clientes;
}

/* ---- TAB ANÁLISIS SEMANAL ---- */
/* clave con mayor valor dentro de un mapa {id:conteo} → {id,n} ó null */
function topEntry(obj){
  var best = null;
  Object.keys(obj).forEach(function (k) {
    if (best === null || obj[k] > best.n) best = { id:k, n:obj[k] };
  });
  return best;
}
/* universo del tab semanal: equipo+tipo y, si está activo, un solo ejecutivo */
function weekUniverse(){
  var u = applyFilters(T);
  if (S.weekAgent) u = u.filter(function (t) { return String(t.assignee_id || 0) === String(S.weekAgent); });
  return u;
}
function buildWeek(){
  var base = applyFilters(T);
  /* el filtro de ejecutivo y la navegación de semana viven en la barra unificada */
  var agFiltrado = !!S.weekAgent;
  var universe = agFiltrado
    ? base.filter(function (t) { return String(t.assignee_id || 0) === String(S.weekAgent); })
    : base;

  var wd = weekData(universe);
  var dias = wd.dias;
  var transcurridos = dias.filter(function (d) { return d.transcurrido; }).length || 1;
  var totEnt = dias.reduce(function (a, d) { return a + d.ent; }, 0);
  var totRes = dias.reduce(function (a, d) { return a + d.res; }, 0);
  var promEnt = totEnt / transcurridos;
  var promRes = totRes / transcurridos;

  var mayorCarga = dias.slice().sort(function (a, b) { return b.ent - a.ent; })[0];
  var mayorCierre = dias.slice().sort(function (a, b) { return b.res - a.res; })[0];
  var mayorConv = dias.slice().filter(function (d) { return d.ent > 0; })
    .sort(function (a, b) { return (b.res/b.ent) - (a.res/a.ent); })[0];

  /* agente con mejor desempeño (más resueltos en la semana) */
  var agg = {};
  dias.forEach(function (d) {
    Object.keys(d.byAgent).forEach(function (a) { agg[a] = (agg[a] || 0) + d.byAgent[a]; });
  });
  var bestAg = Object.keys(agg).map(function (a) { return { id:a, n:agg[a] }; })
    .sort(function (a, b) { return b.n - a.n; })[0];

  var convPct = mayorConv ? Math.round(mayorConv.res / mayorConv.ent * 100) : 0;
  var kCards = [
    kpiCard(promEnt.toFixed(1), 'Prom. diario de ingresos', 'sobre ' + transcurridos + ' día(s)', '#2D7FF9'),
    kpiCard(promRes.toFixed(1), 'Prom. diario atendido', 'sobre ' + transcurridos + ' día(s)', '#17A24F'),
    kpiCard(mayorCarga ? mayorCarga.nombre : '—', 'Día de más ingresos', mayorCarga ? mayorCarga.ent + ' ingresos' : '', '#FF6A00'),
    kpiCard(mayorCierre ? mayorCierre.nombre : '—', 'Día de más cierres', mayorCierre ? mayorCierre.res + ' resueltos' : '', '#0047BB')
  ];
  /* con filtro de ejecutivo activo, "Mejor desempeño" no aporta → se oculta */
  if (!agFiltrado) {
    kCards.push(kpiCard(bestAg ? agentName(bestAg.id) : '—', 'Mejor desempeño',
      bestAg ? bestAg.n + ' resueltos' : '', '#6B4FBB'));
  }
  var kpis = '<div class="cs-kgrid k' + kCards.length + '">' + kCards.join('') + '</div>';

  var convKpi = '<div class="cs-kgrid k4">'
    + kpiCard(num(totEnt), 'Ingresos en la semana', 'lunes a viernes', '#2D7FF9')
    + kpiCard(num(totRes), 'Resueltos en la semana', 'lunes a viernes', '#17A24F')
    + kpiCard(totEnt ? Math.round(totRes/totEnt*100) + '%' : '—', 'Conversión semanal', 'resueltos / ingresos', '#17A24F')
    + kpiCard(mayorConv ? mayorConv.nombre + ' (' + convPct + '%)' : '—', 'Día de mayor conversión', 'resueltos vs. ingresos', '#FF6A00')
    + '</div>';

  /* tabla por día — con empresa con más tickets y ejecutivo con más cierres */
  var tb = '';
  dias.forEach(function (d) {
    var conv = d.ent ? Math.round(d.res/d.ent*100) : 0;
    var to = topEntry(d.byOrg), ta = topEntry(d.byAgent);
    var orgTxt = (d.transcurrido && to)
      ? esc(orgName(to.id)) + ' <span class="sub">(' + to.n + ')</span>' : '—';
    var agTxt = (d.transcurrido && ta)
      ? esc(agentName(ta.id)) + ' <span class="sub">(' + ta.n + ')</span>' : '—';
    tb += '<tr><td class="name ind">' + d.nombre + '</td>'
      + '<td class="n">' + d.ent + '</td><td class="n">' + d.res + '</td>'
      + '<td class="n">' + (d.transcurrido ? conv + '%' : '—') + '</td>'
      + '<td class="ctr">' + orgTxt + '</td><td class="ctr">' + agTxt + '</td></tr>';
  });
  var tabla = '<div class="cs-h2">Detalle por día</div>'
    + '<div class="cs-card"><table class="cs-t"><thead><tr>'
    + '<th>Día</th><th>Ingresos</th><th>Resueltos</th><th>Conversión</th>'
    + '<th>Empresa con más tickets</th><th>Ejecutivo con más cierres</th>'
    + '</tr></thead><tbody>' + tb + '</tbody></table></div>';

  /* top 10 empresas de la semana — con % SLA, media de resolución y media de 1ª respuesta */
  var monday = wd.monday.getTime(), endWeek = monday + 5 * 86400000;
  var orgAgg = {};
  universe.forEach(function (t) {
    var c = ms(t.created_at);
    if (c < monday || c >= endWeek) return;
    var id = t.organization_id || 0;
    var o = orgAgg[id] || (orgAgg[id] = { id:id, n:0, slaEv:0, slaOk:0, durMin:0, durN:0, frtMin:0, frtN:0 });
    o.n++;
    if (slaEvaluated(t)) { o.slaEv++; if (slaOk(t)) o.slaOk++; }
    var sv = solvedMs(t);
    if (sv > 0) { var dm = (sv - c) / 60000; if (dm >= 0) { o.durMin += dm; o.durN++; } }
    if (t.frt_min != null && t.frt_min >= 0) { o.frtMin += t.frt_min; o.frtN++; }
  });
  var orgRows = Object.keys(orgAgg).map(function (id) { return orgAgg[id]; })
    .sort(function (a, b) { return b.n - a.n; }).slice(0, 10);
  var ob = orgRows.length
    ? orgRows.map(function (r) {
        var slaTxt = r.slaEv ? Math.round(r.slaOk / r.slaEv * 100) + '%' : '—';
        var durTxt = r.durN ? fmtMin(r.durMin / r.durN) : '—';
        var frtTxt = r.frtN ? fmtMin(r.frtMin / r.frtN) : '—';
        return '<tr><td class="name ind">' + esc(orgName(r.id)) + '</td>'
          + '<td class="n">' + r.n + '</td><td class="n">' + slaTxt + '</td>'
          + '<td class="n">' + durTxt + '</td><td class="n">' + frtTxt + '</td></tr>';
      }).join('')
    : '<tr><td colspan="5" class="cs-empty">Sin datos</td></tr>';
  var empresas = '<div class="cs-h2">Top 10 empresas de la semana'
    + '<span class="cs-h2s">tickets creados lun-vie · FRT = 1ª respuesta (Zendesk)</span></div>'
    + '<div class="cs-card"><table class="cs-t"><thead><tr>'
    + '<th>Empresa</th><th>Tickets</th><th>% SLA</th>'
    + '<th>Media resolución</th><th>Media 1ª respuesta</th>'
    + '</tr></thead><tbody>' + ob + '</tbody></table></div>';

  var chart = '<div class="cs-h2">Ingresos vs. atendidos vs. bolsa al cierre del día</div>'
    + '<div class="cs-cgrid one">' + chartCard('Semana en curso (lunes a viernes)', 'cWeek', 360) + '</div>';

  var fri = new Date(wd.monday.getTime() + 4*86400000);
  var rotulo = S.weekOffset === 0
    ? 'semana en curso'
    : 'semana del ' + fmtDM(wd.monday) + ' al ' + fmtDM(fri);
  return '<div class="cs-h2">Resumen de la semana'
    + '<span class="cs-h2s">' + fmtDM(wd.monday) + ' — ' + rotulo
    + (agFiltrado ? ' · ejecutivo: ' + esc(agentName(S.weekAgent)) : '') + '</span></div>'
    + kpis + convKpi + chart + tabla + empresas;
}

/* ---- TAB ANÁLISIS ---- */
function buildAna(){
  /* los controles Modo/Día/Rango viven ahora en la barra de filtros unificada */
  var universe = applyFilters(T);
  var s = anaSets(universe);
  var initN = s.INIT.length, inN = s.IN.length, resN = s.RESOLVED.length, cloN = s.CLOSED.length;
  var finalN = initN + inN - resN;
  var balance = inN - resN;
  var balTxt = (balance > 0 ? '+' : '') + balance + ' sobre entradas';
  var rango = rangoCorto(s.win);

  /* SLA cumplido del período (sobre tickets con SLA evaluado) */
  var slaEv = 0, slaOkN = 0;
  s.IN.concat(s.RESOLVED).forEach(function (t) {
    if (slaEvaluated(t)) { slaEv++; if (slaOk(t)) slaOkN++; }
  });
  var slaPctTxt = slaEv ? Math.round(slaOkN / slaEv * 100) + '%' : '—';

  var csG = 0, csB = 0;
  s.RESOLVED.forEach(function (t) {
    if (t.csat === 'good') csG++; else if (t.csat === 'bad') csB++;
  });
  var csN = csG + csB;
  var csatTxt = csN ? Math.round(csG / csN * 100) + '%' : '—';
  var resumen = '<div class="cs-h2">Resumen del período'
    + '<span class="cs-h2s">' + esc(s.win.label) + '</span></div>'
    + '<div class="cs-kgrid k4">'
    + kpiCard(num(resN), 'Tickets gestionados', rango, '#0047BB')
    + kpiCard(slaPctTxt, 'SLA cumplido', slaEv ? rango + ' · ' + slaEv + ' evaluados' : 'sin SLA en el histórico', '#17A24F')
    + kpiCard(num(inN), 'Ingresos del período', rango, '#2D7FF9')
    + kpiCard(csatTxt, 'CSAT', csN ? csN + ' respuestas · ' + rango : 'sin respuestas en el período', '#FF6A00')
    + '</div>';

  var durs = s.RESOLVED.map(function (t) {
    return (ms(t.solved_at || t.updated_at) - ms(t.created_at)) / 3600000;
  }).filter(function (x) { return x >= 0; });
  var avgH = durs.length ? durs.reduce(function (a,b){ return a+b; }, 0) / durs.length : 0;

  var kpis = '<div class="cs-h2">Movimiento de tickets</div>'
    + '<div class="cs-kgrid k5">'
    + kpiCard(num(initN), 'Queue al iniciar', 'al inicio del período', '#0047BB')
    + kpiCard(num(inN),   'Ingresos',         'creados en el período', '#2D7FF9')
    + kpiCard(num(resN),  'Resueltos',        'por ejecutivo',         '#17A24F')
    + kpiCard(num(cloN),  'Cerrados (auto)',  'auto-close de Zendesk', '#8895A0')
    + kpiCard(num(finalN),'Queue estimado',   balTxt, '#FF6A00', balance > 0 ? 'down' : 'up')
    + '</div>';

  var frts = s.RESOLVED.map(function (t) { return t.frt_min; })
    .filter(function (x) { return x != null && x >= 0; }).sort(function (a,b){ return a-b; });
  var frtAvg = frts.length ? frts.reduce(function (a,b){ return a+b; }, 0) / frts.length : null;
  var frtMed = frts.length ? (frts.length % 2 ? frts[(frts.length-1)/2]
    : (frts[frts.length/2-1] + frts[frts.length/2]) / 2) : null;
  var reos = s.RESOLVED.map(function (t) { return t.reopens; }).filter(function (x){ return x != null; });
  var reoTot = reos.reduce(function (a,b){ return a+b; }, 0);
  var reoCnt = reos.filter(function (x){ return x > 0; }).length;
  var reoRate = s.RESOLVED.length ? Math.round(reoCnt / s.RESOLVED.length * 100) : 0;

  var calidad = '<div class="cs-h2">Calidad de atención'
    + '<span class="cs-h2s">sobre ' + num(resN) + ' tickets resueltos</span></div>'
    + '<div class="cs-kgrid k5">'
    + kpiCard(fmtMin(frtAvg), 'FRT promedio',  'primera respuesta', '#0047BB')
    + kpiCard(fmtMin(frtMed), 'FRT mediana',   'primera respuesta', '#2D7FF9')
    + kpiCard(avgH ? avgH.toFixed(1) + ' h' : '—', 'Resolución prom.', 'creación → cierre', '#17A24F')
    + kpiCard(num(reoTot),    'Reaperturas',   reoCnt + ' tickets afectados', '#CE8B00')
    + kpiCard(reoRate + '%',  'Tasa reapertura', 'de los resueltos', '#BB1A1A', reoRate > 0 ? 'down' : '')
    + '</div>';

  /* escalamientos SN1 → SN2 → MO — sobre las entradas del período que pasaron por SN1 */
  var escBase = s.IN.filter(function (t) { return t.paso_sn1; });
  var escSN2  = escBase.filter(function (t) { return t.esc_sn2; });
  var escMO   = escSN2.filter(function (t) { return t.esc_mo; });
  var devolN = 0, devolTk = 0;
  s.IN.forEach(function (t) { if (t.devol) { devolN += t.devol; devolTk++; } });
  var pSN2 = escBase.length ? Math.round(escSN2.length / escBase.length * 100) : 0;
  var pMO  = escSN2.length  ? Math.round(escMO.length  / escSN2.length  * 100) : 0;
  var escalam = '<div class="cs-h2">Escalamientos'
    + '<span class="cs-h2s">entradas del período que pasaron por SN1</span></div>'
    + '<div class="cs-kgrid k4">'
    + kpiCard(num(escBase.length), 'Pasaron por SN1', 'base del cálculo', '#0047BB')
    + kpiCard(pSN2 + '%', 'Escalado a SN2', escSN2.length + ' tickets', '#FF6A00')
    + kpiCard(pMO + '%',  'Escalado a MO',  escMO.length + ' de los que llegaron a SN2', '#BB1A1A')
    + kpiCard(num(devolTk), 'Devoluciones SN2→SN1', devolN + ' rebotes en total', '#CE8B00', devolTk > 0 ? 'down' : '')
    + '</div>';

  var flujoTitulo = S.mode === 'day'
    ? 'Ingresos vs. atendidos vs. cerrados (auto) por hora'
    : 'Ingresos vs. atendidos vs. bolsa al cierre del día';
  var charts = '<div class="cs-h2">Tendencias del período</div>'
    + '<div class="cs-cgrid one">' + chartCard(flujoTitulo, 'cFlujo', 360) + '</div>'
    + '<div class="cs-cgrid">'
    + chartCard('Tickets por mes', 'cMensual')
    + chartCard('CSAT % por mes', 'cCsat')
    + '</div>'
    + '<div class="cs-cgrid">'
    + chartCard('Distribución por categoría', 'cCategoria')
    + chartCard('Resueltos por ejecutivo', 'cEjecAna')
    + '</div>';

  /* detalle por categoría (entradas del período) — segrega las categorías < 1% */
  var catc = {};
  s.IN.forEach(function (t) { var c = t.categoria || '(sin categoría)'; catc[c] = (catc[c] || 0) + 1; });
  var catRows = Object.keys(catc).map(function (c) { return { name:c, n:catc[c] }; })
    .sort(function (a, b) { return b.n - a.n; });
  var totCat = catRows.reduce(function (a, r) { return a + r.n; }, 0) || 1;
  var catMaj = catRows.filter(function (r) { return r.n / totCat >= 0.01; });
  var catMin = catRows.filter(function (r) { return r.n / totCat < 0.01; });
  var ctb;
  if (!catRows.length) {
    ctb = '<tr><td colspan="3" class="cs-empty">Sin datos de categoría</td></tr>';
  } else {
    ctb = catMaj.map(function (r) {
      return '<tr><td class="n">' + esc(r.name) + '</td><td class="n">' + r.n
        + '</td><td class="n">' + Math.round(r.n / totCat * 100) + '%</td></tr>';
    }).join('');
    if (catMin.length) {
      var minN = catMin.reduce(function (a, r) { return a + r.n; }, 0);
      ctb += '<tr><td class="n dim">Otras (' + catMin.length + ' categorías &lt; 1%)</td>'
        + '<td class="n dim">' + minN + '</td>'
        + '<td class="n dim">' + Math.round(minN / totCat * 100) + '%</td></tr>';
    }
  }
  var detCat = '<div class="cs-h2">Detalle por categoría'
    + '<span class="cs-h2s">entradas del período · categorías &lt; 1% agrupadas</span></div>'
    + '<div class="cs-card"><table class="cs-t"><thead><tr>'
    + '<th>Categoría</th><th>Tickets</th><th>% del total</th>'
    + '</tr></thead><tbody>' + ctb + '</tbody></table></div>';

  return resumen + kpis + calidad + escalam + detCat + charts;
}

/* ============================================================
   CHARTS
   ============================================================ */
function destroyCharts(){ CHARTS.forEach(function (c) { try { c.destroy(); } catch (e) {} }); CHARTS = []; }
function mkChart(id, cfg){
  var el = BODY.querySelector('#' + id);
  if (!el || !CHART) return;
  if (!cfg.options) cfg.options = {};
  cfg.options.responsive = true;
  cfg.options.maintainAspectRatio = false;
  CHARTS.push(new CHART(el, cfg));
}
function baseLegend(){ return { labels: { color: AXIS, boxWidth: 12, font: { size: 11 } } }; }
function axisOpts(stacked){
  return {
    x: { stacked: !!stacked, ticks: { color: AXIS, font: { size: 11 } }, grid: { color: GRID } },
    y: { stacked: !!stacked, ticks: { color: AXIS, font: { size: 11 } }, grid: { color: GRID } }
  };
}

/* combo de flujo — paleta del design system iConstruye:
   Ingresos = Azul IC · Atendidos = Verde success · Cerrados auto = Gris Medio IC ·
   Bolsa = Naranjo IC (barras). Líneas sobre eje izq.; barras sobre eje der. */
var COMBO_COL = { ing:'#0047BB', att:'#17A24F', clo:'#425563', bolsa:'#FF6A00' };
function comboFlujoChart(id, buckets, conBolsa, ejeY){
  var ds = [
    { type:'line', label:'Ingresos', yAxisID:'y', order:1,
      data:buckets.map(function (b){ return b.rec; }),
      borderColor:COMBO_COL.ing, backgroundColor:COMBO_COL.ing, tension:.35, pointRadius:3, borderWidth:2 },
    { type:'line', label:'Atendidos (resueltos)', yAxisID:'y', order:2,
      data:buckets.map(function (b){ return b.att; }),
      borderColor:COMBO_COL.att, backgroundColor:COMBO_COL.att, tension:.35, pointRadius:3, borderWidth:2 },
    { type:'line', label:'Cerrados (auto)', yAxisID:'y', order:3,
      data:buckets.map(function (b){ return b.clo; }),
      borderColor:COMBO_COL.clo, backgroundColor:COMBO_COL.clo, borderDash:[5,4], tension:.35, pointRadius:2, borderWidth:2 }
  ];
  if (conBolsa) {
    ds.push({ type:'bar', label:'Bolsa al cierre del día', yAxisID:'y1', order:4,
      data:buckets.map(function (b){ return b.bolsa; }),
      backgroundColor:'rgba(255,106,0,.26)', borderColor:'rgba(255,106,0,.70)', borderWidth:1 });
  }
  var scales = {
    x: axisOpts(false).x,
    y: { position:'left', beginAtZero:true, title:{ display:true, text:ejeY || 'Tickets / día', color:AXIS },
         ticks:{ color:AXIS, font:{size:11} }, grid:{ color:GRID } }
  };
  if (conBolsa) {
    scales.y1 = { position:'right', title:{ display:true, text:'Bolsa total', color:AXIS },
      ticks:{ color:AXIS, font:{size:11} }, grid:{ display:false } };
  }
  mkChart(id, {
    type:'bar',
    data:{ labels:buckets.map(function (b){ return b.label; }), datasets:ds },
    options:{ plugins:{ legend:baseLegend() }, interaction:{ mode:'index', intersect:false }, scales:scales }
  });
}

function drawLiveCharts(){
  var universe = applyFilters(T);
  var actives = universe.filter(function (t) { return ACTIVE[t.status]; });

  var ge = {};
  actives.forEach(function (t) {
    var k = groupName(t.group_id);
    if (!ge[k]) ge[k] = { op:0, pe:0 };
    if (t.status === 'new' || t.status === 'open') ge[k].op++; else ge[k].pe++;
  });
  var gEnt = Object.keys(ge).map(function (k){ return [k, ge[k]]; })
    .sort(function (a,b){ return (b[1].op+b[1].pe) - (a[1].op+a[1].pe); }).slice(0, 10);
  mkChart('cTktEq', {
    type: 'bar',
    data: { labels: gEnt.map(function (e){ return e[0]; }), datasets: [
      { label:'Abiertos',   data:gEnt.map(function (e){ return e[1].op; }), backgroundColor:'#0047BB' },
      { label:'Pendientes', data:gEnt.map(function (e){ return e[1].pe; }), backgroundColor:'#CE8B00' }
    ]},
    options: { indexAxis:'y', plugins:{ legend:baseLegend() }, scales:axisOpts(true) }
  });

  var gs = {};
  actives.forEach(function (t) {
    var k = groupName(t.group_id);
    if (!gs[k]) gs[k] = { ok:0, br:0 };
    if (slaBreached(t)) gs[k].br++;
    else if (slaOk(t)) gs[k].ok++;
  });
  var sEnt = Object.keys(gs).map(function (k){ return [k, gs[k]]; })
    .sort(function (a,b){ return (b[1].ok+b[1].br) - (a[1].ok+a[1].br); }).slice(0, 10);
  mkChart('cSlaEq', {
    type: 'bar',
    data: { labels: sEnt.map(function (e){ return e[0]; }), datasets: [
      { label:'Dentro de SLA', data:sEnt.map(function (e){ return e[1].ok; }), backgroundColor:'#17A24F' },
      { label:'Fuera de SLA',  data:sEnt.map(function (e){ return e[1].br; }), backgroundColor:'#BB1A1A' }
    ]},
    options: { indexAxis:'y', plugins:{ legend:baseLegend() }, scales:axisOpts(true) }
  });

  var rows = statsPorEjecutivo(universe).slice(0, 12);
  mkChart('cCarga', {
    type: 'bar',
    data: { labels: rows.map(function (r){ return r.name; }), datasets: [
      { label:'Abiertos',   data:rows.map(function (r){ return r.op; }), backgroundColor:'#0047BB' },
      { label:'Pendientes', data:rows.map(function (r){ return r.pe; }), backgroundColor:'#CE8B00' }
    ]},
    options: { indexAxis:'y', plugins:{ legend:baseLegend() }, scales:axisOpts(true) }
  });

  /* ingresos vs cierres por hora — jornada actual */
  var start = jornadaStartMs();
  var horas = [], idx = {};
  for (var h = 0; h < 24; h++) {
    var hd = new Date(start + h * 3600000);
    if (hd.getTime() > Date.now() + 3600000) break;
    var lbl = String(hd.getHours()).padStart(2,'0') + 'h';
    idx[h] = horas.length; horas.push({ lbl:lbl, base:start + h*3600000, ent:0, cie:0 });
  }
  universe.forEach(function (t) {
    var c = ms(t.created_at);
    if (c >= start) { var hi = Math.floor((c - start)/3600000); if (idx[hi] != null) horas[idx[hi]].ent++; }
    var sv = solvedMs(t);
    if (sv >= start) { var hs = Math.floor((sv - start)/3600000); if (idx[hs] != null) horas[idx[hs]].cie++; }
  });
  mkChart('cHora', {
    type: 'line',
    data: { labels: horas.map(function (x){ return x.lbl; }), datasets: [
      { label:'Ingresos', data:horas.map(function (x){ return x.ent; }), borderColor:'#2D7FF9', backgroundColor:'rgba(45,127,249,.12)', fill:true, tension:.35 },
      { label:'Cierres',  data:horas.map(function (x){ return x.cie; }), borderColor:'#17A24F', backgroundColor:'rgba(23,162,79,.12)', fill:true, tension:.35 }
    ]},
    options: { plugins:{ legend:baseLegend() }, interaction:{ mode:'index', intersect:false }, scales:axisOpts(false) }
  });
}

function drawWeekCharts(){
  var u = weekUniverse();
  var wd = weekData(u);
  var bk = wd.dias.map(function (d){ return { d0:d.d0, d1:d.d1, label:d.nombre }; });
  flujoBuckets(u, bk);
  comboFlujoChart('cWeek', bk, true, 'Tickets / día');
}

function bucketKey(iso, gran){
  var d = new Date(iso);
  if (gran === 'hour') return fmtDate(d) + ' ' + String(d.getHours()).padStart(2,'0') + 'h';
  if (gran === 'day')  return fmtDate(d);
  if (gran === 'week') {
    var dw = d.getDay() || 7, m = new Date(d);
    m.setDate(d.getDate() - dw + 1);
    return fmtDate(m);
  }
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
}

function drawAnaCharts(){
  var universe = applyFilters(T);
  var s = anaSets(universe);

  /* combo flujo — reemplaza el antiguo "Flujo: entradas vs. cierres" */
  if (S.mode === 'day') {
    var wd0 = computeAnaWindow();
    var bkH = bucketsHora(wd0.startMs, wd0.endMs);
    flujoBuckets(universe, bkH);
    comboFlujoChart('cFlujo', bkH, false, 'Tickets / hora');   /* un día → sin bolsa diaria */
  } else {
    var wd1 = computeAnaWindow();
    var bkD = S.mode === 'pred'
      ? ultimosDiasHabiles(predN())
      : diasHabilesEntre(wd1.startMs, wd1.endMs);
    flujoBuckets(universe, bkD);
    comboFlujoChart('cFlujo', bkD, true, 'Tickets / día');
  }

  /* tickets por mes — creados dentro del período filtrado (respeta el filtro de fecha) */
  var pm = {};
  s.IN.forEach(function (t) {
    if (!t.created_at) return;
    var k = t.created_at.slice(0, 7);
    pm[k] = (pm[k] || 0) + 1;
  });
  var pmKeys = Object.keys(pm).sort();
  mkChart('cMensual', {
    type: 'bar',
    data: { labels: pmKeys.map(function (k){ var p = k.split('-'); return MES[+p[1]-1] + ' ' + p[0].slice(2); }),
      datasets: [ { label:'Tickets creados', data:pmKeys.map(function (k){ return pm[k]; }), backgroundColor:'#FF6A00' } ] },
    options: { plugins:{ legend:{ display:false } }, scales:axisOpts(false) }
  });

  /* distribución por categoría — entradas del período, ≥1% (resto agrupado en "Otras") */
  var catC = {};
  s.IN.forEach(function (t){ var c = t.categoria || '(sin categoría)'; catC[c] = (catC[c]||0)+1; });
  var catTot = Object.keys(catC).reduce(function (a,k){ return a+catC[k]; }, 0) || 1;
  var catArr = Object.keys(catC).map(function (c){ return { name:c, n:catC[c] }; })
    .sort(function (a,b){ return b.n - a.n; });
  var catLbl = [], catVal = [], catOtras = 0, catOtrasN = 0;
  catArr.forEach(function (r) {
    if (r.n / catTot >= 0.01) { catLbl.push(r.name); catVal.push(r.n); }
    else { catOtras += r.n; catOtrasN++; }
  });
  if (catOtrasN) { catLbl.push('Otras (' + catOtrasN + ')'); catVal.push(catOtras); }
  mkChart('cCategoria', {
    type: 'bar',
    data: { labels: catLbl, datasets: [
      { label:'Ingresos', data:catVal, backgroundColor:'#FF6A00' }
    ]},
    options: { indexAxis:'y', plugins:{ legend:{ display:false } }, scales:axisOpts(false) }
  });

  /* CSAT % por mes (sobre resueltos con encuesta respondida) */
  var cm = {};
  s.RESOLVED.forEach(function (t) {
    if (t.csat !== 'good' && t.csat !== 'bad') return;
    var ref = t.solved_at || t.updated_at;
    if (!ref) return;
    var k = ref.slice(0, 7);
    if (!cm[k]) cm[k] = { g:0, n:0 };
    cm[k].n++; if (t.csat === 'good') cm[k].g++;
  });
  var cmK = Object.keys(cm).sort();
  mkChart('cCsat', {
    type: 'line',
    data: { labels: cmK.map(function (k){ var p=k.split('-'); return MES[+p[1]-1]+' '+p[0].slice(2); }),
      datasets: [ { label:'CSAT %', data:cmK.map(function (k){ return Math.round(cm[k].g/cm[k].n*100); }),
        borderColor:'#FF6A00', backgroundColor:'rgba(255,106,0,.14)', fill:true, tension:.35 } ] },
    options: { plugins:{ legend:baseLegend() },
      scales: { x: axisOpts(false).x, y: { min:0, max:100, ticks:{ color:AXIS, font:{size:11} }, grid:{ color:GRID } } } }
  });

  var byA = {};
  s.RESOLVED.forEach(function (t){ var id = t.assignee_id || 0; byA[id] = (byA[id]||0)+1; });
  var aRows = Object.keys(byA).map(function (id){ return { name:agentName(id), n:byA[id] }; })
    .filter(function (r){ return !EXCL_EJEC[r.name]; })
    .sort(function (a,b){ return b.n - a.n; }).slice(0, 12);
  mkChart('cEjecAna', {
    type: 'bar',
    data: { labels: aRows.map(function (r){ return r.name; }), datasets: [
      { label:'Resueltos', data:aRows.map(function (r){ return r.n; }), backgroundColor:'#17A24F' }
    ]},
    options: { indexAxis:'y', plugins:{ legend:{ display:false } }, scales:axisOpts(false) }
  });
}

/* ============================================================
   TAB CLIENTES
   ============================================================ */
/* paginación + componente de navegación reusable */
function pageNav(curPg, totalPgs, action, info){
  if (totalPgs <= 1) return '';
  /* ventana de 7 botones: actual ± 3, con < y > extremos */
  var btns = '';
  var lo = Math.max(0, curPg - 3), hi = Math.min(totalPgs-1, curPg + 3);
  if (lo > 0) { btns += '<button class="cs-pbtn ghost" data-act="'+action+'" data-page="0">«</button>'; }
  for (var p = lo; p <= hi; p++)
    btns += '<button class="cs-pbtn'+(p===curPg?' on':'')+'" data-act="'+action+'" data-page="'+p+'">'+(p+1)+'</button>';
  if (hi < totalPgs-1) { btns += '<button class="cs-pbtn ghost" data-act="'+action+'" data-page="'+(totalPgs-1)+'">»</button>'; }
  return '<div class="cs-pnav">'
    + '<span class="info">'+ (info||('Página '+(curPg+1)+' de '+totalPgs)) +'</span>'
    + btns + '</div>';
}

/* Estado vacío del tab Clientes — panorama global + buscador + tabla paginada.
   Pensado para que VP/líderes detecten en 2s qué clientes tienen problemas. */
function topClientes2026(){
  var y2026s = '2026-01-01', y2026e = '2027-01-01';
  var base = applyFilters(T);

  /* agregaciones por cliente — single pass */
  var vol = {}, act = {}, hist = {}, br = {};
  base.forEach(function(t){
    var o = String(t.organization_id || 0);
    if (o === '0') return;
    if (t.created_at && t.created_at >= y2026s && t.created_at < y2026e) vol[o] = (vol[o]||0) + 1;
    if (ACTIVE[t.status])  act[o]  = (act[o]||0)  + 1;
    else                   hist[o] = (hist[o]||0) + 1;
    if (slaBreached(t)) br[o] = (br[o]||0) + 1;
  });

  /* KPIs panorámicos sobre los clientes — para encabezado del tab */
  var clientIds = Object.keys(vol).concat(Object.keys(act)).filter(function(v,i,a){ return a.indexOf(v)===i; });
  var nClientes = clientIds.length;
  var nClientesActivos = Object.keys(act).filter(function(k){ return (act[k]||0) > 0; }).length;
  var nTicketsActivos = base.filter(function(t){ return ACTIVE[t.status] && t.organization_id; }).length;
  var nFueraSla = base.filter(function(t){ return ACTIVE[t.status] && slaBreached(t); }).length;
  var slaEvalArr2 = base.filter(function(t){ return slaEvaluated(t); });
  var slaOkArr = slaEvalArr2.filter(function(t){ return slaOk(t); });
  var pctSlaPanel = slaEvalArr2.length ? Math.round(slaOkArr.length/slaEvalArr2.length*100) : null;

  var kpisGlobal = '<div class="cs-kgrid k4">'
    + kpiCard(num(nClientesActivos), 'Clientes con tickets activos', 'sobre ' + num(nClientes) + ' del panel', '#0047BB')
    + kpiCard(num(nTicketsActivos), 'Tickets activos totales',       'en clientes',                          '#FF6A00')
    + kpiCard(num(nFueraSla),       'Activos fuera de SLA',          nFueraSla > 0 ? 'requieren atención' : 'sin SLA vencido', '#BB1A1A', nFueraSla > 0 ? 'down' : 'up')
    + kpiCard(pctSlaPanel != null ? pctSlaPanel + '%' : '—', 'SLA cumplido del panel', slaEvalArr2.length + ' tickets evaluados', '#17A24F')
    + '</div>';

  /* ordenar por activos descendente y luego por volumen 2026 */
  var all = clientIds.sort(function(a,b){
    return (act[b]||0)-(act[a]||0) || (vol[b]||0)-(vol[a]||0);
  });

  /* paginación */
  var TOP_PER_PAGE = 10;
  var totalPgs = Math.max(1, Math.ceil(all.length / TOP_PER_PAGE));
  var curPg    = Math.min(S.orgTopPage||0, totalPgs-1);
  var slice    = all.slice(curPg*TOP_PER_PAGE, curPg*TOP_PER_PAGE+TOP_PER_PAGE);
  var offset   = curPg * TOP_PER_PAGE;

  var rows = slice.map(function(id, i){
    var nm = OR[id]||('Org '+id);
    var slaCell = br[id]
      ? '<span class="cs-pill err">'+br[id]+' vencidos</span>'
      : '<span class="cs-pill ok">Sin vencidos</span>';
    return '<tr class="cs-clk" data-act="orgSelect" data-id="' + esc(id) + '">'
      + '<td class="cs-rc ctr">' + (offset+i+1) + '</td>'
      + '<td class="l name">' + esc(nm) + '</td>'
      + '<td class="n">' + (act[id]||0) + '</td>'
      + '<td class="n">' + (hist[id]||0) + '</td>'
      + '<td class="n">' + (vol[id]||0) + '</td>'
      + '<td class="ctr">' + slaCell + '</td>'
      + '<td class="ctr"><span class="cs-arrow">→</span></td>'
      + '</tr>';
  }).join('');

  var tabla = '<div class="cs-card">'
    + '<div class="cs-ch-t-row" style="padding:14px 16px 0">'
    +   '<span class="cs-ch-t" style="margin:0;padding:0">Clientes ordenados por carga activa</span>'
    +   '<span class="cs-h2s">click para analizar</span>'
    + '</div>'
    + '<table class="cs-t cs-org-tbl"><thead><tr>'
    +   '<th class="cs-rc">#</th><th class="l">Cliente</th>'
    +   '<th>Activos</th><th>Históricos</th><th>Total 2026</th>'
    +   '<th>SLA</th><th class="cs-rc"></th>'
    + '</tr></thead><tbody>'
    + (rows||'<tr><td colspan="7" class="cs-empty">Sin clientes con los filtros actuales</td></tr>')
    + '</tbody></table>'
    + pageNav(curPg, totalPgs, 'orgTopPage', num(all.length) + ' clientes · 10 por página')
    + '</div>';

  var search = '<div class="cs-org-search">'
    + '<span class="icon">🔍</span>'
    + '<input type="text" id="cs-org-finder" placeholder="Busca un cliente por nombre y presiona Enter…">'
    + '</div>';

  return '<div class="cs-h2">Panorama de clientes'
    + '<span class="cs-h2s">selecciona un cliente para abrir su análisis completo</span></div>'
    + kpisGlobal + search + tabla;
}

/* Tabla de ejecutivos del cliente — paginada 10/pág, orden activos > resueltos > total */
function buildEjecutivosCliente(universe){
  var by = {};
  function row(id){
    if (!by[id]) by[id] = { id:id, name:agentName(id), grp:'', total:0, act:0, res:0, br:0, ev:0, frtSum:0, frtN:0 };
    return by[id];
  }
  universe.forEach(function(t){
    if (!t.assignee_id || agExcluido(t.assignee_id)) return;
    var r = row(t.assignee_id);
    if (t.group_id && !r.grp) r.grp = groupName(t.group_id);
    r.total++;
    if (ACTIVE[t.status]) r.act++;
    var sv = solvedMs(t);
    if (sv > 0) r.res++;
    if (slaEvaluated(t)) { r.ev++; if (slaBreached(t)) r.br++; }
    if (t.frt_min != null && t.frt_min > 0) { r.frtSum += t.frt_min; r.frtN++; }
  });
  var rows = Object.keys(by).map(function(k){ return by[k]; })
    .sort(function(a,b){ return b.act - a.act || b.res - a.res || b.total - a.total; });
  if (!rows.length) return '<div class="cs-card"><div class="cs-empty">Sin ejecutivos con tickets de este cliente.</div></div>';

  var EPAGE     = 10;
  var eTotalPgs = Math.max(1, Math.ceil(rows.length/EPAGE));
  var eCurPg    = Math.min(S.orgEjecPage||0, eTotalPgs-1);
  var eSlice    = rows.slice(eCurPg*EPAGE, eCurPg*EPAGE+EPAGE);

  var tb = eSlice.map(function(r){
    var pctSla = r.ev ? Math.round((r.ev-r.br)/r.ev*100) : null;
    var frtAvg = r.frtN ? fmtMin(r.frtSum/r.frtN) : '—';
    return '<tr><td class="l name">'+esc(r.name)+'</td>'
      +'<td>'+esc(r.grp||'—')+'</td>'
      +'<td class="n">'+r.total+'</td>'
      +'<td class="n">'+r.act+'</td>'
      +'<td class="n">'+r.res+'</td>'
      +'<td class="n">'+(pctSla!=null?pctSla+'%':'—')+'</td>'
      +'<td class="n">'+frtAvg+'</td></tr>';
  }).join('');
  return '<div class="cs-card"><div class="cs-tscroll"><table class="cs-t"><thead><tr>'
    + '<th class="l">Ejecutivo</th><th>Equipo</th><th>Total</th><th>Activos</th><th>Resueltos</th><th>% SLA</th><th>FRT prom.</th>'
    + '</tr></thead><tbody>'+tb+'</tbody></table></div>'
    + pageNav(eCurPg, eTotalPgs, 'orgEjecPage', rows.length + ' ejecutivos · ' + EPAGE + ' por página')
    + '</div>';
}

/* Componente "Recurrencia detectada" — bigramas con ≥3 tickets, expandible */
function buildRecurrencia(universe){
  var groups = orgRecurrence(universe);
  if (!groups.length) return '<div class="cs-card"><div class="cs-empty">No se detectaron grupos de tickets recurrentes (mínimo 3 con bigrama común).</div></div>';
  var items = groups.map(function(g){
    var open = !!S.orgRec[g.bigram];
    var ids = g.tickets.slice(0, 24).map(function(t){
      return '<a href="'+ZD+t.id+'" target="_blank" rel="noopener" title="'+esc(t.subject)+'">#'+t.id+'</a>';
    }).join(' ');
    var more = g.tickets.length > 24 ? ' <span class="more">+'+(g.tickets.length-24)+' más</span>' : '';
    return '<div class="cs-rec-row '+(open?'open':'')+'">'
      + '<button class="cs-rec-item" data-act="orgRec" data-bg="'+esc(g.bigram)+'">'
      +   '<span class="term">'+esc(g.bigram)+'</span>'
      +   '<span class="cs-pill in">'+g.n+' tickets</span>'
      +   '<span class="caret">'+(open?'▾':'▸')+'</span>'
      + '</button>'
      + (open ? '<div class="cs-rec-ids">'+ids+more+'</div>' : '')
      + '</div>';
  }).join('');
  return '<div class="cs-card"><div class="cs-ch-t">'+groups.length+' temas recurrentes detectados</div>'
    + '<div class="cs-rec-list">'+items+'</div></div>';
}

function buildOrg(){
  if (!S.org) return topClientes2026();
  var universe = orgUniverse(S.org);
  if (!universe.length) return '<div class="cs-card cs-org-empty-card">'
    + '<button class="cs-org-back" data-act="orgSelect" data-id="">← Volver al panorama</button>'
    + '<div class="cs-empty">Sin tickets para este cliente con los filtros actuales (' + esc(OR[S.org]||S.org) + ').</div></div>';

  var k    = orgKPIs(universe);
  var bp   = panelBaseline();
  var name = esc(OR[S.org] || ('Org ' + S.org));

  /* === cabecera enriquecida === */
  var badges = '';
  if (k.activos > 0)
    badges += '<span class="cs-pill '+(k.activos>10?'alert':'in')+'">'+k.activos+' activos</span>';
  if (k.brSla > 0)
    badges += '<span class="cs-pill err">'+k.brSla+' fuera de SLA</span>';
  if (k.pctSla != null && k.pctSla >= 85)
    badges += '<span class="cs-pill ok">SLA saludable</span>';
  if (k.sn2 > 0 && k.pctSn2 > 20)
    badges += '<span class="cs-pill alert">'+Math.round(k.pctSn2)+'% escalado SN2</span>';

  var cabecera = '<div class="cs-card cs-org-head">'
    + '<button class="cs-org-back" data-act="orgSelect" data-id="">← Volver al panorama</button>'
    + '<div class="cs-org-name">' + name + '</div>'
    + '<div class="cs-org-meta">'
    +   '<span><b class="b">' + num(k.total) + '</b> tickets totales</span>'
    +   '<span class="sep">·</span>'
    +   '<span><b class="b">' + k.activos + '</b> activos</span>'
    +   '<span class="sep">·</span>'
    +   '<span><b class="b">' + k.numEjecutivos + '</b> ejecutivo' + (k.numEjecutivos!==1?'s':'') + ' atendiendo</span>'
    + (k.primerTicket ? '<span class="sep">·</span><span>desde <b class="b">' + k.primerTicket + '</b></span>' : '')
    + (k.ultimoTicket ? '<span class="sep">·</span><span>último <b class="b">' + k.ultimoTicket + '</b></span>' : '')
    + '</div>'
    + (badges ? '<div class="cs-org-badges">' + badges + '</div>' : '')
    + '</div>';

  /* === KPIs resumen operativo (k4) — con comparativa vs panel === */
  var subSla = vsPanelSub(k.pctSla,    bp.pctSla,    'pct');
  var subFrt = vsPanelSub(k.frtMed,    bp.frtMed,    'min-inv');
  var subAct = (function(){
    var pctAct = k.total ? (k.activos/k.total*100) : 0;
    var pctActPanel = bp.total ? (bp.activos/bp.total*100) : 0;
    return vsPanelSub(pctAct, pctActPanel, 'pct-inv');
  })();
  var pctSlaClr = k.pctSla==null?'#425563':k.pctSla>=85?'#17A24F':k.pctSla>=70?'#CE8B00':'#BB1A1A';
  var resumenOp = '<div class="cs-h2">Resumen operativo'
    + '<span class="cs-h2s">comparado con el promedio del panel filtrado</span></div>'
    + '<div class="cs-kgrid k4">'
    + kpiCard(num(k.total),    'Tickets del cliente', bp.total ? 'panel: ' + num(bp.total) : '', '#0047BB')
    + kpiCard(num(k.activos),  'Activos',             subAct.txt, k.activos>0?'#FF6A00':'#17A24F', subAct.cls)
    + kpiCard(k.pctSla!=null?Math.round(k.pctSla)+'%':'—', '% SLA cumplido', subSla.txt || (k.slaEvalN+' evaluados'), pctSlaClr, subSla.cls)
    + kpiCard(k.frtMed!=null?fmtMin(k.frtMed):'—', 'FRT mediana', subFrt.txt || '1ª respuesta', '#425563', subFrt.cls)
    + '</div>';

  /* === KPIs calidad y escalamientos (k4) === */
  var subRes = vsPanelSub(k.resMed, bp.resMed, 'min-inv');
  var subReo = vsPanelSub(k.pctReaper, bp.pctReaper, 'pct-inv');
  var subCsat = vsPanelSub(k.pctCsat, bp.pctCsat, 'pct');
  var subSn2 = vsPanelSub(k.pctSn2, bp.pctSn2, 'pct-inv');
  var csatClr = k.pctCsat==null?'#425563':k.pctCsat>=85?'#17A24F':k.pctCsat>=70?'#CE8B00':'#BB1A1A';

  var calidad = '<div class="cs-h2">Calidad de atención y escalamientos</div>'
    + '<div class="cs-kgrid k4">'
    + kpiCard(k.resMed!=null?fmtMin(k.resMed):'—', 'Resolución mediana', subRes.txt || 'creación → cierre', '#425563', subRes.cls)
    + kpiCard(k.pctReaper!=null?k.pctReaper.toFixed(1)+'%':'—', 'Tasa reapertura', subReo.txt || 'de los tickets', k.pctReaper>5?'#BB1A1A':'#17A24F', subReo.cls)
    + kpiCard(k.pctCsat!=null?Math.round(k.pctCsat)+'%':'—', 'CSAT', subCsat.txt || (k.csatN ? k.csatN+' respuestas' : 'sin respuestas'), csatClr, subCsat.cls)
    + kpiCard(k.pctSn2!=null?Math.round(k.pctSn2)+'%':'—', '% escalado a SN2', subSn2.txt || (k.sn2+' tickets'), k.sn2>0?'#CE8B00':'#17A24F', subSn2.cls)
    + '</div>';

  /* === Charts del cliente === */
  var charts = '<div class="cs-h2">Tendencias del cliente</div>'
    + '<div class="cs-cgrid one">' + chartCard('Ingresos vs. resueltos vs. bolsa al cierre del mes (12 meses)', 'cOrgFlujo', 320) + '</div>'
    + '<div class="cs-cgrid">'
    +   chartCard('Distribución por categoría', 'cOrgCat')
    +   chartCard('Distribución por producto', 'cOrgProd')
    + '</div>'
    + '<div class="cs-cgrid">'
    +   chartCard('Histograma de tiempos de resolución', 'cOrgHist')
    +   chartCard('% SLA cumplido por mes', 'cOrgSla')
    + '</div>';

  /* === Ejecutivos del cliente === */
  var ejecutivos = '<div class="cs-h2">Ejecutivos atendiendo a este cliente</div>'
    + buildEjecutivosCliente(universe);

  /* === Tickets activos paginados + sortable === */
  var activos = universe.filter(function(t){ return !!ACTIVE[t.status]; });
  var sortKey = (S.orgActSort && S.orgActSort.key) || 'default';
  var sortDir = (S.orgActSort && S.orgActSort.dir) || 1;
  var SORT_ACT = {
    id:      function(t){ return t.id; },
    triage:  function(t){ return Number(triage(t.subject))||0; },
    subject: function(t){ return (t.subject||'').toLowerCase(); },
    agent:   function(t){ return agentName(t.assignee_id).toLowerCase(); },
    status:  function(t){ return t.status||''; },
    prio:    function(t){ return ({urgent:4,high:3,normal:2,low:1})[t.priority]||0; },
    nivel:   function(t){ return t.nivel||''; },
    sla:     function(t){ return slaBreached(t)?2:slaOk(t)?1:0; },
    cat:     function(t){ return (t.categoria||'').toLowerCase(); },
    created: function(t){ return ms(t.created_at); },
    updated: function(t){ return ms(t.updated_at); }
  };
  if (sortKey === 'default'){
    activos.sort(function(a,b){
      var sa = slaBreached(a) ? 0 : 1;
      var sb = slaBreached(b) ? 0 : 1;
      return sa - sb || ms(a.created_at) - ms(b.created_at);
    });
  } else if (SORT_ACT[sortKey]){
    activos.sort(function(a,b){
      var va = SORT_ACT[sortKey](a), vb = SORT_ACT[sortKey](b);
      if (va < vb) return -sortDir;
      if (va > vb) return sortDir;
      return 0;
    });
  }
  var APAGE     = 10;
  var aTotalPgs = Math.max(1, Math.ceil(activos.length/APAGE));
  var aCurPg    = Math.min(S.orgActPage||0, aTotalPgs-1);
  var aSlice    = activos.slice(aCurPg*APAGE, aCurPg*APAGE+APAGE);

  function aTh(key, label, cls){
    var arr = sortKey === key ? '<span class="arr">'+(sortDir>0?'▴':'▾')+'</span>' : '';
    return '<th class="cs-clk-th'+(cls?' '+cls:'')+'" data-act="orgActSort" data-key="'+key+'">'+label+arr+'</th>';
  }
  var aThs = aTh('id','#','cs-rc')
    + aTh('triage','Triage')
    + aTh('subject','Asunto','l')
    + aTh('agent','Ejecutivo','l')
    + aTh('status','Estado')
    + aTh('prio','Prioridad')
    + aTh('nivel','Nivel')
    + aTh('sla','SLA')
    + aTh('cat','Categoría')
    + aTh('created','Apertura')
    + aTh('updated','Actualizado');
  var aRows = aSlice.map(function(t){
    var cat = t.categoria || '—';
    var subj = t.subject || '';
    var ag = agentName(t.assignee_id);
    return '<tr>'
      + '<td class="cs-rc"><a href="'+ZD+t.id+'" target="_blank" rel="noopener">#'+t.id+'</a></td>'
      + '<td class="ctr">'+(triage(subj)||'—')+'</td>'
      + '<td class="l"><span class="cs-subj" title="'+esc(subj)+'">'+esc(trunc(subj,20))+'</span></td>'
      + '<td class="l" title="'+esc(ag)+'">'+esc(truncWords(ag,2))+'</td>'
      + '<td class="ctr">'+esc(STATUS_LBL[t.status]||t.status)+'</td>'
      + '<td class="ctr">'+prioPill(t.priority)+'</td>'
      + '<td class="ctr">'+(t.nivel?esc(t.nivel.charAt(0).toUpperCase()+t.nivel.slice(1)):'—')+'</td>'
      + '<td class="ctr">'+slaPill(slaState(t))+'</td>'
      + '<td class="ctr"><span class="cs-subj" title="'+esc(cat)+'" style="display:inline-block;max-width:15ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle">'+esc(trunc(cat,15))+'</span></td>'
      + '<td class="ctr">'+(t.created_at||'').slice(0,10)+'</td>'
      + '<td class="ctr">'+relTime(t.updated_at)+'</td>'
      + '</tr>';
  }).join('');
  var tabActivos = '<div class="cs-h2">'
    + '<span>Tickets activos</span>'
    + '<span class="cs-h2s">'+activos.length+' tickets · '
    + (sortKey === 'default'
      ? 'SLA vencido primero, luego apertura'
      : 'orden por columna · click en encabezado para alternar') + '</span>'
    + (activos.length ? '<button class="cs-pbtn cs-h2-action" data-act="orgExportActivos">↓ Exportar a Excel</button>' : '')
    + '</div>'
    + '<div class="cs-card">'
    + (activos.length
      ? '<div class="cs-tscroll"><table class="cs-t"><thead><tr>'+aThs+'</tr></thead><tbody>'+aRows+'</tbody></table></div>'
        + pageNav(aCurPg, aTotalPgs, 'orgActPage', activos.length + ' activos · ' + APAGE + ' por página')
      : '<div class="cs-empty">Sin tickets activos — el queue está limpio para este cliente.</div>')
    + '</div>';

  /* === Casos críticos: top FRT + top SLA vencido ===
   * Ventana de análisis: últimos 60 días (calendario natural). Aplicar antes
   * de los Top 10 para que la foto refleje desempeño reciente, no histórico
   * acumulado del cliente desde su primer ticket. */
  var VENTANA_DIAS = 60;
  var ventanaMs = Date.now() - VENTANA_DIAS * 86400000;
  var universoVentana = universe.filter(function(t){ return ms(t.created_at) >= ventanaMs; });

  var conFrt = universoVentana.filter(function(t){ return t.frt_min!=null && t.frt_min>0; })
    .sort(function(a,b){ return b.frt_min - a.frt_min; }).slice(0, 10);
  var frtRows = conFrt.map(function(t,i){
    var ag = agentName(t.assignee_id);
    return '<tr><td class="cs-rc ctr">'+(i+1)+'</td>'
      +'<td><a href="'+ZD+t.id+'" target="_blank" rel="noopener">#'+t.id+'</a></td>'
      +'<td class="l"><span class="cs-subj" title="'+esc(t.subject)+'">'+esc(trunc(t.subject,20))+'</span></td>'
      +'<td class="n"><strong>'+fmtMin(t.frt_min)+'</strong></td>'
      +'<td title="'+esc(ag)+'">'+esc(truncWords(ag,2))+'</td>'
      +'<td>'+(t.created_at||'').slice(0,10)+'</td>'
      +'<td class="ctr">'+slaPill(slaState(t))+'</td>'
      +'<td class="ctr">'+esc(STATUS_LBL[t.status]||t.status||'—')+'</td></tr>';
  }).join('');
  var tabFrt = '<div class="cs-h2">Top 10 más lentos en 1ª respuesta'
    + '<span class="cs-h2s">últimos ' + VENTANA_DIAS + ' días · FRT más alto del cliente · click en # ticket abre Zendesk</span></div>'
    + '<div class="cs-card">'
    + (frtRows
      ? '<table class="cs-t"><thead><tr><th class="cs-rc">#</th><th>Ticket</th><th class="l">Asunto</th><th>FRT</th><th class="l">Ejecutivo</th><th>Apertura</th><th>SLA</th><th>Estado</th></tr></thead><tbody>'+frtRows+'</tbody></table>'
      : '<div class="cs-empty">Sin datos de FRT en este cliente.</div>')
    + '</div>';

  /* Top 10 SLA vencido — iteración v2 (2026-05-28, feedback usuario post-deploy):
   * - Filtro: últimos 60 días (universoVentana) + slaBreached(t).
   * - Ordenamiento: tiempo de vida DESC (de inicio a fin) — los tickets que
   *   MÁS nos demoraron en resolver, no los más antiguos por fecha de apertura.
   *   Antes con ASC por created_at, un ticket abierto y cerrado el mismo día
   *   aparecía arriba con "0 días" sin aportar al análisis de demora.
   * - Antigüedad: si <24h → "Xh"; si >=1 día → "X días" (formato legible
   *   para resoluciones rápidas que igual cayeron en breach).
   * - Columna "Tiempo de respuesta" (FRT): mide la primera respuesta real.
   *   Reemplazó a "% Cumplimiento SLA" v1 (eliminada porque la métrica por
   *   ticket no es derivable sin el SLA target histórico — Zendesk no lo
   *   expone post-cierre y el seed solo guarda el booleano sla_breached). */
  var fueSla = universoVentana.filter(function(t){ return slaBreached(t); })
    .map(function(t){
      var creado = ms(t.created_at);
      var salida = salidaMs(t);
      var vidaMs = salida ? (salida - creado) : (Date.now() - creado);
      return { t: t, vidaMs: vidaMs };
    })
    .sort(function(a, b){ return b.vidaMs - a.vidaMs; })  /* más demorados primero */
    .slice(0, 10);
  var slaRows = fueSla.map(function(x, i){
    var t = x.t;
    var ag = agentName(t.assignee_id);
    var creado = ms(t.created_at);
    var salida = salidaMs(t);          /* 0 si sigue activo */
    var esActivo = !salida;
    /* Antigüedad: tiempo de vida real (no calendario hasta hoy) */
    var ageMs = x.vidaMs;
    /* Formato legible Antigüedad: <24h → "Xh", sino "X días" */
    var ageTxt;
    if (ageMs < 86400000) {
      var horas = ageMs / 3600000;
      ageTxt = (horas < 2 ? horas.toFixed(1) : Math.round(horas)) + 'h';
    } else {
      ageTxt = Math.floor(ageMs / 86400000) + ' días';
    }
    /* Cierre: fecha real si cerrado, "En Curso" si activo */
    var cierreTxt = esActivo
      ? '<span class="cs-pill" style="background:#e6f4ff;color:#0047BB;border-color:#0047BB">En Curso</span>'
      : new Date(salida).toISOString().slice(0,10);
    /* Tiempo de respuesta (FRT) — más útil para análisis de demora que un % no derivable */
    var frtTxt = (t.frt_min != null && t.frt_min >= 0) ? fmtMin(t.frt_min) : '—';
    return '<tr><td class="cs-rc ctr">'+(i+1)+'</td>'
      +'<td><a href="'+ZD+t.id+'" target="_blank" rel="noopener">#'+t.id+'</a></td>'
      +'<td class="l"><span class="cs-subj" title="'+esc(t.subject)+'">'+esc(trunc(t.subject,20))+'</span></td>'
      +'<td>'+(t.created_at||'').slice(0,10)+'</td>'
      +'<td class="ctr">'+cierreTxt+'</td>'
      +'<td class="ctr">'+ageTxt+'</td>'
      +'<td class="ctr n">'+frtTxt+'</td>'
      +'<td title="'+esc(ag)+'">'+esc(truncWords(ag,2))+'</td>'
      +'<td class="ctr">'+esc(STATUS_LBL[t.status]||t.status||'—')+'</td></tr>';
  }).join('');
  var tabSla = '<div class="cs-h2">Top 10 fuera de SLA · los que más nos demoraron'
    + '<span class="cs-h2s">últimos ' + VENTANA_DIAS + ' días · tickets que vencieron SLA · ordenados por tiempo de vida (de inicio a cierre) DESC</span></div>'
    + '<div class="cs-card">'
    + (slaRows
      ? '<table class="cs-t"><thead><tr>'
        + '<th class="cs-rc">#</th>'
        + '<th>Ticket</th>'
        + '<th class="l">Asunto</th>'
        + '<th>Inicio</th>'
        + '<th>Cierre</th>'
        + '<th title="Tiempo de vida real del ticket (inicio a cierre)">Antigüedad</th>'
        + '<th title="First Reply Time — tiempo real hasta primera respuesta">Tiempo de respuesta</th>'
        + '<th class="l">Ejecutivo</th>'
        + '<th>Estado</th>'
        + '</tr></thead><tbody>'+slaRows+'</tbody></table>'
      : '<div class="cs-empty">Sin tickets fuera de SLA — desempeño limpio.</div>')
    + '</div>';

  var criticos = tabFrt + tabSla;

  /* === Histórico paginado colapsado === */
  var histItems = universe.filter(function(t){ return !ACTIVE[t.status]; })
    .sort(function(a,b){ return ms(b.created_at)-ms(a.created_at); });
  var HPAGE     = 25;
  var hTotalPgs = Math.max(1, Math.ceil(histItems.length/HPAGE));
  var hCurPage  = Math.min(S.orgPage||0, hTotalPgs-1);
  var hSlice    = histItems.slice(hCurPage*HPAGE, hCurPage*HPAGE+HPAGE);
  var hCols = ['id','triage','subject','agent','status','cat','prod','sla','created'];
  var hThs  = hCols.map(function(c){ return '<th'+(COL_TXT[c]?' class="l"':'')+'>'+COL_DEFS[c].label+'</th>'; }).join('');
  var hRows = hSlice.map(function(t){
    return '<tr>'+hCols.map(function(c){ return '<td'+(COL_TXT[c]?' class="l"':'')+'>'+COL_DEFS[c].render(t)+'</td>'; }).join('')+'</tr>';
  }).join('');
  var histLabel = S.orgHistVisible
    ? 'Ocultar histórico'
    : 'Ver histórico completo ('+num(histItems.length)+' tickets)';
  var tabHist = '<div class="cs-h2">Histórico</div>'
    + '<div class="cs-card"><div class="cs-ch-t-row" style="padding:14px 16px">'
    +   '<span class="cs-ch-t" style="margin:0;padding:0">Tickets cerrados o resueltos</span>'
    +   '<button class="cs-pbtn" data-act="orgHist">'+histLabel+'</button>'
    + '</div>'
    + (S.orgHistVisible && histItems.length
      ? '<div class="cs-tscroll"><table class="cs-t"><thead><tr>'+hThs+'</tr></thead><tbody>'+hRows+'</tbody></table></div>'
        + pageNav(hCurPage, hTotalPgs, 'orgPage', histItems.length + ' tickets · ' + HPAGE + ' por página')
      : '')
    + (S.orgHistVisible && !histItems.length
      ? '<div class="cs-empty">Sin tickets históricos para este cliente.</div>' : '')
    + '</div>';

  return cabecera + resumenOp + calidad + charts + ejecutivos + tabActivos + criticos + tabHist + buildOrgExportador(universe);
}

/* ============================================================
   PANEL "Análisis/Exportador Tickets por Rango" — HU 5 (2026-05-28)
   Permite filtrar tickets del cliente por rango desde/hasta + 2 acciones:
   - "Ver datos filtrados" → modal con tabla (filtra localmente del IndexedDB)
   - "Exportar"            → invoca webhook /webhook/cs-export que genera JSONL
                              estructurado para análisis con IA (Gemini/Claude)
   Límite: max 3 meses por export (workflow rechaza rangos mayores).
   ============================================================ */
function buildOrgExportador(universe){
  /* Default: últimos 30 días si no hay rango persistido */
  if (!S.orgExp.from || !S.orgExp.to) {
    var hoy = new Date();
    var hace30 = new Date(hoy.getTime() - 30*86400000);
    S.orgExp.from = S.orgExp.from || hace30.toISOString().slice(0,10);
    S.orgExp.to   = S.orgExp.to   || hoy.toISOString().slice(0,10);
  }
  /* Conteo preview de tickets en rango (cliente, sin red) */
  var enRango = expFiltrarPorRango(universe, S.orgExp.from, S.orgExp.to);
  /* Validar rango máximo 3 meses (workflow rechaza más) */
  var diasRango = Math.floor((Date.parse(S.orgExp.to + 'T23:59:59') - Date.parse(S.orgExp.from + 'T00:00:00')) / 86400000);
  var rangoExcedido = diasRango > 93;  /* 93 días ≈ 3 meses */
  var btnDisabled = rangoExcedido || enRango.length === 0;
  return '<div class="cs-h2">Análisis / Exportador tickets por rango'
    + '<span class="cs-h2s">filtra y exporta tickets del cliente como JSONL para análisis con IA</span></div>'
    + '<div class="cs-card cs-exp">'
    +   '<div class="cs-exp-row">'
    +     '<div class="cs-exp-rango">'
    +       '<label>Desde <input type="date" id="csOrgExpFrom" value="'+esc(S.orgExp.from)+'" max="'+esc(new Date().toISOString().slice(0,10))+'"></label>'
    +       '<label>Hasta <input type="date" id="csOrgExpTo"   value="'+esc(S.orgExp.to)+'"   max="'+esc(new Date().toISOString().slice(0,10))+'"></label>'
    +       '<span class="cs-exp-info">'
    +         num(enRango.length)+' tickets · '+diasRango+' días'
    +         (rangoExcedido ? ' <span style="color:#BB1A1A;font-weight:600">· rango excede 3 meses</span>' : '')
    +       '</span>'
    +     '</div>'
    +     '<div class="cs-exp-acts">'
    +       '<button class="cs-pbtn" data-act="orgExpVer" '+(enRango.length===0?'disabled':'')+'>Ver datos filtrados</button>'
    +       '<button class="cs-pbtn pri" data-act="orgExpDown" '+(btnDisabled?'disabled':'')+'>Exportar (JSONL)</button>'
    +     '</div>'
    +   '</div>'
    +   '<div class="cs-exp-foot">El export incluye metadata + métricas SLA/FRT/CSAT/escalamientos + comments del ticket (fresh desde Zendesk). Tarda ~10-60s según volumen.</div>'
    + '</div>';
}

/* Filtra tickets del cliente por rango created_at (formato YYYY-MM-DD inclusivo) */
function expFiltrarPorRango(universe, from, to){
  if (!from || !to) return [];
  var msFrom = Date.parse(from + 'T00:00:00');
  var msTo   = Date.parse(to   + 'T23:59:59');
  if (isNaN(msFrom) || isNaN(msTo) || msFrom > msTo) return [];
  return universe.filter(function(t){
    var c = ms(t.created_at);
    return c >= msFrom && c <= msTo;
  }).sort(function(a,b){ return ms(b.created_at) - ms(a.created_at); });
}

/* Renderea modal con tabla de tickets filtrados (datos del cliente, sin red).
 * Paginado a 20 tickets por página + scroll horizontal (HU 5 feedback v2). */
function expVerDatosModal(orgId){
  var universe = orgUniverse(orgId);
  var rows = expFiltrarPorRango(universe, S.orgExp.from, S.orgExp.to);
  S.orgExpModalPage = 0;  /* reset al abrir */
  closeModal();
  var ov = document.createElement('div');
  ov.id = 'csv-modal';
  ov.className = 'cs-modal-ov';
  ov.innerHTML = '<div class="cs-modal"><div class="cs-modal-h">'
    + '<div class="cs-modal-t" id="csOrgExpModalT"></div>'
    + '<button class="cs-modal-x" data-act="close">×</button></div>'
    + '<div class="cs-modal-b" id="csOrgExpModalB"></div></div>';
  (document.getElementById('app') || document.body).appendChild(ov);
  ov.addEventListener('click', function(e){
    var act = e.target && e.target.dataset && e.target.dataset.act;
    if (act === 'close') { closeModal(); return; }
    if (act === 'orgExpModalPage') {
      S.orgExpModalPage = parseInt(e.target.dataset.page, 10) || 0;
      _renderExpModalBody(orgId, rows);
      return;
    }
  });
  _renderExpModalBody(orgId, rows);
}

/* Re-renderea cuerpo del modal Exportador (paginación interna sin recargar header) */
function _renderExpModalBody(orgId, rows){
  var MPAGE = 20;
  var total = rows.length;
  var totalPgs = Math.max(1, Math.ceil(total / MPAGE));
  var curPg = Math.min(Math.max(0, S.orgExpModalPage||0), totalPgs - 1);
  var slice = rows.slice(curPg * MPAGE, curPg * MPAGE + MPAGE);

  var title = (OR[orgId]||('Org '+orgId)) + ' — Tickets ' + S.orgExp.from + ' a ' + S.orgExp.to
    + ' (' + total + ' total · página ' + (curPg+1) + ' de ' + totalPgs + ')';
  var titleEl = document.getElementById('csOrgExpModalT');
  if (titleEl) titleEl.textContent = title;

  var body;
  if (total === 0) {
    body = '<div class="cs-empty">Sin tickets en este rango.</div>';
  } else {
    var tableRows = slice.map(function(t){
      var sal = salidaMs(t);
      var cierre = sal ? new Date(sal).toISOString().slice(0,10) : '—';
      return '<tr>'
        +'<td><a href="'+ZD+t.id+'" target="_blank" rel="noopener">#'+t.id+'</a></td>'
        +'<td class="l"><span class="cs-subj" title="'+esc(t.subject)+'">'+esc(trunc(t.subject,40))+'</span></td>'
        +'<td class="ctr">'+esc(STATUS_LBL[t.status]||t.status||'—')+'</td>'
        +'<td>'+(t.created_at||'').slice(0,10)+'</td>'
        +'<td>'+cierre+'</td>'
        +'<td class="n">'+(t.frt_min!=null?fmtMin(t.frt_min):'—')+'</td>'
        +'<td class="ctr">'+slaPill(slaState(t))+'</td>'
        +'<td title="'+esc(agentName(t.assignee_id))+'">'+esc(truncWords(agentName(t.assignee_id),2))+'</td>'
        +'<td class="l">'+esc(t.categoria||'—')+'</td>'
        +'<td class="l">'+esc(t.producto||'—')+'</td>'
        +'<td class="l">'+esc(t.linea_negocio||'—')+'</td>'
        +'<td class="ctr">'+esc(t.priority||'—')+'</td>'
      +'</tr>';
    }).join('');
    body = '<div class="cs-exp-modal-scroll"><table class="cs-t"><thead><tr>'
      + '<th>Ticket</th><th class="l">Asunto</th><th>Estado</th><th>Apertura</th><th>Cierre</th>'
      + '<th>FRT</th><th>SLA</th><th class="l">Ejecutivo</th><th class="l">Categoría</th>'
      + '<th class="l">Producto</th><th class="l">Línea negocio</th><th>Prioridad</th>'
      + '</tr></thead><tbody>' + tableRows + '</tbody></table></div>';
    /* Controles de paginación */
    if (totalPgs > 1) {
      body += '<div class="cs-exp-modal-pages">';
      body += '<button class="cs-pbtn" data-act="orgExpModalPage" data-page="'+(curPg-1)+'"'
        + (curPg<=0?' disabled':'')+'>‹ Anterior</button>';
      body += '<span class="cs-exp-modal-meta">'
        + (curPg*MPAGE+1) + '–' + Math.min((curPg+1)*MPAGE, total) + ' de ' + total
        + '</span>';
      body += '<button class="cs-pbtn" data-act="orgExpModalPage" data-page="'+(curPg+1)+'"'
        + (curPg>=totalPgs-1?' disabled':'')+'>Siguiente ›</button>';
      body += '</div>';
    }
  }
  var bodyEl = document.getElementById('csOrgExpModalB');
  if (bodyEl) bodyEl.innerHTML = body;
}

/* Sistema de toast (helper reutilizable). Type: info | success | error.
 * duration en ms (0 = persistente hasta click manual o nuevo toast).
 * El toast vive en document.body (fuera de .cs-app) — el theme se copia del
 * .cs-app al data-theme del propio toast para que el CSS lo respete. */
function showToast(type, msg, duration){
  /* Limpiar toast previo */
  var prev = document.getElementById('csv-toast');
  if (prev) prev.remove();
  var div = document.createElement('div');
  div.id = 'csv-toast';
  div.className = 'cs-toast cs-toast-' + (type || 'info');
  /* Copiar theme del panel para no quedar transparente en dark */
  var app = document.querySelector('.cs-app');
  div.dataset.theme = (app && app.dataset.theme === 'dark') ? 'dark' : 'light';
  div.innerHTML = '<div class="cs-toast-msg">' + msg + '</div>'
    + '<button class="cs-toast-x" aria-label="Cerrar">×</button>';
  document.body.appendChild(div);
  /* close on click of X */
  div.querySelector('.cs-toast-x').addEventListener('click', function(){ div.remove(); });
  /* auto-dismiss */
  if (duration !== 0) {
    var d = duration || (type === 'error' ? 8000 : 4000);
    setTimeout(function(){ if (document.getElementById('csv-toast') === div) div.remove(); }, d);
  }
  return div;
}

/* Invoca el webhook de export y maneja la descarga del JSONL */
function expExportar(orgId){
  var from = S.orgExp.from, to = S.orgExp.to;
  var orgName = OR[orgId] || ('org-'+orgId);
  var diasRango = Math.floor((Date.parse(to + 'T23:59:59') - Date.parse(from + 'T00:00:00')) / 86400000);
  if (diasRango > 93) {
    showToast('error', 'El rango supera 3 meses. Por favor reduce el rango antes de exportar.', 6000);
    return;
  }
  var toast = showToast('info',
    '<strong>Preparando exportación…</strong><br>'
    + 'Cliente: '+esc(orgName)+'<br>'
    + 'Rango: '+from+' → '+to+'<br>'
    + 'Trayendo metadata + comments desde Zendesk. Puede tardar ~10-60s según volumen.',
    0
  );
  var url = WH_BASE + '/cs-export?org=' + encodeURIComponent(orgId)
    + '&from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to)
    + '&t=' + Date.now();
  /* AbortController con timeout 4 minutos.
   * Medición real con SODEXO (concurrencia 5 + retry en backend):
   *   - 7 días / 107 tickets: 58s
   *   - estimado 14 días / 250 tickets: ~120s
   *   - estimado 21 días / 380 tickets: ~180s
   *   - 240s permite cubrir hasta ~28-30 días de un cliente grande
   * Más allá: el webhook n8n corta a ~240s y devuelve 502. */
  var abortCtrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var abortTimer = abortCtrl ? setTimeout(function(){
    try { abortCtrl.abort(); } catch (_){}
  }, 240000) : null;  /* 4 min — alineado con timeout del webhook n8n */
  fetch(url, { method:'GET', cache:'no-store', signal: abortCtrl ? abortCtrl.signal : undefined })
    .then(function(r){
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + r.statusText);
      return r.blob().then(function(blob){ return { blob:blob, headers:r.headers }; });
    })
    .then(function(res){
      if (abortTimer) clearTimeout(abortTimer);
      /* Triggerar descarga del JSONL */
      var fname = 'cs-export-' + slugify(orgName) + '-' + from + '_' + to + '.jsonl';
      var a = document.createElement('a');
      a.href = URL.createObjectURL(res.blob);
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
      if (toast) toast.remove();
      showToast('success',
        '<strong>Export completado</strong><br>'
        + 'Archivo: '+esc(fname)+'<br>'
        + 'Listo para subir a Gemini o Claude para análisis.',
        6000
      );
    })
    .catch(function(err){
      if (abortTimer) clearTimeout(abortTimer);
      if (toast) toast.remove();
      var msg = String(err && err.message || err);
      /* Mensajes específicos según el tipo de error */
      if (err && err.name === 'AbortError') {
        msg = 'El export se demoró más del tiempo previsto. Intenta con un rango más corto.';
      } else if (msg === 'Failed to fetch' || /NetworkError/i.test(msg)) {
        msg = 'No se pudo conectar al servicio de export. Puede ser inestabilidad temporal del backend.';
      }
      showToast('error',
        '<strong>Error en exportación</strong><br>'
        + esc(msg) + '<br>'
        + 'Si persiste, levanta el caso con <strong>Automatizaciones CS</strong>.',
        0
      );
    });
}

/* Slug para nombres de archivo: minúsculas, sin tildes, alfanum + guiones */
function slugify(s){
  return String(s||'').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'cliente';
}

/* Charts del tab Clientes — 6 visualizaciones */
function drawOrgCharts(){
  if (!S.org) return;
  var universe = orgUniverse(S.org);
  if (!universe.length) return;

  /* === 1. Combo flujo mensual: ingresos · resueltos · bolsa al cierre del mes (últimos 6 meses) === */
  var now = new Date();
  var mBuckets = [];
  for (var i = 5; i >= 0; i--){
    var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    var nd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    mBuckets.push({
      d0: d.getTime(),
      d1: nd.getTime(),
      label: MES[d.getMonth()] + ' ' + String(d.getFullYear()).slice(2)
    });
  }
  flujoBuckets(universe, mBuckets);
  comboFlujoChart('cOrgFlujo', mBuckets, true, 'Tickets / mes');

  /* === 2. Distribución por categoría (Pareto bar horizontal) === */
  var catC = {};
  universe.forEach(function(t){ var c = t.categoria || '(sin categoría)'; catC[c] = (catC[c]||0)+1; });
  var catTot = Object.keys(catC).reduce(function(a,k){ return a+catC[k]; }, 0) || 1;
  var catArr = Object.keys(catC).map(function(c){ return { name:c, n:catC[c] }; })
    .sort(function(a,b){ return b.n-a.n; });
  var catLbl=[], catVal=[], catOtras=0, catOtrasN=0;
  catArr.forEach(function(r){
    if (r.n / catTot >= 0.02) { catLbl.push(r.name); catVal.push(r.n); }
    else { catOtras += r.n; catOtrasN++; }
  });
  if (catOtrasN){ catLbl.push('Otras ('+catOtrasN+')'); catVal.push(catOtras); }
  mkChart('cOrgCat', {
    type:'bar',
    data:{ labels:catLbl, datasets:[{ label:'Tickets', data:catVal, backgroundColor:'#FF6A00' }] },
    options:{ indexAxis:'y', plugins:{ legend:{ display:false } }, scales:axisOpts(false) }
  });

  /* === 3. Distribución por producto (Pareto bar horizontal) === */
  var prodC = {};
  universe.forEach(function(t){ var c = t.producto || '(sin producto)'; prodC[c] = (prodC[c]||0)+1; });
  var prodTot = Object.keys(prodC).reduce(function(a,k){ return a+prodC[k]; }, 0) || 1;
  var prodArr = Object.keys(prodC).map(function(c){ return { name:c, n:prodC[c] }; })
    .sort(function(a,b){ return b.n-a.n; });
  var prodLbl=[], prodVal=[], prodOtras=0, prodOtrasN=0;
  prodArr.forEach(function(r){
    if (r.n / prodTot >= 0.02) { prodLbl.push(r.name); prodVal.push(r.n); }
    else { prodOtras += r.n; prodOtrasN++; }
  });
  if (prodOtrasN){ prodLbl.push('Otros ('+prodOtrasN+')'); prodVal.push(prodOtras); }
  mkChart('cOrgProd', {
    type:'bar',
    data:{ labels:prodLbl, datasets:[{ label:'Tickets', data:prodVal, backgroundColor:'#0047BB' }] },
    options:{ indexAxis:'y', plugins:{ legend:{ display:false } }, scales:axisOpts(false) }
  });

  /* === 4. Histograma de tiempos de resolución === */
  var hist = resolutionBuckets(universe);
  mkChart('cOrgHist', {
    type:'bar',
    data:{ labels:hist.labels, datasets:[{ label:'Tickets resueltos', data:hist.data, backgroundColor:'#17A24F' }] },
    options:{ plugins:{ legend:{ display:false } }, scales:axisOpts(false) }
  });

  /* === 5. % SLA cumplido por mes (línea) === */
  var slaM = {};
  universe.forEach(function(t){
    if (!slaEvaluated(t) || !t.created_at) return;
    var k = t.created_at.slice(0, 7);
    if (!slaM[k]) slaM[k] = { ev:0, ok:0 };
    slaM[k].ev++;
    if (slaOk(t)) slaM[k].ok++;
  });
  var slaKeys = Object.keys(slaM).sort().slice(-12);
  var slaData = slaKeys.map(function(k){ return slaM[k].ev ? Math.round(slaM[k].ok/slaM[k].ev*100) : null; });
  mkChart('cOrgSla', {
    type:'line',
    data:{ labels: slaKeys.map(function(k){ var p=k.split('-'); return MES[+p[1]-1]+' '+p[0].slice(2); }),
      datasets:[{ label:'% SLA', data:slaData, borderColor:'#17A24F',
        backgroundColor:'rgba(23,162,79,.14)', fill:true, tension:.35, pointRadius:3, spanGaps:true }] },
    options:{ plugins:{ legend:baseLegend() },
      scales:{ x: axisOpts(false).x,
        y: { min:0, max:100, ticks:{ color:AXIS, font:{size:11}, callback:function(v){ return v+'%'; } }, grid:{ color:GRID } } } }
  });

  /* Top 20 keywords + recurrencia bigramas: removidos en iteración 2 (UX) */
}

/* ============================================================
   MODAL DRILL-DOWN (ejecutivo / cliente) — columnas reordenables
   ============================================================ */
var MODAL = { mode:'agent', id:null, fTxt:'', fStatus:'', fSla:'', sortKey:'created_at', sortDir:1 };

var COL_DEFS = {
  id:      { label:'#',           render:function(t){ return '<a href="'+ZD+t.id+'" target="_blank" rel="noopener">#'+t.id+'</a>'; }, sort:function(t){ return t.id; } },
  triage:  { label:'Triage',      render:function(t){ return triage(t.subject) || '—'; }, sort:function(t){ return Number(triage(t.subject))||0; } },
  subject: { label:'Asunto',      render:function(t){ return '<span class="cs-subj" title="'+esc(t.subject)+'">'+esc(t.subject)+'</span>'; }, sort:function(t){ return (t.subject||'').toLowerCase(); } },
  org:     { label:'Cliente',     render:function(t){ return esc(orgName(t.organization_id)); }, sort:function(t){ return orgName(t.organization_id).toLowerCase(); } },
  agent:   { label:'Ejecutivo',   render:function(t){ return esc(agentName(t.assignee_id)); }, sort:function(t){ return agentName(t.assignee_id).toLowerCase(); } },
  status:  { label:'Estado',      render:function(t){ return STATUS_LBL[t.status]||t.status; }, sort:function(t){ return t.status||''; } },
  prio:    { label:'Prioridad',   render:function(t){ return prioPill(t.priority); }, sort:function(t){ return ({urgent:4,high:3,normal:2,low:1})[t.priority]||0; } },
  sla:     { label:'SLA',         render:function(t){ return slaPill(slaState(t)); }, sort:function(t){ return slaBreached(t)?2:slaOk(t)?1:0; } },
  created: { label:'Apertura',    render:function(t){ return (t.created_at||'').slice(0,10); }, sort:function(t){ return ms(t.created_at); } },
  updated: { label:'Actualizado', render:function(t){ return relTime(t.updated_at); }, sort:function(t){ return ms(t.updated_at); } },
  nivel:   { label:'Nivel',       render:function(t){ return t.nivel ? (t.nivel.charAt(0).toUpperCase()+t.nivel.slice(1)) : '—'; }, sort:function(t){ return t.nivel||''; } },
  segui:   { label:'Seguimiento', render:function(t){ return t.seguimiento ? '<span class="cs-pill in">Sí</span>' : 'No'; }, sort:function(t){ return t.seguimiento?1:0; } },
  merged:  { label:'Merged',      render:function(t){ return t.merged ? '<span class="cs-pill alert">Sí</span>' : 'No'; }, sort:function(t){ return t.merged?1:0; } },
  cat:     { label:'Categoría',     render:function(t){ return esc(t.categoria || '—'); }, sort:function(t){ return (t.categoria||'').toLowerCase(); } },
  prod:    { label:'Producto',      render:function(t){ return esc(t.producto || '—'); }, sort:function(t){ return (t.producto||'').toLowerCase(); } },
  ln:      { label:'Línea negocio', render:function(t){ return esc(t.linea_negocio || '—'); }, sort:function(t){ return (t.linea_negocio||'').toLowerCase(); } }
};
var COL_DEFAULT = ['id','triage','subject','org','agent','status','prio','nivel','cat','prod','ln','sla','segui','merged','created','updated'];
var COL_TXT = { subject:1, org:1, agent:1 };  /* columnas de texto largo → alineadas a la izquierda */
function colOrder(){
  var saved = S.modalCols;
  if (!Array.isArray(saved) || !saved.length) return COL_DEFAULT.slice();
  var clean = saved.filter(function (c) { return COL_DEFS[c]; });
  COL_DEFAULT.forEach(function (c) { if (clean.indexOf(c) < 0) clean.push(c); });
  return clean;
}
function visibleCols(){
  /* oculta la columna que es constante según el modo */
  return colOrder().filter(function (c) {
    if (MODAL.mode === 'agent' && c === 'agent') return false;
    if (MODAL.mode === 'org'   && c === 'org')   return false;
    return true;
  });
}

function modalTickets(){
  var list = applyFilters(T).filter(function (t) {
    if (!ACTIVE[t.status]) return false;
    return MODAL.mode === 'agent'
      ? String(t.assignee_id || 0) === String(MODAL.id)
      : String(t.organization_id || 0) === String(MODAL.id);
  });
  return list.filter(function (t) {
    if (MODAL.fStatus && t.status !== MODAL.fStatus) return false;
    if (MODAL.fSla === 'br' && !slaBreached(t)) return false;
    if (MODAL.fSla === 'ok' && !slaOk(t)) return false;
    if (MODAL.fTxt) {
      var hay = MODAL.mode === 'agent' ? orgName(t.organization_id) : agentName(t.assignee_id);
      if (hay.toLowerCase().indexOf(MODAL.fTxt.toLowerCase()) < 0) return false;
    }
    return true;
  });
}
function renderModalBody(){
  var box = document.getElementById('csv-modal-body');
  if (!box) return;
  var list = modalTickets();
  var cols = visibleCols();
  var sd = COL_DEFS[MODAL.sortKey] && COL_DEFS[MODAL.sortKey].sort;
  if (sd) list.sort(function (a, b) {
    var va = sd(a), vb = sd(b);
    return (va < vb ? -1 : va > vb ? 1 : 0) * MODAL.sortDir;
  });
  var rows = '';
  if (!list.length) rows = '<tr><td colspan="' + cols.length + '" class="cs-empty">Sin tickets que coincidan</td></tr>';
  else list.forEach(function (t) {
    rows += '<tr>' + cols.map(function (c) { return '<td' + (COL_TXT[c] ? ' class="l"' : '') + '>' + COL_DEFS[c].render(t) + '</td>'; }).join('') + '</tr>';
  });
  var arrow = function (key) { return MODAL.sortKey === key ? (MODAL.sortDir > 0 ? ' ▲' : ' ▼') : ''; };
  var ths = cols.map(function (c) {
    var sortable = COL_DEFS[c].sort ? ' data-sort="' + c + '"' : '';
    return '<th draggable="true" data-col="' + c + '"' + sortable + '>' + COL_DEFS[c].label + arrow(c) + '</th>';
  }).join('');
  var txtPh = MODAL.mode === 'agent' ? 'Filtrar cliente…' : 'Filtrar ejecutivo…';

  box.innerHTML =
    '<div class="cs-mfilt">'
    + '<input class="cs-sel" data-m="txt" placeholder="' + txtPh + '" value="' + esc(MODAL.fTxt) + '">'
    + '<select class="cs-sel" data-m="status"><option value="">Todos los estados</option>'
    + ['new','open','pending','hold'].map(function (s) {
        return '<option value="' + s + '"' + (MODAL.fStatus===s?' selected':'') + '>' + STATUS_LBL[s] + '</option>';
      }).join('')
    + '</select>'
    + '<select class="cs-sel" data-m="sla"><option value="">SLA: todos</option>'
    + '<option value="br"' + (MODAL.fSla==='br'?' selected':'') + '>Solo vencidos</option>'
    + '<option value="ok"' + (MODAL.fSla==='ok'?' selected':'') + '>Solo OK</option>'
    + '</select>'
    + '<span class="cs-mcount">' + list.length + ' tickets · arrastra las columnas para reordenar</span>'
    + '</div>'
    + '<div class="cs-mscroll"><table class="cs-t cs-mtable"><thead><tr>' + ths + '</tr></thead>'
    + '<tbody>' + rows + '</tbody></table></div>';

  box.querySelectorAll('[data-m]').forEach(function (el) {
    var ev = el.tagName === 'INPUT' ? 'input' : 'change';
    el.addEventListener(ev, function () {
      if (el.dataset.m === 'txt') MODAL.fTxt = el.value;
      if (el.dataset.m === 'status') MODAL.fStatus = el.value;
      if (el.dataset.m === 'sla') MODAL.fSla = el.value;
      renderModalBody();
    });
  });
  box.querySelectorAll('[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      var key = th.dataset.sort;
      if (MODAL.sortKey === key) MODAL.sortDir *= -1;
      else { MODAL.sortKey = key; MODAL.sortDir = 1; }
      renderModalBody();
    });
  });
  /* drag&drop de columnas */
  var dragCol = null;
  box.querySelectorAll('th[data-col]').forEach(function (th) {
    th.addEventListener('dragstart', function () { dragCol = th.dataset.col; });
    th.addEventListener('dragover', function (e) { e.preventDefault(); });
    th.addEventListener('drop', function (e) {
      e.preventDefault();
      var target = th.dataset.col;
      if (!dragCol || dragCol === target) return;
      var order = colOrder();
      order.splice(order.indexOf(dragCol), 1);
      order.splice(order.indexOf(target), 0, dragCol);
      S.modalCols = order; saveState();
      renderModalBody();
    });
  });
}
function closeModal(){
  var ov = document.getElementById('csv-modal');
  if (ov) ov.parentNode.removeChild(ov);
}
function openModal(mode, id){
  closeModal();
  MODAL.mode = mode; MODAL.id = id;
  MODAL.fTxt = ''; MODAL.fStatus = ''; MODAL.fSla = '';
  MODAL.sortKey = 'created_at'; MODAL.sortDir = 1;
  var titulo = mode === 'agent' ? agentName(id) : orgName(id);
  var ov = document.createElement('div');
  ov.id = 'csv-modal';
  ov.className = 'cs-modal-ov';
  ov.innerHTML = '<div class="cs-modal"><div class="cs-modal-h">'
    + '<div class="cs-modal-t">' + esc(titulo) + '</div>'
    + '<button class="cs-modal-x" data-act="close">×</button></div>'
    + '<div class="cs-modal-b" id="csv-modal-body"></div></div>';
  (document.getElementById('app') || document.body).appendChild(ov);
  ov.addEventListener('click', function (e) {
    if (e.target.dataset && e.target.dataset.act === 'close') closeModal();
  });
  renderModalBody();
}

/* ============================================================
   EXPORT PDF
   ============================================================ */
function exportPDF(){
  destroyCharts();
  drawCharts();
  setTimeout(function () { window.print(); }, 200);
}
/* el cascarón (index.html) dispara el export desde el botón del header */
if (typeof window !== 'undefined') window.__csExportPDF = exportPDF;

/* ============================================================
   TAB DTE HEALTH — empresas con certificado activo
   ============================================================ */
var WH_BASE = 'https://prod-low-code.iconstruye.dev/webhook';
var _dteCache = (typeof window !== 'undefined' && window.__dteCache) ||
                { rows:null, refreshedAt:null, fetchedAt:0, loading:false, error:null };
if (typeof window !== 'undefined') window.__dteCache = _dteCache;

function loadDteData(force){
  if (_dteCache.loading) return;
  /* Cache de 30s en cliente para no spammear el webhook si el usuario navega entre tabs */
  if (!force && _dteCache.rows && (Date.now() - _dteCache.fetchedAt) < 30000) return;
  _dteCache.loading = true;
  _dteCache.error = null;
  fetch(WH_BASE + '/cs-dte?t=' + Date.now(), { cache:'no-store' })
    .then(function(r){ if(!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(j){
      _dteCache.rows = j.rows || [];
      _dteCache.refreshedAt = j.refreshed_at || null;
      _dteCache.cacheStatus = j.cache_status || 'ready';
      _dteCache.fetchedAt = Date.now();
      _dteCache.error = null;
    })
    .catch(function(e){ _dteCache.error = e.message; })
    .then(function(){
      _dteCache.loading = false;
      if (S.tab === 'extras' && S.extraView === 'dte') repaint();
    });
}

function dteFilterAndSort(rows){
  var f = S.dteFilter || {};
  var fid    = (f.id || '').toLowerCase().trim();
  var frut   = (f.rut || '').toLowerCase().trim();
  var frs    = (f.razon_social || '').toLowerCase().trim();
  var fest   = (f.estado || '').toLowerCase().trim();
  var out = rows.filter(function(r){
    if (fid    && String(r.id || '').toLowerCase().indexOf(fid) < 0) return false;
    if (frut   && String(r.rut || '').toLowerCase().indexOf(frut) < 0) return false;
    if (frs    && String(r.razon_social || '').toLowerCase().indexOf(frs) < 0) return false;
    if (fest   && (r.estado || '').toLowerCase() !== fest) return false;
    return true;
  });
  var k = S.dteSort.key || 'estado';
  var dir = S.dteSort.dir === 1 ? 1 : -1;
  out.sort(function(a, b){
    var va = a[k], vb = b[k];
    /* numérico para id y rut */
    if (k === 'id' || k === 'rut'){
      va = Number(va) || 0; vb = Number(vb) || 0;
      return (va - vb) * dir;
    }
    va = String(va || '').toLowerCase();
    vb = String(vb || '').toLowerCase();
    if (va < vb) return -1 * dir;
    if (va > vb) return  1 * dir;
    return 0;
  });
  return out;
}

function dteHeaderTh(key, label){
  var on = S.dteSort.key === key;
  var arrow = on ? (S.dteSort.dir === 1 ? ' ▴' : ' ▾') : '';
  return '<th class="cs-clk-th" data-dte-sort="' + key + '">' + esc(label) + esc(arrow) + '</th>';
}

/* ============================================================
   FASE C — Paneles Extras (catálogo de herramientas puntuales)
   ============================================================
   Tab principal que reemplaza el viejo "DTE Health". Muestra una grilla de
   tarjetas con paneles disponibles; cada uno se abre con S.extraView=<id>.
   Para agregar un panel nuevo: agregar entry en EXTRAS_CATALOG + función
   build<NombrePanel>() + caso en el dispatch interno. */

var EXTRAS_CATALOG = [
  {
    id: 'dte',
    title: 'DTE Health',
    desc: 'Empresas con certificado DTE activo y estado de emisión.',
    icon: '📄'
  }
  // Próximos paneles puntuales/temporales se agregan aquí
];

function buildExtras(){
  /* Si hay panel activo, mostrar header con back + el panel */
  if (S.extraView) {
    var meta = EXTRAS_CATALOG.find(function(p){ return p.id === S.extraView; });
    var title = meta ? meta.title : 'Panel';
    var header = '<div class="cs-extras-hdr">'
      + '<button class="cs-pbtn ghost" data-extras-back="1">← Paneles Extras</button>'
      + '<span class="cs-extras-title">' + esc(title) + '</span>'
      + '</div>';
    var body = '';
    if (S.extraView === 'dte') body = buildDte();
    else body = '<div class="cs-card" style="padding:24px">Panel no encontrado.</div>';
    return header + body;
  }
  /* Catálogo: grilla de tarjetas */
  var cards = EXTRAS_CATALOG.map(function(p){
    return '<div class="cs-extra-card" data-extras-open="' + esc(p.id) + '">'
      + '<div class="cs-extra-icon">' + esc(p.icon || '⚡') + '</div>'
      + '<div class="cs-extra-title">' + esc(p.title) + '</div>'
      + '<div class="cs-extra-desc">' + esc(p.desc || '') + '</div>'
      + '</div>';
  }).join('');
  return '<div class="cs-h2">Paneles Extras</div>'
    + '<div style="color:var(--mut);font-size:13px;margin-bottom:14px">'
    + 'Herramientas puntuales y soluciones temporales por casuísticas específicas. '
    + 'Cada panel se abre en esta misma vista; vuelves con el botón ← arriba.'
    + '</div>'
    + '<div class="cs-extras-grid">' + cards + '</div>';
}

function buildDte(){
  var h = '';
  /* Header del tab — KPIs + acciones */
  if (_dteCache.rows === null && !_dteCache.loading && !_dteCache.error){
    loadDteData(false);
  }

  if (_dteCache.loading && _dteCache.rows === null){
    return '<div class="cs-pad"><p style="text-align:center;color:#425563;padding:48px 0">Cargando estado DTE…</p></div>';
  }
  if (_dteCache.error && _dteCache.rows === null){
    return '<div class="cs-pad"><div class="cs-banner err" style="margin:24px 0;padding:16px;background:#fee;border-left:4px solid #BB1A1A;border-radius:4px">'
      + '<strong>Error al cargar DTE Health:</strong> ' + esc(_dteCache.error)
      + '<br><button class="cs-pbtn" data-dte-act="refresh" style="margin-top:8px">Reintentar</button>'
      + '</div></div>';
  }

  var rows = _dteCache.rows || [];
  var total = rows.length;
  var nOk    = rows.filter(function(r){ return r.estado === 'OK';    }).length;
  var nError = rows.filter(function(r){ return r.estado === 'Error'; }).length;
  var refreshedTxt = _dteCache.refreshedAt
    ? ('Actualizado ' + new Date(_dteCache.refreshedAt).toLocaleString('es-CL', { timeZone:'America/Santiago', hour:'2-digit', minute:'2-digit', day:'2-digit', month:'2-digit' }))
    : 'sin datos';

  h += '<div class="cs-pad">';
  h += '<div class="cs-kgrid k4">'
    + kpiCard(num(total),  'Empresas con certificado activo', refreshedTxt, '#0047BB')
    + kpiCard(num(nError), 'Sin consulta SII en 24h (Error)', nError > 0 ? 'Requieren revisión' : 'Todo OK', '#BB1A1A', nError > 0 ? 'down' : 'up')
    + kpiCard(num(nOk),    'Con consulta SII en 24h (OK)',    'Integración saludable', '#17A24F')
    + kpiCard(total > 0 ? Math.round(nOk/total*100) + '%' : '—', '% saludables del panel', total + ' empresas evaluadas', '#17A24F')
    + '</div>';

  /* Filtros + acciones */
  var filtered = dteFilterAndSort(rows);
  var PAGE_SIZE = 20;
  var totalPgs = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (S.dtePage >= totalPgs) S.dtePage = 0;
  var pageRows = filtered.slice(S.dtePage * PAGE_SIZE, (S.dtePage + 1) * PAGE_SIZE);

  h += '<div class="cs-h2" style="display:flex;align-items:center;justify-content:space-between;margin-top:24px">'
    + '<div><strong>Detalle por empresa</strong><span class="cs-h2-sub" style="margin-left:8px;color:#425563">'
    + filtered.length + ' empresas' + (filtered.length !== total ? ' (filtradas de ' + total + ')' : '')
    + '</span></div>'
    + '<div class="cs-h2-action">'
    +   '<button class="cs-pbtn" data-dte-act="refresh" title="Refrescar desde el servidor">↻ Actualizar</button> '
    +   '<button class="cs-pbtn" data-dte-act="export" title="Exportar a Excel">↓ Exportar XLSX</button>'
    + '</div>'
    + '</div>';

  /* Tabla */
  h += '<table class="cs-t cs-dte-tbl"><thead>'
    + '<tr>'
    +   dteHeaderTh('id',           'Id')
    +   dteHeaderTh('rut',          'Rut')
    +   dteHeaderTh('razon_social', 'Razón Social')
    +   dteHeaderTh('estado',       'Estado')
    + '</tr>'
    /* Filter row */
    + '<tr class="cs-dte-filter">'
    +   '<th><input type="text" class="cs-dte-fi" data-dte-filter="id"           value="' + esc(S.dteFilter.id || '')           + '" placeholder="filtrar…"></th>'
    +   '<th><input type="text" class="cs-dte-fi" data-dte-filter="rut"          value="' + esc(S.dteFilter.rut || '')          + '" placeholder="filtrar…"></th>'
    +   '<th><input type="text" class="cs-dte-fi" data-dte-filter="razon_social" value="' + esc(S.dteFilter.razon_social || '') + '" placeholder="filtrar…"></th>'
    +   '<th><select class="cs-dte-fi" data-dte-filter="estado">'
    +     '<option value="">Todos</option>'
    +     '<option value="OK"'    + (S.dteFilter.estado === 'OK'    ? ' selected' : '') + '>OK</option>'
    +     '<option value="Error"' + (S.dteFilter.estado === 'Error' ? ' selected' : '') + '>Error</option>'
    +   '</select></th>'
    + '</tr>'
    + '</thead><tbody>';

  if (pageRows.length === 0){
    h += '<tr><td colspan="4" style="text-align:center;padding:24px;color:#425563">Sin resultados</td></tr>';
  } else {
    pageRows.forEach(function(r){
      var estCls = r.estado === 'OK' ? 'ok' : 'err';
      h += '<tr>'
        + '<td>'+ esc(r.id) + '</td>'
        + '<td>'+ esc(r.rut) + '</td>'
        + '<td>'+ esc(r.razon_social || '') + '</td>'
        + '<td><span class="cs-pill ' + estCls + '">' + esc(r.estado) + '</span></td>'
        + '</tr>';
    });
  }
  h += '</tbody></table>';

  /* Paginación */
  if (totalPgs > 1){
    h += pageNav(S.dtePage, totalPgs, 'dte', filtered.length + ' empresas · ' + PAGE_SIZE + ' por página');
  }

  h += '</div>';
  return h;
}

function bindDte(){
  /* Refresh + Export */
  BODY.querySelectorAll('[data-dte-act]').forEach(function(b){
    b.addEventListener('click', function(){
      var act = b.dataset.dteAct;
      if (act === 'refresh'){
        loadDteData(true);
        repaint();
      } else if (act === 'export'){
        var rows = dteFilterAndSort(_dteCache.rows || []);
        var stamp = new Date().toISOString().slice(0, 10);
        var data = rows.map(function(r){ return [r.id, r.rut, r.razon_social || '', r.estado]; });
        exportTicketsXlsx('dte-health-' + stamp + '.xlsx', 'DTE Health',
          ['Id', 'Rut', 'Razón Social', 'Estado'], data, null);
      }
    });
  });
  /* Sort headers */
  BODY.querySelectorAll('[data-dte-sort]').forEach(function(th){
    th.addEventListener('click', function(){
      var k = th.dataset.dteSort;
      if (S.dteSort.key === k){
        S.dteSort.dir = -S.dteSort.dir;
      } else {
        S.dteSort.key = k;
        S.dteSort.dir = (k === 'estado') ? -1 : 1;
      }
      S.dtePage = 0;
      saveState(); repaint();
    });
  });
  /* Filter inputs */
  BODY.querySelectorAll('[data-dte-filter]').forEach(function(el){
    var evt = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(evt, function(){
      S.dteFilter = S.dteFilter || {};
      S.dteFilter[el.dataset.dteFilter] = el.value;
      S.dtePage = 0;
      saveState();
      repaint();
      /* Re-focus en el input que estaba editando */
      var sel = BODY.querySelector('[data-dte-filter="' + el.dataset.dteFilter + '"]');
      if (sel && sel.tagName === 'INPUT'){
        sel.focus();
        sel.setSelectionRange(sel.value.length, sel.value.length);
      }
    });
  });
  /* Paginación (pageNav genera data-act="dte" + data-page) */
  BODY.querySelectorAll('[data-act="dte"]').forEach(function(b){
    b.addEventListener('click', function(e){
      e.stopPropagation();
      var p = parseInt(b.dataset.page, 10);
      if (!isNaN(p)) { S.dtePage = p; saveState(); repaint(); }
    });
  });
}

/* ============================================================
   FASE B — RESUMEN MULTICANAL (cuando S.channel === 'all')
   Franja compacta que se inyecta al inicio de cualquier tab operacional.
   Muestra volumen total cruzado de los 3 canales para dar contexto antes
   de los cálculos del tab (que siguen siendo Zendesk-only). */
function buildMulticanalSummary(){
  /* Volumen por canal con filtros Equipo + Tipo aplicados.
   * Tickets: applyFilters(T_ALL) respeta S.gids y S.type.
   * Calls Aircall: cuando hay filtro de equipo activo, solo se cuentan las
   * calls que tienen ticket Zendesk con aircall_call_id en el equipo filtrado.
   * Limitación: ~60% de calls no tienen cross-link al ticket — se excluyen
   * del conteo cuando hay filtro de equipo. Se aclara con nota. */
  var allCalls = window.__CS_CALLS || [];
  var hasTeamFilter = Array.isArray(S.gids) || !!S.type;

  var filteredTickets = applyFilters(T_ALL);
  var byCanal = { 'Correo':0, 'Chat':0, 'Whatsapp':0, 'Otros':0, 'Teléfono':0 };
  for (var i = 0; i < filteredTickets.length; i++) {
    var k = filteredTickets[i].canal_normalizado || 'Otros';
    if (byCanal[k] != null) byCanal[k]++; else byCanal['Otros']++;
  }

  /* Calls: filtrar por equipo si aplica */
  var calls = allCalls.length;
  var callsExcluded = 0;
  if (hasTeamFilter && allCalls.length) {
    /* mapa aircall_call_id → ticket.group_id (solo tickets que pasan el filtro) */
    var callIdInScope = {};
    for (var ft = 0; ft < filteredTickets.length; ft++) {
      var aid = filteredTickets[ft].aircall_call_id;
      if (aid) callIdInScope[aid] = 1;
    }
    var filteredCalls = 0;
    for (var ci = 0; ci < allCalls.length; ci++) {
      if (callIdInScope[allCalls[ci].id]) filteredCalls++;
      else callsExcluded++;
    }
    calls = filteredCalls;
  }

  var totalSources = byCanal['Correo'] + byCanal['Chat'] + byCanal['Whatsapp'] + calls;
  var pct = function(v){ return totalSources ? Math.round(v*100/totalSources) : 0; };

  /* Título FUERA + KPIs con kpiCard (regla Alvaro 2026-05-26) */
  var subTitulo = 'Total contactos: ' + totalSources.toLocaleString('es-CL');
  if (hasTeamFilter) subTitulo += ' · filtrado por equipo/tipo';
  var html = '<div class="cs-h2">Resumen multicanal '
    + '<span style="font-weight:500;color:var(--mut);font-size:12px;margin-left:8px">'
    + esc(subTitulo)
    + '</span></div>'
    + '<div class="cs-kgrid k4">'
    + kpiCard(byCanal['Correo'].toLocaleString('es-CL'),   'Correo',     pct(byCanal['Correo']) + '% del total',   '#1e40af')
    + kpiCard(calls.toLocaleString('es-CL'),               'Llamadas',   pct(calls) + '% del total',               '#16a34a')
    + kpiCard(byCanal['Chat'].toLocaleString('es-CL'),     'Chat',       pct(byCanal['Chat']) + '% del total',     '#a16207')
    + kpiCard(byCanal['Whatsapp'].toLocaleString('es-CL'), 'Whatsapp',   pct(byCanal['Whatsapp']) + '% del total', '#7c3aed')
    + '</div>';

  var notas = [];
  if (byCanal['Teléfono']) {
    notas.push('Hay ' + byCanal['Teléfono'].toLocaleString('es-CL')
      + ' tickets Zendesk creados por llamadas Aircall (excluidos del total para no doble-contar).');
  }
  if (hasTeamFilter && callsExcluded) {
    notas.push('Aircall: ' + callsExcluded.toLocaleString('es-CL') + ' calls sin cross-link a un ticket del equipo filtrado fueron excluidas del conteo. '
      + 'El cross-link Aircall↔Zendesk cubre ~40% de las calls.');
  }
  if (notas.length) {
    html += '<div style="font-size:11.5px;color:var(--mut);font-style:italic;margin:-4px 0 14px">'
      + notas.map(function(n){ return 'Nota: ' + esc(n); }).join('<br>')
      + '</div>';
  }
  return html;
}

/* ============================================================
   FASE B — VISTA AIRCALL (cuando S.channel === 'ac')
   Vista única que muestra KPIs telefonía, IVRs, agentes, razones missed.
   Se renderiza en lugar de buildLive/buildWeek/etc cuando el filtro es Aircall.
   ============================================================ */
/* Aviso para el tab Clientes en canal Aircall: las llamadas NO traen cliente/organización
   (sin organizationId, sin cross-link zendeskTicketId, sin contactName) → el análisis por
   cliente que sí existe en Zendesk no se puede replicar. */
function buildAircallUnavailable(){
  return '<div class="cs-card" style="padding:44px 32px;text-align:center;color:var(--mut)">'
    + '<div style="font-size:34px;margin-bottom:10px">📞</div>'
    + '<div style="font-size:16px;font-weight:600;color:var(--text);margin-bottom:8px">'
    + 'Panel no disponible para canal Teléfono (Aircall)</div>'
    + '<div style="font-size:13px;max-width:540px;margin:0 auto;line-height:1.55">'
    + 'El análisis por cliente requiere asociar cada llamada a una organización, dato que hoy '
    + 'no viene en el stream de Aircall (sin vínculo con el cliente ni cross-link a Zendesk). '
    + 'Para métricas de telefonía usa <b>En vivo</b>, <b>Análisis semanal</b> o <b>Análisis</b>; '
    + 'para el análisis por cliente cambia el canal a <b>Zendesk</b>.'
    + '</div></div>';
}
/* ============================================================
   VISTA TELÉFONO (Aircall) v3 — 4 TABS enriquecidos (rediseño 2026-05-29, feedback VP)
   Tabs: live (hoy vs ayer/sem.ant) · week (semana vs anterior, navegable) ·
         ana (rango computeAnaWindow + granularidad) · org ("Por Mesa/Línea")
   Criterios validados vs BD: recibidas/contestadas/perdidas, ASA(frt_sec),
   abandono ajustado(duration<=10), talk(ended-answered), rellamadas(raw_digits),
   off-hours(L-V 8:30-20/Sáb 8:30-13:30). Fechas SIEMPRE por componentes (DST-safe).
   ============================================================ */
var AC_ANS  = '#17A24F';
var AC_LOST = (THEME === 'dark') ? '#F2555A' : '#BB1A1A';
var AC_RECV = '#0047BB';
var AC_OUT  = '#425563';
var AC_WAIT = '#FF6A00';
var AC_SEGB = (THEME === 'dark') ? '#15252E' : '#FFFFFF';
var AC_ABAND_UMBRAL = 10;

function acAlpha(hex, a){
  var h = hex.replace('#','');
  if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  return 'rgba(' + parseInt(h.substr(0,2),16) + ',' + parseInt(h.substr(2,2),16) + ',' + parseInt(h.substr(4,2),16) + ',' + a + ')';
}
function acPad(n){ return (n<10?'0':'') + n; }
function acDayKey(d){ return d.getFullYear() + '-' + acPad(d.getMonth()+1) + '-' + acPad(d.getDate()); }
function acPct(n, d){ return d > 0 ? Math.round(n*100/d) : null; }
function acPctTxt(n, d){ var p = acPct(n,d); return p == null ? '—' : p + '%'; }
function acFmtSec(s){
  if (s == null || isNaN(s)) return '—';
  s = Math.round(s);
  if (s < 60) return s + 's';
  var m = Math.floor(s/60);
  return m + 'm ' + acPad(s - m*60) + 's';
}
function acAbColor(pct){
  if (pct == null) return 'var(--mut)';
  if (pct < 5) return 'var(--ok)';
  if (pct <= 10) return 'var(--alert)';
  return 'var(--err)';
}
function acPctil(arr, p){
  if (!arr || !arr.length) return null;
  var a = arr.slice().sort(function(x,y){ return x-y; });
  return a[Math.min(a.length-1, Math.floor(p/100 * a.length))];
}
function acSrc(){ return (window.__CS_CALLS && window.__CS_CALLS.length) ? window.__CS_CALLS : (CALLS_ALL || []); }

/* ---- fechas DST-safe (componentes de calendario, nunca aritmética de ms para días/semanas) ---- */
function acMidnight(d){ return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0,0,0,0); }
function acAddDays(d, n){ return new Date(d.getFullYear(), d.getMonth(), d.getDate()+n, 0,0,0,0); }
function acUnix(d){ return Math.floor(d.getTime()/1000); }
function acMonday(d){ var dow=(d.getDay()+6)%7; return new Date(d.getFullYear(), d.getMonth(), d.getDate()-dow, 0,0,0,0); }

/* Horario laboral CS: L-V 8:30-20:00, Sáb 8:30-13:30, Dom cerrado. */
function acEsLaboral(d){
  var dow = d.getDay(), mins = d.getHours()*60 + d.getMinutes();
  if (dow === 0) return false;
  if (dow === 6) return mins >= 510 && mins < 810;
  return mins >= 510 && mins < 1200;
}

/* Filtro por ejecutivo (cruce con el dropdown weekAgent del tab Semanal, por NOMBRE).
   agentName() (del render) mapea el id de assignee a nombre; se compara con user_name. */
function acFiltroEjec(calls){
  if (S.tab !== 'week' || !S.weekAgent) return calls;   /* el selector ejecutivo solo vive en el tab Semanal */
  var nm = (typeof agentName === 'function') ? agentName(S.weekAgent) : null;
  if (!nm) return calls;
  return calls.filter(function(c){ return c.user_name === nm; });
}

/* Estadísticas base (inbound). talk = ended_at - answered_at. */
function acStats(calls){
  var rec=0, ans=0, lost=0, lostCorto=0, asaArr=[], talkArr=[], lostDurArr=[];
  for (var i=0; i<calls.length; i++){
    var c = calls[i];
    if (c.direction !== 'inbound') continue;
    rec++;
    if (c.answered_at){
      ans++;
      if (typeof c.frt_sec === 'number' && c.frt_sec >= 0) asaArr.push(c.frt_sec);
      if (typeof c.ended_at === 'number' && typeof c.answered_at === 'number'){
        var t = c.ended_at - c.answered_at;
        if (t >= 0 && t < 14400) talkArr.push(t);
      }
    } else {
      lost++;
      if (typeof c.duration === 'number' && c.duration >= 0){
        lostDurArr.push(c.duration);
        if (c.duration <= AC_ABAND_UMBRAL) lostCorto++;
      }
    }
  }
  function avg(a){ return a.length ? a.reduce(function(x,y){return x+y;},0)/a.length : null; }
  return {
    rec:rec, ans:ans, lost:lost, lostCorto:lostCorto,
    contestPct: acPct(ans, rec), abandPct: acPct(lost, rec),
    abandAjustPct: acPct(lost - lostCorto, rec - lostCorto),
    asa: avg(asaArr), asaN: asaArr.length,
    talk: avg(talkArr), talkN: talkArr.length,
    talkMed: acPctil(talkArr, 50),
    asaArr: asaArr, lostDurArr: lostDurArr
  };
}

/* Estadísticas extra: outbound, %ticket, libre/ocupado, duración mediana, IVRs, agentes, razones, mesa×razón. */
function acStatsExtra(calls){
  var out=0, withTicket=0, libre=0, ocupado=0, durArr=[];
  var byIVR={}, byAgent={}, byReason={}, byMesaReason={};
  var ticketByCall={};
  if (typeof T_ALL !== 'undefined') for (var ti=0;ti<T_ALL.length;ti++){ var aid=T_ALL[ti].aircall_call_id; if(aid) ticketByCall[aid]=1; }
  for (var i=0;i<calls.length;i++){ var c=calls[i];
    if (c.direction==='outbound'){ out++; continue; }
    if (c.direction!=='inbound') continue;
    if (ticketByCall[c.id]) withTicket++;
    if (c.missed_reason==='agents_did_not_answer') libre++;
    if (c.missed_reason==='no_available_agent') ocupado++;
    if (c.answered_at && typeof c.ended_at==='number' && typeof c.answered_at==='number'){ var t=c.ended_at-c.answered_at; if(t>=0&&t<14400) durArr.push(t); }
    if (c.number_name && !acMesaExcluir(c.number_name)) byIVR[c.number_name]=(byIVR[c.number_name]||0)+1;
    if (c.user_name){ var a=byAgent[c.user_name]=byAgent[c.user_name]||{calls:0,ans:0,dur:0}; a.calls++; if(c.answered_at){a.ans++; if(typeof c.ended_at==='number'){var tt=c.ended_at-c.answered_at; if(tt>=0&&tt<14400)a.dur+=tt;}} }
    if (c.missed_reason){ byReason[c.missed_reason]=(byReason[c.missed_reason]||0)+1;
      var mesa=(typeof getMesa==='function'?getMesa(c.number_name):c.number_name)||'Sin mesa';
      var mr=byMesaReason[mesa]=byMesaReason[mesa]||{__t:0}; mr[c.missed_reason]=(mr[c.missed_reason]||0)+1; mr.__t++;
    }
  }
  durArr.sort(function(a,b){return a-b;});
  return { outbound:out, withTicket:withTicket, libre:libre, ocupado:ocupado,
    durMed: durArr.length?durArr[Math.floor(durArr.length/2)]:null, durN:durArr.length,
    byIVR:byIVR, byAgent:byAgent, byReason:byReason, byMesaReason:byMesaReason };
}

/* calls en [fromUnix, toUnix) por started_at + filtro ejecutivo. */
function acInRange(fromUnix, toUnix){
  var src = acFiltroEjec(acSrc()), out = [];
  for (var i=0; i<src.length; i++){
    var t = src[i].started_at;
    if (typeof t === 'number' && t >= fromUnix && t < toUnix) out.push(src[i]);
  }
  return out;
}
function acDayBounds(d){ var from = acUnix(acMidnight(d)); return { from: from, to: from + 86400 }; }

/* Análisis de rellamadas por raw_digits (excluye troncales >P99). */
function acCallbackAnalysis(calls, ventanaSeg){
  var byNum = {};
  for (var i=0; i<calls.length; i++){
    var c = calls[i];
    if (c.direction !== 'inbound' || !c.raw_digits || typeof c.started_at !== 'number') continue;
    (byNum[c.raw_digits] = byNum[c.raw_digits] || []).push(c);
  }
  var nums = Object.keys(byNum);
  var counts = nums.map(function(k){ return byNum[k].length; });
  var p99 = acPctil(counts, 99) || 9999;
  var conRellamada=0, base=0, sinReintento=0, recuperadas=0;
  for (var n=0; n<nums.length; n++){
    var arr = byNum[nums[n]];
    if (arr.length > p99) continue;
    base++;
    arr.sort(function(a,b){ return a.started_at - b.started_at; });
    if (arr.length > 1) conRellamada++;
    var recuperada=false, sinRe=false;
    for (var k=0; k<arr.length; k++){
      if (!arr[k].answered_at){
        var hayPosterior=false, hayContest=false;
        for (var m=k+1; m<arr.length; m++){
          if (arr[m].started_at - arr[k].started_at <= ventanaSeg){ hayPosterior=true; if(arr[m].answered_at) hayContest=true; }
        }
        if (hayContest) recuperada=true;
        if (!hayPosterior) sinRe=true;
      }
    }
    if (recuperada) recuperadas++;
    if (sinRe && !recuperada) sinReintento++;
  }
  return { base:base, p99:p99, rellamadaPct:acPct(conRellamada, base),
    perdidasSinReintento:sinReintento, perdidasRecuperadas:recuperadas };
}

/* curación de number_name para "Por Mesa/Línea": excluye PII de agentes, crudos, "Libre". */
var AC_AGENTES_PII = {
  'Jessica Vélez':1,'Natalia Ruiz':1,'Gloria Rebolledo':1,'Alberto Mercado':1,
  'Javiera Castro':1,'Joel Campos':1,'Monica Salas':1,'Fernanda Lillo':1
};
function acMesaExcluir(numberName){
  if (!numberName) return true;
  if (AC_AGENTES_PII[numberName]) return true;
  if (/^\d+$/.test(numberName)) return true;
  if (/^Libre\s*\d*$/i.test(numberName)) return true;
  return false;
}

var AC_REASON_LABELS = {
  'no_available_agent':'Sin agente disponible', 'agents_did_not_answer':'Agentes no atendieron',
  'short_abandoned':'Abandono corto', 'abandoned_in_ivr':'Abandono en IVR',
  'abandoned_in_classic':'Abandono en cola', 'out_of_opening_hours':'Fuera de horario'
};
var AC_REASON_COLS = ['no_available_agent','agents_did_not_answer','short_abandoned','abandoned_in_ivr','abandoned_in_classic','out_of_opening_hours'];

/* ---- helpers de tabla (columnas centradas) ---- */
function acThC(txt){ return '<th style="text-align:center">' + esc(txt) + '</th>'; }
function acTdC(html){ return '<td style="text-align:center">' + html + '</td>'; }
function acTdAb(pct){ return '<td style="text-align:center;color:' + acAbColor(pct) + ';font-weight:600">' + (pct==null?'—':pct+'%') + '</td>'; }
var AC_BADGE = '<span class="cs-badge cs-badge-ac">AIRCALL</span>';

function acDelta(cur, prev, atip){
  if (atip) return 'día atípico';
  if (prev == null || prev === 0) return '—';
  var diff = cur - prev;
  if (diff === 0) return '→ igual';
  return (diff>0?'▲':'▼') + ' ' + Math.round(Math.abs(diff)*100/prev) + '%';
}
function acKpi(value, label, sub, color){
  return '<div class="cs-kpi"><div class="bar" style="background:' + color + '"></div>'
    + '<div class="v">' + value + '</div><div class="l">' + esc(label) + '</div>'
    + '<div class="s">' + (sub||'') + '</div></div>';
}
function acKpiAb(st, label, sub){
  var col = acAbColor(st.abandPct);
  return '<div class="cs-kpi" style="border-color:' + col + '"><div class="bar" style="background:' + col + '"></div>'
    + '<div class="v" style="color:' + col + '">' + acPctTxt(st.lost, st.rec) + '</div><div class="l">' + esc(label) + '</div>'
    + '<div class="s">' + (sub||'') + '</div></div>';
}

/* fila de cards "extra" pedidas por VP: salientes, %atend, %perd, libre, ocupado, duración, %ticket */
function acCardsExtra(st, ex, incluyeBasicos){
  var h = '<div class="cs-kgrid k4" style="margin-top:6px">';
  h += acKpi(ex.outbound.toLocaleString('es-CL'), 'Llamadas emitidas (salientes)', 'outbound del período', AC_OUT);
  if (incluyeBasicos){
    h += acKpi(acPctTxt(st.ans, st.rec), '% Atendidas', st.ans + ' de ' + st.rec, AC_ANS);
    h += '<div class="cs-kpi" style="border-color:' + acAbColor(st.abandPct) + '"><div class="bar" style="background:' + acAbColor(st.abandPct) + '"></div><div class="v" style="color:' + acAbColor(st.abandPct) + '">' + acPctTxt(st.lost, st.rec) + '</div><div class="l">% Perdidas</div><div class="s">' + st.lost + ' de ' + st.rec + '</div></div>';
  }
  h += acKpi(acFmtSec(st.talkMed), 'Duración mediana', st.talkN + ' contestadas (conversación)', '#6B4FBB');
  h += '</div>';
  h += '<div class="cs-kgrid k4" style="margin-top:10px">';
  h += acKpi(acPctTxt(ex.libre, st.rec), 'No atendidas · agente libre', ex.libre.toLocaleString('es-CL') + ' llam. · solo histórico*', AC_LOST);
  h += acKpi(acPctTxt(ex.ocupado, st.rec), 'No atendidas · sin agente', ex.ocupado.toLocaleString('es-CL') + ' llam. · solo histórico*', AC_LOST);
  h += acKpi(acPctTxt(ex.withTicket, st.rec), 'Con ticket Zendesk', ex.withTicket.toLocaleString('es-CL') + ' cruzadas', '#6B4FBB');
  h += acKpi(acFmtSec(st.asa), 'Espera prom. (ASA)', 'p90 ' + acFmtSec(acPctil(st.asaArr,90)) + ' · ' + st.asaN + ' con dato', AC_WAIT);
  h += '</div>';
  h += '<div style="font-size:10.5px;color:var(--mut);margin-top:4px">* El motivo de pérdida (agente libre/sin agente) solo viene poblado en datos históricos; la ingesta en vivo de Aircall no lo registra.</div>';
  return h;
}

/* Top IVRs + Top agentes (2 columnas) */
function acBloqueTops(ex){
  function topN(map, n, ex2){ return Object.keys(map).map(function(k){return [k,map[k]];}).sort(function(a,b){return (ex2?ex2(b[1]):b[1])-(ex2?ex2(a[1]):a[1]);}).slice(0,n); }
  var ivr = topN(ex.byIVR, 10), ag = topN(ex.byAgent, 10, function(v){return v.calls;});
  var h = '<div class="cs-cgrid" style="grid-template-columns:1fr 1fr;gap:16px">';
  h += '<div><div class="cs-h2">Top IVRs / mesas ' + AC_BADGE + '</div><div class="cs-card"><table class="cs-t"><thead><tr><th>IVR / mesa</th>' + acThC('Recibidas') + '</tr></thead><tbody>';
  ivr.forEach(function(r){ h += '<tr><td>' + esc(r[0]) + '</td>' + acTdC(r[1].toLocaleString('es-CL')) + '</tr>'; });
  h += '</tbody></table></div></div>';
  h += '<div><div class="cs-h2">Top agentes ' + AC_BADGE + '</div><div class="cs-card"><table class="cs-t"><thead><tr><th>Agente</th>' + acThC('Calls') + acThC('Atend.') + acThC('Dur prom') + '</tr></thead><tbody>';
  ag.forEach(function(r){ var v=r[1], avg=v.ans>0?Math.round(v.dur/v.ans):null; h += '<tr><td>' + esc(r[0]) + '</td>' + acTdC(v.calls.toLocaleString('es-CL')) + acTdC(v.ans.toLocaleString('es-CL')) + acTdC(acFmtSec(avg)) + '</tr>'; });
  h += '</tbody></table></div></div></div>';
  return h;
}

/* Razones de pérdida + Pérdidas por mesa y razón */
function acBloqueRazones(ex, st){
  var totReason = AC_REASON_COLS.reduce(function(a,k){ return a + (ex.byReason[k]||0); }, 0);
  var sinMotivo = st.lost - totReason;
  var h = '<div class="cs-h2">Razones de llamadas perdidas ' + AC_BADGE + '<span class="cs-h2s">motivo solo en histórico · perdidas sin motivo agrupadas aparte</span></div>'
    + '<div class="cs-card"><table class="cs-t"><thead><tr><th>Razón</th>' + acThC('Perdidas') + acThC('% del total') + '</tr></thead><tbody>';
  AC_REASON_COLS.forEach(function(k){ var v=ex.byReason[k]||0; if(v) h += '<tr><td>' + esc(AC_REASON_LABELS[k]) + '</td>' + acTdC(v.toLocaleString('es-CL')) + acTdC(acPctTxt(v, st.lost)) + '</tr>'; });
  h += '<tr><td style="color:var(--mut)">Sin motivo registrado</td>' + acTdC(sinMotivo.toLocaleString('es-CL')) + acTdC(acPctTxt(sinMotivo, st.lost)) + '</tr>';
  h += '</tbody></table></div>';
  /* mesa × razón */
  var mesas = Object.keys(ex.byMesaReason).map(function(k){return [k,ex.byMesaReason[k]];}).filter(function(e){return e[1].__t>0;}).sort(function(a,b){return b[1].__t-a[1].__t;});
  if (mesas.length){
    h += '<div class="cs-h2">Pérdidas por mesa y razón ' + AC_BADGE + '<span class="cs-h2s">solo histórico</span></div>'
      + '<div class="cs-card"><table class="cs-t"><thead><tr><th>Mesa</th>' + acThC('Total') + AC_REASON_COLS.map(function(k){return acThC(AC_REASON_LABELS[k]);}).join('') + '</tr></thead><tbody>';
    mesas.forEach(function(e){ var mn=e[0], mr=e[1]; h += '<tr><td>' + esc(mn) + '</td>' + acTdC('<b>'+mr.__t+'</b>') + AC_REASON_COLS.map(function(k){return acTdC(mr[k]?mr[k].toLocaleString('es-CL'):'–');}).join('') + '</tr>'; });
    h += '</tbody></table></div>';
  }
  return h;
}

/* tabla comparativa de KPIs entre períodos (col INDICADOR centrado por pedido VP) */
function acTablaComparativa(titulo, periodos){
  var html = '<div class="cs-h2">' + esc(titulo) + ' ' + AC_BADGE + '</div>'
    + '<div class="cs-card"><table class="cs-t"><thead><tr>' + acThC('Indicador') + periodos.map(function(p){ return acThC(p.nombre); }).join('') + '</tr></thead><tbody>';
  function row(lbl, fn){ return '<tr>' + acTdC(lbl) + periodos.map(function(p){ return acTdC(fn(p)); }).join('') + '</tr>'; }
  html += row('Recibidas', function(p){ return p.st.rec.toLocaleString('es-CL'); });
  html += row('Contestadas', function(p){ return p.st.ans.toLocaleString('es-CL'); });
  html += row('Perdidas', function(p){ return p.st.lost.toLocaleString('es-CL'); });
  html += '<tr>' + acTdC('% Abandono') + periodos.map(function(p){ return acTdAb(p.st.abandPct); }).join('') + '</tr>';
  html += row('% Abandono ajustado', function(p){ return acPctTxt(p.st.lost-p.st.lostCorto, p.st.rec-p.st.lostCorto); });
  html += row('% Contestación', function(p){ return acPctTxt(p.st.ans, p.st.rec); });
  html += row('Espera prom. (ASA)', function(p){ return acFmtSec(p.st.asa); });
  html += row('Duración mediana', function(p){ return acFmtSec(p.st.talkMed); });
  if (periodos[0].ex) html += row('Salientes (outbound)', function(p){ return p.ex ? p.ex.outbound.toLocaleString('es-CL') : '—'; });
  if (periodos[0].cb) html += row('Perdidas sin reintento', function(p){ return p.cb ? p.cb.perdidasSinReintento.toLocaleString('es-CL') : '—'; });
  html += '</tbody></table></div>';
  return html;
}

function acGuard(){
  var src = acSrc();
  if (src && src.length) return null;
  var loading = window.__CS_CALLS_LOADING;
  return '<div class="cs-card" style="padding:32px;text-align:center;color:var(--mut)">'
    + '<div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:6px">'
    + (loading ? 'Cargando llamadas Aircall…' : 'Sin datos Aircall') + '</div>'
    + '<div style="font-size:13px;margin-bottom:14px">'
    + (loading ? 'Descargando el seed Aircall (≈ 3 MB · primera vez del día).' : 'No se pudo cargar el seed Aircall. Reintenta.') + '</div>'
    + (loading ? '<div style="font-size:24px">⏳</div>' : '<button class="cs-lbtn" id="acRetryBtn" style="display:inline-block;width:auto;padding:8px 18px">Reintentar descarga</button>')
    + '</div>';
}

/* ============================ DISPATCHER ============================ */
function buildAircallView(){
  var g = acGuard(); if (g) return g;
  var inner;
  if (S.tab === 'live') inner = buildAcLive();
  else if (S.tab === 'week') inner = buildAcWeek();
  else if (S.tab === 'org')  inner = buildAcMesa();
  else inner = buildAcAnalisis();
  var reload = '<div style="text-align:right;margin-bottom:6px">'
    + '<button onclick="this.textContent=\'Recargando…\';window.__acForceReload&&window.__acForceReload()" '
    + 'style="cursor:pointer;border:1px solid var(--border);background:var(--surface);color:var(--mut);'
    + 'font-family:inherit;font-size:11.5px;border-radius:7px;padding:5px 11px">🔄 Recargar llamadas</button></div>';
  return '<div style="margin-top:14px">' + reload + inner + '</div>';
}

/* ============================ TAB EN VIVO ============================ */
function buildAcLive(){
  var now = new Date();
  var hoy0 = acMidnight(now), hoyFrom = acUnix(hoy0), nowU = acUnix(now), offset = nowU - hoyFrom;
  var ayer0 = acUnix(acAddDays(now,-1)), sem0 = acUnix(acAddDays(now,-7));
  var hoyCalls = acInRange(hoyFrom, nowU);
  var hoy = acStats(hoyCalls), ex = acStatsExtra(hoyCalls);
  var ayer = acStats(acInRange(ayer0, ayer0 + offset)), sem = acStats(acInRange(sem0, sem0 + offset));
  var ayerAtip = ayer.rec<10, semAtip = sem.rec<10;
  var hhmm = acPad(now.getHours()) + ':' + acPad(now.getMinutes());

  var html = '<div style="font-size:12.5px;color:var(--mut);margin-bottom:4px">Teléfono ' + AC_BADGE + ' · <b style="color:var(--text)">hoy hasta ' + hhmm + '</b> (intradía acumulado)</div>'
    + '<div style="font-size:11.5px;color:var(--mut);margin-bottom:11px">⚠ Datos hasta el último sync (≤5 min) — no es estado de cola en vivo. Comparado vs ayer y vs mismo día de la semana pasada, a la misma hora.</div>';
  html += '<div class="cs-kgrid k4">';
  html += acKpi(hoy.rec.toLocaleString('es-CL'), 'Recibidas hoy', 'vs ayer ' + acDelta(hoy.rec, ayer.rec, ayerAtip) + ' · vs sem.ant ' + acDelta(hoy.rec, sem.rec, semAtip), AC_RECV);
  html += acKpi(hoy.ans.toLocaleString('es-CL'), 'Contestadas hoy', acPctTxt(hoy.ans, hoy.rec) + ' atención · vs ayer ' + acDelta(hoy.ans, ayer.ans, ayerAtip), AC_ANS);
  html += acKpiAb(hoy, 'Abandono hoy', hoy.lost + ' perdidas · vs ayer ' + acDelta(hoy.abandPct||0, ayer.abandPct, ayerAtip));
  html += acKpi(ex.outbound.toLocaleString('es-CL'), 'Llamadas emitidas hoy', 'salientes (outbound)', AC_OUT);
  html += '</div>';
  /* cards extra: ASA, duración mediana, %ticket */
  html += '<div class="cs-kgrid k4" style="margin-top:10px">';
  html += acKpi(acFmtSec(hoy.asa), 'Espera prom. (ASA)', hoy.asaN + ' con dato · p90 ' + acFmtSec(acPctil(hoy.asaArr,90)), AC_WAIT);
  html += acKpi(acFmtSec(hoy.talkMed), 'Duración mediana', hoy.talkN + ' contestadas', '#6B4FBB');
  html += acKpi(acPctTxt(ex.withTicket, hoy.rec), 'Con ticket Zendesk', ex.withTicket + ' cruzadas', '#6B4FBB');
  html += acKpi(acPctTxt(hoy.lost-hoy.lostCorto, hoy.rec-hoy.lostCorto), 'Abandono ajustado', 'excl. ≤' + AC_ABAND_UMBRAL + 's', AC_LOST);
  html += '</div>';

  html += '<div class="cs-h2">Curva de hoy por hora ' + AC_BADGE + '<span class="cs-h2s">contestadas + perdidas · línea = recibidas mismo día sem. pasada</span></div>' + chartCard('', 'cAcLive', 300);
  html += '<div class="cs-h2">Patrón temporal por hora ' + AC_BADGE + '<span class="cs-h2s">entrantes (inbound) vs salientes (outbound)</span></div>' + chartCard('', 'cAcLiveIO', 260);
  html += acTablaComparativa('Hoy vs ayer vs semana pasada (a la misma hora)', [{nombre:'Hoy ('+hhmm+')',st:hoy},{nombre:'Ayer',st:ayer},{nombre:'Sem. pasada',st:sem}]);
  html += acBloqueTops(ex);
  html += acTablaPorMesa(hoyCalls, 'Por mesa / línea · hoy');
  return html;
}

/* ============================ TAB SEMANAL ============================ */
function buildAcWeek(){
  var mon = semanaActual();
  var monU = acUnix(mon), finU = acUnix(acAddDays(mon,7)), nowU = acUnix(new Date());
  var esActual = (S.weekOffset||0)===0;
  var toU = esActual ? Math.min(finU, nowU) : finU;
  var offset = toU - monU;
  var monAntU = acUnix(acAddDays(mon,-7));
  var calls = acInRange(monU, toU);
  var actual = acStats(calls), ex = acStatsExtra(calls);
  var antCalls = acInRange(monAntU, monAntU + offset);
  var anterior = acStats(antCalls), exAnt = acStatsExtra(antCalls);
  var cbAct = acCallbackAnalysis(calls, 7*86400), cbAnt = acCallbackAnalysis(antCalls, 7*86400);
  var fri = acAddDays(mon,4);

  var html = '<div style="font-size:12.5px;color:var(--mut);margin-bottom:11px">Teléfono ' + AC_BADGE + ' · <b style="color:var(--text)">semana ' + fmtDM(mon) + ' al ' + fmtDM(fri) + '</b>' + (esActual?' (en curso, parcial)':'') + ' · vs misma franja de la semana anterior' + (S.weekAgent?' · ejecutivo filtrado':'') + '</div>';
  html += '<div class="cs-kgrid k4">';
  html += acKpi(actual.rec.toLocaleString('es-CL'), 'Recibidas', 'vs sem.ant ' + acDelta(actual.rec, anterior.rec, anterior.rec<10), AC_RECV);
  html += acKpiAb(actual, 'Abandono (bruto)', 'ajustado ' + acPctTxt(actual.lost-actual.lostCorto, actual.rec-actual.lostCorto) + ' · vs sem.ant ' + acDelta(actual.abandPct||0, anterior.abandPct, anterior.rec<10));
  html += acKpi(acFmtSec(actual.asa), 'Espera prom. (ASA)', 'p90 ' + acFmtSec(acPctil(actual.asaArr,90)) + ' · ' + actual.asaN + ' con dato', AC_WAIT);
  html += acKpi(cbAct.perdidasSinReintento.toLocaleString('es-CL'), 'Perdidas sin reintento', 'no volvieron (7d) · daño real', AC_LOST);
  html += '</div>';
  html += acCardsExtra(actual, ex, true);

  html += '<div class="cs-h2">Llamadas por día ' + AC_BADGE + '<span class="cs-h2s">entrantes / salientes / atendidas · lun→dom</span></div>' + chartCard('', 'cAcWeek', 300);
  html += '<div class="cs-h2">Patrón temporal por hora ' + AC_BADGE + '<span class="cs-h2s">promedio entrantes vs salientes por hora en la semana</span></div>' + chartCard('', 'cAcWeekIO', 260);
  html += acTablaComparativa('Semana actual vs anterior', [{nombre:'Esta semana',st:actual,ex:ex,cb:cbAct},{nombre:'Semana anterior',st:anterior,ex:exAnt,cb:cbAnt}]);
  html += '<div class="cs-h2">Tendencia · últimas 8 semanas ' + AC_BADGE + '<span class="cs-h2s">recibidas y % abandono</span></div>' + chartCard('', 'cAcWeekTrend', 240);
  html += acBloqueRazones(ex, actual);
  html += acBloqueTops(ex);
  html += acTablaPorMesa(calls, 'Por mesa / línea · esta semana');
  return html;
}

/* ============================ TAB ANÁLISIS ============================ */
function buildAcAnalisis(){
  var w = computeAnaWindow();
  var fromU = Math.floor(w.startMs/1000), toU = Math.floor(w.endMs/1000) + 1;
  var rango = acInRange(fromU, toU);
  var st = acStats(rango), ex = acStatsExtra(rango), cb = acCallbackAnalysis(rango, 7*86400);
  var offRec=0, offLost=0;
  for (var i=0;i<rango.length;i++){ var c=rango[i]; if(c.direction!=='inbound'||typeof c.started_at!=='number')continue; if(!acEsLaboral(new Date(c.started_at*1000))){offRec++; if(!c.answered_at)offLost++;} }
  var gran = (S.gran||'day');

  var html = '<div style="font-size:12.5px;color:var(--mut);margin-bottom:11px">Teléfono ' + AC_BADGE + ' · <b style="color:var(--text)">' + esc(w.label) + '</b> · análisis profundo · gráfico ' + (gran==='month'?'por mes':gran==='week'?'por semana':'por día') + (S.weekAgent?' · ejecutivo filtrado':'') + '</div>';
  html += '<div class="cs-kgrid k4">';
  html += acKpi(st.rec.toLocaleString('es-CL'), 'Recibidas', st.ans + ' contest · ' + st.lost + ' perd', AC_RECV);
  html += acKpiAb(st, 'Abandono (bruto)', 'ajustado ' + acPctTxt(st.lost-st.lostCorto, st.rec-st.lostCorto) + ' (excl. ≤' + AC_ABAND_UMBRAL + 's)');
  html += acKpi(acFmtSec(st.asa), 'Espera prom. (ASA)', 'p50 ' + acFmtSec(acPctil(st.asaArr,50)) + ' · p90 ' + acFmtSec(acPctil(st.asaArr,90)), AC_WAIT);
  html += acKpi(acFmtSec(st.talk), 'Duración conversación', st.talkN + ' contestadas (prom)', '#6B4FBB');
  html += '</div>';
  html += acCardsExtra(st, ex, true);

  window.__acAnaBuckets = acBucketsGran(fromU, toU, gran);
  html += '<div class="cs-h2">Volumen y abandono ' + AC_BADGE + '</div>' + chartCard('', 'cAcAna', 300);
  html += '<div class="cs-h2">Patrón temporal por hora ' + AC_BADGE + '<span class="cs-h2s">entrantes vs salientes (total del rango)</span></div>' + chartCard('', 'cAcAnaIO', 260);

  /* percentiles de espera */
  html += '<div class="cs-h2">Distribución de la espera (ASA) ' + AC_BADGE + '<span class="cs-h2s">el promedio esconde la cola</span></div>'
    + '<div class="cs-card"><table class="cs-t"><thead><tr>' + acThC('Mediana (p50)') + acThC('p90') + acThC('p95') + acThC('Máx') + '</tr></thead><tbody><tr>'
    + acTdC(acFmtSec(acPctil(st.asaArr,50))) + acTdC(acFmtSec(acPctil(st.asaArr,90))) + acTdC(acFmtSec(acPctil(st.asaArr,95))) + acTdC(acFmtSec(st.asaArr.length?Math.max.apply(null,st.asaArr):null)) + '</tr></tbody></table></div>';

  /* rellamadas + off-hours */
  html += '<div class="cs-kgrid k4" style="margin-top:6px">';
  html += acKpi((cb.rellamadaPct==null?'—':cb.rellamadaPct+'%'), 'Tasa de rellamada (7d)', 'proxy de no-resolución', '#6B4FBB');
  html += acKpi(cb.perdidasSinReintento.toLocaleString('es-CL'), 'Perdidas sin reintento', 'daño real (7d)', AC_LOST);
  html += acKpi(acPctTxt(offRec, st.rec), 'Recibidas fuera de horario', offRec + ' llam. (L-V 8:30-20·Sáb 8:30-13:30)', AC_WAIT);
  html += acKpi(acPctTxt(offLost, offRec), 'Abandono fuera de horario', offLost + ' de ' + offRec, AC_LOST);
  html += '</div>';

  html += acBloqueRazones(ex, st);
  html += acBloqueTops(ex);
  html += acTablaPorMesa(rango, 'Abandono por mesa · ' + esc(w.label));
  return html;
}

/* ============================ TAB POR MESA / LÍNEA (org) ============================ */
function buildAcMesa(){
  var html = '<div class="cs-card" style="padding:14px 16px;margin-bottom:14px;border-left:3px solid var(--ic-naranjo);font-size:13px;color:var(--mut)">'
    + '<b style="color:var(--text)">Análisis por cliente no disponible en Teléfono.</b> Aircall no entrega la organización/razón social de quien llama. El análisis por cliente real vive en el canal <b>Zendesk</b>. Aquí va el desglose <b>por mesa / línea</b> (el número Aircall marcado).</div>';
  html += acTablaPorMesa(acSrc(), 'Por mesa / línea · histórico completo');
  return html;
}
function acTablaPorMesa(calls, titulo){
  var byMesa = {}, excluidas = 0;
  for (var i=0;i<calls.length;i++){ var c=calls[i]; if(c.direction!=='inbound')continue;
    var nm=c.number_name; if(acMesaExcluir(nm)){excluidas++;continue;}
    var m=byMesa[nm]=byMesa[nm]||{rec:0,ans:0,lost:0,asa:[],horas:{}};
    m.rec++; if(c.answered_at){m.ans++; if(typeof c.frt_sec==='number')m.asa.push(c.frt_sec);} else m.lost++;
    if(typeof c.started_at==='number'){var h=new Date(c.started_at*1000).getHours(); m.horas[h]=(m.horas[h]||0)+1;}
  }
  var arr=Object.keys(byMesa).map(function(k){return [k,byMesa[k]];}).filter(function(e){return e[1].rec>0;}).sort(function(a,b){return b[1].rec-a[1].rec;});
  if(!arr.length) return '';
  var html='<div class="cs-h2">' + esc(titulo) + ' ' + AC_BADGE + '<span class="cs-h2s">mesa = número Aircall (no cliente) · clasificación fina pendiente con la líder</span></div>'
    + '<div class="cs-card"><table class="cs-t"><thead><tr><th>Mesa / línea</th>' + acThC('Recibidas') + acThC('Contestación') + acThC('Abandono') + acThC('Espera (ASA)') + acThC('Hora pico') + '</tr></thead><tbody>';
  arr.forEach(function(e){ var nm=e[0],m=e[1]; var asaAvg=m.asa.length?m.asa.reduce(function(x,y){return x+y;},0)/m.asa.length:null;
    var hp=null,hpv=-1; for(var h in m.horas){if(m.horas[h]>hpv){hpv=m.horas[h];hp=h;}}
    html+='<tr><td>'+esc(nm)+'</td>'+acTdC(m.rec.toLocaleString('es-CL'))+acTdC(acPctTxt(m.ans,m.rec))+acTdAb(acPct(m.lost,m.rec))+acTdC(acFmtSec(asaAvg))+acTdC(hp!=null?(acPad(parseInt(hp,10))+':00'):'—')+'</tr>'; });
  html+='</tbody></table>';
  if(excluidas>0) html+='<div style="font-size:11px;color:var(--mut);padding:8px 2px 0">Nota: '+excluidas+' llamadas en líneas no clasificables (agentes/números crudos/"Libre") excluidas.</div>';
  html+='</div>';
  return html;
}

/* buckets para granularidad del gráfico (DST-safe: avance por componentes) */
function acBucketsGran(fromU, toU, gran){
  var out=[]; var d=acMidnight(new Date(fromU*1000)); var guard=0;
  while (acUnix(d) < toU && guard++ < 400){
    var bFrom, bTo, label;
    if (gran==='month'){ bFrom=new Date(d.getFullYear(),d.getMonth(),1,0,0,0,0); bTo=new Date(d.getFullYear(),d.getMonth()+1,1,0,0,0,0); label=MES[d.getMonth()]+' '+String(d.getFullYear()).slice(2); }
    else if (gran==='week'){ bFrom=acMonday(d); bTo=acAddDays(bFrom,7); label='sem '+fmtDM(bFrom); }
    else { bFrom=acMidnight(d); bTo=acAddDays(bFrom,1); label=fmtDM(bFrom); }
    var st=acStats(acInRange(acUnix(bFrom), Math.min(toU, acUnix(bTo))));
    out.push({label:label, rec:st.rec, ans:st.ans, lost:st.lost, abandPct:st.abandPct, isWeekend:(gran==='day'&&(bFrom.getDay()===0||bFrom.getDay()===6))});
    d = bTo;   /* avance por componentes (acAddDays/mes) → DST-safe */
  }
  return out;
}

/* ============================ CHARTS ============================ */
function drawAircallCharts(){
  if (acGuard()) return;
  if (S.tab === 'live'){ drawAcLive(); drawAcIO('cAcLiveIO', acInRange(acUnix(acMidnight(new Date())), acUnix(new Date())), 'hora'); return; }
  if (S.tab === 'week'){ drawAcWeekByDay(); drawAcWeekTrend(); var mon=semanaActual(); drawAcIO('cAcWeekIO', acInRange(acUnix(mon), Math.min(acUnix(acAddDays(mon,7)), acUnix(new Date()))), 'hora'); return; }
  if (S.tab === 'org') return;
  var w=computeAnaWindow(); drawAcAna(); drawAcIO('cAcAnaIO', acInRange(Math.floor(w.startMs/1000), Math.floor(w.endMs/1000)+1), 'hora');
}
/* curva intradía hoy + línea sem pasada */
function drawAcLive(){
  var now=new Date(); var hoy0=acMidnight(now), sem0=acAddDays(now,-7);
  var hAns=new Array(24).fill(0), hLost=new Array(24).fill(0), semRec=new Array(24).fill(0);
  var hoyFrom=acUnix(hoy0), nowU=acUnix(now), semFrom=acUnix(sem0), semTo=semFrom+(nowU-hoyFrom);
  var src=acFiltroEjec(acSrc());
  for (var i=0;i<src.length;i++){ var c=src[i]; if(c.direction!=='inbound'||typeof c.started_at!=='number')continue; var t=c.started_at;
    if(t>=hoyFrom&&t<nowU){var h=new Date(t*1000).getHours(); if(c.answered_at)hAns[h]++; else hLost[h]++;}
    else if(t>=semFrom&&t<semTo){semRec[new Date(t*1000).getHours()]++;} }
  var labels=[]; for(var x=0;x<24;x++)labels.push(acPad(x)+'h');
  mkChart('cAcLive',{type:'bar',data:{labels:labels,datasets:[
    {type:'bar',label:'Contestadas',data:hAns,backgroundColor:AC_ANS,stack:'h'},
    {type:'bar',label:'Perdidas',data:hLost,backgroundColor:AC_LOST,stack:'h'},
    {type:'line',label:'Recibidas sem. pasada',data:semRec,borderColor:acAlpha(AC_RECV,.7),backgroundColor:acAlpha(AC_RECV,.7),borderDash:[5,4],pointRadius:0,tension:.3}
  ]},options:{plugins:{legend:baseLegend()},scales:axisOpts(true)}});
}
/* patrón temporal inbound/outbound por hora */
function drawAcIO(id, calls, modo){
  var hin=new Array(24).fill(0), hout=new Array(24).fill(0);
  for (var i=0;i<calls.length;i++){ var c=calls[i]; if(typeof c.started_at!=='number')continue; var h=new Date(c.started_at*1000).getHours();
    if(c.direction==='outbound')hout[h]++; else if(c.direction==='inbound')hin[h]++; }
  var labels=[]; for(var x=0;x<24;x++)labels.push(acPad(x)+'h');
  mkChart(id,{type:'bar',data:{labels:labels,datasets:[
    {label:'Entrantes',data:hin,backgroundColor:AC_RECV},
    {label:'Salientes',data:hout,backgroundColor:AC_OUT}
  ]},options:{plugins:{legend:baseLegend()},scales:axisOpts(false)}});
}
/* semana por día: entrantes/salientes/atendidas */
function drawAcWeekByDay(){
  var mon=semanaActual(); var inb=new Array(7).fill(0), out=new Array(7).fill(0), ans=new Array(7).fill(0);
  var monU=acUnix(mon), finU=acUnix(acAddDays(mon,7));
  var src=acFiltroEjec(acSrc());
  for (var i=0;i<src.length;i++){ var c=src[i]; if(typeof c.started_at!=='number')continue; var t=c.started_at; if(t<monU||t>=finU)continue;
    var d=(new Date(t*1000).getDay()+6)%7;
    if(c.direction==='outbound')out[d]++; else if(c.direction==='inbound'){inb[d]++; if(c.answered_at)ans[d]++;} }
  mkChart('cAcWeek',{type:'bar',data:{labels:['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'],datasets:[
    {label:'Entrantes',data:inb,backgroundColor:AC_RECV},
    {label:'Atendidas',data:ans,backgroundColor:AC_ANS},
    {label:'Salientes',data:out,backgroundColor:AC_OUT}
  ]},options:{plugins:{legend:baseLegend()},scales:axisOpts(false)}});
}
/* tendencia 8 semanas (DST-safe) */
function drawAcWeekTrend(){
  var lun0=acMonday(new Date());
  var labels=[],recs=[],abs=[];
  for (var w=7; w>=0; w--){
    var f=acAddDays(lun0, -w*7), t=acAddDays(f,7);
    var st=acStats(acInRange(acUnix(f), acUnix(t)));
    labels.push(fmtDM(f)); recs.push(st.rec); abs.push(st.abandPct||0);
  }
  mkChart('cAcWeekTrend',{type:'bar',data:{labels:labels,datasets:[
    {type:'bar',label:'Recibidas',data:recs,backgroundColor:acAlpha(AC_RECV,.75),yAxisID:'y',order:2},
    {type:'line',label:'% Abandono',data:abs,borderColor:AC_LOST,backgroundColor:AC_LOST,yAxisID:'y1',tension:.3,pointRadius:3,order:1}
  ]},options:{plugins:{legend:baseLegend()},scales:{
    x:axisOpts(false).x,
    y:{position:'left',beginAtZero:true,ticks:{color:AXIS,font:{size:11}},grid:{color:GRID}},
    y1:{position:'right',beginAtZero:true,max:100,ticks:{color:AXIS,font:{size:11},callback:function(v){return v+'%';}},grid:{display:false}}
  }}});
}
function drawAcAna(){
  var b=window.__acAnaBuckets||[]; if(!b.length)return;
  var ansBg=b.map(function(x){return x.isWeekend?acAlpha(AC_ANS,.42):AC_ANS;});
  var lostBg=b.map(function(x){return x.isWeekend?acAlpha(AC_LOST,.42):AC_LOST;});
  mkChart('cAcAna',{type:'bar',data:{labels:b.map(function(x){return x.label;}),datasets:[
    {label:'Contestadas',data:b.map(function(x){return x.ans;}),backgroundColor:ansBg,borderColor:AC_SEGB,borderWidth:1,stack:'a'},
    {label:'Perdidas',data:b.map(function(x){return x.lost;}),backgroundColor:lostBg,borderColor:AC_SEGB,borderWidth:1,stack:'a'}
  ]},options:{plugins:{legend:baseLegend(),tooltip:{mode:'index',intersect:false,callbacks:{footer:function(it){if(!it.length)return'';var d=b[it[0].dataIndex];return 'Recibidas '+d.rec+' · Abandono '+acPctTxt(d.lost,d.rec);}}}},scales:axisOpts(true)}});
}

/* ============================================================
   PINTADO + BINDING
   ============================================================ */
function drawCharts(){
  /* Paneles Extras manejan sus charts internamente, independiente del canal:
   * tienen prioridad para que la vista Aircall no intente dibujar sobre ellos. */
  if (S.tab === 'extras') return;
  /* Fase B — vista Aircall tiene sus propios charts (hora/día). El tab Clientes en Aircall
   * muestra un aviso (sin datos de cliente) → no dibujar charts ahí. */
  if (S.channel === 'ac') {
    if (S.tab === 'org') return;
    drawAircallCharts(); return;
  }
  if (S.tab === 'live') drawLiveCharts();
  else if (S.tab === 'week') drawWeekCharts();
  else if (S.tab === 'org') drawOrgCharts();
  else drawAnaCharts();
}
/* Fase B — recalcula T/CALLS/GROUPS_ACTIVOS según S.channel. Se llama:
 *   - una vez al inicio del módulo (cuando carga el render)
 *   - al inicio de repaint() (cada vez que el usuario cambia algo)
 * BUG fix crítico: antes solo se llamaba al inicio del módulo, entonces al
 * cambiar el dropdown del canal los datos quedaban "pegados" hasta el próximo
 * F5. Ahora cada repaint re-deriva el universo desde T_ALL y CALLS_ALL.
 *
 * Re-encuadre 2026-05-28 — semántica del filtro 'zd':
 *   ANTES: T = T_ALL.filter(canal_normalizado === 'Correo')  → escondía 41% del universo
 *   AHORA: T = T_ALL (universo total Zendesk, todos los canal_normalizado)
 * El subcanal 'wn' sigue filtrando a canal=Chat hasta el deploy de Wotnot stream. */
function applyChannelFilter(){
  if (S.channel === 'zd')      T = T_ALL;
  else if (S.channel === 'wn') T = T_ALL.filter(function(t){ return t.canal_normalizado === 'Chat'; });
  else if (S.channel === 'ac') T = [];
  else                          T = T_ALL;
  /* CALLS_ALL se hidrata async desde IDB; siempre re-leer window.__CS_CALLS */
  CALLS_ALL = window.__CS_CALLS || CALLS_ALL || [];
  /* En vista Aircall, CALLS se filtra por el rango del tab (En vivo = hoy, etc.).
     'all' (resumen multicanal) usa el universo completo. */
  if (S.channel === 'ac')       CALLS = callsInRange();
  else if (S.channel === 'all') CALLS = CALLS_ALL;
  else                          CALLS = [];
  GROUPS_ACTIVOS = {};
  T.forEach(function(t){ if (t.group_id != null) GROUPS_ACTIVOS[t.group_id] = 1; });
}

function repaint(){
  applyChannelFilter();   /* CRÍTICO: rederivar universo antes de re-pintar */
  /* Si filtro=ac y CALLS está vacío, intentar (re)hidratar — útil tras Ctrl+F5
   * o cuando _acEnsure falló por n8n caído al cargar el render */
  if (S.channel === 'ac' && (!CALLS || CALLS.length === 0) && !window.__CS_CALLS_LOADING) {
    _acEnsure();
  }
  closeModal();
  destroyCharts();

  var h = '<div class="cs-wrap">';
  h += '<div class="cs-topstick">' + buildHeader() + buildTabs() + buildFilterBar() + '</div>';
  h += buildStaleBanner();
  /* Paneles Extras son GLOBALES: su data viene de endpoints propios (ej. cs-dte-health),
   * NO dependen del canal. Tienen prioridad sobre el filtro de canal para que el selector
   * Aircall (ni ningún canal) los pise. */
  if (S.tab === 'extras') {
    h += buildExtras();
  } else if (S.channel === 'ac') {
    /* Fase B — vista dedicada cuando el filtro es Aircall (los cálculos de tickets no aplican).
     * Excepción: el tab Clientes no aplica a Aircall (las llamadas no traen organización) → aviso. */
    h += (S.tab === 'org') ? buildAircallUnavailable() : buildAircallView();
  } else {
    /* Fase B — franja Multicanal cuando filtro = Todos (solo tabs operacionales). */
    if (S.channel === 'all' || !S.channel) {
      h += buildMulticanalSummary();
    }
    h += (S.tab === 'live') ? buildLive() : (S.tab === 'week') ? buildWeek() : (S.tab === 'org') ? buildOrg() : buildAna();
  }
  h += '</div>';
  BODY.innerHTML = h;

  BODY.querySelectorAll('.cs-tab').forEach(function (b) {
    b.addEventListener('click', function () {
      var tab = b.dataset.tab;
      /* Clickear "Paneles Extras" siempre vuelve a la vista inicial del tab (listado de
         paneles), incluso si ya estás en él con un panel abierto — misma acción que el
         botón "← Paneles Extras". Antes quedaba "pegado" en el panel seleccionado. */
      if (tab === 'extras') S.extraView = '';
      S.tab = tab; saveState(); repaint();
    });
  });
  /* Fase B — selector canal global */
  var chEl = BODY.querySelector('#csChannel');
  if (chEl) chEl.addEventListener('change', function () {
    S.channel = chEl.value;
    saveState();
    repaint();
  });
  /* Fase C — abrir panel desde el catálogo */
  BODY.querySelectorAll('[data-extras-open]').forEach(function (b) {
    b.addEventListener('click', function () {
      S.extraView = b.getAttribute('data-extras-open');
      saveState();
      repaint();
    });
  });
  /* Fase C — volver al catálogo desde un panel abierto */
  var backEl = BODY.querySelector('[data-extras-back]');
  if (backEl) backEl.addEventListener('click', function () {
    S.extraView = '';
    saveState();
    repaint();
  });
  /* Fase B — botón Reintentar de la vista Aircall vacía */
  var acRetry = BODY.querySelector('#acRetryBtn');
  if (acRetry) acRetry.addEventListener('click', function () {
    acRetry.disabled = true;
    acRetry.textContent = 'Descargando…';
    _acEnsure();
    /* La función _acEnsure llama a repaint cuando termina, vía _acTriggerRepaintIfAircall */
  });
  BODY.querySelectorAll('.cs-sel[data-f]').forEach(function (sel) {
    sel.addEventListener('change', function () {
      S[sel.dataset.f] = sel.value;
      if (sel.dataset.f === 'org') { S.orgPage = 0; S.orgHistVisible = false; }
      saveState(); repaint();
    });
  });

  /* Inputs date del panel Exportador (Tab Cliente — HU 5) — repintar para refrescar conteo */
  var expFrom = BODY.querySelector('#csOrgExpFrom');
  var expTo   = BODY.querySelector('#csOrgExpTo');
  if (expFrom) expFrom.addEventListener('change', function(){
    S.orgExp.from = expFrom.value; saveState(); repaint();
  });
  if (expTo) expTo.addEventListener('change', function(){
    S.orgExp.to = expTo.value; saveState(); repaint();
  });

  /* Multi-select (Equipo) — checkboxes + Todos/Ninguno + persistir open/close */
  BODY.querySelectorAll('details.cs-multi').forEach(function(det){
    det.addEventListener('toggle', function(){
      S.gidsOpen = det.open;
      try { localStorage.setItem(SKEY, JSON.stringify(S)); } catch(e){}
    });
  });
  /* Cerrar el multi-select al hacer click FUERA de él (antes solo cerraba al
     clickear el trigger). Setea det.open=false → dispara el 'toggle' de arriba que
     persiste S.gidsOpen. Listener global idempotente (no se duplica entre repaints);
     no toca S directamente, solo el DOM, para evitar closures stale. */
  if (typeof window !== 'undefined' && !window.__csMultiOutsideBound) {
    window.__csMultiOutsideBound = true;
    document.addEventListener('mousedown', function(e){
      var abiertos = document.querySelectorAll('details.cs-multi[open]');
      for (var i = 0; i < abiertos.length; i++) {
        if (!abiertos[i].contains(e.target)) abiertos[i].open = false;
      }
    });
  }
  BODY.querySelectorAll('[data-multi-id]').forEach(function(cb){
    cb.addEventListener('change', function(){
      var key = cb.dataset.multiId;       /* 'gids' */
      var v   = String(cb.value);
      /* si era undefined (= todos), inicializar con todos los ids visibles */
      if (!Array.isArray(S[key])){
        var all = [];
        cb.closest('.cs-multi-list').querySelectorAll('[data-multi-id]').forEach(function(x){
          all.push(String(x.value));
        });
        S[key] = all;
      }
      var idx = S[key].indexOf(v);
      if (cb.checked && idx < 0) S[key].push(v);
      if (!cb.checked && idx >= 0) S[key].splice(idx, 1);
      saveState(); repaint();
    });
  });
  BODY.querySelectorAll('[data-multi-all]').forEach(function(b){
    b.addEventListener('click', function(e){
      e.preventDefault();
      S[b.dataset.multiAll] = undefined;     /* = todos */
      saveState(); repaint();
    });
  });
  BODY.querySelectorAll('[data-multi-none]').forEach(function(b){
    b.addEventListener('click', function(e){
      e.preventDefault();
      S[b.dataset.multiNone] = [];           /* = ninguno */
      saveState(); repaint();
    });
  });
  BODY.querySelectorAll('[data-week]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (b.dataset.week === 'prev') S.weekOffset -= 1;
      else if (S.weekOffset < 0) S.weekOffset += 1;
      saveState(); repaint();
    });
  });
  BODY.querySelectorAll('[data-a]').forEach(function (el) {
    var ev = el.type === 'checkbox' || el.tagName === 'SELECT' || el.type === 'date' ? 'change' : 'input';
    el.addEventListener(ev, function () {
      var key = el.dataset.a;
      S[key] = el.type === 'checkbox' ? el.checked : el.value;
      saveState(); repaint();
    });
  });
  BODY.querySelectorAll('.cs-clk[data-modal]').forEach(function (tr) {
    tr.addEventListener('click', function () { openModal(tr.dataset.modal, tr.dataset.id); });
  });
  BODY.querySelectorAll('[data-act]').forEach(function (b) {
    b.addEventListener('click', function () {
      var a = b.dataset.act;
      if (a === 'export' || a === 'pdf') { exportPDF(); return; }
      if (a === 'theme') { if (CTX_ACTIONS.toggleTheme) CTX_ACTIONS.toggleTheme(); return; }
      if (a === 'orgSelect')   { S.org = b.dataset.id||''; S.orgPage=0; S.orgActPage=0; S.orgEjecPage=0;
                                  S.orgHistVisible=false; S.orgActSort={key:'default',dir:1}; saveState(); repaint(); return; }
      if (a === 'orgHist')     { S.orgHistVisible=!S.orgHistVisible; S.orgPage=0; saveState(); repaint(); return; }
      if (a === 'orgExpVer')   { if (S.org) expVerDatosModal(S.org); return; }
      if (a === 'orgExpDown')  { if (S.org) expExportar(S.org); return; }
      if (a === 'orgPage')     { S.orgPage=parseInt(b.dataset.page,10)||0; saveState(); repaint(); return; }
      if (a === 'orgActPage')  { S.orgActPage=parseInt(b.dataset.page,10)||0; saveState(); repaint(); return; }
      if (a === 'orgEjecPage') { S.orgEjecPage=parseInt(b.dataset.page,10)||0; saveState(); repaint(); return; }
      if (a === 'orgTopPage')  { S.orgTopPage=parseInt(b.dataset.page,10)||0; saveState(); repaint(); return; }
      if (a === 'orgActSort')  {
        var k = b.dataset.key;
        if (S.orgActSort && S.orgActSort.key === k) S.orgActSort.dir = -S.orgActSort.dir;
        else S.orgActSort = { key:k, dir:1 };
        S.orgActPage = 0;
        saveState(); repaint(); return;
      }
      if (a === 'orgExportActivos') {
        if (!S.org) return;
        var actAll = orgUniverse(S.org).filter(function(t){ return !!ACTIVE[t.status]; });
        actAll.sort(function(x,y){
          var sx = slaBreached(x) ? 0 : 1;
          var sy = slaBreached(y) ? 0 : 1;
          return sx - sy || ms(x.created_at) - ms(y.created_at);
        });
        var headers = ['#','Ticket','Triage','Asunto','Ejecutivo','Equipo','Estado','Prioridad','Nivel','SLA','Categoría','Producto','Línea negocio','Apertura','Actualizado'];
        var xlsRows = actAll.map(function(t, i){
          return [
            i + 1,
            t.id,
            triage(t.subject) || '',
            t.subject || '',
            agentName(t.assignee_id),
            groupName(t.group_id),
            STATUS_LBL[t.status] || t.status || '',
            PRIO_LBL[t.priority] || t.priority || '',
            t.nivel ? (t.nivel.charAt(0).toUpperCase() + t.nivel.slice(1)) : '',
            slaBreached(t) ? 'Vencido' : slaOk(t) ? 'OK' : '',
            t.categoria || '',
            t.producto || '',
            t.linea_negocio || '',
            t.created_at || '',
            t.updated_at || ''
          ];
        });
        var fname = 'tickets-activos-' + slug(OR[S.org]||('org-'+S.org)) + '-' + fmtDate(new Date()) + '.xlsx';
        exportTicketsXlsx(fname, 'Tickets activos', headers, xlsRows, 1);   /* col 1 = Ticket → hyperlink */
        return;
      }
      /* Si estamos en el panel DTE Health dentro de Extras y el usuario apretó
         "Actualizar" del header, también refrescamos los datos DTE (otro webhook) */
      if (a === 'refresh' && S.tab === 'extras' && S.extraView === 'dte') loadDteData(true);
      /* Fase B — el botón Actualizar también sincroniza deltas Aircall */
      if (a === 'refresh') _acSync();
      if (typeof CTX_ACTIONS[a] === 'function') CTX_ACTIONS[a]();
    });
  });

  /* buscador del estado vacío del tab Clientes — local, no repaint */
  var finder = BODY.querySelector('#cs-org-finder');
  if (finder){
    finder.addEventListener('keydown', function(e){
      if (e.key !== 'Enter') return;
      var q = stripDiacritics(finder.value).toLowerCase().trim();
      if (!q) return;
      /* busca el primer cliente cuyo nombre contiene la query y lo selecciona */
      var match = null;
      Object.keys(OR).forEach(function(id){
        if (match) return;
        if (stripDiacritics(OR[id]||'').toLowerCase().indexOf(q) >= 0) match = id;
      });
      if (match){ S.org = match; S.orgPage=0; S.orgActPage=0; S.orgEjecPage=0;
                  S.orgHistVisible=false; S.orgActSort={key:'default',dir:1}; saveState(); repaint(); }
      else finder.style.borderColor = 'var(--err)';
    });
    finder.addEventListener('input', function(){
      finder.parentElement.style.borderColor = '';
      var q = stripDiacritics(finder.value).toLowerCase().trim();
      var rows = BODY.querySelectorAll('.cs-org-tbl tbody tr');
      rows.forEach(function(tr){
        var nm = tr.querySelector('td.name');
        if (!nm) return;
        var txt = stripDiacritics(nm.textContent).toLowerCase();
        tr.style.display = (!q || txt.indexOf(q) >= 0) ? '' : 'none';
      });
    });
  }

  /* Bindings del tab DTE Health */
  if (S.tab === 'extras' && S.extraView === 'dte') bindDte();

  drawCharts();
}

loadHolidays();
repaint();
_acEnsure();   /* Fase B — descarga Aircall en background, repinta cuando termina si filtro=ac */

/* ── Auto-refresh cada 5 min ──────────────────────────────────────────────
   Vive en el render (servido por n8n) y NO en el index.html, porque el cascarón
   "se entrega una sola vez" — así el deploy del render distribuye el auto-refresh a
   todos los clientes sin reenviar el archivo local.
   Idempotente (window.__csAutoTimer): el timer se crea una sola vez aunque el render
   se re-ejecute en cada paint. Dispara CTX_ACTIONS.refresh = doRefresh del loader, que
   sincroniza tickets + calls desde Mongo y repinta. NUNCA pega a Zendesk: el cliente
   solo lee Mongo vía n8n. La única vía a Zendesk es el Schedule de n8n (cada 5 min). */
if (typeof window !== 'undefined' && !window.__csAutoTimer
    && CTX_ACTIONS && typeof CTX_ACTIONS.refresh === 'function') {
  window.__csAutoTimer = setInterval(function () {
    try { if (typeof CTX_ACTIONS.refresh === 'function') CTX_ACTIONS.refresh(); } catch (e) {}
  }, 5 * 60 * 1000);
}
