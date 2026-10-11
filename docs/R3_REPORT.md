# R3 recorder and native/HAR review: clean rebuild, 11 October 2026

**Status: implemented; verification incomplete. R3 is not complete.** All 131 counted tests pass in Chrome 154: 52 pure (40 earlier + 12 new) and 79 browser (70 R0–R2 regressions + 9 new R3 cases). Saved-bookmark installation, Edge, restart, real storage-quota exhaustion, a real second tab and screen-reader checks are **NOT RUN**. The R0–R2 open items are still open; R3 does not close them.

As in R0–R2, this is from-scratch code.

## Environment and artifact

- macOS 26.6.2; Node v24.21.0; TypeScript 7.0.2; esbuild 0.28.2; Playwright 1.63.0; Google Chrome 154.0.8037.99. Edge is not installed.
- Tests ran on fixture ports **4320/4321** (`AW_PORT=4320 AW_OTHER_PORT=4321`).

| Artifact `2.0.0-r3` | Measured | Change from R2 |
| --- | ---: | ---: |
| Readable IIFE | 320,298 bytes | +75,365 |
| Minified IIFE incl. CSS | 208,963 bytes | +48,402 |
| Encoded `javascript:` URL | 304,003 characters | +69,780 |

Minified SHA-256 `3729012c3b267d4e891ded9a94747483787807a88f041968a7eebce5a1781a00`; bookmark SHA-256 `d40e4d35d7d0819a2590f3cc36d1cb571dc718d53b377162344b001f2f84b020`. Full record: [evidence/r3-sizes.json](evidence/r3-sizes.json).

**Size risk, now the top open item.** The R2 report said the increasing-size saved-bookmark experiment had to run before more features were added. It was not run, and the bookmark grew another 30% to 304K characters. By minified bytes, the new code is `importer.ts` 22.7 KB, `review.ts` 12.4 KB, `importers.ts` 6.8 KB, plus capture code in the adapters. `settings.ts` shrank from 11.2 KB to 7.3 KB because import moved out of it. **Run the experiment in Chrome and Edge before R4.**

## What changed

| Area | Behavior |
| --- | --- |
| Capture (`src/net/capture.ts`, `fetch.ts`, `xhr.ts`) | No new hook. When the recorder is on, the existing Fetch/XHR adapters attach a capture to the request record at intake: method, origin+path, ordered query pairs, headers, credentials and the body. Response status and headers follow, plus a bounded text preview read from a `Response` clone (Fetch) or `responseText` (XHR). The capture is **redacted as it is built**. Sensitive header names, query and form fields named like secrets, and JSON keys such as `password` or `access_token` become `{{$redacted}}`; truncated JSON is redacted textually. Browser-controlled headers (Host, Cookie, `Sec-*`, …) are dropped with a note. The response is joined to its request by record ID, never by URL. A request record now has a `source`; Test → Once with **Apply rules** is labelled `tester`. |
| Body limits | Request text is kept up to 64 KiB. A response preview is kept up to 16 KiB with a 2 s deadline, and it uses the shared 4-slot body budget. Binary, Blob, ArrayBuffer, stream and Document bodies are not captured; each records a reason. An unknown-length slow stream is cancelled on our clone only; the page still receives the whole body. A body that was not captured becomes `{{$missing}}`, which blocks dispatch with *not captured when recorded or imported; enter it before sending*. |
| Recorder (`src/data/recorder.ts`) | One recorder per panel, fed by the runtime. Start and Stop are idempotent. Calls that started before Stop still settle into the draft. Tester traffic is excluded unless **Include tester traffic** is on, and it is then labelled. Limits: 100 calls and a 1 MiB draft envelope. At either limit, capture stops with an explanation and the draft stays reviewable and exportable. A recovery copy goes to a new `recorderDrafts` store (IndexedDB version 2), debounced by 300 ms, holding origin, schema, time, calls and deselection. After a reload the draft comes back **inactive**, never recording. Reset asks first, names the exact scope, removes the recovery copy *before* clearing the screen, and never touches profiles. A title-bar **REC** badge and the launcher show recording. **Export as HAR** writes the redacted draft as HAR 1.2, which Import reads back to the same candidates. |
| Import (`src/ui/importer.ts`, `src/data/importers.ts`) | One screen (reference Import.html): Recorder, Source (format override, Choose file, Paste, Apply, Cancel, Clear draft, Export draft, Look for schema 1 data) and a shared review. The format is detected from content. Swagger/OpenAPI/Postman/cURL/copied fetch are *named* ("arrives in a later build"), never claimed or executed. An override that contradicts the content names both formats. Input over 10 MiB is refused before reading. A monotonic draft generation means a slow file read never replaces text typed after it; the file read is replaced, not the typing. Choosing a file over edited text asks Replace draft / Cancel. Settings' import and schema 1 sections moved here; Settings now links to Import. |
| HAR 1.2 adapter | Accepts HAR 1.2 (and 1.1 with a note), up to 1,000 entries. It reads method, URL, repeated query, headers, `postData` text/urlencoded params/multipart params (file params become run-time file requirements), status, headers and content including base64 text. Base64 binary, missing or unfinished responses, cookies and restricted headers are notes. Recorded time is provenance only, never a check. Non-HTTP entries are skipped with a reason. |
| Review (`src/data/review.ts`) | Calls are grouped by **method + origin/path + query + body**. Cache-buster query parameters (`_`, `ts`, `t`… with a timestamp or `Math.random()` value) are ignored for grouping and offered for removal. Different queries or bodies stay separate and are labelled *variant n of m*. Each candidate has selection, an editable name (the path, without the method) and alias, resolved URL, sample choice among grouped calls, notes, and *Needs before sending* (redacted values; historical nonce, idempotency, timestamp or signature headers; files; uncaptured bodies). A captured signature is never presented as reusable. Duplicates of saved endpoints are detected by request identity, never name, and default to **Skip**. **Keep both** gives a fresh ID and alias; **Replace** keeps the saved ID and alias so references stay valid, and names plans that use it. Possible dependencies (a JSON response value reappearing in a later request) are listed as suggestions and never linked. Destination is the current profile or a new named profile. |
| Native import | A profile export or single schema 1 profile can be imported as a **New profile, then switch** (renamed, remapped copy on ID/name collision), **Merge into current** or **Replace current**. A backup can only **Replace all profiles**. Merge reviews endpoints as candidates and adds plans, auth contexts, signing recipes, missing host keys and global headers. Every colliding ID is remapped once, and references follow: plan steps, refresh endpoints, endpoint→context/recipe, and `{{alias…}}` references when an alias is renamed. Skipped endpoints map references to the saved equivalent; deselected ones drop their plan steps with a note. Existing environment mappings and global headers win, with notes. Replace previews the removal scope and offers export first. |
| Commit | Every commit is durable first. Adding to the current profile uses the session's revision-checked durable edit. New profile, replace and restore use one transaction that now also checks the expected stored revision of every profile it replaces or creates. The review records the destination profile and revision. A switch or edit marks it stale, disables Import and offers **Rebuild review**. A storage failure saves nothing, keeps source, review and selection, and offers Retry and Export draft. The success summary states the exact added/replaced/skipped/needs-values counts. Committing recorder calls never removes them from the draft; **Remove imported calls from the recorder draft** is a separate action. |

## Gate ledger (scoped; not whole-gate PASS)

| Gate / portion | Result | Evidence and boundary |
| --- | --- | --- |
| G18 future calls, both transports | PASS (Chrome) | A call before Start and a call after Stop are not captured. Concurrent Fetch and XHR POSTs to the same path, plus a binary GET, give 3 calls. Each sample is its own response. |
| G18 redaction | PASS (pure + Chrome) | A bearer token, form `password`, query `access_token`, and `authorization` echoed in a response body never appear in the rendered panel or the candidates. Unchanged JSON stays byte-exact. |
| G18 caps / body states | PASS (Chrome) for the 100-call cap, binary omission and stream exclusion; **NOT RUN** for the 1 MiB envelope cap in a browser | 105 calls stop at 100 with a reason, and the draft stays usable. A 3 s unknown-length stream: the page gets every chunk, and the capture says *Body not complete within 2000 ms*. |
| G18 recovery | PASS (Chrome) | After a reload: *Recovered draft … not recording*, no REC badge, and a new call is not captured. Reset Cancel keeps the draft. Reset clears it, and a further reload shows nothing. **Recovery write refused by storage: NOT RUN.** |
| G18 selection / promotion | PASS (Chrome) | Deselecting one of three imports exactly 2 and sends nothing (server counters unchanged). The redacted field blocks Once. The draft keeps all calls until the explicit removal. Tester traffic is excluded by default and labelled when included. |
| G19 HAR | PASS (pure + Chrome) | Same URL with different bodies stays distinct, grouping counts, base64, missing response, restricted headers, multipart files, GET body dropped. File and paste give identical candidate lists. Import to a new profile, then Once sends the exact HAR body and header. Zero requests during parse/review/commit. |
| G19 native | PASS (Chrome + pure) | Profile export → Merge (conflict Skip/Keep both) and Replace current. Schema 1 database → new profile and switch, old DB unchanged (R2 test, now through Import). Backup restore through Import. Future schema refused. |
| G19 Swagger/OpenAPI/Postman/cURL/fetch | **NOT IMPLEMENTED (R7)** | Detected and named; a pasted `fetch(...)` is refused, runs nothing, and sends nothing. |
| G20 transaction | PASS (Chrome + pure) | An injected `QuotaExceededError` saves nothing and keeps the review; Retry commits once with exact counts. A profile switch after review → stale, Import disabled, Rebuild review → saved to the new destination. Merge ID/alias/reference remapping and Skip/deselect reference handling validate (pure). **A real second-tab stale write against the new expected-revision check: NOT RUN.** |
| G07 subset (capture) | PASS for the stream deadline and the 16 KiB/64 KiB caps (pure) | Body-slot exhaustion during recording is not exercised. |
| G22 Import/review | PASS (emulated) | 360×420: no panel or main horizontal overflow; Import button reachable. Real zoom/screen reader NOT RUN. |
| G02 saved bookmark for 2.0.0-r3 | **NOT RUN** | Automated launches inject the decoded artifact. |

[Counted results](evidence/r3-automated.json): **131 expected, 0 unexpected, 0 skipped, 0 flaky**, 48.7 s. Screenshots: [recorder](evidence/r3-recorder.png), [review](evidence/r3-review.png).

During development:
- 3 of the 9 first-run browser cases failed because of test mistakes: an edited draft correctly triggered the Replace prompt, `fetch` lowercases header names, and a `Cancel` locator was ambiguous.
- Two product bugs were found and fixed:
  1. **Reset ordering.** Reset cleared the screen before the recovery delete committed, so a quick reload could bring the draft back.
  2. **Grouping.** `t=hi` counted as a cache-buster, which would have merged `?t=hi` and `?t=bye`. Cache-busters are now only timestamp-like or random-number values, and a test covers the word case.
- A test assertion `toContainText('0 of 100')` matched `100 of 100` and hid the timing of the first fix; the counts are now anchored.
- One pure assertion could collide with random IDs and was made specific.

## Commands

```sh
AW_PORT=4320 AW_OTHER_PORT=4321 npm run verify   # tsc --noEmit && build && build+playwright (core ×3, browser, shell, data, import)
npm run fixture                                 # installer at http://127.0.0.1:4310/install (or AW_PORT)
```

## Deliberate R3 boundaries

- **Candidate editing** is name, alias, selection, sample choice, cache-buster removal and the conflict action. Headers, bindings and bodies are edited in the endpoint editor after import. S06.2 item 3's in-review header/binding edit is not built.
- **Recorder limits** are fixed at 100 calls and 1 MiB. The Settings control to raise them toward 1,000 is S18 work. Recovery is debounced by 300 ms, so a reload inside that window loses the newest calls.
- **Redaction is by name**: headers, query, form fields and JSON keys. Plain-text bodies are not scanned. It is not a secret detector. Fetch reports header names in lower case, so recorded endpoints use lower-case names; HTTP treats them the same.
- **Previews** are read only while recording, from a clone, and share the 4-slot body budget with Route/Intercept; a busy budget skips the preview with a reason. XHR `json` responses are re-serialized. XHR `arraybuffer`, `blob` and `document` responses are not captured. Responses from an active Mock rule are captured with a *synthetic* note.
- **Replace** keeps the saved ID and alias; the session rules (R0 modules) that match its path are not changed. Native merge keeps existing environment mappings and global headers.
- **Dependency suggestions** only compare JSON string/number values of at least 8 characters, from earlier responses with later requests.
- Multi-tab: a stale review is detected by profile revision, and replace/new-profile transactions now check the expected stored revision. The other tab's view does not update live.

## Remaining before R3 can close

- [ ] Saved-bookmark installation of 2.0.0-r3 (304,003 characters) in Chrome, then Edge, as the R0 increasing-size experiment. Then reload, restart, record, import, and check that both persist.
- [ ] Recorder envelope cap (1 MiB) and recovery-write refusal in a real browser.
- [ ] A real second tab committing an import against a stale revision.
- [ ] Screen-reader pass of the recorder controls, candidate rows and conflict selects.
- [ ] R0–R2 open items.
