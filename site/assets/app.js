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

const root = $('#app');
if (root) start(JSON.parse(root.dataset.tool));

function start(tool) {
  const isImages = tool.accept === 'images';
  const state = { files: [], options: {}, pages: [], result: null };
  const input = $('input[type=file]', root);
  const dropZone = $('.drop', root);
  const veil = h(`<div class="drop-veil" aria-hidden="true">${esc(t('dropToAdd'))}</div>`);
  document.body.append(veil);

  const accepts = (f) => (isImages ? f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp|gif|avif|bmp)$/i.test(f.name) : f.type === 'application/pdf' || /\.pdf$/i.test(f.name));

  input.addEventListener('change', () => {
    addFiles([...input.files]);
    input.value = '';
  });
  let depth = 0;
  addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    depth++;
    document.body.classList.add('dragging');
  });
  addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      document.body.classList.remove('dragging');
    }
  });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    if (state.result) return;
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) addFiles(files);
  });

  if (location.hash === '#handoff') {
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
    if (!ok.length) return showError(isImages ? t('errChooseImages') : t('errChoosePdf'));
    if (!tool.multiple) {
      state.files = [];
      ok.splice(1);
    }
    for (const file of ok) {
      const entry = { key: crypto.randomUUID(), file, name: file.name, size: file.size };
      entry.bytes = new Uint8Array(await file.arrayBuffer());
      if (!isImages) {
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
    if (['organize', 'rotate', 'delete', 'extract', 'split', 'toImages'].includes(tool.mode)) {
      const n = state.files[0].pageCount;
      state.pages = Array.from({ length: n }, (_, i) => ({ n: i + 1, rot: 0, on: tool.mode === 'toImages' }));
    }
    render();
  }

  function reset() {
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
    $('.assure')?.setAttribute('hidden', '');
    const work = h(`<div class="work"><div class="stage"></div><aside class="panel" aria-label="${esc(t('options'))}"></aside></div>`);
    root.replaceChildren(work);
    const stage = $('.stage', work);
    const panel = $('.panel', work);
    const views = { merge: viewFiles, images: viewFiles, organize: viewPages, rotate: viewPages, delete: viewPages, extract: viewPages, split: viewPages, toImages: viewPages, place: viewPlace };
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
    const selectMode = ['delete', 'extract', 'toImages'].includes(tool.mode);
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
    } else if (tool.mode === 'extract' || tool.mode === 'toImages') {
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
      <div><h3>${esc(f.name)}</h3><p>${f.locked ? esc(t('passwordProtected')) : f.broken ? esc(t('cannotPreview')) : tp('pages', f.pageCount)} · ${fmtBytes(f.size)}</p>
      <p style="margin-top:12px"><button class="btn-plain" type="button">${esc(t('chooseAnother'))}</button></p></div>
    </div>`);
    $('.btn-plain', box).onclick = () => input.click();
    const thumb = $('.thumb', box);
    if (f.locked) thumb.innerHTML = `<div style="color:var(--text-3)">${ICON.lock.replace(/12/g, '48')}</div>`;
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
      case 'toImages': {
        const label = t({ delete: 'pagesToDelete', extract: 'pagesToExtract', toImages: 'pagesToConvert' }[tool.mode]);
        sub.textContent = t(`${tool.mode}Sub`);
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
        if (tool.mode === 'toImages') {
          Object.assign(o, { format: o.format || 'jpeg', scale: o.scale || 2 });
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
        const text = h(`<input class="input" type="text" value="${esc(o.text)}" maxlength="80" aria-label="${esc(t('text'))}">`);
        text.oninput = () => ((o.text = text.value), preview(), (action.disabled = !o.text.trim()));
        nodes.push(field(esc(t('text')), text));
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
        nodes.push(field(esc(t('colour')), sw));
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
          if (!canvas || !o.text.trim()) return;
          const r = canvas.getBoundingClientRect();
          const wrap = state.previewWrap.getBoundingClientRect();
          const mark = textImage(o.text, o.color, 120);
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
        nodes.push(...(tool.slug === 'add-text-to-pdf' ? [text, sig] : [sig, text]));
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
    else $('.placed-body', item.el).style.fontSize = `${item.size * s.clientWidth}px`;
  }

  function addItem(kind, payload) {
    const sheet = visibleSheet();
    const item = { kind, sheet, page: +sheet.dataset.page, x: 0.3, y: 0.4, w: 0.36, size: state.options.textSize, color: state.options.textColor };
    item.el = h(`<div class="placed placed-${kind}"><div class="placed-body"></div><button class="placed-del" type="button" aria-label="${esc(t('deleteItem'))}">${ICON.close}</button>${kind === 'image' ? `<span class="placed-size" aria-hidden="true"></span>` : ''}</div>`);
    const body = $('.placed-body', item.el);
    if (kind === 'image') {
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
      const start = { x: e.clientX, y: e.clientY, ix: item.x, iy: item.y, iw: item.w, size: item.size };
      const sr = sheet.getBoundingClientRect();
      let moved = false;
      const move = (ev) => {
        const dx = (ev.clientX - start.x) / sr.width;
        const dy = (ev.clientY - start.y) / sr.height;
        if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
        moved = true;
        ev.preventDefault();
        if (resizing) item.w = Math.max(0.06, Math.min(1 - item.x, start.iw + dx));
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
      if (item.kind === 'image' || resizing) e.preventDefault();
    });
  }

  // What the engine needs for one item: page, rectangle in page fractions, RGBA pixels.
  function itemPayload(item) {
    const s = item.sheet.getBoundingClientRect();
    const r = item.el.getBoundingClientRect();
    const body = $('.placed-body', item.el).getBoundingClientRect();
    const rect = [(body.left - s.left) / s.width, (body.top - s.top) / s.height, body.width / s.width, body.height / s.height];
    let canvas = item.canvas;
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
    const verb = { crop: 'busySave', nup: 'busySave', metadata: 'busySave', repair: 'busyRepair', place: 'busySave', merge: 'busyMerge', images: 'busyImages', split: 'busySplit', extract: 'busySplit', compress: 'busyCompress', numbers: 'busyNumbers', watermark: 'busyWatermark', protect: 'busyProtect', unlock: 'busyUnlock', toImages: 'busyRender' }[tool.mode] || 'busySave';
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
      case 'delete': {
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
        const mark = textImage(o.text, o.color, 200);
        const rgba = new Uint8Array(mark.getContext('2d').getImageData(0, 0, mark.width, mark.height).data.buffer);
        out = await engine('watermark', { pdf: copy(f.bytes), rgba, width: mark.width, height: mark.height, scale: o.scale, rotation: o.rotation, opacity: o.opacity, tiled: o.tiled }, [rgba.buffer]);
        name = `${base}-watermarked.pdf`;
        break;
      }
      case 'protect':
        out = await engine('protect', { pdf: copy(f.bytes), password: o.password, allowPrint: o.allowPrint, allowCopy: o.allowCopy });
        name = `${base}-protected.pdf`;
        break;
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
    const blob = new Blob([bytes], { type });
    const url = URL.createObjectURL(blob);
    state.result = { url, bytes, name, type };
    let saving = '';
    if (before) {
      const pct = Math.round((1 - blob.size / before) * 100);
      saving = pct > 0 ? `<p class="saving">${esc(t('smaller', { pct }))} · <bdi>${fmtBytes(before)} → ${fmtBytes(blob.size)}</bdi></p>` : `<p class="saving" style="color:var(--text-2);background:var(--surface-2)">${esc(t('optimised'))}</p>`;
    }
    const title = t(type === 'application/zip' ? 'readyFiles' : type.startsWith('image/') ? 'readyImage' : 'readyPdf');
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
}

/* ---------- Watermark drawing (shared by preview and output) ---------- */

function textImage(text, color, px) {
  const font = `700 ${px}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Noto Sans", "Noto Sans Arabic", sans-serif`;
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
