# R0 transport and bookmark feasibility: clean rebuild, 11 October 2026

**Status: implemented; verification incomplete. R0 is not complete.** All 59 counted tests pass in Chrome 154. Saved-bookmark installation, Edge, browser restart and resource profiling are **NOT RUN**.

This is a from-scratch implementation in `/Users/chetangk/Developer/tools/api-workbench-v1`, a new Git repository. As the user directed, no source was copied from `api-workbench` or `rebuild/v2`. The only reused file is the supplied design asset `design/reference/` (theme + 16 reference screens). The earlier rebuild's reports are kept in [history/](history/) as evidence about *that* code only.

## Environment and artifact

- macOS 26.6.2; Node v24.21.0; npm 11.19.0; TypeScript 7.0.2; esbuild 0.28.2; Playwright 1.63.0; Google Chrome 154.0.8037.99. Edge is not installed.
- Fixture: `127.0.0.1:4310` (A) and `127.0.0.1:4311` (B). This avoids the ports used by the old 4173–4196 servers.

| Artifact `2.0.0-r0` | Measured |
| --- | ---: |
| Readable IIFE | 83,039 bytes |
| Minified IIFE incl. CSS | 58,390 bytes |
| Encoded `javascript:` URL | 83,212 characters |

Minified SHA-256 `237a52dee39b3deb432c1e9f8623b4345dceac89972c1d8e9a65e4b5b1867f88`; bookmark SHA-256 `b26cc446254db156c1492f99a18748624a2ad7fc442ed30832a6b43fdd32e9ed`. Full record: [evidence/r0-sizes.json](evidence/r0-sizes.json).

## What exists

| File | Role |
| --- | --- |
| `src/net/plan.ts` | Pure shared planner and rule validators. Each module holds at most one rule (label, method or `*`, exact path, **Rule enabled** separate from **Module active**). It returns frozen plans with selected/skipped/superseded operations; mock wins over route. Route = destination origin + optional path rewrite, with the query kept. |
| `src/net/runtime.ts` | Config revisions; bounded records (500, 16 notes, query values never stored); owned waits settled by Close; 4 body slots; `readBounded` (bytes/deadline/close) |
| `src/net/fetch.ts` | Fetch adapter. Unmatched calls get exact `apply` delegation and the original Response. Also handles the mock reply, route (init precedence, cross-origin Authorization removal, bounded prebuilt-Request body) and bounded text transform. |
| `src/net/xhr.ts` | XHR adapter. It patches the prototype, so native objects and constructor identity are kept. **Route is decided in `open()`**, so the native object opens the destination itself: typed responses, events, timeout and upload stay native with no response reconstruction. Mocks use an explicit state machine (`loadstart → rsc2 → rsc3 → progress → rsc4 → load → loadend`, plus abort/timeout terminals). |
| `src/ui/panel.ts`, `panel.css`, `dom.ts` | Shadow-root panel following `design/reference/screens` (480 px): title bar with active-module indicators, Settings/Import, Minimize, Close; six module tabs; Home module cards, Quick actions and Recent activity; Mock and Intercept screens (Activate, ad-hoc rule row with enable checkbox, Add rule, traffic list) with full-screen editors (Back, Save/Delete footer); Route screen with the inline *New page rule* form; icon-bar launcher. Dirty drafts get a Keep editing/Discard/Save dialog on navigation, Escape or Close, and invalid saves keep the draft with field errors. Test, Chaos, Endpoints, Import and Settings open a *Not in this build* screen; none has a fake handler. Uses the reference icon paths, constructed stylesheets, and DOM construction only (no `innerHTML`). |
| `src/entry.ts` | Composition root: singleton (`Symbol.for('api-workbench')`), legacy-instance guard (`__api_workbench_7f49a1_v1__`), hook install, ownership-aware Close |
| `scripts/build.mjs` | Readable/minified IIFE, encoded bookmark, installer, sizes/hashes. Fails the build on evaluators, dynamic import, CSS `url()`/`@import`/`@font-face`, HTML-string injection, foreign inputs, non-SVG-namespace URLs, or a bookmark that doesn't round-trip. |
| `tests/fixture/` | Two-origin server: echo, counters read outside the page, HttpOnly session, slow/status/binary/big/stream, CORS allowed/denied, exact strict and blocked-connect CSP pages. The page harness looks up `fetch`/`XMLHttpRequest` at call time. |
| `tests/core.spec.ts`, `tests/browser.spec.ts` | One Playwright runner: 18 pure + 41 Chrome cases. Browser cases drive the real UI flows (tab → Add rule → editor → Save → Activate). |

Deliberate R0 boundaries: one rule per module; no profile selector or persistence (rules last for the page session); routing has no glob, conditions or credentials override yet. XHR response-text editing reports *skipped* with a reason, and the native response is delivered. Synthetic XHR does not emit upload events or `document` responses (a document mock is skipped and the request sent natively). A rebuilt transform Response loses `url`/`redirected`, and the record says so. Bodies are not recorded.

## Gate ledger (scoped; not whole-gate PASS)

| Gate / portion | Result | Evidence and boundary |
| --- | --- | --- |
| G01 build/encoding/standalone | PASS | Strict `tsc`; build checks above; bookmark round-trip; installer href = generated bookmark |
| G01 locked install | NOT RUN | `package-lock.json` generated by `npm install --prefer-offline`; `npm ci` from it not yet run |
| G02 actual saved bookmark (Chrome, Edge), restart | **NOT RUN** | Automated launches evaluate the decoded artifact. That is injection, not installation. Manual procedure below. |
| G03 R0 lifecycle | PASS (Chrome, injected) | Single instance/hook on relaunch, minimize keeps modules active, legacy guard installs nothing, Close restores exact natives, later wrapper kept and Workbench layer inert, Close during 5 s delay delivers the selected mock promptly with zero hits |
| G04 native Fetch subset | PASS (Chrome) | Exact argument/`this`/Response identity on unmatched calls, HttpOnly session + `credentials: omit`, signature-like headers and exact body, 503 as Response, CORS-denied as TypeError, pre-aborted and mid-delay abort |
| G05 native XHR subset | PASS (Chrome) | Unmatched trace/status/URL/type identical to a native control for '', text, json, arraybuffer, blob; `instanceof`/prototype intact; handler attributes fire; sync passthrough. Not exhaustive conformance. |
| G06 binary request route subset | PASS (Chrome) | Routed XHR arraybuffer/blob/text/json: one destination hit, native trace, typed value. The arraybuffer request shows Route applied and Transform skipped, with reasons. |
| G06 binary breakpoint | NOT RUN | No pause feature in R0 (R5) |
| G07/G25 body bounds subset | PASS (Chrome) | 4 MiB known-length skips, unknown-length 3 s stream hits the 2 s deadline, binary content type skips; the caller gets complete bodies in every case. A 2 MiB prebuilt Request skips the route and the original endpoint gets all bytes once. A 70,000-byte Request routes with matching SHA-256. |
| G09 static mock subset | PASS (Chrome) | Fetch and XHR in all 5 response types with zero upstream hits, Unicode, HEAD/204 bodyless, 503 as a response, XHR abort/timeout terminals, invalid status rejected while the last valid config keeps working |
| G12 route subset | PASS (Chrome) | Repeated query preserved; cross-origin Authorization removed and noted; same-origin keeps Authorization and HttpOnly session; Mock supersedes Route (zero hits); an invalid destination cannot be saved and nothing is routed; rule-enabled and module-active are independent; Stop all deactivates |
| G25 exact policy pages (injected) | PASS (Chrome) | Strict CSP: panel background `rgb(9, 9, 11)`, same-origin fetch works. Blocked-connect: native fetch rejects with TypeError while the local mock still answers. |
| G25 runtime assets | PASS (injected) | Zero requests during launch + 150 ms idle |
| G25 heap/long-idle/UI latency, Edge | NOT RUN | No profiling done |

[Counted results](evidence/r0-automated.json): **59 expected, 0 unexpected, 0 skipped, 0 flaky**, 17.6 s. An intended-failure probe file produced exit code 1 and was then removed. [Panel screenshot](evidence/r0-panel.png).

## Commands

```sh
npm install --prefer-offline --no-audit --no-fund   # esbuild postinstall not run; binary resolved via @esbuild/darwin-arm64
npm run verify      # tsc --noEmit && build && (build && playwright test)
npm run fixture     # keep fixture running; installer at http://127.0.0.1:4310/install
```

After the UI was rebuilt to match the reference screens, the first run had 56/59 passing. Two failures were test selectors matching both the field error and the screen-reader status text. The third was a real bug: pressing Escape in a dirty editor opened the confirmation dialog during the key event, and Chrome's default Escape action closed it again at once. The fix calls `preventDefault` and opens the dialog after the event; a regression test was added. The original R0 run had 55/56 passing. The one failure was an ambiguous test selector (the hidden launcher label also matched). The selector was fixed; no product change and no assertion was weakened.

## Saved-bookmark procedure (open)

1. `npm run build && npm run fixture`, then open `http://127.0.0.1:4310/install` in a test Chrome profile.
2. Drag **API Workbench 2.0.0-r0** onto the bookmarks bar, or paste the textarea text into a new bookmark's URL. Record which path you used.
3. Open `http://127.0.0.1:4310/fixture` and click the saved bookmark. Expect version 2.0.0-r0 with all modules inactive.
4. Mock tab → Add ad-hoc rule → Save → Activate, then Send (XHR arraybuffer): expect `{"mocked":true…}`. Deactivate Mock. Route tab → Add page rule, destination origin `http://127.0.0.1:4310`, path rewrite `/api/r0-routed`, Save rule → Activate, then Send: the response path should be `/api/r0-routed`.
5. Minimize, click the bookmark again (one panel), reload, click again (inactive defaults), restart the browser and repeat.
6. Repeat on `/policy/strict` and `/policy/blocked-connect`, and repeat everything in Edge.

## Remaining before R0 can close

- [ ] Steps above in Chrome, then in Edge after it is installed. Re-export the saved URL and compare it with the bookmark SHA-256.
- [ ] `npm ci` from the lockfile; native-bookmark network capture; heap/long-idle measurements.
- [ ] The R1 carry-over is now known: the panel can cover host controls, so drag/resize/geometry is first in R1.
