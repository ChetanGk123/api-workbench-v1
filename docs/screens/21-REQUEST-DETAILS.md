# Shared request detail and diagnostics

Supporting workspace entered from Home/module logs/Once/Results/Recorder. Features P08/P09/P12/P14/P15/P19/P21; gates G06/G08/G17/G18/G22/G27; slices R1/R4/R6. Read [NETWORK](../NETWORK.md), [DATA](../DATA.md), [COMPLEX_APPS](../COMPLEX_APPS.md).

## Required behavior

Open one request ID with source page/tester, transport/responseType, service/audience, original/effective URL/method, profile/config revision and parent/run/step/job IDs. Show headers/body previews/capture state, response source/status/headers/body, checks and precise timing lanes. Operation trace explains selected/applied/skipped/superseded/failed reasons and final caller outcome. Display logical transfer/poll/replay grouping without merging request attempts.

Use Overview, Request, Response and Why/Timing sections or native disclosures; preserve selected tab/scroll. Missing evicted body says why. Copy/export uses redacted preview; Promote/Open endpoint/Create rule/Replay lead to reviewed workflows when data supports them. Preview inspection itself sends nothing.

Must not infer CORS vs TLS/DNS from one opaque error, claim server rollback, attach body by newest equal URL, show signing material by default, treat missing body as empty, or replay a write merely because the user opened details.

## Task S21.1 — Implement stable record inspection

**Suggested model:** GPT-6.1 Sol. **Effort:** medium. **Why:** shared read-only presentation by stable ID. **Status:** NOT STARTED in the clean rebuild (earlier rebuild/v2 work: [history](../history/R1_REPORT.md)). **Depends on:** DATA record/cache model, S00 navigation.

1. Resolve record by ID and display immutable request/result identity; join available preview references by ID only.
2. Label original vs effective values, source/transport/body state and redaction.
3. Keep tabs/disclosures/focus independent from body arrival/update; expired record shows retained summary/retention explanation.
4. Copy/select text offers honest outcome, no hidden network call on open.

**Accept:** concurrent equal URLs inspect correctly; truncated/evicted body distinct from empty; byte/status timing describes same request; source secrets masked.

## Task S21.2 — Implement operation reasons and timing lanes

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** final native behavior must match explainability. **Status:** NOT STARTED in the clean rebuild (earlier rebuild/v2 work: [history](../history/R1_REPORT.md)). **Depends on:** normalized operation outcomes, NETWORK capability.

1. Show selected rule/snapshot, winner priority/conditions, capability decision and actual effect per operation.
2. Render mixed applied header/route plus skipped body case without flattening to a whole-request fail.
3. Separate provider supersession, sampling miss, opaque network error, caller cancel and skipped checks.
4. Timeline names queue/pause/injected/dispatch-to-headers/owned body-read, without inventing unavailable native timings.
5. Add signing/audience/freshness and logical-idempotency reasons without exposing keys.

**Accept:** arraybuffer route/body case fully explained; mock supersedes route/no upstream stated accurately; pending transfer not called complete; display counts align with module aggregates.

## Task S21.3 — Implement reviewed follow-up actions

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** capture fidelity, unsafe replay and reference context. **Status:** NOT STARTED. **Depends on:** S05/S06/S07 and rule draft commands.

1. Promote enters shared candidate review with source/required credentials/files/signing and selected sample.
2. Create mock/intercept/route/chaos uses a draft matched to original endpoint/request; nothing activates automatically.
3. Explicit Replay previews destination/method/body/idempotency/attempt count and signing freshness; missing reproducible input blocks with reason.
4. Export detail reflects retained redacted data and omitted fields; never claims full request export when bounded preview lost bytes.
5. Return preserves original module/run/list selection.

**Accept:** click inspection sends nothing; replay requires deliberate reviewed send; incomplete signed capture isn't silently replayable; derived mock isn't an invented complete sample.
