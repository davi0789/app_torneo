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
  balon: 'Balón', aguila: 'Águila', leon: 'León', jaguar: 'Jaguar', lobo: 'Lobo', toro: 'Toro', caballo: 'Caballo',
  paloma: 'Paloma', tiburon: 'Tiburón', mariposa: 'Mariposa', flor: 'Flor', corazon: 'Corazón', pino: 'Pino',
  montana: 'Montaña', sol: 'Sol', luna: 'Luna', estrella: 'Estrella', estrellas: '3 estrellas', rayo: 'Rayo',
  llama: 'Llama', corona: 'Corona', trofeo: 'Trofeo', bota: 'Botín', alas: 'Balón alado',
  inicial: 'Iniciales', ninguno: 'Ninguno',
};
/** Figuras (sin iniciales ni "ninguno"), para escudos al azar e ideas. */
const CREST_FIGURES = Object.keys(CREST_EMBLEMS).filter((k) => k !== 'inicial' && k !== 'ninguno');

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

function crestEmblem(e, initials, ce) {
  const fill = crestColor(ce, '#ffffff');
  const st = `fill="${fill}" stroke="rgba(0,0,0,.6)" stroke-width="3" stroke-linejoin="round" paint-order="stroke"`;
  const dk = 'fill="rgba(0,0,0,.72)"';
  const mirror = (d) => `<path d="${d}" ${st}/><path d="${d}" transform="translate(100 0) scale(-1 1)" ${st}/>`;
  switch (e) {
    case 'aguila': return mirror('M50 37 C46 37 44 41 45 46 L43 51 C35 44 25 36 13 28 C16 37 20 43 25 48 C19 47 15 46 10 46 C15 52 21 56 29 58 C23 59 19 61 15 64 C23 67 32 67 40 65 L42 72 C38 76 36 80 36 87 L44 81 L50 85 Z')
      + `<polygon points="50,44 47,48 50,52 53,48" fill="#f59e0b" stroke="rgba(0,0,0,.6)" stroke-width="1.5"/><circle cx="47.5" cy="42.5" r="1.4" ${dk}/><circle cx="52.5" cy="42.5" r="1.4" ${dk}/>`;
    case 'leon': return `<polygon points="${starPoints(50, 62, 28, 21)}" ${st}/><polygon points="${starPoints(50, 62, 26, 20)}" transform="rotate(18 50 62)" ${st}/>`
      + `<circle cx="50" cy="63" r="15" ${st}/><circle cx="50" cy="63" r="15" fill="rgba(0,0,0,.12)"/>`
      + `<circle cx="44.5" cy="59" r="2" ${dk}/><circle cx="55.5" cy="59" r="2" ${dk}/><polygon points="46,65 54,65 50,70" ${dk}/>`
      + '<path d="M50 70 V73 M50 73 C47 76 44 75 43 73 M50 73 C53 76 56 75 57 73" stroke="rgba(0,0,0,.72)" stroke-width="1.8" fill="none" stroke-linecap="round"/>';
    case 'jaguar': return `<polygon points="31,50 34,34 45,45" ${st}/><polygon points="69,50 66,34 55,45" ${st}/><circle cx="50" cy="62" r="21" ${st}/>`
      + `<circle cx="38" cy="53" r="2" ${dk}/><circle cx="62" cy="53" r="2" ${dk}/><circle cx="35" cy="69" r="2" ${dk}/><circle cx="65" cy="69" r="2" ${dk}/><circle cx="50" cy="46" r="2" ${dk}/>`
      + `<path d="M40 60 Q44 56 47 60 Q44 62 40 60 Z M60 60 Q56 56 53 60 Q56 62 60 60 Z" ${dk}/><polygon points="46,67 54,67 50,72" ${dk}/>`
      + '<path d="M50 72 V75 M30 70 H42 M30 74 L42 72 M70 70 H58 M70 74 L58 72" stroke="rgba(0,0,0,.72)" stroke-width="1.5" fill="none" stroke-linecap="round"/>';
    case 'lobo': return `<path d="M28 34 L42 50 H58 L72 34 L72 60 L62 76 L54 88 H46 L38 76 L28 60 Z" ${st}/>`
      + `<path d="M50 56 L44 76 L50 88 L56 76 Z" fill="rgba(0,0,0,.12)"/><polygon points="36,58 46,61 43,64" ${dk}/><polygon points="64,58 54,61 57,64" ${dk}/><ellipse cx="50" cy="84" rx="4" ry="3" ${dk}/>`;
    case 'toro': return mirror('M40 52 C28 52 19 45 18 31 C25 40 32 43 41 45 Z')
      + `<path d="M38 48 C42 44 58 44 62 48 L61 70 C60 84 40 84 39 70 Z" ${st}/><ellipse cx="50" cy="76" rx="9" ry="6" fill="rgba(0,0,0,.15)"/>`
      + `<circle cx="45.5" cy="76" r="1.8" ${dk}/><circle cx="54.5" cy="76" r="1.8" ${dk}/><circle cx="43.5" cy="58" r="2" ${dk}/><circle cx="56.5" cy="58" r="2" ${dk}/>`;
    case 'caballo': return `<path d="M34 88 H70 C70 76 66 68 61 62 C67 60 71 53 69 45 C66 37 58 33 48 35 L44 29 L41 37 C35 41 31 49 30 58 L39 61 C43 57 47 57 49 59 C42 67 35 76 34 88 Z" ${st}/>`
      + `<circle cx="50" cy="44" r="2" ${dk}/><path d="M58 38 C64 44 66 52 62 60" stroke="rgba(0,0,0,.35)" stroke-width="2" fill="none"/>`;
    case 'paloma': return `<path d="M24 66 C32 56 44 54 54 57 L60 47 C63 42 70 42 72 47 L79 49 L72 52 C72 60 67 67 58 71 C66 73 72 77 76 83 C65 83 55 81 48 77 C38 78 29 74 24 66 Z" ${st}/>`
      + `<path d="M40 62 C46 52 56 46 66 40 C62 52 56 60 46 66 Z" ${st}/><circle cx="66" cy="47" r="1.5" ${dk}/>`;
    case 'tiburon': return `<path d="M24 76 C38 72 47 58 50 34 C58 50 66 66 78 76 Z" ${st}/>`
      + `<path d="M20 84 Q27 79 34 84 T48 84 T62 84 T76 84 T86 84" stroke="${fill}" stroke-width="4" fill="none" stroke-linecap="round"/>`;
    case 'mariposa': return `<ellipse cx="37" cy="52" rx="14" ry="11" transform="rotate(-25 37 52)" ${st}/><ellipse cx="63" cy="52" rx="14" ry="11" transform="rotate(25 63 52)" ${st}/>`
      + `<ellipse cx="40" cy="72" rx="9" ry="11" transform="rotate(20 40 72)" ${st}/><ellipse cx="60" cy="72" rx="9" ry="11" transform="rotate(-20 60 72)" ${st}/>`
      + `<circle cx="36" cy="51" r="4" fill="rgba(0,0,0,.2)"/><circle cx="64" cy="51" r="4" fill="rgba(0,0,0,.2)"/><ellipse cx="50" cy="62" rx="3.5" ry="17" ${dk}/>`
      + '<path d="M49 46 C46 38 42 36 40 35 M51 46 C54 38 58 36 60 35" stroke="rgba(0,0,0,.72)" stroke-width="1.8" fill="none" stroke-linecap="round"/>';
    case 'flor': return [0, 1, 2, 3, 4, 5].map((i) => { const a = (i * Math.PI) / 3; return `<circle cx="${(50 + 13 * Math.cos(a)).toFixed(1)}" cy="${(60 + 13 * Math.sin(a)).toFixed(1)}" r="10" ${st}/>`; }).join('')
      + '<circle cx="50" cy="60" r="8" fill="#facc15" stroke="rgba(0,0,0,.6)" stroke-width="2"/>';
    case 'corazon': return `<path d="M50 86 C30 72 23 61 23 50 C23 40 31 35 38 35 C44 35 48 39 50 43 C52 39 56 35 62 35 C69 35 77 40 77 50 C77 61 70 72 50 86 Z" ${st}/>`;
    case 'pino': return `<path d="M50 32 L64 50 H57 L70 66 H60 L74 82 H26 L40 66 H30 L43 50 H36 Z" ${st}/><rect x="46" y="82" width="8" height="8" ${st}/>`;
    case 'sol': return Array.from({ length: 12 }, (_, i) => { const a = (i * Math.PI) / 6, b = 0.2; const q = (r, t) => `${(50 + r * Math.cos(t)).toFixed(1)},${(60 + r * Math.sin(t)).toFixed(1)}`; return `<polygon points="${q(16, a - b)} ${q(27, a)} ${q(16, a + b)}" ${st}/>`; }).join('')
      + `<circle cx="50" cy="60" r="14" ${st}/>`;
    case 'luna': return `<path d="M58 35 A26 26 0 1 0 58 85 A21 21 0 0 1 58 35 Z" ${st}/><polygon points="${starPoints(66, 52, 7, 3)}" ${st}/>`;
    case 'estrellas': return `<polygon points="${starPoints(50, 54, 16, 7)}" ${st}/><polygon points="${starPoints(31, 74, 11, 5)}" ${st}/><polygon points="${starPoints(69, 74, 11, 5)}" ${st}/>`;
    case 'trofeo': return `<path d="M36 40 C24 40 24 56 38 58 M64 40 C76 40 76 56 62 58" stroke="${fill}" stroke-width="5" fill="none"/>`
      + `<path d="M34 36 H66 V48 C66 60 58 67 50 67 C42 67 34 60 34 48 Z" ${st}/><rect x="46" y="66" width="8" height="10" ${st}/><rect x="37" y="76" width="26" height="8" rx="2" ${st}/>`;
    case 'bota': return `<path d="M30 40 H48 V60 C58 60 72 63 76 71 C78 78 74 80 68 80 H30 Z" ${st}/>`
      + '<path d="M36 48 H44 M36 54 H46 M48 62 L54 60" stroke="rgba(0,0,0,.6)" stroke-width="2"/>'
      + [34, 44, 54, 64].map((x) => `<rect x="${x}" y="81" width="5" height="5" ${dk}/>`).join('');
    case 'alas': return mirror('M39 59 C31 46 20 40 7 40 C13 45 17 49 19 53 C12 53 8 55 5 59 C13 61 19 61 25 62 C19 65 16 69 15 74 C23 72 31 68 39 66 Z')
      + `<circle cx="50" cy="62" r="13" fill="#fff" stroke="rgba(0,0,0,.6)" stroke-width="3" paint-order="stroke"/><polygon points="${pentagon(50, 62, 5)}" fill="#111"/>`;
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
    ${crestEmblem(cr.e, initialsOf(name), cr.ce)}
    <path d="${shape}" fill="none" stroke="rgba(0,0,0,.55)" stroke-width="3"/></svg>`;
}

const CREST_PRESETS = (() => {
  const shapes = Object.keys(CREST_SHAPES), pats = Object.keys(CREST_PATTERNS), ems = CREST_FIGURES;
  const combos = [[0, 14], [8, 3], [5, 14], [12, 4], [10, 3], [2, 12], [1, 4], [7, 14], [9, 0], [3, 12], [11, 14], [6, 3],
    [13, 0], [0, 12], [8, 14], [4, 9], [14, 8], [12, 0], [5, 3], [9, 4], [1, 14], [7, 9], [10, 14], [2, 9]];
  return combos.map(([a, b], i) => ({ s: shapes[i % 4], p: pats[(i * 3) % 7], c1: CREST_COLORS[a][0], c2: CREST_COLORS[b][0], e: ems[(i * 5) % ems.length] }));
})();

function randomCrest() {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const c1 = pick(CREST_COLORS)[0];
  let c2 = pick(CREST_COLORS)[0];
  while (c2 === c1) c2 = pick(CREST_COLORS)[0];
  return {
    s: pick(Object.keys(CREST_SHAPES)), p: pick(Object.keys(CREST_PATTERNS)),
    c1, c2, e: pick(CREST_FIGURES),
  };
}
/** Ícono de una figura sobre un círculo neutro (para elegirla en el creador). */
function crestEmblemIcon(e, size = 40) {
  const inner = e === 'ninguno' ? '<path d="M38 60 H62" stroke="#fff" stroke-width="4" stroke-linecap="round"/>' : crestEmblem(e, 'AB', '#ffffff');
  return `<svg width="${size}" height="${size}" viewBox="14 24 72 72" aria-hidden="true"><circle cx="50" cy="60" r="35" fill="#334155"/>${inner}</svg>`;
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
