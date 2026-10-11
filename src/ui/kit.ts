// Shared view vocabulary for panel screens: navigation contract, draft forms and small controls.
import type { Diag } from '../data/schema';
import type { Session } from '../data/store';
import type { Runtime } from '../net/runtime';
import { h, icon, type IconName } from './dom';

export type Screen = 'home' | 'test' | 'mock' | 'intercept' | 'route' | 'chaos' | 'endpoints' | 'import' | 'settings' | 'detail';
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
  fetchers: { direct: typeof fetch; rules: typeof fetch };
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
  runEndpoint(id: string): void;
  editEndpoint(id: string | null, extra?: (draft: unknown) => void): void;
  backButton(to: Screen, onClick: () => void): HTMLButtonElement;
}

export const NAME: Record<Screen, string> = { home: 'Home', test: 'Test', mock: 'Mock', intercept: 'Intercept', route: 'Route', chaos: 'Chaos', endpoints: 'Endpoints', import: 'Import', settings: 'Settings', detail: 'request' };

export const heading = (text: string, cls = 'aw-h') => h('h2', { class: cls, tabindex: '-1', 'data-focus': true }, text);
export const tile = (name: IconName) => h('div', { class: 'aw-tile' }, icon(name));
export const countBadge = (n = 0) => h('span', { class: 'aw-bd aw-s aw-cnt' }, String(n));
export const methodBadge = (m: string) => h('span', { class: `aw-bd aw-m aw-${m}` }, m === '*' ? 'ANY' : m);
export const section = (title: string, ...kids: (Node | null)[]) =>
  h('section', { class: 'aw-card aw-cp aw-col aw-gap10', 'aria-label': title }, h('h3', { class: 'aw-h aw-h13' }, title), ...kids);

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
