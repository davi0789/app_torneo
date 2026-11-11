// Estado del torneo. Lectura pública; guardar requiere sesión de organizador.
const { configured, redis, verify, readBody } = require('./_lib');

const K_REV = 'torneo:rev';
const K_DATA = 'torneo:data';

// Guardar solo si nadie más guardó antes (control de versiones atómico).
const CAS = `
local r = redis.call('GET', KEYS[1]) or '0'
if r ~= ARGV[1] then return {0, r} end
local n = tonumber(r) + 1
redis.call('SET', KEYS[1], tostring(n))
redis.call('SET', KEYS[2], ARGV[2])
return {1, tostring(n)}`;

async function readAll() {
  const [rev, data] = await redis(['MGET', K_REV, K_DATA]);
  return { rev: Number(rev || 0), data: data ? JSON.parse(data) : null };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return res.status(501).json({ error: 'Base de datos no configurada' });

  try {
    if (req.method === 'GET') {
      const since = req.query && req.query.since;
      if (since !== undefined) {
        const rev = Number((await redis(['GET', K_REV])) || 0);
        if (String(rev) === String(since)) return res.status(200).json({ rev, same: true });
      }
      return res.status(200).json(await readAll());
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      if (!(await verify(req))) return res.status(401).json({ error: 'Debe ingresar como organizador' });
      const body = readBody(req);
      const data = body.data;
      const cats = data && data.cats && typeof data.cats === 'object' ? Object.values(data.cats) : [];
      if (!cats.length || cats.length > 30 || !cats.every((t) => t && Array.isArray(t.teams) && Array.isArray(t.matches))) {
        return res.status(400).json({ error: 'Datos no válidos' });
      }
      const json = JSON.stringify(data);
      if (json.length > 900000) return res.status(413).json({ error: 'Datos demasiado grandes' });

      const [ok, rev] = await redis(['EVAL', CAS, '2', K_REV, K_DATA, String(Number(body.baseRev) || 0), json]);
      if (Number(ok) === 1) return res.status(200).json({ rev: Number(rev) });
      return res.status(409).json(await readAll());
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
