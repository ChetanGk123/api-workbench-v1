// Portable schema 2: durable entities and their runtime validators. Pure: no DOM, no storage.
// Validators rebuild a clean value from untrusted input (unknown fields dropped, prototype keys
// rejected) and report every problem with a field path. TypeScript types are not validation.

export const SCHEMA = 2;
export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type Method = (typeof METHODS)[number];
export const CREDENTIALS = ['same-origin', 'include', 'omit'] as const;
export type Credentials = (typeof CREDENTIALS)[number];

export interface Header { name: string; value: string; /** Endpoint rows only: drop an inherited global header. */ remove?: boolean }
export type Pair = [name: string, value: string];
export type Part = { kind: 'field'; name: string; value: string } | { kind: 'file'; name: string; /** Hint only; the file is chosen at run time. */ fileName: string };
export type Body =
  | { kind: 'none' }
  | { kind: 'text'; text: string }
  | { kind: 'json'; text: string }
  | { kind: 'urlencoded'; pairs: Pair[] }
  | { kind: 'multipart'; parts: Part[] };
export type BodyKind = Body['kind'];

export interface RequestTemplate {
  method: Method;
  /** Environment host key, or null for an absolute URL that environments never retarget. */
  hostKey: string | null;
  /** Path (with hostKey) or absolute URL. May carry a verbatim raw query; `query` pairs are appended. */
  url: string;
  query: Pair[];
  headers: Header[];
  credentials: Credentials;
  body: Body;
}

export type Check =
  | { kind: 'status'; min: number; max: number }
  | { kind: 'header'; name: string; value?: string }
  | { kind: 'body-contains'; value: string }
  | { kind: 'json'; path: string; mode: 'exists' | 'equals' | 'type'; value?: string }
  | { kind: 'duration'; maxMs: number };

export interface Sample {
  status: number;
  headers: Pair[];
  body: string;
  bodyState: 'complete' | 'truncated' | 'redacted';
  /** captured = observed response; authored = typed or edited by a person; migrated = schema 1 sample. */
  source: 'captured' | 'authored' | 'migrated';
  at?: number;
}

export interface Endpoint {
  id: string;
  name: string;
  alias: string;
  request: RequestTemplate;
  checks: Check[];
  sample?: Sample;
  authContextId?: string;
  signingRecipeId?: string;
  provenance: string;
  createdAt: number;
  updatedAt: number;
}

/** Where a runtime value is read at dispatch. Definitions are stored; values never are. */
export interface SourceRef { kind: 'cookie' | 'localStorage' | 'sessionStorage' | 'meta'; key: string }

export interface AuthContext {
  id: string;
  label: string;
  identity: string;
  /** Host key or origin the context's credentials are for; other audiences never receive them. */
  audience: string;
  credentials: Credentials;
  headers: { name: string; prefix: string; source: SourceRef }[];
  expiry?: { source: SourceRef; format: 'epoch-ms' | 'epoch-s' | 'iso' };
  refresh?: { endpointId: string; outputs: { path: string; target: SourceRef }[]; deadlineMs: number; readOnlyRetry: boolean };
}

export type SigningComponent = 'method' | 'path' | 'query' | 'body-sha256' | 'timestamp' | 'nonce' | `header:${string}`;
export interface SigningRecipe {
  id: string;
  label: string;
  algorithm: 'HMAC-SHA-256';
  components: SigningComponent[];
  separator: string;
  encoding: 'hex' | 'base64';
  /** Name of a runtime key binding; key material is never stored. */
  keyRef: string;
  outputHeader: string;
  timestampHeader?: string;
  nonceHeader?: string;
  freshnessMs: number;
}

export type CompareOp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'exists';
export interface Condition { ref: string; op: CompareOp; value?: string }
export interface Step {
  endpointId: string;
  phase: 'setup' | 'load' | 'skip';
  guard?: Condition;
  poll?: { readOnly: true; until: Condition; maxAttempts: number; intervalMs: number; deadlineMs: number };
  idempotency?: { header: string };
  assertions?: Condition[];
}
export interface Plan {
  id: string;
  name: string;
  strategy: 'flow' | 'independent';
  mode: 'direct' | 'rules';
  steps: Step[];
  iterations: number;
  concurrency: number;
  delayMs: number;
  rampUp: boolean;
  onFailure: 'continue' | 'stop';
}

export interface Profile {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** environment name → host key → origin ('' = the page's own origin). */
  environments: Record<string, Record<string, string>>;
  activeEnvironment: string;
  globalHeaders: Header[];
  settings: { bodyCheckKb: number };
}

/** One profile and everything it owns: the unit of a storage transaction and of a profile export. */
export interface Aggregate {
  schema: 2;
  revision: number;
  profile: Profile;
  endpoints: Endpoint[];
  plans: Plan[];
  authContexts: AuthContext[];
  signingRecipes: SigningRecipe[];
  /** Schema 1 rules kept as data, not executable, until rule modules (R4) read them. */
  legacyRules: unknown[];
}

export const BOUNDS = {
  name: 120,
  endpoints: 1000,
  plans: 100,
  rows: 200,
  bodyBytes: 1024 * 1024,
  sampleBytes: 16 * 1024,
  bodyCheckKb: { min: 1, max: 10240, default: 1024 },
  iterations: 1000,
  concurrency: 20,
  delayMs: 60_000,
  poll: { attempts: 10, minIntervalMs: 250, deadlineMs: 30_000 },
  refreshDeadlineMs: 5_000,
  freshnessMs: 300_000,
} as const;

export const FORBIDDEN_HEADERS = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method', 'connection',
  'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin', 'referer', 'set-cookie',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'via',
]);
export const forbiddenHeader = (name: string) => {
  const k = name.trim().toLowerCase();
  return FORBIDDEN_HEADERS.has(k) || k.startsWith('proxy-') || k.startsWith('sec-');
};
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ALIAS = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$|token|secret|session|csrf|xsrf|password|signature/i;
export const sensitiveHeader = (name: string) => SENSITIVE.test(name.trim());

export const utf8Bytes = (s: string) => new TextEncoder().encode(s).byteLength;
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36)}`;

// ---------- diagnostics

export interface Diag { path: string; message: string }
export type Result<T> = { ok: true; value: T } | { ok: false; errors: Diag[] };

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);

/** Validation context: collects diagnostics while rebuilding a clean value. */
class V {
  errors: Diag[] = [];
  err(path: string, message: string) { if (this.errors.length < 200) this.errors.push({ path, message }); }
  obj(x: unknown, path: string): Obj {
    if (isObj(x)) return x;
    this.err(path, 'Expected an object');
    return {};
  }
  arr(x: unknown, path: string, max: number): unknown[] {
    if (!Array.isArray(x)) { this.err(path, 'Expected a list'); return []; }
    if (x.length > max) { this.err(path, `At most ${max} items`); return x.slice(0, max); }
    return x;
  }
  str(o: Obj, k: string, path: string, o2: { max?: number; min?: number; re?: RegExp; reMsg?: string; optional?: boolean } = {}): string {
    const v = o[k];
    const p = path ? `${path}.${k}` : k;
    if (v === undefined && o2.optional) return '';
    if (typeof v !== 'string') { this.err(p, 'Expected text'); return ''; }
    if (o2.min !== undefined && v.trim().length < o2.min) this.err(p, 'Required');
    else if (o2.max !== undefined && v.length > o2.max) this.err(p, `At most ${o2.max} characters`);
    else if (o2.re && !o2.re.test(v)) this.err(p, o2.reMsg ?? 'Invalid value');
    return v;
  }
  int(o: Obj, k: string, path: string, min: number, max: number): number {
    const v = o[k];
    const p = path ? `${path}.${k}` : k;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) { this.err(p, `Whole number from ${min} to ${max}`); return min; }
    return v;
  }
  bool(o: Obj, k: string, path: string): boolean {
    const v = o[k];
    if (typeof v !== 'boolean') { this.err(`${path}.${k}`, 'Expected true or false'); return false; }
    return v;
  }
  oneOf<T extends string>(o: Obj, k: string, path: string, allowed: readonly T[]): T {
    const v = o[k];
    const p = path ? `${path}.${k}` : k;
    if (!allowed.includes(v as T)) { this.err(p, `One of: ${allowed.join(', ')}`); return allowed[0]!; }
    return v as T;
  }
  id(o: Obj, k: string, path: string): string { return this.str(o, k, path, { re: ID, reMsg: 'Invalid ID' }); }
  map(x: unknown, path: string, each: (v: unknown, key: string, p: string) => void) {
    const o = this.obj(x, path);
    for (const key of Object.keys(o)) {
      if (BAD_KEYS.has(key)) { this.err(`${path}.${key}`, 'Reserved key'); continue; }
      each(o[key], key, `${path}.${key}`);
    }
  }
}

const done = <T>(v: V, value: T): Result<T> => (v.errors.length ? { ok: false, errors: v.errors } : { ok: true, value });

// ---------- field validators shared by UI, import and storage

export function validateOrigin(text: string): { ok: true; origin: string } | { ok: false; error: string } {
  let u: URL;
  try { u = new URL(text.trim()); } catch { return { ok: false, error: 'Enter an origin such as https://api.example.com' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'Only http and https origins are supported' };
  if (u.username || u.password) return { ok: false, error: 'Origin must not contain credentials' };
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return { ok: false, error: 'Enter only scheme, host and port' };
  return { ok: true, origin: u.origin };
}

function headers(v: V, x: unknown, path: string, allowRemove: boolean): Header[] {
  const seen = new Set<string>();
  return v.arr(x, path, BOUNDS.rows).map((raw, i) => {
    const p = `${path}.${i}`;
    const o = v.obj(raw, p);
    const name = v.str(o, 'name', p, { max: 256, re: TOKEN, reMsg: 'Header names are letters, digits and - _ . etc.' });
    const value = v.str(o, 'value', p, { max: 8192, re: /^[^\r\n\0]*$/, reMsg: 'Header values cannot contain line breaks' });
    if (name && forbiddenHeader(name)) v.err(`${p}.name`, `The browser does not let scripts set ${name}`);
    const key = name.toLowerCase();
    if (key && seen.has(key)) v.err(`${p}.name`, `${name} appears twice`);
    seen.add(key);
    const h: Header = { name, value };
    if (o.remove !== undefined) {
      if (!allowRemove) v.err(`${p}.remove`, 'Removal applies to endpoint headers only');
      else if (v.bool(o, 'remove', p)) h.remove = true;
    }
    return h;
  });
}

function pairs(v: V, x: unknown, path: string): Pair[] {
  return v.arr(x, path, BOUNDS.rows).map((raw, i) => {
    if (!Array.isArray(raw) || raw.length !== 2 || typeof raw[0] !== 'string' || typeof raw[1] !== 'string') {
      v.err(`${path}.${i}`, 'Expected [name, value]');
      return ['', ''] as Pair;
    }
    if (!raw[0]) v.err(`${path}.${i}`, 'Name is required');
    return [raw[0], raw[1]] as Pair;
  });
}

function body(v: V, x: unknown, path: string): Body {
  const o = v.obj(x, path);
  const kind = v.oneOf(o, 'kind', path, ['none', 'text', 'json', 'urlencoded', 'multipart'] as const);
  const big = (s: string, k: string) => { if (utf8Bytes(s) > BOUNDS.bodyBytes) v.err(`${path}.${k}`, `Body is limited to ${BOUNDS.bodyBytes} bytes`); return s; };
  switch (kind) {
    case 'none': return { kind };
    case 'text': return { kind, text: big(v.str(o, 'text', path), 'text') };
    case 'json': return { kind, text: big(v.str(o, 'text', path), 'text') };
    case 'urlencoded': return { kind, pairs: pairs(v, o.pairs, `${path}.pairs`) };
    case 'multipart': return {
      kind,
      parts: v.arr(o.parts, `${path}.parts`, BOUNDS.rows).map((raw, i) => {
        const p = `${path}.parts.${i}`;
        const q = v.obj(raw, p);
        const k = v.oneOf(q, 'kind', p, ['field', 'file'] as const);
        const name = v.str(q, 'name', p, { min: 1, max: 256 });
        return k === 'field' ? { kind: k, name, value: v.str(q, 'value', p) } : { kind: k, name, fileName: v.str(q, 'fileName', p, { max: 256 }) };
      }),
    };
  }
}

/** URL check that tolerates {{expressions}} (they are resolved at dispatch). */
function urlProblem(url: string, hostKey: string | null): string | null {
  if (/[\s#]/.test(url.replace(/\{\{[^}]*\}\}/g, 'x'))) return 'No spaces or fragment';
  const plain = url.replace(/\{\{[^}]*\}\}/g, 'x');
  if (hostKey !== null) return plain.startsWith('/') ? null : 'Path must start with /';
  try {
    const u = new URL(plain);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Only http and https URLs';
    if (u.username || u.password) return 'URL must not contain credentials';
    return null;
  } catch { return 'Enter a path starting with / and pick a host, or an absolute http(s) URL'; }
}

function validateRequest(v: V, x: unknown, path: string): RequestTemplate {
  const o = v.obj(x, path);
  const method = v.oneOf(o, 'method', path, METHODS);
  let hostKey: string | null = null;
  if (o.hostKey !== null) hostKey = v.str(o, 'hostKey', path, { min: 1, max: 64, re: /^[A-Za-z0-9_.-]+$/, reMsg: 'Host keys are letters, digits, . _ -' });
  const url = v.str(o, 'url', path, { min: 1, max: 8192 });
  const problem = url && urlProblem(url, hostKey);
  if (problem) v.err(`${path}.url`, problem);
  const b = body(v, o.body, `${path}.body`);
  if ((method === 'GET' || method === 'HEAD') && b.kind !== 'none') v.err(`${path}.body`, `${method} requests cannot have a body`);
  return {
    method, hostKey, url,
    query: pairs(v, o.query, `${path}.query`),
    headers: headers(v, o.headers, `${path}.headers`, true),
    credentials: v.oneOf(o, 'credentials', path, CREDENTIALS),
    body: b,
  };
}

function check(v: V, x: unknown, p: string): Check {
  const o = v.obj(x, p);
  const kind = v.oneOf(o, 'kind', p, ['status', 'header', 'body-contains', 'json', 'duration'] as const);
  switch (kind) {
    case 'status': {
      const min = v.int(o, 'min', p, 100, 599), max = v.int(o, 'max', p, 100, 599);
      if (max < min) v.err(`${p}.max`, 'Max must be at least min');
      return { kind, min, max };
    }
    case 'header': {
      const c: Check = { kind, name: v.str(o, 'name', p, { re: TOKEN, reMsg: 'Enter a header name' }) };
      if (o.value !== undefined) c.value = v.str(o, 'value', p, { max: 8192 });
      return c;
    }
    case 'body-contains': return { kind, value: v.str(o, 'value', p, { min: 1, max: 8192 }) };
    case 'json': {
      const path = v.str(o, 'path', p, { re: /^(\$|[A-Za-z_$][\w$]*)?(\.[A-Za-z_$][\w$]*|\[\d+\])*$/, reMsg: 'Use a path such as items[0].id' });
      if (path.split(/[.[\]]/).some((s) => BAD_KEYS.has(s))) v.err(`${p}.path`, 'Reserved key in path');
      const c: Check = { kind, path, mode: v.oneOf(o, 'mode', p, ['exists', 'equals', 'type'] as const) };
      if (c.mode !== 'exists') c.value = v.str(o, 'value', p, { max: 8192 });
      if (c.mode === 'type' && !['string', 'number', 'boolean', 'null', 'object', 'array'].includes(c.value!)) v.err(`${p}.value`, 'Type is string, number, boolean, null, object or array');
      return c;
    }
    case 'duration': return { kind, maxMs: v.int(o, 'maxMs', p, 1, 600_000) };
  }
}

function sample(v: V, x: unknown, p: string): Sample {
  const o = v.obj(x, p);
  const s: Sample = {
    status: v.int(o, 'status', p, 100, 599),
    headers: pairs(v, o.headers, `${p}.headers`),
    body: v.str(o, 'body', p),
    bodyState: v.oneOf(o, 'bodyState', p, ['complete', 'truncated', 'redacted'] as const),
    source: v.oneOf(o, 'source', p, ['captured', 'authored', 'migrated'] as const),
  };
  if (utf8Bytes(s.body) > BOUNDS.sampleBytes) v.err(`${p}.body`, `Sample body is limited to ${BOUNDS.sampleBytes} bytes`);
  if (o.at !== undefined) s.at = v.int(o, 'at', p, 0, Number.MAX_SAFE_INTEGER);
  return s;
}

function validateEndpoint(v: V, x: unknown, p: string): Endpoint {
  const o = v.obj(x, p);
  const e: Endpoint = {
    id: v.id(o, 'id', p),
    name: v.str(o, 'name', p, { min: 1, max: BOUNDS.name }),
    alias: v.str(o, 'alias', p, { re: ALIAS, reMsg: 'Alias starts with a letter or _ and uses letters, digits and _ (max 64)' }),
    request: validateRequest(v, o.request, `${p}.request`),
    checks: v.arr(o.checks, `${p}.checks`, 50).map((c, i) => check(v, c, `${p}.checks.${i}`)),
    provenance: v.str(o, 'provenance', p, { max: 200 }),
    createdAt: v.int(o, 'createdAt', p, 0, Number.MAX_SAFE_INTEGER),
    updatedAt: v.int(o, 'updatedAt', p, 0, Number.MAX_SAFE_INTEGER),
  };
  if (o.sample !== undefined) e.sample = sample(v, o.sample, `${p}.sample`);
  if (o.authContextId !== undefined) e.authContextId = v.id(o, 'authContextId', p);
  if (o.signingRecipeId !== undefined) e.signingRecipeId = v.id(o, 'signingRecipeId', p);
  return e;
}

function sourceRef(v: V, x: unknown, p: string): SourceRef {
  const o = v.obj(x, p);
  return { kind: v.oneOf(o, 'kind', p, ['cookie', 'localStorage', 'sessionStorage', 'meta'] as const), key: v.str(o, 'key', p, { min: 1, max: 256 }) };
}

const CONDITION_OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'exists'] as const;
const REF = /^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_$][\w$]*|\[\d+\])*$/;
function condition(v: V, x: unknown, p: string): Condition {
  const o = v.obj(x, p);
  const c: Condition = { ref: v.str(o, 'ref', p, { re: REF, reMsg: 'Use producer_alias.path' }), op: v.oneOf(o, 'op', p, CONDITION_OPS) };
  if (c.ref.split(/[.[\]]/).some((s) => BAD_KEYS.has(s))) v.err(`${p}.ref`, 'Reserved key in path');
  if (c.op !== 'exists') c.value = v.str(o, 'value', p, { max: 1024 });
  // Ordered comparisons are exact decimal strings, never floating-point approximations.
  if (['lt', 'lte', 'gt', 'gte'].includes(c.op) && !/^-?\d+(\.\d+)?$/.test(c.value ?? '')) v.err(`${p}.value`, 'Ordered comparison needs an exact decimal such as 100.25');
  return c;
}

function authContext(v: V, x: unknown, p: string): AuthContext {
  const o = v.obj(x, p);
  const a: AuthContext = {
    id: v.id(o, 'id', p),
    label: v.str(o, 'label', p, { min: 1, max: BOUNDS.name }),
    identity: v.str(o, 'identity', p, { max: BOUNDS.name }),
    audience: v.str(o, 'audience', p, { min: 1, max: 256 }),
    credentials: v.oneOf(o, 'credentials', p, CREDENTIALS),
    headers: v.arr(o.headers, `${p}.headers`, 20).map((raw, i) => {
      const q = v.obj(raw, `${p}.headers.${i}`);
      const name = v.str(q, 'name', `${p}.headers.${i}`, { re: TOKEN, reMsg: 'Enter a header name' });
      if (forbiddenHeader(name)) v.err(`${p}.headers.${i}.name`, `The browser does not let scripts set ${name}`);
      return { name, prefix: v.str(q, 'prefix', `${p}.headers.${i}`, { max: 64, re: /^[^\r\n]*$/ }), source: sourceRef(v, q.source, `${p}.headers.${i}.source`) };
    }),
  };
  if (o.expiry !== undefined) {
    const q = v.obj(o.expiry, `${p}.expiry`);
    a.expiry = { source: sourceRef(v, q.source, `${p}.expiry.source`), format: v.oneOf(q, 'format', `${p}.expiry`, ['epoch-ms', 'epoch-s', 'iso'] as const) };
  }
  if (o.refresh !== undefined) {
    const q = v.obj(o.refresh, `${p}.refresh`);
    a.refresh = {
      endpointId: v.id(q, 'endpointId', `${p}.refresh`),
      outputs: v.arr(q.outputs, `${p}.refresh.outputs`, 10).map((raw, i) => {
        const r = v.obj(raw, `${p}.refresh.outputs.${i}`);
        return { path: v.str(r, 'path', `${p}.refresh.outputs.${i}`, { min: 1, max: 256 }), target: sourceRef(v, r.target, `${p}.refresh.outputs.${i}.target`) };
      }),
      deadlineMs: v.int(q, 'deadlineMs', `${p}.refresh`, 100, BOUNDS.refreshDeadlineMs),
      readOnlyRetry: v.bool(q, 'readOnlyRetry', `${p}.refresh`),
    };
  }
  return a;
}

const COMPONENT = /^(method|path|query|body-sha256|timestamp|nonce|header:[!#$%&'*+.^_`|~0-9A-Za-z-]+)$/;
function signingRecipe(v: V, x: unknown, p: string): SigningRecipe {
  const o = v.obj(x, p);
  const r: SigningRecipe = {
    id: v.id(o, 'id', p),
    label: v.str(o, 'label', p, { min: 1, max: BOUNDS.name }),
    algorithm: v.oneOf(o, 'algorithm', p, ['HMAC-SHA-256'] as const),
    components: v.arr(o.components, `${p}.components`, 20).map((c, i) => {
      if (typeof c !== 'string' || !COMPONENT.test(c)) v.err(`${p}.components.${i}`, 'Supported: method, path, query, body-sha256, timestamp, nonce, header:<name>');
      return c as SigningComponent;
    }),
    separator: v.str(o, 'separator', p, { max: 4 }),
    encoding: v.oneOf(o, 'encoding', p, ['hex', 'base64'] as const),
    keyRef: v.str(o, 'keyRef', p, { min: 1, max: 64, re: ALIAS, reMsg: 'Key reference is a name, never key material' }),
    outputHeader: v.str(o, 'outputHeader', p, { re: TOKEN, reMsg: 'Enter a header name' }),
    freshnessMs: v.int(o, 'freshnessMs', p, 1000, BOUNDS.freshnessMs),
  };
  if (!r.components.length) v.err(`${p}.components`, 'At least one component');
  if (o.timestampHeader !== undefined) r.timestampHeader = v.str(o, 'timestampHeader', p, { re: TOKEN });
  if (o.nonceHeader !== undefined) r.nonceHeader = v.str(o, 'nonceHeader', p, { re: TOKEN });
  return r;
}

function plan(v: V, x: unknown, p: string): Plan {
  const o = v.obj(x, p);
  return {
    id: v.id(o, 'id', p),
    name: v.str(o, 'name', p, { min: 1, max: BOUNDS.name }),
    strategy: v.oneOf(o, 'strategy', p, ['flow', 'independent'] as const),
    mode: v.oneOf(o, 'mode', p, ['direct', 'rules'] as const),
    steps: v.arr(o.steps, `${p}.steps`, BOUNDS.endpoints).map((raw, i) => {
      const sp = `${p}.steps.${i}`;
      const q = v.obj(raw, sp);
      const s: Step = { endpointId: v.id(q, 'endpointId', sp), phase: v.oneOf(q, 'phase', sp, ['setup', 'load', 'skip'] as const) };
      if (q.guard !== undefined) s.guard = condition(v, q.guard, `${sp}.guard`);
      if (q.poll !== undefined) {
        const r = v.obj(q.poll, `${sp}.poll`);
        if (r.readOnly !== true) v.err(`${sp}.poll.readOnly`, 'Polling requires an endpoint classified read-only');
        s.poll = {
          readOnly: true,
          until: condition(v, r.until, `${sp}.poll.until`),
          maxAttempts: v.int(r, 'maxAttempts', `${sp}.poll`, 1, BOUNDS.poll.attempts),
          intervalMs: v.int(r, 'intervalMs', `${sp}.poll`, BOUNDS.poll.minIntervalMs, BOUNDS.poll.deadlineMs),
          deadlineMs: v.int(r, 'deadlineMs', `${sp}.poll`, BOUNDS.poll.minIntervalMs, BOUNDS.poll.deadlineMs),
        };
      }
      if (q.idempotency !== undefined) s.idempotency = { header: v.str(v.obj(q.idempotency, `${sp}.idempotency`), 'header', `${sp}.idempotency`, { re: TOKEN, reMsg: 'Enter a header name' }) };
      if (q.assertions !== undefined) s.assertions = v.arr(q.assertions, `${sp}.assertions`, 20).map((c, j) => condition(v, c, `${sp}.assertions.${j}`));
      return s;
    }),
    iterations: v.int(o, 'iterations', p, 1, BOUNDS.iterations),
    concurrency: v.int(o, 'concurrency', p, 1, BOUNDS.concurrency),
    delayMs: v.int(o, 'delayMs', p, 0, BOUNDS.delayMs),
    rampUp: v.bool(o, 'rampUp', p),
    onFailure: v.oneOf(o, 'onFailure', p, ['continue', 'stop'] as const),
  };
}

function profile(v: V, x: unknown, p: string): Profile {
  const o = v.obj(x, p);
  const environments: Profile['environments'] = {};
  v.map(o.environments, `${p}.environments`, (envRaw, env, ep) => {
    if (!/^[A-Za-z0-9_. -]{1,64}$/.test(env)) v.err(ep, 'Environment names are 1–64 letters, digits, space . _ -');
    const hosts: Record<string, string> = {};
    v.map(envRaw, ep, (origin, key, hp) => {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) v.err(hp, 'Host keys are letters, digits, . _ -');
      if (typeof origin !== 'string') return v.err(hp, 'Expected an origin or blank');
      if (origin) {
        const r = validateOrigin(origin);
        if (!r.ok) return v.err(hp, r.error);
        hosts[key] = r.origin;
      } else hosts[key] = '';
    });
    environments[env] = hosts;
  });
  const activeEnvironment = v.str(o, 'activeEnvironment', p, { min: 1, max: 64 });
  if (!Object.hasOwn(environments, activeEnvironment)) v.err(`${p}.activeEnvironment`, 'Active environment does not exist');
  const s = v.obj(o.settings, `${p}.settings`);
  return {
    id: v.id(o, 'id', p),
    name: v.str(o, 'name', p, { min: 1, max: BOUNDS.name }),
    createdAt: v.int(o, 'createdAt', p, 0, Number.MAX_SAFE_INTEGER),
    updatedAt: v.int(o, 'updatedAt', p, 0, Number.MAX_SAFE_INTEGER),
    environments,
    activeEnvironment,
    globalHeaders: headers(v, o.globalHeaders, `${p}.globalHeaders`, false),
    settings: { bodyCheckKb: v.int(s, 'bodyCheckKb', `${p}.settings`, BOUNDS.bodyCheckKb.min, BOUNDS.bodyCheckKb.max) },
  };
}

/** Whole aggregate, including cross-entity references and uniqueness. */
export function validateAggregate(x: unknown): Result<Aggregate> {
  const v = new V();
  const o = v.obj(x, '');
  if (o.schema !== SCHEMA) {
    v.err('schema', typeof o.schema === 'number' && o.schema > SCHEMA ? `Schema ${o.schema} is newer than this build supports (${SCHEMA})` : `Expected schema ${SCHEMA}`);
    return { ok: false, errors: v.errors };
  }
  const agg: Aggregate = {
    schema: SCHEMA,
    revision: v.int(o, 'revision', '', 0, Number.MAX_SAFE_INTEGER),
    profile: profile(v, o.profile, 'profile'),
    endpoints: v.arr(o.endpoints, 'endpoints', BOUNDS.endpoints).map((e, i) => validateEndpoint(v, e, `endpoints.${i}`)),
    plans: v.arr(o.plans, 'plans', BOUNDS.plans).map((e, i) => plan(v, e, `plans.${i}`)),
    authContexts: v.arr(o.authContexts, 'authContexts', 50).map((e, i) => authContext(v, e, `authContexts.${i}`)),
    signingRecipes: v.arr(o.signingRecipes, 'signingRecipes', 50).map((e, i) => signingRecipe(v, e, `signingRecipes.${i}`)),
    legacyRules: v.arr(o.legacyRules, 'legacyRules', 1000).map((r, i) => { if (!isObj(r)) v.err(`legacyRules.${i}`, 'Expected an object'); return r; }),
  };
  references(v, agg);
  return done(v, agg);
}

function references(v: V, agg: Aggregate) {
  const uniq = (list: { id: string }[], path: string) => {
    const seen = new Set<string>();
    list.forEach((x, i) => { if (seen.has(x.id)) v.err(`${path}.${i}.id`, `Duplicate ID ${x.id}`); seen.add(x.id); });
    return seen;
  };
  const eps = uniq(agg.endpoints, 'endpoints');
  uniq(agg.plans, 'plans');
  const ctxs = uniq(agg.authContexts, 'authContexts');
  const recipes = uniq(agg.signingRecipes, 'signingRecipes');
  const aliases = new Set<string>();
  const hostKeys = new Set(Object.values(agg.profile.environments).flatMap((h) => Object.keys(h)));
  agg.endpoints.forEach((e, i) => {
    if (aliases.has(e.alias)) v.err(`endpoints.${i}.alias`, `Alias ${e.alias} is already used`);
    aliases.add(e.alias);
    if (e.request.hostKey !== null && !hostKeys.has(e.request.hostKey)) v.err(`endpoints.${i}.request.hostKey`, `Host key ${e.request.hostKey} is not defined in any environment`);
    if (e.authContextId && !ctxs.has(e.authContextId)) v.err(`endpoints.${i}.authContextId`, 'Unknown auth context');
    if (e.signingRecipeId && !recipes.has(e.signingRecipeId)) v.err(`endpoints.${i}.signingRecipeId`, 'Unknown signing recipe');
  });
  agg.plans.forEach((pl, i) => {
    const inPlan = new Set<string>();
    pl.steps.forEach((s, j) => {
      if (!eps.has(s.endpointId)) v.err(`plans.${i}.steps.${j}.endpointId`, 'Step refers to a missing endpoint');
      if (inPlan.has(s.endpointId)) v.err(`plans.${i}.steps.${j}.endpointId`, 'Endpoint listed twice in this plan');
      inPlan.add(s.endpointId);
      if (s.poll) {
        const ep = agg.endpoints.find((e) => e.id === s.endpointId);
        if (ep && ep.request.method !== 'GET' && ep.request.method !== 'HEAD') v.err(`plans.${i}.steps.${j}.poll`, 'Polling is limited to GET/HEAD endpoints');
      }
    });
  });
  agg.authContexts.forEach((a, i) => {
    if (a.refresh && !eps.has(a.refresh.endpointId)) v.err(`authContexts.${i}.refresh.endpointId`, 'Refresh endpoint is missing');
  });
}

/** Endpoint validation for an editor draft, in the context of the rest of its profile. */
export function validateEndpointIn(agg: Aggregate, e: Endpoint): Diag[] {
  const r = validateAggregate({ ...agg, endpoints: [...agg.endpoints.filter((x) => x.id !== e.id), e] });
  if (r.ok) return [];
  const idx = agg.endpoints.filter((x) => x.id !== e.id).length;
  const prefix = `endpoints.${idx}.`;
  return r.errors.filter((d) => d.path.startsWith(prefix)).map((d) => ({ path: d.path.slice(prefix.length), message: d.message }));
}

// ---------- constructors

export function defaultProfile(name = 'Default'): Aggregate {
  const now = Date.now();
  return {
    schema: SCHEMA,
    revision: 0,
    profile: {
      id: newId('profile'), name, createdAt: now, updatedAt: now,
      environments: { default: { default: '' } }, activeEnvironment: 'default',
      globalHeaders: [], settings: { bodyCheckKb: BOUNDS.bodyCheckKb.default },
    },
    endpoints: [], plans: [], authContexts: [], signingRecipes: [], legacyRules: [],
  };
}

export function newEndpoint(agg: Aggregate): Endpoint {
  const now = Date.now();
  let n = agg.endpoints.length + 1;
  while (agg.endpoints.some((e) => e.alias === `endpoint_${n}`)) n++;
  const firstHost = Object.keys(agg.profile.environments[agg.profile.activeEnvironment] ?? {})[0] ?? null;
  return {
    id: newId('ep'), name: `Endpoint ${n}`, alias: `endpoint_${n}`,
    request: { method: 'GET', hostKey: firstHost, url: firstHost ? '/' : '', query: [], headers: [], credentials: 'same-origin', body: { kind: 'none' } },
    checks: [{ kind: 'status', min: 200, max: 299 }],
    provenance: 'Created in Workbench', createdAt: now, updatedAt: now,
  };
}

/** Copy with every contained ID remapped once and every internal reference following it. */
export function copyAggregate(agg: Aggregate, name: string): Aggregate {
  const map = new Map<string, string>();
  const re = (id: string, prefix: string) => { if (!map.has(id)) map.set(id, newId(prefix)); return map.get(id)!; };
  const c = structuredClone(agg);
  c.revision = 0;
  c.profile.id = newId('profile');
  c.profile.name = name;
  c.profile.createdAt = c.profile.updatedAt = Date.now();
  for (const e of c.endpoints) e.id = re(e.id, 'ep');
  for (const a of c.authContexts) a.id = re(a.id, 'auth');
  for (const s of c.signingRecipes) s.id = re(s.id, 'sign');
  for (const e of c.endpoints) {
    if (e.authContextId) e.authContextId = map.get(e.authContextId) ?? e.authContextId;
    if (e.signingRecipeId) e.signingRecipeId = map.get(e.signingRecipeId) ?? e.signingRecipeId;
  }
  for (const a of c.authContexts) if (a.refresh) a.refresh.endpointId = map.get(a.refresh.endpointId) ?? a.refresh.endpointId;
  for (const p of c.plans) {
    p.id = newId('plan');
    for (const s of p.steps) s.endpointId = map.get(s.endpointId) ?? s.endpointId;
  }
  c.legacyRules = c.legacyRules.map((r) => {
    const o = { ...(r as Obj) };
    if (typeof o.endpointId === 'string' && map.has(o.endpointId)) o.endpointId = map.get(o.endpointId);
    o.profileId = c.profile.id;
    return o;
  });
  return c;
}

// ---------- references between endpoints ({{alias.path}} in templates)

/** Every text field of a request that can hold an expression, with a setter. */
function templateFields(r: RequestTemplate): { get(): string; set(s: string): void }[] {
  const f: { get(): string; set(s: string): void }[] = [{ get: () => r.url, set: (s) => { r.url = s; } }];
  for (const q of r.query) f.push({ get: () => q[1], set: (s) => { q[1] = s; } });
  for (const hd of r.headers) f.push({ get: () => hd.value, set: (s) => { hd.value = s; } });
  const b = r.body;
  if (b.kind === 'text' || b.kind === 'json') f.push({ get: () => b.text, set: (s) => { b.text = s; } });
  if (b.kind === 'urlencoded') for (const q of b.pairs) f.push({ get: () => q[1], set: (s) => { q[1] = s; } });
  if (b.kind === 'multipart') for (const q of b.parts) if (q.kind === 'field') f.push({ get: () => q.value, set: (s) => { q.value = s; } });
  return f;
}

const refPattern = (alias: string) => new RegExp(`(\\{\\{\\s*)${alias}(?=\\s*\\}\\}|\\.|\\[)`, 'g');

/** Count exact parsed producer references to an alias (not substrings of other names or raw text). */
export function aliasReferences(agg: Aggregate, alias: string, exceptId?: string): { endpointId: string; name: string; count: number }[] {
  const out: { endpointId: string; name: string; count: number }[] = [];
  for (const e of agg.endpoints) {
    if (e.id === exceptId) continue;
    let count = 0;
    for (const f of templateFields(e.request)) count += [...f.get().matchAll(/\{\{[^}]*\}\}/g)].filter((m) => refPattern(alias).test(m[0])).length;
    if (count) out.push({ endpointId: e.id, name: e.name, count });
  }
  return out;
}

/** Rewrite exact references inside {{ }} tokens only. Mutates `agg`. */
export function renameAliasRefs(agg: Aggregate, from: string, to: string): number {
  let n = 0;
  for (const e of agg.endpoints) {
    for (const f of templateFields(e.request)) {
      const next = f.get().replace(/\{\{[^}]*\}\}/g, (tok) => tok.replace(refPattern(from), (_m, open: string) => { n++; return open + to; }));
      if (next !== f.get()) f.set(next);
    }
  }
  return n;
}

// ---------- redaction for export

/** Literal sensitive values become {{$redacted}}, which blocks dispatch until re-entered. References stay. */
export function redactAggregate(agg: Aggregate): { agg: Aggregate; fields: string[] } {
  const c = structuredClone(agg);
  const fields: string[] = [];
  const lit = (v: string) => v !== '' && !/^\s*(Bearer\s+)?\{\{[^}]*\}\}\s*$/.test(v);
  const scrub = (h: Header, where: string) => {
    if (sensitiveHeader(h.name) && !h.remove && lit(h.value)) { h.value = '{{$redacted}}'; fields.push(`${where}: ${h.name}`); }
  };
  c.profile.globalHeaders.forEach((h) => scrub(h, 'Global headers'));
  for (const e of c.endpoints) {
    e.request.headers.forEach((h) => scrub(h, e.name));
    if (e.sample) {
      const before = e.sample.headers.length;
      e.sample.headers = e.sample.headers.filter(([k]) => !sensitiveHeader(k));
      if (e.sample.headers.length !== before) fields.push(`${e.name}: sample headers`);
    }
  }
  return { agg: c, fields };
}
