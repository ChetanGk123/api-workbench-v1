// Workbench panel following design/reference/screens: title bar, six module tabs, Home cards,
// Mock/Intercept/Route screens with rule editors, traffic lists, and the minimized launcher.
// Only R0 capabilities are wired; later modules state that they are not in this build.
import {
  METHODS, newInterceptRule, newMockRule, newRouteRule, validateInterceptRule, validateMockRule, validateRouteRule,
  type Config, type Errors, type InterceptRule, type MockRule, type Module, type Op, type RouteRule,
} from '../net/plan';
import type { ReqRecord, Runtime } from '../net/runtime';
import { h, icon, type IconName } from './dom';
import themeCss from '../../design/reference/aw-theme.css';
import panelCss from './panel.css';

export interface Panel {
  restore(): void;
  notice(text: string): void;
  destroy(): void;
}

type RuleOf = { mock: MockRule; intercept: InterceptRule; route: RouteRule };
type Screen = 'home' | 'test' | Module | 'chaos' | 'endpoints' | 'import' | 'settings';
interface Editor<M extends Module = Module> {
  module: M;
  draft: RuleOf[M];
  base: string;
  isNew: boolean;
  errors: Errors;
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
const LATER: Partial<Record<Screen, { title: string; icon: IconName; text: string }>> = {
  test: { title: 'API Tester', icon: 'flask', text: 'Saved endpoints, Once and plans are not in this build. Once arrives with endpoints (R2); plans and results follow in R6.' },
  chaos: { title: 'Chaos Engineering', icon: 'flame', text: 'Latency, faults and replay rules are not in this build. They arrive with the rule modules (R4).' },
  endpoints: { title: 'Endpoints', icon: 'book', text: 'Saved endpoints, headers and environments are not in this build. They arrive in R2.' },
  import: { title: 'Import', icon: 'import', text: 'Recorder, native and HAR import arrive in R3; Swagger/OpenAPI/Postman/cURL/fetch in R7.' },
  settings: { title: 'Settings', icon: 'settings', text: 'Profiles, storage, limits and backup arrive in R2. This build keeps rules for the current page session only; reload clears them.' },
};
const SHOWN = 50;

export function mountPanel(rt: Runtime, opts: { version: string; onClose(): void }): Panel {
  const life = new AbortController();
  const on = <E extends Event = Event>(el: EventTarget, type: string, fn: (e: E) => void) => el.addEventListener(type, fn as EventListener, { signal: life.signal });

  const host = document.createElement('div');
  host.setAttribute('data-api-workbench', opts.version);
  for (const [k, v] of [['all', 'initial'], ['position', 'fixed'], ['top', '16px'], ['right', '16px'], ['z-index', '2147483647']]) host.style.setProperty(k!, v!);
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
  const expanded = new Set<number>();
  let follow = true;

  // ---------- chrome
  const iconBtn = (name: IconName, label: string) => h('button', { class: 'aw-btn aw-gh aw-ic aw-sm', type: 'button', 'aria-label': label, title: label }, icon(name));
  const indicators = h('span', { class: 'aw-row aw-inds' });
  const settingsBtn = iconBtn('settings', 'Settings');
  const importBtn = iconBtn('import', 'Import');
  const minimizeBtn = iconBtn('minus', 'Minimize');
  const closeBtn = iconBtn('x', 'Close API Workbench and remove its hooks');
  const header = h('header', { class: 'aw-tb' },
    h('div', { class: 'aw-logo' }, icon('bolt', 'aw-i aw-i14')),
    h('div', { class: 'aw-brand', title: `API Workbench ${opts.version} · ${rt.origin}` }, 'API Workbench'),
    indicators, h('div', { class: 'aw-grow' }), settingsBtn, importBtn, minimizeBtn, closeBtn);

  const tabBtns = new Map<Screen, { btn: HTMLButtonElement; dot: HTMLElement }>();
  const tl = h('div', { class: 'aw-tl' });
  for (const t of TABS) {
    const dot = h('span', { class: 'aw-d aw-dg', hidden: true });
    const btn = h('button', { class: 'aw-tt', type: 'button' }, icon(t.icon, 'aw-i aw-i14'), t.label, dot);
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
  on(launcherClose, 'click', opts.onClose);
  on(panel, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && editor && !dialog.open) {
      // Prevent the browser's Escape default from closing the dialog we are about to open.
      e.preventDefault();
      e.stopPropagation();
      const m = editor.module;
      setTimeout(() => go(m));
    }
  });

  // ---------- config helpers
  const cfg = () => rt.config();
  function setModule<M extends Module>(m: M, patch: Partial<Config[M]>) {
    rt.setConfig({ ...cfg(), [m]: { ...cfg()[m], ...patch } });
  }
  const announce = (text: string) => { status.textContent = text; };
  const activeModules = () => (['mock', 'intercept', 'route'] as Module[]).filter((m) => cfg()[m].active);

  // ---------- navigation and draft guard
  function go(next: Screen) {
    guard(() => {
      editor = null;
      screen = next;
      render();
    });
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
  function render() {
    live = null;
    foot.replaceChildren();
    foot.hidden = true;
    const built = editor && editor.module !== 'route' ? editorScreen(editor as Editor<'mock' | 'intercept'>)
      : screen === 'home' ? homeScreen()
      : screen === 'mock' || screen === 'intercept' ? moduleScreen(screen)
      : screen === 'route' ? routeScreen()
      : laterScreen(screen);
    main.replaceChildren(...built.nodes);
    live = built.refresh ?? null;
    main.scrollTop = 0;
    refreshChrome();
    live?.();
    (main.querySelector('[data-focus]') as HTMLElement | null)?.focus();
  }

  function refreshChrome() {
    const act = activeModules();
    const current: Screen = editor ? editor.module : screen;
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
    launcherState.textContent = act.length ? '' : 'No modules active';
    if (!editor || editor.module === 'route') {
      foot.hidden = act.length === 0;
      if (act.length) {
        const stop = h('button', { class: 'aw-btn aw-out aw-sm', type: 'button' }, icon('stop', 'aw-i aw-i12'), 'Stop all');
        stop.addEventListener('click', stopAll);
        foot.replaceChildren(h('span', { class: 'aw-xs aw-mu aw-grow' }, `Active: ${act.map((m) => MOD[m].tab).join(', ')}`), stop);
      }
    }
  }

  function stopAll() {
    rt.setConfig({ ...cfg(), mock: { ...cfg().mock, active: false }, intercept: { ...cfg().intercept, active: false }, route: { ...cfg().route, active: false } });
    announce('All modules deactivated. Requests already in progress keep their selected behavior.');
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
    btn.addEventListener('click', () => {
      const active = !cfg()[m].active;
      setModule(m, { active });
      announce(`${MOD[m].tab} module ${active ? 'activated' : 'deactivated'}.`);
    });
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
      const name = ruleSummary(m, r);
      const meta = h('span', { class: 'aw-row aw-mono aw-meta' }, methodBadge(r.method), h('span', { class: 'aw-tr' }, r.path));
      if (m === 'mock') meta.append(h('span', { class: 'aw-arrow' }, '→'), h('span', { class: `aw-bd ${(r as MockRule).status < 400 ? 'aw-gr' : 'aw-rd'} aw-h18` }, String((r as MockRule).status)));
      if (m === 'route') meta.append(h('span', { class: 'aw-arrow' }, '→'), h('span', { class: 'aw-tr' }, (r as RouteRule).destinationOrigin + ((r as RouteRule).pathRewrite || '')));
      const open = h('button', { class: 'aw-grow aw-col aw-rulebtn', type: 'button', 'aria-label': `Edit ${name}` }, h('span', { class: 'aw-rname' }, name), meta);
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
      setModule(m, { rule: null, active: false });
      editor = null;
      screen = m;
      render();
      announce('Rule deleted; module deactivated.');
    });
  }

  // ---------- traffic lists (shared by Home and module screens)
  function traffic(filter: (r: ReqRecord) => boolean, empty: string, badge?: HTMLElement) {
    const list = h('ol', { class: 'aw-card aw-list aw-traffic', 'aria-label': 'Requests, newest first' });
    const emptyEl = h('div', { class: 'aw-empty' }, empty);
    const more = h('div', { class: 'aw-hint' });
    const el = h('div', { class: 'aw-col aw-gap8' }, emptyEl, list, more);
    list.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest('button[data-id]');
      if (!btn) return;
      const id = Number(btn.getAttribute('data-id'));
      expanded.has(id) ? expanded.delete(id) : expanded.add(id);
      refresh();
      (list.querySelector(`button[data-id="${id}"]`) as HTMLElement | null)?.focus();
    });
    const refresh = () => {
      const all = rt.records().filter(filter);
      if (badge) badge.textContent = String(all.length);
      const shown = all.slice(-SHOWN).reverse();
      emptyEl.hidden = shown.length > 0;
      list.hidden = shown.length === 0;
      more.textContent = all.length > SHOWN ? `Showing latest ${SHOWN} of ${all.length}` : '';
      const focused = root.activeElement?.closest?.('button[data-id]')?.getAttribute('data-id');
      const top = list.scrollTop;
      list.replaceChildren(...shown.map(row));
      list.scrollTop = follow ? 0 : top;
      if (focused) (list.querySelector(`button[data-id="${focused}"]`) as HTMLElement | null)?.focus();
    };
    return { el, refresh };
  }

  function row(r: ReqRecord): HTMLElement {
    const open = expanded.has(r.id);
    const effect = r.ops.find((o) => o.state === 'applied');
    const skipped = r.ops.some((o) => o.state === 'skipped' || o.state === 'failed');
    const tone = r.outcome === 'pending' ? 'aw-am' : r.outcome === 'ok' && (r.status ?? 0) < 400 ? 'aw-gr' : 'aw-rd';
    const summary = h('button', { class: 'aw-li aw-actrow', type: 'button', 'data-id': String(r.id), 'aria-expanded': String(open) },
      methodBadge(r.method),
      h('span', { class: 'aw-tr aw-grow aw-mono aw-xs' }, pathOf(r.url) + (r.hasQuery ? '?…' : '')),
      effect && h('span', { class: 'aw-bd aw-gr aw-h18' }, MOD[effect.module].tab),
      skipped && h('span', { class: 'aw-bd aw-am aw-h18' }, 'skipped'),
      h('span', { class: `aw-bd ${tone} aw-h18` }, r.outcome === 'ok' ? String(r.status) : r.outcome));
    if (!open) return h('li', {}, summary);
    const lines = [
      `Request #${r.id} · ${r.transport.toUpperCase()}${r.responseType ? ` ${r.responseType}` : ''} · config revision ${r.revision}`,
      `Original ${r.method} ${r.url}${r.hasQuery ? ' (query values hidden)' : ''}`,
      r.finalUrl ? `Effective ${r.finalUrl}` : r.provider === 'mock' ? 'Effective: synthetic reply, nothing dispatched' : 'Effective: original URL',
      `Outcome ${r.outcome}${r.status !== undefined ? ` · HTTP ${r.status}` : ''}${r.elapsedMs !== undefined ? ` · ${r.elapsedMs} ms observed (includes waits)` : ''}`,
      'Bodies: not recorded in this build',
    ];
    return h('li', {}, summary,
      h('div', { class: 'aw-detail aw-col aw-gap4 aw-xs' },
        ...lines.map((l) => h('div', { class: 'aw-mono aw-wrap' }, l)),
        r.ops.length ? h('ul', { class: 'aw-ops' }, ...r.ops.map(opLine)) : h('div', { class: 'aw-mu' }, 'No rule matched; passed through natively.'),
        ...r.notes.map((n) => h('div', { class: 'aw-mu' }, n))));
  }

  function opLine(o: Op) {
    const tone = o.state === 'applied' ? 'aw-gr' : o.state === 'failed' ? 'aw-rd' : o.state === 'selected' ? 'aw-bl' : 'aw-am';
    return h('li', { class: 'aw-row' }, h('span', { class: 'aw-bd' }, MOD[o.module].tab), h('span', { class: `aw-bd ${tone}` }, o.state), h('span', { class: 'aw-grow' }, o.reason));
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
      const sub = h('div', { class: 'aw-xs aw-mu' });
      const openBtn = h('button', { class: 'aw-btn aw-gh aw-sm', type: 'button', 'aria-label': `Open ${MOD[m].home}` }, 'Open', icon('chevronRight', 'aw-i aw-i14'));
      const manage = h('button', { class: 'aw-btn aw-out aw-sm', type: 'button' }, 'Manage rules');
      openBtn.addEventListener('click', () => go(m));
      manage.addEventListener('click', () => go(m));
      refreshers.push(() => {
        badgeSlot.replaceChildren(statusBadge(cfg()[m].active));
        sub.textContent = `${enabledText(m)} · ${effectCount(m)} ${MOD[m].effect}`;
      });
      return h('section', { class: 'aw-card aw-cp aw-col aw-gap12' },
        h('div', { class: 'aw-row aw-gap10' }, tile(MOD[m].icon), h('div', { class: 'aw-grow' }, h('div', { class: 'aw-row aw-gap8' }, h('span', { class: 'aw-h' }, MOD[m].home), badgeSlot), sub), openBtn),
        h('div', { class: 'aw-row' }, manage));
    };
    const qa = (label: string, iconName: IconName, target: Screen) => {
      const b = h('button', { class: 'aw-qa', type: 'button' }, icon(iconName), h('span', {}, label));
      b.addEventListener('click', () => go(target));
      return b;
    };
    const count = countBadge();
    const t = traffic(() => true, 'No requests yet. Page Fetch/XHR calls made after launch appear here.', count);
    refreshers.push(t.refresh);
    const followCb = checkbox('Follow newest', follow, (v) => { follow = v; t.refresh(); });
    const clear = h('button', { class: 'aw-btn aw-gh aw-sm', type: 'button' }, 'Clear');
    clear.addEventListener('click', () => { expanded.clear(); rt.clearRecords(); });
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
          t.el),
        h('p', { class: 'aw-hint aw-wrap' }, `Version ${opts.version} · Frame ${rt.origin} · Current-frame Fetch/XHR after launch only. Rules last for this page session.`),
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

  // ---------- editors
  function openEditor(m: Module, isNew: boolean) {
    const existing = cfg()[m].rule;
    const draft = (isNew || !existing ? (m === 'mock' ? newMockRule() : m === 'route' ? newRouteRule() : newInterceptRule()) : { ...existing }) as RuleOf[Module];
    editor = { module: m, draft, base: JSON.stringify(draft), isNew: isNew || !existing, errors: {} };
    screen = m;
    render();
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
    const back = h('button', { class: 'aw-btn aw-gh aw-sm aw-back', type: 'button', 'aria-label': `Back to ${MOD[ed.module].tab}` }, icon('back', 'aw-i aw-i14'), 'Back');
    back.addEventListener('click', () => go(ed.module));
    const body: Node[] = [h('div', { class: 'aw-row' }, back, heading(`${ed.isNew ? 'New' : 'Edit'} ${MOD[ed.module].noun}`)), ...commonFields(ed)];
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
    save.addEventListener('click', () => { if (commitEditor()) { editor = null; render(); } });
    const second = ed.isNew
      ? h('button', { class: 'aw-btn aw-out aw-grow', type: 'button' }, 'Cancel')
      : h('button', { class: 'aw-btn aw-dst aw-grow', type: 'button' }, icon('trash', 'aw-i aw-i14'), 'Delete');
    second.addEventListener('click', () => (ed.isNew ? go(ed.module) : deleteRule(ed.module)));
    foot.replaceChildren(save, second);
    foot.hidden = false;
    return { nodes: body };
  }

  function routeForm(ed: Editor<'route'>): HTMLElement {
    errEls.clear();
    const d = ed.draft;
    const save = h('button', { class: 'aw-btn aw-pri', type: 'button' }, icon('save', 'aw-i aw-i14'), 'Save rule');
    save.addEventListener('click', () => { if (commitEditor()) { editor = null; render(); } });
    const cancel = h('button', { class: 'aw-btn aw-out', type: 'button' }, 'Cancel');
    cancel.addEventListener('click', () => go('route'));
    const actions = h('div', { class: 'aw-row' }, save, cancel);
    if (!ed.isNew) {
      const del = h('button', { class: 'aw-btn aw-dst aw-push', type: 'button' }, icon('trash', 'aw-i aw-i14'), 'Delete');
      del.addEventListener('click', () => deleteRule('route'));
      actions.append(del);
    }
    return h('section', { class: 'aw-card aw-cp aw-col aw-gap12' },
      heading(ed.isNew ? 'New page rule' : 'Edit page rule', 'aw-h aw-h13'),
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

  // ---------- minimize / restore
  function minimize() {
    panel.hidden = true;
    launcher.hidden = false;
    restoreBtn.focus();
  }
  function restore() {
    launcher.hidden = true;
    panel.hidden = false;
    (main.querySelector('[data-focus]') as HTMLElement | null)?.focus();
  }

  render();

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
