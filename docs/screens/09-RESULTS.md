# Results and run history

Reference: [Results.html](../../../design/reference/screens/Results.html). Features P08/P21; gates G17/G22/G27; slice R6. Read [TESTER](../TESTER.md), [DATA](../DATA.md).

## Required behavior

Open a specific run, with plan/config identity, start/end/state, strategy/mode and progress. Show passed/failed-check/network/timeout/aborted/skipped-dependency/skipped-condition/blocked breakdown. Per-endpoint rows use display name+alias and source-separated measured counts/timings. Open step/job/iteration and each attempt, including refresh/poll/replay, without flattening logical completion into HTTP counts.

Show mean/min/max/P95 with sample count/capping/timing definition. Response samples have body completeness/provenance and Save one/all. Run history identifies retained summaries vs available detail. JSON/CSV export and Run again explicitly name snapshot vs current config. Stop appears only while stoppable work remains.

Must not average endpoint averages, use zero for unavailable duration, mix mock delay into unlabeled server latency, claim distributed/server capacity, call uncertain/pending writes successful, expose sensitive values, or claim Download completed when only a Save sheet opened.

## Task S09.1 — Render accurate progress and aggregates

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** accounting/timing semantics create false results if wrong. **Status:** IMPLEMENTED; breakpoint/injected-delay timings are not separated ([R6 evidence](../R6_REPORT.md)). **Depends on:** S08.3, results aggregator.

1. Read exact run snapshot/ID and derive logical progress separately from attempts and checks.
2. Render outcome categories and per-endpoint display names with network/synthetic counts.
3. Compute/consume aggregate means from underlying totals and nearest-rank P95 from bounded labelled samples.
4. Show definitions for queue/pause/injected/network/body timing and unavailable/capped values.
5. Batch live updates preserving expanded row and scroll/focus state.

**Accept:** seeded fixture timings/counts agree; capped P95 labels retained set; 200/pending step not completed; user can type elsewhere while progress updates.

## Task S09.2 — Implement logical step details and sample saving

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** retries/polls/sample provenance need correct request identity. **Status:** IMPLEMENTED; Save sample/all has no browser case ([R6 evidence](../R6_REPORT.md)). **Depends on:** S09.1/S21 and sample commands.

1. Expand iteration/job/step records with attempt IDs, correlation IDs, producer context, branch/poll state and final assertions.
2. Keep failed refresh/uncertain write/body-unavailable reasons actionable, not buried in raw output.
3. Display last eligible response per endpoint with cap/redaction/provenance; Save one/all installs exactly identified samples.
4. A later concurrent response joins by request ID; old run samples never attach to a different live endpoint merely by URL.
5. Show stale/deleted endpoint save limitations and retain inspectable run snapshot.

**Accept:** banking pending polls grouped correctly; duplicate write attempts keep one logical idempotency context; sample save targets right endpoint; truncated data remains labelled.

## Task S09.3 — Implement export, history and rerun choices

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** snapshot/redaction and CSV correctness. **Status:** IMPLEMENTED; JSON/CSV and stored history verified in Chrome; Run again and retention have no browser case ([R6 evidence](../R6_REPORT.md)). **Depends on:** S09.1, bounded history/export commands.

1. JSON includes schema/config/run identities, categories/timing definitions, retained/capped detail and redaction.
2. CSV escapes quotes/newlines/delimiters and neutralizes user-controlled formula prefixes; preserve exact decimal/integer values.
3. Download feedback distinguishes requested/verified/failed; provide small-text copy fallback where useful.
4. History opens exact retained run; eviction clearly states missing details. Rerun offers retained snapshot vs current configuration after a change.
5. Route rerun through the same preflight; show mutating destinations and input/signing freshness again.

**Accept:** exports match UI aggregates; malicious alias is inert in CSV; changed plan does not silently rerun as old/new; Stop hidden after completion; real download path verified separately.
