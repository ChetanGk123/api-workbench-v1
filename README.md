# API Workbench

A full-inline bookmarklet for testing the current application's Fetch/XHR traffic. This is the **2.0.0-r8 pre-release**; the [release report](docs/R8_REPORT.md) lists the verification still required before release.

```sh
npm ci --offline --no-audit --no-fund
npm run verify
npm run fixture
```

Open `http://127.0.0.1:4310/install`, save the complete bookmark URL, open your application, and click the saved bookmark. The fixture is test infrastructure; the installed bookmark does not need it. Use `AW_PORT=4330 AW_OTHER_PORT=4331 npm run verify` if the default fixture ports are occupied. Do not stop another server to free them.

The generated files are in `dist/`: installer, readable/minified IIFEs, complete bookmark, size/hash report and data-only update manifest. See [deployment and replacement](docs/RELEASE.md) for hosting, manual updates and rollback. Source contracts and earlier slice evidence are in [docs/](docs/README.md).

Modules start inactive. The current frame's future Fetch/XHR calls are covered; workers, other frames, cached API references and browser-managed policies remain boundaries. Profiles are stored in the tested site's IndexedDB and are readable by that site's scripts. Imported scripts are data and never execute. Tokens and signing keys resolved at runtime are not persisted in profiles.
