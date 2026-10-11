# Screen-by-screen implementation tasks

Written 10 October 2026; updated 11 October. **Clean rebuild: R1 portions of S00.1–S00.3, S02.1–S02.2, S20.1 and S21.1–S21.2, and R2 portions of S03.1–S03.3, S04.1–S04.3, S07.1–S07.3 and S18.1–S18.2 are implemented with verification incomplete ([R1 evidence](../R1_REPORT.md), [R2 evidence](../R2_REPORT.md)); S22 has its R2 definition schema only; all other surface tasks are NOT STARTED.** Earlier rebuild/v2 R1 work is in [history](../history/R1_REPORT.md). Model assignments are recommendations for the developer/agent building the screen; the shipped Workbench does not call an AI model.

Read [the rebuild index](../README.md), [product scope](../PRODUCT.md), [UX rules](../UX.md) and the assigned screen before editing. The screen documents expand the contracts into concrete tasks; they do not replace NETWORK/DATA/TESTER/IMPORT_RECORDER or authorize silently changing their behavior. A task includes its connected domain work when necessary; rendering a functional-looking control is insufficient.

## Index

| Surface | Detailed task document | IDs | Main slice |
| --- | --- | --- | --- |
| Shared shell/navigation/dialogs | [00 Shared shell](00-SHELL.md) | S00.1–S00.3 | R1 |
| Public guide/installer | [01 Installation](01-INSTALL.md) | S01.1–S01.3 | R0/R8 |
| Home | [02 Home](02-HOME.md) | S02.1–S02.3 | R1/R6 |
| Endpoints/header/environment management | [03 Endpoints](03-ENDPOINTS.md) | S03.1–S03.3 | R2/R6 |
| Endpoint editor | [04 Endpoint editor](04-ENDPOINT-EDITOR.md) | S04.1–S04.3 | R2/R6 |
| Import and import review | [05 Import](05-IMPORT.md) | S05.1–S05.3 | R3/R7 |
| Recorder and promotion review | [06 Recorder](06-RECORDER.md) | S06.1–S06.3 | R3 |
| Test: Once endpoint | [07 Once](07-ONCE.md) | S07.1–S07.3 | R2/R6 |
| Test: plans/Load | [08 Plans](08-PLANS.md) | S08.1–S08.3 | R6 |
| Results/history | [09 Results](09-RESULTS.md) | S09.1–S09.3 | R6 |
| Mock list | [10 Mock](10-MOCK.md) | S10.1–S10.3 | R4 |
| Mock editor | [11 Mock editor](11-MOCK-EDITOR.md) | S11.1–S11.3 | R4 |
| Intercept list/log | [12 Intercept](12-INTERCEPT.md) | S12.1–S12.3 | R4/R5 |
| Intercept editor | [13 Intercept editor](13-INTERCEPT-EDITOR.md) | S13.1–S13.3 | R4/R5 |
| Paused request/response workspace | [14 Breakpoints](14-BREAKPOINTS.md) | S14.1–S14.3 | R5 |
| Route list/editor | [15 Route](15-ROUTE.md) | S15.1–S15.3 | R4 |
| Chaos list/presets | [16 Chaos](16-CHAOS.md) | S16.1–S16.3 | R4 |
| Chaos editor | [17 Chaos editor](17-CHAOS-EDITOR.md) | S17.1–S17.3 | R4 |
| Settings/profiles/backup/update | [18 Settings](18-SETTINGS.md) | S18.1–S18.3 | R2/R8 |
| Context sources/expression picker | [19 Context](19-CONTEXT.md) | S19.1–S19.3 | R6 |
| Minimized launcher | [20 Minimized](20-MINIMIZED.md) | S20.1–S20.3 | R1/R5 |
| Shared request details/diagnostics | [21 Request details](21-REQUEST-DETAILS.md) | S21.1–S21.3 | R1/R4/R6 |
| Auth/signing configuration | [22 Auth and signing](22-AUTH-SIGNING.md) | S22.1–S22.3 | R2/R6 |

These 23 surfaces cover all 16 supplied HTML references plus required supporting workflows. Test.html is split into Once and Plans; Route.html's embedded rule editor remains in Route; index.html becomes the public install/guide plus a separate development-only reference index. Recorder, breakpoint, request-detail and auth/context workspaces are necessary product surfaces even where the original reference has no separate HTML file. A multi-slice screen is not fully complete when only its early layout/controls exist; later integration tasks retain their prerequisites and gates.

## Model and effort policy

Recommendations below are my task-specific judgment, not benchmark results or guaranteed task success. Availability depends on the user's Codex/model picker. Official sources checked on 10 October 2026:

- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol): recommended default for implementation involving several connected parts. Use **medium** for ordinary screen work and **high** when state/validation/races are central.
- [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra): recommend **high** for the most demanding transport/auth/scheduler/migration reasoning. If unavailable, use Sol high and retain the same gates.
- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna): recommend **medium** for bounded static content or presentational tasks whose state contracts are already established.
- The [official selection guide](https://developers.openai.com/api/docs/guides/model-selection) recommends evaluating on representative work. The [reasoning guidance](https://developers.openai.com/api/docs/guides/deployment-checklist#set-up-reasoningeffort) treats effort as model-dependent; these models support the medium/high settings used here. Do not default everything to xhigh/max; escalate only when a specific failed acceptance case benefits from it.

Each task specifies model, effort and why. Settings are for that future task; this documentation task does not switch models, create subagents or run model API calls. Choose one owner for shared engine/storage changes; a screen assignment is not permission to create another hook or duplicate domain logic.

## How to assign a task

Use this text with one exact task ID:

```text
Implement task Sxx.y in docs/rebuild/screens/<document>.md.
Read its prerequisite contracts and existing connected code first.
Preserve unrelated work. Keep the full-inline bookmarklet and zinc/native DOM UI.
Complete its domain integration and acceptance checks; do not add placeholder handlers.
Record changed files, exact commands, browser/tool versions, PASS/FAIL/NOT RUN,
limitations and next prerequisite task in docs/WORK_LOG.md.
Stop at the assigned task; do not mark a gate complete without evidence.
```

Start with [R0](../PLAN.md), not the entire screen directory. UI tasks depend on verified services. A development fixture can exercise deliberate failure states, but cannot be a hidden production-only shortcut.

## Definition of done for every screen task

1. Each named control performs its specified real action; invalid/busy/unsupported states explain why.
2. Native DOM/shadow/theme constraints hold; host URL, styles and keyboard behavior remain intact.
3. Dirty draft/return context/focus work; repeated renders do not erase inputs.
4. The connected domain command validates and records truthful persistence/network outcome; no UI-owned matcher/scheduler/parser copies.
5. Relevant fixture assertions, keyboard/layout inspection and a representative complex-app case pass. Meaningful tests belong to the behavior, not each trivial visual label.
6. Evidence names the artifact/version/browser and command; failing/unavailable gates stay FAIL/NOT RUN. Update the feature/gate ledger and work log.

All resource caps use [DATA](../DATA.md). All cancellation/teardown and supported-operation decisions use [NETWORK](../NETWORK.md). All complex-app examples use [COMPLEX_APPS](../COMPLEX_APPS.md). No task here turns a dummy 200, mock preview or import detection into proof of a working banking workflow.
