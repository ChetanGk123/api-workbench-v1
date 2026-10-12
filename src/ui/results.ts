// Test → Results: run registry (live runs + stored summaries), progress, outcome categories,
// per-endpoint timings, logical steps with attempts, samples, JSON/CSV export and Run again.
import { BOUNDS, type Plan } from '../data/schema';
import { runStore } from '../data/store';
import type { AuthCoordinator } from '../tester/auth';
import { pageSources } from '../tester/once';
import { OUTCOMES, startRun, type ReqOutcome, type RunHandle, type RunSummary, type StepRow } from '../tester/run';
import { mean, overall, p95, p99, TIMING, toCsv, toJson, type Stat } from '../tester/stats';
import { h, icon } from './dom';
import { btn, download, flash, methodBadge, section, type Kit } from './kit';

export interface RunEntry { summary: RunSummary; handle?: RunHandle; stored: boolean }

const LABEL: Record<ReqOutcome, string> = {
  passed: 'Passed', 'failed-check': 'Failed check', 'network-error': 'Network error', timeout: 'Timeout', aborted: 'Aborted',
  'skipped-dependency': 'Skipped (dependency)', 'skipped-condition': 'Skipped (condition)', 'blocked-before-dispatch': 'Blocked before dispatch',
};
const TONE: Record<ReqOutcome, string> = { passed: 'aw-gr', 'failed-check': 'aw-rd', 'network-error': 'aw-rd', timeout: 'aw-rd', aborted: 'aw-am', 'skipped-dependency': 'aw-am', 'skipped-condition': '', 'blocked-before-dispatch': 'aw-am' };
/** Characters shown in a response box (like Once); Copy response always copies everything. */
const SHOW_CHARS = 64 * 1024;
const ms = (n: number | null) => (n === null ? '—' : `${Math.round(n)} ms`);
/** Latency colour: green under 300 ms, amber to 1000 ms, red above. */
const speed = (n: number | null) => (n === null ? 'aw-t-mu' : n < 300 ? 'aw-t-ok' : n < 1000 ? 'aw-t-warn' : 'aw-t-bad');
/** Count colour: zero is muted, otherwise the outcome's tone. */
const tally = (n: number, tone: string) => (n ? tone : 'aw-t-mu');
const OUTCOME_TONE: Record<ReqOutcome, string> = { passed: 'aw-t-ok', 'failed-check': 'aw-t-bad', 'network-error': 'aw-t-bad', timeout: 'aw-t-bad', aborted: 'aw-t-warn', 'skipped-dependency': 'aw-t-warn', 'skipped-condition': 'aw-t-mu', 'blocked-before-dispatch': 'aw-t-warn' };

export function createRuns(kit: Kit, auth: AuthCoordinator, onChange: () => void) {
  const s = kit.session;
  const entries: RunEntry[] = [];
  let loadedFor = '';
  const subs = new Map<string, () => void>();

  async function load() {
    const pid = s.agg().profile.id;
    if (loadedFor === pid) return;
    loadedFor = pid;
    try {
      const stored = (await runStore.list()) as RunSummary[];
      for (const r of stored.filter((x) => x && x.profileId === pid && x.schema === 2)) if (!entries.some((e) => e.summary.id === r.id)) entries.push({ summary: r, stored: true });
      entries.sort((a, b) => b.summary.startedAt - a.summary.startedAt);
      onChange();
    } catch { kit.announce('Stored run summaries could not be read; live runs still work.'); }
  }

  function start(plan: Plan, once: boolean, agg = s.agg()): RunHandle {
    const handle = startRun({
      agg, plan, once, pageOrigin: kit.rt.origin, sources: pageSources,
      transport: plan.mode === 'direct' ? kit.fetchers.direct : kit.fetchers.rules,
      auth, limit: agg.profile.settings.bodyCheckKb * 1024,
    });
    const e: RunEntry = { summary: handle.summary, handle, stored: false };
    entries.unshift(e);
    let frame = 0;
    subs.set(handle.id, handle.subscribe(() => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; onChange(); }); }));
    handle.done.then(async (sum) => {
      subs.get(handle.id)?.();
      subs.delete(handle.id);
      onChange();
      const text = `${sum.planName} ${sum.kind === 'once' ? 'one pass' : 'Load'} ${sum.state}: ${summaryLine(sum)}`;
      kit.announce(text);
      if (plan.notify !== 'off') notify(plan, text, handle.id);
      if (sum.state === 'failed-preflight' || !entries.includes(e)) return;
      try {
        const removed = await runStore.put(sum.id, structuredClone(sum));
        e.stored = true;
        if (removed) kit.announce(`${removed} older run summar${removed === 1 ? 'y was' : 'ies were'} removed (keeps 20 / 2 MiB).`);
      } catch { kit.announce('Run summary kept for this page session only: storage failed.'); }
      onChange();
    });
    while (entries.length > 40) entries.pop();
    onChange();
    return handle;
  }

  function notify(plan: Plan, text: string, id: string) {
    if (plan.notify === 'browser' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { new Notification('API Workbench', { body: text }); return; } catch { /* fall back to the panel */ }
    }
    kit.notice(plan.notify === 'browser' ? `${text} (browser notifications are not permitted, so this notice is shown here)` : text, { label: 'View run', run: () => kit.showRun(id) });
  }

  return {
    entries: () => entries,
    find: (id: string) => entries.find((e) => e.summary.id === id),
    load,
    start,
    running: () => entries.filter((e) => e.handle && !e.summary.endedAt && e.summary.state === 'running'),
    /** Profile switch / Close: stop owned runs; nothing from the old profile keeps running. */
    stopAll(why: string) {
      for (const e of entries) if (e.handle && !e.summary.endedAt) e.handle.stop(why);
    },
    reset() { entries.length = 0; loadedFor = ''; },
  };
}
export type Runs = ReturnType<typeof createRuns>;

export function summaryLine(r: RunSummary): string {
  const parts = OUTCOMES.filter((o) => r.counts[o]).map((o) => `${r.counts[o]} ${LABEL[o].toLowerCase()}`);
  return `${r.progress.done}/${r.progress.total} steps${parts.length ? ` · ${parts.join(', ')}` : ''}`;
}

/** Results view for one run (or the latest), with history beside it. */
export function resultsNodes(kit: Kit, runs: Runs, selected: () => string | null, select: (id: string) => void, runAgain: (e: RunEntry) => void): { nodes: Node[]; refresh(): void } {
  const historyEl = h('div', { class: 'aw-col aw-gap6' });
  const detail = h('div', { class: 'aw-col aw-gap12', 'aria-live': 'off' });
  let shown = '';
  let shownList = '';
  const openSteps = new Set<string>();

  const refresh = () => {
    const list = runs.entries();
    const cur = (selected() && runs.find(selected()!)) || list[0];
    const listSig = list.map((e) => `${e.summary.id}:${e.summary.state}:${e.summary.progress.done}`).join('|') + (cur?.summary.id ?? '');
    if (listSig !== shownList) {
      shownList = listSig;
      historyEl.replaceChildren(...(list.length ? [h('ol', { class: 'aw-card aw-list', 'aria-label': 'Run history, newest first' }, ...list.slice(0, 20).map((e) => {
        const r = e.summary;
        const b = btn([h('span', { class: `aw-bd ${r.state === 'completed' ? 'aw-gr' : r.state === 'running' ? 'aw-bl' : 'aw-am'}` }, r.state), h('span', { class: 'aw-grow aw-tr' }, `${r.planName} · ${r.kind === 'once' ? 'one pass' : `Load ${r.strategy} ${r.iterations}×${r.concurrency}`}`), h('span', { class: 'aw-xs aw-mu' }, new Date(r.startedAt).toLocaleTimeString())],
          () => { select(r.id); refresh(); }, `aw-li aw-actrow${e === cur ? ' aw-on' : ''}`, { 'aria-current': e === cur ? 'true' : undefined, 'data-key': `run-${r.id}`, 'aria-label': `${r.planName} ${r.kind} ${r.state} at ${new Date(r.startedAt).toLocaleTimeString()}${e.handle ? '' : ' (stored summary)'}` });
        return h('li', {}, b);
      }))] : [h('div', { class: 'aw-empty aw-wrap' }, 'No runs yet. Run a plan from Plans.')]));
    }
    const sig = cur ? `${cur.summary.id}|${cur.summary.state}|${cur.summary.progress.done}|${cur.summary.attempts.length}|${cur.summary.endedAt ?? ''}|${cur.stored}` : '';
    if (sig === shown) return;
    shown = sig;
    // Keep expanded step details and focus while live progress redraws.
    detail.querySelectorAll('details[open][data-step]').forEach((d) => openSteps.add(d.getAttribute('data-step')!));
    const focusKey = kit.root.activeElement?.closest?.('[data-key]')?.getAttribute('data-key');
    detail.replaceChildren(...(cur ? runDetail(cur) : []));
    if (focusKey) detail.querySelector<HTMLElement>(`[data-key="${focusKey}"]`)?.focus();
  };

  function statText(x: Stat) {
    return x.n ? `${x.n} measured · mean ${ms(mean(x))} · min ${ms(x.min)} · max ${ms(x.max)} · P95 ${ms(p95(x.samples))} over ${x.samples.length} retained${x.capped ? ' (capped)' : ''}` : 'none';
  }

  function runDetail(e: RunEntry): Node[] {
    const r = e.summary;
    const live = !!e.handle && !r.endedAt;
    const net = overall(r, 'network'), syn = overall(r, 'synthetic');
    const tile = (label: string, value: Node, extra: Record<string, string> = {}) => h('div', { class: 'aw-card aw-cp aw-col aw-gap4 aw-tile2', ...extra }, h('span', { class: 'aw-xs aw-mu' }, label), value);
    const latency = (label: string, v: number | null) => tile(label, h('span', { class: `aw-big ${speed(v)}` }, v === null ? '—' : String(Math.round(v)), h('span', { class: 'aw-unit' }, 'ms')));
    const tiles = OUTCOMES.filter((o) => o === 'passed' || o === 'failed-check' || r.counts[o]).map((o) =>
      tile(LABEL[o], h('span', { class: `aw-big ${o === 'passed' || o === 'failed-check' ? OUTCOME_TONE[o] : tally(r.counts[o], OUTCOME_TONE[o])}`, 'data-outcome': o }, String(r.counts[o]))));
    const latencies = [latency('Avg latency', mean(net)), latency('P95 latency', p95(net.samples)), latency('P99 latency', p99(net.samples))];
    const head = h('div', { class: 'aw-col aw-gap6' },
      h('div', { class: 'aw-row aw-gap8 aw-wrapbtns' }, h('span', { class: `aw-bd ${r.state === 'completed' ? 'aw-gr' : r.state === 'running' ? 'aw-bl' : 'aw-am'}`, id: 'aw-run-state' }, r.state),
        h('strong', { class: 'aw-grow aw-wrap' }, `${r.planName} · ${r.kind === 'once' ? 'Run plan once (one pass)' : `Load · ${r.strategy === 'flow' ? 'Flow' : 'Independent'} · ${r.iterations}×${r.concurrency}`} · ${r.mode === 'direct' ? 'Direct' : 'Apply rules'}`),
        live ? btn([icon('stop', 'aw-i aw-i12'), 'Stop run'], () => { e.handle!.stop(); kit.announce('Stopping: no new requests; in-flight requests are aborted.'); }, 'aw-btn aw-out aw-sm', { id: 'aw-run-stop' }) : null),
      h('div', { class: 'aw-xs aw-mu aw-wrap' }, `Run ${r.id} · profile ${r.profileName} · config revision ${r.configRevision} · started ${new Date(r.startedAt).toLocaleString()}${r.endedAt ? ` · ended after ${Math.round((r.endedAt - r.startedAt) / 100) / 10} s` : ''}${e.handle ? '' : ' · stored summary (retained configuration snapshot not available)'}`),
      h('div', { class: 'aw-row aw-gap8' },
        h('div', { class: 'aw-prog aw-grow', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(r.progress.total), 'aria-valuenow': String(r.progress.done), 'aria-label': 'Logical steps finished' },
          (() => { const bar = h('span', {}); bar.style.width = `${r.progress.total ? Math.round((100 * r.progress.done) / r.progress.total) : 0}%`; return bar; })()),
        h('span', { class: 'aw-xs', id: 'aw-run-progress' }, `${r.progress.done} / ${r.progress.total} steps`)),
      h('div', { class: 'aw-xs aw-mu aw-wrap', id: 'aw-run-dispatched' }, `${r.dispatched.total} request(s) sent: ${r.dispatched.network} network, ${r.dispatched.synthetic} mock/synthetic · ${r.dispatched.poll} poll, ${r.dispatched.retry} read-only retry, ${r.dispatched.refresh} refresh · preflight bound ${r.preflight.counts.worst}`),
      ...r.notes.map((n) => h('div', { class: 'aw-alert aw-wrap' }, n)),
      ...(r.state === 'failed-preflight' ? r.preflight.errors.map((x) => h('div', { class: 'aw-err aw-wrap' }, x)) : []));
    const table = h('table', { class: 'aw-table', 'aria-label': 'Per-endpoint results' },
      h('thead', {}, h('tr', {}, ...['Endpoint', 'Pass', 'Fail', 'Skip', 'Avg', 'Min', 'Max', 'P95', 'P99'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, ...r.endpoints.map((x) => {
        const notSent = x.counts['skipped-dependency'] + x.counts['skipped-condition'] + x.counts['blocked-before-dispatch'];
        const errs = x.counts['network-error'] + x.counts.timeout + x.counts.aborted;
        const nt = x.network;
        const n = (v: number) => String(v);
        const t = (v: number | null, title?: string) => h('td', { class: speed(v), title }, v === null ? '—' : String(Math.round(v)));
        const kept = `${nt.samples.length} retained sample(s)${nt.capped ? '; capped' : ''}`;
        return h('tr', { 'data-endpoint': x.alias },
          h('th', { scope: 'row', title: `${x.name} · ${x.alias}` }, h('span', { class: 'aw-row aw-gap8' }, methodBadge(x.method), h('span', { class: 'aw-mono aw-tr' }, x.alias))),
          // Fail = failed checks + network errors/timeouts/aborts (split on hover); Skip = not sent.
          h('td', { class: tally(x.counts.passed, 'aw-t-ok') }, n(x.counts.passed)),
          h('td', { class: tally(x.counts['failed-check'] + errs, 'aw-t-bad'), title: `${x.counts['failed-check']} failed check · ${errs} network error, timeout or aborted` }, n(x.counts['failed-check'] + errs)),
          h('td', { class: tally(notSent, 'aw-t-warn'), title: 'Not sent: skipped (dependency or condition) or blocked before dispatch' }, n(notSent)),
          t(mean(nt)), t(nt.min), t(nt.max), t(p95(nt.samples), kept), t(p99(nt.samples), kept));
      })));
    const steps = r.steps.slice(-200).reverse();
    const stepList = h('div', { class: 'aw-col aw-gap4' }, ...steps.map((st) => stepNode(r, st)),
      r.steps.length > 200 || r.stepsDropped ? h('div', { class: 'aw-hint' }, `Showing the latest 200 of ${r.steps.length + r.stepsDropped} steps${r.stepsDropped ? ` (${r.stepsDropped} older dropped from the summary)` : ''}.`) : null);
    const samples = r.samples.map((smp) => {
      const ep = kit.session.agg().endpoints.find((x) => x.id === smp.endpointId);
      const name = r.endpoints.find((x) => x.endpointId === smp.endpointId)?.name ?? smp.endpointId;
      // A live run keeps the whole body in memory (the stored summary keeps BOUNDS.sampleBytes); show and copy all of it.
      const full = e.handle?.fullBody(smp.endpointId);
      const text = full ?? smp.body;
      const shown = text.length > SHOW_CHARS ? text.slice(0, SHOW_CHARS) : text;
      const state = full !== undefined && smp.bodyState === 'truncated' ? 'complete' : smp.bodyState;
      const notes = [
        shown !== text ? `Showing the first ${SHOW_CHARS / 1024}K of ${text.length.toLocaleString('en')} characters; Copy response copies all of it.` : '',
        full !== undefined && smp.bodyState === 'truncated' ? `Save sample keeps the first ${BOUNDS.sampleBytes / 1024} KB.` : '',
        full === undefined && smp.bodyState === 'truncated' ? `Only the first ${BOUNDS.sampleBytes / 1024} KB were kept with this stored run; run it again to see the whole response.` : '',
      ].filter(Boolean).join(' ');
      return h('details', { class: 'aw-sample' }, h('summary', { class: 'aw-xs' }, `${name}: HTTP ${smp.status} · ${state} · attempt #${smp.attemptId}`),
        h('div', { class: 'aw-col aw-gap8 aw-sampbody' },
          h('pre', { class: 'aw-code aw-pre', tabindex: '0' }, shown || '(empty)'),
          notes ? h('p', { class: 'aw-hint aw-wrap aw-m0' }, notes) : null,
          h('div', { class: 'aw-row aw-gap6 aw-wrapbtns' },
            ep ? (() => { const b: HTMLButtonElement = btn('Save sample', () => void saveSamples(r, [smp.endpointId]).then((ok) => ok && flash(b))); return b; })() : h('span', { class: 'aw-hint' }, 'Endpoint no longer exists; this sample cannot be saved.'),
            (() => {
              const b: HTMLButtonElement = btn('Copy response', async () => {
                try { await navigator.clipboard.writeText(text); flash(b, 'Copied'); } catch (x) { kit.toast(`Copy refused by the browser: ${(x as Error).message}`, 'error'); }
              }, 'aw-btn aw-gh aw-sm');
              return b;
            })())));
    });
    // Pinned to the bottom of the scrolling panel (sticky), like the old tool's action bar.
    const exportRow = h('div', { class: 'aw-row aw-gap6 aw-stickyfoot' },
      btn([icon('save', 'aw-i aw-i12'), 'JSON'], () => { download(`api-workbench-run-${r.id}.json`, toJson(r)); kit.announce('JSON download requested. The browser may still ask where to save it; check your downloads.'); }, 'aw-btn aw-out aw-sm', { 'data-key': 'run-json' }),
      btn([icon('save', 'aw-i aw-i12'), 'CSV'], () => { download(`api-workbench-run-${r.id}.csv`, toCsv(r), 'text/csv'); kit.announce('CSV download requested. The browser may still ask where to save it; check your downloads.'); }, 'aw-btn aw-out aw-sm', { 'data-key': 'run-csv' }),
      btn('Copy JSON', async () => { try { await navigator.clipboard.writeText(toJson(r)); kit.announce('Run JSON copied.'); } catch (x) { kit.announce(`Copy refused by the browser: ${(x as Error).message}`); } }, 'aw-btn aw-gh aw-sm'),
      !live && r.state !== 'failed-preflight' ? btn([icon('play', 'aw-i aw-i14'), 'Run again'], () => runAgain(e), 'aw-btn aw-pri aw-grow', { 'data-key': 'run-again' }) : h('div', { class: 'aw-grow' }));
    return [
      head,
      h('div', { class: 'aw-tiles' }, ...tiles),
      h('div', { class: 'aw-g3' }, ...latencies),
      section('Timings',
        h('div', { class: 'aw-xs aw-wrap', id: 'aw-run-network' }, `Network: ${statText(net)}`),
        h('div', { class: 'aw-xs aw-wrap' }, `Mock/synthetic (not server latency): ${statText(syn)}`),
        h('details', {}, h('summary', { class: 'aw-xs' }, 'Timing definitions'), ...Object.values(TIMING).map((t) => h('p', { class: 'aw-hint aw-wrap' }, t)))),
      section('Per-endpoint breakdown', h('div', { class: 'aw-scrollx' }, table),
        h('p', { class: 'aw-hint aw-wrap' }, 'Fail includes network errors and timeouts; Skip is not sent. Network timings in milliseconds: green under 300, amber to 1000, red above. P95 / P99: 95 / 99 of every 100 retained samples were at least that fast. Hover a row for the endpoint name.')),
      section(`Steps (${r.steps.length + r.stepsDropped})`, stepList),
      ...(samples.length ? [section('Last responses', ...samples, (() => { const b: HTMLButtonElement = btn('Save all samples', () => void saveSamples(r, r.samples.map((x) => x.endpointId)).then((ok) => ok && flash(b))); return b; })())] : []),
      h('p', { class: 'aw-hint aw-wrap' }, 'Browser-local test from one tab and one cookie session. These numbers are not server capacity evidence.'),
      exportRow,
    ];
  }

  function stepNode(r: RunSummary, st: StepRow): Node {
    const key = `${st.endpointId}|${st.iteration ?? ''}|${st.job ?? ''}|${st.attempts[0] ?? ''}`;
    const where = st.phase === 'setup' ? 'setup' : st.iteration !== undefined ? `iteration ${st.iteration}` : st.job !== undefined ? `job ${st.job}` : 'pass';
    const attempts = r.attempts.filter((a) => st.attempts.includes(a.id));
    const d = h('details', { 'data-step': key, class: 'aw-step' },
      h('summary', { class: 'aw-row aw-gap6 aw-xs' }, h('span', { class: `aw-bd ${TONE[st.outcome]}` }, LABEL[st.outcome]), h('span', { class: 'aw-mono' }, st.alias), h('span', { class: 'aw-mu' }, where), h('span', { class: 'aw-grow aw-tr' }, st.detail)),
      h('ul', { class: 'aw-ops' }, ...attempts.map((a) => {
        const meta = [a.totalMs !== undefined ? `${a.totalMs} ms` : '', a.queueMs ? `queued ${a.queueMs} ms` : '', a.provider !== 'network' ? `${a.provider} reply` : '',
          a.idempotencyKey ? `Idempotency key ${a.idempotencyKey}` : '', a.signed ? 'signed at dispatch' : '', a.recordId ? `request #${a.recordId}` : '', a.reason ?? ''].filter(Boolean).join(' · ');
        // Stacked: badges + method, URL, then timing/reason, then failed checks — nothing squeezed beside the badges.
        return h('li', { class: 'aw-col aw-gap4 aw-xs' },
          h('div', { class: 'aw-row aw-gap6' }, h('span', { class: 'aw-bd' }, `${a.kind} ${a.n}`), h('span', { class: `aw-bd ${TONE[a.outcome]}` }, a.status !== undefined ? `HTTP ${a.status}` : LABEL[a.outcome]),
            h('span', { class: 'aw-mono' }, a.method)),
          h('div', { class: 'aw-mono aw-wrap' }, a.url),
          meta ? h('div', { class: 'aw-mu aw-wrap' }, meta) : null,
          ...a.checks.filter((c) => c.state !== 'passed').map((c) => h('div', { class: 'aw-mu aw-wrap' }, `${c.text}: ${c.state} (${c.detail})`)));
      }),
        st.attempts.length > attempts.length ? h('li', { class: 'aw-hint' }, `${st.attempts.length - attempts.length} attempt record(s) dropped from the bounded summary`) : null),
      ...(st.assertions.length ? [h('ul', { class: 'aw-ops', 'aria-label': 'Assertions' }, ...st.assertions.map((x) => h('li', { class: 'aw-row aw-xs' }, h('span', { class: `aw-bd ${x.state === 'passed' ? 'aw-gr' : x.state === 'failed' ? 'aw-rd' : 'aw-am'}` }, x.state), h('span', { class: 'aw-grow aw-wrap' }, `${x.text} — ${x.detail}`))))] : []));
    if (openSteps.has(key)) d.open = true;
    return d;
  }

  /** Returns true when saved (the button then flashes "Saved"). */
  async function saveSamples(r: RunSummary, ids: string[]): Promise<boolean> {
    const list = r.samples.filter((x) => ids.includes(x.endpointId));
    const missing: string[] = [];
    const out = await kit.session.edit((a) => {
      for (const smp of list) {
        const ep = a.endpoints.find((x) => x.id === smp.endpointId); // by stable ID, never by URL
        if (!ep) { missing.push(smp.endpointId); continue; }
        const enc = new TextEncoder().encode(smp.body);
        ep.sample = { status: smp.status, headers: smp.headers, body: enc.byteLength > BOUNDS.sampleBytes ? smp.body.slice(0, BOUNDS.sampleBytes / 4) : smp.body, bodyState: smp.bodyState === 'complete' ? 'complete' : 'truncated', source: 'captured', at: smp.at };
      }
    });
    // Visible in the panel (not only announced): saving changes stored endpoints, so say what happened and how to use it.
    const n = list.length - missing.length;
    const cut = list.filter((x) => !missing.includes(x.endpointId) && x.bodyState !== 'complete').length;
    const text = out ? `Response not saved: ${out[0]!.message}`
      : `Saved ${n} response${n === 1 ? '' : 's'} as endpoint sample${n === 1 ? '' : 's'}${missing.length ? `; ${missing.length} endpoint(s) no longer exist` : ''}. Use in Mock → From endpoint or a reply's "Fill from a saved response".`
        + (cut ? ` ${cut} over ${BOUNDS.sampleBytes / 1024} KB ${cut === 1 ? 'was' : 'were'} cut short and can't be a mock reply.` : '');
    kit.toast(text, out ? 'error' : 'ok');
    return !out;
  }

  return { nodes: [historyEl, detail], refresh };
}
