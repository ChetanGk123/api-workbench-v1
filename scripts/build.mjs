// Builds the full-inline bookmarklet: readable + minified IIFE, javascript: URL, installer and size/hash report.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const version = pkg.version;
const sha = (s) => createHash('sha256').update(s).digest('hex');

const common = {
  entryPoints: ['src/entry.ts'],
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  charset: 'utf8',
  legalComments: 'none',
  loader: { '.css': 'text' },
  define: { __VERSION__: JSON.stringify(version) },
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
  [/\beval\s*\(/, 'eval('],
  [/new Function\b/, 'new Function'],
  [/\bimport\s*\(/, 'dynamic import'],
  [/importScripts/, 'importScripts'],
  [/@import\b/, 'CSS @import'],
  [/url\(/, 'CSS url()'],
  [/@font-face/, '@font-face'],
  [/\.innerHTML\s*=|insertAdjacentHTML|document\.write/, 'HTML string injection'],
];
for (const [re, label] of forbidden) if (re.test(min)) failures.push(`forbidden construct: ${label}`);
const urls = (min.match(/https?:\/\/[^\s"'`)]+/g) ?? []).filter((u) => u !== 'http://www.w3.org/2000/svg');
if (urls.length) failures.push(`unexpected URLs in bundle: ${urls.join(', ')}`);

const source = `${min};void 0`;
const bookmark = 'javascript:' + encodeURIComponent(source);
if (decodeURIComponent(bookmark.slice('javascript:'.length)) !== source) failures.push('bookmark encoding does not round-trip');
if (failures.length) {
  console.error('BUILD FAILED\n- ' + failures.join('\n- '));
  process.exit(1);
}

const sizes = {
  version,
  builtAt: new Date().toISOString(),
  readableBytes: Buffer.byteLength(js),
  minifiedBytes: Buffer.byteLength(min),
  bookmarkChars: bookmark.length,
  sha256: { readable: sha(js), minified: sha(min), bookmark: sha(bookmark) },
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;
const install = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install API Workbench ${esc(version)}</title>
<style>
:root{color-scheme:dark}body{margin:0;background:#09090b;color:#fafafa;font:14px/1.55 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px}h1{font-size:22px;margin:0 0 4px}p,li{color:#d4d4d8}.mu{color:#a1a1aa}
.bm{display:inline-flex;align-items:center;gap:8px;margin:16px 0;padding:10px 16px;border-radius:8px;background:#fafafa;color:#18181b;font-weight:600;text-decoration:none;cursor:grab}
.card{border:1px solid #27272a;background:#111113;border-radius:10px;padding:16px;margin:16px 0}
textarea{width:100%;box-sizing:border-box;height:96px;background:#0c0c0e;color:#d4d4d8;border:1px solid #27272a;border-radius:6px;font:11px ui-monospace,Menlo,monospace}
button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid #3f3f46;background:#27272a;color:#fafafa;cursor:pointer}
table{border-collapse:collapse}td{padding:2px 12px 2px 0}code{font-family:ui-monospace,Menlo,monospace;font-size:12px;overflow-wrap:anywhere}
</style></head><body><main>
<h1>API Workbench <span class="mu">${esc(version)}</span></h1>
<p>A browser-local tool for testing the current page's Fetch/XHR traffic. Everything runs from the bookmark itself: no extension, server, or downloaded code.</p>
<p><strong>R0 build.</strong> Mock, route and response-text transform for one endpoint path, with request activity. Later features are not part of this build.</p>
<a class="bm" id="bookmark" href="${esc(bookmark)}">API Workbench ${esc(version)}</a>
<div class="card"><strong>Install</strong><ol>
<li>Show the bookmarks bar (Ctrl/⌘+Shift+B).</li>
<li>Drag the button above onto the bookmarks bar. Clicking it on this page only runs it here; it does not install it.</li>
<li>Or create a bookmark manually and paste the complete text below as its URL. It must start with <code>javascript:</code>.</li>
<li>Open the application you want to test, then click the saved bookmark. Clicking again restores the same panel.</li>
</ol>
<p class="mu">To remove its hooks, use Close in the panel or reload the page. To update, replace the bookmark's URL with a newer build.</p>
<textarea id="text" readonly aria-label="Complete bookmark URL">${esc(bookmark)}</textarea>
<p><button type="button" id="copy">Copy bookmark text</button> <span id="copied" class="mu" role="status"></span></p></div>
<div class="card"><strong>This build</strong><table>
<tr><td class="mu">Minified bundle</td><td>${sizes.minifiedBytes.toLocaleString('en')} bytes (${kib(sizes.minifiedBytes)})</td></tr>
<tr><td class="mu">Bookmark URL</td><td>${sizes.bookmarkChars.toLocaleString('en')} characters</td></tr>
<tr><td class="mu">Bookmark SHA-256</td><td><code>${sizes.sha256.bookmark}</code></td></tr></table>
<p class="mu">Scope: calls made through this frame's fetch/XMLHttpRequest after launch. Workers, other frames, references the page captured earlier, and navigation are not covered. Browser CORS/CSP policies stay in force.</p></div>
</main><script>
document.getElementById('copy').addEventListener('click',function(){var o=document.getElementById('copied');
navigator.clipboard.writeText(document.getElementById('text').value).then(function(){o.textContent='Copied to clipboard. Paste it as the bookmark URL; copying does not install it.'},function(){o.textContent='Clipboard refused. Select the text above and copy it manually.'})});
</script></body></html>
`;

await mkdir('dist', { recursive: true });
await Promise.all([
  writeFile('dist/aw.js', js),
  writeFile('dist/aw.min.js', min),
  writeFile('dist/bookmark.txt', bookmark),
  writeFile('dist/install.html', install),
  writeFile('dist/sizes.json', JSON.stringify(sizes, null, 2) + '\n'),
]);
console.log(`API Workbench ${version}: readable ${sizes.readableBytes} B · minified ${sizes.minifiedBytes} B · bookmark ${sizes.bookmarkChars} chars`);
