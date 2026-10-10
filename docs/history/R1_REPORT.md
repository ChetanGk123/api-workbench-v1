# R1 shell and explanations — 11 October 2026

**Implemented; verification incomplete. R1 is not marked complete.** The final Chrome R1 suite passes 14 tests, the shared R0/core regression run passes 110, and the existing mock/route/breakpoint browser selection passes 40. A newly saved Chrome bookmark launches R1, restores a minimized dirty draft, launches after reload, routes native arraybuffer XHR and remains usable at actual 200% browser zoom. Edge and browser restart remain NOT RUN.

The user assigned R1 after R0 and asked to continue. This supersedes the original M0-only starter instruction without completing R0's open gates or authorizing R2. Existing uncommitted R0 work, old implementation, original fixture server and production bookmarks were preserved. No commit, publication, dependency installation or profile migration was performed.

## Implemented scope and decisions

- Separate `1.0.8-r1` full-inline artifact; one singleton/lifetime owner and the same shared Fetch/XHR pipeline. R0 remains independently buildable. The build script accepts only `r0` or `r1`; default remains R0.
- Supplied zinc theme and native shadow DOM. Persistent six-module navigation on every destination; Home cards, quick actions, session/frame context, activity, Minimize/Restore, true Close and Stop all. Navigation never writes host history or hash. Later-slice destinations explicitly state availability; they neither claim success nor dispatch work.
- Functional session-only editors for the existing static Mock and Route fixture rules. Save validates before mutating configuration; Back, Cancel, Escape, navigation and Close share Save/Discard/Keep editing. Failed Save stays in the editor/dialog. Saving an active rule affects subsequent requests; drafts never alter an in-flight plan. These are R1 shell exercises, not completion of the R4 rule editors or R2 durable storage.
- Per-origin geometry in the new `api-workbench:rebuild:geometry:v1` key, finite-value validation, viewport clamps, pointer and keyboard move/resize, separate launcher position and retained full-panel size. Storage failure reports session-only position. Normal panel interaction does not trap host focus; the deliberate native draft dialog does.
- Stable request IDs, captured config revision, response type, HTTP status and monotonic elapsed trace timestamps. Explicit selected/applied/skipped operation rows include a Route superseded by Mock. A pass-through Fetch rejection now produces a terminal diagnostic as well as rejecting normally. The shared planner adds diagnostic metadata; it does not alter rule precedence.
- Bounded metadata-only request records: 500 records, 2 MiB serialized UTF-8 bytes, 16 events per record, 512-byte reasons and bounded URL previews. Activity renders at most 50 matching rows; eviction is visible, late events cannot recreate an evicted record, and same-URL requests join by ID. UI updates coalesce per animation frame and do not rebuild an editor. Returning from detail restores filter, scroll and initiating row focus.
- R1 deliberately does not subscribe to body capture. Headers/bodies say **not requested in R1**, query values are redacted, URL credentials/fragments removed, and no request/response body is copied into this record store. Shared redacted previews remain R3 work. Paths/custom labels can still contain application-specific sensitive data; this is not a universal secret detector. The 2 MiB cap describes this R1 metadata store, not whole-browser heap usage or the older pipeline's separate trace ring.
- Timing is observed elapsed time and operation event offsets. It is labelled as including waits, not server latency. Separate dispatch-to-headers, body-read and injected-wait duration lanes are not claimed. Full rule priority/sampling/replay and tester/auth/signing explanations remain R4/R6.
- Stop all deactivates the two exposed modules for new requests and keeps the panel open. Already-selected page requests retain their snapshots. Close uses existing ownership-aware pipeline cleanup. No recorder, tester, pause or replay controls are exposed by R1.

## Environment and artifacts

Node v24.21.0; npm 11.19.0; TypeScript 7.0.2; esbuild 0.28.2; Playwright 1.63.0; desktop Chrome 154.0.8037.99; macOS 26.6.2 (25G83). `/Applications/Microsoft Edge.app` is absent. R1 fixtures use `127.0.0.1:4195` and `127.0.0.1:4196`, separately from R0's 4193/4194 and the original 4173/4174 server.

| Artifact | Measured size |
| --- | ---: |
| Readable R1 IIFE | 147,174 bytes |
| Minified R1 IIFE including CSS | 84,197 bytes |
| Complete encoded R1 bookmark | 118,411 characters |

Bookmark SHA-256: `9d180ae438896f332f97a7be502d3a0d13fa66e3ee701e35bd54a8b8122432d7`.

Minified SHA-256: `3404ea8fb44421308ab98b59be3dfcfee15ae9b25299293f871eaf52cae2d3df`.

[All generated sizes/hashes](evidence/r1-sizes.json) are retained outside ignored `dist/`. Regenerated R0 after shared diagnostic changes measured 120,822 readable bytes / 68,098 minified bytes / 95,238 URL characters; its historical saved-bookmark evidence still applies only to the earlier artifact documented in R0_REPORT. The existing product build measured 503,881 readable bytes / 285,790 minified bytes / 412,088 URL characters.

## Evidence ledger

| Gate / portion | Result | Evidence / limit |
| --- | --- | --- |
| G03 R1 lifecycle | PASS in tested Chrome cases | Same hook/instance on relaunch, minimized draft and active rules retained, Stop all keeps editor, close settles synthetic delay without upstream dispatch, later Fetch wrapper preserved; R0 suite also checks Fetch/XHR cleanup |
| G08 R1 diagnostics | PASS in tested Chrome cases | Typed XHR route applies while unsupported binary transform is skipped; Mock supersedes Route explicitly; immutable revision/ID, HTTP outcome, abort/error distinction, count/byte/event eviction checks |
| G22 R1 shell | PASS in tested Chrome cases | Persistent navigation, host DOM/styles/URL/history unchanged, dirty choices and validation failure, correct Back/focus, filter/scroll, caret under traffic, geometry storage failure, SVG-handle drag, 480/320-wide layouts and native 200% zoom |
| G01 artifact/installer subset | PASS | Strict build and inline asset/evaluator checks; fixture serves exact generated installer bookmark href; no requests during automated launch/navigation |
| G02 saved Chrome bookmark subset | PASS | New bookmark via native editor; launch, minimized dirty relaunch, reload launch and routed arraybuffer request through host UI |
| G02 exact saved-URL re-export/restart | NOT RUN | Full generated href was supplied to the native editor and launched; saved URL was not re-exported/hashed, browser was not restarted |
| Edge G03/G08/G22, saved install/zoom/restart | NOT RUN | Edge is absent |
| Full release G03/G08/G22 | INCOMPLETE | Later tester/recorder/pause/profile/durable-edit integrations are not R1 implementations; screen-reader matrix and remaining browser gates are open |

[Final counted R1 results](evidence/r1-automated.json): **14 passed**, zero skipped/unexpected/flaky, 6.209 seconds. [Existing-product regression results](evidence/r1-legacy-regression.json): **40 passed**, zero skipped/unexpected/flaky, 55.315 seconds. Shared R0/core run: **110 passed**, 20.0 seconds as printed by the runner; its current-run JSON was cleared by a subsequent Playwright invocation, so no new retained JSON is claimed for those 110 results.

Automated tests inject decoded bookmark source for engine/UI verification. They are not used as proof of bookmark installation. Screenshots reviewed: [Home](evidence/r1-home.png), [constrained panel](evidence/r1-constrained.png), [mixed binary diagnostics](evidence/r1-binary-detail.png), [actual saved-bookmark 200% editor](evidence/r1-saved-bookmark-200.png), [actual saved-bookmark routed detail](evidence/r1-saved-bookmark-detail.png).

### Actual Chrome procedure

1. Open `http://127.0.0.1:4195/rebuild/r1/install.html`. Create a separate bookmark **API Workbench 1.0.8-r1 verification** in the API Workbench folder. Use Chrome's native bookmark manager to replace that new bookmark's URL with the complete generated href. Existing R0/product bookmarks are unchanged.
2. Open `/fixture`, then click that saved bookmark from Chrome's bookmarks folder. Observe version `1.0.8-r1`, Home and no active modules.
3. Increase real browser zoom to **200%** (Chrome's own zoom indicator). Measured CSS viewport 756×385, panel 560×369, right 748/bottom 377, no panel horizontal overflow. Open Mock editor: header/nav, Save/Cancel and Close remain reachable while the form scrolls.
4. Enter `R1 draft at 200%`, minimize, and click the saved bookmark again. Observe the exact draft retained and one panel. Discard that test draft, reset zoom to 100%, reload, then launch from the saved bookmark again.
5. Activate Route, minimize, set host URL to `/api/mock-target`, send XHR with `arraybuffer`, restore, open Activity detail. Host response and detail agree on `/api/r0-routed`, status 200, native XHR arraybuffer, route selected/applied and the original URL. Stop all afterward; the review tab is left on Home with no active modules.

An initial attempt to open the R1 installer on the old 4193 fixture failed (that process served R0 paths only). Added explicit R1 static artifact serving and started an isolated 4195/4196 fixture. No browser security settings, policy or extension permissions were changed. Browser restart was not attempted in the shared user's session.

## Commands and outcomes

Exact build/test/version commands used (repeat invocations use the same text):

```sh
npx tsc --noEmit
npm run build:r1
AW_REUSE_SERVER=1 npm run test:r1
npm run test:r0
AW_REUSE_SERVER=1 npm run test:r0
npm run fixture:r1
npm run build
AW_FIXTURE_PORT=4195 AW_FIXTURE_OTHER_PORT=4196 AW_REUSE_SERVER=1 npx playwright test tests/m5.spec.mjs tests/m6.spec.mjs tests/m7.spec.mjs
node --version
npm --version
npx playwright --version
sw_vers
git diff --check
git status --short
```

- `tsc`/builds PASS finally. An intermediate status-field change failed type checking because synthetic XHR stores status under `state.delivery`; corrected before tests.
- R1 sandbox attempts failed fixture binding with EPERM; escalated runs were used. Initial R1 run: 9/11 PASS; fixed explicit superseded-route diagnostics and a resize-event assertion timing race. Expanded run: 13/14 PASS; fixed SVG-child drag targeting. Final run: 14/14 PASS, including a real nonzero scroll-restoration assertion. No failing behavior assertion was removed.
- Plain `npm run test:r0` refused the occupied 4193 port. The explicit existing-server invocation passed 110/110. Original running server retained.
- `npm run fixture:r1` starts the isolated local fixture and is left running for review. Existing product build and 40 selected browser regressions PASS. The default legacy config excludes both rebuild suites, avoiding a dependency on unbuilt rebuild artifacts.
- Evidence JSON/sizes/screenshots were copied with Python standard-library `json`, `pathlib` and `shutil`; native browser screenshots saved through Computer Use. Documentation links and `git diff --check` checked at the end.

## Changed files in R1

| Area | Files |
| --- | --- |
| New R1 runtime | `src/rebuild/r1-entry.ts`, `shell.ts`, `r1.css`, `geometry.ts`, `session.ts`, `records.ts` |
| Shared diagnostic metadata/callers | `src/network/pipeline.ts`, `rules.ts`, `fetch-adapter.ts`, `xhr-adapter.ts` |
| Build, fixture, tests | `scripts/build-r0.mjs`, `package.json`, `playwright.r1.config.mjs`, `playwright.config.mjs`, `tests/fixtures/server.mjs`, `tests/r1.spec.mjs` |
| Documentation/status | This report; `docs/WORK_LOG.md`; rebuild README, PLAN, VERIFICATION, UX; screen index and 00/02/20/21 sheets; `evidence/r1-*` |
| Generated/ignored | `dist/rebuild/r1/*`, rebuilt `dist/rebuild/r0/*`, existing product `dist/*`, test outputs |

The working tree already contained R0 edits and files at task start. This table identifies this task's additions/edits rather than attributing the entire dirty tree to R1.

## Remaining verification and next slice

Not run: Edge; browser restart; fresh clean-profile installation; saved URL re-export/hash; R1 saved-bookmark policy matrix; screen-reader navigation; full original-product suite; full heap/long-task/long-idle profiling; real banking application. R0's unresolved resource/payload gates remain open. Native 200% zoom was measured in Chrome only.

For Edge/restart: start `npm run fixture:r1`, open the R1 installer, save its exact generated bookmark, launch on `/fixture`, edit/minimize/relaunch, exercise arraybuffer Route/Mock, reload, restart the browser deliberately, then launch the same saved bookmark and check inactive defaults and retained geometry. Record browser version, exact artifact hash and results; do not substitute console injection.

Next implementation slice is **R2: data, endpoints and Once**, separately assigned. Complete the outstanding R0/R1 browser gates before claiming either slice or release complete. No R2 implementation has started.
