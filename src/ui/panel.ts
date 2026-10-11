// Workbench panel following design/reference/screens: title bar, six module tabs, Home cards,
// rule modules (Mock/Intercept/Route/Chaos), traffic lists, request detail and the minimized launcher.
import type { Module } from '../net/plan';
import type { ReqRecord, Runtime } from '../net/runtime';
import type { Session } from '../data/store';
import { h, icon, type IconName } from './dom';
import { createRecorder } from '../data/recorder';
import { createEndpointsUi } from './endpoints';
import { createImportUi } from './importer';
import { clampPos, GEOMETRY_KEY, MIN_SIZE, readGeometry, writeGeometry, type Pos } from './geometry';
import { checkbox, countBadge, heading, methodBadge, NAME, tile, type Built, type Form, type Kit, type Ret, type Screen } from './kit';
import { createPausesUi } from './pauses';
import { createRulesUi, MOD } from './rules';
import { createSettingsUi, UPDATE_KEY } from './settings';
import { createTestUi } from './test';
import themeCss from '../../design/reference/aw-theme.css';
import panelCss from './panel.css';

export interface Panel {
  restore(): void;
  notice(text: string): void;
  destroy(): void;
}

const TABS: { id: Screen; label: string; icon: IconName }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'test', label: 'Test', icon: 'flask' },
  { id: 'mock', label: 'Mock', icon: 'server' },
  { id: 'intercept', label: 'Intercept', icon: 'shuffle' },
  { id: 'route', label: 'Route', icon: 'route' },
  { id: 'chaos', label: 'Chaos', icon: 'flame' },
];
const RULE_SCREENS = new Set<Screen>(['mock', 'intercept', 'route', 'chaos']);
const SHOWN = 50;
const STEP = 16;

export function mountPanel(rt: Runtime, opts: { version: string; session: Session; fetchers: Kit['fetchers']; onClose(): void }): Panel {
  const session = opts.session;
  const life = new AbortController();
  const on = <E extends Event = Event>(el: EventTarget, type: string, fn: (e: E) => void) => el.addEventListener(type, fn as EventListener, { signal: life.signal });

  const host = document.createElement('div');
  host.setAttribute('data-api-workbench', opts.version);
  for (const [k, v] of [['all', 'initial'], ['position', 'fixed'], ['top', '16px'], ['left', '16px'], ['z-index', '2147483647']]) host.style.setProperty(k!, v!);
  const root = host.attachShadow({ mode: 'open' });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(themeCss + '\n' + panelCss);
    root.adoptedStyleSheets = [sheet];
  } catch {
    root.append(h('style', {}, themeCss + '\n' + panelCss));
  }

  // ---------- view state
  let screen: Screen = 'home';
  /** Open draft workspace (rule, endpoint, headers, environments…) with the shared dirty guard. */
  let form: Form | null = null;
  let live: (() => void) | null = null;
  let follow = true;
  let filterText = '';
  let detailId = 0;
  let detailRet: Ret | null = null;
  /** Where Back from the pause workspace goes; an open editor is kept aside, never discarded. */
  let pausesBack: { ret: Ret; form: Form | null } | null = null;
  let lastFocus: HTMLElement | null = null;

  // ---------- chrome
  const iconBtn = (name: IconName, label: string) => h('button', { class: 'aw-btn aw-gh aw-ic aw-sm', type: 'button', 'aria-label': label, title: label }, icon(name));
  const indicators = h('span', { class: 'aw-row aw-inds' });
  const moveBtn = h('button', { class: 'aw-logo aw-move', type: 'button', 'data-move': true, 'aria-label': 'Move panel: arrow keys move, Shift+arrow keys resize', title: 'Drag to move · arrow keys move · Shift+arrows resize' }, icon('bolt', 'aw-i aw-i14'));
  const settingsBtn = iconBtn('settings', 'Settings');
  const importBtn = iconBtn('import', 'Import');
  const minimizeBtn = iconBtn('minus', 'Minimize');
  const closeBtn = iconBtn('x', 'Close API Workbench and remove its hooks');
  const profBtn = h('button', { class: 'aw-sel aw-profsel', type: 'button', id: 'aw-profile-name' });
  const header = h('header', { class: 'aw-tb' },
    moveBtn,
    h('div', { class: 'aw-brand', title: `API Workbench ${opts.version} · ${rt.origin}` }, 'API Workbench'),
    indicators, h('div', { class: 'aw-grow' }), profBtn, settingsBtn, importBtn, minimizeBtn, closeBtn);

  const tabBtns = new Map<Screen, { btn: HTMLButtonElement; dot: HTMLElement }>();
  const tl = h('div', { class: 'aw-tl' });
  for (const t of TABS) {
    const dot = h('span', { class: 'aw-d aw-dg', hidden: true });
    const btn = h('button', { class: 'aw-tt', type: 'button' }, icon(t.icon, 'aw-i aw-i14'), h('span', { class: 'aw-tlabel' }, t.label), dot);
    on(btn, 'click', () => go(t.id));
    tabBtns.set(t.id, { btn, dot });
    tl.append(btn);
  }
  const nav = h('nav', { class: 'aw-tabs', 'aria-label': 'Modules' }, tl);
  const noticeEl = h('div', { class: 'aw-alert aw-notice', role: 'status', hidden: true });
  const saveBanner = h('div', { class: 'aw-alert aw-notice aw-row aw-gap6', role: 'status', id: 'aw-save-banner', hidden: true });
  const main = h('main', { class: 'aw-body' });
  const foot = h('footer', { class: 'aw-foot', hidden: true });
  const panel = h('div', { class: 'aw-root aw-panel', role: 'region', 'aria-label': 'API Workbench' }, header, nav, noticeEl, saveBanner, main, foot);
  const status = h('div', { class: 'aw-sr', role: 'status', 'aria-live': 'polite' });

  // Launcher (Minimized.html)
  const launchInds = h('div', { class: 'aw-row aw-gap2' });
  const restoreBtn = iconBtn('restore', 'Restore API Workbench');
  const launcherClose = iconBtn('x', 'Close API Workbench and remove its hooks');
  const launcherState = h('span', { class: 'aw-xs aw-mu' });
  const launcher = h('div', { class: 'aw-root aw-launcher', role: 'region', 'aria-label': 'API Workbench minimized', hidden: true },
    h('div', { class: 'aw-logo' }, icon('bolt', 'aw-i aw-i14')), h('span', { class: 'aw-brand' }, 'AW'), launchInds, launcherState,
    h('div', { class: 'aw-grow' }), h('div', { class: 'aw-vsep' }), restoreBtn, launcherClose);

  const dialog = h('dialog', { class: 'aw-dialog', 'aria-labelledby': 'aw-dialog-text' });
  root.append(panel, launcher, dialog, status);
  document.documentElement.append(host);

  on(settingsBtn, 'click', () => go('settings'));
  on(profBtn, 'click', () => go('settings'));
  on(importBtn, 'click', () => go('import'));
  on(minimizeBtn, 'click', minimize);
  on(restoreBtn, 'click', () => restore());
  on(closeBtn, 'click', () => guard(opts.onClose));
  on(launcherClose, 'click', () => {
    if (dirty()) restore(); // show the draft the decision is about
    guard(opts.onClose);
  });
  on(panel, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && form && screen !== 'detail' && !dialog.open) {
      // Prevent the browser's Escape default from closing the dialog we are about to open.
      e.preventDefault();
      e.stopPropagation();
      setTimeout(leaveForm);
    }
  });
  for (const region of [main, foot]) on(region, 'focusin', (e: FocusEvent) => { lastFocus = e.target as HTMLElement; });

  // ---------- geometry: preferences per origin, always clamped to the current viewport
  const geo = readGeometry();
  let storageWarned = false;
  const saveGeo = () => {
    if (writeGeometry(geo) || storageWarned) return;
    storageWarned = true;
    announce('Panel position is kept for this page session only: page storage is unavailable.');
  };
  const viewport = () => ({ vw: document.documentElement.clientWidth || innerWidth, vh: document.documentElement.clientHeight || innerHeight });
  /** Apply stored size/position to whichever surface is visible; returns the clamped position. */
  function place(): Pos {
    const mini = !launcher.hidden;
    const el = mini ? launcher : panel;
    if (!mini) {
      panel.style.width = geo.size ? `${geo.size.w}px` : '';
      panel.style.height = geo.size ? `${geo.size.h}px` : '';
    }
    const r = el.getBoundingClientRect();
    const { vw, vh } = viewport();
    const p = clampPos((mini ? geo.launcher : geo.panel) ?? { x: vw - r.width - 16, y: 16 }, r.width, r.height, vw, vh);
    host.style.left = `${p.x}px`;
    host.style.top = `${p.y}px`;
    return p;
  }
  function draggable(handle: HTMLElement, key: 'panel' | 'launcher') {
    on(handle, 'pointerdown', (e: PointerEvent) => {
      if (e.button !== 0 || (e.target as Element).closest('button:not([data-move]),input,select,textarea')) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY;
      const start = { x: parseFloat(host.style.left), y: parseFloat(host.style.top) };
      handle.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        geo[key] = { x: start.x + ev.clientX - sx, y: start.y + ev.clientY - sy };
        geo[key] = place();
      };
      const end = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        saveGeo();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
  }
  draggable(header, 'panel');
  draggable(launcher, 'launcher');
  const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  on(moveBtn, 'keydown', (e: KeyboardEvent) => {
    const d = ARROWS[e.key];
    if (!d) return;
    e.preventDefault();
    if (e.shiftKey) {
      const r = panel.getBoundingClientRect();
      geo.size = { w: Math.max(MIN_SIZE.w, Math.round(r.width) + d[0] * STEP), h: Math.max(MIN_SIZE.h, Math.round(r.height) + d[1] * STEP) };
    } else {
      geo.panel = { x: parseFloat(host.style.left) + d[0] * STEP, y: parseFloat(host.style.top) + d[1] * STEP };
    }
    geo.panel = place();
    saveGeo();
  });
  // Native CSS resize grip: keep the user's size as the preference.
  const ro = new ResizeObserver(() => {
    if (panel.hidden || !panel.style.width || !panel.style.height) return;
    const w = parseFloat(panel.style.width), hh = parseFloat(panel.style.height);
    if (geo.size?.w === w && geo.size.h === hh) return;
    geo.size = { w: Math.max(MIN_SIZE.w, w), h: Math.max(MIN_SIZE.h, hh) };
    saveGeo();
  });
  ro.observe(panel);
  on(window, 'resize', () => place());

  // ---------- config helpers
  function announce(text: string) { status.textContent = text; }
  const activeModules = () => rulesUi.activeModules();
  /** The tab that owns the current view (an editor or request detail belongs to where it was opened). */
  const owner = (): Screen => form ? form.owner : screen === 'detail' ? detailRet?.screen ?? 'home' : screen === 'pauses' ? 'intercept' : screen;

  // ---------- navigation and draft guard
  /** Settings, Import and Endpoints open with a sub-bar whose Back returns here (module tabs stay: G22). */
  const SUB = new Set<Screen>(['settings', 'import', 'endpoints']);
  let subBack: Screen = 'home';
  function go(next: Screen) {
    if (screen === 'pauses' && pausesBack?.form) { form = pausesBack.form; pausesBack = null; } // its draft decision comes first
    guard(() => {
      if (SUB.has(next) && !SUB.has(owner())) subBack = owner();
      form = null;
      screen = next;
      render();
    });
  }

  /** Snapshot of the current view, used as a return destination. */
  function here(): Ret {
    const focused = root.activeElement?.closest?.('[data-key]');
    return {
      screen: owner(),
      scroll: main.scrollTop,
      listScroll: main.querySelector('.aw-traffic')?.scrollTop ?? 0,
      focus: focused?.getAttribute('data-key') ?? null,
    };
  }

  /** Return to a snapshot. Does not touch an open editor: Back from request detail keeps a Route draft. */
  function goBack(r: Ret, focus = r.focus) {
    screen = r.screen;
    render(false);
    main.scrollTop = r.scroll;
    const list = main.querySelector('.aw-traffic');
    if (list && !follow) list.scrollTop = r.listScroll;
    const target = focus && main.querySelector<HTMLElement>(`[data-key="${focus}"]`);
    if (target) target.focus();
    else main.querySelector<HTMLElement>('[data-focus]')?.focus();
    if (focus && !target && focus.startsWith('req-')) announce('That request is not shown in the current list.');
  }

  function leaveForm() {
    const f = form;
    if (f) guard(() => { form = null; goBack(f.ret); });
  }

  function dirty() {
    return !!form?.dirty();
  }

  function guard(next: () => void) {
    if (!dirty()) return next();
    const f = form!;
    ask('These changes are not saved.', [
      { label: 'Keep editing', cls: 'aw-out', value: 'keep' },
      { label: 'Discard', cls: 'aw-dst', value: 'discard' },
      { label: 'Save', cls: 'aw-pri', value: 'save' },
    ]).then(async (v) => {
      if (v === 'discard') {
        form = null;
        next();
      } else if (v === 'save' && await f.save()) {
        form = null;
        next();
      }
    });
  }

  function ask(text: string, choices: { label: string; cls: string; value: string }[]): Promise<string> {
    const back = root.activeElement as HTMLElement | null;
    return new Promise((resolve) => {
      const onCancel = (e: Event) => { e.preventDefault(); done(choices[0]!.value); };
      const done = (v: string) => {
        dialog.removeEventListener('cancel', onCancel);
        dialog.close();
        back?.focus();
        resolve(v);
      };
      dialog.replaceChildren(
        h('p', { id: 'aw-dialog-text', class: 'aw-dialog-text' }, text),
        h('div', { class: 'aw-row aw-end' }, ...choices.map((c) => {
          const b = h('button', { class: `aw-btn aw-sm ${c.cls}`, type: 'button' }, c.label);
          b.addEventListener('click', () => done(c.value), { once: true });
          return b;
        })),
      );
      dialog.addEventListener('cancel', onCancel);
      dialog.showModal();
      (dialog.querySelector('button') as HTMLElement).focus();
    });
  }

  // ---------- render
  /** Rebuild the current screen. `focusHeading` is for deliberate navigation; Back restores its own focus. */
  function render(focusHeading = true) {
    live = null;
    lastFocus = null;
    foot.replaceChildren();
    foot.hidden = true;
    const built = form ? form.build()
      : screen === 'home' ? homeScreen()
      : screen === 'test' ? testUi.screen()
      : screen === 'endpoints' ? endpointsUi.screen()
      : screen === 'settings' ? settingsUi.screen()
      : screen === 'import' ? importUi.screen()
      : screen === 'pauses' ? pausesUi.screen(backFromPauses, pausesBack?.ret.screen ?? 'intercept')
      : screen === 'intercept' ? interceptScreen()
      : RULE_SCREENS.has(screen) ? rulesUi.screen(screen as Module)
      : detailScreen();
    main.replaceChildren(...built.nodes);
    live = built.refresh ?? null;
    main.scrollTop = 0;
    refreshChrome();
    live?.();
    if (focusHeading) (main.querySelector('[data-focus]') as HTMLElement | null)?.focus();
  }

  function refreshChrome() {
    const act = activeModules();
    const current = owner();
    settingsBtn.classList.toggle('aw-on', current === 'settings');
    importBtn.classList.toggle('aw-on', current === 'import');
    for (const [id, { btn, dot }] of tabBtns) {
      const isOn = id === current;
      btn.classList.toggle('aw-on', isOn);
      isOn ? btn.setAttribute('aria-current', 'page') : btn.removeAttribute('aria-current');
      dot.hidden = !act.includes(id as Module);
    }
    const recording = recorder.recording();
    const paused = pausesUi.waiting().length;
    const running = testUi.runs.running();
    const pauseBtn = (cls: string) => {
      const b = h('button', { class: cls, type: 'button', 'aria-label': `${paused} paused — open paused requests`, title: 'Paused requests' }, icon('pause', 'aw-i aw-i14'), String(paused));
      b.addEventListener('click', () => { restore(); openPauses(); });
      return b;
    };
    indicators.replaceChildren(...(paused ? [pauseBtn('aw-bd aw-am aw-pausebtn')] : []),...act.map((m) => h('span', { class: 'aw-tbm', title: `${MOD[m].tab} module active` }, icon(MOD[m].icon, 'aw-i aw-i14'), h('span', { class: 'aw-dot aw-g' }))),
      ...(recording ? [h('span', { class: 'aw-bd aw-am', id: 'aw-rec-ind', title: 'Recorder is capturing page calls' }, 'REC')] : []),
      ...running.map((e) => h('span', { class: 'aw-bd aw-bl', id: 'aw-run-ind', title: `${e.summary.planName} is running` }, `RUN ${e.summary.progress.done}/${e.summary.progress.total}`)));
    launchInds.replaceChildren(...(paused ? [pauseBtn('aw-btn aw-gh aw-sm aw-ind aw-am')] : []), ...act.map((m) => {
      const b = h('button', { class: 'aw-btn aw-gh aw-ic aw-sm aw-ind', type: 'button', 'aria-label': `${MOD[m].tab} module active — open ${MOD[m].tab}` }, icon(MOD[m].icon), h('span', { class: 'aw-dot aw-g' }));
      b.addEventListener('click', () => { restore(); go(m); });
      return b;
    }));
    launcherState.textContent = [act.length ? act.map((m) => MOD[m].tab).join(', ') : 'No modules active', paused ? `${paused} paused` : '', recording ? 'Recording' : '', ...running.map((e) => `Run ${e.summary.progress.done}/${e.summary.progress.total}`)].filter(Boolean).join(' · ');
    const name = session.agg().profile.name;
    profBtn.replaceChildren(h('span', {}, name), icon('chevrons', 'aw-i aw-i12'));
    profBtn.setAttribute('title', `Profile: ${name}`);
    profBtn.setAttribute('aria-label', `Profile: ${name} — open Settings`);
    const ps = session.persist();
    saveBanner.hidden = !(ps === 'unsaved' || ps === 'conflict' || ps === 'session-only');
    if (!saveBanner.hidden && saveBanner.dataset.state !== ps + session.error()) {
      saveBanner.dataset.state = ps + session.error();
      const b = (label: string, fn: () => void, cls = 'aw-btn aw-out aw-sm') => { const x = h('button', { class: cls, type: 'button' }, label); x.addEventListener('click', fn); return x; };
      saveBanner.replaceChildren(icon('alert', 'aw-i aw-i14'), h('span', { class: 'aw-grow aw-wrap' }, session.error()),
        ...(ps === 'conflict' ? [b('Use stored version', () => { session.useStored(); announce('Loaded the stored version.'); }), b('Keep this tab’s version', () => session.overwrite())]
          : [b(ps === 'session-only' ? 'Try storage again' : 'Retry save', () => session.retry())]),
        b('Export…', () => go('settings'), 'aw-btn aw-gh aw-sm'));
    }
    if (!form) {
      foot.hidden = act.length === 0 && !paused && !running.length;
      if (act.length || paused || running.length) {
        const stop = h('button', { class: 'aw-btn aw-out aw-sm', type: 'button' }, icon('stop', 'aw-i aw-i12'), 'Stop all');
        stop.addEventListener('click', () => {
          rulesUi.stopAll();
          testUi.runs.stopAll('Stopped by Stop all');
          main.querySelector<HTMLElement>('[data-focus]')?.focus(); // the Stop all button just disappeared
        });
        foot.replaceChildren(h('span', { class: 'aw-xs aw-mu aw-grow' }, [act.length ? `Active: ${act.map((m) => MOD[m].tab).join(', ')}` : '', paused ? `${paused} paused` : '', running.length ? `${running.length} run in progress` : ''].filter(Boolean).join(' · ')), stop);
      } else foot.replaceChildren();
    }
  }

  // Data-only updates: coalesced to one frame; never rebuild inputs.
  let frame = 0;
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0;
      refreshChrome();
      live?.();
    });
  };
  const prefs = () => session.agg().profile.settings;
  const shown = (m: Screen) => !(prefs().hidden as string[]).includes(m);
  const recorder = createRecorder(rt, () => ({ calls: prefs().recorderCalls, recovery: prefs().recorderRecovery }));
  // Settings that change resources, not just screens: record cap, body reads, recorder.
  let lastPrefs = '';
  const applyPrefs = () => {
    const p = prefs();
    const sig = JSON.stringify(p);
    if (sig === lastPrefs) return;
    const before = lastPrefs ? JSON.parse(lastPrefs) as typeof p : null;
    lastPrefs = sig;
    rt.setPrefs({ records: p.activityRecords, responseBodies: p.responseBodies });
    if (p.hidden.includes('recorder') && recorder.recording()) {
      recorder.stop();
      announce(`Recorder hidden in Settings: recording stopped. ${recorder.captures().length} call(s) kept in the draft.`);
    }
    if (before && before.recorderRecovery !== p.recorderRecovery) recorder.prefsChanged();
    for (const [id, { btn }] of tabBtns) btn.hidden = !shown(id);
    if (!form && !shown(screen)) go('home');
  };
  const unsubscribe = rt.subscribe(schedule);
  const unsubSession = session.subscribe(schedule);
  const unsubRecorder = recorder.subscribe(schedule);
  // Countdown display only: each pause's deadline timer lives in the runtime and is never reset here.
  const ticker = setInterval(() => { if (rt.pauses().some((p) => p.state === 'waiting')) schedule(); }, 1000);

  // ---------- shared pieces
  const backButton = (to: Screen, onClick: () => void) => {
    const b = h('button', { class: 'aw-btn aw-gh aw-sm aw-back', type: 'button', 'aria-label': `Back to ${NAME[to]}` }, icon('back', 'aw-i aw-i14'), 'Back');
    b.addEventListener('click', onClick);
    return b;
  };

  function statusBadge(active: boolean) {
    return active ? h('span', { class: 'aw-bd aw-gr' }, h('span', { class: 'aw-dot aw-g' }), 'Active') : h('span', { class: 'aw-bd' }, h('span', { class: 'aw-dot' }), 'Inactive');
  }

  // ---------- traffic lists (shared by Home and module screens)
  const outcomeText = (r: ReqRecord) => r.outcome === 'ok' ? `HTTP ${r.status}` : r.outcome;
  function headline(r: ReqRecord) {
    const parts = r.ops.filter((o) => o.state !== 'selected').map((o) => `${o.state[0]!.toUpperCase()}${o.state.slice(1)} ${MOD[o.module].tab.toLowerCase()}${o.part ? ` ${o.part}` : ''}`);
    return parts.length ? parts.join(' · ') : r.ops.length ? 'Pending' : r.source === 'replay' ? `Replay copy of #${r.parentId}` : 'No rule matched';
  }

  function traffic(filter: (r: ReqRecord) => boolean, empty: string, badge?: HTMLElement, textFilter?: () => string) {
    const list = h('ol', { class: 'aw-card aw-list aw-traffic', 'aria-label': 'Requests, newest first' });
    const emptyEl = h('div', { class: 'aw-empty' }, empty);
    const more = h('div', { class: 'aw-hint' });
    const el = h('div', { class: 'aw-col aw-gap8' }, emptyEl, list, more);
    list.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest('button[data-id]');
      if (btn) openDetail(Number(btn.getAttribute('data-id')));
    });
    const refresh = () => {
      const q = textFilter?.().trim().toLowerCase() ?? '';
      const base = rt.records().filter(filter);
      const all = q ? base.filter((r) => `${r.method} ${r.url} ${outcomeText(r)} ${headline(r)}`.toLowerCase().includes(q)) : base;
      if (badge) badge.textContent = String(base.length);
      const shown = all.slice(-SHOWN).reverse();
      emptyEl.hidden = shown.length > 0;
      emptyEl.textContent = q && base.length ? `No requests match “${q}”` : empty;
      list.hidden = shown.length === 0;
      more.textContent = all.length > SHOWN ? `Showing latest ${SHOWN} of ${all.length}` : q ? `${all.length} of ${base.length} match` : '';
      const focused = root.activeElement?.closest?.('button[data-id]')?.getAttribute('data-id');
      const top = list.scrollTop;
      list.replaceChildren(...shown.map(row));
      list.scrollTop = follow ? 0 : top;
      if (focused) (list.querySelector(`button[data-id="${focused}"]`) as HTMLElement | null)?.focus();
    };
    return { el, refresh };
  }

  function row(r: ReqRecord): HTMLElement {
    const effect = r.ops.find((o) => o.state === 'applied');
    const skipped = r.ops.some((o) => o.state === 'skipped' || o.state === 'failed');
    const tone = r.outcome === 'pending' ? 'aw-am' : r.outcome === 'ok' && (r.status ?? 0) < 400 ? 'aw-gr' : 'aw-rd';
    const path = pathOf(r.url) + (r.hasQuery ? '?…' : '');
    return h('li', {}, h('button', {
      class: 'aw-li aw-actrow', type: 'button', 'data-id': String(r.id), 'data-key': `req-${r.id}`,
      'aria-label': `Request ${r.id}: ${r.method} ${path} · ${headline(r)} · ${outcomeText(r)}. Open details`,
    },
    methodBadge(r.method),
    h('span', { class: 'aw-tr aw-grow aw-mono aw-xs' }, path),
    effect && h('span', { class: 'aw-bd aw-gr aw-h18' }, MOD[effect.module].tab),
    skipped && h('span', { class: 'aw-bd aw-am aw-h18' }, 'skipped'),
    h('span', { class: `aw-bd ${tone} aw-h18` }, r.outcome === 'ok' ? String(r.status) : r.outcome),
    icon('chevronRight', 'aw-i aw-i14 aw-mu')));
  }

  function openDetail(id: number) {
    detailRet = here();
    detailRet.focus = `req-${id}`;
    detailId = id;
    screen = 'detail';
    render();
  }

  // ---------- R2 workspaces
  const kit: Kit = {
    rt, session, fetchers: opts.fetchers, root, foot, announce, ask, here, go, goBack,
    openForm(f) { form = f; render(); },
    closeForm(focus) { const f = form; form = null; if (f) goBack(f.ret, focus === undefined ? f.ret.focus : focus); },
    leaveForm,
    runEndpoint(id) { guard(() => { form = null; testUi.select(id); screen = 'test'; render(); }); },
    editEndpoint(id, extra) { endpointsUi.openEditor(id, here(), extra as Parameters<typeof endpointsUi.openEditor>[2]); },
    backButton: (to, onClick) => backButton(to, onClick),
    subbar: (name, title) => h('div', { class: 'aw-sub' },
      h('div', {}, backButton(subBack, () => go(subBack))),
      h('div', { class: 'aw-row aw-gap6' }, icon(name, 'aw-i aw-i14'), heading(title, 'aw-h aw-h14')),
      h('div', {})),
    notice(text, action) {
      const close = h('button', { class: 'aw-btn aw-gh aw-ic aw-sm', type: 'button', 'aria-label': 'Dismiss notice' }, icon('x'));
      close.addEventListener('click', () => { noticeEl.hidden = true; });
      const act = action && h('button', { class: 'aw-btn aw-out aw-sm', type: 'button' }, action.label);
      act?.addEventListener('click', () => { noticeEl.hidden = true; restore(); action!.run(); });
      noticeEl.replaceChildren(h('div', { class: 'aw-row aw-gap6' }, icon('info', 'aw-i aw-i14'), h('span', { class: 'aw-grow aw-wrap' }, text), act ?? '', close));
      noticeEl.hidden = false;
    },
    showRun(id) { guard(() => { form = null; testUi.showRun(id); screen = 'test'; render(); }); },
    changed: () => schedule(),
  };
  const rulesUi = createRulesUi(kit, { traffic, statusBadge });
  const pausesUi = createPausesUi(kit);

  function openPauses(id?: number) {
    if (screen !== 'pauses') pausesBack = { ret: here(), form };
    form = null;
    if (id) pausesUi.select(id);
    screen = 'pauses';
    render();
  }
  function backFromPauses() {
    const b = pausesBack ?? { ret: { screen: 'intercept' as Screen, scroll: 0, listScroll: 0, focus: null }, form: null };
    pausesBack = null;
    if (b.form) { form = b.form; screen = b.ret.screen; render(); } else goBack(b.ret);
  }
  /** Intercept list with the paused-queue summary under its activation control. */
  function interceptScreen(): Built {
    const b = rulesUi.screen('intercept');
    const c = pausesUi.card(() => openPauses());
    b.nodes.splice(3, 0, c.el);
    return { nodes: b.nodes, refresh: () => { c.refresh(); b.refresh?.(); } };
  }
  rulesUi.sync();
  applyPrefs();
  const unsubRules = session.subscribe(rulesUi.sync);
  const unsubPrefs = session.subscribe(applyPrefs);
  const endpointsUi = createEndpointsUi(kit);
  const testUi = createTestUi(kit);
  const importUi = createImportUi(kit, recorder, { version: opts.version, onProfileChange: () => testUi.stop() });
  const settingsUi = createSettingsUi(kit, {
    version: opts.version,
    updateUrl: __UPDATE_URL__,
    onProfileChange: () => testUi.stop(),
    clearPreferences: async () => {
      await recorder.reset();
      rt.clearRecords();
      try { localStorage.removeItem(GEOMETRY_KEY); localStorage.removeItem(UPDATE_KEY); } catch { /* storage refused: nothing stored either */ }
      delete geo.panel; delete geo.size; delete geo.launcher;
      place();
    },
  });

  // ---------- screens

  function homeScreen(): Built {
    const refreshers: (() => void)[] = [];
    const testerCard = () => {
      const sub = h('div', { class: 'aw-xs aw-mu aw-wrap' });
      const openBtn = h('button', { class: 'aw-btn aw-gh aw-sm', type: 'button', 'aria-label': 'Open API Tester' }, 'Open', icon('chevronRight', 'aw-i aw-i14'));
      openBtn.addEventListener('click', () => go('test'));
      const primary = h('button', { class: 'aw-btn aw-sm aw-out', type: 'button', 'data-key': 'card-test' });
      primary.addEventListener('click', () => (session.agg().endpoints.length ? go('test') : kit.editEndpoint(null)));
      refreshers.push(() => {
        const n = session.agg().endpoints.length;
        const plans = session.agg().plans.length;
        const running = testUi.runs.running().length;
        sub.textContent = n ? `${n} endpoint${n === 1 ? '' : 's'} · ${plans} plan${plans === 1 ? '' : 's'}${running ? ` · ${running} run in progress` : ''}` : 'No endpoints yet';
        primary.replaceChildren(icon(n ? 'play' : 'plus', 'aw-i aw-i14'), n ? 'Run once' : 'Create endpoint');
        primary.setAttribute('aria-label', n ? 'Run an endpoint once' : 'Create endpoint');
      });
      return h('section', { class: 'aw-card aw-cp aw-col aw-gap12', 'aria-label': 'API Tester' },
        h('div', { class: 'aw-row aw-gap10' }, tile('flask'), h('div', { class: 'aw-grow' }, h('div', { class: 'aw-row aw-gap8' }, h('span', { class: 'aw-h' }, 'API Tester')), sub), openBtn),
        h('div', { class: 'aw-row' }, primary));
    };
    const moduleCard = (m: Module) => {
      const badgeSlot = h('span', {});
      const sub = h('div', { class: 'aw-xs aw-mu aw-wrap' });
      const openBtn = h('button', { class: 'aw-btn aw-gh aw-sm', type: 'button', 'aria-label': `Open ${MOD[m].home}` }, 'Open', icon('chevronRight', 'aw-i aw-i14'));
      // One primary action, chosen from state: New rule → Activate → Deactivate; no enabled rule leads to the list.
      const primary = h('button', { class: 'aw-btn aw-sm', type: 'button', 'data-key': `card-${m}` });
      let action: 'new' | 'toggle' | 'manage' = 'new';
      openBtn.addEventListener('click', () => go(m));
      primary.addEventListener('click', () => action === 'new' ? rulesUi.openEditor(m, null, here()) : action === 'toggle' ? rulesUi.setActive(m, !rulesUi.config().active[m]) : go(m));
      refreshers.push(() => {
        const active = rulesUi.config().active[m];
        const total = rulesUi.rules(m).length, n = rulesUi.enabledCount(m);
        const applied = rulesUi.counts(m).applied;
        badgeSlot.replaceChildren(statusBadge(active));
        action = !total ? 'new' : n || active ? 'toggle' : 'manage';
        const label = action === 'new' ? 'New rule' : action === 'manage' ? 'Manage rules' : active ? 'Deactivate' : 'Activate';
        primary.className = `aw-btn aw-sm ${action === 'toggle' && !active ? 'aw-pri' : 'aw-out'}`;
        primary.replaceChildren(icon(action === 'new' ? 'plus' : action === 'manage' ? 'chevronRight' : active ? 'stop' : 'play', 'aw-i aw-i14'), label);
        primary.setAttribute('aria-label', action === 'new' ? `New ${MOD[m].tab} rule` : action === 'manage' ? `Manage ${MOD[m].tab} rules` : `${label} ${MOD[m].tab} module`);
        sub.textContent = !total ? 'No rules yet'
          : !n ? `0 of ${total} rules enabled${active ? ' · Module active: traffic unaffected' : ''}`
          : !active ? `${n} enabled rule${n > 1 ? 's' : ''} · Module inactive: traffic unaffected`
          : `${n} enabled rule${n > 1 ? 's' : ''} · ${applied} ${MOD[m].effect}`;
      });
      return h('section', { class: 'aw-card aw-cp aw-col aw-gap12', 'aria-label': MOD[m].home },
        h('div', { class: 'aw-row aw-gap10' }, tile(MOD[m].icon), h('div', { class: 'aw-grow' }, h('div', { class: 'aw-row aw-gap8' }, h('span', { class: 'aw-h' }, MOD[m].home), badgeSlot), sub), openBtn),
        h('div', { class: 'aw-row' }, primary));
    };
    const qa = (label: string, iconName: IconName, target: Screen) => {
      const b = h('button', { class: 'aw-qa', type: 'button' }, icon(iconName), h('span', {}, label));
      b.addEventListener('click', () => go(target));
      return b;
    };
    const count = countBadge();
    const filterIn = h('input', { class: 'aw-in', id: 'aw-filter', type: 'search', placeholder: 'Filter by method, path, outcome or effect', spellcheck: 'false' });
    filterIn.value = filterText;
    const t = traffic(() => true, 'No requests yet. Page Fetch/XHR calls made after launch appear here.', count, () => filterText);
    filterIn.addEventListener('input', () => { filterText = filterIn.value; t.refresh(); });
    refreshers.push(t.refresh);
    const followCb = checkbox('Follow newest', follow, (v) => { follow = v; t.refresh(); });
    const clear = h('button', { class: 'aw-btn aw-gh aw-sm', type: 'button', 'aria-label': 'Clear recent activity' }, 'Clear');
    clear.addEventListener('click', () => { rt.clearRecords(); announce('Recent activity cleared.'); });
    return {
      nodes: [
        h('h2', { class: 'aw-sr', tabindex: '-1', 'data-focus': true }, 'Home'),
        testerCard(),
        ...(['mock', 'intercept', 'route', 'chaos'] as const).filter(shown).map(moduleCard),
        h('div', { class: 'aw-col aw-gap8 aw-mt2' }, h('div', { class: 'aw-cap aw-capl' }, 'Quick actions'),
          h('div', { class: 'aw-g3' }, qa('Endpoints', 'book', 'endpoints'), qa('Import', 'import', 'import'), qa('Settings', 'settings', 'settings'))),
        h('div', { class: 'aw-col aw-gap8 aw-mt2' },
          h('div', { class: 'aw-row' }, h('span', { class: 'aw-lbl aw-grow' }, h('span', {}, 'Recent activity '), count), h('span', { class: 'aw-chk' }, followCb, 'Follow newest'), clear),
          h('label', { class: 'aw-sr', for: 'aw-filter' }, 'Filter recent activity'), filterIn,
          t.el),
        h('p', { class: 'aw-hint aw-wrap' }, `Version ${opts.version} · Frame ${rt.origin} · Current-frame Fetch/XHR after launch only. Rules are saved with the profile; modules start inactive on every launch. The latest ${rt.prefs.records} requests are kept (Settings).`),
      ],
      refresh: () => refreshers.forEach((f) => f()),
    };
  }

  // ---------- request detail (S21.1/S21.2 R1 portion): one record by stable ID, read-only, sends nothing
  function detailScreen(): Built {
    const ret = detailRet ?? { screen: 'home', scroll: 0, listScroll: 0, focus: null };
    const id = detailId;
    const content = h('div', { class: 'aw-col aw-gap12 aw-detail' });
    let shown = '';
    const refresh = () => {
      const r = rt.records().find((x) => x.id === id);
      const sig = r ? `${id}|${r.outcome}|${r.status}|${r.responseType}|${r.ops.map((o) => o.state + o.reason).join()}|${r.notes.length}|${rt.records().filter((x) => x.parentId === id).map((x) => x.outcome).join()}` : 'gone';
      if (sig === shown) return; // unchanged: keep any text selection
      shown = sig;
      content.replaceChildren(...(r ? detailBody(r) : [h('div', { class: 'aw-empty aw-wrap' },
        `Request #${id} is no longer retained. Recent activity keeps the latest ${rt.prefs.records} requests, and Clear removes them. Nothing was re-sent.`)]));
    };
    return {
      nodes: [
        h('div', { class: 'aw-row' }, backButton(ret.screen, () => goBack(ret)), heading(`Request #${id}`)),
        content,
      ],
      refresh,
    };
  }

  function detailBody(r: ReqRecord): Node[] {
    const routed = r.ops.find((o) => o.module === 'route' && o.state === 'applied');
    const synthetic = r.provider !== 'network' && r.ops.some((o) => (o.module === 'mock' || o.module === 'chaos') && o.state === 'applied');
    const by = r.provider === 'mock' ? 'Mock' : 'synthetic chaos';
    const transport = r.transport === 'fetch' ? 'Fetch' : `XHR${r.responseType ? ` · responseType ${r.responseType}` : ''}`;
    const effective = synthetic ? `${by} reply; nothing was sent`
      : routed && r.finalUrl ? `${r.method} ${r.finalUrl}${r.hasQuery ? ' (query preserved)' : ''}`
      : r.outcome === 'pending' && r.ops.some((o) => o.state === 'selected') ? 'Not decided yet'
      : 'Original URL sent';
    const outcome = r.outcome === 'pending' ? 'Pending — not complete'
      : `${r.outcome === 'ok' ? `HTTP ${r.status}` : r.outcome === 'error' ? 'Network error (rejected/failed)' : r.outcome === 'aborted' ? 'Aborted by the caller' : 'Timed out'}${r.elapsedMs !== undefined ? ` · ${r.elapsedMs} ms observed (includes Workbench waits; not server time)` : ''}`;
    const dl = (rows: [string, string][]) => h('dl', { class: 'aw-dl' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', { class: 'aw-mono' }, v)]));
    const section = (title: string, ...kids: Node[]) => h('section', { class: 'aw-col aw-gap6', 'aria-label': title }, h('h3', { class: 'aw-cap' }, title), ...kids);
    const children = rt.records().filter((x) => x.parentId === r.id);
    const link = (id: number, text: string) => {
      const b = h('button', { class: 'aw-btn aw-gh aw-sm', type: 'button' }, text);
      b.addEventListener('click', () => { detailId = id; render(); });
      return b;
    };
    const held = rt.pauses().find((p) => p.rec === r && p.state === 'waiting');
    const source = r.source === 'replay' ? `Chaos replay copy of request #${r.parentId}; sent by Workbench, not the page`
      : `This frame (${rt.origin}) · ${r.source === 'tester' ? 'Test → Once with rules' : 'page'} ${r.transport === 'fetch' ? 'fetch()' : 'XMLHttpRequest'}`;
    return [
      h('p', { class: 'aw-m0 aw-fg aw-wrap' }, `${headline(r)} · ${r.transport === 'fetch' ? 'Fetch' : `XHR ${r.responseType ?? ''}`.trim()} · ${synthetic ? `${by} reply` : routed ? 'routed URL sent' : r.outcome === 'pending' ? 'in progress' : 'original URL sent'}`),
      ...(held ? [h('div', { class: 'aw-alert aw-notice aw-row aw-gap8', role: 'status' }, icon('pause', 'aw-i aw-i14'),
        h('span', { class: 'aw-grow aw-wrap' }, `Paused at the ${held.stage} breakpoint.`), (() => { const b = h('button', { class: 'aw-btn aw-out aw-sm', type: 'button' }, 'Open pause'); b.addEventListener('click', () => openPauses(held.id)); return b; })())] : []),
      section('Overview', dl([
        ['Source', source],
        ['Transport', transport],
        ['Original', `${r.method} ${r.url}${r.hasQuery ? ' (query values not stored)' : ''}`],
        ['Effective', effective],
        ['Outcome', outcome],
        ['Config', `Revision ${r.revision}, captured when the request started`],
      ])),
      ...(r.parentId || children.length ? [section('Replay', h('div', { class: 'aw-row aw-wrapbtns' },
        ...(r.parentId ? [link(r.parentId, `Open primary #${r.parentId}`)] : []),
        ...children.map((c) => link(c.id, `Copy #${c.id}: ${c.outcome === 'ok' ? `HTTP ${c.status}` : c.outcome}`))))] : []),
      section('Why',
        r.ops.length ? h('ul', { class: 'aw-ops' }, ...r.ops.map((o) => {
          const tone = o.state === 'applied' ? 'aw-gr' : o.state === 'failed' ? 'aw-rd' : o.state === 'selected' ? 'aw-bl' : 'aw-am';
          return h('li', { class: 'aw-row' },
            h('span', { class: 'aw-bd' }, `${MOD[o.module].tab}${o.part ? ` ${o.part}` : ''}`), h('span', { class: `aw-bd ${tone}` }, o.state),
            h('span', { class: 'aw-grow aw-wrap' }, o.rule ? h('span', { class: 'aw-fg' }, `${o.rule}: `) : '', o.reason),
            h('span', { class: 'aw-xs aw-mu aw-mono' }, o.at === undefined ? 'at start' : `+${o.at} ms`));
        })) : h('div', { class: 'aw-mu aw-wrap' }, r.source === 'replay' ? 'Replay copies never enter rule selection.' : 'No enabled rule in an active module matched; the request passed through natively.'),
        ...r.notes.map((n) => h('div', { class: 'aw-mu aw-wrap' }, n))),
      section('Bodies', h('div', { class: 'aw-mu aw-wrap' }, 'Request and response bodies are not kept in request details. Headers are not recorded either; nothing here was stored or re-sent.')),
    ];
  }


  // ---------- minimize / restore (Minimize never stops work; the DOM, draft and scroll stay as they are)
  function minimize() {
    panel.hidden = true;
    launcher.hidden = false;
    place();
    restoreBtn.focus();
  }
  function restore() {
    const wasHidden = panel.hidden;
    launcher.hidden = true;
    panel.hidden = false;
    place();
    if (!wasHidden) return;
    const keep = lastFocus && (main.contains(lastFocus) || foot.contains(lastFocus));
    (keep ? lastFocus : main.querySelector<HTMLElement>('[data-focus]'))?.focus();
  }

  render();
  place();

  return {
    restore,
    notice(text) {
      noticeEl.replaceChildren(icon('alert', 'aw-i aw-i14'), text);
      noticeEl.hidden = false;
      restore();
    },
    destroy() {
      cancelAnimationFrame(frame);
      clearInterval(ticker);
      testUi.stop();
      unsubscribe();
      unsubSession();
      unsubRules();
      unsubPrefs();
      unsubRecorder();
      recorder.dispose();
      ro.disconnect();
      life.abort();
      if (dialog.open) dialog.close();
      host.remove();
    },
  };
}

function pathOf(url: string) {
  try {
    const u = new URL(url);
    return u.origin === location.origin ? u.pathname : url;
  } catch {
    return url;
  }
}
