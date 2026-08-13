# Scripting redesign proposal

---

# PLAN OF RECORD (post-review)

Reviewed by Codex (gpt-5.6-sol, xhigh), task-msqn31ii-e50ep3. Verdict: *adopt
shot-local source windows, but not the proposal as written.* The sections below are the
original proposal; this header is what we are actually building and why it differs.

## Corrections — things the proposal got wrong

1. **"Every edit is local" was false as written.** §3a lets a shot omit `world` and
   inherit the previous shot's world-out at a running `rate`. That is a hidden cursor:
   lengthening one implicit shot shifts every later one — the exact defect being fixed.
   **Canonical shots must carry RESOLVED `sourceIn`/`sourceOut`.** "Continue at 1x" is an
   authoring gesture that resolves at compile time, never runtime state.
2. **`hide someTypo` is NOT silent.** `set/show/hide` targets are validated against live
   menus and failures become line-tagged parse errors (CScriptedVideo.js:254-262).
   Verified. Any real failure is resolver *coverage*, not missing validation.
3. **Offline render already composites captions** (`_drawTexts`, ScriptRenderer.js:317).
   Verified. The real gap is exposing caption state to an agent, not a second renderer.
4. **"Cheap occlusion" was wrong.** Projection/frustum tests are cheap; true occlusion
   against terrain, models and async tiles is not.
5. **"Synchronous settled seek" is self-contradictory** — settling and video decode are
   async. It must be an awaitable transaction.
6. **Blanket zero-duration warnings would be noise.** `from X 0` is a deliberate snap and
   the idiom the Coyne video is built on. Only warn where instantaneous semantics are
   undefined (as `fov X 0` is).
7. **§3b and §4 propose two competing visibility systems.** Pick one. For v1, keep the
   existing `set/show/hide`.

## The architecture we are building

Not "a camera path over a scrubbed world", and not a global world-time curve either:
**NLE-style shots with independent source ranges, compiled into a piecewise
screen-time → world-frame map.** Each compiled segment carries its transition and
discontinuity metadata. A global keyframed time curve was considered and rejected — it
encodes no cuts, scene scope, or shot identity, and folds backward on replays.

## Phasing

**Phase 1 — timing model (in progress).**
Compile shots to an explicit `ShotSchedule`; replace the single global `sitFrameAt`
(CScriptedVideo.js:279) with a piecewise `worldFrameAt(screenT)`. Explicit
`world A..B` / `hold A` / `rate N`, resolved at compile time. Honour `Sit.aFrame`/`bFrame`,
which the current mapper ignores. Gives dwell, replay, freeze and slow-motion.

**Phase 2 — cut semantics.** Per-shot `cut` | `continue`. Default a source discontinuity
to `cut`. Segment camera smoothing (CScriptedVideo.js:475) at boundaries, and feed
declared transitions into tile warmup classification (CScriptedVideo.js:515) instead of
inferring cuts from camera jumps.

**Phase 3 — deterministic seek.** One awaitable `seekWorld(sourceFrame, {discontinuity,
settle})` shared by preview, render and probe. Unifies the two paths that exist today
(CScriptedVideo.js:917 vs ScriptRenderer.js:22).

**Phase 4 — agent API.** `compileScript()` returning a revisioned shot manifest,
`patchShots({ifRevision, ops})`, and `scriptProbe({shotId, localT})` addressing shots by
stable ID so an early insertion does not invalidate every reference. Then
`scriptCapabilities()` and the contact sheet.

**Deferred / cut.** Reverse playback (largest unverified surface — needs a node-graph
audit as a release gate). The general `frame A B` solver (underconstrained: `targetPos`
yields a point, not a bounding volume — ScriptCameraEngine.js:26). Automatic occlusion
and "no subject in frame" warnings. Bidirectional JSON round-trip while arbitrary JS is
canonical. Variants/scene switching per shot — §3a/§3b stay as a design sketch for a
later phase, not v1. Rate ramps, audio markers, permanent two-track timeline.

## Load-bearing behaviour not to break

Deterministic run-once-then-schedule evaluation (ScriptJSRunner.js:66); pose continuity
*within* camera sequences; snapshot-derived reversible settings (CScriptedVideo.js:451);
main-vs-look camera ownership split (CScriptedVideo.js:533); source-line/numeric-span
provenance driving wheel edits (ScriptSugar.js:10); total duration derived from max event
end, not the sequential spine (ScriptJSRunner.js:180).

---


Written after building a complete 20-shot, 105-second recreation (the 1973 Coyne
helicopter case) with the current system, entirely through the agent API. Every
criticism below is something that actually cost iterations, not a speculation.

Backwards compatibility is **not** a constraint: there are no legacy scripts worth
preserving.

---

## 1. Diagnosis: one line of code determines everything

```js
// CScriptedVideoManager.sitFrameAt
sitFrame = clamp(t / this.totalDuration, 0, 1) * (Sit.frames - 1)
```

The system models a scripted video as **a camera path over a fixed, uniformly-scrubbed
world**. World time is a pure linear function of position within the script. Five
consequences, all observed:

**a. Every edit is non-local.** Script length is the only speed control, and it is
global. Adding five seconds of establishing shot re-times *every other shot in the
video*. I had to precompute a beat table and pin the total to exactly 105 s so the
compression stayed exactly 4x; any later change means recomputing the whole table.
This is the single worst property for both humans and agents.

**b. You cannot dwell.** The ten seconds everyone remembers — the object stopping
dead in front of the helicopter — got 2.5 s of screen time. The only way to lengthen
it is to lengthen the entire video, which slows everything else down too.

**c. You cannot replay.** "Here is the same ten seconds from the ground" is the most
natural move in a recreation and it is impossible. The Borland video worked around
this by authoring walker paths that traverse the event *twice* inside one sitch —
i.e. faking it in the world data because the script layer could not express it.

**d. No slow-motion and no freeze.** Both are just "a different world rate", which the
model cannot represent.

**e. `Sit.aFrame`/`bFrame` are ignored**, so a video cannot be scoped to part of a sitch.

Everything else in this document is comparatively minor.

---

## 2. Core proposal: a shot owns its world window

A script is a list of **shots**. Each shot has a screen duration (how long the viewer
sees it) and a world window (what interval of sitch time it covers). These are
independent.

```text
rate 4                                     # default: 4 s of world per 1 s of screen

shot 5   from Huey bearing 205 dist 7000 elev 16
shot 4   world 23:04:39..23:04:49  track UFO     # 10 s of world in 4 s  -> 2.5x
shot 3   world 23:04:44            orbit UFO 40  # world FROZEN, camera moves
shot 4   world 23:04:39..23:04:49  from witness  # REPLAY: same 10 s, new angle
shot 6   slow 0.5                  track UFO     # half speed
```

Rules:

- A shot with no `world` continues from the previous shot's world-out at the current `rate`.
- `world A..B` sets an explicit window. `B < A` runs the world backwards.
- `world A` (single value) freezes the world for the shot.
- `rate N` / `slow N` set or override the running default.
- World times accept clock (`23:04:39`), seconds-into-sitch (`164`), or frame (`f4920`).

This one change gives dwell, slow-motion, freeze, replay, reverse and scoping, and
makes every edit local. It is the whole point of the redesign.

**Default rate should be 1x (real time), not "fill the sitch".** Today a three-line
test script silently plays an entire 7-minute sitch at ~100x. A video should default
to real time and the author should opt into compression.

---

## 3. Framing by intent, not by trigonometry

Current framing is `from target secs bearing distance elevation` — the author supplies
geometry and discovers the framing by trial. I did this repeatedly, and for the close
shots I had to solve distance and fov against the object's 18 m length by hand.

```text
shot 4  look UFO  size 0.35  from bearing 25 elev 6   # subtend 35% of frame height
shot 5  frame Huey UFO  margin 0.2                    # contain BOTH, 20% margin
```

- `size` solves distance (or fov, if `dist` is pinned).
- `frame A B ...` solves a camera that contains all named subjects.

`frame A B` is the archetypal recreation shot — two objects converging — and currently
requires manual trig every time.

---

## 3a. Variants: rework sub-sitches into a general primitive

Sub-sitches are barely used either, so they can be reworked freely. The goal is a
primitive that is **useful in its own right, independent of scripting** — the motivating
case being "one sitch, two different camera tracks, switchable and comparable".

Name: **variant**. (Not "scenario" — `CScenarioManager` already owns that word for
self-contained simulation packages like Nimitz and Football.)

### What changes from today

| Today (sub-sitch) | Proposed (variant) |
| --- | --- |
| Snapshot of everything matching a pattern whitelist | **Sparse override set** — only what actually differs from base |
| `subIncludes` patterns must be maintained and silently miss nodes | No whitelist: a variant owns whatever you changed while it was recording |
| One flat list, one active at a time | **Named axes**, one active variant per axis, axes independent |
| Switching swaps camera + clock too | Base is sacred; variants are overlays; the script can own an axis |
| No comparison | `diff`, A/B toggle, and side-by-side where cheap |

**Sparse, recorded-on-edit.** A variant is `{name, axis, overrides: {nodeId: partialMod}}`.
While a variant is recording, node mod changes are written into it — image-editor layer
semantics. So "two camera tracks" is: create variant *Camera A*, set the camera up,
done; create *Camera B*, set it up differently. The base is untouched and the variant
contains exactly the difference. Compare with today, where you snapshot everything
matching `*Camera*` whether you touched it or not.

**Orthogonal axes.** Variants belong to an axis — a dimension of variation — and one is
active per axis:

```
axis camera:        chase | ground observer | cockpit
axis hypothesis:    witness account | mundane trajectory
axis presentation:  clean | illustrative
```

Selection is a vector: `{camera: "ground observer", hypothesis: "witness account"}`.
A single flat list cannot express "camera A **and** hypothesis B", which is exactly what
both analysis and scripting need. Because overrides are sparse, two active variants
writing the same node/param is **detectable** and can be surfaced as a conflict; with
whole-state snapshots it is undetectable.

### What this buys outside scripting

1. **Two camera tracks on one sitch** — the motivating case, and now trivial.
2. **Competing reconstructions.** This is Sitrec's actual job: is it a plane, a balloon,
   or the reported object? Each becomes a named, saved, switchable variant of the *same*
   sitch, checkable frame-by-frame against the same video.
3. **`diffVariants(A, B)`** → a table of exactly what differs. That is an analysis
   artifact in itself, and the honest answer to "what did you change to make it fit?" —
   precisely the question a skeptical reader should ask.
4. **A/B toggle** on a hotkey; **permalinks** that carry the variant vector, so "my sitch
   with hypothesis B" is a URL.
5. **Regression / BotBench**: variants are a natural encoding of test cases over one sitch.

### The constraint that should shape the design

Variants mutate a shared node graph, so **two variants cannot be live simultaneously**
unless they merely *select* among nodes that coexist. That splits them in two:

- **Selection variants** (cheap): both camera tracks are loaded; the variant only changes
  which one drives the camera. Two can be live at once — genuine side-by-side in two
  views, and instant A/B with no recalculation.
- **Mutation variants** (expensive): they change the same node's parameters. Only one can
  be live; comparison is sequential (toggle, or cut between them in a video), and each
  switch costs a recalculate cascade.

**Recommendation: make selection the natural path.** If the UI's obvious gesture is
"duplicate this track into a new variant" rather than "edit this track's parameters",
most variants end up cheap, and side-by-side comparison comes free rather than being a
feature someone has to build. Mutation variants should still work, just be understood as
swap-only.

### How scripting consumes it

```text
shot 4  variant presentation:clean            frame Huey UFO
shot 4  variant presentation:illustrative     frame Huey UFO    # same beat, overlays on
shot 6  variant hypothesis:mundane            track UFO         # the rival reconstruction
```

Unspecified axes inherit from the previous shot. Applying the *containing shot's full
vector* at any `t` keeps scrubbing idempotent, forwards or backwards.

Precedence rule needed: while the script is driving, it owns the **main camera** and the
**clock**, so a variant on those axes must not fight it (see the two blockers below).

---

## 3b. Blockers in the current sub-sitch implementation

`src/CustomManagerSubSitch.js` already implements named, serialised snapshots of node
state: `captureSubSitchState()` collects `modSerialize()` from a whitelist of nodes into
`{mods, focusTracks, lockTracks}`, and `restoreSubSitchState()` `modDeserialize`s them
and runs `recalculateCascade()`. There is already a menu to create, rename, switch and
delete them, and they persist with the sitch.

This is the same state the script's `set`/`show`/`hide` mutate one control at a time.
They should be unified: **a shot names a scene, and `set`/`show`/`hide` become per-shot
deltas on top of it.**

```text
shot 4  scene "clean"           frame Huey UFO
shot 4  scene "with tracks"     frame Huey UFO     # same moment, overlays on
shot 6  scene "venus hypothesis"  track UFO        # a DIFFERENT reconstruction
```

Why this is better than the `presentation`/`overlay` keywords proposed in §4:

- It deletes the boilerplate problem instead of renaming it. Authors build the look they
  want **by hand, WYSIWYG**, capture it, and name it — rather than typing `hide
  traverseDisplayTrack` and discovering omissions by screenshot.
- Agents get a clean, enumerable affordance (`listSubSitches()`), instead of guessing ids
  like `syntheticTrackDisplay_1786569178198` — an epoch-stamped id no author can predict.
- It unlocks the thing Sitrec actually exists for and the script layer cannot express at
  all today: **cutting between competing reconstructions inside one video.** "Here is the
  witness account; here is the same geometry with the object on a mundane trajectory."
  That is the standard Metabunk argument structure.
- Zero new persistence: sub-sitches already serialise.

### Two blockers that must be designed for

**1. Sub-sitches capture the camera and the clock — the two things the script owns.**
`subIncludes` (CustomManagerSubSitch.js:135) enables by default:

| Category | Patterns | Default |
| --- | --- | --- |
| Views | `mainView`, `lookView`, `video`, `chatView`, `*View*` | on |
| **Cameras** | `mainCamera`, `lookCamera`, `fixedCameraPosition`, `ptzAngles`, `*Camera*` | **on** |
| **Date/Time** | `dateTimeStart`, `*DateTime*` | **on** |
| Measurement | `globalMeasureA`, `globalMeasureB` | on |
| Others | `lighting`, `*Lighting*`, `*Effect*`, `*Target*`, `traverseObject` | off |

A scene switch mid-script would therefore fight the scripted camera and reset world time.
The restore needs a **per-call category mask** so the script can restore scene state while
retaining ownership of the main camera and the clock. The mask machinery exists
(`subLoadEnabled`) but is global manager state, not a parameter.

**2. The whitelist does not currently cover presentation state.** `TrackDisplay_UFO`,
`*_ob_label`, `traverseDisplayTrack`, `cameraDisplayTrack` and the measurement/label
toggles match none of the patterns, so a sub-sitch today would **not** capture the
clean-vs-illustrative distinction that motivated this. Using sub-sitches for scripting
needs an extended include set (or a new "Presentation" category). This is a modest,
well-scoped change, but it is not free.

**3. Cost and scrub-safety.** `restoreSubSitchState` runs a full `recalculateCascade()`
over every restored node. That is fine at a cut (a discrete event, once per shot) but must
never land in a per-frame path. It must also be idempotent under backwards scrubbing:
apply the full scene of whichever shot contains `t`, never a delta from the previous
state — the same property the current settings layer has ("scrubbing backwards undoes
them").

---

## 4. Clean by default; overlays are opt-in

Today every script needs a boilerplate block hiding analysis furniture. Mine ended up
eleven lines long, and I *still* missed `traverseDisplayTrack` on the first pass and put
a bright yellow trajectory line through the most dramatic shot in the video.

Proposal: preview and render enter **presentation mode** by default — measurements,
labels, LOS, frustums, traverse/camera display tracks and synthetic track displays are
all off unless asked for. Overlays become explicit, per-shot, and *semantic*:

```text
shot 4  frame Huey UFO   overlay tracks Huey UFO    # trajectory lines, this shot only
shot 3  track UFO        overlay label UFO altitude
```

Note this also makes overlays a deliberate storytelling device (they were the most
"illustrative" thing in my video) rather than leakage to be suppressed.

---

## 5. Validation that catches real mistakes

Current failure modes are all silent:

- `fov 12 0` is **silently dropped** — a camera beat is sampled across its span, so a
  zero-duration beat never evaluates. All fourteen of mine were no-ops and nothing said so.
- `hide someTypo` silently does nothing.
- A subject can drift out of frame with no warning. `flyto look` + `linger 2` at 4x
  moved the world 8 s and the object left the frame entirely; I found it by screenshot.

Proposed lint, surfaced in `parseWarnings` and via the API:

| Check | Severity |
| --- | --- |
| zero-duration beat | warning |
| unresolved target / overlay / control name | **error** |
| subject leaves frame or is occluded for > N% of a shot | warning, with the time |
| shot has no resolvable subject in frame at all | warning |
| overlapping camera beats | warning (exists today, keep) |
| world window outside the sitch range | warning |

The frame check is cheap — project the declared subject at a few samples per shot — and
would have caught my drift bug instantly instead of after three screenshot round-trips.

---

## 6. Agent affordances

This is where most of my iterations went, and where the cheapest wins are.

**a. JSON as a first-class form.** `getScript()` / `setScript()` should accept and emit
`{shots:[...]}` as well as text, round-tripping both ways. Text stays the human editor
format; agents generate and mutate JSON. This removes caption quoting, whitespace
sensitivity, and line-editing hazards in one stroke — I hit all three (nested quotes in
captions, and a `sed` line-delete that silently changed shot timing).

**b. `scriptProbe(t)`** returning:
```json
{ "screenT": 41.8, "worldTime": "23:04:47", "sitFrame": 5010,
  "camera": {"lat":..,"lon":..,"alt":..,"fov":12,"heading":222.8,"pitch":13.1},
  "subjects": [{"name":"UFO","screenX":0.50,"screenY":0.48,"sizeFrac":0.11,
                "visible":true,"occluded":false,"rangeM":790}],
  "captions": ["From the SR-430 bridge, a mother and four children watch it happen"],
  "overlays": ["tracks:UFO","tracks:Huey"] }
```
This lets an agent verify a shot **numerically**. I took roughly fifteen screenshots to
establish things this single call would have answered exactly — where the subject is in
frame, how big it is, whether it is occluded, what the camera is doing.

**c. `scriptContactSheet({cols,rows})`** — one image containing a labelled thumbnail at
each shot's midpoint. Review a whole cut in one round-trip instead of twenty scrub +
screenshot pairs. For an agent this is the difference between a tractable and an
intractable review loop.

**d. `scriptTargets()` and `scriptOverlays()`** — enumerate what is nameable, with kind
and friendly label. I had to guess `TrackDisplay_UFO`, `traverseDisplayTrack`, and
`syntheticTrackDisplay_1786569178198` (an epoch-stamped id no author could predict).

**e. Captions must be verifiable headlessly.** They are DOM, and `view:"page"` capture
requires an active tab, so an agent working in a background tab **cannot see its own
captions at all**. Either composite captions into the rendered frame, or expose them via
`scriptProbe`.

**f. Deterministic scrub.** `startPreview` is async and a same-call `_scrubTo` is
overwritten, so every agent inspection is a two-call dance. A synchronous
`seek(t)` that settles and returns state would remove a whole class of flakiness.

---

## 7. Keep

The current design gets a lot right and these should survive:

- the flat one-line DSL (genuinely pleasant, and very agent-friendly)
- `&` / `&N` concurrency for non-camera beats
- tabs and `include`
- parse-on-keystroke with a live, draggable timeline
- `set`/`show`/`hide` working on menu controls *and* scene objects
- settings snapshot and restore on preview/render exit
- Capture (author by flying the camera)
- the render quality knobs (terrain settling, motion blur, super-sample)

---

## 7b. Blue sky: a visual variant graph

*Speculative. Recorded because it fits the model unusually well, not because it should be
built first.*

Sparse overrides make variants **derivable from each other**: "hypothesis B with wind" is
"hypothesis B" plus three more overrides. That is a graph, and it is worth drawing.

Note this is a genuinely different structure from the axes in §3a, and both are wanted:

- **Axes** are the *composition* model — what is active right now, one per axis.
- **The graph** is the *derivation* model — where a variant came from and what it changed.

Together they make a DAG, not a tree, which is a shape Sitrec already thinks in and
already has a widget for: `CNodeViewDAG` (`src/nodes/CNodeViewDAG.js`) is 516 lines of
pannable, zoomable, pop-out-able, dockable 2D canvas with column layout. A variant graph
could reuse it almost wholesale.

What the picture would show:

- **Nodes** = variants, in swim-lanes by axis; the base sitch as the root.
- **Edges** = derivation. Hovering or selecting an edge shows **exactly the overrides it
  adds** — `diffVariants` rendered visually rather than as a table.
- **Current selection** = one highlighted node per lane.
- **Re-parenting** = rebase, and it is well-defined under sparse overrides: recompute the
  delta against the new parent.

The real payoff is **provenance**. For an analysis tool, being able to see how a
reconstruction was arrived at — what was changed, in what order, from what starting point,
and being able to back up to any point — is the difference between a result and an
argument. It is the visual form of "show your work", and it answers the question a
skeptical reader should always ask: *what did you have to change to make it fit?*

There is also a tempting unification: a video script that cuts between hypotheses is
literally **a walk over this graph across time**, so the same view could double as a
storyboard. That may be too clever, and it should not drive the design.

**Honest caveat.** This is exactly the kind of feature that is more fun to build than to
need. A flat list per axis is probably sufficient until someone actually has a dozen
variants with real derivation structure. Build §3a first, ship it, and let the graph be
earned by use — the DAG widget will still be there.

---

## 8. Open questions

1. Should world windows be absolute clock times, sitch-relative seconds, or both?
   (Recreations want clock, because the sources are clock-stamped.)
2. Named/addressable shots for reuse and for agent patching (`shot @establish`)?
3. Should `rate` interpolate across a shot (ramping into slow motion), or stay constant
   per shot with ramps expressed as adjacent shots?
4. Is there a case for audio/narration markers now that shots have real durations?
5. Does the timeline widget become a two-track view (screen time vs world time)? That is
   the natural UI for this model and is how NLEs show speed ramps.
