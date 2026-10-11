// Settings: storage state, profiles, modules, limits/capture, export/restore, Clear local data and
// About with the data-only update check. Every action is a session command that validates and
// reports the stored outcome.
import { exportEnvelope } from '../data/backup';
import { BOUNDS, defaultSettings, HIDEABLE, type Aggregate, type Hideable, type Settings } from '../data/schema';
import { checkForUpdate, type UpdateResult } from '../data/update';
import { h, icon } from './dom';
import { btn, checkbox, download, field, heading, input, section, tile, type Built, type Kit } from './kit';

export const UPDATE_KEY = 'api-workbench:update:v1';
const HIDE_LABEL: Record<Hideable, string> = { mock: 'Mock', intercept: 'Intercept (and breakpoints)', route: 'Route', chaos: 'Chaos', recorder: 'Recorder' };

export function createSettingsUi(kit: Kit, o: { version: string; updateUrl: string; onProfileChange(): void; clearPreferences(): Promise<void> }) {
  const s = kit.session;
  let sensitive = false;
  // Update state lives across screen rebuilds; a check started earlier never overwrites a later one.
  let checkNo = 0;
  let update: UpdateResult | { kind: 'checking' } | null = null;
  let copyOutcome = '';
  let checking: AbortController | null = null;
  const lastKnown = (): { version: string; checkedAt: number } | null => {
    try {
      const v = JSON.parse(localStorage.getItem(UPDATE_KEY) ?? 'null') as unknown;
      return v && typeof (v as { version?: unknown }).version === 'string' && typeof (v as { checkedAt?: unknown }).checkedAt === 'number' ? v as { version: string; checkedAt: number } : null;
    } catch { return null; }
  };

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
    const modules = h('div', { class: 'aw-col aw-gap6', id: 'aw-modules' });
    const limits = h('div', { class: 'aw-col aw-gap8', id: 'aw-limits' });
    const about = h('div', { class: 'aw-col aw-gap8', id: 'aw-about' });
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
      drawModules();
      drawLimits();
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
        h('div', { class: 'aw-row' }, btn([icon('trash', 'aw-i aw-i14'), `Delete ${cur.profile.name}`], () => remove(cur), 'aw-btn aw-dst aw-sm')),
      );
    }

    function drawModules() {
      const st = s.agg().profile.settings;
      modules.replaceChildren(
        h('p', { class: 'aw-hint aw-wrap aw-m0' }, 'A hidden module has no tab or Home card and no effect on traffic: hiding a rule module deactivates it, and hiding the recorder stops recording (its draft is kept). Saved with this profile.'),
        ...HIDEABLE.map((m) => h('div', { class: 'aw-chk' }, checkbox(`Show ${HIDE_LABEL[m]}`, !st.hidden.includes(m), (v) => void setHidden(m, !v)), `Show ${HIDE_LABEL[m]}`)),
      );
    }
    async function setHidden(m: Hideable, hide: boolean) {
      const out = await s.edit((a) => {
        const set = new Set(a.profile.settings.hidden);
        if (hide) set.add(m); else set.delete(m);
        a.profile.settings.hidden = HIDEABLE.filter((x) => set.has(x));
      });
      kit.announce(out ? `Not saved: ${out[0]!.message}` : `${HIDE_LABEL[m]} ${hide ? 'hidden' : 'shown'}.`);
    }

    function drawLimits() {
      const st = s.agg().profile.settings;
      const num = (id: string, v: number) => { const el = input(String(v), () => {}, { mono: true, id }); el.inputMode = 'numeric'; return el; };
      const body = num('aw-set-bodykb', st.bodyCheckKb);
      const records = num('aw-set-records', st.activityRecords);
      const calls = num('aw-set-calls', st.recorderCalls);
      const roots = input(st.contextRoots.join(', '), () => {}, { mono: true, id: 'aw-set-roots', placeholder: 'e.g. appConfig, __STATE__' });
      const d = defaultSettings();
      const b = BOUNDS;
      limits.replaceChildren(
        h('div', { class: 'aw-col aw-gap8' },
          field(`Body-check limit (KB, ${b.bodyCheckKb.min}–${b.bodyCheckKb.max})`, body, undefined, undefined, 'Once and runs read at most this much of a response; checks on a longer body report not evaluated.'),
          field(`Activity records kept (${b.activityRecords.min}–${b.activityRecords.max})`, records, undefined, undefined, 'Recent activity and module traffic lists. Lowering it drops the oldest records now.'),
          field(`Recorder call limit (${b.recorderCalls.min}–${b.recorderCalls.max})`, calls, undefined, undefined, 'Recording stops at this many calls or at the 1 MiB draft limit. A lower limit never deletes calls already in the draft.'),
          field(`Context roots (up to ${b.contextRoots})`, roots, undefined, undefined, 'Global names Auth & context → Scan page offers. Never scanned until you click Scan.')),
        h('div', { class: 'aw-chk' }, checkbox('Recorder reads response bodies', st.responseBodies, (v) => void saveSettings({ responseBodies: v }, v ? 'Recorder reads bounded response previews.' : 'Recorder keeps response metadata only; bodies are not read.')), 'Recorder reads response bodies (16 KiB preview; off = no body read at all)'),
        h('div', { class: 'aw-chk' }, checkbox('Keep a recorder recovery copy', st.recorderRecovery, (v) => void saveSettings({ recorderRecovery: v }, v ? 'Recorder drafts are kept for recovery after a reload.' : 'Recorder recovery copy removed; drafts now live only in this tab.')), 'Keep a recorder recovery copy (this site’s storage, redacted)'),
        h('div', { class: 'aw-row aw-gap6 aw-wrapbtns' },
          btn('Save limits', () => void saveSettings({
            bodyCheckKb: Number(body.value), activityRecords: Number(records.value), recorderCalls: Number(calls.value),
            contextRoots: roots.value.split(',').map((x) => x.trim()).filter(Boolean),
          }, 'Limits saved.'), 'aw-btn aw-pri aw-sm', { id: 'aw-set-save' }),
          btn('Reset to defaults', () => void saveSettings({ bodyCheckKb: d.bodyCheckKb, activityRecords: d.activityRecords, recorderCalls: d.recorderCalls, responseBodies: d.responseBodies, recorderRecovery: d.recorderRecovery, contextRoots: d.contextRoots },
            `Limits reset: body-check ${d.bodyCheckKb} KB, ${d.activityRecords} records, ${d.recorderCalls} recorder calls, bodies and recovery on, no context roots. Module visibility is unchanged.`), 'aw-btn aw-gh aw-sm', { 'aria-label': 'Reset limits and capture to defaults' })),
      );
    }
    async function saveSettings(patch: Partial<Settings>, ok: string) {
      const out = await s.edit((a) => { a.profile.settings = { ...a.profile.settings, ...patch }; });
      if (out) { kit.announce(`Not saved: ${out.map((e) => `${e.path.split('.').pop()}: ${e.message}`).join('; ')}`); profSig = ''; refresh(); return; }
      kit.announce(ok);
    }

    function drawAbout() {
      const last = lastKnown();
      const u = update;
      const rows: (Node | string)[] = [
        h('dt', {}, 'Running version'), h('dd', { class: 'aw-mono', id: 'aw-about-version' }, o.version),
        h('dt', {}, 'Site'), h('dd', { class: 'aw-mono' }, kit.rt.origin),
        h('dt', {}, 'Data'), h('dd', { class: 'aw-mono' }, 'IndexedDB api-workbench-v2 · schema 2 · this site only'),
        h('dt', {}, 'Update address'), h('dd', { class: 'aw-mono aw-wrap' }, o.updateUrl || 'none in this build'),
        h('dt', {}, 'Last known published'), h('dd', { class: 'aw-mono', id: 'aw-about-last' }, last ? `${last.version} (checked ${new Date(last.checkedAt).toLocaleString()})` : 'not checked'),
      ];
      const out: (Node | string)[] = [];
      if (u?.kind === 'checking') out.push(h('p', { class: 'aw-hint' }, 'Checking…'));
      else if (u?.kind === 'error') out.push(h('p', { class: 'aw-err aw-wrap' }, `Update check failed: ${u.message}. Nothing was changed. You can reinstall from the installer page instead.`));
      else if (u?.kind === 'current') out.push(h('p', { class: 'aw-hint aw-wrap' }, `You are running the published version ${u.manifest.version}.`));
      else if (u?.kind === 'older') out.push(h('p', { class: 'aw-hint aw-wrap' }, `The published version ${u.manifest.version} is older than this one (${o.version}). Nothing to update.`));
      else if (u?.kind === 'newer') {
        out.push(
          h('p', { class: 'aw-alert aw-wrap' }, `Version ${u.manifest.version} is published (${u.bookmark.length.toLocaleString('en')} characters, SHA-256 ${u.manifest.bookmarkSha256.slice(0, 12)}…, verified). It has not been run or installed.`),
          h('div', { class: 'aw-row aw-gap6 aw-wrapbtns' }, btn('Copy new bookmarklet', () => void copy(u.bookmark, u.manifest.version), 'aw-btn aw-pri aw-sm', { id: 'aw-update-copy' })),
          h('ol', { class: 'aw-hint aw-wrap aw-m0' },
            h('li', {}, 'Copy the new bookmarklet.'),
            h('li', {}, 'Right-click your saved API Workbench bookmark → Edit, and replace its whole URL with the copied text.'),
            h('li', {}, 'Close this panel (or reload the page), then click the bookmark. Settings → About should then show the new version.')),
        );
        if (copyOutcome) out.push(h('p', { class: 'aw-hint aw-wrap', id: 'aw-update-outcome', role: 'status' }, copyOutcome));
        if (copyOutcome.startsWith('Clipboard refused')) {
          const ta = h('textarea', { class: 'aw-in aw-mono aw-xs', rows: '3', readonly: true, id: 'aw-update-text', 'aria-label': 'New bookmarklet text' });
          ta.value = u.bookmark;
          out.push(ta);
        }
      }
      about.replaceChildren(
        h('dl', { class: 'aw-dl' }, ...rows),
        h('p', { class: 'aw-hint aw-wrap' }, 'Check reads two data files from the update address when you click it: never in the background, never run. Copying does not install anything; you replace the saved bookmark yourself.'),
        h('div', { class: 'aw-row aw-gap6' }, btn('Check for update', () => void check(), 'aw-btn aw-out aw-sm', { id: 'aw-update-check', disabled: !o.updateUrl || u?.kind === 'checking' })),
        ...out,
      );
    }
    async function check() {
      const n = ++checkNo;
      update = { kind: 'checking' };
      copyOutcome = '';
      drawAbout();
      const ctl = checking = new AbortController();
      const release = kit.rt.own(() => ctl.abort(new DOMException('Workbench closed', 'AbortError')));
      const r = await checkForUpdate(kit.fetchers.direct, o.updateUrl, o.version, ctl.signal);
      release();
      if (n !== checkNo || kit.rt.inert) return; // cleared state or closed UI owns no result
      checking = null;
      update = r;
      if (r.kind !== 'error') try { localStorage.setItem(UPDATE_KEY, JSON.stringify({ version: r.manifest.version, checkedAt: Date.now() })); } catch { /* shown as not checked */ }
      drawAbout();
      kit.announce(r.kind === 'error' ? `Update check failed: ${r.message}` : r.kind === 'newer' ? `Version ${r.manifest.version} is available. Copy it, then replace your saved bookmark.` : r.kind === 'current' ? 'You have the published version.' : 'The published version is older than this one.');
    }
    async function copy(text: string, version: string) {
      try {
        await navigator.clipboard.writeText(text);
        copyOutcome = `Copied ${version} to the clipboard. Not installed yet: replace the saved bookmark's URL with it, then reload and click the bookmark.`;
      } catch (e) {
        copyOutcome = `Clipboard refused (${e instanceof Error ? e.message : String(e)}). Select the text below and copy it, or reinstall from the installer page.`;
      }
      drawAbout();
      kit.announce(copyOutcome);
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
      const v = await kit.ask(`Delete profile ${a.profile.name}? Its ${a.endpoints.length} endpoint(s), ${a.plans.length} plan(s)${a.rules.length ? ` and ${a.rules.length} rule(s)` : ''} are removed from this browser.${last ? ' It is the last profile, so a new empty profile named Default replaces it.' : ''} Export it first if you may need it.`, [
        { label: 'Cancel', cls: 'aw-out', value: 'cancel' }, { label: 'Delete', cls: 'aw-dst', value: 'delete' },
      ]);
      if (v !== 'delete') return;
      o.onProfileChange();
      if (await guarded('Delete', () => s.remove(a.profile.id))) kit.announce(`Deleted ${a.profile.name}. Active profile: ${s.agg().profile.name}.`);
    }

    async function clearAll() {
      const all = s.all();
      const v = await kit.ask(`Clear local data for ${kit.rt.origin}? This deletes ${all.length} profile(s) (${all.map((a) => a.profile.name).join(', ')}) with ${all.reduce((n, a) => n + a.endpoints.length, 0)} endpoint(s), run history, the recorder draft and recovery copy, activity, update state and the remembered panel position. Other sites and the schema 1 database are not touched. Export all first if you may need them.`, [
        { label: 'Cancel', cls: 'aw-out', value: 'cancel' }, { label: 'Clear local data', cls: 'aw-dst', value: 'clear' },
      ]);
      if (v !== 'clear') return;
      o.onProfileChange();
      if (await guarded('Clear', () => s.clearAll())) {
        ++checkNo; // a pending update must not restore cleared state
        checking?.abort();
        checking = null;
        update = null;
        copyOutcome = '';
        await o.clearPreferences();
        drawAbout();
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
    drawAbout();
    return {
      nodes: [
        h('div', { class: 'aw-row aw-gap10' }, tile('settings'), heading('Settings')),
        section('Storage', storage),
        section('Profiles', profiles),
        section('Modules', modules),
        section('Limits and capture', limits),
        section('Export',
          h('div', { class: 'aw-chk' }, checkbox('Include sensitive header values', sensitive, (v) => { sensitive = v; drawExportPreview(); }), 'Include sensitive header values'),
          exportPrev,
          h('div', { class: 'aw-row aw-gap6 aw-wrapbtns' }, btn('Export active profile', () => exportNow('profile')), btn('Export all profiles (backup)', () => exportNow('backup')))),
        section('Import or restore',
          h('p', { class: 'aw-hint aw-wrap' }, 'Profile exports, whole backups, schema 1 data and HAR files are reviewed and imported under Import. Nothing changes until you confirm the review.'),
          h('div', { class: 'aw-row' }, btn([icon('import', 'aw-i aw-i14'), 'Open Import'], () => kit.go('import')))),
        section('Clear local data',
          h('p', { class: 'aw-hint aw-wrap' }, 'Deletes this version’s profiles, runs, recorder draft, activity and preferences for this site, then starts an empty Default profile.'),
          h('div', { class: 'aw-row' }, btn([icon('trash', 'aw-i aw-i14'), 'Clear local data…'], clearAll, 'aw-btn aw-dst aw-sm'))),
        section('About', about),
      ],
      refresh,
    };
  }

  return { screen };
}
