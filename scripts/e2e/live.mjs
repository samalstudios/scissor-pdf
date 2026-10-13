// Drives headless Chrome over the DevTools protocol against a URL and reports console errors,
// failed requests and the result of running a tool on a sample file.
// node scripts/e2e/live.mjs <url> <file> [resolveIp]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, file, ip] = process.argv.slice(2);
const host = new URL(url).hostname;
const args = ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-'))}`, 'about:blank'];
if (ip) args.push(`--host-resolver-rules=MAP ${host} ${ip}`);
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args, { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch('http://127.0.0.1:9333/json')).json()).find((t) => t.type === 'page'); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const waiting = new Map();
const log = [];
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (m.id) return waiting.get(m.id)?.(m);
  if (m.method === 'Runtime.consoleAPICalled') log.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  if (m.method === 'Runtime.exceptionThrown') log.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
  if (m.method === 'Log.entryAdded') log.push(`log.${m.params.entry.level}: ${m.params.entry.text} ${m.params.entry.url ?? ''}`);
  if (m.method === 'Network.loadingFailed') log.push(`netfail: ${m.params.errorText} ${m.params.blockedReason ?? ''}`);
  if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) log.push(`http ${m.params.response.status}: ${m.params.response.url}`);
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
for (const d of ['Runtime', 'Log', 'Network', 'Page', 'DOM']) await send(`${d}.enable`);
await send('Page.navigate', { url });
await sleep(4000);
log.push(`title: ${await evaluate('document.title')}`);
const { root } = (await send('DOM.getDocument')).result;
const { nodeId } = (await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' })).result;
await send('DOM.setFileInputFiles', { nodeId, files: [file] });
await sleep(3000);
log.push(`after file: ${await evaluate("document.querySelector('.stage-head, .single h3, .alert')?.innerText")}`);
await evaluate("document.querySelector('.panel .btn.primary')?.click()");
for (let i = 0; i < 40; i++) { await sleep(500); if (await evaluate("!!document.querySelector('.done, .alert')")) break; }
log.push(`result: ${await evaluate("(document.querySelector('.done, .alert')?.innerText || 'nothing').replace(/\\n+/g, ' | ')")}`);
console.log(log.join('\n'));
chrome.kill();
process.exit(0);
