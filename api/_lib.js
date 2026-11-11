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

function readBody(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
  return b || {};
}

module.exports = { configured, redis, hashPass, checkPass, signToken, verify, readBody, USERS };
