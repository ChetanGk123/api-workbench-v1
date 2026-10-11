# Reuse, migration and replacement

Status: proposed cutover strategy. Existing product/data remain in place during this documentation task.

## Rebuild the seams, retain useful assets

| Existing asset | Recommendation | Required care |
| --- | --- | --- |
| Reference theme/screens | Keep as visual/feature source | Inline CSS/system fonts; improve workflow flaws without changing zinc direction |
| `tests/fixtures/` playground/two origins/API | Keep and extend | Retain binary XHR and exact policy pages; isolate test data/counters; fixture is not shipped runtime |
| `scripts/build.mjs` encoding/bundle checks | Reuse proven intent and encoding assertions | Allow only explicit update data URL; check emitted assets/metafile, hashes, bookmark completion and measured payload |
| `scripts/showcase.mjs` installer/public guide | Retain useful content/illustrations | Rewrite claims around exact rebuilt capabilities and installation evidence |
| `src/import/` parsers/candidate logic | Candidate for reuse after contract tests | Add multipart fidelity, stricter validation/conflict identity, no code execution; do not rebuild a correct parser merely for a new directory |
| Expressions/patch/matcher/plan/results pure logic | Reuse when representative tests pass | Explicit injected environment, bounded AST/own paths, internal stable references and transactional edits |
| Fetch/XHR adapters | Treat as evidence and starting hypotheses | Preserve native assertions; remove broad binary-response exclusion through measured operation capability, not a cosmetic refactor |
| Recorder | Reuse redaction/promotion ideas | Remove implicit unsafe browser-global reads; byte bounds, user-selected sources, request-ID joins and clear overflow |
| UI components/icons | Keep small native components | Draft/focus/nav state outside rendering; avoid generic component framework or giant shared editor |
| Entry/storage modules | Replace broad ownership and weak boundary validation | Composition-only entry, strong schema, revision queue, atomic transactions and error visibility |
| Existing tests | Keep behavioral oracles, adapt selectors/model where required | Count node:test cases properly; do not delete a failing behavior assertion merely because code moved |
| Existing reports/work log | Preserve historical evidence | Do not turn previous injected launch into current saved-install evidence |

This is a selective rebuild, not mandatory deletion of everything that works. Each slice inspects connected code and retains the smallest verified implementation that meets the new contract.

## Development isolation

Use a separate checkout/worktree for implementation if current work must remain usable; document its path and branch. Build/distribution files retain their roles. Do not overwrite the main product, production bookmark or user storage during early experiments. Creating this documentation pack does not create a checkout or authorize publishing.

Recommended restart for this repository: keep the same Git repository, first commit the reviewed documentation/evidence needed by the rebuild, then create branch **rebuild/v2** in a sibling worktree at **/Users/chetangk/Developer/tools/api-workbench-rebuild**. Start R0 in that worktree. This keeps existing source/deployment/history intact while the replacement is developed. A new repository would add migration/history/remote setup work without improving the agreed product scope. The documentation task originally proposed this folder/branch. The subsequent user-authorized R0 task created them from `740782d`; see [that R0 evidence](history/R0_REPORT.md). On 11 October 2026 the user chose a from-scratch rebuild in the separate repository `api-workbench-v1` instead; see [R0_REPORT](R0_REPORT.md). Never lose or broadly commit unrelated current changes while preparing the snapshot.

The current instance registry key is `__api_workbench_7f49a1_v1__` in `src/entry.ts`. A rebuild must detect a running old instance before installing hooks. Use a shared version-aware bootstrap or explicitly check that old registry: show close/reload instructions rather than stacking two independent interception layers.

## Current storage to migrate

Current IndexedDB database: **api-workbench**, version **1**, store **configs** (`src/core/storage.ts`). The origin key holds live profile/endpoints/rules/plan/saved profiles/saved plans; separate `version:<origin>` and `geometry:<origin>` keys hold convenience metadata. Recorder recovery uses a separate namespaced session-storage draft key. Inspect actual source/schema before writing the migration; this inventory is not a substitute for runtime validation.

Preferred safety path: rebuild uses a new schema-2 database namespace, reads old data only for migration preview, then commits the validated converted snapshot to its own stores. Leave the old database intact until the user explicitly requests removal after a verified backup. Do not opportunistically mutate an old-format database that an old bookmark might still write.

If the final implementation chooses an in-place database upgrade instead, record that decision and provide a tested rollback/export strategy before cutover. An old bookmark cannot be assumed to understand a newer database/schema.

## Conversion policy

1. Read old aggregate as untrusted JSON; validate every profile/endpoint/rule/plan and relationships.
2. Convert known schema1 fields to schema2 without guessing missing body/media/auth intent. Preserve stable IDs, display names, aliases, effective host mappings, checks, samples, rule links and plan identity.
3. Convert effective plan ordering/phases/exclusions into explicit step records. Include every saved plan in its owning profile; detect dangling or cross-profile references.
4. Normalize existing matcher string into explicit origin/path/query fields using the old matching semantics. Show any ambiguous query/body/routing changes before activation.
5. Keep exact existing raw body text. Old coercion of multipart-like input into urlencoded does not supply enough evidence to reconstruct files/multipart automatically; retain what is saved and report missing provenance.
6. Add safe new defaults only where absent. New activation/cursors/seeds/reservations/controllers do not resume; all modules start inactive. Newly added visibility settings mean visible unless explicitly disabled.
7. Redact export/recovery without pretending an old literal secret is already a safe source binding. Present unresolved sensitive values for user configuration.
8. Write all converted profiles/references/active metadata atomically into the rebuild namespace, validate reread/round-trip, then visibly switch. Failure leaves old data untouched and preview available.

Complex-app auth/refresh/signing/guard/poll definitions are explicit new schema2 configuration. Old recorded Authorization, nonce, signature or idempotency headers remain literal/provenance data with appropriate freshness diagnostics; migration never invents a signing key, automatic refresh/retry, or successful business-flow assertion.

## Rehearsal matrix

| Case | Required result |
| --- | --- |
| Current single-profile export | Same meaningful request/check/rule/plan behavior after migration |
| Whole backup with saved profiles/plans | Every entity belongs to correct profile; IDs/links preserved or coherently remapped |
| Missing settings/plan/optional fields | Versioned migration supplies safe defaults; no new ID each render |
| Duplicate IDs/aliases or corrupt reference | Actionable error/review; no partial durable write |
| Unknown future schema | Refused; old and rebuild data unchanged |
| Storage error/quota/stale revision | No partial replacement; live/export path retained |
| Old and rebuilt bookmark both clicked | One running layer; clear version guidance |
| Reload/restart after successful conversion | Correct active profile/geometry, inactive modules, recovered recorder draft only |
| Rollback to old bookmark | Old namespace still intact; schema2 edits need explicit compatible export/manual transfer, no promise of automatic downgrade |

## Cutover and rollback

Build a release candidate in isolation. Export backup, perform migration rehearsal in test origins/browser profiles, pass all gates and document known limitations. Only then replace the saved bookmark/deployed installer when separately requested. Public release must not require the fixture server or fetch executable code.

Rollback means reinstalling the prior full-inline bookmark and restoring its compatible backup/namespace on reload. It does not mean downgrading schema2 in place. Keep artifact version/hashes and redacted backups so a user can tell what was running. Review profiles/test data can remain for evidence; deletion is a separate explicit operation.

## What this task does not do

The original documentation task did not implement or publish changes. The rebuild/v2 [R0 task](history/R0_REPORT.md) and the clean [R0](R0_REPORT.md) each add an isolated runtime and separate test bookmark. No database migration, production bookmark replacement, dependency upgrade or publishing has occurred. R0, [R1](R1_REPORT.md) and [R2](R2_REPORT.md) verification remain open. R1 stores one panel-geometry preference key (`api-workbench:geometry:v1`) in the host origin's localStorage. R2 adds the schema 2 database `api-workbench-v2` and a reviewed, read-only schema 1 migration: the old `api-workbench` database is opened only when the user asks, is never created or changed, and its rules are carried as non-executable `legacyRules` until R4.
