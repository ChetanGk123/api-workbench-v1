# Paused request and response workspace

Supporting workspace reached from Intercept/launcher/request details. Features P13/P19/P21; gates G03/G11/G22; slice R5. Read [NETWORK](../NETWORK.md), [COMPLEX_APPS](../COMPLEX_APPS.md).

## Required behavior

Show a queue with request ID, transport, method/original-effective URL, rule/config revision, stage, age/deadline and cap. Selected Request stage exposes only permitted URL/header/body edits before dispatch; Response stage exposes available status/header/body after upstream effects already occurred. Original and draft are separate. Continue commits validated edits, Continue original discards pause edits, Abort rejects/cancels as allowed. Continue all snapshots queued IDs.

The countdown continues independently of UI rendering and cannot be reset by opening/editing. Caller cancellation wins; expiry continues original safely. Stale config is visible without changing the held snapshot. Binary/streaming data may be unavailable for edits while metadata/continuation still work. Preserve draft during background queue updates.

Must not imply a response pause undoes a transfer, resend a dispatched request on Continue/Close, permit infinite waiting, show raw key/token values by default, pause synthetic replies as if a server call existed, or swallow abort/timeout events.

## Task S14.1 — Build queue selection and pause inspection

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** immutable pending snapshots and live countdown UI. **Status:** IMPLEMENTED; verification incomplete (Edge, zoom, screen reader NOT RUN) ([R5 evidence](../R5_REPORT.md)). **Depends on:** pause registry, S00/S21.

1. Subscribe to pause IDs/summaries, retain selected ID and its editable draft while queue changes.
2. Render stage/timer/cap/staleness/caller status and explicit original metadata.
3. Offer metadata-only views for unavailable bodies with supported edits labelled individually.
4. Preserve focus/scroll during ticks; expired/cancelled selected pause becomes an inspectable terminal record.

**Accept:** opening pause does not extend deadline; queue cap visible; many incoming pauses do not erase selected edits; closed/expired pause cannot still dispatch through stale control.

## Task S14.2 — Implement validated continuation and abort

**Suggested model:** GPT-6 Astra. **Effort:** high. **Why:** exactly-once completion and native event/cancel semantics. **Status:** IMPLEMENTED; method edits and re-signing are not offered (re-signing is R6) ([R5 evidence](../R5_REPORT.md)). **Depends on:** S14.1, NETWORK pause/delivery state machine.

1. Validate draft against stage/transport/method/body/signing capability; an invalid edit keeps pause editable without dispatch.
2. Atomically claim the pause before Continue/Original/Abort; duplicate clicks or concurrent expiry/caller abort cannot both win.
3. Request continuation dispatches once; response continuation returns held response once without new dispatch.
4. Intentionally invalidated signature remains explicitly labelled; unsupported direct re-sign has a named requirement.
5. Caller abort/deadline settles according to ownership; UI reflects the winning terminal state.

**Accept:** zero hits before request Continue then one; response Continue never adds a hit; XHR event order matches fixture; abort/expiry/click race settles once.

## Task S14.3 — Implement bulk actions, launcher and shutdown cases

**Suggested model:** GPT-6 Astra. **Effort:** high. **Why:** bulk/close races can duplicate real writes. **Status:** IMPLEMENTED; tester-owned pauses and profile-switch release not browser-tested ([R5 evidence](../R5_REPORT.md)). **Depends on:** S14.2/S20, lifecycle owner.

1. Continue all captures eligible queue IDs, applies each once and leaves later arrivals separate.
2. Launcher shows pause count/stage and Restore opens selected queue context.
3. Close/profile switch uses shared decision then releases original page work under NETWORK; tester work aborts.
4. Record stale rule changes without mutating pending decision; deactivation affects later intake, not held config silently.
5. Test cap/30s auto-continue, close at request/response stages and later-wrapper ownership.

**Accept:** no hanging calls, replay/replacement dispatch or duplicate transfer; Continue all independent from new pauses; minimized queue usable by keyboard; caller abort wins.
