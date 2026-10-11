// Test → Plans: saved-plan picker (new/rename/copy/delete), setup/load/skip and order, Flow vs
// Independent with bounded numbers, complex step fields (guard, read-only poll, idempotency,
// assertions), live preflight, and Run plan once / Run Load. A plan is a draft until saved.
import { BOUNDS, newId, validateAggregate, type Aggregate, type CompareOp, type Condition, type Endpoint, type Plan, type Step } from '../data/schema';
import { describeCond, preflight } from '../tester/graph';
import { pageSources } from '../tester/once';
import { h, icon } from './dom';
import { btn, checkbox, Errors, field, heading, input, methodBadge, section, select, type Built, type Form, type Kit, type Ret } from './kit';

const OPS: [CompareOp, string][] = [['eq', '='], ['ne', '≠'], ['lt', '<'], ['lte', '≤'], ['gt', '>'], ['gte', '≥'], ['in', 'in (a,b)'], ['exists', 'exists']];

export function newPlan(agg: Aggregate): Plan {
  let n = agg.plans.length + 1;
  while (agg.plans.some((p) => p.name === `Plan ${n}`)) n++;
  return { id: newId('plan'), name: `Plan ${n}`, strategy: 'flow', mode: 'direct', steps: agg.endpoints.map((e) => ({ endpointId: e.id, phase: 'skip' })), iterations: 1, concurrency: 1, delayMs: 0, rampUp: false, rampStepMs: 1000, onFailure: 'continue', notify: 'panel' };
}

export function createPlansUi(kit: Kit, o: { keys(): ReadonlySet<string>; run(plan: Plan, once: boolean): void; running(planId: string): boolean; stop(planId: string): void }) {
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
    const errs = new Errors();
    let filter = '';

    const form: Form = {
      owner: 'test',
      ret,
      dirty: () => JSON.stringify(normalize(draft, s.agg())) !== base,
      async save() {
        draft.name = draft.name.trim();
        const cur = s.agg();
        const next = { ...cur, plans: [...cur.plans.filter((p) => p.id !== draft.id), structuredClone(draft)] };
        const v = validateAggregate(next);
        const i = next.plans.length - 1;
        if (!v.ok) {
          const mine = v.errors.filter((d) => d.path.startsWith(`plans.${i}`)).map((d) => ({ path: d.path.slice(`plans.${i}.`.length), message: d.message }));
          if (errs.show(mine.length ? mine : v.errors, kit.announce)) return false;
        }
        if (cur.plans.some((p) => p.id !== draft.id && p.name === draft.name)) { errs.show([{ path: 'name', message: 'Another plan has this name' }], kit.announce); return false; }
        const out = await s.edit((a) => {
          const j = a.plans.findIndex((p) => p.id === draft.id);
          if (j >= 0) a.plans[j] = structuredClone(draft); else a.plans.push(structuredClone(draft));
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
      const actions = h('div', { class: 'aw-row aw-gap6 aw-wrapbtns' });
      const conc = h('span', { class: 'aw-lbl' });
      const update = () => {
        const pf = preflight({ ...s.agg(), plans: [draft] }, draft, { once: false, pageOrigin: kit.rt.origin, sources: pageSources(), keys: o.keys() });
        const once = preflight({ ...s.agg(), plans: [draft] }, draft, { once: true, pageOrigin: kit.rt.origin, sources: pageSources(), keys: o.keys() });
        conc.textContent = draft.strategy === 'flow' ? 'Simultaneous iterations' : 'Simultaneous requests';
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
        const one = btn([icon('play', 'aw-i aw-i14'), 'Run plan once'], () => o.run(structuredClone(draft), true), 'aw-btn aw-out aw-sm', { id: 'aw-run-once', title: blocked || 'One pass of the selected steps; Load settings are not changed' });
        const load = btn([icon('play', 'aw-i aw-i14'), 'Run Load'], () => o.run(structuredClone(draft), false), 'aw-btn aw-pri aw-sm', { id: 'aw-run-load', title: blocked || `${draft.iterations} repetition(s)` });
        one.disabled = load.disabled = !!blocked || busy || !once.ok;
        if (!once.ok && !blocked) one.title = once.errors[0] ?? '';
        actions.replaceChildren(h('span', { class: 'aw-xs aw-mu aw-grow aw-wrap', id: 'aw-run-why' }, busy ? 'This plan is running.' : blocked), ...(busy ? [btn([icon('stop', 'aw-i aw-i14'), 'Stop'], () => o.stop(draft.id), 'aw-btn aw-out aw-sm')] : []), one, load);
      };

      // Plan picker and identity.
      const picker = select<string>(draft.id, [...agg.plans.map((p): [string, string] => [p.id, p.name]), ...(agg.plans.some((p) => p.id === draft.id) ? [] : [[draft.id, `${draft.name} (new, unsaved)`] as [string, string]])], (v) => switchTo(v), { id: 'aw-plan-pick', label: 'Saved plan' });
      const nameIn = input(draft.name, (v) => { draft.name = v; update(); }, { id: 'aw-plan-name' });
      const num = (label: string, key: 'iterations' | 'concurrency' | 'delayMs' | 'rampStepMs', min: number, max: number, hint?: string) => {
        const el = input(String(draft[key]), () => {}, { id: `aw-plan-${key}`, type: 'number' });
        el.min = String(min); el.max = String(max);
        const err = h('span', { class: 'aw-err', role: 'alert' });
        el.addEventListener('input', () => {
          const n = Number(el.value);
          if (el.value.trim() === '' || !Number.isSafeInteger(n) || n < min || n > max) { err.textContent = `Whole number ${min}–${max}; still using ${draft[key]}`; el.setAttribute('aria-invalid', 'true'); }
          else { draft[key] = n; err.textContent = ''; el.removeAttribute('aria-invalid'); }
          update();
        });
        const f = field(label, el, errs, key, hint);
        f.append(err);
        return f;
      };
      const concField = num('Concurrency', 'concurrency', 1, BOUNDS.concurrency);
      concField.querySelector('label')!.replaceChildren(conc);
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
        const opts = h('details', { class: 'aw-col aw-gap8' }, h('summary', { class: 'aw-xs' }, `Options${optionSummary(st, e)}`), ...stepOptions(st, e, update));
        opts.open = openOpts.has(e.id);
        opts.addEventListener('toggle', () => { if (opts.open) openOpts.add(e.id); else openOpts.delete(e.id); });
        return h('div', { class: 'aw-col aw-steprow' },
          h('div', { class: 'aw-row aw-gap6' }, methodBadge(e.request.method),
            h('div', { class: 'aw-grow aw-col' }, h('span', { class: 'aw-wrap' }, e.name), h('span', { class: 'aw-xs aw-mu aw-mono' }, e.alias)),
            phase,
            btn('↑', () => move(-1), 'aw-btn aw-gh aw-ic aw-sm', { 'aria-label': `Move ${e.name} up`, 'data-key': `up-${e.alias}`, disabled: i === 0 }),
            btn('↓', () => move(1), 'aw-btn aw-gh aw-ic aw-sm', { 'aria-label': `Move ${e.name} down`, 'data-key': `down-${e.alias}`, disabled: i === draft.steps.length - 1 })),
          st.phase === 'skip' ? null : opts);
      }

      drawSteps();
      const strategy = select(draft.strategy, [['flow', 'Flow — steps in order inside each iteration'], ['independent', 'Independent — separate jobs per endpoint']], (v) => { draft.strategy = v; update(); }, { id: 'aw-plan-strategy' });
      const mode = select(draft.mode, [['direct', 'Direct (bypass active rules)'], ['rules', 'Apply rules']], (v) => { draft.mode = v; update(); }, { id: 'aw-plan-mode' });
      const fail = select(draft.onFailure, [['continue', 'Continue (dependents of a failure are skipped)'], ['stop', 'Stop the run at the first failure']], (v) => { draft.onFailure = v; update(); }, { id: 'aw-plan-fail' });
      const notify = select(draft.notify, [['panel', 'In-panel notice'], ['browser', 'Browser notification (asks permission)'], ['off', 'Off']], (v) => { draft.notify = v; notifyBtn.hidden = v !== 'browser' || typeof Notification === 'undefined' || Notification.permission === 'granted'; update(); }, { id: 'aw-plan-notify' });
      const ramp = h('div', { class: 'aw-row aw-gap8' }, h('span', { class: 'aw-chk' }, checkbox('Ramp-up', draft.rampUp, (v) => { draft.rampUp = v; update(); }), 'Ramp-up: admit one more worker every'), num('Ramp step ms', 'rampStepMs', 0, BOUNDS.delayMs));

      kit.foot.replaceChildren(
        btn([icon('save', 'aw-i aw-i14'), 'Save plan'], async () => { if (await form.save()) open(ret, draft.id); }, 'aw-btn aw-pri aw-grow', { id: 'aw-plan-save' }),
        btn('Close', () => kit.leaveForm(), 'aw-btn aw-out aw-grow'));
      kit.foot.hidden = false;
      return {
        nodes: [
          h('div', { class: 'aw-row' }, kit.backButton(ret.screen, () => kit.leaveForm()), heading('Plans')),
          errs.summary,
          h('div', { class: 'aw-row aw-gap6 aw-wrapbtns' },
            h('div', { class: 'aw-grow' }, field('Saved plan', picker)),
            btn([icon('plus', 'aw-i aw-i12'), 'New plan'], () => switchTo('__new'), 'aw-btn aw-out aw-sm'),
            btn('Save copy', copy, 'aw-btn aw-out aw-sm'),
            btn([icon('trash', 'aw-i aw-i12')], remove, 'aw-btn aw-gh aw-ic aw-sm', { 'aria-label': `Delete plan ${draft.name}` })),
          field('Plan name', nameIn, errs, 'name'),
          section('Run configuration',
            h('div', { class: 'aw-g2' }, field('Strategy', strategy, errs, 'strategy'), field('Send mode', mode, errs, 'mode')),
            h('div', { class: 'aw-g2' }, num('Iterations (Run Load)', 'iterations', 1, BOUNDS.iterations, 'Run plan once always runs one pass and leaves this unchanged.'), concField),
            h('div', { class: 'aw-g2' }, num('Delay after each iteration/job, ms', 'delayMs', 0, BOUNDS.delayMs), field('On failure', fail, errs, 'onFailure')),
            ramp,
            h('div', { class: 'aw-row aw-gap8 aw-wrapbtns' }, h('div', { class: 'aw-grow' }, field('When the run ends', notify, errs, 'notify')), notifyBtn)),
          section('Steps',
            h('div', { class: 'aw-row aw-gap6 aw-wrapbtns' }, filterIn, btn('Load all', () => bulk('load')), btn('Skip all', () => bulk('skip'))),
            scope, stepsEl),
          section('Preflight', pfEl),
          actions,
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
