// Generates app icons and per-tool social images (1200x630) into site/public with AppKit,
// so they use the system's SF Pro font. Run on macOS when tools change: node scripts/assets.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE, TOOLS, icon } from '../site/tools.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'site/public');
const TMP = join(ROOT, '.cache');
mkdirSync(join(PUB, 'og'), { recursive: true });
mkdirSync(TMP, { recursive: true });
const bin = join(TMP, 'render-svg');
execFileSync('swiftc', ['-O', join(ROOT, 'scripts/render-svg.swift'), '-o', bin]);
const render = (svg, out, w, h) => {
  const f = join(TMP, 'tmp.svg');
  writeFileSync(f, svg);
  execFileSync(bin, [f, out, String(w), String(h)]);
};

const fav = readFileSync(join(PUB, 'favicon.svg'), 'utf8');
for (const [name, size] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  // Touch and PWA icons get a full-bleed background; the OS applies its own mask.
  const svg = name === 'favicon-32.png' ? fav : fav.replace('rx="15"', 'rx="0"');
  render(svg, join(PUB, name), size, size);
}

const glyph = (name) => icon(name).replace(/<svg[^>]*>/, '').replace('</svg>', '');
const og = ({ title, subtitle, iconName }) => `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#ffffff"/>
<g transform="translate(96 112) scale(3.2)" fill="none" stroke="#1d1d1f" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${glyph(iconName)}</g>
<text x="90" y="372" font-family="SF Pro Display, -apple-system, Helvetica Neue, sans-serif" font-size="${title.length > 14 ? 92 : 104}" font-weight="600" letter-spacing="-2" fill="#1d1d1f">${title}</text>
<text x="94" y="438" font-family="SF Pro Text, -apple-system, Helvetica Neue, sans-serif" font-size="34" fill="#86868b">${subtitle}</text>
<g transform="translate(96 520) scale(1.25)" fill="none" stroke="#1d1d1f" stroke-width="1.9" stroke-linecap="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.1 8.1 20 20M8.1 15.9 20 4"/></g>
<text x="136" y="544" font-family="SF Pro Text, -apple-system, Helvetica Neue, sans-serif" font-size="27" font-weight="600" fill="#1d1d1f">${SITE.name}</text>
<text x="1104" y="544" text-anchor="end" font-family="SF Pro Text, -apple-system, Helvetica Neue, sans-serif" font-size="25" fill="#86868b">pdf.scissor.studio</text>
</svg>`;

render(og({ title: 'Every PDF tool.', subtitle: 'Nothing uploaded. Free, in your browser.', iconName: 'split' }), join(PUB, 'og/home.png'), 1200, 630);
const EN = JSON.parse(readFileSync(join(ROOT, 'site/i18n/en.json'), 'utf8'));
for (const t of TOOLS) render(og({ title: EN.tools[t.slug].name, subtitle: 'Free, in your browser. Nothing uploaded.', iconName: t.icon }), join(PUB, `og/${t.slug}.png`), 1200, 630);
console.log(`Generated icons and ${TOOLS.length + 1} social images in site/public`);
