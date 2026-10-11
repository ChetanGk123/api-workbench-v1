// R2 pure assertions: schema 2 validation, schema 1 migration, export/import, request preparation,
// checks, alias references, Promote common. Counted in the same runner as browser cases.
import { expect, test } from '@playwright/test';
import { exportEnvelope, readImport } from '../src/data/backup';
import { migrateV1 } from '../src/data/migrate';
import {
  aliasReferences, copyAggregate, defaultProfile, newEndpoint, redactAggregate, renameAliasRefs, validateAggregate, validateEndpointIn,
  type Aggregate, type Endpoint,
} from '../src/data/schema';
import { evaluate, prepare, type OnceResult, type Sources } from '../src/tester/once';
import { convertBody, promotion } from '../src/ui/endpoints';

const PAGE = 'http://page.test';
const none: Sources = { cookie: () => undefined, localStorage: () => undefined, sessionStorage: () => undefined, meta: () => undefined };
const paths = (r: { ok: boolean; errors?: { path: string }[] }) => (r.ok ? [] : r.errors!.map((d) => d.path));

function agg(mut: (a: Aggregate) => void = () => {}): Aggregate {
  const a = defaultProfile('Bank');
  a.profile.environments = { dev: { api: 'https://dev.bank.test', page: '' }, stage: { api: 'https://stage.bank.test', page: '' } };
  a.profile.activeEnvironment = 'dev';
  mut(a);
  return a;
}
function ep(a: Aggregate, patch: Partial<Omit<Endpoint, 'request'>> & { request?: Partial<Endpoint['request']> } = {}): Endpoint {
  const e = newEndpoint(a);
  const { request, ...rest } = patch;
  Object.assign(e, rest);
  Object.assign(e.request, { hostKey: 'api', url: '/v1/accounts' }, request);
  return e;
}

// A representative schema 1 whole backup, shaped like api-workbench's exportAll().
const V1 = {
  schemaVersion: 1,
  profile: {
    id: 'default', name: 'wires', revision: 3, createdAt: 1, updatedAt: 2,
    environments: { default: { default: '', api: 'https://dev.api.example.com' } }, activeEnvironment: 'default',
    globalHeaders: [{ name: 'Accept', value: 'application/json' }, { name: 'X-Old', value: 'x', removed: true }],
    settings: { bodyLimitKb: 512, enabledModules: { mock: true } },
  },
  endpoints: [
    { id: 'endpoint-1', profileId: 'default', alias: 'get_accounts', name: 'Accounts', hostKey: 'api', createdAt: 1, updatedAt: 1,
      request: { method: 'GET', path: '/api/wires/accounts?RequestID=a%20b+c', headers: [{ name: 'Authorization', value: 'Bearer abc' }, { name: 'Accept', value: '', removed: true }], bodyKind: 'none', body: '', credentials: 'include' },
      checks: [{ kind: 'status', value: { min: 200, max: 299 } }, { kind: 'json', path: 'accounts[0].id', mode: 'exists' }],
      sampleResponse: { status: 200, headers: [{ name: 'Content-Type', value: 'application/json' }], body: 'x'.repeat(20_000) } },
    { id: 'endpoint-2', profileId: 'default', alias: 'post_payee', name: 'Create payee', hostKey: 'api', createdAt: 1, updatedAt: 1,
      request: { method: 'POST', path: '/api/wires/payees', headers: [], bodyKind: 'json', body: '{ "name" :"A",  "amount":"100.10" }', credentials: 'same-origin' },
      checks: [{ kind: 'status', value: 201 }, { kind: 'json', path: 'amount', mode: 'equals', value: '100.10' }] },
    { id: 'endpoint-3', profileId: 'default', alias: 'form_ok', name: 'Form', hostKey: 'api', createdAt: 1, updatedAt: 1,
      request: { method: 'POST', path: '/f', headers: [], bodyKind: 'urlencoded', body: 'a=1&a=2&b=x', credentials: 'same-origin' }, checks: [] },
    { id: 'endpoint-4', profileId: 'default', alias: 'form_raw', name: 'Raw form', hostKey: 'api', createdAt: 1, updatedAt: 1,
      request: { method: 'POST', path: '/f', headers: [], bodyKind: 'urlencoded', body: 'q=a%20b&r=*', credentials: 'same-origin' }, checks: [] },
    { id: 'endpoint-5', profileId: 'default', alias: 'get_with_body', name: 'Get with body', hostKey: 'api', createdAt: 1, updatedAt: 1,
      request: { method: 'GET', path: 'https://other.example.com/x', headers: [], bodyKind: 'text', body: 'ignored', credentials: 'omit' }, checks: [] },
  ],
  rules: [{ id: 'rule-1', profileId: 'default', kind: 'mock', label: 'Mock accounts', endpointId: 'endpoint-1', enabled: true, matcher: { method: 'GET', url: '/api/wires/accounts' } }],
  plan: { id: 'plan-1', profileId: 'default', name: 'Working Plan', strategy: 'flow', mode: 'direct', phases: { 'endpoint-1': 'setup' }, excluded: ['endpoint-5'], iterations: 5, concurrency: 2, delayMs: 0, rampUp: false, onFailure: 'continue', notifyOnComplete: false, bindings: [] },
  savedProfiles: [{
    profile: { id: 'p2', name: 'staging', revision: 1, createdAt: 1, updatedAt: 1, environments: { default: { default: '' } }, activeEnvironment: 'default', globalHeaders: [], settings: { bodyLimitKb: 1024, enabledModules: {} } },
    endpoints: [{ id: 'e9', profileId: 'p2', alias: 'ping', name: 'Ping', hostKey: 'default', createdAt: 1, updatedAt: 1, request: { method: 'GET', path: '/ping', headers: [], bodyKind: 'none', body: '', credentials: 'same-origin' }, checks: [] }],
  }],
  savedPlans: [{ id: 'plan-2', profileId: 'p2', name: 'Smoke', strategy: 'independent', mode: 'rules', phases: {}, excluded: [], iterations: 1, concurrency: 1, delayMs: 0, rampUp: false, onFailure: 'stop', notifyOnComplete: false, bindings: [] }],
};

test.describe('schema 2 validation (G21)', () => {
  test('a new profile is valid; future and missing schemas are refused with a reason', () => {
    expect(validateAggregate(defaultProfile()).ok).toBe(true);
    const future = validateAggregate({ ...defaultProfile(), schema: 3 });
    expect(future.ok).toBe(false);
    expect(!future.ok && future.errors[0]!.message).toContain('newer than this build');
    expect(paths(validateAggregate({}))).toEqual(['schema']);
  });

  test('corrupt input reports field paths and drops nothing silently', () => {
    const a = agg((x) => {
      x.endpoints.push(ep(x, { alias: '1bad', request: { method: 'GET', url: 'no-slash', body: { kind: 'text', text: 'x' } } }));
      x.profile.globalHeaders.push({ name: 'Cookie', value: 'a=b' }, { name: 'X-Line', value: 'a\nb' });
    });
    const r = paths(validateAggregate(a));
    expect(r).toEqual(expect.arrayContaining(['endpoints.0.alias', 'endpoints.0.request.url', 'endpoints.0.request.body', 'profile.globalHeaders.0.name', 'profile.globalHeaders.1.value']));
  });

  test('duplicate IDs/aliases, unknown hosts, stale references and prototype keys are invalid', () => {
    const a = agg();
    const e1 = ep(a), e2 = ep(a, { id: e1.id, alias: e1.alias }), e3 = ep(a, { request: { hostKey: 'nope' } });
    a.endpoints.push(e1, e2, e3);
    a.plans.push({ id: 'p1', name: 'P', strategy: 'flow', mode: 'direct', steps: [{ endpointId: 'missing', phase: 'load' }], iterations: 1, concurrency: 1, delayMs: 0, rampUp: false, onFailure: 'continue' });
    const r = paths(validateAggregate(a));
    expect(r).toEqual(expect.arrayContaining(['endpoints.1.id', 'endpoints.1.alias', 'endpoints.2.request.hostKey', 'plans.0.steps.0.endpointId']));
    const proto = JSON.parse(JSON.stringify(agg()).replace('"stage":', '"__proto__":'));
    expect(paths(validateAggregate(proto))).toContain('profile.environments.__proto__');
  });

  test('complex-app definitions: bounded poll on read-only GET, exact decimals, key references only', () => {
    const a = agg();
    const get = ep(a, { alias: 'status' });
    const post = ep(a, { alias: 'transfer', request: { method: 'POST', body: { kind: 'json', text: '{}' } } });
    a.endpoints.push(get, post);
    a.authContexts.push({ id: 'auth-1', label: 'Customer', identity: 'cust-1', audience: 'api', credentials: 'include',
      headers: [{ name: 'Authorization', prefix: 'Bearer ', source: { kind: 'localStorage', key: 'token' } }],
      refresh: { endpointId: get.id, outputs: [{ path: 'token', target: { kind: 'localStorage', key: 'token' } }], deadlineMs: 5000, readOnlyRetry: true } });
    a.signingRecipes.push({ id: 'sign-1', label: 'HMAC', algorithm: 'HMAC-SHA-256', components: ['method', 'path', 'timestamp', 'nonce', 'body-sha256', 'header:x-request-id'], separator: '\n', encoding: 'base64', keyRef: 'transfer_key', outputHeader: 'X-Signature', timestampHeader: 'X-Timestamp', nonceHeader: 'X-Nonce', freshnessMs: 30000 });
    post.signingRecipeId = 'sign-1';
    post.authContextId = 'auth-1';
    a.plans.push({ id: 'pl', name: 'Transfer', strategy: 'flow', mode: 'direct', iterations: 1, concurrency: 1, delayMs: 0, rampUp: false, onFailure: 'stop', steps: [
      { endpointId: post.id, phase: 'load', idempotency: { header: 'Idempotency-Key' }, assertions: [{ ref: 'transfer.amount', op: 'eq', value: '100.10' }] },
      { endpointId: get.id, phase: 'load', guard: { ref: 'transfer.status', op: 'eq', value: 'PENDING' }, poll: { readOnly: true, until: { ref: 'status.state', op: 'in', value: 'DONE,FAILED' }, maxAttempts: 10, intervalMs: 250, deadlineMs: 30000 } },
    ] });
    const ok = validateAggregate(a);
    expect(ok.ok ? [] : ok.errors).toEqual([]);

    const bad = structuredClone(a);
    bad.plans[0]!.steps[0]!.poll = { readOnly: true, until: { ref: 'x.y', op: 'exists' }, maxAttempts: 11, intervalMs: 100, deadlineMs: 60000 };
    bad.plans[0]!.steps[1]!.assertions = [{ ref: 'transfer.amount', op: 'gt', value: '1e3' }];
    bad.signingRecipes[0]!.keyRef = 'MIIBIjANBg+key/material==';
    bad.signingRecipes[0]!.components.push('script' as never);
    bad.authContexts[0]!.refresh!.deadlineMs = 60000;
    expect(paths(validateAggregate(bad))).toEqual(expect.arrayContaining([
      'plans.0.steps.0.poll', 'plans.0.steps.0.poll.maxAttempts', 'plans.0.steps.0.poll.intervalMs', 'plans.0.steps.0.poll.deadlineMs',
      'plans.0.steps.1.assertions.0.value', 'signingRecipes.0.keyRef', 'signingRecipes.0.components.6', 'authContexts.0.refresh.deadlineMs',
    ]));
  });
});

test.describe('schema 1 migration (G21)', () => {
  test('whole backup converts with IDs, profiles, plans, checks and exact bodies preserved', () => {
    const m = migrateV1(V1);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const [wires, staging] = m.value.aggregates;
    expect(m.value.activeId).toBe('default');
    expect(wires!.profile).toMatchObject({ id: 'default', name: 'wires', globalHeaders: [{ name: 'Accept', value: 'application/json' }], settings: { bodyCheckKb: 512 } });
    const [acc, payee, form, raw, getBody] = wires!.endpoints;
    expect(acc!.request).toMatchObject({ hostKey: 'api', url: '/api/wires/accounts?RequestID=a%20b+c', credentials: 'include', headers: [{ name: 'Authorization', value: 'Bearer abc' }, { name: 'Accept', value: '', remove: true }] });
    expect(acc!.checks).toEqual([{ kind: 'status', min: 200, max: 299 }, { kind: 'json', path: 'accounts[0].id', mode: 'exists' }]);
    expect(acc!.sample).toMatchObject({ bodyState: 'truncated', source: 'migrated' });
    expect(payee!.request.body).toEqual({ kind: 'json', text: '{ "name" :"A",  "amount":"100.10" }' });
    expect(payee!.checks[0]).toEqual({ kind: 'status', min: 201, max: 201 });
    expect(form!.request.body).toEqual({ kind: 'urlencoded', pairs: [['a', '1'], ['a', '2'], ['b', 'x']] });
    expect(raw!.request.body).toEqual({ kind: 'text', text: 'q=a%20b&r=*' }); // non-canonical encoding kept byte-exact
    expect(raw!.request.headers).toEqual([{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }]);
    expect(getBody!.request).toMatchObject({ hostKey: null, url: 'https://other.example.com/x', body: { kind: 'none' } });
    expect(wires!.plans[0]!.steps).toEqual([
      { endpointId: 'endpoint-1', phase: 'setup' }, { endpointId: 'endpoint-2', phase: 'load' }, { endpointId: 'endpoint-3', phase: 'load' },
      { endpointId: 'endpoint-4', phase: 'load' }, { endpointId: 'endpoint-5', phase: 'skip' }]);
    expect(wires!.legacyRules).toHaveLength(1);
    expect(staging!.profile.name).toBe('staging');
    expect(staging!.plans.map((p) => [p.name, p.strategy, p.mode])).toEqual([['Smoke', 'independent', 'rules']]);
    expect(m.value.notes.join(' ')).toContain('dropped');
    expect(wires!.authContexts).toEqual([]); // never inferred from recorded Authorization headers
    expect(wires!.signingRecipes).toEqual([]);
  });

  test('round-trip: migrated → exported → imported is identical', () => {
    const m = migrateV1(V1);
    if (!m.ok) throw new Error('migration failed');
    const { text } = exportEnvelope('backup', m.value.aggregates, m.value.activeId, true);
    const back = readImport(text);
    expect(back.ok && back.value.aggs).toEqual(m.value.aggregates);
    expect(back.ok && back.value.activeId).toBe('default');
  });

  test('dangling plan, duplicate alias or unknown future schema refuse everything', () => {
    const dangling = structuredClone(V1);
    dangling.savedPlans[0]!.profileId = 'ghost';
    const a = migrateV1(dangling);
    expect(!a.ok && a.errors[0]!.path).toBe('savedPlans.0.profileId');
    const dup = structuredClone(V1);
    dup.endpoints[1]!.alias = 'get_accounts';
    const b = migrateV1(dup);
    expect(!b.ok && b.errors.some((d) => d.path.endsWith('endpoints.1.alias'))).toBe(true);
    expect(migrateV1({ ...V1, schemaVersion: 7 }).ok).toBe(false);
    expect(readImport(JSON.stringify({ format: 'api-workbench', kind: 'backup', schema: 3, profiles: [] })).ok).toBe(false);
    expect(readImport('{not json').ok).toBe(false);
  });
});

test.describe('export redaction and copies', () => {
  test('literal secrets are redacted and block dispatch; source references survive', () => {
    const a = agg((x) => {
      x.profile.globalHeaders = [{ name: 'X-XSRF-TOKEN', value: '{{$cookie("XSRF-TOKEN")}}' }, { name: 'Accept', value: 'application/json' }];
      x.endpoints.push(ep(x, { request: { headers: [{ name: 'Authorization', value: 'Bearer live-secret' }] } }));
    });
    const { agg: r, fields } = redactAggregate(a);
    expect(fields).toEqual([`${a.endpoints[0]!.name}: Authorization`]);
    expect(r.profile.globalHeaders[0]!.value).toBe('{{$cookie("XSRF-TOKEN")}}');
    expect(JSON.stringify(r)).not.toContain('live-secret');
    const p = prepare(r, r.endpoints[0]!, PAGE, { ...none, cookie: () => 'c' }, new Map());
    expect(p.blocked).toEqual(['Header Authorization: value was redacted on export; enter it again']);
  });

  test('Save copy remaps every ID and reference once', () => {
    const a = agg();
    const e = ep(a);
    a.endpoints.push(e);
    a.authContexts.push({ id: 'auth-1', label: 'A', identity: '', audience: 'api', credentials: 'include', headers: [], refresh: { endpointId: e.id, outputs: [], deadlineMs: 1000, readOnlyRetry: false } });
    e.authContextId = 'auth-1';
    a.plans.push({ id: 'pl', name: 'P', strategy: 'flow', mode: 'direct', steps: [{ endpointId: e.id, phase: 'load' }], iterations: 1, concurrency: 1, delayMs: 0, rampUp: false, onFailure: 'continue' });
    const c = copyAggregate(a, 'Copy');
    expect(validateAggregate(c).ok).toBe(true);
    expect(c.profile.id).not.toBe(a.profile.id);
    expect(c.endpoints[0]!.id).not.toBe(e.id);
    expect(c.plans[0]!.steps[0]!.endpointId).toBe(c.endpoints[0]!.id);
    expect(c.authContexts[0]!.refresh!.endpointId).toBe(c.endpoints[0]!.id);
    expect(c.endpoints[0]!.authContextId).toBe(c.authContexts[0]!.id);
  });
});

test.describe('request preparation (G14/G15)', () => {
  test('header precedence: global → endpoint override → removal; empty value is not removal', () => {
    const a = agg((x) => { x.profile.globalHeaders = [{ name: 'X-Test', value: 'global' }, { name: 'Accept', value: 'application/json' }, { name: 'X-Empty', value: 'g' }]; });
    const e = ep(a, { request: { headers: [{ name: 'x-test', value: 'local' }, { name: 'ACCEPT', value: '', remove: true }, { name: 'X-Empty', value: '' }] } });
    const p = prepare(a, e, PAGE, none, new Map());
    expect(p.headers.map((h) => [h.name, h.value, h.from])).toEqual([['x-test', 'local', 'endpoint'], ['X-Empty', '', 'endpoint']]);
  });

  test('environments retarget host keys only; absolute URLs never move; blank origin is this page', () => {
    const a = agg();
    const hosted = ep(a, { request: { query: [['q', 'a b&c'], ['q', '2']] } });
    const absolute = ep(a, { request: { hostKey: null, url: 'https://fixed.test/x?raw=a%20b' } });
    const local = ep(a, { request: { hostKey: 'page', url: '/p' } });
    expect(prepare(a, hosted, PAGE, none, new Map()).url).toBe('https://dev.bank.test/v1/accounts?q=a%20b%26c&q=2');
    expect(prepare(a, local, PAGE, none, new Map()).url).toBe(`${PAGE}/p`);
    a.profile.activeEnvironment = 'stage';
    expect(prepare(a, hosted, PAGE, none, new Map()).url).toMatch(/^https:\/\/stage\.bank\.test\//);
    expect(prepare(a, absolute, PAGE, none, new Map()).url).toBe('https://fixed.test/x?raw=a%20b');
  });

  test('every body kind; exact text; GET body, forbidden header, multipart Content-Type and missing file block', async () => {
    const a = agg();
    const json = ep(a, { request: { method: 'POST', body: { kind: 'json', text: '{ "amount" :"1.10" }' } } });
    const pj = prepare(a, json, PAGE, none, new Map());
    expect(pj.body).toBe('{ "amount" :"1.10" }');
    expect(pj.headers).toContainEqual(expect.objectContaining({ name: 'Content-Type', value: 'application/json', from: 'body' }));
    const form = ep(a, { request: { method: 'POST', body: { kind: 'urlencoded', pairs: [['a', '1'], ['a', '2 3'], ['é', 'ü']] } } });
    expect(String(prepare(a, form, PAGE, none, new Map()).body)).toBe('a=1&a=2+3&%C3%A9=%C3%BC');
    const multi = ep(a, { request: { method: 'POST', body: { kind: 'multipart', parts: [{ kind: 'field', name: 'n', value: 'v' }, { kind: 'file', name: 'doc', fileName: 'r.pdf' }] } } });
    expect(prepare(a, multi, PAGE, none, new Map()).blocked).toEqual(['File for "doc" is not selected (expected r.pdf)']);
    const pm = prepare(a, multi, PAGE, none, new Map([[1, new File(['%PDF'], 'r.pdf', { type: 'application/pdf' })]]));
    expect(pm.blocked).toEqual([]);
    expect((pm.body as FormData).getAll('doc')[0]).toBeInstanceOf(File);
    multi.request.headers.push({ name: 'Content-Type', value: 'multipart/form-data' });
    expect(prepare(a, multi, PAGE, none, new Map()).blocked[0]).toContain('boundaries come from the browser');
    const get = ep(a, { request: { body: { kind: 'text', text: 'x' } } });
    expect(prepare(a, get, PAGE, none, new Map()).blocked).toContain('GET cannot send a body');
    const forbidden = ep(a, { request: { headers: [{ name: 'Cookie', value: 'a' }] } });
    expect(prepare(a, forbidden, PAGE, none, new Map()).blocked).toContain('Header Cookie cannot be set by scripts');
  });

  test('page sources resolve at dispatch and are masked; missing CSRF or unknown expressions block', () => {
    const a = agg((x) => { x.profile.globalHeaders = [{ name: 'X-XSRF-TOKEN', value: '{{$cookie("XSRF-TOKEN")}}' }]; });
    const e = ep(a, { request: { url: '/v1/{{acct.id}}' } });
    const missing = prepare(a, e, PAGE, none, new Map());
    expect(missing.blocked).toEqual(['URL: {{acct.id}} needs the expression engine (not in this build)', 'Header X-XSRF-TOKEN: cookie "XSRF-TOKEN" is not available on this page']);
    e.request.url = '/v1/x';
    let token = 'tok-123456';
    const src = { ...none, cookie: (n: string) => (n === 'XSRF-TOKEN' ? token : undefined) };
    const p1 = prepare(a, e, PAGE, src, new Map());
    expect(p1.blocked).toEqual([]);
    expect(p1.headers[0]).toMatchObject({ value: 'tok-123456', shown: '••••3456 (10 chars)' });
    token = 'rotated-999';
    expect(prepare(a, e, PAGE, src, new Map()).headers[0]!.value).toBe('rotated-999');
  });
});

test.describe('checks (G15)', () => {
  const res = (o: Partial<OnceResult>): OnceResult => ({ outcome: 'response', status: 200, headers: [['content-type', 'application/json']], body: { state: 'complete', text: '{"a":{"b":[1,"x"]},"amt":"100.10"}', bytes: 10 }, ms: 50, ...o });
  test('an intentional 503 expectation passes; JSON path/type/equality; duration', () => {
    const out = evaluate([
      { kind: 'status', min: 503, max: 503 }, { kind: 'json', path: 'a.b[1]', mode: 'equals', value: 'x' }, { kind: 'json', path: 'a.b', mode: 'type', value: 'array' },
      { kind: 'json', path: 'amt', mode: 'equals', value: '100.10' }, { kind: 'json', path: 'a.constructor', mode: 'exists' }, { kind: 'duration', maxMs: 40 }, { kind: 'header', name: 'Content-Type' },
    ], res({ status: 503 }));
    expect(out.map((o) => o.state)).toEqual(['passed', 'passed', 'passed', 'passed', 'failed', 'failed', 'passed']);
  });
  test('a truncated, unreadable or missing body cannot pass body checks', () => {
    const checks = [{ kind: 'body-contains' as const, value: 'a' }, { kind: 'json' as const, path: 'a', mode: 'exists' as const }];
    expect(evaluate(checks, res({ body: { state: 'truncated', text: '{"a"', bytes: 4 } })).map((o) => o.state)).toEqual(['not-evaluated', 'not-evaluated']);
    expect(evaluate([{ kind: 'status', min: 200, max: 299 }], res({ outcome: 'network-error', headers: [] }))[0]!.state).toBe('not-evaluated');
  });
});

test.describe('references and multi-endpoint changes', () => {
  test('alias rename updates exact parsed references only', () => {
    const a = agg();
    const acct = ep(a, { alias: 'acct' }), list = ep(a, { alias: 'acct_list' });
    const user = ep(a, { alias: 'user', request: { method: 'POST', url: '/x/{{acct.id}}/{{ acct_list.id }}', query: [['a', '{{acct}}']], body: { kind: 'json', text: '{"note":"acct.id stays","id":"{{acct.items[0].id}}"}' } } });
    a.endpoints.push(acct, list, user);
    expect(aliasReferences(a, 'acct')).toEqual([{ endpointId: user.id, name: user.name, count: 3 }]);
    expect(renameAliasRefs(a, 'acct', 'account')).toBe(3);
    expect(user.request.url).toBe('/x/{{account.id}}/{{ acct_list.id }}');
    expect(user.request.query).toEqual([['a', '{{account}}']]);
    expect((user.request.body as { text: string }).text).toBe('{"note":"acct.id stays","id":"{{account.items[0].id}}"}');
  });

  test('Promote common: identical non-sensitive headers only; differing auth is not promoted', () => {
    const a = agg();
    const one = ep(a, { request: { headers: [{ name: 'Accept', value: 'application/json' }, { name: 'Authorization', value: 'Bearer a' }, { name: 'X-Api-Key', value: 'same' }] } });
    const two = ep(a, { request: { headers: [{ name: 'accept', value: 'application/json' }, { name: 'Authorization', value: 'Bearer b' }, { name: 'X-Api-Key', value: 'same' }] } });
    const other = ep(a);
    a.endpoints.push(one, two, other);
    const p = promotion(a, [one.id, two.id]);
    expect(p.add).toEqual([{ name: 'Accept', value: 'application/json' }]);
    expect(p.skipped).toEqual(['X-Api-Key not promoted: sensitive literal value']);
    expect(p.alsoAffects).toEqual([other.name]);
  });

  test('body kind changes say what would be lost; lossless conversions keep content', () => {
    expect(convertBody({ kind: 'json', text: '{}' }, 'text')).toEqual({ body: { kind: 'text', text: '{}' }, lost: '' });
    expect(convertBody({ kind: 'urlencoded', pairs: [['a', '1']] }, 'multipart').body).toEqual({ kind: 'multipart', parts: [{ kind: 'field', name: 'a', value: '1' }] });
    expect(convertBody({ kind: 'json', text: '{}' }, 'urlencoded').lost).toBe('the body text');
    expect(convertBody({ kind: 'none' }, 'json').lost).toBe('');
  });

  test('editor validation is scoped to the endpoint and sees the rest of the profile', () => {
    const a = agg();
    const one = ep(a, { alias: 'taken' });
    a.endpoints.push(one);
    const draft = ep(a, { alias: 'taken', name: '' });
    expect(validateEndpointIn(a, draft).map((d) => d.path)).toEqual(['name', 'alias']);
  });
});
