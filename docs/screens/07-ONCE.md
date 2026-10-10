# Test screen: Once endpoint

Reference: Once region of [Test.html](../../../design/reference/screens/Test.html). Features P06/P08/P16/P21; gates G15/G17/G22/G27; slices R2/R6. Read [TESTER](../TESTER.md), [COMPLEX_APPS](../COMPLEX_APPS.md).

## Required behavior

Once sends one selected endpoint with an explicit Direct/Apply rules choice, destination/credentials/header/body/required-value preview, Run and Cancel. Local/global header edits show their persistence scope. Auth context and signing status are masked but understandable. The displayed result includes outcome/status/source/size/timings, body completeness, headers and failed/not-evaluated checks, plus Copy body, Save sample and Add check.

Once must not run the whole plan unexpectedly, silently retry writes after 401/timeout, use an old signature reservation, apply active rules in Direct mode, invent missing files/bindings, or show the previous response as the new pending result without clear identity. Cancel owns tester work only.

## Task S07.1 — Build endpoint selection and request preparation preview

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** effective values, sources and preview freshness. **Status:** NOT STARTED. **Depends on:** S04, request preparation, S22 definitions.

1. Select endpoint by stable ID with display name/method/service; entering via row Run selects that endpoint.
2. Show effective origin/credentials/header precedence/body kind and masked required bindings/files.
3. Make Direct/rules choice adjacent to Run; disabled state states why and links to missing configuration.
4. Prepare draft reservations deliberately; regenerate on meaningful edit, sign only in correct final preparation order.
5. Shared header editor saves at the stated profile/endpoint scope; no invisible temporary override.

**Accept:** preview matches server-observed request; missing CSRF/key/file blocks; include/omit behavior explicit; old signed preview is not reused past recipe freshness.

## Task S07.2 — Execute and cancel through one tester path

**Suggested model:** GPT-6 Astra. **Effort:** high. **Why:** auth freshness, cancellation and exactly-once dispatch. **Status:** NOT STARTED. **Depends on:** S07.1, NETWORK/TESTER engine.

1. Validate/re-resolve at dispatch and capture endpoint/config identity; prevent duplicate Run while owned request pending.
2. Dispatch via captured transport or shared pipeline according to visible mode; tag tester source internally only.
3. Apply explicit auth refresh/read-only retry policies from configured context; no automatic mutating retry.
4. Cancel aborts owned request/readers and releases waiters; Close/profile change follows shared owner.
5. Publish blocked/network/timeout/abort/check result separately, retaining uncertain-write status.

**Accept:** one write even after lost response; Cancel settles without later dispatch; Direct bypasses active mock; rules mode traces it; expiry refresh bounded and context-isolated.

## Task S07.3 — Present results and useful follow-up actions

**Suggested model:** GPT-6.1 Sol. **Effort:** medium. **Why:** straightforward presentation over validated results. **Status:** NOT STARTED. **Depends on:** S07.2, S21 detail, check/sample commands.

1. Render the identified latest result body/headers/status without mixing check report into JSON content.
2. Label truncated/unreadable/binary data; show failed/not-evaluated checks and timing meaning/source.
3. Copy returns honest clipboard feedback; Save sample preserves provenance/limits; Add check opens a validated draft.
4. History opens exact request/result and preserves selected endpoint; keyboard/body resize keeps actions reachable.

**Accept:** expected 503 can pass; incomplete body does not pass JSON/contains checks; copied text corresponds to visible result; saved sample never becomes invented network evidence.
