/* =========================================================
   Reglas del campeonato compartidas por la app (navegador) y el servidor (api/match.js).
   Es el mismo código en los dos lados: el servidor valida lo que envía un árbitro con
   exactamente las mismas reglas que el árbitro ve en su pantalla.
   Solo funciones puras: reciben la categoría (t = { teams, matches, config }) y no tocan la pantalla.
   ========================================================= */
(function (root) {
  'use strict';
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  /** Zona horaria del campeonato (El Salvador, sin horario de verano): la hora programada significa lo mismo en el servidor. */
  const TZ = '-06:00';

  /* ---- Equipos y jugadores ---- */
  const teamOf = (t, id) => ((t && t.teams) || []).find((x) => x.id === id) || null;
  const tname = (t, id) => (teamOf(t, id) || {}).name || 'Por definir';
  const playerOf = (t, teamId, pid) => { const tm = teamOf(t, teamId); return (tm && pid && tm.players.find((p) => p.id === pid)) || null; };
  /** Clave del jugador de un gol o tarjeta (identificador; los muy antiguos sin él, por nombre). */
  const evKey = (ev) => ev.pid || 'n:' + norm(ev.player);
  /** Nombre actual del jugador del gol o tarjeta, o el guardado si ya no está en el equipo. */
  const evName = (t, ev) => { const p = playerOf(t, ev.team, ev.pid); return p ? p.name : ev.player; };
  const mById = (t, id) => ((t && t.matches) || []).find((m) => m.id === id) || null;

  /* ---- Nombres parecidos (posible misma persona escrita de otra forma) ---- */
  const PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e']);
  /** Palabras que identifican a la persona: sin partículas ni iniciales. */
  const nameWords = (s) => norm(s).split(' ').filter((w) => w.length > 1 && !PARTICLES.has(w));
  /**
   * ¿Pueden ser la misma persona? Uno de los nombres está contenido en el otro, en el mismo orden y con al menos
   * nombre y apellido. Ej: "Ana Argueta" y "Ana Gabriela Argueta López", "David Gómez" y "David Antonio Gómez Vásquez".
   * El mismo nombre exacto (sin importar mayúsculas, tildes ni espacios) no cuenta aquí: eso ya es "el mismo nombre".
   */
  function similarNames(a, b) {
    if (norm(a) === norm(b)) return false;
    const x = nameWords(a), y = nameWords(b);
    const [s, l] = x.length <= y.length ? [x, y] : [y, x];
    if (s.length < 2) return false;
    let i = 0;
    for (const w of l) if (w === s[i]) i++;
    return i === s.length;
  }

  /* ---- Identificador fijo de cada jugador (calculado igual en todos los teléfonos y en el servidor) ---- */
  const hash36 = (s) => { let h = 5381; for (const ch of String(s)) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0; return h.toString(36); };
  /**
   * Se calcula del equipo y del nombre, así todos obtienen el mismo aunque los datos lleguen sin él (datos antiguos).
   * Una vez asignado no cambia, aunque se corrija el nombre: goles, tarjetas y suspensiones se guardan con él.
   */
  const pidFor = (teamId, name) => 'p' + hash36(teamId + '|' + norm(name));
  /** Asigna identificador a los jugadores que no lo tienen, sin repetir dentro del equipo. */
  function ensurePlayerIds(tm) {
    if (!tm || !Array.isArray(tm.players)) return;
    const used = new Set(tm.players.map((p) => p.id).filter(Boolean));
    for (const p of tm.players) {
      if (p.id) continue;
      const base = pidFor(tm.id, p.name);
      let id = base, k = 2;
      while (used.has(id)) id = `${base}-${k++}`; // dos personas con el mismo nombre en el equipo
      p.id = id; used.add(id);
    }
  }
  /** Identificador del jugador de un gol o tarjeta antiguo (solo tenía el nombre). Si ya no está en el equipo, uno estable. */
  function pidByName(t, teamId, name) {
    const tm = (t.teams || []).find((x) => x.id === teamId);
    const p = tm && tm.players.find((x) => norm(x.name) === norm(name));
    return p ? p.id : pidFor(teamId, name);
  }
  /**
   * Identificador para un jugador nuevo del equipo: nunca reutiliza el de otro jugador (ni el de uno que ya salió
   * y tiene goles o tarjetas), así quien entra empieza sin goles ni tarjetas.
   */
  function newPlayerId(t, teamId, name) {
    const tm = teamOf(t, teamId);
    const used = new Set(((tm && tm.players) || []).map((p) => p.id).filter(Boolean));
    for (const m of (t && t.matches) || []) for (const ev of [...(m.goals || []), ...(m.cards || [])]) if (ev.team === teamId && ev.pid) used.add(ev.pid);
    const base = pidFor(teamId, name);
    let id = base, k = 2;
    while (used.has(id)) id = `${base}-${k++}`;
    return id;
  }
  /** Completa los datos antiguos de una categoría: identificador de jugadores y de los goles y tarjetas. */
  function normalizeCat(t) {
    for (const tm of t.teams || []) ensurePlayerIds(tm);
    for (const m of t.matches || []) {
      for (const g of m.goals || []) if (g.player && !g.own && !g.pid) g.pid = pidByName(t, g.team, g.player);
      for (const cd of m.cards || []) if (cd.player && !cd.pid) cd.pid = pidByName(t, cd.team, cd.player);
    }
    return t;
  }
  /** Texto JSON con las claves ordenadas: para comparar dos copias sin importar el orden de los campos. */
  const stable = (o) => JSON.stringify(o === undefined ? null : o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((a, x) => { a[x] = v[x]; return a; }, {}) : v));

  /* ---- Sanciones (acuerdo del comité, editables por categoría) ----
     y2 = doble amarilla en el mismo partido · yr = amarilla + roja · r = roja directa · agg = roja con agresión
     (número de partidos o 'all' = todo el torneo) · yl = amarillas acumuladas en distintos partidos (0 = no aplica). */
  const SANC_DEF = { y2: 1, yr: 2, r: 3, agg: 'all', yl: 0 };
  const sancRules = (c) => Object.assign({}, SANC_DEF, (c && c.sanc) || {});
  const sancN = (v) => (v === 'all' ? Infinity : Math.max(0, Math.round(Number(v)) || 0));
  const sancText = (n) => (n === Infinity ? 'todo el torneo' : n === 0 ? 'sin suspensión' : `${n} partido${n > 1 ? 's' : ''}`);
  /** Clasifica las tarjetas de un jugador en un partido. Devuelve {why, n} según la regla (n = 0 si no suspende). */
  function cardSanction(cds, R) {
    const y = cds.filter((c) => c.type === 'Y').length;
    const direct = cds.filter((c) => c.type === 'R' && !c.auto);
    if (direct.some((c) => c.agg)) return { why: 'Roja con agresión', n: sancN(R.agg) };
    if (direct.length && y >= 1) return { why: 'Amarilla + roja', n: sancN(R.yr) };
    if (direct.length) return { why: 'Roja directa', n: sancN(R.r) };
    if (y >= 2) return { why: 'Doble amarilla', n: sancN(R.y2) };
    return { why: '', n: 0 };
  }
  /** Partidos de un equipo en orden de juego (calendario si todos tienen fecha; si no, orden de las jornadas). */
  function teamMatches(t, teamId) {
    const list = t.matches.map((m, i) => ({ m, i })).filter(({ m }) => m.home === teamId || m.away === teamId);
    if (list.length && list.every(({ m }) => m.date)) list.sort((a, b) => (a.m.date + (a.m.time || '')).localeCompare(b.m.date + (b.m.time || '')) || a.i - b.i);
    return list.map((x) => x.m);
  }
  /**
   * Todas las sanciones de los jugadores de un equipo, en orden de juego: por tarjetas (con el ajuste del comité
   * si lo hay), por amarillas acumuladas y sanciones directas del comité.
   * from = posición del partido en teamMatches; desde el siguiente partido jugado empieza a cumplirse.
   */
  function sanctionList(t, teamId) {
    const R = sancRules(t.config), list = teamMatches(t, teamId), out = [], yel = new Map();
    list.forEach((m, i) => {
      const vs = tname(t, m.home === teamId ? m.away : m.home);
      const by = new Map();
      for (const cd of m.cards || []) {
        if (cd.team !== teamId || (cd.type !== 'Y' && cd.type !== 'R')) continue; // la blanca no suspende
        const k = evKey(cd);
        if (!by.has(k)) by.set(k, []);
        by.get(k).push(cd);
      }
      for (const [k, cds] of by) {
        const base = cardSanction(cds, R), adj = (m.sancAdj || {})[k];
        if (base.n || adj) out.push({ kind: 'card', key: m.id + '|' + k, pid: k, player: evName(t, cds[0]), team: teamId, from: i, matchId: m.id, vs, why: base.why || 'Tarjetas', base: base.n, n: adj ? sancN(adj.n) : base.n, adj });
        // Amarillas acumuladas: solo cuentan las de partidos en que no fue expulsado
        if (R.yl > 0 && !cds.some((c) => c.type === 'R')) {
          const total = (yel.get(k) || 0) + cds.filter((c) => c.type === 'Y').length;
          if (Math.floor(total / R.yl) > Math.floor((yel.get(k) || 0) / R.yl)) out.push({ kind: 'acum', key: m.id + '|' + k + '|acum', pid: k, player: evName(t, cds[0]), team: teamId, from: i, matchId: m.id, vs, why: `${R.yl} amarillas acumuladas`, base: 1, n: 1 });
          yel.set(k, total);
        }
      }
      for (const e of m.sancExtra || []) {
        if (e.team === teamId) out.push({ kind: 'comite', key: e.id, pid: e.pid, player: (playerOf(t, teamId, e.pid) || {}).name || e.player, team: teamId, from: i, matchId: m.id, vs, why: 'Sanción del comité', base: sancN(e.n), n: sancN(e.n), extra: e });
      }
    });
    return out;
  }
  /** Partidos jugados (finalizados) por el equipo entre dos posiciones de su lista, sin incluirlas. */
  const playedBetween = (list, a, b) => { let n = 0; for (let j = a + 1; j < b; j++) if (list[j].status === 'done') n++; return n; };
  const sancReason = (s, left) => `${s.why} vs ${s.vs} (${sancText(s.n)})${s.n !== Infinity && left !== s.n ? ` · le falta${left > 1 ? 'n' : ''} ${left}` : ''}`;
  /**
   * Jugadores que no pueden jugar este partido: una sanción se cumple con los partidos que el equipo JUEGA
   * después del partido de la sanción (un partido aplazado no cuenta hasta que se juegue).
   * Devuelve [{pid, player, reason, left}].
   */
  function suspendedIn(t, match, teamId) {
    const list = teamMatches(t, teamId);
    const pos = list.findIndex((m) => m.id === match.id);
    if (pos <= 0) return [];
    const out = new Map();
    for (const s of sanctionList(t, teamId)) {
      if (s.from >= pos || !s.n) continue;
      const left = s.n - playedBetween(list, s.from, pos);
      if (left <= 0) continue;
      const cur = out.get(s.pid);
      if (!cur || left > cur.left) out.set(s.pid, { pid: s.pid, player: s.player, reason: sancReason(s, left), left });
    }
    return [...out.values()];
  }

  /* ---- Día de partido ---- */
  /** Reglas del partido de la categoría. halves: si nunca se configuró, un solo tiempo (datos anteriores). */
  function matchRules(c) {
    const r = Object.assign({ halves: 1, breakMin: 5, waitMin: 15, minStart: 3, whiteMin: 2, woGoals: 2 }, (c && c.match) || {});
    r.duration = c && c.duration;
    return r;
  }
  /** Hora programada en milisegundos, en la hora de El Salvador (igual en el teléfono y en el servidor). */
  const schedAt = (m) => (m.date && m.time ? Date.parse(`${m.date}T${m.time}:00${TZ}`) || 0 : 0);
  /** Jugadores presentes de un equipo (null = aún no se pasó lista). */
  const presentOf = (m, tid) => (m.present && Array.isArray(m.present[tid]) ? m.present[tid] : null);

  /* ---- Series de ida y vuelta por puntos (solo puntos; empate en puntos = penales en la vuelta) ---- */
  const legPts = (m, id) => (m.hs === m.as ? 1 : (m.hs > m.as) === (m.home === id) ? 3 : 0);
  /** Puntos de la serie con el marcador actual. vuelta = partido de vuelta (tiene tieOf = id del partido de ida). */
  function seriesPts(t, vuelta) {
    const ida = mById(t, vuelta.tieOf);
    if (!ida || !vuelta.home || !vuelta.away) return null;
    const a = vuelta.home, b = vuelta.away; // en la vuelta, local = visitante de la ida
    return { ida, a, b, pa: (ida.status === 'done' ? legPts(ida, a) : 0) + legPts(vuelta, a), pb: (ida.status === 'done' ? legPts(ida, b) : 0) + legPts(vuelta, b) };
  }
  /** ¿Este partido necesita penales para definirse? Único: empate. Vuelta de una serie: empate en puntos. */
  function needsPens(t, m) {
    if (m.phase !== 'ko' || m.tieLeg === 1) return false;
    if (!m.tieOf) return m.hs === m.as;
    const s = seriesPts(t, m);
    return !!s && s.ida.status === 'done' && s.pa === s.pb;
  }

  /* ---- Inscripción: plazos ---- */
  /**
   * ¿Ya terminó la primera vuelta? (todos los partidos de la 1ª vuelta finalizados). Con una sola vuelta,
   * la "primera vuelta" es toda la fase de grupos o liga. Antes del sorteo no ha terminado.
   */
  function firstLegDone(t) {
    const p1 = ((t && t.matches) || []).filter((m) => m.phase !== 'ko');
    if (!p1.length) return false;
    const l1 = p1.some((m) => m.leg) ? p1.filter((m) => m.leg === 1) : p1;
    return l1.length > 0 && l1.every((m) => m.status === 'done');
  }
  /**
   * Plazos de la categoría. regOpen: se pueden crear y enviar inscripciones de equipos.
   * chOpen: altas y bajas de jugadores (acuerdo: durante toda la primera vuelta).
   * cfg = { open, from (apertura), until (cierre de equipos), changesUntil (cierre de altas y bajas), changesLeg1 }.
   */
  function inscWindows(cfg, t, now) {
    const started = !cfg.from || now >= cfg.from;
    const regOpen = !!cfg.open && started && (!cfg.until || now <= cfg.until);
    let chOpen;
    if (cfg.changesLeg1) chOpen = !!cfg.open && started && !firstLegDone(t) && (!cfg.changesUntil || now <= cfg.changesUntil);
    else chOpen = regOpen || (!!cfg.open && started && !!cfg.changesUntil && now <= cfg.changesUntil);
    return { regOpen, chOpen, notYet: !!cfg.open && !started, leg1Done: firstLegDone(t) };
  }

  /* ---- Ganadores y llave de eliminación ---- */
  /**
   * Ganador del PARTIDO (para resultados y récords). En un partido de vuelta de una serie los penales son de la
   * serie, no del partido, así que aquí no cuentan: para avanzar en la llave se usa tieWinner().
   */
  function winner(m) {
    if (!m || m.status !== 'done') return null;
    if (m.hs > m.as) return m.home;
    if (m.as > m.hs) return m.away;
    if (!m.tieOf && m.ph != null && m.pa != null) {
      if (m.ph > m.pa) return m.home;
      if (m.pa > m.ph) return m.away;
    }
    return null;
  }
  function loser(m) {
    const w = winner(m);
    if (!w) return null;
    return w === m.home ? m.away : m.home;
  }
  /** Quién avanza en la llave: en una serie, por puntos y luego penales del partido de vuelta. */
  function tieWinner(t, m) {
    if (!m || !m.tieOf) return winner(m);
    if (m.status !== 'done') return null;
    const s = seriesPts(t, m);
    if (!s || s.ida.status !== 'done') return null;
    if (m.wo && m.wo !== 'both') return m.wo === m.home ? m.away : m.home; // no se presentó a la vuelta: pierde la serie
    if (s.pa !== s.pb) return s.pa > s.pb ? s.a : s.b;
    if (m.ph != null && m.pa != null && m.ph !== m.pa) return m.ph > m.pa ? m.home : m.away;
    return null;
  }
  function tieLoser(t, m) {
    const w = tieWinner(t, m);
    if (!w) return null;
    return w === m.home ? m.away : m.home;
  }
  function srcTeam(t, src) {
    if (!src) return null;
    if (src.t) return src.t;
    const m = mById(t, src.w || src.l);
    return src.w ? tieWinner(t, m) : tieLoser(t, m);
  }
  /** Deja un partido como nuevo (cuando cambian sus equipos en la llave). */
  function resetMatch(m) {
    Object.assign(m, { hs: 0, as: 0, ph: null, pa: null, status: 'pend', elapsed: 0, runAt: null, alerted: false, alertedAdd: false, added: 0, cards: [], goals: [], sancAdj: {}, sancExtra: [],
      present: null, startedWith: null, startedAt: null, period: 1, h1: null, breakAt: null, shoot: [], penMiss: [], wo: null, woAt: null, woBy: null, woNote: '' });
  }
  /** Actualiza los equipos de la llave según los resultados. */
  function syncKO(t) {
    for (const m of t.matches) {
      if (m.phase !== 'ko') continue;
      const h = srcTeam(t, m.srcH), a = srcTeam(t, m.srcA);
      if (m.home !== h || m.away !== a) {
        if (m.status !== 'pend') resetMatch(m);
        m.home = h; m.away = a;
      }
    }
  }

  const api = {
    TZ, norm, nameWords, similarNames, teamOf, tname, playerOf, evKey, evName, mById, hash36, pidFor, ensurePlayerIds, pidByName, newPlayerId, normalizeCat, stable,
    SANC_DEF, sancRules, sancN, sancText, cardSanction, teamMatches, sanctionList, playedBetween, sancReason, suspendedIn,
    matchRules, schedAt, presentOf, legPts, seriesPts, needsPens,
    winner, loser, tieWinner, tieLoser, srcTeam, resetMatch, syncKO, firstLegDone, inscWindows,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Rules = api;
})(typeof window !== 'undefined' ? window : this);
