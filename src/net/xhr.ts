// XHR adapter. Instruments XMLHttpRequest.prototype so native objects, constructor identity and
// typed responses are kept. Planning happens at send(), when headers and body are known.
// - Route / request-header edits re-open the page's native object at the destination and replay its
//   headers, so responseType/upload/progress/timeout stay native (listeners see OPENED once more).
// - Response edits and real chaos run the request on an internal native XHR that Workbench owns; the
//   page's object never sends and gets one event sequence with the final values, reusing the native
//   typed response. (Chrome runs target listeners in registration order, so native events on the
//   page's own object cannot be held back.)
// - Mock and synthetic chaos use an explicit state/event machine and send nothing.
import { utf8Bytes, type InterceptRule, type Pair, type Transform } from '../data/schema';
import { CAP, cleanHeaders, headerLines, isA, isAbort, newCapture, redactText, requestBody, sensitiveName, type ResBody } from './capture';
import { jsonOrText, matchBody, statusText } from './fetch';
import { applyPatch, hasBodyOps, hasHeaderOps, transformBody } from './patch';
import { BODYLESS_STATUS, LIMITS, planRequest, type Plan } from './plan';
import type { PauseView, ReqRecord, Runtime } from './runtime';

type Proto = typeof XMLHttpRequest.prototype;
export interface XhrNatives {
  open: Proto['open'];
  send: Proto['send'];
  setRequestHeader: Proto['setRequestHeader'];
  abort: Proto['abort'];
}

interface XState {
  method: string;
  url: URL;
  openArgs: unknown[];
  sync: boolean;
  rec?: ReqRecord;
  /** Headers the page set, in order. */
  headers: [string, string][];
  synthetic?: Synthetic;
}

interface Synthetic {
  readyState: number;
  status: number;
  statusText: string;
  headers: string;
  body: string;
  response: unknown;
  url: string;
  done: boolean;
  /** Internal native request in flight (held), aborted with the page's abort(). */
  inner: XMLHttpRequest | null;
  /** Aborted by the page's abort()/timeout so a waiting breakpoint settles as cancelled. */
  pauseCtl: AbortController;
  timers: ReturnType<typeof setTimeout>[];
  release(): void;
}

/** A final reply to deliver: text for responseText; `response` for the typed value. */
interface Reply { status: number; statusText: string; headers: Pair[]; text: string; response: unknown; url: string }

const SHADOWED = ['readyState', 'status', 'statusText', 'response', 'responseText', 'responseURL', 'responseXML', 'getResponseHeader', 'getAllResponseHeaders'] as const;
/** The natives of `win`'s XMLHttpRequest.prototype (a same-origin frame has its own). */
export function captureXhr(win: Window = window): XhrNatives {
  const proto = (win as unknown as typeof globalThis).XMLHttpRequest.prototype;
  return { open: proto.open, send: proto.send, setRequestHeader: proto.setRequestHeader, abort: proto.abort };
}

/** `win` is the window whose XHR prototype this instruments: relative URLs resolve against its current address. */
export function createXhr(n: XhrNatives, rt: Runtime, nativeFetch: typeof fetch, win: Window = window): XhrNatives {
  const state = new WeakMap<XMLHttpRequest, XState>();

  function unshadow(xhr: XMLHttpRequest) {
    const syn = state.get(xhr)?.synthetic;
    if (syn) { syn.done = true; cancel(syn); }
    for (const k of SHADOWED) if (Object.prototype.hasOwnProperty.call(xhr, k)) delete (xhr as unknown as Record<string, unknown>)[k];
  }

  const open = function (this: XMLHttpRequest, method: string, url: string | URL, async?: boolean) {
    // eslint-disable-next-line prefer-rest-params
    const args = [...arguments] as Parameters<Proto['open']>;
    unshadow(this);
    state.delete(this);
    if (rt.inert) return n.open.apply(this, args);
    let u: URL;
    try {
      u = new URL(String(url), win.location.href);
    } catch {
      return n.open.apply(this, args); // native throws the correct SyntaxError
    }
    n.open.apply(this, args);
    state.set(this, { method: String(method).toUpperCase(), url: u, openArgs: args, sync: args.length >= 3 && !async, headers: [] });
  } as Proto['open'];

  const setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    n.setRequestHeader.call(this, name, value);
    const st = state.get(this);
    if (st && st.headers.length < 200) st.headers.push([String(name), String(value)]);
  } as Proto['setRequestHeader'];

  const send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    // eslint-disable-next-line prefer-rest-params
    const args = arguments as unknown as Parameters<Proto['send']>;
    const st = state.get(this);
    if (rt.inert || !st || this.readyState !== 1) return n.send.apply(this, args);
    const plan = planRequest(rt.config(), rt.states, rt.origin, { transport: 'xhr', method: st.method, url: st.url, headers: st.headers, body: matchBody(body), sync: st.sync });
    const rec = rt.start('xhr', st.method, st.url, plan);
    st.rec = rec;
    rec.responseType = this.responseType || 'text';
    if (rt.capturing) captureSend(this, st, rec, body);

    const synthetic = plan.provider !== 'network';
    if (synthetic && this.responseType === 'document') {
      const m = plan.provider === 'mock' ? 'mock' : 'chaos';
      rt.op(rec, m, 'skipped', 'Synthetic document responses are not supported; original request sent');
      return nativeSend(this, rec, args);
    }
    if (plan.provider === 'mock') return deliverMock(this, st, plan, rec);
    if (plan.provider === 'chaos') return deliverChaos(this, st, plan, rec);
    if (!plan.matched) return nativeSend(this, rec, args);
    return network(this, st, plan, rec, body);
  } as Proto['send'];

  const abort = function (this: XMLHttpRequest) {
    const st = state.get(this);
    const syn = st?.synthetic;
    if (!rt.inert && syn && !syn.done) {
      cancel(syn);
      syn.pauseCtl.abort(new DOMException('XHR aborted', 'AbortError')); // caller abort wins over a pause
      syn.done = true; // before the native abort, whose (suppressed) loadend reports back synchronously
      if (syn.inner) n.abort.call(syn.inner); // stop the internal request; the page sees only our abort
      terminal(this, syn, 'abort');
      syn.readyState = 0;
      if (st!.rec) rt.finish(st!.rec, 'aborted');
      return;
    }
    return n.abort.call(this);
  } as Proto['abort'];

  function nativeSend(xhr: XMLHttpRequest, rec: ReqRecord, args: unknown[] | IArguments) {
    const onEnd = (e: Event) => rt.finish(rec, e.type === 'load' ? 'ok' : e.type === 'abort' ? 'aborted' : e.type === 'timeout' ? 'timeout' : 'error', xhr.status);
    for (const t of ['load', 'error', 'abort', 'timeout']) xhr.addEventListener(t, onEnd, { once: true });
    try {
      return (n.send as (...a: unknown[]) => void).apply(xhr, [...args]);
    } catch (e) {
      rt.finish(rec, 'error');
      throw e;
    }
  }

  // ---------- real traffic

  function network(xhr: XMLHttpRequest, st: XState, plan: Plan, rec: ReqRecord, body: unknown) {
    let sendBody = body;
    const ic = plan.intercept?.request ? plan.intercept.rule.request : null;
    const chaos = plan.chaos;
    const hold = !!plan.intercept?.response || !!plan.intercept?.breakRequest || !!plan.intercept?.breakResponse || (!!chaos && chaos.fault.kind !== 'replay');
    const target = plan.route?.to.href ?? st.url.href;

    // Effective headers: route Authorization policy, then request edits (removal before set).
    const removed = new Set(ic?.removeHeaders.map((x) => x.toLowerCase()));
    const set = new Map(ic?.setHeaders.map(([k, v]) => [k.toLowerCase(), [k, v] as const]));
    let droppedAuth = false;
    const headers: [string, string][] = [];
    for (const [k, v] of st.headers) {
      const lk = k.toLowerCase();
      if (plan.route?.dropAuthorization && lk === 'authorization') { droppedAuth = true; continue; }
      if (removed.has(lk) || set.has(lk)) continue;
      headers.push([k, v]);
    }
    for (const [k, v] of set.values()) headers.push([k, v]);
    const cred = plan.route?.credentials;
    const withCredentials = cred ? cred === 'include' : xhr.withCredentials;

    if (plan.route) {
      const did = [`Sent to ${plan.route.to.origin}${plan.route.to.pathname} (query preserved; native ${rec.responseType} response)`];
      if (cred) did.push(cred === 'omit' ? 'credentials omit: XHR still sends same-origin cookies' : `credentials ${cred}`);
      if (droppedAuth) did.push('Authorization removed: destination is a different origin');
      rt.op(rec, 'route', 'applied', did.join('; '));
    }
    if (ic) {
      const did: string[] = [];
      let skipped = '';
      if (hasHeaderOps(ic)) did.push(`${ic.setHeaders.length} set, ${ic.removeHeaders.length} removed header(s)`);
      if (hasBodyOps(ic)) {
        if (typeof body !== 'string') skipped = body == null ? 'no request body' : 'request body is not text';
        else if (utf8Bytes(body) > LIMITS.bodyBytes) skipped = `request body over ${LIMITS.bodyBytes} bytes`;
        else {
          const r = transformBody(body, ic);
          if (r.ok) { sendBody = r.text; did.push(`body: ${r.did.join(', ')}`); } else skipped = r.reason;
        }
      }
      if (did.length) rt.op(rec, 'intercept', 'applied', `Request ${did.join('; ')}${skipped ? `; body skipped: ${skipped}` : ''}`, 'request');
      else rt.op(rec, 'intercept', 'skipped', `Request unchanged: ${skipped}`, 'request');
    }
    const copies = () => { if (chaos?.fault.kind === 'replay') replay(xhr, st, plan, rec, sendBody, headers, withCredentials); };

    if (!hold) {
      if (plan.route || (ic && hasHeaderOps(ic))) {
        // Re-open the page's own object at the destination so responseType/upload/progress stay native.
        // Listeners see readystatechange (OPENED) once more here; it carries readyState 1 again.
        const a = [...st.openArgs];
        a[1] = target;
        if (a.length < 3) a[2] = true;
        (n.open as (...x: unknown[]) => void).apply(xhr, a);
        for (const [k, v] of headers) n.setRequestHeader.call(xhr, k, v);
        if (cred) xhr.withCredentials = withCredentials;
      }
      nativeSend(xhr, rec, [sendBody]);
      return copies(); // after the primary dispatch
    }

    // Held: the real request runs on an internal native XHR; the page's object never sends, so the
    // page sees one event sequence with the final values. Upload progress is not forwarded.
    // A request breakpoint holds here before the internal request is even opened: zero upstream hits.
    const inner = new XMLHttpRequest();
    const syn = newSynthetic(inner);
    st.synthetic = syn;
    shadow(xhr, syn);
    let last = 'error';
    for (const t of ['load', 'error', 'abort', 'timeout']) inner.addEventListener(t, () => { last = t; });
    inner.addEventListener('loadend', () => finishHeld(xhr, inner, st, plan, rec, syn, last));
    fireProgress(xhr, 'loadstart', 0);
    const ic2 = plan.intercept;
    const breaks = !!(ic2?.breakRequest || ic2?.breakResponse);
    const sentAt = performance.now();
    if (breaks && xhr.timeout > 0) {
      // The page's own timeout keeps running while Workbench holds the request or response; it wins.
      syn.timers.push(setTimeout(() => {
        if (syn.done) return;
        syn.pauseCtl.abort(new DOMException('XHR timeout', 'TimeoutError'));
        const i = syn.inner;
        terminal(xhr, syn, 'timeout');
        if (i) n.abort.call(i);
        rt.finish(rec, 'timeout');
      }, xhr.timeout));
    }
    let url = target, hdrs = headers, out: unknown = sendBody;
    const go = (deferred: boolean) => {
      if (syn.done) return;
      (n.open as (...x: unknown[]) => void).apply(inner, [st.method, url, true, ...st.openArgs.slice(3)]);
      for (const [k, v] of hdrs) n.setRequestHeader.call(inner, k, v);
      inner.responseType = xhr.responseType;
      inner.withCredentials = withCredentials;
      if (xhr.timeout > 0) inner.timeout = Math.max(1, Math.round(xhr.timeout - (performance.now() - sentAt)));
      try {
        (n.send as (b: unknown) => void).call(inner, out ?? null);
      } catch (e) {
        if (!deferred) { syn.done = true; rt.finish(rec, 'error'); throw e; }
        terminal(xhr, syn, 'error');
        rt.finish(rec, 'error');
        return;
      }
      if (chaos?.fault.kind === 'timeout') {
        const ms = chaos.fault.timeoutMs;
        syn.timers.push(setTimeout(() => {
          if (syn.done) return;
          rt.op(rec, 'chaos', 'applied', `No response delivered within ${ms} ms: timed out (the request was sent; upstream effects may occur)`);
          terminal(xhr, syn, 'timeout');
          rt.finish(rec, 'timeout');
        }, ms));
      }
    };
    const dispatch = (deferred: boolean) => {
      const pre = chaos?.rule.preDelayMs ?? 0;
      if (!pre || rt.inert) return go(deferred);
      syn.timers.push(setTimeout(() => go(true), pre));
      syn.release = rt.own(() => { cancel(syn); go(true); }); // Close: send now, still exactly once
    };
    if (!ic2?.breakRequest) return dispatch(false);
    const view: PauseView = {
      url, headers: hdrs,
      body: out == null ? { text: '' } : typeof out === 'string' ? { text: out } : { reason: `${Object.prototype.toString.call(out).slice(8, -1)} body: not editable as text; it is sent as is` },
    };
    if (st.method === 'GET' || st.method === 'HEAD') view.body = { reason: `${st.method} requests have no body` };
    rt.pause(rec, 'request', ic2.rule, view, syn.pauseCtl.signal).then((d) => {
      if (syn.done) return;
      if (d.kind === 'abort') {
        terminal(xhr, syn, 'abort');
        syn.readyState = 0;
        return rt.finish(rec, 'aborted');
      }
      if (d.kind === 'continue') {
        url = d.edit.url ?? url;
        hdrs = d.edit.headers;
        if ('text' in d.edit.body && 'text' in view.body && d.edit.body.text !== view.body.text) out = d.edit.body.text;
      }
      dispatch(true);
    }, () => { /* the page aborted or timed out: already settled */ });
  }

  /** The internal request completed (or failed): apply response work and real chaos, then deliver once. */
  function finishHeld(xhr: XMLHttpRequest, inner: XMLHttpRequest, st: XState, plan: Plan, rec: ReqRecord, syn: Synthetic, ended: string) {
    syn.inner = null;
    if (syn.done) return; // aborted or timed out already
    if (ended !== 'load') {
      for (const o of rec.ops) if (o.state === 'selected') rt.op(rec, o.module, 'skipped', `Request ended (${ended}); nothing to edit`, o.part);
      terminal(xhr, syn, ended as 'error' | 'timeout' | 'abort');
      rt.finish(rec, ended === 'timeout' ? 'timeout' : ended === 'abort' ? 'aborted' : 'error');
      return;
    }
    const type = xhr.responseType;
    const textual = type === '' || type === 'text';
    const raw = inner.response;
    let reply: Reply = {
      status: inner.status, statusText: inner.statusText,
      headers: headerLines(inner.getAllResponseHeaders()), url: inner.responseURL,
      text: textual ? (raw as string) : type === 'json' && raw != null ? JSON.stringify(raw) : '',
      response: raw,
    };
    const bodyText = textual || (type === 'json' && raw != null) ? reply.text : null;
    if (plan.intercept?.response) reply = editReply(reply, plan.intercept.rule.response, bodyText === null ? `XHR ${type || 'text'} response cannot be edited as text; native typed response kept` : '', type, rec);

    const brk = plan.intercept?.breakResponse ? plan.intercept.rule : null;
    const out = (r: Reply) => (brk ? pauseReply(xhr, syn, r, rec, brk, st.method) : deliver(xhr, syn, r, rec));
    const chaos = plan.chaos;
    if (!chaos) return out(reply);
    const f = chaos.fault;
    const sent = `upstream returned ${reply.status}`;
    switch (f.kind) {
      case 'latency': case 'random-latency':
        rt.op(rec, 'chaos', 'applied', `Delivery delayed ${chaos.delayMs} ms after the real response (${sent})`);
        syn.timers.push(setTimeout(() => out(reply), chaos.delayMs));
        syn.release = rt.own(() => deliver(xhr, syn, reply, rec)); // Close delivers the real reply now
        return;
      case 'status':
        rt.op(rec, 'chaos', 'applied', `Real response replaced by HTTP ${f.status} (${sent}; upstream effects stand)`);
        return out(textReply(f.status, f.body ? [['content-type', jsonOrText(f.body)]] : [], f.body, st.method, type, reply.url));
      case 'network-error':
        rt.op(rec, 'chaos', 'applied', `Response dropped: network error (${sent}; upstream effects stand)`);
        terminal(xhr, syn, 'error');
        return rt.finish(rec, 'error');
      case 'timeout':
        rt.op(rec, 'chaos', 'skipped', `Response arrived within ${f.timeoutMs} ms; delivered`);
        return out(reply);
      case 'malformed-json':
        if (!textual && type !== 'json') { rt.op(rec, 'chaos', 'skipped', `XHR ${type} response is not text; native typed response delivered`); return out(reply); }
        rt.op(rec, 'chaos', 'applied', `Body replaced with malformed JSON (${sent})`);
        return out({ ...reply, text: f.text, response: type === 'json' ? null : f.text });
      case 'corrupt-json': {
        let parsed: unknown;
        if (bodyText !== null) { try { parsed = JSON.parse(reply.text); } catch { /* reported below */ } }
        const p = parsed === undefined ? null : applyPatch(parsed, f.patch);
        if (!p?.ok) {
          rt.op(rec, 'chaos', 'skipped', `${bodyText === null ? `XHR ${type} response is not text` : parsed === undefined ? 'body is not valid JSON' : `field change ${p!.index + 1} failed (${p!.reason})`}; original response delivered`);
          return out(reply);
        }
        const text = JSON.stringify(p.value);
        rt.op(rec, 'chaos', 'applied', `${f.patch.length} JSON field change${f.patch.length > 1 ? 's' : ''} applied (${sent})`);
        return out({ ...reply, text, response: type === 'json' ? p.value : text });
      }
      case 'replay':
        return out(reply);
    }
  }

  /** Final hold before delivery: the server has already acted on the request. */
  function pauseReply(xhr: XMLHttpRequest, syn: Synthetic, r: Reply, rec: ReqRecord, rule: InterceptRule, method: string) {
    const type = xhr.responseType;
    const textual = type === '' || type === 'text' || type === 'json';
    const view: PauseView = {
      status: r.status, headers: r.headers,
      body: method === 'HEAD' || BODYLESS_STATUS.has(r.status) ? { reason: `No body (${method === 'HEAD' ? 'HEAD' : `HTTP ${r.status}`})` }
        : textual ? { text: r.text } : { reason: `XHR ${type} response: shown as metadata only; the native typed body is delivered unchanged` },
    };
    rt.pause(rec, 'response', rule, view, syn.pauseCtl.signal).then((d) => {
      if (syn.done) return;
      if (d.kind === 'abort') {
        terminal(xhr, syn, 'abort');
        syn.readyState = 0;
        return rt.finish(rec, 'aborted');
      }
      if (d.kind === 'original') return deliver(xhr, syn, r, rec);
      const e = d.edit;
      const next: Reply = { ...r, headers: e.headers, status: e.status ?? r.status };
      if (next.status !== r.status) next.statusText = statusText(next.status);
      if ('text' in e.body && 'text' in view.body && e.body.text !== view.body.text) {
        next.text = e.body.text;
        next.response = type === 'json' ? safeParse(e.body.text) : e.body.text;
      }
      deliver(xhr, syn, next, rec);
    }, () => { /* the page aborted or timed out: already settled */ });
  }

  /** Response transform over a reply. `cannotEditBody` names why body ops are skipped ('' = eligible). */
  function editReply(r: Reply, t: Transform, cannotEditBody: string, type: XMLHttpRequestResponseType, rec: ReqRecord): Reply {
    const did: string[] = [];
    let skipped = '';
    const out = { ...r, headers: [...r.headers] };
    if (hasBodyOps(t)) {
      if (cannotEditBody) skipped = cannotEditBody;
      else if (utf8Bytes(r.text) > LIMITS.bodyBytes) skipped = `body exceeds ${LIMITS.bodyBytes} bytes`;
      else {
        const x = transformBody(r.text, t);
        if (x.ok) {
          out.text = x.text;
          out.response = type === 'json' ? safeParse(x.text) : type === '' || type === 'text' ? x.text : convert(x.text, type, '');
          did.push(`body: ${x.did.join(', ')}`);
        } else skipped = x.reason;
      }
    }
    if (hasHeaderOps(t)) {
      const removed = new Set([...t.removeHeaders, ...t.setHeaders.map(([k]) => k)].map((k) => k.toLowerCase()));
      out.headers = [...out.headers.filter(([k]) => !removed.has(k.toLowerCase())), ...t.setHeaders];
      did.push(`${t.setHeaders.length} set, ${t.removeHeaders.length} removed header(s)`);
    }
    if (t.status && t.status !== r.status) {
      did.push(`status ${r.status} → ${t.status}`);
      out.status = t.status;
      out.statusText = statusText(t.status);
    }
    if (did.length) rt.op(rec, 'intercept', 'applied', `Response ${did.join('; ')}${skipped ? `; body skipped: ${skipped}` : ''}`, 'response');
    else rt.op(rec, 'intercept', 'skipped', `Response unchanged: ${skipped || 'nothing to change'}; original delivered`, 'response');
    return out;
  }

  /** Bounded copies through the captured fetch; the page's XHR sees only the primary. */
  function replay(xhr: XMLHttpRequest, st: XState, plan: Plan, parent: ReqRecord, body: unknown, headers: [string, string][], withCredentials: boolean) {
    const f = plan.chaos!.fault as { copies: number; gapMs: number };
    if (body != null && !(typeof body === 'string' || isA(body, 'Blob') || isA(body, 'File') || isA(body, 'ArrayBuffer') || ArrayBuffer.isView(body) || isA(body, 'URLSearchParams') || isA(body, 'FormData'))) {
      rt.note(parent, 'Replay copies not sent: this body type cannot be sent again');
      return;
    }
    const url = plan.route?.to ?? st.url;
    const init: RequestInit = { method: st.method, headers, credentials: withCredentials ? 'include' : 'same-origin', ...(body != null && { body: body as BodyInit }) };
    const ids: number[] = [];
    const report = (extra = '') => rt.op(parent, 'chaos', 'applied', `Primary sent; ${ids.length} of ${f.copies} cop${f.copies > 1 ? 'ies' : 'y'} sent with fetch${ids.length ? ` (#${ids.join(', #')})` : ''}${extra}. The page sees the primary response only`);
    report();
    void (async () => {
      for (let i = 1; i <= f.copies; i++) {
        await (f.gapMs ? rt.wait(f.gapMs).catch(() => {}) : Promise.resolve());
        const aborted = parent.outcome === 'aborted';
        if (rt.inert || !rt.config().active.chaos || aborted) return report(`; stopped before copy ${i}: ${rt.inert ? 'Workbench closed' : aborted ? 'caller aborted' : 'Chaos deactivated'}`);
        const release = rt.acquireChild();
        if (!release) { rt.note(parent, `Replay copy ${i} skipped: ${LIMITS.replayInFlight} copies already in flight`); continue; }
        const ctl = new AbortController();
        const unown = rt.own(() => ctl.abort(new DOMException('Workbench closed', 'AbortError')));
        const child = rt.start('fetch', st.method, url, { revision: parent.revision, matched: false, provider: 'network', ops: [], notes: [`Replay copy ${i} of XHR request #${parent.id}, sent with fetch; the page does not see this response`] }, parent);
        ids.push(child.id);
        report();
        nativeFetch(url.href, { ...init, signal: ctl.signal }).then(
          (r) => { rt.finish(child, 'ok', r.status); r.body?.cancel().catch(() => {}); },
          (e: unknown) => rt.finish(child, isAbort(e) ? 'aborted' : 'error'),
        ).finally(() => { release(); unown(); });
      }
    })();
  }

  // ---------- synthetic providers

  function deliverMock(xhr: XMLHttpRequest, st: XState, plan: Plan, rec: ReqRecord) {
    const { rule, slot, index } = plan.mock!;
    const which = rule.slots.length > 1 ? `Reply ${index + 1} of ${rule.slots.length}` : 'Synthetic';
    if (!slot) return synthetic(xhr, st, rec, 0, 'error', () => rt.op(rec, 'mock', 'applied', `Sequence exhausted after ${rule.slots.length} replies: network error, nothing sent`));
    const after = slot.delayMs ? ` after ${slot.delayMs} ms` : '';
    if (slot.fault !== 'none') return synthetic(xhr, st, rec, slot.delayMs, slot.fault === 'timeout' ? 'timeout' : 'error', () => rt.op(rec, 'mock', 'applied', `${which}: ${slot.fault}${after}; no upstream request`));
    synthetic(xhr, st, rec, slot.delayMs, () => {
      let r = textReply(slot.status, slot.headers, slot.body, st.method, xhr.responseType, '');
      if (plan.intercept?.response) r = editReply(r, plan.intercept.rule.response, '', xhr.responseType, rec);
      rt.op(rec, 'mock', 'applied', `${which} ${xhr.responseType || 'text'} reply: HTTP ${slot.status}${after}; no upstream request`);
      return r;
    });
  }

  function deliverChaos(xhr: XMLHttpRequest, st: XState, plan: Plan, rec: ReqRecord) {
    const f = plan.chaos!.fault;
    const done = (r: string) => () => rt.op(rec, 'chaos', 'applied', `${r}; nothing was sent`);
    if (f.kind === 'network-error') return synthetic(xhr, st, rec, 0, 'error', done('Synthetic network error'));
    if (f.kind === 'timeout') return synthetic(xhr, st, rec, f.timeoutMs, 'timeout', done(`Synthetic timeout after ${f.timeoutMs} ms`));
    const [status, body] = f.kind === 'status' ? [f.status, f.body] : [200, f.kind === 'malformed-json' ? f.text : ''];
    synthetic(xhr, st, rec, 0, () => {
      let r = textReply(status, body ? [['content-type', f.kind === 'malformed-json' ? 'application/json' : jsonOrText(body)]] : [], body, st.method, xhr.responseType, '');
      if (plan.intercept?.response) r = editReply(r, plan.intercept.rule.response, '', xhr.responseType, rec);
      done(f.kind === 'status' ? `Synthetic HTTP ${status}` : 'Synthetic 200 with malformed JSON')();
      return r;
    });
  }

  /** Synthetic delivery after `delayMs`: a reply (built when due) or a transport failure. xhr.timeout still applies. */
  function synthetic(xhr: XMLHttpRequest, st: XState, rec: ReqRecord, delayMs: number, what: (() => Reply) | 'error' | 'timeout', applied?: () => void) {
    const syn = newSynthetic(null);
    st.synthetic = syn;
    shadow(xhr, syn);
    const due = () => {
      if (syn.done) return;
      cancel(syn);
      if (typeof what === 'function') return deliver(xhr, syn, what(), rec);
      applied?.();
      terminal(xhr, syn, what);
      rt.finish(rec, what);
    };
    fireProgress(xhr, 'loadstart', 0);
    syn.release = rt.own(due); // Close settles the selected synthetic outcome now
    syn.timers.push(setTimeout(due, delayMs));
    if (xhr.timeout > 0 && xhr.timeout <= delayMs) {
      syn.timers.push(setTimeout(() => {
        if (syn.done) return;
        cancel(syn);
        terminal(xhr, syn, 'timeout');
        rt.finish(rec, 'timeout');
      }, xhr.timeout));
    }
  }

  function deliver(xhr: XMLHttpRequest, syn: Synthetic, r: Reply, rec: ReqRecord) {
    if (syn.done) return;
    cancel(syn);
    syn.status = r.status;
    syn.statusText = r.statusText;
    syn.headers = r.headers.map(([k, v]) => `${k.toLowerCase()}: ${v}\r\n`).join('');
    syn.url = r.url;
    syn.readyState = 2;
    fire(xhr, 'readystatechange');
    if (syn.done) return; // a handler may have aborted
    syn.body = r.text;
    syn.readyState = 3;
    fire(xhr, 'readystatechange');
    const bytes = utf8Bytes(r.text);
    fireProgress(xhr, 'progress', bytes);
    if (syn.done) return;
    syn.response = r.response;
    syn.readyState = 4;
    syn.done = true;
    rt.finish(rec, 'ok', r.status);
    fire(xhr, 'readystatechange');
    fireProgress(xhr, 'load', bytes);
    fireProgress(xhr, 'loadend', bytes);
  }

  function terminal(xhr: XMLHttpRequest, syn: Synthetic, type: 'abort' | 'timeout' | 'error') {
    cancel(syn);
    syn.done = true;
    Object.assign(syn, { status: 0, statusText: '', headers: '', response: null, body: '', readyState: 4 });
    fire(xhr, 'readystatechange');
    fireProgress(xhr, type, 0);
    fireProgress(xhr, 'loadend', 0);
  }

  function captureSend(xhr: XMLHttpRequest, st: XState, rec: ReqRecord, body: unknown) {
    const c = newCapture(rec, st.method, st.url);
    rec.capture = c;
    c.headers = cleanHeaders(st.headers, c, 'Header', rt.prefs.keepSecrets);
    c.credentials = xhr.withCredentials ? 'include' : 'same-origin';
    const ct = st.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
    c.body = requestBody(body, ct, c);
    xhr.addEventListener('loadend', () => {
      c.status = xhr.status || undefined;
      c.synthetic = rec.provider !== 'network';
      c.resHeaders = headerLines(xhr.getAllResponseHeaders()).filter(([k]) => !sensitiveName(k));
      const t = xhr.responseType;
      const rct = xhr.getResponseHeader('content-type') ?? '';
      const cut = (text: string): ResBody => {
        if (utf8Bytes(text) <= CAP.responseBytes) return { text: redactText(text, rct, c, 'Response body'), truncated: false };
        return { text: redactText(new TextDecoder().decode(new TextEncoder().encode(text).subarray(0, CAP.responseBytes)), rct, c, 'Response body'), truncated: true };
      };
      if (!xhr.status) { /* no response */ }
      else if (!rt.prefs.responseBodies) c.resBody = { omitted: 'Response bodies are off in Settings; the body was not kept' };
      else if (t === '' || t === 'text') c.resBody = cut(xhr.responseText);
      else if (t === 'json') {
        c.resBody = xhr.response == null ? { omitted: 'responseType json: the body did not parse' } : cut(JSON.stringify(xhr.response));
        c.notes.push('Response JSON was re-serialized from responseType json; spacing may differ');
      } else c.resBody = { omitted: `XHR ${t} response is not captured` };
      c.ms = rec.elapsedMs;
      queueMicrotask(() => rt.captured(rec)); // after finish() has set the outcome
    }, { once: true });
  }

  return { open, send, setRequestHeader, abort };
}

function newSynthetic(inner: XMLHttpRequest | null): Synthetic {
  return { readyState: 1, status: 0, statusText: '', headers: '', body: '', response: null, url: '', done: false, inner, pauseCtl: new AbortController(), timers: [], release: () => {} };
}

function cancel(syn: Synthetic) {
  for (const t of syn.timers) clearTimeout(t);
  syn.timers.length = 0;
  syn.release();
  syn.release = () => {};
}

function textReply(status: number, headers: Pair[], body: string, method: string, type: XMLHttpRequestResponseType, url: string): Reply {
  const text = method === 'HEAD' || BODYLESS_STATUS.has(status) ? '' : body;
  const ct = headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  return { status, statusText: statusText(status), headers, text, response: convert(text, type, ct), url };
}

function shadow(xhr: XMLHttpRequest, syn: Synthetic) {
  const textual = () => xhr.responseType === '' || xhr.responseType === 'text';
  const get = (fn: () => unknown) => ({ configurable: true, get: fn });
  Object.defineProperties(xhr, {
    readyState: get(() => syn.readyState),
    status: get(() => syn.status),
    statusText: get(() => syn.statusText),
    responseURL: get(() => (syn.readyState >= 2 ? syn.url : '')),
    responseXML: get(() => null),
    responseText: get(() => {
      if (!textual()) throw new DOMException("The value is only accessible if the object's 'responseType' is '' or 'text'.", 'InvalidStateError');
      return syn.readyState >= 3 ? syn.body : '';
    }),
    response: get(() => (syn.readyState === 4 ? syn.response : textual() ? (syn.readyState >= 3 ? syn.body : '') : null)),
    getResponseHeader: {
      configurable: true,
      value: (name: string) => {
        if (syn.readyState < 2 || !syn.headers) return null;
        const vals = syn.headers.split('\r\n').filter((l) => l.toLowerCase().startsWith(String(name).toLowerCase() + ':')).map((l) => l.slice(l.indexOf(':') + 1).trim());
        return vals.length ? vals.join(', ') : null;
      },
    },
    getAllResponseHeaders: { configurable: true, value: () => (syn.readyState >= 2 ? syn.headers : '') },
  });
}

const safeParse = (t: string) => { try { return JSON.parse(t); } catch { return null; } };

function convert(text: string, type: XMLHttpRequestResponseType, contentType: string): unknown {
  switch (type) {
    case 'json': return safeParse(text);
    case 'arraybuffer': return new TextEncoder().encode(text).buffer;
    case 'blob': return new Blob([text], { type: contentType });
    default: return text;
  }
}

function fire(xhr: XMLHttpRequest, type: string) {
  xhr.dispatchEvent(new Event(type));
}

function fireProgress(xhr: XMLHttpRequest, type: string, bytes: number) {
  xhr.dispatchEvent(new ProgressEvent(type, { lengthComputable: bytes > 0, loaded: bytes, total: bytes }));
}
