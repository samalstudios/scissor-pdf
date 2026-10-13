// Tool settings shared by every language. All visible text lives in site/i18n/<code>.json;
// the build renders each page's copy, <head> tags and structured data from the same entry.

export const SITE = {
  name: 'Scissor PDF',
  origin: 'https://pdf.scissor.studio',
  org: { name: 'Scissor', url: 'https://scissor.studio' },
};

const ICONS = {
  merge: '<path d="M9 3h7l4 4v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M4 7v12a2 2 0 0 0 2 2h9"/><path d="M13.5 8v6M10.5 11h6"/>',
  split: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.1 8.1 20 20M8.1 15.9 20 4"/>',
  compress: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  organize: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  rotate: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  delete: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  extract: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 18v-6m-3 3 3-3 3 3"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  toImage: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="m8 17 3-3 2 2 2-2 1 1"/>',
  numbers: '<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/>',
  watermark: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  bolt: '<path d="M13 2.5 4.5 13.5h6.5l-1 8 8.5-11h-6.5z"/>',
  tag: '<path d="M3 11.5V4a1 1 0 0 1 1-1h7.5l9.5 9.5-8.5 8.5z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  sign: '<path d="M3 21h18"/><path d="M15 4.5 19.5 9 9 19.5H4.5V15z"/><path d="m13 6.5 4.5 4.5"/>',
  text: '<path d="M5 7V5h14v2M12 5v14M9 19h6"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  nup: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16M6.5 9h3M6.5 12h3M14.5 9h3M14.5 12h3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.6v.4"/>',
  repair: '<path d="M14.7 6.3a4 4 0 0 0-5.3 5.3L3.5 17.5a2.1 2.1 0 0 0 3 3l5.9-5.9a4 4 0 0 0 5.3-5.3l-2.6 2.6-2.5-.5-.5-2.5z"/>',
  unlock: '<rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 7.5-2"/>',
};

export const icon = (name, size = 24) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

export const TOOLS = [
  { slug: 'merge-pdf', icon: 'merge', color: '#0A84FF', mode: 'merge', accept: 'pdf', multiple: true, related: ['split-pdf', 'organize-pdf', 'compress-pdf', 'jpg-to-pdf'] },
  { slug: 'split-pdf', icon: 'split', color: '#FF375F', mode: 'split', accept: 'pdf', related: ['extract-pdf-pages', 'merge-pdf', 'delete-pdf-pages', 'organize-pdf'] },
  { slug: 'compress-pdf', icon: 'compress', color: '#30D158', mode: 'compress', accept: 'pdf', related: ['merge-pdf', 'split-pdf', 'jpg-to-pdf', 'protect-pdf'] },
  { slug: 'organize-pdf', icon: 'organize', color: '#BF5AF2', mode: 'organize', accept: 'pdf', related: ['rotate-pdf', 'delete-pdf-pages', 'merge-pdf', 'extract-pdf-pages'] },
  { slug: 'rotate-pdf', icon: 'rotate', color: '#FF9F0A', mode: 'rotate', accept: 'pdf', related: ['organize-pdf', 'merge-pdf', 'compress-pdf', 'add-page-numbers'] },
  { slug: 'delete-pdf-pages', icon: 'delete', color: '#FF453A', mode: 'delete', accept: 'pdf', related: ['extract-pdf-pages', 'organize-pdf', 'split-pdf', 'compress-pdf'] },
  { slug: 'extract-pdf-pages', icon: 'extract', color: '#0FB5AE', mode: 'extract', accept: 'pdf', related: ['split-pdf', 'delete-pdf-pages', 'merge-pdf', 'pdf-to-jpg'] },
  { slug: 'jpg-to-pdf', icon: 'image', color: '#FFB300', mode: 'images', accept: 'images', multiple: true, related: ['pdf-to-jpg', 'merge-pdf', 'compress-pdf', 'organize-pdf'] },
  { slug: 'pdf-to-jpg', icon: 'toImage', color: '#5E5CE6', mode: 'toImages', accept: 'pdf', related: ['jpg-to-pdf', 'extract-pdf-pages', 'compress-pdf', 'split-pdf'] },
  { slug: 'add-page-numbers', icon: 'numbers', color: '#A2845E', mode: 'numbers', accept: 'pdf', related: ['watermark-pdf', 'organize-pdf', 'merge-pdf', 'compress-pdf'] },
  { slug: 'watermark-pdf', icon: 'watermark', color: '#32ADE6', mode: 'watermark', accept: 'pdf', related: ['protect-pdf', 'add-page-numbers', 'compress-pdf', 'merge-pdf'] },
  { slug: 'protect-pdf', icon: 'lock', color: '#3A3A3C', mode: 'protect', accept: 'pdf', related: ['unlock-pdf', 'watermark-pdf', 'compress-pdf', 'merge-pdf'] },
  { slug: 'unlock-pdf', icon: 'unlock', color: '#34C759', mode: 'unlock', accept: 'pdf', related: ['protect-pdf', 'compress-pdf', 'merge-pdf', 'split-pdf'] },
  { slug: 'sign-pdf', icon: 'sign', color: '#0A84FF', mode: 'place', accept: 'pdf', related: ['add-text-to-pdf', 'protect-pdf', 'merge-pdf', 'compress-pdf'] },
  { slug: 'add-text-to-pdf', icon: 'text', color: '#0A84FF', mode: 'place', accept: 'pdf', related: ['sign-pdf', 'add-page-numbers', 'watermark-pdf', 'merge-pdf'] },
  { slug: 'crop-pdf', icon: 'crop', color: '#0A84FF', mode: 'crop', accept: 'pdf', related: ['organize-pdf', 'rotate-pdf', 'pages-per-sheet', 'compress-pdf'] },
  { slug: 'pages-per-sheet', icon: 'nup', color: '#0A84FF', mode: 'nup', accept: 'pdf', related: ['crop-pdf', 'merge-pdf', 'compress-pdf', 'organize-pdf'] },
  { slug: 'edit-pdf-metadata', icon: 'info', color: '#0A84FF', mode: 'metadata', accept: 'pdf', related: ['protect-pdf', 'compress-pdf', 'watermark-pdf', 'repair-pdf'] },
  { slug: 'repair-pdf', icon: 'repair', color: '#0A84FF', mode: 'repair', accept: 'pdf', related: ['compress-pdf', 'unlock-pdf', 'merge-pdf', 'split-pdf'] },
];

export const toolBySlug = Object.fromEntries(TOOLS.map((t) => [t.slug, t]));
