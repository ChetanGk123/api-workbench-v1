// Plan scheduler: setup once, Flow iterations or Independent fair job queues, bounded admission,
// guards, read-only polls, idempotency keys, auth refresh, signing, cross-step assertions, Stop.
// The run owns every controller and timer it creates; results are a bounded summary.
import { BOUNDS, type Aggregate, type Condition, type Endpoint, type Plan } from '../data/schema';
import type { AuthCoordinator, RefreshAttempt } from './auth';
import { asText, compareDecimal, decimalText, Num, parseExact, parseExpr, walk, type Sources } from './expr';
import { condRoot, describeCond, preflight, type Preflight, type StepInfo } from './graph';
import { describeCheck, evaluate, prepare, send, type OnceResult, type Prepared, type Transport } from './once';
import { signPrepared } from './sign';
import { emptyStat, record, type Stat } from './stats';

export const OUTCOMES = ['passed', 'failed-check', 'network-error', 'timeout', 'aborted', 'skipped-dependency', 'skipped-condition', 'blocked-before-dispatch'] as const;
export type ReqOutcome = (typeof OUTCOMES)[number];
export type RunState = 'queued' | 'running' | 'completed' | 'stopped' | 'failed-preflight';
const zero = () => Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<ReqOutcome, number>;

export interface CheckRow { text: string; state: 'passed' | 'failed' | 'not-evaluated'; detail: string }
export interface Attempt {
  id: number;
  endpointId: string;
  alias: string;
  phase: 'setup' | 'load' | 'auth';
  /** Flow iteration (1-based) or Independent job number; absent for setup. */
  iteration?: number;
  job?: number;
  kind: 'primary' | 'poll' | 'retry' | 'refresh';
  n: number;
  outcome: ReqOutcome;
  reason?: string;
  method: string;
  /** origin + path; query values are not kept. */
  url: string;
  status?: number;
  provider: 'network' | 'mock' | 'synthetic';
  queueMs?: number;
  headersMs?: number;
  totalMs?: number;
  bytes?: number;
  bodyState?: string;
  checks: CheckRow[];
  idempotencyKey?: string;
  signed?: boolean;
  recordId?: number;
  /** ms after the run started. */
  at: number;
}
export interface StepRow {
  endpointId: string;
  alias: string;
  name: string;
  phase: 'setup' | 'load';
  iteration?: number;
  job?: number;
  outcome: ReqOutcome;
  detail: string;
  attempts: number[];
  assertions: CheckRow[];
}
export interface EndpointStats {
  endpointId: string;
  name: string;
  alias: string;
  method: string;
  counts: Record<ReqOutcome, number>;
  network: Stat;
  synthetic: Stat;
}
export interface Sample { endpointId: string; attemptId: number; status: number; headers: [string, string][]; body: string; bodyState: string; at: number }
export interface RunSummary {
  schema: 2;
  id: string;
  planId: string;
  planName: string;
  profileId: string;
  profileName: string;
  configRevision: number;
  kind: 'once' | 'load';
  strategy: Plan['strategy'];
  mode: Plan['mode'];
  iterations: number;
  concurrency: number;
  state: RunState;
  startedAt: number;
  endedAt?: number;
  preflight: Pick<Preflight, 'errors' | 'warnings' | 'counts' | 'destinations' | 'mutating'>;
  progress: { done: number; total: number };
  counts: Record<ReqOutcome, number>;
  dispatched: { total: number; network: number; synthetic: number; poll: number; retry: number; refresh: number };
  endpoints: EndpointStats[];
  steps: StepRow[];
  stepsDropped: number;
  attempts: Attempt[];
  attemptsDropped: number;
  samples: Sample[];
  notes: string[];
}

export interface RunInput {
  agg: Aggregate;
  plan: Plan;
  once: boolean;
  pageOrigin: string;
  sources(): Sources;
  transport: Transport;
  auth: AuthCoordinator;
  limit: number;
  now?: () => number;
  uuid?: () => string;
  random?: () => number;
}
export interface RunHandle {
  id: string;
  summary: RunSummary;
  /** Retained configuration this run used (live runs only; not stored). */
  snapshot: { agg: Aggregate; plan: Plan };
  stop(why?: string): void;
  done: Promise<RunSummary>;
  subscribe(fn: () => void): () => void;
  /** The latest response body per endpoint as read (up to the body-check limit), in memory only: never stored. */
  fullBody(endpointId: string): string | undefined;
}

export const KEEP = { attempts: 500, steps: 1000, sampleBytes: BOUNDS.sampleBytes } as const;
const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);
const SENSITIVE_KEY = /token|secret|password|session|csrf|xsrf|signature|authorization|api[-_]?key/i;
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$|token|secret|session|csrf|xsrf|signature/i;

/** Mask sensitive JSON keys in a sample body; other text is kept as received. */
export function redactSample(text: string): string {
  try {
    const doc = parseExact(text);
    const scrub = (v: unknown): unknown => Array.isArray(v) ? v.map(scrub)
      : v && typeof v === 'object' && !(v instanceof Num) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SENSITIVE_KEY.test(k) && typeof x === 'string' ? '[redacted]' : scrub(x)]))
      : v;
    const out = scrub(doc);
    return JSON.stringify(out, (_k, v) => (v instanceof Num ? Number(v.raw) : v)) === text ? text : stringify(out);
  } catch { return text; }
}
const stringify = (v: unknown): string => (v instanceof Num ? v.raw : Array.isArray(v) ? `[${v.map(stringify).join(',')}]` : v && typeof v === 'object' ? `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}:${stringify(x)}`).join(',')}}` : JSON.stringify(v) ?? 'null');

/** Condition over same-context outputs: true/false, or unavailable with the reason. */
export function checkCondition(c: Condition, get: (alias: string) => { ok: true; value: unknown } | { ok: false; why: string }): { ok: boolean | null; detail: string } {
  const r = parseExpr(c.ref);
  if (!r.ok || r.expr.k !== 'ref') return { ok: null, detail: `${c.ref} is not a field reference` };
  const src = get(r.expr.root);
  if (!src.ok) return { ok: null, detail: src.why };
  const at = walk(src.value, r.expr.path);
  if (c.op === 'exists') return { ok: at.found, detail: at.found ? 'present' : 'missing' };
  if (!at.found) return { ok: false, detail: `${c.ref} is missing` };
  let got: string;
  try { got = asText(at.value); } catch { return { ok: false, detail: `${c.ref} is not a single value` }; }
  const want = c.value ?? '';
  const numeric = decimalText(at.value instanceof Num || typeof at.value === 'number' ? at.value : got);
  switch (c.op) {
    case 'eq': case 'ne': {
      const wn = decimalText(want);
      const same = (at.value instanceof Num || typeof at.value === 'number') && numeric !== null && wn !== null ? compareDecimal(numeric, wn) === 0 : got === want;
      return { ok: c.op === 'eq' ? same : !same, detail: `got ${got}` };
    }
    case 'in': { const set = want.split(',').map((s) => s.trim()); return { ok: set.includes(got), detail: `got ${got}` }; }
    default: {
      if (numeric === null) return { ok: false, detail: `${got} is not an exact decimal` };
      const cmp = compareDecimal(numeric, decimalText(want)!);
      const ok = c.op === 'lt' ? cmp < 0 : c.op === 'lte' ? cmp <= 0 : c.op === 'gt' ? cmp > 0 : cmp >= 0;
      return { ok, detail: `got ${got}` };
    }
  }
}

/** Counting semaphore whose waiters leave on abort. */
function semaphore(n: number) {
  let free = n;
  const queue: (() => void)[] = [];
  return {
    acquire(signal: AbortSignal): Promise<() => void> {
      const release = () => { const next = queue.shift(); if (next) next(); else free++; };
      if (signal.aborted) return Promise.reject(new DOMException('Stopped', 'AbortError'));
      if (free > 0) { free--; return Promise.resolve(once(release)); }
      return new Promise((resolve, reject) => {
        const go = () => { signal.removeEventListener('abort', off); resolve(once(release)); };
        const off = () => { const i = queue.indexOf(go); if (i >= 0) queue.splice(i, 1); reject(new DOMException('Stopped', 'AbortError')); };
        queue.push(go);
        signal.addEventListener('abort', off, { once: true });
      });
    },
  };
}
const once = (fn: () => void) => { let done = false; return () => { if (!done) { done = true; fn(); } }; };

let seq = 0;
export const newRunId = () => `run-${Date.now().toString(36)}-${(++seq).toString(36)}`;

export function startRun(input: RunInput): RunHandle {
  const agg = structuredClone(input.agg);
  const plan = structuredClone(input.plan);
  const now = input.now ?? Date.now;
  const uuid = input.uuid ?? (() => crypto.randomUUID());
  const random = input.random ?? Math.random;
  const t0 = performance.now();
  const since = () => Math.round(performance.now() - t0);
  const ctl = new AbortController();
  const subs = new Set<() => void>();
  const changed = () => subs.forEach((f) => f());
  const pf = preflight(agg, plan, { once: input.once, pageOrigin: input.pageOrigin, sources: input.sources(), keys: new Set(input.auth.keys.keys()) });
  const reps = input.once ? 1 : plan.iterations;
  const s: RunSummary = {
    schema: 2, id: newRunId(), planId: plan.id, planName: plan.name, profileId: agg.profile.id, profileName: agg.profile.name, configRevision: agg.revision,
    kind: input.once ? 'once' : 'load', strategy: plan.strategy, mode: plan.mode, iterations: reps, concurrency: plan.concurrency,
    state: pf.ok ? 'running' : 'failed-preflight', startedAt: now(),
    preflight: { errors: pf.errors, warnings: pf.warnings, counts: pf.counts, destinations: pf.destinations, mutating: pf.mutating },
    progress: { done: 0, total: pf.counts.setup + pf.counts.load }, counts: zero(),
    dispatched: { total: 0, network: 0, synthetic: 0, poll: 0, retry: 0, refresh: 0 },
    endpoints: [...pf.setup, ...pf.load].map((i) => ({ endpointId: i.ep.id, name: i.ep.name, alias: i.ep.alias, method: i.ep.request.method, counts: zero(), network: emptyStat(), synthetic: emptyStat() })),
    steps: [], stepsDropped: 0, attempts: [], attemptsDropped: 0, samples: [], notes: [],
  };
  const counters = new Map<string, number>();
  const sem = semaphore(plan.concurrency);
  let nextAttempt = 1;
  let stopReason = '';

  const stat = (id: string) => s.endpoints.find((e) => e.endpointId === id)!;
  const pushAttempt = (a: Attempt) => {
    s.attempts.push(a);
    if (s.attempts.length > KEEP.attempts) { s.attempts.shift(); s.attemptsDropped++; }
    changed();
  };
  const pushStep = (r: StepRow) => {
    s.steps.push(r);
    if (s.steps.length > KEEP.steps) { s.steps.shift(); s.stepsDropped++; }
    s.counts[r.outcome]++;
    if (s.endpoints.some((e) => e.endpointId === r.endpointId)) stat(r.endpointId).counts[r.outcome]++;
    s.progress.done++;
    changed();
  };

  const sleep = (ms: number) => new Promise<boolean>((resolve) => {
    if (ctl.signal.aborted) return resolve(false);
    const t = setTimeout(() => { ctl.signal.removeEventListener('abort', off); resolve(true); }, ms);
    const off = () => { clearTimeout(t); resolve(false); };
    ctl.signal.addEventListener('abort', off, { once: true });
  });

  function stop(why = 'Stopped by you') {
    if (ctl.signal.aborted) return;
    stopReason = why;
    ctl.abort(new DOMException(why, 'AbortError'));
  }

  type Out = { ok: true; value: unknown } | { ok: false; why: string };
  type Ctx = { outputs: Map<string, Out>; outcomes: Map<string, ReqOutcome>; parent?: Ctx };
  const lookup = (ctx: Ctx, alias: string): Out => {
    for (let c: Ctx | undefined = ctx; c; c = c.parent) { const o = c.outputs.get(alias); if (o) return o; }
    return { ok: false, why: `${alias} has not run in this ${input.once ? 'pass' : plan.strategy === 'flow' ? 'iteration' : 'job'}` };
  };
  const outcomeOf = (ctx: Ctx, id: string): ReqOutcome | undefined => {
    for (let c: Ctx | undefined = ctx; c; c = c.parent) { const o = c.outcomes.get(id); if (o) return o; }
    return undefined;
  };

  /** One transmitted attempt (with an explicit refresh before it when needed). */
  async function attempt(info: StepInfo, where: { phase: 'setup' | 'load'; iteration?: number; job?: number }, build: () => Prepared, kind: Attempt['kind'], n: number, queuedAt: number): Promise<{ a: Attempt; res: OnceResult | null; ids: number[] }> {
    const ep = info.ep;
    const base: Omit<Attempt, 'outcome' | 'checks'> = { id: 0, endpointId: ep.id, alias: ep.alias, phase: where.phase, ...(where.iteration !== undefined && { iteration: where.iteration }), ...(where.job !== undefined && { job: where.job }), kind, n, method: ep.request.method, url: '', provider: 'network', at: since() };
    const done = (a: Attempt, res: OnceResult | null) => { a.id = nextAttempt++; pushAttempt(a); return { a, res, ids: [a.id] }; };
    const blocked = (reason: string, p?: Prepared) => done({ ...base, url: p ? strip(p.url) : '', outcome: 'blocked-before-dispatch', reason, checks: [] }, null);
    let p = build();
    const ctx = ep.authContextId ? agg.authContexts.find((c) => c.id === ep.authContextId) : undefined;
    const doRefresh = async (): Promise<string | null> => {
      if (!ctx) return 'no auth context';
      try {
        return await input.auth.refresh(ctx, ctl.signal, { admit: (sig) => sem.acquire(anySignal(sig, ctl.signal)), report: reportRefresh });
      } catch { return 'stopped'; }
    };
    if (p.auth?.needsRefresh) {
      const err = await doRefresh();
      if (ctl.signal.aborted) return done({ ...base, url: strip(p.url), outcome: 'aborted', reason: stopReason, checks: [] }, null);
      if (err) return blocked(`Auth context ${p.auth.label}: refresh failed — ${err}`, p);
      p = build();
      if (p.auth?.needsRefresh) return blocked(`Auth context ${p.auth.label} is still ${p.auth.state} after refresh: ${p.auth.detail}`, p);
    }
    if (p.blocked.length) return blocked(p.blocked.join('; '), p);
    let release: () => void;
    try { release = await sem.acquire(ctl.signal); } catch { return done({ ...base, url: strip(p.url), outcome: 'aborted', reason: stopReason, checks: [] }, null); }
    const queueMs = Math.round(performance.now() - queuedAt);
    let res: OnceResult;
    let signed = false;
    try {
      if (p.signing) {
        const key = input.auth.keys.get(p.signing.keyRef);
        if (!key) { release(); return blocked(`Signing key "${p.signing.keyRef}" was removed`, p); }
        p = { ...p, headers: (await signPrepared(p, key, now(), uuid())).headers };
        signed = true;
      }
      s.dispatched.total++;
      if (kind === 'poll') s.dispatched.poll++;
      if (kind === 'retry') s.dispatched.retry++;
      res = await send(p, input.transport, ctl.signal, input.limit);
    } finally { release(); }
    const provider = res.provider ?? 'network';
    s.dispatched[provider === 'network' ? 'network' : 'synthetic']++;
    const checks = evaluate(ep.checks, res).map((c) => ({ text: describeCheck(c.check), state: c.state, detail: c.detail }));
    const outcome: ReqOutcome = res.outcome === 'aborted' ? 'aborted' : res.outcome === 'network-error' ? 'network-error'
      : checks.some((c) => c.state !== 'passed') ? 'failed-check' : 'passed';
    const a: Attempt = {
      ...base, url: strip(p.url), outcome, provider, queueMs, totalMs: res.ms, checks, signed,
      ...(res.status !== undefined && { status: res.status }), ...(res.headersMs !== undefined && { headersMs: res.headersMs }),
      ...(res.outcome === 'response' && { bytes: res.body.bytes, bodyState: res.body.state }), ...(res.recordId !== undefined && { recordId: res.recordId }),
      ...(res.error && { reason: res.outcome === 'aborted' ? stopReason || res.error : res.error }),
      ...(info.step.idempotency && { idempotencyKey: p.headers.find((h) => h.name.toLowerCase() === info.step.idempotency!.header.toLowerCase())?.value ?? '' }),
    };
    if (res.outcome === 'response') record(provider === 'network' ? stat(ep.id).network : stat(ep.id).synthetic, res.ms);
    const out = done(a, res);
    // One explicitly configured read-only retry after 401, with the same prepared values. Never for writes.
    if (res.status === 401 && kind !== 'retry' && ctx?.refresh?.readOnlyRetry && READ_ONLY.has(ep.request.method) && !ctl.signal.aborted) {
      const err = await doRefresh();
      if (!err && !ctl.signal.aborted) {
        const r = await attempt(info, where, build, 'retry', n + 1, performance.now());
        return { ...r, ids: [a.id, ...r.ids] };
      }
      a.reason = `401; refresh before the read-only retry failed: ${err}`;
    } else if (res.status === 401 && ctx?.refresh && !READ_ONLY.has(ep.request.method)) a.reason = '401 on a write: not retried automatically; reconcile with a read-only status check';
    return out;
  }

  function reportRefresh(r: RefreshAttempt) {
    const ep = agg.endpoints.find((e) => e.id === r.endpointId);
    s.dispatched.refresh++;
    if (r.result) { s.dispatched.total++; s.dispatched[(r.result.provider ?? 'network') === 'network' ? 'network' : 'synthetic']++; }
    const outcome: ReqOutcome = !r.result ? 'blocked-before-dispatch' : r.error ? (r.result.outcome === 'aborted' ? 'timeout' : r.result.outcome === 'network-error' ? 'network-error' : 'failed-check') : 'passed';
    pushAttempt({
      id: nextAttempt++, endpointId: r.endpointId, alias: ep?.alias ?? '?', phase: 'auth', kind: 'refresh', n: 1, outcome, method: ep?.request.method ?? '', url: r.prepared ? strip(r.prepared.url) : '',
      provider: r.result?.provider ?? 'network', totalMs: r.ms, checks: [], at: since(),
      ...(r.result?.status !== undefined && { status: r.result.status }), ...(r.error && { reason: r.error }),
    });
  }

  /** One logical step in a context: dependency/guard decisions, attempts (polls), outputs, assertions. */
  async function runStep(info: StepInfo, ctx: Ctx, where: { phase: 'setup' | 'load'; iteration?: number; job?: number }) {
    const ep = info.ep;
    const row = (outcome: ReqOutcome, detail: string, attempts: number[] = [], assertions: CheckRow[] = []): StepRow => ({
      endpointId: ep.id, alias: ep.alias, name: ep.name, phase: where.phase, ...(where.iteration !== undefined && { iteration: where.iteration }), ...(where.job !== undefined && { job: where.job }), outcome, detail, attempts, assertions,
    });
    const finish = (r: StepRow) => { ctx.outcomes.set(ep.id, r.outcome); pushStep(r); return r; };
    const queuedAt = performance.now();
    for (const d of info.deps) {
      const o = outcomeOf(ctx, d);
      if (o !== 'passed') {
        const prod = agg.endpoints.find((e) => e.id === d)!;
        ctx.outputs.set(ep.alias, { ok: false, why: `${ep.alias} was skipped` });
        return finish(row('skipped-dependency', o ? `Producer ${prod.alias} ended ${o}` : `Producer ${prod.alias} did not run`));
      }
    }
    const get = (alias: string) => lookup(ctx, alias);
    if (info.step.guard) {
      const g = checkCondition(info.step.guard, get);
      if (g.ok !== true) {
        ctx.outputs.set(ep.alias, { ok: false, why: `${ep.alias} was skipped by its guard` });
        return finish(row(g.ok === null ? 'skipped-dependency' : 'skipped-condition', `Guard ${describeCond(info.step.guard)}: ${g.detail}`));
      }
    }
    // One logical operation: one reservation map (UUIDs, counters, idempotency key) for all its attempts.
    const reserved = new Map<string, unknown>();
    const idem = info.step.idempotency ? [{ name: info.step.idempotency.header, value: uuid() }] : [];
    const build = () => prepare(agg, ep, input.pageOrigin, input.sources(), new Map(), {
      outputs: (alias) => lookup(ctx, alias), reserved, counters, now, uuid, random,
      authSources: input.auth.sources, keys: new Set(input.auth.keys.keys()), stepHeaders: idem,
    });
    const poll = info.step.poll;
    const deadline = poll ? performance.now() + poll.deadlineMs : 0;
    const ids: number[] = [];
    let last: { a: Attempt; res: OnceResult | null } | null = null;
    let detail = '';
    let polled: 'met' | 'pending' | null = null;
    for (let n = 1; ; n++) {
      const r = await attempt(info, where, build, n === 1 ? 'primary' : 'poll', n, queuedAt);
      ids.push(...r.ids);
      last = r;
      ctx.outputs.set(ep.alias, outputOf(r.res, ep.alias));
      if (!poll || !r.res || r.res.outcome !== 'response') break;
      const u = checkCondition(poll.until, get);
      if (u.ok === true) { polled = 'met'; detail = `Poll condition met on attempt ${n}`; break; }
      if (n >= poll.maxAttempts) { polled = 'pending'; detail = `Still pending after ${n} attempt(s) (${describeCond(poll.until)}: ${u.detail})`; break; }
      if (performance.now() + poll.intervalMs > deadline) { polled = 'pending'; detail = `Poll deadline ${poll.deadlineMs} ms reached after ${n} attempt(s) (${u.detail})`; break; }
      if (!(await sleep(poll.intervalMs))) break;
    }
    const final = last!.a;
    let outcome: ReqOutcome = final.outcome;
    if (polled === 'pending' && outcome === 'passed') outcome = 'timeout';
    if (!detail) detail = final.reason ?? (final.status !== undefined ? `HTTP ${final.status}` : final.outcome);
    // Cross-step assertions over declared producers in this context, after the step's own output.
    const assertions: CheckRow[] = [];
    if (final.outcome === 'passed' || final.outcome === 'failed-check') {
      for (const c of info.step.assertions ?? []) {
        const r = checkCondition(c, get);
        assertions.push({ text: describeCond(c), state: r.ok === null ? 'not-evaluated' : r.ok ? 'passed' : 'failed', detail: r.detail });
      }
      if (outcome === 'passed' && assertions.some((x) => x.state !== 'passed')) { outcome = 'failed-check'; detail = 'Assertion failed'; }
    }
    if (outcome !== 'passed') ctx.outputs.set(ep.alias, ctx.outputs.get(ep.alias)?.ok ? ctx.outputs.get(ep.alias)! : { ok: false, why: `${ep.alias} ended ${outcome}` });
    if (last?.res?.outcome === 'response') keepSample(ep, final, last.res);
    return finish(row(outcome, detail, ids, assertions));
  }

  const full = new Map<string, string>();
  function keepSample(ep: Endpoint, a: Attempt, res: OnceResult) {
    full.set(ep.id, res.body.text);
    const enc = new TextEncoder().encode(res.body.text);
    const cut = enc.byteLength > KEEP.sampleBytes;
    const body = redactSample(cut ? new TextDecoder().decode(enc.slice(0, KEEP.sampleBytes)).replace(/�$/, '') : res.body.text);
    const sample: Sample = { endpointId: ep.id, attemptId: a.id, status: res.status!, headers: res.headers.filter(([k]) => !SENSITIVE_HEADER.test(k)), body, bodyState: cut && res.body.state === 'complete' ? 'truncated' : res.body.state, at: now() };
    const i = s.samples.findIndex((x) => x.endpointId === ep.id);
    if (i >= 0) s.samples[i] = sample; else s.samples.push(sample);
  }

  async function iteration(ctx: Ctx, list: StepInfo[], where: { iteration?: number; job?: number }) {
    for (const info of list) {
      if (ctl.signal.aborted) return;
      const r = await runStep(info, ctx, { phase: 'load', ...where });
      if (plan.onFailure === 'stop' && r.outcome !== 'passed' && r.outcome !== 'skipped-condition') stop(`Stopped after ${r.alias} ended ${r.outcome} (failure policy: stop)`);
    }
  }

  async function main(): Promise<RunSummary> {
    if (!pf.ok) { s.endedAt = now(); s.notes.push('Nothing was sent: fix the preflight errors first.'); return s; }
    const setupCtx: Ctx = { outputs: new Map(), outcomes: new Map() };
    for (const info of pf.setup) {
      if (ctl.signal.aborted) break;
      await runStep(info, setupCtx, { phase: 'setup' });
    }
    const failedSetup = pf.setup.filter((i) => setupCtx.outcomes.get(i.ep.id) !== 'passed');
    if (failedSetup.length && !ctl.signal.aborted) s.notes.push(`Load not started: setup ${failedSetup.map((i) => `${i.ep.alias} ${setupCtx.outcomes.get(i.ep.id) ?? 'did not run'}`).join(', ')}`);
    else if (pf.load.length && !ctl.signal.aborted) {
      // Setup outputs are shared read-only; every iteration/job gets a fresh context on top.
      const frozen: Ctx = { outputs: new Map(setupCtx.outputs), outcomes: new Map(setupCtx.outcomes) };
      const workers: Promise<void>[] = [];
      if (plan.strategy === 'flow' || input.once) {
        let next = 0;
        for (let w = 0; w < Math.min(plan.concurrency, reps); w++) workers.push((async () => {
          if (plan.rampUp && w && !(await sleep(w * plan.rampStepMs))) return;
          while (!ctl.signal.aborted && next < reps) {
            const i = ++next;
            await iteration({ outputs: new Map(), outcomes: new Map(), parent: frozen }, pf.load, input.once ? {} : { iteration: i });
            if (plan.delayMs && next < reps && !(await sleep(plan.delayMs))) return;
          }
        })());
      } else {
        // Independent: one queue per endpoint, fair round-robin admission, one global concurrency limit.
        const left = pf.load.map(() => reps);
        let turn = 0, job = 0;
        const take = (): StepInfo | null => {
          for (let k = 0; k < left.length; k++) {
            const q = (turn + k) % left.length;
            if (left[q]! > 0) { left[q]!--; turn = q + 1; return pf.load[q]!; }
          }
          return null;
        };
        for (let w = 0; w < plan.concurrency; w++) workers.push((async () => {
          if (plan.rampUp && w && !(await sleep(w * plan.rampStepMs))) return;
          for (let info = take(); info && !ctl.signal.aborted; info = take()) {
            const n = ++job;
            await iteration({ outputs: new Map(), outcomes: new Map(), parent: frozen }, [info], { job: n });
            if (plan.delayMs && left.some((x) => x > 0) && !(await sleep(plan.delayMs))) return;
          }
        })());
      }
      await Promise.all(workers);
    }
    s.state = ctl.signal.aborted ? 'stopped' : 'completed';
    if (ctl.signal.aborted) s.notes.push(`${stopReason}. ${s.progress.total - s.progress.done} planned step(s) were not started; nothing more was sent.`);
    s.endedAt = now();
    return s;
  }

  const done = main().finally(() => { if (!ctl.signal.aborted) ctl.abort(new DOMException('Run ended', 'AbortError')); changed(); });
  return {
    id: s.id, summary: s, snapshot: { agg, plan }, stop, done,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    fullBody: (id) => full.get(id),
  };
}

function outputOf(res: OnceResult | null, alias: string): { ok: true; value: unknown } | { ok: false; why: string } {
  if (!res || res.outcome !== 'response') return { ok: false, why: `${alias} has no response` };
  if (res.body.state !== 'complete') return { ok: false, why: `${alias}'s body is ${res.body.state}; partial data is never used` };
  try { return { ok: true, value: parseExact(res.body.text) }; } catch { return { ok: false, why: `${alias}'s response is not JSON` }; }
}
const strip = (url: string) => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return url; } };
function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  const c = new AbortController();
  for (const s of [a, b]) { if (s.aborted) c.abort(); else s.addEventListener('abort', () => c.abort(), { once: true }); }
  return c.signal;
}
