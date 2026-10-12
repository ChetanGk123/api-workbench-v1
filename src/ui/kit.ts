// Shared view vocabulary for panel screens: navigation contract, draft forms and small controls.
import type { Diag, Pair } from '../data/schema';
import type { Session } from '../data/store';
import type { Runtime } from '../net/runtime';
import type { Transport } from '../tester/once';
import { h, icon, type IconName } from './dom';

export type Screen = 'home' | 'test' | 'mock' | 'intercept' | 'route' | 'chaos' | 'endpoints' | 'import' | 'record' | 'settings' | 'detail' | 'pauses';
/** Where Back goes, and what to put back there: scroll positions and the focused row/control key. */
export interface Ret { screen: Screen; scroll: number; listScroll: number; focus: string | null }
export type Built = { nodes: Node[]; refresh?: () => void };

/** A draft workspace (editor) with the shared Keep editing / Discard / Save decision. */
export interface Form {
  owner: Screen;
  ret: Ret;
  dirty(): boolean;
  /** Validate and commit; false keeps the draft open with its errors shown. */
  save(): Promise<boolean>;
  build(): Built;
}

export interface Kit {
  rt: Runtime;
  session: Session;
  fetchers: { direct: Transport; rules: Transport };
  root: ShadowRoot;
  foot: HTMLElement;
  announce(text: string): void;
  ask(text: string, choices: { label: string; cls: string; value: string }[]): Promise<string>;
  here(): Ret;
  go(s: Screen): void;
  goBack(r: Ret, focus?: string | null): void;
  openForm(f: Form): void;
  /** Leave the open form without a dirty check (after a save or an explicit discard). */
  closeForm(focus?: string | null): void;
  /** Leave the open form through the dirty-draft decision. */
  leaveForm(): void;
  /** Run `next` after the open form's dirty-draft decision (immediately when nothing is unsaved). */
  guard(next: () => void): void;
  runEndpoint(id: string): void;
  editEndpoint(id: string | null, extra?: (draft: unknown) => void): void;
  backButton(to: Screen, onClick: () => void): HTMLButtonElement;
  /** Sub-bar for Settings / Import / Endpoints: Back to the screen they were opened from, icon + title. */
  subbar(name: IconName, title: string): HTMLElement;
  /** In-panel notice with an optional action; does not restore a minimized panel. */
  notice(text: string, action?: { label: string; run(): void }): void;
  /** Open Test → Results for one run. */
  showRun(id: string): void;
  /** Coalesced chrome + current screen refresh (background state changed). */
  changed(): void;
}

export const NAME: Record<Screen, string> = { home: 'Home', test: 'Test', mock: 'Mock', intercept: 'Intercept', route: 'Route', chaos: 'Chaos', endpoints: 'Endpoints', import: 'Import', record: 'Record', settings: 'Settings', detail: 'request', pauses: 'Paused requests' };

export const heading = (text: string, cls = 'aw-h') => h('h2', { class: cls, tabindex: '-1', 'data-focus': true }, text);
export const tile = (name: IconName) => h('div', { class: 'aw-tile' }, icon(name));
export const countBadge = (n = 0) => h('span', { class: 'aw-bd aw-s aw-cnt' }, String(n));
export const methodBadge = (m: string) => h('span', { class: `aw-bd aw-m aw-${m}` }, m === '*' ? 'ANY' : m);
/** Card section; a [icon, title] pair puts the icon before the title. */
export const section = (title: string | [IconName, string], ...kids: (Node | null)[]) => {
  const [name, text] = Array.isArray(title) ? title : [null, title];
  return h('section', { class: 'aw-card aw-cp aw-col aw-gap10', 'aria-label': text },
    h('h3', { class: 'aw-h aw-h13 aw-row aw-gap8' }, name ? icon(name, 'aw-i aw-i14 aw-mu') : null, text), ...kids);
};

export function btn(label: string | (Node | string)[], onClick: () => void, cls = 'aw-btn aw-out aw-sm', attrs: Record<string, string | boolean | undefined> = {}) {
  const b = h('button', { class: cls, type: 'button', ...attrs }, ...(Array.isArray(label) ? label : [label]));
  b.addEventListener('click', onClick);
  return b;
}

export function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void) {
  const b = h('button', { class: 'aw-cb', type: 'button', role: 'checkbox', 'aria-label': label });
  const set = (v: boolean) => {
    b.classList.toggle('aw-on', v);
    b.setAttribute('aria-checked', String(v));
    b.replaceChildren(...(v ? [icon('check', 'aw-i aw-i12')] : []));
  };
  set(checked);
  b.addEventListener('click', () => {
    const v = b.getAttribute('aria-checked') !== 'true';
    set(v);
    onChange(v);
  });
  return b;
}

/** On/off switch (role=switch) for settings that show or hide something. */
export function toggle(label: string, on: boolean, onChange: (v: boolean) => void) {
  const b = h('button', { class: `aw-sw${on ? ' aw-on' : ''}`, type: 'button', role: 'switch', 'aria-checked': String(on), 'aria-label': label }, h('span', { class: 'aw-th' }));
  b.addEventListener('click', () => {
    const v = b.getAttribute('aria-checked') !== 'true';
    b.classList.toggle('aw-on', v);
    b.setAttribute('aria-checked', String(v));
    onChange(v);
  });
  return b;
}

/** Native file input wrapped in a label styled as a button: the label opens the picker, the input keeps its name and focus. */
export function fileButton(input: HTMLInputElement, text = 'Choose file') {
  input.classList.add('aw-sr');
  return h('label', { class: 'aw-btn aw-out aw-sm aw-filebtn' }, icon('folder', 'aw-i aw-i14'), text, input);
}

/** "Format JSON" for a textarea: shown only while its text is valid, not yet 2-space formatted JSON. Formatting
 * dispatches `input`, so the field's own handler stores the new text. Code that sets the value must dispatch `input` too. */
export function formatJson(ta: HTMLTextAreaElement, label: string): HTMLButtonElement {
  const pretty = () => { try { return JSON.stringify(JSON.parse(ta.value), null, 2); } catch { return null; } };
  const b = btn('Format JSON', () => {
    const f = pretty();
    if (f === null) return;
    ta.value = f;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
  }, 'aw-btn aw-out aw-sm aw-fmt', { 'aria-label': label });
  const sync = () => { const f = ta.value.trim() ? pretty() : null; b.hidden = f === null || f === ta.value; };
  ta.addEventListener('input', sync);
  sync();
  return b;
}

/** A field with a Format JSON button appended (right-aligned, hidden until useful). */
export function withFormat(fieldEl: HTMLElement, ta: HTMLTextAreaElement, label: string) {
  fieldEl.append(formatJson(ta, label));
  return fieldEl;
}

let seq = 0;
/** Labelled input with an error slot registered under a field path. */
export function field(label: string, input: HTMLElement, errs?: Errors, path?: string, hint?: string) {
  const id = input.id || `aw-f${++seq}`;
  input.id = id;
  const err = h('span', { class: 'aw-err', id: `${id}-err`, role: 'alert' });
  input.setAttribute('aria-describedby', `${id}-err`);
  if (errs && path) errs.slot(path, err, input);
  return h('div', { class: 'aw-fld' }, h('label', { class: 'aw-lbl', for: id }, label), input, hint ? h('span', { class: 'aw-hint aw-wrap' }, hint) : null, err);
}

export function input(value: string, onInput: (v: string) => void, o: { mono?: boolean; placeholder?: string; label?: string; type?: string; id?: string } = {}) {
  const el = h('input', { class: `aw-in${o.mono ? ' aw-mono' : ''}`, spellcheck: 'false', placeholder: o.placeholder, 'aria-label': o.label, type: o.type, id: o.id });
  el.value = value;
  el.addEventListener('input', () => onInput(el.value));
  return el;
}

export function textarea(value: string, onInput: (v: string) => void, o: { label?: string; id?: string; rows?: number } = {}) {
  const el = h('textarea', { class: 'aw-ta aw-mono', spellcheck: 'false', 'aria-label': o.label, id: o.id, rows: o.rows ? String(o.rows) : undefined });
  el.value = value;
  el.addEventListener('input', () => onInput(el.value));
  return el;
}

export function select<T extends string>(value: T, options: readonly (T | [T, string])[], onChange: (v: T) => void, o: { label?: string; id?: string } = {}) {
  const el = h('select', { class: 'aw-in aw-select', 'aria-label': o.label, id: o.id },
    ...options.map((opt) => {
      const [v, text] = Array.isArray(opt) ? opt : [opt, opt];
      return h('option', { value: v, selected: v === value }, text);
    }));
  el.addEventListener('change', () => onChange(el.value as T));
  return el;
}

/** Editable [name, value] rows with per-row error slots under `path.i`. */
export function pairRows(list: Pair[], what: string, errs: Errors, path: string, onChange: () => void = () => {}) {
  const wrap = h('div', { class: 'aw-col aw-gap6' });
  const draw = (focusLast = false) => {
    wrap.replaceChildren(...list.map((p, i) => {
      const name = input(p[0], (v) => { p[0] = v; onChange(); }, { mono: true, label: `${what} ${i + 1} name`, placeholder: 'name' });
      const err = h('span', { class: 'aw-err', role: 'alert' });
      errs.slot(`${path}.${i}`, err, name);
      return h('div', { class: 'aw-col' }, h('div', { class: 'aw-row aw-gap6' }, name,
        input(p[1], (v) => { p[1] = v; onChange(); }, { mono: true, label: `${what} ${i + 1} value`, placeholder: 'value' }),
        btn([icon('x')], () => { list.splice(i, 1); onChange(); draw(); }, 'aw-btn aw-gh aw-ic aw-sm', { 'aria-label': `Remove ${what} ${i + 1}` })), err);
    }), btn([icon('plus', 'aw-i aw-i12'), `Add ${what}`], () => { list.push(['', '']); onChange(); draw(true); }, 'aw-btn aw-dash aw-sm'));
    if (focusLast) wrap.querySelectorAll<HTMLInputElement>('input')[list.length * 2 - 2]?.focus();
  };
  draw();
  return wrap;
}

/** Error slots keyed by field path; unmatched diagnostics go to a summary so none is silently lost. */
export class Errors {
  private slots = new Map<string, { el: HTMLElement; input: HTMLElement }>();
  readonly summary = h('div', { class: 'aw-alert aw-col aw-gap4', role: 'alert', hidden: true });
  slot(path: string, el: HTMLElement, input: HTMLElement) { this.slots.set(path, { el, input }); }
  clear() { this.slots.clear(); }
  /** Show diagnostics; returns true when there were any. Focuses the first problem. */
  show(diags: Diag[], announce: (t: string) => void): boolean {
    for (const { el, input } of this.slots.values()) { el.textContent = ''; input.removeAttribute('aria-invalid'); }
    const rest: Diag[] = [];
    let first: HTMLElement | null = null;
    for (const d of diags) {
      const s = this.slots.get(d.path);
      if (s) {
        s.el.textContent ||= d.message;
        s.input.setAttribute('aria-invalid', 'true');
        first ??= s.input;
      } else rest.push(d);
    }
    this.summary.hidden = !rest.length;
    this.summary.replaceChildren(...rest.slice(0, 8).map((d) => h('div', { class: 'aw-wrap' }, d.path ? `${d.path}: ${d.message}` : d.message)));
    if (diags.length) {
      announce(`Not saved: ${diags[0]!.message}`);
      if (!first) this.summary.setAttribute('tabindex', '-1');
      (first ?? this.summary).focus();
    }
    return diags.length > 0;
  }
}

/** Save text as a file without navigating or touching the host page. */
export function download(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  h('a', { href: url, download: name }).click(); // detached: the host DOM is never touched
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
