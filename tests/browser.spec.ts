// R0 browser contract cases in real Chrome. Launch = evaluating the decoded generated bookmark
// (injection; NOT evidence of saved-bookmark installation).
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const A = `http://127.0.0.1:${process.env.AW_PORT ?? 4310}`;
const B = `http://127.0.0.1:${process.env.AW_OTHER_PORT ?? 4311}`;
const bookmark = readFileSync('dist/bookmark.txt', 'utf8');
const source = decodeURIComponent(bookmark.slice('javascript:'.length));

type Res = Record<string, any>;
const send = (page: Page, o: Record<string, unknown>) => page.evaluate((opts) => (window as any).fx.send(opts), o) as Promise<Res>;
const launch = (page: Page) => page.evaluate(source);
const panel = (page: Page) => page.locator('[data-api-workbench]');

async function counters(page: Page): Promise<Record<string, number>> {
  return (await page.request.get(`${A}/__counters`)).json();
}
async function hitsDelta(page: Page, fn: () => Promise<unknown>) {
  const before = await counters(page);
  await fn();
  const after = await counters(page);
  const d: Record<string, number> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if ((after[k] ?? 0) !== (before[k] ?? 0)) d[k] = (after[k] ?? 0) - (before[k] ?? 0);
  return d;
}

const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Modules' }).getByRole('button', { name, exact: true }).click();

async function fill(page: Page, fields: Record<string, string | number | undefined>) {
  for (const [id, v] of Object.entries(fields)) if (v !== undefined) await page.locator(`#${id}`).fill(String(v));
}
async function addMock(page: Page, o: { path?: string; status?: number; delay?: number; ct?: string; body?: string; activate?: boolean } = {}) {
  await tab(page, 'Mock');
  await page.getByRole('button', { name: 'Add ad-hoc rule' }).click();
  await fill(page, { 'aw-path': o.path, 'aw-status': o.status, 'aw-delay': o.delay, 'aw-ct': o.ct, 'aw-body': o.body });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  if (o.activate !== false) await activate(page, 'Mock');
}
async function addRoute(page: Page, o: { origin: string; rewrite?: string; path?: string; activate?: boolean }) {
  await tab(page, 'Route');
  await page.getByRole('button', { name: 'Add page rule' }).click();
  await fill(page, { 'aw-dest': o.origin, 'aw-rewrite': o.rewrite, 'aw-path': o.path });
  await page.getByRole('button', { name: 'Save rule' }).click();
  if (o.activate !== false) await activate(page, 'Route');
}
async function addIntercept(page: Page, o: { find: string; replace?: string; path?: string }) {
  await tab(page, 'Intercept');
  await page.getByRole('button', { name: 'Add rule', exact: true }).click();
  await fill(page, { 'aw-find': o.find, 'aw-replace': o.replace, 'aw-path': o.path });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await activate(page, 'Intercept');
}
async function editMock(page: Page, fields: Record<string, string | number>) {
  await tab(page, 'Mock');
  await page.getByRole('button', { name: /^Edit / }).click();
  await fill(page, fields);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
}
async function editPath(page: Page, module: 'Intercept', path: string) {
  await tab(page, module);
  await page.getByRole('button', { name: /^Edit / }).click();
  await fill(page, { 'aw-path': path });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
}
async function activate(page: Page, module: 'Mock' | 'Route' | 'Intercept') {
  await tab(page, module);
  await page.getByRole('button', { name: `Activate ${module} module` }).click();
  await expect(page.getByRole('button', { name: `Deactivate ${module} module` })).toBeVisible();
}
async function newestDetail(page: Page) {
  await tab(page, 'Home');
  await page.locator('[data-api-workbench] button[data-id]').first().click();
  return page.locator('[data-api-workbench] .aw-traffic li').first();
}

test.beforeEach(async ({ page }) => {
  await page.request.get(`${A}/__reset`);
  await page.goto(`${A}/fixture`);
  await page.waitForFunction(() => (window as any).fx);
});

test.describe('launch and lifecycle', () => {
  test('launch makes no network requests; modules start inactive', async ({ page }) => {
    const seen: string[] = [];
    page.on('request', (r) => seen.push(r.url()));
    await launch(page);
    await page.waitForTimeout(150);
    expect(seen).toEqual([]);
    await expect(panel(page)).toHaveCount(1);
    for (const name of ['Mock Server', 'API Interceptor', 'Page Routing']) await expect(page.locator('section', { hasText: name }).getByText('Inactive')).toBeVisible();
    await expect(page.locator('[data-api-workbench] footer')).toBeHidden();
  });

  test('relaunch restores one instance with one hook; minimize keeps modules active', async ({ page }) => {
    await launch(page);
    await page.evaluate(() => { (window as any).__firstHook = window.fetch; });
    await addMock(page);
    await page.getByRole('button', { name: 'Minimize', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Mock module active — open Mock' })).toBeVisible();
    expect((await send(page, { url: '/api/mock-target' })).body.text).toContain('mocked');
    await launch(page);
    await expect(panel(page)).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Minimize', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deactivate Mock module' })).toBeVisible();
    expect(await page.evaluate(() => window.fetch === (window as any).__firstHook)).toBe(true);
  });

  test('legacy instance present: no hooks installed, explanation shown', async ({ page }) => {
    const native = await page.evaluate(() => { (window as any).__api_workbench_7f49a1_v1__ = {}; (window as any).__nf = window.fetch; return true; });
    expect(native).toBe(true);
    await launch(page);
    await expect(page.getByText('An older API Workbench is running')).toBeVisible();
    expect(await page.evaluate(() => window.fetch === (window as any).__nf)).toBe(true);
  });

  test('Close restores native fetch/XHR and leaves a later wrapper installed and working', async ({ page }) => {
    await page.evaluate(() => { (window as any).__nf = window.fetch; (window as any).__nopen = XMLHttpRequest.prototype.open; });
    await launch(page);
    await addMock(page);
    // A third party wraps after us.
    await page.evaluate(() => { const prev = window.fetch; (window as any).__wrapped = 0; window.fetch = function (...a: Parameters<typeof fetch>) { (window as any).__wrapped++; return prev.apply(this, a); } as typeof fetch; (window as any).__later = window.fetch; });
    await page.getByRole('button', { name: 'Close API Workbench and remove its hooks' }).click();
    await expect(panel(page)).toHaveCount(0);
    const state = await page.evaluate(() => ({ later: window.fetch === (window as any).__later, xhr: XMLHttpRequest.prototype.open === (window as any).__nopen }));
    expect(state).toEqual({ later: true, xhr: true });
    const d = await hitsDelta(page, async () => {
      const r = await send(page, { url: '/api/mock-target' });
      expect(r.body.text).not.toContain('mocked'); // inert after Close
    });
    expect(d).toEqual({ '/api/mock-target': 1 });
    expect(await page.evaluate(() => (window as any).__wrapped)).toBe(1);
    // Closing without a later wrapper restores the exact native function.
    await page.evaluate(() => { window.fetch = (window as any).__nf; });
    await launch(page);
    await page.getByRole('button', { name: 'Close API Workbench and remove its hooks' }).click();
    expect(await page.evaluate(() => window.fetch === (window as any).__nf)).toBe(true);
  });
});

test.describe('native pass-through (G04/G05 subset)', () => {
  test('unmatched fetch delegates exact arguments and returns the original Response', async ({ page }) => {
    await page.evaluate(() => {
      const sentinel = new Response('sentinel');
      (window as any).__sentinel = sentinel;
      window.fetch = function (input: RequestInfo | URL, init?: RequestInit) { (window as any).__args = [input, init, arguments.length]; return Promise.resolve(sentinel); } as typeof fetch;
    });
    await launch(page);
    const same = await page.evaluate(async () => {
      const init = { method: 'POST', body: 'x', headers: { 'x-test': '1' } };
      const r = await fetch('/api/other', init);
      const [input, gotInit, n] = (window as any).__args;
      return r === (window as any).__sentinel && input === '/api/other' && gotInit === init && n === 2;
    });
    expect(same).toBe(true);
  });

  for (const responseType of ['', 'text', 'json', 'arraybuffer', 'blob']) {
    test(`unmatched XHR ${responseType || 'default'} matches the native trace`, async ({ page }) => {
      const o = { transport: 'xhr', url: '/api/echo?x=1', responseType };
      const native = await send(page, o);
      await launch(page);
      const hooked = await send(page, o);
      for (const k of ['status', 'url', 'readyState', 'responseType', 'contentType', 'trace', 'attrLoadend', 'isXhr', 'protoIntact']) expect(hooked[k], k).toEqual(native[k]);
      expect(hooked.body.kind).toBe(native.body.kind);
    });
  }

  test('sync XHR and fetch credentials/HttpOnly session pass through', async ({ page }) => {
    await send(page, { url: '/api/login', method: 'POST' });
    await launch(page);
    const sync = await send(page, { transport: 'xhr', sync: true, url: '/api/echo' });
    expect(sync.status).toBe(200);
    expect(JSON.parse(sync.responseText).session).toBe('s3cr3t-session');
    const f = await send(page, { url: '/api/echo', responseType: 'json' });
    expect(f.body.json.session).toBe('s3cr3t-session');
    const omit = await send(page, { url: '/api/echo', responseType: 'json', credentials: 'omit' });
    expect(omit.body.json.session).toBeNull();
  });

  test('signature-like headers and exact body bytes survive unchanged delegation', async ({ page }) => {
    await launch(page);
    await addMock(page); // active, but a different path
    const body = 'amount=10.00&currency=EUR&note=h%C3%A9llo';
    const r = await send(page, { method: 'POST', url: '/api/transfer', body, responseType: 'json', headers: { 'x-signature': 'sig=abc==', authorization: 'Bearer t1' } });
    expect(r.body.json.bodyText).toBe(body);
    expect(r.body.json.headers).toMatchObject({ 'x-signature': 'sig=abc==', authorization: 'Bearer t1' });
  });

  test('HTTP errors stay responses; network errors reject natively', async ({ page }) => {
    await launch(page);
    expect((await send(page, { url: '/api/status?code=503' })).status).toBe(503);
    const denied = await send(page, { url: `${B}/api/cors-denied` });
    expect(denied).toMatchObject({ ok: false, error: 'TypeError' });
  });
});

test.describe('static mock (G09 subset)', () => {
  test('fetch mock: typed fields, Unicode, zero upstream hits', async ({ page }) => {
    await launch(page);
    await addMock(page);
    const d = await hitsDelta(page, async () => {
      const r = await send(page, { url: '/api/mock-target?q=1', responseType: 'json' });
      expect(r).toMatchObject({ status: 200, contentType: 'application/json', isResponse: true, body: { json: { mocked: true, note: '✓ synthetic' } } });
    });
    expect(d).toEqual({});
    const head = await send(page, { url: '/api/mock-target', method: 'HEAD' });
    expect(head.body.text).toBe('');
  });

  for (const responseType of ['', 'text', 'json', 'arraybuffer', 'blob']) {
    test(`XHR mock ${responseType || 'default'}: legal events and value, zero hits`, async ({ page }) => {
      await launch(page);
      await addMock(page);
      const d = await hitsDelta(page, async () => {
        const r = await send(page, { transport: 'xhr', url: '/api/mock-target', responseType });
        expect(r.status).toBe(200);
        expect(r.statusText).toBe('OK');
        expect(r.readyState).toBe(4);
        expect(r.trace).toEqual(['rsc1', 'loadstart', 'rsc2', 'rsc3', 'progress', 'rsc4', 'load', 'loadend']);
        expect(r.attrLoadend).toBe(true);
        expect(r.isXhr && r.protoIntact).toBe(true);
        if (responseType === 'json') expect(r.body.json).toEqual({ mocked: true, note: '✓ synthetic' });
        else expect(r.body.text).toBe('{"mocked":true,"note":"✓ synthetic"}');
        expect(r.responseText).toBe(responseType === '' || responseType === 'text' ? '{"mocked":true,"note":"✓ synthetic"}' : 'throws:InvalidStateError');
      });
      expect(d).toEqual({});
    });
  }

  test('custom status/body and bodyless 204', async ({ page }) => {
    await launch(page);
    await addMock(page, { status: 204 });
    const r = await send(page, { transport: 'xhr', url: '/api/mock-target' });
    expect(r).toMatchObject({ status: 204, responseText: '' });
    await editMock(page, { 'aw-status': 503, 'aw-body': 'down', 'aw-ct': 'text/plain' });
    const f = await send(page, { url: '/api/mock-target' });
    expect(f).toMatchObject({ ok: true, status: 503, body: { text: 'down' } });
    // Invalid save stays in the editor and leaves the live rule unchanged.
    await page.getByRole('button', { name: /^Edit / }).click();
    await page.locator('#aw-status').fill('700');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#aw-status-err')).toHaveText('Status must be an integer from 200 to 599');
    await expect(page.locator('#aw-status')).toBeFocused();
    expect((await send(page, { url: '/api/mock-target' })).status).toBe(503);
  });

  test('abort before and during delay settles once; XHR timeout during delay', async ({ page }) => {
    await launch(page);
    await addMock(page, { delay: 800 });
    const d = await hitsDelta(page, async () => {
      const f = await send(page, { url: '/api/mock-target', abortAfterMs: 100 });
      expect(f).toMatchObject({ ok: false, error: 'AbortError' });
      expect(f.ms).toBeLessThan(700);
      const pre = await page.evaluate(async () => { try { await fetch('/api/mock-target', { signal: AbortSignal.abort() }); return 'resolved'; } catch (e) { return (e as Error).name; } });
      expect(pre).toBe('AbortError');
      const x = await send(page, { transport: 'xhr', url: '/api/mock-target', abortAfterMs: 100 });
      expect(x.trace).toEqual(['rsc1', 'loadstart', 'rsc4', 'abort', 'loadend']);
      expect(x.readyState).toBe(0);
      const t = await send(page, { transport: 'xhr', url: '/api/mock-target', timeout: 200 });
      expect(t.trace).toEqual(['rsc1', 'loadstart', 'rsc4', 'timeout', 'loadend']);
      expect(t.status).toBe(0);
    });
    expect(d).toEqual({});
  });

  test('Close during synthetic delay settles promptly with the selected reply, not real traffic', async ({ page }) => {
    await launch(page);
    await addMock(page, { delay: 5000 });
    const d = await hitsDelta(page, async () => {
      const pending = Promise.all([send(page, { url: '/api/mock-target' }), send(page, { transport: 'xhr', url: '/api/mock-target' })]);
      await page.waitForTimeout(100);
      await page.getByRole('button', { name: 'Close API Workbench and remove its hooks' }).click();
      const [f, x] = await pending;
      expect(f.body.text).toContain('mocked');
      expect(x.responseText).toContain('mocked');
      expect(f.ms).toBeLessThan(2000);
    });
    expect(d).toEqual({});
  });
});

test.describe('route (G06/G12 subset)', () => {
  test('fetch route: once to destination, query kept, cross-origin Authorization removed', async ({ page }) => {
    await launch(page);
    await addRoute(page, { origin: B, rewrite: '/api/routed' });
    const d = await hitsDelta(page, async () => {
      const r = await send(page, { url: '/api/mock-target?a=1&a=2', responseType: 'json', headers: { authorization: 'Bearer secret', 'x-test': 'kept' } });
      expect(r.body.json).toMatchObject({ servedBy: 'B', path: '/api/routed', query: [['a', '1'], ['a', '2']], headers: { authorization: null, 'x-test': 'kept' } });
      expect(r.url).toBe(`${B}/api/routed?a=1&a=2`);
    });
    expect(d).toEqual({ '/api/routed': 1, 'OPTIONS /api/routed': 1 });
    const detail = await newestDetail(page);
    await expect(detail).toContainText('Authorization removed');
    await expect(detail).toContainText(/Route\s*applied/);
  });

  test('same-origin route keeps Authorization and session cookie', async ({ page }) => {
    await send(page, { url: '/api/login', method: 'POST' });
    await launch(page);
    await addRoute(page, { origin: A, rewrite: '/api/r0-routed' });
    for (const transport of ['fetch', 'xhr']) {
      const r = await send(page, { transport, url: '/api/mock-target', responseType: 'json', headers: { authorization: 'Bearer t' } });
      expect(r.body.json).toMatchObject({ path: '/api/r0-routed', session: 's3cr3t-session', headers: { authorization: 'Bearer t' } });
    }
  });

  for (const responseType of ['', 'text', 'json', 'arraybuffer', 'blob']) {
    test(`XHR ${responseType || 'default'} route keeps native typed response and native events`, async ({ page }) => {
      const nativeTrace = (await send(page, { transport: 'xhr', url: '/api/echo', responseType })).trace;
      await launch(page);
      await addRoute(page, { origin: A, rewrite: '/api/r0-routed' });
      const d = await hitsDelta(page, async () => {
        const r = await send(page, { transport: 'xhr', url: '/api/mock-target?z=9', responseType });
        expect(r.status).toBe(200);
        expect(r.url).toBe(`${A}/api/r0-routed?z=9`);
        expect(r.trace).toEqual(nativeTrace);
        expect(r.body.kind).toBe(responseType === '' || responseType === 'text' ? 'text' : responseType);
        const parsed = responseType === 'json' ? r.body.json : JSON.parse(r.body.text);
        expect(parsed).toMatchObject({ path: '/api/r0-routed', query: [['z', '9']] });
      });
      expect(d).toEqual({ '/api/r0-routed': 1 });
    });
  }

  test('arraybuffer XHR: route applied while text transform is visibly skipped', async ({ page }) => {
    await launch(page);
    await addRoute(page, { origin: A, rewrite: '/api/r0-routed' });
    await addIntercept(page, { find: 'r0-routed', replace: 'EDITED' });
    const r = await send(page, { transport: 'xhr', url: '/api/mock-target', responseType: 'arraybuffer' });
    expect(r.body.kind).toBe('arraybuffer');
    expect(r.body.text).toContain('/api/r0-routed'); // unedited native bytes
    const detail = await newestDetail(page);
    await expect(detail).toContainText(/Route\s*applied/);
    await expect(detail).toContainText(/Intercept\s*skipped/);
    await expect(detail).toContainText('arraybuffer response cannot be edited as text');
  });

  test('prebuilt Request POST routes with exact bytes; >1 MiB body skips route and sends original once', async ({ page }) => {
    await launch(page);
    await addRoute(page, { origin: A, rewrite: '/api/r0-routed' });
    const small = await page.evaluate(async () => {
      const body = new Uint8Array(70_000).map((_, i) => (i * 7) % 256);
      const res = await fetch(new Request('/api/mock-target', { method: 'POST', body, headers: { 'content-type': 'application/octet-stream' } }));
      const h = await crypto.subtle.digest('SHA-256', body);
      return { echo: await res.json(), sha: Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('') };
    });
    expect(small.echo).toMatchObject({ path: '/api/r0-routed', bodyBytes: 70_000, bodySha256: small.sha });
    const d = await hitsDelta(page, async () => {
      const big = await page.evaluate(async () => {
        const res = await fetch(new Request('/api/mock-target', { method: 'POST', body: new Uint8Array(2 * 1024 * 1024) }));
        return res.json();
      });
      expect(big).toMatchObject({ path: '/api/mock-target', bodyBytes: 2 * 1024 * 1024 });
    });
    expect(d).toEqual({ '/api/mock-target': 1 });
    await expect(await newestDetail(page)).toContainText('exceeds 1048576 bytes; original request sent once');
  });

  test('URL+init POST forwards caller body unchanged', async ({ page }) => {
    await launch(page);
    await addRoute(page, { origin: A, rewrite: '/api/r0-routed' });
    const r = await send(page, { method: 'POST', url: '/api/mock-target', body: '{"amount":"10.00"}', responseType: 'json', headers: { 'content-type': 'application/json' } });
    expect(r.body.json).toMatchObject({ path: '/api/r0-routed', bodyText: '{"amount":"10.00"}' });
  });

  test('mock supersedes route: no hit at either endpoint, reason shown', async ({ page }) => {
    await launch(page);
    await addRoute(page, { origin: A, rewrite: '/api/r0-routed' });
    await addMock(page);
    const d = await hitsDelta(page, () => send(page, { transport: 'xhr', url: '/api/mock-target', responseType: 'arraybuffer' }));
    expect(d).toEqual({});
    const detail = await newestDetail(page);
    await expect(detail).toContainText(/Route\s*superseded/);
    await expect(detail).toContainText(/Mock\s*applied/);
  });

  test('invalid destination cannot be saved; nothing is routed', async ({ page }) => {
    await launch(page);
    await tab(page, 'Route');
    await page.getByRole('button', { name: 'Add page rule' }).click();
    await fill(page, { 'aw-dest': 'http://b.test/with/path' });
    await page.getByRole('button', { name: 'Save rule' }).click();
    await expect(page.locator('#aw-dest-err')).toHaveText('Enter only the origin; use Path rewrite for the path');
    await expect(page.getByRole('button', { name: 'Activate Route module' })).toBeDisabled();
    const d = await hitsDelta(page, () => send(page, { url: '/api/mock-target' }));
    expect(d).toEqual({ '/api/mock-target': 1 });
  });

  test('rule enabled and module active are independent; Stop all deactivates', async ({ page }) => {
    await launch(page);
    await addRoute(page, { origin: A, rewrite: '/api/r0-routed', activate: false });
    expect((await send(page, { url: '/api/mock-target', responseType: 'json' })).body.json.path).toBe('/api/mock-target');
    await activate(page, 'Route');
    expect((await send(page, { url: '/api/mock-target', responseType: 'json' })).body.json.path).toBe('/api/r0-routed');
    await page.getByRole('checkbox', { name: /^Enable / }).click();
    expect((await send(page, { url: '/api/mock-target', responseType: 'json' })).body.json.path).toBe('/api/mock-target');
    await page.getByRole('checkbox', { name: /^Enable / }).click();
    await page.getByRole('button', { name: 'Stop all' }).click();
    await expect(page.getByRole('button', { name: 'Activate Route module' })).toBeVisible();
    expect((await send(page, { url: '/api/mock-target', responseType: 'json' })).body.json.path).toBe('/api/mock-target');
  });

  test('dirty editor: navigation asks; Keep editing retains the draft, Discard leaves', async ({ page }) => {
    await launch(page);
    await tab(page, 'Mock');
    await page.getByRole('button', { name: 'Add ad-hoc rule' }).click();
    await page.locator('#aw-body').fill('draft body');
    await tab(page, 'Route');
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.locator('#aw-body')).toHaveValue('draft body');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByRole('heading', { name: 'Mock Server' })).toBeVisible();
    await expect(page.getByText('No ad-hoc rules')).toBeVisible();
  });
});

test.describe('bounded body handling (G07/G25 subset)', () => {
  test('fetch text transform applies within bounds', async ({ page }) => {
    await launch(page);
    await addIntercept(page, { path: '/api/text', find: 'server', replace: 'workbench ✓' });
    const r = await send(page, { url: '/api/text' });
    expect(r.body.text).toBe('hello from workbench ✓');
  });

  test('oversized, slow unknown-length and binary responses are delivered complete and untouched', async ({ page }) => {
    await launch(page);
    await addIntercept(page, { path: '/api/big', find: 'a', replace: 'b' });

    const big = await send(page, { url: '/api/big?n=4194304' });
    expect(big.body.bytes).toBe(4 * 1024 * 1024);
    expect(big.body.text.startsWith('aaaa')).toBe(true);
    await expect(await newestDetail(page)).toContainText('exceeds 1048576 bytes');

    await editPath(page, 'Intercept', '/api/stream');
    const slow = await send(page, { url: '/api/stream?parts=12&gap=250' });
    expect(slow.body.text).toBe(Array.from({ length: 12 }, (_, i) => `chunk${i};`).join(''));
    await expect(await newestDetail(page)).toContainText('not complete within 2000 ms');

    await editPath(page, 'Intercept', '/api/binary');
    const bin = await send(page, { url: '/api/binary?n=1000', responseType: 'arraybuffer' });
    expect(bin.body.bytes).toBe(1000);
    await expect(await newestDetail(page)).toContainText('is not text');
  });
});

test.describe('policy pages (G25 subset, injected launch)', () => {
  test('strict CSP: panel styled, same-origin fetch works', async ({ page }) => {
    await page.goto(`${A}/policy/strict`);
    await page.waitForFunction(() => (window as any).fx);
    await launch(page);
    const bg = await page.locator('[data-api-workbench] .aw-panel').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(9, 9, 11)');
    await addMock(page);
    expect((await send(page, { url: '/api/mock-target' })).body.text).toContain('mocked');
    expect((await send(page, { url: '/api/echo' })).status).toBe(200);
  });

  test('blocked-connect CSP: native fetch rejects, local mock still answers', async ({ page }) => {
    await page.goto(`${A}/policy/blocked-connect`);
    await page.waitForFunction(() => (window as any).fx);
    await launch(page);
    expect(await send(page, { url: '/api/echo' })).toMatchObject({ ok: false, error: 'TypeError' });
    await addMock(page);
    expect((await send(page, { url: '/api/mock-target' })).body.text).toContain('mocked');
  });
});

test.describe('activity', () => {
  test('records are bounded in the view and query values are hidden', async ({ page }) => {
    await launch(page);
    await page.evaluate(async () => { await Promise.all(Array.from({ length: 60 }, (_, i) => fetch(`/api/echo?token=secret${i}`))); });
    await expect(page.locator('[data-api-workbench] button[data-id]')).toHaveCount(50);
    await expect(page.getByText('Showing latest 50 of 60')).toBeVisible();
    expect(await panel(page).evaluate((el) => el.shadowRoot!.textContent!.includes('secret'))).toBe(false);
  });
});
