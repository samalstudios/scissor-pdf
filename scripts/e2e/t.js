// In-browser test helper for the local preview (copied to dist/_test/, never deployed).
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function feed(names) {
  const dt = new DataTransfer();
  for (const n of names) {
    const b = await (await fetch('/_test/' + n)).blob();
    dt.items.add(new File([b], n, { type: n.endsWith('.pdf') ? 'application/pdf' : n.endsWith('.png') ? 'image/png' : 'image/jpeg' }));
  }
  const i = document.querySelector('input[type=file]');
  i.files = dt.files;
  i.dispatchEvent(new Event('change'));
  await sleep(1800);
}
export async function go() {
  document.querySelector('.panel .btn.primary').click();
  for (let i = 0; i < 60 && !document.querySelector('.done, .alert'); i++) await sleep(250);
}
export async function inspect(password) {
  const PJ = document.documentElement.dataset.pdfjs;
  const lib = await import(PJ + '/pdf.min.js');
  lib.GlobalWorkerOptions.workerSrc = PJ + '/pdf.worker.min.js';
  const a = document.querySelector('.done a');
  if (!a) return 'NO RESULT: ' + (document.querySelector('.alert')?.innerText || '');
  const b = new Uint8Array(await (await fetch(a.href)).arrayBuffer());
  if (!a.download.endsWith('.pdf')) return `${a.download} ${b.length}B magic=${String.fromCharCode(...b.slice(0, 4))}`;
  try {
    const d = await lib.getDocument({ data: b, password }).promise;
    const p = await d.getPage(1);
    const t = (await p.getTextContent()).items.map((i) => i.str).join(' ').replace(/\s+/g, ' ');
    return `${a.download} pages=${d.numPages} rot1=${p.rotate} text1="${t.slice(0, 24)}…${t.slice(-14)}"`;
  } catch (e) {
    return `${a.download} ERR ${e.name}`;
  }
}
