# Complex applications and banking-style acceptance

Status: required rebuild target, clarified by the user on 10 October 2026. **Design and acceptance specification, not a claim of tested banking compatibility.**

API Workbench must be useful on complex applications, including banking applications being developed. A small echo fixture proves individual mechanics; it does not prove that the tool handles an authenticated, stateful application. This contract adds a representative complex-app release gate without changing the full-inline bookmarklet distribution.

The same requirements apply to enterprise portals, checkout, insurance, healthcare and multi-service dashboards: changing authentication/context, dependent workflows, concurrent calls, long-running operations, strict browser policies and useful failure diagnosis. Domain labels do not change the browser interception boundary.

## Two equally important testing paths

| Path | What the developer does | Workbench must do |
| --- | --- | --- |
| Test the running application | Sign in normally, perform app actions, observe or apply explicit rules to subsequent supported page Fetch/XHR | Preserve the app's prepared request, credentials, signing and native transport behavior; capture bounded permitted data, mock/route/fault/pause where the operation is supported |
| Test saved API workflows | Record/import/configure endpoints, bind dynamic values, run Once or a plan | Prepare fresh requests with declared authentication and required inputs, execute ordered/conditional bounded steps, assert outcomes and explain blocked preparation |

These are different capabilities. Recording an app's signed request does not provide its signing key or make a timestamp/nonce/OTP reusable. A direct tester request must not claim to reproduce application-client behavior that has not been configured.

## Required capabilities

| ID | Scenario | Required behavior |
| --- | --- | --- |
| C01 | Cookie-based authenticated session | Browser sends eligible cookies; HttpOnly values need not be read; default same-origin and explicit include/omit preserved |
| C02 | Bearer/CSRF rotation | Selected bindings resolve just before dispatch; new token values used; masks/redaction survive capture/history/export |
| C03 | Session expiry/refresh | Tester has explicit refresh endpoint/output mappings and bounded policy; simultaneous tester refresh demand shares one in-flight refresh per auth context; failed refresh blocks waiting work with reasons |
| C04 | Multi-service application | Distinct host/environment mappings, service names and correlation IDs; destination credentials and Authorization policy explicit; cross-origin failures honest |
| C05 | Dependent business flow | Carry account/beneficiary/quote/challenge/transaction IDs through own-property references; setup/iteration/job contexts isolated; missing producers cannot use an unrelated latest response |
| C06 | Conditional and pending results | Declarative step guards and bounded read-only status polling; terminal success/failure/timeout distinguished; max attempts/deadline/dispatch count known before run |
| C07 | Idempotency and uncertain writes | Configurable per-logical-operation key; deliberate duplicate uses the same prepared key/payload; normal new operation gets a new key; no automatic mutating retry or success assumption after a lost response |
| C08 | Signed requests | App-generated unchanged requests delegated intact. Independently prepared requests use only declared/tested native signing recipes and available runtime key binding; edits affecting signed content require re-preparation or a visible signature-invalidating decision |
| C09 | Large collections/concurrent traffic | Search/group by service/endpoint/run/request ID; typed binary responses usable; bounded bodies/logs; concurrent identical URLs never attach the wrong response/token |
| C10 | Meaningful assertions | Status/headers/body checks plus declarative cross-step comparisons, ordered business statuses and exact decimal/integer representations; HTTP 200 alone does not prove a successful workflow |
| C11 | Error and recovery testing | Auth errors, validation errors, conflicts, rate limit, delayed/pending response, server/network failure, malformed response, duplicate dispatch and failed refresh are visible and testable |
| C12 | Scope and policy diagnosis | Explain frame/worker/cached-reference/body/signature/browser-policy limits; an unavailable operation is not advertised as complete application coverage |

## Authentication context

A plan can bind an explicit runtime authentication context: origin/audience/environment, identity label, credential sources, expiry source and optional refresh endpoint/output mappings. Persist definitions and source references; keep current tokens/challenges/keys transient. Different audiences/identities must not share a token merely because header names match.

Cookie identity follows the browser session. Separate Flow variable contexts do not create separate cookie jars or users. Tests for separate cookie-authenticated customers need separate browser sessions/profiles. Explicit bearer-only contexts can be distinct within a run when configured; do not present that as cookie-session isolation.

Fresh bindings are resolved when each request is actually prepared for dispatch, not once at initial import. Refresh is an explicit tester configuration, never a background change to page-owned authentication. Share one pending refresh promise per context and serialize its output installation. On success waiting jobs resolve again; on failure report blocked/auth-expired, with no infinite loop. Abort/Stop releases waiters and schedules no late retry.

Expiry-before-dispatch can refresh and prepare the first send. A received 401 is recorded before any optional action. Post-response automatic retry is off by default; an explicitly enabled one-retry policy is limited to operations classified read-only. Writes require reconciliation or a deliberate new send even if the server uses idempotency keys. The application remains responsible for its own refresh strategy on page-generated traffic.

MFA, consent, CAPTCHA and device-bound authentication occur through the application's normal flow or explicitly supplied test endpoints. Workbench can test subsequent authenticated requests and failure states; it does not manufacture successful authentication or bypass a protected flow.

## Request signing and encrypted payloads

Signed page traffic passes through byte-for-byte where Workbench has no active modifying action. Do not normalize JSON/form/queries, replace credentials, invent timestamps or re-sign ordinary delegated requests. Request-body ownership and response type remain native.

For direct testing, define a finite signing recipe: message components and ordering/encoding, body digest, timestamp/nonce sources, algorithm, runtime key reference and destination header/field. The first proposed supported recipe is developer-configured HMAC-SHA-256 over an explicit byte template, implemented with native [Web Cryptography signing](https://www.w3.org/TR/2017/REC-WebCryptoAPI-20170126/#SubtleCrypto-method-sign) and checked against server-known test vectors. This is a target, not universal support for proprietary bank signing protocols. Additional recipes need individual contracts and gates; no arbitrary imported signing JavaScript.

Preparation order is resolve values → serialize exact bytes → apply intentional tester request edits → finalize destination → reserve fresh timestamp/nonce → sign → dispatch. A queued preview is not a promise that an expiring signature can be reused later. Changes after signing must invalidate preparation; explicit rule faults that corrupt signatures stay possible and are labelled intentional invalid-signature tests. Routing to another signing audience requires a configured new recipe/context or an explicit failure-test action.

Named signing recipes belong to the same preparation service, not an arbitrary runtime plugin loader. Current key material or live CryptoKey references stay session-only and are disposed on context/profile shutdown; do not export/persist a copied key as configuration. A non-extractable key is not automatically reachable from an application closure, worker or authenticator. Unsupported/missing key or algorithm blocks only the direct preparation that needs it; it does not break app-generated pass-through.

TLS is handled by the browser. Application-level encrypted payloads remain wire data unless an explicitly supported codec and accessible test context exist. Do not claim that recording ciphertext supplies plaintext assertions, valid replacement ciphertext, private keys or a decryption API. Such endpoints can still be tested for transport/status/header/fault behavior through supported app traffic; semantic checks require a declared representation. This pack adds no blanket encrypted-payload decoder.

## Stateful workflow primitives

Extend the existing endpoint plan with structured, bounded data fields rather than a general script engine:

- **Guard:** safe declarative predicate over completed same-context outputs; a false guard marks skipped-condition, an unavailable required value blocks/skips with cause. No control-flow cycle introduced.
- **Poll:** a developer-classified read-only endpoint, declared terminal/pending predicates, attempt cap, interval and deadline. Each attempt is a request record. Stop interrupts delay and no later poll is admitted. Errors/terminal failure are not success. Polling GET alone is not proof that the endpoint has no side effects; classification is explicit.
- **Cross-step assertion:** literal/own-path values from declared producers compared by equality, type, set membership or ordered numeric/decimal comparison. Preserve exact integer-minor-unit or fixed-scale decimal strings; do not compare monetary strings through floating-point rounding.
- **Idempotency binding:** per logical operation, stable for explicit duplicates; separate from a fresh timestamp/nonce/signature per transmitted attempt. An uncertain result prompts a read-only status lookup rather than replaying a write automatically.

The request-count preview includes worst-case poll/refresh/read-retry/replay attempts. All remain under DATA's global dispatch/deadline budgets. Flow concurrency continues to mean simultaneous iterations; refresh/poll requests consume network admission slots. Avoid deadlock by releasing a waiting job's admission slot before acquiring one for its prerequisite refresh/poll request; re-admit only after its context is ready.

Guarded dependencies are validated across their possible branches. Missing values from an unexecuted branch do not resolve from another iteration. Independent jobs keep their cross-load-reference restriction. Logical completion and individual HTTP/check outcomes are separate in Results.

## Simulated banking reference flow

Build a controlled local **banking-style test fixture** with synthetic identities/accounts/amounts. It is an acceptance application, not a product backend. Suggested flow:

1. Complete fixture sign-in and optional test challenge in the page; Workbench launches afterward.
2. Read eligible session and account list; select an account ID through a saved binding, not a hardcoded sample.
3. Fetch/create a test beneficiary and obtain a quote with an expiry, current CSRF value and correlation ID.
4. Prepare a transfer request with those IDs, exact amount/currency, logical idempotency key and a fresh configured test signature.
5. Submit once; handle a pending result by bounded status polling. A failure branch records the reason and stops dependent receipt checks.
6. Verify final transaction/status/account delta using the fixture's stated amount/fee rules and a receipt response, including binary download.
7. Explicitly replay the identical logical operation; verify one fixture-side transfer, distinct request-attempt records and correct idempotent response.
8. Inject expired auth/token rotation, quote expiry, rate limit, validation failure, lost response, 503 and malformed JSON; verify each outcome and recovery path.

This is the reference journey for the tool, not a prescribed architecture for every bank. Fixture test vectors define business expectations. Existing profile/session data and a real bank are not needed to prove these behaviors.

## G27 release scenario matrix

Every row requires Chrome and Edge evidence using the bundled tool UI and fixture server assertions. All start NOT RUN.

| Scenario | Assertions |
| --- | --- |
| Session and dynamic tokens | Eligible session works; CSRF rotates between calls; stale values fail distinctly; no secret leakage in saved artifacts |
| Expiry under concurrency | One refresh per context, current values in resumed calls, isolated audiences, no refresh loops or lost Stop cancellation |
| Transfer flow | Dynamic IDs/context, one write, bounded poll terminal result, exact cross-step amount/status checks; producer failure blocks receipt |
| Duplicate/uncertain response | Same logical idempotency key yields one fixture-side operation; a disconnect/timeout does not trigger automatic write retry or false success |
| Signing | Unchanged app traffic passes; test vectors/canonical byte order pass; expired signature/nonce and edits are diagnosed; missing key blocks independent send |
| Multi-service routing | Allowed/denied origins, exact credential audience, no silent Authorization forwarding or wrong-host signing |
| Binary and burst traffic | Routed binary XHR and receipt keep typed behavior; same-URL concurrency records join by request ID; UI editable at bounded limits |
| Authentication boundaries | Manual app challenge remains manual; frame/worker/closure-only credentials show scope limitations; unsupported semantic body operations skipped visibly |
| Failure matrix | 401/403/409/422/429/503, pending timeout, refresh rejection and corrupt response have distinct useful results and bounded dispatch |
| Export/relaunch | Definitions/reference bindings persist; no current token/key/challenge/active work resumes; saved import semantics intact |

Passing this representative fixture is a meaningful complex-application gate. It is not certification that every banking protocol, browser boundary, backend or business invariant is covered. A real project's required protocols map to this capability contract before claiming support.
