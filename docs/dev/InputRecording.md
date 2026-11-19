# UI input recordings

Sitrec can record detailed UI interactions for authenticated users **1** and
**99999999**. The PHP server enforces this fixed account list using the real login,
not the account selected by the administrator's **test as user** control. Other
users, including other administrators, cannot enable it by changing the request.
Both real and effective user IDs appear in each log record.

This recorder is independent of the aggregate `LOG_UI_INTERACTIONS` menu-click
counter. Serverless builds have no recorder backend. The secure build omits the
recorder and its endpoint.

## Enable persistent storage

Set these **server-only** values in `config/shared.env` or the container environment:

```dotenv
INPUT_RECORDING_ENABLED=true
INPUT_RECORDING_DIR=/var/lib/sitrec/input-recordings
```

Create that directory with owner access for the PHP worker. It must be an absolute
path outside the application, document root, public upload directory and public
cache directory. New directories use mode `0700`; files use `0600`. Do not expose
this directory through an alias or a static-file route.

For containers, bind-mount a permanent host directory at that path, and include it
in server backups. For example, a Compose volume entry can be
`/srv/sitrec/input-recordings:/var/lib/sitrec/input-recordings`. The host directory
must be owned by the host UID that corresponds to the PHP worker in the container.
On a read-only container, the mount must be writable. Keep the mount across backend
replacements. Do not use an unmounted container layer or a temporary directory.

There is deliberately **no temporary-storage fallback**. An empty
`INPUT_RECORDING_DIR` disables recording; `INPUT_RECORDING_ENABLED=false` disables
it explicitly. The login response advertises recording only for the two accounts
when configured. Reload the page after changing configuration. Deploy both the
frontend and PHP changes; a frontend-only update cannot activate the recorder.

Check the `rehost.php?getuser=1` response for `inputRecording: true`. After interacting
for at least five seconds, `inputlog.php` should acknowledge uploads with
`{"success":true,"logged":...,"ack":...}` and a file should appear in the directory.
Storage failures return HTTP 503 and write a diagnostic to PHP's error log. Verify
that the same file remains and receives events after restarting the backend.

## What is recorded

- Clicks, double-clicks, context menus, pointer buttons, pointer movement, scrolls,
  wheel gestures, focus, keyboard shortcuts and modifier keys.
- Menu and widget paths, native labels, disabled state, numeric values, checkbox
  state, select values and labels, and date/time/color values. The time editor's
  numeric text fields retain their numbers; sitch-browser items retain their names,
  including clicks on thumbnails and empty previews.
- Slider changes that do not dispatch native input events. These are named
  `control_change` and `control_finish`; they can also represent scripted changes.
- View ID and target bounds, pointer coordinates in viewport CSS pixels, current
  sitch and frame, playback state, viewport size, build, visibility and connectivity.
- Error type and script location, without error messages or stack contents.
- Paste/copy/cut activity and file counts, without clipboard data or file contents.

Pointer movement, scrolling, wheel events and live slider changes are sampled at
100 ms intervals, with pending samples drained in timestamp order before newer
events or a flush. Individual button presses, clicks, input/change events and keys are retained. DOM `trusted`
distinguishes browser-generated input from synthetic events. Capture listeners are
passive and do not replace application event handlers.

Free text is represented by its length and `[text omitted]`; printable keys in
editable controls are omitted too. Password fields and controls identified as
credentials are redacted. A custom control or container can use
`data-input-recording="redact"` to redact its values. URLs in labels lose user info,
query strings and fragments. The recorder does not collect screenshots, network
bodies, browser cookies, storage contents, file contents or clipboard contents.
The server also applies a bounded schema and redaction before writing.

Custom numeric text inputs can use `data-input-recording-value="number"`; only
finite numeric values are retained, and credential redaction still takes priority.
Use `data-input-recording-path` on a container to name events on its descendants.

Recording covers the main application document. Native OS file dialogs, browser
chrome and separate pop-out documents are outside its scope. These are diagnostic
interaction traces, not a pixel recording or a deterministic scene replay.

## Files and delivery

The directory layout is:

```text
INPUT_RECORDING_DIR/
  1/2026-11-19/2026-11-19_<session-uuid>.jsonl
  99999999/2026-11-19/2026-11-19_<session-uuid>.jsonl
```

The date is the session's UTC start date. Each page load gets a unique session,
including duplicated tabs. Each line is one JSON object with:

| Field | Meaning |
| --- | --- |
| `schema` | Format version, currently `1` |
| `session`, `seq` | Recording ID and strictly increasing event sequence |
| `user_id`, `effective_user_id` | Server-authenticated identity and test override |
| `ts`, `received` | Browser event time and server receipt time, Unix milliseconds |
| `elapsed` | Milliseconds since the page's recorder started |
| `type` | DOM event name or recorder event such as `session`, `error`, `gap` |
| `context` | Sitch, frame and paused state |
| `target` | Control path, view, type, value or redaction, and disabled state |
| Other fields | Coordinates, modifiers, deltas, viewport or error location as applicable |

Batches are sent every five seconds, with a beacon attempt on page hide. Pending
events stay in memory and per-tab session storage until acknowledged, and retry
with backoff. A backlog drains at up to one catch-up batch per second. On reload,
pending events are replayed under their original session
before new events are sent. Repeated batches are deduplicated under a file lock by
sequence number. A beacon alone never counts as an acknowledgement.

The pending buffer is limited to 1,000 events. If offline long enough to fill it,
additional events are counted in a subsequent `gap` record. Closing a tab before
its last unacknowledged data arrives can lose that tail; session storage only
survives if the browser restores it. Logs already acknowledged are on the server.
Batches are limited to 100 events and 48 KB; the endpoint limits requests to
64 KiB and 120 per minute per transport IP. Each page load starts a new session file.

Files are retained until the operator archives or deletes them. Monitor the storage
volume and include the directory in the normal retention/backup policy. There is
no browser-accessible log download endpoint; read them through authorized server
filesystem access. Keep copies of real logs out of the public repository.

## Agent analysis

Run the read-only summary command on the server or on a private copy of the files:

```sh
node scripts/analyzeInputRecording.mjs /var/lib/sitrec/input-recordings/1
```

It emits JSON with sessions, builds, event counts, dropped-event counts, frequently
used controls, errors and possible rapid repeated clicks. Those are review
candidates, not proof of UI defects. Each candidate includes session and sequence
references for locating the evidence in the original JSONL file.

Give an agent the summary and the relevant session files. Ask it to inspect the
events before and after each candidate, distinguish scripted control updates from
trusted user input, check for gaps/offline periods, and propose reproducible issues
with the control path, build and event sequence. Repeated clicks can be intentional;
long pauses can be time spent reading. Treat timestamps from different clients as
approximate and use sequence order within each session.

For local analysis in this repository, put log copies and generated reports under
`private/temp/InputRecording/`. Never put them in `docs/`, `data/` or `tools/`, which
are published by the build.
