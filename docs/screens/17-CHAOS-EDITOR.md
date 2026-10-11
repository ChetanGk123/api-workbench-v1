# Chaos rule editor

Reference: [ChaosRule.html](../../../design/reference/screens/ChaosRule.html). Features P15/P19/P21; gates G08/G13/G22/G27; slice R4. Read [NETWORK](../NETWORK.md), [DATA](../DATA.md), [COMPLEX_APPS](../COMPLEX_APPS.md).

## Fields and behavior

Common label/link/matcher/conditions/priority/enablement plus Mode, Fault type and compatible parameters. Latency has fixed/min-max delivery delay and separate explicit pre-dispatch delay for real traffic. HTTP fault has legal status/body/headers or selected fixture; network failure and timeout are distinct. Corruption chooses malformed text or valid transactional field patch. Replay is real-only with bounded copies/gap and exact-vs-supported recipe freshness policy.

Sampling region has probability, seed, hit budget (0 explicitly no hit cap) and optional finite activation duration. Show projected dispatch impact, fallback/supersession and signature/idempotency requirements before save. A synthetic latency action needs a configured response fixture; never pretend a delayed guessed {} is a recorded server reply.

Must not combine incompatible mode/fault, allow infinite timers/copies, coerce malformed JSON into valid JSON, run replay children through rules recursively, automatically regenerate logical idempotency keys, execute custom fault scripts or discard draft on mode rebuild.

## Task S17.1 — Build validated action/mode draft

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** discriminated configuration and hidden-field preservation. **Status:** IMPLEMENTED; verification incomplete ([R4 evidence](../R4_REPORT.md)). **Depends on:** S00.2/shared matcher, chaos validators.

1. Bind common fields and endpoint matcher link with exact detached-edit semantics.
2. Mode/fault choice renders only compatible parameters; changing it previews discarded incompatible configuration and preserves useful draft values.
3. Validate status/body/delay/timeout ranges and condition availability; preview original traffic vs synthetic replacement.
4. Save warns about immediately effective enablement in active module; Delete/Cancel use shared guard.

**Accept:** invalid combinations blocked; mode switch doesn't silently lose unsaved content; synthetic timeout and HTTP503 semantics distinct; no broad matcher assumed.

## Task S17.2 — Implement sampling, duration and corruption controls

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** sampling/reservation and transactional body changes. **Status:** IMPLEMENTED; verification incomplete ([R4 evidence](../R4_REPORT.md)). **Depends on:** S17.1, random/cursor/patch services.

1. Build probability/seed/hit-budget/activation-duration with finite DATA limits and explicit 0 meanings.
2. Describe one sample per selected request and seeded ordering; meaningful action revision/activation resets documented state.
3. Offer fixed/random delays and pre-vs-delivery distinction, never a single ambiguous sleep control.
4. Valid-JSON corruption shares validated transactional patch builder; malformed JSON remains deliberate exact text.
5. Preview fixture/body eligibility and omission reason without fetching a response automatically.

**Accept:** probability0/100 and fixed-seed corpus behave; cosmetic label doesn't reset budget; min>max rejected; corrupt operation failure skips with original body preserved where eligible.

## Task S17.3 — Implement explicit bounded replay and native fault integration

**Suggested model:** GPT-6 Astra. **Effort:** high. **Why:** duplicates, signed freshness and resource ownership. **Status:** PARTIAL: exact-copy replay only; signing-recipe refresh of per-attempt fields waits for R6 ([R4 evidence](../R4_REPORT.md)). **Depends on:** S17.2, NETWORK replay/adapters.

1. Limit real replay to primary+at most2 copies under global child budget; show total primary/copy count and gap.
2. Preserve frozen logical body/idempotency; exact captured replay copies bytes; only declared supported signing recipe refreshes permitted per-attempt fields.
3. Children bypass rule selection and report parent IDs; page receives one primary completion.
4. Confirm synthetic provider supersedes replay; active deactivation/Stop cancels unsent children and owned child work.
5. Test native failure/timeout/status/latency/corruption/replay with responseType capability and cancellation races.

**Accept:** no recursive retries or automatic transfer resubmission; explicit idempotent duplicate yields one logical server operation; missing signing recipe explains replay rejection risk; no child after Stop.
