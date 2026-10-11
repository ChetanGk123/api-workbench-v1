// Test → Auth & context: named bindings, explicit bounded page scan, auth-context definitions with
// explicit refresh, finite HMAC signing recipes and session-only keys. Definitions are a draft saved
// with the profile; current values, refreshed tokens and keys are never stored.
import { BOUNDS, newId, validateAggregate, type Aggregate, type AuthContext, type Binding, type SigningComponent, type SigningRecipe, type SourceRef } from '../data/schema';
import type { AuthCoordinator } from '../tester/auth';
import { describeSource, readSource } from '../tester/expr';
import { mask, pageSources } from '../tester/once';
import { scanPage, type Candidate, type Category } from '../tester/scan';
import { importKey, signature } from '../tester/sign';
import { h, icon } from './dom';
import { btn, checkbox, Errors, field, heading, input, section, select, textarea, type Built, type Form, type Kit, type Ret } from './kit';

const KINDS: [SourceRef['kind'], string][] = [['cookie', 'Cookie (JS-readable)'], ['localStorage', 'localStorage'], ['sessionStorage', 'sessionStorage'], ['meta', 'Meta tag'], ['dom', 'DOM element']];
const CATS: [Category, string][] = [['cookie', 'Readable cookies'], ['localStorage', 'localStorage'], ['sessionStorage', 'sessionStorage'], ['meta', 'Meta tags'], ['dom', 'Form fields'], ['global', 'Global roots']];

export function createContextUi(kit: Kit, auth: AuthCoordinator) {
  const s = kit.session;
  // Transient scan state: previews only, never persisted; a new scan invalidates the old one.
  let scan: { candidates: Candidate[]; errors: string[]; truncated: string[] } | null = null;
  let scanNo = 0;
  const cats = new Set<Category>(['cookie', 'meta']);
  let roots = '';

  function open(ret: Ret) {
    const agg = s.agg();
    const draft = { authContexts: structuredClone(agg.authContexts), signingRecipes: structuredClone(agg.signingRecipes), bindings: structuredClone(agg.bindings) };
    const components = new Map(draft.signingRecipes.map((r) => [r.id, r.components.join(', ')]));
    const base = JSON.stringify(draft);
    const errs = new Errors();
    const apply = () => { for (const r of draft.signingRecipes) r.components = (components.get(r.id) ?? '').split(',').map((x) => x.trim()).filter(Boolean) as SigningComponent[]; };
    const form: Form = {
      owner: 'test',
      ret,
      dirty: () => { apply(); return JSON.stringify(draft) !== base; },
      async save() {
        apply();
        const v = validateAggregate({ ...s.agg(), ...draft });
        if (!v.ok) { errs.show(v.errors.filter((d) => /^(authContexts|signingRecipes|bindings)\./.test(d.path) || !d.path.startsWith('endpoints')), kit.announce); return false; }
        const out = await s.edit((a) => { a.authContexts = structuredClone(draft.authContexts); a.signingRecipes = structuredClone(draft.signingRecipes); a.bindings = structuredClone(draft.bindings); });
        if (out) { errs.show(out, kit.announce); return false; }
        kit.announce('Auth & context definitions saved. Values and keys stay in this session only.');
        return true;
      },
      build: () => screen(),
    };

    function screen(): Built {
      errs.clear();
      const agg = s.agg();
      const live: (() => void)[] = [];
      const hostKeys = [...new Set(Object.values(agg.profile.environments).flatMap((e) => Object.keys(e)))];
      const src = () => pageSources();
      const avail = (ref: SourceRef, ctx?: AuthContext) => {
        const v = readSource(ctx ? auth.sources(ctx, src()) : src(), ref);
        return v === undefined ? h('span', { class: 'aw-bd aw-am' }, 'missing') : h('span', { class: 'aw-bd aw-gr', title: 'Masked; the value is read again at dispatch' }, `available ${mask(v)}`);
      };
      const sourceFields = (ref: SourceRef, what: string, onChange: () => void) => {
        const mode = input(ref.mode ?? 'value', (v) => { ref.mode = v as NonNullable<SourceRef['mode']>; onChange(); }, { label: `${what} read mode`, placeholder: 'value | text | attr:name', mono: true });
        mode.hidden = ref.kind !== 'dom';
        const kind = select(ref.kind, KINDS, (v) => { ref.kind = v; if (v === 'dom') ref.mode ??= 'value'; else delete ref.mode; mode.hidden = v !== 'dom'; onChange(); }, { label: `${what} source` });
        kind.classList.add('aw-sm');
        return [kind, input(ref.key, (v) => { ref.key = v; onChange(); }, { label: `${what} key`, mono: true, placeholder: ref.kind === 'dom' ? '#selector' : 'name' }), mode];
      };

      // ---- bindings
      const bindEl = h('div', { class: 'aw-col aw-gap6' });
      const drawBindings = () => bindEl.replaceChildren(...draft.bindings.map((b, i) => {
        const st = h('span', {});
        const refresh = () => st.replaceChildren(avail(b.source));
        refresh();
        live.push(refresh);
        return h('div', { class: 'aw-col aw-gap4 aw-cardin' },
          h('div', { class: 'aw-row aw-gap6 aw-srcrow' }, input(b.name, (v) => { b.name = v.trim(); }, { label: `Binding ${i + 1} name`, mono: true, placeholder: 'name' }), st,
            btn([icon('x')], () => { draft.bindings.splice(i, 1); drawBindings(); }, 'aw-btn aw-gh aw-ic aw-sm', { 'aria-label': `Remove binding ${i + 1}` })),
          h('div', { class: 'aw-row aw-gap6 aw-srcrow' }, ...sourceFields(b.source, `Binding ${i + 1}`, refresh)),
          h('span', { class: 'aw-xs aw-mu aw-mono' }, `{{$context("${b.name}")}}`));
      }), btn([icon('plus', 'aw-i aw-i12'), 'Add binding'], () => { draft.bindings.push({ name: uniqueName(draft.bindings, 'binding'), source: { kind: 'cookie', key: '' } }); drawBindings(); }, 'aw-btn aw-dash aw-sm'));
      drawBindings();

      // ---- scan
      const scanEl = h('div', { class: 'aw-col aw-gap6', 'aria-live': 'polite' });
      const drawScan = () => scanEl.replaceChildren(...(!scan ? [h('p', { class: 'aw-hint aw-wrap' }, 'Nothing is read until you press Scan. Results are masked previews and are not saved.')] : [
        h('div', { class: 'aw-xs aw-mu', id: 'aw-scan-count' }, `${scan.candidates.length} candidate(s)${scan.truncated.length ? ` · limit reached: ${scan.truncated.join(', ')}` : ''}`),
        ...scan.errors.map((e) => h('div', { class: 'aw-hint aw-wrap' }, e)),
        h('ul', { class: 'aw-ops' }, ...scan.candidates.map((c) => h('li', { class: 'aw-row aw-xs' }, h('span', { class: 'aw-bd' }, c.category), h('span', { class: 'aw-mono aw-grow aw-wrap' }, c.label), h('span', { class: 'aw-mu' }, c.preview),
          c.source ? btn('Use as binding', () => {
            draft.bindings.push({ name: uniqueName(draft.bindings, c.source!.key.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(?=\d)/, '_').slice(0, 40) || 'binding'), source: structuredClone(c.source!) });
            drawBindings();
            kit.announce(`Binding added for ${describeSource(c.source!)}. Save to keep it; its value is read again at dispatch.`);
          }, 'aw-btn aw-gh aw-sm', { 'aria-label': `Use ${c.label} as binding` }) : h('span', { class: 'aw-hint' }, 'discovery only')))),
      ]));
      drawScan();
      const rootsIn = input(roots, (v) => { roots = v; }, { label: 'Global roots', placeholder: 'e.g. appConfig, __STATE__', mono: true });
      const scanCtl = h('div', { class: 'aw-col aw-gap6' },
        h('div', { class: 'aw-row aw-gap8 aw-wrapbtns' }, ...CATS.map(([c, label]) => h('span', { class: 'aw-chk aw-xs' }, checkbox(label, cats.has(c), (v) => { if (v) cats.add(c); else cats.delete(c); scan = null; drawScan(); }), label))),
        rootsIn,
        h('div', { class: 'aw-row aw-gap6' },
          btn('Scan page', () => {
            const n = ++scanNo;
            const r = scanPage(cats, roots.split(',').map((x) => x.trim()).filter(Boolean));
            if (n !== scanNo) return; // a newer scan or a Clear won
            scan = r;
            drawScan();
            kit.announce(`Scan found ${r.candidates.length} candidate(s).`);
          }, 'aw-btn aw-out aw-sm', { id: 'aw-scan' }),
          btn('Clear scan', () => { scanNo++; scan = null; drawScan(); kit.announce('Scan previews cleared; bindings unchanged.'); }, 'aw-btn aw-gh aw-sm')),
        h('p', { class: 'aw-hint aw-wrap' }, 'Reads own data properties only: getters are never invoked and functions are skipped. At most 40 per category, 200 in total, global depth 3. HttpOnly cookies are not readable by scripts and never appear.'));

      // ---- auth contexts
      const ctxEl = h('div', { class: 'aw-col aw-gap8' });
      const drawCtx = () => ctxEl.replaceChildren(...draft.authContexts.map((c, i) => ctxCard(c, i)), btn([icon('plus', 'aw-i aw-i12'), 'Add auth context'], () => {
        draft.authContexts.push({ id: newId('auth'), label: `Context ${draft.authContexts.length + 1}`, identity: '', audience: hostKeys[0] ?? '', credentials: 'same-origin', headers: [] });
        drawCtx();
      }, 'aw-btn aw-dash aw-sm'));
      function ctxCard(c: AuthContext, i: number): HTMLElement {
        const p = `authContexts.${i}`;
        const st = h('div', { class: 'aw-xs aw-wrap', 'aria-live': 'polite' });
        const showState = () => {
          const x = auth.status(c);
          const saved = s.agg().authContexts.find((a) => a.id === c.id);
          st.replaceChildren(h('span', { class: `aw-bd ${x.refreshing ? 'aw-bl' : x.lastError ? 'aw-rd' : ''}` }, x.refreshing ? 'Refreshing' : x.lastError ? 'Refresh failed' : x.installed ? 'Refreshed values in use' : 'Page values'),
            ` ${x.lastError ?? ''}${x.refreshes ? ` · ${x.refreshes} refresh(es) this session` : ''}${saved ? '' : ' · save before testing refresh'}`);
        };
        showState();
        live.push(showState);
        const headersEl = h('div', { class: 'aw-col aw-gap4' });
        const drawHeaders = () => headersEl.replaceChildren(...c.headers.map((ah, j) => {
          const av = h('span', {});
          const r = () => av.replaceChildren(avail(ah.source, c));
          r(); live.push(r);
          return h('div', { class: 'aw-col aw-gap4' },
            h('div', { class: 'aw-row aw-gap6' }, input(ah.name, (v) => { ah.name = v.trim(); }, { label: `Context ${i + 1} header ${j + 1} name`, mono: true, placeholder: 'Authorization' }),
              input(ah.prefix, (v) => { ah.prefix = v; }, { label: `Context ${i + 1} header ${j + 1} prefix`, mono: true, placeholder: 'Bearer ' }),
              btn([icon('x')], () => { c.headers.splice(j, 1); drawHeaders(); }, 'aw-btn aw-gh aw-ic aw-sm', { 'aria-label': `Remove context ${i + 1} header ${j + 1}` })),
            h('div', { class: 'aw-row aw-gap6 aw-srcrow' }, ...sourceFields(ah.source, `Context ${i + 1} header ${j + 1}`, r)), av);
        }), btn([icon('plus', 'aw-i aw-i12'), 'Add header'], () => { c.headers.push({ name: 'Authorization', prefix: 'Bearer ', source: { kind: 'localStorage', key: '' } }); drawHeaders(); }, 'aw-btn aw-dash aw-sm', { 'aria-label': `Add header to context ${i + 1}` }));
        drawHeaders();
        const expiryEl = h('div', { class: 'aw-col aw-gap4' });
        const drawExpiry = () => expiryEl.replaceChildren(h('span', { class: 'aw-chk aw-xs' }, checkbox(`Context ${i + 1} expiry`, !!c.expiry, (v) => { if (v) c.expiry = { source: { kind: 'localStorage', key: '' }, format: 'epoch-ms' }; else delete c.expiry; drawExpiry(); }), 'Expiry source (checked before each dispatch)'),
          ...(c.expiry ? [h('div', { class: 'aw-row aw-gap6 aw-srcrow' }, ...sourceFields(c.expiry.source, `Context ${i + 1} expiry`, () => {}),
            (() => { const f = select(c.expiry!.format, [['epoch-ms', 'epoch ms'], ['epoch-s', 'epoch s'], ['iso', 'ISO date']], (v) => { c.expiry!.format = v; }, { label: `Context ${i + 1} expiry format` }); f.classList.add('aw-sm'); return f; })())] : []));
        drawExpiry();
        const refreshEl = h('div', { class: 'aw-col aw-gap4' });
        const drawRefresh = () => {
          const r = c.refresh;
          const outs = h('div', { class: 'aw-col aw-gap4' });
          const drawOuts = () => outs.replaceChildren(...(r?.outputs ?? []).map((o, j) => h('div', { class: 'aw-row aw-gap6 aw-srcrow' },
            input(o.path, (v) => { o.path = v.trim(); }, { label: `Context ${i + 1} refresh output ${j + 1} path`, mono: true, placeholder: 'access_token' }), h('span', { class: 'aw-xs aw-mu' }, '→'),
            ...sourceFields(o.target, `Context ${i + 1} refresh output ${j + 1} target`, () => {}),
            btn([icon('x')], () => { r!.outputs.splice(j, 1); drawOuts(); }, 'aw-btn aw-gh aw-ic aw-sm', { 'aria-label': `Remove refresh output ${j + 1}` }))),
          ...(r ? [btn([icon('plus', 'aw-i aw-i12'), 'Add output mapping'], () => { r.outputs.push({ path: '', target: { kind: 'localStorage', key: '' } }); drawOuts(); }, 'aw-btn aw-dash aw-sm')] : []));
          drawOuts();
          refreshEl.replaceChildren(h('span', { class: 'aw-chk aw-xs' }, checkbox(`Context ${i + 1} refresh`, !!r, (v) => {
            if (v) c.refresh = { endpointId: s.agg().endpoints[0]?.id ?? '', outputs: [], deadlineMs: BOUNDS.refreshDeadlineMs, readOnlyRetry: false }; else delete c.refresh;
            drawRefresh();
          }), 'Explicit refresh: one shared refresh at a time for this context; outputs replace source values for Workbench only'),
          ...(r ? [
            field('Refresh endpoint', select<string>(r.endpointId, s.agg().endpoints.map((e): [string, string] => [e.id, `${e.request.method} ${e.name} (${e.alias})`]), (v) => { r.endpointId = v; }), errs, `${p}.refresh.endpointId`),
            h('span', { class: 'aw-xs' }, 'Response fields → where Workbench keeps them (in memory; page storage is not changed)'), outs,
            h('div', { class: 'aw-row aw-gap8' },
              (() => { const d = input(String(r.deadlineMs), (v) => { const n = Number(v); if (Number.isSafeInteger(n)) r.deadlineMs = n; }, { type: 'number', label: `Context ${i + 1} refresh deadline ms` }); return h('label', { class: 'aw-col aw-xs' }, `Deadline ms (100–${BOUNDS.refreshDeadlineMs})`, d); })(),
              h('span', { class: 'aw-chk aw-xs' }, checkbox(`Context ${i + 1} read-only retry`, r.readOnlyRetry, (v) => { r.readOnlyRetry = v; }), 'After a 401, refresh and retry once — GET/HEAD only; writes are never retried')),
            btn('Refresh now', async () => {
              const saved = s.agg().authContexts.find((a) => a.id === c.id);
              if (!saved?.refresh) { kit.announce('Save this context with its refresh first.'); return; }
              kit.announce(`Refreshing ${saved.label}…`);
              const err = await auth.refresh(saved, new AbortController().signal).catch(() => 'stopped');
              kit.announce(err ? `Refresh failed: ${err}` : `Refreshed ${saved.label}; new values are used at the next dispatch.`);
              live.forEach((f) => f());
            }, 'aw-btn aw-out aw-sm', { 'aria-label': `Refresh ${c.label} now (sends the refresh endpoint once)` }),
          ] : []));
        };
        drawRefresh();
        const audOpts: [string, string][] = [...hostKeys.map((k): [string, string] => [k, `Host ${k}`]), ...(hostKeys.includes(c.audience) ? [] : [[c.audience, c.audience || '(origin…)'] as [string, string]])];
        return h('div', { class: 'aw-col aw-gap8 aw-cardin', 'aria-label': `Auth context ${c.label}` },
          h('div', { class: 'aw-row aw-gap6' }, h('strong', { class: 'aw-grow' }, `Auth context ${i + 1}`), btn([icon('trash', 'aw-i aw-i12')], () => { draft.authContexts.splice(i, 1); drawCtx(); }, 'aw-btn aw-gh aw-ic aw-sm', { 'aria-label': `Delete auth context ${c.label}` })),
          h('div', { class: 'aw-g2' }, field('Label', input(c.label, (v) => { c.label = v; }), errs, `${p}.label`), field('Identity label', input(c.identity, (v) => { c.identity = v; }, { placeholder: 'test customer A' }), errs, `${p}.identity`)),
          h('div', { class: 'aw-g2' },
            field('Audience (host key or origin)', input(c.audience, (v) => { c.audience = v.trim(); }, { mono: true, placeholder: hostKeys[0] ?? 'https://api.example.com' }), errs, `${p}.audience`, `Known hosts: ${audOpts.map((x) => x[0]).filter(Boolean).join(', ') || 'none'}. Requests to any other origin are blocked.`),
            field('Credentials', select(c.credentials, [['same-origin', 'Same origin'], ['include', 'Include'], ['omit', 'Omit']], (v) => { c.credentials = v; }), errs, `${p}.credentials`)),
          h('span', { class: 'aw-lbl' }, 'Headers set from sources at dispatch'), headersEl, expiryEl, refreshEl, st,
          h('p', { class: 'aw-hint aw-wrap' }, 'Cookie sessions follow this browser tab: a context with different variables is not a different cookie user. Distinct bearer-only contexts can coexist.'));
      }
      drawCtx();

      // ---- signing recipes and session keys
      const signEl = h('div', { class: 'aw-col aw-gap8' });
      const drawSign = () => signEl.replaceChildren(...draft.signingRecipes.map((r, i) => recipeCard(r, i)), btn([icon('plus', 'aw-i aw-i12'), 'Add signing recipe'], () => {
        const r: SigningRecipe = { id: newId('sign'), label: `HMAC recipe ${draft.signingRecipes.length + 1}`, algorithm: 'HMAC-SHA-256', components: ['method', 'path', 'query', 'body-sha256', 'timestamp', 'nonce'], separator: '\n', encoding: 'hex', keyRef: 'signing_key', outputHeader: 'X-Signature', timestampHeader: 'X-Timestamp', nonceHeader: 'X-Nonce', freshnessMs: 30_000 };
        draft.signingRecipes.push(r);
        components.set(r.id, r.components.join(', '));
        drawSign();
      }, 'aw-btn aw-dash aw-sm'));
      function recipeCard(r: SigningRecipe, i: number): HTMLElement {
        const p = `signingRecipes.${i}`;
        const keyState = h('span', { class: 'aw-xs', 'aria-live': 'polite' });
        const showKey = () => keyState.replaceChildren(auth.keys.has(r.keyRef) ? h('span', { class: 'aw-bd aw-gr' }, `key "${r.keyRef}" loaded for this session`) : h('span', { class: 'aw-bd aw-am' }, `key "${r.keyRef}" not loaded: signed requests are blocked`));
        showKey();
        live.push(showKey);
        const secret = input('', () => {}, { type: 'password', label: `Key text for ${r.keyRef}`, placeholder: 'test key (kept in memory only)' });
        secret.autocomplete = 'off';
        const vecIn = textarea('', () => {}, { label: `Test message for ${r.label}`, rows: 2 });
        const vecOut = h('div', { class: 'aw-xs aw-mono aw-wrap', 'aria-live': 'polite' });
        const sep = select(r.separator === '\n' ? 'nl' : r.separator === '' ? 'none' : r.separator, [['nl', 'Newline'], ['|', '|'], ['.', '.'], [':', ':'], ['none', 'Nothing']], (v) => { r.separator = v === 'nl' ? '\n' : v === 'none' ? '' : v; }, { label: `${r.label} separator` });
        return h('div', { class: 'aw-col aw-gap8 aw-cardin', 'aria-label': `Signing recipe ${r.label}` },
          h('div', { class: 'aw-row aw-gap6' }, h('strong', { class: 'aw-grow' }, `Signing recipe ${i + 1} · HMAC-SHA-256`), btn([icon('trash', 'aw-i aw-i12')], () => { draft.signingRecipes.splice(i, 1); drawSign(); }, 'aw-btn aw-gh aw-ic aw-sm', { 'aria-label': `Delete signing recipe ${r.label}` })),
          h('div', { class: 'aw-g2' }, field('Label', input(r.label, (v) => { r.label = v; }), errs, `${p}.label`), field('Key reference (a name, never key material)', input(r.keyRef, (v) => { r.keyRef = v.trim(); showKey(); }, { mono: true }), errs, `${p}.keyRef`)),
          field('Components, in order', input(components.get(r.id) ?? '', (v) => { components.set(r.id, v); }, { mono: true }), errs, `${p}.components`, 'method, path, query, body-sha256, timestamp, nonce, header:<name>. Joined by the separator; the body digest is over the exact bytes sent.'),
          h('div', { class: 'aw-g3' }, field('Separator', sep), field('Encoding', select(r.encoding, [['hex', 'hex'], ['base64', 'base64']], (v) => { r.encoding = v; })), field('Freshness ms', input(String(r.freshnessMs), (v) => { const n = Number(v); if (Number.isSafeInteger(n)) r.freshnessMs = n; }, { type: 'number' }), errs, `${p}.freshnessMs`)),
          h('div', { class: 'aw-g3' }, field('Signature header', input(r.outputHeader, (v) => { r.outputHeader = v.trim(); }, { mono: true }), errs, `${p}.outputHeader`),
            field('Timestamp header', input(r.timestampHeader ?? '', (v) => { if (v.trim()) r.timestampHeader = v.trim(); else delete r.timestampHeader; }, { mono: true })),
            field('Nonce header', input(r.nonceHeader ?? '', (v) => { if (v.trim()) r.nonceHeader = v.trim(); else delete r.nonceHeader; }, { mono: true }))),
          h('div', { class: 'aw-row aw-gap6 aw-wrapbtns' }, secret,
            btn('Use key for this session', async () => {
              if (!secret.value) { kit.announce('Enter the key text first.'); return; }
              try { auth.keys.set(r.keyRef, await importKey(secret.value)); secret.value = ''; kit.announce(`Key "${r.keyRef}" loaded as a non-extractable key for this session. It is never saved or exported.`); }
              catch (e) { kit.announce(`Key not loaded: ${(e as Error).message}`); }
              live.forEach((f) => f());
            }, 'aw-btn aw-out aw-sm', { 'aria-label': `Use key ${r.keyRef} for this session` }),
            btn('Forget key', () => { auth.keys.delete(r.keyRef); kit.announce(`Key "${r.keyRef}" removed.`); live.forEach((f) => f()); }, 'aw-btn aw-gh aw-sm')),
          keyState,
          h('details', {}, h('summary', { class: 'aw-xs' }, 'Test vector'), vecIn,
            btn('Compute signature', async () => {
              const key = auth.keys.get(r.keyRef);
              if (!key) { vecOut.textContent = 'Load the key first.'; return; }
              apply();
              const msg = vecIn.value.replace(/\\n/g, '\n');
              vecOut.textContent = `${r.encoding}: ${await signature(r, key, msg)}`;
            }, 'aw-btn aw-out aw-sm'), vecOut,
            h('p', { class: 'aw-hint aw-wrap' }, 'Enter the canonical message exactly (type \\n for a newline separator) and compare the result with the server’s known vector.')),
          h('p', { class: 'aw-hint aw-wrap' }, 'A fresh timestamp and nonce are reserved and the request is signed immediately before each transmitted attempt; a preview is never reused as a signature. Recorded page signatures are not keys.'));
      }
      drawSign();

      kit.foot.replaceChildren(
        btn([icon('save', 'aw-i aw-i14'), 'Save'], async () => { if (await form.save()) open(ret); }, 'aw-btn aw-pri aw-grow', { id: 'aw-ctx-save' }),
        btn('Close', () => kit.leaveForm(), 'aw-btn aw-out aw-grow'));
      kit.foot.hidden = false;
      return {
        nodes: [
          h('div', { class: 'aw-row' }, kit.backButton(ret.screen, () => kit.leaveForm()), heading('Auth & context')),
          errs.summary,
          section('Bindings', h('p', { class: 'aw-hint aw-wrap' }, 'A binding names one page source. Only the reference is saved; the value is read again for each request.'), bindEl),
          section('Scan page', scanCtl, scanEl),
          section('Auth contexts', h('p', { class: 'aw-hint aw-wrap' }, 'Assign a context to an endpoint in its editor. Its headers are added at dispatch, only for its audience.'), ctxEl),
          section('Signing recipes and session keys', signEl),
        ],
        refresh: () => live.forEach((f) => f()),
      };
    }
    kit.openForm(form);
  }

  return { open, clear() { scan = null; scanNo++; } };
}

function uniqueName(list: Binding[], want: string): string {
  let name = want, n = 2;
  while (list.some((b) => b.name === name)) name = `${want}_${n++}`;
  return name;
}

/** Insert-expression picker for an editor: built-ins, bindings and producer sample fields. */
export function exprPicker(agg: Aggregate, selfId: string, target: () => HTMLInputElement | HTMLTextAreaElement | null, announce: (t: string) => void): HTMLElement {
  const groups: [string, [string, string][]][] = [
    ['Generated (reserved once per request)', [['{{$uuid}}', '$uuid'], ['{{$timestamp}}', '$timestamp (epoch ms)'], ['{{$counter("n", 1, 1)}}', '$counter(name, initial, step)'], ['{{$randomInt(1, 100)}}', '$randomInt(min, max)']]],
    ['Page sources (read at dispatch)', [['{{$cookie("XSRF-TOKEN")}}', '$cookie(name)'], ['{{$localStorage("key")}}', '$localStorage(key)'], ['{{$sessionStorage("key")}}', '$sessionStorage(key)'], ['{{$meta("csrf-token")}}', '$meta(name)'], ['{{$dom("#id", "value")}}', '$dom(selector, value|text|attr:name)'], ['{{$eval("a.b * 2 > 10")}}', '$eval(restricted expression)']]],
    ['Bindings', agg.bindings.map((b): [string, string] => [`{{$context("${b.name}")}}`, `${b.name} · ${describeSource(b.source)}`])],
    ['Producer fields (from saved samples; plans only)', agg.endpoints.filter((e) => e.id !== selfId).flatMap((e) => sampleFields(e.sample?.body).map((f): [string, string] => [`{{${e.alias}.${f}}}`, `${e.alias}.${f}${e.sample ? ` (${e.sample.source} sample)` : ''}`]))],
  ];
  const sel = h('select', { class: 'aw-in aw-select aw-sm', 'aria-label': 'Insert expression into the last focused field' },
    h('option', { value: '' }, 'Insert {{…}}'),
    ...groups.filter(([, items]) => items.length).map(([label, items]) => h('optgroup', { label }, ...items.map(([v, t]) => h('option', { value: v }, t)))));
  sel.addEventListener('change', () => {
    const el = target();
    const v = sel.value;
    sel.value = '';
    if (!v) return;
    if (!el) { announce('Click into a URL, query, header or body field first, then insert.'); return; }
    const a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? a;
    el.value = el.value.slice(0, a) + v + el.value.slice(b);
    el.setSelectionRange(a + v.length, a + v.length);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
    announce(`Inserted ${v}.`);
  });
  return sel;
}

/** Top-level and one nested level of JSON field names in a sample (suggestions, not live values). */
function sampleFields(body: string | undefined): string[] {
  if (!body) return [];
  let doc: unknown;
  try { doc = JSON.parse(body); } catch { return []; }
  if (Array.isArray(doc)) doc = doc[0];
  if (!doc || typeof doc !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(doc).slice(0, 30)) {
    if (!/^[A-Za-z_$][\w$]*$/.test(k)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const k2 of Object.keys(v).slice(0, 10)) { if (/^[A-Za-z_$][\w$]*$/.test(k2)) out.push(`${k}.${k2}`); }
    else out.push(k);
  }
  return out.slice(0, 60);
}
