// XHR adapter. Instruments XMLHttpRequest.prototype so native objects, constructor identity and
// typed responses are kept. Routing is decided at open(): the native object opens the destination
// directly, so responseType/upload/timeout/events all stay native. Mocks use an explicit state machine.
import { utf8Bytes } from '../data/schema';
import { CAP, cleanHeaders, headerLines, newCapture, redactText, requestBody, sensitiveName, type ResBody } from './capture';
import { BODYLESS_STATUS, planRequest, xhrTransformSkip, type Plan } from './plan';
import type { ReqRecord, Runtime } from './runtime';

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
  plan: Plan;
  sync: boolean;
  rec?: ReqRecord;
  /** Headers the page set, kept for a recorder capture. */
  headers: [string, string][];
  synthetic?: Synthetic;
  pendingAuthNote?: boolean;
}

interface Synthetic {
  readyState: number;
  status: number;
  statusText: string;
  headers: string;
  body: string;
  response: unknown;
  done: boolean;
  cancel(): void;
}

const SHADOWED = ['readyState', 'status', 'statusText', 'response', 'responseText', 'responseURL', 'responseXML', 'getResponseHeader', 'getAllResponseHeaders'] as const;
const STATUS_TEXT: Record<number, string> = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 422: 'Unprocessable Content', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

export function captureXhr(): XhrNatives {
  const p = XMLHttpRequest.prototype;
  return { open: p.open, send: p.send, setRequestHeader: p.setRequestHeader, abort: p.abort };
}

export function createXhr(n: XhrNatives, rt: Runtime): XhrNatives {
  const state = new WeakMap<XMLHttpRequest, XState>();

  function unshadow(xhr: XMLHttpRequest) {
    const st = state.get(xhr);
    st?.synthetic?.cancel();
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
      u = new URL(String(url), location.href);
    } catch {
      return n.open.apply(this, args); // native throws the correct SyntaxError
    }
    const sync = args.length >= 3 && !async;
    const m = String(method).toUpperCase();
    const plan = planRequest(rt.config(), rt.origin, { transport: 'xhr', method: m, url: u, sync });
    state.set(this, { method: m, url: u, plan, sync, headers: [] });
    if (plan.routeTo) {
      const routed = [...args] as unknown[];
      routed[1] = plan.routeTo.href;
      if (routed.length < 3) routed[2] = true;
      return (n.open as (...a: unknown[]) => void).apply(this, routed);
    }
    return n.open.apply(this, args);
  } as Proto['open'];

  const setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    const st = state.get(this);
    if (!rt.inert && st?.plan.dropAuthorization && String(name).toLowerCase() === 'authorization') {
      st.rec ? rt.note(st.rec, 'Authorization removed: destination is a different origin') : (st.pendingAuthNote = true);
      return;
    }
    n.setRequestHeader.call(this, name, value);
    if (st && st.headers.length < 200) st.headers.push([String(name), String(value)]);
  } as Proto['setRequestHeader'];

  const send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    // eslint-disable-next-line prefer-rest-params
    const args = arguments as unknown as Parameters<Proto['send']>;
    const st = state.get(this);
    if (rt.inert || !st || this.readyState !== 1) return n.send.apply(this, args);
    const rec = rt.start('xhr', st.method, st.url, st.plan);
    st.rec = rec;
    rec.responseType = this.responseType || 'text';
    if (st.pendingAuthNote) rt.note(rec, 'Authorization removed: destination is a different origin');
    if (rt.capturing) captureSend(this, st, rec, body);
    if (st.plan.transform) rt.op(rec, 'intercept', 'skipped', xhrTransformSkip(this.responseType));

    if (st.plan.provider === 'mock') {
      if (this.responseType === 'document') {
        rt.op(rec, 'mock', 'skipped', 'Synthetic document responses are not supported; original request sent');
      } else {
        deliverMock(this, st, rec, body);
        return;
      }
    }
    if (st.plan.routeTo) rt.op(rec, 'route', 'applied', `Sent to ${st.plan.routeTo.origin}${st.plan.routeTo.pathname} (query preserved; native ${rec.responseType} response)`);
    const xhr = this;
    const onEnd = (e: Event) => rt.finish(rec, e.type === 'load' ? 'ok' : e.type === 'abort' ? 'aborted' : e.type === 'timeout' ? 'timeout' : 'error', xhr.status);
    for (const t of ['load', 'error', 'abort', 'timeout']) this.addEventListener(t, onEnd, { once: true });
    try {
      return n.send.apply(this, args);
    } catch (e) {
      rt.finish(rec, 'error');
      throw e;
    }
  } as Proto['send'];

  const abort = function (this: XMLHttpRequest) {
    const syn = state.get(this)?.synthetic;
    if (!rt.inert && syn && !syn.done) {
      syn.cancel();
      terminal(this, syn, 'abort');
      syn.readyState = 0;
      const rec = state.get(this)?.rec;
      if (rec) rt.finish(rec, 'aborted');
      return;
    }
    return n.abort.call(this);
  } as Proto['abort'];

  function captureSend(xhr: XMLHttpRequest, st: XState, rec: ReqRecord, body: unknown) {
    const c = newCapture(rec, st.method, st.url);
    rec.capture = c;
    c.headers = cleanHeaders(st.headers, c);
    c.credentials = xhr.withCredentials ? 'include' : 'same-origin';
    const ct = st.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
    c.body = requestBody(body, ct, c);
    xhr.addEventListener('loadend', () => {
      c.status = xhr.status || undefined;
      c.synthetic = !!st.synthetic;
      c.resHeaders = headerLines(xhr.getAllResponseHeaders()).filter(([k]) => !sensitiveName(k));
      const t = xhr.responseType;
      const rct = xhr.getResponseHeader('content-type') ?? '';
      const cut = (text: string): ResBody => {
        if (utf8Bytes(text) <= CAP.responseBytes) return { text: redactText(text, rct, c, 'Response body'), truncated: false };
        return { text: redactText(new TextDecoder().decode(new TextEncoder().encode(text).subarray(0, CAP.responseBytes)), rct, c, 'Response body'), truncated: true };
      };
      if (!xhr.status) { /* no response */ }
      else if (t === '' || t === 'text') c.resBody = cut(xhr.responseText);
      else if (t === 'json') {
        c.resBody = xhr.response == null ? { omitted: 'responseType json: the body did not parse' } : cut(JSON.stringify(xhr.response));
        c.notes.push('Response JSON was re-serialized from responseType json; spacing may differ');
      } else c.resBody = { omitted: `XHR ${t} response is not captured` };
      c.ms = rec.elapsedMs;
      queueMicrotask(() => rt.captured(rec)); // after finish() has set the outcome
    }, { once: true });
  }

  function deliverMock(xhr: XMLHttpRequest, st: XState, rec: ReqRecord, _body: unknown) {
    const m = st.plan.mock!;
    const bodyless = st.method === 'HEAD' || BODYLESS_STATUS.has(m.status);
    const text = bodyless ? '' : m.body;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let release = () => {};
    const syn: Synthetic = {
      readyState: 1,
      status: 0,
      statusText: '',
      headers: '',
      body: text,
      response: null,
      done: false,
      cancel() {
        clearTimeout(timer);
        clearTimeout(timeoutTimer);
        release();
      },
    };
    st.synthetic = syn;
    shadow(xhr, syn);

    const deliver = () => {
      if (syn.done) return;
      syn.cancel();
      syn.status = m.status;
      syn.statusText = STATUS_TEXT[m.status] ?? '';
      syn.headers = `content-type: ${m.contentType}\r\n`;
      syn.readyState = 2;
      fire(xhr, 'readystatechange');
      if (syn.done) return; // a handler may have aborted
      syn.readyState = 3;
      fire(xhr, 'readystatechange');
      const bytes = new TextEncoder().encode(text).byteLength;
      fireProgress(xhr, 'progress', bytes);
      if (syn.done) return;
      syn.response = convert(text, xhr.responseType, m.contentType);
      syn.readyState = 4;
      syn.done = true;
      rt.op(rec, 'mock', 'applied', `Synthetic ${m.status} ${xhr.responseType || 'text'} reply${m.delayMs ? ` after ${m.delayMs} ms` : ''}; no upstream request`);
      rt.finish(rec, 'ok', m.status);
      fire(xhr, 'readystatechange');
      fireProgress(xhr, 'load', bytes);
      fireProgress(xhr, 'loadend', bytes);
    };

    fireProgress(xhr, 'loadstart', 0);
    release = rt.own(deliver);
    timer = setTimeout(deliver, m.delayMs);
    if (xhr.timeout > 0 && xhr.timeout <= m.delayMs) {
      timeoutTimer = setTimeout(() => {
        if (syn.done) return;
        syn.cancel();
        terminal(xhr, syn, 'timeout');
        rt.finish(rec, 'timeout');
      }, xhr.timeout);
    }
  }

  function terminal(xhr: XMLHttpRequest, syn: Synthetic, type: 'abort' | 'timeout') {
    syn.done = true;
    syn.status = 0;
    syn.statusText = '';
    syn.headers = '';
    syn.response = null;
    syn.body = '';
    syn.readyState = 4;
    fire(xhr, 'readystatechange');
    fireProgress(xhr, type, 0);
    fireProgress(xhr, 'loadend', 0);
  }

  return { open, send, setRequestHeader, abort };
}

function shadow(xhr: XMLHttpRequest, syn: Synthetic) {
  const textual = () => xhr.responseType === '' || xhr.responseType === 'text';
  const get = (fn: () => unknown) => ({ configurable: true, get: fn });
  Object.defineProperties(xhr, {
    readyState: get(() => syn.readyState),
    status: get(() => syn.status),
    statusText: get(() => syn.statusText),
    responseURL: get(() => ''),
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
        const line = syn.headers.split('\r\n').find((l) => l.toLowerCase().startsWith(String(name).toLowerCase() + ':'));
        return line ? line.slice(line.indexOf(':') + 1).trim() : null;
      },
    },
    getAllResponseHeaders: { configurable: true, value: () => (syn.readyState >= 2 ? syn.headers : '') },
  });
}

function convert(text: string, type: XMLHttpRequestResponseType, contentType: string): unknown {
  switch (type) {
    case 'json':
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    case 'arraybuffer':
      return new TextEncoder().encode(text).buffer;
    case 'blob':
      return new Blob([text], { type: contentType });
    default:
      return text;
  }
}

function fire(xhr: XMLHttpRequest, type: string) {
  xhr.dispatchEvent(new Event(type));
}

function fireProgress(xhr: XMLHttpRequest, type: string, bytes: number) {
  xhr.dispatchEvent(new ProgressEvent(type, { lengthComputable: bytes > 0, loaded: bytes, total: bytes }));
}
