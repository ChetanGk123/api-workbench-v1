# Verification and release gates

Status: rebuild verification contract. Gates initially started **NOT RUN**; current results and remaining gaps for the clean rebuild are recorded in [R8_REPORT](R8_REPORT.md); earlier `rebuild/v2` results are in [history/](history/). No full release gate is implied by a subset pass. Prior results in the [end-user report](../END_USER_TEST_REPORT.md) apply only to that reviewed build.

## One counted runner

Use one Playwright Test runner for pure core assertions and browser cases, matching most existing tests. Pure tests receive explicit clocks/random/context/storage fixtures and do not require browser globals. Browser contract cases use real installed Chrome/Edge. If any other runner is retained, it must have a distinct command included in the top-level exit code and report; a printed failure outside the counted suite is unacceptable.

Build/type/bundle checks and tests are separate mandatory steps. `npm run verify` exists and runs strict types, the standalone build checks and the counted Playwright suite. Do not change scripts merely by documenting them as completed.

Tests assert product behavior, not copies of implementation functions. Mock tests compare server-hit deltas; transport tests compare native control traces; import tests verify no requests/code execution and durable state; race tests control order. Add a small focused regression with each nontrivial fix, not a giant generic snapshot.

## Fixtures to retain and extend

Keep the two-origin loopback fixture as test infrastructure, not a shipped product service. Current routes and exact startup commands are in [TEST_SERVER](../TEST_SERVER.md).

| Fixture | Required evidence |
| --- | --- |
| Echo/session/auth | Method, headers, repeated query, exact body bytes, eligible HttpOnly cookie receipt, explicit credentials/bearer behavior |
| Counters | Primary and replay hit deltas read outside wrapped page transports; tests isolate/reset their own scope |
| Delay/disconnect/status | Abort/timeout/HTTP-error differences and no post-stop admission |
| CRUD producer/consumer | Distinct per-iteration state; graph and setup semantics |
| Text/JSON/XML/malformed/bodyless | Checks, sample provenance and supported body transforms |
| Binary and XHR types | Text/JSON/arraybuffer/blob/document + upload/reuse; unchanged typed values and route capabilities |
| Stream/oversize/slow consumer | Caller body remains usable, bounded observation, no hidden unlimited tee buffering or hung branch cleanup |
| CORS allowed/denied | Actual origin/session/Authorization policy and honest opaque errors |
| Wrapper before/after install | Captured delegation and safe restoration ownership |
| Storage refusal/quota/conflict | Atomic commit failure, persistent Unsaved status, export/retry and revision races |
| Parser corpus | Real accepted clipboard dialects, required values, malformed/ref/depth/Unicode/multipart/auth inputs |
| Keyboard/layout | Focus, dirty drafts, long labels, list retention, constrained height/zoom and reachable controls |

The current playground intentionally uses XHR `arraybuffer`. Keep that regression. Add a visible response-type selector/native control fixtures for other types without replacing the arraybuffer path just to pass routing tests.

Prefer a separate suite-owned fixture server and deterministic per-test state. If testing an existing server, use a readiness **URL** and `reuseExistingServer: true`; a stdout-only startup wait does not discover an existing process. Do not silently stop the user's server. Record shared-state limitations if counters/data are not isolated.

## Required gate ledger

Use stable IDs in reports. All applicable feature IDs in [PRODUCT](PRODUCT.md) must have both a user workflow and a gate; no isolated parser test substitutes for the feature.

| Gate | Required assertions | Features |
| --- | --- | --- |
| G01 Build | Strict types, locked install, standalone IIFE, void bookmark completion, Unicode/encoding round-trip, no runtime imports/assets/evaluators | P01/P20 |
| G02 Real bookmark | Install actual generated full URL, navigate to fixture, click saved bookmark, relaunch/restart; capture version/path/size | P01/P03/P20 |
| G03 Lifecycle | One instance/hook, minimize/restore, close during delays/pauses, wrapper ownership, no dangling listeners/timers/readers | P02/P03/P13 |
| G04 Native Fetch | URL/Request+init precedence, credentials/options/signals/errors, response identity/body usability, unmatched one-hit behavior | P03/P06/P14 |
| G05 Native XHR | Construction/prototype/upload, methods/fields/events/listener styles, responseTypes, sync passthrough, reuse/abort/timeout | P03/P11–P15 |
| G06 Binary request actions | Route/request header/pause on arraybuffer/blob without text reconstruction; native output preserved; visible skip for unsupported body edit | P12/P13/P14/P19 |
| G07 Body limits | UTF-8 byte limits, deadlines/concurrency/total budget, unknown stream exclusion, partial checks never pass, owned reader cancellation | P09/P12/P18 |
| G08 Rules | Original-snapshot matching, priorities/globs/conditions, deterministic reservations, effective activation, selected/applied/skipped/superseded reasons | P11–P15/P19 |
| G09 Mock | Fetch/XHR fields/events, static/sequence/exhaustion, Unicode/bodyless, delay abort, zero upstream hits | P11 |
| G10 Intercept | Request/response header/body/status, JSON Patch atomicity/prototype guard, malformed/large/binary skip, original response fallback | P12 |
| G11 Breakpoints | Pre-dispatch zero-hit, final response override, continue/abort/all/deadline/cap, stale snapshot, minimized/close, exactly-once completion | P13 |
| G12 Route | Exact/glob/query rules, original→final origin/path, CORS/credentials/Authorization, binary request lane, one primary hit | P14 |
| G13 Chaos | Synthetic/real every fault, probability/seed/budget/duration, corruption, primary+bounded replay, no child recursion/duplicates after Stop | P15 |
| G14 Editor/headers | CRUD/dependency impact, alias ref update, credentials, every body kind/files, presets, Promote common, inherited headers/removals, samples/checks | P04/P05 |
| G15 Once | Prepared effective request, direct/rules, blocked inputs, session/body/check outcomes, cancel/copy/sample actions | P06 |
| G16 Plans/expressions | One-pass + repeat, Flow/Independent/setup/DAG, jobs/concurrency/ramp/delay/Stop, built-ins/source failures, no evaluation | P07/P16 |
| G17 Results | Progress/outcome accounting, source-separated timings/counts, means/P95/sample cap, snapshots/rerun, JSON/CSV content and formula defense | P08 |
| G18 Recorder | Future calls only, both transports, redaction/caps/body states, distinct query/body grouping, recovery/selection/promotion | P09 |
| G19 Every import | Per format parse→preview→commit→representative send; zero send/evaluation during import, refs/auth/examples/unresolved/files, file/paste parity | P10 |
| G20 Import transaction | Copy/merge/replace, IDs/references, stale revision/profile, save failure rollback, exact counts and retained draft | P10/P17 |
| G21 Storage/migration | Schema1→2, future refusal, corrupt input, quota/multitab conflict, backup/restore, redaction, atomic profile switch | P17 |
| G22 Shell/UX | Persistent navigation, correct Back/focus, dirty drafts, filter/scroll, consistent names, status/limits, keyboard/200% zoom/layout | P02/P19 |
| G23 Settings/context | Visibility truly stops hidden module work, log/capture settings, source scan limits/getter avoidance, storage info and recovery | P16/P18 |
| G24 Update/deployment | Data-only user-triggered read/copy, stale/malformed/refused manifest, clipboard refusal, current artifact matching, manual saved-bookmark update | P01/P20 |
| G25 Policy/resource | Real-bookmark launch/style/network separate under exact policies; idle no assets/polling; memory/log/resource release under bounded traffic | P03/P18/P20 |
| G26 Complete v1 journey | New-user end-to-end normal journey and full P01–P21 traceability, no missing/placeholder controls | All |
| G27 Complex application | Banking-style auth rotation/expiry under concurrency, signed exact-byte requests, dependent transfer/poll/assertions, idempotency and multi-service/binary failures; all scenario assertions in COMPLEX_APPS | P21 and P03–P19 |

G27 is mandatory before claiming complex-app readiness; an echo/mock pass alone does not close it. Follow [the banking-style scenario matrix](COMPLEX_APPS.md) in a simulated fixture, with every target browser/version and expected server-side invariant recorded. No live financial application or real funds are needed for this gate.

## Policy fixtures

Retain the current exact strict policy:

```text
default-src 'none'; script-src 'self'; style-src 'none'; connect-src 'self';
img-src 'none'; require-trusted-types-for 'script'
```

Retain the blocked variant with `connect-src 'none'`. Add a plain control and specific style/connect/Trusted Types probes as needed. For each browser record separately: actual bookmark activation, UI CSS application, permitted same-origin native requests, denied connection, mock behavior and cleanup. Never loosen a policy midway and retain its old name. A platform limitation has a named exact policy and user-visible outcome; it is not automatically an engine defect or a passing universal-support claim.

## Real saved-bookmark procedure

1. Build the exact release candidate; record artifact hashes, raw/minified bytes and encoded URL characters. Verify installer and bookmark text match.
2. Use a test browser profile with no production secrets. Show bookmarks bar; drag the real installer link, or explicitly record the manual URL paste path.
3. Navigate to fixture, launch from the actual saved bookmark. Confirm version, one panel, one shared layer and expected request behavior. Clicking a link on the installer is a different path.
4. Minimize, click saved bookmark again, verify restore and no duplicate request effects.
5. Reload fixture, launch again; close/restart browser and repeat. Capture retained URL/version and actual responses through bookmark UI, not console injection.
6. Run policy probes with the same installed artifact; separately test enlarged inert payloads and name the installation path. Do not infer a universal length limit.
7. Repeat all required paths in desktop Edge with its exact version.
8. Save an older release candidate; publish a newer data manifest/bookmark, Check for update, Copy new bookmarklet, manually replace saved URL, reload and relaunch. Verify downloaded version/hash and running version change. Text copy alone is not an update.

If UI automation cannot finish installation/restart/update, provide these manual steps and mark the gate NOT RUN. The prior existing-bookmark launch is useful evidence, but does not close a new artifact's gate.

## Performance/resource evidence

Record browser/OS/viewport, native baseline and fixture payload/counts. Measure burst traffic while typing, worst-case log/import limits, slow consumers, body budget exhaustion and cleanup. Proposed interaction target is no Workbench task blocking UI input for more than 50ms in the measured fixture; report actual measurements rather than promising it. Yield bounded parser work, coalesce updates and avoid unnecessary body reads first.

Verify UTF-8 accounting and monotonic sample counts. Memory observations are empirical browser measurements; counts alone do not prove absence of a stream buffer leak. Identify remaining uncertainty when tooling cannot expose it. Do not keep repeating a successful full suite unless changes or unresolved risks justify it.

## Release report format

For each gate: PASS/FAIL/NOT RUN, artifact/version/browser, exact command or manual installation steps, assertion/result, evidence path and limitation. Publish size/hash/format/capability matrices for the exact build. Count every intended test, including failures before test collection. Required FAIL/NOT RUN prevents marking the associated slice/release complete.

Current repository commands (see [RELEASE](RELEASE.md) for ports and standalone bookmark probes):

```sh
npm ci
npm run build
npm run fixture
npm test
AW_BROWSER=msedge npm test
```

The standard test config starts its own server; do not run it against occupied ports without an explicit existing-server configuration. Rebuild scripts/config were implemented in R0; R8 adds update and saved-bookmark probes. Their documented startup and verification paths must be checked as part of G01/G26.
