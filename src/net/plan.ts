// Shared, pure request planner. No DOM, no globals: adapters pass everything in.

export type Transport = 'fetch' | 'xhr';
export type Module = 'mock' | 'route' | 'intercept';
export type OpState = 'selected' | 'applied' | 'skipped' | 'superseded' | 'failed';

export interface Op {
  module: Module;
  state: OpState;
  reason: string;
  /** Readable identity of the rule that produced this operation. */
  rule?: string;
}

export const METHODS = ['*', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

interface RuleBase {
  /** Rule enabled is separate from Module active. */
  enabled: boolean;
  label: string;
  /** '*' or an upper-case method. */
  method: string;
  /** Exact pathname on the launch origin. */
  path: string;
}
export interface MockRule extends RuleBase {
  status: number;
  contentType: string;
  body: string;
  delayMs: number;
}
export interface RouteRule extends RuleBase {
  /** Validated origin, e.g. http://127.0.0.1:4311 */
  destinationOrigin: string;
  /** '' keeps the original path. */
  pathRewrite: string;
}
export interface InterceptRule extends RuleBase {
  find: string;
  replace: string;
}

export interface ModuleState<R> {
  active: boolean;
  /** R0 holds at most one rule per module. */
  rule: Readonly<R> | null;
}

export interface Config {
  readonly revision: number;
  readonly mock: Readonly<ModuleState<MockRule>>;
  readonly route: Readonly<ModuleState<RouteRule>>;
  readonly intercept: Readonly<ModuleState<InterceptRule>>;
}

export interface Intake {
  transport: Transport;
  method: string;
  url: URL;
  sync: boolean;
}

export interface Plan {
  readonly revision: number;
  readonly matched: boolean;
  readonly provider: 'network' | 'mock';
  readonly mock?: Readonly<MockRule>;
  readonly routeTo?: URL;
  /** True when routing crosses origins; Authorization is then removed. */
  readonly dropAuthorization: boolean;
  readonly transform?: Readonly<{ find: string; replace: string }>;
  /** Initial decisions; adapters copy these into the request record and settle them. */
  readonly ops: readonly Readonly<Op>[];
}

export const LIMITS = {
  delayMaxMs: 10_000,
  bodyBytes: 1024 * 1024,
  bodyDeadlineMs: 2_000,
  bodyConcurrency: 4,
  records: 500,
  eventsPerRecord: 16,
} as const;

export function defaultConfig(): Config {
  return {
    revision: 1,
    mock: { active: false, rule: null },
    route: { active: false, rule: null },
    intercept: { active: false, rule: null },
  };
}

export const newMockRule = (): MockRule => ({ enabled: true, label: '', method: '*', path: '/api/mock-target', status: 200, contentType: 'application/json', body: '{"mocked":true,"note":"✓ synthetic"}', delayMs: 0 });
export const newRouteRule = (): RouteRule => ({ enabled: true, label: '', method: '*', path: '/api/mock-target', destinationOrigin: '', pathRewrite: '' });
export const newInterceptRule = (): InterceptRule => ({ enabled: true, label: '', method: '*', path: '/api/mock-target', find: '', replace: '' });

const NO_MATCH = (revision: number): Plan =>
  Object.freeze({ revision, matched: false, provider: 'network', dropAuthorization: false, ops: Object.freeze([]) });

function selects<R extends RuleBase>(m: Readonly<ModuleState<R>>, origin: string, req: Intake): Readonly<R> | null {
  const r = m.rule;
  if (!m.active || !r || !r.enabled) return null;
  if (req.url.origin !== origin || req.url.pathname !== r.path) return null;
  return r.method === '*' || r.method === req.method ? r : null;
}

export function planRequest(cfg: Config, launchOrigin: string, req: Intake): Plan {
  const mockRule = selects(cfg.mock, launchOrigin, req);
  const routeRule = selects(cfg.route, launchOrigin, req);
  const icRule = selects(cfg.intercept, launchOrigin, req);
  if (!mockRule && !routeRule && !icRule) return NO_MATCH(cfg.revision);

  const ops: Op[] = [];
  const ruleName = (r: RuleBase) => r.label || `${r.method === '*' ? 'Any' : r.method} ${r.path}`;
  const syncReason = 'Synchronous XHR is passed through unchanged';
  let provider: Plan['provider'] = 'network';
  let routeTo: URL | undefined;
  let transform: { find: string; replace: string } | undefined;

  if (mockRule) {
    if (req.sync) ops.push({ module: 'mock', rule: ruleName(mockRule), state: 'skipped', reason: syncReason });
    else {
      provider = 'mock';
      ops.push({ module: 'mock', rule: ruleName(mockRule), state: 'selected', reason: 'Synthetic reply; no upstream request' });
    }
  }

  if (routeRule) {
    if (provider === 'mock') ops.push({ module: 'route', rule: ruleName(routeRule), state: 'superseded', reason: 'Mock reply wins; nothing is dispatched' });
    else if (req.sync) ops.push({ module: 'route', rule: ruleName(routeRule), state: 'skipped', reason: syncReason });
    else {
      routeTo = routedUrl(routeRule, req.url);
      ops.push({ module: 'route', rule: ruleName(routeRule), state: 'selected', reason: `Route to ${routeTo.origin}${routeTo.pathname}` });
    }
  }

  if (icRule) {
    if (provider === 'mock') ops.push({ module: 'intercept', rule: ruleName(icRule), state: 'skipped', reason: 'R0 intercepts network responses only' });
    else if (req.sync) ops.push({ module: 'intercept', rule: ruleName(icRule), state: 'skipped', reason: syncReason });
    else {
      transform = { find: icRule.find, replace: icRule.replace };
      ops.push({ module: 'intercept', rule: ruleName(icRule), state: 'selected', reason: 'Replace response text' });
    }
  }

  const plan: Plan = {
    revision: cfg.revision,
    matched: true,
    provider,
    dropAuthorization: !!routeTo && routeTo.origin !== req.url.origin,
    ops: Object.freeze(ops.map((o) => Object.freeze(o))),
    ...(provider === 'mock' && mockRule && { mock: mockRule }),
    ...(routeTo && { routeTo }),
    ...(transform && { transform: Object.freeze(transform) }),
  };
  return Object.freeze(plan);
}

/** Destination origin + (rewrite or original path); the original query is preserved. */
export function routedUrl(rule: Pick<RouteRule, 'destinationOrigin' | 'pathRewrite'>, original: URL): URL {
  const out = new URL(rule.pathRewrite || original.pathname, rule.destinationOrigin);
  out.search = original.search;
  return out;
}

// ---- Validators: each returns field → message for invalid fields.
export type Errors = Partial<Record<string, string>>;

function validateBase(r: RuleBase, e: Errors) {
  if (!METHODS.includes(r.method as (typeof METHODS)[number])) e.method = 'Choose a method';
  const pathErr = validatePath(r.path);
  if (pathErr) e.path = pathErr;
  if (r.label.length > 120) e.label = 'Label is limited to 120 characters';
}

export function validatePath(p: string): string | null {
  return p.startsWith('/') && !/[?#\s]/.test(p) ? null : 'Enter a pathname starting with / (no query, fragment or spaces)';
}

export function validateMockRule(r: MockRule): Errors {
  const e: Errors = {};
  validateBase(r, e);
  if (!Number.isInteger(r.status) || r.status < 200 || r.status > 599) e.status = 'Status must be an integer from 200 to 599';
  if (!Number.isInteger(r.delayMs) || r.delayMs < 0 || r.delayMs > LIMITS.delayMaxMs) e.delayMs = `Delay must be 0–${LIMITS.delayMaxMs} ms`;
  if (!r.contentType.trim() || /[\r\n]/.test(r.contentType)) e.contentType = 'Enter a Content-Type';
  return e;
}

export function validateRouteRule(r: RouteRule): Errors {
  const e: Errors = {};
  validateBase(r, e);
  const o = validateOrigin(r.destinationOrigin);
  if (!o.ok) e.destinationOrigin = o.error;
  if (r.pathRewrite) {
    const pe = validatePath(r.pathRewrite);
    if (pe) e.pathRewrite = pe;
  }
  return e;
}

export function validateInterceptRule(r: InterceptRule): Errors {
  const e: Errors = {};
  validateBase(r, e);
  if (!r.find) e.find = 'Enter the literal text to find';
  return e;
}

export function validateOrigin(text: string): { ok: true; origin: string } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(text.trim());
  } catch {
    return { ok: false, error: 'Enter an origin such as http://localhost:8080' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'Only http and https destinations are supported' };
  if (u.username || u.password) return { ok: false, error: 'Destination must not contain credentials' };
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return { ok: false, error: 'Enter only the origin; use Path rewrite for the path' };
  return { ok: true, origin: u.origin };
}

/** Transform eligibility for an XHR response type. XHR body editing is not part of R0. */
export function xhrTransformSkip(responseType: XMLHttpRequestResponseType): string {
  return responseType === '' || responseType === 'text' || responseType === 'json'
    ? 'XHR response text editing is not implemented in R0; native response delivered'
    : `XHR ${responseType} response cannot be edited as text; native typed response delivered`;
}

export const BODYLESS_STATUS = new Set([101, 103, 204, 205, 304]);
