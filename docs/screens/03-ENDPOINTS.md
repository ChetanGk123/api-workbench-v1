# Endpoints, headers and environments

Reference: [Endpoints.html](../../../design/reference/screens/Endpoints.html). Features P04/P05/P16/P17; gates G14/G21/G22; R2 collection/header/environment work and R6 full dependency integration. Read [DATA](../DATA.md), [TESTER](../TESTER.md) and [UX](../UX.md).

## Purpose and controls

Provide a searchable, service-aware collection with display name, secondary alias, method, host/path, unresolved inputs, checks/sample availability and ordered plan membership where relevant. Row actions are Run/Edit/Delete/Move; keep full accessible entity names. Expose global headers, real Presets, Promote common, dependency Re-analyze, and Base URLs/environment management. Add creates a draft, not a saved dummy request.

Run leads to the same Once preparation/action; Delete previews linked rules/plans/dependencies. Re-analyze parses references and suggests dependencies without rewriting them automatically. Filter/scroll survive edit/import/run return. Reorder is disabled or explicitly translated to unfiltered order while filtered; do not move the wrong hidden row.

This screen must not duplicate every global header into each endpoint, silently retarget absolute URLs on environment change, replace aliases by text substring, ignore repeated query/body distinctions during import, or present inert Presets/Promote controls as complete v1.

## Task S03.1 — Implement collection navigation and CRUD actions

**Suggested model:** GPT-6.1 Sol. **Effort:** medium. **Why:** stable list identity and familiar domain commands. **Status:** IMPLEMENTED for the R2 scope; verification incomplete ([R2 evidence](../R2_REPORT.md)). **Depends on:** S00.1/S00.2, validated endpoint store.

1. Build a filtered view by name/alias/method/host/path; group by service where useful, using endpoint IDs as keys.
2. Carry list return context to editor/Once/imported selection; focus the originating row when it remains visible.
3. Wire Add/Edit/Run to dedicated workflows; Delete requests a reference impact preview and a coherent command.
4. Apply reorder against the full collection only with clear semantics; disable ambiguity under filtering.
5. Show unresolved/sample/check state without reading/transmitting live secrets.

**Accept:** saved edit preserves filter/position; deletion Cancel preserves entities; linked references do not silently broaden; banking accounts/payees endpoints keep understandable labels.

## Task S03.2 — Implement global headers, presets and Promote common

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** precedence and multi-endpoint changes require atomic review. **Status:** IMPLEMENTED for the R2 scope; verification incomplete ([R2 evidence](../R2_REPORT.md)). **Depends on:** header validator, persistence commands.

1. Support ordered editable header rows, explicit removals, case-insensitive keys and saved/unsaved feedback.
2. Provide data-only presets such as JSON Accept/Content-Type and configured CSRF binding; preview collisions and required context.
3. Promote common compares equivalent headers across explicitly selected endpoints, excluding unresolved/sensitive differing values.
4. Preview resulting global additions and local removals/retained overrides; commit as one validated revision/transaction.
5. Show inherited/effective values in the endpoint/Once editor; never copy a masked placeholder into a sent value.

**Accept:** global default/local override/removal behave as shown; two differing auth values are not promoted; failed promotion commit changes nothing; missing CSRF binding blocks dispatch.

## Task S03.3 — Implement environments and dependency analysis

**Suggested model:** GPT-6.1 Sol. **Effort:** high. **Why:** origin/reference changes can misdirect requests. **Status:** IMPLEMENTED for the R2 scope; verification incomplete ([R2 evidence](../R2_REPORT.md)); the DAG is checked by plan preflight in R6, and no separate Re-analyze action exists ([R6 evidence](../R6_REPORT.md)). **Depends on:** DATA model and TESTER graph.

1. Edit validated host-key→origin mappings per environment; reject schemes/paths/credentials not supported as origins.
2. Preview affected endpoint destinations when switching/changing mappings; preserve absolute URLs until explicitly converted.
3. Save/Reset environment draft has explicit scope; Reset restores draft/base values, not all origin storage.
4. Re-analyze exact parsed producer references, cycles/unknowns and suggested dependencies; show impact rather than changing a plan secretly.
5. Alias change/ref deletion uses the shared atomic impact command.

**Accept:** accounts/auth/payment audiences resolve independently; environment change does not move absolute requests; cycles identified before run; renamed aliases update only actual parsed references.
