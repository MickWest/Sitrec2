# Sitrec Serverless Build

The serverless build runs the Sitrec frontend without PHP, user accounts, or a
server-side upload service. It can be served by the included Node.js static-file helper
or by ordinary static hosting.

"Serverless" describes the application architecture; it does not mean that a browser can
open the build with a `file://` URL. JavaScript modules and workers must be served over
HTTP or HTTPS.

## Quick start

Build the production bundle:

```bash
npm run build-serverless
```

Serve it locally:

```bash
npm run start-serverless
```

Then open `http://localhost:3000/sitrec`.

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
| Visualisation and analysis | Runs in the browser as normal. |
| Custom sitches and imported files | Opened from the user's computer. |
| Local save/load | Uses Sitrec's local file and working-folder workflow. |
| Settings | Kept in browser-local storage. |
| Eligible caches and remembered folder metadata | Kept in IndexedDB. |
| Server saves and file rehosting | Unavailable. |
| User accounts and cloud settings sync | Unavailable. |
| Server-backed AI assistant | Unavailable. |
| PHP proxies | Unavailable; a feature must use a permitted direct source or local data. |

Sitch files are **not** silently saved into IndexedDB. Use **File → Local → Save
Local** or **Save Local As...** to write a file, and **Open Local Sitch** to open one.
For the working-folder workflow, first choose **Select Local Sitch Folder**. Browser
support and permission behavior are described in [Saving and Loading
Sitches](docs/SavingAndLoading.md#saving-to-a-local-folder).

The serverless build does not send imported files to a Sitrec backend. Features that use
an external provider can still make browser-to-provider requests, usually after the user
selects the feature or supplies a key. The complete boundary is documented in [Where
Sitrec Sends Data](docs/UserDataEgressCheck.md).

## Local files, browser storage, and offline use

Three storage mechanisms have separate jobs:

- **Local files/folders** hold saved sitches and copied assets.
- **IndexedDB** holds eligible caches and metadata such as a remembered working-folder
  handle. The browser may require the user to grant folder access again after a restart.
- **Browser settings storage** holds user preferences for that browser profile.

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
bundle is copied to another static host. The helper also returns explicit errors for old
PHP-style save, settings, and proxy requests so unsupported calls fail clearly.

To use another port:

```bash
SITREC_PORT=3001 npm run start-serverless
```

## Static hosting

Upload the contents of `dist-serverless/` to the directory from which the app will be
served. Webpack uses an automatic public path, and Sitrec derives its application path at
runtime, so a subdirectory deployment is supported.

Run the production build rather than copying an old output directory. Its lifecycle step
generates third-party notices and audits the emitted bundle for accidentally included
credentials.

### Terrain on a subdirectory-only host

`filterSourcesForServerless()` in `src/terrainSourceUtils.js` removes built-in sources that
are not marked for serverless use. The default local terrain URL is a sibling of the app
directory, which a host that publishes only one directory cannot serve.

Choose one of these arrangements:

- Define serverless-allowed custom map and elevation sources with
  `SITREC_CUSTOM_MAP_<NAME>_*` and `SITREC_CUSTOM_ELEVATION_<NAME>_*` in
  `config/shared.env`, then select them with `DEFAULT_MAP_TYPE` and
  `DEFAULT_ELEVATION_TYPE`.
- Copy a terrain mirror into the published directory and set
  `SITREC_TERRAIN_URL=./sitrec-terrain/`.

Do not put credentials in the published configuration. Serverless builds deliberately
strip sensitive environment values; provider credentials belong in the user's **Settings
→ API Keys...** workflow where supported.

### GitHub Pages

`.github/workflows/pages.yml` builds and publishes the serverless artifact. It is manually
triggered by default. Set the repository's Pages source to **GitHub Actions**; the workflow
publishes an artifact without committing generated build files to a branch.

A `.nojekyll` marker matters only when Pages is configured to deploy a branch through
Jekyll. It is not required for the Actions artifact workflow.

See [Deploying Sitrec on GitHub
Pages](docs/dev/Deploying-on-GitHub-Pages.md) for the maintained deployment procedure and
its data-egress constraints.

## Configuration

`src/config.default.js` records the default capability flags used by the no-backend mode.
Build-time browser configuration is assembled by `scripts/serverlessClientEnv.js`, and the
runtime module replacement is configured in `webpack.serverless.js`.

When adding a serverless feature, verify all three parts of its contract:

1. it does not depend on a PHP endpoint;
2. required data is local or fetched directly from an explicitly allowed source; and
3. any setting or cache has a browser-local implementation.

## Troubleshooting

### Build directory not found

Run `npm run build-serverless` before starting the helper.

### Settings do not persist

Check the browser console and confirm storage is permitted for the site. Private browsing
and site-data cleanup can make browser-local settings temporary.

### Local save or open is unavailable

The working-folder flow requires the File System Access API. Use a supported browser, or
use the desktop build's native local-file workflow. Re-select **Select Local Sitch Folder**
if a remembered permission has expired.

### A remote asset or provider fails

Check the browser console for CORS or network errors. A serverless build has no general
proxy, so the remote service must permit browser requests, or the asset must be stored
locally.

### Port 3000 is already in use

Set `SITREC_PORT` as shown above, then open the corresponding port.

For installation options that include accounts, server saves, or file rehosting, see
[Installing and Configuring Sitrec](docs/dev/Installing-and-configuring.md).
