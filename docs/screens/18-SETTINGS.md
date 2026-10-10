# Settings, profiles, backup and updates

Reference: [Settings.html](../../../design/reference/screens/Settings.html). Features P01/P17/P18/P21; gates G21/G23/G24/G22; slices R2/R8. Read [DATA](../DATA.md), [MIGRATION](../MIGRATION.md), [NETWORK](../NETWORK.md).

## Required behavior

Profiles: active selector, explicit Load/switch, Name/Rename/Save, Save copy, Delete and Export active profile. Origin backup: Export all/Restore preview with affected profiles and explicit replacement. Module visibility, log/capture limits/resets, body-check limit, response body capture, tester inclusion, recorder recovery/reset and context roots all perform real settings commands. About shows bundled version, origin-scoped storage, last known version and Check/Copy update.

State saved/live/unsaved is explicit. Visibility off stops future module selection/capture, not merely hides a tab. Limits are bounded and belong to profile as stated; resets restore documented defaults. Recorder reset scope stays separate from Clear local data. Replace misleading Clear cache with Clear local data and affected-scope preview.

Must not duplicate confusing Save meanings, silently stop work/drop drafts on switch, claim quota estimate is reserved space, put current tokens/keys in backup, restore active controllers, clear every origin by accident, automatically execute update text or say copied bookmark is installed.

## Task S18.1 — Implement profile and whole-origin backup workflows

**Suggested model:** GPT-6 Astra. **Effort:** high. **Why:** migration, coherent references and durable replacement. **Status:** NOT STARTED. **Depends on:** DATA schema/transactions, S00.2, S05.3.

1. Use clear Save/Rename/Save copy scope and stable profile identity; explicit switch preserves outgoing profile and stops old work safely.
2. Delete previews affected endpoints/rules/plans; last-profile case creates explicit safe empty config rather than dangling pointer.
3. Export active vs all envelopes separately, redacted by default with deliberate sensitive inclusion preview.
4. Restore validates schema/references, shows removal/addition summary and commits atomically; future/corrupt schema changes nothing.
5. Migration reads old namespace for reviewed conversion, leaves it intact until separate removal request.

**Accept:** refused write/restore never reports success; all saved plans/profile links survive round-trip; profile switch guards draft; no token/key/active work resurrected on reload.

## Task S18.2 — Wire module/resource/context settings and failure state

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** settings must change resources, not just UI. **Status:** NOT STARTED. **Depends on:** S18.1, lifecycle/body/recorder policy.

1. Bind module visibility to navigation/card and engine selection; switching Recorder off ends capture and retains draft.
2. Build numeric bounded limits/reset defaults with effective readback and overflow explanation.
3. Response-body store setting controls observer subscription; release no-longer-owned body work when disabled.
4. Edit configured context roots via safe descriptors; link to detailed scan/binding workspace, no implicit scanning.
5. Surface persistent Unsaved/Retry/Export and distinguish storage estimate from product budgets.

**Accept:** hidden module cannot affect future requests; capture/log cap changes actually apply; off disables body reads; blocked storage leaves session usable; numeric reset scope clear.

## Task S18.3 — Implement About, data clearing and data-only update

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** user data loss and stale update artifacts. **Status:** NOT STARTED. **Depends on:** S18.1, deployed manifest/bookmark validation.

1. About reports bundled version/origin/storage/last-known published comparison; Check only starts on explicit click using captured transport.
2. Bound manifest/bookmark reads, validate version/hash/text consistency, never execute downloaded text.
3. Copy action reports clipboard outcome and exact edit/reload steps; refusal offers installer/manual path.
4. Clear local data previews exact active/saved profiles/recovery/geometry scope and export choice; commit then install safe empty config.
5. Verify no idle polling/assets, blocked policy fallback, mismatch/newer/equal versions, clipboard refusal and real saved update separately.

**Accept:** copy isn't reported installed; delayed stale read cannot clear a newer version state; Clear Cancel preserves storage; deletion only this origin namespace; About buttons wrap within panel.
