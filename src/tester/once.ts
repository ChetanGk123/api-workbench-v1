// One request preparation path (Once now, plans in R6), declarative checks and a cancellable send.
// Preparation is pure given its inputs: page sources and selected files are passed in.
import { forbiddenHeader, sensitiveHeader, type Aggregate, type Check, type Endpoint } from '../data/schema';

/** Page values read at dispatch. Each returns undefined when the source has no such value. */
export interface Sources {
  cookie(name: string): string | undefined;
  localStorage(key: string): string | undefined;
  sessionStorage(key: string): string | undefined;
  meta(name: string): string | undefined;
}

export interface PreparedHeader { name: string; value: string; shown: string; from: 'global' | 'endpoint' | 'body' }
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
  bodySummary: string;
  /** Exact reasons dispatch is blocked; empty when it can be sent. */
  blocked: string[];
}

const SOURCE = /^\$(cookie|localStorage|sessionStorage|meta)\(\s*"([^"\\]{1,256})"\s*\)$/;

/**
 * Resolve {{...}} in one field. R2 resolves the page-source builtins only; every other expression
 * (producer references, generators, $eval) blocks dispatch by name until the R6 expression engine.
 */
export function resolve(text: string, where: string, src: Sources, blocked: string[], secret: { hit: boolean }): string {
  return text.replace(/\{\{([^}]*)\}\}/g, (_m, inner: string) => {
    const expr = inner.trim();
    if (expr === '$redacted') { blocked.push(`${where}: value was redacted on export; enter it again`); return ''; }
    const m = SOURCE.exec(expr);
    if (!m) { blocked.push(`${where}: {{${expr}}} needs the expression engine (not in this build)`); return ''; }
    let v: string | undefined;
    try { v = src[m[1] as keyof Sources](m[2]!); } catch { v = undefined; }
    if (v === undefined) { blocked.push(`${where}: ${m[1]} "${m[2]}" is not available on this page`); return ''; }
    secret.hit = true;
    return v;
  });
}

export const mask = (v: string) => (v.length <= 4 ? '••••' : `••••${v.slice(-4)} (${v.length} chars)`);

/** Build the exact request an endpoint describes, in the profile's active environment. */
export function prepare(agg: Aggregate, ep: Endpoint, pageOrigin: string, src: Sources, files: ReadonlyMap<number, File>): Prepared {
  const blocked: string[] = [];
  const r = ep.request;
  const env = agg.profile.environments[agg.profile.activeEnvironment] ?? {};
  let origin = '';
  let originNote = 'absolute URL (environments do not retarget it)';
  if (r.hostKey !== null) {
    const mapped = env[r.hostKey];
    if (mapped === undefined) blocked.push(`Host "${r.hostKey}" has no origin in environment "${agg.profile.activeEnvironment}"`);
    origin = mapped || pageOrigin;
    originNote = `host ${r.hostKey} → ${mapped ? mapped : `this page (${pageOrigin})`} · environment ${agg.profile.activeEnvironment}`;
  }
  const s = { hit: false };
  let url = resolve(r.url, 'URL', src, blocked, s);
  const q = r.query.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(resolve(v, `Query ${k}`, src, blocked, s))}`).join('&');
  if (q) url += (url.includes('?') ? '&' : '?') + q;
  let full = '';
  try { full = new URL(origin + url).href; } catch { if (!blocked.length) blocked.push('URL is not valid after resolving its values'); }

  // Header precedence: global defaults → endpoint overrides/removals (case-insensitive; empty value is not removal).
  const merged = new Map<string, PreparedHeader>();
  for (const h of agg.profile.globalHeaders) merged.set(h.name.toLowerCase(), { name: h.name, value: h.value, shown: '', from: 'global' });
  for (const h of r.headers) {
    if (h.remove) merged.delete(h.name.toLowerCase());
    else merged.set(h.name.toLowerCase(), { name: h.name, value: h.value, shown: '', from: 'endpoint' });
  }
  const headers: PreparedHeader[] = [];
  for (const h of merged.values()) {
    const sec = { hit: false };
    const value = resolve(h.value, `Header ${h.name}`, src, blocked, sec);
    if (forbiddenHeader(h.name)) blocked.push(`Header ${h.name} cannot be set by scripts`);
    if (/[\r\n]/.test(value)) blocked.push(`Header ${h.name} resolved to a value with a line break`);
    headers.push({ ...h, value, shown: sec.hit || sensitiveHeader(h.name) ? mask(value) : value });
  }
  const has = (n: string) => headers.some((h) => h.name.toLowerCase() === n);

  let body: BodyInit | null = null;
  let bodySummary = 'No body';
  const b = r.body;
  if (b.kind !== 'none' && (r.method === 'GET' || r.method === 'HEAD')) blocked.push(`${r.method} cannot send a body`);
  else if (b.kind === 'text' || b.kind === 'json') {
    body = resolve(b.text, 'Body', src, blocked, s);
    bodySummary = `${b.kind === 'json' ? 'JSON' : 'Text'} · ${new TextEncoder().encode(body).byteLength} bytes, sent exactly as written`;
    if (b.kind === 'json' && !has('content-type')) headers.push({ name: 'Content-Type', value: 'application/json', shown: 'application/json', from: 'body' });
  } else if (b.kind === 'urlencoded') {
    body = new URLSearchParams(b.pairs.map(([k, v]) => [k, resolve(v, `Form ${k}`, src, blocked, s)]));
    bodySummary = `URL-encoded · ${b.pairs.length} fields in order`;
  } else if (b.kind === 'multipart') {
    if (has('content-type')) blocked.push('Remove the Content-Type header: multipart boundaries come from the browser');
    const fd = new FormData();
    let size = 0;
    b.parts.forEach((p, i) => {
      if (p.kind === 'field') fd.append(p.name, resolve(p.value, `Field ${p.name}`, src, blocked, s));
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
  return { endpointId: ep.id, revision: agg.revision, method: r.method, url: full, origin: originNote, credentials: r.credentials, headers, body, bodySummary, blocked };
}

// ---------- result and checks

export type BodyState = 'complete' | 'truncated' | 'none' | 'unreadable';
export interface OnceResult {
  outcome: 'response' | 'network-error' | 'aborted';
  status?: number;
  statusText?: string;
  headers: [string, string][];
  body: { state: BodyState; text: string; bytes: number; note?: string };
  ms: number;
  error?: string;
}
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
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, key)) return { found: false };
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return { found: true, value: cur };
}

const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

export function evaluate(checks: Check[], r: OnceResult): CheckOutcome[] {
  return checks.map((check): CheckOutcome => {
    const ne = (detail: string): CheckOutcome => ({ check, state: 'not-evaluated', detail });
    const res = (ok: boolean, detail: string): CheckOutcome => ({ check, state: ok ? 'passed' : 'failed', detail });
    if (r.outcome !== 'response') return ne(r.outcome === 'aborted' ? 'Request was cancelled' : 'No HTTP response');
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
        try { doc = JSON.parse(r.body.text); } catch { return res(false, 'Body is not valid JSON'); }
        const at = jsonAt(doc, check.path);
        if (check.mode === 'exists') return res(at.found, at.found ? 'Present' : 'Missing');
        if (!at.found) return res(false, 'Missing');
        if (check.mode === 'type') return res(typeOf(at.value) === check.value, `Is ${typeOf(at.value)}`);
        // Strings compare as-is; other values by their JSON text (number formatting follows JSON.parse).
        const got = typeof at.value === 'string' ? at.value : JSON.stringify(at.value);
        return res(got === check.value, `Got ${got}`);
      }
    }
  });
}

/** Send a prepared request. Reads at most `limit` bytes of the body; the rest is cancelled, never buffered. */
export async function send(p: Prepared, transport: typeof fetch, signal: AbortSignal, limit: number): Promise<OnceResult> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const init: RequestInit = { method: p.method, headers: p.headers.map((h) => [h.name, h.value]), credentials: p.credentials, signal };
  if (p.body !== null) init.body = p.body;
  let res: Response;
  try {
    res = await transport(p.url, init);
  } catch (e) {
    const aborted = signal.aborted;
    return { outcome: aborted ? 'aborted' : 'network-error', headers: [], body: { state: 'none', text: '', bytes: 0 }, ms: ms(), error: aborted ? 'Cancelled before a response arrived' : `${(e as Error)?.name ?? 'Error'}: ${(e as Error)?.message ?? String(e)}` };
  }
  const out: OnceResult = { outcome: 'response', status: res.status, statusText: res.statusText, headers: [...res.headers], body: { state: 'none', text: '', bytes: 0 }, ms: 0 };
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
      if (signal.aborted) return { ...out, outcome: 'aborted', ms: ms(), error: 'Cancelled while the body was arriving' };
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
  return out;
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
  };
}
