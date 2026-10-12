// R6 pure assertions: expression grammar and limits, reservations, exact decimals, auth contexts,
// signing vectors, preflight graph rules and the scheduler (Flow/Independent/setup/Stop/poll/guard/
// idempotency/refresh) against an in-process fake server. No browser.
import { expect, test } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { defaultProfile, newEndpoint, validateAggregate, type Aggregate, type Endpoint, type Plan, type SigningRecipe, type Step } from '../src/data/schema';
import { createAuth } from '../src/tester/auth';
import { compareDecimal, decimalText, Num, parseExact, parseExpr, render, stringifyExact, type Env } from '../src/tester/expr';
import { preflight } from '../src/tester/graph';
import { prepare, type Sources, type Transport } from '../src/tester/once';
import { checkCondition, startRun } from '../src/tester/run';
import { canonical, importKey, signPrepared } from '../src/tester/sign';
import { csvCell, emptyStat, p95, p99, record, toCsv } from '../src/tester/stats';

const PAGE = 'http://page.test';
const none: Sources = { cookie: () => undefined, localStorage: () => undefined, sessionStorage: () => undefined, meta: () => undefined };

function env(o: Partial<Env> = {}): Env {
  let u = 0;
  return { sources: none, bindings: [], aliases: new Set(['acct', 'quote']), reserved: new Map(), counters: new Map(), now: () => 1_700_000_000_000, uuid: () => `uuid-${++u}`, random: () => 0.5, ...o };
}
const run1 = (text: string, site: 'url' | 'text' | 'header' | 'json', e = env()) => {
  const blocked: string[] = [];
  const out = render(text, site, 'F', e, blocked, { hit: false }, { n: 0 });
  return { out, blocked };
};

function profile(): Aggregate {
  const a = defaultProfile('Bank');
  a.profile.environments = { dev: { api: 'https://api.bank.test', other: 'https://other.bank.test' } };
  a.profile.activeEnvironment = 'dev';
  return a;
}
function ep(a: Aggregate, alias: string, method: Endpoint['request']['method'], url: string, extra: Partial<Endpoint> & { body?: string } = {}): Endpoint {
  const e = newEndpoint(a);
  const { body, ...rest } = extra;
  Object.assign(e, { name: alias.replace(/_/g, ' '), alias, checks: [{ kind: 'status', min: 200, max: 299 }] }, rest);
  Object.assign(e.request, { method, hostKey: 'api', url, body: body === undefined ? { kind: 'none' } : { kind: 'json', text: body } });
  a.endpoints.push(e);
  return e;
}
function plan(a: Aggregate, steps: Step[], o: Partial<Plan> = {}): Plan {
  const p: Plan = { id: 'plan-1', name: 'P', strategy: 'flow', mode: 'direct', steps, iterations: 1, concurrency: 1, delayMs: 0, rampUp: false, rampStepMs: 0, onFailure: 'continue', notify: 'off', ...o };
  a.plans = [p];
  return p;
}

/** In-process server: handler gets the request; tracks hits and the maximum simultaneous requests. */
function fake(handler: (r: { method: string; url: URL; headers: Headers; body: string }) => Promise<{ status?: number; body?: unknown; headers?: Record<string, string>; delay?: number }> | { status?: number; body?: unknown; headers?: Record<string, string>; delay?: number }) {
  const log: { method: string; path: string; headers: Headers; body: string }[] = [];
  let inflight = 0, max = 0;
  const transport: Transport = async (url, init) => {
    inflight++; max = Math.max(max, inflight);
    try {
      const headers = new Headers(init.headers);
      const body = typeof init.body === 'string' ? init.body : init.body ? String(init.body) : '';
      const u = new URL(url);
      log.push({ method: init.method ?? 'GET', path: u.pathname + u.search, headers, body });
      const r = await handler({ method: init.method ?? 'GET', url: u, headers, body });
      if (r.delay) await new Promise<void>((res, rej) => {
        const t = setTimeout(res, r.delay);
        init.signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')); });
      });
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...r.headers } });
    } finally { inflight--; }
  };
  return { transport, log, max: () => max };
}
const auth = (agg: Aggregate, transport: Transport, base: Sources = none) => createAuth({ agg: () => agg, pageOrigin: PAGE, base: () => base, transport, limit: () => 1 << 20 });
const go = (agg: Aggregate, p: Plan, transport: Transport, o: { once?: boolean; sources?: Sources; a?: ReturnType<typeof auth> } = {}) =>
  startRun({ agg, plan: p, once: !!o.once, pageOrigin: PAGE, sources: () => o.sources ?? none, transport, auth: o.a ?? auth(agg, transport, o.sources), limit: 1 << 20 });

test.describe('expression grammar (G16)', () => {
  test('every documented form parses; unknown names, calls, prototype keys and limits fail with a reason', () => {
    for (const ok of ['create_user.id', 'list.items[0].id', '$uuid', '$timestamp', '$counter("order", 1, 1)', '$randomInt(1, 100)', '$cookie("XSRF")', '$localStorage("t")',
      '$sessionStorage("t")', '$meta("csrf-token")', '$dom("#token", "value")', '$dom("#x", "attr:data-k")', '$context("auth")', '$eval("amount * 2 > 10 && !(x.ok == false)")'])
      expect(parseExpr(ok), ok).toMatchObject({ ok: true });
    const err = (s: string) => { const r = parseExpr(s); return r.ok ? 'parsed' : r.error; };
    expect(err('$nope()')).toBe('Unknown built-in $nope');
    expect(err('$eval("alert(1)")')).toBe('Calls are not allowed (alert(…))');
    expect(err('$eval("x = 1")')).toMatch(/Unexpected "="/);
    expect(err('a.__proto__.x')).toBe('"__proto__" is not allowed');
    expect(err('constructor')).toBe('"constructor" is not allowed');
    expect(err('$dom("#x", "innerHTML")')).toMatch(/reads "value", "text" or "attr:<name>" only/);
    expect(err(`a${'.b'.repeat(17)}`)).toMatch(/longer than 16 segments/);
    expect(err('x'.repeat(513))).toMatch(/longer than 512/);
    expect(err(`$eval("${Array(130).fill('1').join('+')}")`)).toMatch(/More than 256 parts/);
    expect(err(`$eval("${'('.repeat(20)}1${')'.repeat(20)}")`)).toMatch(/deeper than 16/);
    expect(err('$randomInt(5, 1)')).toBe('Max must be at least min');
    expect(err('$randomInt(1, 99999999999999999)')).toMatch(/safe whole number/);
  });

  test('sites: URL components encoded, header line breaks refused, JSON whole values keep their type and exact digits', () => {
    const outputs = (alias: string) => alias === 'acct'
      ? { ok: true as const, value: parseExact('{"id":"a b/1","amount":100.10,"big":12345678901234567890,"tags":["x"],"open":true,"note":"two\\nlines"}') }
      : { ok: false as const, why: `${alias} has not run` };
    const e = env({ outputs });
    expect(run1('/accounts/{{acct.id}}', 'url', e).out).toBe('/accounts/a%20b%2F1');
    expect(run1('{{acct.note}}', 'header', e).blocked).toEqual(['F: {{acct.note}} resolved to a value with a line break']);
    expect(run1('{{acct.tags}}', 'header', e).blocked).toEqual(['F: {{acct.tags}} is array; pick a field inside it']);
    const j = run1('{"a": {{acct.amount}}, "b": "{{acct.amount}}", "c": "id-{{acct.id}}", "d": {{acct.big}}, "e": {{acct.tags}}, "f": "{{acct.open}}"}', 'json', e);
    expect(j.blocked).toEqual([]);
    expect(j.out).toBe('{"a": 100.10, "b": 100.10, "c": "id-a b/1", "d": 12345678901234567890, "e": ["x"], "f": true}');
    expect(run1('{{quote.id}}', 'text', e).blocked).toEqual(['F: quote has not run']);
    expect(run1('{{acct.missing}}', 'text', e).blocked).toEqual(['F: acct.missing is not in acct\'s response']);
    expect(run1('{{other.id}}', 'text', e).blocked).toEqual(['F: no endpoint has alias other']);
    expect(run1('{{acct.id}}', 'text', env()).blocked[0]).toMatch(/needs acct's response from the same plan run; Once never reuses an earlier response/);
  });

  test('generated values: one reservation per identical expression per request; counters advance in order; eval is exact', () => {
    const e = env();
    expect(run1('{{$uuid}}|{{ $uuid }}|{{$timestamp}}|{{$randomInt(1, 10)}}', 'text', e).out).toBe('uuid-1|uuid-1|1700000000000|6');
    expect(run1('{{$uuid}}', 'text', { ...e, reserved: new Map() }).out).toBe('uuid-2'); // a new preparation
    expect(run1('{{$uuid}}', 'text', e).out).toBe('uuid-1'); // same reservation = deliberate duplicate
    const counters = new Map<string, number>();
    const c = (r = new Map()) => run1('{{$counter("order", 100, 5)}}', 'text', env({ counters, reserved: r })).out;
    expect([c(), c(), c()]).toEqual(['100', '105', '110']);
    const outputs = () => ({ ok: true as const, value: parseExact('{"balance":"100.10","limit":100.1,"status":"open","n":2}') });
    const ev = (x: string) => run1(`{{$eval("${x}")}}`, 'text', env({ outputs }));
    expect(ev('acct.limit == 100.10 && acct.limit >= 100.1').out).toBe('true');
    expect(ev('acct.n * 3 + 1').out).toBe('7');
    expect(ev('acct.status == \\"open\\" || false').out).toBe('true');
    expect(ev('acct.n / 0').blocked[0]).toMatch(/division by zero/);
    expect(ev('acct.n * 9007199254740993').blocked[0]).toMatch(/safe number range/);
    expect(compareDecimal(decimalText('100.10')!, decimalText('1.001e2')!)).toBe(0);
    expect(compareDecimal('-0.5', '0.25')).toBe(-1);
    expect(stringifyExact(parseExact('{"x":[1.50,-0,1e3]}'))).toBe('{"x":[1.50,-0,1e3]}');
  });

  test('conditions compare exact decimals, sets and existence over own paths', () => {
    const get = () => ({ ok: true as const, value: parseExact('{"t":{"amount":"100.10","fee":0.50,"status":"completed"}}') });
    expect(checkCondition({ ref: 'x.t.amount', op: 'eq', value: '100.1' }, get).ok).toBe(false); // a string compares as text
    expect(checkCondition({ ref: 'x.t.fee', op: 'eq', value: '0.5' }, get).ok).toBe(true); // a number compares exactly
    expect(checkCondition({ ref: 'x.t.amount', op: 'gte', value: '100.10' }, get).ok).toBe(true);
    expect(checkCondition({ ref: 'x.t.status', op: 'in', value: 'pending, completed' }, get).ok).toBe(true);
    expect(checkCondition({ ref: 'x.t.nope', op: 'exists' }, get).ok).toBe(false);
    expect(checkCondition({ ref: 'x.t', op: 'eq', value: '1' }, get)).toEqual({ ok: false, detail: 'x.t is not a single value' });
    expect(checkCondition({ ref: 'x.t.fee', op: 'eq', value: '1' }, () => ({ ok: false, why: 'x ended failed-check' }))).toEqual({ ok: null, detail: 'x ended failed-check' });
  });
});

test.describe('auth contexts and signing (S22 / G27 signing)', () => {
  test('context headers come from sources, never cross audiences, and expiry blocks or asks for refresh', () => {
    const a = profile();
    a.authContexts = [{ id: 'auth-1', label: 'Customer', identity: 'alice', audience: 'api', credentials: 'include', headers: [{ name: 'Authorization', prefix: 'Bearer ', source: { kind: 'localStorage', key: 'token' } }], expiry: { source: { kind: 'localStorage', key: 'exp' }, format: 'epoch-ms' } }];
    const e = ep(a, 'accounts', 'GET', '/v1/accounts', { authContextId: 'auth-1' });
    expect(validateAggregate(a).ok).toBe(true);
    const store: Record<string, string> = { token: 'tok-abcdef', exp: String(Date.now() + 60_000) };
    const src = { ...none, localStorage: (k: string) => store[k] };
    const p = prepare(a, e, PAGE, src, new Map());
    expect(p.blocked).toEqual([]);
    expect(p.credentials).toBe('include');
    expect(p.headers.find((h) => h.name === 'Authorization')).toMatchObject({ value: 'Bearer tok-abcdef', from: 'auth', shown: '••••cdef (17 chars)' });
    e.request.hostKey = 'other';
    expect(prepare(a, e, PAGE, src, new Map()).blocked[0]).toBe('Auth context Customer is for https://api.bank.test; this request goes to https://other.bank.test. Its credentials are not sent to another audience');
    e.request.hostKey = 'api';
    store.exp = String(Date.now() - 1);
    expect(prepare(a, e, PAGE, src, new Map()).blocked[0]).toMatch(/^Auth context Customer: expired at .*; configure refresh or sign in again in the page$/);
    a.authContexts[0]!.refresh = { endpointId: e.id, outputs: [{ path: 'token', target: { kind: 'localStorage', key: 'token' } }], deadlineMs: 1000, readOnlyRetry: false };
    const r = prepare(a, e, PAGE, src, new Map());
    expect(r.blocked).toEqual([]);
    expect(r.auth).toMatchObject({ state: 'expired', needsRefresh: true });
  });

  test('HMAC-SHA-256 recipe matches a server-side vector over the exact canonical bytes; missing key blocks', async () => {
    const a = profile();
    const recipe: SigningRecipe = { id: 'sign-1', label: 'Test HMAC', algorithm: 'HMAC-SHA-256', components: ['method', 'path', 'query', 'body-sha256', 'timestamp', 'nonce', 'header:idempotency-key'], separator: '\n', encoding: 'hex', keyRef: 'bank_key', outputHeader: 'X-Signature', timestampHeader: 'X-Timestamp', nonceHeader: 'X-Nonce', freshnessMs: 30_000 };
    a.signingRecipes = [recipe];
    const e = ep(a, 'transfer', 'POST', '/v1/transfers?x=1&a=b', { signingRecipeId: 'sign-1', body: '{ "amount": "100.10" }' });
    e.request.headers = [{ name: 'Idempotency-Key', value: 'k-1' }];
    expect(prepare(a, e, PAGE, none, new Map()).blocked).toEqual(['Signing recipe Test HMAC needs key "bank_key" for this session (Auth & context → Signing keys); keys are never stored']);
    const p = prepare(a, e, PAGE, none, new Map(), { keys: new Set(['bank_key']) });
    expect(p.blocked).toEqual([]);
    const key = await importKey('test-key-123');
    const { headers, message } = await signPrepared(p, key, 1_700_000_000_123, 'nonce-1');
    const bodyHash = createHmac('sha256', '').digest('hex') && (await import('node:crypto')).createHash('sha256').update('{ "amount": "100.10" }').digest('hex');
    expect(message).toBe(['POST', '/v1/transfers', 'x=1&a=b', bodyHash, '1700000000123', 'nonce-1', 'k-1'].join('\n'));
    expect(headers.find((h) => h.name === 'X-Signature')!.value).toBe(createHmac('sha256', 'test-key-123').update(message).digest('hex'));
    expect(headers.find((h) => h.name === 'X-Timestamp')!.value).toBe('1700000000123');
    expect(await canonical({ ...recipe, components: ['method', 'header:x-missing'] }, { method: 'GET', url: 'http://x/', bodyText: null, headers: [], timestamp: '', nonce: '' })).toBe('GET\n');
  });
});

test.describe('preflight graph (G16)', () => {
  test('missing producers, cycles, setup on load, Independent cross-load reads and own-response refs are refused', () => {
    const a = profile();
    const login = ep(a, 'login', 'POST', '/login', { body: '{}' });
    const create = ep(a, 'create', 'POST', '/items', { body: '{"owner":"{{login.user}}"}' });
    const read = ep(a, 'read', 'GET', '/items/{{create.id}}');
    const pf = (p: Plan) => preflight(a, p, { once: false, pageOrigin: PAGE, sources: none, keys: new Set() });
    const ok = pf(plan(a, [{ endpointId: login.id, phase: 'setup' }, { endpointId: read.id, phase: 'load' }, { endpointId: create.id, phase: 'load' }], { iterations: 3 }));
    expect(ok.errors).toEqual([]);
    expect(ok.load.map((i) => i.ep.alias)).toEqual(['create', 'read']); // dependency order, not list order
    expect(ok.counts).toMatchObject({ setup: 1, load: 6, primary: 7, worst: 7 });
    expect(ok.mutating).toEqual(['POST login (login) · no idempotency key', 'POST create (create) · no idempotency key']);
    expect(pf(plan(a, [{ endpointId: login.id, phase: 'load' }, { endpointId: create.id, phase: 'setup' }])).errors).toContain('Setup step create (create) depends on load step login (login); setup runs once before load');
    expect(pf(plan(a, [{ endpointId: create.id, phase: 'load' }, { endpointId: read.id, phase: 'load' }])).errors).toContain('read (read) uses... '.slice(0, 0) + 'create (create) uses login (login), which is not a setup or load step in this plan');
    expect(pf(plan(a, [{ endpointId: login.id, phase: 'setup' }, { endpointId: create.id, phase: 'load' }, { endpointId: read.id, phase: 'load' }], { strategy: 'independent' })).errors)
      .toEqual(["Independent: read (read) reads create (create)'s response, but independent jobs never share outputs. Use Flow, or move create to setup"]);
    login.request.url = '/login/{{read.id}}';
    expect(pf(plan(a, [{ endpointId: login.id, phase: 'load' }, { endpointId: create.id, phase: 'load' }, { endpointId: read.id, phase: 'load' }])).errors).toEqual(['Steps login, create, read depend on each other in a cycle']);
    login.request.url = '/login/{{login.x}}/{{ghost.y}}/{{$bogus}}';
    expect(pf(plan(a, [{ endpointId: login.id, phase: 'setup' }])).errors).toEqual([
      'login (login) URL: {{$bogus}}: Unknown built-in $bogus', 'login (login) URL: refers to its own response', 'login (login) URL: no endpoint has alias ghost']);
  });

  test('worst-case counts include polls, refreshes and read-only retries; the 50,000 cap blocks', () => {
    const a = profile();
    const refresh = ep(a, 'refresh', 'POST', '/refresh', { body: '{}' });
    a.authContexts = [{ id: 'auth-1', label: 'C', identity: '', audience: 'api', credentials: 'same-origin', headers: [], refresh: { endpointId: refresh.id, outputs: [], deadlineMs: 1000, readOnlyRetry: true } }];
    const status = ep(a, 'status', 'GET', '/status', { authContextId: 'auth-1' });
    const p = plan(a, [{ endpointId: status.id, phase: 'load', poll: { readOnly: true, until: { ref: 'status.done', op: 'eq', value: 'true' }, maxAttempts: 5, intervalMs: 250, deadlineMs: 5000 } }], { iterations: 10 });
    const pf = preflight(a, p, { once: false, pageOrigin: PAGE, sources: none, keys: new Set() });
    expect(pf.counts).toEqual({ setup: 0, load: 10, primary: 10, poll: 40, refresh: 100, retry: 50, worst: 200 });
    const big = { ...p, iterations: 1000, steps: [{ ...p.steps[0]!, poll: { ...p.steps[0]!.poll!, maxAttempts: 10 } }] };
    const one = preflight(a, big, { once: false, pageOrigin: PAGE, sources: none, keys: new Set() });
    expect([one.counts.worst, one.ok]).toEqual([1000 + 9000 + 20000 + 10000, true]);
    const status2 = ep(a, 'status2', 'GET', '/status2', { authContextId: 'auth-1' });
    const two = preflight(a, { ...big, steps: [...big.steps, { ...big.steps[0]!, endpointId: status2.id, poll: { ...big.steps[0]!.poll!, until: { ref: 'status2.done', op: 'eq', value: 'true' } } }] }, { once: false, pageOrigin: PAGE, sources: none, keys: new Set() });
    expect(two.errors).toEqual(['Up to 80000 requests; the limit for one run is 50000']);
    expect(preflight(a, p, { once: true, pageOrigin: PAGE, sources: none, keys: new Set() }).counts.primary).toBe(1);
  });
});

test.describe('scheduler (G16/G17)', () => {
  test('Flow: setup once, producer outputs stay inside each iteration, a failed producer skips only its dependents', async () => {
    const a = profile();
    const login = ep(a, 'login', 'POST', '/login', { body: '{}' });
    const create = ep(a, 'create', 'POST', '/items', { body: '{"owner":"{{login.user}}","n":{{$counter("n", 1, 1)}}}' });
    const read = ep(a, 'read', 'GET', '/items/{{create.id}}');
    const other = ep(a, 'other', 'GET', '/other');
    let id = 0;
    const srv = fake(({ method, url, body }) => {
      if (url.pathname === '/login') return { body: { user: 'u1' } };
      if (method === 'POST') { const n = JSON.parse(body).n; return n === 2 ? { status: 500 } : { body: { id: `item-${++id}`, n } }; }
      if (url.pathname.startsWith('/items/')) return { body: { id: url.pathname.slice(7) } };
      return { body: {} };
    });
    const r = go(a, plan(a, [{ endpointId: login.id, phase: 'setup' }, { endpointId: create.id, phase: 'load' }, { endpointId: read.id, phase: 'load' }, { endpointId: other.id, phase: 'load' }], { iterations: 3, concurrency: 2 }), srv.transport);
    const s = await r.done;
    expect(s.state).toBe('completed');
    expect(srv.log.filter((x) => x.path === '/login')).toHaveLength(1);
    const reads = srv.log.filter((x) => x.path.startsWith('/items/')).map((x) => x.path).sort();
    expect(reads).toEqual(['/items/item-1', '/items/item-2']); // iteration 2's create failed: its read was skipped
    expect(srv.log.filter((x) => x.method === 'POST' && x.path === '/items').map((x) => JSON.parse(x.body)).map((b) => b.owner)).toEqual(['u1', 'u1', 'u1']);
    const skipped = s.steps.filter((x) => x.outcome === 'skipped-dependency');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ alias: 'read', detail: 'Producer create ended failed-check' });
    expect(s.counts).toMatchObject({ passed: 8, 'failed-check': 1, 'skipped-dependency': 1 });
    expect(s.steps.filter((x) => x.alias === 'other' && x.outcome === 'passed')).toHaveLength(3); // unrelated steps continue
    expect(s.progress).toEqual({ done: 10, total: 10 });
  });

  test('Independent: one fair queue per endpoint, one global concurrency limit, fresh context per job', async () => {
    const a = profile();
    const x = ep(a, 'x', 'GET', '/x'), y = ep(a, 'y', 'GET', '/y'), z = ep(a, 'z', 'GET', '/z');
    const srv = fake(() => ({ body: {}, delay: 5 }));
    const s = await go(a, plan(a, [{ endpointId: x.id, phase: 'load' }, { endpointId: y.id, phase: 'load' }, { endpointId: z.id, phase: 'load' }], { strategy: 'independent', iterations: 4, concurrency: 2 }), srv.transport).done;
    expect(srv.max()).toBeLessThanOrEqual(2);
    expect(srv.log.map((l) => l.path).slice(0, 6)).toEqual(['/x', '/y', '/z', '/x', '/y', '/z']);
    expect(s.counts.passed).toBe(12);
    expect(new Set(s.steps.map((r) => r.job)).size).toBe(12);
  });

  test('Stop: in-flight requests abort, queued work never dispatches, delays end, distinct outcomes remain', async () => {
    const a = profile();
    const slow = ep(a, 'slow', 'GET', '/slow');
    const srv = fake(() => ({ body: {}, delay: 2000 }));
    const r = go(a, plan(a, [{ endpointId: slow.id, phase: 'load' }], { iterations: 50, concurrency: 3, delayMs: 10_000 }), srv.transport);
    await new Promise((res) => setTimeout(res, 50));
    r.stop();
    const s = await r.done;
    await new Promise((res) => setTimeout(res, 50));
    expect(s.state).toBe('stopped');
    expect(srv.log).toHaveLength(3);
    expect(s.counts.aborted).toBe(3);
    expect(s.notes[0]).toBe('Stopped by you. 47 planned step(s) were not started; nothing more was sent.');
  });

  test('guard false is skipped-condition; a bounded read-only poll ends at its condition or as timeout; assertions compare exact values', async () => {
    const a = profile();
    const quote = ep(a, 'quote', 'POST', '/quotes', { body: '{}' });
    const transfer = ep(a, 'transfer', 'POST', '/transfers', { body: '{"quote":"{{quote.id}}","amount":{{quote.amount}}}' });
    const status = ep(a, 'status', 'GET', '/transfers/{{transfer.id}}');
    const never = ep(a, 'never', 'GET', '/never');
    let polls = 0;
    const srv = fake(({ url, body }) => {
      if (url.pathname === '/quotes') return { body: '{"id":"q1","amount":100.10,"risk":"low"}' };
      if (url.pathname === '/transfers') return { status: 202, body: `{"id":"t1","amount":${JSON.parse(body).amount === 100.1 ? '100.10' : 0}}` };
      if (url.pathname === '/transfers/t1') return { body: ++polls < 3 ? { status: 'pending' } : '{"status":"completed","amount":100.10}' };
      return { body: { status: 'pending' } };
    });
    const until = { ref: 'status.status', op: 'in' as const, value: 'completed,failed' };
    const p = plan(a, [
      { endpointId: quote.id, phase: 'load' },
      { endpointId: transfer.id, phase: 'load', guard: { ref: 'quote.risk', op: 'eq', value: 'low' }, idempotency: { header: 'Idempotency-Key' } },
      { endpointId: status.id, phase: 'load', poll: { readOnly: true, until, maxAttempts: 5, intervalMs: 250, deadlineMs: 5000 }, assertions: [{ ref: 'status.status', op: 'eq', value: 'completed' }, { ref: 'status.amount', op: 'eq', value: '100.1' }, { ref: 'transfer.amount', op: 'gte', value: '100.10' }] },
    ], { iterations: 2 });
    const s = await go(a, p, srv.transport).done;
    const statusRows = s.steps.filter((x) => x.alias === 'status');
    expect(statusRows[0]).toMatchObject({ outcome: 'passed', detail: 'Poll condition met on attempt 3' });
    expect(statusRows[0]!.attempts).toHaveLength(3);
    expect(statusRows[0]!.assertions.map((x) => x.state)).toEqual(['passed', 'passed', 'passed']);
    expect(s.dispatched.poll).toBe(2);
    const keys = s.attempts.filter((x) => x.alias === 'transfer').map((x) => x.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2); // a new logical operation gets a new key
    expect(srv.log.find((l) => l.path === '/transfers')!.body).toBe('{"quote":"q1","amount":100.10}');

    // Never-ending pending: bounded by attempts.
    const pend = plan(a, [{ endpointId: never.id, phase: 'load', poll: { readOnly: true, until: { ref: 'never.status', op: 'eq', value: 'done' }, maxAttempts: 2, intervalMs: 250, deadlineMs: 5000 } }]);
    const s2 = await go(a, pend, srv.transport).done;
    expect(s2.steps[0]).toMatchObject({ outcome: 'timeout', detail: 'Still pending after 2 attempt(s) (never.status = done: got pending)' });

    const guarded = plan(a, [{ endpointId: quote.id, phase: 'load' }, { endpointId: transfer.id, phase: 'load', guard: { ref: 'quote.risk', op: 'eq', value: 'high' } }]);
    const s3 = await go(a, guarded, srv.transport).done;
    expect(s3.steps[1]).toMatchObject({ outcome: 'skipped-condition', detail: 'Guard quote.risk = high: got low' });
  });

  test('expiry under concurrency: one refresh per context, resumed calls use the new token, writes are never auto-retried', async () => {
    const a = profile();
    const refresh = ep(a, 'refresh', 'POST', '/refresh', { body: '{}' });
    a.authContexts = [{ id: 'auth-1', label: 'Customer', identity: 'alice', audience: 'api', credentials: 'same-origin', headers: [{ name: 'Authorization', prefix: 'Bearer ', source: { kind: 'localStorage', key: 'token' } }], expiry: { source: { kind: 'localStorage', key: 'exp' }, format: 'epoch-ms' },
      refresh: { endpointId: refresh.id, outputs: [{ path: 'token', target: { kind: 'localStorage', key: 'token' } }, { path: 'exp', target: { kind: 'localStorage', key: 'exp' } }], deadlineMs: 2000, readOnlyRetry: true } }];
    const read = ep(a, 'read', 'GET', '/accounts', { authContextId: 'auth-1' });
    const write = ep(a, 'write', 'POST', '/pay', { authContextId: 'auth-1', body: '{}' });
    let refreshes = 0;
    let valid = 'new-token';
    const srv = fake(({ url, headers }) => {
      if (url.pathname === '/refresh') { refreshes++; return { body: { token: valid, exp: Date.now() + 60_000 }, delay: 30 }; }
      return headers.get('authorization') === `Bearer ${valid}` ? { body: { ok: true } } : { status: 401, body: { error: 'expired' } };
    });
    const past = String(Date.now() - 1);
    const page = { ...none, localStorage: (k: string) => (k === 'token' ? 'old-token' : k === 'exp' ? past : undefined) };
    const p = plan(a, [{ endpointId: read.id, phase: 'load' }], { strategy: 'independent', iterations: 6, concurrency: 6 });
    const co = auth(a, srv.transport, page);
    const s = await go(a, p, srv.transport, { sources: page, a: co }).done;
    expect(refreshes).toBe(1);
    expect(s.counts.passed).toBe(6);
    expect(s.attempts.filter((x) => x.kind === 'refresh')).toHaveLength(1);
    expect(srv.log.filter((l) => l.path === '/accounts').every((l) => l.headers.get('authorization') === 'Bearer new-token')).toBe(true);

    // The server rotates the token: a read gets 401 → one shared refresh → one retry. A write gets 401 → no retry.
    valid = 'rotated';
    const s2 = await go(a, plan(a, [{ endpointId: read.id, phase: 'load' }, { endpointId: write.id, phase: 'load' }]), srv.transport, { sources: page, a: co }).done;
    expect(s2.attempts.filter((x) => x.alias === 'read').map((x) => [x.kind, x.status])).toEqual([['primary', 401], ['retry', 200]]);
    expect(s2.attempts.filter((x) => x.alias === 'write').map((x) => [x.kind, x.status])).toEqual([['primary', 200]]);
    valid = 'never';
    const s3 = await go(a, plan(a, [{ endpointId: write.id, phase: 'load' }]), srv.transport, { sources: page, a: co }).done;
    expect(s3.attempts.filter((x) => x.alias === 'write')).toHaveLength(1);
    expect(s3.attempts[0]!.reason).toBe('401 on a write: not retried automatically; reconcile with a read-only status check');

    // The application signs in again: its new page token wins over the earlier refreshed one.
    const relogin = { ...none, localStorage: (k: string) => (k === 'token' ? 'app-relogin' : k === 'exp' ? String(Date.now() + 60_000) : undefined) };
    expect(co.sources(a.authContexts[0]!, relogin).localStorage('token')).toBe('app-relogin');
    expect(co.sources(a.authContexts[0]!, page).localStorage('token')).toBe('rotated');

    // Failed refresh blocks waiting work with its cause and no loop.
    const b = profile();
    b.endpoints = a.endpoints; b.authContexts = a.authContexts;
    const failing = fake(({ url }) => (url.pathname === '/refresh' ? { status: 403, body: {} } : { body: {} }));
    const s4 = await go(b, plan(b, [{ endpointId: read.id, phase: 'load' }], { iterations: 3, concurrency: 3, strategy: 'independent' }), failing.transport, { sources: page }).done;
    expect(failing.log.filter((l) => l.path === '/refresh').length).toBeLessThanOrEqual(3);
    expect(s4.counts['blocked-before-dispatch']).toBe(3);
    expect(s4.steps[0]!.detail).toBe('Auth context Customer: refresh failed — Refresh refresh returned HTTP 403');
  });

  test('ramp-up admits one more worker per step; a worker waits its delay after each complete iteration', async () => {
    const a = profile();
    const x = ep(a, 'x', 'GET', '/x');
    const starts: number[] = [];
    const t0 = performance.now();
    let slow = 400;
    const srv = fake(() => { starts.push(performance.now() - t0); return { body: {}, delay: slow }; });
    await go(a, plan(a, [{ endpointId: x.id, phase: 'load' }], { iterations: 3, concurrency: 3, rampUp: true, rampStepMs: 150 }), srv.transport).done;
    expect(starts).toHaveLength(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(140);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(140);
    starts.length = 0;
    slow = 0;
    const t1 = performance.now();
    await go(a, plan(a, [{ endpointId: x.id, phase: 'load' }], { iterations: 3, concurrency: 1, delayMs: 120 }), srv.transport).done;
    expect(performance.now() - t1).toBeGreaterThanOrEqual(235); // two delays between three iterations, none after the last
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(115);
  });

  test('failed preflight sends nothing; stop policy halts admission after the first failure', async () => {
    const a = profile();
    const bad = ep(a, 'bad', 'GET', '/x/{{ghost.id}}');
    const srv = fake(() => ({ status: 500 }));
    const s = await go(a, plan(a, [{ endpointId: bad.id, phase: 'load' }]), srv.transport).done;
    expect(s.state).toBe('failed-preflight');
    expect(srv.log).toHaveLength(0);
    const f = ep(a, 'fail', 'GET', '/fail');
    const s2 = await go(a, plan(a, [{ endpointId: f.id, phase: 'load' }], { iterations: 20, onFailure: 'stop' }), srv.transport).done;
    expect(srv.log).toHaveLength(1);
    expect(s2.state).toBe('stopped');
    expect(s2.notes[0]).toMatch(/^Stopped after fail ended failed-check \(failure policy: stop\)\. 19 planned/);
  });
});

test.describe('statistics and export (G17)', () => {
  test('nearest-rank P95 over retained samples, totals-based means, capped flag', () => {
    expect(p95([])).toBeNull();
    expect(p95([5])).toBe(5);
    expect(p95(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(19);
    expect(p95(Array.from({ length: 100 }, (_, i) => 100 - i))).toBe(95);
    expect(p99([])).toBeNull();
    expect(p99(Array.from({ length: 100 }, (_, i) => 100 - i))).toBe(99);
    expect(p99(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(20);
    const s = emptyStat();
    for (let i = 1; i <= 1005; i++) record(s, i);
    expect(s).toMatchObject({ n: 1005, min: 1, max: 1005, capped: true });
    expect(s.samples).toHaveLength(1000);
    expect(s.sum / s.n).toBe(503);
  });

  test('CSV quotes delimiters/newlines and neutralizes formula prefixes in user text only', async () => {
    expect(csvCell('=HYPERLINK("x")', true)).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell('a,b\nc', true)).toBe('"a,b\nc"');
    expect(csvCell('-5', true)).toBe("'-5");
    expect(csvCell(-5)).toBe('-5');
    const a = profile();
    const e = ep(a, 'x', 'GET', '/x', { name: '@cmd|evil' });
    const s = await go(a, plan(a, [{ endpointId: e.id, phase: 'load' }], { iterations: 2 }), fake(() => ({ body: {} })).transport).done;
    const csv = toCsv(s).split('\r\n');
    expect(csv[1]!.startsWith("'@cmd|evil,x,GET,2,0,")).toBe(true);
    expect(s.endpoints[0]!.network.n).toBe(2);
  });

  test('samples mask sensitive JSON keys and keep exact numbers', async () => {
    const a = profile();
    const e = ep(a, 'login', 'GET', '/l');
    const s = await go(a, plan(a, [{ endpointId: e.id, phase: 'load' }]), fake(() => ({ body: '{"access_token":"abc","amount":100.10,"user":{"sessionId":"s","name":"n"}}', headers: { 'x-csrf-token': 'z' } })).transport).done;
    expect(s.samples[0]!.body).toBe('{"access_token":"[redacted]","amount":100.10,"user":{"sessionId":"[redacted]","name":"n"}}');
    expect(s.samples[0]!.headers.some(([k]) => k === 'x-csrf-token')).toBe(false);
    expect(new Num('1').raw).toBe('1');
  });
});
