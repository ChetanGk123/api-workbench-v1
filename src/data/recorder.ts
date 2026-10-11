// The one recorder: listens to the shared request records (no hook of its own), keeps a bounded,
// redacted draft, and writes a recovery copy. Recovery restores an inactive draft, never capture.
import type { Capture } from '../net/capture';
import type { Runtime } from '../net/runtime';
import { utf8Bytes } from './schema';
import { recovery } from './store';

export const RECORDER = { maxCalls: 100, envelopeBytes: 1024 * 1024, recoverySchema: 1 } as const;

export interface Recorder {
  recording(): boolean;
  startedAt(): number;
  captures(): readonly Capture[];
  bytes(): number;
  includeTester(): boolean;
  setIncludeTester(v: boolean): void;
  /** Why capture stopped by itself (limit), or ''. */
  stopReason(): string;
  /** Saved time of a draft restored from recovery, or 0. */
  recoveredAt(): number;
  /** Last recovery write problem, or ''. */
  recoveryError(): string;
  /** Capture IDs the user deselected in review; kept with the recovery copy. */
  deselected: Set<number>;
  start(): void;
  stop(): void;
  reset(): Promise<void>;
  /** Remove these captures from the draft (after a successful promotion, or a delete). */
  remove(ids: number[]): void;
  saveSelection(): void;
  subscribe(fn: () => void): () => void;
  dispose(): void;
}

export function createRecorder(rt: Runtime): Recorder {
  let list: Capture[] = [];
  let size = 0;
  let started = 0;
  let tester = false;
  let reason = '';
  let recovered = 0;
  let saveErr = '';
  /** Calls from before the last Reset that finish later are ignored. */
  let since = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const subs = new Set<() => void>();
  const changed = () => subs.forEach((f) => f());
  const deselected = new Set<number>();
  const envelope = () => utf8Bytes(JSON.stringify({ schema: RECORDER.recoverySchema, origin: rt.origin, savedAt: Date.now(), captures: [], deselected: [...deselected] }));

  function save() {
    clearTimeout(timer);
    timer = undefined;
    const value = list.length ? { schema: RECORDER.recoverySchema, origin: rt.origin, savedAt: Date.now(), captures: list, deselected: [...deselected] } : null;
    recovery.put(value).then(() => { if (saveErr) { saveErr = ''; changed(); } }, (e: unknown) => {
      saveErr = `Recovery copy not saved (${e instanceof Error ? e.message : String(e)}). The draft is kept in this tab; export it to keep it.`;
      changed();
    });
  }
  const later = () => { clearTimeout(timer); timer = setTimeout(save, 300); };

  rt.onCapture = (rec) => {
    const c = rec.capture;
    if (!c || c.at < since) return;
    if (c.source === 'tester' && !tester) return;
    const n = utf8Bytes(JSON.stringify(c));
    if (list.length >= RECORDER.maxCalls || size + n + envelope() > RECORDER.envelopeBytes) {
      if (rt.capturing) {
        rt.capturing = false;
        reason = list.length >= RECORDER.maxCalls
          ? `Stopped at the ${RECORDER.maxCalls}-call limit. Review or export this draft, then Reset to record more.`
          : `Stopped at the ${RECORDER.envelopeBytes / 1024 / 1024} MiB draft limit. Review or export this draft, then Reset to record more.`;
      }
      changed();
      return;
    }
    list.push(c);
    size += n;
    changed();
    later();
  };

  const r: Recorder = {
    recording: () => rt.capturing,
    startedAt: () => started,
    captures: () => list,
    bytes: () => size,
    includeTester: () => tester,
    setIncludeTester(v) { tester = v; changed(); },
    stopReason: () => reason,
    recoveredAt: () => recovered,
    recoveryError: () => saveErr,
    deselected,
    start() {
      if (rt.capturing) return;
      if (list.length >= RECORDER.maxCalls) { reason = `The draft already holds ${RECORDER.maxCalls} calls. Review or export it, then Reset to record more.`; return changed(); }
      reason = '';
      started = Date.now();
      rt.capturing = true;
      changed();
    },
    stop() {
      if (!rt.capturing) return;
      rt.capturing = false;
      changed();
    },
    async reset() {
      rt.capturing = false;
      since = Date.now();
      clearTimeout(timer);
      timer = undefined;
      // Remove the recovery copy first, so an empty draft on screen is also empty after a reload.
      try { await recovery.put(null); saveErr = ''; } catch (e) { saveErr = `Recovery copy could not be removed (${e instanceof Error ? e.message : String(e)}).`; }
      list = [];
      size = 0;
      reason = '';
      recovered = 0;
      deselected.clear();
      changed();
    },
    remove(ids) {
      const drop = new Set(ids);
      list = list.filter((c) => !drop.has(c.id));
      for (const id of ids) deselected.delete(id);
      size = list.reduce((n, c) => n + utf8Bytes(JSON.stringify(c)), 0);
      if (!list.length) recovered = 0;
      changed();
      save();
    },
    saveSelection: later,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    dispose() {
      rt.capturing = false;
      rt.onCapture = null;
      if (timer) save();
      subs.clear();
    },
  };

  // Restore an inactive draft. Stored data is untrusted: only well-formed calls are kept, within the limits.
  recovery.get().then((raw) => {
    const o = raw as { schema?: unknown; origin?: unknown; savedAt?: unknown; captures?: unknown; deselected?: unknown } | undefined;
    if (!o || o.schema !== RECORDER.recoverySchema || o.origin !== rt.origin || !Array.isArray(o.captures) || list.length) return;
    const ok = o.captures.filter((c): c is Capture => !!c && typeof c === 'object' && typeof (c as Capture).method === 'string' && typeof (c as Capture).url === 'string'
      && Array.isArray((c as Capture).query) && Array.isArray((c as Capture).headers) && !!(c as Capture).body && typeof (c as Capture).body === 'object' && Number.isSafeInteger((c as Capture).id));
    for (const c of ok.slice(0, RECORDER.maxCalls)) {
      const n = utf8Bytes(JSON.stringify(c));
      if (size + n > RECORDER.envelopeBytes) break;
      list.push(c);
      size += n;
    }
    if (Array.isArray(o.deselected)) for (const id of o.deselected) if (typeof id === 'number') deselected.add(id);
    recovered = typeof o.savedAt === 'number' ? o.savedAt : Date.now();
    if (list.length) changed();
  }, (e: unknown) => {
    saveErr = `Recovery is unavailable (${e instanceof Error ? e.message : String(e)}).`;
    changed();
  });

  return r;
}
