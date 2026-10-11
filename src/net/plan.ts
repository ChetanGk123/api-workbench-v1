// Shared request planner. No DOM, no globals: adapters pass everything in.
// Matching reads only the original request. The one side effect is reservation in `states`
// (sequence cursor, chaos sample, budget), done once per request in intake order.
import type { ChaosFault, ChaosRule, InterceptRule, Matcher, MockRule, MockSlot, Rule, RuleKind, RouteRule } from '../data/schema';
import { hasBodyOps, hasHeaderOps } from './patch';

export type Transport = 'fetch' | 'xhr';
export type Module = RuleKind;
export const MODULES: readonly Module[] = ['mock', 'intercept', 'route', 'chaos'];
export type OpState = 'selected' | 'applied' | 'skipped' | 'superseded' | 'failed' | 'sampled-out';
/** request/response split an intercept rule; *-pause are its breakpoints; replay is a real-chaos follow-up. */
export type Part = 'request' | 'response' | 'request-pause' | 'response-pause' | 'replay';

export interface Op {
  module: Module;
  part?: Part;
  state: OpState;
  reason: string;
  /** Readable rule identity, and the stable ID behind it. */
  rule?: string;
  ruleId?: string;
}

export interface Config {
  readonly revision: number;
  readonly active: Readonly<Record<Module, boolean>>;
  /** Saved rules with linked endpoint matchers already resolved. */
  readonly rules: readonly Readonly<Rule>[];
}

/** Runtime-only per-rule state. Reset on module activation and on an action revision. */
export interface RuleState {
  revision: number;
  cursor: number;
  hits: number;
  armedAt: number;
  rand: () => number;
}
export type RuleStates = Map<string, RuleState>;

export interface Intake {
  transport: Transport;
  method: string;
  url: URL;
  /** Script-visible request headers, or null when not known at intake. */
  headers: [string, string][] | null;
  /** Complete bounded text, or why it is not available for a body condition. */
  body: { text: string } | { reason: string };
  sync: boolean;
}

export interface Plan {
  readonly revision: number;
  readonly matched: boolean;
  readonly provider: 'network' | 'mock' | 'chaos';
  /** Mock provider: the reserved reply; null when the sequence is exhausted with a network error. */
  readonly mock?: { rule: MockRule; slot: MockSlot | null; index: number };
  /** Sampled-in chaos fault (synthetic provider or real follow-up). Random latency is resolved here. */
  readonly chaos?: { rule: ChaosRule; fault: ChaosFault; delayMs: number };
  readonly route?: { rule: RouteRule; to: URL; credentials?: RequestCredentials; dropAuthorization: boolean };
  /** Parts of the intercept rule still to run (request part and both pauses only for real traffic). */
  readonly intercept?: { rule: InterceptRule; request: boolean; response: boolean; breakRequest: boolean; breakResponse: boolean };
  readonly ops: readonly Readonly<Op>[];
  /** Selection notes: conditions that could not be evaluated, budgets used up. */
  readonly notes: readonly string[];
}

export const LIMITS = {
  bodyBytes: 1024 * 1024,
  bodyDeadlineMs: 2_000,
  bodyConcurrency: 4,
  records: 500,
  eventsPerRecord: 16,
  replayInFlight: 20,
  pauses: 20,
  pauseDeadlineMs: 30_000,
} as const;

export const BODYLESS_STATUS = new Set([101, 103, 204, 205, 304]);

export function defaultConfig(): Config {
  return { revision: 1, active: { mock: false, intercept: false, route: false, chaos: false }, rules: [] };
}

export const ruleName = (r: Rule) => r.label || `${r.matcher.method === '*' ? 'Any' : r.matcher.method} ${r.matcher.path}`;

/** Higher priority wins, then creation sequence ascending, then stable ID. */
export const byPrecedence = (a: Rule, b: Rule) => b.priority - a.priority || a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ---------- matching

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `*` stays inside one segment, `**` crosses segments. */
export const globSource = (p: string) => p.split('**').map((part) => part.split('*').map(esc).join('[^/]*')).join('.*');
const globCache = new Map<string, RegExp>();
export function globMatch(pattern: string, path: string): boolean {
  let re = globCache.get(pattern);
  if (!re) {
    re = new RegExp(`^${globSource(pattern)}$`);
    if (globCache.size > 500) globCache.clear();
    globCache.set(pattern, re);
  }
  return re.test(path);
}

export type MatchResult = { match: true } | { match: false; notEvaluated?: string };

export function matches(m: Matcher, launchOrigin: string, req: Intake): MatchResult {
  if (m.method !== '*' && m.method !== req.method) return { match: false };
  if (req.url.origin !== (m.origin || launchOrigin)) return { match: false };
  if (!globMatch(m.path, req.url.pathname)) return { match: false };
  for (const [k, v] of m.query) {
    const values = req.url.searchParams.getAll(k);
    if (!values.length || (v !== '' && !values.includes(v))) return { match: false };
  }
  if (m.headers.length) {
    if (!req.headers) return { match: false, notEvaluated: 'request headers are not known at intake' };
    for (const [k, v] of m.headers) {
      const got = req.headers.filter(([n]) => n.toLowerCase() === k.toLowerCase()).map(([, x]) => x);
      if (!got.length || (v !== '' && !got.includes(v))) return { match: false };
    }
  }
  if (m.bodyContains) {
    if (!('text' in req.body)) return { match: false, notEvaluated: `body condition not evaluated: ${req.body.reason}` };
    if (!req.body.text.includes(m.bodyContains)) return { match: false };
  }
  return { match: true };
}

// ---------- route

/** Destination URL: exact rewrite, one trailing /** capture, or the original path. The query is kept. */
export function routedUrl(rule: Pick<RouteRule, 'destinationOrigin' | 'pathRewrite' | 'matcher'>, original: URL): URL {
  let path = original.pathname;
  const rw = rule.pathRewrite;
  if (rw.endsWith('/**')) {
    const prefix = rule.matcher.path.slice(0, -3);
    const m = new RegExp(`^${globSource(prefix)}/(.*)$`).exec(original.pathname);
    path = rw.slice(0, -3) + (m ? `/${m[1]}` : '');
  } else if (rw) path = rw;
  const out = new URL(path, rule.destinationOrigin);
  out.search = original.search;
  return out;
}

// ---------- seeded sampling

function hash(text: string): number {
  let v = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { v ^= text.charCodeAt(i); v = Math.imul(v, 0x01000193); }
  return v >>> 0;
}
/** mulberry32: small and deterministic; reproduces an ordered sample stream for one seed. */
export function seeded(seed: string): () => number {
  let s = hash(seed);
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const freshState = (r: Rule, now: number): RuleState => ({
  revision: r.revision, cursor: 0, hits: 0, armedAt: now,
  rand: r.kind === 'chaos' && r.seed ? seeded(r.seed) : Math.random,
});

// ---------- planning

const NO_MATCH = (revision: number, notes: string[]): Plan =>
  Object.freeze({ revision, matched: false, provider: 'network', ops: Object.freeze([]), notes: Object.freeze(notes) });

export function planRequest(cfg: Config, states: RuleStates, launchOrigin: string, req: Intake, now = performance.now()): Plan {
  const notes: string[] = [];
  const stateOf = (r: Rule) => {
    let s = states.get(r.id);
    if (!s || s.revision !== r.revision) states.set(r.id, (s = freshState(r, now)));
    return s;
  };
  const winner = <K extends Module>(m: K): Extract<Rule, { kind: K }> | null => {
    if (!cfg.active[m]) return null;
    const list = cfg.rules.filter((r): r is Extract<Rule, { kind: K }> => r.kind === m && r.enabled).sort(byPrecedence);
    for (const r of list) {
      const res = matches(r.matcher, launchOrigin, req);
      if (!res.match) {
        if (res.notEvaluated) notes.push(`${ruleName(r)}: ${res.notEvaluated}; not matched`);
        continue;
      }
      if (r.kind === 'chaos') {
        const c = r as ChaosRule, s = stateOf(c);
        if (c.budget && s.hits >= c.budget) { notes.push(`${ruleName(c)}: hit budget ${c.budget} used; not selected`); continue; }
        if (c.durationMs && now - s.armedAt > c.durationMs) { notes.push(`${ruleName(c)}: active period of ${c.durationMs} ms ended; not selected`); continue; }
      }
      return r;
    }
    return null;
  };

  const mockR = winner('mock'), icR = winner('intercept'), routeR = winner('route'), chaosR = winner('chaos');
  if (!mockR && !icR && !routeR && !chaosR) return NO_MATCH(cfg.revision, notes);

  const ops: Op[] = [];
  const op = (r: Rule, state: OpState, reason: string, part?: Part) => ops.push({ module: r.kind, state, reason, rule: ruleName(r), ruleId: r.id, ...(part && { part }) });

  if (req.sync) {
    for (const r of [chaosR, mockR, routeR, icR]) if (r) op(r, 'skipped', 'Synchronous XHR is passed through unchanged');
    return Object.freeze({ revision: cfg.revision, matched: true, provider: 'network', ops: Object.freeze(ops), notes: Object.freeze(notes) });
  }

  // Chaos: one sample per selected request; a failed sample never tries a lower-priority rule.
  let chaos: Plan['chaos'];
  if (chaosR) {
    const s = stateOf(chaosR);
    const draw = s.rand();
    if (draw * 100 >= chaosR.probability) op(chaosR, 'sampled-out', `Not sampled (${chaosR.probability}% chance${chaosR.seed ? `, seed “${chaosR.seed}”` : ''}); request unaffected`);
    else {
      const f = chaosR.fault;
      const delayMs = f.kind === 'latency' ? f.delayMs : f.kind === 'random-latency' ? f.minMs + Math.floor(s.rand() * (f.maxMs - f.minMs + 1)) : 0;
      chaos = { rule: chaosR, fault: f, delayMs };
    }
  }
  const synthetic = chaos?.rule.mode === 'synthetic';
  let provider: Plan['provider'] = synthetic ? 'chaos' : 'network';

  let mock: Plan['mock'];
  if (mockR) {
    if (synthetic) op(mockR, 'superseded', 'A synthetic chaos fault wins over the mock reply');
    else {
      provider = 'mock';
      const s = stateOf(mockR);
      const n = mockR.slots.length;
      const i = mockR.mode === 'static' ? 0 : s.cursor++;
      const index = i < n ? i : mockR.exhaustion === 'loop' ? i % n : mockR.exhaustion === 'repeat-last' ? n - 1 : -1;
      mock = { rule: mockR, slot: index < 0 ? null : mockR.slots[index]!, index };
      op(mockR, 'selected', index < 0 ? `Sequence exhausted after ${n} replies: network error, nothing sent` : `Reply ${index + 1}${n > 1 ? ` of ${n}` : ''}; no upstream request`);
    }
  }

  if (chaos) {
    // The hit budget counts reserved faults; a superseded one gives nothing back because it never took one.
    if (provider === 'mock') { op(chaos.rule, 'superseded', 'Mock reply wins; real chaos needs real traffic'); chaos = undefined; }
    else { op(chaos.rule, 'selected', describeFault(chaos)); stateOf(chaos.rule).hits++; }
  }

  let route: Plan['route'];
  if (routeR) {
    if (provider !== 'network') op(routeR, 'superseded', `${provider === 'mock' ? 'Mock reply' : 'Synthetic chaos fault'} wins; nothing is dispatched`);
    else {
      const to = routedUrl(routeR, req.url);
      const cross = to.origin !== req.url.origin;
      route = { rule: routeR, to, dropAuthorization: cross && !routeR.keepAuthorization, ...(routeR.credentials !== 'caller' && { credentials: routeR.credentials }) };
      op(routeR, 'selected', `Route to ${to.origin}${to.pathname}`);
    }
  }

  let intercept: Plan['intercept'];
  if (icR) {
    const wantReq = hasHeaderOps(icR.request) || hasBodyOps(icR.request);
    const wantRes = hasHeaderOps(icR.response) || hasBodyOps(icR.response) || !!icR.response.status;
    const noReply = provider === 'mock' ? !mock?.slot || mock.slot.fault !== 'none' : provider === 'chaos' ? chaos!.fault.kind === 'network-error' || chaos!.fault.kind === 'timeout' : false;
    let request = false, response = false;
    if (wantReq) {
      if (provider !== 'network') op(icR, 'superseded', `${provider === 'mock' ? 'Mock reply' : 'Synthetic chaos fault'}: no request is sent to edit`, 'request');
      else { request = true; op(icR, 'selected', 'Edit request', 'request'); }
    }
    if (wantRes) {
      if (noReply) op(icR, 'superseded', 'A transport failure has no response to edit', 'response');
      else { response = true; op(icR, 'selected', 'Edit response', 'response'); }
    }
    // Breakpoints hold real traffic only: a synthetic reply has no server call to pause.
    let breakRequest = false, breakResponse = false;
    const why = provider === 'mock' ? 'Mock reply' : 'Synthetic chaos fault';
    if (icR.breakRequest) {
      if (provider !== 'network') op(icR, 'superseded', `${why}: no request is sent, so nothing is paused`, 'request-pause');
      else { breakRequest = true; op(icR, 'selected', 'Pause before sending', 'request-pause'); }
    }
    if (icR.breakResponse) {
      if (provider !== 'network') op(icR, 'superseded', `${why}: no server response to pause`, 'response-pause');
      else { breakResponse = true; op(icR, 'selected', 'Pause before delivering the response', 'response-pause'); }
    }
    if (request || response || breakRequest || breakResponse) intercept = { rule: icR, request, response, breakRequest, breakResponse };
  }

  return Object.freeze({
    revision: cfg.revision, matched: true, provider, ops: Object.freeze(ops.map((o) => Object.freeze(o))), notes: Object.freeze(notes),
    ...(mock && { mock }), ...(chaos && { chaos }), ...(route && { route }), ...(intercept && { intercept }),
  });
}

export function describeFault(c: { rule: ChaosRule; fault: ChaosFault; delayMs: number }): string {
  const f = c.fault;
  const real = c.rule.mode === 'real';
  const pre = real && c.rule.preDelayMs ? `wait ${c.rule.preDelayMs} ms, send, ` : real ? 'send, then ' : '';
  switch (f.kind) {
    case 'status': return `${pre}${real ? 'replace the response with' : 'synthetic'} HTTP ${f.status}`;
    case 'latency': case 'random-latency': return `${pre}delay delivery ${c.delayMs} ms`;
    case 'network-error': return `${pre}${real ? 'drop the response: ' : ''}network error`;
    case 'timeout': return `${pre}${real ? 'drop the response: ' : ''}time out after ${f.timeoutMs} ms`;
    case 'malformed-json': return `${pre}${real ? 'replace the body with' : 'synthetic 200 with'} malformed JSON`;
    case 'corrupt-json': return `${pre}corrupt ${f.patch.length} JSON field${f.patch.length > 1 ? 's' : ''}`;
    case 'replay': return `${pre}send ${f.copies} extra cop${f.copies > 1 ? 'ies' : 'y'}${f.gapMs ? ` ${f.gapMs} ms apart` : ''}; the page sees the first response`;
  }
}
