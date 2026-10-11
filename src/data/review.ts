// Shared import review: observed calls (recorder or HAR) and native endpoints become candidates;
// candidates are grouped, compared with the destination profile and applied to a copy of it.
// Pure: no DOM, no storage, never dispatches. The session validates and commits the result.
import { REDACTED, type Capture } from '../net/capture';
import {
  BOUNDS, METHODS, newId, renameAliasRefs, sensitiveHeader, utf8Bytes,
  type Aggregate, type Body, type Check, type Endpoint, type Header, type Method, type Pair, type Sample,
} from './schema';

export type Action = 'keep' | 'replace' | 'skip';

export interface Candidate {
  /** Stable within one review. */
  key: string;
  selected: boolean;
  endpoint: Endpoint;
  /** Grouped observed calls (recorder/HAR), oldest first; empty for native endpoints. */
  members: Capture[];
  /** Index into `members` used for the sample. */
  sampleIdx: number;
  source: string;
  notes: string[];
  /** Values the user must provide before this request can be sent faithfully. */
  requires: string[];
  /** Query names that look like cache-busters; removable before import. */
  transient: string[];
  dropQuery: string[];
  /** Existing endpoint with the same request identity (method, origin, path, query, body). */
  conflict: { id: string; name: string } | null;
  action: Action;
  /** "variant 2 of 3" when the same method+path has different queries or bodies. */
  variant: string;
}

export interface Suggestion { from: string; to: string; text: string }

// ---------- request identity

const TRANSIENT = /^(_|_t|t|ts|timestamp|cb|cachebust(er)?|nocache|rand|random|nonce)$/i;
/** Cache-buster: a known name with a timestamp or Math.random()-like value. Anything else is a real query constraint. */
const transientPair = ([k, v]: Pair) => TRANSIENT.test(k) && /^(\d{6,20}|0\.\d{4,20})$/.test(v);

/** Grouping policy: method + origin/path + query (cache-busters excluded) + body. Different queries or bodies stay apart. */
export const captureIdentity = (c: Capture) => JSON.stringify([c.method, c.url, c.query.filter((p) => !transientPair(p)), c.body]);

function endpointOrigin(agg: Aggregate, e: Endpoint, pageOrigin: string): { origin: string; path: string } {
  const r = e.request;
  if (r.hostKey === null) {
    try { const u = new URL(r.url); return { origin: u.origin, path: u.pathname }; } catch { return { origin: '', path: r.url }; }
  }
  const env = agg.profile.environments[agg.profile.activeEnvironment] ?? {};
  return { origin: env[r.hostKey] || pageOrigin, path: r.url.split('?')[0]! };
}

/** Name alone is never identity: method, effective origin, path, query and body decide. */
export function requestIdentity(agg: Aggregate, e: Endpoint, pageOrigin: string): string {
  const { origin, path } = endpointOrigin(agg, e, pageOrigin);
  return JSON.stringify([e.request.method, origin, path, e.request.query, e.request.body]);
}

// ---------- capture → endpoint

const ROTATING = /nonce|idempot|request-?id|timestamp|x-date|otp|signature/i;

function hostFor(agg: Aggregate, origin: string, pageOrigin: string): string | null {
  const env = agg.profile.environments[agg.profile.activeEnvironment] ?? {};
  for (const [k, o] of Object.entries(env)) if ((o || pageOrigin) === origin) return k;
  return null;
}

function slug(method: string, url: string): string {
  let path = url;
  try { path = new URL(url).pathname; } catch { /* already a path */ }
  const words = path.split('/').filter(Boolean).slice(-3).join('_').replace(/[^A-Za-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const s = `${method.toLowerCase()}_${words || 'root'}`.slice(0, 56);
  return /^[A-Za-z_]/.test(s) ? s : `_${s}`;
}

export function uniqueAlias(base: string, used: Set<string>): string {
  let a = base;
  for (let n = 2; used.has(a); n++) a = `${base}_${n}`;
  used.add(a);
  return a;
}

function bodyOf(c: Capture, contentType: string, notes: string[], requires: string[]): Body {
  const b = c.body;
  switch (b.kind) {
    case 'none': return { kind: 'none' };
    case 'urlencoded': return { kind: 'urlencoded', pairs: b.pairs };
    case 'multipart': {
      const files = b.parts.filter((p) => p.kind === 'file');
      if (files.length) requires.push(`Choose ${files.length === 1 ? 'the file' : `${files.length} files`} for ${files.map((p) => p.name).join(', ')} when running`);
      return { kind: 'multipart', parts: b.parts };
    }
    case 'text': {
      if (/json/i.test(contentType)) {
        try { JSON.parse(b.text); return { kind: 'json', text: b.text }; } catch { notes.push('Body declared JSON but did not parse; kept as exact text'); }
      }
      return { kind: 'text', text: b.text };
    }
    case 'omitted':
      requires.push(`Request body was not captured (${b.reason}); enter it before sending`);
      return { kind: 'text', text: '{{$missing}}' };
  }
}

function sampleOf(c: Capture, notes: string[]): Sample | undefined {
  if (!c.status) { notes.push(c.outcome === 'pending' || c.outcome === 'unfinished' ? 'No response was recorded' : `No response (${c.outcome}); no sample`); return undefined; }
  if (c.status < 100 || c.status > 599) return undefined;
  const rb = c.resBody;
  let body = '';
  let bodyState: Sample['bodyState'] = 'complete';
  if (rb && 'text' in rb) {
    body = rb.text;
    if (rb.truncated || utf8Bytes(body) > BOUNDS.sampleBytes) {
      bodyState = 'truncated';
      while (utf8Bytes(body) > BOUNDS.sampleBytes) body = body.slice(0, Math.floor(body.length * 0.9));
    }
  } else if (rb) { bodyState = 'truncated'; notes.push(`Sample body: ${rb.omitted}`); }
  if (c.redacted.some((r) => r.startsWith('Response body'))) bodyState = 'redacted';
  if (c.synthetic) notes.push('Sample came from an active Mock rule, not the server');
  return { status: c.status, headers: c.resHeaders.filter(([k]) => !sensitiveHeader(k)).slice(0, BOUNDS.rows), body, bodyState, source: 'captured', ...(c.at > 0 && { at: c.at }) };
}

function statusCheck(status: number | undefined): Check {
  if (!status || (status >= 200 && status <= 299)) return { kind: 'status', min: 200, max: 299 };
  return { kind: 'status', min: status, max: status };
}

/** Build the proposed endpoint for a group of identical observed calls. */
function capturedEndpoint(agg: Aggregate, members: Capture[], sampleIdx: number, dropQuery: string[], pageOrigin: string, alias: string): Pick<Candidate, 'endpoint' | 'notes' | 'requires'> {
  const c = members[members.length - 1]!; // newest call defines the request
  const notes = [...new Set(members.flatMap((m) => m.notes))];
  const requires: string[] = [];
  const method = c.method as Method;
  let origin = '', path = c.url;
  try { const u = new URL(c.url); origin = u.origin; path = u.pathname; } catch { /* validated by the session */ }
  const hostKey = hostFor(agg, origin, pageOrigin);
  const headers: Header[] = [];
  const seen = new Set<string>();
  const ct = c.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  for (const [name, value] of c.headers) {
    const k = name.toLowerCase();
    if (seen.has(k)) { notes.push(`Header ${name} appeared twice; the first value is kept`); continue; }
    if (c.body.kind === 'multipart' && k === 'content-type') continue; // the browser sets the boundary
    seen.add(k);
    headers.push({ name, value });
    if (value === REDACTED) requires.push(/signature/i.test(name) ? `Header ${name}: the captured signature is historical and was redacted; configure a signing recipe or enter a fresh value` : `Header ${name}: enter a fresh value (the captured value was redacted)`);
    else if (ROTATING.test(name)) requires.push(`Header ${name} looks per-request (nonce, idempotency key, timestamp or OTP); the captured value is historical and must be prepared fresh`);
  }
  const query = c.query.filter(([k]) => !dropQuery.includes(k));
  for (const [k, v] of query) if (v === REDACTED) requires.push(`Query ${k}: enter a fresh value (the captured value was redacted)`);
  let body = bodyOf(c, ct, notes, requires);
  if ((method === 'GET' || method === 'HEAD') && body.kind !== 'none') { notes.push(`${method} body was dropped: browsers do not send it`); body = { kind: 'none' }; requires.splice(0, requires.length, ...requires.filter((r) => !r.startsWith('Request body'))); }
  if (body.kind === 'urlencoded') for (const [k, v] of body.pairs) if (v === REDACTED) requires.push(`Form field ${k}: enter a fresh value (the captured value was redacted)`);
  if (body.kind === 'multipart') for (const p of body.parts) if (p.kind === 'field' && p.value === REDACTED) requires.push(`Field ${p.name}: enter a fresh value (the captured value was redacted)`);
  if ((body.kind === 'json' || body.kind === 'text') && body.text.includes(REDACTED)) requires.push('Body has redacted fields; enter fresh values before sending');
  const sample = sampleOf(members[sampleIdx] ?? c, notes);
  const now = Date.now();
  const where = c.transport === 'har' ? `HAR entry ${c.id + 1}` : `Recorded ${c.transport} call #${c.id}`;
  const e: Endpoint = {
    id: newId('ep'),
    name: path.slice(0, BOUNDS.name),
    alias,
    request: { method, hostKey, url: hostKey === null ? `${origin}${path}` : path, query, headers, credentials: c.credentials, body },
    checks: [statusCheck(sample?.status)],
    provenance: `${where}${c.at > 0 ? ` · ${new Date(c.at).toISOString()}` : ''}${c.ms !== undefined ? ` · ${Math.round(c.ms)} ms observed` : ''}`.slice(0, 200),
    createdAt: now,
    updatedAt: now,
  };
  if (sample) e.sample = sample;
  return { endpoint: e, notes, requires };
}

export interface BuildOptions { group: boolean; pageOrigin: string }

/** Turn observed calls into candidates against the destination profile. */
export function candidatesFromCaptures(agg: Aggregate, captures: Capture[], o: BuildOptions): { candidates: Candidate[]; skipped: string[] } {
  const skipped: string[] = [];
  const groups = new Map<string, Capture[]>();
  let solo = 0;
  for (const c of captures) {
    if (!(METHODS as readonly string[]).includes(c.method)) { skipped.push(`${c.method} ${c.url}: method ${c.method} cannot be saved as an endpoint`); continue; }
    if (!/^https?:\/\//.test(c.url)) { skipped.push(`${c.url}: only http(s) requests can be saved`); continue; }
    const k = o.group ? captureIdentity(c) : `solo-${solo++}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const used = new Set(agg.endpoints.map((e) => e.alias));
  const existing = new Map(agg.endpoints.map((e) => [requestIdentity(agg, e, o.pageOrigin), e]));
  const byPath = new Map<string, number>();
  for (const ms of groups.values()) { const k = `${ms[0]!.method} ${ms[0]!.url}`; byPath.set(k, (byPath.get(k) ?? 0) + 1); }
  const seenPath = new Map<string, number>();
  const out: Candidate[] = [];
  for (const members of groups.values()) {
    const first = members[0]!;
    const pathKey = `${first.method} ${first.url}`;
    const n = (seenPath.get(pathKey) ?? 0) + 1;
    seenPath.set(pathKey, n);
    const total = byPath.get(pathKey)!;
    const transient = [...new Set(members.flatMap((m) => m.query.filter(transientPair).map(([k]) => k)))];
    const alias = uniqueAlias(slug(first.method, first.url), used);
    const cand: Candidate = {
      key: `c${out.length}`, selected: true, members, sampleIdx: members.length - 1,
      source: members.length > 1 ? `${members.length} identical calls` : first.transport === 'har' ? `HAR entry ${first.id + 1}` : `Call #${first.id} · ${first.transport}${first.source === 'tester' ? ' · tester traffic' : ''}`,
      transient, dropQuery: [], conflict: null, action: 'keep',
      variant: total > 1 ? `variant ${n} of ${total} (different query or body)` : '',
      ...capturedEndpoint(agg, members, members.length - 1, [], o.pageOrigin, alias),
    };
    markConflict(agg, cand, existing, o.pageOrigin);
    out.push(cand);
  }
  return { candidates: out, skipped };
}

function markConflict(agg: Aggregate, cand: Candidate, existing: Map<string, Endpoint>, pageOrigin: string) {
  const hit = existing.get(requestIdentity(agg, cand.endpoint, pageOrigin));
  cand.conflict = hit ? { id: hit.id, name: hit.name } : null;
  if (hit) cand.action = 'skip';
}

/** Rebuild a candidate's endpoint after a sample or transient-query choice, keeping the user's name/alias. */
export function rebuildCandidate(agg: Aggregate, cand: Candidate, pageOrigin: string): void {
  const { name, alias } = cand.endpoint;
  const next = capturedEndpoint(agg, cand.members, cand.sampleIdx, cand.dropQuery, pageOrigin, alias);
  Object.assign(cand, next);
  cand.endpoint.name = name;
  const existing = new Map(agg.endpoints.map((e) => [requestIdentity(agg, e, pageOrigin), e]));
  const action = cand.action;
  markConflict(agg, cand, existing, pageOrigin);
  if (cand.conflict && action !== 'keep') cand.action = action;
  if (!cand.conflict) cand.action = 'keep';
}

/** Values from one call's JSON response that reappear in a later call's request. Suggestions only. */
export function dependencySuggestions(cands: Candidate[]): Suggestion[] {
  const out: Suggestion[] = [];
  const produced: { value: string; path: string; from: Candidate }[] = [];
  const order = cands.flatMap((c) => c.members.map((m) => ({ c, m }))).sort((a, b) => a.m.at - b.m.at);
  for (const { c, m } of order) {
    if (out.length >= 20) break;
    const fields: [string, string][] = [...m.query.map(([k, v]) => [`query ${k}`, v] as [string, string]), ...m.headers.map(([k, v]) => [`header ${k}`, v] as [string, string])];
    if (m.body.kind === 'text') fields.push(['body', m.body.text]);
    if (m.body.kind === 'urlencoded') fields.push(...m.body.pairs.map(([k, v]) => [`form ${k}`, v] as [string, string]));
    for (const p of produced) {
      if (p.from === c) continue;
      const f = fields.find(([, v]) => v.includes(p.value));
      if (f && !out.some((s) => s.from === p.from.key && s.to === c.key)) out.push({ from: p.from.key, to: c.key, text: `${c.endpoint.name} ${f[0]} contains ${p.from.endpoint.name} response ${p.path}. Possible dependency; a repeated value does not prove one, and nothing was linked.` });
    }
    const rb = m.resBody;
    if (rb && 'text' in rb && !rb.truncated && produced.length < 500) {
      try { leaves(JSON.parse(rb.text), '', (path, v) => { if (v.length >= 8 && v !== REDACTED && produced.length < 500) produced.push({ value: v, path: path || '$', from: c }); }, 0); } catch { /* not JSON */ }
    }
  }
  return out;
}

function leaves(x: unknown, path: string, fn: (path: string, v: string) => void, depth: number) {
  if (depth > 16) return;
  if (typeof x === 'string' || typeof x === 'number') fn(path, String(x));
  else if (Array.isArray(x)) x.slice(0, 50).forEach((e, i) => leaves(e, `${path}[${i}]`, fn, depth + 1));
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x).slice(0, 100)) leaves(v, path ? `${path}.${k}` : k, fn, depth + 1);
}

// ---------- applying candidates

export interface Applied { agg: Aggregate; added: number; replaced: number; skipped: number; unresolved: number; addedIds: string[]; notes: string[] }

/** Apply selected candidates to a copy of `agg`. Replace keeps the existing ID and alias so references stay valid. */
export function applyCandidates(agg: Aggregate, cands: Candidate[]): Applied {
  const next = structuredClone(agg);
  const r: Applied = { agg: next, added: 0, replaced: 0, skipped: 0, unresolved: 0, addedIds: [], notes: [] };
  for (const c of cands) {
    if (!c.selected) continue;
    if (c.conflict && c.action === 'skip') { r.skipped++; continue; }
    const e = structuredClone(c.endpoint);
    if (c.requires.length) r.unresolved++;
    if (c.conflict && c.action === 'replace') {
      const i = next.endpoints.findIndex((x) => x.id === c.conflict!.id);
      if (i < 0) { r.notes.push(`${c.conflict.name} no longer exists; added instead`); }
      else {
        const old = next.endpoints[i]!;
        e.id = old.id;
        e.alias = old.alias;
        e.createdAt = old.createdAt;
        if (old.authContextId) e.authContextId = old.authContextId;
        if (old.signingRecipeId) e.signingRecipeId = old.signingRecipeId;
        next.endpoints[i] = e;
        r.replaced++;
        r.addedIds.push(e.id);
        continue;
      }
    }
    next.endpoints.push(e);
    r.added++;
    r.addedIds.push(e.id);
  }
  return r;
}

/** Which plans use an endpoint, for the Replace preview. */
export const plansUsing = (agg: Aggregate, id: string) => agg.plans.filter((p) => p.steps.some((s) => s.endpointId === id)).map((p) => p.name);

// ---------- native merge

/** Endpoints of an imported profile as candidates against the current profile. */
export function candidatesFromNative(cur: Aggregate, incoming: Aggregate, pageOrigin: string): Candidate[] {
  const existing = new Map(cur.endpoints.map((e) => [requestIdentity(cur, e, pageOrigin), e]));
  return incoming.endpoints.map((e, i) => {
    const cand: Candidate = {
      key: `n${i}`, selected: true, endpoint: structuredClone(e), members: [], sampleIdx: 0, source: `Endpoint ${e.alias}`,
      notes: [], requires: [], transient: [], dropQuery: [], conflict: null, action: 'keep', variant: '',
    };
    if ([e.request.url, ...e.request.headers.map((h) => h.value)].some((v) => v.includes('{{$redacted}}'))) cand.requires.push('Has values redacted on export; enter them again');
    // Compare in the incoming profile's own environment so host keys mean what they meant there.
    const hit = existing.get(requestIdentity(incoming, e, pageOrigin));
    if (hit) { cand.conflict = { id: hit.id, name: hit.name }; cand.action = 'skip'; }
    return cand;
  });
}

/**
 * Merge an imported profile into the current one. Endpoints follow the candidate choices; plans,
 * auth contexts, signing recipes, host keys, global headers and kept rules are added with every
 * ID and reference remapped once. Existing records are never changed except by an explicit Replace.
 */
export function mergeNative(cur: Aggregate, incoming: Aggregate, cands: Candidate[]): Applied {
  const next = structuredClone(cur);
  const inc = structuredClone(incoming);
  const r: Applied = { agg: next, added: 0, replaced: 0, skipped: 0, unresolved: 0, addedIds: [], notes: [] };
  const ids = new Set([...next.endpoints.map((e) => e.id), ...next.plans.map((p) => p.id), ...next.authContexts.map((a) => a.id), ...next.signingRecipes.map((s) => s.id)]);
  const fresh = (id: string, prefix: string) => (ids.has(id) ? newId(prefix) : id);
  const epMap = new Map<string, string>();
  const used = new Set(next.endpoints.map((e) => e.alias));

  // Aliases that must change are renamed inside the incoming endpoints' own references first.
  const renames: [string, string][] = [];
  for (const c of cands) {
    if (!c.selected || (c.conflict && c.action !== 'keep')) continue;
    const want = c.endpoint.alias;
    const final = used.has(want) ? uniqueAlias(want, used) : (used.add(want), want);
    const orig = inc.endpoints.find((e) => e.id === c.endpoint.id)!.alias;
    if (final !== orig) renames.push([orig, final]);
    c.endpoint.alias = final;
  }
  renames.forEach(([from], i) => renameAliasRefs(inc, from, `__aw_tmp_${i}`));
  renames.forEach(([, to], i) => renameAliasRefs(inc, `__aw_tmp_${i}`, to));
  const byId = new Map(inc.endpoints.map((e) => [e.id, e]));

  for (const c of cands) {
    const src = byId.get(c.endpoint.id)!;
    if (!c.selected) { r.notes.push(`${c.endpoint.name} not selected`); continue; }
    if (c.conflict && c.action === 'skip') { epMap.set(src.id, c.conflict.id); r.skipped++; continue; }
    const e: Endpoint = { ...structuredClone(src), name: c.endpoint.name, alias: c.endpoint.alias };
    if (c.requires.length) r.unresolved++;
    if (c.conflict && c.action === 'replace') {
      const i = next.endpoints.findIndex((x) => x.id === c.conflict!.id);
      if (i >= 0) {
        e.id = next.endpoints[i]!.id;
        e.alias = next.endpoints[i]!.alias;
        next.endpoints[i] = e;
        epMap.set(src.id, e.id);
        r.replaced++;
        r.addedIds.push(e.id);
        continue;
      }
    }
    e.id = fresh(src.id, 'ep');
    ids.add(e.id);
    epMap.set(src.id, e.id);
    next.endpoints.push(e);
    r.added++;
    r.addedIds.push(e.id);
  }

  const ctxMap = new Map<string, string>();
  for (const a of inc.authContexts) {
    const id = fresh(a.id, 'auth');
    ids.add(id);
    ctxMap.set(a.id, id);
    const copy = { ...a, id };
    if (copy.refresh) {
      const to = epMap.get(copy.refresh.endpointId);
      if (to) copy.refresh = { ...copy.refresh, endpointId: to };
      else { delete copy.refresh; r.notes.push(`Auth context ${a.label}: its refresh endpoint was not imported, so refresh was removed`); }
    }
    next.authContexts.push(copy);
  }
  const recipeMap = new Map<string, string>();
  for (const s of inc.signingRecipes) {
    const id = fresh(s.id, 'sign');
    ids.add(id);
    recipeMap.set(s.id, id);
    next.signingRecipes.push({ ...s, id });
  }
  for (const b of inc.bindings) {
    if (next.bindings.some((x) => x.name === b.name)) r.notes.push(`Binding ${b.name} already exists here; the existing one is kept`);
    else next.bindings.push(b);
  }
  for (const e of next.endpoints) {
    if (!r.addedIds.includes(e.id)) continue;
    if (e.authContextId) e.authContextId = ctxMap.get(e.authContextId) ?? e.authContextId;
    if (e.signingRecipeId) e.signingRecipeId = recipeMap.get(e.signingRecipeId) ?? e.signingRecipeId;
  }
  for (const p of inc.plans) {
    const steps = [];
    const inPlan = new Set<string>();
    for (const s of p.steps) {
      const to = epMap.get(s.endpointId);
      if (!to) { r.notes.push(`Plan ${p.name}: a step's endpoint was not imported, so the step was removed`); continue; }
      if (inPlan.has(to)) { r.notes.push(`Plan ${p.name}: two steps now use the same endpoint; the later one was removed`); continue; }
      inPlan.add(to);
      steps.push({ ...s, endpointId: to });
    }
    const id = fresh(p.id, 'plan');
    ids.add(id);
    let name = p.name;
    for (let n = 2; next.plans.some((x) => x.name === name); n++) name = `${p.name} (${n})`;
    next.plans.push({ ...p, id, name, steps });
  }
  // Host keys used by imported endpoints must exist; existing mappings win.
  const curEnv = next.profile.environments;
  const incEnv = inc.profile.environments[inc.profile.activeEnvironment] ?? {};
  for (const [envName, hosts] of Object.entries(inc.profile.environments)) {
    if (!curEnv[envName]) { curEnv[envName] = { ...hosts }; r.notes.push(`Environment ${envName} added`); continue; }
    for (const [k, o] of Object.entries(hosts)) if (!(k in curEnv[envName]!)) curEnv[envName]![k] = o;
      else if (curEnv[envName]![k] !== o) r.notes.push(`Host ${k} in ${envName} keeps its current origin (${curEnv[envName]![k] || 'this page'}), not ${o || 'this page'}`);
  }
  for (const e of next.endpoints) {
    const k = e.request.hostKey;
    if (k === null) continue;
    for (const hosts of Object.values(curEnv)) if (!(k in hosts)) hosts[k] = incEnv[k] ?? '';
  }
  const names = new Set(next.profile.globalHeaders.map((h) => h.name.toLowerCase()));
  for (const h of inc.profile.globalHeaders) {
    if (names.has(h.name.toLowerCase())) { r.notes.push(`Global header ${h.name} keeps its current value`); continue; }
    next.profile.globalHeaders.push(h);
  }
  let seq = Math.max(0, ...next.rules.map((x) => x.seq));
  for (const rule of inc.rules) {
    const o = structuredClone(rule);
    if (next.rules.some((x) => x.id === o.id)) o.id = newId('rule');
    if (o.endpointId) o.endpointId = epMap.get(o.endpointId) ?? o.endpointId;
    if (o.endpointId && !next.endpoints.some((e) => e.id === o.endpointId)) delete o.endpointId;
    o.seq = ++seq;
    next.rules.push(o);
  }
  for (const rule of inc.legacyRules) {
    const o = { ...(rule as Record<string, unknown>) };
    if (typeof o.endpointId === 'string') o.endpointId = epMap.get(o.endpointId) ?? o.endpointId;
    o.profileId = next.profile.id;
    next.legacyRules.push(o);
  }
  return r;
}
