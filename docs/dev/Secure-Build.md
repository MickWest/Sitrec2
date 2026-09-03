# The Secure Build

The secure build is the production server build with every outbound feature removed at compile time. It is for a hardened deployment on an isolated network: a site that runs its own Sitrec server, saves through that server, and must never contact anything else. It reuses the full server build (`sitrecServer/` and all), so the result is a normal install to run behind a web server with PHP, not a static bundle.

Three things make it different from `npm run deploy`:

1. **Outbound features are removed, not disabled.** Code that would call an AI provider, a tile provider, a data feed or an object-storage service is replaced at compile time by a stub. The host names are not in the output at all, so no setting, no runtime override and no saved file can turn them back on.
2. **Default external data sources are off.** The built-in internet map, elevation and satellite element-set sources are disabled by settings the build forces, whatever the configuration says. The deployment supplies its own sources through the custom-source configuration.
3. **Runtime overrides can only tighten.** A container entrypoint may still inject settings at run time (`window.__SITREC_ENV__`), but in this build a security flag the build set to `"false"` cannot be set to anything else, and a credential can never be put back.

The output is audited after every build. A build that fails an audit is not an artifact.

## Building and auditing

```bash
npm run build-secure          # production build to dist-secure/, then the audits
npm run audit-secure-bundle   # re-run the audits on an existing dist-secure/
npm run build-secure-debug    # unminified, with eval source maps, for debugging only
node test-all-builds.js --quick --config=secure   # serve dist-secure/ with PHP and load it
```

`build-secure` runs `webpack.secure.js` in production mode, writes to `dist-secure/` (cleaned first), then in `postbuild-secure`:

- generates the third-party notices from the bundle's own module list;
- runs `scripts/auditBundleSecrets.js --mode=secure dist-secure`. The secure mode of the secret scan expects a server tree (`sitrecServer/`, and `shared.env.php` with its `<?php` guard, whose content is not served) and allows no credential anywhere else, including the two keys a normal server build is permitted to publish. A configured credential appearing in any other file fails the build;
- runs `scripts/auditBundleEgress.js dist-secure`, the egress tripwire described below.

The debug variant is the same configuration with `--mode development`: unminified, with eval source maps, `[name].bundle.js` file names. Its post-build step runs the secrets audit and the egress audit with `--allow-source-maps`. It is never the deployed artifact.

The build reads `config/shared.env` (or the file `SITREC_SHARED_ENV` names) exactly as the production build does, so a checkout that builds for several deployments can build a secure artifact for any of them.

## What the build forces

`scripts/secureClientEnv.js` builds the client environment. It merges `config/shared.env.example` under the live `shared.env`, blanks every sensitive key (any key on the explicit credential list, or with `TOKEN`, `SECRET`, `PASSWORD`, `ACCESS_KEY`, `API_KEY` or `API` in its name), then forces:

| Setting | Value | Effect |
|---|---|---|
| `IS_SECURE_BUILD` | `true` | identifies the build to the code (`isSecureBuild` in `src/configUtils.js`) |
| `CHATBOT_ENABLED` | `false` | the AI assistant relay is off; with it off, the page also creates none of the assistant's Settings entries (AI Model, Voice Model, old models) and never asks the server for a model list |
| `SITREC_TRACK_STATS` | `false` | no visit counter, no tile-usage statistics |
| `LOG_UI_INTERACTIONS` | `false` | no menu-click logging |
| `SITREC_ENABLE_DEFAULT_MAP_SOURCES` | `false` | the built-in internet map providers are removed from the source list |
| `SITREC_ENABLE_DEFAULT_ELEVATION_SOURCES` | `false` | the built-in internet elevation providers are removed |
| `SITREC_ENABLE_DEFAULT_TLE_SOURCES` | `false` | the built-in satellite element-set sources are off |
| `USE_S3_PRESIGNED_URLS` | `false` | no direct browser-to-object-storage transfers |

Only settings the browser is meant to see are embedded at all. The list is the container entrypoint's `CLIENT_VARS` block in `docker/entrypoint.sh`, read at build time so there is one source of truth, plus any `SITREC_CUSTOM_MAP_*` or `SITREC_CUSTOM_ELEVATION_*` name. A server-only setting (a forum path, an upload directory, a custom feed address) is not compiled into the page, blanked or otherwise. Within that list everything else in `shared.env` passes through as a benign setting: banner text, default map type, the custom source definitions, the local host name.

Deliberately **not** forced: `SAVE_TO_SERVER`, `SAVE_TO_S3` and `SETTINGS_SERVER_ENABLED`. The secure deployment saves through its own server, and the server decides where a file may go. The build removes the browser's ability to reach anything other than that server; it does not remove the save feature.

The seven flags below `IS_SECURE_BUILD` are the build's **security flags**. `src/secureFlags.js` carries the same list for the bundled code, and `tests/secureClientEnv.test.js` fails if the two copies drift.

## Runtime overrides: the ratchet

`getEnv()` in `src/envUtils.js` reads a runtime override from `window.__SITREC_ENV__` before the compile-time value. This is how a container is configured without a rebuild, and it still works in the secure build, with two rules that apply only there:

- a **security flag** the build set to `"false"` stays `"false"`: a runtime value of `"false"` is accepted, anything else (`"true"`, `"1"`, an empty string) is ignored;
- a **sensitive key** (same rule as the build) is ignored outright, so a token blanked at build time cannot be supplied at run time.

Every other setting is overridable as usual. In every other build `getEnv()` is unchanged; the checks are compiled out. `tests/envUtilsSecureRatchet.test.js` proves both halves.

## What is removed

`scripts/secureStubs.js` maps each original module to its stub under `src/secureStubs/`. `webpack.secure.js` applies the map after module resolution, so every import of an original, however it is written, resolves to the stub. The build warns if the map file is absent (then nothing is stubbed) and fails if the map names a stub that does not exist.

Each stub leaves a marker string in the bundle, listed in the map as `removedMarkers`, and the map lists the host names of the originals as `originalHostLiterals`. The egress audit checks both: every marker must appear in the emitted code, and no original host name may. The current list of stubbed modules is the `aliases` map in `scripts/secureStubs.js`; when that file is absent, the build and the audit both say so.

Stubbed today: the startup geolocation lookup, menu-click and tile-usage telemetry, the local compute bridge, the browser-side model clients and the provider key store, dialog and model catalogue, the voice session, the sky-mask client, the live-feed registry, overlay and layer, the public-site importers (forum threads, source videos, records), the aircraft trace and live fetchers, the sounding fetcher, the photorealistic-tiles authentication, the street-level panorama node, and the OCR library loader (the library fetches its worker and language files from a public CDN by default).

A few modules stay because they have other work to do, and are **gated** inside on `isSecureBuild` instead: the wind field's weather lookup (and the wind-source list drops that option), the place-name geocoder in the command box, the startup approximate-location call, the help menu's external links and functions from the configuration file, and the "open in Google Maps" entry of the ground context menu. The map lists their hosts as `gatedHostLiterals`, and the audit requires a matching gated allow-list entry for each.

## What the server ships

The secure artifact packages only the server files named in `scripts/secure-server-allowlist.json`; `webpackCopyPatterns.js` turns every other file under `sitrecServer/` into an ignore pattern for this build only. Left out: every endpoint that fetches from a public data provider on the browser's behalf (aircraft, soundings, live feeds, satellite history, global wind, source videos, street-level imagery), the assistant relays and their logs, the diagnostics pages, and the telemetry writers. Kept: the application's own endpoints (situations, uploads through the server, same-origin object reads, settings, labels, short links), the fixed-key element-set fetch and the operator wind proxy — the two mechanisms a deployment points at its own mirrors — the administrator information page, and the PHP dependencies.

Two rules about `config.php`. The secure build always packages the tracked `config/config.php.example`, never a checkout's own `config/config.php`, because the example carries the identity seam (`AUTH_MODE`) and the local copy is that checkout's public-site configuration; the build prints a warning when it skips one. And the audit reads the packaged `config.php` and fails if the seam is missing, so an artifact with the wrong file can never pass.

With `S3_READS_VIA_SERVER=true` the server answers every object reference with a same-origin `s3-proxy.php` URL instead of a public or presigned storage URL, for deployments whose browsers cannot reach the storage endpoint. It is off unless set.

## The egress tripwire

`scripts/auditBundleEgress.js` reads every emitted `.js`, `.mjs`, `.html`, `.css` and `.json` file in `dist-secure/`, extracts every `http://host` and `https://host` literal, and fails if a host is not in `scripts/secure-egress-allowlist.json`. It skips `docs/` and `README.html` (rendered documentation, links by nature), `tools/` (the standalone tool pages, outside the application bundle), `data/` (built-in situations and their source attributions), `sitrecServer/vendor/` (server-side library code) and `tests/` (the published test tree: fixture strings the application never executes).

Every allow-list entry states its purpose and its **class**, which says honestly why the literal is in the output:

| Class | Meaning | `mayReceive` |
|---|---|---|
| `inert` (default) | never a request: an XML namespace identifier, a link inside library code, a citation in shader text, a display string, a pattern that recognises a pasted address | must be `["none"]` |
| `link` | a navigation the user starts by clicking; the page never fetches it | what such a click carries, so the disclosure is written down |
| `gated` | fetch or link code is present but sits on a path closed at compile time; `gate` names the control, and only `isSecureBuild` or one of the forced flags (`<FLAG>=false`) is accepted | must be `["none"]` |

The loader refuses any other shape, so the list cannot quietly become a list of permitted egress. A host the application would actually contact at run time is never an entry of any class; it is a finding, and the fix is a stub or a gate. Most gated entries today are the built-in map and elevation providers and their attribution links, which live in the configuration file and are closed by the forced source flags; the rest are closed by `isSecureBuild`. A passing run prints the class summary and every gated and link host, so the artifact's disclosure surface is stated each time, not only when something fails.

The audit also fails on any `.map` file in the output and any `sourceMappingURL=` in emitted JavaScript, because a source map republishes the unminified source, comments included.

To see every host literal in the output with its count and the files it is in:

```bash
node scripts/auditBundleEgress.js dist-secure --list-hosts
```

## Not yet done

This is the first step. Still to come, each as its own change:

- **Response headers.** The Content-Security-Policy is still the partial meta tag every build carries (see `webpack.common.js`). A hardened deployment needs it as a response header, with `connect-src` limited to the deployment's own origin and `frame-ancestors` set; that is web-server configuration this repository does not yet ship.
- **Mirror data source.** The deployment needs its own map, elevation and satellite element-set sources on the isolated network, defined through the custom-source configuration. The build disables the defaults; it does not yet provide the replacement.
- **Menu entries for removed features.** A stubbed feature's menu entry can still be shown and then do nothing (the provider key settings, the aircraft trace and sounding importers, the live-traffic toggle, the street-level view, the AI masking action). Each needs a small `isSecureBuild` gate where the menu is built.
- **An automated browser-level proof.** The manual check below is the proof today. A regression run against the served secure build in a real browser, recording every request origin, would make it repeatable; `test-all-builds.js --config=secure` serves the artifact but needs a machine whose headless browser can create a rendering context.

## Checking the secure build in a real browser

The audits prove what is in the artifact. This check proves what it does at run time, on a development machine whose web server already serves directories under a site root with PHP (the same server the ordinary local build uses).

1. Serve the output next to the ordinary build, for example with a symbolic link from the site root to `dist-secure/`, and open it in the browser.
2. The served `shared.env.php` is the build machine's configuration. For a faithful test add `S3_READS_VIA_SERVER=true` inside its comment block (a rebuild regenerates the file, so re-add it after one), because the development configuration has the setting off.
3. Load a situation with terrain, open the situation browser so thumbnails load, then in the developer console:

   ```js
   // every request origin since the page loaded; expect only the page's own
   [...new Set(performance.getEntriesByType("resource").map(e => new URL(e.name).origin))]
   // the stubs that have executed so far (lazy chunks add theirs when they load)
   globalThis.__SITREC_SECURE_STUBS__
   ```

4. Expected: one origin, no console errors, the terrain menu offers only the deployment's own and synthetic sources, the help menu has no external-links folder, and thumbnails are `sitrecServer/s3-proxy.php?key=…` addresses answered with status 200 (a range request, `curl -H "Range: bytes=0-1023"`, answers 206).

A tile that fails to load now says what it most likely means, in the words of the settings involved (`src/errorHints.js`): a 404 on the pre-downloaded tile directory names the directory, the container mount point and `SITREC_TERRAIN_URL`; a 404 from a remote provider points at the URL template and maximum zoom; a 401 or 403 at a missing or blank key; no answer at all at the isolated-network case and the custom-source settings; the follow-on "ServiceUnavailable" errors point back at the first failure. The sentence appears once per source and kind of failure, in the console in every build and in the error dialog on a development host.

Two things that look like failures and are not. The `featured` list is served with a one-minute cache and stale-while-revalidate, so a page opened before a server-side change can show the previous addresses until the cache turns over; a fetch with `cache: "reload"` proves the server's current answer. And the stub count seen at run time is lower than the number of stubs in the artifact until every lazily loaded chunk has executed; the build-time audit is the count that matters.
