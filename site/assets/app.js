// Scissor PDF front end. Reads files into memory, previews them with PDF.js and hands
// the actual PDF work to the Rust/WebAssembly engine in a worker. Nothing is uploaded.

const V = document.documentElement.dataset.v || '';
const PDFJS = document.documentElement.dataset.pdfjs;
const $ = (sel, el = document) => el.querySelector(sel);
const h = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`);
const baseName = (name) => name.replace(/\.[^.]+$/, '') || 'document';
// Interface text for the page's language, embedded by the build (site/i18n/<code>.json).
const I18N = JSON.parse(document.getElementById('i18n')?.textContent || '{"ui":{},"langs":[]}');
const fill = (s, vars = {}) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
const t = (key, vars) => fill(I18N.ui[key] ?? key, vars);
// Text with an English default, for strings that may not be translated yet.
const ts = (key, fallback, vars) => fill(I18N.ui[key] ?? fallback, vars);
const pluralRules = new Intl.PluralRules(I18N.code === 'ku' ? 'tr' : I18N.code || 'en');
const tp = (key, n) => {
  const forms = I18N.ui[key] || {};
  return fill(forms[pluralRules.select(n)] ?? forms.other ?? `${n}`, { n });
};
const ICON = {
  rotate: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  rotateLeft: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11a8 8 0 1 1 2.3 5.7"/><path d="M4 4v7h7"/></svg>',
  close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  tick: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>',
  lock: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  plus: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  left: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6"/></svg>',
  right: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
};

if ('ontouchstart' in window) document.documentElement.classList.add('touch');

// Safety net: anything unexpected gets a calm message instead of a silently broken page.
let lastProblem = 0;
function reportProblem(err) {
  console.error(err);
  if (Date.now() - lastProblem < 4000) return;
  lastProblem = Date.now();
  let box = document.querySelector('.problem-toast');
  if (!box) {
    box = document.createElement('div');
    box.className = 'problem-toast';
    box.setAttribute('role', 'alert');
    document.body.append(box);
  }
  box.textContent = ts('errUnexpected', 'Something went wrong. Your files never left this device. Please try again.');
  box.hidden = false;
  setTimeout(() => (box.hidden = true), 6000);
}
addEventListener('error', (e) => e.error && reportProblem(e.error));
addEventListener('unhandledrejection', (e) => reportProblem(e.reason));

// Offline support: the service worker caches the app after the first visit.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

/* ---------- Engine (Rust → WebAssembly, in a worker) ---------- */

let worker;
let seq = 0;
const pending = new Map();
function engine(op, args, transfer = []) {
  if (!worker) {
    worker = new Worker(`/assets/worker.js?v=${V}`, { type: 'module' });
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      pending.delete(data.id);
      data.error ? p.reject(new Error(data.error)) : p.resolve(data.out);
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(t('errEngine')));
      pending.clear();
      worker = null;
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, op, args }, transfer);
  });
}

/* ---------- PDF.js previews ---------- */

let pdfjsLib;
async function pdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import(`${PDFJS}/pdf.min.js`);
    pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.js`;
  }
  return pdfjsLib;
}
async function openPdf(bytes, password) {
  const lib = await pdfjs();
  return lib.getDocument({
    data: bytes.slice(),
    password,
    isEvalSupported: false,
    cMapUrl: `${PDFJS}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS}/standard_fonts/`,
    wasmUrl: `${PDFJS}/wasm/`,
    iccUrl: `${PDFJS}/iccs/`,
  }).promise;
}
const renderQueue = [];
let rendering = 0;
function renderThumb(doc, pageNo, target, size = 220) {
  return new Promise((resolve) => {
    renderQueue.push(async () => {
      try {
        const page = await doc.getPage(pageNo);
        const base = page.getViewport({ scale: 1 });
        const dpr = Math.min(devicePixelRatio || 1, 2);
        const scale = (size * dpr) / Math.max(base.width, base.height);
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        canvas.style.width = `${Math.round(vp.width / dpr)}px`;
        await page.render({ canvas, viewport: vp }).promise;
        target.replaceChildren(canvas);
        resolve(canvas);
      } catch {
        resolve(null);
      }
    });
    pump();
  });
}
function pump() {
  while (rendering < 2 && renderQueue.length) {
    rendering++;
    renderQueue.shift()().finally(() => {
      rendering--;
      pump();
    });
  }
}
// Render thumbnails only once they scroll into view: large PDFs stay fast.
const lazy = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      lazy.unobserve(e.target);
      e.target._render?.();
    }
  },
  { rootMargin: '400px' },
);

/* ---------- Handoff between tools ("Continue with…") ---------- */

const idb = () =>
  new Promise((res, rej) => {
    const r = indexedDB.open('scissor-pdf', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('handoff');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
async function handoffPut(value) {
  const db = await idb();
  await new Promise((res, rej) => {
    const tx = db.transaction('handoff', 'readwrite');
    tx.objectStore('handoff').put(value, 'file');
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
async function handoffTake() {
  const db = await idb();
  return new Promise((res) => {
    const tx = db.transaction('handoff', 'readwrite');
    const store = tx.objectStore('handoff');
    const get = store.get('file');
    get.onsuccess = () => {
      store.delete('file');
      res(get.result);
    };
    get.onerror = () => res(null);
  });
}

/* ---------- Sortable grid (mouse, trackpad and touch) ---------- */

function sortable(container, onChange) {
  let drag = null;
  container.addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.card.sortable');
    if (!card || e.target.closest('button, input') || e.button > 0) return;
    drag = { card, x: e.clientX, y: e.clientY, started: false, id: e.pointerId };
  });
  addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
      drag.started = true;
      const r = drag.card.getBoundingClientRect();
      drag.dx = drag.x - r.left;
      drag.dy = drag.y - r.top;
      drag.ghost = drag.card.cloneNode(true);
      drag.ghost.classList.add('ghost');
      drag.ghost.style.width = `${r.width}px`;
      for (const c of drag.card.querySelectorAll('canvas')) {
        const copy = drag.ghost.querySelector('canvas');
        if (copy) copy.getContext('2d').drawImage(c, 0, 0);
      }
      document.body.append(drag.ghost);
      drag.card.classList.add('dragging');
    }
    e.preventDefault();
    drag.ghost.style.left = `${e.clientX - drag.dx}px`;
    drag.ghost.style.top = `${e.clientY - drag.dy}px`;
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.card.sortable');
    if (over && over !== drag.card && over.parentNode === container) {
      const cards = [...container.querySelectorAll('.card.sortable')];
      const before = cards.indexOf(over) < cards.indexOf(drag.card);
      flip(container, () => over.parentNode.insertBefore(drag.card, before ? over : over.nextSibling));
    }
  }, { passive: false });
  const end = () => {
    if (!drag) return;
    if (drag.started) {
      container._dragEnded = Date.now();
      drag.ghost.remove();
      drag.card.classList.remove('dragging');
      onChange([...container.querySelectorAll('.card.sortable')].map((c) => c.dataset.key));
    }
    drag = null;
  };
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
}
// Animates cards from their old to their new positions.
function flip(container, mutate) {
  const cards = [...container.children];
  const before = new Map(cards.map((c) => [c, c.getBoundingClientRect()]));
  mutate();
  for (const c of cards) {
    const a = before.get(c);
    const b = c.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (!dx && !dy) continue;
    c.style.transition = 'none';
    c.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => {
      c.style.transition = '';
      c.style.transform = '';
    });
  }
}

/* ---------- Page ranges ---------- */

function parseRanges(text, max) {
  const groups = [];
  for (const part of text.split(/[,;]+/).map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*(?:[-–]\s*(\d+|end)?)?$/i);
    if (!m) throw new Error(t('notARange', { part }));
    const a = +m[1];
    const b = m[2] === undefined ? (part.includes('-') || part.includes('–') ? max : a) : m[2].toLowerCase() === 'end' ? max : +m[2];
    if (a < 1 || b < 1 || a > max || b > max) throw new Error(t('pdfHas', { pages: tp('pages', max) }));
    const g = [];
    for (let i = a; a <= b ? i <= b : i >= b; a <= b ? i++ : i--) g.push(i);
    groups.push(g);
  }
  return groups;
}
function formatRanges(nums) {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j;
  }
  return out.join(', ');
}

/* ---------- App ---------- */

// Tools whose screen is only a set of options (no page picking or placing).
const PANEL_ONLY = new Set(['simple', 'compress', 'protect', 'metadata', 'resize', 'margins', 'booklet', 'nup', 'half', 'blank', 'splitSize', 'headerFooter', 'bates', 'toText', 'toEpub']);

const appRoot = $('#app');
if (appRoot) start(JSON.parse(appRoot.dataset.tool));

// Runs one tool. On a tool page it owns #app; inside PDF Studio it renders into
// `opts.root`, starts with `opts.files`, and hands results to `opts.onResult`.
function start(tool, opts = {}) {
  const embedded = !!opts.root;
  const root = opts.root || appRoot;
  const isImages = tool.accept === 'images';
  const isEpub = tool.accept === 'epub';
  const state = { files: [], options: {}, pages: [], result: null };
  const input = embedded ? h(`<input type="file" hidden accept="${isEpub ? 'application/epub+zip,.epub' : `application/pdf,.pdf${tool.mode === 'merge' ? ',image/*' : ''}`}" ${tool.multiple ? 'multiple' : ''}>`) : $('input[type=file]', root);
  if (embedded) document.body.append(input);
  const dropZone = $('.drop', root);
  const veil = h(`<div class="drop-veil" aria-hidden="true">${esc(t('dropToAdd'))}</div>`);
  if (!embedded) document.body.append(veil);

  const isImageFile = (f) => f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp|gif|avif|bmp)$/i.test(f.name);
  const accepts = (f) => (isEpub ? /\.epub$/i.test(f.name) || f.type === 'application/epub+zip' : null) ?? ((tool.mode === 'merge' && isImageFile(f)) || (isImages ? f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp|gif|avif|bmp)$/i.test(f.name) : f.type === 'application/pdf' || /\.pdf$/i.test(f.name)));

  input.addEventListener('change', () => {
    addFiles([...input.files]);
    input.value = '';
  });
  let depth = 0;
  if (!embedded) addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    depth++;
    document.body.classList.add('dragging');
  });
  if (!embedded) addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      document.body.classList.remove('dragging');
    }
  });
  if (!embedded) addEventListener('dragover', (e) => e.preventDefault());
  if (!embedded) addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    if (state.result) return;
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) addFiles(files);
  });

  if (!embedded && location.hash === '#handoff') {
    history.replaceState(null, '', location.pathname);
    handoffTake()
      .then((f) => f && addFiles([new File([f.bytes], f.name, { type: f.type })]))
      .catch(() => {});
  }

  function showError(message) {
    const old = $('.alert', root);
    old?.remove();
    // Engine errors start with a code; show the translated message for it.
    const code = message.match(/^([A-Z]+):\s*/)?.[1];
    const unlockUrl = `${I18N.langs.find((l) => l.code === I18N.code)?.prefix || ''}/unlock-pdf/`;
    let text;
    if (code === 'ENCRYPTED') text = `${esc(message.includes('"') ? message.replace(/^[A-Z]+:\s*/, '') : t('errEncrypted'))} ${t('errUnlockFirst', { url: unlockUrl })}`;
    else if (code === 'PASSWORD') text = esc(t('errPassword'));
    else if (code === 'INVALID') text = `${esc(t('errInvalid'))} <small>(${esc(message.replace(/^[A-Z]+:\s*/, ''))})</small>`;
    else text = esc(message);
    const el = h(`<div class="alert" role="alert"><b>!</b><div>${text}</div></div>`);
    root.prepend(el);
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function addFiles(list) {
    $('.alert', root)?.remove();
    const ok = list.filter(accepts);
    if (!ok.length) return showError(isEpub ? t('errChooseEpub') : isImages ? t('errChooseImages') : t('errChoosePdf'));
    if (!tool.multiple) {
      state.files = [];
      ok.splice(1);
    }
    for (const file of ok) {
      const entry = { key: crypto.randomUUID(), file, name: file.name, size: file.size };
      entry.bytes = new Uint8Array(await file.arrayBuffer());
      // Merge also takes images: each becomes a one-page PDF first.
      if (tool.mode === 'merge' && isImageFile(file)) {
        const img = /jpe?g$/i.test(file.type) || /\.jpe?g$/i.test(file.name) ? { jpeg: true, data: entry.bytes.slice() } : { jpeg: false, ...(await decodeImage(file)) };
        entry.bytes = await engine('images', { images: [img], paper: 'fit', margin: 0 }, [img.data.buffer]);
      }
      if (isEpub) entry.epub = true;
      else if (!isImages) {
        try {
          entry.doc = await openPdf(entry.bytes);
          entry.pageCount = entry.doc.numPages;
        } catch (e) {
          if (e?.name === 'PasswordException') {
            if (tool.mode !== 'unlock') {
              showError(`ENCRYPTED: ${t('errProtected', { name: file.name })}`);
              continue;
            }
            entry.locked = true;
          } else if (tool.mode === 'repair') {
            entry.broken = true;
          } else {
            showError(t('errDamaged', { name: file.name }));
            continue;
          }
        }
      } else {
        entry.url = URL.createObjectURL(file);
      }
      state.files.push(entry);
    }
    if (!state.files.length) return;
    if (tool.mode === 'compare' || tool.mode === 'mix') state.files = state.files.slice(-2);
    if (tool.mode === 'background') state.files = state.files.slice(-2);
    if (['organize', 'rotate', 'delete', 'extract', 'split', 'toImages', 'longImage', 'bookmarks'].includes(tool.mode)) {
      const n = state.files[0].pageCount;
      state.pages = Array.from({ length: n }, (_, i) => ({ n: i + 1, rot: 0, on: tool.mode === 'toImages' || tool.mode === 'longImage' }));
    }
    render();
    if (tool.autoBlank) detectBlankPages();
    if (tool.mode === 'info') showInfo();
  }

  function reset() {
    if (embedded) {
      dropBar();
      input.remove();
      return opts.onCancel?.();
    }
    for (const f of state.files) f.url && URL.revokeObjectURL(f.url);
    if (state.result?.url) URL.revokeObjectURL(state.result.url);
    Object.assign(state, { files: [], pages: [], result: null, options: {} });
    dropBar();
    root.replaceChildren(dropZone);
    $('.assure')?.removeAttribute('hidden');
    root.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  /* ----- Work view ----- */

  function render() {
    // Inside the app, options-only tools show just their panel; the pages stay on the canvas.
    if (opts.panelHost && PANEL_ONLY.has(tool.mode)) {
      const panel = h(`<div class="panel inspector-panel" aria-label="${esc(t('options'))}"></div>`);
      panel.append(...buildPanel());
      opts.panelHost.replaceChildren(panel);
      return;
    }
    $('.assure')?.setAttribute('hidden', '');
    const work = h(`<div class="work"><div class="stage"></div><aside class="panel" aria-label="${esc(t('options'))}"></aside></div>`);
    root.replaceChildren(work);
    const stage = $('.stage', work);
    const panel = $('.panel', work);
    const views = { merge: viewFiles, images: viewFiles, organize: viewPages, rotate: viewPages, delete: viewPages, extract: viewPages, split: viewPages, toImages: viewPages, longImage: viewPages, bookmarks: viewPages, background: viewFiles, place: viewPlace, view: viewPlace, form: viewForm, compare: viewFiles, mix: viewFiles };
    (views[tool.mode] || viewSingle)(stage);
    panel.append(...buildPanel());
    root.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function addMoreButton(label) {
    const b = h(`<button class="add-card" type="button">${ICON.plus}<span>${label}</span></button>`);
    b.onclick = () => input.click();
    return b;
  }

  // Merge and JPG to PDF: one card per file, sortable.
  function viewFiles(stage) {
    const total = state.files.reduce((s, f) => s + (f.pageCount || 1), 0);
    stage.append(
      h(`<div class="stage-head"><span>${tp(isImages ? 'images' : 'files', state.files.length)}${isImages ? '' : ` · ${tp('pages', total)}`}</span><span class="spacer"></span><span>${esc(t('dragToReorder'))}</span></div>`),
    );
    const grid = h('<div class="grid"></div>');
    for (const f of state.files) {
      const card = h(`<div class="card sortable" data-key="${f.key}">
        <div class="thumb"><div class="skeleton"></div></div>
        <div class="name" title="${esc(f.name)}">${esc(f.name)}</div>
        <div class="meta"><span>${isImages ? '' : tp('pages', f.pageCount)}</span><span>${fmtBytes(f.size)}</span></div>
        <div class="card-actions"><button class="icon-btn" type="button" aria-label="${esc(t('remove', { name: f.name }))}">${ICON.close}</button></div>
      </div>`);
      $('.icon-btn', card).onclick = () => {
        state.files = state.files.filter((x) => x !== f);
        state.files.length ? render() : reset();
      };
      const thumb = $('.thumb', card);
      if (isImages) {
        const img = new Image();
        img.alt = '';
        img.decoding = 'async';
        img.onload = () => thumb.replaceChildren(img);
        img.onerror = () => (thumb.innerHTML = `<span class="hint">${esc(t('noPreview'))}</span>`);
        img.src = f.url;
      } else {
        thumb._render = () => renderThumb(f.doc, 1, thumb);
        lazy.observe(thumb);
      }
      grid.append(card);
    }
    grid.append(addMoreButton(esc(t(isImages ? 'addImages' : 'addPdfs'))));
    sortable(grid, (keys) => {
      state.files.sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key));
    });
    stage.append(grid);
  }

  // Page-level tools: one card per page.
  function viewPages(stage) {
    const f = state.files[0];
    const head = h(`<div class="stage-head"><b style="color:var(--text)">${esc(f.name)}</b><span>${tp('pages', f.pageCount)} · ${fmtBytes(f.size)}</span><span class="spacer"></span></div>`);
    const change = h(`<button class="btn-plain" type="button">${esc(t('chooseAnother'))}</button>`);
    change.onclick = () => input.click();
    head.append(change);
    stage.append(head);
    const grid = h('<div class="grid"></div>');
    const sortableMode = tool.mode === 'organize';
    const selectMode = ['delete', 'extract', 'toImages', 'longImage'].includes(tool.mode);
    for (const p of state.pages) {
      const card = h(`<div class="card ${sortableMode ? 'sortable' : ''} ${selectMode ? 'selectable' : ''}" data-key="${p.n}" ${selectMode ? 'role="checkbox" tabindex="0"' : ''}>
        <div class="thumb"><div class="skeleton"></div></div>
        <div class="meta"><span class="num">${p.n}</span><span class="state"></span></div>
      </div>`);
      p.el = card;
      const thumb = $('.thumb', card);
      thumb._render = () => renderThumb(f.doc, p.n, thumb, 200).then(() => applyPageState(p));
      lazy.observe(thumb);
      if (selectMode) {
        card.prepend(h(`<span class="tick">${ICON.tick}</span>`));
        const toggle = () => {
          p.on = !p.on;
          applyPageState(p);
          syncPanel();
        };
        card.onclick = toggle;
        card.onkeydown = (e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), toggle());
      }
      if (tool.mode === 'bookmarks') {
        card.classList.add('selectable');
        card.onclick = () => state.addBookmark?.(p.n);
      }
      if (['organize', 'rotate'].includes(tool.mode)) {
        const actions = h('<div class="card-actions"></div>');
        if (sortableMode) {
          const left = h(`<button class="icon-btn" type="button" aria-label="${esc(t('moveEarlier', { n: p.n }))}">${ICON.left}</button>`);
          const right = h(`<button class="icon-btn" type="button" aria-label="${esc(t('moveLater', { n: p.n }))}">${ICON.right}</button>`);
          left.onclick = () => move(p, -1);
          right.onclick = () => move(p, 1);
          actions.append(left, right);
        }
        const rot = h(`<button class="icon-btn" type="button" aria-label="${esc(t('rotatePage', { n: p.n }))}">${ICON.rotate}</button>`);
        rot.onclick = () => {
          p.rot = (p.rot + 90) % 360;
          applyPageState(p);
        };
        actions.append(rot);
        if (sortableMode) {
          const del = h(`<button class="icon-btn" type="button" aria-label="${esc(t('deletePage', { n: p.n }))}">${ICON.close}</button>`);
          del.onclick = () => {
            p.off = !p.off;
            applyPageState(p);
            syncPanel();
          };
          actions.append(del);
        }
        card.append(actions);
      }
      grid.append(card);
      applyPageState(p);
    }
    if (sortableMode) {
      sortable(grid, (keys) => {
        state.pages.sort((a, b) => keys.indexOf(String(a.n)) - keys.indexOf(String(b.n)));
      });
    }
    state.grid = grid;
    stage.append(grid);
  }

  function move(p, dir) {
    const i = state.pages.indexOf(p);
    const j = i + dir;
    if (j < 0 || j >= state.pages.length) return;
    [state.pages[i], state.pages[j]] = [state.pages[j], state.pages[i]];
    flip(state.grid, () => {
      const other = state.pages[i].el;
      dir < 0 ? state.grid.insertBefore(p.el, other) : state.grid.insertBefore(other, p.el);
    });
  }

  function applyPageState(p) {
    const canvas = $('canvas', p.el);
    if (canvas) canvas.style.transform = p.rot ? `rotate(${p.rot}deg)` : '';
    const label = $('.state', p.el);
    if (tool.mode === 'delete') {
      p.el.classList.toggle('marked', p.on);
      p.el.setAttribute('aria-checked', p.on);
      label.textContent = p.on ? t('stateDelete') : '';
    } else if (tool.mode === 'extract' || tool.mode === 'toImages' || tool.mode === 'longImage') {
      p.el.classList.toggle('selected', p.on);
      p.el.setAttribute('aria-checked', p.on);
    } else if (tool.mode === 'organize') {
      p.el.classList.toggle('marked', !!p.off);
      label.textContent = p.off ? t('stateDeleted') : p.rot ? `${p.rot}°` : '';
    } else if (tool.mode === 'rotate') {
      label.textContent = p.rot ? `${p.rot}°` : '';
    }
  }

  // Compress, page numbers, watermark, protect, unlock: one large preview.
  function viewSingle(stage) {
    const f = state.files[0];
    const box = h(`<div class="single">
      <div class="preview-wrap"><div class="thumb"><div class="skeleton"></div></div></div>
      <div><h3>${esc(f.name)}</h3><p>${f.epub ? 'ePub' : f.locked ? esc(t('passwordProtected')) : f.broken ? esc(t('cannotPreview')) : tp('pages', f.pageCount)} · ${fmtBytes(f.size)}</p>
      <p style="margin-top:12px"><button class="btn-plain" type="button">${esc(t('chooseAnother'))}</button></p></div>
    </div>`);
    $('.btn-plain', box).onclick = () => input.click();
    const thumb = $('.thumb', box);
    if (f.epub) thumb.innerHTML = `<div class="epub-cover"><svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3M9 7h6M9 10h4"/></svg></div>`;
    else if (f.locked) thumb.innerHTML = `<div style="color:var(--text-3)">${ICON.lock.replace(/12/g, '48')}</div>`;
    else if (f.broken) thumb.innerHTML = `<div class="hint" style="text-align:center">${esc(t('cannotPreview'))}</div>`;
    else renderThumb(f.doc, 1, thumb, tool.mode === 'crop' ? 720 : 360).then(() => state.updatePreview?.());
    if (tool.mode === 'crop') box.classList.add('single-large');
    state.previewWrap = $('.preview-wrap', box);
    stage.append(box);
  }

  /* ----- Options panel per tool ----- */

  function seg(name, options, value, onChange) {
    const el = h(`<div class="seg" role="group" aria-label="${esc(name)}"></div>`);
    for (const [v, label] of options) {
      const b = h(`<button type="button" aria-pressed="${v === value}">${label}</button>`);
      b.onclick = () => {
        for (const x of el.children) x.setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-pressed', 'true');
        onChange(v);
      };
      el.append(b);
    }
    return el;
  }
  function field(label, control, hint = '') {
    const el = h(`<div class="field"><div class="label">${label}</div></div>`);
    el.append(control);
    if (hint) el.append(h(`<div class="hint">${hint}</div>`));
    return el;
  }

  let syncPanel = () => {};
  function buildPanel() {
    const o = state.options;
    const nodes = [h(`<h2>${esc(tool.name)}</h2>`)];
    if (embedded) {
      const back = h(`<button class="btn-plain studio-back" type="button">‹ ${esc(ts('studioTools', 'Tools'))}</button>`);
      back.onclick = reset;
      nodes.unshift(back);
    }
    const sub = h('<p class="sub"></p>');
    nodes.push(sub);
    const action = h(`<button class="btn primary big block" type="button">${esc(tool.action)}</button>`);
    const f = state.files[0];
    const n = f?.pageCount || 0;
    syncPanel = () => {};

    switch (tool.mode) {
      case 'merge':
        sub.textContent = t('mergeSub');
        syncPanel = () => (action.disabled = state.files.length < 2);
        if (state.files.length < 2) sub.textContent = t('mergeNeedMore');
        break;
      case 'images':
        Object.assign(o, { paper: o.paper || 'fit', margin: o.margin ?? 0 });
        sub.textContent = t('imagesSub');
        nodes.push(field(t('pageSize'), seg(t('pageSize'), [['fit', t('fitImage')], ['a4', t('a4')], ['letter', t('letter')]], o.paper, (v) => (o.paper = v))));
        nodes.push(field(t('margin'), seg(t('margin'), [[0, t('none')], [20, t('small')], [40, t('large')]], o.margin, (v) => (o.margin = v))));
        break;
      case 'organize':
      case 'rotate': {
        sub.textContent = t(tool.mode === 'organize' ? 'organizeSub' : 'rotateSub');
        const row = h('<div class="row"></div>');
        const l = h(`<button class="btn small" type="button">${ICON.rotateLeft} ${esc(t('left'))}</button>`);
        const r = h(`<button class="btn small" type="button">${ICON.rotate} ${esc(t('right'))}</button>`);
        l.onclick = () => state.pages.forEach((p) => ((p.rot = (p.rot + 270) % 360), applyPageState(p)));
        r.onclick = () => state.pages.forEach((p) => ((p.rot = (p.rot + 90) % 360), applyPageState(p)));
        row.append(l, r);
        nodes.push(field(t('rotateAll'), row));
        const resetBtn = h(`<button class="btn-plain" type="button">${esc(t('resetChanges'))}</button>`);
        resetBtn.onclick = () => {
          state.pages.sort((a, b) => a.n - b.n).forEach((p) => ((p.rot = 0), (p.off = false)));
          render();
        };
        nodes.push(h('<div class="field"></div>'));
        nodes.at(-1).append(resetBtn);
        syncPanel = () => (action.disabled = tool.mode === 'organize' && state.pages.every((p) => p.off));
        break;
      }
      case 'delete':
      case 'extract':
      case 'longImage':
      case 'toImages': {
        const label = t({ delete: 'pagesToDelete', extract: 'pagesToExtract', toImages: 'pagesToConvert', longImage: 'pagesToConvert' }[tool.mode]);
        sub.textContent = t(tool.splitAtBlank ? 'splitBlankSub' : tool.autoBlank ? 'blankSub' : tool.mode === 'longImage' ? 'toImagesSub' : `${tool.mode}Sub`);
        const inp = h(`<input class="input" type="text" inputmode="numeric" placeholder="${esc(t('rangePlaceholder'))}" aria-label="${esc(label)}">`);
        const hint = h('<div class="hint"></div>');
        inp.oninput = () => {
          try {
            const set = new Set(inp.value.trim() ? parseRanges(inp.value, n).flat() : []);
            state.pages.forEach((p) => ((p.on = set.has(p.n)), applyPageState(p)));
            hint.textContent = '';
            hint.classList.remove('error');
            syncCount();
          } catch (e) {
            hint.textContent = e.message;
            hint.classList.add('error');
          }
        };
        const box = field(esc(label), inp);
        box.append(hint);
        nodes.push(box);
        const quick = h('<div class="row" style="margin:-8px 0 18px"></div>');
        const all = h(`<button class="btn-plain" type="button" style="flex:none">${esc(t('selectAll'))}</button>`);
        const none = h(`<button class="btn-plain" type="button" style="flex:none">${esc(t('clear'))}</button>`);
        all.onclick = () => (state.pages.forEach((p) => ((p.on = true), applyPageState(p))), syncPanel());
        none.onclick = () => (state.pages.forEach((p) => ((p.on = false), applyPageState(p))), syncPanel());
        quick.append(all, none);
        nodes.push(quick);
        if (tool.mode === 'extract') {
          o.each = o.each || false;
          nodes.push(field(t('saveAs'), seg(t('saveAs'), [[false, t('onePdf')], [true, t('filePerPage')]], o.each, (v) => (o.each = v))));
        }
        if (tool.mode === 'longImage') {
          o.format = o.format || 'jpeg';
          nodes.push(field(t('format'), seg(t('format'), [['jpeg', 'JPG'], ['png', 'PNG']], o.format, (v) => (o.format = v))));
        }
        if (tool.mode === 'toImages') {
          Object.assign(o, { format: o.format || tool.defaults?.format || 'jpeg', scale: o.scale || 2 });
          nodes.push(field(t('format'), seg(t('format'), [['jpeg', 'JPG'], ['png', 'PNG']], o.format, (v) => (o.format = v))));
          nodes.push(field(t('resolution'), seg(t('resolution'), [[1.5, t('standard')], [2, t('high')], [3, t('print')]], o.scale, (v) => (o.scale = v)), esc(t('dpiHint'))));
        }
        const syncCount = () => {
          const k = state.pages.filter((p) => p.on).length;
          action.disabled = k === 0 || (tool.mode === 'delete' && k === n);
          action.textContent = k ? `${tool.action} (${k})` : tool.action;
        };
        syncPanel = () => {
          if (document.activeElement !== inp) inp.value = formatRanges(state.pages.filter((p) => p.on).map((p) => p.n));
          syncCount();
        };
        break;
      }
      case 'split': {
        Object.assign(o, { how: o.how || 'ranges', every: o.every || Math.max(1, Math.ceil(n / 2)) });
        const half = Math.ceil(n / 2);
        o.ranges = o.ranges ?? (n > 1 ? `1-${half}, ${half + 1}-${n}` : '1');
        sub.textContent = t('inThisPdf', { pages: tp('pages', n) });
        const ranges = h(`<input class="input" type="text" value="${esc(o.ranges)}" aria-label="${esc(t('pageRanges'))}">`);
        const every = h(`<input class="input" type="number" min="1" max="${n}" value="${o.every}" aria-label="${esc(t('pagesPerFile'))}">`);
        const hint = h('<div class="hint"></div>');
        const rangesField = field(esc(t('pageRanges')), ranges, esc(t('rangesHint')));
        const everyField = field(esc(t('pagesPerFile')), every);
        const update = () => {
          rangesField.hidden = o.how !== 'ranges';
          everyField.hidden = o.how !== 'every';
          try {
            const groups = splitGroups();
            hint.textContent = t(groups.length > 1 ? 'createsZip' : 'creates', { pdfs: tp('pdfs', groups.length) });
            hint.classList.remove('error');
            action.disabled = false;
            const colors = ['#0A84FF', '#FF375F', '#30D158', '#FF9F0A', '#BF5AF2', '#0FB5AE', '#5E5CE6', '#A2845E'];
            const owner = new Map();
            groups.forEach((g, i) => g.forEach((p) => owner.set(p, i)));
            for (const p of state.pages) {
              p.el.querySelector('.badge')?.remove();
              const i = owner.get(p.n);
              if (i !== undefined) p.el.append(h(`<span class="badge" style="background:${colors[i % colors.length]}">${esc(t('fileN', { n: i + 1 }))}</span>`));
            }
          } catch (e) {
            hint.textContent = e.message;
            hint.classList.add('error');
            action.disabled = true;
          }
        };
        ranges.oninput = () => ((o.ranges = ranges.value), update());
        every.oninput = () => ((o.every = Math.max(1, Math.min(n, +every.value || 1))), update());
        nodes.push(field(t('splitBy'), seg(t('splitBy'), [['ranges', t('ranges')], ['every', t('fixedSize')], ['each', t('everyPage')]], o.how, (v) => ((o.how = v), update()))));
        nodes.push(rangesField, everyField);
        nodes.push(hint);
        syncPanel = update;
        break;
      }
      case 'compress': {
        o.level = o.level ?? 1;
        sub.textContent = t('compressSub');
        const levels = [
          [0, t('lossless'), t('losslessDesc')],
          [1, t('recommended'), t('recommendedDesc')],
          [2, t('strong'), t('strongDesc')],
        ];
        const box = h(`<div class="choices field" role="radiogroup" aria-label="${esc(t('compressSub'))}"></div>`);
        for (const [v, title, desc] of levels) {
          const b = h(`<button type="button" class="choice" aria-pressed="${v === o.level}"><div><b>${esc(title)}</b><span>${esc(desc)}</span></div></button>`);
          b.onclick = () => {
            o.level = v;
            for (const x of box.children) x.setAttribute('aria-pressed', 'false');
            b.setAttribute('aria-pressed', 'true');
          };
          box.append(b);
        }
        nodes.push(box);
        break;
      }
      case 'numbers': {
        Object.assign(o, { position: o.position || 'bottom-center', template: o.template || '{n}', first: o.first || 1, start: o.start || 1, size: o.size || 11 });
        sub.textContent = t('numbersSub');
        const grid = h(`<div class="pos-grid" role="group" aria-label="${esc(t('position'))}"></div>`);
        const posLabel = { 'top-left': 'posTopLeft', 'top-center': 'posTopCenter', 'top-right': 'posTopRight', 'bottom-left': 'posBottomLeft', 'bottom-center': 'posBottomCenter', 'bottom-right': 'posBottomRight' };
        for (const pos of Object.keys(posLabel)) {
          const b = h(`<button type="button" aria-label="${esc(t(posLabel[pos]))}" aria-pressed="${pos === o.position}"></button>`);
          b.onclick = () => {
            o.position = pos;
            for (const x of grid.children) x.setAttribute('aria-pressed', 'false');
            b.setAttribute('aria-pressed', 'true');
            preview();
          };
          grid.append(b);
        }
        nodes.push(field(esc(t('position')), grid));
        // The PDF uses a standard font with Latin characters only, so wording in other scripts
        // falls back to the English template.
        const latin = (s) => /^[\u0020-\u007e\u00a0-\u00ff]*$/.test(s);
        const pageWord = latin(t('pageWord')) ? I18N.ui.pageWord : 'Page {n}';
        const pageOf = latin(t('pageOfWord')) ? I18N.ui.pageOfWord : 'Page {n} of {total}';
        const fmt = h(`<select class="input" aria-label="${esc(t('format'))}"></select>`);
        for (const v of ['{n}', pageWord, pageOf, '{n} / {total}', '- {n} -']) fmt.append(new Option(fill(v, { n: 1, total: n }), v));
        fmt.value = o.template;
        fmt.onchange = () => ((o.template = fmt.value), preview());
        nodes.push(field(esc(t('format')), fmt));
        const first = h(`<input class="input" type="number" min="1" max="${n}" value="${o.first}" aria-label="${esc(t('startOnPage'))}">`);
        const startNo = h(`<input class="input" type="number" min="0" value="${o.start}" aria-label="${esc(t('firstNumber'))}">`);
        first.oninput = () => ((o.first = Math.max(1, Math.min(n, +first.value || 1))), preview());
        startNo.oninput = () => ((o.start = Math.max(0, +startNo.value || 0)), preview());
        const row = h('<div class="row"></div>');
        row.append(field(esc(t('startOnPage')), first), field(esc(t('firstNumber')), startNo));
        nodes.push(row);
        nodes.push(field(esc(t('size')), seg(t('size'), [[9, t('small')], [11, 'M'], [14, t('large')]], o.size, (v) => ((o.size = v), preview()))));
        const preview = () => {
          state.previewWrap?.querySelector('.overlay-preview')?.remove();
          const canvas = $('canvas', state.previewWrap);
          if (!canvas || o.first > 1) return;
          const r = canvas.getBoundingClientRect();
          const wrap = state.previewWrap.getBoundingClientRect();
          const k = r.width / (f.pageWidth || 612);
          const text = o.template.replace('{n}', o.start).replace('{total}', o.start + n - o.first);
          const el = h(`<div class="overlay-preview" style="font:${Math.max(7, o.size * k)}px Helvetica, Arial, sans-serif;color:#333;white-space:nowrap">${esc(text)}</div>`);
          const m = 24 * k;
          const [v, hz] = o.position.split('-');
          el.style[v] = `${(v === 'top' ? r.top - wrap.top : wrap.bottom - r.bottom) + m}px`;
          if (hz === 'center') {
            el.style.left = `${r.left - wrap.left + r.width / 2}px`;
            el.style.transform = 'translateX(-50%)';
          } else el.style[hz] = `${(hz === 'left' ? r.left - wrap.left : wrap.right - r.right) + m}px`;
          state.previewWrap.append(el);
        };
        state.updatePreview = preview;
        f.doc.getPage(1).then((pg) => ((f.pageWidth = pg.getViewport({ scale: 1 }).width), preview()));
        break;
      }
      case 'watermark': {
        Object.assign(o, { text: o.text ?? t('defaultWatermark'), color: o.color || '#d70015', scale: o.scale || 0.6, rotation: o.rotation ?? 45, opacity: o.opacity ?? 0.25, tiled: o.tiled || false });
        sub.textContent = t('watermarkSub');
        if (tool.watermarkImage) {
          const pick = h(`<label class="btn block"><input type="file" accept="image/*" hidden>${esc(t('chooseImage'))}</label>`);
          $('input', pick).onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const bmp = await createImageBitmap(file);
            const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
            const c = document.createElement('canvas');
            c.width = Math.round(bmp.width * scale);
            c.height = Math.round(bmp.height * scale);
            c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
            o.image = c;
            action.disabled = false;
            preview();
          };
          nodes.push(field(esc(t('image')), pick));
          o.opacity = o.opacity === 0.25 ? 0.35 : o.opacity;
          o.rotation = o.rotation === 45 ? 0 : o.rotation;
          queueMicrotask(() => (action.disabled = !o.image));
        } else {
          const text = h(`<input class="input" type="text" value="${esc(o.text)}" maxlength="80" aria-label="${esc(t('text'))}">`);
          text.oninput = () => ((o.text = text.value), preview(), (action.disabled = !o.text.trim()));
          nodes.push(field(esc(t('text')), text));
        }
        const sw = h(`<div class="swatches" role="group" aria-label="${esc(t('colour'))}"></div>`);
        for (const [c, name] of [['#d70015', t('red')], ['#6e6e73', t('grey')], ['#0071e3', t('blue')], ['#1d1d1f', t('black')]]) {
          const b = h(`<button type="button" class="swatch" style="background:${c}" aria-label="${esc(name)}" aria-pressed="${c === o.color}"></button>`);
          b.onclick = () => {
            o.color = c;
            for (const x of sw.children) x.setAttribute('aria-pressed', 'false');
            b.setAttribute('aria-pressed', 'true');
            preview();
          };
          sw.append(b);
        }
        if (!tool.watermarkImage) nodes.push(field(esc(t('colour')), sw));
        const slider = (label, key, min, max, step, show) => {
          const s = h(`<input class="range" type="range" min="${min}" max="${max}" step="${step}" value="${o[key]}" aria-label="${esc(label)}">`);
          const fld = field(`${esc(label)} <span style="float:inline-end;font-weight:400">${show(o[key])}</span>`, s);
          s.oninput = () => {
            o[key] = +s.value;
            $('span', fld).textContent = show(o[key]);
            preview();
          };
          return fld;
        };
        nodes.push(slider(t('size'), 'scale', 0.15, 0.95, 0.05, (v) => `${Math.round(v * 100)}%`));
        nodes.push(slider(t('angle'), 'rotation', -90, 90, 5, (v) => `${v}°`));
        nodes.push(slider(t('opacity'), 'opacity', 0.05, 1, 0.05, (v) => `${Math.round(v * 100)}%`));
        nodes.push(field(esc(t('layout')), seg(t('layout'), [[false, t('single')], [true, t('tiled')]], o.tiled, (v) => ((o.tiled = v), preview()))));
        const preview = () => {
          state.previewWrap?.querySelector('.overlay-preview')?.remove();
          const canvas = $('canvas', state.previewWrap);
          if (!canvas || (tool.watermarkImage ? !o.image : !o.text.trim())) return;
          const r = canvas.getBoundingClientRect();
          const wrap = state.previewWrap.getBoundingClientRect();
          const mark = tool.watermarkImage ? o.image : textImage(o.text, o.color, 120);
          const c = document.createElement('canvas');
          const dpr = Math.min(devicePixelRatio || 1, 2);
          c.width = r.width * dpr;
          c.height = r.height * dpr;
          c.className = 'overlay-preview';
          Object.assign(c.style, { left: `${r.left - wrap.left}px`, top: `${r.top - wrap.top}px`, width: `${r.width}px`, height: `${r.height}px` });
          drawMarks(c.getContext('2d'), c.width, c.height, mark, o);
          state.previewWrap.append(c);
        };
        state.updatePreview = preview;
        break;
      }
      case 'protect': {
        Object.assign(o, { allowPrint: o.allowPrint ?? true, allowCopy: o.allowCopy ?? true });
        sub.textContent = t('protectSub');
        const pw = h(`<input class="input" type="password" autocomplete="new-password" aria-label="${esc(t('password'))}">`);
        const pw2 = h(`<input class="input" type="password" autocomplete="new-password" aria-label="${esc(t('repeatPassword'))}">`);
        const hint = h('<div class="hint"></div>');
        const showBox = h(`<label class="check"><input type="checkbox"> ${esc(t('showPassword'))}</label>`);
        $('input', showBox).onchange = (e) => (pw.type = pw2.type = e.target.checked ? 'text' : 'password');
        const check = () => {
          o.password = pw.value;
          const mismatch = pw2.value && pw.value !== pw2.value;
          hint.textContent = mismatch ? t('mismatch') : pw.value && pw.value.length < 6 ? t('longerTip') : '';
          hint.classList.toggle('error', !!mismatch);
          action.disabled = !pw.value || pw.value !== pw2.value;
        };
        pw.oninput = pw2.oninput = check;
        const fld = field(esc(t('password')), pw);
        nodes.push(fld, field(esc(t('repeatPassword')), pw2));
        nodes.at(-1).append(hint);
        nodes.push(showBox);
        const print = h(`<label class="check"><input type="checkbox" ${o.allowPrint ? 'checked' : ''}> ${esc(t('allowPrint'))}</label>`);
        const copy = h(`<label class="check"><input type="checkbox" ${o.allowCopy ? 'checked' : ''}> ${esc(t('allowCopy'))}</label>`);
        $('input', print).onchange = (e) => (o.allowPrint = e.target.checked);
        $('input', copy).onchange = (e) => (o.allowCopy = e.target.checked);
        const perms = h(`<div class="field"><div class="label">${esc(t('permissions'))}</div></div>`);
        perms.append(print, copy);
        nodes.push(perms);
        syncPanel = check;
        break;
      }
      case 'simple':
        sub.textContent = t('simpleSub');
        if (tool.option === 'keepLinks') {
          o.keepLinks = o.keepLinks ?? true;
          const c = h(`<label class="check"><input type="checkbox" ${o.keepLinks ? 'checked' : ''}> ${esc(t('keepLinks'))}</label>`);
          $('input', c).onchange = (e) => (o.keepLinks = e.target.checked);
          nodes.push(c);
        }
        break;
      case 'toEpub': {
        o.layout = o.layout || 'text';
        sub.textContent = t('toEpubSub');
        const hint = h(`<p class="hint"></p>`);
        const sync = () => (hint.textContent = o.layout === 'text' ? t('epubTextHint') : t('epubPagesHint'));
        nodes.push(field(t('epubLayout'), seg(t('epubLayout'), [['text', t('epubText')], ['pages', t('epubPages')]], o.layout, (v) => ((o.layout = v), sync()))), hint);
        sync();
        break;
      }
      case 'fromEpub': {
        Object.assign(o, { paper: o.paper || 'a5', font: o.font || 12 });
        sub.textContent = t('fromEpubSub');
        nodes.push(field(t('pageSize'), seg(t('pageSize'), [['a5', 'A5'], ['a4', 'A4'], ['letter', 'Letter']], o.paper, (v) => (o.paper = v))));
        nodes.push(field(t('textSize'), seg(t('textSize'), [[10, t('sizeSmall')], [12, t('sizeMedium')], [14, t('sizeLarge')]], o.font, (v) => (o.font = v))));
        break;
      }
      case 'toText': {
        o.marks = o.marks ?? true;
        sub.textContent = t('toTextSub');
        const c = h(`<label class="check"><input type="checkbox" ${o.marks ? 'checked' : ''}> ${esc(t('pageMarks'))}</label>`);
        $('input', c).onchange = (e) => (o.marks = e.target.checked);
        nodes.push(c);
        break;
      }
      case 'blank': {
        Object.assign(o, { where: o.where || 'every', after: o.after || '' });
        sub.textContent = t('blankPagesSub');
        const inp = h(`<input class="input" type="text" inputmode="numeric" placeholder="${esc(t('rangePlaceholder'))}" value="${esc(o.after)}" aria-label="${esc(t('afterPages'))}">`);
        const fld = field(esc(t('afterPages')), inp, esc(t('afterPagesHint')));
        inp.oninput = () => (o.after = inp.value);
        nodes.push(field(t('where'), seg(t('where'), [['every', t('afterEvery')], ['some', t('afterSome')]], o.where, (v) => ((o.where = v), (fld.hidden = v !== 'some')))));
        fld.hidden = o.where !== 'some';
        nodes.push(fld);
        break;
      }
      case 'mix': {
        o.reverseB = o.reverseB ?? true;
        sub.textContent = t('mixSub');
        const c = h(`<label class="check"><input type="checkbox" ${o.reverseB ? 'checked' : ''}> ${esc(t('reverseSecond'))}</label>`);
        $('input', c).onchange = (e) => (o.reverseB = e.target.checked);
        nodes.push(c);
        syncPanel = () => (action.disabled = state.files.length !== 2);
        break;
      }
      case 'compare':
        sub.textContent = t('compareSub');
        syncPanel = () => (action.disabled = state.files.length !== 2);
        break;
      case 'half': {
        Object.assign(o, { vertical: o.vertical ?? true, rtl: o.rtl ?? false });
        sub.textContent = t('halfSub');
        const rtl = h(`<label class="check"><input type="checkbox" ${o.rtl ? 'checked' : ''}> ${esc(t('rightToLeft'))}</label>`);
        $('input', rtl).onchange = (e) => (o.rtl = e.target.checked);
        nodes.push(field(t('cut'), seg(t('cut'), [[true, t('leftRight')], [false, t('topBottom')]], o.vertical, (v) => ((o.vertical = v), (rtl.hidden = !v)))));
        nodes.push(rtl);
        break;
      }
      case 'resize':
        o.paper = o.paper || 'a4';
        sub.textContent = t('resizeSub');
        nodes.push(field(t('pageSize'), seg(t('pageSize'), [['a4', 'A4'], ['letter', t('letter')], ['a3', 'A3'], ['a5', 'A5'], ['legal', 'Legal']], o.paper, (v) => (o.paper = v))));
        break;
      case 'margins':
        o.mm = o.mm || 10;
        sub.textContent = t('marginsSub');
        nodes.push(field(t('margin'), seg(t('margin'), [[5, '5 mm'], [10, '10 mm'], [20, '20 mm'], [30, '30 mm']], o.mm, (v) => (o.mm = v))));
        break;
      case 'booklet':
        o.paper = o.paper || 'auto';
        sub.textContent = t('bookletSub');
        nodes.push(field(t('pageSize'), seg(t('pageSize'), [['auto', t('sameAsPdf')], ['a4', 'A4'], ['letter', t('letter')]], o.paper, (v) => (o.paper = v))));
        break;
      case 'splitSize': {
        o.mb = o.mb || 5;
        sub.textContent = t('splitSizeSub');
        const inp = h(`<input class="input" type="number" min="0.5" step="0.5" value="${o.mb}" aria-label="${esc(t('maxSize'))}">`);
        inp.oninput = () => (o.mb = Math.max(0.2, +inp.value || 5));
        nodes.push(field(`${esc(t('maxSize'))} (MB)`, inp));
        break;
      }
      case 'headerFooter':
      case 'bates': {
        Object.assign(o, { size: o.size || 10, first: o.first || 1 });
        if (tool.mode === 'bates') {
          Object.assign(o, { prefix: o.prefix ?? 'ABC-', start: o.start ?? 1, digits: o.digits || 6, corner: o.corner || 'bottom-right' });
          sub.textContent = t('batesSub');
          const prefix = h(`<input class="input" type="text" value="${esc(o.prefix)}" aria-label="${esc(t('prefix'))}">`);
          const start = h(`<input class="input" type="number" min="0" value="${o.start}" aria-label="${esc(t('firstNumber'))}">`);
          const digits = h(`<input class="input" type="number" min="1" max="12" value="${o.digits}" aria-label="${esc(t('digits'))}">`);
          const example = h('<div class="hint"></div>');
          const upd = () => (example.textContent = `${o.prefix}${String(o.start).padStart(o.digits, '0')}`);
          prefix.oninput = () => ((o.prefix = prefix.value), upd());
          start.oninput = () => ((o.start = Math.max(0, +start.value || 0)), upd());
          digits.oninput = () => ((o.digits = Math.max(1, Math.min(12, +digits.value || 6))), upd());
          upd();
          nodes.push(field(esc(t('prefix')), prefix));
          const row = h('<div class="row"></div>');
          row.append(field(esc(t('firstNumber')), start), field(esc(t('digits')), digits));
          nodes.push(row, example);
          nodes.push(field(t('position'), seg(t('position'), [['bottom-right', t('posBottomRight')], ['bottom-left', t('posBottomLeft')], ['top-right', t('posTopRight')]], o.corner, (v) => (o.corner = v))));
        } else {
          o.slots = o.slots || { hl: '', hc: '', hr: '', fl: '', fc: '{page} / {total}', fr: '' };
          sub.textContent = t('headerFooterSub');
          for (const [row, keys] of [['header', ['hl', 'hc', 'hr']], ['footer', ['fl', 'fc', 'fr']]]) {
            const box = h('<div class="slot-row"></div>');
            for (const k of keys) {
              const inp = h(`<input class="input" type="text" value="${esc(o.slots[k])}" aria-label="${esc(t(row))} ${esc(t({ l: 'left', c: 'center', r: 'right' }[k[1]]))}">`);
              inp.oninput = () => (o.slots[k] = inp.value);
              box.append(inp);
            }
            nodes.push(field(esc(t(row)), box));
          }
          nodes.push(h(`<p class="hint" style="margin:-8px 0 18px">${esc(t('tokensHint'))}</p>`));
        }
        nodes.push(field(t('size'), seg(t('size'), [[8, t('small')], [10, 'M'], [13, t('large')]], o.size, (v) => (o.size = v))));
        const first = h(`<input class="input" type="number" min="1" max="${n}" value="${o.first}" aria-label="${esc(t('startOnPage'))}">`);
        first.oninput = () => (o.first = Math.max(1, Math.min(n, +first.value || 1)));
        nodes.push(field(esc(t('startOnPage')), first));
        break;
      }
      case 'view': {
        sub.textContent = t('viewSub');
        o.zoom = o.zoom || 640;
        nodes.push(field(t('zoom'), seg(t('zoom'), [[640, '100%'], [900, '140%'], [1200, '190%']], o.zoom, (v) => {
          o.zoom = v;
          $('.sheets', root).style.maxWidth = `${v}px`;
          for (const sh of state.sheets) sh._render?.();
        })));
        action.hidden = true;
        break;
      }
      case 'info':
        sub.textContent = t('infoSub');
        action.hidden = true;
        break;
      case 'form':
        sub.textContent = t('formSub');
        break;
      case 'bookmarks': {
        sub.textContent = ts('bookmarksSub', 'Click a page to add a bookmark for it, then name it.');
        o.marks = o.marks || [];
        const list = h('<div class="bookmark-list"></div>');
        const draw = () => {
          list.replaceChildren();
          o.marks.forEach((m, i) => {
            const row = h(`<div class="bookmark-row"><input class="input" type="text" value="${esc(m.title)}" aria-label="${esc(ts('bookmarkTitle', 'Title'))}"><input class="input page-no" type="number" min="1" max="${n}" value="${m.page}" aria-label="${esc(ts('bookmarkPage', 'Page'))}"><button class="icon-btn" type="button" aria-label="${esc(t('deleteItem'))}">${ICON.close}</button></div>`);
            const [title, page] = row.querySelectorAll('input');
            title.oninput = () => (m.title = title.value);
            page.oninput = () => (m.page = Math.max(1, Math.min(n, +page.value || 1)));
            $('button', row).onclick = () => (o.marks.splice(i, 1), draw());
            list.append(row);
          });
          if (!o.marks.length) list.append(h(`<p class="hint">${esc(ts('noBookmarks', 'No bookmarks yet.'))}</p>`));
        };
        state.addBookmark = (page) => {
          o.marks.push({ title: fill(t('pageWord'), { n: page }), page });
          o.marks.sort((a, b) => a.page - b.page);
          draw();
          list.querySelectorAll('input')[o.marks.findIndex((m) => m.page === page) * 2]?.select();
        };
        const add = h(`<button class="btn small" type="button">${esc(ts('addBookmark', 'Add bookmark'))}</button>`);
        add.onclick = () => state.addBookmark(1);
        nodes.push(list, add);
        // Start from the bookmarks the PDF already has.
        if (!o.loaded) {
          o.loaded = true;
          f.doc.getOutline().then(async (outline) => {
            for (const item of outline || []) {
              try {
                const dest = typeof item.dest === 'string' ? await f.doc.getDestination(item.dest) : item.dest;
                const index = dest?.[0] ? await f.doc.getPageIndex(dest[0]) : null;
                if (index !== null) o.marks.push({ title: item.title, page: index + 1 });
              } catch {}
            }
            draw();
          });
        }
        draw();
        break;
      }
      case 'background': {
        Object.assign(o, { onTop: o.onTop ?? false, firstOnly: o.firstOnly ?? false });
        sub.textContent = ts('backgroundSub', 'First file: your document. Second file: the background; its first page is used.');
        nodes.push(field(ts('placement', 'Placement'), seg(ts('placement', 'Placement'), [[false, ts('behind', 'Behind content')], [true, ts('onTop', 'On top')]], o.onTop, (v) => (o.onTop = v))));
        nodes.push(field(ts('applyTo', 'Apply to'), seg(t('applyTo'), [[false, t('allPages')], [true, ts('firstPageOnly', 'First page')]], o.firstOnly, (v) => (o.firstOnly = v))));
        syncPanel = () => (action.disabled = state.files.length !== 2);
        break;
      }
      case 'crop': {
        o.m = o.m || [0.06, 0.06, 0.06, 0.06];
        o.scope = o.scope || 'all';
        sub.textContent = t('cropSub');
        const inputs = [];
        const box = h('<div class="crop-fields"></div>');
        ['left', 'top', 'right', 'bottom'].forEach((side, i) => {
          const inp = h(`<input class="input" type="number" min="0" max="40" step="1" value="${Math.round(o.m[i] * 100)}" aria-label="${esc(t(side))}">`);
          inp.oninput = () => {
            o.m[i] = Math.max(0, Math.min(40, +inp.value || 0)) / 100;
            preview();
          };
          inputs.push(inp);
          box.append(field(`${esc(t(side))} %`, inp));
        });
        nodes.push(box);
        const range = h(`<input class="input" type="text" inputmode="numeric" placeholder="${esc(t('rangePlaceholder'))}" aria-label="${esc(t('pageRanges'))}">`);
        const rangeField = field(esc(t('pageRanges')), range);
        range.oninput = () => (o.range = range.value);
        nodes.push(field(t('applyTo'), seg(t('applyTo'), [['all', t('allPages')], ['some', t('somePages')]], o.scope, (v) => ((o.scope = v), (rangeField.hidden = v !== 'some')))));
        rangeField.hidden = o.scope !== 'some';
        nodes.push(rangeField);
        // A crop frame over the preview: drag any edge, or type the margins.
        const preview = () => {
          inputs.forEach((inp, i) => document.activeElement !== inp && (inp.value = Math.round(o.m[i] * 100)));
          const canvas = $('canvas', state.previewWrap);
          if (!canvas) return;
          let frame = $('.crop-frame', state.previewWrap);
          if (!frame) {
            frame = h('<div class="crop-frame"><div class="crop-box"><i data-e="0"></i><i data-e="1"></i><i data-e="2"></i><i data-e="3"></i></div></div>');
            state.previewWrap.append(frame);
            frame.addEventListener('pointerdown', (e) => {
              const edge = e.target.dataset?.e;
              if (edge === undefined) return;
              e.preventDefault();
              const r = frame.getBoundingClientRect();
              const move = (ev) => {
                const fx = (ev.clientX - r.left) / r.width;
                const fy = (ev.clientY - r.top) / r.height;
                const v = [fx, fy, 1 - fx, 1 - fy][edge];
                o.m[edge] = Math.max(0, Math.min(0.4, v));
                preview();
              };
              const up = () => (removeEventListener('pointermove', move), removeEventListener('pointerup', up));
              addEventListener('pointermove', move);
              addEventListener('pointerup', up);
            });
          }
          const r = canvas.getBoundingClientRect();
          const w = state.previewWrap.getBoundingClientRect();
          Object.assign(frame.style, { left: `${r.left - w.left}px`, top: `${r.top - w.top}px`, width: `${r.width}px`, height: `${r.height}px` });
          const [l, tp, rt, b] = o.m.map((v) => `${v * 100}%`);
          Object.assign($('.crop-box', frame).style, { left: l, top: tp, right: rt, bottom: b });
        };
        state.updatePreview = preview;
        addEventListener('resize', preview);
        break;
      }
      case 'nup': {
        Object.assign(o, { per: o.per || 2, paper: o.paper || 'auto' });
        sub.textContent = t('nupSub');
        nodes.push(field(t('perSheet'), seg(t('perSheet'), [[2, '2'], [4, '4']], o.per, (v) => (o.per = v))));
        nodes.push(field(t('pageSize'), seg(t('pageSize'), [['auto', t('sameAsPdf')], ['a4', t('a4')], ['letter', t('letter')]], o.paper, (v) => (o.paper = v))));
        break;
      }
      case 'metadata': {
        sub.textContent = t('metaSub');
        const keys = [['Title', 'metaTitle'], ['Author', 'metaAuthor'], ['Subject', 'metaSubject'], ['Keywords', 'metaKeywords']];
        o.meta = o.meta || {};
        const inputs = {};
        for (const [k, label] of keys) {
          const inp = h(`<input class="input" type="text" aria-label="${esc(t(label))}">`);
          inp.oninput = () => (o.meta[k] = inp.value);
          inputs[k] = inp;
          nodes.push(field(esc(t(label)), inp));
        }
        const extra = h('<div class="field meta-extra"></div>');
        nodes.push(extra);
        f.doc?.getMetadata().then(({ info }) => {
          for (const [k] of keys) if (o.meta[k] === undefined) inputs[k].value = o.meta[k] = info?.[k] || '';
          const fmtDate = (d) => {
            const m = /^D:(\d{4})(\d{2})?(\d{2})?/.exec(d || '');
            return m ? new Date(+m[1], (+m[2] || 1) - 1, +m[3] || 1).toLocaleDateString(I18N.code) : '';
          };
          const rows = [[t('metaApp'), [info?.Creator, info?.Producer].filter(Boolean).join(' · ')], [t('metaCreated'), fmtDate(info?.CreationDate)], [t('metaModified'), fmtDate(info?.ModDate)]].filter(([, v]) => v);
          if (rows.length) extra.innerHTML = `<div class="label">${esc(t('alsoStored'))}</div><dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
        });
        const wipe = h(`<button class="btn-plain" type="button">${esc(t('wipeAll'))}</button>`);
        wipe.onclick = () => {
          o.wipe = true;
          action.click();
        };
        state.afterAction = wipe;
        break;
      }
      case 'repair':
        sub.textContent = t('repairSub');
        break;
      case 'place': {
        Object.assign(o, { textColor: o.textColor || '#1d1d1f', textSize: o.textSize || 0.028 });
        sub.textContent = t('placeSub');
        const sig = h('<div class="field"></div>');
        const drawSig = () => {
          sig.innerHTML = `<div class="label">${esc(t('signature'))}</div>`;
          if (state.signature) {
            const tile = h(`<div class="sig-tile"><img alt="${esc(t('signature'))}" src="${state.signature.toDataURL()}"></div>`);
            const add = h(`<button class="btn small" type="button">${esc(t("addToPage"))}</button>`);
            const again = h(`<button class="btn-plain" type="button">${esc(t('newSignature'))}</button>`);
            add.onclick = () => addItem('image', state.signature);
            again.onclick = () => signatureDialog().then((c) => c && ((state.signature = c), drawSig(), addItem('image', c)));
            const row = h('<div class="row" style="align-items:center"></div>');
            row.append(add, again);
            sig.append(tile, row);
          } else {
            const make = h(`<button class="btn block" type="button">${esc(t('createSignature'))}</button>`);
            make.onclick = () => signatureDialog().then((c) => c && ((state.signature = c), drawSig(), addItem('image', c)));
            sig.append(make);
          }
        };
        drawSig();
        const text = h('<div class="field"></div>');
        text.append(h(`<div class="label">${esc(t('text'))}</div>`));
        const sw = h('<div class="swatches" style="margin:10px 0"></div>');
        for (const [c, name] of [['#1d1d1f', t('black')], ['#0040dd', t('blue')], ['#d70015', t('red')]]) {
          const b = h(`<button type="button" class="swatch" style="background:${c}" aria-label="${esc(name)}" aria-pressed="${c === o.textColor}"></button>`);
          b.onclick = () => {
            o.textColor = c;
            for (const x of sw.children) x.setAttribute('aria-pressed', 'false');
            b.setAttribute('aria-pressed', 'true');
            const a = state.active;
            if (a?.kind === 'text') $('.placed-body', a.el).style.color = a.color = c;
          };
          sw.append(b);
        }
        const size = seg(t('size'), [[0.02, t('small')], [0.028, 'M'], [0.04, t('large')]], o.textSize, (v) => {
          o.textSize = v;
          const a = state.active;
          if (a?.kind === 'text') ((a.size = v), layoutItem(a));
        });
        const addText = h(`<button class="btn small" type="button">${esc(t('addText'))}</button>`);
        const addDate = h(`<button class="btn small" type="button">${esc(t('addDate'))}</button>`);
        addText.onclick = () => addItem('text', t('typeText'));
        addDate.onclick = () => addItem('text', new Intl.DateTimeFormat(I18N.code, { dateStyle: 'long' }).format(new Date()));
        const row = h('<div class="row" style="margin-top:12px"></div>');
        row.append(addText, addDate);
        text.append(sw, size, row);
        if (tool.editor === 'image') {
          const pick = h(`<label class="btn block"><input type="file" accept="image/*" hidden>${esc(t('chooseImage'))}</label>`);
          $('input', pick).onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const bmp = await createImageBitmap(file);
            const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
            const c = document.createElement('canvas');
            c.width = Math.round(bmp.width * scale);
            c.height = Math.round(bmp.height * scale);
            c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
            addItem('image', c);
            e.target.value = '';
          };
          const box = h(`<div class="field"><div class="label">${esc(t('image'))}</div></div>`);
          box.append(pick);
          nodes.push(box);
        } else if (tool.editor === 'stamp') {
          const grid = h('<div class="stamp-grid"></div>');
          for (const [key, label, color] of STAMPS) {
            const c = stampCanvas(ts(key, label), color);
            const b = h(`<button type="button" class="stamp-pick" aria-label="${esc(ts(key, label))}"></button>`);
            b.append(c);
            b.onclick = () => addItem('image', stampCanvas(ts(key, label), color));
            grid.append(b);
          }
          nodes.push(field(esc(ts('stamps', 'Stamps')), grid));
        } else if (tool.editor === 'draw') {
          Object.assign(o, { ink: o.ink || '#1d1d1f', inkWidth: o.inkWidth || 0.004, inkMode: o.inkMode || 'draw' });
          const sw = h('<div class="swatches" style="margin-bottom:12px"></div>');
          for (const [c, name] of [['#1d1d1f', t('black')], ['#0040dd', t('blue')], ['#d70015', t('red')], ['#ffd60a', t('yellow')]]) {
            const b = h(`<button type="button" class="swatch" style="background:${c}" aria-label="${esc(name)}" aria-pressed="${c === o.ink}"></button>`);
            b.onclick = () => {
              o.ink = c;
              for (const x of sw.children) x.setAttribute('aria-pressed', 'false');
              b.setAttribute('aria-pressed', 'true');
            };
            sw.append(b);
          }
          nodes.push(field(esc(t('colour')), sw));
          nodes.push(field(esc(ts('lineWidth', 'Line width')), seg(ts('lineWidth', 'Line width'), [[0.0025, t('small')], [0.004, 'M'], [0.008, t('large')]], o.inkWidth, (v) => (o.inkWidth = v))));
          if (matchMedia('(pointer: coarse)').matches) {
            nodes.push(field(esc(ts('touchMode', 'Touch')), seg(ts('touchMode', 'Touch'), [['draw', ts('drawMode', 'Draw')], ['scroll', ts('scrollMode', 'Scroll')]], o.inkMode, (v) => ((o.inkMode = v), document.body.classList.toggle('ink-scroll', v === 'scroll')))));
          }
          const undo = h(`<button class="btn small" type="button">${esc(ts('undoStroke', 'Undo stroke'))}</button>`);
          const clear = h(`<button class="btn small" type="button">${esc(ts('clearAll', 'Clear all'))}</button>`);
          undo.onclick = () => state.ink?.undo();
          clear.onclick = () => state.ink?.clear();
          const row = h('<div class="row"></div>');
          row.append(undo, clear);
          nodes.push(row);
          syncPanel = () => (action.disabled = !state.ink?.count());
          break;
        } else if (tool.editor === 'highlight' || tool.editor === 'redact' || tool.editor === 'whiteout') {
          const redact = tool.editor === 'redact';
          const whiteout = tool.editor === 'whiteout';
          o.boxColor = whiteout ? '#ffffff' : o.boxColor || (redact ? '#000000' : '#ffd60a');
          const box = h(`<div class="field"></div>`);
          if (!redact && !whiteout) {
            const swatches = h('<div class="swatches" style="margin-bottom:12px"></div>');
            for (const [c, name] of [['#ffd60a', t('yellow')], ['#30d158', t('green')], ['#ff6482', t('pink')]]) {
              const b = h(`<button type="button" class="swatch" style="background:${c}" aria-label="${esc(name)}" aria-pressed="${c === o.boxColor}"></button>`);
              b.onclick = () => {
                o.boxColor = c;
                for (const x of swatches.children) x.setAttribute('aria-pressed', 'false');
                b.setAttribute('aria-pressed', 'true');
              };
              swatches.append(b);
            }
            box.append(swatches);
          }
          const add = h(`<button class="btn block" type="button">${esc(whiteout ? ts('addWhiteout', 'Add white box') : t(redact ? 'addRedaction' : 'addHighlight'))}</button>`);
          add.onclick = () => addItem('box', { color: o.boxColor, alpha: redact || whiteout ? 1 : 0.4 });
          box.append(add);
          if (redact) box.append(h(`<p class="hint">${esc(t('redactHint'))}</p>`));
          if (whiteout) box.append(h(`<p class="hint">${esc(ts('whiteoutHint', 'White boxes only cover content. To remove it from the file, use Redact PDF.'))}</p>`));
          nodes.push(box);
        } else nodes.push(...(tool.slug === 'add-text-to-pdf' ? [text, sig] : [sig, text]));
        syncPanel = () => (action.disabled = !state.items?.length);
        break;
      }
      case 'unlock': {
        if (f.locked) {
          sub.textContent = t('unlockLockedSub');
          const pw = h(`<input class="input" type="password" autocomplete="current-password" aria-label="${esc(t('password'))}">`);
          pw.oninput = () => ((o.password = pw.value), (action.disabled = !pw.value));
          pw.onkeydown = (e) => e.key === 'Enter' && pw.value && action.click();
          nodes.push(field(esc(t('password')), pw));
          syncPanel = () => (action.disabled = !o.password);
          setTimeout(() => pw.focus(), 300);
        } else {
          sub.textContent = t('unlockOpenSub');
        }
        break;
      }
    }

    action.onclick = () => run().catch((e) => {
      $('.busy', root)?.remove();
      showError(e.message || String(e));
    });
    nodes.push(action);
    if (state.afterAction) {
      nodes.push(state.afterAction);
      state.afterAction.classList.add('secondary-action');
      state.afterAction = null;
    }
    nodes.push(h(`<p class="fine">${ICON.lock} ${esc(t('processedHere'))}</p>`));
    mobileBar(action);
    queueMicrotask(() => syncPanel());
    return nodes;
  }

  // On phones the options sit below the pages, so the main button is mirrored in a bottom bar
  // that steps aside whenever the real button is on screen.
  function mobileBar(action) {
    document.querySelector('.mobile-bar')?.remove();
    if (action.hidden) return;
    const bar = h('<div class="mobile-bar"><button class="btn primary big" type="button"></button></div>');
    const proxy = $('button', bar);
    const sync = () => {
      proxy.textContent = action.textContent;
      proxy.disabled = action.disabled;
    };
    new MutationObserver(sync).observe(action, { attributes: true, childList: true, characterData: true, subtree: true });
    sync();
    proxy.onclick = () => action.click();
    // Visible only while the workspace is on screen and its own button is not.
    let workVisible = true;
    let actionVisible = false;
    const update = () => bar.classList.toggle('away', actionVisible || !workVisible);
    new IntersectionObserver(([e]) => ((actionVisible = e.isIntersecting), update())).observe(action);
    const work = action.closest('.work');
    if (work) new IntersectionObserver(([e]) => ((workVisible = e.isIntersecting), update()), { rootMargin: '0px 0px -120px 0px' }).observe(work);
    document.body.append(bar);
    document.body.classList.add('has-bar');
  }
  const dropBar = () => {
    document.querySelector('.mobile-bar')?.remove();
    document.body.classList.remove('has-bar');
  };

  function splitGroups() {
    const n = state.files[0].pageCount;
    const o = state.options;
    if (o.how === 'each') return Array.from({ length: n }, (_, i) => [i + 1]);
    if (o.how === 'every') {
      const g = [];
      for (let i = 1; i <= n; i += o.every) g.push(Array.from({ length: Math.min(o.every, n - i + 1) }, (_, k) => i + k));
      return g;
    }
    const groups = parseRanges(o.ranges || '', n);
    if (!groups.length) throw new Error(t('needRange'));
    return groups;
  }

  /* ----- Sign and add text: a page viewer with movable items ----- */

  function viewPlace(stage) {
    const f = state.files[0];
    state.items = [];
    state.sheets = [];
    const head = h(`<div class="stage-head"><b style="color:var(--text)">${esc(f.name)}</b><span>${tp('pages', f.pageCount)}</span><span class="spacer"></span></div>`);
    const change = h(`<button class="btn-plain" type="button">${esc(t('chooseAnother'))}</button>`);
    change.onclick = () => input.click();
    head.append(change);
    const list = h('<div class="sheets"></div>');
    stage.append(head, list);
    for (let n = 1; n <= f.pageCount; n++) {
      const sheet = h(`<div class="sheet" data-page="${n}"><div class="sheet-canvas"></div></div>`);
      state.sheets.push(sheet);
      list.append(sheet);
      f.doc.getPage(n).then((pg) => {
        const vp = pg.getViewport({ scale: 1 });
        sheet.style.aspectRatio = `${vp.width} / ${vp.height}`;
        sheet._render = async () => {
          const width = sheet.clientWidth || 600;
          const dpr = Math.min(devicePixelRatio || 1, 2);
          const v = pg.getViewport({ scale: (width * dpr) / vp.width });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(v.width);
          canvas.height = Math.ceil(v.height);
          await pg.render({ canvasContext: canvas.getContext('2d'), viewport: v, intent: 'print' }).promise;
          $('.sheet-canvas', sheet).replaceChildren(canvas);
        };
        lazy.observe(sheet);
      });
    }
    // Clicking empty paper deselects.
    list.addEventListener('pointerdown', (e) => !e.target.closest('.placed') && select(null));
    if (tool.editor === 'draw') state.ink = inkLayer(state.sheets);
  }

  // Freehand drawing: strokes are stored in page fractions and drawn again at export size.
  function inkLayer(sheets) {
    const strokes = new Map();
    const history = [];
    const paint = (sheet) => {
      const c = $('.ink', sheet);
      const r = sheet.getBoundingClientRect();
      const dpr = Math.min(devicePixelRatio || 1, 2);
      c.width = r.width * dpr;
      c.height = r.height * dpr;
      drawStrokes(c.getContext('2d'), strokes.get(sheet) || [], c.width, c.height);
    };
    for (const sheet of sheets) {
      const c = h('<canvas class="ink"></canvas>');
      sheet.append(c);
      new ResizeObserver(() => paint(sheet)).observe(sheet);
      let current = null;
      c.addEventListener('pointerdown', (e) => {
        if (document.body.classList.contains('ink-scroll')) return;
        c.setPointerCapture(e.pointerId);
        const r = c.getBoundingClientRect();
        current = { color: state.options.ink, width: state.options.inkWidth, points: [[(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]] };
        if (!strokes.has(sheet)) strokes.set(sheet, []);
        strokes.get(sheet).push(current);
        history.push(sheet);
      });
      c.addEventListener('pointermove', (e) => {
        if (!current) return;
        const r = c.getBoundingClientRect();
        current.points.push([(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]);
        paint(sheet);
      });
      const end = () => {
        if (current) syncPanel();
        current = null;
      };
      c.addEventListener('pointerup', end);
      c.addEventListener('pointercancel', end);
    }
    return {
      count: () => history.length,
      undo() {
        const sheet = history.pop();
        if (sheet) (strokes.get(sheet).pop(), paint(sheet), syncPanel());
      },
      clear() {
        strokes.clear();
        history.length = 0;
        sheets.forEach(paint);
        syncPanel();
      },
      // One transparent image per page that has drawing on it.
      export() {
        return [...strokes.entries()]
          .filter(([, list]) => list.length)
          .map(([sheet, list]) => {
            const ratio = sheet.clientHeight / sheet.clientWidth;
            const c = document.createElement('canvas');
            c.width = 1600;
            c.height = Math.round(1600 * ratio);
            drawStrokes(c.getContext('2d'), list, c.width, c.height);
            const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            return { page: +sheet.dataset.page, rect: [0, 0, 1, 1], width: c.width, height: c.height, rgba: new Uint8Array(data.buffer.slice(0)) };
          });
      },
    };
  }

  function visibleSheet() {
    let best = state.sheets[0];
    let bestArea = 0;
    for (const s of state.sheets) {
      const r = s.getBoundingClientRect();
      const area = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (area > bestArea) [best, bestArea] = [s, area];
    }
    return best;
  }

  function select(item) {
    for (const i of state.items) i.el.classList.toggle('active', i === item);
    state.active = item;
  }

  // Items are positioned in fractions of the page, so they survive any screen size.
  function layoutItem(item) {
    const s = item.sheet;
    Object.assign(item.el.style, { left: `${item.x * 100}%`, top: `${item.y * 100}%` });
    if (item.kind === 'image') item.el.style.width = `${item.w * 100}%`;
    else if (item.kind === 'box') Object.assign(item.el.style, { width: `${item.w * 100}%`, height: `${item.h * 100}%` });
    else $('.placed-body', item.el).style.fontSize = `${item.size * s.clientWidth}px`;
  }

  function addItem(kind, payload) {
    const sheet = visibleSheet();
    const item = { kind, sheet, page: +sheet.dataset.page, x: 0.3, y: 0.4, w: 0.36, size: state.options.textSize, color: state.options.textColor };
    item.el = h(`<div class="placed placed-${kind}"><div class="placed-body"></div><button class="placed-del" type="button" aria-label="${esc(t('deleteItem'))}">${ICON.close}</button>${kind !== 'text' ? `<span class="placed-size" aria-hidden="true"></span>` : ''}</div>`);
    const body = $('.placed-body', item.el);
    if (kind === 'box') {
      Object.assign(item, { w: 0.5, h: 0.04, color: payload.color, alpha: payload.alpha, x: 0.25 });
      body.style.background = payload.color;
      body.style.opacity = payload.alpha;
      if (payload.color === '#ffffff') item.el.classList.add('placed-white');
    } else if (kind === 'image') {
      item.canvas = payload;
      const img = new Image();
      img.src = payload.toDataURL();
      img.alt = '';
      body.append(img);
      item.x = 0.5 - item.w / 2;
    } else {
      body.contentEditable = 'plaintext-only';
      body.spellcheck = false;
      body.textContent = payload;
      body.style.color = item.color;
      item.x = 0.1;
    }
    // Place it where the reader is looking.
    const r = sheet.getBoundingClientRect();
    const mid = (Math.min(r.bottom, innerHeight) + Math.max(r.top, 0)) / 2;
    // Each new item on the same page steps down a little so nothing hides another.
    const onPage = state.items.filter((i) => i.sheet === sheet).length;
    item.y = Math.max(0.02, Math.min(0.85, (mid - r.top) / r.height - 0.04 + onPage * 0.06));
    sheet.append(item.el);
    layoutItem(item);
    state.items.push(item);
    select(item);
    syncPanel();
    $('.placed-del', item.el).onclick = () => {
      item.el.remove();
      state.items = state.items.filter((i) => i !== item);
      syncPanel();
    };
    if (kind === 'text') {
      const sel = getSelection();
      const range = document.createRange();
      range.selectNodeContents(body);
      sel.removeAllRanges();
      sel.addRange(range);
      body.focus();
    }
    // Drag to move (after a few pixels, so a tap still edits text); corner handle resizes.
    item.el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.placed-del')) return;
      select(item);
      const resizing = e.target.classList.contains('placed-size');
      const start = { x: e.clientX, y: e.clientY, ix: item.x, iy: item.y, iw: item.w, ih: item.h, size: item.size };
      const sr = sheet.getBoundingClientRect();
      let moved = false;
      const move = (ev) => {
        const dx = (ev.clientX - start.x) / sr.width;
        const dy = (ev.clientY - start.y) / sr.height;
        if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
        moved = true;
        ev.preventDefault();
        if (resizing) {
          item.w = Math.max(0.03, Math.min(1 - item.x, start.iw + dx));
          if (item.kind === 'box') item.h = Math.max(0.01, Math.min(1 - item.y, start.ih + dy));
        }
        else {
          const er = item.el.getBoundingClientRect();
          item.x = Math.max(0, Math.min(1 - er.width / sr.width, start.ix + dx));
          item.y = Math.max(0, Math.min(1 - er.height / sr.height, start.iy + dy));
        }
        layoutItem(item);
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
      };
      addEventListener('pointermove', move, { passive: false });
      addEventListener('pointerup', up);
      if (item.kind !== 'text' || resizing) e.preventDefault();
    });
  }

  // What the engine needs for one item: page, rectangle in page fractions, RGBA pixels.
  function itemPayload(item) {
    const s = item.sheet.getBoundingClientRect();
    const r = item.el.getBoundingClientRect();
    const body = $('.placed-body', item.el).getBoundingClientRect();
    const rect = [(body.left - s.left) / s.width, (body.top - s.top) / s.height, body.width / s.width, body.height / s.height];
    let canvas = item.canvas;
    if (item.kind === 'box') {
      canvas = document.createElement('canvas');
      canvas.width = canvas.height = 4;
      const cx = canvas.getContext('2d');
      cx.globalAlpha = item.alpha;
      cx.fillStyle = item.color;
      cx.fillRect(0, 0, 4, 4);
    }
    if (item.kind === 'text') {
      const k = 4;
      const el = $('.placed-body', item.el);
      const cs = getComputedStyle(el);
      canvas = document.createElement('canvas');
      canvas.width = Math.ceil(body.width * k);
      canvas.height = Math.ceil(body.height * k);
      const ctx = canvas.getContext('2d');
      ctx.scale(k, k);
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      ctx.fillStyle = item.color;
      ctx.textBaseline = 'top';
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.25;
      const pad = parseFloat(cs.paddingTop) || 0;
      el.innerText.split('\n').forEach((line, i) => ctx.fillText(line, parseFloat(cs.paddingLeft) || 0, pad + i * lh + (lh - parseFloat(cs.fontSize)) / 2));
    }
    void r;
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return { page: item.page, rect, width: canvas.width, height: canvas.height, rgba: new Uint8Array(data.buffer.slice(0)) };
  }

  /* ----- Helpers for the newer tools ----- */

  // Marks pages that render as (almost) pure white, for the reader to confirm.
  async function detectBlankPages() {
    const f = state.files[0];
    const hint = h(`<p class="hint blank-scan">${esc(t('scanning'))}</p>`);
    $('.panel .sub', root)?.after(hint);
    for (const p of state.pages) {
      const page = await f.doc.getPage(p.n);
      const vp = page.getViewport({ scale: 1 });
      const scale = 90 / Math.max(vp.width, vp.height);
      const v = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.ceil(v.width);
      c.height = Math.ceil(v.height);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: v, intent: 'print' }).promise;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let ink = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 225 || d[i + 1] < 225 || d[i + 2] < 225) ink++;
      p.on = ink / (d.length / 4) < 0.003;
      applyPageState(p);
    }
    const found = state.pages.filter((p) => p.on).length;
    hint.textContent = t('blankFound', { pages: tp('pages', found) });
    syncPanel();
  }

  async function showInfo() {
    const f = state.files[0];
    const json = JSON.parse(new TextDecoder().decode(await engine('info', { pdf: f.bytes.slice() })));
    const yes = (v) => (v ? t('yes') : t('no'));
    const rows = [
      [t('infoPages'), json.pages],
      [t('infoSize'), fmtBytes(f.size)],
      [t('infoVersion'), `PDF ${json.version}`],
      [t('infoPageSizes'), Object.entries(json.sizes).map(([s, c]) => { const [w, h2] = s.split('x').map(Number); return `${Math.round((w / 72) * 25.4)} × ${Math.round((h2 / 72) * 25.4)} mm (${c})`; }).join(', ')],
      [t('infoImages'), json.images],
      [t('infoForms'), json.formFields ? json.formFields : t('no')],
      [t('infoBookmarks'), yes(json.bookmarks)],
      [t('infoJs'), yes(json.javascript)],
      [t('infoAttachments'), yes(json.attachments)],
      [t('infoTagged'), yes(json.tagged)],
      [t('infoEncrypted'), yes(json.wasEncrypted)],
      ...Object.entries(json.metadata).map(([k, v]) => [k, v]),
    ];
    const fonts = json.fonts.map((x) => `<li>${esc(x.name)} <span>${esc(x.type)} · ${esc(x.embedded ? t('embedded') : t('notEmbedded'))}</span></li>`).join('');
    const box = h(`<div class="info-table"><dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>`).join('')}</dl>${fonts ? `<h4>${esc(t('infoFonts'))}</h4><ul>${fonts}</ul>` : ''}</div>`);
    $('.stage', root).append(box);
  }

  // Renders short text into images, one per page slot, for header/footer and Bates numbers.
  async function textStamps(f, o, mode) {
    const items = [];
    const date = new Intl.DateTimeFormat(I18N.code, { dateStyle: 'medium' }).format(new Date());
    for (let n = o.first; n <= f.pageCount; n++) {
      const page = await f.doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const slots = mode === 'bates'
        ? { [{ 'bottom-right': 'fr', 'bottom-left': 'fl', 'top-right': 'hr' }[o.corner]]: `${o.prefix}${String(o.start + n - o.first).padStart(o.digits, '0')}` }
        : o.slots;
      for (const [k, raw] of Object.entries(slots)) {
        if (!raw?.trim()) continue;
        const text = raw.replace(/\{page\}/g, n).replace(/\{total\}/g, f.pageCount).replace(/\{date\}/g, date).replace(/\{file\}/g, f.name);
        const c = textImage(text, '#3a3a3c', 64, 500);
        const hPts = o.size * 1.35;
        const wPts = (hPts * c.width) / c.height;
        const m = 22;
        const x = k[1] === 'l' ? m : k[1] === 'r' ? vp.width - m - wPts : (vp.width - wPts) / 2;
        const y = k[0] === 'h' ? m - 4 : vp.height - m - hPts + 4;
        const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        items.push({ page: n, rect: [x / vp.width, y / vp.height, wPts / vp.width, hPts / vp.height], width: c.width, height: c.height, rgba: new Uint8Array(data.buffer.slice(0)) });
      }
    }
    return items;
  }

  // Stitches pages into one tall image, lowering resolution to stay within browser limits.
  async function longImage(doc, pages, format) {
    const sizes = [];
    for (const n of pages) sizes.push((await doc.getPage(n)).getViewport({ scale: 1 }));
    const maxW = Math.max(...sizes.map((v) => v.width));
    const totalH = sizes.reduce((a, v) => a + v.height, 0);
    const scale = Math.min(2, 16000 / totalH, Math.sqrt(90e6 / (maxW * totalH)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(maxW * scale);
    canvas.height = Math.round(totalH * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    let y = 0;
    for (const n of pages) {
      const page = await doc.getPage(n);
      const v = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.round(v.width);
      c.height = Math.round(v.height);
      await page.render({ canvasContext: c.getContext('2d'), viewport: v, intent: 'print' }).promise;
      ctx.drawImage(c, Math.round((canvas.width - c.width) / 2), y);
      y += c.height;
    }
    return new Promise((r) => canvas.toBlob(r, `image/${format}`, 0.9));
  }

  // True redaction: pages with boxes are re-rendered with the boxes burned in.
  async function redact(f) {
    const byPage = new Map();
    for (const it of state.items) {
      const s = it.sheet.getBoundingClientRect();
      const r = it.el.getBoundingClientRect();
      if (!byPage.has(it.page)) byPage.set(it.page, []);
      byPage.get(it.page).push([(r.left - s.left) / s.width, (r.top - s.top) / s.height, r.width / s.width, r.height / s.height]);
    }
    const pages = [];
    const sizes = [];
    const jpegs = [];
    for (const [n, boxes] of byPage) {
      const page = await f.doc.getPage(n);
      const v = page.getViewport({ scale: 200 / 72 });
      const c = document.createElement('canvas');
      c.width = Math.round(v.width);
      c.height = Math.round(v.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: v, intent: 'print' }).promise;
      ctx.fillStyle = '#000';
      for (const [x, y, w, hh] of boxes) ctx.fillRect(x * c.width, y * c.height, w * c.width, hh * c.height);
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
      pages.push(n);
      sizes.push(c.width, c.height);
      jpegs.push(new Uint8Array(await blob.arrayBuffer()));
    }
    return engine('rasterize', { pdf: f.bytes.slice(), pages, sizes, jpegs }, jpegs.map((j) => j.buffer));
  }

  async function pageWords(f) {
    const pages = [];
    for (let i = 1; i <= f.pageCount; i++) {
      const c = await (await f.doc.getPage(i)).getTextContent();
      pages.push(c.items.map((x) => x.str).join(' ').split(/\s+/).filter(Boolean));
    }
    return pages;
  }

  // Word-level differences per page (longest common subsequence).
  async function compareDocs(a, b) {
    const [pa, pb] = [await pageWords(a), await pageWords(b)];
    const out = [];
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || [];
      const y = pb[i] || [];
      if (x.join(' ') === y.join(' ')) {
        out.push({ page: i + 1, same: true });
        continue;
      }
      if (x.length * y.length > 4e6) {
        out.push({ page: i + 1, parts: [['del', x.join(' ')], ['ins', y.join(' ')]] });
        continue;
      }
      const dp = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
      for (let r = x.length - 1; r >= 0; r--) for (let c = y.length - 1; c >= 0; c--) dp[r][c] = x[r] === y[c] ? dp[r + 1][c + 1] + 1 : Math.max(dp[r + 1][c], dp[r][c + 1]);
      const parts = [];
      const push = (kind, word) => (parts.length && parts.at(-1)[0] === kind ? (parts.at(-1)[1] += ` ${word}`) : parts.push([kind, word]));
      let r = 0;
      let c = 0;
      while (r < x.length && c < y.length) {
        if (x[r] === y[c]) push('same', x[r++]), c++;
        else if (dp[r + 1][c] >= dp[r][c + 1]) push('del', x[r++]);
        else push('ins', y[c++]);
      }
      while (r < x.length) push('del', x[r++]);
      while (c < y.length) push('ins', y[c++]);
      out.push({ page: i + 1, parts });
    }
    return out;
  }

  function showCompare(result) {
    const changed = result.filter((p) => !p.same);
    const el = h(`<div class="done compare-result"><h2>${esc(changed.length ? t('compareChanged', { pages: tp('pages', changed.length) }) : t('compareSame'))}</h2>
      <p class="file">${esc(state.files[0].name)} → ${esc(state.files[1].name)}</p>
      <div class="diff">${changed.map((p) => `<section><h3>${esc(fill(t('pageWord'), { n: p.page }))}</h3><p>${p.parts.map(([k, w]) => (k === 'same' ? esc(w) : `<${k}>${esc(w)}</${k}>`)).join(' ')}</p></section>`).join('')}</div>
      <div class="actions"><button class="btn-plain start-over" type="button">${esc(t('startOver'))}</button></div></div>`);
    $('.start-over', el).onclick = reset;
    dropBar();
    root.replaceChildren(el);
  }

  // Form filling with PDF.js's own form layer; values are saved back into the PDF.
  async function viewForm(stage) {
    const f = state.files[0];
    if (!document.getElementById('pdfjs-viewer-css')) {
      const link = document.createElement('link');
      link.id = 'pdfjs-viewer-css';
      link.rel = 'stylesheet';
      link.href = `${PDFJS}/pdf_viewer.css`;
      document.head.append(link);
    }
    const lib = await pdfjs();
    const head = h(`<div class="stage-head"><b style="color:var(--text)">${esc(f.name)}</b><span>${tp('pages', f.pageCount)}</span></div>`);
    const list = h('<div class="sheets"></div>');
    stage.append(head, list);
    const fields = await f.doc.getFieldObjects();
    if (!fields || !Object.keys(fields).length) {
      const prefix = I18N.langs.find((l) => l.code === I18N.code)?.prefix || '';
      list.before(h(`<div class="alert"><b>!</b><div>${esc(t('noFields'))} <a href="${prefix}/add-text-to-pdf/">${esc(t('useAddText'))}</a></div></div>`));
    }
    for (let n = 1; n <= f.pageCount; n++) {
      const pg = await f.doc.getPage(n);
      const base = pg.getViewport({ scale: 1 });
      const sheet = h('<div class="sheet form-sheet"><div class="sheet-canvas"></div></div>');
      sheet.style.aspectRatio = `${base.width} / ${base.height}`;
      list.append(sheet);
      const width = sheet.clientWidth || 600;
      const scale = width / base.width;
      const vp = pg.getViewport({ scale });
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width * dpr);
      canvas.height = Math.ceil(vp.height * dpr);
      await pg.render({ canvasContext: canvas.getContext('2d'), viewport: pg.getViewport({ scale: scale * dpr }), annotationMode: lib.AnnotationMode.ENABLE_FORMS }).promise;
      $('.sheet-canvas', sheet).append(canvas);
      const layerDiv = h('<div class="annotationLayer"></div>');
      sheet.style.setProperty('--scale-factor', scale);
      sheet.style.setProperty('--total-scale-factor', scale);
      sheet.append(layerDiv);
      const annotations = await pg.getAnnotations({ intent: 'display' });
      const layer = new lib.AnnotationLayer({ div: layerDiv, page: pg, viewport: vp.clone({ dontFlip: true }), annotationStorage: f.doc.annotationStorage, linkService: { getDestinationHash: () => '#', getAnchorUrl: () => '#', addLinkAttributes: () => {}, isInPresentationMode: false, eventBus: { dispatch() {}, _on() {} } } });
      await layer.render({ annotations, renderForms: true, annotationStorage: f.doc.annotationStorage, enableScripting: false, hasJSActions: false, fieldObjects: fields });
    }
  }

  /* ----- Running a job ----- */

  function busy(message) {
    const el = h(`<div class="busy" role="status" aria-live="polite"><div><div class="spinner"></div>${esc(message)}<small>${esc(t('busyNote'))}</small></div></div>`);
    root.append(el);
    return el;
  }

  async function run() {
    const o = state.options;
    const f = state.files[0];
    const base = baseName(f.name);
    const verb = { bookmarks: 'busySave', background: 'busySave', simple: 'busySave', toText: 'busySave', toEpub: 'busyRender', fromEpub: 'busyRender', compare: 'busySave', longImage: 'busyRender', crop: 'busySave', nup: 'busySave', metadata: 'busySave', repair: 'busyRepair', place: 'busySave', merge: 'busyMerge', images: 'busyImages', split: 'busySplit', extract: 'busySplit', compress: 'busyCompress', numbers: 'busyNumbers', watermark: 'busyWatermark', protect: 'busyProtect', unlock: 'busyUnlock', toImages: 'busyRender' }[tool.mode] || 'busySave';
    const spinner = busy(t(verb));
    const copy = (b) => b.slice();
    let out;
    let name;
    let type = 'application/pdf';
    const t0 = performance.now();

    switch (tool.mode) {
      case 'merge': {
        const files = state.files.map((x) => copy(x.bytes));
        out = await engine('merge', { files }, files.map((b) => b.buffer));
        name = 'merged.pdf';
        break;
      }
      case 'images': {
        const images = [];
        for (const im of state.files) {
          if (/jpe?g$/i.test(im.file.type) || /\.jpe?g$/i.test(im.name)) images.push({ jpeg: true, data: copy(im.bytes) });
          else images.push({ jpeg: false, ...(await decodeImage(im.file)) });
        }
        out = await engine('images', { images, paper: o.paper, margin: o.margin }, images.map((i) => i.data.buffer));
        name = state.files.length === 1 ? `${base}.pdf` : 'images.pdf';
        break;
      }
      case 'organize':
      case 'rotate': {
        const keep = state.pages.filter((p) => !p.off);
        out = await engine('organize', { pdf: copy(f.bytes), pages: keep.map((p) => p.n), rotations: keep.map((p) => p.rot) });
        name = `${base}-${tool.mode === 'rotate' ? 'rotated' : 'organized'}.pdf`;
        break;
      }
      case 'bookmarks': {
        const marks = o.marks || [];
        out = await engine('setBookmarks', { pdf: copy(f.bytes), titles: marks.map((m) => m.title), pages: marks.map((m) => m.page) });
        name = `${base}-bookmarks.pdf`;
        break;
      }
      case 'background': {
        const [a, b] = state.files.map((x) => copy(x.bytes));
        out = await engine('addBackground', { pdf: a, background: b, onTop: o.onTop, firstOnly: o.firstOnly }, [a.buffer, b.buffer]);
        name = `${baseName(state.files[0].name)}-letterhead.pdf`;
        break;
      }
      case 'delete': {
        if (tool.splitAtBlank) {
          // Runs of pages between blank separators become separate files.
          const groups = [[]];
          for (const p of state.pages) p.on ? groups.at(-1).length && groups.push([]) : groups.at(-1).push(p.n);
          const parts = groups.filter((g) => g.length);
          if (!parts.length) throw new Error(t('errInvalid'));
          out = await engine('split', { pdf: copy(f.bytes), groups: parts, base });
          if (parts.length > 1) [name, type] = [`${base}-split.zip`, 'application/zip'];
          else name = `${base}-part.pdf`;
          break;
        }
        const keep = state.pages.filter((p) => !p.on);
        out = await engine('organize', { pdf: copy(f.bytes), pages: keep.map((p) => p.n), rotations: [] });
        name = `${base}-edited.pdf`;
        break;
      }
      case 'extract': {
        const sel = state.pages.filter((p) => p.on).map((p) => p.n);
        const groups = o.each ? sel.map((n) => [n]) : [sel];
        out = await engine('split', { pdf: copy(f.bytes), groups, base });
        if (groups.length > 1) [name, type] = [`${base}-pages.zip`, 'application/zip'];
        else name = `${base}-extracted.pdf`;
        break;
      }
      case 'split': {
        const groups = splitGroups();
        out = await engine('split', { pdf: copy(f.bytes), groups, base });
        if (groups.length > 1) [name, type] = [`${base}-split.zip`, 'application/zip'];
        else name = `${base}-part.pdf`;
        break;
      }
      case 'compress':
        out = await engine('compress', { pdf: copy(f.bytes), level: o.level });
        name = `${base}-compressed.pdf`;
        break;
      case 'numbers':
        out = await engine('numbers', { pdf: copy(f.bytes), position: o.position, template: o.template, start: o.start, firstPage: o.first, size: o.size, margin: 24 });
        name = `${base}-numbered.pdf`;
        break;
      case 'watermark': {
        const mark = tool.watermarkImage ? o.image : textImage(o.text, o.color, 200);
        const rgba = new Uint8Array(mark.getContext('2d').getImageData(0, 0, mark.width, mark.height).data.buffer);
        out = await engine('watermark', { pdf: copy(f.bytes), rgba, width: mark.width, height: mark.height, scale: o.scale, rotation: o.rotation, opacity: o.opacity, tiled: o.tiled }, [rgba.buffer]);
        name = `${base}-watermarked.pdf`;
        break;
      }
      case 'protect':
        out = await engine('protect', { pdf: copy(f.bytes), password: o.password, allowPrint: o.allowPrint, allowCopy: o.allowCopy });
        name = `${base}-protected.pdf`;
        break;
      case 'simple': {
        const args = { pdf: copy(f.bytes), base, keepLinks: o.keepLinks };
        if (tool.op === 'reverse') args.pages = Array.from({ length: f.pageCount }, (_, i) => f.pageCount - i);
        out = await engine(tool.op, args);
        const suffix = { extractImages: 'images', grayscale: 'grayscale', removeImages: 'no-images', reverse: 'reversed', splitBookmarks: 'chapters', flatten: 'flat', removeAnnotations: 'clean' }[tool.op];
        if (['extractImages', 'splitBookmarks'].includes(tool.op)) [name, type] = [`${base}-${suffix}.zip`, 'application/zip'];
        else name = `${base}-${suffix}.pdf`;
        break;
      }
      case 'toEpub': {
        const files = await pdfToEpub(f.doc, { name: base, layout: o.layout, onPage: (i, n) => spinner.progress?.(i / n) });
        out = await engine('zip', { files }, files.map((x) => x.data.buffer));
        [name, type] = [`${base}.epub`, 'application/epub+zip'];
        break;
      }
      case 'fromEpub': {
        const r = await epubToPdf(f.bytes.slice(), { paper: o.paper, fontSize: o.font });
        out = r.bytes;
        name = `${base}.pdf`;
        break;
      }
      case 'toText': {
        let text = '';
        for (let i = 1; i <= f.pageCount; i++) {
          const page = await f.doc.getPage(i);
          const content = await page.getTextContent();
          if (o.marks) text += `${i > 1 ? '\n' : ''}--- ${fill(t('pageWord'), { n: i })} ---\n`;
          for (const item of content.items) text += item.str + (item.hasEOL ? '\n' : '');
          text += '\n';
        }
        out = new TextEncoder().encode(text);
        [name, type] = [`${base}.txt`, 'text/plain'];
        break;
      }
      case 'blank': {
        const after = o.where === 'some' && o.after.trim() ? parseRanges(o.after, f.pageCount).flat() : [];
        out = await engine('insertBlank', { pdf: copy(f.bytes), after, every: o.where !== 'some' });
        name = `${base}-with-blanks.pdf`;
        break;
      }
      case 'mix': {
        const [a, b] = state.files.map((x) => copy(x.bytes));
        out = await engine('interleave', { a, b, reverseB: o.reverseB }, [a.buffer, b.buffer]);
        name = `${baseName(state.files[0].name)}-combined.pdf`;
        break;
      }
      case 'half':
        out = await engine('splitHalf', { pdf: copy(f.bytes), vertical: o.vertical, rtl: o.rtl });
        name = `${base}-split-pages.pdf`;
        break;
      case 'resize':
        out = await engine('resize', { pdf: copy(f.bytes), paper: o.paper });
        name = `${base}-${o.paper}.pdf`;
        break;
      case 'margins':
        out = await engine('addMargins', { pdf: copy(f.bytes), points: (o.mm * 72) / 25.4 });
        name = `${base}-margins.pdf`;
        break;
      case 'booklet':
        out = await engine('booklet', { pdf: copy(f.bytes), paper: o.paper });
        name = `${base}-booklet.pdf`;
        break;
      case 'splitSize':
        out = await engine('splitBySize', { pdf: copy(f.bytes), maxBytes: Math.round(o.mb * 1048576), base });
        [name, type] = [`${base}-parts.zip`, 'application/zip'];
        break;
      case 'headerFooter':
      case 'bates': {
        const items = await textStamps(f, o, tool.mode);
        out = await engine('place', { pdf: copy(f.bytes), items }, items.map((i) => i.rgba.buffer));
        name = `${base}-${tool.mode === 'bates' ? 'bates' : 'header-footer'}.pdf`;
        break;
      }
      case 'longImage': {
        const blob = await longImage(f.doc, state.pages.filter((p) => p.on).map((p) => p.n), o.format);
        out = new Uint8Array(await blob.arrayBuffer());
        [name, type] = [`${base}-long.${o.format === 'png' ? 'png' : 'jpg'}`, `image/${o.format}`];
        break;
      }
      case 'compare': {
        const result = await compareDocs(state.files[0], state.files[1]);
        spinner.remove();
        return showCompare(result);
      }
      case 'form': {
        out = await f.doc.saveDocument();
        name = `${base}-filled.pdf`;
        break;
      }
      case 'crop': {
        const pages = o.scope === 'some' && o.range?.trim() ? parseRanges(o.range, f.pageCount).flat() : [];
        out = await engine('crop', { pdf: copy(f.bytes), pages, margins: o.m });
        name = `${base}-cropped.pdf`;
        break;
      }
      case 'nup':
        out = await engine('nup', { pdf: copy(f.bytes), perSheet: o.per, paper: o.paper });
        name = `${base}-${o.per}-up.pdf`;
        break;
      case 'metadata': {
        const m = o.meta || {};
        out = await engine('metadata', { pdf: copy(f.bytes), title: m.Title || '', author: m.Author || '', subject: m.Subject || '', keywords: m.Keywords || '', wipe: !!o.wipe });
        name = `${base}${o.wipe ? '-clean' : ''}.pdf`;
        o.wipe = false;
        break;
      }
      case 'repair':
        out = await engine('repair', { pdf: copy(f.bytes) });
        name = `${base}-repaired.pdf`;
        break;
      case 'place': {
        if (tool.editor === 'draw') {
          const items = state.ink.export();
          out = await engine('place', { pdf: copy(f.bytes), items }, items.map((i) => i.rgba.buffer));
          name = `${base}-drawing.pdf`;
          break;
        }
        if (tool.editor === 'redact') {
          out = await redact(f);
          name = `${base}-redacted.pdf`;
          break;
        }
        const items = state.items.map(itemPayload);
        out = await engine('place', { pdf: copy(f.bytes), items }, items.map((i) => i.rgba.buffer));
        name = `${base}-${tool.slug === 'sign-pdf' ? 'signed' : 'edited'}.pdf`;
        break;
      }
      case 'unlock':
        out = await engine('unlock', { pdf: copy(f.bytes), password: o.password || '' });
        name = `${base}-unlocked.pdf`;
        break;
      case 'toImages': {
        const sel = state.pages.filter((p) => p.on);
        const ext = o.format === 'png' ? 'png' : 'jpg';
        const files = [];
        for (const [i, p] of sel.entries()) {
          $('.busy small', spinner).textContent = t('busyPage', { i: i + 1, n: sel.length });
          files.push({ name: `${base}-page-${p.n}.${ext}`, data: await pageImage(f.doc, p.n, o.scale, o.format) });
        }
        if (files.length === 1) [out, name, type] = [files[0].data, files[0].name, `image/${o.format}`];
        else {
          out = await engine('zip', { files }, files.map((x) => x.data.buffer));
          [name, type] = [`${base}-images.zip`, 'application/zip'];
        }
        break;
      }
    }
    // Keep the spinner up briefly so very fast jobs do not flash.
    const elapsed = performance.now() - t0;
    if (elapsed < 450) await new Promise((r) => setTimeout(r, 450 - elapsed));
    spinner.remove();
    showResult({ bytes: out, name, type, before: tool.mode === 'compress' ? f.size : null });
  }

  async function decodeImage(file) {
    const bmp = await createImageBitmap(file).catch(async () => {
      const img = new Image();
      img.src = URL.createObjectURL(file);
      await img.decode();
      return img;
    });
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    return { data: new Uint8Array(ctx.getImageData(0, 0, c.width, c.height).data.buffer), width: c.width, height: c.height };
  }

  async function pageImage(doc, n, scale, format) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Print intent renders without requestAnimationFrame, so it keeps going in background tabs.
    await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
    const blob = await new Promise((r) => canvas.toBlob(r, `image/${format}`, 0.9));
    return new Uint8Array(await blob.arrayBuffer());
  }

  function showResult({ bytes, name, type, before }) {
    if (embedded) {
      dropBar();
      input.remove();
      return opts.onResult?.({ bytes, name, type, before });
    }
    const blob = new Blob([bytes], { type });
    const url = URL.createObjectURL(blob);
    state.result = { url, bytes, name, type };
    let saving = '';
    if (before) {
      const pct = Math.round((1 - blob.size / before) * 100);
      saving = pct > 0 ? `<p class="saving">${esc(t('smaller', { pct }))} · <bdi>${fmtBytes(before)} → ${fmtBytes(blob.size)}</bdi></p>` : `<p class="saving" style="color:var(--text-2);background:var(--surface-2)">${esc(t('optimised'))}</p>`;
    }
    const title = t(type === 'application/zip' ? 'readyFiles' : type.startsWith('image/') ? 'readyImage' : type === 'text/plain' ? 'readyText' : 'readyPdf');
    if (type === 'text/plain') {
      const text = new TextDecoder().decode(bytes);
      saving = text.trim() ? `<pre class="text-preview">${esc(text.slice(0, 4000))}</pre>` : `<p class="saving" style="color:var(--text-2)">${esc(t('noText'))}</p>`;
    }
    const el = h(`<div class="done">
      <svg class="check-anim" viewBox="0 0 84 84" fill="none" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><circle cx="42" cy="42" r="38"/><path d="m27 43 10 10 21-22"/></svg>
      <h2>${esc(title)}</h2>
      <p class="file">${esc(name)} · ${fmtBytes(blob.size)}</p>${saving}
      <div class="actions">
        <a class="btn primary big" href="${url}" download="${esc(name)}">${esc(t('download'))}</a>
        <button class="btn-plain start-over" type="button">${esc(t('startOver'))}</button>
      </div>
    </div>`);
    $('.start-over', el).onclick = reset;
    if (type === 'application/pdf' && tool.next?.length) {
      const next = h(`<div class="next"><h3>${esc(t('continueWith'))}</h3><div class="chips"></div></div>`);
      for (const nt of tool.next) {
        const chip = h(`<button class="chip" type="button" style="--tint:${nt.color}"><span class="tool-icon">${nt.icon}</span>${esc(nt.name)}</button>`);
        chip.onclick = async () => {
          await handoffPut({ bytes, name, type });
          location.href = `${nt.href}#handoff`;
        };
        $('.chips', next).append(chip);
      }
      el.append(next);
    }
    dropBar();
    root.replaceChildren(el);
    root.scrollIntoView({ block: 'start', behavior: 'smooth' });
    $('a.btn', el).focus({ preventScroll: true });
  }
  if (opts.files) addFiles(opts.files);
}

/* ---------- Watermark drawing (shared by preview and output) ---------- */

function textImage(text, color, px, weight = 700) {
  const font = `${weight} ${px}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Noto Sans", "Noto Sans Arabic", sans-serif`;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width + px * 0.4);
  c.width = Math.max(1, w);
  c.height = Math.ceil(px * 1.35);
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(text, c.width / 2, c.height / 2);
  return c;
}

// Mirrors the engine's placement so the preview matches the saved PDF.
function drawMarks(ctx, w, h, mark, o) {
  const dw = w * o.scale;
  const dh = (dw * mark.height) / mark.width;
  const centers = [];
  if (o.tiled) {
    const sx = dw * 1.6;
    const sy = Math.max(dh * 3, dw * 0.6);
    for (let row = 0, y = sy / 2; y < h + sy; y += sy, row++) for (let x = row % 2 ? sx / 2 : 0; x < w + sx; x += sx) centers.push([x, h - y]);
  } else centers.push([w / 2, h / 2]);
  ctx.globalAlpha = o.opacity;
  for (const [x, y] of centers) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((-o.rotation * Math.PI) / 180);
    ctx.drawImage(mark, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }
}

/* ---------- Language suggestion ---------- */

// Offers the visitor's own language once, without redirecting (search engines and shared
// links keep landing on the language they asked for).
(() => {
  const langs = I18N.langs || [];
  const here = langs.find((l) => l.code === I18N.code);
  if (!here) return;
  let dismissed = false;
  try {
    dismissed = localStorage.getItem('lang-suggest') === 'off';
  } catch {}
  if (dismissed) return;
  const wanted = (navigator.languages || [navigator.language]).map((l) => l.toLowerCase());
  const pick = (code) => wanted.some((w) => w === code || w.startsWith(`${code}-`) || (code === 'ckb' && (w === 'ku-iq' || w === 'ckb-iq')));
  if (pick(here.code)) return;
  const match = langs.find((l) => l.code !== here.code && pick(l.code));
  if (!match) return;
  const path = location.pathname.slice(here.prefix.length) || '/';
  const bar = h(`<div class="lang-suggest" lang="${match.code}" dir="${match.dir}" role="region">
    <span>${esc(fill(match.text, { lang: match.name }))}</span>
    <a class="btn primary small" href="${match.prefix}${path}">${esc(match.switch)}</a>
    <button class="icon-btn" type="button" aria-label="${esc(match.dismiss)}">${ICON.close}</button>
  </div>`);
  $('button', bar).onclick = () => {
    bar.remove();
    try {
      localStorage.setItem('lang-suggest', 'off');
    } catch {}
  };
  document.querySelector('.nav')?.after(bar);
})();

/* ---------- Signature pad ---------- */

// Crops a canvas to its visible pixels, with a little breathing room.
function trimCanvas(src, pad = 8) {
  const ctx = src.getContext('2d');
  const { data, width, height } = ctx.getImageData(0, 0, src.width, src.height);
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1 + pad * 2;
  out.height = y1 - y0 + 1 + pad * 2;
  out.getContext('2d').drawImage(src, x0, y0, x1 - x0 + 1, y1 - y0 + 1, pad, pad, x1 - x0 + 1, y1 - y0 + 1);
  return out;
}

const SCRIPT_FONTS = [
  '"Snell Roundhand", "Apple Chancery", "Segoe Script", "Brush Script MT", cursive',
  '"Bradley Hand", "Segoe Print", "Ink Free", cursive',
  '"Savoye LET", "Lucida Handwriting", "Edwardian Script ITC", cursive',
];

// Resolves to a trimmed canvas with a transparent background, or null if cancelled.
function signatureDialog() {
  return new Promise((resolve) => {
    let mode = 'draw';
    let color = '#1d1d1f';
    let font = 0;
    let uploaded = null;
    const dlg = h(`<dialog class="sig-dialog">
      <h2>${esc(t('createSignature'))}</h2>
      <div class="sig-tabs"></div>
      <div class="sig-pane" data-pane="draw"><div class="sig-pad-wrap"><canvas class="sig-pad"></canvas><span class="sig-line">${esc(t('signHere'))}</span></div></div>
      <div class="sig-pane" data-pane="type" hidden><input class="input sig-name" type="text" placeholder="${esc(t('yourName'))}" autocomplete="name"><div class="sig-fonts"></div></div>
      <div class="sig-pane" data-pane="upload" hidden><label class="btn"><input type="file" accept="image/*" hidden>${esc(t('chooseImage'))}</label><label class="check"><input type="checkbox" checked> ${esc(t('removeWhite'))}</label><div class="sig-upload-preview"></div></div>
      <div class="sig-foot"><div class="swatches"></div><span class="spacer"></span><button class="btn-plain sig-clear" type="button">${esc(t('clearPad'))}</button></div>
      <div class="sig-actions"><button class="btn sig-cancel" type="button">${esc(t('cancel'))}</button><button class="btn primary sig-use" type="button">${esc(t('useSignature'))}</button></div>
    </dialog>`);
    document.body.append(dlg);
    const pad = $('.sig-pad', dlg);
    const ctx = pad.getContext('2d');
    const dpr = Math.min(devicePixelRatio || 1, 3);
    const sizePad = () => {
      const r = pad.getBoundingClientRect();
      pad.width = r.width * dpr;
      pad.height = r.height * dpr;
      ctx.scale(dpr, dpr);
      ctx.lineCap = ctx.lineJoin = 'round';
    };
    const tabs = seg2(
      [['draw', t('draw')], ['type', t('typeIt')], ['upload', t('upload')]],
      mode,
      (v) => {
        mode = v;
        for (const p of dlg.querySelectorAll('.sig-pane')) p.hidden = p.dataset.pane !== v;
        $('.sig-clear', dlg).hidden = v !== 'draw';
        if (v === 'type') $('.sig-name', dlg).focus();
      },
    );
    $('.sig-tabs', dlg).append(tabs);
    for (const [c, name] of [['#1d1d1f', t('black')], ['#0040dd', t('blue')]]) {
      const b = h(`<button type="button" class="swatch" style="background:${c}" aria-label="${esc(name)}" aria-pressed="${c === color}"></button>`);
      b.onclick = () => {
        color = c;
        for (const x of $('.swatches', dlg).children) x.setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-pressed', 'true');
        renderFonts();
      };
      $('.swatches', dlg).append(b);
    }
    // Drawing with smooth, pressure-free strokes.
    let last = null;
    const point = (e) => {
      const r = pad.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    pad.addEventListener('pointerdown', (e) => {
      pad.setPointerCapture(e.pointerId);
      last = point(e);
      $('.sig-line', dlg).classList.add('used');
    });
    pad.addEventListener('pointermove', (e) => {
      if (!last) return;
      const p = point(e);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(...last);
      ctx.quadraticCurveTo(last[0], last[1], (last[0] + p[0]) / 2, (last[1] + p[1]) / 2);
      ctx.lineTo(...p);
      ctx.stroke();
      last = p;
    });
    pad.addEventListener('pointerup', () => (last = null));
    pad.style.touchAction = 'none';
    $('.sig-clear', dlg).onclick = () => {
      ctx.clearRect(0, 0, pad.width, pad.height);
      $('.sig-line', dlg).classList.remove('used');
    };
    // Typed signature in a choice of handwriting faces available on the device.
    const nameInput = $('.sig-name', dlg);
    const renderFonts = () => {
      const box = $('.sig-fonts', dlg);
      box.replaceChildren();
      SCRIPT_FONTS.forEach((ff, i) => {
        const b = h(`<button type="button" class="sig-font" aria-pressed="${i === font}" style="font-family:${ff};color:${color}">${esc(nameInput.value || t('yourName'))}</button>`);
        b.onclick = () => {
          font = i;
          renderFonts();
        };
        box.append(b);
      });
    };
    nameInput.oninput = renderFonts;
    renderFonts();
    // Uploaded image, optionally with its paper background made transparent.
    const fileInput = $('[data-pane="upload"] input[type=file]', dlg);
    const whiteBox = $('[data-pane="upload"] input[type=checkbox]', dlg);
    const showUpload = async () => {
      const file = fileInput.files[0];
      if (!file) return;
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      const cx = c.getContext('2d');
      cx.drawImage(bmp, 0, 0, c.width, c.height);
      if (whiteBox.checked) {
        const img = cx.getImageData(0, 0, c.width, c.height);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          const light = Math.min(d[i], d[i + 1], d[i + 2]);
          if (light > 200) d[i + 3] = Math.round(Math.max(0, 255 - (light - 200) * 4.6));
        }
        cx.putImageData(img, 0, 0);
      }
      uploaded = c;
      const prev = $('.sig-upload-preview', dlg);
      prev.replaceChildren(c);
    };
    fileInput.onchange = showUpload;
    whiteBox.onchange = showUpload;

    const close = (value) => {
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    $('.sig-cancel', dlg).onclick = () => close(null);
    dlg.addEventListener('cancel', (e) => (e.preventDefault(), close(null)));
    $('.sig-use', dlg).onclick = () => {
      let out = null;
      if (mode === 'draw') out = trimCanvas(pad);
      else if (mode === 'type' && nameInput.value.trim()) {
        const c = document.createElement('canvas');
        const cx = c.getContext('2d');
        const f = `160px ${SCRIPT_FONTS[font]}`;
        cx.font = f;
        c.width = Math.ceil(cx.measureText(nameInput.value).width + 120);
        c.height = 280;
        cx.font = f;
        cx.fillStyle = color;
        cx.textBaseline = 'middle';
        cx.fillText(nameInput.value, 60, 140);
        out = trimCanvas(c);
      } else if (mode === 'upload' && uploaded) out = trimCanvas(uploaded, 4);
      if (out) close(out);
    };
    dlg.showModal();
    requestAnimationFrame(sizePad);
  });
}

// Segmented control used outside the tool panel.
function seg2(options, value, onChange) {
  const el = h('<div class="seg" role="group"></div>');
  for (const [v, label] of options) {
    const b = h(`<button type="button" aria-pressed="${v === value}">${esc(label)}</button>`);
    b.onclick = () => {
      for (const x of el.children) x.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-pressed', 'true');
      onChange(v);
    };
    el.append(b);
  }
  return el;
}


/* ---------- The app (/app/) ---------- */

/* ----- ePub, both ways. Everything happens in this tab. ----- */

const xmlText = (s) => esc(String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, ''));
const RTL_CHARS = /[֐-ࣿיִ-﷿ﹰ-﻿]/g;

// Reads a zip (stored or deflated) with the browser's own decompressor.
function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let e = bytes.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('INVALID: not an ePub file');
  const files = new Map();
  const dec = new TextDecoder();
  let p = dv.getUint32(e + 16, true);
  for (let i = dv.getUint16(e + 10, true); i > 0 && dv.getUint32(p, true) === 0x02014b50; i--) {
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const at = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    const start = at + 30 + dv.getUint16(at + 26, true) + dv.getUint16(at + 28, true);
    files.set(name, { method, raw: bytes.subarray(start, start + size) });
  }
  return {
    has: (name) => files.has(name),
    async get(name) {
      const f = files.get(name);
      if (!f) return null;
      if (f.method === 0) return f.raw;
      return new Uint8Array(await new Response(new Blob([f.raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    },
    async text(name) {
      const b = await this.get(name);
      return b ? new TextDecoder().decode(b) : null;
    },
  };
}

const resolvePath = (from, href) => {
  try {
    return decodeURIComponent(new URL(href, `http://x/${from}`).pathname.slice(1));
  } catch {
    return href;
  }
};
const dataUrl = async (bytes, type) => {
  const r = new FileReader();
  return new Promise((res) => ((r.onload = () => res(r.result)), r.readAsDataURL(new Blob([bytes], { type }))));
};

// PDF to ePub. "text" makes a reflowable book from the text; "pages" keeps every page as a picture.
async function pdfToEpub(pdf, { name, layout, onPage }) {
  const n = pdf.numPages;
  const meta = await pdf.getMetadata().catch(() => null);
  const title = meta?.info?.Title?.trim() || name;
  const author = meta?.info?.Author?.trim() || '';
  // Sections follow the bookmarks when there are any, else every 20 pages.
  let starts = [];
  try {
    for (const item of (await pdf.getOutline()) || []) {
      const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
      if (dest?.[0]) starts.push({ page: (typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0])) + 1, title: item.title });
    }
  } catch {}
  starts = starts.filter((s, i, a) => s.page >= 1 && s.page <= n && a.findIndex((x) => x.page === s.page) === i).sort((a, b) => a.page - b.page);
  if (!starts.length) for (let p = 1; p <= n; p += 20) starts.push({ page: p, title: n > 20 ? `${fill(t('pageWord'), { n: p })}` : title });
  else if (starts[0].page > 1) starts.unshift({ page: 1, title });

  const files = [];
  const manifest = [];
  const spine = [];
  let rtl = 0;
  let ltr = 0;
  let w0 = 0;
  let h0 = 0;
  const pageHtml = [];

  for (let i = 1; i <= n; i++) {
    onPage?.(i, n);
    const page = await pdf.getPage(i);
    if (layout === 'pages') {
      const vp0 = page.getViewport({ scale: 1 });
      const scale = Math.min(3, 1400 / Math.max(vp0.width, vp0.height));
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
      const jpg = new Uint8Array(await (await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85))).arrayBuffer());
      if (i === 1) [w0, h0] = [c.width, c.height];
      files.push({ name: `OEBPS/images/p${i}.jpg`, data: jpg });
      manifest.push(`<item id="img${i}" href="images/p${i}.jpg" media-type="image/jpeg"${i === 1 ? ' properties="cover-image"' : ''}/>`);
      pageHtml.push(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${xmlText(fill(t('pageWord'), { n: i }))}</title><meta name="viewport" content="width=${c.width}, height=${c.height}"/><style>html,body{margin:0;padding:0}img{display:block;width:${c.width}px;height:${c.height}px}</style></head><body><img src="images/p${i}.jpg" alt=""/></body></html>`);
      page.cleanup();
      continue;
    }
    // Text: lines from positioned runs, then paragraphs from the gaps between lines.
    const tc = await page.getTextContent();
    const lines = [];
    let line = null;
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const y = it.transform[5];
      const x = it.transform[4];
      const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
      if (it.str) {
        if (!line || Math.abs(line.y - y) > size * 0.6) lines.push((line = { y, size, text: '', end: x }));
        else if (x - line.end > size * 0.2 && !/\s$/.test(line.text) && !/^\s/.test(it.str)) line.text += ' ';
        line.text += it.str;
        line.size = Math.max(line.size, size);
        line.end = x + (it.width || 0);
      }
      if (it.hasEOL) line = null;
    }
    const kept = lines.filter((l) => l.text.trim() && !/^\s*[-–—]?\s*\d{1,4}\s*[-–—]?\s*$/.test(l.text));
    const sizes = kept.map((l) => l.size).sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)] || 10;
    const blocks = [];
    let prev = null;
    for (const l of kept) {
      const text = l.text.replace(/\s+/g, ' ').trim();
      rtl += (text.match(RTL_CHARS) || []).length;
      ltr += (text.match(/[A-Za-zÀ-ɏЀ-ӿ]/g) || []).length;
      const heading = l.size >= median * 1.25 && text.length < 140;
      const gap = prev ? prev.y - l.y : 0;
      const last = blocks[blocks.length - 1];
      if (last && last.heading === heading && gap > 0 && gap < Math.max(prev.size, l.size) * 1.7 && Math.abs(prev.size - l.size) < median * 0.15) {
        last.text = /[\p{L}]-$/u.test(last.text) ? last.text.slice(0, -1) + text : `${last.text} ${text}`;
      } else blocks.push({ text, heading });
      prev = l;
    }
    pageHtml.push(blocks);
    page.cleanup();
  }

  const dir = layout !== 'pages' && rtl > ltr ? 'rtl' : 'ltr';
  const id = `urn:uuid:${crypto.randomUUID()}`;
  const nav = [];
  if (layout === 'pages') {
    pageHtml.forEach((html, i) => {
      files.push({ name: `OEBPS/p${i + 1}.xhtml`, data: html });
      manifest.push(`<item id="p${i + 1}" href="p${i + 1}.xhtml" media-type="application/xhtml+xml"/>`);
      spine.push(`<itemref idref="p${i + 1}"/>`);
    });
    for (const s of starts) nav.push({ href: `p${s.page}.xhtml`, title: s.title });
  } else {
    starts.forEach((s, k) => {
      const end = (starts[k + 1]?.page || n + 1) - 1;
      let out = [];
      for (let p = s.page; p <= end; p++) {
        const blocks = pageHtml[p - 1];
        // A paragraph cut by the page break continues on the next page.
        const first = blocks[0];
        const last = out[out.length - 1];
        if (first && last && !first.heading && !last.heading && !/[.!?:;"”»)\]…。！？]$/.test(last.text) && /^[\p{Ll}\p{Lo}]/u.test(first.text)) {
          last.text = /[\p{L}]-$/u.test(last.text) ? last.text.slice(0, -1) + first.text : `${last.text} ${first.text}`;
          out = out.concat(blocks.slice(1));
        } else out = out.concat(blocks);
      }
      const body = out.map((b) => (b.heading ? `<h2>${xmlText(b.text)}</h2>` : `<p>${xmlText(b.text)}</p>`)).join('\n');
      files.push({
        name: `OEBPS/s${k + 1}.xhtml`,
        data: `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" dir="${dir}"><head><title>${xmlText(s.title)}</title><link rel="stylesheet" href="style.css" type="text/css"/></head><body>
${body || `<p>${xmlText(s.title)}</p>`}
</body></html>`,
      });
      manifest.push(`<item id="s${k + 1}" href="s${k + 1}.xhtml" media-type="application/xhtml+xml"/>`);
      spine.push(`<itemref idref="s${k + 1}"/>`);
      nav.push({ href: `s${k + 1}.xhtml`, title: s.title });
    });
    files.push({ name: 'OEBPS/style.css', data: 'body{margin:0 4%;line-height:1.5}p{margin:0 0 .8em;text-align:justify;hyphens:auto}h2{font-size:1.3em;line-height:1.25;margin:1.4em 0 .6em;text-align:start}' });
    manifest.push('<item id="css" href="style.css" media-type="text/css"/>');
  }
  const navXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" dir="${dir}"><head><title>${xmlText(title)}</title></head><body>
<nav epub:type="toc" id="toc"><h1>${xmlText(title)}</h1><ol>${nav.map((x) => `<li><a href="${x.href}">${xmlText(x.title)}</a></li>`).join('')}</ol></nav>
</body></html>`;
  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${id}"/></head><docTitle><text>${xmlText(title)}</text></docTitle><navMap>${nav.map((x, i) => `<navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>${xmlText(x.title)}</text></navLabel><content src="${x.href}"/></navPoint>`).join('')}</navMap></ncx>`;
  const fixed = layout === 'pages';
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"${fixed ? ' prefix="rendition: http://www.idpf.org/vocab/rendition/#"' : ''}>
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${id}</dc:identifier>
<dc:title>${xmlText(title)}</dc:title>
<dc:language>${xmlText(meta?.info?.Language || 'und')}</dc:language>
${author ? `<dc:creator>${xmlText(author)}</dc:creator>` : ''}
<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
${fixed ? `<meta property="rendition:layout">pre-paginated</meta><meta property="rendition:spread">auto</meta><meta name="original-resolution" content="${w0}x${h0}"/>` : ''}
${fixed ? '<meta name="cover" content="img1"/>' : ''}
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
${manifest.join('\n')}
</manifest>
<spine toc="ncx"${dir === 'rtl' ? ' page-progression-direction="rtl"' : ''}>
${spine.join('\n')}
</spine>
</package>`;
  return [
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: '<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: navXhtml },
    { name: 'OEBPS/toc.ncx', data: ncx },
    ...files,
  ].map((f) => ({ name: f.name, data: typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data }));
}

// Opens an ePub: title, the reading order as XHTML, and the book's CSS with
// pictures and fonts inlined, so each chapter can be drawn without a network.
async function readEpub(bytes) {
  const z = unzip(bytes);
  const parse = (s, type = 'application/xml') => new DOMParser().parseFromString(s, type);
  const container = await z.text('META-INF/container.xml');
  const opfPath = container && parse(container).querySelector('rootfile')?.getAttribute('full-path');
  const opfText = opfPath && (await z.text(opfPath));
  if (!opfText) throw new Error('INVALID: this ePub has no package file');
  const opf = parse(opfText);
  const items = new Map([...opf.getElementsByTagName('item')].map((x) => [x.getAttribute('id'), { href: resolvePath(opfPath, x.getAttribute('href') || ''), type: x.getAttribute('media-type') || '' }]));
  const typeOf = (path) => [...items.values()].find((x) => x.href === path)?.type || ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', otf: 'font/otf', ttf: 'font/ttf', woff: 'font/woff', woff2: 'font/woff2' }[path.split('.').pop().toLowerCase()] || 'application/octet-stream');
  const cache = new Map();
  const inline = async (path) => {
    if (!cache.has(path)) cache.set(path, z.get(path).then((b) => (b ? dataUrl(b, typeOf(path)) : '')));
    return cache.get(path);
  };
  const inlineCss = async (css, from) => {
    const urls = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)];
    for (const [whole, , href] of urls) {
      if (/^(data:|#)/.test(href)) continue;
      const data = await inline(resolvePath(from, href));
      css = css.split(whole).join(data ? `url("${data}")` : 'none');
    }
    return css.replace(/@import[^;]+;/g, '');
  };
  const titleEl = opf.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0];
  const lang = opf.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'language')[0]?.textContent?.trim();
  const ppd = opf.getElementsByTagName('spine')[0]?.getAttribute('page-progression-direction');
  const chapters = [];
  for (const ref of opf.getElementsByTagName('itemref')) {
    if (ref.getAttribute('linear') === 'no') continue;
    const item = items.get(ref.getAttribute('idref'));
    if (!item || !/html|xml/.test(item.type)) continue;
    const src = await z.text(item.href);
    if (!src) continue;
    let d = parse(src, 'application/xhtml+xml');
    if (d.getElementsByTagName('parsererror').length) d = parse(src, 'text/html');
    let css = '';
    for (const link of [...d.querySelectorAll('link[rel~="stylesheet"][href]')]) css += await inlineCss((await z.text(resolvePath(item.href, link.getAttribute('href')))) || '', resolvePath(item.href, link.getAttribute('href')));
    for (const st of [...d.querySelectorAll('style')]) css += await inlineCss(st.textContent, item.href);
    const body = d.body || d.getElementsByTagName('body')[0];
    if (!body) continue;
    for (const bad of [...body.querySelectorAll('script, iframe, object, embed, video, audio, form, link, style, meta')]) bad.remove();
    for (const img of [...body.querySelectorAll('img[src]')]) img.setAttribute('src', await inline(resolvePath(item.href, img.getAttribute('src'))));
    for (const im of [...body.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'image')]) {
      const href = im.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || im.getAttribute('href');
      if (href) im.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', await inline(resolvePath(item.href, href)));
    }
    for (const el of [...body.querySelectorAll('[style]')]) el.setAttribute('style', await inlineCss(el.getAttribute('style'), item.href));
    for (const a of [...body.querySelectorAll('a[href]')]) a.removeAttribute('href');
    const wrap = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    wrap.setAttribute('class', `${body.getAttribute('class') || ''} epub-body`);
    const bdir = body.getAttribute('dir') || d.documentElement.getAttribute('dir');
    if (bdir) wrap.setAttribute('dir', bdir);
    for (const child of [...body.childNodes]) wrap.append(document.importNode(child, true));
    chapters.push({ css, html: new XMLSerializer().serializeToString(wrap) });
  }
  if (!chapters.length) throw new Error('INVALID: this ePub has no readable chapters');
  return { title: titleEl?.textContent?.trim() || '', lang, rtl: ppd === 'rtl', chapters };
}

// Lays each chapter out in columns, one column per page, and draws the pages
// through an SVG image so the book's own fonts and styles are kept.
async function epubToPdf(bytes, { paper, fontSize, onPage }) {
  const book = await readEpub(bytes);
  const [W, H] = paper === 'a4' ? [595, 842] : paper === 'letter' ? [612, 792] : [420, 595];
  const M = Math.round(W * 0.09);
  const cw = W - 2 * M;
  const ch = H - 2 * M;
  const scale = 2.5;
  const base = `html,body{margin:0;padding:0;background:#fff}
.flow{position:absolute;left:${M}px;top:${M}px;width:${cw}px;height:${ch}px;column-width:${cw}px;column-gap:${2 * M}px;column-fill:auto;font-family:Georgia,'Iowan Old Style','Times New Roman',serif;font-size:${fontSize}px;line-height:1.5;color:#111;overflow-wrap:break-word}
.flow img,.flow svg{max-width:100%;max-height:${ch}px;height:auto;object-fit:contain;break-inside:avoid}
.flow h1,.flow h2,.flow h3{break-after:avoid;line-height:1.25}
.flow p{orphans:2;widows:2}`;
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = `position:fixed;left:-20000px;top:0;width:${W}px;height:${H}px;border:0;visibility:hidden`;
  document.body.append(frame);
  const images = [];
  try {
    const fdoc = frame.contentDocument;
    let done = 0;
    for (const chap of book.chapters) {
      const css = `${chap.css}\n${base}`;
      fdoc.open();
      fdoc.write(`<!doctype html><html${book.lang ? ` lang="${esc(book.lang)}"` : ''}${book.rtl ? ' dir="rtl"' : ''}><head><style>${css.replace(/<\/style/gi, '')}</style></head><body><div class="flow">${chap.html}</div></body></html>`);
      fdoc.close();
      await new Promise((r) => setTimeout(r, 30));
      await fdoc.fonts?.ready;
      await Promise.all([...fdoc.images].map((im) => (im.complete ? null : new Promise((r) => ((im.onload = r), (im.onerror = r))))));
      const flow = fdoc.querySelector('.flow');
      const pages = Math.max(1, Math.round((flow.scrollWidth + 2 * M) / W));
      for (let i = 0; i < pages; i++) {
        onPage?.(++done);
        const shift = book.rtl ? i * W : -i * W;
        const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * scale}" height="${H * scale}" viewBox="0 0 ${W} ${H}"><foreignObject width="${W}" height="${H}"><html xmlns="http://www.w3.org/1999/xhtml"${book.lang ? ` lang="${esc(book.lang)}"` : ''}${book.rtl ? ' dir="rtl"' : ''}><head><style>${esc(css)}</style></head><body style="width:${W}px;height:${H}px;overflow:hidden;position:relative"><div class="flow" style="transform:translateX(${shift}px)">${chap.html}</div></body></html></foreignObject></svg>`;
        {
          const img = new Image();
          img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = W * scale;
          c.height = H * scale;
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          images.push({ jpeg: true, data: new Uint8Array(await (await new Promise((res, rej) => { try { c.toBlob(res, 'image/jpeg', 0.88); } catch (e) { rej(e); } })).arrayBuffer()) });
        }
      }
    }
  } finally {
    frame.remove();
  }
  const out = await engine('images', { images, paper: paper === 'letter' ? 'letter' : paper === 'a4' ? 'a4' : 'a5', margin: 0 }, images.map((x) => x.data.buffer));
  return { bytes: out, title: book.title };
}


// Several documents, every tool. Each action runs the tool's own screen inside the app
// window; a PDF result replaces the active document (with undo), other results download.
const studioEl = $('#studio');
if (studioEl) startStudio(studioEl);

function startStudio(el) {
  const tools = JSON.parse(el.dataset.tools);
  const groups = JSON.parse(el.dataset.groups);
  const home = el.dataset.home || '/';
  const S = { docs: [], active: null, pending: null, sel: new Set(), zoom: 190, running: false };
  const doc = () => S.docs.find((d) => d.id === S.active);
  const isPdf = (f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name);
  const svg = (d, w = 18) => `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const IC = {
    mark: svg('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.1 8.1 20 20M8.1 15.9 20 4"/>'),
    sidebar: svg('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M9 4.5v15M5.5 8h1.5M5.5 11h1.5"/>'),
    undo: svg('<path d="M9 14 4.5 9.5 9 5"/><path d="M4.5 9.5H15a5 5 0 0 1 0 10h-3"/>'),
    redo: svg('<path d="m15 14 4.5-4.5L15 5"/><path d="M19.5 9.5H9a5 5 0 0 0 0 10h3"/>'),
    open: svg('<path d="M3.5 7.5V18a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2V9.5a2 2 0 0 0-2-2h-7l-2-2.5h-4a2 2 0 0 0-2 2z"/>'),
    share: svg('<path d="M12 3.5v11M8 7.5l4-4 4 4"/><path d="M7.5 10.5H6a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6.5a2 2 0 0 0-2-2h-1.5"/>'),
    stack: svg('<path d="m12 4 8.5 4.5L12 13 3.5 8.5z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.5 12 21l8.5-4.5"/>'),
    tools: svg('<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>'),
    search: svg('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>', 15),
    chevron: svg('<path d="m9.5 6 6 6-6 6"/>', 13),
    rotL: svg('<path d="M4 11a8 8 0 1 1 2.3 5.7"/><path d="M4 4v7h7"/>', 16),
    rotR: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>', 16),
    small: svg('<rect x="7" y="7" width="10" height="12" rx="1.5"/>', 13),
    large: svg('<rect x="4" y="3" width="16" height="18" rx="2"/>', 16),
  };
  el.innerHTML = `<div class="studio-window sidebar-open">
    <header class="studio-bar">
      <div class="bar-left">
        <a class="studio-brand" href="${home}" aria-label="${esc(ts('studioHome', 'Scissor PDF home'))}">${IC.mark}</a>
        <button class="tb-btn studio-sidebar-toggle" type="button" aria-label="${esc(ts('studioSidebar', 'Show or hide the sidebar'))}" hidden>${IC.sidebar}</button>
      </div>
      <div class="bar-title"><b>Scissor PDF</b><span></span></div>
      <div class="bar-right">
        <label class="zoom-ctl" title="${esc(t('zoom'))}" hidden>${IC.small}<input type="range" min="120" max="420" step="10" value="190" aria-label="${esc(t('zoom'))}">${IC.large}</label>
        <div class="tb-group"><button class="tb-btn studio-undo" type="button" aria-label="${esc(ts('studioUndo', 'Undo'))}" disabled>${IC.undo}</button><button class="tb-btn studio-redo" type="button" aria-label="${esc(ts('studioRedo', 'Redo'))}" disabled>${IC.redo}</button></div>
        <div class="studio-menu"><button class="tb-btn studio-open" type="button" aria-haspopup="true" title="${esc(ts('studioOpenShort', 'Open'))} (⌘O)">${IC.open}<span>${esc(ts('studioOpenShort', 'Open'))}</span></button>
          <div class="studio-menu-list" hidden><button type="button" data-open="files">${esc(ts('studioOpenFiles', 'Open files'))}…</button><button type="button" data-open="folder">${esc(ts('studioOpenFolder', 'Open folder'))}…</button></div></div>
        <button class="tb-btn studio-download-all" type="button" aria-label="${esc(ts('studioDownloadAll', 'Download all'))}" title="${esc(ts('studioDownloadAll', 'Download all'))}" hidden>${IC.stack}</button>
        <a class="tb-btn primary studio-download" hidden>${IC.share}<span>${esc(t('download'))}</span></a>
      </div>
    </header>
    <div class="studio-main"><nav class="studio-files" aria-label="${esc(ts('studioFiles', 'Files'))}" hidden></nav><div class="studio-body"></div></div>
    <nav class="studio-tabbar" aria-label="${esc(ts('studioTools', 'Tools'))}">
      <button type="button" class="tab-open">${IC.open}<span>${esc(ts('studioOpenShort', 'Open'))}</span></button>
      <button type="button" class="tab-tools">${IC.tools}<span>${esc(ts('studioTools', 'Tools'))}</span></button>
      <button type="button" class="tab-share" disabled>${IC.share}<span>${esc(t('download'))}</span></button>
    </nav>
    <div class="studio-sheet-backdrop" hidden></div>
    <div class="studio-sheet" role="dialog" aria-label="${esc(ts('studioTools', 'Tools'))}" hidden><div class="sheet-grabber"></div><div class="sheet-content"></div></div>
    <div class="studio-toast" role="status" aria-live="polite" hidden></div>
  </div>`;
  const win = $('.studio-window', el);
  const body = $('.studio-body', el);
  const filesNav = $('.studio-files', el);
  const fileInput = h('<input type="file" accept="application/pdf,.pdf,application/epub+zip,.epub" multiple hidden>');
  const folderInput = h('<input type="file" webkitdirectory multiple hidden>');
  document.body.append(fileInput, folderInput);
  fileInput.onchange = () => (openFiles([...fileInput.files]), (fileInput.value = ''));
  folderInput.onchange = () => (openFiles([...folderInput.files].sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true }))), (folderInput.value = ''));

  // Open menu: files or a whole folder.
  const menu = $('.studio-menu-list', el);
  $('.studio-open', el).onclick = (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  };
  addEventListener('click', () => (menu.hidden = true));
  menu.onclick = (e) => {
    const kind = e.target.dataset?.open;
    if (kind === 'files') fileInput.click();
    if (kind === 'folder') folderInput.click();
  };
  $('.studio-undo', el).onclick = () => travel(-1);
  $('.studio-redo', el).onclick = () => travel(1);
  $('.studio-download-all', el).onclick = downloadAll;
  $('.zoom-ctl input', el).oninput = (e) => {
    S.zoom = +e.target.value;
    $('.studio-pages', body)?.style.setProperty('--page-w', `${S.zoom}px`);
  };
  $('.studio-sidebar-toggle', el).onclick = () => win.classList.toggle('sidebar-open');
  // Phone: bottom tab bar, with Tools as a sheet.
  const sheet = $('.studio-sheet', el);
  const backdrop = $('.studio-sheet-backdrop', el);
  const closeSheet = () => ((sheet.hidden = true), (backdrop.hidden = true));
  backdrop.onclick = closeSheet;
  $('.tab-open', el).onclick = () => fileInput.click();
  $('.tab-share', el).onclick = () => $('.studio-download', el).click();
  $('.tab-tools', el).onclick = () => {
    $('.sheet-content', sheet).innerHTML = toolsList();
    bindTools(sheet, closeSheet);
    sheet.hidden = false;
    backdrop.hidden = false;
  };

  // Drop files or folders anywhere.
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', async (e) => {
    e.preventDefault();
    if ($('.studio-app', body)) return;
    const files = await droppedFiles(e.dataTransfer);
    if (files.length) openFiles(files);
  });

  // Installed app: PDFs opened from the operating system arrive here (Chrome, Edge).
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      const files = await Promise.all((params.files || []).map((handle) => handle.getFile()));
      if (files.length) openFiles(files);
    });
  }

  async function droppedFiles(dt) {
    const out = [];
    const walk = async (entry) => {
      if (!entry) return;
      if (entry.isFile) out.push(await new Promise((res) => entry.file(res, () => res(null))));
      else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res) => reader.readEntries(res, () => res([])));
          for (const child of batch) await walk(child);
        } while (batch.length);
      }
    };
    const entries = [...(dt?.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    if (entries.length) for (const entry of entries) await walk(entry);
    else out.push(...(dt?.files || []));
    return out.filter(Boolean);
  }

  // Tools: four tabs with an icon grid, plus a ⌘K palette that searches everything.
  const toolOf = (slug) => tools.find((x) => x.slug === slug);
  const tabs = groups.map(([key, label, slugs]) => ({ key, label, list: slugs.map(toolOf).filter(Boolean) })).filter((x) => x.list.length);
  let tabKey = (() => {
    try {
      return localStorage.getItem('scissor-tab') || tabs[0].key;
    } catch {
      return tabs[0].key;
    }
  })();
  if (!tabs.some((x) => x.key === tabKey)) tabKey = tabs[0].key;

  function toolsList() {
    const tab = tabs.find((x) => x.key === tabKey);
    return `<div class="tools-head">
        <div class="seg" role="tablist">${tabs.map((x) => `<button type="button" role="tab" data-tab="${x.key}" aria-selected="${x.key === tabKey}">${esc(x.label)}</button>`).join('')}</div>
        <button type="button" class="tools-find" aria-label="${esc(ts('studioSearch', 'Search tools'))}" title="${esc(ts('studioSearch', 'Search tools'))} (⌘K)">${IC.search}<span>${esc(ts('studioSearch', 'Search tools'))}</span><kbd>${/Mac|iP/.test(navigator.platform) ? '⌘' : 'Ctrl+'}K</kbd></button>
      </div>
      <div class="tool-grid" role="tabpanel">${tab.list.map((x) => `<button type="button" class="tool-tile" data-slug="${x.slug}" title="${esc(x.name)}">${x.iconSvg}<span>${esc(x.name)}</span></button>`).join('')}</div>`;
  }

  function pick(slug) {
    if (doc()) runTool(slug);
    else {
      S.pending = slug;
      fileInput.click();
    }
  }

  function bindTools(scope, after) {
    for (const b of scope.querySelectorAll('.tool-tile')) b.onclick = () => (after?.(), pick(b.dataset.slug));
    for (const b of scope.querySelectorAll('[data-tab]'))
      b.onclick = () => {
        tabKey = b.dataset.tab;
        try {
          localStorage.setItem('scissor-tab', tabKey);
        } catch {}
        const host = b.closest('.inspector, .sheet-content');
        host.innerHTML = toolsList();
        bindTools(host, after);
        $(`[data-tab="${tabKey}"]`, host)?.focus();
      };
    const find = $('.tools-find', scope);
    if (find) find.onclick = () => (after?.(), palette());
  }

  // Spotlight-style search over every tool.
  function palette() {
    if ($('.palette')) return;
    const box = h(`<div class="palette-backdrop"><div class="palette" role="dialog" aria-modal="true" aria-label="${esc(ts('studioSearch', 'Search tools'))}">
      <div class="palette-input">${IC.search}<input type="search" placeholder="${esc(ts('studioSearch', 'Search tools'))}" autocomplete="off" spellcheck="false"></div>
      <div class="palette-list" role="listbox"></div></div></div>`);
    document.body.append(box);
    const input = $('input', box);
    const list = $('.palette-list', box);
    const all = tabs.flatMap((tab) => tab.list.map((x) => ({ ...x, tab: tab.label, hay: `${x.name} ${x.slug.replace(/-/g, ' ')} ${tab.label}`.toLowerCase() })));
    let hits = [];
    let at = 0;
    const close = () => box.remove();
    const paint = () => {
      const q = input.value.trim().toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      hits = words.length ? all.filter((x) => words.every((w) => x.hay.includes(w))).sort((x, y) => x.name.toLowerCase().indexOf(words[0]) - y.name.toLowerCase().indexOf(words[0])) : all;
      at = Math.min(at, Math.max(0, hits.length - 1));
      list.innerHTML = hits.length
        ? hits.map((x, i) => `<button type="button" role="option" class="palette-row" data-i="${i}" aria-selected="${i === at}">${x.iconSvg}<span>${esc(x.name)}</span><small>${esc(x.tab)}</small></button>`).join('')
        : `<p class="palette-empty">${esc(ts('studioNoTools', 'No matching tools'))}</p>`;
      for (const r of list.querySelectorAll('.palette-row')) {
        r.onclick = () => (close(), pick(hits[+r.dataset.i].slug));
        r.onmousemove = () => {
          if (at === +r.dataset.i) return;
          at = +r.dataset.i;
          mark();
        };
      }
    };
    const mark = () => {
      for (const r of list.querySelectorAll('.palette-row')) r.setAttribute('aria-selected', +r.dataset.i === at);
      list.querySelector(`[data-i="${at}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    input.oninput = () => ((at = 0), paint());
    input.onkeydown = (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        at = (at + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % Math.max(1, hits.length);
        mark();
      } else if (e.key === 'Enter' && hits[at]) {
        close();
        pick(hits[at].slug);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    box.onclick = (e) => e.target === box && close();
    paint();
    input.focus();
  }

  function renderFiles() {
    const any = S.docs.length > 0;
    filesNav.hidden = !any;
    $('.studio-sidebar-toggle', el).hidden = !any;
    filesNav.innerHTML = `<h3>${esc(ts('studioFiles', 'Files'))}</h3>`;
    for (const d of S.docs) {
      const item = h(`<div class="studio-file-item${d.id === S.active ? ' active' : ''}"><button type="button" class="studio-file-pick"><span class="thumb"></span><span class="studio-file-text"><b>${esc(d.name)}</b><small>${tp('pages', d.pdf.numPages)}</small></span></button><button type="button" class="icon-btn" aria-label="${esc(ts('studioClose', 'Close {name}', { name: d.name }))}">${ICON.close}</button></div>`);
      $('.studio-file-pick', item).onclick = () => {
        if (S.active !== d.id) S.sel.clear();
        S.active = d.id;
        showHome();
      };
      $('.icon-btn', item).onclick = () => {
        S.docs = S.docs.filter((x) => x !== d);
        if (S.active === d.id) S.active = S.docs[0]?.id ?? null;
        showHome();
      };
      renderThumb(d.pdf, 1, $('.thumb', item), 64);
      filesNav.append(item);
    }
  }

  function showHome() {
    S.running = false;
    updateBar();
    renderFiles();
    const d = doc();
    const canvas = d
      ? `<div class="studio-canvas"><div class="studio-pages"></div></div>`
      : `<div class="studio-canvas"><div class="studio-welcome">
          <img src="/icon-192.png" width="88" height="88" alt="">
          <h2>Scissor PDF</h2>
          <p>${S.pending ? `<b>${esc(tools.find((x) => x.slug === S.pending).name)}</b> · ` : ''}${esc(ts('studioWelcome', 'Open PDFs to get started.'))}</p>
          <div class="studio-open-buttons"><button class="btn primary" type="button" data-open="files">${esc(ts('studioOpenFiles', 'Open files'))}…</button><button class="btn" type="button" data-open="folder">${esc(ts('studioOpenFolder', 'Open folder'))}…</button></div>
          <p class="hint">${esc(ts('studioDrop', 'or drop PDFs or a folder anywhere. Nothing is uploaded.'))}</p>
          ${el.dataset.repo ? `<a class="welcome-source" href="${el.dataset.repo}" rel="noopener">${esc(ts('studioSource', 'Open source on GitHub'))}</a>` : ''}
        </div></div>`;
    body.innerHTML = `${canvas}<aside class="inspector" aria-label="${esc(ts('studioTools', 'Tools'))}">${toolsList()}</aside>`;
    bindTools($('.inspector', body));
    if (!d) {
      $('[data-open="files"]', body).onclick = () => fileInput.click();
      $('[data-open="folder"]', body).onclick = () => folderInput.click();
      return;
    }
    renderPages(d);
  }

  /* Pages on the canvas: select, drag to reorder, act on the selection. */

  function renderPages(d) {
    const canvas = $('.studio-canvas', body);
    canvas.innerHTML = `<div class="studio-pages" role="listbox" aria-multiselectable="true" aria-label="${esc(tp('pages', d.pdf.numPages))}"></div>
      <div class="canvas-foot">
        <div class="selection-bar" hidden>
          <span class="sel-count"></span>
          <button class="tb-btn" type="button" data-act="left" title="${esc(ts('studioRotateLeft', 'Rotate Left'))} (⌘[)">${IC.rotL}</button>
          <button class="tb-btn" type="button" data-act="right" title="${esc(ts('studioRotateRight', 'Rotate Right'))} (⌘])">${IC.rotR}</button>
          <button class="tb-btn" type="button" data-act="extract">${esc(ts('studioExtract', 'Extract'))}</button>
          <button class="tb-btn danger" type="button" data-act="delete" title="⌫">${esc(t('stateDelete'))}</button>
        </div>
      </div>`;
    const grid = $('.studio-pages', canvas);
    grid.style.setProperty('--page-w', `${S.zoom}px`);
    for (const b of canvas.querySelectorAll('.selection-bar [data-act]')) b.onclick = () => act(b.dataset.act);
    for (let n = 1; n <= d.pdf.numPages; n++) {
      const card = h(`<figure class="card sortable studio-page" data-key="${n}" role="option" tabindex="${n === 1 ? 0 : -1}" aria-selected="false"><div class="thumb"><div class="skeleton"></div></div><figcaption>${n}</figcaption></figure>`);
      const thumb = $('.thumb', card);
      thumb._render = () => renderThumb(d.pdf, n, thumb, 420);
      lazy.observe(thumb);
      card.addEventListener('click', (e) => {
        if (Date.now() - (grid._dragEnded || 0) < 250) return;
        select(n, e);
      });
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!S.sel.has(n)) select(n, {});
        contextMenu(e.clientX, e.clientY);
      });
      grid.append(card);
    }
    sortable(grid, (keys) => {
      const order = keys.map(Number);
      if (order.every((n, i) => n === i + 1)) return;
      organizeDoc(order, [], ts('studioReorder', 'Reorder'));
    });
    paintSelection();
  }

  let anchor = null;
  function select(n, e) {
    if (e.shiftKey && anchor) {
      const [a, b] = [Math.min(anchor, n), Math.max(anchor, n)];
      if (!(e.metaKey || e.ctrlKey)) S.sel.clear();
      for (let i = a; i <= b; i++) S.sel.add(i);
    } else if (e.metaKey || e.ctrlKey) {
      S.sel.has(n) ? S.sel.delete(n) : S.sel.add(n);
      anchor = n;
    } else {
      S.sel = new Set([n]);
      anchor = n;
    }
    paintSelection();
  }

  function paintSelection() {
    const grid = $('.studio-pages', body);
    if (!grid) return;
    for (const card of grid.children) {
      const on = S.sel.has(+card.dataset.key);
      card.classList.toggle('selected', on);
      card.setAttribute('aria-selected', on);
    }
    const bar = $('.selection-bar', body);
    bar.hidden = !S.sel.size || S.running;
    $('.sel-count', bar).textContent = ts('studioSelected', '{pages} selected', { pages: tp('pages', S.sel.size) });
  }

  async function organizeDoc(pages, rotations, label) {
    const d = doc();
    try {
      const out = await engine('organize', { pdf: d.bytes.slice(), pages, rotations });
      S.sel.clear();
      await commit(out, label);
    } catch (e) {
      toast(e.message);
    }
  }

  async function act(kind) {
    const d = doc();
    if (!d || !S.sel.size) return;
    const all = Array.from({ length: d.pdf.numPages }, (_, i) => i + 1);
    const chosen = all.filter((n) => S.sel.has(n));
    if (kind === 'left' || kind === 'right') {
      const keep = new Set(chosen);
      return organizeDoc(all, all.map((n) => (keep.has(n) ? (kind === 'left' ? 270 : 90) : 0)), ts(kind === 'left' ? 'studioRotateLeft' : 'studioRotateRight', kind === 'left' ? 'Rotate Left' : 'Rotate Right'));
    }
    if (kind === 'delete') {
      if (chosen.length === all.length) return toast(t('errInvalid'));
      return organizeDoc(all.filter((n) => !S.sel.has(n)), [], t('stateDelete'));
    }
    if (kind === 'extract') {
      const out = await engine('organize', { pdf: d.bytes.slice(), pages: chosen, rotations: [] });
      const nd = await makeDoc(out, `${baseName(d.name)}-pages.pdf`);
      if (!nd) return;
      nd.dirty = true;
      S.docs.push(nd);
      S.active = nd.id;
      S.sel.clear();
      showHome();
      toast(ts('studioApplied', '{tool} done', { tool: ts('studioExtract', 'Extract') }));
    }
  }

  const menuEl = h('<div class="studio-context" role="menu" hidden></div>');
  el.append(menuEl);
  function contextMenu(x, y) {
    const items = [
      ['left', ts('studioRotateLeft', 'Rotate Left'), '⌘['],
      ['right', ts('studioRotateRight', 'Rotate Right'), '⌘]'],
      ['extract', ts('studioExtract', 'Extract'), ''],
      ['delete', t('stateDelete'), '⌫'],
      ['all', t('selectAll'), '⌘A'],
    ];
    menuEl.innerHTML = items.map(([k, label, key]) => `<button type="button" role="menuitem" data-k="${k}"><span>${esc(label)}</span><kbd>${key}</kbd></button>`).join('');
    menuEl.hidden = false;
    const r = menuEl.getBoundingClientRect();
    Object.assign(menuEl.style, { left: `${Math.min(x, innerWidth - r.width - 8)}px`, top: `${Math.min(y, innerHeight - r.height - 8)}px` });
    menuEl.onclick = (e) => {
      const k = e.target.closest('[data-k]')?.dataset.k;
      menuEl.hidden = true;
      if (k === 'all') selectAll();
      else if (k) act(k);
    };
  }
  addEventListener('click', () => (menuEl.hidden = true));
  addEventListener('scroll', () => (menuEl.hidden = true), true);

  function selectAll() {
    const d = doc();
    if (!d) return;
    S.sel = new Set(Array.from({ length: d.pdf.numPages }, (_, i) => i + 1));
    paintSelection();
  }

  // Keyboard shortcuts, as in Preview.
  addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const typing = e.target.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]');
    const k = e.key.toLowerCase();
    if (k === 'escape') {
      if ($('.palette')) return $('.palette-backdrop').remove();
      if (!menuEl.hidden) return (menuEl.hidden = true);
      if (S.running) return $('.studio-back', el)?.click();
      if (S.sel.size) return (S.sel.clear(), paintSelection());
    }
    if (mod && k === 'o') return (e.preventDefault(), fileInput.click());
    if (mod && (k === 'f' || k === 'k') && !S.running) return (e.preventDefault(), palette());
    if (typing) return;
    if (mod && k === 'z') return (e.preventDefault(), travel(e.shiftKey ? 1 : -1));
    if (mod && k === 'y') return (e.preventDefault(), travel(1));
    if (mod && k === 's') return (e.preventDefault(), doc() && $('.studio-download', el).click());
    if (S.running) return;
    if (mod && k === 'a') return (e.preventDefault(), selectAll());
    if (mod && e.key === '[') return (e.preventDefault(), act('left'));
    if (mod && e.key === ']') return (e.preventDefault(), act('right'));
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel.size) return (e.preventDefault(), act('delete'));
  });

  // Ask before closing the tab with changes that were not downloaded.
  addEventListener('beforeunload', (e) => {
    if (S.docs.some((d) => d.dirty)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  function updateBar() {
    const d = doc();
    const dl = $('.studio-download', el);
    $('.bar-title b', el).textContent = d ? d.name : 'Scissor PDF';
    $('.bar-title span', el).textContent = d ? `${tp('pages', d.pdf.numPages)} · ${fmtBytes(d.bytes.length)}` : '';
    if (dl._url) URL.revokeObjectURL(dl._url);
    if (d) {
      dl._url = URL.createObjectURL(new Blob([d.bytes], { type: 'application/pdf' }));
      dl.href = dl._url;
      dl.download = d.name;
    }
    dl.hidden = !d;
    dl.onclick = () => d && (d.dirty = false);
    $('.tab-share', el).disabled = !d;
    $('.studio-download-all', el).hidden = S.docs.length < 2;
    $('.zoom-ctl', el).hidden = !d || S.running;
    $('.studio-undo', el).disabled = !d || d.index <= 0;
    $('.studio-redo', el).disabled = !d || d.index >= d.history.length - 1;
  }

  // Two open files never share a name: "report.pdf", "report (2).pdf", …
  function uniqueName(name) {
    const taken = new Set(S.docs.map((d) => d.name));
    if (!taken.has(name)) return name;
    const [stem, ext] = /^(.*?)(\.pdf)?$/i.exec(name).slice(1);
    for (let i = 2; ; i++) if (!taken.has(`${stem} (${i})${ext || ''}`)) return `${stem} (${i})${ext || ''}`;
  }

  async function makeDoc(bytes, name) {
    name = uniqueName(name);
    try {
      const pdf = await openPdf(bytes);
      return { id: crypto.randomUUID(), name, bytes, pdf, history: [bytes], index: 0 };
    } catch (e) {
      toast(e?.name === 'PasswordException' ? `${name}: ${t('errEncrypted')}` : t('errDamaged', { name }));
      return null;
    }
  }

  async function openFiles(list) {
    const isEpub = (f) => /\.epub$/i.test(f.name) || f.type === 'application/epub+zip';
    const pdfs = list.filter((f) => isPdf(f) || isEpub(f));
    if (!pdfs.length) return toast(ts('studioNoPdfs', 'No PDF files found there.'));
    let first = null;
    for (const file of pdfs) {
      let bytes = new Uint8Array(await file.arrayBuffer());
      let name = file.name;
      // E-books open as PDFs (A5, like a paperback).
      if (isEpub(file)) {
        toast(`${ts('busyRender', 'Rendering…')} ${file.name}`);
        try {
          bytes = (await epubToPdf(bytes, { paper: 'a5', fontSize: 12 })).bytes;
          name = name.replace(/\.epub$/i, '.pdf');
        } catch (e) {
          toast(String(e.message || e).replace(/^[A-Z]+:\s*/, ''));
          continue;
        }
      }
      const d = await makeDoc(bytes, name);
      if (!d) continue;
      S.docs.push(d);
      first ??= d;
    }
    if (!first) return;
    S.active = first.id;
    showHome();
    if (S.pending) {
      const slug = S.pending;
      S.pending = null;
      runTool(slug);
    }
  }

  async function setBytes(d, bytes) {
    d.bytes = bytes;
    d.pdf = await openPdf(bytes);
  }

  async function commit(bytes, label) {
    const d = doc();
    d.history = d.history.slice(0, d.index + 1);
    d.history.push(bytes);
    if (d.history.length > 25) d.history.shift();
    d.index = d.history.length - 1;
    d.dirty = true;
    await setBytes(d, bytes);
    showHome();
    toast(ts('studioApplied', '{tool} done', { tool: label }));
  }

  async function travel(step) {
    const d = doc();
    if (!d || d.index + step < 0 || d.index + step >= d.history.length) return;
    d.index += step;
    await setBytes(d, d.history[d.index]);
    showHome();
  }

  function runTool(slug) {
    const tool = tools.find((x) => x.slug === slug);
    const d = doc();
    S.running = true;
    let host;
    let panelHost;
    if (PANEL_ONLY.has(tool.mode) && matchMedia('(min-width: 761px)').matches && $('.studio-canvas', body)) {
      // Options-only tools: pages stay on the canvas, the inspector shows the options.
      host = $('.studio-canvas', body);
      panelHost = $('.inspector', body);
      panelHost.classList.add('running');
    } else {
      host = h('<div class="app studio-app"></div>');
      body.replaceChildren(host);
    }
    $('.studio-download', el).hidden = true;
    $('.zoom-ctl', el).hidden = true;
    // Multi-document tools start with every open file (merge) or the first two (compare, mix).
    let docs = [d];
    if (tool.multiple) docs = [d, ...S.docs.filter((x) => x !== d)].slice(0, tool.slug === 'merge-pdf' ? undefined : 2);
    start(tool, {
      root: host,
      panelHost,
      files: docs.map((x) => new File([x.bytes], x.name, { type: 'application/pdf' })),
      onCancel: showHome,
      onResult: async ({ bytes, name, type }) => {
        if (type === 'application/pdf' && tool.multiple) {
          // A merged document opens as a new file next to the originals.
          const merged = await makeDoc(bytes, name);
          if (merged) {
            merged.dirty = true;
            S.docs.push(merged);
            S.active = merged.id;
          }
          showHome();
          return toast(ts('studioApplied', '{tool} done', { tool: tool.name }));
        }
        // Encrypted output cannot be edited further, so it downloads like other files.
        if (type === 'application/pdf' && !tool.final) return commit(bytes, tool.name);
        const url = URL.createObjectURL(new Blob([bytes], { type }));
        showHome();
        toast(ts('studioReady', '{name} is ready', { name }), url, name);
      },
    });
  }

  async function downloadAll() {
    const files = S.docs.map((d) => ({ name: d.name, data: d.bytes.slice() }));
    const zip = await engine('zip', { files }, files.map((f) => f.data.buffer));
    const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
    toast(ts('studioReady', '{name} is ready', { name: 'scissor-pdf.zip' }), url, 'scissor-pdf.zip');
  }

  let toastTimer;
  function toast(text, url, filename) {
    const box = $('.studio-toast', el);
    box.innerHTML = `<span>${esc(text)}</span>${url ? `<a class="btn primary small" href="${url}" download="${esc(filename)}">${esc(t('download'))}</a>` : ''}`;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (box.hidden = true), url ? 12000 : 3200);
  }

  // Shortcuts from the installed app (and links) can ask for a tool: /app/?tool=merge-pdf
  const wanted = new URLSearchParams(location.search).get('tool');
  if (wanted && tools.some((x) => x.slug === wanted)) S.pending = wanted;
  showHome();
}


/* ---------- Stamps and ink ---------- */

const STAMPS = [
  ['stampApproved', 'APPROVED', '#1f8a3b'],
  ['stampRejected', 'REJECTED', '#c8102e'],
  ['stampPaid', 'PAID', '#0a58ca'],
  ['stampReceived', 'RECEIVED', '#0a58ca'],
  ['stampDraft', 'DRAFT', '#6e6e73'],
  ['stampConfidential', 'CONFIDENTIAL', '#c8102e'],
  ['stampFinal', 'FINAL', '#1f8a3b'],
  ['stampCopy', 'COPY', '#6e6e73'],
];

// A rubber-stamp style label with today's date, drawn at high resolution.
function stampCanvas(word, color) {
  const date = new Intl.DateTimeFormat(I18N.code, { dateStyle: 'medium' }).format(new Date());
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const big = '800 96px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
  const small = '600 34px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
  ctx.font = big;
  const w = Math.max(ctx.measureText(word).width, 260) + 96;
  c.width = Math.ceil(w);
  c.height = 210;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.roundRect(8, 8, c.width - 16, c.height - 16, 26);
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = big;
  ctx.fillText(word, c.width / 2, 92);
  ctx.font = small;
  ctx.fillText(date, c.width / 2, 160);
  return c;
}

function drawStrokes(ctx, strokes, w, h) {
  ctx.clearRect(0, 0, w, h);
  ctx.lineCap = ctx.lineJoin = 'round';
  for (const s of strokes) {
    ctx.strokeStyle = s.color;
    ctx.globalAlpha = s.color === '#ffd60a' ? 0.5 : 1;
    ctx.lineWidth = s.width * w;
    ctx.beginPath();
    s.points.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
    if (s.points.length === 1) ctx.lineTo(s.points[0][0] * w + 0.1, s.points[0][1] * h);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
