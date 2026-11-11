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
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + (Number(n) || 0).toLocaleString('es', { maximumFractionDigits: 2 });
const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const num = (v, d = 0) => { const n = parseFloat(v); return isNaN(n) ? d : n; };

function newTournament(name = '', color = 0) {
  return {
    name, color,
    config: {
      fee: 0, duration: 20,
      format: 'liga',      // liga | grupos | elim
      ligaFinal: 0,        // 0 = gana la tabla, 2 = final, 4 = semifinales
      groupSize: 4, perGroup: 2,
      podium: 3,           // 1, 2 o 3 lugares
    },
    teams: [],
    stage: 'inscripcion',  // inscripcion | fase1 | final
    groups: [],
    matches: [],
  };
}

/** Configuración general del torneo (aplica a todos los equipos). */
const defaultTorConfig = () => ({ starters: 8, subs: 4, minPlayers: 8 });
function newTorneo(name, catsFrom) {
  const cats = {};
  if (catsFrom) Object.entries(catsFrom).forEach(([k, t]) => { cats[k] = newTournament(t.name, t.color); cats[k].config = Object.assign(clone(t.config), {}); });
  else { cats.M = newTournament('Masculino', 0); cats.F = newTournament('Femenino', 1); }
  return { name, createdAt: Date.now(), config: defaultTorConfig(), cats };
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
    Object.keys(tor.cats).forEach((k, i) => {
      const t = tor.cats[k];
      if (!t || !Array.isArray(t.teams) || !Array.isArray(t.matches)) { delete tor.cats[k]; return; }
      if (!t.name) t.name = defaults[k] ? defaults[k][0] : 'Categoría ' + (i + 1);
      if (t.color == null) t.color = defaults[k] ? defaults[k][1] : i % PALETTES;
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
  const d = { torneos: { t1: newTorneo('Mi Torneo') }, tab: 'partidos', view: 'cal' };
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
const isAdmin = () => sync.mode === 'local' || !!(auth && auth.token);
// El acceso de organizadores solo se muestra entrando por /admin (o ?admin)
const ADMIN_URL = /\/admin\/?$/.test(location.pathname) || /(^|[?&#])admin(\b|$)/.test(location.search + location.hash);
const showAccess = () => isAdmin() || ADMIN_URL;
function setAuth(a) {
  auth = a;
  try { if (a) localStorage.setItem(AUTH_KEY, JSON.stringify(a)); else localStorage.removeItem(AUTH_KEY); } catch (e) { /* nada */ }
}

function saveLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('⚠️ No se pudo guardar'); }
}
function save() {
  saveLocal();
  if (sync.mode !== 'local' && isAdmin()) {
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
  return map;
}

/* ---------------- Partidos ---------------- */
function mkMatch(o) {
  return Object.assign({
    id: uid(), phase: '', group: '', round: 1, ko: '', label: '',
    home: null, away: null, srcH: null, srcA: null,
    hs: 0, as: 0, ph: null, pa: null,
    status: 'pend', duration: T().config.duration, elapsed: 0, runAt: null, alerted: false,
    cards: [],
  }, o);
}

function winner(m) {
  if (!m || m.status !== 'done') return null;
  if (m.hs > m.as) return m.home;
  if (m.as > m.hs) return m.away;
  if (m.ph != null && m.pa != null) {
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
function buildKO(seeds) {
  const t = T();
  const n = seeds.length;
  if (n < 2) return;
  let P = 1; while (P < n) P *= 2;
  let prev = bracketOrder(P).map((s) => (s <= n ? { t: seeds[s - 1] } : null));
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
        const m = mkMatch({
          phase: 'ko', round, ko: prev.length === 2 ? 'final' : (prev.length === 4 ? 'semi' : 'ko'),
          label: pairs > 1 ? `${name} ${k}` : name, srcH: a, srcA: b,
        });
        created.push(m);
        next.push({ w: m.id });
      } else {
        next.push(a || b); // pasa directo (bye)
      }
    }
    t.matches.push(...created);
    if (prev.length === 4 && t.config.podium >= 3 && next[0] && next[0].w && next[1] && next[1].w) {
      t.matches.push(mkMatch({ phase: 'ko', round: round + 1, ko: 'third', label: 'Tercer lugar', srcH: { l: next[0].w }, srcA: { l: next[1].w } }));
    }
    prev = next;
    round++;
  }
  syncKO();
}

function srcTeam(src, t = T()) {
  if (!src) return null;
  if (src.t) return src.t;
  const m = mById(src.w || src.l, t);
  return src.w ? winner(m) : loser(m);
}
function srcLabel(src) {
  if (!src) return 'Por definir';
  if (src.t) return tname(src.t);
  const m = mById(src.w || src.l);
  return (src.w ? 'Ganador ' : 'Perdedor ') + (m ? m.label : '');
}
function resetMatch(m) {
  Object.assign(m, { hs: 0, as: 0, ph: null, pa: null, status: 'pend', elapsed: 0, runAt: null, alerted: false, cards: [] });
}
/** Actualiza los equipos de la llave según los resultados. */
function syncKO(t = T()) {
  for (const m of t.matches) {
    if (m.phase !== 'ko') continue;
    const h = srcTeam(m.srcH, t), a = srcTeam(m.srcA, t);
    if (m.home !== h || m.away !== a) {
      if (m.status !== 'pend') resetMatch(m);
      m.home = h; m.away = a;
    }
  }
}

/* ---------------- Tabla de posiciones ---------------- */
function standings(ids, phase, group) {
  const rows = new Map(ids.map((id) => [id, { id, pj: 0, pg: 0, pe: 0, pp: 0, gf: 0, gc: 0, pts: 0, ta: 0, tr: 0 }]));
  for (const m of T().matches) {
    if (m.phase !== phase || m.group !== group) continue;
    for (const c of m.cards) {
      const r = rows.get(c.team);
      if (r) { if (c.type === 'Y') r.ta++; else r.tr++; }
    }
    if (m.status !== 'done') continue;
    const h = rows.get(m.home), a = rows.get(m.away);
    if (!h || !a) continue;
    h.pj++; a.pj++;
    h.gf += m.hs; h.gc += m.as; a.gf += m.as; a.gc += m.hs;
    if (m.hs > m.as) { h.pg++; a.pp++; h.pts += 3; }
    else if (m.hs < m.as) { a.pg++; h.pp++; a.pts += 3; }
    else { h.pe++; a.pe++; h.pts++; a.pts++; }
  }
  return [...rows.values()].sort((x, y) =>
    y.pts - x.pts || (y.gf - y.gc) - (x.gf - x.gc) || y.gf - x.gf ||
    (x.ta + 3 * x.tr) - (y.ta + 3 * y.tr) || tname(x.id).localeCompare(tname(y.id)));
}

const phase1 = () => T().matches.filter((m) => m.phase !== 'ko');
const phase1Done = () => { const p = phase1(); return p.length > 0 && p.every((m) => m.status === 'done'); };
const needsFinal = () => { const c = T().config; return c.format === 'grupos' || (c.format === 'liga' && c.ligaFinal > 0); };

function podium() {
  const t = T(), c = t.config;
  const ko = t.matches.filter((m) => m.phase === 'ko');
  if (ko.length) {
    const fin = ko.find((m) => m.ko === 'final');
    if (!fin || fin.status !== 'done') return null;
    const p = [winner(fin), loser(fin)];
    if (c.podium >= 3) {
      const th = ko.find((m) => m.ko === 'third');
      if (th) p.push(winner(th));
      else if (c.format === 'liga' && t.groups[0]) {
        const tab = standings(t.groups[0].teams, 'liga', '');
        const third = tab.find((r) => !p.includes(r.id));
        p.push(third ? third.id : null);
      }
    }
    return p.slice(0, c.podium);
  }
  if (c.format === 'liga' && !needsFinal() && phase1Done()) {
    return standings(t.groups[0].teams, 'liga', '').slice(0, c.podium).map((r) => r.id);
  }
  return null;
}

/* ---------------- Sorteo ---------------- */
function doDraw() {
  const t = T(), c = t.config;
  const n = t.teams.length;
  if (n < 2) return toast('Se necesitan al menos 2 equipos');
  const short = t.teams.filter((x) => x.players.length < TC().minPlayers);
  if (short.length) return toast(`Faltan integrantes en: ${short.map((x) => x.name).join(', ')}`);
  if (c.format === 'grupos' && n < 4) return toast('Para grupos se necesitan al menos 4 equipos');
  if (c.format === 'liga' && c.ligaFinal > n) return toast(`No hay ${c.ligaFinal} equipos para la fase final`);
  if (!confirm(`¿Realizar el sorteo de ${n} equipos (${catName(S.cat)})?`)) return;

  const ids = shuffle(t.teams.map((x) => x.id));
  t.matches = []; t.groups = [];
  if (c.format === 'elim') {
    t.stage = 'final';
    buildKO(ids);
  } else if (c.format === 'liga') {
    t.groups = [{ name: '', teams: ids }];
    t.matches = roundRobin(ids, 'liga', '');
    t.stage = 'fase1';
  } else {
    const ng = Math.max(2, Math.floor(n / c.groupSize));
    const letters = 'ABCDEFGHIJ';
    t.groups = Array.from({ length: ng }, (_, i) => ({ name: letters[i], teams: [] }));
    ids.forEach((id, i) => t.groups[i % ng].teams.push(id));
    // intercalar partidos de los grupos por fecha
    const all = t.groups.flatMap((g) => roundRobin(g.teams, 'grupo', g.name));
    t.matches = all.sort((a, b) => a.round - b.round);
    t.stage = 'fase1';
  }
  save(); render();
  toast('🎲 Sorteo realizado');
}

function genFinal() {
  const t = T(), c = t.config;
  if (!phase1Done()) return toast('Terminen todos los partidos primero');
  let seeds = [];
  if (c.format === 'liga') {
    seeds = standings(t.groups[0].teams, 'liga', '').slice(0, c.ligaFinal).map((r) => r.id);
  } else {
    const tabs = t.groups.map((g) => standings(g.teams, 'grupo', g.name));
    for (let pos = 0; pos < c.perGroup; pos++) for (const tab of tabs) if (tab[pos]) seeds.push(tab[pos].id);
  }
  if (seeds.length < 2) return toast('No hay suficientes clasificados');
  t.matches = t.matches.filter((m) => m.phase !== 'ko');
  buildKO(seeds);
  t.stage = 'final';
  save(); render();
  toast('🏁 Fase final generada');
}

/* ---------------- Vistas ---------------- */
const views = { equipos: viewEquipos, partidos: viewPartidos, tabla: viewTabla, ajustes: viewAjustes };

function render() {
  sync.pendingRender = false;
  const adm = isAdmin();
  fixSelection(S);
  const brand = $('#brand-name');
  if (brand) brand.textContent = TOR().name;
  document.body.dataset.pal = String((T().color || 0) % PALETTES);
  document.body.classList.toggle('public', !adm);
  const cats = $('#cats');
  cats.innerHTML = Object.keys(CATS_()).map((k) => `<button data-a="cat" data-c="${k}" class="${k === S.cat ? 'on' : ''}">${esc(catName(k))}</button>`).join('');
  const onBtn = cats.querySelector('.on');
  if (onBtn) cats.scrollLeft = onBtn.offsetLeft - cats.clientWidth / 2 + onBtn.clientWidth / 2;
  const t4 = document.querySelector('#tabs [data-t="ajustes"]');
  if (!showAccess() && S.tab === 'ajustes') S.tab = 'partidos';
  if (t4) {
    t4.hidden = !showAccess();
    t4.innerHTML = adm ? '<span>⚙️</span>Ajustes' : '<span>🔑</span>Ingresar';
  }
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === S.tab));
  $('#view').innerHTML = (views[S.tab] || viewEquipos)();
  renderModal();
  setMode(sync.mode, false);
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
const phaseLabel = (m) => (m.phase === 'ko' ? m.label : `${m.group ? 'Grupo ' + m.group + ' · ' : ''}Jornada ${m.round}`);

function teamRecord(id) {
  const r = { pj: 0, g: 0, e: 0, p: 0, gf: 0, gc: 0 };
  for (const m of T().matches) {
    if (m.status !== 'done' || (m.home !== id && m.away !== id)) continue;
    const home = m.home === id;
    r.pj++; r.gf += home ? m.hs : m.as; r.gc += home ? m.as : m.hs;
    const w = winner(m);
    if (!w) r.e++; else if (w === id) r.g++; else r.p++;
  }
  return r;
}
const recordHTML = (r) => `<span class="rec"><b class="g">${r.g}G</b><b class="e">${r.e}E</b><b class="p">${r.p}P</b></span>`;

function viewEquipos() {
  const t = T(), c = t.config;
  if (!isAdmin()) {
    let h = `<h1>Equipos ${catName(S.cat)}</h1>`;
    if (!t.teams.length) return h + `<div class="empty">Aún no hay equipos inscritos.</div>`;
    h += `<p class="muted">${t.teams.length} equipos · G = ganados, E = empatados, P = perdidos</p>`;
    for (const tm of t.teams) {
      h += `<button class="list-item" data-a="viewTeam" data-id="${tm.id}">
        ${teamBadge(tm, 40)}
        <div class="grow"><div class="t">${esc(tm.name)}</div><small>${tm.players.length} integrantes</small></div>
        ${recordHTML(teamRecord(tm.id))}</button>`;
    }
    return h;
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
  if (!t.teams.length) {
    h += `<div class="empty">Aún no hay equipos inscritos.<br><small>Cuota de inscripción: ${money(c.fee)} · ${TC().starters} titulares + ${TC().subs} suplentes · mínimo ${TC().minPlayers}</small></div>`;
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

function drawSetupHTML() {
  const t = T(), c = t.config, n = t.teams.length;
  let h = `<h1>Sorteo ${catName(S.cat)}</h1>
    <p class="muted">${n} equipo(s) inscritos. Configure el formato y realice el sorteo.</p>
    <h3>Formato</h3>
    ${optRadio('format', 'liga', c.format, 'Todos contra todos', 'Todos se enfrentan una vez. Tabla por puntos.')}
    ${optRadio('format', 'grupos', c.format, 'Cuadrangulares (grupos)', 'Se sortean grupos; los mejores pasan a eliminación.')}
    ${optRadio('format', 'elim', c.format, 'Eliminación directa', 'Llave de eliminación desde el inicio.')}`;
  if (c.format === 'liga') {
    h += `<h3>Fase final</h3>
      ${optRadio('ligaFinal', 0, c.ligaFinal, 'Sin fase final', 'Gana el primero de la tabla')}
      ${optRadio('ligaFinal', 2, c.ligaFinal, 'Final', '1° vs 2° de la tabla')}
      ${optRadio('ligaFinal', 4, c.ligaFinal, 'Semifinales', '1° vs 4° y 2° vs 3°, luego final')}`;
  }
  if (c.format === 'grupos') {
    h += `<div class="grid2">
        <label class="fl">Equipos por grupo<select data-cfg="groupSize">
          ${[3, 4, 5, 6].map((v) => `<option value="${v}" ${c.groupSize == v ? 'selected' : ''}>${v}${v === 4 ? ' (cuadrangular)' : ''}</option>`).join('')}
        </select></label>
        <label class="fl">Clasifican por grupo<select data-cfg="perGroup">
          ${[1, 2, 3, 4].map((v) => `<option value="${v}" ${c.perGroup == v ? 'selected' : ''}>${v}</option>`).join('')}
        </select></label></div>`;
    if (n >= 4) h += `<p class="muted"><small>Con ${n} equipos se formarán ${Math.max(2, Math.floor(n / c.groupSize))} grupos.</small></p>`;
  }
  h += `<h3>Premiación</h3>
      ${optRadio('podium', 1, c.podium, 'Solo campeón (1 lugar)', '')}
      ${optRadio('podium', 2, c.podium, 'Campeón y subcampeón (2 lugares)', '')}
      ${optRadio('podium', 3, c.podium, '3 lugares', 'Incluye partido por el tercer lugar si hay semifinales')}
      <label class="fl">Duración de partido por defecto (minutos)<input type="number" inputmode="numeric" min="1" data-cfg="duration" value="${c.duration}"></label>
      <div style="height:12px"></div>
      <button class="btn block" data-a="draw" ${n < 2 ? 'disabled' : ''}>🎲 Realizar sorteo</button>`;
  return h;
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
    h += `<h3>${c.format === 'liga' ? 'Fase regular' : 'Fase de grupos'} · ${p1.filter((m) => m.status === 'done').length}/${p1.length}</h3>`;
    for (const r of [...new Set(p1.map((m) => m.round))]) {
      h += `<div class="day">Jornada ${r}</div>`;
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
  if (t.stage === 'inscripcion') {
    if (adm) return drawSetupHTML();
    return `<h1>Partidos ${catName(S.cat)}</h1><div class="empty">El sorteo aún no se ha realizado.<br><small>${t.teams.length} equipo(s) inscritos</small></div>`;
  }
  const fmt = { liga: 'Todos contra todos', grupos: 'Cuadrangulares', elim: 'Eliminación directa' }[c.format];
  const mode = S.view === 'fase' ? 'fase' : 'cal';
  const all = t.matches;
  const done = all.filter((m) => m.status === 'done').length;
  let h = `<h1>Partidos ${catName(S.cat)}</h1>
    <p class="muted">${fmt} · ${done}/${all.length} jugados${adm ? ' · toque un partido para jugarlo' : ''}</p>
    <div class="seg2">
      <button data-a="view" data-v="cal" class="${mode === 'cal' ? 'on' : ''}">📅 Calendario</button>
      <button data-a="view" data-v="fase" class="${mode === 'fase' ? 'on' : ''}">🗂️ Por fase</button>
    </div>`;
  if (adm) h += `<button class="btn ghost block sm" data-a="openSchedule" style="margin-bottom:10px">🗓️ Programar fechas y horarios</button>`;

  const live = all.filter((m) => m.status === 'live');
  if (live.length) { h += `<h3>🔴 En juego ahora</h3>`; for (const m of live) h += matchCard(m); }

  h += mode === 'cal' ? calendarHTML(all) : phasesHTML();

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

function matchCard(m) {
  const done = m.status === 'done';
  const w = winner(m);
  const side = (id, src, cls) => id
    ? `<div class="${cls} ${done && w === id ? 'win' : ''}">${cls === 'a' ? miniCrest(id) : ''}<span>${esc(tname(id))}</span>${cls === 'h' ? miniCrest(id) : ''}</div>`
    : `<div class="${cls} tbd">${esc(srcLabel(src))}</div>`;
  const status = done ? (w ? '<span class="badge b-ok">Final</span>' : '<span class="badge b-ok">Empate</span>')
    : m.status === 'live' ? '<span class="badge b-live">En juego</span>'
      : '<span class="badge b-pend">Pendiente</span>';
  const pens = done && m.ph != null && m.hs === m.as ? `<small>pen ${m.ph}-${m.pa}</small>` : '';
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
    <div class="meta"><span>${when ? `<b>${when}</b> · ` : ''}${esc(phaseLabel(m))}</span><span>${cards} ${status}</span></div>
  </button>`;
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
  let h = `<h1>Tabla ${catName(S.cat)}</h1>`;
  const pod = podium();
  if (pod) h += podiumHTML(pod);

  if (c.format === 'liga') {
    h += `<h3>Posiciones</h3>` + tableHTML(standings(t.groups[0].teams, 'liga', ''), c.ligaFinal || c.podium);
  } else if (c.format === 'grupos') {
    for (const g of t.groups) h += `<h3>Grupo ${g.name}</h3>` + tableHTML(standings(g.teams, 'grupo', g.name), c.perGroup);
  }
  const ko = t.matches.filter((m) => m.phase === 'ko');
  if (ko.length) {
    h += `<h3>Llave final</h3>`;
    for (const m of ko) h += matchCard(m);
  }

  // Tarjetas por jugador
  const map = new Map();
  for (const m of t.matches) for (const cd of m.cards) {
    const k = cd.team + '|' + cd.player;
    const r = map.get(k) || { team: cd.team, player: cd.player, Y: 0, R: 0 };
    r[cd.type]++; map.set(k, r);
  }
  const rows = [...map.values()].sort((a, b) => b.R - a.R || b.Y - a.Y);
  h += `<h3>Tarjetas</h3>`;
  h += rows.length ? `<div class="tbl-wrap"><table><tr><th class="tn">Jugador</th><th class="tn">Equipo</th><th>🟨</th><th>🟥</th></tr>
    ${rows.map((r) => `<tr><td class="tn">${esc(r.player)}</td><td class="tn">${esc(tname(r.team))}</td><td>${r.Y}</td><td>${r.R}</td></tr>`).join('')}</table></div>`
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
    <div class="fl">Tamaño de los equipos <small>(para todas las categorías)</small></div>
    <div class="grid3b">
      <label class="fl">Titulares<input type="number" inputmode="numeric" min="1" max="30" data-tcfg="starters" value="${g.starters}"></label>
      <label class="fl">Suplentes<input type="number" inputmode="numeric" min="0" max="30" data-tcfg="subs" value="${g.subs}"></label>
      <label class="fl">Mínimo<input type="number" inputmode="numeric" min="1" max="60" data-tcfg="minPlayers" value="${g.minPlayers}"></label>
    </div>
    <p class="muted" style="font-size:14px;margin:8px 0 0">Total por equipo: <b>${g.starters + g.subs}</b> integrantes (${g.starters} titulares + ${g.subs} suplentes). Un equipo necesita al menos <b>${g.minPlayers}</b> para inscribirse.</p>
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
    <form id="catForm" class="row" style="margin-top:10px;flex-wrap:nowrap" autocomplete="off">
      <input id="cat-name" maxlength="24" placeholder="Nueva categoría, ej: Veteranos">
      <button class="btn sm" type="submit" style="flex:none">＋ Agregar</button>
    </form>
  </div>`;
}
const catNameTaken = (n, except) => Object.entries(CATS_()).some(([k, t]) => k !== except && norm(t.name) === norm(n));

function viewAjustes() {
  if (!isAdmin()) return loginHTML();
  const c = T().config;
  const online = sync.mode !== 'local';
  return `<h1>Ajustes ${catName(S.cat)}</h1>
  ${online ? `<div class="card">
    <h2>Sesión</h2>
    <p style="margin:6px 0 10px">👤 <b>${esc(auth.user)}</b> <small>· organizador</small></p>
    <div class="row">
      <button class="btn ghost sm" data-a="changePass">Cambiar contraseña</button>
      <button class="btn danger sm" data-a="logout">Cerrar sesión</button>
    </div>
  </div>
  <div class="card">
    <h2>Organizadores</h2>
    <p class="muted" style="font-size:14px">Pueden inscribir, sortear y anotar resultados. El público solo ve.</p>
    <div id="orgList">${orgs ? orgs.users.map((u) => `<div class="org"><span>👤 ${esc(u)}${u === orgs.me ? ' <small>(usted)</small>' : ''}</span>
      ${u === orgs.me ? '' : `<button class="btn danger sm" data-a="delOrg" data-u="${esc(u)}">Quitar</button>`}</div>`).join('') : '<p class="muted">Cargando…</p>'}</div>
    <form id="orgForm" class="grid2" style="margin-top:8px" autocomplete="off">
      <input id="o-user" placeholder="Nuevo usuario" autocapitalize="none" spellcheck="false" autocomplete="off">
      <input id="o-pass" type="password" placeholder="Contraseña" autocomplete="new-password">
      <button class="btn sm" type="submit" style="grid-column:1/3">＋ Agregar organizador</button>
    </form>
  </div>` : ''}
  ${torneoCard()}
  ${categoriesCard()}
  <div class="card">
    <h2>Inscripción · ${esc(catName(S.cat))}</h2>
    <div class="grid2">
      <label class="fl">Cuota de inscripción<input type="number" inputmode="decimal" min="0" data-cfg="fee" value="${c.fee}"></label>
      <label class="fl">Minutos por partido<input type="number" inputmode="numeric" min="1" data-cfg="duration" value="${c.duration}"></label>
    </div>
    <small>Estos ajustes son solo para la categoría ${catName(S.cat)}.</small>
  </div>
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
  if (!isAdmin() && (modal.type === 'team' || modal.type === 'schedule')) { modal = null; return renderModal(); }
  const sheet = $('#sheet');
  const scroll = sheet.scrollTop;
  if (modal.type === 'team') sheet.innerHTML = teamFormHTML(modal.id);
  else if (modal.type === 'schedule') sheet.innerHTML = scheduleHTML();
  else if (modal.type === 'torneos') sheet.innerHTML = torneosHTML();
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

function torneosHTML() {
  const ids = Object.keys(S.torneos).sort((a, b) => (S.torneos[b].createdAt || 0) - (S.torneos[a].createdAt || 0));
  const adm = isAdmin();
  return `<div class="mh"><h2>Torneos</h2><button class="x" data-a="close">✕</button></div>
  <div class="mb" style="padding-top:12px">
    ${ids.map((id) => { const tor = S.torneos[id]; const nTeams = Object.values(tor.cats).reduce((a, t) => a + t.teams.length, 0);
      return `<div class="org">
        <button class="list-item" style="margin:0;flex:1" data-a="switchTorneo" data-id="${id}">
          <div class="grow"><div class="t">${id === S.tor ? '✅ ' : ''}${esc(tor.name)}</div>
          <small>${Object.keys(tor.cats).length} categorías · ${nTeams} equipos</small></div></button>
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
    <p class="muted" style="margin:0 0 6px">Goles a favor ${r.gf} · en contra ${r.gc}</p>
    <h3>Partidos</h3>
    ${ms.length ? ms.map(matchCard).join('') : '<p class="muted">Aún no tiene partidos asignados.</p>'}
    ${[['Titulares', tm.players.filter((p) => !p.sub)], ['Suplentes', tm.players.filter((p) => p.sub)]].filter(([, l]) => l.length).map(([title, list]) => `
    <h3>${title} (${list.length})</h3>
    <ul class="cardlist">${list.map((p) => `<li><span class="grow">${p.num ? `<b>${esc(p.num)}</b> · ` : ''}${esc(p.name)}</span></li>`).join('')}</ul>`).join('')}
  </div>`;
}

/* ---- Programar calendario ---- */
function scheduleHTML() {
  const c = T().config;
  const s = Object.assign({ mode: 'dia', date: isoDate(new Date()), time: '08:00', fields: 1, gap: c.duration + 5, scope: 'sin' }, c.sched || {});
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
    <small>“Minutos entre partidos” = duración del partido + descanso (por defecto ${c.duration} + 5).</small>
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
    gap: Math.max(5, parseInt($('#s-gap').value, 10) || t.config.duration + 5),
    scope: $('#s-scope').value,
  };
  if (!s.date) return toast('Elija la fecha de inicio');
  const target = t.matches.filter((m) => m.status === 'pend' && (s.scope === 'pend' || !m.date));
  if (!target.length) return toast('No hay partidos pendientes para programar');

  // Agrupar en jornadas, en orden: fase 1 por jornada, luego cada ronda de la fase final
  const jKey = (m) => (m.phase === 'ko' ? 1000 + m.round : m.round);
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
  const t = T(), c = t.config, g = TC();
  const tm = id ? teamById(id) : null;
  const players = tm ? tm.players : [];
  const tit = players.filter((p) => !p.sub), sup = players.filter((p) => p.sub);
  const nTit = Math.max(g.starters, tit.length), nSup = Math.max(g.subs, sup.length);
  if (modal.crest === undefined) modal.crest = tm ? (tm.crest || null) : randomCrest();
  let n = 0;
  const row = (p, sub, req) => {
    n++;
    return `<div class="prow" data-sub="${sub ? 1 : 0}"><span class="pn">${n}</span>
      <input class="pl-name" data-pl autocomplete="off" placeholder="Nombre y apellido${req ? ' *' : ''}" value="${esc(p.name || '')}">
      <input class="pl-num" type="number" inputmode="numeric" placeholder="N°" value="${esc(p.num ?? '')}">
      <div class="perr"></div></div>`;
  };
  let h = `<div class="mh"><h2>${tm ? 'Editar equipo' : 'Inscribir equipo'}</h2><button class="x" data-a="close">✕</button></div>
  <div class="mb">
    <label class="fl">Nombre del equipo<input id="f-name" maxlength="40" placeholder="Ej: Los Tigres" value="${esc(tm ? tm.name : '')}"></label>
    ${crestEditorHTML(tm ? tm.name : '')}
    <div class="fl">Integrantes <small id="f-count"></small></div>
    <div id="f-players">
      <div class="psec">Titulares <small>(${g.starters})</small></div>`;
  for (let i = 0; i < nTit; i++) h += row(tit[i] || {}, false, i < g.minPlayers);
  if (nSup > 0) h += `<div class="psec">Suplentes <small>(${g.subs})</small></div>`;
  for (let i = 0; i < nSup; i++) h += row(sup[i] || {}, true, nTit + i < g.minPlayers);
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
  const sel = (key, opts) => `<select data-crest="${key}" class="inp">${opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>`;
  return `<div class="fl">Escudo</div>
  <div class="crest-edit">
    <div id="crest-preview" class="crest-prev">${crestPreview(cr, name)}</div>
    <div class="crest-ctrl">
      <div class="row">
        <button type="button" class="btn ghost sm" data-a="crestRandom">🎲 Al azar</button>
        <label class="btn ghost sm">📷 Subir<input type="file" accept="image/*" id="crestFile" hidden></label>
        <button type="button" class="btn ghost sm" data-a="crestNone" aria-label="Quitar escudo">✕</button>
      </div>
      <div class="crest-sel">
        ${sel('s', Object.entries(CREST_SHAPES).map(([k, v]) => [k, 'Forma: ' + v[0]]))}
        ${sel('p', Object.entries(CREST_PATTERNS).map(([k, v]) => [k, 'Diseño: ' + v]))}
        ${sel('c1', CREST_COLORS.map(([c, l]) => [c, 'Color 1: ' + l]))}
        ${sel('c2', CREST_COLORS.map(([c, l]) => [c, 'Color 2: ' + l]))}
        ${sel('e', Object.entries(CREST_EMBLEMS).map(([k, v]) => [k, 'Emblema: ' + v]))}
      </div>
    </div>
  </div>
  <div class="crest-gallery">${CREST_PRESETS.map((p, i) => `<button type="button" data-a="crestPreset" data-i="${i}" aria-label="Escudo ${i + 1}">${crestHTML(p, name || 'FC', 46)}</button>`).join('')}</div>`;
}
const crestPreview = (cr, name) => (cr ? crestHTML(cr, name || '?', 96) : '<div class="crest-none">Sin escudo</div>');
function updateCrestUI() {
  if (!modal || modal.type !== 'team') return;
  const name = ($('#f-name') || {}).value || '';
  const prev = $('#crest-preview');
  if (prev) prev.innerHTML = crestPreview(modal.crest, name);
  const cr = modal.crest;
  document.querySelectorAll('[data-crest]').forEach((s) => {
    if (cr && !cr.img && cr[s.dataset.crest]) s.value = cr[s.dataset.crest];
    s.disabled = !!(cr && cr.img);
  });
}

function checkPlayers() {
  if (!modal || modal.type !== 'team') return 0;
  const idx = playerIndex(modal.id);
  const seen = new Map();
  let errors = 0, filled = 0;
  document.querySelectorAll('#f-players .prow').forEach((row) => {
    const inp = row.querySelector('.pl-name');
    const n = norm(inp.value);
    let msg = '';
    if (n) {
      filled++;
      if (idx.has(n)) msg = `Ya está inscrito en ${idx.get(n)}`;
      else if (seen.has(n)) msg = `Repetido con el integrante ${seen.get(n)}`;
      else seen.set(n, row.querySelector('.pn').textContent);
    }
    row.classList.toggle('bad', !!msg);
    row.querySelector('.perr').textContent = msg;
    if (msg) errors++;
  });
  const g = TC();
  const cnt = $('#f-count');
  if (cnt) cnt.textContent = `(${filled} de ${g.starters + g.subs} · mínimo ${g.minPlayers} para participar)`;
  updateCrestUI();
  return errors;
}

function saveTeam() {
  const t = T(), g = TC();
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
    if (pn) players.push({ name: pn, num: nb, sub: row.dataset.sub === '1' });
  });
  const nTit = players.filter((p) => !p.sub).length, nSup = players.length - nTit;
  if (players.length < g.minPlayers) return toast(`Para participar se requieren al menos ${g.minPlayers} integrantes (hay ${players.length})`);
  if (nTit > g.starters) return toast(`Máximo ${g.starters} titulares`);
  if (nSup > g.subs) return toast(`Máximo ${g.subs} suplentes`);
  const paid = num($('#f-paid').value);
  const crest = modal.crest || null;
  if (id) {
    Object.assign(teamById(id), { name, players, paid, crest });
  } else {
    if (t.stage !== 'inscripcion') return toast('El sorteo ya se realizó');
    t.teams.push({ id: uid(), name, players, paid, crest, createdAt: Date.now() });
  }
  save(); closeModal(); render();
  toast(id ? 'Equipo actualizado' : `✅ ${name} inscrito`);
}

/* ---- partido ---- */
const elapsedMs = (m) => m.elapsed + (m.runAt ? Date.now() - m.runAt : 0);
const fmtClock = (ms) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

function updateClock() {
  if (!modal || modal.type !== 'match') return;
  const m = mById(modal.id);
  const el = $('#clock');
  if (!m || !el) return;
  const ms = elapsedMs(m);
  el.textContent = fmtClock(ms);
  const over = ms >= m.duration * 60000;
  el.classList.toggle('over', over);
  if (over && m.runAt && !m.alerted && isAdmin()) {
    m.alerted = true; save();
    if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 600]);
    toast(`⏰ Se cumplieron los ${m.duration} minutos`);
  }
}

function matchHTML(m) {
  const adm = isAdmin();
  const done = m.status === 'done';
  const ready = !!(m.home && m.away);
  const edit = adm && !done && ready;      // puede anotar
  const isKO = m.phase === 'ko';
  const side = (id, src, s, val) => `<div>
    ${id && teamById(id) && teamById(id).crest ? `<div class="mcrest-big">${crestHTML(teamById(id).crest, tname(id), 56)}</div>` : ''}
    <div class="tn">${esc(id ? tname(id) : srcLabel(src))}</div>
    <span class="big">${m.status === 'pend' && !adm ? '–' : val}</span>
    ${edit ? `<div class="stepper"><button class="minus" data-a="goal" data-s="${s}" data-d="-1">−</button><button data-a="goal" data-s="${s}" data-d="1">+</button></div>` : ''}
  </div>`;

  let h = `<div class="mh"><h2>${esc(phaseLabel(m))}</h2><button class="x" data-a="close">✕</button></div><div class="mb">`;
  if (!ready) h += `<div class="note warn" style="margin-top:12px">Este partido se define cuando terminen los partidos anteriores.</div>`;
  h += `<div class="score">${side(m.home, m.srcH, 'h', m.hs)}<div class="vs">-</div>${side(m.away, m.srcA, 'a', m.as)}</div>`;
  if (done) {
    const w = winner(m);
    h += `<p style="text-align:center;margin:0 0 6px;font-weight:700">${w ? `🏆 Ganó ${esc(tname(w))}${m.ph != null && m.hs === m.as ? ` (penales ${m.ph}-${m.pa})` : ''}` : '🤝 Empate'}</p>`;
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

  if (!done && (adm || m.status === 'live')) {
    const running = !!m.runAt;
    h += `<div class="timer">
      <div><div class="clock" id="clock">00:00</div><small>${running ? 'En juego' : m.elapsed ? 'Pausado' : 'Sin iniciar'}</small></div>
      ${adm ? `<div class="dur">Tiempo<input type="number" inputmode="numeric" min="1" id="m-dur" value="${m.duration}">min</div>
      <div class="row" style="width:100%">
        ${running ? `<button class="btn ghost sm" data-a="pause">⏸ Pausar</button>`
        : `<button class="btn sm" data-a="start" ${ready ? '' : 'disabled'}>▶ ${m.elapsed ? 'Reanudar' : 'Iniciar'}</button>`}
        ${m.elapsed || running ? `<button class="btn ghost sm" data-a="resetClock">↺ Reiniciar reloj</button>` : ''}
      </div>` : `<div class="dur">de ${m.duration} min</div>`}</div>`;
  } else if (done) {
    h += `<p class="muted" style="text-align:center;margin:0">Partido finalizado · ${m.duration} min</p>`;
  }

  if (isKO && ready && m.hs === m.as && (edit || m.ph != null)) {
    h += `<h3>Penales (empate)</h3><div class="pens">
      <input type="number" inputmode="numeric" min="0" id="m-ph" value="${m.ph ?? ''}" ${edit ? '' : 'disabled'} placeholder="0">
      <span>-</span>
      <input type="number" inputmode="numeric" min="0" id="m-pa" value="${m.pa ?? ''}" ${edit ? '' : 'disabled'} placeholder="0"></div>`;
  }

  // Tarjetas
  if (ready && (adm || m.cards.length)) {
    h += `<h3>Tarjetas</h3>`;
    if (edit) {
      const selTeam = modal.cardTeam && [m.home, m.away].includes(modal.cardTeam) ? modal.cardTeam : m.home;
      const tm = teamById(selTeam);
      h += `<div class="cardform">
        <select id="c-team" class="inp">${[m.home, m.away].map((id) => `<option value="${id}" ${id === selTeam ? 'selected' : ''}>${esc(tname(id))}</option>`).join('')}</select>
        <input id="c-min" type="number" inputmode="numeric" min="0" placeholder="Minuto (auto)">
        <select id="c-player" class="inp full">${(tm ? tm.players : []).map((p) => `<option value="${esc(p.name)}">${p.num ? esc(p.num) + ' · ' : ''}${esc(p.name)}</option>`).join('')}</select>
        <button class="btn cy" data-a="card" data-type="Y">🟨 Amarilla</button>
        <button class="btn cr" data-a="card" data-type="R">🟥 Roja</button>
      </div>`;
    }
    const list = [...m.cards].sort((a, b) => a.min - b.min);
    h += list.length ? `<ul class="cardlist">${list.map((cd) => `<li><span class="chip ${cd.type}"></span>
      <span class="grow"><b>${esc(cd.player)}</b> <small>${esc(tname(cd.team))}</small></span>
      <small>${cd.min}'</small>${edit ? `<button data-a="delCard" data-id="${cd.id}" aria-label="Quitar">✕</button>` : ''}</li>`).join('')}</ul>`
      : `<p class="muted" style="font-size:14px">Sin tarjetas.</p>`;
  }
  h += `</div><div class="mf">`;
  if (adm && ready) {
    h += done
      ? `<button class="btn ghost block" data-a="reopen">✏️ Corregir resultado</button>`
      : `<button class="btn block" data-a="finish">✅ Finalizar partido</button>`;
  }
  h += `</div>`;
  return h;
}

function curMatch() { return modal && modal.type === 'match' ? mById(modal.id) : null; }

function finishMatch() {
  const m = curMatch(); if (!m) return;
  if (m.phase === 'ko' && m.hs === m.as) {
    const ph = $('#m-ph').value, pa = $('#m-pa').value;
    if (ph === '' || pa === '' || +ph === +pa) return toast('En eliminación debe haber ganador: ingrese los penales');
    m.ph = +ph; m.pa = +pa;
  } else { m.ph = null; m.pa = null; }
  if (!confirm(`Finalizar: ${tname(m.home)} ${m.hs} - ${m.as} ${tname(m.away)}${m.ph != null ? ` (pen ${m.ph}-${m.pa})` : ''}`)) return;
  if (m.runAt) { m.elapsed += Date.now() - m.runAt; m.runAt = null; }
  m.status = 'done';
  syncKO();
  save(); closeModal(); render();
  const w = winner(m);
  toast(w ? `🏆 Gana ${tname(w)}` : 'Partido finalizado (empate)');
}

function reopenMatch() {
  const m = curMatch(); if (!m) return;
  const t = T();
  if (m.phase !== 'ko' && t.stage === 'final' && t.config.format !== 'elim') {
    return toast('Primero use "Deshacer fase final" en Partidos para corregir esta fase');
  }
  if (m.phase === 'ko') {
    const dep = t.matches.some((x) => x.status !== 'pend' && [x.srcH, x.srcA].some((s) => s && (s.w === m.id || s.l === m.id)));
    if (dep && !confirm('Los partidos siguientes que dependen de este se reiniciarán. ¿Continuar?')) return;
  }
  m.status = 'live';
  m.ph = null; m.pa = null;
  syncKO();
  save(); render();
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
    setAuth({ user: j.user, token: j.token });
    sync.needSetup = false;
    // empezar desde lo que hay en línea para no subir datos viejos de este teléfono
    sync.dirty = false; sync.rev = -1;
    S.tab = 'equipos';
    render();
    toast(`👋 Bienvenido, ${j.user}`);
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
function mergeList(L, B, R) {
  const bm = new Map(B.map((x) => [x.id, x]));
  const lm = new Map(L.map((x) => [x.id, x]));
  let out = R.filter((x) => !(bm.has(x.id) && !lm.has(x.id))); // borrados aquí
  for (const l of L) {
    const b = bm.get(l.id);
    if (b && same(b, l)) continue;                // sin cambios locales
    const i = out.findIndex((x) => x.id === l.id);
    if (i >= 0) out[i] = l;                       // modificado aquí
    else if (!b) out.push(l);                     // nuevo aquí
  }
  return out;
}
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
  if (L.name !== B.name) o.name = L.name;
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
    if (!same(L.groups, B.groups)) {             // sorteo hecho/deshecho aquí
      o.groups = L.groups; o.stage = L.stage; o.matches = L.matches;
    } else {
      if (L.stage !== B.stage) o.stage = L.stage;
      o.matches = mergeList(L.matches, B.matches, R.matches);
    }
    o.teams = mergeList(L.teams, B.teams, R.teams);
    syncKO(o);
    return o;
  }
}

function isBusy() {
  const a = document.activeElement;
  return (modal && modal.type === 'team') || (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.type !== 'radio');
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
    if (sync.dirty && sync.known && isAdmin()) return schedulePush(0); // push combina si hay conflicto
    if (j.rev !== sync.rev || !sync.known) adopt(j);
  } catch (e) {
    setMode('offline');
  }
}

async function push() {
  if (sync.mode === 'local' || !sync.dirty || sync.pushing || !isAdmin()) return;
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
          S.torneos = rebase(payload(), sync.base, remote).torneos;
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

function startSync() {
  if (location.protocol === 'file:') return setMode('local');
  pull(true);
  checkSetup();
  if (auth && S.tab === 'ajustes') loadOrgs();
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (sync.pendingRender && !isBusy()) render();
    if (sync.dirty) push(); else pull(false);
  }, 5000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pull(false); });
  window.addEventListener('online', () => (sync.dirty ? push() : pull(true)));
  document.addEventListener('focusout', () => setTimeout(() => { if (sync.pendingRender && !isBusy()) render(); }, 300));
}

/* ---------------- Eventos ---------------- */
const actions = {
  cat: (d) => { S.cat = d.c; save(); render(); window.scrollTo(0, 0); },
  tab: (d) => {
    S.tab = d.t; save(); render(); window.scrollTo(0, 0);
    if (d.t === 'ajustes' && auth && sync.mode !== 'local') loadOrgs();
    if (d.t === 'ajustes' && !isAdmin()) checkSetup();
  },
  close: () => closeModal(),
  view: (d) => { S.view = d.v; save(); render(); },
  viewTeam: (d) => openModal('teamView', d.id),
  openSchedule: () => openModal('schedule', null),
  applySchedule: () => applySchedule(),
  clearSchedule: () => {
    const ms = T().matches.filter((m) => m.status === 'pend' && m.date);
    if (!ms.length) return toast('No hay partidos pendientes con fecha');
    if (!confirm('¿Quitar fecha, hora y cancha de ' + ms.length + ' partidos pendientes?')) return;
    ms.forEach((m) => { m.date = ''; m.time = ''; m.field = ''; });
    save(); closeModal(); render();
  },
  logout: () => {
    if (sync.dirty && !confirm('Hay cambios que aún no se guardaron en línea. ¿Cerrar sesión de todos modos?')) return;
    setAuth(null); orgs = null;
    sync.dirty = false; sync.rev = -1;
    S.tab = ADMIN_URL ? 'ajustes' : 'partidos'; render(); pull(true);
    toast('Sesión cerrada');
  },
  changePass: async () => {
    const p1 = prompt('Nueva contraseña (mínimo 6 caracteres):');
    if (!p1) return;
    if (p1.length < 6) return toast('Mínimo 6 caracteres');
    if (prompt('Repita la nueva contraseña:') !== p1) return toast('Las contraseñas no coinciden');
    const { status, j } = await authCall({ action: 'password', pass: p1 });
    if (status === 401) return sessionExpired();
    toast(status === 200 ? '✅ Contraseña cambiada' : (j && j.error) || 'No se pudo cambiar');
  },
  delOrg: async (d) => {
    if (!confirm('¿Quitar al organizador "' + d.u + '"? Ya no podrá editar.')) return;
    const { status, j } = await authCall({ action: 'remove', user: d.u });
    if (status === 401) return sessionExpired();
    if (status !== 200) return toast((j && j.error) || 'No se pudo quitar');
    orgs = j; render(); toast('Organizador quitado');
  },
  newTeam: () => openModal('team', null),
  editTeam: (d) => openModal('team', d.id),
  saveTeam: () => saveTeam(),
  delTeam: (d) => {
    const tm = teamById(d.id);
    if (!tm || !confirm(`¿Eliminar el equipo ${tm.name}?`)) return;
    T().teams = T().teams.filter((x) => x.id !== d.id);
    save(); closeModal(); render(); toast('Equipo eliminado');
  },
  draw: () => doDraw(),
  genFinal: () => genFinal(),
  undoFinal: () => {
    if (!confirm('¿Borrar la fase final y sus resultados?')) return;
    const t = T();
    t.matches = t.matches.filter((m) => m.phase !== 'ko');
    t.stage = 'fase1'; save(); render();
  },
  undoDraw: () => {
    if (!confirm('¿Deshacer el sorteo? Se borrarán TODOS los partidos y resultados de esta categoría.')) return;
    const t = T();
    t.matches = []; t.groups = []; t.stage = 'inscripcion';
    save(); render(); toast('Sorteo deshecho');
  },
  openMatch: (d) => openModal('match', d.id),
  goal: (d) => {
    const m = curMatch(); if (!m) return;
    const k = d.s === 'h' ? 'hs' : 'as';
    m[k] = Math.max(0, m[k] + Number(d.d));
    if (m.status === 'pend') m.status = 'live';
    save(); renderModal();
  },
  start: () => {
    const m = curMatch(); if (!m) return;
    m.runAt = Date.now(); m.status = 'live';
    save(); renderModal();
  },
  pause: () => {
    const m = curMatch(); if (!m || !m.runAt) return;
    m.elapsed += Date.now() - m.runAt; m.runAt = null;
    save(); renderModal();
  },
  resetClock: () => {
    const m = curMatch(); if (!m || !confirm('¿Reiniciar el reloj a 00:00?')) return;
    m.elapsed = 0; m.runAt = m.runAt ? Date.now() : null; m.alerted = false;
    save(); renderModal();
  },
  card: (d) => {
    const m = curMatch(); if (!m) return;
    const team = $('#c-team').value, player = $('#c-player').value;
    if (!player) return toast('Seleccione un jugador');
    let min = $('#c-min').value;
    min = min === '' ? Math.floor(elapsedMs(m) / 60000) + 1 : Math.max(0, parseInt(min, 10) || 0);
    const yellows = m.cards.filter((c) => c.team === team && c.player === player && c.type === 'Y').length;
    m.cards.push({ id: uid(), team, player, type: d.type, min });
    if (m.status === 'pend') m.status = 'live';
    save(); renderModal();
    if (d.type === 'Y' && yellows >= 1) toast(`⚠️ Segunda amarilla para ${player}: corresponde roja`);
    else toast(`${d.type === 'Y' ? '🟨 Amarilla' : '🟥 Roja'} · ${player}`);
  },
  delCard: (d) => {
    const m = curMatch(); if (!m) return;
    m.cards = m.cards.filter((c) => c.id !== d.id);
    save(); renderModal();
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
    if (!confirm(`¿Borrar TODO de la categoría ${catName(S.cat)}? No se puede deshacer.`)) return;
    if (!confirm('¿Seguro? Se perderán equipos, pagos y resultados.')) return;
    CATS_()[S.cat] = newTournament(T().name, T().color); save(); render(); toast('Categoría vaciada');
  },
  crestRandom: () => { if (modal) { modal.crest = randomCrest(); updateCrestUI(); } },
  crestNone: () => { if (modal) { modal.crest = null; updateCrestUI(); } },
  crestPreset: (d) => { if (modal) { modal.crest = clone(CREST_PRESETS[+d.i]); updateCrestUI(); } },
  openTorneos: () => openModal('torneos', null),
  switchTorneo: (d) => {
    if (!S.torneos[d.id]) return;
    S.tor = d.id; S.cat = Object.keys(CATS_())[0];
    saveLocal(); closeModal(); render(); window.scrollTo(0, 0);
  },
  newTorneo: () => {
    const n = (prompt('Nombre del nuevo torneo (ej: Copa Navidad 2026):') || '').trim().slice(0, 40);
    if (!n) return;
    const id = 't' + uid();
    S.torneos[id] = newTorneo(n, CATS_());
    S.torneos[id].config = clone(TC());
    S.tor = id; S.cat = Object.keys(CATS_())[0];
    save(); closeModal(); render();
    toast('🏆 Torneo "' + n + '" creado con las mismas categorías');
  },
  delTorneo: (d) => {
    const tor = S.torneos[d.id];
    if (!tor || Object.keys(S.torneos).length < 2) return;
    if (!confirm('¿Eliminar el torneo "' + tor.name + '" con todas sus categorías, equipos y resultados?')) return;
    if (!confirm('Esta acción no se puede deshacer. ¿Seguro?')) return;
    delete S.torneos[d.id];
    fixSelection(S);
    save(); closeModal(); render(); toast('Torneo eliminado');
  },
  renameCat: (d) => {
    const t = CATS_()[d.c]; if (!t) return;
    const n = (prompt('Nuevo nombre de la categoría:', t.name) || '').trim().slice(0, 24);
    if (!n || n === t.name) return;
    if (catNameTaken(n, d.c)) return toast('Ya existe una categoría con ese nombre');
    t.name = n; save(); render();
  },
  colorCat: (d) => { const t = CATS_()[d.c]; if (!t) return; t.color = ((t.color || 0) + 1) % PALETTES; save(); render(); },
  delCat: (d) => {
    const t = CATS_()[d.c]; if (!t || Object.keys(CATS_()).length < 2) return;
    if (!confirm(`¿Eliminar la categoría "${t.name}"?${t.teams.length ? ` Tiene ${t.teams.length} equipos inscritos.` : ''}`)) return;
    if (t.teams.length && !confirm('Se borrarán sus equipos, pagos, partidos y resultados. No se puede deshacer. ¿Seguro?')) return;
    delete CATS_()[d.c];
    if (S.cat === d.c) S.cat = Object.keys(CATS_())[0];
    save(); render(); toast('Categoría eliminada');
  },
  syncInfo: () => toast(syncText()),
  syncNow: () => { if (sync.dirty) push(); else pull(true); },
  install: async () => {
    if (!installEvt) return;
    installEvt.prompt();
    await installEvt.userChoice;
    installEvt = null; render();
  },
};

const PUBLIC_ACTIONS = new Set(['cat', 'tab', 'close', 'view', 'viewTeam', 'openMatch', 'syncInfo', 'syncNow', 'install', 'openTorneos', 'switchTorneo']);

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'loginForm') { e.preventDefault(); return doLogin(); }
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
    const user = $('#o-user').value.trim().toLowerCase(), pass = $('#o-pass').value;
    if (!user || !pass) return toast('Escriba usuario y contraseña');
    const { status, j } = await authCall({ action: 'add', user, pass });
    if (status === 401) return sessionExpired();
    if (status !== 200) return toast((j && j.error) || 'No se pudo agregar');
    orgs = j; render(); toast('✅ Organizador ' + user + ' agregado');
  }
});

document.addEventListener('click', (e) => {
  if (e.target.id === 'modal') return closeModal();
  const el = e.target.closest('[data-a]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.a];
  if (!fn) return;
  e.preventDefault();
  if (!isAdmin() && !PUBLIC_ACTIONS.has(el.dataset.a)) return toast('Ingrese como organizador para editar');
  fn(el.dataset, el);
});

document.addEventListener('input', (e) => {
  if (e.target.matches('[data-pl]')) checkPlayers();
  if (e.target.id === 'f-name' && modal && modal.crest && modal.crest.e === 'inicial') updateCrestUI();
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.id === 't-name') {
    if (!isAdmin()) return;
    const n = el.value.trim().slice(0, 40);
    if (n) { TOR().name = n; save(); render(); toast('Nombre del torneo guardado'); }
    return;
  }
  if (el.dataset.tcfg) {
    if (!isAdmin()) return;
    const g = TC(), k = el.dataset.tcfg;
    g[k] = Math.max(k === 'subs' ? 0 : 1, Math.min(k === 'minPlayers' ? 60 : 30, Math.round(num(el.value, g[k]))));
    if (g.minPlayers > g.starters + g.subs) { g.minPlayers = g.starters + g.subs; toast('El mínimo no puede superar el total del equipo'); }
    save(); render();
    return;
  }
  if (el.dataset.crest) {
    const k = el.dataset.crest;
    modal.crest = Object.assign(modal.crest && !modal.crest.img ? modal.crest : randomCrest(), { [k]: el.value });
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
    if (k === 'format') v = el.value;
    if (k === 'duration') v = Math.max(1, Math.min(200, Math.round(v)));
    if (k === 'fee') v = Math.max(0, v);
    c[k] = v;

    if (k === 'format' && c.format !== 'liga') c.ligaFinal = c.ligaFinal || 0;
    save();
    if (el.type === 'radio' || el.tagName === 'SELECT') render();
    return;
  }
  if (el.id === 'm-dur') {
    const m = curMatch(); if (!m) return;
    m.duration = Math.max(1, Math.min(200, Math.round(num(el.value, m.duration))));
    m.alerted = false; save(); updateClock();
    return;
  }
  if (el.id === 'c-team' && modal) { modal.cardTeam = el.value; renderModal(); return; }
  if (['m-date', 'm-time', 'm-field'].includes(el.id)) {
    const m = curMatch(); if (!m || !isAdmin()) return;
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
        if (!confirm('¿Reemplazar los datos actuales con el respaldo?')) return;
        S = d; save(); render(); toast('✅ Respaldo importado');
      } catch (err) { toast('Archivo no válido'); }
    };
    r.readAsText(el.files[0]);
  }
});

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
