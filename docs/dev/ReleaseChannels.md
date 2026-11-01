# Shipped and Beta releases

Channel-enabled server installations provide two frontend versions with one
reviewed PHP backend. Shipped is the most recent fully reviewed release. A normal
Beta contains newer frontend changes that passed unit tests, visual regression and
a browser smoke test. Backend, dependency, permission and incompatible save-format
changes use the full release process.

Channels are off unless an operator enables them, so an installation that does not
use them needs no action. Serverless, desktop and secure builds (a secure build is
what `npm run build-secure` makes) never use channels: the bootstrap ignores
`SITREC_CHANNELS_ENABLED` in those builds. The existing
non-container installation remains available; the quickship deployment process is
designed around containers.

To join or leave Beta, see [Choosing a version](#choosing-a-version). Operators: see
[Container setup](#container-setup) and [Local quickship artifacts](#local-quickship-artifacts).

## Choosing a version

On any channel-enabled installation, including Metabunk, logged-in users default to
Beta. Turn off **Sitrec → Settings → Use Beta updates** to stay on Shipped.
Anonymous visitors default to Shipped and can explicitly select Beta on that browser.
`?channel=shipped` opens Shipped for one load. Neither this nor choosing a version
for a single shared file changes the saved preference. Changing the preference does
not immediately reload unsaved work.

A missing or disabled Beta falls back to Shipped. This is silent: only a load that
explicitly asked for Beta with `?channel=beta` is told when Beta could not be opened,
so anyone who did not choose Beta sees no channel message at startup.

When a full release has a higher version than the current Beta, that Beta is
retired, so a Beta user never runs older code than a visitor. `channels.php` does
not return it and the bootstrap ignores it, so a Beta preference and an explicit
`?channel=beta` both open Shipped. Equal versions do not retire a Beta.

Beta labels show the version with the suffix `b` and a UTC build time. Each build
also has a unique internal build ID, which is in its `build-info.json`. Saved files
retain the creating build's metadata, including this ID, separately from their
numeric migration version. A Shipped reader opening a beta save can open the
available Beta, cancel, or continue in Shipped. Once a reviewed release includes
that beta, list its build ID in the manifest's `shipped.coveredBetaIds` to suppress
the warning. On a channel-enabled installation, a save from a Beta older than
Shipped needs no entry: it opens in Shipped with no warning, because that Beta is
retired. Old files continue to load.

## Container setup

The normal container remains the PHP service. A second, read-only static image
serves immutable frontend trees under `/builds/<build-id>/`, on port 8080 by default.
Route the `builds/` path under the application prefix to that service, and remove
the prefix. For an application at `/sitrec/`, a request for
`/sitrec/builds/<build-id>/app-entry.json` must reach the service as
`/builds/<build-id>/app-entry.json`. In nginx:
`location ^~ /sitrec/builds/ { proxy_pass http://<host>:8080/builds/; }`. To test the
route, request a build's `app-entry.json`. The service returns 404 for a build's
top-level HTML page, so a retired build cannot open by URL. `/healthz` reports the
health of the service.

The static service uses `docker/frontend_server.py` from a reviewed image containing
Python. It runs as an unprivileged user and receives no backend credentials or
writable user-data mounts. All PHP and existing upload/cache/video routes continue
to use the reviewed backend.

Set both of these as environment variables of the PHP container:
`SITREC_CHANNELS_ENABLED=true` and
`SITREC_CHANNEL_MANIFEST=/opt/sitrec-channels/manifest.json`. The container
entrypoint passes the first to the browser, and the second to PHP only. If the
manifest file is missing, channels stay off and no error appears.
Mount the manifest's directory read-only; mounting an individual file would prevent
atomic replacement from appearing in an already-running container. An example:

```json
{
  "format": 1,
  "betaEnabled": true,
  "shipped": {
    "id": "shipped-example",
    "channel": "shipped",
    "version": "2.155.2",
    "builtAt": "2026-09-09T00:00:00Z",
    "coveredBetaIds": []
  },
  "beta": null
}
```

Build descriptors come from each artifact's `build-info.json`; do not invent an ID
for different bytes. Set `beta` to the tested beta descriptor to publish it.
`channels.php` derives same-origin asset paths and exposes only public fields from
the operator manifest. Its authenticated preferences use a separate private
`settings/<user-id>/channel.json` object so older clients saving ordinary settings
cannot erase an opt-out. Exclude all `settings/` objects from public storage access.
Preference writes require the authenticated user, JSON, same-origin requests and
the custom channel header; bootstrap responses must bypass CDN caching. A visitor
who receives a user ID from `SITREC_DEFAULT_USERID` (`config/shared.env.example`
sets it to 1) counts as logged in: that visitor defaults to Beta, and all such
visitors share one saved preference.

The small bootstrap selects an asset set before loading the main application. It
keeps the original page URL. `SITREC_APP` identifies the selected assets,
`SITREC_SHARE_APP` identifies the channel-neutral page, and `SITREC_SERVER`
identifies the common API. Use these bases when adding links or resources. Worker
and lazy-chunk URLs remain within their immutable build directory.

## Local quickship artifacts

`scripts/quickship.mjs` freezes a source snapshot and records timing/evidence in
`quickship.json` inside an isolated work directory, which every command names with
`--work <dir>`. Its commands are:

- `prepare`: select a numeric version/channel (`--version x.y.z`, and
  `--channel beta|shipped`, default `beta`) and explicitly include new files
  (`--include <path>`, repeatable). Beta requires the reviewed Shipped baseline
  (`--baseline <file>`). For a normal Beta, reviewed changes to the local quickship
  packaging tool are eligible; runtime, backend, authentication, dependency and
  deployment configuration changes require the full release process.
- `units`: run the unit suite against that source snapshot.
- `build`: build production output once with its final identity, generate notices
  and check the resulting browser bundle for secrets.
- `regression`: copy only frontend artifacts into the local preview webroot
  (`--preview <webroot>`) and run the existing visual suite against the supplied URL
  (`--base <url>`).
- `package`: package tested frontend artifacts for `linux/amd64`, reusing an
  immutable reviewed runtime (`--runtime <image digest>`). For a normal Beta, supply
  the reviewed delta hash (`--reviewed-delta <hash>`): `prepare` prints it as
  `deltaHash`. With a previous static image (`--previous <sha256 digest>`), also
  supply the live channel manifest (`--manifest <file>`): the new image copies only
  the builds that the manifest names, so it holds at most three builds (the new
  build, the current Shipped and the current Beta). It does not copy a Beta that is
  older than the manifest's Shipped, because that Beta is retired.
- `import-image`: import Shipped frontend bytes from a reviewed release image
  (`--image ghcr.io/mickwest/sitrec2@sha256:<digest>`) whose source revision matches
  the snapshot, avoiding an unnecessary rebuild.

Host transfer, candidate browser smoke, atomic promotion and verified backup follow
packaging. A deployment adapter does these steps. It is specific to each host, and
this repository does not include one. It must verify all required results and
artifact identities before activation. These commands never create commits, release
tags or GitHub pushes. A locally built beta does not have a GitHub build attestation.

When the quickship tool changes, review its effect on the resulting artifact and
exercise the changed packaging behavior. Retain the exact packager with the build
record. The pinned runtime, inherited image layers, container isolation, candidate
smoke test and backup restore checks still apply.

Compatible frontend defaults in `data/custom/SitCustom.js` are also eligible for
Beta. Review saved-scene compatibility alongside the consuming frontend code.

The Starlink Flare Predictor (SHF), the standalone browser app in `tools/shf/`, is
packaged with each new frontend. Its menu link uses that build's assets, while TLE
(two-line element set, satellite orbit data) requests and Open in Sitrec use the
common application entry. Beta handoffs retain a one-load Beta selection. Other
tools, tool build scripts and tool dependency changes are outside this quickship
scope. Isolated quickship builds disable webpack's persistent cache and verify three
copied SHF files against the frozen source before packaging.

A normal Beta cannot include channel machinery changes, which require full ship. The
one exception is a change to `src/release/ChannelUI.js` that differs from reviewed
Shipped only by the `isLocal` import and early return, which hide the Beta-save
warning on a local host.

Keep the current Shipped, current Beta and rollback builds in the active image. A
tab still open on a build outside that image cannot load its workers or lazy chunks.
Retain recovery images and source identities in verified backups before pruning. An
image/channel rollback changes code only; it must never reverse the shared user
data. Keep the existing full data-backup and restore schedule independently of
quickships.
