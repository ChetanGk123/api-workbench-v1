# Data, validation and persistence

Status: rebuild schema. The current public schema is version 1. The rebuild uses **portable schema 2** with explicit schema-1 migration; do not relabel incompatible JSON as schema 1. R2 implements schema 2 validators in `src/data/schema.ts`, migration in `src/data/migrate.ts` and the `api-workbench-v2` IndexedDB store (`profiles`, `metadata`) in `src/data/store.ts`; R3 adds the `recorderDrafts` store (database version 2) for the bounded recorder recovery copy; R4 adds `rules` to the profile aggregate and R5 adds Intercept `breakRequest`/`breakResponse` flags (absent = false) (activation, cursors, samples and budgets stay runtime-only); R6 adds named `bindings` (absent = none), `dom` sources with an explicit read mode, plan `rampStepMs` (absent = 1000) and `notify` (absent = panel), and the `runSummaries` store (database version 3; 20 summaries / 2 MiB, oldest removed first) ([R2 evidence](R2_REPORT.md), [R3 evidence](R3_REPORT.md), [R6 evidence](R6_REPORT.md)).

## Durable entities

| Entity | Required fields and invariants |
| --- | --- |
| Profile | ID, unique readable name, schema/revision/timestamps, environment maps, active environment, global headers/presets, profile settings |
| Endpoint | ID/profile ID, display name, unique alias, host key, request template, checks, optional sample, provenance, timestamps |
| Request template | Method, path/URL template, ordered query pairs, ordered headers with explicit removals, credentials, discriminated body, required inputs |
| Body | None, exact text, exact JSON text, ordered urlencoded pairs, or multipart descriptors; selected files are runtime values, never automatic imported filesystem paths |
| Rule | ID/profile ID/kind/label, endpoint link, enabled, priority/creation sequence/revision, matcher, discriminated action |
| Matcher | Method, explicit origin and exact/glob path, ordered query/header constraints, optional literal body constraint |
| Mock action | Static/sequence slots, legal status/header/body, delay/fault, explicit exhaustion |
| Intercept action | Ordered request/response operations, status override at response stage, request/response breakpoint flags |
| Route action | Match origin, destination origin, explicit path rewrite, credentials policy, destination-specific Authorization decision |
| Chaos action | Compatible fault + synthetic/real mode, sampling/seed/budget, pre/delivery delay, replay settings, activation duration definition |
| Plan | Stable ID/name/profile, explicit ordered setup/load step IDs, strategy/mode, schedule settings, failure policy, bindings, selected/skipped endpoints |
| Run summary | ID/plan/config revision, state/start/end, per-outcome/endpoint counts, timing definitions, bounded samples, byte size; no active controllers |
| Recorder recovery | Schema/session/origin/timestamp, redacted candidate records, selection, limits; restores inactive review draft only |
| Preferences | Origin-scoped geometry, selected profile and safe view preferences; no active modules or secrets |

For P21 add validated **auth context definitions** (audience/identity/source references/expiry and optional refresh mappings), **signing recipes** (supported algorithm/byte-template/components/runtime key binding), and structured **guard/poll/cross-step assertion/idempotency definitions** on plans/requests. Their exact behavior is owned by [COMPLEX_APPS](COMPLEX_APPS.md). Current tokens, challenge values, keys, refresh promises and poll controllers remain runtime-only. Schema2 validation/migration must not infer a signing/refresh policy from old captured headers.

A profile export includes its endpoints/rules/plans and settings, not all profiles implicitly. A whole-origin backup is a separate envelope with an explicit list of profiles and supported stored summaries/drafts. Show which artifacts each export includes.

## Reference and request semantics

- IDs survive display-name changes, reordering and replacement. Rules/plans/dependencies reference IDs internally; aliases are presentation/serialization syntax.
- Alias rename finds exact parsed references, previews the affected fields and updates them atomically. Do not text-replace matching substrings in unrelated raw bodies.
- Copy remaps every contained ID and every reference once, including linked rules, plan steps and parsed dependencies. Replace-in-place preserves the destination endpoint ID and updates dependent links under the reviewed policy.
- Header precedence: global defaults → endpoint overrides/removals → runtime binding resolution → explicit active intercept operations. Case-insensitive names; empty value is not removal.
- Host keys map to origins per environment. Absolute URLs retain their origin unless explicitly converted to a host mapping; environment selection never silently retargets an absolute request.
- Ordered query/form/header pairs preserve repeated names and ordering where represented. Preserve original raw text/bytes where normalization could change a signed request; explain when exact replay cannot be represented.
- Samples carry status, headers, bounded body, capture/redaction state and provenance. Missing sample remains absent; an edited sample is labelled user-authored rather than invented server evidence.

## Separate runtime types

Native Requests/Responses, XHR objects, DOM nodes, files, controllers, listeners, timers, live discovered values, secret values, sequence cursors, replay children and scheduling state never enter configuration JSON. Draft file descriptors can name required files, but launching/importing cannot read them; a run requires explicit file selection again.

A request record has a request ID and optional parent/run/iteration/job/step IDs, immutable original/effective metadata, selected/applied/skipped operations, reason codes, timings, outcome and preview references. Preview storage is a bounded shared cache keyed by request ID; module lists reference it rather than making unlimited copies.

Useful body states are: not-requested, complete, truncated, omitted-type, omitted-stream, over-limit, unreadable, redacted and not-evaluated. A truncated preview cannot satisfy an assertion that requires a complete body.

## Validation boundaries

Validate imported JSON, stored data, UI commands and compiled rule actions at runtime. TypeScript is not a JSON validator. Use small explicit validators with field-path diagnostics; reuse them across UI, import and storage.

Reject invalid origins/schemes, unsafe method/body combinations, impossible synthetic statuses, forbidden script-set request headers, illegal paths/prototype keys, incompatible chaos actions, out-of-bound numbers, stale/foreign references, duplicate IDs/aliases and future schemas. Preserve unsupported imported content as diagnostics, not executable values.

Synthetic HTTP replies accept statuses 200–599 with appropriate bodyless handling; HTTP 4xx/5xx remain responses, not transport failures. Preserve real browser responses outside that synthetic-constructor contract without inventing a replacement. Delay, timeout, probability and activation duration have finite validated bounds; never encode an unending request as a timeout preset.

Each validation result is valid, valid-with-unresolved-inputs, or invalid. Saved unresolved templates are permitted; dispatch is blocked with exact field/required-binding names. Every source diagnostic keeps adapter/item/location context. No success result merely for recognizing a format marker.

## Storage design and commit behavior

Begin with a namespaced IndexedDB database: `profiles` (one validated aggregate per profile), `metadata`, `runSummaries`, `recorderDrafts`. Separate stores only where their lifetime/byte budget differs; do not create a store per field. Version the database independently from the portable schema.

An aggregate holds profile+endpoints+rules+plans so one profile transaction cannot leave half-remapped relationships. Metadata points to the active profile. New-profile import or whole-origin restore updates relevant stores and active metadata in one transaction. Missing/failed reads leave the session usable and explain recovery choices.

Ordinary edits can be live but unsaved, with an origin-wide persistent banner. Imports/restore/profile replacement publish success only after durable commit. Serialized revision comparison prevents stale local writes and competing tabs from overwriting newer storage. Reads/writes have explicit disposal and retry; only the owning latest revision clears an Unsaved warning.

Migrations are pure version-to-version transformations followed by complete validation. Preserve an exportable original snapshot before replacement. Unsupported future schema leaves everything unchanged. Quota/permission/transaction errors retain usable session data, offer export/retry, and never report Saved.

Storage remains on the host origin and is readable by its page scripts; a bookmarklet is not a secret vault. Do not advertise browser quota estimates as Workbench's own available reservation.

## Initial resource budgets

These are proposed product limits inherited from the plan or made explicit here. Measure UTF-8 **bytes**, not JS string length. Apply budgets before allocating/reading, not after unlimited capture. R0/R2 tests validate and may tune them without dropping the bounded-storage requirement.

| Resource | Default / maximum / overflow behavior |
| --- | --- |
| Per-module traffic list | 50 / 500 records; oldest metadata dropped |
| Shared live metadata | 500 records; release unreferenced previews |
| Total live preview cache | 2 MiB; evict oldest eligible previews, retain omission reason |
| One stored body preview | 16 KiB; truncate at a valid UTF-8 boundary and label |
| Finite body matching/transform | 1 MiB / 1 MiB; skip with named reason when unavailable or over budget |
| Concurrent buffered body operations | 4; unavailable observation slots skip capture rather than delay page traffic |
| Finite page body operation deadline | Proposed 2 seconds; skip/fallback where safe, cancel only owned reader branch; prove no caller hang |
| Recorder captures | 100 / 1000, also bounded by recovery bytes; stop capture at the envelope cap and retain the draft |
| Recorder recovery envelope | 1 MiB including metadata/selection; never expand unbounded |
| Import input | 10 MiB UTF-8/file bytes; reject without dropping previous draft |
| Import item/depth/ref limits | Swagger/OpenAPI 500 operations; Postman 500 requests/depth 16; HAR 1000 entries; cURL/fetch 200 commands per paste; local ref chain depth 8; JSON nesting proposed 64; 10 body examples per operation (R7 implements these; JSON nesting is bounded only by the literal fetch grammar's depth 32) |
| Pauses | 20 concurrent; 30-second auto-continue deadline |
| Repeated runs | 1 default repetition / 1000 maximum; concurrency 1 / 20; explicit combined preflight request cap proposed 50,000 |
| Timing samples | Up to 1000 per endpoint; exact P95 only for the retained stated sample set, aggregate counts/means over all measured values |
| Stored run summaries | 20 / 2 MiB total; oldest summaries removed under explicit retention rules |
| Replay | Primary plus at most 2 copies; 20 child dispatches maximum in flight globally; unavailable child slot skips copy with trace |
| Expression/context bounds | See TESTER; count/depth/input limits prevent arbitrary page walking |
| Geometry | Clamp to viewport; no offscreen Close/Restore; safe values only |

Do not lower a capture limit by silently destroying a user's import/editor draft. Explain evictions and retention separately from configuration. File bytes remain transient and may consume a separate user-selected run budget; proposed initial total selected file size is 10 MiB per prepared request, pending fixture measurement.

Complex-flow proposed defaults: no refresh/retry/poll until configured; one shared refresh in flight per auth context, 5-second refresh deadline; at most one configured read-only auth retry; polling cap 10 attempts and 30 seconds with interval at least 250ms. Effective polling also observes its attempt cap/deadline and the normal run dispatch budget. Preflight includes worst-case refresh, retry and poll traffic. Stop aborts owned work and releases refresh waiters; these bounds are test targets, not measured compatibility claims.

## Redaction and export

Redact known credential headers/cookies, selected sensitive bindings and configured JSON/query keys before persistence or log rendering. Keep field names/source references so missing values can be configured. Runtime resolution does not turn a binding's current secret into a durable literal. Do not claim automatic redaction catches every application-specific secret; show a review of sensitive fields and configurable rules.

Default exports redact secrets in literal headers/bodies and explain which values need re-entry. A deliberate include-sensitive-fields choice previews the exact scope. Recovery logs do not become an accidental secret backup. Clear stored data and whole-origin restore show affected profiles/items and require an explicit product confirmation with export available first.
