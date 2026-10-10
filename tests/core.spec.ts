// Pure core assertions (no browser). Counted in the same runner as browser cases.
import { expect, test } from '@playwright/test';
import {
  defaultConfig, newInterceptRule, newMockRule, newRouteRule, planRequest, routedUrl, validateInterceptRule, validateMockRule,
  validateOrigin, validateRouteRule, xhrTransformSkip, LIMITS, type Config,
} from '../src/net/plan';
import { createRuntime, readBounded } from '../src/net/runtime';
import { clampPos, parseGeometry } from '../src/ui/geometry';

const ORIGIN = 'http://app.test';
type Opts = { mock?: object | false; route?: object | false; intercept?: object | false; inactive?: boolean };
/** Config with the given modules active, each holding one enabled rule (patched). */
const cfg = (o: Opts): Config => {
  const d = defaultConfig();
  const mod = <R,>(patch: object | false | undefined, make: () => R) =>
    patch === undefined || patch === false ? { active: false, rule: null } : { active: !o.inactive, rule: { ...make(), ...patch } };
  return { ...d, mock: mod(o.mock, newMockRule), route: mod(o.route, newRouteRule), intercept: mod(o.intercept, newInterceptRule) };
};
const dest = { destinationOrigin: 'http://b.test', pathRewrite: '/routed' };
const req = (url: string, extra: Partial<{ transport: 'fetch' | 'xhr'; method: string; sync: boolean }> = {}) => ({
  transport: extra.transport ?? 'fetch',
  method: extra.method ?? 'GET',
  url: new URL(url, ORIGIN),
  sync: extra.sync ?? false,
});

test.describe('planner', () => {
  test('modules start inactive with no rules; nothing matches', () => {
    const p = planRequest(defaultConfig(), ORIGIN, req('/api/mock-target'));
    expect(p.matched).toBe(false);
    expect(p.ops).toEqual([]);
  });

  test('rule enabled is not module activation, and vice versa', () => {
    expect(planRequest(cfg({ mock: {}, inactive: true }), ORIGIN, req('/api/mock-target')).matched).toBe(false);
    expect(planRequest(cfg({ mock: { enabled: false } }), ORIGIN, req('/api/mock-target')).matched).toBe(false);
    expect(planRequest(cfg({ mock: {} }), ORIGIN, req('/api/mock-target')).matched).toBe(true);
  });

  test('matches exact path on the launch origin and the rule method', () => {
    const c = cfg({ mock: { method: 'POST' } });
    expect(planRequest(c, ORIGIN, req('/api/mock-target?x=1', { method: 'POST' })).matched).toBe(true);
    expect(planRequest(c, ORIGIN, req('/api/mock-target', { method: 'GET' })).matched).toBe(false);
    expect(planRequest(c, ORIGIN, req('/api/mock-target/child', { method: 'POST' })).matched).toBe(false);
    expect(planRequest(c, ORIGIN, req('http://other.test/api/mock-target', { method: 'POST' })).matched).toBe(false);
    expect(planRequest(cfg({ mock: { method: '*' } }), ORIGIN, req('/api/mock-target', { method: 'DELETE' })).matched).toBe(true);
  });

  test('mock wins and route is explicitly superseded', () => {
    const p = planRequest(cfg({ mock: {}, route: dest }), ORIGIN, req('/api/mock-target'));
    expect(p.provider).toBe('mock');
    expect(p.routeTo).toBeUndefined();
    expect(p.ops.map((o) => [o.module, o.state])).toEqual([['mock', 'selected'], ['route', 'superseded']]);
  });

  test('route: destination origin + rewrite, original query kept, Authorization dropped only across origins', () => {
    const cross = planRequest(cfg({ route: dest }), ORIGIN, req('/api/mock-target?a=1&a=2&b=%20'));
    expect(cross.routeTo!.href).toBe('http://b.test/routed?a=1&a=2&b=%20');
    expect(cross.dropAuthorization).toBe(true);
    const keepPath = planRequest(cfg({ route: { destinationOrigin: ORIGIN, pathRewrite: '' } }), ORIGIN, req('/api/mock-target?z=1'));
    expect(keepPath.routeTo!.href).toBe(`${ORIGIN}/api/mock-target?z=1`);
    expect(keepPath.dropAuthorization).toBe(false);
  });

  test('sync XHR is skipped for every module', () => {
    const p = planRequest(cfg({ mock: {}, route: dest, intercept: { find: 'a' } }), ORIGIN, req('/api/mock-target', { transport: 'xhr', sync: true }));
    expect(p.provider).toBe('network');
    expect(p.ops.length).toBe(3);
    expect(p.ops.every((o) => o.state === 'skipped')).toBe(true);
  });

  test('binary transform skip does not discard eligible route', () => {
    const p = planRequest(cfg({ route: dest, intercept: { find: 'x' } }), ORIGIN, req('/api/mock-target', { transport: 'xhr' }));
    expect(p.routeTo).toBeDefined();
    expect(p.transform).toEqual({ find: 'x', replace: '' });
    expect(xhrTransformSkip('arraybuffer')).toContain('cannot be edited as text');
  });

  test('plans are frozen snapshots of the revision at intake', () => {
    const c = cfg({ mock: {} });
    const p = planRequest(c, ORIGIN, req('/api/mock-target'));
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
  test('mock rule bounds', () => {
    expect(validateMockRule(newMockRule())).toEqual({});
    for (const status of [199, 600, 2.5, NaN]) expect(validateMockRule({ ...newMockRule(), status }).status).toBeTruthy();
    for (const delayMs of [-1, LIMITS.delayMaxMs + 1, 1.5, NaN]) expect(validateMockRule({ ...newMockRule(), delayMs }).delayMs).toBeTruthy();
    expect(validateMockRule({ ...newMockRule(), path: 'api' }).path).toBeTruthy();
    expect(validateMockRule({ ...newMockRule(), path: '/a?b=1' }).path).toBeTruthy();
    expect(validateMockRule({ ...newMockRule(), method: 'BREW' }).method).toBeTruthy();
    expect(validateMockRule({ ...newMockRule(), contentType: 'a\r\nb' }).contentType).toBeTruthy();
  });
  test('route and intercept rules', () => {
    expect(validateRouteRule({ ...newRouteRule(), ...dest })).toEqual({});
    expect(validateRouteRule(newRouteRule()).destinationOrigin).toBeTruthy();
    expect(validateRouteRule({ ...newRouteRule(), ...dest, pathRewrite: 'x' }).pathRewrite).toBeTruthy();
    expect(validateInterceptRule(newInterceptRule()).find).toBeTruthy();
    expect(validateInterceptRule({ ...newInterceptRule(), find: 'a' })).toEqual({});
  });
  test('routedUrl replaces path and keeps repeated query', () => {
    expect(routedUrl(dest, new URL('http://a.test/old?x=1&x=2')).href).toBe('http://b.test/routed?x=1&x=2');
  });
});

test.describe('runtime', () => {
  test('records are capped and late finish on evicted record is harmless', () => {
    const rt = createRuntime(ORIGIN, defaultConfig());
    const p = planRequest(rt.config(), ORIGIN, req('/x'));
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
    rt.setConfig({ ...before, mock: { active: true, rule: newMockRule() } });
    expect(rt.config().revision).toBe(before.revision + 1);
    expect(Object.isFrozen(rt.config())).toBe(true);
    expect(before.mock.active).toBe(false);
  });

  test('selected ops left at finish become skipped with a reason', () => {
    const rt = createRuntime(ORIGIN, defaultConfig());
    rt.setConfig({ ...rt.config(), mock: { active: true, rule: newMockRule() } });
    const p = planRequest(rt.config(), ORIGIN, req('/api/mock-target'));
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
    const c = cfg({ route: { ...dest, label: 'Accounts to B' }, mock: { method: 'POST' } });
    const p = planRequest(c, ORIGIN, req('/api/mock-target'));
    expect(p.ops.map((o) => o.rule)).toEqual(['Accounts to B']);
    const rt = createRuntime(ORIGIN, c);
    const rec = rt.start('fetch', 'GET', new URL('/api/mock-target', ORIGIN), p);
    expect(rec.ops[0]!.at).toBeUndefined();
    rt.op(rec, 'route', 'applied', 'Sent');
    expect(rec.ops[0]!.at).toBeGreaterThanOrEqual(0);
    const unnamed = planRequest(cfg({ mock: { method: 'GET' } }), ORIGIN, req('/api/mock-target'));
    expect(unnamed.ops[0]!.rule).toBe('GET /api/mock-target');
  });
});
