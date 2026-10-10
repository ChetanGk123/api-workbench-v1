# UX and screen specification

Status: v1 UI contract, grounded in the supplied screens and the [end-user review](../END_USER_TEST_REPORT.md). In the clean rebuild only the R0 status panel exists ([R0_REPORT](R0_REPORT.md)); the workflows below remain specifications.

The detailed implementation assignments are in [screen-by-screen tasks](screens/README.md). This document owns shared UX rules; those task sheets expand individual screens and supporting workspaces, including model/effort recommendations.

## Navigation and shell

Keep the six primary modules: Home, Test, Mock, Intercept, Route, Chaos. Keep access to this navigation on Endpoints, Record, Import, Settings and Results as well. An editor adds a breadcrumb and a true return destination; it does not erase the product map. At constrained widths a clearly labelled Modules control can expose the same destinations.

The title bar holds identity/version, profile, frame origin/context, Import, Settings, Minimize and Close. Full origin can be available in a tooltip/disclosure; active profile must have a complete accessible name even when visually truncated. Use native select/listbox semantics for profile selection, not menu semantics for a value picker.

A persistent activity control exposes **Stop all** whenever a module, recorder, tester or pause is active. Stop all follows NETWORK's shutdown rules while keeping the panel open; Minimize does not stop work. A closed-looking panel must never hide active rules.

Proposed initial panel size: width 560px, height `min(760px, viewport height - 32px)`, clamped to the usable viewport. Preserve a compact approximately 480px mode from the reference. These sizes are design starting points, not measured improvements. Validate minimum, ordinary desktop and zoom layouts before choosing final defaults. Persist user geometry by origin; recover offscreen geometry when the viewport changes.

Header, navigation and editor actions remain reachable while the main content scrolls. Only code/table regions can scroll horizontally when needed; the whole panel must not overflow. Do not move or style the host application's elements. Normal panel interaction is non-modal and does not trap host-page focus.

## Visual rules

Reuse [aw-theme.css](../../design/reference/aw-theme.css) with its zinc tokens: `--aw-zinc-950` panel, `--aw-zinc-925` card, `--aw-zinc-940` code/footer, `--aw-zinc-800` border, `--aw-zinc-50` primary text and `--aw-zinc-400` muted text. Reuse 13px base/14px headings, native system/monospace fonts, inline SVG and the existing spacing/radius scale. No runtime font or stylesheet link.

Green means active/applied/passed; amber means pending/skipped/attention; red means failed/destructive; grey means inactive. Every color accompanies text or an icon with a label. Enabled rule and active module have separate labels: **Rule enabled** and **Module active**. A new rule preview names the affected request and says whether saving makes it effective immediately.

Use consistent action vocabulary: **New rule**, **From endpoint**, **Activate**, **Deactivate**, **Save**, **Cancel**. Endpoint rows use display name first, alias second, method/path nearby. Results and plan rows retain the same identity; alias never replaces the only readable name.

## Navigation and editor state

- View state retains filter, scroll and selected row on a return from edit/run/review.
- Back names and returns to the actual destination. An editor opened from Record returns to Record; Results returns to its run list/configuration context.
- Dirty drafts survive normal navigation or receive Keep editing / Discard / Save choices. Escape closes a menu/dialog first; in an editor it follows the same dirty-draft decision. It does not silently discard a name/body.
- Profile switch has a dirty-draft decision before stopping old work. Import preview is tied to profile ID and revision; changed destination requires a new review.
- Save validates before changing data and moves focus to the saved row. A returned row outside the filter gets a short explanation; do not clear the filter without permission.
- Deleting an endpoint previews affected linked rules, plans and dependencies. Delete and Clear stored data are distinct from deleting a draft row.
- Successful actions report concrete results, such as **3 endpoints added · 1 skipped · 2 need inputs**. A parse result is not a saved result.

## Screen contracts

| Screen | Primary path and essential states |
| --- | --- |
| Home | Three first-use actions: Import, Record, Create endpoint. Then module status/enabled rule counts/applied traffic, last run, quick actions and bounded activity |
| Endpoints | Searchable list with stable focus/position, display name/alias/method/path, Run/Edit/Delete/reorder, header/environment access, dependency impact |
| Endpoint editor | Identity; resolved destination preview; method/path/query; credentials; global/local headers; body kind including multipart/files; sample; checks; expression picker; fixed Save/Cancel |
| Test Once | Select endpoint; show effective origin/credentials/headers/body and Direct/rules mode; Run/Cancel; result body/headers/status/check reasons; copy/save sample/add check |
| Plan configuration | Saved plan actions; setup/load/skip and ordering; strategy explanations; bounds; projected count/origins/mutating steps; Run plan once / Run Load / Stop |
| Results | Progress/outcome breakdown, per-endpoint name+alias, network/synthetic timing separation, samples, history, JSON/CSV and repeat controls |
| Record | Start/Stop/time/count/bytes/scope; filter/select/dedupe/edit candidates; redacted/omitted reasons; Add to current profile or create new; explicit Reset |
| Import | Paste/file/format/help/record entry; Apply means preview; destination and counts; required values/conflicts/notes; final Import; draft survives cancel/failure |
| Mock | Enable rules and activate module independently; static/sequence/sample editor; slot cursor/exhaustion; applied traffic and skipped reasons |
| Intercept | Rule lists, operation editor and transactional diagnostics; request/response pause queue; continue/abort/continue-all; traffic with selected/applied/skipped actions |
| Route | Matcher and destination/rewrite preview; credentials/Authorization choices; original→final destination; responseType-related skip reasons |
| Chaos | Preset selects action then matcher/endpoint; synthetic/real impact; probability/budget/duration; replay makes primary+copy counts clear; fault outcomes |
| Settings | Profile/storage/backup, module visibility, per-resource limits, recorder recovery and context sources, version/update; no meaningless code-cache control |
| Minimized | Active module names, paused count, recording/run activity, Restore and true shutdown Close |

## Useful details beyond the reference

**Headers:** show inherited vs overridden/removed values. Presets insert data fields and never executable snippets. Promote common previews equivalent headers across selected endpoints, resulting global entry and local removals; commit together.

**Body editor:** never automatically reformat raw input while typing or merely importing. Format JSON is explicit. File fields show selected filename/size/type and unresolved imported file requirements. The browser supplies multipart boundaries. JSON/form/text kinds stay distinguishable.

**Expression picker:** available in path/query/headers/supported bodies; list built-ins, named bindings and previous endpoint sample fields. Show required producer/phase and escaped preview. A sample field is a suggestion, not a proven dependency. Alias rename previews and updates real parsed references.

**Rule matcher:** exact/path-pattern mode, origin and conditions are visible. Show a sample request and matches / does not match / condition cannot be evaluated. Do not open presets with a misleading `/api/` default and expect a user to infer wildcard semantics. If no endpoint exists, request a matcher explicitly.

**Request details:** from any activity/rule log open one record with original/effective URL, transport/response type, source/config revision, operations/reasons and timings. Example: **Skipped route · XHR arraybuffer · original URL sent**. Stable labels are more useful than a large raw debug dump.

**Complex flows:** expose service/audience, masked auth-context status, token binding source, signing recipe/freshness requirements and logical idempotency key in request preparation. Plan editing shows guard/poll limits and their worst-case requests. Results group attempts beneath their logical step while keeping each request ID inspectable; a pending/uncertain write never wears a completed-success badge. No key/token plaintext is needed to explain these states.

**Downloads:** show format, intended filename and Download requested; show success only when the implementation can actually know it. Offer copy/select text fallback for small content. Do not call a browser Save-sheet attempt a verified download. Exports needing secret inclusion have a preview before download.

## State messages

| State | Required UI behavior |
| --- | --- |
| Empty | Specific next action, not inert controls without explanation |
| Loading/parsing | Named progress; Cancel where owned work is cancellable; no duplicate submissions |
| Required value missing | Field-path/binding/producer name and configure action; request blocked |
| Skipped operation | Reason and original behavior; included in activity details and counts |
| Storage failure | Persistent Unsaved banner, Retry/Export, continued usable session |
| Import commit failure | Keep draft/review/selection; no success count; Retry/Export draft |
| Browser policy failure | Observed opaque failure and destination; do not offer a false bypass |
| Timeout/abort | Distinct outcome and source of cancellation; Stop prevents further scheduling |
| Changed rule while paused | Snapshot marked stale; current pause remains immutable until deliberate user edits |

## Keyboard and accessibility acceptance

Use native labels, inputs, buttons, select, details and dialog wherever suitable. Accessible names include full endpoint/rule context for repeated icon actions. Focus goes to the editor heading/first field on entry, the returned row on exit, and the previous control when a dialog closes. Back's label matches its target. Validation messages reference fields and appear in a status/alert region.

Keyboard reaches the panel promptly after launch, navigates primary tabs and dialog/menu choices, edits all fields and can restore/minimize/close. Do not install a shortcut that consumes unrelated host-page keystrokes; any optional shortcut is scoped or explicitly enabled with a collision check. No global Escape handler discards page or Workbench content.

Test visible focus, color-independent states, 200% zoom, constrained height, long names/paths, response text resize and large collections. Use the [verification gates](VERIFICATION.md); do not infer accessibility from the presence of ARIA alone.
