// R3 pure assertions: detection, HAR adapter, capture redaction, grouping/conflicts, apply and native merge.
import { expect, test } from '@playwright/test';
import { exportEnvelope } from '../src/data/backup';
import { capturesToHar, parseSource } from '../src/data/importers';
import {
  applyCandidates, candidatesFromCaptures, candidatesFromNative, dependencySuggestions, mergeNative, rebuildCandidate, type Candidate,
} from '../src/data/review';
import { defaultProfile, newEndpoint, validateAggregate, type Aggregate } from '../src/data/schema';
import { redactText, requestBody, type Capture } from '../src/net/capture';

const PAGE = 'http://page.test';
type Entry = { method?: string; url: string; headers?: [string, string][]; postData?: object; response?: object | null; time?: number };
const har = (entries: Entry[], version = '1.2') => JSON.stringify({
  log: {
    version, creator: { name: 'WebInspector', version: '537.36' },
    entries: entries.map((e, i) => ({
      startedDateTime: new Date(1_700_000_000_000 + i * 1000).toISOString(), time: e.time ?? 12,
      request: { method: e.method ?? 'GET', url: e.url, headers: (e.headers ?? []).map(([name, value]) => ({ name, value })), ...(e.postData && { postData: e.postData }) },
      ...(e.response !== null && { response: e.response ?? { status: 200, headers: [{ name: 'Content-Type', value: 'application/json' }], content: { mimeType: 'application/json', text: '{"ok":true}' } } }),
    })),
  },
});
function calls(text: string): Capture[] {
  const r = parseSource(text, 'auto');
  if (!r.ok || r.value.format !== 'har') throw new Error(JSON.stringify(r));
  return r.value.captures;
}
const build = (a: Aggregate, text: string, group = true) => candidatesFromCaptures(a, calls(text), { group, pageOrigin: PAGE });

test.describe('detection (S05.1)', () => {
  test('content decides the format; empty documents are refused with the reason', () => {
    const msg = (t: string) => { const r = parseSource(t, 'auto'); return r.ok ? r.value.format : r.errors[0]!.message; };
    expect(msg(har([{ url: `${PAGE}/a` }]))).toBe('har');
    expect(msg(JSON.stringify({ swagger: '2.0', paths: {} }))).toBe('The document has no operations');
    expect(msg(JSON.stringify({ openapi: '3.0.3', paths: {} }))).toBe('The document has no operations');
    expect(msg(JSON.stringify({ info: { _postman_id: 'x', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [] }))).toBe('The collection has no requests');
    expect(msg("curl 'https://x.test/a' -H 'x: 1'")).toBe('curl');
    expect(msg('fetch("https://x.test/a", {})')).toBe('fetch');
    expect(msg('{"request": {"url": "x"}}')).toContain('unrecognized content'); // a generic "request" key is not a format
    expect(msg('')).toContain('Paste or choose');
  });

  test('override contradiction, versions and limits refuse with the reason', () => {
    const r = parseSource(har([{ url: `${PAGE}/a` }]), 'native');
    expect(r.ok ? '' : r.errors[0]!.message).toBe('Format is set to API Workbench export, backup or schema 1 JSON, but the content looks like HAR 1.2');
    const v = parseSource(har([{ url: `${PAGE}/a` }], '1.3'), 'auto');
    expect(v.ok ? '' : v.errors[0]!.message).toContain('HAR version 1.3 is not supported');
    const big = parseSource(har(Array.from({ length: 1001 }, () => ({ url: `${PAGE}/a` }))), 'auto');
    expect(big.ok ? '' : big.errors[0]!.message).toContain('at most 1000');
    const env = JSON.parse(exportEnvelope('profile', [defaultProfile()], '', false).text);
    env.schema = 3;
    const fut = parseSource(JSON.stringify(env), 'auto');
    expect(fut.ok ? '' : fut.errors[0]!.message).toContain('newer than this build supports');
    expect(parseSource('x'.repeat(10 * 1024 * 1024 + 1), 'auto').ok).toBe(false);
  });
});

test.describe('HAR adapter and candidates (G19 HAR)', () => {
  test('same URL with different bodies stays separate; identical calls group with a count', () => {
    const post = (amount: string) => ({ method: 'POST', url: `${PAGE}/api/transfer`, headers: [['Content-Type', 'application/json']] as [string, string][], postData: { mimeType: 'application/json', text: `{"amount":"${amount}"}` } });
    const { candidates } = build(defaultProfile(), har([post('1'), post('2'), post('1')]));
    expect(candidates.map((c) => [c.members.length, (c.endpoint.request.body as { text: string }).text, c.variant])).toEqual([
      [2, '{"amount":"1"}', 'variant 1 of 2 (different query or body)'],
      [1, '{"amount":"2"}', 'variant 2 of 2 (different query or body)'],
    ]);
    expect(candidates[0]!.endpoint.request).toMatchObject({ method: 'POST', hostKey: 'default', url: '/api/transfer', body: { kind: 'json' } });
    const ungrouped = build(defaultProfile(), har([post('1'), post('2'), post('1')]), false);
    expect(ungrouped.candidates).toHaveLength(3);
  });

  test('different queries stay separate; cache-busters do not split groups and can be removed', () => {
    const { candidates } = build(defaultProfile(), har([
      { url: `${PAGE}/api/list?page=1&_=1700000000111` }, { url: `${PAGE}/api/list?page=1&_=1700000000222` }, { url: `${PAGE}/api/list?page=2` },
      { url: `${PAGE}/api/list?t=hi` }, { url: `${PAGE}/api/list?t=bye` }, // a word is a real constraint, not a cache-buster
    ]));
    expect(candidates.map((c) => c.members.length)).toEqual([2, 1, 1, 1]);
    expect(candidates[2]!.transient).toEqual([]);
    const c = candidates[0]!;
    expect(c.transient).toEqual(['_']);
    c.dropQuery = ['_'];
    rebuildCandidate(defaultProfile(), c, PAGE);
    expect(c.endpoint.request.query).toEqual([['page', '1']]);
  });

  test('base64, missing response, restricted and sensitive headers, GET body', () => {
    const b64 = Buffer.from('héllo ✓').toString('base64');
    const text6 = har([
      { url: `${PAGE}/api/text`, response: { status: 200, headers: [], content: { mimeType: 'text/plain', text: b64, encoding: 'base64' } } },
      { url: `${PAGE}/api/bin`, response: { status: 200, headers: [], content: { mimeType: 'image/png', text: 'iVBORw0K', encoding: 'base64' } } },
      { url: `${PAGE}/api/pending`, response: null },
      { url: `${PAGE}/api/secure?access_token=zz-query-secret&x=1`, headers: [[':authority', 'page.test'], ['Cookie', 'session=1'], ['Host', 'page.test'], ['Authorization', 'Bearer live'], ['X-Idempotency-Key', 'k-1'], ['X-Trace', 't']] },
      { method: 'GET', url: `${PAGE}/api/getbody`, postData: { mimeType: 'text/plain', text: 'ignored' } },
      { url: 'ftp://page.test/file' },
    ]);
    const parsed = parseSource(text6, 'auto');
    expect(parsed.ok && parsed.value.format === 'har' && parsed.value.skipped).toEqual(['Entry 6: ftp: requests are not HTTP calls']);
    const { candidates } = build(defaultProfile(), text6);
    const [text, bin, pending, secure, getbody] = candidates;
    expect(text!.endpoint.sample).toMatchObject({ status: 200, body: 'héllo ✓', bodyState: 'complete', source: 'captured' });
    expect(bin!.endpoint.sample).toMatchObject({ body: '', bodyState: 'truncated' });
    expect(bin!.notes.join()).toContain('Base64 image/png response is not imported as text');
    expect(pending!.endpoint.sample).toBeUndefined();
    expect(pending!.notes.join()).toContain('Response missing or unfinished');
    const r = secure!.endpoint.request;
    expect(r.headers).toEqual([{ name: 'Authorization', value: '{{$redacted}}' }, { name: 'X-Idempotency-Key', value: 'k-1' }, { name: 'X-Trace', value: 't' }]);
    expect(r.query).toEqual([['access_token', '{{$redacted}}'], ['x', '1']]);
    expect(secure!.notes.join('|')).toContain('Header Host is set by the browser');
    expect(secure!.notes.join('|')).toContain('replay uses this browser’s cookies');
    expect(secure!.requires.join('|')).toContain('Header Authorization: enter a fresh value');
    expect(secure!.requires.join('|')).toContain('X-Idempotency-Key looks per-request');
    expect(getbody!.endpoint.request.body).toEqual({ kind: 'none' });
    expect(JSON.stringify(candidates)).not.toContain('Bearer live');
    expect(JSON.stringify(candidates)).not.toContain('zz-query-secret');
  });

  test('multipart files and urlencoded params; timing stays provenance, never a check', () => {
    const { candidates } = build(defaultProfile(), har([
      { method: 'POST', url: `${PAGE}/api/upload`, postData: { mimeType: 'multipart/form-data; boundary=x', params: [{ name: 'memo', value: 'hi' }, { name: 'doc', fileName: 'a.pdf', contentType: 'application/pdf' }] }, time: 432 },
      { method: 'POST', url: `${PAGE}/api/form`, postData: { mimeType: 'application/x-www-form-urlencoded', params: [{ name: 'a', value: '1' }, { name: 'password', value: 'pw' }] } },
    ]));
    expect(candidates[0]!.endpoint.request.body).toEqual({ kind: 'multipart', parts: [{ kind: 'field', name: 'memo', value: 'hi' }, { kind: 'file', name: 'doc', fileName: 'a.pdf' }] });
    expect(candidates[0]!.requires.join()).toContain('Choose the file for doc');
    expect(candidates[0]!.endpoint.provenance).toContain('432 ms observed');
    expect(candidates[0]!.endpoint.checks).toEqual([{ kind: 'status', min: 200, max: 299 }]);
    expect(candidates[1]!.endpoint.request.body).toEqual({ kind: 'urlencoded', pairs: [['a', '1'], ['password', '{{$redacted}}']] });
  });

  test('duplicates of saved endpoints default to Skip; Replace keeps ID and alias; result validates', () => {
    const a = defaultProfile();
    const saved = newEndpoint(a);
    Object.assign(saved, { name: 'Saved list', alias: 'saved_list' });
    saved.request.url = '/api/list';
    a.endpoints.push(saved);
    const { candidates } = build(a, har([{ url: `${PAGE}/api/list` }, { url: `${PAGE}/api/other` }, { url: `https://elsewhere.test/api/list` }]));
    expect(candidates.map((c) => [c.conflict?.name ?? null, c.action, c.endpoint.request.hostKey])).toEqual([['Saved list', 'skip', 'default'], [null, 'keep', 'default'], [null, 'keep', null]]);
    let r = applyCandidates(a, candidates);
    expect([r.added, r.replaced, r.skipped]).toEqual([2, 0, 1]);
    candidates[0]!.action = 'replace';
    r = applyCandidates(a, candidates);
    expect([r.added, r.replaced, r.skipped]).toEqual([2, 1, 0]);
    const replaced = r.agg.endpoints.find((e) => e.id === saved.id)!;
    expect(replaced).toMatchObject({ alias: 'saved_list', sample: { status: 200, source: 'captured' } });
    expect(validateAggregate(r.agg).ok).toBe(true);
    expect(a.endpoints).toHaveLength(1); // input untouched
    candidates.forEach((c) => { c.selected = false; });
    expect(applyCandidates(a, candidates).added).toBe(0);
  });

  test('recorder HAR export reads back to the same candidates', () => {
    const caps = calls(har([{ method: 'POST', url: `${PAGE}/api/x?q=1`, headers: [['Content-Type', 'application/json'], ['Authorization', 'Bearer t']], postData: { mimeType: 'application/json', text: '{"a":1}' } }]));
    const again = calls(capturesToHar(caps, 'test'));
    const strip = (c: Candidate[]) => c.map((x) => ({ ...x.endpoint, id: '', createdAt: 0, updatedAt: 0, provenance: '' }));
    expect(strip(candidatesFromCaptures(defaultProfile(), again, { group: true, pageOrigin: PAGE }).candidates)).toEqual(strip(candidatesFromCaptures(defaultProfile(), caps, { group: true, pageOrigin: PAGE }).candidates));
  });

  test('dependency suggestions are suggestions only', () => {
    const { candidates } = build(defaultProfile(), har([
      { method: 'POST', url: `${PAGE}/api/orders`, response: { status: 201, headers: [], content: { mimeType: 'application/json', text: '{"order":{"id":"ord_12345678"}}' } } },
      { url: `${PAGE}/api/orders/status?id=ord_12345678` },
    ]));
    const s = dependencySuggestions(candidates);
    expect(s).toHaveLength(1);
    expect(s[0]!.text).toContain('query id contains /api/orders response order.id');
    expect(candidates[1]!.endpoint.request.query).toEqual([['id', 'ord_12345678']]);
  });
});

test.describe('capture redaction (G18 redaction)', () => {
  test('JSON keys, truncated JSON and form strings are redacted; clean text stays exact', () => {
    const c = { redacted: [] as string[], notes: [] as string[] };
    expect(redactText('{ "a" : 1 }', 'application/json', c, 'Body')).toBe('{ "a" : 1 }');
    expect(redactText('{"user":{"password":"pw","name":"n"}}', 'application/json', c, 'Body')).toBe('{"user":{"password":"{{$redacted}}","name":"n"}}');
    expect(redactText('{"access_token":"abcdef","refresh_token":"ghi', 'application/json', c, 'Response body')).toBe('{"access_token":"{{$redacted}}","refresh_token":"{{$redacted}}"');
    expect(c.redacted).toEqual(['Body field password', 'Response body field access_token', 'Response body field refresh_token']);
    expect(requestBody('a=1&token=x', 'application/x-www-form-urlencoded', c)).toEqual({ kind: 'urlencoded', pairs: [['a', '1'], ['token', '{{$redacted}}']] });
    expect(requestBody(new Blob(['x']), '', c)).toEqual({ kind: 'omitted', reason: 'Binary request body (Blob/ArrayBuffer) is not captured' });
    expect(requestBody('x'.repeat(70 * 1024), 'text/plain', c)).toMatchObject({ kind: 'omitted' });
  });
});

test.describe('native merge (G20)', () => {
  function incoming(): Aggregate {
    const a = defaultProfile('Incoming');
    a.profile.environments = { default: { default: '', api: 'https://api.test' } };
    const login = newEndpoint(a);
    Object.assign(login, { id: 'ep-shared', name: 'Login', alias: 'login' });
    login.request.url = '/api/login';
    const me = newEndpoint(a);
    Object.assign(me, { id: 'ep-me', name: 'Me', alias: 'me' });
    me.request = { ...me.request, hostKey: 'api', url: '/me', headers: [{ name: 'X-From', value: '{{login.token}}' }] };
    a.endpoints.push(login, me);
    a.authContexts.push({ id: 'auth-1', label: 'Session', identity: '', audience: 'api', credentials: 'include', headers: [], refresh: { endpointId: 'ep-shared', outputs: [], deadlineMs: 1000, readOnlyRetry: false } });
    me.authContextId = 'auth-1';
    a.plans.push({ id: 'plan-1', name: 'Flow', strategy: 'flow', mode: 'direct', steps: [{ endpointId: 'ep-shared', phase: 'setup' }, { endpointId: 'ep-me', phase: 'load' }], iterations: 1, concurrency: 1, delayMs: 0, rampUp: false, onFailure: 'stop' });
    a.profile.globalHeaders = [{ name: 'Accept', value: 'application/json' }];
    return a;
  }

  test('colliding IDs and aliases are remapped once; references follow; the result validates', () => {
    const cur = defaultProfile('Current');
    const other = newEndpoint(cur);
    Object.assign(other, { id: 'ep-shared', name: 'Other', alias: 'login' });
    other.request.url = '/api/other';
    cur.endpoints.push(other);
    const cands = candidatesFromNative(cur, incoming(), PAGE);
    expect(cands.map((c) => c.conflict)).toEqual([null, null]);
    const r = mergeNative(cur, incoming(), cands);
    expect(validateAggregate(r.agg)).toMatchObject({ ok: true });
    const login = r.agg.endpoints.find((e) => e.name === 'Login')!;
    const me = r.agg.endpoints.find((e) => e.name === 'Me')!;
    expect(login.id).not.toBe('ep-shared');
    expect(login.alias).toBe('login_2');
    expect(me.request.headers[0]!.value).toBe('{{login_2.token}}');
    expect(r.agg.plans[0]!.steps.map((s) => s.endpointId)).toEqual([login.id, me.id]);
    expect(r.agg.authContexts[0]!.refresh!.endpointId).toBe(login.id);
    expect(me.authContextId).toBe(r.agg.authContexts[0]!.id);
    expect(r.agg.profile.environments.default!.api).toBe('https://api.test');
    expect(r.agg.profile.globalHeaders).toEqual([{ name: 'Accept', value: 'application/json' }]);
    expect(r.agg.endpoints.find((e) => e.id === 'ep-shared')!.name).toBe('Other'); // existing unchanged
    expect([r.added, r.replaced, r.skipped]).toEqual([2, 0, 0]);
  });

  test('Skip maps references to the saved equivalent; deselected endpoints drop their plan steps with a note', () => {
    const cur = defaultProfile('Current');
    const same = newEndpoint(cur);
    Object.assign(same, { name: 'My login', alias: 'my_login' });
    same.request.url = '/api/login';
    cur.endpoints.push(same);
    const cands = candidatesFromNative(cur, incoming(), PAGE);
    expect(cands[0]).toMatchObject({ conflict: { id: same.id }, action: 'skip' });
    let r = mergeNative(cur, incoming(), cands);
    expect(validateAggregate(r.agg).ok).toBe(true);
    expect(r.agg.plans[0]!.steps[0]!.endpointId).toBe(same.id);
    expect([r.added, r.skipped]).toEqual([1, 1]);
    cands[1]!.selected = false;
    r = mergeNative(cur, incoming(), cands);
    expect(validateAggregate(r.agg).ok).toBe(true);
    expect(r.notes.join('|')).toContain("Plan Flow: a step's endpoint was not imported");
  });
});
