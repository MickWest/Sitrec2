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
- **Catch defects in the analysis itself.** Running hundreds of scenarios whose
  answers are known surfaces failures no single sitch would reveal — including
  the awkward kind, where the analysis was systematically *penalising its own
  best work*. See
  [Why a good fit can still read "Unresolved"](#why-a-good-fit-can-still-read-unresolved).

Everything is computed at the file's own native sample rate. A benchmark
scenario of 51 samples at [1 Hz](#hertz-hz) is analysed as 51 measurements — not resampled
onto a 30 fps video timeline where 29 of every 30 "measurements" would be
interpolation.

## What it accepts

Anything that records **where the sensor was** and **which way it pointed**,
mixed freely in one folder:

- **BOT interchange scenarios** — `<name>.input.csv` or `<name>.all.csv`, each
  optionally paired with a `<name>.scenario.json` [sidecar](#sidecar) and, on
  the answer-key side, a `<name>.truth.json` *labels* sidecar. Both are matched
  by filename automatically and are never queued as rows of their own. A
  `<name>.truth.csv` is recognised as an answer key (positions, no sightlines)
  and treated as a sidecar too — it will never appear as an error row. The
  format is described [below](#the-bot-interchange-format).
- **MISB FMV clips** — `.ts` transport streams or bare `.klv` files whose
  [KLV](#misb-and-klv) metadata carries sensor position, platform attitude and
  gimbal angles. The sightline is rebuilt from those angles with the same
  rotation code the live MISB track nodes use. A clip carrying no gimbal angles
  but recording a **frame centre** — the ground point under the optical axis —
  gets its sightline built as sensor → centre instead; where a row has both,
  the angles win.
- **Track CSVs that carry camera pointing** — any CSV Sitrec itself can import
  as a track, through the same import dispatch the File menu uses: MISB-column
  exports, Airdata drone logs, and the rest. A position-only or multi-role CSV
  refuses *with that as the reason* rather than being analysed as though it had
  pointed somewhere.
- **DJI `.srt` sidecars** that carry gimbal angles. The extension alone cannot
  tell those from ordinary subtitles, so a folder walk **reads** each `.srt`
  before queuing it — the one content check in an otherwise name-based sweep.
- **[STANAG 4676](#stanag-4676) tracks** (`.csv`, or `.xml` when you pick the
  file by hand). The sightline is the platform-and-ground endpoint pair each
  track point carries. The producer's own target estimate lies on that same ray
  and is deliberately **not** scored as truth.

Ordinary video files (`.mp4`, `.mov`, …) are *not* queued: they carry no
sightline metadata, so each one would only ever produce an error row. `.xml` is
not walked for the same reason — a folder may hold XML for a hundred unrelated
reasons — but *is* accepted when you pick the file yourself, which is a
statement that you mean that file.

Files that cannot be trusted are **refused with the reason** rather than
analysed anyway: a sidecar that exists but does not parse, a sidecar that fails
to state its coordinate frame, a `Time` column that never advances, a truth-only
file with nothing to analyse. A file that yielded no usable samples says whether
it was **pointing** or **position** that was missing, with a count per cause, so
a clock that was fine is never blamed for a metadata gap. An error row tells you
what was wrong with the file; it never silently falls back to guesses.

Besides the window's own pickers, a run can start from the
**Track Browser**'s *Open in BOTBench* button, which hands over the files it
has already walked — sidecars included. A run started that way is
indistinguishable from one started here.

---

## The window, top to bottom

The window is a controls row, a status line and progress bar, a row of summary
tiles, and then the results table — one row per file, its columns split into a
**SOURCE DATA** group (measured before any fit runs) and an **ANALYSIS RESULT**
group.

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
- **Folder (Read)** — pick a folder to scan, with **read-only** access. You can
  also drag a folder from your file manager anywhere onto the window. (Folder
  picking needs a Chromium-family browser; elsewhere, use Choose Files or
  drag-and-drop.) Caches already sitting in the folder are still *reused*, but
  no new ones are written.
- **Folder (Caching)** — the same scan, but granting the page **write** access
  to the folder and everything under it (the browser will ask). Results are then
  cached in the folder so a re-run skips the optimizers — see
  [the result cache](#the-result-cache) below.
- **Choose Files** — pick individual files. Note that BOT files chosen without
  their `.scenario.json` sidecars fall back to the standard scenario set's default site
  for the coordinate origin, and take their sample rate from the CSV's own
  `Time` column (recorded as a warning on the row) — fine for the standard
  scenarios, wrong for files generated at another site.
- **Cancel Run** — stop the run. The file being analysed when you click is
  abandoned at its next checkpoint and its row is marked *cancelled*; rows that
  already finished keep their results, and the files after it stay unanalysed.
- **Clear Results** — empty the table and start fresh.
- **Flush Cache** — delete the cache from every folder this run touched, so the
  next run analyses everything from scratch. Rarely needed: a stale cache
  normally detects itself and re-runs (see below).
- **Export JSON** — save every row's measurements and conclusions (not the
  fitted tracks) for machine consumption.
- **Export CSV** — one row per file, for a spreadsheet. The export is built from
  an explicit column list rather than from whatever the row happens to hold, and
  a test asserts the list covers the row — so a newly added measurement cannot
  quietly go missing from the CSV.
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
  carry no truth (see [file generation](BOTBenchScenarios.md)).
- **Median |err|** — [median](#median) line-of-sight [residual](#residual) of
  the top-ranked interpretation across the run, in degrees: how well the
  winning candidates fit their sightlines.
- **Median rel. sep** — shown when truth exists: the median, over the scored
  files, of the top interpretation's mean 3D separation from truth divided by
  the mean true range. It is scale-free, so a 2 km scenario and a 50 km
  scenario compare on the same axis. 0.1 means "on average within 10% of the
  true range of the right place"; 1.0 means "as far from the truth as the truth
  is from the camera".
- **Best candidate** — the same measure, but for the *closest candidate any
  method produced* on each file. Truth picks that winner, so this is an
  [oracle](#oracle): a ceiling, never a score the analysis could claim. Read it
  beside *Median rel. sep* — that tile scores the **ranking**, this one scores
  the **fits**.
- **Ranking cost** — the median of (top interpretation's error ÷ closest
  candidate's error). `1x` means the ranking chose the best available answer
  every time. A large figure means the fits had already found the object and the
  selection stage discarded it — a completely different repair from the fits
  missing it, which is why the two are separated.

### The results table — SOURCE DATA columns

These are measured from the file **before any fit runs**. They describe what
the data can support, and they are the first place to look when a verdict
disappoints.

- **File** — path relative to the chosen folder, or the scenario's *descriptive
  name* where an answer-key sidecar supplies one (the path then moves to the
  tooltip). **Click it to open that scenario in a new Sitrec window** — the
  sensor track, the truth track and the analysis's own consistent candidates,
  loaded as ordinary tracks so you can look at them in 3D. See
  [Opening a row in Sitrec](#opening-a-row-in-sitrec).
- **Status** — progress while running, then the final state (`done`, `cached`,
  or an error; hover for detail).
- **Target** — what the object **actually was and what it was doing**, read from
  the answer-key sidecar. A flag marks a scenario *declared anomalous*, where
  "unresolved" is the correct outcome and used to look identical to failure. A
  sham splice is labelled as a sham. Blank on challenge files, which carry no
  answer by design. This is a **source** column, not an analysis one: nothing
  derived from it reaches any fit — it is shown so a verdict can be judged
  against what was true.
- **Platform** — what the sensor flew: declared by the sidecar where there is
  one, otherwise **measured** from the sensor path (straightness and sweep) and
  shown in *italics* to mark it as inferred. The platform's path is what makes
  range solvable at all, so this is the first thing to read when a file fails.
- **n** — usable samples in the file, at its own native rate.
- **Dur** — clip duration in seconds.
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
- **Noise** — the pointing noise **measured from the sightlines**, divided by
  the noise the file **declares**: a ratio, so `1.0` means the sightlines carry
  exactly the error they claim. The measurement uses no model of the target —
  it is the median angle by which each sightline deviates from the direction
  midway between its two neighbours, converted to a [sigma](#sigma) under an
  explicit assumption ([isotropic Gaussian](#gaussian) pointing error on a
  locally straight path). Both raw figures are in the tooltip. A ratio outside
  roughly 0.7–1.4 on a white-noise declaration is highlighted, because that is a
  real disagreement worth chasing. A trailing `*` marks a
  [**correlated** error model](#correlated-wobble) — slow wobble rather than
  white jitter — whose declared amplitude is a *deadband amplitude*, not a
  standard deviation: the ratio there is not like-for-like and reads far below
  1. That gap is the signature of wobble, not a bug, and the column never
  highlights it.
- **Src** — a one-word triage of everything to the left: **good** (nothing
  flagged), **fair** (minor flags: marginal conditioning, irregular timing,
  timing gaps, or a missing sidecar), **hard** (conditioning poor — the linear
  route to range is closed), **weak** (a fundamental degeneracy: fewer than 10
  frames, a sensor that barely moved, or a sightline that barely swept). It is
  a sort key, not a calibrated score — hover it for the specific reasons, and
  the numbers it came from are all in the row. The tooltip also carries the
  earth and ground models actually in force for this file, and the
  [geometry probe](#geometry-probe): whether pure geometry *pinned* a range with
  no speed assumption involved, pinned one whose implied speed was implausibly
  high (read that as **recoverable** — a fast object at a pinned range is a
  finding, not an ambiguity), or left range genuinely ambiguous so the fit fell
  back to its speed prior. The probe speaks for geometry only; physics and
  [stationary-point](#stationary-point-methods) methods may still succeed where
  it says "prior".

### The results table — ANALYSIS RESULT columns

- **Verdict** — the [executive verdict](#executive-verdict) for this file,
  shortened to fit the cell; hover for the full headline. The wordings and exactly what each one
  licenses you to say are documented in
  [Doing Defensible Analysis §7](DefensibleAnalysis.md#7-reading-the-executive-verdict-without-over-reading-it). "Unresolved" on a
  row whose Src column says **hard** or **weak** is the system being honest
  about data that cannot support a conclusion.
- **Top interpretation** — the highest-ranked candidate (e.g. *Sky Lantern /
  Balloon*, *Constant Altitude*, *Quadcopter*) and its rank tier. Ranking is
  **blind**: truth, even when the file carries it, plays no part in choosing
  the winner — it is only used afterwards, to score the choice.
- **|err|** — the top interpretation's mean line-of-sight
  [residual](#residual) in degrees, and after the slash the
  **[noise floor](#noise-floor)** — the residual a *perfect* track would score
  against the file's own declared pointing error. A residual at or below the
  floor is fitting the noise, not the object, and cannot be read as a good
  answer. The two belong together because the residual is nearly **invariant to
  where along the sightline a track sits**: three files in one run once tied at
  0.039° while sitting 0.2%, 1.4% and 97.5% of range from truth. A residual
  cannot carry range, and a column that showed it alone invited the opposite
  conclusion.
- **Range** — the top interpretation's start range, in nautical miles.
- **Spd (Knots)** — the top interpretation's air speed over the clip, min–max.
- **Alt (ft)** — the top interpretation's mean altitude.
- **Truth** — where truth exists: the top interpretation's
  [relative separation](#relative-separation) from it (the per-file version of
  *Median rel. sep*), or, for a direction-only target, its bearing error in
  degrees.
- **Best** — the same measure for the **closest candidate any method produced**.
  Truth picks that winner, so it is an [oracle](#oracle) and not an achievable
  score. This is the single most diagnostic column in the table: a small **Best**
  beside a large **Truth** means the answer *was found and then out-ranked* —
  which the Truth column alone cannot distinguish from never finding it at all.
  Hover for which method produced it.
- **Gallery** / **Report** (last column) — **Gallery** opens the full-screen
  candidate gallery for this file, the same view the live Analyze button
  produces, with no recomputation; **Report** builds and opens the full HTML
  analysis report on demand. Both work on cached rows as well as fresh ones,
  and are disabled only for a row with no analysis at all (an error, or a
  cancelled run). One difference from the live gallery: **Use exact result** is
  disabled for bulk rows, with a note explaining why — the fitted track lives in
  some other file's local coordinate frame at its own epoch, and applying it to
  the currently loaded sitch would silently corrupt it.

### Why a good fit can still read "Unresolved"

A candidate badged **Optimizer incomplete** is treated as *ineligible*, and
eligibility is exactly what the [executive verdict](#executive-verdict) counts
as "consistent". So that one badge propagates from a gallery tile all the way to
the **Verdict** column and the **Resolved** tile. It is worth knowing when the
badge is real and when it is not.

**What the optimizer is doing.** The physics fits use **Nelder-Mead**, a
derivative-free search. For a model with *n* free parameters it keeps *n*+1
trial parameter sets — the [**simplex**](#simplex) — and repeatedly throws out
the worst one, reflecting it through the others, so the whole shape crawls
downhill and shrinks around a minimum. Two different things can therefore be
said to have converged: the **costs** at the vertices can all be nearly equal (a
*flat objective*), and the **vertices themselves** can be nearly coincident (a
*collapsed simplex*).

Sitrec's line-of-sight fits require **both**. Cost-only stopping is unsafe here:
an unobservable parameter can span most of its allowed range while every vertex
scores identically, and stopping on cost alone would report that parameter as
determined when the data never constrained it at all.

The consequence is that hitting the iteration budget is **not** by itself an
unfinished search. There are two ways to hit it that are really convergence, and
each is recognised explicitly:

- **The objective settled, but some parameters are still wide.** That is an
  *identifiability* limit, not an optimizer failure — those parameters were not
  measured. A sky lantern whose solved flame-out lies beyond the end of the clip
  never exercises its sink and cool-down parameters, so nothing can ever close
  the simplex along those axes. The tile says so, naming the unconstrained
  parameters, and never claims convergence for them.
- **Every parameter collapsed, but the cost spread never settled.** The simplex
  has nowhere left to move, so no further iteration could shrink the cost spread
  — there is no x-movement left to shrink it with. This is convergence.

That second case used to be badged incomplete, and the effect was backwards: **it
penalised precision.** Measured on `botset_balloons_orbit` at 3.219 km in a
steady wind, the fit that recovered truth to a
[relative separation](#relative-separation) of **0.00015** drove its simplex to a
*full* collapse — "spans 0.00% of parameter bounds" — was stamped incomplete,
cost the balloon class its viability, and made the whole file report
**Unresolved**. A deliberately sloppier fit of the same file, with a residual
100× worse and its range 200 m out at a relative separation of 0.032, settled
into a broad flat basin, met the cost tolerance, was stamped complete — and
*resolved*. The better the answer, the likelier it was refused.

Between those two exceptions, the only remaining iteration-limit stop is a
search that genuinely was still moving, and that keeps the warning. Where the
per-parameter spreads are missing entirely, the warning is also kept: silence is
never inferred from an absent measurement.

### Plotting two columns against each other

Every numeric column header is clickable, and assigns that column to a scatter
plot axis: **left-click = X**, **right-click = Y**, **middle-click = dot size**.
Choose an X and a Y and the run plots as a sized scatter in a floating graph
window, light-themed so it prints. Hovering a dot outlines and scrolls to its
table row. The extractors pull the **raw** value from each result rather than
parsing the formatted cell, so a column that switches between metres and
kilometres in the table still plots on one consistent axis. The plot extends
itself as further rows complete, so it can be opened mid-run.

### Opening a row in Sitrec

Clicking a row's **File** cell opens that scenario in a fresh Sitrec window.
The rows come from a folder picker or a drag, so the file is an in-memory blob
with no path for a link to point at — the bytes are handed over through an
internal handoff store instead, and the new window loads:

- the **sensor track** with its sightlines, and the **truth track** where one
  exists (drawn with the usual ground-truth marker);
- the analysis's own **consistent candidates**, as ordinary tracks named
  `c_<type>` — one per candidate type, the best-ranked standing for its family
  and the rest counted in the sitch Notes. Where nothing passed the consistency
  screen the **weak** band travels instead, named `w_<type>` with the reason it
  was declined in the Notes. That is a *fallback*, not an addition: a
  bound-pinned solve standing beside an endorsed one would read as its peer.
- The camera, heading and zoom are claimed by the **sensor's own** recorded
  angles and field of view once the sensor track exists, rather than by
  whichever track won the parse race.

The sidecars travel as **Notes**, not as files. The conversion from the
scenario's local frame back to latitude/longitude uses the interchange
format's own flat-plane rule — using the general tangent-frame conversion
instead put candidates 40 m from a truth track the analysis had scored at 2.8 m,
which is the geoid separation plus curvature almost exactly.

### The result cache

Choosing a folder with **Folder (Caching)** lets a run store its work in the
folder itself: a `.botbench-cache.json` index per leaf folder, plus a
`.botbench-cache/` folder holding one fitted battery per file. On a later run an
unchanged file skips the optimizers — the expensive part — and everything
downstream of the fit is **replayed** rather than restored, so a cached row is
identical to a fresh one and Gallery, Report and Open-in-Sitrec all work.

A cache entry is used only when the input hashes, the analysis options **and**
the app version all match, *and* replaying it reproduces the row it was stored
with. A stale cache therefore normally re-runs itself; **Flush Cache** is for
the cases where you want that forced.

---

## What a bulk run deliberately does not do

The fits are identical to the live button's; the *environment* is not, because
there is no loaded scene. Every difference is stated with the results rather
than left to be discovered:

- **Flat terrain.** A BOT scenario is generated on a flat plane, so the ground
  is a level surface at the site elevation — exactly as the scenario generator
  defines it. An FMV clip has no scene either, so its ground plane is taken from
  the **file's own frame-centre elevations**: the producer's recorded terrain
  height under the optical axis, median over the clip. That matters more than it
  sounds — defaulting to sea level over Cheyenne puts the ground 1,867 m below
  the real surface, so buried candidates passed the underground screen and the
  ground-vehicle fits rode a plane a kilometre under the road. Under five
  samples, or a median at or above the lowest sensor height, falls back to sea
  level. The row records which model was used (hover **Src**).
- **No wind field.** The free balloon fit still runs and infers its own wind;
  only the *Sky Lantern / Balloon (measured wind)* variant, which needs a wind
  source, is skipped — and it is reported per file as "not tested — no wind was
  supplied", never silently omitted.
- **No scene [hypotheses](#hypothesis).** No astronomy sweep, no satellite catalogue, no live
  line-of-sight-fitting method nodes from the interactive scene. These are
  listed under *absent hypotheses* in every
  report and export, so a missing interpretation is never mistaken for negative
  evidence — "no satellite matched" and "no satellite catalogue was searched"
  are different statements.
- **One range anchor for the whole run** (see the Range anchor control above).

## How ordinary is the answer?

Alongside the residual, every candidate carries an **ordinariness** score: how
far outside the envelope of the nearest real object class it sits, in
[decades](#decades-order-of-magnitude). `0` means every quantity — size, speed,
sustained acceleration — falls inside *some* real class; `1` means the best
available class is off by a factor of ten somewhere.

It shows on each gallery tile as *Ordinariness*, with the binding quantity
named, because "anomalous" without a named quantity is not a finding — for
example *"nearest ordinary object is a light aircraft, and this misses that
envelope by 12x on acceleration"*. A bulk run carries the **same score from the
same function**: three columns in the **Summary** report, and in the CSV export
the per-term breakdown (size, speed, acceleration) beside the **Ord** total, since a
total alone cannot say which term carried it.

**It is disclosure, and it does not move the ranking.** That is deliberate: the
score has to be judged against real files before it is allowed to decide
anything.

The score is **joint, never marginal**, and that is the whole point. A size test
on its own cannot refute a solution that has collapsed toward the camera: a
candidate at 500 m implies an object 0.28 m across, and 0.28 m is a perfectly
ordinary size. What refutes it is the **pair** — 0.28 m sustaining 300 knots. A
bird is the right size and impossibly fast; an aircraft is the right speed and
impossibly small. So each class is judged on all of its quantities at once and
the candidate keeps the *best* class it can find: a candidate is as mundane as
the most ordinary object that could have produced it.

The three columns are three different claims:

- **Ord** — how ordinary the candidate the ranking **picked** is.
- **OrdMin** — how ordinary the data **allows** any candidate to be, anywhere in
  the gallery.
- **OrdErr** — that most-ordinary candidate's own residual, and it must be read
  with **OrdMin**, because OrdMin is ungated by residual. A low OrdMin at a high
  OrdErr is an ordinary explanation that *does not fit*. A bare `0.00` with no
  OrdErr beside it would read as though one did.

On a bearings-only problem **OrdMin is routinely far below Ord**, and a single
column would hide exactly that. A low OrdMin at a *low* OrdErr, beside a high
Ord, is the real finding: an ordinary explanation exists **at a different
range**, and the sightlines alone cannot choose between them. Measurement on the
benchmark sets bears this out: across fifteen *declared-anomalous* scenarios,
the most ordinary candidate the analysis could find was in every case at least
as ordinary as the true object, and in eight of the fifteen it sat entirely
inside a real object's envelope — a fixed-wing model reproduced a 50 g turn's
sightlines to 0.0037° with completely ordinary kinematics. That is not a defect
in the analysis; it is the scale degeneracy of bearings-only data, restated in
units a reader can act on. The practical consequence is blunt: **do not treat a
low residual alone as a finding**, because almost everything fits a
bearings-only problem somewhere along the line.

The framing matters and is easy to get backwards. A high ordinariness cost is a
**positive finding about the object**, not a failure to explain it away, and the
question the tool asks is always whether a mundane explanation *exists* — never
which explanation it would prefer.

### Implied object size

Where the file publishes an
[angular-diameter bound](#angular-diameter-bound), each candidate also reports
the physical size its range would imply — the part of the answer a reader can
sanity-check by eye against the video.

When the target is **sub-pixel** the bound sits at its floor of about two
[IFOVs](#ifov), the implied interval collapses to `[0, hi]`, and the display
says so: *"under 2.11 m at this range — target is sub-pixel, so there is no
lower bound"*. Printing "0.00–2.11 m" there would read as a measured interval
when only the upper half is one. This is not an edge case: on the straight
balloon set a 0.35 m party balloon is between 0.05 and 0.67 pixels across in
**all twenty** scenarios.

The upper bound is still real evidence, and the arithmetic behind the score is
unchanged by the wording — it refutes any candidate that has collapsed inside
`D_min / θ_max`, which is 611 m for the smallest class the score knows about.

---

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

The full specification (currently **v1.2**) ships with the benchmark as
`benchmarks/botbench/BOT-Interchange-Format.html`. The short version:

One schema, three views of the same data:

| File | Columns | Role |
|---|---|---|
| `<name>.input.csv` | `TrackID, TrackSource, Time, SensorPositionX/Y/Z, LOSUnitVectorX/Y/Z, MaxRange, LOSUncertainty, AngularDiameterMaxDeg` | the challenge |
| `<name>.truth.csv` | `TrackID, Time, TruePositionX/Y/Z` | the answer key |
| `<name>.all.csv` | input columns + truth columns | both, joined row-for-row |

`AngularDiameterMaxDeg` (new in v1.2) is an **upper bound** on the target's
observed angular diameter — never the exact subtended angle. Paired with a
*minimum plausible diameter* for an assumed object class it gives a range
**floor**, `R ≥ D_min / θ`, and that floor is the only quantity in the whole
format that opposes the scale degeneracy bearings-only data suffers from. It is
deliberately a bound: publishing the exact `D/R` would let any consumer that
assumes a diameter read range straight off, which would dissolve the benchmark
rather than inform it. The bound can never be tighter than one
[IFOV](#ifov), so a target far enough away to be sub-pixel still reports about
one — read `sensor.pixelsAcross` in the sidecar to know what that is. Blank
where the scenario declares no target size, and blank for direction-only
targets, which have no finite range.

Positions are metres in a **local [ENU frame](#enu-frame)** (the sidecar declares
`axisOrder: "X=East, Y=North, Z=Up"` explicitly, because a consumer that
guesses X=North gets a mirrored scene that is perfectly consistent with its own
bearings). Scenarios are generated on a **flat plane**: altitude is Z plus the
site's ground elevation at any horizontal distance. The truth columns are
deliberately empty for a direction-only target.

The `<name>.scenario.json` sidecar carries everything the CSV cannot: the frame
origin (latitude, longitude, ground elevation), the [epoch](#epoch), the sample
rate, the declared line-of-sight error model ([white sigma](#white-noise) or
[correlated wobble](#correlated-wobble) — the `*` in the Noise column), the
sensor field of view **and its width in pixels**, a list of invalid frames, and
an **analyst wind estimate** (what a forecast would have said — an input an
analyst would legitimately have, distinct from the generator's true wind).
It also carries SHA-256 hashes of the input file and
[*commitments*](#hash-commitment) to the truth files, so a scored release can
later prove the truth was fixed before anyone ran it.

Answer-key folders additionally carry a `<name>.truth.json` **labels** sidecar:
what the object was, its class, its *true* physical diameter, whether it was
declared anomalous, and the events spliced into it with their onset times. That
is what fills the **Target** column, and it is why a bulk run can flag "this
scenario was declared anomalous" without any of it reaching a fit.

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

That has its own page: **[BOTBench Scenario Files](BOTBenchScenarios.md)** —
the curated interchange set, the swept botsets and what each was built to
answer, the sealed-release commitment, and the commands that build them.

## One number worth remembering

Because BOTBench measures the shipping pipeline end to end, its aggregate
numbers are the honest ones to quote about the analysis as a whole — including
the unflattering ones. On the standard scenario set the individual fits often
land close to the truth, while the *ranking* — the choice of which candidate to
put on top — picks the closest available candidate only a minority of the
time. That gap between "a good answer was found" and "the good answer was
chosen" is exactly the kind of thing this tool exists to make visible, and it is
now measured directly: the **Best** column and the **Ranking cost** tile exist
because a run once reported a median relative separation of 0.680 while the
closest candidate any method produced had a median of 0.015 and landed within
10% of range on 8 files of 10. The fits had found the objects; the ranking
picked that candidate once. Those are opposite repairs, and the table has to be
able to tell them apart.

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
[Doing Defensible Analysis §7](DefensibleAnalysis.md#7-reading-the-executive-verdict-without-over-reading-it).

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
their error — think of a camera swaying on a mast rather than jittering, or an
operator chasing a target and over-correcting. Its declared amplitude is a
*deadband amplitude*, **not** comparable to a white sigma (the `*` in the
**Noise** column marks it), and it is much harder on the fits: averaging more
frames does not average it away. It is nonetheless **zero-mean** — it recentres
— which is what separates it from [drift](#drift-error).

#### Drift error

Pointing error that slides steadily **one way** off the target instead of
wobbling about it. Not zero-mean, and therefore the error a short clip cannot
absorb: over twenty seconds a slow slide is indistinguishable from the target
genuinely drifting — which is exactly the question a balloon scenario exists to
ask. The balloon botsets use this ladder; the maneuver botsets use
[wobble](#correlated-wobble).

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

Samples per second. The interchange scenario files are 1 Hz — one measurement
per second; the [botsets](#botset) are 10 Hz; video is typically 25–30 Hz.
Everything is analysed at the file's own rate, never resampled.

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

#### Simplex

The set of *n*+1 trial parameter sets a **Nelder-Mead** search carries for a
model with *n* free parameters — a triangle in two dimensions, a tetrahedron in
three, and so on. Each step replaces the worst vertex by reflecting it through
the rest, so the shape walks downhill and shrinks. A **collapsed** simplex is
one whose vertices have converged onto essentially the same point: there is no
movement left in it, which is why a collapse counts as convergence even if the
costs at those vertices never flattened out. Sitrec reports the collapse as a
percentage of the parameter bounds, so "spans 0.00%" means fully collapsed.

#### Botset

One of the five large **swept grids** of generated scenarios — a full taxonomy
crossed with a duration or geometry axis and an error ladder, published as its
own folder tree. The point of a swept set rather than a curated one is that a
result reads as a *curve* across the ladder: not "the analysis scored 0.2", but
"the analysis holds to the 5% rung and collapses at 20%".

#### Angular-diameter bound

An **upper bound** on how large the target appeared, in degrees, published per
scenario as `AngularDiameterMaxDeg`. Combined with a minimum plausible diameter
for an assumed object class it gives a range **floor**: `R ≥ D_min / θ`. It is
the only measurement in the interchange format that pushes back against the
scale degeneracy of bearings-only data, and it is deliberately a bound rather
than the exact `D/R`, which any consumer assuming a diameter could read range
straight off. A bright unresolved source blooms across neighbouring pixels, so
apparent extent always *overstates* true size — the safe direction here, since
overstating θ only weakens the floor it implies.

#### IFOV

**I**nstantaneous **F**ield **O**f **V**iew: the angle one pixel covers —
the field of view divided by the frame width in pixels. It is the resolution
limit of the whole measurement. An
[angular-diameter bound](#angular-diameter-bound) can never be tighter than the
IFOV, and is published with a further pixel of margin, so a target too far away
to resolve ("sub-pixel") reports a floor of about two IFOVs — and the
implied-size interval it produces then has an upper end only. The extra pixel is
deliberate: overstating θ only *weakens* the range floor it implies, which is
the safe direction to be wrong in.

#### Decades (order of magnitude)

Factors of ten. The ordinariness score is measured in decades outside the
nearest real object class's envelope, so it reads directly: `0` means every
quantity sits inside some class, `1` means the best available class is off by a
factor of ten somewhere, `2` by a hundred.

#### Noise floor

The [residual](#residual) a **perfect** track would score against a file's own
declared pointing error — `sigma x sqrt(pi/2)`, because the pointing error is
two Gaussians in the tangent plane and its magnitude follows a Rayleigh
distribution. A fit at or below the floor is fitting the noise, not the object.
It is shown after the slash in the **|err|** column so a small residual can
never be mistaken for a good answer.

#### Oracle

A score computed **using the answer** — here, the *closest candidate any method
produced*, chosen by comparing every candidate against truth. It is a ceiling
on what the fits could deliver, never a score the analysis could claim for
itself, because the real analysis has to choose blind. Its distance from the
achieved score is exactly what the ranking costs.

#### Geometry probe

A data-quality check made by **attempting the extraction** rather than by
grading entry conditions. The Minimum Acceleration fit's first stage tries to
pin a range from pure trajectory smoothness, with no assumption about the
object's speed; whether it succeeded rides every row in the **Src** tooltip.
Three outcomes: geometry pinned a range; geometry pinned one whose implied
speed was implausibly high, so the fit fell back to its prior (read as
*recoverable* — a fast object at a pinned range is a finding, not an
ambiguity); or geometry left range genuinely ambiguous. It speaks for geometry
only.

#### STANAG 4676

The NATO standard for exchanging **motion imagery tracks** — a track as a
series of points, each carrying the platform's position and the corresponding
ground point, rather than raw camera angles. BOTBench builds the sightline from
that endpoint pair. The producer's own estimate of the target sits on the same
ray, which is why it is never scored as truth.

#### Hash commitment

A way to prove a file existed unchanged before some event, without revealing
it: publish the file's SHA-256 *hash* (a digital fingerprint that changes
completely if even one byte changes), and later reveal the file — anyone can
re-compute the fingerprint and confirm the match. The sealed release uses
this so entrants can verify the answers were fixed before they started. The
*salt* is a secret random value mixed in so scenario identities cannot be
guessed by brute force.
