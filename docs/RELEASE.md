# Build, deploy, replace and roll back

R8 preparation, 11 October 2026. **Do not publish this candidate as release-ready while the required gates in [R8_REPORT](R8_REPORT.md) remain open.** No production bookmark, host deployment or application data was replaced by this work.

## Build and inspect

`npm ci --offline --no-audit --no-fund` installs the lockfile when packages are cached; omit `--offline` for an uncached install. `npm run verify` checks types, standalone/encoding constraints and the counted core/Chrome suite. For installed Edge: `AW_BROWSER=msedge npm test`. Use a dedicated fixture origin/profile for tests; the suite resets its own fixture data.

```sh
npm run build
npm run fixture
```

The installer is `http://127.0.0.1:4310/install`. `dist/install.html` also works as a standalone page. Its link and textarea contain the entire `dist/bookmark.txt`; copying or clicking on the installer does not install it. Paste the whole URL in a bookmark's Edit dialog and verify that it starts with `javascript:`. Drag installation is a separate, still-open check.

## Static hosting and updates

No service is required to run the tool. A public static folder can hold `install.html`, `bookmark.txt`, `update.json` and `sizes.json`; `aw.js`/`aw.min.js` are optional readable/debug downloads, never fetched by the bookmark. Attach the release report and evidence to the release for review.

To configure explicit Check for update, build with the final public folder URL:

```sh
AW_UPDATE_URL=https://example.com/api-workbench/ npm run build
```

The address must be HTTPS and end in `/`, without credentials, a query or a fragment. HTTP is allowed only on localhost/127.0.0.1 for fixtures. Without an address the button is disabled; manual replacement from the installer remains available. The chosen address is compiled into the artifact, so rerun its size/hash and saved-bookmark gates after changing it.

Serve `update.json` as JSON and `bookmark.txt` as UTF-8 plain text, with `Access-Control-Allow-Origin: *` (these are public data, requests use `credentials: omit`). Do not redirect the two update URLs. Prefer `Cache-Control: no-store` for these mutable files. The tested application's `connect-src` may refuse the address even when CORS is configured; the error explains this and offers manual reinstallation. Browser policy is never bypassed.

Publish the bookmark before its matching manifest, preferably swap a staged folder atomically. The manifest's version, character length and SHA-256 must describe that bookmark; an inconsistent upload is refused. It is not a cryptographic authenticity guarantee against a compromised hosting origin. Preserve older artifacts by version for rollback. Build-generated hashes live in `sizes.json` and `update.json`.

## Manual update gate

1. Save the old full URL in a disposable browser profile and launch it on the fixture.
2. Publish the new bookmark and its matching manifest to the configured address.
3. Settings → About → Check for update. Verify the version and checksum message, then Copy new bookmarklet. The running version must remain the old one.
4. In the browser's bookmark Edit dialog, replace the complete URL with the copied text. Reload the page and click the saved bookmark. About must show the new version.
5. Restart the disposable browser and repeat; compare retained text with the build's SHA-256. Repeat in Chrome and Edge.

`scripts/bookmark-update.mjs` checks the bookmark model, actual clipboard, browser restart and saved-URL navigation in a throwaway profile. It does **not** operate the native Edit dialog. `scripts/bookmark-experiment.mjs` similarly records model/restart/size/policy evidence; neither script substitutes for a recorded native bookmark-menu click.

```sh
AW_PORT=4340 AW_OTHER_PORT=4341 npm run fixture
AW_PORT=4340 node scripts/bookmark-experiment.mjs docs/evidence/r8-bookmark-chrome.json
AW_PORT=4340 AW_OTHER_PORT=4341 node scripts/bookmark-update.mjs docs/evidence/r8-bookmark-update-chrome.json
```

## Migration and rollback

Export all profiles before replacement. Close the old panel and reload; the legacy-instance guard prevents stacked interception layers. Import → Look for schema 1 data previews a conversion and saves only on confirmation. The old `api-workbench` database is left intact; the new namespace is `api-workbench-v2`. Refused writes leave the old database unchanged and the review retryable.

Rollback means reinstalling the prior full bookmark and reloading. Schema 2 writes are not converted back to schema 1; restore a compatible older backup if needed. Modules, recorder, controllers, current signing keys and refresh work never resume from a saved profile. Clear local data previews its scope and clears this tool's current-origin data, leaving the host's unrelated keys and schema 1 data intact.
