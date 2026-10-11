// Shared UI drivers for the R4 rule modules. Old R0 field IDs are accepted as aliases.
import { expect, type Page } from '@playwright/test';

export type ModuleName = 'Mock' | 'Intercept' | 'Route' | 'Chaos';
export const OLD_MOCK_BODY = '{"mocked":true,"note":"✓ synthetic"}';

const ALIAS: Record<string, string> = {
  'aw-path': 'aw-r-path', 'aw-method': 'aw-r-method', 'aw-label': 'aw-r-label',
  'aw-status': 'aw-slot-0-status', 'aw-delay': 'aw-slot-0-delay', 'aw-body': 'aw-slot-0-body',
  'aw-dest': 'aw-route-dest', 'aw-rewrite': 'aw-route-rewrite',
  'aw-find': 'aw-response-find', 'aw-replace': 'aw-response-with',
};

export const panel = (page: Page) => page.locator('[data-api-workbench]');
export const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Modules' }).getByRole('button', { name, exact: true }).click();

export async function fill(page: Page, fields: Record<string, string | number | undefined>) {
  for (const [id, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (id === 'aw-ct') await page.getByLabel('reply header 1 value').fill(String(v));
    else await page.locator(`#${ALIAS[id] ?? id}`).fill(String(v));
  }
}
export async function select(page: Page, id: string, value: string) {
  await page.locator(`#${id}`).selectOption(value);
}
export const saveRule = (page: Page) => panel(page).locator('footer').getByRole('button', { name: 'Save', exact: true }).click();

export async function newRule(page: Page, module: ModuleName) {
  await tab(page, module);
  await page.getByRole('button', { name: 'New rule', exact: true }).click();
}

export async function activate(page: Page, module: ModuleName) {
  await tab(page, module);
  await page.getByRole('button', { name: `Activate ${module} module` }).click();
  await expect(page.getByRole('button', { name: `Deactivate ${module} module` })).toBeVisible();
}

export async function addMock(page: Page, o: { path?: string; method?: string; status?: number; delay?: number; ct?: string; body?: string; activate?: boolean } = {}) {
  await newRule(page, 'Mock');
  if (o.method) await select(page, 'aw-r-method', o.method);
  await fill(page, { 'aw-path': o.path ?? '/api/mock-target', 'aw-status': o.status, 'aw-delay': o.delay, 'aw-ct': o.ct, 'aw-body': o.body ?? OLD_MOCK_BODY });
  await saveRule(page);
  if (o.activate !== false) await activate(page, 'Mock');
}

export async function addRoute(page: Page, o: { origin: string; rewrite?: string; path?: string; activate?: boolean }) {
  await newRule(page, 'Route');
  await fill(page, { 'aw-path': o.path ?? '/api/mock-target', 'aw-dest': o.origin, 'aw-rewrite': o.rewrite });
  await saveRule(page);
  if (o.activate !== false) await activate(page, 'Route');
}

export async function addIntercept(page: Page, o: { find: string; replace?: string; path?: string; activate?: boolean }) {
  await newRule(page, 'Intercept');
  await fill(page, { 'aw-path': o.path ?? '/api/mock-target', 'aw-find': o.find, 'aw-replace': o.replace });
  await saveRule(page);
  if (o.activate !== false) await activate(page, 'Intercept');
}

/** Open the first rule of a module, change fields, save. */
export async function editFirst(page: Page, module: ModuleName, fields: Record<string, string | number>) {
  await tab(page, module);
  await page.getByRole('button', { name: /^Edit / }).first().click();
  await fill(page, fields);
  await saveRule(page);
}
