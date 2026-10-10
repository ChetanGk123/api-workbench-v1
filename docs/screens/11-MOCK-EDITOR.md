# Mock rule editor

Reference: [MockRule.html](../../../design/reference/screens/MockRule.html). Features P11/P19; gates G08/G09/G22; slice R4. Read [NETWORK](../NETWORK.md), [DATA](../DATA.md).

## Required fields and behavior

Label, linked endpoint/ad-hoc choice, method/origin/exact-or-pattern URL, AND conditions/query/headers/body-contains, priority and Rule enabled. Linked method/path follow endpoint ID; manual edit previews detachment. Response mode is static or sequence with ordered slots: legal status/headers/body, bounded delay and explicit static/network-error/timeout fault. Sequence adds/reorders/removes slots and chooses loop/repeat-last/failure exhaustion.

Use recorded response previews exact sample/provenance and completeness; do not overwrite draft immediately. Body text may be non-JSON by content type; valid/invalid JSON is feedback, not automatic correction. Save/Cancel fixed; new enabled rule warns when its module is already active.

Must not allow impossible status/body combinations, manually update native cookie jar through mock headers, invent absent samples, broaden detached matcher secretly, make sequence fallback real traffic, or reset runtime cursor on every render.

## Task S11.1 — Implement matcher, linking and draft validation

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** link/condition semantics and safe effective save. **Status:** NOT STARTED. **Depends on:** S00.2, matcher validator/editor.

1. Bind rule draft/base revision; resolve linked endpoint by ID and show synced matcher.
2. Offer explicit exact/glob/origin mode and a sample request match preview, including condition-not-evaluated.
3. Edit conditions/priority/enablement with validated bounds and clear AND semantics.
4. On method/path change show detachment impact; Save commits only validated draft and affects future requests.

**Accept:** missing body cannot match by default; invalid glob/headers retains draft; detached matcher equals reviewed value; Back/Escape guard protects edits.

## Task S11.2 — Implement static and sequence responses

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** response legality and deterministic sequence configuration. **Status:** NOT STARTED. **Depends on:** S11.1, slot/response validators.

1. Build static/sequence slot fields with method/bodyless legality, content headers and UTF-8 feedback.
2. Add/reorder/remove slots while preserving stable slot identity; cannot save an empty sequence.
3. Show explicit exhaustion alternatives and no-server-fallback meaning; delays/timeouts use DATA finite bounds.
4. Separate fault response from HTTP error response; timeout/network fault has transport-specific behavior.

**Accept:** 503 mock is ordinary HTTP response; HEAD/204/205/304 no body; Unicode survives; sequence config round-trips and invalid slots block Save.

## Task S11.3 — Implement sample reuse and save/runtime integration

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** sample provenance, action revision and active effects. **Status:** NOT STARTED. **Depends on:** S11.2, S09 samples, mock engine.

1. Preview available recorded/saved samples and completeness before copy into chosen slot.
2. Preserve redaction/unresolved placeholders and require replacement where needed; absent sample disables with explanation.
3. Commit action revision atomically; reset sequence only on documented action change/activation, not cosmetic name.
4. Show whether enabled save affects active module; Delete/Cancel follows shared drafts and snapshot lifetime.
5. Verify static/sequence native Fetch/XHR plus no-upstream/abort assertions through UI.

**Accept:** truncated capture never looks like a complete mock fixture; label-only edit preserves cursor; meaningful slot edit resets as declared; save failure leaves draft.
