# Shared shell, navigation and dialogs

Reference: shared chrome in every [reference screen](../../../design/reference/screens/index.html). Features P02/P03/P19; gates G03/G22; slice R1 after R0. Read [UX](../UX.md), [ARCHITECTURE](../ARCHITECTURE.md) and [NETWORK](../NETWORK.md).

## What this surface should do

Mount one non-modal Workbench panel in one shadow root. Its header shows identity/version, active profile and frame/origin context, Import, Settings, Minimize and Close. Keep the six module destinations reachable on every secondary screen. Add a breadcrumb/Back destination for editors rather than replacing the product navigation. A persistent activity control exposes Stop all when work is active.

Use fixed chrome and a scrolling content region. Validate/clamp stored geometry and allow resize/drag without moving host elements. Return focus to the initiating control or row when a workspace closes. Dialogs are modal only within their deliberate interaction and restore previous focus.

## What it should not do

- No page navigation/hash/history changes for screen changes; no global host stylesheet or keyboard trap.
- No DOM render that mutates saved config, executes a request or installs a second transport layer.
- No Back labelled Home when its handler goes to a list/Test; no Escape silently dropping dirty drafts.
- No Close that merely hides active hooks; no Minimize that stops an active run.
- No unvalidated persisted x/y/size or unreachable Close at 200% zoom.

## State and implementation seam

View owns screen/return route, selected entity, filters/scroll/disclosure/focus and draft sessions. Lifecycle owns singleton/hooks/resources. Durable profile switch is a domain command; screen routing only requests it. Existing seam: `src/ui/shell.ts`, `src/ui/dom.ts`, `src/core/store.ts`; extract responsibilities when the slice needs them, not prebuilt empty files.

## Task S00.1 — Build persistent navigation and focus routing

**Suggested model:** GPT-6.1 Sol. **Effort:** medium. **Why:** connected UI state with a clear contract. **Status:** NOT STARTED in the clean rebuild (earlier rebuild/v2 work: [history](../history/R1_REPORT.md)). **Depends on:** R0 lifecycle; shared model/view contract.

1. Create native shell regions and internal screen identifiers. Keep primary navigation mounted; allow a compact Modules selector for narrow panels.
2. Store an explicit return context when opening editor/detail/run views. Carry list filter, scroll and selected row ID.
3. Pass Back label and handler together; give repeated icon actions full accessible entity names.
4. Render selected destinations and move focus on deliberate navigation; preserve focus during data-only updates.
5. Restore origin-scoped geometry with finite-value validation and viewport clamps.

**Accept:** Import→Endpoints→Mock needs no Home detour; editor from Record returns to Record; Back announces the true destination; host URL/history unchanged; long profile/origin names do not hide Close.

## Task S00.2 — Implement draft-safe dialogs and screen transitions

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** shared dirty-state and async-save races affect many screens. **Status:** NOT STARTED in the clean rebuild (earlier rebuild/v2 work: [history](../history/R1_REPORT.md)). **Depends on:** S00.1, DATA command/persistence behavior.

1. Give each editor an immutable base revision and separate mutable draft; compute dirty against meaningful saved fields.
2. Route Back/Escape/profile switch/Close through one decision interface with Save, Discard and Keep editing where appropriate.
3. Use native dialog, focus initialization/restoration, explicit destructive action labels and busy prevention. Escape cancels the dialog before touching the editor.
4. Successful Save awaits the appropriate command result; failed validation/write keeps the draft and dialog/edit surface usable.
5. Keep import draft and review lifetimes distinct from ordinary endpoint drafts; invalidating a review does not erase source text.

**Accept:** a changed body survives Escape/Keep editing; clean editor exits directly; refused save never navigates as if Saved; switching profile cannot silently commit the old draft into the new one.

## Task S00.3 — Wire activity, minimize and true shutdown

**Suggested model:** GPT-6 Astra. **Effort:** high. **Why:** UI controls must honor page/tester ownership and async cleanup. **Status:** NOT STARTED in the clean rebuild (earlier rebuild/v2 work: [history](../history/R1_REPORT.md)). **Depends on:** S00.1, verified R0 stop/close service.

1. Subscribe to bounded activity summaries, not full native request objects; batch updates without replacing an active editor.
2. Show Stop all only when relevant and bind it to the lifecycle command that keeps UI open.
3. Delegate Minimize/Restore and Close to one instance owner; dispose UI listeners/object URLs/subscriptions under the shared lifetime.
4. Explain queued pauses/runs when Close needs a deliberate decision; follow native page continuation rules after that decision.
5. Inspect ordinary/minimum/zoom layouts and keyboard navigation while traffic updates continue.

**Accept:** Stop all admits no new tester/replay work; Minimize retains active modules; Close settles pauses once and removes panel; later third-party wrapper survives; input caret stays stable during a fixture burst.
