# The Secure Build

The secure build is the production server build with outbound features removed or closed at compile time. It is for a hardened deployment on an isolated network, the AWS shape in [Installing Hardened Sitrec on AWS](Installing-Hardened-Sitrec-on-AWS.md): a site that runs its own Sitrec server, saves through that server, and must never contact anything else. The build alone does not yet meet that last requirement: see [Not yet done](#not-yet-done). It reuses the server build, with only an allow-listed part of `sitrecServer/`, so the result is a normal install to run behind a web server with PHP, not a static bundle. This page calls any other build a **standard build**.

Three things make it different from `npm run deploy`:

1. **Outbound features are removed or closed, not left to a setting.** Most code that would call an AI provider, a data feed or a public site is replaced at compile time by a stub. That code is not in the output, so no setting, no runtime override and no saved file can turn it back on. The built-in map and elevation providers stay in the output, and the forced settings in item 2 close them. A few other features are gated on `isSecureBuild`.
2. **Default external data sources are off.** The built-in internet map and elevation sources and the dated satellite entries are disabled by settings the build forces, whatever the configuration says. The deployment supplies its own map and elevation sources through the custom-source configuration. The two current satellite catalogues work differently: **Load CURRENT Starlink** and **Load ACTIVE Satellites** appear when `CURRENT_STARLINK` and `CURRENT_ACTIVE` are set, and the server fetches those addresses. `config/shared.env.example` sets both to a public host, and `proxy.php` falls back to that host when `CURRENT_STARLINK` is unset, so set both to your own mirror: see [Not yet done](#not-yet-done).
3. **Runtime overrides can only tighten.** A container entrypoint may still inject settings at run time (`window.__SITREC_ENV__`), but in this build a security flag the build set to `"false"` cannot be set to anything else, and a credential cannot be put back that way.

The output is audited after every build. A failed audit makes the command exit with an error, but `dist-secure/` stays on disk, so do not package it.

Those audits judge the **bundle** — a directory a web server will serve. Once the bundle is
packaged into a container image the exposure changes, because anyone who can pull the image
reads every layer directly and no web server stands in the way. That is a separate review:
see [Container Security Review](Container-Security-Review.md).

## Building and auditing

```bash
npm run build-secure          # production build to dist-secure/, then the audits
npm run audit-secure-bundle   # re-run the audits on an existing dist-secure/
npm run build-secure-debug    # unminified, with eval source maps, for debugging only
node test-all-builds.js --quick --config=secure   # serve dist-secure/ with PHP and load it
```

`build-secure` runs `webpack.secure.js` in production mode, writes to `dist-secure/` (cleaned first), then in `postbuild-secure`:

- generates the third-party notices from the bundle's own module list;
- runs `scripts/auditBundleSecrets.js --mode=secure dist-secure`. The secure mode of the secret scan expects a server tree (`sitrecServer/`, and `shared.env.php` with its `<?php` guard, whose content is not served) and allows no credential anywhere else, including the two keys a standard server build is permitted to publish. A configured credential appearing in any other file fails the build;
- runs `scripts/auditBundleEgress.js dist-secure`, the egress tripwire described below.

The debug variant is the same configuration with `--mode development`: unminified, with eval source maps, `[name].bundle.js` file names. Its post-build step runs the secrets audit and the egress audit with `--allow-source-maps`. It is never the deployed artifact.

The build reads `config/shared.env` (or the file `SITREC_SHARED_ENV` names) exactly as a standard production build does, so a checkout that builds for several deployments can make a secure build for any of them.

## What the build forces

`scripts/secureClientEnv.js` builds the client environment. It merges `config/shared.env.example` under the live `shared.env`, blanks every sensitive key (any key on the explicit credential list, or with `TOKEN`, `SECRET`, `PASSWORD`, `ACCESS_KEY`, `API_KEY` or `API` in its name), then forces:

| Setting | Value | Effect |
|---|---|---|
| `IS_SECURE_BUILD` | `true` | identifies the build to the code (`isSecureBuild` in `src/configUtils.js`) |
| `CHATBOT_ENABLED` | `false` | the AI assistant relay is off; with it off, the page also creates none of the assistant's Settings entries and never asks the server for a model list |
| `SITREC_TRACK_STATS` | `false` | no visit counter, no tile-usage statistics |
| `LOG_UI_INTERACTIONS` | `false` | no menu-click logging |
| `SITREC_ENABLE_DEFAULT_MAP_SOURCES` | `false` | the built-in internet map providers are removed from the source list |
| `SITREC_ENABLE_DEFAULT_ELEVATION_SOURCES` | `false` | the built-in internet elevation providers are removed |
| `SITREC_ENABLE_DEFAULT_TLE_SOURCES` | `false` | the LEO, SLOW and ALL satellite load entries are off; the two current catalogues are not (see above) |
| `USE_S3_PRESIGNED_URLS` | `false` | uploads go through the server, not straight to storage. Reads are separate: without `S3_READS_VIA_SERVER=true` the browser still reads from the storage endpoint |

Only settings the browser is meant to see are embedded at all. The list is the container entrypoint's `CLIENT_VARS` block in `docker/entrypoint.sh`, read at build time so there is one source of truth, plus any `SITREC_CUSTOM_MAP_*`, `SITREC_CUSTOM_ELEVATION_*` or `SITREC_CUSTOM_SOUNDING_*` name. A server-only setting (a forum path, an upload directory, a custom feed address) is not compiled into the page, blanked or otherwise. Within that list everything else in `shared.env` passes through as a benign setting: banner text, default map type, the custom source definitions, the local host name. At run time the server is a separate route: `sitrecServer/config_paths.php?FETCH_CONFIG` returns every environment variable whose name starts with `SITREC_`, with no blanking, and the ratchet does not apply to it. Do not put a credential in a `SITREC_` name.

Deliberately **not** forced: `SAVE_TO_SERVER`, `SAVE_TO_S3` and `SETTINGS_SERVER_ENABLED`. A hardened deployment saves through its own server, and the server decides where a file may go. The build does not remove the save feature.

The seven flags below `IS_SECURE_BUILD` are the build's **security flags**. `src/secureFlags.js` carries the same list for the bundled code, and `tests/secureClientEnv.test.js` fails if the two copies drift.

## Runtime overrides: the ratchet

`getEnv()` in `src/envUtils.js` reads a runtime override from `window.__SITREC_ENV__` before the compile-time value. This is how a container is configured without a rebuild, and it still works in the secure build, with two rules that apply only there:

- a **security flag** the build set to `"false"` stays `"false"`: a runtime value of `"false"` is accepted, anything else (`"true"`, `"1"`, an empty string) is ignored;
- a **sensitive key** (same rule as the build) is ignored outright, so a token blanked at build time cannot be supplied at run time.

Every other setting can be set at run time as usual. In every other build `getEnv()` is unchanged; the checks are compiled out. `tests/envUtilsSecureRatchet.test.js` proves both halves.

## The user's SITREC_ ENV Override

A user can also replace settings for their own browser, with **Sitrec → Settings → SITREC_ ENV Override…** (see [the Settings Manager](SettingsManager.md#sitrec_-env-override)). In every build that override is default-deny: a line is used only if its name starts with `SITREC_` and matches a pattern in the installation's `ALLOW_OVERRIDE` list. With no list, or an empty one, a user can override nothing and the menu entry is not shown. So a user cannot add a map, elevation or water source, or any other setting, that the installation did not allow.

The secure build adds its own rule on top, in `userOverrideAllowed()` in `src/envUtils.js`: a user can set a security flag only to `"false"`, whatever value the installation sent, and cannot supply a credential. `tests/EnvOverride.test.js` covers the list and this rule.

## What is removed

`scripts/secureStubs.js` maps each original module to its stub under `src/secureStubs/`. `webpack.secure.js` applies the map after module resolution, so every import of an original, however it is written, resolves to the stub. The build warns if the map file is absent (then nothing is stubbed) and fails if the map names a stub that does not exist.

Each stub leaves a marker string in the bundle, listed in the map as `removedMarkers`, and the map lists the host names of the originals as `originalHostLiterals`. The egress audit checks both: every marker must appear in the emitted code, and no original host name may. The current list of stubbed modules is the `aliases` map in `scripts/secureStubs.js`; when that file is absent, the build and the audit both say so.

Stubbed today: the startup geolocation lookup, menu-click and tile-usage telemetry, the local compute bridge, the browser-side model clients and the provider key store, dialog and model catalogue, the voice session, the sky-mask client, the live-feed registry, overlay and layer, the public-site importers (forum threads, source videos, records), the aircraft trace and live fetchers, the sounding fetcher, the photorealistic-tiles authentication, the street-level panorama node, and the OCR library loader (the library fetches its worker and language files from a public CDN by default).

A few modules stay because they have other work to do, and are **gated** inside on `isSecureBuild` instead: the wind field's weather lookup (and the wind-source list drops that option), the place-name geocoder in the command box, the startup approximate-location call, the help menu's external links and functions from the configuration file, and the "open in Google Maps" entry of the ground context menu. The map lists the weather and geocoder hosts as `gatedHostLiterals`, and the audit requires a matching gated allow-list entry for each. Any other host is gated in the allow-list only.

## What the server ships

The secure build packages only the server files named in `scripts/secure-server-allowlist.json`; `webpackCopyPatterns.js` turns every other file under `sitrecServer/` into an ignore pattern for this build only. Left out: every endpoint that fetches from a public data provider on the browser's behalf (aircraft, soundings, live feeds, satellite history, global wind, source videos, street-level imagery), the assistant relays and their logs, the diagnostics pages, and the telemetry writers. Kept: the application's own endpoints (sitches, uploads through the server, same-origin object reads, settings, labels, short links), the fixed-key element-set fetch and the operator wind proxy — the two mechanisms a deployment points at its own mirrors — the administrator information page, and the PHP dependencies.

Two rules about `config.php`. The secure build always packages the tracked `config/config.php.example`, never a checkout's own `config/config.php`, because the example carries the identity seam (`AUTH_MODE`) and the local copy is that checkout's public-site configuration; the build prints a warning when it skips one. And the audit reads the packaged `config.php` and fails if the seam is missing, so an artifact with the wrong file can never pass.

With `S3_READS_VIA_SERVER=true` the server answers every object reference with a same-origin `s3-proxy.php` URL instead of a public or presigned storage URL, for deployments whose browsers cannot reach the storage endpoint. It is off unless set.

## The egress tripwire

`scripts/auditBundleEgress.js` reads every emitted `.js`, `.mjs`, `.html`, `.css` and `.json` file in `dist-secure/`, extracts every `http://host` and `https://host` literal, and fails if a host is not in `scripts/secure-egress-allowlist.json`. It does not read `.php` files, so it says nothing about what the server fetches, and it matches only `http` and `https` addresses with a dotted host name. It skips `docs/` and `README.html` (rendered documentation, links by nature), `tools/` (the standalone tool pages, which the artifact still ships; see [Not yet done](#not-yet-done)), `data/` (built-in sitches and their source attributions) and `sitrecServer/vendor/` (server-side library code).

Every allow-list entry states its purpose and its **class**, which says honestly why the literal is in the output:

| Class | Meaning | `mayReceive` |
|---|---|---|
| `inert` (default) | never a request: an XML namespace identifier, a link inside library code, a citation in shader text, a display string, a pattern that recognises a pasted address | must be `["none"]` |
| `link` | a navigation the user starts by clicking; the page never fetches it | what such a click carries, so the disclosure is written down |
| `gated` | fetch or link code is present but sits on a path closed at compile time; `gate` names the control, and only `isSecureBuild` or one of the forced flags (`<FLAG>=false`) is accepted | must be `["none"]` |

The loader refuses any other shape, so the list cannot quietly become a list of permitted egress. A host the application would actually contact at run time is never an entry of any class; it is a finding, and the fix is a stub or a gate. Most gated entries today are the built-in map and elevation providers and their attribution links, which live in the configuration file and are closed by the forced source flags. The rest are closed by `isSecureBuild`, except `celestrak.org`, which is listed under the satellite source flag and is the address in the two current-catalogue settings. A passing run prints the class summary and every gated and link host, so the artifact's disclosure surface is stated each time, not only when something fails.

The audit also fails on any `.map` file in the output and any `sourceMappingURL=` in emitted JavaScript, because a source map republishes the unminified source, comments included.

To see every host literal in the scanned files, with its count and up to five of the files it is in:

```bash
node scripts/auditBundleEgress.js dist-secure --list-hosts
```

## Not yet done

Still to come, each as its own change:

- **Response headers.** The build and the container image give the application page no Content-Security-Policy beyond the partial meta tag every build carries (see `webpack.common.js`). A hardened deployment needs it as a response header, with `connect-src` limited to the deployment's own origin and `frame-ancestors` set. The AWS deployment module inserts one at its load balancer: see [Installing Hardened Sitrec on AWS](Installing-Hardened-Sitrec-on-AWS.md), section 8.1. Any other web server must set its own: see [Security Headers](SecurityHeaders.md). Until that header is in place, the browser still fetches a remote address it is given, for example in `?custom=<url>`. The build does not check the origin of such an address.
- **Standalone tools.** The build still copies `tools/` into the artifact, and **Sitrec → Extra Tools** still links to it. Some tools contact public hosts directly. For example, the **Starlink Flare Predictor** falls back to a public host for its satellite catalogue, and it looks up places through a public geocoder. Until the build leaves these tools out, use the response header above to stop those requests.
- **Mirror data source.** The deployment needs its own map, elevation and satellite element-set sources on the isolated network. Maps and elevation use the `SITREC_CUSTOM_MAP_*` and `SITREC_CUSTOM_ELEVATION_*` settings. Current element sets use `CURRENT_STARLINK` and `CURRENT_ACTIVE`. Each of these two addresses must end in `.csv`, with no query string, because `proxy.php` takes the file type from the address. Set all of these settings at run time, in the container environment or in the served `shared.env.php`. Do not set them in the file the build reads: the build compiles them into the page, and the egress audit fails on a host that is not in its allow-list. Do not set `SITREC_USE_CUSTOM_TLE`: its endpoint, `proxyStarlink.php`, is not in this build. The build disables the defaults; it does not yet provide the replacement.
- **Menu entries for removed features.** A stubbed feature's menu entry can still be shown and then do nothing (the provider key settings, the aircraft trace and sounding importers, the live-traffic toggle, the street-level view, the GFS (NOAA), UWYO Soundings and IGRA2 Soundings entries of the wind-source list, and, for an administrator, the AI masking action). Each needs a small `isSecureBuild` gate where the menu is built.
- **An automated browser-level proof.** The manual check below is the proof today. A regression run against the served secure build in a real browser, recording every request origin, would make it repeatable; `test-all-builds.js --config=secure` serves the artifact but needs a machine whose headless browser can create a rendering context.

## Checking the secure build in a real browser

The audits prove what is in the artifact. This check proves what it does at run time, on a development machine whose web server already serves directories under a site root with PHP (the same server a standard local build uses).

1. Serve the output next to the standard build, for example with a symbolic link from the site root to `dist-secure/`, and open it in the browser.
2. The served `shared.env.php` is the build machine's configuration. For a faithful test add `S3_READS_VIA_SERVER=true` inside its comment block (a rebuild regenerates the file, so re-add it after one), because the development configuration has the setting off.
3. Open the Network panel of the developer tools before you load the page. Load a [sitch](../Glossary.md) with terrain and open the sitch browser so thumbnails load. Filter the panel with `-domain:<your host>`. Do not use `performance.getEntriesByType("resource")` for this check: the browser keeps 250 entries by default, and a page load alone can fill them. Then in the developer console:

   ```js
   // the stubs that have executed so far (lazy chunks add theirs when they load)
   globalThis.__SITREC_SECURE_STUBS__
   ```

4. Expected: no row in the filtered panel that names another host, no console errors, the terrain menu offers only the deployment's own and synthetic sources, the help menu has no external-links folder, and thumbnails are `sitrecServer/s3-proxy.php?key=…` addresses answered with status 200 (a range request, `curl -H "Range: bytes=0-1023"`, answers 206).

A map tile that fails to load says what it most likely means, in the words of the settings involved (`src/errorHints.js`): a 404 on the pre-downloaded tile directory names the directory, the container mount point and `SITREC_TERRAIN_URL`; a 404 from a remote provider points at the URL template and maximum zoom; a 401 or 403 at a missing or blank key; no answer at all at the isolated-network case and the custom-source settings; the follow-on "ServiceUnavailable" errors point back at the first failure. The sentence appears in the console, once per source and kind of failure.

Two things that look like failures and are not. The `featured` list is served with a one-minute cache and stale-while-revalidate, so a page opened before a server-side change can show the previous addresses until the cache turns over; a fetch with `cache: "reload"` proves the server's current answer. And the stub count seen at run time is lower than the number of stubs in the artifact until every lazily loaded chunk has executed; the build-time audit is the count that matters.
