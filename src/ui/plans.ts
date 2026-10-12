// Test → Plans: saved-plan picker (new/rename/copy/delete), setup/load/skip and order, Flow vs
// Independent with bounded numbers, complex step fields (guard, read-only poll, idempotency,
// assertions), live preflight, and Run once / Run Load in the footer. A plan is a draft until saved.
import { BOUNDS, newId, validateAggregate, type Aggregate, type CompareOp, type Condition, type Endpoint, type Plan, type Step } from '../data/schema';
import { describeSource, readSource } from '../tester/expr';
import { describeCond, preflight } from '../tester/graph';
import { mask, pageSources } from '../tester/once';
import { headerRows } from './endpoints';
import { h, icon } from './dom';
import { btn, checkbox, toggle, Errors, field, heading, input, methodBadge, section, select, type Built, type Form, type Kit, type Ret } from './kit';

const OPS: [CompareOp, string][] = [['eq', '='], ['ne', '≠'], ['lt', '<'], ['lte', '≤'], ['gt', '>'], ['gte', '≥'], ['in', 'in (a,b)'], ['exists', 'exists']];

export function newPlan(agg: Aggregate): Plan {
  let n = agg.plans.length + 1;
  while (agg.plans.some((p) => p.name === `Plan ${n}`)) n++;
  return { id: newId('plan'), name: `Plan ${n}`, strategy: 'flow', mode: 'direct', steps: agg.endpoints.map((e) => ({ endpointId: e.id, phase: 'skip' })), iterations: 1, concurrency: 1, delayMs: 0, rampUp: false, rampStepMs: 1000, onFailure: 'continue', notify: 'panel' };
}

export function createPlansUi(kit: Kit, o: { keys(): ReadonlySet<string>; openContext(ret: Ret): void; run(plan: Plan, once: boolean): void; running(planId: string): boolean; stop(planId: string): void }) {
  const s = kit.session;
  let current: string | null = null;

  function open(ret: Ret, id?: string) {
    const agg = s.agg();
    const pick = (id && agg.plans.find((p) => p.id === id)) || agg.plans.find((p) => p.id === current) || agg.plans[0];
    const isNew = !pick;
    const draft: Plan = pick ? structuredClone(pick) : newPlan(agg);
    // Every endpoint appears once: saved steps first (their order), then any endpoint not yet listed as skip.
    for (const e of agg.endpoints) if (!draft.steps.some((st) => st.endpointId === e.id)) draft.steps.push({ endpointId: e.id, phase: 'skip' });
    draft.steps = draft.steps.filter((st) => agg.endpoints.some((e) => e.id === st.endpointId));
    current = draft.id;
    const base = isNew ? '' : JSON.stringify(normalize(pick!, agg));
    // Profile global headers are edited here too and saved by Save plan (part of this draft's dirty state).
    const globals = structuredClone(agg.profile.globalHeaders);
    const globalsBase = JSON.stringify(globals);
    const globalsDirty = () => JSON.stringify(globals) !== globalsBase;
    const errs = new Errors();
    let filter = '';

    const form: Form = {
      owner: 'test',
      ret,
      dirty: () => JSON.stringify(normalize(draft, s.agg())) !== base || globalsDirty(),
      async save() {
        draft.name = draft.name.trim();
        const cur = s.agg();
        const headers = globals.map((x) => ({ ...x, name: x.name.trim() }));
        const next = { ...cur, profile: { ...cur.profile, globalHeaders: headers }, plans: [...cur.plans.filter((p) => p.id !== draft.id), structuredClone(draft)] };
        const v = validateAggregate(next);
        const i = next.plans.length - 1;
        if (!v.ok) {
          const mine = v.errors.flatMap((d) => d.path.startsWith(`plans.${i}`) ? [{ path: d.path.slice(`plans.${i}.`.length), message: d.message }]
            : d.path.startsWith('profile.globalHeaders') ? [{ path: d.path.slice('profile.'.length), message: d.message }] : []);
          if (errs.show(mine.length ? mine : v.errors, kit.announce)) return false;
        }
        if (cur.plans.some((p) => p.id !== draft.id && p.name === draft.name)) { errs.show([{ path: 'name', message: 'Another plan has this name' }], kit.announce); return false; }
        const out = await s.edit((a) => {
          const j = a.plans.findIndex((p) => p.id === draft.id);
          if (j >= 0) a.plans[j] = structuredClone(draft); else a.plans.push(structuredClone(draft));
          if (globalsDirty()) a.profile.globalHeaders = headers;
        });
        if (out) { errs.show(out, kit.announce); return false; }
        kit.announce(`Plan ${draft.name} saved.`);
        return true;
      },
      build: () => screen(),
    };

    function screen(): Built {
      errs.clear();
      const agg = s.agg();
      const pfEl = h('div', { class: 'aw-col aw-gap6', id: 'aw-pf', 'aria-live': 'polite' });
      // Footer run bar (reason/selection, Save when unsaved, Stop, Run once, Run Load), refreshed by update().
      const why = h('span', { class: 'aw-xs aw-mu aw-wrap', id: 'aw-run-why' });
      const picked = h('span', { class: 'aw-xs aw-mu', id: 'aw-run-picked' });
      const runBtns = h('div', { class: 'aw-row aw-gap6 aw-grow aw-end' });
      const saveBtn = btn([icon('save', 'aw-i aw-i14'), 'Save'], async () => { if (await form.save()) open(ret, draft.id); }, 'aw-btn aw-pri', { id: 'aw-plan-save' });
      const conc = h('span', {});
      const update = () => {
        const pf = preflight({ ...s.agg(), plans: [draft] }, draft, { once: false, pageOrigin: kit.rt.origin, sources: pageSources(), keys: o.keys() });
        const once = preflight({ ...s.agg(), plans: [draft] }, draft, { once: true, pageOrigin: kit.rt.origin, sources: pageSources(), keys: o.keys() });
        conc.textContent = draft.strategy === 'flow' ? 'Concurrency is the number of simultaneous iterations, not parallel requests inside one iteration.' : 'Concurrency is the number of simultaneous requests across the endpoint jobs.';
        const c = pf.counts;
        pfEl.replaceChildren(
          h('div', { class: 'aw-xs aw-wrap', id: 'aw-pf-counts' }, `Setup ${c.setup} · load ${pf.load.length} step(s) × ${draft.iterations} = ${c.load} jobs · run once = ${once.counts.primary} request(s) · Load = ${c.primary} primary, up to ${c.worst} with ${c.poll} poll, ${c.refresh} refresh, ${c.retry} read-only retry`),
          h('div', { class: 'aw-xs aw-mu aw-wrap' }, `Destinations: ${pf.destinations.join(', ') || '—'} · ${draft.mode === 'direct' ? 'Direct (active rules bypassed)' : 'Apply rules'} · ${draft.strategy === 'flow' ? `Flow: ${draft.concurrency} iteration(s) at a time, steps in order inside each` : `Independent: ${draft.concurrency} request(s) at a time across fair per-endpoint queues`}`),
          ...pf.mutating.map((m) => h('div', { class: 'aw-xs aw-wrap' }, h('span', { class: 'aw-bd aw-am' }, 'writes'), ' ', m)),
          ...pf.errors.map((e) => h('div', { class: 'aw-err aw-wrap' }, e)),
          ...pf.warnings.map((w) => h('div', { class: 'aw-hint aw-wrap' }, w)),
          h('p', { class: 'aw-hint aw-wrap' }, 'Each iteration or job has its own variables, but every request uses this tab’s cookies and session: they are not separate users or customers. Nothing is retried automatically except an explicitly configured read-only retry after 401.'));
        const dirty = form.dirty();
        const blocked = dirty ? 'Save the plan before running it' : !pf.ok ? 'Fix the preflight errors first' : '';
        const busy = o.running(draft.id);
        const one = btn('Run once', () => o.run(structuredClone(draft), true), 'aw-btn aw-out', { id: 'aw-run-once', title: blocked || 'One pass of the selected steps; Load settings are not changed' });
        // While unsaved, Save is the highlighted (primary) action and Run Load is outlined.
        const load = btn([icon('play', 'aw-i aw-i14'), 'Run Load'], () => o.run(structuredClone(draft), false), dirty ? 'aw-btn aw-out' : 'aw-btn aw-pri', { id: 'aw-run-load', title: blocked || `${draft.iterations} repetition(s)` });
        one.disabled = load.disabled = !!blocked || busy || !once.ok;
        if (!once.ok && !blocked) one.title = once.errors[0] ?? '';
        load.classList.add('aw-grow');
        why.textContent = busy ? 'This plan is running.' : blocked;
        picked.textContent = why.textContent ? '' : `${draft.steps.filter((st) => st.phase !== 'skip').length} selected · ${draft.iterations}×${draft.concurrency}`;
        runBtns.replaceChildren(...(dirty ? [saveBtn] : []), ...(busy ? [btn([icon('stop', 'aw-i aw-i14'), 'Stop'], () => o.stop(draft.id), 'aw-btn aw-out')] : []), one, load);
      };

      // Plan picker and identity.
      const picker = select<string>(draft.id, [...agg.plans.map((p): [string, string] => [p.id, p.name]), ...(agg.plans.some((p) => p.id === draft.id) ? [] : [[draft.id, `${draft.name} (new, unsaved)`] as [string, string]])], (v) => switchTo(v), { id: 'aw-plan-pick', label: 'Saved plan' });
      const nameIn = input(draft.name, (v) => { draft.name = v; update(); }, { id: 'aw-plan-name' });
      // Run configuration rows: label column, control (+ unit), error under the control.
      const cfgRow = (label: string | Node, control: HTMLElement, extra: Node[] = [], key?: string) => {
        const err = h('span', { class: 'aw-err', role: 'alert', id: `${control.id}-err` });
        control.setAttribute('aria-describedby', err.id);
        if (key) errs.slot(key, err, control);
        return h('div', { class: 'aw-cfgrow' }, typeof label === 'string' ? h('label', { class: 'aw-lbl', for: control.id }, label) : label,
          h('div', { class: 'aw-row aw-gap8' }, control, ...extra), err);
      };
      const numRow = (label: string | Node, key: 'iterations' | 'concurrency' | 'delayMs' | 'rampStepMs', min: number, max: number, unit?: string, aria?: string) => {
        const el = input(String(draft[key]), () => {}, { id: `aw-plan-${key}`, type: 'number', mono: true, ...(aria ? { label: aria } : {}) });
        el.min = String(min); el.max = String(max);
        el.classList.add('aw-numin');
        const row = cfgRow(label, el, unit ? [h('span', { class: 'aw-xs aw-mu' }, unit)] : [], key);
        const err = row.querySelector('.aw-err')!;
        el.addEventListener('input', () => {
          const n = Number(el.value);
          if (el.value.trim() === '' || !Number.isSafeInteger(n) || n < min || n > max) { err.textContent = `Whole number ${min}–${max}; still using ${draft[key]}`; el.setAttribute('aria-invalid', 'true'); }
          else { draft[key] = n; err.textContent = ''; el.removeAttribute('aria-invalid'); }
          update();
        });
        return row;
      };
      const notifyBtn = btn('Allow browser notifications', async () => {
        try { const r = await Notification.requestPermission(); kit.announce(`Browser notifications: ${r}.`); } catch { kit.announce('This browser refused the notification permission request.'); }
      }, 'aw-btn aw-gh aw-sm');
      notifyBtn.hidden = draft.notify !== 'browser' || typeof Notification === 'undefined' || Notification.permission === 'granted';

      const stepsEl = h('div', { class: 'aw-col' });
      const scope = h('span', { class: 'aw-xs aw-mu' });
      const drawSteps = () => {
        const agg = s.agg();
        const q = filter.trim().toLowerCase();
        const visible = draft.steps.filter((st) => { const e = agg.endpoints.find((x) => x.id === st.endpointId)!; return !q || `${e.name} ${e.alias} ${e.request.method} ${e.request.url}`.toLowerCase().includes(q); });
        scope.textContent = q ? `${visible.length} of ${draft.steps.length} shown; bulk actions change only these` : `${draft.steps.length} endpoint(s); bulk actions change all`;
        const focus = kit.root.activeElement?.getAttribute?.('data-key');
        stepsEl.replaceChildren(...visible.map((st) => stepRow(agg, st, drawSteps)));
        if (focus) stepsEl.querySelector<HTMLElement>(`[data-key="${focus}"]`)?.focus();
        update();
      };
      const bulk = (phase: Step['phase']) => {
        const agg = s.agg();
        const q = filter.trim().toLowerCase();
        let n = 0;
        for (const st of draft.steps) {
          const e = agg.endpoints.find((x) => x.id === st.endpointId)!;
          if (!q || `${e.name} ${e.alias} ${e.request.method} ${e.request.url}`.toLowerCase().includes(q)) { st.phase = phase; n++; }
        }
        kit.announce(`${n} step(s) set to ${phase}.`);
        drawSteps();
      };
      const filterIn = input(filter, (v) => { filter = v; drawSteps(); }, { label: 'Filter steps', placeholder: 'Filter by name, alias, method or path', id: 'aw-plan-filter' });

      function stepRow(agg: Aggregate, st: Step, redraw: () => void): HTMLElement {
        const e = agg.endpoints.find((x) => x.id === st.endpointId)!;
        const i = draft.steps.indexOf(st);
        const move = (d: number) => {
          const j = i + d;
          if (j < 0 || j >= draft.steps.length) return;
          [draft.steps[i], draft.steps[j]] = [draft.steps[j]!, draft.steps[i]!];
          redraw();
        };
        const phase = select(st.phase, [['setup', 'Setup'], ['load', 'Load'], ['skip', 'Skip']], (v) => { st.phase = v; redraw(); }, { label: `Phase for ${e.name}`, id: `aw-phase-${e.alias}` });
        phase.classList.add('aw-sm');
        // One line per step; options (guard, poll, idempotency, assertions) expand underneath.
        const opts = h('div', { class: 'aw-col aw-gap8 aw-stepopts', hidden: !openOpts.has(e.id) }, ...stepOptions(st, e, update));
        const n = optionCount(st);
        const optsBtn = btn([icon('sliders', 'aw-i aw-i14'), n ? String(n) : ''], () => {
          opts.hidden = !opts.hidden;
          optsBtn.setAttribute('aria-expanded', String(!opts.hidden));
          if (opts.hidden) openOpts.delete(e.id); else openOpts.add(e.id);
        }, `aw-btn aw-gh aw-sm${n ? ' aw-optn' : ' aw-ic'}`, { 'aria-label': `Options for ${e.name}${optionSummary(st, e)}`, 'aria-expanded': String(!opts.hidden), title: `Options${optionSummary(st, e)}` });
        if (st.phase === 'skip') optsBtn.style.visibility = 'hidden'; // keeps the columns aligned
        return h('div', { class: 'aw-col aw-steprow' },
          h('div', { class: 'aw-row aw-gap6' }, methodBadge(e.request.method),
            h('span', { class: 'aw-grow aw-tr', title: `${e.name} · ${e.alias}` }, e.name, ' ', h('span', { class: 'aw-xs aw-mu aw-mono' }, e.alias)),
            phase, optsBtn,
            btn('↑', () => move(-1), 'aw-btn aw-gh aw-ic aw-sm', { 'aria-label': `Move ${e.name} up`, 'data-key': `up-${e.alias}`, disabled: i === 0 }),
            btn('↓', () => move(1), 'aw-btn aw-gh aw-ic aw-sm', { 'aria-label': `Move ${e.name} down`, 'data-key': `down-${e.alias}`, disabled: i === draft.steps.length - 1 })),
          st.phase === 'skip' ? null : opts);
      }

      drawSteps();
      const strategy = select(draft.strategy, [['flow', 'Flow — ordered sequence per iteration'], ['independent', 'Independent — one job per endpoint']], (v) => { draft.strategy = v; update(); }, { id: 'aw-plan-strategy' });
      const mode = select(draft.mode, [['direct', 'Direct — bypass active rules'], ['rules', 'Apply active rules']], (v) => { draft.mode = v; update(); }, { id: 'aw-plan-mode' });
      const fail = select(draft.onFailure, [['continue', 'Continue unrelated steps'], ['stop', 'Stop at the first failure']], (v) => { draft.onFailure = v; update(); }, { id: 'aw-plan-fail' });
      const notify = select(draft.notify, [['panel', 'In-panel notice'], ['browser', 'Browser notification'], ['off', 'Off']], (v) => { draft.notify = v; notifyBtn.hidden = v !== 'browser' || typeof Notification === 'undefined' || Notification.permission === 'granted'; update(); }, { id: 'aw-plan-notify' });
      let rampIn: HTMLInputElement | null = null;
      const ramp = numRow(h('span', { class: 'aw-row aw-gap8' }, toggle('Ramp-up', draft.rampUp, (v) => { draft.rampUp = v; rampIn!.disabled = !v; update(); }), h('span', { class: 'aw-lbl' }, 'Ramp-up')),
        'rampStepMs', 0, BOUNDS.delayMs, 'ms per added worker', 'Ramp step ms');
      rampIn = ramp.querySelector('input')!;
      rampIn.disabled = !draft.rampUp;
      const notifyRow = cfgRow('Notify', notify, [], 'notify');
      notifyRow.append(notifyBtn);

      kit.foot.replaceChildren(h('div', { class: 'aw-col aw-runinfo' }, why, picked), runBtns);
      kit.foot.hidden = false;
      return {
        nodes: [
          h('div', { class: 'aw-row' }, kit.backButton(ret.screen, () => kit.leaveForm()), heading('Plans')),
          errs.summary,
          h('div', { class: 'aw-fieldrow' },
            h('div', { class: 'aw-grow' }, field('Saved plan', picker)),
            h('div', { class: 'aw-row aw-gap6' }, // wraps as one group under the picker when narrow
              btn([icon('plus', 'aw-i aw-i12'), 'New plan'], () => switchTo('__new'), 'aw-btn aw-out aw-sm'),
              btn('Save copy', copy, 'aw-btn aw-out aw-sm'),
              btn([icon('trash', 'aw-i aw-i12')], remove, 'aw-btn aw-gh aw-ic aw-sm', { 'aria-label': `Delete plan ${draft.name}` }))),
          field('Plan name', nameIn, errs, 'name'),
          section('Run configuration',
            cfgRow('Strategy', strategy, [], 'strategy'),
            numRow('Iterations', 'iterations', 1, BOUNDS.iterations, 'for Run Load'),
            numRow('Concurrency', 'concurrency', 1, BOUNDS.concurrency),
            numRow('Delay', 'delayMs', 0, BOUNDS.delayMs, 'ms after each iteration/job'),
            h('div', { class: 'aw-sep' }),
            ramp,
            h('div', { class: 'aw-sep' }),
            cfgRow('Mode', mode, [], 'mode'),
            cfgRow('On failure', fail, [], 'onFailure'),
            notifyRow,
            h('p', { class: 'aw-hint aw-wrap' }, conc, ' A failed step skips the steps that depend on it. Run once always sends one pass; Iterations applies to Run Load only.')),
          disclosure('aw-plan-headers', `Headers (${globals.length})`,
            h('p', { class: 'aw-hint aw-wrap' }, `Global · sent with every request in profile ${agg.profile.name}, saved by Save plan. An endpoint's own headers are edited on Endpoints.`),
            headerRows(kit, globals, errs, 'globalHeaders', false, update)),
          disclosure('aw-plan-context', `Page context (${agg.bindings.length} binding${agg.bindings.length === 1 ? '' : 's'})`,
            h('p', { class: 'aw-hint aw-wrap' }, 'Bindings read page values (cookies, storage, meta tags, form fields, globals) at dispatch. Use them as {{$context("name")}}.'),
            ...(agg.bindings.length ? [h('ul', { class: 'aw-ops' }, ...agg.bindings.map((b) => {
              const v = readSource(pageSources(), b.source);
              return h('li', { class: 'aw-row aw-gap6 aw-xs' }, h('span', { class: 'aw-mono' }, b.name), h('span', { class: 'aw-grow aw-mu aw-wrap' }, describeSource(b.source)),
                v === undefined ? h('span', { class: 'aw-bd aw-am' }, 'missing') : h('span', { class: 'aw-bd aw-gr', title: 'Masked; the value is read again at dispatch' }, `available ${mask(v)}`));
            }))] : [h('div', { class: 'aw-empty' }, 'No bindings yet. Scan the page and add what a request needs.')]),
            h('div', { class: 'aw-row' }, btn('Scan page & edit bindings', () => kit.guard(() => o.openContext(ret)), 'aw-btn aw-out aw-sm', { 'aria-label': 'Open Auth & context to scan the page and edit bindings' }))),
          section('Steps',
            h('div', { class: 'aw-row aw-gap6 aw-wrapbtns' }, filterIn, btn('Load all', () => bulk('load')), btn('Skip all', () => bulk('skip'))),
            scope, stepsEl),
          section('Preflight', pfEl),
        ],
        refresh: update,
      };
    }

    async function decide(): Promise<boolean> {
      if (!form.dirty()) return true;
      const v = await kit.ask('This plan has unsaved changes.', [{ label: 'Keep editing', cls: 'aw-out', value: 'keep' }, { label: 'Discard', cls: 'aw-dst', value: 'discard' }, { label: 'Save', cls: 'aw-pri', value: 'save' }]);
      return v === 'discard' || (v === 'save' && (await form.save()));
    }
    async function switchTo(id: string) {
      if (!(await decide())) { kit.openForm(form); return; }
      if (id === '__new') {
        const p = newPlan(s.agg());
        const out = await s.edit((a) => { a.plans.push(p); });
        if (out) { kit.announce(`Plan not created: ${out[0]!.message}`); return; }
        kit.announce(`Created ${p.name}. Choose setup and load steps, then save.`);
        open(ret, p.id);
      } else open(ret, id);
    }
    async function copy() {
      if (!(await decide())) return;
      const cur = s.agg().plans.find((p) => p.id === draft.id);
      if (!cur) { kit.announce('Save the plan before copying it.'); return; }
      let n = 2;
      while (s.agg().plans.some((p) => p.name === `${cur.name} copy${n > 2 ? ` ${n}` : ''}`)) n++;
      const c = { ...structuredClone(cur), id: newId('plan'), name: `${cur.name} copy${n > 2 ? ` ${n}` : ''}` };
      const out = await s.edit((a) => { a.plans.push(c); });
      if (out) { kit.announce(`Copy not saved: ${out[0]!.message}`); return; }
      kit.announce(`Saved ${c.name}; it keeps the same steps and settings.`);
      open(ret, c.id);
    }
    async function remove() {
      const exists = s.agg().plans.some((p) => p.id === draft.id);
      const v = await kit.ask(`Delete plan ${draft.name}? Endpoints are not changed. Stored run summaries stay in history.`, [{ label: 'Cancel', cls: 'aw-out', value: 'cancel' }, { label: 'Delete', cls: 'aw-dst', value: 'delete' }]);
      if (v !== 'delete') return;
      if (exists) {
        const out = await s.edit((a) => { a.plans = a.plans.filter((p) => p.id !== draft.id); });
        if (out) { kit.announce(`Not deleted: ${out[0]!.message}`); return; }
      }
      const next = s.agg().plans[0];
      current = next?.id ?? null;
      kit.announce(`Deleted ${draft.name}.${next ? ` Showing ${next.name}.` : ''}`);
      if (next) open(ret, next.id); else kit.closeForm(null);
    }
    kit.openForm(form);
  }

  const openOpts = new Set<string>();
  /** Collapsible card section; its open state survives screen rebuilds. */
  const openDisc = new Set<string>();
  function disclosure(key: string, title: string, ...kids: Node[]) {
    const d = h('details', { class: 'aw-card aw-cp aw-disc', 'data-key': key }, h('summary', { class: 'aw-h aw-h13' }, title), h('div', { class: 'aw-col aw-gap10' }, ...kids));
    d.open = openDisc.has(key);
    d.addEventListener('toggle', () => { if (d.open) openDisc.add(key); else openDisc.delete(key); });
    return d;
  }

  function stepOptions(st: Step, e: Endpoint, changed: () => void): Node[] {
    const out: Node[] = [];
    const guardSlot = h('div', { class: 'aw-col aw-gap4' });
    const drawGuard = () => guardSlot.replaceChildren(
      h('span', { class: 'aw-chk aw-xs' }, checkbox(`Guard for ${e.name}`, !!st.guard, (v) => { if (v) st.guard = { ref: '', op: 'eq', value: '' }; else delete st.guard; drawGuard(); changed(); }), 'Guard: send only when a condition over an earlier step holds (else skipped-condition)'),
      ...(st.guard ? [condRow(st.guard, `guard ${e.alias}`, changed)] : []));
    drawGuard();
    out.push(guardSlot);

    const readOnly = e.request.method === 'GET' || e.request.method === 'HEAD';
    const pollSlot = h('div', { class: 'aw-col aw-gap4' });
    const drawPoll = () => {
      const p = st.poll;
      const n = (label: string, key: 'maxAttempts' | 'intervalMs' | 'deadlineMs', min: number, max: number) => {
        const el = input(String(p![key]), (v) => { const x = Number(v); if (Number.isSafeInteger(x) && x >= min && x <= max) { p![key] = x; el.removeAttribute('aria-invalid'); } else el.setAttribute('aria-invalid', 'true'); changed(); }, { type: 'number', label: `${label} for ${e.name}` });
        return h('label', { class: 'aw-col aw-xs' }, `${label} (${min}–${max})`, el);
      };
      pollSlot.replaceChildren(
        h('span', { class: 'aw-chk aw-xs' }, checkbox(`Poll ${e.name}`, !!p, (v) => {
          if (v) st.poll = { readOnly: true, until: { ref: `${e.alias}.status`, op: 'in', value: 'completed,failed' }, maxAttempts: 10, intervalMs: 1000, deadlineMs: 30_000 }; else delete st.poll;
          drawPoll(); changed();
        }), readOnly ? 'Poll until a condition on this step’s response (read-only endpoints only)' : `Poll is not available: ${e.request.method} is not read-only`),
        ...(p ? [condRow(p.until, `poll ${e.alias}`, changed), h('div', { class: 'aw-g3' }, n('Max attempts', 'maxAttempts', 1, BOUNDS.poll.attempts), n('Interval ms', 'intervalMs', BOUNDS.poll.minIntervalMs, BOUNDS.poll.deadlineMs), n('Deadline ms', 'deadlineMs', BOUNDS.poll.minIntervalMs, BOUNDS.poll.deadlineMs)),
          h('p', { class: 'aw-hint aw-wrap' }, 'You classify this endpoint as read-only: a GET can still have side effects on some servers. Each attempt is a separate request record; still pending at the cap or deadline is a timeout, never success.')] : []));
      const box = pollSlot.querySelector<HTMLButtonElement>('.aw-cb');
      if (box && !readOnly && !p) box.disabled = true;
    };
    drawPoll();
    out.push(pollSlot);

    if (e.request.method !== 'GET' && e.request.method !== 'HEAD') {
      const idem = input(st.idempotency?.header ?? '', (v) => { if (v.trim()) st.idempotency = { header: v.trim() }; else delete st.idempotency; changed(); }, { label: `Idempotency header for ${e.name}`, placeholder: 'Idempotency-Key', mono: true });
      out.push(h('label', { class: 'aw-col aw-xs' }, 'Idempotency header (a new key per logical operation; the same key for its own retries)', idem));
    }

    const asSlot = h('div', { class: 'aw-col aw-gap4' });
    const list = (st.assertions ??= []);
    const drawAs = () => asSlot.replaceChildren(h('span', { class: 'aw-xs' }, 'Assertions after this step (exact decimals; may read earlier steps in the same iteration)'),
      ...list.map((c, i) => h('div', { class: 'aw-row aw-gap6' }, condRow(c, `assertion ${i + 1} ${e.alias}`, changed), btn([icon('x')], () => { list.splice(i, 1); drawAs(); changed(); }, 'aw-btn aw-gh aw-ic aw-sm', { 'aria-label': `Remove assertion ${i + 1} of ${e.name}` }))),
      btn([icon('plus', 'aw-i aw-i12'), 'Add assertion'], () => { list.push({ ref: `${e.alias}.`, op: 'eq', value: '' }); drawAs(); changed(); }, 'aw-btn aw-dash aw-sm', { 'aria-label': `Add assertion to ${e.name}` }));
    drawAs();
    out.push(asSlot);
    return out;
  }

  function condRow(c: Condition, what: string, changed: () => void): HTMLElement {
    const value = input(c.value ?? '', (v) => { c.value = v; changed(); }, { label: `${what} value`, mono: true, placeholder: 'value' });
    const op = select<CompareOp>(c.op, OPS, (v) => { c.op = v; if (v === 'exists') delete c.value; else c.value ??= ''; value.hidden = v === 'exists'; changed(); }, { label: `${what} comparison` });
    op.classList.add('aw-sm');
    value.hidden = c.op === 'exists';
    return h('div', { class: 'aw-cond aw-grow' }, input(c.ref, (v) => { c.ref = v.trim(); changed(); }, { label: `${what} field`, mono: true, placeholder: 'alias.path' }), op, value, h('span', {}));
  }

  return { open };
}

function optionCount(st: Step): number {
  return [st.guard?.ref, st.poll, st.idempotency, st.assertions?.length].filter(Boolean).length;
}

function optionSummary(st: Step, e: Endpoint): string {
  const parts = [st.guard && st.guard.ref ? `guard ${describeCond(st.guard)}` : '', st.poll ? `poll ≤${st.poll.maxAttempts}` : '', st.idempotency ? `idempotency ${st.idempotency.header}` : '', st.assertions?.length ? `${st.assertions.length} assertion(s)` : ''].filter(Boolean);
  void e;
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

/** Comparable plan: empty assertion lists and endpoint ordering of skip rows do not count as edits. */
function normalize(p: Plan, agg: Aggregate): Plan {
  const c = structuredClone(p);
  for (const e of agg.endpoints) if (!c.steps.some((st) => st.endpointId === e.id)) c.steps.push({ endpointId: e.id, phase: 'skip' });
  for (const st of c.steps) if (st.assertions && !st.assertions.length) delete st.assertions;
  return c;
}
