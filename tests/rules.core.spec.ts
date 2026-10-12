// R4 pure assertions: matching, precedence, reservations, sampling, composition, JSON Patch,
// rule validation and schema 1 conversion. No browser.
import { expect, test } from '@playwright/test';
import {
  copyAggregate, defaultProfile, meaningfulRuleChange, newEndpoint, newRule, rulesFromV1, validateAggregate, validateRuleIn,
  type Aggregate, type Rule, type RuleKind,
} from '../src/data/schema';
import { applyPatch, replaceText, transformBody } from '../src/net/patch';
import { globMatch, planRequest, routedUrl, seeded, type Config, type Intake, type RuleStates } from '../src/net/plan';
import { createRuntime } from '../src/net/runtime';
import { compileRules } from '../src/ui/rules';
import { stripTrailingCommas } from '../src/ui/kit';

const ORIGIN = 'http://app.test';
const base = defaultProfile();
let seq = 0;
function rule<K extends RuleKind>(kind: K, patch: Record<string, unknown> = {}, matcher: Record<string, unknown> = {}): Extract<Rule, { kind: K }> {
  const r = newRule(base, kind);
  r.seq = ++seq;
  r.matcher = { ...r.matcher, path: '/api/x', ...matcher };
  const extra = kind === 'route' ? { destinationOrigin: 'http://b.test', pathRewrite: '' }
    : kind === 'intercept' ? { response: { setHeaders: [['X-A', '1']], removeHeaders: [], patch: [], replace: null, status: 0 } } : {};
  return { ...r, ...extra, ...patch } as Extract<Rule, { kind: K }>;
}
const cfg = (rules: Rule[]): Config => ({ revision: 1, rules, active: { mock: true, intercept: true, route: true, chaos: true } });
const req = (url: string, extra: Partial<Intake> = {}): Intake => ({ transport: 'fetch', method: 'GET', url: new URL(url, ORIGIN), headers: [], body: { text: '' }, sync: false, ...extra });
const states = (): RuleStates => new Map();

test.describe('matching (G08)', () => {
  test('globs: * stays in a segment, ** crosses; matching is on the original pathname', () => {
    expect(globMatch('/api/*/items', '/api/7/items')).toBe(true);
    expect(globMatch('/api/*/items', '/api/7/8/items')).toBe(false);
    expect(globMatch('/api/**', '/api/7/8/items')).toBe(true);
    expect(globMatch('/api/**', '/apix')).toBe(false);
    expect(globMatch('/a.b', '/aXb')).toBe(false); // regex characters are literal
  });

  test('query any-of, header names case-insensitive, conditions ANDed', () => {
    const c = cfg([rule('mock', {}, { query: [['tag', 'b'], ['page', '']], headers: [['X-Tenant', 'acme']] })]);
    const s = states();
    const hit = (url: string, headers: [string, string][]) => planRequest(c, s, ORIGIN, req(url, { headers })).matched;
    expect(hit('/api/x?tag=a&tag=b&page=2', [['x-tenant', 'acme']])).toBe(true);
    expect(hit('/api/x?tag=a&page=2', [['x-tenant', 'acme']])).toBe(false);
    expect(hit('/api/x?tag=b', [['x-tenant', 'acme']])).toBe(false);
    expect(hit('/api/x?tag=b&page=1', [['x-tenant', 'other']])).toBe(false);
  });

  test('an unavailable body is "not evaluated": no false match, and the next rule can win', () => {
    const top = rule('mock', { priority: 5, label: 'Body rule' }, { bodyContains: 'transfer' });
    const low = rule('mock', { label: 'Fallback' });
    const p = planRequest(cfg([low, top]), states(), ORIGIN, req('/api/x', { method: 'POST', body: { reason: 'a Blob body is not read for matching' } }));
    expect(p.mock!.rule.label).toBe('Fallback');
    expect(p.notes.join()).toContain('Body rule: body condition not evaluated: a Blob body is not read for matching');
    expect(planRequest(cfg([low, top]), states(), ORIGIN, req('/api/x', { body: { text: '{"type":"transfer"}' } })).mock!.rule.label).toBe('Body rule');
  });

  test('priority, then creation sequence, then ID; one winner per module', () => {
    const a = rule('mock', { label: 'A', seq: 2 }), b = rule('mock', { label: 'B', seq: 1 }), c = rule('mock', { label: 'C', priority: 1, seq: 9 });
    expect(planRequest(cfg([a, b]), states(), ORIGIN, req('/api/x')).mock!.rule.label).toBe('B');
    const p = planRequest(cfg([a, b, c]), states(), ORIGIN, req('/api/x'));
    expect(p.mock!.rule.label).toBe('C');
    expect(p.ops.filter((o) => o.module === 'mock')).toHaveLength(1);
  });

  test('relative matcher is scoped to the launch origin; explicit origin to that origin', () => {
    expect(planRequest(cfg([rule('mock')]), states(), ORIGIN, req('http://other.test/api/x')).matched).toBe(false);
    expect(planRequest(cfg([rule('mock', {}, { origin: 'http://other.test' })]), states(), ORIGIN, req('http://other.test/api/x')).matched).toBe(true);
  });

  test('route rewrite: exact path or trailing /** capture; query preserved', () => {
    const r = rule('route', { pathRewrite: '/v2/**' }, { path: '/api/**' });
    expect(routedUrl(r, new URL('http://app.test/api/a/b?x=1&x=2')).href).toBe('http://b.test/v2/a/b?x=1&x=2');
    expect(routedUrl({ ...r, pathRewrite: '/fixed' }, new URL('http://app.test/api/a?q')).href).toBe('http://b.test/fixed?q');
  });
});

test.describe('mock sequences (G09)', () => {
  const seqRule = (exhaustion: 'repeat-last' | 'loop' | 'network-error') => rule('mock', {
    mode: 'sequence', exhaustion,
    slots: [1, 2, 3].map((n) => ({ id: `s${n}`, status: 200 + n, headers: [], body: String(n), delayMs: 0, fault: 'none' })),
  });
  const run = (r: Rule, n: number) => { const s = states(); return Array.from({ length: n }, () => planRequest(cfg([r]), s, ORIGIN, req('/api/x')).mock!.slot?.status ?? 'error'); };

  test('slots are reserved in arrival order with explicit exhaustion; never real traffic', () => {
    expect(run(seqRule('repeat-last'), 5)).toEqual([201, 202, 203, 203, 203]);
    expect(run(seqRule('loop'), 5)).toEqual([201, 202, 203, 201, 202]);
    expect(run(seqRule('network-error'), 5)).toEqual([201, 202, 203, 'error', 'error']);
    const s = states(), r = seqRule('network-error');
    for (let i = 0; i < 4; i++) planRequest(cfg([r]), s, ORIGIN, req('/api/x'));
    const p = planRequest(cfg([r]), s, ORIGIN, req('/api/x'));
    expect(p.provider).toBe('mock'); // exhausted is still the mock provider, not network
    expect(p.ops[0]!.reason).toContain('exhausted');
  });

  test('cursor resets on an action revision or activation, not on a label edit', () => {
    const r = seqRule('repeat-last');
    const rt = createRuntime(ORIGIN, { revision: 1, rules: [], active: { mock: false, intercept: false, route: false, chaos: false } });
    const on = { mock: true, intercept: false, route: false, chaos: false };
    rt.setConfig({ rules: [r], active: on });
    const next = () => planRequest(rt.config(), rt.states, ORIGIN, req('/api/x')).mock!.slot!.status;
    expect([next(), next()]).toEqual([201, 202]);
    const relabelled = { ...r, label: 'renamed' };
    expect(meaningfulRuleChange(r, relabelled)).toBe(false);
    rt.setConfig({ rules: [relabelled], active: on });
    expect(next()).toBe(203);
    const edited = { ...r, revision: 2, slots: r.slots.slice(0, 2) };
    expect(meaningfulRuleChange(r, edited)).toBe(true);
    rt.setConfig({ rules: [edited], active: on });
    expect(next()).toBe(201);
    rt.setConfig({ rules: [edited], active: { ...on, mock: false } });
    rt.setConfig({ rules: [edited], active: on });
    expect(next()).toBe(201);
  });
});

test.describe('chaos sampling and composition (G13)', () => {
  test('probability 0 is sampled out and never falls through to a lower rule; 100 always applies', () => {
    const p = planRequest(cfg([rule('chaos', { probability: 0, priority: 5 }), rule('chaos', { label: 'low' })]), states(), ORIGIN, req('/api/x'));
    expect(p.chaos).toBeUndefined();
    expect(p.ops.map((o) => o.state)).toEqual(['sampled-out']);
    expect(planRequest(cfg([rule('chaos')]), states(), ORIGIN, req('/api/x')).provider).toBe('chaos');
  });

  test('a seed reproduces the same ordered samples; unseeded is independent', () => {
    const r = rule('chaos', { probability: 50, seed: 'demo' });
    const corpus = () => { const s = states(); return Array.from({ length: 20 }, () => planRequest(cfg([r]), s, ORIGIN, req('/api/x')).ops[0]!.state).join(); };
    expect(corpus()).toBe(corpus());
    expect(corpus()).toContain('sampled-out');
    expect(corpus()).toContain('selected');
    const g = seeded('demo');
    expect([g(), g()]).toEqual((() => { const h = seeded('demo'); return [h(), h()]; })());
  });

  test('hit budget and active duration end selection', () => {
    const s = states();
    const b = rule('chaos', { budget: 2 });
    const picks = Array.from({ length: 4 }, () => planRequest(cfg([b]), s, ORIGIN, req('/api/x')).provider);
    expect(picks).toEqual(['chaos', 'chaos', 'network', 'network']);
    const d = rule('chaos', { durationMs: 1000 });
    const s2 = states();
    expect(planRequest(cfg([d]), s2, ORIGIN, req('/api/x'), 0).provider).toBe('chaos');
    const late = planRequest(cfg([d]), s2, ORIGIN, req('/api/x'), 1500);
    expect(late.matched).toBe(false);
    expect(late.notes.join()).toContain('active period of 1000 ms ended');
  });

  test('synthetic chaos supersedes mock and route; real chaos is superseded by a mock', () => {
    const p = planRequest(cfg([rule('chaos'), rule('mock'), rule('route')]), states(), ORIGIN, req('/api/x'));
    expect(p.provider).toBe('chaos');
    expect(p.ops.map((o) => [o.module, o.state])).toEqual([['mock', 'superseded'], ['chaos', 'selected'], ['route', 'superseded']]);
    const real = rule('chaos', { mode: 'real', fault: { kind: 'latency', delayMs: 10 } });
    const q = planRequest(cfg([real, rule('mock')]), states(), ORIGIN, req('/api/x'));
    expect(q.provider).toBe('mock');
    expect(q.chaos).toBeUndefined();
    expect(q.ops.find((o) => o.module === 'chaos')!.state).toBe('superseded');
  });

  test('transport failures supersede response edits; request edits never run for synthetic replies', () => {
    const ic = rule('intercept', { request: { setHeaders: [['X-B', '1']], removeHeaders: [], patch: [], replace: null, status: 0 } });
    const p = planRequest(cfg([rule('chaos', { fault: { kind: 'network-error' } }), ic]), states(), ORIGIN, req('/api/x'));
    expect(p.intercept).toBeUndefined();
    expect(p.ops.filter((o) => o.module === 'intercept').map((o) => [o.part, o.state])).toEqual([['request', 'superseded'], ['response', 'superseded']]);
    const m = planRequest(cfg([rule('mock'), ic]), states(), ORIGIN, req('/api/x'));
    expect(m.intercept).toMatchObject({ request: false, response: true });
  });

  test('random latency stays within its range', () => {
    const r = rule('chaos', { mode: 'real', fault: { kind: 'random-latency', minMs: 100, maxMs: 120 }, seed: 's' });
    const s = states();
    for (let i = 0; i < 50; i++) {
      const d = planRequest(cfg([r]), s, ORIGIN, req('/api/x')).chaos!.delayMs;
      expect(d).toBeGreaterThanOrEqual(100);
      expect(d).toBeLessThanOrEqual(120);
    }
  });
});

test.describe('JSON Patch and literal replace (G10)', () => {
  const doc = { a: { b: [1, 2] }, c: 'x' };

  test('RFC 6902 operations on a copy', () => {
    const r = applyPatch(doc, [
      { op: 'add', path: '/a/b/-', value: 3 }, { op: 'replace', path: '/c', value: null }, { op: 'copy', from: '/a/b/0', path: '/d' },
      { op: 'move', from: '/d', path: '/e' }, { op: 'remove', path: '/a/b/0' }, { op: 'test', path: '/e', value: 1 },
    ]);
    expect(r).toEqual({ ok: true, value: { a: { b: [2, 3] }, c: null, e: 1 } });
    expect(doc).toEqual({ a: { b: [1, 2] }, c: 'x' }); // input untouched
  });

  test('one failing operation applies nothing; prototype paths are refused', () => {
    expect(applyPatch(doc, [{ op: 'replace', path: '/c', value: 'y' }, { op: 'test', path: '/c', value: 'z' }])).toMatchObject({ ok: false, index: 1 });
    expect(applyPatch(doc, [{ op: 'remove', path: '/missing' }])).toMatchObject({ ok: false, index: 0 });
    expect(applyPatch({}, [{ op: 'add', path: '/__proto__/polluted', value: 1 }])).toMatchObject({ ok: false, reason: expect.stringContaining('not allowed') });
    expect(applyPatch({}, [{ op: 'add', path: '/constructor', value: 1 }]).ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const own = JSON.parse('{"__proto__": {"x": 1}}');
    expect(applyPatch(own, [{ op: 'replace', path: '/__proto__/x', value: 2 }]).ok).toBe(false);
  });

  test('body transform: invalid JSON or a failed patch leaves the text unchanged with a reason', () => {
    expect(transformBody('not json', { patch: [{ op: 'remove', path: '/a' }], replace: null })).toEqual({ ok: false, reason: 'Body is not valid JSON; JSON Patch not applied' });
    expect(transformBody('{"a":1}', { patch: [{ op: 'remove', path: '/b' }], replace: null })).toMatchObject({ ok: false, reason: expect.stringContaining('no operation applied') });
    expect(transformBody('{"a":1}', { patch: [{ op: 'replace', path: '/a', value: 2 }], replace: { find: '2', with: '3', scope: 'all' } })).toMatchObject({ ok: true, text: '{"a":3}' });
  });

  test('literal replace: first/all, no regular expressions', () => {
    expect(replaceText('a.a.a', '.', '-', 'first')).toEqual({ text: 'a-a.a', count: 1 });
    expect(replaceText('a.a.a', '.', '$&', 'all')).toEqual({ text: 'a$&a$&a', count: 2 });
    expect(replaceText('abc', 'x', 'y', 'all')).toEqual({ text: 'abc', count: 0 });
  });
});

test.describe('rule validation and persistence (G08/G21)', () => {
  const paths = (agg: Aggregate, r: Rule) => validateRuleIn(agg, r).map((d) => `${d.path}: ${d.message}`);

  test('incompatible and impossible configurations are refused', () => {
    const agg = defaultProfile();
    expect(paths(agg, rule('chaos', { fault: { kind: 'latency', delayMs: 10 } })).join()).toContain('Synthetic latency has no reply to delay');
    expect(paths(agg, rule('chaos', { fault: { kind: 'replay', copies: 3, gapMs: 0 }, mode: 'real' })).join()).toContain('fault.copies');
    expect(paths(agg, rule('chaos', { fault: { kind: 'random-latency', minMs: 50, maxMs: 10 }, mode: 'real' })).join()).toContain('Maximum must be at least the minimum');
    expect(paths(agg, rule('chaos', { preDelayMs: 10 })).join()).toContain('real traffic only');
    expect(paths(agg, rule('mock', { slots: [{ id: 's', status: 204, headers: [], body: 'x', delayMs: 0, fault: 'none' }] })).join()).toContain('A 204 reply has no body');
    expect(paths(agg, rule('mock', { slots: [{ id: 's', status: 200, headers: [['Set-Cookie', 'a=b']], body: '', delayMs: 0, fault: 'none' }] })).join()).toContain('cookie jar is unchanged');
    expect(paths(agg, rule('mock', { mode: 'static', slots: [] })).join()).toContain('Add a reply');
    expect(paths(agg, rule('route', { pathRewrite: '/v2/**' })).join()).toContain('needs a matcher path that also ends in /**');
    expect(paths(agg, rule('route', { pathRewrite: '/a/*/b' })).join()).toContain('exact path or one trailing /** capture');
    expect(paths(agg, rule('intercept', { response: { setHeaders: [], removeHeaders: [], patch: [], replace: null, status: 0 } })).join()).toContain('Add at least one');
    expect(paths(agg, rule('intercept', { request: { setHeaders: [['Cookie', 'x']], removeHeaders: [], patch: [], replace: null, status: 0 } })).join()).toContain('does not let scripts set Cookie');
    expect(paths(agg, rule('intercept', { response: { setHeaders: [], removeHeaders: [], patch: [{ op: 'add', path: '/a/__proto__', value: 1 }], replace: null, status: 0 } })).join()).toContain('not allowed');
    expect(paths(agg, rule('mock', {}, { path: '' })).join()).toContain('matcher.path: Required');
    expect(paths(agg, rule('mock', { endpointId: 'ep-missing' })).join()).toContain('Linked endpoint is missing');
    expect(paths(agg, rule('mock'))).toEqual([]);
  });

  test('linked rules follow the endpoint by ID; copies remap links', () => {
    const agg = defaultProfile();
    const e = newEndpoint(agg);
    e.request.url = '/api/users/{{id}}/cards';
    e.request.method = 'POST';
    agg.endpoints.push(e);
    agg.rules.push(rule('mock', { endpointId: e.id }, { path: '/old' }));
    expect(compileRules(agg)[0]!.matcher).toMatchObject({ method: 'POST', path: '/api/users/*/cards', origin: '' });
    e.name = 'Renamed';
    expect(compileRules(agg)[0]!.matcher.path).toBe('/api/users/*/cards');
    const copy = copyAggregate(validateAggregate(agg).ok ? agg : (() => { throw new Error('invalid'); })(), 'Copy');
    expect(copy.rules[0]!.endpointId).toBe(copy.endpoints[0]!.id);
    expect(copy.rules[0]!.id).not.toBe(agg.rules[0]!.id);
    expect(validateAggregate(copy).ok).toBe(true);
  });

  test('schema 1 rules convert; what cannot convert is kept as data with a note', () => {
    const v1 = [
      { id: 'r1', kind: 'mock', label: 'Accounts', enabled: true, priority: 0, seq: 1, matcher: { method: 'GET', url: '/api/accounts', query: 'a=1', headers: '', bodyContains: '' }, mode: 'sequence', exhaustion: 'loop', slots: [{ status: 200, headers: 'Content-Type: application/json', body: '{}', delayMs: 0, fault: 'none' }, { status: 503, headers: '', body: '', delayMs: 10, fault: 'none' }] },
      { id: 'r2', kind: 'route', label: 'Local', enabled: true, priority: 0, seq: 2, matcher: { method: '*', url: 'https://api.bank.test/wires/**', query: '', headers: 'X-Env=dev', bodyContains: '' }, matchOrigin: '', destinationOrigin: 'http://localhost:8080', pathRewrite: '/v2/**', preservePath: true, credentials: 'include', keepAuthorization: false },
      { id: 'r3', kind: 'chaos', label: 'Slow', enabled: false, priority: 0, seq: 3, matcher: { method: 'GET', url: '/api/**', query: '', headers: '', bodyContains: '' }, mode: 'real', fault: { kind: 'latency', delayMs: 500 }, probability: 50, seed: 'x', budget: 0, preDelayMs: 0 },
      { id: 'r4', kind: 'chaos', label: 'Bad', enabled: true, priority: 0, seq: 4, matcher: { method: 'GET', url: '/a', query: '', headers: '', bodyContains: '' }, mode: 'synthetic', fault: { kind: 'latency', delayMs: 500 }, probability: 50, seed: '', budget: 0, preDelayMs: 0 },
      { id: 'r5', kind: 'teleport' },
    ];
    const out = rulesFromV1(v1, new Set());
    expect(out.rules.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(out.rules[0]).toMatchObject({ kind: 'mock', mode: 'sequence', exhaustion: 'loop', matcher: { query: [['a', '1']], origin: '' } });
    expect(out.rules[1]).toMatchObject({ kind: 'route', credentials: 'include', matcher: { origin: 'https://api.bank.test', path: '/wires/**', headers: [['X-Env', 'dev']] } });
    expect(out.rest).toHaveLength(2);
    expect(out.notes.join('\n')).toMatch(/Bad was not converted.*Synthetic latency/);
    expect(out.notes.join('\n')).toContain('now match the page’s own origin only');
    // A schema 2 aggregate stored before R4 converts on load.
    const stored = { ...defaultProfile(), legacyRules: v1 } as Record<string, unknown>;
    delete stored.rules;
    const r = validateAggregate(stored);
    expect(r.ok && r.value.rules.length).toBe(3);
    expect(r.ok && r.value.legacyRules.length).toBe(2);
  });
});

test.describe('Format JSON repair (trailing commas only)', () => {
  test('removes commas before ] or } outside strings, nothing else', () => {
    expect(stripTrailingCommas('{"a":[1,2,],}')).toBe('{"a":[1,2]}');
    expect(stripTrailingCommas('{\n  "data": [\n    {"id": 1},\n  ],\n  "ok": true\n}')).toBe('{\n  "data": [\n    {"id": 1}\n  ],\n  "ok": true\n}');
    expect(stripTrailingCommas('{"t":"a,]b,}","q":"x\\",]"}')).toBe('{"t":"a,]b,}","q":"x\\",]"}'); // inside strings, incl. an escaped quote
    expect(stripTrailingCommas('[1,,2]')).toBe('[1,,2]'); // other errors are left for the parser to report
    expect(JSON.parse(stripTrailingCommas('{"data":[{"m":1},{"m":2},],"icon":"success",}'))).toEqual({ data: [{ m: 1 }, { m: 2 }], icon: 'success' });
  });
});
