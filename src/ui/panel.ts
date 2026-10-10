// R0 status panel: version/origin, one-endpoint Mock/Route/Transform controls, bounded activity, Minimize/Restore/Close.
import { validateDelay, validateDestination, validateMockStatus, type Config, type Op } from '../net/plan';
import type { ReqRecord, Runtime } from '../net/runtime';
import { h, icon } from './dom';
import themeCss from '../../design/reference/aw-theme.css';
import panelCss from './panel.css';

const SHOWN = 50;

export interface Panel {
  restore(): void;
  notice(text: string): void;
  destroy(): void;
}

export function mountPanel(rt: Runtime, opts: { version: string; onClose(): void }): Panel {
  const life = new AbortController();
  const on = <E extends Event>(el: EventTarget, type: string, fn: (e: E) => void) => el.addEventListener(type, fn as EventListener, { signal: life.signal });

  const host = document.createElement('div');
  host.setAttribute('data-api-workbench', opts.version);
  const hs = host.style;
  hs.setProperty('all', 'initial');
  hs.setProperty('position', 'fixed');
  hs.setProperty('top', '16px');
  hs.setProperty('right', '16px');
  hs.setProperty('z-index', '2147483647');
  const root = host.attachShadow({ mode: 'open' });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(themeCss + '\n' + panelCss);
    root.adoptedStyleSheets = [sheet];
  } catch {
    root.append(h('style', {}, themeCss + '\n' + panelCss));
  }

  // ---- Title bar
  const minimizeBtn = h('button', { class: 'aw-btn aw-gh aw-ic aw-sm', type: 'button', 'aria-label': 'Minimize API Workbench' }, icon('minus'));
  const closeBtn = h('button', { class: 'aw-btn aw-gh aw-ic aw-sm', type: 'button', 'aria-label': 'Close API Workbench and remove its hooks' }, icon('x'));
  const titlebar = h(
    'header',
    { class: 'aw-tb' },
    h('div', { class: 'aw-logo' }, icon('bolt', 'aw-i aw-i14')),
    h('div', { class: 'aw-grow aw-col aw-gap0' },
      h('div', { class: 'aw-row' }, h('span', { class: 'aw-brand' }, 'API Workbench'), h('span', { class: 'aw-bd aw-mono' }, opts.version)),
      h('span', { class: 'aw-xs aw-mu aw-tr', title: rt.origin }, `Frame ${rt.origin}`)),
    minimizeBtn,
    closeBtn,
  );

  const noticeEl = h('div', { class: 'aw-alert', role: 'status', hidden: true });

  // ---- Controls (rendered once; never rebuilt on traffic)
  const cfg = rt.config();
  const pathIn = h('input', { class: 'aw-in aw-mono', id: 'aw-path', value: cfg.path, spellcheck: 'false' });
  const pathErr = h('span', { class: 'aw-err', role: 'alert' });

  const mockSw = switchEl('Mock module active');
  const statusIn = h('input', { class: 'aw-in aw-mono', id: 'aw-status', inputmode: 'numeric', value: String(cfg.mock.status) });
  const ctIn = h('input', { class: 'aw-in aw-mono', id: 'aw-ct', value: cfg.mock.contentType });
  const bodyIn = h('textarea', { class: 'aw-ta', id: 'aw-body', spellcheck: 'false' });
  bodyIn.value = cfg.mock.body;
  const delayIn = h('input', { class: 'aw-in aw-mono', id: 'aw-delay', inputmode: 'numeric', value: String(cfg.mock.delayMs) });
  const mockErr = h('span', { class: 'aw-err', role: 'alert' });

  const routeSw = switchEl('Route module active');
  const destIn = h('input', { class: 'aw-in aw-mono', id: 'aw-dest', placeholder: 'http(s)://host/path', spellcheck: 'false' });
  const destErr = h('span', { class: 'aw-err', role: 'alert' });

  const tfSw = switchEl('Response transform active');
  const findIn = h('input', { class: 'aw-in aw-mono', id: 'aw-find', spellcheck: 'false' });
  const replIn = h('input', { class: 'aw-in aw-mono', id: 'aw-repl', spellcheck: 'false' });

  const card = (title: string, sw: HTMLElement | null, hint: string, ...rows: HTMLElement[]) =>
    h('section', { class: 'aw-card aw-cp aw-col' }, h('div', { class: 'aw-row' }, h('h2', { class: 'aw-h aw-grow' }, title), sw), h('p', { class: 'aw-hint' }, hint), ...rows);
  const field = (label: string, input: HTMLElement, extra?: HTMLElement) =>
    h('div', { class: 'aw-fld' }, h('label', { class: 'aw-lbl', for: input.id }, label), input, extra);

  const controls = h(
    'div',
    { class: 'aw-col aw-gap12' },
    card('Endpoint', null, `Rules below apply only to this exact path on ${rt.origin}. All modules start inactive.`, field('Path', pathIn, pathErr)),
    card('Mock', mockSw, 'Replies without contacting the server. Mock wins over Route.',
      h('div', { class: 'aw-g2' }, field('Status', statusIn), field('Delay (ms, 0–10000)', delayIn)),
      field('Content-Type', ctIn), field('Body', bodyIn), mockErr),
    card('Route', routeSw, 'Sends the request to another URL; the original query is kept. Authorization is removed for another origin. Routing does not bypass CORS.',
      field('Destination URL', destIn, destErr)),
    card('Response transform', tfSw, 'Replaces literal text in finite text Fetch responses up to 1 MiB. Other responses are delivered unchanged with a reason.',
      h('div', { class: 'aw-g2' }, field('Find', findIn), field('Replace with', replIn))),
  );

  // ---- Activity
  const follow = h('input', { type: 'checkbox', id: 'aw-follow', checked: true });
  const clearBtn = h('button', { class: 'aw-btn aw-gh aw-sm', type: 'button' }, 'Clear');
  const countEl = h('span', { class: 'aw-xs aw-mu' });
  const list = h('ol', { class: 'aw-act', 'aria-label': 'Request activity, newest first' });
  const activity = h(
    'section',
    { class: 'aw-col' },
    h('div', { class: 'aw-row' }, h('h2', { class: 'aw-cap aw-grow' }, 'Activity'), countEl,
      h('label', { class: 'aw-chk', for: 'aw-follow' }, follow, 'Follow newest'), clearBtn),
    list,
  );

  const stopBtn = h('button', { class: 'aw-btn aw-out aw-sm', type: 'button' }, icon('stop', 'aw-i aw-i12'), 'Stop all');
  const statusLine = h('span', { class: 'aw-xs aw-mu aw-grow', 'aria-live': 'polite' });
  const foot = h('footer', { class: 'aw-foot' }, statusLine, stopBtn);

  const panel = h('div', { class: 'aw-root aw-panel', role: 'region', 'aria-label': 'API Workbench' }, titlebar, h('div', { class: 'aw-scroll' }, noticeEl, controls, activity), foot);

  // ---- Launcher
  const launcherLabel = h('span', { class: 'aw-tr' });
  const restoreBtn = h('button', { class: 'aw-btn aw-gh aw-sm', type: 'button', 'aria-label': 'Restore API Workbench' }, icon('restore', 'aw-i aw-i14'), launcherLabel);
  const launcherClose = h('button', { class: 'aw-btn aw-gh aw-ic aw-sm', type: 'button', 'aria-label': 'Close API Workbench and remove its hooks' }, icon('x'));
  const launcher = h('div', { class: 'aw-root aw-launcher', role: 'region', 'aria-label': 'API Workbench minimized', hidden: true }, h('div', { class: 'aw-logo' }, icon('bolt', 'aw-i aw-i14')), restoreBtn, launcherClose);

  root.append(panel, launcher);
  document.documentElement.append(host);

  // ---- Behavior
  function update(mut: (c: { -readonly [K in keyof Config]: Config[K] }) => void) {
    const next = { ...rt.config(), mock: { ...rt.config().mock }, route: { ...rt.config().route }, transform: { ...rt.config().transform } };
    mut(next);
    rt.setConfig(next);
    renderState();
  }

  function readMock() {
    const status = Number(statusIn.value);
    const delay = Number(delayIn.value);
    const err = validateMockStatus(status) ?? validateDelay(delay);
    mockErr.textContent = err ?? '';
    if (err) return;
    update((c) => { c.mock = { ...c.mock, status, delayMs: delay, contentType: ctIn.value.trim() || 'text/plain', body: bodyIn.value }; });
  }
  for (const el of [statusIn, delayIn, ctIn, bodyIn]) on(el, 'input', readMock);

  on(pathIn, 'input', () => {
    const v = pathIn.value.trim();
    const ok = v.startsWith('/') && !/[?#\s]/.test(v);
    pathErr.textContent = ok ? '' : 'Enter a pathname starting with / (no query or fragment)';
    if (ok) update((c) => { c.path = v; });
  });
  on(destIn, 'input', () => {
    const r = validateDestination(destIn.value);
    destErr.textContent = r.ok || !destIn.value ? '' : r.error;
    update((c) => { c.route = { ...c.route, destination: r.ok ? r.href : '' }; });
  });
  const readTf = () => update((c) => { c.transform = { ...c.transform, find: findIn.value, replace: replIn.value }; });
  on(findIn, 'input', readTf);
  on(replIn, 'input', readTf);

  on(mockSw, 'click', () => update((c) => { c.mock = { ...c.mock, active: !c.mock.active }; }));
  on(routeSw, 'click', () => update((c) => { c.route = { ...c.route, active: !c.route.active }; }));
  on(tfSw, 'click', () => update((c) => { c.transform = { ...c.transform, active: !c.transform.active }; }));
  on(stopBtn, 'click', stopAll);

  function stopAll() {
    update((c) => {
      c.mock = { ...c.mock, active: false };
      c.route = { ...c.route, active: false };
      c.transform = { ...c.transform, active: false };
    });
  }

  function activeNames() {
    const c = rt.config();
    return [c.mock.active && 'Mock', c.route.active && 'Route', c.transform.active && 'Transform'].filter(Boolean) as string[];
  }

  function renderState() {
    const c = rt.config();
    setSwitch(mockSw, c.mock.active);
    setSwitch(routeSw, c.route.active);
    setSwitch(tfSw, c.transform.active);
    const names = activeNames();
    statusLine.textContent = names.length ? `Active: ${names.join(', ')} · config revision ${c.revision}` : `No modules active · config revision ${c.revision}`;
    stopBtn.hidden = names.length === 0;
    launcherLabel.textContent = names.length ? `AW · ${names.join(', ')} active` : 'AW · no modules active';
    if (c.route.active && !c.route.destination) destErr.textContent = 'Route is active but has no valid destination; matching requests are sent unchanged';
  }

  // Activity: coalesced to one frame; only the list is rebuilt.
  const expanded = new Set<number>();
  let frame = 0;
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => renderActivity()); };
  const unsubscribe = rt.subscribe(schedule);
  on(follow, 'change', schedule);
  on(clearBtn, 'click', () => { expanded.clear(); rt.clearRecords(); });
  on(list, 'click', (e: MouseEvent) => {
    const btn = (e.target as Element).closest('button[data-id]');
    if (!btn) return;
    const id = Number(btn.getAttribute('data-id'));
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    renderActivity(true);
  });

  function renderActivity(keepFocus = false) {
    frame = 0;
    const all = rt.records();
    const shown = all.slice(-SHOWN).reverse();
    countEl.textContent = all.length > SHOWN ? `latest ${SHOWN} of ${all.length}` : `${all.length}`;
    const focusedId = keepFocus || root.activeElement?.closest?.('button[data-id]') ? root.activeElement?.getAttribute('data-id') : null;
    const top = list.scrollTop;
    list.replaceChildren(...(shown.length ? shown.map(row) : [h('li', { class: 'aw-empty' }, 'No requests yet. Matching and unmatched page Fetch/XHR calls appear here.')]));
    if (follow.checked) list.scrollTop = 0;
    else list.scrollTop = top;
    if (focusedId) (list.querySelector(`button[data-id="${focusedId}"]`) as HTMLElement | null)?.focus();
  }

  function row(r: ReqRecord): HTMLElement {
    const open = expanded.has(r.id);
    const effect = r.ops.find((o) => o.state === 'applied');
    const skipped = r.ops.some((o) => o.state === 'skipped' || o.state === 'failed');
    const outcome = r.outcome === 'ok' ? `${r.status}` : r.outcome;
    const tone = r.outcome === 'pending' ? 'aw-am' : r.outcome === 'ok' && (r.status ?? 0) < 400 ? 'aw-gr' : 'aw-rd';
    const summary = h('button', { class: 'aw-actrow', type: 'button', 'data-id': String(r.id), 'aria-expanded': String(open) },
      h('span', { class: `aw-bd aw-m aw-${r.method}` }, r.method),
      h('span', { class: 'aw-tr aw-grow aw-mono aw-xs' }, pathOf(r.url) + (r.hasQuery ? '?…' : '')),
      effect && h('span', { class: 'aw-bd aw-gr' }, labelOf(effect.module)),
      skipped && h('span', { class: 'aw-bd aw-am' }, 'skipped'),
      h('span', { class: `aw-bd ${tone}` }, outcome));
    if (!open) return h('li', {}, summary);
    const lines = [
      `Request #${r.id} · ${r.transport.toUpperCase()}${r.responseType ? ` ${r.responseType}` : ''} · config revision ${r.revision}`,
      `Original ${r.method} ${r.url}${r.hasQuery ? ' (query values hidden)' : ''}`,
      r.finalUrl ? `Effective ${r.finalUrl}` : r.provider === 'mock' ? 'Effective: synthetic reply, nothing dispatched' : 'Effective: original URL',
      `Outcome ${r.outcome}${r.status !== undefined ? ` · HTTP ${r.status}` : ''}${r.elapsedMs !== undefined ? ` · ${r.elapsedMs} ms observed (includes waits)` : ''}`,
      'Bodies: not recorded in R0',
    ];
    return h('li', {}, summary,
      h('div', { class: 'aw-inset aw-col aw-gap4 aw-xs' },
        ...lines.map((l) => h('div', { class: 'aw-mono aw-wrap' }, l)),
        r.ops.length ? h('ul', { class: 'aw-ops' }, ...r.ops.map(opLine)) : h('div', { class: 'aw-mu' }, 'No rule matched; passed through natively.'),
        ...r.notes.map((n) => h('div', { class: 'aw-mu' }, n))));
  }

  function opLine(o: Op) {
    const tone = o.state === 'applied' ? 'aw-gr' : o.state === 'failed' ? 'aw-rd' : o.state === 'selected' ? 'aw-bl' : 'aw-am';
    return h('li', { class: 'aw-row' }, h('span', { class: 'aw-bd' }, labelOf(o.module)), h('span', { class: `aw-bd ${tone}` }, o.state), h('span', { class: 'aw-grow' }, o.reason));
  }

  // Minimize / restore / close
  function minimize() {
    panel.hidden = true;
    launcher.hidden = false;
    restoreBtn.focus();
  }
  function restore() {
    launcher.hidden = true;
    panel.hidden = false;
    minimizeBtn.focus();
  }
  on(minimizeBtn, 'click', minimize);
  on(restoreBtn, 'click', restore);
  on(closeBtn, 'click', () => opts.onClose());
  on(launcherClose, 'click', () => opts.onClose());

  renderState();
  renderActivity();
  minimizeBtn.focus();

  return {
    restore,
    notice(text) {
      noticeEl.textContent = text;
      noticeEl.hidden = false;
      restore();
    },
    destroy() {
      cancelAnimationFrame(frame);
      unsubscribe();
      life.abort();
      host.remove();
    },
  };
}

function switchEl(label: string) {
  return h('button', { class: 'aw-sw', type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': label }, h('span', { class: 'aw-th' }));
}
function setSwitch(el: HTMLElement, on: boolean) {
  el.classList.toggle('aw-on', on);
  el.setAttribute('aria-checked', String(on));
}
function labelOf(m: Op['module']) {
  return m === 'mock' ? 'Mock' : m === 'route' ? 'Route' : 'Transform';
}
function pathOf(url: string) {
  try {
    const u = new URL(url);
    return u.origin === location.origin ? u.pathname : url;
  } catch {
    return url;
  }
}
