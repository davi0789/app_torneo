// Acceso de organizadores: crear la primera cuenta, ingresar y administrar organizadores.
const { configured, redis, hashPass, checkPass, signToken, verify, readBody, USERS } = require('./_lib');

const cleanUser = (u) => String(u || '').trim().toLowerCase();
const validUser = (u) => /^[a-z0-9._-]{3,30}$/.test(u);
const validPass = (p) => typeof p === 'string' && p.length >= 6 && p.length <= 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Crea el primer usuario solo si aún no existe ninguno (atómico).
const SETUP = `
if redis.call('HLEN', KEYS[1]) > 0 then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return 1`;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return res.status(501).json({ error: 'Base de datos no configurada' });

  try {
    if (req.method === 'GET') {
      const n = Number(await redis(['HLEN', USERS]));
      return res.status(200).json({ setup: n === 0 });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

    const b = readBody(req);
    const action = b.action;
    const user = cleanUser(b.user);

    if (action === 'setup' || action === 'login') {
      if (action === 'setup') {
        if (!validUser(user)) return res.status(400).json({ error: 'Usuario: 3 a 30 letras o números, sin espacios' });
        if (!validPass(b.pass)) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
        const ok = Number(await redis(['EVAL', SETUP, '1', USERS, user, hashPass(b.pass)]));
        if (!ok) return res.status(409).json({ error: 'Ya existe un organizador. Use Ingresar.' });
      } else {
        const stored = user ? await redis(['HGET', USERS, user]) : null;
        if (!stored || !checkPass(b.pass || '', stored)) {
          await sleep(700);
          return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
        }
      }
      return res.status(200).json({ user, token: await signToken(user) });
    }

    // Acciones que requieren sesión
    const me = await verify(req);
    if (!me) return res.status(401).json({ error: 'Sesión no válida' });
    const list = async () => (await redis(['HKEYS', USERS])).sort();

    if (action === 'list') return res.status(200).json({ me, users: await list() });

    if (action === 'add') {
      if (!validUser(user)) return res.status(400).json({ error: 'Usuario: 3 a 30 letras o números, sin espacios' });
      if (!validPass(b.pass)) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
      const ok = Number(await redis(['HSETNX', USERS, user, hashPass(b.pass)]));
      if (!ok) return res.status(409).json({ error: 'Ese usuario ya existe' });
      return res.status(200).json({ me, users: await list() });
    }

    if (action === 'remove') {
      if (user === me) return res.status(400).json({ error: 'No puede eliminar su propio usuario' });
      await redis(['HDEL', USERS, user]);
      return res.status(200).json({ me, users: await list() });
    }

    if (action === 'password') {
      if (!validPass(b.pass)) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
      await redis(['HSET', USERS, me, hashPass(b.pass)]);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Acción no válida' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
