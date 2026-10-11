# R2 data, endpoints and Once: clean rebuild, 11 October 2026

**Status: implemented; verification incomplete. R2 is not complete.** All 110 counted tests pass in Chrome 154: 40 pure (21 earlier + 19 new) and 70 browser (54 R0/R1 regressions + 16 new R2 cases). Saved-bookmark installation, Edge, real browser zoom, restart, real storage quota exhaustion and screen-reader checks are **NOT RUN**. The R0 and R1 open items are still open; R2 does not close them.

As in R0 and R1, this is from-scratch code. The schema 1 shape was read from `api-workbench/src/core/model.ts` and `storage.ts` so that migration converts real data. No code was copied.

## Environment and artifact

- macOS 26.6.2; Node v24.21.0; TypeScript 7.0.2; esbuild 0.28.2; Playwright 1.63.0; Google Chrome 154.0.8037.99. Edge is not installed.
- Tests ran on fixture ports **4320/4321** (`AW_PORT=4320 AW_OTHER_PORT=4321`).

| Artifact `2.0.0-r2` | Measured | Change from R1 |
| --- | ---: | ---: |
| Readable IIFE | 244,933 bytes | +147,939 |
| Minified IIFE incl. CSS | 160,561 bytes | +93,189 |
| Encoded `javascript:` URL | 234,223 characters | +137,819 |

Minified SHA-256 `40dc24b25523a1a5a5ea9707e6297a09a7ee0b03b68e191a100b2fb86ffa0765`; bookmark SHA-256 `03414d74638cf15e01bd5873142efe9d405dbc75b530ebcfc45821ec4d61ed64`. Full record: [evidence/r2-sizes.json](evidence/r2-sizes.json).

**Size risk.** The bookmark is 2.4 times the R1 size. The growth is the new code, not a dependency: by minified bytes, `endpoints.ts` 27.9 KB, `schema.ts` 19.0 KB, `settings.ts` 11.2 KB, `test.ts` 8.2 KB, `once.ts` 7.0 KB, `migrate.ts` 6.5 KB, `store.ts` 5.9 KB. The R0 increasing-size experiment (does a saved bookmark of this length install and launch in Chrome and Edge?) is still NOT RUN. It now has to run before more features are added.

## What changed

| Area | Behavior |
| --- | --- |
| Schema 2 (`src/data/schema.ts`) | Types and runtime validators for profile, endpoint, request template (method, host key or absolute URL, ordered query pairs, ordered headers with explicit removals, credentials, discriminated body), checks, samples, plans with explicit step records, auth-context definitions, HMAC-SHA-256 signing recipes, and guard/poll/assertion/idempotency step definitions. Validators rebuild a clean value from untrusted input, drop unknown fields, and reject prototype keys, forbidden request headers, line breaks in header values, GET/HEAD bodies, invalid origins, duplicate IDs/aliases/names, unknown host keys, stale references, out-of-bound numbers and future schemas. Every problem has a field path. The UI, import and storage use the same validators. |
| Complex-app definitions | Stored as definitions only: source references (cookie, local/session storage, meta), never values. Signing keys are a named runtime reference; key material is rejected. Polling is limited to GET/HEAD steps with at most 10 attempts, an interval of at least 250 ms and a deadline of at most 30 s. Ordered comparisons accept exact decimal strings only. Refresh deadlines are at most 5 s. Migration never infers auth, refresh or signing from recorded headers. |
| Storage (`src/data/store.ts`) | New IndexedDB database `api-workbench-v2`, stores `profiles` (one aggregate per profile) and `metadata` (active profile). Each write is a compare-and-set on the stored revision. A stale tab gets a conflict, with **Use stored version** / **Keep this tab’s version**, never a silent overwrite. Ordinary edits apply live, then save; a persistent banner shows Unsaved, with Retry and Export. Restore, import, profile create/copy/delete and Promote common are written first and applied only after the commit. When IndexedDB is refused, the session keeps working and says so. Stored records that fail validation are reported and left untouched. |
| Schema 1 migration (`src/data/migrate.ts`) | A pure conversion of the live profile, its saved profiles, its live and saved plans, and its rules. It accepts an export, a whole backup or the stored record. Settings → **Look for schema 1 data** opens the old `api-workbench` database read-only and never creates or changes it; you review the result before anything is added. IDs, names, aliases, host mappings, checks, samples and exact body text are preserved. A non-canonical URL-encoded body stays exact text with its type header, and the migration says so. A GET body that schema 1 never sent is dropped, with a note. Plan phases and exclusions become ordered step records. Rules are kept as non-executable data (`legacyRules`) until R4. A dangling plan, a duplicate alias or a future schema refuses the whole migration. |
| Export / import (`src/data/backup.ts`) | **Export active profile** and **Export all profiles (backup)** are separate envelopes. Literal sensitive header values are redacted by default to `{{$redacted}}`, which blocks dispatch with *value was redacted on export; enter it again*. Source references are kept, and the preview lists exactly which fields are redacted. **Include sensitive header values** shows what will be included. Import accepts schema 2 or schema 1 input of up to 10 MiB and reviews it before committing. A profile export is added; if its ID or name is already stored, it is added as a remapped copy. A backup replaces every stored profile after a preview that names the removed profiles. |
| Profiles and Settings | Active profile selector with an explicit **Switch**; Create empty; Save copy (every ID and reference remapped once); Rename (unique, case-insensitive); Delete with an impact preview. Deleting the last profile creates an empty Default. Body-check limit (1–10240 KB) with Reset. **Clear local data** lists the profiles and endpoints it will delete and the panel position; other sites and the schema 1 database are untouched. About shows the version, site and data schema. The profile name is shown in the title bar. A profile change cancels an in-flight Once. |
| Endpoints | Filtered list by name, alias, method, host or path. Rows have Run / Edit / Move / Delete and badges for checks, sample, inputs and files. Move is disabled while the list is filtered. Delete previews linked plans, rules and parsed `{{alias…}}` references, and refuses when the endpoint is an auth refresh endpoint. Separate workspaces for **Global headers** (ordered rows plus data-only Presets: JSON Accept/Content-Type, CSRF from cookie or meta, Bearer from localStorage), **Promote common** (identical headers across the selected endpoints; sensitive literals and global conflicts excluded; also lists the unselected endpoints that will newly receive the header; one durable commit) and **Environments** (host key → origin per environment; blank means this page; the preview names every destination change; absolute URLs are never moved; Save/Reset/Cancel). |
| Endpoint editor | Detached draft with the shared Keep editing / Discard / Save guard, including Escape. Name, alias, method, host or absolute URL, a live resolved destination, ordered query pairs and credentials (Same origin / Include / Omit). Inherited global headers are shown as *inherited*, *overridden here* or *removed here*. Body kinds are None, exact Text, exact JSON (Format only on click), ordered URL-encoded pairs, and multipart fields/files. Files are chosen at run time; only a file-name hint is stored. A body-kind change names what would be lost. Checks cover status range, header, body contains, JSON path exists/equals/type, and duration. A sample shows captured, authored or migrated provenance; editing it marks it authored. Renaming an alias previews the exact parsed references and updates them in the same save. |
| Request preparation (`src/tester/once.ts`) | One path: environment origin → URL/query → header precedence (global → endpoint override/removal; empty value is not removal) → body. JSON gets `Content-Type: application/json` only when no header sets it; multipart refuses a manual Content-Type. `{{$cookie/localStorage/sessionStorage/meta("…")}}` resolve at dispatch and are masked in the preview. Every other `{{…}}` blocks dispatch by name (expression engine is R6). |
| Test → Once | Endpoint selection by ID; **Direct** (captured native fetch, bypasses all rules) or **Apply rules** (enters the page pipeline and appears in Recent activity) next to Run. A preview of the exact request: URL, origin source, credentials, masked headers by source, body summary, file pickers and an exact list of reasons it cannot be sent. Run is disabled while a request is pending; Cancel aborts the owned request. The result is identified (*Run #n · endpoint · mode · time*). It shows outcome, status, observed ms, bytes, body state, check outcomes (passed / failed / not evaluated), headers and body. The body is read only up to the body-check limit; a truncated or unreadable body cannot pass a body check. **Copy body**, **Save sample** (captured, at most 16 KiB, truncation labelled) and **Add check** (opens the editor with a status check already filled in). |

## Gate ledger (scoped; not whole-gate PASS)

| Gate / portion | Result | Evidence and boundary |
| --- | --- | --- |
| G21 schema 1 → 2 | PASS (pure + Chrome) | Whole-backup fixture migrates with IDs, plans and exact bodies preserved; migrate → export → import round trip is identical; a real schema 1 IndexedDB record is migrated through the UI, the endpoint sends its exact body with the migrated global header, and the old record is byte-for-byte unchanged afterwards |
| G21 refusal/corruption | PASS | Future schema (backup file and schema 1 path), invalid JSON, dangling plan, duplicate alias and prototype keys refuse everything with field paths |
| G21 storage failure / multi-tab | PASS (simulated) | IndexedDB open refused → session-only with a working Once. Write throws `QuotaExceededError` → Unsaved banner, then Retry → stored and present after reload. A second tab writes first → conflict, Use stored version. **A real quota exhaustion was NOT RUN.** |
| G21 backup/restore/redaction | PASS (Chrome) | Backup download contains no literal token; Clear → restore from file → the endpoint returns, and the redacted header blocks dispatch with its reason |
| G21 atomic profile switch | PASS (Chrome) | Create/copy/rename-conflict/switch/delete; active pointer survives reload; the last delete leaves an empty Default |
| G14 editor/headers | PASS (Chrome) | CRUD; exact JSON bytes after reopen; URL-encoded repeats/order/Unicode; multipart with a run-time file; credentials include/omit/same-origin observed at the server across origins; global/override/removal; CSRF preset blocks until the cookie exists, then sends the rotated value masked; Promote common (sensitive differing auth not promoted; failed commit changes nothing); environments (host keys move, absolute URL stays, invalid origin refused); alias rename updates exact references only; delete preview and Cancel |
| G14 dependency Re-analyze | **NOT IMPLEMENTED** | Parsed-reference DAG is R6 (S03.3 item 4). Delete/rename previews use the same parser |
| G15 Once | PASS (Chrome) | Direct bypasses an active mock (1 server hit) while Apply rules is mocked (0 new hits) and traced; Cancel settles and re-enables Run; expected 503 passes; a 2 MiB body over a 1 MiB limit is *not evaluated*; blocked inputs send nothing; Save sample; Add check opens a dirty draft |
| G15 Copy body | **NOT RUN** | Clipboard outcome not asserted in automation |
| G22 R2 screens | PASS (emulated) | 360×420: no panel or main horizontal overflow on Endpoints, editor, Once, Settings; editor Save in view. Real zoom/screen reader NOT RUN |
| G02 saved bookmark for 2.0.0-r2 | **NOT RUN** | Automated launches inject the decoded artifact |

[Counted results](evidence/r2-automated.json): **110 expected, 0 unexpected, 0 skipped, 0 flaky**, 38.1 s. Screenshots: [Endpoints](evidence/r2-endpoints.png), [editor](evidence/r2-editor.png), [Once result](evidence/r2-once.png), [Settings](evidence/r2-settings.png).

During development, 3 of the 15 first-run R2 browser cases failed, all because of mistakes in the tests:
- One test reloaded before the background save had landed. The test now waits for *All changes saved*. The behavior itself is the boundary listed below.
- One used an ambiguous text locator.
- One used the wrong button name.

A later constrained-layout failure had the same cause as in R1: the panel was measured before the window `resize` handler had run. The test now polls.

## Commands

```sh
AW_PORT=4320 AW_OTHER_PORT=4321 npm run verify   # tsc --noEmit && build && build+playwright (core ×2, browser, shell, data)
npm run fixture                                 # installer at http://127.0.0.1:4310/install (or AW_PORT)
```

## Deliberate R2 boundaries

- **Expressions:** only the page-source builtins resolve. Producer references (`{{alias.path}}`), generators and `$eval` block dispatch by name until the R6 engine. Expression insertion at the caret (S04.2 item 4) and the expression picker are R6/S19.
- **Auth and signing:** definitions are validated, stored, exported, copied and migrated, but there is no editing workspace (S22) and Once does not apply them. Refresh, signing and poll execution are R6.
- **Plans** exist as validated, migrated data with no UI or runner (R6). **Rules** are still the R1 page-session rules, not profile data; schema 1 rules are carried as `legacyRules` until R4.
- **Settings scope:** module visibility, log/capture limits, context roots, recorder reset and the update check (S18.2/S18.3) are not built. Only the body-check limit is a working setting.
- **Once:** Apply rules traffic appears in Recent activity as a page request; the request record has no *tester* source field yet. Once history (S07.3 item 4) arrives with Results in R6. Timing is total observed time only.
- **Live-then-save:** an ordinary edit is stored a few milliseconds after it is applied. Closing the tab inside that window loses the last edit. Settings shows Saving/Saved, and failures show the banner.
- **Multi-tab:** a conflict is detected when the second tab writes. The other tab's view does not update live.
- **Redaction** is by header name (authorization, cookie, api-key, and names containing token, secret, session, csrf, xsrf, password or signature). Sensitive sample headers are dropped. Bodies are not scanned. This is not a secret detector.
- Storage is per site (IndexedDB on the host origin), so each site has its own profiles. It is readable by that site's scripts.

## Remaining before R2 can close

- [ ] Saved-bookmark install of 2.0.0-r2 (234,223 characters) in Chrome, then Edge, including the R0 increasing-size experiment. Then reload, restart, create an endpoint, and check that it persists.
- [ ] Real quota exhaustion and a real second browser window, not just simulated failures.
- [ ] Copy body clipboard outcome (granted and refused).
- [ ] Screen-reader pass of the editor rows, dialogs, Once result and Settings.
- [ ] R0/R1 open items.
