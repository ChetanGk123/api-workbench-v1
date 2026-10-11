// The one supported signing recipe: HMAC-SHA-256 over an explicit ordered byte template, with
// native Web Cryptography. Keys are non-extractable CryptoKeys held for this session only.
import type { SigningComponent, SigningRecipe } from '../data/schema';
import type { Prepared, PreparedHeader } from './once';

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));

/** Import key text as a non-extractable HMAC-SHA-256 signing key. The text is not kept. */
export const importKey = (secret: string) =>
  crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

export interface SignInput { method: string; url: string; bodyText: string | null; headers: { name: string; value: string }[]; timestamp: string; nonce: string }

/** The exact canonical message for a recipe, in its component order. */
export async function canonical(r: SigningRecipe, x: SignInput): Promise<string> {
  const u = new URL(x.url);
  const part = async (c: SigningComponent): Promise<string> => {
    switch (c) {
      case 'method': return x.method;
      case 'path': return u.pathname;
      case 'query': return u.search.slice(1);
      case 'body-sha256': return hex(await crypto.subtle.digest('SHA-256', enc.encode(x.bodyText ?? '')));
      case 'timestamp': return x.timestamp;
      case 'nonce': return x.nonce;
      default: {
        const name = c.slice(7).toLowerCase();
        return x.headers.find((h) => h.name.toLowerCase() === name)?.value ?? '';
      }
    }
  };
  const parts: string[] = [];
  for (const c of r.components) parts.push(await part(c));
  return parts.join(r.separator);
}

export async function signature(r: SigningRecipe, key: CryptoKey, message: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return r.encoding === 'hex' ? hex(mac) : b64(mac);
}

/**
 * Sign a prepared request for one transmitted attempt: fresh timestamp and nonce, then the
 * signature header. Logical values (body, idempotency key) are unchanged between attempts.
 */
export async function signPrepared(p: Prepared, key: CryptoKey, now: number, nonce: string): Promise<{ headers: PreparedHeader[]; message: string }> {
  const r = p.signing!;
  const headers = p.headers.slice();
  const set = (name: string, value: string, shown = value) => {
    const i = headers.findIndex((h) => h.name.toLowerCase() === name.toLowerCase());
    const h: PreparedHeader = { name, value, shown, from: 'signing' };
    if (i >= 0) headers[i] = h; else headers.push(h);
  };
  const timestamp = String(now);
  if (r.timestampHeader) set(r.timestampHeader, timestamp);
  if (r.nonceHeader) set(r.nonceHeader, nonce);
  const message = await canonical(r, { method: p.method, url: p.url, bodyText: p.bodyText, headers, timestamp, nonce });
  const sig = await signature(r, key, message);
  set(r.outputHeader, sig, `${sig.slice(0, 8)}… (signed at dispatch)`);
  return { headers, message };
}
