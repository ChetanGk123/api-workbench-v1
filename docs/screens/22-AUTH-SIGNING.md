# Authentication and signing configuration workspace

Supporting workspace opened from endpoint/Once/plan/context/settings. Features P16/P21; gates G16/G23/G27; slices R2/R6. Read [COMPLEX_APPS](../COMPLEX_APPS.md), [DATA](../DATA.md), [TESTER](../TESTER.md).

## Required behavior

Configure definitions, not automatic page-client impersonation. Auth context has identity label/environment/audience, credentials intent, source bindings, expiry source and optional explicit refresh endpoint/output mappings/deadline/read-only retry policy. Show Available/Missing/Expired/Refreshing/Failed with masked source names. A separate signing region selects a finite supported recipe, canonical byte components/encoding, digest/timestamp/nonce, runtime key binding and destination output.

Request preview makes page-generated pass-through vs independently prepared send distinct. Resolve current values at dispatch; an import of headers does not configure future refresh/signing. Keys/current tokens/challenges remain transient. Test recipe uses controlled test vectors/context; no automatic request is sent on selecting a source. Audience mismatch, missing key, unsupported algorithm and expired reservation produce configure/blocked outcomes.

Must not bypass normal MFA/device/authenticator flow, extract keys from closures/workers, evaluate imported signing JS, persist actual keys/tokens, silently refresh page requests, share token across identities/audiences, re-sign edits without explicit recipe, or retry mutating endpoints automatically.

## Task S22.1 — Build auth-context definitions and masked availability

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** source/audience ownership and runtime/durable separation. **Status:** NOT STARTED. **Depends on:** S19 bindings, DATA schema, endpoint credentials controls.

1. Edit validated label/identity/audience/environment/source references and expiry interpretation; headers select context-owned bindings.
2. Show cookie-session scope vs distinct bearer contexts; profile/worker variables are not separate browser cookies/users.
3. Persist definition only; availability reads explicit source safely and masks values. Import/migration does not guess auth policy.
4. Provide configure/test-preview actions with no automatic sends; missing source names exact required field.
5. Profile switch/Close clears live context material and preserves safe definitions.

**Accept:** rotating CSRF read fresh; wrong audience blocked; origin/profile switch leaks no transient value; export contains references not tokens; unavailable page key doesn't break pass-through.

## Task S22.2 — Configure refresh and verify concurrency/cancellation

**Suggested model:** GPT-6 Astra. **Effort:** high. **Why:** refresh races and late admission can send wrong authenticated requests. **Status:** NOT STARTED. **Depends on:** S22.1, scheduler/context coordinator.

1. Select explicit refresh endpoint and validated token/expiry output mappings; specify finite deadline and optional one read-only post-401 retry.
2. Preview worst-case extra requests and failure policy; default no refresh/retry until configured.
3. Share one in-flight refresh per identity/audience context; install outputs atomically and re-resolve waiting jobs.
4. Release admission slots while awaiting prerequisites, then re-admit; failed refresh blocks waiters with cause.
5. Stop/Abort/Profile switch cancels owned waiters/work and prevents late retry; page-generated requests retain application auth strategy.

**Accept:** concurrent expiry yields one refresh per context; unrelated audience not overwritten; one bounded read retry maximum; writes aren't auto-retried; Stop schedules nothing after refresh resolves.

## Task S22.3 — Build finite signing recipe and integrity preview

**Suggested model:** GPT-6 Astra. **Effort:** high. **Why:** canonical bytes/freshness/key availability require exact reasoning. **Status:** NOT STARTED. **Depends on:** S22.1, native signing preparation and controlled verifier fixture.

1. Start with explicitly configured HMAC-SHA-256 recipe from COMPLEX_APPS; fixed supported algorithms/components, no arbitrary plugin/code hook.
2. Show canonical field order/encoding/body digest and redacted key reference; hold current key in runtime only.
3. Resolve/serialize/intentional edits/destination then reserve timestamp+nonce/sign; invalidate edits/expiry before dispatch.
4. Distinguish logical idempotency/payload stability from allowed per-attempt signing freshness; captured replay without recipe stays exact and warns of freshness rejection.
5. Compare server-known vectors and negative stale/changed/wrong-audience cases through UI; signature-invalidating faults remain explicit tests.

**Accept:** exact vectors pass; JSON whitespace/query ordering preserved as declared; missing/inaccessible key blocks direct send with reason; no raw key in logs/backup; ordinary signed page request remains byte-preserved.
