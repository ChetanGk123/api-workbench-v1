// R7 pure assertions: Swagger 2.0, OpenAPI 3.0, Postman v2.1, cURL (bash/cmd) and copied fetch
// adapters, the real Chrome DevTools dialect corpus, refusals with locations, and draft review/apply.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { parseSource, type Format, type Parsed } from '../src/data/importers';
import { applyCandidates, candidatesFromDrafts, rebuildCandidate, type Draft } from '../src/data/review';
import { defaultProfile, newEndpoint, validateAggregate, type Aggregate } from '../src/data/schema';
import { prepare, type Sources } from '../src/tester/once';
import { openapiDoc, postmanDoc, swaggerDoc } from './import-fixtures';

const O = 'http://127.0.0.1:4320';
const PAGE = 'http://page.test';
const none: Sources = { cookie: () => undefined, localStorage: () => undefined, sessionStorage: () => undefined, meta: () => undefined };
const corpus = JSON.parse(readFileSync('tests/fixture/corpus/chrome-154.json', 'utf8')) as {
  version: string; origins: { A: string; B: string };
  cases: { id: string; curlBash: string; curlCmd: string; fetch: string; fetchNode: string }[];
  copyAll: { curlBash: string; curlCmd: string; fetch: string };
};
const A = corpus.origins.A;

type DraftParsed = Extract<Parsed, { drafts: Draft[] }>;
function parsed(text: string, f: Format = 'auto', o: { server?: number } = {}): DraftParsed {
  const r = parseSource(text, f, o);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  if (!('drafts' in r.value)) throw new Error(`not drafts: ${r.value.format}`);
  return r.value;
}
const drafts = (text: string, f: Format = 'auto') => parsed(text, f).drafts;
const errorOf = (text: string, f: Format = 'auto') => { const r = parseSource(text, f); return r.ok ? `ok: ${r.value.format}` : r.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join(' | '); };
const byName = (ds: Draft[], n: string) => ds.find((d) => d.name === n) ?? (() => { throw new Error(`no draft ${n}: ${ds.map((d) => d.name).join(', ')}`); })();
const hdr = (d: Draft, n: string) => d.headers.find(([k]) => k.toLowerCase() === n.toLowerCase())?.[1];
const bodyText = (d: Draft) => { const b = d.bodies[0]?.body; return b && (b.kind === 'text' || b.kind === 'json') ? b.text : undefined; };

/** Commit drafts to a profile the way the UI does, and require the result to validate. */
function commit(agg: Aggregate, ds: Draft[]) {
  const { candidates } = candidatesFromDrafts(agg, ds, PAGE);
  const res = applyCandidates(agg, candidates);
  const v = validateAggregate(res.agg);
  if (!v.ok) throw new Error(JSON.stringify(v.errors.slice(0, 5)));
  return { candidates, res, agg: v.value };
}

test.describe('detection and override (S05.1)', () => {
  test('content decides the family and version; contradictions and unsupported versions are explicit', () => {
    expect(parsed(JSON.stringify(swaggerDoc(O))).format).toBe('swagger');
    expect(parsed(JSON.stringify(openapiDoc(O))).format).toBe('openapi');
    expect(parsed(JSON.stringify(postmanDoc(O))).format).toBe('postman');
    expect(parsed(corpus.cases[0]!.curlBash).format).toBe('curl');
    expect(parsed(corpus.cases[0]!.fetch).format).toBe('fetch');
    expect(parsed(corpus.cases[0]!.curlCmd).label).toBe('cURL (Windows cmd)');
    expect(parsed(corpus.cases[0]!.curlBash).label).toBe('cURL (bash)');
    expect(errorOf(JSON.stringify({ ...openapiDoc(O), openapi: '3.1.0' }))).toContain('OpenAPI 3.1.0 is not supported; this build reads OpenAPI 3.0.x JSON');
    expect(errorOf('openapi: 3.0.0\npaths: {}\n')).toContain('Detected YAML (only JSON documents are supported');
    expect(errorOf(JSON.stringify({ info: { name: 'x' }, requests: [] }))).toContain('Detected Postman collection v1');
    expect(errorOf(JSON.stringify({ swagger: '1.2', apis: [] }))).toContain('Detected Swagger 1.2');
    expect(errorOf(JSON.stringify({ name: 'dev', values: [{ key: 'baseUrl', value: 'x' }], _postman_variable_scope: 'environment' }))).toContain('Detected Postman environment file (variables only, not a collection');
    expect(errorOf(JSON.stringify(postmanDoc(O)), 'swagger')).toBe('Format is set to Swagger 2.0 JSON, but the content looks like Postman collection v2.1');
    expect(errorOf(corpus.cases[0]!.curlBash, 'fetch')).toBe('Format is set to Copied fetch, but the content looks like cURL command');
    expect(errorOf(JSON.stringify({ request: { url: 'x' } }))).toContain('unrecognized content'); // a generic request key is not a format
    expect(errorOf('hello world')).toContain('Not valid JSON, cURL or fetch');
  });
});

test.describe('Swagger 2.0 (G19)', () => {
  const ds = drafts(JSON.stringify(swaggerDoc(O)));
  test('base URL, local refs, repeated query, defaults, auth hints and response examples', () => {
    const list = byName(ds, 'List pets');
    expect(list).toMatchObject({ method: 'GET', url: `${O}/api/pets`, alias: 'listPets', query: [['limit', '10'], ['tags', 'a'], ['tags', 'b']], headers: [['X-Api-Key', '{{$missing("API key key")}}']] });
    expect(list.notes).toContain('Optional query sort has no example and was left out');
    expect(list.requires).toEqual(['Header X-Api-Key: API key (key); enter it or use {{$context("…")}}']);
    expect(list.sample).toMatchObject({ status: 200, source: 'authored', body: '[\n  {\n    "name": "Rex"\n  }\n]' });
    expect(byName(ds, 'Create pet').bodies).toEqual([{ label: 'application/json · schema example', contentType: 'application/json', body: { kind: 'json', text: '{\n  "name": "Rex",\n  "tag": "dog"\n}' } }]);
  });
  test('missing path values block, encoded examples fill, files and unsupported security are required inputs', () => {
    const get = ds.find((d) => d.method === 'GET' && d.url.includes('{{'))!;
    expect(get.url).toBe(`${O}/api/pets/{{$missing("path petId")}}`);
    expect(get.requires).toEqual(['Path petId: the document gives no example; enter a value', 'Security oauth (oauth2 implicit) is not supported; configure an auth context for its token']);
    expect(ds.find((d) => d.method === 'DELETE')).toMatchObject({ url: `${O}/api/pets/p%201`, headers: [], requires: [] }); // security: [] overrides the root
    const up = byName(ds, 'uploadPhoto');
    expect(up.bodies[0]!.body).toEqual({ kind: 'multipart', parts: [{ kind: 'field', name: 'caption', value: 'hi' }, { kind: 'file', name: 'file', fileName: '' }] });
    expect(up.requires).toContain('Choose the file for file when running');
  });
  test('cyclic and remote refs are notes, never fetched or followed; duplicate operationIds are named', () => {
    const p = parsed(JSON.stringify(swaggerDoc(O)));
    expect(p.notes).toEqual(expect.arrayContaining([
      'operationId getPet is used 2 times; aliases get a numeric suffix',
      'paths./loops.post: reference #/definitions/Loop is cyclic or chained more than 8 deep; not followed',
      'paths./remote.get: remote reference https://example.invalid/params.json#/Limit was not fetched',
    ]));
    expect(byName(ds, 'loop').requires).toContain('Request body (application/json): the document has a schema but no example; enter it');
    const { candidates } = commit(defaultProfile(), ds);
    expect(candidates.filter((c) => c.endpoint.alias.startsWith('getPet')).map((c) => c.endpoint.alias)).toEqual(['getPet', 'getPet_2']);
  });
});

test('document limits from DATA: 500 operations, ref chains of 8, Postman folders 16 deep', () => {
  const paths = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`/p${i}`, { get: { responses: {} } }]));
  const big = parsed(JSON.stringify({ swagger: '2.0', host: 'x.test', paths }));
  expect(big.drafts).toHaveLength(500);
  expect(big.skipped).toEqual(['paths./p500.get: more than 500 operations; the rest were not read']);
  const defs = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`D${i}`, i === 9 ? { example: { ok: 1 } } : { $ref: `#/definitions/D${i + 1}` }]));
  const deep = (start: number) => parsed(JSON.stringify({ swagger: '2.0', host: 'x.test', definitions: defs, paths: { '/a': { post: { parameters: [{ name: 'b', in: 'body', required: true, schema: { $ref: `#/definitions/D${start}` } }], responses: {} } } } }));
  expect(deep(2).drafts[0]!.bodies[0]!.body).toEqual({ kind: 'json', text: '{\n  "ok": 1\n}' }); // 8 links
  expect(deep(1).notes).toContain('paths./a.post: reference #/definitions/D9 is cyclic or chained more than 8 deep; not followed'); // 9 links
  let item: object[] = [{ name: 'leaf', request: { method: 'GET', url: 'https://x.test/a' } }];
  for (let i = 0; i < 18; i++) item = [{ name: `f${i}`, item }];
  const nested = parsed(JSON.stringify({ info: { _postman_id: 'n', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [...item, { name: 'top', request: 'https://x.test/top' }] }));
  expect(nested.drafts.map((d) => d.name)).toEqual(['top']);
  expect(nested.skipped[0]).toMatch(/folders nested deeper than 16 levels were not read$/);
});

test.describe('OpenAPI 3.0 (G19)', () => {
  const text = JSON.stringify(openapiDoc(O));
  test('server variables, selectable media examples, deepObject/array query and response samples', () => {
    const p = parsed(text);
    expect(p.servers).toEqual([`${O}/api`, '/relative/api']);
    const create = byName(p.drafts, 'Create order');
    expect(create.bodies.map((b) => b.label)).toEqual(['application/json · example "small"', 'application/json · example "big"', 'application/x-www-form-urlencoded · example']);
    expect(create.bodies[0]!.body).toEqual({ kind: 'json', text: '{\n  "sku": "A1",\n  "qty": 1,\n  "price": "100.10"\n}' });
    expect(create.bodies[2]!.body).toEqual({ kind: 'urlencoded', pairs: [['sku', 'C3'], ['qty', '2']] });
    expect(create.headers).toEqual([]); // security: [] overrides the root requirement
    expect(byName(p.drafts, 'cancelOrder')).toMatchObject({ headers: [['Authorization', 'Bearer {{$missing("bearer token bearer")}}']], requires: ['Path id: the document gives no example; enter a value', 'Authorization: bearer token (bearer); enter it or use {{$context("…")}}, or attach an auth context'] });
    expect(create.sample).toMatchObject({ status: 201, body: '{\n  "id": "o-1",\n  "status": "new"\n}' });
    const list = byName(p.drafts, 'listOrders');
    expect(list.query).toEqual([['status', 'new'], ['status', 'paid'], ['filter[min]', '1'], ['filter[max]', '5'], ['api_key', '{{$missing("API key q")}}']]);
    expect(list.headers).toEqual([['X-Trace', '{{$missing("header X-Trace")}}']]);
    expect(parsed(text, 'auto', { server: 1 }).drafts[0]!.url).toBe('/relative/api/orders');
  });
  test('cookie auth means browser credentials; alternatives, OIDC and schema-only bodies stay unresolved', () => {
    const ds = drafts(text);
    expect(byName(ds, 'getOrder')).toMatchObject({ credentials: 'include', url: `${O}/api/orders/{{$missing("path id")}}` });
    const put = byName(ds, 'replaceOrder');
    expect(put.notes).toContain('Alternative security requirements: oidc or bearer; the first is used');
    expect(put.requires).toEqual(['Path id: the document gives no example; enter a value', 'Security oidc (openIdConnect) is not supported; configure an auth context for its token', 'Request body: the document has a schema but no example; enter it']);
    expect(put.bodies[0]!.body).toEqual({ kind: 'text', text: '{{$missing("request body")}}' });
    const up = byName(ds, 'upload');
    expect(up.bodies[0]!.body).toEqual({ kind: 'multipart', parts: [{ kind: 'field', name: 'title', value: '{{$missing("field title")}}' }, { kind: 'field', name: 'note', value: 'n1' }, { kind: 'file', name: 'doc', fileName: '' }] });
  });
  test('relative server maps to the first host key; choosing another example rebuilds body and content type', () => {
    const agg = defaultProfile();
    const { candidates } = candidatesFromDrafts(agg, parsed(text, 'auto', { server: 1 }).drafts, PAGE);
    const c = candidates.find((x) => x.endpoint.alias === 'createOrder')!;
    expect(c.endpoint.request).toMatchObject({ hostKey: 'default', url: '/relative/api/orders', body: { kind: 'json' } });
    c.bodyIdx = 2;
    c.endpoint.name = 'Renamed';
    rebuildCandidate(agg, c, PAGE);
    expect(c.endpoint.name).toBe('Renamed');
    expect(c.endpoint.request.body).toEqual({ kind: 'urlencoded', pairs: [['sku', 'C3'], ['qty', '2']] });
    expect(c.endpoint.request.headers.find((h) => h.name === 'Content-Type')?.value).toBe('application/x-www-form-urlencoded');
  });
});

test.describe('Postman collection v2.1 (G19)', () => {
  const ds = drafts(JSON.stringify(postmanDoc(O)));
  test('nested auth and variable inheritance; noauth stops it; disabled entries and scripts are visible', () => {
    const get = byName(ds, 'Accounts / Get account');
    expect(get).toMatchObject({ method: 'GET', url: `${O}/api/accounts/ACC-FOLDER`, query: [['expand', '1']], headers: [['X-Trace', 'acct-ACC-FOLDER'], ['X-Bank-Key', '{{$missing("API key X-Bank-Key")}}']] });
    expect(get.notes).toEqual(['This request: test script was not run', 'Disabled query skip was skipped', 'Disabled header X-Off was skipped']);
    expect(get.requires).toEqual(['Header X-Bank-Key: API key (the collection value is not imported); enter it']);
    expect(get.sample).toMatchObject({ status: 200, body: '{"id":"ACC-FOLDER"}' });
    expect(byName(ds, 'Accounts / Public rates')).toMatchObject({ headers: [], requires: [], notes: ['No auth (explicitly set; inherited auth is not applied)'] });
    const p = parsed(JSON.stringify(postmanDoc(O)));
    expect(p.notes).toEqual(expect.arrayContaining(['Collection: variable off is disabled and was not used', 'Collection: prerequest script was not run']));
  });
  test('collection bearer inherited; unknown variables and dynamic ones; raw JSON, form-data files, GraphQL, urlencoded, basic', () => {
    const t = byName(ds, 'Transfers / Create transfer');
    expect(t.headers).toEqual([['Content-Type', 'application/json'], ['Idempotency-Key', '{{$uuid}}'], ['Authorization', 'Bearer {{$missing("bearer token")}}']]);
    expect(bodyText(t)).toBe('{"from":"ACC-9","amount":"10.00","memo":"{{$missing("variable memo")}}"}');
    expect(t.requires).toContain('Variable memo is not defined in the collection; enter its value');
    expect(JSON.stringify(ds)).not.toContain('collection-secret-token');
    expect(JSON.stringify(ds)).not.toContain('folder-secret');
    expect(JSON.stringify(ds)).not.toContain('pw-secret');
    const up = byName(ds, 'Transfers / Upload statement');
    expect(up.bodies[0]!.body).toEqual({ kind: 'multipart', parts: [{ kind: 'field', name: 'kind', value: 'pdf' }, { kind: 'file', name: 'file', fileName: 'statement.pdf' }] });
    expect(up.requires).toContain('Choose the file for file (/Users/someone/statement.pdf is a path on the exporting machine and is never read) when running');
    expect(bodyText(byName(ds, 'Transfers / Search'))).toBe('{"query":"query { accounts { id } }","variables":{"n":1}}');
    const login = byName(ds, 'Transfers / Login form');
    expect(login.bodies[0]!.body).toEqual({ kind: 'urlencoded', pairs: [['user', 'ana'], ['remember', '1']] });
    expect(login.headers).toEqual([['Authorization', 'Basic {{$missing("basic credentials")}}']]);
    const hawk = byName(ds, 'Transfers / Signed (hawk)');
    expect(hawk.url).toBe('https://{{$missing("variable otherBase")}}/api/signed');
    expect(hawk.requires).toEqual(['Postman hawk auth is not supported; configure an auth context or headers before sending', 'Variable otherBase is not defined in the collection; enter its value']);
  });
  test('the commit validates; markers block Once with their label; rotating headers are flagged', () => {
    const { agg, res } = commit(defaultProfile(), ds);
    expect(res.added).toBe(7);
    const hawk = agg.endpoints.find((e) => e.name === 'Transfers / Signed (hawk)')!;
    expect(prepare(agg, hawk, PAGE, none, new Map()).blocked.join(' ')).toContain('variable otherBase: not supplied by the import; enter it before sending');
    const rates = agg.endpoints.find((e) => e.name === 'Accounts / Public rates')!;
    expect(prepare(agg, rates, PAGE, none, new Map()).blocked).toEqual([]);
  });
});

test.describe(`real DevTools dialect corpus, Chrome ${corpus.version} (G19)`, () => {
  const cases = new Map(corpus.cases.map((c) => [c.id, c]));
  const each = (id: string) => (['curlBash', 'curlCmd', 'fetch', 'fetchNode'] as const).map((k) => [k, drafts(cases.get(id)![k])[0]!] as const);

  test('every copy of every case parses to one request with the method, URL and query that was sent', () => {
    const sent: Record<string, [string, string, [string, string][]]> = {
      'get-query-unicode': ['GET', `${A}/api/echo`, [['q', 'café'], ['tag', 'a'], ['tag', 'b'], ['empty', '']]],
      'post-json-escapes': ['POST', `${A}/api/echo`, []],
      'post-urlencoded': ['POST', `${A}/api/echo`, []],
      'post-multipart': ['POST', `${A}/api/echo`, []],
      'put-glob-cmd-chars': ['PUT', `${A}/api/echo/items[1]/%7Bid%7D`, [['a', '1'], ['b', '%PATH%']]],
      'auth-and-empty-header': ['GET', `${A}/api/echo`, []],
      'delete-cross-origin-credentials': ['DELETE', `${corpus.origins.B}/api/echo/7`, []],
      'patch-json-no-ct': ['PATCH', `${A}/api/echo/7`, []],
    };
    for (const c of corpus.cases) {
      for (const k of ['curlBash', 'curlCmd', 'fetch', 'fetchNode'] as const) {
        const p = parsed(c[k]);
        expect(p.drafts, `${c.id} ${k}`).toHaveLength(1);
        const d = p.drafts[0]!;
        expect([d.method, d.url, d.query], `${c.id} ${k}`).toEqual(sent[c.id]);
        expect(hdr(d, 'x-corpus'), `${c.id} ${k}`).toBe(c.id);
        for (const [name] of d.headers) expect(name.toLowerCase(), `${c.id} ${k}`).not.toMatch(/^(sec-|cookie$|referer$|origin$|connection$|user-agent$)/);
      }
    }
  });

  test('bodies are byte-exact from bash and fetch; cmd differences are DevTools losses that are named', () => {
    const json = '{"text":"line1\\nline2\\ttab \\"dq\\" \'sq\' back\\\\slash $HOME !bang %PATH% ^caret &amp","emoji":"😀","n":1.1}';
    for (const [k, d] of each('post-json-escapes')) {
      expect(d.bodies[0]!.body, k).toEqual({ kind: 'json', text: k === 'curlCmd' ? json.replace('😀', '  ') : json });
      expect(d.credentials, k).toBe('include');
    }
    const cmd = drafts(cases.get('post-json-escapes')!.curlCmd)[0]!;
    expect(cmd.notes).toEqual(expect.arrayContaining([
      'Windows cmd copy: 2 character(s) were written as "^ " — DevTools replaces non-ASCII text with spaces in cmd copies. Check text values, or use the bash or fetch copy.',
      'Windows cmd copy: doubled backslashes were halved to recover the copied request, as DevTools doubles them (running the command in cmd would send them doubled)',
    ]));
    for (const [k, d] of each('put-glob-cmd-chars')) {
      expect(bodyText(d), k).toBe('plain & simple | 50% <ok> "q" \\ end');
      expect(hdr(d, 'x-odd'), k).toBe('100% ^ & | < > "q"');
    }
    for (const [k, d] of each('get-query-unicode')) expect(hdr(d, 'x-note'), k).toBe(k === 'curlCmd' ? 'na ve caf' : 'naïve café');
    for (const [k, d] of each('patch-json-no-ct')) expect(d.bodies[0], k).toEqual({ label: k.startsWith('curl') ? 'data' : 'body', contentType: 'text/plain;charset=UTF-8', body: { kind: 'text', text: '{"op":"set","v":true}' } });
  });

  test('forms, raw multipart, secrets, empty headers and credentials', () => {
    for (const [k, d] of each('post-urlencoded')) {
      expect(d.bodies[0]!.body, k).toEqual({ kind: 'urlencoded', pairs: [['a', '1'], ['b', 'two words'], ['c', '&='], ['password', '{{$redacted}}']] });
      expect(d.requires, k).toEqual(['Form password: the source value is a secret and was not imported; enter it or use {{$context("…")}}']);
    }
    for (const [k, d] of each('post-multipart')) {
      if (k === 'curlCmd') { expect(d.requires[0]).toContain('Multipart body has no CRLF line ends (the copy dropped them)'); continue; }
      expect(bodyText(d), k).toMatch(/^------WebKitFormBoundary\w+\r\nContent-Disposition: form-data; name="title"\r\n\r\nRésumé & notes\r\n/);
      expect(d.bodies[0]!.contentType, k).toMatch(/^multipart\/form-data; boundary=----WebKitFormBoundary/);
    }
    for (const [k, d] of each('auth-and-empty-header')) {
      expect(hdr(d, 'authorization'), k).toBe('{{$redacted}}');
      expect(hdr(d, 'x-empty'), k).toBe('');
      expect(JSON.stringify(d), k).not.toContain('sekrit-token-123');
    }
    for (const c of corpus.cases) for (const k of ['curlBash', 'curlCmd', 'fetchNode'] as const) expect(JSON.stringify(drafts(c[k])), `${c.id} ${k}`).not.toContain('s3cr3t-session');
    expect(each('delete-cross-origin-credentials').map(([, d]) => d.credentials)).toEqual(['same-origin', 'same-origin', 'omit', 'same-origin']);
  });

  test('"Copy all" in each dialect gives independent candidates; every corpus request commits valid', () => {
    for (const k of ['curlBash', 'curlCmd', 'fetch'] as const) expect(drafts(corpus.copyAll[k]).map((d) => hdr(d, 'x-corpus')), k).toEqual(['get-query-unicode', 'post-json-escapes', 'post-urlencoded']);
    const all = corpus.cases.flatMap((c) => (['curlBash', 'curlCmd', 'fetch', 'fetchNode'] as const).flatMap((k) => drafts(c[k])));
    const { res, agg } = commit(defaultProfile(), all);
    expect(res.added).toBe(32);
    expect(agg.endpoints.every((e) => e.request.hostKey === null)).toBe(true);
  });
});

test.describe('refusals: nothing is executed, read or expanded (G19)', () => {
  test('shell syntax, variables and files in cURL are refused with a location', () => {
    expect(errorOf("curl 'https://x.test/a' -H \"X-A: $(whoami)\"")).toBe('line 1, column 34: $ inside double quotes is a variable or substitution; it is not expanded. Nothing was run.');
    expect(errorOf('curl https://x.test/`id`')).toBe('line 1, column 21: "`" is shell syntax and is not supported. Nothing was run.');
    expect(errorOf("curl 'https://x.test/a' | sh")).toContain('line 1, column 25: "|" is shell syntax');
    expect(errorOf("curl 'https://x.test/a' && rm -rf /")).toContain('&& joins commands into a script');
    expect(errorOf('curl $URL')).toContain('$ outside quotes is a variable');
    expect(errorOf("curl 'https://x.test/a' \\\n  --proxy 'http://p:1'")).toBe('Command 1: --proxy at line 2, column 3: Proxies cannot be used from a page; not imported');
    expect(errorOf("curl 'https://x.test/a' --upload-file ./x")).toContain('File upload by path is not supported');
    expect(errorOf("curl 'https://x.test/a' --frobnicate")).toBe('Command 1: unsupported option --frobnicate at line 1, column 25; not imported');
    expect(errorOf('curl ^"https://x.test/%PATH%^"', 'curl-cmd')).toBe('line 1, column 23: %VARIABLE% expansion is not supported. Nothing was run.');
    expect(errorOf('curl ^"https://x.test/a^" | more', 'curl-cmd')).toContain('is a pipe or redirect');
  });
  test('files are named requirements, never read; -u, -G, --data-urlencode, -F and several commands', () => {
    const ds = drafts([
      "curl 'https://x.test/up' -F 'meta=hello' -F 'doc=@/etc/passwd;type=text/plain' -F 'cfg=</etc/hosts' -u 'ana:pw'",
      "curl 'https://x.test/q' -G --data-urlencode 'q=a b&c' -d 'n=1'",
      "curl 'https://x.test/raw' --data-binary @body.json -H 'Content-Type: application/json'",
    ].join('\n'));
    expect(ds).toHaveLength(3);
    expect(ds[0]!.bodies[0]!.body).toEqual({ kind: 'multipart', parts: [{ kind: 'field', name: 'meta', value: 'hello' }, { kind: 'file', name: 'doc', fileName: 'passwd' }, { kind: 'field', name: 'cfg', value: '{{$missing("file contents for cfg")}}' }] });
    expect(ds[0]!.requires).toEqual(['Choose the file for doc (/etc/passwd is never read) when running', 'Field cfg reads /etc/hosts as its value; files are never read; enter it', 'Authorization: -u credentials for ana are not imported; enter base64 user:password']);
    expect(JSON.stringify(ds[0])).not.toContain('pw');
    expect(ds[1]).toMatchObject({ method: 'GET', query: [['q', 'a b&c'], ['n', '1']], bodies: [] });
    expect(ds[2]!.bodies[0]!.body).toEqual({ kind: 'json', text: '{{$missing("file body.json")}}' });
  });
  test('copied fetch accepts literals only', () => {
    expect(errorOf('fetch(url, {})')).toBe('line 1, column 7: The URL must be a string literal. Nothing was run.');
    expect(errorOf('fetch("https://x.test/a", { body: JSON.stringify({a:1}) })')).toBe('line 1, column 35: JSON… is code (a call or property access); only literal values are accepted. Nothing was run.');
    expect(errorOf('fetch("https://x.test/a", { headers: h })')).toContain('h is a variable; only literal values are accepted');
    expect(errorOf('fetch(`https://x.test/${id}`)')).toContain('Template literals can interpolate code');
    expect(errorOf('fetch("https://x.test/a", { body: new FormData() })')).toContain('new … constructs an object in code');
    expect(errorOf('fetch("https://x.test/a", { method })')).toContain('method without a value is a variable reference');
    expect(errorOf('fetch("https://x.test/a").then(r => r.json())')).toContain('.then()/.catch() are code');
    expect(errorOf('fetch("https://x.test/a", { ...opts })')).toContain('Spread is code');
    expect(errorOf('fetch("https://x.test/a", { "__proto__": {} })')).toContain('Key __proto__ is not allowed');
    const d = drafts("await fetch('https://x.test/a?k=1', { method: 'post', headers: [['X-A', '\\u00e9\\x41']], body: 'a\\nb', cache: 'no-cache', keepalive: true, mode: 'no-cors' });")[0]!;
    expect(d).toMatchObject({ method: 'POST', query: [['k', '1']], headers: [['X-A', 'éA']] });
    expect(bodyText(d)).toBe('a\nb');
    expect(d.notes).toEqual(expect.arrayContaining(['cache is not represented (sends use no-store)', 'keepalive is not represented', 'mode "no-cors" is not represented; the request is sent as cors and the response is readable only if the server allows it']));
  });
});

test.describe('draft review against the destination (S05.2, G20)', () => {
  test('identity, not name, finds conflicts; alias collisions get a suffix; Replace keeps the saved ID', () => {
    const agg = defaultProfile();
    const e = newEndpoint(agg);
    e.alias = 'createPet';
    e.request = { ...e.request, method: 'GET', hostKey: null, url: `${O}/api/pets`, query: [['limit', '10'], ['tags', 'a'], ['tags', 'b']], headers: [] };
    agg.endpoints.push(e);
    const ds = drafts(JSON.stringify(swaggerDoc(O)));
    const { candidates } = candidatesFromDrafts(agg, ds, PAGE);
    // Different names, same method/origin/path/query/body: the same request (headers are not identity).
    const list = candidates.find((c) => c.endpoint.name === 'List pets')!;
    expect(list.conflict).toEqual({ id: e.id, name: 'Endpoint 1' });
    expect(list.action).toBe('skip');
    expect(candidates.find((c) => c.endpoint.name === 'Create pet')!.endpoint.alias).toBe('createPet_2'); // alias collision is naming, not identity
    const other = candidatesFromDrafts(agg, [{ ...ds[0]!, query: [['limit', '20']] }], PAGE).candidates[0]!;
    expect(other.conflict).toBeNull(); // a different query constraint is a different request
    list.action = 'replace';
    const res = applyCandidates(agg, [list]);
    expect(res.replaced).toBe(1);
    expect(res.agg.endpoints.find((x) => x.id === e.id)!.alias).toBe('createPet');
  });
  test('same method and path with different bodies stay distinct variants; nothing is merged', () => {
    const ds = drafts([`curl '${A}/api/echo' --data-raw 'a=1'`, `curl '${A}/api/echo' --data-raw 'a=2'`].join(' ;\n'));
    const { candidates } = candidatesFromDrafts(defaultProfile(), ds, PAGE);
    expect(candidates.map((c) => c.variant)).toEqual(['variant 1 of 2 (same method and path)', 'variant 2 of 2 (same method and path)']);
    expect(candidates.map((c) => c.endpoint.request.body)).toEqual([{ kind: 'urlencoded', pairs: [['a', '1']] }, { kind: 'urlencoded', pairs: [['a', '2']] }]);
  });
});
