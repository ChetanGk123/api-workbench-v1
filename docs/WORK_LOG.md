# Work log

## 11 October 2026 — Installer reference refinement

Revised the installer using [the supplied public page](https://chetangk123.github.io/api-workbench/) as visual inspiration: illustrated hero with install/copy actions, feature grid, separate illustrated setup, and an explicitly labelled empty-state example. Kept the existing FAQ, generated metadata and full-inline artifact. Both copy buttons share feedback handling; clipboard refusal opens the manual installation text. No dependencies or runtime changes.

PASS: `npm run typecheck`, `npm run build`, `AW_PORT=4330 AW_OTHER_PORT=4331 npx playwright test tests/release.spec.ts --project=chrome --grep 'installer:'` (1 counted test), and `git diff --check`. Checks cover both copy buttons, refusal fallback, keyboard navigation, exact artifact and 320–1440px layouts. Reviewed desktop/mobile screenshots and the live local page; preview saved as `test-results/installer-preview.jpg`. Artifact sizes remain 451,315 minified bytes and 495,335 bookmark characters. NOT RUN: full regression suite, Edge, real bookmarks-bar drag and screen readers.

## 11 October 2026 — Installer page recreation

Recreated the generated installer in `scripts/build.mjs` using the existing zinc palette and system fonts: responsive hero/install card, draggable full bookmark, manual-copy disclosure, module cards, first-session workflow, FAQ and generated artifact details. No dependencies or runtime changes. Updated the installer case in `tests/release.spec.ts` for the manual disclosure, exact copied payload, clipboard refusal, keyboard skip navigation and seven viewport widths (320–1440px). Desktop/mobile screenshots are in `test-results/installer-desktop.png` and `test-results/installer-mobile.png`; historical R8 evidence is preserved.

PASS: `npm run typecheck`, `npm run build`, `AW_PORT=4330 AW_OTHER_PORT=4331 npx playwright test tests/release.spec.ts --project=chrome --grep 'installer:'` (1 counted test), and `git diff --check`. Build: 451,315 minified bytes; 495,335 bookmark characters. Reviewed both screenshots. Default port 4310 was left running; the test owned temporary fixture ports 4330/4331. NOT RUN: full regression suite, Edge, actual bookmarks-bar drag and screen readers. Existing release gates remain open.

## 11 October 2026 — R8 release and replacement

Continued the in-progress R8 working tree. Delivered effective Settings/About/update controls, installer/deployment/rollback guidance, a full feature/gate ledger, migration and banking journeys, recorder/update cleanup fixes, durable Results rerun/sample/retention assertions and bounded resource probes. Reused the existing native UI, schema/store/recorder, transport and fixture paths; added no dependencies.

Locked offline install, strict types and standalone build checks pass. Exact counted totals, sizes/hashes, bookmark/restart/policy/update observations and environment blockers are in [R8_REPORT](R8_REPORT.md) and its linked JSON evidence. `npm run verify` owns all counted core/Chrome cases; quota inability is an explicit skipped gate, not release success. Default fixture port 4310 was occupied and left untouched; owned checks used 4330/4331 and 4340/4341.

R8 implementation is delivered; release remains incomplete. Edge installation/signature checks failed, quota override was not enforced, and native update/restart, drag, human accessibility and long-idle/input/stream-buffer acceptance remain open. No public deployment or production bookmark replacement occurred.
