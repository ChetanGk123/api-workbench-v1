# R7 remaining imports: clean rebuild, 11 October 2026

**Status: implemented; verification incomplete. R7 is not complete.** All 238 counted tests pass in Chrome 154: 121 pure (101 earlier + 20 new) and 117 browser (112 from R0–R6 + 5 new R7 cases). The dialect corpus was captured from Chrome's own DevTools code. **Not run:** the Edge corpus and Edge tests (Edge is not installed), saved-bookmark installation of this artifact, and a screen-reader pass of the new review controls. The R0–R6 open items are still open.

As in R0–R6, this is from-scratch code.

## Environment and artifact

macOS 26.6.2; Node v24.21.0; TypeScript 7.0.2; esbuild 0.28.2; Playwright 1.63.0; Google Chrome 154.0.8037.99. Fixture ports 4320/4321.

| Artifact `2.0.0-r7` | Measured | Change from R6 |
| --- | ---: | ---: |
| Readable IIFE | 681,852 bytes | +84,067 |
| Minified IIFE incl. CSS | 437,081 bytes | +52,703 |
| Encoded `javascript:` URL | 643,809 characters | +79,987 |

Minified SHA-256 `6f10ba5f228c1c8bc76dd526e93c94da4f3f79cbe8976fdd5693b07fcc101dd3`; bookmark SHA-256 `cd61d4382ee68316009e03192e370133f76b8ba4f07993747ff891b21c7f153a`. Full record: [evidence/r7-sizes.json](evidence/r7-sizes.json). The bookmark is 41% of the 1.5 MiB working ceiling measured in R4. It has not been through the saved-bookmark procedure.

## What changed

| Area | Behavior |
| --- | --- |
| Detection (`src/data/importers.ts`) | The format is decided by content: discriminator, version and structure. Overrides: Swagger 2.0 JSON, OpenAPI 3.0 JSON, Postman collection v2.1, cURL (bash), cURL (Windows cmd), Copied fetch. These are named, not imported: OpenAPI 3.1, YAML, Swagger 1.x, Postman v1 and Postman environment files. An override that contradicts the content names both formats. A generic `request` key is still not a format. |
| Shared draft path (`src/data/review.ts`) | The five new adapters produce one `Draft` shape: name, operationId alias, method, URL, query, headers, credentials, body choices, authored sample, source location, notes and requirements. `candidatesFromDrafts` uses the R3 identity rules (method, effective origin, path, query, body; never name or headers), alias uniqueness, *variant n of m* labels and Skip/Keep both/Replace. It uses the R3 transaction unchanged. A URL whose origin an environment maps becomes host key + path. A relative server uses the first host key. Per-request headers (nonce, idempotency, timestamp, OTP) with literal values are listed as needing fresh values. |
| Unresolved values (`src/tester/expr.ts`) | A value the source does not supply becomes `{{$missing("label")}}`. It stays visible in the review, the editor and the preview. It blocks Once and plans with *label: not supplied by the import; enter it before sending*. A label is optional. `{{$missing}}` without one keeps its R3 meaning. Secrets are never imported. Header, query, form and JSON values with sensitive names follow the recorder's redaction rules. Auth taken from a document or collection becomes a labelled marker. |
| Swagger 2.0 / OpenAPI 3.0 (`src/data/specs.ts`) | Supported: schemes/host/basePath; OpenAPI servers with default variables, with a **Server** choice when there are several; path-level and operation parameters (the operation wins); local `$ref` (chain depth 8, cycles detected); `example`/`examples`/`x-example`/`default`. Query serialization: repeated `multi`/form-explode arrays, `csv`/`ssv`/`pipes`, deepObject. Path values are percent-encoded. Required values with no example become markers. Optional ones are left out with a note. Bodies: JSON, urlencoded, and multipart with file parts. **Each media type and example is a selectable body**, up to 10 per operation. A schema-only JSON body is a marker plus a requirement; nothing is generated from a schema. 2xx response examples become authored samples. Security: apiKey (header/query), HTTP basic and bearer become marker headers or query values. Cookie apiKey and cookie parameters mean `credentials: include`. oauth2 and openIdConnect are named as unsupported. Alternative requirements are named, and the first one is used. Remote `$ref` and `externalValue` are never fetched. A duplicate operationId gets a suffix and a note. TRACE is skipped. At most 500 operations. |
| Postman v2.1 (`src/data/specs.ts`) | Folder names make the request name (`Folder / Request`). Collection and folder variables apply, nearest first. `{{$guid}}`/`{{$randomUUID}}` map to `{{$uuid}}`. Other dynamic, environment, global and script variables become named markers. An unresolved base URL becomes `https://{{$missing("variable …")}}/path`, so the URL stays valid and still blocks dispatch. Auth is inherited request → item → folder → collection, and `noauth` stops it. Bearer, basic and header/query API key become marker headers or query values. Other auth types are named as unsupported. Path variables (`:id`) take their values from `url.variable`. Disabled headers, query rows, form fields and variables are skipped with notes. Pre-request and test scripts are listed as *not run* at collection, folder and request level. Bodies: raw (language → content type, kept exact), urlencoded, form-data with file parts (the exporting machine's path is shown, never read), and GraphQL as JSON. A `file` body becomes a marker. Saved responses become samples. v2.0 is read with the v2.1 rules and a note. At most 500 requests, folders up to 16 deep. |
| cURL (`src/data/snippets.ts`) | Two grammars, neither of them a shell. **bash**: `'…'`, `$'…'` (ANSI-C escapes including `\uXXXX`), `"…"`, `\` continuation, and ` ;` between commands. **Windows cmd**: `^` escapes, `^`+newline continuation, ` &` between commands, then the C runtime argument rules. Refused with a line and column: `$`/backtick substitution, unquoted globs, `|`, redirects, `&&`, `%VAR%`/`!VAR!`, unknown options, `--proxy`, `-T`, `-K`, TLS and DNS options. Options read: `--url`, `-X`, `-H` (including `name;` for an empty value), `-d`/`--data-raw`/`--data-binary`/`--data-ascii`/`--data-urlencode`, `-F`/`--form-string` (multipart is kept as fields; `@file` becomes a named file requirement, `<file` a marker), `-u` (marker), `-b`/Cookie (`credentials: include`; the value is never kept), `-G`, `-I`; `-L`, `-k`, `-s`, `--compressed` and others are notes. `\[`/`\{` URL escapes are read; unescaped globbing is refused. Raw multipart text (as DevTools copies it) is kept as exact text with its boundary. Browser-set headers (User-Agent, `Sec-*`, Origin, Referer, Connection, Cookie) are dropped, with one note listing them. At most 200 commands per paste. |
| Copied fetch (`src/data/snippets.ts`) | A bounded literal grammar: `[await] fetch("url", { … })`, then `;`. Strings with JS escapes, numbers, `true`/`false`/`null`, objects and arrays only. Refused with a location: variables, calls and property access (`JSON.stringify`), `new`, template literals, spread, computed keys, shorthand properties, parentheses, `.then()`, and `__proto__`. Read: method, headers (object or pair list), string body, credentials. Named as not preserved: `referrer`, `referrerPolicy`, `mode: "no-cors"`, `cache`, `redirect`, `integrity`, `keepalive`, `priority` and unknown options. The Node.js copy's `cookie` header becomes `credentials: include`. A relative URL is refused, because the adapter does not guess the page origin. |
| Import screen (`src/ui/importer.ts`) | Every format has an override option. **Supported formats and examples** lists each adapter, its accepted grammar and an example. A drafts review shows source/candidate/skipped/*need values* counts, the destination, a **Server** select for multi-server OpenAPI, a **Body example** select per candidate, *Needs before sending*, notes, and **Request preview** (credentials, headers, bounded body). The file chooser also accepts `.txt/.sh/.cmd/.bat/.js`. Paste and file use the same path. |
| Dialect corpus (`scripts/capture-devtools-corpus.mjs`, `tests/fixture/corpus/chrome-154.json`) | Chrome is launched with DevTools open. The page sends 8 fixture requests: Unicode query/header, JSON with escapes, `$`, `!`, `%`, `^`, `&` and an emoji, urlencoded with a password, multipart with a file, PUT with `[ ] { }` and cmd metacharacters, an Authorization header plus an empty header, a cross-origin DELETE, and a PATCH without a content type. The script attaches to the DevTools frontend target over CDP and calls the functions behind the Network panel Copy menu: `NetworkLogView.generateCurlCommand(request, 'unix'|'win')`, `generateFetchCall(request, browser|nodejs)` and the *Copy all* variants. **This is real browser output, not text written from memory**, but it is not a clipboard read from a manual click. |

## Real Chrome 154 dialect facts (from the corpus)

The corpus changed the parser. Before the capture, these were assumptions:

- `curl --url '…'` rather than a positional URL; cookies are `-b '…'`; *Copy all* joins with ` ;\n` (bash), ` &\r\n` (cmd) and `}); ;\n` (fetch, an empty statement).
- **Windows cmd copies are lossy.** Each non-ASCII character becomes `^ ` (an escaped space), so `naïve café` arrives as `na ve caf`. CRLF inside a body becomes LF, which breaks raw multipart. Every backslash is doubled, and the C runtime would keep a run that is not before a quote doubled. The cmd adapter halves even runs to recover the copied request. It names each of these facts on the candidate. A multipart body without CRLF is a requirement.
- The fetch copy omits browser-set headers; the cURL copy includes all of them. The fetch copy's `credentials` follows whether cookies were *sent*. The cross-origin DELETE was made with `include`, but it copies as `"omit"` because no cookie existed for that origin.

## Gate ledger (scoped; not whole-gate PASS)

| Gate / portion | Result | Evidence and boundary |
| --- | --- | --- |
| G19 Swagger 2.0 | PASS (pure + Chrome) | Refs, cyclic and remote refs, repeated query, defaults, a missing path value, an encoded example, multipart file, apiKey/oauth2 hints, duplicate operationId. Chrome: paste → review counts and preview → commit to a new profile → *API key key: not supplied by the import* blocks Once → DELETE `/api/pets/p%201` is sent. Zero requests during import. |
| G19 OpenAPI 3.0 | PASS (pure + Chrome) | Server variables and choice, three selectable bodies, deepObject/array query, cookie auth → include, OIDC, alternatives, schema-only body, multipart from schema, 3.1/YAML refused. Chrome: server switch changes URLs; the chosen **big** example survives a destination switch and is the exact body sent. |
| G19 Postman v2.1 | PASS (pure + Chrome) | Nested folder variables and API-key auth, `noauth` override, disabled entries, scripts named, form-data file, GraphQL, urlencoded, basic, hawk unsupported, an unresolved base URL. No collection secret appears in drafts or the panel. Chrome: file and paste reviews are identical; `Public rates` sends with the resolved URL; an inherited bearer blocks by label. |
| G19 cURL bash/cmd | PASS (pure + Chrome) for Chrome 154 copies; **Edge NOT RUN** | All 8 corpus cases × bash/cmd: method, URL, query and `x-corpus` match what was sent. Bash bodies are byte-exact; cmd differences are exactly the named DevTools losses. Copy-all gives 3 independent candidates per dialect. All 32 corpus requests (4 copy kinds × 8) commit valid. Refusals have locations. Chrome: `.sh` file = paste; the exact escaped JSON body is sent. |
| G19 copied fetch | PASS (pure + Chrome) for Chrome 154 copies; **Edge NOT RUN** | Browser and Node.js copies of all 8 cases. Chrome: PUT with `[1]`, `%PATH%` query, the `x-odd` header with cmd metacharacters, and the body are sent exactly. A snippet with a side effect (`window.pwned = 1`) and a `$(…)` cURL are refused; the page variable is unchanged and fixture counters are unchanged. |
| G19 no execution/network during import | PASS (Chrome) | Server counters are compared before parse and after commit in every R7 browser case. No adapter reads a file path, fetches a reference or evaluates code. The build gate still finds no evaluator or remote-URL text in the bundle. |
| G19 file/paste parity | PASS (Chrome) for Postman and cURL; R3 for HAR | |
| G20 transaction for drafts | PASS by shared path (Chrome); **no draft-specific failure or stale case** | Drafts commit through the same branch as recorder/HAR calls: revision-checked edit, or new-profile transaction. The R3 injected-failure, Retry and stale-rebuild Chrome case still passes on that branch. A rebuilt review now keeps body example, sample choice and cache-buster removal (see below). |
| G02 saved bookmark for 2.0.0-r7 | **NOT RUN** | Automated launches inject the decoded artifact. |

[Counted results](evidence/r7-automated.json): **238 expected, 0 unexpected, 0 skipped, 0 flaky**, 117 s. Screenshot: [OpenAPI review with a chosen body example](evidence/r7-openapi-review.png).

## Found during testing

Product bugs, fixed:

1. **A rebuilt review dropped choices.** Switching the destination, or *Rebuild review* after a stale destination, rebuilt candidates. It kept only selection and name. A chosen body example was lost, so the committed request silently used the first example. The same bug was present since R3 for the HAR/recorder sample choice and cache-buster removal. Both builders now keep these choices. The OpenAPI Chrome case covers it.
2. **A marker-only auth header was also listed as a redacted secret.** It produced two requirements for one value.
3. **Import limits did not match DATA.** The adapters used 1000 operations and a ref chain of 32; they now use DATA's 500 / 500 / 8 / 16. A test covers each limit.
4. The build's distribution gate flagged the regex `/curl(\.exe)?/` as CSS `url(`. The regex was rewritten. URL text built from document parts now uses scheme constants, so the bundle still holds no literal remote URL.
5. A parenthesized value in a fetch snippet gave *Unexpected "("*. It now says it is code.

Test mistakes: four wrong column numbers in refusal assertions, an identity test whose comment contradicted the rule (headers are not identity), a wrong Back button name, an expected `%5B` where fetch keeps `[1]` unencoded, and the order of the browser-header note.

## Commands

```sh
AW_PORT=4320 AW_OTHER_PORT=4321 npm run verify                          # tsc, build, 238 counted tests
AW_PORT=4320 AW_OTHER_PORT=4321 npm run fixture &                       # then, to recapture the corpus:
AW_PORT=4320 AW_OTHER_PORT=4321 node scripts/capture-devtools-corpus.mjs chrome   # or msedge
```

## Deliberate R7 boundaries

- **JSON only.** YAML and OpenAPI 3.1 are refused, not converted. Response schemas are not turned into checks; every candidate gets the R3 status check.
- **No generated examples.** The one structural use of a schema: multipart/urlencoded bodies with no example get their property names as fields. A field without an example is a marker; a binary property is a file part.
- **Auth becomes markers, not auth contexts.** A document's bearer, basic or API key becomes a labelled marker header or query value. The user replaces it with a value, `{{$context("…")}}`, or an auth context. No auth context, binding or signing recipe is created from a document or snippet.
- **Base URLs are not turned into host keys.** A resolved Postman `baseUrl` or OpenAPI server becomes an absolute URL. The exception: when an environment already maps that origin, it becomes host key + path. OpenAPI path- or operation-level `servers` use their first entry. The **Server** choice applies to document-level servers.
- **Raw multipart from DevTools stays exact text** with its boundary; it is not split into fields. A copied binary file's bytes are not exact, and a note says so.
- **cmd fidelity.** The cmd adapter inverts DevTools' backslash doubling. That is not what `curl.exe` itself would send for those runs, and the note says so. Non-ASCII characters lost by the copy cannot be recovered.
- **Requirements do not block saving.** A candidate with markers imports and is counted as *need values before sending*. Dispatch is what blocks.
- **Candidate editing** is still name, alias, selection, body example, sample and conflict action. Headers and markers are edited in the endpoint editor after import, as in R3.

## Remaining before R7 can close

- [ ] Install Edge; run `node scripts/capture-devtools-corpus.mjs msedge`; add the Edge corpus to the corpus tests; run the Chrome suite with `AW_BROWSER=msedge`.
- [ ] A manual clipboard check: right-click → Copy as cURL (bash) / (cmd) / fetch in Chrome and Edge, then paste. Compare with the generated corpus, which was captured through the same DevTools functions but not through the clipboard.
- [ ] A draft-specific injected-failure and stale-destination case in a browser. The shared branch is covered only through HAR.
- [ ] Saved-bookmark installation of 2.0.0-r7 (643,809 characters) in Chrome, then Edge.
- [ ] Screen-reader pass of the Server and Body example selects and the request preview.
- [ ] R0–R6 open items.
