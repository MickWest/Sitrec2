# Shipped and Beta releases

Channel-enabled server installations provide two frontend versions with one
reviewed PHP backend. Shipped is the most recent fully reviewed release. Beta
contains newer frontend changes that passed unit tests, visual regression and a
browser smoke test. Backend, dependency, permission and incompatible save-format
changes use the full release process.

On Metabunk, logged-in members default to Beta. Turn off **Sitrec → Settings →
Use Beta updates** to stay on Shipped. Anonymous visitors default to Shipped and
can explicitly select Beta on that browser. A missing or disabled Beta falls back
to Shipped. When a full release is newer than the current Beta, a Beta preference
opens that release instead, so a Beta user never runs older code than a visitor;
an explicit one-load Beta selection still opens the exact Beta, which a Beta-saved
sitch's handoff relies on. Choosing a version for a single shared file does not
change the saved preference. Changing the preference does not immediately reload
unsaved work.

Beta labels include `b`, a UTC build time and a unique internal build ID. Saved
files retain the creating build's metadata separately from their numeric migration
version. A Shipped reader opening a beta save can open the available Beta, cancel,
or continue in Shipped. Once a reviewed release includes that beta, the release
manifest can suppress the warning for that build ID. Old files continue to load.

## Container setup

The normal container remains the PHP service. A second, read-only static image
serves immutable frontend trees under `/builds/<build-id>/`. Route the application
prefix, for example `/sitrec/builds/`, to that service, retaining the build path.
The static service uses `docker/frontend_server.py` from a reviewed image containing
Python. It runs as an unprivileged user and receives no backend credentials or
writable user-data mounts. All PHP and existing upload/cache/video routes continue
to use the reviewed backend.

Set `SITREC_CHANNELS_ENABLED=true` in the browser runtime configuration and set
`SITREC_CHANNEL_MANIFEST=/opt/sitrec-channels/manifest.json` in the PHP environment.
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
the custom channel header; bootstrap responses must bypass CDN caching.

The small bootstrap selects an asset set before loading the main application. It
keeps the original page URL. `SITREC_APP` identifies the selected assets,
`SITREC_SHARE_APP` identifies the channel-neutral page, and `SITREC_SERVER`
identifies the common API. Use these bases when adding links or resources. Worker
and lazy-chunk URLs remain within their immutable build directory.

## Local quickship artifacts

`scripts/quickship.mjs` freezes a source snapshot and records timing/evidence in
`quickship.json` inside an isolated work directory. Its commands are:

- `prepare`: select a numeric version/channel and explicitly include new files.
  Beta requires the reviewed Shipped baseline. Reviewed changes to the local
  quickship packaging tool are eligible; runtime, backend, authentication,
  dependency and deployment configuration changes require the full release process.
- `units`: run the unit suite against that source snapshot.
- `build`: build production output once with its final identity, generate notices
  and check the resulting browser bundle for secrets.
- `regression`: copy only frontend artifacts into the local preview webroot and
  run the existing visual suite against the supplied URL.
- `package`: package tested frontend artifacts for `linux/amd64`, reusing an
  immutable reviewed runtime. Supply the reviewed delta hash for Beta. A previous
  static image can retain older build directories using the same runtime.
- `import-image`: import Shipped frontend bytes from a reviewed release image whose
  source revision matches the snapshot, avoiding an unnecessary rebuild.

Host transfer, candidate browser smoke, atomic promotion and verified backup follow
packaging. Each deployment adapter must verify all required results and artifact
identities before activation. These commands never create commits, release tags or
GitHub pushes. A locally built beta does not have a GitHub build attestation.

When the quickship tool changes, review its effect on the resulting artifact and
exercise the changed packaging behavior. Retain the exact packager with the build
record. The pinned runtime, inherited image layers, container isolation, candidate
smoke test and backup restore checks still apply.

Compatible frontend defaults in `data/custom/SitCustom.js` are also eligible for
Beta. Review saved-scene compatibility alongside the consuming frontend code.

Isolated quickship builds disable webpack's persistent cache and verify copied
SHF code against the frozen source before packaging.

The standalone SHF browser app is packaged with each new frontend. Its menu link
uses that build's assets, while TLE requests and Open in Sitrec use the common
application entry. Beta handoffs retain a one-load Beta selection. Other tools,
tool build scripts and tool dependency changes are outside this quickship scope.
The existing local-development-only channel-warning exemption is accepted only
when removing that import and early return exactly reproduces reviewed Shipped;
other channel machinery changes still require full ship.

Keep the current Shipped, current Beta and rollback artifacts reachable, including
workers requested by older open tabs. Retain recovery images and source identities
in verified backups before pruning. An image/channel rollback changes code only;
it must never reverse the shared user data. Keep the existing full data-backup and
restore schedule independently of quickships.

Installations that do not enable channels retain their ordinary server,
serverless and desktop behavior. The existing non-container installation remains
available; the quickship deployment process is designed around containers.
