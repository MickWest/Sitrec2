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

### `timing-report-export` — accepted 2.183.11; its 2.184.0 extension accepted 2026-11-08
- **Code:** `src/nodes/CNodeDateTime.js`, `src/analysis/MisbTimingStats.js`,
  `src/showTimingAnalysis.js`. The Timing Analysis report. With its "Show Filename and Names"
  checkbox on (the default), it shows the loaded file names and track names, and for each KLV
  stream: up to five different values of each identity tag (mission ID, platform tail number,
  call sign or track ID, platform designation, image source sensor) and of each local set; up to
  five raw values of each tag that Sitrec does not decode; the stream and descriptor names in the
  TS file; the first time stamp of the stream; and the sun height at that time. With the checkbox
  off, each value that can hold a name or an identifier shows as "hidden".
- **Data:** text that the user copies or downloads from the report dialog. No network request.
- **Limits:** that report, and only when the user selects Copy or Download. These values in
  another log, export, save or shared link are findings (see "Refused": descriptor names in a
  shared copy of a save). The report shows no position, only the median distance between two
  streams and the sun height; a position in it is a finding.

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

### `wind-grid-reload-on-sitch-load` — accepted 2.189.0 (contract widened)
- **Code:** `src/nodes/CNodeDisplayWindField.js` (`modDeserialize`), `src/CustomManagerSerialize.js`
  (`finishDeserialization`). When a saved sitch opens with its grid wind field visible, the
  application requests the wind grids for the sitch time again. It does this when the sitch holds
  no wind files, and also after it restores saved wind files, to blend the two grid times.
- **Data:** a date, an hour and a pressure level (time), to the application's own `windProxy.php`
  or `customWindProxy.php`. No position.
- **Limits:** only a grid wind field that the saved sitch shows as visible. A request when that
  wind field is hidden, a position or any other field in the request, or another destination is a
  finding.

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

### `doppler-search-terrain-tiles` — accepted 2.193.0 (contract widened), widened again 2.194.1
- **Code:** `src/doppler/DopplerElevation.js`, used by `src/doppler/DopplerArchiveSearch.js`. A
  Doppler geolocation archive search gets the ground height of each candidate location from the
  public Terrarium elevation tiles, also when no terrain is shown.
- **Data:** tile coordinates at zoom 11 (coarse-area) for the candidate locations, to
  `s3.amazonaws.com` (`elevation-tiles-prod`).
- **Limits:** only during an archive search that an administrator or a logged-in user starts in
  the Doppler geolocation tool. Until 2.194.0 the tool was for administrators only; from 2.194.1
  it is for administrators and logged-in users. A finer zoom, a position finer than a tile,
  another destination, a fetch without that search, or the tool open to a visitor with no login
  is a finding.

### `published-sitch-lists` — accepted 2.193.0 (contract widened)
- **Code:** `sitrecServer/metadata.php` (`updateFeatured`, `updateTemplates`, `?featured=1`,
  `?templates=1`) and `sitrecServer/getsitches.php` (`isPublishedSitch`). An administrator puts a
  saved sitch on one of two shared lists: the featured sitches (`metadata/featured.json`) or the
  global templates (`metadata/templates.json`). Anyone can read the two lists without login, and
  also the list of saved versions of a sitch that is on one of them.
- **Data:** for each sitch on a list: its name, the id of its owner, its date, its screenshot
  reference and the addresses of all of its saved versions, to any visitor.
- **Limits:** these two lists only, and only an administrator can write them. A write by another
  user, a third list, more fields in an entry, or the version list of a sitch that is on no list
  given to a caller who is not its owner or an administrator, is a finding.

### `point-track-csv-filename` — accepted 2.195.0
- **Code:** `src/pointFrequency/CNodePointTrackFrequencyGraphView.js`, the Export CSV button of
  Frequency Analysis. The name of the downloaded file holds the name of the point track. Each
  character that is not a letter, a digit, `_` or `-` becomes `_`, for example
  `PointTrackFrequency-Track_2.csv`. The track name is a label that the user types, or the
  default `Track N`.
- **Data:** the track label, in the name of a local file that the user chooses to export. No
  network request.
- **Limits:** the name of that local file only, and only when the user selects Export CSV. The
  track name in a URL, an upload, a shared link, a log or a server request is a finding.

### `navigation-pins-in-sitch` — accepted 2.199.0
- **Code:** `src/CFeatureManager.js` (`addLocationPin`), called from `src/GoTo.js`
  (`applyGoToString`, the G prompt and pasted text), `src/CSitrecAPI.js` (`gotoLLA`) and
  `src/CClientNLU.js`. When the user goes to a place name or a coordinate, Sitrec drops a
  feature pin there. Its label is the place text that the user gave (or the coordinates), and it
  is the same visible, editable and deletable pin that Drop Pin makes.
- **Data:** the pin's label and position, as part of the sitch. They leave only through the
  actions that already send a sitch: the user's own save, export or share. No new destination and
  no new request.
- **Limits:** a pin that is visible in the scene and is saved only with the sitch. The pin's
  label or position in a URL parameter, a log, a request of its own, telemetry, or any send
  that the user did not start is a finding.

### `gfs-archive-grids-from-ncei` — accepted 2.201.2 (contract widened)
- **Code:** `sitrecServer/windProxy.php` and `tools/fetch_wind.py` (`build_ncei_url`,
  `download_from_ncei`, `download_indexed_grib`). For a GFS cycle before 2021-03-22 12Z, which
  the NOMADS and AWS sources do not hold, the server reads the GFS analysis grid from the NOAA
  NCEI archive: first its `.grb2.inv` inventory, then byte ranges of the requested level.
- **Data:** the date and hour of the cycle (time), in the path of a whole-globe grid file, sent
  by the application's server to `www.ncei.noaa.gov`. The browser does not contact NCEI. No
  position, and nothing about the user.
- **Limits:** server-side requests for whole-globe GFS grids, only for cycles before
  2021-03-22 12Z, under the same trigger as the other GFS sources (the user enables GFS wind,
  or a saved sitch reloads its visible grid wind field). A position or an area in the request,
  a request from the browser, another destination, or NCEI use for later cycles is a finding.

### `selected-account-input-recording` — accepted 2.203.0
- **Code:** `src/InputRecording.js`, `src/UILogging.js`, `sitrecServer/inputlog.php` and
  `sitrecServer/input_recording.php`. For two authorized accounts only (user IDs 1 and
  99999999, from the login that the server checks), the browser sends batches of UI input
  events to the application's own `inputlog.php`. The server appends them to JSONL files in the
  directory that `INPUT_RECORDING_DIR` names.
- **Data:** control paths and values, pointer gestures, shortcuts, sitch and track
  names, and scene and timing context, which can include a precise position and a time, with
  the user ID and a session identifier. Checkbox, number, range, color, date and time controls
  record their value, and a list records its selected option. A control path is a fixed path
  or element id that the code sets, or else the label of the element under the pointer (or of
  its control) as the page shows it: its accessible name, its title or placeholder, or the
  text of a button, link, menu item or option. The element need not be a control: the title
  of a table cell or of any other element is recorded the same way. That label can be text
  that the user made or imported, for example the name of a sitch label in the sitch browser
  (an element title), the text of a link in the sitch Notes, or a description in an imported
  data table (widened 2.203.0, and again after its release check). A URL in a label keeps only its origin and path: the recorder
  removes its query, its fragment and any user name and password, and it redacts text in the
  form of an API key or a bearer token. The text typed into a text field is never recorded,
  only its length. A password field, or a control whose name or label names a password, a
  secret, a credential, an API key, an access token, authorization or a user name, has its
  value redacted. The files stay on the application's
  own server, outside the web root, until an operator archives or deletes them. No other host
  receives them.
- **Limits:** those two accounts only, and only while an absolute `INPUT_RECORDING_DIR` is
  configured. With the directory set, the recorder is on when `INPUT_RECORDING_ENABLED` is
  unset or true, and any other value turns it off. Recording for another account or a visitor,
  the text typed into a text field, a password, a URL query or fragment, text taken from
  anything other than the path, label or value of the element under the pointer or of its
  control as described above, a directory inside the web root or a public mount, or a send to
  another host is a finding.

### `ground-locked-track-tiles` — accepted 2.203.0 (contract widened)
- **Code:** `src/TrackGroundCache.js` (`TrackLoadRegion`, `TrackGroundCache`), used by
  `src/nodes/CNodeBuildings3DTiles.js`. While Google photorealistic 3D tiles are the ground,
  each track that is locked to the ground (*Lock Altitude* with *Height From* = *Ground*) gets
  a load region of 45 m spheres every 20 m along its path. The 3D tiles renderer loads the
  finest tiles in that region, offscreen parts included, so that the locked heights follow the
  drawn ground. This also happens when a saved sitch with such a track opens.
- **Data:** the requests for the tiles along the track, to `tile.googleapis.com`. Together they
  show the route of the track at about 45 m. No other field.
- **Limits:** only while Google photorealistic 3D tiles are shown, and only for tracks that are
  locked to the ground. A wider region, tiles for a track that is not locked to the ground,
  another tile host, or any other data in the requests is a finding.

### `sea-level-inundation-tiles` — accepted 2.206.0 (contract widened)
- **Code:** `src/water/SeaLevelInundation.js`, `src/water/InundationTerrain.js` and
  `src/WaterMaskGeo.js` (`loadOceanMaskRegion`), used by `src/nodes/CNodeTerrainUI.js`. While
  the Sea Level surface is shown with *Inundation* on (the default when Sea Level is shown),
  the application loads the vector water tiles and the elevation tiles for the whole Coverage
  square around the look camera, offscreen parts included, to find the low ground that
  connects to the ocean. This also happens when a saved sitch with the Sea Level surface shown
  opens, and again when the user selects *Recalculate inundation*.
- **Data:** tile coordinates only (coarse-area). Vector water tiles at zoom 6 to the source's
  maximum zoom (14 by default), to the vector water source: `api.maptiler.com` by default, or
  the host that the operator sets in `SITREC_VECTOR_WATER_URL`. Elevation tiles for the same
  square, to the selected elevation source. No other field.
- **Limits:** loading starts only while the Sea Level surface is shown with Inundation on, and
  only for the Coverage square, which is at most 100 km wide. A request that starts while Sea
  Level is hidden or Inundation is off, a wider region, a position finer than a tile, a
  destination other than the configured vector water source and the selected elevation source,
  or any other data in the requests is a finding.

### `inundation-3d-detail-tiles` — accepted 2.207.0 (contract widened)
- **Code:** `src/nodes/CNodeBuildings3DTiles.js` (`setInundationRegion`) and
  `src/water/InundationLoadSchedule.js`, used by `src/nodes/CNodeTerrainUI.js`. While the Sea
  Level surface is shown with *Inundation* and *Use 3D geometry* on, and Google photorealistic
  3D tiles are the shown buildings layer, one view's 3D tiles renderer gets a load region: a
  sphere around the sea surface center with the *3D detail radius*. The renderer loads the
  finest tiles in that region, offscreen parts included, so that walls and buildings can block
  the water. This also happens when a saved sitch with these settings opens.
- **Data:** the requests for the 3D tiles in that region, to `tile.googleapis.com`. Together they
  show the area around the sea surface center, which follows the look camera. No other field.
- **Limits:** only while all four settings above hold. *Use 3D geometry* is off by default. The
  radius is 0.5 to 10 km and at most half of Coverage. A larger region, a request when one of the
  settings is off, another tile host, or any other data in the requests is a finding.

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
