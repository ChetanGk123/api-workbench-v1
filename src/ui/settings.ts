// Settings: storage state, profiles, body-check limit, export/restore, schema 1 migration and Clear
// local data. Every action is a session command that validates and reports the stored outcome.
import { exportEnvelope } from '../data/backup';
import { BOUNDS, type Aggregate } from '../data/schema';
import { h, icon } from './dom';
import { btn, checkbox, download, field, heading, input, section, tile, type Built, type Kit } from './kit';

export function createSettingsUi(kit: Kit, o: { version: string; onProfileChange(): void; clearPreferences(): void }) {
  const s = kit.session;
  let sensitive = false;

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

    refresh();
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
          h('p', { class: 'aw-hint aw-wrap' }, 'Profile exports, whole backups, schema 1 data and HAR files are reviewed and imported under Import. Nothing changes until you confirm the review.'),
          h('div', { class: 'aw-row' }, btn([icon('import', 'aw-i aw-i14'), 'Open Import'], () => kit.go('import')))),
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
