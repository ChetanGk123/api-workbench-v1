# Import and recorder contract

Status: rebuild behavior. R3 implements the recorder, the shared review/commit flow and the native and HAR adapters ([R3 evidence](R3_REPORT.md)); the other five external formats are detected and named but arrive in R7. All seven advertised external format/version paths and the recorder source are required. Source limits and recovery budgets are owned by [DATA](DATA.md).

## One conversion/review flow

```text
source draft → detect/override → parse adapter → normalize candidates
→ validate + find required inputs/dependencies/conflicts → review
→ validate destination revision → transaction → show saved summary
```

No parser/detector/normalizer dispatches a request, writes storage, expands a local path or executes imported code. They accept data and return candidates/diagnostics. The UI owns draft/read/parse cancellation; a stale parse result cannot replace a more recently edited source.

A normalized candidate carries source format/version/item/location, proposed endpoint/request/check/sample, unresolved fields, redaction/body-fidelity notes, source identity and conflict options. It is not a saved endpoint until commit. Every adapter uses the same validators and candidate editor.

For complex apps, captured auth/signature/nonce/idempotency fields are provenance and required-configuration hints. They do not establish a reusable signing recipe, valid future OTP or safe write retry. Review names fresh context/signing requirements and lets the user configure typed recipes/bindings; unsupported direct reconstruction remains visible while app-generated testing can still use the captured native path. Native exports carry recipe/context/guard/poll definitions without current secrets.

## Adapter contracts

| Input | Translate | Explicit diagnostics / refused behavior |
| --- | --- | --- |
| Native schema 1/2 | Profile/endpoints/plans/rules/headers/environments/settings, supported migration and complete reference remap | Future schemas rejected; no activation/in-flight data restored |
| Swagger 2.0 JSON | Schemes/host/basePath, operations, path/query/header/body/form parameters, examples, local refs, operation aliases | Remote refs, required missing values, unsupported security, schema-only data; no invented requests/examples |
| OpenAPI 3.0 JSON | Selected server/default variables, operations/parameters, request media types/examples, local refs, response examples, auth hints | YAML/OpenAPI 3.1 are not implied; remote refs and schema-only bodies are notes; required inputs stay unresolved |
| HAR 1.2 | Method/URL, supported headers, repeated query, postData text/params, available status/headers/body including supported base64, timing provenance | Omitted/unfinished responses, restricted headers, unrepresentable binary/file parts; no timing converted into a mandatory assertion |
| Postman collection v2.1 | Nested folder names, active headers/query, variables and deterministic auth inheritance, raw/urlencoded/multipart descriptors/GraphQL, supported samples | Scripts never run; unsupported auth/environment files/file-body requirements named; disabled entries visible as skipped |
| DevTools cURL | Declared bash and Windows cmd quoting/continuation/escapes, URL/method/headers, supported literal data/urlencoded/multipart fields/basic auth | No shell, backtick/substitution execution, proxy/TLS bypass or file auto-read; unsupported flags have character locations |
| Copied fetch | Literal URL and literal options emitted by supported Chrome/Edge; method/headers/body/credentials and request-model-representable literal options | Calls/variables/assignments/getters/template interpolation rejected; unsupported browser-controlled options shown, never silently claimed preserved |
| Recorder | Selected supported captured calls with provenance, body/capture state, redacted headers, samples and user edits | Current frame only; cached references/other resource types not fabricated as capture |

Choose content, not filename. Detection must check actual discriminator/version/structure, not a generic `request` key. Format override that contradicts source gives a useful error. cURL dialect support requires captured real browser clipboard fixtures; do not market a general shell parser.

For copied fetch, a bounded literal grammar is enough; no JavaScript engine. Reject code-dependent `JSON.stringify`, `new Request`, functions, variables and interpolation. Escaped literal Unicode/newlines remain data. The accepted grammar is listed with examples in the runtime help; literal parsing does not authorize executing pasted requests.

For cURL `-F`, preserve multipart field descriptors and explicit missing-file requirements. Do not coerce multipart into urlencoded while claiming fidelity. Imported `@file` remains a named required file selection. Multiple commands are independent candidates, not a script. Cookie/cookie-jar flags map to an explicit browser credentials intent with diagnostics; captured Cookie values are not ordinary script-set headers.

Postman inheritance is request → item → folder → collection, with explicit noauth overriding inheritance. Bearer/basic/header API-key auth maps to configurable header/binding data; other auth and API-key placements must be translated only when the request model represents them, otherwise marked unresolved. No script-generated variable or token is assumed to exist.

## Review and conflict behavior

Show detected format/version, source/importable/skipped counts, exact destination profile, source notes, unresolved inputs, sensitive fields and fidelity limits. Each candidate has selection, editable name, effective request preview and source detail. Body/media-type examples are selectable. The user can inspect conflict effects before commit.

Duplicate detection compares method, effective origin/host mapping, normalized pathname, query constraints and body identity when available. Repeated captures can be grouped, but different queries/bodies must not be silently merged. Alias collision is a distinct naming conflict. Name alone is never request identity. The same path across two environments/origins is not blindly one request.

- Keep both: fresh ID and unique alias.
- Replace: user chooses the specific existing endpoint, ID preserved, reviewed dependency/rule impacts applied.
- Skip: existing record unchanged; skipped count names the reason.
- Group repeated calls: count and sample choices visible; source entries remain inspectable.

Native modes: new profile and visibly switch; merge into current; replace current. Copy remaps all IDs/references coherently. Replacement previews removal scope and supports export before commit. Native schema-1 migration does not guess what unsupported original fields once meant.

Preview records profile ID and revision. Switching profiles or editing conflicting destination entities invalidates it; require rebuild/explicit retarget review. Transaction failure saves nothing, retains source/review/selection and offers Retry or Export draft. Only confirmed durable counts appear in the success summary. Commit never sends endpoints or activates a rule module.

## Import UI states and controls

Retain Paste, Choose file, Apply, format override, format help/examples, recording entry, active-profile destination, Back/Settings/Minimize/Close. Clear/Export draft and Use recorded calls share existing state, not another recorder implementation.

States: empty, reading, detecting, parsing, invalid, review ready, saving, save failed, saved. A cancelled/unreadable/oversized file preserves the prior draft. Replacing edited input offers Replace draft / Cancel. Parse work yields between bounded item batches so Cancel and Close remain usable. Cancel invalidates result publication; it need not pretend a synchronous JSON parse can be interrupted midway.

## Recorder

One recorder subscribes to normalized shared request records; it never installs another wrapper. Starting captures only subsequent supported calls. Tester traffic is excluded by default and labelled when explicitly included. Stop ends new capture and retains the reviewable draft. Reset clears recorder draft/recovery only; saved profile data stays intact.

Capture metadata first. Body reads follow operation eligibility and budgets; unavailable text/binary/streaming bodies keep reasons. Redact before rendering, storing or recovery writes. Credentials may retain a user-approved source binding reference rather than a literal value. Do not scan all page secrets opportunistically to guess bindings; use configured/user-selected source categories and own data descriptors.

Record response identity by request ID, not latest method/URL. Grouping has an explicit method/origin/path/query/body policy; show differing bodies/queries and permit separate endpoints. Promotion presents removable transient parameters and dependency suggestions for review. A repeated sample value does not prove a dependency.

Recovery stores origin/schema/time, bounded records and selection. It resumes a draft, never active interception. Budget overflow stops capture with an explanation and allows review/export, rather than retaining unlimited data. When a capture cannot represent replay (binary/streaming/missing file), the candidate states that requirement and cannot pass a body-dependent test silently.

## Required acceptance examples

- Native export→import preserves IDs or remaps every reference according to mode; schema-1 migrations retain samples/checks/rules/saved plans; future schema changes nothing.
- Swagger/OpenAPI examples include refs/cycles/depth limits, repeated query, missing path variables, multiple media examples, collisions and authentication hints.
- HAR includes same URL with different bodies, base64, missing response, restricted headers and explicit grouping.
- Postman includes nested auth/variable inheritance, disabled entries, scripts, multipart files and noauth override.
- Real Chrome/Edge cURL bash/cmd and copied fetch fixtures include multiline/escapes/Unicode/headers/body/credentials; importing executes no code and sends zero requests.
- File and paste yield equivalent candidate semantics; cancel/failure retain old input; oversized content is refused before uncontrolled expansion.
- Recorder captures Fetch and XHR with matched request IDs, redacts secrets, enforces byte/count caps and recovers an inactive draft; selection/promotion affects only chosen records.
- Stale profile/revision and injected transaction failure cannot redirect or partially commit an import.

Each advertised format needs parse, preview, commit and then representative dispatch/check evidence. Detecting an envelope alone is not format support.
