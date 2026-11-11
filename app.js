'use strict';
/* =========================================================
   Torneo de Fútbol — app local (PWA). Datos en localStorage.
   ========================================================= */
const KEY = 'torneo-futbol-v1';
const CATS = { M: 'Masculino', F: 'Femenino' };

const $ = (s) => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + (Number(n) || 0).toLocaleString('es', { maximumFractionDigits: 2 });
const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const num = (v, d = 0) => { const n = parseFloat(v); return isNaN(n) ? d : n; };

function newTournament() {
  return {
    config: {
      minPlayers: 8, maxPlayers: 10, fee: 0, duration: 20,
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

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && d.cats && d.cats.M && d.cats.F) return d;
  } catch (e) { /* sin datos */ }
  return { cats: { M: newTournament(), F: newTournament() }, cat: 'M', tab: 'equipos' };
}
let S = load();

/* Estado de sincronización con la base de datos en línea */
const SYNC_KEY = 'torneo-sync-v1';
const PIN_KEY = 'torneo-pin';
const sync = { mode: 'init', rev: 0, base: null, dirty: false, known: false, needPin: false, last: 0, pushing: false, timer: null, pendingRender: false };
try {
  const d = JSON.parse(localStorage.getItem(SYNC_KEY));
  if (d) Object.assign(sync, { rev: d.rev || 0, base: d.base || null, dirty: !!d.dirty, known: true });
} catch (e) { /* nada */ }

function saveLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('⚠️ No se pudo guardar'); }
}
function save() {
  saveLocal();
  if (sync.mode !== 'local') {
    sync.dirty = JSON.stringify(payload()) !== JSON.stringify(sync.base);
    saveSync();
    if (sync.dirty) schedulePush();
  }
}

let modal = null;      // { type: 'team'|'match', id }
let tick = null;
let installEvt = null;

const T = () => S.cats[S.cat];
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
  for (const k of Object.keys(S.cats)) {
    for (const tm of S.cats[k].teams) {
      if (tm.id === exceptTeamId) continue;
      for (const p of tm.players) map.set(norm(p.name), `${tm.name} (${CATS[k]})`);
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
  const short = t.teams.filter((x) => x.players.length < c.minPlayers);
  if (short.length) return toast(`Faltan integrantes en: ${short.map((x) => x.name).join(', ')}`);
  if (c.format === 'grupos' && n < 4) return toast('Para grupos se necesitan al menos 4 equipos');
  if (c.format === 'liga' && c.ligaFinal > n) return toast(`No hay ${c.ligaFinal} equipos para la fase final`);
  if (!confirm(`¿Realizar el sorteo de ${n} equipos (${CATS[S.cat]})?`)) return;

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
  document.body.dataset.cat = S.cat;
  document.querySelectorAll('#cats button').forEach((b) => b.classList.toggle('on', b.dataset.c === S.cat));
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === S.tab));
  $('#view').innerHTML = (views[S.tab] || viewEquipos)();
  renderModal();
  setMode(sync.mode, false);
}

function viewEquipos() {
  const t = T(), c = t.config;
  const paid = t.teams.reduce((a, x) => a + num(x.paid), 0);
  const due = t.teams.reduce((a, x) => a + Math.max(0, num(c.fee) - num(x.paid)), 0);
  let h = `<h1>Equipos ${CATS[S.cat]}</h1>
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
    h += `<div class="empty">Aún no hay equipos inscritos.<br><small>Cuota de inscripción: ${money(c.fee)} · ${c.minPlayers} a ${c.maxPlayers} integrantes</small></div>`;
  }
  for (const tm of t.teams) {
    const owes = num(c.fee) - num(tm.paid);
    const badge = num(c.fee) <= 0 ? `<span class="badge b-pend">${money(tm.paid)}</span>`
      : owes <= 0 ? `<span class="badge b-ok">Pagado</span>`
        : `<span class="badge b-bad">Debe ${money(owes)}</span>`;
    h += `<button class="list-item" data-a="editTeam" data-id="${tm.id}">
      <div class="avatar">${esc(tm.name.slice(0, 1).toUpperCase())}</div>
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

function viewPartidos() {
  const t = T(), c = t.config;
  if (t.stage === 'inscripcion') {
    const n = t.teams.length;
    let h = `<h1>Sorteo ${CATS[S.cat]}</h1>
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
      if (n >= 4) {
        const ng = Math.max(2, Math.floor(n / c.groupSize));
        h += `<p class="muted"><small>Con ${n} equipos se formarán ${ng} grupos.</small></p>`;
      }
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

  const fmt = { liga: 'Todos contra todos', grupos: 'Cuadrangulares', elim: 'Eliminación directa' }[c.format];
  let h = `<h1>Partidos ${CATS[S.cat]}</h1><p class="muted">${fmt} · ${c.podium} lugar(es) · toque un partido para jugarlo</p>`;

  const p1 = phase1();
  const done1 = p1.filter((m) => m.status === 'done').length;
  if (p1.length) {
    h += `<h3>${c.format === 'liga' ? 'Fase regular' : 'Fase de grupos'} · ${done1}/${p1.length}</h3>`;
    const rounds = [...new Set(p1.map((m) => m.round))];
    for (const r of rounds) {
      h += `<div class="muted" style="font-size:13px;margin:10px 0 6px;font-weight:700">Fecha ${r}</div>`;
      for (const m of p1.filter((x) => x.round === r)) h += matchCard(m);
    }
    if (t.stage === 'fase1' && needsFinal()) {
      h += phase1Done()
        ? `<button class="btn block" data-a="genFinal">🏁 Generar fase final</button>`
        : `<div class="note warn">Cuando terminen todos los partidos podrá generar la fase final.</div>`;
    }
  }

  const ko = t.matches.filter((m) => m.phase === 'ko');
  if (ko.length) {
    h += `<h3>Fase final</h3>`;
    const labels = [];
    for (const m of ko) { const base = m.label.replace(/ \d+$/, ''); if (!labels.includes(base)) labels.push(base); }
    for (const lb of labels) {
      h += `<div class="muted" style="font-size:13px;margin:10px 0 6px;font-weight:700">${lb}</div>`;
      for (const m of ko.filter((x) => x.label.replace(/ \d+$/, '') === lb)) h += matchCard(m);
    }
    if (c.format !== 'elim') h += `<button class="btn ghost block sm" data-a="undoFinal">Deshacer fase final</button>`;
  }
  const pod = podium();
  if (pod) h += podiumHTML(pod);

  h += `<div style="height:20px"></div><button class="btn danger block sm" data-a="undoDraw">Deshacer sorteo (borra resultados)</button>`;
  return h;
}

function matchCard(m) {
  const done = m.status === 'done';
  const w = winner(m);
  const side = (id, src, cls) => id
    ? `<div class="${cls} ${done && w === id ? 'win' : ''}">${esc(tname(id))}</div>`
    : `<div class="${cls} tbd">${esc(srcLabel(src))}</div>`;
  const status = done ? '<span class="badge b-ok">Final</span>'
    : m.status === 'live' ? '<span class="badge b-live">En juego</span>'
      : '<span class="badge b-pend">Pendiente</span>';
  const pens = done && m.ph != null && m.hs === m.as ? `<small>pen ${m.ph}-${m.pa}</small>` : '';
  const yc = m.cards.filter((x) => x.type === 'Y').length, rc = m.cards.filter((x) => x.type === 'R').length;
  const cards = (yc || rc) ? `${yc ? `🟨${yc}` : ''} ${rc ? `🟥${rc}` : ''}` : '';
  return `<button class="match ${m.status}" data-a="openMatch" data-id="${m.id}">
    ${side(m.home, m.srcH, 'h')}
    <div class="sc">${m.status === 'pend' ? 'vs' : `${m.hs} - ${m.as}`}${pens}</div>
    ${side(m.away, m.srcA, 'a')}
    <div class="meta"><span>${m.phase === 'ko' ? esc(m.label) : (m.group ? 'Grupo ' + m.group : '')} · ${m.duration} min</span><span>${cards} ${status}</span></div>
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
    ${rows.map((r, i) => `<tr class="${i < qualify ? 'q' : ''}"><td>${i + 1}</td><td class="tn">${esc(tname(r.id))}</td>
      <td>${r.pj}</td><td>${r.pg}</td><td>${r.pe}</td><td>${r.pp}</td><td>${r.gf}</td><td>${r.gc}</td><td>${r.gf - r.gc}</td>
      <td>${r.ta}</td><td>${r.tr}</td><td class="pts">${r.pts}</td></tr>`).join('')}
  </table></div>`;
}

function viewTabla() {
  const t = T(), c = t.config;
  if (t.stage === 'inscripcion') return `<h1>Tabla ${CATS[S.cat]}</h1><div class="empty">Aún no se ha realizado el sorteo.</div>`;
  let h = `<h1>Tabla ${CATS[S.cat]}</h1>`;
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

function viewAjustes() {
  const c = T().config;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  return `<h1>Ajustes ${CATS[S.cat]}</h1>
  <div class="card">
    <h2>Inscripción</h2>
    <div class="grid2">
      <label class="fl">Mínimo integrantes<input type="number" inputmode="numeric" min="1" max="30" data-cfg="minPlayers" value="${c.minPlayers}"></label>
      <label class="fl">Máximo integrantes<input type="number" inputmode="numeric" min="1" max="30" data-cfg="maxPlayers" value="${c.maxPlayers}"></label>
    </div>
    <div class="grid2">
      <label class="fl">Cuota de inscripción<input type="number" inputmode="decimal" min="0" data-cfg="fee" value="${c.fee}"></label>
      <label class="fl">Minutos por partido<input type="number" inputmode="numeric" min="1" data-cfg="duration" value="${c.duration}"></label>
    </div>
    <small>Estos ajustes son solo para la categoría ${CATS[S.cat]}.</small>
  </div>
  <div class="card">
    <h2>Base de datos en línea</h2>
    <p class="muted" style="font-size:14px" id="sync-status">${esc(syncText())}</p>
    ${sync.needPin ? `<label class="fl">PIN de organizador <small>(necesario para guardar cambios)</small>
      <input type="password" inputmode="numeric" id="pin" placeholder="PIN" value="${esc(localStorage.getItem(PIN_KEY) || '')}"></label>` : ''}
    ${sync.mode !== 'local' ? '<button class="btn ghost block sm" data-a="syncNow">🔄 Sincronizar ahora</button>' : ''}
  </div>
  <div class="card">
    <h2>Instalar en el teléfono</h2>
    ${standalone ? '<p class="muted">✅ La app ya está instalada.</p>' : `
      ${installEvt ? '<button class="btn block" data-a="install">📲 Instalar app</button>' : ''}
      <p class="muted" style="font-size:14px"><b>Android (Chrome):</b> menú ⋮ → “Instalar aplicación” o “Agregar a pantalla principal”.<br>
      <b>iPhone (Safari):</b> botón Compartir → “Agregar a inicio”.</p>`}
  </div>
  <div class="card">
    <h2>Respaldo de datos</h2>
    <p class="muted" style="font-size:14px">Los datos se guardan en este dispositivo. Exporte un respaldo para pasarlo a otro teléfono o no perderlo.</p>
    <div class="row">
      <button class="btn ghost" data-a="export">⬇️ Exportar</button>
      <label class="btn ghost">⬆️ Importar<input type="file" accept="application/json,.json" id="importFile" hidden></label>
    </div>
  </div>
  <div class="card">
    <h2>Borrar</h2>
    <p class="muted" style="font-size:14px">Elimina equipos, sorteo y resultados de la categoría ${CATS[S.cat]}.</p>
    <button class="btn danger block" data-a="resetCat">Borrar categoría ${CATS[S.cat]}</button>
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
  const sheet = $('#sheet');
  const scroll = sheet.scrollTop;
  if (modal.type === 'team') sheet.innerHTML = teamFormHTML(modal.id);
  else if (modal.type === 'match') {
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

function teamFormHTML(id) {
  const t = T(), c = t.config;
  const tm = id ? teamById(id) : null;
  const players = tm ? tm.players : [];
  const rows = Math.max(c.maxPlayers, players.length);
  let h = `<div class="mh"><h2>${tm ? 'Editar equipo' : 'Inscribir equipo'}</h2><button class="x" data-a="close">✕</button></div>
  <div class="mb">
    <label class="fl">Nombre del equipo<input id="f-name" maxlength="40" placeholder="Ej: Los Tigres" value="${esc(tm ? tm.name : '')}"></label>
    <div class="fl">Integrantes <small id="f-count">(mínimo ${c.minPlayers}, máximo ${c.maxPlayers})</small></div>
    <div id="f-players">`;
  for (let i = 0; i < rows; i++) {
    const p = players[i] || {};
    h += `<div class="prow"><span class="pn">${i + 1}</span>
      <input class="pl-name" data-pl autocomplete="off" placeholder="Nombre y apellido${i < c.minPlayers ? ' *' : ''}" value="${esc(p.name || '')}">
      <input class="pl-num" type="number" inputmode="numeric" placeholder="N°" value="${esc(p.num ?? '')}">
      <div class="perr"></div></div>`;
  }
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
  const c = T().config;
  const cnt = $('#f-count');
  if (cnt) cnt.textContent = `(${filled} de ${c.maxPlayers} · mínimo ${c.minPlayers})`;
  return errors;
}

function saveTeam() {
  const t = T(), c = t.config;
  const id = modal.id;
  const name = $('#f-name').value.trim().replace(/\s+/g, ' ');
  if (!name) return toast('Escriba el nombre del equipo');
  for (const k of Object.keys(S.cats)) {
    const dup = S.cats[k].teams.find((x) => x.id !== id && norm(x.name) === norm(name));
    if (dup) return toast(`Ya existe un equipo "${dup.name}" en ${CATS[k]}`);
  }
  if (checkPlayers() > 0) return toast('Hay integrantes repetidos (marcados en rojo)');
  const players = [];
  document.querySelectorAll('#f-players .prow').forEach((row) => {
    const pn = row.querySelector('.pl-name').value.trim().replace(/\s+/g, ' ');
    const nb = row.querySelector('.pl-num').value.trim();
    if (pn) players.push({ name: pn, num: nb });
  });
  if (players.length < c.minPlayers) return toast(`Se requieren al menos ${c.minPlayers} integrantes (hay ${players.length})`);
  if (players.length > c.maxPlayers) return toast(`Máximo ${c.maxPlayers} integrantes`);
  const paid = num($('#f-paid').value);
  if (id) {
    Object.assign(teamById(id), { name, players, paid });
  } else {
    if (t.stage !== 'inscripcion') return toast('El sorteo ya se realizó');
    t.teams.push({ id: uid(), name, players, paid, createdAt: Date.now() });
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
  if (over && m.runAt && !m.alerted) {
    m.alerted = true; save();
    if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 600]);
    toast(`⏰ Se cumplieron los ${m.duration} minutos`);
  }
}

function matchHTML(m) {
  const t = T();
  const done = m.status === 'done';
  const ready = !!(m.home && m.away);
  const isKO = m.phase === 'ko';
  const title = isKO ? m.label : `${m.group ? 'Grupo ' + m.group + ' · ' : ''}Fecha ${m.round}`;
  const side = (id, src, s, val) => `<div>
    <div class="tn">${esc(id ? tname(id) : srcLabel(src))}</div>
    <span class="big">${val}</span>
    ${!done && ready ? `<div class="stepper"><button class="minus" data-a="goal" data-s="${s}" data-d="-1">−</button><button data-a="goal" data-s="${s}" data-d="1">+</button></div>` : ''}
  </div>`;

  let h = `<div class="mh"><h2>${esc(title)}</h2><button class="x" data-a="close">✕</button></div><div class="mb">`;
  if (!ready) h += `<div class="note warn" style="margin-top:12px">Este partido se define cuando terminen los partidos anteriores.</div>`;
  h += `<div class="score">${side(m.home, m.srcH, 'h', m.hs)}<div class="vs">-</div>${side(m.away, m.srcA, 'a', m.as)}</div>`;

  if (!done) {
    const running = !!m.runAt;
    h += `<div class="timer">
      <div><div class="clock" id="clock">00:00</div><small>${running ? 'En juego' : m.elapsed ? 'Pausado' : 'Sin iniciar'}</small></div>
      <div class="dur">Tiempo<input type="number" inputmode="numeric" min="1" id="m-dur" value="${m.duration}">min</div>
      <div class="row" style="width:100%">
        ${running ? `<button class="btn ghost sm" data-a="pause">⏸ Pausar</button>`
        : `<button class="btn sm" data-a="start" ${ready ? '' : 'disabled'}>▶ ${m.elapsed ? 'Reanudar' : 'Iniciar'}</button>`}
        ${m.elapsed || running ? `<button class="btn ghost sm" data-a="resetClock">↺ Reiniciar reloj</button>` : ''}
      </div></div>`;
  } else {
    h += `<p class="muted" style="text-align:center;margin:0">Partido finalizado · ${m.duration} min${m.elapsed ? ` · reloj ${fmtClock(m.elapsed)}` : ''}</p>`;
  }

  if (isKO && ready && m.hs === m.as && (!done || m.ph != null)) {
    h += `<h3>Penales (empate)</h3><div class="pens">
      <input type="number" inputmode="numeric" min="0" id="m-ph" value="${m.ph ?? ''}" ${done ? 'disabled' : ''} placeholder="0">
      <span>-</span>
      <input type="number" inputmode="numeric" min="0" id="m-pa" value="${m.pa ?? ''}" ${done ? 'disabled' : ''} placeholder="0"></div>`;
  }

  // Tarjetas
  if (ready) {
    h += `<h3>Tarjetas</h3>`;
    if (!done) {
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
      <small>${cd.min}'</small>${done ? '' : `<button data-a="delCard" data-id="${cd.id}" aria-label="Quitar">✕</button>`}</li>`).join('')}</ul>`
      : `<p class="muted" style="font-size:14px">Sin tarjetas.</p>`;
  }
  h += `</div><div class="mf">`;
  if (ready) {
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
const clone = (o) => JSON.parse(JSON.stringify(o));
const payload = () => ({ cats: S.cats });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function saveSync() {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify({ rev: sync.rev, base: sync.base, dirty: sync.dirty })); } catch (e) { /* nada */ }
}
function schedulePush(ms = 400) { clearTimeout(sync.timer); sync.timer = setTimeout(push, ms); }

async function apiCall(method, body, query = '') {
  const headers = { 'Content-Type': 'application/json' };
  const pin = localStorage.getItem(PIN_KEY);
  if (pin) headers['x-pin'] = pin;
  const r = await fetch('api/state' + query, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  let j = null;
  try { j = await r.json(); } catch (e) { /* respuesta no JSON (sin API) */ }
  return { status: r.status, j };
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
function rebase(local, base, remote) {
  const out = { cats: {} };
  for (const k of Object.keys(CATS)) {
    const L = local.cats[k], B = (base && base.cats && base.cats[k]) || newTournament();
    const R = (remote && remote.cats && remote.cats[k]) || newTournament();
    const o = clone(R);
    if (!same(L.config, B.config)) o.config = L.config;
    if (!same(L.groups, B.groups)) {             // sorteo hecho/deshecho aquí
      o.groups = L.groups; o.stage = L.stage; o.matches = L.matches;
    } else {
      if (L.stage !== B.stage) o.stage = L.stage;
      o.matches = mergeList(L.matches, B.matches, R.matches);
    }
    o.teams = mergeList(L.teams, B.teams, R.teams);
    syncKO(o);
    out.cats[k] = o;
  }
  return out;
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
  if (!sync.known && S.cats.M.teams.length + S.cats.F.teams.length > 0 && !same(payload(), j.data)) {
    try { localStorage.setItem('torneo-respaldo-local', JSON.stringify(S)); } catch (e) { /* nada */ }
  }
  S.cats = { M: j.data.cats.M || newTournament(), F: j.data.cats.F || newTournament() };
  Object.assign(sync, { rev: j.rev, base: clone(payload()), dirty: false, known: true });
  saveLocal(); saveSync();
  requestRender();
}

function setMode(m, touch = true) {
  sync.mode = m;
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
    if (j.pin !== undefined) sync.needPin = j.pin;
    setMode('online');
    if (j.same) { if (sync.dirty) schedulePush(0); return; }
    if (!j.data) {                                   // base vacía: subir lo de este teléfono
      if (S.cats.M.teams.length + S.cats.F.teams.length > 0) { sync.dirty = true; sync.rev = j.rev; schedulePush(0); }
      return;
    }
    if (sync.dirty && sync.known) return schedulePush(0); // push combina si hay conflicto
    if (j.rev !== sync.rev || !sync.known) adopt(j);
  } catch (e) {
    setMode('offline');
  }
}

async function push() {
  if (sync.mode === 'local' || !sync.dirty || sync.pushing) return;
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
          S.cats = rebase(payload(), sync.base, j.data).cats;
          sync.base = j.data;
          saveLocal(); requestRender();
        }
        sync.rev = j ? j.rev : 0;
      } else if (status === 401) {
        const pin = prompt('Esta base de datos tiene PIN de organizador.\nIngrese el PIN para guardar cambios:');
        if (pin) { localStorage.setItem(PIN_KEY, pin.trim()); continue; }
        sync.dirty = false; sync.rev = -1; sync.pushing = false;
        toast('Sin PIN solo puede ver. Se recargaron los datos.');
        return pull(true);
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
  tab: (d) => { S.tab = d.t; save(); render(); window.scrollTo(0, 0); },
  close: () => closeModal(),
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
    if (!confirm(`¿Borrar TODO de la categoría ${CATS[S.cat]}? No se puede deshacer.`)) return;
    if (!confirm('¿Seguro? Se perderán equipos, pagos y resultados.')) return;
    S.cats[S.cat] = newTournament(); save(); render(); toast('Categoría borrada');
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

document.addEventListener('click', (e) => {
  if (e.target.id === 'modal') return closeModal();
  const el = e.target.closest('[data-a]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.a];
  if (fn) { e.preventDefault(); fn(el.dataset, el); }
});

document.addEventListener('input', (e) => {
  if (e.target.matches('[data-pl]')) checkPlayers();
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.cfg) {
    const c = T().config;
    const k = el.dataset.cfg;
    let v = num(el.value);
    if (k === 'format') v = el.value;
    if (['minPlayers', 'maxPlayers', 'duration'].includes(k)) v = Math.max(1, Math.min(k === 'duration' ? 200 : 30, Math.round(v)));
    if (k === 'fee') v = Math.max(0, v);
    c[k] = v;
    if (c.minPlayers > c.maxPlayers) {
      if (k === 'minPlayers') c.maxPlayers = c.minPlayers; else c.minPlayers = c.maxPlayers;
    }
    if (k === 'format' && c.format !== 'liga') c.ligaFinal = c.ligaFinal || 0;
    save();
    if (el.type === 'radio' || el.tagName === 'SELECT' || ['minPlayers', 'maxPlayers'].includes(k)) render();
    return;
  }
  if (el.id === 'm-dur') {
    const m = curMatch(); if (!m) return;
    m.duration = Math.max(1, Math.min(200, Math.round(num(el.value, m.duration))));
    m.alerted = false; save(); updateClock();
    return;
  }
  if (el.id === 'c-team' && modal) { modal.cardTeam = el.value; renderModal(); return; }
  if (el.id === 'pin') {
    localStorage.setItem(PIN_KEY, el.value.trim());
    toast('PIN guardado'); if (sync.dirty) push();
    return;
  }
  if (el.id === 'importFile' && el.files[0]) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (!d || !d.cats || !d.cats.M || !d.cats.F) throw new Error('formato');
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

render();
startSync();
