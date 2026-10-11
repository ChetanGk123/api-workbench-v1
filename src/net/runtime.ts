// Runtime state shared by the adapters: config pointer, bounded records, owned waits and body slots.
import { forbiddenHeader, utf8Bytes, type InterceptRule } from '../data/schema';
import type { Capture } from './capture';
import { freshState, LIMITS, MODULES, ruleName, type Config, type Op, type Part, type Plan, type RuleStates, type Transport } from './plan';

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

export type Stage = 'request' | 'response';
/** What a pause shows and an edit may change. Copies only: the held work is never touched by the UI. */
export interface PauseView {
  /** Request stage: the URL that would be sent. */
  url?: string;
  /** Response stage: the status that would be delivered. */
  status?: number;
  headers: [string, string][];
  /** Editable text, or why the body is metadata only. */
  body: { text: string } | { reason: string };
  /** Set when nothing may be edited; Continue then sends/delivers the held work unchanged. */
  locked?: string;
}
export type Decision = { kind: 'continue'; edit: PauseView } | { kind: 'original' } | { kind: 'abort' };
/** waiting, then exactly one terminal state. */
export type PauseState = 'waiting' | 'continued' | 'original' | 'aborted' | 'expired' | 'cancelled' | 'released';
export interface Pause {
  readonly id: number;
  readonly rec: ReqRecord;
  readonly stage: Stage;
  readonly ruleId: string;
  readonly rule: string;
  /** Rule action revision and config revision when the request started; later edits make the pause stale, never change it. */
  readonly ruleRevision: number;
  readonly createdAt: number;
  readonly deadline: number;
  readonly held: Readonly<PauseView>;
  state: PauseState;
  endedAt?: number;
  /** Readable terminal outcome. */
  outcome?: string;
}

export interface Prefs { records: number; responseBodies: boolean }

export interface Runtime {
  readonly origin: string;
  inert: boolean;
  /** Recorder on: adapters build a capture for each new call. */
  capturing: boolean;
  /** Profile settings the adapters read at intake (R8). */
  readonly prefs: Readonly<Prefs>;
  /** Apply new settings; a lower record limit drops the oldest records now. */
  setPrefs(p: Prefs): void;
  /** Called once per captured call when its capture is complete (response preview read or skipped). */
  onCapture: ((rec: ReqRecord) => void) | null;
  /** Run `fn` with calls it starts synchronously labelled as tester traffic. */
  /** Run fn as tester traffic; onRecord receives the record its request creates (rules mode). */
  asTester<T>(fn: () => T, onRecord?: (rec: ReqRecord) => void): T;
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
  /**
   * Hold a real request/response until a decision, the deadline (original continues), Close
   * (original continues) or the caller's abort (rejects with its reason). Over the cap: original at once.
   */
  pause(rec: ReqRecord, stage: Stage, rule: InterceptRule, held: PauseView, signal?: AbortSignal | null): Promise<Decision>;
  /** Waiting pauses, then the latest ended ones (newest first). */
  pauses(): readonly Pause[];
  /** First decision wins. Returns null when applied, or why it was not (already ended). */
  decide(id: number, d: Decision): string | null;
  /** Continue every waiting pause unchanged (Stop all, profile switch). Returns how many. */
  releasePauses(why: string): number;
}

export function createRuntime(origin: string, initial: Config): Runtime {
  let cfg = initial;
  let nextId = 1;
  const list: ReqRecord[] = [];
  const subs = new Set<() => void>();
  const pending = new Set<() => void>();
  let bodySlots = 0;
  let tester: false | { on?: ((rec: ReqRecord) => void) | undefined } = false;
  let children = 0;
  const states: RuleStates = new Map();
  const changed = () => subs.forEach((fn) => fn());
  let nextPause = 1;
  const waiting = new Map<number, { p: Pause; settle(state: PauseState, d: Decision | null, outcome: string): void }>();
  const ended: Pause[] = [];

  const rt: Runtime = {
    origin,
    inert: false,
    capturing: false,
    prefs: { records: LIMITS.records, responseBodies: true },
    setPrefs(p) {
      if (p.records === rt.prefs.records && p.responseBodies === rt.prefs.responseBodies) return;
      (rt as { prefs: Prefs }).prefs = { ...p };
      if (list.length > p.records) list.splice(0, list.length - p.records);
      changed();
    },
    onCapture: null,
    asTester(fn, onRecord) {
      tester = { on: onRecord };
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
      if (tester && !parent) { const on = tester.on; tester = false; on?.(rec); } // only the first record is the tester's
      list.push(rec);
      if (list.length > rt.prefs.records) list.splice(0, list.length - rt.prefs.records);
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
    pause(rec, stage, rule, held, signal) {
      const part: Part = stage === 'request' ? 'request-pause' : 'response-pause';
      const keep = (why: string) => { rt.op(rec, 'intercept', 'skipped', why, part); return Promise.resolve<Decision>({ kind: 'original' }); };
      if (rt.inert) return keep('Workbench closed; not paused');
      if (waiting.size >= LIMITS.pauses) return keep(`${LIMITS.pauses} requests are already paused (cap); not paused`);
      if (signal?.aborted) return Promise.reject(signal.reason);
      const now = performance.now();
      const p: Pause = {
        id: nextPause++, rec, stage, ruleId: rule.id, rule: ruleName(rule), ruleRevision: rule.revision,
        createdAt: now, deadline: now + LIMITS.pauseDeadlineMs, held: Object.freeze(structuredClone(held)), state: 'waiting',
      };
      return new Promise<Decision>((resolve, reject) => {
        const settle = (state: PauseState, d: Decision | null, outcome: string) => {
          if (p.state !== 'waiting') return;
          p.state = state;
          p.endedAt = performance.now();
          p.outcome = outcome;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          release();
          waiting.delete(p.id);
          ended.unshift(p);
          if (ended.length > LIMITS.pauses) ended.length = LIMITS.pauses;
          rt.op(rec, 'intercept', 'applied', `Paused ${((p.endedAt - p.createdAt) / 1000).toFixed(1)} s; ${outcome}`, part);
          if (d) resolve(d); else reject(signal!.reason);
        };
        const onAbort = () => settle('cancelled', null, stage === 'request' ? 'the caller aborted; nothing was sent' : 'the caller aborted; the response was not delivered (upstream effects stand)');
        const timer = setTimeout(() => settle('expired', { kind: 'original' }, `${LIMITS.pauseDeadlineMs / 1000} s deadline reached; ${stage === 'request' ? 'original request sent' : 'original response delivered'}`), LIMITS.pauseDeadlineMs);
        const release = rt.own(() => settle('released', { kind: 'original' }, `Workbench closed; ${stage === 'request' ? 'original request sent' : 'original response delivered'}`));
        signal?.addEventListener('abort', onAbort, { once: true });
        waiting.set(p.id, { p, settle });
        rt.op(rec, 'intercept', 'applied', `Paused ${stage === 'request' ? 'before sending' : 'before delivery (the server already received the request)'}; waiting for a decision`, part);
      });
    },
    pauses: () => [...[...waiting.values()].map((w) => w.p), ...ended],
    decide(id, d) {
      const w = waiting.get(id);
      if (!w) {
        const p = ended.find((x) => x.id === id);
        return p ? `Pause #${id} already ended: ${p.outcome}` : `Pause #${id} is no longer retained`;
      }
      const st = w.p.stage;
      if (d.kind === 'continue' && w.p.held.locked) d = { kind: 'original' };
      if (d.kind === 'continue') {
        const bad = checkEdit(st, d.edit);
        if (bad) return bad;
      }
      if (d.kind === 'abort') w.settle('aborted', d, st === 'request' ? 'aborted by you; nothing was sent' : 'aborted by you; the response was not delivered (upstream effects stand)');
      else if (d.kind === 'original') w.settle('original', d, st === 'request' ? 'continued unchanged' : 'original response delivered');
      else {
        const changes = diffView(w.p.held, d.edit);
        w.settle('continued', d, changes.length ? `continued with edits: ${changes.join(', ')}` : 'continued unchanged');
      }
      return null;
    },
    releasePauses(why) {
      const list = [...waiting.values()];
      for (const w of list) w.settle('released', { kind: 'original' }, `${why}; ${w.p.stage === 'request' ? 'original request sent' : 'original response delivered'}`);
      return list.length;
    },
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

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** First problem with a pause edit, or null. The pause stays waiting while an edit is invalid. */
export function checkEdit(stage: Stage, e: PauseView): string | null {
  if (stage === 'request') {
    let u: URL;
    try { u = new URL(e.url ?? ''); } catch { return 'URL: enter an absolute http(s) URL'; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'URL: only http and https can be sent';
  } else if (!Number.isInteger(e.status) || e.status! < 200 || e.status! > 599) return 'Status: enter a whole number from 200 to 599';
  for (const [k, v] of e.headers) {
    if (!TOKEN.test(k)) return `Header "${k}": names are letters, digits and - _ . etc.`;
    if (/[\r\n\0]/.test(v)) return `Header ${k}: values cannot contain line breaks`;
    if (stage === 'request' && forbiddenHeader(k)) return `Header ${k}: the browser does not let scripts set it`;
    if (stage === 'response' && /^set-cookie2?$/i.test(k)) return 'Set-Cookie cannot be set by a script reply';
  }
  if ('text' in e.body && utf8Bytes(e.body.text) > LIMITS.bodyBytes) return `Body: limited to ${LIMITS.bodyBytes} bytes`;
  return null;
}

const sorted = (h: [string, string][]) => JSON.stringify(h.map(([k, v]) => [k.toLowerCase(), v]).sort());
export const sameHeaders = (a: [string, string][], b: [string, string][]) => sorted(a) === sorted(b);

/** Names of the parts an edit changes, for the operation reason. */
export function diffView(a: PauseView, b: PauseView): string[] {
  const out: string[] = [];
  if (a.url !== b.url) out.push('URL');
  if (a.status !== b.status) out.push(`status ${a.status} → ${b.status}`);
  if (!sameHeaders(a.headers, b.headers)) out.push('headers');
  if ('text' in a.body && 'text' in b.body && a.body.text !== b.body.text) out.push('body');
  return out;
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
