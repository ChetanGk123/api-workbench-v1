// R1 shell, navigation, geometry and request-detail cases in real Chrome. Launch = evaluating the decoded
// generated bookmark (injection; NOT evidence of saved-bookmark installation).
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { addIntercept, fill, newRule, OLD_MOCK_BODY, saveRule, tab } from './rule-helpers';

const A = `http://127.0.0.1:${process.env.AW_PORT ?? 4310}`;
const bookmark = readFileSync('dist/bookmark.txt', 'utf8');
const source = decodeURIComponent(bookmark.slice('javascript:'.length));
const KEY = 'api-workbench:geometry:v1';

const launch = (page: Page) => page.evaluate(source);
const send = (page: Page, o: Record<string, unknown>) => page.evaluate((opts) => (window as any).fx.send(opts), o) as Promise<Record<string, any>>;
const aw = (page: Page) => page.locator('[data-api-workbench]');
const box = async (page: Page) => (await page.locator('[data-api-workbench] .aw-panel').boundingBox())!;
const focusedKey = (page: Page) => aw(page).evaluate((el) => el.shadowRoot!.activeElement?.getAttribute('data-key') ?? el.shadowRoot!.activeElement?.id ?? null);
const stored = (page: Page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), KEY);

test.beforeEach(async ({ page }) => {
  await page.request.get(`${A}/__reset`);
  await page.goto(`${A}/fixture`);
  await page.evaluate((k) => localStorage.removeItem(k), KEY);
  await page.waitForFunction(() => (window as any).fx);
});

test.describe('navigation and drafts (S00.1/S00.2, G22)', () => {
  test('every destination keeps module navigation; host URL, history, DOM and styles untouched', async ({ page }) => {
    const hostState = () => page.evaluate(() => ({
      href: location.href, history: history.length, title: document.title,
      body: document.body.innerHTML, bodyStyle: getComputedStyle(document.body).cssText || getComputedStyle(document.body).font,
      sheets: document.styleSheets.length,
    }));
    const before = await hostState();
    await launch(page);
    await send(page, { url: '/api/echo' });
    for (const s of ['Endpoints', 'Import', 'Settings']) {
      await page.getByRole('button', { name: s, exact: true }).first().click();
      await expect(page.getByRole('navigation', { name: 'Modules' })).toBeVisible();
    }
    await tab(page, 'Mock'); // Import → Endpoints → Mock with no Home detour
    await expect(page.getByRole('heading', { name: 'Mock Server' })).toBeFocused();
    for (const t of ['Test', 'Intercept', 'Route', 'Chaos', 'Home']) await tab(page, t);
    await page.locator('[data-api-workbench] button[data-id]').first().click();
    await page.getByRole('button', { name: 'Back to Home' }).click();
    expect(await hostState()).toEqual(before);
  });

  test('Home cards: New rule opens the editor and returns to Home; enabled vs active stated separately', async ({ page }) => {
    await launch(page);
    const card = page.getByRole('region', { name: 'Mock Server' });
    await expect(card).toContainText('No rules yet');
    await card.getByRole('button', { name: 'New Mock rule' }).click();
    await expect(page.getByRole('heading', { name: 'New mock rule' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Back to Home' })).toBeVisible();
    await fill(page, { 'aw-path': '/api/mock-target', 'aw-body': OLD_MOCK_BODY });
    await saveRule(page);
    await expect(card).toContainText('1 enabled rule · Module inactive: traffic unaffected');
    expect(await focusedKey(page)).toBe('card-mock');
    expect((await send(page, { url: '/api/mock-target' })).body.text).not.toContain('mocked');
    await card.getByRole('button', { name: 'Activate Mock module' }).click();
    expect((await send(page, { url: '/api/mock-target' })).body.text).toContain('mocked');
    await expect(card).toContainText('1 enabled rule · 1 replies served');
    await expect(page.getByRole('region', { name: 'API Interceptor' })).toContainText('No rules yet');
    await expect(page.getByRole('region', { name: 'API Interceptor' })).toContainText('Inactive');

    // Route's editor opened from Home also returns to Home, and a dirty Cancel asks first.
    await page.getByRole('region', { name: 'Page Routing' }).getByRole('button', { name: 'New Route rule' }).click();
    await page.locator('#aw-route-dest').fill('http://127.0.0.1:1');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.locator('#aw-route-dest')).toHaveValue('http://127.0.0.1:1');
    await page.getByRole('button', { name: 'Back to Home' }).click();
    await page.getByRole('button', { name: 'Discard' }).click();
    expect(await focusedKey(page)).toBe('card-route');
  });

  test('editor from a module list returns there and focuses the saved rule', async ({ page }) => {
    await launch(page);
    await newRule(page, 'Mock');
    await expect(page.getByRole('button', { name: 'Back to Mock' })).toBeVisible();
    await fill(page, { 'aw-label': 'Accounts', 'aw-path': '/api/accounts' });
    await saveRule(page);
    await expect(page.getByRole('button', { name: 'Edit Accounts' })).toBeFocused();
  });

  test('caret and value stay put in an editor while traffic bursts', async ({ page }) => {
    await launch(page);
    await newRule(page, 'Mock');
    const label = page.locator('#aw-r-label');
    await label.fill('abcdef');
    await label.evaluate((el: HTMLInputElement) => el.setSelectionRange(3, 3));
    await page.evaluate(() => Promise.all(Array.from({ length: 40 }, () => fetch('/api/echo'))));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await expect(label).toBeFocused();
    expect(await label.evaluate((el: HTMLInputElement) => [el.value, el.selectionStart])).toEqual(['abcdef', 3]);
  });
});

test.describe('request detail (S21.1/S21.2 R1 portion, G08)', () => {
  test('identical URLs open their own records; Back restores filter, scroll and row focus', async ({ page }) => {
    await launch(page);
    await send(page, { transport: 'xhr', url: '/api/echo?k=secret', responseType: 'arraybuffer' });
    await send(page, { url: '/api/echo?k=secret' });
    for (let i = 0; i < 20; i++) await send(page, { url: `/api/text?i=${i}` });
    const rows = page.locator('[data-api-workbench] button[data-id]');

    await page.locator('#aw-filter').fill('echo');
    await expect(rows).toHaveCount(2);
    await rows.nth(1).click(); // older: the XHR
    await expect(page.getByRole('heading', { name: 'Request #1' })).toBeFocused();
    await expect(aw(page).locator('.aw-detail')).toContainText('responseType arraybuffer');
    await expect(aw(page).locator('.aw-detail')).toContainText('(query values not stored)');
    await page.getByRole('button', { name: 'Back to Home' }).click();
    await expect(page.locator('#aw-filter')).toHaveValue('echo');
    expect(await focusedKey(page)).toBe('req-1');
    await rows.nth(0).click();
    await expect(page.getByRole('heading', { name: 'Request #2' })).toBeVisible();
    await expect(aw(page).locator('.aw-detail')).toContainText('Fetch');
    await expect(aw(page).locator('.aw-detail')).not.toContainText('arraybuffer');
    expect(await aw(page).evaluate((el) => el.shadowRoot!.textContent!.includes('secret'))).toBe(false);

    // Scroll position of the main region is restored too.
    await page.getByRole('button', { name: 'Back to Home' }).click();
    await page.locator('#aw-filter').fill('');
    const main = aw(page).locator('main');
    await main.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const top = await main.evaluate((el) => el.scrollTop);
    expect(top).toBeGreaterThan(0);
    await rows.nth(5).click();
    await page.getByRole('button', { name: 'Back to Home' }).click();
    expect(await main.evaluate((el) => el.scrollTop)).toBe(top);
  });

  test('mixed outcome is explained per operation with rule names and timing', async ({ page }) => {
    await launch(page);
    await newRule(page, 'Route');
    await fill(page, { 'aw-label': 'Wires to local', 'aw-path': '/api/mock-target', 'aw-dest': A, 'aw-rewrite': '/api/r0-routed' });
    await saveRule(page);
    await page.getByRole('button', { name: 'Activate Route module' }).click();
    await addIntercept(page, { find: 'r0' });
    await send(page, { transport: 'xhr', url: '/api/mock-target', responseType: 'arraybuffer' });
    await page.locator('[data-api-workbench] button[data-id]').first().click();
    const d = aw(page).locator('.aw-detail');
    await expect(d).toContainText('Applied route · Skipped intercept response · XHR arraybuffer · routed URL sent');
    await expect(d).toContainText(`GET ${A}/api/r0-routed`);
    await expect(d).toContainText('Wires to local: Sent to');
    await expect(d).toContainText('Any /api/mock-target: Response unchanged: XHR arraybuffer response cannot be edited as text');
    await expect(d).toContainText(/\+\d+ ms/);
    await expect(d).toContainText('HTTP 200');
    await expect(page.getByRole('button', { name: 'Back to Intercept' })).toBeVisible();
  });

  test('an evicted record says so instead of showing another request', async ({ page }) => {
    await launch(page);
    await send(page, { url: '/api/echo' });
    await page.locator('[data-api-workbench] button[data-id]').first().click();
    await expect(page.getByRole('heading', { name: 'Request #1' })).toBeVisible();
    await page.evaluate(async () => { for (let i = 0; i < 5; i++) await Promise.all(Array.from({ length: 100 }, () => fetch('/api/echo'))); });
    await expect(aw(page).locator('.aw-detail')).toContainText('Request #1 is no longer retained');
  });
});

test.describe('geometry (G22, R0 carry-over)', () => {
  test('drag moves the panel, persists per origin and survives reload; bad or offscreen values recover', async ({ page }) => {
    await launch(page);
    const start = await box(page);
    expect(start.x + start.width).toBeGreaterThan(page.viewportSize()!.width - 40); // default top-right
    const brand = aw(page).getByText('API Workbench', { exact: true });
    const b = (await brand.boundingBox())!;
    await page.mouse.move(b.x + 5, b.y + 5);
    await page.mouse.down();
    await page.mouse.move(b.x - 300, b.y - 5, { steps: 5 });
    await page.mouse.up();
    const moved = await box(page);
    expect(Math.round(moved.x - start.x)).toBe(-305);
    expect(Math.round(moved.y - start.y)).toBe(-10);
    expect(await stored(page)).toMatchObject({ panel: { x: Math.round(moved.x), y: Math.round(moved.y) } });
    await expect(page.getByRole('heading', { name: 'Home' })).toBeAttached(); // drag did not navigate

    await page.reload();
    await launch(page);
    expect(await box(page)).toMatchObject({ x: moved.x, y: moved.y });

    await page.evaluate((k) => localStorage.setItem(k, '{"panel":{"x":9000,"y":9000},"size":{"w":99999,"h":"x"}}'), KEY);
    await page.reload();
    await launch(page);
    const vp = page.viewportSize()!;
    const p = await box(page);
    expect(p.x + p.width).toBeLessThanOrEqual(vp.width);
    expect(p.y + p.height).toBeLessThanOrEqual(vp.height);

    await page.setViewportSize({ width: 700, height: 500 });
    await expect.poll(async () => { const q = await box(page); return q.x >= 0 && q.x + q.width <= 700 && q.y + q.height <= 500; }).toBe(true);
  });

  test('keyboard moves and resizes; storage failure is reported as session-only', async ({ page }) => {
    await launch(page);
    const move = page.getByRole('button', { name: /^Move panel/ });
    const a = await box(page);
    await move.focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Shift+ArrowUp');
    await page.keyboard.press('Shift+ArrowLeft');
    const b = await box(page);
    expect([Math.round(b.x - a.x), Math.round(b.y - a.y), Math.round(b.width - a.width), Math.round(b.height - a.height)]).toEqual([-32, -16, -16, -16]);
    expect(await stored(page)).toMatchObject({ size: { w: Math.round(a.width) - 16, h: Math.round(a.height) - 16 } });
    await expect(page.getByRole('navigation', { name: 'Modules' })).toBeVisible();

    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('blocked', 'SecurityError'); }; });
    await page.keyboard.press('ArrowLeft');
    await expect(aw(page).locator('.aw-sr[role=status]')).toHaveText(/session only/);
    expect(Math.round((await box(page)).x - b.x)).toBe(-16);
  });

  test('native resize grip sets the size preference and it survives reload', async ({ page }) => {
    await launch(page);
    await page.getByRole('button', { name: 'Endpoints', exact: true }).first().click(); // short empty screen: the grip is well inside the viewport
    const p = await box(page);
    await page.mouse.move(p.x + p.width - 3, p.y + p.height - 3);
    await page.mouse.down();
    await page.mouse.move(p.x + p.width - 103, p.y + p.height + 57, { steps: 5 });
    await page.mouse.up();
    const q = await box(page);
    expect([q.width, q.height]).toEqual([Math.round(p.width - 100), Math.round(p.height + 60)]);
    expect(await stored(page)).toMatchObject({ size: { w: q.width, h: q.height } });
    await page.reload();
    await launch(page);
    expect(await box(page)).toMatchObject({ width: q.width, height: q.height });
  });

  test('constrained viewport: Close reachable, no horizontal overflow, editor actions visible', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 420 }); // ≈ 720×840 at 200% zoom (emulated, not real zoom)
    await launch(page);
    const close = page.getByRole('button', { name: 'Close API Workbench and remove its hooks' });
    const c = (await close.boundingBox())!;
    expect(c.x + c.width).toBeLessThanOrEqual(360);
    const overflow = await aw(page).locator('.aw-panel').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await newRule(page, 'Mock'); // labels visually collapsed, accessible names intact
    const save = (await page.getByRole('button', { name: 'Save', exact: true }).boundingBox())!;
    expect(save.y + save.height).toBeLessThanOrEqual(420);
  });
});

test.describe('minimize and lifecycle (S00.3/S20.1, G03)', () => {
  test('minimized draft survives relaunch with focus; launcher Close asks first; launcher position is separate', async ({ page }) => {
    await launch(page);
    await newRule(page, 'Mock');
    await page.locator('#aw-slot-0-body').fill('draft X');
    await page.getByRole('button', { name: 'Minimize', exact: true }).click();
    await expect(page.getByRole('region', { name: 'API Workbench minimized' })).toContainText('No modules active');

    const l = (await aw(page).locator('.aw-launcher').boundingBox())!;
    await page.mouse.move(l.x + 30, l.y + 26);
    await page.mouse.down();
    await page.mouse.move(l.x - 170, l.y + 226, { steps: 4 });
    await page.mouse.up();
    const g = await stored(page);
    expect(g.launcher).toEqual({ x: Math.round(l.x - 200), y: Math.round(l.y + 200) });
    expect(g.panel).toBeUndefined();

    await launch(page); // saved-bookmark click again
    await expect(aw(page)).toHaveCount(1);
    await expect(page.locator('#aw-slot-0-body')).toHaveValue('draft X');
    await expect(page.locator('#aw-slot-0-body')).toBeFocused();

    await page.getByRole('button', { name: 'Minimize', exact: true }).click();
    await aw(page).locator('.aw-launcher').getByRole('button', { name: 'Close API Workbench and remove its hooks' }).click();
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.locator('#aw-slot-0-body')).toHaveValue('draft X');
    await page.getByRole('button', { name: 'Close API Workbench and remove its hooks' }).click();
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(aw(page)).toHaveCount(0);
  });

  test('Stop all keeps the panel and moves focus to the screen heading', async ({ page }) => {
    await launch(page);
    const card = page.getByRole('region', { name: 'Mock Server' });
    await card.getByRole('button', { name: 'New Mock rule' }).click();
    await fill(page, { 'aw-path': '/api/mock-target', 'aw-body': OLD_MOCK_BODY });
    await saveRule(page);
    await card.getByRole('button', { name: 'Activate Mock module' }).click();
    await page.getByRole('button', { name: 'Stop all' }).click();
    await expect(card).toContainText('Inactive');
    await expect(page.getByRole('heading', { name: 'Home' })).toBeFocused();
    expect((await send(page, { url: '/api/mock-target' })).body.text).not.toContain('mocked');
  });
});
