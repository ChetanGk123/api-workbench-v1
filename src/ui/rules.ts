// Rule modules (R4): Mock, Intercept, Route and Chaos lists and editors over durable profile rules.
// Saved rules change only through session edits; activation is runtime-only. Editors hold detached
// drafts and never send anything: previews run the pure planner/patch code over typed or sample data.
import {
  BODYLESS, CHAOS_MODES, linkedMatcher, meaningfulRuleChange, METHODS, newRule, newSlot,
  type Aggregate, type ChaosFault, type ChaosFaultKind, type ChaosRule, type Diag, type InterceptRule, type Matcher, type MockRule,
  type PatchOp, type RouteRule, type Rule, type RuleKind, type Transform, validateRuleIn,
} from '../data/schema';
import { describeFault, LIMITS, matches, routedUrl, ruleName, type Config, type Module, byPrecedence } from '../net/plan';
import { transformBody } from '../net/patch';
import type { ReqRecord } from '../net/runtime';
import { h, icon, type IconName } from './dom';
import {
  btn, checkbox, countBadge, Errors, field, heading, input, methodBadge, pairRows, section, select, textarea, tile,
  type Built, type Form, type Kit, type Ret,
} from './kit';

export const MOD: Record<Module, { title: string; home: string; tab: string; icon: IconName; noun: string; effect: string; about: string }> = {
  mock: { title: 'Mock Server', home: 'Mock Server', tab: 'Mock', icon: 'server', noun: 'mock rule', effect: 'replies served', about: 'Matching requests get a synthetic reply: nothing is sent to the server. Rules match the original request; a synthetic chaos fault wins over a mock.' },
  intercept: { title: 'Interceptor', home: 'API Interceptor', tab: 'Intercept', icon: 'shuffle', noun: 'intercept rule', effect: 'requests/responses edited', about: 'Edits headers, JSON fields, literal text and status of matching requests and responses. Binary, streaming, opaque or over-1 MiB bodies are left unchanged with a reason; header and status edits still apply.' },
  route: { title: 'Page Routing', home: 'Page Routing', tab: 'Route', icon: 'route', noun: 'route rule', effect: 'routed', about: 'Sends matching page requests to another origin. The original query is kept. Browser CORS and cookie policies still apply; this is not a proxy.' },
  chaos: { title: 'Chaos Engineering', home: 'Chaos Engineering', tab: 'Chaos', icon: 'flame', noun: 'chaos rule', effect: 'faults applied', about: 'Synthetic faults reply without contacting the server. Real faults send the request first, so the server may act on it even when the page sees a failure.' },
};

type Preset = { label: string; mode: ChaosRule['mode']; fault: ChaosFault };
const PRESETS: Preset[] = [
  { label: 'Slow API', mode: 'real', fault: { kind: 'latency', delayMs: 1000 } },
  { label: 'Very slow API', mode: 'real', fault: { kind: 'latency', delayMs: 5000 } },
  { label: 'Random latency', mode: 'real', fault: { kind: 'random-latency', minMs: 250, maxMs: 2000 } },
  { label: 'Server error 500', mode: 'synthetic', fault: { kind: 'status', status: 500, body: '' } },
  { label: 'Service unavailable 503', mode: 'synthetic', fault: { kind: 'status', status: 503, body: '' } },
  { label: 'Bad gateway 502', mode: 'synthetic', fault: { kind: 'status', status: 502, body: '' } },
];
const MORE: Preset[] = [
  { label: 'Timeout', mode: 'synthetic', fault: { kind: 'timeout', timeoutMs: 3000 } },
  { label: 'Network failure', mode: 'synthetic', fault: { kind: 'network-error' } },
  { label: 'Malformed JSON', mode: 'real', fault: { kind: 'malformed-json', text: '{"data": [1, 2,' } },
  { label: 'Corrupt JSON field', mode: 'real', fault: { kind: 'corrupt-json', patch: [{ op: 'replace', path: '/id', value: null }] } },
  { label: 'Request replay', mode: 'real', fault: { kind: 'replay', copies: 1, gapMs: 0 } },
];
const FAULTS: [ChaosFaultKind, string][] = [
  ['status', 'HTTP error status'], ['latency', 'Latency (fixed)'], ['random-latency', 'Latency (random range)'], ['network-error', 'Network failure'],
  ['timeout', 'Timeout'], ['malformed-json', 'Malformed JSON text'], ['corrupt-json', 'Corrupt valid JSON fields'], ['replay', 'Replay (send copies)'],
];
const FAULT_DEFAULT: Record<ChaosFaultKind, ChaosFault> = {
  status: { kind: 'status', status: 503, body: '' }, latency: { kind: 'latency', delayMs: 1000 }, 'random-latency': { kind: 'random-latency', minMs: 250, maxMs: 2000 },
  'network-error': { kind: 'network-error' }, timeout: { kind: 'timeout', timeoutMs: 3000 }, 'malformed-json': { kind: 'malformed-json', text: '{"data": [1, 2,' },
  'corrupt-json': { kind: 'corrupt-json', patch: [{ op: 'replace', path: '/id', value: null }] }, replay: { kind: 'replay', copies: 1, gapMs: 0 },
};

/** Saved rules with linked endpoints resolved to their current method/origin/path. */
export function compileRules(agg: Aggregate): Rule[] {
  return agg.rules.map((r) => {
    const e = r.endpointId ? agg.endpoints.find((x) => x.id === r.endpointId) : undefined;
    return e ? { ...r, matcher: { ...r.matcher, ...linkedMatcher(agg, e) } } : r;
  });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function ruleSummary(r: Rule): string {
  switch (r.kind) {
    case 'mock': {
      const s = r.slots[0]!;
      return r.mode === 'static' ? (s.fault === 'none' ? `→ ${s.status}` : `→ ${s.fault}`) : `${plural(r.slots.length, 'reply', 'replies')} · then ${r.exhaustion === 'network-error' ? 'network error' : r.exhaustion}`;
    }
    case 'intercept': {
      const t = (x: Transform) => [x.status && `status ${x.status}`, x.setHeaders.length + x.removeHeaders.length && plural(x.setHeaders.length + x.removeHeaders.length, 'header'), x.patch.length && plural(x.patch.length, 'patch op'), x.replace && 'replace'].filter(Boolean).join(', ');
      const brk = [r.breakRequest && 'request', r.breakResponse && 'response'].filter(Boolean).join(' + ');
      return [brk && `breaks on ${brk}`, t(r.request) && `request: ${t(r.request)}`, t(r.response) && `response: ${t(r.response)}`].filter(Boolean).join(' · ');
    }
    case 'route': return `→ ${r.destinationOrigin}${r.pathRewrite || ''}`;
    case 'chaos': return `${r.mode} · ${FAULTS.find(([k]) => k === r.fault.kind)![1]} · ${r.probability}%${r.budget ? ` · budget ${r.budget}` : ''}`;
  }
}

export function createRulesUi(kit: Kit, deps: {
  traffic(filter: (r: ReqRecord) => boolean, empty: string, badge?: HTMLElement): { el: HTMLElement; refresh(): void };
  statusBadge(active: boolean): HTMLElement;
}) {
  const s = kit.session;
  const rt = kit.rt;
  const cfg = () => rt.config();

  // ---------- activation and config

  /** Install the session's rules into the runtime, keeping activation. Called on every session change. */
  let lastSig = '';
  let lastProfile = '';
  function sync() {
    const agg = s.agg();
    const rules = compileRules(agg);
    let active = cfg().active;
    if (lastProfile && lastProfile !== agg.profile.id) {
      const n = rt.releasePauses('Profile switched');
      const was = Object.values(active).some(Boolean);
      active = { mock: false, intercept: false, route: false, chaos: false };
      if (was || n) kit.announce(`Profile switched: every module is now inactive.${n ? ` ${n} paused item${n > 1 ? 's' : ''} continued unchanged.` : ''}`);
    }
    lastProfile = agg.profile.id;
    const sig = JSON.stringify([rules, active]);
    if (sig === lastSig) return;
    lastSig = sig;
    rt.setConfig({ active, rules });
  }

  function setActive(m: Module, v: boolean) {
    rt.setConfig({ rules: cfg().rules, active: { ...cfg().active, [m]: v } });
    lastSig = JSON.stringify([cfg().rules, cfg().active]);
    kit.announce(`${MOD[m].tab} module ${v ? 'activated' : 'deactivated'}.${v ? '' : ' Requests already in progress keep their selected behavior.'}`);
  }
  function stopAll() {
    rt.setConfig({ rules: cfg().rules, active: { mock: false, intercept: false, route: false, chaos: false } });
    lastSig = JSON.stringify([cfg().rules, cfg().active]);
    const n = rt.releasePauses('Stop all');
    kit.announce(`All modules deactivated.${n ? ` ${n} paused item${n > 1 ? 's' : ''} continued unchanged.` : ''} Requests already in progress keep their selected behavior.`);
  }

  const rulesOf = (m: Module) => s.agg().rules.filter((r) => r.kind === m).sort(byPrecedence);
  const enabledCount = (m: Module) => rulesOf(m).filter((r) => r.enabled).length;

  /** Counters by operation state for one module, over retained records. */
  function counts(m: Module) {
    const c = { matched: 0, applied: 0, skipped: 0, superseded: 0, 'sampled-out': 0 };
    for (const r of rt.records()) {
      const ops = r.ops.filter((o) => o.module === m);
      if (!ops.length) continue;
      c.matched++;
      if (ops.some((o) => o.state === 'applied')) c.applied++;
      else if (ops.some((o) => o.state === 'superseded')) c.superseded++;
      else if (ops.some((o) => o.state === 'sampled-out')) c['sampled-out']++;
      else if (ops.some((o) => o.state === 'skipped' || o.state === 'failed')) c.skipped++;
    }
    return c;
  }

  /** Runtime state of one rule, from reservations (never from saved fields). */
  function liveState(r: Rule): string {
    if (!cfg().active[r.kind] || !r.enabled) return '';
    const st = rt.states.get(r.id);
    if (r.kind === 'mock' && r.mode === 'sequence') {
      const used = st?.cursor ?? 0;
      return used < r.slots.length ? `next reply ${used + 1} of ${r.slots.length}` : r.exhaustion === 'network-error' ? 'exhausted: network error' : r.exhaustion === 'loop' ? `looping: next reply ${(used % r.slots.length) + 1}` : 'repeating last reply';
    }
    if (r.kind === 'chaos') {
      const parts: string[] = [];
      if (r.budget) parts.push(`${Math.min(st?.hits ?? 0, r.budget)}/${r.budget} hits used`);
      if (r.durationMs && st) {
        const left = r.durationMs - (performance.now() - st.armedAt);
        parts.push(left > 0 ? `${Math.ceil(left / 1000)} s left` : 'active period ended');
      }
      return parts.join(' · ');
    }
    return '';
  }

  // ---------- list screen

  function screen(m: Module): Built {
    const badgeSlot = h('span', {});
    const act = btn('', () => setActive(m, !cfg().active[m]), 'aw-btn', { 'data-key': `act-${m}` });
    const actHint = h('span', { class: 'aw-hint', id: `aw-act-${m}-hint` });
    act.setAttribute('aria-describedby', actHint.id);
    const stats = h('div', { class: 'aw-xs aw-mu aw-wrap', 'aria-live': 'polite' });
    const ruleCount = countBadge();
    const list = h('div', { class: 'aw-col aw-gap8' });
    const tCount = countBadge();
    const t = deps.traffic((r) => r.ops.some((o) => o.module === m) || (m === 'chaos' && r.source === 'replay'), `No ${MOD[m].tab.toLowerCase()} traffic yet`, tCount);
    const addBtn = btn([icon('plus', 'aw-i aw-i14'), 'New rule'], () => openEditor(m, null, kit.here()), 'aw-btn aw-dash', { 'data-key': `new-${m}` });
    const fromEp = endpointPicker((id) => openEditor(m, null, kit.here(), { endpointId: id }));
    let shown = '';

    const presets = m === 'chaos'
      ? section('Presets',
        h('p', { class: 'aw-hint aw-m0' }, 'A preset opens a draft. Choose what it applies to, then save; nothing changes until you activate Chaos.'),
        h('div', { class: 'aw-g2' }, ...PRESETS.map((p) => btn(p.label, () => openEditor('chaos', null, kit.here(), { preset: p }), 'aw-btn aw-out aw-sm'))),
        h('details', {}, h('summary', { class: 'aw-xs aw-mu' }, 'More…'), h('div', { class: 'aw-g2 aw-mt2' }, ...MORE.map((p) => btn(p.label, () => openEditor('chaos', null, kit.here(), { preset: p }), 'aw-btn aw-out aw-sm')))))
      : null;

    function draw() {
      const rules = rulesOf(m);
      const sig = JSON.stringify([rules, s.agg().endpoints.map((e) => [e.id, e.name])]);
      if (sig !== shown && !list.contains(kit.root.activeElement)) {
        shown = sig;
        const linked = rules.filter((r) => r.endpointId), adhoc = rules.filter((r) => !r.endpointId);
        list.replaceChildren(
          ...(rules.length ? [] : [h('div', { class: 'aw-empty aw-wrap' }, `No ${MOD[m].noun}s yet. Create one, or start from an endpoint.`)]),
          ...(linked.length ? [h('div', { class: 'aw-cap aw-capl' }, 'Linked to endpoints'), h('ol', { class: 'aw-card aw-list aw-rulelist', 'aria-label': 'Linked rules' }, ...linked.map(row))] : []),
          ...(adhoc.length ? [h('div', { class: 'aw-cap aw-capl' }, 'Ad-hoc rules'), h('ol', { class: 'aw-card aw-list aw-rulelist', 'aria-label': 'Ad-hoc rules' }, ...adhoc.map(row))] : []),
        );
      }
      for (const el of list.querySelectorAll<HTMLElement>('[data-live]')) {
        const r = rules.find((x) => x.id === el.dataset.live);
        el.textContent = r ? liveState(r) : '';
      }
      const active = cfg().active[m];
      const n = enabledCount(m);
      badgeSlot.replaceChildren(deps.statusBadge(active));
      act.className = `aw-btn ${active ? 'aw-out' : 'aw-pri'}`;
      act.replaceChildren(icon(active ? 'stop' : 'play', 'aw-i aw-i14'), active ? 'Deactivate' : 'Activate');
      act.setAttribute('aria-label', `${active ? 'Deactivate' : 'Activate'} ${MOD[m].tab} module`);
      act.disabled = !active && !n;
      act.classList.toggle('aw-dis', act.disabled);
      actHint.textContent = active && !n ? 'Active, but no enabled rule: traffic is unaffected.' : !active && !rules.length ? 'Add a rule first.' : !active && !n ? 'Enable a rule first.' : !active ? 'Inactive: saved rules do not affect traffic.' : '';
      ruleCount.textContent = String(rules.length);
      const c = counts(m);
      stats.textContent = `${n} of ${plural(rules.length, 'rule')} enabled · matched ${c.matched} · applied ${c.applied} · skipped ${c.skipped} · superseded ${c.superseded}${m === 'chaos' ? ` · sampled out ${c['sampled-out']}` : ''}`;
      fromEp.refresh();
      t.refresh();
    }

    return {
      nodes: [
        h('div', { class: 'aw-row aw-gap10' }, tile(MOD[m].icon), heading(MOD[m].title), badgeSlot),
        h('p', { class: 'aw-hint aw-wrap aw-m0' }, MOD[m].about),
        h('div', { class: 'aw-col aw-gap6 aw-start' }, act, actHint),
        stats,
        ...(presets ? [presets] : []),
        h('div', { class: 'aw-col aw-gap8' }, h('div', { class: 'aw-row' }, h('span', { class: 'aw-lbl' }, 'Rules'), ruleCount), list,
          h('div', { class: 'aw-g2' }, addBtn, fromEp.el)),
        h('div', { class: 'aw-col aw-gap8' }, h('div', { class: 'aw-row' }, h('span', { class: 'aw-lbl' }, 'Traffic'), tCount), t.el),
      ],
      refresh: draw,
    };
  }

  function row(r: Rule): HTMLElement {
    const name = ruleName(r);
    const ep = r.endpointId ? s.agg().endpoints.find((e) => e.id === r.endpointId) : undefined;
    const m = r.matcher;
    const open = btn([
      h('span', { class: 'aw-row aw-gap6' }, h('span', { class: 'aw-rname' }, name), r.priority ? h('span', { class: 'aw-bd aw-h18' }, `priority ${r.priority}`) : null, ep ? h('span', { class: 'aw-bd aw-h18', title: 'Method and URL follow this endpoint' }, `↔ ${ep.name}`) : null),
      h('span', { class: 'aw-row aw-mono aw-meta' }, methodBadge(m.method), h('span', { class: 'aw-tr' }, `${m.origin && m.origin !== rt.origin ? m.origin : ''}${m.path}`)),
      h('span', { class: 'aw-xs aw-mu aw-wrap' }, ruleSummary(r)),
      h('span', { class: 'aw-xs aw-am', 'data-live': r.id }),
    ], () => openEditor(r.kind, r.id, kit.here()), 'aw-grow aw-col aw-rulebtn', { 'aria-label': `Edit ${name}`, 'data-key': `rule-${r.id}` });
    const cb = checkbox(`Enable ${name}`, r.enabled, async (v) => {
      const out = await s.edit((a) => { const x = a.rules.find((y) => y.id === r.id); if (x) x.enabled = v; });
      kit.announce(out ? `Not changed: ${out[0]!.message}` : `${name} ${v ? 'enabled' : 'disabled'}${cfg().active[r.kind] ? '; affects the next matching request' : ''}.`);
    });
    const del = btn([icon('trash', 'aw-i aw-i14')], () => remove(r), 'aw-btn aw-gh aw-ic aw-sm', { 'aria-label': `Delete ${name}` });
    return h('li', { class: 'aw-row aw-rule' }, cb, open, del);
  }

  async function remove(r: Rule, after?: () => void) {
    const name = ruleName(r);
    const v = await kit.ask(`Delete ${name}?${cfg().active[r.kind] && r.enabled ? ` ${MOD[r.kind].tab} is active: the next matching request is no longer affected.` : ''} Requests already in progress keep their selected behavior.`, [
      { label: 'Cancel', cls: 'aw-out', value: 'cancel' }, { label: 'Delete', cls: 'aw-dst', value: 'delete' },
    ]);
    if (v !== 'delete') return;
    const out = await s.edit((a) => { a.rules = a.rules.filter((x) => x.id !== r.id); });
    kit.announce(out ? `Not deleted: ${out[0]!.message}` : `${name} deleted.`);
    if (!out) after?.();
  }

  /** "From endpoint" control: a labelled select that opens a linked draft. */
  function endpointPicker(pick: (id: string) => void) {
    const sel = h('select', { class: 'aw-in aw-select', 'aria-label': 'New rule from endpoint' });
    let shown = '';
    sel.addEventListener('change', () => { if (sel.value) { const id = sel.value; sel.value = ''; pick(id); } });
    const refresh = () => {
      const eps = s.agg().endpoints;
      const sig = JSON.stringify(eps.map((e) => [e.id, e.name, e.request.method]));
      if (sig === shown) return;
      shown = sig;
      sel.replaceChildren(h('option', { value: '' }, eps.length ? 'From endpoint…' : 'From endpoint (none saved)'), ...eps.map((e) => h('option', { value: e.id }, `${e.request.method} ${e.name}`)));
      sel.disabled = !eps.length;
    };
    refresh();
    return { el: sel, refresh };
  }

  // ---------- editor

  function openEditor(m: RuleKind, id: string | null, ret: Ret, o: { endpointId?: string; preset?: Preset } = {}) {
    const agg = s.agg();
    const existing = id ? agg.rules.find((r) => r.id === id) : undefined;
    if (id && !existing) { kit.announce('That rule no longer exists.'); return; }
    const draft: Rule = existing ? structuredClone(existing) : newRule(agg, m);
    const notes: string[] = [];
    if (!existing && o.endpointId) {
      const e = agg.endpoints.find((x) => x.id === o.endpointId)!;
      draft.endpointId = e.id;
      draft.label = e.name;
      draft.matcher = { ...draft.matcher, ...linkedMatcher(agg, e) };
      if (draft.kind === 'mock') {
        if (!e.sample) notes.push(`${e.name} has no saved sample; the reply starts as {} and is yours to fill.`);
        else if (e.sample.bodyState === 'truncated') notes.push(`${e.name}'s sample was truncated when captured, so it was not copied: a cut-off body is not a complete reply.`);
        else {
          draft.slots[0] = { ...newSlot(), status: e.sample.status, headers: e.sample.headers.filter(([k]) => !/^(content-length|content-encoding|set-cookie2?)$/i.test(k)), body: BODYLESS.has(e.sample.status) ? '' : e.sample.body };
          notes.push(`Reply copied from ${e.name}'s ${e.sample.source} sample${e.sample.bodyState === 'redacted' ? '; redacted values ({{$redacted}}) are replied literally until you replace them' : ''}.`);
        }
      }
    }
    if (!existing && o.preset && draft.kind === 'chaos') {
      draft.label = o.preset.label;
      draft.mode = o.preset.mode;
      draft.fault = structuredClone(o.preset.fault);
      notes.push(`${o.preset.label}: choose a method and path (or link an endpoint) before saving. The preset applies to nothing until then.`);
    }
    const base = JSON.stringify(draft);
    // Raw JSON Patch text per transform: the draft's source of truth until saved.
    const raw = { request: '', response: '', corrupt: '' };
    if (draft.kind === 'intercept') { raw.request = patchText(draft.request.patch); raw.response = patchText(draft.response.patch); }
    if (draft.kind === 'chaos' && draft.fault.kind === 'corrupt-json') raw.corrupt = patchText(draft.fault.patch);
    const rawBase = JSON.stringify(raw);
    const faultCache: Partial<Record<ChaosFaultKind, ChaosFault>> = {};
    const errs = new Errors();

    const form: Form = {
      owner: m,
      ret,
      dirty: () => JSON.stringify(draft) !== base || JSON.stringify(raw) !== rawBase,
      async save() {
        const parsed = compilePatches(draft, raw);
        if (parsed.length) { errs.show(parsed, kit.announce); return false; }
        draft.label = draft.label.trim();
        draft.matcher.path = draft.matcher.path.trim();
        draft.matcher.origin = draft.matcher.origin.trim().replace(/\/$/, '');
        if (draft.kind === 'route') draft.destinationOrigin = draft.destinationOrigin.trim().replace(/\/$/, '');
        const cur = s.agg();
        const prev = cur.rules.find((r) => r.id === draft.id);
        const next = structuredClone(draft);
        if (prev && meaningfulRuleChange(prev, next)) next.revision = prev.revision + 1;
        const diags = validateRuleIn(cur, next);
        if (errs.show(diags, kit.announce)) return false;
        const out = await s.edit((a) => {
          const i = a.rules.findIndex((r) => r.id === next.id);
          if (i >= 0) a.rules[i] = next; else a.rules.push(next);
        });
        if (out && errs.show(out.map((d) => ({ ...d, path: d.path.replace(/^rules\.\d+\./, '') })), kit.announce)) return false;
        draft.revision = next.revision;
        const affects = cfg().active[m] && next.enabled;
        kit.announce(`${ruleName(next)} saved${s.persist() === 'session-only' ? ' for this page session (storage unavailable)' : ''}.${affects ? ' It applies to the next matching request.' : ` ${MOD[m].tab} is inactive: traffic is unchanged until you activate it.`}${prev && prev.revision !== next.revision && (m === 'mock' || m === 'chaos') ? ' Sequence and budget state restart.' : ''}`);
        return true;
      },
      build: () => editorScreen(),
    };

    function editorScreen(): Built {
      errs.clear();
      const cur = s.agg();
      const save = btn([icon('save', 'aw-i aw-i14'), 'Save'], async () => { if (await form.save()) kit.closeForm(ret.screen === m ? `rule-${draft.id}` : ret.focus); }, 'aw-btn aw-pri aw-grow');
      const second = existing
        ? btn([icon('trash', 'aw-i aw-i14')], () => remove(existing, () => kit.closeForm(null)), 'aw-btn aw-dst aw-ic', { 'aria-label': `Delete ${ruleName(existing)}` })
        : btn('Cancel', () => kit.leaveForm(), 'aw-btn aw-out aw-grow');
      kit.foot.replaceChildren(save, ...(existing ? [btn('Cancel', () => kit.leaveForm(), 'aw-btn aw-out aw-grow'), second] : [second]));
      kit.foot.hidden = false;
      return {
        nodes: [
          h('div', { class: 'aw-row' }, kit.backButton(ret.screen, () => kit.leaveForm()), heading(`${existing ? 'Edit' : 'New'} ${MOD[m].noun}`)),
          ...notes.map((n) => h('div', { class: 'aw-alert aw-notice aw-wrap', role: 'status' }, icon('info', 'aw-i aw-i14'), n)),
          errs.summary,
          field('Label', input(draft.label, (v) => { draft.label = v; }, { id: 'aw-r-label', placeholder: `e.g. ${MOD[m].tab} accounts` }), errs, 'label', 'A label change keeps sequence position and budgets.'),
          matcherSection(cur),
          ...actionSections(cur),
          h('div', { class: 'aw-row aw-gap8 aw-top' },
            h('div', { class: 'aw-w104' }, field('Priority', input(String(draft.priority), (v) => { draft.priority = v.trim() === '' ? NaN : Number(v); }, { mono: true, id: 'aw-r-priority' }), errs, 'priority')),
            h('div', { class: 'aw-grow aw-col aw-gap6 aw-mt2' },
              h('div', { class: 'aw-chk' }, checkbox('Rule enabled', draft.enabled, (v) => { draft.enabled = v; }), 'Rule enabled', h('span', { class: 'aw-mu' }, `— does not activate ${MOD[m].tab}`)),
              h('span', { class: 'aw-hint aw-wrap' }, 'Higher priority wins; equal priorities go to the older rule. One rule per module acts on a request.'))),
          h('p', { class: 'aw-hint aw-wrap aw-m0' }, cfg().active[m]
            ? `${MOD[m].tab} is active: saving an enabled rule affects the next matching request.`
            : `${MOD[m].tab} is inactive: saving does not change traffic until you activate it.`),
        ],
      };
    }

    function matcherSection(cur: Aggregate): HTMLElement {
      const mt = draft.matcher;
      const ep = draft.endpointId ? cur.endpoints.find((e) => e.id === draft.endpointId) : undefined;
      const linkSel = select<string>(draft.endpointId ?? '', [['', 'None (ad-hoc rule)'], ...cur.endpoints.map((e): [string, string] => [e.id, `${e.request.method} ${e.name}`])], (v) => {
        if (v) { const e = cur.endpoints.find((x) => x.id === v)!; draft.endpointId = v; Object.assign(draft.matcher, linkedMatcher(cur, e)); }
        else delete draft.endpointId;
        kit.openForm(form);
      }, { id: 'aw-r-link' });
      const linked = !!ep;
      const methodSel = select<Matcher['method']>(mt.method, [['*', '* (any)'], ...METHODS.map((x): [Matcher['method'], string] => [x, x])], (v) => { mt.method = v; }, { id: 'aw-r-method' });
      const pathIn = input(mt.path, (v) => { mt.path = v; }, { mono: true, id: 'aw-r-path', placeholder: '/api/accounts or /api/**' });
      const originIn = input(mt.origin, (v) => { mt.origin = v; }, { mono: true, id: 'aw-r-origin', placeholder: `Blank = ${rt.origin}` });
      for (const el of [methodSel, pathIn, originIn]) el.toggleAttribute('disabled', linked);
      const detach = linked ? btn('Detach to edit the matcher', () => {
        Object.assign(draft.matcher, linkedMatcher(cur, ep!));
        delete draft.endpointId;
        notes.push(`Detached from ${ep!.name}: the matcher keeps ${draft.matcher.method} ${draft.matcher.path} and no longer follows the endpoint.`);
        kit.openForm(form);
      }, 'aw-btn aw-out aw-sm') : null;
      return section('Match',
        field('Linked endpoint', linkSel, errs, 'endpointId', linked ? `Method and URL follow ${ep!.name} by ID, including renames and environment changes.` : 'Ad-hoc: the matcher below is used as written.'),
        h('div', { class: 'aw-row aw-top aw-gap8' },
          h('div', { class: 'aw-w104' }, field('Method', methodSel, errs, 'matcher.method')),
          h('div', { class: 'aw-grow' }, field('Path', pathIn, errs, 'matcher.path', '* matches within one segment; ** across segments. Query is matched separately.'))),
        field('Origin', originIn, errs, 'matcher.origin'),
        detach,
        h('details', { open: mt.query.length || mt.headers.length || mt.bodyContains ? true : undefined },
          h('summary', { class: 'aw-xs aw-mu' }, 'Conditions (all must hold)'),
          h('div', { class: 'aw-col aw-gap8 aw-mt2' },
            h('span', { class: 'aw-lbl' }, 'Query parameters (blank value = present)'), pairRows(mt.query, 'query condition', errs, 'matcher.query'),
            h('span', { class: 'aw-lbl' }, 'Request headers (case-insensitive name; blank value = present)'), pairRows(mt.headers, 'header condition', errs, 'matcher.headers'),
            field('Body contains', input(mt.bodyContains, (v) => { mt.bodyContains = v; }, { mono: true, id: 'aw-r-body-contains' }), errs, 'matcher.bodyContains',
              'Literal text. Only string and URL-encoded bodies up to 1 MiB are checked; any other body is “not evaluated” and does not match.'))));
    }

    function actionSections(cur: Aggregate): HTMLElement[] {
      switch (draft.kind) {
        case 'mock': return [mockSection(draft)];
        case 'intercept': return [breakSection(draft), transformSection(draft, 'request', cur), transformSection(draft, 'response', cur)];
        case 'route': return [routeSection(draft)];
        case 'chaos': return [chaosSection(draft)];
      }
    }

    function mockSection(d: MockRule): HTMLElement {
      const slotsEl = h('div', { class: 'aw-col aw-gap10' });
      const draw = () => {
        slotsEl.replaceChildren(...d.slots.map((sl, i) => {
          const p = `slots.${i}`;
          const n = d.slots.length;
          const status = input(String(sl.status), (v) => { sl.status = v.trim() === '' ? NaN : Number(v); }, { mono: true, id: `aw-slot-${i}-status` });
          const fault = select(sl.fault, [['none', 'HTTP reply'], ['network-error', 'Network failure'], ['timeout', 'Timeout']], (v) => { sl.fault = v; draw(); }, { id: `aw-slot-${i}-fault` });
          const body = textarea(sl.body, (v) => { sl.body = v; showJson(); }, { id: `aw-slot-${i}-body`, rows: 4 });
          const jsonState = h('span', { class: 'aw-hint' });
          const showJson = () => {
            const ct = sl.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
            if (!/json/i.test(ct) || !sl.body) { jsonState.textContent = ''; return; }
            try { JSON.parse(sl.body); jsonState.textContent = 'Valid JSON'; } catch (e) { jsonState.textContent = `Not valid JSON (sent exactly as typed): ${(e as Error).message}`; }
          };
          showJson();
          const http = sl.fault === 'none';
          return h('div', { class: 'aw-card aw-cp aw-col aw-gap8', 'aria-label': `Reply ${i + 1}` },
            h('div', { class: 'aw-row' }, h('span', { class: 'aw-lbl aw-grow' }, n > 1 ? `Reply ${i + 1}` : 'Reply'),
              ...(d.mode === 'sequence' ? [
                btn('↑', () => { d.slots.splice(i - 1, 0, d.slots.splice(i, 1)[0]!); draw(); }, 'aw-btn aw-gh aw-ic aw-sm', { 'aria-label': `Move reply ${i + 1} up`, disabled: i === 0 }),
                btn('↓', () => { d.slots.splice(i + 1, 0, d.slots.splice(i, 1)[0]!); draw(); }, 'aw-btn aw-gh aw-ic aw-sm', { 'aria-label': `Move reply ${i + 1} down`, disabled: i === n - 1 }),
                btn([icon('x')], () => { d.slots.splice(i, 1); draw(); }, 'aw-btn aw-gh aw-ic aw-sm', { 'aria-label': `Remove reply ${i + 1}`, disabled: n === 1 }),
              ] : [])),
            h('div', { class: 'aw-g3' },
              field('Kind', fault, errs, `${p}.fault`),
              http ? field('Status', status, errs, `${p}.status`) : h('span', {}),
              field('Delay (ms)', input(String(sl.delayMs), (v) => { sl.delayMs = v.trim() === '' ? NaN : Number(v); }, { mono: true, id: `aw-slot-${i}-delay` }), errs, `${p}.delayMs`)),
            ...(http ? [
              h('span', { class: 'aw-lbl' }, 'Headers'), pairRows(sl.headers, 'reply header', errs, `${p}.headers`, showJson),
              field('Body', body, errs, `${p}.body`, `Sent exactly as typed. HEAD requests and ${[...BODYLESS].join('/')} replies have no body.`), jsonState,
            ] : [h('p', { class: 'aw-hint aw-m0 aw-wrap' }, sl.fault === 'timeout' ? 'Fetch rejects with a TimeoutError after the delay; XHR fires timeout. Nothing is sent.' : 'Fetch rejects with TypeError; XHR fires error. Nothing is sent.')]));
        }));
      };
      draw();
      const modeSel = select(d.mode, [['static', 'Static: one reply'], ['sequence', 'Sequence: replies in order']], (v) => {
        d.mode = v;
        if (v === 'static' && d.slots.length > 1) { notes.push(`Static keeps reply 1; replies 2–${d.slots.length} were removed from the draft (Cancel restores them).`); d.slots.length = 1; }
        kit.openForm(form);
      }, { id: 'aw-r-mode' });
      return section('Response',
        field('Mode', modeSel, errs, 'mode'),
        errLine('slots'),
        slotsEl,
        ...(d.mode === 'sequence' ? [
          btn([icon('plus', 'aw-i aw-i12'), 'Add reply'], () => { d.slots.push(newSlot()); draw(); }, 'aw-btn aw-dash aw-sm'),
          field('After the last reply', select(d.exhaustion, [['repeat-last', 'Repeat the last reply'], ['loop', 'Start again from reply 1'], ['network-error', 'Network failure (never real traffic)']], (v) => { d.exhaustion = v; }, { id: 'aw-r-exhaust' }), errs, 'exhaustion',
            'Each matching request takes the next reply when it starts. Saving a change to the replies, or activating Mock, starts again from reply 1.'),
        ] : []));
    }

    function errLine(path: string) {
      const el = h('span', { class: 'aw-err', role: 'alert' });
      errs.slot(path, el, el);
      return el;
    }

    function breakSection(d: InterceptRule): HTMLElement {
      return section('Breakpoints',
        h('div', { class: 'aw-chk' }, checkbox('Break on request', d.breakRequest, (v) => { d.breakRequest = v; }), 'Break on request', h('span', { class: 'aw-mu' }, '— before it is sent; edit or abort with zero server hits')),
        h('div', { class: 'aw-chk' }, checkbox('Break on response', d.breakResponse, (v) => { d.breakResponse = v; }), 'Break on response', h('span', { class: 'aw-mu' }, '— after the server answered, before the page sees it')),
        errLine('breakRequest'),
        h('p', { class: 'aw-hint aw-m0 aw-wrap' }, `Real traffic only: a mock or synthetic chaos reply is never paused. Each pause waits at most ${LIMITS.pauseDeadlineMs / 1000} s and then continues unchanged; at most ${LIMITS.pauses} are held at once and later ones pass through. A response pause happens after transforms and real chaos, so it is the final say.`));
    }

    function transformSection(d: InterceptRule, stage: 'request' | 'response', cur: Aggregate): HTMLElement {
      const t = d[stage];
      const p = stage;
      const removeIn = input(t.removeHeaders.join(', '), (v) => { t.removeHeaders = v.split(/[\s,]+/).filter(Boolean); }, { mono: true, id: `aw-${p}-remove`, placeholder: 'X-Debug, ETag' });
      const patchIn = textarea(raw[stage], (v) => { raw[stage] = v; }, { id: `aw-${p}-patch`, rows: 3 });
        const rep = t.replace ?? { find: '', with: '', scope: 'all' as const };
      const findIn = input(rep.find, (v) => { rep.find = v; t.replace = rep.find || rep.with ? rep : null; }, { mono: true, id: `aw-${p}-find` });
      const withIn = input(rep.with, (v) => { rep.with = v; t.replace = rep.find || rep.with ? rep : null; }, { mono: true, id: `aw-${p}-with` });
      const scope = select(rep.scope, [['all', 'Every occurrence'], ['first', 'First occurrence']], (v) => { rep.scope = v; }, { id: `aw-${p}-scope` });
      const builder = patchBuilder(() => raw[stage], (v) => { raw[stage] = v; patchIn.value = v; }, `${p}-b`);
      const preview = stage === 'response' ? samplePreview(d, cur) : null;
      return section(stage === 'request' ? 'Request transform' : 'Response transform',
        h('p', { class: 'aw-hint aw-m0 aw-wrap' }, stage === 'request'
          ? 'Applies to real requests before they are sent. A mock or synthetic chaos reply means no request, so it is superseded. Edits to a signed request are not re-signed: the server sees a changed request.'
          : 'Applies to real responses and to mock/synthetic HTTP replies. Transport failures have no response to edit.'),
        ...(stage === 'response' ? [field('Status', input(t.status ? String(t.status) : '', (v) => { t.status = v.trim() === '' ? 0 : Number(v); }, { mono: true, id: 'aw-response-status', placeholder: 'Blank keeps the original' }), errs, 'response.status')] : []),
        h('span', { class: 'aw-lbl' }, 'Set headers'), pairRows(t.setHeaders, `${stage} header`, errs, `${p}.setHeaders`),
        field('Remove headers', removeIn, errs, `${p}.removeHeaders`, 'Names separated by commas or spaces. Removal runs before set.'),
        field('JSON Patch (RFC 6902, raw JSON)', patchIn, errs, `${p}.patch`, 'All operations apply to a copy, or none do. __proto__, constructor and prototype paths are refused.'),
        builder,
        h('div', { class: 'aw-g2' }, field('Find text', findIn, errs, `${p}.replace.find`), field('Replace with', withIn, errs, `${p}.replace.with`)),
        field('Replace scope', scope, errs, `${p}.replace.scope`, 'Exact text, no regular expressions. Runs after the patch.'),
        ...(preview ? [preview] : []));
    }

    /** Local preview of the response transform over the linked endpoint's sample. Sends nothing. */
    function samplePreview(d: InterceptRule, cur: Aggregate): HTMLElement {
      const ep = d.endpointId ? cur.endpoints.find((e) => e.id === d.endpointId) : undefined;
      const out = h('pre', { class: 'aw-pre aw-mono aw-xs aw-wrap', 'aria-live': 'polite' });
      if (!ep?.sample) return h('p', { class: 'aw-hint aw-m0 aw-wrap' }, 'Link an endpoint with a saved sample to preview this transform locally.');
      const sample = ep.sample;
      return h('div', { class: 'aw-col aw-gap6' }, btn('Preview on sample', () => {
        const parsed = compilePatches(d, raw);
        if (parsed.length) { out.textContent = parsed.map((x) => x.message).join('\n'); return; }
        const t = d.response;
        const lines = [`Sample: ${sample.source}, HTTP ${sample.status}${sample.bodyState !== 'complete' ? ` (${sample.bodyState})` : ''}`];
        if (t.status) lines.push(`Status ${sample.status} → ${t.status}`);
        if (t.patch.length || t.replace) {
          if (sample.bodyState === 'truncated') lines.push('Body: sample is truncated, so a body preview would be misleading.');
          else {
            const r = transformBody(sample.body, t);
            lines.push(r.ok ? `Body (${r.did.join(', ')}):\n${r.text.slice(0, 4000)}` : `Body unchanged: ${r.reason}`);
          }
        }
        if (t.setHeaders.length || t.removeHeaders.length) lines.push(`Headers: set ${t.setHeaders.map(([k]) => k).join(', ') || 'none'}; remove ${t.removeHeaders.join(', ') || 'none'}`);
        out.textContent = lines.join('\n');
      }, 'aw-btn aw-out aw-sm'), out);
    }

    function routeSection(d: RouteRule): HTMLElement {
      const example = input('', () => show(), { mono: true, id: 'aw-route-example', placeholder: `${rt.origin}/api/example?a=1&a=2` });
      const out = h('div', { class: 'aw-xs aw-mono aw-wrap', 'aria-live': 'polite' });
      const show = () => {
        let u: URL;
        try { u = new URL(example.value || `${d.matcher.origin || rt.origin}${d.matcher.path.replace(/\*\*/g, 'a/b').replace(/\*/g, 'x') || '/'}?a=1&a=2`, rt.origin); } catch { out.textContent = 'Enter a full example URL'; return; }
        const dest = d.destinationOrigin.trim().replace(/\/$/, '');
        const m = matches({ ...d.matcher, headers: [], bodyContains: '' }, rt.origin, { transport: 'fetch', method: d.matcher.method === '*' ? 'GET' : d.matcher.method, url: u, headers: [], body: { text: '' }, sync: false });
        if (!m.match) { out.textContent = `${u.href} does not match this rule's method/origin/path/query.`; return; }
        try {
          const to = routedUrl({ ...d, destinationOrigin: dest }, u);
          const cross = to.origin !== u.origin;
          out.textContent = `${u.href}\n→ ${to.href}${cross ? `\nCross-origin: the browser applies CORS; Authorization is ${d.keepAuthorization ? `forwarded to ${to.origin}` : 'removed'}; cookies follow credentials ${d.credentials === 'caller' ? 'of the caller' : d.credentials}.` : ''}`;
        } catch { out.textContent = 'Enter a destination origin to preview.'; }
      };
      const re = () => show();
      const destIn = input(d.destinationOrigin, (v) => { d.destinationOrigin = v; re(); }, { mono: true, id: 'aw-route-dest', placeholder: 'http://localhost:8080' });
      const rwIn = input(d.pathRewrite, (v) => { d.pathRewrite = v; re(); }, { mono: true, id: 'aw-route-rewrite', placeholder: 'Blank keeps the original path' });
      queueMicrotask(show);
      return section('Destination',
        field('Destination origin', destIn, errs, 'destinationOrigin'),
        field('Path rewrite', rwIn, errs, 'pathRewrite', 'An exact path, or a trailing /** that receives what the matcher’s trailing /** captured.'),
        field('Credentials', select(d.credentials, [['caller', 'As the caller sent them'], ['same-origin', 'Same origin'], ['include', 'Include (cross-origin cookies)'], ['omit', 'Omit']], (v) => { d.credentials = v; re(); }, { id: 'aw-route-cred' }), errs, 'credentials'),
        h('div', { class: 'aw-chk' }, checkbox('Forward Authorization to this destination', d.keepAuthorization, (v) => { d.keepAuthorization = v; re(); }), 'Forward Authorization to this destination', h('span', { class: 'aw-mu' }, '— off removes it when the destination is another origin')),
        field('Example request', example, undefined, undefined, 'Preview only; nothing is sent.'), out);
    }

    function chaosSection(d: ChaosRule): HTMLElement {
      const f = d.fault;
      const kindSel = select(f.kind, FAULTS, (v) => {
        faultCache[d.fault.kind] = d.fault;
        d.fault = structuredClone(faultCache[v] ?? FAULT_DEFAULT[v]);
        if (v === 'corrupt-json') raw.corrupt = patchText((d.fault as { patch: PatchOp[] }).patch);
        if (!CHAOS_MODES[v].includes(d.mode)) { d.mode = CHAOS_MODES[v][0]!; notes.push(`${FAULTS.find(([k]) => k === v)![1]} works on real traffic only; mode changed to Real.`); }
        kit.openForm(form);
      }, { id: 'aw-chaos-fault' });
      const modeSel = select(d.mode, [['synthetic', 'Synthetic: nothing is sent'], ['real', 'Real: send, then apply the fault']], (v) => { d.mode = v; if (v === 'synthetic') d.preDelayMs = 0; kit.openForm(form); }, { id: 'aw-chaos-mode' });
      const num = (label: string, key: string, get: () => number, set: (n: number) => void, hint?: string) =>
        field(label, input(String(get()), (v) => { set(v.trim() === '' ? NaN : Number(v)); }, { mono: true, id: `aw-chaos-${key.replace('.', '-')}` }), errs, key, hint);
      const params: (HTMLElement | null)[] = [];
      switch (f.kind) {
        case 'status':
          params.push(h('div', { class: 'aw-g2' }, num('Status', 'fault.status', () => f.status, (n) => { f.status = n; })),
            field('Body', textarea(f.body, (v) => { f.body = v; }, { id: 'aw-chaos-body', rows: 3 }), errs, 'fault.body', 'Optional; HTTP 4xx/5xx is an ordinary response, not a transport failure.'));
          break;
        case 'latency': params.push(num('Delivery delay (ms)', 'fault.delayMs', () => f.delayMs, (n) => { f.delayMs = n; }, 'Added after the real response arrives.')); break;
        case 'random-latency': params.push(h('div', { class: 'aw-g2' }, num('Minimum (ms)', 'fault.minMs', () => f.minMs, (n) => { f.minMs = n; }), num('Maximum (ms)', 'fault.maxMs', () => f.maxMs, (n) => { f.maxMs = n; }))); break;
        case 'timeout': params.push(num('Time out after (ms)', 'fault.timeoutMs', () => f.timeoutMs, (n) => { f.timeoutMs = n; }, d.mode === 'real' ? 'The request is sent and keeps running upstream; the page stops waiting.' : undefined)); break;
        case 'malformed-json': params.push(field('Exact body text', textarea(f.text, (v) => { f.text = v; }, { id: 'aw-chaos-text', rows: 2 }), errs, 'fault.text', 'Delivered exactly; it is never repaired into valid JSON.')); break;
        case 'corrupt-json': {
          const ta = textarea(raw.corrupt, (v) => { raw.corrupt = v; }, { id: 'aw-chaos-patch', rows: 3 });
          params.push(field('Field changes (JSON Patch)', ta, errs, 'fault.patch', 'All changes apply, or the original response is delivered with a reason.'),
            patchBuilder(() => raw.corrupt, (v) => { raw.corrupt = v; ta.value = v; }, 'chaos-b'));
          break;
        }
        case 'replay':
          params.push(h('div', { class: 'aw-g2' }, num('Extra copies (1–2)', 'fault.copies', () => f.copies, (n) => { f.copies = n; }), num('Gap between copies (ms)', 'fault.gapMs', () => f.gapMs, (n) => { f.gapMs = n; })),
            h('p', { class: 'aw-alert aw-notice aw-wrap aw-m0' }, icon('alert', 'aw-i aw-i14'), 'Copies are deliberate duplicates of the exact request, including any idempotency key or signature. A server without idempotency handling may act on each copy. Copies never re-enter rules.'));
          break;
        case 'network-error': break;
      }
      const real = d.mode === 'real';
      return section('Fault',
        h('div', { class: 'aw-g2' }, field('Fault', kindSel, errs, 'fault.kind'), field('Mode', modeSel, errs, 'mode')),
        h('p', { class: 'aw-hint aw-m0 aw-wrap' }, real ? 'Real: the request reaches the server first. A failure the page sees does not undo what the server did.' : 'Synthetic: the page gets the fault and nothing is sent.'),
        ...params,
        ...(real ? [num('Delay before sending (ms)', 'preDelayMs', () => d.preDelayMs, (n) => { d.preDelayMs = n; }, 'Separate from delivery latency.')] : []),
        h('details', { open: d.probability !== 100 || d.seed || d.budget || d.durationMs ? true : undefined }, h('summary', { class: 'aw-xs aw-mu' }, 'Sampling, budget and duration'),
          h('div', { class: 'aw-col aw-gap8 aw-mt2' },
            h('div', { class: 'aw-g2' },
              num('Probability (%)', 'probability', () => d.probability, (n) => { d.probability = n; }),
              field('Seed', input(d.seed, (v) => { d.seed = v; }, { mono: true, id: 'aw-chaos-seed', placeholder: 'Blank = random' }), errs, 'seed')),
            h('div', { class: 'aw-g2' },
              num('Hit budget (0 = no cap)', 'budget', () => d.budget, (n) => { d.budget = n; }),
              num('Active for (ms, 0 = no limit)', 'durationMs', () => d.durationMs, (n) => { d.durationMs = n; })),
            h('p', { class: 'aw-hint aw-m0 aw-wrap' }, 'One sample per selected request, in arrival order; a request that is not sampled is left alone and no lower-priority chaos rule is tried. A seed repeats the same sample sequence for the same order of requests, not for concurrent races. Budget and duration restart on activation or a saved change other than label/enabled.'))),
        h('p', { class: 'aw-xs aw-mu aw-wrap aw-m0', 'aria-live': 'polite' }, `When it fires: ${safeDescribe(d)}`));
    }

    kit.openForm(form);
  }

  function safeDescribe(d: ChaosRule) {
    try { return describeFault({ rule: d, fault: d.fault, delayMs: d.fault.kind === 'latency' ? d.fault.delayMs : d.fault.kind === 'random-latency' ? d.fault.minMs : 0 }); } catch { return '—'; }
  }

  return {
    screen, openEditor, sync, setActive, stopAll, counts, enabledCount,
    rules: rulesOf,
    activeModules: (): Module[] => (Object.keys(cfg().active) as Module[]).filter((m) => cfg().active[m]),
    config: (): Config => cfg(),
  };
}

// ---------- JSON Patch text <-> operations

const patchText = (ops: PatchOp[]) => (ops.length ? JSON.stringify(ops) : '');

/** Parse each raw patch into the draft; returns diagnostics for text that is not an array of operations. */
function compilePatches(d: Rule, raw: { request: string; response: string; corrupt: string }): Diag[] {
  const out: Diag[] = [];
  const parse = (text: string, path: string): PatchOp[] | null => {
    if (!text.trim()) return [];
    try {
      const v = JSON.parse(text);
      if (!Array.isArray(v)) { out.push({ path, message: 'Enter a JSON array of operations, e.g. [{"op":"replace","path":"/id","value":1}]' }); return null; }
      return v;
    } catch (e) { out.push({ path, message: `Not valid JSON: ${(e as Error).message}` }); return null; }
  };
  if (d.kind === 'intercept') {
    const a = parse(raw.request, 'request.patch'), b = parse(raw.response, 'response.patch');
    if (a) d.request.patch = a;
    if (b) d.response.patch = b;
  }
  if (d.kind === 'chaos' && d.fault.kind === 'corrupt-json') {
    const c = parse(raw.corrupt, 'fault.patch');
    if (c) d.fault.patch = c;
  }
  return out;
}

/** Builder row that appends one validated operation to the raw text (which stays editable). */
function patchBuilder(get: () => string, set: (v: string) => void, id: string): HTMLElement {
  const op = { op: 'replace' as PatchOp['op'], path: '', from: '', value: 'null' };
  const msg = h('span', { class: 'aw-hint aw-wrap', 'aria-live': 'polite' });
  const opSel = select(op.op, [['replace', 'Replace'], ['add', 'Add'], ['remove', 'Remove'], ['nullify', 'Nullify'], ['move', 'Move'], ['copy', 'Copy'], ['test', 'Test']] as [PatchOp['op'] | 'nullify', string][], (v) => { (op as { op: string }).op = v; }, { label: 'Operation', id: `aw-${id}-op` });
  const pathIn = input('', (v) => { op.path = v; }, { mono: true, label: 'Path', placeholder: '/field/0', id: `aw-${id}-path` });
  const fromIn = input('', (v) => { op.from = v; }, { mono: true, label: 'From (move/copy)', placeholder: 'from', id: `aw-${id}-from` });
  const valIn = input('null', (v) => { op.value = v; }, { mono: true, label: 'Value (JSON)', placeholder: 'value JSON', id: `aw-${id}-value` });
  const add = btn([icon('plus', 'aw-i aw-i12'), 'Add operation'], () => {
    let list: PatchOp[];
    try { list = get().trim() ? JSON.parse(get()) : []; if (!Array.isArray(list)) throw new Error('not a list'); } catch { msg.textContent = 'Fix the raw JSON first; the builder appends to it.'; return; }
    const kind = op.op as PatchOp['op'] | 'nullify';
    const next: PatchOp = { op: kind === 'nullify' ? 'replace' : kind, path: op.path };
    if (kind === 'move' || kind === 'copy') next.from = op.from;
    if (kind === 'nullify') next.value = null;
    else if (kind === 'add' || kind === 'replace' || kind === 'test') {
      try { next.value = JSON.parse(op.value); } catch { msg.textContent = 'Value must be JSON: "text" in quotes, numbers, true/false/null, objects or lists.'; return; }
    }
    list.push(next);
    set(JSON.stringify(list));
    msg.textContent = `Added ${next.op} ${next.path || '(whole value)'}.`;
  }, 'aw-btn aw-out aw-sm');
  return h('details', {}, h('summary', { class: 'aw-xs aw-mu' }, 'Add an operation'),
    h('div', { class: 'aw-col aw-gap6 aw-mt2' }, h('div', { class: 'aw-g2' }, opSel, pathIn, fromIn, valIn), add, msg));
}

