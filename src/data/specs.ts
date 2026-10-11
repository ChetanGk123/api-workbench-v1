// Document adapters: Swagger 2.0, OpenAPI 3.0 and Postman collection v2.1 become drafted requests.
// Pure: no remote $ref is fetched, no script runs, no value is invented. What the document does not
// supply becomes a labelled {{$missing("…")}} marker that blocks dispatch and is listed as required.
import { cleanHeaders, cleanPairs, redactText, type Capture } from '../net/capture';
import type { Draft } from './review';
import { BOUNDS, forbiddenHeader, utf8Bytes, type Body, type Pair, type Part, type Sample } from './schema';

type Obj = Record<string, unknown>;
export const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown) => (typeof x === 'string' ? x : '');
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
/** A labelled marker that blocks dispatch until the user enters the value. */
export const missing = (label: string) => `{{$missing("${label.replace(/[^\w .:/-]+/g, '').slice(0, 64)}")}}`;
const MARKER = /\{\{\$missing\("[^"]*"\)\}\}/g;

/** cleanHeaders, except a value that is only a marker (with an optional scheme) is not a secret to redact. */
export function draftHeaders(rows: Pair[], r: Red): Pair[] {
  return rows.flatMap(([k, v]) => (v.includes('{{$missing(') && !v.replace(MARKER, '').replace(/^(Bearer|Basic)\s*$/i, '').trim() ? (forbiddenHeader(k) ? [] : [[k, v] as Pair]) : cleanHeaders([[k, v]], r)));
}
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'] as const;
/** Import limits owned by DATA: operations/requests per document, local $ref chain depth. */
export const DOC_LIMITS = { operations: 500, requests: 500, refChain: 8, folderDepth: 16 } as const;
const MAX_MEDIA = 10;
const MAX_EXAMPLES = 10;
/** Scheme prefixes for URLs built from document parts (kept apart so the bundle has no literal URL text). */
export const HTTP = 'http:', HTTPS = 'https:';

/** Redaction notes collected while a draft is built (same rules as the recorder and HAR). */
export type Red = Pick<Capture, 'redacted' | 'notes'>;
export const red = (): Red => ({ redacted: [], notes: [] });

/** cleanPairs, except marker values are kept. */
export const draftPairs = (rows: Pair[], r: Red, where: string): Pair[] => rows.map(([k, v]) => (v.includes('{{$missing(') ? [k, v] : cleanPairs([[k, v]], r, where)[0]!) as Pair);

/** Requirements for values that were redacted (secrets are never imported). */
export function redactedRequires(r: Red): string[] {
  return [...new Set(r.redacted)].map((w) => `${w}: the source value is a secret and was not imported; enter it or use {{$context("…")}}`);
}

/** Text of an example value for a body of `mime`. Strings are kept exact. */
function exampleText(v: unknown, mime: string): string {
  if (typeof v === 'string') {
    if (!/json/i.test(mime)) return v;
    try { JSON.parse(v); return v; } catch { return JSON.stringify(v); }
  }
  return JSON.stringify(v, null, 2) ?? '';
}

/** A body for one media type and example value; binary types cannot be represented. */
function bodyFor(mime: string, v: unknown, r: Red, fileProps: string[] = [], exact = false): { body: Body; note?: string } {
  const m = mime.toLowerCase();
  if (/^multipart\/form-data/.test(m)) {
    const parts: Part[] = [];
    if (isObj(v)) for (const [k, x] of Object.entries(v).slice(0, BOUNDS.rows)) {
      if (fileProps.includes(k)) continue;
      parts.push({ kind: 'field', name: k, value: typeof x === 'string' ? x : JSON.stringify(x) ?? '' });
    }
    for (const k of fileProps) parts.push({ kind: 'file', name: k, fileName: '' });
    return { body: { kind: 'multipart', parts: parts.map((p) => (p.kind === 'field' ? { ...p, value: cleanPairs([[p.name, p.value]], r, 'Field')[0]![1] } : p)) } };
  }
  if (/^application\/x-www-form-urlencoded/.test(m)) {
    const pairs: Pair[] = typeof v === 'string' ? [...new URLSearchParams(v)] : isObj(v) ? Object.entries(v).flatMap(([k, x]) => (Array.isArray(x) ? x : [x]).map((y) => [k, typeof y === 'string' ? y : JSON.stringify(y) ?? ''] as Pair)) : [];
    return { body: { kind: 'urlencoded', pairs: cleanPairs(pairs, r, 'Form') } };
  }
  if (/^(application\/octet-stream|image\/|audio\/|video\/|application\/pdf|application\/zip)/.test(m)) {
    return { body: { kind: 'text', text: missing(`${mime} body`) }, note: `${mime} body is binary and cannot be imported as text; enter or choose it before sending` };
  }
  const text = exact && typeof v === 'string' ? v : exampleText(v, m);
  if (utf8Bytes(text) > BOUNDS.bodyBytes) return { body: { kind: 'text', text: missing('request body') }, note: `Example body over ${BOUNDS.bodyBytes / 1024 / 1024} MiB was not imported` };
  const clean = redactText(text, m, r, 'Body');
  return { body: /json/.test(m) ? { kind: 'json', text: clean } : { kind: 'text', text: clean } };
}

function sampleFrom(status: number, mime: string, v: unknown): Sample {
  let body = typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? '';
  let bodyState: Sample['bodyState'] = 'complete';
  while (utf8Bytes(body) > BOUNDS.sampleBytes) { body = body.slice(0, Math.floor(body.length * 0.9)); bodyState = 'truncated'; }
  return { status, headers: mime ? [['Content-Type', mime]] : [], body, bodyState, source: 'authored' };
}

// ---------- local $ref resolution (no remote fetch; cycle and depth bounded)

class Refs {
  notes = new Set<string>();
  constructor(private doc: Obj) {}
  /** Follow local refs. Remote, broken and cyclic refs resolve to undefined with a note. */
  get(x: unknown, where: string): unknown {
    const seen = new Set<string>();
    while (isObj(x) && typeof x.$ref === 'string') {
      const ref = x.$ref;
      if (!ref.startsWith('#/')) { this.notes.add(`${where}: remote reference ${ref} was not fetched`); return undefined; }
      if (seen.has(ref) || seen.size >= DOC_LIMITS.refChain) { this.notes.add(`${where}: reference ${ref} is cyclic or chained more than ${DOC_LIMITS.refChain} deep; not followed`); return undefined; }
      seen.add(ref);
      let cur: unknown = this.doc;
      for (const raw of ref.slice(2).split('/')) {
        const k = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
        if (k === '__proto__' || k === 'constructor' || k === 'prototype' || !isObj(cur) && !Array.isArray(cur)) { cur = undefined; break; }
        cur = Object.hasOwn(cur as object, k) ? (cur as Obj)[k] : undefined;
      }
      if (cur === undefined) { this.notes.add(`${where}: reference ${ref} does not resolve`); return undefined; }
      x = cur;
    }
    return x;
  }
}

// ---------- parameters (Swagger 2.0 and OpenAPI 3.0)

interface Found { value: unknown; how: string }

function paramExample(p: Obj, schema: Obj | undefined, refs: Refs, where: string): Found | null {
  if (p.example !== undefined) return { value: p.example, how: 'example' };
  if (isObj(p.examples)) {
    for (const [name, ex] of Object.entries(p.examples)) {
      const e = refs.get(ex, where);
      if (isObj(e) && e.value !== undefined) return { value: e.value, how: `example "${name}"` };
      if (isObj(e) && typeof e.externalValue === 'string') refs.notes.add(`${where}: external example ${e.externalValue} was not fetched`);
    }
  }
  if (p['x-example'] !== undefined) return { value: p['x-example'], how: 'x-example' };
  if (schema?.example !== undefined) return { value: schema.example, how: 'schema example' };
  if (p.default !== undefined) return { value: p.default, how: 'default' };
  if (schema?.default !== undefined) return { value: schema.default, how: 'schema default' };
  return null;
}

const prim = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null);

interface Req { url: string; query: Pair[]; headers: Pair[]; notes: string[]; requires: string[]; cookieAuth: boolean }

function applyParams(params: Obj[], req: Req, refs: Refs, where: string, swagger: boolean) {
  for (const p of params) {
    const name = str(p.name);
    const loc = str(p.in);
    if (!name || loc === 'body' || loc === 'formData') continue;
    const schema = swagger ? p : (refs.get(p.schema, where) as Obj | undefined);
    const f = paramExample(p, isObj(schema) ? schema : undefined, refs, where);
    const required = loc === 'path' || p.required === true;
    const label = `${loc} ${name}`;
    const need = () => { req.requires.push(`${label[0]!.toUpperCase()}${label.slice(1)}: the document gives no example; enter a value`); return missing(label); };
    if (loc === 'path') {
      let v: string | null = null;
      if (f) v = Array.isArray(f.value) ? f.value.map(prim).join(',') : prim(f.value);
      if (f && v === null) req.notes.push(`Path ${name}: the example is an object, which is not supported; enter a value`);
      const token = `{${name}}`;
      if (!req.url.includes(token)) { req.notes.push(`Path parameter ${name} is not in the path template`); continue; }
      req.url = req.url.split(token).join(v !== null ? encodeURIComponent(v) : need());
    } else if (loc === 'query') {
      if (!f) { if (required) req.query.push([name, need()]); else req.notes.push(`Optional query ${name} has no example and was left out`); continue; }
      const v = f.value;
      const style = str(p.style) || 'form';
      const explode = swagger ? p.collectionFormat === 'multi' : p.explode !== false && style === 'form';
      if (Array.isArray(v)) {
        if (explode) for (const x of v.slice(0, BOUNDS.rows)) req.query.push([name, prim(x) ?? JSON.stringify(x)]);
        else req.query.push([name, v.map((x) => prim(x) ?? '').join(({ ssv: ' ', tsv: '\t', pipes: '|', spaceDelimited: ' ', pipeDelimited: '|' } as Record<string, string>)[str(swagger ? p.collectionFormat : style)] ?? ',')]);
      } else if (isObj(v)) {
        if (style === 'deepObject') for (const [k, x] of Object.entries(v)) req.query.push([`${name}[${k}]`, prim(x) ?? JSON.stringify(x)]);
        else if (explode) for (const [k, x] of Object.entries(v)) req.query.push([k, prim(x) ?? JSON.stringify(x)]);
        else req.query.push([name, Object.entries(v).flatMap(([k, x]) => [k, prim(x) ?? '']).join(',')]);
      } else req.query.push([name, prim(v) ?? '']);
    } else if (loc === 'header') {
      const v = f ? (Array.isArray(f.value) ? f.value.map(prim).join(',') : prim(f.value)) : null;
      if (v === null && !required) { req.notes.push(`Optional header ${name} has no example and was left out`); continue; }
      req.headers.push([name, v ?? need()]);
    } else if (loc === 'cookie') {
      req.cookieAuth = true;
      req.notes.push(`Cookie parameter ${name}: cookies come from this browser; the request sends them with credentials: include`);
    }
  }
}

/** Operation parameters override path-level ones with the same name and location. */
function mergedParams(pathItem: Obj, op: Obj, refs: Refs, where: string): Obj[] {
  const out = new Map<string, Obj>();
  for (const raw of [...arr(pathItem.parameters), ...arr(op.parameters)]) {
    const p = refs.get(raw, where);
    if (isObj(p)) out.set(`${str(p.in)}:${str(p.name)}`, p);
  }
  return [...out.values()];
}

function applySecurity(doc: Obj, op: Obj, schemes: Obj, req: Req, refs: Refs) {
  const reqs = arr(op.security ?? doc.security).filter(isObj);
  if (!reqs.length) return;
  if (reqs.some((r) => !Object.keys(r).length)) { req.notes.push('Authentication is optional for this operation; none is applied'); return; }
  if (reqs.length > 1) req.notes.push(`Alternative security requirements: ${reqs.map((r) => Object.keys(r).join(' + ')).join(' or ')}; the first is used`);
  for (const name of Object.keys(reqs[0]!)) {
    const s = refs.get(schemes[name], `security ${name}`);
    if (!isObj(s)) { req.requires.push(`Security scheme ${name} is not defined in the document`); continue; }
    const type = str(s.type);
    const scheme = str(s.scheme).toLowerCase();
    if (type === 'apiKey' && s.in === 'header') {
      req.headers.push([str(s.name), missing(`API key ${name}`)]);
      req.requires.push(`Header ${str(s.name)}: API key (${name}); enter it or use {{$context("…")}}`);
    } else if (type === 'apiKey' && s.in === 'query') {
      req.query.push([str(s.name), missing(`API key ${name}`)]);
      req.requires.push(`Query ${str(s.name)}: API key (${name}); enter it`);
    } else if (type === 'apiKey' && s.in === 'cookie') {
      req.cookieAuth = true;
      req.notes.push(`API key ${name} is a cookie (${str(s.name)}); this browser's cookies are sent with credentials: include`);
    } else if (type === 'basic' || (type === 'http' && scheme === 'basic')) {
      req.headers.push(['Authorization', `Basic ${missing('basic credentials')}`]);
      req.requires.push(`Authorization: basic credentials (${name}) as base64 user:password; enter them`);
    } else if (type === 'http' && scheme === 'bearer') {
      req.headers.push(['Authorization', `Bearer ${missing(`bearer token ${name}`)}`]);
      req.requires.push(`Authorization: bearer token (${name}); enter it or use {{$context("…")}}, or attach an auth context`);
    } else {
      req.requires.push(`Security ${name} (${type}${scheme ? ` ${scheme}` : ''}${isObj(s.flows) ? ` ${Object.keys(s.flows).join('/')}` : str(s.flow) ? ` ${str(s.flow)}` : ''}) is not supported; configure an auth context for its token`);
    }
  }
}

function opName(op: Obj, method: string, path: string) {
  return str(op.summary).trim() || str(op.operationId) || `${method.toUpperCase()} ${path}`;
}

export interface DocResult { label: string; drafts: Draft[]; skipped: string[]; notes: string[]; servers?: string[] }
type R = { ok: true; value: DocResult } | { ok: false; errors: { path: string; message: string }[] };
const fail = (message: string, path = ''): R => ({ ok: false, errors: [{ path, message }] });

function eachOperation(doc: Obj, refs: Refs, fn: (path: string, method: string, pathItem: Obj, op: Obj, where: string) => void, skipped: string[]) {
  let n = 0;
  for (const [path, rawItem] of Object.entries(isObj(doc.paths) ? doc.paths : {})) {
    const item = refs.get(rawItem, `paths.${path}`);
    if (!isObj(item)) continue;
    for (const m of HTTP_METHODS) {
      if (!isObj(item[m])) continue;
      const where = `paths.${path}.${m}`;
      if (++n > DOC_LIMITS.operations) { skipped.push(`${where}: more than ${DOC_LIMITS.operations} operations; the rest were not read`); return; }
      fn(path, m, item, item[m] as Obj, where);
    }
    for (const k of Object.keys(item)) if (k === 'trace') skipped.push(`paths.${path}.trace: TRACE cannot be sent from a page`);
  }
}

function aliasNotes(drafts: Draft[], notes: string[]) {
  const ids = new Map<string, number>();
  for (const d of drafts) if (d.alias) ids.set(d.alias, (ids.get(d.alias) ?? 0) + 1);
  for (const [id, n] of ids) if (n > 1) notes.push(`operationId ${id} is used ${n} times; aliases get a numeric suffix`);
}

// ---------- Swagger 2.0

export function parseSwagger(doc: Obj): R {
  const refs = new Refs(doc);
  const notes: string[] = [];
  const skipped: string[] = [];
  const schemes = arr(doc.schemes).map(str);
  const host = str(doc.host);
  const basePath = str(doc.basePath).replace(/\/$/, '');
  let base = basePath;
  if (host) {
    const scheme = schemes.includes('https') ? 'https' : schemes.includes('http') ? 'http' : 'https';
    if (!schemes.length) notes.push('No schemes are declared; https is assumed');
    else if (!schemes.some((x) => x === 'https' || x === 'http')) notes.push(`Schemes ${schemes.join(', ')} are not HTTP; https is assumed`);
    base = `${scheme}:${'//'}${host}${basePath}`;
  } else notes.push('No host is declared; paths are relative to the first host key (or this page)');
  const drafts: Draft[] = [];
  const secDefs = isObj(doc.securityDefinitions) ? doc.securityDefinitions : {};
  eachOperation(doc, refs, (path, m, item, op, where) => {
    const r = red();
    const req: Req = { url: base + path, query: [], headers: [], notes: [], requires: [], cookieAuth: false };
    const params = mergedParams(item, op, refs, where);
    applyParams(params, req, refs, where, true);
    applySecurity(doc, op, secDefs, req, refs);
    const consumes = arr(op.consumes ?? doc.consumes).map(str).filter(Boolean);
    const bodies: Draft['bodies'] = [];
    const bodyParam = params.find((p) => p.in === 'body');
    const form = params.filter((p) => p.in === 'formData');
    if (bodyParam) {
      const schema = refs.get(bodyParam.schema, where);
      const mime = consumes.find((c) => /json/i.test(c)) ?? consumes[0] ?? 'application/json';
      const f = paramExample(bodyParam, isObj(schema) ? schema : undefined, refs, where);
      if (f) { const b = bodyFor(mime, f.value, r); bodies.push({ label: `${mime} · ${f.how}`, contentType: mime, body: b.body }); if (b.note) req.requires.push(b.note); }
      else if (bodyParam.required) { bodies.push({ label: mime, contentType: mime, body: { kind: 'text', text: missing('request body') } }); req.requires.push(`Request body (${mime}): the document has a schema but no example; enter it`); }
      else req.notes.push('Optional request body has a schema but no example; no body is sent');
    } else if (form.length) {
      const multipart = form.some((p) => p.type === 'file') || consumes.some((c) => /multipart\/form-data/i.test(c));
      const fields: Pair[] = [];
      const files: string[] = [];
      for (const p of form) {
        const name = str(p.name);
        if (p.type === 'file') { files.push(name); continue; }
        const f = paramExample(p, undefined, refs, where);
        if (f) fields.push([name, prim(f.value) ?? JSON.stringify(f.value)]);
        else if (p.required) { fields.push([name, missing(`form ${name}`)]); req.requires.push(`Form field ${name}: the document gives no example; enter a value`); }
        else req.notes.push(`Optional form field ${name} has no example and was left out`);
      }
      const mime = multipart ? 'multipart/form-data' : 'application/x-www-form-urlencoded';
      const b = bodyFor(mime, Object.fromEntries(fields), r, files);
      if (files.length) req.requires.push(`Choose ${files.length === 1 ? 'the file' : 'files'} for ${files.join(', ')} when running`);
      bodies.push({ label: mime, contentType: mime, body: b.body });
    }
    const resps = isObj(op.responses) ? op.responses : {};
    let sample: Sample | undefined;
    for (const code of Object.keys(resps).filter((c) => /^2\d\d$/.test(c)).sort()) {
      const resp = refs.get(resps[code], `${where}.responses.${code}`);
      if (!isObj(resp) || !isObj(resp.examples)) continue;
      const mime = Object.keys(resp.examples).find((k) => /json/i.test(k)) ?? Object.keys(resp.examples)[0];
      if (mime) { sample = sampleFrom(Number(code), mime, resp.examples[mime]); break; }
    }
    const headers = draftHeaders(req.headers, r);
    drafts.push({
      name: opName(op, m, path), ...(typeof op.operationId === 'string' && { alias: op.operationId }), method: m.toUpperCase(),
      url: req.url, query: draftPairs(req.query, r, 'Query'), headers, credentials: req.cookieAuth ? 'include' : 'same-origin',
      bodies, ...(sample && { sample }), source: `Swagger ${where}`,
      notes: [...(op.deprecated ? ['Deprecated operation'] : []), ...req.notes, ...r.notes], requires: [...req.requires, ...redactedRequires(r)],
    });
  }, skipped);
  aliasNotes(drafts, notes);
  notes.push(...refs.notes);
  if (!drafts.length) return fail(skipped[0] ?? 'The document has no operations', 'paths');
  return { ok: true, value: { label: `Swagger 2.0 · ${str(isObj(doc.info) ? doc.info.title : '') || 'untitled'}`, drafts, skipped, notes } };
}

// ---------- OpenAPI 3.0

function serverUrl(s: Obj): string {
  let url = str(s.url) || '/';
  const vars = isObj(s.variables) ? s.variables : {};
  url = url.replace(/\{([^}]+)\}/g, (m, k: string) => (isObj(vars[k]) && typeof vars[k].default === 'string' ? vars[k].default as string : m));
  return url.replace(/\/$/, '');
}

export function parseOpenApi(doc: Obj, serverIdx = 0): R {
  const version = str(doc.openapi);
  if (!/^3\.0\.\d+$/.test(version)) return fail(`OpenAPI ${version || '(missing version)'} is not supported; this build reads OpenAPI 3.0.x JSON (3.1 and YAML are not supported)`, 'openapi');
  const refs = new Refs(doc);
  const notes: string[] = [];
  const skipped: string[] = [];
  const servers = arr(doc.servers).filter(isObj);
  const serverList = servers.map(serverUrl);
  const comps = isObj(doc.components) ? doc.components : {};
  const schemes = isObj(comps.securitySchemes) ? comps.securitySchemes : {};
  const drafts: Draft[] = [];
  const baseFor = (list: unknown, idx: number, where: string) => {
    const ss = arr(list).filter(isObj);
    if (!ss.length) return null;
    const s = ss[Math.min(idx, ss.length - 1)]!;
    const url = serverUrl(s);
    if (/\{[^}]+\}/.test(url)) { notes.push(`${where}: server variable without a default in ${url}`); }
    return url;
  };
  const docBase = baseFor(doc.servers, serverIdx, 'servers') ?? '';
  if (!servers.length) notes.push('No servers are declared; paths are relative to the first host key (or this page)');
  eachOperation(doc, refs, (path, m, item, op, where) => {
    const r = red();
    const base = baseFor(op.servers, 0, where) ?? baseFor(item.servers, 0, `paths.${path}`) ?? docBase;
    const req: Req = { url: base + path, query: [], headers: [], notes: [], requires: [], cookieAuth: false };
    if (/\{[^}]+\}/.test(base)) { req.url = `${HTTPS}//${missing('server URL')}${path}`; req.requires.push('Server URL has a variable without a default; enter the origin'); }
    else if (req.url.startsWith('//')) req.url = HTTPS + req.url;
    else if (!/^https?:\/\//.test(req.url) && !req.url.startsWith('/')) req.url = `/${req.url}`;
    applyParams(mergedParams(item, op, refs, where), req, refs, where, false);
    applySecurity(doc, op, schemes, req, refs);
    const bodies: Draft['bodies'] = [];
    const rb = refs.get(op.requestBody, `${where}.requestBody`);
    if (isObj(rb) && isObj(rb.content)) {
      const media = Object.entries(rb.content).slice(0, MAX_MEDIA);
      if (Object.keys(rb.content).length > MAX_MEDIA) req.notes.push(`Only the first ${MAX_MEDIA} request media types were read`);
      for (const [mime, rawMt] of media) {
        if (!isObj(rawMt)) continue;
        const schema = refs.get(rawMt.schema, `${where}.requestBody`);
        const s = isObj(schema) ? schema : undefined;
        const props = s && isObj(s.properties) ? s.properties : {};
        const fileProps = Object.entries(props).filter(([, p]) => { const q = refs.get(p, where); return isObj(q) && (q.format === 'binary' || q.format === 'base64'); }).map(([k]) => k);
        const add = (v: unknown, how: string) => {
          if (bodies.length >= MAX_EXAMPLES) return;
          const b = bodyFor(mime, v, r, fileProps);
          bodies.push({ label: `${mime} · ${how}`, contentType: mime, body: b.body });
          if (b.note && !req.requires.includes(b.note)) req.requires.push(b.note);
        };
        if (isObj(rawMt.examples) && Object.keys(rawMt.examples).length) {
          for (const [name, ex] of Object.entries(rawMt.examples)) {
            const e = refs.get(ex, `${where}.requestBody`);
            if (isObj(e) && e.value !== undefined) add(e.value, `example "${name}"`);
            else if (isObj(e) && typeof e.externalValue === 'string') req.notes.push(`Example ${name} is external (${e.externalValue}) and was not fetched`);
          }
        } else if (rawMt.example !== undefined) add(rawMt.example, 'example');
        else if (s?.example !== undefined) add(s.example, 'schema example');
        else if (/^(multipart\/form-data|application\/x-www-form-urlencoded)/i.test(mime) && Object.keys(props).length) {
          const required = arr(s?.required).map(str);
          const fields: Obj = {};
          for (const [k, p] of Object.entries(props)) {
            if (fileProps.includes(k)) continue;
            const q = refs.get(p, where);
            const f = isObj(q) ? paramExample({}, q, refs, where) : null;
            if (f) fields[k] = f.value;
            else if (required.includes(k)) { fields[k] = missing(`field ${k}`); req.requires.push(`Field ${k}: the document gives no example; enter a value`); }
          }
          add(fields, 'fields from schema');
          if (fileProps.length) req.requires.push(`Choose ${fileProps.length === 1 ? 'the file' : 'files'} for ${fileProps.join(', ')} when running`);
        } else if (/^(application\/octet-stream|image\/|audio\/|video\/|application\/pdf|application\/zip)/i.test(mime)) {
          add(undefined, 'binary');
        } else {
          req.notes.push(`Request body ${mime} has a schema but no example`);
          if (rb.required === true) bodies.push({ label: `${mime} · no example`, contentType: mime, body: { kind: 'text', text: missing('request body') } });
        }
      }
      if (rb.required === true && bodies.some((b) => b.body.kind === 'text' && b.body.text === missing('request body')) && !req.requires.some((t) => t.startsWith('Request body'))) req.requires.push('Request body: the document has a schema but no example; enter it');
    }
    const resps = isObj(op.responses) ? op.responses : {};
    let sample: Sample | undefined;
    for (const code of Object.keys(resps).filter((c) => /^2\d\d$/.test(c)).sort()) {
      const resp = refs.get(resps[code], `${where}.responses.${code}`);
      if (!isObj(resp) || !isObj(resp.content)) continue;
      for (const [mime, mt] of Object.entries(resp.content)) {
        if (!isObj(mt)) continue;
        let v: unknown;
        if (mt.example !== undefined) v = mt.example;
        else if (isObj(mt.examples)) { const first = refs.get(Object.values(mt.examples)[0], where); if (isObj(first)) v = first.value; }
        if (v !== undefined) { sample = sampleFrom(Number(code), mime, v); break; }
      }
      if (sample) break;
    }
    drafts.push({
      name: opName(op, m, path), ...(typeof op.operationId === 'string' && { alias: op.operationId }), method: m.toUpperCase(),
      url: req.url, query: draftPairs(req.query, r, 'Query'), headers: draftHeaders(req.headers, r), credentials: req.cookieAuth ? 'include' : 'same-origin',
      bodies, ...(sample && { sample }), source: `OpenAPI ${where}`,
      notes: [...(op.deprecated ? ['Deprecated operation'] : []), ...req.notes, ...r.notes], requires: [...req.requires, ...redactedRequires(r)],
    });
  }, skipped);
  aliasNotes(drafts, notes);
  notes.push(...refs.notes);
  if (serverList.length > 1) notes.push(`Server: ${serverList[Math.min(serverIdx, serverList.length - 1)]} (${serverList.length} declared)`);
  if (!drafts.length) return fail(skipped[0] ?? 'The document has no operations', 'paths');
  return { ok: true, value: { label: `OpenAPI ${version} · ${str(isObj(doc.info) ? doc.info.title : '') || 'untitled'}`, drafts, skipped, notes, ...(serverList.length > 1 && { servers: serverList }) } };
}

// ---------- Postman collection v2.1

type Vars = Map<string, string>;
const DYNAMIC: Record<string, string> = { $guid: '{{$uuid}}', $randomUUID: '{{$uuid}}' };

/** Replace {{var}} with collection/folder values. Unknown or script-made variables become markers. */
function resolver(unresolved: Set<string>) {
  return function sub(text: string, vars: Vars, depth = 0): string {
    return text.replace(/\{\{([^{}]+)\}\}/g, (_m, raw: string) => {
      const k = raw.trim();
      if (k.startsWith('$')) { if (DYNAMIC[k]) return DYNAMIC[k]; unresolved.add(k); return missing(`Postman ${k}`); }
      const v = vars.get(k);
      if (v === undefined) { unresolved.add(k); return missing(`variable ${k}`); }
      return depth < 5 ? sub(v, vars, depth + 1) : v;
    });
  };
}

function varsOf(list: unknown, into: Vars, notes: string[], where: string) {
  for (const v of arr(list).filter(isObj)) {
    const k = str(v.key) || str(v.id);
    if (!k) continue;
    if (v.disabled === true) { notes.push(`${where}: variable ${k} is disabled and was not used`); continue; }
    into.set(k, typeof v.value === 'string' ? v.value : v.value === undefined || v.value === null ? '' : JSON.stringify(v.value));
  }
}

/** Auth params come as [{key, value}] (v2.1) or {key: value} (v2.0). */
function authParam(auth: Obj, type: string, key: string): string | undefined {
  const p = auth[type];
  if (Array.isArray(p)) { const hit = p.filter(isObj).find((x) => x.key === key); return hit ? (typeof hit.value === 'string' ? hit.value : String(hit.value ?? '')) : undefined; }
  if (isObj(p) && p[key] !== undefined) return String(p[key]);
  return undefined;
}

function scriptNotes(events: unknown, where: string): string[] {
  return arr(events).filter(isObj).filter((e) => isObj(e.script) && arr((e.script as Obj).exec).some((l) => str(l).trim())).map((e) => `${where}: ${str(e.listen) || 'script'} script was not run`);
}

export function parsePostman(doc: Obj): R {
  const info = isObj(doc.info) ? doc.info : {};
  const schema = str(info.schema);
  if (/collection\/v1/.test(schema) || Array.isArray(doc.requests)) return fail('Postman collection v1 is not supported; export as Collection v2.1');
  const v20 = /collection\/v2\.0/.test(schema);
  if (!/collection\/v2\.[01]/.test(schema)) return fail(`Postman schema ${schema || '(missing)'} is not supported; export as Collection v2.1`, 'info.schema');
  const notes: string[] = v20 ? ['Collection v2.0 read with the v2.1 field rules'] : [];
  const skipped: string[] = [];
  const drafts: Draft[] = [];
  const rootVars: Vars = new Map();
  varsOf(doc.variable, rootVars, notes, 'Collection');
  notes.push(...scriptNotes(doc.event, 'Collection'));
  notes.push('Environment, global and script-set variables are not part of a collection; requests that use them name each one under “Needs before sending”');
  let count = 0;

  const walk = (items: unknown, trail: string[], vars: Vars, auth: Obj | null, depth: number) => {
    if (depth > DOC_LIMITS.folderDepth) { skipped.push(`${trail.join(' / ')}: folders nested deeper than ${DOC_LIMITS.folderDepth} levels were not read`); return; }
    for (const it of arr(items)) {
      if (!isObj(it)) continue;
      const name = str(it.name) || '(unnamed)';
      const path = [...trail, name];
      const where = path.join(' / ');
      const scope: Vars = new Map(vars);
      varsOf(it.variable, scope, notes, where);
      const ownAuth = isObj(it.auth) ? it.auth : null;
      if (Array.isArray(it.item)) {
        notes.push(...scriptNotes(it.event, where));
        walk(it.item, path, scope, ownAuth ?? auth, depth + 1);
        continue;
      }
      if (++count > DOC_LIMITS.requests) { skipped.push(`${where}: more than ${DOC_LIMITS.requests} requests; the rest were not read`); return; }
      const rq = typeof it.request === 'string' ? { url: it.request, method: 'GET' } as Obj : isObj(it.request) ? it.request : null;
      if (!rq) { skipped.push(`${where}: no request`); continue; }
      const d = postmanRequest(rq, it, where, scope, isObj(rq.auth) ? rq.auth : ownAuth ?? auth);
      if (typeof d === 'string') skipped.push(`${where}: ${d}`); else drafts.push(d);
    }
  };
  walk(doc.item, [], rootVars, isObj(doc.auth) ? doc.auth : null, 0);
  if (!drafts.length) return fail(skipped[0] ?? 'The collection has no requests', 'item');
  return { ok: true, value: { label: `Postman collection ${v20 ? 'v2.0' : 'v2.1'} · ${str(info.name) || 'untitled'}`, drafts, skipped, notes } };
}

function postmanRequest(rq: Obj, item: Obj, where: string, vars: Vars, auth: Obj | null): Draft | string {
  const unresolved = new Set<string>();
  const sub = resolver(unresolved);
  const r = red();
  const notes: string[] = [...scriptNotes(item.event, 'This request')];
  const requires: string[] = [];
  const method = (sub(str(rq.method) || 'GET', vars)).toUpperCase();
  // URL: object form is authoritative (it carries disabled query rows and path variables).
  let rawUrl = '';
  let query: Pair[] = [];
  const u = rq.url;
  const pathVars: Vars = new Map();
  if (isObj(u)) {
    for (const v of arr(u.variable).filter(isObj)) if (str(v.key)) pathVars.set(str(v.key), typeof v.value === 'string' ? v.value : '');
    const host = Array.isArray(u.host) ? u.host.map(str).join('.') : str(u.host);
    const segs = Array.isArray(u.path) ? u.path.map((s) => (isObj(s) ? str(s.value) : str(s))) : str(u.path).split('/').filter(Boolean);
    if (host) {
      const proto = str(u.protocol);
      rawUrl = `${proto ? `${proto}:${'//'}` : ''}${host}${str(u.port) ? `:${str(u.port)}` : ''}/${segs.join('/')}`;
    } else rawUrl = str(u.raw).split('?')[0]!;
    for (const q of arr(u.query).filter(isObj)) {
      const k = sub(str(q.key), vars);
      if (q.disabled === true) { notes.push(`Disabled query ${k} was skipped`); continue; }
      query.push([k, q.value === null || q.value === undefined ? '' : sub(str(q.value), vars)]);
    }
  } else {
    const raw = str(u);
    const i = raw.indexOf('?');
    rawUrl = i < 0 ? raw : raw.slice(0, i);
    if (i >= 0) query = [...new URLSearchParams(raw.slice(i + 1))].map(([k, v]) => [sub(k, vars), sub(v, vars)]);
  }
  // Path variables (:id) take values from url.variable; an empty one must be entered.
  rawUrl = rawUrl.replace(/\/:([A-Za-z_][\w-]*)/g, (_m, k: string) => {
    const v = pathVars.get(k);
    if (v) return `/${encodeURIComponent(sub(v, vars))}`;
    requires.push(`Path variable :${k}: the collection gives no value; enter it`);
    return `/${missing(`path ${k}`)}`;
  });
  let url = sub(rawUrl, vars).trim();
  if (!url) return 'no URL';
  if (url.startsWith('{{$missing')) url = `${HTTPS}//${url.replace(/^(\{\{[^}]*\}\})\/?/, '$1/')}`; // the whole origin is an unresolved variable
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) { url = `${HTTP}//${url}`; notes.push('The URL has no protocol; http is assumed, as Postman does'); }
  if (!/^https?:\/\//i.test(url)) return `${url.split(':')[0]} requests are not HTTP calls`;
  const headers: Pair[] = [];
  for (const h of arr(rq.header).filter(isObj)) {
    const k = sub(str(h.key), vars);
    if (!k) continue;
    if (h.disabled === true) { notes.push(`Disabled header ${k} was skipped`); continue; }
    headers.push([k, sub(str(h.value), vars)]);
  }
  // Auth: request → item → folder → collection; noauth stops inheritance.
  if (auth && str(auth.type) && auth.type !== 'noauth') {
    const type = str(auth.type);
    if (type === 'bearer') {
      headers.push(['Authorization', `Bearer ${missing('bearer token')}`]);
      requires.push(`Authorization: bearer token${authParam(auth, 'bearer', 'token') ? ' (the collection value is not imported)' : ''}; enter it or use {{$context("…")}}, or attach an auth context`);
    } else if (type === 'basic') {
      headers.push(['Authorization', `Basic ${missing('basic credentials')}`]);
      requires.push(`Authorization: basic credentials for ${sub(authParam(auth, 'basic', 'username') ?? '', vars) || 'the user'} (the password is not imported); enter base64 user:password`);
    } else if (type === 'apikey') {
      const key = sub(authParam(auth, 'apikey', 'key') ?? '', vars) || 'X-API-Key';
      const placement = authParam(auth, 'apikey', 'in') ?? 'header';
      if (placement === 'query') query.push([key, missing(`API key ${key}`)]);
      else headers.push([key, missing(`API key ${key}`)]);
      requires.push(`${placement === 'query' ? 'Query' : 'Header'} ${key}: API key (the collection value is not imported); enter it`);
    } else {
      requires.push(`Postman ${type} auth is not supported; configure an auth context or headers before sending`);
    }
  } else if (auth?.type === 'noauth') notes.push('No auth (explicitly set; inherited auth is not applied)');
  const bodies: Draft['bodies'] = [];
  const ct = headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  const b = isObj(rq.body) ? rq.body : null;
  if (b && b.disabled !== true) {
    const mode = str(b.mode);
    if (mode === 'raw') {
      const lang = isObj(b.options) && isObj((b.options as Obj).raw) ? str(((b.options as Obj).raw as Obj).language) : '';
      const mime = ct || ({ json: 'application/json', xml: 'application/xml', html: 'text/html', javascript: 'application/javascript', text: 'text/plain' } as Record<string, string>)[lang] || 'text/plain';
      const text = sub(str(b.raw), vars);
      if (text) bodies.push({ label: `raw ${lang || mime}`, contentType: mime, body: bodyFor(mime, text, r, [], true).body });
    } else if (mode === 'urlencoded') {
      const pairs: Pair[] = [];
      for (const p of arr(b.urlencoded).filter(isObj)) {
        if (p.disabled === true) { notes.push(`Disabled form field ${str(p.key)} was skipped`); continue; }
        pairs.push([sub(str(p.key), vars), sub(str(p.value), vars)]);
      }
      bodies.push({ label: 'urlencoded', contentType: 'application/x-www-form-urlencoded', body: { kind: 'urlencoded', pairs: cleanPairs(pairs, r, 'Form') } });
    } else if (mode === 'formdata') {
      const parts: Part[] = [];
      for (const p of arr(b.formdata).filter(isObj)) {
        const k = sub(str(p.key), vars);
        if (p.disabled === true) { notes.push(`Disabled form field ${k} was skipped`); continue; }
        if (p.type === 'file') {
          const src = Array.isArray(p.src) ? p.src.map(str).join(', ') : str(p.src);
          parts.push({ kind: 'file', name: k, fileName: src.split(/[\\/]/).pop() ?? '' });
          requires.push(`Choose the file for ${k}${src ? ` (${src} is a path on the exporting machine and is never read)` : ''} when running`);
        } else parts.push({ kind: 'field', name: k, value: cleanPairs([[k, sub(str(p.value), vars)]], r, 'Field')[0]![1] });
      }
      bodies.push({ label: 'form-data', contentType: 'multipart/form-data', body: { kind: 'multipart', parts } });
    } else if (mode === 'graphql' && isObj(b.graphql)) {
      const g = b.graphql as Obj;
      let variables: unknown;
      const vt = sub(str(g.variables), vars).trim();
      if (vt) { try { variables = JSON.parse(vt); } catch { notes.push('GraphQL variables are not valid JSON; sent as text'); variables = vt; } }
      const text = JSON.stringify({ query: sub(str(g.query), vars), ...(variables !== undefined && { variables }) });
      bodies.push({ label: 'GraphQL', contentType: 'application/json', body: bodyFor('application/json', text, r, [], true).body });
    } else if (mode === 'file') {
      bodies.push({ label: 'file', contentType: ct || 'application/octet-stream', body: { kind: 'text', text: missing('file body') } });
      requires.push(`Request body is a file${isObj(b.file) && str((b.file as Obj).src) ? ` (${str((b.file as Obj).src)})` : ''}; binary file bodies cannot be imported; enter the body before sending`);
    } else if (mode) notes.push(`Body mode ${mode} is not supported and was left out`);
  }
  let sample: Sample | undefined;
  for (const resp of arr(item.response).filter(isObj)) {
    const code = typeof resp.code === 'number' ? resp.code : 0;
    if (code < 100 || code > 599) continue;
    const rct = arr(resp.header).filter(isObj).find((h) => str(h.key).toLowerCase() === 'content-type');
    sample = sampleFrom(code, rct ? str(rct.value) : '', str(resp.body));
    if (code >= 200 && code < 300) break;
  }
  for (const k of unresolved) if (!k.startsWith('$')) requires.push(`Variable ${k} is not defined in the collection; enter its value`);
  for (const k of unresolved) if (k.startsWith('$')) requires.push(`Postman dynamic variable ${k} has no equivalent here; enter a value or use a generator such as {{$uuid}}`);
  if (headers.some(([k]) => k.toLowerCase() === 'cookie')) notes.push('Cookie header: this browser sends its own cookies (credentials: include)');
  const clean = draftHeaders(headers, r);
  return {
    name: where, method, url: url.replace(/^(https?:\/\/[^/?#]+)$/i, '$1/'), query: draftPairs(query, r, 'Query'), headers: clean,
    credentials: headers.some(([k]) => k.toLowerCase() === 'cookie') ? 'include' : 'same-origin',
    bodies, ...(sample && { sample }), source: `Postman ${where}`, notes: [...notes, ...r.notes],
    requires: [...requires, ...redactedRequires(r)],
  };
}
