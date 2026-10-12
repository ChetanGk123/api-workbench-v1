// Test: Once (one selected endpoint, explicit Direct / Apply rules, masked preview with reserved values,
// Run/Cancel/Send again, identified result and history), Plans (form), Results, Auth & context.
import { BOUNDS, type Check, type Endpoint, type Plan } from '../data/schema';
import { createAuth } from '../tester/auth';
import { describeCheck, evaluate, pageSources, prepare, send, type CheckOutcome, type OnceResult, type Prepared } from '../tester/once';
import { signPrepared } from '../tester/sign';
import { createContextUi } from './context';
import { h, icon } from './dom';
import { btn, fileButton, heading, methodBadge, section, tile, type Built, type Kit } from './kit';
import { createPlansUi } from './plans';
import { createRuns, resultsNodes, type RunEntry } from './results';

interface Run {
  no: number;
  endpointId: string;
  name: string;
  mode: 'direct' | 'rules';
  at: Date;
  prepared: Prepared;
  checks: Check[];
  result: OnceResult | null;
  outcomes: CheckOutcome[];
  /** Generated values this run sent; Send again reuses them (a deliberate duplicate). */
  reserved: Map<string, unknown>;
  duplicateOf?: number;
  notes: string[];
}

export function createTestUi(kit: Kit) {
  const s = kit.session;
  let selected: string | null = null;
  let mode: 'direct' | 'rules' = 'direct';
  let files = new Map<number, File>();
  let inflight: AbortController | null = null;
  let runNo = 0;
  let last: Run | null = null;
  const history: Run[] = [];
  /** Draft reservation shown in the preview and used by the next Run; Regenerate makes a new one. */
  let reserved = new Map<string, unknown>();
  /** Manual Once has its own transient counter scope. */
  const counters = new Map<string, number>();
  let view: 'once' | 'results' = 'once';
  let selectedRun: string | null = null;

  const auth = createAuth({ agg: () => s.agg(), pageOrigin: kit.rt.origin, base: pageSources, transport: kit.fetchers.direct, limit: () => s.agg().profile.settings.bodyCheckKb * 1024 });
  const runs = createRuns(kit, auth, () => kit.changed());
  const contextUi = createContextUi(kit, auth);
  const plansUi = createPlansUi(kit, {
    keys: () => new Set(auth.keys.keys()),
    openContext: (ret) => contextUi.open(ret),
    run(plan: Plan, once: boolean) {
      if (runs.running().length) { kit.announce('Another run is in progress. Stop it first.'); return; }
      const hd = runs.start(plan, once);
      view = 'results';
      selectedRun = hd.id;
      kit.announce(`${plan.name}: ${once ? 'one pass' : 'Load'} started.`);
      kit.closeForm(null);
    },
    running: (id) => runs.running().some((e) => e.summary.planId === id),
    stop: (id) => runs.running().filter((e) => e.summary.planId === id).forEach((e) => e.handle!.stop()),
  });
  const prepOpts = () => ({ reserved, counters, authSources: auth.sources, keys: new Set(auth.keys.keys()) });

  const current = (): Endpoint | undefined => {
    const eps = s.agg().endpoints;
    return eps.find((e) => e.id === selected) ?? eps[0];
  };

  function select(id: string) {
    if (id !== selected) { files = new Map(); reserved = new Map(); }
    selected = id;
    view = 'once';
  }

  /** Profile switch / Close: cancel owned work and forget anything from the old profile. */
  function stop() {
    inflight?.abort();
    inflight = null;
    selected = null;
    files = new Map();
    last = null;
    history.length = 0;
    reserved = new Map();
    counters.clear();
    runs.stopAll('Stopped: profile changed or Workbench closed');
    runs.reset();
    auth.clear();
    contextUi.clear();
    selectedRun = null;
  }

  /** C08: a rule that changed or answered a signed request after signing is named, never silent. */
  function signedAfter(id: number): string[] {
    const rec = kit.rt.records().find((r) => r.id === id);
    if (!rec) return [];
    const out: string[] = [];
    for (const o of rec.ops) {
      if (o.state !== 'applied') continue;
      const who = o.rule ? `${o.module} rule ${o.rule}` : o.module;
      if (o.module === 'intercept' && (o.part === 'request' || o.part === 'request-pause'))
        out.push(`Signed content changed after signing by ${who}: the server sees a signature that does not cover what was sent (intentional invalid-signature test)`);
      else if (o.module === 'route')
        out.push(`Routed after signing by ${who} to ${rec.finalUrl ?? 'another destination'}: the signature was prepared for the original destination, not re-signed for this one`);
      else if (o.module === 'mock' || (o.module === 'chaos' && rec.provider === 'chaos'))
        out.push(`Answered by ${who} without reaching the server: the signature was not verified`);
    }
    return out;
  }

  /** Explicit refresh before dispatch, signing per attempt, one configured read-only retry after 401. */
  async function transmit(agg: ReturnType<typeof s.agg>, ep: Endpoint, use: Map<string, unknown>, signal: AbortSignal, notes: string[]): Promise<{ p: Prepared; res: OnceResult | null }> {
    const build = () => prepare(agg, ep, kit.rt.origin, pageSources(), files, { ...prepOpts(), reserved: use });
    const ctx = ep.authContextId ? agg.authContexts.find((c) => c.id === ep.authContextId) : undefined;
    let p = build();
    if (p.auth?.needsRefresh && ctx) {
      notes.push(`Auth context ${ctx.label} was ${p.auth.state}: refreshed before sending`);
      const err = await auth.refresh(ctx, signal).catch(() => 'cancelled');
      if (err) return { p: { ...p, blocked: [`Auth context ${ctx.label}: refresh failed — ${err}`] }, res: null };
      p = build();
      if (p.auth?.needsRefresh) return { p: { ...p, blocked: [`Auth context ${ctx.label} is still ${p.auth.state} after refresh`] }, res: null };
    }
    if (p.blocked.length) return { p, res: null };
    const go = async (q: Prepared) => {
      if (q.signing) {
        const key = auth.keys.get(q.signing.keyRef);
        if (!key) return { p: { ...q, blocked: [`Signing key "${q.signing.keyRef}" is not loaded`] }, res: null };
        q = { ...q, headers: (await signPrepared(q, key, Date.now(), crypto.randomUUID())).headers };
        notes.push('Signed at dispatch with a fresh timestamp and nonce');
      }
      const res = await send(q, mode === 'direct' ? kit.fetchers.direct : kit.fetchers.rules, signal, agg.profile.settings.bodyCheckKb * 1024);
      if (q.signing && res.recordId) notes.push(...signedAfter(res.recordId));
      return { p: q, res };
    };
    const first = await go(p);
    if (first.res?.status === 401 && ctx?.refresh?.readOnlyRetry && (ep.request.method === 'GET' || ep.request.method === 'HEAD') && !signal.aborted) {
      notes.push('HTTP 401: refreshed and retried once (read-only retry is enabled for this context)');
      const err = await auth.refresh(ctx, signal).catch(() => 'cancelled');
      if (!err) return go(build());
      notes.push(`Refresh failed: ${err}; no retry`);
    } else if (first.res?.status === 401 && ctx?.refresh) notes.push('HTTP 401 on a write or without read-only retry: not retried automatically');
    return first;
  }

  async function run(ep: Endpoint, duplicate?: Run) {
    if (inflight) return; // one owned request at a time
    const agg = s.agg();
    const use = duplicate ? duplicate.reserved : reserved;
    const pre = prepare(agg, ep, kit.rt.origin, pageSources(), files, { ...prepOpts(), reserved: use }); // values re-resolved at dispatch
    if (pre.blocked.length) { kit.announce(`Not sent: ${pre.blocked[0]}`); draw?.(); return; }
    const ctl = new AbortController();
    inflight = ctl;
    const r: Run = { no: ++runNo, endpointId: ep.id, name: ep.name, mode, at: new Date(), prepared: pre, checks: structuredClone(ep.checks), result: null, outcomes: [], reserved: use, notes: [], ...(duplicate && { duplicateOf: duplicate.no }) };
    last = r;
    history.unshift(r);
    if (history.length > 10) history.pop();
    if (!duplicate) reserved = new Map(); // the next Run is a new logical operation
    kit.announce(`Run #${r.no} sending ${ep.name}${mode === 'direct' ? ' directly' : ' through active rules'}${duplicate ? ` as a deliberate duplicate of #${duplicate.no}` : ''}.`);
    draw?.();
    const { p, res } = await transmit(agg, ep, use, ctl.signal, r.notes);
    if (inflight === ctl) inflight = null;
    if (!history.includes(r)) return; // profile switched or closed meanwhile
    r.prepared = p;
    if (!res) {
      r.result = { outcome: 'blocked', headers: [], body: { state: 'none', text: '', bytes: 0 }, ms: 0, error: `Not sent: ${p.blocked.join('; ')}` };
      r.outcomes = evaluate(r.checks, r.result);
      kit.announce(`Run #${r.no} not sent: ${p.blocked[0]}`);
      draw?.();
      return;
    }
    r.result = res;
    r.outcomes = evaluate(r.checks, res);
    const failed = r.outcomes.filter((o) => o.state === 'failed').length;
    kit.announce(`Run #${r.no}: ${outcomeText(res)}${r.outcomes.length ? ` · ${failed ? `${failed} check(s) failed` : r.outcomes.every((o) => o.state === 'passed') ? 'checks passed' : 'some checks not evaluated'}` : ''}.`);
    draw?.();
  }

  let draw: (() => void) | null = null;

  /** Segmented header shared by Once and Results; Plans and Auth & context open as draft workspaces. */
  function header(): Node[] {
    const seg = (label: string, on: boolean, go: () => void, key: string) => btn(label, go, `aw-btn aw-sm${on ? ' aw-on' : ''}`, { 'aria-pressed': String(on), 'data-key': key });
    const running = runs.running().length;
    return [
      h('div', { class: 'aw-row aw-gap10' }, tile('flask'), h('div', { class: 'aw-grow' }, heading('API Tester'), h('div', { class: 'aw-xs aw-mu' }, 'Once sends one endpoint. Plans run setup/load steps. Results keep run history.')),
        btn([icon('book', 'aw-i aw-i14'), 'Endpoints'], () => kit.go('endpoints'), 'aw-btn aw-out aw-sm', { 'data-key': 'test-endpoints' })),
      h('div', { class: 'aw-row aw-gap8 aw-wrapbtns' },
        h('div', { class: 'aw-seg', role: 'group', 'aria-label': 'Tester view' },
          seg('Once', view === 'once', () => { view = 'once'; kit.go('test'); }, 'view-once'),
          seg('Plans', false, () => plansUi.open(kit.here()), 'view-plans'),
          seg(`Results${running ? ` (${running} running)` : ''}`, view === 'results', () => { view = 'results'; void runs.load(); kit.go('test'); }, 'view-results')),
        h('div', { class: 'aw-grow' }),
        btn('Auth & context', () => contextUi.open(kit.here()), 'aw-btn aw-gh aw-sm', { 'data-key': 'view-context' })),
    ];
  }

  function screen(): Built {
    if (view === 'results') {
      void runs.load();
      const r = resultsNodes(kit, runs, () => selectedRun, (id) => { selectedRun = id; }, runAgain);
      const head = h('div', { class: 'aw-col aw-gap10' });
      let sig = '';
      const refresh = () => {
        const x = String(runs.running().length);
        if (x !== sig) { sig = x; head.replaceChildren(...header()); }
        r.refresh();
      };
      draw = refresh;
      refresh();
      return { nodes: [head, ...r.nodes], refresh };
    }
    const top = h('div', { class: 'aw-col aw-gap10' });
    const preview = h('div', { class: 'aw-col aw-gap6' });
    const resultEl = h('div', { class: 'aw-col aw-gap10', 'aria-live': 'polite' });
    let shownTop = '';
    let shownResult = '';
    let shownPreview = '';

    const refresh = () => {
      const agg = s.agg();
      const ep = current();
      const topSig = JSON.stringify([agg.profile.id, agg.endpoints.map((e) => [e.id, e.name, e.request.method]), ep?.id, mode, !!inflight]);
      if (topSig !== shownTop) {
        shownTop = topSig;
        top.replaceChildren(...topControls(ep));
      }
      const p = ep && prepare(agg, ep, kit.rt.origin, pageSources(), files, prepOpts());
      const prevSig = JSON.stringify([p && { ...p, body: null }, [...files].map(([i, f]) => [i, f.name, f.size])]);
      if (prevSig !== shownPreview) { // traffic updates must not rebuild file inputs or move focus
        shownPreview = prevSig;
        preview.replaceChildren(...(ep && p ? previewNodes(ep, p) : []));
      }
      const resSig = last ? `${last.no}|${last.result ? 'done' : 'pending'}|${history.length}|${!!inflight}` : 'none';
      if (resSig !== shownResult) {
        shownResult = resSig;
        resultEl.replaceChildren(...(last ? resultNodes(last) : []));
      }
    };
    draw = refresh;

    function topControls(ep: Endpoint | undefined): Node[] {
      const agg = s.agg();
      if (!ep) return [h('div', { class: 'aw-empty aw-wrap' }, 'No endpoints in this profile yet.'),
        h('div', { class: 'aw-row' }, btn([icon('plus', 'aw-i aw-i14'), 'Add endpoint'], () => kit.editEndpoint(null), 'aw-btn aw-pri aw-sm'), btn('Open Endpoints', () => kit.go('endpoints')))];
      const sel = h('select', { class: 'aw-in aw-select', id: 'aw-once-ep' }, ...agg.endpoints.map((e) => h('option', { value: e.id, selected: e.id === ep.id }, `${e.name} · ${e.request.method} ${e.request.url}`)));
      sel.addEventListener('change', () => { select(sel.value); refresh(); });
      const seg = (value: 'direct' | 'rules', label: string) => {
        const b = btn(label, () => { mode = value; refresh(); kit.root.getElementById(`aw-once-${value}`)?.focus(); }, `aw-btn aw-sm ${mode === value ? 'aw-pri' : 'aw-out'}`, { 'aria-pressed': String(mode === value), id: `aw-once-${value}` });
        return b;
      };
      const runBtn = btn([icon('play', 'aw-i aw-i14'), 'Run'], () => { view = 'once'; void run(ep); }, 'aw-btn aw-pri', { id: 'aw-once-run', 'data-key': 'once-run' });
      const cancel = btn([icon('stop', 'aw-i aw-i14'), 'Cancel'], () => { inflight?.abort(); kit.announce('Cancelling the request.'); }, 'aw-btn aw-out', { hidden: !inflight });
      runBtn.disabled = !!inflight;
      return [
        h('div', { class: 'aw-fld' }, h('label', { class: 'aw-lbl', for: 'aw-once-ep' }, 'Endpoint'), sel),
        h('div', { class: 'aw-row aw-gap8 aw-wrapbtns', role: 'group', 'aria-label': 'Send mode' }, seg('direct', 'Direct'), seg('rules', 'Apply rules'), h('div', { class: 'aw-grow' }), cancel, runBtn),
        h('p', { class: 'aw-hint aw-wrap' }, mode === 'direct'
          ? 'Direct sends with the browser’s own fetch, bypassing every active Mock/Intercept/Route rule.'
          : 'Apply rules sends through the page pipeline: active rules can mock, route or change it, and it appears in Recent activity.'),
        h('div', { class: 'aw-row aw-gap6' }, btn('Edit endpoint', () => kit.editEndpoint(ep.id), 'aw-btn aw-gh aw-sm', { 'aria-label': `Edit ${ep.name}` })),
      ];
    }

    function previewNodes(ep: Endpoint, p: Prepared): Node[] {
      const fileInputs = ep.request.body.kind === 'multipart' ? ep.request.body.parts.flatMap((part, i) => {
        if (part.kind !== 'file') return [];
        const f = h('input', { type: 'file', class: 'aw-xs', 'aria-label': `File for ${part.name}` });
        f.addEventListener('change', () => {
          const file = f.files?.[0];
          if (file) files.set(i, file); else files.delete(i);
          refresh();
        });
        const chosen = files.get(i);
        return [h('div', { class: 'aw-row aw-gap6 aw-xs' }, h('span', { class: 'aw-mono' }, part.name), fileButton(f),
          h('span', { class: 'aw-mu' }, chosen ? `${chosen.name} · ${chosen.size} bytes · ${chosen.type || 'no type'}` : 'not selected'))];
      }) : [];
      const dl = (rows: [string, Node | string][]) => h('dl', { class: 'aw-dl' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', { class: 'aw-mono' }, v)]));
      return [section('Request preview',
        dl([
          ['Send', h('span', {}, methodBadge(p.method), ' ', p.url || '(unresolved)')],
          ['Origin', p.origin],
          ['Credentials', p.credentials === 'include' ? 'Include (cookies also cross-origin)' : p.credentials === 'omit' ? 'Omit (no cookies)' : 'Same origin'],
          ['Body', p.bodySummary],
        ]),
        h('div', { class: 'aw-lbl' }, `Headers (${p.headers.length})`),
        p.headers.length ? h('ul', { class: 'aw-ops' }, ...p.headers.map((x) => h('li', { class: 'aw-row aw-xs' }, h('span', { class: 'aw-bd' }, x.from), h('span', { class: 'aw-mono aw-wrap' }, `${x.name}: ${x.shown}`)))) : h('span', { class: 'aw-hint' }, 'No headers set by Workbench.'),
        ...fileInputs,
        ...(p.auth ? [h('div', { class: 'aw-xs aw-wrap', id: 'aw-once-auth' }, h('span', { class: `aw-bd ${p.auth.state === 'available' ? 'aw-gr' : 'aw-am'}` }, `auth ${p.auth.state}`), ` ${p.auth.label}: ${p.auth.detail}${p.auth.needsRefresh ? ' · will refresh before sending' : ''}`)] : []),
        ...(p.signing ? [h('div', { class: 'aw-xs aw-wrap', id: 'aw-once-signing' }, h('span', { class: 'aw-bd' }, 'signed'), ` ${p.signing.label}: ${p.signing.components.join(' + ')} → ${p.signing.outputHeader}, signed at dispatch with a fresh timestamp and nonce (the preview is not a signature)`)] : []),
        ...(p.reserved.size ? [h('div', { class: 'aw-row aw-gap6 aw-xs aw-wrap', id: 'aw-once-reserved' }, h('span', { class: 'aw-grow aw-wrap' }, `Generated for the next Run: ${[...p.reserved].map(([k, v]) => `${k} = ${String(v)}`).join(' · ')}`),
          btn('Regenerate', () => { reserved = new Map(); refresh(); kit.announce('New generated values reserved for the next Run.'); }, 'aw-btn aw-gh aw-sm', { 'data-key': 'once-regen' }))] : []),
        p.blocked.length ? h('div', { class: 'aw-alert aw-col aw-gap4', id: 'aw-once-blocked' }, h('strong', {}, 'Cannot send yet'), ...p.blocked.map((b) => h('div', { class: 'aw-wrap' }, b))) : null,
        h('p', { class: 'aw-hint aw-wrap' }, 'Values are read again when you press Run. Secret-looking values are masked here. Nothing is sent until Run.'))];
    }

    function resultNodes(r: Run): Node[] {
      const res = r.result;
      const ident = `Run #${r.no} · ${r.name} · ${r.mode === 'direct' ? 'Direct' : 'Apply rules'} · ${r.at.toLocaleTimeString()}${r.duplicateOf ? ` · deliberate duplicate of #${r.duplicateOf} (same generated values)` : ''}`;
      if (!res) return [section('Result', h('div', { class: 'aw-xs aw-mu' }, ident), h('div', { class: 'aw-row aw-gap6' }, h('span', { class: 'aw-bd aw-am' }, 'pending'), `${r.prepared.method} ${r.prepared.url}`))];
      const failed = r.outcomes.filter((o) => o.state === 'failed').length;
      const notEval = r.outcomes.filter((o) => o.state === 'not-evaluated').length;
      const verdict = res.outcome !== 'response' ? (res.outcome === 'aborted' ? ['aw-am', 'Cancelled'] : res.outcome === 'blocked' ? ['aw-am', 'Not sent'] : ['aw-rd', 'Network error'])
        : !r.outcomes.length ? ['', 'Response received · no checks']
        : failed ? ['aw-rd', `${failed} check${failed > 1 ? 's' : ''} failed`]
        : notEval ? ['aw-am', `${notEval} check${notEval > 1 ? 's' : ''} not evaluated`] : ['aw-gr', 'Checks passed'];
      const nodes: Node[] = [
        ...(history.length > 1 ? [(() => {
          const hs = h('select', { class: 'aw-in aw-select aw-sm', 'aria-label': 'Once history', id: 'aw-once-history' }, ...history.map((x) => h('option', { value: String(x.no), selected: x === r }, `#${x.no} ${x.name} · ${x.result ? (x.result.outcome === 'response' ? `HTTP ${x.result.status}` : x.result.outcome) : 'pending'}`)));
          hs.addEventListener('change', () => { const x = history.find((y) => String(y.no) === hs.value); if (x) { last = x; refresh(); } });
          return hs;
        })()] : []),
        h('div', { class: 'aw-xs aw-mu', id: 'aw-once-ident' }, ident),
        ...r.notes.map((n) => h('div', { class: 'aw-xs aw-wrap' }, n)),
        h('div', { class: 'aw-row aw-gap6 aw-wrapbtns' }, h('span', { class: `aw-bd ${verdict[0]}`, id: 'aw-once-verdict' }, verdict[1]!), h('span', { class: 'aw-wrap' }, outcomeText(res))),
      ];
      if (r.outcomes.length) nodes.push(h('ul', { class: 'aw-ops', 'aria-label': 'Checks' }, ...r.outcomes.map((o) =>
        h('li', { class: 'aw-row aw-xs' }, h('span', { class: `aw-bd ${o.state === 'passed' ? 'aw-gr' : o.state === 'failed' ? 'aw-rd' : 'aw-am'}` }, o.state), h('span', { class: 'aw-grow aw-wrap' }, `${describeCheck(o.check)} — ${o.detail}`)))));
      if (res.outcome === 'response') {
        nodes.push(h('details', {}, h('summary', { class: 'aw-lbl' }, `Response headers (${res.headers.length})`),
          h('dl', { class: 'aw-dl' }, ...res.headers.flatMap(([k, v]) => [h('dt', {}, k), h('dd', { class: 'aw-mono' }, v)]))));
        const shownText = res.body.text.length > 65536 ? res.body.text.slice(0, 65536) : res.body.text;
        nodes.push(h('div', { class: 'aw-lbl' }, `Body · ${res.body.bytes} bytes · ${res.body.state}${res.body.note ? ` (${res.body.note})` : ''}${shownText !== res.body.text ? ' · display shows the first 64K characters' : ''}`),
          h('pre', { class: 'aw-code aw-pre', id: 'aw-once-body', tabindex: '0' }, shownText || '(empty)'));
        const ep = s.agg().endpoints.find((e) => e.id === r.endpointId);
        nodes.push(h('div', { class: 'aw-row aw-gap6 aw-wrapbtns' },
          btn('Copy body', async () => {
            try { await navigator.clipboard.writeText(res.body.text); kit.announce(`Copied ${res.body.text.length} characters of the run #${r.no} body.`); }
            catch (e) { kit.announce(`Copy refused by the browser: ${(e as Error).message}. Select the body text instead.`); }
          }),
          ep ? btn('Save sample', () => saveSample(ep, r, res)) : null,
          ep ? btn('Add check', () => kit.editEndpoint(ep.id, (d) => (d as Endpoint).checks.push({ kind: 'status', min: res.status!, max: res.status! }))) : null,
          ep && !inflight ? btn('Send again (same values)', () => run(ep, r), 'aw-btn aw-gh aw-sm', { 'data-key': 'once-dup', title: 'A deliberate duplicate: the same generated values (UUIDs, idempotency keys) are sent again; signing freshness is renewed' }) : null));
      } else if (res.error) nodes.push(h('p', { class: 'aw-hint aw-wrap' }, res.error));
      return [section('Result', ...nodes)];
    }

    refresh();
    return { nodes: [...header(), top, preview, resultEl], refresh };
  }

  async function runAgain(e: RunEntry) {
    const cur = s.agg();
    const plan = cur.plans.find((p) => p.id === e.summary.planId);
    const snap = e.handle?.snapshot;
    const changed = snap && plan && (JSON.stringify(snap.plan) !== JSON.stringify(plan) || snap.agg.revision !== cur.revision || JSON.stringify(snap.agg.endpoints) !== JSON.stringify(cur.endpoints));
    let use: 'current' | 'snapshot' = 'current';
    if (!plan && !snap) { kit.announce('That plan no longer exists and this stored summary has no configuration snapshot.'); return; }
    if (changed || (!plan && snap)) {
      const v = await kit.ask(`The configuration changed since run ${e.summary.id}. Run the retained snapshot (as it ran) or the current configuration?`, [
        { label: 'Cancel', cls: 'aw-out', value: 'cancel' }, { label: 'Retained snapshot', cls: 'aw-out', value: 'snapshot' }, ...(plan ? [{ label: 'Current configuration', cls: 'aw-pri', value: 'current' }] : []),
      ]);
      if (v === 'cancel') return;
      use = v as 'current' | 'snapshot';
    } else if (!snap) kit.announce('Stored summary: running the current configuration (the original snapshot is not retained after reload).');
    if (runs.running().length) { kit.announce('Another run is in progress. Stop it first.'); return; }
    const hd = use === 'snapshot' ? runs.start(snap!.plan, e.summary.kind === 'once', { ...snap!.agg, bindings: cur.bindings }) : runs.start(plan!, e.summary.kind === 'once');
    selectedRun = hd.id;
    kit.announce(`Run again (${use === 'snapshot' ? 'retained snapshot' : 'current configuration'}) started.`);
    draw?.();
  }

  function showRun(id: string) {
    selectedRun = id;
    view = 'results';
  }

  async function saveSample(ep: Endpoint, r: Run, res: OnceResult) {
    const enc = new TextEncoder().encode(res.body.text);
    const cut = enc.byteLength > BOUNDS.sampleBytes;
    const body = cut ? new TextDecoder().decode(enc.slice(0, BOUNDS.sampleBytes)).replace(/�$/, '') : res.body.text;
    const out = await s.edit((a) => {
      const e = a.endpoints.find((x) => x.id === ep.id);
      if (e) e.sample = { status: res.status!, headers: res.headers, body, bodyState: cut || res.body.state !== 'complete' ? 'truncated' : 'complete', source: 'captured', at: r.at.getTime() };
    });
    kit.announce(out ? `Sample not saved: ${out[0]!.message}` : `Sample saved on ${ep.name} from run #${r.no}${cut || res.body.state !== 'complete' ? ' (body truncated)' : ''}.`);
  }

  return { screen, select, stop, showRun, runs, plansUi, contextUi, auth };
}

function outcomeText(r: OnceResult): string {
  if (r.outcome === 'blocked') return r.error ?? 'Not sent';
  if (r.outcome === 'aborted') return `Cancelled after ${r.ms} ms`;
  if (r.outcome === 'network-error') return `No HTTP response after ${r.ms} ms (network failure, CORS or browser policy)`;
  return `HTTP ${r.status}${r.statusText ? ` ${r.statusText}` : ''} · ${r.ms} ms observed · ${r.body.bytes} bytes`;
}
