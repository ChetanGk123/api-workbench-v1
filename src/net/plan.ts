// Shared, pure request planner. No DOM, no globals: adapters pass everything in.

export type Transport = 'fetch' | 'xhr';
export type Module = 'mock' | 'route' | 'transform';
export type OpState = 'selected' | 'applied' | 'skipped' | 'superseded' | 'failed';

export interface Op {
  module: Module;
  state: OpState;
  reason: string;
}

export interface MockConfig {
  active: boolean;
  status: number;
  contentType: string;
  body: string;
  delayMs: number;
}

export interface Config {
  readonly revision: number;
  /** Exact pathname matched on the launch origin. */
  readonly path: string;
  readonly mock: Readonly<MockConfig>;
  /** destination is a validated absolute URL, or '' when unset/invalid. */
  readonly route: Readonly<{ active: boolean; destination: string }>;
  readonly transform: Readonly<{ active: boolean; find: string; replace: string }>;
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
  readonly mock?: Readonly<MockConfig>;
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
    path: '/api/mock-target',
    mock: { active: false, status: 200, contentType: 'application/json', body: '{"mocked":true,"note":"✓ synthetic"}', delayMs: 0 },
    route: { active: false, destination: '' },
    transform: { active: false, find: '', replace: '' },
  };
}

const NO_MATCH = (revision: number): Plan =>
  Object.freeze({ revision, matched: false, provider: 'network', dropAuthorization: false, ops: Object.freeze([]) });

export function planRequest(cfg: Config, launchOrigin: string, req: Intake): Plan {
  if (req.url.origin !== launchOrigin || req.url.pathname !== cfg.path) return NO_MATCH(cfg.revision);
  if (!cfg.mock.active && !cfg.route.active && !cfg.transform.active) return NO_MATCH(cfg.revision);

  const ops: Op[] = [];
  const syncReason = 'Synchronous XHR is passed through unchanged';
  let provider: Plan['provider'] = 'network';
  let mock: MockConfig | undefined;
  let routeTo: URL | undefined;
  let transform: { find: string; replace: string } | undefined;

  if (cfg.mock.active) {
    if (req.sync) ops.push({ module: 'mock', state: 'skipped', reason: syncReason });
    else {
      provider = 'mock';
      mock = { ...cfg.mock };
      ops.push({ module: 'mock', state: 'selected', reason: 'Synthetic reply; no upstream request' });
    }
  }

  if (cfg.route.active) {
    if (provider === 'mock') ops.push({ module: 'route', state: 'superseded', reason: 'Mock reply wins; nothing is dispatched' });
    else if (req.sync) ops.push({ module: 'route', state: 'skipped', reason: syncReason });
    else if (!cfg.route.destination) ops.push({ module: 'route', state: 'skipped', reason: 'Route destination is not a valid URL; original URL sent' });
    else {
      routeTo = routedUrl(cfg.route.destination, req.url);
      ops.push({ module: 'route', state: 'selected', reason: `Route to ${routeTo.origin}${routeTo.pathname}` });
    }
  }

  if (cfg.transform.active) {
    if (provider === 'mock') ops.push({ module: 'transform', state: 'skipped', reason: 'R0 transforms network responses only' });
    else if (req.sync) ops.push({ module: 'transform', state: 'skipped', reason: syncReason });
    else if (!cfg.transform.find) ops.push({ module: 'transform', state: 'skipped', reason: 'Find text is empty' });
    else {
      transform = { find: cfg.transform.find, replace: cfg.transform.replace };
      ops.push({ module: 'transform', state: 'selected', reason: 'Replace response text' });
    }
  }

  const plan: Plan = {
    revision: cfg.revision,
    matched: true,
    provider,
    dropAuthorization: !!routeTo && routeTo.origin !== req.url.origin,
    ops: Object.freeze(ops.map((o) => Object.freeze(o))),
    ...(mock && { mock: Object.freeze(mock) }),
    ...(routeTo && { routeTo }),
    ...(transform && { transform: Object.freeze(transform) }),
  };
  return Object.freeze(plan);
}

/** Destination path replaces the original path; the original query is preserved. */
export function routedUrl(destination: string, original: URL): URL {
  const out = new URL(destination);
  out.search = original.search;
  return out;
}

/** Returns a normalized href, or an error message. */
export function validateDestination(text: string): { ok: true; href: string } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(text.trim());
  } catch {
    return { ok: false, error: 'Enter an absolute http(s) URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'Only http and https destinations are supported' };
  if (u.username || u.password) return { ok: false, error: 'Destination must not contain credentials' };
  if (u.search || u.hash) return { ok: false, error: 'Destination must not contain a query or fragment; the original query is kept' };
  return { ok: true, href: u.href };
}

/** Transform eligibility for an XHR response type. XHR body editing is not part of R0. */
export function xhrTransformSkip(responseType: XMLHttpRequestResponseType): string {
  return responseType === '' || responseType === 'text' || responseType === 'json'
    ? 'XHR response text editing is not implemented in R0; native response delivered'
    : `XHR ${responseType} response cannot be edited as text; native typed response delivered`;
}

export const BODYLESS_STATUS = new Set([101, 103, 204, 205, 304]);

export function validateMockStatus(n: number): string | null {
  return Number.isInteger(n) && n >= 200 && n <= 599 ? null : 'Status must be an integer from 200 to 599';
}

export function validateDelay(n: number): string | null {
  return Number.isInteger(n) && n >= 0 && n <= LIMITS.delayMaxMs ? null : `Delay must be 0–${LIMITS.delayMaxMs} ms`;
}
