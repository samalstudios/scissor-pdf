// Opens PDFs with pdf.js (the renderer the site uses) and prints page count and page-1 text.
// node scripts/pdfcheck.mjs [--password pw] file.pdf...
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
let password;
if (args[0] === '--password') { password = args[1]; args.splice(0, 2); }
for (const f of args) {
  try {
    const doc = await getDocument({ data: new Uint8Array(readFileSync(f)), password, verbosity: 0 }).promise;
    const p = await doc.getPage(1);
    const t = (await p.getTextContent()).items.map(i => i.str).join(' ');
    console.log(`${f.split('/').pop()}: pages=${doc.numPages} rotate=${p.rotate} text="${t.slice(0, 40)}…${t.slice(-20)}"`);
  } catch (e) { console.log(`${f.split('/').pop()}: ERROR ${e.name} ${e.message}`); }
}
