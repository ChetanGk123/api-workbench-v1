// Settings: storage state, profiles, body-check limit, export/restore, schema 1 migration and Clear
// local data. Every action is a session command that validates and reports the stored outcome.
import { exportEnvelope, readImport, type ImportRead } from '../data/backup';
import { migrateV1 } from '../data/migrate';
import { BOUNDS, copyAggregate, type Aggregate, type Diag } from '../data/schema';
import { readV1 } from '../data/store';
import { h, icon } from './dom';
import { btn, checkbox, download, field, heading, input, section, textarea, tile, type Built, type Kit } from './kit';

type Review = { source: string; read: ImportRead } | { source: string; errors: Diag[] };

export function createSettingsUi(kit: Kit, o: { version: string; onProfileChange(): void; clearPreferences(): void }) {
  const s = kit.session;
  let sensitive = false;
  let pasted = '';
  let review: Review | null = null;
  let v1State = '';

  const fileName = (what: string) => `api-workbench-${what}-${new Date().toISOString().slice(0, 10)}.json`;
  const fail = (e: unknown) => (e instanceof Error ? e.message : String(e));

  async function guarded(label: string, fn: () => Promise<void>) {
    try { await fn(); } catch (e) {
      kit.announce(`${label} failed: ${fail(e)}. Nothing was changed.`);
      await kit.ask(`${label} failed: ${fail(e)}. Nothing was changed.`, [{ label: 'OK', cls: 'aw-out', value: 'ok' }]);
      return false;
    }
    return true;
  }

  function screen(): Built {
    const storage = h('div', { class: 'aw-col aw-gap6' });
    const profiles = h('div', { class: 'aw-col aw-gap8' });
    const exportPrev = h('p', { class: 'aw-hint aw-wrap', id: 'aw-export-preview' });
    const reviewEl = h('div', { class: 'aw-col aw-gap8', 'aria-live': 'polite' });
    let sig = '';
    let profSig = '';

    const refresh = () => {
      const next = JSON.stringify([s.persist(), s.error(), s.loadIssues()]);
      if (next !== sig) { sig = next; drawStorage(); }
      const p = JSON.stringify([s.all().map((a) => [a.profile.id, a.profile.name, a.endpoints.length]), s.agg().profile.id, s.agg().profile.settings]);
      if (p === profSig) return;
      const refocus = profiles.contains(kit.root.activeElement) ? (kit.root.activeElement as HTMLElement).id || 'aw-prof-select' : null;
      profSig = p;
      drawProfiles();
      drawExportPreview();
      if (refocus) kit.root.getElementById(refocus)?.focus();
    };

    function drawStorage() {
      const p = s.persist();
      const text = { loading: 'Loading…', saved: 'All changes saved', saving: 'Saving…', unsaved: 'Unsaved changes', conflict: 'Changed in another tab', 'session-only': 'Storage unavailable: page session only' }[p];
      storage.replaceChildren(
        h('div', { class: 'aw-row aw-gap6' }, h('span', { class: `aw-bd ${p === 'saved' ? 'aw-gr' : p === 'saving' || p === 'loading' ? '' : 'aw-am'}`, id: 'aw-store-state' }, text)),
        s.error() ? h('p', { class: 'aw-hint aw-wrap' }, s.error()) : '',
        ...s.loadIssues().map((t) => h('p', { class: 'aw-err aw-wrap' }, t)),
        h('p', { class: 'aw-hint aw-wrap' }, `Stored in this browser for ${kit.rt.origin} (IndexedDB api-workbench-v2, schema 2). Readable by this site's scripts; not a secret vault. Browser quota estimates are not a reservation.`),
      );
    }

    function drawProfiles() {
      const cur = s.agg();
      const sel = h('select', { class: 'aw-in aw-select', id: 'aw-prof-select' }, ...s.all().map((a) => h('option', { value: a.profile.id, selected: a.profile.id === cur.profile.id }, `${a.profile.name} · ${a.endpoints.length} endpoint${a.endpoints.length === 1 ? '' : 's'}`)));
      let newName = '';
      let rename = cur.profile.name;
      const limitIn = input(String(cur.profile.settings.bodyCheckKb), () => {}, { mono: true, id: 'aw-set-bodykb' });
      limitIn.inputMode = 'numeric';
      profiles.replaceChildren(
        h('div', { class: 'aw-row aw-gap6 aw-end' },
          h('div', { class: 'aw-grow' }, field('Active profile', sel)),
          btn('Switch', () => switchTo(sel.value), 'aw-btn aw-out aw-sm', { 'aria-label': 'Switch to the selected profile' })),
        h('div', { class: 'aw-row aw-gap6 aw-end' },
          h('div', { class: 'aw-grow' }, field('New profile name', input('', (v) => { newName = v; }, { id: 'aw-prof-new' }))),
          btn('Create empty', () => create(newName, false)), btn('Save copy', () => create(newName, true), 'aw-btn aw-out aw-sm', { 'aria-label': `Save a copy of ${cur.profile.name}` })),
        h('div', { class: 'aw-row aw-gap6 aw-end' },
          h('div', { class: 'aw-grow' }, field('Rename active profile', input(rename, (v) => { rename = v; }, { id: 'aw-prof-rename' }))),
          btn('Rename', async () => {
            const out = await s.rename(rename);
            kit.announce(out ? `Not renamed: ${out[0]!.message}` : `Profile renamed to ${rename.trim()}.`);
          })),
        h('div', { class: 'aw-row aw-gap6 aw-end' },
          h('div', { class: 'aw-grow' }, field(`Body-check limit (KB, ${BOUNDS.bodyCheckKb.min}–${BOUNDS.bodyCheckKb.max})`, limitIn, undefined, undefined, 'Once reads at most this much of a response; checks on a longer body report not evaluated.')),
          btn('Save limit', async () => {
            const n = Number(limitIn.value);
            const out = await s.edit((a) => { a.profile.settings.bodyCheckKb = n; });
            kit.announce(out ? `Not saved: ${out[0]!.message}` : `Body-check limit is ${n} KB.`);
          }),
          btn('Reset', async () => {
            await s.edit((a) => { a.profile.settings.bodyCheckKb = BOUNDS.bodyCheckKb.default; });
            limitIn.value = String(BOUNDS.bodyCheckKb.default);
            kit.announce(`Body-check limit reset to ${BOUNDS.bodyCheckKb.default} KB.`);
          }, 'aw-btn aw-gh aw-sm', { 'aria-label': 'Reset body-check limit' })),
        h('div', { class: 'aw-row' }, btn([icon('trash', 'aw-i aw-i14'), `Delete ${cur.profile.name}`], () => remove(cur), 'aw-btn aw-dst aw-sm')),
      );
    }

    function drawExportPreview() {
      const { redacted } = exportEnvelope('backup', s.all(), s.agg().profile.id, false);
      exportPrev.textContent = sensitive
        ? `Sensitive values are INCLUDED: ${redacted.length ? redacted.join('; ') : 'none found'}. Anyone with the file can read them.`
        : redacted.length ? `Redacted by default (re-entry needed after import): ${redacted.join('; ')}.` : 'No sensitive header values found to redact. Exports contain definitions and source references, never current tokens or keys.';
    }

    function drawReview() {
      if (!review) return reviewEl.replaceChildren();
      if ('errors' in review) {
        return reviewEl.replaceChildren(h('div', { class: 'aw-alert aw-col aw-gap4', id: 'aw-review' }, h('strong', {}, `${review.source}: nothing can be imported`),
          ...review.errors.slice(0, 12).map((d) => h('div', { class: 'aw-wrap' }, d.path ? `${d.path}: ${d.message}` : d.message)),
          review.errors.length > 12 ? h('div', {}, `…and ${review.errors.length - 12} more`) : ''));
      }
      const r = review.read;
      const existing = new Map(s.all().map((a) => [a.profile.id, a]));
      const lines = r.aggs.map((a) => `${a.profile.name}: ${a.endpoints.length} endpoints, ${a.plans.length} plans${a.legacyRules.length ? `, ${a.legacyRules.length} saved rules (kept as data)` : ''}${existing.has(a.profile.id) ? ' · already stored' : ''}`);
      const actions: Node[] = [];
      if (r.kind === 'backup') {
        const removed = s.all().filter((a) => !r.aggs.some((b) => b.profile.id === a.profile.id)).map((a) => a.profile.name);
        actions.push(h('p', { class: 'aw-hint aw-wrap' }, `Restore replaces every stored profile.${removed.length ? ` Removed: ${removed.join(', ')}.` : ''} Export a backup first if you may need the current data.`),
          btn('Replace all profiles with this backup', () => commit('all'), 'aw-btn aw-dst aw-sm'));
      } else {
        actions.push(btn(`Add ${r.aggs.length} profile${r.aggs.length > 1 ? 's' : ''}`, () => commit('add'), 'aw-btn aw-pri aw-sm'),
          h('p', { class: 'aw-hint aw-wrap' }, 'Profiles whose ID or name is already stored are added as renamed copies; nothing existing is overwritten.'));
      }
      reviewEl.replaceChildren(h('div', { class: 'aw-card aw-cp aw-col aw-gap6', id: 'aw-review' },
        h('strong', {}, `${review.source}: ${r.kind === 'backup' ? 'whole backup' : r.kind === 'schema1' ? 'schema 1 data (migrated preview)' : 'profile export'}`),
        ...lines.map((t) => h('div', { class: 'aw-xs aw-mono aw-wrap' }, t)),
        ...r.notes.map((t) => h('div', { class: 'aw-xs aw-mu aw-wrap' }, t)),
        ...actions, btn('Discard review', () => { review = null; drawReview(); }, 'aw-btn aw-gh aw-sm')));
    }

    async function commit(scope: 'all' | 'add') {
      if (!review || 'errors' in review) return;
      const r = review.read;
      let aggs = r.aggs;
      let activeId = r.activeId;
      if (scope === 'add') {
        const ids = new Set(s.all().map((a) => a.profile.id));
        const names = new Set(s.all().map((a) => a.profile.name.toLowerCase()));
        aggs = aggs.map((a) => {
          if (!ids.has(a.profile.id) && !names.has(a.profile.name.toLowerCase())) { names.add(a.profile.name.toLowerCase()); return a; }
          let name = `${a.profile.name} (imported)`;
          for (let n = 2; names.has(name.toLowerCase()); n++) name = `${a.profile.name} (imported ${n})`;
          names.add(name.toLowerCase());
          return copyAggregate(a, name);
        });
        activeId = s.agg().profile.id;
      } else {
        o.onProfileChange();
      }
      const ok = await guarded(scope === 'all' ? 'Restore' : 'Import', () => s.replaceAll(aggs, activeId, scope));
      if (!ok) return;
      kit.announce(scope === 'all'
        ? `Restored ${aggs.length} profile(s); active profile ${s.agg().profile.name}.`
        : `Added ${aggs.map((a) => a.profile.name).join(', ')} · ${aggs.reduce((n, a) => n + a.endpoints.length, 0)} endpoints. Switch to it under Profiles.`);
      review = null;
      drawReview();
      refresh();
    }

    async function switchTo(id: string) {
      if (id === s.agg().profile.id) return kit.announce('That profile is already active.');
      o.onProfileChange();
      if (await guarded('Switch', () => s.switchTo(id))) kit.announce(`Active profile: ${s.agg().profile.name}. Running modules keep their rules (they are not profile data yet).`);
    }

    async function create(name: string, copy: boolean) {
      if (!name.trim()) return kit.announce('Enter a name for the new profile.');
      o.onProfileChange();
      if (await guarded(copy ? 'Save copy' : 'Create', () => s.create(name, copy))) kit.announce(`Profile ${name.trim()} created and active.`);
    }

    async function remove(a: Aggregate) {
      const last = s.all().length === 1;
      const v = await kit.ask(`Delete profile ${a.profile.name}? Its ${a.endpoints.length} endpoint(s), ${a.plans.length} plan(s)${a.legacyRules.length ? ` and ${a.legacyRules.length} saved rule(s)` : ''} are removed from this browser.${last ? ' It is the last profile, so a new empty profile named Default replaces it.' : ''} Export it first if you may need it.`, [
        { label: 'Cancel', cls: 'aw-out', value: 'cancel' }, { label: 'Delete', cls: 'aw-dst', value: 'delete' },
      ]);
      if (v !== 'delete') return;
      o.onProfileChange();
      if (await guarded('Delete', () => s.remove(a.profile.id))) kit.announce(`Deleted ${a.profile.name}. Active profile: ${s.agg().profile.name}.`);
    }

    async function clearAll() {
      const all = s.all();
      const v = await kit.ask(`Clear local data for ${kit.rt.origin}? This deletes ${all.length} profile(s) (${all.map((a) => a.profile.name).join(', ')}) with ${all.reduce((n, a) => n + a.endpoints.length, 0)} endpoint(s) from this version's storage, and the remembered panel position. Other sites and the schema 1 database are not touched. Export all first if you may need them.`, [
        { label: 'Cancel', cls: 'aw-out', value: 'cancel' }, { label: 'Clear local data', cls: 'aw-dst', value: 'clear' },
      ]);
      if (v !== 'clear') return;
      o.onProfileChange();
      if (await guarded('Clear', () => s.clearAll())) {
        o.clearPreferences();
        kit.announce('Local data cleared; a new empty Default profile is active.');
      }
    }

    function exportNow(kind: 'profile' | 'backup') {
      const aggs = kind === 'profile' ? [s.agg()] : s.all();
      const { text, redacted } = exportEnvelope(kind, aggs, s.agg().profile.id, sensitive);
      download(fileName(kind === 'profile' ? s.agg().profile.name.replace(/[^\w-]+/g, '_') : 'backup'), text);
      kit.announce(`Exported ${kind === 'profile' ? `profile ${s.agg().profile.name}` : `${aggs.length} profiles`}${sensitive ? ' including sensitive values' : redacted.length ? ` with ${redacted.length} value(s) redacted` : ''}.`);
    }

    const fileIn = h('input', { type: 'file', accept: '.json,application/json', class: 'aw-xs', id: 'aw-import-file', 'aria-label': 'Choose an export or backup file' });
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files?.[0];
      if (!f) return;
      if (f.size > 10 * 1024 * 1024) { review = { source: f.name, errors: [{ path: '', message: 'File exceeds 10 MiB' }] }; return drawReview(); }
      const r = readImport(await f.text());
      review = r.ok ? { source: f.name, read: r.value } : { source: f.name, errors: r.errors };
      fileIn.value = '';
      drawReview();
    });

    refresh();
    drawReview();
    return {
      nodes: [
        h('div', { class: 'aw-row aw-gap10' }, tile('settings'), heading('Settings')),
        section('Storage', storage),
        section('Profiles', profiles),
        section('Export',
          h('div', { class: 'aw-chk' }, checkbox('Include sensitive header values', sensitive, (v) => { sensitive = v; drawExportPreview(); }), 'Include sensitive header values'),
          exportPrev,
          h('div', { class: 'aw-row aw-gap6 aw-wrapbtns' }, btn('Export active profile', () => exportNow('profile')), btn('Export all profiles (backup)', () => exportNow('backup')))),
        section('Import or restore',
          h('p', { class: 'aw-hint aw-wrap' }, 'Accepts a profile export, a whole backup, or schema 1 JSON. Nothing changes until you confirm the review.'),
          fileIn,
          field('Or paste JSON', textarea(pasted, (v) => { pasted = v; }, { id: 'aw-import-paste', rows: 4 })),
          h('div', { class: 'aw-row' }, btn('Review pasted JSON', () => {
            const r = readImport(pasted);
            review = r.ok ? { source: 'Pasted JSON', read: r.value } : { source: 'Pasted JSON', errors: r.errors };
            drawReview();
          })),
          reviewEl),
        section('Schema 1 data',
          h('p', { class: 'aw-hint aw-wrap', id: 'aw-v1-state' }, v1State || 'Profiles saved by the previous version on this site can be migrated. The old database is only read and stays unchanged.'),
          h('div', { class: 'aw-row' }, btn('Look for schema 1 data', async () => {
            const raw = await readV1(kit.rt.origin);
            const el = kit.root.getElementById('aw-v1-state');
            if (!raw) { v1State = 'No schema 1 data is stored for this site.'; if (el) el.textContent = v1State; return; }
            const m = migrateV1(raw);
            v1State = 'Schema 1 data found. Review the migrated profiles below; the old database is left as it is.';
            if (el) el.textContent = v1State;
            review = m.ok ? { source: 'Schema 1 database', read: { kind: 'schema1', aggs: m.value.aggregates, activeId: m.value.activeId, notes: m.value.notes } } : { source: 'Schema 1 database', errors: m.errors };
            drawReview();
            kit.root.getElementById('aw-review')?.scrollIntoView({ block: 'nearest' });
          }))),
        section('Clear local data',
          h('p', { class: 'aw-hint aw-wrap' }, 'Deletes this version’s profiles for this site and the panel position, then starts an empty Default profile.'),
          h('div', { class: 'aw-row' }, btn([icon('trash', 'aw-i aw-i14'), 'Clear local data…'], clearAll, 'aw-btn aw-dst aw-sm'))),
        section('About', h('dl', { class: 'aw-dl' }, h('dt', {}, 'Version'), h('dd', { class: 'aw-mono' }, o.version), h('dt', {}, 'Site'), h('dd', { class: 'aw-mono' }, kit.rt.origin), h('dt', {}, 'Data'), h('dd', { class: 'aw-mono' }, 'schema 2'))),
      ],
      refresh,
    };
  }

  return { screen };
}
