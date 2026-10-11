// Result statistics and export. Means use totals over every measured value; P95 is nearest rank
// over the retained samples only, and says when samples were capped. Unavailable is absent, not 0.
import type { RunSummary } from './run';

export const SAMPLE_CAP = 1000;
export interface Stat { n: number; sum: number; min: number | null; max: number | null; samples: number[]; capped: boolean }
export const emptyStat = (): Stat => ({ n: 0, sum: 0, min: null, max: null, samples: [], capped: false });

export function record(s: Stat, ms: number) {
  s.n++;
  s.sum += ms;
  s.min = s.min === null ? ms : Math.min(s.min, ms);
  s.max = s.max === null ? ms : Math.max(s.max, ms);
  if (s.samples.length < SAMPLE_CAP) s.samples.push(ms); else s.capped = true;
}

/** Nearest-rank P95 of retained samples: sorted[ceil(0.95 n) - 1]. */
export function p95(samples: readonly number[]): number | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1]!;
}
export const mean = (s: Stat): number | null => (s.n ? s.sum / s.n : null);

/** Totals across endpoints: sums and counts, never a mean of means. */
export function overall(r: RunSummary, which: 'network' | 'synthetic'): Stat {
  const t = emptyStat();
  for (const e of r.endpoints) {
    const x = e[which];
    t.n += x.n;
    t.sum += x.sum;
    if (x.min !== null) t.min = t.min === null ? x.min : Math.min(t.min, x.min);
    if (x.max !== null) t.max = t.max === null ? x.max : Math.max(t.max, x.max);
    t.samples.push(...x.samples);
    t.capped ||= x.capped;
  }
  return t;
}

export const TIMING = {
  queueMs: 'Wait from the step becoming ready to admission (concurrency slot).',
  headersMs: 'Dispatch to response headers, as the browser reported them.',
  totalMs: 'Dispatch to the end of the owned body read (bounded by the body-check limit).',
  note: 'Browser-local timings from one tab; not server capacity. In Apply rules mode a mock or synthetic reply is counted separately, and network timings can include Workbench delays or pauses.',
} as const;

/** Text cell for CSV: quoted when needed; user-controlled text that a spreadsheet would run as a formula is neutralized. */
export function csvCell(v: string | number | null | undefined, user = false): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (user && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const round = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

export function toCsv(r: RunSummary): string {
  const head = ['endpoint', 'alias', 'method', 'passed', 'failed-check', 'network-error', 'timeout', 'aborted', 'skipped-dependency', 'skipped-condition', 'blocked-before-dispatch',
    'network samples', 'network mean ms', 'network min ms', 'network max ms', 'network p95 ms', 'p95 samples capped', 'synthetic samples', 'synthetic mean ms'];
  const rows = r.endpoints.map((e) => [
    csvCell(e.name, true), csvCell(e.alias, true), e.method,
    ...(['passed', 'failed-check', 'network-error', 'timeout', 'aborted', 'skipped-dependency', 'skipped-condition', 'blocked-before-dispatch'] as const).map((k) => String(e.counts[k])),
    String(e.network.n), csvCell(round(mean(e.network))), csvCell(e.network.min), csvCell(e.network.max), csvCell(p95(e.network.samples)), e.network.capped ? 'yes' : 'no',
    String(e.synthetic.n), csvCell(round(mean(e.synthetic))),
  ].join(','));
  return [head.join(','), ...rows].join('\r\n') + '\r\n';
}

/** JSON export: identities, outcomes, timing definitions and what was redacted or dropped. */
export function toJson(r: RunSummary): string {
  return JSON.stringify({
    format: 'api-workbench-run', schema: r.schema,
    run: { id: r.id, kind: r.kind, state: r.state, startedAt: new Date(r.startedAt).toISOString(), endedAt: r.endedAt ? new Date(r.endedAt).toISOString() : null },
    plan: { id: r.planId, name: r.planName, strategy: r.strategy, mode: r.mode, iterations: r.iterations, concurrency: r.concurrency },
    profile: { id: r.profileId, name: r.profileName, configRevision: r.configRevision },
    timing: TIMING,
    redaction: 'No request header values or query values are kept. Sample response headers whose names look sensitive are removed; JSON keys such as token/secret/password/session in samples are masked.',
    preflight: r.preflight, progress: r.progress, counts: r.counts, dispatched: r.dispatched,
    endpoints: r.endpoints.map((e) => ({ endpointId: e.endpointId, name: e.name, alias: e.alias, method: e.method, counts: e.counts,
      network: { samples: e.network.n, meanMs: round(mean(e.network)), minMs: e.network.min, maxMs: e.network.max, p95Ms: p95(e.network.samples), p95RetainedSamples: e.network.samples.length, capped: e.network.capped },
      synthetic: { samples: e.synthetic.n, meanMs: round(mean(e.synthetic)) } })),
    steps: r.steps, stepsDropped: r.stepsDropped, attempts: r.attempts, attemptsDropped: r.attemptsDropped, samples: r.samples, notes: r.notes,
  }, null, 2);
}
