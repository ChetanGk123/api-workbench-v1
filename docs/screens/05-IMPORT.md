# Import and import review

Reference: [Import.html](../../../design/reference/screens/Import.html). Features P09/P10/P17/P21; gates G19/G20/G22; slices R3/R7. Read [IMPORT_RECORDER](../IMPORT_RECORDER.md) and [DATA](../DATA.md).

## Required behavior and states

Source region includes Paste, Choose file, detected format/version, override/help/examples, Apply, Clear/Export draft and recording entry. Apply parses/previews; Import selected/profile is the separate durable action. Show destination profile/revision, source/importable/skipped counts, per-item diagnostics/required values, names/selection, media examples, conflicts and sensitive/fidelity notes.

States are empty, reading, parsing, invalid, review, saving, failed save and saved. Native modes are new-profile-and-switch, merge and explicit replace. Cancel/Back/Minimize retain draft. Changed destination/revision invalidates review without erasing source. Recording entry opens/uses the one recorder; it is not another capture implementation.

Do not execute snippets, send imported requests, read remote refs/local file paths, trust extension alone, claim detection equals import support, silently merge differing bodies/queries, invent samples or report Saved before transaction completion. Missing signing/token requirements stay visible.

## Task S05.1 — Implement source draft and parser lifecycle

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** stale async input/file/parse results must not overwrite drafts. **Status:** IMPLEMENTED for all seven families (R3: native, HAR, recorder; R7: Swagger 2.0, OpenAPI 3.0, Postman v2.1, cURL bash/cmd, copied fetch); verification incomplete — Edge, saved bookmark and screen reader NOT RUN ([R3 evidence](../R3_REPORT.md), [R7 evidence](../R7_REPORT.md)). **Depends on:** S00.2, bounded parser entry.

1. Keep source text/file provenance/override in view state; use monotonic draft generation to reject stale results.
2. Inspect bytes/content; reject oversize before uncontrolled allocation. File cancel/failure preserves old draft; replacement prompts when edited.
3. Detect exact family/version or ambiguity; override contradiction names expected/observed format.
4. Apply yields between bounded candidate batches; busy/Cancel states prevent duplicate parse/commit. Runtime help lists actual adapters/dialects.
5. Export/Clear draft operate on draft only; recorder entry reuses capture session.

**Accept:** every reference control works; a newer paste wins over an older file read; cancel retains input; snippet containing code is refused and executes/sends nothing.

## Task S05.2 — Implement candidates, diagnostics and conflicts

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** fidelity and identity changes affect saved requests. **Status:** IMPLEMENTED for all seven families (R3: native, HAR, recorder; R7: Swagger 2.0, OpenAPI 3.0, Postman v2.1, cURL bash/cmd, copied fetch); verification incomplete — Edge, saved bookmark and screen reader NOT RUN ([R3 evidence](../R3_REPORT.md), [R7 evidence](../R7_REPORT.md)). **Depends on:** S05.1, format adapters/validators, S04 candidate editor.

1. Render stable candidate IDs with selection/name/resolved method+origin+path and source notes.
2. Support missing parameter/binding/file/signing requirements, selectable media examples and redaction preview.
3. Compare normalized request identity including relevant body/query; separate alias naming conflicts.
4. Keep both/Replace specific item/Skip each preview final entity/reference impacts; Select all/Clear act on clearly stated scope.
5. For native imports show aggregate mode/remap/removal summary rather than pretending it is a flat endpoint list.

**Accept:** same path with different bodies remains distinct; unsupported flags/security/scripts have source locations; Replace names linked rules/plans; review never creates requests or durable data.

## Task S05.3 — Commit transactionally and prove every format

**Suggested model:** GPT-6 Astra. **Effort:** high. **Why:** rollback, ID remapping and stale destination safety. **Status:** IMPLEMENTED for all seven families (R3: native, HAR, recorder; R7: Swagger 2.0, OpenAPI 3.0, Postman v2.1, cURL bash/cmd, copied fetch); verification incomplete — Edge, saved bookmark and screen reader NOT RUN ([R3 evidence](../R3_REPORT.md), [R7 evidence](../R7_REPORT.md)). **Depends on:** S05.2, DATA transactions, every advertised adapter.

1. Revalidate selection and base profile/revision before commit; stale destination rebuilds review.
2. Apply ID/reference remapping as one aggregate; commit to durable stores before installing imported live config.
3. On refusal retain draft/selection/review with Retry/Export draft and zero success count.
4. On success switch visibly when requested, restore imported list/filter and report exact counts/unresolved requirements.
5. Run per-format parse→review→commit→representative dispatch/check, file/paste parity and no-code/no-network import assertions.

**Accept:** all seven families and recorder path verified; native copy/merge/replace reference behavior correct; injected failure/stale profile changes nothing; current bank signing headers are not advertised as fresh usable signatures.
