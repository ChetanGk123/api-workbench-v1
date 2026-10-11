// R5 pure assertions: breakpoint planning, the pause registry's single decision, cap, caller
// cancel, Close/Stop release, edit validation and the schema flags. No browser.
import { expect, test } from '@playwright/test';
import { defaultProfile, newRule, validateRuleIn, type InterceptRule, type Rule } from '../src/data/schema';
import { LIMITS, planRequest, type Config, type Intake } from '../src/net/plan';
import { checkEdit, createRuntime, type PauseView } from '../src/net/runtime';

const ORIGIN = 'http://app.test';
const base = defaultProfile();
const brk = (o: Partial<InterceptRule> = {}): InterceptRule => ({ ...newRule(base, 'intercept'), matcher: { method: '*', origin: '', path: '/api/x', query: [], headers: [], bodyContains: '' }, breakRequest: true, breakResponse: true, ...o });
const cfg = (rules: Rule[]): Config => ({ revision: 1, rules, active: { mock: true, intercept: true, route: true, chaos: true } });
const req: Intake = { transport: 'fetch', method: 'POST', url: new URL('/api/x', ORIGIN), headers: [], body: { text: '{}' }, sync: false };
const view = (): PauseView => ({ url: `${ORIGIN}/api/x`, headers: [['x-a', '1']], body: { text: '{}' } });

function setup(rule = brk()) {
  const rt = createRuntime(ORIGIN, cfg([rule]));
  const plan = planRequest(rt.config(), rt.states, ORIGIN, req);
  return { rt, rule, rec: () => rt.start('fetch', 'POST', req.url, plan) };
}

test.describe('breakpoint planning (G11)', () => {
  test('real traffic selects both pauses; mock and synthetic chaos supersede them with a reason', () => {
    const p = planRequest(cfg([brk()]), new Map(), ORIGIN, req);
    expect(p.intercept).toMatchObject({ breakRequest: true, breakResponse: true, request: false, response: false });
    expect(p.ops.map((o) => `${o.part}:${o.state}`)).toEqual(['request-pause:selected', 'response-pause:selected']);

    const mock = { ...newRule(base, 'mock'), matcher: brk().matcher };
    const m = planRequest(cfg([brk(), mock]), new Map(), ORIGIN, req);
    expect(m.intercept).toBeUndefined();
    expect(m.ops.filter((o) => o.module === 'intercept').map((o) => [o.state, o.reason])).toEqual([
      ['superseded', 'Mock reply: no request is sent, so nothing is paused'],
      ['superseded', 'Mock reply: no server response to pause'],
    ]);
    const chaos = { ...newRule(base, 'chaos'), matcher: brk().matcher };
    expect(planRequest(cfg([brk(), chaos]), new Map(), ORIGIN, req).ops.filter((o) => o.module === 'intercept').every((o) => o.state === 'superseded')).toBe(true);
  });

  test('synchronous XHR is never paused', () => {
    const p = planRequest(cfg([brk()]), new Map(), ORIGIN, { ...req, transport: 'xhr', sync: true });
    expect(p.intercept).toBeUndefined();
    expect(p.ops[0]).toMatchObject({ state: 'skipped', reason: 'Synchronous XHR is passed through unchanged' });
  });
});

test.describe('pause registry (G11/G03)', () => {
  test('first decision wins; a second click or stale control is refused with the outcome', async () => {
    const { rt, rule, rec } = setup();
    const r = rec();
    const held = rt.pause(r, 'request', rule, view());
    const [p] = rt.pauses();
    expect(p).toMatchObject({ state: 'waiting', stage: 'request', ruleId: rule.id });
    expect(p!.deadline - p!.createdAt).toBe(LIMITS.pauseDeadlineMs);
    const edit = { ...view(), url: `${ORIGIN}/api/y` };
    expect(rt.decide(p!.id, { kind: 'continue', edit })).toBeNull();
    expect(rt.decide(p!.id, { kind: 'abort' })).toBe(`Pause #${p!.id} already ended: continued with edits: URL`);
    expect(await held).toEqual({ kind: 'continue', edit });
    expect(r.ops.find((o) => o.part === 'request-pause')).toMatchObject({ state: 'applied' });
    expect(r.ops.find((o) => o.part === 'request-pause')!.reason).toMatch(/^Paused \d+\.\d s; continued with edits: URL$/);
  });

  test('the held snapshot is a frozen copy: later edits to the source never change it', () => {
    const { rt, rule, rec } = setup();
    const v = view();
    void rt.pause(rec(), 'request', rule, v);
    v.headers.push(['x-late', '1']);
    expect(rt.pauses()[0]!.held.headers).toEqual([['x-a', '1']]);
    expect(Object.isFrozen(rt.pauses()[0]!.held)).toBe(true);
    rt.settleAll();
  });

  test('an invalid edit keeps the pause waiting; nothing is decided', () => {
    const { rt, rule, rec } = setup();
    void rt.pause(rec(), 'request', rule, view());
    const id = rt.pauses()[0]!.id;
    expect(rt.decide(id, { kind: 'continue', edit: { ...view(), url: 'ftp://x' } })).toBe('URL: only http and https can be sent');
    expect(rt.decide(id, { kind: 'continue', edit: { ...view(), headers: [['Cookie', 'a']] } })).toBe('Header Cookie: the browser does not let scripts set it');
    expect(rt.pauses()[0]!.state).toBe('waiting');
    rt.settleAll();
  });

  test('caller abort wins: the pause rejects with the caller reason and later controls are refused', async () => {
    const { rt, rule, rec } = setup();
    const ctl = new AbortController();
    const held = rt.pause(rec(), 'request', rule, view(), ctl.signal);
    const id = rt.pauses()[0]!.id;
    ctl.abort(new DOMException('gone', 'AbortError'));
    await expect(held).rejects.toMatchObject({ name: 'AbortError', message: 'gone' });
    expect(rt.pauses()[0]).toMatchObject({ state: 'cancelled', outcome: 'the caller aborted; nothing was sent' });
    expect(rt.decide(id, { kind: 'original' })).toContain('already ended');
  });

  test('an already-aborted caller is never paused', async () => {
    const { rt, rule, rec } = setup();
    const ctl = new AbortController();
    ctl.abort();
    await expect(rt.pause(rec(), 'request', rule, view(), ctl.signal)).rejects.toBeTruthy();
    expect(rt.pauses()).toEqual([]);
  });

  test(`cap: the ${LIMITS.pauses + 1}st request is not paused and says why; release continues each once`, async () => {
    const { rt, rule, rec } = setup();
    const held = Array.from({ length: LIMITS.pauses }, () => rt.pause(rec(), 'response', rule, { status: 200, headers: [], body: { text: '' } }));
    const over = rec();
    expect(await rt.pause(over, 'response', rule, { status: 200, headers: [], body: { text: '' } })).toEqual({ kind: 'original' });
    expect(over.ops.find((o) => o.part === 'response-pause')).toMatchObject({ state: 'skipped', reason: `${LIMITS.pauses} requests are already paused (cap); not paused` });
    expect(rt.releasePauses('Stop all')).toBe(LIMITS.pauses);
    expect(rt.releasePauses('Stop all')).toBe(0);
    for (const d of await Promise.all(held)) expect(d).toEqual({ kind: 'original' });
    expect(rt.pauses().every((p) => p.state === 'released' && p.outcome === 'Stop all; original response delivered')).toBe(true);
  });

  test('Close (settleAll) continues the original; a closed runtime does not pause', async () => {
    const { rt, rule, rec } = setup();
    const held = rt.pause(rec(), 'request', rule, view());
    rt.settleAll();
    expect(await held).toEqual({ kind: 'original' });
    expect(rt.pauses()[0]!.outcome).toBe('Workbench closed; original request sent');
    rt.inert = true;
    expect(await rt.pause(rec(), 'request', rule, view())).toEqual({ kind: 'original' });
  });

  test('a locked pause turns Continue into Continue original', async () => {
    const { rt, rule, rec } = setup();
    const held = rt.pause(rec(), 'response', rule, { status: 0, headers: [], body: { reason: 'opaque' }, locked: 'Opaque response' });
    expect(rt.decide(rt.pauses()[0]!.id, { kind: 'continue', edit: { status: 500, headers: [], body: { text: 'x' } } })).toBeNull();
    expect(await held).toEqual({ kind: 'original' });
  });

  test('response edit checks', () => {
    expect(checkEdit('response', { status: 99, headers: [], body: { text: '' } })).toBe('Status: enter a whole number from 200 to 599');
    expect(checkEdit('response', { status: 200, headers: [['Set-Cookie', 'a=1']], body: { text: '' } })).toBe('Set-Cookie cannot be set by a script reply');
    expect(checkEdit('response', { status: 200, headers: [['x', 'a\nb']], body: { text: '' } })).toBe('Header x: values cannot contain line breaks');
    expect(checkEdit('response', { status: 418, headers: [['X-Ok', '1']], body: { text: 'é' } })).toBeNull();
  });
});

test.describe('breakpoint flags (data)', () => {
  test('R4 data without flags loads as false; a breakpoint alone is a valid rule; nothing at all is not', () => {
    const agg = { ...base, rules: [] as Rule[] };
    const { breakRequest: _a, breakResponse: _b, ...r4 } = brk({ breakRequest: false, breakResponse: false, response: { setHeaders: [['X-A', '1']], removeHeaders: [], patch: [], replace: null, status: 0 } });
    expect(validateRuleIn(agg, r4 as unknown as Rule)).toEqual([]);
    expect(validateRuleIn(agg, brk({ breakResponse: false }))).toEqual([]);
    expect(validateRuleIn(agg, brk({ breakRequest: false, breakResponse: false }))).toEqual([{ path: 'response', message: 'Add at least one request or response change, or a breakpoint' }]);
    expect(validateRuleIn(agg, { ...brk(), breakRequest: 'yes' } as unknown as Rule)).toEqual([{ path: 'breakRequest', message: 'Expected true or false' }]);
  });
});
