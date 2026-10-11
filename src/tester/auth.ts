// Runtime auth coordinator: one pending refresh per auth context, outputs installed atomically into
// a transient overlay (never into page storage, never persisted), and session-only signing keys.
import type { Aggregate, AuthContext, SourceRef } from '../data/schema';
import { asText, parseExact, readSource, walk, type Sources } from './expr';
import { prepare, send, type OnceResult, type Prepared, type Transport } from './once';

export interface RefreshAttempt { contextId: string; endpointId: string; prepared: Prepared | null; result: OnceResult | null; error: string | null; ms: number }

export interface AuthCoordinator {
  /** Page sources with this context's refreshed values first. */
  sources(ctx: AuthContext, base: Sources): Sources;
  /**
   * Refresh a context, sharing one in-flight refresh among all callers. Resolves null on success or
   * the failure reason. A caller's abort releases only that caller; nothing is retried later.
   */
  refresh(ctx: AuthContext, signal: AbortSignal, o?: { admit?: (s: AbortSignal) => Promise<() => void>; report?: (a: RefreshAttempt) => void }): Promise<string | null>;
  status(ctx: AuthContext): { refreshing: boolean; lastError: string | null; installed: number; refreshes: number };
  /** Session keys by recipe key reference. */
  keys: Map<string, CryptoKey>;
  /** Profile switch / Close: drop every transient value and key. */
  clear(): void;
}

const slot = (r: SourceRef) => `${r.kind}:${r.key}${r.mode ? `:${r.mode}` : ''}`;

export function createAuth(deps: { agg(): Aggregate; pageOrigin: string; base(): Sources; transport: Transport; limit(): number }): AuthCoordinator {
  /** Refreshed value per source slot, with what the page source held when it was installed. */
  const overlay = new Map<string, Map<string, { value: string; page: string | undefined }>>();
  const pending = new Map<string, Promise<string | null>>();
  const errors = new Map<string, string | null>();
  const counts = new Map<string, number>();
  const keys = new Map<string, CryptoKey>();
  let generation = 0;

  // The newest value wins: a refreshed value is used until the page's own source changes (for example
  // the application signs in again), then the page value is used.
  const sources = (ctx: AuthContext, base: Sources): Sources => {
    const o = overlay.get(ctx.id);
    if (!o?.size) return base;
    const pick = (ref: SourceRef): string | undefined => {
      const page = readSource(base, ref);
      const x = o.get(slot(ref));
      return x && x.page === page ? x.value : page;
    };
    return {
      cookie: (k) => pick({ kind: 'cookie', key: k }),
      localStorage: (k) => pick({ kind: 'localStorage', key: k }),
      sessionStorage: (k) => pick({ kind: 'sessionStorage', key: k }),
      meta: (k) => pick({ kind: 'meta', key: k }),
      dom: (k, m) => pick({ kind: 'dom', key: k, mode: m as NonNullable<SourceRef['mode']> }),
    };
  };

  async function run(ctx: AuthContext, o: { admit?: (s: AbortSignal) => Promise<() => void>; report?: (a: RefreshAttempt) => void }): Promise<string | null> {
    const gen = generation;
    const agg = deps.agg();
    const def = ctx.refresh!;
    const ep = agg.endpoints.find((e) => e.id === def.endpointId);
    if (!ep) return 'Refresh endpoint no longer exists';
    // The refresh request never re-enters its own context (no refresh loop).
    const { authContextId: _drop, ...plain } = ep;
    const p = prepare(agg, plain, deps.pageOrigin, sources(ctx, deps.base()), new Map());
    const started = performance.now();
    const report = (result: OnceResult | null, error: string | null) => { o.report?.({ contextId: ctx.id, endpointId: ep.id, prepared: p, result, error, ms: Math.round(performance.now() - started) }); return error; };
    if (p.blocked.length) return report(null, `Refresh ${ep.name} is blocked: ${p.blocked[0]}`);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), def.deadlineMs);
    let release = () => {};
    try {
      if (o.admit) release = await o.admit(ctl.signal);
      counts.set(ctx.id, (counts.get(ctx.id) ?? 0) + 1);
      const res = await send(p, deps.transport, ctl.signal, deps.limit());
      if (res.outcome === 'aborted') return report(res, `Refresh ${ep.name} exceeded its ${def.deadlineMs} ms deadline`);
      if (res.outcome !== 'response') return report(res, `Refresh ${ep.name}: ${res.error ?? 'no HTTP response'}`);
      if (res.status! < 200 || res.status! > 299) return report(res, `Refresh ${ep.name} returned HTTP ${res.status}`);
      if (res.body.state !== 'complete') return report(res, `Refresh ${ep.name}: body is ${res.body.state}`);
      let doc: unknown;
      try { doc = parseExact(res.body.text); } catch { return report(res, `Refresh ${ep.name}: response is not valid JSON`); }
      const next = new Map(overlay.get(ctx.id));
      for (const out of def.outputs) {
        const at = walk(doc, out.path.replace(/^\$\.?/, '').match(/[^.[\]]+|\[\d+\]/g)?.map((s) => (s.startsWith('[') ? Number(s.slice(1, -1)) : s)) ?? []);
        if (!at.found) return report(res, `Refresh ${ep.name}: ${out.path} is not in the response`);
        try { next.set(slot(out.target), { value: asText(at.value), page: readSource(deps.base(), out.target) }); } catch { return report(res, `Refresh ${ep.name}: ${out.path} is not a single value`); }
      }
      if (gen !== generation) return report(res, 'Profile changed during refresh; values discarded');
      overlay.set(ctx.id, next); // every output at once, or none
      return report(res, null);
    } catch (e) {
      return report(null, ctl.signal.aborted ? `Refresh ${ep.name} exceeded its ${def.deadlineMs} ms deadline` : String((e as Error)?.message ?? e));
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  return {
    sources,
    keys,
    refresh(ctx, signal, o = {}) {
      if (!ctx.refresh) return Promise.resolve('No refresh is configured for this auth context');
      if (signal.aborted) return Promise.reject(new DOMException('Stopped', 'AbortError'));
      let p = pending.get(ctx.id);
      if (!p) {
        p = run(ctx, o).then((err) => { errors.set(ctx.id, err); return err; }).finally(() => pending.delete(ctx.id));
        pending.set(ctx.id, p);
      }
      const shared = p;
      return new Promise((resolve, reject) => {
        const off = () => reject(new DOMException('Stopped', 'AbortError'));
        signal.addEventListener('abort', off, { once: true });
        shared.then((v) => { signal.removeEventListener('abort', off); resolve(v); });
      });
    },
    status: (ctx) => ({ refreshing: pending.has(ctx.id), lastError: errors.get(ctx.id) ?? null, installed: overlay.get(ctx.id)?.size ?? 0, refreshes: counts.get(ctx.id) ?? 0 }),
    clear() {
      generation++;
      overlay.clear();
      errors.clear();
      counts.clear();
      keys.clear();
    },
  };
}
