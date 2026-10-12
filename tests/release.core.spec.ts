// R8 pure assertions: profile settings validation/defaults and the data-only update check.
import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { defaultProfile, rulesFromV1, validateAggregate } from '../src/data/schema';
import { checkForUpdate, compareVersions, parseManifest } from '../src/data/update';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const HEX = 'a'.repeat(64);

test.describe('profile settings (S18.2, G23)', () => {
  test('R2–R7 data without the new fields loads with documented defaults', () => {
    const a = defaultProfile();
    (a.profile as { settings: unknown }).settings = { bodyCheckKb: 256 };
    const r = validateAggregate(JSON.parse(JSON.stringify(a)));
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.profile.settings).toEqual({ bodyCheckKb: 256, hidden: [], activityRecords: 500, recorderCalls: 100, responseBodies: true, recorderRecovery: true, recorderSecrets: false, contextRoots: [] });
  });

  test('bounds, module names and root names are enforced', () => {
    const bad = (settings: Record<string, unknown>) => {
      const a = defaultProfile();
      Object.assign(a.profile.settings, settings);
      const r = validateAggregate(JSON.parse(JSON.stringify(a)));
      return r.ok ? [] : r.errors.map((e) => e.path);
    };
    expect(bad({ activityRecords: 49 })).toEqual(['profile.settings.activityRecords']);
    expect(bad({ activityRecords: 501 })).toEqual(['profile.settings.activityRecords']);
    expect(bad({ recorderCalls: 1001 })).toEqual(['profile.settings.recorderCalls']);
    expect(bad({ hidden: ['mock', 'test'] })).toEqual(['profile.settings.hidden.1']);
    expect(bad({ contextRoots: ['appConfig', 'a.b', '__proto__'] })).toEqual(['profile.settings.contextRoots.1']);
    expect(bad({ responseBodies: 'no' })).toEqual(['profile.settings.responseBodies']);
    expect(bad({ hidden: ['chaos', 'recorder'], contextRoots: ['__STATE__'] })).toEqual([]);
  });
});

test.describe('data-only update check (S18.3, G24)', () => {
  test('version order: prerelease numbers, releases after prereleases', () => {
    expect(compareVersions('2.0.0-r8', '2.0.0-r7')).toBe(1);
    expect(compareVersions('2.0.0-r10', '2.0.0-r9')).toBe(1);
    expect(compareVersions('2.0.0', '2.0.0-r8')).toBe(1);
    expect(compareVersions('2.0.0-r8', '2.0.0-r8')).toBe(0);
    expect(compareVersions('1.9.9', '2.0.0-r1')).toBe(-1);
    expect(compareVersions('2.0.10', '2.0.9')).toBe(1);
  });

  test('manifest validation names the problem', () => {
    const ok = { schema: 1, version: '2.0.0-r9', bookmarkChars: 100, bookmarkSha256: HEX, minifiedSha256: HEX, builtAt: 'x' };
    expect(parseManifest(JSON.stringify(ok))).toMatchObject({ version: '2.0.0-r9' });
    expect(parseManifest('<html>')).toBe('The update manifest is not JSON');
    expect(parseManifest(JSON.stringify({ ...ok, schema: 2 }))).toBe('Unsupported update manifest schema 2');
    expect(parseManifest(JSON.stringify({ ...ok, version: 'latest' }))).toBe('The update manifest has no valid version');
    expect(parseManifest(JSON.stringify({ ...ok, bookmarkSha256: 'abc' }))).toBe('The update manifest has no valid bookmark SHA-256');
    expect(parseManifest(JSON.stringify({ ...ok, bookmarkChars: 9e9 }))).toBe('The update manifest has no valid bookmark length');
  });

  // A fake deployment: path → [status, body]. Records each read so the test can see what was fetched.
  function deployment(files: Record<string, [number, string]>) {
    const reads: string[] = [];
    const fetcher = async (url: string, init: RequestInit) => {
      reads.push(url);
      expect(init).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error' });
      const f = files[url.slice(url.lastIndexOf('/') + 1)];
      return f ? new Response(f[1], { status: f[0] }) : new Response('nope', { status: 404 });
    };
    return { reads, fetcher };
  }
  const publish = (version: string, text = `javascript:${encodeURIComponent('void 0')}`, o: { chars?: number; hash?: string } = {}) => ({
    'update.json': [200, JSON.stringify({ schema: 1, version, bookmarkChars: o.chars ?? text.length, bookmarkSha256: o.hash ?? sha(text), minifiedSha256: HEX, builtAt: '' })] as [number, string],
    'bookmark.txt': [200, text] as [number, string],
  });

  test('newer: bookmark text read, length and SHA-256 verified, returned as data', async () => {
    const d = deployment(publish('2.0.0-r9'));
    const r = await checkForUpdate(d.fetcher, 'https://x.test/aw/', '2.0.0-r8');
    expect(r).toMatchObject({ kind: 'newer', manifest: { version: '2.0.0-r9' }, bookmark: 'javascript:void%200' });
    expect(d.reads).toEqual(['https://x.test/aw/update.json', 'https://x.test/aw/bookmark.txt']);
  });

  test('equal and older versions never download the bookmark', async () => {
    for (const [v, kind] of [['2.0.0-r8', 'current'], ['2.0.0-r7', 'older']] as const) {
      const d = deployment(publish(v));
      expect((await checkForUpdate(d.fetcher, 'https://x.test/', '2.0.0-r8')).kind).toBe(kind);
      expect(d.reads).toEqual(['https://x.test/update.json']);
    }
  });

  test('manifest byte limit cancels a multibyte stream and releases its reader', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('界'.repeat(6000))); },
      cancel() { cancelled = true; },
    }));
    const result = await checkForUpdate(async () => response, 'https://x.test/', '2.0.0-r8');
    expect(result).toEqual({ kind: 'error', message: 'Update manifest is larger than expected' });
    expect(cancelled).toBe(true);
    expect(response.body!.locked).toBe(false);
  });

  test('the lifetime owner can cancel a pending update check', async () => {
    const ctl = new AbortController();
    const pending = checkForUpdate(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }), 'https://x.test/', '2.0.0-r8', ctl.signal);
    ctl.abort(new DOMException('Workbench closed', 'AbortError'));
    expect(await pending).toEqual({ kind: 'error', message: 'Workbench closed' });
  });

  test('mismatched hash/length, non-bookmark text, HTTP errors and oversize are refused', async () => {
    const msg = async (files: Record<string, [number, string]>) => {
      const r = await checkForUpdate(deployment(files).fetcher, 'https://x.test/', '2.0.0-r8');
      return r.kind === 'error' ? r.message : r.kind;
    };
    expect(await msg(publish('2.0.0-r9', 'javascript:void 0', { hash: HEX }))).toContain('does not match the manifest SHA-256');
    expect(await msg(publish('2.0.0-r9', 'javascript:void 0', { chars: 99 }))).toContain('the manifest says 99');
    expect(await msg(publish('2.0.0-r9', 'alert(document.cookie)'))).toContain('does not start with javascript:');
    expect(await msg({ 'update.json': [404, ''] })).toBe('Update manifest: HTTP 404');
    expect(await msg({ ...publish('2.0.0-r9'), 'bookmark.txt': [503, ''] })).toBe('Published bookmark: HTTP 503');
    expect(await msg({ 'update.json': [200, ' '.repeat(20_000)] })).toBe('Update manifest is larger than expected');
    const refused = async () => { throw new TypeError('Failed to fetch'); };
    const r = await checkForUpdate(refused, 'https://x.test/', '2.0.0-r8');
    expect(r.kind === 'error' && r.message).toContain('could not be read from this page');
  });
});

test('migration rehearsal regression: a schema 1 static mock without exhaustion converts; a sequence one is not guessed', () => {
  const rule = (mode: string) => ({ id: `r-${mode}`, kind: 'mock', label: mode, enabled: true, matcher: { method: 'GET', url: '/api/x' }, mode, slots: [{ status: 200, headers: '', body: '{}' }] });
  const out = rulesFromV1([rule('static'), rule('sequence')], new Set());
  expect(out.rules.map((r) => [r.id, r.kind === 'mock' && r.exhaustion])).toEqual([['r-static', 'repeat-last']]);
  expect(out.notes.join('\n')).toMatch(/sequence was not converted \(exhaustion/);
});
