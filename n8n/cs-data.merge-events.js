// CS Data — nodo "Merge Events" (rama Schedule). C2b escalamientos.
// Procesa ticket_events (cambios de grupo) y calcula los campos de escalamiento C2
// (paso_sn1/esc_sn2/esc_mo/devol) sobre los tickets que cs-data conoce de punta a
// punta (creados a partir del despliegue). El histórico lo aporta el seed; el cliente
// preserva esos campos cuando el delta no los trae.
const SN1 = new Set(['4681557011739', '4681700491547', '4681682013083', '4681854804123']);
const SN2 = '4681742537243';
const MO  = '4681656062107';

const sd = $getWorkflowStaticData('global');
const cache = sd.cache || (sd.cache = {});
if (!cache.esc_by_tid) cache.esc_by_tid = {};
const nowSec = Math.floor(Date.now() / 1000);

// 1 — acumular las transiciones de grupo del delta en esc_by_tid (no se poda)
const events = $input.all().flatMap(i => (i.json && i.json.ticket_events) || []);
for (const e of events) {
  const tid = e.ticket_id;
  if (tid == null) continue;
  for (const ce of (e.child_events || [])) {
    if (ce.event_type !== 'Change' || !('group_id' in ce)) continue;
    const prev = ce.previous_value != null ? String(ce.previous_value) : null;
    const nw   = ce.group_id != null ? String(ce.group_id) : null;
    (cache.esc_by_tid[tid] || (cache.esc_by_tid[tid] = [])).push([e.timestamp || 0, prev, nw]);
  }
}

// 2 — clasifica una secuencia de grupos (misma lógica que carga_inicial.escalation_fields)
function escFields(transitions, currentGroup) {
  const cg = currentGroup != null ? String(currentGroup) : null;
  let seq;
  if (transitions && transitions.length) {
    const trs = transitions.slice().sort((a, b) => (a[0] || 0) - (b[0] || 0));
    seq = [trs[0][1]].concat(trs.map(t => t[2]));
  } else {
    seq = [cg];
  }
  if (cg && (seq.length === 0 || seq[seq.length - 1] !== cg)) seq.push(cg);
  seq = seq.filter(Boolean);
  let devol = 0;
  for (let i = 0; i < seq.length - 1; i++) {
    if (seq[i] === SN2 && SN1.has(seq[i + 1])) devol++;
  }
  return {
    paso_sn1: seq.some(g => SN1.has(g)),
    esc_sn2:  seq.some(g => g === SN2),
    esc_mo:   seq.some(g => g === MO),
    devol:    devol,
  };
}

// 3 — escribe esc_* SOLO en tickets que cs-data conoce completos (created_at >= deploy)
const escSince = cache.esc_since_unix || 0;
let escWritten = 0;
for (const tid of Object.keys(cache.tickets || {})) {
  const t = cache.tickets[tid];
  const created = Date.parse(t.created_at || '') / 1000;
  if (Number.isFinite(created) && created >= escSince) {
    Object.assign(t, escFields(cache.esc_by_tid[tid] || [], t.group_id));
    escWritten++;
  }
}

cache.events_cursor = nowSec;

return [{ json: {
  ok: true,
  events_in: events.length,
  esc_tracked_tids: Object.keys(cache.esc_by_tid).length,
  esc_written: escWritten,
  esc_since_unix: cache.esc_since_unix || null,
  events_cursor: cache.events_cursor
} }];
