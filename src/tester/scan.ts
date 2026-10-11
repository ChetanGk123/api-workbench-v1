// Explicit, bounded page-context discovery. Runs only on a user action over selected categories;
// reads own data properties only (getters are never invoked, functions skipped) and masks values.
import type { SourceRef } from '../data/schema';
import { mask } from './once';

export const SCAN_LIMITS = { perCategory: 40, total: 200, globalDepth: 3 } as const;
export type Category = 'cookie' | 'localStorage' | 'sessionStorage' | 'meta' | 'dom' | 'global';
export interface Candidate {
  category: Category;
  /** What a binding would store (absent for globals: discovery only in this build). */
  source?: SourceRef;
  label: string;
  preview: string;
}
export interface ScanResult { candidates: Candidate[]; errors: string[]; truncated: string[] }

export function scanPage(cats: ReadonlySet<Category>, roots: string[], w: Window = window): ScanResult {
  const out: Candidate[] = [];
  const errors: string[] = [];
  const truncated: string[] = [];
  const add = (c: Candidate, perCat: { n: number }) => {
    if (out.length >= SCAN_LIMITS.total) { if (!truncated.includes('total')) truncated.push('total'); return false; }
    if (perCat.n >= SCAN_LIMITS.perCategory) { if (!truncated.includes(c.category)) truncated.push(c.category); return false; }
    perCat.n++;
    out.push(c);
    return true;
  };
  const view = (v: string) => (v ? mask(v) : '(empty)');

  if (cats.has('cookie')) {
    const n = { n: 0 };
    try {
      for (const part of w.document.cookie.split(';')) {
        const i = part.indexOf('=');
        if (i <= 0) continue;
        const key = part.slice(0, i).trim();
        if (!add({ category: 'cookie', source: { kind: 'cookie', key }, label: key, preview: view(part.slice(i + 1).trim()) }, n)) break;
      }
    } catch (e) { errors.push(`Cookies: ${(e as Error).message}`); }
  }
  for (const kind of ['localStorage', 'sessionStorage'] as const) {
    if (!cats.has(kind)) continue;
    const n = { n: 0 };
    try {
      const st = w[kind]; // access itself can throw (blocked storage): inside the try
      for (let i = 0; i < st.length; i++) {
        const key = st.key(i);
        if (key === null) continue;
        if (!add({ category: kind, source: { kind, key }, label: key, preview: view(st.getItem(key) ?? '') }, n)) break;
      }
    } catch (e) { errors.push(`${kind}: ${(e as Error).message || 'not available'}`); }
  }
  if (cats.has('meta')) {
    const n = { n: 0 };
    const seen = new Map<string, number>();
    const metas = [...w.document.querySelectorAll('meta[name]')];
    for (const m of metas) seen.set(m.getAttribute('name')!, (seen.get(m.getAttribute('name')!) ?? 0) + 1);
    for (const m of metas) {
      const key = m.getAttribute('name')!;
      if (seen.get(key)! > 1) { errors.push(`meta ${key}: ${seen.get(key)} tags share this name, so it cannot be resolved uniquely`); seen.set(key, 0); continue; }
      if (seen.get(key) === 0) continue;
      if (!add({ category: 'meta', source: { kind: 'meta', key }, label: key, preview: view(m.getAttribute('content') ?? '') }, n)) break;
    }
  }
  if (cats.has('dom')) {
    const n = { n: 0 };
    for (const el of w.document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select')) {
      if (el.closest('[data-api-workbench]')) continue;
      const sel = el.id ? `#${CSS.escape(el.id)}` : el.name ? `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]` : '';
      if (!sel || w.document.querySelectorAll(sel).length !== 1) continue;
      if (!add({ category: 'dom', source: { kind: 'dom', key: sel, mode: 'value' }, label: `${sel}${el instanceof HTMLInputElement ? ` (${el.type})` : ''}`, preview: view(el.value) }, n)) break;
    }
  }
  if (cats.has('global')) {
    const n = { n: 0 };
    const walk = (obj: object, path: string, depth: number) => {
      let keys: string[];
      try { keys = Object.keys(obj); } catch { return; }
      for (const k of keys.slice(0, SCAN_LIMITS.perCategory)) {
        if (n.n >= SCAN_LIMITS.perCategory || out.length >= SCAN_LIMITS.total) return;
        let d: PropertyDescriptor | undefined;
        try { d = Object.getOwnPropertyDescriptor(obj, k); } catch { continue; }
        if (!d || !('value' in d)) continue; // accessor: never invoked
        const v = d.value;
        const p = `${path}.${k}`;
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') add({ category: 'global', label: p, preview: view(String(v)) }, n);
        else if (v && typeof v === 'object' && depth < SCAN_LIMITS.globalDepth && (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype)) walk(v, p, depth + 1);
      }
    };
    for (const root of roots) {
      if (!/^[A-Za-z_$][\w$]*$/.test(root)) { errors.push(`Global root "${root}" is not a plain name`); continue; }
      let d: PropertyDescriptor | undefined;
      try { d = Object.getOwnPropertyDescriptor(w, root); } catch { d = undefined; }
      if (!d) { errors.push(`window.${root} does not exist`); continue; }
      if (!('value' in d)) { errors.push(`window.${root} is a getter; not invoked`); continue; }
      if (d.value && typeof d.value === 'object') walk(d.value, root, 1);
      else errors.push(`window.${root} is not an object`);
    }
  }
  return { candidates: out, errors, truncated };
}
