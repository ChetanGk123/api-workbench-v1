// Workbench panel following design/reference/screens: title bar, six module tabs, Home cards,
// Mock/Intercept/Route screens with rule editors, traffic lists, request detail and the minimized launcher.
// Only R0/R1 capabilities are wired; later modules state that they are not in this build.
import {
  LIMITS, METHODS, newInterceptRule, newMockRule, newRouteRule, validateInterceptRule, validateMockRule, validateRouteRule,
  type Config, type Errors, type InterceptRule, type MockRule, type Module, type RouteRule,
} from '../net/plan';
import type { ReqRecord, Runtime } from '../net/runtime';
import { h, icon, type IconName } from './dom';
import { clampPos, MIN_SIZE, readGeometry, writeGeometry, type Pos } from './geometry';
import themeCss from '../../design/reference/aw-theme.css';
import panelCss from './panel.css';

export interface Panel {
  restore(): void;
  notice(text: string): void;
  destroy(): void;
}

type RuleOf = { mock: MockRule; intercept: InterceptRule; route: RouteRule };
type Screen = 'home' | 'test' | Module | 'chaos' | 'endpoints' | 'import' | 'settings' | 'detail';
/** Where Back goes, and what to put back there: scroll positions and the focused row/control key. */
interface Ret { screen: Screen; scroll: number; listScroll: number; focus: string | null }
interface Editor<M extends Module = Module> {
  module: M;
  draft: RuleOf[M];
  base: string;
  isNew: boolean;
  errors: Errors;
  ret: Ret;
}

const MOD: Record<Module, { title: string; home: string; tab: string; icon: IconName; noun: string; effect: string; empty: string; traffic: string }> = {
  mock: { title: 'Mock Server', home: 'Mock Server', tab: 'Mock', icon: 'server', noun: 'mock rule', effect: 'requests mocked', empty: 'No matched traffic yet', traffic: 'Matched traffic' },
  intercept: { title: 'Interceptor', home: 'API Interceptor', tab: 'Intercept', icon: 'shuffle', noun: 'intercept rule', effect: 'responses modified', empty: 'No intercepted traffic yet', traffic: 'Traffic log' },
  route: { title: 'Page Routing', home: 'Page Routing', tab: 'Route', icon: 'route', noun: 'page rule', effect: 'routed', empty: 'No routed traffic yet', traffic: 'Routed traffic' },
};
const TABS: { id: Screen; label: string; icon: IconName }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'test', label: 'Test', icon: 'flask' },
  { id: 'mock', label: 'Mock', icon: 'server' },
  { id: 'intercept', label: 'Intercept', icon: 'shuffle' },
  { id: 'route', label: 'Route', icon: 'route' },
  { id: 'chaos', label: 'Chaos', icon: 'flame' },
];
const NAME: Record<Screen, string> = { home: 'Home', test: 'Test', mock: 'Mock', intercept: 'Intercept', route: 'Route', chaos: 'Chaos', endpoints: 'Endpoints', import: 'Import', settings: 'Settings', detail: 'request' };
const LATER: Partial<Record<Screen, { title: string; icon: IconName; text: string }>> = {
  test: { title: 'API Tester', icon: 'flask', text: 'Saved endpoints, Once and plans are not in this build. Once arrives with endpoints (R2); plans and results follow in R6.' },
  chaos: { title: 'Chaos Engineering', icon: 'flame', text: 'Latency, faults and replay rules are not in this build. They arrive with the rule modules (R4).' },
  endpoints: { title: 'Endpoints', icon: 'book', text: 'Saved endpoints, headers and environments are not in this build. They arrive in R2.' },
  import: { title: 'Import', icon: 'import', text: 'Recorder, native and HAR import arrive in R3; Swagger/OpenAPI/Postman/cURL/fetch in R7.' },
  settings: { title: 'Settings', icon: 'settings', text: 'Profiles, storage, limits and backup arrive in R2. This build keeps rules for the current page session only; reload clears them. Panel position and size are remembered for this site.' },
};
const SHOWN = 50;
const STEP = 16;

export function mountPanel(rt: Runtime, opts: { version: string; onClose(): void }): Panel {
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
  let editor: Editor | null = null;
  let live: (() => void) | null = null;
  let follow = true;
  let filterText = '';
  let detailId = 0;
  let detailRet: Ret | null = null;
  let lastFocus: HTMLElement | null = null;

  // ---------- chrome
  const iconBtn = (name: IconName, label: string) => h('button', { class: 'aw-btn aw-gh aw-ic aw-sm', type: 'button', 'aria-label': label, title: label }, icon(name));
  const indicators = h('span', { class: 'aw-row aw-inds' });
  const moveBtn = h('button', { class: 'aw-logo aw-move', type: 'button', 'data-move': true, 'aria-label': 'Move panel: arrow keys move, Shift+arrow keys resize', title: 'Drag to move · arrow keys move · Shift+arrows resize' }, icon('bolt', 'aw-i aw-i14'));
  const settingsBtn = iconBtn('settings', 'Settings');
  const importBtn = iconBtn('import', 'Import');
  const minimizeBtn = iconBtn('minus', 'Minimize');
  const closeBtn = iconBtn('x', 'Close API Workbench and remove its hooks');
  const header = h('header', { class: 'aw-tb' },
    moveBtn,
    h('div', { class: 'aw-brand', title: `API Workbench ${opts.version} · ${rt.origin}` }, 'API Workbench'),
    indicators, h('div', { class: 'aw-grow' }), settingsBtn, importBtn, minimizeBtn, closeBtn);

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
  const main = h('main', { class: 'aw-body' });
  const foot = h('footer', { class: 'aw-foot', hidden: true });
  const panel = h('div', { class: 'aw-root aw-panel', role: 'region', 'aria-label': 'API Workbench' }, header, nav, noticeEl, main, foot);
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
  on(importBtn, 'click', () => go('import'));
  on(minimizeBtn, 'click', minimize);
  on(restoreBtn, 'click', () => restore());
  on(closeBtn, 'click', () => guard(opts.onClose));
  on(launcherClose, 'click', () => {
    if (dirty()) restore(); // show the draft the decision is about
    guard(opts.onClose);
  });
  on(panel, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && editor && screen !== 'detail' && !dialog.open) {
      // Prevent the browser's Escape default from closing the dialog we are about to open.
      e.preventDefault();
      e.stopPropagation();
      setTimeout(leaveEditor);
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
  const cfg = () => rt.config();
  function setModule<M extends Module>(m: M, patch: Partial<Config[M]>) {
    rt.setConfig({ ...cfg(), [m]: { ...cfg()[m], ...patch } });
  }
  function announce(text: string) { status.textContent = text; }
  const activeModules = () => (['mock', 'intercept', 'route'] as Module[]).filter((m) => cfg()[m].active);
  /** The tab that owns the current view (an editor or request detail belongs to where it was opened). */
  const owner = (): Screen => editor ? editor.module : screen === 'detail' ? detailRet?.screen ?? 'home' : screen;

  // ---------- navigation and draft guard
  function go(next: Screen) {
    guard(() => {
      editor = null;
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

  function leaveEditor() {
    const ed = editor;
    if (ed) guard(() => { editor = null; goBack(ed.ret); });
  }

  function dirty() {
    return !!editor && JSON.stringify(editor.draft) !== editor.base;
  }

  function guard(next: () => void) {
    if (!dirty()) return next();
    ask('This rule has unsaved changes.', [
      { label: 'Keep editing', cls: 'aw-out', value: 'keep' },
      { label: 'Discard', cls: 'aw-dst', value: 'discard' },
      { label: 'Save', cls: 'aw-pri', value: 'save' },
    ]).then((v) => {
      if (v === 'discard') {
        editor = null;
        next();
      } else if (v === 'save' && commitEditor()) next();
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
    const built = editor && editor.module !== 'route' ? editorScreen(editor as Editor<'mock' | 'intercept'>)
      : screen === 'home' ? homeScreen()
      : screen === 'mock' || screen === 'intercept' ? moduleScreen(screen)
      : screen === 'route' ? routeScreen()
      : screen === 'detail' ? detailScreen()
      : laterScreen(screen);
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
    for (const [id, { btn, dot }] of tabBtns) {
      const isOn = id === current;
      btn.classList.toggle('aw-on', isOn);
      isOn ? btn.setAttribute('aria-current', 'page') : btn.removeAttribute('aria-current');
      dot.hidden = !act.includes(id as Module);
    }
    indicators.replaceChildren(...act.map((m) => h('span', { class: 'aw-tbm', title: `${MOD[m].tab} module active` }, icon(MOD[m].icon, 'aw-i aw-i14'), h('span', { class: 'aw-dot aw-g' }))));
    launchInds.replaceChildren(...act.map((m) => {
      const b = h('button', { class: 'aw-btn aw-gh aw-ic aw-sm aw-ind', type: 'button', 'aria-label': `${MOD[m].tab} module active — open ${MOD[m].tab}` }, icon(MOD[m].icon), h('span', { class: 'aw-dot aw-g' }));
      b.addEventListener('click', () => { restore(); go(m); });
      return b;
    }));
    launcherState.textContent = act.length ? act.map((m) => MOD[m].tab).join(', ') : 'No modules active';
    if (!editor || editor.module === 'route') {
      foot.hidden = act.length === 0;
      if (act.length) {
        const stop = h('button', { class: 'aw-btn aw-out aw-sm', type: 'button' }, icon('stop', 'aw-i aw-i12'), 'Stop all');
        stop.addEventListener('click', stopAll);
        foot.replaceChildren(h('span', { class: 'aw-xs aw-mu aw-grow' }, `Active: ${act.map((m) => MOD[m].tab).join(', ')}`), stop);
      } else foot.replaceChildren();
    }
  }

  function stopAll() {
    rt.setConfig({ ...cfg(), mock: { ...cfg().mock, active: false }, intercept: { ...cfg().intercept, active: false }, route: { ...cfg().route, active: false } });
    announce('All modules deactivated. Requests already in progress keep their selected behavior.');
    main.querySelector<HTMLElement>('[data-focus]')?.focus(); // the Stop all button just disappeared
  }

  // Data-only updates: coalesced to one frame; never rebuild inputs.
  let frame = 0;
  const unsubscribe = rt.subscribe(() => {
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0;
      refreshChrome();
      live?.();
    });
  });

  // ---------- shared pieces
  const heading = (text: string, cls = 'aw-h') => h('h2', { class: cls, tabindex: '-1', 'data-focus': true }, text);
  const tile = (name: IconName) => h('div', { class: 'aw-tile' }, icon(name));
  const countBadge = () => h('span', { class: 'aw-bd aw-s aw-cnt' }, '0');
  const methodBadge = (m: string) => h('span', { class: `aw-bd aw-m aw-${m}` }, m === '*' ? 'ANY' : m);
  const backButton = (to: Screen, onClick: () => void) => {
    const b = h('button', { class: 'aw-btn aw-gh aw-sm aw-back', type: 'button', 'aria-label': `Back to ${NAME[to]}` }, icon('back', 'aw-i aw-i14'), 'Back');
    b.addEventListener('click', onClick);
    return b;
  };

  function statusBadge(active: boolean) {
    return active ? h('span', { class: 'aw-bd aw-gr' }, h('span', { class: 'aw-dot aw-g' }), 'Active') : h('span', { class: 'aw-bd' }, h('span', { class: 'aw-dot' }), 'Inactive');
  }

  const effectCount = (m: Module) => rt.records().filter((r) => r.ops.some((o) => o.module === m && o.state === 'applied')).length;
  const enabledText = (m: Module) => {
    const r = cfg()[m].rule;
    return `${r?.enabled ? 1 : 0}/${r ? 1 : 0} rules enabled`;
  };

  function activateButton(m: Module, outline = false) {
    const btn = h('button', { class: 'aw-btn', type: 'button' });
    const hint = h('span', { class: 'aw-hint' });
    btn.addEventListener('click', () => toggleModule(m));
    const refresh = () => {
      const { active, rule } = cfg()[m];
      btn.className = `aw-btn ${active || outline ? 'aw-out' : 'aw-pri'}`;
      btn.replaceChildren(icon(active ? 'stop' : 'play', 'aw-i aw-i14'), active ? 'Deactivate' : 'Activate');
      btn.setAttribute('aria-label', `${active ? 'Deactivate' : 'Activate'} ${MOD[m].tab} module`);
      const usable = !!rule?.enabled;
      btn.disabled = !active && !usable;
      btn.classList.toggle('aw-dis', btn.disabled);
      hint.textContent = active && !usable ? 'Active, but no enabled rule: traffic is unaffected.' : !active && !rule ? 'Add a rule first.' : !active && !usable ? 'Enable the rule first.' : '';
    };
    hint.id = `aw-act-${m}-hint`;
    btn.setAttribute('aria-describedby', hint.id);
    return { el: h('div', { class: 'aw-col aw-gap6 aw-start' }, btn, hint), refresh };
  }

  function toggleModule(m: Module) {
    const active = !cfg()[m].active;
    setModule(m, { active });
    announce(`${MOD[m].tab} module ${active ? 'activated' : 'deactivated'}.`);
  }

  function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void) {
    const b = h('button', { class: 'aw-cb', type: 'button', role: 'checkbox', 'aria-label': label });
    const set = (v: boolean) => {
      b.classList.toggle('aw-on', v);
      b.setAttribute('aria-checked', String(v));
      b.replaceChildren(...(v ? [icon('check', 'aw-i aw-i12')] : []));
    };
    set(checked);
    b.addEventListener('click', () => {
      const v = b.getAttribute('aria-checked') !== 'true';
      set(v);
      onChange(v);
    });
    return b;
  }

  function ruleSummary(m: Module, r: RuleOf[Module]) {
    return r.label || `${MOD[m].tab} ${r.path}`;
  }

  function ruleList(m: Module) {
    const wrap = h('div', { class: 'aw-col aw-gap8' });
    const refresh = () => {
      const r = cfg()[m].rule;
      if (!r) return wrap.replaceChildren(h('div', { class: 'aw-empty' }, m === 'intercept' ? 'No freestanding intercept rules' : `No ${m === 'route' ? 'page' : 'ad-hoc'} rules`));
      if (wrap.contains(root.activeElement)) return; // data-only update; keep the focused control
      const name = ruleSummary(m, r);
      const meta = h('span', { class: 'aw-row aw-mono aw-meta' }, methodBadge(r.method), h('span', { class: 'aw-tr' }, r.path));
      if (m === 'mock') meta.append(h('span', { class: 'aw-arrow' }, '→'), h('span', { class: `aw-bd ${(r as MockRule).status < 400 ? 'aw-gr' : 'aw-rd'} aw-h18` }, String((r as MockRule).status)));
      if (m === 'route') meta.append(h('span', { class: 'aw-arrow' }, '→'), h('span', { class: 'aw-tr' }, (r as RouteRule).destinationOrigin + ((r as RouteRule).pathRewrite || '')));
      const open = h('button', { class: 'aw-grow aw-col aw-rulebtn', type: 'button', 'aria-label': `Edit ${name}`, 'data-key': `rule-${m}` }, h('span', { class: 'aw-rname' }, name), meta);
      open.addEventListener('click', () => openEditor(m, false));
      const del = h('button', { class: 'aw-btn aw-gh aw-ic aw-sm', type: 'button', 'aria-label': `Delete rule ${name}` }, icon('x'));
      del.addEventListener('click', () => deleteRule(m));
      const cb = checkbox(`Enable ${name}`, r.enabled, (v) => {
        setModule(m, { rule: { ...cfg()[m].rule!, enabled: v } } as Partial<Config[Module]>);
        announce(`Rule ${v ? 'enabled' : 'disabled'}.`);
      });
      wrap.replaceChildren(h('div', { class: 'aw-card aw-list' }, h('div', { class: 'aw-row aw-rule' }, cb, open, del)));
    };
    return { el: wrap, refresh };
  }

  function deleteRule(m: Module) {
    ask(`Delete this ${MOD[m].noun}? Requests already in progress keep their selected behavior.`, [
      { label: 'Cancel', cls: 'aw-out', value: 'cancel' },
      { label: 'Delete', cls: 'aw-dst', value: 'delete' },
    ]).then((v) => {
      if (v !== 'delete') return;
      const back = editor?.ret;
      setModule(m, { rule: null, active: false });
      editor = null;
      announce('Rule deleted; module deactivated.');
      if (back) goBack(back);
      else { screen = m; render(); }
    });
  }

  // ---------- traffic lists (shared by Home and module screens)
  const outcomeText = (r: ReqRecord) => r.outcome === 'ok' ? `HTTP ${r.status}` : r.outcome;
  function headline(r: ReqRecord) {
    const parts = r.ops.filter((o) => o.state !== 'selected').map((o) => `${o.state[0]!.toUpperCase()}${o.state.slice(1)} ${MOD[o.module].tab.toLowerCase()}`);
    return parts.length ? parts.join(' · ') : r.ops.length ? 'Pending' : 'No rule matched';
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

  // ---------- screens
  type Built = { nodes: Node[]; refresh?: () => void };

  function homeScreen(): Built {
    const refreshers: (() => void)[] = [];
    const laterCard = (title: string, iconName: IconName, sub: string, target: Screen) => {
      const openBtn = h('button', { class: 'aw-btn aw-gh aw-sm', type: 'button', 'aria-label': `Open ${title}` }, 'Open', icon('chevronRight', 'aw-i aw-i14'));
      openBtn.addEventListener('click', () => go(target));
      return h('section', { class: 'aw-card aw-cp aw-col aw-gap12' },
        h('div', { class: 'aw-row aw-gap10' }, tile(iconName), h('div', { class: 'aw-grow' }, h('div', { class: 'aw-row aw-gap8' }, h('span', { class: 'aw-h' }, title), h('span', { class: 'aw-bd' }, 'Not in this build')), h('div', { class: 'aw-xs aw-mu' }, sub)), openBtn));
    };
    const moduleCard = (m: Module) => {
      const badgeSlot = h('span', {});
      const sub = h('div', { class: 'aw-xs aw-mu aw-wrap' });
      const openBtn = h('button', { class: 'aw-btn aw-gh aw-sm', type: 'button', 'aria-label': `Open ${MOD[m].home}` }, 'Open', icon('chevronRight', 'aw-i aw-i14'));
      // One primary action, chosen from state: New rule → Activate → Deactivate; a disabled rule leads to the list.
      const primary = h('button', { class: 'aw-btn aw-sm', type: 'button', 'data-key': `card-${m}` });
      let action: 'new' | 'toggle' | 'manage' = 'new';
      openBtn.addEventListener('click', () => go(m));
      primary.addEventListener('click', () => action === 'new' ? openEditor(m, true) : action === 'toggle' ? toggleModule(m) : go(m));
      refreshers.push(() => {
        const { active, rule } = cfg()[m];
        const n = effectCount(m);
        badgeSlot.replaceChildren(statusBadge(active));
        action = !rule ? 'new' : rule.enabled || active ? 'toggle' : 'manage';
        const label = action === 'new' ? 'New rule' : action === 'manage' ? 'Manage rules' : active ? 'Deactivate' : 'Activate';
        primary.className = `aw-btn aw-sm ${action === 'toggle' && !active ? 'aw-pri' : 'aw-out'}`;
        primary.replaceChildren(icon(action === 'new' ? 'plus' : action === 'manage' ? 'chevronRight' : active ? 'stop' : 'play', 'aw-i aw-i14'), label);
        primary.setAttribute('aria-label', action === 'new' ? `New ${MOD[m].tab} rule` : action === 'manage' ? `Manage ${MOD[m].tab} rules` : `${label} ${MOD[m].tab} module`);
        sub.textContent = !rule ? 'No rules yet'
          : !rule.enabled ? `0 of 1 rules enabled${active ? ' · Module active: traffic unaffected' : ''}`
          : !active ? '1 enabled rule · Module inactive: traffic unaffected'
          : `1 enabled rule · ${n} ${MOD[m].effect}`;
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
        laterCard('API Tester', 'flask', 'Endpoints, Once and plans arrive in later builds', 'test'),
        moduleCard('mock'), moduleCard('intercept'), moduleCard('route'),
        laterCard('Chaos Engineering', 'flame', 'Latency and fault rules arrive in a later build', 'chaos'),
        h('div', { class: 'aw-col aw-gap8 aw-mt2' }, h('div', { class: 'aw-cap aw-capl' }, 'Quick actions'),
          h('div', { class: 'aw-g3' }, qa('Endpoints', 'book', 'endpoints'), qa('Import', 'import', 'import'), qa('Settings', 'settings', 'settings'))),
        h('div', { class: 'aw-col aw-gap8 aw-mt2' },
          h('div', { class: 'aw-row' }, h('span', { class: 'aw-lbl aw-grow' }, h('span', {}, 'Recent activity '), count), h('span', { class: 'aw-chk' }, followCb, 'Follow newest'), clear),
          h('label', { class: 'aw-sr', for: 'aw-filter' }, 'Filter recent activity'), filterIn,
          t.el),
        h('p', { class: 'aw-hint aw-wrap' }, `Version ${opts.version} · Frame ${rt.origin} · Current-frame Fetch/XHR after launch only. Rules last for this page session; the latest ${LIMITS.records} requests are kept.`),
      ],
      refresh: () => refreshers.forEach((f) => f()),
    };
  }

  function moduleScreen(m: 'mock' | 'intercept'): Built {
    const badgeSlot = h('span', {});
    const act = activateButton(m);
    const rules = ruleList(m);
    const addBtn = h('button', { class: 'aw-btn aw-dash aw-w', type: 'button' }, icon('plus', 'aw-i aw-i14'), m === 'mock' ? 'Add ad-hoc rule' : 'Add rule');
    const addHint = h('span', { class: 'aw-hint' }, 'This build supports one rule per module.');
    addBtn.addEventListener('click', () => openEditor(m, true));
    const ruleCount = countBadge();
    const tCount = countBadge();
    const t = traffic((r) => r.ops.some((o) => o.module === m), MOD[m].empty, tCount);
    return {
      nodes: [
        h('div', { class: 'aw-row aw-gap10' }, tile(MOD[m].icon), heading(MOD[m].title), badgeSlot),
        h('p', { class: 'aw-hint' }, m === 'mock' ? 'Replies without contacting the server. Mock wins over Route for the same request.' : 'Replaces literal text in finite text Fetch responses (up to 1 MiB). Other responses are delivered unchanged with a reason.'),
        act.el,
        h('div', { class: 'aw-col aw-gap8' }, h('div', { class: 'aw-row' }, h('span', { class: 'aw-lbl' }, 'Ad-hoc rules'), ruleCount), rules.el, addBtn, addHint),
        h('div', { class: 'aw-col aw-gap8' }, h('div', { class: 'aw-row' }, h('span', { class: 'aw-lbl' }, MOD[m].traffic), tCount), t.el),
      ],
      refresh: () => {
        badgeSlot.replaceChildren(statusBadge(cfg()[m].active));
        act.refresh();
        rules.refresh();
        ruleCount.textContent = cfg()[m].rule ? '1' : '0';
        addBtn.hidden = !!cfg()[m].rule;
        addHint.hidden = !cfg()[m].rule;
        t.refresh();
      },
    };
  }

  function routeScreen(): Built {
    const summary = h('span', { class: 'aw-xs aw-mu' });
    const act = activateButton('route', true);
    const rules = ruleList('route');
    const formSlot = h('div', {});
    const addBtn = h('button', { class: 'aw-btn aw-dash aw-w', type: 'button' }, icon('plus', 'aw-i aw-i14'), 'Add page rule');
    addBtn.addEventListener('click', () => openEditor('route', true));
    const tCount = countBadge();
    const t = traffic((r) => r.ops.some((o) => o.module === 'route'), MOD.route.empty, tCount);
    if (editor?.module === 'route') formSlot.append(routeForm(editor as Editor<'route'>));
    return {
      nodes: [
        h('div', { class: 'aw-row aw-gap10' }, tile('route'), h('div', { class: 'aw-grow' }, heading('Page Routing'), h('div', { class: 'aw-xs aw-mu' }, 'This document’s fetch / XHR'))),
        h('div', { class: 'aw-row aw-between aw-top' }, summary, act.el),
        rules.el, formSlot, addBtn,
        h('div', { class: 'aw-col aw-gap8' }, h('div', { class: 'aw-row' }, h('span', { class: 'aw-lbl' }, MOD.route.traffic), tCount), t.el),
        h('div', { class: 'aw-row aw-hint aw-gap6' }, icon('info', 'aw-i aw-i14'), 'Routing changes the destination only; browser CORS and credential policies still apply.'),
      ],
      refresh: () => {
        summary.replaceChildren(h('span', { class: 'aw-fg' }, enabledText('route').split(' ')[0]!), ' rules enabled · ', h('span', { class: 'aw-fg' }, String(effectCount('route'))), ' requests routed');
        act.refresh();
        const editing = editor?.module === 'route';
        rules.el.hidden = editing;
        if (!editing) rules.refresh();
        addBtn.hidden = editing || !!cfg().route.rule;
        t.refresh();
      },
    };
  }

  function laterScreen(s: Screen): Built {
    const info = LATER[s]!;
    return { nodes: [h('div', { class: 'aw-row aw-gap10' }, tile(info.icon), heading(info.title), h('span', { class: 'aw-bd' }, 'Not in this build')), h('div', { class: 'aw-empty aw-wrap' }, info.text)] };
  }

  // ---------- request detail (S21.1/S21.2 R1 portion): one record by stable ID, read-only, sends nothing
  function detailScreen(): Built {
    const ret = detailRet ?? { screen: 'home', scroll: 0, listScroll: 0, focus: null };
    const id = detailId;
    const content = h('div', { class: 'aw-col aw-gap12 aw-detail' });
    let shown = '';
    const refresh = () => {
      const r = rt.records().find((x) => x.id === id);
      const sig = r ? `${r.outcome}|${r.status}|${r.responseType}|${r.ops.map((o) => o.state + o.reason).join()}|${r.notes.length}` : 'gone';
      if (sig === shown) return; // unchanged: keep any text selection
      shown = sig;
      content.replaceChildren(...(r ? detailBody(r) : [h('div', { class: 'aw-empty aw-wrap' },
        `Request #${id} is no longer retained. Recent activity keeps the latest ${LIMITS.records} requests, and Clear removes them. Nothing was re-sent.`)]));
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
    const mocked = r.ops.find((o) => o.module === 'mock' && o.state === 'applied');
    const transport = r.transport === 'fetch' ? 'Fetch' : `XHR${r.responseType ? ` · responseType ${r.responseType}` : ''}`;
    const effective = mocked ? 'Synthetic reply; nothing was sent'
      : routed && r.finalUrl ? `${r.method} ${r.finalUrl}${r.hasQuery ? ' (query preserved)' : ''}`
      : r.outcome === 'pending' && r.ops.some((o) => o.state === 'selected') ? 'Not decided yet'
      : 'Original URL sent';
    const outcome = r.outcome === 'pending' ? 'Pending — not complete'
      : `${r.outcome === 'ok' ? `HTTP ${r.status}` : r.outcome === 'error' ? 'Network error (rejected/failed)' : r.outcome === 'aborted' ? 'Aborted by the caller' : 'Timed out'}${r.elapsedMs !== undefined ? ` · ${r.elapsedMs} ms observed (includes Workbench waits; not server time)` : ''}`;
    const dl = (rows: [string, string][]) => h('dl', { class: 'aw-dl' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', { class: 'aw-mono' }, v)]));
    const section = (title: string, ...kids: Node[]) => h('section', { class: 'aw-col aw-gap6', 'aria-label': title }, h('h3', { class: 'aw-cap' }, title), ...kids);
    return [
      h('p', { class: 'aw-m0 aw-fg aw-wrap' }, `${headline(r)} · ${r.transport === 'fetch' ? 'Fetch' : `XHR ${r.responseType ?? ''}`.trim()} · ${mocked ? 'synthetic reply' : routed ? 'routed URL sent' : r.outcome === 'pending' ? 'in progress' : 'original URL sent'}`),
      section('Overview', dl([
        ['Source', `This frame (${rt.origin}) · page ${r.transport === 'fetch' ? 'fetch()' : 'XMLHttpRequest'}`],
        ['Transport', transport],
        ['Original', `${r.method} ${r.url}${r.hasQuery ? ' (query values not stored)' : ''}`],
        ['Effective', effective],
        ['Outcome', outcome],
        ['Config', `Revision ${r.revision}, captured when the request started`],
      ])),
      section('Why',
        r.ops.length ? h('ul', { class: 'aw-ops' }, ...r.ops.map((o) => {
          const tone = o.state === 'applied' ? 'aw-gr' : o.state === 'failed' ? 'aw-rd' : o.state === 'selected' ? 'aw-bl' : 'aw-am';
          return h('li', { class: 'aw-row' },
            h('span', { class: 'aw-bd' }, MOD[o.module].tab), h('span', { class: `aw-bd ${tone}` }, o.state),
            h('span', { class: 'aw-grow aw-wrap' }, o.rule ? h('span', { class: 'aw-fg' }, `${o.rule}: `) : '', o.reason),
            h('span', { class: 'aw-xs aw-mu aw-mono' }, o.at === undefined ? 'at start' : `+${o.at} ms`));
        })) : h('div', { class: 'aw-mu aw-wrap' }, 'No enabled rule in an active module matched; the request passed through natively.'),
        ...r.notes.map((n) => h('div', { class: 'aw-mu aw-wrap' }, n))),
      section('Bodies', h('div', { class: 'aw-mu aw-wrap' }, 'Request and response bodies are not captured in this build. Headers are not recorded either; nothing here was stored or re-sent.')),
    ];
  }

  // ---------- editors
  function openEditor(m: Module, isNew: boolean) {
    const ret = here();
    const existing = cfg()[m].rule;
    const draft = (isNew || !existing ? (m === 'mock' ? newMockRule() : m === 'route' ? newRouteRule() : newInterceptRule()) : { ...existing }) as RuleOf[Module];
    editor = { module: m, draft, base: JSON.stringify(draft), isNew: isNew || !existing, errors: {}, ret };
    screen = m;
    render();
  }

  /** After a successful save: back to where the editor was opened, focusing the saved rule when it is shown there. */
  function savedAndBack(ed: Editor) {
    editor = null;
    goBack(ed.ret, ed.ret.screen === ed.module ? `rule-${ed.module}` : ed.ret.focus);
  }

  const errEls = new Map<string, HTMLElement>();
  function field(id: string, name: string, label: string, input: HTMLElement, hint?: string) {
    const err = h('span', { class: 'aw-err', id: `${id}-err`, role: 'alert' });
    errEls.set(name, err);
    input.setAttribute('aria-describedby', `${id}-err`);
    return h('div', { class: 'aw-fld' }, h('label', { class: 'aw-lbl', for: id }, label), input, hint ? h('span', { class: 'aw-hint' }, hint) : null, err);
  }
  function bindText<T extends object>(draft: T, key: keyof T & string, id: string, o: { mono?: boolean; area?: boolean; placeholder?: string; number?: boolean } = {}) {
    const el = o.area ? h('textarea', { class: 'aw-ta', id, spellcheck: 'false' }) : h('input', { class: `aw-in${o.mono ? ' aw-mono' : ''}`, id, spellcheck: 'false', inputmode: o.number ? 'numeric' : undefined, placeholder: o.placeholder });
    el.value = String(draft[key] ?? '');
    el.addEventListener('input', () => {
      (draft as Record<string, unknown>)[key] = o.number ? (el.value.trim() === '' ? NaN : Number(el.value)) : el.value;
    });
    return el;
  }
  function methodSelect(draft: { method: string }) {
    const sel = h('select', { class: 'aw-in aw-select', id: 'aw-method' }, ...METHODS.map((m) => h('option', { value: m, selected: m === draft.method }, m === '*' ? '* (any)' : m)));
    sel.addEventListener('change', () => { draft.method = sel.value; });
    return sel;
  }
  function commonFields(ed: Editor) {
    const d = ed.draft;
    return [
      field('aw-label', 'label', 'Label', bindText(d, 'label', 'aw-label', { placeholder: `e.g. ${MOD[ed.module].tab} accounts` })),
      h('div', { class: 'aw-row aw-top' },
        h('div', { class: 'aw-w104' }, field('aw-method', 'method', 'Method', methodSelect(d))),
        h('div', { class: 'aw-grow' }, field('aw-path', 'path', 'URL pathname', bindText(d, 'path', 'aw-path', { mono: true }), `Exact path on ${rt.origin}; any query string matches.`))),
    ];
  }
  function enabledRow(ed: Editor) {
    return h('div', { class: 'aw-chk' }, checkbox('Rule enabled', ed.draft.enabled, (v) => { ed.draft.enabled = v; }), 'Rule enabled', h('span', { class: 'aw-mu' }, `— does not activate ${MOD[ed.module].tab}`));
  }
  function effectHint(m: Module) {
    return h('p', { class: 'aw-hint aw-wrap aw-m0' }, cfg()[m].active
      ? `${MOD[m].tab} is active: saving an enabled rule affects the next matching request.`
      : `${MOD[m].tab} is inactive: saving does not change traffic until you activate it.`);
  }

  function editorScreen(ed: Editor<'mock' | 'intercept'>): Built {
    errEls.clear();
    const body: Node[] = [h('div', { class: 'aw-row' }, backButton(ed.ret.screen, leaveEditor), heading(`${ed.isNew ? 'New' : 'Edit'} ${MOD[ed.module].noun}`)), ...commonFields(ed)];
    if (ed.module === 'mock') {
      const d = ed.draft as MockRule;
      body.push(h('section', { class: 'aw-card aw-cp aw-col aw-gap12' }, h('div', { class: 'aw-h aw-h13' }, 'Response'),
        h('div', { class: 'aw-g3' },
          field('aw-status', 'status', 'Status', bindText(d, 'status', 'aw-status', { mono: true, number: true })),
          field('aw-delay', 'delayMs', 'Delay (ms)', bindText(d, 'delayMs', 'aw-delay', { mono: true, number: true })),
          field('aw-ct', 'contentType', 'Content-Type', bindText(d, 'contentType', 'aw-ct', { mono: true }))),
        field('aw-body', 'body', 'Body', bindText(d, 'body', 'aw-body', { area: true }), 'Sent exactly as typed. HEAD, 204 and 304 replies have no body.')));
    } else {
      const d = ed.draft as InterceptRule;
      body.push(h('section', { class: 'aw-card aw-cp aw-col aw-gap12' }, h('div', { class: 'aw-h aw-h13' }, 'Response transform'),
        h('div', { class: 'aw-g2 aw-gap10' }, field('aw-find', 'find', 'Body find', bindText(d, 'find', 'aw-find', { mono: true })), field('aw-replace', 'replace', 'Replace', bindText(d, 'replace', 'aw-replace', { mono: true }))),
        h('p', { class: 'aw-hint aw-m0' }, 'Literal text, every occurrence. Binary, streaming, opaque or over-1 MiB responses are delivered unchanged and the reason is shown.')));
    }
    body.push(enabledRow(ed), effectHint(ed.module));

    const save = h('button', { class: 'aw-btn aw-pri aw-grow', type: 'button' }, icon('save', 'aw-i aw-i14'), 'Save');
    save.addEventListener('click', () => { if (commitEditor()) savedAndBack(ed); });
    const second = ed.isNew
      ? h('button', { class: 'aw-btn aw-out aw-grow', type: 'button' }, 'Cancel')
      : h('button', { class: 'aw-btn aw-dst aw-grow', type: 'button' }, icon('trash', 'aw-i aw-i14'), 'Delete');
    second.addEventListener('click', () => (ed.isNew ? leaveEditor() : deleteRule(ed.module)));
    foot.replaceChildren(save, second);
    foot.hidden = false;
    return { nodes: body };
  }

  function routeForm(ed: Editor<'route'>): HTMLElement {
    errEls.clear();
    const d = ed.draft;
    const save = h('button', { class: 'aw-btn aw-pri', type: 'button' }, icon('save', 'aw-i aw-i14'), 'Save rule');
    save.addEventListener('click', () => { if (commitEditor()) savedAndBack(ed); });
    const cancel = h('button', { class: 'aw-btn aw-out', type: 'button' }, 'Cancel');
    cancel.addEventListener('click', leaveEditor);
    const actions = h('div', { class: 'aw-row' }, save, cancel);
    if (!ed.isNew) {
      const del = h('button', { class: 'aw-btn aw-dst aw-push', type: 'button' }, icon('trash', 'aw-i aw-i14'), 'Delete');
      del.addEventListener('click', () => deleteRule('route'));
      actions.append(del);
    }
    const head = h('div', { class: 'aw-row' }, heading(ed.isNew ? 'New page rule' : 'Edit page rule', 'aw-h aw-h13'));
    if (ed.ret.screen !== 'route') head.prepend(backButton(ed.ret.screen, leaveEditor));
    return h('section', { class: 'aw-card aw-cp aw-col aw-gap12' },
      head,
      h('div', { class: 'aw-g2' },
        field('aw-label', 'label', 'Label', bindText(d, 'label', 'aw-label', { placeholder: 'e.g. Local wires API' })),
        field('aw-method', 'method', 'Method (* = any)', methodSelect(d)),
        field('aw-path', 'path', 'URL pathname', bindText(d, 'path', 'aw-path', { mono: true }), `Exact path on ${rt.origin}`),
        field('aw-dest', 'destinationOrigin', 'Destination origin', bindText(d, 'destinationOrigin', 'aw-dest', { mono: true, placeholder: 'http://localhost:8080' })),
        field('aw-rewrite', 'pathRewrite', 'Path rewrite', bindText(d, 'pathRewrite', 'aw-rewrite', { mono: true, placeholder: 'Blank = original path' }))),
      h('div', { class: 'aw-col aw-gap10 aw-mt2' }, enabledRow(ed)),
      h('p', { class: 'aw-hint aw-m0 aw-wrap' }, 'The original query is kept. Credentials follow the caller; Authorization is removed when the destination is another origin.'),
      effectHint('route'),
      actions);
  }

  /** Validate and install the draft. Returns false (and shows errors) when invalid. */
  function commitEditor(): boolean {
    if (!editor) return true;
    const ed = editor;
    const d = { ...ed.draft, label: ed.draft.label.trim(), path: ed.draft.path.trim() } as RuleOf[Module];
    if (ed.module === 'route') {
      const r = d as RouteRule;
      r.destinationOrigin = r.destinationOrigin.trim().replace(/\/$/, '');
      r.pathRewrite = r.pathRewrite.trim();
    }
    const errors = ed.module === 'mock' ? validateMockRule(d as MockRule) : ed.module === 'route' ? validateRouteRule(d as RouteRule) : validateInterceptRule(d as InterceptRule);
    for (const [k, el] of errEls) el.textContent = errors[k] ?? '';
    for (const [k, el] of errEls) {
      const input = root.getElementById(el.id.replace(/-err$/, ''));
      input?.toggleAttribute('aria-invalid', !!errors[k]);
    }
    const first = Object.keys(errors)[0];
    if (first) {
      announce(`Not saved: ${errors[first]}`);
      (root.getElementById(errEls.get(first)!.id.replace(/-err$/, '')) as HTMLElement | null)?.focus();
      return false;
    }
    if (ed.module === 'route') d.label ||= '';
    setModule(ed.module, { rule: Object.freeze(d) } as Partial<Config[Module]>);
    announce(`Rule saved.${cfg()[ed.module].active && d.enabled ? ' It applies to the next matching request.' : ''}`);
    return true;
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
      unsubscribe();
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
