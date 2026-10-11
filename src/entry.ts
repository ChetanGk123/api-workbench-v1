// Composition root and lifetime owner: singleton, captured natives, hook install, UI mount, Close.
import { defaultConfig } from './net/plan';
import { createRuntime } from './net/runtime';
import { createFetch } from './net/fetch';
import { captureXhr, createXhr } from './net/xhr';
import { mountPanel } from './ui/panel';
import { createSession } from './data/store';

const KEY = Symbol.for('api-workbench');
/** Registry key of the previous (v1) implementation; never stack two interception layers. */
const LEGACY_KEY = '__api_workbench_7f49a1_v1__';

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

  const nativeFetch = window.fetch;
  const xhrNative = captureXhr();
  const awFetch = createFetch(nativeFetch, rt);
  const awXhr = createXhr(xhrNative, rt, nativeFetch);
  const proto = XMLHttpRequest.prototype;

  window.fetch = awFetch;
  Object.assign(proto, awXhr);

  const close = () => {
    rt.inert = true; // later wrappers that still delegate to us now reach native behavior
    rt.capturing = false;
    rt.settleAll(); // synthetic delays deliver now; owned body reads cancel
    if (window.fetch === awFetch) window.fetch = nativeFetch;
    for (const k of Object.keys(awXhr) as (keyof typeof awXhr)[]) {
      if (proto[k] === awXhr[k]) (proto as unknown as Record<string, unknown>)[k] = xhrNative[k];
    }
    panel.destroy();
    delete w[KEY];
  };

  const panel = mountPanel(rt, { version: __VERSION__, session, fetchers: { direct: (u, init) => nativeFetch(u, init), rules: (u, init, on) => rt.asTester(() => awFetch(u, init), on && ((r) => on({ id: r.id, provider: r.provider === 'chaos' ? 'synthetic' : r.provider }))) }, onClose: close });
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
