# Tester, expressions and results

Status: proposed rebuild execution contract. The runner is browser-local and uses one tab's account/cookie jar; isolated variables do not create independent authenticated users.

Complex banking/enterprise flows additionally require [COMPLEX_APPS](COMPLEX_APPS.md): transient auth contexts and explicit refresh, finite request-signing recipes, structured guards, bounded read-only polling, logical idempotency bindings and cross-step assertions. These requirements extend endpoint plans through typed fields, not arbitrary scripting. Include every possible bounded dispatch in preflight and network admission accounting.

## Request preparation

All sends, plan jobs and explicit replay share one preparation path:

1. Capture endpoint/config revision and execution context.
2. Resolve host/environment origin without silently rewriting absolute URLs.
3. Reserve generated values once and resolve required selected bindings at dispatch.
4. Construct path/query/headers/body with site-appropriate escaping and explicit credentials.
5. Validate supported method/body, required values/files and finite bounds.
6. Show a redacted preview/preflight; dispatch only after success.

Direct uses captured transport and bypasses active rules. Apply rules enters the shared pipeline. The source stays tester in metadata; do not add an identification header that alters CORS. Replay children reuse logical prepared values, never generate another UUID/counter/idempotency key for a duplicate; only recipe-declared per-attempt signing freshness may be renewed.

A logical idempotency value is stable for explicit duplicates. A signing recipe may still require a fresh timestamp/nonce/signature for each transmitted attempt. Such attempts reuse the logical payload/key and re-prepare only recipe-declared freshness fields; when a replay rule has no supported recipe it copies exact frozen bytes and must state that the server may reject a stale nonce/signature. Never present either behavior as an automatic retry of an uncertain write.

Body support includes exact text/JSON, ordered URL-encoded pairs and multipart fields/files. Use browser FormData boundaries. Missing imported file descriptors block until explicit file selection; no local path auto-read. JSON formatting is optional. Header removal is explicit; credentials are editable Same origin / Include / Omit.

## Once and one-pass plans

**Once endpoint** sends the selected endpoint once, with cancel and detailed checks/body/headers/result actions. **Run plan once** executes selected setup/load steps using the selected Flow/Independent strategy with one repetition, without overwriting saved Load repetition settings. **Run Load** repeats using the plan's repetition settings.

This resolves the historical difference between the existing single-endpoint Once UI and the original plan's one-pass selected steps: retain both capabilities with distinct actions. Do not call a single endpoint request a completed business flow.

## Expression grammar

Expressions use `{{ ... }}`. Parse into a bounded syntax tree; never run JavaScript. Internally producer references use endpoint IDs, with aliases for display and portable syntax. Support own-property paths and numeric arrays: `{{create_user.id}}`, `{{list_items.items[0].id}}`.

| Form | Contract |
| --- | --- |
| `{{$uuid}}` | UUID reserved once per prepared request |
| `{{$timestamp}}` | Epoch milliseconds reserved once per prepared request |
| `{{$counter("order", 1, 1)}}` | Run-scoped named counter, initial/step safe integers, reserved in scheduler order |
| `{{$randomInt(1, 100)}}` | Inclusive safe integer bounds; one reserved value per identical expression in this prepared request |
| `{{$cookie("XSRF_TOKEN")}}` | Explicit JS-readable cookie name; missing fails required binding |
| `{{$localStorage("token")}}` | Explicit storage key, read safely at dispatch |
| `{{$sessionStorage("token")}}` | Same contract for session storage |
| `{{$meta("csrf-token")}}` | Explicit uniquely resolved meta name/content |
| `{{$dom("#token", "value")}}` | Explicit selector and approved value/textContent/attribute mode; no arbitrary property/getter execution |
| `{{$context("auth")}}` | Named user-selected source binding, refreshed at dispatch |
| `{{$eval("amount * 2 > 10")}}` | Restricted literals/arithmetic/comparison/boolean/own paths over prepared bindings; no calls/statements/assignments/global access |

Missing/ambiguous values, prototype keys, invalid paths, unsafe integers and forbidden syntax produce field-specific blocked-before-dispatch errors. Path/query expressions encode components; header values reject illegal line breaks; JSON values preserve types when the whole value is an expression. Text interpolation uses a documented string conversion; do not stringify objects implicitly in headers or path components.

Repeated identical generated expressions in one request reuse one reservation. A preview is a draft reservation; editing or Regenerate makes a new reservation. Manual Once uses a separate transient counter scope. Determinism applies to a defined admitted job order/seed, not arbitrary concurrent page arrival order.

Proposed parser limits: expression 512 characters, path 16 segments, restricted-eval 256 syntax nodes/depth 16, total 1000 expressions per prepared request. Errors identify location. No prototype traversal or getters. Unknown builtin/name fails; no fallback to executing source text.

## Page context discovery

Scan only on an explicit user action with selected categories: readable cookies, local/session storage, meta tags, configured named global roots and DOM form fields. Show names/paths with masked values and source errors. Proposed bounds: 40 candidates per category, 200 total, global depth 3; safe own data descriptors only, no getters/functions or unrestricted window walk.

The user chooses bindings. Store source/key/attribute/name, not current values; resolve again before dispatch. Storage access failures are caught around obtaining the storage object and reading it, not after unsafe global access has already thrown. Source disappearance blocks required values and explains how to fix them.

## Dependency planning

Scan parsed references across URL/query/global+local headers/body and build a DAG. Reject duplicate aliases, missing producers, cycles and setup depending on load. Alias rename previews all actual references. Captured sample similarities are reviewable suggestions, never automatic dependencies.

Preflight shows selected endpoint count, setup/load jobs, exact projected primary/replay bounds, destinations, active-rule mode, mutating steps, concurrency meaning and missing inputs. Do not dispatch partially because validation found errors late. Where setup produces a required value, preflight validates the dependency rather than demanding an output before setup ran.

## Scheduling

| Concern | Flow | Independent |
| --- | --- | --- |
| Setup | Once per run in dependency order, read-only outputs shared within run | Same |
| Load | Sequential dependency order inside each iteration | One fair queue per selected endpoint, repetitions per endpoint |
| Context | Fresh context per iteration, seeded from setup outputs | Fresh context per (endpoint, repetition) job |
| Concurrency | Maximum simultaneous iterations | One global simultaneous-request limit across all queues |
| Delay | Worker waits after complete iteration before next one | Worker waits after complete job before next admitted job |
| Ramp-up | Admit iteration workers at configured step | Admit global request workers at configured step |
| Cross-load dependency | Valid if acyclic and within iteration | Invalid; offer Flow or reviewed producer promotion to setup |
| Failure | Producer failure skips dependents; unrelated steps follow continue/stop | Job isolated; continue/stop policy applies to admission |

Setup failure blocks load. No implicit response reuse across runs/profiles/accounts. No automatic retries of mutating requests. A shared session may change server state across simultaneous iterations; preview that fact and require intentionally distinct fixture data where needed.

Scheduler owns all tester controllers and timers. Stop prevents new admission, cancels queued jobs and owned requests, then finalizes distinct aborted/skipped outcomes. Notification is in-panel by default; optional browser notification requires explicit permission and must have a useful fallback. Profile switch/Close never allows queued jobs to leak into a new profile.

## Checks and result meaning

Checks: status/range, header presence/equality, literal body-contains, JSON path equality/existence/type and duration limit. Default status 2xx; a deliberate expected 503 can pass. Body checks require complete eligible data; unavailable/truncated data is not-evaluated and cannot pass. Type/parse/size errors are distinct from HTTP/network errors.

Request outcomes: passed, failed-check, network-error, timeout, aborted, skipped-dependency and blocked-before-dispatch. A run state is queued/running/completed/stopped/failed-preflight, separate from whether individual checks passed. Results show category breakdown rather than hiding every outcome inside Failed.

Structured guards add **skipped-condition**; required auth/refresh/signing failures retain a precise blocked reason. Poll attempts have their own request outcomes plus a logical step terminal state. Cross-step checks can compare declared same-context producer values, including exact integer/fixed-scale decimal representations, without converting domain values into floating-point approximations.

Timing fields: queue wait, breakpoint wait, injected delay, dispatch-to-headers, owned body-read completion and total. Use monotonic durations. Show network vs mock/synthetic sample counts and avoid blending them into a claimed server latency. An observer preview duration is not the application's full body-consumption time.

For retained samples, P95 is nearest rank `sorted[ceil(0.95 * n) - 1]`; show sample count and whether samples were capped. Means use total durations/counts across measured samples, not means of means. Unavailable values are absent, not zero. Never imply a capped sample P95 describes unretained data. Bounded last response samples retain provenance and capture state.

JSON export includes schema/run/plan/config identity, outcomes, timing definitions and redaction state. CSV escapes delimiter/quote/newline and neutralizes formula prefixes in user-controlled text. Run again identifies which configuration will run; offer retained snapshot vs current configuration when they differ, rather than silently using a changed endpoint.

## Acceptance journeys

- Once CRUD/session/header/body/check and credentials/file configuration paths work through UI without hand-writing native import JSON.
- Flow create→read with `{{producer.id}}` stays inside each iteration; setup runs once; failed producer blocks only dependents unless Stop selected.
- Independent preflight rejects another load endpoint's output; valid jobs obey global concurrency and fair admission.
- Counter/UUID/time/random values remain stable within preparation/replay, distinct where intended across jobs, and source bindings refresh at dispatch.
- Stop/Close/profile-switch dispatch no new jobs; owned aborts settle with useful results.
- Complete/incomplete bodies cannot produce misleading checks; displayed counters/means/P95/export agree with controlled fixtures.
- Mutating preflight is visible; no browser-local run is marketed as server capacity evidence.
