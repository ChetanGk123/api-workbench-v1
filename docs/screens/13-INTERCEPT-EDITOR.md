# Intercept rule editor

Reference: [InterceptRule.html](../../../design/reference/screens/InterceptRule.html). Features P12/P13/P19; gates G10/G11/G22; slices R4/R5. Read [NETWORK](../NETWORK.md), [DATA](../DATA.md).

## Required controls

Identity/link/matcher/conditions/priority/enablement; Break on request/response; distinct Request transform and Response transform regions. Each supports set/remove headers, JSON Patch builder/Raw JSON and literal body find/replace first/all. Response additionally supports legal status override; blank preserves original. Patch actions include Add/Remove/Replace, convenience Nullify, and supported move/copy/test through validated raw/builder forms.

Load patch/sample fields uses selected endpoint sample as a suggestion, not a live value. Show ordered operations, paths and a local preview over sample data with transactional success/failure. Save compiles validated operations; sample preview must perform no network action. Request signing impact is visible where configured.

Must not mutate original/sample while previewing, invoke eval, follow prototype paths, apply half a failed patch, keep stale content length/encoding after a rewrite, treat regex as literal replace feature, or make body unavailability disable eligible request headers/routes.

## Task S13.1 — Build shared matcher and breakpoint draft

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** linking and real/synthetic pause semantics. **Status:** PARTIAL: shared matcher/link/detach and save behavior built; breakpoint flags are R5 ([R4 evidence](../R4_REPORT.md)). **Depends on:** S11.1 matcher component, S00.2, rule validation.

1. Reuse identity/link/exact-glob/conditions editor with independent draft and action revision.
2. Breakpoint flags explain pre-dispatch vs after-response, cap/deadline and synthetic-provider exemption.
3. Show enabled-save effect in active module and signature-invalidating request edits.
4. Save/Cancel/Delete with safe reference/snapshot behavior; Back label names Intercept list.

**Accept:** flags persist and create actual future pauses; editing linked method/path detaches explicitly; dirty Escape guarded; synthetic paths are not promised a server pause.

## Task S13.2 — Implement headers and transactional patch builder

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** ordered data edits and raw/builder parity. **Status:** IMPLEMENTED (raw JSON Patch plus an append-only builder; sample preview) ([R4 evidence](../R4_REPORT.md)). **Depends on:** patch/header validators.

1. Build request/response set/remove headers separately; reject forbidden request names and conflicting invalid fields.
2. Represent patch rows as ordered validated operations; Add/Remove/Replace/Nullify have explicit path/value; move/copy require from path; test failure aborts transaction.
3. Raw JSON edits parse into the same operation model; swapping modes never loses malformed unsaved text silently.
4. Sample-path picker uses own fields and provenance; apply preview to cloned data and display either complete result or failure.
5. Compile when saving, preserving order and prototype-chain guards.

**Accept:** failing operation leaves original value unchanged; __proto__/constructor paths blocked; raw/builder round-trip; sample Load sends nothing; request/response fields do not cross-wire.

## Task S13.3 — Implement body/status operations and capability feedback

**Suggested model:** GPT-6 Astra. **Effort:** high. **Why:** native fidelity/fallback and signing consequences. **Status:** PARTIAL: body/status operations and capability skips built; signing-impact display waits for signing preparation (R6) ([R4 evidence](../R4_REPORT.md)). **Depends on:** S13.2, body capabilities/adapters.

1. Literal replace specifies first/all, rejects empty ambiguous find and preserves exact text unless explicitly edited.
2. Response status blank preserves original; validate synthetic/reconstructed legality and bodyless combinations.
3. Drop stale encoding/length after rewrite and keep original native response on failed eligible transform when possible.
4. Explain streaming/binary/opaque/over-limit capability skips; request-only operations remain independently eligible.
5. Verify end-to-end header/body/patch/status and intentionally invalid-signature behavior with controlled fixtures.

**Accept:** binary skip reason visible; no body consumed for a no-op; status/error semantics native; failed patch never delivered half-applied; signed content edit is explicit rather than silently re-signed.
