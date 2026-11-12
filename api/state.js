// Estado del torneo. Lectura pública; guardar requiere sesión de organizador.
// Cada guardado conserva la versión anterior en un historial (últimas 40) para poder restaurarla.
const { configured, redis, verify, readBody } = require('./_lib');

const K_REV = 'torneo:rev';
const K_DATA = 'torneo:data';
const K_HIST = 'torneo:hist';
const K_META = 'torneo:meta';
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

/** Resumen corto de una versión: equipos y partidos finalizados. */
function summary(data) {
  let teams = 0, done = 0, live = 0;
  for (const tor of Object.values((data && data.torneos) || {})) {
    for (const c of Object.values(tor.cats || {})) {
      teams += (c.teams || []).length;
      for (const m of c.matches || []) { if (m.status === 'done') done++; else if (m.status === 'live') live++; }
    }
  }
  return { teams, done, live };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return res.status(501).json({ error: 'Base de datos no configurada' });

  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      // Historial (solo organizadores)
      if (q.history !== undefined || q.version !== undefined) {
        if (!(await verify(req))) return res.status(401).json({ error: 'Debe ingresar como organizador' });
        if (q.version !== undefined) {
          const raw = await redis(['LINDEX', K_HIST, String(Number(q.version) || 0)]);
          if (!raw) return res.status(404).json({ error: 'Versión no encontrada' });
          return res.status(200).json(JSON.parse(raw));
        }
        const list = (await redis(['LRANGE', K_HIST, '0', String(HIST_MAX - 1)])) || [];
        return res.status(200).json({
          versions: list.map((raw, i) => {
            try { const v = JSON.parse(raw); return { i, rev: v.rev, at: v.meta && v.meta.at, by: v.meta && v.meta.by, ...summary(v.data) }; } catch (e) { return { i, error: true }; }
          }),
        });
      }
      const since = q.since;
      if (since !== undefined) {
        const rev = Number((await redis(['GET', K_REV])) || 0);
        if (String(rev) === String(since)) return res.status(200).json({ rev, same: true });
      }
      return res.status(200).json(await readAll());
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      const user = await verify(req);
      if (!user) return res.status(401).json({ error: 'Debe ingresar como organizador' });
      const body = readBody(req);
      const data = body.data;
      const tors = data && data.torneos && typeof data.torneos === 'object' ? Object.values(data.torneos) : [];
      const validCat = (t) => t && Array.isArray(t.teams) && Array.isArray(t.matches);
      const validTor = (tor) => tor && tor.cats && typeof tor.cats === 'object'
        && Object.values(tor.cats).length > 0 && Object.values(tor.cats).length <= 30 && Object.values(tor.cats).every(validCat);
      if (!tors.length || tors.length > 50 || !tors.every(validTor)) {
        return res.status(400).json({ error: 'Datos no válidos' });
      }
      const json = JSON.stringify(data);
      if (json.length > 900000) return res.status(413).json({ error: 'Datos demasiado grandes' });
      const meta = JSON.stringify({ at: Date.now(), by: user });

      const [ok, rev] = await redis(['EVAL', CAS, '4', K_REV, K_DATA, K_HIST, K_META, String(Number(body.baseRev) || 0), json, meta]);
      if (Number(ok) === 1) return res.status(200).json({ rev: Number(rev) });
      return res.status(409).json(await readAll());
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
