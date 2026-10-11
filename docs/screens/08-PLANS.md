# Test screen: plans and Load

Reference: Load region of [Test.html](../../../design/reference/screens/Test.html). Features P07/P16/P21; gates G16/G22/G27; slice R6. Read [TESTER](../TESTER.md), [COMPLEX_APPS](../COMPLEX_APPS.md), [DATA](../DATA.md).

## Required behavior

Offer a stable saved-plan picker with Rename/Save copy/Delete, Once endpoint and Load navigation, and explicit Run plan once/Run Load/Stop. Configure setup/load/skip/order, Flow/Independent, iterations/concurrency/delay/ramp-up, direct/rules and failure/notification policy. Show display name and secondary alias in every step. Filters retain selection/order and state exactly what Include/Exclude all affects.

Complex Flow includes declared auth context, guard, bounded read-only poll, cross-step checks and idempotency bindings. Preflight shows missing inputs, graph errors, destinations, mutating steps and worst-case refresh/poll/retry/replay counts. Independent cannot read another load endpoint's response. Numeric edits visibly update effective configuration; no hidden committed value differs from shown input.

Must not imply shared-session workers are separate bank customers, treat setup output as a permanent global cache, auto-retry writes, run a stale changed preflight, over-admit auth/poll requests, create a new plan ID on every render, or call an HTTP-success step a completed transaction.

## Task S08.1 — Implement saved plans and phase editing

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** stable identities/order and reference updates. **Status:** IMPLEMENTED; rename/copy/delete/filter/reorder have no browser case ([R6 evidence](../R6_REPORT.md)). **Depends on:** DATA plan commands, S00/S03.

1. Maintain one live plan ID before edits; saved copies keep profile ownership and explicit ordered steps.
2. Build rename/copy/delete with dirty decision and reference-aware persistence; deleting live plan installs an explicit available plan.
3. Edit setup/load/skip, selected steps/order and phase filters; bulk include/exclude names visible/all scope.
4. Keep graph diagnostics beside affected fields and offer reviewed producer-to-setup/Flow changes.
5. Retain step display names/aliases and return context for opening endpoint editor.

**Accept:** switching plans restores each plan's settings; rename/reload preserves ID; filter bulk action affects stated rows; deleted producer identified; setup cannot depend on load.

## Task S08.2 — Implement bounded configuration and complex step controls

**Suggested model:** GPT-6 Astra. **Effort:** high. **Why:** guards/polls/auth and dependency semantics intersect. **Status:** IMPLEMENTED; verification incomplete ([R6 evidence](../R6_REPORT.md)); plans cannot attach files. **Depends on:** S08.1, S22/S19 and validated graph.

1. Build explicit strategy/mode/numeric/failure/notify fields with DATA bounds and updated readback.
2. Explain Flow concurrency as iterations and Independent as global request concurrency; label delay/ramp units and worker admission.
3. Edit structured guard/poll/check/idempotency/context fields using safe expression pickers; require read-only poll classification and finite bounds.
4. Preflight validates all branches, producer references, missing files/context/signing recipes and worst-case attempt totals.
5. Show isolated variables vs shared cookies explicitly; a profile is not a separate authenticated cookie jar.

**Accept:** visible value equals run config; Independent cross-load reference refused; poll max/deadline counts shown; transfer preflight names write/audience/idempotency requirements without exposing secrets.

## Task S08.3 — Integrate run admission, Stop and notification

**Suggested model:** GPT-6 Astra. **Effort:** high. **Why:** scheduler correctness and cancellation under concurrency. **Status:** IMPLEMENTED; browser notification with permission and profile switch during a run NOT RUN; the notice does not restore a minimized panel ([R6 evidence](../R6_REPORT.md)). **Depends on:** S08.2 and TESTER scheduler/auth coordinator.

1. Run plan once uses one repetition without changing saved Load settings; both run actions validate current preflight revision.
2. Setup executes once; contexts/jobs follow declared Flow/Independent semantics; prerequisites refresh/poll consume admission slots without deadlock.
3. Stop aborts owned work, cancels queue/delays and prevents late refresh/retry/replay admission.
4. Open Results for exact run ID while allowing internal navigation; completion notice offers View run and restores minimized panel when specified.
5. Preserve a per-run snapshot for inspection; do not reread changing endpoint config inside an admitted step.

**Accept:** fixture counts match predicted bounded behavior; concurrent contexts never share producer outputs; one refresh per auth context; Stop schedules no later request; notification off remains quiet.
