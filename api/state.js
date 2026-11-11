// API única del torneo: guarda todo el estado en Upstash Redis (Vercel Storage).
// Variables de entorno (las crea Vercel al conectar Upstash):
//   KV_REST_API_URL / KV_REST_API_TOKEN   (o UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)
// Opcional: ADMIN_PIN -> si se define, solo quien tenga el PIN puede guardar cambios.

const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const PIN = process.env.ADMIN_PIN || '';
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

async function readAll() {
  const [rev, data] = await redis(['MGET', K_REV, K_DATA]);
  return { rev: Number(rev || 0), data: data ? JSON.parse(data) : null };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!DB_URL || !DB_TOKEN) return res.status(501).json({ error: 'Base de datos no configurada' });

  try {
    if (req.method === 'GET') {
      const since = req.query && req.query.since;
      if (since !== undefined) {
        const rev = Number((await redis(['GET', K_REV])) || 0);
        if (String(rev) === String(since)) return res.status(200).json({ rev, same: true });
      }
      const all = await readAll();
      return res.status(200).json({ ...all, pin: !!PIN });
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      if (PIN && req.headers['x-pin'] !== PIN) return res.status(401).json({ error: 'PIN incorrecto' });
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body);
      const data = body && body.data;
      if (!data || !data.cats || typeof data.cats.M !== 'object' || typeof data.cats.F !== 'object') {
        return res.status(400).json({ error: 'Datos no válidos' });
      }
      const json = JSON.stringify(data);
      if (json.length > 900000) return res.status(413).json({ error: 'Datos demasiado grandes' });

      const [ok, rev] = await redis(['EVAL', CAS, '2', K_REV, K_DATA, String(Number(body.baseRev) || 0), json]);
      if (Number(ok) === 1) return res.status(200).json({ rev: Number(rev) });
      // Otro dispositivo guardó antes: devolver lo actual para combinar.
      return res.status(409).json(await readAll());
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
