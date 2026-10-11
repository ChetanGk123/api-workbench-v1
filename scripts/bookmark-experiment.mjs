// G02 saved-bookmark experiment in real Chrome. For each size, in its own throwaway profile: save the
// URL through Chrome's own bookmark model (chrome://bookmarks), restart the browser, read it back
// byte-for-byte, reopen the bookmark manager, then run the saved URL on the fixture page via a
// browser-initiated navigation (the path a bookmark click takes). The fixture must be running.
// Size 0 is the generated bookmark; the rest are padded copies (encoded trailing comment) of it.
// Not covered: dragging/clicking in the bookmarks-bar UI itself. Edge: AW_BROWSER=msedge.
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const channel = process.env.AW_BROWSER ?? 'chrome';
const A = `http://127.0.0.1:${process.env.AW_PORT ?? 4310}`;
const out = process.argv[2];
const real = readFileSync('dist/bookmark.txt', 'utf8');
const { version } = JSON.parse(readFileSync('dist/sizes.json', 'utf8'));
const sha = (s) => createHash('sha256').update(s).digest('hex');
const pad = (n) => real + encodeURIComponent('/*' + 'x'.repeat(Math.max(0, n - real.length - 13)) + '*/');
const sizes = (process.env.AW_SIZES ?? `${real.length},${512 * 1024},${1024 * 1024},${1536 * 1024},${2 * 1024 * 1024 - 64},${2 * 1024 * 1024 + 64}`).split(',').map(Number);
const err = (e) => String(e?.message ?? e).split('\n')[0];

async function manager(ctx, fn, arg) {
  const p = await ctx.newPage();
  try {
    await p.goto('chrome://bookmarks');
    return await p.evaluate(fn, arg);
  } catch (e) {
    return { crashed: err(e) };
  } finally {
    await p.close().catch(() => {});
  }
}

async function run(n) {
  const url = n === real.length ? real : pad(n);
  const c = { chars: url.length, sha256: sha(url) };
  const dir = mkdtempSync(join(tmpdir(), 'aw-bookmarks-'));
  const open = () => chromium.launchPersistentContext(dir, { channel, headless: false });
  try {
    let ctx = await open();
    c.browserVersion = ctx.browser()?.version();
    c.saved = await manager(ctx, (url) => chrome.bookmarks.create({ parentId: '1', title: 'API Workbench', url })
      .then((b) => ({ ok: true, chars: b.url.length }), (e) => ({ ok: false, error: String(e?.message ?? e) })), url);
    await ctx.close();

    ctx = await open(); // restart
    const back = await manager(ctx, () => chrome.bookmarks.getChildren('1').then((l) => l.map((b) => b.url)));
    const saved = Array.isArray(back) ? back[0] : undefined;
    c.afterRestart = Array.isArray(back) ? (saved ? { present: true, chars: saved.length, exact: sha(saved) === c.sha256 } : { present: false }) : back;
    if (saved) {
      const page = await ctx.newPage();
      await page.goto(`${A}/fixture`);
      const t0 = Date.now();
      try {
        await (await ctx.newCDPSession(page)).send('Page.navigate', { url: saved });
        const panel = page.locator('[data-api-workbench]');
        await panel.waitFor({ timeout: 15000 });
        c.launch = { ok: true, ms: Date.now() - t0, stayedOnFixture: page.url() === `${A}/fixture`, showsVersion: await panel.getByText(version).first().isVisible() };
      } catch (e) {
        c.launch = { ok: false, error: err(e) };
      }
    }
    await ctx.close();
  } catch (e) {
    c.error = err(e);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.error(JSON.stringify(c));
  return c;
}

const result = { browser: channel, version, bookmarkChars: real.length, bookmarkSha256: sha(real), method: 'chrome.bookmarks.create on chrome://bookmarks; restart; CDP Page.navigate on /fixture', cases: [] };
for (const n of sizes) result.cases.push(await run(n));
const text = JSON.stringify(result, null, 2);
if (out) writeFileSync(out, text + '\n');
else console.log(text);
