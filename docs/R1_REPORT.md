# R1 shell and explanations: clean rebuild, 11 October 2026

**Status: implemented; verification incomplete. R1 is not complete.** All 75 counted tests pass in Chrome 154 (21 pure, 41 R0 browser regressions, 13 new R1 browser cases). Saved-bookmark installation, Edge, real browser zoom, browser restart and screen-reader checks are **NOT RUN**. R0's open gates (see [R0_REPORT](R0_REPORT.md)) are still open; R1 does not close them.

As in R0, this is from-scratch code in this repository. Nothing was copied from `api-workbench` or `rebuild/v2`; the [history R1 report](history/R1_REPORT.md) was read for scope only.

## Environment and artifact

- macOS 26.6.2; Node v24.21.0; TypeScript 7.0.2; esbuild 0.28.2; Playwright 1.63.0; Google Chrome 154.0.8037.99. Edge is not installed.
- Tests ran on fixture ports **4320/4321** (`AW_PORT=4320 AW_OTHER_PORT=4321`). An earlier fixture process was already listening on 4310 and was left running.

| Artifact `2.0.0-r1` | Measured | Change from R0 |
| --- | ---: | ---: |
| Readable IIFE | 96,994 bytes | +13,955 |
| Minified IIFE incl. CSS | 67,372 bytes | +8,982 |
| Encoded `javascript:` URL | 96,404 characters | +13,192 |

Minified SHA-256 `369f67fc0a347d4c28ee30246812dc93cccda0372082ac51992014682b03d7e8`; bookmark SHA-256 `7b1b6db84ed17b233e6c2bd457f68e9e2c27ac70374ecd18da384c3395a71abc`. Full record: [evidence/r1-sizes.json](evidence/r1-sizes.json).

## What changed

| Area | Behavior |
| --- | --- |
| Geometry (R0 carry-over) | `src/ui/geometry.ts` validates stored values (finite and in range; size at least 320×240) and clamps the visible surface to the viewport on launch, on minimize/restore and on window resize. You can drag the title bar, or use the native CSS resize grip. The logo is a **Move panel** button: arrow keys move the panel 16 px, Shift+arrow resizes it. Panel position, panel size and launcher position are stored separately in the host origin's `localStorage` under `api-workbench:geometry:v1`. They are written only after a move or resize, and a viewport clamp never overwrites them. If storage throws, the change is announced as session-only. |
| Navigation and return context | All six module tabs stay mounted on every screen, including editors, Endpoints/Import/Settings and request detail. An editor or detail view records where it was opened (screen, main scroll, list scroll, focused row key). Back is labelled with that destination (**Back to Home**, **Back to Mock**…), restores scroll and focuses the originating row or card. After a save, focus goes to the saved rule when the list is shown. Below 440 px of panel width, tab labels are hidden visually but keep their accessible names. Nothing writes host URL, hash or history. |
| Drafts | Back, Cancel, Escape, tab navigation, title-bar Close and **launcher Close** all go through one Keep editing / Discard / Save decision. Launcher Close restores the panel first, so you can see the draft you are deciding about. A failed save stays in the editor. Back from request detail keeps an open Route draft. |
| Home cards (S02.1 R1 portion) | One primary action, chosen from state: **New rule** (opens the editor, returning to Home), **Activate**/**Deactivate**, or **Manage rules** when the only rule is disabled. Card text keeps rule state and module state separate, for example *1 enabled rule · Module inactive: traffic unaffected*. |
| Activity and request detail (S02.2/S21.1/S21.2 R1 portion) | Rows open one record by its stable ID. Home activity has a filter (method/path/outcome/effect) that persists across detail visits. The detail view shows a one-line summary (e.g. *Applied route · Skipped intercept · XHR arraybuffer · routed URL sent*) and an Overview (source frame, transport/responseType, original vs effective URL, outcome with "observed, includes Workbench waits; not server time", and the config revision captured at intake). **Why** lists each operation's state, rule name and reason, plus `+N ms` when the state changed. Bodies/headers are explicitly not captured. An evicted record says it is no longer retained; it never shows a different request. Opening detail sends nothing. Updates while open re-render only when that record changes. |
| Engine | The planner attaches a readable rule identity to each operation (label, or `Method /path`). The runtime stamps the time offset at which each operation settled. Precedence and matching are unchanged. |
| Minimize/restore | Restore returns focus to the last focused control in the screen (e.g. the editor field being typed in). The launcher names the active modules or says *No modules active*. Stop all keeps the panel open and moves focus to the screen heading, because the Stop all button disappears. |

## Gate ledger (scoped; not whole-gate PASS)

| Gate / portion | Result | Evidence and boundary |
| --- | --- | --- |
| G22 navigation/Back/focus/drafts | PASS (Chrome, injected) | Every destination keeps tabs; Settings→Mock directly with no Home detour; editor from Home and from Mock return to their origin with focus; dirty Cancel/Back/launcher Close ask; host `location`, `history.length`, title, body DOM, body style and stylesheet count unchanged |
| G22 filter/scroll/caret under traffic | PASS (Chrome) | Filter value, main scroll and row focus restored after detail. Caret position and value unchanged in an editor field during a 40-request burst |
| G22 geometry | PASS (Chrome) | Pointer drag, native grip, keyboard move/resize; persisted and reapplied after reload; NaN/offscreen/oversized storage recovered; viewport shrink clamps; storage failure announced; launcher position separate |
| G22 constrained layout | PASS (emulated) | 360×420 viewport (about 200% zoom of 720×840): Close in view, no panel horizontal overflow, editor Save visible. **Real browser zoom NOT RUN.** |
| G22 screen reader / Edge | NOT RUN | No assistive-technology pass; Edge absent |
| G03 R1 lifecycle | PASS (Chrome, injected) | Relaunch while minimized restores one panel with the same draft and focus; Minimize keeps modules active (R0 case); Stop all keeps the panel; Close after Discard removes it. All R0 lifecycle cases still pass |
| G08 R1 diagnostics | PASS (Chrome) | Mixed arraybuffer route applied + intercept skipped with rule names and offsets; Mock supersedes Route (R0 case, now via detail); identical URLs with different IDs open their own records; evicted record explained |
| G02 saved bookmark for 2.0.0-r1 | **NOT RUN** | Automated launches inject the decoded artifact |

[Counted results](evidence/r1-automated.json): **75 expected, 0 unexpected, 0 skipped, 0 flaky**, 22.1 s. Screenshots: [Home](evidence/r1-home.png), [mixed-outcome detail](evidence/r1-detail.png), [360×420 editor](evidence/r1-constrained.png).

During development, three first-run failures were in the new geometry tests. Two came from the panel being near full viewport height, so the clamp correctly refused to move it down. I had also overridden the UX `100vh − 32px` max height by mistake; that is fixed, and the tests now move within the reachable range. The third was a race: the panel was measured before the window `resize` event ran, so the test now polls.

## Commands

```sh
AW_PORT=4320 AW_OTHER_PORT=4321 npm run verify   # tsc --noEmit && build && build+playwright (core, browser, shell)
npm run fixture                                 # installer at http://127.0.0.1:4310/install (or AW_PORT)
```

## Deliberate R1 boundaries

- Still one rule per module, page-session rules, and no profiles (R2). Home has no Record/Create endpoint first-use actions because those features do not exist yet (R2/R3). Showing them as dead buttons would break the "no fake handlers" rule.
- S02.3 (Run), S20.2 (pauses/notices) and S21.3 (Promote/Create rule/Replay/Copy) are not started. Detail has no copy/export control; its text is selectable.
- Timing shows the total observed time and when each operation settled. Native dispatch-to-headers and body-read lanes are not measured or claimed.
- Request records still store origin + path only. Paths and labels can contain application data; this is not a secret detector.
- Geometry is one localStorage key in the host origin. A page that clears its storage resets panel position; that is acceptable for a preference.

## Remaining before R1 can close

- [ ] Saved-bookmark run of 2.0.0-r1 in Chrome, then Edge: launch, drag/resize, reload (geometry restored), minimize with a dirty draft and relaunch, real 200% browser zoom, and a request detail after a routed arraybuffer XHR.
- [ ] Screen-reader pass of tabs, Back labels, dialogs and the detail view.
- [ ] R0's open items (saved bookmark, `npm ci`, resource profiling) are still open.
