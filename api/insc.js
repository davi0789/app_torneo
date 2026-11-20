// Inscripciones en línea: los capitanes inscriben a su equipo y los organizadores aprueban, observan o rechazan.
// Todas las reglas se validan aquí (en el servidor), no solo en el teléfono del capitán.
const { configured, redis, hashPass, checkPass, signData, verifyData, verify, readBody } = require('./_lib');

const K_INSC = 'torneo:insc';     // hash: código → inscripción (JSON)
const K_BANS = 'torneo:bajas';    // hash: "torneo|nombre" → jugador dado de baja (no puede inscribirse en otro equipo)
const K_LOCK = 'torneo:insc:lock';
const K_INV = 'torneo:invit';     // hash: código de invitación → {tor, cat, label, usedBy}
const normInv = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
async function getInv(code) {
  const c = normInv(code);
  const raw = c.length === 8 ? await redis(['HGET', K_INV, c]) : null;
  try { return raw ? { code: c, ...JSON.parse(raw) } : null; } catch (e) { return null; }
}
async function allInvites() {
  const flat = (await redis(['HGETALL', K_INV])) || [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) { try { out.push({ code: flat[i], ...JSON.parse(flat[i + 1]) }); } catch (e) { /* dañada */ } }
  return out.sort((a, z) => (z.createdAt || 0) - (a.createdAt || 0));
}
const MAX_REGS = 300;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const clean = (s, max = 60) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
const digits = (s) => String(s || '').replace(/\D/g, '');
const fail = (res, code, error, extra) => res.status(code).json({ error, ...extra });

/** Configuración de inscripción de una categoría (la define el organizador en Ajustes). */
function inscCfg(cat) {
  const c = (cat && cat.config && cat.config.insc) || {};
  return {
    open: !!c.open,
    until: Number(c.until) || 0,
    changesUntil: Number(c.changesUntil) || 0,
    min: Math.max(1, Number(c.min) || 5),
    max: Math.max(1, Number(c.max) || 10),
  };
}
/** regOpen: se pueden crear y enviar inscripciones. chOpen: se pueden dar altas y bajas de jugadores. */
function windows(cfg) {
  const now = Date.now();
  const regOpen = cfg.open && (!cfg.until || now <= cfg.until);
  const chOpen = cfg.open && (cfg.changesUntil ? now <= cfg.changesUntil : regOpen);
  return { regOpen, chOpen: chOpen || regOpen };
}

async function loadData() {
  const raw = await redis(['GET', 'torneo:data']);
  try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
async function allRegs() {
  const flat = (await redis(['HGETALL', K_INSC])) || [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) { try { out.push(JSON.parse(flat[i + 1])); } catch (e) { /* dañada */ } }
  return out;
}
async function allBans() {
  const flat = (await redis(['HGETALL', K_BANS])) || [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) { try { out.push({ key: flat[i], ...JSON.parse(flat[i + 1]) }); } catch (e) { /* dañada */ } }
  return out;
}
const putReg = (r) => redis(['HSET', K_INSC, r.id, JSON.stringify(r)]);
const publicReg = (r) => { const o = { ...r }; delete o.pass; delete o.pv; return o; };
const addLog = (r, by, t, text = '') => { r.log = (r.log || []).concat({ at: Date.now(), by, t, text }).slice(-150); };

/** Un solo cambio a la vez (evita que dos capitanes inscriban al mismo jugador al mismo tiempo). */
async function withLock(fn) {
  for (let i = 0; i < 30; i++) {
    if ((await redis(['SET', K_LOCK, '1', 'NX', 'PX', '6000'])) === 'OK') {
      try { return await fn(); } finally { await redis(['DEL', K_LOCK]); }
    }
    await sleep(150);
  }
  throw new Error('El sistema está ocupado, intente de nuevo');
}

function newCode(existing, len = 6) {
  const crypto = require('crypto');
  for (;;) {
    let c = '';
    for (let i = 0; i < len; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!existing.has(c)) return c;
  }
}

/* ---------------- Validaciones ---------------- */
const validTeamName = (n) => n.length >= 2 && n.length <= 40;
const validPersonName = (n) => /^[\p{L} .'-]{5,60}$/u.test(n) && n.split(' ').filter((w) => w.replace(/[.'-]/g, '').length >= 2).length >= 2;
const validPhone = (p) => digits(p).length >= 8 && digits(p).length <= 15;
/**
 * Documento opcional para distinguir a dos personas con el mismo nombre:
 * DUI (00000000-0) o carné de minoridad / partida (5 a 15 letras o números).
 * Devuelve '' si está vacío y null si no es válido.
 */
const normDoc = (d) => {
  const x = String(d || '').toUpperCase().replace(/[\s.]/g, '');
  if (!x) return '';
  if (/^\d{8}-?\d$/.test(x)) { const n = x.replace('-', ''); return n.slice(0, 8) + '-' + n.slice(8); }
  return /^[A-Z0-9-]{5,15}$/.test(x) ? x : null;
};

function cleanRep(r) { r = r || {}; return { name: clean(r.name), phone: clean(r.phone, 20) }; }
function cleanPlayers(list) {
  return (Array.isArray(list) ? list : []).slice(0, 40).map((p) => ({
    name: clean(p && p.name),
    num: String((p && p.num) ?? '').trim().slice(0, 3),
    doc: clean(p && p.doc, 16),
  })).filter((p) => p.name);
}
function cleanCrest(c) {
  if (!c || typeof c !== 'object') return null;
  if (c.img) return /^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(c.img) && c.img.length < 60000 ? { img: c.img } : null;
  const o = {};
  for (const k of ['s', 'p', 'c1', 'c2', 'e', 'ce']) if (c[k] != null) o[k] = String(c[k]).slice(0, 20);
  return o;
}

/**
 * Índice de jugadores ya inscritos en el mismo torneo: nombre → [{label, doc}] y documento → label.
 * Los equipos que vienen de una inscripción en línea se toman de la inscripción (que sí tiene documentos).
 */
function playerIndex(data, regs, reg) {
  const names = new Map(), docs = new Map();
  const add = (n, label, doc) => { if (!names.has(n)) names.set(n, []); names.get(n).push({ label, doc: doc || '' }); };
  const tor = data && data.torneos && data.torneos[reg.tor];
  const catLabel = (k) => (tor && tor.cats[k] && tor.cats[k].name) || 'otra categoría';
  const live = new Set();
  for (const r of regs) {
    if (r.tor !== reg.tor || r.status === 'rechazada') continue;
    live.add(r.id);
    if (r.id === reg.id) continue;
    for (const p of r.players || []) {
      add(norm(p.name), `${r.name} (${catLabel(r.cat)})`, p.doc);
      if (p.doc) docs.set(p.doc, `${r.name} (${catLabel(r.cat)})`);
    }
  }
  if (tor) {
    for (const [k, cat] of Object.entries(tor.cats || {})) {
      for (const tm of cat.teams || []) {
        if ((reg.teamId && tm.id === reg.teamId) || (tm.insc && live.has(tm.insc))) continue;
        for (const p of tm.players || []) add(norm(p.name), `${tm.name} (${catLabel(k)})`, '');
      }
    }
  }
  return { names, docs };
}
function banIndex(bans, tor) {
  const names = new Map(), docs = new Map();
  for (const b of bans) {
    if (b.tor !== tor) continue;
    const n = norm(b.name);
    if (!names.has(n)) names.set(n, []);
    names.get(n).push({ label: b.team, doc: b.doc || '' });
    if (b.doc) docs.set(b.doc, b.team);
  }
  return { names, docs };
}
/**
 * Mismo nombre: ¿es la misma persona?
 * hard = mismo documento, o ninguno de los dos tiene documento (no se puede distinguir) → se bloquea.
 * soft = solo uno de los dos tiene documento → se permite y la organización lo verifica.
 * Si ambos tienen documento y son distintos, son personas distintas.
 */
function clash(list, doc) {
  let soft = null;
  for (const o of list || []) {
    if (doc && o.doc) { if (o.doc === doc) return { hard: o }; continue; }
    if (!doc && !o.doc) return { hard: o };
    soft = soft || o;
  }
  return { soft };
}

/**
 * Revisa la lista de jugadores. Devuelve errores por jugador [{i, msg}], errores generales
 * y avisos para la organización (posibles homónimos que hay que verificar).
 * send = la inscripción se envía (o ya fue enviada) a revisión: exige el mínimo.
 */
function checkPlayers(players, { cfg, idx, bans, reg, send }) {
  const errors = [], general = [], flags = [];
  const seen = new Map(), seenNum = new Map(), seenDoc = new Map();
  const bi = banIndex(bans, reg.tor);
  const approved = new Map((reg.approvedPlayers || []).map((p) => [norm(p.name), p]));
  players.forEach((p, i) => {
    const n = norm(p.name), doc = normDoc(p.doc);
    let msg = '';
    const twin = clash(seen.get(n), doc).hard;
    if (!validPersonName(p.name)) msg = 'Escriba nombre y apellido (solo letras)';
    else if (p.num !== '' && !(/^\d{1,2}$/.test(p.num))) msg = 'El número de camisa debe ser de 0 a 99';
    else if (doc === null) msg = 'Documento no válido: DUI (00000000-0) o número de carné';
    else if (twin) msg = `Repetido con el jugador ${twin.label}${doc ? '' : ' (si es otra persona, escriba el DUI o carné de ambos)'}`;
    else if (doc && seenDoc.has(doc)) msg = `Documento repetido con el jugador ${seenDoc.get(doc) + 1}`;
    else if (p.num !== '' && seenNum.has(String(+p.num))) msg = `El número ${+p.num} ya lo usa el jugador ${seenNum.get(String(+p.num)) + 1}`;
    else {
      const b = clash(bi.names.get(n), doc), bd = doc && bi.docs.get(doc);
      const o = clash(idx.names.get(n), doc), od = doc && idx.docs.get(doc);
      if (bd || b.hard) msg = `Fue dado de baja de ${bd || b.hard.label} y no puede volver a inscribirse en ningún equipo`;
      else if (od) msg = `Ese documento ya está inscrito en ${od}`;
      else if (o.hard) msg = doc ? `Ya está inscrito en ${o.hard.label}`
        : `Ya hay un jugador con este nombre en ${o.hard.label}. Si es la misma persona, debe decidir en cuál equipo jugará; si es otra persona, escriba su DUI o carné para diferenciarlo`;
      else if (approved.has(n) && String(approved.get(n).num || '') !== String(p.num === '' ? '' : +p.num)) msg = `Ya aprobado con el número ${approved.get(n).num || 'sin número'}: debe usar el mismo número todo el campeonato`;
      else {
        if (b.soft) flags.push({ name: p.name, msg: `Mismo nombre que un jugador dado de baja de ${b.soft.label}. Verifique con el documento que sea otra persona.` });
        if (o.soft) flags.push({ name: p.name, msg: `Mismo nombre que un jugador de ${o.soft.label}. Verifique con el DUI o carné que sean personas distintas.` });
      }
    }
    if (!msg) {
      if (!seen.has(n)) seen.set(n, []);
      seen.get(n).push({ label: String(i + 1), doc });
      if (p.num !== '') seenNum.set(String(+p.num), i);
      if (doc) seenDoc.set(doc, i);
    }
    if (msg) errors.push({ i, msg });
  });
  // Un jugador aprobado no se borra de la lista: se le da de baja (con motivo) y queda intransferible.
  const now = new Set(players.map((p) => norm(p.name)));
  const gone = new Set((reg.bajas || []).map((b) => norm(b.name)));
  for (const [n, p] of approved) if (!now.has(n) && !gone.has(n)) general.push(`Para quitar a ${p.name} use “Dar de baja” e indique el motivo`);
  if (players.length > cfg.max) general.push(`Máximo ${cfg.max} jugadores por equipo (hay ${players.length})`);
  if (send && players.length < cfg.min) general.push(`Se requieren al menos ${cfg.min} jugadores (hay ${players.length})`);
  return { errors, general, flags };
}

/** Avisos para la organización: conflictos (hard) y posibles homónimos por verificar. */
function regWarn(reg, data, regs, bans) {
  if (reg.status === 'rechazada') return [];
  const cat = data && data.torneos && data.torneos[reg.tor] && data.torneos[reg.tor].cats[reg.cat];
  const chk = checkPlayers(reg.players || [], { cfg: inscCfg(cat), idx: playerIndex(data, regs, reg), bans, reg, send: false });
  return chk.errors.map((e) => ({ name: reg.players[e.i].name, msg: e.msg, hard: true })).concat(chk.flags.map((f) => ({ ...f, hard: false })));
}
async function withWarnings(reg) {
  const [data, regs, bans] = await Promise.all([loadData(), allRegs(), allBans()]);
  return { ...publicReg(reg), warn: regWarn(reg, data, regs, bans) };
}

function teamNameTaken(name, data, regs, reg) {
  const n = norm(name);
  const cat = data && data.torneos && data.torneos[reg.tor] && data.torneos[reg.tor].cats[reg.cat];
  if (cat && (cat.teams || []).some((t) => t.id !== reg.teamId && norm(t.name) === n)) return true;
  return regs.some((r) => r.id !== reg.id && r.tor === reg.tor && r.cat === reg.cat && r.status !== 'rechazada' && norm(r.name) === n);
}

/* ---------------- Rutas ---------------- */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return fail(res, 501, 'Base de datos no configurada');
  if (req.method !== 'POST') return fail(res, 405, 'Método no permitido');

  try {
    const b = readBody(req);
    const action = b.action;

    /* ---- Capitán: revisar su invitación (solo dice para qué categoría es) ---- */
    if (action === 'checkInvite') {
      const inv = await getInv(b.invite);
      if (!inv) { await sleep(800); return fail(res, 404, 'Código de invitación no válido. Revise el enlace que le enviaron.'); }
      const data = await loadData();
      const cat = data && data.torneos && data.torneos[inv.tor] && data.torneos[inv.tor].cats[inv.cat];
      const cfg = inscCfg(cat), w = windows(cfg);
      return res.status(200).json({ invite: inv.code, tor: inv.tor, cat: inv.cat, catName: cat ? cat.name : '', label: inv.label, used: !!inv.usedBy, open: w.regOpen, until: cfg.until });
    }

    /* ---- Capitán: crear inscripción (solo con invitación de la organización) ---- */
    if (action === 'create') {
      return await withLock(async () => {
        const inv = await getInv(b.invite);
        if (!inv) { await sleep(800); return fail(res, 403, 'Se necesita una invitación válida de la organización para inscribir un equipo'); }
        if (inv.usedBy) return fail(res, 409, 'Esta invitación ya fue usada. Ingrese con el código de su equipo y su clave.');
        b.tor = inv.tor; b.cat = inv.cat;
        const data = await loadData();
        const tor = data && data.torneos && data.torneos[b.tor];
        const cat = tor && tor.cats && tor.cats[b.cat];
        if (!cat) return fail(res, 404, 'Categoría no encontrada');
        const cfg = inscCfg(cat);
        if (!windows(cfg).regOpen) return fail(res, 403, cfg.open ? 'El plazo de inscripción ya cerró' : 'La inscripción en línea de esta categoría no está habilitada');
        const name = clean(b.name, 40), rep = cleanRep(b.rep);
        if (!validTeamName(name)) return fail(res, 400, 'Escriba el nombre del equipo (2 a 40 letras)');
        if (!validPersonName(rep.name)) return fail(res, 400, 'Escriba nombre y apellido del representante');
        if (!validPhone(rep.phone)) return fail(res, 400, 'Escriba un teléfono válido del representante');
        if (typeof b.pass !== 'string' || b.pass.length < 6 || b.pass.length > 60) return fail(res, 400, 'La clave debe tener al menos 6 caracteres');
        const regs = await allRegs();
        if (regs.filter((r) => r.tor === b.tor).length >= MAX_REGS) return fail(res, 429, 'Se alcanzó el máximo de inscripciones');
        const reg = {
          id: newCode(new Set(regs.map((r) => r.id))), tor: b.tor, cat: b.cat, name, rep, rep2: { name: '', phone: '' },
          crest: cleanCrest(b.crest), colors: '', players: [], bajas: [], status: 'borrador',
          createdAt: Date.now(), updatedAt: Date.now(), pass: hashPass(b.pass), pv: 1, log: [], invite: inv.code,
        };
        if (teamNameTaken(name, data, regs, reg)) return fail(res, 409, `Ya existe un equipo llamado "${name}" en ${cat.name}`);
        addLog(reg, 'capitán', 'creada', `Inscripción creada por ${rep.name} (invitación ${inv.label})`);
        await putReg(reg);
        const used = { ...inv, usedBy: reg.id, usedAt: Date.now(), team: name };
        delete used.code;
        await redis(['HSET', K_INV, inv.code, JSON.stringify(used)]);
        return res.status(200).json({ reg: publicReg(reg), token: await signData({ k: 'cap', id: reg.id, v: reg.pv }, 120) });
      });
    }

    /* ---- Capitán: ingresar con código y clave ---- */
    if (action === 'login') {
      const id = String(b.id || '').trim().toUpperCase();
      const raw = id ? await redis(['HGET', K_INSC, id]) : null;
      const reg = raw ? JSON.parse(raw) : null;
      if (!reg || !checkPass(b.pass || '', reg.pass)) { await sleep(800); return fail(res, 401, 'Código o clave incorrectos'); }
      return res.status(200).json({ reg: publicReg(reg), token: await signData({ k: 'cap', id: reg.id, v: reg.pv }, 120) });
    }

    /* ---- Capitán: acciones con sesión ---- */
    if (['get', 'save', 'baja'].includes(action)) {
      const tk = await verifyData(req);
      if (!tk || tk.k !== 'cap') return fail(res, 401, 'Sesión de capitán no válida');
      return await withLock(async () => {
        const raw = await redis(['HGET', K_INSC, tk.id]);
        const reg = raw ? JSON.parse(raw) : null;
        if (!reg || reg.pv !== tk.v) return fail(res, 401, 'La sesión terminó. Ingrese de nuevo con su código y clave.');
        if (action === 'get') return res.status(200).json({ reg: publicReg(reg) });

        const data = await loadData();
        const cat = data && data.torneos && data.torneos[reg.tor] && data.torneos[reg.tor].cats[reg.cat];
        if (!cat) return fail(res, 404, 'La categoría ya no existe');
        const cfg = inscCfg(cat), win = windows(cfg);
        if (reg.status === 'rechazada') return fail(res, 403, 'Esta inscripción fue rechazada. Comuníquese con la organización.');
        const [regs, bans] = await Promise.all([allRegs(), allBans()]);

        if (action === 'baja') {
          const n = norm(b.name);
          const p = (reg.players || []).find((x) => norm(x.name) === n);
          if (!p) return fail(res, 404, 'Ese jugador no está en la lista');
          if (!(reg.approvedPlayers || []).some((x) => norm(x.name) === n)) return fail(res, 400, 'Este jugador aún no fue aprobado: puede quitarlo de la lista sin darle de baja');
          if (!win.chOpen) return fail(res, 403, 'El plazo para altas y bajas de jugadores ya cerró');
          const reason = clean(b.reason, 200);
          if (reason.length < 10) return fail(res, 400, 'Explique el motivo de la baja (al menos 10 letras)');
          reg.players = reg.players.filter((x) => norm(x.name) !== n);
          reg.bajas = (reg.bajas || []).concat({ name: p.name, num: p.num, doc: p.doc || '', reason, at: Date.now() });
          await redis(['HSET', K_BANS, `${reg.tor}|${n}`, JSON.stringify({ tor: reg.tor, name: p.name, doc: p.doc || '', team: reg.name, cat: cat.name, reason, at: Date.now(), insc: reg.id })]);
          if (reg.status === 'aprobada') reg.status = 'enviada';
          reg.updatedAt = Date.now();
          addLog(reg, 'capitán', 'baja', `${p.name}: ${reason}`);
          await putReg(reg);
          return res.status(200).json({ reg: publicReg(reg) });
        }

        // save: guardar borrador o enviar a revisión
        const sent = !!reg.sentAt;
        const send = !!b.send || sent;
        const fullEdit = reg.status === 'observada' || win.regOpen;
        if (!fullEdit && !(sent && win.chOpen)) return fail(res, 403, sent ? 'El plazo para altas y bajas de jugadores ya cerró' : 'El plazo de inscripción ya cerró');

        const next = {
          name: fullEdit ? clean(b.name, 40) : reg.name,
          rep: cleanRep(b.rep), rep2: cleanRep(b.rep2),
          crest: cleanCrest(b.crest), colors: clean(b.colors, 60),
          players: cleanPlayers(b.players),
        };
        const general = [];
        if (!validTeamName(next.name)) general.push('Escriba el nombre del equipo (2 a 40 letras)');
        else if (teamNameTaken(next.name, data, regs, reg)) general.push(`Ya existe un equipo llamado "${next.name}" en ${cat.name}`);
        if (!validPersonName(next.rep.name) || !validPhone(next.rep.phone)) general.push('Complete nombre y teléfono del representante propietario');
        if (send) {
          if (!validPersonName(next.rep2.name) || !validPhone(next.rep2.phone)) general.push('Complete nombre y teléfono del representante suplente');
          else if (norm(next.rep2.name) === norm(next.rep.name)) general.push('El suplente debe ser una persona distinta al representante propietario');
          if (!next.crest) general.push('Agregue el logo o escudo del equipo');
          if (next.colors.length < 3) general.push('Indique los colores del uniforme');
          if (!sent && !b.accept) general.push('Debe confirmar que los jugadores pertenecen o residen permanentemente en el municipio y que acepta el reglamento');
        }
        const idx = playerIndex(data, regs, reg);
        const chk = checkPlayers(next.players, { cfg, idx, bans, reg, send });
        general.push(...chk.general);
        if (general.length || chk.errors.length) return fail(res, 422, general[0] || 'Hay jugadores con errores (marcados en rojo)', { errors: chk.errors, general });

        next.players = next.players.map((p) => ({ name: p.name, num: p.num === '' ? '' : String(+p.num), doc: normDoc(p.doc) || '' }));
        const changed = JSON.stringify(next) !== JSON.stringify({ name: reg.name, rep: reg.rep, rep2: reg.rep2, crest: reg.crest, colors: reg.colors, players: reg.players });
        const before = new Set((reg.players || []).map((p) => norm(p.name)));
        const added = next.players.filter((p) => !before.has(norm(p.name))).map((p) => p.name);
        Object.assign(reg, next, { updatedAt: Date.now() });
        if (!sent && b.send) {
          reg.sentAt = Date.now(); reg.status = 'enviada';
          addLog(reg, 'capitán', 'enviada', `Enviada con ${reg.players.length} jugadores`);
        } else if (changed || (b.send && reg.status === 'observada')) {
          // Cualquier cambio a una inscripción ya enviada (o aprobada) vuelve a revisión de la organización
          if (sent) reg.status = 'enviada';
          addLog(reg, 'capitán', 'cambio', added.length ? 'Altas: ' + added.join(', ') : changed ? 'Datos actualizados' : 'Reenviada para revisión');
        }
        await putReg(reg);
        return res.status(200).json({ reg: publicReg(reg) });
      });
    }

    /* ---- Organizadores ---- */
    const me = await verify(req);
    if (!me) return fail(res, 401, 'Debe ingresar como organizador');

    if (action === 'list') {
      const [regs, bans, invites] = await Promise.all([allRegs(), allBans(), allInvites()]);
      const data = await loadData();
      return res.status(200).json({ regs: regs.map((r) => ({ ...publicReg(r), warn: regWarn(r, data, regs, bans) })).sort((a, z) => (z.updatedAt || 0) - (a.updatedAt || 0)), bans, invites });
    }

    /* Invitación personal para un capitán: un solo uso y para una categoría */
    if (action === 'invite') {
      const data = await loadData();
      const cat = data && data.torneos && data.torneos[b.tor] && data.torneos[b.tor].cats[b.cat];
      if (!cat) return fail(res, 404, 'Categoría no encontrada');
      const label = clean(b.label, 60);
      if (label.length < 3) return fail(res, 400, 'Escriba a quién va dirigida la invitación (capitán o equipo)');
      const existing = new Set((await allInvites()).map((i) => i.code));
      if (existing.size >= 500) return fail(res, 429, 'Demasiadas invitaciones');
      const code = newCode(existing, 8);
      const inv = { tor: b.tor, cat: b.cat, label, createdAt: Date.now(), by: me, usedBy: null };
      await redis(['HSET', K_INV, code, JSON.stringify(inv)]);
      return res.status(200).json({ invite: { code, ...inv } });
    }

    if (action === 'invDel') {
      const inv = await getInv(b.code);
      if (!inv) return fail(res, 404, 'Invitación no encontrada');
      if (inv.usedBy) return fail(res, 409, 'Esta invitación ya fue usada; elimine la inscripción si es necesario');
      await redis(['HDEL', K_INV, inv.code]);
      return res.status(200).json({ ok: true });
    }

    if (action === 'review') {
      return await withLock(async () => {
        const raw = await redis(['HGET', K_INSC, String(b.id || '')]);
        const reg = raw ? JSON.parse(raw) : null;
        if (!reg) return fail(res, 404, 'Inscripción no encontrada');
        const note = clean(b.note, 500);
        if (b.status === 'aprobada') {
          if (!reg.sentAt) return fail(res, 400, 'El capitán aún no ha enviado la inscripción');
          if (!/^[a-z0-9]{4,30}$/.test(String(b.teamId || ''))) return fail(res, 400, 'Equipo no válido');
          const data = await loadData();
          const cat = data && data.torneos && data.torneos[reg.tor] && data.torneos[reg.tor].cats[reg.cat];
          const cfg = inscCfg(cat);
          if (reg.players.length < cfg.min || reg.players.length > cfg.max) return fail(res, 400, `El equipo debe tener entre ${cfg.min} y ${cfg.max} jugadores (tiene ${reg.players.length})`);
          const [regs, bans] = await Promise.all([allRegs(), allBans()]);
          const hard = regWarn(reg, data, regs, bans).filter((w) => w.hard);
          if (hard.length) return fail(res, 409, `${hard[0].name}: ${hard[0].msg}`);
          reg.teamId = b.teamId;
          reg.approvedPlayers = JSON.parse(JSON.stringify(reg.players));
          reg.approvedAt = Date.now();
          reg.status = 'aprobada';
          addLog(reg, me, 'aprobada', note);
        } else if (b.status === 'observada' || b.status === 'rechazada') {
          if (note.length < 5) return fail(res, 400, 'Escriba la observación o el motivo para el capitán');
          if (b.status === 'rechazada' && reg.approvedAt) return fail(res, 400, 'El equipo ya fue aprobado: use “Observar” para pedir correcciones');
          reg.status = b.status;
          addLog(reg, me, b.status, note);
        } else return fail(res, 400, 'Estado no válido');
        reg.updatedAt = Date.now();
        await putReg(reg);
        return res.status(200).json({ reg: await withWarnings(reg) });
      });
    }

    /* El organizador editó (o eliminó) en el torneo un equipo que vino de la inscripción en línea:
       se copia a la inscripción para que el capitán vea lo mismo. */
    if (action === 'adminSync') {
      return await withLock(async () => {
        const raw = await redis(['HGET', K_INSC, String(b.id || '')]);
        const reg = raw ? JSON.parse(raw) : null;
        if (!reg) return fail(res, 404, 'Inscripción no encontrada');
        if (b.remove) {
          Object.assign(reg, { status: 'rechazada', approvedAt: null, teamId: null, approvedPlayers: [], updatedAt: Date.now() });
          addLog(reg, me, 'eliminado', 'La organización eliminó el equipo del torneo');
          await putReg(reg);
          return res.status(200).json({ reg: publicReg(reg) });
        }
        if (reg.approvedAt && (reg.status === 'enviada' || reg.status === 'observada')) return fail(res, 409, 'El capitán tiene cambios pendientes de revisión. Apruébelos u obsérvelos antes de editar el equipo.');
        if (reg.status !== 'aprobada') return fail(res, 409, 'Esta inscripción no está aprobada');
        const docs = new Map([...(reg.approvedPlayers || []), ...(reg.players || [])].map((p) => [norm(p.name), p.doc || '']));
        const nums = new Map((reg.players || []).map((p) => [norm(p.name), p.num]));
        const players = cleanPlayers(b.players).map((p) => ({ name: p.name, num: /^\d{1,2}$/.test(p.num) ? String(+p.num) : '', doc: docs.get(norm(p.name)) || '' }));
        const after = new Set(players.map((p) => norm(p.name))), before = new Set(reg.players.map((p) => norm(p.name)));
        const added = players.filter((p) => !before.has(norm(p.name))).map((p) => p.name);
        const removed = reg.players.filter((p) => !after.has(norm(p.name)));
        const renum = players.filter((p) => nums.has(norm(p.name)) && nums.get(norm(p.name)) !== p.num).map((p) => `${p.name} → ${p.num || 'sin número'}`);
        const reason = clean(b.baja, 200);
        if (b.baja != null && reason.length < 10) return fail(res, 400, 'Explique el motivo de la baja (al menos 10 letras)');
        const data = await loadData();
        const catName = (data && data.torneos && data.torneos[reg.tor] && data.torneos[reg.tor].cats[reg.cat] || {}).name || '';
        for (const p of removed) {
          if (!reason) continue;
          reg.bajas = (reg.bajas || []).concat({ name: p.name, num: p.num, doc: p.doc || '', reason, at: Date.now(), by: me });
          await redis(['HSET', K_BANS, `${reg.tor}|${norm(p.name)}`, JSON.stringify({ tor: reg.tor, name: p.name, doc: p.doc || '', team: reg.name, cat: catName, reason, at: Date.now(), insc: reg.id })]);
        }
        // Si el organizador vuelve a poner a un jugador dado de baja, lo está habilitando a propósito
        const unbanned = [];
        for (const p of added) {
          const key = `${reg.tor}|${norm(p)}`;
          if (Number(await redis(['HDEL', K_BANS, key])) === 1) unbanned.push(p);
        }
        const name = clean(b.name, 40);
        const parts = [];
        if (validTeamName(name) && name !== reg.name) { parts.push(`Nombre: ${reg.name} → ${name}`); reg.name = name; }
        if (b.crest !== undefined && JSON.stringify(cleanCrest(b.crest)) !== JSON.stringify(reg.crest)) { reg.crest = cleanCrest(b.crest); parts.push('Escudo actualizado'); }
        if (added.length) parts.push('Altas: ' + added.join(', '));
        if (unbanned.length) parts.push('Habilitados de nuevo: ' + unbanned.join(', '));
        if (removed.length) parts.push((reason ? 'Bajas: ' : 'Quitados (corrección): ') + removed.map((p) => p.name).join(', ') + (reason ? ` · ${reason}` : ''));
        if (renum.length) parts.push('Números: ' + renum.join(', '));
        reg.players = players;
        reg.approvedPlayers = JSON.parse(JSON.stringify(players));
        reg.updatedAt = Date.now();
        if (parts.length) addLog(reg, me, 'editado', parts.join(' · '));
        await putReg(reg);
        return res.status(200).json({ reg: await withWarnings(reg) });
      });
    }

    if (action === 'resetPin') {
      if (typeof b.pass !== 'string' || b.pass.length < 6) return fail(res, 400, 'La clave debe tener al menos 6 caracteres');
      return await withLock(async () => {
        const raw = await redis(['HGET', K_INSC, String(b.id || '')]);
        if (!raw) return fail(res, 404, 'Inscripción no encontrada');
        const reg = JSON.parse(raw);
        reg.pass = hashPass(b.pass); reg.pv = (reg.pv || 1) + 1;
        addLog(reg, me, 'clave', 'Clave del capitán restablecida');
        await putReg(reg);
        return res.status(200).json({ reg: publicReg(reg) });
      });
    }

    if (action === 'unban') {
      await redis(['HDEL', K_BANS, String(b.key || '')]);
      return res.status(200).json({ ok: true });
    }

    if (action === 'remove') {
      await redis(['HDEL', K_INSC, String(b.id || '')]);
      return res.status(200).json({ ok: true });
    }

    return fail(res, 400, 'Acción no válida');
  } catch (e) {
    return fail(res, 500, String((e && e.message) || e));
  }
};
