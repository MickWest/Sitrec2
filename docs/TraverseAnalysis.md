# Traverse Analysis and the Verdict

This document covers **Traverse ▸ Analyze Traverse Methods…** — the button that runs every
method at once, ranks the results, and issues an executive verdict — and how to read what it
gives you without reading more into it than it says.

For how each individual method computes a path, see [Traverse Methods](TraverseMethods.md).
For how to conduct and write up an investigation, see
[Doing Defensible Analysis](DefensibleAnalysis.md).

---

## Physically Plausible Analysis (the Analyze button and the extra fits)

LOS-only data never uniquely determines a trajectory: near-perfect fits exist
at many ranges, provided the object is allowed to maneuver. The tools in this
section make that ambiguity explicit. Each fit adds one *stated assumption* (a
nominal speed, roughly straight and level flight, low kinematic acceleration)
as a soft target rather than an exact constraint, so that it can report, for
every range, how much maneuvering the sightlines would force on that
assumption. The targets define the question each fit asks; they are not a
preference of the analysis. The interesting output is the family of plausible
solutions — and how much maneuvering every *other* interpretation would require.

### Global Fit: Minimum Acceleration

(Formerly "Global Fit: Plausible" — the display name now describes the
algorithm's objective rather than a claimed result; saved sitches still
serialize the original menu key.)

**Model**: the range along each LOS ray is a smooth cubic B-spline λ(f)
(25 control points). The trajectory follows the rays, with a soft range floor
(so it can never end up behind the camera) and a light output smoothing that
sheds frame-scale pointing jitter; the acceleration objective is measured
over ~half-second strides so that jitter cannot dominate it.

**Method**: two-stage. Stage 1 solves a pure-smoothness (no speed target)
coarse sweep over range: when the sensor itself maneuvers (an orbit, a hard
turn), geometry alone pins the range — the smoothness-vs-range valley is
decisive and the speed target is *not used* (the Minimum Acceleration Fit
Results folder shows "not needed (geometry)"). Only when that valley is flat — the classic
narrow-baseline case like Gimbal, where range is unobservable from geometry —
does Stage 2 fall back to the soft air-speed target
`((airspeed − Target Speed)/σ)²` with σ ≈ 60 kt (IRLS), which is then what
gives the plausibility-vs-range curve a real minimum. The winner is refined
and re-solved at full quality (the result appears as **Found Range**; the
**Min Dist** / **Max Dist** limits in Traverse Analysis Tweaks bound the
search). Where Constant Air Speed holds a speed *exactly*, Minimum
Acceleration treats speed (when used at all) as a loose target and finds the
smoothest path consistent with the rays.

**When to use**: as the "best fit" interpretation of a hypothesis like
"a ~350 kt aircraft at ~30 NM" — it shows what the *smoothest* version of that
hypothesis looks like, and its acceleration/turn metrics quantify how demanding the
hypothesis is at that distance.

### Global Fit: Minimum Speed

**Model**: the same on-the-rays B-spline range profile as Minimum
Acceleration, but the
objective is inverted: instead of the least-maneuvering path near a target
speed, it finds the **slowest** object consistent with the sightlines, then
applies a curvature-penalized smoothing pass that sheds sensor pointing
jitter (which would otherwise read as enormous kinematic acceleration on a slow object).

**When to use**: this is the drifting-lantern / near-static reading. When the
sensor orbits or passes a slow, close object, most of the apparent motion is
the sensor's own parallax — the slowest consistent object is then a
near-static drifter (the classic Aguadilla answer, ~12 kt). It takes no
parameters; the range follows from where the sightlines let an object move
least. A final few IRLS passes level the air speed over the first/last 15%
of the clip (the spline endpoints are data-starved, so without this the
speed graph of an exactly-constant-speed object read as a ±5 kt end wobble).
The Analyze gallery's **Minimum Speed** candidate uses this same fit, so
applying it reproduces exactly the previewed path.

### Global Fit: Physics — the dynamics models

The Physics fit integrates a real dynamics model forward with RK4 and fits
its parameters to the sightlines with **differential evolution** (a
genetic-style global search) followed by Nelder-Mead polish. Three models are
available via the **Physics Model** dropdown in the Traverse menu:

**Sky Lantern** — pure wind-drift kinematics. A sky lantern is a
near-perfect wind tracer (grams of mass, large drag area), so its horizontal
velocity *is* the wind at its current altitude: a solved wind vector with a
linear altitude shear (clamped so it can never reverse or blow up — the wind
aloft is allowed to be stronger, e.g. "wind from the east, increasing with
altitude"). The wind may also **vary smoothly across the clip** (a duration-
invariant linear + quadratic drift, priced by a variability prior so it cannot
wander without support), letting the balloon follow a gently curving drift as
real wind veers over minutes — a constant wind can only produce a straight
ground track. Vertical motion follows the lantern life cycle — rise while the
flame burns, exponential buoyancy decay after flame-out, terminal sink — and
the solved flame-out time can fall before the clip (a lantern already in its
cooling descent, the Aguadilla case), inside it, or after it (still climbing
throughout). The base-wind components are bounded to ±40 m/s, the shear
multiplier to 0.25–3, and rise/sink parameters to 4 m/s. Those are broad search
constraints, not a certified lantern envelope: the wind box is wide enough to
reach ordinary winds aloft from any bearing, and along its diagonal it admits
110 kt, which is not lantern-like. Excluding non-lantern motion is the job of
the light-wind speed prior and the kinematic ordinariness screen, not of the
box. Its residual measures
compatibility with this particular wind-tracer/life-cycle model, not the
probability that the object is a lantern. Bound-pinned and shear-clamped
solutions therefore need explicit scrutiny.

**Fixed Wing Aircraft** — constant horizontal airspeed, a linearly-varying turn rate,
constant climb rate, and wind advection. Parameters (initial range, heading,
horizontal airspeed, turn rate, turn acceleration, climb, wind E/N) share the same DE +
polish recipe; the cost combines LOS angular error with explicit soft targets
for speed, turn, climb, and (when supplied) wind. The generic conventional
prior searches 25–360 m/s horizontal airspeed and ±40 m/s climb. It does not
cover every fighter in the catalog, and a result on a bound makes this test
incomplete rather than excluding every possible fixed-wing aircraft.

**Quadcopter** — a hover-capable multirotor drone. Unlike a fixed-wing, it
needs no forward airspeed to stay aloft, so ground speed is free to fall to
zero (hover) or rise, the heading can swing on a wide turn budget, and it can
climb or descend far more steeply than a plane. Parameters (initial range,
heading, speed, along-track acceleration, turn rate/acceleration, climb, wind
E/N) fit with the same DE + polish recipe. A selected make/model bounds initial
speed and vertical rate and penalizes full-clip overspeed. The generic fit
permits initial ranges from 50 m to 20 km and air-relative horizontal speed up
to 60 m/s. This is a broad kinematic compatibility test: acceleration can push
the trajectory beyond nominal speed during the clip, so it is not a hard
flight-envelope certification.

**Make / model (Fixed-Wing and Quadcopter).** When Fixed Wing or Quadcopter is
selected, a second dropdown chooses a specific airframe/drone whose approximate
performance envelope tightens the fit bounds — Cessna 172, Boeing 737-800,
MQ-9 Reaper, F/A-18E/F, F-35, F-16; DJI Mini 4 Pro, Air 3, Mavic 3, Phantom 4
Pro, DJI FPV, Racing FPV. Both default to **AUTO**, which fits a generic
envelope and can report the closest compatible catalog envelope from speed,
climb, g, and altitude where available. Quadcopter climb capability is
direction-aware: a solved descent is checked against the drone's maximum
descent rate (usually the smaller number), not its climb rate. Catalog
figures are approximate values used to bracket and describe the search, not
exact specifications or IDs.

Solved parameters (wind, rates, fit error, and any selected/compatible catalog
envelope) appear in the Physics Fit Results folder. Residuals from different
models are not directly comparable object-type probabilities: the models have
different parameter counts, priors, bounds, and wind freedom. Use them as
model-conditioned diagnostics and inspect bound hits and sensitivity.

**Drone (flown inputs)** — a gallery-only companion to the free Quadcopter that
asks a different question. The free Quadcopter asks "is there *any* path inside
the envelope that fits?" — almost always yes, which is how it can produce a
many-revolution corkscrew that buys a tiny residual. The flown-inputs fit instead
models a drone as a *few held control inputs* (forward speed, yaw, climb, changed
occasionally): it seeds from the best geometric path, inverts it into the control
history needed to fly it, and refines while paying for control **effort** — how
much the inputs must move — rather than for path shape. Holding an input is free,
a steady orbit is cheap, and an aggressive-but-deliberate manoeuvre stays
reachable; only motion that buys no residual (the corkscrew) is priced out.
Reading the gap between its residual and the free Quadcopter's is the point: a
small gap means an ordinary flight explains the sightlines as well as any
contortion.

### Ground contact and underground rejection

LOS-only geometry can produce trajectories that pass **underground**. The
analysis samples each candidate against loaded terrain (falling back to the
reference surface) and demotes sustained penetration below the configured
tolerance. This is a rejection check, not a terrain-following solve.

Beyond that always-on check, the **Ground contact** selector in *Traverse
Analysis Tweaks* constrains the solution space to how the object touches the
ground:

- **Airborne (any)** — the default; no ground contact required (underground
  is still rejected).
- **On the ground** — adds a dedicated **Ground Vehicle** candidate: the point
  where each sightline meets a curved, constant-elevation shell near the local
  terrain height (distinct from the stationary *Ground Object*), then checks
  samples against the actual terrain. It does not follow changing DEM height
  over slopes or ridges.
- **Starts on ground** — takeoff, or a released balloon: the trajectory begins
  on the surface, then a portion is airborne.
- **Ends on ground** — landing, or a descending balloon: the trajectory ends on
  the surface.

The non-airborne modes also add a soft **ground prior** to the fixed-wing,
lantern and quadcopter fits, pulling the relevant endpoint(s) toward the
surface so the physics fits find takeoff/landing/release/descent solutions
rather than purely mid-air ones. This is gated: in the default Airborne mode
the fits are byte-identical to before.

### Analysis integrity

The analysis is engineered to be honest about what LOS-only data can and
cannot determine:

- **Deterministic global search**: the analysis injects seeds derived from the
  input/run into its stochastic searches and records optimizer metadata. This
  makes supported runs repeatable for the same code and inputs; it does not
  prove that a retained basin is the global optimum.
- **Physical fits are seeded from the smoother**: the balloon (with its wind free
  to vary over the clip) and the drone control-input candidate start from the
  best geometric approximation — the Kalman-smoother path — and refine from
  there, rather than searching their high-dimensional parameter spaces blind.
  The smoother is regularised, and its constant-velocity start is given an
  explicit 500 m range floor because regularisation alone cannot remove an LOS
  fit's degeneracy along range. The seed carries no truth and no object
  assumptions, but it can still affect convergence and which local basin is
  retained; the free
  Quadcopter is deliberately left unseeded as the unconstrained, anomaly-reachable
  fit. Because the drone fit then starts on a good path it needs only local
  refinement (Nelder-Mead from the seed), which is why it now solves in about a
  second where it once took tens.
- **Circular-LOS detection**: when the sightlines are *constructed* from the
  target being tested (Camera Heading = "To Target" with LOS Source = raw
  Camera Center), the gallery and verdict carry a prominent
  "Constructed LOS — validation only" banner. Fits recovering the target then
  confirm internal consistency, not an independent discovery.
- **No global object winner**: every tile carries a colored **category label**
  — *Physically based* (balloon, drone, aircraft), *LOS Constrained* (constant
  air speed / altitude / minimum acceleration), *Geometric* (stationary, ground,
  at-infinity), *Geometric Approximations* (the curve/Kalman/least-squares fits),
  and *Known Object* (star, planet, satellite). The gallery is shown in one flat,
  best-first order, but that order is decided by keys which ARE comparable across
  categories (with a usable truth track — at least five overlapping frames:
  completeness, then closeness to that track; otherwise broad-screen pass,
  eligibility, completeness, tier, and
  bound-pin count) *before* it ever reaches
  a within-category score that is not — so a trajectory construction cannot
  outrank a balloon or satellite as though those were comparable object
  probabilities, and category order only breaks what would otherwise be an
  unsound tie. Each tile still reports its standing within its own category
  ("#1 of 4 physically based").
- **Fit quality and ordinariness are separate judgements**: a tile's tier is
  the worse of how well the model reproduces the sightlines and how ordinary the
  motion it requires is, but the **badge names whichever one is binding**. When
  the fit is the limit the labels read `Passes broad screen` / `Fair fit` /
  `Weak fit` / `Poor fit`; when the motion is the limit they read `Passes broad
  screen` / `Moderate` / `Low` / `Kinematically extreme`. This stops a slow,
  ordinary object with a middling residual being called "Implausible" (that word
  is about the object; the evidence was about the fit), and stops a 12 g solution
  that threads the rays exactly being hidden as merely a good fit. Search-edge,
  active-model-limit, inactive-bound, internal-clamp, and optimizer-incomplete
  badges remain independently visible; a tier is never relabelled upward, and an
  incomplete result cannot receive an affirmative global winner badge. Two more
  labels exist. **Not fully tested** replaces a tier label only when a model
  limit is the binding constraint — the fit and the motion would both grade
  higher, but a pinned bound stopped the search, so the model was never fully
  tested rather than measured and found wanting (a fit that pins *and* fits
  poorly keeps the stronger "Poor fit"). **Co-leader** marks tiles that tie on
  every comparable key (screen pass, eligibility, completeness, tier, pin
  count), so the one shown first leads only by category priority; with a truth
  track selected, truth separation breaks the tie instead.
- **Balloon-consistency tie-break**: a *Physically based* balloon tile is
  scored on whether its own fitted motion is self-consistent with a passive
  wind tracer — a steady climb, level, or descent drifting in one direction is
  credited, and a "balloon" that had to yo-yo vertically or curve back on
  itself is debited by the same amount. It is a consistency check on the model,
  not a preference for the object: it is bounded and only ever reorders
  otherwise equally-well-fitting candidates (it can never lift a balloon over a
  clearly better-fitting drone), so it cannot foreclose a genuine
  better-fitting energetic or maneuvering solution.
- **Family bands**: flat solution valleys are reported as bands ("50–650 kt at
  19–41 NM fit about equally") with a deterministic representative (nearest
  the Target Speed prior), instead of a knife-edge argmin that flips with
  last-bit input changes. The range bracket self-expands when the winner
  touches a grid edge, and a result still on the edge is flagged
  boundary-limited.
- **Bounds are sensitivity-checked**: a parameter merely landing within 1% of
  a numerical bound is not treated as a capability failure. The fitter probes
  it inward and demotes only locally load-bearing constraints. Flat/inactive
  parameters are reported as unconstrained; an inward improvement is reported
  as optimizer-incomplete. Duplicate manifestations of the same constraint
  (such as a speed parameter and derived overspeed) count once. This prevents a
  pre-burn lantern's unused terminal-sink parameter from being counted against
  it.
- **Curved-Earth geometry**: displayed altitudes/climb are geodetic, and the
  constant-altitude and ground candidates include Earth curvature. Dynamics
  still use one fixed-origin ENU frame, so headings and wind axes are
  origin-frame approximations over large/high-latitude scenes.
- **Physical time**: dataset speeds/accelerations honor `simSpeed`, and
  track-driven winds are sampled historically per frame (not the playhead
  value repeated; frames in a wind-data gap use the nearest row with data).
  Velocity/acceleration differentiation uses an approximately 0.5-second
  physical window rather than 15 frames, so changing source frame rate does
  not change the screen. For A-B windows too short to hold that window, the
  differentiation window clamps to the selection length — short analyses
  report real (noisier) metrics; a window too short for any statistics reads
  as invalid, never as zeros.
- **Make/model labels are envelopes, not identifications**: "Closest containing envelope:
  Boeing 737-800 (not an ID)" means the solved speed/climb sits nearest that
  catalog entry's performance envelope — nothing more.

### The Analyze button

**Traverse ▸ Analyze Traverse Methods...** runs the full battery against the current
LOS data and opens a single flat, best-first hypothesis gallery — each tile
carrying a colored category label rather than being buried under a section
heading, so that object-model tiles are not buried under curve fits that merely
thread the same rays; which tile leads is decided by the screen, not by its
name. This is a screening order, not an object verdict. The standalone HTML
report is built on demand. **Use exact result** installs the analyzed
trajectory as a frozen Analysis Snapshot; it does not silently rewrite the
speed/range assumptions used by the next run.

The analyzed window can be narrower than the A-B range. A track holds its last
sample past the end of its data, and a frozen sensor on a frozen ray is not an
observation, so held frames at either end of the window are dropped and the
console reports how many, and which frames were analyzed. If more than half the
window is held frames nothing is trimmed — that is a scene problem (check that
the clip's In/Out range covers real data), and the analysis says so.

1. **Constant-air-speed sweep** — a grid over (start distance × air speed,
   15–650 kt log-spaced so slow drifters are representable alongside jets).
   Each combo is solved as the smoothest ray-following path that holds that
   air speed (a spline solve — the old frame-by-frame ray walk was a shooting
   method that exploded into corkscrews whenever the sensor maneuvered), then
   scored for smoothness (kinematic acceleration, turn-rate variability, climb) plus how well
   the requested speed could actually be held. Surfaces the valley of
   straight-flight solutions (for Gimbal: ~30–32 NM, speed loosely
   400–550 kt).
2. **Range profile** — for each assumed start range, the least-maneuvering
   spline solution with a fast-object (cruise speed) and a slow-object
   (drifting) speed target. Quantifies what an object at any given distance
   would *have* to do — e.g. at 6–8 NM the Gimbal object must nearly stop and
   whip through a rapid heading reversal, or sustain a continuous banked turn.
3. **Aircraft fit** — the differential-evolution fixed-wing fit, reported as
   interpretable parameters (range, origin-ENU heading, horizontal airspeed,
   turn, climb).

The report contains provenance, a run-audit manifest, an executive summary, sweep
and range-profile plots, common-axis track comparisons, selected time series,
and candidate tables/details. Criteria are deliberately loose checks; scores
order model-conditioned hypotheses and are not posterior probabilities.

Unchanged analyses are cached by their LOS, A-B range, timing, wind, model
options, priors, and stable terrain-data configuration. Choosing **Use exact**
or orbiting a render camera does not change those inputs and reopens the prior
gallery immediately. Render-camera terrain LOD (active tiles/revision) is kept
out of the scientific key; the cached result retains the terrain samples used
when it was graded. Adjacent terrain LODs that reconstruct the same surface
within 0.1 m are treated as equivalent; a larger change from an equal- or
higher-resolution authoritative sample, explicit terrain reload, or source
change invalidates normally. A lower-resolution fallback never overrides the
cached authoritative sample. If terrain tiles merely finish loading
*while* an analysis is running, the run is **not** discarded — it completes using
the ground samples consumed while building and grading the candidates (a late
sub-decimetre refinement is unlikely to be material) and
the gallery shows a small note that terrain finished loading, which you can act
on by re-running once it settles if you need the ground samples exact. Starting
an analysis while terrain is still doing its initial load is still blocked, since
a half-loaded start could be genuinely wrong rather than marginally off.

Notes on the gallery tiles:

- The ray-following tiles (Constant Air Speed, Constant Altitude, Minimum
  Acceleration) show their analyzed, lightly smoothed paths. **Use exact result**
  installs that exact sampled path as a snapshot, so preview, metrics, and
  applied output refer to the same result.
- Tiles are shown in one flat, best-first order, each labelled with its
  **category** and its rank within that category ("#1 of 4 physically based").
  The order is decided first by keys comparable across categories — screen pass,
  eligibility, completeness, broad-screen tier, unique active model constraints —
  and only then by a within-category secondary score (which is not comparable
  across categories), with category priority breaking otherwise-equal ties. The
  0.05 display-tie threshold is a formatting convention, not a statistical claim.
- The **raw LOS residual is always shown**. A flexible constant-acceleration
  reference is displayed separately as context and never substituted for the
  raw value or used as a noise estimate. Ray-constrained smoothing residuals
  receive one fixed 0.05° solver-fidelity allowance; changing the generic
  reference cannot change rank.
- `Max kinematic acceleration (g)` is the change in smoothed air-relative
  velocity divided by gravitational acceleration. It is not aircraft load
  factor and does not include the ordinary 1 g supporting level flight.
- **Constant Altitude** searches the altitude band and scores each candidate
  on the smoothed path plus its LOS residual; if the sightlines are
  near-horizontal (they never cross a constant-altitude plane) the tile
  reports "fit failed" instead of a meaningless track.
- **Minimum Speed**'s family note has two modes: with a genuine low-motion
  window (the classic saddle) it reports the range band that fits equally
  well over that window; on a continuously rotating LOS (the sensor's own
  motion triangulates the range) it reports how sharply the full-clip cost
  valley pins the range instead.
- The flexible constant-acceleration residual shown for scale is a
  **model-reference residual**, not an estimate of sensor noise. It must not be
  used to make statistical confidence or likelihood claims.
- **Ordinariness** and **Implied object size** are disclosure lines, not
  ranking inputs. Ordinariness measures how far the candidate's required size,
  speed and acceleration sit outside the envelope of the nearest ordinary
  object class (bird, balloon, quadcopter, fixed-wing), judged on all the
  quantities together: 0.00 means some ordinary class contains it, and a high
  value is a positive statement about the object, never a failure to explain
  it. Implied object size converts the file's angular-size bound to metres at
  the candidate's range; a sub-pixel target gives an upper bound only, and the
  line says so rather than printing a fictitious lower end. Neither line moves
  the order of the tiles. See
  [How ordinary is the answer?](BOTBench.md#how-ordinary-is-the-answer) for the
  definition and the measured behaviour.
- The **Sky Lantern / Balloon (measured wind)** variant pins the drift to a
  supplied wind. When no wind source is loaded (winds aloft, or the sitch wind)
  it is reported as "not tested — no wind was supplied", never silently
  omitted, so a missing tile is not mistaken for a failed fit.

### Solution families — the range band a model admits

*Traverse Analysis Tweaks → "Solution families (range bands)". Off by default;
it re-fits each physics model several times.*

A single drawn trajectory is the most misleading thing this analysis can
produce, because bearings alone rarely determine range. For **any** distance
profile R(t), the path `S(t) + R(t)·D(t)` reproduces the sightlines exactly —
so a distance is only pinned once you assume something about how the object
moves, and then only as far as that assumption actually constrains it.

With this enabled, each physically-based interpretation (balloon, quadcopter,
fixed-wing) is re-fitted at a ladder of **held** ranges: the start distance is
locked to each rung and every other parameter is re-solved under the same
model. The rungs whose fit stays acceptable are the model's **admitted band**.

- Admitted members are drawn as faint tracks in the tile's own color, with
  the headline solution solid on top. A member that follows the sightlines but
  fails the physical screen (underground, extreme kinematics) is drawn dashed
  and dimmer — visible, because "the rays allow this and physics does not" is
  worth seeing, but never mistakable for part of the answer.
- The tile reports the band next to the slant range, with the number of rungs
  **sampled**: "3.0–3.6 NM (2 of 12 sampled)". A narrow band says the range is
  well constrained *for that model*; a wide one says it is not.
- **The ladder is a sample, not a measurement of the boundary.** An admitted
  rung shows that distance works; it never shows that the untested ground
  between it and its rejected neighbour does not. So a band's edges are where
  the *sampling* changed answer, and the analysis says so rather than quoting a
  distance: "2.2 NM was the only sampled range admitted; the nearest sampled
  ranges below 1.1 NM and above 4.3 NM were rejected, so the true edges lie
  between those and the band shown". Nothing here ever reports a resolved or
  exact distance, however few rungs survive.
- Admitted ranges are reported as **separate intervals** when they are not
  contiguous, and filling a gap in would invent solutions the analysis never
  found. Each gap is described on its own terms — with three bands there are
  two gaps and they can mean different things:
  - every sampled rung in it rejected → **those samples** are excluded (the
    untested ground between them is not — the ladder is discrete);
  - a rung in it produced no fit → that part is **untested, not ruled out**,
    because a failure to solve is not evidence the range is unavailable.

Four cautions, all of which the tile states:

1. **The band is conditional on its model.** It is not a general uncertainty
   on the object's distance. A balloon band and a drone band answer different
   questions and are never merged.
2. **The acceptance cut is empirical, not derived.** There is no calibrated
   sightline noise floor here (the constant-acceleration reference residual is
   explicitly not one), so the cut is set relative to the model's own best fit.
   Its width is calibrated against benchmark truth coverage — see
   `benchmarks/botbench/verdict.bench.test.js`.
3. **A band that reaches the searched bracket's edge is a bound, not a
   result.** Widen Min/Max Dist to find where it really ends.
4. **The search marches outward from the best fit, seeded from each
   neighbour.** That is far cheaper than a global search per rung, but these
   landscapes are multimodal — so a global re-search runs at each end of the
   ladder, and if it finds a better basin the band is re-traced from there and
   says so.

The band is reporting only. It never enters the ranking: a model with a
tighter band does not sort higher, because "the more determined model wins"
would be exactly the calibrated object-probability claim this analysis
declines to make.

### How the tiles are ranked

The gallery mixes unlike questions — object models, LOS-constrained
trajectory families, fixed-geometry checks, curve fits, catalogue matches —
and there is no cross-model likelihood that could rank them as competing
object probabilities. The flat best-first order is instead decided
**lexicographically**, by a cascade of keys that *are* comparable across
categories, before anything model-specific is consulted:

1. **Truth separation** (only when a truth track is selected): completed fits
   first, then mean 3D separation from the truth in metres — the one score
   that is soundly comparable across every category.
2. **Broad-screen pass** — anything rated *Kinematically extreme* / *Poor
   fit* (or flagged invalid, underground, or off-mode) sorts below
   everything that passed, even an incomplete pass. This ordering is
   deliberate: broad, weakly-constrained slow families are the ones that
   honestly report touching a search edge, and completeness-first would
   bury them under extreme-but-cleanly-converged solutions.
3. **Eligibility** — complete *and* top tier.
4. **Completeness** — no search-boundary or optimizer-incomplete flags.
5. **Tier** (see below), then the count of locally load-bearing model limits.
6. **Category priority** — *Physically based* → *LOS Constrained* →
   *Geometric* → *Geometric Approximations* → *Known Object*. Used only in
   the flat ordering, and only here, because the next key is not
   commensurable across categories (catalogue and at-infinity tiles score
   raw degrees; the rest a smoothness composite roughly an order of
   magnitude larger).
   An object model leading a curve fit that answers no object question is the
   intended effect.
7. **Within-category secondary score**, then raw LOS residual as the final
   tie-break.

Three worked examples. A *Minimum Acceleration* path that threads the rays
at 0.03° but needs 6 g is rated *Low*, so a complete balloon fit at 0.04°
and 0.3 g — top tier and eligible — leads it at the eligibility key; their
scores are never compared. A slow drifting family flagged *Search
incomplete* because its range band touches the grid edge still leads a
cleanly-converged 900 kt / 12 g solution: the extreme candidate fails the
broad-screen pass, which is decided *before* completeness, so honestly
reporting a search edge is not punished by a worse tile that merely
finished. And a catalogued planet with a close angular match (say 0.08°,
the top catalogue grade) ties a passing drone fit on every key down
through tier and pin count — but its secondary score is 0.08 (raw
degrees) while the drone's smoothness-plus-residual composite is several
units. Compared directly the planet would "win" purely on units, so
category priority decides that pair and the unsound comparison is never
made.

**The tier** for trajectory tiles is the worse of two independent 0–3
grades, and the badge names whichever one is binding. *Fit quality*, from
the scored LOS residual (ray-constrained solutions first get a fixed 0.05°
solver-fidelity allowance subtracted): ≤ 0.05° is the top grade, then
≤ 0.15° (*Fair fit*), ≤ 0.5° (*Weak fit*), and worse (*Poor fit*).
*Kinematic ordinariness*: ≤ 1.5 g and ≤ 650 kt is the top grade; up to 4 g
(still ≤ 650 kt) is *Moderate*; above 4 g or 650 kt is *Low*; above 9 g or
900 kt is *Kinematically extreme*. One locally load-bearing model limit
caps the tier at 2, two or more at 1, and an unconverged optimizer caps it
at 1 as a *Provisional fit*. Two iteration-limit stops are **not** counted as
unconverged: a Nelder-Mead simplex that has collapsed to its position tolerance
on every parameter has converged even if the cost spread has not settled (no
further iteration can move it), and a fit whose cost has settled while some
parameters stay wide is reported as settled but unidentifiable on the named
parameters — an identifiability limit of the clip, not an optimizer failure.
Before this distinction the most precise fits were the likeliest to be refused;
see [Why a good fit can still read "Unresolved"](BOTBench.md#why-a-good-fit-can-still-read-unresolved). Catalogue and at-infinity tiles have no
kinematics to grade: they are tiered on angular offset alone, with the
visibility / illumination check folded in for catalogue objects.

**The secondary score** for trajectory tiles is a smoothness composite plus
the residual: `4·rms(g) + max(g) + 0.05·std(turn rate) + 0.02·(mean
vertical speed beyond 5 m/s)`, plus the scored residual divided by 0.05 —
so one score unit equals 0.05° of LOS residual, putting "how much
manoeuvring does this require" and "how well does it thread the rays" on
one scale. The composite prices exactly the things a wrong assumed
distance forces on a solution: sustained and peak acceleration, erratic
turning, and implausible climb or descent.

**The balloon special case.** Buoyant tiles get a bounded consistency
nudge. A passive wind tracer is physically confined to a single steady
vertical trend and an essentially one-direction drift, so consistency
`C ∈ [0, 1]` is measured from the solved track as net displacement over
path length per axis, taking the *weaker* of the vertical and horizontal
values (a monotonic climb does not excuse a circling ground track). A
near-level vertical axis counts as a steady trend — a neutrally-buoyant
balloon is ordinary — and a near-hovering horizontal axis scores neutral,
so calm-wind cases are never penalised for not moving. The
nudge is `6·(1 − 2C)` score units — at most ±0.3° of residual-equivalent,
symmetric: textbook balloon motion is promoted, and a "balloon" that had
to yo-yo vertically or curve back on itself is demoted by the same
amount. The nudge lives entirely inside the secondary score, which the
cascade consults only for candidates that already tie on screen pass,
eligibility, completeness, the combined tier, and load-bearing-limit
count. Within such a group it moves the balloon's score by at most 6
units (0.3° of residual-equivalent), so that is the most
smoothness-plus-residual disadvantage it can overcome; any candidate
ahead on one of the earlier keys — a better combined tier, a complete
search where the balloon's is not, fewer load-bearing limits — is out of
its reach.

**Surfacing true anomalies.** Several deliberate choices keep a genuinely
anomalous solution from being ranked or labelled out of sight. The
fit/ordinariness split means a 12 g solution that reproduces the
sightlines exactly is badged *Kinematically extreme* — a good fit
describing extraordinary motion — rather than blending in among good
fits or being dismissed as a bad one. The free Quadcopter fit is left
unseeded as the unconstrained, anomaly-reachable search. The balloon
nudge is tier-bounded and symmetric, so no mundane reading is ever
forced. And when nothing passes, the verdict is *Unresolved* — stated
with what was and wasn't tested — rather than either a manufactured
conventional winner or an anomaly claim the uncalibrated noise floor
cannot support.

## The executive verdict

The analysis ends with a one-line **executive verdict** above the gallery. It
has five codes: *insufficient* (two wordings — independent evidence is lacking
because the sightlines were constructed from the target under test, or the
range is undetermined because the sensor's motion gives no usable parallax),
*probably a wind-blown balloon* (the only affirmative verdict, gated on an
independent wind measurement), *consistent with one* conventional
interpretation, *consistent with several*, and *unresolved* (the safety valve,
not an anomaly claim). Exactly what each wording licenses you to say, and the
list of causes Sitrec has no model for at all, are in
[Reading the executive verdict without over-reading it](DefensibleAnalysis.md#7-reading-the-executive-verdict-without-over-reading-it)
and [What a fit does and does not license](DefensibleAnalysis.md#5-what-a-fit-does-and-does-not-license).
