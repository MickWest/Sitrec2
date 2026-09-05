You are reviewing one push to the Sitrec repository for a single question: does any change in this push create a new way for data a user loads into the application to leave it, or send more of it than the application is designed to send?

"User data" means anything the user brings into a session or creates in it: tracks and their coordinates, positions and times, video files and video frames, video and file metadata, file names, imported files (KML, CSV, TLE, images, 3D models), settings, and the contents of a saved situation.

"Leave" means being sent over the network to any destination, or being written where another party could later read it: a third-party host, the application's own server, browser storage that is later uploaded, a server log, a URL, an exported file, a shared link, or a page on another origin.

This is a data-handling review only. Do not review style, naming, performance, or unrelated bugs. Do not comment on files outside the diff.

Inputs, relative to the repository root. Read all three before anything else.

- `.egress/scan.md` is the deterministic scan of this push: network calls and other data sinks on added lines, destinations and server endpoints compared against the allow-list, positions sent to destinations whose contract has no position class, and URLs that carry a position without naming their destination.
- `scripts/egress-allowlist.json` is the allow-list. Every destination the application is designed to call has an entry with a purpose, what triggers the request, and `mayReceive`: the most revealing classes of data it is designed to receive, from this fixed vocabulary, least to most revealing: none, time, coarse-area (tile coordinates or a bounding box of the viewed area), precise-position (a specific latitude and longitude), identifier (an aircraft, satellite or object identifier the user looks up), user-text (text the user typed), user-file (a file the user explicitly chose to upload or share), user-audio, usage-stats (control names and counts, no content), video-frame, menu-summary (a summary of the current menu state, sent with a chat message), session-data (whatever the AI assistant reads through its tool calls: positions, times, identifiers, notes, file names, the serialized situation).
- `.egress/push.diff` is the diff of the push for the files in scope.

You may open any file in the repository for context. Do not modify files, do not run commands that change the repository, and do not access the network.

The fixed vocabulary also includes `audit-metadata`: UTC and event/correlation fields,
server/script/method, transport-peer address, numeric account identities, and hashed
resource/subject identifiers. It excludes raw names, URLs, coordinates, credentials
and request content. Hashes can be correlated or guessed from low-entropy inputs;
this class does not mean anonymous data. A local logging contract does not approve
an arbitrary remote collector or a broader field set.

The rule you are applying. A request to a listed destination is expected. It is a finding when a change:

1. sends anything to a destination that has no entry in the allow-list, including a destination decided at run time;
2. sends a listed destination a class of data outside its `mayReceive`, or a more revealing form of a class it has (a precise position where the contract says coarse-area, a full track where it says identifier);
3. sends user data without the trigger the entry names, for example an upload that no longer waits for the user's choice, or a request on page load that used to need a menu action;
4. writes user data to a new persistent place: a server log, a file on the server, storage that is later synchronised;
5. puts user data into a URL, an exported file or a shared link where the user would not expect it.

Established context. Do not re-derive it. Map and elevation tile requests inherently send the tile coordinates of the viewed area to the tile provider; that is coarse-area and is designed behaviour. The usage statistics endpoints receive control names and counts only. The optional AI features send the user's message and a summary of the menu state only when the user invokes them. The file-sharing features upload only when the user chooses to.

Report format. The first line of your reply must be exactly one of these two lines and nothing else:

Verdict: CLEAR
Verdict: ATTENTION

Then, for each finding, give: the file and line, which rule above it breaks, what data can leave, where it goes, how it is triggered, and a suggested fix, which should prefer sending less (round a position to the precision the destination needs, send an identifier instead of a track, wait for the user's action). Keep each finding under 120 words.

If there are no findings, follow the verdict line with one sentence stating what you examined (the number of files and the number of network calls or sinks) and stop. Do not pad the report. Use plain text and Markdown only.
