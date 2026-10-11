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
const manifest = { schema: 1, version, bookmarkChars: sizes.bookmarkChars, bookmarkSha256: sizes.sha256.bookmark, minifiedSha256: sizes.sha256.minified, builtAt: sizes.builtAt };

// Public guide + installer (S01.1): self-contained, system fonts, no external assets. Facts come from this build.
const install = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install API Workbench ${esc(version)}</title>
<meta name="description" content="Test, mock, intercept, route and stress your application's API traffic with one browser-local bookmark.">
<style>
:root{color-scheme:dark;--bg:#09090b;--card:#111113;--inset:#0c0c0e;--surface:#18181b;--border:#27272a;--strong:#3f3f46;--text:#fafafa;--soft:#d4d4d8;--muted:#a1a1aa}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.65 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}p{margin:0;color:var(--muted)}h1,h2,h3{margin:0;line-height:1.2;letter-spacing:-.03em}h1{font-size:64px;font-weight:650;letter-spacing:-.055em;line-height:1.04}h2{font-size:36px;font-weight:600;letter-spacing:-.04em}h3{font-size:17px;font-weight:600;letter-spacing:-.01em}
.wrap{max-width:1200px;margin:0 auto;padding:0 32px}.header{border-bottom:1px solid var(--border)}.header-inner{min-height:80px;display:flex;align-items:center;gap:28px}
.brand{display:inline-flex;align-items:center;gap:12px;text-decoration:none;font-size:15px;font-weight:600;letter-spacing:-.02em}.logo{display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;background:var(--text);color:var(--bg);flex-shrink:0}.logo .icon{width:16px;height:16px}
.icon{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}.nav{display:flex;gap:28px;margin-left:auto;font-size:13px;color:var(--muted)}.nav a{text-decoration:none}.nav a:hover,.footer a:hover{color:var(--text)}
.skip{position:absolute;left:-9999px}.skip:focus{left:16px;top:12px;z-index:10;background:var(--text);color:var(--surface);padding:8px 12px;border-radius:6px}
:focus-visible{outline:2px solid var(--muted);outline-offset:4px}section[id],aside[id]{scroll-margin-top:24px}
.hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:48px;align-items:center;padding:96px 0 48px}.eyebrow{font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-bottom:24px;display:block}
.hero h1 span{color:var(--muted)}.intro{font-size:16px;line-height:1.8;margin:24px 0;max-width:460px}.traits{display:flex;gap:32px;flex-wrap:wrap;padding:24px 0 48px;border-top:1px solid var(--border);border-bottom:1px solid var(--border);font-size:12px;color:var(--muted)}.traits span{display:flex;align-items:center;gap:6px}.traits .icon{width:14px;height:14px;color:var(--soft)}
.badge{display:inline-flex;border:1px solid var(--border);border-radius:6px;padding:4px 8px;color:var(--muted);font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;min-width:0}.actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center}.bm{display:inline-flex;align-items:center;justify-content:center;gap:10px;padding:12px 16px;border-radius:8px;background:var(--text);color:var(--surface);font-size:13px;font-weight:600;text-decoration:none;cursor:grab}.bm:hover{background:var(--soft)}.bm:active{cursor:grabbing}.drag-hint{font-size:12px;margin-top:12px}.drag-hint a{text-underline-offset:4px}
figure{margin:0;min-width:0}.art{width:100%;height:auto;display:block;border-radius:12px}figcaption{margin-top:16px;font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}.install-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:48px;align-items:start}.install-layout h2{margin-bottom:16px}.install-layout .art{margin-top:32px}.install-layout>div>p{max-width:480px}
.steps{list-style:none;padding:0;margin:0;display:grid;gap:16px;counter-reset:step}.steps li{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--border);border-radius:10px;background:var(--card);padding:20px;color:var(--muted);font-size:13px}.steps li:before{counter-increment:step;content:counter(step);display:grid;place-items:center;width:24px;height:24px;border:1px solid var(--strong);border-radius:6px;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;flex-shrink:0}.steps strong{display:block;font-size:14px;font-weight:500;color:var(--soft);margin-bottom:4px}
kbd{font:10px ui-monospace,SFMono-Regular,Menlo,monospace;padding:2px 4px;border:1px solid var(--strong);border-radius:4px;color:var(--soft);white-space:nowrap}details{border-bottom:1px solid var(--border);padding:16px 0}summary{cursor:pointer;font-size:13px;font-weight:500;color:var(--soft)}details p{margin-top:12px;font-size:13px}.manual{border-bottom:0;margin-top:16px;padding-bottom:0}.manual label{display:block;font-size:12px;color:var(--muted);margin:16px 0 8px}
textarea{display:block;width:100%;height:100px;resize:vertical;padding:12px;background:var(--inset);color:var(--soft);border:1px solid var(--border);border-radius:6px;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}button{display:inline-flex;align-items:center;justify-content:center;gap:8px;font:inherit;font-size:13px;font-weight:500;padding:12px 16px;border-radius:8px;border:1px solid var(--strong);background:var(--surface);color:var(--text);cursor:pointer}button:hover{background:var(--border)}.copy-row{margin-top:12px}.copy-row .icon{width:14px;height:14px}.copy-status{display:block;font-size:12px;margin-top:8px;color:var(--muted)}.copy-status:empty{display:none}
.release-note{display:flex;align-items:flex-start;gap:12px;padding:16px 20px;margin-bottom:32px;border:1px solid var(--border);border-radius:8px;font-size:12px}.release-note .icon{width:16px;height:16px;margin-top:2px;color:var(--muted)}.release-note strong{color:var(--soft);font-weight:500}
.section{padding:80px 0;border-bottom:1px solid var(--border)}.section-head{display:flex;align-items:flex-end;justify-content:space-between;gap:48px;margin-bottom:32px}.section-head p{font-size:14px;max-width:380px}.section-head .eyebrow{margin-bottom:16px}
.modules{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.module{padding:24px;border:1px solid var(--border);border-radius:10px;background:var(--card)}.module-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;color:var(--soft)}.module-top span{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}.module p{font-size:13px;margin-top:12px}.module .tag{display:block;margin-top:20px;font:10px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.workflow{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:32px;list-style:none;padding:0;margin:32px 0 0;counter-reset:journey}.workflow li:before{counter-increment:journey;content:'0' counter(journey);display:block;margin-bottom:20px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}.workflow p{font-size:13px;margin-top:12px}.session-end{margin-top:32px;padding-top:20px;border-top:1px solid var(--border);font-size:12px}
.experiment{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:32px;margin-top:64px}.experiment .section-head h2{font-size:32px}.flow{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr) auto minmax(0,1fr);gap:16px;align-items:center}.flow-box{padding:24px;border:1px solid var(--strong);border-radius:8px;background:var(--bg);min-width:0}.flow-box code{display:block;color:var(--muted);font-size:10px;margin-bottom:16px;letter-spacing:.04em}.flow-box strong{font-size:15px}.flow-box p{font-size:12px;margin-top:8px}.flow-arrow{color:var(--muted)}
.help{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:64px;padding:64px 0}.help h2{font-size:24px;margin-bottom:16px}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;overflow-wrap:anywhere;color:var(--soft)}
.build-card{align-self:start;border:1px solid var(--border);background:var(--card);border-radius:10px;padding:24px}.build-card h2{font-size:16px;margin-bottom:8px}.build-card>p{font-size:12px;margin-bottom:24px}.build-stats{display:grid;grid-template-columns:1fr 1fr;gap:20px;padding-bottom:20px;border-bottom:1px solid var(--border);margin:0 0 20px}.build-stats dt{font-size:11px;color:var(--muted)}.build-stats dd{margin:4px 0 0;font:20px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-.04em}.build-stats dd span{font-size:11px;color:var(--muted);letter-spacing:0}
.build-meta{display:grid;gap:16px;margin:0}.build-meta dt{font-size:11px;color:var(--muted)}.build-meta dd{margin:4px 0 0;font-size:12px;color:var(--soft);overflow-wrap:anywhere}.footer{border-top:1px solid var(--border)}.footer-inner{display:flex;justify-content:space-between;align-items:center;gap:20px;padding-top:24px;padding-bottom:32px;font-size:12px;color:var(--muted)}.footer .brand{font-size:12px;color:var(--soft)}.footer .icon{width:16px;height:16px}
@media(max-width:960px){.hero{gap:32px;grid-template-columns:1fr;padding-top:64px}.hero figure{max-width:680px}h1{font-size:56px}.install-layout{grid-template-columns:1fr;gap:32px}.help{gap:32px}.modules{grid-template-columns:repeat(2,minmax(0,1fr))}.flow{gap:12px}.flow-box{padding:20px}}
@media(max-width:720px){.wrap{padding-left:20px;padding-right:20px}.header-inner{min-height:72px;gap:16px}.header-inner>.badge{display:none}.nav{gap:16px}.nav a:first-child{display:none}.hero{gap:36px;padding:48px 0 32px}h1{font-size:44px}.intro{max-width:520px}.eyebrow{margin-bottom:20px}.traits{gap:16px;padding-bottom:32px}.section{padding:48px 0}.section-head{display:block}.section-head p{margin-top:16px}.workflow{grid-template-columns:1fr;gap:28px}.workflow li:before{margin-bottom:12px}.experiment{padding:24px;margin-top:48px}.experiment .section-head h2{font-size:28px}.flow{grid-template-columns:1fr;gap:12px}.flow-arrow{text-align:center;transform:rotate(90deg)}.help{grid-template-columns:1fr;gap:36px;padding:48px 0}.footer-inner{align-items:flex-start;flex-direction:column;gap:12px}}
@media(max-width:440px){h1{font-size:40px}.modules{grid-template-columns:1fr}.release-note{padding:16px}.section-head h2{font-size:28px}.build-stats dd{font-size:18px}}
</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true" style="position:absolute"><defs>
<symbol id="bolt" viewBox="0 0 24 24"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></symbol>
<symbol id="check" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></symbol>
<symbol id="info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-9h.01"/></symbol>
<symbol id="bookmark-icon" viewBox="0 0 24 24"><path d="M6 20V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v15l-6-4z"/></symbol>
<symbol id="copy-icon" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></symbol>
<symbol id="flask" viewBox="0 0 24 24"><path d="M9 3h6M10 3v7L5 19a1 1 0 0 0 1 2h12a1 1 0 0 0 1-2l-5-9V3M8 15h8"/></symbol>
<symbol id="server" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/></symbol>
<symbol id="intercept" viewBox="0 0 24 24"><path d="m18 2 4 4-4 4m0 4 4 4-4 4M2 18h2l10-12h8M2 6h2l3 3m6 6 3 3h6"/></symbol>
<symbol id="route" viewBox="0 0 24 24"><circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/></symbol>
<symbol id="flame" viewBox="0 0 24 24"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></symbol>
<symbol id="import-icon" viewBox="0 0 24 24"><path d="M12 3v12m-5-5 5 5 5-5M3 15v5h18v-5"/></symbol>
</defs></svg>
<a class="skip" href="#install">Skip to installation</a>
<header class="header"><div class="wrap header-inner">
<a class="brand" href="#top"><span class="logo"><svg class="icon" aria-hidden="true"><use href="#bolt"/></svg></span>API Workbench</a>
<nav class="nav" aria-label="Page sections"><a href="#modules">Features</a><a href="#workflow">Guide</a><a href="#install">Install ↗</a></nav><span class="badge">${esc(version)}</span>
</div></header>
<main class="wrap" id="top">
<section class="hero" aria-labelledby="hero-title">
<div><div class="eyebrow">API testing, where your app runs</div>
<h1 id="hero-title">A complete<br>API toolkit.<br><span>In one bookmark.</span></h1>
<p class="intro">Give your app the response you need. Try the timeout, empty state, or error you want to understand. Test and shape API traffic right inside its tab.</p>
<div class="actions"><a class="bm" id="bookmark" href="${esc(bookmark)}" draggable="true" title="Drag to your bookmarks bar" aria-label="API Workbench ${esc(version)}"><svg class="icon" aria-hidden="true"><use href="#bookmark-icon"/></svg>API Workbench</a><button type="button" id="copy" data-copy="copied"><svg class="icon" aria-hidden="true"><use href="#copy-icon"/></svg>Copy bookmark text</button></div>
<p class="drag-hint">Drag to your bookmarks bar. <a href="#install">See the setup steps ↗</a></p><span id="copied" class="copy-status" role="status"></span>
</div>
<figure>
<svg class="art" viewBox="0 0 640 420" role="img" aria-label="Illustration of Workbench over an application, with an active mock returning an empty task list">
<rect x="1" y="1" width="638" height="418" rx="14" fill="var(--inset)" stroke="var(--border)"/>
<g fill="var(--strong)"><circle cx="24" cy="24" r="4"/><circle cx="40" cy="24" r="4"/><circle cx="56" cy="24" r="4"/></g>
<rect x="80" y="15" width="440" height="18" rx="6" fill="var(--surface)"/><text x="94" y="28" fill="var(--muted)" font-family="ui-monospace,monospace" font-size="10">app.example.com/tasks</text>
<g fill="var(--border)" opacity=".6"><rect x="24" y="72" width="128" height="16" rx="4"/><rect x="24" y="104" width="168" height="8" rx="4"/><rect x="24" y="124" width="144" height="8" rx="4"/><rect x="24" y="166" width="168" height="76" rx="6"/><rect x="24" y="256" width="168" height="76" rx="6"/></g>
<rect x="220" y="52" width="400" height="346" rx="12" fill="var(--bg)" stroke="var(--strong)"/>
<rect x="236" y="68" width="22" height="22" rx="6" fill="var(--text)"/><use href="#bolt" x="239" y="71" width="16" height="16" fill="none" stroke="var(--bg)" stroke-width="1.8"/>
<g font-family="system-ui,sans-serif"><text x="268" y="84" fill="var(--text)" font-size="13" font-weight="600">API Workbench</text><rect x="530" y="71" width="74" height="18" rx="5" fill="var(--surface)" stroke="var(--border)"/><text x="544" y="84" fill="var(--muted)" font-size="10">Default</text></g>
<path d="M220 102h400" stroke="var(--border)"/><rect x="236" y="114" width="368" height="30" rx="7" fill="var(--surface)" stroke="var(--border)"/><rect x="358" y="118" width="58" height="22" rx="5" fill="var(--bg)" stroke="var(--strong)"/>
<g font-family="system-ui,sans-serif" font-size="10" fill="var(--muted)" text-anchor="middle"><text x="268" y="133">Home</text><text x="328" y="133">Test</text><text x="387" y="133" fill="var(--text)">Mock</text><text x="448" y="133">Intercept</text><text x="508" y="133">Route</text><text x="568" y="133">Chaos</text></g>
<rect x="236" y="158" width="368" height="90" rx="9" fill="var(--card)" stroke="var(--border)"/><circle cx="254" cy="180" r="4" fill="#4ade80"/>
<g font-family="system-ui,sans-serif"><text x="268" y="184" fill="var(--text)" font-size="12" font-weight="600">Mock Server</text><rect x="542" y="170" width="46" height="19" rx="5" fill="var(--bg)" stroke="var(--strong)"/><text x="552" y="183" fill="var(--soft)" font-size="10">Active</text><text x="252" y="211" fill="var(--muted)" font-size="11">1 enabled rule · 14 matched calls</text><rect x="252" y="224" width="84" height="14" rx="4" fill="var(--border)"/><text x="263" y="234" fill="var(--soft)" font-size="8">Manage rules</text></g>
<rect x="236" y="260" width="368" height="96" rx="9" fill="var(--card)" stroke="var(--border)"/><text x="252" y="284" fill="var(--muted)" font-family="system-ui,sans-serif" font-size="11">Matched traffic</text>
<g font-family="ui-monospace,monospace" font-size="10"><text x="252" y="309" fill="#4ade80">GET</text><text x="284" y="309" fill="var(--soft)">/api/tasks</text><text x="588" y="309" text-anchor="end" fill="var(--muted)">200 · mocked</text><text x="252" y="338" fill="var(--soft)">{"tasks":[]}</text></g>
<circle cx="252" cy="377" r="3" fill="var(--muted)"/><text x="264" y="381" fill="var(--muted)" font-family="system-ui,sans-serif" font-size="10">Example scenario · local response</text>
</svg><figcaption>01 / Product illustration · example configuration and traffic</figcaption>
</figure>
</section>
<div class="traits"><span><svg class="icon" aria-hidden="true"><use href="#check"/></svg>No extension</span><span><svg class="icon" aria-hidden="true"><use href="#check"/></svg>Full-inline bookmark</span><span><svg class="icon" aria-hidden="true"><use href="#check"/></svg>Runs in your app's tab</span><span><svg class="icon" aria-hidden="true"><use href="#check"/></svg>No product backend or telemetry</span></div>

<section class="section" id="modules" aria-labelledby="modules-title">
<div class="section-head"><div><div class="eyebrow">Explore the what-ifs</div><h2 id="modules-title">A tool for every<br>response you need.</h2></div><p>Check a happy path, introduce a fault, or fill in a missing backend. Choose the module that fits your next experiment.</p></div>
<div class="modules">
<article class="module"><div class="module-top"><svg class="icon" aria-hidden="true"><use href="#flask"/></svg><span>01</span></div><h3>Test</h3><p>Send an endpoint once or run repeatable plans with setup, iterations, concurrency, and response checks.</p><span class="tag">Requests → results</span></article>
<article class="module"><div class="module-top"><svg class="icon" aria-hidden="true"><use href="#server"/></svg><span>02</span></div><h3>Mock</h3><p>Return a static response or a sequence of replies for matching calls, without sending them to the server.</p><span class="tag">Your response, on demand</span></article>
<article class="module"><div class="module-top"><svg class="icon" aria-hidden="true"><use href="#intercept"/></svg><span>03</span></div><h3>Intercept</h3><p>Edit headers, bodies, and status codes. Pause requests or responses at breakpoints to inspect and change them.</p><span class="tag">Pause. Inspect. Continue.</span></article>
<article class="module"><div class="module-top"><svg class="icon" aria-hidden="true"><use href="#route"/></svg><span>04</span></div><h3>Route</h3><p>Point matching calls at another origin or path. Cross-origin Authorization is dropped unless explicitly allowed.</p><span class="tag">A different destination</span></article>
<article class="module"><div class="module-top"><svg class="icon" aria-hidden="true"><use href="#flame"/></svg><span>05</span></div><h3>Chaos</h3><p>Try latency, HTTP errors, network faults, timeouts, corruption, and bounded replay with probability and budgets.</p><span class="tag">Find the failure paths</span></article>
<article class="module"><div class="module-top"><svg class="icon" aria-hidden="true"><use href="#import-icon"/></svg><span>06</span></div><h3>Import &amp; record</h3><p>Bring in saved requests or capture this frame's future calls. Review everything before saving it as endpoints.</p><span class="tag">Start with real requests</span></article>
</div>
</section>

<section class="section install-layout" id="install" tabindex="-1" aria-labelledby="install-title">
<div><div class="eyebrow">A place on your bookmarks bar</div><h2 id="install-title">Save a bookmark.<br>Open a workbench.</h2><p>The complete tool travels with the bookmark. Save it once, then open it on the application you're testing.</p>
<figure><svg class="art" viewBox="0 0 640 200" role="img" aria-label="Illustration of dragging the API Workbench button to a browser bookmarks bar">
<rect x="1" y="1" width="638" height="198" rx="12" fill="var(--inset)" stroke="var(--border)"/><rect x="24" y="24" width="592" height="32" rx="7" fill="var(--surface)" stroke="var(--border)"/>
<g font-family="system-ui,sans-serif" font-size="11" fill="var(--muted)"><text x="44" y="45">Docs</text><text x="132" y="45">Staging</text><text x="232" y="45">Dashboard</text></g><path d="M360 32v16" stroke="var(--text)" stroke-width="2"/>
<rect x="300" y="112" width="176" height="36" rx="8" fill="var(--text)"/><use href="#bolt" x="312" y="121" width="18" height="18" fill="none" stroke="var(--bg)" stroke-width="1.8"/><text x="338" y="135" fill="var(--bg)" font-family="system-ui,sans-serif" font-size="12" font-weight="600">API Workbench</text>
<path d="M388 106Q366 80 360 62" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="4 5"/><path d="m354 68 6-8 6 8" fill="none" stroke="var(--muted)" stroke-width="1.5"/><text x="494" y="135" fill="var(--muted)" font-family="system-ui,sans-serif" font-size="11">drag it here ↑</text>
</svg></figure>
<details class="manual" id="manual"><summary>Prefer to install manually?</summary>
<p>Create a bookmark, edit its URL, and paste the complete text below. Keep the <code>javascript:</code> prefix.</p>
<label for="text">Complete bookmark text · ${sizes.bookmarkChars.toLocaleString('en')} characters</label>
<textarea id="text" readonly spellcheck="false">${esc(bookmark)}</textarea>
<div class="copy-row"><button type="button" id="copy-manual" data-copy="copied-manual"><svg class="icon" aria-hidden="true"><use href="#copy-icon"/></svg>Copy bookmark text</button><span id="copied-manual" class="copy-status" role="status"></span></div>
</details></div>
<ol class="steps">
<li><div><strong>Show your bookmarks bar</strong><kbd>Ctrl + Shift + B</kbd> or <kbd>⌘ + Shift + B</kbd> on macOS.</div></li>
<li><div><strong>Drag the Workbench button onto the bar</strong>Use the button at the top of this page. Clicking it here runs it on this page; it does not install it.</div></li>
<li><div><strong>Open your app. Click the bookmark.</strong>Sign in as usual, then launch Workbench. Click again to restore the same panel. After a reload, launch it again.</div></li>
</ol>
</section>

<section class="experiment" aria-labelledby="experiment-title">
<div class="section-head"><div><div class="eyebrow">Try an empty state</div><h2 id="experiment-title">One request.<br>A different experience.</h2></div><p>Create an enabled mock for GET <code>/api/tasks</code> with body <code>{"tasks":[]}</code>, activate Mock, then reload the task list in your app.</p></div>
<figure aria-label="Example: a task-list request is matched by a local mock, and the application displays its empty state"><div class="flow">
<div class="flow-box"><code>01 / APP REQUEST</code><strong>GET /api/tasks</strong><p>The application asks for its tasks.</p></div><span class="flow-arrow" aria-hidden="true">→</span>
<div class="flow-box"><code>02 / LOCAL MOCK</code><strong>200 · {"tasks":[]}</strong><p>Workbench supplies the response.</p></div><span class="flow-arrow" aria-hidden="true">→</span>
<div class="flow-box"><code>03 / EMPTY STATE</code><strong>“No tasks yet”</strong><p>Inspect the app's empty-list view.</p></div>
</div><figcaption>02 / Illustrative example · adapt the response to your API. Deactivate Mock to restore real responses.</figcaption></figure>
</section>

<section class="section" id="workflow" aria-labelledby="workflow-title">
<div class="section-head"><div><div class="eyebrow">A guide to your first session</div><h2 id="workflow-title">Capture. Test. Change.</h2></div><p>Modules start inactive.<br>You choose when rules affect traffic.</p></div>
<ol class="workflow">
<li><h3>Bring a request in</h3><p>Import, record a page action, or create an endpoint. Review and save it, then fill in any unresolved inputs before sending.</p></li>
<li><h3>Send it. See what happened.</h3><p>Test → Once previews the prepared request and shows the response, headers, and checks. Build a plan when you need to repeat it.</p></li>
<li><h3>Make the app handle your scenario</h3><p>Derive a rule and activate its module. Repeat the page action; request details explain what applied, what was skipped, and why.</p></li>
</ol>
<p class="session-end">Before you leave: export your profile (secrets are redacted by default), Stop all, then Close to remove Workbench's hooks.</p>
</section>

<div class="help">
<section id="faq" aria-labelledby="faq-title"><div class="eyebrow">Good to know</div><h2 id="faq-title">A few practical details.</h2>
<details><summary>Which requests does it cover?</summary><p>Calls through this frame's <code>fetch</code> and <code>XMLHttpRequest</code> after launch. Workers, other frames, previously saved API references, navigation, beacons, sockets, and event streams are outside that scope.</p><p>CORS, cookies, and Content-Security-Policy stay in force. A strict policy may block the bookmark or tester requests.</p></details>
<details><summary>What can I import?</summary><p>HAR 1.2, Swagger 2.0 JSON, OpenAPI 3.0 JSON, Postman collection v2.1, Chrome DevTools cURL (bash and cmd) and fetch copies, plus native profiles and backups.</p><p>Imports are data: scripts and shell commands never execute. YAML, OpenAPI 3.1, Postman v1, and environment files are not imported.</p></details>
<details><summary>Where does my data live?</summary><p>In the browser storage of the site you test, readable by that site's scripts. It is not a secret vault. Current tokens, signing keys, and signatures are never saved. The complete tool runs from the bookmark without downloading code.</p></details>
<details><summary>Update to a newer build</summary><p>${updateUrl ? `In the panel, open Settings → About → <em>Check for update</em>. It reads <code>update.json</code> and <code>bookmark.txt</code> from <code>${esc(updateUrl)}</code> only when you click, verifies the SHA-256, and lets you copy the new text. Then edit your saved bookmark, replace its URL with the copied text, reload the page and click it.` : 'This build has no update address. Come back to the installer page, copy the newer bookmark text, and replace your saved bookmark\'s URL with it.'} Copying never installs anything by itself.</p></details>
<details><summary>Remove the hooks or the tool</summary><p>Close in the panel (or reloading the page) removes the hooks. Settings → Clear local data deletes this tool's data for the current site only. Deleting the bookmark uninstalls it.</p></details>
<details><summary>Go back to an earlier build</summary><p>Reinstall the earlier bookmark text. Data written by a newer build is not converted back automatically; export a profile first if you need it in both.</p></details>
<details><summary>Coming from API Workbench 1.x</summary><p>Close the 1.x panel and reload before launching this version; two layers never run together. Import → <em>Look for schema 1 data</em> previews the old data and converts it only after you confirm; the old database is left untouched.</p></details>
</section>
<aside class="build-card" aria-labelledby="build-title"><h2 id="build-title">Inside this build</h2><p>Full-inline delivery. Measured from this artifact.</p>
<dl class="build-stats"><div><dt>Minified bundle</dt><dd>${(sizes.minifiedBytes / 1024).toFixed(1)} <span>KiB</span></dd></div><div><dt>Bookmark URL</dt><dd>${sizes.bookmarkChars.toLocaleString('en')} <span>chars</span></dd></div></dl>
<dl class="build-meta">
<div><dt>Version</dt><dd>${esc(version)}</dd></div>
<div><dt>Built (UTC)</dt><dd><time datetime="${esc(sizes.builtAt)}">${esc(sizes.builtAt)}</time></dd></div>
<div><dt>Minified bytes</dt><dd>${sizes.minifiedBytes.toLocaleString('en')}</dd></div>
<div><dt>Bookmark SHA-256</dt><dd><code>${sizes.sha256.bookmark}</code></dd></div>
<div><dt>Update address</dt><dd>${updateUrl ? `<code>${esc(updateUrl)}</code>` : 'Not configured · update manually'}</dd></div>
</dl></aside>
</div>
<div class="release-note"><svg class="icon" aria-hidden="true"><use href="#info"/></svg><p><strong>Pre-release verification.</strong> Chrome is covered by automated tests. Edge, bookmarks-bar dragging, and screen readers remain unverified for this build.</p></div>
</main>
<footer class="footer"><div class="wrap footer-inner"><span class="brand"><svg class="icon" aria-hidden="true"><use href="#bolt"/></svg>API Workbench</span><span>One bookmark. Your browser. <a href="#install">Back to installation ↑</a></span></div></footer>
<script>
document.querySelectorAll('[data-copy]').forEach(function(button){button.addEventListener('click',function(){var o=document.getElementById(button.dataset.copy);
Promise.resolve().then(function(){return navigator.clipboard.writeText(document.getElementById('text').value)}).then(function(){o.textContent='Copied. Paste it as the bookmark URL; copying does not install it.'},function(){document.getElementById('manual').open=true;o.textContent='Clipboard refused. Copy the complete text in the manual installation section.'})});
});
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
