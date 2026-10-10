# Mock module list and traffic

Reference: [Mock.html](../../../design/reference/screens/Mock.html). Features P11/P19; gates G08/G09/G22; slice R4. Read [NETWORK](../NETWORK.md).

## Required behavior

Explain that selected mock replies replace supported upstream requests with no server dispatch. Separate linked endpoint rules and ad-hoc rules, enablement from module activation, and matcher hits from actual replies/skips/superseded actions. Show New rule/From endpoint, activation controls, sequence cursor/exhaustion and matched traffic links.

Rules open the editor with full return context. Enable toggle changes only future requests and records a revision. Delete previews link/impact and follows active-work snapshots. Traffic opens identified request detail. Empty state leads to a valid matcher/sample setup.

Do not imply active module means every request is mocked, silently fall back to server on exhausted sequence, call selected unsupported body conditions a match, reset cursors for a cosmetic label edit, or install a separate fetch wrapper.

## Task S10.1 — Build rule list and activation states

**Suggested model:** GPT-6.1 Sol. **Effort:** medium. **Why:** common list/control presentation. **Status:** NOT STARTED. **Depends on:** S00 and mock selectors/commands.

1. Derive linked/ad-hoc groups, enabled counts and module state; label no-rule/inactive/active cases separately.
2. Wire New rule/From endpoint to drafts; choose by endpoint ID/display name and show missing sample explicitly.
3. Toggle activation/enablement through shared commands; make effective-immediately impact visible.
4. Preserve list focus/filter when returning from editor; Delete uses shared confirmation/snapshot rules.

**Accept:** inactive module with enabled rules is clearly inactive; enable toggle affects new requests only; creation doesn't activate module; linked endpoint rename keeps identity.

## Task S10.2 — Expose sequence and operation outcomes

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** counters must reflect reservations and actual delivery. **Status:** NOT STARTED. **Depends on:** S10.1, sequence engine, S21.

1. Render cursor/next slot/exhaustion policy from runtime reservations, not saved fields.
2. Show matched/applied/skipped/superseded counters and bounded request rows with source/status/transport.
3. Explain synthetic chaos superseding mock, unevaluated body conditions and rule revisions.
4. Keep same-URL concurrent rows keyed by request ID; body previews reference shared cache.

**Accept:** simultaneous matches reserve slots in arrival order; exhausted rule never reaches server; superseded mock not counted as a delivered reply; binary response capability failures have reasons.

## Task S10.3 — Verify list-to-editor-to-page journey

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** UI success must equal native behavior and zero server hits. **Status:** NOT STARTED. **Depends on:** S11 and native mock adapters.

1. Create from endpoint/sample, inspect response, save/enable/activate and issue native page Fetch/XHR.
2. Assert returned fields/body/events and upstream deltas outside hooks; unmatched request remains native.
3. Exercise sequence exhaustion, abort during delay, deactivation and close.
4. Confirm synthetic Set-Cookie is not described as changing native cookies; expected error sample remains testable.

**Accept:** both target browsers show configured reply and zero new upstream hits; no old-body/sample confusion; lifecycle settles once.
