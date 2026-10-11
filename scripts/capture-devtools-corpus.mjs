// Captures the real DevTools "Copy as cURL (bash)", "Copy as cURL (cmd)", "Copy as fetch" and
// "Copy as fetch (Node.js)" text for a set of fixture requests, using the browser's own DevTools
// frontend code (the same functions the Network panel's Copy menu calls). Output is the R7 dialect
// corpus in tests/fixture/corpus/. Needs the fixture server running (npm run fixture).
//
//   AW_PORT=4320 AW_OTHER_PORT=4321 npm run fixture &
//   AW_PORT=4320 AW_OTHER_PORT=4321 node scripts/capture-devtools-corpus.mjs [chrome|msedge]
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const channel = process.argv[2] ?? 'chrome';
const A = `http://127.0.0.1:${process.env.AW_PORT ?? 4310}`;
const B = `http://127.0.0.1:${process.env.AW_OTHER_PORT ?? 4311}`;

// Each case is sent by the page; `id` is carried in the x-corpus header so requests can be matched.
const CASES = [
  { id: 'get-query-unicode', url: `${A}/api/echo?q=caf%C3%A9&tag=a&tag=b&empty=`, init: { headers: { 'X-Note': 'naïve café' } } },
  { id: 'post-json-escapes', url: `${A}/api/echo`, init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: "line1\nline2\ttab \"dq\" 'sq' back\\slash $HOME !bang %PATH% ^caret &amp", emoji: '😀', n: 1.10 }) } },
  { id: 'post-urlencoded', url: `${A}/api/echo`, init: { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1&b=two+words&c=%26%3D&password=hunter2' } },
  { id: 'post-multipart', url: `${A}/api/echo`, init: { method: 'POST', body: '__FORMDATA__' } },
  { id: 'put-glob-cmd-chars', url: `${A}/api/echo/items[1]/{id}?a=1&b=%25PATH%25`, init: { method: 'PUT', headers: { 'Content-Type': 'text/plain', 'X-Odd': '100% ^ & | < > "q"' }, body: 'plain & simple | 50% <ok> "q" \\ end' } },
  { id: 'auth-and-empty-header', url: `${A}/api/echo`, init: { headers: { Authorization: 'Bearer sekrit-token-123', 'X-Empty': '' } } },
  { id: 'delete-cross-origin-credentials', url: `${B}/api/echo/7`, init: { method: 'DELETE', credentials: 'include' } },
  { id: 'patch-json-no-ct', url: `${A}/api/echo/7`, init: { method: 'PATCH', body: '{"op":"set","v":true}' } },
];

const browser = await chromium.launch({ channel, headless: false, args: ['--auto-open-devtools-for-tabs'] });
const version = browser.version();
const page = await browser.newPage();
await page.goto(`${A}/api/login`); // sets a session cookie so copies include cookie data
await page.goto(`${A}/fixture`);
await page.waitForTimeout(2500);
const cdp = await browser.newBrowserCDPSession();
const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{}] });
const dt = targetInfos.find((t) => t.type === 'page' && t.url.startsWith('devtools://'));
if (!dt) throw new Error('DevTools frontend target not found');
// Non-flattened session: messages go through Target.sendMessageToTarget (Playwright exposes no
// page object for the DevTools frontend).
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: dt.targetId, flatten: false });
let seq = 0;
const pending = new Map();
cdp.on('Target.receivedMessageFromTarget', (e) => {
  const m = JSON.parse(e.message);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const evalDt = async (expression) => {
  const id = ++seq;
  const done = new Promise((resolve) => pending.set(id, resolve));
  await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }) });
  const m = await done;
  if (m.error || m.result.exceptionDetails) throw new Error(JSON.stringify(m.error ?? m.result.exceptionDetails).slice(0, 1200));
  return m.result.result.value;
};
await page.evaluate(async (cases) => {
  for (const c of cases) {
    const init = { ...c.init, headers: { ...(c.init.headers ?? {}), 'X-Corpus': c.id } };
    if (init.body === '__FORMDATA__') {
      const fd = new FormData();
      fd.append('title', 'Résumé & notes');
      fd.append('upload', new Blob(['file-bytes'], { type: 'text/plain' }), 'notes.txt');
      init.body = fd;
    }
    await fetch(c.url, init).then((r) => r.text()).catch(() => {});
  }
}, CASES);
await page.waitForTimeout(1500);

const out = await evalDt(`(async () => {
  const Logs = await import('./models/logs/logs.js');
  const Network = await import('./panels/network/network.js');
  const View = Network.NetworkLogView.NetworkLogView;
  const self = Object.create(View.prototype); // generateFetchCall/generateAll* are instance methods that use no view state
  const reqs = Logs.NetworkLog.NetworkLog.instance().requests();
  const res = [];
  const all = [];
  for (const r of reqs) {
    const h = r.requestHeaders().find((x) => x.name.toLowerCase() === 'x-corpus');
    if (!h || r.requestMethod === 'OPTIONS') continue;
    res.push({
      id: h.value,
      curlBash: await View.generateCurlCommand(r, 'unix'),
      curlCmd: await View.generateCurlCommand(r, 'win'),
      fetch: await self.generateFetchCall(r, 0),
      fetchNode: await self.generateFetchCall(r, 1),
    });
    if (['get-query-unicode', 'post-json-escapes', 'post-urlencoded'].includes(h.value)) all.push(r);
  }
  return { res, all: { curlBash: await self.generateAllCurlCommand(all, 'unix'), curlCmd: await self.generateAllCurlCommand(all, 'win'), fetch: await self.generateAllFetchCall(all, 0) } };
})()`);
await browser.close();

const byId = new Map(out.res.map((x) => [x.id, x]));
const missing = CASES.filter((c) => !byId.has(c.id)).map((c) => c.id);
if (missing.length) throw new Error(`not captured: ${missing.join(', ')}`);
mkdirSync('tests/fixture/corpus', { recursive: true });
const file = `tests/fixture/corpus/${channel}-${version.split('.')[0]}.json`;
writeFileSync(file, JSON.stringify({
  browser: channel, version, capturedAt: new Date().toISOString(), origins: { A, B },
  method: 'DevTools frontend NetworkLogView.generateCurlCommand(request, unix|win) and generateFetchCall(request, browser|nodejs), the functions behind the Network panel Copy menu',
  cases: CASES.map((c) => ({ id: c.id, sent: { url: c.url, method: c.init.method ?? 'GET' }, ...byId.get(c.id) })),
  copyAll: { ids: ['get-query-unicode', 'post-json-escapes', 'post-urlencoded'], ...out.all },
}, null, 2) + '\n');
console.log(`wrote ${file} (${version}, ${out.res.length} cases)`);
