// R8 G27 rows left open by R6, in real Chrome through the bundled UI: failure matrix, pending timeout,
// lost response after a committed write, rules that change or route a signed request after signing,
// audience isolation across services, and a routed typed-binary receipt. Launch = evaluating the
// generated bookmark (injection; NOT saved-bookmark evidence).
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { bankProfile } from './bank-profile';
import { activate, fill, newRule, panel, saveRule } from './rule-helpers';

const A = `http://127.0.0.1:${process.env.AW_PORT ?? 4310}`;
const B = `http://127.0.0.1:${process.env.AW_OTHER_PORT ?? 4311}`;
const source = decodeURIComponent(readFileSync('dist/bookmark.txt', 'utf8').slice('javascript:'.length));
const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Modules' }).getByRole('button', { name, exact: true }).click();
const counters = async (page: Page): Promise<Record<string, number>> => (await page.request.get(`${A}/__counters`)).json();
const bankState = async (page: Page) => (await page.request.get(`${A}/__bank`)).json();
const foot = (page: Page) => page.locator('[data-api-workbench] footer');
const outcome = (page: Page, o: string) => page.locator(`[data-outcome="${o}"]`);

const now = 1;
const ep = (id: string, name: string, method: string, url: string, o: { query?: [string, string][]; hostKey?: string; checks?: unknown[]; auth?: boolean; sign?: boolean; body?: string } = {}) => ({
  id, name, alias: id.replace(/-/g, '_'),
  request: { method, hostKey: o.hostKey ?? 'default', url, query: o.query ?? [], headers: [], credentials: 'same-origin', body: o.body ? { kind: 'json', text: o.body } : { kind: 'none' } },
  checks: o.checks ?? [{ kind: 'status', min: 200, max: 299 }], provenance: 'G27 R8', createdAt: now, updatedAt: now,
  ...(o.auth !== false && { authContextId: 'auth-bank' }), ...(o.sign && { signingRecipeId: 'sign-bank' }),
});
export const FAILS = ['401', '403', '409', '422', '429', '503', 'malformed'] as const;

/** The R6 bank profile plus failure-matrix endpoints and a second service mapped to origin B. */
function profile() {
  const env = JSON.parse(bankProfile()) as { profiles: { profile: { environments: Record<string, Record<string, string>> }; endpoints: unknown[] }[] };
  const agg = env.profiles[0]!;
  agg.profile.environments = { default: { default: '', ledger: B } };
  agg.endpoints.push(
    ...FAILS.map((f) => ep(`ep-fail-${f}`, `Fail ${f}`, 'GET', '/api/bank/accounts', { query: [['fail', f]], checks: [{ kind: 'status', min: 200, max: 299 }, { kind: 'json', path: 'accounts', mode: 'exists' }] })),
    ep('ep-ledger', 'Ledger accounts (service B)', 'GET', '/api/bank/accounts', { hostKey: 'ledger' }),
    ep('ep-receipt-1', 'Receipt t-2', 'GET', '/api/bank/transfers/t-2/receipt', { checks: [{ kind: 'status', min: 200, max: 200 }, { kind: 'body-contains', value: '%PDF-1.4 synthetic receipt t-2 100.60' }] }),
  );
  return JSON.stringify(env);
}

async function signIn(page: Page) {
  await page.evaluate(async () => {
    const j = await (await fetch('/api/bank/login', { method: 'POST' })).json();
    localStorage.setItem('bank_token', j.token);
    localStorage.setItem('bank_exp', String(j.expiresAt));
  });
}
async function setup(page: Page) {
  await signIn(page);
  await page.evaluate(source);
  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  await page.locator('#aw-imp-text').fill(profile());
  await page.locator('#aw-imp-apply').click();
  await page.locator('#aw-imp-commit').click();
  await expect(page.locator('#aw-imp-saved')).toContainText('Bank fixture');
  await tab(page, 'Test');
  await page.locator('[data-key="view-context"]').click();
  await page.getByLabel('Key text for bank_key').fill('test-key-123');
  await page.getByRole('button', { name: 'Use key bank_key for this session' }).click();
  await foot(page).getByRole('button', { name: 'Close' }).click();
}
async function once(page: Page, label: string, mode: 'Direct' | 'Apply rules' = 'Direct') {
  await tab(page, 'Test');
  await page.locator('[data-key="view-once"]').click();
  await page.locator('#aw-once-ep').selectOption({ label });
  await page.getByRole('group', { name: 'Send mode' }).getByRole('button', { name: mode, exact: true }).click();
  await page.locator('#aw-once-run').click();
  await expect(page.locator('#aw-once-verdict')).toBeVisible();
  return panel(page).getByRole('region', { name: 'Result' });
}
async function runPlanOnce(page: Page) {
  await tab(page, 'Test');
  await page.locator('[data-key="view-plans"]').click();
  await page.locator('#aw-run-once').click();
  await expect(page.locator('#aw-run-state')).toHaveText(/completed|stopped|failed/, { timeout: 20_000 });
}
const step = async (page: Page, id: string) => {
  const d = page.locator(`details[data-step^="${id}|"]`).first();
  await d.locator('summary').click();
  return d;
};

test.beforeEach(async ({ page }) => {
  await page.request.get(`${A}/__reset`);
  await page.goto(`${A}/fixture`);
  await page.evaluate(() => Promise.all(['api-workbench-v2', 'api-workbench'].map((n) => new Promise((r) => { const q = indexedDB.deleteDatabase(n); q.onsuccess = q.onerror = q.onblocked = r; }))));
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.waitForFunction(() => (window as any).fx);
});

test.describe('banking-style fixture: R8 rows (G27)', () => {
  test('concurrent expiry shares one refresh, then all read-only jobs use the refreshed identity', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => localStorage.setItem('bank_exp', '0'));
    await tab(page, 'Test');
    await page.locator('[data-key="view-plans"]').click();
    await page.locator('#aw-plan-strategy').selectOption('independent');
    for (const alias of ['quote', 'transfer', 'status', 'receipt']) await page.locator(`#aw-phase-${alias}`).selectOption('skip');
    await page.locator('#aw-plan-iterations').fill('8');
    await page.locator('#aw-plan-concurrency').fill('4');
    await page.locator('#aw-plan-save').click();
    await page.locator('#aw-run-load').click();
    await expect(page.locator('#aw-run-state')).toHaveText('completed');
    await expect(outcome(page, 'passed')).toHaveText('8');
    const c = await counters(page);
    expect(c['bank:refresh']).toBe(1);
    expect(c['/api/bank/accounts']).toBe(8);
    expect(c['bank:401'] ?? 0).toBe(0);
    expect(c['bank:transfer:logical'] ?? 0).toBe(0);
  });

  test('unchanged app-generated signatures preserve exact Unicode bytes; reused nonce, expired timestamp and stale CSRF fail distinctly', async ({ page }) => {
    await setup(page);
    const got = await page.evaluate(async () => {
      const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((n) => n.toString(16).padStart(2, '0')).join('');
      const csrf = () => decodeURIComponent(document.cookie.split('; ').find((p) => p.startsWith('XSRF-TOKEN='))!.split('=')[1]!);
      const authorization = `Bearer ${localStorage.getItem('bank_token')}`;
      const quote = await (await fetch('/api/bank/quotes', { method: 'POST', headers: { authorization }, body: '{"accountId":"acc-001","amount":"100.10"}' })).json();
      const body = JSON.stringify({ quoteId: quote.id, amount: '100.10', note: 'naïve 😀' });
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-key-123'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const bodyHash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
      const nonce = crypto.randomUUID(), ts = Date.now(), oldCsrf = csrf();
      const send = async (stamp: number, n: string, token = csrf()) => {
        const canonical = ['POST', '/api/bank/transfers', '', bodyHash, String(stamp), n].join('\n');
        const sig = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical)));
        const r = await fetch(new Request(`${location.origin}/api/bank/transfers`, { method: 'POST', headers: { authorization, 'X-XSRF-TOKEN': token, 'X-Timestamp': String(stamp), 'X-Nonce': n, 'X-Signature': sig, 'Idempotency-Key': 'app-generated-logical-operation' }, body }));
        return { status: r.status, body: await r.json() };
      };
      return [await send(ts, nonce), await send(ts, nonce), await send(ts - 60_000, crypto.randomUUID()), await send(Date.now(), crypto.randomUUID(), oldCsrf)];
    });
    expect(got.map((r) => r.status)).toEqual([202, 401, 401, 403]);
    expect(got.slice(1).map((r) => r.body.error)).toEqual(['stale timestamp or reused nonce', 'stale timestamp or reused nonce', 'csrf']);
    const c = await counters(page);
    expect(c['bank:transfer:logical']).toBe(1);
    expect(c['bank:stale-signature']).toBe(2);
    expect(c['bank:csrf-rejected']).toBe(1);
    expect(c['bank:bad-signature'] ?? 0).toBe(0);
  });

  test('failure matrix: 401/403/409/422/429/503 and malformed JSON are distinct, one dispatch each, never a pass (401: one configured read-only retry)', async ({ page }) => {
    await setup(page);
    const seen: string[] = [];
    for (const f of FAILS) {
      const r = await once(page, `Fail ${f} · GET /api/bank/accounts`);
      const verdict = await page.locator('#aw-once-verdict').textContent();
      expect(verdict).not.toBe('Checks passed');
      if (f === 'malformed') {
        await expect(r).toContainText('HTTP 200');
        await expect(r).toContainText('JSON accounts exists — Body is not valid JSON');
      } else {
        await expect(r).toContainText(`HTTP ${f}`);
        await expect(r).toContainText(`injected ${f}`);
        // 401 on a GET: the context's configured refresh runs, then exactly one read-only retry.
        if (f === '401') await expect(r).toContainText('HTTP 401: refreshed and retried once (read-only retry is enabled for this context)');
      }
      seen.push(`${f}:${verdict}`);
    }
    const c = await counters(page);
    expect(c['/api/bank/accounts']).toBe(FAILS.length + 1); // + the one read-only retry
    expect(c['bank:refresh']).toBe(1);
    expect(seen).toEqual([...FAILS.slice(0, -1).map((f) => `${f}:2 checks failed`), 'malformed:1 check failed']);
  });

  test('pending past the poll cap ends as a bounded, non-successful poll; the receipt guard skips', async ({ page }) => {
    await setup(page);
    await page.request.get(`${A}/__bank?pending=50`);
    await runPlanOnce(page);
    const c = await counters(page);
    expect(c['bank:transfer:logical']).toBe(1);
    expect(c['bank:status']).toBe(5); // maxAttempts, never more
    expect(Object.keys(c).some((k) => k.endsWith('/receipt'))).toBe(false);
    await expect(outcome(page, 'passed')).not.toHaveText('5');
    const status = await step(page, 'ep-status');
    await expect(status).toContainText('Still pending after 5 attempt(s) (status.status in completed,failed: got pending)');
    await expect(status).toContainText('failedstatus.status = completed — got pending');
    await expect(status).not.toContainText('Poll condition met');
    const receipt = await step(page, 'ep-receipt');
    await expect(receipt).toContainText(/skipped/i);
  });

  test('a lost response after a committed write: no Workbench retry, never success, dependents skipped', async ({ page }) => {
    await setup(page);
    await page.request.get(`${A}/__bank?drop=1`);
    await runPlanOnce(page);
    const c = await counters(page);
    // Workbench sent the write once (accounts, quote, transfer) and did not retry it.
    await expect(page.locator('#aw-run-dispatched')).toContainText('3 request(s) sent: 3 network');
    expect(c['bank:transfer:dropped']).toBe(1);
    expect(c['bank:transfer:logical']).toBe(1);
    // Browser boundary: Chrome's network stack transparently re-sends a request whose reused keep-alive
    // connection closed without a response. That resend is not Workbench's; here the rotated CSRF token
    // rejects it, so the server still holds one logical transfer.
    expect(c['/api/bank/transfers']).toBeLessThanOrEqual(2);
    expect((c['/api/bank/transfers'] ?? 0) - 1).toBe((c['bank:csrf-rejected'] ?? 0) + (c['bank:stale-signature'] ?? 0) + (c['bank:transfer:duplicate'] ?? 0));
    expect(c['bank:status'] ?? 0).toBe(0);
    const state = await bankState(page);
    expect(state.transfers).toHaveLength(1); // the server did commit it: the outcome is uncertain, not failed-and-safe
    // Whatever answer the browser delivers (no response, or its resend's rejection), it is not success,
    // and the dependent status/receipt steps never run.
    const transfer = await step(page, 'ep-transfer');
    await expect(transfer).toContainText(/network|HTTP 403/i);
    await expect(transfer).not.toContainText('HTTP 202');
    await expect(outcome(page, 'passed')).toHaveText('2');
    await expect(outcome(page, 'skipped-dependency')).toHaveText('2');
  });

  test('Apply rules: an intercept edit after signing is named and rejected by the server; a route after signing is named', async ({ page }) => {
    await setup(page);
    const quote = await page.evaluate(async () => {
      const q = await (await fetch('/api/bank/quotes', { method: 'POST', headers: { authorization: `Bearer ${localStorage.getItem('bank_token')}` }, body: '{"accountId":"acc-001","amount":"100.10"}' })).json();
      sessionStorage.setItem('quote_id', q.id);
      return q.id as string;
    });
    expect(quote).toMatch(/^q-/);
    await newRule(page, 'Intercept');
    await fill(page, { 'aw-r-path': '/api/bank/transfers', 'aw-request-patch': '[{"op":"replace","path":"/amount","value":"1.00"}]' });
    await saveRule(page);
    await activate(page, 'Intercept');
    const label = 'Transfer (manual, idempotent) · POST /api/bank/transfers';
    let r = await once(page, label, 'Apply rules');
    await expect(r).toContainText('HTTP 401');
    await expect(r).toContainText('Signed content changed after signing by intercept rule');
    expect((await counters(page))['bank:bad-signature']).toBe(1);
    expect((await counters(page))['bank:transfer:logical'] ?? 0).toBe(0);
    // Direct is unaffected by page rules and passes.
    r = await once(page, label, 'Direct');
    await expect(page.locator('#aw-once-verdict')).toHaveText('Checks passed');
    await expect(r).not.toContainText('after signing by');
    await foot(page).getByRole('button', { name: 'Stop all' }).click();

    // Route to service B after signing: named; signing is not silently redone for the new host.
    await newRule(page, 'Route');
    await fill(page, { 'aw-r-path': '/api/bank/transfers', 'aw-route-dest': B });
    await page.getByRole('checkbox', { name: 'Forward Authorization to this destination' }).click();
    await saveRule(page);
    await activate(page, 'Route');
    r = await once(page, label, 'Apply rules');
    await expect(r).toContainText(`Routed after signing by route rule`);
    await expect(r).toContainText(`${B}/api/bank/transfers: the signature was prepared for the original destination`);
  });

  test('audiences stay isolated across services: credentials for the page origin are never sent to service B', async ({ page }) => {
    await setup(page);
    await tab(page, 'Test');
    await page.locator('[data-key="view-once"]').click();
    await page.locator('#aw-once-ep').selectOption({ label: 'Ledger accounts (service B) · GET /api/bank/accounts' });
    await expect(page.locator('#aw-once-blocked')).toContainText(`Auth context Synthetic customer is for ${A}; this request goes to ${B}. Its credentials are not sent to another audience`);
    await page.locator('#aw-once-run').click();
    expect((await counters(page))['/api/bank/accounts'] ?? 0).toBe(0);
  });

  test('a routed arraybuffer XHR receipt keeps native typed bytes; Once reads the same receipt', async ({ page }) => {
    await setup(page);
    await runPlanOnce(page); // quote q-1, transfer t-2, completed after polling
    expect((await bankState(page)).transfers.map((t: { id: string; status: string }) => `${t.id}:${t.status}`)).toEqual(['t-2:completed']);
    await newRule(page, 'Route');
    await fill(page, { 'aw-r-path': '/api/legacy/receipt/t-2', 'aw-route-dest': A, 'aw-route-rewrite': '/api/bank/transfers/t-2/receipt' });
    await saveRule(page);
    await activate(page, 'Route');
    const got = await page.evaluate(() => new Promise<{ type: string; isAb: boolean; text: string; ct: string | null }>((res) => {
      const x = new XMLHttpRequest();
      x.open('GET', '/api/legacy/receipt/t-2');
      x.responseType = 'arraybuffer';
      x.setRequestHeader('Authorization', `Bearer ${localStorage.getItem('bank_token')}`);
      x.onload = () => res({ type: x.responseType, isAb: x.response instanceof ArrayBuffer, text: new TextDecoder('latin1').decode(x.response), ct: x.getResponseHeader('content-type') });
      x.send();
    }));
    expect(got).toEqual({ type: 'arraybuffer', isAb: true, text: '%PDF-1.4 synthetic receipt t-2 100.60\n', ct: 'application/pdf' });
    await foot(page).getByRole('button', { name: 'Stop all' }).click();
    await once(page, 'Receipt t-2 · GET /api/bank/transfers/t-2/receipt');
    await expect(page.locator('#aw-once-verdict')).toHaveText('Checks passed');
  });
});
