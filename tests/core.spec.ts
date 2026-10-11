// Pure core assertions (no browser). Counted in the same runner as browser cases.
import { expect, test } from '@playwright/test';
import { defaultProfile, newRule, validateOrigin, type Rule, type RuleKind } from '../src/data/schema';
import { defaultConfig, planRequest, routedUrl, LIMITS, type Config, type Intake, type RuleStates } from '../src/net/plan';
import { createRuntime, readBounded } from '../src/net/runtime';
import { clampPos, parseGeometry } from '../src/ui/geometry';

const ORIGIN = 'http://app.test';
const agg = defaultProfile();
/** A rule of `kind` on /api/mock-target with patched fields. */
function rule<K extends RuleKind>(kind: K, patch: Record<string, unknown> = {}, matcher: Record<string, unknown> = {}): Extract<Rule, { kind: K }> {
  const r = newRule(agg, kind);
  r.matcher = { ...r.matcher, path: '/api/mock-target', ...matcher };
  return { ...r, ...(kind === 'route' && { destinationOrigin: 'http://b.test', pathRewrite: '/routed' }), ...(kind === 'intercept' && { response: { setHeaders: [], removeHeaders: [], patch: [], replace: { find: 'x', with: '', scope: 'all' }, status: 0 } }), ...patch } as Extract<Rule, { kind: K }>;
}
const cfg = (rules: Rule[], inactive = false): Config => ({
  revision: 1, rules,
  active: { mock: !inactive, intercept: !inactive, route: !inactive, chaos: !inactive },
});
const req = (url: string, extra: Partial<Intake> = {}): Intake => ({
  transport: 'fetch', method: 'GET', url: new URL(url, ORIGIN), headers: [], body: { text: '' }, sync: false, ...extra,
});
const plan = (c: Config, r: Intake, states: RuleStates = new Map()) => planRequest(c, states, ORIGIN, r, 0);

test.describe('planner', () => {
  test('modules start inactive with no rules; nothing matches', () => {
    const p = plan(defaultConfig(), req('/api/mock-target'));
    expect(p.matched).toBe(false);
    expect(p.ops).toEqual([]);
  });

  test('rule enabled is not module activation, and vice versa', () => {
    expect(plan(cfg([rule('mock')], true), req('/api/mock-target')).matched).toBe(false);
    expect(plan(cfg([rule('mock', { enabled: false })]), req('/api/mock-target')).matched).toBe(false);
    expect(plan(cfg([rule('mock')]), req('/api/mock-target')).matched).toBe(true);
  });

  test('matches exact path on the launch origin and the rule method', () => {
    const c = cfg([rule('mock', {}, { method: 'POST' })]);
    expect(plan(c, req('/api/mock-target?x=1', { method: 'POST' })).matched).toBe(true);
    expect(plan(c, req('/api/mock-target', { method: 'GET' })).matched).toBe(false);
    expect(plan(c, req('/api/mock-target/child', { method: 'POST' })).matched).toBe(false);
    expect(plan(c, req('http://other.test/api/mock-target', { method: 'POST' })).matched).toBe(false);
    expect(plan(cfg([rule('mock')]), req('/api/mock-target', { method: 'DELETE' })).matched).toBe(true);
  });

  test('mock wins and route is explicitly superseded', () => {
    const p = plan(cfg([rule('mock'), rule('route')]), req('/api/mock-target'));
    expect(p.provider).toBe('mock');
    expect(p.route).toBeUndefined();
    expect(p.ops.map((o) => [o.module, o.state])).toEqual([['mock', 'selected'], ['route', 'superseded']]);
  });

  test('route: destination origin + rewrite, original query kept, Authorization dropped only across origins', () => {
    const cross = plan(cfg([rule('route')]), req('/api/mock-target?a=1&a=2&b=%20'));
    expect(cross.route!.to.href).toBe('http://b.test/routed?a=1&a=2&b=%20');
    expect(cross.route!.dropAuthorization).toBe(true);
    const keepPath = plan(cfg([rule('route', { destinationOrigin: ORIGIN, pathRewrite: '' })]), req('/api/mock-target?z=1'));
    expect(keepPath.route!.to.href).toBe(`${ORIGIN}/api/mock-target?z=1`);
    expect(keepPath.route!.dropAuthorization).toBe(false);
    expect(plan(cfg([rule('route', { keepAuthorization: true })]), req('/api/mock-target')).route!.dropAuthorization).toBe(false);
  });

  test('sync XHR is skipped for every module', () => {
    const p = plan(cfg([rule('mock'), rule('route'), rule('intercept')]), req('/api/mock-target', { transport: 'xhr', sync: true }));
    expect(p.provider).toBe('network');
    expect(p.ops.length).toBe(3);
    expect(p.ops.every((o) => o.state === 'skipped')).toBe(true);
  });

  test('a response edit selected alongside a route keeps the route', () => {
    const p = plan(cfg([rule('route'), rule('intercept')]), req('/api/mock-target', { transport: 'xhr' }));
    expect(p.route).toBeDefined();
    expect(p.intercept).toMatchObject({ request: false, response: true });
  });

  test('plans are frozen snapshots of the revision at intake', () => {
    const c = cfg([rule('mock')]);
    const p = plan(c, req('/api/mock-target'));
    expect(Object.isFrozen(p) && Object.isFrozen(p.ops)).toBe(true);
    expect(p.revision).toBe(c.revision);
  });
});

test.describe('validators', () => {
  test('origin', () => {
    expect(validateOrigin('http://b.test:8080')).toEqual({ ok: true, origin: 'http://b.test:8080' });
    expect(validateOrigin('http://b.test/')).toEqual({ ok: true, origin: 'http://b.test' });
    for (const bad of ['b.test', 'ftp://b.test', 'http://u:p@b.test', 'http://b.test/x', 'http://b.test?q=1', 'http://b.test#h']) expect(validateOrigin(bad).ok).toBe(false);
  });
  test('routedUrl replaces path and keeps repeated query', () => {
    expect(routedUrl({ destinationOrigin: 'http://b.test', pathRewrite: '/routed', matcher: rule('route').matcher }, new URL('http://a.test/old?x=1&x=2')).href).toBe('http://b.test/routed?x=1&x=2');
  });
});

test.describe('runtime', () => {
  test('records are capped and late finish on evicted record is harmless', () => {
    const rt = createRuntime(ORIGIN, defaultConfig());
    const p = plan(rt.config(), req('/x'));
    const first = rt.start('fetch', 'GET', new URL('/x?secret=1', ORIGIN), p);
    for (let i = 0; i < LIMITS.records + 10; i++) rt.start('fetch', 'GET', new URL('/x', ORIGIN), p);
    expect(rt.records().length).toBe(LIMITS.records);
    expect(rt.records()).not.toContain(first);
    rt.finish(first, 'ok', 200);
    expect(rt.records().length).toBe(LIMITS.records);
    expect(first.url).toBe(`${ORIGIN}/x`); // query values never stored
  });

  test('config revisions increase and snapshots are frozen', () => {
    const rt = createRuntime(ORIGIN, defaultConfig());
    const before = rt.config();
    rt.setConfig({ rules: [rule('mock')], active: { ...before.active, mock: true } });
    expect(rt.config().revision).toBe(before.revision + 1);
    expect(Object.isFrozen(rt.config())).toBe(true);
    expect(before.active.mock).toBe(false);
  });

  test('selected ops left at finish become skipped with a reason', () => {
    const rt = createRuntime(ORIGIN, defaultConfig());
    rt.setConfig({ rules: [rule('mock')], active: { ...rt.config().active, mock: true } });
    const p = plan(rt.config(), req('/api/mock-target'));
    const r = rt.start('fetch', 'GET', new URL('/api/mock-target', ORIGIN), p);
    rt.finish(r, 'aborted');
    expect(r.ops[0]).toMatchObject({ state: 'skipped', reason: expect.stringContaining('aborted') });
  });

  test('wait: abort rejects with reason, settleAll resolves early, once', async () => {
    const rt = createRuntime(ORIGIN, defaultConfig());
    const ctl = new AbortController();
    const w1 = rt.wait(10_000, ctl.signal);
    ctl.abort(new Error('caller'));
    await expect(w1).rejects.toThrow('caller');
    const t0 = Date.now();
    const w2 = rt.wait(10_000);
    rt.settleAll();
    await w2;
    expect(Date.now() - t0).toBeLessThan(1000);
    await expect(rt.wait(1, AbortSignal.abort(new Error('pre')))).rejects.toThrow('pre');
  });

  test('body slots are capped at the concurrency limit', () => {
    const rt = createRuntime(ORIGIN, defaultConfig());
    const held = Array.from({ length: LIMITS.bodyConcurrency }, () => rt.acquireBodySlot());
    expect(held.every(Boolean)).toBe(true);
    expect(rt.acquireBodySlot()).toBeNull();
    held[0]!();
    held[0]!(); // double release is harmless
    expect(rt.activeBodySlots()).toBe(LIMITS.bodyConcurrency - 1);
  });

  const streamOf = (chunks: Uint8Array[], gapMs = 0) =>
    new ReadableStream<Uint8Array>({
      async pull(c) {
        const next = chunks.shift();
        if (!next) return c.close();
        if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
        c.enqueue(next);
      },
    });

  test('readBounded: complete, over-limit, deadline, close', async () => {
    const rt = createRuntime(ORIGIN, defaultConfig());
    const ok = await readBounded(streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]), 3, 1000, rt.own);
    expect(ok).toEqual({ ok: true, bytes: new Uint8Array([1, 2, 3]) });
    const big = await readBounded(streamOf([new Uint8Array(3), new Uint8Array(3)]), 4, 1000, rt.own);
    expect(big).toMatchObject({ ok: false, reason: expect.stringContaining('exceeds 4 bytes') });
    const slow = await readBounded(streamOf([new Uint8Array(1), new Uint8Array(1)], 300), 10, 100, rt.own);
    expect(slow).toMatchObject({ ok: false, reason: expect.stringContaining('within 100 ms') });
    const pending = readBounded(streamOf([new Uint8Array(1)], 2000), 10, 5000, rt.own);
    setTimeout(() => rt.settleAll(), 50);
    expect(await pending).toMatchObject({ ok: false, reason: 'Workbench closed' });
  });
});

test.describe('geometry (R1)', () => {
  test('parseGeometry keeps only finite, in-range values', () => {
    expect(parseGeometry(null)).toEqual({});
    expect(parseGeometry('not json')).toEqual({});
    expect(parseGeometry('{"panel":{"x":"10","y":5},"size":{"w":100,"h":900},"launcher":{"x":1e9,"y":0}}')).toEqual({});
    expect(parseGeometry('{"panel":{"x":10,"y":5},"size":{"w":500,"h":600},"launcher":{"x":-3,"y":7}}'))
      .toEqual({ panel: { x: 10, y: 5 }, size: { w: 500, h: 600 }, launcher: { x: -3, y: 7 } });
  });

  test('clampPos keeps the whole box on screen; top-left wins when it cannot fit', () => {
    expect(clampPos({ x: 5000, y: -40 }, 480, 600, 1280, 800)).toEqual({ x: 800, y: 0 });
    expect(clampPos({ x: 100, y: 100 }, 480, 600, 1280, 800)).toEqual({ x: 100, y: 100 });
    expect(clampPos({ x: 50, y: 50 }, 480, 600, 360, 400)).toEqual({ x: 0, y: 0 });
  });

  test('ops carry the rule identity and a timing offset once settled', () => {
    const c = cfg([rule('route', { label: 'Accounts to B' }), rule('mock', {}, { method: 'POST' })]);
    const p = plan(c, req('/api/mock-target'));
    expect(p.ops.map((o) => o.rule)).toEqual(['Accounts to B']);
    const rt = createRuntime(ORIGIN, c);
    const rec = rt.start('fetch', 'GET', new URL('/api/mock-target', ORIGIN), p);
    expect(rec.ops[0]!.at).toBeUndefined();
    rt.op(rec, 'route', 'applied', 'Sent');
    expect(rec.ops[0]!.at).toBeGreaterThanOrEqual(0);
    const unnamed = plan(cfg([rule('mock', {}, { method: 'GET' })]), req('/api/mock-target'));
    expect(unnamed.ops[0]!.rule).toBe('GET /api/mock-target');
  });
});
