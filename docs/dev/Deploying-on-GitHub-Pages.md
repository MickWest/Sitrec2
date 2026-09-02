# Deploying Sitrec on GitHub Pages

The copy of Sitrec at `https://mickwest.github.io/Sitrec2/` is the **serverless build**, published by GitHub Actions on every push to `main`. There is no server behind it: no PHP, no accounts, no provider keys. GitHub's static file hosting serves the built files, and everything else happens in the browser.

This page explains what that build is, what it can and cannot do, how it gets published, and how to run or fork it.

## What "serverless" means at build time

The normal Sitrec install is a web app plus a PHP back end (`sitrecServer/`) that handles logins, saves, proxies to data providers, and the AI assistant. The serverless build is the same web app compiled without any of that. `npm run build-serverless` runs `webpack.serverless.js`, which:

- sets `IS_SERVERLESS_BUILD=true` before anything else loads, so the code and the copy rules can tell which build they are in;
- swaps the runtime configuration module for `src/runtimeConfig.serverless.js`, which carries no install-specific values at all;
- builds the client environment with `buildServerlessClientEnv()` in `scripts/serverlessClientEnv.js`. Every provider credential is blanked (map tokens, 3D tile tokens, AI and storage keys), and a few settings are forced off regardless of what the config says: the AI assistant, server and cloud saves, and server-side settings storage;
- generates `manifest.json`, a list of the built-in sitches read from `data/`, which replaces the server's sitch listing. The legacy video sitches that depend on large media files are left out;
- copies only the files a browser needs. `sitrecServer/` is not part of the output;
- after the build, generates the third-party notices and runs `scripts/auditBundleSecrets.js` over the output. A configured key found in any emitted file fails the build, so a leaked credential can never reach a published site.

The result is a directory, `dist-serverless/`, that any static web server can serve.

## What that means when you use it

Everything that runs in the browser works as in a full install: loading tracks, videos, images and models by drag and drop, building custom sitches, the terrain and sky, the analysis tools, rendering video, and the built-in text-only sitches.

What changes:

- **Saves stay in the browser.** There is no server to save to, so sitches and imported files are kept in the browser's own storage (IndexedDB). They persist across visits on the same browser and are not shared anywhere. Settings are stored locally too.
- **No accounts or sharing links.** Login, file rehosting and short links all need the server.
- **No AI assistant.** The assistant relays through the server, so it is off.
- **No street-level imagery**, and no usage statistics are collected.
- **Some live data feeds are unavailable.** Feeds that must go through the server's proxy are off. Feeds that accept the user's own key work, and some sources are fetched directly from the provider instead of via the proxy.
- **The legacy video sitches are absent** (Aguadilla, Gimbal, GoFast and a few others), because their media is not part of the build.

## Terrain on a static host

Terrain is the one thing a static host needs that a normal install provides through configuration. `filterSourcesForServerless()` in `src/terrainSourceUtils.js` removes every map and elevation source that is not marked `allowInServerless`. That removes all the built-in internet providers, because they need keys, and the "Local" source it falls back to reads tiles from a directory a static site cannot serve.

Sources defined through the `SITREC_CUSTOM_MAP_*` and `SITREC_CUSTOM_ELEVATION_*` environment variables do carry that flag. The Pages workflow defines two that need no key and allow cross-origin requests: ESRI World Imagery for the map, and AWS Terrarium tiles for elevation. Those are the only two remote services the site contacts on its own. See [Custom Terrain and Elevation Sources](CustomTerrainSources.md) for the variables.

## How it gets published

`.github/workflows/pages.yml` runs on every push to `main`, and on demand from the Actions tab. A deploy takes about two minutes.

1. A full-depth checkout, because the version string comes from `git describe --tags` and a shallow clone has no tags.
2. The config templates are copied into place. The live config files are gitignored, so a clean checkout has only `config/*.example`.
3. Every placeholder credential (`EXAMPLEKEY`) in the environment file is cleared. An empty value reads as "not configured" everywhere in the app, and the secret audit would otherwise match the placeholder against the app's own source.
4. The two keyless terrain sources above are appended and set as the defaults.
5. `npm install`, then `npm run build-serverless`, which includes the notices and the secret audit.
6. `dist-serverless/` is uploaded as a Pages artifact and handed to the Pages CDN.

**Nothing is written to the repository.** The build is a workflow artifact with a one-day retention, not a commit. The older way of publishing to a `gh-pages` branch commits the whole build on every deploy, and git keeps every version for ever, which is why this workflow does not do that. Repository size is unaffected however often it runs.

Two settings matter:

- **Settings → Pages → Source must be "GitHub Actions".** With the older "deploy from a branch" setting the build succeeds and the deploy step fails.
- **Concurrency.** Deploys are serialised and never cancelled in flight, so a push during a deploy waits for it rather than leaving a half-published site.

The site is about 140 MB in under 500 files, against Pages' 1 GB limit, with the largest file around 12 MB against the 100 MB per-file limit. No `.nojekyll` marker is needed: an Actions deployment serves the artifact as-is.

## Running the same build yourself

```
npm run build-serverless          # builds dist-serverless/ and runs the secret audit
npm run start-serverless          # serves it at http://localhost:3000/sitrec
npm run audit-serverless-bundle   # re-run the audit on its own
```

`standalone-serverless.js` is a small Node server for the output; any static server works. To point the build at your own terrain sources, define the custom source variables in `config/shared.env` before building.

## Forks

### Getting a fork's site running

The workflow contains nothing specific to this repository, so a fork can publish its own copy with four steps:

1. Fork the repository on GitHub.
2. Open the fork's **Actions** tab and enable workflows. A fork starts with all workflows switched off, and the tab shows a button to turn them on.
3. In the fork's **Settings → Pages**, set **Source** to "GitHub Actions".
4. Run a first deploy: **Actions → Deploy to GitHub Pages → Run workflow**, or push any commit to `main`.

The site appears at `https://<your-account>.github.io/Sitrec2/`. The path is the repository name, so a renamed fork gets the new name in the URL. To use a different map or elevation provider, or one with a key, change the "use keyless terrain sources" step in the fork's copy of the workflow; a key placed there is public, so only use one that is meant to be, such as a key restricted to the site's own domain.

### A fork does not update itself

A fork is a copy of the repository at the moment it was made. Its site is rebuilt only by its own copy of the workflow, and that runs only on a push to the fork's `main`. New Sitrec releases in this repository do not reach the fork on their own. There are three ways to bring them across.

#### Option 1: sync by hand

Every one of these ends in a push to the fork's `main`, which runs the deploy.

- **On the web.** On the fork's page, click **Sync fork**, then **Update branch**. If the fork has commits of its own that conflict with upstream, GitHub offers to discard them or to open a pull request instead.
- **With the GitHub CLI**, from anywhere:

  ```
  gh repo sync <your-account>/Sitrec2
  ```

  This updates the fork on GitHub from its parent by fast-forward. It refuses if the fork's `main` has diverged; `--force` resets the branch to upstream and discards the fork's own commits on it. Run inside a clone with no argument, it syncs the clone instead of the fork.
- **With git**, from a clone of the fork:

  ```
  git remote add upstream https://github.com/MickWest/Sitrec2.git   # once
  git fetch upstream
  git merge upstream/main          # or: git rebase upstream/main, if you keep your own commits
  git push origin main
  ```

#### Option 2: a scheduled sync workflow in the fork

Add this file to the fork as `.github/workflows/sync-upstream.yml`. Once a day it merges this repository's `main` into the fork and, if anything changed, starts the deploy.

```yaml
name: Sync from upstream

on:
  schedule:
    - cron: '17 4 * * *'   # daily at 04:17 UTC; choose your own minute
  workflow_dispatch:

permissions:
  contents: write
  actions: write

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - name: merge upstream main
        id: merge
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git remote add upstream https://github.com/MickWest/Sitrec2.git
          git fetch upstream main
          BEFORE="$(git rev-parse HEAD)"
          git merge --no-edit upstream/main
          if [ "$(git rev-parse HEAD)" != "$BEFORE" ]; then
            git push origin main
            echo "changed=true" >> "$GITHUB_OUTPUT"
          else
            echo "changed=false" >> "$GITHUB_OUTPUT"
          fi

      # A push made with the workflow's own token does not trigger other workflows
      # (GitHub prevents recursive runs), so the deploy has to be started explicitly.
      # Dispatching a workflow is the one thing that token is allowed to trigger.
      - name: deploy
        if: steps.merge.outputs.changed == 'true'
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh workflow run pages.yml --ref main -R "$GITHUB_REPOSITORY"
```

Three things to know about it:

- **Enable it after adding it.** Scheduled workflows in a fork are disabled by default. Open it in the Actions tab and click **Enable workflow**.
- **It goes to sleep after two quiet months.** On a public repository, GitHub disables a scheduled workflow after 60 days with no activity in the repository. If this repository has had no releases for that long, the fork's schedule stops until someone re-enables it from the Actions tab. Running it by hand from the same tab is a good habit after a long gap.
- **Merge conflicts stop it.** The merge fails, and the run is red, only when the fork and this repository have changed the same lines. Keeping the fork's own changes small, ideally just the terrain step in the workflow, keeps that rare. When it happens, sync by hand once and resolve the conflict.

#### Option 3: build from upstream on a schedule

If the fork exists only to publish a site, it need not track this repository's content at all. In the fork's copy of `pages.yml`, add a schedule to the triggers and point the checkout at this repository:

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch:
  schedule:
    - cron: '17 4 * * *'
```

```yaml
      - uses: actions/checkout@v6
        with:
          repository: MickWest/Sitrec2
          ref: main
          fetch-depth: 0
```

The workflow that runs is still the fork's own file, so its terrain step and any other changes to the workflow itself still apply. Every other file in the fork is ignored; the site is built from this repository as it stands each morning. The 60-day sleep rule applies here too, and the build runs whether or not anything changed, which costs nothing on a public repository.

#### Choosing

| | Setup | Updates arrive | The fork's own changes |
|---|---|---|---|
| Sync by hand | none | when you remember | kept |
| Scheduled sync | one workflow file, enabled once | daily, until a quiet period puts it to sleep | merged in |
| Build from upstream | two lines in the workflow | daily, same sleep rule | only the workflow file counts |

For comparison, a container deployment such as the [VPS install](Deploying-on-a-VPS.md) pulls each new release image on a timer, with no action in the fork at all. Pages has no equivalent, because a Pages site is a static artifact that only the repository's own workflow can replace.

## What the site sends where

Because there is no server, the site itself receives nothing from its users. The page contacts the two tile providers above while the map is shown, and any data source a user explicitly invokes with their own key. Loaded files never leave the browser. The repository's [User Data Egress Check](../UserDataEgressCheck.md) records, per destination, what the application is designed to send.
