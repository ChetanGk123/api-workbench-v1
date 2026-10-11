// R5 breakpoints in real Chrome, driven through the panel and checked against server counters
// outside the hooks. Launch = evaluating the decoded generated bookmark.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { activate, addMock, fill, newRule, panel, saveRule, tab } from './rule-helpers';

const A = `http://127.0.0.1:${process.env.AW_PORT ?? 4310}`;
const source = decodeURIComponent(readFileSync('dist/bookmark.txt', 'utf8').slice('javascript:'.length));
const launch = (page: Page) => page.evaluate(source);
type Res = Record<string, any>;
const send = (page: Page, o: Record<string, unknown>) => page.evaluate((opts) => (window as any).fx.send(opts), o) as Promise<Res>;
const hits = async (page: Page, key: string): Promise<number> => ((await (await page.request.get(`${A}/__counters`)).json())[key] ?? 0);
const settle = (page: Page, ms: number) => page.evaluate((t) => new Promise((r) => setTimeout(r, t)), ms);

async function addBreak(page: Page, o: { path?: string; request?: boolean; response?: boolean; activate?: boolean } = {}) {
  await newRule(page, 'Intercept');
  await fill(page, { 'aw-r-path': o.path ?? '/api/echo' });
  if (o.request !== false) await panel(page).getByRole('checkbox', { name: 'Break on request' }).click();
  if (o.response) await panel(page).getByRole('checkbox', { name: 'Break on response' }).click();
  await saveRule(page);
  if (o.activate !== false) await activate(page, 'Intercept');
}
/** Wait for `n` waiting pauses (title-bar indicator) and open the workspace from it. */
async function openPaused(page: Page, n = 1) {
  const ind = panel(page).getByRole('button', { name: `${n} paused — open paused requests` }).first();
  await expect(ind).toBeVisible();
  await ind.click();
  await expect(panel(page).getByRole('heading', { name: 'Paused requests' })).toBeVisible();
}
const button = (page: Page, name: string) => panel(page).getByRole('button', { name, exact: true });

test.beforeEach(async ({ page }) => {
  await page.request.get(`${A}/__reset`);
  await page.goto(`${A}/fixture`);
  await page.waitForFunction(() => (window as any).fx);
});

test.describe('request breakpoint (G11)', () => {
  test('fetch: zero hits while paused; Continue sends the edited request exactly once; duplicate controls are gone', async ({ page }) => {
    await launch(page);
    await addBreak(page);
    const p = send(page, { method: 'POST', url: '/api/echo?a=1', headers: { 'Content-Type': 'application/json', 'X-Test': 'orig' }, body: '{"amount":5}' });
    await openPaused(page);
    await settle(page, 300);
    expect(await hits(page, '/api/echo')).toBe(0);
    await expect(panel(page).getByText('Request: not sent yet')).toBeVisible();
    await panel(page).getByLabel('request header 2 value').fill('edited');
    await fill(page, { 'aw-p-body': '{"amount":7}', 'aw-p-url': `${A}/api/echo?a=2` });
    await button(page, 'Continue').click();
    const r = await p;
    expect(r).toMatchObject({ ok: true, status: 200, body: { kind: 'text' } });
    const echo = JSON.parse(r.body.text);
    expect(echo).toMatchObject({ headers: { 'x-test': 'edited' }, bodyText: '{"amount":7}', query: [['a', '2']] });
    expect(await hits(page, '/api/echo')).toBe(1);
    await expect(panel(page).getByText(/Ended: continued with edits: URL, headers, body/)).toBeVisible();
    await expect(button(page, 'Continue')).toHaveCount(0);
    await settle(page, 200);
    expect(await hits(page, '/api/echo')).toBe(1);
  });

  test('XHR: Abort fails the call with native-shaped events and sends nothing', async ({ page }) => {
    await launch(page);
    await addBreak(page);
    const p = send(page, { transport: 'xhr', method: 'POST', url: '/api/echo', body: 'x' });
    await openPaused(page);
    await button(page, 'Abort').click();
    const r = await p;
    expect(r.trace).toEqual(['rsc1', 'loadstart', 'rsc4', 'abort', 'loadend']);
    expect(r).toMatchObject({ status: 0, readyState: 0, attrLoadend: true });
    await settle(page, 200);
    expect(await hits(page, '/api/echo')).toBe(0);
  });

  test('XHR: Continue original sends once with native event order and typed response', async ({ page }) => {
    await launch(page);
    await addBreak(page);
    const p = send(page, { transport: 'xhr', url: '/api/echo', responseType: 'json' });
    await openPaused(page);
    expect(await hits(page, '/api/echo')).toBe(0);
    await button(page, 'Continue original').click();
    const r = await p;
    expect(r.trace).toEqual(['rsc1', 'loadstart', 'rsc2', 'rsc3', 'progress', 'rsc4', 'load', 'loadend']);
    expect(r).toMatchObject({ status: 200, protoIntact: true, body: { kind: 'json', json: { path: '/api/echo' } } });
    expect(await hits(page, '/api/echo')).toBe(1);
  });

  test('caller abort wins on both transports: AbortError / abort events, pause ends cancelled, zero hits', async ({ page }) => {
    await launch(page);
    await addBreak(page);
    const f = send(page, { url: '/api/echo', abortAfterMs: 400 });
    const x = send(page, { transport: 'xhr', url: '/api/echo', abortAfterMs: 400 });
    await openPaused(page, 2);
    expect(await f).toMatchObject({ ok: false, error: 'AbortError' });
    expect((await x).trace).toEqual(['rsc1', 'loadstart', 'rsc4', 'abort', 'loadend']);
    await expect(panel(page).getByRole('button', { name: /cancelled/ })).toHaveCount(2);
    await expect(button(page, 'Continue')).toHaveCount(0); // selected one ended: no stale control
    await settle(page, 200);
    expect(await hits(page, '/api/echo')).toBe(0);
  });

  test('sensitive values hidden by default; signature header warns that edits are not re-signed', async ({ page }) => {
    await launch(page);
    await addBreak(page);
    const p = send(page, { url: '/api/echo', headers: { Authorization: 'Bearer top-secret-token', 'X-Signature': 'sig-1' } });
    await openPaused(page);
    await expect(panel(page).getByText('Authorization: •••••• (hidden)')).toBeVisible();
    expect(await panel(page).locator('input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).not.toContain('Bearer top-secret-token');
    await expect(panel(page).getByText(/carries X-Signature\. Edits are not re-signed/i)).toBeVisible();
    await panel(page).getByRole('checkbox', { name: 'Show sensitive values' }).click();
    expect(await panel(page).locator('input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).toContain('Bearer top-secret-token');
    await button(page, 'Continue').click(); // unchanged edit = original
    expect(JSON.parse((await p).body.text).headers).toMatchObject({ authorization: 'Bearer top-secret-token', 'x-signature': 'sig-1' });
  });

  test('invalid edit keeps the pause editable and sends nothing', async ({ page }) => {
    await launch(page);
    await addBreak(page);
    const p = send(page, { url: '/api/echo' });
    await openPaused(page);
    await fill(page, { 'aw-p-url': 'not a url' });
    await button(page, 'Continue').click();
    await expect(panel(page).getByRole('alert')).toHaveText('URL: enter an absolute http(s) URL');
    expect(await hits(page, '/api/echo')).toBe(0);
    await button(page, 'Continue original').click();
    expect((await p).status).toBe(200);
  });
});

test.describe('response breakpoint (G11)', () => {
  test('fetch: final override of status/body after the one real hit; Continue adds no hit', async ({ page }) => {
    await launch(page);
    await addBreak(page, { path: '/api/text', request: false, response: true });
    const p = send(page, { url: '/api/text?t=hello', responseType: 'text' });
    await openPaused(page);
    expect(await hits(page, '/api/text')).toBe(1);
    await expect(panel(page).getByText('Response: server already replied')).toBeVisible();
    await expect(panel(page).getByText(/does not undo anything upstream/)).toBeVisible();
    expect(await panel(page).locator('#aw-p-body').inputValue()).toBe('hello');
    await fill(page, { 'aw-p-status': 418, 'aw-p-body': 'edited ✓' });
    await button(page, 'Continue').click();
    expect(await p).toMatchObject({ ok: true, status: 418, body: { text: 'edited ✓' } });
    await settle(page, 200);
    expect(await hits(page, '/api/text')).toBe(1);
  });

  test('XHR arraybuffer: metadata-only body, native bytes delivered unchanged on Continue', async ({ page }) => {
    const native = await send(page, { transport: 'xhr', url: '/api/binary?n=1024', responseType: 'arraybuffer' });
    await launch(page);
    await addBreak(page, { path: '/api/binary', request: false, response: true });
    const p = send(page, { transport: 'xhr', url: '/api/binary?n=1024', responseType: 'arraybuffer' });
    await openPaused(page);
    await expect(panel(page).getByText(/Body: XHR arraybuffer response: shown as metadata only/)).toBeVisible();
    await expect(panel(page).locator('#aw-p-body')).toHaveCount(0);
    await button(page, 'Continue').click();
    const r = await p;
    expect(r.body).toMatchObject({ kind: 'arraybuffer', bytes: 1024, sha256: native.body.sha256 });
    expect(r.trace).toEqual(native.trace);
    expect(await hits(page, '/api/binary')).toBe(2);
  });

  test('XHR response Abort: page sees abort; upstream hit stands', async ({ page }) => {
    await launch(page);
    await addBreak(page, { request: false, response: true });
    const p = send(page, { transport: 'xhr', url: '/api/echo' });
    await openPaused(page);
    await button(page, 'Abort').click();
    expect((await p).trace).toEqual(['rsc1', 'loadstart', 'rsc4', 'abort', 'loadend']);
    expect(await hits(page, '/api/echo')).toBe(1);
  });

  test('mock replies are never paused; the reason is shown', async ({ page }) => {
    await launch(page);
    await addBreak(page, { path: '/api/mock-target', response: true });
    await addMock(page);
    expect((await send(page, { url: '/api/mock-target' })).status).toBe(200);
    await tab(page, 'Home');
    await panel(page).locator('button[data-id]').first().click();
    await expect(panel(page).getByText('Mock reply: no request is sent, so nothing is paused')).toBeVisible();
    await expect(panel(page).getByText('Mock reply: no server response to pause')).toBeVisible();
  });
});

test.describe('queue, lifecycle and deadline (G11/G03)', () => {
  test('Continue all takes one snapshot: each held request sent once, a later arrival stays queued; draft survives queue updates', async ({ page }) => {
    await launch(page);
    await addBreak(page);
    const first = [send(page, { url: '/api/echo?n=1' }), send(page, { transport: 'xhr', url: '/api/echo?n=2' })];
    await openPaused(page, 2);
    await fill(page, { 'aw-p-url': `${A}/api/echo?draft=kept` });
    const late = send(page, { url: '/api/echo?n=3' });
    await expect(panel(page).getByRole('heading', { name: 'Paused requests' }).locator('..').getByText('3 / 20')).toBeVisible();
    expect(await panel(page).locator('#aw-p-url').inputValue()).toBe(`${A}/api/echo?draft=kept`);
    await button(page, 'Continue all unchanged').click();
    for (const r of await Promise.all([...first, late])) expect(r.status).toBe(200);
    expect(await hits(page, '/api/echo')).toBe(3);
    const after = send(page, { url: '/api/echo?n=4' });
    await expect(panel(page).getByText('1 / 20')).toBeVisible();
    expect(await hits(page, '/api/echo')).toBe(3);
    await expect(button(page, 'Continue original')).toHaveCount(0); // the ended selection stays inspectable
    await panel(page).locator('button[data-pause]').first().click(); // waiting rows come first
    await button(page, 'Continue original').click();
    await after;
    expect(await hits(page, '/api/echo')).toBe(4);
  });

  test('stale snapshot: editing the rule while paused is visible and does not change the held request', async ({ page }) => {
    await launch(page);
    await addBreak(page);
    const p = send(page, { url: '/api/echo', headers: { 'X-Test': 'held' } });
    await openPaused(page);
    await tab(page, 'Intercept');
    await panel(page).getByRole('button', { name: /^Edit / }).first().click();
    await panel(page).getByRole('checkbox', { name: 'Break on response' }).click();
    await saveRule(page);
    await button(page, 'Open paused requests').click();
    await expect(panel(page).getByText(/The rule was edited since this pause began\. The held request is unchanged/)).toBeVisible();
    await button(page, 'Continue original').click();
    expect(JSON.parse((await p).body.text).headers['x-test']).toBe('held');
  });

  test('Close at request stage sends the original once; Close at response stage delivers the original', async ({ page }) => {
    await launch(page);
    await addBreak(page, { path: '/api/*', response: true });
    const req = send(page, { url: '/api/echo', headers: { 'X-Test': 'orig' } });
    await openPaused(page);
    expect(await hits(page, '/api/echo')).toBe(0);
    await panel(page).getByRole('button', { name: 'Close API Workbench and remove its hooks' }).first().click();
    // The request stage also had a response breakpoint: Close released both, the response is the native one.
    const r = await req;
    expect(JSON.parse(r.body.text).headers['x-test']).toBe('orig');
    expect(await hits(page, '/api/echo')).toBe(1);
    await expect(panel(page)).toHaveCount(0);

    await launch(page);
    await activate(page, 'Intercept');
    const res = send(page, { transport: 'xhr', url: '/api/text?t=held' });
    await openPaused(page);
    await button(page, 'Continue original').click(); // request stage passed: now held at the response stage
    await panel(page).locator('button[data-pause]').first().click();
    await expect(panel(page).getByText('Response: server already replied')).toBeVisible();
    expect(await hits(page, '/api/text')).toBe(1);
    await page.evaluate(() => (window as any)[Symbol.for('api-workbench')].close());
    expect(await res).toMatchObject({ status: 200, responseText: 'held' });
    await settle(page, 200);
    expect(await hits(page, '/api/echo')).toBe(1);
    expect(await hits(page, '/api/text')).toBe(1);
  });

  test('opening a pause from the launcher keeps an unsaved editor; Back returns to it', async ({ page }) => {
    await launch(page);
    await addBreak(page);
    await newRule(page, 'Mock');
    await fill(page, { 'aw-r-label': 'Unsaved draft', 'aw-r-path': '/api/draft' });
    await panel(page).getByRole('button', { name: 'Minimize' }).click();
    const p = send(page, { url: '/api/echo' });
    await panel(page).getByRole('region', { name: 'API Workbench minimized' }).getByRole('button', { name: '1 paused — open paused requests' }).click();
    await button(page, 'Continue original').click();
    expect((await p).status).toBe(200);
    await panel(page).getByRole('button', { name: 'Back to Mock' }).click();
    await expect(panel(page).getByRole('heading', { name: 'New mock rule' })).toBeVisible();
    expect(await page.locator('#aw-r-label').inputValue()).toBe('Unsaved draft');
  });

  test('Stop all continues held work unchanged and deactivates modules', async ({ page }) => {
    await launch(page);
    await addBreak(page);
    const p = send(page, { url: '/api/echo' });
    await openPaused(page);
    await panel(page).locator('footer').getByRole('button', { name: 'Stop all' }).click();
    expect((await p).status).toBe(200);
    expect(await hits(page, '/api/echo')).toBe(1);
    await expect(panel(page).getByText('Ended: Stop all; original request sent. Nothing more can be sent from here.')).toBeVisible();
  });

  test('minimized: launcher shows the paused count; the 30 s deadline continues the original while hidden', async ({ page }) => {
    test.setTimeout(60_000);
    await launch(page);
    await addBreak(page);
    await panel(page).getByRole('button', { name: 'Minimize' }).click();
    const started = Date.now();
    const p = send(page, { url: '/api/echo' });
    const ind = panel(page).getByRole('region', { name: 'API Workbench minimized' }).getByRole('button', { name: '1 paused — open paused requests' });
    await expect(ind).toBeVisible();
    await expect(panel(page).getByRole('region', { name: 'API Workbench minimized' })).toContainText('1 paused');
    await ind.focus();
    await page.keyboard.press('Enter'); // keyboard reachable; opening does not extend the deadline
    await expect(panel(page).getByRole('heading', { name: 'Paused requests' })).toBeVisible();
    await panel(page).getByRole('button', { name: 'Minimize' }).click();
    const r = await p;
    const waited = Date.now() - started;
    expect(r.status).toBe(200);
    expect(waited).toBeGreaterThan(29_000);
    expect(waited).toBeLessThan(40_000);
    expect(await hits(page, '/api/echo')).toBe(1);
    await panel(page).getByRole('button', { name: 'Restore API Workbench' }).click();
    await expect(panel(page).getByText('Ended: 30 s deadline reached; original request sent. Nothing more can be sent from here.')).toBeVisible();
  });
});
