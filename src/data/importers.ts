// Format detection by content, dispatch to every adapter, and the HAR 1.2 adapter. Pure: parsing
// never dispatches, reads files or executes anything. HAR entries become the same redacted
// observed-call form the recorder uses; Swagger/OpenAPI/Postman/cURL/fetch become drafted requests.
import { CAP, cleanHeaders, cleanPairs, redactText, requestBody, sensitiveName, textualType, type Capture, type ResBody } from '../net/capture';
import { readImport, IMPORT_MAX_BYTES, type ImportRead } from './backup';
import { isSchema1 } from './migrate';
import type { Draft } from './review';
import { BOUNDS, utf8Bytes, type Diag, type Part } from './schema';
import { parseCurl, parseFetch } from './snippets';
import { parseOpenApi, parsePostman, parseSwagger } from './specs';

export type Format = 'auto' | 'native' | 'har' | 'swagger' | 'openapi' | 'postman' | 'curl-bash' | 'curl-cmd' | 'fetch';
export const FORMAT_NAMES: Record<Exclude<Format, 'auto'>, string> = {
  native: 'API Workbench export, backup or schema 1 JSON', har: 'HAR 1.2', swagger: 'Swagger 2.0 JSON', openapi: 'OpenAPI 3.0 JSON',
  postman: 'Postman collection v2.1', 'curl-bash': 'cURL (bash)', 'curl-cmd': 'cURL (Windows cmd)', fetch: 'Copied fetch',
};
export const HAR_MAX_ENTRIES = 1000;

export type Parsed =
  | { format: 'native'; label: string; read: ImportRead }
  | { format: 'har'; label: string; captures: Capture[]; skipped: string[]; notes: string[] }
  | { format: 'swagger' | 'openapi' | 'postman' | 'curl' | 'fetch'; label: string; drafts: Draft[]; skipped: string[]; notes: string[]; servers?: string[] };

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);
const fail = (message: string, path = ''): { ok: false; errors: Diag[] } => ({ ok: false, errors: [{ path, message }] });

/** What the content is, from its structure (discriminators and versions), never a file name. */
function observe(x: unknown, text: string): Exclude<Format, 'auto' | 'curl-cmd'> | 'curl' | string {
  if (isObj(x)) {
    if (x.format === 'api-workbench' || isSchema1(x)) return 'native';
    if (isObj(x.log) && Array.isArray(x.log.entries)) return 'har';
    if (x.swagger === '2.0' && isObj(x.paths)) return 'swagger';
    if (typeof x.swagger === 'string') return `Swagger ${x.swagger}`;
    if (typeof x.openapi === 'string' && isObj(x.paths)) return 'openapi';
    if (isObj(x.info) && Array.isArray(x.item) && (typeof x.info._postman_id === 'string' || String(x.info.schema ?? '').includes('schema.getpostman.com'))) return 'postman';
    if (isObj(x.info) && Array.isArray(x.requests)) return 'Postman collection v1';
    if (typeof x._postman_variable_scope === 'string' && Array.isArray(x.values)) return `Postman ${x._postman_variable_scope} file (variables only, not a collection; its values are not imported — enter them where requests name them)`;
    return 'unrecognized content';
  }
  if (x !== undefined) return 'unrecognized content';
  if (/^\s*curl\s|^\s*curl\.exe\s/i.test(text)) return 'curl';
  if (/^\s*(await\s+)?fetch\s*\(/.test(text)) return 'fetch';
  if (/^\s*(openapi|swagger)\s*:/m.test(text)) return 'YAML (only JSON documents are supported; convert it to JSON)';
  return 'unrecognized content';
}

const NAMES: Record<string, string> = { ...FORMAT_NAMES, curl: 'cURL command' };
const SUPPORTED = 'API Workbench JSON, HAR 1.2, Swagger 2.0 JSON, OpenAPI 3.0 JSON, Postman collection v2.1, cURL (bash or Windows cmd) and copied fetch';

export function parseSource(text: string, override: Format, o: { server?: number } = {}): { ok: true; value: Parsed } | { ok: false; errors: Diag[] } {
  if (utf8Bytes(text) > IMPORT_MAX_BYTES) return fail(`Input exceeds ${IMPORT_MAX_BYTES / 1024 / 1024} MiB; nothing was parsed`);
  if (!text.trim()) return fail('Paste or choose something to import');
  let x: unknown;
  let jsonError = '';
  try { x = JSON.parse(text); } catch (e) { jsonError = (e as Error).message; }
  const seen = observe(x, text);
  const wanted = override === 'curl-bash' || override === 'curl-cmd' ? 'curl' : override;
  if (override !== 'auto' && seen !== wanted) return fail(`Format is set to ${FORMAT_NAMES[override]}, but the content looks like ${NAMES[seen] ?? seen}`);
  if (seen === 'curl') {
    const r = parseCurl(text, override === 'curl-bash' ? 'bash' : override === 'curl-cmd' ? 'cmd' : undefined);
    return r.ok ? { ok: true, value: { format: 'curl', ...r.value } } : r;
  }
  if (seen === 'fetch') {
    const r = parseFetch(text);
    return r.ok ? { ok: true, value: { format: 'fetch', ...r.value } } : r;
  }
  if (jsonError) return fail(seen === 'unrecognized content' ? `Not valid JSON, cURL or fetch: ${jsonError}. Supported: ${SUPPORTED}.` : `Detected ${seen}. Supported: ${SUPPORTED}.`);
  if (seen === 'swagger' || seen === 'openapi' || seen === 'postman') {
    const r = seen === 'swagger' ? parseSwagger(x as Obj) : seen === 'openapi' ? parseOpenApi(x as Obj, o.server) : parsePostman(x as Obj);
    return r.ok ? { ok: true, value: { format: seen, ...r.value } } : r;
  }
  if (seen === 'native') {
    const r = readImport(text);
    if (!r.ok) return r;
    const label = r.value.kind === 'backup' ? 'API Workbench backup (schema 2)' : r.value.kind === 'schema1' ? 'API Workbench schema 1 data (migrated preview)' : 'API Workbench profile export (schema 2)';
    return { ok: true, value: { format: 'native', label, read: r.value } };
  }
  if (seen === 'har') return parseHar(x as Obj);
  return fail(`Detected ${seen}. Supported: ${SUPPORTED}.`);
}

// ---------- HAR 1.2

const str = (x: unknown) => (typeof x === 'string' ? x : '');
const rows = (x: unknown): [string, string][] => (Array.isArray(x) ? x.filter(isObj).map((h) => [str(h.name), str(h.value)] as [string, string]).filter(([k]) => k) : []);

function harContent(content: Obj, c: Capture): ResBody {
  const mime = str(content.mimeType);
  let text = str(content.text);
  if (content.text === undefined) return { omitted: 'The HAR file does not include this response body' };
  if (content.encoding === 'base64') {
    if (!textualType(mime)) return { omitted: `Base64 ${mime || 'binary'} response is not imported as text` };
    try { text = new TextDecoder().decode(Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0))); } catch { return { omitted: 'Base64 response body did not decode' }; }
  } else if (content.encoding !== undefined) return { omitted: `Response encoding ${String(content.encoding)} is not supported` };
  const bytes = new TextEncoder().encode(text);
  const truncated = bytes.byteLength > CAP.responseBytes;
  return { text: redactText(truncated ? new TextDecoder().decode(bytes.subarray(0, CAP.responseBytes)) : text, mime, c, 'Response body'), truncated };
}

function parseHar(x: Obj): { ok: true; value: Parsed } | { ok: false; errors: Diag[] } {
  const log = x.log as Obj;
  const version = str(log.version);
  if (version !== '1.2' && version !== '1.1') return fail(`HAR version ${version || '(missing)'} is not supported; expected 1.2`, 'log.version');
  const entries = log.entries as unknown[];
  if (entries.length > HAR_MAX_ENTRIES) return fail(`HAR has ${entries.length} entries; at most ${HAR_MAX_ENTRIES} can be reviewed`, 'log.entries');
  const notes: string[] = [];
  if (isObj(log.creator)) notes.push(`Created by ${str(log.creator.name) || 'unknown'} ${str(log.creator.version)}`.trim());
  if (version === '1.1') notes.push('HAR 1.1 read with the 1.2 field rules');
  const skipped: string[] = [];
  const captures: Capture[] = [];
  entries.forEach((raw, i) => {
    const where = `Entry ${i + 1}`;
    if (!isObj(raw) || !isObj(raw.request)) return skipped.push(`${where}: no request`);
    const req = raw.request;
    let url: URL;
    try { url = new URL(str(req.url)); } catch { return skipped.push(`${where}: invalid URL`); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return skipped.push(`${where}: ${url.protocol} requests are not HTTP calls`);
    const c: Capture = {
      id: i, at: Date.parse(str(raw.startedDateTime)) || 0, transport: 'har', source: 'file', method: str(req.method).toUpperCase(),
      url: url.origin + url.pathname, query: [], headers: [], credentials: 'same-origin', body: { kind: 'none' }, redacted: [], notes: [], outcome: 'ok', resHeaders: [],
    };
    c.query = cleanPairs(url.searchParams, c, 'Query');
    const hdrs = rows(req.headers);
    if (hdrs.some(([k]) => k.toLowerCase() === 'cookie')) c.notes.push('Cookies were sent; replay uses this browser’s cookies, never the recorded ones');
    c.headers = cleanHeaders(hdrs, c);
    if (isObj(req.postData)) {
      const pd = req.postData;
      const mime = str(pd.mimeType);
      const params = Array.isArray(pd.params) ? pd.params.filter(isObj) : [];
      if (/^multipart\/form-data/i.test(mime)) {
        if (!params.length) c.body = { kind: 'omitted', reason: 'Multipart body without parsed params cannot be split into fields' };
        else c.body = { kind: 'multipart', parts: params.slice(0, BOUNDS.rows).map((p): Part => (p.fileName !== undefined
          ? { kind: 'file', name: str(p.name), fileName: str(p.fileName) }
          : { kind: 'field', name: str(p.name), value: sensitiveName(str(p.name)) ? (c.redacted.push(`Field ${str(p.name)}`), '{{$redacted}}') : str(p.value) })) };
        if (params.some((p) => p.fileName !== undefined)) c.notes.push('File contents are never imported; choose the files again when running');
      } else if (/^application\/x-www-form-urlencoded/i.test(mime) && params.length && pd.text === undefined) {
        c.body = { kind: 'urlencoded', pairs: cleanPairs(params.map((p) => [str(p.name), str(p.value)] as [string, string]), c, 'Form') };
      } else if (pd.text !== undefined) {
        c.body = utf8Bytes(str(pd.text)) > BOUNDS.bodyBytes ? { kind: 'omitted', reason: `Request body over ${BOUNDS.bodyBytes / 1024 / 1024} MiB` } : requestBody(str(pd.text), mime, c, BOUNDS.bodyBytes);
      }
      if (!c.headers.some(([k]) => k.toLowerCase() === 'content-type') && mime && c.body.kind === 'text') c.headers.push(['Content-Type', mime]);
    }
    const res = isObj(raw.response) ? raw.response : null;
    const status = res && typeof res.status === 'number' ? res.status : 0;
    if (!res || status <= 0) { c.outcome = 'unfinished'; c.notes.push('Response missing or unfinished in the HAR'); }
    else {
      c.status = status;
      c.resHeaders = rows(res.headers).filter(([k]) => !sensitiveName(k) && k.toLowerCase() !== 'set-cookie');
      c.resBody = isObj(res.content) ? harContent(res.content, c) : { omitted: 'No response content' };
    }
    if (typeof raw.time === 'number' && raw.time >= 0) c.ms = raw.time;
    captures.push(c);
  });
  if (!captures.length) return { ok: false, errors: [{ path: 'log.entries', message: entries.length ? `No importable entries (${skipped.slice(0, 3).join('; ')})` : 'The HAR has no entries' }] };
  return { ok: true, value: { format: 'har', label: `HAR ${version}`, captures, skipped, notes } };
}

/** Recorder draft as a HAR 1.2 file (already redacted), so it can be kept or imported later. */
export function capturesToHar(captures: Capture[], version: string): string {
  const pairs = (p: [string, string][]) => p.map(([name, value]) => ({ name, value }));
  const entries = captures.map((c) => {
    const query = c.query.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const ct = c.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
    const b = c.body;
    const postData = b.kind === 'text' ? { mimeType: ct || 'text/plain', text: b.text }
      : b.kind === 'urlencoded' ? { mimeType: 'application/x-www-form-urlencoded', params: pairs(b.pairs) }
      : b.kind === 'multipart' ? { mimeType: 'multipart/form-data', params: b.parts.map((p) => (p.kind === 'file' ? { name: p.name, fileName: p.fileName } : { name: p.name, value: p.value })) }
      : undefined;
    const rb = c.resBody;
    return {
      startedDateTime: new Date(c.at || 0).toISOString(),
      time: c.ms ?? 0,
      request: { method: c.method, url: c.url + (query ? `?${query}` : ''), httpVersion: '', headers: pairs(c.headers), queryString: pairs(c.query), cookies: [], headersSize: -1, bodySize: -1, ...(postData && { postData }) },
      response: { status: c.status ?? 0, statusText: '', httpVersion: '', headers: pairs(c.resHeaders), cookies: [], content: { size: -1, mimeType: c.resHeaders.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '', ...(rb && 'text' in rb && { text: rb.text }) }, redirectURL: '', headersSize: -1, bodySize: -1 },
      cache: {}, timings: { send: 0, wait: c.ms ?? 0, receive: 0 },
      comment: [c.body.kind === 'omitted' ? `request body: ${c.body.reason}` : '', rb && 'omitted' in rb ? `response body: ${rb.omitted}` : rb?.truncated ? 'response body truncated' : '', c.redacted.length ? `redacted: ${c.redacted.join(', ')}` : ''].filter(Boolean).join('; '),
    };
  });
  return JSON.stringify({ log: { version: '1.2', creator: { name: 'API Workbench recorder', version }, entries } }, null, 2);
}
