# R0 transport and bookmark feasibility — 10 October 2026

**Status: implemented; verification incomplete. R0 is not complete and R1 has not started.** Chrome's normal saved bookmark, static mock and native binary XHR route work. The final counted suite passes 110 tests; the existing product's final routing regression passes 12. Edge, browser restart and resource measurements listed below remain open.

This is the user-authorized first rebuild slice in [PLAN](PLAN.md), using the original [M0 feasibility requirements](../FIRST_TASK_M0.md) as a baseline. It does not replace the existing product or prove full v1/complex-application readiness. Decisions are in [R0_DECISIONS](R0_DECISIONS.md).

## Checkout, environment and artifacts

- Same repository, separate worktree: `/Users/chetangk/Developer/tools/api-workbench-rebuild`.
- Branch `rebuild/v2`, base commit `740782d`. Changes remain uncommitted. Original checkout and production bookmark retained.
- Node v24.21.0; npm 11.19.0; TypeScript 7.0.2; esbuild 0.28.2; Playwright 1.63.0.
- Installed desktop Chrome 154.0.8037.99; macOS 26.6.2 (25G83). Edge is not installed. Saved-bookmark checks used the existing Chrome profile and only loopback fixture data, not a clean release-test profile.
- Fixture origins `http://127.0.0.1:4193` and `http://127.0.0.1:4194`. The user's server on 4173/4174 was preserved.

| R0 artifact | Measured size |
| --- | ---: |
| Version | 1.0.8-r0 |
| Readable IIFE | 119,355 bytes |
| Minified IIFE including CSS | 67,319 bytes |
| Encoded full bookmark URL | 94,127 characters |

Minified SHA-256: `f55bfcedd7903eba4d1e18660dc75694b650e5f7590acc91f0f4847bdb11753c`.

Bookmark SHA-256: `5ae0b9beb421b2531a3defa41b54b971e15dad12adb68a9fa81ba4e5c6abac6f`.

[All artifact and probe hashes](evidence/r0-sizes.json) are retained independently of ignored `dist/`. No compressed transfer size is used as bookmark evidence. The final existing-product build is separate: 502,414 readable bytes, 285,013 minified bytes, 410,987 URL characters.

## What works in this slice

The R0 entry reuses the supplied zinc theme, native shadow DOM and existing planner/adapters. It provides version/origin, bounded activity, static mock with 0–10,000 ms delay, route destination, Minimize/Restore/Close. Both modules start off. Rules target the current origin's `/api/mock-target`; mock wins when both are enabled. Invalid route destinations disable routing until corrected. Destination credentials/query/fragment are rejected; the original request query is preserved.

The route policy is explicit: same-origin credentials, cross-origin Authorization removed. Routing changes neither CORS nor CSP permissions. The legacy instance registry prevents old/new bookmarks from stacking hooks. There is no R0 persistence, loader, updater, framework, runtime package or external asset.

The planner takes an isolated frozen plan at intake. Operation records distinguish selected, applied and skipped routing/mocking; unsupported binary response editing does not discard eligible request routing. This is a limited diagnostic vocabulary for R0, not completion of the full R1/R4 explanations contract.

Fetch passes unchanged calls to the captured implementation with original arguments and preserves the Response object. Request/init headers and signal precedence, including null signal overrides, are covered. Malformed headers still reject asynchronously through native Fetch. Static responses handle Unicode, HEAD and bodyless statuses.

Request-only XHR routing uses the original native XHR object. Reopening applies the chosen destination and accepted request headers while retaining response type, timeout, credentials policy, MIME override and upload target. Text, JSON, arraybuffer and blob route/mock cases pass, with one upstream hit for routes and zero for mocks. Native passthrough, synchronous behavior, reuse, upload, abort/timeout and wrapper restoration have controlled assertions.

## Evidence and gate ledger

[Counted R0 results](evidence/r0-automated.json) preserve all 110 test names, statuses, durations and attachments: 88 core cases plus 22 R0 browser cases; zero skipped, unexpected or flaky results; 20.459 seconds. [Final existing-product routing results](evidence/r0-legacy-routing.json): 12 passed, 8.1 seconds. Automated engine launches decode and inject the artifact; they are explicitly not saved-bookmark proof.

| Gate / portion | Result | Evidence and boundary |
| --- | --- | --- |
| G01 build, encoding, standalone distribution | PASS | Strict types/build assertions, no runtime imports/URLs/evaluators/assets, void completion, installer href exactly matches generated bookmark; locked dependency install succeeded |
| G02 Chrome actual saved artifact | PASS for launch/relaunch/reload | Native bookmark editor and saved bookmark menu; version 1.0.8-r0; separate bookmark; typed mock/route through fixture controls |
| G02 Chrome restart / Edge | NOT RUN | Shared Chrome session not restarted; Edge absent; required procedure below |
| G03 R0 lifecycle | PASS in tested Chrome cases | Single instance/hooks, minimize/relaunch restore, close during synthetic delay, active native route survival, later-wrapper ownership, old-instance guard |
| G04 native Fetch, R0 operations | PASS in tested Chrome cases | Original invocation/Response, Request+init override, exact binary bytes, signature-like headers, HttpOnly session eligibility, HTTP error, cancellation, routed POST and fallback |
| G05 native XHR, R0 operations | PASS in tested Chrome cases | Native object/event target/upload, four response types, exact request bytes, native terminal comparison, reuse and sync passthrough; not exhaustive XHR conformance |
| G06 binary route/request transform subset | PASS | Eligible route proceeds while unsupported binary response editing reports skipped; response remains typed/native |
| G06 binary breakpoint and complete capability matrix | NOT RUN | Outside exposed R0 controls; current binary chaos/pause paths are skipped, not implemented capabilities |
| G25 Chrome exact policy launch/style/network | PASS for observations below | Actual saved bookmark; exact policies retained; no policy relaxation |
| G25 runtime asset requests | PASS for injected launch/150 ms idle | Observed request list empty; build checks also reject runtime assets; separate native-bookmark network capture not recorded |
| G25 body bounds/cleanup subset | PASS | Measured response bodies, 4-reader cap, deadline, close and original-body preservation below |
| G25 heap/long task/long idle, Edge policy/resources | NOT RUN | No heap profile, long-run resource baseline or UI latency measurement; bounded counters alone do not prove absence of all browser buffering |

These are scoped results, not blanket PASS for whole release gates. G07–G27 features beyond the tested subset remain unverified for the rebuild. In particular G27 banking/auth rotation/signing/idempotency has not been implemented or tested.

## Actual saved-bookmark procedure and observations

The installer was opened at `http://127.0.0.1:4193/rebuild/r0/install.html`. A separate bookmark named **R0 verification 2026-10-10** was created through Chrome's bookmark UI and moved into the existing API Workbench folder. Its URL was replaced in the native bookmark editor with the full generated href, including `javascript:`. Existing product bookmarks were not replaced. Tests launched using the saved bookmark menu, not the install-page link or console.

Observed on the 94,127-character artifact:

1. Fresh fixture launch opened version 1.0.8-r0 with inactive controls.
2. Mock on: fixture arraybuffer XHR returned the synthetic Unicode JSON.
3. Mock off, Route on: arraybuffer XHR returned network JSON with `/api/r0-routed`; activity showed selected/applied route.
4. Minimize then saved-bookmark launch restored one panel. Reload then saved-bookmark launch succeeded again with inactive controls.
5. Exact strict policy allowed styled panel plus permitted same-origin Fetch. Exact blocked-connect policy allowed the panel, rejected the native Fetch with TypeError, and allowed a local static mock.
6. The ordinary bookmark was restored after size probes. Final UI verification returned `200 OK`, path `/api/r0-routed`, through arraybuffer XHR; screenshot below. Minimize was needed to uncover the fixture Send controls.

![Saved R0 bookmark with a routed arraybuffer XHR response](evidence/r0-bookmark.png)

| Full encoded URL length | Saved Chrome observation |
| --- | --- |
| 94,127 | PASS: launch, relaunch, reload, mock and route |
| 131,072 | PASS: panel visible after fresh-page saved-bookmark activation |
| 262,144 | PASS: panel visible after fresh-page saved-bookmark activation |
| 1,048,576 | NOT RUN to a conclusive result: pasted/saved and attempted twice; no panel observed, but native menu activation was inconsistent during this sequence, including a subsequent ordinary-size attempt. Needs an isolated manual rerun before attributing failure to payload size |

The initial live progress message described the 1 MiB attempts as failed launches. The later ordinary-size activation inconsistency prevents treating that as a confirmed size boundary. Native accessibility exposed only a truncated URL value, so retained full probe length was not independently verified. Successful panel launch does not prove the inert padding itself survived saving. No universal bookmark limit or sync/restart retention claim follows from this experiment.

Exact strict policy:

```text
default-src 'none'; script-src 'self'; style-src 'none'; connect-src 'self'; img-src 'none'; require-trusted-types-for 'script'
```

Blocked-connect variant changes only `connect-src 'self'` to `connect-src 'none'`. Strict-page panel computed background was `rgb(9, 9, 11)`. Constructed shadow stylesheets rendered in this tested Chrome configuration. This does not establish support for arbitrary enterprise policies, cross-origin frames, workers, existing captured references or other browsers.

## Body handling: measured limits and tradeoffs

Passive Fetch observation reads only declared-length, uncompressed text up to 16 KiB. Unknown lengths, encoded bodies, binary bodies and larger bodies are metadata-only. At most four readers run concurrently; each has a two-second deadline. Close cancels the owned branch without awaiting the page branch's tee cancellation. Intake string previews use UTF-8 byte accounting. XHR text preview is capped while native response ownership remains with the browser.

[Response measurements](evidence/r0-body-measurements.json), taken after response headers with a 30 ms controlled caller delay:

| Response fixture | Caller bytes | Observation | Elapsed |
| --- | ---: | --- | ---: |
| Known-length 4 MiB text | 4,194,304 | Omitted | 35 ms |
| Unknown-length 100-byte text | 100 | Omitted | 31 ms |
| Known-length 100-byte text | 100 | Captured, exactly 100 bytes | 32 ms |
| 100-byte text completed after 2.5 s | 100 | Omitted at observation deadline | 2,502 ms |

A six-response concurrent slow fixture reached exactly four active observers. Close returned active count to zero, all observations were omitted, and all six callers received their full 100-byte bodies. These are fixture measurements, not throughput benchmarks or heap measurements.

A real Chrome HTTP/1.1 test exposed a separate issue: rewriting a prebuilt Request by forwarding its body as a newly constructed stream failed. Explicit route preparation now buffers at most 1 MiB, for at most two seconds, with at most four simultaneous preparations. URL + existing BodyInit requests retain their body without observation. Prepared Request POST bodies below the bound route with exact bytes. Overflow/deadline/close skips routing, reports why, and dispatches the preserved original once; caller abort still wins.

The 2 MiB prebuilt POST overflow test verified the original endpoint received all 2,097,152 bytes once and the route destination received none. Deadline/close preservation tests use a controlled captured transport that consumes a stream, rather than claiming HTTP/1.1 support for native streamed uploads. Native transport limitations still apply to the fallback. This bounded route behavior is visible and must remain documented in future route UX.

## Commands and outcomes

Commands were run from the rebuild worktree unless a path is explicit. The sibling worktree required sandbox approval for writes/builds. No dependency versions were changed.

```sh
# Preparation, from the original checkout:
git worktree add -b rebuild/v2 /Users/chetangk/Developer/tools/api-workbench-rebuild
# In the rebuild worktree:
npm ci
npm run build:r0
npm run test:r0
npm run fixture:r0
npm run build
AW_FIXTURE_PORT=4193 AW_FIXTURE_OTHER_PORT=4194 AW_REUSE_SERVER=1 npx playwright test tests/m6.spec.mjs
git diff --check
```

- Worktree creation and locked install: PASS; 7 packages installed, zero reported vulnerabilities.
- Final `npm run test:r0`: PASS, includes TypeScript/build checks and 110 counted cases. This run started its suite-owned fixture with ports free. Later manual work started the persistent `fixture:r0` server.
- Final `npm run build`: PASS, existing product still builds. It correctly skips size probes smaller than that larger product bookmark.
- Final M6 command above: PASS, 12 existing-product routing/interception cases. It explicitly reused the R0 fixture server.
- An earlier broader existing-product selection passed 60 cases before the final bounded Request-body change. It is historical session evidence, not the final full-suite result; final retained evidence is the 110-case suite and 12-case routing rerun.
- Initial failures uncovered unknown-length fixture framing, test selector/global-name collisions, a missing opaque-route diagnostic and the native Request POST routing issue. Those were addressed before the final passes; failed runs are not counted as passing evidence.
- Read-only environment commands included `node --version`, `npm --version`, `sw_vers`, `test -d '/Applications/Microsoft Edge.app'`, Git status/diff and source reads. Edge directory check returned false. Full `npm test`, Edge tests, browser restart, deployment and migration were not run.

To reproduce with the preview server already running, use `AW_REUSE_SERVER=1 npm run test:r0`. With ports 4193/4194 free, use `npm run test:r0`. `npm run fixture:r0` keeps the preview available; open the installer URL above, save the bookmark and launch on `/fixture`. The fixture is development infrastructure; the generated bookmark contains all runtime code and CSS.

## Changed files and scope

- Build/harness: `package.json`, `playwright.config.mjs`, new `playwright.r0.config.mjs`, new `scripts/build-r0.mjs`.
- Runtime: new `src/rebuild/r0-entry.ts`, `src/rebuild/r0.css`, `src/network/body-preview.ts`; updated `src/network/fetch-adapter.ts`, `xhr-adapter.ts`, `pipeline.ts` and `src/recorder/recorder.ts`. Recorder storage getters are now inside the existing error boundary so unavailable storage does not break pure tests or capture.
- Fixtures: `tests/fixtures/page.html`, `page.js`, `server.mjs`, `test-api.mjs`; typed/native controls, exact byte/body fixtures, readiness and separate ports.
- Assertions: new `tests/r0.spec.mjs`; updated `tests/m0.spec.mjs`, `m2-core.spec.mjs`, `m3-tester.spec.mjs`, `m5.spec.mjs`, `m6.spec.mjs`, `m7.spec.mjs`. The formerly separate Node cases now run through the counted Playwright runner. Port changes in these selected tests do not prove all legacy tests support arbitrary ports.
- Documentation: this report, `R0_DECISIONS.md`, rebuild `README.md`, `PLAN.md`, `MIGRATION.md`, `VERIFICATION.md`, `docs/WORK_LOG.md`, and evidence JSON/PNG files in `docs/rebuild/evidence/`.

Shared adapter fixes affect the existing product too. The old response-transform/chaos/breakpoint paths have not been comprehensively redesigned for bounded reading or full lifecycle conformance; they are not exposed by the R0 UI. Binary response edits and binary pauses are not silently represented as working. Synthetic document responses and exhaustive synthetic upload/event semantics remain unproved.

## Remaining tasks before R0 can close

- [ ] In an isolated Chrome test profile, repeat native bookmark installation and actual browser restart. Verify the entire saved URL survives and version/mock/route work afterward. Do not terminate unrelated user tabs to perform this check.
- [ ] Rerun the 1 MiB probe with reliable native menu activation, compare saved URL against the generated text through the bookmark editor, and record observed behavior without a universal-limit claim. Restore the base bookmark afterward.
- [ ] Install/use desktop Edge in a dedicated profile. Record its version, run `AW_BROWSER=msedge npm run test:r0` (or add `AW_REUSE_SERVER=1` if reusing the fixture), then repeat actual saved-bookmark launch/relaunch/reload/restart and the exact policy matrix. Installing Edge was not performed in this task.
- [ ] Capture native-bookmark launch/idle network activity separately. Measure longer traffic/idle resource behavior, browser heap and UI latency against a native baseline. Retain raw observations; counts alone are insufficient.
- [ ] Review the R0 capability boundary against G06: binary request pause remains later R5 work; full G06 must stay open until implemented and verified. Do not mark all G01–G06 complete based on this route-only experiment.

For each browser: build; record `sizes.json`; save the actual installer href in a new named bookmark; navigate to plain fixture; launch; run native control, mock and route with text/JSON/arraybuffer/blob; minimize/relaunch; reload/relaunch; fully restart the isolated browser and repeat. Then visit `/policy/strict` and `/policy/blocked-connect` and separately record launch, CSS, allowed/denied native request and local mock. Compare per-endpoint counter deltas around each operation. Keep the exact CSP unchanged.

## UX findings to carry into R1

- [ ] Move/resize the panel and retain geometry so it does not permanently cover the application's Send controls. The current functional workaround is Minimize → use host page → Restore.
- [ ] Left-align field labels consistently. Generic label centering makes the delay/destination fields harder to scan.
- [ ] Give bounded activity a deliberate follow-newest control. Prepending entries can preserve an old scroll anchor and hide the latest route result.
- [ ] Keep original and final destination, selected/applied/skipped reason and body omission reasons visible in request detail. Report opaque browser connection failures honestly; never imply that routing bypasses CORS.

Next slice: **R1 Shell and explanations**, separately assigned after the outstanding R0 evidence is resolved or explicitly reviewed. No R1 scaffolding or complex-app feature implementation was added here. The banking-style requirements remain in [COMPLEX_APPS](COMPLEX_APPS.md), with delivery in R2/R6/R8 and mandatory G27 verification.
