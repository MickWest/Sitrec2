# Accepted egress patterns

The user data egress review reads this file. Each entry below is a pattern that an earlier
review reported and that the maintainer accepted after looking at it, as it is or by changing a
contract in `scripts/egress-allowlist.json`. The same pattern in a later push is not a finding.

**How to apply an entry.** A change matches an entry when it is the same kind of code, sending the
same class of data to the same kind of destination, under the same trigger, within the entry's
limits. Then report it in one line, `Accepted pattern: <id>`, and do not raise ATTENTION for it.
A change that goes beyond an entry — more data, a more revealing form of it, another destination,
a broader trigger, or anything the entry's limits exclude — is a finding: say which limit it
passes. An entry never covers anything listed under "Refused" at the end.

**Adding an entry.** When the maintainer accepts a finding, the release that ships it adds an
entry here: an id, what the code does, where the data goes, the release, and its limits.

## Entries

### `dev-preview-proxy` — accepted 2.179.0
- **Code:** `webpack.local.js`. A preview server that a developer starts by hand proxies to a
  target set in the environment (`SITREC_BACKEND_TARGET`, `SITREC_ASSET_TARGET`).
- **Data:** the developer's own requests, to the host the developer chose.
- **Limits:** development only. No build script, workflow or release image uses it; a release
  image contains only the built `dist/`. Code that reaches a run-time destination in a build that
  ships is not covered.

### `chat-continuation-temp` — accepted 2.183.5
- **Code:** `sitrecServer/chatbot.php` (`savePendingContinuation`). The AI chat stores the state
  of a reply that continues across requests (prompt, history, tool calls and results) in a file in
  the server's temporary directory.
- **Data:** the same fields that were kept in the PHP session before, on the application's own
  server.
- **Limits:** a server temporary file, deleted when it is used, lasting at most 15 minutes. Longer
  retention, another location, or more fields is a finding.

### `tile-provider-recovery-probe` — accepted 2.183.7 (contract widened)
- **Code:** `src/ServiceAvailability.js` (`watchRecovery`). After a map tile provider fails and the
  map falls back to another, the application requests the last failed tile again about once a
  minute, to find out when the provider is back.
- **Data:** tile coordinates (coarse-area) to the original tile provider.
- **Limits:** the providers whose `trigger` in the allow-list names this probe. Positions finer
  than a tile, or other providers, are findings.

### `timing-report-export` — accepted 2.183.11
- **Code:** `src/nodes/CNodeDateTime.js`, `src/showTimingAnalysis.js`. The Timing Analysis report
  shows the video file name (a "Show Filename and Names" checkbox, on by default) and up to five
  raw values from KLV metadata.
- **Data:** text the user copies or downloads. No network request.
- **Limits:** that report only. New fields in other logs or exports are findings.

### `debug-log-file-names` — accepted 2.183.12
- **Code:** `src/CFileManagerParse.js` and other loaders write console lines that name the file
  being loaded. The console goes into Help > Export Debug Log.
- **Data:** file names, in a log that leaves the machine only when the user exports it.
- **Limits:** file names only, in the console. Control values, panel contents, positions or file
  contents in the log are findings (see "Refused").

### `configured-source-authorization` — accepted 2.184.0 (security requirement SR-17)
- **Code:** `sitrecServer/proxy.php`, `curlGetRequest.php` (`curlConfiguredSourceHeaders`),
  `proxyStarlink.php`, `customWindProxy.php`. The server fetches catalogue and wind data from a
  source that the operator sets in configuration (`CURRENT_*`, `CUSTOM_TLE`, `CUSTOM_WIND_URL`)
  and forwards the browser's `Authorization` header to that source. A hardened deployment depends
  on it (`docs/dev/SecurityRequirements.md`, SR-17; `docs/UserDataEgressCheck.md`).
- **Data:** the request and the `Authorization` header, to the host the operator configured.
- **Limits:** operator-configured sources only. Forwarding to a fixed public host (for example the
  default `celestrak.org`) or to every upstream is a finding. Removing the forwarding is not a
  fix: it breaks SR-17.

### `open-meteo-playback-columns` — accepted 2.185.0
- **Code:** `src/nodes/CNodeWind.js`, `src/nodes/CNodeDisplayWindField.js`. With Open-Meteo chosen
  as the wind source, playback fetches a new wind column whenever the point is more than 0.25°
  from the columns already loaded.
- **Data:** a position rounded to 0.01° and a date, to the Open-Meteo hosts, whose contract
  allows a precise position and a time.
- **Limits:** only when the user has chosen Open-Meteo (Manual is the default). A finer position,
  or fetching without that choice, is a finding.

### `local-debug-frame-writer` — accepted 2.158.0
- **Code:** `src/analysis/BotBenchImageCapture.js`. A debug hook POSTs rendered frames to a
  `writerUrl` the caller supplies (default loopback).
- **Data:** rendered frames, to a URL the developer gives.
- **Limits:** the hook is installed only on local development hosts. Installing it on a public
  host, or a caller that sends frames without a developer's action, is a finding.

### `kml-traverse-export` — accepted 2.159.0
- **Code:** `src/ExportCameraKML.js`. The KML/KMZ export holds the whole traverse path, with a
  precise position for each frame.
- **Data:** a file the user chooses to export. No network request.
- **Limits:** a local export the user starts. Uploading it, or adding it to a shared link, is a
  finding.

### `public-folder-link` — accepted 2.155.1
- **Code:** `sitrecServer/object.php`. A public folder link opens, for anyone, the newest public
  save in that folder.
- **Data:** a save the user made public, to anyone with the link.
- **Limits:** public saves only. The private-folder exceptions stay; exposing a private save is a
  finding.

### `audit-log-metadata` — accepted 2.152.0 (contract added)
- **Code:** `sitrecServer/audit.php`. Security audit events go to the PHP error log or the local
  syslog.
- **Data:** the `audit-metadata` class (see the review prompt).
- **Limits:** local logging only. A remote collector, or fields outside that class, is a finding.

### `link-only-hosts` — accepted 2.176.0
- **Code:** `src/FireballUI.js`. Source and licence links that the user clicks, opened with
  `noopener noreferrer`.
- **Data:** none sent by the application; the user follows a link.
- **Limits:** hosts listed in the allow-list with `mayReceive: ["none"]`. A link built from file
  data to an unlisted host is a finding (see "Refused").

## Refused — never covered by an entry

- **A URL parameter that can name any host** for the application to load (2.172.0,
  `tools/shf/stats/viewer.js` `?data=`). Fixed to same-origin only.
- **Links built from an imported file's URL to any host** (2.176.1, `src/FireballUI.js`
  `source.url`). Fixed: only the listed hosts are linked; anything else is plain text.
- **Control values or panel titles in the debug log** (2.183.12, `src/DropdownWatch.js`). Fixed:
  only the control name is logged.
- **Stream descriptor names in a shared copy of a save** (2.184.0, `src/CFileManagerSave.js`
  timing sidecar). Fixed: the shared copy leaves them out.
- **Forwarding the browser's `Authorization` header to every upstream** (removed in 2.183.6).
  Only operator-configured sources may receive it.
