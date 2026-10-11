// One request preparation path for Once, plan jobs, refresh and explicit duplicates; declarative
// checks and a cancellable send. Preparation is pure given its inputs: page sources, selected
// files, producer outputs, reservations and runtime auth/key state are passed in.
import { forbiddenHeader, sensitiveHeader, validateOrigin, type Aggregate, type AuthContext, type Check, type Endpoint, type SigningRecipe } from '../data/schema';
import { Blocked, describeSource, Num, parseExact, readSource, render, stringifyExact, type Env, type Outputs, type Sources } from './expr';

export type { Sources } from './expr';

export interface PreparedHeader { name: string; value: string; shown: string; from: 'global' | 'endpoint' | 'body' | 'auth' | 'step' | 'signing' }
export interface AuthState {
  contextId: string;
  label: string;
  /** missing/expired with a refresh configured = needsRefresh instead of blocked. */
  state: 'available' | 'missing' | 'expired';
  needsRefresh: boolean;
  expiresAt?: number;
  detail: string;
}
export interface Prepared {
  endpointId: string;
  revision: number;
  method: string;
  url: string;
  /** Where the origin came from, e.g. "host api (env dev)" or "absolute URL". */
  origin: string;
  credentials: RequestCredentials;
  headers: PreparedHeader[];
  body: BodyInit | null;
  /** Exact text that will be sent, when the body is text (signing digest input). */
  bodyText: string | null;
  bodySummary: string;
  /** Exact reasons dispatch is blocked; empty when it can be sent. */
  blocked: string[];
  /** Generated values of this preparation. Re-preparing with the same map reuses them (duplicates, retries). */
  reserved: Map<string, unknown>;
  auth?: AuthState;
  /** Signed just before each transmitted attempt with a fresh timestamp and nonce. */
  signing?: SigningRecipe;
}

export interface PrepOptions {
  outputs?: Outputs;
  reserved?: Map<string, unknown>;
  counters?: Map<string, number>;
  now?: () => number;
  uuid?: () => string;
  random?: () => number;
  /** Runtime auth overlay: refreshed values installed for a context, consulted before page sources. */
  authSources?: (ctx: AuthContext, base: Sources) => Sources;
  /** Names of signing keys available in this session. */
  keys?: ReadonlySet<string>;
  /** Plan step headers (idempotency), applied after auth. */
  stepHeaders?: { name: string; value: string }[];
}

export const mask = (v: string) => (v.length <= 4 ? '••••' : `••••${v.slice(-4)} (${v.length} chars)`);

/** Resolve a context audience (host key or origin) to an origin in the active environment. */
export function audienceOrigin(agg: Aggregate, aud: string, pageOrigin: string): string | null {
  const env = agg.profile.environments[agg.profile.activeEnvironment] ?? {};
  if (Object.hasOwn(env, aud)) return env[aud] || pageOrigin;
  const o = validateOrigin(aud);
  return o.ok ? o.origin : null;
}

function expiryOf(raw: string, format: NonNullable<AuthContext['expiry']>['format']): number | null {
  if (format === 'iso') { const t = Date.parse(raw); return Number.isNaN(t) ? null : t; }
  const n = Number(raw);
  return Number.isFinite(n) ? (format === 'epoch-s' ? n * 1000 : n) : null;
}

/** Build the exact request an endpoint describes, in the profile's active environment. */
export function prepare(agg: Aggregate, ep: Endpoint, pageOrigin: string, src: Sources, files: ReadonlyMap<number, File>, o: PrepOptions = {}): Prepared {
  const blocked: string[] = [];
  const r = ep.request;
  const now = o.now ?? Date.now;
  const env: Env = {
    sources: src,
    bindings: agg.bindings,
    aliases: new Set(agg.endpoints.map((e) => e.alias)),
    ...(o.outputs && { outputs: o.outputs }),
    reserved: o.reserved ?? new Map(),
    counters: o.counters ?? new Map(),
    now,
    uuid: o.uuid ?? (() => crypto.randomUUID()),
    random: o.random ?? Math.random,
  };
  const count = { n: 0 };
  const res = (text: string, site: 'url' | 'text' | 'header' | 'json', where: string, sec = { hit: false }) => {
    try { return render(text, site, where, env, blocked, sec, count); } catch (e) {
      if (!(e instanceof Blocked)) throw e;
      blocked.push(`${where}: ${e.message}`);
      return '';
    }
  };
  const envMap = agg.profile.environments[agg.profile.activeEnvironment] ?? {};
  let origin = '';
  let originNote = 'absolute URL (environments do not retarget it)';
  if (r.hostKey !== null) {
    const mapped = envMap[r.hostKey];
    if (mapped === undefined) blocked.push(`Host "${r.hostKey}" has no origin in environment "${agg.profile.activeEnvironment}"`);
    origin = mapped || pageOrigin;
    originNote = `host ${r.hostKey} → ${mapped ? mapped : `this page (${pageOrigin})`} · environment ${agg.profile.activeEnvironment}`;
  }
  let url = res(r.url, 'url', 'URL');
  const q = r.query.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(res(v, 'text', `Query ${k}`))}`).join('&');
  if (q) url += (url.includes('?') ? '&' : '?') + q;
  let full = '';
  try { full = new URL(origin + url).href; } catch { if (!blocked.length) blocked.push('URL is not valid after resolving its values'); }

  // Header precedence: global defaults → endpoint overrides/removals (case-insensitive; empty value is not removal)
  // → auth context → plan step (idempotency).
  const merged = new Map<string, PreparedHeader>();
  for (const h of agg.profile.globalHeaders) merged.set(h.name.toLowerCase(), { name: h.name, value: h.value, shown: '', from: 'global' });
  for (const h of r.headers) {
    if (h.remove) merged.delete(h.name.toLowerCase());
    else merged.set(h.name.toLowerCase(), { name: h.name, value: h.value, shown: '', from: 'endpoint' });
  }
  const headers: PreparedHeader[] = [];
  for (const h of merged.values()) {
    const sec = { hit: false };
    const value = res(h.value, 'header', `Header ${h.name}`, sec);
    if (forbiddenHeader(h.name)) blocked.push(`Header ${h.name} cannot be set by scripts`);
    headers.push({ ...h, value, shown: sec.hit || sensitiveHeader(h.name) ? mask(value) : value });
  }
  const setHeader = (x: PreparedHeader) => {
    const i = headers.findIndex((y) => y.name.toLowerCase() === x.name.toLowerCase());
    if (i >= 0) headers[i] = x; else headers.push(x);
  };

  let credentials: RequestCredentials = r.credentials;
  let auth: AuthState | undefined;
  const ctx = ep.authContextId ? agg.authContexts.find((a) => a.id === ep.authContextId) : undefined;
  if (ep.authContextId && !ctx) blocked.push('The endpoint names an auth context that no longer exists');
  if (ctx) {
    const csrc = o.authSources ? o.authSources(ctx, src) : src;
    const aud = audienceOrigin(agg, ctx.audience, pageOrigin);
    let dest = '';
    try { dest = new URL(full).origin; } catch { /* reported above */ }
    if (!aud) blocked.push(`Auth context ${ctx.label}: audience "${ctx.audience}" is not a host key or origin`);
    else if (dest && dest !== aud) blocked.push(`Auth context ${ctx.label} is for ${aud}; this request goes to ${dest}. Its credentials are not sent to another audience`);
    credentials = ctx.credentials;
    const missing: string[] = [];
    for (const ah of ctx.headers) {
      const v = readSource(csrc, ah.source);
      if (v === undefined) { missing.push(`${ah.name} needs ${describeSource(ah.source)}`); continue; }
      if (/[\r\n\0]/.test(v)) { blocked.push(`Auth context ${ctx.label}: ${ah.name} source has a line break`); continue; }
      setHeader({ name: ah.name, value: ah.prefix + v, shown: mask(ah.prefix + v), from: 'auth' });
    }
    let state: AuthState['state'] = missing.length ? 'missing' : 'available';
    let expiresAt: number | undefined;
    let detail = missing.length ? missing.join('; ') : `${ctx.headers.length} header(s) from ${ctx.identity || ctx.label}`;
    if (ctx.expiry) {
      const raw = readSource(csrc, ctx.expiry.source);
      const t = raw === undefined ? null : expiryOf(raw, ctx.expiry.format);
      if (t === null) detail += `; expiry ${describeSource(ctx.expiry.source)} unavailable`;
      else {
        expiresAt = t;
        if (now() >= t && state === 'available') { state = 'expired'; detail = `expired at ${new Date(t).toISOString()}`; }
      }
    }
    const needsRefresh = state !== 'available' && !!ctx.refresh;
    if (state !== 'available' && !needsRefresh) blocked.push(`Auth context ${ctx.label}: ${detail}${state === 'expired' ? '; configure refresh or sign in again in the page' : ''}`);
    auth = { contextId: ctx.id, label: ctx.label, state, needsRefresh, detail, ...(expiresAt !== undefined && { expiresAt }) };
  }
  for (const sh of o.stepHeaders ?? []) setHeader({ name: sh.name, value: sh.value, shown: sh.value, from: 'step' });
  const has = (n: string) => headers.some((h) => h.name.toLowerCase() === n);

  let body: BodyInit | null = null;
  let bodyText: string | null = null;
  let bodySummary = 'No body';
  const b = r.body;
  if (b.kind !== 'none' && (r.method === 'GET' || r.method === 'HEAD')) blocked.push(`${r.method} cannot send a body`);
  else if (b.kind === 'text' || b.kind === 'json') {
    body = bodyText = res(b.text, b.kind === 'json' ? 'json' : 'text', 'Body');
    bodySummary = `${b.kind === 'json' ? 'JSON' : 'Text'} · ${new TextEncoder().encode(bodyText).byteLength} bytes, sent exactly as written`;
    if (b.kind === 'json' && !has('content-type')) headers.push({ name: 'Content-Type', value: 'application/json', shown: 'application/json', from: 'body' });
  } else if (b.kind === 'urlencoded') {
    const form = new URLSearchParams(b.pairs.map(([k, v]) => [k, res(v, 'text', `Form ${k}`)]));
    body = form;
    bodyText = form.toString();
    bodySummary = `URL-encoded · ${b.pairs.length} fields in order`;
  } else if (b.kind === 'multipart') {
    if (has('content-type')) blocked.push('Remove the Content-Type header: multipart boundaries come from the browser');
    const fd = new FormData();
    let size = 0;
    b.parts.forEach((p, i) => {
      if (p.kind === 'field') fd.append(p.name, res(p.value, 'text', `Field ${p.name}`));
      else {
        const f = files.get(i);
        if (!f) blocked.push(`File for "${p.name}" is not selected${p.fileName ? ` (expected ${p.fileName})` : ''}`);
        else { fd.append(p.name, f, f.name); size += f.size; }
      }
    });
    if (size > 10 * 1024 * 1024) blocked.push('Selected files exceed 10 MiB for one request');
    body = fd;
    bodySummary = `Multipart · ${b.parts.length} parts (boundary set by the browser)`;
  }

  let signing: SigningRecipe | undefined;
  const recipe = ep.signingRecipeId ? agg.signingRecipes.find((x) => x.id === ep.signingRecipeId) : undefined;
  if (ep.signingRecipeId && !recipe) blocked.push('The endpoint names a signing recipe that no longer exists');
  if (recipe) {
    if (!o.keys?.has(recipe.keyRef)) blocked.push(`Signing recipe ${recipe.label} needs key "${recipe.keyRef}" for this session (Auth & context → Signing keys); keys are never stored`);
    if (b.kind === 'multipart') blocked.push(`Signing recipe ${recipe.label}: multipart bodies cannot be signed (no exact byte form before the browser adds boundaries)`);
    for (const c of recipe.components) {
      if (c.startsWith('header:') && !has(c.slice(7).toLowerCase())) blocked.push(`Signing recipe ${recipe.label} signs header ${c.slice(7)}, which this request does not have`);
    }
    signing = recipe;
  }
  return {
    endpointId: ep.id, revision: agg.revision, method: r.method, url: full, origin: originNote, credentials, headers, body, bodyText, bodySummary, blocked,
    reserved: env.reserved, ...(auth && { auth }), ...(signing && { signing }),
  };
}

// ---------- result and checks

export type BodyState = 'complete' | 'truncated' | 'none' | 'unreadable';
export interface OnceResult {
  /** blocked = refused before dispatch (nothing was sent). */
  outcome: 'response' | 'network-error' | 'aborted' | 'blocked';
  status?: number;
  statusText?: string;
  headers: [string, string][];
  body: { state: BodyState; text: string; bytes: number; note?: string };
  ms: number;
  /** Dispatch to response headers (absent when none arrived). */
  headersMs?: number;
  error?: string;
  /** Rules mode: who answered, from the runtime record. */
  provider?: 'network' | 'mock' | 'synthetic';
  recordId?: number;
}
/** Direct = the captured native fetch; rules = the page pipeline, which reports its record. */
export type Transport = (url: string, init: RequestInit, onRecord?: (r: { id: number; provider: 'network' | 'mock' | 'synthetic' }) => void) => Promise<Response>;
export type CheckOutcome = { check: Check; state: 'passed' | 'failed' | 'not-evaluated'; detail: string };

export function describeCheck(c: Check): string {
  switch (c.kind) {
    case 'status': return c.min === c.max ? `Status is ${c.min}` : `Status ${c.min}–${c.max}`;
    case 'header': return c.value === undefined ? `Header ${c.name} present` : `Header ${c.name} = ${c.value}`;
    case 'body-contains': return `Body contains "${c.value}"`;
    case 'json': return c.mode === 'exists' ? `JSON ${c.path || '$'} exists` : c.mode === 'type' ? `JSON ${c.path || '$'} is ${c.value}` : `JSON ${c.path || '$'} = ${c.value}`;
    case 'duration': return `Completes within ${c.maxMs} ms`;
  }
}

/** Own-property path lookup: a.b[0].c. No prototype traversal. */
export function jsonAt(root: unknown, path: string): { found: boolean; value?: unknown } {
  const parts = path.replace(/^\$\.?/, '').match(/[^.[\]]+|\[\d+\]/g) ?? [];
  let cur: unknown = root;
  for (const raw of parts) {
    const key = raw.startsWith('[') ? Number(raw.slice(1, -1)) : raw;
    if (cur === null || typeof cur !== 'object' || cur instanceof Num || !Object.hasOwn(cur, key)) return { found: false };
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return { found: true, value: cur };
}

const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : v instanceof Num ? 'number' : typeof v);

export function evaluate(checks: Check[], r: OnceResult): CheckOutcome[] {
  return checks.map((check): CheckOutcome => {
    const ne = (detail: string): CheckOutcome => ({ check, state: 'not-evaluated', detail });
    const res = (ok: boolean, detail: string): CheckOutcome => ({ check, state: ok ? 'passed' : 'failed', detail });
    if (r.outcome !== 'response') return ne(r.outcome === 'aborted' ? 'Request was cancelled' : r.outcome === 'blocked' ? 'Nothing was sent' : 'No HTTP response');
    switch (check.kind) {
      case 'status': return res(r.status! >= check.min && r.status! <= check.max, `Got ${r.status}`);
      case 'duration': return res(r.ms <= check.maxMs, `Took ${r.ms} ms`);
      case 'header': {
        const h = r.headers.find(([k]) => k.toLowerCase() === check.name.toLowerCase());
        if (!h) return res(false, 'Header not present (or not exposed by CORS)');
        return check.value === undefined ? res(true, 'Present') : res(h[1] === check.value, `Got ${h[1]}`);
      }
      case 'body-contains':
      case 'json': {
        if (r.body.state !== 'complete') return ne(`Body is ${r.body.state}${r.body.note ? `: ${r.body.note}` : ''}; a partial body cannot pass`);
        if (check.kind === 'body-contains') return res(r.body.text.includes(check.value), r.body.text.includes(check.value) ? 'Found' : 'Not found');
        let doc: unknown;
        try { doc = parseExact(r.body.text); } catch { return res(false, 'Body is not valid JSON'); }
        const at = jsonAt(doc, check.path);
        if (check.mode === 'exists') return res(at.found, at.found ? 'Present' : 'Missing');
        if (!at.found) return res(false, 'Missing');
        if (check.mode === 'type') return res(typeOf(at.value) === check.value, `Is ${typeOf(at.value)}`);
        // Strings compare as-is; other values by their exact JSON text (100.10 stays 100.10).
        const got = typeof at.value === 'string' ? at.value : stringifyExact(at.value);
        return res(got === check.value, `Got ${got}`);
      }
    }
  });
}

/** Send a prepared request. Reads at most `limit` bytes of the body; the rest is cancelled, never buffered. */
export async function send(p: Prepared, transport: Transport, signal: AbortSignal, limit: number): Promise<OnceResult> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  // no-store: a tester send never reuses a cached response and never waits on the browser's cache lock
  // for an identical in-flight URL (which would serialize simultaneous plan jobs).
  const init: RequestInit = { method: p.method, headers: p.headers.map((h) => [h.name, h.value]), credentials: p.credentials, signal, cache: 'no-store' };
  if (p.body !== null) init.body = p.body;
  let res: Response;
  let rec: { id: number; provider: NonNullable<OnceResult['provider']> } | undefined;
  const tag = (o: OnceResult): OnceResult => (rec ? { ...o, recordId: rec.id, provider: rec.provider } : o);
  try {
    res = await transport(p.url, init, (r) => { rec = r; });
  } catch (e) {
    const aborted = signal.aborted;
    return tag({ outcome: aborted ? 'aborted' : 'network-error', headers: [], body: { state: 'none', text: '', bytes: 0 }, ms: ms(), error: aborted ? 'Cancelled before a response arrived' : `${(e as Error)?.name ?? 'Error'}: ${(e as Error)?.message ?? String(e)}` });
  }
  const out: OnceResult = { outcome: 'response', status: res.status, statusText: res.statusText, headers: [...res.headers], body: { state: 'none', text: '', bytes: 0 }, ms: 0, headersMs: ms() };
  if (res.body && p.method !== 'HEAD') {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let state: BodyState = 'complete';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const room = limit - total;
        if (value.byteLength > room) {
          chunks.push(value.subarray(0, room));
          total += room;
          state = 'truncated';
          reader.cancel().catch(() => {});
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    } catch (e) {
      if (signal.aborted) return tag({ ...out, outcome: 'aborted', ms: ms(), error: 'Cancelled while the body was arriving' });
      state = 'unreadable';
      out.body.note = String((e as Error)?.message ?? e);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
    out.body = { ...out.body, state, bytes: total, text: new TextDecoder().decode(bytes) };
    if (state === 'truncated') out.body.note = `stopped at the ${Math.round(limit / 1024)} KB body-check limit`;
  }
  out.ms = ms();
  return tag(out);
}

export function pageSources(): Sources {
  return {
    cookie(name) {
      for (const part of document.cookie.split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) {
          try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return part.slice(i + 1).trim(); }
        }
      }
      return undefined;
    },
    localStorage: (k) => { try { return window.localStorage.getItem(k) ?? undefined; } catch { return undefined; } },
    sessionStorage: (k) => { try { return window.sessionStorage.getItem(k) ?? undefined; } catch { return undefined; } },
    meta(name) {
      const found = document.querySelectorAll(`meta[name="${CSS.escape(name)}"]`);
      return found.length === 1 ? found[0]!.getAttribute('content') ?? undefined : undefined;
    },
    dom(selector, mode) {
      // One uniquely matching element; only its form value, text or a named attribute is read.
      const found = document.querySelectorAll(selector);
      if (found.length !== 1) return undefined;
      const el = found[0]!;
      if (mode === 'text') return el.textContent ?? undefined;
      if (mode.startsWith('attr:')) return el.getAttribute(mode.slice(5)) ?? undefined;
      return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? el.value : undefined;
    },
  };
}
