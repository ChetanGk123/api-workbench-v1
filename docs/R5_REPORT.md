# R5 breakpoints: clean rebuild, 11 October 2026

**Status: implemented; verification incomplete. R5 is not complete.** All 190 counted tests pass in Chrome 154. That is 83 pure tests (71 earlier + 12 new) and 107 browser tests (91 from R0–R4 + 16 new R5 cases). Not run: Edge, real zoom, a screen reader, tester-driven pauses (Once with rules), and the manual bookmarks-bar click. The R0–R4 open items are still open.

As in R0–R4, this is from-scratch code.

## Environment and artifact

macOS 26.6.2; Node v24.21.0; TypeScript 7.0.2; esbuild 0.28.2; Playwright 1.63.0; Google Chrome 154.0.8037.99. Fixture ports 4320/4321, using this repository's own fixture server.

| Artifact `2.0.0-r5` | Measured | Change from R4 |
| --- | ---: | ---: |
| Readable IIFE | 437,018 bytes | +29,974 |
| Minified IIFE incl. CSS | 283,476 bytes | +19,358 |
| Encoded `javascript:` URL | 414,904 characters | +28,862 |

Minified SHA-256 `c86b5bddc75c545d6be649945459e60370bdecf2974c8a55b19de9a38a42e337`; bookmark SHA-256 `92d9681bd79a93d1e01d22953169cfaa5f4e19fc6b2472e14a4bcf39b91a27bc`. Full record: [evidence/r5-sizes.json](evidence/r5-sizes.json). The bookmark is 27% of the 1.5 MiB working ceiling measured in R4.

## What changed

| Area | Behavior |
| --- | --- |
| Data (`src/data/schema.ts`) | Intercept rules gain `breakRequest` and `breakResponse`. If R4 data has no flag, it loads as `false`, so no migration is needed. A rule that only has a breakpoint is valid. A rule with no change and no breakpoint is refused. A flag change counts as an action revision. |
| Planner (`src/net/plan.ts`) | New operation parts `request-pause` and `response-pause`. Both are selected only when the provider is the real network. With a mock or synthetic chaos provider they are *superseded*, and the reason says there is no server call to pause. Synchronous XHR is skipped, as before. |
| Pause registry (`src/net/runtime.ts`) | One owner for every pause. Each held item is a frozen copy of what would be sent or delivered: URL or status, headers, and body text or the reason the body is metadata only. It also records the rule ID, the rule revision and the config revision. The deadline timer lives here, so opening, editing or minimizing cannot reset it. The first decision wins: Continue (with a validated edit), Continue original, or Abort. When the 30 s deadline expires, the original continues. A caller abort rejects with the caller's own reason. Close (`settleAll`), Stop all and a profile switch continue the original. A later decision gets "already ended: …" back. Over the 20-pause cap, the request is not paused and its record says why. An invalid edit (non-http(s) URL, forbidden or invalid header, status outside 200–599, Set-Cookie, body over 1 MiB) is refused, and the pause stays waiting. The latest 20 ended pauses stay available for inspection. |
| Fetch adapter | Request pause comes after route and request edits and before the real-chaos pre-delay. The pre-delay moved after preparation; nothing observable changed for R4 rules. Continue original with no other change sends the caller's own arguments. An edit builds one changed request. Abort rejects with `AbortError`, and nothing is sent. If the request cannot be prepared, the pause is *locked*: it can be continued or aborted, not edited. Response pause is the last step, after transforms and real chaos. Text bodies are read from a bounded clone. Continue rebuilds the response only if something changed. Abort cancels the body and rejects. An opaque response is locked. |
| XHR adapter | Any breakpoint uses R4's internal native XHR, so the page's object sees one event sequence. For a request pause, the internal XHR is not even opened until a decision. Edits change its URL, headers or text body. A response pause holds the final reply before any page event; bodies other than text or JSON are metadata only, and the native typed body is delivered unchanged. The page's `abort()` and its own `timeout` keep counting during a pause and win over it. |
| Workspace (`src/ui/pauses.ts`) | You reach it from the paused indicator (title bar or launcher), the Intercept screen's queue card, or a request's details. It has: a queue with method, held path, transport/stage and seconds left; and per-pause drafts kept by ID, so new arrivals and ticks never rebuild the editor. The selected pause shows original and held URL, rule/revision/config, caller state, deadline, and a stale-rule notice when the rule is edited, disabled or deleted, or Intercept is deactivated (the held item is not changed). Request edits are URL, headers and body. Response edits are status, headers and body. Sensitive header values are hidden until "Show sensitive values". Signature-like headers get a not-re-signed warning. Continue all unchanged takes one snapshot of the queue. A pause that ended becomes a read-only record with its outcome. An editor that was open is kept aside and comes back on Back. |
| Editor and lists | The Intercept editor has a Breakpoints section with both flags; it explains real-only, the cap, the deadline, and that a response pause has the final say. Rule summaries say "breaks on request + response". The launcher, title bar and footer show the paused count. Stop all is shown while anything is paused. |

## Gate ledger (scoped; not whole-gate PASS)

| Gate / portion | Result | Evidence and boundary |
| --- | --- | --- |
| G11 pre-dispatch zero hits | PASS (Chrome, both transports) | Zero hits while paused, then exactly one. Abort sends nothing. |
| G11 final response override | PASS (Chrome) | Fetch status 418 + Unicode body edit, one hit. XHR response Abort fires abort events while the upstream hit stands. |
| G11 continue / abort / all / deadline / cap | PASS: Chrome for continue, abort, Continue all and the 30 s deadline while minimized (29–40 s window); pure test for the cap | Continue all: three held, each sent once; a later arrival stays queued. The cap is pure-tested only; 21 parallel browser requests were not run. |
| G11 stale snapshot | PASS (Chrome) | A rule edited while paused shows the notice; the held header is delivered unchanged. |
| G11 exactly-once / caller cancel wins | PASS (pure + Chrome) | A second decision is refused. Caller abort on fetch and XHR ends the pause as cancelled, with zero hits and native-shaped events. An ended selection shows no controls. |
| G11 minimized / close | PASS (Chrome) | Close at the request stage sends the original once. Close at the response stage delivers the original. Stop all continues held work. The launcher pause button is keyboard reachable. Opening a pause keeps an unsaved editor. |
| G03 lifecycle (pause portion) | PASS (Chrome) for close during pauses and minimize/restore with pauses | Profile switch release is implemented but not browser-tested. Later-wrapper ownership is unchanged from R0 and was not re-run with a pause held. |
| G06 binary (pause portion) | PASS (Chrome) for an arraybuffer XHR response pause: metadata only, bytes identical to native, same event trace | A pause on a binary *request* body (shown as metadata) has no dedicated test. |
| Signing (COMPLEX_APPS) | Partial | Signature-like headers get a not-re-signed warning. Re-signing is R6. |

[Counted results](evidence/r5-automated.json): **190 expected, 0 unexpected, 0 skipped, 0 flaky**. Screenshots: [paused workspace](evidence/r5-paused.png), [Intercept editor breakpoints](evidence/r5-intercept-breakpoints.png), [launcher](evidence/r5-launcher.png).

During development:
- **Wrong wording.** The first version reused the form error helper, which announced "Not saved:" for a refused Continue. The workspace now has its own alert ("Not continued: …").
- **Back label.** Back from the workspace said "Back to Intercept" even when it returned to another editor. It now names the real destination.
- **Shared port.** Port 4310 was held by a Playwright test server from a sibling repository (`api-workbench`). The counted runs use 4320/4321 and this repository's fixture server.

## Commands

```sh
AW_PORT=4320 AW_OTHER_PORT=4321 npm run verify     # tsc, build, core ×5 + Chrome ×6 spec files
AW_BROWSER=msedge …                                # same, for Edge once installed
```

## Deliberate R5 boundaries

- **The method cannot be edited** at a request pause. Only URL, headers and text body can.
- **Non-text request bodies** (Blob, FormData, URLSearchParams, streams, binary) are metadata only. The URL and headers can still be edited.
- **XHR with a breakpoint** always runs on the internal native XHR. Upload progress is not forwarded, and the page's object stays at readyState 1 while a response is held.
- **Continue all** continues every waiting item unchanged. A draft on the selected item is not applied by Continue all.
- **Response pause** comes after real chaos. Chaos faults that end in a transport failure (network error, timeout) leave no response to pause, and the record says so.
- The countdown is display only and rounds up. The deadline is the runtime timer.

## Remaining before R5 can close

- [ ] Edge run of every R5 browser case, plus the R0 bookmark procedure for 2.0.0-r5.
- [ ] Tester (Once with rules) traffic held by a breakpoint, with Run Stop aborting it.
- [ ] Browser checks for profile switch with held pauses, the cap at 21 parallel requests, a binary request-body pause, and a later third-party wrapper installed while a pause is held.
- [ ] Constrained-viewport, zoom and screen-reader checks of the workspace.
- [ ] R0–R4 open items.
