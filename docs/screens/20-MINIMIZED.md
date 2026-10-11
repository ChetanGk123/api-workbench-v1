# Minimized launcher

Reference: [Minimized.html](../../../design/reference/screens/Minimized.html). Features P02/P03/P13/P19; gates G03/G11/G22; slices R1/R5. Read [NETWORK](../NETWORK.md), [UX](../UX.md).

## Required behavior

Launcher replaces visible panel without shutting down. Show AW identity, active profile, active module names, recorder/run progress and paused count/urgent status as space permits. Restore and Close stay keyboard-accessible with full labels. Drag/clamp geometry is separate from the full panel's stored size. Repeated saved-bookmark launch restores the same instance and prior screen/draft.

Paused indicator opens Intercept/selected pause deliberately; ordinary Restore returns to previous screen. Completion notifications can restore an appropriate run notice but must not overwrite a dirty editor. No active modules is explicit rather than a misleading green dot.

Must not hide active interception behind Close, stop work on Minimize, imply pause deadline frozen, lose draft/focus/filters, create another hook on restore, or let a narrow launcher spill offscreen.

## Task S20.1 — Build compact state and restore behavior

**Suggested model:** GPT-6.1 Sol. **Effort:** medium. **Why:** compact state-derived UI with focus restoration. **Status:** IMPLEMENTED for the R1 scope; verification incomplete ([R1 evidence](../R1_REPORT.md)). **Depends on:** S00.1/S00.3.

1. Derive active module/recording/run/pause summaries from runtime, no duplicated state machine.
2. Use readable labels and text+color; profile value remains full in accessible name.
3. Restore preserves previous screen/draft/scroll/focus or explicitly selected pause/run context.
4. Keep launcher and panel geometry finite/clamped; drag updates preferences without firing navigation.

**Accept:** minimization leaves matching rules active; restore shows same editor draft; long profile/status fits; keyboard finds Restore/Close.

## Task S20.2 — Integrate pauses and completion notices

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** urgent pending work and dirty-view context. **Status:** PARTIAL: paused count, keyboard-reachable pause action and draft-keeping restore built; run completion notices wait for R6 ([R5 evidence](../R5_REPORT.md)). **Depends on:** S14, run notifications.

1. Paused count updates by ID and deadline continues while hidden.
2. Pause action restores queue without discarding another draft; offer return context.
3. Notify-on-complete restores explicit notice/View run path; unchecked completion remains quiet.
4. Expired/caller-cancelled pauses remove active count and retain terminal diagnostics; no second timer owner.

**Accept:** held banking request reachable before deadline; minimized timeout settles correctly; completing run doesn't erase unsaved endpoint; count agrees with registry.

## Task S20.3 — Verify saved relaunch and true Close

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** singleton and lifetime fidelity. **Status:** NOT STARTED in the clean rebuild (earlier rebuild/v2 work: [history](../history/R1_REPORT.md)). **Depends on:** S20.1/S20.2, verified R0 lifecycle.

1. Same saved bookmark restores existing instance, retaining hooks and transient work; different version explains replacement steps.
2. Close delegates ownership-sensitive Stop all/disposal, including pause decision and child cancellations.
3. Reload resets active work and restores only safe preferences/config/draft recovery.
4. Test native page requests after close, later-wrapper retention and no hidden timers/readers.

**Accept:** one hook/panel after repeated launch; Close means shutdown; ordinary requests survive; real saved-bookmark evidence kept separate from injection.
