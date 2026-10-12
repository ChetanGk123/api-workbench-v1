// R4 rule modules in real Chrome, driven through the panel UI and checked against native page
// calls and server counters outside the hooks. Launch = evaluating the decoded generated bookmark.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { activate, addMock, fill, newRule, panel, saveRule, select, tab } from './rule-helpers';

const A = `http://127.0.0.1:${process.env.AW_PORT ?? 4310}`;
const B = `http://127.0.0.1:${process.env.AW_OTHER_PORT ?? 4311}`;
const source = decodeURIComponent(readFileSync('dist/bookmark.txt', 'utf8').slice('javascript:'.length));
const launch = (page: Page) => page.evaluate(source);
type Res = Record<string, any>;
const send = (page: Page, o: Record<string, unknown>) => page.evaluate((opts) => (window as any).fx.send(opts), o) as Promise<Res>;
const counters = async (page: Page): Promise<Record<string, number>> => (await page.request.get(`${A}/__counters`)).json();
const hits = async (page: Page, key: string) => (await counters(page))[key] ?? 0;
const settle = (page: Page, ms: number) => page.evaluate((t) => new Promise((r) => setTimeout(r, t)), ms);

async function addChaos(page: Page, o: { path?: string; fault: string; mode?: string; params?: Record<string, string | number>; sampling?: Record<string, string | number>; activate?: boolean }) {
  await newRule(page, 'Chaos');
  await fill(page, { 'aw-r-path': o.path ?? '/api/echo' });
  await select(page, 'aw-chaos-fault', o.fault);
  if (o.mode) await select(page, 'aw-chaos-mode', o.mode);
  await fill(page, o.params ?? {});
  if (o.sampling) {
    await panel(page).getByText('Sampling, budget and duration').click();
    await fill(page, o.sampling);
  }
  await saveRule(page);
  if (o.activate !== false) await activate(page, 'Chaos');
}

async function newestDetail(page: Page) {
  await tab(page, 'Home');
  await panel(page).locator('button[data-id]').first().click();
  return panel(page).locator('.aw-detail');
}

test.beforeEach(async ({ page }) => {
  await page.request.get(`${A}/__reset`);
  await page.goto(`${A}/fixture`);
  await page.waitForFunction(() => (window as any).fx);
});

test.describe('mock sequences (G09)', () => {
  test('sequence replies in arrival order on both transports, then explicit failure; zero upstream hits', async ({ page }) => {
    await launch(page);
    await newRule(page, 'Mock');
    await fill(page, { 'aw-r-path': '/api/seq/*', 'aw-slot-0-body': '{"n":1,"u":"日本 ✓"}' });
    await select(page, 'aw-r-mode', 'sequence');
    await page.getByRole('button', { name: 'Add reply', exact: true }).click();
    await fill(page, { 'aw-slot-1-status': 503, 'aw-slot-1-body': 'down' });
    await select(page, 'aw-r-exhaust', 'network-error');
    await saveRule(page);
    await activate(page, 'Mock');
    await expect(panel(page).getByText('next reply 1 of 2')).toBeVisible();
    const a = await send(page, { url: '/api/seq/1', responseType: 'json' });
    const b = await send(page, { transport: 'xhr', url: '/api/seq/2' });
    const c = await send(page, { url: '/api/seq/3' });
    const d = await send(page, { transport: 'xhr', url: '/api/seq/4' });
    expect(a).toMatchObject({ ok: true, status: 200, body: { json: { n: 1, u: '日本 ✓' } } });
    expect(b).toMatchObject({ status: 503, responseText: 'down', statusText: 'Service Unavailable' });
    expect(c).toMatchObject({ ok: false, error: 'TypeError' });
    expect(d.trace).toEqual(['rsc1', 'loadstart', 'rsc4', 'error', 'loadend']);
    expect(await counters(page)).toEqual({});
    await tab(page, 'Mock');
    await expect(panel(page).getByText('exhausted: network error')).toBeVisible();
    await page.getByRole('button', { name: 'Deactivate Mock module' }).click();
    await activate(page, 'Mock'); // activation restarts the sequence
    expect((await send(page, { url: '/api/seq/5' })).status).toBe(200);
  });

  test('timeout slot: fetch rejects with TimeoutError, XHR fires timeout; rules persist across reload, modules do not', async ({ page }) => {
    await launch(page);
    await newRule(page, 'Mock');
    await fill(page, { 'aw-r-path': '/api/slow-mock', 'aw-slot-0-delay': 200 });
    await select(page, 'aw-slot-0-fault', 'timeout');
    await saveRule(page);
    await activate(page, 'Mock');
    expect(await send(page, { url: '/api/slow-mock' })).toMatchObject({ ok: false, error: 'TimeoutError' });
    expect((await send(page, { transport: 'xhr', url: '/api/slow-mock' })).trace).toEqual(['rsc1', 'loadstart', 'rsc4', 'timeout', 'loadend']);
    await page.reload();
    await page.waitForFunction(() => (window as any).fx);
    await launch(page);
    await tab(page, 'Mock');
    await expect(page.getByRole('button', { name: 'Edit Any /api/slow-mock' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Activate Mock module' })).toBeVisible();
    expect((await send(page, { url: '/api/slow-mock' })).status).toBe(200); // inactive: the real (echo) server answers
    expect(await hits(page, '/api/slow-mock')).toBe(1);
  });

  test('Format JSON appears only for valid, unformatted reply bodies and formats in place', async ({ page }) => {
    await page.evaluate(source);
    await newRule(page, 'Mock');
    const body = page.locator('#aw-slot-0-body');
    const format = page.getByRole('button', { name: 'Format reply 1 body as JSON' });
    await expect(format).toBeHidden(); // default "{}" is already formatted
    await body.fill('{"a":1,"b":[1,2]}');
    await expect(format).toBeVisible();
    await format.click();
    await expect(body).toHaveValue('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
    await expect(format).toBeHidden();
    await body.fill('{"data":[{"m":1},],"icon":"success"}'); // trailing comma: offered as Fix & format
    const fix = page.getByRole('button', { name: 'Format reply 1 body as JSON, removing trailing commas' });
    await expect(fix).toHaveText('Fix & format');
    await fix.click();
    await expect(body).toHaveValue('{\n  "data": [\n    {\n      "m": 1\n    }\n  ],\n  "icon": "success"\n}');
    await body.fill('not json');
    await expect(format).toBeHidden();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Discard' }).click();

    // Same control on intercept JSON Patch and the endpoint JSON body.
    await newRule(page, 'Intercept');
    const patch = page.locator('#aw-request-patch');
    await patch.fill('[{"op":"add","path":"/a","value":1}]');
    await page.getByRole('button', { name: 'Format request JSON Patch' }).click();
    await expect(patch).toHaveValue('[\n  {\n    "op": "add",\n    "path": "/a",\n    "value": 1\n  }\n]');
    await expect(page.getByRole('button', { name: 'Format request JSON Patch' })).toBeHidden();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Discard' }).click();
    await tab(page, 'Home');
    await page.getByRole('button', { name: 'Endpoints', exact: true }).click();
    await page.getByRole('button', { name: 'Add endpoint', exact: true }).click();
    await page.locator('#aw-ep-bodykind').selectOption('json');
    await page.locator('#aw-ep-body').fill('{"x":[1]}');
    await page.getByRole('button', { name: 'Format request body as JSON' }).click();
    await expect(page.locator('#aw-ep-body')).toHaveValue('{\n  "x": [\n    1\n  ]\n}');
  });

  test('from endpoint: linked rule copies the sample and follows the endpoint path by ID', async ({ page }) => {
    await launch(page);
    await page.getByRole('button', { name: 'Endpoints', exact: true }).first().click();
    await page.getByRole('button', { name: 'Add endpoint' }).click();
    await fill(page, { 'aw-ep-name': 'Accounts', 'aw-ep-alias': 'accounts', 'aw-ep-url': '/api/accounts' });
    await saveRule(page);
    await tab(page, 'Mock');
    await page.getByLabel('New rule from endpoint').selectOption({ label: 'GET Accounts' });
    await expect(page.locator('#aw-r-path')).toBeDisabled();
    await expect(panel(page)).toContainText('has no saved sample');
    await fill(page, { 'aw-slot-0-body': '{"linked":true}' });
    await saveRule(page);
    await activate(page, 'Mock');
    expect((await send(page, { url: '/api/accounts' })).body.text).toBe('{"linked":true}');
    await tab(page, 'Home');
    await page.getByRole('button', { name: 'Endpoints', exact: true }).first().click();
    await page.getByRole('button', { name: /^Edit Accounts/ }).click();
    await fill(page, { 'aw-ep-url': '/api/accounts/v2' });
    await saveRule(page);
    expect((await send(page, { url: '/api/accounts/v2' })).body.text).toBe('{"linked":true}');
    expect((await send(page, { url: '/api/accounts' })).status).toBe(200);
    expect(await hits(page, '/api/accounts')).toBe(1);
  });
});

test.describe('intercept (G10)', () => {
  test('request headers and JSON body edited before send; response status/header/JSON edited after', async ({ page }) => {
    await launch(page);
    await newRule(page, 'Intercept');
    await fill(page, { 'aw-r-path': '/api/echo' });
    await page.getByRole('button', { name: 'Add request header' }).click();
    await page.getByLabel('request header 1 name').fill('X-Added');
    await page.getByLabel('request header 1 value').fill('yes');
    await fill(page, { 'aw-request-remove': 'X-Test', 'aw-request-patch': '[{"op":"replace","path":"/amount","value":5}]' });
    await fill(page, { 'aw-response-status': 202, 'aw-response-patch': '[{"op":"replace","path":"/unicode","value":"patched ✓"}]' });
    await saveRule(page);
    await activate(page, 'Intercept');
    for (const transport of ['fetch', 'xhr']) {
      const r = await send(page, { transport, url: '/api/echo', method: 'POST', headers: { 'X-Test': 'gone', 'Content-Type': 'application/json' }, body: '{"amount":1}', responseType: 'json' });
      expect(r.status).toBe(202);
      expect(r.body.json).toMatchObject({ unicode: 'patched ✓', bodyText: '{"amount":5}', headers: { 'x-added': 'yes', 'x-test': null } });
    }
    const d = await newestDetail(page);
    await expect(d).toContainText(/Intercept request\s*applied/);
    await expect(d).toContainText(/Intercept response\s*applied/);
  });

  test('failed patch delivers the original; binary keeps native bytes while header edits apply', async ({ page }) => {
    await launch(page);
    await newRule(page, 'Intercept');
    await fill(page, { 'aw-r-path': '/api/**', 'aw-response-patch': '[{"op":"test","path":"/servedBy","value":"nobody"},{"op":"remove","path":"/unicode"}]' });
    await page.getByRole('button', { name: 'Add response header' }).click();
    await page.getByLabel('response header 1 name').fill('X-Edited');
    await page.getByLabel('response header 1 value').fill('1');
    await saveRule(page);
    await activate(page, 'Intercept');
    const r = await send(page, { url: '/api/echo', responseType: 'json' });
    expect(r.body.json.unicode).toBe('héllo ✓ 日本');
    let d = await newestDetail(page);
    await expect(d).toContainText('JSON Patch operation 1 failed');
    const bin = await send(page, { transport: 'xhr', url: '/api/binary?n=300', responseType: 'arraybuffer' });
    expect(bin.body).toMatchObject({ kind: 'arraybuffer', bytes: 300 });
    const f = await send(page, { url: '/api/binary?n=300', responseType: 'arraybuffer' });
    expect(f.body).toMatchObject({ kind: 'arraybuffer', bytes: 300 });
    d = await newestDetail(page);
    await expect(d).toContainText('body skipped: content type "application/octet-stream" is not text');
  });
});

test.describe('route (G12)', () => {
  test('glob /** capture rewrite to another origin: query kept, Authorization forwarded only when chosen, blob XHR native', async ({ page }) => {
    await launch(page);
    await newRule(page, 'Route');
    await fill(page, { 'aw-r-path': '/api/v1/**', 'aw-route-dest': B, 'aw-route-rewrite': '/api/v2/**', 'aw-route-example': `${A}/api/v1/a/b?x=1&x=2` });
    await expect(panel(page)).toContainText(`→ ${B}/api/v2/a/b?x=1&x=2`);
    await saveRule(page);
    await activate(page, 'Route');
    const r = await send(page, { url: '/api/v1/a/b?x=1&x=2', headers: { Authorization: 'Bearer t' }, responseType: 'json' });
    expect(r.body.json).toMatchObject({ servedBy: 'B', path: '/api/v2/a/b', query: [['x', '1'], ['x', '2']], headers: { authorization: null } });
    const blob = await send(page, { transport: 'xhr', url: '/api/v1/binary?n=64', responseType: 'blob' });
    expect(blob).toMatchObject({ servedBy: 'B', status: 200, isXhr: true, body: { kind: 'blob', type: 'application/json' } });
    expect(await hits(page, '/api/v2/binary')).toBe(1);
    await page.getByRole('button', { name: /^Edit / }).click();
    await page.getByRole('checkbox', { name: 'Forward Authorization to this destination' }).click();
    await saveRule(page);
    for (const transport of ['fetch', 'xhr']) {
      const k = await send(page, { transport, url: '/api/v1/z', headers: { Authorization: 'Bearer t' }, responseType: 'json' });
      expect(k.body.json.headers.authorization).toBe('Bearer t');
    }
  });
});

test.describe('chaos (G13)', () => {
  test('preset opens a draft and changes nothing until saved with a matcher', async ({ page }) => {
    await launch(page);
    await tab(page, 'Chaos');
    await page.getByRole('button', { name: 'Service unavailable 503' }).click();
    await expect(page.locator('#aw-r-label')).toHaveValue('Service unavailable 503');
    await saveRule(page);
    await expect(page.locator('#aw-r-path-err')).toHaveText('Required');
    await fill(page, { 'aw-r-path': '/api/echo' });
    await saveRule(page);
    expect((await send(page, { url: '/api/echo' })).status).toBe(200); // saved, still inactive
    await activate(page, 'Chaos');
    const r = await send(page, { url: '/api/echo' });
    const x = await send(page, { transport: 'xhr', url: '/api/echo' });
    expect([r.status, x.status]).toEqual([503, 503]);
    expect(await hits(page, '/api/echo')).toBe(1); // only the pre-activation call
  });

  test('synthetic timeout and network failure send nothing; real failures send once and say so', async ({ page }) => {
    await launch(page);
    await addChaos(page, { path: '/api/a', fault: 'timeout', params: { 'aw-chaos-fault-timeoutMs': 150 } });
    await addChaos(page, { path: '/api/b', fault: 'network-error', mode: 'real', activate: false });
    await addChaos(page, { path: '/api/c', fault: 'status', mode: 'real', params: { 'aw-chaos-fault-status': 500 }, activate: false });
    expect(await send(page, { url: '/api/a' })).toMatchObject({ ok: false, error: 'TimeoutError' });
    expect((await send(page, { transport: 'xhr', url: '/api/a' })).trace).toEqual(['rsc1', 'loadstart', 'rsc4', 'timeout', 'loadend']);
    expect(await send(page, { url: '/api/b' })).toMatchObject({ ok: false, error: 'TypeError' });
    expect((await send(page, { transport: 'xhr', url: '/api/b' })).trace).toEqual(['rsc1', 'loadstart', 'rsc4', 'error', 'loadend']);
    expect((await send(page, { url: '/api/c' })).status).toBe(500);
    expect((await send(page, { transport: 'xhr', url: '/api/c', responseType: 'json' })).status).toBe(500);
    expect(await counters(page)).toEqual({ '/api/b': 2, '/api/c': 2 });
    const d = await newestDetail(page);
    await expect(d).toContainText('upstream effects stand');
  });

  test('real latency delays delivery after the response; probability 0 is sampled out; budget ends faults', async ({ page }) => {
    await launch(page);
    await addChaos(page, { path: '/api/slow', fault: 'latency', mode: 'real', params: { 'aw-chaos-fault-delayMs': 400 } });
    const t = await send(page, { url: '/api/slow?ms=0' });
    const x = await send(page, { transport: 'xhr', url: '/api/slow?ms=0', responseType: 'arraybuffer' });
    expect(t.ms).toBeGreaterThanOrEqual(390);
    expect(x).toMatchObject({ status: 200, body: { kind: 'arraybuffer' } });
    expect(x.ms).toBeGreaterThanOrEqual(390);
    await addChaos(page, { path: '/api/never', fault: 'status', sampling: { 'aw-chaos-probability': 0 }, activate: false });
    expect((await send(page, { url: '/api/never' })).status).toBe(200);
    let d = await newestDetail(page);
    await expect(d).toContainText(/Chaos\s*sampled-out/);
    await addChaos(page, { path: '/api/once', fault: 'status', sampling: { 'aw-chaos-budget': 1 }, activate: false });
    expect([(await send(page, { url: '/api/once' })).status, (await send(page, { url: '/api/once' })).status]).toEqual([503, 200]);
    d = await newestDetail(page);
    await expect(d).toContainText('hit budget 1 used');
    await tab(page, 'Chaos');
    await expect(panel(page)).toContainText('1/1 hits used');
  });

  test('corrupt valid JSON field on real traffic; malformed JSON delivered exactly', async ({ page }) => {
    await launch(page);
    await addChaos(page, { path: '/api/echo', fault: 'corrupt-json', params: { 'aw-chaos-patch': '[{"op":"replace","path":"/servedBy","value":null}]' } });
    for (const transport of ['fetch', 'xhr']) expect((await send(page, { transport, url: '/api/echo', responseType: 'json' })).body.json).toMatchObject({ servedBy: null, unicode: 'héllo ✓ 日本' });
    await addChaos(page, { path: '/api/text', fault: 'malformed-json', mode: 'synthetic', activate: false });
    expect((await send(page, { url: '/api/text' })).body.text).toBe('{"data": [1, 2,');
    expect(await hits(page, '/api/text')).toBe(0);
  });

  test('replay: primary plus copies hit the server, idempotency keeps one logical transfer, page sees one response', async ({ page }) => {
    await launch(page);
    await addChaos(page, { path: '/api/idempotent-transfer', fault: 'replay', params: { 'aw-chaos-fault-copies': 2 } });
    for (const [i, transport] of ['fetch', 'xhr'].entries()) {
      const r = await send(page, { transport, url: '/api/idempotent-transfer', method: 'POST', headers: { 'Idempotency-Key': `k${i}` }, body: '{"amount":10}', responseType: 'json' });
      expect(r.body.json).toEqual({ key: `k${i}`, duplicate: false });
    }
    await expect.poll(() => hits(page, '/api/idempotent-transfer')).toBe(6);
    expect(await hits(page, 'transfer:logical')).toBe(2);
    const d = await newestDetail(page);
    await d.getByRole('button', { name: /^Open primary/ }).click();
    await expect(d).toContainText(/Primary sent; 2 of 2 copies sent with fetch/);
    await expect(d.getByRole('button', { name: /^Copy #\d+: HTTP 200/ })).toHaveCount(2);
  });

  test('deactivating Chaos or closing during the replay gap sends no further copy', async ({ page }) => {
    await launch(page);
    await addChaos(page, { path: '/api/idempotent-transfer', fault: 'replay', params: { 'aw-chaos-fault-copies': 2, 'aw-chaos-fault-gapMs': 600 } });
    await send(page, { url: '/api/idempotent-transfer', method: 'POST', body: 'x' });
    await page.getByRole('button', { name: 'Deactivate Chaos module' }).click();
    await settle(page, 1500);
    expect(await hits(page, '/api/idempotent-transfer')).toBe(1);
    await activate(page, 'Chaos');
    await send(page, { url: '/api/idempotent-transfer', method: 'POST', body: 'x' });
    await settle(page, 700); // first copy has gone
    await page.getByRole('button', { name: 'Close API Workbench and remove its hooks' }).click();
    await settle(page, 1000);
    expect(await hits(page, '/api/idempotent-transfer')).toBe(3);
  });
});
