# Public guide and installation screen

Reference: [index.html](../../../design/reference/screens/index.html) plus generated installer. Features P01/P20; gates G01/G02/G24/G26; slices R0/R8. Read [PRODUCT](../PRODUCT.md), [VERIFICATION](../VERIFICATION.md) and [MIGRATION](../MIGRATION.md).

## What this screen should do

Explain the tool in a short concrete journey, show current build/version and full-inline delivery, and provide a real draggable bookmark link. Explain bookmark bar installation, manual complete-URL paste, navigation/reload launch, uninstall/Close and manual update. Show measured minified bytes/URL length with artifact identity. Offer the local playground/OpenAPI guide when the fixture exists, with no claim that it is a required runtime service.

Keep a separate development reference-screen index. The public guide describes the real shipped modules/import versions and browser limits, including current-frame scope and complex-app support gates. It is a self-contained HTML artifact with embedded assets/system fonts.

## What it should not do

No hosted script loader, runtime dependencies, universal bookmark-size claim, automatic bookmark replacement, or claim that clicking a link on the installer proves saved installation. No invented feature screenshots represented as evidence. No silent clipboard write/download; copy buttons require a user action and feedback. Do not advertise a parser or banking readiness before its corresponding gates pass.

## Task S01.1 — Build the self-contained guide and installer

**Suggested model:** GPT-6 Luna. **Effort:** medium. **Why:** bounded static layout/content once build contract exists. **Status:** NOT STARTED. **Depends on:** R0 generated artifact/encoding.

1. Reuse existing build/showcase generation and zinc assets; render version/size from build metadata, not manually typed constants.
2. Place one primary install link with full encoded payload and explicit drag instructions. Offer a separate complete bookmark-text/manual path.
3. Include first-use choices Import/Record/Create endpoint, brief module descriptions and truthful format/version/scope help.
4. Add native FAQ/disclosures, keyboard skip link and copy feedback; avoid external fonts/images/scripts.
5. Ensure responsive prose and intentionally scrollable format comparison without page-wide overflow.

**Accept:** installer link matches bookmark artifact; no external page assets; links/FAQ/keyboard work; 390px/desktop layouts readable; generated version/size matches build.

## Task S01.2 — Verify saved bookmark installation and persistence

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** browser UI evidence differs from injection tests. **Status:** NOT STARTED. **Depends on:** S01.1 and R0 transport.

1. Follow the exact VERIFICATION saved-bookmark procedure on the generated candidate, recording drag vs paste path.
2. Navigate away from installer to fixture and click actual saved bookmark; record version/URL retention, double launch, reload and browser restart.
3. Run exact policy probes and enlarged inert payload experiments; keep original policy names/content.
4. Repeat Chrome/Edge, preserving screenshots/artifact hash/versions. If automation cannot perform a step, mark NOT RUN with manual procedure.

**Accept:** real installed candidate launches/relaunches in both target browsers; one instance; unchanged page requests; measured URL size retained for each path. Injected launch remains separately labelled.

## Task S01.3 — Document and verify the manual update journey

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** artifact/version consistency and clipboard/browser-policy failures. **Status:** NOT STARTED. **Depends on:** S18.3 and release deployment artifacts.

1. Publish version metadata and full bookmark text together; verify matching version/hash.
2. Keep the current bookmark running during Check/Copy. Copy new text only after validation; do not execute it.
3. Show exact edit-bookmark URL, reload and relaunch steps; confirm actual running version changes after replacement.
4. Exercise stale/malformed/refused metadata, mismatched bookmark, clipboard refusal and installer re-download.

**Accept:** copy success never says Installed; complete paste/reload/relaunch is observed on Chrome/Edge; update check is data-only and user-triggered.
