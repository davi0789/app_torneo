'use strict';
/* =========================================================
   Escudos de equipo: diseños vectoriales originales generados
   con forma + diseño + 2 colores + emblema. También admite
   una imagen subida (dataURL pequeña).
   ========================================================= */
const CREST_COLORS = [
  ['#dc2626', 'Rojo'], ['#7f1d1d', 'Vino'], ['#f97316', 'Naranja'], ['#facc15', 'Amarillo'],
  ['#ca8a04', 'Dorado'], ['#16a34a', 'Verde'], ['#065f46', 'Verde oscuro'], ['#0ea5e9', 'Celeste'],
  ['#1d4ed8', 'Azul'], ['#1e3a8a', 'Azul marino'], ['#7c3aed', 'Morado'], ['#db2777', 'Rosado'],
  ['#111827', 'Negro'], ['#6b7280', 'Gris'], ['#f8fafc', 'Blanco'],
];
const CREST_SHAPES = {
  clasico: ['Clásico', 'M50 4 L94 16 V58 C94 88 72 106 50 116 C28 106 6 88 6 58 V16 Z'],
  punta: ['Punta', 'M8 6 H92 V52 C92 84 70 104 50 116 C30 104 8 84 8 52 Z'],
  insignia: ['Insignia', 'M16 6 H84 L94 18 V78 L50 116 L6 78 V18 Z'],
  redondo: ['Redondo', 'M50 14 A46 46 0 1 1 49.9 14 Z'],
};
const CREST_PATTERNS = {
  liso: 'Liso', franjas: 'Franjas', mitad: 'Mitades', banda: 'Banda', aros: 'Aros', chevron: 'Chevrón', cuartos: 'Cuarteles',
};
const CREST_EMBLEMS = {
  balon: 'Balón', estrella: 'Estrella', rayo: 'Rayo', corona: 'Corona', llama: 'Llama', montana: 'Montaña', inicial: 'Iniciales', ninguno: 'Ninguno',
};

let crestSeq = 0;
const crestColor = (c, d) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : d);
const crestEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function crestPattern(p, c1, c2) {
  const bg = `<rect width="100" height="120" fill="${c1}"/>`;
  switch (p) {
    case 'franjas': return bg + [12.5, 37.5, 62.5, 87.5].map((x) => `<rect x="${x}" width="12.5" height="120" fill="${c2}"/>`).join('');
    case 'mitad': return bg + `<rect x="50" width="50" height="120" fill="${c2}"/>`;
    case 'banda': return bg + `<polygon points="-10,22 22,-10 112,96 80,128" fill="${c2}"/>`;
    case 'aros': return bg + [18, 50, 82].map((y) => `<rect y="${y}" width="100" height="16" fill="${c2}"/>`).join('');
    case 'chevron': return bg + `<polygon points="0,36 50,66 100,36 100,60 50,90 0,60" fill="${c2}"/>`;
    case 'cuartos': return bg + `<rect x="50" width="50" height="60" fill="${c2}"/><rect y="60" width="50" height="60" fill="${c2}"/>`;
    default: return bg;
  }
}

function starPoints(cx, cy, ro, ri) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 ? ri : ro;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(' ');
}
function pentagon(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(' ');
}

function crestEmblem(e, initials) {
  const st = 'fill="#fff" stroke="rgba(0,0,0,.6)" stroke-width="3" stroke-linejoin="round" paint-order="stroke"';
  switch (e) {
    case 'balon': return `<circle cx="50" cy="60" r="21" ${st}/><polygon points="${pentagon(50, 60, 8)}" fill="#111"/>`
      + [0, 1, 2, 3, 4].map((i) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5; return `<line x1="${(50 + 8 * Math.cos(a)).toFixed(1)}" y1="${(60 + 8 * Math.sin(a)).toFixed(1)}" x2="${(50 + 19 * Math.cos(a)).toFixed(1)}" y2="${(60 + 19 * Math.sin(a)).toFixed(1)}" stroke="#111" stroke-width="2"/>`; }).join('');
    case 'estrella': return `<polygon points="${starPoints(50, 60, 24, 10)}" ${st}/>`;
    case 'rayo': return `<polygon points="57,34 36,64 49,64 42,88 66,54 53,54 60,34" ${st}/>`;
    case 'corona': return `<polygon points="28,76 28,44 39,57 50,38 61,57 72,44 72,76" ${st}/><rect x="28" y="78" width="44" height="6" ${st}/>`;
    case 'llama': return `<path d="M50 34 C61 46 69 56 67 69 C65 81 57 88 50 88 C41 88 33 81 33 69 C33 60 39 53 44 47 C46 56 48 59 53 59 C53 50 51 43 50 34 Z" ${st}/>`;
    case 'montana': return `<polygon points="24,82 43,52 51,64 60,48 77,82" ${st}/>`;
    case 'inicial': {
      const t = crestEsc(String(initials || '').slice(0, 2).toUpperCase());
      return `<text x="50" y="72" text-anchor="middle" font-family="system-ui,Arial,sans-serif" font-weight="900" font-size="${t.length > 1 ? 30 : 38}" ${st}>${t}</text>`;
    }
    default: return '';
  }
}

function initialsOf(name) {
  const w = String(name || '').trim().split(/\s+/).filter((x) => x.length > 2 || /^[A-Z]/.test(x));
  if (!w.length) return String(name || '?').slice(0, 1);
  return w.length > 1 ? w[0][0] + w[1][0] : w[0].slice(0, 2);
}

/** Devuelve el HTML del escudo (svg o imagen) de alto `size`. */
function crestHTML(cr, name = '', size = 40) {
  if (!cr) return '';
  const w = Math.round((size * 100) / 120);
  if (cr.img) {
    if (!/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(cr.img)) return '';
    return `<img class="crest" src="${cr.img}" width="${size}" height="${size}" alt="" style="object-fit:contain">`;
  }
  const shape = (CREST_SHAPES[cr.s] || CREST_SHAPES.clasico)[1];
  const c1 = crestColor(cr.c1, '#1d4ed8'), c2 = crestColor(cr.c2, '#f8fafc');
  const id = 'cr' + (++crestSeq);
  return `<svg class="crest" width="${w}" height="${size}" viewBox="0 0 100 120" aria-hidden="true">
    <defs><clipPath id="${id}"><path d="${shape}"/></clipPath></defs>
    <g clip-path="url(#${id})">${crestPattern(cr.p, c1, c2)}</g>
    ${crestEmblem(cr.e, initialsOf(name))}
    <path d="${shape}" fill="none" stroke="rgba(0,0,0,.55)" stroke-width="3"/></svg>`;
}

const CREST_PRESETS = (() => {
  const shapes = Object.keys(CREST_SHAPES), pats = Object.keys(CREST_PATTERNS), ems = Object.keys(CREST_EMBLEMS).slice(0, 7);
  const combos = [[0, 14], [8, 3], [5, 14], [12, 4], [10, 3], [2, 12], [1, 4], [7, 14], [9, 0], [3, 12], [11, 14], [6, 3],
    [13, 0], [0, 12], [8, 14], [4, 9], [14, 8], [12, 0], [5, 3], [9, 4], [1, 14], [7, 9], [10, 14], [2, 9]];
  return combos.map(([a, b], i) => ({ s: shapes[i % 4], p: pats[(i * 3) % 7], c1: CREST_COLORS[a][0], c2: CREST_COLORS[b][0], e: ems[i % 7] }));
})();

function randomCrest() {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const c1 = pick(CREST_COLORS)[0];
  let c2 = pick(CREST_COLORS)[0];
  while (c2 === c1) c2 = pick(CREST_COLORS)[0];
  return {
    s: pick(Object.keys(CREST_SHAPES)), p: pick(Object.keys(CREST_PATTERNS)),
    c1, c2, e: pick(Object.keys(CREST_EMBLEMS).slice(0, 7)),
  };
}

/** Reduce una imagen subida a 96x96 y la devuelve como dataURL. */
function crestFromFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const S = 96, c = document.createElement('canvas');
      c.width = S; c.height = S;
      const g = c.getContext('2d');
      const k = Math.min(S / img.width, S / img.height);
      const w = img.width * k, h = img.height * k;
      g.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
      URL.revokeObjectURL(url);
      let d = c.toDataURL('image/webp', 0.82);
      if (!d.startsWith('data:image/webp')) d = c.toDataURL('image/png');
      if (d.length > 40000) d = c.toDataURL('image/jpeg', 0.8);
      resolve(d);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('imagen')); };
    img.src = url;
  });
}
