// Runtime state shared by the adapters: config pointer, bounded records, owned waits and body slots.
import type { Capture } from './capture';
import { freshState, LIMITS, MODULES, type Config, type Op, type Part, type Plan, type RuleStates, type Transport } from './plan';

export type Outcome = 'pending' | 'ok' | 'error' | 'aborted' | 'timeout';

export interface ReqRecord {
  readonly id: number;
  /** Replay copies point at the request they copy; they never enter rule selection. */
  readonly parentId?: number;
  readonly transport: Transport;
  readonly method: string;
  /** origin + path; query values are never stored. */
  readonly url: string;
  readonly hasQuery: boolean;
  readonly revision: number;
  readonly provider: Plan['provider'];
  readonly startedAt: number;
  /** tester = sent by Test → Once with Apply rules; replay = a chaos copy; page = everything else. */
  readonly source: 'page' | 'tester' | 'replay';
  /** Present only when the recorder was on at intake. Redacted as it is built. */
  capture?: Capture;
  finalUrl?: string;
  responseType?: string;
  /** Operations with `at`: ms after start when the state last changed (absent = decided at intake). */
  ops: (Op & { at?: number })[];
  outcome: Outcome;
  status?: number;
  elapsedMs?: number;
  notes: string[];
}

export interface Runtime {
  readonly origin: string;
  inert: boolean;
  /** Recorder on: adapters build a capture for each new call. */
  capturing: boolean;
  /** Called once per captured call when its capture is complete (response preview read or skipped). */
  onCapture: ((rec: ReqRecord) => void) | null;
  /** Run `fn` with calls it starts synchronously labelled as tester traffic. */
  asTester<T>(fn: () => T): T;
  /** Mark a record's capture complete and hand it to the recorder. */
  captured(rec: ReqRecord): void;
  config(): Config;
  /** Install a new config; resets per-rule state for newly activated modules and changed action revisions. */
  setConfig(next: Omit<Config, 'revision'>): void;
  /** Sequence cursors, chaos samples and budgets. Runtime only. */
  readonly states: RuleStates;
  start(transport: Transport, method: string, url: URL, plan: Plan, parent?: ReqRecord): ReqRecord;
  op(rec: ReqRecord, module: Op['module'], state: Op['state'], reason?: string, part?: Part): void;
  /** Replay copy slot; null when the global in-flight limit is reached. */
  acquireChild(): (() => void) | null;
  note(rec: ReqRecord, text: string): void;
  finish(rec: ReqRecord, outcome: Outcome, status?: number): void;
  records(): readonly ReqRecord[];
  clearRecords(): void;
  subscribe(fn: () => void): () => void;
  /** Owned delay. Rejects with the signal's reason on abort; resolves at once when settleAll runs. */
  wait(ms: number, signal?: AbortSignal | null): Promise<void>;
  /** Register owned pending work that must settle promptly on Close. */
  own(settle: () => void): () => void;
  settleAll(): void;
  /** Bounded body slot; null when all slots are busy. */
  acquireBodySlot(): (() => void) | null;
  activeBodySlots(): number;
}

export function createRuntime(origin: string, initial: Config): Runtime {
  let cfg = initial;
  let nextId = 1;
  const list: ReqRecord[] = [];
  const subs = new Set<() => void>();
  const pending = new Set<() => void>();
  let bodySlots = 0;
  let tester = false;
  let children = 0;
  const states: RuleStates = new Map();
  const changed = () => subs.forEach((fn) => fn());

  const rt: Runtime = {
    origin,
    inert: false,
    capturing: false,
    onCapture: null,
    asTester(fn) {
      tester = true;
      try { return fn(); } finally { tester = false; }
    },
    captured(rec) {
      if (rec.capture && rec.capture.outcome === 'pending') rec.capture.outcome = rec.outcome;
      rt.onCapture?.(rec);
    },
    config: () => cfg,
    states,
    setConfig(next) {
      const now = performance.now();
      const ids = new Set(next.rules.map((r) => r.id));
      for (const id of states.keys()) if (!ids.has(id)) states.delete(id);
      for (const r of next.rules) {
        const s = states.get(r.id);
        if (!s || s.revision !== r.revision || (next.active[r.kind] && !cfg.active[r.kind])) states.set(r.id, freshState(r, now));
      }
      for (const m of MODULES) if (!next.active[m] && cfg.active[m]) for (const r of next.rules) if (r.kind === m) states.delete(r.id);
      cfg = Object.freeze({ ...next, revision: cfg.revision + 1 });
      changed();
    },
    start(transport, method, url, plan, parent) {
      const rec: ReqRecord = {
        id: nextId++,
        transport,
        method,
        url: url.origin + url.pathname,
        hasQuery: url.search.length > 1,
        revision: plan.revision,
        provider: plan.provider,
        startedAt: performance.now(),
        source: parent ? 'replay' : tester ? 'tester' : 'page',
        ops: plan.ops.map((o) => ({ ...o })),
        outcome: 'pending',
        notes: plan.notes.slice(0, LIMITS.eventsPerRecord),
        ...(parent && { parentId: parent.id }),
      };
      if (plan.route) rec.finalUrl = plan.route.to.origin + plan.route.to.pathname;
      list.push(rec);
      if (list.length > LIMITS.records) list.splice(0, list.length - LIMITS.records);
      changed();
      return rec;
    },
    op(rec, module, state, reason, part) {
      const o = rec.ops.find((x) => x.module === module && x.part === part);
      if (!o) return;
      o.state = state;
      if (reason) o.reason = reason;
      o.at = Math.round(performance.now() - rec.startedAt);
      changed();
    },
    note(rec, text) {
      if (rec.notes.length < LIMITS.eventsPerRecord) rec.notes.push(text.slice(0, 512));
      changed();
    },
    finish(rec, outcome, status) {
      if (rec.outcome !== 'pending') return;
      rec.outcome = outcome;
      if (status !== undefined) rec.status = status;
      rec.elapsedMs = Math.round(performance.now() - rec.startedAt);
      // Anything still only "selected" never took effect.
      for (const o of rec.ops) if (o.state === 'selected') { o.state = 'skipped'; o.reason = `Not applied: request ended (${outcome})`; o.at = rec.elapsedMs; }
      changed();
    },
    records: () => list,
    clearRecords() {
      list.length = 0;
      changed();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    wait(ms, signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          release();
        };
        const onAbort = () => {
          done();
          reject(signal!.reason);
        };
        const release = rt.own(() => {
          done();
          resolve();
        });
        const timer = setTimeout(() => {
          done();
          resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    own(settle) {
      pending.add(settle);
      return () => pending.delete(settle);
    },
    settleAll() {
      for (const settle of [...pending]) settle();
      pending.clear();
    },
    acquireBodySlot() {
      if (bodySlots >= LIMITS.bodyConcurrency) return null;
      bodySlots++;
      let released = false;
      return () => {
        if (!released) { released = true; bodySlots--; }
      };
    },
    activeBodySlots: () => bodySlots,
    acquireChild() {
      if (children >= LIMITS.replayInFlight) return null;
      children++;
      let released = false;
      return () => {
        if (!released) { released = true; children--; }
      };
    },
  };
  return rt;
}

/** Read a stream we own, bounded by bytes and time. Cancels only this stream on failure. */
export async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  deadlineMs: number,
  own: Runtime['own'],
): Promise<{ ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; reason: string }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let stop: string | null = null;
  const halt = (why: string) => {
    if (stop) return;
    stop = why;
    reader.cancel(why).catch(() => {});
  };
  const timer = setTimeout(() => halt(`Body not complete within ${deadlineMs} ms`), deadlineMs);
  const release = own(() => halt('Workbench closed'));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (stop) return { ok: false, reason: stop };
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        halt(`Body exceeds ${maxBytes} bytes`);
        return { ok: false, reason: stop! };
      }
      chunks.push(value);
    }
  } catch (e) {
    return { ok: false, reason: stop ?? `Body read failed: ${String(e)}` };
  } finally {
    clearTimeout(timer);
    release();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return { ok: true, bytes: out };
}
