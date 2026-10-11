// Two-origin loopback fixture (test infrastructure, never shipped).
// A = 127.0.0.1:AW_PORT (default 4310), B = 127.0.0.1:AW_OTHER_PORT (default 4311).
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
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

export const POLICIES = {
  strict: "default-src 'none'; script-src 'self'; style-src 'none'; connect-src 'self'; img-src 'none'; require-trusted-types-for 'script'",
  'blocked-connect': "default-src 'none'; script-src 'self'; style-src 'none'; connect-src 'none'; img-src 'none'; require-trusted-types-for 'script'",
};

function cors(req, res) {
  const o = req.headers.origin;
  if (o && ORIGINS.has(o)) {
    res.setHeader('access-control-allow-origin', o);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-headers', 'content-type, authorization, x-test, x-signature, x-xsrf-token, x-added, idempotency-key');
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, HEAD');
    res.setHeader('access-control-expose-headers', 'x-served-by');
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
      return res.end('reset');
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
