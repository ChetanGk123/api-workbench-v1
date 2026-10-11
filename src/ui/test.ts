// Test → Once: one selected endpoint, an explicit Direct / Apply rules choice, a masked preview of the
// exact request, Run/Cancel, and an identified result with checks and follow-up actions.
import { BOUNDS, type Check, type Endpoint } from '../data/schema';
import { describeCheck, evaluate, pageSources, prepare, send, type CheckOutcome, type OnceResult, type Prepared } from '../tester/once';
import { h, icon } from './dom';
import { btn, heading, methodBadge, section, tile, type Built, type Kit } from './kit';

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
}

export function createTestUi(kit: Kit) {
  const s = kit.session;
  let selected: string | null = null;
  let mode: 'direct' | 'rules' = 'direct';
  let files = new Map<number, File>();
  let inflight: AbortController | null = null;
  let runNo = 0;
  let last: Run | null = null;

  const current = (): Endpoint | undefined => {
    const eps = s.agg().endpoints;
    return eps.find((e) => e.id === selected) ?? eps[0];
  };

  function select(id: string) {
    if (id !== selected) files = new Map();
    selected = id;
  }

  /** Profile switch / Close: cancel owned work and forget anything from the old profile. */
  function stop() {
    inflight?.abort();
    inflight = null;
    selected = null;
    files = new Map();
    last = null;
  }

  async function run(ep: Endpoint) {
    if (inflight) return; // one owned request at a time
    const agg = s.agg();
    const p = prepare(agg, ep, kit.rt.origin, pageSources(), files); // values re-resolved at dispatch
    if (p.blocked.length) { kit.announce(`Not sent: ${p.blocked[0]}`); return; }
    const ctl = new AbortController();
    inflight = ctl;
    const r: Run = { no: ++runNo, endpointId: ep.id, name: ep.name, mode, at: new Date(), prepared: p, checks: structuredClone(ep.checks), result: null, outcomes: [] };
    last = r;
    kit.announce(`Run #${r.no} sending ${ep.name}${mode === 'direct' ? ' directly' : ' through active rules'}.`);
    draw?.();
    const res = await send(p, mode === 'direct' ? kit.fetchers.direct : kit.fetchers.rules, ctl.signal, agg.profile.settings.bodyCheckKb * 1024);
    if (inflight === ctl) inflight = null;
    if (last !== r) return; // profile switched or closed meanwhile
    r.result = res;
    r.outcomes = evaluate(r.checks, res);
    const failed = r.outcomes.filter((o) => o.state === 'failed').length;
    kit.announce(`Run #${r.no}: ${outcomeText(res)}${r.outcomes.length ? ` · ${failed ? `${failed} check(s) failed` : r.outcomes.every((o) => o.state === 'passed') ? 'checks passed' : 'some checks not evaluated'}` : ''}.`);
    draw?.();
  }

  let draw: (() => void) | null = null;

  function screen(): Built {
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
      const p = ep && prepare(agg, ep, kit.rt.origin, pageSources(), files);
      const prevSig = JSON.stringify([p && { ...p, body: null }, [...files].map(([i, f]) => [i, f.name, f.size])]);
      if (prevSig !== shownPreview) { // traffic updates must not rebuild file inputs or move focus
        shownPreview = prevSig;
        preview.replaceChildren(...(ep && p ? previewNodes(ep, p) : []));
      }
      const resSig = last ? `${last.no}|${last.result ? 'done' : 'pending'}` : 'none';
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
      const runBtn = btn([icon('play', 'aw-i aw-i14'), 'Run'], () => run(ep), 'aw-btn aw-pri', { id: 'aw-once-run', 'data-key': 'once-run' });
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
        return [h('div', { class: 'aw-row aw-gap6 aw-xs' }, h('span', { class: 'aw-mono' }, part.name), f,
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
        p.blocked.length ? h('div', { class: 'aw-alert aw-col aw-gap4', id: 'aw-once-blocked' }, h('strong', {}, 'Cannot send yet'), ...p.blocked.map((b) => h('div', { class: 'aw-wrap' }, b))) : null,
        h('p', { class: 'aw-hint aw-wrap' }, 'Values are read again when you press Run. Secret-looking values are masked here. Nothing is sent until Run.'))];
    }

    function resultNodes(r: Run): Node[] {
      const res = r.result;
      const ident = `Run #${r.no} · ${r.name} · ${r.mode === 'direct' ? 'Direct' : 'Apply rules'} · ${r.at.toLocaleTimeString()}`;
      if (!res) return [section('Result', h('div', { class: 'aw-xs aw-mu' }, ident), h('div', { class: 'aw-row aw-gap6' }, h('span', { class: 'aw-bd aw-am' }, 'pending'), `${r.prepared.method} ${r.prepared.url}`))];
      const failed = r.outcomes.filter((o) => o.state === 'failed').length;
      const notEval = r.outcomes.filter((o) => o.state === 'not-evaluated').length;
      const verdict = res.outcome !== 'response' ? (res.outcome === 'aborted' ? ['aw-am', 'Cancelled'] : ['aw-rd', 'Network error'])
        : !r.outcomes.length ? ['', 'Response received · no checks']
        : failed ? ['aw-rd', `${failed} check${failed > 1 ? 's' : ''} failed`]
        : notEval ? ['aw-am', `${notEval} check${notEval > 1 ? 's' : ''} not evaluated`] : ['aw-gr', 'Checks passed'];
      const nodes: Node[] = [
        h('div', { class: 'aw-xs aw-mu', id: 'aw-once-ident' }, ident),
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
          ep ? btn('Add check', () => kit.editEndpoint(ep.id, (d) => (d as Endpoint).checks.push({ kind: 'status', min: res.status!, max: res.status! }))) : null));
      } else if (res.error) nodes.push(h('p', { class: 'aw-hint aw-wrap' }, res.error));
      return [section('Result', ...nodes)];
    }

    refresh();
    return {
      nodes: [
        h('div', { class: 'aw-row aw-gap10' }, tile('flask'), h('div', { class: 'aw-grow' }, heading('API Tester'), h('div', { class: 'aw-xs aw-mu' }, 'Once: send one endpoint. Plans and Load arrive in a later build.')),
          btn([icon('book', 'aw-i aw-i14'), 'Endpoints'], () => kit.go('endpoints'), 'aw-btn aw-out aw-sm', { 'data-key': 'test-endpoints' })),
        top, preview, resultEl,
      ],
      refresh,
    };
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

  return { screen, select, stop };
}

function outcomeText(r: OnceResult): string {
  if (r.outcome === 'aborted') return `Cancelled after ${r.ms} ms`;
  if (r.outcome === 'network-error') return `No HTTP response after ${r.ms} ms (network failure, CORS or browser policy)`;
  return `HTTP ${r.status}${r.statusText ? ` ${r.statusText}` : ''} · ${r.ms} ms observed · ${r.body.bytes} bytes`;
}
