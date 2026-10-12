// R3 cases in real Chrome: recorder (G18), HAR/native import review and commit (G19 HAR/native, G20).
// Launch = evaluating the decoded generated bookmark (injection; NOT saved-bookmark evidence).
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const A = `http://127.0.0.1:${process.env.AW_PORT ?? 4310}`;
const bookmark = readFileSync('dist/bookmark.txt', 'utf8');
const source = decodeURIComponent(bookmark.slice('javascript:'.length));

const button = (page: Page, name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' });
const counters = async (page: Page): Promise<Record<string, number>> => (await page.request.get(`${A}/__counters`)).json();
const send = (page: Page, o: object) => page.evaluate((x) => (window as any).fx.send(x), o);
const panelText = (page: Page) => page.locator('[data-api-workbench]').evaluate((el) => (el.shadowRoot!.querySelector('.aw-panel') as HTMLElement).innerText);

async function launch(page: Page, open: (page: Page) => Promise<void> = openImport) {
  await page.evaluate(source);
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await expect(page.locator('#aw-store-state')).toHaveText(/All changes saved|Storage unavailable/);
  await open(page);
}
const openImport = async (page: Page) => {
  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible();
};
/** The recorder has its own screen, opened from Home → Quick actions → Record. */
const openRecord = async (page: Page) => {
  await page.getByRole('navigation', { name: 'Modules' }).getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Record', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Record', exact: true })).toBeVisible();
};
async function fresh(page: Page) {
  await page.goto(`${A}/fixture`);
  await page.evaluate(() => Promise.all(['api-workbench-v2', 'api-workbench'].map((n) => new Promise((r) => { const q = indexedDB.deleteDatabase(n); q.onsuccess = q.onerror = q.onblocked = r; }))));
  await page.evaluate(() => localStorage.clear());
}
async function endpointCount(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  return page.locator('#aw-prof-select option:checked').textContent();
}

test.beforeEach(async ({ page }) => {
  await page.request.get(`${A}/__reset`);
  await fresh(page);
  await page.waitForFunction(() => (window as any).fx);
});

test.describe('recorder (G18, S06)', () => {
  test('captures future Fetch and XHR once each, joins responses by request ID, redacts, promotes only the selection', async ({ page }) => {
    await launch(page, openRecord);
    await send(page, { url: '/api/echo?before=1' }); // before Start: never captured
    await button(page, 'Start recording').click();
    await expect(page.locator('#aw-rec-ind')).toHaveText('REC');
    // Same URL, concurrently, different bodies: each sample must be its own response.
    await Promise.all([
      send(page, { method: 'POST', url: '/api/slow?ms=300', body: '{"who":"fetch"}', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sekrit-token' } }),
      send(page, { transport: 'xhr', method: 'POST', url: '/api/slow?ms=100', body: 'who=xhr&password=hunter2', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }),
      send(page, { url: '/api/binary?n=64', responseType: 'arraybuffer' }),
    ]);
    await expect(page.locator('#aw-rec-count')).toContainText('3 of 100 calls');
    // While recording the captured calls are listed; on Stop the review (endpoints + destination) appears by itself.
    await expect(page.getByRole('list', { name: 'Captured calls, newest first' }).getByRole('listitem')).toHaveCount(3);
    await button(page, 'Stop recording').click();
    await expect(page.locator('#aw-imp-review')).toContainText('3 candidates');
    await expect(page.locator('#aw-imp-review')).toContainText('Destination');
    await expect(page.locator('#aw-rec-ind')).toHaveCount(0);
    await send(page, { url: '/api/echo?after=1' }); // after Stop: not captured
    await page.waitForTimeout(100);
    await expect(page.locator('#aw-rec-count')).toContainText('3 of 100 calls');

    await button(page, 'Review recorded calls').click();
    const review = page.locator('#aw-imp-review');
    await expect(review).toContainText('3 candidates');
    const fetchRow = page.getByRole('listitem', { name: /POST \/api\/slow/ }).filter({ hasText: 'fetch' }).first();
    await expect(fetchRow).toContainText(/Header authorization: enter a fresh value/i);
    const text = await panelText(page);
    expect(text).not.toContain('sekrit-token');
    expect(text).not.toContain('hunter2');
    // Response identity by request ID: each sample echoes its own request.
    const samples = await page.evaluate(() => {
      const root = document.querySelector('[data-api-workbench]')!.shadowRoot!;
      return [...root.querySelectorAll('[data-key^="cand-"]')].map((li) => li.textContent);
    });
    expect(samples.filter((t) => t!.includes('sample 200'))).toHaveLength(3);
    await expect(page.getByRole('listitem', { name: /GET \/api\/binary/ })).toContainText('Sample body: Content type "application/octet-stream" is not text');

    await page.getByRole('checkbox', { name: 'Select /api/binary' }).click();
    await expect(button(page, /Import 2 selected/)).toBeVisible();
    const before = await counters(page);
    await button(page, /Import 2 selected/).click();
    await expect(page.locator('#aw-imp-saved')).toHaveText(/2 added, 0 replaced, 0 skipped \(already saved\), 2 need values before sending/);
    expect(await counters(page)).toEqual(before); // committing sends nothing
    expect(await endpointCount(page)).toBe('Default · 2 endpoints');

    // Representative dispatch: the redacted form field blocks; the stored endpoint has the exact recorded shape.
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await page.getByRole('button', { name: 'Endpoints', exact: true }).click();
    await page.getByRole('button', { name: /^Run \/api\/slow/ }).first().click();
    await expect(page.locator('#aw-once-blocked')).toContainText('value was redacted on export or capture');

    // Promoted calls leave the draft only on an explicit cleanup.
    await openRecord(page);
    await expect(page.locator('#aw-rec-count')).toContainText('3 of 100 calls');
    await button(page, 'Remove imported calls from the recorder draft').click();
    await expect(page.locator('#aw-rec-count')).toHaveText(/^1 of 100 calls/);
  });

  test('an unknown-length slow stream is excluded from the capture; the page still gets the whole body (G07)', async ({ page }) => {
    await launch(page, openRecord);
    await button(page, 'Start recording').click();
    const r = await send(page, { url: '/api/stream?parts=15&gap=200' });
    expect(r.body.text).toBe(Array.from({ length: 15 }, (_, i) => `chunk${i};`).join(''));
    await expect(page.locator('#aw-rec-count')).toHaveText(/^1 of 100 calls/);
    await button(page, 'Review recorded calls').click();
    await expect(page.locator('#aw-imp-review')).toContainText('Sample body: Body not complete within 2000 ms (stream or slow response); not captured');
  });

  test('tester traffic is excluded by default and labelled when included', async ({ page }) => {
    await launch(page);
    const har = { log: { version: '1.2', creator: { name: 't' }, entries: [{ startedDateTime: new Date().toISOString(), time: 1, request: { method: 'GET', url: `${A}/api/echo?k=1`, headers: [] }, response: { status: 200, headers: [], content: { mimeType: 'application/json', text: '{}' } } }] } };
    await page.locator('#aw-imp-text').fill(JSON.stringify(har));
    await button(page, 'Apply').click();
    await button(page, 'Import 1 selected').click();
    await expect(page.locator('#aw-imp-saved')).toContainText('1 added');
    await openRecord(page);
    await button(page, 'Start recording').click();
    const runRules = async () => {
      await page.getByRole('button', { name: 'Home', exact: true }).click();
      await page.getByRole('button', { name: 'Endpoints', exact: true }).click();
      await page.getByRole('button', { name: /^Run \/api\/echo/ }).click();
      await button(page, 'Apply rules').click();
      const n = (await counters(page))['/api/echo'] ?? 0;
      await page.locator('#aw-once-run').click();
      await expect.poll(async () => (await counters(page))['/api/echo']).toBe(n + 1);
      await openRecord(page);
    };
    await runRules();
    await page.waitForTimeout(150);
    await expect(page.locator('#aw-rec-count')).toHaveText(/^0 of 100 calls/);
    await page.getByRole('checkbox', { name: 'Include tester traffic' }).click();
    await runRules();
    await expect(page.locator('#aw-rec-count')).toHaveText(/^1 of 100 calls/);
    await button(page, 'Review recorded calls').click();
    await expect(page.locator('#aw-imp-review')).toContainText('tester traffic');
  });

  test('stops at the call limit with a usable draft; recovery restores it inactive after reload; Reset previews and clears', async ({ page }) => {
    await launch(page, openRecord);
    await button(page, 'Start recording').click();
    await page.evaluate(() => Promise.all(Array.from({ length: 105 }, (_, i) => (window as any).fx.send({ url: `/api/text?t=${i}` }))));
    await expect(page.locator('#aw-rec-reason')).toContainText('Stopped at the 100-call limit');
    await expect(page.locator('#aw-rec-count')).toContainText('100 of 100 calls');
    await expect(page.locator('#aw-rec-ind')).toHaveCount(0);
    await expect(button(page, 'Start recording')).toBeVisible();

    await page.waitForTimeout(500); // recovery write is debounced
    await page.reload();
    await page.waitForFunction(() => (window as any).fx);
    await launch(page, openRecord);
    await expect(page.locator('#aw-rec-state')).toContainText('Recovered draft from');
    await expect(page.locator('#aw-rec-state')).toContainText('not recording');
    await expect(page.locator('#aw-rec-count')).toContainText('100 of 100 calls');
    await expect(page.locator('#aw-rec-ind')).toHaveCount(0);
    await send(page, { url: '/api/echo?not-recorded=1' });
    await page.waitForTimeout(100);
    await expect(page.locator('#aw-rec-count')).toContainText('100 of 100 calls');

    await button(page, 'Reset…').click();
    await expect(page.getByRole('dialog')).toContainText('deletes 100 recorded call(s) and their recovery copy. Saved profiles and endpoints are not touched.');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('#aw-rec-count')).toContainText('100 of 100 calls');
    await button(page, 'Reset…').click();
    await button(page, 'Reset recorder').click();
    await expect(page.locator('#aw-rec-count')).toHaveText(/^0 of 100 calls/);
    await page.reload();
    await page.waitForFunction(() => (window as any).fx);
    await launch(page, openRecord);
    await expect(page.locator('#aw-rec-state')).toHaveText('Not recording');
  });
});

test.describe('import review and commit (G19 HAR/native, G20)', () => {
  const harText = (base: string) => JSON.stringify({
    log: {
      version: '1.2', creator: { name: 'WebInspector', version: '537.36' },
      entries: [
        { startedDateTime: '2026-10-11T10:00:00.000Z', time: 20, request: { method: 'POST', url: `${base}/api/echo`, headers: [{ name: 'Content-Type', value: 'application/json' }, { name: 'X-Test', value: 'har' }], postData: { mimeType: 'application/json', text: '{"amount":"1.00"}' } }, response: { status: 200, headers: [], content: { mimeType: 'application/json', text: '{"ok":1}' } } },
        { startedDateTime: '2026-10-11T10:00:01.000Z', time: 20, request: { method: 'POST', url: `${base}/api/echo`, headers: [{ name: 'Content-Type', value: 'application/json' }, { name: 'X-Test', value: 'har' }], postData: { mimeType: 'application/json', text: '{"amount":"2.00"}' } }, response: { status: 200, headers: [], content: { mimeType: 'application/json', text: '{"ok":2}' } } },
      ],
    },
  });

  test('HAR file and paste give the same review; import sends nothing; a representative endpoint sends its exact body', async ({ page }) => {
    await launch(page);
    const text = harText(A);
    const before = await counters(page);
    await page.locator('#aw-imp-file').setInputFiles({ name: 'calls.har', mimeType: 'application/json', buffer: Buffer.from(text) });
    const fromFile = await page.locator('#aw-imp-review ul').innerText();
    await expect(page.locator('#aw-imp-counts')).toHaveText('2 source items · 2 candidates · 0 skipped');
    await page.locator('#aw-imp-text').fill(text);
    await button(page, 'Apply').click();
    await expect(page.locator('#aw-imp-state')).toContainText('Pasted text');
    expect(await page.locator('#aw-imp-review ul').innerText()).toBe(fromFile);

    await page.locator('#aw-imp-dest').selectOption('new');
    await page.locator('#aw-imp-newname').fill('From HAR');
    await button(page, 'Import 2 selected').click();
    await expect(page.locator('#aw-imp-saved')).toContainText('Saved to new profile From HAR (now active): 2 added');
    await expect(page.locator('#aw-profile-name')).toHaveText('From HAR');
    expect(await counters(page)).toEqual(before);

    await page.getByRole('button', { name: 'Show endpoints' }).click();
    await page.getByRole('button', { name: /^Run \/api\/echo/ }).nth(1).click();
    await page.locator('#aw-once-run').click();
    await expect(page.locator('#aw-once-verdict')).toBeVisible();
    const echo = JSON.parse((await page.locator('#aw-once-body').textContent())!);
    expect(echo).toMatchObject({ method: 'POST', bodyText: '{"amount":"2.00"}', headers: { 'x-test': 'har', 'content-type': 'application/json' } });
  });

  test('pasted code is refused and runs nothing; oversized file and a newer paste keep the right draft', async ({ page }) => {
    await launch(page);
    const before = await counters(page);
    await page.locator('#aw-imp-text').fill('fetch("/api/echo", { method: "POST" })');
    await button(page, 'Apply').click();
    await expect(page.locator('#aw-imp-errors')).toContainText('Call 1: URL /api/echo is not absolute; not imported');
    expect(await counters(page)).toEqual(before);

    await page.locator('#aw-imp-file').setInputFiles({ name: 'huge.har', mimeType: 'application/json', buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 32) });
    await expect(page.locator('#aw-imp-state')).toContainText('huge.har is 10.0 MiB; the limit is 10 MiB. The current draft is unchanged.');
    await expect(page.locator('#aw-imp-text')).toHaveValue('fetch("/api/echo", { method: "POST" })');

    // A slow file read loses to text typed after it started.
    await page.locator('#aw-imp-text').fill('');
    await page.evaluate(() => { const t = Blob.prototype.text; Blob.prototype.text = function () { return new Promise((r) => setTimeout(() => r(t.call(this)), 400)); }; });
    await page.locator('#aw-imp-file').setInputFiles({ name: 'slow.har', mimeType: 'application/json', buffer: Buffer.from(harText(A)) });
    await expect(page.locator('#aw-imp-state')).toContainText('Reading file');
    await page.locator('#aw-imp-text').fill('typed later');
    await page.waitForTimeout(600);
    await expect(page.locator('#aw-imp-text')).toHaveValue('typed later');
    await expect(page.locator('#aw-imp-review')).toHaveCount(0);
  });

  test('save failure keeps the review and saves nothing; Retry commits once; stale destination must be rebuilt', async ({ page }) => {
    await launch(page);
    await page.locator('#aw-imp-text').fill(harText(A));
    await button(page, 'Apply').click();
    await page.evaluate(() => { (window as any).__put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function () { throw new DOMException('Quota exceeded', 'QuotaExceededError'); }; });
    await button(page, 'Import 2 selected').click();
    await expect(page.locator('#aw-imp-failed')).toContainText('Not saved: Quota exceeded. The source, review and selection are kept.');
    await expect(page.locator('#aw-imp-review')).toContainText('2 candidates');
    await page.evaluate(() => { IDBObjectStore.prototype.put = (window as any).__put; });
    await button(page, 'Retry').click();
    await expect(page.locator('#aw-imp-saved')).toContainText('2 added');
    expect(await endpointCount(page)).toBe('Default · 2 endpoints');

    // Same HAR again: duplicates default to Skip.
    await openImport(page);
    await button(page, 'Apply').click();
    await expect(page.getByText('Same request as saved endpoint /api/echo.').first()).toBeVisible();

    // The destination changes after the review is built: commit is refused until rebuilt.
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await page.locator('#aw-prof-new').fill('Other');
    await button(page, 'Create empty').click();
    await expect(page.locator('#aw-profile-name')).toHaveText('Other');
    await openImport(page);
    await expect(page.locator('#aw-imp-stale')).toContainText('The destination changed after this review was built');
    await expect(page.locator('#aw-imp-commit')).toBeDisabled();
    await button(page, 'Rebuild review').click();
    await expect(page.locator('#aw-imp-stale')).toBeHidden();
    await expect(page.locator('#aw-imp-review')).not.toContainText('Same request as saved endpoint');
    await button(page, 'Import 2 selected').click();
    await expect(page.locator('#aw-imp-saved')).toContainText('Saved to Other: 2 added');
  });

  test('native profile export merges into the current profile with conflicts reviewed', async ({ page }) => {
    await launch(page);
    await page.locator('#aw-imp-text').fill(harText(A));
    await button(page, 'Apply').click();
    await button(page, 'Import 2 selected').click();
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    const [dl] = await Promise.all([page.waitForEvent('download'), button(page, 'Export active profile').click()]);
    const exported = readFileSync((await dl.path())!, 'utf8');

    await openImport(page);
    await page.locator('#aw-imp-text').fill(exported);
    await button(page, 'Apply').click();
    await expect(page.locator('#aw-imp-review')).toContainText('Default: 2 endpoints, 0 plans');
    await page.locator('#aw-imp-mode').selectOption('merge');
    await expect(page.getByText('Same request as saved endpoint').first()).toBeVisible();
    await page.getByRole('combobox', { name: /Conflict action for/ }).first().selectOption('keep');
    await button(page, 'Import 2 selected').click();
    await expect(page.locator('#aw-imp-saved')).toContainText('1 added, 0 replaced, 1 skipped');
    expect(await endpointCount(page)).toBe('Default · 3 endpoints');

    await openImport(page);
    await page.locator('#aw-imp-text').fill(exported);
    await button(page, 'Apply').click();
    await page.locator('#aw-imp-mode').selectOption('replace');
    await expect(page.locator('#aw-imp-scope')).toContainText('removes its 3 endpoint(s)');
    await button(page, 'Replace Default').click();
    await expect(page.locator('#aw-imp-saved')).toContainText('Replaced Default: 2 endpoints');
    expect(await endpointCount(page)).toBe('Default · 2 endpoints');
  });

  test('Import and Record fit a narrow viewport (G22, emulated)', async ({ page }) => {
    await launch(page);
    await page.locator('#aw-imp-text').fill(harText(A));
    await button(page, 'Apply').click();
    await page.setViewportSize({ width: 360, height: 420 });
    const overflow = () => page.locator('[data-api-workbench]').evaluate((el) => {
      const p = el.shadowRoot!.querySelector('.aw-panel') as HTMLElement;
      const m = el.shadowRoot!.querySelector('.aw-body') as HTMLElement;
      return { panel: p.scrollWidth - p.clientWidth, main: m.scrollWidth - m.clientWidth, right: p.getBoundingClientRect().right - innerWidth };
    });
    await expect.poll(async () => (await overflow()).right).toBeLessThanOrEqual(0);
    const o = await overflow();
    expect(o.panel).toBeLessThanOrEqual(0);
    expect(o.main).toBeLessThanOrEqual(0);
    await page.locator('#aw-imp-commit').scrollIntoViewIfNeeded();
    await expect(page.locator('#aw-imp-commit')).toBeInViewport();    await openRecord(page);
    const r = await overflow();
    expect(r.panel).toBeLessThanOrEqual(0);
    expect(r.main).toBeLessThanOrEqual(0);
  });
});
