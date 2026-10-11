// Builds the full-inline bookmarklet: readable + minified IIFE, javascript: URL, installer and size/hash report.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

// AW_VERSION / AW_OUT build a labelled test candidate elsewhere (update-cycle tests); AW_UPDATE_URL is the
// published folder holding update.json + bookmark.txt (https, or http on loopback for the fixture).
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const version = process.env.AW_VERSION ?? pkg.version;
const outDir = process.env.AW_OUT ?? 'dist';
const updateUrl = process.env.AW_UPDATE_URL ?? '';
if (updateUrl) {
  let u;
  try { u = new URL(updateUrl); } catch { u = null; }
  const loopback = u && u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname);
  if (!u || !(u.protocol === 'https:' || loopback) || !updateUrl.endsWith('/') || u.search || u.hash || u.username || u.password) {
    console.error(`BUILD FAILED\n- AW_UPDATE_URL must be an https (or loopback http) folder URL ending in /: ${updateUrl}`);
    process.exit(1);
  }
}
const sha = (s) => createHash('sha256').update(s).digest('hex');

const common = {
  entryPoints: ['src/entry.ts'],
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  charset: 'utf8',
  legalComments: 'none',
  loader: { '.css': 'text' },
  define: { __VERSION__: JSON.stringify(version), __UPDATE_URL__: JSON.stringify(updateUrl) },
  write: false,
  metafile: true,
};
const [readable, minified] = await Promise.all([build({ ...common }), build({ ...common, minify: true })]);
const js = readable.outputFiles[0].text;
const min = minified.outputFiles[0].text.trim();

// ---- Distribution checks (G01): inline only, no evaluators, no runtime assets.
const failures = [];
for (const input of Object.keys(minified.metafile.inputs)) {
  if (!input.startsWith('src/') && !input.startsWith('design/reference/')) failures.push(`unexpected bundled input ${input}`);
}
const forbidden = [
  // `$eval(` is the restricted expression keyword (data, parsed by src/tester/expr.ts), never a call.
  [/(?<![$\w.])eval\s*\(|\.eval\s*\(/, 'eval('],
  [/new Function\b/, 'new Function'],
  [/\bimport\s*\(/, 'dynamic import'],
  [/importScripts/, 'importScripts'],
  [/@import\b/, 'CSS @import'],
  [/url\(/, 'CSS url()'],
  [/@font-face/, '@font-face'],
  [/\.innerHTML\s*=|insertAdjacentHTML|document\.write/, 'HTML string injection'],
];
for (const [re, label] of forbidden) if (re.test(min)) failures.push(`forbidden construct: ${label}`);
// Literal strings only: the SVG namespace and placeholder/example text. Never fetched.
const ALLOWED_URL_TEXT = new Set(['http://www.w3.org/2000/svg', 'http://localhost:8080', 'https://api.example.com', 'https://api.example.com/path']);
// The update address is the one URL the bundle may read, and only on an explicit Check click.
if (updateUrl) ALLOWED_URL_TEXT.add(updateUrl);
const urls = (min.match(/https?:\/\/[^\s"'`)]+/g) ?? []).filter((u) => !ALLOWED_URL_TEXT.has(u));
if (urls.length) failures.push(`unexpected URLs in bundle: ${urls.join(', ')}`);

const source = `${min};void 0`;
// Opaque javascript URLs need delimiters, literal %, whitespace and Unicode escaped, not every JS
// punctuation mark. Full component encoding inflated this bundle past the native clipboard path.
const bookmark = 'javascript:' + source.replace(/[^\x21-\x7e]|[%#?]/gu, (c) => encodeURIComponent(c));
if (decodeURIComponent(bookmark.slice('javascript:'.length)) !== source) failures.push('bookmark encoding does not round-trip');
if (failures.length) {
  console.error('BUILD FAILED\n- ' + failures.join('\n- '));
  process.exit(1);
}

const sizes = {
  version,
  builtAt: new Date().toISOString(),
  updateUrl,
  readableBytes: Buffer.byteLength(js),
  minifiedBytes: Buffer.byteLength(min),
  bookmarkChars: bookmark.length,
  sha256: { readable: sha(js), minified: sha(min), bookmark: sha(bookmark) },
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;
const manifest = { schema: 1, version, bookmarkChars: sizes.bookmarkChars, bookmarkSha256: sizes.sha256.bookmark, minifiedSha256: sizes.sha256.minified, builtAt: sizes.builtAt };

// Public guide + installer (S01.1): self-contained, system fonts, no external assets. Facts come from this build.
const install = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install API Workbench ${esc(version)}</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#09090b;color:#fafafa;font:15px/1.6 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}
a{color:#e4e4e7}main{max-width:760px;margin:0 auto;padding:32px 16px 64px}h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 8px}
p,li,dd{color:#d4d4d8}.mu{color:#a1a1aa}.skip{position:absolute;left:-9999px}.skip:focus{left:16px;top:8px;background:#fafafa;color:#18181b;padding:6px 10px;border-radius:6px}
.bm{display:inline-flex;align-items:center;gap:8px;margin:16px 0 4px;padding:10px 16px;border-radius:8px;background:#fafafa;color:#18181b;font-weight:600;text-decoration:none;cursor:grab}
.card{border:1px solid #27272a;background:#111113;border-radius:10px;padding:16px;margin:16px 0}
textarea{width:100%;height:96px;background:#0c0c0e;color:#d4d4d8;border:1px solid #27272a;border-radius:6px;font:11px ui-monospace,Menlo,monospace}
button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid #3f3f46;background:#27272a;color:#fafafa;cursor:pointer}
:focus-visible{outline:2px solid #a1a1aa;outline-offset:2px}
.scroll{overflow-x:auto;max-width:100%}table{border-collapse:collapse;min-width:520px}th,td{padding:4px 12px 4px 0;text-align:left;vertical-align:top;border-bottom:1px solid #27272a}th{color:#a1a1aa;font-weight:500}
code{font-family:ui-monospace,Menlo,monospace;font-size:12px;overflow-wrap:anywhere}details{border-bottom:1px solid #27272a;padding:8px 0}summary{cursor:pointer;font-weight:500}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0}dt{color:#a1a1aa}dd{margin:0;overflow-wrap:anywhere}
</style></head><body><a class="skip" href="#install">Skip to installation</a><main>
<h1>API Workbench <span class="mu">${esc(version)}</span></h1>
<p>A browser-local tool for testing an application's API traffic inside the application's own tab. Everything runs from the bookmark itself: no extension, server, account or downloaded code. Data stays in the browser storage of the site you test.</p>
<p class="mu"><strong>Pre-release build.</strong> Chrome is tested by an automated suite; Microsoft Edge, real bookmarks-bar dragging and screen readers have not been verified for this build. See the release report before relying on it.</p>

<h2 id="install">Install</h2>
<a class="bm" id="bookmark" href="${esc(bookmark)}">API Workbench ${esc(version)}</a>
<ol>
<li>Show the bookmarks bar (Ctrl+Shift+B, or ⌘+Shift+B on macOS).</li>
<li>Drag the button above onto the bookmarks bar. Clicking it on this page only runs it here; it does not install it.</li>
<li>Or create a bookmark by hand and paste the complete text below as its URL. It must start with <code>javascript:</code> and be pasted whole.</li>
<li>Open the application you want to test, sign in as usual, then click the saved bookmark. Clicking it again restores the same panel.</li>
</ol>
<div class="card"><label for="text"><strong>Complete bookmark text</strong> <span class="mu">(${sizes.bookmarkChars.toLocaleString('en')} characters)</span></label>
<textarea id="text" readonly>${esc(bookmark)}</textarea>
<p><button type="button" id="copy">Copy bookmark text</button> <span id="copied" class="mu" role="status"></span></p></div>

<h2>A first session</h2>
<ol>
<li><strong>Get requests in.</strong> Import a HAR, OpenAPI/Swagger, Postman, cURL or fetch copy; or Record the page's calls; or create an endpoint by hand.</li>
<li><strong>Review and save.</strong> Nothing is saved until you confirm the review. Values the source did not supply are marked and block sending until you fill them.</li>
<li><strong>Send once.</strong> Test → Once shows the exact prepared request, then the response, headers and checks.</li>
<li><strong>Derive a rule.</strong> Turn the endpoint into a mock, an intercept, a route or a chaos rule. Saving a rule does not change traffic; <em>activating</em> its module does.</li>
<li><strong>Use the app.</strong> Repeat the page action and open its request detail: it says which rule was selected, applied or skipped, and why.</li>
<li><strong>Keep it.</strong> Export the profile (secrets redacted by default), Stop all, then Close. Close removes the hooks it installed.</li>
</ol>

<h2>Modules</h2>
<div class="scroll"><table>
<tr><th scope="col">Module</th><th scope="col">What it does</th></tr>
<tr><td>Test</td><td>Saved endpoints, Once, plans (Flow/Independent, setup, iterations, concurrency), results, auth contexts with refresh, HMAC-SHA-256 signing recipes, guards, polling and cross-step checks.</td></tr>
<tr><td>Mock</td><td>Static or sequenced replies for matching page calls; no request reaches the server.</td></tr>
<tr><td>Intercept</td><td>Edit request/response headers and bodies (JSON Patch, literal replacements, status); pause requests or responses at breakpoints.</td></tr>
<tr><td>Route</td><td>Send matching calls to another origin/path; Authorization is dropped across origins unless allowed for that destination.</td></tr>
<tr><td>Chaos</td><td>Latency, HTTP/network/timeout faults, corruption and bounded replay, synthetic or on real responses, with probability, seed and budgets.</td></tr>
<tr><td>Import / Recorder</td><td>HAR 1.2, Swagger 2.0 JSON, OpenAPI 3.0 JSON, Postman collection v2.1, Chrome DevTools cURL (bash and cmd) and fetch copies, native profiles and backups; recorder for this frame's future calls.</td></tr>
</table></div>

<h2>Scope and limits</h2>
<ul>
<li>Covers calls made through this frame's <code>fetch</code> and <code>XMLHttpRequest</code> after launch. Workers, other frames, references the page saved earlier, navigation, beacons, sockets and event streams are not covered.</li>
<li>Browser CORS, cookies and Content-Security-Policy stay in force. A strict policy can block the bookmark itself or the tester's requests; the panel says so rather than bypassing it.</li>
<li>Imported files are data: no script, shell command or Postman script runs. YAML, OpenAPI 3.1, Postman v1 and environment files are named but not imported.</li>
<li>Stored data is readable by the site's own scripts; it is not a secret vault. Current tokens, keys and signatures are never saved.</li>
</ul>

<h2>Update, remove, roll back</h2>
<details><summary>Update to a newer build</summary><p>${updateUrl ? `In the panel, open Settings → About → <em>Check for update</em>. It reads <code>update.json</code> and <code>bookmark.txt</code> from <code>${esc(updateUrl)}</code> only when you click, verifies the SHA-256, and lets you copy the new text. Then edit your saved bookmark, replace its URL with the copied text, reload the page and click it.` : 'This build has no update address. Come back to the installer page, copy the newer bookmark text, and replace your saved bookmark\'s URL with it.'} Copying never installs anything by itself.</p></details>
<details><summary>Remove the hooks or the tool</summary><p>Close in the panel (or reloading the page) removes the hooks. Settings → Clear local data deletes this tool's data for the current site only. Deleting the bookmark uninstalls it.</p></details>
<details><summary>Go back to an earlier build</summary><p>Reinstall the earlier bookmark text. Data written by a newer build is not converted back automatically; export a profile first if you need it in both.</p></details>
<details><summary>Coming from API Workbench 1.x</summary><p>Close the 1.x panel and reload before launching this version; two layers never run together. Import → <em>Look for schema 1 data</em> previews the old data and converts it only after you confirm; the old database is left untouched.</p></details>

<h2>This build</h2>
<div class="card"><dl>
<dt>Version</dt><dd>${esc(version)}</dd>
<dt>Built</dt><dd>${esc(sizes.builtAt)}</dd>
<dt>Minified bundle</dt><dd>${sizes.minifiedBytes.toLocaleString('en')} bytes (${kib(sizes.minifiedBytes)})</dd>
<dt>Bookmark URL</dt><dd>${sizes.bookmarkChars.toLocaleString('en')} characters</dd>
<dt>Bookmark SHA-256</dt><dd><code>${sizes.sha256.bookmark}</code></dd>
<dt>Update address</dt><dd>${updateUrl ? `<code>${esc(updateUrl)}</code>` : 'none'}</dd>
</dl></div>
</main><script>
document.getElementById('copy').addEventListener('click',function(){var o=document.getElementById('copied');
Promise.resolve().then(function(){return navigator.clipboard.writeText(document.getElementById('text').value)}).then(function(){o.textContent='Copied. Paste it as the bookmark URL; copying does not install it.'},function(){o.textContent='Clipboard refused. Select the text above and copy it manually.'})});
</script></body></html>
`;

await mkdir(outDir, { recursive: true });
await Promise.all([
  writeFile(`${outDir}/aw.js`, js),
  writeFile(`${outDir}/aw.min.js`, min),
  writeFile(`${outDir}/bookmark.txt`, bookmark),
  writeFile(`${outDir}/install.html`, install),
  writeFile(`${outDir}/update.json`, JSON.stringify(manifest, null, 2) + '\n'),
  writeFile(`${outDir}/sizes.json`, JSON.stringify(sizes, null, 2) + '\n'),
]);
console.log(`API Workbench ${version}: readable ${sizes.readableBytes} B · minified ${sizes.minifiedBytes} B · bookmark ${sizes.bookmarkChars} chars${updateUrl ? ` · update ${updateUrl}` : ''} → ${outDir}/`);
