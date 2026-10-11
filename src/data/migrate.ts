// Schema 1 → schema 2. Pure: reads untrusted schema 1 JSON (an export, a backup or the stored
// `api-workbench` record) and returns validated schema 2 aggregates, or diagnostics and no data.
// Never guesses missing body/auth intent; raw text is kept exactly.
import {
  BOUNDS, copyAggregate, rulesFromV1, SCHEMA, utf8Bytes, validateAggregate,
  type Aggregate, type Body, type Check, type Diag, type Endpoint, type Plan, type Profile, type Sample, type Step,
} from './schema';

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const clamp = (x: unknown, lo: number, hi: number, d: number) => Math.min(hi, Math.max(lo, Math.round(num(x, d))));

export interface Migration {
  aggregates: Aggregate[];
  activeId: string;
  /** What changed shape or was not carried over, for the preview. */
  notes: string[];
}

export function isSchema1(x: unknown): boolean {
  return isObj(x) && (x.schemaVersion === 1 || (x.schemaVersion === undefined && isObj(x.profile) && Array.isArray(x.endpoints)));
}

export function migrateV1(input: unknown): { ok: true; value: Migration } | { ok: false; errors: Diag[] } {
  if (!isObj(input)) return { ok: false, errors: [{ path: '', message: 'Expected a schema 1 object' }] };
  if (typeof input.schemaVersion === 'number' && input.schemaVersion > 1) return { ok: false, errors: [{ path: 'schemaVersion', message: `Not schema 1 (found ${input.schemaVersion})` }] };
  if (!isObj(input.profile) || !Array.isArray(input.endpoints)) return { ok: false, errors: [{ path: '', message: 'Schema 1 data needs a profile and an endpoints list' }] };

  const notes: string[] = [];
  const errors: Diag[] = [];
  const rules = arr(input.rules);
  const savedPlans = arr(input.savedPlans);
  const livePlan = isObj(input.plan) ? input.plan : null;
  const liveId = String(input.profile.id ?? '');

  const snapshots: { profile: Obj; endpoints: unknown[]; rules: unknown[]; plans: Obj[]; label: string }[] = [{
    profile: input.profile, endpoints: input.endpoints, label: 'active profile',
    rules: rules.filter((r) => !isObj(r) || r.profileId === undefined || r.profileId === liveId),
    plans: [...(livePlan ? [livePlan] : [])],
  }];
  for (const [i, s] of arr(input.savedProfiles).entries()) {
    if (!isObj(s) || !isObj(s.profile)) { errors.push({ path: `savedProfiles.${i}`, message: 'Saved profile is not an object with a profile' }); continue; }
    snapshots.push({ profile: s.profile, endpoints: arr(s.endpoints), rules: arr(s.rules), plans: isObj(s.plan) ? [s.plan] : [], label: `saved profile ${String(s.profile.name ?? i)}` });
  }
  const ids = new Set(snapshots.map((s) => String(s.profile.id ?? '')));
  for (const [i, p] of savedPlans.entries()) {
    if (!isObj(p)) { errors.push({ path: `savedPlans.${i}`, message: 'Expected a plan object' }); continue; }
    const owner = snapshots.find((s) => s.profile.id === p.profileId);
    if (!owner) { errors.push({ path: `savedPlans.${i}.profileId`, message: `Plan "${String(p.name)}" belongs to profile ${String(p.profileId)}, which is not in this data` }); continue; }
    owner.plans.push(p);
  }
  if (ids.size !== snapshots.length) notes.push('A saved copy shares its ID with another profile; it is imported as a separate copy.');

  const out: Aggregate[] = [];
  const seenIds = new Set<string>();
  const names = new Set<string>();
  for (const s of snapshots) {
    let agg = convert(s, notes);
    const r = validateAggregate(agg);
    if (!r.ok) { errors.push(...r.errors.map((d) => ({ path: `${s.label}: ${d.path}`, message: d.message }))); continue; }
    agg = r.value;
    if (seenIds.has(agg.profile.id)) agg = copyAggregate(agg, `${agg.profile.name} (saved copy)`);
    let name = agg.profile.name;
    for (let n = 2; names.has(name); n++) name = `${agg.profile.name}-${n}`;
    if (name !== agg.profile.name) { notes.push(`Profile "${agg.profile.name}" renamed "${name}" to keep names unique.`); agg.profile.name = name; }
    names.add(name);
    seenIds.add(agg.profile.id);
    out.push(agg);
  }
  if (errors.length) return { ok: false, errors };
  notes.push('Modules, sequence cursors and active runs do not carry over; every module starts inactive.');
  return { ok: true, value: { aggregates: out, activeId: out[0]!.profile.id, notes } };
}

function convert(s: { profile: Obj; endpoints: unknown[]; rules: unknown[]; plans: Obj[]; label: string }, notes: string[]): Aggregate {
  const p = s.profile;
  const settings = isObj(p.settings) ? p.settings : {};
  const globals = arr(p.globalHeaders).filter(isObj);
  if (globals.some((h) => h.removed)) notes.push(`${String(p.name)}: removed global header rows had no effect and were dropped.`);
  const now = Date.now();
  const environments = isObj(p.environments) && Object.keys(p.environments).length ? p.environments : { default: { default: '' } };
  const profile: Profile = {
    id: String(p.id ?? ''),
    name: String(p.name ?? 'Migrated'),
    createdAt: num(p.createdAt, now),
    updatedAt: num(p.updatedAt, now),
    environments: environments as Profile['environments'],
    activeEnvironment: typeof p.activeEnvironment === 'string' && p.activeEnvironment ? p.activeEnvironment : Object.keys(environments)[0]!,
    globalHeaders: globals.filter((h) => !h.removed).map((h) => ({ name: String(h.name ?? '').trim(), value: String(h.value ?? '') })),
    settings: { bodyCheckKb: clamp(settings.bodyLimitKb, BOUNDS.bodyCheckKb.min, BOUNDS.bodyCheckKb.max, BOUNDS.bodyCheckKb.default) },
  };
  const endpoints = s.endpoints.map((e) => endpoint(e, notes));
  const order = endpoints.map((e) => e.id);
  const r = rulesFromV1(s.rules, new Set(order));
  notes.push(...r.notes.map((n) => `${profile.name}: ${n}`));
  return {
    schema: SCHEMA, revision: 0, profile, endpoints,
    plans: s.plans.map((pl) => plan(pl, order)),
    authContexts: [], signingRecipes: [],
    rules: r.rules, legacyRules: r.rest,
  };
}

function endpoint(x: unknown, notes: string[]): Endpoint {
  const e = isObj(x) ? x : {};
  const r = isObj(e.request) ? e.request : {};
  const name = String(e.name ?? '');
  const path = String(r.path ?? '');
  const absolute = /^https?:\/\//i.test(path);
  const headers = arr(r.headers).filter(isObj).map((h) => {
    const out: Endpoint['request']['headers'][number] = { name: String(h.name ?? '').trim(), value: String(h.value ?? '') };
    if (h.removed) out.remove = true;
    return out;
  });
  const raw = String(r.body ?? '');
  let body: Body = { kind: 'none' };
  switch (r.bodyKind) {
    case 'text': body = { kind: 'text', text: raw }; break;
    case 'json': body = { kind: 'json', text: raw }; break;
    case 'urlencoded': {
      const params = new URLSearchParams(raw);
      if (params.toString() === raw) body = { kind: 'urlencoded', pairs: [...params] };
      else {
        // Re-encoding would change the bytes; keep them exactly and say what the type is.
        body = { kind: 'text', text: raw };
        if (!headers.some((h) => h.name.toLowerCase() === 'content-type')) headers.push({ name: 'Content-Type', value: 'application/x-www-form-urlencoded' });
        notes.push(`${name}: form body kept as exact text (its encoding is not canonical); multipart/files cannot be reconstructed from schema 1.`);
      }
      break;
    }
    default: if (raw) { body = { kind: 'text', text: raw }; notes.push(`${name}: body kind "${String(r.bodyKind)}" kept as exact text.`); }
  }
  const method = String(r.method ?? 'GET').toUpperCase() as Endpoint['request']['method'];
  if ((method === 'GET' || method === 'HEAD') && body.kind !== 'none') {
    notes.push(`${name}: ${method} had a saved body that schema 1 never sent; it was dropped.`);
    body = { kind: 'none' };
  }
  const now = Date.now();
  const out: Endpoint = {
    id: String(e.id ?? ''),
    name,
    alias: String(e.alias ?? ''),
    request: {
      method,
      hostKey: absolute ? null : String(e.hostKey ?? 'default'),
      url: path,
      query: [],
      headers,
      credentials: (['same-origin', 'include', 'omit'].includes(String(r.credentials)) ? r.credentials : 'same-origin') as Endpoint['request']['credentials'],
      body,
    },
    checks: arr(e.checks).map(check).filter((c): c is Check => !!c),
    provenance: 'Migrated from schema 1',
    createdAt: num(e.createdAt, now),
    updatedAt: num(e.updatedAt, now),
  };
  if (isObj(e.sampleResponse)) out.sample = sample(e.sampleResponse);
  return out;
}

function check(x: unknown): Check | null {
  if (!isObj(x)) return null;
  switch (x.kind) {
    case 'status': return isObj(x.value) ? { kind: 'status', min: num(x.value.min, 200), max: num(x.value.max, 299) } : { kind: 'status', min: num(x.value, 200), max: num(x.value, 200) };
    case 'header': { const c: Check = { kind: 'header', name: String(x.name ?? '') }; if (x.value !== undefined) c.value = String(x.value); return c; }
    case 'body-contains': return { kind: 'body-contains', value: String(x.value ?? '') };
    case 'json': {
      const mode = x.mode === 'equals' || x.mode === 'type' ? x.mode : 'exists';
      const c: Check = { kind: 'json', path: String(x.path ?? ''), mode };
      if (mode !== 'exists') c.value = x.value === null ? 'null' : String(x.value ?? '');
      return c;
    }
    case 'duration': return { kind: 'duration', maxMs: num(x.maxMs, 1000) };
    default: return { kind: x.kind as 'status', min: 0, max: 0 }; // unknown kind: fails validation with its path
  }
}

function sample(x: Obj): Sample {
  let body = String(x.body ?? '');
  let bodyState: Sample['bodyState'] = 'complete';
  if (utf8Bytes(body) > BOUNDS.sampleBytes) {
    const bytes = new TextEncoder().encode(body).slice(0, BOUNDS.sampleBytes);
    body = new TextDecoder().decode(bytes).replace(/�$/, '');
    bodyState = 'truncated';
  }
  return {
    status: num(x.status, 200),
    headers: arr(x.headers).filter(isObj).filter((h) => !h.removed).map((h) => [String(h.name ?? ''), String(h.value ?? '')] as [string, string]),
    body, bodyState, source: 'migrated',
  };
}

function plan(x: Obj, order: string[]): Plan {
  const phases = isObj(x.phases) ? x.phases : {};
  const excluded = new Set(arr(x.excluded).map(String));
  const steps: Step[] = order.map((id) => ({ endpointId: id, phase: excluded.has(id) ? 'skip' : phases[id] === 'setup' ? 'setup' : 'load' }));
  return {
    id: String(x.id ?? ''),
    name: String(x.name ?? 'Plan'),
    strategy: x.strategy === 'independent' ? 'independent' : 'flow',
    mode: x.mode === 'rules' ? 'rules' : 'direct',
    steps,
    iterations: clamp(x.iterations, 1, BOUNDS.iterations, 1),
    concurrency: clamp(x.concurrency, 1, BOUNDS.concurrency, 1),
    delayMs: clamp(x.delayMs, 0, BOUNDS.delayMs, 0),
    rampUp: x.rampUp === true,
    onFailure: x.onFailure === 'stop' ? 'stop' : 'continue',
  };
}
