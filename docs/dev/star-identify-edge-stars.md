# Star identification: the edge stars that are circled but not named

Status: **bug 1 fixed and verified; bug 2 turned out not to be the blocker; the edge stars are
still unnamed, and now we know why.** Start at "Where this stands now".

Reference clip: `?custom=99999999/Rotating Starfield issue/20260801_233530.js` — a ~96 deg IR
monocular timelapse, sky rotating 3.28 deg about a pole just past the top-right corner, horizon in
frame. Its whole Star Track result is captured at `tests/fixtures/rotatingStarfieldMap.json`
(391 tracks: 2D chart position, both classifications, magnitude, observation count, and the
track's DIRECTION on the unit sphere), so all of this is now reproducible headlessly in Jest —
`tests/StarIdentifyRealClip.test.js`.

## Where this stands now

The lens/spherical work (`ad6e4523`, `854f871a`) fixed the original classification bug: 231 star /
5 moving, where it was 169 / 70. Green circles now reach the frame edges. But only ~68 stars got
NAMES, because `identifyStars` deliberately feeds identification the OLD 2D-classified star set.

**Bug 1 (tangent units read as radians) is fixed.** It was doing more damage than the handover
supposed — it was degrading the shipping solve, not merely blocking a wider one.

**Bug 2 (the consensus cliff) is real arithmetic but was never what refused the improved set.**
Measured: the improved set's match count *collapses* under refinement (58 provisional → 16
rematched), long before the denominator matters.

**The edge stars are still unnamed, and that is now a deliberate, measured choice**, not an
unexplained failure. With bug 1 fixed the improved set *does* solve on the wide tier — and the
labels it puts on the recovered edge stars are wrong far too often.

## What bug 1 actually cost

`scalePriorFromFov` (`StarIdentify.js:182`) returns gnomonic TANGENT UNITS per pixel and its
docstring warns that treating that linearly is "8% off at phone-lens widths and worse beyond".
`projectAndMatch` then did exactly that:

```js
const scale = Math.hypot(T.A[0], T.A[1]);   // comment said "rad per px" - it is NOT
const fovRadiusRad = width * scale * 0.75;
if (fovRadiusRad > 1.2) return null;        // ">70 deg radius: not a camera field"
```

`width * scale * 0.75 > 1.2` rejects any centred gnomonic field wider than 77.3 deg. **The
reference clip's own shipping solve cleared it at 1.199 against the 1.2 ceiling** — one part in a
thousand from failing outright.

And it was already failing *inside* the solve. The diagnostics show the shipping run's refinement
aborting at round 0 with `rolledBack: "projectNull"` — the guard was rejecting refinement's own
reprojection, so the shipped answer came from the **unrefined provisional model**.

The fix is the arctangent (`fovRadiusRad = Math.atan(width * scale * 0.75)`), plus the same
correction to the reported `fovDeg` in `finishSolve`. `pxPerDeg` was already consistent with
tangent units and `starTrackVfovDeg` already went back through the arctangent, so neither changed.
The only consumer of `fovDeg` is a status string.

### Measured, on the shipping configuration

Scored per label against an arbiter the identifier never sees: fit the spherical map's directions
to the matched catalogue directions with a trimmed rotation, then ask how far each named star lands
from where the map puts that track. The map is pixel-geometry only — no catalogue went into it.

| | matched | right | wrong | grossly wrong (>0.5 deg) | err median | p90 | max |
|---|---|---|---|---|---|---|---|
| before | 68 | 56 | 12 | 7 | 0.146 deg | 0.723 deg | 3.179 deg |
| after | 72 | 66 | 6 | 3 | 0.145 deg | 0.253 deg | 2.209 deg |

More names *and* less than half the errors. Five tracks got a different HIP than before; **all five
moved closer** to where the map independently says they are (e.g. track 85: 0.692 → 0.200 deg;
track 76: 0.983 → 0.640 deg). None got worse.

Codex (gpt-5.6-sol) reviewed the change and confirmed the arithmetic independently: `0.75 W` is
6.1% beyond even a square's half-diagonal so the arctangent is the right conversion; the guard now
fires at a 119.5 deg centred side FOV / 67.6 deg square-diagonal radius, which is the "~70 deg
radius" the constant always claimed; the tightened `minDot` prefilter (60.2 deg vs the padded
bounds' actual 43.8 deg farthest corner) loses no in-field catalogue stars; `fovDeg`'s new formula
is correct and `pxPerDeg` needed no change; and the DIAG try/finally ordering is sound.

It also broke the 68 → 72 down properly, which is worth stating exactly: **54 unchanged, 5 changed,
13 newly named, 9 that lost their names.** Scored by the same arbiter — the 9 dropped were 5 right
and 4 wrong (three of them grossly), the 13 new are 12 right and 1 wrong, and the 5 changed all
moved closer. The dropped ones were all magnitude 6.42–6.94, i.e. exactly the population
refinement's `maxProjected` brightest-3×nImage cap cuts (it fell at mag 6.21 here). That cap is a
real catalogue-completeness assumption and worth revisiting; on this clip it happened to shed more
errors than names.

Regression coverage: `tests/StarIdentify.test.js` gained "a field wider than 77 degrees solves —
tangent units are not radians" (a 100 deg synthetic field; confirmed to FAIL with the old line
restored), and `tests/StarIdentifyRealClip.test.js` pins the per-label numbers above.

## Two smaller bugs fixed alongside (both found by the review)

- **`nProjected` was fabricated.** `finishSolve` initialised it to `min(deep.length, maxProjected)`
  — the whole SKY's verification pool clipped by the cap, a number no projection ever produced —
  and never rolled it back when a refinement round did. The final consensus gate divides by it, so
  a rolled-back solve was judged against a denominator far larger than the field held: conservative
  by accident, and able to reject a valid solve. It now travels with the matches from the
  projection that produced them, and rolls back with the rest of the triple.
- **Two more tangent/radian misstatements.** The `scalePrior` option doc said "radians per pixel";
  and `identifyStars` computed `fovWdeg = scalePrior * maxDim * 180/PI` to choose tier order,
  crossing its 35 deg threshold at a true 34.0 deg. Both corrected.

## What the diagnostics are

`solveField(..., {debug: true})` now attaches a `diag` record: quad counts, code hits, hypotheses
tried, a `rej.*` counter per guard, the maximum each guarded quantity reached, and per finalist the
full acceptance arithmetic of every refinement round. Off by default, never read by the solve.
This is what turned "refinement lost the match consensus" — one sentence covering a dozen causes —
into the table below.

## Why the improved star set still cannot be used

With bug 1 fixed, all four combinations were re-run. Star sets: OLD = 137 (2D-classified),
NEW = 199 (spherical-classified, i.e. including the recovered edge stars). Charts: the 2D
reference chart, and a gnomonic chart built from the spherical map.

| configuration | matched | right | grossly wrong | recovered EDGE stars |
|---|---|---|---|---|
| OLD + 2D, tier 1 *(ships)* | 72 | 66 | 3 | — |
| OLD + 2D, tier 3 | 76 | 69 | 4 | — |
| NEW + 2D, tier 3 | 89 | 78 | 6 | **1 right / 3 wrong** |
| OLD + gnomonic, tier 3 | 56 | 52 | 3 | — |
| NEW + gnomonic, tier 3 | 101 | 76 | 14 | **12 right / 7 wrong** |

The improved set solves. It names more stars. And on *precisely the stars this exercise exists to
name*, it is wrong 37–75% of the time. That fails the bar (a wrong name shown confidently is worse
than no name), so `identifyStars` keeps its current input.

Note the NEW set fails tier 1 and tier 2 and only succeeds on tier 3. Since the clip carries no
optics metadata, `identifyStars` would try tiers in order and land on tier 3 — so switching the
input would silently adopt the worst row in that table.

### The most promising lead

`verifyPixelTolerance` is `verifyPixelFraction * width`, sized for a similarity model whose error
grows with the field. On a chart that is *already gnomonic* the model is exact, so that slack is
what lets a greedy matcher hand an edge star its neighbour's name. Sweeping it:

With the robust refit also in place:

| NEW + gnomonic, tier 3 | matched | right | grossly wrong | edge stars |
|---|---|---|---|---|
| frac 0.005 (default) | 106 | 88 | 9 | 11 right / 7 wrong |
| frac 0.004 | 88 | 73 | 10 | 11 right / 5 wrong |
| **frac 0.003** | **100** | **86** | **2** | **17 right / 5 wrong** |
| frac 0.0025 | 85 | 76 | 2 | 15 right / 4 wrong |
| frac 0.002 | 74 | 59 | 8 | 7 right / 6 wrong |

At 0.003 the gross error rate (2/100) is *better than what ships today* (3/72) while naming 39%
more stars, 17 of them recovered edge stars. **Do not just change the default on this evidence.**
The response is NOT MONOTONE — 0.004 is worse than both 0.005 and 0.003 — which is the signature
of the solve switching to a different hypothesis rather than trading coverage against accuracy
smoothly. That is precisely the shape that makes a tuned constant look excellent on one clip and
fail on the next, and this is n=1 clip. It needs a second and third real clip, and ideally a
tolerance derived from the model's own residual rather than a tuned constant.

Worth noting alongside it: NEW + 2D at frac 0.003 gives 72 matched / 67 right / **zero** gross
errors - the cleanest result measured anywhere - but names no edge stars at all. Coverage and
per-label safety are being traded directly, and the trade is currently made by a constant that
knows nothing about either.

## Corrections to the earlier investigation

- **The spherical map is accurate to ~0.15 deg, not 0.42 deg.** Trimmed Wahba fit plus
  great-circle residuals over inliers: median 0.14 deg, rms 0.18 deg, p90 0.25 deg, max 0.64 deg.
  The 0.42 deg came from a best-fit planar *similarity* between two gnomonic charts, which measures
  how unlike the charts are, not sky error. **The refraction hypothesis is unnecessary and should
  be dropped** — there is no residual left for it to explain. (0.15 deg is ~2 px at this plate
  scale, i.e. the map's pixel noise floor, consistent with the solve's 2.8 px rms.)
- **Bug 2 is not what refused the improved set.** The arithmetic is right — 68/(137+62) = 34%
  against a 35% floor — but the solve never gets there: refinement's rematch collapses first
  (58 → 16 matches). The cause is that the refit is a plain least-squares similarity over ALL
  provisional matches, including spurious ones, with no robust trimming. That is worth fixing on
  its own merits.
- The "intrinsic gnomonic warp caps match fraction at ~47%" claim belongs to a warped 2D
  similarity-stitched *mosaic* fixture, not to gnomonic fields in general.
- `lensInfo.chart` (`StarTrackerUI.js:1042`) is zero-centred while `identifyStars` builds bounds
  from the video rectangle. Still latent, still unconsumed; any future use must not mix the two.

## Robust refinement — DONE

`finishSolve`'s refit is the one fit in the module whose input is a whole match set collected at
tolerance rather than four hand-picked quad stars, and it was plain least squares: every chance
pairing got an equal vote, and a few wrong pairs at the frame edge (longest lever arm) tilted the
model enough that the rematch then lost the good pairs.

`fitSimilarityRobust` now fits, measures, drops the tail at 3x the MEDIAN residual, and refits.
The median is used because it survives a minority of arbitrarily bad pairs, which is exactly the
contamination present; the cut never trims below 60% of the points, and on a clean set nothing is
trimmed at all, so an uncontaminated solve is left bit-for-bit where least squares put it.

Measured (per-label, same arbiter):

| configuration | before | after |
|---|---|---|
| OLD + 2D, tier 1 *(ships)* | 72 / 66 right / 3 gross, rms 2.84 | unchanged counts, **rms 2.73** |
| NEW + gnomonic, tier 3 | 101 / 76 right / **14 gross** | **106 / 88 right / 9 gross** |

Everything else is unchanged, and all 2804 tests pass. Unit coverage is in
`tests/StarIdentify.test.js` ("StarIdentify robust refit"): a contaminated set must not drag the
transform, a clean one must be untouched, and a set too small to have a majority is kept whole.

## The celestial-frame fix (branch `moon`), and what it does NOT change

Merged alongside this work. The night sky was drawn from J2000/ICRS coordinates but rotated onto
the Earth by `Rz(-GMST)` alone, omitting precession — the whole sky sat ~22.3′ out against the
terrain by mid-2026. It survived for years because the sky stayed *self-consistent*, so only
sky-vs-TERRAIN alignment exposed it.

**It does not touch the blind solve, and it must not.** `StarIdentify.js` maps pixels to CATALOGUE
RA/Dec by quad hashing — a star-to-star process in the catalogue frame — and contains no reference
to ECEF, GMST, GAST, `Sit` or `Globals` (verified by grep, and worth keeping that way). Applying
precession or aberration there would be actively wrong: the quads must match the catalogue **as
stored**. The only star-tracker change is `CNodeControllerStarTrack.apply()`, which now converts
the solve's catalogue RA/Dec to APPARENT directions via `getStarDirectionECEF()` before pointing
the camera.

### Anything previously synced carries two independent errors, not one

The frame error is ~22.3′. The identify fixes above move the solve as well, and by a comparable
amount — measured on the reference clip, pre-fix capture against post-fix solve:

| | pre-fix | post-fix | moved |
|---|---|---|---|
| boresight | RA 11.5023h Dec 37.5373 | RA 11.5053h Dec 37.6647 | **7.9′** |
| roll | 57.925° | 57.647° | **16.7′** |
| synced vertical FOV | 48.406° | 48.698° | **17.5′** |

So a Sync Camera result published before both fixes is out by ~22′ of frame error PLUS ~8′ of
pointing, and its ROLL and FOV are wrong too — which the frame fix alone does not address, because
those come from the plate solve rather than the sky transform. Re-derive rather than patch.

### Proper motion is not worth chasing here

The shipped catalogue (`data/nightsky/sitrec_bsc_lite.bin`) is a Hipparcos/ICRS repack at epoch
**J1991.25 with no proper-motion columns**, despite the `bsc` in its filename. The accumulated
residual as of 2026 is median 1.17″, p90 5.09″, worst star 234″.

Against this clip's per-star scatter of **11.8′**, the median proper-motion error is 0.0195′ —
about 600 times smaller — and even the worst star in the sky (3.9′) sits inside the 6.4 px
(0.46°) match tolerance. It is nowhere near the accuracy floor: the ~0.15 deg absolute accuracy
measured above is pixel noise (0.14 deg × 13.98 px/deg ≈ 2.0 px, consistent with the solve's 2.7 px
rms), not catalogue epoch. Regenerating the catalogue with PM columns is real work (22 → 30 byte
records) and would buy the star tracker nothing measurable.

## Tried and RULED OUT: a residual-derived rematch tolerance

This was the previous "what to do next" item 1, and it does not work. Recorded so nobody spends
the afternoon on it twice.

The idea: replace refinement's `verifyPixelFraction * width` rematch gate with one derived from
the converged model's own MEDIAN residual (median, not rms, because the set being measured is the
contaminated one and an rms is inflated by exactly the pairs the gate should exclude). Implemented
as `k * median`, clamped so it can only ever tighten. Swept k over {4, 3, 2.5, 2}:

| k | OLD+2D tier 1 (ships) | NEW+gnomonic tier 3 |
|---|---|---|
| off | 72 matched / 66 right / 3 gross | 106 / 88 / 9 |
| 4 | unchanged | unchanged |
| 3 | 70 / 64 / 3 | unchanged |
| 2.5 | 57 / 53 / 1 | unchanged |
| 2 | 56 / 52 / 1 | 97 / 80 / 8 |

At every safe strength it is a NO-OP on the configuration it was meant to help: the gnomonic
solve's median residual is already large enough that `k * median` exceeds the field-size tolerance
until k drops to about 2, and by then it has cut the shipping path from 72 matches to 56. The
change was reverted rather than left as an option defaulting to off.

**What this proves is more useful than the change would have been.** The `verifyPixelFraction`
0.003 result is NOT about the final rematch gate. That constant also feeds hypothesis
verification, the quad-rms prune (`2 * tolPx * scale`) and the provisional-acceptance gate — so
tightening it changes WHICH HYPOTHESIS WINS, not how the winner's matches are filtered. That is
exactly why the response is non-monotone: it is not trading coverage against accuracy, it is
selecting a different solve.

Which relocates the problem. Candidates are ranked by `matches.length` alone
(`candidates.sort((a, b) => b.matches.length - a.matches.length)`), and on the improved star set
many hypotheses clear the provisional gate, so the one with the most provisional matches need not
be the most accurate. The promising direction is a selection criterion that weighs residual
quality alongside count — measure the top-5 finalists' final accuracy against the arbiter before
designing it, because the diagnostics already record them.

## The cropped clip: why a local principal-point search cannot work

Second real clip: `?custom=99999999/Cropped Starlink Timelapse/20260802_212450.js`, captured at
`tests/fixtures/croppedStarlinkClip.json` (baseline correspondences at five frame pairs, plus each
track's classification). It is a CROP of a larger frame, so its optical axis is at fraction
(0.7446, 0.3324) of the video — **(953, 239) in the 1280x720 decode**, against a frame centre of
(640, 360). That is the first clip with a KNOWN principal point rather than a fitted one.

It arrived reporting 658 moving against 283 star — "half the stars are red" — because the lens fit
REFUSED: *"no better than a rectilinear lens (rms 11.70 vs 11.97)"*. Both numbers are terrible;
nothing fitted at all.

The data was never the problem. Scoring candidate lenses directly:

| principal point | best lens | robust rms | inliers < 4 px |
|---|---|---|---|
| frame centre (640, 360) | orthographicFisheye f=2100 | 6.82 px | 41/153 |
| **true axis (953, 239)** | **rectilinear f=1150** | **0.53 px** | **153/153** |

One rotation through a plain pinhole explains EVERY correspondence to half a pixel. The search
simply never went there — and the reason is that it cannot, by local descent. The rms surface over
the principal point, with lens type and focal re-fitted at every cell:

```
      y\x      400     520     640     760     880    [953]   1040    1160
      120     5.04    5.55    3.11    1.49    0.93    1.04    1.20    1.39
      239     4.73    5.44    5.53    1.81    0.65   [0.60]   0.76    1.08
     [360]    4.51    5.07   [5.90]   5.66    2.41    1.66    1.07    1.02
      480     4.64    5.07    5.65    6.11    5.76    5.07    2.71    1.70
```

From the frame centre the steepest improvement is LEFTWARD (5.90 -> 5.07), away from the global
minimum at 0.60, into a broad shallow plateau. Because type and focal are re-fitted at every cell,
this is not an artifact of holding them fixed while the axis moves: the joint objective genuinely
misleads. No local refinement solves this however it is seeded or stepped.

**Fix: `scanPrincipal`** — a coarse global grid over the principal point, seeding the existing
scan and local refinement. Gated on the centred scan explaining fewer than
`principalSearchWithinFrac` (0.6) of the correspondences, so a clip whose axis really is centred
never pays for it (the reference clip scores 0.99 and skips it; this one scores 0.32–0.48).
Deliberately cheap — 40 subsampled pairs, 9 focal steps, and only two shape types, because it has
only to find the right NEIGHBOURHOOD; the winning cell is then re-scanned at full resolution.

Recovered, against a truth the fit never saw:

| baseline | pairs | fitted principal | truth | error | rms |
|---|---|---|---|---|---|
| 0->60 | 242 | (949, 246) | (953, 239) | **8 px** | 0.60 |
| 0->40 | 342 | (955, 246) | (953, 239) | **7 px** | 0.51 |
| 0->80 | 153 | (1029, 251) | (953, 239) | 77 px | 1.00 |

An axis 313 px off-centre, recovered to 7–8 px on the two strong baselines. Note this also
validates the `principalMaxOffsetFrac` widening done earlier: at 24.5% of frame the true axis was
just inside the old hard-coded 25% bound — the fit would have been pressed against a clamp it
could not report.

COST. Measured on the 242-pair baseline: `scanPrincipal` adds ~1.1 s and the re-scan at the seed
~2.9 s. Both are dwarfed by `refineCustom` at ~14 s, which is pre-existing and scales with
correspondence count (this clip has 242–342 pairs against the reference clip's 130). If
calibration ever needs to be faster, that is where the time is, not here. RESPONSIVENESS, partially addressed. `calibrateLens` is now ASYNC and takes an `onYield` hook
(StarTrackerUI passes `yieldToBrowser`), awaited between the scan, the principal grid, each
nominee re-scan, the local refinement, the rectilinear comparison and the shape search. That stops
the whole calibration being one uninterruptible block. It does NOT make the page properly
responsive: `refineCustom` alone is a single ~14 s coordinate descent with no yield inside it, and
each `scanLens` is ~3 s. Verified after the change - the page still fails to answer during the
run. Finishing this needs yields INSIDE refineCustom's descent loop (and ideally inside scanLens'
focal loop), which is a change to the hot path and was not attempted here.

### Reviewed, and what is still open

Codex (gpt-5.6-sol) reviewed this and found more than the two the stop-gate caught. FIXED here:
`chooseBaseline` now screens candidates for rotation with a cheap nominal-lens fit BEFORE ranking
them (scoring `pairs * span` alone could pick a dense narrow baseline that then failed the
rotation gate, refusing a clip whose wider baseline calibrates fine — measured on a 1 deg synthetic
scene: 0->12 with 150 pairs scores highest, rotates 0.31 deg, refused; 0->39 with 25 pairs rotates
0.99 deg and calibrates); the custom-to-preset fallback no longer reports the discarded custom
fit's `principalClamped`; `diag.focalPx` is refreshed when the shape search moves it;
`centredWithin` is now a fraction of the INPUT correspondences rather than of the rows the lens
happened to be able to project (`within/n` could read 0.75 for a lens explaining 15 of 100); the
seed is adopted only on more inliers AND no worse rms; and the grid reports
`principalScanAtBoundary` when its winner sits on its own edge.

STILL OPEN, and none of it should be taken as settled:

- **Gate 5 is not an independent holdout.** `heldOut()` re-fits only the ROTATION on the training
  half; focal, principal, type and distortion were all fitted on every row beforehand, and the
  custom refinement's own inner split overlaps the outer one. For n=242 the outer test set is 81
  rows, of which 60 were in custom's training set and the remaining 21 in its internal validation —
  all 81 influenced the lens. A real test needs an outer split before `scanLens`/`refinePrincipal`/
  `refineCustom`, with both pipelines refitted inside it.
- **Held-out rms can be computed over DIFFERENT subsets for the two models**, since each silently
  skips rows it cannot project and divides by its own count. Invalid predictions should take the
  capped loss, or both models should be scored on a declared intersection.
- **The claim that held-out error is "essentially always" larger than in-sample is too strong** and
  is not reproduced by the current fixture (242 pairs: full rectilinear rms 0.6021, held-out
  0.5208). The direction of the fix is right; that particular justification is not.
- **`pairs * span` is still not an information objective.** For small rotation the Fisher
  information goes roughly as `N * span^2`, which ranks the 60- and 80-frame baselines differently
  from `N * span`. The rotation screen removes the refusal failure mode but not this.
- **The coarse 9-focal grid picks the wrong basin on the 153-pair baseline**: cell (928,198) scores
  95/153 at rms 2.145 while the boundary cell (1216,198) scores 97/153 at rms 3.267, and inlier
  count is primary so the boundary wins. At the normal 34 focals (928,198) wins outright
  (144/153, rms 1.186). So "the winning cell is re-scanned so nothing is lost" is FALSE — only the
  already-wrong cell is re-scanned. Re-scanning the top few cells would fix it.
- **A noisy CENTRED clip can still trigger the search**, since the trigger measures a poor centred
  fit rather than off-centre optics.
- `principalScanPairs: 40` is a stride, not a cap (153 -> 51 samples, 242 -> 41).

## What to do next
2. **Per-label refusal — MEASURED, and it works on the shipping path only.** Nothing today
   withholds an individual name. The best-vs-second-nearest margin was measured in the solve's own
   frame (via `refToSky`, so it needs no spherical map and would work for a single still), scored
   against the arbiter:

   | | right labels | wrong labels | grossly wrong |
   |---|---|---|---|
   | OLD + 2D, tier 1 *(ships)* | median **0.508 deg** | median **0.030 deg** | median 0.082 deg |
   | NEW + gnomonic, tier 3 | median 0.417 deg | median 0.195 deg | median **0.306 deg** |

   On the shipping path that is a 17x separation and a usable refusal signal: a 0.05 deg cut drops
   3 of the 6 wrong labels (one of them gross) for the cost of 2 correct ones; 0.10 deg drops 4
   wrong / 2 gross but costs 9 correct.

   On the improved set it does NOT work, and the reason is the useful part: there the *grossly*
   wrong labels have a LARGER median margin than wrong labels in general. A margin measures how
   AMBIGUOUS a match is, not how WRONG THE MODEL is — when the model is off, the neighbouring star
   really is nearest to where the model puts the detection, so the label is confidently wrong.
   This is independent confirmation that the edge-star failure is model error, not ambiguity, and
   that no per-label confidence test computed against the same model can rescue it.

   Not shipped: the cut is a constant whose cost/benefit is measured on one clip, and the whole
   argument against the `verifyPixelFraction` 0.003 tuning applies here too. Worth adopting for
   the shipping path once a second clip agrees on the threshold.
3. **A second and third real clip.** Every number in this document is n=1. Capture them the same
   way (see the fixture section of `tests/StarIdentifyRealClip.test.js`).
4. **Catalogue-tied refinement** remains the principled endgame: the video-only calibration
   optimises temporal pixel reprojection with lens, per-frame rotations and map free to compensate
   for each other. Fitting against catalogue directions supplies the missing absolute constraint,
   and is the only route that works for single stills (the spherical path is skipped for stills at
   `StarTrackerUI.js:964`).

## Safety bar for any fix

A wrong name shown confidently is worse than no name. Existing tests prove field-level REFUSAL
(the dense-random-field control) and, now, per-label accuracy on one real clip. Any extension still
needs its own negative controls: correct seed plus random extra tracks yields zero extensions;
corrupted seed IDs are rejected; edge names withheld where anchors do not support them; a close
catalogue double inside the gate stays ambiguous; labels unstable under catalogue-depth sweeps are
withheld.

## Reference

The fuller background is in `star-identify-brief.md` — note that its "candidate explanations"
section is superseded by the corrections above.
