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
export interface SourceRef {
  kind: 'cookie' | 'localStorage' | 'sessionStorage' | 'meta' | 'dom';
  /** Cookie/storage key, meta name, or a CSS selector for dom. */
  key: string;
  /** dom only: which approved part of the one matching element is read. */
  mode?: 'value' | 'text' | `attr:${string}`;
}
/** A named, user-selected page source for {{$context("name")}}. Only the reference is stored. */
export interface Binding { name: string; source: SourceRef }

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
  /** With rampUp: one more worker is admitted every rampStepMs. Absent in R2 data = 1000. */
  rampStepMs: number;
  onFailure: 'continue' | 'stop';
  /** Completion notice. Absent in R2 data = panel. Browser asks permission first and falls back to panel. */
  notify: 'off' | 'panel' | 'browser';
}

// ---------- rules (R4). Runtime-only state (activation, cursors, samples, budgets used) is never stored.

export const RULE_KINDS = ['mock', 'intercept', 'route', 'chaos'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export interface Matcher {
  method: Method | '*';
  /** '' = the launch frame's origin. */
  origin: string;
  /** Pathname, exact or glob: `*` stays inside a segment, `**` crosses segments. */
  path: string;
  /** Each pair must be present; '' value = key present with any value; a repeated key matches if any value equals. */
  query: Pair[];
  /** Case-insensitive names; '' value = header present. */
  headers: Pair[];
  /** Literal text in a complete bounded text request body; '' = no body condition. */
  bodyContains: string;
}

interface RuleBase {
  id: string;
  label: string;
  /** Linked endpoint: its method and URL replace the stored matcher's while the link exists. */
  endpointId?: string;
  enabled: boolean;
  priority: number;
  /** Creation sequence: equal priorities resolve by it, then by ID. */
  seq: number;
  /** Action revision: bumped by a meaningful edit; resets sequence cursors and chaos budgets. */
  revision: number;
  matcher: Matcher;
}

export interface MockSlot { id: string; status: number; headers: Pair[]; body: string; delayMs: number; fault: 'none' | 'network-error' | 'timeout' }
export interface MockRule extends RuleBase {
  kind: 'mock';
  mode: 'static' | 'sequence';
  slots: MockSlot[];
  /** After the last slot. Never falls back to real traffic. */
  exhaustion: 'repeat-last' | 'loop' | 'network-error';
}

/** RFC 6902 operation. "Nullify" in the UI is replace with null. */
export interface PatchOp { op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test'; path: string; from?: string; value?: unknown }
export interface Transform {
  setHeaders: Pair[];
  removeHeaders: string[];
  /** Applied in order to an isolated copy; committed only if every operation succeeds. */
  patch: PatchOp[];
  /** Literal text, no regular expressions. Runs after the patch. */
  replace: { find: string; with: string; scope: 'first' | 'all' } | null;
  /** Response only: 0 keeps the original status. */
  status: number;
}
export interface InterceptRule extends RuleBase {
  kind: 'intercept';
  request: Transform;
  response: Transform;
  /** Hold real requests before dispatch / real responses before delivery (R5). Absent in R4 data = false. */
  breakRequest: boolean;
  breakResponse: boolean;
}

export interface RouteRule extends RuleBase {
  kind: 'route';
  destinationOrigin: string;
  /** '' keeps the original path; otherwise an exact path or one trailing `/**` capture. */
  pathRewrite: string;
  /** 'caller' keeps the request's own credentials mode. */
  credentials: 'caller' | Credentials;
  /** A cross-origin route removes Authorization unless this is set for this destination. */
  keepAuthorization: boolean;
}

export type ChaosFault =
  | { kind: 'status'; status: number; body: string }
  | { kind: 'latency'; delayMs: number }
  | { kind: 'random-latency'; minMs: number; maxMs: number }
  | { kind: 'network-error' }
  | { kind: 'timeout'; timeoutMs: number }
  | { kind: 'malformed-json'; text: string }
  | { kind: 'corrupt-json'; patch: PatchOp[] }
  | { kind: 'replay'; copies: number; gapMs: number };
export type ChaosFaultKind = ChaosFault['kind'];
/** Synthetic: no upstream request. Real: the request is sent and upstream effects can occur. */
export const CHAOS_MODES: Record<ChaosFaultKind, readonly ('synthetic' | 'real')[]> = {
  status: ['synthetic', 'real'], 'network-error': ['synthetic', 'real'], timeout: ['synthetic', 'real'], 'malformed-json': ['synthetic', 'real'],
  latency: ['real'], 'random-latency': ['real'], 'corrupt-json': ['real'], replay: ['real'],
};
export interface ChaosRule extends RuleBase {
  kind: 'chaos';
  mode: 'synthetic' | 'real';
  fault: ChaosFault;
  /** 0–100, sampled once per selected request. */
  probability: number;
  /** '' = unseeded. */
  seed: string;
  /** Faults applied before the rule stops being selected; 0 = no cap. */
  budget: number;
  /** Real mode only: wait before dispatch. */
  preDelayMs: number;
  /** Stop selecting this long after activation or a meaningful edit; 0 = no limit. */
  durationMs: number;
}

export type Rule = MockRule | InterceptRule | RouteRule | ChaosRule;

export interface Profile {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** environment name → host key → origin ('' = the page's own origin). */
  environments: Record<string, Record<string, string>>;
  activeEnvironment: string;
  globalHeaders: Header[];
  settings: Settings;
}

/** Modules a profile can hide. Hidden = no tab or card, and no effect on traffic (R8). */
export const HIDEABLE = ['mock', 'intercept', 'route', 'chaos', 'recorder'] as const;
export type Hideable = (typeof HIDEABLE)[number];
export interface Settings {
  bodyCheckKb: number;
  hidden: Hideable[];
  /** Request records kept in Recent activity and the module lists. */
  activityRecords: number;
  /** Recorder call limit per draft. */
  recorderCalls: number;
  /** Recorder reads a bounded response preview; off = metadata only, no body read. */
  responseBodies: boolean;
  /** Recorder keeps a recovery copy in this origin's storage. */
  recorderRecovery: boolean;
  /** Recorder keeps secret-looking request header values (Authorization, tokens) instead of redacting them. Off by default. */
  recorderSecrets: boolean;
  /** Global roots offered by Auth & context → Find values; scanned only when the user asks. */
  contextRoots: string[];
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
  /** Named page-source bindings (R6). Absent in R2–R5 data = none. */
  bindings: Binding[];
  rules: Rule[];
  /** Schema 1 rules that could not be converted: kept as data, never executed. */
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
  activityRecords: { min: 50, max: 500, default: 500 },
  recorderCalls: { min: 10, max: 1000, default: 100 },
  contextRoots: 20,
  iterations: 1000,
  concurrency: 20,
  delayMs: 60_000,
  poll: { attempts: 10, minIntervalMs: 250, deadlineMs: 30_000 },
  refreshDeadlineMs: 5_000,
  freshnessMs: 300_000,
  rules: 500,
  priority: 1000,
  slots: 50,
  patchOps: 50,
  ruleDelayMs: 60_000,
  durationMs: 3_600_000,
  budget: 100_000,
  replayCopies: 2,
  replayGapMs: 10_000,
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
  const s: SourceRef = { kind: v.oneOf(o, 'kind', p, ['cookie', 'localStorage', 'sessionStorage', 'meta', 'dom'] as const), key: v.str(o, 'key', p, { min: 1, max: 256 }) };
  if (s.kind === 'dom') {
    const m = v.str(o, 'mode', p, { re: /^(value|text|attr:[A-Za-z_:][-A-Za-z0-9_.:]{0,63})$/, reMsg: 'Read value, text or attr:<name>' });
    s.mode = m as NonNullable<SourceRef['mode']>;
  }
  return s;
}

function binding(v: V, x: unknown, p: string): Binding {
  const o = v.obj(x, p);
  return { name: v.str(o, 'name', p, { re: ALIAS, reMsg: 'Binding names start with a letter or _ and use letters, digits and _' }), source: sourceRef(v, o.source, `${p}.source`) };
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
    rampStepMs: o.rampStepMs === undefined ? 1000 : v.int(o, 'rampStepMs', p, 0, BOUNDS.delayMs),
    onFailure: v.oneOf(o, 'onFailure', p, ['continue', 'stop'] as const),
    notify: o.notify === undefined ? 'panel' : v.oneOf(o, 'notify', p, ['off', 'panel', 'browser'] as const),
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
    settings: settings(v, s, `${p}.settings`),
  };
}

export const defaultSettings = (): Settings => ({
  bodyCheckKb: BOUNDS.bodyCheckKb.default, hidden: [], activityRecords: BOUNDS.activityRecords.default,
  recorderCalls: BOUNDS.recorderCalls.default, responseBodies: true, recorderRecovery: true, recorderSecrets: false, contextRoots: [],
});
const ROOT_NAME = /^[A-Za-z_$][\w$]*$/;
/** Fields added in R8 default when absent, so earlier schema 2 data still loads. */
function settings(v: V, s: Obj, p: string): Settings {
  const d = defaultSettings();
  const has = (k: string) => s[k] !== undefined;
  const hidden = has('hidden') ? v.arr(s.hidden, `${p}.hidden`, HIDEABLE.length).filter((m, i): m is Hideable => {
    if ((HIDEABLE as readonly unknown[]).includes(m)) return true;
    v.err(`${p}.hidden.${i}`, `Expected one of ${HIDEABLE.join(', ')}`);
    return false;
  }) : d.hidden;
  const contextRoots = has('contextRoots') ? v.arr(s.contextRoots, `${p}.contextRoots`, BOUNDS.contextRoots).filter((r, i): r is string => {
    if (typeof r === 'string' && ROOT_NAME.test(r) && r.length <= 64) return true;
    v.err(`${p}.contextRoots.${i}`, 'Expected a global name such as appConfig');
    return false;
  }) : d.contextRoots;
  return {
    bodyCheckKb: v.int(s, 'bodyCheckKb', p, BOUNDS.bodyCheckKb.min, BOUNDS.bodyCheckKb.max),
    hidden: [...new Set(hidden)],
    activityRecords: has('activityRecords') ? v.int(s, 'activityRecords', p, BOUNDS.activityRecords.min, BOUNDS.activityRecords.max) : d.activityRecords,
    recorderCalls: has('recorderCalls') ? v.int(s, 'recorderCalls', p, BOUNDS.recorderCalls.min, BOUNDS.recorderCalls.max) : d.recorderCalls,
    responseBodies: has('responseBodies') ? v.bool(s, 'responseBodies', p) : d.responseBodies,
    recorderRecovery: has('recorderRecovery') ? v.bool(s, 'recorderRecovery', p) : d.recorderRecovery,
    recorderSecrets: has('recorderSecrets') ? v.bool(s, 'recorderSecrets', p) : d.recorderSecrets,
    contextRoots: [...new Set(contextRoots)],
  };
}

// ---------- rules

export const BODYLESS = new Set([204, 205, 304]);
const POINTER_BAD = new Set(['__proto__', 'constructor', 'prototype']);
/** Problem with a JSON Pointer, or null. Prototype-chain segments are refused. */
export function pointerProblem(p: string): string | null {
  if (p === '') return null;
  if (!p.startsWith('/')) return 'A JSON Pointer starts with / (or is empty for the whole value)';
  if (/~[^01]/.test(p) || p.endsWith('~')) return 'Use ~0 for ~ and ~1 for /';
  for (const seg of p.slice(1).split('/')) if (POINTER_BAD.has(seg.replace(/~1/g, '/').replace(/~0/g, '~'))) return `"${seg}" is not allowed in a path`;
  return null;
}

/** Glob path problem, or null. */
export function globProblem(p: string): string | null {
  if (!p.startsWith('/')) return 'Path must start with /';
  if (/[?#\s]/.test(p)) return 'No query, fragment or spaces; use query conditions instead';
  if (p.includes('***')) return 'Use * (one segment) or ** (any segments)';
  return null;
}

/** Route rewrite: exact path, or one trailing /** capture into a matcher that also ends in /**. */
export function rewriteProblem(matchPath: string, rewrite: string): string | null {
  if (!rewrite) return null;
  if (!rewrite.startsWith('/') || /[?#\s]/.test(rewrite)) return 'Enter a path starting with / (no query, fragment or spaces)';
  if (!rewrite.includes('*')) return null;
  const doubles = (s: string) => (s.match(/\*\*/g) ?? []).length;
  if (!rewrite.endsWith('/**') || doubles(rewrite) !== 1 || rewrite.slice(0, -3).includes('*')) return 'A rewrite is an exact path or one trailing /** capture';
  if (!matchPath.endsWith('/**') || doubles(matchPath) !== 1) return 'A trailing /** rewrite needs a matcher path that also ends in /**';
  return null;
}

function matcher(v: V, x: unknown, p: string): Matcher {
  const o = v.obj(x, p);
  const origin = v.str(o, 'origin', p, { max: 2048 });
  if (origin) { const r = validateOrigin(origin); if (!r.ok) v.err(`${p}.origin`, r.error); }
  const path = v.str(o, 'path', p, { min: 1, max: 2048 });
  const gp = path && globProblem(path);
  if (gp) v.err(`${p}.path`, gp);
  const hdrs = pairs(v, o.headers, `${p}.headers`);
  hdrs.forEach(([n], i) => { if (n && !TOKEN.test(n)) v.err(`${p}.headers.${i}`, 'Header names are letters, digits and - _ . etc.'); });
  return {
    method: v.oneOf(o, 'method', p, ['*', ...METHODS] as const),
    origin: origin ? (validateOrigin(origin) as { origin?: string }).origin ?? origin : '',
    path,
    query: pairs(v, o.query, `${p}.query`),
    headers: hdrs,
    bodyContains: v.str(o, 'bodyContains', p, { max: 1024 }),
  };
}

function patchOps(v: V, x: unknown, p: string): PatchOp[] {
  return v.arr(x, p, BOUNDS.patchOps).map((raw, i) => {
    const q = `${p}.${i}`;
    const o = v.obj(raw, q);
    const op = v.oneOf(o, 'op', q, ['add', 'remove', 'replace', 'move', 'copy', 'test'] as const);
    const path = v.str(o, 'path', q, { max: 1024 });
    const pp = pointerProblem(path);
    if (pp) v.err(`${q}.path`, pp);
    const out: PatchOp = { op, path };
    if (op === 'move' || op === 'copy') {
      out.from = v.str(o, 'from', q, { max: 1024 });
      const fp = pointerProblem(out.from);
      if (fp) v.err(`${q}.from`, fp);
    }
    if (op === 'add' || op === 'replace' || op === 'test') {
      if (!Object.hasOwn(o, 'value')) v.err(`${q}.value`, 'A value is required');
      else {
        try { out.value = JSON.parse(JSON.stringify(o.value)); } catch { v.err(`${q}.value`, 'Value must be JSON'); }
        if (out.value === undefined) v.err(`${q}.value`, 'Value must be JSON');
      }
    }
    return out;
  });
}

function responseHeaderPairs(v: V, x: unknown, p: string): Pair[] {
  const list = pairs(v, x, p);
  list.forEach(([n, val], i) => {
    if (n && !TOKEN.test(n)) v.err(`${p}.${i}`, 'Header names are letters, digits and - _ . etc.');
    else if (/^set-cookie2?$/i.test(n)) v.err(`${p}.${i}`, 'Set-Cookie cannot be set by a script reply; the browser cookie jar is unchanged');
    if (/[\r\n\0]/.test(val)) v.err(`${p}.${i}`, 'Header values cannot contain line breaks');
  });
  return list;
}

function transform(v: V, x: unknown, p: string, stage: 'request' | 'response'): Transform {
  const o = v.obj(x, p);
  const set = stage === 'response' ? responseHeaderPairs(v, o.setHeaders, `${p}.setHeaders`) : pairs(v, o.setHeaders, `${p}.setHeaders`);
  if (stage === 'request') set.forEach(([n, val], i) => {
    if (n && !TOKEN.test(n)) v.err(`${p}.setHeaders.${i}`, 'Header names are letters, digits and - _ . etc.');
    else if (n && forbiddenHeader(n)) v.err(`${p}.setHeaders.${i}`, `The browser does not let scripts set ${n}`);
    if (/[\r\n\0]/.test(val)) v.err(`${p}.setHeaders.${i}`, 'Header values cannot contain line breaks');
  });
  const removeHeaders = v.arr(o.removeHeaders, `${p}.removeHeaders`, BOUNDS.rows).map((n, i) => {
    if (typeof n !== 'string' || !TOKEN.test(n)) { v.err(`${p}.removeHeaders.${i}`, 'Enter a header name'); return ''; }
    return n;
  });
  let replace: Transform['replace'] = null;
  if (o.replace !== null && o.replace !== undefined) {
    const r = v.obj(o.replace, `${p}.replace`);
    replace = { find: v.str(r, 'find', `${p}.replace`, { min: 1, max: 4096 }), with: v.str(r, 'with', `${p}.replace`, { max: 65536 }), scope: v.oneOf(r, 'scope', `${p}.replace`, ['first', 'all'] as const) };
  }
  const status = v.int(o, 'status', p, 0, 599);
  if (stage === 'request' && status) v.err(`${p}.status`, 'Status applies to responses only');
  else if (status && status < 200) v.err(`${p}.status`, 'Status is 0 (keep) or 200–599');
  return { setHeaders: set, removeHeaders, patch: patchOps(v, o.patch, `${p}.patch`), replace, status };
}

function fault(v: V, x: unknown, p: string): ChaosFault {
  const o = v.obj(x, p);
  const kind = v.oneOf(o, 'kind', p, Object.keys(CHAOS_MODES) as ChaosFaultKind[]);
  const ms = (k: string, min = 0) => v.int(o, k, p, min, BOUNDS.ruleDelayMs);
  switch (kind) {
    case 'status': {
      const status = v.int(o, 'status', p, 200, 599);
      const body = v.str(o, 'body', p, { max: 65536 });
      if (BODYLESS.has(status) && body) v.err(`${p}.body`, `A ${status} reply has no body`);
      return { kind, status, body };
    }
    case 'latency': return { kind, delayMs: ms('delayMs', 1) };
    case 'random-latency': {
      const minMs = ms('minMs'), maxMs = ms('maxMs', 1);
      if (minMs > maxMs) v.err(`${p}.maxMs`, 'Maximum must be at least the minimum');
      return { kind, minMs, maxMs };
    }
    case 'network-error': return { kind };
    case 'timeout': return { kind, timeoutMs: ms('timeoutMs', 1) };
    case 'malformed-json': return { kind, text: v.str(o, 'text', p, { min: 1, max: 65536 }) };
    case 'corrupt-json': {
      const patch = patchOps(v, o.patch, `${p}.patch`);
      if (!patch.length) v.err(`${p}.patch`, 'Add at least one field change');
      return { kind, patch };
    }
    case 'replay': return { kind, copies: v.int(o, 'copies', p, 1, BOUNDS.replayCopies), gapMs: v.int(o, 'gapMs', p, 0, BOUNDS.replayGapMs) };
  }
}

function validateRule(v: V, x: unknown, p: string): Rule {
  const o = v.obj(x, p);
  const kind = v.oneOf(o, 'kind', p, RULE_KINDS);
  const base = {
    id: v.id(o, 'id', p),
    label: v.str(o, 'label', p, { max: BOUNDS.name }),
    enabled: v.bool(o, 'enabled', p),
    priority: v.int(o, 'priority', p, -BOUNDS.priority, BOUNDS.priority),
    seq: v.int(o, 'seq', p, 0, Number.MAX_SAFE_INTEGER),
    revision: v.int(o, 'revision', p, 1, Number.MAX_SAFE_INTEGER),
    matcher: matcher(v, o.matcher, `${p}.matcher`),
    ...(o.endpointId !== undefined && { endpointId: v.id(o, 'endpointId', p) }),
  };
  switch (kind) {
    case 'mock': {
      const mode = v.oneOf(o, 'mode', p, ['static', 'sequence'] as const);
      const slots = v.arr(o.slots, `${p}.slots`, BOUNDS.slots).map((raw, i): MockSlot => {
        const q = `${p}.slots.${i}`;
        const s = v.obj(raw, q);
        const status = v.int(s, 'status', q, 200, 599);
        const body = v.str(s, 'body', q, { max: BOUNDS.bodyBytes });
        if (utf8Bytes(body) > BOUNDS.bodyBytes) v.err(`${q}.body`, `Body is limited to ${BOUNDS.bodyBytes} bytes`);
        const f = v.oneOf(s, 'fault', q, ['none', 'network-error', 'timeout'] as const);
        if (f === 'none' && BODYLESS.has(status) && body) v.err(`${q}.body`, `A ${status} reply has no body`);
        return { id: v.id(s, 'id', q), status, headers: responseHeaderPairs(v, s.headers, `${q}.headers`), body, delayMs: v.int(s, 'delayMs', q, 0, BOUNDS.ruleDelayMs), fault: f };
      });
      if (!slots.length) v.err(`${p}.slots`, 'Add a reply');
      if (mode === 'static' && slots.length > 1) v.err(`${p}.slots`, 'A static rule has exactly one reply');
      return { ...base, kind, mode, slots, exhaustion: v.oneOf(o, 'exhaustion', p, ['repeat-last', 'loop', 'network-error'] as const) };
    }
    case 'intercept': {
      const flag = (k: string) => (o[k] === undefined ? false : v.bool(o, k, p));
      const r: InterceptRule = {
        ...base, kind, request: transform(v, o.request, `${p}.request`, 'request'), response: transform(v, o.response, `${p}.response`, 'response'),
        breakRequest: flag('breakRequest'), breakResponse: flag('breakResponse'),
      };
      const empty = (t: Transform) => !t.setHeaders.length && !t.removeHeaders.length && !t.patch.length && !t.replace && !t.status;
      if (empty(r.request) && empty(r.response) && !r.breakRequest && !r.breakResponse) v.err(`${p}.response`, 'Add at least one request or response change, or a breakpoint');
      return r;
    }
    case 'route': {
      const dest = v.str(o, 'destinationOrigin', p, { min: 1, max: 2048 });
      const d = dest ? validateOrigin(dest) : null;
      if (d && !d.ok) v.err(`${p}.destinationOrigin`, d.error);
      const pathRewrite = v.str(o, 'pathRewrite', p, { max: 2048 });
      const rp = rewriteProblem(base.matcher.path, pathRewrite);
      if (rp) v.err(`${p}.pathRewrite`, rp);
      return {
        ...base, kind, destinationOrigin: d?.ok ? d.origin : dest, pathRewrite,
        credentials: v.oneOf(o, 'credentials', p, ['caller', ...CREDENTIALS] as const),
        keepAuthorization: v.bool(o, 'keepAuthorization', p),
      };
    }
    case 'chaos': {
      const mode = v.oneOf(o, 'mode', p, ['synthetic', 'real'] as const);
      const f = fault(v, o.fault, `${p}.fault`);
      if (!CHAOS_MODES[f.kind].includes(mode)) {
        v.err(`${p}.mode`, f.kind === 'latency' || f.kind === 'random-latency'
          ? 'Synthetic latency has no reply to delay: use Real mode, or a Mock rule with a delay'
          : `${f.kind === 'replay' ? 'Replay' : 'Corrupting JSON'} needs a real request; use Real mode`);
      }
      const preDelayMs = v.int(o, 'preDelayMs', p, 0, BOUNDS.ruleDelayMs);
      if (preDelayMs && mode === 'synthetic') v.err(`${p}.preDelayMs`, 'A pre-dispatch delay applies to real traffic only');
      return {
        ...base, kind, mode, fault: f,
        probability: v.int(o, 'probability', p, 0, 100),
        seed: v.str(o, 'seed', p, { max: 64 }),
        budget: v.int(o, 'budget', p, 0, BOUNDS.budget),
        preDelayMs,
        durationMs: v.int(o, 'durationMs', p, 0, BOUNDS.durationMs),
      };
    }
  }
}

/** One rule draft, validated in the context of its profile (endpoint link, unique ID). Paths are relative to the rule. */
export function validateRuleIn(agg: Aggregate, r: Rule): Diag[] {
  const res = validateAggregate({ ...agg, rules: [...agg.rules.filter((x) => x.id !== r.id), r] });
  if (res.ok) return [];
  const prefix = `rules.${agg.rules.filter((x) => x.id !== r.id).length}.`;
  return res.errors.filter((d) => d.path.startsWith(prefix)).map((d) => ({ path: d.path.slice(prefix.length), message: d.message }));
}

/** No default path: a rule never starts out matching a broad set of requests. */
const emptyMatcher = (): Matcher => ({ method: '*', origin: '', path: '', query: [], headers: [], bodyContains: '' });
export const emptyTransform = (): Transform => ({ setHeaders: [], removeHeaders: [], patch: [], replace: null, status: 0 });
export const newSlot = (): MockSlot => ({ id: newId('slot'), status: 200, headers: [['Content-Type', 'application/json']], body: '{}', delayMs: 0, fault: 'none' });

/** New rule draft with defaults; `seq` follows the highest stored one. */
export function newRule<K extends RuleKind>(agg: Aggregate, kind: K): Extract<Rule, { kind: K }> {
  const base = { id: newId('rule'), label: '', enabled: true, priority: 0, seq: Math.max(0, ...agg.rules.map((r) => r.seq)) + 1, revision: 1, matcher: emptyMatcher() };
  const by: { [k in RuleKind]: Extract<Rule, { kind: k }> } = {
    mock: { ...base, kind: 'mock', mode: 'static', slots: [newSlot()], exhaustion: 'repeat-last' },
    intercept: { ...base, kind: 'intercept', request: emptyTransform(), response: emptyTransform(), breakRequest: false, breakResponse: false },
    route: { ...base, kind: 'route', destinationOrigin: '', pathRewrite: '', credentials: 'caller', keepAuthorization: false },
    chaos: { ...base, kind: 'chaos', mode: 'synthetic', fault: { kind: 'status', status: 503, body: '' }, probability: 100, seed: '', budget: 0, preDelayMs: 0, durationMs: 0 },
  };
  return by[kind] as Extract<Rule, { kind: K }>;
}

/**
 * The matcher fields a linked endpoint supplies: method, origin (active environment; '' = this page)
 * and path, with each {{expression}} as a one-segment `*`. An unmapped host key supplies no origin.
 */
export function linkedMatcher(agg: Aggregate, e: Endpoint): Pick<Matcher, 'method' | 'path'> & Partial<Pick<Matcher, 'origin'>> {
  const r = e.request;
  const raw = r.url.replace(/\{\{[^}]*\}\}/g, '*').split(/[?#]/)[0]!;
  if (r.hostKey === null) {
    try { const u = new URL(raw); return { method: r.method, origin: u.origin, path: decodeURI(u.pathname) || '/' }; } catch { return { method: r.method, path: raw || '/' }; }
  }
  const o = agg.profile.environments[agg.profile.activeEnvironment]?.[r.hostKey];
  return { method: r.method, path: raw || '/', ...(o !== undefined && { origin: o }) };
}

/** Fields whose change is cosmetic: they keep cursors and budgets. Everything else is an action revision. */
export const meaningfulRuleChange = (a: Rule, b: Rule) => {
  const strip = ({ label: _l, enabled: _e, revision: _r, ...rest }: Rule) => JSON.stringify(rest);
  return strip(a) !== strip(b);
};

/**
 * Schema 1 rules → schema 2. Each one is converted and validated on its own; a rule that does not
 * convert stays in `legacyRules` with a note. v1 relative URLs matched any origin; here they are
 * scoped to the launch frame, which the note says.
 */
export function rulesFromV1(legacy: unknown[], endpointIds: Set<string>): { rules: Rule[]; rest: unknown[]; notes: string[] } {
  const rules: Rule[] = [];
  const rest: unknown[] = [];
  const notes: string[] = [];
  const kv = (s: unknown): Pair[] => typeof s === 'string' && s.trim() ? [...new URLSearchParams(s.trim())] : [];
  const lines = (s: unknown): Pair[] => typeof s === 'string' ? s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(':'); return (i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : [l, '']) as Pair; }) : [];
  const xform = (t: unknown): Transform => {
    const o = isObj(t) ? t : {};
    const b = isObj(o.body) && typeof o.body.find === 'string' && o.body.find ? { find: o.body.find, with: String(o.body.replace ?? ''), scope: o.body.scope === 'first' ? 'first' as const : 'all' as const } : null;
    return { setHeaders: lines(o.setHeaders), removeHeaders: typeof o.removeHeaders === 'string' ? o.removeHeaders.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [], patch: Array.isArray(o.patch) ? o.patch as PatchOp[] : [], replace: b, status: typeof o.status === 'number' ? o.status : 0 };
  };
  let relative = 0;
  legacy.forEach((raw, i) => {
    const r = isObj(raw) ? raw : {};
    const m = isObj(r.matcher) ? r.matcher : {};
    const url = String(m.url ?? '');
    let origin = '', path = url.split(/[?#]/)[0] || '/';
    if (/^https?:\/\//i.test(url)) { try { const u = new URL(url); origin = u.origin; path = u.pathname; } catch { /* left invalid; validation reports it */ } }
    else relative++;
    const method = String(m.method ?? '*').toUpperCase();
    const base = {
      id: typeof r.id === 'string' ? r.id : newId('rule'), label: String(r.label ?? ''), enabled: r.enabled === true,
      priority: typeof r.priority === 'number' ? r.priority : 0, seq: typeof r.seq === 'number' ? r.seq : i + 1, revision: 1,
      matcher: { method, origin, path, query: kv(m.query), headers: kv(m.headers), bodyContains: String(m.bodyContains ?? '') },
      ...(typeof r.endpointId === 'string' && endpointIds.has(r.endpointId) && { endpointId: r.endpointId }),
    };
    let out: unknown;
    // A static reply repeats by definition, so an absent exhaustion is that; a sequence's is not inferred.
    if (r.kind === 'mock') out = { ...base, kind: 'mock', mode: r.mode, exhaustion: r.exhaustion ?? (r.mode === 'static' ? 'repeat-last' : undefined), slots: arrOf(r.slots).map((s) => ({ id: newId('slot'), status: s.status, headers: lines(s.headers), body: s.body ?? '', delayMs: s.delayMs ?? 0, fault: s.fault ?? 'none' })) };
    else if (r.kind === 'intercept') out = { ...base, kind: 'intercept', request: xform(r.request), response: xform(r.response), breakRequest: r.breakRequest === true, breakResponse: r.breakResponse === true };
    else if (r.kind === 'route') {
      const mo = typeof r.matchOrigin === 'string' && r.matchOrigin ? r.matchOrigin : origin;
      // v1 blank rewrite + "preserve path" off meant "/".
      out = { ...base, matcher: { ...base.matcher, origin: mo }, kind: 'route', destinationOrigin: r.destinationOrigin, pathRewrite: r.pathRewrite || (r.preservePath === false ? '/' : ''), credentials: r.credentials === 'same-origin' || r.credentials === 'include' || r.credentials === 'omit' ? r.credentials : 'caller', keepAuthorization: r.keepAuthorization === true };
    } else if (r.kind === 'chaos') {
      const f = isObj(r.fault) ? { ...r.fault } : {};
      if (f.kind === 'malformed-json') f.text = '{"data": [1, 2,';
      out = { ...base, kind: 'chaos', mode: r.mode, fault: f, probability: r.probability, seed: String(r.seed ?? ''), budget: r.budget ?? 0, preDelayMs: r.preDelayMs ?? 0, durationMs: 0 };
    }
    const v = new V();
    const rule = out ? validateRule(v, out, '') : null;
    if (rule && !v.errors.length) rules.push(rule);
    else { rest.push(raw); notes.push(`Rule ${String(r.label || r.id || i + 1)} was not converted (${out ? v.errors.map((d) => `${d.path}: ${d.message}`).slice(0, 2).join('; ') : `unknown kind ${String(r.kind)}`}); it is kept as data and never runs.`); }
  });
  if (relative && rules.length) notes.push('Schema 1 rule URLs without an origin now match the page’s own origin only.');
  return { rules, rest, notes };
}
const arrOf = (x: unknown): Obj[] => (Array.isArray(x) ? x.filter(isObj) : []);

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
    bindings: v.arr(o.bindings ?? [], 'bindings', 100).map((e, i) => binding(v, e, `bindings.${i}`)),
    rules: [],
    legacyRules: v.arr(o.legacyRules, 'legacyRules', 1000).map((r, i) => { if (!isObj(r)) v.err(`legacyRules.${i}`, 'Expected an object'); return r; }),
  };
  if (o.rules === undefined && agg.legacyRules.length) {
    // Stored before R4: convert schema 1 rules now; what does not convert stays as data.
    const c = rulesFromV1(agg.legacyRules, new Set(agg.endpoints.map((e) => e.id)));
    agg.rules = c.rules;
    agg.legacyRules = c.rest;
  } else agg.rules = v.arr(o.rules ?? [], 'rules', BOUNDS.rules).map((r, i) => validateRule(v, r, `rules.${i}`));
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
  const names = new Set<string>();
  agg.bindings.forEach((b, i) => { if (names.has(b.name)) v.err(`bindings.${i}.name`, `Binding ${b.name} is already defined`); names.add(b.name); });
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
  uniq(agg.rules, 'rules');
  agg.rules.forEach((r, i) => { if (r.endpointId && !eps.has(r.endpointId)) v.err(`rules.${i}.endpointId`, 'Linked endpoint is missing'); });
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
      globalHeaders: [], settings: defaultSettings(),
    },
    endpoints: [], plans: [], authContexts: [], signingRecipes: [], bindings: [], rules: [], legacyRules: [],
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
  for (const r of c.rules) {
    r.id = newId('rule');
    if (r.endpointId) r.endpointId = map.get(r.endpointId) ?? r.endpointId;
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
