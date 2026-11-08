# The User Data Egress Check

Every push to `main` is checked for one thing: did this change create a new way for data a user loads into Sitrec to leave it, or send more of it than Sitrec is designed to send? The result is posted as a comment on the commit, so the record is public and permanent.

This page lists [where Sitrec sends data today](#where-sitrec-sends-data-today), for each kind of install. It also explains what the check covers, how to read a result, and what to do when it turns red.

## What "user data" and "leave" mean here

**User data** is anything a user brings into a session or creates in it: tracks and their coordinates, positions and times, video files and frames, video and file metadata, file names, imported files (KML, CSV, TLE, images, 3D models), settings, and the contents of a saved sitch.

**Leave** means being sent over the network to any destination, or being written where another party could later read it: a third-party host, Sitrec's own server, a server log, a URL, an exported file, a shared link, or a page on another origin.

Sitrec does send data out by design. Map tiles are fetched from tile providers, which necessarily learn which area is being viewed. The open-meteo wind source sends a position to that weather service. Sharing a sitch uploads it. The check does not try to stop those. It reports a new route that is not written down, and a route that appears to send more than is written down.

## The contract: `scripts/egress-allowlist.json`

Every destination Sitrec is designed to call has an entry. Each entry states the destination, its purpose, what triggers the request, and `mayReceive`: the most revealing classes of data it may be sent, from a fixed vocabulary.

| Class | Meaning |
|---|---|
| `none` | the request carries nothing beyond the fact that it was made |
| `time` | a date or time only |
| `coarse-area` | tile coordinates or a bounding box of the viewed area |
| `precise-position` | a specific latitude and longitude |
| `identifier` | an aircraft, satellite or object identifier the user looks up |
| `user-text` | text the user typed: a place name, a chat message, a label |
| `user-file` | a file the user explicitly chose to upload or share |
| `user-audio` | microphone audio, for the voice feature |
| `usage-stats` | control names and counts, no content |
| `audit-metadata` | security-event and correlation fields, server/script/method, transport-peer address, numeric account identities and resource/subject hashes; excludes raw names, URLs, coordinates, credentials and request content |
| `video-frame` | a frame of the user's video |
| `menu-summary` | a summary of the current menu state, sent with a chat message |
| `session-data` | whatever the AI assistant reads through its tool calls: positions, times, identifiers, notes, file names, the serialized situation |

The same file lists Sitrec's own server endpoints (`uilog.php`, `rehost.php` and so on) with the same fields. The file is the public statement of where Sitrec sends data and how much. Anyone can read it, and every change to it is in the git history.

Server-internal includes also have entries when they handle an egress route. The
`audit.php` entry describes a local logging sink, not a browser-callable API. Its
`audit-metadata` class is deliberately separate from ordinary identifiers or usage
statistics; adding it does not expand any other destination's allowed data classes.

## Where Sitrec sends data today

This is the narrative inventory of the egress routes in the code, checked against the code, `scripts/egress-allowlist.json` and the workflow on October 31, 2026. The allow-list is the contract that the check compares against, and is updated with route changes. The standalone pages in **Sitrec → Extra Tools** have their own routes, and the allow-list names them.

### Baseline requests without feature use

In the default full-server configuration, opening Sitrec, loading a sitch, and looking at the map can cause these baseline requests. Operator-enabled features described below can add their own routes; serverless builds replace or omit the server calls.

| Request | Goes to | Carries |
|---|---|---|
| Server paths | Sitrec's own server (`config_paths.php`) | nothing beyond the request |
| List of built-in sitches | Sitrec's own server (`getsitches.php`) | nothing beyond the request |
| Login check | Sitrec's own server (`rehost.php?getuser=1`) | the browser's cookies for that server; on a site with accounts this identifies the account |
| Saved settings | Sitrec's own server (`settings.php`) | the same cookies; the user's preferences come back in the response (server-side settings are on by default) |
| Featured sitches and their preview images, and the user's own sitch list when logged in | Sitrec's own server or storage (`metadata.php`, `getsitches.php?get=myfiles`) | the same cookies; these requests come when the sitch browser opens at startup, which needs server or cloud saves on and no sitch named in the URL |
| Price list for AI models | OpenRouter | nothing beyond the request; no key |
| Map tiles | the default map provider | the tile coordinates of the viewed area |
| Elevation tiles | the default elevation provider | the tile coordinates of the viewed area |

The default map provider is ESRI World Imagery and the default elevation provider is AWS Terrarium, both keyless, in the example configuration and on the public site alike. Tile coordinates reveal the area being looked at, at the resolution of the zoom level; at the highest zoom that is tens of metres: about 38 m at the equator at zoom 20, the ESRI maximum in the example configuration. The serverless builds make none of the server requests, since they have no server. Every build on this page makes the price-list request, which carries no key and no session data. The [secure build](dev/Secure-Build.md), the output of `npm run build-secure`, does not make it.

Everything else happens only when an operator setting is on, or when the user does something. Those two groups follow.

### A) The public site, www.metabunk.org

The public site is a full server install with these operator settings on, over and above the defaults:

- **Usage statistics.** A visit counter runs once per page load. It records the `sitch` URL parameter, if there is one, with the user id and address. Tile counts per provider are reported in batches. The menu paths of controls used, with timestamps, are logged in batches, and the server stores them with the user id and address. A menu path can hold a track's name, and that name can come from its file name. No positions or file contents are in any of these.
- **Accounts.** The login check identifies the Metabunk forum account, which is what saves, shares and the assistant's usage accounting are keyed on.
- **Saving and sharing to cloud storage.** **File → Server → Save**, **File → Server → Save As** and share links upload the sitch and the files it references to the site's storage bucket. Objects there can be read by anyone who has the link; that is the design of sharing, and it is the user's explicit action that triggers it. The key of a saved version has a random part, except for versions saved before September 2026. A link to a sitch folder (`<user id>/<sitch name>/`) has no random part: anyone who knows the user id and the sitch name can open the newest public version.
- **The AI assistant** and street-level imagery are available, using the site's provider keys. Image masking is available to administrators only. What they send is in the feature list below.
- **Keyed map providers** (Mapbox, MapTiler) and **3D buildings** (Google photorealistic tiles, Cesium Ion) are available in the **Terrain** menu. Selecting one sends tile coordinates to that provider, with the site's key. Nothing is sent to a provider that is not selected.

### B) Self-hosted builds in their default configuration

Each of these is the same code with a different configuration and, in the last two cases, no server at all.

- **Local install with the PHP server** (`npm run build` behind a web server, or the standalone Node.js build). The example configuration ships with usage statistics off, the assistant off, and saves to the operator's own server on. The startup requests above go to that server. **Save**, **Save As** and share links upload to it, on the user's action. Keyed map providers are not available until the operator adds keys. 3D buildings need a key from the operator, or the user's own key under **Sitrec → Settings → API Keys…**. The keyless providers in the feature list below are available.
- **Container** (Docker or Podman), and **the VPS install** built on it. The image carries the example configuration, and the operator's environment file overrides it, so a container in its default configuration behaves exactly like the local install above. The VPS guide adds a reverse proxy and automatic updates; it adds no egress. Its example `sitrec.env` turns server saves off, so sitches there are saved as local files.
- **Serverless build on any static host.** No PHP requests, and no third-party request by default except the price list above: the sitch list and application assets come from the static host, the login check is skipped, settings stay in the browser, sitches are saved as local files, and statistics, the assistant, sharing, and server-proxied data sources are off. On the user's action the browser can still call some sources directly: for example an ADS-B trace from adsb.lol, a weather-balloon sounding from the IGRA2 archive, or a keyed feed on the user's own key. It has **no internet map provider** unless the operator defines one through the custom-source variables. Ordinary same-origin requests for the application, bundled data, and manifest still go to the static host; loaded user files are not uploaded.
- **The GitHub Pages copy** (`mickwest.github.io/Sitrec2`). The serverless build plus the two keyless tile providers. With no user action it sends tile coordinates to ESRI and to AWS, and it makes the price-list request to OpenRouter. [Deploying Sitrec on GitHub Pages](dev/Deploying-on-GitHub-Pages.md) covers how it is built.

Summary, for the default configuration of each:

| | Public site | Local / container / VPS | Serverless | GitHub Pages |
|---|---|---|---|---|
| Sitch list, login check, settings, to own server | yes | yes | no | no |
| Tile coordinates to ESRI and AWS | yes | yes | no | yes |
| Price-list request to OpenRouter | yes | yes | yes | yes |
| Usage statistics | yes | off | no | no |
| Assistant, masking, street-level imagery | available (masking: administrators only) | off | no | no |
| Saves and share links | cloud storage | operator's server (VPS guide: local files) | local files, no share links | local files, no share links |
| Keyed providers and 3D buildings | available | off until keyed | no | no |
| Other keyless map providers | available | available | no | no |

### Automatic audit records

Certificate authentication mode always enables audit logging; other modes
require `AUDIT_LOG_ENABLED`. Authentication outcomes and instrumented API attempts
and completions, including reads and refusals, write the declared audit metadata
to PHP's configured error logger or local `AUTHPRIV` syslog. In the published
container, PHP uses the container error stream. No raw user content or coordinates
are included, but account IDs, peer addresses and resource hashes remain protected
operational data: low-entropy resource names can be guessed and hashed.

This is a new, intentional persistent record introduced with the audit feature.
The inventory approves the described local sinks and fields, not arbitrary remote
collectors. Before forwarding through PHP, syslog, a container log driver or a log
agent, the operator must separately review the concrete collector destination,
the same or a smaller field set, access roles and retention. The app neither
opens a collector connection nor verifies that downstream configuration. See
[Server audit logging](dev/AuditLogging.md) for exact fields and coverage.

### What each feature sends when you use it

None of these happens until the user turns the feature on or takes the action. Each names its destination and what leaves.

- **Choosing a map or elevation layer.** Tile coordinates of the viewed area go to the chosen provider, with the operator's key if it needs one. Mapbox and MapTiler need a key. The other ESRI layers, Open Streetmap, EOX, USGS, and the NRL and NASA imagery servers need none, and they are in the example configuration.
- **3D buildings.** Google photorealistic tiles receive tile coordinates and the key in use: the user's own key if one is set under **API Keys…**, otherwise the operator's. Cesium Ion receives the asset id and token once, chosen the same way, then tile coordinates; that request is made by the bundled 3D-tiles library rather than by code in this repository.
- **Satellites.** Current element sets come from Celestrak through the server proxy, keyed by catalogue group; historical sets come from Space-Track through the server, with the operator's account, keyed by date. Neither carries a position.
- **A source the operator configured.** A host named in `CUSTOM_TLE`, `CUSTOM_WIND_URL`, `CURRENT_STARLINK`, `CURRENT_ACTIVE`, `CURRENT_ONEWEB`, `CURRENT_KUIPER`, `CURRENT_AST` or `CURRENT_IRIDIUM` is fetched by the server, and receives the `Authorization` header the browser sent, if it sent one, so a source can sit behind the same sign-on as the site. `celestrak.org` and the fixed public hosts never receive that header. See [SR-17](dev/SecurityRequirements.md).
- **Aircraft.** Loading an ADS-B trace sends the aircraft's identifier, with no date, to adsb.lol through the proxy (directly in the serverless build). The live aircraft feed sends the position and radius of the viewed area.
- **Wind.** The default source is **Manual**, which sends nothing. **GFS (NOAA)** is a global forecast grid fetched through the server by date, hour and level, with no position. Weather-balloon soundings send a station identifier and time. Choosing the **open-meteo** source sends the positions of the wind sample points to that service.
- **Live feeds.** Military aircraft, balloons, launches and earthquakes come through the server proxy from fixed, world-wide feed addresses; the browser sends the feed's name and nothing about the view. Ships (a WebSocket stream), webcams and road traffic incidents use the user's own provider key, from the browser and never through the server, also in the serverless build. They send a box around the viewed area, or its centre and a radius.
- **City Lights.** With **Show City Lights** on and a mapped **Method**, the browser reads road and building data for the viewed area from Overture Maps on Amazon S3. Those requests reveal the viewed area.
- **Street-level imagery.** The selected position goes to Google through the server.
- **The AI assistant.** Each message sends the user's text and a summary of the current menu state (which includes the names of loaded tracks and files) to the configured provider: the site's provider on the public site, the user's own key sent directly to that provider, or a custom endpoint that the user names. The assistant can also call Sitrec's API in reply. Of more than a hundred functions, only two are withheld from it, so it can read track positions, the camera position, the notes, the list of loaded files, and the entire sitch state; whatever it asks for is returned to the provider as a tool result. It can also save the sitch and create a share link, which uploads it. Every turn is the user's action, but the data reachable in that turn is everything in the session.
- **Image masking** (administrators only). The current video frame and a fixed outlining prompt go through the server to the vision model selected in **Sitrec → Settings → AI Model**. The user types no text for this.
- **The voice feature.** Microphone audio goes to OpenAI, on the user's own key only. A voice session also receives the menu summary and can call the same functions as the assistant, so what it reads through them goes to OpenAI too.
- **Saving and sharing.** **Save**, **Save As** and share links upload the sitch and its referenced files to the operator's server or storage, and the short-link service receives the link. Exports (KML and the rest) are files written for the user; they contain the data by definition.
- **Settings.** Changing a setting sends the whole settings set to the server, when server-side settings are on. That set includes a startup position, if the user has set one.
- **Location from the connection.** The night-sky and Starlink sitches, when they have no position given, ask a geolocation service for an approximate position; the request carries nothing, the service infers it from the connection. The **Geolocate from IP Address** button on a position does the same on demand.
- **Typing a place name** into the chat box, a position's **Lookup** field or the **G** (Go To) prompt sends that text to the Nominatim geocoding service. Text pasted or dropped onto the page goes the same way, unless Sitrec reads it as a URL, a frame number, a TLE, a date or time, or a coordinate. Serverless builds have no geocoder. After a **Lookup** that gives no altitude, the position also goes to the Open-Meteo elevation service. Coordinates typed into **Lookup** skip the geocoder but not the elevation service.
- **Map links in the Help menu** (ADSB Replay, FlightRadar24 Replay, In-The-Sky, Earth Nullschool, Google Maps) and **Google Maps Here** on the right-click menu open another site. The URL carries the camera position and time, or the clicked position. The Google Maps links carry no time.
- **Loading a public source video** sends that video's URL to the server, which fetches it.
- **Help → External Links.** The example configuration includes **Astrometry.net Image Solver** and **Sitrec Helper Chatbot**. Each opens a third-party page in a new tab, and Sitrec sends it nothing. What the user uploads or types there goes directly to that site.

## The two layers

**1. The scan** (`scripts/security-scan-egress.mjs`) is deterministic and costs nothing. On the lines a push adds, it lists every network call and other data sink, every destination host, every server endpoint, and every URL that carries a position. It then applies three hard rules:

- a literal `http(s)` host, or a `.php` name in browser code, with no entry in the allow-list fails the check;
- a new `.php` file directly under `sitrecServer/` with no entry fails the check;
- a position parameter on a line that also names a destination whose `mayReceive` has no position class fails the check.

The scan only lists a host decided at run time, a WebSocket call, and a position on a line that names no destination. It cannot see inside a request body. So it also hands its listing to the second layer.

**2. The review** is an LLM that reads the scan, the allow-list, the accepted patterns and the diff, and judges what the new code can actually send, against the same contracts. It reports a finding when a change sends to an unlisted destination, sends a listed destination a class outside its contract or a more revealing form of one, sends without the trigger the entry names, writes user data to a new persistent place, or puts user data into a URL, an export or a shared link where the user would not expect it. Its reply carries a line of its own that reads `Verdict: CLEAR` or `Verdict: ATTENTION`; where it states both, the record takes `ATTENTION`, and where it states neither the record is `INCOMPLETE`.

### How the review is run, and how deep it goes

- **Instructions.** The reviewer's complete brief is [`scripts/egress-review-prompt.md`](https://github.com/MickWest/Sitrec2/blob/main/scripts/egress-review-prompt.md). It is committed, so every change to what the reviewer is asked is in the git history, and the transcript of each run is kept with the workflow run for 90 days.
- **Model.** GitHub Copilot CLI, run inside the workflow and billed to the repository owner's Copilot seat. The model is set in one place, `COPILOT_MODEL_NAME` in `.github/workflows/user-data-egress-check.yml`, and is currently `gpt-5.6-terra`. Each run is capped at 100 AI credits (1 dollar of model usage); a run that hits the cap is reported as INCOMPLETE, never as CLEAR.
- **What it reads.** The scan report, the allow-list, the accepted patterns, and the diff of the push with normal context for the files in scope, truncated at 400,000 bytes. It may open any file in the repository for context, and in practice it opens the files the diff touches. It is told not to modify files or access the network. The workflow denies it file writes, `git push`, `curl` and `wget`, and its token can only read the repository.
- **Depth.** The review covers the change in each push, not the whole tree. It sees the added and removed lines of in-scope files, with surrounding context, up to the 400,000-byte limit, and whatever files it chooses to open. The verdict line does not say when the diff was cut. It is a reading of the code by a model, with the strengths and limits that implies: it is good at spotting a new request, a widened payload, or a removed user-action gate in the lines it is shown, and it will not find a leak that only appears when the application runs. The deterministic scan, and the whole-tree inventory test, are what keep the list of literal hosts complete.
- **Scope.** Code files under `src/`, `sitrecServer/`, `tools/`, the config templates, and the root build scripts. Tests, documentation, and mirrors of third-party packages are out of scope, and so are `data/`, `scripts/`, `apps/` and the allow-list itself. Requests made by bundled libraries (for example the 3D-tiles library's requests to Cesium Ion) are not visible to the scan; they are recorded in the allow-list by hand.

A push that changes no code in scope skips the review entirely.

## Reading a result

The comment on each commit has a heading, then one line:

`Verdict: CLEAR · range abc1234..def5678 · 4 files in scope · scan: 2 sinks on added lines, 0 unlisted, 0 over contract · review: model-name · workflow run`

- **CLEAR**: both layers found nothing. The rest of the comment shows what was examined. If no code in scope changed, the line reads `review: skipped`, and only the scan ran.
- **ATTENTION**: at least one layer found something. The scan's reasons appear on the next line, and the review's findings give file and line, what data can leave, where it goes, how it is triggered, and a suggested fix.
- **INCOMPLETE**: the review did not produce a verdict (the model was unavailable, the spending cap was reached, or the run failed), or the scan did not run. Where the scan ran, its result still stands. The workflow is red so that the gap is visible.

The scan and review are in the comment under collapsible sections, cut if they are very long. The workflow run keeps their full text, the diff the review read and the model's transcript for 90 days; the comment does not expire.

## When the check is red

**An accepted pattern.** [`scripts/egress-accepted-patterns.md`](https://github.com/MickWest/Sitrec2/blob/main/scripts/egress-accepted-patterns.md) lists findings that the maintainer has already accepted after a review, each with its limits, and findings that were refused. The review reports a change that matches an accepted entry, within its limits, as `Accepted pattern: <id>` and not as a finding. When a finding is accepted, the release that ships it adds an entry there.

**A new destination.** If the request is intended, add an entry to `scripts/egress-allowlist.json` with an honest `purpose`, `trigger` and `mayReceive`, in the same push as the code. The scan validates the classes and rejects an entry it does not understand: a bad entry stops the scan, and the record reads INCOMPLETE. If the request is not intended, remove it.

**A position sent somewhere that should not get one.** Send less. Round to the precision the destination needs, send an identifier instead of a track, or drop the parameter. If the destination genuinely needs a position, add the class to its entry and say so in `purpose`.

**A review finding.** Read the suggested fix. The reviewer is asked to prefer the change that sends less. If the finding is wrong, say why in the commit message of the fix; the next run reviews that too.

**INCOMPLETE.** Re-run the workflow from the Actions tab. If the record says that the scan did not run, run it locally to see the error: a re-run does not help while the allow-list is invalid. A local run gives the scan part only, because the review runs only in the workflow.

```
node scripts/security-scan-egress.mjs --range <base>..<head>
```

## Running it locally

```
node scripts/security-scan-egress.mjs --range origin/main..HEAD   # the scan part of what a push would report
node scripts/security-scan-egress.mjs --inventory                 # every literal destination the tree references
npx jest tests/securityScanEgress.test.js                         # the scanner's own tests
```

The inventory is a useful map on its own: it lists every literal destination the code references, how many files reference each, and every kind of data sink in the tree. The test suite includes a check that every in-scope tracked file matches the allow-list, so a literal `http(s)` host cannot be added without an entry and still pass the tests.

## What the check does not do

It does not inspect what the running application sends; it reads the code. It does not see requests made from inside bundled third-party libraries or the server's PHP dependencies; those destinations are in the allow-list by hand, and a library update that adds a new one would not be caught by the scan. It does not stop a call. It reports a call that goes past its contract, after the push is on `main`. And it does not replace reading the allow-list: the entries are the policy, and the check only compares the code against them.
