# Sitrec Serverless Build

The serverless build runs the Sitrec frontend without PHP, user accounts, or a
server-side upload service. It can be served by the included Node.js static-file helper
or by ordinary static hosting.

"Serverless" describes the application architecture; it does not mean that a browser can
open the build with a `file://` URL. The browser blocks the app's first request, for
`app-entry.json`, so the files must be served over HTTP or HTTPS.

## Quick start

Use Node.js 22 (`.nvmrc`). In a fresh clone, create the config files and install the
dependencies:

```bash
for f in config/*.example; do cp "$f" "${f%.example}"; done
npm install
```

Build the production bundle:

```bash
npm run build-serverless
```

Serve it locally:

```bash
npm run start-serverless
```

Then open `http://localhost:3000/sitrec`.

A default build has no terrain tiles. Sitrec opens with the Local map source, shows a
`Failed to load texture for tile` error and a grey globe, and changes elevation to Flat. To
show terrain, see [Terrain](#terrain).

For an unminified development build, use:

```bash
npm run build-serverless-debug
npm run start-serverless
```

The `dev-serverless` scripts combine a build and server start, but the two commands above
are usually easier to diagnose separately.

## What changes in this build

| Capability | Serverless behavior |
|---|---|
| Visualisation and analysis | Runs in the browser. |
| Custom sitches and imported files | Opened from the user's computer. |
| Built-in sitches | Sitrec opens the custom sitch. Most others are left out. A URL such as `?sitch=chilean` shows an error and opens the custom sitch instead. |
| Local save/load | Uses a working folder that you select. Needs the File System Access API. |
| Settings | Kept in a browser cookie. |
| Eligible caches and remembered folder metadata | Kept in IndexedDB. |
| Server saves and file rehosting | Unavailable. |
| User accounts and cloud settings sync | Unavailable. |
| AI assistant | Unavailable, including with your own API key. |
| PHP proxies | Unavailable; a feature must use a permitted direct source or local data. |
| Live ADS-B Traffic, keyless Live Feeds, Street View Pano | Unavailable, because they need the Sitrec server. |

Sitch files are **not** silently saved into IndexedDB. Choose **File → Local → Select Local
Sitch Folder** first. **Save Local**, **Save Local As...** and **Open Local Sitch** then
appear in the same menu. In a browser without the File System Access API, these three
commands do not appear. Browser support and permission behavior are described in [Saving
and Loading Sitches](docs/SavingAndLoading.md#saving-to-a-local-folder).

The serverless build does not send imported files to a Sitrec backend. Features that use
an external provider can still make browser-to-provider requests, usually after the user
selects the feature or supplies a key. The complete boundary is documented in [Where
Sitrec sends data today](docs/UserDataEgressCheck.md#where-sitrec-sends-data-today).

## Local files, browser storage, and offline use

Three storage mechanisms have separate jobs:

- **Local files/folders** hold saved sitches and copied assets.
- **IndexedDB** holds eligible caches and metadata such as a remembered working-folder
  handle. The browser may require the user to grant folder access again after a restart.
  It also holds the keys you enter in API Keys, so clearing site data removes them.
- **A browser cookie** holds user preferences for that site in that browser profile.

Storage quotas and persistence rules are browser- and device-dependent. Do not treat a
browser cache as a backup. Keep important sitches and assets in an ordinary backed-up
folder.

The build can be used on an isolated network when its application files, terrain, and
scenario assets are available there. A public static deployment is not automatically an
offline web app, and features that fetch live or remote data still need access to their
source.

## Included Node.js helper

`standalone-serverless.js` serves `dist-serverless/` and provides a few diagnostics:

```text
GET /api/health
GET /api/manifest
GET /api/debug/status
GET /api/debug/files
```

These endpoints belong to the included helper; they do not appear automatically when the
bundle is copied to another static host.

To use another port:

```bash
SITREC_PORT=3001 npm run start-serverless
```

## Static hosting

Upload the contents of `dist-serverless/` to the directory from which the app will be
served. Webpack uses an automatic public path, and Sitrec derives its application path at
runtime, so a subdirectory deployment is supported. Terrain needs its own setup: see
[Terrain](#terrain).

Run the production build rather than copying an old output directory. Its lifecycle step
generates third-party notices and audits the emitted bundle for accidentally included
credentials.

### GitHub Pages

`.github/workflows/pages.yml` builds and publishes the serverless artifact. It runs when a
release tag such as `2.147.2` is pushed, and on demand from the Actions tab. It does not run
on ordinary pushes to `main`. Set the repository's Pages source to **GitHub Actions**; the
workflow publishes an artifact without committing generated build files to a branch.

A `.nojekyll` marker matters only when Pages is configured to deploy a branch through
Jekyll. It is not required for the Actions artifact workflow.

See [Deploying Sitrec on GitHub
Pages](docs/dev/Deploying-on-GitHub-Pages.md) for the maintained deployment procedure and
its data-egress constraints.

## Terrain

A default build has no terrain tiles. `filterSourcesForServerless()` in
`src/terrainSourceUtils.js` removes built-in sources that are not marked for serverless use,
so Sitrec falls back to the Local source. Its default terrain URL is a sibling of the app
directory, which a host that publishes only one directory cannot serve.

A terrain mirror is a folder of pre-downloaded tiles.
`SITREC_TERRAIN_DIR=<folder> MAX_IMG=8 node scripts/download_local_tiles.js` builds one, with
about 93,000 tiles. It has imagery to level 8 and elevation to level 6, the deepest levels
that Local reads.

Choose one of these arrangements:

- Define serverless-allowed custom map and elevation sources with
  `SITREC_CUSTOM_MAP_<NAME>_*` and `SITREC_CUSTOM_ELEVATION_<NAME>_*` in
  `config/shared.env`. Then set `DEFAULT_MAP_TYPE=CustomMap_<NAME>` and
  `DEFAULT_ELEVATION_TYPE=CustomElevation_<NAME>`, and rebuild. Sitrec uses Local if the name
  does not match a source. A remote tile source must allow cross-origin requests from your
  site. `.github/workflows/pages.yml` defines a keyless pair, and [Custom map, elevation,
  and water sources](docs/dev/CustomTerrainSources.md) lists the variables.
- Add these lines to `config/shared.env`, with URLs that point at the mirror on your site. Set
  `_MAX_ZOOM` on each to the deepest level in the mirror, and rebuild. Then copy the terrain
  mirror into the published directory. Do this after the build, because a rebuild deletes
  everything in `dist-serverless/`.

  ```text
  SITREC_CUSTOM_MAP_MIRROR_URL="https://example.org/app/sitrec-terrain/imagery/esri/{z}/{y}/{x}.jpg"
  SITREC_CUSTOM_MAP_MIRROR_MAX_ZOOM=8
  SITREC_CUSTOM_ELEVATION_MIRROR_URL="https://example.org/app/sitrec-terrain/elevation/{z}/{x}/{y}.png"
  SITREC_CUSTOM_ELEVATION_MIRROR_MAX_ZOOM=6
  DEFAULT_MAP_TYPE=CustomMap_MIRROR
  DEFAULT_ELEVATION_TYPE=CustomElevation_MIRROR
  ```

- With the included helper, copy a terrain mirror to `dist-serverless/sitrec-terrain/` after
  the build. The helper serves it at `/sitrec-terrain/`, where Local reads it. A rebuild
  deletes it. The helper allows 1,000 requests in 15 minutes and each tile is a request, so
  use another web server for regular work with a mirror.

Do not put credentials in the published configuration. Serverless builds deliberately strip
sensitive environment values by variable name, but a key inside a custom source URL stays in
the bundle. Provider keys belong in **Sitrec → Settings → API Keys…** where supported. A key
in that dialog does not add a map or elevation source.

## Configuration

Build-time browser configuration is assembled by `scripts/serverlessClientEnv.js`. Its
`SERVERLESS_FORCED_VALUES` turn off server saves, server settings and the assistant. Code
checks `isServerless` from `src/configUtils.js`, and the runtime module replacement is
configured in `webpack.serverless.js`.

When adding a serverless feature, verify all three parts of its contract:

1. it does not depend on a PHP endpoint;
2. required data is local or fetched directly from an explicitly allowed source; and
3. any setting or cache has a browser-local implementation.

## Troubleshooting

### Build directory not found

Run `npm run build-serverless` before starting the helper.

### Settings do not persist

Check the browser console and confirm that the browser allows cookies for the site. Private
browsing and site-data cleanup can make these settings temporary.

### Local save or open is unavailable

The working-folder flow requires the File System Access API. Use a supported browser, or
use the desktop build's native local-file workflow. Browsers offer this API only on HTTPS or
on `localhost`, so plain HTTP at any other address does not work, even in Chrome or Edge. To
use HTTPS with the helper, set `USE_HTTPS=true`.

If a remembered permission has expired, the menu title shows **(reconnect)**. Use **Reconnect
Folder**. If Sitrec remembers your last local sitch file, this also opens it, and it replaces
the current sitch.

### A remote asset or provider fails

Check the browser console for CORS or network errors. A serverless build has no general
proxy, so the remote service must permit browser requests, or the asset must be stored
locally.

### Port 3000 is already in use

Set `SITREC_PORT` as shown above, then open the corresponding port.

For installation options that include accounts, server saves, or file rehosting, see
[Installing Sitrec](docs/dev/Installing-and-configuring.md).
