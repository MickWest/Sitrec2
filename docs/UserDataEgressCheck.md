# The User Data Egress Check

Every push to `main` is checked for one thing: did this change create a new way for data a user loads into Sitrec to leave it, or send more of it than Sitrec is designed to send? The result is posted as a comment on the commit, so the record is public and permanent.

This page explains what the check covers, how to read a result, and what to do when it turns red.

## What "user data" and "leave" mean here

**User data** is anything a user brings into a session or creates in it: tracks and their coordinates, positions and times, video files and frames, video and file metadata, file names, imported files (KML, CSV, TLE, images, 3D models), settings, and the contents of a saved sitch.

**Leave** means being sent over the network to any destination, or being written where another party could later read it: a third-party host, Sitrec's own server, a server log, a URL, an exported file, a shared link, or a page on another origin.

Sitrec does send data out by design. Map tiles are fetched from tile providers, which necessarily learn which area is being viewed. Wind lookups send a position to a weather service. Sharing a sitch uploads it. The check does not try to stop those. It makes sure each one is written down, and that nothing grows past what is written down.

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
| `video-frame` | a frame of the user's video |
| `menu-summary` | a summary of the current menu state, sent with a chat message |

The same file lists Sitrec's own server endpoints (`uilog.php`, `rehost.php` and so on) with the same fields. The file is the public statement of where Sitrec sends data and how much. Anyone can read it, and every change to it is in the git history.

## Where Sitrec sends data today

This is the inventory of the actual egress routes in the code as of September 2026, by build. The allow-list above is the authoritative, always-current version; this section is the narrative reading of it, and it will be refreshed when the routes change.

### With no user action, in every build

Opening Sitrec, loading a sitch, and looking at the map cause these requests and no others:

| Request | Goes to | Carries |
|---|---|---|
| List of built-in sitches | Sitrec's own server (`getsitches.php`) | nothing beyond the request |
| Login check | Sitrec's own server (`rehost.php?getuser=1`) | the browser's cookies for that server; on a site with accounts this identifies the account |
| Saved settings | Sitrec's own server (`settings.php`) | the user's preferences, when server-side settings are on (the default) |
| Map tiles | the default map provider | the tile coordinates of the viewed area |
| Elevation tiles | the default elevation provider | the tile coordinates of the viewed area |

The default map provider is ESRI World Imagery and the default elevation provider is AWS Terrarium, both keyless, in the example configuration and on the public site alike. Tile coordinates reveal the area being looked at, at the resolution of the zoom level; at high zoom that is a few hundred metres. The serverless builds make none of the server requests, since they have no server.

Everything else happens only when an operator setting is on, or when the user does something. Those two groups follow.

### A) The public site, www.metabunk.org

The public site is a full server install with these operator settings on, over and above the defaults:

- **Usage statistics.** A visit counter records the sitch name each time one loads. Tile counts per provider are reported in batches. The names of controls used, with timestamps, are logged in batches, and the server stores them with the user id and address. No content, positions or file names are in any of these.
- **Accounts.** The login check identifies the Metabunk forum account, which is what saves, shares and the assistant's usage accounting are keyed on.
- **Saving and sharing to cloud storage.** "Save to server" and share links upload the sitch and the files it references to the site's storage bucket. Objects there are addressed by an unguessable key and are public to anyone who has the link; that is the design of sharing, and it is the user's explicit action that triggers it.
- **The AI assistant**, image masking, and street-level imagery are available, using the site's provider keys. What they send is in the feature list below.
- **Keyed map providers** (Mapbox, MapTiler, the NRL and NASA imagery servers, USGS) and **3D buildings** (Google photorealistic tiles, Cesium Ion) are available in the terrain menu. Selecting one sends tile coordinates to that provider, with the site's key. Nothing is sent to a provider that is not selected.

### B) Self-hosted builds in their default configuration

Each of these is the same code with a different configuration and, in the last two cases, no server at all.

- **Local install with the PHP server** (`npm run build` behind a web server, or the standalone Node.js build). The example configuration ships with usage statistics off, the assistant off, and saves to the operator's own server on. The startup requests above go to that server. "Save to server" and share links upload to it, on the user's action. Keyed providers and 3D buildings are not available until the operator adds keys.
- **Container** (Docker or Podman), and **the VPS install** built on it. The image carries the example configuration, and the operator's environment file overrides it, so a container in its default configuration behaves exactly like the local install above. The VPS guide adds a reverse proxy and automatic updates; it adds no egress.
- **Serverless build on any static host.** No server requests at all: the sitch list is a file shipped with the site, the login check is skipped, settings and saved sitches live in the browser's storage, and statistics, the assistant, sharing and the proxied data sources are off. It also has **no internet map provider** unless the operator defines one through the custom-source variables, so in its plain default configuration it contacts nothing. Loaded files never leave the browser.
- **The GitHub Pages copy** (`mickwest.github.io/Sitrec2`). The serverless build plus the two keyless tile providers. Its complete egress, with no user action, is tile coordinates to ESRI and to AWS. The [Pages guide](dev/Deploying-on-GitHub-Pages.md) covers how it is built.

Summary, for the default configuration of each:

| | Public site | Local / container / VPS | Serverless | GitHub Pages |
|---|---|---|---|---|
| Sitch list, login check, settings, to own server | yes | yes | no | no |
| Tile coordinates to ESRI and AWS | yes | yes | no | yes |
| Usage statistics | yes | off | no | no |
| Assistant, masking, street-level imagery | available | off | no | no |
| Saves and share links | cloud storage | operator's server | browser only | browser only |
| Keyed providers and 3D buildings | available | off until keyed | no | no |

### What each feature sends when you use it

None of these happens until the user turns the feature on or takes the action. Each names its destination and what leaves.

- **Choosing a map or elevation layer.** Tile coordinates of the viewed area go to the chosen provider, with the operator's key if it needs one.
- **3D buildings.** Google photorealistic tiles receive tile coordinates and the operator's key. Cesium Ion receives the asset id and token once, then tile coordinates; that request is made by the bundled 3D-tiles library rather than by code in this repository.
- **Satellites.** Current element sets come from Celestrak through the server proxy, keyed by catalogue group; historical sets come from Space-Track through the server, with the operator's account, keyed by date. Neither carries a position.
- **Aircraft.** Loading an ADS-B trace sends the aircraft's identifier and date to the provider through the proxy (directly to the provider in the serverless build). The live aircraft feed sends the position and radius of the viewed area.
- **Wind.** The default source is a global forecast grid fetched through the server by date, hour and level, with no position. Weather-balloon soundings send a station identifier and time. Choosing the Open-Meteo source sends the positions of the wind sample points to that service.
- **Live feeds.** Military aircraft, balloons, launches and earthquakes come through the server proxy, by area and time. Ships (a WebSocket stream) and webcams use the user's own provider key and send a box around the viewed area, or its centre and a radius.
- **Street-level imagery.** The selected position goes to Google through the server.
- **The AI assistant.** Each message sends the user's text and a summary of the current menu state (which includes the names of loaded tracks and files) to the configured provider: the site's provider on the public site, or the user's own key sent directly to that provider. The assistant can also call Sitrec's API in reply. Of about a hundred functions, only a handful are withheld from it, so it can read track positions, the camera position, the notes, the list of loaded files, and the entire sitch state; whatever it asks for is returned to the provider as a tool result. It can also save the sitch and create a share link, which uploads it. Every turn is the user's action, but the data reachable in that turn is everything in the session.
- **Image masking.** The selected video frame and the user's instruction go to a vision model at the configured provider.
- **The voice feature.** Microphone audio goes to OpenAI, on the user's own key only.
- **Saving and sharing.** "Save to server" and share links upload the sitch and its referenced files to the operator's server or storage, and the short-link service receives the link. Exports (KML and the rest) are files written for the user; they contain the data by definition.
- **Settings.** Saving a setting sends its value to the server, when server-side settings are on.
- **Location from the connection.** The night-sky sitch, when it has no position given, asks a geolocation service for an approximate position; the request carries nothing, the service infers it from the connection. The "geolocate" button on a position does the same on demand.
- **Typing a place name** into the command box sends that text to a geocoding service.
- **Star-field solving** uploads the chosen image to the astrometry service.
- **"Open in …" links** to Google Maps, Flightradar24, ADS-B Exchange, in-the-sky and the wind map put the viewed position and time in the URL of the page they open.
- **Loading a public source video** sends that video's URL to the server, which fetches it.
- **The embedded help chat**, if the operator configures one, receives what is typed into it.

## The two layers

**1. The scan** (`scripts/security-scan-egress.mjs`) is deterministic and costs nothing. On the lines a push adds, it lists every network call and other data sink, every destination host, every server endpoint, and every URL that carries a position. It then applies three hard rules:

- a destination or server endpoint with no entry in the allow-list fails the check;
- a new file under `sitrecServer/` with no entry fails the check;
- a position parameter aimed at a destination whose `mayReceive` has no position class fails the check.

The scan cannot see inside a request body, so it also hands its listing to the second layer.

**2. The review** is an LLM that reads the scan, the allow-list and the diff, and judges what the new code can actually send, against the same contracts. It reports a finding when a change sends to an unlisted destination, sends a listed destination a class outside its contract or a more revealing form of one, sends without the trigger the entry names, writes user data to a new persistent place, or puts user data into a URL, an export or a shared link where the user would not expect it. Its reply begins with `Verdict: CLEAR` or `Verdict: ATTENTION`.

### How the review is run, and how deep it goes

- **Instructions.** The reviewer's complete brief is [`scripts/egress-review-prompt.md`](https://github.com/MickWest/Sitrec2/blob/main/scripts/egress-review-prompt.md). It is committed, so every change to what the reviewer is asked is in the git history, and the transcript of each run is kept with the workflow run for 90 days.
- **Model.** GitHub Copilot CLI, run inside the workflow and billed to the repository owner's Copilot seat. The model is set in one place, `COPILOT_MODEL_NAME` in `.github/workflows/user-data-egress-check.yml`, and is currently `gpt-5.6-terra`. Each run is capped at 30 AI credits (30 cents of model usage); a run that hits the cap is reported as INCOMPLETE, never as CLEAR.
- **What it reads.** The scan report, the allow-list, and the diff of the push with normal context for the files in scope, truncated at 400,000 bytes. It may open any file in the repository for context, and in practice it opens the files the diff touches. It cannot run the application, cannot access the network, and cannot write.
- **Depth.** The review covers the change in each push, not the whole tree. It sees every added and removed line in scope, with surrounding context, and whatever files it chooses to open. It is a reading of the code by a model, with the strengths and limits that implies: it is good at spotting a new request, a widened payload, or a removed user-action gate in the lines it is shown, and it will not find a leak that only appears when the application runs. The deterministic scan, and the whole-tree inventory test, are what make the destination list itself reliable.
- **Scope.** Files under `src/`, `sitrecServer/`, `tools/`, the config templates, and the root build scripts. Tests, documentation, and mirrors of third-party packages are out of scope. Requests made by bundled libraries (for example the 3D-tiles library's requests to Cesium Ion) are not visible to the scan; they are recorded in the allow-list by hand.

A push that changes no code in scope skips the review entirely.

## Reading a result

The comment on each commit starts with one line:

`Verdict: CLEAR · range abc1234..def5678 · 4 files in scope · scan: 2 sinks on added lines, 0 unlisted, 0 over contract · review: model-name · workflow run`

- **CLEAR**: both layers found nothing. The rest of the comment shows what was examined.
- **ATTENTION**: at least one layer found something. The scan's reasons appear on the next line, and the review's findings give file and line, what data can leave, where it goes, how it is triggered, and a suggested fix.
- **INCOMPLETE**: the review did not produce a verdict (the model was unavailable, the spending cap was reached, or the run failed). The scan result still stands. The workflow is red so that the gap is visible.

The full scan and review are in the comment under collapsible sections. The workflow run keeps the diff the review read and the model's transcript for 90 days; the comment does not expire.

## When the check is red

**A new destination.** If the request is intended, add an entry to `scripts/egress-allowlist.json` with an honest `purpose`, `trigger` and `mayReceive`, in the same push as the code. The scan validates the classes and rejects an entry it does not understand. If the request is not intended, remove it.

**A position sent somewhere that should not get one.** Send less. Round to the precision the destination needs, send an identifier instead of a track, or drop the parameter. If the destination genuinely needs a position, add the class to its entry and say so in `purpose`.

**A review finding.** Read the suggested fix. The reviewer is asked to prefer the change that sends less. If the finding is wrong, say why in the commit message of the fix; the next run reviews that too.

**INCOMPLETE.** Re-run the workflow from the Actions tab, or run the scan locally:

```
node scripts/security-scan-egress.mjs --range <base>..<head>
```

## Running it locally

```
node scripts/security-scan-egress.mjs --range origin/main..HEAD   # what a push would report
node scripts/security-scan-egress.mjs --inventory                 # every destination the tree references
npx jest tests/securityScanEgress.test.js                         # the scanner's own tests
```

The inventory is a useful map on its own: it lists every destination the code references, how many files reference each, and every kind of data sink in the tree. The test suite includes a check that the whole tracked tree matches the allow-list, so a destination cannot be referenced without an entry even outside the workflow.

## What the check does not do

It does not inspect what the running application sends; it reads the code. It does not see requests made from inside bundled third-party libraries or the server's PHP dependencies; those destinations are in the allow-list by hand, and a library update that adds a new one would not be caught by the scan. It does not stop a destination in the allow-list from being called; it stops the call from growing past its contract. And it does not replace reading the allow-list: the entries are the policy, and the check only enforces them.
