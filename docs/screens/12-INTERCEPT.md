# Intercept module list and traffic

Reference: [Intercept.html](../../../design/reference/screens/Intercept.html). Features P12/P13/P19; gates G08/G10/G11/G22; slices R4/R5. Read [NETWORK](../NETWORK.md) and [UX](../UX.md).

## Required behavior

Explain request/response editing and breakpoint behavior. Show module activation, linked/ad-hoc enabled rules, operation counts/request-response breakpoint flags, New rule/From endpoint, bounded traffic and a visible paused-request queue. Use matched/applied/skipped/superseded counts separately. Opening details identifies the exact original/effective request and operation reason.

Breakpoints link into the dedicated paused workspace with Continue/Abort/Continue all and cap/deadline. The list itself does not rewrite a request based on a latest editable config. Response body storage remains an explicit bounded setting; unavailable binary/stream/oversize transforms have visible reasons.

Do not label selection as modified response, hide skipped arraybuffer operations, capture every body just to populate a log, match again after routing, or let a list update overwrite a pause/editor draft.

## Task S12.1 — Implement rules and activation navigation

**Suggested model:** GPT-6.1 Sol. **Effort:** medium. **Why:** shared rule-list pattern. **Status:** IMPLEMENTED for R4 (no breakpoint flags until R5) ([R4 evidence](../R4_REPORT.md)). **Depends on:** S00, shared rule commands.

1. Render enabled/active state, linked/ad-hoc groups and concise operation/breakpoint summary.
2. New rule/From endpoint open detached drafts with matcher/link provenance; Delete previews active/link effects.
3. Keep main navigation and actual Back/list return state; repeated icon labels name the rule.
4. Disable activation with a meaningful no-rule/config-error explanation rather than inert tooltip only.

**Accept:** no hidden module activation; rules link by ID; active state text/color truthful; filters/focus survive editor save.

## Task S12.2 — Render operation diagnostics and bounded traffic

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** selected vs changed vs skipped accounting. **Status:** IMPLEMENTED; the optional stored response-body display setting is not built ([R4 evidence](../R4_REPORT.md)). **Depends on:** operation records, S21, DATA cache.

1. Derive per-operation status/reason and bounded summaries by request ID; include original/final URL and transport/body state.
2. Header-only edit can be applied while body transform skipped; render both rather than one misleading success/failure.
3. Enable body display only from allowed shared preview; setting off releases unsubscribed observation work.
4. Display patch transaction failures with path/reason and unchanged-response outcome.

**Accept:** unsupported binary edit says skipped while eligible routing remains applied; log cap respected; concurrent equal URLs attach correct body; no unconditional response read.

## Task S12.3 — Integrate pause queue and lifecycle

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** pending work must remain findable and settle safely. **Status:** NOT STARTED (R5). **Depends on:** S14 and NETWORK pause registry.

1. Render paused count/stage/deadline/caller status with stable request IDs; open exact pause workspace.
2. Continue all takes one queue snapshot and continues each eligible request once; arriving new pauses stay visible.
3. Show stale-rule/cancelled/expired outcomes and keep launcher activity current.
4. Module/profile/Close transitions use shared lifetime owner, not a UI loop creating new dispatches.

**Accept:** synthetic provider explains no-pause decision; queue cap/deadline visible; Continue all no duplicate hits; Close/abort leaves no hung page request.
