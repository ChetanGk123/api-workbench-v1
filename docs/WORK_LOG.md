# Work log

## 11 October 2026 — R8 release and replacement

Continued the in-progress R8 working tree. Delivered effective Settings/About/update controls, installer/deployment/rollback guidance, a full feature/gate ledger, migration and banking journeys, recorder/update cleanup fixes, durable Results rerun/sample/retention assertions and bounded resource probes. Reused the existing native UI, schema/store/recorder, transport and fixture paths; added no dependencies.

Locked offline install, strict types and standalone build checks pass. Exact counted totals, sizes/hashes, bookmark/restart/policy/update observations and environment blockers are in [R8_REPORT](R8_REPORT.md) and its linked JSON evidence. `npm run verify` owns all counted core/Chrome cases; quota inability is an explicit skipped gate, not release success. Default fixture port 4310 was occupied and left untouched; owned checks used 4330/4331 and 4340/4341.

R8 implementation is delivered; release remains incomplete. Edge installation/signature checks failed, quota override was not enforced, and native update/restart, drag, human accessibility and long-idle/input/stream-buffer acceptance remain open. No public deployment or production bookmark replacement occurred.
