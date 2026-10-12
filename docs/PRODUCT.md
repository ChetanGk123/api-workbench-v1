# Product contract

Status: proposed rebuild specification, preserving the confirmed v1 scope.

## Purpose and boundaries

API Workbench is a browser-local tool for testing and debugging an application's API traffic in the application's own desktop browser context. It launches from a saved bookmark, stays on the page, and lets a developer move from a captured or imported request to a saved endpoint, repeatable test and explicit page-traffic rule.

Target applications include complex banking and enterprise applications, not only simple request demos. Required representative behavior is defined in [COMPLEX_APPS](COMPLEX_APPS.md): authenticated multi-service calls, changing tokens, dependent workflows, explicit request-signing recipes, bounded polling and business assertions. App complexity must not be used as a reason to silently skip eligible operations; browser/security/representation boundaries remain explicit.

The normal journey is: launch → import/record/create → review → configure → send → inspect → derive a rule → enable the rule and activate its module → repeat a page action → inspect its outcome → export/save → stop/close.

Non-negotiable constraints:

- Full-inline bookmarklet for desktop Chrome and Edge. No runtime packages, external UI assets/fonts, backend, required extension or hosted code loader.
- Native DOM in one shadow root; supplied zinc theme and system fonts.
- One shared interception layer; separate fetch and XHR adapters.
- Browser-managed credentials and policies remain authoritative. New tester requests need explicitly configured bearer/CSRF headers; do not infer them from an application client.
- Calls made through the hooked APIs after launch, in the launch page and every same-origin frame (nested, added or navigated later; a frame's calls before it is hooked are missed). Cross-origin frames are unreachable from page script and are named in the UI, never implied. Cached references, workers, browser resource loads, navigation, beacon, sockets and event streams outside supported fetch/XHR behavior are not whole-tab capture.
- All listed v1 features remain in the release. Milestones control order, not scope.
- Imported code is data: no shell execution, `eval`, `new Function`, Postman scripts or arbitrary page function invocation.
- A user-requested update check may read the deployed version and bookmark text as data. This is not a runtime loader; the text is never executed or installed automatically. There is no passive update request.

## Feature ledger

Each row is a required user workflow. An implementation task and acceptance evidence must name its ID. A screenshot or enabled-looking control alone cannot close a row.

| ID | Feature | Required completion behavior |
| --- | --- | --- |
| P01 | Build/install/update | Standalone artifacts, size report, honest installer, saved-bookmark launch/relaunch, manual update cycle, no code/asset downloads |
| P02 | Shell/Home/launcher | Current frame/origin/version/profile, six modules, status/activity/history/quick actions, drag/resize, minimized active/paused counts |
| P03 | Lifecycle | Single instance, inactive startup, Stop all, owned cancellation, safe Close, restoration only while Workbench owns the wrapper |
| P04 | Endpoint editor | CRUD, display name and stable ID, alias/dependency references, origin mapping, method/path/query/headers, credentials, bodies, samples, checks, expression picker |
| P05 | Headers/environments | Global defaults, local overrides/removal, real header presets, common-header promotion preview, environments/host mappings |
| P06 | Once | Direct single endpoint, page-eligible session, request preview, cancellation, readable response/headers/checks, copy/sample/check actions |
| P07 | Plans | Save/rename/copy/delete, setup/load/skip, Flow and Independent, one-pass and repeated execution, iterations/concurrency/delay/ramp-up, failure policy, completion notice |
| P08 | Results | Progress, separate outcome categories, per-endpoint results, honest timing/statistics, response samples, history, JSON/CSV, rerun |
| P09 | Recorder | Start/Stop/Reset, future calls from the page and its same-origin frames, bounded/redacted capture, recovery as a draft, filter/select/edit/dedupe, promote into current/new profile |
| P10 | Import | Native schema, HAR 1.2, Swagger 2.0 JSON, OpenAPI 3.0 JSON, Postman 2.1, supported cURL dialects and literal fetch; file/paste, override, examples, reviewed transactional commits |
| P11 | Mock | Linked/ad-hoc rules, static/sequence replies, status/body/headers, bounded delays/faults, priority/conditions, atomic sequence reservation, explicit exhaustion, samples, hits/traffic |
| P12 | Intercept | Request/response headers and bodies, transactional JSON Patch, literal replacements, status override, conditions/priority, visible applied/skipped traces |
| P13 | Breakpoints | Request/response pause, edit/continue/abort, continue-all, deadline/cap, stale-rule visibility, minimized indicator, safe close behavior |
| P14 | Route | Original-origin/path matching, destination/path rewrite, query preservation, credentials/Authorization policy, conditions/priority, route preview and final destination trace |
| P15 | Chaos | Presets, endpoint/ad-hoc rules, synthetic vs real modes, fixed/random latency, HTTP/network/timeout/corruption/replay faults, probability/seed/hit budget/activation duration, bounded replay |
| P16 | Expressions/context | Built-ins and endpoint fields, safe grammar, dependency analysis, masked user-triggered source discovery, named bindings resolved at dispatch |
| P17 | Profiles/storage | Origin-scoped persistence, profile CRUD, atomic copy/merge/replace/backup, migration, redaction, recovery/export on save failure |
| P18 | Settings | Module visibility, bounded log/body/capture limits, recorder recovery/traffic inclusion, selected context roots, version/storage/build information |
| P19 | Explainability/accessibility | Stable navigation, dirty-draft protection, accurate labels/focus/status, consistent names, match/applied/skipped counters and actionable reasons |
| P20 | Release evidence | Chrome and Edge contract suite, genuine installation/restart/update, policy matrix, no runtime asset requests, payload measurements, full feature ledger |
| P21 | Complex application workflows | Banking-style session/token refresh, independent vs app-generated signing, guarded/polled dependent workflows, idempotency/cross-step assertions, multi-service diagnostics and G27 evidence |

Optional self-contained module-only builds remain an optional build recipe from the same source; they never replace the complete release or remove a required parser from the full build.

## Deliberate exclusions

No cloud accounts, collaboration backend, telemetry, remote parsing, proxy/CORS bypass, whole-tab extension capture, cross-origin frame instrumentation, arbitrary JavaScript execution or distributed performance claims. Postman environment files/YAML/remote references are not implicit in the declared format versions. Explain unsupported content rather than treating it as a successful translation.

## Defaults and important user choices

| Choice | Default / meaning |
| --- | --- |
| Launch | Modules and recorder inactive; saved rule enablement is not activation |
| Tester | Direct; active rules apply only when explicitly chosen |
| Credentials | Same origin for tester; intercepted calls retain caller choices unless an active rule changes them |
| New rules | Enabled on deliberate save, module remains inactive; preview names matcher and the enablement state. No implicit broad matcher |
| Synthetic reply | Does not dispatch upstream; a synthetic Set-Cookie cannot update the native cookie jar |
| Route | Blank origin means launch frame's origin; cross-origin Authorization is dropped unless the specific destination is explicitly allowed |
| Runs | One repetition/concurrency one, no automatic retries; preflight shows origins/request count/mutating steps |
| New-profile import | Creates and visibly switches to a new profile; outgoing profile remains available |
| Body/log export | Redacted by default; a separate explicit inclusion choice names sensitive fields |
| Missing input | Saved as visibly unresolved if valid as a template; blocks tester dispatch until resolved |

The enabled-on-save proposal unifies the current inconsistent new-rule defaults. It does not activate a module. An already active module makes this consequential: the save preview must say that the enabled rule affects subsequent matching calls immediately, and allow saving disabled.

## Screen traceability

| Supplied screen | Rebuild requirements |
| --- | --- |
| index | P01/P20 public guide and installation; development screen index stays separate |
| home / Minimized | P02/P03/P19 |
| Endpoints / EndpointEdit | P04/P05/P16/P19 |
| Import | P09/P10/P17/P19; retain every specified file/paste/record/control path |
| Test / Results | P06/P07/P08/P16/P19 |
| Mock / MockRule | P11/P19 |
| Intercept / InterceptRule | P12/P13/P19 |
| Route | P14/P19 |
| Chaos / ChaosRule | P15/P19 |
| Settings | P17/P18/P01/P19 |

Use the full original plan for finer reference requirements. Missing multipart/file bodies, credentials controls, header presets or Promote common are unfinished work, not accepted simplifications.

## Definition of release-ready

All P01–P21 workflows exist; every contract-required gate is PASS with artifacts and exact versions; a representative new user completes the normal journey without source editing; the banking-style G27 fixture passes; native pass-through and teardown preserve browser behavior; all skipped operations have reasons; migration preserves references; full bookmark installation is measured in both target browsers. NOT RUN and FAIL gates prevent a completion claim.
