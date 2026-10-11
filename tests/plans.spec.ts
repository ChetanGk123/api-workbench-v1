// R6 cases in real Chrome: plans built in the UI (Flow/Independent/setup/Stop), Results and export,
// page-context scan, and the banking-style fixture journey (auth refresh, CSRF rotation, signing,
// idempotency, polling, cross-step assertions, binary receipt). Launch = evaluating the generated
// bookmark (injection; NOT saved-bookmark evidence).
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { bankProfile } from './bank-profile';

const A = `http://127.0.0.1:${process.env.AW_PORT ?? 4310}`;
const source = decodeURIComponent(readFileSync('dist/bookmark.txt', 'utf8').slice('javascript:'.length));
const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Modules' }).getByRole('button', { name, exact: true }).click();
const button = (page: Page, name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' });
const counters = async (page: Page): Promise<Record<string, number>> => (await page.request.get(`${A}/__counters`)).json();
const foot = (page: Page) => page.locator('[data-api-workbench] footer');

async function launch(page: Page) {
  await page.evaluate(source);
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await expect(page.locator('#aw-store-state')).toHaveText(/All changes saved|Storage unavailable/);
  await tab(page, 'Home');
}
test.beforeEach(async ({ page }) => {
  await page.request.get(`${A}/__reset`);
  await page.goto(`${A}/fixture`);
  await page.evaluate(() => Promise.all(['api-workbench-v2', 'api-workbench'].map((n) => new Promise((r) => { const q = indexedDB.deleteDatabase(n); q.onsuccess = q.onerror = q.onblocked = r; }))));
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
});

async function addEndpoint(page: Page, o: { name: string; alias: string; method?: string; url: string; body?: string }) {
  await tab(page, 'Home');
  await page.getByRole('button', { name: 'Endpoints', exact: true }).click();
  await button(page, 'Add endpoint').click();
  await page.locator('#aw-ep-name').fill(o.name);
  await page.locator('#aw-ep-alias').fill(o.alias);
  if (o.method) await page.locator('#aw-ep-method').selectOption(o.method);
  await page.locator('#aw-ep-url').fill(o.url);
  if (o.body !== undefined) { await page.locator('#aw-ep-bodykind').selectOption('json'); await page.locator('#aw-ep-body').fill(o.body); }
  await button(page, 'Save').click();
  await expect(page.getByRole('heading', { name: 'Endpoints' })).toBeVisible();
}
async function openPlans(page: Page) {
  await tab(page, 'Test');
  await page.locator('[data-key="view-plans"]').click();
  await expect(page.getByRole('heading', { name: 'Plans' })).toBeVisible();
}
async function waitRun(page: Page, state: string | RegExp = 'completed') {
  await expect(page.locator('#aw-run-state')).toHaveText(state, { timeout: 20_000 });
}
const outcome = (page: Page, o: string) => page.locator(`[data-outcome="${o}"]`);

test.describe('plans and results (G16/G17)', () => {
  test('Flow plan built in the UI: setup once, per-iteration producer values, Results/CSV/JSON agree with the fixture', async ({ page }) => {
    await launch(page);
    await addEndpoint(page, { name: 'Login', alias: 'login', method: 'POST', url: '/api/login', body: '{}' });
    await addEndpoint(page, { name: '=Create item', alias: 'create', method: 'POST', url: '/api/crud/items', body: '{"n": {{$counter("n", 1, 1)}}}' });
    await addEndpoint(page, { name: 'Read item', alias: 'read', url: '/api/crud/items/{{create.id}}' });
    await openPlans(page);
    await page.locator('#aw-phase-login').selectOption('setup');
    await page.locator('#aw-phase-read').selectOption('load');
    await page.locator('#aw-phase-create').selectOption('load');
    await page.locator('#aw-plan-iterations').fill('3');
    await page.locator('#aw-plan-concurrency').fill('2');
    await expect(page.locator('#aw-run-why')).toHaveText('Save the plan before running it');
    await expect(page.locator('#aw-pf-counts')).toContainText('Setup 1 · load 2 step(s) × 3 = 6 jobs · run once = 3 request(s) · Load = 7 primary, up to 7');
    await page.locator('#aw-plan-concurrency').fill('99');
    await expect(page.getByText('Whole number 1–20; still using 2')).toBeVisible();
    await page.locator('#aw-plan-concurrency').fill('2');
    await page.locator('#aw-plan-save').click();
    await expect(page.locator('#aw-run-why')).toHaveText('');
    await page.locator('#aw-run-load').click();
    await waitRun(page);
    await expect(outcome(page, 'passed')).toHaveText('7');
    await expect(page.locator('#aw-run-progress')).toHaveText('7 / 7 steps');
    const c = await counters(page);
    expect(c['/api/login']).toBe(1);
    for (const i of [1, 2, 3]) { expect(c[`crud:create:item-${i}`]).toBe(1); expect(c[`crud:read:item-${i}`]).toBe(1); }
    await expect(page.locator('#aw-run-network')).toContainText('Network: 7 measured');
    await expect(page.locator('[data-api-workbench] .aw-notice').getByText(/Plan 1 Load completed: 7\/7 steps · 7 passed/)).toBeVisible();
    await expect(page.locator('[data-api-workbench] .aw-notice').getByRole('button', { name: 'View run' })).toBeVisible();

    const [csv] = await Promise.all([page.waitForEvent('download'), page.locator('[data-key="run-csv"]').click()]);
    const text = readFileSync((await csv.path())!, 'utf8');
    expect(text.split('\r\n')[0]).toMatch(/^endpoint,alias,method,passed,failed-check/);
    expect(text).toContain("'=Create item,create,POST,3,0,");
    const [js] = await Promise.all([page.waitForEvent('download'), page.locator('[data-key="run-json"]').click()]);
    const run = JSON.parse(readFileSync((await js.path())!, 'utf8'));
    expect(run).toMatchObject({ format: 'api-workbench-run', run: { kind: 'load', state: 'completed' }, counts: { passed: 7 }, dispatched: { total: 7, network: 7 } });
    expect(run.endpoints.find((e: { alias: string }) => e.alias === 'read').network.samples).toBe(3);

    // One pass leaves the saved Load settings unchanged.
    await openPlans(page);
    await page.locator('#aw-run-once').click();
    await waitRun(page);
    await expect(outcome(page, 'passed')).toHaveText('3');
    await openPlans(page);
    await expect(page.locator('#aw-plan-iterations')).toHaveValue('3');

    // Reload: history keeps the stored summaries; the plan keeps its ID and settings.
    await page.reload();
    await launch(page);
    await tab(page, 'Test');
    await page.locator('[data-key="view-results"]').click();
    await expect(page.getByRole('list', { name: 'Run history, newest first' }).getByRole('button')).toHaveCount(2);
    await expect(page.locator('#aw-run-state')).toHaveText('completed');
    await expect(page.getByText('stored summary (retained configuration snapshot not available)')).toBeVisible();
  });

  test('Independent refuses another load step’s output; Stop aborts in-flight work and admits nothing more', async ({ page }) => {
    await launch(page);
    await addEndpoint(page, { name: 'Create item', alias: 'create', method: 'POST', url: '/api/crud/items', body: '{}' });
    await addEndpoint(page, { name: 'Read item', alias: 'read', url: '/api/crud/items/{{create.id}}' });
    await addEndpoint(page, { name: 'Slow', alias: 'slow', url: '/api/slow?ms=3000' });
    await openPlans(page);
    await page.locator('#aw-phase-create').selectOption('load');
    await page.locator('#aw-phase-read').selectOption('load');
    await page.locator('#aw-plan-strategy').selectOption('independent');
    await expect(page.locator('#aw-pf')).toContainText("Independent: Read item (read) reads Create item (create)'s response, but independent jobs never share outputs. Use Flow, or move create to setup");
    await page.locator('#aw-plan-save').click();
    await expect(page.locator('#aw-run-load')).toBeDisabled();
    await expect(page.locator('#aw-run-why')).toHaveText('Fix the preflight errors first');

    await page.locator('#aw-phase-create').selectOption('skip');
    await page.locator('#aw-phase-read').selectOption('skip');
    await page.locator('#aw-phase-slow').selectOption('load');
    await page.locator('#aw-plan-iterations').fill('20');
    await page.locator('#aw-plan-concurrency').fill('2');
    await page.locator('#aw-plan-save').click();
    await page.locator('#aw-run-load').click();
    await expect(page.locator('#aw-run-state')).toHaveText('running');
    await expect(page.locator('#aw-run-ind')).toBeVisible();
    await expect.poll(async () => (await counters(page))['/api/slow'] ?? 0).toBe(2);
    await page.locator('#aw-run-stop').click();
    await waitRun(page, 'stopped');
    await expect(outcome(page, 'aborted')).toHaveText('2');
    await page.waitForTimeout(3500);
    expect((await counters(page))['/api/slow']).toBe(2);
    await expect(page.locator('[data-api-workbench]').getByText(/18 planned step\(s\) were not started; nothing more was sent/)).toBeVisible();
    await expect(page.locator('#aw-run-ind')).toHaveCount(0);
  });

  test('page scan is explicit, bounded and masked; getters are never invoked; a scanned source becomes a binding', async ({ page }) => {
    await page.evaluate(() => {
      document.cookie = 'XSRF-TOKEN=abc123456789; path=/';
      localStorage.setItem('api_token', 'secret-token-value');
      (window as any).__getterHits = 0;
      (window as any).appConfig = { tenant: 'bank-a', nested: { region: 'eu' } };
      Object.defineProperty((window as any).appConfig, 'trap', { enumerable: true, get() { (window as any).__getterHits++; return 'x'; } });
    });
    await launch(page);
    await tab(page, 'Test');
    await page.locator('[data-key="view-context"]').click();
    await expect(page.getByRole('heading', { name: 'Auth & context' })).toBeVisible();
    await expect(page.getByText('Nothing is read until you press Scan.')).toBeVisible();
    await page.getByRole('checkbox', { name: 'localStorage' }).first().click();
    await page.getByRole('checkbox', { name: 'Global roots' }).click();
    await page.getByRole('textbox', { name: 'Global roots' }).fill('appConfig, nope');
    await page.locator('#aw-scan').click();
    await expect(page.locator('#aw-scan-count')).toHaveText(/^\d+ candidate/);
    const scan = page.getByRole('region', { name: 'Scan page' });
    await expect(scan).toContainText('XSRF-TOKEN');
    await expect(scan).toContainText('••••6789 (12 chars)');
    await expect(scan).toContainText('appConfig.nested.region');
    await expect(scan).toContainText('window.nope does not exist');
    await expect(scan).not.toContainText('secret-token-value');
    expect(await page.evaluate(() => (window as any).__getterHits)).toBe(0);
    await page.getByRole('button', { name: 'Use XSRF-TOKEN as binding' }).click();
    await page.locator('#aw-ctx-save').click();
    await expect(page.getByRole('region', { name: 'Bindings' })).toContainText('{{$context("XSRF_TOKEN")}}');
    await expect(page.getByRole('region', { name: 'Bindings' })).toContainText('available ••••6789');
  });
});

test.describe('expression picker (S19.2)', () => {
  test('inserts at the caret of the last focused field; producer fields come from samples; nothing is evaluated', async ({ page }) => {
    await launch(page);
    await addEndpoint(page, { name: 'Accounts', alias: 'accounts', url: '/api/echo' });
    await tab(page, 'Test');
    await page.locator('#aw-once-run').click();
    await expect(page.locator('#aw-once-verdict')).toBeVisible();
    await button(page, 'Save sample').click();
    await addEndpoint(page, { name: 'Use', alias: 'use', url: '/api/echo/' });
    await page.getByRole('button', { name: 'Edit Use (use)' }).click();
    const url = page.locator('#aw-ep-url');
    await url.click();
    await url.press('End');
    const picker = page.getByLabel('Insert expression into the last focused field');
    await expect(picker.locator('option', { hasText: 'accounts.servedBy (captured sample)' })).toHaveCount(1);
    await picker.selectOption('{{accounts.servedBy}}');
    await expect(url).toHaveValue('/api/echo/{{accounts.servedBy}}');
    await picker.selectOption('{{$uuid}}');
    await expect(url).toHaveValue('/api/echo/{{accounts.servedBy}}{{$uuid}}');
    await expect(page.locator('#aw-ep-auth')).toHaveValue('');
    await expect(page.locator('#aw-ep-signing')).toHaveValue('');
    await button(page, 'Save').click();
    await page.getByRole('button', { name: 'Run Use once' }).click();
    await expect(page.locator('#aw-once-blocked')).toContainText("needs accounts's response from the same plan run; Once never reuses an earlier response");
  });
});

test.describe('banking-style fixture (G27 subset)', () => {
  test('session, refresh, CSRF rotation, signing, idempotency, polling, exact assertions and receipt', async ({ page }) => {
    // The customer signs in through the application first; its client keeps the bearer token in localStorage.
    await page.evaluate(async () => {
      const j = await (await fetch('/api/bank/login', { method: 'POST' })).json();
      localStorage.setItem('bank_token', j.token);
      localStorage.setItem('bank_exp', String(j.expiresAt));
    });
    await launch(page);
    await page.getByRole('button', { name: 'Import', exact: true }).first().click();
    await page.locator('#aw-imp-text').fill(bankProfile());
    await page.locator('#aw-imp-apply').click();
    await page.locator('#aw-imp-commit').click();
    await expect(page.locator('#aw-imp-saved')).toContainText('Bank fixture');

    // Missing key blocks only the signed direct send, with the reason.
    await openPlans(page);
    await expect(page.locator('#aw-pf')).toContainText('Signing recipe Bank HMAC needs key "bank_key" for this session');
    await expect(page.locator('#aw-run-load')).toBeDisabled();
    await page.locator('[data-api-workbench] footer').getByRole('button', { name: 'Close' }).click();
    await page.locator('[data-key="view-context"]').click();
    await page.getByLabel('Key text for bank_key').fill('test-key-123');
    await page.getByRole('button', { name: 'Use key bank_key for this session' }).click();
    await expect(page.getByText('key "bank_key" loaded for this session')).toBeVisible();
    await foot(page).getByRole('button', { name: 'Close' }).click();

    await openPlans(page);
    await expect(page.locator('#aw-pf-counts')).toContainText('Load = 10 primary, up to');
    await expect(page.locator('#aw-pf')).toContainText('POST Submit transfer (transfer) · idempotency header Idempotency-Key');
    await page.locator('#aw-run-load').click();
    await waitRun(page);
    await expect(outcome(page, 'passed')).toHaveText('10');
    let c = await counters(page);
    expect(c['bank:transfer:logical']).toBe(2);
    expect(c['bank:csrf-rejected'] ?? 0).toBe(0); // the rotated CSRF cookie was read again for the second write
    expect(c['bank:bad-signature'] ?? 0).toBe(0);
    expect(c['bank:status']).toBe(6); // pending, pending, completed per iteration
    const state = await (await page.request.get(`${A}/__bank`)).json();
    expect(state.transfers.map((t: { status: string; total: string }) => [t.status, t.total])).toEqual([['completed', '100.60'], ['completed', '100.60']]);
    await expect(page.locator('#aw-run-dispatched')).toContainText('14 request(s) sent: 14 network');
    const status = page.locator('details[data-step^="ep-status|1|"]');
    await status.locator('summary').click();
    await expect(status).toContainText('Poll condition met on attempt 3');
    await expect(status).toContainText('status.total = 100.60 — got 100.60');

    // Server-side expiry: the read gets 401, one refresh, one retry; the writes use the refreshed token.
    await page.request.get(`${A}/__bank?expire=1`);
    await openPlans(page);
    await page.locator('#aw-run-once').click();
    await waitRun(page);
    await expect(outcome(page, 'passed')).toHaveText('5');
    c = await counters(page);
    expect(c['bank:refresh']).toBe(1);
    expect(c['bank:transfer:logical']).toBe(3);
    const accounts = page.locator('details[data-step^="ep-accounts|"]');
    await accounts.locator('summary').click();
    await expect(accounts).toContainText('primary 1');
    await expect(accounts).toContainText('retry 2');

    // A failed refresh blocks the waiting work with its cause; nothing loops.
    await page.request.get(`${A}/__bank?expire=1&refresh=fail`);
    await openPlans(page);
    await page.locator('#aw-run-once').click();
    await waitRun(page);
    await expect(outcome(page, 'failed-check')).toHaveText('1');
    await expect(outcome(page, 'skipped-dependency')).toHaveText('4');
    expect((await counters(page))['bank:refresh']).toBe(2);
    expect((await counters(page))['bank:transfer:logical']).toBe(3);

    // Deliberate duplicate in Once: same Idempotency-Key and payload, fresh signature → one logical transfer.
    await page.request.get(`${A}/__bank?refresh=ok`);
    const fresh = await page.evaluate(async () => {
      const j = await (await fetch('/api/bank/refresh', { method: 'POST' })).json();
      localStorage.setItem('bank_token', j.token);
      localStorage.setItem('bank_exp', String(j.expiresAt));
      const q = await (await fetch('/api/bank/quotes', { method: 'POST', headers: { authorization: `Bearer ${j.token}` }, body: '{"accountId":"acc-001","amount":"100.10"}' })).json();
      sessionStorage.setItem('quote_id', q.id);
      return q.id as string;
    });
    expect(fresh).toMatch(/^q-/);
    await tab(page, 'Test');
    await page.locator('[data-key="view-once"]').click();
    await page.locator('#aw-once-ep').selectOption({ label: 'Transfer (manual, idempotent) · POST /api/bank/transfers' });
    await expect(page.locator('#aw-once-signing')).toContainText('signed at dispatch with a fresh timestamp and nonce');
    await expect(page.locator('#aw-once-auth')).toContainText('auth available');
    await page.locator('#aw-once-run').click();
    await expect(page.locator('#aw-once-verdict')).toHaveText('Checks passed');
    await page.locator('[data-key="once-dup"]').click();
    await expect(page.locator('#aw-once-ident')).toContainText('deliberate duplicate of #1');
    await expect(page.locator('#aw-once-verdict')).toHaveText('Checks passed');
    c = await counters(page);
    expect(c['bank:transfer:logical']).toBe(4);
    expect(c['bank:transfer:duplicate']).toBe(1);
    await page.locator('#aw-once-run').click(); // a new logical operation gets a new key
    await expect(page.locator('#aw-once-ident')).toContainText('Run #3');
    await expect(page.locator('#aw-once-verdict')).toBeVisible();
    expect((await counters(page))['bank:transfer:logical']).toBe(5);

    // Saved artifacts keep definitions and references only; after reload no key or token is resumed.
    await page.reload();
    await launch(page);
    await tab(page, 'Test');
    await page.locator('#aw-once-ep').selectOption({ label: 'Transfer (manual, idempotent) · POST /api/bank/transfers' });
    await expect(page.locator('#aw-once-blocked')).toContainText('needs key "bank_key" for this session');
    const stored = await page.evaluate(() => new Promise<string>((res) => {
      const r = indexedDB.open('api-workbench-v2');
      r.onsuccess = () => {
        const t = r.result.transaction(['profiles', 'runSummaries'], 'readonly');
        Promise.all(['profiles', 'runSummaries'].map((n) => new Promise((ok) => { const g = t.objectStore(n).getAll(); g.onsuccess = () => ok(g.result); }))).then((v) => res(JSON.stringify(v)));
      };
    }));
    const token = await page.evaluate(() => localStorage.getItem('bank_token'));
    expect(stored).not.toContain(token!);
    expect(stored).not.toContain('test-key-123');
    expect(stored).not.toMatch(/tok-[0-9a-f-]{36}/);
  });
});
