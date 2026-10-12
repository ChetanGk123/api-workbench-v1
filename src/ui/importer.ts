// Import: one source draft (paste/file/schema 1/recorder), one review, one durable commit.
// Parsing and review never send a request or write storage; only Import selected commits.
import { IMPORT_MAX_BYTES, type ImportRead } from '../data/backup';
import { capturesToHar, FORMAT_NAMES, parseSource, type Format } from '../data/importers';
import { migrateV1 } from '../data/migrate';
import { RECORDER, type Recorder } from '../data/recorder';
import {
  applyCandidates, candidatesFromCaptures, candidatesFromDrafts, candidatesFromNative, dependencySuggestions, mergeNative, plansUsing, rebuildCandidate,
  type Applied, type Candidate, type Draft, type Suggestion,
} from '../data/review';
import { copyAggregate, defaultProfile, validateAggregate, type Aggregate, type Diag } from '../data/schema';
import { Conflict, readV1 } from '../data/store';
import type { Capture } from '../net/capture';
import { exportEnvelope } from '../data/backup';
import { h, icon } from './dom';
import { btn, checkbox, download, field, fileButton, heading, input, methodBadge, section, select, textarea, tile, type Built, type Kit } from './kit';

type Phase = 'empty' | 'reading' | 'parsing' | 'invalid' | 'review' | 'saving' | 'failed' | 'saved';
type NativeMode = 'new' | 'merge' | 'replace' | 'all';

interface Review {
  source: string;
  label: string;
  notes: string[];
  skipped: string[];
  /** Destination the review was built against; a change makes it stale. */
  profileId: string;
  revision: number;
  candidates: Candidate[];
  suggestions: Suggestion[];
  calls?: { captures: Capture[]; fromRecorder: boolean; group: boolean; dest: 'current' | 'new'; newName: string };
  /** Swagger/OpenAPI/Postman/cURL/fetch: drafted requests; `servers` when an OpenAPI document declares several. */
  drafts?: { list: Draft[]; dest: 'current' | 'new'; newName: string; text: string; format: Format; servers?: string[]; server: number };
  native?: { read: ImportRead; mode: NativeMode };
}

const kib = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const fail = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createImportUi(kit: Kit, rec: Recorder, o: { version: string; onProfileChange(): void; scope(): string }) {
  const s = kit.session;
  let text = '';
  let edited = false;
  let sourceName = '';
  let override: Format = 'auto';
  /** Monotonic draft generation: a stale file read or parse never replaces newer input. */
  let gen = 0;
  let phase: Phase = 'empty';
  let message = '';
  let errors: Diag[] = [];
  let review: Review | null = null;
  let saved: { text: string; recorderIds: number[]; fromRecorder: boolean } | null = null;
  /** Which screen is built: Record shows only recorder reviews, Import only pasted/file reviews (one draft at a time). */
  let where: 'import' | 'record' = 'import';
  const fromRecorder = () => !!(review ? review.calls?.fromRecorder : saved?.fromRecorder);

  // Elements of the current screen (rebuilt by screen()).
  let ui: { state: HTMLElement; text: HTMLTextAreaElement; review: HTMLElement; rec: HTMLElement; stale: HTMLElement } | null = null;

  const destination = () => s.agg();
  /** Script-readable cookie names on this page now ($cookie reads the same jar at send time). */
  const cookieNames = () => { try { return document.cookie.split(';').map((p) => p.split('=')[0]!.trim()).filter(Boolean); } catch { return []; } };
  const isStale = () => !!review && (destination().profile.id !== review.profileId || destination().revision !== review.revision);

  // ---------- source draft

  function setPhase(p: Phase, msg = '') {
    phase = p;
    message = msg;
    drawState();
  }

  function drawState() {
    if (!ui) return;
    const label: Record<Phase, string> = {
      empty: 'No source yet.', reading: 'Reading file…', parsing: 'Parsing…', invalid: 'Nothing can be imported.', review: 'Review ready. Nothing is saved until you import.',
      saving: 'Saving…', failed: 'Save failed. Nothing was saved.', saved: 'Saved.',
    };
    ui.state.replaceChildren(
      h('span', { class: `aw-bd ${phase === 'invalid' || phase === 'failed' ? 'aw-am' : phase === 'saved' ? 'aw-gr' : ''}` }, label[phase]),
      sourceName ? h('span', { class: 'aw-xs aw-mu aw-wrap' }, ` ${sourceName}`) : '',
      message ? h('p', { class: 'aw-hint aw-wrap' }, message) : '',
      ...(phase === 'invalid' ? [h('div', { class: 'aw-alert aw-col aw-gap4', id: 'aw-imp-errors' }, ...errors.slice(0, 12).map((d) => h('div', { class: 'aw-wrap' }, d.path ? `${d.path}: ${d.message}` : d.message)), errors.length > 12 ? h('div', {}, `…and ${errors.length - 12} more`) : '')] : []),
    );
  }

  async function apply(from = 'Pasted text') {
    const my = ++gen;
    sourceName = from;
    review = null;
    saved = null;
    drawReview();
    setPhase('parsing');
    await tick(); // let Cancel/Close paint before the synchronous parse
    if (my !== gen) return;
    const r = parseSource(text, override);
    await tick();
    if (my !== gen) return; // cancelled or replaced while parsing
    if (!r.ok) { errors = r.errors; return setPhase('invalid'); }
    const p = r.value;
    if (p.format === 'har') buildCalls(p.captures, { source: from, label: p.label, notes: p.notes, skipped: p.skipped, fromRecorder: false });
    else if (p.format === 'native') buildNative(p.read, from, p.label);
    else buildDrafts(p.drafts, { source: from, label: p.label, notes: p.notes, skipped: p.skipped, text, format: override, ...(p.servers && { servers: p.servers }), server: 0 });
  }

  function cancel() {
    gen++;
    setPhase(review ? 'review' : text ? 'empty' : 'empty', 'Cancelled. The draft is unchanged.');
  }

  async function readFile(f: File) {
    if (f.size > IMPORT_MAX_BYTES) return setPhase(phase, `${f.name} is ${(f.size / 1024 / 1024).toFixed(1)} MiB; the limit is ${IMPORT_MAX_BYTES / 1024 / 1024} MiB. The current draft is unchanged.`);
    if (edited && text.trim()) {
      const v = await kit.ask(`Replace the edited draft with ${f.name}?`, [{ label: 'Cancel', cls: 'aw-out', value: 'cancel' }, { label: 'Replace draft', cls: 'aw-pri', value: 'replace' }]);
      if (v !== 'replace') return;
    }
    const my = ++gen;
    const before = phase;
    setPhase('reading');
    let t: string;
    try { t = await f.text(); } catch (e) {
      if (my === gen) setPhase(before, `${f.name} could not be read (${fail(e)}). The current draft is unchanged.`);
      return;
    }
    if (my !== gen) return; // newer input won
    text = t;
    edited = false;
    if (ui) ui.text.value = t;
    await apply(f.name);
  }

  async function lookForV1() {
    const raw = await readV1(kit.rt.origin);
    if (!raw) return setPhase(phase, 'No schema 1 data is stored for this site.');
    const m = migrateV1(raw);
    gen++;
    if (!m.ok) { errors = m.errors; sourceName = 'Schema 1 database'; return setPhase('invalid'); }
    buildNative({ kind: 'schema1', aggs: m.value.aggregates, activeId: m.value.activeId, notes: m.value.notes }, 'Schema 1 database (read only; left unchanged)', 'API Workbench schema 1 data (migrated preview)');
  }

  // ---------- review building

  function buildCalls(captures: Capture[], x: { source: string; label: string; notes: string[]; skipped: string[]; fromRecorder: boolean }, prev?: Review) {
    const dest = prev?.calls?.dest ?? 'current';
    const group = prev?.calls?.group ?? true;
    const target = dest === 'new' ? defaultProfile('New profile') : destination();
    const { candidates, skipped } = candidatesFromCaptures(target, captures, { group, pageOrigin: kit.rt.origin, cookies: cookieNames() });
    for (const c of candidates) {
      const old = prev?.candidates.find((p) => p.key === c.key && p.members.length === c.members.length && p.members[0]!.id === c.members[0]!.id);
      if (old) keepChoices(target, c, old);
      else if (x.fromRecorder && c.members.every((m) => rec.deselected.has(m.id))) c.selected = false;
    }
    review = {
      source: x.source, label: x.label, notes: x.notes, skipped: [...x.skipped, ...skipped],
      profileId: destination().profile.id, revision: destination().revision,
      candidates, suggestions: dependencySuggestions(candidates),
      calls: { captures, fromRecorder: x.fromRecorder, group, dest, newName: prev?.calls?.newName ?? 'Recorded calls' },
    };
    setPhase('review');
    drawReview();
  }

  function buildDrafts(list: Draft[], x: { source: string; label: string; notes: string[]; skipped: string[]; text: string; format: Format; servers?: string[]; server: number }, prev?: Review) {
    const dest = prev?.drafts?.dest ?? 'current';
    const target = dest === 'new' ? defaultProfile('New profile') : destination();
    const { candidates, skipped } = candidatesFromDrafts(target, list, kit.rt.origin);
    for (const c of candidates) {
      const old = prev?.candidates.find((p) => p.key === c.key && p.draft?.source === c.draft?.source);
      if (old) keepChoices(target, c, old);
    }
    review = {
      source: x.source, label: x.label, notes: x.notes, skipped: [...x.skipped, ...skipped],
      profileId: destination().profile.id, revision: destination().revision, candidates, suggestions: [],
      drafts: { list, dest, newName: prev?.drafts?.newName ?? x.label.split(' · ').pop()!.slice(0, 60), text: x.text, format: x.format, ...(x.servers && { servers: x.servers }), server: x.server },
    };
    setPhase('review');
    drawReview();
  }

  /** OpenAPI with several servers: parse again against the chosen one. */
  function chooseServer(r: Review, idx: number) {
    const d = r.drafts!;
    const p = parseSource(d.text, d.format, { server: idx });
    if (!p.ok || p.value.format === 'native' || p.value.format === 'har') return;
    buildDrafts(p.value.drafts, { source: r.source, label: r.label, notes: p.value.notes, skipped: p.value.skipped, text: d.text, format: d.format, ...(d.servers && { servers: d.servers }), server: idx }, r);
  }

  /** A rebuilt review (destination switch, stale rebuild) keeps the user's choices for the same source item. */
  function keepChoices(target: Aggregate, c: Candidate, old: Candidate) {
    c.selected = old.selected;
    const changed = old.sampleIdx !== c.sampleIdx || old.dropQuery.length > 0 || (old.bodyIdx ?? 0) !== (c.bodyIdx ?? 0);
    c.sampleIdx = old.sampleIdx;
    c.dropQuery = [...old.dropQuery];
    if (old.bodyIdx !== undefined) c.bodyIdx = old.bodyIdx;
    if (changed) rebuildCandidate(target, c, kit.rt.origin, cookieNames());
    c.endpoint.name = old.endpoint.name;
  }

  function buildNative(read: ImportRead, source: string, label: string, mode?: NativeMode) {
    const single = read.kind !== 'backup' && read.aggs.length === 1;
    const m: NativeMode = read.kind === 'backup' ? 'all' : mode && (single || mode === 'new') ? mode : 'new';
    review = {
      source, label, notes: read.notes, skipped: [],
      profileId: destination().profile.id, revision: destination().revision,
      candidates: m === 'merge' ? candidatesFromNative(destination(), read.aggs[0]!, kit.rt.origin) : [],
      suggestions: [],
      native: { read, mode: m },
    };
    setPhase('review');
    drawReview();
  }

  function rebuild() {
    if (!review) return;
    if (review.calls) buildCalls(review.calls.captures, { source: review.source, label: review.label, notes: review.notes, skipped: review.skipped.filter((t) => !t.includes('cannot be saved') && !t.includes('only http')), fromRecorder: review.calls.fromRecorder }, review);
    else if (review.drafts) { const d = review.drafts; buildDrafts(d.list, { source: review.source, label: review.label, notes: review.notes, skipped: review.skipped.filter((t) => !t.includes('cannot be saved as an endpoint')), text: d.text, format: d.format, ...(d.servers && { servers: d.servers }), server: d.server }, review); }
    else if (review.native) buildNative(review.native.read, review.source, review.label, review.native.mode);
    kit.announce('Review rebuilt against the current profile.');
  }

  // ---------- review rendering

  function drawReview() {
    if (!ui) return;
    if ((review || saved) && fromRecorder() !== (where === 'record')) { ui.review.replaceChildren(); return; }
    if (!review) { ui.review.replaceChildren(...(saved ? [savedCard()] : [])); return; }
    const r = review;
    const cur = destination();
    const kids: (Node | string)[] = [
      h('strong', { class: 'aw-wrap' }, `${r.label} · ${r.source}`),
    ];
    if (r.calls || r.drafts) {
      const total = (r.calls ? r.calls.captures.length : r.drafts!.list.length) + r.skipped.length - (r.drafts ? r.skipped.filter((t) => t.includes('cannot be saved as an endpoint')).length : 0);
      const needs = r.candidates.filter((c) => c.requires.length).length;
      kids.push(h('div', { class: 'aw-xs aw-wrap', id: 'aw-imp-counts' }, `${total} source item${total === 1 ? '' : 's'} · ${r.candidates.length} candidate${r.candidates.length === 1 ? '' : 's'} · ${r.skipped.length} skipped${r.drafts ? ` · ${needs} need values` : ''}`));
    }
    kids.push(...r.notes.map((t) => h('div', { class: 'aw-xs aw-mu aw-wrap' }, t)));
    if (r.skipped.length) kids.push(h('details', {}, h('summary', { class: 'aw-xs' }, `Skipped (${r.skipped.length})`), ...r.skipped.map((t) => h('div', { class: 'aw-xs aw-mu aw-wrap' }, t))));
    kids.push(ui.stale);
    if (r.calls || r.drafts) kids.push(...callsControls(r, cur));
    else if (r.native) kids.push(...nativeControls(r, cur));
    if (r.suggestions.length) kids.push(h('details', {}, h('summary', { class: 'aw-xs' }, `Possible dependencies (${r.suggestions.length}, not applied)`), ...r.suggestions.map((x) => h('div', { class: 'aw-xs aw-mu aw-wrap' }, x.text))));
    if (r.candidates.length) kids.push(h('ul', { class: 'aw-eplist aw-col aw-gap8', 'aria-label': 'Import candidates' }, ...r.candidates.map((c, i) => candidateRow(r, c, i))));
    const importBtn = btn([icon('save', 'aw-i aw-i14'), commitLabel(r)], commit, 'aw-btn aw-pri aw-sm', { id: 'aw-imp-commit', disabled: phase === 'saving' });
    kids.push(h('div', { class: 'aw-row aw-gap6 aw-wrapbtns' }, importBtn, btn('Discard review', () => { review = null; setPhase(text ? 'empty' : 'empty'); drawReview(); }, 'aw-btn aw-gh aw-sm')));
    if (phase === 'failed') kids.push(h('div', { class: 'aw-alert aw-col aw-gap6', id: 'aw-imp-failed' }, h('span', { class: 'aw-wrap' }, message),
      h('div', { class: 'aw-row aw-gap6' }, btn('Retry', commit), btn('Export draft', exportDraft, 'aw-btn aw-gh aw-sm'))));
    ui.review.replaceChildren(h('div', { class: 'aw-card aw-cp aw-col aw-gap8', id: 'aw-imp-review' }, ...kids));
    drawStale();
  }

  function commitLabel(r: Review): string {
    if (r.native && r.native.mode !== 'merge') return r.native.mode === 'all' ? 'Replace all profiles' : r.native.mode === 'replace' ? `Replace ${destination().profile.name}` : `Import as new profile${r.native.read.aggs.length > 1 ? 's' : ''}`;
    const n = r.candidates.filter((c) => c.selected).length;
    return `Import ${n} selected`;
  }

  function refreshCommit() {
    const b = ui?.review.querySelector<HTMLButtonElement>('#aw-imp-commit');
    if (b && review) b.lastChild!.textContent = commitLabel(review);
  }

  function callsControls(r: Review, cur: Aggregate): Node[] {
    const c = (r.calls ?? r.drafts)!;
    const destSel = select(c.dest, [['current', `Current profile: ${cur.profile.name}`], ['new', 'New profile…']] as const, (v) => { c.dest = v; rebuild(); }, { id: 'aw-imp-dest', label: 'Destination' });
    const nameIn = input(c.newName, (v) => { c.newName = v; }, { id: 'aw-imp-newname' });
    const all = btn('Select all', () => { r.candidates.forEach((x) => setSelected(r, x, true)); drawReview(); }, 'aw-btn aw-gh aw-sm', { 'aria-label': `Select all ${r.candidates.length} candidates` });
    const none = btn('Clear selection', () => { r.candidates.forEach((x) => setSelected(r, x, false)); drawReview(); }, 'aw-btn aw-gh aw-sm', { 'aria-label': `Clear selection of all ${r.candidates.length} candidates` });
    const d = r.drafts;
    return [
      h('div', { class: 'aw-fieldrow' }, h('div', { class: 'aw-grow' }, field('Destination', destSel)), ...(c.dest === 'new' ? [h('div', { class: 'aw-grow' }, field('New profile name', nameIn))] : [])),
      h('div', { class: 'aw-xs aw-mu aw-wrap', id: 'aw-imp-dest-note' }, c.dest === 'current' ? `Adds to ${cur.profile.name} (revision ${r.revision}). Duplicates of saved endpoints default to Skip.` : 'Creates the profile and switches to it after saving. The current profile is not changed.'),
      ...(d?.servers ? [field('Server', select(String(d.server), d.servers.map((u, i) => [String(i), u || '(relative)'] as [string, string]), (v) => chooseServer(r, Number(v)), { id: 'aw-imp-server' }))] : []),
      h('div', { class: 'aw-row aw-gap6 aw-wrapbtns' },
        r.calls ? h('span', { class: 'aw-chk' }, checkbox('Group identical calls', r.calls.group, (v) => { r.calls!.group = v; rebuild(); }), 'Group identical calls') : '',
        h('div', { class: 'aw-grow' }), all, none),
      r.calls ? h('p', { class: 'aw-hint aw-wrap' }, 'Grouping joins calls with the same method, origin, path, query and body (cache-buster parameters such as _ or ts ignored). Calls that differ stay separate.')
        : h('p', { class: 'aw-hint aw-wrap' }, 'Values the source does not supply are {{$missing("…")}} markers: sending stops at them until you enter a value. Secrets are never imported.'),
    ];
  }

  function nativeControls(r: Review, cur: Aggregate): Node[] {
    const n = r.native!;
    const read = n.read;
    const out: Node[] = read.aggs.map((a) => h('div', { class: 'aw-xs aw-mono aw-wrap' },
      `${a.profile.name}: ${a.endpoints.length} endpoints, ${a.plans.length} plans, ${a.authContexts.length} auth contexts, ${a.signingRecipes.length} signing recipes${a.rules.length ? `, ${a.rules.length} rules` : ''}${a.legacyRules.length ? `, ${a.legacyRules.length} unconverted schema 1 rules (kept as data)` : ''}${s.all().some((b) => b.profile.id === a.profile.id) ? ' · already stored' : ''}`));
    const single = read.kind !== 'backup' && read.aggs.length === 1;
    const modes: [NativeMode, string][] = read.kind === 'backup' ? [['all', 'Replace all profiles (restore backup)']]
      : single ? [['new', 'New profile, then switch to it'], ['merge', `Merge into ${cur.profile.name}`], ['replace', `Replace ${cur.profile.name}`]]
      : [['new', 'New profiles, then switch']];
    out.push(field('Mode', select(n.mode, modes, (v) => buildNative(read, r.source, r.label, v), { id: 'aw-imp-mode' })));
    if (n.mode === 'all') {
      const removed = s.all().filter((a) => !read.aggs.some((b) => b.profile.id === a.profile.id)).map((a) => a.profile.name);
      out.push(h('p', { class: 'aw-hint aw-wrap', id: 'aw-imp-scope' }, `Restore replaces every stored profile.${removed.length ? ` Removed: ${removed.join(', ')}.` : ''} Export a backup first if you may need the current data.`),
        btn('Export current backup first', () => exportCurrent('backup'), 'aw-btn aw-gh aw-sm'));
    } else if (n.mode === 'replace') {
      out.push(h('p', { class: 'aw-hint aw-wrap', id: 'aw-imp-scope' }, `Replaces the contents of ${cur.profile.name}: removes its ${cur.endpoints.length} endpoint(s)${cur.endpoints.length ? ` (${cur.endpoints.slice(0, 8).map((e) => e.name).join(', ')}${cur.endpoints.length > 8 ? '…' : ''})` : ''}, ${cur.plans.length} plan(s), environments and global headers. The profile keeps its name.`),
        btn(`Export ${cur.profile.name} first`, () => exportCurrent('profile'), 'aw-btn aw-gh aw-sm'));
    } else if (n.mode === 'new') {
      out.push(h('p', { class: 'aw-hint aw-wrap', id: 'aw-imp-scope' }, 'Adds the profile(s); one whose ID or name is already stored is added as a renamed copy with every ID remapped. Nothing existing is overwritten. The imported profile becomes active.'));
    } else {
      out.push(h('p', { class: 'aw-hint aw-wrap', id: 'aw-imp-scope' }, `Adds selected endpoints to ${cur.profile.name}, with plans, auth contexts, signing recipes, missing host keys and global headers; IDs are remapped when they collide. Existing mappings and headers win.`));
    }
    return out;
  }

  function setSelected(r: Review, c: Candidate, v: boolean) {
    c.selected = v;
    if (r.calls?.fromRecorder) { for (const m of c.members) v ? rec.deselected.delete(m.id) : rec.deselected.add(m.id); rec.saveSelection(); }
  }

  function candidateRow(r: Review, c: Candidate, i: number): HTMLElement {
    const e = c.endpoint;
    const target = (r.calls ?? r.drafts)?.dest === 'new' ? defaultProfile() : destination();
    const urlText = `${e.request.hostKey === null ? e.request.url : `${(target.profile.environments[target.profile.activeEnvironment] ?? {})[e.request.hostKey] || kit.rt.origin}${e.request.url}`}${e.request.query.length ? `?${e.request.query.map(([k, v]) => `${k}=${v}`).join('&')}` : ''}`;
    const sel = checkbox(`Select ${e.name}`, c.selected, (v) => { setSelected(r, c, v); refreshCommit(); });
    const nameIn = input(e.name, (v) => { e.name = v; }, { label: `Name for candidate ${i + 1}`, id: `aw-cand-name-${i}` });
    const aliasIn = input(e.alias, (v) => { e.alias = v; }, { label: `Alias for candidate ${i + 1}`, mono: true, id: `aw-cand-alias-${i}` });
    const kids: (Node | string | null)[] = [
      h('div', { class: 'aw-row aw-gap6' }, sel, methodBadge(e.request.method), nameIn),
      h('div', { class: 'aw-row aw-gap6' }, h('span', { class: 'aw-xs aw-mu' }, 'alias'), aliasIn),
      h('div', { class: 'aw-xs aw-mono aw-wrap' }, urlText),
      h('div', { class: 'aw-xs aw-mu aw-wrap' }, [c.source, c.variant, e.request.body.kind !== 'none' ? `body ${e.request.body.kind}` : '', e.sample ? `sample ${e.sample.status}${e.sample.bodyState !== 'complete' ? ` (${e.sample.bodyState})` : ''}` : 'no sample'].filter(Boolean).join(' · ')),
    ];
    if (c.members.length > 1) {
      kids.push(field('Sample from', select(String(c.sampleIdx), c.members.map((m, j) => [String(j), `Call #${m.id} · ${m.status ?? m.outcome}${m.ms !== undefined ? ` · ${Math.round(m.ms)} ms` : ''}`] as [string, string]), (v) => {
        c.sampleIdx = Number(v);
        rebuildCandidate(target, c, kit.rt.origin, cookieNames());
        drawReview();
      }, { id: `aw-cand-sample-${i}` })));
    }
    const bodies = c.draft?.bodies ?? [];
    if (bodies.length > 1) {
      kids.push(field('Body example', select(String(c.bodyIdx ?? 0), bodies.map((b, j) => [String(j), b.label] as [string, string]), (v) => {
        c.bodyIdx = Number(v);
        rebuildCandidate(target, c, kit.rt.origin, cookieNames());
        drawReview();
      }, { id: `aw-cand-body-${i}` })));
    }
    for (const t of c.transient) {
      kids.push(h('div', { class: 'aw-chk' }, checkbox(`Remove transient query ${t} from ${e.name}`, c.dropQuery.includes(t), (v) => {
        c.dropQuery = v ? [...c.dropQuery, t] : c.dropQuery.filter((x) => x !== t);
        rebuildCandidate(target, c, kit.rt.origin, cookieNames());
        drawReview();
      }), `Remove transient query ${t} (looks like a cache-buster)`));
    }
    if (c.conflict) {
      const plans = plansUsing(destination(), c.conflict.id);
      kids.push(h('div', { class: 'aw-col aw-gap4' },
        h('div', { class: 'aw-xs aw-wrap' }, `Same request as saved endpoint ${c.conflict.name}.`),
        select(c.action, [['skip', 'Skip (keep the saved one unchanged)'], ['keep', 'Keep both (new ID and alias)'], ['replace', `Replace ${c.conflict.name} (keeps its ID and alias)`]] as const, (v) => { c.action = v; drawReview(); }, { label: `Conflict action for ${e.name}`, id: `aw-cand-action-${i}` }),
        c.action === 'replace' ? h('div', { class: 'aw-xs aw-mu aw-wrap' }, `Replace changes its request, checks and sample${plans.length ? `; used by plans: ${plans.join(', ')}` : ''}. Rules that name its path are not changed.`) : ''));
    }
    if (c.requires.length) kids.push(h('div', { class: 'aw-col aw-gap2' }, h('span', { class: 'aw-xs aw-am' }, 'Needs before sending:'), ...c.requires.map((t) => h('div', { class: 'aw-xs aw-wrap' }, `• ${t}`))));
    if (c.notes.length) kids.push(h('div', { class: 'aw-col aw-gap2' }, ...c.notes.map((t) => h('div', { class: 'aw-xs aw-mu aw-wrap' }, t))));
    if (c.draft) {
      const rq = e.request;
      const b = rq.body;
      const bodyText = b.kind === 'json' || b.kind === 'text' ? b.text : b.kind === 'urlencoded' ? b.pairs.map(([k, v]) => `${k}=${v}`).join('&') : b.kind === 'multipart' ? b.parts.map((p) => (p.kind === 'file' ? `${p.name}: <file ${p.fileName || 'chosen at run time'}>` : `${p.name}: ${p.value}`)).join('\n') : '';
      kids.push(h('details', {}, h('summary', { class: 'aw-xs' }, `Request preview · ${c.source}`),
        h('div', { class: 'aw-xs aw-mono aw-wrap' }, `credentials: ${rq.credentials}`),
        ...rq.headers.map((x) => h('div', { class: 'aw-xs aw-mono aw-wrap' }, `${x.name}: ${x.value}`)),
        bodyText ? h('pre', { class: 'aw-pre aw-xs aw-mono' }, bodyText.length > 600 ? `${bodyText.slice(0, 600)}…` : bodyText) : ''));
    }
    if (c.members.length) {
      kids.push(h('details', {}, h('summary', { class: 'aw-xs' }, `Source call${c.members.length > 1 ? 's' : ''} (${c.members.length})`),
        ...c.members.map((m) => h('div', { class: 'aw-xs aw-mono aw-wrap' }, `#${m.id} ${m.transport} ${m.method} ${m.url}${m.query.length ? `?${m.query.map(([k, v]) => `${k}=${v}`).join('&')}` : ''} → ${m.status ?? m.outcome}${m.redacted.length ? ` · redacted: ${m.redacted.join(', ')}` : ''}${m.body.kind === 'omitted' ? ` · ${m.body.reason}` : ''}`))));
    }
    return h('li', { class: 'aw-card aw-cp aw-col aw-gap6', 'data-key': `cand-${c.key}`, 'aria-label': `Candidate ${i + 1}: ${e.request.method} ${e.name}` }, ...kids);
  }

  function drawStale() {
    if (!ui) return;
    const stale = isStale();
    ui.stale.hidden = !stale;
    if (stale && !ui.stale.childNodes.length) {
      ui.stale.replaceChildren(h('span', { class: 'aw-wrap aw-grow' }, `The destination changed after this review was built (now ${destination().profile.name}, revision ${destination().revision}). Rebuild the review before importing.`), btn('Rebuild review', rebuild));
    }
    if (!stale) ui.stale.replaceChildren();
    const b = ui.review.querySelector<HTMLButtonElement>('#aw-imp-commit');
    if (b) b.disabled = stale || phase === 'saving';
  }

  function savedCard(): HTMLElement {
    const kids: Node[] = [h('strong', { class: 'aw-wrap', id: 'aw-imp-saved' }, saved!.text)];
    const row = h('div', { class: 'aw-row aw-gap6 aw-wrapbtns' }, btn('Show endpoints', () => kit.go('endpoints')));
    if (saved!.recorderIds.length) row.append(btn('Remove imported calls from the recorder draft', () => {
      rec.remove(saved!.recorderIds);
      kit.announce(`Removed ${saved!.recorderIds.length} call(s) from the recorder draft.`);
      saved = { ...saved!, recorderIds: [] };
      drawReview();
    }, 'aw-btn aw-gh aw-sm'));
    kids.push(row);
    return h('div', { class: 'aw-card aw-cp aw-col aw-gap8' }, ...kids);
  }

  // ---------- commit

  async function commit() {
    const r = review;
    if (!r || phase === 'saving') return;
    if (isStale()) return drawStale();
    const list = r.calls ?? r.drafts;
    if (list && list.dest === 'new' && !list.newName.trim()) return kit.announce('Enter a name for the new profile.');
    const names = r.candidates.filter((c) => c.selected).map((c) => c.endpoint.alias);
    if (new Set(names).size !== names.length) { setPhase('failed', 'Two selected candidates use the same alias. Change one, then import.'); return drawReview(); }
    setPhase('saving');
    drawReview();
    let summary = '';
    let recorderIds: number[] = [];
    try {
      if (list) {
        const sel = r.candidates.filter((c) => c.selected);
        if (list.dest === 'new') {
          const name = list.newName.trim();
          if (s.all().some((a) => a.profile.name.toLowerCase() === name.toLowerCase())) throw new Error(`A profile named "${name}" already exists`);
          const res = applyCandidates(defaultProfile(name), sel);
          const v = validateAggregate(res.agg);
          if (!v.ok) throw new Invalid(v.errors, res.agg);
          o.onProfileChange();
          await s.replaceAll([v.value], v.value.profile.id, 'add', { [v.value.profile.id]: 0 });
          summary = counts(res, `new profile ${name} (now active)`);
        } else {
          let res: Applied | null = null;
          const diags = await s.edit((a) => { res = applyCandidates(a, sel); Object.assign(a, res.agg); }, true);
          if (diags) throw new Invalid(diags, res!.agg);
          summary = counts(res!, s.agg().profile.name);
        }
        if (r.calls?.fromRecorder) recorderIds = sel.flatMap((c) => c.members.map((m) => m.id));
      } else if (r.native) {
        summary = await commitNative(r);
      }
    } catch (e) {
      const why = e instanceof Invalid ? e.describe() : e instanceof Conflict ? `${e.message}. Rebuild the review.` : fail(e);
      setPhase('failed', `Not saved: ${why}. The source, review and selection are kept.`);
      kit.announce(`Import failed: ${why}. Nothing was saved.`);
      drawReview();
      return;
    }
    saved = { text: summary, recorderIds, fromRecorder: !!r.calls?.fromRecorder };
    review = null;
    setPhase('saved');
    drawReview();
    kit.announce(summary);
    ui?.review.querySelector<HTMLElement>('#aw-imp-saved')?.focus();
  }

  async function commitNative(r: Review): Promise<string> {
    const { read, mode } = r.native!;
    const cur = destination();
    if (mode === 'merge') {
      let res: Applied | null = null;
      const diags = await s.edit((a) => { res = mergeNative(a, read.aggs[0]!, r.candidates); Object.assign(a, res.agg); }, true);
      if (diags) throw new Invalid(diags, res!.agg);
      return counts(res!, cur.profile.name) + (res!.notes.length ? ` ${res!.notes.slice(0, 4).join('. ')}.` : '');
    }
    if (mode === 'replace') {
      const next: Aggregate = { ...structuredClone(read.aggs[0]!), revision: cur.revision, profile: { ...structuredClone(read.aggs[0]!.profile), id: cur.profile.id, name: cur.profile.name } };
      const v = validateAggregate(next);
      if (!v.ok) throw new Invalid(v.errors, next);
      o.onProfileChange();
      await s.replaceAll([v.value], cur.profile.id, 'add', { [cur.profile.id]: r.revision });
      return `Replaced ${cur.profile.name}: ${next.endpoints.length} endpoints, ${next.plans.length} plans.`;
    }
    if (mode === 'all') {
      o.onProfileChange();
      await s.replaceAll(read.aggs, read.activeId, 'all', Object.fromEntries(s.all().map((a) => [a.profile.id, a.revision])));
      return `Restored ${read.aggs.length} profile(s); active profile ${s.agg().profile.name}.`;
    }
    const ids = new Set(s.all().map((a) => a.profile.id));
    const names = new Set(s.all().map((a) => a.profile.name.toLowerCase()));
    let activeId = read.activeId;
    const aggs = read.aggs.map((a) => {
      if (!ids.has(a.profile.id) && !names.has(a.profile.name.toLowerCase())) { names.add(a.profile.name.toLowerCase()); return a; }
      let name = `${a.profile.name} (imported)`;
      for (let n = 2; names.has(name.toLowerCase()); n++) name = `${a.profile.name} (imported ${n})`;
      names.add(name.toLowerCase());
      const c = copyAggregate(a, name);
      if (a.profile.id === activeId) activeId = c.profile.id;
      return c;
    });
    if (!aggs.some((a) => a.profile.id === activeId)) activeId = aggs[0]!.profile.id;
    o.onProfileChange();
    await s.replaceAll(aggs, activeId, 'add', Object.fromEntries(aggs.map((a) => [a.profile.id, 0])));
    return `Added ${aggs.map((a) => a.profile.name).join(', ')} · ${aggs.reduce((n, a) => n + a.endpoints.length, 0)} endpoints. Active profile: ${s.agg().profile.name}.`;
  }

  function counts(res: Applied, where: string) {
    return `Saved to ${where}: ${res.added} added, ${res.replaced} replaced, ${res.skipped} skipped (already saved)${res.unresolved ? `, ${res.unresolved} need values before sending` : ''}.`;
  }

  // ---------- exports

  function exportDraft() {
    const day = new Date().toISOString().slice(0, 10);
    if (review?.calls?.fromRecorder) return exportRecorder();
    if (!text) return kit.announce('There is no draft text to export.');
    download(`api-workbench-import-draft-${day}.json`, text);
    kit.announce('Exported the import draft.');
  }
  function exportRecorder() {
    if (!rec.captures().length) return kit.announce('The recorder draft is empty.');
    download(`api-workbench-recording-${new Date().toISOString().slice(0, 10)}.har`, capturesToHar([...rec.captures()], o.version));
    kit.announce(`Exported ${rec.captures().length} recorded call(s) as HAR 1.2 (values already redacted).`);
  }
  function exportCurrent(kind: 'profile' | 'backup') {
    const aggs = kind === 'profile' ? [s.agg()] : s.all();
    download(`api-workbench-${kind === 'profile' ? s.agg().profile.name.replace(/[^\w-]+/g, '_') : 'backup'}-${new Date().toISOString().slice(0, 10)}.json`, exportEnvelope(kind, aggs, s.agg().profile.id, false).text);
    kit.announce(`Exported ${kind === 'profile' ? s.agg().profile.name : 'a backup'} (sensitive values redacted).`);
  }

  // ---------- recorder

  function drawRecorder() {
    if (!ui) return;
    const n = rec.captures().length;
    const on = rec.recording();
    const status = on ? `Recording since ${new Date(rec.startedAt()).toLocaleTimeString()}` : rec.recoveredAt() ? `Recovered draft from ${new Date(rec.recoveredAt()).toLocaleString()} · not recording` : n ? 'Stopped' : 'Not recording';
    const keep = s.agg().profile.settings.recorderSecrets;
    const sig = JSON.stringify([on, n, rec.bytes(), rec.stopReason(), rec.recoveryError(), rec.recoveredAt(), rec.includeTester(), keep]);
    if (ui.rec.dataset.sig === sig) return;
    ui.rec.dataset.sig = sig;
    const refocus = ui.rec.contains(kit.root.activeElement) ? (kit.root.activeElement as HTMLElement).id : '';
    ui.rec.replaceChildren(
      h('div', { class: 'aw-row aw-gap6' }, h('span', { class: `aw-bd ${on ? 'aw-gr' : ''}`, id: 'aw-rec-state' }, on ? h('span', { class: 'aw-dot aw-g' }) : '', status)),
      h('div', { class: 'aw-xs aw-wrap', id: 'aw-rec-count' }, `${n} of ${rec.limit()} calls · ${kib(rec.bytes())} of ${RECORDER.envelopeBytes / 1024 / 1024} MiB`),
      rec.stopReason() ? h('p', { class: 'aw-alert aw-wrap', id: 'aw-rec-reason' }, rec.stopReason()) : '',
      rec.recoveryError() ? h('p', { class: 'aw-alert aw-wrap', id: 'aw-rec-recovery' }, rec.recoveryError()) : '',
      h('div', { class: 'aw-row aw-gap6 aw-wrapbtns' },
        on ? btn([icon('stop', 'aw-i aw-i12'), 'Stop recording'], () => { rec.stop(); kit.announce(`Recording stopped. ${rec.captures().length} call(s) ready to review below.`); autoReview(); }, 'aw-btn aw-out aw-sm', { id: 'aw-rec-stop' })
          : btn([icon('play', 'aw-i aw-i12'), 'Start recording'], () => {
            if (saved?.fromRecorder) { saved = null; drawReview(); } // a new recording starts a new review
            rec.start();
            kit.announce(rec.recording() ? 'Recording. Page calls made from now on are captured.' : rec.stopReason());
          }, 'aw-btn aw-pri aw-sm', { id: 'aw-rec-start' }),
        btn('Review recorded calls', () => reviewRecorded(), 'aw-btn aw-out aw-sm', { id: 'aw-rec-review', disabled: !n }),
        btn('Export as HAR', exportRecorder, 'aw-btn aw-gh aw-sm', { id: 'aw-rec-export', disabled: !n }),
        btn([icon('trash', 'aw-i aw-i12'), 'Reset…'], resetRecorder, 'aw-btn aw-gh aw-sm', { id: 'aw-rec-reset', disabled: !n && !on && !rec.stopReason() })),
      h('div', { class: 'aw-chk' }, checkbox('Include tester traffic', rec.includeTester(), (v) => rec.setIncludeTester(v)), 'Include tester traffic (Test → Once with Apply rules; labelled)'),
      h('div', { class: 'aw-chk aw-top' }, checkbox('Keep secret header values', keep, (v) => void setKeepSecrets(v)),
        h('span', { class: 'aw-col aw-gap2' }, 'Keep secret header values (Authorization, tokens, API keys)',
          h('span', { class: 'aw-xs aw-mu aw-wrap' }, 'Saved with this profile in this browser for this site, so recorded endpoints send as recorded. Applies to calls recorded from now on; exports still leave them out unless you include them.'))),
      ...(on && n ? [liveCalls()] : []),
    );
    if (refocus) kit.root.getElementById(refocus)?.focus();
  }

  /** While recording: the newest captured calls, so it is visible what is being recorded. */
  function liveCalls(): HTMLElement {
    const caps = rec.captures();
    const path = (u: string) => { try { const x = new URL(u); return x.origin === kit.rt.origin ? x.pathname : `${x.host}${x.pathname}`; } catch { return u; } };
    return h('div', { class: 'aw-col aw-gap6' }, h('span', { class: 'aw-cap' }, `Captured calls (newest first${caps.length > 20 ? `, latest 20 of ${caps.length}` : ''})`),
      h('ol', { class: 'aw-card aw-list aw-reclive', 'aria-label': 'Captured calls, newest first' }, ...caps.slice(-20).reverse().map((c) =>
        h('li', { class: 'aw-li aw-gap8' }, methodBadge(c.method), h('span', { class: 'aw-grow aw-tr aw-mono aw-xs', title: c.url }, path(c.url)),
          h('span', { class: `aw-xs ${c.status && c.status < 400 ? 'aw-t-ok' : 'aw-t-bad'}` }, c.status ? String(c.status) : c.outcome)))));
  }

  async function setKeepSecrets(v: boolean) {
    const out = await s.edit((a) => { a.profile.settings.recorderSecrets = v; });
    kit.announce(out ? `Not saved: ${out[0]!.message}` : v ? 'Secret request header values are now kept when recording, for this profile.' : 'Secret request header values are redacted again when recording.');
  }

  /** On Record, a stopped draft is shown as a review (endpoints + destination) without an extra click. Never replaces
   * another pending review, and not right after the recorded calls were imported. */
  function autoReview() {
    if (where !== 'record' || !ui || rec.recording() || !rec.captures().length || review || saved?.fromRecorder) return;
    reviewRecorded(false);
  }

  function reviewRecorded(scroll = true) {
    gen++;
    saved = null;
    sourceName = 'Recorder';
    const caps = [...rec.captures()];
    buildCalls(caps, { source: `Recorder draft (${caps.length} call${caps.length === 1 ? '' : 's'})`, label: 'Recorded calls', notes: [], skipped: [], fromRecorder: true }, review?.calls?.fromRecorder ? review : undefined);
    if (scroll) ui?.review.querySelector<HTMLElement>('#aw-imp-review strong')?.scrollIntoView({ block: 'nearest' });
  }

  async function resetRecorder() {
    const n = rec.captures().length;
    const v = await kit.ask(`Reset the recorder? This stops recording and deletes ${n} recorded call(s) and their recovery copy. Saved profiles and endpoints are not touched.`, [
      { label: 'Cancel', cls: 'aw-out', value: 'cancel' }, { label: 'Reset recorder', cls: 'aw-dst', value: 'reset' },
    ]);
    if (v !== 'reset') return;
    await rec.reset();
    if (review?.calls?.fromRecorder) { review = null; setPhase('empty'); drawReview(); }
    kit.announce('Recorder reset. Saved profiles are unchanged.');
  }

  // ---------- screen

  function screen(): Built {
    const state = h('div', { class: 'aw-col aw-gap4', id: 'aw-imp-state', 'aria-live': 'polite' });
    const ta = textarea(text, (v) => { text = v; edited = true; gen++; if (phase === 'reading') setPhase('empty', 'File read replaced by your edit.'); }, { id: 'aw-imp-text', rows: 5 });
    const reviewEl = h('div', { class: 'aw-col aw-gap8', 'aria-live': 'polite' });
    const recEl = h('div', { class: 'aw-col aw-gap8', id: 'aw-rec' });
    const stale = h('div', { class: 'aw-alert aw-row aw-gap6', id: 'aw-imp-stale', hidden: true });
    ui = { state, text: ta, review: reviewEl, rec: recEl, stale };

    const fileIn = h('input', { type: 'file', accept: '.json,.har,.txt,.sh,.cmd,.bat,.js,application/json,text/plain', class: 'aw-xs', id: 'aw-imp-file', 'aria-label': 'Choose a file to import' });
    fileIn.addEventListener('change', () => {
      const f = fileIn.files?.[0];
      fileIn.value = '';
      if (f) void readFile(f);
    });
    const fmt = select(override, [['auto', 'Detect from content'], ...(Object.entries(FORMAT_NAMES) as [Exclude<Format, 'auto'>, string][])], (v) => { override = v; }, { id: 'aw-imp-format', label: 'Format' });

    where = 'import';
    drawState();
    drawReview();
    return {
      nodes: [
        kit.subbar('import', 'Import'),
        section('Source',
          h('div', { class: 'aw-fieldrow' }, h('div', { class: 'aw-grow' }, field('Format', fmt)), fileButton(fileIn)),
          field('Paste', ta, undefined, undefined, `Up to ${IMPORT_MAX_BYTES / 1024 / 1024} MiB. The format is detected from the content. Importing never runs code, reads a file path, fetches a reference or sends a request.`),
          formatHelp(),
          h('div', { class: 'aw-row aw-gap6 aw-wrapbtns' },
            btn('Apply', () => void apply(edited || !sourceName || sourceName === 'Recorder' ? 'Pasted text' : sourceName), 'aw-btn aw-pri aw-sm', { id: 'aw-imp-apply' }),
            btn('Cancel', cancel, 'aw-btn aw-out aw-sm', { id: 'aw-imp-cancel' }),
            btn('Clear draft', () => { gen++; text = ''; edited = false; sourceName = ''; ta.value = ''; review = null; saved = null; setPhase('empty'); drawReview(); }, 'aw-btn aw-gh aw-sm'),
            btn('Export draft', exportDraft, 'aw-btn aw-gh aw-sm'),
            btn('Look for schema 1 data', () => void lookForV1(), 'aw-btn aw-gh aw-sm')),
          state),
        reviewEl,
      ],
      refresh: () => { if (review) drawStale(); },
    };
  }

  /** Record: the recorder and the review/commit of recorded calls (same review flow as Import). */
  function recordScreen(): Built {
    const reviewEl = h('div', { class: 'aw-col aw-gap8', 'aria-live': 'polite' });
    const recEl = h('div', { class: 'aw-col aw-gap8', id: 'aw-rec' });
    const stale = h('div', { class: 'aw-alert aw-row aw-gap6', id: 'aw-imp-stale', hidden: true });
    ui = { state: h('div', {}), text: textarea('', () => {}), review: reviewEl, rec: recEl, stale };
    where = 'record';
    const scopeEl = h('p', { class: 'aw-hint aw-wrap', id: 'aw-rec-scope' });
    const drawScope = () => { scopeEl.textContent = `Captures ${o.scope().replace(/^Fetch\/XHR/, 'Fetch/XHR calls')} Recording continues while the panel is minimized. Workers and cached responses are not captured. ${s.agg().profile.settings.recorderSecrets ? 'Secret request header values are kept (this profile); secrets in query and JSON fields are still redacted.' : 'Secrets in headers, query and JSON fields are redacted before they are shown or kept.'}`; };
    drawScope();
    drawReview();
    drawRecorder();
    autoReview();
    return {
      nodes: [
        kit.subbar('record', 'Record'),
        section(['record', 'Recorder'],
          scopeEl,
          recEl),
        reviewEl,
      ],
      refresh: () => { drawScope(); drawRecorder(); autoReview(); if (review) drawStale(); },
    };
  }

  return { screen, recordScreen };
}

/** Runtime help: the adapters this build has and the grammar each accepts. */
function formatHelp(): HTMLElement {
  const row = (title: string, text: string, example = '') => h('div', { class: 'aw-col aw-gap2' }, h('strong', { class: 'aw-xs' }, title), h('span', { class: 'aw-xs aw-wrap' }, text), example ? h('pre', { class: 'aw-xs aw-mono aw-wrap' }, example) : '');
  return h('details', { id: 'aw-imp-help' }, h('summary', { class: 'aw-xs' }, 'Supported formats and examples'),
    row('API Workbench', 'Profile export, backup or schema 1 data. New profile, merge or replace.'),
    row('HAR 1.2', 'DevTools Network → Save all as HAR. Same calls with different bodies stay separate.'),
    row('Swagger 2.0 / OpenAPI 3.0 (JSON)', 'Operations, parameters, local $ref, examples and auth hints. Remote refs are not fetched; schema-only values are not invented. YAML and OpenAPI 3.1 are not supported.'),
    row('Postman collection v2.1', 'Folders, enabled headers/query, collection and folder variables, auth inheritance (bearer, basic, API key; noauth stops it), raw/urlencoded/form-data/GraphQL bodies, saved responses. Scripts never run.'),
    row('cURL (bash or Windows cmd)', 'DevTools Copy as cURL. Accepts -X -H -d --data-raw --data-binary --data-urlencode -F -u -b -G -I --compressed; several commands are separate requests. Shell variables, substitutions, pipes and @file reads are refused.', "curl 'https://api.example.com/path' \\\n  -H 'content-type: application/json' \\\n  --data-raw '{\"n\":1}'"),
    row('Copied fetch', 'DevTools Copy as fetch: fetch("url", {…}) with string, number, true/false/null, object and array literals only. Variables, calls, template literals, new and JSON.stringify are refused.', 'fetch("https://api.example.com/path", {\n  "headers": { "content-type": "application/json" },\n  "body": "{\\"n\\":1}",\n  "method": "POST",\n  "credentials": "include"\n});'));
}

/** Validation failure of the would-be result, described by candidate name where possible. */
class Invalid extends Error {
  constructor(readonly diags: Diag[], readonly agg: Aggregate) { super('invalid'); }
  describe(): string {
    return this.diags.slice(0, 4).map((d) => {
      const m = /^endpoints\.(\d+)\.?(.*)$/.exec(d.path);
      const ep = m ? this.agg.endpoints[Number(m[1])] : undefined;
      return ep ? `${ep.name}${m![2] ? ` (${m![2]})` : ''}: ${d.message}` : `${d.path || 'profile'}: ${d.message}`;
    }).join('; ');
  }
}
