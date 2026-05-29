/* ============================================================
   cs-view — render(data, ctx) del Panel CS · iConstruye
   Fuente versionada. Deploy: assignment "js" del nodo
   "Construir Vista" (workflow CS View) vía deploy_cs_view.py

   Se ejecuta vía  new Function('data','ctx', <este archivo>)
   en el cascarón index.html.
     data: { tickets, agents_by_id, orgs_by_id, groups_by_id, meta }
     ctx:  { bodyEl, Chart }

   Tabs: En vivo · Análisis semanal · Análisis.
   Milestone mejoras Fase A (ver outputs/cs-panel/MEJORAS.md).
   ============================================================ */
var BODY = ctx.bodyEl;
var CHART = ctx.Chart || (typeof window !== 'undefined' ? window.Chart : null);
var T  = data.tickets || [];
var AG = data.agents_by_id || {};
var GR = data.groups_by_id || {};
var OR = data.orgs_by_id || {};

/* equipos con al menos un ticket cargado (para ocultar los vacíos del filtro) */
var GROUPS_ACTIVOS = {};
T.forEach(function (t) { if (t.group_id != null) GROUPS_ACTIVOS[t.group_id] = 1; });

/* ---- estado de UI (persistido entre paints vía localStorage) ---- */
var SKEY = 'csv-state';
var S;
try { S = JSON.parse(localStorage.getItem(SKEY)) || {}; } catch (e) { S = {}; }
S.tab  = S.tab  || 'live';
S.gid  = S.gid  || '';
S.type = S.type || '';
S.mode = S.mode || 'day';
S.gran = S.gran || 'week';
S.weekAgent = S.weekAgent || '';                   /* filtro de ejecutivo del tab semanal */
if (typeof S.weekOffset !== 'number') S.weekOffset = 0;  /* 0=semana actual · -1=anterior … */
if (typeof S.workdays !== 'boolean') S.workdays = false;
function saveState(){ try { localStorage.setItem(SKEY, JSON.stringify(S)); } catch (e) {} }

/* ---- constantes ---- */
var ACTIVE = { new:1, open:1, pending:1, hold:1 };
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

/* ---- universo filtrado por equipo + tipo ---- */
function applyFilters(list){
  return list.filter(function (t) {
    if (S.gid  && String(t.group_id) !== String(S.gid)) return false;
    if (S.type && inferType(t.subject) !== S.type) return false;
    return true;
  });
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
      if (t.sla_breached === true) r.br++;
      if (t.sla_breached != null) r.ev++;
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

function buildTabs(){
  function tb(id, txt){ return '<button class="cs-tab' + (S.tab===id?' on':'') + '" data-tab="' + id + '">' + txt + '</button>'; }
  return '<div class="cs-tabs">' + tb('live','En vivo') + tb('week','Análisis semanal') + tb('ana','Análisis') + '</div>';
}

function fld(label, inner){
  return '<div class="cs-fld"><label>' + label + '</label>' + inner + '</div>';
}
/* controles propios del tab Análisis — Modo + Día / Rango */
function anaFilterControls(){
  var now = new Date();
  var h = fld('Modo', '<select class="cs-sel" data-a="mode">'
    + '<option value="day"'   + (S.mode==='day'  ?' selected':'') + '>Día</option>'
    + '<option value="range"' + (S.mode==='range'?' selected':'') + '>Rango</option></select>');
  if (S.mode === 'day') {
    h += fld('Día', '<input type="date" class="cs-sel" data-a="day" value="'
      + esc(S.day || fmtDate(now)) + '">');
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
function buildFilterBar(){
  var grpOpts = '<option value="">Todos los equipos</option>';
  Object.keys(GR).filter(function (id) { return GROUPS_ACTIVOS[id]; })
    .map(function (id) { return { id:id, name:GR[id] || ('Equipo ' + id) }; })
    .sort(function (a, b) { return a.name.localeCompare(b.name); })
    .forEach(function (g) {
      grpOpts += '<option value="' + esc(g.id) + '"'
        + (String(S.gid) === String(g.id) ? ' selected' : '') + '>' + esc(g.name) + '</option>';
    });
  var typeOpts = '';
  [['', 'Todos los tipos'], ['incidente', 'Incidentes'], ['solicitud', 'Solicitudes']]
    .forEach(function (o) {
      typeOpts += '<option value="' + o[0] + '"'
        + (S.type === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
    });
  var html = '<div class="cs-fbar">'
    + fld('Equipo', '<select class="cs-sel" data-f="gid">' + grpOpts + '</select>')
    + fld('Tipo',   '<select class="cs-sel" data-f="type">' + typeOpts + '</select>');
  if (S.tab === 'ana')  html += anaFilterControls();
  if (S.tab === 'week') html += weekFilterControls();
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
    + kpiCard(num(j.in),   'Entradas',         'desde el corte', '#2D7FF9')
    + kpiCard(num(j.res),  'Resueltos',        'por ejecutivo',  '#17A24F')
    + kpiCard((neto > 0 ? '+' : '') + neto, 'Neto tickets', netoSub, '#6B4FBB', neto > 0 ? 'down' : 'up')
    + kpiCard(num(j.now),  'Queue ahora',      deltaTxt,         '#FF6A00', deltaCls)
    + '</div>';

  var open = 0, pend = 0, breach = 0, evald = 0;
  actives.forEach(function (t) {
    if (t.status === 'new' || t.status === 'open') open++; else pend++;
    if (t.sla_breached === true) breach++;
    if (t.sla_breached != null)  evald++;
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
    + '<th>Q.inicio</th><th>Entradas</th><th>Resueltos</th><th>Cerr.auto</th>'
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
    kpiCard(promEnt.toFixed(1), 'Prom. diario recibido', 'sobre ' + transcurridos + ' día(s)', '#2D7FF9'),
    kpiCard(promRes.toFixed(1), 'Prom. diario atendido', 'sobre ' + transcurridos + ' día(s)', '#17A24F'),
    kpiCard(mayorCarga ? mayorCarga.nombre : '—', 'Día de mayor carga', mayorCarga ? mayorCarga.ent + ' recibidos' : '', '#FF6A00'),
    kpiCard(mayorCierre ? mayorCierre.nombre : '—', 'Día de más cierres', mayorCierre ? mayorCierre.res + ' resueltos' : '', '#0047BB')
  ];
  /* con filtro de ejecutivo activo, "Mejor desempeño" no aporta → se oculta */
  if (!agFiltrado) {
    kCards.push(kpiCard(bestAg ? agentName(bestAg.id) : '—', 'Mejor desempeño',
      bestAg ? bestAg.n + ' resueltos' : '', '#6B4FBB'));
  }
  var kpis = '<div class="cs-kgrid k' + kCards.length + '">' + kCards.join('') + '</div>';

  var convKpi = '<div class="cs-kgrid k4">'
    + kpiCard(num(totEnt), 'Recibidos en la semana', 'lunes a viernes', '#2D7FF9')
    + kpiCard(num(totRes), 'Resueltos en la semana', 'lunes a viernes', '#17A24F')
    + kpiCard(totEnt ? Math.round(totRes/totEnt*100) + '%' : '—', 'Conversión semanal', 'resueltos / recibidos', '#17A24F')
    + kpiCard(mayorConv ? mayorConv.nombre + ' (' + convPct + '%)' : '—', 'Día de mayor conversión', 'resueltos vs. recibidos', '#FF6A00')
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
    + '<th>Día</th><th>Recibidos</th><th>Resueltos</th><th>Conversión</th>'
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
    if (t.sla_breached != null) { o.slaEv++; if (t.sla_breached === false) o.slaOk++; }
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

  var chart = '<div class="cs-h2">Recibidos vs. resueltos por día</div>'
    + '<div class="cs-cgrid one">' + chartCard('Semana en curso (lunes a viernes)', 'cWeek') + '</div>';

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
  var slaEv = 0, slaOk = 0;
  s.IN.concat(s.RESOLVED).forEach(function (t) {
    if (t.sla_breached != null) { slaEv++; if (t.sla_breached === false) slaOk++; }
  });
  var slaPctTxt = slaEv ? Math.round(slaOk / slaEv * 100) + '%' : '—';

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
    + kpiCard(num(inN), 'Entradas del período', rango, '#2D7FF9')
    + kpiCard(csatTxt, 'CSAT', csN ? csN + ' respuestas · ' + rango : 'sin respuestas en el período', '#FF6A00')
    + '</div>';

  var durs = s.RESOLVED.map(function (t) {
    return (ms(t.solved_at || t.updated_at) - ms(t.created_at)) / 3600000;
  }).filter(function (x) { return x >= 0; });
  var avgH = durs.length ? durs.reduce(function (a,b){ return a+b; }, 0) / durs.length : 0;

  var kpis = '<div class="cs-h2">Movimiento de tickets</div>'
    + '<div class="cs-kgrid k5">'
    + kpiCard(num(initN), 'Queue al iniciar', 'al inicio del período', '#0047BB')
    + kpiCard(num(inN),   'Entradas',         'creados en el período', '#2D7FF9')
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

  var charts = '<div class="cs-h2">Tendencias del período</div>'
    + '<div class="cs-cgrid one">' + chartCard('Flujo: entradas vs. cierres', 'cFlujo') + '</div>'
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
    if (t.sla_breached === true) gs[k].br++;
    else if (t.sla_breached === false) gs[k].ok++;
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
  var wd = weekData(weekUniverse());
  mkChart('cWeek', {
    type: 'line',
    data: { labels: wd.dias.map(function (d){ return d.nombre; }), datasets: [
      { label:'Recibidos', data:wd.dias.map(function (d){ return d.ent; }), borderColor:'#2D7FF9', backgroundColor:'rgba(45,127,249,.14)', fill:true, tension:.35 },
      { label:'Resueltos', data:wd.dias.map(function (d){ return d.res; }), borderColor:'#17A24F', backgroundColor:'rgba(23,162,79,.14)', fill:true, tension:.35 }
    ]},
    options: { plugins:{ legend:baseLegend() }, interaction:{ mode:'index', intersect:false }, scales:axisOpts(false) }
  });
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
  var gran = S.mode === 'day' ? 'hour' : S.gran;

  var cr = {}, re = {}, cl = {};
  s.IN.forEach(function (t){ var k = bucketKey(t.created_at, gran); cr[k] = (cr[k]||0)+1; });
  s.RESOLVED.forEach(function (t){ var k = bucketKey(t.solved_at || t.updated_at, gran); re[k] = (re[k]||0)+1; });
  s.CLOSED.forEach(function (t){ var k = bucketKey(t.closed_at || t.updated_at, gran); cl[k] = (cl[k]||0)+1; });
  var keys = Object.keys(cr).concat(Object.keys(re)).concat(Object.keys(cl));
  keys = keys.filter(function (v,i){ return keys.indexOf(v) === i; }).sort();
  mkChart('cFlujo', {
    type: 'line',
    data: { labels: keys, datasets: [
      { label:'Entradas',  data:keys.map(function (k){ return cr[k]||0; }), borderColor:'#2D7FF9', backgroundColor:'rgba(45,127,249,.12)', fill:true, tension:.35 },
      { label:'Resueltos', data:keys.map(function (k){ return re[k]||0; }), borderColor:'#17A24F', backgroundColor:'rgba(23,162,79,.12)', fill:true, tension:.35 },
      { label:'Cerrados auto', data:keys.map(function (k){ return cl[k]||0; }), borderColor:'#8895A0', borderDash:[4,4], fill:false, tension:.35 }
    ]},
    options: { plugins:{ legend:baseLegend() }, interaction:{ mode:'index', intersect:false }, scales:axisOpts(false) }
  });

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
      { label:'Entradas', data:catVal, backgroundColor:'#FF6A00' }
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
  sla:     { label:'SLA',         render:function(t){ return slaPill(t.sla_breached); }, sort:function(t){ return t.sla_breached===true?2:t.sla_breached===false?1:0; } },
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
    if (MODAL.fSla === 'br' && t.sla_breached !== true) return false;
    if (MODAL.fSla === 'ok' && t.sla_breached !== false) return false;
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
   PINTADO + BINDING
   ============================================================ */
function drawCharts(){
  if (S.tab === 'live') drawLiveCharts();
  else if (S.tab === 'week') drawWeekCharts();
  else drawAnaCharts();
}
function repaint(){
  closeModal();
  destroyCharts();

  var h = '<div class="cs-wrap">';
  h += '<div class="cs-stickybar">' + buildTabs() + buildFilterBar() + '</div>';
  h += (S.tab === 'live') ? buildLive() : (S.tab === 'week') ? buildWeek() : buildAna();
  h += '</div>';
  BODY.innerHTML = h;

  BODY.querySelectorAll('.cs-tab').forEach(function (b) {
    b.addEventListener('click', function () { S.tab = b.dataset.tab; saveState(); repaint(); });
  });
  BODY.querySelectorAll('.cs-sel[data-f]').forEach(function (sel) {
    sel.addEventListener('change', function () { S[sel.dataset.f] = sel.value; saveState(); repaint(); });
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
  var pdf = BODY.querySelector('[data-act="pdf"]');
  if (pdf) pdf.addEventListener('click', exportPDF);

  drawCharts();
}

loadHolidays();
repaint();
