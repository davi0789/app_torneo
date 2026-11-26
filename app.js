'use strict';
/* =========================================================
   Torneo de Fútbol — app local (PWA). Datos en localStorage.
   ========================================================= */
const KEY = 'torneo-futbol-v1';
const PALETTES = 6; // colores disponibles para categorías
const catName = (k) => (CATS_()[k] && CATS_()[k].name) || 'Categoría';
const totalTeams = (d) => Object.values(d.torneos || {}).reduce((a, tor) => a + Object.values(tor.cats || {}).reduce((b, t) => b + ((t && t.teams) || []).length, 0), 0);

const $ = (s) => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
/** Huella corta y estable de un texto (igual en todos los teléfonos). */
// Identificador fijo de cada jugador (rules.js: calculado igual en todos los teléfonos y en el servidor)
const hash36 = Rules.hash36;
const pidFor = Rules.pidFor;
const ensurePlayerIds = Rules.ensurePlayerIds;
/**
 * Enlaza la lista nueva de un equipo con la anterior: el mismo nombre conserva su identificador.
 * Devuelve los jugadores cuya fila tenía a otro jugador (nombre cambiado): queda a decisión si es corrección.
 */
function matchPlayerIds(players, old) {
  const claimed = new Set();
  for (const p of players) {
    const o = old.find((x) => !claimed.has(x.id) && norm(x.name) === norm(p.name));
    if (o) { p.id = o.id; claimed.add(o.id); }
  }
  const renamed = [];
  for (const p of players) {
    if (p.id || !p.rowPid || claimed.has(p.rowPid)) continue;
    const o = old.find((x) => x.id === p.rowPid);
    if (o) { p.oldName = o.name; claimed.add(o.id); renamed.push(p); }
  }
  return renamed;
}
/**
 * Asigna identificador a los jugadores nuevos. Nunca reutiliza el de un jugador anterior del equipo
 * (aunque se llame igual que alguien dado de baja): así un jugador nuevo empieza sin goles ni tarjetas.
 */
function assignPlayerIds(teamId, players, old = [], t = T()) {
  const used = new Set([...old, ...players].map((p) => p.id).filter(Boolean));
  // También los de jugadores que ya no están pero tienen goles o tarjetas registrados
  for (const m of (t && t.matches) || []) for (const ev of [...(m.goals || []), ...(m.cards || [])]) if (ev.team === teamId && ev.pid) used.add(ev.pid);
  for (const p of players) {
    if (p.id) continue;
    const base = pidFor(teamId, p.name);
    let id = base, k = 2;
    while (used.has(id)) id = `${base}-${k++}`;
    p.id = id; used.add(id);
  }
}
const pidByName = Rules.pidByName;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + (Number(n) || 0).toLocaleString('es', { maximumFractionDigits: 2 });
/** Número aleatorio 0..n-1 usando el generador criptográfico del navegador (sin sesgo). */
function randInt(n) {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = new Uint32Array(1), lim = Math.floor(0x100000000 / n) * n;
    let x; do { crypto.getRandomValues(buf); x = buf[0]; } while (x >= lim);
    return x % n;
  }
  return Math.floor(Math.random() * n);
}
/** Mezcla de Fisher-Yates: todas las combinaciones tienen la misma probabilidad. */
const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const num = (v, d = 0) => { const n = parseFloat(v); return isNaN(n) ? d : n; };

function newTournament(name = '', color = 0) {
  return {
    name, color,
    config: {
      fee: 0, duration: 20,
      tiebreak: 'h2h',     // h2h = enfrentamiento directo primero | dg = diferencia de goles primero
      // sanc: reglas de suspensión (ver SANC_DEF); si falta, se usa el acuerdo del comité
      format: 'liga',      // liga | grupos | elim
      ligaFinal: 0,        // 0 = gana la tabla, 2 = final, 4 = semifinales
      groupSize: 4, perGroup: 2,
      koPairing: 'cruzado', // cruzado = 1° vs 2° de otro grupo | sorteo = cruces sorteados | ranking = mejor vs peor
      podium: 3,           // 1, 2 o 3 lugares
    },
    teams: [],
    stage: 'inscripcion',  // inscripcion | fase1 | final
    groups: [],
    matches: [],
  };
}

/** Categorías del Campeonato de Futbolito Perquín 2026: [clave, nombre, color, cómo reconocerla]. */
const CHAMP_CATS = [['F', 'Futbolito Femenino', 1, /femen/], ['J', 'Futbolito Juvenil', 2, /juven/], ['L', 'Futbolito Libre', 0, /libre|mascul/]];
/** Configuración general del torneo (aplica a todos los equipos). */
/** starters = titulares en cancha (solo para ordenar la lista). El mínimo y máximo de jugadores es de cada categoría (inscOf). */
const defaultTorConfig = () => ({ starters: 5 });
function newTorneo(name, catsFrom) {
  const cats = {};
  if (catsFrom) Object.entries(catsFrom).forEach(([k, t]) => { cats[k] = newTournament(t.name, t.color); cats[k].config = Object.assign(clone(t.config), {}); });
  else CHAMP_CATS.forEach(([k, n, c]) => { cats[k] = newTournament(n, c); });
  return { name, createdAt: Date.now(), config: defaultTorConfig(), cats, rules: '' };
}

/** Valida los datos, migra el formato antiguo ({cats}) y completa valores faltantes. */
function normalizeData(d) {
  if (!d || typeof d !== 'object') return null;
  if (!d.torneos && d.cats && typeof d.cats === 'object') {
    const m = Object.values(d.cats)[0] || {};
    const oc = m.config || {};
    d.torneos = { t1: { name: 'Mi Torneo', createdAt: 0, config: { starters: 8, subs: Math.max(0, (oc.maxPlayers || 12) - 8), minPlayers: oc.minPlayers || 8 }, cats: d.cats } };
    delete d.cats;
  }
  if (!d.torneos || typeof d.torneos !== 'object') return null;
  const defaults = { M: ['Masculino', 0], F: ['Femenino', 1] };
  for (const [tid, tor] of Object.entries(d.torneos)) {
    if (!tor || !tor.cats || typeof tor.cats !== 'object') { delete d.torneos[tid]; continue; }
    if (!tor.name) tor.name = 'Mi Torneo';
    if (tor.createdAt == null) tor.createdAt = 0;
    tor.config = Object.assign(defaultTorConfig(), tor.config || {});
    // Configuración antigua sin tocar (8 titulares + 4 suplentes, mínimo 8): ya no aplica con equipos de 5 a 8
    if (tor.config.starters === 8 && tor.config.subs === 4 && tor.config.minPlayers === 8) tor.config.starters = 5;
    Object.keys(tor.cats).forEach((k, i) => {
      const t = tor.cats[k];
      if (!t || !Array.isArray(t.teams) || !Array.isArray(t.matches)) { delete tor.cats[k]; return; }
      if (!t.name) t.name = defaults[k] ? defaults[k][0] : 'Categoría ' + (i + 1);
      if (t.color == null) t.color = defaults[k] ? defaults[k][1] : i % PALETTES;
      // Jugadores con identificador fijo; goles y tarjetas antiguos (solo con nombre) se enlazan a ese identificador
      Rules.normalizeCat(t);
    });
    if (!Object.keys(tor.cats).length) tor.cats.M = newTournament('General', 0);
  }
  return Object.keys(d.torneos).length ? d : null;
}
/** Torneo que se muestra por defecto: el más reciente. */
const latestTorneo = (d) => Object.keys(d.torneos).sort((a, b) => (d.torneos[b].createdAt || 0) - (d.torneos[a].createdAt || 0))[0];
function fixSelection(d) {
  if (!d.torneos[d.tor]) d.tor = latestTorneo(d);
  const cats = d.torneos[d.tor].cats;
  if (!cats[d.cat]) d.cat = Object.keys(cats)[0];
}
function load() {
  try {
    const d = normalizeData(JSON.parse(localStorage.getItem(KEY)));
    if (d) { fixSelection(d); return d; }
  } catch (e) { /* sin datos */ }
  const d = { torneos: { t1: newTorneo('Mi Torneo') }, tab: 'inicio', view: 'cal' };
  d.torneos.t1.createdAt = 0;
  fixSelection(d);
  return d;
}
const clone = (o) => JSON.parse(JSON.stringify(o));
let S = load();

/* Estado de sincronización con la base de datos en línea */
const SYNC_KEY = 'torneo-sync-v1';
const AUTH_KEY = 'torneo-auth';
const sync = { mode: 'init', rev: 0, base: null, dirty: false, known: false, needSetup: false, last: 0, pushing: false, timer: null, pendingRender: false };
try {
  const d = JSON.parse(localStorage.getItem(SYNC_KEY));
  if (d) Object.assign(sync, { rev: d.rev || 0, base: d.base ? normalizeData(d.base) : null, dirty: !!d.dirty, known: true });
} catch (e) { /* nada */ }

/* Sesión de organizador. Sin sesión = vista pública (solo lectura). */
let auth = null;
try { auth = JSON.parse(localStorage.getItem(AUTH_KEY)); } catch (e) { /* nada */ }
let orgs = null; // lista de organizadores (se carga en Ajustes)
/** Organizador: todo. Sin base de datos (este teléfono solo) también es organizador. */
const isAdmin = () => sync.mode === 'local' || !!(auth && auth.token && auth.role !== 'arbitro');
/** Árbitro: solo maneja los partidos que le asignan (marcador, tarjetas, presentación, tiempos, W.O.). */
const isRef = () => sync.mode !== 'local' && !!(auth && auth.token && auth.role === 'arbitro');
const isMyMatch = (m) => !!(m && isRef() && m.ref === auth.user);
/** ¿Puede anotar en este partido? Organizador siempre; árbitro solo en su partido y mientras no esté finalizado. */
const canEditMatch = (m) => !!m && (isAdmin() || (isMyMatch(m) && m.status !== 'done'));
const signedIn = () => isAdmin() || isRef();
// El acceso de organizadores solo se muestra entrando por /admin (o ?admin)
// Entrada fija de capitanes (sin botón público): /capitan → ingreso con código de equipo y clave
const CAP_URL = /\/capitan\/?$/.test(location.pathname);
const ADMIN_URL = /\/admin\/?$/.test(location.pathname) || /(^|[?&#])admin(\b|$)/.test(location.search + location.hash);
const showAccess = () => signedIn() || ADMIN_URL;
function setAuth(a) {
  auth = a;
  try { if (a) localStorage.setItem(AUTH_KEY, JSON.stringify(a)); else localStorage.removeItem(AUTH_KEY); } catch (e) { /* nada */ }
}

function saveLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('⚠️ No se pudo guardar'); }
}
function save() {
  saveLocal();
  if (sync.mode !== 'local' && signedIn()) {
    sync.dirty = JSON.stringify(payload()) !== JSON.stringify(sync.base);
    saveSync();
    if (sync.dirty) schedulePush();
  }
}

let modal = null;      // { type: 'team'|'match', id }
let tick = null;
let installEvt = null;

const TOR = () => S.torneos[S.tor];
const CATS_ = () => TOR().cats;
const TC = () => TOR().config;
const T = () => CATS_()[S.cat];
/** Escudo pequeño + nombre, o avatar con inicial si el equipo no tiene escudo. */
function teamBadge(tm, size = 40) {
  if (tm && tm.crest) { const h = crestHTML(tm.crest, tm.name, size); if (h) return `<span class="tcrest" style="width:${size}px;height:${size}px">${h}</span>`; }
  return `<div class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px">${esc(((tm && tm.name) || '?').slice(0, 1).toUpperCase())}</div>`;
}
const miniCrest = (id) => { const tm = teamById(id); return tm && tm.crest ? `<span class="mcrest">${crestHTML(tm.crest, tm.name, 22)}</span>` : ''; };
const teamById = (id) => T().teams.find((x) => x.id === id);
const tname = (id) => (teamById(id) || {}).name || 'Por definir';
const mById = (id, t = T()) => t.matches.find((m) => m.id === id);
/** Jugador de un equipo por su identificador. */
const playerById = (teamId, pid) => { const tm = teamById(teamId); return (tm && pid && tm.players.find((p) => p.id === pid)) || null; };
/** Clave del jugador de un gol o tarjeta (identificador; los muy antiguos sin él, por nombre). */
const evKey = (ev) => ev.pid || 'n:' + norm(ev.player);
/** Nombre para mostrar: el actual del jugador (si se corrigió, se ve corregido) o el que quedó guardado si ya no está en el equipo. */
const evName = (ev) => { const p = playerById(ev.team, ev.pid); return p ? p.name : ev.player; };

/* ---------------- Ventanas propias (reemplazan confirm/prompt del navegador) ---------------- */
// En pruebas automáticas se usan respuestas inmediatas (sin interfaz).
const SYNC_DIALOGS = typeof __nativeDialogs !== 'undefined';
const now = (v) => ({ then: (f) => now(f ? f(v) : v) });
function openDialog({ title, message, input, options, okText = 'Aceptar', cancelText = 'Cancelar', danger, placeholder, value, type }) {
  return new Promise((resolve) => {
    let el = document.getElementById('dialog');
    if (!el) { el = document.createElement('div'); el.id = 'dialog'; el.className = 'dialog'; document.body.appendChild(el); }
    const msg = message ? `<div class="dlg-msg">${esc(message).replace(/\n/g, '<br>')}</div>` : '';
    const btns = options
      ? options.map((o, i) => `<button class="btn ${o.style || ''}" data-dlg="${i}">${esc(o.label)}</button>`).join('') + `<button class="btn ghost" data-dlg="x">${esc(cancelText)}</button>`
      : `<button class="btn ghost" data-dlg="x">${esc(cancelText)}</button><button class="btn ${danger ? 'danger-solid' : ''}" data-dlg="ok">${esc(okText)}</button>`;
    el.innerHTML = `<div class="dlg" role="dialog" aria-modal="true">
      ${title ? `<h2>${esc(title)}</h2>` : ''}${msg}
      ${input ? `<input id="dlg-in" type="${type || 'text'}" placeholder="${esc(placeholder || '')}" value="${esc(value || '')}" autocomplete="off" autocapitalize="characters">` : ''}
      <div class="dlg-btns ${options ? 'col' : ''}">${btns}</div></div>`;
    el.hidden = false;
    const inp = el.querySelector('#dlg-in');
    setTimeout(() => (inp || el.querySelector('[data-dlg="ok"]') || el.querySelector('[data-dlg]')).focus(), 60);
    const done = (v) => { el.hidden = true; el.innerHTML = ''; document.removeEventListener('keydown', key, true); resolve(v); };
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
      else if (e.key === 'Enter' && !options) { e.preventDefault(); e.stopPropagation(); done(input ? inp.value : true); }
    };
    document.addEventListener('keydown', key, true);
    el.onclick = (e) => {
      e.stopPropagation();
      const b = e.target.closest('[data-dlg]');
      if (!b) { if (e.target === el) done(null); return; }
      const k = b.dataset.dlg;
      if (k === 'x') done(null);
      else if (k === 'ok') done(input ? inp.value : true);
      else done(options[+k].value);
    };
  });
}
/** Confirmación Sí/No. Devuelve true/false. */
function ask(message, o = {}) {
  if (SYNC_DIALOGS) return now(!!confirm(message));
  return openDialog({ title: o.title || '¿Confirmar?', message, okText: o.ok || 'Aceptar', cancelText: o.cancel, danger: o.danger }).then((v) => !!v);
}
/** Pide un texto. Devuelve el texto o null. */
function askText(message, o = {}) {
  if (SYNC_DIALOGS) return now(prompt(message, o.value));
  return openDialog({ title: o.title, message, input: true, placeholder: o.placeholder, value: o.value, type: o.type, okText: o.ok || 'Aceptar', danger: o.danger });
}
/** Elegir entre varias opciones [{key,label,value,style}]. Devuelve value o null. */
function askChoice(message, options, o = {}) {
  if (SYNC_DIALOGS) { const a = (prompt(message) || '').trim().toUpperCase(); const x = options.find((op) => op.key === a); return now(x ? x.value : null); }
  return openDialog({ title: o.title, message, options, cancelText: o.cancel || 'Cancelar' });
}
/** Acción peligrosa: hay que escribir la palabra (BORRAR). Devuelve true/false. */
function askWord(message, o = {}) {
  const word = o.word || 'BORRAR';
  return askText(message + (SYNC_DIALOGS ? '' : `\n\nEscriba ${word} para confirmar.`), { title: o.title || '⚠️ Acción irreversible', placeholder: word, ok: o.ok || 'Confirmar', danger: true })
    .then((v) => (v || '').trim().toUpperCase() === word);
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ---------------- Jugadores únicos ---------------- */
function playerIndex(exceptTeamId) {
  const map = new Map();
  for (const k of Object.keys(CATS_())) {
    for (const tm of CATS_()[k].teams) {
      if (tm.id === exceptTeamId) continue;
      for (const p of tm.players) map.set(norm(p.name), `${tm.name} (${catName(k)})`);
    }
  }
  // Inscripciones en línea aún no aprobadas (solo las ve el organizador)
  for (const r of inscList || []) {
    if (r.tor !== S.tor || r.status === 'rechazada' || (exceptTeamId && r.teamId === exceptTeamId)) continue;
    for (const p of r.players) if (!map.has(norm(p.name))) map.set(norm(p.name), `la inscripción de ${r.name} (${catName(r.cat)})`);
  }
  return map;
}
/** Jugadores dados de baja en este torneo: quedan intransferibles. */
const banOf = (n) => inscBans.find((b) => b.tor === S.tor && norm(b.name) === n);

/* ---------------- Partidos ---------------- */
function mkMatch(o) {
  return Object.assign({
    id: uid(), phase: '', group: '', round: 1, ko: '', label: '',
    home: null, away: null, srcH: null, srcA: null,
    hs: 0, as: 0, ph: null, pa: null,
    goals: [],
    status: 'pend', duration: T().config.duration, added: 0, elapsed: 0, runAt: null, alerted: false, alertedAdd: false,
    cards: [],
  }, o);
}

// Ganadores (rules.js, compartido con el servidor)
const winner = Rules.winner;
const loser = Rules.loser;

/* ---- Series de ida y vuelta por puntos (liguilla): solo cuentan los puntos, no los goles ---- */
// Reglas compartidas con el servidor (rules.js): series por puntos y penales
const legPts = Rules.legPts;
const seriesPts = (vuelta, t = T()) => Rules.seriesPts(t, vuelta);
const needsPens = (m, t = T()) => Rules.needsPens(t, m);
const tieWinner = (m, t = T()) => Rules.tieWinner(t, m);
const tieLoser = (m, t = T()) => Rules.tieLoser(t, m);
/** Penales que se muestran: los del partido único empatado o los de la serie (en el partido de vuelta). */
const pensShown = (m) => m.ph != null && m.pa != null && (m.tieOf || m.hs === m.as);
/** Partido que define (para podio y fase): el único o el de vuelta. */
const isDecider = (m) => m.tieLeg !== 1;

function roundRobin(ids, phase, group) {
  const a = [...ids];
  if (a.length % 2) a.push(null);
  const n = a.length;
  const out = [];
  for (let r = 0; r < n - 1; r++) {
    for (let i = 0; i < n / 2; i++) {
      const x = a[i], y = a[n - 1 - i];
      if (x && y) {
        const flip = r % 2 === 1 && i === 0;
        out.push(mkMatch({ phase, group, round: r + 1, home: flip ? y : x, away: flip ? x : y }));
      }
    }
    a.splice(1, 0, a.pop());
  }
  return out;
}
/**
 * Dos vueltas: la segunda repite los cruces de la primera con local y visitante invertidos.
 * Empieza cuando termina la primera vuelta de TODOS los grupos (jornadas siguientes a la última de la 1ª vuelta).
 */
function withSecondLeg(matches) {
  const R = Math.max(0, ...matches.map((m) => m.round));
  matches.forEach((m) => { m.leg = 1; });
  return matches.concat(matches.map((m) => mkMatch({ phase: m.phase, group: m.group, round: m.round + R, leg: 2, home: m.away, away: m.home })));
}
const legsOf = (c) => (c.format === 'liga' || c.format === 'grupos') && Number(c.legs) === 2 ? 2 : 1;
const koLegsOf = (c) => (Number(c.koLegs) === 2 ? 2 : 1);
/** Cantidad de grupos: la elegida (p. ej. 2, acuerdo del comité) o automática según "equipos por grupo". */
const ngOf = (c, n) => (Number(c.nGroups) > 0 ? Math.max(1, Math.min(Number(c.nGroups), Math.floor(n / 2))) : groupCount(n, c.groupSize));

function bracketOrder(P) {
  let arr = [1, 2];
  while (arr.length < P) {
    const len = arr.length * 2 + 1;
    arr = arr.flatMap((s) => [s, len - s]);
  }
  return arr.slice(0, P);
}
const roundName = (slots) => ({ 2: 'Final', 4: 'Semifinal', 8: 'Cuartos de final', 16: 'Octavos de final', 32: 'Dieciseisavos' }[slots] || `Ronda de ${slots}`);

/** Crea la llave de eliminación. seeds = ids de equipos ordenados por siembra. */
function buildKO(seeds, groupOf, slots) {
  const t = T();
  const n = slots ? slots.filter(Boolean).length : seeds.length;
  if (n < 2) return;
  let P = 1; while (P < n) P *= 2;
  let prev = slots ? slots.map((id) => (id ? { t: id } : null)) : bracketOrder(P).map((s) => (s <= n ? { t: seeds[s - 1] } : null));
  if (slots) groupOf = null; // los cruces sorteados ya evitan el mismo grupo
  // Evitar que dos equipos del mismo grupo se crucen en la primera ronda
  if (groupOf) {
    const G = (x) => x && groupOf[x.t];
    for (let i = 0; i < prev.length; i += 2) {
      const a = prev[i], b = prev[i + 1];
      if (!a || !b || G(a) !== G(b)) continue;
      for (let j = 0; j < prev.length; j += 2) {
        const c = prev[j], d = prev[j + 1];
        if (j === i || !c || !d) continue;
        if (G(a) !== G(d) && G(c) !== G(b)) { prev[i + 1] = d; prev[j + 1] = b; break; }
      }
    }
  }
  // Ida y vuelta (liguilla por puntos): cada cruce son 2 partidos; avanza quien sume más puntos y,
  // si empatan en puntos, se define por penales al final de la vuelta. La llave sigue al partido de vuelta.
  const legs = koLegsOf(t.config);
  const tie = (o) => {
    if (legs === 1) { const m = mkMatch(o); return { list: [m], id: m.id }; }
    const ida = mkMatch(Object.assign({}, o, { tieLeg: 1 }));
    const vuelta = mkMatch(Object.assign({}, o, { tieLeg: 2, tieOf: ida.id, srcH: o.srcA, srcA: o.srcH }));
    return { list: [ida, vuelta], id: vuelta.id };
  };
  let round = 1;
  while (prev.length > 1) {
    const name = roundName(prev.length);
    const pairs = prev.length / 2;
    const next = [];
    let k = 0;
    const created = [];
    for (let i = 0; i < prev.length; i += 2) {
      const a = prev[i], b = prev[i + 1];
      if (a && b) {
        k++;
        const x = tie({
          phase: 'ko', round, ko: prev.length === 2 ? 'final' : (prev.length === 4 ? 'semi' : 'ko'),
          label: pairs > 1 ? `${name} ${k}` : name, srcH: a, srcA: b,
        });
        created.push(...x.list);
        next.push({ w: x.id });
      } else {
        next.push(a || b); // pasa directo (bye)
      }
    }
    t.matches.push(...created);
    if (prev.length === 4 && t.config.podium >= 3 && next[0] && next[0].w && next[1] && next[1].w) {
      t.matches.push(...tie({ phase: 'ko', round: round + 1, ko: 'third', label: 'Tercer lugar', srcH: { l: next[0].w }, srcA: { l: next[1].w } }).list);
    }
    prev = next;
    round++;
  }
  syncKO();
}

const srcTeam = (src, t = T()) => Rules.srcTeam(t, src);
function srcLabel(src) {
  if (!src) return 'Por definir';
  if (src.t) return tname(src.t);
  const m = mById(src.w || src.l);
  return (src.w ? 'Ganador ' : 'Perdedor ') + (m ? m.label : '');
}
const resetMatch = Rules.resetMatch;
/** Actualiza los equipos de la llave según los resultados (rules.js; el servidor hace lo mismo). */
const syncKO = (t = T()) => Rules.syncKO(t);

/* ---------------- Tabla de posiciones ---------------- */
function standings(ids, phase, group) {
  const rows = new Map(ids.map((id) => [id, { id, pj: 0, pg: 0, pe: 0, pp: 0, gf: 0, gc: 0, pts: 0, ta: 0, tr: 0 }]));
  for (const m of T().matches) {
    if (m.phase !== phase || m.group !== group) continue;
    for (const c of m.cards) {
      const r = rows.get(c.team);
      if (r) { if (c.type === 'Y') r.ta++; else if (c.type === 'R') r.tr++; } // la blanca no cuenta
    }
    if (m.status !== 'done') continue;
    const h = rows.get(m.home), a = rows.get(m.away);
    if (!h || !a) continue;
    h.pj++; a.pj++;
    if (m.wo === 'both') { h.pp++; a.pp++; continue; } // no se presentó ninguno: ambos pierden
    h.gf += m.hs; h.gc += m.as; a.gf += m.as; a.gc += m.hs;
    if (m.hs > m.as) { h.pg++; a.pp++; h.pts += 3; }
    else if (m.hs < m.as) { a.pg++; h.pp++; a.pts += 3; }
    else { h.pe++; a.pe++; h.pts++; a.pts++; }
  }
  const tb = T().config.tiebreak || 'h2h';
  const general = (x, y) => (y.gf - y.gc) - (x.gf - x.gc) || y.gf - x.gf;
  const ov = T().tieOverride || {};
  const manual = (x, y) => { const w = ov[[x.id, y.id].sort().join('|')]; return w ? (w === x.id ? -1 : 1) : 0; };
  const tail = (x, y) => (x.ta + 3 * x.tr) - (y.ta + 3 * y.tr) || manual(x, y) || tname(x.id).localeCompare(tname(y.id));
  const all = [...rows.values()].sort((x, y) => y.pts - x.pts);
  // Ordenar cada bloque de equipos empatados en puntos
  const out = [];
  for (let i = 0; i < all.length;) {
    let j = i; while (j < all.length && all[j].pts === all[i].pts) j++;
    const block = all.slice(i, j);
    if (block.length > 1 && tb === 'h2h') {
      const ids = new Set(block.map((r) => r.id));
      const mini = new Map(block.map((r) => [r.id, { pts: 0, dg: 0, gf: 0 }]));
      for (const m of T().matches) {
        if (m.phase !== phase || m.group !== group || m.status !== 'done' || !ids.has(m.home) || !ids.has(m.away)) continue;
        const h = mini.get(m.home), a = mini.get(m.away);
        h.gf += m.hs; a.gf += m.as; h.dg += m.hs - m.as; a.dg += m.as - m.hs;
        if (m.hs > m.as) h.pts += 3; else if (m.hs < m.as) a.pts += 3; else { h.pts++; a.pts++; }
      }
      block.forEach((r) => { r.h2h = mini.get(r.id); });
      block.sort((x, y) => y.h2h.pts - x.h2h.pts || y.h2h.dg - x.h2h.dg || y.h2h.gf - x.h2h.gf || general(x, y) || tail(x, y));
    } else {
      block.sort((x, y) => general(x, y) || tail(x, y));
    }
    out.push(...block); i = j;
  }
  return out;
}

/** Qué criterio separó a dos equipos consecutivos de la tabla. */
function decidedBy(x, y) {
  if (x.pts !== y.pts) return 'puntos';
  const ov = (T().tieOverride || {})[[x.id, y.id].sort().join('|')];
  if (ov) { const rest = decidedBy(Object.assign({}, x, { id: '_' }), Object.assign({}, y, { id: '__' })); if (rest === 'empate total') return 'decisión del organizador'; }
  if (x.h2h && y.h2h && (x.h2h.pts !== y.h2h.pts || x.h2h.dg !== y.h2h.dg || x.h2h.gf !== y.h2h.gf)) return 'enfrentamiento directo';
  if ((x.gf - x.gc) !== (y.gf - y.gc)) return 'diferencia de goles';
  if (x.gf !== y.gf) return 'goles a favor';
  if ((x.ta + 3 * x.tr) !== (y.ta + 3 * y.tr)) return 'juego limpio (menos tarjetas)';
  return 'empate total';
}

/* ============ Suspensiones (roja y amarillas acumuladas) ============ */
// Reglas compartidas con el servidor (rules.js): el árbitro ve y el servidor valida exactamente lo mismo
const teamMatches = (teamId, t = T()) => Rules.teamMatches(t, teamId);
const SANC_DEF = Rules.SANC_DEF;
const sancRules = (c = T().config) => Rules.sancRules(c);
const sancN = Rules.sancN;
const sancText = Rules.sancText;
const cardSanction = Rules.cardSanction;
const sanctionList = (teamId, t = T()) => Rules.sanctionList(t, teamId);
const playedBetween = Rules.playedBetween;
const sancReason = Rules.sancReason;
/** Jugadores que no pueden jugar este partido: [{pid, player, reason, left}] (ver rules.js). */
const suspendedIn = (match, teamId, t = T()) => Rules.suspendedIn(t, match, teamId);
/** Próximo partido pendiente del equipo en el que un jugador está suspendido (para la ficha). */
function nextSuspension(teamId, pid) {
  const next = teamMatches(teamId).find((m) => m.status !== 'done');
  if (!next) return null;
  const s = suspendedIn(next, teamId).find((x) => x.pid === pid);
  return s ? { match: next, reason: s.reason, left: s.left } : null;
}
/** Sanciones que todavía no se terminan de cumplir (para la tabla pública). */
function activeSanctions(t = T()) {
  const out = [];
  for (const tm of t.teams) {
    const list = teamMatches(tm.id, t);
    for (const s of sanctionList(tm.id, t)) {
      if (!s.n) continue;
      const left = s.n - playedBetween(list, s.from, list.length);
      if (left > 0) out.push({ ...s, left });
    }
  }
  return out.sort((a, b) => b.left - a.left || a.player.localeCompare(b.player));
}

/* ============ Goleadores ============ */
function scorers(t = T()) {
  const map = new Map();
  for (const m of t.matches) for (const g of m.goals || []) {
    if (!g.player || g.own) continue;
    // Por identificador: el jugador dado de baja conserva sus goles y quien entre con su número empieza en 0
    const k = g.team + '|' + evKey(g);
    const r = map.get(k) || { team: g.team, pid: evKey(g), player: evName(g), gone: !playerById(g.team, g.pid), n: 0 };
    r.n++; map.set(k, r);
  }
  return [...map.values()].sort((a, b) => b.n - a.n || a.player.localeCompare(b.player));
}
function scorersHTML(limit) {
  const rows = scorers();
  if (!rows.length) return '<p class="muted">Aún no hay goles con jugador registrado.</p>';
  const list = limit ? rows.slice(0, limit) : rows;
  return `<div class="tbl-wrap"><table><tr><th>#</th><th class="tn">Jugador</th><th class="tn">Equipo</th><th>⚽</th></tr>
    ${list.map((r, i) => `<tr><td>${i === 0 ? '🥇' : i + 1}</td><td class="tn"><b>${esc(r.player)}</b>${r.gone ? ' <small class="muted">(ya no está en el equipo)</small>' : ''}</td><td class="tn">${miniCrest(r.team)}${esc(tname(r.team))}</td><td class="pts">${r.n}</td></tr>`).join('')}</table></div>`;
}

/** "Todos contra todos" y "Partidos a elección" comparten tabla, fase final y podio. */
const ligaLike = (c) => c.format === 'liga' || c.format === 'manual';
const phase1 = () => T().matches.filter((m) => m.phase !== 'ko');
const phase1Done = () => {
  const t = T(), p = phase1();
  if (t.config.format === 'manual' && !t.manualClosed) return false; // en manual, la fase termina cuando el organizador la cierra
  return p.length > 0 && p.every((m) => m.status === 'done');
};
const needsFinal = () => { const c = T().config; return c.format === 'grupos' || (ligaLike(c) && c.ligaFinal > 0); };

function podium() {
  const t = T(), c = t.config;
  const ko = t.matches.filter((m) => m.phase === 'ko');
  if (ko.length) {
    const fin = ko.find((m) => m.ko === 'final' && isDecider(m));
    if (!fin || fin.status !== 'done' || !tieWinner(fin)) return null;
    const p = [tieWinner(fin), tieLoser(fin)];
    if (c.podium >= 3) {
      const th = ko.find((m) => m.ko === 'third' && isDecider(m));
      if (th) p.push(tieWinner(th));
      else if ((ligaLike(c) || t.groups.length === 1) && t.groups[0]) {
        const tab = standings(t.groups[0].teams, ligaLike(c) ? 'liga' : 'grupo', t.groups[0].name);
        const third = tab.find((r) => !p.includes(r.id));
        p.push(third ? third.id : null);
      }
    }
    return p.slice(0, c.podium);
  }
  if (ligaLike(c) && !needsFinal() && phase1Done()) {
    return standings(t.groups[0].teams, 'liga', '').slice(0, c.podium).map((r) => r.id);
  }
  return null;
}

/* ---------------- Sorteo ---------------- */
const nextPow2 = (n) => { let p = 1; while (p < n) p *= 2; return p; };
/**
 * Cruces por sorteo: los mejor ubicados ("cabezas", p. ej. los 1° de grupo) se sortean contra
 * el resto (los 2°), evitando que se crucen equipos del mismo grupo. Si sobran cabezas, pasan directo.
 */
function drawPairs(seeds, groupOf, ng = 1) {
  const Q = seeds.length, P = nextPow2(Q), nb = P - Q;
  // nivel de cada clasificado: 0 = primeros de grupo, 1 = segundos, etc. (en liga, su puesto)
  const lvl = (id) => { const i = seeds.indexOf(id); return groupOf ? Math.floor(i / ng) : i; };
  const levels = [...new Set(seeds.map(lvl))].sort((x, y) => x - y);
  // Pases directos: para los mejor ubicados; si hay más candidatos que pases, se sortea entre ellos
  const byes = [];
  for (const L of levels) {
    if (byes.length >= nb) break;
    byes.push(...shuffle(seeds.filter((id) => lvl(id) === L)).slice(0, nb - byes.length));
  }
  // El resto se cruza: mitad mejor ubicada contra mitad peor ubicada, por sorteo y sin repetir grupo
  const remaining = seeds.filter((id) => !byes.includes(id));
  const half = remaining.length / 2;
  const heads = shuffle(remaining.slice(0, half)), rest0 = remaining.slice(half);
  let rest = shuffle(rest0);
  const clash = (r) => r.some((id, i) => groupOf && groupOf[id] && groupOf[id] === groupOf[heads[i]]);
  for (let k = 0; k < 500 && clash(rest); k++) rest = shuffle(rest0);
  const pairs = [...byes.map((b) => [b, null]), ...heads.map((h, i) => [h, rest[i]])];
  return shuffle(pairs).flat();
}
const groupCount = (n, size) => Math.max(1, Math.min(Math.floor(n / 2), Math.round(n / size)));
function doDraw() {
  const t = T(), c = t.config;
  const n = t.teams.length;
  if (n < 2) return toast('Se necesitan al menos 2 equipos');
  const sz = teamSize(t);
  const short = t.teams.filter((x) => x.players.length < sz.min);
  if (short.length) return toast(`Faltan integrantes (mínimo ${sz.min}) en: ${short.map((x) => x.name).join(', ')}`);
  const over = t.teams.filter((x) => x.players.length > sz.max);
  if (over.length) return toast(`Pasan del máximo de ${sz.max} jugadores: ${over.map((x) => x.name).join(', ')}`);
  if (c.format === 'grupos' && n < 3) return toast('Para grupos se necesitan al menos 3 equipos');
  if (c.format === 'grupos') {
    const ng = ngOf(c, n);
    if (ng * c.perGroup < 2) return toast('Deben clasificar al menos 2 equipos: aumente "Clasifican por grupo"');
    if (Math.min(...Array.from({ length: ng }, (_, i) => Math.floor(n / ng) + (i < n % ng ? 1 : 0))) < c.perGroup) return toast('Hay grupos con menos equipos que los que clasifican');
  }
  if (ligaLike(c) && c.ligaFinal > n) return toast(`No hay ${c.ligaFinal} equipos para la fase final`);
  if (c.format === 'manual') return ask(`Se iniciará el torneo de ${catName(S.cat)} con ${n} equipos. Ustedes eligen cada partido; la tabla se calcula sola.`, { title: '✋ Partidos a elección', ok: 'Iniciar torneo' }).then((ok) => { if (ok) doDrawNow(); });
  return ask(`Se sortearán ${n} equipos de ${catName(S.cat)}.\n\nEl sorteo se hace una sola vez y queda registrado con fecha y usuario.`, { title: '🎲 Sorteo oficial', ok: '🎲 Realizar sorteo' })
    .then((ok) => { if (ok) doDrawNow(); });
}
function doDrawNow() {
  const t = T(), c = t.config, n = t.teams.length;
  const ids = shuffle(t.teams.map((x) => x.id));
  t.matches = []; t.groups = []; t.tieOverride = {}; t.finalInfo = null;
  t.drawInfo = { at: Date.now(), by: auth ? auth.user : 'local', n, format: c.format, num: (t.drawLog || []).filter((x) => x.type === 'draw').length + 1 };
  if (c.format === 'elim') {
    t.stage = 'final';
    buildKO(ids);
  } else if (c.format === 'liga') {
    t.groups = [{ name: '', teams: ids }];
    t.matches = roundRobin(ids, 'liga', '');
    if (legsOf(c) === 2) t.matches = withSecondLeg(t.matches);
    t.stage = 'fase1';
  } else if (c.format === 'manual') {
    // Partidos a elección: los equipos quedan en una sola tabla y el organizador crea cada partido
    t.groups = [{ name: '', teams: t.teams.map((x) => x.id) }];
    t.matches = [];
    t.manualClosed = false;
    t.stage = 'fase1';
  } else {
    const ng = ngOf(c, n);
    const letters = 'ABCDEFGHIJ';
    t.groups = Array.from({ length: ng }, (_, i) => ({ name: letters[i], teams: [] }));
    ids.forEach((id, i) => t.groups[i % ng].teams.push(id));
    // intercalar partidos de los grupos por fecha
    let all = t.groups.flatMap((g) => roundRobin(g.teams, 'grupo', g.name));
    if (legsOf(c) === 2) all = withSecondLeg(all);
    t.matches = all.sort((a, b) => a.round - b.round);
    t.stage = 'fase1';
  }
  save(); render();
  toast('🎲 Sorteo realizado');
}

function genFinal(prevNotes = []) {
  const t = T(), c = t.config;
  if (!phase1Done()) return toast('Terminen todos los partidos primero');
  let seeds = [];
  if (ligaLike(c)) {
    seeds = standings(t.groups[0].teams, 'liga', '').slice(0, c.ligaFinal).map((r) => r.id);
  } else {
    const tabs = t.groups.map((g) => standings(g.teams, 'grupo', g.name));
    if (pairingOf(c) === 'ranking') {
      // Tabla general de clasificados: primero la posición en el grupo, luego promedio de puntos, DG y goles
      const rows = [];
      tabs.forEach((tab) => tab.slice(0, c.perGroup).forEach((r, pos) => rows.push({ ...r, pos })));
      const avg = (r, k) => (r.pj ? r[k] / r.pj : 0);
      rows.sort((x, y) => x.pos - y.pos || avg(y, 'pts') - avg(x, 'pts') || (avg(y, 'gf') - avg(y, 'gc')) - (avg(x, 'gf') - avg(x, 'gc')) || avg(y, 'gf') - avg(x, 'gf'));
      seeds = rows.map((r) => r.id);
    } else {
      for (let pos = 0; pos < c.perGroup; pos++) for (const tab of tabs) if (tab[pos]) seeds.push(tab[pos].id);
    }
  }
  if (seeds.length < 2) return toast('No hay suficientes clasificados');

  // Revisar el último cupo de cada tabla: avisar cómo se decidió y pedir decisión si hay empate total
  const cuts = ligaLike(c)
    ? [{ tab: standings(t.groups[0].teams, 'liga', ''), cut: c.ligaFinal, g: '' }]
    : t.groups.map((g) => ({ tab: standings(g.teams, 'grupo', g.name), cut: c.perGroup, g: g.name }));
  const notes = [...prevNotes];
  for (const { tab, cut, g } of cuts) {
    const x = tab[cut - 1], y = tab[cut];
    if (!x || !y) continue;
    const why = decidedBy(x, y);
    if (why === 'empate total') {
      return askChoice(`${tname(x.id)} y ${tname(y.id)} están empatados en todo por el último cupo${g ? ' del Grupo ' + g : ''}.\n\nDefinan en la cancha (por ejemplo con penales) y elijan quién clasifica, o sortéenlo.`, [
        { key: '1', label: '✅ Clasifica ' + tname(x.id), value: x.id },
        { key: '2', label: '✅ Clasifica ' + tname(y.id), value: y.id },
        { key: 'S', label: '🎲 Sortear al azar', value: 'S', style: 'ghost' },
      ], { title: '⚖️ Empate total' }).then((ans) => {
        const w = ans === 'S' ? [x.id, y.id][randInt(2)] : ans;
        if (!w) return toast('Fase final no generada: falta decidir el empate');
        t.tieOverride = Object.assign({}, t.tieOverride, { [[x.id, y.id].sort().join('|')]: w });
        notes.push(`${tname(w)} clasificó por ${ans === 'S' ? 'sorteo' : 'decisión del organizador'}`);
        return genFinal(notes); // recalcular con la decisión aplicada
      });
    }
    if (why === 'juego limpio (menos tarjetas)') notes.push(`${tname(x.id)} clasificó sobre ${tname(y.id)} por juego limpio (menos tarjetas)`);
  }
  const qual = seeds.map(tname).join(', ');
  return ask(`Clasificados: ${qual}\n\nCruces: ${PAIRING_TEXT[pairingOf(c)]}${notes.length ? '\n\n⚠️ ' + notes.join('\n⚠️ ') : ''}`, { title: '🏁 Generar fase final', ok: 'Generar fase final' })
    .then((ok) => { if (ok) genFinalNow(seeds); });
}
function genFinalNow(seeds) {
  const t = T(), c = t.config;
  t.matches = t.matches.filter((m) => m.phase !== 'ko');
  const groupOf = c.format === 'grupos' && t.groups.length > 1 ? Object.fromEntries(t.groups.flatMap((g) => g.teams.map((id) => [id, g.name]))) : null;
  const pairing = pairingOf(c);
  if (pairing === 'sorteo') buildKO(null, null, drawPairs(seeds, groupOf, t.groups.length));
  else buildKO(seeds, pairing === 'cruzado' ? groupOf : null);
  t.stage = 'final';
  t.finalInfo = { at: Date.now(), by: auth ? auth.user : 'local', qualified: seeds, pairing };
  save(); render();
  const first = t.matches.filter((m) => m.phase === 'ko' && m.round === 1 && m.home && m.away && m.tieLeg !== 2);
  toast(`🏁 Fase final generada · ${first.map((m) => tname(m.home) + ' vs ' + tname(m.away)).join(' · ')}`);
}

/* ---------------- Vistas ---------------- */
const views = { inicio: viewInicio, equipos: viewEquipos, partidos: viewPartidos, tabla: viewTabla, ajustes: viewAjustes };
const ICON_SETTINGS = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>';
const ICON_KEY = '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3M16 7l3 3M14 9l2 2"/></svg>';

function render() {
  sync.pendingRender = false;
  const adm = isAdmin();
  fixSelection(S);
  const brand = $('#brand-name');
  if (brand) brand.textContent = TOR().name;
  const sub = $('#brand-sub');
  if (sub) {
    const nT = Object.values(CATS_()).reduce((a, t) => a + t.teams.length, 0);
    sub.textContent = TOR().org ? 'Organiza: ' + TOR().org
      : Object.keys(S.torneos).length > 1 ? 'Toca para cambiar de torneo' : `${Object.keys(CATS_()).length} categorías · ${nT} equipos`;
  }
  const nb = document.querySelector('.nav-brand span');
  if (nb) nb.textContent = TOR().name;
  document.body.dataset.pal = String((T().color || 0) % PALETTES);
  document.body.classList.toggle('public', !adm);
  const cats = $('#cats');
  cats.innerHTML = Object.keys(CATS_()).map((k) => `<button data-a="cat" data-c="${k}" class="${k === S.cat ? 'on' : ''}">${esc(catName(k))}</button>`).join('');
  const onBtn = cats.querySelector('.on');
  if (onBtn) cats.scrollLeft = onBtn.offsetLeft - cats.clientWidth / 2 + onBtn.clientWidth / 2;
  const t4 = document.querySelector('#tabs [data-t="ajustes"]');
  if (!showAccess() && S.tab === 'ajustes') S.tab = 'inicio';
  if (t4) {
    t4.hidden = !showAccess();
    t4.innerHTML = adm ? ICON_SETTINGS + 'Ajustes' : ICON_KEY + 'Ingresar';
  }
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === S.tab));
  $('#view').innerHTML = (views[S.tab] || viewEquipos)();
  renderModal();
  setMode(sync.mode, false);
  document.querySelectorAll('.hscroll[id]').forEach(updateArrows);
}

/* ---- utilidades de fechas ---- */
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function dayLabel(d) {
  const dt = new Date(d + 'T12:00');
  let s = dt.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long', year: dt.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
  s = s.charAt(0).toUpperCase() + s.slice(1);
  const today = isoDate(new Date());
  const tomorrow = isoDate(new Date(Date.now() + 864e5));
  if (d === today) s = 'Hoy · ' + s;
  else if (d === tomorrow) s = 'Mañana · ' + s;
  return s;
}
const shortDate = (d) => new Date(d + 'T12:00').toLocaleDateString('es', { weekday: 'short', day: 'numeric', month: 'short' });
const legName = (m) => (m.tieLeg === 1 ? 'ida' : m.tieLeg === 2 ? 'vuelta' : '');
const vueltaName = (m) => (m.leg ? `${m.leg}ª vuelta` : '');
const phaseLabel = (m) => (m.phase === 'ko' ? m.label + (m.tieLeg ? ' · ' + legName(m) : '') : `${m.group ? 'Grupo ' + m.group + ' · ' : ''}${m.leg ? vueltaName(m) + ' · ' : ''}Jornada ${m.round}`);

function teamRecord(id) {
  const r = { pj: 0, g: 0, e: 0, p: 0, gf: 0, gc: 0 };
  for (const m of T().matches) {
    if (m.status !== 'done' || (m.home !== id && m.away !== id)) continue;
    const home = m.home === id;
    r.pj++; r.gf += home ? m.hs : m.as; r.gc += home ? m.as : m.hs;
    const w = winner(m);
    if (m.wo === 'both') r.p++; else if (!w) r.e++; else if (w === id) r.g++; else r.p++;
  }
  return r;
}
const recordHTML = (r) => `<span class="rec"><b class="g">${r.g}G</b><b class="e">${r.e}E</b><b class="p">${r.p}P</b></span>`;

/* ---------------- Inicio (panel) ---------------- */
const whenKey = (m, empty = '9999-99-99') => (m.date || empty) + ' ' + (m.time || '99:99');
const bigCrest = (id, size = 60) => {
  const tm = teamById(id);
  if (!tm) return `<div class="avatar" style="width:${size * 0.8}px;height:${size * 0.8}px;border-radius:50%">?</div>`;
  return tm.crest ? crestHTML(tm.crest, tm.name, size) : teamBadge(tm, Math.round(size * 0.8));
};

function phaseText() {
  const t = T();
  if (t.stage === 'inscripcion') return 'Inscripciones abiertas';
  const pod = podium();
  if (pod && pod[0]) return 'Finalizado';
  const ko = t.matches.filter((m) => m.phase === 'ko' && m.status !== 'done');
  if (t.stage === 'final' && ko.length) return ko[0].label.replace(/ \d+$/, '');
  const p1 = t.matches.filter((m) => m.phase !== 'ko' && m.status !== 'done');
  const lg = p1.length && p1[0].leg ? ' · ' + vueltaName(p1.reduce((a, m) => (m.leg < a.leg ? m : a))) : '';
  return (t.config.format === 'grupos' ? 'Fase de grupos' : 'Fase regular') + lg;
}

function whenText(m) {
  if (!m.date) return 'Fecha por definir';
  return `${dayLabel(m.date)}${m.time ? ' · ' + m.time : ''}`;
}

function featureMatch(m, title) {
  const live = m.status === 'live', done = m.status === 'done';
  const side = (id, src) => `<div class="vs-team"><div class="crest-slot">${id ? bigCrest(id, 64) : '<div class="avatar">?</div>'}</div><b>${esc(id ? tname(id) : srcLabel(src))}</b></div>`;
  const iso = m.date ? `${m.date}T${m.time || '00:00'}` : '';
  return `<button class="feature ${live ? 'live' : ''}" data-a="openMatch" data-id="${m.id}">
    <div class="feature-meta">${live ? '<span class="badge b-live"><i class="pulse"></i>EN VIVO</span>' : `<b>${esc(title)}</b>`}<span>${esc(phaseLabel(m))}</span></div>
    <div class="vs-row">${side(m.home, m.srcH)}
      ${live || done ? `<div class="vs-score">${m.hs} - ${m.as}</div>` : '<div class="vs-score vs">VS</div>'}
      ${side(m.away, m.srcA)}</div>
    <div class="feature-meta">
      ${live ? `<span class="live-clock" data-clock="${m.id}"></span><span>de ${m.duration} min${m.added ? ` +${m.added}'` : ''}</span>` : `<span>📅 ${esc(whenText(m))}</span>`}
      ${m.field ? `<span>📍 Cancha ${esc(m.field)}</span>` : ''}
    </div>
    ${!live && iso ? `<span class="countdown" data-countdown="${iso}"></span>` : ''}
  </button>`;
}

function miniMatch(m) {
  const tm = (id, src) => `<div class="tm">${id ? `<span class="mcrest">${bigCrest(id, 22)}</span>` : ''}<span>${esc(id ? tname(id) : srcLabel(src))}</span></div>`;
  return `<button class="mini" data-a="openMatch" data-id="${m.id}">
    <div class="when">${m.date ? esc(shortDate(m.date)) : 'Por definir'}${m.time ? ' · ' + m.time : ''}</div>
    ${tm(m.home, m.srcH)}${tm(m.away, m.srcA)}
    <div class="ph">${esc(phaseLabel(m))}${m.field ? ' · Cancha ' + esc(m.field) : ''}</div>
  </button>`;
}

function resultRow(m) {
  const w = winner(m);
  return `<div class="res" data-a="openMatch" data-id="${m.id}" role="button">
    <div class="t r ${w === m.home ? 'w' : ''}"><span>${esc(tname(m.home))}</span>${miniCrest(m.home)}</div>
    <div class="s">${m.hs} - ${m.as}${pensShown(m) ? `<small> (pen ${m.ph}-${m.pa})</small>` : ''}</div>
    <div class="t ${w === m.away ? 'w' : ''}">${miniCrest(m.away)}<span>${esc(tname(m.away))}</span></div>
  </div>`;
}

function miniStandings() {
  const t = T(), c = t.config;
  if (t.stage === 'inscripcion' || c.format === 'elim' || !t.groups.length) return '';
  const blocks = t.groups.map((g) => {
    const rows = standings(g.teams, ligaLike(c) ? 'liga' : 'grupo', g.name).slice(0, ligaLike(c) ? 6 : 4);
    return `${g.name ? `<div class="day" style="margin:14px 14px 6px">Grupo ${g.name}</div>` : ''}
      <table><tr><th>#</th><th class="tn">Equipo</th><th>PJ</th><th>DG</th><th>Pts</th></tr>
      ${rows.map((r, i) => `<tr class="${i < (ligaLike(c) ? (c.ligaFinal || c.podium) : c.perGroup) ? 'q' : ''}"><td>${i + 1}</td><td class="tn">${miniCrest(r.id)}${esc(tname(r.id))}</td><td>${r.pj}</td><td>${r.gf - r.gc}</td><td class="pts">${r.pts}</td></tr>`).join('')}</table>`;
  }).join('');
  return `<div class="sec-head"><h2>📊 Posiciones</h2><button class="link" data-a="tab" data-t="tabla">Ver todo →</button></div>
    <div class="panel">${blocks}</div>`;
}

function teamsGrid(limit) {
  const teams = T().teams;
  if (!teams.length) return '';
  const list = limit ? teams.slice(0, limit) : teams;
  return `<div class="team-grid">${list.map((tm) => `<button class="team-card" data-a="viewTeam" data-id="${tm.id}">
      ${tm.crest ? crestHTML(tm.crest, tm.name, 56) : teamBadge(tm, 48)}
      <b>${esc(tm.name)}</b>${recordHTML(teamRecord(tm.id))}</button>`).join('')}</div>`;
}

function viewInicio() {
  const t = T(), tor = TOR(), adm = isAdmin();
  const all = t.matches;
  const done = all.filter((m) => m.status === 'done');
  const live = all.filter((m) => m.status === 'live');
  const goals = done.concat(live).reduce((a, m) => a + m.hs + m.as, 0);
  const cards = all.reduce((a, m) => a + m.cards.length, 0);
  const pct = all.length ? Math.round((done.length / all.length) * 100) : 0;
  const pod = podium();

  let h = `<section class="hero">
    <div class="hero-chips"><span class="hero-chip solid">${esc(catName(S.cat))}</span><span class="hero-chip">${esc(phaseText())}</span></div>
    <h1>${esc(tor.name)}</h1>
    <p>${tor.org ? `Organiza: <b>${esc(tor.org)}</b> · ` : ''}${t.teams.length} equipos · de ${teamSize().min} a ${teamSize().max} jugadores por equipo</p>
    ${tor.contact ? `<p style="margin-top:2px">📞 Contacto: ${esc(tor.contact)}</p>` : ''}
    <div class="hero-stats">
      <div><b>${t.teams.length}</b><span>Equipos</span></div>
      <div><b>${done.length}<small style="color:inherit;opacity:.7;font-size:13px;display:inline">/${all.length}</small></b><span>Jugados</span></div>
      <div><b>${goals}</b><span>Goles</span></div>
      <div><b>${cards}</b><span>Tarjetas</span></div>
    </div>
    ${all.length ? `<div class="progress"><span style="width:${pct}%"></span></div><small>${pct}% del torneo completado</small>` : ''}
  </section>`;
  if (!adm) h += inscCTA();

  // Campeón
  if (pod && pod[0]) {
    const medal = ['🥈', '🥉'];
    h += `<section class="champ">
      <div style="font-size:13px;font-weight:800;letter-spacing:.08em">🏆 CAMPEÓN</div>
      <div class="crest-slot">${bigCrest(pod[0], 80)}</div>
      <h2>${esc(tname(pod[0]))}</h2>
      <div class="places">${pod.slice(1).map((id, i) => (id ? `<span>${medal[i]} ${esc(tname(id))}</span>` : '')).join('')}</div>
    </section>`;
  }

  // Inscripciones (antes del sorteo)
  if (t.stage === 'inscripcion') {
    h += adm
      ? `<div class="cta-grid"><button class="btn" data-a="newTeam">＋ Inscribir equipo</button><button class="btn ghost" data-a="tab" data-t="partidos">🎲 Ir al sorteo</button></div>`
      : '';
    h += `<div class="sec-head"><h2>🛡️ Equipos inscritos</h2><span class="muted" style="font-size:14px">${t.teams.length}</span></div>`;
    h += t.teams.length ? teamsGrid() : `<div class="empty"><span class="big-ic">📝</span>Aún no hay equipos inscritos en ${esc(catName(S.cat))}.</div>`;
    return h;
  }

  const upcoming = all.filter((m) => m.status === 'pend').sort((a, b) => whenKey(a).localeCompare(whenKey(b)));
  const recent = done.slice().sort((a, b) => whenKey(b, '0000').localeCompare(whenKey(a, '0000'))).slice(0, 5);

  let left = '';
  if (live.length) {
    left += `<div class="sec-head"><h2><i class="pulse"></i> En vivo</h2></div>`;
    left += live.map((m) => featureMatch(m, 'En vivo')).join('');
  }
  if (upcoming.length) {
    left += `<div class="sec-head"><h2>⏭️ Próximo partido</h2><button class="link" data-a="tab" data-t="partidos">Calendario →</button></div>`;
    left += featureMatch(upcoming[0], 'Próximo');
    if (upcoming.length > 1) {
      left += `<div class="sec-head"><h2>📅 Siguientes</h2>
          <span class="row" style="flex-wrap:nowrap;align-items:center;gap:6px">
            <span class="muted" style="font-size:13px">${upcoming.length - 1} partidos</span>
            <button class="arrow" data-a="scrollRow" data-row="nextRow" data-dir="-1" aria-label="Anteriores" disabled>‹</button>
            <button class="arrow" data-a="scrollRow" data-row="nextRow" data-dir="1" aria-label="Siguientes" ${upcoming.length - 1 > 1 ? '' : 'disabled'}>›</button>
          </span></div>
        <div class="hscroll" id="nextRow">${upcoming.slice(1, 40).map(miniMatch).join('')}</div>`;
    }
  }
  if (recent.length) {
    left += `<div class="sec-head"><h2>✅ Últimos resultados</h2><button class="link" data-a="tab" data-t="partidos">Ver todos →</button></div>
      <div class="panel">${recent.map(resultRow).join('')}</div>`;
  }
  if (!left) left = `<div class="empty"><span class="big-ic">⚽</span>Pronto se publicarán los partidos.</div>`;

  let right = miniStandings();
  if (scorers().length) right += `<div class="sec-head"><h2>⚽ Goleadores</h2><button class="link" data-a="tab" data-t="tabla">Ver todos →</button></div>${scorersHTML(5)}`;
  right += `<div class="sec-head"><h2>🛡️ Equipos</h2><button class="link" data-a="tab" data-t="equipos">Ver todos →</button></div>${teamsGrid(8)}`;

  h += `<div class="home-grid"><div>${left}</div><div>${right}</div></div>`;
  return h;
}

/* Reloj de partidos en vivo y cuentas regresivas (se actualizan cada segundo) */
/**
 * Fase del partido en vivo, para que todos la vean: 1er tiempo, Descanso, 2º tiempo, Penales o Final del partido.
 * (Sin dos tiempos configurados: "En juego".)
 */
function livePhase(m) {
  if (!m || m.status !== 'live') return '';
  if (inBreak(m)) return 'Descanso';
  if ((m.shoot || []).length) return 'Penales';
  const last = periodOf(m) >= halvesOf(m), st = clockState(m);
  if (last && st.phase === 'over' && !m.runAt) return needsPens(m) ? 'Penales' : 'Final del partido';
  return halvesOf(m) > 1 ? (periodOf(m) === 1 ? '1er tiempo' : '2º tiempo') : 'En juego';
}
/** Texto corto en vivo: "1T 12'", "2T 41'", "Descanso", "Penales 4-3". */
function liveText(m) {
  const ph = livePhase(m);
  if (ph === 'Descanso' || ph === 'Final del partido') return ph;
  if (ph === 'Penales') return (m.ph != null || (m.shoot || []).length) ? `Penales ${m.ph || 0}-${m.pa || 0}` : 'Penales';
  return (ph === '1er tiempo' ? '1T ' : ph === '2º tiempo' ? '2T ' : '') + minuteText(m);
}
function tickLive() {
  document.querySelectorAll('[data-clock]').forEach((el) => {
    const m = mById(el.dataset.clock);
    if (!m) return;
    if (inBreak(m)) { el.textContent = '☕ Descanso'; el.classList.remove('over'); return; }
    if (livePhase(m) === 'Penales') { el.textContent = '🥅 ' + liveText(m); el.classList.remove('over'); return; }
    const st = clockState(m);
    const pre = halvesOf(m) > 1 ? (periodOf(m) === 1 ? '1T ' : '2T ') : '';
    el.textContent = pre + (st.phase === 'reg' ? '⏱ ' + fmtClock(st.ms)
      : st.phase === 'add' ? `⏱ ${m.duration}:00 + ${fmtClock(st.extra)} (agregado +${m.added}')`
        : `⏱ ${minuteText(m)} · tiempo cumplido`);
    el.classList.toggle('over', st.phase === 'over');
  });
  document.querySelectorAll('[data-cmin]').forEach((el) => {
    const m = mById(el.dataset.cmin);
    if (!m) return;
    el.textContent = liveText(m);
  });
  document.querySelectorAll('[data-cphase]').forEach((el) => {
    const m = mById(el.dataset.cphase);
    if (m) el.textContent = livePhase(m);
  });
  document.querySelectorAll('[data-countdown]').forEach((el) => {
    const diff = new Date(el.dataset.countdown).getTime() - Date.now();
    if (isNaN(diff)) return;
    if (diff <= 0) { el.textContent = diff > -3 * 3600e3 ? '⏰ Por comenzar' : '📌 Pendiente de resultado'; return; }
    const d = Math.floor(diff / 864e5), h = Math.floor((diff % 864e5) / 36e5), mi = Math.floor((diff % 36e5) / 6e4), s = Math.floor((diff % 6e4) / 1000);
    el.textContent = '⏳ Comienza en ' + (d ? `${d} d ${h} h` : h ? `${h} h ${pad(mi)} min` : `${mi} min ${pad(s)} s`);
  });
}
setInterval(tickLive, 1000);

/* ---- ¿En qué equipo está? Búsqueda de jugadores, solo para organizadores (nombre, número, equipo y categoría) ---- */
function findPlayers(q) {
  const n = norm(q);
  if (n.length < 3) return [];
  const words = n.split(' ');
  const out = [];
  for (const [ck, c] of Object.entries(CATS_())) {
    for (const tm of c.teams) for (const p of tm.players) {
      const pn = norm(p.name);
      if (words.every((w) => pn.includes(w))) out.push({ ck, c, tm, p });
    }
  }
  return out.sort((a, b) => a.p.name.localeCompare(b.p.name)).slice(0, 25);
}
function playerResultsHTML(q) {
  if (norm(q).length < 3) return '<small class="muted">Escriba al menos 3 letras del nombre o apellido.</small>';
  const list = findPlayers(q);
  if (!list.length) return '<p class="muted" style="margin:6px 0 0">No está inscrito en ningún equipo de este torneo.</p>';
  return `<ul class="cardlist">${list.map(({ ck, c, tm, p }) => `<li><span class="grow"><b>${esc(p.name)}</b>${p.num ? ` <small>#${esc(p.num)}</small>` : ''}<br><small>${esc(tm.name)} · ${esc(c.name)}</small></span>
    <button class="btn ghost sm" data-a="viewTeamCat" data-c="${esc(ck)}" data-id="${esc(tm.id)}">Ver equipo</button></li>`).join('')}</ul>`;
}
function playerSearchHTML() {
  return `<div class="card" style="margin-top:14px">
    <h2>🔎 ¿En qué equipo está?</h2>
    <p class="muted" style="font-size:14px;margin-top:0">Solo organizadores. Busque a un jugador por su nombre para saber en qué equipo y categoría está inscrito (un jugador solo puede estar en un equipo del torneo).</p>
    <input id="psearch" class="inp" placeholder="Nombre o apellido" autocomplete="off" value="${esc(S.psearch || '')}">
    <div id="presults" style="margin-top:8px">${S.psearch ? playerResultsHTML(S.psearch) : ''}</div>
  </div>`;
}
function viewEquipos() {
  const t = T(), c = t.config;
  if (!isAdmin()) {
    let h = `<h1>Equipos ${esc(catName(S.cat))}</h1>` + inscCTA();
    if (!t.teams.length) return h + `<div class="empty"><span class="big-ic">🛡️</span>Aún no hay equipos inscritos.</div>`;
    h += `<p class="muted">${t.teams.length} equipos · G = ganados, E = empatados, P = perdidos. Toca un equipo para ver su plantel y partidos.</p>`;
    return h + teamsGrid();
  }
  const paid = t.teams.reduce((a, x) => a + num(x.paid), 0);
  const due = t.teams.reduce((a, x) => a + Math.max(0, num(c.fee) - num(x.paid)), 0);
  let h = `<h1>Equipos ${catName(S.cat)}</h1>
  <div class="stats">
    <div class="stat"><b>${t.teams.length}</b><span>Equipos</span></div>
    <div class="stat"><b>${money(paid)}</b><span>Recaudado</span></div>
    <div class="stat"><b>${money(due)}</b><span>Pendiente</span></div>
  </div>`;
  if (t.stage === 'inscripcion') {
    h += `<button class="btn block" data-a="newTeam">＋ Inscribir equipo</button><div style="height:12px"></div>`;
  } else {
    h += `<div class="note">Sorteo realizado: aún puede editar integrantes y pagos, pero no agregar ni eliminar equipos.</div>`;
  }
  h += inscAdminCard();
  h += playerSearchHTML();
  if (sync.mode !== 'local') setTimeout(loadInsc, 0);
  if (!t.teams.length) {
    h += `<div class="empty">Aún no hay equipos inscritos.<br><small>Cuota de inscripción: ${money(c.fee)} · de ${teamSize().min} a ${teamSize().max} jugadores por equipo</small></div>`;
  }
  for (const tm of t.teams) {
    const owes = num(c.fee) - num(tm.paid);
    const badge = num(c.fee) <= 0 ? `<span class="badge b-pend">${money(tm.paid)}</span>`
      : owes <= 0 ? `<span class="badge b-ok">Pagado</span>`
        : `<span class="badge b-bad">Debe ${money(owes)}</span>`;
    h += `<button class="list-item" data-a="editTeam" data-id="${tm.id}">
      ${teamBadge(tm, 40)}
      <div class="grow"><div class="t">${esc(tm.name)}</div><small>${tm.players.length} integrantes · pagó ${money(tm.paid)}</small></div>
      ${badge}</button>`;
  }
  return h;
}

function optRadio(name, value, cur, title, desc) {
  return `<label class="opt ${String(cur) === String(value) ? 'on' : ''}">
    <input type="radio" name="${name}" value="${value}" data-cfg="${name}" ${String(cur) === String(value) ? 'checked' : ''}>
    <div><b>${title}</b>${desc ? `<span>${desc}</span>` : ''}</div></label>`;
}

const PAIRING_TEXT = {
  cruzado: 'fijos: 1° de un grupo contra 2° de otro grupo',
  sorteo: 'por sorteo entre los clasificados (1° contra 2°, sin repetir grupo)',
  ranking: 'por rendimiento: el mejor clasificado contra el peor',
};
/** Regla de cruces efectiva según el formato. */
function pairingOf(c) {
  const p = c.koPairing || 'cruzado';
  if (ligaLike(c)) return p === 'sorteo' ? 'sorteo' : 'ranking';
  if (c.format === 'grupos' && ngOf(c, T().teams.length) === 1 && p === 'cruzado') return 'ranking';
  return p;
}

/** Explica con palabras cómo quedará el torneo antes de sortear. */
function formatPreview() {
  const t = T(), c = t.config, n = t.teams.length;
  if (n < 2) return '';
  const parts = [];
  let Q = 0;
  if (c.format === 'grupos') {
    if (n < 3) return '';
    const ng = ngOf(c, n);
    const sizes = Array.from({ length: ng }, (_, i) => Math.floor(n / ng) + (i < n % ng ? 1 : 0));
    const gm = sizes.reduce((a, k) => a + (k * (k - 1)) / 2, 0) * legsOf(c);
    parts.push(ng === 1 ? `1 grupo de ${n} equipos (${gm} partidos)` : `${ng} grupos de ${sizes.join(', ')} equipos (${gm} partidos de grupos${legsOf(c) === 2 ? ", a dos vueltas" : ""})`);
    Q = ng * c.perGroup;
    parts.push(`clasifican ${Q} (${c.perGroup === 1 ? 'el 1°' : 'los ' + c.perGroup + ' primeros'}${ng > 1 ? ' de cada grupo' : ''})`);
  } else if (c.format === 'manual') {
    parts.push(`ustedes eligen cada partido; la tabla se calcula por puntos y la fase termina cuando el organizador la cierra`);
    Q = c.ligaFinal;
    if (!Q) return `<div class="note"><b>Así quedará:</b> ${parts.join('; ')}. Gana el 1° de la tabla.</div>`;
  } else if (c.format === 'liga') {
    parts.push(`todos contra todos${legsOf(c) === 2 ? " a dos vueltas" : ""}: ${(n * (n - 1)) / 2 * legsOf(c)} partidos en ${(n % 2 ? n : n - 1) * legsOf(c)} jornadas${n % 2 ? ' (cada jornada descansa un equipo)' : ''}`);
    Q = c.ligaFinal;
    if (!Q) return `<div class="note"><b>Así quedará:</b> ${parts.join('; ')}. Gana el 1° de la tabla.</div>`;
  } else {
    Q = n;
  }
  const P = nextPow2(Q), byes = P - Q;
  const rounds = []; for (let k = P; k >= 2; k /= 2) rounds.push(roundName(k));
  let fin = rounds.join(' → ');
  if (byes) fin = fin.replace(rounds[0], `${rounds[0]} (${byes} pase${byes > 1 ? 's' : ''} directo${byes > 1 ? 's' : ''})`);
  if (c.podium >= 3 && Q >= 4) fin += ' + partido por el 3er lugar';
  parts.push('fase final: ' + fin + (koLegsOf(c) === 2 ? ' (cada cruce a ida y vuelta, solo por puntos; empate en puntos = penales)' : ''));
  if (c.format !== 'elim' && Q >= 4) parts.push('cruces ' + PAIRING_TEXT[pairingOf(c)]);
  return `<div class="note"><b>Así quedará:</b> ${parts.join('; ')}.</div>`;
}

/** Formato acordado por el comité para el Campeonato Perquín 2026. */
const COMITE_FORMAT = { format: 'grupos', nGroups: 2, legs: 2, perGroup: 2, koPairing: 'cruzado', koLegs: 2 };
const isComiteFormat = (c) => Object.entries(COMITE_FORMAT).every(([k, v]) => String(c[k]) === String(v));
function drawSetupHTML() {
  const t = T(), c = t.config, n = t.teams.length;
  let h = `<h1>Sorteo ${catName(S.cat)}</h1>
    <p class="muted">${n} equipo(s) inscritos. Configure el formato y realice el sorteo.</p>
    <h3>Formato</h3>
    ${optRadio('format', 'liga', c.format, 'Todos contra todos', 'Todos se enfrentan una vez. Tabla por puntos.')}
    ${optRadio('format', 'grupos', c.format, 'Cuadrangulares (grupos)', 'Se sortean grupos; los mejores pasan a eliminación.')}
    ${optRadio('format', 'elim', c.format, 'Eliminación directa', 'Llave de eliminación desde el inicio.')}
    ${optRadio('format', 'manual', c.format, 'Partidos a elección', 'Ustedes eligen quién juega contra quién (la app sugiere cruces parejos). Tabla por puntos.')}
    <button class="btn ghost block sm" data-a="openCompare" style="margin:4px 0 6px">🧮 Comparar formatos según la cantidad de equipos</button>
    ${isComiteFormat(c) ? '<div class="note">✅ Formato acordado por el comité: 2 grupos a dos vueltas, clasifican 2 por grupo, semifinales cruzadas y final a ida y vuelta por puntos.</div>'
      : '<button class="btn block sm" data-a="formatComite" style="margin:0 0 6px">📋 Usar formato del comité (2 grupos, dos vueltas, finales ida y vuelta por puntos)</button>'}`;
  if (c.format === 'liga' || c.format === 'grupos') {
    h += `<h3>Vueltas</h3>
      ${optRadio('legs', 1, legsOf(c), 'Una vuelta', 'Cada equipo enfrenta una vez a los de su grupo')}
      ${optRadio('legs', 2, legsOf(c), 'Dos vueltas (ida y vuelta)', 'Primera y segunda vuelta: se repiten los cruces con local y visitante invertidos')}`;
  }
  if (ligaLike(c)) {
    h += `<h3>Fase final</h3>
      ${optRadio('ligaFinal', 0, c.ligaFinal, 'Sin fase final', 'Gana el primero de la tabla')}
      ${optRadio('ligaFinal', 2, c.ligaFinal, 'Final', '1° vs 2° de la tabla')}
      ${optRadio('ligaFinal', 4, c.ligaFinal, 'Semifinales', '1° vs 4° y 2° vs 3°, luego final')}`;
    if (c.ligaFinal === 4) {
      h += `<h3>Cruces de semifinales</h3>
      ${optRadio('koPairing', 'ranking', pairingOf(c), 'Por posición', '1° vs 4° y 2° vs 3°')}
      ${optRadio('koPairing', 'sorteo', pairingOf(c), 'Por sorteo', 'Se sortea contra quién juegan el 1° y el 2° (entre el 3° y el 4°)')}`;
    }
  }
  if (c.format === 'grupos') {
    h += `<label class="fl">Cantidad de grupos<select data-cfg="nGroups">
          ${[0, 2, 3, 4].map((v) => `<option value="${v}" ${Number(c.nGroups || 0) === v ? 'selected' : ''}>${v ? v + ' grupos' : 'Automático (según equipos por grupo)'}</option>`).join('')}
        </select></label>
      <div class="grid2">
        <label class="fl">Equipos por grupo${Number(c.nGroups) > 0 ? ' <small>(no aplica: cantidad fija)</small>' : ''}<select data-cfg="groupSize" ${Number(c.nGroups) > 0 ? 'disabled' : ''}>
          ${[3, 4, 5, 6].map((v) => `<option value="${v}" ${c.groupSize == v ? 'selected' : ''}>${v}${v === 4 ? ' (cuadrangular)' : ''}</option>`).join('')}
        </select></label>
        <label class="fl">Clasifican por grupo<select data-cfg="perGroup">
          ${[1, 2, 3, 4].map((v) => `<option value="${v}" ${c.perGroup == v ? 'selected' : ''}>${v}</option>`).join('')}
        </select></label></div>`;
    if (n >= 3 && ngOf(c, n) * c.perGroup >= 4) {
      const one = ngOf(c, n) === 1;
      h += `<h3>Cruces de la fase final</h3>
      ${one ? '' : optRadio('koPairing', 'cruzado', pairingOf(c), 'Cruces fijos', '1° del Grupo A vs 2° del Grupo B, 1° del B vs 2° del A…')}
      ${optRadio('koPairing', 'sorteo', pairingOf(c), 'Por sorteo', one ? 'Se sortea contra quién juegan los mejores ubicados' : 'Se sortea qué 1° juega contra qué 2° (nunca del mismo grupo)')}
      ${optRadio('koPairing', 'ranking', pairingOf(c), 'Por rendimiento', 'Tabla general de clasificados: el mejor contra el peor')}`;
    }
  }
  if (c.format === 'elim' || c.format === 'grupos' || (ligaLike(c) && c.ligaFinal > 0)) {
    h += `<h3>Partidos de la fase final</h3>
      ${optRadio('koLegs', 1, koLegsOf(c), 'Partido único', 'Gana el partido; si empatan, penales')}
      ${optRadio('koLegs', 2, koLegsOf(c), 'Ida y vuelta por puntos (liguilla)', 'Semifinales y final a dos partidos. Solo cuentan los puntos (no los goles); si empatan en puntos, penales al final de la vuelta')}`;
  }
  h += formatPreview();
  h += `<h3>Premiación</h3>
      ${optRadio('podium', 1, c.podium, 'Solo campeón (1 lugar)', '')}
      ${optRadio('podium', 2, c.podium, 'Campeón y subcampeón (2 lugares)', '')}
      ${optRadio('podium', 3, c.podium, '3 lugares', 'Incluye partido por el tercer lugar si hay semifinales')}
      <label class="fl">Duración de partido por defecto (minutos)<input type="number" inputmode="numeric" min="1" data-cfg="duration" value="${c.duration}"></label>
      <div style="height:12px"></div>
      <button class="btn block" data-a="draw" ${n < 2 ? 'disabled' : ''}>${c.format === 'manual' ? '✋ Iniciar torneo (partidos a elección)' : '🎲 Realizar sorteo'}</button>`;
  return h;
}

/** Transparencia: cuándo y quién hizo el sorteo y la fase final. */
function drawInfoHTML(t) {
  const fmtAt = (ms) => new Date(ms).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  let h = '';
  if (t.drawInfo) h += `🎲 Sorteo realizado el ${fmtAt(t.drawInfo.at)}${t.drawInfo.by && t.drawInfo.by !== 'local' ? ' por ' + esc(t.drawInfo.by) : ''}`;
  if (t.drawInfo && t.drawInfo.num > 1) h = h.replace('🎲 Sorteo realizado', `🎲 Sorteo oficial (n.° ${t.drawInfo.num})`);
  if (t.finalInfo) h += `${h ? '<br>' : ''}🏁 Fase final generada el ${fmtAt(t.finalInfo.at)}${t.finalInfo.by && t.finalInfo.by !== 'local' ? ' por ' + esc(t.finalInfo.by) : ''}${t.finalInfo.pairing ? ' · cruces ' + esc(PAIRING_TEXT[t.finalInfo.pairing] || '') : ''}`;
  for (const x of t.drawLog || []) h += `${h ? '<br>' : ''}⚠️ ${x.type === 'draw' ? 'Un sorteo' : 'Una fase final'} del ${fmtAt(x.at)} fue anulado${x.annulledBy && x.annulledBy !== 'local' ? ' por ' + esc(x.annulledBy) : ''} el ${fmtAt(x.annulledAt)}`;
  return h ? `<p class="muted" style="font-size:13px;margin:-6px 0 12px">${h}</p>` : '';
}

function calendarHTML(list) {
  const key = (m) => m.date + ' ' + (m.time || '99:99') + ' ' + String(m.field || '').padStart(3, '0');
  const dated = list.filter((m) => m.date).sort((a, b) => key(a).localeCompare(key(b)));
  const undated = list.filter((m) => !m.date);
  let h = '';
  if (!dated.length) {
    h += `<div class="note">${isAdmin() ? 'Aún no hay fechas programadas. Use “Programar fechas y horarios”.' : 'Aún no se han programado fechas.'}</div>`;
  }
  let cur = null;
  for (const m of dated) {
    if (m.date !== cur) { cur = m.date; h += `<div class="day ${m.date === isoDate(new Date()) ? 'today' : ''}">${esc(dayLabel(m.date))}</div>`; }
    h += matchCard(m);
  }
  if (undated.length) {
    if (dated.length) h += `<div class="day">Sin fecha asignada</div>`;
    for (const m of undated) h += matchCard(m);
  }
  return h;
}

function phasesHTML() {
  const t = T(), c = t.config;
  let h = '';
  const p1 = phase1();
  if (p1.length) {
    h += `<h3>${ligaLike(c) ? 'Fase regular' : 'Fase de grupos'} · ${p1.filter((m) => m.status === 'done').length}/${p1.length}</h3>`;
    for (const r of [...new Set(p1.map((m) => m.round))]) {
      const lg = (p1.find((x) => x.round === r) || {}).leg;
      h += `<div class="day">${lg ? vueltaName({ leg: lg }) + ' · ' : ''}Jornada ${r}</div>`;
      for (const m of p1.filter((x) => x.round === r)) h += matchCard(m);
    }
  }
  const ko = t.matches.filter((m) => m.phase === 'ko');
  if (ko.length) {
    h += `<h3>Fase final</h3>`;
    const labels = [];
    for (const m of ko) { const base = m.label.replace(/ \d+$/, ''); if (!labels.includes(base)) labels.push(base); }
    for (const lb of labels) {
      h += `<div class="day">${lb}</div>`;
      for (const m of ko.filter((x) => x.label.replace(/ \d+$/, '') === lb)) h += matchCard(m);
    }
  }
  return h;
}

function viewPartidos() {
  const t = T(), c = t.config, adm = isAdmin();
  // Árbitro: sus partidos asignados arriba, en todas las categorías
  const mine = isRef() ? `<h3>🧑‍⚖️ Mis partidos</h3>${myMatchesHTML()}` : '';
  if (t.stage === 'inscripcion') {
    if (adm) return drawSetupHTML();
    return `<h1>Partidos ${catName(S.cat)}</h1>${mine}<div class="empty">El sorteo aún no se ha realizado.<br><small>${t.teams.length} equipo(s) inscritos</small></div>`;
  }
  const fmt = { liga: 'Todos contra todos', grupos: 'Cuadrangulares', elim: 'Eliminación directa', manual: 'Partidos a elección' }[c.format];
  const mode = S.view === 'fase' ? 'fase' : 'cal';
  const all = t.matches;
  const done = all.filter((m) => m.status === 'done').length;
  let h = `<h1>Partidos ${catName(S.cat)}</h1>
    <p class="muted">${fmt} · ${done}/${all.length} jugados${adm ? ' · toque un partido para jugarlo' : ''}</p>
    ${drawInfoHTML(t)}${mine}`;
  h += `
    <div class="seg2">
      <button data-a="view" data-v="cal" class="${mode === 'cal' ? 'on' : ''}">📅 Calendario</button>
      <button data-a="view" data-v="fase" class="${mode === 'fase' ? 'on' : ''}">🗂️ Por fase</button>
    </div>`;
  if (adm) h += `<button class="btn ghost block sm" data-a="openSchedule" style="margin-bottom:10px">🗓️ Programar fechas y horarios</button>`;

  // En el calendario, los partidos en vivo van solo arriba (no se repiten en la lista).
  // En la vista por fase se quedan en su jornada.
  if (mode === 'cal') {
    const live = all.filter((m) => m.status === 'live');
    if (live.length) { h += `<h3>🔴 En juego ahora</h3>`; for (const m of live) h += matchCard(m); }
    h += calendarHTML(all.filter((m) => m.status !== 'live'));
  } else {
    h += phasesHTML();
  }

  if (adm && c.format === 'manual' && t.stage === 'fase1') {
    if (!t.manualClosed) {
      h += `<div class="cta-grid" style="margin-top:14px">
        <button class="btn" data-a="manualNew">＋ Agregar partido</button>
        <button class="btn ghost" data-a="manualSuggest">🎲 Sugerir partido</button>
      </div>
      ${manualBalanceHTML()}
      <button class="btn ghost block sm" data-a="manualClose" ${phase1().length && phase1().every((m) => m.status === 'done') ? '' : 'disabled'}>🏁 Terminar fase de partidos${needsFinal() ? ' (para generar la fase final)' : ' (definir campeón)'}</button>
      <p class="muted" style="font-size:12.5px">Para terminar la fase, todos los partidos creados deben estar finalizados.</p>`;
    } else if (!t.matches.some((m) => m.phase === 'ko')) {
      h += `<div class="note">La fase de partidos está cerrada.</div><button class="btn ghost block sm" data-a="manualReopen">↩️ Reabrir fase para agregar más partidos</button>`;
    }
  }
  if (adm) {
    if (t.stage === 'fase1' && needsFinal()) {
      h += phase1Done()
        ? `<button class="btn block" data-a="genFinal">🏁 Generar fase final</button>`
        : `<div class="note warn">Cuando terminen todos los partidos de la primera fase podrá generar la fase final.</div>`;
    }
    if (all.some((m) => m.phase === 'ko') && c.format !== 'elim') h += `<button class="btn ghost block sm" data-a="undoFinal">Deshacer fase final</button>`;
  }
  const pod = podium();
  if (pod) h += podiumHTML(pod);
  if (adm) h += `<div style="height:20px"></div><button class="btn danger block sm" data-a="undoDraw">Deshacer sorteo (borra resultados)</button>`;
  return h;
}

/* ---------------- Formato "Partidos a elección" ---------------- */
/** Partidos jugados/programados por equipo y si ya se enfrentaron. */
function manualStats() {
  const t = T();
  const count = Object.fromEntries(t.teams.map((x) => [x.id, 0]));
  const met = new Set();
  for (const m of phase1()) { count[m.home]++; count[m.away]++; met.add([m.home, m.away].sort().join('|')); }
  return { count, met };
}
function manualBalanceHTML() {
  const t = T(), { count } = manualStats();
  const rows = [...t.teams].sort((a, b) => count[a.id] - count[b.id]);
  return `<div class="card" style="padding:12px;margin-top:10px"><b style="font-size:14px">Partidos por equipo</b>
    <div class="row" style="margin-top:8px;gap:6px">${rows.map((x) => `<span class="badge ${count[x.id] === count[rows[0].id] ? 'b-ok' : 'b-pend'}">${esc(x.name)}: ${count[x.id]}</span>`).join('')}</div>
    <small>En verde, los que menos han jugado. "Sugerir partido" los prioriza y evita repetir cruces.</small></div>`;
}
/** Sugerencia: dos equipos con menos partidos que aún no se hayan enfrentado (si es posible). */
function suggestPair() {
  const t = T(), { count, met } = manualStats();
  const ids = shuffle(t.teams.map((x) => x.id)).sort((a, b) => count[a] - count[b]);
  let best = null, bestScore = Infinity;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = ids[i], b = ids[j];
    const score = (count[a] + count[b]) * 10 + (met.has([a, b].sort().join('|')) ? 1000 : 0) + Math.abs(count[a] - count[b]);
    if (score < bestScore) { bestScore = score; best = [a, b]; }
  }
  return best;
}
function manualMatchHTML() {
  const t = T(), sel = modal.pair || [];
  // Jornada sugerida: la última si aún caben partidos (cada equipo juega 1 vez por jornada), si no, la siguiente
  const p1 = phase1(), last = p1.length ? Math.max(...p1.map((m) => m.round)) : 1;
  const inLast = p1.filter((m) => m.round === last).length;
  const nextRound = !p1.length ? 1 : inLast < Math.floor(t.teams.length / 2) ? last : last + 1;
  const opt = (v) => t.teams.map((x) => `<option value="${x.id}" ${x.id === v ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  return `<div class="mh"><h2>＋ Agregar partido</h2><button class="x" data-a="close">✕</button></div>
  <div class="mb">
    <div class="grid2">
      <label class="fl">Local<select id="mm-h" class="inp"><option value="">— Elegir —</option>${opt(sel[0])}</select></label>
      <label class="fl">Visitante<select id="mm-a" class="inp"><option value="">— Elegir —</option>${opt(sel[1])}</select></label>
    </div>
    <label class="fl">Jornada / ronda<input id="mm-r" type="number" inputmode="numeric" min="1" value="${modal.round || nextRound}"></label>
    <p class="muted" style="font-size:13px">La jornada sirve para ordenar el calendario. Puede programar fecha y hora después.</p>
  </div>
  <div class="mf">
    <button class="btn block" data-a="manualCreate">Crear partido</button>
    <button class="btn ghost block sm" data-a="manualSuggest">🎲 Sugerir otro cruce</button>
  </div>`;
}

/* ---------------- Comparador de formatos ---------------- */
function compareFormats(n, minutes, fields) {
  const c = T().config, podium3 = c.podium >= 3;
  const ko = (Q) => (Q < 2 ? 0 : Q - 1 + (podium3 && Q >= 4 ? 1 : 0));
  const koText = (Q) => {
    if (Q < 2) return 'sin fase final';
    const P = nextPow2(Q), byes = P - Q, rs = []; for (let k = P; k >= 2; k /= 2) rs.push(roundName(k));
    if (byes) rs[0] += ` (${byes} pase${byes > 1 ? 's' : ''} directo${byes > 1 ? 's' : ''})`;
    return rs.join(' → ') + (podium3 && Q >= 4 ? ' + 3er lugar' : '');
  };
  const time = (games) => { const slots = Math.ceil(games / fields), mins = slots * minutes; return `≈ ${Math.floor(mins / 60)} h ${pad(mins % 60)} min`; };
  const out = [];
  // Todos contra todos (con final o semis)
  const rr = (n * (n - 1)) / 2;
  for (const fin of [0, 2, 4]) {
    if (fin > n) continue;
    const g = rr + ko(fin);
    out.push({ name: 'Todos contra todos' + (fin === 2 ? ' + final' : fin === 4 ? ' + semifinales' : ''), games: g, perTeam: `${n - 1}${fin ? '–' + (n - 1 + (fin === 2 ? 1 : 2)) : ''}`,
      detail: `${rr} partidos en ${n % 2 ? n : n - 1} jornadas${n % 2 ? ', cada jornada descansa 1 equipo' : ''}${fin ? '; luego ' + koText(fin) : '; gana el 1° de la tabla'}`, time: time(g) });
  }
  // Grupos
  for (const size of [3, 4]) {
    if (n < 3) break;
    const ng = groupCount(n, size), sizes = Array.from({ length: ng }, (_, i) => Math.floor(n / ng) + (i < n % ng ? 1 : 0));
    const gm = sizes.reduce((a, k) => a + (k * (k - 1)) / 2, 0), Q = ng * 2;
    if (Math.min(...sizes) < 3) continue; // grupos de 2 no tienen sentido
    const g = gm + ko(Q);
    out.push({ name: ng === 1 ? 'Cuadrangular: 1 grupo' : `Cuadrangulares: ${ng} grupos`, games: g, perTeam: `${Math.min(...sizes) - 1}–${Math.max(...sizes) - 1 + Math.log2(nextPow2(Q))}`,
      detail: `${ng} grupo${ng > 1 ? 's' : ''} de ${sizes.join(', ')} (${gm} partidos); pasan 2${ng > 1 ? ' por grupo' : ''} → ${koText(Q)}`, time: time(g) });
    if (out.some((o) => o.detail === out[out.length - 1].detail && o !== out[out.length - 1])) out.pop(); // sin filas repetidas
  }
  // Eliminación directa
  const ge = ko(n);
  out.push({ name: 'Eliminación directa', games: ge, perTeam: `1–${Math.log2(nextPow2(n))}`, detail: koText(n) + '; el que pierde queda fuera', time: time(ge) });
  return out;
}
function compareHTML() {
  const c = T().config;
  const n = modal.n || Math.max(2, T().teams.length || 6);
  const fields = modal.fields || 1, minutes = matchLength(c) + 5;
  const rows = compareFormats(n, minutes, fields);
  return `<div class="mh"><h2>🧮 Comparar formatos</h2><button class="x" data-a="close">✕</button></div>
  <div class="mb" style="padding-top:10px">
    <div class="grid2">
      <label class="fl">Cantidad de equipos<input id="cmp-n" type="number" inputmode="numeric" min="2" max="40" value="${n}"></label>
      <label class="fl">Canchas a la vez<select id="cmp-f" class="inp">${[1, 2, 3].map((v) => `<option ${v === fields ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    </div>
    <p class="muted" style="font-size:13px">${n % 2 ? `<b>${n} es impar:</b> en todos contra todos un equipo descansa cada jornada; en eliminación hay pases directos.` : `<b>${n} es par:</b> en todos contra todos juegan todos en cada jornada.`} Tiempo estimado con partidos de ${matchLength(c)} min + 5 de cambio.</p>
    ${rows.map((r) => `<div class="card" style="padding:12px;margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline"><b>${esc(r.name)}</b><span class="badge b-ok">${r.games} partidos</span></div>
      <div class="muted" style="font-size:13.5px;margin:4px 0">${esc(r.detail)}</div>
      <small>Cada equipo juega ${r.perTeam} partidos · ${r.time} con ${fields} cancha${fields > 1 ? 's' : ''}</small></div>`).join('')}
    <div class="card" style="padding:12px"><b>Partidos a elección</b><div class="muted" style="font-size:13.5px;margin-top:4px">Ustedes deciden cuántos partidos y quién contra quién. Útil si hay poco tiempo o equipos que llegan tarde.</div></div>
  </div>`;
}

function matchCard(m) {
  const done = m.status === 'done';
  const w = winner(m);
  const side = (id, src, cls) => id
    ? `<div class="${cls} ${done && w === id ? 'win' : ''}">${cls === 'a' ? miniCrest(id) : ''}<span>${esc(tname(id))}</span>${cls === 'h' ? miniCrest(id) : ''}</div>`
    : `<div class="${cls} tbd">${esc(srcLabel(src))}</div>`;
  const status = done ? (m.wo ? '<span class="badge b-bad">W.O.</span>' : w ? '<span class="badge b-ok">Final</span>' : '<span class="badge b-ok">Empate</span>')
    : m.status === 'live' ? `<span class="badge b-live"><i class="pulse"></i>EN VIVO <span data-cmin="${m.id}"></span></span>`
      : '<span class="badge b-pend">Pendiente</span>';
  const pens = done && pensShown(m) ? `<small>pen ${m.ph}-${m.pa}</small>` : '';
  const yc = m.cards.filter((x) => x.type === 'Y').length, rc = m.cards.filter((x) => x.type === 'R').length;
  const cards = (yc || rc) ? `${yc ? `🟨${yc}` : ''} ${rc ? `🟥${rc}` : ''}` : '';
  const when = [
    m.date && S.view === 'fase' ? shortDate(m.date) : '',
    m.time ? '🕒 ' + m.time : '',
    m.field ? 'Cancha ' + esc(m.field) : '',
  ].filter(Boolean).join(' · ');
  return `<button class="match ${m.status}" data-a="openMatch" data-id="${m.id}">
    ${side(m.home, m.srcH, 'h')}
    <div class="sc">${m.status === 'pend' ? 'vs' : `${m.hs} - ${m.as}`}${pens}</div>
    ${side(m.away, m.srcA, 'a')}
    <div class="meta"><span>${when ? `<b>${when}</b> · ` : ''}${esc(phaseLabel(m))}${m.ref && signedIn() && sync.mode !== 'local' ? ' · 🧑‍⚖️ ' + esc(m.ref) : ''}</span><span>${cards} ${status}</span></div>
    ${seriesNote(m) ? `<div class="meta"><span>${esc(seriesNote(m))}</span></div>` : ''}
  </button>`;
}
/** Resumen de la serie de ida y vuelta (en el partido de vuelta): puntos de cada uno y quién avanza. */
function seriesNote(m) {
  if (!m.tieOf || m.status === 'pend') return '';
  const s = seriesPts(m);
  if (!s) return '';
  const w = tieWinner(m);
  return `Serie: ${tname(s.a)} ${s.pa} pts · ${tname(s.b)} ${s.pb} pts${w ? ` → avanza ${tname(w)}${s.pa === s.pb ? ' por penales' : ''}` : s.ida.status !== 'done' ? ' (falta terminar la ida)' : ''}`;
}

function podiumHTML(p) {
  const medals = ['🥇', '🥈', '🥉'];
  const names = ['Campeón', 'Subcampeón', 'Tercer lugar'];
  return `<h3>Premiación</h3><div class="card podium">${p.map((id, i) =>
    `<div><span>${medals[i]}</span><div>${id ? esc(tname(id)) : '<span class="muted" style="font-size:15px">Por definir</span>'}<br><small>${names[i]}</small></div></div>`).join('')}</div>`;
}

function tableHTML(rows, qualify) {
  return `<div class="tbl-wrap"><table>
    <tr><th>#</th><th class="tn">Equipo</th><th>PJ</th><th>G</th><th>E</th><th>P</th><th>GF</th><th>GC</th><th>DG</th><th>🟨</th><th>🟥</th><th>Pts</th></tr>
    ${rows.map((r, i) => `<tr class="${i < qualify ? 'q' : ''}"><td>${i + 1}</td><td class="tn">${miniCrest(r.id)}${esc(tname(r.id))}</td>
      <td>${r.pj}</td><td>${r.pg}</td><td>${r.pe}</td><td>${r.pp}</td><td>${r.gf}</td><td>${r.gc}</td><td>${r.gf - r.gc}</td>
      <td>${r.ta}</td><td>${r.tr}</td><td class="pts">${r.pts}</td></tr>`).join('')}
  </table></div>`;
}

function viewTabla() {
  const t = T(), c = t.config;
  if (t.stage === 'inscripcion') return `<h1>Tabla ${catName(S.cat)}</h1><div class="empty">Aún no se ha realizado el sorteo.</div>`;
  let h = `<h1>Tabla ${catName(S.cat)}</h1>${drawInfoHTML(t)}`;
  const pod = podium();
  if (pod) h += podiumHTML(pod);

  if (ligaLike(c)) {
    h += `<h3>Posiciones</h3>` + tableHTML(standings(t.groups[0].teams, 'liga', ''), c.ligaFinal || c.podium);
    h += `<p class="muted" style="font-size:12.5px;margin-top:-4px">Desempate: ${(c.tiebreak || 'h2h') === 'h2h' ? 'enfrentamiento directo → diferencia de goles' : 'diferencia de goles'} → goles a favor → menos tarjetas.</p>`;
  } else if (c.format === 'grupos') {
    for (const g of t.groups) h += `<h3>Grupo ${g.name}</h3>` + tableHTML(standings(g.teams, 'grupo', g.name), c.perGroup);
  }
  const ko = t.matches.filter((m) => m.phase === 'ko');
  if (ko.length) {
    h += `<h3>Llave final</h3>`;
    for (const m of ko) h += matchCard(m);
  }

  h += `<h3>⚽ Goleadores</h3>` + scorersHTML();

  // Sanciones que aún se están cumpliendo
  const susp = activeSanctions(t);
  if (susp.length) {
    h += `<h3>⛔ Sanciones vigentes</h3><div class="tbl-wrap"><table><tr><th class="tn">Jugador</th><th class="tn">Equipo</th><th class="tn">Motivo</th><th>Faltan</th></tr>
      ${susp.map((s) => `<tr><td class="tn"><b>${esc(s.player)}</b></td><td class="tn">${miniCrest(s.team)}${esc(tname(s.team))}</td><td class="tn">${esc(s.why)} vs ${esc(s.vs)}${s.adj ? ` <small>· ajustada por el comité: ${esc(s.adj.reason)}</small>` : ''}${s.extra ? ` <small>· ${esc(s.extra.reason)}</small>` : ''}</td><td>${s.left === Infinity ? 'Todo el torneo' : s.left}</td></tr>`).join('')}</table></div>`;
  }

  // Tarjetas por jugador
  const map = new Map();
  for (const m of t.matches) for (const cd of m.cards) {
    const k = cd.team + '|' + evKey(cd);
    const r = map.get(k) || { team: cd.team, player: evName(cd), Y: 0, R: 0, W: 0 };
    r[cd.type]++; map.set(k, r);
  }
  const rows = [...map.values()].sort((a, b) => b.R - a.R || b.Y - a.Y);
  h += `<h3>Tarjetas</h3>`;
  h += rows.length ? `<div class="tbl-wrap"><table><tr><th class="tn">Jugador</th><th class="tn">Equipo</th><th>🟨</th><th>🟥</th><th>⬜</th></tr>
    ${rows.map((r) => `<tr><td class="tn">${esc(r.player)}</td><td class="tn">${esc(tname(r.team))}</td><td>${r.Y}</td><td>${r.R}</td><td>${r.W}</td></tr>`).join('')}</table></div>`
    : `<p class="muted">Sin tarjetas registradas.</p>`;
  return h;
}

function installCard() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  return `<div class="card">
    <h2>Instalar en el teléfono</h2>
    ${standalone ? '<p class="muted">✅ La app ya está instalada.</p>' : `
      ${installEvt ? '<button class="btn block" data-a="install">📲 Instalar app</button>' : ''}
      <p class="muted" style="font-size:14px"><b>Android (Chrome):</b> menú ⋮ → “Instalar aplicación” o “Agregar a pantalla principal”.<br>
      <b>iPhone (Safari):</b> botón Compartir → “Agregar a inicio”.</p>`}
  </div>`;
}

function loginHTML() {
  const setup = sync.needSetup;
  return `<h1>${setup ? 'Crear organizador' : 'Ingreso de organizadores'}</h1>
  <div class="card">
    <p class="muted" style="font-size:14px;margin-top:0">${setup
    ? 'Aún no hay organizadores. Cree la cuenta principal; luego podrá agregar a los demás organizadores.'
    : 'Sin ingresar puede ver equipos, partidos, resultados y calendario. Para inscribir, sortear y anotar resultados ingrese con su usuario.'}</p>
    <form id="loginForm" autocomplete="on">
      <label class="fl">Usuario<input id="l-user" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="ej: david" required></label>
      <label class="fl">Contraseña<input id="l-pass" name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" placeholder="${setup ? 'Mínimo 6 caracteres' : ''}" required></label>
      ${setup ? '<label class="fl">Repetir contraseña<input id="l-pass2" type="password" autocomplete="new-password" required></label>' : ''}
      <div style="height:12px"></div>
      <button class="btn block" type="submit">${setup ? 'Crear cuenta e ingresar' : 'Ingresar'}</button>
    </form>
  </div>
  ${installCard()}`;
}

function torneoCard() {
  const tor = TOR(), g = tor.config;
  const others = Object.keys(S.torneos).length;
  return `<div class="card">
    <h2>🏆 Torneo</h2>
    <label class="fl">Nombre del torneo<input id="t-name" maxlength="40" value="${esc(tor.name)}" placeholder="Ej: Copa Navidad 2026"></label>
    <label class="fl">Organizado por <small>(ONG, iglesia, comunidad, empresa…)</small><input id="t-org" maxlength="60" value="${esc(tor.org || '')}" placeholder="Ej: Iglesia San José"></label>
    <label class="fl">Contacto para el público <small>(opcional: teléfono, WhatsApp o correo)</small><input id="t-contact" maxlength="60" value="${esc(tor.contact || '')}" placeholder="Ej: 7777-7777"></label>
    <label class="fl">Titulares en cancha <small>(para todas las categorías)</small><input type="number" inputmode="numeric" min="1" max="30" data-tcfg="starters" value="${g.starters}"></label>
    <p class="muted" style="font-size:14px;margin:8px 0 0">El mínimo y el máximo de jugadores por equipo se configuran en cada categoría, en <b>Inscripción en línea</b> (${esc(catName(S.cat))}: de ${teamSize().min} a ${teamSize().max}). Los demás inscritos aparecen como suplentes.</p>
    <div class="row" style="margin-top:12px">
      <button class="btn ghost sm" data-a="openTorneos">🔁 ${others > 1 ? 'Cambiar de torneo (' + others + ')' : 'Torneos'}</button>
      <button class="btn ghost sm" data-a="newTorneo">＋ Nuevo torneo</button>
    </div>
  </div>`;
}

function categoriesCard() {
  const keys = Object.keys(CATS_());
  return `<div class="card">
    <h2>Categorías</h2>
    <p class="muted" style="font-size:14px">Cada categoría tiene sus propios equipos, sorteo, partidos y tabla. Ejemplo: Infantil, Juvenil, Libre, Veteranos.</p>
    ${keys.map((k) => { const t = CATS_()[k]; return `<div class="org">
      <span class="grow"><span class="dot" data-pal="${(t.color || 0) % PALETTES}"></span> <b>${esc(t.name)}</b> <small>· ${t.teams.length} equipos</small></span>
      <span class="row" style="flex-wrap:nowrap;flex:none">
        <button class="btn ghost sm" data-a="colorCat" data-c="${k}" aria-label="Cambiar color">🎨</button>
        <button class="btn ghost sm" data-a="renameCat" data-c="${k}" aria-label="Renombrar">✏️</button>
        ${keys.length > 1 ? `<button class="btn danger sm" data-a="delCat" data-c="${k}" aria-label="Eliminar">🗑️</button>` : ''}
      </span></div>`; }).join('')}
    ${CHAMP_CATS.every(([, n]) => keys.some((k) => CATS_()[k].name === n)) ? '' : '<button class="btn ghost block sm" style="margin-top:10px" data-a="champCats">⚽ Usar categorías del campeonato: Futbolito Femenino, Juvenil y Libre</button>'}
    <form id="catForm" class="row" style="margin-top:10px;flex-wrap:nowrap" autocomplete="off">
      <input id="cat-name" maxlength="24" placeholder="Nueva categoría, ej: Veteranos">
      <button class="btn sm" type="submit" style="flex:none">＋ Agregar</button>
    </form>
  </div>`;
}
const catNameTaken = (n, except) => Object.entries(CATS_()).some(([k, t]) => k !== except && norm(t.name) === norm(n));

/** Reglas del día de partido (por categoría): tiempos, descanso, espera, mínimo para iniciar, blanca y W.O. */
function matchRulesCard(c) {
  const R = matchRules(c);
  const sel = (k, vals, fmt) => `<select data-mrule="${k}">${vals.map((v) => `<option value="${v}" ${Number(R[k]) === v ? 'selected' : ''}>${fmt(v)}</option>`).join('')}</select>`;
  return `<div class="card">
    <h2>⏱️ Partido · ${esc(catName(S.cat))}</h2>
    <div class="grid2">
      <label class="fl">Tiempos${sel('halves', [1, 2], (v) => (v === 1 ? '1 tiempo corrido' : '2 tiempos con descanso'))}</label>
      <label class="fl">Descanso${sel('breakMin', [3, 5, 10, 15], (v) => `${v} minutos`)}</label>
      <label class="fl">Espera después de la hora${sel('waitMin', [0, 5, 10, 15, 20, 30], (v) => (v ? `${v} minutos` : 'Sin espera'))}</label>
      <label class="fl">Mínimo para iniciar${sel('minStart', [1, 2, 3, 4, 5], (v) => `${v} jugadores`)}</label>
      <label class="fl">Tarjeta blanca${sel('whiteMin', [1, 2, 3, 5], (v) => `${v} minutos fuera`)}</label>
      <label class="fl">W.O. (no se presentó)${sel('woGoals', [1, 2, 3], (v) => `gana ${v}-0`)}</label>
    </div>
    <small>El partido valida la presentación de jugadores, no deja iniciar con menos del mínimo y solo permite declarar W.O. pasada la espera. Un partido ya iniciado conserva sus tiempos.</small>
    ${matchAgreed(c) ? '' : `<div class="note warn" style="margin-top:8px">⚠️ Acuerdo del comité: ${MATCH_AGREE.halves} tiempos de ${MATCH_AGREE.duration} minutos, descanso de ${MATCH_AGREE.breakMin}, espera de ${MATCH_AGREE.waitMin}, mínimo ${MATCH_AGREE.minStart} jugadores, blanca ${MATCH_AGREE.whiteMin} minutos, W.O. ${MATCH_AGREE.woGoals}-0.
      <div style="margin-top:8px"><button class="btn sm" data-a="matchAgree">Aplicar el acuerdo del comité</button></div></div>`}
  </div>`;
}
/** Duración total de un partido en minutos (para programar el calendario). */
const matchLength = (c) => { const R = matchRules(c); return R.halves * c.duration + (R.halves > 1 ? R.breakMin : 0); };
/** Reglas de sanción (por categoría). Valores por defecto = acuerdo del comité. */
function sancConfigHTML(c) {
  const R = sancRules(c);
  const opts = (k, vals) => `<select data-sanc="${k}">${vals.map((v) => `<option value="${v}" ${String(R[k]) === String(v) ? 'selected' : ''}>${v === 'all' ? 'Todo el torneo' : v === 0 ? (k === 'yl' ? 'No suspenden' : 'Sin suspensión') : k === 'yl' ? `${v} = 1 partido` : sancText(v)}</option>`).join('')}</select>`;
  const n = [0, 1, 2, 3, 4, 5, 6, 8, 10, 'all'];
  const changed = Object.keys(SANC_DEF).some((k) => String(R[k]) !== String(SANC_DEF[k]));
  return `<div class="fl" style="margin-top:6px">Sanciones <small>(partidos de suspensión)</small></div>
    <div class="grid2">
      <label class="fl">2 amarillas en un partido${opts('y2', n)}</label>
      <label class="fl">Amarilla + roja${opts('yr', n)}</label>
      <label class="fl">Roja directa${opts('r', n)}</label>
      <label class="fl">Roja con agresión${opts('agg', n)}</label>
      <label class="fl">Amarillas acumuladas <small>(en distintos partidos)</small>${opts('yl', [0, 2, 3, 4, 5])}</label>
    </div>
    ${changed ? `<div class="note warn" style="margin-top:8px">⚠️ Distinto del acuerdo del comité (2 amarillas: 1 · amarilla + roja: 2 · roja: 3 · agresión: todo el torneo · sin acumulación).
      <div style="margin-top:8px"><button class="btn sm ghost" data-a="sancDefault">Volver al acuerdo del comité</button></div></div>` : ''}`;
}
/** Partidos asignados al árbitro (en todas las categorías del torneo). */
function myMatches() {
  if (!isRef()) return [];
  const out = [];
  for (const [ck, c] of Object.entries(CATS_())) for (const m of c.matches) if (m.ref === auth.user) out.push({ ck, c, m });
  return out.sort((a, b) => whenKey(a.m).localeCompare(whenKey(b.m)));
}
function myMatchesHTML() {
  const list = myMatches();
  if (!list.length) return '<div class="empty">Aún no tiene partidos asignados. El organizador los asigna desde cada partido.</div>';
  return list.map(({ ck, c, m }) => `<button class="mini" data-a="openMyMatch" data-c="${esc(ck)}" data-id="${m.id}" style="width:100%;margin-bottom:6px">
    <div class="when">${m.date ? esc(shortDate(m.date)) : 'Fecha por definir'}${m.time ? ' · ' + m.time : ''}${m.field ? ' · Cancha ' + esc(m.field) : ''} · <b>${esc(c.name)}</b></div>
    <div class="tm"><span>${esc(Rules.tname(c, m.home))}</span></div><div class="tm"><span>${esc(Rules.tname(c, m.away))}</span></div>
    <div class="ph">${m.status === 'done' ? `✅ Finalizado ${m.hs}-${m.as}` : m.status === 'live' ? '🔴 En juego' : '⏳ Pendiente'}</div>
  </button>`).join('');
}
/** Ajustes de un árbitro: su sesión y sus partidos (no puede cambiar nada del torneo). */
function refSettingsHTML() {
  return `<h1>Árbitro</h1>
  <div class="card">
    <h2>Sesión</h2>
    <p style="margin:6px 0 10px">🧑‍⚖️ Usuario: <b>${esc(auth.user)}</b> · árbitro</p>
    <p class="muted" style="font-size:14px">Puede anotar marcador, goles, tarjetas, presentación de jugadores, tiempos y W.O. solo en los partidos que le asignen. Un partido finalizado lo corrige un organizador.</p>
    <div class="row">
      <button class="btn ghost sm" data-a="changePass">Cambiar contraseña</button>
      <button class="btn danger sm" data-a="logout">Cerrar sesión</button>
    </div>
  </div>
  <h3>🧑‍⚖️ Mis partidos</h3>
  ${myMatchesHTML()}`;
}
function viewAjustes() {
  if (isRef()) return refSettingsHTML();
  if (!isAdmin()) return loginHTML();
  const c = T().config;
  const online = sync.mode !== 'local';
  return `<h1>Ajustes ${catName(S.cat)}</h1>
  ${online ? `<div class="card">
    <h2>Sesión</h2>
    <p style="margin:6px 0 10px">👤 Usuario: <b>${esc(auth.user)}</b>${TOR().org ? ` <small>· ${esc(TOR().org)}</small>` : ''}</p>
    <div class="row">
      <button class="btn ghost sm" data-a="changePass">Cambiar contraseña</button>
      <button class="btn danger sm" data-a="logout">Cerrar sesión</button>
    </div>
  </div>
  <div class="card">
    <h2>Usuarios con acceso</h2>
    <p class="muted" style="font-size:14px"><b>Organizador:</b> inscribe, sortea, programa y anota todo. <b>Árbitro:</b> solo anota marcador, tarjetas, presentación, tiempos y W.O. en los partidos que se le asignen. El público solo ve.</p>
    <div id="orgList">${orgs ? orgs.users.map((u) => { const r = roleName(u); return `<div class="org"><span>${r === 'arbitro' ? '🧑‍⚖️' : '👤'} ${esc(u)} <span class="badge ${r === 'arbitro' ? 'b-warn' : 'b-ok'}">${r === 'arbitro' ? 'Árbitro' : 'Organizador'}</span>${u === orgs.me ? ' <small>(usted)</small>' : ''}</span>
      ${u === orgs.me ? '' : `<span class="row" style="flex-wrap:nowrap"><button class="btn ghost sm" data-a="orgRole" data-u="${esc(u)}" data-r="${r === 'arbitro' ? 'admin' : 'arbitro'}">${r === 'arbitro' ? 'Hacer organizador' : 'Hacer árbitro'}</button><button class="btn danger sm" data-a="delOrg" data-u="${esc(u)}">Quitar</button></span>`}</div>`; }).join('') : '<p class="muted">Cargando…</p>'}</div>
    <form id="orgForm" class="grid2" style="margin-top:8px" autocomplete="off">
      <input id="o-user" placeholder="Nuevo usuario" autocapitalize="none" spellcheck="false" autocomplete="off">
      <input id="o-pass" type="password" placeholder="Contraseña" autocomplete="new-password">
      <select id="o-role" style="grid-column:1/3"><option value="admin">Organizador (todo)</option><option value="arbitro">Árbitro (solo sus partidos)</option></select>
      <button class="btn sm" type="submit" style="grid-column:1/3">＋ Agregar usuario</button>
    </form>
  </div>` : ''}
  ${torneoCard()}
  ${categoriesCard()}
  ${rulesCard()}
  <div class="card">
    <h2>Inscripción · ${esc(catName(S.cat))}</h2>
    <div class="grid2">
      <label class="fl">Cuota de inscripción<input type="number" inputmode="decimal" min="0" data-cfg="fee" value="${c.fee}"></label>
      <label class="fl">${matchRules(c).halves > 1 ? 'Minutos por tiempo' : 'Minutos por partido'}<input type="number" inputmode="numeric" min="1" data-cfg="duration" value="${c.duration}"></label>
    </div>
    <small>Estos ajustes son solo para la categoría ${catName(S.cat)}.</small>
  </div>
  ${matchRulesCard(c)}
  ${inscConfigCard(online)}
  <div class="card">
    <h2>Reglas · ${esc(catName(S.cat))}</h2>
    <label class="fl">Desempate cuando hay igualdad de puntos<select data-cfg="tiebreak">
      <option value="h2h" ${(c.tiebreak || 'h2h') === 'h2h' ? 'selected' : ''}>1° Enfrentamiento directo, 2° diferencia de goles</option>
      <option value="dg" ${c.tiebreak === 'dg' ? 'selected' : ''}>1° Diferencia de goles, 2° goles a favor</option>
    </select></label>
    ${sancConfigHTML(c)}
    <small>Doble amarilla en un partido = roja automática. La tarjeta blanca no suspende. Las suspensiones se cumplen con los partidos que el equipo juega. Desempate: puntos → ${(c.tiebreak || 'h2h') === 'h2h' ? 'enfrentamiento directo → diferencia de goles' : 'diferencia de goles'} → goles a favor → menos tarjetas.</small>
  </div>
  ${online ? `<div class="card">
    <h2>🕘 Historial y restauración</h2>
    <p class="muted" style="font-size:14px">Cada cambio guarda una copia de la versión anterior (últimas 40). Si algo se borra o se cambia por error, puede volver a una versión anterior.</p>
    <button class="btn ghost block sm" data-a="openHistory">Ver versiones anteriores</button>
  </div>` : ''}
  <div class="card">
    <h2>Base de datos en línea</h2>
    <p class="muted" style="font-size:14px" id="sync-status">${esc(syncText())}</p>
    ${online ? '<button class="btn ghost block sm" data-a="syncNow">🔄 Sincronizar ahora</button>' : ''}
  </div>
  ${installCard()}
  <div class="card">
    <h2>Respaldo de datos</h2>
    <p class="muted" style="font-size:14px">Descargue una copia de todo el torneo, o restaure una copia anterior.</p>
    <div class="row">
      <button class="btn ghost" data-a="export">⬇️ Exportar</button>
      <label class="btn ghost">⬆️ Importar<input type="file" accept="application/json,.json" id="importFile" hidden></label>
    </div>
  </div>
  <div class="card">
    <h2>Vaciar categoría</h2>
    <p class="muted" style="font-size:14px">Elimina equipos, sorteo y resultados de ${esc(catName(S.cat))}, pero conserva la categoría.</p>
    <button class="btn danger block" data-a="resetCat">Vaciar ${esc(catName(S.cat))}</button>
  </div>
  ${online ? `<div class="card" style="border-color:var(--bad)">
    <h2>⚠️ Reiniciar todo</h2>
    <p class="muted" style="font-size:14px">Borra TODOS los torneos, equipos, partidos, resultados y el historial de versiones, y deja un torneo vacío. Solo queda su usuario (${esc(auth.user)}); los demás usuarios se eliminan. Pide su contraseña.</p>
    <button class="btn danger block" data-a="resetAll">Reiniciar base de datos</button>
  </div>` : ''}
  <p class="muted" style="text-align:center;font-size:12px">Torneo Fútbol · funciona sin internet</p>`;
}

/* ---------------- Modal ---------------- */
function openModal(type, id) { modal = { type, id }; renderModal(); }
function closeModal() { modal = null; if (sync.pendingRender) render(); else renderModal(); }

function renderModal() {
  const el = $('#modal');
  clearInterval(tick); tick = null;
  if (!modal) { el.hidden = true; document.body.style.overflow = ''; return; }
  // si perdió el permiso (cerró sesión), no mostrar formularios de edición
  if (!isAdmin() && ['team', 'schedule', 'inscAdmin'].includes(modal.type)) { modal = null; return renderModal(); }
  const sheet = $('#sheet');
  const scroll = sheet.scrollTop;
  if (modal.type === 'team') sheet.innerHTML = teamFormHTML(modal.id);
  else if (modal.type === 'schedule') sheet.innerHTML = scheduleHTML();
  else if (modal.type === 'torneos') sheet.innerHTML = torneosHTML();
  else if (modal.type === 'history') sheet.innerHTML = historyHTML();
  else if (modal.type === 'manualMatch') sheet.innerHTML = manualMatchHTML();
  else if (modal.type === 'compare') sheet.innerHTML = compareHTML();
  else if (modal.type === 'cap') sheet.innerHTML = capHTML();
  else if (modal.type === 'inscAdmin') sheet.innerHTML = inscAdminHTML(modal.id);
  else if (modal.type === 'rules') sheet.innerHTML = rulesHTML();
  else if (modal.type === 'teamView') {
    if (!teamById(modal.id)) { modal = null; return renderModal(); }
    sheet.innerHTML = teamViewHTML(modal.id);
  } else if (modal.type === 'match') {
    const m = mById(modal.id);
    if (!m) { modal = null; return renderModal(); }
    sheet.innerHTML = matchHTML(m);
    updateClock();
    tick = setInterval(updateClock, 500);
  }
  el.hidden = false;
  document.body.style.overflow = 'hidden';
  sheet.scrollTop = scroll;
}

let historyList = null;
function historyHTML() {
  const fmtAt = (ms) => (ms ? new Date(ms).toLocaleString('es', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
  let body;
  if (!historyList) body = '<p class="muted">Cargando…</p>';
  else if (!historyList.length) body = '<p class="muted">Aún no hay versiones anteriores guardadas. Se irán guardando con cada cambio.</p>';
  else body = historyList.map((v) => v.error ? '' : `<div class="org">
      <span class="grow"><b>${fmtAt(v.at)}</b><br><small>${v.by ? 'guardada por ' + esc(v.by) + ' · ' : ''}${v.teams} equipos · ${v.done} partidos finalizados${v.live ? ' · ' + v.live + ' en vivo' : ''}</small></span>
      <button class="btn ghost sm" data-a="restoreVersion" data-i="${v.i}">Restaurar</button></div>`).join('');
  return `<div class="mh"><h2>🕘 Versiones anteriores</h2><button class="x" data-a="close">✕</button></div>
  <div class="mb" style="padding-top:10px">
    <div class="note">Restaurar reemplaza los datos actuales de TODOS los torneos por los de esa versión. La versión actual también queda guardada, así que puede deshacer la restauración.</div>
    ${body}
  </div>`;
}

function torneosHTML() {
  const ids = Object.keys(S.torneos).sort((a, b) => (S.torneos[b].createdAt || 0) - (S.torneos[a].createdAt || 0));
  const adm = isAdmin();
  return `<div class="mh"><h2>Torneos</h2><button class="x" data-a="close">✕</button></div>
  <div class="mb" style="padding-top:12px">
    ${ids.map((id) => { const tor = S.torneos[id]; const nTeams = Object.values(tor.cats).reduce((a, t) => a + t.teams.length, 0);
      return `<div class="org">
        <button class="list-item" style="margin:0;flex:1" data-a="switchTorneo" data-id="${id}">
          <div class="grow"><div class="t">${id === S.tor ? '✅ ' : ''}${esc(tor.name)}</div>
          <small>${tor.org ? esc(tor.org) + ' · ' : ''}${Object.keys(tor.cats).length} categorías · ${nTeams} equipos</small></div></button>
        ${adm && ids.length > 1 ? `<button class="btn danger sm" data-a="delTorneo" data-id="${id}" aria-label="Eliminar">🗑️</button>` : ''}
      </div>`; }).join('')}
  </div>
  ${adm ? '<div class="mf"><button class="btn block" data-a="newTorneo">＋ Nuevo torneo</button></div>' : ''}`;
}

function teamViewHTML(id) {
  const tm = teamById(id);
  const r = teamRecord(id);
  const ms = T().matches.filter((m) => m.home === id || m.away === id);
  return `<div class="mh"><h2>${esc(tm.name)}</h2><button class="x" data-a="close">✕</button></div>
  <div class="mb">
    <div class="stats" style="margin-top:12px;grid-template-columns:repeat(4,minmax(0,1fr))">
      <div class="stat"><b>${r.pj}</b><span>Jugados</span></div>
      <div class="stat"><b class="g">${r.g}</b><span>Ganados</span></div>
      <div class="stat"><b class="e">${r.e}</b><span>Empatados</span></div>
      <div class="stat"><b class="p">${r.p}</b><span>Perdidos</span></div>
    </div>
    <p class="muted" style="margin:0 0 6px">Goles a favor ${r.gf} · en contra ${r.gc}${tm.colors ? ` · 🎽 ${esc(tm.colors)}` : ''}</p>
    <h3>Partidos</h3>
    ${ms.length ? ms.map(matchCard).join('') : '<p class="muted">Aún no tiene partidos asignados.</p>'}
    ${[['Titulares', tm.players.filter((p) => !p.sub)], ['Suplentes', tm.players.filter((p) => p.sub)]].filter(([, l]) => l.length).map(([title, list]) => `
    <h3>${title} (${list.length})</h3>
    <ul class="cardlist">${list.map((p) => { const g = scorers().find((x) => x.team === id && x.pid === p.id); const su = nextSuspension(id, p.id);
      return `<li><span class="grow">${p.num ? `<b>${esc(p.num)}</b> · ` : ''}${esc(p.name)}${p.cap ? ' <b title="Capitán">(C)</b>' : ''}${su ? ` <span class="badge b-bad">⛔ Suspendido</span>` : ''}</span>${g ? `<small>⚽ ${g.n}</small>` : ''}</li>`; }).join('')}</ul>`).join('')}
  </div>`;
}

/* ---- Programar calendario ---- */
function scheduleHTML() {
  const c = T().config;
  const s = Object.assign({ mode: 'dia', date: isoDate(new Date()), time: '08:00', fields: 1, gap: matchLength(c) + 5, scope: 'sin' }, c.sched || {});
  const opt = (v, title, desc) => `<label class="opt ${s.mode === v ? 'on' : ''}"><input type="radio" name="s-mode" value="${v}" ${s.mode === v ? 'checked' : ''}>
    <div><b>${title}</b><span>${desc}</span></div></label>`;
  return `<div class="mh"><h2>Programar calendario</h2><button class="x" data-a="close">✕</button></div>
  <div class="mb">
    <p class="muted" style="font-size:14px">Asigna fecha, hora y cancha automáticamente. Después puede ajustar cada partido por separado.</p>
    <h3>¿Cómo se juega?</h3>
    ${opt('dia', 'Todo en un día', 'Todos los partidos seguidos el mismo día')}
    ${opt('diario', 'Una jornada por día', 'Jornada 1 hoy, jornada 2 mañana…')}
    ${opt('semana', 'Una jornada por semana', 'Mismo día de la semana, cada 7 días')}
    ${opt('mes', 'Una jornada por mes', 'Mismo día de cada mes')}
    <div class="grid2">
      <label class="fl">Fecha de inicio<input type="date" id="s-date" value="${s.date}"></label>
      <label class="fl">Hora del primer partido<input type="time" id="s-time" value="${s.time}"></label>
      <label class="fl">Canchas a la vez<select id="s-fields">${[1, 2, 3, 4].map((v) => `<option ${+s.fields === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="fl">Minutos entre partidos<input type="number" inputmode="numeric" min="5" id="s-gap" value="${s.gap}"></label>
    </div>
    <label class="fl">Aplicar a<select id="s-scope">
      <option value="sin" ${s.scope === 'sin' ? 'selected' : ''}>Solo partidos pendientes sin fecha</option>
      <option value="pend" ${s.scope === 'pend' ? 'selected' : ''}>Todos los partidos pendientes (reprogramar)</option>
    </select></label>
    <small>“Minutos entre partidos” = duración del partido + cambio de cancha (por defecto ${matchLength(c)} + 5${matchRules(c).halves > 1 ? ', con los 2 tiempos y el descanso' : ''}).</small>
  </div>
  <div class="mf">
    <button class="btn block" data-a="applySchedule">🗓️ Programar</button>
    <button class="btn danger block sm" data-a="clearSchedule">Quitar fechas de los partidos pendientes</button>
  </div>`;
}

function addDays(iso, n) { const d = new Date(iso + 'T12:00'); d.setDate(d.getDate() + n); return isoDate(d); }
function addMonths(iso, n) {
  const d = new Date(iso + 'T12:00');
  const day = d.getDate();
  d.setDate(1); d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return isoDate(d);
}
function addMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + mins;
  return `${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}`;
}

function applySchedule() {
  const t = T();
  const mode = (document.querySelector('input[name="s-mode"]:checked') || {}).value || 'dia';
  const s = {
    mode, date: $('#s-date').value, time: $('#s-time').value || '08:00',
    fields: Math.max(1, parseInt($('#s-fields').value, 10) || 1),
    gap: Math.max(5, parseInt($('#s-gap').value, 10) || matchLength(t.config) + 5),
    scope: $('#s-scope').value,
  };
  if (!s.date) return toast('Elija la fecha de inicio');
  const target = t.matches.filter((m) => m.status === 'pend' && (s.scope === 'pend' || !m.date));
  if (!target.length) return toast('No hay partidos pendientes para programar');

  // Agrupar en jornadas, en orden: fase 1 por jornada, luego cada ronda de la fase final
  // la ida y la vuelta de una serie quedan en jornadas distintas
  const jKey = (m) => (m.phase === 'ko' ? 1000 + m.round * 2 + (m.tieLeg === 2 ? 1 : 0) : m.round);
  const keys = [...new Set(target.map(jKey))].sort((a, b) => a - b);
  let slot = 0;
  keys.forEach((k, j) => {
    let day = s.date;
    if (mode === 'dia') {
      slot = Math.ceil(slot / s.fields) * s.fields; // cada jornada empieza en un turno nuevo
    } else {
      slot = 0;
      day = mode === 'diario' ? addDays(s.date, j) : mode === 'semana' ? addDays(s.date, 7 * j) : addMonths(s.date, j);
    }
    for (const m of target.filter((x) => jKey(x) === k)) {
      m.date = day;
      m.time = addMinutes(s.time, Math.floor(slot / s.fields) * s.gap);
      m.field = s.fields > 1 ? String((slot % s.fields) + 1) : '';
      slot++;
    }
  });
  t.config.sched = s;
  S.view = 'cal';
  save(); closeModal(); render();
  toast(`🗓️ ${target.length} partidos programados`);
}

function teamFormHTML(id) {
  const t = T(), c = t.config, g = teamSize(t);
  const tm = id ? teamById(id) : null;
  const players = tm ? tm.players : [];
  const tit = players.filter((p) => !p.sub), sup = players.filter((p) => p.sub);
  const nTit = Math.max(g.starters, tit.length), nSup = Math.max(g.max - nTit, sup.length, 0);
  if (modal.crest === undefined) modal.crest = tm ? (tm.crest || null) : randomCrest();
  let n = 0;
  const row = (p, sub, req) => {
    n++;
    return `<div class="prow prow-cap" data-sub="${sub ? 1 : 0}" data-pid="${esc(p.id || '')}"><span class="pn">${n}</span>
      <input class="pl-name" data-pl autocomplete="off" placeholder="Nombre y apellido${req ? ' *' : ''}" value="${esc(p.name || '')}">
      <input class="pl-num" type="number" inputmode="numeric" placeholder="N°" value="${esc(p.num ?? '')}">
      <label class="pcap" title="Capitán del equipo"><input type="radio" name="f-cap" class="pl-cap" ${p.cap ? 'checked' : ''}> C</label>
      <div class="perr"></div></div>`;
  };
  let h = `<div class="mh"><h2>${tm ? 'Editar equipo' : 'Inscribir equipo'}</h2><button class="x" data-a="close">✕</button></div>
  <div class="mb">
    <label class="fl">Nombre del equipo<input id="f-name" maxlength="40" placeholder="Ej: Los Tigres" value="${esc(tm ? tm.name : '')}"></label>
    ${crestEditorHTML(tm ? tm.name : '')}
    <div class="fl">Integrantes <small id="f-count"></small></div>
    <div id="f-players">
      <div class="psec">Titulares <small>(${g.starters})</small></div>`;
  for (let i = 0; i < nTit; i++) h += row(tit[i] || {}, false, i < g.min);
  if (nSup > 0) h += `<div class="psec">Suplentes <small>(${g.subs})</small></div>`;
  for (let i = 0; i < nSup; i++) h += row(sup[i] || {}, true, nTit + i < g.min);
  h += `</div>
    <label class="fl">Monto de inscripción pagado ${num(c.fee) > 0 ? `<small>(cuota ${money(c.fee)})</small>` : ''}
      <input id="f-paid" type="number" inputmode="decimal" min="0" placeholder="0" value="${esc(tm ? tm.paid : '')}"></label>
  </div>
  <div class="mf">
    <button class="btn block" data-a="saveTeam">Guardar equipo</button>
    ${tm && t.stage === 'inscripcion' ? `<button class="btn danger block" data-a="delTeam" data-id="${tm.id}">Eliminar equipo</button>` : ''}
  </div>`;
  setTimeout(checkPlayers, 0);
  return h;
}

/* ---- editor de escudo ---- */
function crestEditorHTML(name) {
  const cr = modal.crest;
  const sw = (k, label) => `<div class="cr-lbl">${label}</div><div class="swatches">${CREST_COLORS.map(([c, l]) => `<button type="button" class="sw" data-a="crestSet" data-k="${k}" data-v="${c}" style="background:${c}" title="${esc(l)}" aria-label="${label}: ${esc(l)}"></button>`).join('')}</div>`;
  return `<div class="fl">Escudo o logo del equipo</div>
  <div class="crest-edit">
    <div id="crest-preview" class="crest-prev">${crestPreview(cr, name)}</div>
    <div class="crest-ctrl">
      <label class="btn sm">📷 Subir nuestro logo<input type="file" accept="image/*" id="crestFile" hidden></label>
      <div class="row"><button type="button" class="btn ghost sm" data-a="crestRandom">🎲 Al azar</button><button type="button" class="btn ghost sm" data-a="crestNone">✕ Quitar</button></div>
      <small>¿No tienen logo? Créenlo aquí abajo: elijan una figura, la forma y los colores.</small>
    </div>
  </div>
  <div class="crest-maker${cr && cr.img ? ' is-img' : ''}">
    <div class="note img-note">Está usando su logo subido. Si elige una figura o un color, se cambia por un escudo creado aquí.</div>
    <div class="cr-lbl">1. Figura</div>
    <div class="emb-grid">${Object.entries(CREST_EMBLEMS).map(([k, l]) => `<button type="button" class="emb" data-a="crestSet" data-k="e" data-v="${k}">${crestEmblemIcon(k, 38)}<span>${esc(l)}</span></button>`).join('')}</div>
    <div class="cr-lbl">2. Forma</div>
    <div class="shape-row">${Object.entries(CREST_SHAPES).map(([k, [l]]) => `<button type="button" class="emb" data-a="crestSet" data-k="s" data-v="${k}">${crestHTML({ s: k, p: 'liso', c1: '#94a3b8', c2: '#94a3b8', e: 'ninguno' }, '', 36)}<span>${esc(l)}</span></button>`).join('')}</div>
    <label class="fl">3. Diseño del fondo<select data-crest="p" class="inp">${Object.entries(CREST_PATTERNS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>
    ${sw('c1', '4. Color principal')}${sw('c2', '5. Color secundario')}${sw('ce', '6. Color de la figura')}
    <div class="cr-lbl">O tome una idea lista</div>
    <div class="crest-gallery">${CREST_PRESETS.map((pr, i) => `<button type="button" data-a="crestPreset" data-i="${i}" aria-label="Escudo ${i + 1}">${crestHTML(pr, name || 'FC', 46)}</button>`).join('')}</div>
  </div>`;
}
const crestPreview = (cr, name) => (cr ? crestHTML(cr, name || '?', 96) : '<div class="crest-none">Sin escudo</div>');
function updateCrestUI() {
  if (!modal || (modal.type !== 'team' && modal.type !== 'cap')) return;
  const name = ($('#f-name') || {}).value || '';
  const prev = $('#crest-preview');
  if (prev) prev.innerHTML = crestPreview(modal.crest, name);
  const cr = modal.crest, made = cr && !cr.img;
  const maker = document.querySelector('.crest-maker');
  if (maker) maker.classList.toggle('is-img', !!(cr && cr.img));
  const def = { ce: '#ffffff' };
  document.querySelectorAll('[data-a="crestSet"]').forEach((b) => b.classList.toggle('on', !!made && (cr[b.dataset.k] || def[b.dataset.k]) === b.dataset.v));
  document.querySelectorAll('[data-crest]').forEach((sel) => { if (made && cr[sel.dataset.crest]) sel.value = cr[sel.dataset.crest]; });
}

/** Revisa el formulario del organizador. Devuelve los errores (rojo) y deja en checkPlayers.warns los avisos (amarillo). */
function checkPlayers() {
  checkPlayers.warns = 0;
  if (!modal || modal.type !== 'team') return 0;
  const idx = playerIndex(modal.id);
  const seen = new Map();
  let errors = 0, filled = 0;
  document.querySelectorAll('#f-players .prow').forEach((row) => {
    const inp = row.querySelector('.pl-name');
    const n = norm(inp.value);
    let msg = '', warn = '';
    if (n) {
      filled++;
      if (seen.has(n)) msg = `Repetido con el integrante ${seen.get(n)}`;
      else {
        seen.set(n, row.querySelector('.pn').textContent);
        // Puede ser otra persona con el mismo nombre: el organizador decide al guardar
        if (banOf(n)) warn = `⚠️ Mismo nombre que un jugador dado de baja de ${banOf(n).team} (intransferible). ¿Es otra persona?`;
        else if (idx.has(n)) warn = `⚠️ Mismo nombre que un jugador de ${idx.get(n)}. ¿Es otra persona?`;
        else { const sim = [...idx.keys()].find((k) => Rules.similarNames(n, k)); if (sim) warn = `⚠️ Nombre parecido a un jugador de ${idx.get(sim)}. ¿Es otra persona?`; }
      }
    }
    row.classList.toggle('bad', !!msg);
    row.classList.toggle('warn', !msg && !!warn);
    row.querySelector('.perr').textContent = msg || warn;
    if (msg) errors++;
    if (warn) checkPlayers.warns++;
  });
  const g = teamSize();
  const cnt = $('#f-count');
  if (cnt) { cnt.textContent = `(${filled} de ${g.max} · mínimo ${g.min} para participar)`; cnt.style.color = filled > g.max ? 'var(--bad)' : ''; }
  updateCrestUI();
  return errors;
}

async function saveTeam() {
  const t = T(), g = teamSize(t);
  const id = modal.id;
  const name = $('#f-name').value.trim().replace(/\s+/g, ' ');
  if (!name) return toast('Escriba el nombre del equipo');
  const dup = t.teams.find((x) => x.id !== id && norm(x.name) === norm(name));
  if (dup) return toast(`Ya existe un equipo "${dup.name}" en ${catName(S.cat)}`);
  if (checkPlayers() > 0) return toast('Hay integrantes repetidos (marcados en rojo)');
  const players = [];
  document.querySelectorAll('#f-players .prow').forEach((row) => {
    const pn = row.querySelector('.pl-name').value.trim().replace(/\s+/g, ' ');
    const nb = row.querySelector('.pl-num').value.trim();
    const cap = row.querySelector('.pl-cap');
    if (pn) players.push({ name: pn, num: nb, sub: row.dataset.sub === '1', rowPid: row.dataset.pid || '', ...(cap && cap.checked ? { cap: true } : {}) });
  });
  if (players.length < g.min) return toast(`En ${catName(S.cat)} se requieren al menos ${g.min} jugadores (hay ${players.length})`);
  if (players.length > g.max) return toast(`En ${catName(S.cat)} el máximo es de ${g.max} jugadores (hay ${players.length})`);
  const paid = num($('#f-paid').value);
  const crest = modal.crest || null;
  if (checkPlayers.warns && !(await ask(`${checkPlayers.warns} integrante(s) tienen el mismo nombre que un jugador de otro equipo o dado de baja (marcados en amarillo).\n\n¿Confirma que son personas distintas?`, { title: '⚠️ Nombres repetidos', ok: 'Sí, son distintas' }))) return;
  const tm0 = id ? teamById(id) : null;
  const teamId = id || uid();
  // Identificadores: mismo nombre = mismo jugador. Si en una fila se cambió el nombre, hay que saber si es
  // una corrección (conserva goles, tarjetas y suspensiones) o es otro jugador (empieza de cero).
  const renamed = matchPlayerIds(players, tm0 ? tm0.players : []);
  let keepRenamed = false;
  const online = tm0 && tm0.insc && sync.mode !== 'local';
  if (renamed.length && !online) {
    const how = await askChoice(`Cambió el nombre en: ${renamed.map((p) => `${p.oldName} → ${p.name}`).join(', ')}.\n\n¿Es la misma persona con el nombre corregido o es otro jugador?`,
      [{ key: 'C', label: '✏️ Misma persona (conserva goles y tarjetas)', value: 'fix', style: 'ghost' }, { key: 'N', label: '🆕 Otro jugador (empieza de cero)', value: 'new' }], { title: 'Nombres cambiados' });
    if (!how) return;
    keepRenamed = how === 'fix';
  }
  // Equipo que vino de la inscripción en línea: el cambio se copia también a la inscripción del capitán
  if (online) {
    const removed = tm0.players.filter((p) => !players.some((x) => norm(x.name) === norm(p.name))).map((p) => p.name);
    let baja;
    if (removed.length) {
      const how = await askChoice(`Quitó a: ${removed.join(', ')}.\n\n¿Es una baja (el jugador queda intransferible y no podrá jugar en otro equipo) o solo una corrección de un nombre mal escrito?`,
        [{ key: 'B', label: '➖ Es una baja', value: 'baja', style: 'danger' }, { key: 'C', label: '✏️ Solo corrección', value: 'fix', style: 'ghost' }], { title: 'Jugadores quitados' });
      if (!how) return;
      keepRenamed = how === 'fix'; // corrección de nombre: la misma persona conserva sus goles y tarjetas
      if (how === 'baja') {
        const r = await askText('Motivo de la baja (obligatorio, lo verá el capitán):', { title: 'Motivo de la baja' });
        if (r == null) return;
        if (r.trim().length < 10) return toast('Explique el motivo (al menos 10 letras)');
        baja = r.trim();
      }
    }
    try {
      const { status, j } = await admInsc({ action: 'adminSync', id: tm0.insc, name, crest, players: players.map((p) => ({ name: p.name, num: p.num, ...(p.cap ? { cap: true } : {}) })), baja });
      if (status === 401) return sessionExpired();
      if (status !== 200) return toast(j.error || 'No se pudo actualizar la inscripción del capitán');
      replaceReg(j.reg);
      if (baja) loadInsc(true);
    } catch (e) { return toast('Sin conexión: este equipo viene de la inscripción en línea y se necesita internet para editarlo'); }
  }
  if (!id && t.stage !== 'inscripcion') return toast('El sorteo ya se realizó');
  // Acuerdo: altas solo durante la primera vuelta. El organizador puede hacerlo después, pero confirmando.
  const added = players.filter((p) => !p.id && !(keepRenamed && renamed.includes(p)));
  if (tm0 && added.length && !Rules.inscWindows(Object.assign({}, inscOf(t), { open: true, from: 0 }), t, serverNow()).chOpen
    && !(await ask(`Terminó la primera vuelta: según el reglamento ya no se inscriben jugadores.\n\nAltas: ${added.map((p) => p.name).join(', ')}\n\n¿Las autorizó el comité?`, { title: '⚠️ Fuera de plazo', ok: 'Sí, autorizado' }))) return;
  if (keepRenamed) {
    renamed.forEach((p) => { p.id = p.rowPid; });
    // El nombre guardado en sus goles y tarjetas también se corrige (se ve así aunque luego salga del equipo)
    const fixed = new Map(renamed.map((p) => [p.id, p.name]));
    for (const m of t.matches) for (const ev of [...(m.goals || []), ...(m.cards || [])]) if (ev.team === teamId && fixed.has(ev.pid)) ev.player = fixed.get(ev.pid);
  }
  assignPlayerIds(teamId, players, tm0 ? tm0.players : []);
  players.forEach((p) => { delete p.rowPid; delete p.oldName; });
  if (id) {
    Object.assign(teamById(id), { name, players, paid, crest });
  } else {
    t.teams.push({ id: teamId, name, players, paid, crest, createdAt: Date.now() });
  }
  save(); closeModal(); render();
  toast(id ? 'Equipo actualizado' : `✅ ${name} inscrito`);
}

/* ---- partido ---- */
const elapsedMs = (m) => m.elapsed + (m.runAt ? Date.now() - m.runAt : 0);

/* ---- Hora del servidor: la espera de 15 minutos no depende del reloj de cada teléfono ---- */
function noteServerTime(r) {
  const d = r && r.headers && Date.parse(r.headers.get('Date') || '');
  if (d && !isNaN(d)) sync.skew = d - Date.now();
}
const serverNow = () => Date.now() + (sync.skew || 0);

/* ---- Reglas del día de partido (por categoría). Acuerdo del comité: 2 tiempos de 30, descanso de 5,
   espera de 15 minutos, mínimo 3 jugadores para iniciar, blanca = 2 minutos fuera, W.O. 2-0. ---- */
const MATCH_AGREE = { halves: 2, duration: 30, breakMin: 5, waitMin: 15, minStart: 3, whiteMin: 2, woGoals: 2 };
/** Reglas del partido de la categoría (rules.js, compartidas con el servidor). */
const matchRules = (c = T().config) => Rules.matchRules(c);
const matchAgreed = (c = T().config) => { const r = matchRules(c); return Object.keys(MATCH_AGREE).every((k) => Number(r[k]) === MATCH_AGREE[k]); };
const halvesOf = (m) => m.halves || 1;
const periodOf = (m) => m.period || 1;
const inBreak = (m) => !!m.breakAt;
/** Tiempo jugado en total (1er tiempo + lo que va del 2º): sirve para la tarjeta blanca. */
const playMs = (m) => (periodOf(m) === 2 && m.h1 ? m.h1.elapsed : 0) + elapsedMs(m);
/** Minuto del partido para goles y tarjetas (en el 2º tiempo sigue contando: 31', 32'…). */
const matchMinute = (m) => (periodOf(m) === 2 ? m.duration : 0) + Math.floor(elapsedMs(m) / 60000) + 1;
/** Hora programada, en la hora de El Salvador (rules.js: igual en el teléfono y en el servidor). */
const schedAt = Rules.schedAt;
/** Jugadores presentes de un equipo (null = aún no se pasó lista). */
const presentOf = Rules.presentOf;
/** Jugadores que están fuera por tarjeta blanca en este momento. */
const whiteOut = (m, tid) => (m.status !== 'live' ? [] : (m.cards || [])
  .filter((c) => c.type === 'W' && (!tid || c.team === tid) && c.wAt != null)
  .map((c) => Object.assign({}, c, { left: c.wAt + c.wMs - playMs(m) })).filter((c) => c.left > 0));
/** ¿Puede este jugador anotar? Devuelve el motivo si no puede. */
function cantPlay(m, tid, pid) {
  const p = playerById(tid, pid);
  if (suspendedIn(m, tid).some((x) => x.pid === pid)) return `${p ? p.name : 'El jugador'} está suspendido y no puede jugar este partido`;
  const pr = presentOf(m, tid);
  if (pr && !pr.includes(pid)) return `${p ? p.name : 'El jugador'} no está marcado como presente (márquelo en la presentación si llegó)`;
  if (whiteOut(m, tid).some((c) => c.pid === pid)) return `${p ? p.name : 'El jugador'} está fuera por tarjeta blanca`;
  return '';
}
const fmtClock = (ms) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

/** Estado del reloj: normal, en tiempo agregado o tiempo cumplido. */
function clockState(m) {
  const ms = elapsedMs(m), reg = m.duration * 60000, add = (m.added || 0) * 60000;
  if (ms < reg) return { phase: 'reg', ms };
  if (add && ms < reg + add) return { phase: 'add', ms, extra: ms - reg };
  return { phase: 'over', ms, extra: ms - reg };
}
/** Minuto para mostrar: 13', 20+2', 20'+ (en el 2º tiempo continúa: 31', 60+2'). En el descanso: "Descanso". */
function minuteText(m) {
  if (inBreak(m)) return 'Descanso';
  const st = clockState(m), base = (periodOf(m) - 1) * m.duration, d = base + m.duration;
  if (st.phase === 'reg') return base + Math.floor(st.ms / 60000) + 1 + "'";
  if (st.phase === 'add') return `${d}+${Math.floor(st.extra / 60000) + 1}'`;
  return m.added ? `${d}+${m.added}'` : d + "'+";
}
const periodName = (m) => (halvesOf(m) < 2 ? '' : periodOf(m) === 1 ? '1er tiempo' : '2º tiempo');
const breakLeft = (m) => (m.breakMin || 5) * 60000 - (Date.now() - m.breakAt);

function updateClock() {
  if (!modal || modal.type !== 'match') return;
  const m = mById(modal.id);
  // Cuenta regresiva de las tarjetas blancas (2 minutos de juego fuera)
  document.querySelectorAll('[data-wcd]').forEach((x) => {
    const c = m && (m.cards || []).find((cd) => cd.id === x.dataset.wcd);
    const left = c ? c.wAt + c.wMs - playMs(m) : 0;
    x.textContent = left > 0 ? fmtClock(left + 999) : 'puede volver';
    if (left <= 0 && x.dataset.done !== '1') { x.dataset.done = '1'; if (m.runAt) { toast(`⬜ ${evName(c)} puede volver a la cancha`); renderModal(); } }
  });
  // Terminó la espera reglamentaria: se habilita el botón de W.O.
  const wb = document.querySelector('[data-a="wo"][disabled]');
  if (wb && serverNow() >= Number(wb.dataset.woAt)) return renderModal();
  const el = $('#clock');
  if (!m || !el) return;
  const lab = $('#clock-lab');
  if (inBreak(m)) {
    const left = breakLeft(m);
    el.textContent = left > 0 ? fmtClock(left + 999) : '00:00';
    el.classList.toggle('over', left <= 0);
    if (lab) lab.textContent = left > 0 ? 'Descanso' : `Terminó el descanso (${m.breakMin || 5} min)`;
    return;
  }
  const st = clockState(m);
  el.textContent = fmtClock(st.ms);
  el.classList.toggle('add', st.phase === 'add');
  el.classList.toggle('over', st.phase === 'over');
  const pn = periodName(m) ? periodName(m) + ' · ' : '';
  if (lab) {
    lab.textContent = pn + (st.phase === 'add' ? `Tiempo agregado · ${minuteText(m)}`
      : st.phase === 'over' ? (m.added ? `Terminó el tiempo agregado (+${m.added}')` : 'Tiempo cumplido')
        : m.runAt ? 'En juego' : m.elapsed ? 'Pausado' : 'Sin iniciar');
  }
  if (!m.runAt || !canEditMatch(m)) return; // avisos de tiempo: organizador o árbitro del partido
  if (st.ms >= m.duration * 60000 && !m.alerted) {
    m.alerted = true; save();
    if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 600]);
    toast(`⏰ Se cumplieron los ${m.duration} minutos${pn ? ' del ' + periodName(m) : ''}${m.added ? ` · +${m.added}' de agregado` : ' · ¿agregar tiempo?'}`);
  }
  if (m.added && st.phase === 'over' && !m.alertedAdd) {
    m.alertedAdd = true; save();
    if (navigator.vibrate) navigator.vibrate([600, 200, 600]);
    toast(`⏰ Terminó el tiempo agregado (+${m.added}')`);
  }
}

/** Sanciones que salen de este partido (por tarjetas y del comité), con ajuste del comité para organizadores. */
function matchSanctionsHTML(m, adm) {
  const list = [m.home, m.away].flatMap((tid) => sanctionList(tid).filter((s) => s.matchId === m.id));
  if (!list.length && !adm) return '';
  let h = `<h3>⚖️ Sanciones de este partido</h3>`;
  h += list.length ? `<ul class="cardlist">${list.map((s) => `<li><span class="grow"><b>${esc(s.player)}</b> <small>${esc(tname(s.team))}</small><br>
      <small>${esc(s.why)}${s.kind === 'comite' ? ': ' + esc(s.extra.reason) : ''} → <b>${esc(sancText(s.n))}</b>${s.adj ? ` (regla: ${esc(sancText(s.base))} · ajustada por ${esc(s.adj.by)}: ${esc(s.adj.reason)})` : ''}</small></span>
      ${adm && s.kind === 'card' ? `<button class="btn ghost sm" data-a="sancAdj" data-team="${esc(s.team)}" data-pid="${esc(s.pid)}">Ajustar</button>` : ''}
      ${adm && s.kind === 'comite' ? `<button data-a="sancDel" data-id="${esc(s.extra.id)}" aria-label="Quitar sanción">✕</button>` : ''}</li>`).join('')}</ul>`
    : `<p class="muted" style="font-size:14px">Sin sanciones.</p>`;
  if (adm) h += `<button class="btn ghost sm" data-a="sancAdd">➕ Sanción del comité</button>`;
  return h;
}
/**
 * Presentación de jugadores al inicio: el árbitro marca quiénes llegaron (los suspendidos no se pueden marcar).
 * Para iniciar hace falta el mínimo por equipo (3). Pasados 15 minutos de la hora programada se puede declarar W.O.
 */
/**
 * ¿Se puede inscribir un jugador en la cancha? Acuerdo: durante la primera vuelta y si el equipo tiene cupo.
 * (La misma regla la aplica el servidor; vale aunque la inscripción en línea esté apagada.)
 */
function fieldAddOpen(tm) {
  if (!tm) return false;
  const cfg = inscOf();
  return tm.players.length < cfg.max && Rules.inscWindows(Object.assign({}, cfg, { open: true, from: 0 }), T(), serverNow()).chOpen;
}
/** Rol de un usuario según la lista que carga el organizador. */
const roleName = (u) => (orgs && orgs.roles && orgs.roles[u]) || 'admin';
const referees = () => (orgs ? orgs.users.filter((u) => roleName(u) === 'arbitro') : []);
/** Árbitro del partido: el organizador lo elige; los demás solo lo ven. */
function refPickHTML(m, adm) {
  if (adm && sync.mode !== 'local') {
    const list = referees();
    if (m.ref && !list.includes(m.ref)) list.unshift(m.ref);
    return `<label class="fl">🧑‍⚖️ Árbitro del partido<select id="m-ref"><option value="">Sin asignar (solo organizadores)</option>${list.map((u) => `<option value="${esc(u)}" ${m.ref === u ? 'selected' : ''}>${esc(u)}${roleName(u) === 'arbitro' ? '' : ' (ya no es árbitro)'}</option>`).join('')}</select></label>
      ${!list.length ? '<small class="muted">Para asignar, cree un usuario con rol <b>Árbitro</b> en Ajustes.</small>' : ''}`;
  }
  return m.ref ? `<p class="muted" style="text-align:center;margin:0 0 8px">🧑‍⚖️ Árbitro: <b>${esc(m.ref)}</b>${isMyMatch(m) ? ' (usted)' : ''}</p>` : '';
}
function lineupHTML(m, edit) {
  const R = matchRules(), adm = canEditMatch(m);
  if (!adm && !m.present) return '';
  const hh = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  let h = `<h3>📋 Presentación de jugadores</h3>`;
  if (edit) h += `<p class="muted" style="font-size:14px;margin-top:0">Toque a cada jugador que está presente. Para iniciar se necesitan al menos <b>${R.minStart}</b> por equipo.${m.status === 'live' ? ' Puede marcar a los que lleguen tarde.' : ''}</p>`;
  for (const tid of [m.home, m.away]) {
    const tm = teamById(tid), pr = presentOf(m, tid) || [], sus = new Set(suspendedIn(m, tid).map((x) => x.pid));
    const n = pr.length, short = n < R.minStart;
    h += `<div class="lineup"><div class="pick-h"><b>${esc(tname(tid))}</b> · presentes <b>${n}</b> de ${tm ? tm.players.length : 0}
      ${presentOf(m, tid) && short ? ` <span class="badge b-bad">faltan ${R.minStart - n} para poder iniciar</span>` : ''}
      ${m.startedWith && m.startedWith[tid] != null && m.startedWith[tid] < teamSize().starters ? ` <span class="badge b-warn">inició con ${m.startedWith[tid]}</span>` : ''}
      ${edit ? ` <button class="link" data-a="presentAll" data-team="${tid}">Marcar todos</button>` : ''}
      ${edit && fieldAddOpen(tm) ? ` <button class="link" data-a="addOnField" data-team="${tid}">➕ Inscribir jugador</button>` : ''}</div>
      <div class="pick-grid">${(tm ? tm.players : []).map((p) => {
        const on = pr.includes(p.id), s = sus.has(p.id);
        const label = `${p.num ? `<b>${esc(p.num)}</b> ` : ''}${esc(p.name)}${p.cap ? ' (C)' : ''}${s ? ' ⛔' : on ? ' ✓' : ''}`;
        return edit ? `<button data-a="present" data-team="${tid}" data-pid="${esc(p.id)}" class="${on ? 'sel' : ''}${s ? ' off' : ''}" ${s ? 'disabled title="Suspendido"' : ''}>${label}</button>`
          : `<button class="${on ? 'sel' : 'off'}" disabled>${label}</button>`;
      }).join('')}</div></div>`;
  }
  // Equipo que no se presenta: solo después de la espera reglamentaria
  if (edit && m.status === 'pend') {
    const at = schedAt(m), until = at + R.waitMin * 60000, can = !at || serverNow() >= until;
    h += `<div class="note ${can ? 'warn' : ''}" style="margin-top:6px">🕒 ${at ? (can ? `Ya pasaron los ${R.waitMin} minutos de espera (hora programada ${esc(m.time)}).` : `Espera reglamentaria: hasta las <b>${hh(until)}</b> (${R.waitMin} min después de la hora programada ${esc(m.time)}).`) : 'Este partido no tiene hora programada: la espera no se puede controlar.'}
      <div style="margin-top:8px"><button class="btn danger sm" data-a="wo" data-wo-at="${until}" ${can ? '' : 'disabled'}>🚫 Equipo no se presentó (W.O.)</button></div></div>`;
  }
  return h;
}
/** Opciones de cantidad de partidos para el comité. */
const sancChoices = () => [1, 2, 3, 4, 5, 6, 8, 10].map((n, i) => ({ key: String(i + 1), label: sancText(n), value: n, style: 'ghost' })).concat({ key: 'T', label: 'Todo el torneo', value: 'all', style: 'danger' });
function matchHTML(m) {
  const adm = isAdmin(), ctl = canEditMatch(m); // ctl = organizador o el árbitro asignado a este partido
  const done = m.status === 'done';
  const ready = !!(m.home && m.away);
  const edit = ctl && !done && ready;      // puede anotar
  const isKO = m.phase === 'ko';
  const side = (id, src, s, val) => `<div>
    ${id && teamById(id) && teamById(id).crest ? `<div class="mcrest-big">${crestHTML(teamById(id).crest, tname(id), 56)}</div>` : ''}
    <div class="tn">${esc(id ? tname(id) : srcLabel(src))}</div>
    <span class="big">${m.status === 'pend' && !adm ? '–' : val}</span>
    ${edit ? `<div class="stepper"><button class="minus" data-a="goal" data-s="${s}" data-d="-1" aria-label="Quitar gol">−</button><button data-a="goalPick" data-s="${s}" aria-label="Gol">+</button></div>` : ''}
  </div>`;

  let h = `<div class="mh"><h2>${esc(phaseLabel(m))}</h2><button class="x" data-a="close">✕</button></div><div class="mb">`;
  if (!ready) h += `<div class="note warn" style="margin-top:12px">Este partido se define cuando terminen los partidos anteriores.</div>`;
  h += `<div class="score">${side(m.home, m.srcH, 'h', m.hs)}<div class="vs">-</div>${side(m.away, m.srcA, 'a', m.as)}</div>`;
  // En vivo: fase del partido para todos (1er tiempo, Descanso, 2º tiempo, Penales…)
  if (m.status === 'live') h += `<p style="text-align:center;margin:0 0 8px"><span class="badge b-live"><i class="pulse"></i>EN VIVO</span> <b data-cphase="${m.id}">${esc(livePhase(m))}</b>${pensShown(m) || (m.shoot || []).length ? ` · penales ${m.ph || 0}-${m.pa || 0}` : ''}</p>`;
  if (edit && modal && modal.goalPick) {
    const tid = modal.goalPick === 'h' ? m.home : m.away, rival = modal.goalPick === 'h' ? m.away : m.home;
    const tm = teamById(tid), mode = modal.goalMode || 'g';
    const why = (p) => cantPlay(m, tid, p.id);
    const tag = (p) => (suspendedIn(m, tid).some((x) => x.pid === p.id) ? ' ⛔' : whiteOut(m, tid).some((c) => c.pid === p.id) ? ' ⬜' : why(p) ? ' (ausente)' : '');
    const chip = (k, label) => `<button class="btn sm ${mode === k ? '' : 'ghost'}" data-a="goalMode" data-m="${k}">${label}</button>`;
    h += `<div class="pick"><div class="pick-h">${mode === 'x' ? '❌ Penal fallado' : '⚽ Gol'} de <b>${esc(tname(tid))}</b> · ¿quién ${mode === 'x' ? 'lo tiró' : 'anotó'}?</div>
      <div class="row" style="margin-bottom:8px">${chip('g', '⚽ Gol')}${chip('p', '🎯 Gol de penal')}${chip('x', '❌ Penal fallado')}</div>
      <div class="pick-grid">${(tm ? tm.players : []).map((p) => `<button data-a="scorer" data-pid="${esc(p.id)}" ${why(p) ? `class="off" disabled title="${esc(why(p))}"` : ''}>${p.num ? `<b>${esc(p.num)}</b> ` : ''}${esc(p.name)}${tag(p)}</button>`).join('')}</div>
      <div class="row" style="margin-top:8px">
        ${mode === 'x' ? '' : `<button class="btn ghost sm" data-a="scorer" data-i="-1">Sin especificar</button>`}
        ${mode === 'g' ? `<button class="btn ghost sm" data-a="scorer" data-i="own">Autogol de ${esc(tname(rival))}</button>` : ''}
        <button class="btn danger sm" data-a="goalCancel">Cancelar</button>
      </div></div>`;
  }
  const goalsList = (m.goals || []).filter((g) => g.player || g.own || g.pen);
  const missList = m.penMiss || [];
  if (goalsList.length || missList.length) {
    const items = [...goalsList.map((g) => ({ g, min: g.min })), ...missList.map((x) => ({ x, min: x.min }))].sort((a, b) => a.min - b.min);
    h += `<ul class="goals">${items.map(({ g, x }) => (g
      ? `<li class="${g.team === m.home ? 'gh' : 'ga'}">⚽ <b>${esc(g.own ? 'Autogol' : g.player ? evName(g) : 'Gol')}</b> <small>${g.min}'${g.pen ? ' · penal' : ''}${g.own ? ' · de ' + esc(g.from || 'rival') : ''}</small></li>`
      : `<li class="${x.team === m.home ? 'gh' : 'ga'}">❌ <b>${esc(x.player ? evName(x) : tname(x.team))}</b> <small>${x.min}' · penal fallado</small>${edit ? ` <button data-a="penMissDel" data-id="${x.id}" aria-label="Quitar">✕</button>` : ''}</li>`)).join('')}</ul>`;
  }
  if (m.wo) {
    h += `<div class="note warn" style="margin:8px 0">🚫 <b>${m.wo === 'both' ? 'Ninguno de los dos equipos se presentó' : `${esc(tname(m.wo))} no se presentó`}</b>${m.wo === 'both' ? ' · ambos pierden' : ` · gana ${esc(tname(m.wo === m.home ? m.away : m.home))} ${m.hs}-${m.as}`}<br><small>Declarado por ${esc(m.woBy || '')} · ${esc(fmtWhen(m.woAt))}${m.woNote ? ' · ' + esc(m.woNote) : ''}</small></div>`;
  }
  if (done) {
    const w = winner(m);
    h += `<p style="text-align:center;margin:0 0 6px;font-weight:700">${w ? `🏆 Ganó ${esc(tname(w))}${!m.tieOf && pensShown(m) ? ` (penales ${m.ph}-${m.pa})` : ''}` : '🤝 Empate'}${m.tieLeg === 1 ? ' <small class="muted">(ida)</small>' : ''}</p>`;
  }
  if (m.tieLeg) {
    // Serie de ida y vuelta: solo puntos; si empatan en puntos, penales al final de la vuelta
    const vuelta = m.tieLeg === 2 ? m : T().matches.find((x) => x.tieOf === m.id);
    const note = vuelta ? seriesNote(vuelta) : '';
    h += `<div class="note" style="margin:8px 0">🔁 <b>Serie de ida y vuelta por puntos</b> (los goles no cuentan; empate en puntos = penales al final de la vuelta).${note ? '<br>' + esc(note) : ''}${pensShown(vuelta || {}) ? ` · penales ${vuelta.ph}-${vuelta.pa}` : ''}</div>`;
  }

  // Programación (fecha, hora, cancha)
  if (adm) {
    h += `<div class="grid3">
      <label class="fl">Fecha<input type="date" id="m-date" value="${esc(m.date || '')}"></label>
      <label class="fl">Hora<input type="time" id="m-time" value="${esc(m.time || '')}"></label>
      <label class="fl">Cancha<input id="m-field" maxlength="12" placeholder="—" value="${esc(m.field || '')}"></label>
    </div>`;
  } else {
    h += `<p class="muted" style="text-align:center;margin:4px 0 8px">${m.date ? '📅 ' + esc(dayLabel(m.date)) : 'Fecha por definir'}${m.time ? ' · 🕒 ' + esc(m.time) : ''}${m.field ? ' · Cancha ' + esc(m.field) : ''}</p>`;
  }

  h += refPickHTML(m, adm);
  if (ready && !done) h += lineupHTML(m, edit);

  if (!done && (ctl || m.status === 'live')) {
    const running = !!m.runAt, two = (m.status === 'pend' ? matchRules().halves : halvesOf(m)) > 1;
    const pLab = two ? (m.status === 'pend' ? '1er tiempo · ' : inBreak(m) ? '' : periodName(m) + ' · ') : '';
    let btns;
    if (inBreak(m)) btns = `<button class="btn sm" data-a="secondHalf">▶ Iniciar 2º tiempo</button>`;
    else if (running) btns = `<button class="btn ghost sm" data-a="pause">⏸ Pausar</button>${two && periodOf(m) === 1 ? `<button class="btn ghost sm" data-a="endHalf">☕ Fin del 1er tiempo (descanso)</button>` : ''}`;
    else btns = `<button class="btn sm" data-a="start" ${ready ? '' : 'disabled'}>▶ ${m.status === 'pend' ? 'Iniciar partido' : m.elapsed ? 'Reanudar' : 'Iniciar'}</button>${two && periodOf(m) === 1 && m.status === 'live' ? `<button class="btn ghost sm" data-a="endHalf">☕ Fin del 1er tiempo (descanso)</button>` : ''}`;
    h += `<div class="timer">
      <div><div class="clock" id="clock">00:00</div><small id="clock-lab">${inBreak(m) ? 'Descanso' : pLab + (running ? 'En juego' : m.elapsed ? 'Pausado' : 'Sin iniciar')}</small></div>
      ${ctl ? `<div class="dur">${two ? 'Cada tiempo' : 'Tiempo'}${adm ? `<input type="number" inputmode="numeric" min="1" id="m-dur" value="${m.duration}">min` : ` ${m.duration} min`}</div>
      <div class="row" style="width:100%">${btns}</div>
      ${inBreak(m) ? '' : `<div class="added">
        <span>Tiempo agregado: <b>+${m.added || 0}'</b></span>
        <span class="row" style="flex-wrap:nowrap">
          <button class="btn ghost sm" data-a="addTime" data-n="-1" ${m.added ? '' : 'disabled'} aria-label="Quitar un minuto">−1'</button>
          <button class="btn ghost sm" data-a="addTime" data-n="1">+1'</button>
          <button class="btn ghost sm" data-a="addTime" data-n="2">+2'</button>
          <button class="btn ghost sm" data-a="addTime" data-n="3">+3'</button>
          <button class="btn ghost sm" data-a="addTime" data-n="5">+5'</button>
        </span>
      </div>`}` : `<div class="dur">${inBreak(m) ? `Descanso de ${m.breakMin || 5} min` : `${two ? `${periodName(m) || '1er tiempo'} · ` : ''}de ${m.duration} min`}${m.added ? ` <b>+${m.added}'</b>` : ''}</div>`}</div>`;
  } else if (done && !m.wo) {
    const two = halvesOf(m) > 1;
    h += `<p class="muted" style="text-align:center;margin:0">Partido finalizado · ${two ? `2 tiempos de ${m.duration} min` : `${m.duration} min`}${m.h1 && m.h1.added ? ` · 1T +${m.h1.added}'` : ''}${m.added ? ` · ${two ? '2T ' : ''}+${m.added}' agregado` : ''}</p>`;
  }

  if (isKO && ready && needsPens(m) && (edit || m.ph != null)) {
    const kicks = m.shoot || [];
    const row = (tid) => kicks.filter((k) => k.team === tid).map((k) => (k.scored ? '✅' : '❌')).join(' ') || '—';
    h += `<h3>Penales ${m.tieOf ? '(serie empatada en puntos)' : '(empate)'}</h3>
      ${edit ? `<div class="grid2" style="margin-bottom:8px">${[m.home, m.away].map((tid) => `<div class="card" style="padding:10px;margin:0"><b>${esc(tname(tid))}</b><div style="margin:6px 0;font-size:18px">${row(tid)}</div>
        <div class="row"><button class="btn sm" data-a="kick" data-team="${tid}" data-ok="1">✅ Anotó</button><button class="btn ghost sm" data-a="kick" data-team="${tid}" data-ok="0">❌ Falló</button></div></div>`).join('')}</div>
        ${kicks.length ? `<button class="btn ghost sm" data-a="kickUndo">↩️ Deshacer último tiro</button>` : ''}` : kicks.length ? `<p class="muted" style="text-align:center">${esc(tname(m.home))}: ${row(m.home)}<br>${esc(tname(m.away))}: ${row(m.away)}</p>` : ''}
      <div class="pens">
      <input type="number" inputmode="numeric" min="0" id="m-ph" value="${m.ph ?? ''}" ${edit ? '' : 'disabled'} placeholder="0">
      <span>-</span>
      <input type="number" inputmode="numeric" min="0" id="m-pa" value="${m.pa ?? ''}" ${edit ? '' : 'disabled'} placeholder="0"></div>
      ${edit ? '<small class="muted">Marque cada tiro o escriba el total directamente.</small>' : ''}`;
  }

  // Suspendidos para este partido
  if (ready && m.status !== 'done') {
    const sus = [m.home, m.away].flatMap((tid) => suspendedIn(m, tid).map((x) => ({ ...x, tid })));
    if (sus.length) h += `<div class="note warn" style="margin-top:12px"><b>⛔ No pueden jugar este partido:</b><br>${sus.map((x) => `${esc(x.player)} (${esc(tname(x.tid))}) · ${esc(x.reason)}`).join('<br>')}</div>`;
  }

  // Tarjetas
  if (ready && (adm || m.cards.length)) {
    h += `<h3>Tarjetas</h3>`;
    if (edit) {
      const selTeam = modal && modal.cardTeam && [m.home, m.away].includes(modal.cardTeam) ? modal.cardTeam : m.home;
      const tm = teamById(selTeam), off = new Set(suspendedIn(m, selTeam).map((x) => x.pid)), pr = presentOf(m, selTeam);
      const wm = matchRules().whiteMin;
      h += `<div class="cardform">
        <select id="c-team" class="inp">${[m.home, m.away].map((id) => `<option value="${id}" ${id === selTeam ? 'selected' : ''}>${esc(tname(id))}</option>`).join('')}</select>
        <input id="c-min" type="number" inputmode="numeric" min="0" placeholder="Minuto (auto)">
        <select id="c-player" class="inp full">${(tm ? tm.players : []).map((p) => { const no = off.has(p.id) ? ' ⛔ suspendido' : pr && !pr.includes(p.id) ? ' (ausente)' : ''; return `<option value="${esc(p.id)}" ${no ? 'disabled' : ''}>${p.num ? esc(p.num) + ' · ' : ''}${esc(p.name)}${no}</option>`; }).join('')}</select>
        <button class="btn cy" data-a="card" data-type="Y">🟨 Amarilla</button>
        <button class="btn cr" data-a="card" data-type="R">🟥 Roja</button>
        <button class="btn ghost sm" data-a="card" data-type="W">⬜ Blanca (${wm}' fuera)</button>
        <button class="btn danger sm" data-a="card" data-type="R" data-agg="1">🟥 Roja con agresión</button>
      </div>`;
    }
    const outs = whiteOut(m);
    if (outs.length) h += `<div class="note warn" style="margin-top:8px"><b>⬜ Fuera por tarjeta blanca:</b><br>${outs.map((c) => `${esc(evName(c))} (${esc(tname(c.team))}) · vuelve en <b data-wcd="${c.id}">${fmtClock(c.left + 999)}</b> de juego`).join('<br>')}</div>`;
    const list = [...m.cards].sort((a, b) => a.min - b.min);
    h += list.length ? `<ul class="cardlist">${list.map((cd) => `<li><span class="chip ${cd.type}"></span>
      <span class="grow"><b>${esc(evName(cd))}</b> <small>${esc(tname(cd.team))}</small></span>
      <small>${cd.min}'${cd.type === 'W' ? ` · blanca (${Math.round((cd.wMs || 120000) / 60000)}' fuera)` : ''}${cd.auto ? ' · doble amarilla' : ''}${cd.agg ? ' · con agresión' : ''}</small>${edit && !cd.auto ? `<button data-a="delCard" data-id="${cd.id}" aria-label="Quitar">✕</button>` : ''}</li>`).join('')}</ul>`
      : `<p class="muted" style="font-size:14px">Sin tarjetas.</p>`;
  }
  if (ready) h += matchSanctionsHTML(m, adm);
  h += `</div><div class="mf">`;
  if (ready && done && adm) h += `<button class="btn ghost block" data-a="reopen">✏️ Corregir resultado</button>`;
  else if (ready && !done && ctl) h += `<button class="btn block" data-a="finish">✅ Finalizar partido</button>`;
  if (done && isMyMatch(m)) h += `<p class="muted" style="text-align:center;font-size:13px;margin:6px 0 0">Partido finalizado. Si hay que corregir algo, avise a un organizador.</p>`;
  if (adm && T().config.format === 'manual' && m.phase !== 'ko' && m.status === 'pend' && !T().manualClosed) {
    h += `<button class="btn danger block sm" data-a="manualDelete" data-id="${m.id}">Eliminar este partido</button>`;
  }
  h += `</div>`;
  return h;
}

function curMatch() { return modal && modal.type === 'match' ? mById(modal.id) : null; }
/** El partido abierto, solo si este usuario puede anotar en él (organizador o su árbitro). */
function editMatch() { const m = curMatch(); return canEditMatch(m) ? m : null; }

function finishMatch() {
  const m = editMatch(); if (!m) return;
  if (m.tieOf) {
    const ida = mById(m.tieOf);
    if (!ida || ida.status !== 'done') return toast('Primero finalice el partido de ida de esta serie');
  }
  if (needsPens(m)) {
    const ph = $('#m-ph') ? $('#m-ph').value : '', pa = $('#m-pa') ? $('#m-pa').value : '';
    if (ph === '' || pa === '' || +ph === +pa) return toast(m.tieOf ? 'La serie quedó empatada en puntos: ingrese los penales' : 'En eliminación debe haber ganador: ingrese los penales');
    m.ph = +ph; m.pa = +pa;
  } else { m.ph = null; m.pa = null; }
  let extra = '';
  if (m.tieOf) {
    const s = seriesPts(m);
    const w = s.pa !== s.pb ? (s.pa > s.pb ? s.a : s.b) : (m.ph > m.pa ? m.home : m.away);
    extra = `\n\nSerie por puntos: ${tname(s.a)} ${s.pa} · ${tname(s.b)} ${s.pb}${s.pa === s.pb ? ` (penales ${m.ph}-${m.pa})` : ''}\nAvanza: ${tname(w)}`;
  }
  return ask(`${tname(m.home)} ${m.hs} - ${m.as} ${tname(m.away)}${!m.tieOf && m.ph != null ? `  (penales ${m.ph}-${m.pa})` : ''}${extra}`, { title: '✅ ¿Finalizar el partido?', ok: 'Finalizar' })
    .then((ok) => { if (ok) finishNow(m); });
}
function finishNow(m) {
  if (m.runAt) { m.elapsed += Date.now() - m.runAt; m.runAt = null; }
  m.status = 'done';
  syncKO();
  save(); closeModal(); render();
  const w = winner(m), adv = m.tieOf ? tieWinner(m) : null;
  toast(adv ? `🏁 Avanza ${tname(adv)} (serie por puntos)` : w ? `🏆 Gana ${tname(w)}` : 'Partido finalizado (empate)');
  // Se corrigió la ida con la vuelta ya jugada: si ahora la serie queda empatada sin penales, avisar
  if (m.tieLeg === 1) {
    const v = T().matches.find((x) => x.tieOf === m.id);
    if (v && v.status === 'done' && !tieWinner(v)) setTimeout(() => toast('⚠️ La serie quedó empatada en puntos: corrija el partido de vuelta e ingrese los penales'), 2600);
  }
}

function reopenMatch() {
  const m = curMatch(); if (!m || !isAdmin()) return; // corregir un resultado: solo organizadores
  const t = T();
  if (m.phase !== 'ko' && t.stage === 'final' && t.config.format !== 'elim') {
    return toast('Primero use "Deshacer fase final" en Partidos para corregir esta fase');
  }
  const go = () => {
    if (m.wo) { Object.assign(m, { wo: null, woAt: null, woBy: null, woNote: '', hs: 0, as: 0, status: 'pend' }); } // anular el W.O.
    else m.status = 'live';
    m.ph = null; m.pa = null; m.shoot = []; syncKO(); save(); render();
  };
  if (m.phase === 'ko') {
    // De la ida de una serie dependen los partidos que siguen a su vuelta
    const ids = [m.id, ...t.matches.filter((x) => x.tieOf === m.id).map((x) => x.id)];
    const dep = t.matches.some((x) => x.status !== 'pend' && [x.srcH, x.srcA].some((s) => s && (ids.includes(s.w) || ids.includes(s.l))));
    if (dep) return ask('Los partidos siguientes que dependen de este se reiniciarán.', { title: '✏️ Corregir resultado', ok: 'Continuar' }).then((ok) => { if (ok) go(); });
  }
  go();
}

/* ---------------- Base de datos en línea ---------------- */
const payload = () => ({ torneos: S.torneos });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function saveSync() {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify({ rev: sync.rev, base: sync.base, dirty: sync.dirty })); } catch (e) { /* nada */ }
}
function schedulePush(ms = 400) { clearTimeout(sync.timer); sync.timer = setTimeout(push, ms); }

async function apiCall(method, body, query = '', path = 'api/state') {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && auth.token) headers.Authorization = 'Bearer ' + auth.token;
  const r = await fetch(path + query, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  noteServerTime(r);
  let j = null;
  try { j = await r.json(); } catch (e) { /* respuesta no JSON (sin API) */ }
  return { status: r.status, j };
}
const authCall = (body) => apiCall(body ? 'POST' : 'GET', body, '', 'api/auth');

/* ---- Sesión de organizadores ---- */
async function checkSetup() {
  try {
    const { status, j } = await authCall();
    if (status === 200 && j) {
      const was = sync.needSetup;
      sync.needSetup = !!j.setup;
      if (was !== sync.needSetup && !isAdmin() && S.tab === 'ajustes') requestRender();
    }
  } catch (e) { /* sin conexión */ }
}

async function doLogin() {
  const user = $('#l-user').value.trim().toLowerCase();
  const pass = $('#l-pass').value;
  if (!user || !pass) return toast('Escriba usuario y contraseña');
  const setup = sync.needSetup;
  if (setup && pass !== $('#l-pass2').value) return toast('Las contraseñas no coinciden');
  try {
    const { status, j } = await authCall({ action: setup ? 'setup' : 'login', user, pass });
    if (status === 409 && setup) { sync.needSetup = false; render(); return toast(j.error); }
    if (status !== 200) return toast((j && j.error) || 'No se pudo ingresar');
    setAuth({ user: j.user, token: j.token, role: j.role || 'admin' });
    sync.needSetup = false;
    // empezar desde lo que hay en línea para no subir datos viejos de este teléfono
    sync.dirty = false; sync.rev = -1;
    S.tab = 'inicio';
    render();
    toast(j.role === 'arbitro' ? `🧑‍⚖️ Bienvenido, ${j.user} (árbitro). Sus partidos están en Partidos.` : `👋 Bienvenido, ${j.user}`);
    pull(true);
  } catch (e) {
    toast('Sin conexión. Intente de nuevo.');
  }
}

async function loadOrgs() {
  const { status, j } = await authCall({ action: 'list' });
  if (status === 401) return sessionExpired();
  if (status === 200) { orgs = j; if (S.tab === 'ajustes') requestRender(); }
}

function sessionExpired() {
  setAuth(null); orgs = null;
  sync.dirty = false; sync.rev = -1;
  toast('La sesión terminó. Ingrese de nuevo.');
  render();
  pull(true);
}

/** Combina cambios locales (local vs base) sobre lo que hay en el servidor (remote). */
function mergeList(L, B, R, itemMerge) {
  L = L || []; B = B || []; R = R || [];
  const bm = new Map(B.map((x) => [x.id, x]));
  const lm = new Map(L.map((x) => [x.id, x]));
  let out = R.filter((x) => !(bm.has(x.id) && !lm.has(x.id))); // borrados aquí
  for (const l of L) {
    const b = bm.get(l.id);
    if (b && same(b, l)) continue;                // sin cambios locales
    const i = out.findIndex((x) => x.id === l.id);
    if (i >= 0) out[i] = itemMerge && b ? itemMerge(l, b, out[i]) : l; // modificado aquí
    else if (!b) out.push(l);                     // nuevo aquí
  }
  return out;
}
/** Combina campo por campo: solo se aplican los campos que cambiaron en este teléfono. */
function mergeFields(L, B, R, lists = [], deltas = []) {
  const o = clone(R);
  for (const k of new Set([...Object.keys(L), ...Object.keys(B)])) {
    if (same(L[k], B[k])) continue;
    if (lists.includes(k)) o[k] = mergeList(L[k], B[k], R[k]);
    else if (deltas.includes(k) && typeof L[k] === 'number' && typeof B[k] === 'number') o[k] = Math.max(0, (R[k] || 0) + (L[k] - B[k]));
    else o[k] = clone(L[k]);
  }
  return o;
}
/** Partido: goles y tarjetas se suman de ambos lados; el marcador se combina por diferencia. */
const mergeMatch = (L, B, R) => {
  const o = mergeFields(L, B, R, ['cards', 'goals', 'sancExtra', 'penMiss', 'shoot'], ['hs', 'as']);
  // Un partido FINALIZADO en el servidor no se reabre por cambios de otro teléfono
  // (solo si este organizador lo había finalizado y lo reabrió con "Corregir resultado").
  if (R.status === 'done' && L.status !== 'done' && B.status !== 'done') {
    for (const k of ['status', 'runAt', 'elapsed', 'ph', 'pa']) o[k] = R[k];
    mergeNotices.push('Un partido ya había sido finalizado por otro organizador; se mantuvo su resultado.');
  }
  // Si aquí se finalizó, el marcador final es el de este teléfono más los goles que el otro haya sumado
  return o;
};
const mergeTeam = (L, B, R) => mergeFields(L, B, R);
let mergeNotices = [];
/** Combina objetos por clave (torneos o categorías): altas, bajas y cambios de ambos lados. */
function mergeKeyed(L, B, R, mergeItem) {
  L = L || {}; B = B || {}; R = R || {};
  const out = {};
  for (const k of [...new Set([...Object.keys(R), ...Object.keys(L)])]) {
    const inL = k in L, inB = k in B, inR = k in R;
    if (inB && !inL) continue;                                    // eliminado aquí
    if (inB && !inR) { if (!same(L[k], B[k])) out[k] = clone(L[k]); continue; } // eliminado en otro teléfono
    if (!inR) { out[k] = clone(L[k]); continue; }                 // nuevo aquí
    if (!inL) { out[k] = clone(R[k]); continue; }                 // nuevo en otro teléfono
    out[k] = mergeItem(L[k], B[k], R[k]);
  }
  return out;
}
function mergeTorneo(L, B, R) {
  B = B || {};
  const o = clone(R);
  for (const k of ['name', 'org', 'contact', 'rules']) if (L[k] !== B[k]) o[k] = L[k];
  if (!same(L.config, B.config)) o.config = L.config;
  o.cats = mergeKeyed(L.cats, B.cats, R.cats, mergeCat);
  return o;
}
function rebase(local, base, remote) {
  return { torneos: mergeKeyed(local.torneos, base && base.torneos, remote && remote.torneos, mergeTorneo) };
}
function mergeCat(L, B, R) {
  {
    B = B || newTournament();
    const o = clone(R);
    if (L.name !== B.name) o.name = L.name;
    if (L.color !== B.color) o.color = L.color;
    if (!same(L.config, B.config)) o.config = L.config;
    const drawL = !same(L.groups, B.groups), drawR = !same(R.groups, B.groups);
    const koIds = (x) => (x.matches || []).filter((m) => m.phase === 'ko').map((m) => m.id).sort().join();
    const koL = koIds(L) !== koIds(B), koR = koIds(R) !== koIds(B);
    const meta = ['drawInfo', 'finalInfo', 'tieOverride', 'drawLog', 'manualClosed'];
    if (drawL && drawR) {
      // Ambos sortearon a la vez: se mantiene el sorteo que llegó primero al servidor
      mergeNotices.push(`Otro organizador ya había realizado el sorteo de ${R.name || 'la categoría'}. Se mantiene ese sorteo.`);
    } else if (drawL) {
      o.groups = L.groups; o.stage = L.stage; o.matches = L.matches;
      meta.forEach((k) => { o[k] = L[k]; });
    } else if (koL && koR) {
      // Ambos generaron o deshicieron la fase final: se mantiene la del servidor, se combina la fase 1
      const p1 = (x) => (x.matches || []).filter((m) => m.phase !== 'ko');
      o.matches = mergeList(p1(L), p1(B), p1(R), mergeMatch).concat(R.matches.filter((m) => m.phase === 'ko'));
      mergeNotices.push(`Otro organizador ya había cambiado la fase final de ${R.name || 'la categoría'}. Se mantiene la suya.`);
    } else {
      if (L.stage !== B.stage) o.stage = L.stage;
      meta.forEach((k) => { if (!same(L[k], B[k])) o[k] = L[k]; });
      o.matches = mergeList(L.matches, B.matches, R.matches, mergeMatch);
    }
    o.teams = mergeList(L.teams, B.teams, R.teams, mergeTeam);
    syncKO(o);
    return o;
  }
}

function isBusy() {
  const a = document.activeElement;
  return (modal && (modal.type === 'team' || modal.type === 'cap')) || (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.type !== 'radio');
}
function requestRender() {
  if (isBusy()) sync.pendingRender = true;
  else render();
}

function adopt(j) {
  if (!sync.known && totalTeams(S) > 0 && !same(payload(), j.data)) {
    try { localStorage.setItem('torneo-respaldo-local', JSON.stringify(S)); } catch (e) { /* nada */ }
  }
  const d = normalizeData(clone(j.data));
  if (d) S.torneos = d.torneos;
  fixSelection(S);
  Object.assign(sync, { rev: j.rev, base: clone(payload()), dirty: false, known: true });
  saveLocal(); saveSync();
  requestRender();
}

function setMode(m, touch = true) {
  const wasAdmin = isAdmin();
  sync.mode = m;
  if (wasAdmin !== isAdmin()) requestRender();
  if (m === 'online' && touch) sync.last = Date.now();
  const dot = $('#sync');
  if (dot) { dot.className = 'sync ' + m; dot.title = syncText(); }
  const st = $('#sync-status');
  if (st) st.textContent = syncText();
}
function syncText() {
  switch (sync.mode) {
    case 'online': return `✅ Conectado. Todos los teléfonos ven los mismos datos. Última sincronización: ${new Date(sync.last).toLocaleTimeString()}`;
    case 'saving': return '⏳ Guardando en línea…';
    case 'offline': return '⚠️ Sin conexión. Los cambios quedan en este teléfono y se enviarán al volver la señal.';
    case 'local': return 'Sin base de datos: los datos se guardan solo en este teléfono.';
    default: return 'Conectando…';
  }
}

async function pull(full) {
  if (sync.mode === 'local' || sync.pushing) return;
  try {
    const q = !full && sync.mode === 'online' ? `?since=${sync.rev}` : '';
    const { status, j } = await apiCall('GET', null, q);
    if (status === 404 || status === 501 || !j) return setMode('local');
    if (status !== 200) throw new Error(status);
    setMode('online');
    if (j.same) { if (sync.dirty) schedulePush(0); return; }
    if (!j.data) {                                   // base vacía: subir lo de este teléfono
      if (isAdmin() && totalTeams(S) > 0) { sync.dirty = true; sync.rev = j.rev; schedulePush(0); }
      return;
    }
    if (sync.dirty && sync.known && signedIn()) return schedulePush(0); // push combina si hay conflicto
    if (j.rev !== sync.rev || !sync.known) adopt(j);
  } catch (e) {
    setMode('offline');
  }
}

async function push() {
  if (sync.mode === 'local' || !sync.dirty || sync.pushing || !signedIn()) return;
  if (isRef()) return pushRef(); // el árbitro solo envía sus partidos
  sync.pushing = true;
  setMode('saving');
  try {
    for (let i = 0; i < 6 && sync.dirty; i++) {
      const sent = JSON.stringify(payload());
      const { status, j } = await apiCall('PUT', { baseRev: sync.rev, data: JSON.parse(sent) });
      if (status === 200) {
        sync.rev = j.rev; sync.base = JSON.parse(sent); sync.known = true;
        sync.dirty = JSON.stringify(payload()) !== sent;
      } else if (status === 409) {
        if (j && j.data) {
          const remote = normalizeData(clone(j.data)) || { torneos: {} };
          mergeNotices = [];
          S.torneos = rebase(payload(), sync.base, remote).torneos;
          if (mergeNotices.length) toast('ℹ️ ' + mergeNotices.join(' '));
          fixSelection(S);
          sync.base = remote;
          saveLocal(); requestRender();
        }
        sync.rev = j ? j.rev : 0;
      } else if (status === 401) {
        sync.pushing = false;
        return sessionExpired();
      } else if (status === 404 || status === 501) {
        return setMode('local');
      } else {
        throw new Error(status);
      }
    }
    setMode('online');
  } catch (e) {
    setMode('offline');
  } finally {
    sync.pushing = false;
    saveSync();
  }
}

/* ---- Árbitro: envía solo los partidos que cambió en este teléfono, uno por uno, a /api/match ---- */
/** Partidos que cambiaron aquí respecto de lo último recibido del servidor: [{tor, cat, L, B}]. */
function refChanges() {
  const out = [];
  const base = (sync.base && sync.base.torneos) || {};
  for (const [tk, tor] of Object.entries(S.torneos)) {
    for (const [ck, c] of Object.entries(tor.cats || {})) {
      const bc = base[tk] && base[tk].cats && base[tk].cats[ck];
      for (const L of c.matches) {
        const B = bc && bc.matches.find((x) => x.id === L.id);
        if (B && !same(L, B)) out.push({ tor: tk, cat: ck, L, B });
      }
    }
  }
  return out;
}
/** Toma los datos del servidor y vuelve a poner encima los partidos que aún no se enviaron. */
function adoptKeeping(j, pending) {
  const d = normalizeData(clone(j.data));
  if (!d) return;
  sync.base = clone({ torneos: d.torneos });
  for (const p of pending) {
    const c = d.torneos[p.tor] && d.torneos[p.tor].cats[p.cat];
    const i = c ? c.matches.findIndex((x) => x.id === p.L.id) : -1;
    if (i >= 0) c.matches[i] = clone(p.L);
  }
  S.torneos = d.torneos; fixSelection(S);
  sync.rev = j.rev; sync.known = true;
  sync.dirty = pending.length > 0;
  saveLocal(); requestRender();
}
async function pushRef() {
  sync.pushing = true;
  setMode('saving');
  try {
    for (let k = 0; k < 8; k++) {
      const changes = refChanges();
      if (!changes.length) { sync.dirty = false; break; }
      const c = changes[0], sent = clone(c.L); // copia: el árbitro puede seguir anotando mientras se envía
      const { status, j } = await apiCall('POST', { action: 'save', tor: c.tor, cat: c.cat, match: sent, base: c.B }, '', 'api/match');
      if (status === 200 && j && j.data) {
        // Quedan pendientes los demás partidos y este solo si se volvió a cambiar durante el envío
        adoptKeeping(j, refChanges().filter((x) => !(x.L.id === sent.id && same(x.L, sent))));
      } else if (status === 409 && j && j.data) {
        // Otro teléfono cambió el mismo partido: se combinan (goles y tarjetas de ambos) y se vuelve a enviar
        const remote = normalizeData(clone(j.data));
        const R = remote && remote.torneos[c.tor] && remote.torneos[c.tor].cats[c.cat] && remote.torneos[c.tor].cats[c.cat].matches.find((x) => x.id === sent.id);
        const pend = refChanges().map((x) => (x.L.id === sent.id && R ? Object.assign({}, x, { L: mergeMatch(x.L, x.B, R) }) : x));
        mergeNotices = [];
        adoptKeeping(j, pend);
        if (mergeNotices.length) toast('ℹ️ ' + mergeNotices.join(' '));
      } else if (status === 401) {
        sync.pushing = false;
        return sessionExpired();
      } else if (status === 404 || status === 501) {
        return setMode('local');
      } else if (status >= 400 && status < 500) {
        // El servidor rechazó el cambio (fuera de sus permisos o contra el reglamento): se descarta y se recarga
        toast('⛔ ' + ((j && j.error) || 'El servidor no aceptó el cambio'));
        sync.dirty = false; sync.pushing = false;
        await pull(true);
        return;
      } else {
        throw new Error(status);
      }
    }
    setMode('online');
  } catch (e) {
    setMode('offline');
  } finally {
    sync.pushing = false;
    saveSync();
  }
}
/** Al abrir la app con una sesión guardada, se confirma el rol con el servidor (un organizador pudo cambiarlo). */
async function refreshRole() {
  if (!auth || !auth.token) return;
  try {
    const { status, j } = await authCall({ action: 'me' });
    if (status === 401) return sessionExpired();
    if (status === 200 && j.role && j.role !== auth.role) { setAuth(Object.assign({}, auth, { role: j.role })); requestRender(); }
  } catch (e) { /* sin conexión: se usa el rol guardado */ }
}

function startSync() {
  if (location.protocol === 'file:') return setMode('local');
  pull(true);
  checkSetup();
  refreshRole().then(() => { if (auth && isAdmin()) loadOrgs(); }); // la lista de usuarios sirve para asignar árbitros
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (sync.pendingRender && !isBusy()) render();
    if (sync.dirty) push(); else pull(false);
    if (auth && isAdmin() && S.tab === 'equipos') loadInsc();
  }, 5000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pull(false); });
  window.addEventListener('online', () => (sync.dirty ? push() : pull(true)));
  document.addEventListener('focusout', () => setTimeout(() => { if (sync.pendingRender && !isBusy()) render(); }, 300));
}

/* =========================================================
   Inscripción en línea: capitanes inscriben, organizadores aprueban.
   El servidor (api/insc) valida todo; aquí solo se ayuda a llenar bien.
   ========================================================= */
/** Acuerdo del comité: de 5 a 8 jugadores por equipo. */
// from = apertura (acuerdo: a partir del día 25) · changesLeg1 = altas y bajas durante toda la primera vuelta
const INSC_DEF = { open: false, from: 0, until: 0, changesUntil: 0, changesLeg1: true, min: 5, max: 8 };
/** local = solo jugadores del municipio. Por defecto todas las categorías menos Femenino (jugadoras libres). */
const localDefault = (c) => !/femen/i.test((c && c.name) || '');
const inscOf = (c = T()) => Object.assign({}, INSC_DEF, { local: localDefault(c) }, (c && c.config && c.config.insc) || {});
/** Tamaño de equipo de una categoría (única regla: la de la inscripción). Titulares en cancha no puede pasar del máximo. */
function teamSize(c = T()) {
  const i = inscOf(c);
  const starters = Math.max(1, Math.min(i.max, TC().starters || i.min));
  return { min: i.min, max: i.max, starters, subs: Math.max(0, i.max - starters) };
}
/** regOpen: se pueden crear y enviar inscripciones. chOpen: altas y bajas de jugadores. */
/** Plazos (rules.js, la misma regla que aplica el servidor): {regOpen, chOpen, notYet, leg1Done}. */
const inscWin = (cfg, c = T()) => Rules.inscWindows(cfg, c, serverNow());
/** Texto de los plazos para capitanes y público. */
function plazoText(cfg, w) {
  if (!cfg.open) return '';
  if (w.notYet) return `La inscripción abre el <b>${fmtWhen(cfg.from)}</b>.`;
  const ch = cfg.changesLeg1 ? (w.leg1Done ? 'Terminó la primera vuelta: ya no hay altas ni bajas de jugadores.' : `Altas y bajas de jugadores durante toda la primera vuelta${cfg.changesUntil ? ' (a más tardar el <b>' + fmtWhen(cfg.changesUntil) + '</b>)' : ''}.`)
    : cfg.changesUntil ? `Altas y bajas de jugadores hasta el <b>${fmtWhen(cfg.changesUntil)}</b>.` : '';
  if (w.regOpen) return `Inscripción abierta${cfg.until ? ' hasta el <b>' + fmtWhen(cfg.until) + '</b>' : ''}. ${ch}`;
  return `Inscripción de equipos cerrada. ${w.chOpen ? ch : 'El plazo de altas y bajas ya cerró.'}`;
}
const fmtWhen = (ms) => (ms ? new Date(ms).toLocaleString('es', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const toLocalInput = (ms) => { if (!ms) return ''; const d = new Date(ms); return `${isoDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const regCat = (r) => (r && S.torneos[r.tor] && S.torneos[r.tor].cats[r.cat]) || null;
const INSC_STATUS = { borrador: ['Borrador', 'b-pend'], enviada: ['Por revisar', 'b-warn'], observada: ['Con observaciones', 'b-bad'], aprobada: ['Aprobada', 'b-ok'], rechazada: ['Rechazada', 'b-bad'] };
const inscBadge = (r) => { const [l, c] = INSC_STATUS[r.status] || [r.status, 'b-pend']; return `<span class="badge ${c}">${r.status === 'enviada' && r.approvedAt ? 'Cambios por revisar' : l}</span>`; };
const LOG_TXT = { editado: '🛠️ Editado por la organización', eliminado: '🗑️ Equipo eliminado', creada: '🆕 Creada', enviada: '📨 Enviada', cambio: '✏️ Cambio', baja: '➖ Baja', aprobada: '✅ Aprobada', observada: '⚠️ Observación', rechazada: '❌ Rechazada', clave: '🔑 Clave' };
const logItem = (l) => `<li><span class="grow"><b>${LOG_TXT[l.t] || esc(l.t)}</b>${l.text ? ' · ' + esc(l.text) : ''}<br><small>${fmtWhen(l.at)} · ${esc(l.by)}</small></span></li>`;

async function inscCall(body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch('api/insc', { method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store' });
  noteServerTime(r);
  let j = null;
  try { j = await r.json(); } catch (e) { /* sin API */ }
  return { status: r.status, j: j || {} };
}

/* ---- Sesión del capitán (código + clave) ---- */
const CAP_KEY = 'torneo-cap';
let capAuth = null;
try { capAuth = JSON.parse(localStorage.getItem(CAP_KEY)); } catch (e) { /* nada */ }
let capReg = null;
function setCap(a, reg = null) {
  capAuth = a; capReg = reg;
  try { if (a) localStorage.setItem(CAP_KEY, JSON.stringify(a)); else localStorage.removeItem(CAP_KEY); } catch (e) { /* nada */ }
}
const capCall = (body) => inscCall(body, capAuth && capAuth.token);
function capGone(j) { setCap(null); if (modal && modal.type === 'cap') modal = { type: 'cap' }; renderModal(); toast((j && j.error) || 'Ingrese de nuevo con su código y clave'); }

async function capLoad() {
  try {
    const { status, j } = await capCall({ action: 'get' });
    if (status === 401) return capGone(j);
    if (status !== 200) return toast(j.error || 'No se pudo cargar la inscripción');
    setCap(Object.assign({}, capAuth, { name: j.reg.name }), j.reg);
  } catch (e) { toast('Sin conexión. Intente de nuevo.'); }
  if (modal && modal.type === 'cap') renderModal();
}

/** Botones públicos: inscribir equipo, mi inscripción y reglamento. */
/**
 * Tarjeta de inscripción: solo para el capitán que ya ingresó (con el enlace de su invitación) en este teléfono.
 * El público no la ve: los capitanes entran con la invitación personal que les envía la organización.
 * El reglamento está en el ícono 📄 del encabezado, para todos.
 */
function inscCTA() {
  if (!capAuth) return '';
  const cfg = inscOf(), w = inscWin(cfg);
  const txt = plazoText(cfg, w);
  return `<div class="card">
    <h2>📝 Mi inscripción</h2>
    <p class="muted" style="margin:4px 0 10px;font-size:14px">${txt ? txt + ' ' : ''}De ${cfg.min} a ${cfg.max} jugadores por equipo. La organización aprueba cada inscripción y cada cambio.</p>
    <div class="row"><button class="btn" data-a="capOpen">🔑 Mi inscripción${capAuth.name ? ' · ' + esc(capAuth.name) : ''}</button></div>
  </div>`;
}

function capHTML() {
  const head = (t) => `<div class="mh"><h2>${t}</h2><button class="x" data-a="close">✕</button></div>`;
  if (sync.mode === 'local') return head('Inscripción') + '<div class="mb"><p class="muted">La inscripción en línea necesita conexión con la base de datos.</p></div>';
  if (!capAuth) return head('Inscripción de equipos') + capStartHTML();
  if (!capReg) return head('Mi inscripción') + '<div class="mb"><p class="muted">Cargando…</p></div>';
  return capEditorHTML();
}

function capStartHTML() {
  const inv = modal.inv;
  let nueva;
  if (!inv) {
    nueva = `<div class="card" style="margin-top:12px">
      <h3 style="margin-top:0">Inscribir un equipo</h3>
      <p class="muted" style="font-size:14px">La inscripción es <b>solo con invitación</b>: la organización envía a cada capitán un enlace personal. Si le dieron el código de invitación, escríbalo aquí.</p>
      <form id="capInvForm" autocomplete="off">
        <label class="fl">Código de invitación<input id="ci-code" maxlength="12" autocapitalize="characters" spellcheck="false" placeholder="Ej: K7P2-QX9M" value="${esc(modal.invCode || '')}" required></label>
        <div style="height:10px"></div><button class="btn block" type="submit">Continuar</button>
      </form>
    </div>`;
  } else if (inv.used) {
    nueva = '<div class="note warn" style="margin-top:12px">Esta invitación ya se usó para inscribir un equipo. Ingrese abajo con el <b>código del equipo</b> y su <b>clave</b>.</div>';
  } else if (!inv.open) {
    nueva = `<div class="note warn" style="margin-top:12px">${inv.notYet && inv.from ? `La inscripción de <b>${esc(inv.catName)}</b> abre el <b>${fmtWhen(inv.from)}</b>. Vuelva a abrir este enlace ese día.` : `La inscripción de <b>${esc(inv.catName)}</b> no está abierta en este momento. Consulte a la organización.`}</div>`;
  } else {
    nueva = `<div class="card" style="margin-top:12px">
      <h3 style="margin-top:0">Nueva inscripción · ${esc(inv.catName)}</h3>
      <div class="note">✉️ Invitación para <b>${esc(inv.label)}</b>${inv.until ? `<br>Inscripción abierta hasta el <b>${fmtWhen(inv.until)}</b>` : ''}</div>
      <p class="muted" style="font-size:14px">Cree la inscripción y después agregue a sus jugadores. Recibirá un <b>código de equipo</b>: con ese código y su clave podrá volver a entrar desde cualquier teléfono. La invitación sirve una sola vez.</p>
      <form id="capNewForm" autocomplete="off">
        <label class="fl">Nombre del equipo<input id="cn-name" maxlength="40" placeholder="Ej: Los Tigres" required></label>
        <label class="fl">Representante propietario <small>(nombre y apellido)</small><input id="cn-rep" maxlength="60" required></label>
        <label class="fl">Teléfono del representante<input id="cn-phone" type="tel" inputmode="tel" maxlength="20" placeholder="Ej: 7777-7777" required></label>
        <label class="fl">Cree una clave <small>(mínimo 6 caracteres, solo usted la sabrá)</small><input id="cn-pass" type="password" autocomplete="new-password" minlength="6" required></label>
        <div style="height:10px"></div><button class="btn block" type="submit">Crear inscripción</button>
      </form>
    </div>`;
  }
  return `<div class="mb">
    ${nueva}
    <div class="card">
      <h3 style="margin-top:0">Ya tengo mi equipo inscrito</h3>
      <form id="capLoginForm" autocomplete="on">
        <div class="grid2">
          <label class="fl">Código del equipo<input id="cl-id" name="username" maxlength="6" autocapitalize="characters" spellcheck="false" placeholder="Ej: MJGVDH" required></label>
          <label class="fl">Clave<input id="cl-pass" name="password" type="password" autocomplete="current-password" required></label>
        </div>
        <div style="height:10px"></div><button class="btn ghost block" type="submit">Ingresar</button>
      </form>
      <p class="muted" style="font-size:13px;margin-bottom:0">¿Olvidó su clave? Pida a la organización que se la restablezca.</p>
    </div>
    <button class="btn ghost block sm" data-a="openRules">📜 Ver reglamento</button>
  </div>`;
}
/** Revisa un código de invitación y muestra el formulario de inscripción. */
async function checkInvite(code) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length !== 8) return toast('El código de invitación tiene 8 letras y números');
  try {
    const { status, j } = await inscCall({ action: 'checkInvite', invite: c });
    if (status !== 200) return toast(j.error || 'Código de invitación no válido');
    if (modal && modal.type === 'cap') { modal.inv = j; modal.invCode = c; renderModal(); }
  } catch (e) { toast('Sin conexión. Intente de nuevo.'); }
}

/* ---- Invitaciones (organizador) ---- */
let inscInvites = [];
const invPretty = (c) => String(c).slice(0, 4) + '-' + String(c).slice(4);
const invLink = (c) => `${location.origin}/?i=${invPretty(c)}`;
function invText(inv) {
  const tor = S.torneos[inv.tor], c = tor && tor.cats[inv.cat], cfg = inscOf(c);
  return `Hola ${inv.label} 👋\nEsta es su invitación para inscribir su equipo en *${tor ? tor.name : 'el torneo'}* · ${c ? c.name : ''}.\n\n👉 ${invLink(inv.code)}\n\nCódigo de invitación: ${invPretty(inv.code)}\n${cfg.from && cfg.from > Date.now() ? `La inscripción abre el ${fmtWhen(cfg.from)}.\n` : ''}${cfg.until ? `Inscripción abierta hasta el ${fmtWhen(cfg.until)}.\n` : ''}El enlace es personal y sirve una sola vez: no lo comparta.\n\nDespués, para volver a entrar a su inscripción: ${location.origin}/capitan (con el código de su equipo y su clave).`;
}
function invShare(inv, how) {
  const text = invText(inv);
  if (how === 'wa') { window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank'); return; }
  const fallback = () => askText('Copie el enlace de invitación:', { title: '📋 Enlace', value: invLink(inv.code), ok: 'Listo' });
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast('📋 Invitación copiada. Péguela en WhatsApp o SMS.'), fallback);
  else fallback();
}
function invitesHTML() {
  const list = inscInvites.filter((i) => i.tor === S.tor && i.cat === S.cat);
  const pend = list.filter((i) => !i.usedBy).length;
  return `<div class="cr-lbl" style="margin-top:14px">✉️ Invitaciones a capitanes${list.length ? ` <small>· ${pend} sin usar</small>` : ''}</div>
    <p class="muted" style="font-size:13px;margin:0 0 8px">Solo quien tenga una invitación puede inscribir un equipo. Cada invitación sirve una vez y es para esta categoría.</p>
    <button class="btn block sm" data-a="invNew">✉️ Invitar a un capitán</button>
    ${list.map((i) => `<div class="org"><span class="grow"><b>${esc(i.label)}</b><br><small><span class="code">${invPretty(i.code)}</span> · ${i.usedBy ? `✅ usada: ${esc(i.team || i.usedBy)}` : 'pendiente'}</small></span>
      ${i.usedBy ? '' : `<span class="row" style="flex-wrap:nowrap;flex:none">
        <button class="btn ghost sm" data-a="invWa" data-c="${i.code}" aria-label="Enviar por WhatsApp">💬</button>
        <button class="btn ghost sm" data-a="invCopy" data-c="${i.code}" aria-label="Copiar">📋</button>
        <button class="btn danger sm" data-a="invDel" data-c="${i.code}" aria-label="Anular">🗑️</button></span>`}</div>`).join('')}`;
}

/** Qué puede cambiar el capitán ahora (el servidor aplica las mismas reglas). */
function capPerm(reg) {
  const c = regCat(reg), cfg = inscOf(c), w = inscWin(cfg, c), sent = !!reg.sentAt;
  const alive = reg.status !== 'rechazada';
  const full = alive && (reg.status === 'observada' || w.regOpen);
  return { c, cfg, w, sent, full, edit: alive && (full || (sent && w.chOpen)), baja: alive && w.chOpen };
}

function capEditorHTML() {
  const reg = capReg, d = modal.draft || reg, P = capPerm(reg), cfg = P.cfg;
  if (modal.crest === undefined) modal.crest = d.crest || null;
  const approved = new Set((reg.approvedPlayers || []).map((p) => norm(p.name)));
  const lastNote = [...(reg.log || [])].reverse().find((l) => l.t === 'observada' || l.t === 'rechazada');
  const dis = (on) => (on ? '' : 'disabled');
  let st;
  if (reg.status === 'borrador') st = `<div class="note">📝 Aún no ha enviado la inscripción. Agregue de ${cfg.min} a ${cfg.max} jugadores y toque <b>Enviar inscripción</b>${cfg.until ? ' antes del <b>' + fmtWhen(cfg.until) + '</b>' : ''}.</div>`;
  else if (reg.status === 'enviada') st = `<div class="note">⏳ ${reg.approvedAt ? 'Sus cambios están' : 'Su inscripción está'} en revisión. La organización la aprobará o le dejará observaciones aquí.</div>`;
  else if (reg.status === 'observada') st = `<div class="note warn">⚠️ <b>La organización dejó observaciones:</b><br>${esc(lastNote ? lastNote.text : '')}<br><small>Corrija y toque <b>Reenviar a revisión</b>.</small></div>`;
  else if (reg.status === 'aprobada') st = `<div class="note">✅ Equipo aprobado. ${P.w.chOpen ? `Puede dar altas y bajas de jugadores${cfg.changesUntil ? ' hasta el <b>' + fmtWhen(cfg.changesUntil) + '</b>' : ''}; cada cambio vuelve a revisión.` : 'El plazo de cambios ya cerró.'}</div>`;
  else st = `<div class="note warn">❌ <b>Inscripción rechazada.</b> ${esc(lastNote ? lastNote.text : '')}</div>`;
  if (!P.edit && reg.status !== 'rechazada') st += '<div class="note warn">🔒 El plazo está cerrado: solo puede ver su inscripción.</div>';

  const rows = d.players.map((p) => ({ ...p, ok: approved.has(norm(p.name)) }));
  if (P.edit) while (rows.length < cfg.max) rows.push({ name: '', num: '', doc: '' });
  const errs = modal.errors || {};
  const playerRows = rows.map((p, i) => {
    const lock = p.ok || !P.edit, e = errs[i] || '';
    return `<div class="prow cprow" data-srv="${esc(e)}"><span class="pn">${i + 1}</span>
      <input class="pl-name" data-cpl autocomplete="off" placeholder="Nombre y apellido${i < cfg.min ? ' *' : ''}" value="${esc(p.name)}" ${lock ? 'readonly' : ''}>
      <input class="pl-num" data-cpl type="number" inputmode="numeric" min="0" max="99" placeholder="N°" value="${esc(p.num)}" ${lock ? 'readonly' : ''}>
      <div class="pdoc"><input class="pl-doc" data-cpl maxlength="10" inputmode="numeric" placeholder="DUI (opcional)" value="${esc(p.doc || '')}" ${lock ? 'readonly' : ''}>
        <label class="pcap" title="Capitán del equipo"><input type="radio" name="c-cap" class="pl-cap" data-cpl ${p.cap ? 'checked' : ''} ${P.edit ? '' : 'disabled'}> Capitán</label></div>
      ${p.ok && P.baja ? `<button type="button" class="btn danger sm" data-a="capBaja" data-n="${esc(p.name)}">Baja</button>` : `<span class="pok">${p.ok ? '✅' : ''}</span>`}
      <div class="perr"></div></div>`;
  }).join('');
  const send = P.sent ? `<button class="btn block" data-a="capSave" data-send="1">${reg.status === 'observada' ? '📨 Reenviar a revisión' : 'Guardar cambios'}</button>`
    : '<button class="btn block" data-a="capSave" data-send="1">📨 Enviar inscripción</button><button class="btn ghost block" data-a="capSave">Guardar borrador</button>';
  setTimeout(checkCapPlayers, 0);
  return `<div class="mh"><h2>${esc(d.name)}</h2><button class="x" data-a="close">✕</button></div>
  <div class="mb">
    <div class="row" style="align-items:center;margin:12px 0 10px">${inscBadge(reg)}<small>Código <b class="code">${esc(reg.id)}</b> · ${esc(P.c ? P.c.name : '')}</small></div>
    ${st}
    ${modal.general && modal.general.length ? `<div class="note warn">${modal.general.map(esc).join('<br>')}</div>` : ''}
    <label class="fl">Nombre del equipo<input id="f-name" maxlength="40" value="${esc(d.name)}" ${dis(P.full)}></label>
    ${P.edit ? crestEditorHTML(d.name) : `<div class="fl">Escudo</div><div class="crest-prev">${crestPreview(d.crest, d.name)}</div>`}
    <label class="fl">Colores del uniforme<input id="c-colors" maxlength="60" placeholder="Ej: camisa roja, short negro" value="${esc(d.colors || '')}" ${dis(P.edit)}></label>
    <div class="psec">Representantes</div>
    <div class="grid2">
      <label class="fl">Propietario<input id="c-rep-n" maxlength="60" value="${esc(d.rep.name)}" ${dis(P.edit)}></label>
      <label class="fl">Teléfono<input id="c-rep-p" type="tel" inputmode="tel" maxlength="20" value="${esc(d.rep.phone)}" ${dis(P.edit)}></label>
      <label class="fl" style="grid-column:1/3">DUI del propietario <small>(opcional)</small><input id="c-rep-d" maxlength="10" inputmode="numeric" placeholder="00000000-0" value="${esc(d.rep.doc || '')}" ${dis(P.edit)}></label>
      <label class="fl">Suplente<input id="c-rep2-n" maxlength="60" value="${esc(d.rep2.name)}" ${dis(P.edit)}></label>
      <label class="fl">Teléfono<input id="c-rep2-p" type="tel" inputmode="tel" maxlength="20" value="${esc(d.rep2.phone)}" ${dis(P.edit)}></label>
      <label class="fl" style="grid-column:1/3">DUI del suplente <small>(opcional)</small><input id="c-rep2-d" maxlength="10" inputmode="numeric" placeholder="00000000-0" value="${esc((d.rep2 && d.rep2.doc) || '')}" ${dis(P.edit)}></label>
    </div>
    <small>El suplente actúa solo cuando el propietario no está. Si el representante también juega, agréguelo en la lista de jugadores. Los teléfonos y DUI solo los ve la organización.</small>
    <div class="psec">Jugadores <small id="c-count"></small></div>
    <div id="c-players">${playerRows || '<p class="muted">Sin jugadores.</p>'}</div>
    <small>Marque al <b>Capitán</b> del equipo (uno de los jugadores). Si dos jugadores se llaman igual, escriba el DUI de cada uno para diferenciarlos. ✅ = aprobado. Un jugador aprobado no se borra: se le da de <b>Baja</b> con el motivo y ya no podrá inscribirse en ningún otro equipo. Cada jugador usa el mismo número todo el campeonato.</small>
    ${reg.bajas && reg.bajas.length ? `<div class="psec">Dados de baja (intransferibles)</div><ul class="cardlist">${reg.bajas.map((b) => `<li><span class="grow"><b>${esc(b.name)}</b><br><small>${esc(b.reason)} · ${fmtWhen(b.at)}</small></span></li>`).join('')}</ul>` : ''}
    ${!P.sent && P.edit ? `<label class="opt ${modal.accept ? 'on' : ''}" style="margin-top:14px"><input type="checkbox" id="c-accept" ${modal.accept ? 'checked' : ''}><div><b>Confirmo</b><span>${cfg.local ? 'que todos los jugadores pertenecen al municipio o viven permanentemente en él, y ' : ''}que el equipo acepta el reglamento del campeonato.</span></div></label>` : ''}
    <div class="psec">Historial</div>
    <ul class="cardlist">${(reg.log || []).slice(-10).reverse().map(logItem).join('')}</ul>
  </div>
  <div class="mf">
    ${P.edit ? send : ''}
    <div class="row"><button class="btn ghost sm" data-a="openRules">📜 Reglamento</button><button class="btn ghost sm" data-a="capLogout">Salir</button></div>
  </div>`;
}

/** Jugadores repetidos o ya inscritos en otro equipo publicado del torneo (el servidor hace la revisión completa). */
function checkCapPlayers() {
  if (!modal || modal.type !== 'cap' || !capReg) return 0;
  const cfg = inscOf(regCat(capReg));
  const idx = new Map();
  const tor = S.torneos[capReg.tor];
  const orig = new Map();
  if (tor) for (const c of Object.values(tor.cats)) for (const tm of c.teams) { if (tm.id === capReg.teamId) continue; for (const p of tm.players) { idx.set(norm(p.name), `${tm.name} (${c.name})`); orig.set(norm(p.name), p.name); } }
  const seen = new Map(), nums = new Map();
  let errors = 0, filled = 0;
  document.querySelectorAll('#c-players .cprow').forEach((row) => {
    const n = norm(row.querySelector('.pl-name').value), num = row.querySelector('.pl-num').value.trim();
    const doc = row.querySelector('.pl-doc').value.trim().toUpperCase().replace(/[\s.]/g, '');
    const pn = row.querySelector('.pn').textContent;
    let msg = '', warn = '';
    if (n) {
      filled++;
      const twin = (seen.get(n) || []).find((o) => !doc || !o.doc || o.doc === doc);
      if (doc && !/^\d{8}-?\d$/.test(doc)) msg = 'DUI no válido: debe tener 9 números (00000000-0)';
      else if (twin) msg = `Repetido con el jugador ${twin.pn}${doc ? '' : ' (si es otra persona, escriba el DUI de ambos)'}`;
      else if (idx.has(n) && !doc) msg = `Ya hay un jugador con este nombre en ${idx.get(n)}. Si es la misma persona, debe decidir en cuál equipo jugará; si es otra persona, escriba su DUI`;
      else if (num !== '' && nums.has(String(+num))) msg = `El número ${+num} ya lo usa el jugador ${nums.get(String(+num))}`;
      else msg = row.dataset.srv || '';
      if (!msg) {
        const sim = !doc && [...orig.keys()].find((k) => Rules.similarNames(n, k));
        warn = (modal.warns && modal.warns[n]) || (sim ? `⚠️ Nombre parecido a ${orig.get(sim)}, que ya está en ${idx.get(sim)}. Si es la misma persona no puede estar en dos equipos; si es otra, escriba su DUI.` : '');
      }
      if (!seen.has(n)) seen.set(n, []);
      seen.get(n).push({ pn, doc });
      if (num !== '' && !nums.has(String(+num))) nums.set(String(+num), pn);
    }
    row.classList.toggle('bad', !!msg);
    row.classList.toggle('warn', !msg && !!warn);
    row.querySelector('.perr').textContent = msg || warn;
    if (msg) errors++;
  });
  const cnt = $('#c-count');
  if (cnt) { cnt.textContent = `(${filled} de ${cfg.max} · mínimo ${cfg.min})`; cnt.style.color = filled < cfg.min || filled > cfg.max ? 'var(--bad)' : ''; }
  updateCrestUI();
  return errors;
}

function capCollect() {
  const v = (id) => (($('#' + id) || {}).value || '').trim().replace(/\s+/g, ' ');
  const players = [];
  document.querySelectorAll('#c-players .cprow').forEach((row) => {
    const name = row.querySelector('.pl-name').value.trim().replace(/\s+/g, ' ');
    const cap = row.querySelector('.pl-cap');
    if (name) players.push({ name, num: row.querySelector('.pl-num').value.trim(), doc: row.querySelector('.pl-doc').value.trim(), ...(cap && cap.checked ? { cap: true } : {}) });
  });
  const acc = $('#c-accept');
  if (acc) modal.accept = acc.checked;
  return { name: v('f-name') || capReg.name, crest: modal.crest || null, colors: v('c-colors'), rep: { name: v('c-rep-n'), phone: v('c-rep-p'), doc: v('c-rep-d') }, rep2: { name: v('c-rep2-n'), phone: v('c-rep2-p'), doc: v('c-rep2-d') }, players };
}

async function capSave(send) {
  if (!capReg) return;
  const data = capCollect();
  if (checkCapPlayers() > 0) return toast('Hay jugadores con errores (marcados en rojo)');
  const cfg = inscOf(regCat(capReg));
  if (data.players.length > cfg.max) return toast(`Máximo ${cfg.max} jugadores`);
  if (send && data.players.length < cfg.min) return toast(`Se requieren al menos ${cfg.min} jugadores (hay ${data.players.length})`);
  if (send && !capReg.sentAt && !modal.accept) return toast('Marque la casilla de confirmación antes de enviar');
  if (send && !data.players.some((p) => p.cap)) return toast('Indique quién es el capitán: marque “Capitán” en uno de los jugadores');
  modal.draft = Object.assign({}, capReg, data);
  try {
    const { status, j } = await capCall(Object.assign({ action: 'save', send: !!send, accept: !!modal.accept }, data));
    if (status === 401) return capGone(j);
    if (status === 422) {
      modal.errors = Object.fromEntries((j.errors || []).map((e) => [e.i, e.msg]));
      modal.general = j.general || [];
      renderModal();
      return toast(j.error || 'Revise los datos');
    }
    if (status !== 200) return toast(j.error || 'No se pudo guardar');
    const first = send && !capReg.sentAt;
    setCap(Object.assign({}, capAuth, { name: j.reg.name }), j.reg);
    // Avisos (no bloquean): nombre igual o parecido a un jugador de otro equipo; la organización lo verifica
    modal.warns = Object.fromEntries((j.warn || []).map((w) => [norm(w.name), w.msg]));
    Object.assign(modal, { draft: null, errors: null, general: null, crest: undefined });
    renderModal();
    if ((j.warn || []).length) return toast(`⚠️ Guardado con ${j.warn.length} aviso(s): revise los nombres marcados en amarillo`);
    toast(first ? '📨 Inscripción enviada. La organización la revisará.' : j.reg.status === 'enviada' && j.reg.approvedAt ? '📨 Cambios enviados a revisión' : '✅ Guardado');
  } catch (e) { toast('Sin conexión. Intente de nuevo.'); }
}

async function capBaja(name) {
  modal.draft = Object.assign({}, capReg, capCollect());
  // Una sola ventana: aviso + motivo obligatorio (si es muy corto, se vuelve a pedir con lo escrito)
  let reason = '';
  for (;;) {
    reason = await askText(`${name} será dado de baja del equipo.\n\nQuedará intransferible: no podrá volver a inscribirse en ningún equipo del torneo. No se puede deshacer.\n\nMotivo de la baja (obligatorio, lo verá la organización):`, { title: '➖ Dar de baja', placeholder: 'Ej: se fue a vivir fuera del municipio', ok: 'Dar de baja', danger: true, value: reason });
    if (reason == null) return;
    reason = reason.trim();
    if (reason.length >= 10) break;
    toast('Explique el motivo (al menos 10 letras)');
  }
  try {
    const { status, j } = await capCall({ action: 'baja', name, reason: reason.trim() });
    if (status === 401) return capGone(j);
    if (status !== 200) return toast(j.error || 'No se pudo dar de baja');
    capReg = j.reg;
    if (modal.draft) modal.draft.players = modal.draft.players.filter((p) => norm(p.name) !== norm(name));
    modal.errors = null;
    renderModal();
    toast(`${name} dado de baja`);
  } catch (e) { toast('Sin conexión. Intente de nuevo.'); }
}

/* ---- Panel de organizadores ---- */
let inscList = null, inscBans = [], inscLoading = false, inscAt = 0;
const admInsc = (body) => inscCall(body, auth && auth.token);
async function loadInsc(force) {
  if (!auth || !auth.token || !isAdmin() || sync.mode === 'local' || inscLoading) return;
  if (!force && inscList && Date.now() - inscAt < 30000) return;
  inscLoading = true;
  try {
    const { status, j } = await admInsc({ action: 'list' });
    if (status === 401) return sessionExpired();
    if (status === 200) {
      inscList = j.regs || []; inscBans = j.bans || []; inscInvites = j.invites || []; inscAt = Date.now();
      if (S.tab === 'equipos' || (modal && modal.type === 'inscAdmin')) requestRender();
    }
  } catch (e) { /* sin conexión */ } finally { inscLoading = false; }
}
function replaceReg(r) {
  if (!inscList) inscList = [];
  const i = inscList.findIndex((x) => x.id === r.id);
  if (i >= 0) inscList[i] = r; else inscList.unshift(r);
}
/** Avisos del servidor: hard = conflicto real (bloquea), soft = posible homónimo por verificar. */
const regWarns = (r) => (r && r.warn) || [];

function inscAdminCard() {
  if (sync.mode === 'local') return '';
  const cfg = inscOf(), w = inscWin(cfg);
  const order = { enviada: 0, observada: 1, borrador: 2, aprobada: 3, rechazada: 4 };
  const regs = (inscList || []).filter((r) => r.tor === S.tor && r.cat === S.cat)
    .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || (b.updatedAt || 0) - (a.updatedAt || 0));
  const pend = regs.filter((r) => r.status === 'enviada').length;
  const bans = inscBans.filter((b) => b.tor === S.tor);
  const state = !cfg.open ? 'Cerrada (actívela en Ajustes)'
    : w.notYet ? `Abre el ${fmtWhen(cfg.from)}`
      : w.regOpen ? `Abierta${cfg.until ? ' hasta ' + fmtWhen(cfg.until) : ''}`
        : w.chOpen ? `Equipos nuevos cerrado · altas y bajas ${cfg.changesLeg1 ? 'hasta que termine la primera vuelta' : 'hasta ' + fmtWhen(cfg.changesUntil)}` : w.leg1Done ? 'Terminó la primera vuelta: sin altas ni bajas' : 'Plazo vencido';
  return `<div class="card">
    <div class="sec-head" style="margin:0 0 6px"><h2 style="margin:0">📝 Inscripciones en línea</h2><button class="link" data-a="inscReload">🔄 Actualizar</button></div>
    <p class="muted" style="font-size:14px;margin:0 0 10px">${state} · ${cfg.min} a ${cfg.max} jugadores${pend ? ` · <b style="color:var(--text)">${pend} por revisar</b>` : ''}</p>
    ${inscList === null ? '<p class="muted">Cargando…</p>' : regs.length ? regs.map((r) => `<button class="list-item" data-a="inscView" data-id="${esc(r.id)}">
      <span class="tcrest" style="width:36px;height:36px">${crestHTML(r.crest, r.name, 36)}</span>
      <div class="grow"><div class="t">${esc(r.name)}${regWarns(r).length ? ' ⚠️' : ''}</div><small>${r.players.length} jugadores · ${esc(r.rep.name)} · ${fmtWhen(r.updatedAt)}</small></div>${inscBadge(r)}</button>`).join('')
    : '<p class="muted">Aún no hay inscripciones en línea en esta categoría.</p>'}
    ${invitesHTML()}
    ${bans.length ? `<details style="margin-top:8px"><summary><b>Jugadores dados de baja (intransferibles): ${bans.length}</b></summary>
      ${bans.map((b) => `<div class="org"><span class="grow"><b>${esc(b.name)}</b> <small>· ${esc(b.team)} (${esc(b.cat)})</small><br><small>${esc(b.reason)} · ${fmtWhen(b.at)}</small></span>
      <button class="btn ghost sm" data-a="inscUnban" data-k="${esc(b.key)}">Habilitar</button></div>`).join('')}</details>` : ''}
  </div>`;
}

function inscAdminHTML(id) {
  const r = (inscList || []).find((x) => x.id === id);
  const head = (t) => `<div class="mh"><h2>${t}</h2><button class="x" data-a="close">✕</button></div>`;
  if (!r) return head('Inscripción') + '<div class="mb"><p class="muted">No encontrada.</p></div>';
  const c = regCat(r), cfg = inscOf(c);
  const appr = new Set((r.approvedPlayers || []).map((p) => norm(p.name)));
  const warns = regWarns(r);
  const wOf = (n) => warns.filter((w) => norm(w.name) === n);
  const tel = (p) => (p ? `<a href="tel:${esc(String(p).replace(/[^\d+]/g, ''))}">${esc(p)}</a>` : '—');
  const nOk = r.players.length >= cfg.min && r.players.length <= cfg.max;
  const canApprove = r.sentAt && (r.status === 'enviada' || r.status === 'observada');
  return `${head(esc(r.name))}
  <div class="mb">
    <div class="row" style="align-items:center;margin:12px 0 10px">${inscBadge(r)}<small>Código <b class="code">${esc(r.id)}</b> · ${esc(c ? c.name : '¿categoría eliminada?')}${r.sentAt ? ' · enviada ' + fmtWhen(r.sentAt) : ''}</small></div>
    <div class="crest-edit" style="grid-template-columns:72px 1fr">
      <div class="crest-prev" style="width:72px;height:80px">${crestPreview(r.crest, r.name)}</div>
      <div style="font-size:14px">🎽 <b>Uniforme:</b> ${esc(r.colors || '—')}<br>
        👤 <b>Propietario:</b> ${esc(r.rep.name || '—')} · ${tel(r.rep.phone)}${r.rep.doc ? ' · DUI ' + esc(r.rep.doc) : ''}<br>
        👥 <b>Suplente:</b> ${esc((r.rep2 && r.rep2.name) || '—')} · ${tel(r.rep2 && r.rep2.phone)}${r.rep2 && r.rep2.doc ? ' · DUI ' + esc(r.rep2.doc) : ''}<br>🧢 <b>Capitán:</b> ${esc((r.players.find((p) => p.cap) || {}).name || '— (sin marcar)')}</div>
    </div>
    ${warns.length ? `<div class="note warn" style="margin-top:12px">${warns.map((w) => `${w.hard ? '⛔' : '⚠️'} <b>${esc(w.name)}</b>: ${esc(w.msg)}`).join('<br>')}</div>` : ''}
    <div class="psec">Jugadores (${r.players.length}) <small style="color:${nOk ? 'inherit' : 'var(--bad)'}">· se permiten ${cfg.min} a ${cfg.max}</small></div>
    <ul class="cardlist">${r.players.map((p) => { const w = wOf(norm(p.name)); return `<li><span class="grow">${p.num !== '' ? `<b>${esc(p.num)}</b> · ` : ''}${esc(p.name)}${p.cap ? ' <b title="Capitán">(C)</b>' : ''}${p.doc ? ` <small>· ${/^\d{8}-\d$/.test(p.doc) ? 'DUI' : 'Doc.'} ${esc(p.doc)}</small>` : ''}</span>
      ${r.approvedAt && !appr.has(norm(p.name)) ? '<span class="badge b-warn">Alta nueva</span>' : ''}${w.some((x) => x.hard) ? '<span class="badge b-bad">Repetido</span>' : w.length ? '<span class="badge b-warn">Verificar</span>' : ''}</li>`; }).join('') || '<li class="muted">Sin jugadores</li>'}</ul>
    ${r.bajas && r.bajas.length ? `<div class="psec">Bajas</div><ul class="cardlist">${r.bajas.map((b) => `<li><span class="grow"><b>${esc(b.name)}</b><br><small>${esc(b.reason)} · ${fmtWhen(b.at)}</small></span></li>`).join('')}</ul>` : ''}
    <div class="psec">Historial</div>
    <ul class="cardlist">${(r.log || []).slice().reverse().map(logItem).join('')}</ul>
  </div>
  <div class="mf">
    ${canApprove ? `<button class="btn block" data-a="inscApprove" data-id="${esc(r.id)}">✅ ${r.approvedAt ? 'Aprobar cambios' : 'Aprobar e inscribir equipo'}</button>` : ''}
    ${!r.sentAt ? '<div class="note" style="margin:0">El capitán aún no ha enviado esta inscripción.</div>' : ''}
    <div class="row">
      <button class="btn ghost sm" data-a="inscReview" data-st="observada" data-id="${esc(r.id)}">⚠️ Observar</button>
      ${!r.approvedAt && r.status !== 'rechazada' ? `<button class="btn danger sm" data-a="inscReview" data-st="rechazada" data-id="${esc(r.id)}">❌ Rechazar</button>` : ''}
    </div>
    <div class="row">
      <button class="btn ghost sm" data-a="inscPin" data-id="${esc(r.id)}">🔑 Restablecer clave</button>
      ${!r.approvedAt ? `<button class="btn danger sm" data-a="inscRemove" data-id="${esc(r.id)}">🗑️ Eliminar</button>` : ''}
    </div>
  </div>`;
}

async function inscApprove(id) {
  const r = (inscList || []).find((x) => x.id === id);
  const c = regCat(r);
  if (!r || !c) return toast('La categoría de esta inscripción ya no existe');
  let team = r.teamId ? c.teams.find((t) => t.id === r.teamId) : null;
  if (!team && c.stage !== 'inscripcion') return toast(`El sorteo de ${c.name} ya se realizó: no se pueden agregar equipos nuevos`);
  const dup = c.teams.find((t) => t !== team && norm(t.name) === norm(r.name));
  if (dup) return toast(`Ya existe el equipo "${dup.name}" en ${c.name}`);
  const warns = regWarns(r), hard = warns.filter((w) => w.hard);
  if (hard.length) return toast(`⛔ ${hard[0].name}: ${hard[0].msg}`);
  if (warns.length && !(await ask(warns.map((w) => `• ${w.name}: ${w.msg}`).join('\n') + '\n\n¿Ya verificó que son personas distintas?', { title: '⚠️ Posibles nombres repetidos', ok: 'Sí, verificado' }))) return;
  const ok = await ask(team ? `Se actualizará ${r.name} en ${c.name} con ${r.players.length} jugadores.` : `${r.name} quedará inscrito en ${c.name} con ${r.players.length} jugadores y aparecerá en la lista pública de equipos.`, { title: '✅ Aprobar', ok: 'Aprobar' });
  if (!ok) return;
  const teamId = team ? team.id : uid();
  try {
    const { status, j } = await admInsc({ action: 'review', id, status: 'aprobada', teamId });
    if (status === 401) return sessionExpired();
    if (status !== 200) return toast(j.error || 'No se pudo aprobar');
    const reg = j.reg;
    team = c.teams.find((t) => t.id === teamId);
    const starters = Math.min(S.torneos[reg.tor].config.starters || 5, inscOf(c).max);
    const prevSub = new Map(team ? team.players.map((p) => [norm(p.name), p.sub]) : []);
    const players = reg.players.map((p, i) => ({ name: p.name, num: p.num, sub: prevSub.has(norm(p.name)) ? prevSub.get(norm(p.name)) : i >= starters, ...(p.cap ? { cap: true } : {}) }));
    // Mismo nombre = mismo jugador (conserva su identificador); los nuevos reciben uno nuevo
    matchPlayerIds(players, team ? team.players : []);
    assignPlayerIds(teamId, players, team ? team.players : [], c);
    if (team) Object.assign(team, { name: reg.name, players, crest: reg.crest, colors: reg.colors, insc: reg.id });
    else c.teams.push({ id: teamId, name: reg.name, players, paid: 0, crest: reg.crest, colors: reg.colors, insc: reg.id, createdAt: Date.now() });
    replaceReg(reg);
    save(); render();
    toast(team ? `✅ Cambios de ${reg.name} aprobados` : `✅ ${reg.name} inscrito en ${c.name}`);
  } catch (e) { toast('Sin conexión'); }
}

/* ---- Reglamento ---- */
function rulesBody(text) {
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of String(text || '').split('\n')) {
    const l = raw.trim();
    let m;
    if (!l) close();
    else if ((m = l.match(/^#+\s*(.+)/))) { close(); out.push(`<h3>${esc(m[1])}</h3>`); }
    else if ((m = l.match(/^[-*•]\s*(.+)/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${esc(m[1])}</li>`); }
    else if ((m = l.match(/^\d+[.)]\s*(.+)/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${esc(m[1])}</li>`); }
    else { close(); out.push(`<p>${esc(l)}</p>`); }
  }
  close();
  return out.join('');
}
function rulesHTML() {
  const tor = TOR(), cfg = inscOf();
  const sys = [
    'Solo pueden inscribir equipos los capitanes que reciben una invitación personal de la organización (sirve una sola vez).',
    `Cada equipo inscribe de ${cfg.min} a ${cfg.max} jugadores.`,
    'Un jugador solo puede estar en un equipo del torneo (en cualquier categoría). Si ya aparece en otro equipo, el sistema no lo deja inscribir y el jugador debe decidir en cuál participará. Si son dos personas con el mismo nombre, se diferencian con el DUI y la organización lo verifica.',
    'Para dar de baja a un jugador hay que escribir el motivo. El jugador dado de baja queda intransferible: no puede volver a inscribirse en ningún equipo.',
    'Son obligatorios: representante propietario y suplente (nombre y teléfono), logo o escudo y colores del uniforme.',
    'El número de camisa no se repite dentro del equipo y, una vez aprobado, el jugador conserva el mismo número todo el campeonato.',
    cfg.local ? 'El capitán confirma que sus jugadores pertenecen o viven permanentemente en el municipio.' : 'Categoría libre: se aceptan jugadores de otros municipios.',
    !cfg.open ? 'La inscripción en línea de esta categoría aún no está abierta.'
      : (cfg.from ? `La inscripción abre el ${fmtWhen(cfg.from)}. ` : '') + (cfg.until ? `Inscripción de equipos hasta el ${fmtWhen(cfg.until)}.` : 'Inscripción de equipos abierta.')
        + (cfg.changesLeg1 ? ' Se pueden inscribir y desinscribir jugadores durante toda la primera vuelta; al terminar, el sistema lo cierra solo.' : cfg.changesUntil ? ` Altas y bajas de jugadores hasta el ${fmtWhen(cfg.changesUntil)}.` : ''),
    `Durante la primera vuelta, si el equipo tiene menos de ${cfg.max} jugadores, se puede inscribir a un jugador en la cancha antes de jugar (con las mismas validaciones).`,
    'Toda inscripción y todo cambio de jugadores queda pendiente hasta que la organización lo aprueba, lo observa o lo rechaza.',
    (() => { const R = sancRules(); return `Suspensiones automáticas: 2 amarillas en un partido, ${sancText(sancN(R.y2))}; amarilla + roja, ${sancText(sancN(R.yr))}; roja directa, ${sancText(sancN(R.r))}; roja con agresión, ${sancText(sancN(R.agg))}${R.yl ? `; ${R.yl} amarillas acumuladas, 1 partido` : ''}. Se cumplen en los partidos que el equipo juega; el jugador suspendido no puede anotar ni recibir tarjetas.`; })(),
  ];
  return `<div class="mh"><h2>📜 Reglamento</h2><button class="x" data-a="close">✕</button></div>
  <div class="mb rules">
    <div class="note" style="margin-top:12px"><b>✅ Lo que el sistema valida automáticamente · ${esc(catName(S.cat))}</b><ul>${sys.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>
    ${rulesText(tor) ? rulesBody(rulesText(tor)) : '<p class="muted">La organización aún no ha publicado el reglamento completo.</p>'}
  </div>`;
}

/** Categorías del torneo que no tienen el tamaño de equipo acordado por el comité (5 a 8). */
const offAgreement = () => Object.entries(CATS_()).filter(([, c]) => { const i = inscOf(c); return i.min !== INSC_DEF.min || i.max !== INSC_DEF.max; });
function inscAgreementNote() {
  const off = offAgreement();
  if (!off.length) return '';
  return `<div class="note warn" style="margin-top:10px">⚠️ Acuerdo del comité: de <b>${INSC_DEF.min} a ${INSC_DEF.max}</b> jugadores por equipo. No lo cumplen: ${off.map(([, c]) => `${esc(c.name)} (${inscOf(c).min} a ${inscOf(c).max})`).join(', ')}.
    <div style="margin-top:8px"><button class="btn sm" data-a="inscAgreement">Aplicar ${INSC_DEF.min} a ${INSC_DEF.max} en todas las categorías</button></div></div>`;
}
/** Opción de municipio y tamaño de equipo: se usa siempre (formulario de equipos y sorteo), haya o no base de datos. */
const inscSizeHTML = (cfg) => `<label class="opt ${cfg.local ? 'on' : ''}"><input type="checkbox" data-insc="local" ${cfg.local ? 'checked' : ''}><div><b>Solo jugadores del municipio</b><span>${cfg.local ? 'El capitán debe confirmar que sus jugadores pertenecen o viven permanentemente en el municipio.' : 'Categoría libre: se aceptan jugadores de otros municipios.'}</span></div></label>
    <div class="grid2">
      <label class="fl">Mínimo de jugadores<input type="number" inputmode="numeric" min="1" max="30" data-insc="min" value="${cfg.min}"></label>
      <label class="fl">Máximo de jugadores<input type="number" inputmode="numeric" min="1" max="30" data-insc="max" value="${cfg.max}"></label>
    </div>
    ${inscAgreementNote()}`;
function inscConfigCard(online = true) {
  const cfg = inscOf();
  if (!online) return `<div class="card"><h2>👥 Jugadores por equipo · ${esc(catName(S.cat))}</h2>${inscSizeHTML(cfg)}</div>`;
  return `<div class="card">
    <h2>📝 Inscripción en línea · ${esc(catName(S.cat))}</h2>
    <p class="muted" style="font-size:14px">Los capitanes inscriben a su equipo desde su teléfono y ustedes aprueban, observan o rechazan en <b>Equipos</b>. Cada categoría tiene su propio plazo y tamaño de equipo.</p>
    <label class="opt ${cfg.open ? 'on' : ''}"><input type="checkbox" data-insc="open" ${cfg.open ? 'checked' : ''}><div><b>Inscripción en línea habilitada</b><span>Los capitanes pueden crear, enviar y modificar inscripciones dentro de los plazos.</span></div></label>
    <label class="fl">Apertura <small>(acuerdo: a partir del día 25 · vacío = desde ya)</small><input type="datetime-local" data-insc="from" value="${toLocalInput(cfg.from)}"></label>
    <label class="fl">Cierre de inscripción de equipos <small>(fecha y hora)</small><input type="datetime-local" data-insc="until" value="${toLocalInput(cfg.until)}"></label>
    <label class="opt ${cfg.changesLeg1 ? 'on' : ''}"><input type="checkbox" data-insc="changesLeg1" ${cfg.changesLeg1 ? 'checked' : ''}><div><b>Altas y bajas durante la primera vuelta</b><span>${cfg.changesLeg1 ? 'Se cierran solas cuando se juega el último partido de la primera vuelta (acuerdo del comité).' : 'Se cierran en la fecha de abajo (o con la inscripción de equipos).'}</span></div></label>
    <label class="fl">${cfg.changesLeg1 ? 'Cierre de altas y bajas a más tardar <small>(opcional)</small>' : 'Cierre de altas y bajas de jugadores <small>(vacío = mismo cierre de equipos)</small>'}<input type="datetime-local" data-insc="changesUntil" value="${toLocalInput(cfg.changesUntil)}"></label>
    ${inscSizeHTML(cfg)}
    <small>Hora de este teléfono. El cierre lo aplica el servidor aunque el capitán tenga la pantalla abierta.</small>
  </div>`;
}
/** Reglamento del torneo. Si nunca se ha escrito uno, se usa el del Campeonato de Futbolito Perquín 2026. */
const strHash = (s) => hash36(String(s).replace(/\r/g, '').trim());
/** Versiones anteriores del reglamento modelo: si el torneo guardó una sin modificarla, se muestra la vigente. */
const OLD_TEMPLATES = new Set(['ozxzcr']);
const rulesText = (tor) => (tor.rules == null || OLD_TEMPLATES.has(strHash(tor.rules)) ? RULES_TEMPLATE : tor.rules);
function rulesCard() {
  return `<div class="card">
    <h2>📜 Reglamento del torneo</h2>
    <p class="muted" style="font-size:14px">Lo ven capitanes, jugadores y público con el botón “Reglamento”. Formato: <b># Título</b>, <b>- punto</b>, <b>1. punto numerado</b>. Se guarda al salir del cuadro.</p>
    <textarea id="t-rules" rows="10" maxlength="20000" placeholder="Escriba o pegue el reglamento…">${esc(rulesText(TOR()))}</textarea>
    <div class="row" style="margin-top:10px">
      <button class="btn ghost sm" data-a="rulesTemplate">📄 Usar reglamento Perquín 2026</button>
      <button class="btn ghost sm" data-a="openRules">👁️ Ver</button>
    </div>
  </div>`;
}

const RULES_TEMPLATE = `# Generalidades
- Como estructura partidaria de Nuevas Ideas en el Distrito de Perquín, se realizará la planificación, organización, coordinación y ejecución del campeonato de futbolito, que se regirá por lo siguiente.
- El campeonato se desarrollará por medio de esta plataforma digital, abierta a todos los participantes y a todo el que quiera dar seguimiento permanente al evento.
- Se convocará a una reunión previa con todos los interesados en formar equipos. Entre los asistentes se formará un comité organizador, integrado por las diferentes categorías, con voz y voto en todo lo relacionado con la estructura, forma y bases de competencia.
- Se presentará un borrador que, en la primera reunión, deberá considerar todas las opciones de fondo posibles para lograr una mejor organización.
- De los representantes se nombrará una junta directiva con voz y voto para la toma de decisiones, dentro de lo acordado al inicio.
- Cada miembro de la junta directiva velará por los intereses del torneo de forma íntegra, sin salirse de los lineamientos, bases y reglamento aprobados.
- La junta directiva general se reunirá una vez a la semana para realizar las programaciones y verificar resultados.

# Equipos e inscripción
- Cada equipo inscribirá un representante propietario y un suplente. El suplente actuará únicamente cuando el propietario no esté.
- En las categorías Juvenil y Libre, los participantes deberán pertenecer al municipio de Perquín. También podrán participar quienes vivan permanentemente en el municipio.
- En la categoría Femenino las jugadoras son libres: pueden ser de otros municipios.
- La inscripción se realizará por medio de esta plataforma, a partir del día 25 y hasta la fecha de cierre que anuncie la organización, con toda la información que se requiera.
- El mínimo de jugadores será de 5 y el máximo a inscribir será de 8.
- Se permitirá inscribir y desinscribir jugadores durante toda la primera vuelta. Los jugadores desinscritos quedan intransferibles y no podrán jugar en otros equipos.
- Durante la primera vuelta, si el equipo tiene cupos vacíos, se podrá inscribir a un jugador el mismo día del partido, antes de que juegue.
- El jugador desinscrito conserva los goles que anotó. Si otro jugador ocupa su número, comienza con cero goles.
- Toda inscripción se hará por medios digitales, por el encargado de realizar cambios en el sistema, y deberá tener la aprobación de los organizadores.
- Al desinscribir a un jugador se deberá justificar el motivo por el cual ya no participará.
- Cada equipo presentará un logo y los colores de uniforme a utilizar; de preferencia camisas numeradas, y el mismo jugador usará siempre el mismo número en todo el campeonato.
- Si el equipo no se presenta debidamente identificado con su uniforme, será causal de pérdida de puntos.
- El sistema muestra a qué equipo pertenece cada jugador y detectará si un jugador intenta inscribirse en dos equipos; se le consultará al jugador en cuál equipo desea participar.
- El representante será el responsable de recibir y entregar los chalecos.

# Formato de competencia
- Se jugará en dos grupos, a dos vueltas (primera y segunda vuelta). Luego vienen la clasificación y las finales.
- Clasificarán los dos equipos de mayor puntuación de cada grupo.
- En caso de empate, para efectos de clasificación se definirá por diferencia de goles.
- Las semifinales serán cruzadas entre grupos (1° de un grupo contra 2° del otro) y, junto con la final, se jugarán a ida y vuelta como una liguilla.
- En semifinales y finales solo cuentan los puntos (3 por partido ganado, 1 por empate); los goles no cuentan. Si la serie termina empatada en puntos, se define por penales al final del partido de vuelta.

# Partidos
- Para su identificación, los jugadores titulares y suplentes deberán presentarse al terreno de juego para el reconocimiento del árbitro. El careo se hará 10 minutos antes de iniciar el juego.
- Al inicio del partido el árbitro registra qué jugadores están presentes y cuáles no.
- Después de la hora programada se esperará a los equipos un máximo de 15 minutos.
- Un partido podrá iniciar con un mínimo de TRES jugadores. Si un equipo tiene menos integrantes presentes que los de cancha, el árbitro deja constancia de que inicia con los que tenga, siempre que sean al menos tres; de lo contrario, el equipo pierde por default.
- No habrá límite de cambios durante el partido.
- Se jugarán dos tiempos de 30 minutos, con un descanso máximo de 5 minutos después del primer tiempo.

# Pérdida de partidos
- Todo equipo perderá el juego a favor de su contrincante, al que se adjudicarán los tres puntos, cuando no se presente a la hora indicada, por conductas inapropiadas o por agresión al árbitro.
- Cuando un equipo pierda el juego por estas causas, el resultado será de dos a cero a favor de su adversario, anotando los goles al capitán.
- El equipo que no se presente a 3 juegos consecutivos del campeonato quedará automáticamente fuera.
- No se aceptan reclamos sobre el trámite del partido. Toda apelación se hará en reunión con las partes involucradas, con elementos justificables.
- Los árbitros rendirán ante el comité, únicamente en las reuniones, un informe de todos los incidentes del partido.

# Tarjeta blanca: 2 minutos fuera del terreno de juego
- Durante esos 2 minutos el jugador no podrá jugar. Se aplica por:
1. Entrar o salir sin autorización del árbitro.
2. Botar el balón deliberadamente.
3. Entrar cambiándose.
4. Tirar el balón encima de las mallas que están sobre la cancha.

# Tarjetas amarillas
1. Agresiones verbales y palabras obscenas.
2. Falta física leve por conducta antideportiva.

# Expulsiones y suspensiones
- Dos tarjetas amarillas en el mismo partido: expulsión y 1 partido de suspensión.
- Una tarjeta amarilla más una roja: 2 partidos de suspensión.
- Roja directa: 3 partidos de suspensión.
- Roja con agresiones: expulsión de todo el campeonato.
- Las suspensiones se cumplen en los siguientes partidos que juegue el equipo.

# Reglas de juego
1. Toda mano y falta grave dentro del área será sancionada como penal, sin ningún jugador o jugadora en la portería.
2. No se permite invadir el área pequeña por más de 5 segundos; si ocurre, el equipo contrario tendrá un tiro libre desde el centro de la cancha con un jugador estático cubriendo la portería.
3. Todo balón de saque de meta no debe sobrepasar la media cancha; si lo hace, será posesión del equipo contrario.
4. Los saques de banda serán en contacto con el piso, sujetando el balón con la mano y golpeándolo de forma rasante.
5. No está permitido que el jugador se sujete de la malla; hacerlo será falta sancionada por el árbitro.`;


/* ---------------- Eventos ---------------- */
const actions = {
  cat: (d) => { S.cat = d.c; save(); render(); window.scrollTo(0, 0); },
  tab: (d) => {
    S.tab = d.t; save(); render(); window.scrollTo(0, 0);
    if (d.t === 'ajustes' && auth && isAdmin() && sync.mode !== 'local') loadOrgs();
    if (d.t === 'ajustes' && !signedIn()) checkSetup();
  },
  close: () => { if (modal && modal.type === 'rules' && modal.back) { modal = modal.back; return renderModal(); } closeModal(); },
  view: (d) => { S.view = d.v; save(); render(); },
  viewTeam: (d) => openModal('teamView', d.id),
  openSchedule: () => openModal('schedule', null),
  applySchedule: () => applySchedule(),
  clearSchedule: () => {
    const ms = T().matches.filter((m) => m.status === 'pend' && m.date);
    if (!ms.length) return toast('No hay partidos pendientes con fecha');
    ask('Se quitará la fecha, hora y cancha de ' + ms.length + ' partidos pendientes.', { title: '🗓️ Quitar fechas', ok: 'Quitar fechas' }).then((ok) => {
      if (!ok) return;
      ms.forEach((m) => { m.date = ''; m.time = ''; m.field = ''; });
      save(); closeModal(); render();
    });
  },
  logout: () => {
    const go = () => {
      setAuth(null); orgs = null; inscList = null; inscBans = [];
      sync.dirty = false; sync.rev = -1;
      S.tab = ADMIN_URL ? 'ajustes' : 'inicio'; render(); pull(true);
      toast('Sesión cerrada');
    };
    if (sync.dirty) return ask('Hay cambios que aún no se guardaron en línea.', { title: 'Cerrar sesión', ok: 'Cerrar de todos modos', danger: true }).then((ok) => { if (ok) go(); });
    go();
  },
  changePass: async () => {
    const p1 = await askText('Mínimo 6 caracteres.', { title: '🔑 Nueva contraseña', type: 'password', ok: 'Siguiente' });
    if (!p1) return;
    if (p1.length < 6) return toast('Mínimo 6 caracteres');
    if ((await askText('Escríbala otra vez para confirmar.', { title: '🔑 Repetir contraseña', type: 'password', ok: 'Cambiar' })) !== p1) return toast('Las contraseñas no coinciden');
    const { status, j } = await authCall({ action: 'password', pass: p1 });
    if (status === 401) return sessionExpired();
    toast(status === 200 ? '✅ Contraseña cambiada' : (j && j.error) || 'No se pudo cambiar');
  },
  orgRole: async (d) => {
    const txt = d.r === 'arbitro' ? 'solo podrá anotar en los partidos que se le asignen' : 'podrá inscribir, sortear, programar y editar todo';
    if (!(await ask('"' + d.u + '" ' + txt + '.', { title: d.r === 'arbitro' ? 'Hacer árbitro' : 'Hacer organizador', ok: 'Cambiar' }))) return;
    const { status, j } = await authCall({ action: 'setRole', user: d.u, role: d.r });
    if (status === 401) return sessionExpired();
    if (status !== 200) return toast((j && j.error) || 'No se pudo cambiar el rol');
    orgs = j; render(); toast('Rol actualizado');
  },
  delOrg: async (d) => {
    if (!(await ask('"' + d.u + '" ya no podrá ingresar ni editar.', { title: 'Quitar usuario', ok: 'Quitar', danger: true }))) return;
    const { status, j } = await authCall({ action: 'remove', user: d.u });
    if (status === 401) return sessionExpired();
    if (status !== 200) return toast((j && j.error) || 'No se pudo quitar');
    orgs = j; render(); toast('Usuario quitado');
  },
  // Siempre traer el estado actual (la organización pudo aprobar u observar mientras tanto)
  capOpen: () => { modal = { type: 'cap' }; if (capAuth) capReg = null; renderModal(); if (capAuth) capLoad(); },
  capSave: (d) => capSave(!!d.send),
  capBaja: (d) => capBaja(d.n),
  capLogout: () => ask('Saldrá de la inscripción en este teléfono. Para volver a entrar necesitará su código y su clave.', { title: 'Salir', ok: 'Salir' }).then((ok) => {
    if (!ok) return;
    setCap(null); modal = { type: 'cap' }; renderModal(); render(); toast('Salió de la inscripción');
  }),
  openRules: () => {
    // Desde la inscripción: guardar lo escrito para volver sin perderlo
    if (modal && modal.type === 'cap') {
      const back = capReg ? { type: 'cap', draft: Object.assign({}, capReg, capCollect()), crest: modal.crest, accept: modal.accept, errors: modal.errors, general: modal.general } : { type: 'cap' };
      modal = { type: 'rules', back };
      return renderModal();
    }
    openModal('rules', null);
  },
  inscReload: () => loadInsc(true).then(() => toast('Inscripciones actualizadas')),
  inscView: (d) => openModal('inscAdmin', d.id),
  inscApprove: (d) => inscApprove(d.id),
  inscReview: async (d) => {
    const obs = d.st === 'observada';
    const note = await askText(obs ? 'Escriba qué debe corregir el capitán. Lo verá en su inscripción.' : 'Escriba el motivo del rechazo. Lo verá el capitán.', { title: obs ? '⚠️ Observaciones' : '❌ Rechazar inscripción', ok: obs ? 'Enviar observación' : 'Rechazar', danger: !obs });
    if (note == null) return;
    if (note.trim().length < 5) return toast('Escriba un poco más de detalle');
    try {
      const { status, j } = await admInsc({ action: 'review', id: d.id, status: d.st, note: note.trim() });
      if (status === 401) return sessionExpired();
      if (status !== 200) return toast(j.error || 'No se pudo guardar');
      replaceReg(j.reg); loadInsc(true); renderModal(); render(); toast(obs ? 'Observación enviada al capitán' : 'Inscripción rechazada');
    } catch (e) { toast('Sin conexión'); }
  },
  inscPin: async (d) => {
    const pass = await askText('Nueva clave para el capitán (mínimo 6 caracteres). Entréguesela personalmente o por un medio seguro.', { title: '🔑 Restablecer clave', ok: 'Guardar' });
    if (pass == null) return;
    if (pass.length < 6) return toast('La clave debe tener al menos 6 caracteres');
    try {
      const { status, j } = await admInsc({ action: 'resetPin', id: d.id, pass });
      if (status === 401) return sessionExpired();
      if (status !== 200) return toast(j.error || 'No se pudo cambiar');
      replaceReg(j.reg); renderModal(); toast(`✅ Clave cambiada. Código: ${d.id}`);
    } catch (e) { toast('Sin conexión'); }
  },
  inscRemove: async (d) => {
    const ok = await ask('Se eliminará esta inscripción (no aprobada). El capitán ya no podrá entrar con su código.', { title: '🗑️ Eliminar inscripción', ok: 'Eliminar', danger: true });
    if (!ok) return;
    const { status, j } = await admInsc({ action: 'remove', id: d.id });
    if (status === 401) return sessionExpired();
    if (status !== 200) return toast(j.error || 'No se pudo eliminar');
    inscList = (inscList || []).filter((x) => x.id !== d.id);
    closeModal(); render(); toast('Inscripción eliminada');
  },
  inscAgreement: async () => {
    if (!isAdmin()) return;
    const off = offAgreement();
    if (!off.length) return;
    const { min, max } = INSC_DEF;
    // Equipos (o inscripciones en línea) que quedarían fuera del rango: se avisan, no se borran jugadores
    const big = [];
    for (const [k, c] of off) {
      for (const tm of c.teams) if (tm.players.length > max || tm.players.length < min) big.push(`${tm.name} (${c.name}): ${tm.players.length}`);
      for (const r of inscList || []) if (r.tor === S.tor && r.cat === k && r.status !== 'rechazada' && !r.teamId && r.players.length > max) big.push(`inscripción de ${r.name} (${c.name}): ${r.players.length}`);
    }
    const ok = await ask(`Se aplicará de ${min} a ${max} jugadores por equipo en: ${off.map(([, c]) => c.name).join(', ')}.${big.length ? `\n\n⚠️ Estos equipos quedan fuera del rango y deberán ajustar su lista (no se borra a nadie):\n• ${big.join('\n• ')}` : ''}`, { title: 'Acuerdo del comité', ok: 'Aplicar' });
    if (!ok) return;
    for (const [, c] of off) c.config.insc = Object.assign(inscOf(c), { min, max });
    save(); render(); toast(`Aplicado: de ${min} a ${max} jugadores por equipo`);
  },
  inscUnban: async (d) => {
    const b = inscBans.find((x) => x.key === d.k);
    const ok = await ask(`${b ? b.name : 'El jugador'} podrá volver a inscribirse en cualquier equipo. Úselo solo para corregir una baja hecha por error.`, { title: 'Habilitar jugador', ok: 'Habilitar' });
    if (!ok) return;
    const { status, j } = await admInsc({ action: 'unban', key: d.k });
    if (status === 401) return sessionExpired();
    if (status !== 200) return toast(j.error || 'No se pudo habilitar');
    inscBans = inscBans.filter((x) => x.key !== d.k);
    render(); toast('Jugador habilitado');
  },
  rulesTemplate: async () => {
    if (rulesText(TOR()) && rulesText(TOR()) !== RULES_TEMPLATE && !(await ask('Se reemplazará el reglamento actual por el del Campeonato de Futbolito Perquín 2026.', { title: '📄 Usar plantilla', ok: 'Reemplazar', danger: true }))) return;
    TOR().rules = RULES_TEMPLATE; save(); render(); toast('Reglamento cargado. Puede editarlo.');
  },
  invNew: async () => {
    const label = await askText(`¿A quién va dirigida? Escriba el nombre del capitán y/o del equipo.\n\nCategoría: ${catName(S.cat)}`, { title: '✉️ Nueva invitación', placeholder: 'Ej: Juan López – Los Tigres', ok: 'Crear invitación' });
    if (label == null) return;
    if (label.trim().length < 3) return toast('Escriba el nombre del capitán o del equipo');
    try {
      const { status, j } = await admInsc({ action: 'invite', tor: S.tor, cat: S.cat, label: label.trim() });
      if (status === 401) return sessionExpired();
      if (status !== 200) return toast(j.error || 'No se pudo crear la invitación');
      inscInvites.unshift(j.invite); render();
      const how = await askChoice(`Invitación para ${j.invite.label}\n\n${invLink(j.invite.code)}\n\nEnvíela solo a esa persona.`,
        [{ key: 'W', label: '💬 Enviar por WhatsApp', value: 'wa' }, { key: 'C', label: '📋 Copiar mensaje', value: 'copy', style: 'ghost' }], { title: '✅ Invitación creada', cancel: 'Después' });
      if (how) invShare(j.invite, how);
    } catch (e) { toast('Sin conexión'); }
  },
  invWa: (d) => { const i = inscInvites.find((x) => x.code === d.c); if (i) invShare(i, 'wa'); },
  invCopy: (d) => { const i = inscInvites.find((x) => x.code === d.c); if (i) invShare(i, 'copy'); },
  invDel: async (d) => {
    const i = inscInvites.find((x) => x.code === d.c);
    if (!(await ask(`Se anulará la invitación de ${i ? i.label : ''}. El enlace dejará de funcionar.`, { title: 'Anular invitación', ok: 'Anular', danger: true }))) return;
    const { status, j } = await admInsc({ action: 'invDel', code: d.c });
    if (status === 401) return sessionExpired();
    if (status !== 200) return toast(j.error || 'No se pudo anular');
    inscInvites = inscInvites.filter((x) => x.code !== d.c); render(); toast('Invitación anulada');
  },
  champCats: async () => {
    const cats = CATS_(), used = new Set(), plan = [];
    for (const [, name, color, re] of CHAMP_CATS) {
      const k = Object.keys(cats).find((x) => !used.has(x) && (cats[x].name === name || re.test(norm(cats[x].name))));
      if (k) { used.add(k); if (cats[k].name !== name) plan.push({ k, name, txt: `“${cats[k].name}” → ${name} (conserva sus ${cats[k].teams.length} equipos)` }); }
      else plan.push({ name, color, txt: `Nueva: ${name}` });
    }
    const rest = Object.keys(cats).filter((k) => !used.has(k)).map((k) => cats[k].name);
    if (!plan.length) return toast('Las categorías ya están listas');
    const ok = await ask(plan.map((x) => '• ' + x.txt).join('\n') + (rest.length ? `\n\nNo se tocan: ${rest.join(', ')} (puede eliminarlas o renombrarlas después).` : ''), { title: '⚽ Categorías del campeonato', ok: 'Aplicar' });
    if (!ok) return;
    for (const x of plan) {
      if (x.k) cats[x.k].name = x.name;
      else { const id = 'c' + uid(); cats[id] = newTournament(x.name, x.color); }
    }
    // Orden: Femenino, Juvenil, Libre y después las demás
    const ordered = {};
    for (const [, name] of CHAMP_CATS) { const k = Object.keys(cats).find((x) => cats[x].name === name); if (k) ordered[k] = cats[k]; }
    for (const k of Object.keys(cats)) if (!ordered[k]) ordered[k] = cats[k];
    TOR().cats = ordered;
    save(); render(); toast('✅ Categorías listas');
  },
  newTeam: () => openModal('team', null),
  editTeam: (d) => openModal('team', d.id),
  saveTeam: () => saveTeam(),
  delTeam: (d) => {
    const tm = teamById(d.id);
    if (!tm) return;
    ask(`Se eliminará el equipo "${tm.name}" con sus integrantes.${tm.insc ? '\n\nVino de la inscripción en línea: la inscripción del capitán quedará cerrada.' : ''}`, { title: 'Eliminar equipo', ok: 'Eliminar', danger: true }).then(async (ok) => {
      if (!ok) return;
      if (tm.insc && sync.mode !== 'local') {
        try {
          const { status, j } = await admInsc({ action: 'adminSync', id: tm.insc, remove: true });
          if (status === 401) return sessionExpired();
          if (status !== 200 && status !== 404) return toast(j.error || 'No se pudo cerrar la inscripción del capitán');
          if (j.reg) replaceReg(j.reg);
        } catch (e) { return toast('Sin conexión'); }
      }
      T().teams = T().teams.filter((x) => x.id !== d.id);
      save(); closeModal(); render(); toast('Equipo eliminado');
    });
  },
  draw: () => doDraw(),
  genFinal: () => genFinal(),
  undoFinal: () => {
    const t = T();
    const played = t.matches.filter((m) => m.phase === 'ko' && m.status !== 'pend').length;
    const drawn = t.finalInfo && t.finalInfo.pairing === 'sorteo';
    const go = () => {
    if (t.finalInfo) t.drawLog = [...(t.drawLog || []), { type: 'final', at: t.finalInfo.at, by: t.finalInfo.by, annulledAt: Date.now(), annulledBy: auth ? auth.user : 'local' }];
    t.finalInfo = null; t.tieOverride = {};
    t.matches = t.matches.filter((m) => m.phase !== 'ko');
    t.stage = 'fase1'; save(); render(); toast('Fase final deshecha');
    };
    if (played || drawn) {
      const msg = `${drawn ? 'Los cruces se definieron por sorteo. Si los anula, quedará registrado públicamente.' : ''}${played ? `${drawn ? '\n\n' : ''}Hay ${played} partido(s) de la fase final con resultado. Se borrarán.` : ''}`;
      return askWord(msg, { title: '⚠️ Deshacer fase final', ok: 'Deshacer' }).then((ok) => (ok ? go() : toast('No se borró nada')));
    }
    ask('Se borrará la fase final (todavía no tiene resultados).', { title: 'Deshacer fase final', ok: 'Deshacer', danger: true }).then((ok) => { if (ok) go(); });
  },
  undoDraw: () => {
    const t = T();
    const played = t.matches.filter((m) => m.status !== 'pend').length;
    const msg = `El sorteo es oficial y se hace una sola vez. Si lo anula, quedará registrado públicamente que fue anulado (por ${auth ? auth.user : 'este dispositivo'}).${played ? `\n\nTambién se borrarán ${played} partido(s) con resultados, goles y tarjetas.` : ''}`;
    askWord(msg, { title: '⚠️ Anular sorteo oficial', ok: 'Anular sorteo' }).then((ok) => {
    if (!ok) return toast('No se anuló el sorteo');
    if (t.drawInfo) t.drawLog = [...(t.drawLog || []), { type: 'draw', at: t.drawInfo.at, by: t.drawInfo.by, annulledAt: Date.now(), annulledBy: auth ? auth.user : 'local' }];
    t.matches = []; t.groups = []; t.stage = 'inscripcion'; t.drawInfo = null; t.finalInfo = null; t.tieOverride = {}; t.manualClosed = false;
    save(); render(); toast('Sorteo anulado');
    });
  },
  openMatch: (d) => openModal('match', d.id),
  viewTeamCat: (d) => { if (CATS_()[d.c]) S.cat = d.c; render(); openModal('teamView', d.id); },
  openMyMatch: (d) => { if (CATS_()[d.c]) S.cat = d.c; S.tab = 'partidos'; save(); render(); openModal('match', d.id); },
  goal: (d) => {
    // Quitar el último gol del equipo
    const m = editMatch(); if (!m) return;
    const k = d.s === 'h' ? 'hs' : 'as', tid = d.s === 'h' ? m.home : m.away;
    if (!m[k]) return;
    m[k]--;
    m.goals = m.goals || [];
    for (let i = m.goals.length - 1; i >= 0; i--) if (m.goals[i].team === tid) { m.goals.splice(i, 1); break; }
    modal.goalPick = null;
    save(); renderModal();
  },
  goalPick: (d) => {
    if (!modal) return;
    const m = editMatch(); if (!m) return;
    if (m.status === 'pend') return toast('Primero haga la presentación de jugadores e inicie el partido');
    modal.goalPick = d.s; modal.goalMode = 'g'; renderModal();
  },
  goalCancel: () => { if (modal) { modal.goalPick = null; modal.goalMode = null; renderModal(); } },
  goalMode: (d) => { if (modal && modal.goalPick) { modal.goalMode = d.m; renderModal(); } },
  scorer: (d) => {
    const m = editMatch(); if (!m || !modal.goalPick) return;
    if (m.status === 'pend') return toast('Primero haga la presentación de jugadores e inicie el partido');
    const side = modal.goalPick, tid = side === 'h' ? m.home : m.away, rival = side === 'h' ? m.away : m.home;
    const mode = modal.goalMode || 'g';
    const min = matchMinute(m);
    let player = '', pid = '', own = false;
    if (d.i === 'own') own = true;
    else if (d.pid) {
      const p = playerById(tid, d.pid);
      if (!p) { modal.goalPick = null; renderModal(); return toast('Ese jugador ya no está en el equipo'); }
      const why = cantPlay(m, tid, p.id);
      if (why) return toast('⛔ ' + why);
      player = p.name; pid = p.id;
    }
    modal.goalPick = null; modal.goalMode = null;
    if (mode === 'x') {
      // Penal fallado: queda registrado, no cambia el marcador
      m.penMiss = (m.penMiss || []).concat({ id: uid(), team: tid, player, ...(pid ? { pid } : {}), min });
      save(); renderModal();
      return toast(`❌ Penal fallado · ${player || tname(tid)}`);
    }
    m.goals = m.goals || [];
    m.goals.push({ id: uid(), team: tid, player, ...(pid ? { pid } : {}), own, min, ...(mode === 'p' && !own ? { pen: true } : {}), ...(own ? { player: '', from: tname(rival) } : {}) });
    m[side === 'h' ? 'hs' : 'as']++;
    save(); renderModal();
    toast(`⚽ ${mode === 'p' ? 'Gol de penal' : 'Gol'} de ${tname(tid)}${player ? ' · ' + player : own ? ' (autogol)' : ''}`);
  },
  penMissDel: (d) => { const m = editMatch(); if (!m) return; m.penMiss = (m.penMiss || []).filter((x) => x.id !== d.id); save(); renderModal(); },
  /* Inscribir a un jugador en la cancha (organizador o árbitro del partido) */
  addOnField: async (d) => {
    const m = editMatch(); if (!m || m.status === 'done') return;
    const tm = teamById(d.team), cfg = inscOf();
    if (!tm || !fieldAddOpen(tm)) return toast(tm && tm.players.length >= cfg.max ? `${tm.name} ya tiene el máximo de ${cfg.max} jugadores` : 'Terminó la primera vuelta: ya no se pueden inscribir jugadores');
    const name = ((await askText(`Nombre y apellido del jugador que se inscribe en ${tm.name} (cupo: ${tm.players.length} de ${cfg.max}):`, { title: '➕ Inscribir en la cancha', placeholder: 'Ej: Juan Pérez' })) || '').trim().replace(/\s+/g, ' ');
    if (!name) return;
    if (name.split(' ').filter((w) => w.length >= 2).length < 2) return toast('Escriba nombre y apellido');
    if (tm.players.some((p) => norm(p.name) === norm(name))) return toast(`${name} ya está en ${tm.name}`);
    const other = playerIndex(tm.id).get(norm(name));
    if (other && sync.mode === 'local') return toast(`Ya hay un jugador con ese nombre en ${other}`);
    const num = await askText('Número de camisa (opcional):', { title: name, type: 'number', placeholder: 'Ej: 14' });
    if (num == null) return;
    if (num !== '' && !/^\d{1,2}$/.test(num.trim())) return toast('El número debe ser de 0 a 99');
    if (num !== '' && tm.players.some((p) => String(p.num) === String(+num))) return toast(`El número ${+num} ya lo usa otro jugador de ${tm.name}`);
    let doc = '';
    if (sync.mode !== 'local') {
      doc = await askText(`DUI (opcional)${other ? `

⚠️ Ya hay un jugador con ese nombre en ${other}: si es otra persona, escriba su DUI.` : ''}`, { title: name, placeholder: '00000000-0' });
      if (doc == null) return;
    }
    if (!(await ask(`${name}${num !== '' ? ' #' + +num : ''} se inscribe en ${tm.name} y queda presente para este partido.

Queda registrado quién lo inscribió. Un jugador inscrito ya no puede pasar a otro equipo.`, { title: '➕ Inscribir en la cancha', ok: 'Inscribir' }))) return;
    if (sync.mode === 'local') {
      const pid = Rules.newPlayerId(T(), tm.id, name);
      tm.players.push({ id: pid, name, num: num === '' ? '' : String(+num), sub: true, addedAt: Date.now(), addedBy: 'local', addedIn: m.id });
      const pr = presentOf(m, tm.id);
      if (pr) m.present = Object.assign({}, m.present, { [tm.id]: pr.concat(pid) });
      save(); renderModal(); return toast(`✅ ${name} inscrito en ${tm.name}`);
    }
    // En línea: el servidor valida (un solo equipo por jugador, dados de baja, cupo, primera vuelta) y guarda
    for (let i = 0; i < 20 && (sync.pushing || sync.dirty); i++) { if (!sync.pushing) push(); await new Promise((r) => setTimeout(r, 300)); }
    if (sync.dirty) return toast('Hay cambios sin guardar: espere un momento e intente de nuevo');
    try {
      const { status, j } = await inscCall({ action: 'matchAdd', tor: S.tor, cat: S.cat, matchId: m.id, team: tm.id, name, num, doc }, auth && auth.token);
      if (status === 401) return sessionExpired();
      if (status !== 200) return toast('⛔ ' + (j.error || 'No se pudo inscribir'));
      if (isRef()) adoptKeeping(j, []); else adopt(j);
      if (isAdmin()) loadInsc(true);
      renderModal();
      toast(`✅ ${name} inscrito en ${tm.name}${(j.warn || []).length ? ' · ⚠️ ' + j.warn[0].msg : ''}`);
    } catch (e) { toast('Sin conexión: para inscribir en la cancha se necesita internet'); }
  },
  /* Presentación de jugadores */
  present: (d) => {
    const m = editMatch(); if (!m || m.status === 'done') return;
    if (suspendedIn(m, d.team).some((x) => x.pid === d.pid)) return toast('⛔ Suspendido: no puede jugar este partido');
    const cur = presentOf(m, d.team) || [];
    m.present = Object.assign({}, m.present, { [d.team]: cur.includes(d.pid) ? cur.filter((x) => x !== d.pid) : cur.concat(d.pid) });
    save(); renderModal();
  },
  presentAll: (d) => {
    const m = editMatch(); if (!m || m.status === 'done') return;
    const sus = new Set(suspendedIn(m, d.team).map((x) => x.pid));
    m.present = Object.assign({}, m.present, { [d.team]: (teamById(d.team) || { players: [] }).players.filter((p) => !sus.has(p.id)).map((p) => p.id) });
    save(); renderModal();
  },
  start: async () => {
    const m = editMatch(); if (!m || inBreak(m)) return;
    if (m.status === 'pend') {
      // Validación al inicio: mínimo de jugadores presentes por equipo; si son menos de los de cancha, queda constancia
      const R = matchRules(), st = teamSize().starters;
      const cnt = (tid) => (presentOf(m, tid) || []).length;
      const short = [m.home, m.away].filter((tid) => cnt(tid) < R.minStart);
      if (short.length) return toast(`Para iniciar se necesitan al menos ${R.minStart} jugadores presentes. Falta en: ${short.map(tname).join(' y ')}`);
      const few = [m.home, m.away].filter((tid) => cnt(tid) < st);
      const ok = await ask(`${tname(m.home)}: ${cnt(m.home)} presentes\n${tname(m.away)}: ${cnt(m.away)} presentes${few.length ? `\n\nQueda constancia: ${few.map((tid) => `${tname(tid)} inicia con ${cnt(tid)} integrantes`).join('; ')}.` : ''}${R.halves > 1 ? `\n\n2 tiempos de ${m.duration} min, descanso de ${R.breakMin} min.` : ''}`, { title: '▶ Iniciar partido', ok: 'Iniciar' });
      if (!ok || curMatch() !== m || m.status !== 'pend') return;
      m.startedWith = { [m.home]: cnt(m.home), [m.away]: cnt(m.away) };
      Object.assign(m, { halves: R.halves, period: 1, breakMin: R.breakMin, startedAt: serverNow() });
    }
    m.runAt = Date.now(); m.status = 'live';
    save(); renderModal();
  },
  endHalf: async () => {
    const m = editMatch(); if (!m || m.status !== 'live' || halvesOf(m) < 2 || periodOf(m) !== 1 || inBreak(m)) return;
    if (!(await ask(`Termina el 1er tiempo (${minuteText(m)}). Empieza el descanso de ${m.breakMin || 5} minutos.`, { title: '☕ Fin del 1er tiempo', ok: 'Ir al descanso' }))) return;
    if (curMatch() !== m) return;
    if (m.runAt) { m.elapsed += Date.now() - m.runAt; m.runAt = null; }
    m.h1 = { elapsed: m.elapsed, added: m.added || 0 };
    m.breakAt = Date.now();
    save(); renderModal(); toast('☕ Descanso');
  },
  secondHalf: () => {
    const m = editMatch(); if (!m || !inBreak(m)) return;
    Object.assign(m, { period: 2, elapsed: 0, added: 0, alerted: false, alertedAdd: false, breakAt: null, runAt: Date.now() });
    save(); renderModal(); toast('▶ Comienza el 2º tiempo');
  },
  /* Equipo que no se presentó: después de la espera reglamentaria */
  wo: async () => {
    const m = editMatch(); if (!m || m.status !== 'pend' || !m.home || !m.away) return;
    const R = matchRules(), at = schedAt(m);
    if (at && serverNow() < at + R.waitMin * 60000) return toast(`Aún no terminan los ${R.waitMin} minutos de espera`);
    const opts = [m.home, m.away].map((tid, i) => ({ key: String(i + 1), label: `${tname(tid)} no se presentó`, value: tid, style: 'danger' }));
    if (m.phase !== 'ko') opts.push({ key: 'B', label: 'No se presentó ninguno', value: 'both', style: 'ghost' });
    const who = await askChoice(`El equipo presente gana ${R.woGoals}-0 y se lleva los 3 puntos.${at ? '' : '\n\n⚠️ Este partido no tiene hora programada.'}`, opts, { title: '🚫 W.O. (no se presentó)' });
    if (!who) return;
    const note = await askText('Observación (opcional, queda registrada):', { title: 'W.O.', placeholder: 'Ej: esperamos hasta las 8:15' });
    if (note == null || curMatch() !== m || m.status !== 'pend') return;
    Object.assign(m, { wo: who, woAt: serverNow(), woBy: auth ? auth.user : 'local', woNote: note.trim().slice(0, 200), goals: [], ph: null, pa: null, runAt: null, status: 'done' });
    if (who === 'both') { m.hs = 0; m.as = 0; } else { m.hs = who === m.away ? R.woGoals : 0; m.as = who === m.home ? R.woGoals : 0; }
    syncKO(); save(); closeModal(); render();
    const streak = who === 'both' ? [m.home, m.away] : [who];
    const out = streak.filter((tid) => { const l = teamMatches(tid).filter((x) => x.status === 'done'); let k = 0; for (let i = l.length - 1; i >= 0 && (l[i].wo === tid || l[i].wo === 'both'); i--) k++; return k >= 3; });
    toast(`🚫 W.O. registrado${out.length ? ` · ⚠️ ${out.map(tname).join(' y ')} lleva 3 W.O. seguidos: según el reglamento queda fuera` : ''}`);
  },
  /* Tanda de penales tiro por tiro */
  kick: (d) => {
    const m = editMatch(); if (!m) return;
    m.shoot = (m.shoot || []).concat({ id: uid(), team: d.team, scored: d.ok === '1' });
    m.ph = m.shoot.filter((k) => k.team === m.home && k.scored).length;
    m.pa = m.shoot.filter((k) => k.team === m.away && k.scored).length;
    save(); renderModal();
  },
  kickUndo: () => {
    const m = editMatch(); if (!m || !(m.shoot || []).length) return;
    m.shoot = m.shoot.slice(0, -1);
    m.ph = m.shoot.filter((k) => k.team === m.home && k.scored).length;
    m.pa = m.shoot.filter((k) => k.team === m.away && k.scored).length;
    save(); renderModal();
  },
  pause: () => {
    const m = editMatch(); if (!m || !m.runAt) return;
    m.elapsed += Date.now() - m.runAt; m.runAt = null;
    save(); renderModal();
  },
  addTime: (d) => {
    const m = editMatch(); if (!m) return;
    m.added = Math.max(0, Math.min(30, (m.added || 0) + Number(d.n)));
    m.alertedAdd = false;
    save(); renderModal();
    toast(m.added ? `⏱ Tiempo agregado: +${m.added}'` : 'Sin tiempo agregado');
  },
  card: async (d) => {
    const m = editMatch(); if (!m) return;
    const team = $('#c-team').value, pl = playerById(team, $('#c-player').value);
    if (!pl) return toast('Seleccione un jugador');
    const player = pl.name, pid = pl.id;
    if (m.status === 'pend') return toast('Primero haga la presentación de jugadores e inicie el partido');
    if (suspendedIn(m, team).some((x) => x.pid === pid)) return toast(`⛔ ${player} está suspendido y no puede jugar este partido`);
    const pr = presentOf(m, team);
    if (pr && !pr.includes(pid)) return toast(`${player} no está marcado como presente`);
    let min = $('#c-min').value;
    min = min === '' ? matchMinute(m) : Math.max(0, parseInt(min, 10) || 0);
    const mine = m.cards.filter((c) => c.team === team && evKey(c) === pid);
    if (mine.some((c) => c.type === 'R')) return toast(`${player} ya fue expulsado en este partido`);
    const agg = d.type === 'R' && d.agg === '1';
    if (agg) {
      const ok = await ask(`${player} (${tname(team)}) recibe roja por agresión: queda fuera ${sancText(sancN(sancRules().agg))}.`, { title: '🟥 Roja con agresión', ok: 'Confirmar', danger: true });
      const cur = curMatch();
      if (!ok || cur !== m) return;
    }
    const yellows = mine.filter((c) => c.type === 'Y').length;
    const id = uid();
    if (d.type === 'W') {
      // Tarjeta blanca: 2 minutos de juego fuera (el reloj pausado o el descanso no descuentan)
      const ms = matchRules().whiteMin * 60000;
      m.cards.push({ id, team, player, pid, type: 'W', min, wAt: playMs(m), wMs: ms });
      save(); renderModal();
      return toast(`⬜ Blanca · ${player}: ${matchRules().whiteMin} minutos fuera`);
    }
    m.cards.push({ id, team, player, pid, type: d.type, min, ...(agg ? { agg: true } : {}) });
    // Doble amarilla = roja automática
    if (d.type === 'Y' && yellows >= 1) m.cards.push({ id: uid(), team, player, pid, type: 'R', min, auto: true, from: id });
    save(); renderModal();
    if (d.type === 'Y' && yellows >= 1) toast(`🟥 Segunda amarilla: ${player} expulsado (roja automática)`);
    else toast(`${d.type === 'Y' ? '🟨 Amarilla' : agg ? '🟥 Roja con agresión' : '🟥 Roja'} · ${player}`);
  },
  delCard: (d) => {
    const m = editMatch(); if (!m) return;
    m.cards = m.cards.filter((c) => c.id !== d.id && c.from !== d.id); // si se quita la 2ª amarilla, se quita su roja
    save(); renderModal();
  },
  /* Ajuste del comité a la sanción de una tarjeta (apelación): cambia los partidos o la anula, con motivo */
  sancAdj: async (d) => {
    const m = editMatch(); if (!m || !isAdmin()) return;
    const s = sanctionList(d.team).find((x) => x.matchId === m.id && x.kind === 'card' && x.pid === d.pid);
    if (!s) return;
    const opts = [{ key: '0', label: 'Anular (sin suspensión)', value: 0, style: 'ghost' }, ...sancChoices()];
    if (s.adj) opts.push({ key: 'R', label: `Volver a la regla (${sancText(s.base)})`, value: 'rule', style: 'ghost' });
    const n = await askChoice(`${s.player} · ${s.why}\nSegún la regla: ${sancText(s.base)}${s.adj ? `\nAhora: ${sancText(s.n)} (ajustada)` : ''}\n\n¿Cuántos partidos decidió el comité?`, opts, { title: '⚖️ Ajustar sanción' });
    if (n == null) return;
    const reason = await askText(n === 'rule' ? 'Motivo para volver a la regla:' : 'Motivo de la decisión del comité (queda registrado y es público):', { title: 'Motivo', placeholder: 'Ej: apelación aprobada en reunión del 3/12' });
    if (reason == null) return;
    if (reason.trim().length < 5) return toast('Escriba el motivo (al menos 5 letras)');
    const cur = curMatch(); if (!cur) return;
    const adj = Object.assign({}, cur.sancAdj);
    if (n === 'rule') delete adj[d.pid];
    else adj[d.pid] = { n, reason: reason.trim().slice(0, 200), by: auth ? auth.user : 'local', at: Date.now() };
    cur.sancAdj = adj;
    save(); renderModal();
    toast(n === 'rule' ? 'Sanción según la regla' : `Sanción ajustada: ${sancText(sancN(n))}`);
  },
  /* Sanción directa del comité (por ejemplo, por un informe del árbitro) a partir de este partido */
  sancAdd: async () => {
    const m = editMatch(); if (!m || !isAdmin()) return;
    const team = await askChoice('¿De qué equipo es el jugador?', [m.home, m.away].map((id, i) => ({ key: String(i + 1), label: tname(id), value: id, style: 'ghost' })), { title: '➕ Sanción del comité' });
    if (!team) return;
    const tm = teamById(team);
    const pid = await askChoice('¿Qué jugador?', tm.players.map((p, i) => ({ key: String(i + 1), label: `${p.num ? p.num + ' · ' : ''}${p.name}`, value: p.id, style: 'ghost' })), { title: tname(team) });
    if (!pid) return;
    const n = await askChoice(`${playerById(team, pid).name}: se cumple desde el siguiente partido que juegue ${tname(team)}.`, sancChoices(), { title: 'Partidos de suspensión' });
    if (n == null) return;
    const reason = await askText('Motivo (queda registrado y es público):', { title: 'Motivo', placeholder: 'Ej: informe del árbitro por agresión verbal' });
    if (reason == null) return;
    if (reason.trim().length < 5) return toast('Escriba el motivo (al menos 5 letras)');
    const cur = curMatch(); if (!cur) return;
    cur.sancExtra = (cur.sancExtra || []).concat({ id: uid(), team, pid, player: playerById(team, pid).name, n, reason: reason.trim().slice(0, 200), by: auth ? auth.user : 'local', at: Date.now() });
    save(); renderModal();
    toast(`Sanción registrada: ${sancText(sancN(n))}`);
  },
  sancDel: async (d) => {
    const m = editMatch(); if (!m || !isAdmin()) return;
    if (!(await ask('Se quitará esta sanción del comité.', { title: 'Quitar sanción', ok: 'Quitar', danger: true }))) return;
    m.sancExtra = (m.sancExtra || []).filter((e) => e.id !== d.id);
    save(); renderModal(); toast('Sanción quitada');
  },
  matchAgree: async () => {
    if (!isAdmin()) return;
    const t = T(), pend = t.matches.filter((m) => m.status === 'pend' && m.duration !== MATCH_AGREE.duration);
    const ok = await ask(`${catName(S.cat)}: ${MATCH_AGREE.halves} tiempos de ${MATCH_AGREE.duration} minutos con ${MATCH_AGREE.breakMin} de descanso, espera de ${MATCH_AGREE.waitMin} minutos, mínimo ${MATCH_AGREE.minStart} jugadores para iniciar, tarjeta blanca de ${MATCH_AGREE.whiteMin} minutos y W.O. ${MATCH_AGREE.woGoals}-0.${pend.length ? `\n\nTambién se cambiarán a ${MATCH_AGREE.duration} minutos por tiempo ${pend.length} partido(s) pendientes. Los ya jugados o en juego no cambian.` : ''}`, { title: 'Acuerdo del comité', ok: 'Aplicar' });
    if (!ok) return;
    const { duration, ...rest } = MATCH_AGREE;
    t.config.duration = duration;
    t.config.match = Object.assign({}, rest);
    pend.forEach((m) => { m.duration = duration; });
    save(); render(); toast('Reglas del partido según el acuerdo del comité');
  },
  formatComite: () => {
    if (!isAdmin() || T().stage !== 'inscripcion') return;
    Object.assign(T().config, COMITE_FORMAT);
    save(); render(); toast('Formato del comité aplicado. Revise y realice el sorteo.');
  },
  sancDefault: () => {
    if (!isAdmin()) return;
    T().config.sanc = Object.assign({}, SANC_DEF);
    save(); render(); toast('Sanciones según el acuerdo del comité');
  },
  finish: () => finishMatch(),
  reopen: () => reopenMatch(),
  export: () => {
    const blob = new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `torneo-respaldo-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  resetCat: () => {
    askWord(`Se borrarán TODOS los equipos, pagos, partidos y resultados de ${catName(S.cat)}. La categoría se conserva vacía.`, { title: '⚠️ Vaciar ' + catName(S.cat), ok: 'Vaciar' }).then((ok) => {
      if (!ok) return toast('No se borró nada');
      CATS_()[S.cat] = newTournament(T().name, T().color); save(); render(); toast('Categoría vaciada');
    });
  },
  crestRandom: () => { if (modal) { modal.crest = randomCrest(); updateCrestUI(); } },
  crestSet: (d) => {
    if (!modal) return;
    const base = modal.crest && !modal.crest.img ? modal.crest : Object.assign(randomCrest(), { e: 'balon' });
    modal.crest = Object.assign({}, base, { [d.k]: d.v });
    updateCrestUI();
  },
  crestNone: () => { if (modal) { modal.crest = null; updateCrestUI(); } },
  crestPreset: (d) => { if (modal) { modal.crest = clone(CREST_PRESETS[+d.i]); updateCrestUI(); } },
  openTorneos: () => openModal('torneos', null),
  openHistory: async () => {
    historyList = null; openModal('history', null);
    try {
      const { status, j } = await apiCall('GET', null, '?history=1');
      if (status === 401) return sessionExpired();
      historyList = status === 200 && j ? j.versions : [];
    } catch (e) { historyList = []; toast('Sin conexión'); }
    if (modal && modal.type === 'history') renderModal();
  },
  openCompare: () => openModal('compare', null),
  manualNew: () => { modal = { type: 'manualMatch', id: null, pair: null }; renderModal(); },
  manualSuggest: () => {
    if (T().teams.length < 2) return toast('Se necesitan al menos 2 equipos');
    const pair = suggestPair();
    modal = { type: 'manualMatch', id: null, pair };
    renderModal();
    toast(`🎲 Sugerido: ${tname(pair[0])} vs ${tname(pair[1])}`);
  },
  manualCreate: () => {
    const t = T();
    const home = $('#mm-h').value, away = $('#mm-a').value, round = Math.max(1, parseInt($('#mm-r').value, 10) || 1);
    if (!home || !away) return toast('Elija los dos equipos');
    if (home === away) return toast('Un equipo no puede jugar contra sí mismo');
    const create = () => {
      t.matches.push(mkMatch({ phase: 'liga', group: '', round, home, away }));
      save(); closeModal(); render();
      toast(`✅ Partido creado: ${tname(home)} vs ${tname(away)}`);
    };
    const already = phase1().filter((m) => [m.home, m.away].sort().join('|') === [home, away].sort().join('|')).length;
    if (already) return ask(`${tname(home)} y ${tname(away)} ya tienen ${already} partido(s) entre ellos. ¿Crear otro?`, { title: 'Cruce repetido', ok: 'Crear de todos modos' }).then((ok) => { if (ok) create(); });
    create();
  },
  manualDelete: (d) => {
    const m = mById(d.id); if (!m || m.status !== 'pend') return toast('Solo se pueden eliminar partidos que no han empezado');
    ask(`${tname(m.home)} vs ${tname(m.away)}`, { title: 'Eliminar partido', ok: 'Eliminar', danger: true }).then((ok) => {
      if (!ok) return;
      T().matches = T().matches.filter((x) => x.id !== m.id);
      save(); closeModal(); render(); toast('Partido eliminado');
    });
  },
  manualClose: () => {
    const t = T(), p = phase1();
    if (!p.length || p.some((m) => m.status !== 'done')) return toast('Primero finalice todos los partidos creados');
    const { count } = manualStats(), vals = Object.values(count);
    const uneven = Math.max(...vals) !== Math.min(...vals);
    ask(`Se cerrará la fase con ${p.length} partidos jugados.${uneven ? '\n\n⚠️ No todos los equipos jugaron la misma cantidad de partidos (' + Math.min(...vals) + ' a ' + Math.max(...vals) + ').' : ''}${needsFinal() ? '\n\nLuego podrá generar la fase final.' : '\n\nEl 1° de la tabla será el campeón.'}`, { title: '🏁 Terminar fase de partidos', ok: 'Terminar fase' }).then((ok) => {
      if (!ok) return;
      t.manualClosed = true; save(); render(); toast('Fase de partidos terminada');
    });
  },
  manualReopen: () => { T().manualClosed = false; save(); render(); toast('Fase reabierta: puede agregar más partidos'); },
  resetAll: async () => {
    const ok = await askWord('Se borrarán TODOS los torneos, categorías, equipos, partidos, resultados y el historial de versiones. Solo quedará su usuario. Esta acción no se puede deshacer.', { title: '⚠️ Reiniciar base de datos', word: 'REINICIAR', ok: 'Continuar' });
    if (!ok) return toast('No se borró nada');
    const pass = await askText('Para confirmar, escriba su contraseña.', { title: '🔑 Contraseña de ' + auth.user, type: 'password', ok: 'Reiniciar todo', danger: true });
    if (!pass) return toast('No se borró nada');
    const fresh = { torneos: { t1: newTorneo('Mi Torneo') } };
    fresh.torneos.t1.createdAt = Date.now();
    try {
      const { status, j } = await authCall({ action: 'resetAll', pass, data: fresh });
      if (status === 401) return sessionExpired();
      if (status !== 200) return toast((j && j.error) || 'No se pudo reiniciar');
      // empezar limpio también en este teléfono
      S.torneos = fresh.torneos; S.tor = 't1'; S.cat = Object.keys(fresh.torneos.t1.cats)[0]; S.tab = 'ajustes';
      sync.dirty = false; sync.rev = -1; sync.base = null;
      saveLocal(); saveSync();
      orgs = null; render(); await pull(true); loadOrgs();
      toast('✅ Base de datos reiniciada' + (j.removedUsers && j.removedUsers.length ? ' · usuarios eliminados: ' + j.removedUsers.join(', ') : ''));
    } catch (e) { toast('Sin conexión'); }
  },
  restoreVersion: async (d) => {
    const v = (historyList || []).find((x) => String(x.i) === String(d.i));
    if (!v || !(await ask(`Versión del ${new Date(v.at).toLocaleString('es')}: ${v.teams} equipos, ${v.done} partidos finalizados.\n\nLos datos actuales se reemplazarán, pero quedarán guardados en el historial.`, { title: '🕘 Restaurar versión', ok: 'Restaurar' }))) return;
    try {
      const ver = await apiCall('GET', null, '?version=' + v.i);
      if (ver.status !== 200 || !ver.j || !ver.j.data) return toast('No se pudo leer esa versión');
      const data = normalizeData(clone(ver.j.data));
      if (!data) return toast('Versión no válida');
      const cur = await apiCall('GET', null, '');
      const put = await apiCall('PUT', { baseRev: cur.j ? cur.j.rev : 0, data: { torneos: data.torneos } });
      if (put.status === 401) return sessionExpired();
      if (put.status !== 200) return toast('No se pudo restaurar, intente de nuevo');
      sync.dirty = false; sync.rev = -1;
      closeModal();
      await pull(true);
      toast('✅ Versión restaurada');
    } catch (e) { toast('Sin conexión'); }
  },
  switchTorneo: (d) => {
    if (!S.torneos[d.id]) return;
    S.tor = d.id; S.cat = Object.keys(CATS_())[0];
    saveLocal(); closeModal(); render(); window.scrollTo(0, 0);
  },
  newTorneo: () => {
    askText('Se creará con las mismas categorías y configuración, pero sin equipos.', { title: '🏆 Nuevo torneo', placeholder: 'Ej: Copa Navidad 2026', ok: 'Crear torneo' }).then((v) => {
      const n = (v || '').trim().slice(0, 40);
      if (!n) return;
      const id = 't' + uid();
      S.torneos[id] = newTorneo(n, CATS_());
      S.torneos[id].config = clone(TC());
      S.tor = id; S.cat = Object.keys(CATS_())[0];
      save(); closeModal(); render();
      toast('🏆 Torneo "' + n + '" creado con las mismas categorías');
    });
  },
  delTorneo: (d) => {
    const tor = S.torneos[d.id];
    if (!tor || Object.keys(S.torneos).length < 2) return;
    askWord('Se eliminará el torneo "' + tor.name + '" con todas sus categorías, equipos y resultados.', { title: '⚠️ Eliminar torneo', ok: 'Eliminar' }).then((ok) => {
      if (!ok) return toast('No se eliminó nada');
      delete S.torneos[d.id];
      fixSelection(S);
      save(); closeModal(); render(); toast('Torneo eliminado');
    });
  },
  renameCat: (d) => {
    const t = CATS_()[d.c]; if (!t) return;
    askText('', { title: '✏️ Nombre de la categoría', value: t.name, ok: 'Guardar' }).then((v) => {
      const n = (v || '').trim().slice(0, 24);
      if (!n || n === t.name) return;
      if (catNameTaken(n, d.c)) return toast('Ya existe una categoría con ese nombre');
      t.name = n; save(); render();
    });
  },
  colorCat: (d) => { const t = CATS_()[d.c]; if (!t) return; t.color = ((t.color || 0) + 1) % PALETTES; save(); render(); },
  delCat: (d) => {
    const t = CATS_()[d.c]; if (!t || Object.keys(CATS_()).length < 2) return;
    const go = () => { delete CATS_()[d.c]; if (S.cat === d.c) S.cat = Object.keys(CATS_())[0]; save(); render(); toast('Categoría eliminada'); };
    if (t.teams.length) return askWord(`La categoría "${t.name}" tiene ${t.teams.length} equipos. Se borrarán sus equipos, pagos, partidos y resultados.`, { title: '⚠️ Eliminar categoría', ok: 'Eliminar' }).then((ok) => (ok ? go() : toast('No se eliminó nada')));
    ask(`Se eliminará la categoría "${t.name}" (no tiene equipos).`, { title: 'Eliminar categoría', ok: 'Eliminar', danger: true }).then((ok) => { if (ok) go(); });
  },
  scrollRow: (d) => {
    const row = document.getElementById(d.row); if (!row) return;
    const card = row.firstElementChild;
    const step = card ? (card.getBoundingClientRect().width + 10) * Math.max(1, Math.floor(row.clientWidth / (card.getBoundingClientRect().width + 10))) : row.clientWidth * 0.8;
    row.scrollBy({ left: Number(d.dir) * step }); // desplazamiento suave definido en CSS
    setTimeout(() => updateArrows(row), 450);
  },
  syncInfo: () => toast(syncText()),
  theme: () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('torneo-theme', next); } catch (e) { /* nada */ }
  },
  share: async () => {
    const url = location.origin + '/';
    const text = TOR().name + ' · resultados, calendario y tabla en vivo';
    try {
      if (navigator.share) await navigator.share({ title: TOR().name, text, url });
      else { await navigator.clipboard.writeText(url); toast('🔗 Enlace copiado: ' + url); }
    } catch (e) { /* cancelado */ }
  },
  syncNow: () => { if (sync.dirty) push(); else pull(true); },
  install: async () => {
    if (!installEvt) return;
    installEvt.prompt();
    await installEvt.userChoice;
    installEvt = null; render();
  },
};

const PUBLIC_ACTIONS = new Set(['cat', 'tab', 'close', 'view', 'viewTeam', 'viewTeamCat', 'openMatch', 'syncInfo', 'syncNow', 'install', 'openTorneos', 'switchTorneo', 'theme', 'share', 'scrollRow', 'openCompare',
  'capOpen', 'capSave', 'capBaja', 'capLogout', 'openRules', 'crestRandom', 'crestNone', 'crestPreset', 'crestSet']);
/** Acciones del árbitro (cada una revisa además que sea SU partido: editMatch). */
const REF_ACTIONS = new Set(['openMyMatch', 'addOnField', 'changePass', 'logout', 'goal', 'goalPick', 'goalCancel', 'goalMode', 'scorer', 'penMissDel', 'present', 'presentAll',
  'start', 'pause', 'addTime', 'endHalf', 'secondHalf', 'wo', 'kick', 'kickUndo', 'card', 'delCard', 'finish']);

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'loginForm') { e.preventDefault(); return doLogin(); }
  if (e.target.id === 'capNewForm') {
    e.preventDefault();
    const body = { action: 'create', invite: modal.inv && modal.inv.invite, name: $('#cn-name').value.trim(), rep: { name: $('#cn-rep').value.trim(), phone: $('#cn-phone').value.trim() }, pass: $('#cn-pass').value };
    try {
      const { status, j } = await inscCall(body);
      if (status !== 200) { if (status === 409 && modal.inv && /invitación/.test(j.error || '')) { modal.inv.used = true; renderModal(); } return toast(j.error || 'No se pudo crear la inscripción'); }
      setCap({ id: j.reg.id, token: j.token, name: j.reg.name }, j.reg);
      modal = { type: 'cap' }; renderModal(); render();
      ask(`Su código de equipo es ${j.reg.id}\n\nAnótelo junto con su clave. Para volver a entrar desde cualquier teléfono: ${location.origin}/capitan\n\nAhora agregue a sus jugadores y envíe la inscripción.`, { title: '✅ Inscripción creada', ok: 'Entendido' });
    } catch (err) { toast('Sin conexión. Intente de nuevo.'); }
    return;
  }
  if (e.target.id === 'capInvForm') { e.preventDefault(); return checkInvite($('#ci-code').value); }
  if (e.target.id === 'capLoginForm') {
    e.preventDefault();
    try {
      const { status, j } = await inscCall({ action: 'login', id: $('#cl-id').value.trim().toUpperCase(), pass: $('#cl-pass').value });
      if (status !== 200) return toast(j.error || 'No se pudo ingresar');
      setCap({ id: j.reg.id, token: j.token, name: j.reg.name }, j.reg);
      modal = { type: 'cap' }; renderModal(); render(); toast(`👋 ${j.reg.name}`);
    } catch (err) { toast('Sin conexión. Intente de nuevo.'); }
    return;
  }
  if (e.target.id === 'catForm') {
    e.preventDefault();
    if (!isAdmin()) return;
    const n = $('#cat-name').value.trim().slice(0, 24);
    if (!n) return toast('Escriba el nombre de la categoría');
    if (catNameTaken(n)) return toast('Ya existe una categoría con ese nombre');
    const used = Object.values(CATS_()).map((t) => t.color);
    let color = Object.keys(CATS_()).length % PALETTES;
    for (let i = 0; i < PALETTES; i++) if (!used.includes(i)) { color = i; break; }
    const id = 'c' + uid();
    CATS_()[id] = newTournament(n, color);
    S.cat = id;
    save(); render(); toast('✅ Categoría ' + n + ' creada');
    return;
  }
  if (e.target.id === 'orgForm') {
    e.preventDefault();
    const user = $('#o-user').value.trim().toLowerCase(), pass = $('#o-pass').value, role = ($('#o-role') || {}).value || 'admin';
    if (!user || !pass) return toast('Escriba usuario y contraseña');
    const { status, j } = await authCall({ action: 'add', user, pass, role });
    if (status === 401) return sessionExpired();
    if (status !== 200) return toast((j && j.error) || 'No se pudo agregar');
    orgs = j; render(); toast('✅ ' + (role === 'arbitro' ? 'Árbitro ' : 'Organizador ') + user + ' agregado');
  }
});

document.addEventListener('click', (e) => {
  if (e.target.id === 'modal') return closeModal();
  const el = e.target.closest('[data-a]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.a];
  if (!fn) return;
  e.preventDefault();
  if (!isAdmin() && !PUBLIC_ACTIONS.has(el.dataset.a) && !(isRef() && REF_ACTIONS.has(el.dataset.a))) return toast(isRef() ? 'Como árbitro solo puede anotar en sus partidos' : 'Ingrese como organizador para editar');
  fn(el.dataset, el);
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'psearch') { S.psearch = e.target.value.slice(0, 60); const r = $('#presults'); if (r) r.innerHTML = playerResultsHTML(S.psearch); return; }
  if (e.target.matches('[data-pl]')) checkPlayers();
  if (e.target.matches('[data-cpl]')) { const row = e.target.closest('.cprow'); if (row) row.dataset.srv = ''; checkCapPlayers(); }
  if (e.target.id === 'f-name' && modal && modal.crest && modal.crest.e === 'inicial') updateCrestUI();
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.id === 't-org' || el.id === 't-contact') {
    if (!isAdmin()) return;
    TOR()[el.id === 't-org' ? 'org' : 'contact'] = el.value.trim().slice(0, 60);
    save(); render(); toast(el.id === 't-org' ? 'Organizador guardado' : 'Contacto guardado');
    return;
  }
  if (el.id === 't-name') {
    if (!isAdmin()) return;
    const n = el.value.trim().slice(0, 40);
    if (n) { TOR().name = n; save(); render(); toast('Nombre del torneo guardado'); }
    return;
  }
  if (el.dataset.insc) {
    if (!isAdmin()) return;
    const k = el.dataset.insc, cur = inscOf();
    if (k === 'open' || k === 'local' || k === 'changesLeg1') cur[k] = el.checked;
    else if (k === 'from' || k === 'until' || k === 'changesUntil') { const ms = el.value ? new Date(el.value).getTime() : 0; cur[k] = isNaN(ms) ? 0 : ms; }
    else cur[k] = Math.max(1, Math.min(30, Math.round(num(el.value, cur[k]))));
    if (cur.min > cur.max) { if (k === 'min') cur.min = cur.max; else cur.max = cur.min; toast('El mínimo no puede ser mayor que el máximo'); }
    else if (cur.until && cur.changesUntil && cur.changesUntil < cur.until) toast('⚠️ El cierre de altas y bajas quedó antes que el de inscripción');
    else toast('Inscripción en línea guardada');
    T().config.insc = cur;
    save(); render();
    return;
  }
  if (el.id === 't-rules') {
    if (!isAdmin()) return;
    TOR().rules = el.value.replace(/\r/g, '').slice(0, 20000);
    save(); toast('Reglamento guardado');
    return;
  }
  if (el.id === 'c-accept') { modal.accept = el.checked; el.closest('.opt').classList.toggle('on', el.checked); return; }
  if (el.id === 'cmp-n' || el.id === 'cmp-f') {
    if (modal && modal.type === 'compare') {
      if (el.id === 'cmp-n') modal.n = Math.max(2, Math.min(40, parseInt(el.value, 10) || 2));
      else modal.fields = Math.max(1, Math.min(3, parseInt(el.value, 10) || 1));
      renderModal();
    }
    return;
  }
  if (el.dataset.mrule) {
    if (!isAdmin()) return;
    const c = T().config;
    c.match = Object.assign({}, matchRules(c), { [el.dataset.mrule]: Math.round(num(el.value)) });
    delete c.match.duration; // la duración está en c.duration
    save(); render(); toast('Reglas del partido actualizadas');
    return;
  }
  if (el.dataset.sanc) {
    if (!isAdmin()) return;
    const c = T().config, k = el.dataset.sanc;
    c.sanc = Object.assign(sancRules(c), { [k]: el.value === 'all' ? 'all' : Math.max(0, Math.round(num(el.value))) });
    save(); render();
    toast('Sanciones actualizadas');
    return;
  }
  if (el.dataset.tcfg) {
    if (!isAdmin()) return;
    const g = TC(), k = el.dataset.tcfg;
    g[k] = Math.max(1, Math.min(30, Math.round(num(el.value, g[k]))));
    delete g.subs; delete g.minPlayers; // campos antiguos: ya no se usan
    save(); render();
    return;
  }
  if (el.dataset.crest) {
    const k = el.dataset.crest;
    modal.crest = Object.assign({}, modal.crest && !modal.crest.img ? modal.crest : Object.assign(randomCrest(), { e: 'balon' }), { [k]: el.value });
    updateCrestUI();
    return;
  }
  if (el.id === 'crestFile' && el.files[0]) {
    crestFromFile(el.files[0]).then((img) => { modal.crest = { img }; updateCrestUI(); }).catch(() => toast('No se pudo leer la imagen'));
    return;
  }
  if (el.dataset.cfg) {
    if (!isAdmin()) return;
    const c = T().config;
    const k = el.dataset.cfg;
    let v = num(el.value);
    if (k === 'format' || k === 'tiebreak' || k === 'koPairing') v = el.value;
    if (k === 'duration') v = Math.max(1, Math.min(200, Math.round(v)));
    if (k === 'fee') v = Math.max(0, v);
    c[k] = v;

    if (k === 'format' && c.format !== 'liga') c.ligaFinal = c.ligaFinal || 0;
    save();
    if (el.type === 'radio' || el.tagName === 'SELECT') render();
    return;
  }
  if (el.id === 'm-ref') {
    const m = editMatch(); if (!m || !isAdmin()) return;
    m.ref = el.value || null;
    save(); renderModal(); toast(m.ref ? '🧑‍⚖️ Árbitro asignado: ' + m.ref : 'Sin árbitro asignado');
    return;
  }
  if (el.id === 'm-dur') {
    const m = editMatch(); if (!m || !isAdmin()) return;
    m.duration = Math.max(1, Math.min(200, Math.round(num(el.value, m.duration))));
    m.alerted = false; save(); updateClock();
    return;
  }
  if (el.id === 'c-team' && modal) { modal.cardTeam = el.value; renderModal(); return; }
  if (['m-date', 'm-time', 'm-field'].includes(el.id)) {
    const m = editMatch(); if (!m || !isAdmin()) return;
    m[{ 'm-date': 'date', 'm-time': 'time', 'm-field': 'field' }[el.id]] = el.value.trim();
    save(); toast('Programación guardada');
    return;
  }
  if (el.name === 's-mode') {
    document.querySelectorAll('input[name="s-mode"]').forEach((r) => r.closest('.opt').classList.toggle('on', r.checked));
    return;
  }
  if (el.id === 'importFile' && el.files[0]) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (!normalizeData(d)) throw new Error('formato');
        fixSelection(d);
        ask('Los datos actuales se reemplazarán por los del archivo.', { title: '⬆️ Importar respaldo', ok: 'Importar', danger: true }).then((ok) => {
          if (!ok) return;
          S = d; save(); render(); toast('✅ Respaldo importado');
        });
      } catch (err) { toast('Archivo no válido'); }
    };
    r.readAsText(el.files[0]);
  }
});

/** Activa o desactiva las flechas ‹ › de las filas deslizables según la posición. */
function updateArrows(row) {
  const btns = document.querySelectorAll('[data-row="' + row.id + '"]');
  btns.forEach((b) => { b.disabled = Number(b.dataset.dir) < 0 ? row.scrollLeft <= 20 : row.scrollLeft + row.clientWidth >= row.scrollWidth - 20; });
}
document.addEventListener('scroll', (e) => { if (e.target && e.target.classList && e.target.classList.contains('hscroll') && e.target.id) updateArrows(e.target); }, true);
window.addEventListener('resize', () => document.querySelectorAll('.hscroll[id]').forEach(updateArrows));

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal) closeModal(); });

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); installEvt = e;
  if (S.tab === 'ajustes') render();
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

if (ADMIN_URL && !auth) S.tab = 'ajustes';
render();
startSync();
// Enlace de invitación para capitanes: /?i=XXXX-XXXX
(() => {
  const code = new URLSearchParams(location.search).get('i');
  if (!code && CAP_URL) { S.tab = 'equipos'; render(); actions.capOpen(); return; } // con sesión guardada abre su inscripción
  if (!code) return;
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* nada */ }
  S.tab = 'equipos'; render();
  modal = { type: 'cap', invCode: code };
  if (capAuth) setCap(null);
  renderModal();
  checkInvite(code);
})();
