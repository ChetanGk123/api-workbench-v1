// Fetch adapter. Unmatched calls are delegated with the caller's exact arguments and Response.
import { BODYLESS_STATUS, LIMITS, planRequest, type Plan } from './plan';
import { readBounded, type ReqRecord, type Runtime } from './runtime';

const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)\b|[^;]*\+(json|xml)\b)/i;

export function createFetch(nativeFetch: typeof fetch, rt: Runtime): typeof fetch {
  return function awFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    // eslint-disable-next-line prefer-rest-params
    const args = arguments as unknown as Parameters<typeof fetch>;
    if (rt.inert) return nativeFetch.apply(this, args);

    let url: URL;
    let method: string;
    try {
      const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      url = new URL(raw, location.href);
      method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    } catch {
      return nativeFetch.apply(this, args); // native produces the correct rejection
    }

    const plan = planRequest(rt.config(), rt.origin, { transport: 'fetch', method, url, sync: false });
    const rec = rt.start('fetch', method, url, plan);

    if (!plan.matched) {
      const p = nativeFetch.apply(this, args);
      observe(p, rec, rt);
      return p;
    }
    const signal = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined;
    const p = plan.provider === 'mock' ? mockResponse(plan, method, signal, rec, rt) : networkResponse(nativeFetch, this, input, init, plan, rec, rt);
    observe(p, rec, rt);
    return p;
  };
}

function observe(p: Promise<Response>, rec: ReqRecord, rt: Runtime): void {
  p.then(
    (r) => rt.finish(rec, 'ok', r.status),
    (e: unknown) => rt.finish(rec, e instanceof DOMException && e.name === 'AbortError' ? 'aborted' : e instanceof DOMException && e.name === 'TimeoutError' ? 'timeout' : 'error'),
  );
}

async function mockResponse(plan: Plan, method: string, signal: AbortSignal | null | undefined, rec: ReqRecord, rt: Runtime): Promise<Response> {
  const m = plan.mock!;
  if (signal?.aborted) throw signal.reason;
  if (m.delayMs > 0) await rt.wait(m.delayMs, signal);
  const bodyless = method === 'HEAD' || BODYLESS_STATUS.has(m.status);
  const res = new Response(bodyless ? null : m.body, { status: m.status, headers: { 'content-type': m.contentType } });
  rt.op(rec, 'mock', 'applied', `Synthetic ${m.status} reply${m.delayMs ? ` after ${m.delayMs} ms` : ''}; no upstream request`);
  return res;
}

async function networkResponse(
  nativeFetch: typeof fetch,
  self: unknown,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  plan: Plan,
  rec: ReqRecord,
  rt: Runtime,
): Promise<Response> {
  let res: Response;
  if (plan.routeTo) {
    const routed = await prepareRoute(input, init, plan, rec, rt);
    res = routed ? await nativeFetch.call(self, plan.routeTo.href, routed) : await nativeFetch.call(self, input, init);
  } else {
    res = await nativeFetch.call(self, input, init);
  }
  return plan.transform ? transformResponse(res, plan.transform, rec, rt) : res;
}

/** Build routed RequestInit, or null to send the original request unchanged (route skipped with a reason). */
async function prepareRoute(input: RequestInfo | URL, init: RequestInit | undefined, plan: Plan, rec: ReqRecord, rt: Runtime): Promise<RequestInit | null> {
  const req = input instanceof Request ? input : null;
  // Init members win over Request members, exactly as in `new Request(input, init)`.
  const pick = <K extends keyof RequestInit & keyof Request>(k: K): RequestInit[K] | undefined =>
    init?.[k] !== undefined ? init[k] : req ? (req[k] as RequestInit[K]) : undefined;

  const out: RequestInit = {};
  for (const k of ['method', 'credentials', 'cache', 'redirect', 'referrer', 'referrerPolicy', 'integrity', 'keepalive', 'signal'] as const) {
    const v = pick(k);
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  const mode = pick('mode');
  if (mode && mode !== 'navigate') out.mode = mode;

  const headers = new Headers(init?.headers !== undefined ? init.headers : req?.headers);
  if (plan.dropAuthorization && headers.has('authorization')) {
    headers.delete('authorization');
    rt.note(rec, 'Authorization removed: destination is a different origin');
  }
  out.headers = headers;

  if (init?.body !== undefined) {
    if (init.body != null) out.body = init.body; // caller's BodyInit forwarded without inspection
    if ((init as { duplex?: string }).duplex) (out as { duplex?: string }).duplex = (init as { duplex?: string }).duplex!;
  } else if (req?.body) {
    if (req.bodyUsed) {
      rt.op(rec, 'route', 'skipped', 'Request body already used; original request delegated');
      return null;
    }
    // A prebuilt Request body must be re-materialized for a new URL. Bounded; read from a clone so the original stays usable.
    const release = rt.acquireBodySlot();
    if (!release) {
      rt.op(rec, 'route', 'skipped', `${LIMITS.bodyConcurrency} body preparations already running; original request sent`);
      return null;
    }
    try {
      const r = await readBounded(req.clone().body!, LIMITS.bodyBytes, LIMITS.bodyDeadlineMs, rt.own);
      if (!r.ok) {
        rt.op(rec, 'route', 'skipped', `${r.reason}; original request sent once`);
        return null;
      }
      out.body = r.bytes;
    } finally {
      release();
    }
  }
  rt.op(rec, 'route', 'applied', `Sent to ${plan.routeTo!.origin}${plan.routeTo!.pathname} (query preserved)`);
  return out;
}

async function transformResponse(res: Response, t: { find: string; replace: string }, rec: ReqRecord, rt: Runtime): Promise<Response> {
  const skip = (reason: string) => {
    rt.op(rec, 'transform', 'skipped', `${reason}; original response delivered`);
    return res;
  };
  if (res.type === 'opaque' || res.type === 'opaqueredirect' || !res.body) return skip('No readable response body');
  const ct = res.headers.get('content-type') ?? '';
  if (!TEXTUAL.test(ct)) return skip(`Content type "${ct || 'unknown'}" is not text`);
  const len = Number(res.headers.get('content-length'));
  if (len > LIMITS.bodyBytes) return skip(`Body exceeds ${LIMITS.bodyBytes} bytes`);
  const release = rt.acquireBodySlot();
  if (!release) return skip(`${LIMITS.bodyConcurrency} body operations already running`);
  let r: Awaited<ReturnType<typeof readBounded>>;
  try {
    r = await readBounded(res.clone().body!, LIMITS.bodyBytes, LIMITS.bodyDeadlineMs, rt.own);
  } finally {
    release();
  }
  if (!r.ok) return skip(r.reason);
  const text = new TextDecoder().decode(r.bytes);
  if (!text.includes(t.find)) return skip('Find text not present');
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  res.body!.cancel().catch(() => {});
  rt.op(rec, 'transform', 'applied', 'Response text replaced; rebuilt Response does not keep url/redirected');
  return new Response(text.split(t.find).join(t.replace), { status: res.status, statusText: res.statusText, headers });
}
