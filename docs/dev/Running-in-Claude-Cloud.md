# Running Sitrec in a Claude Code Cloud Session

Result of a feasibility test (2026-09-07) in a Claude Code remote container
(Linux, 4 CPU, 15 GB RAM, Node 22.22.2, npm 10.9.7, PHP 8.4 CLI, no Docker
daemon, pre-installed Playwright Chromium, allowlisted outbound network).

**Verdict: yes.** The serverless build compiles, serves, and renders in
headless Chromium; the webpack dev server runs; the full Jest suite passes
(5644 tests, 0 failures, ~21 minutes on 4 cores).

## Setup steps a fresh cloud clone needs

```bash
npm install                                        # see lockfile note below
cp config/config.js.example config/config.js       # needed by Jest, not the serverless build
cp config/shared.env.example config/shared.env
# config/config-install.js: copy the example, but pin buildFolder if the
# branch name contains slashes (claude/* branches do):
#   module.exports = { dev_path: .../dist/sitrec, prod_path: same, buildFolder: 'sitrec' }
git fetch origin 'refs/tags/*:refs/tags/*' --depth=1   # clone is tagless; see version note
```

These are candidates for the environment's setup script (or a SessionStart
hook), which would also let the `sitrec-bridge` MCP server connect — it failed
at session start only because `node_modules` did not exist yet when the
container launched it (`mcp-server.js` imports `ws` and the MCP SDK from the
repo's `node_modules`). It starts fine after `npm install`.

## What was verified

- `npm run build-serverless-debug`: compiles in ~22 s, secret audit passes.
- `node standalone-serverless.js`: serves on :3000, `/api/health` OK.
- Headless Chromium (SwiftShader): the app boots at `/sitrec/`, WebGL 2.0
  context created, the custom sitch renders both views (stars, frustum, LOS
  measurements, offline-fallback terrain), and `?sitch=nightsky` reaches
  "All pending operations completed" in ~32 s with the textured globe,
  constellation lines and labels, and correct current-time sky.
- `npx webpack serve --config webpack.dev.js`: compiles in ~12 s. The
  in-memory app is served at `/` (the `/sitrec` path serves the on-disk
  `dist/` build, which does not exist until `npm run build`). The app boots;
  `/sitrecServer` PHP calls fail as expected with no backend on :8081.
- `npx jest`: 308 suites passed, 5585 tests (plus 59 in the two suites that
  need `config/config.js`), 0 failures, 75 skipped.

## Environment quirks and workarounds

- **`npm ci` fails on npm 10.9.7** with "Missing: @noble/hashes@2.4.0 from
  lock file". The committed lockfile was written by a newer npm that omits
  optional-peer entries (`@noble/hashes` is an optional peer of
  `@exodus/bytes`, pulled in by jsdom 29). `npm install` works. Fix options:
  regenerate the lockfile with an npm that records those entries, or accept
  `npm install` in cloud sessions.
- **Tagless clone breaks the build**: `getVersionNumber()` in
  `webpack.common.js` runs `git describe --tags` and throws. Either fetch
  tags (above) or set the already-supported `VERSION` env var.
- **Playwright version skew**: the repo's pinned Playwright wants a newer
  bundled Chromium than the container pre-installs. Launch with
  `executablePath: '/opt/pw-browsers/chromium'` instead of downloading.
  Software WebGL needs `--enable-unsafe-swiftshader --use-angle=swiftshader`.
- **Network allowlist**: registry.npmjs.org is reachable; map-tile providers,
  celestrak.org, and openrouter.ai were blocked in this environment. Sitrec
  handles it as designed — five failed tile fetches trigger the offline
  terrain fallback with a dialog. Broaden the environment's network policy if
  cloud sessions need live terrain, TLEs, or AI-model lists.
- **Text sitches** (flir1 etc.) are not URL-loadable at startup under the
  serverless helper — `getsitches.php` deliberately returns `{}` there; only
  JS-class sitches (e.g. `nightsky`) resolve via `?sitch=`. Serverless
  design, not a cloud limitation.
- The Docker dev flow is out (no daemon). PHP 8.4 CLI exists, so a
  `php -S`-based `sitrecServer` on :8081 behind the dev-server proxy looks
  possible but was not tested.
- SwiftShader is CPU rendering: fine for smoke tests and screenshots, slow
  for regression-scale visual work — the same caveat
  `tests_regression/fast-regression/run.mjs` already documents for CI.
