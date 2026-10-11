// Recorder capture: what one page call looked like, redacted when it is built. Adapters fill it only
// while the recorder is on; nothing here installs hooks, dispatches, or stores anything.
import { forbiddenHeader, sensitiveHeader, utf8Bytes, type Credentials, type Pair, type Part } from '../data/schema';
import type { Runtime } from './runtime';

export const CAP = {
  /** Request body text kept per call; larger bodies are omitted with a reason. */
  requestBytes: 64 * 1024,
  /** Response preview per call (the sample bound). */
  responseBytes: 16 * 1024,
  responseDeadlineMs: 2_000,
} as const;

export const REDACTED = '{{$redacted}}';

export type CapBody =
  | { kind: 'none' }
  | { kind: 'text'; text: string }
  | { kind: 'urlencoded'; pairs: Pair[] }
  | { kind: 'multipart'; parts: Part[] }
  | { kind: 'omitted'; reason: string };

export type ResBody = { text: string; truncated: boolean } | { omitted: string };

/** One observed call. Also the normalized form HAR entries are converted to. */
export interface Capture {
  /** Request record ID (recorder) or entry index (HAR): the response is joined by this, never by URL. */
  id: number;
  at: number;
  transport: 'fetch' | 'xhr' | 'har';
  source: 'page' | 'tester' | 'file';
  method: string;
  /** origin + pathname; query values live in `query`. */
  url: string;
  query: Pair[];
  headers: Pair[];
  credentials: Credentials;
  body: CapBody;
  /** Field names whose values were replaced by {{$redacted}}, and other fidelity notes. */
  redacted: string[];
  notes: string[];
  outcome: string;
  status?: number | undefined;
  resHeaders: Pair[];
  resBody?: ResBody;
  synthetic?: boolean;
  ms?: number | undefined;
}

const SECRET_FIELD = /^(key|api_?key|sig|otp|code|pin|pwd|pass|access_token|refresh_token|id_token)$/i;
export const sensitiveName = (n: string) => sensitiveHeader(n) || SECRET_FIELD.test(n.trim());

/** Header rows a script could replay: forbidden names dropped (noted), sensitive values redacted. */
export function cleanHeaders(rows: Iterable<[string, string]>, c: Pick<Capture, 'redacted' | 'notes'>, where = 'Header'): Pair[] {
  const out: Pair[] = [];
  for (const [k, v] of rows) {
    if (out.length >= 200) break;
    if (k.startsWith(':')) continue; // HTTP/2 pseudo-headers in HAR
    if (forbiddenHeader(k)) { c.notes.push(`${where} ${k} is set by the browser and was not kept`); continue; }
    if (sensitiveName(k)) { c.redacted.push(`${where} ${k}`); out.push([k, REDACTED]); } else out.push([k, v]);
  }
  return out;
}

export function cleanPairs(rows: Iterable<[string, string]>, c: Pick<Capture, 'redacted'>, where: string): Pair[] {
  return [...rows].slice(0, 200).map(([k, v]) => (sensitiveName(k) ? (c.redacted.push(`${where} ${k}`), [k, REDACTED]) : [k, v]) as Pair);
}

/** JSON text with sensitive keys redacted. Untouched text stays byte-exact; redacted JSON is re-serialized. */
export function redactText(text: string, contentType: string, c: Pick<Capture, 'redacted' | 'notes'>, where: string): string {
  if (!/json/i.test(contentType) && !/^\s*[[{]/.test(text)) return text;
  let x: unknown;
  try { x = JSON.parse(text); } catch {
    // Truncated or invalid JSON: redact "name": value pairs textually, including a value cut off at the end.
    return text.replace(/"([^"\\]{1,64})"(\s*:\s*)("(?:[^"\\]|\\.)*("|$)|-?\d[\d.eE+-]*)/g, (m, k: string, sep: string) => {
      if (!sensitiveName(k)) return m;
      c.redacted.push(`${where} field ${k}`);
      return `"${k}"${sep}"${REDACTED}"`;
    });
  }
  let hit = false;
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 64 || !v || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((e) => walk(e, depth + 1));
    const o: Record<string, unknown> = {};
    for (const [k, e] of Object.entries(v)) {
      if (sensitiveName(k) && (typeof e === 'string' || typeof e === 'number')) { hit = true; c.redacted.push(`${where} field ${k}`); o[k] = REDACTED; } else o[k] = walk(e, depth + 1);
    }
    return o;
  };
  const out = walk(x, 0);
  if (!hit) return text;
  c.notes.push(`${where} was re-serialized after redaction; spacing may differ from the original`);
  return JSON.stringify(out);
}

const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql)\b|[^;]*\+(json|xml)\b)/i;
export const textualType = (ct: string) => TEXTUAL.test(ct.trim());

export function newCapture(rec: { id: number; transport: 'fetch' | 'xhr'; source: string }, method: string, url: URL): Capture {
  const c: Capture = {
    id: rec.id, at: Date.now(), transport: rec.transport, source: rec.source === 'tester' ? 'tester' : 'page', method, url: url.origin + url.pathname,
    query: [], headers: [], credentials: 'same-origin', body: { kind: 'none' }, redacted: [], notes: [], outcome: 'pending', resHeaders: [],
  };
  c.query = cleanPairs(url.searchParams, c, 'Query');
  return c;
}

/** Classify a request body the page passed. Synchronous kinds only; a prebuilt Request is read by the fetch adapter. */
export function requestBody(body: unknown, contentType: string, c: Pick<Capture, 'redacted' | 'notes'>, max: number = CAP.requestBytes): CapBody {
  if (body == null) return { kind: 'none' };
  if (typeof body === 'string') {
    if (utf8Bytes(body) > max) return { kind: 'omitted', reason: `Request body over ${max / 1024} KiB was not captured` };
    if (/^application\/x-www-form-urlencoded\b/i.test(contentType)) return { kind: 'urlencoded', pairs: cleanPairs(new URLSearchParams(body), c, 'Form') };
    return { kind: 'text', text: redactText(body, contentType, c, 'Body') };
  }
  if (body instanceof URLSearchParams) return { kind: 'urlencoded', pairs: cleanPairs(body, c, 'Form') };
  if (body instanceof FormData) {
    const parts: Part[] = [];
    for (const [name, v] of body) {
      if (typeof v === 'string') parts.push({ kind: 'field', name, value: sensitiveName(name) ? (c.redacted.push(`Field ${name}`), REDACTED) : v });
      else parts.push({ kind: 'file', name, fileName: v.name });
    }
    if (parts.some((p) => p.kind === 'file')) c.notes.push('File contents are never captured; choose the files again when running');
    return { kind: 'multipart', parts };
  }
  if (body instanceof ReadableStream) return { kind: 'omitted', reason: 'Streaming request body cannot be captured' };
  if (typeof Document !== 'undefined' && body instanceof Document) return { kind: 'omitted', reason: 'Document request body is not captured' };
  return { kind: 'omitted', reason: 'Binary request body (Blob/ArrayBuffer) is not captured' };
}

/** Read up to `max` bytes of a stream we own (a clone), then cancel it. Never fails the page's copy. */
export async function readPrefix(stream: ReadableStream<Uint8Array>, max: number, deadlineMs: number, own: Runtime['own']): Promise<ResBody> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = '';
  let total = 0;
  let stop = '';
  const halt = (why: string) => { if (!stop) { stop = why; reader.cancel(why).catch(() => {}); } };
  const timer = setTimeout(() => halt(`Body not complete within ${deadlineMs} ms (stream or slow response); not captured`), deadlineMs);
  const release = own(() => halt('Workbench closed'));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (stop) return { omitted: stop };
      if (done) return { text: text + dec.decode(), truncated: false };
      const room = max - total;
      total += value.byteLength;
      if (value.byteLength > room) {
        text += dec.decode(value.subarray(0, room));
        halt('preview complete');
        return { text, truncated: true };
      }
      text += dec.decode(value, { stream: true });
    }
  } catch (e) {
    return { omitted: stop || `Body read failed: ${String(e)}` };
  } finally {
    clearTimeout(timer);
    release();
  }
}

/** Parse "name: value\r\n" header blocks (XHR getAllResponseHeaders). */
export const headerLines = (s: string): [string, string][] =>
  s.split(/\r?\n/).filter(Boolean).map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] as [string, string]; }).filter(([k]) => k);
