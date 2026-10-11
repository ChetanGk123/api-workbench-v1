# Recorder and promotion review

No separate original HTML; entered from Home/Import. Features P09/P10/P17/P21; gates G07/G18/G20/G22; slice R3. Read [IMPORT_RECORDER](../IMPORT_RECORDER.md), [NETWORK](../NETWORK.md) and [DATA](../DATA.md).

## Required behavior

Show scope, recording status/time, capture count and byte budget, Start/Stop/Reset, tester inclusion, filtered candidates and promotion actions. Supported future page Fetch/XHR calls arrive through the shared pipeline. Stop keeps draft; Reset affects recorder/recovery only and previews loss. Add to current profile vs new profile names destination before commit.

Candidate rows expose method/service/path/query/body variants, grouping counts, selected sample, redacted credentials, unavailable bodies/files and possible inputs. Edit uses the same endpoint draft. Recovery restores inactive review state, not hooks. Banking captures must explain rotating token/nonce/signature fields without treating a historical value as reusable.

Must not install another hook, capture earlier/whole-tab/worker traffic falsely, automatically scan all page secrets, attach responses by latest URL, store unlimited bodies or erase saved endpoints on reset.

## Task S06.1 — Wire bounded capture and lifecycle

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** observer/reader ownership and recovery limits. **Status:** IMPLEMENTED; verification incomplete ([R3 evidence](../R3_REPORT.md)); the 1 MiB envelope cap and recovery-write refusal are NOT RUN in a browser. **Depends on:** shared request records/body policy; S00.3.

1. Subscribe one recorder to eligible subsequent records; source-filter tester traffic under explicit setting.
2. Render count/time/bytes without replacing edited candidate fields. Redact before display/persistence.
3. Start/Stop are idempotent; Stop detaches new capture while bounded owned previews settle under lifecycle policy.
4. Enforce UTF-8 preview/envelope/count caps; stop at cap with usable review/export. Dispose readers/listeners on Close.
5. Persist bounded recovery keyed to schema/origin and restore inactive draft only.

**Accept:** native Fetch/XHR captured once; binary body omission stated; cap stops predictably; storage refusal visible; relaunch never starts recording automatically.

## Task S06.2 — Build review, grouping and candidate editing

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** dedupe can accidentally lose meaningful transaction variants. **Status:** IMPLEMENTED for the R3 scope; verification incomplete ([R3 evidence](../R3_REPORT.md)); in-review header/binding editing (item 3) is not built, edit after import. **Depends on:** S06.1, S04 candidate drafts.

1. Group using explicit method/origin/path/query/body policy; display variants and allow keeping them separate.
2. Join request/response by request ID; expose source records/samples and omission state.
3. Filter/select/edit names, headers/required bindings and transient query suggestions without changing captured originals.
4. Delete candidate previews underlying capture removal; Reset offers Cancel and exact draft scope.
5. Suggest dependencies from samples as suggestions requiring review; preserve distinct IDs and current-value requirements.

**Accept:** concurrent equal URLs retain correct responses; differing transfer bodies are not collapsed blindly; Reset Cancel keeps draft; suggestions do not mutate plan or unmask tokens.

## Task S06.3 — Promote selected candidates through shared commit

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** profile/draft preservation and transaction semantics. **Status:** IMPLEMENTED; verification incomplete ([R3 evidence](../R3_REPORT.md)). **Depends on:** S06.2/S05.3.

1. Convert only selected editable candidates through common validators/conflict preview.
2. Support current-profile add and new-profile-name preview; keep outgoing profile available.
3. Commit revision-checked aggregate, then navigate to promoted rows with exact added/skipped/unresolved count.
4. Failed commit retains captures/edits/selection; recovery is removed only by an explicit successful cleanup decision.
5. Verify restored draft/promotion with redacted bank auth fields and missing nonce/signing setup.

**Accept:** saved profiles untouched until commit; only selected calls added; failed save changes nothing; promoted historical signature is marked as needing fresh preparation.
