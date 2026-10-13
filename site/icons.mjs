// Tool icons on one system: a page (with a folded corner) plus a clear mark for the action.
// Drawn on a 32 × 32 grid with 1.6 strokes, so they stay legible from 16 to 64 pixels.

const page = (x = 7, y = 3, w = 18, h = 26, f = 5) =>
  `<path d="M${x + 2} ${y}h${w - 2 - f}l${f} ${f}v${h - f - 2}a2 2 0 0 1-2 2h${-(w - 4)}a2 2 0 0 1-2-2v${-(h - 4)}a2 2 0 0 1 2-2z"/><path d="M${x + w - f} ${y}v${f}h${f}"/>`;
const sheet = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1.6"/>`;
const lines = (x, y, widths, step = 3.2) => widths.map((w, i) => `<path d="M${x} ${y + i * step}h${w}"/>`).join('');
const label = (text, y = 24.5) => `<text x="16" y="${y}" text-anchor="middle" font-size="6.2" font-weight="700" font-family="-apple-system, system-ui, sans-serif" fill="currentColor" stroke="none" letter-spacing="0.2">${text}</text>`;
const photo = (x, y, w, h) => `${sheet(x, y, w, h)}<path d="M${x + 1.5} ${y + h - 1.5}l${w * 0.3} ${-h * 0.42}l${w * 0.22} ${h * 0.24}l${w * 0.16} ${-h * 0.14}l${w * 0.22} ${h * 0.32}"/><circle cx="${x + w * 0.72}" cy="${y + h * 0.3}" r="1.2"/>`;
const arrowRight = (x, y, len = 6) => `<path d="M${x} ${y}h${len}M${x + len - 2.5} ${y - 2.5}l2.5 2.5-2.5 2.5"/>`;

const ICONS = {
  merge: `${page(4, 3, 15, 21, 4)}${page(12, 8, 15, 21, 4).replace('<path', '<path fill="var(--icon-bg, #fff)"')}<path d="M19.5 15v8M15.5 19h8"/>`,
  split: `${page(7, 3, 18, 26)}<path d="M4 16h3M10 16h2.5M15.5 16h2.5M21 16h2.5M27 16h1.5" stroke-dasharray="0"/><circle cx="12" cy="21.5" r="2"/><circle cx="12" cy="10.5" r="2"/><path d="m13.6 20.3 7.4-8.6M13.6 11.7l7.4 8.6"/>`,
  compress: `${page()}<path d="M11 12l4 4M15 12.5V16h-3.5M21 25l-4-4M17 24.5V21h3.5"/>`,
  organize: `${sheet(5, 4, 9, 11)}${sheet(18, 4, 9, 11)}${sheet(5, 18, 9, 11)}${sheet(18, 18, 9, 11)}<path d="M15.5 9.5h1M15.5 23.5h1" />`,
  rotate: `${page()}<path d="M21 17.5a5 5 0 1 1-1.5-3.6"/><path d="M20.5 10.5v4h-4"/>`,
  delete: `${page()}<path d="M11 13.5h10M14.5 13.5v-1.5h3v1.5M12.2 13.5l.8 9.5h6l.8-9.5"/>`,
  extract: `${page(5, 6, 16, 23, 4)}${page(13, 3, 14, 18, 4).replace('<path', '<path fill="var(--icon-bg, #fff)"')}<path d="M20 16.5v-6M17.5 13l2.5-2.5 2.5 2.5"/>`,
  image: `${photo(3, 5, 16, 13)}${page(14, 9, 15, 20, 4).replace('<path', '<path fill="var(--icon-bg, #fff)"')}${label('PDF', 24.5).replace('x="16"', 'x="21.5"')}`,
  toImage: `${page(3, 3, 15, 20, 4)}${label('PDF', 15.5).replace('x="16"', 'x="10.5"')}${photo(13, 15, 16, 13).replace('<rect', '<rect fill="var(--icon-bg, #fff)"')}`,
  numbers: `${page()}${lines(11, 10, [10, 8, 10, 6])}<path d="M14.5 21.5l1.5-1v5M14.5 25.5h3"/>`,
  watermark: `${page()}<path d="M16 11.5s4.5 4.6 4.5 7.8a4.5 4.5 0 0 1-9 0c0-3.2 4.5-7.8 4.5-7.8z"/>`,
  lock: `${page()}<rect x="11" y="16" width="10" height="8" rx="1.6"/><path d="M13 16v-2.5a3 3 0 0 1 6 0V16"/>`,
  unlock: `${page()}<rect x="11" y="16" width="10" height="8" rx="1.6"/><path d="M13 16v-2.5a3 3 0 0 1 5.8-1.1"/>`,
  sign: `${page()}<path d="M10.5 21.5c1.5-4 2.6-6.6 3.6-6.4.9.2-.6 5.4.5 5.6 1 .2 1.7-2.4 2.6-2.3.8.1.6 2.2 1.4 2.3.7.1 1.3-1 2-1.3"/><path d="M10.5 24.5h11"/>`,
  text: `${page()}<path d="M11.5 12.5h9M16 12.5v12M14 24.5h4"/>`,
  crop: `<path d="M9 3v18a2 2 0 0 0 2 2h18"/><path d="M23 29V11a2 2 0 0 0-2-2H3"/>`,
  nup: `<rect x="3" y="6" width="26" height="20" rx="2"/>${sheet(6.5, 9, 8.5, 14)}${sheet(17, 9, 8.5, 14)}`,
  info: `${page()}<circle cx="16" cy="18" r="5.5"/><path d="M16 17.5v3.2M16 15.1v.1"/>`,
  meta: `${page()}<path d="M11 13.5v4.2l6.3 6.3 4.7-4.7-6.3-6.3H11z"/><circle cx="13.6" cy="16.1" r="1"/>`,
  repair: `${page()}<path d="M12 21l7-7M13.5 23.5l-2-2a1.4 1.4 0 0 1 0-2l7.5-7.5a1.4 1.4 0 0 1 2 0l2 2a1.4 1.4 0 0 1 0 2l-7.5 7.5a1.4 1.4 0 0 1-2 0z" transform="translate(-1 0)"/><path d="M15 17.2v.1M16.6 18.8v.1"/>`,
  png: `${photo(3, 5, 16, 13)}${page(14, 9, 15, 20, 4).replace('<path', '<path fill="var(--icon-bg, #fff)"')}${label('PDF', 24.5).replace('x="16"', 'x="21.5"')}${label('PNG', 30.5).replace('x="16"', 'x="9"').replace('font-size="6.2"', 'font-size="5.4"')}`,
  webp: `${photo(3, 5, 16, 13)}${page(14, 9, 15, 20, 4).replace('<path', '<path fill="var(--icon-bg, #fff)"')}${label('PDF', 24.5).replace('x="16"', 'x="21.5"')}${label('WEBP', 30.5).replace('x="16"', 'x="9"').replace('font-size="6.2"', 'font-size="5.4"')}`,
  toPng: `${page(3, 3, 15, 20, 4)}${label('PDF', 15.5).replace('x="16"', 'x="10.5"')}${photo(13, 15, 16, 13).replace('<rect', '<rect fill="var(--icon-bg, #fff)"')}${label('PNG', 6).replace('x="16"', 'x="25"').replace('font-size="6.2"', 'font-size="5.4"')}`,
  toText: `${page()}<path d="M11.5 12.5h4.5M13.75 12.5v6"/>${lines(11.5, 21.5, [9, 6.5])}<path d="M18.5 14h2.5M18.5 17h2.5"/>`,
  extractImages: `${page(4, 6, 16, 23, 4)}${photo(13, 4, 15, 12).replace('<rect', '<rect fill="var(--icon-bg, #fff)"')}<path d="M8 21h6M8 24.5h8"/>`,
  grayscale: `${page()}<circle cx="16" cy="18" r="5.5"/><path d="M16 12.5v11a5.5 5.5 0 0 0 0-11z" fill="currentColor"/>`,
  reverse: `${sheet(4, 6, 10, 14)}${sheet(18, 12, 10, 14)}<path d="M9 23v3.5h12M18.5 24l2.5 2.5-2.5 2.5M23 9V5.5H11M13.5 8 11 5.5 13.5 3" />`,
  blank: `${page(4, 3, 15, 21, 4)}${page(12, 8, 15, 21, 4).replace('<path', '<path fill="var(--icon-bg, #fff)" stroke-dasharray="2.4 2"')}<path d="M19.5 15.5v7M16 19h7"/>`,
  mix: `${sheet(3, 5, 9, 12)}${sheet(20, 5, 9, 12)}${sheet(11.5, 17, 9, 12)}<path d="M7.5 17.5v3.5h3M24.5 17.5v3.5h-3"/>`,
  half: `${page()}<path d="M16 3v26" stroke-dasharray="2.2 2"/>${lines(10, 12, [4, 3.5, 4])}${lines(18.5, 12, [4, 3.5, 4])}`,
  resize: `${sheet(4, 12, 11, 16)}<path d="M13 4h15v15" stroke-dasharray="2.2 2"/><path d="M19 13l7-7M21.5 6H26v4.5"/>`,
  margins: `${page()}<rect x="10.5" y="10.5" width="11" height="15" rx="1" stroke-dasharray="2 1.8"/>`,
  booklet: `<path d="M16 8.5c-3-2-7.5-2.5-12-2v19c4.5-.5 9 0 12 2 3-2 7.5-2.5 12-2v-19c-4.5-.5-9 0-12 2z"/><path d="M16 8.5v19"/>`,
  removeBlank: `${page(7, 3, 18, 26).replace(/<path /g, '<path stroke-dasharray="2.4 2" ')}<path d="M12.5 14.5l7 7M19.5 14.5l-7 7"/>`,
  bySize: `${page()}${label('MB', 22)}<path d="M11 12.5h10" />`,
  headerFooter: `${page()}<path d="M10.5 10.5h11M10.5 25h11" stroke-width="2.6"/>${lines(11.5, 15, [9, 7, 9])}`,
  bates: `${page()}${lines(11, 10, [10, 8, 10])}${label('001', 25)}`,
  addImage: `${page()}${photo(10.5, 12, 11, 9)}<path d="M16 23.5v3M14.5 25h3" />`,
  redact: `${page()}<path d="M11 11h10M11 23.5h7"/><rect x="10.5" y="14.5" width="11" height="5" rx="0.8" fill="currentColor"/>`,
  form: `${page()}<rect x="10.5" y="11" width="4" height="4" rx="0.8"/><path d="m11.4 13 .9.9 1.5-1.7"/><path d="M16.5 13h5"/><rect x="10.5" y="18.5" width="11" height="5" rx="1"/>`,
  flatten: `${page()}<path d="M11 12.5l5 2.5 5-2.5-5-2.5z"/><path d="M11 16.5l5 2.5 5-2.5"/><path d="M10.5 24h11"/>`,
  unannotate: `${page()}<path d="M11 12h10v6.5h-5l-3 2.5v-2.5h-2z"/><path d="M18 22.5l3 3M21 22.5l-3 3"/>`,
  removeImages: `${page()}${photo(10.5, 12, 11, 9)}<path d="M10 25.5 22 10.5"/>`,
  view: `${page()}<path d="M9.5 18s2.6-4.5 6.5-4.5 6.5 4.5 6.5 4.5-2.6 4.5-6.5 4.5-6.5-4.5-6.5-4.5z"/><circle cx="16" cy="18" r="1.8"/>`,
  compare: `${sheet(3, 5, 11, 15)}${sheet(18, 12, 11, 15)}${lines(5.5, 9, [6, 4.5, 6])}${lines(20.5, 16, [6, 4.5, 6])}<path d="M10 23.5v2.5h5.5M20 8.5V6h-5.5"/>`,
  bookmarks: `${page()}<path d="M13 3v10l3-2.2 3 2.2V3"/>${lines(11, 18, [10, 8, 10])}`,
  highlight: `${page()}${lines(11, 11.5, [10])}<path d="M10.5 16.5h11" stroke-width="3.6" stroke-opacity="0.35"/>${lines(11, 21.5, [10, 7])}`,
  imageWatermark: `${page()}${photo(10.5, 13, 11, 9).replace('<rect', '<rect stroke-dasharray="2 1.6"')}`,
  longImage: `<rect x="10" y="2" width="12" height="28" rx="1.6"/><path d="M10 11h12M10 20h12"/>${lines(12.5, 5.5, [7, 5])}${lines(12.5, 14.5, [7, 5])}${lines(12.5, 23.5, [7, 5])}`,
  // Small symbols used elsewhere on the site (24-unit artwork, scaled up).
  bolt: `<g transform="scale(1.3333)"><path d="M13 2.5 4.5 13.5h6.5l-1 8 8.5-11h-6.5z"/></g>`,
  tag: `<g transform="scale(1.3333)"><path d="M3 11.5V4a1 1 0 0 1 1-1h7.5l9.5 9.5-8.5 8.5z"/><circle cx="7.5" cy="7.5" r="1.5"/></g>`,
  padlock: `<g transform="scale(1.3333)"><rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></g>`,
};

export const iconNames = Object.keys(ICONS);

export const icon = (name, size = 24) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ICONS.info}</svg>`;
