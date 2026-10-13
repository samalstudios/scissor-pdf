// Checks translations against site/i18n/en.json: same keys, same {placeholders}, same HTML tags
// and links, valid plural categories, and title/description lengths that fit search results.
// node scripts/i18n-check.mjs [code...]
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../site/i18n');
const en = JSON.parse(readFileSync(join(DIR, 'en.json'), 'utf8'));
const codes = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'en.json').map((f) => f.slice(0, -5));
const PLURAL = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const isPlural = (o) => o && typeof o === 'object' && !Array.isArray(o) && 'other' in o && Object.keys(o).every((k) => PLURAL.has(k));
const holes = (s) => [...s.matchAll(/\{[a-zA-Z0-9]+\}/g)].map((m) => m[0]).sort().join(',');
const tags = (s) => [...s.matchAll(/<\/?([a-z0-9]+)[^>]*>/gi)].map((m) => m[1].toLowerCase()).sort().join(',');
const hrefs = (s) => [...s.matchAll(/href="([^"]*)"/g)].map((m) => m[1]).sort().join(',');
let failed = false;

for (const code of codes) {
  const errors = [];
  let tr;
  try {
    tr = JSON.parse(readFileSync(join(DIR, `${code}.json`), 'utf8'));
  } catch (e) {
    console.log(`${code}: cannot read (${e.message})`);
    failed = true;
    continue;
  }
  const rules = new Intl.PluralRules(code === 'ku' ? 'tr' : code).resolvedOptions().pluralCategories;
  const walk = (a, b, path) => {
    if (isPlural(a)) {
      if (!isPlural(b)) return errors.push(`${path}: must be a plural object`);
      for (const c of rules) if (!(c in b)) errors.push(`${path}: missing plural form "${c}"`);
      for (const [k, v] of Object.entries(b)) if (holes(v) !== '{n}') errors.push(`${path}.${k}: needs exactly {n}`);
      return;
    }
    if (typeof a === 'string') {
      if (typeof b !== 'string') return errors.push(`${path}: missing or not text`);
      if (!b.trim()) errors.push(`${path}: empty`);
      if (holes(a) !== holes(b)) errors.push(`${path}: placeholders ${holes(b) || 'none'} ≠ ${holes(a)}`);
      if (tags(a) !== tags(b)) errors.push(`${path}: HTML tags differ`);
      if (hrefs(a) !== hrefs(b)) errors.push(`${path}: links differ`);
      return;
    }
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return errors.push(`${path}: expected ${a.length} items`);
      return a.forEach((x, i) => walk(x, b[i], `${path}[${i}]`));
    }
    for (const k of Object.keys(a)) {
      if (path === 'meta') continue;
      if (!(k in (b || {}))) errors.push(`${path ? path + '.' : ''}${k}: missing`);
      else walk(a[k], b[k], `${path ? path + '.' : ''}${k}`);
    }
    for (const k of Object.keys(b || {})) if (!(k in a)) errors.push(`${path ? path + '.' : ''}${k}: unknown key`);
  };
  walk(en, tr, '');
  const m = tr.meta || {};
  if (m.code !== code || !m.name || !['ltr', 'rtl'].includes(m.dir) || !m.ogLocale) errors.push('meta: needs code, name, dir (ltr|rtl), ogLocale');
  for (const [slug, t] of Object.entries(tr.tools || {})) {
    if ((t.title || '').length > 46) errors.push(`tools.${slug}.title: ${t.title.length} chars, max 46`);
    if ((t.description || '').length > 165) errors.push(`tools.${slug}.description: ${t.description.length} chars, max 165`);
  }
  if (errors.length) failed = true;
  console.log(errors.length ? `${code}: ${errors.length} problem(s)\n  ${errors.slice(0, 40).join('\n  ')}` : `${code}: OK`);
}
process.exit(failed ? 1 : 0);
