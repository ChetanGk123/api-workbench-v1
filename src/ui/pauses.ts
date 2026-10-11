// Paused request/response workspace (R5). The runtime owns every pause, its deadline and its single
// decision; this view only keeps per-pause drafts and sends one decision through rt.decide().
import { sensitiveName } from '../net/capture';
import { LIMITS } from '../net/plan';
import { checkEdit, type Pause, type PauseView } from '../net/runtime';
import { h, icon } from './dom';
import { btn, checkbox, countBadge, Errors, heading, input, methodBadge, pairRows, section, textarea, type Built, type Kit, type Screen } from './kit';

/** pairRows wants error slots; pause edits are checked as a whole by checkEdit instead. */
const noSlots = new Errors();

interface Draft { view: PauseView; reveal: boolean }

const SIGNED = /signature|hmac|digest|^x-amz-|nonce/i;
const STAGE = { request: 'Request: not sent yet', response: 'Response: server already replied' } as const;

export function createPausesUi(kit: Kit) {
  const rt = kit.rt;
  const drafts = new Map<number, Draft>();
  let selected = 0;

  const waiting = () => rt.pauses().filter((p) => p.state === 'waiting');
  const left = (p: Pause) => Math.max(0, Math.ceil((p.deadline - performance.now()) / 1000));
  const pathOf = (url: string) => { try { const u = new URL(url); return u.origin === rt.origin ? u.pathname + u.search : u.href; } catch { return url; } };

  /** Why the rule no longer matches its held snapshot; '' = current. Never changes the pause. */
  function stale(p: Pause): string {
    const c = rt.config();
    const r = c.rules.find((x) => x.id === p.ruleId);
    const why = !r ? 'The rule was deleted' : !r.enabled ? 'The rule is now disabled' : !c.active.intercept ? 'Intercept is now inactive' : r.revision !== p.ruleRevision ? 'The rule was edited' : '';
    return why && `${why} since this pause began. The held ${p.stage} is unchanged; the change applies to later requests.`;
  }

  function draftOf(p: Pause): Draft {
    let d = drafts.get(p.id);
    if (!d) drafts.set(p.id, (d = { view: structuredClone(p.held) as PauseView, reveal: false }));
    return d;
  }

  /** One alert line per editor; the pause stays waiting while it shows a problem. */
  function problem(el: HTMLElement, text: string) {
    el.textContent = text;
    el.hidden = false;
    kit.announce(`Not continued: ${text}`);
  }

  function decide(p: Pause, kind: 'continue' | 'original' | 'abort', err: HTMLElement) {
    const d = drafts.get(p.id);
    const out = rt.decide(p.id, kind === 'continue' && d ? { kind, edit: d.view } : kind === 'continue' ? { kind: 'original' } : { kind });
    if (out) return problem(err, out);
    drafts.delete(p.id);
    kit.announce(`Pause #${p.id}: ${rt.pauses().find((x) => x.id === p.id)?.outcome ?? 'ended'}.`);
  }

  function continueAll() {
    // One snapshot of the queue: each held item continues once; later arrivals stay queued.
    const ids = waiting().map((p) => p.id);
    let n = 0;
    for (const id of ids) if (!rt.decide(id, { kind: 'original' })) { n++; drafts.delete(id); }
    kit.announce(n ? `${n} paused ${n === 1 ? 'item' : 'items'} continued unchanged.` : 'Nothing was waiting.');
  }

  function screen(onBack: () => void, backTo: Screen): Built {
    const count = countBadge();
    const queue = h('ol', { class: 'aw-card aw-list', 'aria-label': 'Paused requests' });
    const empty = h('div', { class: 'aw-empty aw-wrap' }, 'Nothing is paused. Turn on a breakpoint in an Intercept rule and activate Intercept; matching real requests stop here.');
    const allBtn = btn('Continue all unchanged', continueAll, 'aw-btn aw-out aw-sm', { 'data-key': 'pause-all' });
    const detail = h('div', { class: 'aw-col aw-gap10' });
    let shown = '';
    let clock: HTMLElement | null = null;

    queue.addEventListener('click', (e) => {
      const b = (e.target as Element).closest('button[data-pause]');
      if (!b) return;
      selected = Number(b.getAttribute('data-pause'));
      refresh();
      detail.querySelector<HTMLElement>('[data-first]')?.focus();
    });

    function row(p: Pause) {
      const r = p.rec;
      const label = p.state === 'waiting' ? `${left(p)} s left` : p.state;
      return h('li', {}, h('button', {
        class: 'aw-li aw-actrow', type: 'button', 'data-pause': String(p.id), 'data-key': `pause-${p.id}`,
        'aria-current': p.id === selected ? 'true' : undefined,
        'aria-label': `Pause ${p.id}: request ${r.id}, ${r.method} ${pathOf(p.held.url ?? r.url)}, ${p.stage} stage, ${label}${p.id === selected ? ', selected' : ''}`,
      }, methodBadge(r.method), h('span', { class: 'aw-tr aw-grow aw-mono aw-xs' }, pathOf(p.held.url ?? r.url)),
      h('span', { class: 'aw-bd aw-h18' }, `${r.transport === 'fetch' ? 'Fetch' : 'XHR'} ${p.stage}`),
      h('span', { class: `aw-bd aw-h18 ${p.state === 'waiting' ? 'aw-am' : ''}` }, label)));
    }

    function body(p: Pause): Node[] {
      const r = p.rec;
      const live = p.state === 'waiting';
      const d = live ? draftOf(p) : null;
      const err = h('div', { class: 'aw-alert aw-wrap', role: 'alert', hidden: true });
      const dl = (rows: [string, string][]) => h('dl', { class: 'aw-dl' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', { class: 'aw-mono aw-wrap' }, v)]));
      clock = h('span', { class: 'aw-bd aw-am', 'aria-live': 'off' });
      const st = stale(p);
      const info = [
        h('div', { class: 'aw-row aw-gap8' }, h('span', { class: 'aw-h aw-h13 aw-grow', tabindex: '-1', 'data-first': true }, `Pause #${p.id} · request #${r.id}`), live ? clock : h('span', { class: 'aw-bd' }, p.state)),
        dl([
          ['Stage', STAGE[p.stage]],
          ['Transport', r.transport === 'fetch' ? 'Fetch' : `XHR${r.responseType ? ` · responseType ${r.responseType}` : ''}`],
          ['Original', `${r.method} ${r.url}${r.hasQuery ? '?…' : ''}`],
          ...(p.held.url ? [['Held URL', p.held.url] as [string, string]] : []),
          ['Rule', `${p.rule} · revision ${p.ruleRevision} · config ${r.revision}`],
          ['Caller', live ? 'Waiting' : r.outcome === 'pending' ? 'Released' : r.outcome],
          ['Deadline', `${LIMITS.pauseDeadlineMs / 1000} s from pause, then it continues unchanged`],
        ]),
        ...(st ? [h('div', { class: 'aw-alert aw-notice aw-wrap', role: 'status' }, icon('info', 'aw-i aw-i14'), st)] : []),
        ...(p.stage === 'response' ? [h('p', { class: 'aw-hint aw-wrap aw-m0' }, 'The server has already received and answered this request. Continue or Abort changes only what the page sees; it does not undo anything upstream.')] : []),
      ];
      if (!live) return [...info, h('p', { class: 'aw-wrap aw-m0' }, `Ended: ${p.outcome}. Nothing more can be sent from here.`)];

      const v = d!.view;
      const fields: (Node | null)[] = [];
      if (p.held.locked) fields.push(h('div', { class: 'aw-alert aw-notice aw-wrap' }, icon('alert', 'aw-i aw-i14'), p.held.locked));
      else {
        if (p.stage === 'request') fields.push(h('div', { class: 'aw-fld' }, h('label', { class: 'aw-lbl', for: 'aw-p-url' }, 'URL'), input(v.url ?? '', (x) => { v.url = x; }, { mono: true, id: 'aw-p-url' })));
        else fields.push(h('div', { class: 'aw-fld' }, h('label', { class: 'aw-lbl', for: 'aw-p-status' }, 'Status'), input(String(v.status), (x) => { v.status = x.trim() === '' ? NaN : Number(x); }, { mono: true, id: 'aw-p-status' })));
        const secret = v.headers.filter(([k]) => sensitiveName(k));
        if (secret.length && !d!.reveal) {
          // Hidden values stay in the draft untouched; only non-sensitive rows are editable.
          const plain = v.headers.filter(([k]) => !sensitiveName(k));
          const sync = () => { v.headers = [...secret, ...plain]; };
          fields.push(h('span', { class: 'aw-lbl' }, 'Headers'),
            h('ul', { class: 'aw-col aw-gap4 aw-m0' }, ...secret.map(([k]) => h('li', { class: 'aw-mono aw-xs' }, `${k}: •••••• (hidden)`))),
            pairRows(plain, `${p.stage} header`, noSlots, 'headers', sync));
        } else fields.push(h('span', { class: 'aw-lbl' }, 'Headers'), pairRows(v.headers, `${p.stage} header`, noSlots, 'headers'));
        if (secret.length) fields.push(h('div', { class: 'aw-chk' }, checkbox('Show sensitive values', d!.reveal, (x) => { d!.reveal = x; shown = ''; refresh(); }), 'Show sensitive values', h('span', { class: 'aw-mu' }, `— ${secret.map(([k]) => k).join(', ')}`)));
        fields.push('text' in v.body
          ? h('div', { class: 'aw-fld' }, h('label', { class: 'aw-lbl', for: 'aw-p-body' }, 'Body'), textarea(v.body.text, (x) => { v.body = { text: x }; }, { id: 'aw-p-body', rows: 6 }))
          : h('p', { class: 'aw-hint aw-wrap aw-m0' }, `Body: ${v.body.reason}`));
        if (p.stage === 'request' && p.held.headers.some(([k]) => SIGNED.test(k))) {
          fields.push(h('div', { class: 'aw-alert aw-notice aw-wrap' }, icon('alert', 'aw-i aw-i14'),
            `This request carries ${p.held.headers.filter(([k]) => SIGNED.test(k)).map(([k]) => k).join(', ')}. Edits are not re-signed: a changed URL, header or body may no longer match its signature.`));
        }
      }
      const cont = btn([icon('play', 'aw-i aw-i14'), 'Continue'], () => {
        const bad = checkEdit(p.stage, v);
        if (bad) return problem(err, bad);
        decide(p, 'continue', err);
      }, 'aw-btn aw-pri aw-sm', { 'data-key': `pause-go-${p.id}`, ...(p.held.locked && { hidden: true }) });
      return [...info,
        section(p.stage === 'request' ? 'Request to send' : 'Response to deliver', err, ...fields),
        h('div', { class: 'aw-row aw-gap8 aw-wrapbtns' }, cont,
          btn(p.held.locked ? 'Continue' : 'Continue original', () => decide(p, 'original', err), 'aw-btn aw-out aw-sm', { 'data-key': `pause-orig-${p.id}` }),
          btn([icon('stop', 'aw-i aw-i14'), 'Abort'], () => decide(p, 'abort', err), 'aw-btn aw-dst aw-sm', { 'data-key': `pause-abort-${p.id}` })),
        h('p', { class: 'aw-hint aw-wrap aw-m0' }, p.stage === 'request'
          ? 'Continue sends your edits once. Continue original sends the held request. Abort fails the call; nothing is sent.'
          : 'Continue delivers your edits. Continue original delivers the held response. Abort fails the call for the page.')];
    }

    function refresh() {
      const all = rt.pauses();
      const w = all.filter((p) => p.state === 'waiting');
      if (!all.some((p) => p.id === selected)) selected = w[0]?.id ?? all[0]?.id ?? 0;
      for (const id of drafts.keys()) if (!w.some((p) => p.id === id)) drafts.delete(id);
      count.textContent = `${w.length} / ${LIMITS.pauses}`;
      allBtn.disabled = !w.length;
      empty.hidden = all.length > 0;
      queue.hidden = !all.length;
      const focused = kit.root.activeElement?.closest?.('button[data-pause]')?.getAttribute('data-pause');
      queue.replaceChildren(...all.map(row));
      if (focused) queue.querySelector<HTMLElement>(`button[data-pause="${focused}"]`)?.focus();
      const p = all.find((x) => x.id === selected);
      // Rebuild the editor only when the selection, its state or its staleness changes: drafts and caret survive queue updates.
      const sig = p ? `${p.id}|${p.state}|${stale(p)}` : '';
      if (sig !== shown) {
        shown = sig;
        detail.replaceChildren(...(p ? body(p) : []));
      }
      if (p && clock) clock.textContent = `${left(p)} s left`;
    }

    return {
      nodes: [
        h('div', { class: 'aw-row' }, kit.backButton(backTo, onBack), heading('Paused requests'), count),
        h('p', { class: 'aw-hint aw-wrap aw-m0' }, `Breakpoints hold real requests before sending and real responses before delivery. Each waits at most ${LIMITS.pauseDeadlineMs / 1000} s, then continues unchanged; at most ${LIMITS.pauses} are held and later ones pass through. Mock and synthetic chaos replies are never paused.`),
        h('div', { class: 'aw-row' }, h('span', { class: 'aw-lbl aw-grow' }, 'Queue'), allBtn),
        empty, queue, detail,
      ],
      refresh,
    };
  }

  /** Summary for the Intercept screen. */
  function card(open: () => void) {
    const text = h('span', { class: 'aw-grow aw-wrap' });
    const b = btn('Open paused requests', open, 'aw-btn aw-out aw-sm', { 'data-key': 'pause-open' });
    const el = h('div', { class: 'aw-alert aw-notice aw-row aw-gap8', role: 'status' }, icon('pause', 'aw-i aw-i14'), text, b);
    const refresh = () => {
      const w = waiting();
      el.hidden = !w.length;
      const next = Math.min(...w.map(left));
      text.textContent = `${w.length} paused (cap ${LIMITS.pauses}) · next continues in ${next} s`;
    };
    return { el, refresh };
  }

  return { screen, card, waiting, select(id: number) { selected = id; } };
}
