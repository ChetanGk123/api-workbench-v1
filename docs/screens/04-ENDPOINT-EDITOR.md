# Endpoint editor

Reference: [EndpointEdit.html](../../../design/reference/screens/EndpointEdit.html). Features P04/P05/P16/P21; gates G14/G15/G22/G27; R2 request/body/check work and R6 full expression/auth integration. Read [DATA](../DATA.md), [TESTER](../TESTER.md), [COMPLEX_APPS](../COMPLEX_APPS.md).

## Required behavior

Edit a detached draft with Name, Alias, method, host/environment, path/query, credentials, global/local headers, body kind, response sample, checks and expressions. Show resolved destination and required inputs without silently sending. Fixed Save/Cancel and accurate Back return to the originating list/recorder. Retain invalid text until corrected or explicitly discarded.

Body choices are None, exact Text, JSON text, ordered URL-encoded pairs and multipart fields/files. Show inherited values separately. Sample carries provenance/status/headers/body state; missing samples stay absent. Checks have editable defaults, including expected errors when intentional. Auth/signing references link to their explicit configuration workspace.

Must not auto-format a signed/raw body, silently change body type, set multipart boundaries, read imported file paths, persist file/key/token values, create duplicate aliases or discard on Escape. Editing a capture must not mutate the saved endpoint until the intended promotion/save command succeeds.

## Task S04.1 — Build draft identity and request fields

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** field validation, alias references and safe saves. **Status:** NOT STARTED. **Depends on:** S00.2, S03.1, DATA commands.

1. Clone the endpoint into a draft tied to profile/entity/base revision; editor opened from Record uses candidate callbacks rather than saved mutation.
2. Build labelled Name/Alias/method/host/path/query/credentials controls and resolved-origin preview.
3. Validate headers and global overrides/removals; aliases need an impact preview and atomic reference update.
4. Save validates whole request and reference impact; stale revision shows a review choice. Cancel/Back/Escape use shared dirty guard.
5. Return selected endpoint and collection context; show Unsaved when ordinary persistence fails.

**Accept:** include/omit/same-origin can be created and round-tripped in UI; aliases unique; failure preserves draft; Record editor returns to candidates; accidental Escape retains banking request body.

## Task S04.2 — Implement every body kind and expression insertion

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** exact serialization, files and binding/type semantics. **Status:** NOT STARTED. **Depends on:** S04.1, S19.2 and preparation service.

1. Keep raw text/JSON unchanged unless Format JSON is explicitly clicked; parser errors reference location without deleting input.
2. Use ordered urlencoded/multipart row editors, repeated fields and runtime file selection with filename/size/type.
3. Body-kind change previews incompatible content/type-header effects; GET/HEAD with body is blocked rather than silently sent/dropped.
4. Insert expressions at current selection in eligible path/query/header/body fields, preserving caret; show required producer/source and encoding preview.
5. Track missing files and signing freshness requirements; form boundaries come from native FormData.

**Accept:** Unicode/repeated fields/files arrive as expected; imported @file remains unresolved until selection; JSON whole-value expressions preserve types; signed exact-byte body is not reformatted on reopen.

## Task S04.3 — Build response samples and declarative checks

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** false-positive tests and incomplete samples are material errors. **Status:** NOT STARTED. **Depends on:** S04.1, TESTER check evaluator.

1. Offer sample editing/explicit formatting with original status/headers/provenance and capture/redaction labels.
2. Build status/range, header, body-contains, JSON path/type/equality and duration checks with validated bounds.
3. Add expression/sample field picker and link to plan-level cross-step checks; a sample is not a live producer output.
4. Save sample/check changes with request draft atomically; do not invent sample status/body for empty input.
5. Explain body checks that need complete data; default 2xx can be replaced by intentional 503 expectation.

**Accept:** incomplete/redacted body cannot yield a false pass; expected 503 passes correctly; checks survive export/import; sample edits are labelled authored; named sample fields do not auto-create dependencies.
