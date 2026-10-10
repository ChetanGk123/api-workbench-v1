# Chaos module list and presets

Reference: [Chaos.html](../../../design/reference/screens/Chaos.html). Features P15/P19/P21; gates G08/G13/G22/G27; slice R4. Read [NETWORK](../NETWORK.md), [COMPLEX_APPS](../COMPLEX_APPS.md).

## Required behavior

Show active module vs enabled rules, presets, endpoint/ad-hoc creation, counters/budgets/deadlines and fault traffic. Presets include Slow/Very slow/Random latency, 500/502/503, and More: timeout/network failure/malformed JSON/valid JSON corruption/explicit replay. A preset opens a draft with action defaults then asks for endpoint/matcher; it never immediately faults every API.

Explain synthetic (no upstream) vs real (upstream effects can occur). Show probability/seed/hit budget/remaining activation time and source/outcome. Replay names primary plus copy count and idempotency/signing implications. Failure of probability sample means no chaos, not another lower-priority attempt.

Do not promise server rollback, secretly retry transfers, reset budget on render, make an exact /api/ default look like all endpoints, or classify selected/sampled-out/superseded actions as actual faults. Closing the panel truly stops new work.

## Task S16.1 — Implement preset selection and rule list

**Suggested model:** GPT-6.1 Sol. **Effort:** medium. **Why:** reuse of rule/preset UI with explicit scope. **Status:** NOT STARTED. **Depends on:** S00, CHAOS action definitions.

1. Render preset actions from finite registry shared with validators/help; More uses native disclosure.
2. Preset opens draft, selects endpoint or explicit matcher, and shows synthetic/real default before Save.
3. Render enabled/active states, display names and action/probability summary; New rule/From endpoint use stable links.
4. Enable/Delete/Activate goes through shared commands and future-request snapshot semantics.

**Accept:** every listed preset has implementation; click sends/faults nothing immediately; no misleading all-API matcher; inactive module clearly harmless until activated.

## Task S16.2 — Show sampling, budget and fault outcomes

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** runtime counters and probability explanations. **Status:** NOT STARTED. **Depends on:** S16.1, chaos engine, S21.

1. Display matched/sampled-out/applied/skipped/superseded counts distinctly and current hit budget/deadline.
2. Show seeded ordering guarantee without claiming arbitrary concurrent determinism.
3. Fault records identify synthetic/real source, actual dispatch/copy IDs and invalidated signature/body capability reasons.
4. Expired activation deactivates future selection; update status without creating a second timeout owner.

**Accept:** failed sample never tries lower rule; real fault count reflects applied action; budget/deadline ends work as configured; unsupported binary body edit remains visible.

## Task S16.3 — Verify complex failure journeys

**Suggested model:** GPT-6 Astra. **Effort:** high. **Why:** real effects, replay and cancellation can duplicate writes. **Status:** NOT STARTED. **Depends on:** S17, adapters/run cancellation.

1. Create explicit fault rule through UI and issue matching page/tester calls in stated mode.
2. Assert synthetic zero hits vs real primary hit and explicit bounded copies outside wrapped transports.
3. Exercise expired auth/429/503/pending timeout/lost response without automatically retrying mutating requests.
4. Stop/deactivate/Close during latency/replay and verify no new child dispatch; primary settled once.

**Accept:** fixture idempotency proves one logical transfer under deliberate duplicate; real response error never claims no server effect; UI/source counters match observed dispatch.
