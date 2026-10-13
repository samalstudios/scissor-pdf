// Builds the static site into dist/: compiles the Rust engine to WebAssembly, copies PDF.js,
// and renders every page in every language from site/tools.mjs + site/i18n/<code>.json.
// English lives at the root (/merge-pdf/), other languages under a prefix (/es/merge-pdf/).
// node scripts/build.mjs [--skip-wasm]
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE, TOOLS, icon, toolBySlug } from '../site/tools.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const ENGINE = join(ROOT, 'engine');
const PDFJS_VERSION = JSON.parse(readFileSync(join(ROOT, 'node_modules/pdfjs-dist/package.json'), 'utf8')).version;
const PDFJS_PATH = `/vendor/pdfjs-${PDFJS_VERSION}`;
const TODAY = new Date().toISOString().slice(0, 10);
const cargoEnv = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };

/* ---------- Languages ---------- */

const ORDER = ['en', 'es', 'pt', 'fr', 'de', 'it', 'nl', 'pl', 'tr', 'ru', 'uk', 'ar', 'fa', 'ckb', 'ku', 'hi', 'id', 'vi', 'ja', 'ko', 'zh'];
const available = readdirSync(join(ROOT, 'site/i18n')).filter((f) => /^[a-z]+\.json$/.test(f)).map((f) => f.slice(0, -5));
// Every translation is published. Keys a translation lacks (for example a newly added tool)
// fall back to English until translated; the checker lists them.
const LANGS = ORDER.filter((c) => available.includes(c));
const fillFrom = (base, tr) => {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return tr ?? base;
  const out = { ...base, ...(tr || {}) };
  for (const k of Object.keys(base)) if (typeof base[k] === 'object' && !Array.isArray(base[k]) && !('other' in base[k])) out[k] = fillFrom(base[k], tr?.[k]);
  return out;
};
const EN = JSON.parse(readFileSync(join(ROOT, 'site/i18n/en.json'), 'utf8'));
const STRINGS = Object.fromEntries(LANGS.map((c) => [c, c === 'en' ? EN : fillFrom(EN, JSON.parse(readFileSync(join(ROOT, `site/i18n/${c}.json`), 'utf8')))]));
const untranslated = LANGS.filter((c) => {
  if (c === 'en') return false;
  try {
    execSync(`node ${join(ROOT, 'scripts/i18n-check.mjs')} ${c}`, { stdio: 'pipe' });
    return false;
  } catch {
    return true;
  }
});
if (untranslated.length) console.warn(`  incomplete translations (English fallback used): ${untranslated.join(', ')}`);
const prefix = (c) => (c === 'en' ? '' : `/${c}`);
const hreflang = (c) => ({ zh: 'zh-Hans' })[c] || c;

/* ---------- Engine ---------- */

if (!process.argv.includes('--skip-wasm') || !existsSync(join(ENGINE, 'pkg/engine_bg.wasm'))) {
  console.log('Building engine (Rust → WebAssembly)…');
  execSync('cargo build --release --target wasm32-unknown-unknown', { cwd: ENGINE, stdio: 'inherit', env: cargoEnv });
  execSync('wasm-bindgen --target web --no-typescript --out-dir pkg target/wasm32-unknown-unknown/release/engine.wasm', { cwd: ENGINE, stdio: 'inherit', env: cargoEnv });
  try {
    execSync('wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int -o pkg/engine_bg.wasm pkg/engine_bg.wasm', { cwd: ENGINE, stdio: 'ignore', env: cargoEnv });
  } catch {
    console.log('  (wasm-opt not found, skipping size optimisation)');
  }
}

/* ---------- Static files ---------- */

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
cpSync(join(ROOT, 'site/assets'), join(DIST, 'assets'), { recursive: true });
cpSync(join(ROOT, 'site/public'), DIST, { recursive: true });
mkdirSync(join(DIST, 'engine'));
for (const f of ['engine.js', 'engine_bg.wasm']) cpSync(join(ENGINE, 'pkg', f), join(DIST, 'engine', f));
const pdfjs = join(ROOT, 'node_modules/pdfjs-dist');
const vendor = join(DIST, PDFJS_PATH);
mkdirSync(vendor, { recursive: true });
for (const f of ['pdf.min', 'pdf.worker.min']) cpSync(join(pdfjs, `build/${f}.mjs`), join(vendor, `${f}.js`));
for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) cpSync(join(pdfjs, d), join(vendor, d), { recursive: true });
// Form filling uses PDF.js's own field styles and icons.
cpSync(join(pdfjs, 'web/pdf_viewer.css'), join(vendor, 'pdf_viewer.css'));
cpSync(join(pdfjs, 'web/images'), join(vendor, 'images'), { recursive: true });
cpSync(join(pdfjs, 'LICENSE'), join(vendor, 'LICENSE'));

// Version every app file by content so browsers and the service worker never mix builds.
const hashOf = (...files) => createHash('sha256').update(files.map((f) => readFileSync(f)).join('')).digest('hex').slice(0, 10);
const V = hashOf(...['assets/app.js', 'assets/app.css', 'assets/worker.js', 'engine/engine.js', 'engine/engine_bg.wasm'].map((f) => join(DIST, f)));
const worker = join(DIST, 'assets/worker.js');
writeFileSync(worker, readFileSync(worker, 'utf8').replaceAll('../engine/engine.js', `../engine/engine.js?v=${V}`).replaceAll('../engine/engine_bg.wasm', `../engine/engine_bg.wasm?v=${V}`));

/* ---------- Helpers ---------- */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
const url = (path) => `${SITE.origin}${path}`;
const ORG_ID = `${SITE.org.url}/#organization`;
const SITE_ID = `${SITE.origin}/#website`;

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

const LOCK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';
const CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>';
const MARK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.1 8.1 20 20M8.1 15.9 20 4"/></svg>';
const GLOBE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';

const organization = { '@type': 'Organization', '@id': ORG_ID, name: SITE.org.name, url: SITE.org.url, logo: url('/icon-512.png') };

/* ---------- Page rendering, per language ---------- */

const pages = []; // English paths; the sitemap lists every language for each

function render(L, slugPath, html) {
  const dir = join(DIST, prefix(L), slugPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), html);
  if (L === 'en') pages.push(slugPath);
}

function layout(L, { slugPath, title, description, ogImage, jsonld, body, bare = false }) {
  const S = STRINGS[L];
  const path = `${prefix(L)}${slugPath}`;
  const alternates = LANGS.map((c) => `<link rel="alternate" hreflang="${hreflang(c)}" href="${url(prefix(c) + slugPath)}">`).join('\n');
  // Strings for the app, plus each language's own "available in" banner text.
  const i18n = {
    code: L,
    ui: S.ui,
    langs: LANGS.map((c) => ({ code: c, name: STRINGS[c].meta.name, dir: STRINGS[c].meta.dir, prefix: prefix(c), text: STRINGS[c].common.suggestLang, switch: STRINGS[c].common.switch, dismiss: STRINGS[c].common.dismiss })),
  };
  return `<!doctype html>
<html lang="${hreflang(L)}" dir="${S.meta.dir}" data-v="${V}" data-pdfjs="${PDFJS_PATH}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url(path)}">
${alternates}
<link rel="alternate" hreflang="x-default" href="${url(slugPath)}">
<meta name="theme-color" content="#fbfbfd" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE.name}">
<meta property="og:locale" content="${S.meta.ogLocale}">
${LANGS.filter((c) => c !== L).map((c) => `<meta property="og:locale:alternate" content="${STRINGS[c].meta.ogLocale}">`).join('\n')}
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url(path)}">
<meta property="og:image" content="${url(ogImage)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/assets/app.css?v=${V}">
<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>
<script type="application/json" id="i18n">${JSON.stringify(i18n).replace(/</g, '\\u003c')}</script>
</head>
<body${bare ? ' class="app-mode"' : ''}>
${bare ? '' : nav(L)}
<main>
${body}
</main>
${bare ? '' : footer(L, slugPath)}
<script type="module" src="/assets/app.js?v=${V}"></script>
</body></html>`;
}

function nav(L) {
  const S = STRINGS[L];
  const p = prefix(L);
  return `<header class="nav"><div class="wrap">
<a class="brand" href="${p}/" aria-label="${SITE.name}">${MARK}${SITE.name}</a>
<nav class="nav-links" aria-label="Main"><a href="${p}/app/"><b>${esc(S.studio?.nav ?? STUDIO_TEXT.nav)}</b></a><a href="${p}/#tools">${esc(S.nav.allTools)}</a><a class="opt" href="${p}/compress-pdf/">${esc(S.nav.compress)}</a><a class="opt" href="${p}/merge-pdf/">${esc(S.nav.merge)}</a><a class="opt" href="${p}/how-it-works/">${esc(S.nav.how)}</a><a class="lang-link" href="#languages" aria-label="${esc(S.nav.language)}">${GLOBE}<span>${esc(S.meta.name)}</span></a></nav>
</div></header>`;
}

function footer(L, slugPath) {
  const S = STRINGS[L];
  const p = prefix(L);
  const link = (slug) => `<li><a href="${p}/${slug}/">${esc(S.tools[slug].name)}</a></li>`;
  return `<footer class="footer"><div class="wrap">
<div class="footer-cols">
${GROUPS.map(([k, slugs]) => `<div><h2>${esc(S.footer[k])}</h2><ul>${slugs.map(link).join('')}</ul></div>`).join('\n')}
<div><h2>${esc(S.footer.about)}</h2><ul><li><a href="${p}/how-it-works/">${esc(S.nav.how)}</a></li><li><a href="${p}/privacy/">${esc(S.footer.privacy)}</a></li><li><a href="/ilovepdf-smallpdf-alternative/" hreflang="en">vs iLovePDF &amp; Smallpdf</a></li><li><a href="${SITE.org.url}">Scissor</a></li></ul></div>
</div>
<div id="languages" class="langs"><h2>${GLOBE} ${esc(S.footer.languages)}</h2><ul>${LANGS.map((c) => `<li><a href="${prefix(c)}${slugPath}" hreflang="${hreflang(c)}" lang="${hreflang(c)}"${c === L ? ' aria-current="page"' : ''}>${esc(STRINGS[c].meta.name)}</a></li>`).join('')}</ul></div>
<p>${esc(S.footer.note)} © ${new Date().getFullYear()} <a href="${SITE.org.url}">Scissor</a>. ${esc(S.footer.updated)} <time datetime="${TODAY}">${TODAY}</time>.</p>
</div></footer>`;
}

const chiclet = (L, t) => `<a class="chiclet" href="${prefix(L)}/${t.slug}/">${icon(t.icon, 40)}<span>${esc(STRINGS[L].tools[t.slug].name)}</span></a>`;
const chiclets = (L, slugs) => `<div class="chiclets">${slugs.map((s) => chiclet(L, toolBySlug[s])).join('')}</div>`;
const GROUPS = [
  ['organize', ['merge-pdf', 'split-pdf', 'organize-pdf', 'rotate-pdf', 'reverse-pdf', 'delete-pdf-pages', 'remove-blank-pages', 'extract-pdf-pages', 'insert-blank-pages', 'alternate-mix-pdf', 'split-pdf-by-size', 'split-pdf-by-bookmarks', 'split-pdf-pages-in-half', 'crop-pdf', 'resize-pdf', 'add-margins-to-pdf', 'pages-per-sheet', 'pdf-booklet']],
  ['optimize', ['compress-pdf', 'jpg-to-pdf', 'png-to-pdf', 'webp-to-pdf', 'pdf-to-jpg', 'pdf-to-png', 'pdf-to-long-image', 'pdf-to-text', 'extract-images-from-pdf', 'grayscale-pdf', 'remove-images-from-pdf', 'repair-pdf']],
  ['edit', ['sign-pdf', 'fill-pdf-form', 'add-text-to-pdf', 'add-image-to-pdf', 'highlight-pdf', 'redact-pdf', 'add-page-numbers', 'pdf-header-footer', 'bates-numbering', 'watermark-pdf', 'image-watermark-pdf', 'flatten-pdf', 'remove-pdf-annotations', 'protect-pdf', 'unlock-pdf', 'edit-pdf-metadata']],
  ['inspect', ['pdf-viewer', 'compare-pdf', 'pdf-info']],
];
const toolGroups = (L) => GROUPS.map(([k, slugs]) => `<div class="tool-group"><h3>${esc(STRINGS[L].footer[k])}</h3>${chiclets(L, slugs)}</div>`).join('');
const faqHtml = (faqs) => `<div class="faq">${faqs.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</div>`;
const points = (L) => {
  const c = STRINGS[L].common;
  return `<div class="points">${[['padlock', c.f1t, c.f1p], ['bolt', c.f2t, c.f2p], ['tag', c.f3t, c.f3p]].map(([i, h, p]) => `<div class="point">${icon(i, 32)}<h3>${esc(h)}</h3><p>${esc(p)}</p></div>`).join('')}</div>`;
};
// What the browser app needs to run a tool, in the page's language.
function toolConfig(L, t) {
  const S = STRINGS[L];
  const s = S.tools[t.slug];
  const p = prefix(L);
  return {
    slug: t.slug,
    name: s.name,
    mode: t.mode,
    accept: t.accept,
    multiple: !!t.multiple,
    action: s.action,
    op: t.op,
    option: t.option,
    editor: t.editor,
    defaults: t.defaults,
    autoBlank: t.autoBlank,
    watermarkImage: t.watermarkImage,
    next: t.related.map((r) => toolBySlug[r]).filter((r) => r.accept === 'pdf').map((r) => ({ href: `${p}/${r.slug}/`, name: S.tools[r.slug].name, color: r.color, icon: icon(r.icon, 16) })),
  };
}

// Tools offered inside PDF Studio: everything that works on one open PDF.
const STUDIO_SKIP = new Set(['jpg-to-pdf', 'png-to-pdf', 'webp-to-pdf', 'pdf-viewer', 'repair-pdf', 'unlock-pdf']);
const STUDIO_FINAL = new Set(['protect-pdf']);
const STUDIO_TEXT = {
  title: 'PDF Studio: Every PDF Tool in One Private App',
  description: 'Open a PDF once and edit it with every tool: merge, compress, sign, redact, rotate, convert. Undo any step. Runs in your browser, nothing is uploaded.',
  h1: 'PDF Studio',
  lead: 'Open a PDF once, then use any tool on it. Every step can be undone, and nothing leaves your device.',
  nav: 'Studio',
};

const section = (inner, cls = '', id = '') => `<section class="section ${cls}"${id ? ` id="${id}"` : ''}><div class="wrap">${inner}</div></section>`;

// Breaks text into lines for SVG; scripts without spaces are cut by character count.
const wrapLines = (text, max) => {
  const words = /\s/.test(text) ? text.split(/\s+/) : [...text];
  const sep = /\s/.test(text) ? ' ' : '';
  const lines = [''];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if (cur && (cur + sep + w).length > max) lines.push(w);
    else lines[lines.length - 1] = cur ? cur + sep + w : w;
  }
  return lines;
};

// The home page "product shot": the Organize tool mid-drag, with realistic documents,
// drawn as SVG so it stays sharp, follows light and dark mode and speaks the page's language.
function heroArt(L, mobile = false) {
  const S = STRINGS[L];
  const name = S.tools['organize-pdf'].name;
  const action = S.tools['organize-pdf'].action;
  const W = 116;
  const H = 150;
  const bar = (x, y, w, h = 3, cls = 'a-text') => `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/>`;
  const lines = (x, y, widths, step = 6.5) => widths.map((w, i) => bar(x, y + i * step, w)).join('');
  const sheet = (x, y, inner, attrs = '') => `<g ${attrs}><rect class="a-page" x="${x}" y="${y}" width="${W}" height="${H}" rx="1.5" filter="url(#paper)"/>${inner}</g>`;
  const docs = {
    cover: (x, y) =>
      sheet(x, y, `<clipPath id="c${x}${y}"><rect x="${x}" y="${y}" width="${W}" height="90" rx="1.5"/></clipPath>
<g clip-path="url(#c${x}${y})"><rect x="${x}" y="${y}" width="${W}" height="90" fill="url(#sky)"/><circle cx="${x + 84}" cy="${y + 30}" r="9" fill="#fff" opacity="0.85"/>
<path d="M${x} ${y + 70} L${x + 26} ${y + 48} L${x + 44} ${y + 62} L${x + 70} ${y + 40} L${x + W} ${y + 66} V${y + 90} H${x}Z" fill="#2b5d8c" opacity="0.9"/>
<path d="M${x} ${y + 80} L${x + 34} ${y + 64} L${x + 62} ${y + 76} L${x + 92} ${y + 62} L${x + W} ${y + 74} V${y + 90} H${x}Z" fill="#1b3f63"/></g>
<text class="a-doc" x="${x + 10}" y="${y + 106}" font-size="10" font-weight="700">Annual Report</text>
<text class="a-docsoft" x="${x + 10}" y="${y + 118}" font-size="7">2026 · Scissor</text>${lines(x + 10, y + 128, [70, 52])}`),
    article: (x, y) =>
      sheet(x, y, `${bar(x + 10, y + 12, 64, 5, 'a-ink')}${bar(x + 10, y + 22, 40, 3, 'a-text2')}
${lines(x + 10, y + 34, [44, 42, 44, 38, 44, 44, 40, 44, 30, 44, 42, 44, 36, 44, 44, 26])}${lines(x + 62, y + 34, [44, 44, 40, 44, 42, 44, 22, 44, 44, 40, 44, 38, 44, 44, 42, 34])}`),
    chart: (x, y) =>
      sheet(x, y, `${bar(x + 10, y + 12, 52, 5, 'a-ink')}${lines(x + 10, y + 24, [96, 90, 70])}
<line class="a-axis" x1="${x + 12}" y1="${y + 104}" x2="${x + 104}" y2="${y + 104}"/>
${[30, 44, 26, 52, 38, 60].map((hgt, i) => `<rect class="a-accent" opacity="${0.3 + i * 0.12}" x="${x + 16 + i * 15}" y="${y + 104 - hgt}" width="9" height="${hgt}" rx="1"/>`).join('')}
${lines(x + 10, y + 114, [96, 88, 92, 60])}`),
    invoice: (x, y) =>
      sheet(x, y, `<circle class="a-accent" cx="${x + 15}" cy="${y + 16}" r="5"/>${bar(x + 24, y + 13, 30, 5, 'a-ink')}${bar(x + 72, y + 13, 34, 3, 'a-text2')}
${lines(x + 10, y + 32, [40, 34, 46])}
${[0, 1, 2, 3, 4, 5].map((i) => `<rect class="a-row" x="${x + 8}" y="${y + 58 + i * 11}" width="100" height="10" opacity="${i % 2 ? 0 : 1}"/>${bar(x + 12, y + 61.5 + i * 11, 44 + ((i * 13) % 20))}${bar(x + 86, y + 61.5 + i * 11, 16)}`).join('')}
<line class="a-axis" x1="${x + 60}" y1="${y + 128}" x2="${x + 106}" y2="${y + 128}"/>${bar(x + 62, y + 133, 18, 4, 'a-ink')}${bar(x + 84, y + 133, 20, 4, 'a-ink')}`),
    photo: (x, y) =>
      sheet(x, y, `${bar(x + 10, y + 12, 58, 5, 'a-ink')}
<clipPath id="p${x}${y}"><rect x="${x + 10}" y="${y + 24}" width="96" height="62" rx="1.5"/></clipPath>
<g clip-path="url(#p${x}${y})"><rect x="${x + 10}" y="${y + 24}" width="96" height="62" fill="url(#dusk)"/><circle cx="${x + 40}" cy="${y + 58}" r="10" fill="#ffe7b0" opacity="0.9"/>
<path d="M${x + 10} ${y + 70} Q${x + 40} ${y + 56} ${x + 66} ${y + 68} T${x + 106} ${y + 64} V${y + 86} H${x + 10}Z" fill="#5a2d4f"/></g>
${bar(x + 10, y + 91, 50, 2.5, 'a-text2')}${lines(x + 10, y + 100, [96, 92, 96, 84, 96, 60])}`),
    table: (x, y) =>
      sheet(x, y, `${bar(x + 10, y + 12, 46, 5, 'a-ink')}${lines(x + 10, y + 24, [96, 70])}
${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<line class="a-axis" x1="${x + 10}" y1="${y + 44 + i * 11}" x2="${x + 106}" y2="${y + 44 + i * 11}"/>${bar(x + 12, y + 47.5 + i * 11, 30, 3, i ? 'a-text' : 'a-text2')}${bar(x + 56, y + 47.5 + i * 11, 18, 3, i ? 'a-text' : 'a-text2')}${bar(x + 84, y + 47.5 + i * 11, 18, 3, i ? 'a-text' : 'a-text2')}`).join('')}`),
  };
  if (mobile) {
    // Portrait composition matching the phone UI: two columns of pages and the bottom action bar.
    const mc = [36, 208];
    const mr = [84, 276];
    let m = '';
    [['cover', 1], ['chart', 2], ['photo', 3], [null, 4]].forEach(([kind, n], i) => {
      const x = mc[i % 2];
      const y = mr[Math.floor(i / 2)];
      m += kind ? docs[kind](x, y) : `<rect class="a-slot" x="${x}" y="${y}" width="${W}" height="${H}" rx="3"/>`;
      m += `<text class="a-muted" x="${x + W / 2}" y="${y + H + 20}" font-size="11" text-anchor="middle">${n}</text>`;
    });
    const fx = 196;
    const fy = 150;
    return `<svg viewBox="0 0 360 470" role="img" aria-label="${esc(name)}" xmlns="http://www.w3.org/2000/svg">
<defs>
<linearGradient id="skyM" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#bfe0ff"/><stop offset="0.6" stop-color="#7fb2e5"/><stop offset="1" stop-color="#4a83bd"/></linearGradient>
<linearGradient id="duskM" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f9c58d"/><stop offset="0.55" stop-color="#ef8a6a"/><stop offset="1" stop-color="#8d4a72"/></linearGradient>
<filter id="paperM" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="1" stdDeviation="1.2" flood-opacity="0.18"/></filter>
<filter id="liftM" x="-40%" y="-30%" width="180%" height="170%"><feDropShadow dx="0" dy="18" stdDeviation="14" flood-opacity="0.24"/></filter>
<clipPath id="winM"><rect width="360" height="470" rx="28"/></clipPath>
</defs>
<g class="a-shadow"><rect class="a-window" width="360" height="470" rx="28"/></g>
<g clip-path="url(#winM)">
<rect class="a-stage" width="360" height="470"/>
<text class="a-label" x="36" y="44" font-size="14" font-weight="600">Annual Report.pdf</text>
<text class="a-muted" x="36" y="63" font-size="12">${esc(fill(S.ui.pages.other, { n: 8 }))} · 3.1 MB</text>
${m}
<rect class="a-accent a-caret" x="${mc[1] - 22}" y="${mr[1]}" width="3" height="${H}" rx="1.5"/>
<g filter="url(#liftM)"><g class="a-float">${docs.invoice(fx, fy)}<rect class="a-ring" x="${fx - 3}" y="${fy - 3}" width="${W + 6}" height="${H + 6}" rx="4" stroke-width="2"/></g></g>
<rect class="a-panel" x="0" y="394" width="360" height="76" opacity="0.94"/>
<line class="a-line" x1="0" y1="394.5" x2="360" y2="394.5"/>
<rect class="a-accent" x="24" y="408" width="312" height="44" rx="22"/>
<text class="a-white" x="180" y="435" font-size="15" text-anchor="middle">${esc(action)}</text>
</g>
<rect class="a-line" x="0.5" y="0.5" width="359" height="469" rx="27.5"/>
</svg>`.replace(/url\(#sky\)/g, 'url(#skyM)').replace(/url\(#dusk\)/g, 'url(#duskM)').replace(/url\(#paper\)/g, 'url(#paperM)');
  }
  const cols = [44, 200, 356, 512];
  const rows = [92, 346];
  const slots = [['cover', 1], ['article', 2], ['chart', 3], ['article', 4], ['photo', 5], ['table', 6], [null, 7], ['article', 8]];
  let pages = '';
  slots.forEach(([kind, n], i) => {
    const x = cols[i % 4];
    const y = rows[Math.floor(i / 4)];
    pages += kind ? docs[kind](x, y) : `<rect class="a-slot" x="${x}" y="${y}" width="${W}" height="${H}" rx="3"/>`;
    pages += `<text class="a-muted" x="${x + W / 2}" y="${y + H + 22}" font-size="11" text-anchor="middle">${n}</text>`;
  });
  const lx = cols[1] - 26;
  const ly = rows[1] - 28;
  const lifted = `<g class="a-float">${docs.invoice(lx, ly, '')}<rect class="a-ring" x="${lx - 3}" y="${ly - 3}" width="${W + 6}" height="${H + 6}" rx="4" stroke-width="2"/>
<path d="M${lx + 92} ${ly + 104} l0 20 l5 -5 l4 9 l3 -1.5 l-4 -9 l7 0 z" fill="#000" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></g>`;
  const title = name.length > 18 ? 17 : 21;
  return `<svg viewBox="0 0 980 600" role="img" aria-label="${esc(name)}" xmlns="http://www.w3.org/2000/svg">
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#bfe0ff"/><stop offset="0.6" stop-color="#7fb2e5"/><stop offset="1" stop-color="#4a83bd"/></linearGradient>
<linearGradient id="dusk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f9c58d"/><stop offset="0.55" stop-color="#ef8a6a"/><stop offset="1" stop-color="#8d4a72"/></linearGradient>
<filter id="paper" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="1" stdDeviation="1.2" flood-opacity="0.18"/></filter>
<filter id="lift" x="-40%" y="-30%" width="180%" height="170%"><feDropShadow dx="0" dy="22" stdDeviation="18" flood-opacity="0.24"/></filter>
<clipPath id="win"><rect width="980" height="600" rx="18"/></clipPath>
</defs>
<g class="a-shadow"><rect class="a-window" width="980" height="600" rx="18"/></g>
<g clip-path="url(#win)">
<rect class="a-stage" width="690" height="600"/>
<text class="a-label" x="44" y="46" font-size="14" font-weight="600">Annual Report.pdf</text>
<text class="a-muted" x="${44 + 'Annual Report.pdf'.length * 8.2}" y="46" font-size="13">${esc(fill(S.ui.pages.other, { n: 8 }))} · 3.1 MB</text>
${pages}
<rect class="a-accent a-caret" x="${cols[1] - 22}" y="${rows[1]}" width="3" height="${H}" rx="1.5"/>
<g filter="url(#lift)">${lifted}</g>
<rect class="a-panel" x="690" y="0" width="290" height="600"/>
<line class="a-line" x1="690.5" y1="0" x2="690.5" y2="600"/>
<text class="a-label" x="722" y="62" font-size="${title}" font-weight="600">${esc(name)}</text>
${wrapLines(S.ui.organizeSub, 34).slice(0, 3).map((ln, i) => `<text class="a-muted" x="722" y="${88 + i * 18}" font-size="13">${esc(ln)}</text>`).join('')}
<text class="a-muted" x="722" y="176" font-size="11" font-weight="600" style="fill:var(--text-2)">${esc(S.ui.rotateAll)}</text>
<rect class="a-fill" x="722" y="186" width="230" height="32" rx="9"/>
<rect class="a-seg" x="724" y="188" width="113" height="28" rx="7"/>
<text class="a-muted" x="780" y="207" font-size="13" text-anchor="middle" style="fill:var(--text)">${esc(S.ui.left)}</text>
<text class="a-muted" x="894" y="207" font-size="13" text-anchor="middle" style="fill:var(--text)">${esc(S.ui.right)}</text>
<text class="a-muted" x="722" y="248" font-size="13" style="fill:var(--link)">${esc(S.ui.resetChanges)}</text>
<rect class="a-accent" x="722" y="512" width="230" height="44" rx="22"/>
<text class="a-white" x="837" y="539" font-size="15" text-anchor="middle">${esc(action)}</text>
</g>
<rect class="a-line" x="0.5" y="0.5" width="979" height="599" rx="17.5"/>
</svg>`;
}

const website = { '@type': 'WebSite', '@id': SITE_ID, url: url('/'), name: SITE.name, description: STRINGS.en.site.description, publisher: { '@id': ORG_ID }, inLanguage: LANGS.map(hreflang) };
const faqLd = (path, faqs) => ({ '@type': 'FAQPage', '@id': url(`${path}#faq`), mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
const crumbsLd = (path, items) => ({ '@type': 'BreadcrumbList', '@id': url(`${path}#breadcrumb`), itemListElement: items.map(([name, p], i) => ({ '@type': 'ListItem', position: i + 1, name, item: url(p) })) });
const appLd = (L, id, name, description, featureList, path) => ({
  '@type': 'WebApplication',
  '@id': id,
  name,
  url: url(path),
  description,
  inLanguage: hreflang(L),
  applicationCategory: 'UtilitiesApplication',
  applicationSubCategory: 'PDF editor',
  operatingSystem: 'Any (web browser)',
  browserRequirements: 'Requires JavaScript and WebAssembly. Works in current Safari, Chrome, Edge and Firefox.',
  featureList,
  isAccessibleForFree: true,
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  image: url('/og/home.png'),
  publisher: { '@id': ORG_ID },
});
const webPage = (L, path, name, description, extra = {}) => ({ '@type': 'WebPage', '@id': url(`${path}#webpage`), url: url(path), name, description, isPartOf: { '@id': SITE_ID }, dateModified: TODAY, inLanguage: hreflang(L), ...extra });

for (const L of LANGS) {
  const S = STRINGS[L];
  const p = prefix(L);
  const crumbs = (name) => `<nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="${p}/">${esc(S.nav.home)}</a></li><li aria-current="page">${esc(name)}</li></ol></nav>`;

  /* Tool pages */
  for (const t of TOOLS) {
    const s = S.tools[t.slug];
    const slugPath = `/${t.slug}/`;
    const path = `${p}${slugPath}`;
    const multi = t.multiple;
    const choose = t.accept === 'images' ? (multi ? S.common.chooseImages : S.common.chooseImage) : multi ? S.common.choosePdfs : S.common.choosePdf;
    const config = toolConfig(L, t);
    const jsonld = {
      '@context': 'https://schema.org',
      '@graph': [
        organization,
        website,
        webPage(L, path, s.title, s.description, { breadcrumb: { '@id': url(`${path}#breadcrumb`) }, mainEntity: { '@id': url(`${path}#app`) } }),
        appLd(L, url(`${path}#app`), `${s.name} · ${SITE.name}`, s.description, [s.short, s.steps[0], S.common.assureLocal, S.common.assureFree], path),
        crumbsLd(path, [[S.nav.home, `${p}/`], [s.name, path]]),
        faqLd(path, s.faqs),
      ],
    };
    render(
      L,
      slugPath,
      layout(L, {
        slugPath,
        title: `${s.title} | ${SITE.name}`,
        description: s.description,
        ogImage: `/og/${t.slug}.png`,
        jsonld,
        body: `<section class="hero tool-hero wrap">
${crumbs(s.name)}
<h1>${esc(s.h1)}</h1>
<p class="lead">${esc(s.lead)}</p>
<div id="app" class="app" data-tool="${esc(JSON.stringify(config))}">
<div class="drop">
<div class="glyph">${icon(t.icon, 56)}</div>
<label class="btn primary big"><input type="file" accept="${t.mime || (t.accept === 'images' ? 'image/*,.heic,.heif' : 'application/pdf,.pdf')}" ${multi ? 'multiple' : ''}>${esc(choose)}</label>
<p class="drop-hint">${esc(multi ? S.common.dropThem : S.common.dropIt)}</p>
</div>
</div>
<p class="assure">${LOCK}<span>${esc(S.common.assureLocal)} · ${esc(S.common.assureFree)} · ${esc(S.common.assureNoMark)}</span></p>
<noscript><p class="alert">${esc(S.common.noscript)}</p></noscript>
</section>
${section(`<h2 class="headline">${esc(s.howTo)}</h2><ol class="steps">${s.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>`, 'alt')}
${section(s.sections.map((x) => `<div class="split-copy"><h2>${esc(x.h)}</h2><p>${esc(x.p)}</p></div>`).join(''))}
${section(`<h2 class="headline">${esc(fill(S.common.questionsAbout, { name: s.name }))}</h2>${faqHtml(s.faqs)}`, 'alt', 'faq')}
${section(`<h2 class="headline">${esc(S.common.moreTools)}</h2>${chiclets(L, t.related)}`)}`,
      }),
    );
  }

  /* Home */
  {
    const path = `${p}/`;
    const jsonld = {
      '@context': 'https://schema.org',
      '@graph': [
        organization,
        website,
        webPage(L, path, `${SITE.name}: ${S.site.homeTitle}`, S.site.description, { about: { '@id': url(`${path}#app`) } }),
        appLd(L, url(`${path}#app`), SITE.name, S.site.description, TOOLS.map((t) => `${S.tools[t.slug].name}: ${S.tools[t.slug].short}`), path),
        { '@type': 'ItemList', '@id': url(`${path}#tools`), name: S.site.allTools, itemListElement: TOOLS.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: S.tools[t.slug].name, url: url(`${p}/${t.slug}/`) })) },
        faqLd(path, S.homeFaqs),
      ],
    };
    render(
      L,
      '/',
      layout(L, {
        slugPath: '/',
        title: `${SITE.name}: ${S.site.homeTitle}`,
        description: S.site.description,
        ogImage: '/og/home.png',
        jsonld,
        body: `<section class="hero home-hero wrap">
<h1>${esc(S.site.homeH1a)}<br><span class="soft">${esc(S.site.homeH1b)}</span></h1>
<p class="lead">${esc(S.site.homeLead)}</p>
<div class="hero-ctas"><a class="btn primary big" href="${p}/app/">${esc(S.studio?.cta ?? 'Open PDF Studio')}</a><a class="more" href="#tools">${esc(S.site.allTools)}</a></div>
<div class="hero-art"><div class="art-wide">${heroArt(L)}</div><div class="art-phone">${heroArt(L, true)}</div></div>
</section>
${section(`<h2 class="headline">${esc(S.site.allTools)}</h2>${toolGroups(L)}`, 'alt', 'tools')}
<section class="section dark"><div class="wrap statement">${icon('padlock', 44)}<h2 class="headline">${esc(S.site.privateH2)}</h2><p>${S.site.privateP1}</p><p>${fill(S.site.privateP2, { how: `${p}/how-it-works/` })}</p></div></section>
${section(`<h2 class="headline">${esc(S.site.whySwitch)}</h2>${points(L)}`)}
${section(`<h2 class="headline">${esc(S.site.faqTitle)}</h2>${faqHtml(S.homeFaqs)}`, 'alt', 'faq')}`,
      }),
    );
  }

  /* PDF Studio */
  {
    const st = { ...STUDIO_TEXT, ...(S.studio || {}) };
    const slugPath = '/app/';
    const path = `${p}${slugPath}`;
    const tools = GROUPS.flatMap(([, slugs]) => slugs)
      .filter((slug) => !STUDIO_SKIP.has(slug))
      .map((slug) => ({ ...toolConfig(L, toolBySlug[slug]), iconSvg: icon(toolBySlug[slug].icon, 28), final: STUDIO_FINAL.has(slug) }));
    const groups = GROUPS.map(([k, slugs]) => [S.footer[k], slugs.filter((x) => !STUDIO_SKIP.has(x))]);
    const jsonld = {
      '@context': 'https://schema.org',
      '@graph': [organization, website, webPage(L, path, st.title, st.description, { mainEntity: { '@id': url(`${path}#app`) } }), appLd(L, url(`${path}#app`), `${st.h1} · ${SITE.name}`, st.description, tools.map((x) => x.name), path), crumbsLd(path, [[S.nav.home, `${p}/`], [st.h1, path]])],
    };
    render(
      L,
      slugPath,
      layout(L, {
        slugPath,
        title: `${st.title}`.length > 60 ? st.title : `${st.title}`,
        description: st.description,
        ogImage: '/og/home.png',
        jsonld,
        bare: true,
        body: `<h1 class="visually-hidden">${esc(st.h1)}</h1>
<div id="studio" class="studio" data-home="${p}/" data-tools="${esc(JSON.stringify(tools))}" data-groups="${esc(JSON.stringify(groups))}"></div>
<noscript><p class="alert">${esc(S.common.noscript)}</p></noscript>
<p class="visually-hidden">${esc(st.lead)}</p>`,
      }),
    );
  }

  // The app used to live at /studio/; keep old links working.
  {
    const dir = join(DIST, prefix(L), 'studio');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><link rel="canonical" href="${url(`${p}/app/`)}"><meta http-equiv="refresh" content="0; url=${p}/app/"><title>Scissor PDF</title><a href="${p}/app/">${esc(S.studio?.cta ?? 'Open the app')}</a>`);
  }

  /* How it works, privacy */
  for (const [key, slugPath] of [['how', '/how-it-works/'], ['privacy', '/privacy/']]) {
    const a = S.pages[key];
    const path = `${p}${slugPath}`;
    const jsonld = {
      '@context': 'https://schema.org',
      '@graph': [organization, website, webPage(L, path, a.title, a.description, { breadcrumb: { '@id': url(`${path}#breadcrumb`) } }), crumbsLd(path, [[S.nav.home, `${p}/`], [a.h1, path]])],
    };
    render(
      L,
      slugPath,
      layout(L, {
        slugPath,
        title: `${a.title} | ${SITE.name}`,
        description: a.description,
        ogImage: '/og/home.png',
        jsonld,
        body: `<section class="hero tool-hero wrap">${crumbs(a.h1)}<h1>${esc(a.h1)}</h1><p class="lead">${esc(a.lead)}</p></section>
${section(`<article class="prose">${a.body.replace(/<(\/?)h3>/g, '<$1h2>')}</article>`, 'alt')}
${section(`<h2 class="headline">${esc(S.common.tryTool)}</h2>${chiclets(L, ['merge-pdf', 'compress-pdf', 'split-pdf', 'jpg-to-pdf', 'organize-pdf', 'protect-pdf'])}`)}`,
      }),
    );
  }
}

/* Comparison page (English) */
const COMPARE = JSON.parse(readFileSync(join(ROOT, 'site/pages/compare.json'), 'utf8'));
{
  const c = COMPARE;
  const S = STRINGS.en;
  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      organization,
      website,
      webPage('en', c.slug, c.title, c.description, { breadcrumb: { '@id': url(`${c.slug}#breadcrumb`) }, about: { '@id': url('/#app') } }),
      crumbsLd(c.slug, [[S.nav.home, '/'], [c.h1, c.slug]]),
      faqLd(c.slug, c.faqs),
    ],
  };
  const [head, ...rows] = [['', 'Scissor PDF', 'iLovePDF', 'Smallpdf'], ...c.rows];
  const html = layout('en', {
    slugPath: c.slug,
    title: `${c.title} | ${SITE.name}`,
    description: c.description,
    ogImage: '/og/home.png',
    jsonld,
    body: `<section class="hero tool-hero wrap"><nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="/">${esc(S.nav.home)}</a></li><li aria-current="page">${esc(c.h1)}</li></ol></nav><h1>${esc(c.h1)}</h1><p class="lead">${esc(c.lead)}</p></section>
${section(`<div class="table-wrap"><table class="compare"><caption class="visually-hidden">${esc(c.title)}</caption>
<thead><tr>${head.map((h, i) => (i ? `<th scope="col">${esc(h)}</th>` : '<td></td>')).join('')}</tr></thead>
<tbody>${rows.map((r) => `<tr><th scope="row">${esc(r[0])}</th>${r.slice(1).map((v, i) => `<td${i === 0 ? ' class="us"' : ''}>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
<p class="hint">Based on each company's own published pages, checked <time datetime="${c.checked}">${c.checked}</time>. Plans and features change; check the sources below.</p>`, 'alt')}
${section(`${c.sections.map((x) => `<div class="split-copy"><h2>${esc(x.h)}</h2><p>${x.p}</p></div>`).join('')}<div class="split-copy"><h2>Sources</h2><p>${c.sources.map(([n, u]) => `<a href="${u}" rel="nofollow noopener">${esc(n)}</a>`).join('<br>')}</p></div>`)}
${section(`<h2 class="headline">${esc(S.site.faqTitle)}</h2>${faqHtml(c.faqs)}`, 'alt', 'faq')}
${section(`<h2 class="headline">${esc(S.common.tryTool)}</h2>${chiclets('en', ['merge-pdf', 'compress-pdf', 'split-pdf', 'jpg-to-pdf', 'organize-pdf', 'protect-pdf'])}`)}`,
  }).replace(/<link rel="alternate" hreflang[^>]*>\n/g, '');
  const dir = join(DIST, c.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), html);
}

/* 404 (English; Caddy serves it for every unknown path) */
{
  const S = STRINGS.en;
  const html = layout('en', {
    slugPath: '/',
    title: `${S.pages.notFound.title} | ${SITE.name}`,
    description: S.pages.notFound.lead,
    ogImage: '/og/home.png',
    jsonld: { '@context': 'https://schema.org', '@graph': [organization, website] },
    body: `<section class="hero tool-hero wrap"><h1>${esc(S.pages.notFound.h1)}</h1><p class="lead">${esc(S.pages.notFound.lead)}</p></section>
${section(toolGroups('en'))}`,
  })
    .replace(/<link rel="canonical"[^>]*>\n/, '<meta name="robots" content="noindex">\n')
    .replace(/<link rel="alternate" hreflang[^>]*>\n/g, '');
  writeFileSync(join(DIST, '404.html'), html);
}

/* ---------- Crawlers, feeds, PWA ---------- */

writeFileSync(
  join(DIST, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${pages
  .flatMap((slugPath) =>
    LANGS.map(
      (L) => `  <url><loc>${url(prefix(L) + slugPath)}</loc>
${LANGS.map((c) => `    <xhtml:link rel="alternate" hreflang="${hreflang(c)}" href="${url(prefix(c) + slugPath)}"/>`).join('\n')}
    <xhtml:link rel="alternate" hreflang="x-default" href="${url(slugPath)}"/>
  </url>`,
    ),
  )
  .join('\n')}
  <url><loc>${url(COMPARE.slug)}</loc></url>
</urlset>
`,
);
writeFileSync(join(DIST, 'robots.txt'), `# Search and AI crawlers are welcome.\nUser-agent: *\nAllow: /\n\nSitemap: ${url('/sitemap.xml')}\n`);
{
  const S = STRINGS.en;
  writeFileSync(
    join(DIST, 'llms.txt'),
    `# ${SITE.name}\n\n> ${S.site.description}\n\nAll processing happens locally in the browser (Rust compiled to WebAssembly, plus PDF.js for rendering). Files are never uploaded. Free, no account, no watermark, works offline after the first visit. Available in ${LANGS.length} languages: ${LANGS.map((c) => STRINGS[c].meta.name).join(', ')}.\n\n## Tools\n\n${TOOLS.map((t) => `- [${S.tools[t.slug].name}](${url(`/${t.slug}/`)}): ${S.tools[t.slug].short}`).join('\n')}\n\n## About\n\n- [How it works](${url('/how-it-works/')}): how local processing works and how to verify no upload happens\n- [Privacy](${url('/privacy/')})\n- [Scissor PDF vs iLovePDF vs Smallpdf](${url('/ilovepdf-smallpdf-alternative/')}): honest comparison of privacy, limits and features\n`,
  );
}
writeFileSync(
  join(DIST, 'manifest.webmanifest'),
  JSON.stringify(
    {
      name: SITE.name,
      short_name: 'Scissor PDF',
      description: STRINGS.en.site.description,
      id: '/app/',
      start_url: '/app/',
      scope: '/',
      display: 'standalone',
      background_color: '#fbfbfd',
      theme_color: '#fbfbfd',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
      shortcuts: ['merge-pdf', 'compress-pdf', 'split-pdf', 'jpg-to-pdf'].map((s) => ({ name: STRINGS.en.tools[s].name, url: `/${s}/` })),
      categories: ['productivity', 'utilities'],
      file_handlers: [{ action: '/app/', accept: { 'application/pdf': ['.pdf'] }, launch_type: 'single-client' }],
      launch_handler: { client_mode: 'focus-existing' },
    },
    null,
    2,
  ),
);

// Service worker: precache the app shell so every tool works offline after one visit.
// Pages in other languages are cached the first time they are opened.
const precache = [
  ...pages,
  `/assets/app.css?v=${V}`,
  `/assets/app.js?v=${V}`,
  `/assets/worker.js?v=${V}`,
  `/engine/engine.js?v=${V}`,
  `/engine/engine_bg.wasm?v=${V}`,
  `${PDFJS_PATH}/pdf.min.js`,
  `${PDFJS_PATH}/pdf.worker.min.js`,
  '/favicon.svg',
  '/manifest.webmanifest',
];
writeFileSync(
  join(DIST, 'sw.js'),
  `// Generated by scripts/build.mjs. Caches the app for offline use; never sees user files.
const CACHE = 'scissor-pdf-${V}';
const PRECACHE = ${JSON.stringify(precache)};
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== location.origin) return;
  if (req.mode === 'navigate') {
    // Pages: fresh when online, cached when offline.
    e.respondWith(fetch(req).then((res) => {
      const copy = res.clone();
      if (res.ok) caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('/'))));
    return;
  }
  // Versioned files never change: cache first, and keep PDF.js fonts and maps once used.
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  })));
});
`,
);

/* ---------- Report ---------- */

const size = (p) => (statSync(p).isDirectory() ? readdirSync(p).reduce((s, f) => s + size(join(p, f)), 0) : statSync(p).size);
console.log(`Built ${pages.length} pages × ${LANGS.length} languages (${LANGS.join(', ')}) into ${relative(ROOT, DIST)}/ (version ${V}, ${(size(DIST) / 1048576).toFixed(1)} MB, engine ${(size(join(DIST, 'engine/engine_bg.wasm')) / 1048576).toFixed(2)} MB)`);
