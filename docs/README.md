# API Workbench rebuild pack

Written 10 October 2026; updated 11 October. **Clean from-scratch rebuild in this repository: R0–R6 implemented, verification incomplete** (see [R0 evidence](R0_REPORT.md), [R1 evidence](R1_REPORT.md), [R2 evidence](R2_REPORT.md), [R3 evidence](R3_REPORT.md), [R4 evidence](R4_REPORT.md), [R5 evidence](R5_REPORT.md), [R6 evidence](R6_REPORT.md)). R7–R8 are unstarted here. Reports from the earlier `rebuild/v2` worktree are kept in [history/](history/) as evidence about that code only.

If I rebuilt this tool, I would keep its product and delivery model, replace its internal seams, and build it in tested vertical slices. The hard part is preserving browser behavior while making selected changes explainable. The UI and engine should share an explicit account of what matched, what actually changed, what was skipped and why.

I would use strict TypeScript, native DOM in one shadow root, the supplied zinc theme, IndexedDB, and one self-contained IIFE. Development tools can remain TypeScript, esbuild and Playwright. I would not introduce a UI framework, extension, server, hosted loader or general plugin framework.

## Read in this order

| Document | Use it for |
| --- | --- |
| [Product contract](PRODUCT.md) | Full v1 scope, feature IDs and requirements that cannot silently disappear |
| [Complex applications](COMPLEX_APPS.md) | Banking-style auth, signing, dependent transactions and a representative application release gate |
| [UX specification](UX.md) | Navigation, screen behavior, editor safety and readable network outcomes |
| [Screen-by-screen tasks](screens/README.md) | Detailed behavior/do-not rules, implementation steps, dependencies, acceptance checks and model/effort suggestions for 23 surfaces |
| [Architecture and decisions](ARCHITECTURE.md) | Code boundaries, ownership, state changes and technical decisions |
| [Network contract](NETWORK.md) | Pipeline, fetch/XHR capabilities, body ownership, cancellation and cleanup |
| [Data and persistence](DATA.md) | Durable entities, validation, transactions, migration and resource limits |
| [Import and recorder](IMPORT_RECORDER.md) | All import adapters, review/commit and bounded recording |
| [Tester and expressions](TESTER.md) | Request preparation, variables, scheduling, checks and result metrics |
| [Verification and release](VERIFICATION.md) | Fixtures, meaningful gates, evidence and installation/update testing |
| [Delivery plan](PLAN.md) | Ordered implementation slices and the first task to assign |
| [Reuse and migration](MIGRATION.md) | What to retain from this repository and how to replace it safely |

These are maintained specifications, not a second copy of the old work log. Each contract has one owner: product scope here and in PRODUCT; complex-app scenario/auth/signing extensions in COMPLEX_APPS; presentation in UX; transport semantics in NETWORK; durable structure/limits in DATA; parsing/capture in IMPORT_RECORDER; execution in TESTER; gates in VERIFICATION; sequence in PLAN. Link to the owning contract rather than duplicating a changing rule in several files.

## Authority and provenance

1. The user's latest instruction wins.
2. Existing [repository instructions](../../AGENTS.md) and the [original build plan](../API_WORKBENCH_BUILD_PLAN.md) retain their confirmed product constraints.
3. This pack is my recommended rebuild design. It does not retroactively declare the current implementation correct or complete, and it does not authorize starting a rebuild in this documentation task.
4. Preserve the [reference theme](../../design/reference/aw-theme.css) and [16 reference screens](../../design/reference/screens/index.html). Their controls are feature references, not an instruction to reproduce known navigation defects.
5. Use [the latest end-user report](../END_USER_TEST_REPORT.md) for current measured findings. Older [UX](../UX_REVIEW.md) and [readiness](../PRODUCTION_READINESS_REVIEW.md) reports are historical evidence, not automatically current defects.

Known ambiguities are resolved explicitly in the relevant documents: native imports as a new profile switch visibly to it; Once can send one endpoint while a separate Run plan once action preserves one-pass plan execution; request routing has a capability separate from body transformation; header presets/promotion and multipart are real v1 work; update checks read data only on a user action.

Complex applications are an explicit target, including a banking application being developed. Simple transport fixtures remain useful unit evidence, but a release must also pass the stateful authenticated [G27 banking-style journey](COMPLEX_APPS.md). Preserving app-generated requests and independently reproducing signed/authenticated requests are separate capabilities with explicit supported boundaries.

## What would be different

| Current pain | Rebuild choice |
| --- | --- |
| Binary XHR skips unrelated work without useful UI feedback | Operation-level capability checks; native binary request routing gate; visible skipped reasons |
| Large entry/UI modules own many unrelated jobs | Small domain modules connected by one composition root and typed commands |
| Editor navigation drops drafts or list position | Separate draft/view state; dirty-draft decisions; return destination and filter restoration |
| Configuration, transient activity and storage are intertwined | Durable profile aggregate, runtime registry and view state have separate lifetimes |
| Import detection can look like support | Adapter parse → normalized candidates → validation → review → durable commit; end-to-end fixture gates |
| Passing totals omit a failing Node test | One counted runner for core/browser assertions and a nonzero exit on any failed gate |
| Reference requirements have missing controls | Feature-ID coverage ledger; no v1 completion while a required workflow is absent |

## Builder working rules

- Read the assigned slice plus its contract and inspect existing code before editing.
- Start with [R0 in the delivery plan](PLAN.md). Do not scaffold every planned file first.
- Build a working slice, then verify it against controlled fixtures. Use the current browser APIs as the behavioral oracle for pass-through.
- Never weaken CSP/CORS, change distribution, skip a failing gate, or use console injection as proof of a saved bookmark.
- Keep unsupported operations visible. Keep unaffected native operations working. An unexplained fallback is a defect.
- Track byte/time/count limits, ownership, cancellation and disposal when introducing a resource.
- Keep runtime imports/assets absent. All parsers and styles must ship inline.
- Record changed files, exact commands, versions, PASS/FAIL/NOT RUN, measured sizes and limitations in the work log. A proposal is not evidence.

## Status of this pack

The preceding review observed a Chrome 154.0.8037.99 saved bookmark launching build 1.0.8. It also recorded 242 counted Playwright passes and a separate failing Node recorder test. That is evidence about the existing build only. Every rebuild slice and browser capability in this pack starts **NOT RUN** until its own tests and installation checks are recorded.

The current 279,493-byte minified bundle / 403,269-character generated bookmark is a comparison point, not a browser limit or a rebuild size promise. Edge, fresh installation, restart and update verification remain open. Details and reproduction commands live in the linked end-user report.
