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

## The two layers

**1. The scan** (`scripts/security-scan-egress.mjs`) is deterministic and costs nothing. On the lines a push adds, it lists every network call and other data sink, every destination host, every server endpoint, and every URL that carries a position. It then applies three hard rules:

- a destination or server endpoint with no entry in the allow-list fails the check;
- a new file under `sitrecServer/` with no entry fails the check;
- a position parameter aimed at a destination whose `mayReceive` has no position class fails the check.

The scan cannot see inside a request body, so it also hands its listing to the second layer.

**2. The review** is an LLM (GitHub Copilot CLI, run inside the workflow) that reads the scan, the allow-list and the diff, and judges what the new code can actually send, against the same contracts. It reports a finding when a change sends to an unlisted destination, sends a listed destination a class outside its contract or a more revealing form of one, sends without the trigger the entry names, writes user data to a new persistent place, or puts user data into a URL, an export or a shared link where the user would not expect it. Its reply begins with `Verdict: CLEAR` or `Verdict: ATTENTION`.

The review is run with a fixed spending cap per push, no write access to the repository, and no network access. A push that changes no code in scope skips it entirely.

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

It does not inspect what the running application sends; it reads the code. It does not stop a destination in the allow-list from being called; it stops the call from growing past its contract. And it does not replace reading the allow-list: the entries are the policy, and the check only enforces them.
