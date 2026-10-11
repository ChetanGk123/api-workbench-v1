// RFC 6902 JSON Patch on an isolated value, plus literal text replace. Pure.
// Own properties only; prototype-chain path segments are refused before anything changes.
import { pointerProblem, type PatchOp, type Transform } from '../data/schema';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type PatchResult = { ok: true; value: unknown } | { ok: false; index: number; reason: string };

const segs = (p: string) => (p === '' ? [] : p.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~')));
const isObj = (x: unknown): x is Record<string, Json> => !!x && typeof x === 'object' && !Array.isArray(x);
const clone = (x: unknown) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]));
  }
  return false;
}

/** Parent container and final key for a pointer; throws a readable reason. */
function locate(doc: { root: unknown }, path: string): { parent: unknown; key: string } {
  const s = segs(path);
  let cur: unknown = doc.root;
  for (const k of s.slice(0, -1)) {
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(k) || Number(k) >= cur.length) throw new Error(`${path}: no item ${k}`);
      cur = cur[Number(k)];
    } else if (isObj(cur)) {
      if (!Object.hasOwn(cur, k)) throw new Error(`${path}: no field ${k}`);
      cur = cur[k];
    } else throw new Error(`${path}: ${k} is inside a ${cur === null ? 'null' : typeof cur}`);
  }
  return { parent: cur, key: s[s.length - 1]! };
}

function get(doc: { root: unknown }, path: string): unknown {
  if (path === '') return doc.root;
  const { parent, key } = locate(doc, path);
  if (Array.isArray(parent) && /^(0|[1-9]\d*)$/.test(key) && Number(key) < parent.length) return parent[Number(key)];
  if (isObj(parent) && Object.hasOwn(parent, key)) return parent[key];
  throw new Error(`${path} does not exist`);
}

function remove(doc: { root: unknown }, path: string): unknown {
  if (path === '') throw new Error('Cannot remove the whole value');
  const old = get(doc, path);
  const { parent, key } = locate(doc, path);
  if (Array.isArray(parent)) parent.splice(Number(key), 1);
  else delete (parent as Record<string, Json>)[key];
  return old;
}

function add(doc: { root: unknown }, path: string, value: unknown) {
  if (path === '') { doc.root = value; return; }
  const { parent, key } = locate(doc, path);
  if (Array.isArray(parent)) {
    if (key === '-') parent.push(value as Json);
    else if (/^(0|[1-9]\d*)$/.test(key) && Number(key) <= parent.length) parent.splice(Number(key), 0, value as Json);
    else throw new Error(`${path}: index ${key} is outside the list`);
  } else if (isObj(parent)) {
    Object.defineProperty(parent, key, { value, writable: true, enumerable: true, configurable: true });
  } else throw new Error(`${path}: parent is not an object or list`);
}

/** Apply every operation to a copy of `input`; on any failure nothing is returned but the reason. */
export function applyPatch(input: unknown, ops: readonly PatchOp[]): PatchResult {
  const doc = { root: clone(input) };
  for (const [i, o] of ops.entries()) {
    const bad = pointerProblem(o.path) ?? (o.from !== undefined ? pointerProblem(o.from) : null);
    if (bad) return { ok: false, index: i, reason: bad };
    try {
      switch (o.op) {
        case 'add': add(doc, o.path, clone(o.value)); break;
        case 'remove': remove(doc, o.path); break;
        case 'replace': get(doc, o.path); if (o.path === '') doc.root = clone(o.value); else { remove(doc, o.path); add(doc, o.path, clone(o.value)); } break;
        case 'move': {
          if (o.path.startsWith(o.from! + '/')) throw new Error(`Cannot move ${o.from} into itself`);
          const v = remove(doc, o.from!);
          add(doc, o.path, v);
          break;
        }
        case 'copy': add(doc, o.path, clone(get(doc, o.from!))); break;
        case 'test': if (!equal(get(doc, o.path), o.value)) throw new Error(`Test failed: ${o.path || 'the value'} is not ${JSON.stringify(o.value)}`); break;
      }
    } catch (e) {
      return { ok: false, index: i, reason: (e as Error).message };
    }
  }
  return { ok: true, value: doc.root };
}

/** Literal find/replace. No regular expressions. */
export function replaceText(text: string, find: string, by: string, scope: 'first' | 'all'): { text: string; count: number } {
  if (!find || !text.includes(find)) return { text, count: 0 };
  if (scope === 'first') return { text: text.replace(find, () => by), count: 1 };
  const parts = text.split(find);
  return { text: parts.join(by), count: parts.length - 1 };
}

/**
 * A transform's body part over text: patch (JSON only) then literal replace.
 * Returns the new text, or a reason it was not changed (the original stays in use).
 */
export function transformBody(text: string, t: Pick<Transform, 'patch' | 'replace'>): { ok: true; text: string; did: string[] } | { ok: false; reason: string } {
  const did: string[] = [];
  let out = text;
  if (t.patch.length) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return { ok: false, reason: 'Body is not valid JSON; JSON Patch not applied' }; }
    const r = applyPatch(parsed, t.patch);
    if (!r.ok) return { ok: false, reason: `JSON Patch operation ${r.index + 1} failed (${r.reason}); no operation applied` };
    out = JSON.stringify(r.value);
    did.push(`${t.patch.length} patch operation${t.patch.length > 1 ? 's' : ''}`);
  }
  if (t.replace) {
    const r = replaceText(out, t.replace.find, t.replace.with, t.replace.scope);
    if (r.count) { out = r.text; did.push(`${r.count} literal replacement${r.count > 1 ? 's' : ''}`); }
    else if (!did.length) return { ok: false, reason: 'Find text not present' };
    else did.push('find text not present after patch');
  }
  return { ok: true, text: out, did };
}

export const hasBodyOps = (t: Pick<Transform, 'patch' | 'replace'>) => t.patch.length > 0 || !!t.replace;
export const hasHeaderOps = (t: Pick<Transform, 'setHeaders' | 'removeHeaders'>) => t.setHeaders.length > 0 || t.removeHeaders.length > 0;

/** Apply set/remove to a Headers copy. Removal runs first, so a set of the same name wins. */
export function editHeaders(h: Headers, t: Pick<Transform, 'setHeaders' | 'removeHeaders'>): Headers {
  const out = new Headers(h);
  for (const n of t.removeHeaders) out.delete(n);
  for (const [n, v] of t.setHeaders) out.set(n, v);
  return out;
}
