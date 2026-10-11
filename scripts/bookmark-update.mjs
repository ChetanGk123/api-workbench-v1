// G24 saved-bookmark update cycle in real Chrome (or AW_BROWSER=msedge). In a throwaway profile:
// save an older candidate through Chrome's own bookmark model, restart, launch it from the saved URL on
// the fixture, Settings → About → Check for update → Copy new bookmarklet (real clipboard), replace the
// saved bookmark's URL with the clipboard text, restart, launch again, and read the running version.
// The fixture must be running (npm run fixture). Not covered: the Edit-bookmark dialog UI itself.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const channel = process.env.AW_BROWSER ?? 'chrome';
const A = `http://127.0.0.1:${process.env.AW_PORT ?? 4310}`;
const B = `http://127.0.0.1:${process.env.AW_OTHER_PORT ?? 4311}`;
const out = process.argv[2];
const sha = (s) => createHash('sha256').update(s).digest('hex');
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const newer = `${version}.1`;

const build = (dir, v) => {
  execFileSync('node', ['scripts/build.mjs'], { env: { ...process.env, AW_OUT: dir, AW_VERSION: v, AW_UPDATE_URL: `${B}/deploy/` }, stdio: 'pipe' });
  return readFileSync(`${dir}/bookmark.txt`, 'utf8');
};
const oldText = build('test-results/upd-old', version);
const newText = build('test-results/upd-new', newer);
mkdirSync('test-results/deploy', { recursive: true });
for (const f of ['update.json', 'bookmark.txt']) copyFileSync(`test-results/upd-new/${f}`, `test-results/deploy/${f}`);

const r = { browser: channel, method: 'chrome.bookmarks on chrome://bookmarks (create, update); restart; CDP Page.navigate to the saved URL on /fixture; panel UI for Check/Copy; real clipboard', old: { version, chars: oldText.length, sha256: sha(oldText) }, published: { version: newer, chars: newText.length, sha256: sha(newText) }, steps: {} };
const dir = mkdtempSync(join(tmpdir(), 'aw-update-'));
const open = () => chromium.launchPersistentContext(dir, { channel, headless: false });
const inManager = async (ctx, fn, arg) => {
  const p = await ctx.newPage();
  try { await p.goto('chrome://bookmarks'); return await p.evaluate(fn, arg); } finally { await p.close(); }
};
async function launchSaved(ctx) {
  const url = await inManager(ctx, () => chrome.bookmarks.getChildren('1').then((l) => l[0]?.url ?? null));
  const page = await ctx.newPage();
  await page.goto(`${A}/fixture`);
  await (await ctx.newCDPSession(page)).send('Page.navigate', { url });
  await page.locator('[data-api-workbench]').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  const running = await page.locator('#aw-about-version').textContent();
  return { page, url, running };
}

try {
  let ctx = await open();
  r.browserVersion = ctx.browser()?.version();
  r.steps.saved = await inManager(ctx, (url) => chrome.bookmarks.create({ parentId: '1', title: 'API Workbench', url }).then((b) => b.url.length), oldText);
  await ctx.close();

  ctx = await open(); // restart
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: A });
  let { page, url, running } = await launchSaved(ctx);
  r.steps.launchOld = { savedExact: sha(url) === r.old.sha256, running };
  const before = await (await page.request.get(`${A}/__counters`)).json();
  await page.getByRole('button', { name: 'Check for update' }).click();
  await page.locator('#aw-about').getByText(`Version ${newer} is published`).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Copy new bookmarklet' }).click();
  const outcome = await page.locator('#aw-update-outcome').textContent();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const after = await (await page.request.get(`${A}/__counters`)).json();
  r.steps.check = {
    outcome, clipboardExact: sha(clip) === r.published.sha256, stillRunning: await page.locator('#aw-about-version').textContent(),
    reads: { manifest: (after['deploy:update.json'] ?? 0) - (before['deploy:update.json'] ?? 0), bookmark: (after['deploy:bookmark.txt'] ?? 0) - (before['deploy:bookmark.txt'] ?? 0) },
  };
  // The user's manual step, through the same bookmark model the Edit dialog writes.
  r.steps.replaced = await inManager(ctx, (text) => chrome.bookmarks.getChildren('1').then((l) => chrome.bookmarks.update(l[0].id, { url: text })).then((b) => b.url.length), clip);
  await ctx.close();

  ctx = await open(); // restart, reload, relaunch from the saved bookmark
  ({ url, running } = await launchSaved(ctx));
  r.steps.launchNew = { savedExact: sha(url) === r.published.sha256, running };
  await ctx.close();
  r.pass = r.steps.launchOld.savedExact && r.steps.launchOld.running === version && r.steps.check.clipboardExact && r.steps.check.stillRunning === version
    && r.steps.check.reads.manifest === 1 && r.steps.check.reads.bookmark === 1 && r.steps.launchNew.savedExact && r.steps.launchNew.running === newer;
} catch (e) {
  r.error = String(e?.message ?? e).split('\n')[0];
  r.pass = false;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const text = JSON.stringify(r, null, 2);
if (out) writeFileSync(out, text + '\n');
console.log(text);
process.exit(r.pass ? 0 : 1);
