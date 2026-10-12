// Fetch adapter. Unmatched calls are delegated with the caller's exact arguments and Response.
// Matched calls follow the NETWORK pipeline: provider (synthetic chaos > mock > network), request
// work, one primary dispatch, response work, real chaos, then delivery. Replay copies bypass rules.
import { utf8Bytes, type Credentials, type Pair, type Transform } from '../data/schema';
import { CAP, cleanHeaders, isA, isAbort, newCapture, readPrefix, redactText, requestBody, sensitiveName, textualType } from './capture';
import { applyPatch, editHeaders, hasBodyOps, hasHeaderOps, transformBody } from './patch';
import { BODYLESS_STATUS, LIMITS, planRequest, type Intake, type Plan } from './plan';
import { readBounded, sameHeaders, type PauseView, type ReqRecord, type Runtime } from './runtime';

const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)\b|[^;]*\+(json|xml)\b)/i;
const STATUS_TEXT: Record<number, string> = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 422: 'Unprocessable Content', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };
export const statusText = (s: number) => STATUS_TEXT[s] ?? '';

/** What a body condition can see: complete bounded text, or why not. Never reads a stream. */
export function matchBody(body: unknown): Intake['body'] {
  if (body == null) return { text: '' };
  const text = typeof body === 'string' ? body : isA(body, 'URLSearchParams') ? String(body) : null;
  if (text === null) return { reason: `a ${Object.prototype.toString.call(body).slice(8, -1)} body is not read for matching` };
  return utf8Bytes(text) <= LIMITS.bodyBytes ? { text } : { reason: `body over ${LIMITS.bodyBytes} bytes` };
}

export const networkError = () => new TypeError('Failed to fetch');
export const timeoutError = (ms: number) => new DOMException(`Workbench chaos: no response within ${ms} ms`, 'TimeoutError');
export const jsonOrText = (body: string) => { try { JSON.parse(body); return 'application/json'; } catch { return 'text/plain;charset=UTF-8'; } };

/** Legal synthetic Response: HEAD and bodyless statuses carry no body. */
function synth(status: number, headers: HeadersInit, body: string, method: string): Response {
  const bodyless = method === 'HEAD' || BODYLESS_STATUS.has(status);
  return new Response(bodyless ? null : body, { status, statusText: statusText(status), headers });
}

/** `win` is the window whose fetch this wraps: relative URLs resolve against its current address (frames too). */
export function createFetch(nativeFetch: typeof fetch, rt: Runtime, win: Window = window): typeof fetch {
  const handle = createHandler(nativeFetch, rt, win);
  if (win === window) return handle;
  // A frame's code gets its own realm's Promise/Response/errors, so `instanceof` checks there keep working.
  // Network responses already come from the frame's native fetch; synthetic and rebuilt ones are re-wrapped.
  const W = win as Window & typeof globalThis;
  const ownRealm = (r: Response): boolean => r instanceof W.Response; // the types match across realms; the classes do not
  return function awFetch(this: unknown) {
    // eslint-disable-next-line prefer-rest-params
    return W.Promise.resolve(handle.apply(this, arguments as unknown as Parameters<typeof fetch>)).then(
      (r: Response) => (ownRealm(r) ? r : new W.Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers })),
      (e: unknown) => {
        if (e instanceof W.Error || !(e instanceof Error)) throw e;
        throw e.name === 'TypeError' ? new W.TypeError(e.message) : new W.DOMException(e.message, e.name);
      });
  } as typeof fetch;
}

function createHandler(nativeFetch: typeof fetch, rt: Runtime, win: Window): typeof fetch {
  return function awFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    // eslint-disable-next-line prefer-rest-params
    const args = arguments as unknown as Parameters<typeof fetch>;
    if (rt.inert) return nativeFetch.apply(this, args);

    let url: URL;
    let method: string;
    const req = isA(input, 'Request') ? input as Request : null;
    try {
      url = new URL(req ? req.url : isA(input, 'URL') ? (input as URL).href : String(input), win.location.href);
      method = String(init?.method ?? (req ? req.method : 'GET')).toUpperCase();
    } catch {
      return nativeFetch.apply(this, args); // native produces the correct rejection
    }
    let headers: [string, string][] | null;
    try { headers = [...new Headers(init?.headers !== undefined ? init.headers : req?.headers)]; } catch { headers = null; }
    const body = init?.body !== undefined ? matchBody(init.body) : req?.body ? { reason: 'a prebuilt Request body is not read for matching' } : { text: '' };

    const plan = planRequest(rt.config(), rt.states, rt.origin, { transport: 'fetch', method, url, headers, body, sync: false });
    const rec = rt.start('fetch', method, url, plan);
    const reqBody = rt.capturing ? captureRequest(input, init, url, method, rec, rt) : undefined;

    if (!plan.matched) {
      const p = nativeFetch.apply(this, args);
      observe(p, rec, rt, reqBody);
      return p;
    }
    const signal = init?.signal !== undefined ? init.signal : req ? req.signal : undefined;
    const p = run(nativeFetch, this, input, init, url.href, method, signal, plan, rec, rt);
    observe(p, rec, rt, reqBody);
    return p;
  };
}

async function run(nativeFetch: typeof fetch, self: unknown, input: RequestInfo | URL, init: RequestInit | undefined, href: string, method: string, signal: AbortSignal | null | undefined, plan: Plan, rec: ReqRecord, rt: Runtime): Promise<Response> {
  if (signal?.aborted) throw signal.reason;
  if (plan.provider === 'chaos') return syntheticChaos(plan, method, signal, rec, rt);
  if (plan.provider === 'mock') return mockResponse(plan, method, signal, rec, rt);

  const chaos = plan.chaos;
  const ic = plan.intercept;
  const changes = !!(plan.route || ic?.request || chaos?.fault.kind === 'replay');
  let prepared = changes || ic?.breakRequest ? await prepare(input, init, href, plan, rec, rt) : null;
  if (ic?.breakRequest) {
    const d = await requestPause(prepared, input, init, href, method, signal, plan, rec, rt);
    if (d === 'abort') throw new DOMException('Workbench breakpoint: request aborted before it was sent', 'AbortError');
    if (d !== 'keep') prepared = d;
    else if (!changes) prepared = null; // unchanged: the caller's own arguments, exactly as given
  }
  if (chaos?.rule.preDelayMs) await rt.wait(chaos.rule.preDelayMs, signal);
  const target = prepared?.url ?? input;
  const dispatched = nativeFetch.call(self, target, prepared?.init ?? init);
  if (chaos?.fault.kind === 'replay') replay(nativeFetch, prepared, chaos.fault, signal, rec, rt);
  let res: Response;
  if (chaos?.fault.kind === 'timeout') {
    // Real timeout: the request was sent and keeps running upstream; the page stops waiting.
    const ms = chaos.fault.timeoutMs;
    res = await Promise.race([dispatched, rt.wait(ms, signal).then(() => {
      rt.op(rec, 'chaos', 'applied', `No response delivered within ${ms} ms: timed out (the request was sent; upstream effects may occur)`);
      throw timeoutError(ms);
    })]);
  } else res = await dispatched;
  if (ic?.response) res = await transformResponse(res, ic.rule.response, method, rec, rt);
  if (chaos) res = await realChaos(res, plan, method, signal, rec, rt);
  return ic?.breakResponse ? responsePause(res, method, signal, plan, rec, rt) : res;
}

// ---------- breakpoints (pause registry in runtime)

/** Hold the effective request before dispatch. 'keep' = send as prepared; a Prepared = send the edit. */
async function requestPause(prepared: Prepared | null, input: RequestInfo | URL, init: RequestInit | undefined, href: string, method: string, signal: AbortSignal | null | undefined, plan: Plan, rec: ReqRecord, rt: Runtime): Promise<Prepared | 'keep' | 'abort'> {
  let view: PauseView;
  if (prepared) {
    const b = prepared.init.body;
    const ct = new Headers(prepared.init.headers).get('content-type') ?? '';
    view = {
      url: prepared.url,
      headers: [...new Headers(prepared.init.headers)],
      body: b == null ? { text: '' } : typeof b === 'string' ? { text: b }
        : isA(b, 'Uint8Array') && textualType(ct) && (b as Uint8Array).byteLength <= LIMITS.bodyBytes ? { text: new TextDecoder().decode(b as Uint8Array) }
        : { reason: `${Object.prototype.toString.call(b).slice(8, -1)} body: not editable as text; it is sent as is` },
    };
    if (method === 'GET' || method === 'HEAD') view.body = { reason: `${method} requests have no body` };
  } else {
    const req = isA(input, 'Request') ? input as Request : null;
    let headers: [string, string][] = [];
    try { headers = [...new Headers(init?.headers !== undefined ? init.headers : req?.headers)]; } catch { /* native reports it */ }
    view = { url: href, headers, locked: 'The request could not be prepared for editing (see Why); Continue sends it unchanged', body: { reason: 'Not available' } };
  }
  const d = await rt.pause(rec, 'request', plan.intercept!.rule, view, signal);
  if (d.kind === 'abort') return 'abort';
  if (d.kind === 'original' || !prepared) return 'keep';
  const e = d.edit;
  const out: RequestInit = { ...prepared.init, headers: new Headers(e.headers) };
  let reusable = prepared.reusable;
  if ('text' in e.body && 'text' in view.body && e.body.text !== view.body.text) { out.body = e.body.text; reusable = true; }
  return { url: e.url ?? prepared.url, init: out, reusable };
}

/** Final hold before delivery: the server has already acted on the request. */
async function responsePause(res: Response, method: string, signal: AbortSignal | null | undefined, plan: Plan, rec: ReqRecord, rt: Runtime): Promise<Response> {
  const opaque = res.type === 'opaque' || res.type === 'opaqueredirect';
  const body = opaque ? { reason: 'Opaque response: hidden from scripts' } : method === 'HEAD' || BODYLESS_STATUS.has(res.status) ? { reason: `No body (${method === 'HEAD' ? 'HEAD' : `HTTP ${res.status}`})` } : await readText(res, rt);
  const view: PauseView = { status: res.status, headers: [...res.headers], body, ...(opaque && { locked: 'Opaque response: status, headers and body are hidden from scripts; it can only be delivered or aborted' }) };
  let d;
  try {
    d = await rt.pause(rec, 'response', plan.intercept!.rule, view, signal);
  } catch (e) {
    res.body?.cancel().catch(() => {});
    throw e;
  }
  if (d.kind === 'abort') {
    res.body?.cancel().catch(() => {});
    throw new DOMException('Workbench breakpoint: response aborted (the server already received the request)', 'AbortError');
  }
  if (d.kind === 'original' || opaque) return res;
  const e = d.edit;
  const text = 'text' in e.body && 'text' in view.body && e.body.text !== view.body.text ? e.body.text : undefined;
  const headersChanged = !sameHeaders(e.headers, view.headers);
  if (e.status === res.status && !headersChanged && text === undefined) return res;
  return rebuild(res, { status: e.status ?? res.status, headers: new Headers(e.headers), ...(text !== undefined && { text }) }, method);
}

// ---------- providers

async function syntheticChaos(plan: Plan, method: string, signal: AbortSignal | null | undefined, rec: ReqRecord, rt: Runtime): Promise<Response> {
  const f = plan.chaos!.fault;
  const done = (reason: string) => rt.op(rec, 'chaos', 'applied', `${reason}; nothing was sent`);
  if (f.kind === 'network-error') { done('Synthetic network error'); throw networkError(); }
  if (f.kind === 'timeout') {
    await rt.wait(f.timeoutMs, signal);
    done(`Synthetic timeout after ${f.timeoutMs} ms`);
    throw timeoutError(f.timeoutMs);
  }
  const [status, body] = f.kind === 'status' ? [f.status, f.body] : [200, f.kind === 'malformed-json' ? f.text : ''];
  let res = synth(status, body ? { 'content-type': f.kind === 'malformed-json' ? 'application/json' : jsonOrText(body) } : {}, body, method);
  done(f.kind === 'status' ? `Synthetic HTTP ${status}` : 'Synthetic 200 with malformed JSON');
  if (plan.intercept?.response) res = await transformResponse(res, plan.intercept.rule.response, method, rec, rt);
  return res;
}

async function mockResponse(plan: Plan, method: string, signal: AbortSignal | null | undefined, rec: ReqRecord, rt: Runtime): Promise<Response> {
  const { slot, index, rule } = plan.mock!;
  if (!slot) {
    rt.op(rec, 'mock', 'applied', `Sequence exhausted after ${rule.slots.length} replies: network error, nothing sent`);
    throw networkError();
  }
  if (slot.delayMs > 0) await rt.wait(slot.delayMs, signal);
  const which = rule.slots.length > 1 ? `Reply ${index + 1} of ${rule.slots.length}` : 'Synthetic reply';
  const after = slot.delayMs ? ` after ${slot.delayMs} ms` : '';
  if (slot.fault === 'network-error') { rt.op(rec, 'mock', 'applied', `${which}: network error${after}; no upstream request`); throw networkError(); }
  if (slot.fault === 'timeout') { rt.op(rec, 'mock', 'applied', `${which}: timeout${after}; no upstream request`); throw timeoutError(slot.delayMs); }
  let res = synth(slot.status, slot.headers, slot.body, method);
  rt.op(rec, 'mock', 'applied', `${which}: HTTP ${slot.status}${after}; no upstream request`);
  if (plan.intercept?.response) res = await transformResponse(res, plan.intercept.rule.response, method, rec, rt);
  return res;
}

// ---------- request work

interface Prepared { url: string; init: RequestInit; /** Body can be sent again (replay). */ reusable: boolean }

/**
 * Build the effective request: route destination/credentials/Authorization, then request edits.
 * Returns null to send the original arguments unchanged; each skipped part says why.
 */
async function prepare(input: RequestInfo | URL, init: RequestInit | undefined, href: string, plan: Plan, rec: ReqRecord, rt: Runtime): Promise<Prepared | null> {
  const req = isA(input, 'Request') ? input as Request : null;
  const fail = (reason: string) => {
    if (plan.route) rt.op(rec, 'route', 'skipped', `${reason}; original request sent once`);
    if (plan.intercept?.request) rt.op(rec, 'intercept', 'skipped', `${reason}; original request sent once`, 'request');
    if (plan.chaos?.fault.kind === 'replay') rt.note(rec, `Replay copies not sent: ${reason}`);
    return null;
  };
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
  let headers = new Headers(init?.headers !== undefined ? init.headers : req?.headers);

  let body: BodyInit | null | undefined;
  let reusable = true;
  if (init?.body !== undefined) {
    body = init.body; // caller's BodyInit forwarded without inspection
    if (isA(body, 'ReadableStream')) reusable = false;
    if ((init as { duplex?: string }).duplex) (out as { duplex?: string }).duplex = (init as { duplex?: string }).duplex!;
  } else if (req?.body) {
    if (req.bodyUsed) return fail('Request body already used');
    // A prebuilt Request body must be re-materialized for a new URL. Bounded; read from a clone so the original stays usable.
    const release = rt.acquireBodySlot();
    if (!release) return fail(`${LIMITS.bodyConcurrency} body preparations already running`);
    try {
      const r = await readBounded(req.clone().body!, LIMITS.bodyBytes, LIMITS.bodyDeadlineMs, rt.own);
      if (!r.ok) return fail(r.reason);
      body = r.bytes;
    } finally {
      release();
    }
  }

  let url = href;
  if (plan.route) {
    const { to, dropAuthorization, credentials } = plan.route;
    url = to.href;
    const did = [`Sent to ${to.origin}${to.pathname} (query preserved)`];
    if (credentials) { out.credentials = credentials; did.push(`credentials ${credentials}`); }
    if (dropAuthorization && headers.has('authorization')) { headers.delete('authorization'); did.push('Authorization removed: destination is a different origin'); }
    rt.op(rec, 'route', 'applied', did.join('; '));
  }

  const ic = plan.intercept?.request ? plan.intercept.rule.request : null;
  if (ic) {
    const did: string[] = [];
    let skipped = '';
    if (hasHeaderOps(ic)) { headers = editHeaders(headers, ic); did.push(`${ic.setHeaders.length} set, ${ic.removeHeaders.length} removed header(s)`); }
    if (hasBodyOps(ic)) {
      const text = typeof body === 'string' ? body : isA(body, 'Uint8Array') && textualType(headers.get('content-type') ?? '') ? new TextDecoder().decode(body as Uint8Array) : null;
      if (text === null) skipped = body == null ? 'no request body' : 'request body is not finite text';
      else if (utf8Bytes(text) > LIMITS.bodyBytes) skipped = `request body over ${LIMITS.bodyBytes} bytes`;
      else {
        const r = transformBody(text, ic);
        if (r.ok) { body = r.text; reusable = true; did.push(`body: ${r.did.join(', ')}`); } else skipped = r.reason;
      }
    }
    if (did.length) rt.op(rec, 'intercept', 'applied', `Request ${did.join('; ')}${skipped ? `; body skipped: ${skipped}` : ''}`, 'request');
    else rt.op(rec, 'intercept', 'skipped', `Request unchanged: ${skipped}`, 'request');
  }
  out.headers = headers;
  if (body != null) out.body = body;
  return { url, init: out, reusable };
}

/** Bounded copies through the captured transport. They never enter rule selection or replay again. */
function replay(nativeFetch: typeof fetch, prepared: Prepared | null, f: { copies: number; gapMs: number }, signal: AbortSignal | null | undefined, parent: ReqRecord, rt: Runtime) {
  if (!prepared) return;
  if (!prepared.reusable) { rt.note(parent, 'Replay copies not sent: the body is a stream that can be sent only once'); return; }
  const url = new URL(prepared.url);
  const method = String(prepared.init.method ?? 'GET').toUpperCase();
  const ids: number[] = [];
  const report = (extra = '') => rt.op(parent, 'chaos', 'applied', `Primary sent; ${ids.length} of ${f.copies} cop${f.copies > 1 ? 'ies' : 'y'} sent${ids.length ? ` (#${ids.join(', #')})` : ''}${extra}. The page sees the primary response only`);
  report();
  void (async () => {
    for (let i = 1; i <= f.copies; i++) {
      await (f.gapMs ? rt.wait(f.gapMs).catch(() => {}) : Promise.resolve());
      if (rt.inert || !rt.config().active.chaos || signal?.aborted) return report(`; stopped before copy ${i}: ${rt.inert ? 'Workbench closed' : signal?.aborted ? 'caller aborted' : 'Chaos deactivated'}`);
      const release = rt.acquireChild();
      if (!release) { rt.note(parent, `Replay copy ${i} skipped: ${LIMITS.replayInFlight} copies already in flight`); continue; }
      const ctl = new AbortController();
      const unown = rt.own(() => ctl.abort(new DOMException('Workbench closed', 'AbortError')));
      const child = rt.start('fetch', method, url, { revision: parent.revision, matched: false, provider: 'network', ops: [], notes: [`Replay copy ${i} of request #${parent.id}; the page does not see this response`] }, parent);
      ids.push(child.id);
      report();
      nativeFetch(url.href, { ...prepared.init, signal: ctl.signal }).then(
        (r) => { rt.finish(child, 'ok', r.status); r.body?.cancel().catch(() => {}); },
        (e: unknown) => rt.finish(child, isAbort(e) ? 'aborted' : 'error'),
      ).finally(() => { release(); unown(); });
    }
  })();
}

// ---------- response work

/** Read a finite text body from a clone, or say why not. The original stays unread. */
async function readText(res: Response, rt: Runtime): Promise<{ text: string } | { reason: string }> {
  if (res.type === 'opaque' || res.type === 'opaqueredirect' || !res.body) return { reason: 'no readable response body' };
  const ct = res.headers.get('content-type') ?? '';
  if (!TEXTUAL.test(ct)) return { reason: `content type "${ct || 'unknown'}" is not text` };
  if (Number(res.headers.get('content-length')) > LIMITS.bodyBytes) return { reason: `body exceeds ${LIMITS.bodyBytes} bytes` };
  const release = rt.acquireBodySlot();
  if (!release) return { reason: `${LIMITS.bodyConcurrency} body operations already running` };
  try {
    const r = await readBounded(res.clone().body!, LIMITS.bodyBytes, LIMITS.bodyDeadlineMs, rt.own);
    return r.ok ? { text: new TextDecoder().decode(r.bytes) } : { reason: r.reason };
  } finally {
    release();
  }
}

/** Rebuild with a new status/headers/body. Bodyless statuses and HEAD drop the body; rewritten text drops stale length/encoding. */
function rebuild(res: Response, o: { status?: number; headers?: Headers; text?: string }, method: string): Response {
  const status = o.status ?? res.status;
  const headers = o.headers ?? new Headers(res.headers);
  const bodyless = method === 'HEAD' || BODYLESS_STATUS.has(status);
  let body: BodyInit | null = res.body;
  if (o.text !== undefined || bodyless) {
    headers.delete('content-length');
    headers.delete('content-encoding');
    res.body?.cancel().catch(() => {});
    body = bodyless ? null : o.text!;
  }
  return new Response(body, { status, statusText: status === res.status ? res.statusText : statusText(status), headers });
}

async function transformResponse(res: Response, t: Transform, method: string, rec: ReqRecord, rt: Runtime): Promise<Response> {
  if (res.type === 'opaque' || res.type === 'opaqueredirect') {
    rt.op(rec, 'intercept', 'skipped', 'Opaque response: status, headers and body are hidden from scripts; original delivered', 'response');
    return res;
  }
  const did: string[] = [];
  let skipped = '';
  let text: string | undefined;
  if (hasBodyOps(t)) {
    const r = await readText(res, rt);
    if ('reason' in r) skipped = r.reason;
    else {
      const x = transformBody(r.text, t);
      if (x.ok) { text = x.text; did.push(`body: ${x.did.join(', ')}`); } else skipped = x.reason;
    }
  }
  const headers = hasHeaderOps(t) ? editHeaders(res.headers, t) : undefined;
  if (headers) did.push(`${t.setHeaders.length} set, ${t.removeHeaders.length} removed header(s)`);
  if (t.status && t.status !== res.status) did.push(`status ${res.status} → ${t.status}`);
  if (!did.length) {
    rt.op(rec, 'intercept', 'skipped', `Response unchanged: ${skipped || 'nothing to change'}; original delivered`, 'response');
    return res;
  }
  rt.op(rec, 'intercept', 'applied', `Response ${did.join('; ')}${skipped ? `; body skipped: ${skipped}` : ''}. Rebuilt Response does not keep url/redirected`, 'response');
  return rebuild(res, { ...(t.status && { status: t.status }), ...(headers && { headers }), ...(text !== undefined && { text }) }, method);
}

/** Real chaos after response work: the upstream request has already happened. */
async function realChaos(res: Response, plan: Plan, method: string, signal: AbortSignal | null | undefined, rec: ReqRecord, rt: Runtime): Promise<Response> {
  const { fault: f, delayMs } = plan.chaos!;
  const sent = `upstream returned ${res.status}`;
  switch (f.kind) {
    case 'latency': case 'random-latency':
      await rt.wait(delayMs, signal);
      rt.op(rec, 'chaos', 'applied', `Delivery delayed ${delayMs} ms after the real response (${sent})`);
      return res;
    case 'status':
      rt.op(rec, 'chaos', 'applied', `Real response replaced by HTTP ${f.status} (${sent}; upstream effects stand)`);
      return rebuild(res, { status: f.status, headers: new Headers(f.body ? { 'content-type': jsonOrText(f.body) } : {}), text: f.body }, method);
    case 'network-error':
      res.body?.cancel().catch(() => {});
      rt.op(rec, 'chaos', 'applied', `Response dropped: network error (${sent}; upstream effects stand)`);
      throw networkError();
    case 'timeout':
      rt.op(rec, 'chaos', 'skipped', `Response arrived within ${f.timeoutMs} ms; delivered`);
      return res;
    case 'malformed-json':
      rt.op(rec, 'chaos', 'applied', `Body replaced with malformed JSON (${sent})`);
      return rebuild(res, { text: f.text }, method);
    case 'corrupt-json': {
      const r = await readText(res, rt);
      let parsed: unknown;
      if ('text' in r) { try { parsed = JSON.parse(r.text); } catch { /* reported below */ } }
      const p = parsed === undefined ? null : applyPatch(parsed, f.patch);
      if (!p?.ok) {
        rt.op(rec, 'chaos', 'skipped', `${'reason' in r ? r.reason : parsed === undefined ? 'body is not valid JSON' : `field change ${p!.index + 1} failed (${p!.reason})`}; original response delivered`);
        return res;
      }
      rt.op(rec, 'chaos', 'applied', `${f.patch.length} JSON field change${f.patch.length > 1 ? 's' : ''} applied (${sent})`);
      return rebuild(res, { text: JSON.stringify(p.value) }, method);
    }
    case 'replay':
      return res; // copies report themselves
  }
}

// ---------- recorder (unchanged from R3)

function observe(p: Promise<Response>, rec: ReqRecord, rt: Runtime, reqBody?: Promise<void>): void {
  p.then(
    (r) => {
      rt.finish(rec, 'ok', r.status);
      if (rec.capture) captureResponse(r, rec, rt, reqBody);
    },
    (e: unknown) => {
      rt.finish(rec, isAbort(e) ? 'aborted' : (e as { name?: unknown } | null)?.name === 'TimeoutError' ? 'timeout' : 'error');
      if (rec.capture) void Promise.resolve(reqBody).then(() => rt.captured(rec));
    },
  );
}

/** Request side of a capture. Returns a promise only when a prebuilt Request body has to be read from a clone. */
function captureRequest(input: RequestInfo | URL, init: RequestInit | undefined, url: URL, method: string, rec: ReqRecord, rt: Runtime): Promise<void> {
  const c = newCapture(rec, method, url);
  rec.capture = c;
  const req = isA(input, 'Request') ? input as Request : null;
  let headers: Headers;
  try { headers = new Headers(init?.headers !== undefined ? init.headers : req?.headers); } catch { headers = new Headers(); c.notes.push('Request headers were invalid; the browser rejected them'); }
  c.headers = cleanHeaders(headers, c);
  c.credentials = (init?.credentials ?? req?.credentials ?? 'same-origin') as Credentials;
  const ct = headers.get('content-type') ?? '';
  if (init?.body !== undefined) c.body = requestBody(init.body, ct, c);
  else if (req?.body && !req.bodyUsed) {
    if (!textualType(ct)) c.body = { kind: 'omitted', reason: `Request body of type "${ct || 'unknown'}" is not captured` };
    else {
      return readPrefix(req.clone().body!, CAP.requestBytes, CAP.responseDeadlineMs, rt.own).then((b) => {
        c.body = 'omitted' in b ? { kind: 'omitted', reason: b.omitted } : b.truncated ? { kind: 'omitted', reason: `Request body over ${CAP.requestBytes / 1024} KiB was not captured` } : requestBody(b.text, ct, c);
      });
    }
  }
  return Promise.resolve();
}

const OFF = 'Response bodies are off in Settings; the body was not read';
async function captureResponse(res: Response, rec: ReqRecord, rt: Runtime, reqBody?: Promise<void>): Promise<void> {
  const c = rec.capture!;
  c.status = res.status;
  c.synthetic = rec.provider !== 'network' && rec.ops.some((o) => (o.module === 'mock' || o.module === 'chaos') && o.state === 'applied');
  c.resHeaders = [...res.headers].filter(([k]) => !sensitiveName(k)) as Pair[];
  const ct = res.headers.get('content-type') ?? '';
  if (res.type === 'opaque' || res.type === 'opaqueredirect') c.resBody = { omitted: 'Opaque response: the browser hides its body' };
  else if (!res.body) c.resBody = { text: '', truncated: false };
  else if (!rt.prefs.responseBodies) c.resBody = { omitted: OFF };
  else if (!textualType(ct)) c.resBody = { omitted: `Content type "${ct || 'unknown'}" is not text; body not captured` };
  else {
    const release = rt.acquireBodySlot();
    if (!release) c.resBody = { omitted: `${LIMITS.bodyConcurrency} body reads already running; preview skipped` };
    else {
      try {
        let disabled = false;
        const b = await readPrefix(res.clone().body!, CAP.responseBytes, CAP.responseDeadlineMs, (stop) => {
          const release = rt.own(stop);
          const unsubscribe = rt.subscribe(() => { if (!rt.prefs.responseBodies) { disabled = true; stop(); } });
          return () => { release(); unsubscribe(); };
        });
        c.resBody = disabled ? { omitted: OFF } : 'text' in b ? { text: redactText(b.text, ct, c, 'Response body'), truncated: b.truncated } : b;
      } catch {
        c.resBody = { omitted: 'Response body was already used' };
      } finally {
        release();
      }
    }
  }
  await reqBody;
  c.ms = rec.elapsedMs;
  rt.captured(rec);
}
