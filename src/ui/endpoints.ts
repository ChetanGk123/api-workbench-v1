// Endpoints collection, endpoint editor, global headers/presets, Promote common and environments.
// Every change goes through the session's validated commands; editors hold detached drafts.
import {
  aliasReferences, BOUNDS, linkedMatcher, METHODS, newEndpoint, renameAliasRefs, sensitiveHeader, validateEndpointIn, validateOrigin,
  type Aggregate, type Body, type BodyKind, type Check, type Diag, type Endpoint, type Header, type Pair, type Part,
} from '../data/schema';
import { describeCheck } from '../tester/once';
import { exprPicker } from './context';
import { h, icon } from './dom';
import {
  btn, checkbox, countBadge, Errors, field, heading, input, methodBadge, pairRows, section, select, textarea, tile,
  type Built, type Form, type Kit, type Ret,
} from './kit';

const PRESETS: { label: string; headers: Pair[]; needs?: string }[] = [
  { label: 'JSON Accept', headers: [['Accept', 'application/json']] },
  { label: 'JSON Content-Type', headers: [['Content-Type', 'application/json']] },
  { label: 'CSRF from cookie XSRF-TOKEN', headers: [['X-XSRF-TOKEN', '{{$cookie("XSRF-TOKEN")}}']], needs: 'a script-readable XSRF-TOKEN cookie on this page' },
  { label: 'CSRF from meta csrf-token', headers: [['X-CSRF-Token', '{{$meta("csrf-token")}}']], needs: 'one <meta name="csrf-token"> on this page' },
  { label: 'Bearer from localStorage token', headers: [['Authorization', 'Bearer {{$localStorage("token")}}']], needs: 'a localStorage "token" value on this page' },
];
const BODY_KINDS: [BodyKind, string][] = [['none', 'None'], ['text', 'Text (exact)'], ['json', 'JSON text (exact)'], ['urlencoded', 'URL-encoded fields'], ['multipart', 'Multipart fields/files']];
const CHECK_KINDS: [Check['kind'], string][] = [['status', 'Status range'], ['header', 'Header'], ['body-contains', 'Body contains'], ['json', 'JSON path'], ['duration', 'Duration']];

/** Where an endpoint goes in the profile's active environment. */
export function destination(agg: Aggregate, r: Endpoint['request'], pageOrigin: string): string {
  if (r.hostKey === null) return `${r.url || '(no URL)'} · absolute`;
  const env = agg.profile.environments[agg.profile.activeEnvironment] ?? {};
  const o = env[r.hostKey];
  return o === undefined ? `host ${r.hostKey} is not mapped in ${agg.profile.activeEnvironment}` : `${o || pageOrigin}${r.url}`;
}

export function createEndpointsUi(kit: Kit) {
  const s = kit.session;
  let filter = '';

  // ---------- list
  function screen(): Built {
    const count = countBadge();
    const ctx = h('div', { class: 'aw-xs aw-mu aw-wrap' });
    const filterIn = input(filter, (v) => { filter = v; draw(); }, { label: 'Filter endpoints', placeholder: 'Filter by name, alias, method, host or path', type: 'search', id: 'aw-ep-filter' });
    const list = h('ol', { class: 'aw-card aw-list aw-eplist', 'aria-label': 'Endpoints' });
    const empty = h('div', { class: 'aw-empty aw-wrap' });
    const add = btn([icon('plus', 'aw-i aw-i14'), 'Add endpoint'], () => kit.editEndpoint(null), 'aw-btn aw-pri aw-sm', { 'data-key': 'ep-add' });
    const headersBtn = btn('', () => openHeaders(kit.here()), 'aw-btn aw-out aw-sm', { 'data-key': 'ep-headers' });
    const promote = btn('Promote common…', () => openPromote(kit.here()), 'aw-btn aw-out aw-sm', { 'data-key': 'ep-promote' });
    const envBtn = btn('Environments…', () => openEnvironments(kit.here()), 'aw-btn aw-out aw-sm', { 'data-key': 'ep-env' });
    const moveHint = h('p', { class: 'aw-hint' });
    let shown = '';

    function draw() {
      const agg = s.agg();
      const q = filter.trim().toLowerCase();
      const terms = q.split(/\s+/).filter(Boolean);
      const rows = agg.endpoints.filter((e) => terms.every((t) => `${e.name} ${e.alias} ${e.request.method} ${e.request.hostKey ?? ''} ${e.request.url}`.toLowerCase().includes(t)));
      count.textContent = String(agg.endpoints.length);
      ctx.textContent = `Profile ${agg.profile.name} · environment ${agg.profile.activeEnvironment}`;
      headersBtn.textContent = `Global headers (${agg.profile.globalHeaders.length})`;
      moveHint.textContent = q ? 'Clear the filter to reorder endpoints.' : '';
      empty.hidden = rows.length > 0;
      empty.textContent = agg.endpoints.length ? `No endpoints match “${filter.trim()}”` : 'No endpoints yet. Add one to send it with Once.';
      list.hidden = !rows.length;
      const sig = JSON.stringify([q, agg.endpoints, agg.profile.environments, agg.profile.activeEnvironment]);
      if (sig === shown) return;
      shown = sig;
      const focused = kit.root.activeElement?.closest?.('[data-key]')?.getAttribute('data-key');
      list.replaceChildren(...rows.map((e) => row(agg, e, !!q)));
      if (focused) list.querySelector<HTMLElement>(`[data-key="${focused}"]`)?.focus();
    }

    return {
      nodes: [
        h('div', { class: 'aw-row aw-gap10' }, tile('book'), h('div', { class: 'aw-grow' }, h('div', { class: 'aw-row aw-gap8' }, heading('Endpoints'), count), ctx), add),
        h('div', { class: 'aw-row aw-wrapbtns' }, headersBtn, promote, envBtn),
        h('label', { class: 'aw-sr', for: 'aw-ep-filter' }, 'Filter endpoints'), filterIn,
        empty, list, moveHint,
      ],
      refresh: draw,
    };
  }

  function row(agg: Aggregate, e: Endpoint, filtered: boolean): HTMLElement {
    const i = agg.endpoints.indexOf(e);
    const needsFiles = e.request.body.kind === 'multipart' && e.request.body.parts.some((p) => p.kind === 'file');
    const exprs = JSON.stringify(e.request).match(/\{\{[^}]*\}\}/g)?.length ?? 0;
    const open = h('button', { class: 'aw-grow aw-col aw-rulebtn', type: 'button', 'data-key': `ep-${e.id}`, 'aria-label': `Edit ${e.name} (${e.alias})` },
      h('span', { class: 'aw-row aw-gap6' }, h('span', { class: 'aw-rname' }, e.name), h('span', { class: 'aw-xs aw-mu aw-mono' }, e.alias)),
      h('span', { class: 'aw-row aw-mono aw-meta', title: destination(agg, e.request, kit.rt.origin) }, methodBadge(e.request.method),
        e.request.hostKey !== null ? h('span', { class: 'aw-mu' }, e.request.hostKey) : null, h('span', { class: 'aw-tr' }, e.request.url)));
    open.addEventListener('click', () => kit.editEndpoint(e.id));
    const tags = h('span', { class: 'aw-row aw-gap4' },
      h('span', { class: 'aw-bd aw-h18', title: e.checks.map(describeCheck).join('\n') }, `${e.checks.length} check${e.checks.length === 1 ? '' : 's'}`),
      e.sample ? h('span', { class: 'aw-bd aw-h18' }, 'sample') : null,
      exprs ? h('span', { class: 'aw-bd aw-am aw-h18', title: 'Values resolved at dispatch' }, `${exprs} input${exprs === 1 ? '' : 's'}`) : null,
      needsFiles ? h('span', { class: 'aw-bd aw-am aw-h18' }, 'file') : null);
    const run = btn([icon('play', 'aw-i aw-i12'), 'Run'], () => kit.runEndpoint(e.id), 'aw-btn aw-gh aw-sm', { 'aria-label': `Run ${e.name} once` });
    const up = btn('↑', () => move(i, -1), 'aw-btn aw-gh aw-ic aw-sm', { 'aria-label': `Move ${e.name} up`, disabled: filtered || i === 0 });
    const down = btn('↓', () => move(i, 1), 'aw-btn aw-gh aw-ic aw-sm', { 'aria-label': `Move ${e.name} down`, disabled: filtered || i === agg.endpoints.length - 1 });
    const del = btn([icon('trash', 'aw-i aw-i14')], () => remove(e), 'aw-btn aw-gh aw-ic aw-sm', { 'aria-label': `Delete ${e.name}` });
    return h('li', { class: 'aw-row aw-rule aw-eprow' }, open, h('span', { class: 'aw-col aw-gap4 aw-endcol' }, tags, h('span', { class: 'aw-row aw-gap2' }, run, up, down, del)));
  }

  async function move(i: number, d: number) {
    const name = s.agg().endpoints[i]?.name;
    await s.edit((a) => { const [x] = a.endpoints.splice(i, 1); a.endpoints.splice(i + d, 0, x!); });
    kit.announce(`${name} moved ${d < 0 ? 'up' : 'down'}.`);
  }

  async function remove(e: Endpoint) {
    const agg = s.agg();
    const plans = agg.plans.filter((p) => p.steps.some((st) => st.endpointId === e.id)).map((p) => p.name);
    const rules = agg.rules.filter((r) => r.endpointId === e.id).length;
    const refs = aliasReferences(agg, e.alias, e.id);
    const auth = agg.authContexts.filter((a) => a.refresh?.endpointId === e.id).map((a) => a.label);
    const impact = [
      plans.length ? `removed from plan${plans.length > 1 ? 's' : ''} ${plans.join(', ')}` : '',
      rules ? `${rules} linked rule${rules > 1 ? 's' : ''} keep their last matcher and lose the link` : '',
      refs.length ? `${refs.reduce((n, r) => n + r.count, 0)} reference(s) to {{${e.alias}…}} in ${refs.map((r) => r.name).join(', ')} become unresolved` : '',
    ].filter(Boolean);
    if (auth.length) {
      await kit.ask(`${e.name} cannot be deleted: it is the refresh endpoint of auth context ${auth.join(', ')}.`, [{ label: 'OK', cls: 'aw-out', value: 'ok' }]);
      return;
    }
    const v = await kit.ask(`Delete ${e.name}?${impact.length ? ` It will be ${impact.join('; ')}.` : ' Nothing else refers to it.'}`, [
      { label: 'Cancel', cls: 'aw-out', value: 'cancel' }, { label: 'Delete', cls: 'aw-dst', value: 'delete' },
    ]);
    if (v !== 'delete') return;
    const diags = await s.edit((a) => {
      a.endpoints = a.endpoints.filter((x) => x.id !== e.id);
      for (const p of a.plans) p.steps = p.steps.filter((st) => st.endpointId !== e.id);
      for (const r of a.rules) if (r.endpointId === e.id) {
        // Detach to the last resolved matcher so the rule keeps matching what it matched.
        r.matcher = { ...r.matcher, ...linkedMatcher(a, e) };
        delete r.endpointId;
      }
    });
    kit.announce(diags ? `Not deleted: ${diags[0]!.message}` : `${e.name} deleted.`);
  }

  // ---------- shared row editors
  function headerRows(list: Header[], errs: Errors, path: string, allowRemove: boolean, onChange: () => void) {
    const wrap = h('div', { class: 'aw-col aw-gap6' });
    const draw = (focusLast = false) => {
      wrap.replaceChildren(...list.map((hd, i) => {
        const name = input(hd.name, (v) => { hd.name = v; onChange(); }, { mono: true, label: `Header ${i + 1} name`, placeholder: 'Header-Name' });
        const value = input(hd.value, (v) => { hd.value = v; onChange(); }, { mono: true, label: `Header ${i + 1} value`, placeholder: hd.remove ? '(removed)' : 'value' });
        value.disabled = !!hd.remove;
        const errN = h('span', { class: 'aw-err', role: 'alert' });
        const errV = h('span', { class: 'aw-err', role: 'alert' });
        errs.slot(`${path}.${i}.name`, errN, name);
        errs.slot(`${path}.${i}.value`, errV, value);
        const r = h('div', { class: 'aw-row aw-gap6' }, name, value);
        if (allowRemove) r.append(h('span', { class: 'aw-chk aw-xs', title: 'Send without this inherited header' }, checkbox(`Remove ${hd.name || `header ${i + 1}`} from this request`, !!hd.remove, (v) => {
          if (v) hd.remove = true; else delete hd.remove;
          onChange();
          draw();
        }), 'Remove'));
        r.append(btn([icon('x')], () => { list.splice(i, 1); onChange(); draw(); }, 'aw-btn aw-gh aw-ic aw-sm', { 'aria-label': `Delete header row ${i + 1}` }));
        return h('div', { class: 'aw-col' }, r, errN, errV);
      }), h('div', { class: 'aw-row aw-gap6' },
        btn([icon('plus', 'aw-i aw-i12'), 'Add header'], () => { list.push({ name: '', value: '' }); onChange(); draw(true); }, 'aw-btn aw-dash aw-sm'),
        presetSelect(list, () => { onChange(); draw(); })));
      if (focusLast) wrap.querySelectorAll<HTMLInputElement>('input[aria-label$="name"]')[list.length - 1]?.focus();
    };
    draw();
    return wrap;
  }

  function presetSelect(list: Header[], after: () => void) {
    const sel = h('select', { class: 'aw-in aw-select aw-sm', 'aria-label': 'Add header preset' },
      h('option', { value: '' }, 'Presets…'), ...PRESETS.map((p, i) => h('option', { value: String(i) }, p.label)));
    sel.addEventListener('change', async () => {
      const p = PRESETS[Number(sel.value)];
      sel.value = '';
      if (!p) return;
      for (const [name, value] of p.headers) {
        const hit = list.find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (hit && hit.value !== value) {
          const v = await kit.ask(`${name} is already set to “${hit.value}”. Replace it with “${value}”?`, [
            { label: 'Keep existing', cls: 'aw-out', value: 'keep' }, { label: 'Replace', cls: 'aw-pri', value: 'replace' },
          ]);
          if (v === 'replace') { hit.value = value; delete hit.remove; }
        } else if (!hit) list.push({ name, value });
      }
      after();
      kit.announce(`Preset ${p.label} added${p.needs ? `; it needs ${p.needs} when sent` : ''}.`);
    });
    return sel;
  }

  // ---------- endpoint editor
  function openEditor(id: string | null, ret: Ret, extra?: (d: Endpoint) => void) {
    const agg = s.agg();
    const existing = id ? agg.endpoints.find((e) => e.id === id) : undefined;
    if (id && !existing) { kit.announce('That endpoint no longer exists.'); return; }
    const draft: Endpoint = existing ? structuredClone(existing) : newEndpoint(agg);
    const base = JSON.stringify(draft);
    extra?.(draft);
    const errs = new Errors();
    const originalAlias = existing?.alias;
    let sampleTouched = false;

    const form: Form = {
      owner: ret.screen === 'test' ? 'test' : 'endpoints',
      ret,
      dirty: () => JSON.stringify(draft) !== base,
      async save() {
        draft.name = draft.name.trim();
        draft.alias = draft.alias.trim();
        if (draft.sample && sampleTouched) { draft.sample.source = 'authored'; draft.sample.bodyState = 'complete'; draft.sample.at = Date.now(); }
        const cur = s.agg();
        const diags = validateEndpointIn(cur, { ...draft, updatedAt: Date.now() });
        if (errs.show(diags, kit.announce)) return false;
        let rename = false;
        if (existing && originalAlias !== draft.alias) {
          const refs = aliasReferences(cur, originalAlias!, draft.id);
          if (refs.length) {
            const v = await kit.ask(`Alias ${originalAlias} → ${draft.alias}: update ${refs.reduce((n, r) => n + r.count, 0)} reference(s) in ${refs.map((r) => r.name).join(', ')}? Only exact {{${originalAlias}…}} references change.`, [
              { label: 'Cancel', cls: 'aw-out', value: 'cancel' }, { label: 'Update references', cls: 'aw-pri', value: 'update' },
            ]);
            if (v !== 'update') return false;
            rename = true;
          }
        }
        const out = await s.edit((a) => {
          const next = { ...structuredClone(draft), updatedAt: Date.now() };
          const i = a.endpoints.findIndex((e) => e.id === draft.id);
          if (i >= 0) a.endpoints[i] = next; else a.endpoints.push(next);
          if (rename) renameAliasRefs(a, originalAlias!, draft.alias);
        });
        if (out && errs.show(out.map((d) => ({ ...d, path: d.path.replace(/^endpoints\.\d+\./, '') })), kit.announce)) return false;
        kit.announce(`${draft.name} saved${s.persist() === 'session-only' ? ' for this page session (storage unavailable)' : ''}.`);
        return true;
      },
      build: () => editorScreen(),
    };

    function editorScreen(): Built {
      errs.clear();
      const cur = s.agg();
      const dest = h('div', { class: 'aw-xs aw-mu aw-mono aw-wrap', 'aria-live': 'polite' });
      const showDest = () => { dest.textContent = `→ ${draft.request.method} ${destination(cur, draft.request, kit.rt.origin)}`; };
      const hostKeys = [...new Set(Object.values(cur.profile.environments).flatMap((e) => Object.keys(e)))];
      const hostSel = select<string>(draft.request.hostKey ?? '', [...hostKeys.map((k): [string, string] => [k, `Host ${k}`]), ['', 'Absolute URL']], (v) => {
        draft.request.hostKey = v || null;
        urlIn.placeholder = v ? '/path' : 'https://api.example.com/path';
        showDest();
      }, { id: 'aw-ep-host' });
      const urlIn = input(draft.request.url, (v) => { draft.request.url = v; showDest(); }, { mono: true, id: 'aw-ep-url', placeholder: draft.request.hostKey === null ? 'https://api.example.com/path' : '/path' });
      const methodSel = select(draft.request.method, METHODS, (v) => { draft.request.method = v; showDest(); }, { id: 'aw-ep-method' });
      showDest();

      const inherited = h('div', { class: 'aw-col aw-gap4' });
      const showInherited = () => {
        const local = new Map(draft.request.headers.map((x) => [x.name.toLowerCase(), x]));
        inherited.replaceChildren(...(cur.profile.globalHeaders.length ? cur.profile.globalHeaders.map((g) => {
          const l = local.get(g.name.toLowerCase());
          const state = !l ? 'inherited' : l.remove ? 'removed here' : 'overridden here';
          return h('div', { class: 'aw-row aw-gap6 aw-xs' }, h('span', { class: `aw-bd ${l ? 'aw-am' : ''}` }, state), h('span', { class: 'aw-mono aw-tr' }, `${g.name}: ${sensitiveHeader(g.name) && !/\{\{/.test(g.value) ? '••••' : g.value}`));
        }) : [h('span', { class: 'aw-hint' }, 'No global headers in this profile.')]));
      };
      showInherited();

      const bodySlot = h('div', { class: 'aw-col aw-gap8' });
      const drawBody = () => bodySlot.replaceChildren(...bodyEditor(draft, errs, drawBody));
      drawBody();
      const checksSlot = h('div', { class: 'aw-col aw-gap8' });
      const drawChecks = () => checksSlot.replaceChildren(...checksEditor(draft.checks, errs, drawChecks));
      drawChecks();
      const sampleSlot = h('div', { class: 'aw-col aw-gap8' });
      const drawSample = () => sampleSlot.replaceChildren(...sampleEditor(draft, errs, () => { sampleTouched = true; }, drawSample));
      drawSample();

      const save = btn([icon('save', 'aw-i aw-i14'), 'Save'], async () => { if (await form.save()) kit.closeForm(`ep-${draft.id}`); }, 'aw-btn aw-pri aw-grow');
      const cancel = btn('Cancel', () => kit.leaveForm(), 'aw-btn aw-out aw-grow');
      kit.foot.replaceChildren(save, cancel);
      kit.foot.hidden = false;

      const auth = section('Auth and signing',
        field('Auth context', select<string>(draft.authContextId ?? '', [['', 'None (headers above only)'], ...cur.authContexts.map((a): [string, string] => [a.id, `${a.label} (${a.audience})`])], (v) => { if (v) draft.authContextId = v; else delete draft.authContextId; }, { id: 'aw-ep-auth' }), errs, 'authContextId',
          'Its headers are read from their sources at dispatch, only for its audience; explicit refresh if configured.'),
        field('Signing recipe', select<string>(draft.signingRecipeId ?? '', [['', 'None'], ...cur.signingRecipes.map((r): [string, string] => [r.id, `${r.label} (${r.algorithm}, key ${r.keyRef})`])], (v) => { if (v) draft.signingRecipeId = v; else delete draft.signingRecipeId; }, { id: 'aw-ep-signing' }), errs, 'signingRecipeId',
          'Signed with a fresh timestamp and nonce just before each send; needs its key loaded for this session.'),
        h('p', { class: 'aw-hint aw-wrap' }, 'Define auth contexts, signing recipes and session keys in Test → Auth & context.'));
      // Expression picker: inserts at the caret of the last focused text field of this editor.
      let lastField: HTMLInputElement | HTMLTextAreaElement | null = null;
      const picker = exprPicker(cur, draft.id, () => (lastField?.isConnected ? lastField : null), kit.announce);
      const nodes: Node[] = [
          h('div', { class: 'aw-row' }, kit.backButton(ret.screen, () => kit.leaveForm()), heading(existing ? `Edit ${existing.name}` : 'New endpoint')),
          errs.summary,
          h('div', { class: 'aw-g2' },
            field('Name', input(draft.name, (v) => { draft.name = v; }, { id: 'aw-ep-name' }), errs, 'name'),
            field('Alias', input(draft.alias, (v) => { draft.alias = v; }, { mono: true, id: 'aw-ep-alias' }), errs, 'alias', 'Used in {{alias.path}} references; unique in this profile.')),
          section('Request',
            h('div', { class: 'aw-row aw-top aw-gap8' },
              h('div', { class: 'aw-w104' }, field('Method', methodSel, errs, 'request.method')),
              h('div', { class: 'aw-grow' }, field('Host', hostSel, errs, 'request.hostKey'))),
            field('Path or URL', urlIn, errs, 'request.url', 'Environments never retarget an absolute URL. A raw ?query here is sent verbatim.'),
            dest,
            h('div', { class: 'aw-col aw-gap6' }, h('span', { class: 'aw-lbl' }, 'Query parameters (encoded, in order)'), pairRows(draft.request.query, 'query parameter', errs, 'request.query')),
            field('Credentials', select(draft.request.credentials, [['same-origin', 'Same origin'], ['include', 'Include (cross-origin cookies)'], ['omit', 'Omit']], (v) => { draft.request.credentials = v; }, { id: 'aw-ep-cred' }), errs, 'request.credentials')),
          section('Headers',
            h('div', { class: 'aw-lbl' }, 'Inherited from global'), inherited,
            h('div', { class: 'aw-lbl' }, 'This endpoint (overrides and removals)'),
            headerRows(draft.request.headers, errs, 'request.headers', true, showInherited)),
          section('Body', bodySlot),
          section('Checks', checksSlot),
          section('Response sample', sampleSlot),
          auth,
          h('p', { class: 'aw-hint aw-wrap' }, `${draft.provenance}. Saving changes stored data only; nothing is sent.`),
      ];
      const wrap = h('div', { class: 'aw-col aw-gap12' }, h('div', { class: 'aw-row aw-gap6' }, h('span', { class: 'aw-xs aw-mu aw-grow' }, 'Expressions: click a field, then pick'), picker), ...nodes.slice(1));
      wrap.addEventListener('focusin', (ev) => {
        const t = ev.target;
        if ((t instanceof HTMLInputElement && (t.type === 'text' || t.type === '' || t.type === 'search')) || t instanceof HTMLTextAreaElement) lastField = t;
      });
      return { nodes: [nodes[0]!, wrap] };
    }
    kit.openForm(form);
  }

  function bodyEditor(d: Endpoint, errs: Errors, redraw: () => void): Node[] {
    const b = d.request.body;
    const err = h('span', { class: 'aw-err', role: 'alert' });
    const kindSel = select(b.kind, BODY_KINDS, async (k) => {
      const next = convertBody(b, k);
      if (next.lost) {
        const v = await kit.ask(`Switching the body to ${BODY_KINDS.find((x) => x[0] === k)![1]} discards: ${next.lost}.`, [
          { label: 'Keep current body', cls: 'aw-out', value: 'keep' }, { label: 'Switch', cls: 'aw-dst', value: 'switch' },
        ]);
        if (v !== 'switch') { kindSel.value = b.kind; return; }
      }
      d.request.body = next.body;
      redraw();
      errs.summary.hidden = true;
      kit.root.getElementById('aw-ep-bodykind')?.focus();
    }, { id: 'aw-ep-bodykind' });
    errs.slot('request.body', err, kindSel);
    errs.slot('request.body.kind', err, kindSel);
    const out: Node[] = [field('Body kind', kindSel), err];
    if (b.kind === 'text' || b.kind === 'json') {
      const ta = textarea(b.text, (v) => { b.text = v; }, { id: 'aw-ep-body', rows: 6 });
      out.push(field(b.kind === 'json' ? 'JSON text' : 'Text', ta, errs, 'request.body.text', 'Sent byte-for-byte as written; never reformatted unless you click Format.'));
      if (b.kind === 'json') {
        const msg = h('span', { class: 'aw-hint', role: 'status' });
        out.push(h('div', { class: 'aw-row aw-gap6' }, btn('Format JSON', () => {
          try {
            b.text = JSON.stringify(JSON.parse(b.text), null, 2);
            ta.value = b.text;
            msg.textContent = 'Formatted.';
          } catch (e) { msg.textContent = `Not formatted: ${(e as Error).message}`; }
        }), msg));
      }
    } else if (b.kind === 'urlencoded') {
      out.push(h('span', { class: 'aw-lbl' }, 'Fields (repeated names and order kept)'), pairRows(b.pairs, 'form field', errs, 'request.body.pairs'));
    } else if (b.kind === 'multipart') {
      out.push(partRows(b.parts, errs), h('p', { class: 'aw-hint aw-wrap' }, 'Files are chosen each time you run; no file content or local path is stored. The browser sets the boundary.'));
    }
    return out;
  }

  function partRows(parts: Part[], errs: Errors) {
    const wrap = h('div', { class: 'aw-col aw-gap6' });
    const draw = () => {
      wrap.replaceChildren(...parts.map((p, i) => {
        const name = input(p.name, (v) => { p.name = v; }, { mono: true, label: `Part ${i + 1} name`, placeholder: 'name' });
        const err = h('span', { class: 'aw-err', role: 'alert' });
        errs.slot(`request.body.parts.${i}.name`, err, name);
        const second = p.kind === 'field'
          ? input(p.value, (v) => { p.value = v; }, { mono: true, label: `Part ${i + 1} value`, placeholder: 'value' })
          : input(p.fileName, (v) => { p.fileName = v; }, { label: `Part ${i + 1} expected file name (hint)`, placeholder: 'file chosen at run time' });
        const kind = select(p.kind, [['field', 'Field'], ['file', 'File']], (k) => {
          parts[i] = k === 'field' ? { kind: 'field', name: p.name, value: '' } : { kind: 'file', name: p.name, fileName: '' };
          draw();
        }, { label: `Part ${i + 1} kind` });
        return h('div', { class: 'aw-col' }, h('div', { class: 'aw-row aw-gap6' }, kind, name, second,
          btn([icon('x')], () => { parts.splice(i, 1); draw(); }, 'aw-btn aw-gh aw-ic aw-sm', { 'aria-label': `Remove part ${i + 1}` })), err);
      }), h('div', { class: 'aw-row aw-gap6' },
        btn([icon('plus', 'aw-i aw-i12'), 'Add field'], () => { parts.push({ kind: 'field', name: '', value: '' }); draw(); }, 'aw-btn aw-dash aw-sm'),
        btn([icon('plus', 'aw-i aw-i12'), 'Add file'], () => { parts.push({ kind: 'file', name: '', fileName: '' }); draw(); }, 'aw-btn aw-dash aw-sm')));
    };
    draw();
    return wrap;
  }

  function checksEditor(checks: Check[], errs: Errors, redraw: () => void): Node[] {
    const rows = checks.map((c, i) => {
      const p = `checks.${i}`;
      const err = h('span', { class: 'aw-err', role: 'alert' });
      const kind = select(c.kind, CHECK_KINDS, (k) => { checks[i] = blankCheck(k); redraw(); }, { label: `Check ${i + 1} kind` });
      const num = (k: string, v: number, label: string) => {
        const el = input(Number.isFinite(v) ? String(v) : '', (t) => { (c as unknown as Record<string, number>)[k] = t.trim() === '' ? NaN : Number(t); }, { mono: true, label: `Check ${i + 1} ${label}` });
        el.inputMode = 'numeric';
        errs.slot(`${p}.${k}`, err, el);
        return el;
      };
      const txt = (k: string, v: string, label: string) => {
        const el = input(v, (t) => { (c as unknown as Record<string, string>)[k] = t; }, { mono: true, label: `Check ${i + 1} ${label}`, placeholder: label });
        errs.slot(`${p}.${k}`, err, el);
        return el;
      };
      const parts: Node[] = [kind];
      switch (c.kind) {
        case 'status': parts.push(num('min', c.min, 'minimum status'), h('span', { class: 'aw-mu' }, '–'), num('max', c.max, 'maximum status')); break;
        case 'header': {
          const val = input(c.value ?? '', (t) => { if (t) c.value = t; else delete c.value; }, { mono: true, label: `Check ${i + 1} expected value (blank = present)`, placeholder: 'blank = present' });
          parts.push(txt('name', c.name, 'header name'), val);
          break;
        }
        case 'body-contains': parts.push(txt('value', c.value, 'text')); break;
        case 'json': {
          const mode = select(c.mode, [['exists', 'exists'], ['equals', 'equals'], ['type', 'is type']], (m) => { c.mode = m; if (m === 'exists') delete c.value; else c.value ??= ''; redraw(); }, { label: `Check ${i + 1} JSON mode` });
          parts.push(txt('path', c.path, 'path e.g. items[0].id'), mode);
          if (c.mode !== 'exists') parts.push(txt('value', c.value ?? '', c.mode === 'type' ? 'string|number|…' : 'value'));
          break;
        }
        case 'duration': parts.push(num('maxMs', c.maxMs, 'max ms')); break;
      }
      parts.push(btn([icon('x')], () => { checks.splice(i, 1); redraw(); }, 'aw-btn aw-gh aw-ic aw-sm', { 'aria-label': `Remove check ${i + 1}` }));
      return h('div', { class: 'aw-col' }, h('div', { class: 'aw-row aw-gap6 aw-checkrow' }, ...parts), err);
    });
    return [
      ...(rows.length ? rows : [h('p', { class: 'aw-hint' }, 'No checks: any HTTP response counts as received, not as passed.')]),
      h('div', { class: 'aw-row' }, btn([icon('plus', 'aw-i aw-i12'), 'Add check'], () => { checks.push(blankCheck('status')); redraw(); }, 'aw-btn aw-dash aw-sm')),
      h('p', { class: 'aw-hint aw-wrap' }, 'Body and JSON checks need the complete body; a truncated or unreadable body is reported as not evaluated, never passed.'),
    ];
  }

  function sampleEditor(d: Endpoint, errs: Errors, touched: () => void, redraw: () => void): Node[] {
    const sm = d.sample;
    if (!sm) return [h('p', { class: 'aw-hint' }, 'No sample. Save one from a Once result, or add one by hand (labelled authored).'),
      h('div', { class: 'aw-row' }, btn('Add sample by hand', () => { d.sample = { status: NaN, headers: [], body: '', bodyState: 'complete', source: 'authored', at: Date.now() }; redraw(); }, 'aw-btn aw-dash aw-sm'))];
    const label = sm.source === 'captured' ? `Captured response${sm.at ? ` · ${new Date(sm.at).toLocaleString()}` : ''}` : sm.source === 'migrated' ? 'Migrated from schema 1' : 'Authored by hand (not network evidence)';
    const status = input(Number.isFinite(sm.status) ? String(sm.status) : '', (t) => { sm.status = t.trim() === '' ? NaN : Number(t); touched(); }, { mono: true, id: 'aw-ep-sstatus' });
    return [
      h('div', { class: 'aw-row aw-gap6' }, h('span', { class: 'aw-bd' }, label), sm.bodyState !== 'complete' ? h('span', { class: 'aw-bd aw-am' }, `body ${sm.bodyState}`) : null),
      h('div', { class: 'aw-w104' }, field('Status', status, errs, 'sample.status')),
      h('span', { class: 'aw-lbl' }, 'Headers'), pairRows(sm.headers, 'sample header', errs, 'sample.headers', touched),
      field('Body', textarea(sm.body, (v) => { sm.body = v; touched(); }, { rows: 5, id: 'aw-ep-sbody' }), errs, 'sample.body', `Up to ${BOUNDS.sampleBytes / 1024} KB. Editing marks the sample as authored.`),
      h('div', { class: 'aw-row' }, btn('Remove sample', () => { delete d.sample; redraw(); }, 'aw-btn aw-gh aw-sm')),
    ];
  }

  // ---------- global headers
  function openHeaders(ret: Ret) {
    const list = structuredClone(s.agg().profile.globalHeaders);
    const base = JSON.stringify(list);
    const errs = new Errors();
    const form: Form = {
      owner: 'endpoints', ret,
      dirty: () => JSON.stringify(list) !== base,
      async save() {
        const out = await s.edit((a) => { a.profile.globalHeaders = list.map((x) => ({ name: x.name.trim(), value: x.value })); });
        if (out && errs.show(out.map((d) => ({ ...d, path: d.path.replace(/^profile\./, '') })), kit.announce)) return false;
        kit.announce('Global headers saved.');
        return true;
      },
      build() {
        errs.clear();
        kit.foot.replaceChildren(
          btn([icon('save', 'aw-i aw-i14'), 'Save'], async () => { if (await form.save()) kit.closeForm('ep-headers'); }, 'aw-btn aw-pri aw-grow'),
          btn('Cancel', () => kit.leaveForm(), 'aw-btn aw-out aw-grow'));
        kit.foot.hidden = false;
        return {
          nodes: [
            h('div', { class: 'aw-row' }, kit.backButton(ret.screen, () => kit.leaveForm()), heading('Global headers')),
            h('p', { class: 'aw-hint aw-wrap' }, `Sent with every endpoint in profile ${s.agg().profile.name} unless the endpoint overrides or removes the header. Endpoints are not copied.`),
            errs.summary,
            headerRows(list, errs, 'globalHeaders', false, () => {}),
          ],
        };
      },
    };
    kit.openForm(form);
  }

  // ---------- Promote common
  function openPromote(ret: Ret) {
    const chosen = new Set<string>();
    const form: Form = {
      owner: 'endpoints', ret,
      dirty: () => false,
      save: async () => true,
      build() {
        const agg = s.agg();
        const preview = h('div', { class: 'aw-col aw-gap6', 'aria-live': 'polite' });
        const commit = btn('Promote', () => run(), 'aw-btn aw-pri aw-grow', { disabled: true });
        const draw = () => {
          const p = promotion(s.agg(), [...chosen]);
          commit.disabled = !p.add.length;
          commit.textContent = p.add.length ? `Promote ${p.add.length} header${p.add.length > 1 ? 's' : ''}` : 'Promote';
          preview.replaceChildren(...(chosen.size < 2 ? [h('p', { class: 'aw-hint' }, 'Select at least two endpoints.')] : [
            ...(p.add.length ? p.add.map((x) => h('div', { class: 'aw-xs aw-mono aw-wrap' }, `+ global ${x.name}: ${x.value} · removed locally from ${chosen.size} endpoints`)) : [h('p', { class: 'aw-hint' }, 'No identical, non-sensitive header is set on all selected endpoints.')]),
            ...p.skipped.map((t) => h('div', { class: 'aw-xs aw-mu aw-wrap' }, t)),
            ...(p.alsoAffects.length ? [h('div', { class: 'aw-xs aw-am aw-wrap' }, `Also newly sent by unselected endpoints that do not set it: ${p.alsoAffects.join(', ')}`)] : []),
          ]));
        };
        async function run() {
          const p = promotion(s.agg(), [...chosen]);
          try {
            const out = await s.edit((a) => {
              for (const x of p.add) if (!a.profile.globalHeaders.some((g) => g.name.toLowerCase() === x.name.toLowerCase())) a.profile.globalHeaders.push({ name: x.name, value: x.value });
              for (const e of a.endpoints) if (chosen.has(e.id)) e.request.headers = e.request.headers.filter((hd) => hd.remove || !p.add.some((x) => x.name.toLowerCase() === hd.name.toLowerCase()));
            }, true);
            if (out) { kit.announce(`Not promoted: ${out[0]!.message}`); return; }
          } catch (e) {
            kit.announce(`Not promoted: ${(e as Error).message}. Nothing was changed.`);
            await kit.ask(`Promotion was not saved: ${(e as Error).message}. Nothing was changed.`, [{ label: 'OK', cls: 'aw-out', value: 'ok' }]);
            return;
          }
          kit.announce(`Promoted ${p.add.map((x) => x.name).join(', ')} to global headers.`);
          kit.closeForm('ep-promote');
        }
        kit.foot.replaceChildren(commit, btn('Cancel', () => kit.leaveForm(), 'aw-btn aw-out aw-grow'));
        kit.foot.hidden = false;
        draw();
        return {
          nodes: [
            h('div', { class: 'aw-row' }, kit.backButton(ret.screen, () => kit.leaveForm()), heading('Promote common headers')),
            h('p', { class: 'aw-hint aw-wrap' }, 'Moves headers that are identical on every selected endpoint into the global list, in one saved change. Sensitive literal values (tokens, keys, cookies) are never promoted.'),
            h('div', { class: 'aw-card aw-list' }, ...agg.endpoints.map((e) => h('div', { class: 'aw-row aw-gap8 aw-li' }, checkbox(`Select ${e.name}`, chosen.has(e.id), (v) => { if (v) chosen.add(e.id); else chosen.delete(e.id); draw(); }), methodBadge(e.request.method), h('span', { class: 'aw-tr' }, e.name)))),
            section('Preview', preview),
          ],
        };
      },
    };
    kit.openForm(form);
  }

  // ---------- environments
  function openEnvironments(ret: Ret) {
    const p = s.agg().profile;
    const draft = { envs: structuredClone(p.environments), active: p.activeEnvironment };
    const base = JSON.stringify(draft);
    const errs = new Errors();
    let viewing = draft.active;
    const form: Form = {
      owner: 'endpoints', ret,
      dirty: () => JSON.stringify(draft) !== base,
      async save() {
        for (const [env, hosts] of Object.entries(draft.envs)) for (const [k, o] of Object.entries(hosts)) {
          if (o.trim()) { const r = validateOrigin(o); if (!r.ok) return !errs.show([{ path: `${env}.${k}`, message: r.error }], kit.announce); hosts[k] = r.origin; } else hosts[k] = '';
        }
        const out = await s.edit((a) => { a.profile.environments = structuredClone(draft.envs); a.profile.activeEnvironment = draft.active; });
        if (out && errs.show(out.map((d): Diag => ({ ...d, path: d.path.replace(/^profile\.environments\./, '') })), kit.announce)) return false;
        kit.announce(`Environments saved; active environment ${draft.active}.`);
        return true;
      },
      build() {
        errs.clear();
        const envNames = Object.keys(draft.envs);
        if (!draft.envs[viewing]) viewing = envNames[0]!;
        const hosts = draft.envs[viewing]!;
        const preview = h('div', { class: 'aw-col aw-gap4', 'aria-live': 'polite' });
        const drawPreview = () => {
          const cur = s.agg();
          const after: Aggregate = { ...cur, profile: { ...cur.profile, environments: draft.envs, activeEnvironment: draft.active } };
          const lines = cur.endpoints.map((e) => {
            const a = destination(cur, e.request, kit.rt.origin), b = destination(after, e.request, kit.rt.origin);
            return { e, a, b };
          });
          const changed = lines.filter((l) => l.a !== l.b);
          const absolute = cur.endpoints.filter((e) => e.request.hostKey === null).length;
          preview.replaceChildren(
            h('div', { class: 'aw-xs aw-wrap' }, changed.length ? `${changed.length} endpoint destination(s) change when saved:` : 'No endpoint destination changes.'),
            ...changed.slice(0, 20).map((l) => h('div', { class: 'aw-xs aw-mono aw-wrap' }, `${l.e.name}: ${l.a} → ${l.b}`)),
            absolute ? h('div', { class: 'aw-xs aw-mu aw-wrap' }, `${absolute} absolute-URL endpoint(s) are unchanged by environments.`) : '');
        };
        const rows = Object.keys(hosts).map((k) => {
          const o = input(hosts[k]!, (v) => { hosts[k] = v; drawPreview(); }, { mono: true, label: `Origin for host ${k} in ${viewing}`, placeholder: `blank = this page (${kit.rt.origin})` });
          const err = h('span', { class: 'aw-err', role: 'alert' });
          errs.slot(`${viewing}.${k}`, err, o);
          return h('div', { class: 'aw-col' }, h('div', { class: 'aw-row aw-gap6' }, h('span', { class: 'aw-mono aw-w104 aw-tr' }, k), o,
            btn([icon('x')], () => { delete hosts[k]; rebuild(); }, 'aw-btn aw-gh aw-ic aw-sm', { 'aria-label': `Remove host ${k} from ${viewing}` })), err);
        });
        let newHost = '', newEnv = '';
        const rebuild = () => kit.openForm(form);
        kit.foot.replaceChildren(
          btn([icon('save', 'aw-i aw-i14'), 'Save'], async () => { if (await form.save()) kit.closeForm('ep-env'); }, 'aw-btn aw-pri aw-grow'),
          btn('Reset', () => { const b = JSON.parse(base) as typeof draft; draft.envs = b.envs; draft.active = b.active; viewing = b.active; rebuild(); kit.announce('Environment draft reset to the saved values.'); }, 'aw-btn aw-out aw-grow'),
          btn('Cancel', () => kit.leaveForm(), 'aw-btn aw-out aw-grow'));
        kit.foot.hidden = false;
        drawPreview();
        return {
          nodes: [
            h('div', { class: 'aw-row' }, kit.backButton(ret.screen, () => kit.leaveForm()), heading('Environments')),
            errs.summary,
            h('div', { class: 'aw-g2' },
              field('Active environment', select(draft.active, envNames, (v) => { draft.active = v; drawPreview(); }, { id: 'aw-env-active' })),
              field('Editing', select(viewing, envNames, (v) => { viewing = v; rebuild(); }, { id: 'aw-env-view' }))),
            section(`Hosts in ${viewing}`, ...rows,
              h('div', { class: 'aw-row aw-gap6' }, input('', (v) => { newHost = v; }, { mono: true, label: 'New host key', placeholder: 'host key, e.g. api' }),
                btn('Add host', () => {
                  const k = newHost.trim();
                  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k) || Object.hasOwn(hosts, k)) { kit.announce('Host keys are 1–64 letters, digits, . _ - and must be new.'); return; }
                  hosts[k] = '';
                  rebuild();
                }))),
            section('Environments',
              h('div', { class: 'aw-row aw-gap6' }, input('', (v) => { newEnv = v; }, { label: 'New environment name', placeholder: 'e.g. staging' }),
                btn('Add environment', () => {
                  const n = newEnv.trim();
                  if (!/^[A-Za-z0-9_. -]{1,64}$/.test(n) || Object.hasOwn(draft.envs, n)) { kit.announce('Environment names are 1–64 characters and must be new.'); return; }
                  draft.envs[n] = Object.fromEntries(Object.keys(hosts).map((k) => [k, '']));
                  viewing = n;
                  rebuild();
                })),
              envNames.length > 1 ? btn(`Delete ${viewing}`, () => {
                delete draft.envs[viewing];
                if (draft.active === viewing) draft.active = Object.keys(draft.envs)[0]!;
                rebuild();
              }, 'aw-btn aw-dst aw-sm') : null),
            section('Preview', preview),
          ],
        };
      },
    };
    kit.openForm(form);
  }

  return { screen, openEditor };
}

function blankCheck(k: Check['kind']): Check {
  switch (k) {
    case 'status': return { kind: k, min: 200, max: 299 };
    case 'header': return { kind: k, name: '' };
    case 'body-contains': return { kind: k, value: '' };
    case 'json': return { kind: k, path: '', mode: 'exists' };
    case 'duration': return { kind: k, maxMs: 1000 };
  }
}

/** Convert a body to another kind, keeping content where it maps exactly; `lost` names what would be dropped. */
export function convertBody(b: Body, k: BodyKind): { body: Body; lost: string } {
  const text = b.kind === 'text' || b.kind === 'json' ? b.text : '';
  const pairs = b.kind === 'urlencoded' ? b.pairs : b.kind === 'multipart' && b.parts.every((p) => p.kind === 'field') ? b.parts.map((p) => [p.name, (p as { value: string }).value] as Pair) : null;
  const has = text !== '' || (b.kind === 'urlencoded' && b.pairs.length > 0) || (b.kind === 'multipart' && b.parts.length > 0);
  const what = b.kind === 'text' || b.kind === 'json' ? 'the body text' : b.kind === 'urlencoded' ? 'the form fields' : 'the multipart parts';
  switch (k) {
    case 'none': return { body: { kind: k }, lost: has ? what : '' };
    case 'text': case 'json': return b.kind === 'text' || b.kind === 'json' ? { body: { kind: k, text }, lost: '' } : { body: { kind: k, text: '' }, lost: has ? what : '' };
    case 'urlencoded': return pairs ? { body: { kind: k, pairs: structuredClone(pairs) }, lost: '' } : { body: { kind: k, pairs: [] }, lost: has ? what : '' };
    case 'multipart': return b.kind === 'urlencoded' ? { body: { kind: k, parts: b.pairs.map(([name, value]) => ({ kind: 'field', name, value })) }, lost: '' }
      : b.kind === 'multipart' ? { body: b, lost: '' } : { body: { kind: k, parts: [] }, lost: has ? what : '' };
  }
}

/** Headers identical (case-insensitive name, exact value) on every chosen endpoint, minus sensitive literals and global conflicts. */
export function promotion(agg: Aggregate, ids: string[]): { add: { name: string; value: string }[]; skipped: string[]; alsoAffects: string[] } {
  const eps = agg.endpoints.filter((e) => ids.includes(e.id));
  const add: { name: string; value: string }[] = [];
  const skipped: string[] = [];
  if (eps.length < 2) return { add, skipped, alsoAffects: [] };
  for (const hd of eps[0]!.request.headers) {
    if (hd.remove) continue;
    const key = hd.name.toLowerCase();
    const same = eps.every((e) => e.request.headers.some((x) => !x.remove && x.name.toLowerCase() === key && x.value === hd.value));
    if (!same) continue;
    if (sensitiveHeader(hd.name) && !/^\s*(Bearer\s+)?\{\{[^}]*\}\}\s*$/.test(hd.value)) { skipped.push(`${hd.name} not promoted: sensitive literal value`); continue; }
    const g = agg.profile.globalHeaders.find((x) => x.name.toLowerCase() === key);
    if (g && g.value !== hd.value) { skipped.push(`${hd.name} not promoted: global already sets a different value`); continue; }
    add.push({ name: hd.name, value: hd.value });
  }
  const alsoAffects = agg.endpoints.filter((e) => !ids.includes(e.id) && add.some((x) =>
    !agg.profile.globalHeaders.some((g) => g.name.toLowerCase() === x.name.toLowerCase()) && !e.request.headers.some((hd) => hd.name.toLowerCase() === x.name.toLowerCase()))).map((e) => e.name);
  return { add, skipped, alsoAffects };
}
