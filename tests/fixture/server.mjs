// Two-origin loopback fixture (test infrastructure, never shipped).
// A = 127.0.0.1:AW_PORT (default 4310), B = 127.0.0.1:AW_OTHER_PORT (default 4311).
import { createServer } from 'node:http';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const PORT_A = Number(process.env.AW_PORT ?? 4310);
const PORT_B = Number(process.env.AW_OTHER_PORT ?? 4311);
const ORIGINS = new Set([`http://127.0.0.1:${PORT_A}`, `http://127.0.0.1:${PORT_B}`]);

/** Hit counters, read by tests from outside the page (never through wrapped transports). */
const hits = new Map();
const transfers = new Set();
const count = (key) => hits.set(key, (hits.get(key) ?? 0) + 1);

// Banking-style acceptance fixture (R6/G27): synthetic identities, accounts and amounts only.
// Exact decimal strings; fee 0.50 per transfer; HMAC-SHA-256 request signing with a known test key.
export const BANK_KEY = 'test-key-123';
const bankFresh = () => ({ cfg: { ttl: 60_000, refresh: 'ok', pending: 2 }, tokens: new Map(), sessions: new Set(), csrf: randomUUID(), quotes: new Map(), transfers: new Map(), byKey: new Map(), nonces: new Set(), crud: new Map(), seq: 0 });
let bank = bankFresh();
const cents = (s) => { const [i, f = ''] = String(s).split('.'); return BigInt(i) * 100n + BigInt((f + '00').slice(0, 2)) * (String(s).startsWith('-') ? -1n : 1n); };
const money = (c) => `${c / 100n}.${String((c < 0n ? -c : c) % 100n).padStart(2, '0')}`;
const issue = () => { const t = `tok-${randomUUID()}`; const exp = Date.now() + bank.cfg.ttl; bank.tokens.set(t, exp); return { token: t, expiresAt: exp }; };

export const POLICIES = {
  strict: "default-src 'none'; script-src 'self'; style-src 'none'; connect-src 'self'; img-src 'none'; require-trusted-types-for 'script'",
  'blocked-connect': "default-src 'none'; script-src 'self'; style-src 'none'; connect-src 'none'; img-src 'none'; require-trusted-types-for 'script'",
};

function cors(req, res) {
  const o = req.headers.origin;
  if (o && ORIGINS.has(o)) {
    res.setHeader('access-control-allow-origin', o);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-headers', 'content-type, authorization, x-test, x-signature, x-xsrf-token, x-added, idempotency-key, x-timestamp, x-nonce');
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, HEAD');
    res.setHeader('access-control-expose-headers', 'x-served-by, x-idempotent-replay');
  }
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie ?? '').split(';').filter(Boolean).map((p) => p.trim().split('=').map(decodeURIComponent)));
}

function handler(name) {
  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    res.setHeader('x-served-by', name);
    res.setHeader('cache-control', 'no-store');

    if (path === '/__ready') return res.end('ok');
    if (path === '/__counters') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(Object.fromEntries(hits)));
    }
    if (path === '/__reset') {
      hits.clear();
      transfers.clear();
      bank = bankFresh();
      return res.end('reset');
    }
    if (path === '/__bank') {
      for (const k of ['ttl', 'pending']) if (url.searchParams.has(k)) bank.cfg[k] = Number(url.searchParams.get(k));
      if (url.searchParams.has('refresh')) bank.cfg.refresh = url.searchParams.get('refresh');
      if (url.searchParams.has('expire')) for (const t of bank.tokens.keys()) bank.tokens.set(t, 0);
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ cfg: bank.cfg, transfers: [...bank.transfers.values()], tokens: bank.tokens.size, csrf: bank.csrf }));
    }

    if (path === '/fixture' || path.startsWith('/policy/')) {
      const policy = POLICIES[path.slice('/policy/'.length)];
      if (path.startsWith('/policy/') && !policy) return notFound(res);
      if (policy) res.setHeader('content-security-policy', policy);
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(await readFile(join(here, 'page.html')));
    }
    if (path === '/fixture.js') {
      res.setHeader('content-type', 'text/javascript; charset=utf-8');
      return res.end(await readFile(join(here, 'page.js')));
    }
    if (path === '/install') return file(res, join(root, 'dist', 'install.html'), 'text/html; charset=utf-8');
    if (path.startsWith('/dist/')) {
      const p = normalize(join(root, path));
      if (!p.startsWith(join(root, 'dist'))) return notFound(res);
      return file(res, p, p.endsWith('.json') ? 'application/json' : p.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8');
    }

    if (!path.startsWith('/api/')) return notFound(res);
    cors(req, res);
    if (req.method === 'OPTIONS') {
      count(`OPTIONS ${path}`);
      res.statusCode = 204;
      return res.end();
    }
    const bytes = await body(req);
    count(path);

    if (path === '/api/cors-denied') res.removeHeader('access-control-allow-origin');
    if (path === '/api/login') {
      res.setHeader('set-cookie', 'session=s3cr3t-session; HttpOnly; Path=/; SameSite=Lax');
      return json(res, { ok: true });
    }
    if (path === '/api/slow') {
      const ms = Math.min(Number(url.searchParams.get('ms') ?? 1000), 30000);
      await new Promise((r) => setTimeout(r, ms));
    }
    if (path === '/api/status') {
      res.statusCode = Number(url.searchParams.get('code') ?? 500);
    }
    if (path === '/api/binary') {
      const n = Math.min(Number(url.searchParams.get('n') ?? 256), 16 * 1024 * 1024);
      const buf = Buffer.alloc(n);
      for (let i = 0; i < n; i++) buf[i] = i % 256;
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-length', n);
      return res.end(buf);
    }
    if (path === '/api/big') {
      const n = Math.min(Number(url.searchParams.get('n') ?? 4 * 1024 * 1024), 32 * 1024 * 1024);
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.setHeader('content-length', n);
      return res.end(Buffer.alloc(n, 'a'));
    }
    if (path === '/api/stream') {
      // Unknown length, slow chunks.
      const parts = Math.min(Number(url.searchParams.get('parts') ?? 5), 100);
      const gap = Math.min(Number(url.searchParams.get('gap') ?? 200), 5000);
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      for (let i = 0; i < parts; i++) {
        res.write(`chunk${i};`);
        await new Promise((r) => setTimeout(r, gap));
      }
      return res.end();
    }
    if (path === '/api/idempotent-transfer') {
      // Idempotent write: a repeated Idempotency-Key is a duplicate, not a second transfer.
      const key = req.headers['idempotency-key'] ?? '';
      const first = !!key && !transfers.has(key);
      if (first) { transfers.add(key); count('transfer:logical'); }
      return json(res, { key, duplicate: !!key && !first });
    }
    if (path.startsWith('/api/crud/items')) {
      // CRUD producer/consumer: every POST creates a distinct item.
      if (req.method === 'POST' && path === '/api/crud/items') {
        const id = `item-${++bank.seq}`;
        let n = null;
        try { n = JSON.parse(bytes.toString('utf8')).n ?? null; } catch { /* not JSON */ }
        bank.crud.set(id, { id, n });
        count(`crud:create:${id}`);
        res.statusCode = 201;
        return json(res, { id, n });
      }
      const id = path.slice('/api/crud/items/'.length);
      count(`crud:read:${id}`);
      const item = bank.crud.get(id);
      if (!item) { res.statusCode = 404; return json(res, { error: 'not found', id }); }
      return json(res, item);
    }
    if (path.startsWith('/api/bank/')) return bankRoute(req, res, url, path, bytes);
    if (path === '/api/text') {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      return res.end(url.searchParams.get('t') ?? 'hello from server');
    }

    // Default: echo.
    return json(res, {
      servedBy: name,
      method: req.method,
      path,
      query: [...url.searchParams],
      headers: {
        authorization: req.headers.authorization ?? null,
        'content-type': req.headers['content-type'] ?? null,
        'x-test': req.headers['x-test'] ?? null,
        'x-signature': req.headers['x-signature'] ?? null,
        'x-xsrf-token': req.headers['x-xsrf-token'] ?? null,
        'x-added': req.headers['x-added'] ?? null,
        accept: req.headers.accept ?? null,
      },
      session: cookies(req).session ?? null,
      bodyBytes: bytes.length,
      bodySha256: createHash('sha256').update(bytes).digest('hex'),
      bodyText: bytes.length <= 65536 ? bytes.toString('utf8') : null,
      unicode: 'héllo ✓ 日本',
    });
  };
}

function bankRoute(req, res, url, path, bytes) {
  const fail = url.searchParams.get('fail');
  if (fail === 'malformed') { res.setHeader('content-type', 'application/json'); return res.end('{"broken":'); }
  if (fail) { res.statusCode = Number(fail); return json(res, { error: `injected ${fail}` }); }
  const ck = cookies(req);
  if (path === '/api/bank/login' && req.method === 'POST') {
    const sid = randomUUID();
    bank.sessions.add(sid);
    bank.csrf = randomUUID();
    res.setHeader('set-cookie', [`bank_session=${sid}; HttpOnly; Path=/; SameSite=Lax`, `XSRF-TOKEN=${bank.csrf}; Path=/; SameSite=Lax`]);
    return json(res, { user: 'synthetic-customer-a', ...issue() });
  }
  if (!bank.sessions.has(ck.bank_session)) { res.statusCode = 401; return json(res, { error: 'no session' }); }
  if (path === '/api/bank/refresh' && req.method === 'POST') {
    count('bank:refresh');
    if (bank.cfg.refresh !== 'ok') { res.statusCode = 401; return json(res, { error: 'refresh rejected' }); }
    return json(res, issue());
  }
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  const exp = bank.tokens.get(bearer);
  if (!exp || exp <= Date.now()) { count('bank:401'); res.statusCode = 401; return json(res, { error: exp ? 'token expired' : 'bad token' }); }
  if (path === '/api/bank/accounts' && req.method === 'GET') return json(res, { accounts: [{ id: 'acc-001', name: 'Synthetic current', balance: '1000.00', currency: 'EUR' }, { id: 'acc-002', name: 'Synthetic savings', balance: '50.00', currency: 'EUR' }] });
  if (path === '/api/bank/quotes' && req.method === 'POST') {
    let b; try { b = JSON.parse(bytes.toString('utf8')); } catch { res.statusCode = 422; return json(res, { error: 'body is not JSON' }); }
    if (!/^\d+\.\d{2}$/.test(String(b.amount ?? ''))) { res.statusCode = 422; return json(res, { error: 'amount must be a decimal string with 2 places' }); }
    const id = `q-${++bank.seq}`;
    const q = { id, accountId: b.accountId, amount: b.amount, fee: '0.50', total: money(cents(b.amount) + 50n), currency: 'EUR', expiresAt: Date.now() + 60_000 };
    bank.quotes.set(id, q);
    return json(res, q);
  }
  if (path === '/api/bank/transfers' && req.method === 'POST') {
    if (req.headers['x-xsrf-token'] !== bank.csrf) { count('bank:csrf-rejected'); res.statusCode = 403; return json(res, { error: 'csrf' }); }
    const key = req.headers['idempotency-key'];
    if (!key) { res.statusCode = 422; return json(res, { error: 'Idempotency-Key required' }); }
    const ts = Number(req.headers['x-timestamp']), nonce = req.headers['x-nonce'] ?? '';
    const msg = [req.method, url.pathname, url.search.slice(1), createHash('sha256').update(bytes).digest('hex'), String(req.headers['x-timestamp'] ?? ''), nonce].join('\n');
    const want = createHmac('sha256', BANK_KEY).update(msg).digest('hex');
    if (req.headers['x-signature'] !== want) { count('bank:bad-signature'); res.statusCode = 401; return json(res, { error: 'signature' }); }
    if (!(Math.abs(Date.now() - ts) < 30_000) || bank.nonces.has(nonce)) { count('bank:stale-signature'); res.statusCode = 401; return json(res, { error: 'stale timestamp or reused nonce' }); }
    bank.nonces.add(nonce);
    bank.csrf = randomUUID(); // rotates after every accepted write
    res.setHeader('set-cookie', `XSRF-TOKEN=${bank.csrf}; Path=/; SameSite=Lax`);
    const prior = bank.byKey.get(key);
    if (prior) { count('bank:transfer:duplicate'); res.statusCode = 202; res.setHeader('x-idempotent-replay', 'true'); return json(res, prior); }
    let b; try { b = JSON.parse(bytes.toString('utf8')); } catch { res.statusCode = 422; return json(res, { error: 'body is not JSON' }); }
    const q = bank.quotes.get(b.quoteId);
    if (!q) { res.statusCode = 409; return json(res, { error: 'unknown quote' }); }
    if (b.amount !== q.amount) { res.statusCode = 422; return json(res, { error: `amount ${b.amount} does not match quote ${q.amount}` }); }
    const t = { id: `t-${++bank.seq}`, status: 'pending', amount: q.amount, fee: q.fee, total: q.total, currency: q.currency, polls: 0 };
    bank.transfers.set(t.id, t);
    count('bank:transfer:logical');
    const out = { id: t.id, status: t.status, amount: t.amount };
    bank.byKey.set(key, out);
    res.statusCode = 202;
    return json(res, out);
  }
  const m = /^\/api\/bank\/transfers\/([\w-]+)(\/receipt)?$/.exec(path);
  if (m && req.method === 'GET') {
    const t = bank.transfers.get(m[1]);
    if (!t) { res.statusCode = 404; return json(res, { error: 'unknown transfer' }); }
    if (m[2]) {
      if (t.status !== 'completed') { res.statusCode = 409; return json(res, { error: 'not completed' }); }
      res.setHeader('content-type', 'application/pdf');
      return res.end(Buffer.from(`%PDF-1.4 synthetic receipt ${t.id} ${t.total}\n`, 'latin1'));
    }
    count('bank:status');
    if (++t.polls > bank.cfg.pending) t.status = 'completed';
    return json(res, { id: t.id, status: t.status, amount: t.amount, fee: t.fee, total: t.total, currency: t.currency });
  }
  return notFound(res);
}

function json(res, v) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(v));
}
function notFound(res) {
  res.statusCode = 404;
  res.end('not found');
}
async function file(res, p, type) {
  try {
    const data = await readFile(p);
    res.setHeader('content-type', type);
    res.end(data);
  } catch {
    notFound(res);
  }
}

createServer(handler('A')).listen(PORT_A, '127.0.0.1');
createServer(handler('B')).listen(PORT_B, '127.0.0.1');
console.log(`fixture A http://127.0.0.1:${PORT_A}/fixture · B http://127.0.0.1:${PORT_B} · installer http://127.0.0.1:${PORT_A}/install`);
