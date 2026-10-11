// Test → Results: run registry (live runs + stored summaries), progress, outcome categories,
// per-endpoint timings, logical steps with attempts, samples, JSON/CSV export and Run again.
import { BOUNDS, type Plan } from '../data/schema';
import { runStore } from '../data/store';
import type { AuthCoordinator } from '../tester/auth';
import { pageSources } from '../tester/once';
import { OUTCOMES, startRun, type ReqOutcome, type RunHandle, type RunSummary, type StepRow } from '../tester/run';
import { mean, overall, p95, TIMING, toCsv, toJson, type Stat } from '../tester/stats';
import { h, icon } from './dom';
import { btn, download, methodBadge, section, type Kit } from './kit';

export interface RunEntry { summary: RunSummary; handle?: RunHandle; stored: boolean }

const LABEL: Record<ReqOutcome, string> = {
  passed: 'Passed', 'failed-check': 'Failed check', 'network-error': 'Network error', timeout: 'Timeout', aborted: 'Aborted',
  'skipped-dependency': 'Skipped (dependency)', 'skipped-condition': 'Skipped (condition)', 'blocked-before-dispatch': 'Blocked before dispatch',
};
const TONE: Record<ReqOutcome, string> = { passed: 'aw-gr', 'failed-check': 'aw-rd', 'network-error': 'aw-rd', timeout: 'aw-rd', aborted: 'aw-am', 'skipped-dependency': 'aw-am', 'skipped-condition': '', 'blocked-before-dispatch': 'aw-am' };
const ms = (n: number | null) => (n === null ? '—' : `${Math.round(n)} ms`);

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
      if (sum.state === 'failed-preflight') return;
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
    const tiles = OUTCOMES.filter((o) => o === 'passed' || o === 'failed-check' || r.counts[o]).map((o) =>
      h('div', { class: 'aw-card aw-cp aw-col aw-tile2' }, h('span', { class: 'aw-xs aw-mu' }, LABEL[o]), h('span', { class: 'aw-h aw-num', 'data-outcome': o }, String(r.counts[o]))));
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
      h('thead', {}, h('tr', {}, ...['Endpoint', 'Pass', 'Fail', 'Not sent', 'Errors', 'Mean', 'Min', 'Max', 'P95'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, ...r.endpoints.map((x) => {
        const notSent = x.counts['skipped-dependency'] + x.counts['skipped-condition'] + x.counts['blocked-before-dispatch'];
        const errs = x.counts['network-error'] + x.counts.timeout + x.counts.aborted;
        const nt = x.network;
        return h('tr', { 'data-endpoint': x.alias },
          h('th', { scope: 'row' }, methodBadge(x.method), ' ', x.name, h('span', { class: 'aw-xs aw-mu' }, ` ${x.alias}`)),
          h('td', {}, String(x.counts.passed)), h('td', {}, String(x.counts['failed-check'])), h('td', {}, String(notSent)), h('td', {}, String(errs)),
          h('td', {}, ms(mean(nt))), h('td', {}, ms(nt.min)), h('td', {}, ms(nt.max)), h('td', { title: `${nt.samples.length} retained sample(s)${nt.capped ? '; capped' : ''}` }, nt.n ? `${ms(p95(nt.samples))} (n=${nt.samples.length}${nt.capped ? ', capped' : ''})` : '—'));
      })));
    const steps = r.steps.slice(-200).reverse();
    const stepList = h('div', { class: 'aw-col aw-gap4' }, ...steps.map((st) => stepNode(r, st)),
      r.steps.length > 200 || r.stepsDropped ? h('div', { class: 'aw-hint' }, `Showing the latest 200 of ${r.steps.length + r.stepsDropped} steps${r.stepsDropped ? ` (${r.stepsDropped} older dropped from the summary)` : ''}.`) : null);
    const samples = r.samples.map((smp) => {
      const ep = kit.session.agg().endpoints.find((x) => x.id === smp.endpointId);
      const name = r.endpoints.find((x) => x.endpointId === smp.endpointId)?.name ?? smp.endpointId;
      return h('details', {}, h('summary', { class: 'aw-xs' }, `${name}: HTTP ${smp.status} · ${smp.bodyState} · attempt #${smp.attemptId}`),
        h('pre', { class: 'aw-code aw-pre', tabindex: '0' }, smp.body.slice(0, 4096) || '(empty)'),
        ep ? btn('Save sample', () => saveSamples(r, [smp.endpointId])) : h('span', { class: 'aw-hint' }, 'Endpoint no longer exists; this sample cannot be saved.'));
    });
    const exportRow = h('div', { class: 'aw-row aw-gap6 aw-wrapbtns' },
      btn([icon('save', 'aw-i aw-i12'), 'JSON'], () => { download(`api-workbench-run-${r.id}.json`, toJson(r)); kit.announce('JSON download requested. The browser may still ask where to save it; check your downloads.'); }, 'aw-btn aw-out aw-sm', { 'data-key': 'run-json' }),
      btn([icon('save', 'aw-i aw-i12'), 'CSV'], () => { download(`api-workbench-run-${r.id}.csv`, toCsv(r), 'text/csv'); kit.announce('CSV download requested. The browser may still ask where to save it; check your downloads.'); }, 'aw-btn aw-out aw-sm', { 'data-key': 'run-csv' }),
      btn('Copy JSON', async () => { try { await navigator.clipboard.writeText(toJson(r)); kit.announce('Run JSON copied.'); } catch (x) { kit.announce(`Copy refused by the browser: ${(x as Error).message}`); } }, 'aw-btn aw-gh aw-sm'),
      h('div', { class: 'aw-grow' }),
      !live && r.state !== 'failed-preflight' ? btn([icon('play', 'aw-i aw-i12'), 'Run again'], () => runAgain(e), 'aw-btn aw-pri aw-sm', { 'data-key': 'run-again' }) : null);
    return [
      head,
      h('div', { class: 'aw-g4' }, ...tiles),
      section('Timings',
        h('div', { class: 'aw-xs aw-wrap', id: 'aw-run-network' }, `Network: ${statText(net)}`),
        h('div', { class: 'aw-xs aw-wrap' }, `Mock/synthetic (not server latency): ${statText(syn)}`),
        h('details', {}, h('summary', { class: 'aw-xs' }, 'Timing definitions'), ...Object.values(TIMING).map((t) => h('p', { class: 'aw-hint aw-wrap' }, t)))),
      section('Per-endpoint breakdown', h('div', { class: 'aw-scrollx' }, table)),
      section(`Steps (${r.steps.length + r.stepsDropped})`, stepList),
      ...(samples.length ? [section('Last responses', ...samples, btn('Save all samples', () => saveSamples(r, r.samples.map((x) => x.endpointId))))] : []),
      exportRow,
      h('p', { class: 'aw-hint aw-wrap' }, 'Browser-local test from one tab and one cookie session. These numbers are not server capacity evidence.'),
    ];
  }

  function stepNode(r: RunSummary, st: StepRow): Node {
    const key = `${st.endpointId}|${st.iteration ?? ''}|${st.job ?? ''}|${st.attempts[0] ?? ''}`;
    const where = st.phase === 'setup' ? 'setup' : st.iteration !== undefined ? `iteration ${st.iteration}` : st.job !== undefined ? `job ${st.job}` : 'pass';
    const attempts = r.attempts.filter((a) => st.attempts.includes(a.id));
    const d = h('details', { 'data-step': key, class: 'aw-step' },
      h('summary', { class: 'aw-row aw-gap6 aw-xs' }, h('span', { class: `aw-bd ${TONE[st.outcome]}` }, st.outcome), h('span', { class: 'aw-mono' }, st.alias), h('span', { class: 'aw-mu' }, where), h('span', { class: 'aw-grow aw-tr' }, st.detail)),
      h('ul', { class: 'aw-ops' }, ...attempts.map((a) => h('li', { class: 'aw-row aw-xs aw-wrap' },
        h('span', { class: 'aw-bd' }, `${a.kind} ${a.n}`), h('span', { class: `aw-bd ${TONE[a.outcome]}` }, a.status !== undefined ? `HTTP ${a.status}` : a.outcome),
        h('span', { class: 'aw-grow aw-wrap' }, [a.method, a.url, a.totalMs !== undefined ? `${a.totalMs} ms` : '', a.queueMs ? `queued ${a.queueMs} ms` : '', a.provider !== 'network' ? `${a.provider} reply` : '',
          a.idempotencyKey ? `Idempotency key ${a.idempotencyKey}` : '', a.signed ? 'signed at dispatch' : '', a.recordId ? `request #${a.recordId}` : '', a.reason ?? ''].filter(Boolean).join(' · ')),
        ...a.checks.filter((c) => c.state !== 'passed').map((c) => h('span', { class: 'aw-xs aw-mu aw-wrap' }, `${c.text}: ${c.state} (${c.detail})`)))),
        st.attempts.length > attempts.length ? h('li', { class: 'aw-hint' }, `${st.attempts.length - attempts.length} attempt record(s) dropped from the bounded summary`) : null),
      ...(st.assertions.length ? [h('ul', { class: 'aw-ops', 'aria-label': 'Assertions' }, ...st.assertions.map((x) => h('li', { class: 'aw-row aw-xs' }, h('span', { class: `aw-bd ${x.state === 'passed' ? 'aw-gr' : x.state === 'failed' ? 'aw-rd' : 'aw-am'}` }, x.state), h('span', { class: 'aw-wrap' }, `${x.text} — ${x.detail}`))))] : []));
    if (openSteps.has(key)) d.open = true;
    return d;
  }

  async function saveSamples(r: RunSummary, ids: string[]) {
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
    kit.announce(out ? `Samples not saved: ${out[0]!.message}` : `Saved ${list.length - missing.length} sample(s) from run ${r.id}${missing.length ? `; ${missing.length} endpoint(s) no longer exist` : ''}.`);
  }

  return { nodes: [historyEl, detail], refresh };
}
