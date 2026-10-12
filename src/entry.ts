// Composition root and lifetime owner: singleton, captured natives, hook install, UI mount, Close.
import { defaultConfig } from './net/plan';
import { createRuntime } from './net/runtime';
import { createFetch } from './net/fetch';
import { captureXhr, createXhr, type XhrNatives } from './net/xhr';
import { mountPanel } from './ui/panel';
import { createSession } from './data/store';

const KEY = Symbol.for('api-workbench');
/** Registry key of the previous (v1) implementation; never stack two interception layers. */
const LEGACY_KEY = '__api_workbench_7f49a1_v1__';
/** Set on a document whose window's fetch/XHR carry this instance's hooks. A frame that navigates gets a new
 * document (unmarked), so it is hooked again; a document is never hooked twice. */
const MARK = Symbol.for('api-workbench:hooked');
/** How often frames are re-scanned (new, navigated or nested same-origin frames). */
const SCAN_MS = 500;

interface Hooked { win: Window; doc: Document; nativeFetch: typeof fetch; awFetch: typeof fetch; xhrNative: XhrNatives; awXhr: XhrNatives }
type Realm = Window & typeof globalThis;

interface Instance {
  version: string;
  relaunch(version: string): void;
  close(): void;
}

(() => {
  const w = window as unknown as Record<string | symbol, unknown>;
  const existing = w[KEY] as Instance | undefined;
  if (existing) {
    existing.relaunch(__VERSION__);
    return;
  }

  const rt = createRuntime(location.origin, defaultConfig());
  const session = createSession();

  if (w[LEGACY_KEY]) {
    rt.inert = true;
    // No hooks: Once still works, and "Apply rules" has no pipeline to enter, so it is the native fetch too.
    const p = mountPanel(rt, { version: __VERSION__, session, fetchers: { direct: (u, init) => window.fetch(u, init), rules: (u, init) => window.fetch(u, init) }, onClose: () => p.destroy() });
    p.notice('An older API Workbench is running on this page. Close it and reload before launching this version. No hooks were installed.');
    return;
  }

  // ---- hooks: this window and every same-origin frame (nested, added or navigated later). Cross-origin frames are
  // unreachable from page script (browser security); they are counted so the UI can say so.
  const hooked: Hooked[] = [];
  let blocked = 0;
  const onLoad = () => scan();
  function hook(win: Window): Hooked | null {
    let doc: Document;
    try { doc = win.document; } catch { return null; }
    const d = doc as unknown as Record<symbol, unknown>;
    const owned = win !== window && ((win as unknown as Record<string | symbol, unknown>)[KEY] || (win as unknown as Record<string, unknown>)[LEGACY_KEY]);
    if (d[MARK] || owned) return null; // already ours, or another Workbench instruments that frame itself
    const nativeFetch = win.fetch;
    const xhrNative = captureXhr(win);
    const h: Hooked = { win, doc, nativeFetch, awFetch: createFetch(nativeFetch, rt, win), xhrNative, awXhr: createXhr(xhrNative, rt, nativeFetch, win) };
    win.fetch = h.awFetch;
    Object.assign((win as Realm).XMLHttpRequest.prototype, h.awXhr);
    d[MARK] = true;
    doc.addEventListener('load', onLoad, true); // iframe loads in this document (load does not bubble; capture sees it)
    hooked.push(h);
    return h;
  }
  /** Restore natives where ours are still installed (a later page wrapper keeps working; it reaches us, then inert). */
  function unhook(h: Hooked) {
    try {
      h.doc.removeEventListener('load', onLoad, true);
      delete (h.doc as unknown as Record<symbol, unknown>)[MARK];
      if (h.win.document !== h.doc) return; // navigated away: the new document never had our hooks
      if (h.win.fetch === h.awFetch) h.win.fetch = h.nativeFetch;
      const proto = (h.win as Realm).XMLHttpRequest.prototype as unknown as Record<string, unknown>;
      for (const k of Object.keys(h.awXhr) as (keyof XhrNatives)[]) if (proto[k] === h.awXhr[k]) proto[k] = h.xhrNative[k];
    } catch { /* frame removed, or now cross-origin */ }
  }
  const live = (h: Hooked) => { try { return h.win.document === h.doc; } catch { return false; } };
  function scan() {
    for (let i = hooked.length - 1; i > 0; i--) if (!live(hooked[i]!)) hooked.splice(i, 1); // navigated or removed frames
    let n = 0;
    const walk = (w: Window) => {
      for (let i = 0; i < w.frames.length; i++) {
        const f = w.frames[i]!;
        try { void f.document; } catch { n++; continue; }
        hook(f);
        walk(f);
      }
    };
    walk(window);
    blocked = n;
  }
  const top = hook(window)!;
  scan();
  const scanner = setInterval(scan, SCAN_MS);
  const awFetch = top.awFetch;
  const nativeFetch = top.nativeFetch;

  const close = () => {
    rt.inert = true; // later wrappers that still delegate to us now reach native behavior
    rt.capturing = false;
    rt.settleAll(); // synthetic delays deliver now; owned body reads cancel
    clearInterval(scanner);
    for (const h of hooked.splice(0)) unhook(h);
    panel.destroy();
    delete w[KEY];
  };

  const frames = () => ({ hooked: hooked.filter((h) => h !== top && live(h)).length, blocked });
  const panel = mountPanel(rt, { version: __VERSION__, session, frames, fetchers: { direct: (u, init) => nativeFetch(u, init), rules: (u, init, on) => rt.asTester(() => awFetch(u, init), on && ((r) => on({ id: r.id, provider: r.provider === 'chaos' ? 'synthetic' : r.provider }))) }, onClose: close });
  const instance: Instance = {
    version: __VERSION__,
    relaunch(version) {
      if (version !== __VERSION__) panel.notice(`Version ${__VERSION__} is running. Close it and reload the page before launching ${version}.`);
      else panel.restore();
    },
    close,
  };
  Object.defineProperty(w, KEY, { value: instance, configurable: true });
})();
