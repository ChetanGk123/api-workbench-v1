# R4 rule modules: clean rebuild, 11 October 2026

**Status: implemented; verification incomplete. R4 is not complete.** All 162 counted tests pass in Chrome 154: 71 pure (50 earlier + 21 new) and 91 browser (79 R0–R3 regressions + 12 new R4 cases). Edge, real zoom, a screen reader, CORS-denied routing for R4, and tester-driven chaos journeys are **NOT RUN**. The saved-bookmark gate that blocked R4 has now run in Chrome (below). The R0–R3 open items are still open.

As in R0–R3, this is from-scratch code.

## Saved-bookmark experiment (G02, Chrome): run before R4 started

PLAN required the increasing-size experiment before R4. `scripts/bookmark-experiment.mjs` does the following for each size, in its own throwaway Chrome profile:

1. Saves the URL through Chrome's own bookmark model (`chrome.bookmarks.create` on `chrome://bookmarks`).
2. Restarts the browser.
3. Reads the URL back and compares SHA-256.
4. Reopens the bookmark manager.
5. Runs the saved URL on `/fixture` with a browser-initiated navigation (CDP `Page.navigate`), which is the path a bookmark click takes.

Size 0 is the generated bookmark. Larger sizes are the same bookmark plus an encoded trailing comment.

| Saved URL | 2.0.0-r3 run | 2.0.0-r4 run |
| ---: | --- | --- |
| generated (304,003 / 386,042 chars) | saved, byte-exact after restart, launches, shows version | same |
| 512 KiB | byte-exact, launches | same |
| 1 MiB | byte-exact, launches | same |
| 1.5 MiB | byte-exact, launches | same |
| 2 MiB − 64 | saved, then **the bookmark manager crashes on reopen** after restart | same |
| 2 MiB + 64 | byte-exact, but **does not launch** (over Chrome's URL limit) | same |

Evidence: [evidence/r4-bookmark-chrome.json](evidence/r4-bookmark-chrome.json).

**Boundary:** a bookmark at or near 2 MiB is unusable in Chrome 154. **Working ceiling: 1.5 MiB, tested.** R4 is 26% of that.

**Not covered:**
- Dragging to the bookmarks bar and clicking it with a mouse. Automation cannot reach browser chrome. The model API, restart and browser-initiated navigation are the same code paths, but a manual click is still the formal G02 step.
- Edge, which is not installed.

## Environment and artifact

macOS 26.6.2; Node v24.21.0; TypeScript 7.0.2; esbuild 0.28.2; Playwright 1.63.0; Google Chrome 154.0.8037.99. Fixture ports 4320/4321.

| Artifact `2.0.0-r4` | Measured | Change from R3 |
| --- | ---: | ---: |
| Readable IIFE | 407,044 bytes | +86,746 |
| Minified IIFE incl. CSS | 264,118 bytes | +55,155 |
| Encoded `javascript:` URL | 386,042 characters | +82,039 |

Minified SHA-256 `406c6d99c492694c829badd485f58c99bd6b60ec6179f0b1a085afd4c028faf7`; bookmark SHA-256 `38b87785586e302f7ef9189be3b91a30c1b3d982248c99e593ac58535d3d5d70`. Full record: [evidence/r4-sizes.json](evidence/r4-sizes.json). By minified bytes, most of the growth is the rule editors (`src/ui/rules.ts`), the adapter pipelines, and the planner/patch/schema code.

## What changed

| Area | Behavior |
| --- | --- |
| Durable rules (`src/data/schema.ts`) | Schema 2 gains `rules`: mock, intercept, route and chaos rules. Each has an ID, label, optional endpoint link, enabled, priority, creation sequence, action revision and matcher. Matcher fields: method, origin (blank = launch frame), exact or glob path, query and header conditions, and literal body-contains. Runtime validators enforce: legal statuses; no body on 204/205/304; no `Set-Cookie` in synthetic replies; forbidden request headers; JSON Pointer paths with prototype segments refused; exact or trailing `/**` rewrites only; finite delays, durations, budgets and copies; and fault/mode compatibility (synthetic latency, corruption and replay are refused, with the reason). Rules are saved with the profile. Activation, cursors, samples and budgets stay runtime-only, so every module starts inactive on launch. Copy, export, merge import and endpoint delete all remap or detach rule links. |
| Schema 1 rules | `rulesFromV1` converts v1 rules one by one. Migration notes name any that do not convert; those stay in `legacyRules` as data and never run. A schema 2 aggregate stored before R4 converts on load. v1 relative URLs matched any origin; they are now scoped to the launch frame, and the note says so. |
| Planner (`src/net/plan.ts`) | One pure planner reads only the original request. Precedence is priority, then creation sequence, then ID, with one winner per module. In globs, `*` stays in a segment and `**` crosses segments. A repeated query key matches if any of its values matches. Header names are case-insensitive. A body that is not complete bounded text is "not evaluated": it never false-matches, the record says why, and a lower rule can still win. Reservation happens once per request in arrival order: the sequence cursor, one chaos sample (seeded mulberry32 or random) and the hit budget. A sampled-out request never tries a lower chaos rule. Exhausted budgets and ended active periods stop selection. Composition order is synthetic chaos > mock > network. Route and request edits are *superseded* by any synthetic provider. Response edits are superseded by transport failures. Real chaos is superseded by a mock. Operations carry `part` (request/response) and the new state `sampled-out`. |
| Runtime | Per-rule state resets on module activation or an action-revision change. A label or enabled edit keeps it. Replay copies are records with `parentId` and source `replay`, under a 20-in-flight global cap. |
| JSON Patch (`src/net/patch.ts`) | RFC 6902 add/remove/replace/move/copy/test on an isolated copy: every operation applies, or none does. Only own properties are touched. `__proto__`, `constructor` and `prototype` path segments are refused. Literal find/replace has first and all modes, with no regular expressions. Header edits apply removal before set. |
| Fetch adapter | The unmatched path is unchanged. Mock sequences cover legal replies, slot network errors and timeouts (fetch rejects with `TimeoutError`), and exhaustion as a network error, never real traffic. Synthetic chaos covers status, network error, timeout and malformed JSON. Route and request edits are prepared once; a prebuilt `Request` body is read from a clone, bounded. Response edits rebuild only when something changed. Header and status edits keep the original stream, so they work on binary. Body edits need finite text of at most 1 MiB; otherwise the body is skipped with a reason while the header edits still apply. Rewritten bodies drop `content-length`/`content-encoding`. Real chaos runs after response edits: delivery latency, status replacement, network error or timeout after dispatch (the record says upstream effects stand), malformed text, and transactional JSON corruption. Replay sends 1–2 exact copies through captured `fetch` after the primary, with an optional gap. It stops on Close, Chaos deactivation or caller abort, and the page sees only the primary. |
| XHR adapter | Planning moved from `open()` to `send()`, so header and body conditions can be evaluated. Route and request-header edits re-open the page's own native object at the destination and replay its headers, keeping responseType, upload, progress and timeout native. **Finding:** the plan was to hold native events with a capture listener at the target. A direct test showed that Chrome 154 runs target listeners in registration order, capture or not, so this cannot hold events back. Response edits and real chaos therefore run the request on an **internal native XHR** owned by Workbench. The page's object never sends and gets one event sequence with the final values. The typed response (arraybuffer/blob/json) is reused, so header and status edits work on binary. |
| UI (`src/ui/rules.ts`) | One list/editor system replaces the R0 single-rule screens. The list shows: module state; a separate enabled count; matched/applied/skipped/superseded counts (plus sampled-out for chaos); linked and ad-hoc groups; and runtime state per rule (next reply, exhausted, hits used, time left). It also has New rule and From endpoint. Chaos adds six presets plus five under More…; a preset opens a draft with no path, so it cannot apply to anything until a matcher is chosen. Editors share Match: endpoint link with explicit *Detach to edit*, conditions, priority, enabled, and a note when the module is active. Kind-specific parts: Mock has static or sequence slots, reorder, and an exhaustion choice. Intercept has request/response headers, raw JSON Patch with an append-only builder, literal replace, status, and a local preview on the linked sample. Route has destination, rewrite, credentials, an explicit Authorization choice and a live URL preview. Chaos has compatible fault/mode, parameters, probability/seed/budget/duration and a "When it fires" summary. Home has four module cards. Request detail shows provider, per-part operations and replay parent/child links. |

## Gate ledger (scoped; not whole-gate PASS)

| Gate / portion | Result | Evidence and boundary |
| --- | --- | --- |
| G02 saved bookmark | **PASS (Chrome, model API + restart + browser navigation)**; manual bar click and Edge NOT RUN | Table above. |
| G08 matching/precedence/reservation/reasons | PASS (pure + Chrome) | Globs, query any-of, case-insensitive headers, not-evaluated body with fallback, priority/sequence/ID, launch-origin scoping, one op per module, superseded and sampled-out reasons. |
| G09 mock | PASS (Chrome) for sequence on both transports, Unicode, 503 statusText, explicit network-error exhaustion, timeout slot, zero upstream hits, restart on activation, persistence across reload with modules inactive, linked endpoint follows a path change | R0 static/abort/close cases still pass. |
| G10 intercept | PASS (Chrome + pure) for request header set/remove, request JSON Patch, response status/JSON Patch on fetch and XHR, failed patch delivering the original, binary keeping native bytes while headers apply, prototype guard and atomicity | Response *body* edits on XHR arraybuffer/blob/document are skipped by design. |
| G12 route | PASS (Chrome) for `/**` capture rewrite cross-origin, repeated query kept, Authorization removed unless explicitly forwarded (fetch and XHR), blob XHR routed natively | Allowed/denied CORS routing not re-run for R4. R0 binary/arraybuffer/Request-body cases still pass. |
| G13 chaos | PASS (Chrome + pure) for synthetic 503/timeout/network error/malformed JSON with zero hits; real 500/network error with one hit and an upstream-effects reason; real latency on fetch and arraybuffer XHR; probability 0 sampled out; budget 1; seeded corpus; duration; corrupt JSON on both transports; replay primary + 2 copies on both transports with idempotency keeping one logical transfer; deactivate and Close during the gap send no further copy | Tester-driven chaos, expired-auth/429 journeys and signing-recipe refresh NOT RUN or NOT IMPLEMENTED (R6). |
| G22 rule screens | Partial | The R1 360×420 emulated check still passes on the Mock editor. Chaos/Route/Intercept editors are not separately measured; real zoom and screen reader NOT RUN. |

[Counted results](evidence/r4-automated.json): **162 expected, 0 unexpected, 0 skipped, 0 flaky**. Screenshots: [Chaos list](evidence/r4-chaos.png), [Intercept editor](evidence/r4-intercept-editor.png).

During development:
- **XHR hold design falsified.** The first version stopped trusted XHR events with a capture listener at the target. A direct probe in Chrome 154 showed that page listeners added earlier still run first. Real-latency XHR then returned status 0 immediately. Replaced with the internal-XHR design above.
- **ID with a dot.** Chaos parameter inputs had IDs like `aw-chaos-fault.timeoutMs`, which `#id` selectors read as a class. Changed to dashes.
- **Fixture collision.** A new idempotent fixture endpoint first took over `/api/transfer`, which an R0 test uses as an echo path. It was renamed to `/api/idempotent-transfer`; the R0 test was not changed.
- **Test-side corrections.** Native `open()` legitimately fires `rsc1` before `loadstart`. A Blob type is the MIME essence. Unknown fixture `/api/` paths echo 200. An R1 resize assertion now rounds a sub-pixel auto height.
- **Behavior change.** One old R0 assertion expected a 204 mock with the default body; that combination is now refused at validation.

## Commands

```sh
AW_PORT=4320 AW_OTHER_PORT=4321 npm run verify     # tsc, build, core ×4 + Chrome ×5 spec files
AW_PORT=4320 node scripts/bookmark-experiment.mjs docs/evidence/r4-bookmark-chrome.json   # fixture must be running
AW_BROWSER=msedge …                                # same, for Edge once installed
```

## Deliberate R4 boundaries

- **Breakpoints** (request/response pause, queue, Continue all, deadline) are R5. Intercept rules have no breakpoint flags yet.
- **Replay** sends exact copies only. Re-preparing a signature, timestamp or nonce per attempt needs R6 signing preparation. Copies of an XHR are sent with `fetch` and say so. A body that cannot be resent (a stream, a Document) skips the copies with a reason.
- **Budget** counts *reserved* faults, at intake. A reserved real fault that later skips (for example, corrupt JSON on a non-JSON body) still used its hit.
- **XHR internal object.** When a response edit or real chaos applies, `xhr.upload` progress events are not forwarded, and the page sees one collapsed progress event. Without those rules, routed XHR keeps the page's own native object. Listeners there then see an extra OPENED `readystatechange` from the re-open.
- **XHR `credentials: omit`** cannot stop same-origin cookies; the route trace says so.
- **Real timeout** stops the page waiting; the request keeps running upstream and its late response is discarded.
- **Body conditions** read only string and `URLSearchParams` bodies of at most 1 MiB. A prebuilt `Request` body is not read for matching.
- **Linked rules** follow the endpoint's method, active-environment origin and path, with `{{…}}` as `*`. They do not follow its query or headers.
- **Editors:** a match preview against a sample request (S11.1) and choosing among several recorded samples per mock slot (S11.3) are not built. The patch builder appends only; editing is in the raw JSON.

## Remaining before R4 can close

- [ ] Manual bookmarks-bar drag and click of 2.0.0-r4 in Chrome. Then Edge: the same experiment and the R0 procedure.
- [ ] Edge run of every R4 browser case.
- [ ] CORS allowed/denied routing, and tester-driven (Once with rules) chaos/mock/intercept journeys.
- [ ] Constrained-viewport, zoom and screen-reader checks of the four editors.
- [ ] R0–R3 open items.
