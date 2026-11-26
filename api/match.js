// Módulo de árbitro: el árbitro solo guarda SUS partidos asignados, y el servidor revisa cada cambio con las
// mismas reglas que ve en su pantalla (rules.js): suspendidos, presentación, mínimo para iniciar, espera para el
// W.O., penales y marcador. No puede tocar equipos, sorteo, calendario, ajustes ni partidos finalizados.
const { configured, verifyRole, readBody, readAll, casWrite } = require('./_lib');
const Rules = require('../rules.js');

/** Campos del partido que maneja el árbitro (todo lo demás debe quedar igual). */
const REF_FIELDS = new Set(['hs', 'as', 'goals', 'cards', 'penMiss', 'shoot', 'ph', 'pa', 'status', 'runAt', 'elapsed', 'added',
  'alerted', 'alertedAdd', 'period', 'halves', 'breakAt', 'breakMin', 'h1', 'present', 'startedWith', 'startedAt', 'wo', 'woAt', 'woBy', 'woNote']);
// Comparación sin importar el orden de los campos (null y sin valor cuentan igual)
const same = (a, b) => Rules.stable(a) === Rules.stable(b);
const fail = (res, code, error, extra) => res.status(code).json({ error, ...extra });

/**
 * Revisa el partido que envía el árbitro (next) contra el que hay en el servidor (cur).
 * t = categoría con el partido ya reemplazado (para calcular series y suspensiones). Devuelve el error o ''.
 */
function validate(t, cur, next, now) {
  const changed = [...new Set([...Object.keys(cur), ...Object.keys(next)])].filter((k) => !same(cur[k], next[k]));
  const bad = changed.filter((k) => !REF_FIELDS.has(k));
  if (bad.length) return `El árbitro no puede cambiar: ${bad.join(', ')}`;
  if (!cur.home || !cur.away) return 'Este partido aún no tiene sus dos equipos';
  if (!['pend', 'live', 'done'].includes(next.status)) return 'Estado no válido';
  const R = Rules.matchRules(t.config);
  const sides = [cur.home, cur.away];
  const team = (tid) => Rules.teamOf(t, tid);
  const isPlayer = (tid, pid) => !!(team(tid) && team(tid).players.some((p) => p.id === pid));
  const suspended = (tid) => new Set(Rules.suspendedIn(t, next, tid).map((x) => x.pid));

  // Estados: pendiente → en juego → finalizado (o pendiente → W.O.). Nunca hacia atrás.
  const flow = { pend: ['pend', 'live', 'done'], live: ['live', 'done'], done: ['done'] };
  if (!flow[cur.status || 'pend'].includes(next.status)) return 'Un partido no puede volver a un estado anterior (lo corrige un organizador)';

  // Presentación: solo jugadores del equipo y nunca un suspendido
  for (const tid of sides) {
    const pr = Rules.presentOf(next, tid);
    if (!pr) continue;
    if (pr.some((pid) => !isPlayer(tid, pid))) return 'La presentación tiene jugadores que no son del equipo';
    const sus = suspended(tid);
    const s = pr.find((pid) => sus.has(pid));
    if (s) return `${(Rules.playerOf(t, tid, s) || {}).name || 'Un jugador'} está suspendido y no puede estar en la presentación`;
  }
  // Iniciar: mínimo de jugadores presentes por equipo
  if ((cur.status || 'pend') === 'pend' && next.status === 'live') {
    const short = sides.filter((tid) => (Rules.presentOf(next, tid) || []).length < R.minStart);
    if (short.length) return `Para iniciar se necesitan al menos ${R.minStart} jugadores presentes (${short.map((x) => Rules.tname(t, x)).join(' y ')})`;
  }

  // W.O.: solo desde pendiente, pasada la espera (hora del servidor) y con el marcador reglamentario
  if (next.wo && !same(cur.wo, next.wo)) {
    if ((cur.status || 'pend') !== 'pend' || next.status !== 'done') return 'El W.O. solo se declara antes de iniciar el partido';
    if (![...sides, 'both'].includes(next.wo) || (next.wo === 'both' && cur.phase === 'ko')) return 'W.O. no válido';
    const at = Rules.schedAt(cur);
    if (at && now < at + R.waitMin * 60000) return `Aún no terminan los ${R.waitMin} minutos de espera`;
    const g = R.woGoals;
    const want = next.wo === 'both' ? [0, 0] : next.wo === cur.home ? [0, g] : [g, 0];
    if (next.hs !== want[0] || next.as !== want[1]) return `El W.O. es ${g}-0 para el equipo presente`;
    if ((next.goals || []).length) return 'Un W.O. no lleva goles';
    return '';
  }
  if (!next.wo && cur.wo) return 'Solo un organizador puede anular un W.O.';

  // Goles: del equipo del partido; los nuevos, de un jugador presente, no suspendido, con el partido en juego
  const curGoals = new Set((cur.goals || []).map((g) => g.id));
  for (const g of next.goals || []) {
    if (!sides.includes(g.team)) return 'Hay un gol de un equipo que no juega este partido';
    if (curGoals.has(g.id)) continue;
    if ((cur.status || 'pend') !== 'live') return 'Los goles se anotan con el partido en juego';
    if (g.pid) {
      if (!isPlayer(g.team, g.pid)) return 'Hay un gol de un jugador que no es del equipo';
      if (suspended(g.team).has(g.pid)) return `${g.player || 'El jugador'} está suspendido y no puede anotar`;
      const pr = Rules.presentOf(next, g.team);
      if (pr && !pr.includes(g.pid)) return `${g.player || 'El jugador'} no está marcado como presente`;
    }
  }
  // El marcador debe coincidir con los goles registrados
  const count = (tid) => (next.goals || []).filter((g) => g.team === tid).length;
  if (next.hs !== count(cur.home) || next.as !== count(cur.away)) return 'El marcador no coincide con los goles registrados';

  // Tarjetas: del partido, de un jugador del equipo; las nuevas, no a un suspendido y con el partido en juego
  const curCards = new Set((cur.cards || []).map((c) => c.id));
  for (const c of next.cards || []) {
    if (!sides.includes(c.team) || !['Y', 'R', 'W'].includes(c.type)) return 'Tarjeta no válida';
    if (curCards.has(c.id)) continue;
    if ((cur.status || 'pend') !== 'live') return 'Las tarjetas se registran con el partido en juego';
    if (!c.pid || !isPlayer(c.team, c.pid)) return 'Hay una tarjeta para un jugador que no es del equipo';
    if (suspended(c.team).has(c.pid)) return `${c.player || 'El jugador'} está suspendido`;
  }

  // Finalizar: la serie necesita la ida terminada; si hay que definir por penales, deben tener ganador
  if (next.status === 'done' && cur.status !== 'done') {
    if (next.tieOf) {
      const ida = Rules.mById(t, next.tieOf);
      if (!ida || ida.status !== 'done') return 'Primero debe finalizarse el partido de ida';
    }
    if (Rules.needsPens(t, next)) {
      const ok = Number.isInteger(next.ph) && Number.isInteger(next.pa) && next.ph >= 0 && next.pa >= 0 && next.ph !== next.pa;
      if (!ok) return 'Hay que definir por penales: faltan los penales o están empatados';
    } else if (next.ph != null || next.pa != null) return 'Este partido no se define por penales';
  }
  return '';
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return fail(res, 501, 'Base de datos no configurada');
  if (req.method !== 'POST') return fail(res, 405, 'Método no permitido');
  try {
    const s = await verifyRole(req);
    if (!s) return fail(res, 401, 'Debe ingresar con su usuario');
    const b = readBody(req);
    if (b.action !== 'save') return fail(res, 400, 'Acción no válida');
    const next = b.match;
    if (!next || typeof next !== 'object' || !next.id) return fail(res, 400, 'Partido no válido');
    if (JSON.stringify(next).length > 60000) return fail(res, 413, 'Datos demasiado grandes');

    // Reintentos: si otro guardó otra cosa del torneo al mismo tiempo, se vuelve a aplicar sobre lo nuevo
    for (let k = 0; k < 5; k++) {
      const { rev, data } = await readAll();
      const cat = data && data.torneos && data.torneos[b.tor] && data.torneos[b.tor].cats && data.torneos[b.tor].cats[b.cat];
      if (cat) Rules.normalizeCat(cat); // los mismos identificadores de jugador que calcula la app
      const i = cat ? cat.matches.findIndex((m) => m.id === next.id) : -1;
      if (i < 0) return fail(res, 404, 'El partido ya no existe');
      const cur = cat.matches[i];
      if (s.role !== 'admin') {
        if (cur.ref !== s.user) return fail(res, 403, 'Este partido no está asignado a usted');
        if (cur.status === 'done') return fail(res, 403, 'El partido ya fue finalizado: solo un organizador puede corregirlo');
      }
      // El partido cambió en el servidor desde que el árbitro lo vio: se le devuelve lo actual para combinar
      if (!same(cur, b.base)) return res.status(409).json({ rev, data, error: 'El partido cambió en otro teléfono' });
      const t = Object.assign({}, cat, { matches: cat.matches.slice() });
      t.matches[i] = next;
      const err = validate(t, cur, next, Date.now());
      if (err) return fail(res, 422, err);
      // Datos que pone el servidor: quién y cuándo declaró el W.O.
      if (next.wo && !same(cur.wo, next.wo)) { next.woBy = s.user; next.woAt = Date.now(); }
      cat.matches[i] = next;
      Rules.syncKO(cat); // el ganador pasa a la siguiente ronda de la llave
      const json = JSON.stringify(data);
      if (json.length > 900000) return fail(res, 413, 'Datos demasiado grandes');
      const w = await casWrite(rev, json, { at: Date.now(), by: s.user, role: s.role, match: next.id });
      if (w.ok) return res.status(200).json({ rev: w.rev, data });
    }
    return fail(res, 503, 'El sistema está ocupado, intente de nuevo');
  } catch (e) {
    return fail(res, 500, String((e && e.message) || e));
  }
};
module.exports.validate = validate;
