# Network and lifecycle contract

Status: proposed operation contract. Every capability below needs separate Chrome and Edge evidence. No table entry is a claim that the existing or rebuilt adapter has passed it.

The [Fetch Standard](https://fetch.spec.whatwg.org/#fetch-api) defines request/response semantics, the [XHR Standard](https://xhr.spec.whatwg.org/#interface-xmlhttprequest) defines XHR fields/events, and the [Streams Standard](https://streams.spec.whatwg.org/#rs-tee) defines stream splitting. Use native fixture behavior and these standards as the oracle. Bookmark launch, styles and subsequent connections require separate policy checks under [CSP](https://www.w3.org/TR/CSP3/#connect-src); injection success is insufficient.

## Intake and planning

Assign one request ID and capture: caller source (page/tester), transport, original URL/method, script-visible headers, supported body metadata, credentials intent, caller signal, frame origin and configuration revision. Do not consume a body merely to describe the request. Preserve the original invocation alongside the descriptive record.

For complex apps preserve already-prepared signing/nonce/CSRF/correlation data on unchanged delegated calls. Signed/encrypted wire content is not necessarily semantically editable. Direct signing preparation and intentional signature-breaking rules follow [COMPLEX_APPS](COMPLEX_APPS.md); a captured request does not grant key access or make an expired request reusable. Selected edits that affect signature components need a visible preparation/invalid-signature outcome, not an implied successful re-sign.

The shared planner returns selected rules plus ordered operations. It must distinguish **selected**, **eligible**, **applied**, **skipped**, **superseded**, **failed**. The transport adapter decides operation eligibility using actual request/response capabilities; it must not declare every action unavailable because one body operation is unavailable.

## Pipeline order

| Stage | Contract |
| --- | --- |
| 1. Intake | Capture immutable original request and config revision; honor already-aborted callers |
| 2. Selection | One winner per module; reserve mock slot and chaos sample once in intake order |
| 3. Request work | Apply eligible request edits transactionally; request breakpoint only for a real provider |
| 4. Provider | Synthetic chaos HTTP/failure wins, else mock, else captured transport |
| 5. Dispatch | Real provider only: route, explicit pre-delay, one primary dispatch; explicit replay alone creates bounded children |
| 6. Response work | Transactional supported response edits; no body edit for an unreadable/missing response |
| 7. Real chaos | Real provider only: configured fault/delivery delay after transforms; upstream work is not undone |
| 8. Response pause | Real response only; final explicit edit/continue/abort |
| 9. Delivery | Settle caller once, publish outcome/operation reasons/timings, release owned resources |

Resolve provider during planning so synthetic replies never enter a breakpoint waiting for a nonexistent server. Request edits may affect the prepared synthetic path, but do not cause a network call. Response transforms may edit synthetic HTTP responses; a transport failure has no ordinary response to patch. Route and real chaos are marked superseded when a synthetic provider wins.

Replay children use frozen logical payload/idempotency values and captured transport; they never re-enter selection or create recursive replay. Exact captured replay copies the original bytes. Only an explicitly configured supported signing recipe may re-prepare declared per-attempt timestamp/nonce/signature fields, as specified in COMPLEX_APPS; it does not regenerate other request values. Caller sees only the primary completion. Each child has a parent ID and its own record. Sequence cursors and random sampling are not advanced by child dispatches.

## Matching and rule behavior

- Match the original request, not a route/transform's output. No rematching chains.
- Higher integer priority wins, then creation sequence ascending, then stable ID. Conditions are ANDed. A failed chaos probability sample does not try a lower-priority rule.
- Explicit origin, method (`*` allowed), exact pathname or glob; `*` stays in a segment, `**` crosses segments. Query constraints are separate; a repeated key matches if any value equals the constraint. Header names are case-insensitive.
- A relative matcher is scoped to the launch frame origin. Preserve queries by default in a route rewrite; path rewrites are exact or a single documented trailing `/**` capture.
- Body-contains requires an eligible complete bounded text body. Missing/truncated/oversized data returns condition-not-evaluated and does not produce a false match.
- Endpoint links use immutable IDs. Manual matcher method/URL edits explicitly detach on save; deletion previews detach-to-last-matcher vs delete-linked-rule.
- Static mocks and sequences return legal transport replies. Reserve a slot atomically at intake; loop/repeat-last/failure exhaustion is explicit and never falls back to real traffic.
- Header/body edits are validated before saving. JSON Patch runs on an isolated own-property value and commits only if every operation succeeds. Forbid prototype traversal. Literal replacement has first/all modes. Rewritten content drops stale length/encoding metadata.
- Chaos has explicit synthetic/real mode, eligible fault kind, probability, seed, hit budget and optional activation deadline. Valid-JSON field corruption uses the same patch engine; malformed JSON is a separate named action. Budget/cursors reset on activation or meaningful action revision, not on cosmetic label edits.

## Proposed operation capabilities

**Target** means required experimental work. **Skip** means a documented unsupported body action with visible reason. An unsatisfied target is a failing rebuild gate; it is not permission to ship a silent fallback.

| Operation | Fetch finite text/JSON | Fetch opaque/unknown stream/binary | Async XHR text/JSON | Async XHR arraybuffer/blob/document | Sync XHR |
| --- | --- | --- | --- | --- | --- |
| Unchanged delegation | Native | Native | Native | Native | Native |
| Metadata observation | Target | Only available metadata | Target | Target | Minimal native metadata only |
| Bounded body capture | Eligible complete text | Skip body read | Target within bounds | Metadata only; byte samples need an explicit tested contract | Skip |
| URL route / request headers | Target | Target if original request remains usable | Target | **Target without response text reconstruction** | Skip modification |
| Response headers / delivery latency | Target | Response reconstruction is conditional; skip with reason when fidelity unavailable | Target | Separate experiment preserving typed native response | Skip |
| Body transformation | Eligible complete finite text | Skip | Eligible complete text/JSON | Skip; preserve native typed delivery | Skip |
| Synthetic static reply | Legal Response | Legal Response when rule is independent of unavailable body | Target | Target per responseType with correct conversion; never claim document fidelity without tests | Skip |
| Request / response pause | Target real provider | Request pause may work; response edit is capability-limited | Target real provider | Target request pause; response shows available metadata, no binary-to-text fiction | Skip |

The current review's arraybuffer route skip is the first regression fixture. Rebuild routing must not depend on whether the response can be decoded as text. If the chosen XHR adapter cannot preserve native typed delivery, revisit the adapter at R0 before building all feature screens.

## Fetch adapter

- Keep a true no-op path: delegate the original arguments to captured fetch and return its original Response unchanged. Preserve Request+init precedence, signal, credentials, mode, redirects, cache, body ownership and errors.
- Normalize into a changed request only when an eligible explicit action requires it. Validate the changed request before dispatch. Uncloneable/used/streaming bodies need a named limitation; never read a caller body for convenience.
- Recorder preview reads must be opt-in, independent of caller consumption and bounded by bytes, time and concurrent operations. Do not clone all page responses and then truncate storage after the full body was read.
- Only a body known eligible for finite bounded transformation may be buffered. Keep pass-through unchanged for unknown streaming content. A retained original branch permits fallback only if it is still usable and the operation's buffering budget is honored; cancellation of one tee branch can interact with the other, so test branch cleanup under slow consumers.
- Mock HTTP errors resolve as Responses; simulated transport failures reject; timeout/caller abort semantics are distinct. HEAD/bodyless statuses have no body. Synthetic/rebuilt Responses cannot promise identical native URL/redirect/filter metadata; retain original metadata in the record.
- The tester may consume its owned response under its explicit size/deadline policy; that is not permission to consume arbitrary page response streams.

## XHR adapter experiment

Preferred starting point: retain native XHR objects, constructor/prototype identity and a captured native backing transport. Instrument open/send/header/abort behavior only where needed. Define synthetic delivery as an explicit state/event machine. Do not implement XHR by forwarding everything to fetch.

For real routed/request-edited requests, preserve the native typed response and upload behavior rather than round-tripping through a text-only response representation. If an additional internal native object is needed, forwarding getters/events must avoid duplicate OPENED/progress/terminal sequences. This is a design hypothesis, not proven feasibility.

Test construction/instanceof, `open` validation, `setRequestHeader`, getters, send errors, synchronous send, async success, both listener styles, timeout, abort before/during send, responseURL, all responseTypes, upload events and reuse after a new open. Compare actual event/state traces with a native control request; do not invent one universal event trace for every native case.

Synthetic tests must separately cover UTF-8 text, parsed JSON, arraybuffer/blob conversion, missing/invalid JSON, headers/status, HEAD/204/205/304 body handling and reuse. Failure/abort/timeout emit exactly one appropriate terminal event and loadend, under the verified state transition contract. Event scheduling must remain asynchronous where native behavior requires it.

## Outcomes and timings

Every request record retains original/effective URL, source, transport, response origin (network/mock/synthetic-chaos), snapshot revision and per-module decision. Counters mean:

- Matched: matcher and conditions selected the winner.
- Applied: a specified operation actually changed, delayed, paused, rerouted or provided this request.
- Skipped: selected operation could not execute, with a stable reason code and readable explanation.
- Superseded: provider/composition made an operation irrelevant.

Do not attach a delayed body by searching for the newest equal URL; join on request ID. Display opaque network failure when script cannot distinguish CORS/DNS/TLS/connectivity; do not assert the server received nothing. Measure queue, pause, injected delay, dispatch-to-headers and available body-read timing separately with monotonic clocks. TESTER owns result aggregation.

## Lifetime transitions

| Action | Required behavior |
| --- | --- |
| Minimize | Keep active work; launcher names active modules and paused count |
| Module deactivate | Stop selecting its rules for new work; keep primary in-flight semantics; no new replay children |
| Profile switch | Dirty-draft decision; stop modules/recorder/tester; resolve old page pauses; install new inactive config |
| Run Stop | Abort tester-owned work, cancel pending jobs/delays, classify stopped work, dispatch nothing further |
| Close before page dispatch | Release pause and dispatch original request once unless caller aborted; never duplicate |
| Close after page dispatch | Return unedited native response where possible; do not cancel unrelated native page work |
| Close during synthetic delay | Settle already-selected synthetic reply/failure promptly; do not replace it with real traffic |
| Close during replay | Cancel unsent child jobs and owned replay-only work; primary not duplicated |
| Close with later third-party wrapper | Keep later wrapper installed, make delegated Workbench layer inert |
| Relaunch same version | Restore one instance and one interception layer |
| Relaunch newer/different version | Explain running version; require clean close/reload before replacement |

Default pause cap/deadline and body budgets are centralized in [DATA](DATA.md). Every asynchronous stage checks caller cancellation and lifetime state. Deadline expiry continues the original page request safely; it never leaves it waiting forever.
