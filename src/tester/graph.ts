// Plan dependency graph and preflight: parsed references → DAG, phase/strategy rules, exact
// projected dispatch bounds, destinations and mutating steps. Nothing is sent here.
import { BOUNDS, type Aggregate, type Condition, type Endpoint, type Plan, type Step } from '../data/schema';
import { parseExpr, referencedAliases, syntaxProblems } from './expr';
import { prepare, type Sources } from './once';

export const MAX_DISPATCH = 50_000;

export interface StepInfo { step: Step; ep: Endpoint; index: number; /** Producer endpoint IDs this step's request or guard reads. */ deps: string[] }
export interface Counts { setup: number; load: number; primary: number; poll: number; refresh: number; retry: number; worst: number }
export interface Preflight {
  ok: boolean;
  errors: string[];
  warnings: string[];
  setup: StepInfo[];
  load: StepInfo[];
  counts: Counts;
  destinations: string[];
  mutating: string[];
  /** Plan + aggregate revision this preflight describes; a run refuses a stale one. */
  key: string;
}

const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);
export const condRoot = (c: Condition) => { const r = parseExpr(c.ref); return r.ok && r.expr.k === 'ref' ? r.expr.root : null; };
export const describeCond = (c: Condition) => `${c.ref} ${{ eq: '=', ne: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥', in: 'in', exists: 'exists' }[c.op]}${c.op === 'exists' ? '' : ` ${c.value ?? ''}`}`;

function templateTexts(agg: Aggregate, ep: Endpoint): { where: string; text: string }[] {
  const r = ep.request;
  const out = [{ where: 'URL', text: r.url }, ...r.query.map(([k, v]) => ({ where: `Query ${k}`, text: v }))];
  for (const h of agg.profile.globalHeaders) out.push({ where: `Global header ${h.name}`, text: h.value });
  for (const h of r.headers) if (!h.remove) out.push({ where: `Header ${h.name}`, text: h.value });
  const b = r.body;
  if (b.kind === 'text' || b.kind === 'json') out.push({ where: 'Body', text: b.text });
  if (b.kind === 'urlencoded') for (const [k, v] of b.pairs) out.push({ where: `Form ${k}`, text: v });
  if (b.kind === 'multipart') for (const p of b.parts) if (p.kind === 'field') out.push({ where: `Field ${p.name}`, text: p.value });
  return out;
}

export function preflight(agg: Aggregate, plan: Plan, o: { once: boolean; pageOrigin: string; sources: Sources; keys: ReadonlySet<string> }): Preflight {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byAlias = new Map(agg.endpoints.map((e) => [e.alias, e]));
  const bindingNames = new Set(agg.bindings.map((b) => b.name));
  const infos: StepInfo[] = [];
  plan.steps.forEach((step, index) => {
    const ep = agg.endpoints.find((e) => e.id === step.endpointId);
    if (!ep) { errors.push(`Step ${index + 1} refers to an endpoint that no longer exists`); return; }
    if (step.phase === 'skip') return;
    infos.push({ step, ep, index, deps: [] });
  });
  const phaseOf = new Map(infos.map((i) => [i.ep.id, i.step.phase]));
  const label = (e: Endpoint) => `${e.name} (${e.alias})`;

  for (const info of infos) {
    const { ep, step } = info;
    const deps = new Set<string>();
    for (const t of templateTexts(agg, ep)) {
      errors.push(...syntaxProblems(t.text, `${label(ep)} ${t.where}`));
      for (const alias of referencedAliases(t.text)) {
        if (bindingNames.has(alias) && !byAlias.has(alias)) continue;
        const prod = byAlias.get(alias);
        if (!prod) { errors.push(`${label(ep)} ${t.where}: no endpoint has alias ${alias}`); continue; }
        if (prod.id === ep.id) { errors.push(`${label(ep)} ${t.where}: refers to its own response`); continue; }
        deps.add(prod.id);
      }
    }
    if (step.guard) {
      const root = condRoot(step.guard);
      const prod = root ? byAlias.get(root) : undefined;
      if (!prod) errors.push(`${label(ep)} guard: no endpoint has alias ${root}`);
      else if (prod.id === ep.id) errors.push(`${label(ep)} guard reads its own response; a guard is decided before the step is sent`);
      else deps.add(prod.id);
    }
    for (const a of step.assertions ?? []) {
      const root = condRoot(a);
      const prod = root ? byAlias.get(root) : undefined;
      if (!prod) errors.push(`${label(ep)} assertion ${describeCond(a)}: no endpoint has alias ${root}`);
      else if (prod.id !== ep.id) deps.add(prod.id);
    }
    if (step.poll) {
      if (condRoot(step.poll.until) !== ep.alias) errors.push(`${label(ep)} poll condition must read this step's own response (${ep.alias}.…)`);
      if (!READ_ONLY.has(ep.request.method)) errors.push(`${label(ep)} cannot be polled: ${ep.request.method} is not read-only`);
    }
    if (ep.request.body.kind === 'multipart' && ep.request.body.parts.some((p) => p.kind === 'file')) errors.push(`${label(ep)} needs a selected file; plans cannot attach files in this build (use Once)`);
    for (const id of deps) {
      const prod = agg.endpoints.find((e) => e.id === id)!;
      const ph = phaseOf.get(id);
      if (!ph) errors.push(`${label(ep)} uses ${label(prod)}, which is not a setup or load step in this plan`);
      else if (step.phase === 'setup' && ph === 'load') errors.push(`Setup step ${label(ep)} depends on load step ${label(prod)}; setup runs once before load`);
      else if (plan.strategy === 'independent' && step.phase === 'load' && ph === 'load') errors.push(`Independent: ${label(ep)} reads ${label(prod)}'s response, but independent jobs never share outputs. Use Flow, or move ${prod.alias} to setup`);
    }
    info.deps = [...deps];
  }

  // Order each phase by dependencies (stable by step order); report cycles.
  const order = (phase: 'setup' | 'load'): StepInfo[] => {
    const list = infos.filter((i) => i.step.phase === phase);
    const ids = new Set(list.map((i) => i.ep.id));
    const done = new Set<string>();
    const out: StepInfo[] = [];
    while (out.length < list.length) {
      const next = list.find((i) => !done.has(i.ep.id) && i.deps.every((d) => !ids.has(d) || done.has(d)));
      if (!next) {
        const stuck = list.filter((i) => !done.has(i.ep.id));
        errors.push(`Steps ${stuck.map((i) => i.ep.alias).join(', ')} depend on each other in a cycle`);
        out.push(...stuck);
        break;
      }
      done.add(next.ep.id);
      out.push(next);
    }
    return out;
  };
  const setup = order('setup');
  const load = order('load');
  if (!setup.length && !load.length) errors.push('Choose at least one setup or load step');

  // Projected bounds: every possible dispatch, including polls, refreshes and read-only retries.
  const reps = o.once ? 1 : plan.iterations;
  const counts: Counts = { setup: setup.length, load: load.length * reps, primary: setup.length + load.length * reps, poll: 0, refresh: 0, retry: 0, worst: 0 };
  const destinations = new Set<string>();
  const mutating: string[] = [];
  for (const [list, n] of [[setup, 1], [load, reps]] as const) {
    for (const i of list) {
      const attempts = i.step.poll?.maxAttempts ?? 1;
      counts.poll += (attempts - 1) * n;
      const ctx = i.ep.authContextId ? agg.authContexts.find((a) => a.id === i.ep.authContextId) : undefined;
      const retry = !!ctx?.refresh?.readOnlyRetry && READ_ONLY.has(i.ep.request.method);
      if (ctx?.refresh) counts.refresh += attempts * n * (retry ? 2 : 1);
      if (retry) counts.retry += attempts * n;
      if (!READ_ONLY.has(i.ep.request.method)) mutating.push(`${i.ep.request.method} ${label(i.ep)}${i.step.idempotency ? ` · idempotency header ${i.step.idempotency.header}` : ' · no idempotency key'}`);
      const p = prepare(agg, i.ep, o.pageOrigin, o.sources, new Map(), { outputs: () => ({ ok: false, why: '\u0000producer' }), keys: o.keys });
      try { if (p.url) destinations.add(new URL(p.url).origin); } catch { /* reported below */ }
      for (const b of p.blocked) {
        if (b.includes('\u0000producer') || b.includes(' is not in ')) continue; // produced during the run
        if (b.includes('no endpoint has alias') || /^[^:]+: \{\{.*\}\}: /.test(b)) continue; // reported per field above
        if (/is not available on this page|Auth context .*: .*needs |expired at/.test(b)) warnings.push(`${label(i.ep)}: ${b} (read again at dispatch)`);
        else errors.push(`${label(i.ep)}: ${b}`);
      }
      if (p.auth?.needsRefresh) warnings.push(`${label(i.ep)}: auth context ${p.auth.label} is ${p.auth.state} now; it will be refreshed before dispatch`);
    }
  }
  counts.worst = counts.primary + counts.poll + counts.refresh + counts.retry;
  if (counts.worst > MAX_DISPATCH) errors.push(`Up to ${counts.worst} requests; the limit for one run is ${MAX_DISPATCH}`);
  if (!o.once && plan.iterations > BOUNDS.iterations) errors.push(`At most ${BOUNDS.iterations} iterations`);
  if (plan.mode === 'rules') warnings.push('Apply rules: active Mock/Intercept/Route/Chaos rules can change, pause or answer these requests');
  if (plan.concurrency > 1 && mutating.length) warnings.push(`${plan.concurrency} simultaneous ${plan.strategy === 'flow' ? 'iterations' : 'requests'} share this tab's cookies and session: they are not separate users, and writes can change server state for each other`);
  return {
    ok: !errors.length, errors: [...new Set(errors)], warnings: [...new Set(warnings)], setup, load, counts,
    destinations: [...destinations], mutating, key: `${plan.id}|${agg.profile.id}|${agg.revision}|${JSON.stringify(plan)}|${o.once}`,
  };
}
