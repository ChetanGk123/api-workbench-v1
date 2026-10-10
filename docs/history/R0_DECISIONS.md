# R0 implementation decisions

10 October 2026. Implementation is isolated on `rebuild/v2` in
`/Users/chetangk/Developer/tools/api-workbench-rebuild`, based on `740782d`.

- Keep the existing product entry/build and origin storage. Add a minimal R0 entry and artifacts under `dist/rebuild/r0/`; these do not represent the full v1 product.
- Reuse the shared planner and native adapters. Fix request-only XHR routing on the original native object so typed responses, upload targets and browser terminal events remain native. Response editing is a separate capability; an unsupported binary edit must not cancel routing.
- Delegate unchanged Fetch invocations exactly. A URL + BodyInit route retains that body without inspection. Experimentally, forwarding a prebuilt Request body as a new stream failed over Chrome's HTTP/1.1 transport. Explicit routing of such bodies now uses a bounded preparation branch: 1 MiB, two seconds, four simultaneous preparations. Overflow/deadline/close cancels only that branch, reports a skipped route and delegates the preserved original Request once. This is request preparation for an explicit route, distinct from passive response observation.
- Observe only known-length, uncompressed text responses up to 16 KiB, with four concurrent readers and a two-second deadline. Unknown-length, encoded, binary and oversized responses receive metadata only. Close cancels observation branches, never the page's body. These conservative R0 limits are deliberate and will be measured.
- Retain the supplied zinc theme and native shadow DOM. No storage, update checks or later feature screens in the R0 entry. Share the legacy instance registry to prevent two workbenches stacking.
- Use Playwright for both pure and browser cases, including the seven previously uncounted Node cases. Parameterize fixture ports so R0 can run on 4193/4194 without replacing the user's server on 4173.

The evidence report will distinguish injected contract tests from actual saved-bookmark tests. R0 remains incomplete while required gates are FAIL or NOT RUN. Later slices remain separately assigned.
