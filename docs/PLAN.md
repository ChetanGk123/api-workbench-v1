# Delivery plan and first assigned slice

Status: clean rebuild in this repository. R0, R1 and R2 are implemented (110 counted Chrome/core tests pass); saved-bookmark, Edge, restart, real-zoom, real-quota and resource gates are NOT RUN, so no slice is complete. See [R0 evidence](R0_REPORT.md), [R1 evidence](R1_REPORT.md) and [R2 evidence](R2_REPORT.md). The 2.0.0-r2 bookmark is 234K characters; the saved-bookmark size experiment should run before R3. R3 is next once assigned. The earlier `rebuild/v2` reports live in [history/](history/).

Use **R** labels to avoid rewriting the current repository's M0–M10 history. Every internal slice remains pre-release until full v1 and real-browser gates pass. No slice is an excuse to drop a later feature.

For an individual screen, assign one task ID from [the screen task index](screens/README.md). Screen tasks may span slices: shell/empty-state work can precede the engine, but full behavioral tasks remain unstarted/incomplete until their declared dependencies are available. The model/effort suggestions are task assignments, not product runtime dependencies or evidence that a gate passed.

## Ordered slices

| Slice | Working deliverable | Gate / exit evidence |
| --- | --- | --- |
| R0 Transport and bookmark feasibility | Small inline bookmark + zinc status shell; one shared planner; native Fetch/XHR, static mock, request route, cancellation and cleanup; binary route experiment; installer/size report | G01–G06 and initial G25; actual generated saved bookmark in both browsers, exact policies; capability failures documented and resolved before adopting adapter |
| R1 Shell and explanations | Persistent navigation, Home/launcher, drag/resize/geometry, shared draft/focus controls, bounded request detail with operation reasons | G03/G08/G22; host style/navigation untouched; readable selected/applied/skipped traces |
| R2 Data, endpoints and Once | Schema2 validation/migration, storage transactions, profiles/environments, all request body/credentials/header workflows, checks/samples, direct/rules Once; complex-app auth/signing/step definition schemas | G14/G15/G21; schema1 round-trip/reference migration; presets/Promote common/files fully usable; no inferred secret/refresh/signing policy |
| R3 Recorder and native/HAR review | One recorder, byte budgets/redaction/recovery, shared review/commit, native and HAR adapters | G07/G18/G20 and applicable G19; selection, distinct bodies/queries and atomic save failure |
| R4 Rule modules | Static/sequence mocks, transforms, route, synthetic/real chaos with complete operation diagnostics | G08–G10/G12/G13; probability/budget/duration/replay/corruption and binary request path |
| R5 Breakpoints | Request/response queue/edit/abort/all/deadline, stale snapshot and close | G11/G03; caller cancel wins, one completion, no duplicate page dispatch |
| R6 Expressions, plans and results | Safe grammar/picker/scanner, DAG, setup/Flow/Independent, one-pass/load, scheduler/Stop/notification, history/stats/export/samples; complex-app auth refresh/signing, guards/polls/idempotency/cross-step checks | G16/G17/G23 and G27 scenario assertions; fair bounded scheduling, no cross-context values, exact signing fixtures and logical outcomes |
| R7 Remaining imports | Swagger/OpenAPI/Postman/cURL/fetch adapters and real dialect corpus; file/example/auth/variable conversion | Complete G19/G20; all format/control paths work end-to-end in bundle |
| R8 Release and replacement | Full user journey, banking-style reference application, all settings/backup, manual update/data-only checks, deployment/docs, size probes, migration rehearsal | G01–G27 all applicable PASS, P01–P21 complete, Chrome+Edge saved installation/restart/update and complex-app journey |

R0 starts with the risky mechanics, not full screen scaffolding. R2 includes the currently missing v1 request/header features so they do not disappear beneath later rule work. R3 creates one review flow that all later importers use. Internal builds can be reviewed after each slice; public release remains R8.

The user's complex-app clarification adds [COMPLEX_APPS](COMPLEX_APPS.md) as a required target. R0's native unchanged-call tests include preservation of prepared auth/signature-like headers and exact body bytes; R2 defines the data, R6 delivers bounded auth/stateful execution and the simulated banking fixture, R8 closes G27. This expands the proposed rebuild contract; it does not assert those features exist in the current build.

## First task: R0

**Objective:** prove that the chosen native fetch/XHR adapter and current full-inline installation can support a small working vertical slice without compromising caller behavior. R0 is intentionally narrower than v1.

Read README, PRODUCT P01/P03/P11/P14/P20, NETWORK, DATA limits, VERIFICATION G01–G06/G25 and MIGRATION. Inspect existing build, fixture, adapter and M0/M6 tests before deciding whether to retain a working piece or replace it. Preserve unrelated work.

### Implement only these controls/artifacts

- Generated readable/minified IIFE, encoded void bookmark, standalone installer and raw/minified/URL size/hash report; CSS inline.
- One shadow-root panel with version/origin, activity, static mock on/off for one endpoint, bounded delay, route target for the same endpoint, Minimize/Restore/Close.
- Shared immutable intake/plan/operation outcome, one captured Fetch adapter and one XHR adapter. New UI stays inactive until explicit activation.
- Existing two-origin fixture with native controls, credentials/session, counters/slow/errors/CORS/policy pages. Add response-type/native comparison controls without erasing the existing arraybuffer regression.
- One counted runner for pure/browser checks. Every intended failure must affect exit status; mixed node:test accounting fixed in the rebuild harness.

### Assert before building the rest

1. Native unmatched Fetch and async/sync XHR behavior remain intact; no-op response/body/options/credential/event checks compare with native fixture results.
2. Static Fetch and XHR mocks return correct typed fields/events and add zero upstream hits.
3. Fetch route and async XHR text/JSON/arraybuffer/blob route reach the configured origin/path once, preserve response type and credentials policy, and do not require text response reconstruction.
4. A selected unsupported binary body transform is clearly skipped while an eligible request route still applies. Do not skip the entire request decision.
5. Abort/timeout before/during delay settle once; Close clears owned work, restores only owned APIs and leaves later wrappers intact.
6. Caller bodies/slow consumers remain usable; bounded observation never becomes full unconditional buffering. Initial body/time measurements included.
7. Install the actual artifact through real bookmark UI in Chrome and Edge; double launch/reload/restart; exact policy checks and increasing-size experiment. If unavailable, NOT RUN with exact manual procedure, not complete.
8. Inspect idle/launch requests: no code/font/style downloads. Update feature is not implemented in R0 and must not be introduced as a loader workaround.

### Output of R0

Working code, meaningful fixtures/assertions and a dated R0 evidence report with gate results, versions, sizes, commands and limitations. Update work log. If a capability fails, keep the failure visible and revisit the adapter; do not continue all UI screens on a known-invalid transport design. Stop at R0; R1 is separately assigned.

## Completion rule for every slice

The task owns changes, callers, fixtures, export/migration impact and evidence. A gate marked NOT RUN/FAIL cannot be called complete. Confirmed browser policy boundaries are documented as boundaries; unexpected failures in supported behavior are fixed. Finish one coherent slice with working controls and assertions, not empty source/document stubs.

When scope changes, update the owning contract and feature ledger explicitly. Do not silently redefine a promised feature because it is difficult. No schedule/date promise is attached to these slices; gate completion determines order.
