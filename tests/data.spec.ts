// R2 cases in real Chrome: storage, profiles, endpoints, headers, environments, Once and migration.
// Launch = evaluating the decoded generated bookmark (injection; NOT saved-bookmark evidence).
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const A = `http://127.0.0.1:${process.env.AW_PORT ?? 4310}`;
const B = `http://127.0.0.1:${process.env.AW_OTHER_PORT ?? 4311}`;
const bookmark = readFileSync('dist/bookmark.txt', 'utf8');
const source = decodeURIComponent(bookmark.slice('javascript:'.length));

const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Modules' }).getByRole('button', { name, exact: true }).click();
const button = (page: Page, name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' });
const counters = async (page: Page): Promise<Record<string, number>> => (await page.request.get(`${A}/__counters`)).json();
const body = (page: Page) => page.locator('#aw-once-body');
const echo = async (page: Page) => JSON.parse((await body(page).textContent())!);
async function openEndpoints(page: Page) {
  await tab(page, 'Home');
  await page.getByRole('button', { name: 'Endpoints', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Endpoints' })).toBeVisible();
}

async function launch(page: Page) {
  await page.evaluate(source);
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await expect(page.locator('#aw-store-state')).toHaveText(/All changes saved|Storage unavailable/);
  await tab(page, 'Home');
}
async function fresh(page: Page) {
  await page.goto(`${A}/fixture`);
  await page.evaluate(() => Promise.all(['api-workbench-v2', 'api-workbench'].map((n) => new Promise((r) => { const q = indexedDB.deleteDatabase(n); q.onsuccess = q.onerror = q.onblocked = r; }))));
  await page.evaluate(() => { localStorage.clear(); document.cookie = 'XSRF-TOKEN=; max-age=0; path=/'; });
}

/** Create an endpoint through the editor. Starts from wherever Endpoints is reachable. */
async function addEndpoint(page: Page, o: { name: string; alias: string; method?: string; host?: string; url: string; body?: { kind: string; text?: string }; headers?: [string, string][]; cred?: string; checks?: 'none' }) {
  await openEndpoints(page);
  await button(page, 'Add endpoint').click();
  await page.locator('#aw-ep-name').fill(o.name);
  await page.locator('#aw-ep-alias').fill(o.alias);
  if (o.method) await page.locator('#aw-ep-method').selectOption(o.method);
  await page.locator('#aw-ep-host').selectOption(o.host ?? 'default');
  await page.locator('#aw-ep-url').fill(o.url);
  if (o.cred) await page.locator('#aw-ep-cred').selectOption(o.cred);
  for (const [k, v] of o.headers ?? []) {
    await button(page, 'Add header').click();
    await page.getByRole('textbox', { name: /^Header \d+ name$/ }).last().fill(k);
    await page.getByRole('textbox', { name: /^Header \d+ value$/ }).last().fill(v);
  }
  if (o.body) {
    await page.locator('#aw-ep-bodykind').selectOption(o.body.kind);
    if (o.body.text !== undefined) await page.locator('#aw-ep-body').fill(o.body.text);
  }
  if (o.checks === 'none') await button(page, 'Remove check 1').click();
  await button(page, 'Save').click();
  await expect(page.getByRole('heading', { name: 'Endpoints' })).toBeVisible();
}

async function runOnce(page: Page, name: string, mode: 'Direct' | 'Apply rules' = 'Direct') {
  await page.getByRole('button', { name: `Run ${name} once` }).click();
  await expect(page.getByRole('heading', { name: 'API Tester' })).toBeVisible();
  await button(page, mode).click();
  const ident = page.locator('#aw-once-ident');
  const before = (await ident.count()) ? await ident.textContent() : null;
  await page.locator('#aw-once-run').click();
  if (before) await expect(ident).not.toHaveText(before);
  await expect(page.locator('#aw-once-verdict')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.request.get(`${A}/__reset`);
  await fresh(page);
  await page.waitForFunction(() => (window as any).fx);
});

test.describe('endpoints and Once (G14/G15)', () => {
  test('create → Once Direct sends the exact JSON body; checks pass; sample saved; survives reload', async ({ page }) => {
    await launch(page);
    const json = '{ "amount" :"100.10",\n  "memo": "héllo ✓" }';
    await addEndpoint(page, { name: 'Create transfer', alias: 'create_transfer', method: 'POST', url: '/api/echo', headers: [['X-Test', 'local']], body: { kind: 'json', text: json } });
    await expect(page.getByRole('button', { name: 'Edit Create transfer (create_transfer)' })).toBeFocused();
    await runOnce(page, 'Create transfer');
    await expect(page.locator('#aw-once-verdict')).toHaveText('Checks passed');
    const e = await echo(page);
    expect(e).toMatchObject({ method: 'POST', path: '/api/echo', bodyText: json, headers: { 'content-type': 'application/json', 'x-test': 'local' } });
    await button(page, 'Save sample').click();
    await expect(page.getByRole('status').filter({ hasText: 'Sample saved' })).toHaveCount(1);
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await expect(page.locator('#aw-store-state')).toHaveText('All changes saved'); // live edit, then stored
    await page.reload();
    await page.waitForFunction(() => (window as any).fx);
    await launch(page);
    await openEndpoints(page);
    await page.getByRole('button', { name: 'Edit Create transfer (create_transfer)' }).click();
    await expect(page.locator('#aw-ep-body')).toHaveValue(json); // exact bytes, never reformatted on reopen
    await expect(page.getByText(/^Captured response/)).toBeVisible();
  });

  test('URL-encoded order/repeats, multipart file chosen at run time, Unicode text', async ({ page }) => {
    await launch(page);
    await addEndpoint(page, { name: 'Form', alias: 'form', method: 'POST', url: '/api/echo', body: { kind: 'urlencoded' } });
    await page.getByRole('button', { name: 'Edit Form (form)' }).click();
    for (const [k, v] of [['a', '1'], ['a', '2 3'], ['é', 'ü']]) {
      await button(page, 'Add form field').click();
      await page.getByRole('textbox', { name: /^form field \d+ name$/ }).last().fill(k!);
      await page.getByRole('textbox', { name: /^form field \d+ value$/ }).last().fill(v!);
    }
    await button(page, 'Save').click();
    await runOnce(page, 'Form');
    expect((await echo(page)).bodyText).toBe('a=1&a=2+3&%C3%A9=%C3%BC');

    await addEndpoint(page, { name: 'Upload', alias: 'upload', method: 'POST', url: '/api/echo', body: { kind: 'multipart' } });
    await page.getByRole('button', { name: 'Edit Upload (upload)' }).click();
    await button(page, 'Add field').click();
    await page.getByRole('textbox', { name: 'Part 1 name' }).fill('note');
    await page.getByRole('textbox', { name: 'Part 1 value' }).fill('日本');
    await button(page, 'Add file').click();
    await page.getByRole('textbox', { name: 'Part 2 name' }).fill('doc');
    await page.getByRole('textbox', { name: 'Part 2 expected file name (hint)' }).fill('receipt.txt');
    await button(page, 'Save').click();
    await page.getByRole('button', { name: 'Run Upload once' }).click();
    await expect(page.locator('#aw-once-blocked')).toContainText('File for "doc" is not selected (expected receipt.txt)');
    const hits = (await counters(page))['/api/echo'] ?? 0;
    await page.locator('#aw-once-run').click(); // blocked: nothing is sent
    expect((await counters(page))['/api/echo'] ?? 0).toBe(hits);
    await page.getByLabel('File for doc').setInputFiles({ name: 'receipt.txt', mimeType: 'text/plain', buffer: Buffer.from('paid ✓') });
    await expect(page.locator('#aw-once-blocked')).toHaveCount(0);
    await page.locator('#aw-once-run').click();
    await expect(page.locator('#aw-once-verdict')).toHaveText('Checks passed');
    const e = await echo(page);
    expect(e.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(e.bodyText).toContain('name="note"\r\n\r\n日本');
    expect(e.bodyText).toContain('filename="receipt.txt"\r\nContent-Type: text/plain\r\n\r\npaid ✓');
  });

  test('credentials include / omit / same-origin reach the server as configured', async ({ page }) => {
    await page.request.get(`${A}/__reset`);
    await page.evaluate(() => (window as any).fx.send({ url: '/api/login', method: 'POST' }));
    await launch(page);
    await addEndpoint(page, { name: 'Local omit', alias: 'local_omit', url: '/api/echo', cred: 'omit' });
    await addEndpoint(page, { name: 'Local same', alias: 'local_same', url: '/api/echo' });
    await addEndpoint(page, { name: 'Other same', alias: 'other_same', host: '', url: `${B}/api/echo` });
    await addEndpoint(page, { name: 'Other include', alias: 'other_include', host: '', url: `${B}/api/echo`, cred: 'include' });
    const session = async (name: string) => { await openEndpoints(page); await runOnce(page, name); return (await echo(page)).session; };
    expect(await session('Local omit')).toBeNull();
    expect(await session('Local same')).toBe('s3cr3t-session');
    expect(await session('Other same')).toBeNull();
    expect(await session('Other include')).toBe('s3cr3t-session');
    expect((await echo(page)).servedBy).toBe('B');
  });

  test('Direct bypasses an active mock; Apply rules is mocked and traced', async ({ page }) => {
    await launch(page);
    await tab(page, 'Mock');
    await button(page, 'Add ad-hoc rule').click();
    await button(page, 'Save').click();
    await button(page, 'Activate Mock module').click();
    await addEndpoint(page, { name: 'Target', alias: 'target', url: '/api/mock-target' });
    await runOnce(page, 'Target', 'Direct');
    expect((await counters(page))['/api/mock-target']).toBe(1);
    expect(await body(page).textContent()).not.toContain('mocked');
    await button(page, 'Apply rules').click();
    await page.locator('#aw-once-run').click();
    await expect(page.locator('#aw-once-ident')).toContainText('Run #2');
    await expect(body(page)).toContainText('"mocked":true');
    expect((await counters(page))['/api/mock-target']).toBe(1);
    await tab(page, 'Home');
    await expect(page.locator('[data-api-workbench] button[data-id]').first()).toContainText('Mock');
  });

  test('Cancel settles the owned request; an expected 503 passes; a truncated body is not evaluated', async ({ page }) => {
    await launch(page);
    await addEndpoint(page, { name: 'Slow', alias: 'slow', url: '/api/slow?ms=4000' });
    await page.getByRole('button', { name: 'Run Slow once' }).click();
    await page.locator('#aw-once-run').click();
    await expect(page.locator('#aw-once-run')).toBeDisabled();
    await button(page, 'Cancel').click();
    await expect(page.locator('#aw-once-verdict')).toHaveText('Cancelled');
    await expect(page.locator('#aw-once-run')).toBeEnabled();

    await addEndpoint(page, { name: 'Down', alias: 'down', url: '/api/status?code=503' });
    await page.getByRole('button', { name: 'Edit Down (down)' }).click();
    await page.getByRole('textbox', { name: 'Check 1 minimum status' }).fill('503');
    await page.getByRole('textbox', { name: 'Check 1 maximum status' }).fill('503');
    await button(page, 'Save').click();
    await runOnce(page, 'Down');
    await expect(page.locator('#aw-once-verdict')).toHaveText('Checks passed');

    await addEndpoint(page, { name: 'Big', alias: 'big', url: '/api/big?n=2097152' });
    await page.getByRole('button', { name: 'Edit Big (big)' }).click();
    await button(page, 'Add check').click();
    await page.getByRole('combobox', { name: 'Check 2 kind' }).selectOption('body-contains');
    await page.getByRole('textbox', { name: 'Check 2 text' }).fill('a');
    await button(page, 'Save').click();
    await runOnce(page, 'Big');
    await expect(page.locator('#aw-once-verdict')).toHaveText('1 check not evaluated');
    await expect(page.getByRole('list', { name: 'Checks' })).toContainText('Body is truncated');
  });

  test('Add check from a result opens a dirty editor draft; Escape asks and Keep editing retains it', async ({ page }) => {
    await launch(page);
    await addEndpoint(page, { name: 'Ping', alias: 'ping', url: '/api/echo' });
    await runOnce(page, 'Ping');
    await button(page, 'Add check').click();
    await expect(page.getByRole('textbox', { name: 'Check 2 minimum status' })).toHaveValue('200');
    await expect(page.getByRole('button', { name: 'Back to Test' })).toBeVisible();
    await page.locator('#aw-ep-name').press('Escape');
    await button(page, 'Keep editing').click();
    await expect(page.getByRole('textbox', { name: 'Check 2 minimum status' })).toHaveValue('200');
    await button(page, 'Save').click();
    await expect(page.getByRole('heading', { name: 'API Tester' })).toBeVisible();
  });
});

test.describe('headers, presets, Promote common, environments, aliases (G14)', () => {
  test('global default, local override and explicit removal; CSRF preset blocks until the cookie exists', async ({ page }) => {
    await launch(page);
    await openEndpoints(page);
    await page.getByRole('button', { name: /^Global headers/ }).click();
    await button(page, 'Add header').click();
    await page.getByRole('textbox', { name: 'Header 1 name' }).fill('X-Test');
    await page.getByRole('textbox', { name: 'Header 1 value' }).fill('global');
    await page.getByRole('combobox', { name: 'Add header preset' }).selectOption({ label: 'CSRF from cookie XSRF-TOKEN' });
    await button(page, 'Save').click();
    await expect(page.getByRole('button', { name: 'Global headers (2)' })).toBeFocused();
    await addEndpoint(page, { name: 'Inherit', alias: 'inherit', url: '/api/echo' });
    await addEndpoint(page, { name: 'Override', alias: 'override', url: '/api/echo', headers: [['x-test', 'local']] });
    await addEndpoint(page, { name: 'Drop', alias: 'drop', url: '/api/echo', headers: [['X-Test', '']] });
    await page.getByRole('button', { name: 'Edit Drop (drop)' }).click();
    await page.getByRole('checkbox', { name: 'Remove X-Test from this request' }).click();
    await expect(page.getByText('removed here')).toBeVisible();
    await button(page, 'Save').click();

    await page.getByRole('button', { name: 'Run Inherit once' }).click();
    await expect(page.locator('#aw-once-blocked')).toContainText('cookie "XSRF-TOKEN" is not available on this page');
    await page.evaluate(() => { document.cookie = 'XSRF-TOKEN=tok-abcdef12; path=/'; });
    await button(page, 'Direct').click(); // any refresh re-reads sources
    await expect(page.locator('#aw-once-blocked')).toHaveCount(0);
    await expect(page.getByText('X-XSRF-TOKEN: ••••ef12 (12 chars)')).toBeVisible();
    await page.locator('#aw-once-run').click();
    await expect(page.locator('#aw-once-verdict')).toBeVisible();
    expect((await echo(page)).headers).toMatchObject({ 'x-test': 'global', 'x-xsrf-token': 'tok-abcdef12' });
    for (const [name, want] of [['Override', 'local'], ['Drop', null]] as const) {
      await openEndpoints(page);
      await runOnce(page, name);
      expect((await echo(page)).headers['x-test']).toBe(want);
    }
  });

  test('Promote common moves identical headers atomically; differing auth stays; a failed commit changes nothing', async ({ page }) => {
    await launch(page);
    await addEndpoint(page, { name: 'Accounts', alias: 'accounts', url: '/api/echo', headers: [['Accept', 'application/json'], ['Authorization', 'Bearer one']] });
    await addEndpoint(page, { name: 'Payees', alias: 'payees', url: '/api/echo', headers: [['accept', 'application/json'], ['Authorization', 'Bearer two']] });
    await page.getByRole('button', { name: 'Promote common…' }).click();
    await page.getByRole('checkbox', { name: 'Select Accounts' }).click();
    await page.getByRole('checkbox', { name: 'Select Payees' }).click();
    await expect(page.getByText('+ global Accept: application/json · removed locally from 2 endpoints')).toBeVisible();

    // Storage refuses the write: nothing changes.
    await page.evaluate(() => { (window as any).__put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function () { throw new DOMException('Quota exceeded', 'QuotaExceededError'); }; });
    await button(page, 'Promote 1 header').click();
    await expect(page.getByRole('dialog')).toContainText('Nothing was changed');
    await button(page, 'OK').click();
    await page.evaluate(() => { IDBObjectStore.prototype.put = (window as any).__put; });
    await button(page, 'Cancel').click();
    await expect(page.getByRole('button', { name: 'Global headers (0)' })).toBeVisible();

    await page.getByRole('button', { name: 'Promote common…' }).click();
    await page.getByRole('checkbox', { name: 'Select Accounts' }).click();
    await page.getByRole('checkbox', { name: 'Select Payees' }).click();
    await button(page, 'Promote 1 header').click();
    await expect(page.getByRole('button', { name: 'Promote common…' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Global headers (1)' })).toBeVisible();
    await page.getByRole('button', { name: 'Edit Accounts (accounts)' }).click();
    await expect(page.getByRole('textbox', { name: 'Header 1 name' })).toHaveValue('Authorization');
    await expect(page.getByRole('textbox', { name: 'Header 2 name' })).toHaveCount(0);
    await expect(page.getByText('Accept: application/json')).toBeVisible(); // now inherited
  });

  test('environment switch retargets host-key endpoints only; absolute URLs stay; preview names the change', async ({ page }) => {
    await launch(page);
    await openEndpoints(page);
    await button(page, 'Environments…').click();
    await page.getByRole('textbox', { name: 'New host key' }).fill('api');
    await button(page, 'Add host').click();
    await page.getByRole('textbox', { name: 'Origin for host api in default' }).fill(A);
    await page.getByRole('textbox', { name: 'New environment name' }).fill('stage');
    await button(page, 'Add environment').click();
    await page.getByRole('textbox', { name: 'Origin for host api in stage' }).fill('ftp://bad');
    await button(page, 'Save').click();
    await expect(page.locator('.aw-err', { hasText: 'Only http and https origins are supported' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Origin for host api in stage' }).fill(B);
    await button(page, 'Save').click();
    await addEndpoint(page, { name: 'Hosted', alias: 'hosted', host: 'api', url: '/api/echo' });
    await addEndpoint(page, { name: 'Pinned', alias: 'pinned', host: '', url: `${A}/api/echo` });
    await button(page, 'Environments…').click();
    await page.locator('#aw-env-active').selectOption('stage');
    await expect(page.getByText(`Hosted: ${A}/api/echo → ${B}/api/echo`)).toBeVisible();
    await expect(page.getByText('1 absolute-URL endpoint(s) are unchanged by environments.')).toBeVisible();
    await button(page, 'Save').click();
    await runOnce(page, 'Hosted');
    expect((await echo(page)).servedBy).toBe('B');
    await openEndpoints(page);
    await runOnce(page, 'Pinned');
    expect((await echo(page)).servedBy).toBe('A');
  });

  test('alias rename previews and updates exact references only; delete previews impact and Cancel keeps it', async ({ page }) => {
    await launch(page);
    await addEndpoint(page, { name: 'Account', alias: 'acct', url: '/api/echo' });
    await addEndpoint(page, { name: 'Account list', alias: 'acct_list', url: '/api/echo' });
    await addEndpoint(page, { name: 'Use', alias: 'use', method: 'POST', url: '/api/echo/{{acct.id}}/{{acct_list.id}}', body: { kind: 'text', text: 'acct.id literal {{acct}}' } });
    await page.getByRole('button', { name: 'Edit Account (acct)' }).click();
    await page.locator('#aw-ep-alias').fill('account');
    await button(page, 'Save').click();
    await expect(page.getByRole('dialog')).toContainText('update 2 reference(s) in Use');
    await button(page, 'Update references').click();
    await page.getByRole('button', { name: 'Edit Use (use)' }).click();
    await expect(page.locator('#aw-ep-url')).toHaveValue('/api/echo/{{account.id}}/{{acct_list.id}}');
    await expect(page.locator('#aw-ep-body')).toHaveValue('acct.id literal {{account}}');
    await button(page, 'Back to Endpoints').click();
    await page.getByRole('button', { name: 'Delete Account list' }).click();
    await expect(page.getByRole('dialog')).toContainText('1 reference(s) to {{acct_list…}} in Use become unresolved');
    await button(page, 'Cancel').click();
    await expect(page.getByRole('button', { name: 'Edit Account list (acct_list)' })).toBeVisible();
    await page.getByRole('button', { name: 'Delete Account list' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('button', { name: 'Edit Account list (acct_list)' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Run Use once' }).click();
    await expect(page.locator('#aw-once-blocked')).toContainText('{{acct_list.id}} needs the expression engine');
  });
});

test.describe('storage, profiles, backup and migration (G21)', () => {
  test('profiles: create, copy, rename, switch, delete; the last delete leaves a safe empty profile', async ({ page }) => {
    await launch(page);
    await addEndpoint(page, { name: 'Ping', alias: 'ping', url: '/api/echo' });
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await page.locator('#aw-prof-new').fill('Staging');
    await button(page, 'Save a copy of Default').click();
    await expect(page.locator('#aw-profile-name')).toHaveText('Staging');
    await page.locator('#aw-prof-rename').fill('default');
    await button(page, 'Rename').click();
    await expect(page.getByRole('status').filter({ hasText: 'already exists' })).toHaveCount(1);
    await page.locator('#aw-prof-new').fill('Empty');
    await button(page, 'Create empty').click();
    await expect(page.locator('#aw-profile-name')).toHaveText('Empty');
    await page.reload();
    await page.waitForFunction(() => (window as any).fx);
    await launch(page);
    await expect(page.locator('#aw-profile-name')).toHaveText('Empty'); // active pointer persisted
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await page.locator('#aw-prof-select').selectOption({ label: 'Staging · 1 endpoint' });
    await button(page, 'Switch to the selected profile').click();
    await expect(page.locator('#aw-profile-name')).toHaveText('Staging');
    for (let left = 3; left > 0; left--) { // Delete applies to the active profile
      const name = (await page.locator('#aw-profile-name').textContent())!;
      await page.getByRole('button', { name: `Delete ${name}`, exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
      await expect(page.locator('#aw-prof-select option')).toHaveCount(Math.max(1, left - 1));
    }
    await expect(page.locator('#aw-profile-name')).toHaveText('Default');
    await expect(page.locator('#aw-prof-select option')).toHaveText(['Default · 0 endpoints']);
  });

  test('backup export → clear → restore round-trip; redacted by default; future schema refused', async ({ page }) => {
    await launch(page);
    await addEndpoint(page, { name: 'Secret', alias: 'secret', url: '/api/echo', headers: [['Authorization', 'Bearer live-token']] });
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await expect(page.locator('#aw-export-preview')).toContainText('Redacted by default (re-entry needed after import): Secret: Authorization');
    const [dl] = await Promise.all([page.waitForEvent('download'), button(page, 'Export all profiles (backup)').click()]);
    const text = readFileSync((await dl.path())!, 'utf8');
    expect(text).not.toContain('live-token');
    expect(JSON.parse(text)).toMatchObject({ format: 'api-workbench', kind: 'backup', schema: 2, redacted: true });

    await page.locator('#aw-import-paste').fill(text.replace('"schema": 2', '"schema": 3'));
    await button(page, 'Review pasted JSON').click();
    await expect(page.locator('#aw-review')).toContainText('newer than this build supports');

    await button(page, 'Clear local data…').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Clear local data' }).click();
    await expect(page.locator('#aw-prof-select option')).toHaveText(['Default · 0 endpoints']);

    await page.locator('#aw-import-file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await expect(page.locator('#aw-review')).toContainText('Default: 1 endpoints, 0 plans');
    await button(page, 'Replace all profiles with this backup').click();
    await expect(page.locator('#aw-prof-select option')).toHaveText(['Default · 1 endpoint']);
    await openEndpoints(page);
    await page.getByRole('button', { name: 'Run Secret once' }).click();
    await expect(page.locator('#aw-once-blocked')).toContainText('Header Authorization: value was redacted on export; enter it again');
  });

  test('schema 1 database is migrated after review and left untouched', async ({ page }) => {
    const v1 = {
      profile: { id: 'default', name: 'wires', revision: 1, createdAt: 1, updatedAt: 1, environments: { default: { default: '' } }, activeEnvironment: 'default', globalHeaders: [{ name: 'X-Test', value: 'from-v1' }], settings: { bodyLimitKb: 1024, enabledModules: {} } },
      endpoints: [{ id: 'endpoint-1', profileId: 'default', alias: 'echo', name: 'Old echo', hostKey: 'default', createdAt: 1, updatedAt: 1, request: { method: 'POST', path: '/api/echo', headers: [], bodyKind: 'json', body: '{"a" : 1}', credentials: 'same-origin' }, checks: [{ kind: 'status', value: { min: 200, max: 299 } }] }],
      rules: [], savedProfiles: [],
    };
    await page.evaluate(([cfg, origin]) => new Promise<void>((resolve) => {
      const r = indexedDB.open('api-workbench', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('configs');
      r.onsuccess = () => { const t = r.result.transaction('configs', 'readwrite'); t.objectStore('configs').put(cfg, origin); t.oncomplete = () => { r.result.close(); resolve(); }; };
    }), [v1, A] as const);
    await launch(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await button(page, 'Look for schema 1 data').click();
    await expect(page.locator('#aw-review')).toContainText('wires: 1 endpoints, 0 plans');
    await button(page, 'Add 1 profile').click();
    await page.locator('#aw-prof-select').selectOption({ label: 'wires · 1 endpoint' });
    await button(page, 'Switch to the selected profile').click();
    await openEndpoints(page);
    await runOnce(page, 'Old echo');
    expect(await echo(page)).toMatchObject({ bodyText: '{"a" : 1}', headers: { 'x-test': 'from-v1' } });
    const old = await page.evaluate((origin) => new Promise((resolve) => {
      const r = indexedDB.open('api-workbench');
      r.onsuccess = () => { const g = r.result.transaction('configs').objectStore('configs').get(origin); g.onsuccess = () => { r.result.close(); resolve(g.result); }; };
    }), A);
    expect(old).toEqual(v1);
  });

  test('another tab saving first is a conflict, not a silent overwrite', async ({ page, context }) => {
    await launch(page);
    const other = await context.newPage();
    await other.goto(`${A}/fixture`);
    await other.waitForFunction(() => (window as any).fx);
    await launch(other);
    await addEndpoint(other, { name: 'From tab two', alias: 'two', url: '/api/echo' });
    await addEndpoint(page, { name: 'From tab one', alias: 'one', url: '/api/echo' });
    await expect(page.locator('#aw-save-banner')).toContainText('Another tab saved this profile');
    await button(page, 'Use stored version').click();
    await expect(page.locator('#aw-save-banner')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Edit From tab two (two)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit From tab one (one)' })).toHaveCount(0);
  });

  test('storage refused: session-only work continues; a failed write stays Unsaved until Retry succeeds', async ({ page }) => {
    await page.evaluate(() => { (window as any).__open = indexedDB.open; IDBFactory.prototype.open = function () { throw new DOMException('blocked', 'SecurityError'); }; });
    await page.evaluate(source);
    await expect(page.locator('#aw-save-banner')).toContainText('Storage unavailable');
    await addEndpoint(page, { name: 'Volatile', alias: 'volatile', url: '/api/echo' });
    await runOnce(page, 'Volatile');
    await expect(page.locator('#aw-once-verdict')).toHaveText('Checks passed');

    await fresh(page);
    await page.waitForFunction(() => (window as any).fx);
    await launch(page);
    await page.evaluate(() => { (window as any).__put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function () { throw new DOMException('Quota exceeded', 'QuotaExceededError'); }; });
    await addEndpoint(page, { name: 'Pending', alias: 'pending', url: '/api/echo' });
    await expect(page.locator('#aw-save-banner')).toContainText('Not saved: Quota exceeded');
    await page.evaluate(() => { IDBObjectStore.prototype.put = (window as any).__put; });
    await button(page, 'Retry save').click();
    await expect(page.locator('#aw-save-banner')).toBeHidden();
    await page.reload();
    await page.waitForFunction(() => (window as any).fx);
    await launch(page);
    await openEndpoints(page);
    await expect(page.getByRole('button', { name: 'Edit Pending (pending)' })).toBeVisible();
  });
});

test('constrained viewport: new screens keep actions reachable without horizontal overflow (G22, emulated)', async ({ page }) => {
  await launch(page);
  await addEndpoint(page, { name: 'Create transfer with a long readable name', alias: 'create_transfer', method: 'POST', url: '/api/echo/with/a/rather/long/path/segment', body: { kind: 'json', text: '{}' } });
  await page.setViewportSize({ width: 360, height: 420 });
  const overflow = () => page.locator('[data-api-workbench]').evaluate((el) => {
    const p = el.shadowRoot!.querySelector('.aw-panel') as HTMLElement;
    const m = el.shadowRoot!.querySelector('main') as HTMLElement;
    return { panel: p.scrollWidth - p.clientWidth, main: m.scrollWidth - m.clientWidth, right: p.getBoundingClientRect().right - innerWidth };
  });
  // The window resize handler re-clamps the panel asynchronously, so poll.
  const check = async () => {
    await expect.poll(async () => (await overflow()).right).toBeLessThanOrEqual(0);
    const o = await overflow();
    expect(o.panel).toBeLessThanOrEqual(0);
    expect(o.main).toBeLessThanOrEqual(0);
  };
  await check();
  await page.getByRole('button', { name: 'Edit Create transfer with a long readable name (create_transfer)' }).click();
  await check();
  await expect(button(page, 'Save')).toBeInViewport();
  await button(page, 'Cancel').click();
  await page.getByRole('button', { name: 'Run Create transfer with a long readable name once' }).click();
  await check();
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await check();
});
