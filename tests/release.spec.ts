// R8 cases in real Chrome: settings that change resources (G23), the data-only update check against a
// stand-in deployment (G24), and the new-user journey (G26). Launch = evaluating the decoded generated
// bookmark (injection; NOT saved-bookmark evidence — see scripts/bookmark-update.mjs for that path).
import { chromium, expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activate, addMock, panel, tab } from './rule-helpers';
import { defaultProfile } from '../src/data/schema';

const A = `http://127.0.0.1:${process.env.AW_PORT ?? 4310}`;
const B = `http://127.0.0.1:${process.env.AW_OTHER_PORT ?? 4311}`;
const decode = (bm: string) => decodeURIComponent(bm.slice('javascript:'.length));
const source = decode(readFileSync('dist/bookmark.txt', 'utf8'));
const { version } = JSON.parse(readFileSync('dist/sizes.json', 'utf8')) as { version: string };

const button = (page: Page, name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' });
const openRecord = async (page: Page) => { await tab(page, 'Home'); await button(page, 'Record').first().click(); };
const counters = async (page: Page): Promise<Record<string, number>> => (await page.request.get(`${A}/__counters`)).json();
const send = (page: Page, o: object) => page.evaluate((x) => (window as any).fx.send(x), o) as Promise<Record<string, any>>;
const settings = (page: Page) => page.getByRole('button', { name: 'Settings', exact: true }).first().click();
const saved = (page: Page) => expect(page.locator('#aw-store-state')).toHaveText('All changes saved');

async function launch(page: Page, src = source) {
  await page.evaluate(src);
  await settings(page);
  await expect(page.locator('#aw-store-state')).toHaveText(/All changes saved|Storage unavailable/);
}
async function fresh(page: Page) {
  await page.goto(`${A}/fixture`);
  await page.evaluate(() => Promise.all(['api-workbench-v2', 'api-workbench'].map((n) => new Promise((r) => { const q = indexedDB.deleteDatabase(n); q.onsuccess = q.onerror = q.onblocked = r; }))));
  await page.evaluate(() => localStorage.clear());
  await page.waitForFunction(() => (window as any).fx);
}
async function setLimits(page: Page, f: Record<string, string>) {
  await settings(page);
  for (const [id, v] of Object.entries(f)) await page.locator(`#${id}`).fill(v);
  await button(page, 'Save limits').click();
  await saved(page);
}

test.beforeEach(async ({ page }) => {
  await page.request.get(`${A}/__reset`);
  await fresh(page);
});

test('installer: exact artifact, responsive layout, keyboard navigation and manual copy', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(`${A}/install`);
  expect(await page.locator('#bookmark').getAttribute('href')).toBe(readFileSync('dist/bookmark.txt', 'utf8'));
  await expect(page.locator('#bookmark')).toHaveAttribute('draggable', 'true');
  await expect(page.locator('#text')).toHaveValue(readFileSync('dist/bookmark.txt', 'utf8'));
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to installation' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#install')).toBeFocused();
  await expect(page.locator('#text')).toBeHidden();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).__copiedBookmark = text; } } });
  });
  await page.locator('#copy').click();
  await expect(page.locator('#copied')).toHaveText('Copied. Paste it as the bookmark URL; copying does not install it.');
  expect(await page.evaluate(() => (window as any).__copiedBookmark)).toBe(readFileSync('dist/bookmark.txt', 'utf8'));
  await page.getByText('Prefer to install manually?', { exact: true }).click();
  await expect(page.locator('#text')).toBeVisible();
  await page.locator('#copy-manual').click();
  await expect(page.locator('#copied-manual')).toHaveText('Copied. Paste it as the bookmark URL; copying does not install it.');
  await page.locator('#manual > summary').click();
  await page.getByText('Update to a newer build', { exact: true }).click();
  await expect(page.getByText('This build has no update address.', { exact: false })).toBeVisible();
  for (const width of [1440, 1280, 960, 768, 720, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: undefined }); });
  await page.locator('#copy').click();
  await expect(page.locator('#copied')).toHaveText('Clipboard refused. Copy the complete text in the manual installation section.');
  await expect(page.locator('#text')).toBeVisible();
  await page.locator('#copy-manual').click();
  await expect(page.locator('#copied-manual')).toHaveText('Clipboard refused. Copy the complete text in the manual installation section.');
  expect(requests).toEqual([`${A}/install`]);
  await page.locator('#manual > summary').click();
  await page.getByText('Update to a newer build', { exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.screenshot({ path: 'test-results/installer-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.screenshot({ path: 'test-results/installer-desktop.png', fullPage: true });
});

test('resources: idle has no requests; same-path burst joins captures; recorder byte cap and Close remain usable', async ({ page, browser }) => {
  test.setTimeout(60_000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    return Object.fromEntries(metrics.filter((m) => ['JSHeapUsedSize', 'Nodes', 'JSEventListeners'].includes(m.name)).map((m) => [m.name, m.value]));
  };
  const burst = async () => page.evaluate(async () => {
    const start = performance.now();
    for (let batch = 0; batch < 6; batch++) await Promise.all(Array.from({ length: 10 }, (_, i) => fetch(`/api/echo?i=${batch * 10 + i}`).then((r) => r.text())));
    return performance.now() - start;
  });
  const baseline = await heap();
  const nativeMs = await burst();
  const launchRequests: string[] = [];
  const listener = (r: any) => launchRequests.push(r.url());
  page.on('request', listener);
  await launch(page);
  await page.waitForTimeout(1000); // measured idle window, not a synchronization workaround
  expect(launchRequests).toEqual([]);
  page.off('request', listener);
  await openRecord(page);
  await button(page, 'Start recording').click();
  const hookedMs = await burst();
  await expect(page.locator('#aw-rec-count')).toContainText('60 of 100 calls');
  const [har] = await Promise.all([page.waitForEvent('download'), page.locator('#aw-rec-export').click()]);
  const entries = JSON.parse(readFileSync((await har.path())!, 'utf8')).log.entries;
  expect(entries).toHaveLength(60);
  for (const e of entries) if (e.response.content.text) {
    expect(JSON.parse(e.response.content.text).query).toEqual([...new URL(e.request.url).searchParams]);
  }
  const retained = await heap();
  await button(page, 'Stop recording').click();
  await page.locator('#aw-rec-reset').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset recorder', exact: true }).click();
  await button(page, 'Start recording').click();
  for (let i = 0; i < 30; i++) await send(page, { method: 'POST', url: '/api/echo', body: '界'.repeat(10_000) });
  await expect(page.locator('#aw-rec-reason')).toContainText('Stopped at the 1 MiB draft limit');
  const [bounded] = await Promise.all([page.waitForEvent('download'), page.locator('#aw-rec-export').click()]);
  const calls = JSON.parse(readFileSync((await bounded.path())!, 'utf8')).log.entries.length;
  expect(calls).toBeGreaterThan(0);
  expect(calls).toBeLessThan(30);
  await tab(page, 'Home');
  await page.locator('#aw-filter').fill('echo');
  await expect(page.locator('#aw-filter')).toHaveValue('echo');
  await page.getByRole('button', { name: 'Close API Workbench and remove its hooks' }).first().click();
  await expect(page.locator('[data-api-workbench]')).toHaveCount(0);
  const closed = await heap();
  writeFileSync('docs/evidence/r8-resources-chrome.json', JSON.stringify({ browser: browser.version(), viewport: page.viewportSize(), baseline, retained, closed, nativeBurstMs: nativeMs, hookedBurstMs: hookedMs, burstCalls: 60, concurrency: 10, callsAtByteCap: calls, idleMs: 1000, idleRequests: launchRequests, limitation: 'One empirical forced-GC observation; not a proof of no stream-buffer leak or a long-idle benchmark.' }, null, 2) + '\n');
});

test.describe('settings change resources, not just screens (S18.2, G23)', () => {
  test('hiding an active rule module deactivates it: no tab, no card, page traffic unaffected; showing it keeps it inactive', async ({ page }) => {
    await launch(page);
    await addMock(page, { path: '/api/mock-target' });
    expect((await send(page, { url: '/api/mock-target' })).body.text).toContain('mocked');
    await settings(page);
    await page.getByRole('switch', { name: 'Show Mock' }).click();
    await saved(page);
    const nav = page.getByRole('navigation', { name: 'Modules' });
    await expect(nav.getByRole('button', { name: 'Mock', exact: true })).toBeHidden();
    const before = await counters(page);
    expect((await send(page, { url: '/api/mock-target' })).body.text).not.toContain('mocked');
    expect((await counters(page))['/api/mock-target']).toBe((before['/api/mock-target'] ?? 0) + 1);
    await tab(page, 'Home');
    await expect(page.getByRole('region', { name: 'Mock Server' })).toHaveCount(0);
    // Persisted with the profile: still hidden after a reload.
    await page.reload();
    await page.waitForFunction(() => (window as any).fx);
    await launch(page);
    await expect(page.getByRole('switch', { name: 'Show Mock' })).toHaveAttribute('aria-checked', 'false');
    await page.getByRole('switch', { name: 'Show Mock' }).click();
    await tab(page, 'Mock');
    await expect(button(page, 'Activate Mock module')).toBeVisible(); // shown again, still inactive
    expect((await send(page, { url: '/api/mock-target' })).body.text).not.toContain('mocked');
  });

  test('hiding the recorder stops recording and keeps the draft; call limit, body capture and recovery settings apply', async ({ page }) => {
    await launch(page);
    await setLimits(page, { 'aw-set-calls': '10' });
    await page.getByRole('checkbox', { name: 'Recorder reads response bodies' }).click();
    await page.getByRole('checkbox', { name: 'Keep a recorder recovery copy' }).click();
    await saved(page);
    await openRecord(page);
    await button(page, 'Start recording').click();
    for (let i = 0; i < 12; i++) await send(page, { url: `/api/echo?n=${i}` });
    await expect(page.locator('#aw-rec-count')).toContainText('10 of 10 calls');
    await expect(page.locator('#aw-rec-reason')).toContainText('Stopped at the 10-call limit');
    await button(page, 'Review recorded calls').click();
    await expect(page.locator('#aw-imp-review')).toContainText('Response bodies are off in Settings; the body was not read');
    // Recovery off: nothing survives a reload.
    await page.reload();
    await page.waitForFunction(() => (window as any).fx);
    await launch(page);
    await openRecord(page);
    await expect(page.locator('#aw-rec-count')).toContainText('0 of 10 calls');
    // Hide while recording: capture stops, the draft stays.
    await button(page, 'Start recording').click();
    await send(page, { url: '/api/echo?kept=1' });
    await expect(page.locator('#aw-rec-count')).toContainText('1 of 10 calls');
    await settings(page);
    await page.getByRole('switch', { name: 'Show Recorder' }).click();
    await saved(page);
    await send(page, { url: '/api/echo?late=1' });
    await tab(page, 'Home');
    await expect(button(page, 'Record')).toHaveCount(0); // hidden with the recorder module
    await settings(page);
    await page.getByRole('switch', { name: 'Show Recorder' }).click();
    await openRecord(page);
    await expect(page.locator('#aw-rec-count')).toContainText('1 of 10 calls');
    await expect(button(page, 'Start recording')).toBeVisible();
  });

  test('activity record limit trims now and bounds later traffic; invalid input is refused; Reset restores defaults', async ({ page }) => {
    await launch(page);
    for (let i = 0; i < 60; i++) await send(page, { url: `/api/echo?i=${i}` });
    await setLimits(page, { 'aw-set-records': '50' });
    await tab(page, 'Home');
    await expect(page.locator('[data-api-workbench] .aw-cnt').first()).toHaveText('50');
    await expect(panel(page).getByText('The latest 50 requests are kept (Settings).')).toBeVisible();
    await setLimits(page, { 'aw-set-records': '20' }).catch(() => {}); // below the minimum: refused
    await expect(page.locator('[data-api-workbench] [role=status]').last()).toContainText('Not saved: activityRecords');
    await expect(page.locator('#aw-set-records')).toHaveValue('50');
    await button(page, 'Reset limits and capture to defaults').click();
    await saved(page);
    await expect(page.locator('#aw-set-records')).toHaveValue('500');
    await expect(page.locator('#aw-set-calls')).toHaveValue('100');
  });

  test('configured context roots are offered on Auth & context and scanned only on click', async ({ page }) => {
    await page.evaluate(() => { (window as any).__getterHits = 0; (window as any).appConfig = { tenant: 'bank-a' }; });
    await launch(page);
    await setLimits(page, { 'aw-set-roots': 'appConfig, __STATE__' });
    await tab(page, 'Test');
    await page.locator('[data-key="view-context"]').click();
    await expect(page.getByRole('textbox', { name: 'Global roots' })).toHaveValue('appConfig, __STATE__');
    await expect(page.getByRole('checkbox', { name: 'Global roots' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Nothing is read until you press Scan.')).toBeVisible();
    await page.locator('#aw-scan').click();
    await expect(page.getByRole('region', { name: 'Scan page' })).toContainText('appConfig.tenant');
  });

  test('turning body capture off releases a pending recorder read while the page receives every chunk', async ({ page }) => {
    await launch(page);
    await openRecord(page);
    await button(page, 'Start recording').click();
    await page.evaluate(() => {
      (window as any).streamDone = fetch('/api/stream?parts=15&gap=200').then((r) => r.text());
    });
    await expect.poll(async () => (await counters(page))['/api/stream']).toBe(1);
    await settings(page);
    await page.getByRole('checkbox', { name: 'Recorder reads response bodies' }).click();
    await openRecord(page);
    await expect(page.locator('#aw-rec-count')).toContainText('1 of 100 calls');
    await button(page, 'Review recorded calls').click();
    await expect(page.locator('#aw-imp-review')).toContainText('Response bodies are off in Settings; the body was not read');
    expect(await page.evaluate(() => (window as any).streamDone)).toBe(Array.from({ length: 15 }, (_, i) => `chunk${i};`).join(''));
  });

  test('Clear local data cancels safely, then clears the recorder draft and recovery without touching host storage', async ({ page }) => {
    await launch(page);
    await page.evaluate(() => localStorage.setItem('host-setting', 'keep'));
    await openRecord(page);
    await button(page, 'Start recording').click();
    await send(page, { url: '/api/echo?kept=1' });
    await expect(page.locator('#aw-rec-count')).toContainText('1 of 100 calls');
    await settings(page);
    await button(page, 'Clear local data…').click();
    await expect(page.getByRole('dialog')).toContainText('recorder draft and recovery copy');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await openRecord(page);
    await expect(page.locator('#aw-rec-count')).toContainText('1 of 100 calls');
    await settings(page);
    await button(page, 'Clear local data…').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Clear local data', exact: true }).click();
    await expect(page.locator('[data-api-workbench] [role=status]').last()).toContainText('Local data cleared');
    await openRecord(page);
    await expect(page.locator('#aw-rec-count')).toContainText('0 of 100 calls');
    await page.getByRole('button', { name: 'Close API Workbench and remove its hooks' }).first().click();
    await page.reload();
    await launch(page);
    await openRecord(page);
    await expect(page.locator('#aw-rec-count')).toContainText('0 of 100 calls');
    expect(await page.evaluate(() => localStorage.getItem('host-setting'))).toBe('keep');
  });
});

test.describe('data-only update check (S18.3, G24)', () => {
  const dir = 'test-results/deploy';
  /** Build a labelled candidate into its own folder; returns its bookmark text. */
  const build = (out: string, env: Record<string, string>) => {
    execFileSync('node', ['scripts/build.mjs'], { env: { ...process.env, AW_OUT: out, ...env }, stdio: 'pipe' });
    return readFileSync(`${out}/bookmark.txt`, 'utf8');
  };
  let running = '';
  let privateRunning = '';
  let newer = '';
  test.beforeAll(() => {
    mkdirSync(dir, { recursive: true });
    newer = build('test-results/cand-new', { AW_VERSION: '2.0.0-r99', AW_UPDATE_URL: `${B}/deploy/` });
    running = decode(build('test-results/cand-old', { AW_VERSION: version, AW_UPDATE_URL: `${B}/deploy/` }));
    privateRunning = decode(build('test-results/cand-private', { AW_VERSION: version, AW_UPDATE_URL: `${B}/deploy-private/` }));
  });
  const publish = (from: string) => { for (const f of ['update.json', 'bookmark.txt']) copyFileSync(`${from}/${f}`, `${dir}/${f}`); };
  const about = async (page: Page) => { await settings(page); await expect(page.locator('#aw-about')).toBeVisible(); };

  test('newer published build: verified, copied on click, never run; replacing the bookmark changes the running version', async ({ page, context }) => {
    publish('test-results/cand-new');
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: A });
    await launch(page, running);
    await page.waitForTimeout(300);
    expect(Object.keys(await counters(page)).filter((k) => k.startsWith('deploy:'))).toEqual([]); // no passive request
    await about(page);
    await expect(page.locator('#aw-about-version')).toHaveText(version);
    await expect(page.locator('#aw-about-last')).toHaveText('not checked');
    await button(page, 'Check for update').click();
    await expect(page.locator('#aw-about')).toContainText('Version 2.0.0-r99 is published');
    await expect(page.locator('#aw-about')).toContainText('verified). It has not been run or installed.');
    expect(await page.evaluate(() => document.querySelectorAll('[data-api-workbench]').length)).toBe(1); // nothing ran
    const c = await counters(page);
    expect([c['deploy:update.json'], c['deploy:bookmark.txt']]).toEqual([1, 1]);
    await button(page, 'Copy new bookmarklet').click();
    await expect(page.locator('#aw-update-outcome')).toHaveText(/^Copied 2\.0\.0-r99 to the clipboard\. Not installed yet/);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(newer);
    await expect(page.locator('#aw-about-version')).toHaveText(version); // still the running version
    await expect(page.locator('#aw-about-last')).toContainText('2.0.0-r99');
    // The user's manual step: replace the bookmark, reload, launch the new text.
    await page.reload();
    await page.waitForFunction(() => (window as any).fx);
    await launch(page, decode(await page.evaluate(() => navigator.clipboard.readText())));
    await expect(page.locator('#aw-about-version')).toHaveText('2.0.0-r99');
  });

  test('equal/older version, inconsistent deployment, unreadable address and clipboard refusal are each reported; nothing changes', async ({ page }) => {
    await launch(page, running);
    await about(page);
    // Equal: the running build itself is published.
    publish('test-results/cand-old');
    await button(page, 'Check for update').click();
    await expect(page.locator('#aw-about')).toContainText(`You are running the published version ${version}.`);
    // Inconsistent: the manifest is newer but the bookmark text is not the one it describes.
    publish('test-results/cand-new');
    writeFileSync(`${dir}/bookmark.txt`, readFileSync(`${dir}/bookmark.txt`, 'utf8').replace('void%200', 'void%201'));
    await button(page, 'Check for update').click();
    await expect(page.locator('#aw-about')).toContainText('does not match the manifest SHA-256');
    await expect(button(page, 'Copy new bookmarklet')).toHaveCount(0);
    // Malformed manifest.
    writeFileSync(`${dir}/update.json`, '{"schema":1,"version":"next"}');
    await button(page, 'Check for update').click();
    await expect(page.locator('#aw-about')).toContainText('Update check failed: The update manifest has no valid version');
    // Clipboard refusal: the text is offered for manual copy, never reported as copied.
    publish('test-results/cand-new');
    await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { value: () => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError')) }); });
    await button(page, 'Check for update').click();
    await button(page, 'Copy new bookmarklet').click();
    await expect(page.locator('#aw-update-outcome')).toContainText('Clipboard refused (Write permission denied.)');
    await expect(page.locator('#aw-update-text')).toHaveValue(newer);
    await expect(page.locator('#aw-about-version')).toHaveText(version);
  });

  test('an address that is not CORS-readable fails honestly; a build without an address cannot check', async ({ page }) => {
    publish('test-results/cand-new');
    await launch(page, privateRunning);
    await about(page);
    await button(page, 'Check for update').click();
    await expect(page.locator('#aw-about')).toContainText('could not be read from this page');
    await page.reload();
    await page.waitForFunction(() => (window as any).fx);
    await launch(page);
    await about(page);
    await expect(page.locator('#aw-about')).toContainText('none in this build');
    await expect(button(page, 'Check for update')).toBeDisabled();
  });
});

test.describe('new-user journey (G26)', () => {
  test('launch → import → review → send once → save sample → derive mock → activate → page call → detail → export → Stop all → Close', async ({ page }) => {
    const doc = {
      openapi: '3.0.3', info: { title: 'Journey', version: '1' }, servers: [{ url: A }],
      paths: { '/api/echo': { get: { operationId: 'readJourney', summary: 'Read journey', responses: { 200: { description: 'ok' } } } } },
    };
    const nativeFetch = await page.evaluate(() => window.fetch.toString());
    await launch(page);
    await expect(page.locator('#aw-about-version')).toHaveText(version);
    // Import and review: nothing is sent.
    const before = await counters(page);
    await button(page, 'Import').first().click();
    await page.locator('#aw-imp-text').fill(JSON.stringify(doc));
    await button(page, 'Apply').click();
    await expect(page.locator('#aw-imp-review > strong')).toContainText('OpenAPI 3.0.3 · Journey');
    await button(page, 'Import 1 selected').click();
    await expect(page.locator('#aw-imp-saved')).toContainText('1 added');
    expect(await counters(page)).toEqual(before);
    // Send once and keep the real response as the endpoint's sample.
    await page.getByRole('button', { name: 'Show endpoints' }).click();
    await page.getByRole('button', { name: 'Run Read journey once', exact: true }).click();
    await page.locator('#aw-once-run').click();
    await expect(page.locator('#aw-once-verdict')).toHaveText('Checks passed');
    expect((await counters(page))['/api/echo']).toBe(1);
    await button(page, 'Save sample').click();
    // Derive a mock rule from the endpoint, save, then activate the module.
    await tab(page, 'Mock');
    await page.getByRole('combobox', { name: 'New rule from endpoint' }).selectOption({ label: 'GET Read journey' });
    await expect(panel(page)).toContainText("Reply copied from Read journey's");
    await panel(page).locator('footer').getByRole('button', { name: 'Save', exact: true }).click();
    await activate(page, 'Mock');
    // The page's own action now gets the mocked reply with zero upstream hits; detail explains it.
    const r = await send(page, { url: '/api/echo' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body.text)).toMatchObject({ path: '/api/echo' }); // the saved sample's body
    expect((await counters(page))['/api/echo']).toBe(1);
    await tab(page, 'Home');
    await page.locator('[data-api-workbench] button[data-id]').first().click();
    await expect(panel(page)).toContainText(/Mock[^]*applied/);
    // Export (redacted by default), Stop all, Close: hooks gone, page fetch native again.
    await settings(page);
    const dl = page.waitForEvent('download');
    await button(page, 'Export active profile').click();
    const text = readFileSync(await (await dl).path(), 'utf8');
    expect(JSON.parse(text)).toMatchObject({ kind: 'profile' });
    expect(text).toContain('Read journey');
    await panel(page).locator('footer').getByRole('button', { name: 'Stop all' }).click();
    await expect(panel(page).locator('footer').getByRole('button', { name: 'Stop all' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Close API Workbench and remove its hooks' }).first().click();
    await expect(panel(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.fetch.toString())).toBe(nativeFetch);
    await send(page, { url: '/api/echo' });
    expect((await counters(page))['/api/echo']).toBe(2);
  });
});

test('results: save samples, rerun a retained snapshot or current config, retain only 20 stored runs', async ({ page }) => {
  test.setTimeout(60_000);
  const agg = defaultProfile('Results retention');
  agg.endpoints.push({ id: 'ep-result', alias: 'result', name: 'Result', request: { method: 'GET', hostKey: 'default', url: '/api/text?t=original', query: [], headers: [], credentials: 'same-origin', body: { kind: 'none' } }, checks: [{ kind: 'status', min: 200, max: 299 }], provenance: 'R8 results fixture', createdAt: 1, updatedAt: 1 });
  agg.plans.push({ id: 'plan-result', name: 'Results plan', strategy: 'flow', mode: 'direct', steps: [{ endpointId: 'ep-result', phase: 'load' }], iterations: 1, concurrency: 1, delayMs: 0, rampUp: false, rampStepMs: 1000, onFailure: 'continue', notify: 'off' });
  await launch(page);
  await button(page, 'Import').first().click();
  await page.locator('#aw-imp-text').fill(JSON.stringify({ format: 'api-workbench', schema: 2, kind: 'profile', profiles: [agg] }));
  await page.locator('#aw-imp-apply').click();
  await page.locator('#aw-imp-commit').click();
  await expect(page.locator('#aw-imp-saved')).toContainText('Results retention');
  await tab(page, 'Test');
  await page.locator('[data-key="view-plans"]').click();
  await page.locator('#aw-run-once').click();
  await expect(page.locator('#aw-run-state')).toHaveText('completed');
  const original = (await panel(page).getByText(/^Run .* · profile/).textContent())!.split(' · ')[0];
  await button(page, 'Save all samples').click();
  await expect(page.locator('[data-api-workbench] .aw-toast').last()).toContainText('Saved 1 response as endpoint sample');
  await page.locator('[data-key="run-again"]').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Retained snapshot' }).click();
  await expect(page.locator('#aw-run-state')).toHaveText('completed');
  await expect(panel(page).getByText(/^Run .* · profile/)).not.toContainText(original);
  await page.getByRole('region', { name: 'Last responses' }).locator('summary').click();
  await expect(page.getByRole('region', { name: 'Last responses' })).toContainText('original');
  // Save changed endpoint content through the UI, then rerun the old history entry both ways.
  await tab(page, 'Home');
  await button(page, 'Endpoints').click();
  await page.getByRole('button', { name: 'Edit Result (result)' }).click();
  await page.locator('#aw-ep-url').fill('/api/text?t=current');
  await button(page, 'Save').click();
  await tab(page, 'Test');
  await page.locator('[data-key="view-results"]').click();
  for (const [choice, body] of [['Retained snapshot', 'original'], ['Current configuration', 'current']] as const) {
    await page.getByRole('list', { name: 'Run history, newest first' }).getByRole('button').last().click();
    await page.locator('[data-key="run-again"]').click();
    await page.getByRole('dialog').getByRole('button', { name: choice }).click();
    await expect(page.locator('#aw-run-state')).toHaveText('completed');
    await page.getByRole('region', { name: 'Last responses' }).locator('summary').click();
    await expect(page.getByRole('region', { name: 'Last responses' })).toContainText(body);
  }
  // Enough real user reruns to exercise the durable retention boundary, not just the visible list cap.
  for (let i = 0; i < 18; i++) {
    const before = await panel(page).getByText(/^Run .* · profile/).textContent();
    await page.locator('[data-key="run-again"]').click();
    await expect(panel(page).getByText(/^Run .* · profile/)).not.toHaveText(before!);
    await expect(page.locator('#aw-run-state')).toHaveText('completed');
  }
  await page.reload();
  await launch(page);
  await tab(page, 'Test');
  await page.locator('[data-key="view-results"]').click();
  await expect(page.getByRole('list', { name: 'Run history, newest first' }).getByRole('button')).toHaveCount(20);
  const stored = await page.evaluate(() => new Promise<any[]>((resolve) => {
    const r = indexedDB.open('api-workbench-v2');
    r.onsuccess = () => { const db = r.result; const q = db.transaction('runSummaries').objectStore('runSummaries').getAll(); q.onsuccess = () => { db.close(); resolve(q.result); }; };
  }));
  expect(stored).toHaveLength(20);
  expect(stored.reduce((n, r) => n + new TextEncoder().encode(JSON.stringify(r)).byteLength, 0)).toBeLessThanOrEqual(2 * 1024 * 1024);
  await settings(page);
  const [exported] = await Promise.all([page.waitForEvent('download'), button(page, 'Export active profile').click()]);
  expect(JSON.parse(readFileSync((await exported.path())!, 'utf8')).profiles[0].endpoints[0].sample.body).toBe('original');
});

test('real IndexedDB quota refusal leaves the saved profile intact and Retry saves the live draft', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-quota-'));
  const context = await chromium.launchPersistentContext(dir, { channel: process.env.AW_BROWSER ?? 'chrome' });
  const page = await context.newPage();
  try {
    await fresh(page);
    await launch(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Storage.overrideQuotaForOrigin', { origin: A, quotaSize: 32 * 1024 });
    expect(await cdp.send('Storage.getUsageAndQuota', { origin: A })).toMatchObject({ overrideActive: true, quota: 32 * 1024 });
    try {
      // A bounded environment probe: don't call an injected error a real quota failure.
      const exhausted = await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const r = indexedDB.open('quota-fill'); r.onupgradeneeded = () => r.result.createObjectStore('fill');
          r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
        });
        try {
          for (let i = 0; i < 32; i++) {
            const bytes = new Uint8Array(512 * 1024);
            for (let j = 0; j < bytes.length; j += 65536) crypto.getRandomValues(bytes.subarray(j, j + 65536));
            try { await new Promise<void>((resolve, reject) => { const t = db.transaction('fill', 'readwrite'); t.objectStore('fill').put(bytes, i); t.oncomplete = () => resolve(); t.onabort = () => reject(t.error); }); }
            catch (e) { return (e as DOMException).name; }
          }
          return 'quota not enforced within 16 MiB';
        } finally { db.close(); }
      });
      writeFileSync('docs/evidence/r8-quota-chrome.json', JSON.stringify({ browser: context.browser()?.version(), quota: await cdp.send('Storage.getUsageAndQuota', { origin: A }), result: exhausted, maxProbeBytes: 16 * 1024 * 1024 }, null, 2) + '\n');
      test.skip(exhausted !== 'QuotaExceededError', 'Real quota gate NOT RUN: Chrome accepted 16 MiB under a 32 KiB override; this environment does not enforce the probe quota');
      await tab(page, 'Home');
      await button(page, 'Endpoints').click();
      await button(page, 'Add endpoint').click();
      await page.locator('#aw-ep-name').fill('Quota draft');
      await page.locator('#aw-ep-alias').fill('quota');
      await page.locator('#aw-ep-method').selectOption('POST');
      await page.locator('#aw-ep-url').fill('/api/echo');
      await page.locator('#aw-ep-bodykind').selectOption('text');
      const body = await page.evaluate(() => Array.from({ length: 8192 }, () => crypto.randomUUID()).join('').slice(0, 256 * 1024));
      await page.locator('#aw-ep-body').fill(body); // incompressible enough to consume real IndexedDB disk quota
      await button(page, 'Save').click();
      await expect(page.locator('#aw-save-banner')).toContainText(/Not saved.*quota/i);
      const durable = await page.evaluate(() => new Promise<any[]>((resolve) => {
        const r = indexedDB.open('api-workbench-v2');
        r.onsuccess = () => { const db = r.result; const q = db.transaction('profiles').objectStore('profiles').getAll(); q.onsuccess = () => { db.close(); resolve(q.result); }; };
      }));
      expect(durable).toHaveLength(1);
      expect(durable[0].endpoints).toEqual([]);
      await settings(page);
      const [exported] = await Promise.all([page.waitForEvent('download'), button(page, 'Export active profile').click()]);
      expect(JSON.parse(readFileSync((await exported.path())!, 'utf8')).profiles[0].endpoints[0].request.body.text).toHaveLength(256 * 1024);
    } finally { await cdp.send('Storage.overrideQuotaForOrigin', { origin: A }); }
    await button(page, 'Retry save').click();
    await expect(page.locator('#aw-save-banner')).toBeHidden();
    await page.reload();
    await launch(page);
    await tab(page, 'Home');
    await button(page, 'Endpoints').click();
    await expect(page.getByRole('button', { name: 'Edit Quota draft (quota)' })).toBeVisible();
  } finally { await context.close(); rmSync(dir, { recursive: true, force: true }); }
});

test.describe('migration rehearsal (MIGRATION matrix, G21)', () => {
  const v1 = {
    schemaVersion: 1,
    profile: { id: 'default', name: 'wires', revision: 3, createdAt: 1, updatedAt: 2, environments: { default: { default: '' } }, activeEnvironment: 'default', globalHeaders: [{ name: 'X-Test', value: 'from-v1' }], settings: { bodyLimitKb: 512, enabledModules: { mock: true } } },
    endpoints: [
      { id: 'endpoint-1', profileId: 'default', alias: 'echo', name: 'Old echo', hostKey: 'default', createdAt: 1, updatedAt: 1, request: { method: 'POST', path: '/api/echo', headers: [], bodyKind: 'json', body: '{"a" : 1}', credentials: 'same-origin' }, checks: [{ kind: 'status', value: { min: 200, max: 299 } }] },
      { id: 'endpoint-2', profileId: 'default', alias: 'target', name: 'Target', hostKey: 'default', createdAt: 1, updatedAt: 1, request: { method: 'GET', path: '/api/mock-target', headers: [], bodyKind: 'none', body: '', credentials: 'same-origin' }, checks: [] },
    ],
    rules: [{ id: 'rule-1', profileId: 'default', kind: 'mock', label: 'Old mock', endpointId: 'endpoint-2', enabled: true, matcher: { method: 'GET', url: '/api/mock-target' }, mode: 'static', slots: [{ status: 200, headers: 'Content-Type: application/json', body: '{"from":"v1 rule"}' }] }],
    plan: { id: 'plan-1', profileId: 'default', name: 'Working Plan', strategy: 'flow', mode: 'direct', phases: {}, excluded: [], iterations: 1, concurrency: 1, delayMs: 0, rampUp: false, rampStepMs: 1000, onFailure: 'continue', notify: 'panel', notifyOnComplete: false, bindings: [] },
    savedProfiles: [{
      profile: { id: 'p2', name: 'staging', revision: 1, createdAt: 1, updatedAt: 1, environments: { default: { default: '' } }, activeEnvironment: 'default', globalHeaders: [], settings: { bodyLimitKb: 1024, enabledModules: {} } },
      endpoints: [{ id: 'e9', profileId: 'p2', alias: 'ping', name: 'Ping', hostKey: 'default', createdAt: 1, updatedAt: 1, request: { method: 'GET', path: '/api/echo', headers: [], bodyKind: 'none', body: '', credentials: 'same-origin' }, checks: [] }],
    }],
    savedPlans: [{ id: 'plan-2', profileId: 'p2', name: 'Smoke', strategy: 'independent', mode: 'rules', phases: {}, excluded: [], iterations: 1, concurrency: 1, delayMs: 0, rampUp: false, rampStepMs: 1000, onFailure: 'stop', notify: 'panel', notifyOnComplete: false, bindings: [] }],
  };
  const readOld = (page: Page) => page.evaluate((origin) => new Promise((resolve) => {
    const r = indexedDB.open('api-workbench');
    r.onsuccess = () => { const g = r.result.transaction('configs').objectStore('configs').get(origin); g.onsuccess = () => { r.result.close(); resolve(g.result); }; };
  }), A);

  test('whole schema 1 backup: refused write changes nothing; then converts with rules/plans; reload keeps profile, modules inactive; old data intact', async ({ page }) => {
    await page.evaluate(([cfg, origin]) => new Promise<void>((resolve) => {
      const r = indexedDB.open('api-workbench', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('configs');
      r.onsuccess = () => { const t = r.result.transaction('configs', 'readwrite'); t.objectStore('configs').put(cfg, origin); t.oncomplete = () => { r.result.close(); resolve(); }; };
    }), [v1, A] as const);
    await launch(page);
    await button(page, 'Import').first().click();
    await button(page, 'Look for schema 1 data').click();
    await expect(page.locator('#aw-imp-review')).toContainText('wires: 2 endpoints, 1 plans');
    await expect(page.locator('#aw-imp-review')).toContainText('staging: 1 endpoints, 1 plans');
    // Storage refuses the write: nothing is converted, the preview stays, the old database is untouched.
    await page.evaluate(() => { (window as any).__put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function () { throw new DOMException('Quota exceeded', 'QuotaExceededError'); }; });
    await button(page, 'Import as new profiles').click();
    await expect(page.locator('#aw-imp-failed')).toContainText('Quota exceeded');
    await expect(page.locator('#aw-imp-review')).toContainText('wires: 2 endpoints');
    await page.evaluate(() => { IDBObjectStore.prototype.put = (window as any).__put; });
    await settings(page);
    await expect(page.locator('#aw-prof-select option')).toHaveText(['Default · 0 endpoints']);
    expect(await readOld(page)).toEqual(v1);
    // Retry from the kept preview.
    await button(page, 'Import').first().click();
    await button(page, 'Retry').click();
    await expect(page.locator('#aw-imp-saved')).toContainText('Active profile: wires');
    await settings(page);
    await expect(page.locator('#aw-prof-select option')).toHaveText(['Default · 0 endpoints', 'wires · 2 endpoints', 'staging · 1 endpoint']);
    // Same request behavior; the converted rule is enabled but its module starts inactive.
    expect((await send(page, { url: '/api/mock-target' })).body.text).not.toContain('v1 rule');
    await activate(page, 'Mock');
    expect((await send(page, { url: '/api/mock-target' })).body.text).toBe('{"from":"v1 rule"}');
    await tab(page, 'Test');
    await page.locator('[data-key="view-plans"]').click();
    await expect(panel(page)).toContainText('Working Plan');
    // Reload: the converted profile is still active and nothing resumes.
    await page.reload();
    await page.waitForFunction(() => (window as any).fx);
    await launch(page);
    await expect(page.locator('#aw-profile-name')).toHaveText('wires');
    expect((await send(page, { url: '/api/mock-target' })).body.text).not.toContain('v1 rule');
    expect(await readOld(page)).toEqual(v1); // rollback path: the old bookmark still finds its data
  });
});
