// Estado del torneo. Lectura pública; guardar requiere sesión de organizador (los árbitros usan /api/match).
// Cada guardado conserva la versión anterior en un historial (últimas 40) para poder restaurarla.
const { configured, redis, requireAdmin, readBody, K_REV, K_HIST, HIST_MAX, readAll, casWrite } = require('./_lib');

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
        if (!(await requireAdmin(req, res))) return;
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
      // Solo organizadores: un árbitro no puede reemplazar el torneo completo
      const user = await requireAdmin(req, res);
      if (!user) return;
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

      const w = await casWrite(body.baseRev, json, { at: Date.now(), by: user });
      if (w.ok) return res.status(200).json({ rev: w.rev });
      return res.status(409).json(await readAll());
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
