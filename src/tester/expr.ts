// Expression grammar for {{ ... }}: parsed into a bounded tree and interpreted. Never JavaScript.
// Producer references, page sources, generators reserved once per prepared request, and a
// restricted $eval over literals, arithmetic, comparison, boolean logic and own-property paths.
import type { Binding, SourceRef } from '../data/schema';

export const EXPR_LIMITS = { chars: 512, segments: 16, nodes: 256, depth: 16, perRequest: 1000 } as const;

/** A JSON number kept as its exact source text, so 100.10 stays 100.10 and big integers stay exact. */
export class Num {
  constructor(readonly raw: string) {}
  toString() { return this.raw; }
}

/** JSON.parse that keeps every number's exact text (ES2025 source text access). */
export function parseExact(text: string): unknown {
  return JSON.parse(text, function (_k, v, ctx?: { source?: string }) {
    return typeof v === 'number' ? new Num(ctx?.source ?? String(v)) : v;
  } as (this: unknown, k: string, v: unknown) => unknown);
}

/** JSON text for a value that may contain Num, with exact numbers. */
export function stringifyExact(v: unknown): string {
  if (v instanceof Num) return v.raw;
  if (Array.isArray(v)) return `[${v.map(stringifyExact).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}:${stringifyExact(x)}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

// ---------- exact decimals

/** Plain decimal text for a number literal (exponents expanded), or null. */
export function decimalText(v: unknown): string | null {
  const s = v instanceof Num ? v.raw : typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v.trim() : null;
  if (s === null) return null;
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m) return null;
  let int = m[2]!, frac = m[3] ?? '';
  const exp = Number(m[4] ?? 0);
  if (Math.abs(exp) > 400) return null;
  if (exp > 0) { frac = frac.padEnd(exp, '0'); int += frac.slice(0, exp); frac = frac.slice(exp); }
  else if (exp < 0) { int = int.padStart(-exp + 1, '0'); frac = int.slice(exp) + frac; int = int.slice(0, exp); }
  int = int.replace(/^0+(?=\d)/, '');
  frac = frac.replace(/0+$/, '');
  return `${m[1] && (int !== '0' || frac) ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/** Exact comparison of two decimals: -1, 0, 1. No floating point. */
export function compareDecimal(a: string, b: string): number {
  const neg = (s: string) => s.startsWith('-');
  if (neg(a) !== neg(b)) return neg(a) ? -1 : 1;
  const sign = neg(a) ? -1 : 1;
  const [ai, af = ''] = a.replace('-', '').split('.') as [string, string?];
  const [bi, bf = ''] = b.replace('-', '').split('.') as [string, string?];
  if (ai.length !== bi.length) return (ai.length < bi.length ? -1 : 1) * sign;
  const w = Math.max(af.length, bf.length);
  const x = ai + af.padEnd(w, '0'), y = bi + bf.padEnd(w, '0');
  return x === y ? 0 : (x < y ? -1 : 1) * sign;
}

// ---------- syntax

type Lit = string | number | boolean | null;
export type Node =
  | { k: 'lit'; v: Lit | Num }
  | { k: 'path'; root: string; path: (string | number)[] }
  | { k: 'un'; op: '!' | '-'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node };

export type Expr =
  | { k: 'ref'; root: string; path: (string | number)[] }
  | { k: 'uuid' } | { k: 'timestamp' }
  | { k: 'counter'; name: string; start: number; step: number }
  | { k: 'randomInt'; min: number; max: number }
  | { k: 'source'; ref: SourceRef }
  | { k: 'context'; name: string }
  | { k: 'eval'; node: Node }
  | { k: 'marker'; name: 'redacted' | 'missing'; label?: string };

const BAD = new Set(['__proto__', 'prototype', 'constructor']);
type Tok = { t: 'id' | 'str' | 'num' | 'op' | 'end'; v: string; at: number };

function lex(src: string): Tok[] | string {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    const at = i;
    if (c === '"') {
      let s = '';
      i++;
      for (;;) {
        if (i >= src.length) return `Unclosed string at ${at + 1}`;
        const d = src[i++]!;
        if (d === '"') break;
        if (d === '\\') {
          const e = src[i++];
          if (e === '"' || e === '\\') s += e; else if (e === 'n') s += '\n'; else return `Unsupported escape at ${i}`;
        } else s += d;
      }
      out.push({ t: 'str', v: s, at });
    } else if (/[0-9]/.test(c)) {
      const m = /^\d+(\.\d+)?/.exec(src.slice(i))![0];
      out.push({ t: 'num', v: m, at });
      i += m.length;
    } else if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))![0];
      out.push({ t: 'id', v: m, at });
      i += m.length;
    } else {
      const two = src.slice(i, i + 2);
      if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) { out.push({ t: 'op', v: two, at }); i += 2; }
      else if ('()[].,+-*/%<>!'.includes(c)) { out.push({ t: 'op', v: c, at }); i++; }
      else return `Unexpected "${c}" at ${at + 1}`;
    }
  }
  out.push({ t: 'end', v: '', at: src.length });
  return out;
}

class P {
  i = 0;
  nodes = 0;
  constructor(readonly toks: Tok[]) {}
  peek() { return this.toks[this.i]!; }
  next() { return this.toks[this.i++]!; }
  is(v: string) { const t = this.peek(); return t.t === 'op' && t.v === v; }
  eat(v: string) { if (!this.is(v)) throw new SyntaxError(`Expected "${v}" at ${this.peek().at + 1}`); this.i++; }
  node<T extends Node>(n: T, depth: number): T {
    if (++this.nodes > EXPR_LIMITS.nodes) throw new SyntaxError(`More than ${EXPR_LIMITS.nodes} parts`);
    if (depth > EXPR_LIMITS.depth) throw new SyntaxError(`Nested deeper than ${EXPR_LIMITS.depth}`);
    return n;
  }
  /** Path after its root identifier: .name and [index] only, own properties, bounded. */
  path(root: string): { root: string; path: (string | number)[] } {
    if (BAD.has(root)) throw new SyntaxError(`"${root}" is not allowed`);
    const path: (string | number)[] = [];
    for (;;) {
      if (this.is('.')) {
        this.i++;
        const t = this.next();
        if (t.t !== 'id') throw new SyntaxError(`Expected a field name at ${t.at + 1}`);
        if (BAD.has(t.v)) throw new SyntaxError(`"${t.v}" is not allowed`);
        path.push(t.v);
      } else if (this.is('[')) {
        this.i++;
        const t = this.next();
        if (t.t !== 'num' || t.v.includes('.')) throw new SyntaxError(`Expected an array index at ${t.at + 1}`);
        path.push(Number(t.v));
        this.eat(']');
      } else break;
      if (path.length > EXPR_LIMITS.segments) throw new SyntaxError(`Path longer than ${EXPR_LIMITS.segments} segments`);
    }
    return { root, path };
  }
  // Restricted eval: precedence climbing over || && comparison + - * / % and unary ! -.
  expr(d: number): Node { return this.bin(d, 0); }
  static LEVELS = [['||'], ['&&'], ['==', '!=', '<', '<=', '>', '>='], ['+', '-'], ['*', '/', '%']];
  bin(d: number, level: number): Node {
    if (level === P.LEVELS.length) return this.unary(d);
    let a = this.bin(d + 1, level + 1);
    while (this.peek().t === 'op' && P.LEVELS[level]!.includes(this.peek().v)) {
      const op = this.next().v;
      a = this.node({ k: 'bin', op, a, b: this.bin(d + 1, level + 1) }, d);
      if (level === 2) break; // comparisons do not chain
    }
    return a;
  }
  unary(d: number): Node {
    if (this.is('!') || this.is('-')) { const op = this.next().v as '!' | '-'; return this.node({ k: 'un', op, a: this.unary(d + 1) }, d); }
    const t = this.next();
    if (t.t === 'num') return this.node({ k: 'lit', v: new Num(t.v) }, d);
    if (t.t === 'str') return this.node({ k: 'lit', v: t.v }, d);
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') return this.node({ k: 'lit', v: t.v === 'true' }, d);
      if (t.v === 'null') return this.node({ k: 'lit', v: null }, d);
      if (t.v.startsWith('$')) throw new SyntaxError(`${t.v} is not available inside $eval`);
      if (this.is('(')) throw new SyntaxError(`Calls are not allowed (${t.v}(…))`);
      return this.node({ k: 'path', ...this.path(t.v) }, d);
    }
    if (t.t === 'op' && t.v === '(') { const n = this.expr(d + 1); this.eat(')'); return n; }
    throw new SyntaxError(t.t === 'end' ? 'Expression ends too early' : `Unexpected "${t.v}" at ${t.at + 1}`);
  }
  args(): Tok[] {
    this.eat('(');
    const out: Tok[] = [];
    if (!this.is(')')) for (;;) {
      const neg = this.is('-') ? (this.i++, true) : false;
      const t = this.next();
      if (t.t !== 'str' && t.t !== 'num') throw new SyntaxError(`Arguments are literal text or numbers (at ${t.at + 1})`);
      out.push(neg ? { ...t, v: `-${t.v}` } : t);
      if (this.is(')')) break;
      this.eat(',');
    }
    this.eat(')');
    return out;
  }
}

const safeInt = (t: Tok | undefined, what: string) => {
  const n = t?.t === 'num' ? Number(t.v) : NaN;
  if (!Number.isSafeInteger(n)) throw new SyntaxError(`${what} must be a safe whole number`);
  return n;
};
const text = (t: Tok | undefined, what: string, max = 256) => {
  if (t?.t !== 'str' || !t.v) throw new SyntaxError(`${what} must be quoted text`);
  if (t.v.length > max) throw new SyntaxError(`${what} is longer than ${max} characters`);
  return t.v;
};

/** Parse the inside of one {{ }}. */
export function parseExpr(src: string): { ok: true; expr: Expr } | { ok: false; error: string } {
  if (src.length > EXPR_LIMITS.chars) return { ok: false, error: `Expression longer than ${EXPR_LIMITS.chars} characters` };
  const toks = lex(src);
  if (typeof toks === 'string') return { ok: false, error: toks };
  const p = new P(toks);
  try {
    const head = p.next();
    if (head.t !== 'id') throw new SyntaxError(head.t === 'end' ? 'Empty expression' : `Unexpected "${head.v}" at ${head.at + 1}`);
    let expr: Expr;
    if (!head.v.startsWith('$')) expr = { k: 'ref', ...p.path(head.v) };
    else {
      const name = head.v.slice(1);
      const noArgs = () => { if (p.is('(')) { const a = p.args(); if (a.length) throw new SyntaxError(`$${name} takes no arguments`); } };
      switch (name) {
        case 'uuid': noArgs(); expr = { k: 'uuid' }; break;
        case 'timestamp': noArgs(); expr = { k: 'timestamp' }; break;
        case 'redacted': noArgs(); expr = { k: 'marker', name }; break;
        case 'missing': {
          // Optional label names what an import could not supply: {{$missing("path id")}}.
          const a = p.is('(') ? p.args() : [];
          if (a.length > 1) throw new SyntaxError('$missing takes at most a label');
          expr = a.length ? { k: 'marker', name, label: text(a[0], 'Label', 64) } : { k: 'marker', name };
          break;
        }
        case 'counter': {
          const a = p.args();
          expr = { k: 'counter', name: text(a[0], 'Counter name'), start: a.length > 1 ? safeInt(a[1], 'Initial value') : 1, step: a.length > 2 ? safeInt(a[2], 'Step') : 1 };
          if (a.length > 3) throw new SyntaxError('$counter takes name, initial, step');
          break;
        }
        case 'randomInt': {
          const a = p.args();
          if (a.length !== 2) throw new SyntaxError('$randomInt takes min and max');
          const min = safeInt(a[0], 'Min'), max = safeInt(a[1], 'Max');
          if (max < min) throw new SyntaxError('Max must be at least min');
          expr = { k: 'randomInt', min, max };
          break;
        }
        case 'cookie': case 'localStorage': case 'sessionStorage': case 'meta': {
          const a = p.args();
          if (a.length !== 1) throw new SyntaxError(`$${name} takes one quoted name`);
          expr = { k: 'source', ref: { kind: name, key: text(a[0], 'Name') } };
          break;
        }
        case 'dom': {
          const a = p.args();
          if (a.length !== 2) throw new SyntaxError('$dom takes a selector and "value", "text" or "attr:<name>"');
          const mode = text(a[1], 'Mode');
          if (!/^(value|text|attr:[A-Za-z_:][-A-Za-z0-9_.:]{0,63})$/.test(mode)) throw new SyntaxError('$dom reads "value", "text" or "attr:<name>" only');
          expr = { k: 'source', ref: { kind: 'dom', key: text(a[0], 'Selector'), mode: mode as NonNullable<SourceRef['mode']> } };
          break;
        }
        case 'context': {
          const a = p.args();
          if (a.length !== 1) throw new SyntaxError('$context takes one binding name');
          expr = { k: 'context', name: text(a[0], 'Binding name') };
          break;
        }
        case 'eval': {
          const a = p.args();
          if (a.length !== 1) throw new SyntaxError('$eval takes one quoted expression');
          const inner = lex(text(a[0], 'Expression', EXPR_LIMITS.chars));
          if (typeof inner === 'string') throw new SyntaxError(inner);
          const q = new P(inner);
          const node = q.expr(1);
          if (q.peek().t !== 'end') throw new SyntaxError(`Unexpected "${q.peek().v}" at ${q.peek().at + 1} inside $eval`);
          expr = { k: 'eval', node };
          break;
        }
        default: throw new SyntaxError(`Unknown built-in $${name}`);
      }
    }
    if (p.peek().t !== 'end') throw new SyntaxError(`Unexpected "${p.peek().v}" at ${p.peek().at + 1}`);
    return { ok: true, expr };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Every {{ }} token in a field: [full match, inner text, index]. */
export const tokens = (s: string) => [...s.matchAll(/\{\{([^}]*)\}\}/g)].map((m) => ({ raw: m[0], inner: m[1]!.trim(), at: m.index! }));

/** Producer aliases a text field references (parsed, including inside $eval). Invalid tokens are ignored here. */
export function referencedAliases(s: string): string[] {
  const out = new Set<string>();
  const walk = (n: Node) => {
    if (n.k === 'path') out.add(n.root);
    else if (n.k === 'un') walk(n.a);
    else if (n.k === 'bin') { walk(n.a); walk(n.b); }
  };
  for (const t of tokens(s)) {
    const r = parseExpr(t.inner);
    if (!r.ok) continue;
    if (r.expr.k === 'ref') out.add(r.expr.root);
    if (r.expr.k === 'eval') walk(r.expr.node);
  }
  return [...out];
}

// ---------- evaluation

/** Page values read at dispatch. Each returns undefined when the source has no such value. */
export interface Sources {
  cookie(name: string): string | undefined;
  localStorage(key: string): string | undefined;
  sessionStorage(key: string): string | undefined;
  meta(name: string): string | undefined;
  dom?(selector: string, mode: string): string | undefined;
}

export function readSource(src: Sources, ref: SourceRef): string | undefined {
  try {
    if (ref.kind === 'dom') return src.dom?.(ref.key, ref.mode ?? 'value');
    return src[ref.kind](ref.key);
  } catch { return undefined; }
}
export const describeSource = (r: SourceRef) => r.kind === 'dom' ? `dom "${r.key}" ${r.mode}` : `${r.kind} "${r.key}"`;

/** Same-context producer output lookup: found, or why not. */
export type Outputs = (alias: string) => { ok: true; value: unknown } | { ok: false; why: string };

export interface Env {
  sources: Sources;
  bindings: readonly Binding[];
  aliases: ReadonlySet<string>;
  /** Absent (Once): producer references block instead of reusing an unrelated latest response. */
  outputs?: Outputs;
  /** One reservation per identical generated expression in this prepared request. */
  reserved: Map<string, unknown>;
  /** Named counters: run-scoped in plans, a transient scope in Once. */
  counters: Map<string, number>;
  now(): number;
  uuid(): string;
  random(): number;
}

export class Blocked extends Error {}

/** Own-property path lookup. No prototype traversal, no getters invoked on page objects (data only). */
export function walk(root: unknown, path: readonly (string | number)[]): { found: boolean; value?: unknown } {
  let cur = root;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object' || cur instanceof Num || !Object.hasOwn(cur, key)) return { found: false };
    if (Array.isArray(cur) !== (typeof key === 'number')) return { found: false };
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return { found: true, value: cur };
}

const pathText = (root: string, path: readonly (string | number)[]) => root + path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('');

function refValue(env: Env, root: string, path: readonly (string | number)[]): unknown {
  if (!env.aliases.has(root)) throw new Blocked(`no endpoint has alias ${root}`);
  if (!env.outputs) throw new Blocked(`{{${pathText(root, path)}}} needs ${root}'s response from the same plan run; Once never reuses an earlier response`);
  const out = env.outputs(root);
  if (!out.ok) throw new Blocked(out.why);
  const at = walk(out.value, path);
  if (!at.found) throw new Blocked(`${pathText(root, path)} is not in ${root}'s response`);
  return at.value;
}

const isNum = (v: unknown) => v instanceof Num || typeof v === 'number';
function toNumber(v: unknown): number {
  const n = v instanceof Num ? Number(v.raw) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Blocked('arithmetic needs numbers');
  return n;
}

function evalNode(env: Env, n: Node): unknown {
  switch (n.k) {
    case 'lit': return n.v;
    case 'path': {
      const b = env.bindings.find((x) => x.name === n.root);
      if (b && !n.path.length) return contextValue(env, n.root);
      return refValue(env, n.root, n.path);
    }
    case 'un': {
      const a = evalNode(env, n.a);
      if (n.op === '!') { if (typeof a !== 'boolean') throw new Blocked('! needs true or false'); return !a; }
      return checkSafe(-toNumber(a));
    }
    case 'bin': {
      if (n.op === '&&' || n.op === '||') {
        const a = evalNode(env, n.a);
        if (typeof a !== 'boolean') throw new Blocked(`${n.op} needs true or false`);
        if (n.op === '&&' ? !a : a) return a;
        const b = evalNode(env, n.b);
        if (typeof b !== 'boolean') throw new Blocked(`${n.op} needs true or false`);
        return b;
      }
      const a = evalNode(env, n.a), b = evalNode(env, n.b);
      if (['==', '!=', '<', '<=', '>', '>='].includes(n.op)) {
        let c: number | null = null;
        if (isNum(a) && isNum(b)) c = compareDecimal(decimalText(a)!, decimalText(b)!);
        else if (typeof a === 'string' && typeof b === 'string' && (n.op === '==' || n.op === '!=')) c = a === b ? 0 : 1;
        else if ((a === null || typeof a === 'boolean' || b === null || typeof b === 'boolean') && (n.op === '==' || n.op === '!=')) c = a === b ? 0 : 1;
        else if (typeof a === 'string' && typeof b === 'string') c = a < b ? -1 : a > b ? 1 : 0;
        if (c === null) throw new Blocked(`cannot compare ${typeName(a)} with ${typeName(b)}`);
        return n.op === '==' ? c === 0 : n.op === '!=' ? c !== 0 : n.op === '<' ? c < 0 : n.op === '<=' ? c <= 0 : n.op === '>' ? c > 0 : c >= 0;
      }
      if (n.op === '+' && typeof a === 'string' && typeof b === 'string') return a + b;
      const x = toNumber(a), y = toNumber(b);
      if ((n.op === '/' || n.op === '%') && y === 0) throw new Blocked('division by zero');
      return checkSafe(n.op === '+' ? x + y : n.op === '-' ? x - y : n.op === '*' ? x * y : n.op === '/' ? x / y : x % y);
    }
  }
}
function checkSafe(n: number): number {
  if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n))) throw new Blocked('result is outside the safe number range');
  return n;
}
export const typeName = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : v instanceof Num ? 'number' : typeof v);

function contextValue(env: Env, name: string): string {
  const b = env.bindings.find((x) => x.name === name);
  if (!b) throw new Blocked(`no binding named ${name} (define it under Auth & context)`);
  const v = readSource(env.sources, b.source);
  if (v === undefined) throw new Blocked(`binding ${name} (${describeSource(b.source)}) is not available on this page`);
  return v;
}

/** One expression's value. Generated values are reserved once per identical expression text. */
export function evaluate(env: Env, inner: string): { value: unknown; secret: boolean } {
  const r = parseExpr(inner);
  if (!r.ok) throw new Blocked(`{{${inner}}}: ${r.error}`);
  const e = r.expr;
  const reserve = (make: () => unknown) => {
    const key = inner.replace(/\s+/g, '');
    if (!env.reserved.has(key)) env.reserved.set(key, make());
    return env.reserved.get(key);
  };
  switch (e.k) {
    case 'marker': throw new Blocked(e.name === 'redacted' ? 'value was redacted on export or capture; enter it again' : e.label ? `${e.label}: not supplied by the import; enter it before sending` : 'not captured when recorded or imported; enter it before sending');
    case 'ref': return { value: refValue(env, e.root, e.path), secret: false };
    case 'uuid': return { value: reserve(env.uuid), secret: false };
    case 'timestamp': return { value: reserve(() => new Num(String(env.now()))), secret: false };
    case 'randomInt': return { value: reserve(() => new Num(String(e.min + Math.floor(env.random() * (e.max - e.min + 1))))), secret: false };
    case 'counter': return {
      value: reserve(() => {
        const cur = env.counters.get(e.name);
        const next = cur === undefined ? e.start : cur + e.step;
        if (!Number.isSafeInteger(next)) throw new Blocked(`counter ${e.name} left the safe number range`);
        env.counters.set(e.name, next);
        return new Num(String(next));
      }),
      secret: false,
    };
    case 'source': {
      const v = readSource(env.sources, e.ref);
      if (v === undefined) throw new Blocked(`${e.ref.kind === 'dom' ? `dom "${e.ref.key}"` : `${e.ref.kind} "${e.ref.key}"`} is not available on this page`);
      return { value: v, secret: true };
    }
    case 'context': return { value: contextValue(env, e.name), secret: true };
    case 'eval': return { value: evalNode(env, e.node), secret: false };
  }
}

/** Documented text conversion: strings as-is, numbers exactly, booleans/null as words. Objects are refused. */
export function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Num) return v.raw;
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  throw new Blocked(`is ${typeName(v)}; pick a field inside it`);
}

export type Site = 'url' | 'text' | 'header' | 'json';

/**
 * Resolve every {{ }} in one field for its site. URL values are encoded as components; header values
 * reject line breaks; in JSON a token that is a whole value (bare, or the entire string) keeps its type.
 * Problems are pushed to `blocked` prefixed by `where`; `secret` notes values read from page sources.
 */
export function render(text: string, site: Site, where: string, env: Env, blocked: string[], secret: { hit: boolean }, count: { n: number }): string {
  if (!text.includes('{{')) return text;
  const one = (inner: string, whole: boolean): string => {
    if (++count.n > EXPR_LIMITS.perRequest) throw new Blocked(`more than ${EXPR_LIMITS.perRequest} expressions in one request`);
    const { value, secret: s } = evaluate(env, inner);
    if (s) secret.hit = true;
    if (site === 'json' && whole) return stringifyExact(value);
    let t: string;
    try { t = asText(value); } catch (e) { throw new Blocked(`{{${inner}}} ${(e as Error).message}`); }
    if (site === 'url') return encodeURIComponent(t);
    if (site === 'header' && /[\r\n\0]/.test(t)) throw new Blocked(`{{${inner}}} resolved to a value with a line break`);
    if (site === 'json') return JSON.stringify(t).slice(1, -1);
    return t;
  };
  const guard = (inner: string, whole: boolean) => {
    try { return one(inner, whole); } catch (e) {
      if (!(e instanceof Blocked)) throw e;
      blocked.push(`${where}: ${e.message}`);
      return '';
    }
  };
  if (site !== 'json') return text.replace(/\{\{([^}]*)\}\}/g, (_m, inner: string) => guard(inner.trim(), false));
  // JSON: track string state so a token's position (whole value or inside text) is known.
  let out = '';
  let i = 0;
  let inStr = false;
  let strStart = -1;
  while (i < text.length) {
    if (text.startsWith('{{', i)) {
      const end = text.indexOf('}}', i);
      if (end < 0) { out += text.slice(i); break; }
      const inner = text.slice(i + 2, end).trim();
      const after = end + 2;
      if (!inStr) out += guard(inner, true);
      else if (strStart === i - 1 && text[after] === '"') {
        // "{{x}}" exactly: replace the quotes too, keeping the value's own JSON type.
        out = out.slice(0, -1) + guard(inner, true);
        inStr = false;
        i = after + 1;
        continue;
      } else out += guard(inner, false);
      i = after;
      continue;
    }
    const c = text[i]!;
    if (inStr && c === '\\') { out += text.slice(i, i + 2); i += 2; continue; }
    if (c === '"') { inStr = !inStr; if (inStr) strStart = i; }
    out += c;
    i++;
  }
  return out;
}

/** Validate a template field without resolving it (editor/preflight): syntax errors with location. */
export function syntaxProblems(text: string, where: string): string[] {
  return tokens(text).flatMap((t) => { const r = parseExpr(t.inner); return r.ok ? [] : [`${where}: {{${t.inner}}}: ${r.error}`]; });
}
