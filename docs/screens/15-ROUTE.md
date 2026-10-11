# Route list and rule editor

Reference: [Route.html](../../../design/reference/screens/Route.html). Features P14/P19/P21; gates G06/G08/G12/G22/G27; slice R4. Read [NETWORK](../NETWORK.md), [COMPLEX_APPS](../COMPLEX_APPS.md).

## Required behavior

List enabled rules, module state, applied/skipped traffic and original→final destinations. New/edit rule has Label, method, exact/glob URL, match origin, destination origin, path rewrite/preserve original, AND conditions, destination credentials, explicit destination Authorization choice, priority and enablement. Save/Cancel is separate from Activate.

Show an example full request including query before/after. Blank match origin means launch frame origin. Exact or supported trailing /** rewrite semantics are explicit. Original query remains unless a declared operation changes it. Cross-origin account/auth audiences are named. Binary XHR routing is an independent required request operation.

Must not claim a proxy/security bypass, rematch routed URL recursively, route when synthetic provider wins, forward Authorization silently, rewrite absolute tester URLs via environment secretly, or disable request routing because response cannot be decoded as text. Unsupported signing audience must be visible.

## Task S15.1 — Build list and validated route draft

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** URL/origin/path semantics and credentials. **Status:** IMPLEMENTED; verification incomplete ([R4 evidence](../R4_REPORT.md)). **Depends on:** S00, matcher/route validators.

1. Reuse list/matcher draft components with stable rule IDs and future-request revision behavior.
2. Validate HTTP(S) origins, supported exact/trailing-capture rewrites and conditions; preserve invalid input until corrected.
3. Build live pure URL preview with repeated queries, path capture and destination audience.
4. Display effective enablement/module impact; Save/Cancel/Back uses shared guard; Delete preview includes active context.

**Accept:** preview matches engine URL; invalid arbitrary glob rewrite rejected; rule save does not activate module; origin labels remain readable for long bank service URLs.

## Task S15.2 — Wire credential and signing policies to native routing

**Suggested model:** GPT-6 Astra. **Effort:** high. **Why:** request integrity and transport-native binary behavior. **Status:** PARTIAL: credentials, explicit Authorization and native binary routing built; signing audience/freshness display waits for R6 ([R4 evidence](../R4_REPORT.md)). **Depends on:** S15.1, verified R0 binary route and signing preparation.

1. Apply one route to selected real primary request with snapshot credentials; strip cross-origin Authorization unless explicitly permitted for that destination.
2. Preserve path/query/body/headers not explicitly modified; no request reconstruction that consumes a caller stream unnecessarily.
3. Preserve XHR typed native output/upload/state for request-only route.
4. Show selected signing recipe audience/freshness conflict; require declared preparation or explicit invalid-signature test.
5. Synthetic provider marks route superseded rather than pretending upstream dispatch occurred.

**Accept:** Fetch/text/arraybuffer/blob XHR hit destination once; cookie/audience policy correct; no hidden Authorization forwarding; signed byte changes diagnosed; mock creates zero destination hits.

## Task S15.3 — Render route trace and browser-policy failures

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** honest applied/skipped/error evidence. **Status:** PARTIAL: traces built; allowed/denied CORS routing cases not re-run for R4 ([R4 evidence](../R4_REPORT.md)). **Depends on:** S15.2/S21.

1. Show original/final URLs, transport, rule, revision and applied/skipped/superseded counts.
2. Explain unsupported operation with reason and original behavior; keep actual network failures opaque when cause not knowable.
3. Open exact request details; shared bounded previews/counters do not grow per destination indefinitely.
4. Verify allowed/denied CORS, deactivate, query preservation and body-signature cases in both browsers.

**Accept:** no false CORS-solved/no-server-hit claim; failed destination remains inspectable; routed count reflects actual applied operation; arraybuffer regression is explicitly covered.
