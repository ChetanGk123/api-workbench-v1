// R7 cases in real Chrome: Swagger 2.0, OpenAPI 3.0, Postman v2.1, real DevTools cURL and fetch copies.
// Each format: parse → review → commit → representative send (G19); zero requests during import.
// Launch = evaluating the decoded generated bookmark (injection; NOT saved-bookmark evidence).
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openapiDoc, postmanDoc, swaggerDoc } from './import-fixtures';

const A = `http://127.0.0.1:${process.env.AW_PORT ?? 4310}`;
const bookmark = readFileSync('dist/bookmark.txt', 'utf8');
const source = decodeURIComponent(bookmark.slice('javascript:'.length));
const corpus = JSON.parse(readFileSync('tests/fixture/corpus/chrome-154.json', 'utf8')) as { origins: { A: string }; cases: Record<string, string>[] };
/** A corpus copy retargeted at this run's fixture origin (the corpus was captured on port 4320). */
const copy = (id: string, k: string) => corpus.cases.find((c) => c.id === id)![k]!.split(corpus.origins.A).join(A);

const button = (page: Page, name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' });
const counters = async (page: Page): Promise<Record<string, number>> => (await page.request.get(`${A}/__counters`)).json();

async function launch(page: Page) {
  await page.evaluate(source);
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await expect(page.locator('#aw-store-state')).toHaveText(/All changes saved|Storage unavailable/);
  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible();
}
async function paste(page: Page, text: string) {
  await page.locator('#aw-imp-text').fill(text);
  await button(page, 'Apply').click();
  await expect(page.locator('#aw-imp-review')).toBeVisible();
}
async function commitNew(page: Page, name: string, n: number) {
  await page.locator('#aw-imp-dest').selectOption('new');
  await page.locator('#aw-imp-newname').fill(name);
  await button(page, `Import ${n} selected`).click();
  await expect(page.locator('#aw-imp-saved')).toContainText(`Saved to new profile ${name} (now active): ${n} added`);
  await page.getByRole('button', { name: 'Show endpoints' }).click();
}
async function once(page: Page, name: string) {
  await page.getByRole('button', { name: `Run ${name} once`, exact: true }).click();
  await page.locator('#aw-once-run').click();
}
async function echo(page: Page) {
  await expect(page.locator('#aw-once-verdict')).toBeVisible();
  return JSON.parse((await page.locator('#aw-once-body').textContent())!);
}

test.beforeEach(async ({ page }) => {
  await page.request.get(`${A}/__reset`);
  await page.goto(`${A}/fixture`);
  await page.evaluate(() => Promise.all(['api-workbench-v2', 'api-workbench'].map((n) => new Promise((r) => { const q = indexedDB.deleteDatabase(n); q.onsuccess = q.onerror = q.onblocked = r; }))));
  await page.evaluate(() => localStorage.clear());
  await page.waitForFunction(() => (window as any).fx);
});

test('Swagger 2.0: review names missing inputs; a missing value blocks Once by label; a complete operation sends', async ({ page }) => {
  await launch(page);
  const before = await counters(page);
  await paste(page, JSON.stringify(swaggerDoc(A)));
  await expect(page.locator('#aw-imp-review > strong')).toContainText('Swagger 2.0 · Pets (Swagger)');
  await expect(page.locator('#aw-imp-counts')).toHaveText('7 source items · 7 candidates · 0 skipped · 6 need values');
  await expect(page.locator('#aw-imp-review')).toContainText('paths./remote.get: remote reference https://example.invalid/params.json#/Limit was not fetched');
  const create = page.getByRole('listitem', { name: /POST Create pet/ });
  await expect(create).toContainText('Header X-Api-Key: API key (key)');
  await create.getByText(/^Request preview/).click();
  await expect(create).toContainText('X-Api-Key: {{$missing("API key key")}}');
  await page.locator('#aw-cand-name-3').fill('Delete pet');
  await commitNew(page, 'Pets', 7);
  expect(await counters(page)).toEqual(before);

  await page.getByRole('button', { name: 'Run Create pet once', exact: true }).click();
  await expect(page.locator('#aw-once-blocked')).toContainText('API key key: not supplied by the import; enter it before sending');
  await page.getByRole('button', { name: 'Endpoints', exact: true }).first().click();
  await once(page, 'Delete pet');
  expect(await echo(page)).toMatchObject({ method: 'DELETE', path: '/api/pets/p%201' });
});

test('OpenAPI 3.0: server and media example choices change the saved request; the chosen example is sent exactly', async ({ page }) => {
  await launch(page);
  const before = await counters(page);
  await paste(page, JSON.stringify(openapiDoc(A)));
  await expect(page.locator('#aw-imp-server option')).toHaveText([`${A}/api`, '/relative/api']);
  await page.locator('#aw-imp-server').selectOption('1');
  await expect(page.getByRole('listitem', { name: /POST Create order/ })).toContainText(`${A}/relative/api/orders`);
  await page.locator('#aw-imp-server').selectOption('0');
  const row = page.getByRole('listitem', { name: /POST Create order/ });
  await expect(row).toContainText(`${A}/api/orders`);
  const sel = row.getByRole('combobox', { name: 'Body example' });
  await expect(sel.locator('option')).toHaveText(['application/json · example "small"', 'application/json · example "big"', 'application/x-www-form-urlencoded · example']);
  await sel.selectOption({ label: 'application/json · example "big"' });
  await expect(page.locator('#aw-imp-review')).toContainText('"sku": "B2"');
  await commitNew(page, 'Shop', 6);
  expect(await counters(page)).toEqual(before);
  await once(page, 'Create order');
  expect(await echo(page)).toMatchObject({ method: 'POST', path: '/api/orders', bodyText: '{\n  "sku": "B2",\n  "qty": 500,\n  "price": "9.99"\n}', headers: { 'content-type': 'application/json' } });
});

test('Postman v2.1: file and paste agree; noauth request sends with resolved variables; inherited bearer blocks', async ({ page }) => {
  await launch(page);
  const text = JSON.stringify(postmanDoc(A));
  const before = await counters(page);
  await page.locator('#aw-imp-file').setInputFiles({ name: 'bank.postman_collection.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await expect(page.locator('#aw-imp-review')).toBeVisible();
  const fromFile = await page.locator('#aw-imp-review ul').innerText();
  await paste(page, text);
  await expect(page.locator('#aw-imp-state')).toContainText('Pasted text');
  expect(await page.locator('#aw-imp-review ul').innerText()).toBe(fromFile);
  await expect(page.locator('#aw-imp-review')).toContainText('Collection: prerequest script was not run');
  await expect(page.getByRole('listitem', { name: /GET Accounts \/ Get account/ })).toContainText(`${A}/api/accounts/ACC-FOLDER?expand=1`);
  expect(await page.locator('[data-api-workbench]').evaluate((el) => el.shadowRoot!.textContent)).not.toContain('collection-secret-token');
  await commitNew(page, 'Bank', 7);
  expect(await counters(page)).toEqual(before);
  await once(page, 'Accounts / Public rates');
  expect(await echo(page)).toMatchObject({ method: 'GET', path: '/api/rates', headers: { authorization: null } });
  await page.getByRole('button', { name: 'Endpoints', exact: true }).first().click();
  await page.getByRole('button', { name: 'Run Transfers / Create transfer once', exact: true }).click();
  await expect(page.locator('#aw-once-blocked')).toContainText('bearer token: not supplied by the import');
});

test('real DevTools cURL: bash file and paste agree and send the exact body; the cmd copy names its losses', async ({ page }) => {
  await launch(page);
  const bash = copy('post-json-escapes', 'curlBash');
  const before = await counters(page);
  await page.locator('#aw-imp-file').setInputFiles({ name: 'copy.sh', mimeType: 'text/plain', buffer: Buffer.from(bash) });
  await expect(page.locator('#aw-imp-review > strong')).toContainText('cURL (bash) · copy.sh');
  const fromFile = await page.locator('#aw-imp-review ul').innerText();
  await paste(page, bash);
  expect(await page.locator('#aw-imp-review ul').innerText()).toBe(fromFile);
  await expect(page.locator('#aw-imp-review')).toContainText('Set by the browser and not kept: User-Agent, Connection, Origin, Referer, Sec-Fetch-Dest');
  await commitNew(page, 'From curl', 1);
  expect(await counters(page)).toEqual(before);
  await once(page, '/api/echo');
  const sent = await echo(page);
  expect(sent).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json', 'x-corpus': 'post-json-escapes' } });
  expect(sent.bodyText).toBe('{"text":"line1\\nline2\\ttab \\"dq\\" \'sq\' back\\\\slash $HOME !bang %PATH% ^caret &amp","emoji":"😀","n":1.1}');

  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  await paste(page, copy('post-json-escapes', 'curlCmd'));
  await expect(page.locator('#aw-imp-review > strong')).toContainText('cURL (Windows cmd)');
  await expect(page.locator('#aw-imp-review')).toContainText('DevTools replaces non-ASCII text with spaces in cmd copies');
});

test('real DevTools fetch: method, query, header and body are sent exactly; code is refused and nothing runs', async ({ page }) => {
  await launch(page);
  const before = await counters(page);
  await paste(page, copy('put-glob-cmd-chars', 'fetch'));
  await expect(page.locator('#aw-imp-review')).toContainText('referrer is set by the browser and is not preserved');
  await commitNew(page, 'From fetch', 1);
  expect(await counters(page)).toEqual(before);
  await once(page, '/api/echo/items[1]/%7Bid%7D');
  expect(await echo(page)).toMatchObject({
    method: 'PUT', path: '/api/echo/items[1]/%7Bid%7D', // as the page sent it: fetch does not encode [ ] query: [['a', '1'], ['b', '%PATH%']],
    headers: { 'content-type': 'text/plain', 'x-odd': '100% ^ & | < > "q"' }, bodyText: 'plain & simple | 50% <ok> "q" \\ end',
  });

  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  const n = await counters(page);
  await page.evaluate(() => { (window as any).pwned = 0; });
  await page.locator('#aw-imp-text').fill('fetch("/api/echo", { body: (window.pwned = 1, "x") })');
  await button(page, 'Apply').click();
  await expect(page.locator('#aw-imp-errors')).toContainText('A parenthesized expression is code; only literal values are accepted. Nothing was run.');
  await page.locator('#aw-imp-text').fill("curl 'http://127.0.0.1/api/echo' -H \"X: $(touch /tmp/x)\"");
  await button(page, 'Apply').click();
  await expect(page.locator('#aw-imp-errors')).toContainText('$ inside double quotes is a variable or substitution; it is not expanded. Nothing was run.');
  expect(await page.evaluate(() => (window as any).pwned)).toBe(0);
  expect(await counters(page)).toEqual(n);
  await page.locator('#aw-imp-help summary').click();
  await expect(page.locator('#aw-imp-help')).toContainText('Swagger 2.0 / OpenAPI 3.0 (JSON)');
  await expect(page.locator('#aw-imp-help')).toContainText('Variables, calls, template literals, new and JSON.stringify are refused.');
});
