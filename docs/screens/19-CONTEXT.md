# Page context, bindings and expression picker

Supporting workspaces entered from Test/endpoint editor/Settings. Features P16/P21; gates G16/G23/G22/G27; slice R6. Read [TESTER](../TESTER.md), [COMPLEX_APPS](../COMPLEX_APPS.md), [DATA](../DATA.md).

## Required behavior

Scan page has explicit source-category selection: readable cookies, local/session storage, meta tags, configured global roots and DOM form fields. Candidate rows show source/key/path, masked preview, availability/error and Select as binding. Binding editor has stable name/source/key/attribute/required status and context/audience ownership. Values refresh at dispatch; scan preview is not a persisted token snapshot.

Expression picker opens from an eligible input's current selection, lists exact built-in grammar, named bindings and producer sample fields, and shows dependency/phase/encoding/type impact before insertion. Selected output fields are suggestions, not proven live values. Restricted eval is explicitly limited and never general JavaScript.

Must not walk all window globals, invoke getters/functions, poll for secrets silently, read HttpOnly cookies, expose masked preview as actual sent text, infer a signing key from a captured signature, insert expression into unsupported binary data, or resolve a value from another job's last response.

## Task S19.1 — Implement bounded explicit source scan

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** browser-global safety, bounds and masking. **Status:** IMPLEMENTED; global roots are discovery only ([R6 evidence](../R6_REPORT.md)). **Depends on:** source reader with injected environment, DATA limits.

1. Build categories/configured-root controls and Scan/Cancel; do not scan on workspace mount.
2. Obtain storage/cookie/DOM access within error handling; safe own data descriptors/global depth/candidate count enforced.
3. Show source-specific failures/ambiguity and masked preview; retain selection without persisting discovered values.
4. Cancel invalidates publication from old scan; changing source configuration requires a new explicit scan.
5. Clear scan deletes transient previews only, not configured bindings.

**Accept:** throwing getter never invoked; blocked storage doesn't crash; bounds stop walking; scan exports no values; categories off not inspected.

## Task S19.2 — Build bindings and field insertion

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** site-specific escaping and dependent identity. **Status:** IMPLEMENTED; the picker lists built-ins, bindings and producer fields from saved samples ([R6 evidence](../R6_REPORT.md)). **Depends on:** S19.1, expression parser, S04/S08.

1. Save binding definitions with unique names, explicit source/selector/attribute and auth-context ownership; no current value stored.
2. Picker captures initiating field/selection and inserts chosen expression without losing input/caret on re-render.
3. Producer fields reference stable endpoint IDs internally, aliases externally; display required producer/phase and sample provenance.
4. Preview URL/header/text/whole-JSON insertion semantics and blocked invalid paths/prototype references.
5. Provide help/examples for every built-in and restricted eval; malformed syntax remains editable with location.

**Accept:** same generated expression reused once per preparation; alias rename updates real references; JSON number remains number; header line break rejected; no code executed.

## Task S19.3 — Verify fresh resolution and complex-app isolation

**Suggested model:** GPT-6 Astra. **Effort:** high. **Why:** dynamic auth and per-context outputs under concurrency. **Status:** IMPLEMENTED; verification partial (CSRF rotation and fresh bearer in Chrome; audience isolation pure only) ([R6 evidence](../R6_REPORT.md)). **Depends on:** S19.2, preparation/refresh/graph services.

1. Re-resolve selected sources before dispatch; missing/ambiguous source blocks with exact field/binding.
2. Fresh value updates stay in owning auth context/audience; setup outputs read-only and iteration/job references independent.
3. Regeneration/queued signature freshness follows preparation rules; replay logical values remain stable.
4. Fixture rotates CSRF/bearer, removes source, presents inaccessible key and shares concurrent URLs; inspect captured/exported artifacts for leaks.

**Accept:** current CSRF reaches server; wrong audience blocked; missing source not sent empty; no cross-job response reuse; key absent reports direct signing limitation while native app request works.
