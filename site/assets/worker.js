// Runs the Rust/WebAssembly engine off the main thread so the page stays responsive.
// Receives { id, op, args } and answers { id, out } or { id, error }. No network access.
import init, * as E from '../engine/engine.js';

const ready = init({ module_or_path: new URL('../engine/engine_bg.wasm', import.meta.url) });

const ops = {
  merge: (a) => E.merge(a.files),
  organize: (a) => E.organize(a.pdf, Uint32Array.from(a.pages), Int32Array.from(a.rotations)),
  split: (a) => E.split(a.pdf, Uint32Array.from(a.groups.flat()), Uint32Array.from(a.groups.map((g) => g.length)), a.base),
  compress: (a) => E.compress(a.pdf, a.level),
  numbers: (a) => E.pageNumbers(a.pdf, a.position, a.template, a.start, a.firstPage, a.size, a.margin),
  watermark: (a) => E.watermark(a.pdf, a.rgba, a.width, a.height, a.scale, a.rotation, a.opacity, a.tiled),
  protect: (a) => E.protect(a.pdf, a.password, '', a.allowPrint, a.allowCopy),
  unlock: (a) => E.unlock(a.pdf, a.password),
  crop: (a) => E.crop(a.pdf, Uint32Array.from(a.pages), ...a.margins),
  nup: (a) => E.nUp(a.pdf, a.perSheet, a.paper),
  metadata: (a) => E.metadata(a.pdf, a.title, a.author, a.subject, a.keywords, a.wipe),
  repair: (a) => E.repair(a.pdf),
  grayscale: (a) => E.grayscale(a.pdf),
  flatten: (a) => E.flatten(a.pdf),
  removeAnnotations: (a) => E.removeAnnotations(a.pdf, !!a.keepLinks),
  extractImages: (a) => E.extractImages(a.pdf),
  removeImages: (a) => E.removeImages(a.pdf),
  reverse: (a) => E.organize(a.pdf, Uint32Array.from(a.pages), new Int32Array(0)),
  splitBookmarks: (a) => E.splitByBookmarks(a.pdf, a.base),
  rasterize: (a) => E.rasterizePages(a.pdf, Uint32Array.from(a.pages), Uint32Array.from(a.sizes), a.jpegs),
  insertBlank: (a) => E.insertBlank(a.pdf, Uint32Array.from(a.after), a.every),
  interleave: (a) => E.interleave(a.a, a.b, a.reverseB),
  splitHalf: (a) => E.splitHalf(a.pdf, a.vertical, a.rtl),
  addMargins: (a) => E.addMargins(a.pdf, a.points),
  resize: (a) => E.resize(a.pdf, a.paper),
  booklet: (a) => E.booklet(a.pdf, a.paper),
  splitBySize: (a) => E.splitBySize(a.pdf, a.maxBytes, a.base),
  setBookmarks: (a) => E.setBookmarks(a.pdf, a.titles, Uint32Array.from(a.pages)),
  addBackground: (a) => E.addBackground(a.pdf, a.background, a.onTop, a.firstOnly),
  info: (a) => new TextEncoder().encode(E.info(a.pdf)),
  place: (a) =>
    E.placeImages(
      a.pdf,
      Uint32Array.from(a.items.map((i) => i.page)),
      Float32Array.from(a.items.flatMap((i) => i.rect)),
      Uint32Array.from(a.items.flatMap((i) => [i.width, i.height])),
      a.items.map((i) => i.rgba),
    ),
  images: (a) => {
    const doc = new E.ImageDoc(a.paper, a.margin);
    try {
      for (const im of a.images) im.jpeg ? doc.addJpeg(im.data) : doc.addRgba(im.data, im.width, im.height);
      return doc.finish();
    } finally {
      doc.free();
    }
  },
  zip: (a) => {
    const zip = new E.Zip();
    try {
      for (const f of a.files) zip.add(f.name, f.data);
      return zip.finish();
    } finally {
      zip.free();
    }
  },
};

self.onmessage = async ({ data: { id, op, args } }) => {
  try {
    await ready;
    const out = ops[op](args);
    self.postMessage({ id, out }, [out.buffer]);
  } catch (e) {
    self.postMessage({ id, error: String(e?.message ?? e) });
  }
};
