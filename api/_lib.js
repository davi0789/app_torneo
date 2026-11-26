// Utilidades compartidas por las funciones de /api (los archivos con _ no son rutas públicas).
const crypto = require('crypto');

const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const USERS = 'torneo:users';
const SECRET = 'torneo:secret';

const configured = () => !!(DB_URL && DB_TOKEN);

async function redis(cmd) {
  const r = await fetch(DB_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DB_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

let secretCache = null;
async function secret() {
  if (secretCache) return secretCache;
  let s = await redis(['GET', SECRET]);
  if (!s) {
    await redis(['SET', SECRET, crypto.randomBytes(32).toString('hex'), 'NX']);
    s = await redis(['GET', SECRET]);
  }
  secretCache = s;
  return s;
}

function hashPass(pass, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(String(pass), salt, 64).toString('hex');
}
function checkPass(pass, stored) {
  const [salt, h] = String(stored || '').split(':');
  if (!salt || !h) return false;
  const a = crypto.scryptSync(String(pass), salt, 64);
  const b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const DAYS = 30;
async function signToken(user) {
  const body = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + DAYS * 864e5 })).toString('base64url');
  const sig = crypto.createHmac('sha256', await secret()).update(body).digest('base64url');
  return body + '.' + sig;
}

/** Devuelve el usuario del token si es válido y el usuario sigue existiendo. */
async function verify(req) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [body, sig] = tok.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', await secret()).update(body).digest('base64url');
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  let d;
  try { d = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch (e) { return null; }
  if (!d.u || !d.exp || d.exp < Date.now()) return null;
  return Number(await redis(['HEXISTS', USERS, d.u])) === 1 ? d.u : null;
}

/** Firma un objeto cualquiera (tokens de capitanes). */
async function signData(obj, days = DAYS) {
  const body = Buffer.from(JSON.stringify({ ...obj, exp: Date.now() + days * 864e5 })).toString('base64url');
  const sig = crypto.createHmac('sha256', await secret()).update(body).digest('base64url');
  return body + '.' + sig;
}
/** Devuelve el objeto firmado si el token es válido y no venció (no consulta usuarios). */
async function verifyData(req) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [body, sig] = tok.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', await secret()).update(body).digest('base64url');
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try { const d = JSON.parse(Buffer.from(body, 'base64url').toString()); return d.exp > Date.now() ? d : null; } catch (e) { return null; }
}

function readBody(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
  return b || {};
}

/* ---------------- Roles ----------------
   torneo:roles guarda solo los roles distintos de organizador ('arbitro').
   Un usuario que no aparece ahí es organizador (así los usuarios que ya existían no cambian). */
const ROLES = 'torneo:roles';
const ROLE_NAMES = ['admin', 'arbitro'];
async function roleOf(user) { return (user && (await redis(['HGET', ROLES, user]))) || 'admin'; }
/** Usuario y rol de la sesión, o null. */
async function verifyRole(req) {
  const user = await verify(req);
  return user ? { user, role: await roleOf(user) } : null;
}
/** Solo organizadores. Responde 401/403 y devuelve null si no corresponde. */
async function requireAdmin(req, res) {
  const s = await verifyRole(req);
  if (!s) { res.status(401).json({ error: 'Debe ingresar como organizador' }); return null; }
  if (s.role !== 'admin') { res.status(403).json({ error: 'Su usuario es de árbitro: no tiene permiso para esta acción' }); return null; }
  return s.user;
}

/* ---------------- Datos del torneo con control de versiones ---------------- */
const K_REV = 'torneo:rev', K_DATA = 'torneo:data', K_HIST = 'torneo:hist', K_META = 'torneo:meta';
const HIST_MAX = 40;
// Guardar solo si nadie más guardó antes (control de versiones atómico) y respaldar la versión anterior.
const CAS = `
local r = redis.call('GET', KEYS[1]) or '0'
if r ~= ARGV[1] then return {0, r} end
local old = redis.call('GET', KEYS[2])
if old then
  local meta = redis.call('GET', KEYS[4]) or '{}'
  redis.call('LPUSH', KEYS[3], '{"rev":' .. r .. ',"meta":' .. meta .. ',"data":' .. old .. '}')
  redis.call('LTRIM', KEYS[3], 0, ${HIST_MAX - 1})
end
local n = tonumber(r) + 1
redis.call('SET', KEYS[1], tostring(n))
redis.call('SET', KEYS[2], ARGV[2])
redis.call('SET', KEYS[4], ARGV[3])
return {1, tostring(n)}`;
async function readAll() {
  const [rev, data] = await redis(['MGET', K_REV, K_DATA]);
  return { rev: Number(rev || 0), data: data ? JSON.parse(data) : null };
}
/** Guarda si la versión sigue siendo baseRev. Devuelve {ok, rev}. */
async function casWrite(baseRev, json, meta) {
  const [ok, rev] = await redis(['EVAL', CAS, '4', K_REV, K_DATA, K_HIST, K_META, String(Number(baseRev) || 0), json, JSON.stringify(meta)]);
  return { ok: Number(ok) === 1, rev: Number(rev) };
}

module.exports = {
  configured, redis, hashPass, checkPass, signToken, verify, signData, verifyData, readBody, USERS,
  ROLES, ROLE_NAMES, roleOf, verifyRole, requireAdmin,
  K_REV, K_DATA, K_HIST, K_META, HIST_MAX, readAll, casWrite,
};
