# Home screen

Reference: [home.html](../../../design/reference/screens/home.html). Features P02/P03/P08/P19; gates G03/G22/G26; slice R1 shell/status, R6 run integration. Read [UX](../UX.md) and [DATA](../DATA.md).

## Purpose and behavior

Home answers: which profile/frame is being tested, which modules can affect traffic, what happened recently, and what to do next. Show API Tester and four rule-module cards, quick actions to Endpoints/Record/Import/Settings, bounded run history and activity. Empty profiles show three useful start actions rather than empty counters alone.

Each rule card distinguishes visible module, active module, enabled rule count and actual applied request count. A module with rules but inactive says exactly that. Activate is offered only when it can perform meaningful work; otherwise New rule is primary. Tester card shows current plan and last run, not an activation chip implying interception.

Home must not start a mutating plan or activate every module just because it opened. Do not read raw secrets for its summary, rerender the entire app on each traffic event, use a latest-text line as the whole activity log, or label synthetic latency as server performance.

## Task S02.1 — Render first-use and module status cards

**Suggested model:** GPT-6.1 Sol. **Effort:** medium. **Why:** state-derived UI and clear empty states. **Status:** NOT STARTED in the clean rebuild (earlier rebuild/v2 work: [history](../history/R1_REPORT.md)). **Depends on:** S00.1 and module/runtime selectors.

1. Derive card summaries from config and runtime separately; render display labels, counts and text+color states.
2. Wire Open/New rule/Activate/Deactivate to shared navigation/domain commands; show impact before activating fault rules where the editor requires it.
3. Add Import/Record/Create endpoint onboarding and Endpoints count without hiding other destinations.
4. Keep cards compact; move long scope help to a disclosure while origin/activity remains identifiable.

**Accept:** zero-rule card leads to creation; enabled rule in inactive module is not shown as effective; activation changes module state but not unrelated modules; hidden modules respect Settings.

## Task S02.2 — Show useful activity and history

**Suggested model:** GPT-6.1 Sol. **Effort:** medium. **Why:** bounded summaries and navigation by stable IDs. **Status:** NOT STARTED in the clean rebuild (earlier rebuild/v2 work: [history](../history/R1_REPORT.md)). **Depends on:** request/run record selectors and S21.1.

1. Render newest bounded request summaries with method/name/service/outcome/source and openable request IDs.
2. Display selected/applied/skipped reasons as concise summaries; preserve body omission labels.
3. Render run history with logical state/outcome counts and plan name, opening the exact run in Results.
4. Separate live transient activity from stored run summary availability; show clear retention state after reload.

**Accept:** two identical URLs with different IDs open their own records; skipped binary operation is discoverable; history opens correct run; cap/eviction matches DATA.

## Task S02.3 — Make Run and Stop all truthful

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** shortcut actions can otherwise bypass plan preflight. **Status:** NOT STARTED. **Depends on:** S08.3, S00.3.

1. Home Run opens the current plan preflight or uses the same reviewed preflight command; never invent a separate scheduler.
2. Show Run unavailable with exact missing-endpoint/context reason; do not dispatch a partially configured plan.
3. Stop all reflects actual active work and invokes shared lifecycle semantics.
4. Preserve return-to-Home context after inspecting a run/request.

**Accept:** Run does not bypass mutating/signing/missing-binding preflight; Stop all stops future admission; closing details restores Home focus; no duplicate commands on repeated click.
