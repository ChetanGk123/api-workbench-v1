# R8 release and replacement — 11 October 2026

**Implementation delivered; release verification incomplete. R8 is not release-ready.** The full core/Chrome suite and focused R8 checks cover the completed workflows below. Edge, real quota exhaustion, screen-reader acceptance, native Edit-dialog update/restart and long-idle/resource acceptance remain open. Required NOT RUN gates are not passes. The generated installer stays labelled pre-release.

The final suite has **270 passed (131 core + 139 Chrome), 1 explicit quota skip, 0 failures, 0 flaky**, across 271 collected cases. Types and build checks pass. These totals do not close the skipped or unavailable release gates.

## Implementation and regressions

- Settings now persist module visibility, 50–500 activity records, 10–1000 recorder calls, response-body capture, recovery and up to 20 context roots. Missing fields in earlier schema 2 data receive compatible defaults. Hidden rule modules are inactive; hiding Recorder stops recording and keeps the draft. Body capture off skips new reads and cancels an existing recorder preview without consuming the page's copy.
- About reports the running version, storage namespace, configured update address and last checked published version. Check reads data through captured native fetch only after a click; it bounds bytes/time, refuses schema/version/length/hash errors, and never runs or installs the text. Close/clear cancel pending checks and prevent stale results restoring cleared state. Copy refusal offers the complete text and exact manual steps.
- Clear local data removes the recorder draft/recovery and current activity as well as profiles/preferences, so Close cannot resurrect an old draft. Forgotten run handles cannot write a new summary after reset. Cancel preserves the draft; host storage is retained.
- Schema 1 static mocks without an exhaustion field now retain their repeating behavior; a sequence's missing exhaustion is still reported, not guessed. The migration rehearsal covers multiple profiles/plans/rules, failed commit, Retry, inactive relaunch and the untouched old namespace.
- The installer is a self-contained first-session guide, with artifact-derived version/size/hash, accepted import versions, module descriptions, manual install/update/rollback steps, keyboard skip link and native disclosures. Unavailable clipboard APIs give manual-copy feedback.
- Native clipboard replacement exposed truncation of the original 663,841-character component-encoded URL (the pasted text produced `SyntaxError: Unexpected end of input`). The build now escapes whitespace/Unicode, `%`, `#` and `?`, retaining ASCII JavaScript punctuation in the opaque URL. The **complete, identical minified code** becomes 495,335 characters; Chrome saves it byte-exact and restarts/launches it. A probe established that escaping `?` is necessary to avoid Chrome rewriting the code as URL query text. No loader, evaluator or parser removal was introduced. Native clipboard paste of the compact artifact still requires acceptance; the cause of the original clipping is not established as a universal Chrome limit.
- Chrome journeys cover import → review → Once → sample → mock → activation → page call/detail → export → Stop all → Close. Results tests save samples, choose retained/current reruns and retain only 20 durable summaries within 2 MiB.
- Banking tests add concurrent expiry (8 jobs/4 workers, one refresh), unchanged Unicode exact-byte app signing, stale CSRF/nonce/timestamp failures, 401/403/409/422/429/503/malformed responses, poll exhaustion, lost committed-write response, post-sign intercept/route diagnostics, audience isolation and typed arraybuffer receipt routing.

## Environment and artifact

macOS 26.6.2 (25G83), Node v24.21.0, TypeScript 7.0.2, esbuild 0.28.2, Playwright 1.63.0, Chrome 154.0.8037.99. The counted suite owns ports 4330/4331; separate bookmark probes use 4340/4341. `npm ci --offline --no-audit --no-fund` succeeded; no dependency was added.

Exact final sizes/hashes and counted totals are in [r8-sizes](evidence/r8-sizes.json) and [r8-automated](evidence/r8-automated.json). Bundle hash changes require rerunning saved-artifact checks. All normal-suite launches inject the decoded generated bookmark; saved-bookmark evidence is separate.

| Final artifact | Measurement |
| --- | ---: |
| Readable IIFE | 702,376 bytes |
| Minified IIFE, including CSS | 451,315 bytes |
| Complete bookmark URL | 495,335 characters |

Minified SHA-256 `374ed01598d352924b9d1b4329bec7f58d884771d9e6b0e78dda6f19090ce300`; bookmark SHA-256 `c0a66bec9b7e3873e4b99d2d52705afac77189ae1953d878141c8a40e2c2837d`.

## G01–G27 ledger

PASS entries below mean the recorded **Chrome/core scope**, not an Edge pass or exhaustive browser conformance. The release contract requires both target browsers; it remains unfulfilled.

| Gate | Chrome/core result and evidence | Remaining release scope |
| --- | --- | --- |
| G01 | PASS: locked install, strict types, standalone/metafile/evaluator/URL checks, encoded void completion, installer artifact parity | Final deployed-address artifact, if different |
| G02 | PARTIAL: original R8 encoding passed native URL Edit/menu launch/relaunch/reload; final compact artifact passes byte-exact model/restart/navigation | Final compact native paste/relaunch/restart, drag installation and all Edge paths |
| G03 | PASS: singleton, inactive startup, delay/pause/close/caller-cancel and wrapper ownership; update read cancellation | Edge; long-idle ownership profiling |
| G04 | PASS for Fetch argument/options/credentials/signals/identity/errors/body and one-hit fixture cases | Edge |
| G05 | PASS for native XHR traces/types/sync/reuse/cancel/timeouts and event fixture cases | Edge; not an exhaustive XHR conformance claim |
| G06 | PASS: eligible binary route/header/pause actions retain native typed bytes; unsupported text edits are visibly skipped | Edge |
| G07 | PASS: UTF-8 bounds/deadlines/slots, oversize/unknown stream/caller usability and partial checks; disabling recorder previews releases a pending read | Edge; stream-buffer heap proof remains open |
| G08 | PASS: original matching, priorities/conditions/reservations/activation and operation reasons | Edge |
| G09 | PASS: static/sequence/exhaustion, typed replies/bodyless/Unicode, zero upstream mock hits and cancellation | Edge |
| G10 | PASS: transactional patch/headers/status/literal edits, malformed/binary/large fallbacks | Edge |
| G11 | PASS: request/response queues, edit/abort/all/deadline/stale/minimize/close and one completion | Edge |
| G12 | PASS: original→final route/query/auth/credentials/CORS fixture assertions and typed binary receipt | Edge |
| G13 | PASS for existing synthetic/real latency/fault/corruption/replay/probability/budget/duration and Stop fixtures | Edge; broader tester-driven chaos acceptance |
| G14 | PASS: editor/header/environment/body/file/sample/dependency workflows | Edge |
| G15 | PASS: prepared/direct/rules/blocked/cancel/check/sample workflows | Edge |
| G16 | PASS: grammar/DAG/Flow/Independent/setup/one-pass/load/Stop, bounded admission and contexts | Edge |
| G17 | PASS: accounting/timing/statistics/JSON/CSV, samples/history and retained/current reruns; 20-summary retention | Edge; adversarial 2 MiB eviction workload |
| G18 | PASS: both transports/redaction/query-body grouping/recovery/selection/promotion, call cap and 1 MiB byte cap | Edge |
| G19 | PASS: every declared adapter parse→review→commit→send, no execution/network; Chrome DevTools corpus | Edge-generated corpus and browser suite |
| G20 | PASS: copy/merge/replace/refs/stale review/failure rollback/Retry | Edge |
| G21 | PASS for schema/ref validation, backup and migration, refusal/conflict/session-only behavior | Real disk quota NOT RUN; diagnostic below; Edge |
| G22 | PASS for keyboard/focus/drafts/navigation and constrained layouts; actual Chrome 200% Home/Settings readable with reachable Close, zoom restored | Screen-reader pass; full real-zoom screen matrix; Edge |
| G23 | PASS: hidden work inactive, capture/log limits/reset/context roots and explicit descriptor-based scans | Edge |
| G24 | PARTIAL: data-only check/copy and errors pass; compact model/clipboard/restart is byte-exact | Original native paste produced incomplete code; compact native Edit/Paste update and restart still open; production host/address not supplied; Edge |
| G25 | PASS for saved-URL exact strict/blocked policy launch/style/network separation, no idle assets, bounded burst/capture and empirical GC observations | Long-idle/typing-task/stream-buffer resource acceptance and Edge |
| G26 | PASS for the representative new-user workflow and P01–P21 implementation trace below | Overall release cannot pass with remaining gates |
| G27 | PASS for the banking assertions described above and R6 regression fixtures | Edge; complete authentication-boundary and burst-under-load acceptance |

## Banking scenario trace

| Required scenario | Evidence |
| --- | --- |
| Session/dynamic tokens | R6 app login/session and per-write rotating CSRF; R8 stale-CSRF rejection |
| Concurrent expiry | R8 8 independent read jobs / concurrency 4, exactly one refresh, no stale-token response; pure refresh-failure/Stop races plus R6 failure journey |
| Transfer | R6 dependent accounts/quote/write/poll/receipt with exact `100.10 + 0.50 = 100.60` string assertions; R8 cap stops polling and receipt guard skips |
| Duplicate/uncertain response | R6 deliberate duplicate/new logical key; R8 committed write then dropped response: Workbench sends once and dependents do not proceed |
| Signing | Node HMAC canonical vector; R8 exact Unicode app bytes succeed, nonce/timestamp replay fails; missing runtime key blocks; post-sign intercept/route decisions named |
| Multi-service | Origin B audience blocks before dispatch; explicit route auth forwarding and denied CORS regressions |
| Binary/burst | R8 routed native arraybuffer receipt and Once content; request-ID capture joins under a 60-call burst |
| Authentication boundaries | Existing scope/closure/key guidance and visible binary semantic skips; complete real-frame/worker/manual-challenge acceptance still open |
| Failures | HTTP 401/403/409/422/429/503 and malformed body distinct; refresh rejection and pending cap non-success; no automatic Workbench mutating retry |
| Export/relaunch | R6 no runtime token/key in stored profiles/results, key required again after reload; R8 migration and normal export journey |

Chrome's native network stack may resend a request after a reused keep-alive connection drops. The lost-response test distinguishes Workbench dispatch count from server request count; the fixture's rotating CSRF/signature/idempotency checks keep one logical transfer. A disconnect is not proof that a write was not committed.

## Bookmark, policy and resource measurements

[Earlier R8 size/policy JSON](evidence/r8-bookmark-chrome.json) records the component-encoded candidate plus padded copies. Chrome retained/restarted/launched near 1.0 and 1.5 MiB; near 2 MiB a bookmark-manager page crashed or navigation failed. [Final compact artifact JSON](evidence/r8-bookmark-final-chrome.json) records its byte-exact saved/restarted URL, 30 ms launch and exact policies. These are measured installation paths, not a universal limit. Strict `connect-src 'self'` yields a styled panel and HTTP 200 same-origin request; blocked-connect yields a styled panel and native TypeError. Console injection does not supply this evidence.

[Update JSON](evidence/r8-bookmark-update-chrome.json) records compact labelled `r8`/`r8.1` candidates with a loopback update address: one manifest and bookmark read, checksum-exact clipboard text, byte-exact saved URL, old version until replacement, new version after restart. Native UI acceptance is separate: the original long candidate reached Check/Copy, but Edit/Paste/Save/reload/menu launch failed with incomplete code. The compact fix passed the model cycle; native paste acceptance remains open. `/deploy/install.html` navigation was also refused (`ERR_BLOCKED_BY_CLIENT`); the rehearsal used the regular installer route with a labelled test candidate, then restored the final installer.

[Resource JSON](evidence/r8-resources-chrome.json) records native/hooked 60-call bursts at concurrency 10, one-second idle with zero requests, correctly joined response/query captures, recorder stopping before 30 large UTF-8 calls at the 1 MiB draft cap, and forced-GC heap/node/listener observations before/after. Close removes the panel. Retained heap does not return to the native baseline in this short probe; counts are not a leak proof, and no 50 ms interaction or long-idle target is claimed.

The native UI check created **AW R8 release test** in Chrome's API Workbench bookmark folder using the URL Edit path. It launched the original R8 candidate on the dedicated fixture, restored one minimized panel and launched after reload; the same code passed actual Home/Settings 200% zoom checks and zoom was reset. Dragging had no observable saved-bookmark result. The test bookmark was subsequently used for the failed long-URL paste rehearsal and is not an accepted final installation. It is separate from the user's production bookmark. Native observations and their artifact identities are in [r8-native-chrome](evidence/r8-native-chrome.json).

## Concrete blockers

- **Edge NOT RUN.** `/Applications` has no Edge. `npx playwright install msedge` stopped at sudo requiring a password. The official Microsoft 155.0.4283.45 package downloaded to `/tmp` has SHA-256 `9f34fb05d8c66440cd8f972dc0c34d0f9e9ef25827525c093117ba61d69ee2e1`, matching Microsoft's product metadata, but both `pkgutil --check-signature` and `codesign --verify --deep --strict` reported invalid signatures. It was not installed or run, and security checks were not disabled.
- **Real quota NOT RUN.** CDP reported an active 32 KiB override, yet accepted 16 MiB in a bounded disposable persistent-profile probe. The counted real-quota test explicitly skips on that outcome and preserves its intended rollback/export/Retry assertions for an environment that enforces quota. [Diagnostic](evidence/r8-quota-chrome.json). Injected quota/write errors and actual atomic transaction conflicts remain tested independently. No disk was filled to exhaustion.
- **Human/resource gates open.** Native UI update/restart, drag installation, screen-reader acceptance, the full real-zoom matrix, long-idle/input latency and slow-stream heap acceptance have not passed. See [RELEASE](RELEASE.md) and [VERIFICATION](VERIFICATION.md) for the required procedure.

## P01–P21 implementation trace

| Features | Implementation/workflow | Checks |
| --- | --- | --- |
| P01/P20 | `scripts/build.mjs`, installer, `data/update.ts`, Settings/About, bookmark probes and deployment/rollback guide | G01/G02/G24/G25; P20 verification incomplete |
| P02/P03 | `ui/panel.ts`, geometry, entry/runtime/transport lifetime | shell/browser/pauses + R8 cancellation/resource checks |
| P04/P05 | endpoints/editor, schema, header presets/promotion and environments | data core/browser |
| P06 | Once preparation/send/check/copy/sample | data/plans/release/browser |
| P07/P08 | plans/run/graph/stats/results/history/rerun/export | tester core/plans/release |
| P09 | recorder/capture/import review/recovery | import/release |
| P10 | native/HAR/specs/snippets/import transaction | adapters/import core + every formats browser case |
| P11–P15 | mock/intercept/breakpoints/route/chaos shared planner and adapters | rules/pauses/browser core + browser |
| P16 | safe expressions, dispatch bindings, user-triggered scan | tester core/plans/release |
| P17/P18 | store/schema/migration/backup, complete Settings resources/About | data/import/release core + browser |
| P19 | navigation/focus/drafts/status/selected-applied-skipped explanations | shell/data/import/rules/pauses; human accessibility acceptance incomplete |
| P21 | declared auth/refresh/signing/guard/poll/idempotency/cross-step assertions | tester core + plans + bank.plans; Edge/boundary acceptance incomplete |

## Commands and handoff

```sh
npm ci --offline --no-audit --no-fund
AW_PORT=4330 AW_OTHER_PORT=4331 npm run verify
AW_PORT=4340 AW_OTHER_PORT=4341 npm run fixture
AW_PORT=4340 node scripts/bookmark-experiment.mjs docs/evidence/r8-bookmark-chrome.json
AW_PORT=4340 AW_OTHER_PORT=4341 node scripts/bookmark-update.mjs docs/evidence/r8-bookmark-update-chrome.json
```

The default 4310 fixture was already running and was left untouched. Only the separate fixture started for these probes is owned by this task. No public hosting was changed. R8 implementation is reviewable in the working tree; open release gates remain explicit rather than silently narrowing the contract.
