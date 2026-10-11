// Data-only update check (G24): on an explicit click, read the published manifest and bookmark text,
// validate them against each other, and hand the text back for the user to copy. Nothing here
// executes, installs or stores the downloaded text, and nothing runs without a click.

export interface Manifest {
  schema: 1;
  version: string;
  bookmarkChars: number;
  bookmarkSha256: string;
  minifiedSha256: string;
  builtAt: string;
}

export type UpdateResult =
  | { kind: 'current'; manifest: Manifest }
  | { kind: 'older'; manifest: Manifest }
  | { kind: 'newer'; manifest: Manifest; bookmark: string }
  | { kind: 'error'; message: string };

export const UPDATE = { manifestBytes: 16 * 1024, bookmarkChars: 4 * 1024 * 1024, timeoutMs: 15_000 } as const;
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** Semver order; prerelease parts compare numerically where both are numbers or share a prefix (r7 < r10). */
export function compareVersions(a: string, b: string): number {
  const [ma, pa] = split(a), [mb, pb] = split(b);
  for (let i = 0; i < 3; i++) if (ma[i] !== mb[i]) return ma[i]! < mb[i]! ? -1 : 1;
  if (pa === pb) return 0;
  if (!pa) return 1; // a release is newer than its prereleases
  if (!pb) return -1;
  return Math.sign(pa.localeCompare(pb, 'en', { numeric: true }));
}
function split(v: string): [number[], string] {
  const i = v.indexOf('-');
  return [(i < 0 ? v : v.slice(0, i)).split('.').map(Number), i < 0 ? '' : v.slice(i + 1)];
}

export function parseManifest(text: string): Manifest | string {
  let o: unknown;
  try { o = JSON.parse(text); } catch { return 'The update manifest is not JSON'; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'The update manifest is not an object';
  const m = o as Record<string, unknown>;
  if (m.schema !== 1) return `Unsupported update manifest schema ${JSON.stringify(m.schema)}`;
  if (typeof m.version !== 'string' || !VERSION.test(m.version) || m.version.length > 64) return 'The update manifest has no valid version';
  if (!Number.isSafeInteger(m.bookmarkChars) || (m.bookmarkChars as number) < 12 || (m.bookmarkChars as number) > UPDATE.bookmarkChars) return 'The update manifest has no valid bookmark length';
  if (typeof m.bookmarkSha256 !== 'string' || !HEX64.test(m.bookmarkSha256)) return 'The update manifest has no valid bookmark SHA-256';
  if (typeof m.minifiedSha256 !== 'string' || !HEX64.test(m.minifiedSha256)) return 'The update manifest has no valid bundle SHA-256';
  return { schema: 1, version: m.version, bookmarkChars: m.bookmarkChars as number, bookmarkSha256: m.bookmarkSha256, minifiedSha256: m.minifiedSha256, builtAt: typeof m.builtAt === 'string' ? m.builtAt.slice(0, 40) : '' };
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Bound the bytes read, including multibyte text, and release the owned reader. */
async function bounded(res: Response, max: number, what: string): Promise<string> {
  if (!res.ok || Number(res.headers.get('content-length')) > max) {
    void res.body?.cancel().catch(() => {});
    throw new Error(!res.ok ? `${what}: HTTP ${res.status}` : `${what} is larger than expected`);
  }
  const reader = res.body?.getReader();
  if (!reader) return '';
  const dec = new TextDecoder();
  let out = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return out + dec.decode();
      bytes += value.byteLength;
      if (bytes > max) { void reader.cancel().catch(() => {}); throw new Error(`${what} is larger than expected`); }
      out += dec.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

/** One check. `base` ends with "/" and holds update.json and bookmark.txt. */
export async function checkForUpdate(fetcher: Fetcher, base: string, running: string, signal?: AbortSignal): Promise<UpdateResult> {
  const timeout = AbortSignal.timeout(UPDATE.timeoutMs);
  const init: RequestInit = { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
  try {
    const m = parseManifest(await bounded(await fetcher(`${base}update.json`, init), UPDATE.manifestBytes, 'Update manifest'));
    if (typeof m === 'string') return { kind: 'error', message: m };
    const order = compareVersions(m.version, running);
    if (order === 0) return { kind: 'current', manifest: m };
    if (order < 0) return { kind: 'older', manifest: m };
    const text = await bounded(await fetcher(`${base}bookmark.txt`, init), UPDATE.bookmarkChars, 'Published bookmark');
    if (!text.startsWith('javascript:')) return { kind: 'error', message: 'The published bookmark does not start with javascript:; nothing to copy' };
    if (text.length !== m.bookmarkChars) return { kind: 'error', message: `The published bookmark has ${text.length} characters; the manifest says ${m.bookmarkChars}. The deployment is inconsistent (perhaps mid-upload); try again later` };
    if (await sha256(text) !== m.bookmarkSha256) return { kind: 'error', message: 'The published bookmark does not match the manifest SHA-256. The deployment is inconsistent; nothing to copy' };
    return { kind: 'newer', manifest: m, bookmark: text };
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    const message = name === 'TimeoutError' ? `No answer within ${UPDATE.timeoutMs / 1000} s`
      : name === 'TypeError' ? 'The update address could not be read from this page (offline, blocked by this site\'s Content-Security-Policy connect-src, or not CORS-readable)'
      : e instanceof Error ? e.message : String(e);
    return { kind: 'error', message };
  }
}
