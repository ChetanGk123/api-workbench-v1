# R6 expressions, plans and results: clean rebuild, 11 October 2026

**Status: implemented; verification incomplete. R6 is not complete.** All 213 counted tests pass in Chrome 154. That is 101 pure tests (83 earlier + 18 new) and 112 browser tests (107 from R0–R5 + 5 new R6 cases). Not run: Edge, real zoom, a screen reader, browser notifications with a granted permission, profile switch during a run, the stored-summary retention limit, and the manual bookmarks-bar click. The R0–R5 open items are still open.

As in R0–R5, this is from-scratch code.

## Environment and artifact

macOS 26.6.2; Node v24.21.0; TypeScript 7.0.2; esbuild 0.28.2; Playwright 1.63.0; Google Chrome 154.0.8037.99. Fixture ports 4320/4321, using this repository's own fixture server (4310 is still held by the sibling `api-workbench` repository's server).

| Artifact `2.0.0-r6` | Measured | Change from R5 |
| --- | ---: | ---: |
| Readable IIFE | 597,785 bytes | +160,767 |
| Minified IIFE incl. CSS | 384,378 bytes | +100,902 |
| Encoded `javascript:` URL | 563,822 characters | +148,918 |

Minified SHA-256 `9a2ea0e20d49a9db5cc2cf2c030a65d87b8832827cfc48a367cfe145c44faea8`; bookmark SHA-256 `7c558aa5cfd8d57f9c9ba48eef760d4f684999cf6c10697202405cb92b722854`. Full record: [evidence/r6-sizes.json](evidence/r6-sizes.json). The bookmark is 36% of the 1.5 MiB working ceiling measured in R4. The larger artifact has not been through the saved-bookmark procedure.

## What changed

| Area | Behavior |
| --- | --- |
| Data (`src/data/schema.ts`, `store.ts`) | Still schema 2, additive only. New `bindings` (named page sources; absent in R2–R5 data = none). Sources gain `dom` with an explicit read mode (`value`, `text` or `attr:<name>`). Plans gain `rampStepMs` (absent = 1000) and `notify` (`off`/`panel`/`browser`; absent = `panel`). IndexedDB moves to version 3 and adds the `runSummaries` store: at most 20 summaries and 2 MiB, oldest removed first, in one transaction. Clear local data also clears it. Native merge adds bindings by name and keeps an existing one. |
| Expressions (`src/tester/expr.ts`) | Every TESTER form is parsed into a bounded tree and interpreted; nothing is evaluated as JavaScript. Limits: 512 characters, 16 path segments, 256 nodes, depth 16, 1000 expressions per request. Unknown built-ins, calls, assignments and `__proto__`/`prototype`/`constructor` fail with a reason. URL values are encoded as components. Header values with a line break are refused. Objects are never turned into text. In a JSON body, a token that is a whole value keeps its type and exact digits (`100.10` stays `100.10`; big integers stay exact). Numbers are kept as their source text through `JSON.parse` source access, and ordered comparisons use exact decimal comparison, never floating point. |
| Preparation (`src/tester/once.ts`) | Once, plan jobs, refresh and duplicates share one path. Generated values (`$uuid`, `$timestamp`, `$counter`, `$randomInt`) are reserved once per identical expression per preparation; re-preparing with the same reservation map repeats them. In Once, a producer reference blocks ("Once never reuses an earlier response"). An endpoint's auth context adds its headers from sources at dispatch, but only when the destination is the context's audience; otherwise the request is blocked. Missing or expired auth blocks, or asks for a refresh when one is configured. A signing recipe blocks when its session key is not loaded or the body is multipart. JSON checks now compare exact values. Every tester send uses `cache: 'no-store'` (see "Found during testing"). |
| Signing (`src/tester/sign.ts`) | HMAC-SHA-256 over the recipe's ordered components (method, path, query, SHA-256 of the exact body bytes, timestamp, nonce, named headers), with native Web Crypto. Keys are imported as non-extractable session keys and are never stored or exported. A fresh timestamp and nonce are reserved and the request is signed immediately before each transmitted attempt; logical values (body, idempotency key) do not change. |
| Auth coordinator (`src/tester/auth.ts`) | Only one refresh runs at a time per auth context; every waiter shares it. Its outputs are installed together into a transient overlay. The page's storage is not changed, and nothing is persisted. If any output is missing, nothing is installed. Each refresh has a deadline (100–5000 ms). A caller's abort releases only that caller. A profile switch discards a refresh that is still running. The newest value wins: if the page's own source changes after a refresh (for example, the app signs in again), the page value is used. |
| Graph and preflight (`src/tester/graph.ts`) | Builds a dependency graph from parsed references in the URL, query, global and endpoint headers, body, guards and assertions, and orders steps by it. It refuses: missing producers, a producer that is not a selected step, a step that reads its own response, setup that depends on load, a load step in Independent that reads another load step, cycles, polls on non-read-only methods, poll conditions on another step, and file parts in plans. It projects worst-case dispatches: primary plus polls, refreshes and read-only retries, with a 50,000 cap. It also lists destinations, writes with their idempotency header (or "no idempotency key"), shared-session warnings and the Apply-rules warning. Source values that are absent now are warnings, because they are read again at dispatch. |
| Scheduler (`src/tester/run.ts`) | Setup runs once. Its outputs are shared read-only, and a setup failure blocks load. Flow runs N iterations with C at a time; steps run in dependency order inside each iteration, and each iteration has a fresh context. Independent has one fair round-robin queue per endpoint and one global limit. Delay and ramp-up are applied per worker. Every dispatch, including polls and refreshes, takes an admission slot; a job waiting for a refresh releases its slot first, so there is no deadlock. Producer failure skips only dependents. A false guard gives `skipped-condition`; an unavailable guard value gives `skipped-dependency`. A read-only poll runs until its condition holds, up to its attempt cap and deadline; still pending at the end is `timeout`, never success. A plan step's idempotency key is new per logical operation and the same for that operation's own retries. One read-only retry after 401 runs only when the context enables it. A write is never retried, and the attempt says so. Cross-step assertions run after the step. The failure policy can be continue or stop. Stop aborts in-flight requests, ends delays and admits nothing more. Outcomes are the eight TESTER categories, and logical steps are kept separate from attempts. |
| Results (`src/tester/stats.ts`, `src/ui/results.ts`) | Shows progress, outcome tiles, and "N sent: network vs mock/synthetic, poll, retry, refresh, preflight bound". Per endpoint: pass, fail, not sent, errors, mean/min/max and nearest-rank P95 over at most 1000 retained samples, labelled when capped. Means are computed from totals. Unavailable values show as —. Steps can be expanded to show their attempts (kind, status, timing, queue wait, provider, idempotency key, signed, request #) and assertions. The last response per endpoint is kept, with sensitive headers removed and token-like JSON keys masked; Save sample and Save all target the endpoint by ID. JSON export contains identities, timing definitions, the redaction statement and dropped counts. CSV quotes cells and neutralizes formula prefixes in user text. Run again offers the retained snapshot or the current configuration when they differ. History includes stored summaries after a reload. |
| UI | Test has Once / Plans / Results and **Auth & context**. Plans is a draft workspace with the usual unsaved-changes decision: picker, New, Save copy, Delete, rename, strategy, mode, numbers (an invalid number shows "still using N" and is not applied), ramp-up, failure policy and notice. Steps have phase, order, a filter with bulk actions limited to what the filter shows, and options for guard, poll, idempotency header and assertions. Preflight is live. Run plan once and Run Load are disabled while the plan has unsaved changes or preflight errors. Auth & context holds bindings, an explicit scan, auth contexts (headers, expiry, refresh mappings, read-only retry, Refresh now) and signing recipes (session key, test vector). The endpoint editor gains auth-context and signing selects and an expression picker that inserts at the caret. Once shows auth and signing state and the generated values with Regenerate, and adds Send again (same values) and Once history. The title bar and launcher show RUN progress; Stop all also stops runs. Completion shows an in-panel notice with View run. |
| Scan (`src/tester/scan.ts`) | Runs only when you press Scan, over the categories you select. Reads own data properties only: getters are never invoked and functions are skipped. Bounds: 40 per category, 200 in total, global depth 3. Storage access is inside error handling. Meta names that are not unique are reported. Values are masked, and scan results are not saved. Global values are discovery only. |
| Fixture (`tests/fixture/server.mjs`) | CRUD producer/consumer routes. A banking-style fixture with synthetic data: HttpOnly session, rotating XSRF cookie, short-lived bearer tokens with refresh (can be made to fail), accounts, quotes with exact decimal fees, signed idempotent transfers (HMAC check, freshness window, nonce reuse refused, CSRF rotation after each accepted write), pending→completed status, a PDF receipt, `?fail=` injection and `/__bank` state for assertions. |

## Gate ledger (scoped; not whole-gate PASS)

| Gate / portion | Result | Evidence and boundary |
| --- | --- | --- |
| G16 grammar, limits, no evaluation | PASS (pure) | Every documented form; unknown names, calls, prototype keys and each limit refused with a reason. The bundle guard still fails the build on any `eval(` call. The `$eval(` keyword text is allowed. |
| G16 sites and reservations | PASS (pure + Chrome) | URL encoding, header line break, JSON type and exact digits. One reservation per identical expression; counters in admission order; Send again reuses values; Regenerate makes new ones. |
| G16 DAG and preflight | PASS (pure + Chrome) | Cycles, setup on load, missing producers and own-response refs are refused in pure tests. In Chrome, Independent refuses a cross-load read and the Run buttons stay disabled. Worst-case counts include polls, refreshes and retries; the 50,000 cap is enforced. |
| G16 Flow / Independent / setup / Stop | PASS (pure + Chrome) | Flow plan built in the UI: setup once, three iterations with their own IDs, each fixture item created and read exactly once. Independent fairness and the global limit: pure. Stop with 20 jobs at concurrency 2: two aborted, no later hit, 18 not started. Ramp-up and delay: pure timing. |
| G17 accounting, statistics, export | PASS (pure + Chrome) | Nearest-rank P95, totals-based means and the capped flag: pure. In Chrome, CSV and JSON downloads agree with the fixture (7 passed, 7 network), formula prefixes are neutralized, and stored history survives a reload. |
| G17 rerun / sample save / retention | Implemented; NOT RUN in a browser | Run again (snapshot vs current), Save sample/all and 20 / 2 MiB retention have no browser case. |
| G23 context scan | PASS (Chrome) | Explicit categories, masked values, an absent root reported, a throwing getter not invoked (counter stays 0), a scanned cookie becomes a binding that is resolved and masked. Blocked-storage errors and the bounds have no dedicated case. |
| G27 session and dynamic tokens | PASS (Chrome) | HttpOnly session plus the bearer token from page storage. The second transfer reads the rotated XSRF cookie (0 rejections). No token or key in IndexedDB profiles or run summaries after reload. |
| G27 expiry under concurrency | PASS (pure + Chrome) | Pure: 6 simultaneous jobs → 1 refresh, all use the new token, a failed refresh blocks every waiter with its cause. Chrome: server-side expiry → read 401 → 1 refresh → retry 200; later writes use the refreshed token; a rejected refresh blocks dependents with no loop. Isolated audiences: pure only. |
| G27 transfer flow | PASS (Chrome) | Two iterations: accounts → quote (exact `total = 100.60`) → guarded, signed, idempotent transfer → status polled three times to completed (exact amount/total assertions) → receipt (PDF content-type). 2 logical transfers on the fixture. |
| G27 duplicate / uncertain response | PARTIAL (Chrome) | Once Send again: same key and payload, fresh signature → 1 logical transfer and 1 duplicate; a normal new Run gets a new key. No disconnect/lost-response fixture case yet; writes are never retried by design. |
| G27 signing | PARTIAL | Pure: canonical bytes and signature match a Node HMAC vector. Chrome: the fixture verifies every signed transfer (0 bad signatures), and a missing session key blocks with its reason. Stale or reused nonce, and edits by Apply-rules after signing, have no case. |
| G27 multi-service, binary/burst, failure matrix, boundaries | Partial / NOT RUN | Audience blocking is pure only. The receipt check covers content type, not typed bytes. The 401/403/409/422/429/503/malformed fixture switches exist but no run asserts each one. |
| G22 layout (R6 screens) | PASS (Chrome, 1000×1000) for no horizontal overflow on Plans, Results and Auth & context | Screenshots: [plans](evidence/r6-plans.png), [results](evidence/r6-results.png), [auth & context](evidence/r6-auth-context.png). Zoom, constrained height and a screen reader were not run. |

[Counted results](evidence/r6-automated.json): **213 expected, 0 unexpected, 0 skipped, 0 flaky**.

## Found during testing

- **Chrome serialized simultaneous identical GETs.** With concurrency 2, the second `/api/slow` request did not reach the server until the first finished, because of Chrome's HTTP cache lock. Every tester send now uses `cache: 'no-store'`. That also guarantees a plan never reuses a cached response.
- **A refreshed token hid the app's newer login.** After a refresh, the overlay kept winning even when the page had signed in again with a newer token, so Once sent an expired token. The overlay now remembers the page value from when it was installed and gives way when the page changes. There is a pure regression test.
- **Layout.** In plan steps, the name column collapsed to one character, and source key inputs were squeezed by the availability badge. Fixed, and checked with an overflow measurement.
- **Bundle guard.** The R0 check rejected the literal `$eval(` grammar text. The check now fails only on an actual `eval(` or `.eval(` call.

## Commands

```sh
AW_PORT=4320 AW_OTHER_PORT=4321 npm run verify     # tsc, build, core ×6 + Chrome ×7 spec files
AW_BROWSER=msedge …                                # same, for Edge once installed
```

## Deliberate R6 boundaries

- **Plans cannot attach files.** A multipart step with a file part fails preflight; use Once.
- **Timings** are queue wait, dispatch→headers and dispatch→end of the bounded body read. Breakpoint waits and injected delays are not separated: in Apply rules mode, network timings can include them, and mock or synthetic replies are counted separately.
- **Apply rules after signing.** A rule can still change a signed request, and Workbench does not re-sign it. The server will reject it; preflight warns that rules can change requests.
- **Global roots** are discovery only; they cannot be bound.
- **The completion notice** does not restore a minimized panel. The launcher shows run progress, and View run opens it.
- **One run at a time.** Starting another run while one is in progress is refused with a message.
- **Producer fields in the picker** come from saved samples. They are suggestions, not proof of live values.

## Remaining before R6 can close

- [ ] Edge run of every R6 case, plus the R0 bookmark procedure for 2.0.0-r6 (the bookmark is now 564K characters).
- [ ] Browser cases for Run again (snapshot vs current), Save sample/all from Results, 20 / 2 MiB retention, profile switch during a run, browser notification with permission, and plan rename/copy/delete/filter/reorder.
- [ ] G27 rows still partial: lost response/disconnect, stale nonce and Apply-rules edits after signing, isolated audiences in a browser, typed binary receipt bytes, multi-origin routing and the full 401/403/409/422/429/503/malformed matrix.
- [ ] Constrained-viewport, zoom and screen-reader checks of Plans, Results and Auth & context.
- [ ] R0–R5 open items.
