// Snippet adapters: DevTools "Copy as cURL" (bash and Windows cmd) and "Copy as fetch". Bounded
// literal grammars, not a shell or a JavaScript engine: substitutions, variables, calls, pipes and
// redirects are refused with a location, files are never read and nothing is executed or sent.
import { cleanPairs, redactText, sensitiveName } from '../net/capture';
import type { Draft } from './review';
import { BOUNDS, utf8Bytes, type Body, type Credentials, type Pair, type Part } from './schema';
import { draftHeaders, HTTP, missing, red, redactedRequires, type Red } from './specs';

export type Dialect = 'bash' | 'cmd';
export const SNIPPET_MAX_COMMANDS = 200;

type Diag = { path: string; message: string };
export type SnippetResult = { ok: true; value: { label: string; drafts: Draft[]; skipped: string[]; notes: string[] } } | { ok: false; errors: Diag[] };

/** 1-based line and column of an offset, for diagnostics. */
function at(src: string, i: number): string {
  const before = src.slice(0, i);
  const line = before.split('\n').length;
  return `line ${line}, column ${i - before.lastIndexOf('\n')}`;
}
class Refused extends Error { constructor(msg: string, readonly pos: number) { super(msg); } }

interface Word { text: string; pos: number }

// ---------- bash words (DevTools output: '…', $'…', "…", \ continuation; " ;" between commands)

function bashWords(src: string): Word[][] {
  const cmds: Word[][] = [[]];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === '\\' && (src[i + 1] === '\n' || (src[i + 1] === '\r' && src[i + 2] === '\n'))) { i += src[i + 1] === '\r' ? 3 : 2; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '\n' || c === ';') { cmds.push([]); i++; continue; }
    if (c === '&' && src[i + 1] === '&') throw new Refused('&& joins commands into a script; paste separate commands', i);
    if ('|<>&()`'.includes(c)) throw new Refused(`"${c}" is shell syntax (pipe, redirect, background or substitution) and is not supported`, i);
    if (c === '#') throw new Refused('Comments are not supported', i);
    const pos = i;
    let text = '';
    while (i < n && !' \t\r\n;'.includes(src[i]!)) {
      const d = src[i]!;
      if (d === '\\') {
        if (src[i + 1] === '\n') { i += 2; continue; }
        if (i + 1 >= n) throw new Refused('Trailing backslash', i);
        text += src[i + 1];
        i += 2;
      } else if (d === "'") {
        const end = src.indexOf("'", i + 1);
        if (end < 0) throw new Refused('Unclosed single quote', i);
        text += src.slice(i + 1, end);
        i = end + 1;
      } else if (d === '$' && src[i + 1] === "'") {
        i += 2;
        for (;;) {
          if (i >= n) throw new Refused("Unclosed $'…' quote", pos);
          const e = src[i]!;
          if (e === "'") { i++; break; }
          if (e !== '\\') { text += e; i++; continue; }
          const x = src[i + 1] ?? '';
          const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', '\\': '\\', "'": "'", '"': '"', '?': '?', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v' };
          if (x in simple) { text += simple[x]; i += 2; continue; }
          const hex = (len: number, re: RegExp) => { const m = re.exec(src.slice(i + 2, i + 2 + len)); return m ? m[0] : ''; };
          if (x === 'u' || x === 'U') {
            const h = hex(x === 'u' ? 4 : 8, /^[0-9a-fA-F]+/);
            if (!h) throw new Refused('Invalid \\u escape', i);
            text += String.fromCodePoint(parseInt(h, 16));
            i += 2 + h.length;
          } else if (x === 'x') {
            const h = hex(2, /^[0-9a-fA-F]+/);
            if (!h) throw new Refused('Invalid \\x escape', i);
            text += String.fromCharCode(parseInt(h, 16));
            i += 2 + h.length;
          } else if (/[0-7]/.test(x)) {
            const o = /^[0-7]{1,3}/.exec(src.slice(i + 1))![0];
            text += String.fromCharCode(parseInt(o, 8));
            i += 1 + o.length;
          } else { text += `\\${x}`; i += 2; }
        }
      } else if (d === '"') {
        i++;
        for (;;) {
          if (i >= n) throw new Refused('Unclosed double quote', pos);
          const e = src[i]!;
          if (e === '"') { i++; break; }
          if (e === '$' || e === '`') throw new Refused(`${e === '$' ? '$' : 'Backtick'} inside double quotes is a variable or substitution; it is not expanded`, i);
          if (e === '\\' && '$`"\\\n'.includes(src[i + 1] ?? '')) { if (src[i + 1] !== '\n') text += src[i + 1]; i += 2; continue; }
          text += e;
          i++;
        }
      } else if (d === '$') throw new Refused('$ outside quotes is a variable or substitution; it is not expanded', i);
      else if ('|<>&()`'.includes(d)) throw new Refused(`"${d}" is shell syntax and is not supported`, i);
      else if ('*?[{'.includes(d)) throw new Refused(`Unquoted "${d}" is a shell glob; quote the value`, i);
      else { text += d; i++; }
    }
    cmds[cmds.length - 1]!.push({ text, pos });
  }
  return cmds.filter((c) => c.length);
}

// ---------- Windows cmd words (DevTools output: ^"…^" with ^ escapes, " ^" continuation, " &" between commands)

/** Facts about a cmd copy that change fidelity, reported as notes. */
const cmdFacts = { replaced: 0, halved: 0, odd: 0 };

function cmdWords(src: string): Word[][] {
  // cmd.exe pass: ^ escapes the next character (^ + newline continues the line and takes the next
  // character literally); unescaped & separates commands; % variables, pipes and redirects are refused.
  cmdFacts.replaced = cmdFacts.halved = cmdFacts.odd = 0;
  const lines: { text: string; map: number[] }[] = [{ text: '', map: [] }];
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const cur = lines[lines.length - 1]!;
    const put = (ch: string, pos: number) => { cur.text += ch; cur.map.push(pos); };
    if (c === '\r') continue;
    if (quoted) { if (c === '"') quoted = false; if (c === '\n') throw new Refused('Unclosed double quote', i); put(c, i); continue; }
    if (c === '^') {
      let j = i + 1;
      if (src[j] === '\r') j++;
      if (src[j] === '\n') { j++; if (src[j] === '\r') j++; if (j < src.length) put(src[j]!, j); i = j; continue; }
      if (src[j] === ' ') cmdFacts.replaced++; // DevTools writes "^ " where it dropped a non-ASCII character
      if (j < src.length) put(src[j]!, j);
      i = j;
      continue;
    }
    if (c === '"') { quoted = true; put(c, i); continue; }
    if (c === '\n' || c === '&') {
      if (c === '&' && src[i + 1] === '&') throw new Refused('&& joins commands into a script; paste separate commands', i);
      lines.push({ text: '', map: [] });
      continue;
    }
    if ('|<>'.includes(c)) throw new Refused(`"${c}" is a pipe or redirect and is not supported`, i);
    if (c === '%' && /^%[A-Za-z_][\w]*%/.test(src.slice(i))) throw new Refused('%VARIABLE% expansion is not supported', i);
    if (c === '!' && /^![A-Za-z_][\w]*!/.test(src.slice(i))) throw new Refused('!VARIABLE! expansion is not supported', i);
    put(c, i);
  }
  // C runtime argument pass: whitespace splits outside quotes; backslashes escape quotes only.
  // DevTools doubles every backslash before escaping quotes, so an even run that is not before a
  // quote is halved to recover the copied request (curl.exe itself would keep the run doubled).
  return lines.map(({ text, map }) => {
    const words: Word[] = [];
    let i = 0;
    while (i < text.length) {
      if (/\s/.test(text[i]!)) { i++; continue; }
      const pos = map[i] ?? 0;
      let w = '';
      let q = false;
      while (i < text.length && (q || !/\s/.test(text[i]!))) {
        const c = text[i]!;
        if (c === '\\') {
          let k = i;
          while (text[k] === '\\') k++;
          const count = k - i;
          if (text[k] === '"') { w += '\\'.repeat(Math.floor(count / 2)); if (count % 2) { w += '"'; i = k + 1; } else i = k; }
          else if (count % 2 === 0) { w += '\\'.repeat(count / 2); cmdFacts.halved++; i = k; }
          else { w += '\\'.repeat(count); cmdFacts.odd++; i = k; }
          continue;
        }
        if (c === '"') { if (q && text[i + 1] === '"') { w += '"'; i += 2; continue; } q = !q; i++; continue; }
        w += c;
        i++;
      }
      words.push({ text: w, pos });
    }
    return words;
  }).filter((c) => c.length);
}

// ---------- curl options

const NO_VALUE: Record<string, string> = {
  '--compressed': 'Response compression is handled by the browser', '-s': '', '--silent': '', '-S': '', '--show-error': '', '-v': '', '--verbose': '', '-i': '', '--include': '',
  '-L': 'fetch follows redirects by default', '--location': 'fetch follows redirects by default', '-k': 'TLS checks cannot be bypassed from a page; the browser enforces them', '--insecure': 'TLS checks cannot be bypassed from a page; the browser enforces them',
  '-G': '', '--get': '', '-I': '', '--head': '', '--globoff': '', '-g': '', '--http1.1': 'The browser chooses the HTTP version', '--http2': 'The browser chooses the HTTP version',
};
const WITH_VALUE = new Set(['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '-F', '--form', '--form-string',
  '-u', '--user', '-b', '--cookie', '-c', '--cookie-jar', '-A', '--user-agent', '-e', '--referer', '--url', '-m', '--max-time', '--connect-timeout', '-o', '--output']);
const REFUSED: Record<string, string> = {
  '-x': 'Proxies cannot be used from a page', '--proxy': 'Proxies cannot be used from a page', '-T': 'File upload by path is not supported', '--upload-file': 'File upload by path is not supported',
  '-K': 'Config files are never read', '--config': 'Config files are never read', '--cacert': 'TLS settings are controlled by the browser', '--cert': 'TLS settings are controlled by the browser',
  '--resolve': 'DNS overrides are not possible from a page', '--unix-socket': 'Unix sockets are not reachable from a page',
};

/** One curl command (after `curl`) as a draft, or a reason it cannot be imported. */
function curlDraft(words: Word[], src: string, index: number, dialect: Dialect): Draft | string {
  const r: Red = red();
  const notes: string[] = [];
  const requires: string[] = [];
  let url = '';
  let method = '';
  let get = false;
  let head = false;
  const headers: Pair[] = [];
  const data: { text: string; kind: 'raw' | 'urlencode' }[] = [];
  const form: Part[] = [];
  let credentials: Credentials = 'same-origin';
  const opts: [string, string, number][] = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    let flag = w.text;
    let value: string | null = null;
    if (flag.startsWith('--') && flag.includes('=')) { value = flag.slice(flag.indexOf('=') + 1); flag = flag.slice(0, flag.indexOf('=')); }
    else if (/^-[A-Za-z]/.test(flag) && flag.length > 2 && WITH_VALUE.has(flag.slice(0, 2))) { value = flag.slice(2); flag = flag.slice(0, 2); }
    else if (/^-[A-Za-z]{2,}$/.test(flag) && [...flag.slice(1)].every((ch) => `-${ch}` in NO_VALUE)) { for (const ch of flag.slice(1)) opts.push([`-${ch}`, '', w.pos]); continue; }
    if (!flag.startsWith('-') || flag === '-') { if (url) return `two URLs (${url} and ${flag}) at ${at(src, w.pos)}`; url = flag; continue; }
    if (REFUSED[flag]) return `${flag} at ${at(src, w.pos)}: ${REFUSED[flag]}`;
    if (flag in NO_VALUE) { opts.push([flag, '', w.pos]); continue; }
    if (!WITH_VALUE.has(flag)) return `unsupported option ${flag} at ${at(src, w.pos)}`;
    if (value === null) {
      const next = words[++i];
      if (!next) return `${flag} at ${at(src, w.pos)} needs a value`;
      value = next.text;
    }
    opts.push([flag, value, w.pos]);
  }
  for (const [flag, value, pos] of opts) {
    switch (flag) {
      case '-X': case '--request': method = value.toUpperCase(); break;
      case '--url': if (url) return `two URLs at ${at(src, pos)}`; url = value; break;
      case '-H': case '--header': {
        const m = /^([^:;]+)(:|;)(.*)$/s.exec(value);
        if (!m) { notes.push(`Header "${value}" at ${at(src, pos)} has no name: value form and was skipped`); break; }
        const name = m[1]!.trim();
        const v = m[3]!.trim();
        if (m[2] === ':' && !v) { notes.push(`-H "${name}:" removes a curl default header; nothing to import`); break; }
        if (name.toLowerCase() === 'cookie') { credentials = 'include'; notes.push('Cookie header: cookie values are not imported; this browser sends its own cookies (credentials: include)'); break; }
        if (name.toLowerCase() === 'user-agent') { notes.push('Header User-Agent is set by the browser and was not kept'); break; }
        headers.push([name, v]);
        break;
      }
      case '-d': case '--data': case '--data-ascii': case '--data-binary':
        if (value.startsWith('@')) { data.push({ text: missing(`file ${value.slice(1)}`), kind: 'raw' }); requires.push(`Body from file ${value.slice(1)}: files are never read; enter the body before sending`); }
        else data.push({ text: flag === '--data-binary' ? value : value.replace(/[\r\n]/g, ''), kind: 'raw' });
        if (flag !== '--data-binary' && /[\r\n]/.test(value)) notes.push(`${flag} strips line breaks, as curl does; use --data-binary or --data-raw to keep them`);
        break;
      case '--data-raw': data.push({ text: value, kind: 'raw' }); break;
      case '--data-urlencode': {
        const eq = value.indexOf('=');
        const name = eq > 0 ? value.slice(0, eq) : '';
        const content = eq >= 0 ? value.slice(eq + 1) : value;
        if (/^[^=]*@/.test(value) && (eq < 0 || value.indexOf('@') < eq)) { data.push({ text: missing(`file for ${name || 'data'}`), kind: 'raw' }); requires.push(`--data-urlencode ${value}: files are never read; enter the value`); break; }
        data.push({ text: name ? `${name}=${encodeURIComponent(content)}` : encodeURIComponent(content), kind: 'urlencode' });
        break;
      }
      case '-F': case '--form': case '--form-string': {
        const eq = value.indexOf('=');
        if (eq <= 0) return `-F "${value}" at ${at(src, pos)} is not name=value`;
        const name = value.slice(0, eq);
        let v = value.slice(eq + 1);
        if (flag !== '--form-string' && (v.startsWith('@') || v.startsWith('<'))) {
          const path = v.slice(1).split(';')[0]!;
          const fn = /;filename=("?)([^;"]*)\1/.exec(v)?.[2] ?? path.split(/[\\/]/).pop() ?? '';
          if (v.startsWith('@')) { form.push({ kind: 'file', name, fileName: fn }); requires.push(`Choose the file for ${name} (${path} is never read) when running`); }
          else { form.push({ kind: 'field', name, value: missing(`file contents for ${name}`) }); requires.push(`Field ${name} reads ${path} as its value; files are never read; enter it`); }
          break;
        }
        if (flag !== '--form-string' && /;type=/.test(v)) { notes.push(`Field ${name}: ;type= is not represented; sent as a plain field`); v = v.replace(/;type=[^;]*/, ''); }
        form.push({ kind: 'field', name, value: sensitiveName(name) ? (r.redacted.push(`Field ${name}`), '{{$redacted}}') : v });
        break;
      }
      case '-u': case '--user':
        headers.push(['Authorization', `Basic ${missing('basic credentials')}`]);
        requires.push(`Authorization: -u credentials for ${value.split(':')[0] || 'the user'} are not imported; enter base64 user:password`);
        break;
      case '-b': case '--cookie':
        credentials = 'include';
        notes.push(value.includes('=') ? 'Cookies (-b): values are not imported; this browser sends its own cookies (credentials: include)' : `Cookie file ${value} is never read; this browser's cookies are sent (credentials: include)`);
        break;
      case '-c': case '--cookie-jar': notes.push('Cookie jar (-c) is ignored; the browser keeps cookies'); break;
      case '-A': case '--user-agent': notes.push('User-Agent is set by the browser and was not kept'); break;
      case '-e': case '--referer': notes.push('Referer is set by the browser and was not kept'); break;
      case '-m': case '--max-time': case '--connect-timeout': notes.push(`${flag} is not imported; set a timeout in the plan or Once`); break;
      case '-o': case '--output': notes.push(`${flag} is ignored; nothing is written`); break;
      case '-G': case '--get': get = true; break;
      case '-I': case '--head': head = true; break;
      default: if (NO_VALUE[flag]) notes.push(`${flag}: ${NO_VALUE[flag]}`);
    }
  }
  if (!url) return 'no URL';
  // curl URL globbing uses [] and {}; DevTools escapes them with a backslash.
  if (/(^|[^\\])[[{]/.test(url) && !opts.some(([f]) => f === '-g' || f === '--globoff')) return `URL ${url} uses curl globbing ([ ] or { }), which is not supported`;
  url = url.replace(/\\([[\]{}])/g, '$1');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) { url = `${HTTP}//${url}`; notes.push('The URL has no scheme; http is assumed, as curl does'); }
  let u: URL;
  try { u = new URL(url); } catch { return `invalid URL ${url}`; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${u.protocol} is not an HTTP URL`;
  if (u.username || u.password) { requires.push('Credentials in the URL are not imported; enter an Authorization header'); headers.push(['Authorization', `Basic ${missing('basic credentials')}`]); }
  const query: Pair[] = [...u.searchParams];
  if (form.length && data.length) return '-F and -d cannot be combined';
  let bodies: Draft['bodies'] = [];
  const joined = data.map((d) => d.text).join('&');
  if (data.length && get) { for (const [k, v] of new URLSearchParams(joined)) query.push([k, v]); }
  else if (data.length) {
    const ct = headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? 'application/x-www-form-urlencoded';
    if (utf8Bytes(joined) > BOUNDS.bodyBytes) { bodies = [{ label: 'data', contentType: ct, body: { kind: 'text', text: missing('request body') } }]; requires.push(`Body over ${BOUNDS.bodyBytes / 1024 / 1024} MiB was not imported`); }
    else bodies = [{ label: 'data', contentType: ct, body: textBody(joined, ct, r) }];
  } else if (form.length) bodies = [{ label: 'form', contentType: 'multipart/form-data', body: { kind: 'multipart', parts: form } }];
  const m = method || (head ? 'HEAD' : get ? 'GET' : data.length || form.length ? 'POST' : 'GET');
  const where = `command ${index} (${at(src, words[0]!.pos)})`;
  const clean = draftHeaders(headers, r);
  if (dialect === 'cmd') {
    if (cmdFacts.replaced) notes.push(`Windows cmd copy: ${cmdFacts.replaced} character(s) were written as "^ " — DevTools replaces non-ASCII text with spaces in cmd copies. Check text values, or use the bash or fetch copy.`);
    if (cmdFacts.halved) notes.push('Windows cmd copy: doubled backslashes were halved to recover the copied request, as DevTools doubles them (running the command in cmd would send them doubled)');
    if (cmdFacts.odd) notes.push('Windows cmd copy: an odd run of backslashes was kept as written');
  }
  if (bodies[0]?.body.kind === 'text' && /^multipart\//i.test(bodies[0].contentType)) multipartNote(bodies[0].body.text, notes, requires);
  return {
    name: u.pathname, method: m, url: u.origin + u.pathname, query: cleanPairs(query, r, 'Query'), headers: clean, credentials,
    bodies, source: `cURL (${dialect}) ${where}`, notes: collapse([...notes, ...r.notes]), requires: [...requires, ...redactedRequires(r)],
  };
}

/** Raw multipart text keeps its exact bytes and boundary; it only works with CRLF line ends. */
function multipartNote(text: string, notes: string[], requires: string[]) {
  if (text.includes('{{$missing(')) return;
  if (!text.includes('\r\n')) requires.push('Multipart body has no CRLF line ends (the copy dropped them), so its parts cannot be parsed by a server; rebuild it as form fields or use the bash or fetch copy');
  else notes.push('Multipart body is kept as exact text with its boundary; file parts carry the copied bytes, which DevTools shows as text (binary files are not exact)');
}

/** One note for all browser-set headers instead of one per header. */
function collapse(notes: string[]): string[] {
  const names: string[] = [];
  const rest = notes.filter((n) => { const m = /^Header (\S+) is set by the browser and was not kept$/.exec(n); if (m) names.push(m[1]!); return !m; });
  return names.length ? [`Set by the browser and not kept: ${names.join(', ')}`, ...rest] : rest;
}

function textBody(text: string, ct: string, r: Red): Body {
  if (/^application\/x-www-form-urlencoded/i.test(ct) && !text.includes('{{$missing(')) return { kind: 'urlencoded', pairs: cleanPairs(new URLSearchParams(text), r, 'Form') };
  const clean = redactText(text, ct, r, 'Body');
  return /json/i.test(ct) ? { kind: 'json', text: clean } : { kind: 'text', text: clean };
}

/** The dialect a cURL snippet was copied in, from its quoting and continuation style. */
export function curlDialect(text: string): Dialect {
  return /\^"|\s\^\r?\n/.test(text) ? 'cmd' : 'bash';
}

export function parseCurl(text: string, dialect: Dialect = curlDialect(text)): SnippetResult {
  let cmds: Word[][];
  try { cmds = dialect === 'cmd' ? cmdWords(text) : bashWords(text); } catch (e) {
    if (e instanceof Refused) return { ok: false, errors: [{ path: at(text, e.pos), message: `${e.message}. Nothing was run.` }] };
    throw e;
  }
  if (cmds.length > SNIPPET_MAX_COMMANDS) return { ok: false, errors: [{ path: '', message: `${cmds.length} commands; at most ${SNIPPET_MAX_COMMANDS} can be reviewed` }] };
  const drafts: Draft[] = [];
  const skipped: string[] = [];
  cmds.forEach((words, i) => {
    if (words[0]!.text !== 'curl' && words[0]!.text !== 'curl.exe') { skipped.push(`Command ${i + 1} (${at(text, words[0]!.pos)}): "${words[0]!.text.slice(0, 40)}" is not curl and was not run`); return; }
    const d = curlDraft(words, text, i + 1, dialect);
    if (typeof d === 'string') skipped.push(`Command ${i + 1}: ${d}; not imported`); else drafts.push(d);
  });
  if (!drafts.length) return { ok: false, errors: skipped.length ? skipped.map((m) => ({ path: '', message: m })) : [{ path: '', message: 'No curl command found' }] };
  return { ok: true, value: { label: `cURL (${dialect === 'cmd' ? 'Windows cmd' : 'bash'})`, drafts, skipped, notes: ['Commands were parsed, not run. Files named with @ are never read.'] } };
}

// ---------- copied fetch: fetch("url", { literal options }) [;] — repeated for "Copy all as fetch"

type Lit = string | number | boolean | null | Lit[] | { [k: string]: Lit };

class LitParser {
  i = 0;
  constructor(readonly s: string) {}
  ws() { for (;;) { const m = /^(\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(this.s.slice(this.i)); if (!m) return; this.i += m[0].length; } }
  peek() { this.ws(); return this.s[this.i] ?? ''; }
  eat(ch: string) { if (this.peek() !== ch) throw new Refused(`Expected "${ch}"`, this.i); this.i++; }
  word(): string { this.ws(); const m = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i)); if (!m) return ''; this.i += m[0].length; return m[0]; }
  value(depth = 0): Lit {
    if (depth > 32) throw new Refused('Nested too deeply', this.i);
    const c = this.peek();
    if (c === '"' || c === "'") return this.string();
    if (c === '{') {
      this.i++;
      const o: Record<string, Lit> = {};
      while (this.peek() !== '}') {
        const kpos = this.i;
        const q = this.peek();
        const k = q === '"' || q === "'" ? this.string() : this.word();
        if (!k) throw new Refused(this.peek() === '[' ? 'Computed keys are code, not literals' : this.peek() === '.' ? 'Spread is code, not a literal' : `Unexpected "${this.peek()}"`, this.i);
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') throw new Refused(`Key ${k} is not allowed`, kpos);
        if (this.peek() !== ':') throw new Refused(`${k} without a value is a variable reference, not a literal`, kpos);
        this.i++;
        o[k] = this.value(depth + 1);
        if (this.peek() === ',') this.i++; else if (this.peek() !== '}') throw new Refused('Expected "," or "}"', this.i);
      }
      this.i++;
      return o;
    }
    if (c === '[') {
      this.i++;
      const a: Lit[] = [];
      while (this.peek() !== ']') {
        a.push(this.value(depth + 1));
        if (this.peek() === ',') this.i++; else if (this.peek() !== ']') throw new Refused('Expected "," or "]"', this.i);
      }
      this.i++;
      return a;
    }
    if (c === '`') throw new Refused('Template literals can interpolate code; use a plain string', this.i);
    if (c === '(') throw new Refused('A parenthesized expression is code; only literal values are accepted', this.i);
    const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.s.slice(this.i));
    if (num) { this.i += num[0].length; return Number(num[0]); }
    const pos = this.i;
    const w = this.word();
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    if (w === 'undefined') return null;
    if (w) throw new Refused(w === 'new' ? 'new … constructs an object in code; only literal values are accepted' : this.peek() === '(' || this.peek() === '.' ? `${w}… is code (a call or property access); only literal values are accepted` : `${w} is a variable; only literal values are accepted`, pos);
    throw new Refused(`Unexpected "${c || 'end of input'}"`, this.i);
  }
  /** A JavaScript string literal's value. Escapes become data; nothing is evaluated. */
  string(): string {
    const q = this.s[this.i]!;
    const start = this.i;
    let j = this.i + 1;
    let out = '';
    const ESC: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
    for (;;) {
      if (j >= this.s.length) throw new Refused('Unclosed string', start);
      const c = this.s[j]!;
      if (c === q) break;
      if (c === '\n') throw new Refused('Line break inside a string', j);
      if (c !== '\\') { out += c; j++; continue; }
      const e = this.s[j + 1] ?? '';
      const hex = (re: RegExp) => re.exec(this.s.slice(j + 2))?.[0];
      if (e === 'x') { const h = hex(/^[0-9a-fA-F]{2}/); if (!h) throw new Refused('Invalid \\x escape', j); out += String.fromCharCode(parseInt(h, 16)); j += 4; }
      else if (e === 'u' && this.s[j + 2] === '{') { const h = hex(/^\{[0-9a-fA-F]{1,6}\}/); const cp = h ? parseInt(h.slice(1, -1), 16) : NaN; if (!(cp <= 0x10ffff)) throw new Refused('Invalid \\u{} escape', j); out += String.fromCodePoint(cp); j += 2 + h!.length; }
      else if (e === 'u') { const h = hex(/^[0-9a-fA-F]{4}/); if (!h) throw new Refused('Invalid \\u escape', j); out += String.fromCharCode(parseInt(h, 16)); j += 6; }
      else if (e === '\r' || e === '\n') { j += this.s[j + 1] === '\r' && this.s[j + 2] === '\n' ? 3 : 2; }
      else if (e in ESC && !(e === '0' && /[0-9]/.test(this.s[j + 2] ?? ''))) { out += ESC[e]; j += 2; }
      else if (/[0-9]/.test(e)) throw new Refused('Octal escapes are not supported', j);
      else { out += e; j += 2; }
    }
    this.i = j + 1;
    return out;
  }
}

const FETCH_NOTES: Record<string, string> = {
  referrer: 'referrer is set by the browser and is not preserved', referrerPolicy: 'referrerPolicy is not represented and is not preserved',
  mode: '', cache: 'cache is not represented (sends use no-store)', redirect: 'redirect is not represented; redirects are followed',
  integrity: 'integrity is not represented and is not preserved', keepalive: 'keepalive is not represented', priority: 'priority is not represented',
  signal: '', window: '', duplex: '',
};

export function parseFetch(text: string): SnippetResult {
  const p = new LitParser(text);
  const drafts: Draft[] = [];
  const skipped: string[] = [];
  try {
    for (let index = 1; p.peek(); index++) {
      while (p.peek() === ';') p.i++; // "Copy all as fetch" joins calls with " ;"
      if (!p.peek()) break;
      if (index > SNIPPET_MAX_COMMANDS) throw new Refused(`More than ${SNIPPET_MAX_COMMANDS} calls`, p.i);
      const start = p.i;
      let w = p.word();
      if (w === 'await') w = p.word();
      if (w !== 'fetch') throw new Refused(w ? `${w} is not fetch; only literal fetch("…", {…}) calls are accepted` : `Unexpected "${p.peek()}"; only literal fetch("…", {…}) calls are accepted`, start);
      p.eat('(');
      const q = p.peek();
      if (q !== '"' && q !== "'") throw new Refused(q === '`' ? 'Template literals can interpolate code; use a plain string URL' : 'The URL must be a string literal', p.i);
      const url = p.string();
      let opts: Lit = {};
      if (p.peek() === ',') { p.i++; if (p.peek() !== ')') opts = p.value(); if (p.peek() === ',') p.i++; }
      p.eat(')');
      if (p.peek() === '.') throw new Refused('.then()/.catch() are code; paste the fetch call only', p.i);
      if (p.peek() === ';') p.i++;
      const d = fetchDraft(url, opts, index, at(text, start));
      if (typeof d === 'string') skipped.push(`Call ${index}: ${d}; not imported`); else drafts.push(d);
    }
  } catch (e) {
    if (e instanceof Refused) return { ok: false, errors: [{ path: at(text, e.pos), message: `${e.message}. Nothing was run.` }] };
    throw e;
  }
  if (!drafts.length) return { ok: false, errors: skipped.length ? skipped.map((m) => ({ path: '', message: m })) : [{ path: '', message: 'No fetch call found' }] };
  return { ok: true, value: { label: 'Copied fetch', drafts, skipped, notes: ['Literal values only; the snippet was parsed, not run.'] } };
}

function fetchDraft(rawUrl: string, opts: Lit, index: number, where: string): Draft | string {
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) return 'options must be an object literal';
  const r = red();
  const notes: string[] = [];
  const requires: string[] = [];
  let u: URL;
  try { u = new URL(rawUrl); } catch { return `URL ${rawUrl} is not absolute`; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${u.protocol} is not an HTTP URL`;
  const method = typeof opts.method === 'string' ? opts.method.toUpperCase() : 'GET';
  const headers: Pair[] = [];
  let credentials: Credentials = 'same-origin';
  const h = opts.headers;
  const rows: [string, Lit][] = Array.isArray(h) ? h.filter((x): x is Lit[] => Array.isArray(x) && x.length === 2).map((x) => [String(x[0]), x[1]!]) : h && typeof h === 'object' ? Object.entries(h) : [];
  for (const [k, v] of rows) {
    if (typeof v !== 'string') { notes.push(`Header ${k} is not a string and was skipped`); continue; }
    if (k.toLowerCase() === 'cookie') { credentials = 'include'; notes.push('Cookie header (Node.js copy): values are not imported; this browser sends its own cookies (credentials: include)'); continue; }
    if (/^referr?er(-policy)?$/i.test(k)) { notes.push(`${k} is set by the browser and is not preserved`); continue; }
    headers.push([k, v]);
  }
  if (opts.credentials !== undefined) {
    if (opts.credentials === 'include' || opts.credentials === 'omit' || opts.credentials === 'same-origin') credentials = opts.credentials;
    else notes.push(`credentials ${String(opts.credentials)} is not valid; same-origin is used`);
  }
  if (opts.mode === 'no-cors') notes.push('mode "no-cors" is not represented; the request is sent as cors and the response is readable only if the server allows it');
  for (const k of Object.keys(opts)) {
    if (['method', 'headers', 'body', 'credentials', 'mode'].includes(k)) continue;
    if (k in FETCH_NOTES) { if (FETCH_NOTES[k]) notes.push(FETCH_NOTES[k]!); }
    else notes.push(`Option ${k} is not represented and is not preserved`);
  }
  let bodies: Draft['bodies'] = [];
  const b = opts.body;
  if (typeof b === 'string' && b !== '') {
    const ct = headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? 'text/plain;charset=UTF-8';
    if (utf8Bytes(b) > BOUNDS.bodyBytes) {
      bodies = [{ label: 'body', contentType: ct, body: { kind: 'text', text: missing('request body') } }];
      requires.push(`Body over ${BOUNDS.bodyBytes / 1024 / 1024} MiB was not imported`);
    } else bodies = [{ label: 'body', contentType: ct, body: textBody(b, ct, r) }];
    if (bodies[0]!.body.kind === 'text' && /^multipart\//i.test(ct)) multipartNote(b, notes, requires);
  } else if (b !== undefined && b !== null && b !== '') return 'body must be a string literal or null';
  return {
    name: u.pathname, method, url: u.origin + u.pathname, query: cleanPairs(u.searchParams, r, 'Query'), headers: draftHeaders(headers, r), credentials,
    bodies, source: `fetch call ${index} (${where})`, notes: collapse([...notes, ...r.notes]), requires: [...requires, ...redactedRequires(r)],
  };
}
