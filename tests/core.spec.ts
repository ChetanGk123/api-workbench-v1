// Pure core assertions (no browser). Counted in the same runner as browser cases.
import { expect, test } from '@playwright/test';
import { defaultConfig, planRequest, routedUrl, validateDelay, validateDestination, validateMockStatus, xhrTransformSkip, LIMITS, type Config } from '../src/net/plan';
import { createRuntime, readBounded } from '../src/net/runtime';

const ORIGIN = 'http://app.test';
const cfg = (patch: Partial<{ [K in keyof Config]: Partial<Config[K] & object> | Config[K] }> = {}): Config => {
  const d = defaultConfig();
  return {
    ...d,
    ...(patch.path !== undefined && { path: patch.path as string }),
    mock: { ...d.mock, ...(patch.mock as object) },
    route: { ...d.route, ...(patch.route as object) },
    transform: { ...d.transform, ...(patch.transform as object) },
  };
};
const req = (url: string, extra: Partial<{ transport: 'fetch' | 'xhr'; method: string; sync: boolean }> = {}) => ({
  transport: extra.transport ?? 'fetch',
  method: extra.method ?? 'GET',
  url: new URL(url, ORIGIN),
  sync: extra.sync ?? false,
});

test.describe('planner', () => {
  test('modules start inactive; nothing matches by default', () => {
    const p = planRequest(defaultConfig(), ORIGIN, req('/api/mock-target'));
    expect(p.matched).toBe(false);
    expect(p.ops).toEqual([]);
  });

  test('matches only the exact path on the launch origin', () => {
    const c = cfg({ mock: { active: true } });
    expect(planRequest(c, ORIGIN, req('/api/mock-target?x=1')).matched).toBe(true);
    expect(planRequest(c, ORIGIN, req('/api/mock-target/child')).matched).toBe(false);
    expect(planRequest(c, ORIGIN, req('http://other.test/api/mock-target')).matched).toBe(false);
  });

  test('mock wins and route is explicitly superseded', () => {
    const p = planRequest(cfg({ mock: { active: true }, route: { active: true, destination: 'http://b.test/r' } }), ORIGIN, req('/api/mock-target'));
    expect(p.provider).toBe('mock');
    expect(p.routeTo).toBeUndefined();
    expect(p.ops.map((o) => [o.module, o.state])).toEqual([['mock', 'selected'], ['route', 'superseded']]);
  });

  test('route preserves original query and drops Authorization only across origins', () => {
    const cross = planRequest(cfg({ route: { active: true, destination: 'http://b.test/routed' } }), ORIGIN, req('/api/mock-target?a=1&a=2&b=%20'));
    expect(cross.routeTo!.href).toBe('http://b.test/routed?a=1&a=2&b=%20');
    expect(cross.dropAuthorization).toBe(true);
    const same = planRequest(cfg({ route: { active: true, destination: `${ORIGIN}/api/r0-routed` } }), ORIGIN, req('/api/mock-target'));
    expect(same.dropAuthorization).toBe(false);
  });

  test('invalid destination skips route with reason, never silently', () => {
    const p = planRequest(cfg({ route: { active: true, destination: '' } }), ORIGIN, req('/api/mock-target'));
    expect(p.ops).toEqual([{ module: 'route', state: 'skipped', reason: expect.stringContaining('not a valid URL') }]);
  });

  test('sync XHR is skipped for every module', () => {
    const p = planRequest(cfg({ mock: { active: true }, route: { active: true, destination: 'http://b.test/r' }, transform: { active: true, find: 'a' } }), ORIGIN, req('/api/mock-target', { transport: 'xhr', sync: true }));
    expect(p.provider).toBe('network');
    expect(p.ops.every((o) => o.state === 'skipped')).toBe(true);
  });

  test('binary transform skip does not discard eligible route', () => {
    const p = planRequest(cfg({ route: { active: true, destination: 'http://b.test/r' }, transform: { active: true, find: 'x' } }), ORIGIN, req('/api/mock-target', { transport: 'xhr' }));
    expect(p.routeTo).toBeDefined();
    expect(xhrTransformSkip('arraybuffer')).toContain('cannot be edited as text');
  });

  test('plans are frozen snapshots of the revision at intake', () => {
    const c = cfg({ mock: { active: true } });
    const p = planRequest(c, ORIGIN, req('/api/mock-target'));
    expect(Object.isFrozen(p) && Object.isFrozen(p.ops) && Object.isFrozen(p.mock)).toBe(true);
    expect(p.revision).toBe(c.revision);
  });
});

test.describe('validators', () => {
  test('destination', () => {
    expect(validateDestination('http://b.test/x')).toEqual({ ok: true, href: 'http://b.test/x' });
    for (const bad of ['b.test/x', 'ftp://b.test/x', 'http://u:p@b.test/x', 'http://b.test/x?q=1', 'http://b.test/x#h']) expect(validateDestination(bad).ok).toBe(false);
  });
  test('status and delay bounds', () => {
    expect(validateMockStatus(200)).toBeNull();
    expect(validateMockStatus(599)).toBeNull();
    for (const s of [199, 600, 2.5, NaN]) expect(validateMockStatus(s)).not.toBeNull();
    expect(validateDelay(0)).toBeNull();
    expect(validateDelay(LIMITS.delayMaxMs)).toBeNull();
    for (const d of [-1, LIMITS.delayMaxMs + 1, 1.5, NaN]) expect(validateDelay(d)).not.toBeNull();
  });
  test('routedUrl replaces path and keeps repeated query', () => {
    expect(routedUrl('http://b.test/new', new URL('http://a.test/old?x=1&x=2')).href).toBe('http://b.test/new?x=1&x=2');
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
    rt.setConfig({ ...before, path: '/y' });
    expect(rt.config().revision).toBe(before.revision + 1);
    expect(Object.isFrozen(rt.config())).toBe(true);
    expect(before.path).toBe('/api/mock-target');
  });

  test('selected ops left at finish become skipped with a reason', () => {
    const rt = createRuntime(ORIGIN, defaultConfig());
    rt.setConfig({ ...rt.config(), mock: { ...rt.config().mock, active: true } });
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
