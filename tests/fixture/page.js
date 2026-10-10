// Fixture "application". Looks up fetch/XMLHttpRequest at call time so installed hooks apply.
(function () {
  async function digest(buf) {
    const h = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function describeBody(kind, value) {
    if (value == null) return { kind, value: null };
    if (value instanceof ArrayBuffer) return { kind: 'arraybuffer', bytes: value.byteLength, sha256: await digest(value), text: new TextDecoder().decode(value).slice(0, 4096) };
    if (value instanceof Blob) { const b = await value.arrayBuffer(); return { kind: 'blob', type: value.type, bytes: b.byteLength, sha256: await digest(b), text: new TextDecoder().decode(b).slice(0, 4096) }; }
    if (typeof value === 'string') return { kind: 'text', bytes: new TextEncoder().encode(value).byteLength, text: value.slice(0, 65536) };
    return { kind: 'json', json: value };
  }

  /** Send one request and return a plain description. */
  async function send(o) {
    const opts = Object.assign({ transport: 'fetch', method: 'GET', url: '/api/mock-target', responseType: '', headers: {} }, o);
    const started = performance.now();
    if (opts.transport === 'fetch') {
      const ctl = new AbortController();
      if (opts.abortAfterMs != null) setTimeout(() => ctl.abort(), opts.abortAfterMs);
      const init = { method: opts.method, headers: opts.headers, signal: ctl.signal };
      if (opts.credentials) init.credentials = opts.credentials;
      if (opts.body != null) init.body = opts.body;
      try {
        const input = opts.asRequest ? new Request(opts.url, init) : opts.url;
        const res = opts.asRequest ? await window.fetch(input) : await window.fetch(input, init);
        const value = opts.responseType === 'arraybuffer' ? await res.arrayBuffer() : opts.responseType === 'blob' ? await res.blob() : opts.responseType === 'json' ? await res.json().catch(() => null) : await res.text();
        return { ok: true, status: res.status, statusText: res.statusText, url: res.url, type: res.type, contentType: res.headers.get('content-type'), servedBy: res.headers.get('x-served-by'), isResponse: res instanceof Response, body: await describeBody(opts.responseType, value), ms: performance.now() - started };
      } catch (e) {
        return { ok: false, error: e && e.name, message: String(e && e.message), ms: performance.now() - started };
      }
    }
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      const trace = [];
      const rec = (e) => trace.push(e.type === 'readystatechange' ? `rsc${xhr.readyState}` : e.type);
      for (const t of ['readystatechange', 'loadstart', 'progress', 'load', 'error', 'abort', 'timeout', 'loadend']) xhr.addEventListener(t, rec);
      let attrLoadend = false;
      xhr.onloadend = () => { attrLoadend = true; };
      const finish = async () => {
        let text = null;
        try { text = xhr.responseText; } catch (e) { text = `throws:${e.name}`; }
        resolve({ ok: xhr.status !== 0, status: xhr.status, statusText: xhr.statusText, url: xhr.responseURL, readyState: xhr.readyState, responseType: xhr.responseType, contentType: xhr.getResponseHeader('content-type'), servedBy: xhr.getResponseHeader('x-served-by'), isXhr: xhr instanceof XMLHttpRequest, protoIntact: Object.getPrototypeOf(xhr) === XMLHttpRequest.prototype, trace, attrLoadend, responseText: text && text.slice(0, 4096), body: await describeBody(xhr.responseType, xhr.response), ms: performance.now() - started });
      };
      xhr.addEventListener('loadend', () => setTimeout(finish, 0));
      const sync = opts.sync === true;
      xhr.open(opts.method, opts.url, !sync);
      if (!sync && opts.responseType) xhr.responseType = opts.responseType;
      if (opts.timeout) xhr.timeout = opts.timeout;
      if (opts.withCredentials) xhr.withCredentials = true;
      for (const [k, v] of Object.entries(opts.headers)) xhr.setRequestHeader(k, v);
      if (opts.abortAfterMs != null) setTimeout(() => xhr.abort(), opts.abortAfterMs);
      try {
        xhr.send(opts.body == null ? null : opts.body);
      } catch (e) {
        resolve({ ok: false, error: e.name, trace });
      }
      if (sync) finish();
    });
  }

  window.fx = { send };

  const $ = (id) => document.getElementById(id);
  $('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('out').textContent = 'Sending…';
    const r = await send({ transport: $('transport').value, responseType: $('rt').value, method: $('method').value, url: $('url').value, body: $('body').value || null });
    $('out').textContent = JSON.stringify(r, null, 2);
  });
  $('login').addEventListener('click', async () => {
    const r = await send({ url: '/api/login', method: 'POST' });
    $('out').textContent = JSON.stringify(r, null, 2);
  });
})();
