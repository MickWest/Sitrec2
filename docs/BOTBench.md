# BOTBench — Bearings-Only Traversal Bulk Analysis

This document covers **File ▸ File Analysis ▸ BOTBench…** — the window that runs
Sitrec's traverse analysis over a whole folder of files at once and tables the
results side by side. It sits next to **Analyze Video FMV Data…** in the same
submenu, and the two are deliberately similar.

**BOT** stands for **Bearings-Only Traversal**: reconstructing where something
was, and how it moved, from pointing directions alone — a camera tells you
which way it was looking, never how far away the object was. The
[traverse](#traverse) is Sitrec's name for a reconstructed target path, and
"bearings-only" is the standard term for this class of problem. BOTBench is
the bench that tests how well Sitrec solves it.

For what the analysis itself computes and how to read a verdict, see
[Traverse Analysis and the Verdict](TraverseAnalysis.md). For how each fitting
method works, see [Traverse Methods](TraverseMethods.md). Technical terms used
below are anchor-linked to the [glossary](#glossary) at the end of this page;
Sitrec-wide vocabulary is in the main [Glossary](Glossary.md).

---

## What it is for

The interactive **Analyze Traverse Methods** button answers a question about one
sitch: *given these [sightlines](#sightline), what could the object have been?* BOTBench asks
the question that comes before trusting that answer: *how good is the analysis
itself?* It runs the **same shipping analysis code** (the fit battery was
extracted into a shared module precisely so the live button and BOTBench cannot
diverge) over many files in one sitting, so you can:

- **Score the analysis against known truth.** BOT benchmark scenarios carry the
  true target position for every frame. Run a folder of them and the table
  shows, file by file, how close the top-ranked interpretation came.
- **Triage real footage in bulk.** Point it at a folder of [MISB](#misb-and-klv)
  [FMV](#fmv) clips (`.ts` / `.klv`) and every clip gets the full analysis, without building a
  sitch per clip.
- **Compare source data quality.** Half the table is measured *before any fit
  runs* — it tells you what each file's geometry can support at all, which is
  often the real explanation for why an analysis succeeded or failed.

Everything is computed at the file's own native sample rate. A benchmark
scenario of 51 samples at [1 Hz](#hertz-hz) is analysed as 51 measurements — not resampled
onto a 30 fps video timeline where 29 of every 30 "measurements" would be
interpolation.

## What it accepts

Two kinds of file, mixed freely in one folder:

- **BOT interchange scenarios** — `<name>.input.csv` or `<name>.all.csv`, each
  optionally paired with a `<name>.scenario.json` [sidecar](#sidecar). The sidecar is
  matched by filename automatically and is never queued as a row of its own.
  A `<name>.truth.csv` is recognised as an *answer key* (positions, no
  sightlines) and treated as a sidecar too — it will never appear as an error
  row. The format is described [below](#the-bot-interchange-format).
- **MISB FMV clips** — `.ts` transport streams or bare `.klv` files whose
  [KLV](#misb-and-klv) metadata carries sensor position, platform attitude and
  gimbal angles. The
  sightline is rebuilt from those angles with the same rotation code the live
  MISB track nodes use.

Ordinary video files (`.mp4`, `.mov`, …) are *not* queued: they carry no
sightline metadata, so each one would only ever produce an error row.

Files that cannot be trusted are **refused with the reason** rather than
analysed anyway: a sidecar that exists but does not parse, a sidecar that fails
to state its coordinate frame, a `Time` column that never advances, a truth-only
file with nothing to analyse. An error row tells you what was wrong with the
file; it never silently falls back to guesses.

---

## The window, top to bottom

![A completed BOTBench run over the standard scenario set — the controls row,
the summary tiles, and the results table with its SOURCE DATA and ANALYSIS
RESULT column groups](images/botbench-results.jpg)

### The controls row

- **Recursive** — descend into subfolders of a chosen or dropped folder (on by
  default). The folder you explicitly hand over is always scanned; the checkbox
  only controls whether folders *inside* it are.
- **Range bands** — after each [physics-model](#physics-models) fit, re-fit the model at a ladder
  of held ranges to find the whole range interval it still admits, exactly as
  the live analysis's solution-families option does. Several extra fits per
  model — roughly triples the time per file.
- **Monte Carlo sweep** — add the two [Monte Carlo](#monte-carlo) curve-fit
  strategies across [polynomial orders](#polynomial-order). This is a method diagnostic (it shows how sensitive the
  polynomial fits are to their order), adds ten candidates per file, and is the
  bulk of the sweep's cost. Leave it off unless you are studying the methods
  themselves.
- **Range anchor … NM** — the start distance the search bracket is centred on,
  identical for **every file in the run** (default 20 [NM](#nautical-mile-nm),
  clamped to 0.3–90 NM). The interactive analysis anchors its bracket on the *Tgt Start
  Dist* slider — which you have usually already nudged toward the answer. A
  bulk run must not acquire any such knowledge, or the range bracket becomes a
  function of the answer and cross-file comparison stops meaning anything. If
  you type a value outside the clamp, the box shows the value actually used.
- **Choose Folder** — pick a folder to scan. You can also drag a folder from
  your file manager anywhere onto the window. (Folder picking needs a
  Chromium-family browser; elsewhere, use Choose Files or drag-and-drop.)
- **Choose Files** — pick individual files. Note that BOT files chosen without
  their `.scenario.json` sidecars fall back to the standard scenario set's default site
  for the coordinate origin, and take their sample rate from the CSV's own
  `Time` column (recorded as a warning on the row) — fine for the standard
  scenarios, wrong for files generated at another site.
- **Cancel Run** — stop the run. The file being analysed when you click is
  abandoned at its next checkpoint and its row is marked *cancelled*; rows that
  already finished keep their results, and the files after it stay unanalysed.
- **Clear Results** — empty the table and start fresh.
- **Export JSON** — save every row's measurements and conclusions (not the
  fitted tracks) for machine consumption.
- **Export CSV** — one row per file, for a spreadsheet.
- **Summary** — open a combined overview report: what the run covered, how the
  source data scored, where the analysis landed, and the run's option settings.
- **Close** — close the window and restore the playback state Sitrec was in
  before it opened. Results are discarded (export first if you want them).

While a run is in progress the analysis holds Sitrec's playback paused and the
option controls are locked, so every file in the run is analysed with the same
settings.

### The status line and progress bar

The status line narrates the run — which file is being analysed, and, when
done, how many results are in the table. The progress bar spans the queued
files.

### The summary tiles

- **Queued** — files queued for this run.
- **Analysed** — files that produced a result.
- **Errors** — files that could not be ingested or analysed. Hover an error
  row's Status cell for the reason.
- **Good source** — files whose source data has no flagged
  [degeneracy](#degenerate): enough frames, a real sensor
  [baseline](#baseline), a sightline that actually swept, and good
  [conditioning](#conditioning-and-rcond) (see the **Src** column below).
- **Range unobservable** — files where the sensor baseline is too small for
  *any* [free-range method](#free-range-methods) to determine distance. No fit can recover range from
  such a file; that is a property of the data, not a failure of the analysis.
- **Resolved** — files whose executive verdict was something other than
  "unresolved" *and* whose top candidate does not contradict the file's declared
  `MaxRange` (the longest distance the file says its sensor could plausibly
  have been measuring at). A parenthesised figure counts verdicts excluded for that
  contradiction — a verdict resting on a candidate the measurement says is
  impossible is not a resolution.
- **With truth** — files whose conclusion can be scored: either a true position
  per frame, or a direction truth for a target that has a bearing but no finite
  range (a celestial object). The two are scored in different units and never
  averaged together; the tile shows them as *positional+direction*. Running the
  challenge `Input/` folder alone shows 0 here — the input files deliberately
  carry no truth (see [file generation](#where-the-scenario-files-come-from)).
- **Median |err|** — [median](#median) line-of-sight [residual](#residual) of
  the top-ranked interpretation across the run, in degrees: how well the
  winning candidates fit their sightlines.
- **Median rel. sep** — shown when truth exists: the median, over the scored
  files, of the top interpretation's mean 3D separation from truth divided by
  the mean true range. It is scale-free, so a 2 km scenario and a 50 km
  scenario compare on the same axis. 0.1 means "on average within 10% of the
  true range of the right place"; 1.0 means "as far from the truth as the truth
  is from the camera".

### The results table — SOURCE DATA columns

These are measured from the file **before any fit runs**. They describe what
the data can support, and they are the first place to look when a verdict
disappoints.

- **File** — path relative to the chosen folder.
- **Status** — progress while running, then the final state (`done`, or an
  error; hover for detail).
- **n** — usable samples in the file, at its own native rate.
- **Dur** — clip duration in seconds.
- **Rate** — samples per second: the sidecar's declared rate when the file's
  timestamps agree with it, otherwise the rate measured from the `Time` column
  itself — on disagreement the timestamps win, because they are the data.
- **Base** — straight-line extent of the sensor's own path, in metres. This is
  the *aperture* of the whole problem: range comes from [parallax](#parallax),
  parallax comes from the sensor moving, and a sensor that barely moved gives
  every range the same sightlines. A large [baseline](#baseline) does not
  guarantee success, but a tiny one guarantees a specific failure.
- **Sweep** — total angular path travelled by the sightline, in degrees. A
  bearing that never moves carries no information about the target's motion.
- **CV rcond** — [conditioning](#conditioning-and-rcond) of the
  [Constant Velocity (CV) family](#constant-velocity-cv-family)'s fit design
  (0–1, higher is better; the same diagnostic the live analysis computes).
  The "CV" in the header is load-bearing: this number speaks for the
  constant-velocity family of fits and nothing else.
  It answers one narrow question: *could a linear fit determine range here?*
  It is one-way — poor rcond genuinely rules the linear family out, but good
  rcond is not a promise, and [physics](#physics-models) or
  [stationary-point](#stationary-point-methods) methods may still work where
  it is poor.
- **Noise** — pointing noise in degrees, estimated **from the sightlines
  themselves** with no model of the target: the median angle by which each
  sightline deviates from the direction midway between its two neighbours. On a
  smooth trajectory sampled fast enough, that deviation is dominated by
  pointing jitter rather than real curvature, and an explicit assumption
  ([isotropic Gaussian](#gaussian) pointing error on a locally straight path)
  converts the median to a [sigma](#sigma). On a slow clip of a manoeuvring object the curvature term
  is real and inflates it — it is an estimate, not a calibration.
- **Decl** — the pointing sigma the file *declares* (the BOT sidecar's
  `losError.sigmaDeg`, or the `LOSUncertainty` column), in degrees. Blank for
  FMV, which declares none. Comparing **Noise** with **Decl** is the point of
  having both: agreement is evidence the declared figure is honest. A trailing
  `*` (e.g. `0.150*`) marks a [**correlated** error model](#correlated-wobble) —
  slow wobble rather than white jitter — whose declared amplitude is *not*
  comparable with the [white-noise](#white-noise) estimate to its left. On the standard scenario set the estimate
  reads about 1.0× the declared sigma on white-noise files, and far below it on
  wobble files — that gap is the wobble signature, not a bug.
- **Src** — a one-word triage of everything to the left: **good** (nothing
  flagged), **fair** (minor flags: marginal conditioning, irregular timing,
  timing gaps, or a missing sidecar), **hard** (conditioning poor — the linear
  route to range is closed), **weak** (a fundamental degeneracy: fewer than 10
  frames, a sensor that barely moved, or a sightline that barely swept). It is
  a sort key, not a calibrated score — hover it for the specific reasons, and
  the numbers it came from are all in the row.

### The results table — ANALYSIS RESULT columns

- **Verdict** — the [executive verdict](#executive-verdict) for this file,
  shortened to fit the cell; hover for the full headline. The wordings and exactly what each one
  licenses you to say are documented in
  [Traverse Analysis and the Verdict](TraverseAnalysis.md). "Unresolved" on a
  row whose Src column says **hard** or **weak** is the system being honest
  about data that cannot support a conclusion.
- **Top interpretation** — the highest-ranked candidate (e.g. *Sky Lantern /
  Balloon*, *Constant Altitude*, *Quadcopter*) and its rank tier. Ranking is
  **blind**: truth, even when the file carries it, plays no part in choosing
  the winner — it is only used afterwards, to score the choice.
- **|err|** — the top interpretation's mean line-of-sight
  [residual](#residual), in degrees: how well that candidate's track
  reprojects onto the measured sightlines.
- **Range** — the top interpretation's start range, in nautical miles.
- **Truth** — where truth exists: the top interpretation's
  [relative separation](#relative-separation) from it (the per-file version of
  *Median rel. sep*), or, for a direction-only target, its bearing error in
  degrees.
- **Gallery** — opens the full-screen candidate gallery for this file, the
  same view the live Analyze button produces, with no recomputation — every
  row keeps its complete results object. One difference: the gallery's **Use
  exact result** button is disabled for bulk rows, with a note explaining
  why — the fitted track lives in some other file's local coordinate frame at
  its own epoch, and applying it to the currently loaded sitch would silently
  corrupt it.
- **Report** — builds and opens the same full HTML analysis report the live
  analysis produces, on demand.

---

## What a bulk run deliberately does not do

The fits are identical to the live button's; the *environment* is not, because
there is no loaded scene. Every difference is stated with the results rather
than left to be discovered:

- **Flat terrain.** A BOT scenario is generated on a flat plane, so the ground
  is a level surface at the site elevation — exactly as the scenario generator
  defines it. An FMV clip gets sea level, which is right over water and wrong
  inland; the row records which was used.
- **No wind field.** The free balloon fit still runs and infers its own wind;
  only the "balloon using measured wind" variant, which needs a scene wind
  node, is absent.
- **No scene [hypotheses](#hypothesis).** No astronomy sweep, no satellite catalogue, no live
  line-of-sight-fitting method nodes from the interactive scene. These are
  listed under *absent hypotheses* in every
  report and export, so a missing interpretation is never mistaken for negative
  evidence — "no satellite matched" and "no satellite catalogue was searched"
  are different statements.
- **One range anchor for the whole run** (see the Range anchor control above).

## Scoring against truth

Truth is quarantined at ingest: the `TruePosition` columns are read into a
separate structure that nothing in the analysis path can see, attached only
after the hypotheses are built, and used only to score them. For a positional
truth the score is **relative separation** — mean 3D distance between the
candidate track and the truth track, divided by the mean true range (see
[relative separation](#relative-separation)). For a
direction-only truth (Venus, effectively at infinity) the score is the bearing
error in degrees. The two are never pooled.

---

## The BOT interchange format

The full specification ships with the benchmark as
`benchmarks/botbench/BOT-Interchange-Format.html`. The short version:

One schema, three views of the same data:

| File | Columns | Role |
|---|---|---|
| `<name>.input.csv` | `TrackID, TrackSource, Time, SensorPositionX/Y/Z, LOSUnitVectorX/Y/Z, MaxRange, LOSUncertainty` | the challenge |
| `<name>.truth.csv` | `TrackID, Time, TruePositionX/Y/Z` | the answer key |
| `<name>.all.csv` | input columns + truth columns | both, joined row-for-row |

Positions are metres in a **local [ENU frame](#enu-frame)** (the sidecar declares
`axisOrder: "X=East, Y=North, Z=Up"` explicitly, because a consumer that
guesses X=North gets a mirrored scene that is perfectly consistent with its own
bearings). Scenarios are generated on a **flat plane**: altitude is Z plus the
site's ground elevation at any horizontal distance. The truth columns are
deliberately empty for a direction-only target.

The `<name>.scenario.json` sidecar carries everything the CSV cannot: the frame
origin (latitude, longitude, ground elevation), the [epoch](#epoch), the sample
rate, the declared line-of-sight error model ([white sigma](#white-noise) or
[correlated wobble](#correlated-wobble) — the
`*` in the Decl column), the sensor field of view, a list of invalid frames,
and an **analyst wind estimate** (what a forecast would have said — an input an
analyst would legitimately have, distinct from the generator's true wind).
It also carries SHA-256 hashes of the input file and
[*commitments*](#hash-commitment) to the truth files, so a scored release can
later prove the truth was fixed before anyone ran it.

You can also **drop a BOT CSV straight into Sitrec** like any other track file:
an input file becomes a sensor track with its sightlines, a truth file becomes
a target track, an all file gives you both. That path is for *looking* at a
scenario in 3D — it places the flat-plane data on the real ellipsoid (a
curvature difference of ~2 m at 5 km, ~196 m at 50 km) and, without a sidecar,
assumes the standard set's default site. Scoring belongs in BOTBench, which
honours the flat-plane rule exactly.

## Where the scenario files come from

The scenario files are generated by the BOT Bench benchmark suite in the
source repository — they are not shipped with Sitrec, and the output directory
(`benchmarks/botbench/results/`) is deliberately not in version control:
anyone with the repo regenerates an identical set.

```bash
npm run bench-bot-interchange
```

writes the development set to `benchmarks/botbench/results/interchange/`:
`Input/`, `Truth/` and `All/` folders side by side with descriptive filenames,
plus `index.json` and `MANIFEST.json`. The set is a curated group of about
twenty scenarios spanning the space the analysis is supposed to handle:
balloons on orbiting, straight and curving sensor paths at 2–20 km; a
high-altitude balloon at 50 km; a slow [aerostat](#aerostat); cruising and
turning aircraft; a bird; Venus (the direction-only target); and matched
anomaly/control pairs — an impulsive east dash and a [20 g](#g-force-g) pulse, each paired
with a mundane twin on the same sensor trajectory. Sensor geometries range
from decisive (a 60-second orbit) to degenerate (a short straight pass), and
declared noise ranges from white jitter to correlated wobble, so the table
exercises every grade the Src column can produce.

```bash
BOTBENCH_OPAQUE=1 BOTBENCH_SEAL_SALT=$(openssl rand -hex 32) \
  npm run bench-bot-interchange
```

builds a **sealed release** for scoring third-party algorithms blind:
`challenge/` (ship this) contains only `Input/` files under opaque,
[salt](#hash-commitment)-permuted ids with randomized parameters; `answers/`
(keep this) holds the truth, the id map, and the salt. Noiseless reference scenarios and
truth-sharing duplicates are withheld, no file under `challenge/` may contain
a descriptive name, a truth column or the salt (the generator's tests enforce
this), and the per-scenario [seal hashes](#hash-commitment) let an entrant
verify afterwards that the answers were committed before they started. The `All/` folder lives under
`answers/` on purpose: it looks like a convenience file, and every row of it
carries the answer beside the measurement.

Two related commands: `npm run bench-bot-export` writes a few scenarios as
KML track pairs (sensor + target) for loading into the live app, and the wider
suite (`npm run bench-bot`, `bench-bot-physics`, `bench-bot-verdict`, …) runs
the same battery headless over the full synthetic matrix — several hundred
scenarios — which is where the calibration figures quoted in
[Traverse Analysis and the Verdict](TraverseAnalysis.md) come from.

## One number worth remembering

Because BOTBench measures the shipping pipeline end to end, its aggregate
numbers are the honest ones to quote about the analysis as a whole — including
the unflattering ones. On the standard scenario set the individual fits often
land close to the truth, while the *ranking* — the choice of which candidate to
put on top — picks the closest available candidate only a minority of the
time. That gap between "a good answer was found" and "the good answer was
chosen" is exactly the kind of thing this tool exists to make visible.

---

## Glossary

Terms as used on this page. Sitrec-wide vocabulary (sitch, node, track, and so
on) is in the main [Glossary](Glossary.md).

#### Traverse

Sitrec's name for a reconstructed path of the target object. Given the
camera's sightlines, a traverse is one candidate answer to "where was the
object along each line, moment by moment". "Bearings-Only Traversal" — the BOT
in BOTBench — is recovering a traverse from pointing directions alone.

#### Sightline

The direction from the sensor to the object at one instant — also called a
*line of sight* (LOS) or a *bearing*. Bearings-only data is a series of
sightlines with no distances attached: each one says "the object was somewhere
along this line", and nothing more.

#### Parallax

The apparent shift of an object against distant background when the viewpoint
moves — near things shift more than far things. Parallax from the sensor's own
motion is the **only** source of distance information in bearings-only data,
which is why the sensor's [baseline](#baseline) matters so much.

#### Baseline

How far the sensor itself travelled, end to end, while recording. It is the
aperture of the whole problem: no baseline, no parallax, no way to tell a
small near object from a large far one.

#### Residual

How badly a candidate track disagrees with the measured sightlines, expressed
as the mean angle (in degrees) between each measured sightline and the
direction to the candidate's position at that moment. A small residual means
the candidate is *consistent* with the data — not that it is the truth; many
different candidates can all have small residuals.

#### Hypothesis

One possible explanation fitted to the sightlines — a balloon drifting in the
wind, an aircraft at cruise speed, a drone, an object at constant altitude.
Also called a *candidate* or an *interpretation*. The analysis fits many and
ranks them; the **Top interpretation** column shows the winner.

#### Executive verdict

The one-line overall assessment the analysis issues for a file ("Consistent:
wind-blown balloon", "Unresolved", …). The exact wordings, and precisely what
each one does and does not claim, are documented in
[Traverse Analysis and the Verdict](TraverseAnalysis.md).

#### Constant Velocity (CV) family

The group of fitting methods that model the target as moving in a straight
line at constant speed, and their close linear relatives. Some tooltips
abbreviate this to "CV family" — it is the same thing. These methods are the
mathematically simplest, which is why their [conditioning](#conditioning-and-rcond)
is used as a data-quality diagnostic.

#### Conditioning and rcond

How well-posed a fitting problem is: whether the data pins the answer down, or
whether tiny changes in the input swing the answer enormously. `rcond`
(reciprocal condition number) scores this from 0 to 1 for the
[CV family](#constant-velocity-cv-family): near 1, the fit is stable; near 0,
the fit is *degenerate* — it cannot determine range, and any range it reports
is an artifact. It is a one-way test: poor rcond genuinely closes the linear
route to range, but good rcond is not a guarantee of success.

#### Degenerate

Data whose geometry cannot distinguish between very different answers — for
example, a sensor that flew dead straight produces sightlines equally
consistent with a near-slow object and a far-fast one. No amount of fitting
skill recovers information the geometry never captured.

#### Free-range methods

Fitting methods that treat the object's distance as an unknown to be
determined from the data, rather than assuming it. When the summary tiles say
a file is *range unobservable*, they mean no free-range method can succeed on
it — distance is simply not in the data.

#### Stationary-point methods

Fits that model the object as not moving at all — a hovering or fixed object
whose apparent motion is entirely the sensor's own. These can succeed on data
whose [conditioning](#conditioning-and-rcond) defeats the linear moving-object
fits.

#### Physics models

The fitting methods that model a *specific kind of object* with its real-world
constraints — a wind-blown balloon, a sky lantern, a fixed-wing aircraft, a
multirotor drone — rather than a generic motion pattern. See
[Traverse Methods](TraverseMethods.md).

#### Monte Carlo

A fitting strategy that runs many randomized trials and keeps the best,
useful for search landscapes where a single deterministic fit can get stuck.
Named after the casino.

#### Polynomial order

How bendy a fitted curve is allowed to be: order 1 is a straight line, order 2
can curve once, order 5 can wiggle several times. Higher orders fit the data
more closely but are more prone to fitting the noise.

#### Sigma

Standard deviation — here, the typical size of the pointing error, in degrees.
A sigma of 0.03° means most individual sightlines point within a few
hundredths of a degree of where they should.

#### White noise

Measurement error that is independent from sample to sample: each frame's
pointing error is a fresh random draw, with no memory of the previous frame.
A "white sigma" is the [sigma](#sigma) of such noise. This is the simplest —
and most optimistic — error model.

#### Correlated wobble

Measurement error that drifts slowly, so neighbouring frames share most of
their error — think of a camera swaying on a mast rather than jittering. Its
declared amplitude is **not** comparable to a white sigma (the `*` in the
**Decl** column marks it), and it is much harder on the fits: averaging more
frames does not average it away.

#### Gaussian

The bell-curve probability distribution that standard deviation describes.
*Isotropic* Gaussian pointing error means the error is equally likely in every
direction — no preferred axis.

#### Median

The middle value of a list — half the values are above it, half below. Used
here instead of the mean because one catastrophically bad file should not
drag the run-wide summary around.

#### Relative separation

How far a candidate track is from the truth, divided by how far away the truth
actually was: mean 3D separation ÷ mean true range. 0.1 means the candidate
tracked within 10% of the true distance; 1.0 means it was off by as much as
the whole distance to the object. Being scale-free, it lets a 2 km scenario
and a 50 km scenario share one axis.

#### ENU frame

A local **E**ast-**N**orth-**U**p coordinate system: X metres east, Y metres
north, Z metres up, all measured from a stated origin point. The BOT files
carry positions in ENU; the sidecar states where on Earth the origin is.

#### Epoch

The absolute date and time the file's clock starts at. Sightline data is
timestamped relative to it; celestial scenarios (Venus) are only meaningful at
their stated epoch.

#### Sidecar

A small companion file carrying metadata *about* a data file, matched to it by
name — here, `bot-0001.scenario.json` riding alongside `bot-0001.input.csv`.

#### FMV

**F**ull **M**otion **V**ideo — the military/ISR term for video with embedded
sensor metadata: where the camera was, and which way it pointed, recorded
frame by frame inside the video file itself.

#### MISB and KLV

**MISB** is the Motion Imagery Standards Board, which defines the US standard
for embedding sensor metadata in [FMV](#fmv). **KLV** (Key-Length-Value) is
the binary encoding that metadata is written in. A `.ts` file is an MPEG
*transport stream*, a container that carries the video and its KLV metadata
together; a bare `.klv` file is the metadata alone.

#### Hertz (Hz)

Samples per second. The BOT scenario files are 1 Hz — one measurement per
second; video is typically 25–30 Hz.

#### Nautical mile (NM)

1,852 metres — the standard unit for aviation distances. The **Range** column
and the range anchor use it.

#### G-force (g)

Acceleration in multiples of Earth's gravity. A "20 g pulse" is a burst of
acceleration twenty times stronger than gravity — far beyond what birds,
balloons or conventional aircraft can produce, which is what makes it an
anomaly scenario.

#### Aerostat

Any lighter-than-air craft — balloons and blimps. A *HAB* is a high-altitude
balloon, the kind that rides the stratosphere at 20–50 km.

#### Hash commitment

A way to prove a file existed unchanged before some event, without revealing
it: publish the file's SHA-256 *hash* (a digital fingerprint that changes
completely if even one byte changes), and later reveal the file — anyone can
re-compute the fingerprint and confirm the match. The sealed release uses
this so entrants can verify the answers were fixed before they started. The
*salt* is a secret random value mixed in so scenario identities cannot be
guessed by brute force.
