# Star Tracker: Prior Work and Novelty

A companion to [StarTracker.md](StarTracker.md), written as groundwork for a possible academic
paper on the hybrid method. It maps each stage of Sitrec's Star Tracker pipeline onto the
established literature and states, stage by stage, where the implementation **matches** standard
practice, where it **diverges**, where it **extends**, and where it is frankly a **local heuristic**
with no claim to novelty.

## How to read this document

Three rules were applied while writing it, and they are worth stating because they constrain what
it says.

1. **Every claim about what Sitrec does is anchored to a file and a line.** Nothing here is
   inferred from the user-facing documentation; the source was read.
2. **Every citation was checked against the publisher, ADS, Crossref or arXiv.** Where a
   bibliographic detail could not be confirmed it is marked `[unverified]` rather than guessed.
3. **Novelty is claimed narrowly or not at all.** Most of this pipeline is a careful implementation
   of well-known methods. Saying so is the point; a paper that overclaims on stages 1, 3 and 5
   would be refuted by a single reviewer who has read Bertin & Arnouts and Lang et al.

A caution about the whole exercise: **absence of a citation here is not evidence of novelty.** No
systematic literature search was performed for several stages — in particular for radial-lens
self-calibration from a purely rotating camera (§7), which is the strongest candidate contribution
and therefore the one most in need of a proper survey before anything is claimed.

## The pipeline as implemented

The orchestration lives in `src/starTrack/StarTrackerUI.js`. The stage order, with the call sites:

| # | Stage | Module | Entry point |
|---|---|---|---|
| 0 | PSF / detection self-scaling | `StarDetect.js` | `calibrateDetection` (`StarDetect.js:702`) |
| 1 | Per-frame source extraction and photometry | `StarDetect.js` | `detectSources` (`StarDetect.js:286`), called at `StarTrackerUI.js:1167` |
| 2 | Frame-to-frame registration (2D similarity chain) | `StarMatch.js` | `solveFrameChain` (`StarMatch.js:945`), called at `StarTrackerUI.js:1226` |
| 3 | Tracklet association + global 2D refinement + classification | `StarSolve.js` | `solveStarField` (`StarSolve.js:1208`), called at `StarTrackerUI.js:1230` |
| 4 | Lens self-calibration | `StarCalibrate.js` | `calibrateLens` (`StarCalibrate.js:525`), called at `StarTrackerUI.js:1274` |
| 5 | Spherical re-solve and re-classification | `StarSphere.js`, `StarSolveSphere.js`, `StarSphereSolvePool.js` | `refineGlobalSphericalAsync` (`StarSphereSolvePool.js:222`), called at `StarTrackerUI.js:1306` |
| 6 | Blind plate solve (star identification) | `StarIdentify.js` | `solveField` (`StarIdentify.js:540`), called at `StarTrackerUI.js:917` |
| 7 | Co-moving light clustering | `StarCluster.js` | `groupMovingClusters` (`StarCluster.js:244`), called at `StarTrackerUI.js:1424` |
| — | Sky / horizon segmentation | *not implemented* | see §10 |

The architecturally interesting fact — and the thing a paper would actually be about — is the
**split of roles between the planar and spherical models**, stated at `StarSolveSphere.js:7-16` and
implemented at `StarTrackerUI.js:1265-1404`:

> the existing 2D similarity machinery is a PROPOSAL / BOOTSTRAP layer — it generates
> correspondences and an initial guess, which is what it is good at — but every ACCEPTED state and
> the final map are rotations, verified by pixel reprojection.

Concretely: the 2D chain decides *which detections belong to which track* and supplies the
initialisation; the spherical solve decides *whether a track moved*. Two consumers are deliberately
left on the planar chart — star identification (`StarTrackerUI.js:1375-1383`, which preserves the
2D verdict as `klass2D`) and light clustering (`StarCluster.js`, whose motion models live in
reference-chart pixels). Both holdouts are documented, with measurements, in
`docs/dev/star-track-overlay-circles.md`.

---

## 1. Source detection and photometry

### The standard

Source extraction from astronomical images was standardised by **SExtractor**[^bertin]. Its pipeline,
stated precisely because the details matter below:

- **Background.** A coarse mesh (32–128 px cells work on most images). Each cell's histogram is
  κσ-clipped iteratively to ±3σ about its median. If σ changed by less than 20% during clipping the
  field is deemed uncrowded and the clipped **mean** is used; otherwise the **mode** is estimated as
  `2.5 × median − 1.5 × mean` — a form the paper explicitly distinguishes from the textbook
  `3 × median − 2 × mean`, having found it more accurate on clipped distributions. The mesh may then
  be median-filtered to suppress local overestimation near bright stars, and is interpolated back to
  full resolution **bilinearly**.
- **Detection.** Convolve with a matched filter, threshold, and extract 8-connected pixels in one
  pass (Lutz's algorithm), subject to a minimum area.
- **Deblending.** Each connected set is re-thresholded at **30 exponentially spaced levels** between
  its extraction threshold and its peak, giving a tree; branches are accepted as separate objects
  when a branch holds more than a fraction `δ_c` (default 5 × 10⁻³) of the composite's integrated
  intensity *and* at least one other branch at the same level does too. Leftover pixels are
  reassigned by a bivariate Gaussian fit.
- **Photometry.** Isophotal, circular aperture, corrected-isophotal, and an adaptive **Kron**
  first-moment elliptical aperture at `k = 2.5` (mean flux loss ~6% for galaxies, ~3% for stars).
  The adaptive aperture is used unless a neighbour would bias it by more than 0.1 mag. Second-order
  moments give the `A_IMAGE` / `B_IMAGE` / `THETA_IMAGE` ellipse. The paper's own summary of the
  trade-off: "Aperture photometry is known to be generally less biased than isophotal photometry,
  but it only works in non-crowded regions."

The alternative tradition for crowded fields is **PSF fitting**, established by DAOPHOT[^stetson],
which fits an empirical point-spread function to each source rather than summing pixels. Matched
filtering — convolving with a kernel matched to the expected source profile before thresholding — is
standard signal-detection practice and is what SExtractor's `FILTER` stage does.

### What Sitrec does

`StarDetect.js` implements a reduced SExtractor.

- **Background.** `estimateBackground` (`StarDetect.js:120`) tiles the luma plane (default 64 px,
  `StarDetect.js:28`), samples on a stride-2 lattice, and iterates a σ-clipped **median**, with σ
  from the median absolute deviation scaled by the Gaussian consistency factor
  1.4826 (`StarDetect.js:151`)[^rousseeuw]. `backgroundAt` (`StarDetect.js:174`) interpolates the
  tile-centre samples **bilinearly**.
- **Matched filter.** A separable Gaussian (`gaussianBlur`, `StarDetect.js:190`) is applied for
  detection only; measurement always runs on the unsmoothed image (`StarDetect.js:292-293`).
- **Threshold and segmentation.** `D[i] > b + threshSigma * s` (`StarDetect.js:308`), then an
  8-connected flood fill with an explicit stack (`StarDetect.js:413-422`) and a minimum-area cut
  (`StarDetect.js:425`).
- **Moments.** Flux-weighted second moments give elongation `sqrt(λ1/λ2)` and orientation
  (`StarDetect.js:429-443`).
- **Photometry.** Both isophotal flux (the threshold-set sum, accumulated at `StarDetect.js:377`)
  and fixed circular **aperture** flux with a **sky annulus** (`StarDetect.js:537-618`). The
  annulus median excludes pixels claimed by any labelled component (`StarDetect.js:549`), the
  aperture excludes pixels labelled to a *different* component (`StarDetect.js:571`), and a
  geometric bounding-box test flags a neighbour intruding on the annulus (`StarDetect.js:603-611`).
  `instrumentalMagnitude` (`StarSolve.js:1013`) then prefers clean aperture flux, falls back to
  isophotal, and ranks a *contaminated* aperture last — on the stated reasoning that isophotal flux
  carries a uniform scale error while a contaminated aperture corrupts the ordering.

### Relationship

- **Deblending is the sharp divergence.** SExtractor *splits* merged components by
  multi-thresholding into a 30-level tree with an explicit contrast criterion. Sitrec only *counts*
  peaks — `countPeaks` (`StarDetect.js:230`) finds local
  maxima, merges those closer than `deblendMinSeparation` or not separated by a saddle deeper than
  `deblendContrast` of the peak height, where the saddle is approximated by the minimum along the
  straight line between the two peaks (`StarDetect.js:258-268`) — and `rejectReason` then discards
  any blob with more than one peak as `"blended"` (`StarDetect.js:651`). This is strictly weaker
  than SExtractor and deliberately so: a merged pair is dropped rather than guessed at, because the
  downstream question is "did this point move against the sky", for which a corrupted centroid is
  worse than a missing one.
- **The background estimator matches SExtractor more closely than it first appears, and differs in
  three specific ways.** The 64 px tile (`StarDetect.js:28`) sits squarely in SExtractor's
  recommended 32–128 px range, and the **bilinear** mesh interpolation (`backgroundAt`,
  `StarDetect.js:174`) is what SExtractor itself does — *not* a simplification of it. (A common
  secondary description of SExtractor says "median-filtered and spline-interpolated"; the 1996 paper
  says bilinear.) The three real differences are: Sitrec always takes the clipped **median**, where
  SExtractor switches between the clipped mean and the `2.5·median − 1.5·mean` mode estimator
  depending on crowding; Sitrec clips only the **high** side because sources are positive excursions
  (`StarDetect.js:154-157`), where SExtractor clips symmetrically at ±3σ; and Sitrec does **not**
  median-filter the mesh before interpolating. None of these is novel; they are simplifications, and
  the one-sided clipping is arguably a small improvement for a field of point sources on blank sky.
- **The colour machinery is entirely local and has no astronomical precedent** — it exists because
  the reference footage contains a green laser. Colour is measured only over pixels that are
  simultaneously above the raw threshold and unclipped in every channel, as an excess over a
  per-channel sky scaled by the local luma background (`StarDetect.js:368-406`), with a
  "partial-channel" lower-bound path that can convict a green-clipped core but never acquit one
  (`StarDetect.js:467-471`). The reasoning is sound and carefully argued in the comments, but it is
  a domain hack for consumer video, not a contribution to photometry.
- **`calibrateDetection` (`StarDetect.js:702`)** measures the median accepted blob area on one frame
  and rescales every pixel-denominated constant in the pipeline from the implied PSF radius — minimum
  area at 1/16 of the median area, aperture at 2.5 r, association gate at 3 r, artifact excursion
  bound at 3.5 r. Scaling an aperture to a measured PSF width is completely standard; propagating
  the *same* measured radius into the tracker's association gate and artifact test is a convenience,
  and the specific multipliers are tuned to one clip.

**Match** — background mesh with κσ-clipped statistics and bilinear interpolation, matched
filtering, σ-thresholding, connected-component segmentation with a minimum area, second-moment shape
parameters, aperture photometry with a local sky annulus, isophotal-vs-aperture bias reasoning. All
SExtractor/DAOPHOT-era standard practice.
**Diverge** — deblending is replaced by blend *rejection*; an unconditional clipped median instead
of SExtractor's mean/mode switch; one-sided clipping; no median filtering of the mesh; no adaptive
(Kron) aperture; no PSF fitting at all.
**Extend** — nothing defensible. The three-tier photometry preference in `instrumentalMagnitude`
(clean aperture ▸ isophotal ▸ contaminated aperture) is a sensible ordering argued from which
error corrupts *ranking* versus *scale*, but is not a new measurement.
**Local heuristic** — the entire colour/laser rejection path; the specific constants in
`calibrateDetection`; the `lowPeak` background-failure guard (`StarDetect.js:655`).

---

## 2. Frame-to-frame registration

### The standard

Two families are relevant.

*Point-pattern matching without a prior.* Groth's triangle algorithm[^groth] matches two coordinate
lists by building triangles from all triples, labelling vertices so that one named side is shortest
and another longest (a six-fold reduction in candidates), and placing each triangle in a 2-D
descriptor space spanned by the **ratio of longest to shortest side** and the **cosine of the angle
at the middle vertex** — invariant to translation, rotation, scaling and inversion. FOCAS[^valdes] is
the canonical reference implementation, extended to tolerate partial overlap and passband-dependent
magnitude offsets. Translation/pose voting — accumulating each candidate correspondence's implied
transform in a histogram and taking the peak — is the generalised-Hough / pose-clustering tradition.

*Robust fitting.* RANSAC[^fischler] is the default for correspondence sets with gross outliers.
Least trimmed squares with iterated concentration steps[^rousseeuwvd] is the deterministic
alternative: fit, re-select the best-fitting subset, refit, to a fixed point. Scale is estimated
robustly via the MAD with the 1.4826 Gaussian consistency factor[^rousseeuw].

*Model.* For a camera rotating about its optical centre with fixed intrinsics, consecutive frames
are related exactly by the homography `H = K R K⁻¹`; a rotation-plus-translation similarity is its
small-angle, narrow-field approximation. This is textbook[^hz].

### What Sitrec does

- **Model.** A complex similarity `q = A·p + B` (`StarMatch.js:110-146`), with `|A|` constrained
  to 1 by default (`allowScale: false`, `StarMatch.js:49`). Under that constraint the weighted
  least-squares optimum is exactly the unit complex number aligned with the cross-correlation sum
  (`StarMatch.js:205-208`) — i.e. the 2D orthogonal-Procrustes solution.
- **Robust fit.** `fitSimilarity` (`StarMatch.js:228`) is deterministic trimmed least squares, and
  the code says explicitly why not RANSAC (`StarMatch.js:215-221`): once matching is predicted the
  set is overwhelmingly inliers, so sampling buys nothing and costs run-to-run variance. Three
  refinements over plain trimming: a **median-translation seed** (`StarMatch.js:244-261`), an
  **annealed rejection threshold** from 4× down to 1× (`StarMatch.js:264-287`), and a **fixed-point
  loop with cycle detection** (`StarMatch.js:319-341`) so the returned transform is the least-squares
  fit of precisely the set it reports as inliers.
- **Three matchers, always all three.** Prediction-then-refine
  (`matchByPrediction`, `StarMatch.js:440`, with greedy mutually-exclusive pairing over a spatial
  hash, `StarMatch.js:378`); triangle side-ratio invariants (`buildTriangles`, `StarMatch.js:473`;
  `triangleMatch`, `StarMatch.js:518`); and translation-offset voting into a 6 px histogram with
  vote-splitting mitigation (`matchByOffsetVote`, `StarMatch.js:608`). All three run on every frame
  pair and **the corroborated fit explaining the most sources wins** (`StarMatch.js:818`).
- **Artifact removal before registration.** `findCameraFixed` (`StarMatch.js:701`) clusters raw
  pixel positions across the whole clip and marks persistent clusters, but only after a first
  unexcluded pass has established that the camera moves at all (`StarMatch.js:955-975`).
- **Gap bridging.** When the previous frame failed, the step is measured against a pool of recent
  *strongly*-fitted anchors rather than only the last trusted frame (`StarMatch.js:862-905`).

### Relationship

- The **similarity model and its closed-form solution are standard.** The `|A| = 1` constraint is
  argued from physics (stars are at infinity; only rotation moves them) plus a measurement — a free
  scale absorbed camera-fixed artifacts instead of rejecting them, recovering 22.5 px of a commanded
  38 px motion (`StarMatch.js:167-172`). The argument is good; the model is not new.
- **Triangle matching is Groth/Valdes**, and the code says so (`StarMatch.js:471`). Sitrec's
  descriptor is the pair of side ratios `(s₀/s₂, s₁/s₂)` — two ratios — rather than Groth's
  (longest/shortest ratio, cosine of the middle angle). The two carry the same information for a
  non-degenerate triangle; Sitrec's is marginally cheaper and avoids a trigonometric call. Vertices
  are ordered by opposite-side length so matching triangles align without trying six permutations
  (`StarMatch.js:497-506`), which is Groth's labelling trick in another guise, and triangles are
  built only over each source's nearest neighbours so they survive a partial field. All
  implementation choices within the established family. Note also that Sitrec inherits the weakness
  Lang et al. cite as their reason for moving to quads: a two-number descriptor produces frequent
  chance agreement — which is exactly why `matchByInvariants` refuses an uncorroborated fit
  (`StarMatch.js:562-570`).
- **Offset voting is pose clustering**, applied to pure translation. Nothing new; the useful part is
  the stated *reason* it is kept alongside triangles (`StarMatch.js:592-600`): motion blur scrambles
  the brightness ranking that triangle anchors depend on, while position consensus does not care
  about ranking.
- **The arbitration policy is the one genuinely arguable design contribution here.** The usual
  pattern is a fallback cascade — try prediction, fall back to invariants if it looks weak. Sitrec
  runs all matchers unconditionally and arbitrates on inlier count, on the stated reasoning that a
  coherent cluster of stationary artifacts produces a *strong-looking* lock while the real field has
  shifted elsewhere, so a strength test cannot detect its own failure (`StarMatch.js:810-817`). A
  disagreement between two corroborated interpretations is additionally recorded as `contested`
  (`StarMatch.js:845-850`) rather than silently resolved. This is defensible engineering; it is not
  a new algorithm, and no ablation against a cascade is reported.
- **The fixed-point trimming** (fit and inlier set mutually consistent, cycle-detected) is
  essentially an LTS concentration loop[^rousseeuwvd] applied to a similarity fit. The
  *justification offered* — that an inflated inlier count is a safety problem because downstream
  corroboration gates read it — is a nice framing but the mechanism is known.

**Match** — similarity/Procrustes fitting, triangle-invariant point-pattern matching, translation
pose clustering, LTS-style concentration to a fixed point, MAD-scaled robust statistics.
**Diverge** — RANSAC is explicitly rejected in favour of a deterministic trimmed fit; scale is
constrained rather than free.
**Extend** — the "consult every matcher, arbitrate on inlier count, flag disagreement" policy, and
the multi-anchor bridging pool. Both are modest and untested against alternatives.
**Local heuristic** — every threshold in `STAR_MATCH_DEFAULTS` (`StarMatch.js:32-107`); the
`fixedMaxFraction` / `staticMotionThreshold` guards that distinguish a still camera from artifact
domination.

---

## 3. Tracklet association

### The standard

Frame-to-frame data association with a gate and a global assignment is the standard multi-target
tracking formulation. Solving the per-frame assignment exactly is the Hungarian algorithm[^kuhn];
the shortest-augmenting-path form with dual potentials used here is Jonker–Volgenant[^jv]. Under
Gaussian measurement noise, minimising the sum of squared distances is the maximum-likelihood
assignment. Constant-velocity gating is the degenerate (gain-free) case of a Kalman filter.

### What Sitrec does

`buildTracklets` (`StarSolve.js:149`) associates in **reference coordinates** rather than raw pixels,
so a star barely moves however fast the camera pans and the gate can stay tight. Each frame's pairing
is an **exact minimum-cost assignment** (`assignMinCost`, `StarSolve.js:274` — the JV
shortest-augmenting-path form with potentials), with an explicit **dummy column per detection**
(`StarSolve.js:227`) whose cost exceeds any gated pairing, so maximum cardinality and minimum cost
are a single objective rather than two passes that can disagree. Gate centres come from a
constant-velocity least-squares fit over the last eight observations, used only once there are four
of them spanning at least three frames (`trackPrediction`, `StarSolve.js:324`).

The comment at `StarSolve.js:196-207` records that greedy, greedy-plus-augmenting, and
greedy-plus-swaps all failed on reachable cases, and that **each failure surfaced as a manufactured
mover** — which is the substantive point: in this application an association error is not a tracking
nuisance, it is a false detection of anomalous motion.

The spherical path re-implements association in the *observing* frame's pixels
(`buildTrackletsSpherical`, `StarSolveSphere.js:249`) because a spherical map has no single plane;
it imports the same `assignMinCost` rather than reimplementing it (`StarSolveSphere.js:31`).

### Relationship

**Match** — global nearest-neighbour association by exact linear assignment with a dummy-column
miss model, and constant-velocity gating. Entirely standard.
**Diverge** — association happens in a motion-compensated reference chart rather than in image
coordinates, which is what allows the tight gate.
**Extend** — nothing.
**Local heuristic** — the eight-observation / four-point / three-frame thresholds on when a velocity
is trusted (`StarSolve.js:325-328`).

---

## 4. Global refinement: a restricted bundle adjustment

### The standard

Bundle adjustment — jointly refining structure and viewing parameters to minimise reprojection
error — is surveyed definitively by Triggs et al.[^triggs]. That survey covers exactly the design
choices this stage makes: the cost function and robustness, **gauge (datum) freedom** and how to fix
it, and the trade-off between joint sparse Newton/Levenberg–Marquardt steps (with Schur-complement
elimination) and the alternating **resection–intersection** scheme, which Triggs et al. describe as
simple but linearly and often slowly convergent.

### What Sitrec does

Two implementations of the same idea.

*Planar* — `refineGlobal` (`StarSolve.js:452`) alternates: with star positions held, each frame's
transform is a robust similarity fit; with transforms held, each star's position is the **median** of
its back-projected observations (`starPosition`, `StarSolve.js:412`). The gauge is fixed by re-pinning
the first solved frame to the identity after every round (`StarSolve.js:510-518`), which makes the map's
coordinates "frame 0 pixels". The trimming gate is rescaled each iteration to the *measured* noise
(`StarSolve.js:537`).

*Spherical* — `refineGlobalSpherical` (`StarSolveSphere.js:770`) alternates per-frame orientation
(Wahba plus a pixel-domain Gauss–Newton refinement, `fitFrameOrientation`, `StarSolveSphere.js:501`)
with per-track direction (the **mean** of back-rotated rays, `solveTrackDirection`,
`StarSolveSphere.js:548`). Gauge is pinned identically (`applyGauge`, `StarSolveSphere.js:637`).

`solveStarField` (`StarSolve.js:1208`) runs the planar solve **three times**, re-associating between
passes, with the third restricted to tracks already classified as stars — because "the first solve
necessarily includes the mover and any artifacts, and those pull on the very transforms used to judge
them". `StarTrackerUI.js:1333-1365` repeats that pattern on the sphere.

### How, precisely, this is *restricted*

Against a general bundle adjustment:

- **No 3D structure.** Points are constrained to a plane (planar path) or to the unit sphere
  (spherical path). Stars are at infinity, so there is no depth to solve for.
- **No camera translation.** Each frame's pose is 3 DOF (a rotation) on the sphere, or 3 DOF
  (rotation + 2D translation, with scale fixed) in the plane. There is no baseline and therefore no
  parallax.
- **Intrinsics are fixed during refinement.** The lens is calibrated once, beforehand, on a single
  baseline pair (§7), and is then held constant. Focal scale `s` exists in the state
  (`makeFrameState`, `StarSphere.js:147`) but nothing solves for it — the reason given
  (`StarSphere.js:141-146`) is that a free scale absorbs camera-fixed artifacts instead of rejecting
  them.
- **Alternating, not joint.** Each block has a closed form, so no Jacobian is assembled across
  blocks and no Schur complement is formed. This is exactly the resection–intersection scheme, with
  its known convergence penalty; in practice both spherical passes converge in 8–9 of a permitted 12
  iterations (`docs/dev/star-track-overlay-circles.md`).
- **Robust by trimming, not by an M-estimator kernel.** Triggs et al.'s recommended robust cost
  functions are not used; the gate is a hard trim, annealed.
- **Anchor subsetting.** The spherical path caps the tracks that may shape the orientations at 400,
  longest-observed first (`packAnchors`, `StarSolveSphere.js:459`); every track is still placed in the
  finished map and classified against it. The planar path has the same knob but leaves it off by
  default, with a measured reason (`StarSolve.js:41-49`).

### The temporal smoothness prior

`applySmoothedTransforms` (`StarSolve.js:578`) is the part least like a textbook bundle adjustment.
Rather than fitting each frame's rotation independently, it solves all frames jointly:

```
minimise  Σ_f w_f (θ_f − θ̂_f)²  +  λ Σ_f (θ_{f−1} − 2θ_f + θ_{f+1})²
```

with `θ̂_f` the independently fitted rotation and **`w_f` the exact curvature of that frame's
least-squares cost with respect to rotation** — which, with the translation eliminated, is the inlier
spread about the inlier centroid `Σ|p − p̄|²` (`StarSolve.js:606-618`). The normal matrix is
pentadiagonal and positive definite, solved directly by an LDLᵀ factorisation
(`solveBanded2`, `StarSolve.js:670`). The translation is then **re-estimated at the pinned rotation**
by a median-seeded annealed consensus (`robustTranslationAtRotation`, `StarSolve.js:710`), because
`B` is not separable from `A`.

Three things about this are worth a paper's attention and one is worth a caveat:

- A **second**-difference penalty is chosen over a first-difference one because it is identically
  zero on any constant-rate pan and only resists *acceleration* (`StarSolve.js:60-70`). A
  first-difference penalty would bias a steady pan toward stationarity. This is the classic argument
  for second-order graduation/smoothing penalties[^whittaker] and is correct.
- Weighting the data term by the **exact Hessian of the per-frame cost** makes the units of the two
  terms agree (px² per rad²) so that λ can be expressed as a multiple of the median `w`, and makes a
  sparsely-observed frame follow its neighbours while a well-observed one follows its own evidence.
  This is a Bayesian-precision weighting done exactly rather than approximately, and it is a genuinely
  tidy construction.
- The failure it fixes is measured and specific: sparse frames were **bistable**, flip-flopping
  between rotations 1.2° apart on alternating frames, which duplicated every star in the map
  (`StarSolve.js:52-64`).
- **Caveat.** The penalised-second-difference smoother is Whittaker–Henderson graduation /
  discrete-second-derivative Tikhonov regularisation, and equivalent priors are routine in
  visual–inertial smoothing and in trajectory estimation generally. The novelty, if any, is narrow:
  applying it to *per-frame image-plane rotation* with the *data weight taken as the analytic
  curvature of the per-frame reprojection cost*, and the demonstration that it suppresses a
  specific, reproducible bistability. It is applied only on the planar path — the spherical solve
  has no equivalent term.

**Match** — alternating (resection–intersection) refinement of poses and structure against a shared
map; explicit gauge fixing by pinning one frame; iterative re-weighting/trimming; re-solving on the
inlier population to avoid contaminants shaping the estimate that judges them.
**Diverge** — pure rotation, no depth, fixed intrinsics, hard trimming instead of a robust kernel,
alternating instead of joint sparse Newton. The alternation is a deliberate exploitation of the fact
that both blocks have exact closed forms.
**Extend** — the curvature-weighted second-difference rotation prior with its direct pentadiagonal
solve and the subsequent translation re-estimation at the pinned rotation.
**Local heuristic** — `refineSmoothness = 1.0`; the three-pass / re-associate-between-passes
schedule in `solveStarField`; `maxAnchors = 400`.

---

## 5. Rotation estimation

### The standard

Finding the rotation that best aligns two sets of unit vectors is **Wahba's problem**[^wahba] — which
is worth citing carefully, because it is a *one-page problem statement* in SIAM Review's problems
department, not a paper; the solutions were published separately a year later[^farrell].

Closed-form solutions: Davenport's **q-method**[^davenport], which builds a 4×4 symmetric `K` matrix
whose dominant eigenvector *is* the optimal quaternion; **QUEST**[^shuster], which finds that
eigenvalue by a Newton iteration on the characteristic polynomial rather than a full
eigendecomposition (and which also introduced TRIAD in the same paper); and Markley's **SVD
solution**[^markley], which is the most numerically robust and is the orthogonal-Procrustes route.

### What Sitrec does

`fitRotationWahba` (`StarSphere.js:244`) is Davenport's q-method: it accumulates the attitude profile
matrix `M = Σ wᵢ Bᵢ Aᵢᵀ`, builds `K` from its trace, symmetric part and the vector of antisymmetric
components, and takes the dominant eigenvector via a cyclic **Jacobi** eigendecomposition
(`dominantEigenvector`, `StarSphere.js:195`). At `StarSphere.js:264-269` the result is conjugated,
with the reason recorded: Davenport's method is stated in the Shuster/JPL quaternion convention,
which is the conjugate of the Hamilton convention used elsewhere, and returning it unconjugated
yields exactly twice the true rotation angle.

Two properties of the surrounding code matter more than the choice of Wahba solver:

- **Wahba is only the initialiser.** It minimises *chord* error between unit rays, which is not
  detector-pixel error once the lens Jacobian varies across the field
  (`StarSphere.js:240-242`). `refineRotationPixels` (`StarSphere.js:281`) then minimises
  reprojection error in pixels by Gauss–Newton on the rotation vector with a **left** update
  `q ← exp(δ)·q` and a numeric 3-column Jacobian. This is standard Lie-group optimisation on SO(3),
  and the reason it is necessary is stated quantitatively: an orthographic lens compresses radially
  by `cos θ`, which is 0.6 at the corner of the measured clip.
- **The robust seed is a median of per-pair rotation vectors** (`fitRotationRobust`,
  `StarSphere.js:387-393`), because unweighted Wahba is dragged far enough by gross mismatches that
  subsequent trimming rejects the true consensus instead. Measured: with a fifth of pairs displaced
  by ~150 px, all-pairs Wahba lands 2.4° out, putting every genuine inlier ~37 px from its
  prediction so nothing falls inside the gate. The gate is annealed and **widened** rather than
  abandoned when it empties (`StarSphere.js:421-425`).

### Relationship

**Match** — Davenport's q-method for Wahba's problem; Gauss–Newton refinement on the SO(3) tangent
space; annealed trimming.
**Diverge** — the Jacobi eigensolver is a pedestrian choice; QUEST or Markley's SVD would be faster
or more robust respectively, and a paper should say why neither was used (the honest answer appears
to be that the cost is negligible here — the fit runs on at most 400 anchors per frame).
**Extend** — the explicit two-stage structure (chord-optimal Wahba → pixel-optimal refinement) with
the anisotropic-Jacobian justification, and the median-of-rotation-vectors robust seed. The
two-stage structure is standard photogrammetric practice stated unusually clearly; the seed is a
straightforward robustification.
**Local heuristic** — `rounds = 8`, `startThresholdFactor = 4.0`, the 4096 px gate-widening ceiling.

---

## 6. Noise estimation and the classification statistic

### The standard

For a Gaussian, the MAD is made consistent with σ by the factor 1.4826[^rousseeuw]. For *two*
independent Gaussian components of equal σ, the radial magnitude follows a **Rayleigh** distribution,
whose median is σ·√(2 ln 2) ≈ 1.17741·σ; hence σ = median / 1.1774. The significance of a fitted
slope against Gaussian noise is the usual t-statistic, slope / (σ / √Σ(x−x̄)²). For a two-component
velocity the correct statistic is the Mahalanobis norm √(vᵀ Cov(v)⁻¹ v), which is 2-DOF.

### What Sitrec does

- **Planar** (`estimateNoise`, `StarSolve.js:743`). Per track, the scatter is the **median radial
  residual about that track's own linear trend**; across tracks, a **low quantile** (25th) is taken,
  and *that* value is divided by 1.1774 (`StarSolve.js:838`). Camera-fixed artifacts are excluded
  first (`StarSolve.js:774`) because under a steady pan they trace near-perfect lines in reference
  coordinates, so their scatter is near zero and they would set the noise level for the whole field.
  A floor of 0.15 px applies.
- **Spherical** (`estimateNoiseSpherical`, `StarSolveSphere.js:833`). Residuals pooled over all
  observations, median taken, divided by 1.1774 (`StarSolveSphere.js:851`), floored identically.
- **Classification.** Planar: slope t-statistic against the measured σ (`StarSolve.js:915-917`),
  plus an absolute drift bar expressed in σ (`driftMinSigmas = 12`), plus a scatter test and a
  visibility fraction (`StarSolve.js:956-961`). Spherical: 4-parameter Gauss–Newton fit of a
  tangent-plane offset and velocity, minimised in detector pixels, with significance taken as the
  **2-DOF Mahalanobis norm** of the velocity block of `σ²(JᵀJ)⁻¹` (`StarSolveSphere.js:971-984`).

### Why 1.1774 and not 1.4826 — and what it does *not* license

This is the detail the brief singles out and it is worth stating exactly, because the two constants
enter with opposite senses.

- The MAD estimator **multiplies**: σ̂ = 1.4826 × MAD.
- The Rayleigh median correction **divides**: σ̂ = median / 1.1774 = 0.8493 × median.

So applying the MAD factor to a set of 2D radial residuals would overstate the per-axis σ by
1.4826 × 1.1774 ≈ **1.746×** — which is the 1.75× the code comment claims (`StarSolve.js:829-831`).
That arithmetic is correct, and both usages in the codebase are internally consistent: `StarDetect.js:151`
applies 1.4826 to a genuine one-dimensional MAD of tile samples, while `StarSolve.js:838` and
`StarSolveSphere.js:851` apply 1/1.1774 to medians of 2D magnitudes.

Two honest caveats a reviewer will raise:

1. **The 1.1774 conversion is exact only for the median of a Rayleigh sample.** In the planar path
   it is applied to a value selected by a *25th-percentile-across-tracks* rule, so the input is a
   per-track median (correct object) but chosen from the low tail of a population (biased low by
   selection). The code is explicit that these are two corrections at two levels and must not be
   conflated (`StarSolve.js:832-835`), and the floor exists precisely to stop the resulting σ from
   collapsing. But the estimator is deliberately **biased low** — it estimates "the noise of a
   well-measured source", not the population noise — and every threshold expressed in σ inherits
   that bias. A paper must say so.
2. **The variable named `mad` in `estimateNoiseSpherical` is not a MAD**; it is the median of the
   residual magnitudes (`StarSolveSphere.js:849`). The arithmetic is right, the name is misleading.
3. **The two paths use different statistics with the same threshold names.** The planar significance
   divides a two-component slope magnitude by the standard error of a *single* component; the
   spherical one is properly 2-DOF. `StarSolveSphere.js:871-876` acknowledges that the tuned
   threshold of 5.0 encodes the old construction and "must therefore be re-derived rather than
   inherited", and points at `tests/StarSolveDriftStatistic.test.js`. As shipped, both paths use
   `driftSignificance = 5.0`. This is a known, documented inconsistency, not a hidden one — but it
   means the two classifiers are not calibrated to the same false-alarm rate.

**Match** — Gaussian MAD scaling; Rayleigh median-to-σ conversion; slope t-statistic; 2-DOF
Mahalanobis significance; a hard floor on an estimated scale.
**Diverge** — the across-track low quantile instead of a median or a pooled estimate, chosen because
the well-measured sources *are* the low tail and a median follows a poorly-behaved majority
(measured: 25 random-walking tracks held σ at 6.06 px, at which a 39.5 px mover reads as a star,
`StarSolve.js:812-826`).
**Extend** — the argument at `StarSolve.js:816-826` that a classify-then-re-estimate loop cannot
escape this circularity, because an inflated σ inflates the scatter cut that would have marked the
junk incoherent in exactly the same proportion. That observation — that the fix must be an estimator
which does not need the classification — is the substantive statistical point in this stage and is
worth stating in a paper.
**Local heuristic** — `noiseQuantile = 0.25`; `noiseFloor = 0.15 px`; `driftMinSigmas = 12`;
`scatterSigma = 4.0`; `minVisibleFraction = 0.4`.

---

## 6a. Track merging by falsifiable hypothesis

Not a standard pipeline stage, so it is called out separately.

A star can drop below threshold for longer than the association gap allows, or hand its detections
to a second track during a blend, leaving two tracklets that are one star. `mergeSplitStarTracks`
(`StarSolve.js:1055`) merges star-classified tracks that are close **and** temporally
complementary, where the complementarity test rests on a physical fact — one light yields one
detection per frame, so two tracks of the same star can coexist only through a blend's transient
double-detection, an *absolute* few frames rather than a fraction of track length
(`StarSolve.js:116-125`). Grouping uses **complete linkage**, not transitive pairwise chaining,
because a short fragment sitting between two genuinely distinct stars would otherwise bridge them
into a chimera that alternates between two positions and reads as a manufactured mover
(`StarSolve.js:1076-1083`).

`mergeAndVerify` (`StarSolve.js:1181`) then treats each merge as a **falsifiable hypothesis**: the
merged track must still classify as a star, and anything else refutes it. A refuted *combination* is
forbidden and the merge is re-run from the original tracks, so correct sub-merges survive while the
chimera cannot re-form; verification repeats after every rebuild because reclassification re-measures
σ. Each round forbids at least one combination, so the loop terminates; exhausting the cap abandons
merging entirely rather than shipping unverified merges.

**Match** — complete-linkage agglomerative clustering; hypothesise-and-verify is the RANSAC family's
basic move.
**Diverge / Extend** — the *refutation* semantics: a merge is not scored, it is tested against the
same classifier that consumes it, and a failed test forbids that exact combination and its supersets
rather than reverting the whole merge. I am not aware of this specific construction in the tracking
literature, but no search was done, and it is a small enough idea that it has probably been
reinvented elsewhere.
**Local heuristic** — `starMergeRadius = 4 px`, `starMergeMaxSharedFrames = 3`, the 20-round cap.

---

## 7. Lens self-calibration

### The standard

*Self-calibration from a rotating camera.* Hartley[^hartley97] showed that a camera fixed in
location and rotated freely can be calibrated from point matches alone, via the inter-image
homographies and the image of the absolute conic; Agapito, Hayman and Reid[^agapito] extended this
to cameras that zoom, using the infinite-homography constraint. Both assume a **pinhole**
(projective) camera. Zhang[^zhang] is the standard planar-target calibration method. Hartley &
Zisserman[^hz] is the reference text, including the standard result that the principal point is
weakly observable.

*Lens models.* Radial-plus-tangential polynomial distortion of a pinhole image is the
**Brown–Conrady** model: Conrady[^conrady] gave the first rigorous treatment of decentred systems,
and Brown turned it into the practical radial-plus-tangential polynomial parameterisation[^brown66];
Brown's better-known 1971 paper[^brown71] is the close-range *self-calibrating bundle adjustment*
work, and is the wrong citation for the distortion model itself. For wide-angle and fisheye optics
the classical projections are equidistant (r = fθ), equisolid-angle (r = 2f sin(θ/2)), orthographic
(r = f sin θ) and stereographic (r = 2f tan(θ/2)); the generic **odd-polynomial** radial model
r(θ) = k₁θ + k₂θ³ + k₃θ⁵ + k₄θ⁷ + k₅θ⁹ is Kannala & Brandt[^kb], who use exactly five terms with a
**free** leading coefficient and add two separable asymmetric (radial and tangential) distortion
families on top, for 23 parameters in the full model against 9 in the radially-symmetric reduction.

### What Sitrec does

`CameraLens.js:41-101` defines the five closed-form presets above plus a `custom` type whose curve is
the **inverse** parameterisation, θ(ρ) = ρ(1 + d₃ρ² + d₅ρ⁴ + d₇ρ⁶), where ρ = r/(f·s) — an odd
polynomial in normalised image radius returning field angle, with the linear coefficient **pinned to
1** so that `focalPx` alone sets the paraxial scale (`CameraLens.js:86-90`; a free linear term is an
exact duplicate of the focal length and the fit wanders along that valley). Non-monotone fitted
curves are **rejected, never clamped** (`CameraLens.js:211-217`), because clamping makes the forward
and inverse maps disagree.

`calibrateLens` (`StarCalibrate.js:525`) recovers the lens from the star field alone:

1. **Baseline selection** (`chooseBaseline`, `StarCalibrate.js:111`) scores candidate frame pairs by
   `pairs × span` — but screens on rotation *first*, with a cheap nominal-lens fit, because a dense
   narrow baseline can win on score and then be refused for insufficient rotation while a wider,
   thinner, perfectly calibratable baseline sits unexamined (`StarCalibrate.js:130-149`).
2. **A focal-length scan, not an optimiser** (`scanLens`, `StarCalibrate.js:190`), over a geometric
   grid of 34 values from 0.35 to 8 half-widths, for each of the five presets, with a robust 3D
   rotation refitted at every candidate. The reason is an observability statement
   (`StarCalibrate.js:8-13`): the cost surface has a broad flat valley running out to f → ∞, and
   f → ∞ *is* the degenerate 2D model the whole exercise exists to replace, so a cold-started
   optimiser sits in that valley and reports convergence. Measured: five different focal seeds
   returned bit-identical answers.
3. **A coarse principal-point grid search**, gated (`scanPrincipal`, `StarCalibrate.js:259`), run
   only when a centred axis explains fewer than 60% of the correspondences. The justification is a
   *measured cost surface* (`StarCalibrate.js:241-248`) on a real cropped timelapse whose true axis
   is at (953, 239) of a 1280×720 frame: the global minimum is 0.60 px at the truth, and from the
   frame centre the **steepest improvement points away from it**, into a broad shallow plateau. The
   grid nominates three cells, each re-scanned at full focal resolution before one is chosen,
   because at the grid's coarse resolution a boundary cell out-scored the near-truth cell and led to
   an axis 77 px from truth.
4. **Free-shape refinement** (`refineCustom`, `StarCalibrate.js:359`) by coordinate descent over the
   polynomial coefficients, focal length and principal point, seeded from an **area-weighted
   least-squares fit** of the polynomial to the winning preset's curve (`polyFromPreset`,
   `StarCalibrate.js:303`; weighted by ρ because the sensor's area element goes as ρ dρ). A
   truncated Taylor series of the same curve is measurably worse — 9.83 px vs 0.98 px at the corner
   for an orthographic lens over 1280×720.
5. **An acceptance gate with five conditions** (`StarCalibrate.js:610-754`): enough rotation; the
   rotation axis at least 12° off the boresight; enough radial *span*; enough radial *motion*; and
   a robust rms at least 1.6× better than a re-optimised **rectilinear** model given the same
   freedoms. Then a held-out test, split by *track* rather than by observation, compared **like with
   like** against the rectilinear baseline's own held-out error — and a free polynomial that fails
   to generalise falls back to the preset rather than taking the whole calibration down
   (`StarCalibrate.js:726-753`).

### The roll degeneracy

The gate's second condition is the observability statement worth a paper's attention
(`StarCalibrate.js:15-20`, `StarCalibrate.js:619-627`):

> a PURE ROLL about the optical axis tells you nothing whatsoever about the lens. Every radially
> symmetric lens maps a roll to the same rotation about the principal point, so a large, clean,
> full-frame roll fits every candidate equally well and a naive "did it rotate enough / do the stars
> cover enough radii" test passes it with flying colours while the fit is pure noise.

This is a straightforward consequence of radial symmetry, so it is almost certainly stated somewhere
in the self-calibration literature — but it is *not* commonly implemented as an explicit refusal
condition in practical tools, and `radialExcitation` (`StarCalibrate.js:504`) operationalises it
precisely: it separately measures radial *coverage* (span of radii occupied) and radial *motion*
(90th percentile of |r_B − r_A|), and refuses on either.

### Relationship

- **Self-calibration from a purely rotating camera is Hartley 1997 / Agapito et al. 2001** in
  principle. Sitrec diverges in that it does **not** use homographies or the absolute conic at all:
  it directly searches a family of non-pinhole radial projections, refitting a 3D rotation at each
  candidate and scoring reprojection in detector pixels. This is necessary because the whole point is
  that `K R K⁻¹` cannot express radial compression — measured, a full homography gave 11.4 px
  against a rigid similarity's 11.7 px on the reference clip (`CameraLens.js:9-10`).
- **The lens model is Kannala–Brandt's family, inverted and reduced.** KB write image radius as an
  odd polynomial in field angle with a **free** leading coefficient and five terms; Sitrec writes
  field angle as an odd polynomial in normalised image radius with the leading coefficient **pinned
  to 1** and three terms (θ³, θ⁵, θ⁷ in ρ). The leading-coefficient-1 convention is *not* KB's own —
  it is the reparameterisation used by OpenCV's `fisheye` model and its descendants, which absorbs
  the scale into the focal length; Sitrec arrives at it independently and for the same stated reason
  (`CameraLens.js:86-90`). Sitrec's model is also **strictly radial**: it has no analogue of KB's two
  asymmetric term families, which `docs/dev/star-identify-edge-stars.md` names as a candidate
  explanation for a residual 0.42° absolute sky error on one clip.
- **No calibration target, no EXIF, no user input.** The stars are the target. That is not itself
  novel — plate-scale and distortion solving from star fields is routine in astrometry — but the
  combination of *(video, unknown lens family, unknown principal point, unknown focal length,
  possibly cropped, no catalogue involved)* is unusual.
- **The "decline when the evidence does not support a fit" discipline is the strongest practical
  claim.** Every refusal path returns a human-readable reason and the flat model stands
  (`StarCalibrate.js:540`, `:616`, `:626`, `:635`, `:638`, `:650`, `:751`). The user documentation is
  careful to call this "a guard, not a proof — the holdout is not fully independent (earlier stages of
  the search see all the correspondences)" (`StarTracker.md`), which is exactly the right caveat and
  should survive into any paper.

**Match** — self-calibration of a rotating camera; odd-polynomial radial lens models; principal point
as a weakly-observable parameter requiring a bound; held-out model selection for polynomial order.
**Diverge** — a bounded grid search over projection *family* and focal length instead of homography
algebra or a cold-started optimiser; direct pixel-domain scoring; a strictly radial model with no
decentring terms.
**Extend** — (i) the explicit roll-degeneracy refusal, operationalised as separate radial-coverage
and radial-motion tests; (ii) the gated coarse principal-point search justified by a measured,
actively misleading cost surface on cropped footage; (iii) the like-with-like held-out comparison
against a re-optimised rectilinear baseline, with fallback to the preset rather than outright
refusal.
**Local heuristic** — `minRotationDeg = 0.35`, `minAxisOffsetDeg = 12`, `minRadialSpanFrac = 0.35`,
`minRadialMotionPx = 2.0`, `minImprovement = 1.6`, `principalMaxOffsetFrac = 0.45`,
`principalSearchWithinFrac = 0.6`, the 3-term polynomial cap, the coordinate-descent step schedule.
Every one of these is tuned against two real clips and a set of synthetic scenes.

---

## 8. Blind plate solving (star identification)

### The standard

**Astrometry.net**[^lang] is the reference method for blind astrometric calibration and Sitrec
follows it closely — the module says so at `StarIdentify.js:5-7`. The method: take four stars, let A
and B be the most widely separated pair, express C and D in the local coordinate system in which A
is the origin and B is (1,1); the resulting **4-vector (x_C, y_C, x_D, y_D)** is invariant under
translation, rotation and scale. C and D are required to lie **within the circle having A and B on
its diameter**. The code has two symmetries — swapping A and B maps each coordinate `z` to `1 − z`,
and swapping C and D exchanges the pairs — which are broken by demanding **x_C ≤ x_D and
x_C + x_D ≤ 1**. Quads rather than triangles because, in the authors' words, "the positional noise
level in typical astronomical images is sufficiently high that triangles are not distinctive
enough… By using quads instead of triangles, we nearly square the distinctiveness of our features."
Codes are precomputed for catalogue quads and indexed; each image quad whose code matches proposes a
field, and the hypothesis is verified by projecting the in-field catalogue into the image.
Astrometry.net builds indices by selecting bright stars uniformly over **HEALPix** cells, in
sub-indices each spanning a factor-of-two range of scales, with kd-tree code lookup; acceptance is a
**Bayesian decision** — the log-odds of the "aligned" hypothesis against an explicit false-positive
background model.

Older star-identification work is the star-tracker literature: Groth's triangles[^groth]; the grid
algorithm of Padgett & Kreutz-Delgado[^padgett]; Mortari et al.'s **Pyramid**[^mortari], which is
also a four-star construction for the lost-in-space case; and Liebe's tutorial on star-tracker
accuracy[^liebe].

### What Sitrec does

`quadCode` (`StarIdentify.js:262`) is the astrometry.net code, including both canonicalisations and
the stability constraint:

- A and B are the most separated pair (`StarIdentify.js:263-270`).
- The frame is `z = (P − A)/(B − A)` then multiplied by (1 + i) so B lands on (1,1)
  (`StarIdentify.js:277-282`).
- C and D must lie **inside the circle of diameter AB** — outside it, which pair is "most separated"
  flips under noise and the code is unstable (`StarIdentify.js:285-287`).
- Canonical A/B labelling via `cx + dx ≤ 1`, then C before D by x (`StarIdentify.js:288-293`) —
  which is exactly Lang et al.'s pair of symmetry-breaking conditions, implemented in the same
  order, including the `z ↦ 1 − z` map applied on the A/B swap.

Around that:

- **The index is built at runtime**, in tiers (`buildQuadIndex`, `StarIdentify.js:321`;
  `STAR_IDENTIFY_DEFAULTS.tiers`, `StarIdentify.js:32-41`), from the catalogue Sitrec already ships.
  Tiers are (mag ≤ 5.0, quads ≤ 22°), (mag ≤ 6.5, ≤ 8°) and (mag ≤ 4.0, ≤ 50° with a looser 0.05
  code tolerance) for phone-lens fields. Lookup is a binary search on the first code coordinate plus
  a windowed L∞ scan (`lookupCode`, `StarIdentify.js:384`).
- **Both parities are searched** (`StarIdentify.js:665-669`), because screen y grows downward while
  tangent-plane north grows upward and which way the camera maps them is not knowable up front.
- **The tangent point is re-centred on the image centre before verification**
  (`verifyHypothesis`, `StarIdentify.js:922`): the hypothesis arrives projected about the *catalogue
  quad's anchor*, which on a wide field can sit 30° from the image centre, and about the wrong
  tangent point even a correct hypothesis carries tens of pixels of pure projection distortion.
- **Acceptance is two-stage**: a modest provisional bar a four-point transform can actually reach
  (`provisionalMatchFraction = 0.15`, `minMatches = 8`), then robust refinement, then a full
  consensus gate — either `minMatchFraction = 0.5`, or `strongMatchCount = 25` matches at the
  reduced `strongMatchFraction = 0.35` (`consensusMet`, `StarIdentify.js:887`). The denominator is
  `min(nImage, nProjected)` (`consensusNeeded`, `StarIdentify.js:880`), so an image far deeper than
  the verification catalogue is not penalised for stars that could not have matched.
- **Refinement is a three-way consistency loop** (`finishSolve`, `StarIdentify.js:965`): re-centre
  the tangent point, refit the transform *in the new basis*, rematch under the refit model — with the
  whole round rolled back atomically if any step fails its gates.
- **Quad anchors are selected as point sources, not as bright detections**
  (`StarIdentify.js:579-636`): a local-density test against the *median* neighbour count, an extent
  cap relative to the image's own median detection, an elongation cap tighter than the detector's,
  and ranking by `peakSNR` rather than integrated flux where available. The measurement behind this
  is specific — on a 4032×3024 twilight photo with a treeline, taking the 25 brightest by flux put 24
  anchors in the foliage; ranking by `peakSNR` alone left 12 in the trees, compactness alone left 19,
  both together left 1.

### The catalogue — a documentation discrepancy worth correcting

`StarTracker.md` says "The catalog is the Bright Star Catalogue". The shipped file
`data/nightsky/sitrec_bsc_lite.bin` is **not** BSC5. Reading its header directly (7 × int32, the
third being −nStars, the seventh the 22-byte record length, per `parseStarCatalog`,
`StarIdentify.js:118`) gives **117,955 records with Hipparcos numbers up to 120404 and magnitudes
down to ~12** — i.e. a repacked **Hipparcos** catalogue[^hipparcos], not the 9,110-entry Yale Bright
Star Catalogue[^bsc]. (8,870 of its entries are brighter than mag 6.5, which is roughly BSC depth,
and the identification tiers only index down to mag 6.5 — so operationally it *behaves* like a
bright-star catalogue at the indexing stage. But `finishSolve` rematches against the whole catalogue
sorted by magnitude, capped at `max(3 × nImage, 100)` stars in field (`StarIdentify.js:974-979`), so
the refinement pass can and does name stars fainter than any BSC limit.) The `BSC5` key in
`src/ExtraFiles.js:7` is legacy; the real `BSC5.bin` sits unused beside it. Proper names come from
the IAU Catalog of Star Names[^iaucsn], parsed at fixed columns by `parseStarNames`
(`StarIdentify.js:157`).

### Relationship

**Match** — the quad code, its two canonicalisations, the AB-circle stability constraint, the
hypothesise-then-verify-against-the-whole-field structure, both-parity search, and an optional plate
scale prior (`scalePriorFromFov`, `StarIdentify.js:192`; the gate at `StarIdentify.js:730-734`). This
stage is a faithful reimplementation of astrometry.net's core and should be presented as such.
**Diverge** — three ways, and the third is the one that matters:
  1. *Index structure.* Astrometry.net ships pre-built indices with HEALPix-uniform bright-star
     selection, factor-of-two scale sub-indices, and kd-tree lookup in the 4-D code space. Sitrec
     builds three magnitude/diameter tiers at runtime in a couple of seconds, indexed by a sort on
     the **first code coordinate only** with a windowed L∞ scan over the other three. Simpler,
     smaller, and it cannot drift out of sync with the catalogue — but the tiers are the only scale
     stratification, and neighbour selection is by angular radius from each anchor star rather than
     by a sky-uniform binning, so quad density follows the star density rather than being flattened.
  2. *Verification depth.* A shallow pool for hypothesis verification (sparse ⇒ strong evidence) and
     a depth-adaptive pool for refinement (`StarIdentify.js:969-979`).
  3. *Acceptance criterion.* **Astrometry.net accepts on Bayesian odds against an explicit
     false-positive model. Sitrec accepts on a heuristic fraction-or-count gate.** These are not the
     same guarantee, and no false-positive rate is characterised — only negative controls in
     `tests/StarIdentify.test.js` ("points that are not a sky refuse to solve rather than inventing a
     field"; "a DENSE random field refuses too — the strong-count path is not an escape hatch"). Any
     paper must be explicit that this is a weaker claim than astrometry.net's.
**Extend** — the point-source anchor selection for terrestrial clutter. Astrometry.net assumes an
astronomical image; a horizon-in-frame handheld video is a different input distribution, and lit
foliage defeats brightness ranking specifically because integrated flux rewards *size*. This is a
small but real contribution to applying blind plate solving to ground-level, wide-field consumer
imagery, and it is supported by a measured ablation (24/25 → 12/25 → 19/25 → 1/25).
**Local heuristic** — every constant in `STAR_IDENTIFY_DEFAULTS`; the `fovRadiusRad > 1.2` "not a
camera field" cut (`StarIdentify.js:815`); the `3 × median` cut at `fitSimilarityRobust`
(`StarIdentify.js:503`); the "finalise the top five candidates" rule (`StarIdentify.js:784`).

### A limitation that shapes the whole result

Identification still runs on the **planar** reference chart, not the spherical map
(`StarTrackerUI.js:1375-1383`). `docs/dev/star-identify-edge-stars.md` records why, with numbers:
feeding the matcher the ~60 edge stars the lens fit recovers breaks its match consensus outright,
and a gnomonic chart built from the spherical map is *twice as bad in absolute terms* (0.444° vs
0.227° rms against catalogue geometry) even though it is better in self-consistency (0.15 px vs
0.25 px). The distinction drawn there — **self-consistency is not absolute accuracy** — is one of the
more useful things this project has established and would be a legitimate section of a paper on its
own.

---

## 9. Grouping co-moving lights

### The standard

Estimating one shared slope across groups that each keep their own intercept is the **fixed-effects**
(within-group demeaned) estimator from panel-data econometrics; the code names it as such
(`StarCluster.js:113`). Model selection between a linear and a quadratic path by an F-test on the
extra parameters is standard regression practice. Union-find over pairwise agreement is standard
single-linkage clustering.

### What Sitrec does

`groupMovingClusters` (`StarCluster.js:244`) takes every non-star, non-artifact track — including
those individually dismissed as `short` or `incoherent`, which is exactly what a strobe produces —
and:

- fits a per-track linear motion model with the slope's standard error from its own residuals
  (`motionModel`, `StarCluster.js:76`);
- unions pairs whose velocities agree within `3σ` of their joint slope uncertainty plus a 0.15 px/frame
  systematic floor, *and* whose predicted positions at a common epoch sit within a 60 px formation
  radius (`StarCluster.js:273-287`);
- fits one **shared path** with per-member intercepts (`sharedMotionModel`, `StarCluster.js:132`),
  optionally quadratic if an F-test with threshold 10 supports it (`StarCluster.js:200-205`), with
  time centred before squaring and the velocity uncertainty taken from the quadratic design's own
  leverage `Var(v) = s²·S_ww/det` rather than the straight-line `s²/S_uu`;
- attaches velocity-less fragments whose observations lie on the fitted path
  (`StarCluster.js:305-320`);
- holds the ensemble to the same significance and absolute-drift bars a single mover faces, **plus**
  an absolute speed floor of 0.5 px/frame (`StarCluster.js:340-342`), because pooling a hundred
  observations shrinks the standard error until residual *solve* drift measures as significant —
  measured, three groups of star fragments were promoted to "objects" at 0.05–0.34 px/frame while
  the genuine aircraft crossed at 2.1–2.7;
- resolves members into **lights** (`StarCluster.js:385-407`) using the same one-detection-per-frame
  physical fact as the star merge, with a position gate combining each burst's own averaging noise
  and the shared velocity's error projected over the gap between burst epochs;
- enforces the formation limit on the **widest pair of light positions**, not centre-relative,
  because union chaining otherwise builds lines (`StarCluster.js:416-438`).

### Relationship

**Match** — fixed-effects shared-slope estimation, F-test model selection, union-find clustering,
correct leverage for the quadratic design's velocity variance.
**Diverge** — nothing structural.
**Extend** — the promotion of tracks that individually *failed* classification into a jointly
significant object. That is the genuinely useful idea: a flashing aircraft beacon produces only
fragments, each of which is `short` or `incoherent`, and none of which is evidence on its own; their
*agreement* is. Framing this as "the ensemble must clear the same statistical bar a single mover
does, plus an absolute speed floor" is a clean way to keep the promotion honest.
**Local heuristic** — every constant in `STAR_CLUSTER_DEFAULTS` (`StarCluster.js:28-55`), stated at
one clip's plate scale and rescaled by the app layer; the F > 10 threshold; the `shared ≤ 2` frames
rule; the `≥ 3` observations to *found* a light.

---

## 10. Sky and horizon segmentation — **planned, not implemented**

**There is no sky- or horizon-segmentation code in Sitrec.** A search of `src/starTrack/` for sky
masking, horizon detection or edge-based segmentation returns only unrelated uses of the word "sky"
(the photometric sky *level*, and prose about motion "on the sky"). This section therefore maps the
literature for a stage that is designed but unwritten, and makes no claim about an implementation.

### Why the stage is wanted

Two measured failures in the shipped pipeline are the motivation, and both are recorded in the
repository:

1. **Terrestrial clutter hijacks quad anchors.** On a twilight photo with a treeline, 24 of the 25
   brightest detections were foliage (`StarIdentify.js:601-612`). The current defence is the
   point-source anchor test of §8 — a *statistical* proxy for "this is not sky". A geometric sky mask
   would be the direct answer.
2. **The horizon in frame is a candidate explanation for an unresolved 0.42° absolute error.**
   `docs/dev/star-identify-edge-stars.md` lists atmospheric refraction — ~0.5° at the horizon,
   falling off fast with altitude, and not absorbable by any radially symmetric lens — as the leading
   untested explanation for the gap between self-consistency (0.15 px) and absolute sky accuracy
   (0.42°). Knowing where the horizon is would let that be modelled rather than speculated about.

### The prior work

**Shen & Wang**[^shen] is the closest classical fit, and its actual content matters because it is
easy to mis-state. The paper is *Sky Region Detection in a Single Image for Autonomous Ground Robot
Navigation*, Int. J. Adv. Robotic Systems **10**(10), art. 362 (2013). Verified properties, quoting
where the wording is load-bearing:

- **The border-finding stage is greyscale.** "If the input image is a colour image, we convert it
  into a greyscale image", then the gradient magnitude image is formed by convolving with the two
  **Sobel** operators[^sobel] and combining. Colour is discarded here. Any claim that the method
  "assumes daytime colour statistics" is wrong.
- **But the objective it optimises is colour-based.** The energy function is built from Σ_s and Σ_g,
  the **3 × 3 covariance matrices of RGB pixel values** in the candidate sky and ground regions.
  Shen & Wang modify Ettinger et al.'s[^ettinger] earlier energy function to
  `J_n = 1 / (γ|Σ_s| + |Σ_g| + γ|λ₁ˢ| + |λ₁ᵍ|)` with `γ = 2`, dropping the smaller eigenvalues as
  negligible near singularity. So the honest summary is **greyscale + Sobel for the border geometry,
  colour statistics for the objective** — and the authors' claim of applicability to greyscale rests
  on the covariance simply degenerating. Neither "it is purely greyscale" nor "it requires colour"
  is correct.
- **It assumes exactly one sky border per column.** A **sky border position function `b(x)`**,
  1 ≤ b(x) ≤ H, gives the border row in column x, with sky = {(x,y) : y ≤ b(x)} and
  ground = {(x,y) : y > b(x)}. The paper states the limitation itself: "our proposed algorithm
  implicitly assumes that there are sky region pixels in every column." This is the assumption most
  likely to break on a night-sky clip with a treeline, a mast or a building.
- **What is actually searched is a single scalar** — the gradient threshold `t`, by 1-D scan over
  t ∈ [5, 600] in steps of 5 (120 samples), the range chosen because J_n(t) is near-constant beyond
  t ≈ 600.
- **Post-processing** handles the no-sky case (via the mean border row and the mean absolute
  successive difference of b(x)) and columns where objects extrude from the ground (via k-means with
  k = 2 in RGB, taking the cluster further from the ground mean in **Mahalanobis** distance as true
  sky).

For the horizon specifically, the relevant tradition is horizon-line detection for attitude
estimation and for ground-vehicle navigation — Ettinger et al.[^ettinger] is the direct ancestor,
and constrains the horizon to a **straight line** for micro-air-vehicle flight control. The useful
framing for Sitrec is that Shen & Wang deliberately let the boundary **follow the terrain** instead,
which is what a real night-sky clip needs.

The modern alternative is **learned** segmentation. Liba et al.[^liba] train a network to produce a
sky alpha-mask for low-light photography, from partially annotated images inpainted and refined by a
modified weighted guided filter, and run it end to end in under half a second on a mobile device.
This is directly on-domain — *low-light* skies are exactly Sitrec's input — but it is a learned model
with a training-set dependency, which is a different kind of commitment from a 60-line gradient
method and would have to be weighed against Sitrec's deployment modes (including a fully offline
serverless/desktop build).

### Relationship

**Match / Diverge / Extend** — none apply; nothing is implemented.
**Planned.** If it is built, the honest positioning is: a re-implementation of Shen & Wang for the
night-sky case, whose novel content (if any) would be in the *use* — gating quad anchors, and
supplying an altitude coordinate for a refraction model — rather than in the segmentation itself. The
per-column single-border assumption is the specific thing to test first on real clips.

---

## 11. Parallelisation and determinism

Not a research contribution, but it constrains what the method can claim, so it belongs here.

`StarSphereSolvePool.js` runs the spherical refinement across a worker pool. The measured phase split
(`StarSolveSphere.js:352-369`) is: per-frame orientation fit 65–76% (independent across **frames**),
per-track direction update 12–19% and per-track residual sum 10–16% (independent across **tracks**),
gauge re-pin < 0.1%. Both halves had to be parallelised — splitting only the orientation fit caps at
1/(0.30 + 0.70/8) = 2.6× on eight cores. Wall clock on a dense Milky Way timelapse went from 159 s to
~75 s, with the two solve stages from 66 s and 55 s to 4.8 s and 5.3 s
(`docs/dev/star-track-overlay-circles.md`).

The result is **bit-identical to the synchronous solve for any worker count**, achieved by three
disciplines (`StarSphereSolvePool.js:20-33`): workers run the same kernels imported from
`StarSolveSphere.js` rather than a copy; every frame's fit and track's update is independent of the
others; and the cost is reduced from **per-track partials summed in track-index order**, never as a
running total in chunk-arrival order — because floating-point addition is not associative. The
synchronous path was changed to sum the same way. Verification was empirical rather than assumed: the
same FNV hash of all 160 per-frame quaternions and all 2,531 track directions at full double
precision before and after, with `rms` the sole exception at ~1e-15.

This matters for a paper because it means reported results are reproducible across machines and core
counts, which is not true of most parallel bundle adjustments.

---

## 12. Relationship to star-tracker / lost-in-space attitude determination

The closest engineering analogue to this feature is a spacecraft **star tracker**: an instrument that,
given an image of the sky and no prior pointing, identifies stars and returns an attitude
quaternion. Liebe's tutorial[^liebe] is the standard accounting of what governs their accuracy;
identification algorithms in that tradition include Padgett & Kreutz-Delgado's grid method[^padgett]
and Mortari et al.'s Pyramid[^mortari], the latter also a four-star construction for the
lost-in-space case. Attitude itself is then Wahba's problem[^wahba], solved by
q-method[^davenport]/QUEST[^shuster]/SVD[^markley] — which is exactly what `StarSphere.js` does.

The differences are what make this a different problem, and they are the honest core of any novelty
argument:

| | Spacecraft star tracker | Sitrec Star Tracker |
|---|---|---|
| Optics | Known, calibrated on the ground, fixed | **Unknown**; possibly fisheye; possibly cropped off-centre; recovered from the data |
| Field content | Stars only | Stars, aircraft, satellites, drones, lasers, hot pixels, a reticle, terrain, a horizon |
| Goal | Attitude | **Which points are *not* stars**, and by how much they moved |
| Frames | Independent exposures | A video sequence to be solved jointly |
| Noise | Characterised per instrument | Estimated from the clip, robustly, in the presence of the very anomalies being sought |
| Failure cost | Degraded attitude | A false claim that something anomalous moved against the sky |

The last row is the design driver visible throughout the code. Repeatedly, a cheaper method was
rejected not because it was less accurate but because its specific failure mode was a **manufactured
mover** — greedy association (`StarSolve.js:196-207`), chained pairwise merge linkage
(`StarSolve.js:1076-1083`), unrestrained free scale (`StarMatch.js:167-172`), the flat lens model at
the frame edges (`CameraLens.js:4-11`), the classify-then-re-estimate noise loop
(`StarSolve.js:816-826`), a phantom curvature term (`StarCluster.js:126-128`). Framing the whole
pipeline as *minimising false anomaly detections rather than minimising residual* is the most
defensible way to present it as more than an assembly of known parts.

---

## 13. Candidate contributions for a paper

An honest shortlist, strongest first, each with what it would need.

### 1. The hybrid planar-proposal / spherical-verdict architecture

**The claim.** A 2D similarity chain is a good *proposal* mechanism (correspondence generation,
tracklet association, initialisation) and a bad *decision* mechanism on a wide or cropped lens; a
spherical solve is the reverse in cost and the right one for the verdict. Splitting the pipeline on
that line — and keeping the tuned planar machinery rather than replacing it — recovered 231 stars /
5 movers from 169 / 70 on the reference clip, and dropped median circle-placement error at 800–1000 px
from the optical axis from 11.35 px to 0.33 px.

**Caveats it needs.** The comparison is on two clips. The 2D and spherical classifiers do not use the
same significance statistic (§6). Two consumers — identification and clustering — are still on the
planar chart, so the architecture is not fully realised. And the strongest single number
(11.4 px for a homography vs 11.7 px for a similarity, showing that no planar model of any order
helps) is one measurement on one clip.

### 2. Self-calibration of an unknown, possibly cropped, possibly fisheye lens from a night-sky video, with a principled refusal

**The claim.** A camera that merely rotates carries enough information to recover its projection
family, focal length, principal point and a free radial polynomial — *if* the rotation moves stars
across radii. The roll degeneracy is stated explicitly and enforced (`StarCalibrate.js:619-627`); the
principal-point cost surface on cropped footage actively misleads local descent, so a gated coarse
grid search is required (`StarCalibrate.js:241-248`); and the fit is compared like-with-like on
held-out correspondences against a re-optimised rectilinear baseline, declining rather than adopting
a fit of noise.

**Caveats it needs.** This is the claim most exposed to an unsurveyed literature — radial-distortion
self-calibration from pure rotation is an active area and a proper survey has not been done. The
holdout is not fully independent (earlier search stages see all correspondences), which the user
documentation already concedes. The model is strictly radial, and a 0.42° absolute residual on one
real clip is unexplained. And "declines when it should" is demonstrated by four synthetic refusal
tests, not by a false-acceptance rate over a corpus.

### 3. Anomaly-detection-first design: every choice justified by the false positive it prevents

**The claim.** A measurement pipeline whose output is "this point moved against the sky" should be
designed around the false-alarm mode of each component, not around its residual. Six documented cases
where a cheaper, lower-residual method was rejected because its failure mode was specifically a
manufactured mover (listed in §12) make this a coherent methodological position rather than a
collection of fixes.

**Caveats it needs.** This is a design *philosophy* paper unless it comes with a false-alarm-rate
measurement over a corpus of clips. There is none. Every number quoted is a before/after on a
specific clip, which demonstrates that a bug existed but not the rate at which the fixed system errs.

### 4. A noise estimator that does not need the classification it feeds

**The claim.** Estimating astrometric noise by classify-then-re-estimate is circular in a way no
number of passes escapes: an inflated σ inflates the scatter cut that would have marked the inflating
tracks incoherent, in exactly the same proportion (`StarSolve.js:816-826`). Reading a **low quantile**
of the per-track scatter distribution estimates well-measured sources even when badly-behaved tracks
outnumber them, and needs no classification at all. With the correct Rayleigh conversion
(median / 1.1774, not 1.4826 × median — a 1.75× difference in the wrong direction) and a floor, this
gives a σ in which every threshold can be expressed.

**Caveats it needs.** The estimator is deliberately biased low, and by an unquantified amount that
depends on the population's shape. `noiseQuantile = 0.25` is not derived. The circularity argument is
stated but not proved. And the two code paths apply the constant at different levels
(across-track quantile vs pooled median), so they do not estimate the same quantity.

### 5. Falsifiable track merging

**The claim.** A merge of two tracklets asserts they are one stationary star. No threshold makes that
assertion safe, but it is *checkable*: re-classify the merged track, and if the verdict is anything
but `star`, the merge is refuted. Forbid that exact combination and its supersets, rebuild, and
re-verify — so correct sub-merges survive a refuted chimera (`StarSolve.js:1181`).

**Caveats it needs.** Small idea; probably reinvented elsewhere; no search was done. Terminates only
because each round forbids at least one combination, with a 20-round cap that abandons merging
entirely if exhausted. No measurement of how often the verification actually fires.

### 6. Blind plate solving on ground-level wide-field imagery with terrestrial clutter

**The claim.** Astrometry.net's quad method assumes an astronomical image. On a handheld twilight
frame with a treeline, integrated flux ranks lit foliage above stars because a leaf clump is *large*;
selecting quad anchors by peak SNR **and** compactness **and** local-density-relative-to-median cut
foliage anchors from 24/25 to 1/25.

**Caveats it needs.** One image. An ablation, not a benchmark. And the acceptance criterion
underneath it is a heuristic consensus gate, not astrometry.net's Bayesian odds — so the
false-positive guarantee is weaker, and only negative controls (not a rate) support it.

### 7. Bit-identical parallel refinement

**The claim.** A parallel alternating solve can be made bit-identical to its serial form for any
worker count by fixing the reduction order to a data-index order reachable from any partition, and
this was verified by hashing all outputs at full precision rather than assumed.

**Caveats it needs.** This is a reproducibility engineering result, not a research contribution. It
belongs in an implementation section.

### Not candidate contributions

For completeness, the parts that should be presented as straight implementations of prior work:
source extraction and photometry (SExtractor); triangle-invariant matching (Groth/Valdes); the
assignment-based association (Hungarian/Jonker–Volgenant); Wahba/Davenport rotation fitting; the quad
code and hypothesise-verify structure (astrometry.net); the fixed-effects shared-velocity estimator;
and the second-difference smoothness penalty as a *form* (its data weighting is the only part worth
arguing about).

---

## References

[^bertin]: E. Bertin and S. Arnouts, "SExtractor: Software for source extraction", *Astronomy and Astrophysics Supplement Series* **117**(2), 393–404, 1996. DOI: 10.1051/aas:1996164. (Full text read for this document. Note that the 1996 paper specifies **bilinear** background-mesh interpolation and the mode estimator `2.5 × median − 1.5 × mean`; secondary descriptions — including Lang et al. 2010 — sometimes say "spline-interpolated", and the textbook mode formula `3 × median − 2 × mean` is one the paper explicitly declines to use.)

[^stetson]: P. B. Stetson, "DAOPHOT: A Computer Program for Crowded-Field Stellar Photometry", *Publications of the Astronomical Society of the Pacific* **99**(613), 191–222, 1987. DOI: 10.1086/131977. (Crossref and IOP record only the first page; 191–222 is the standard span.)

[^rousseeuw]: P. J. Rousseeuw and C. Croux, "Alternatives to the Median Absolute Deviation", *Journal of the American Statistical Association* **88**(424), 1273–1283, 1993. DOI: 10.1080/01621459.1993.10476408. Cite as "see e.g.": the paper states the constant — "one usually takes MAD_n = 1.4826 med_i{|x_i − med_j x_j|}" — but its actual subject is *replacing* the MAD with the more efficient S_n and Q_n. The constant itself is simply the Fisher-consistency factor 1/Φ⁻¹(0.75) = 1.4826022185…, verified numerically here, and the MAD-as-robust-scale lineage runs back through Hampel (1974), *JASA* **69**, 383–393 — that Hampel citation is `[unverified]`.

[^rousseeuwvd]: P. J. Rousseeuw and K. Van Driessen, "Computing LTS Regression for Large Data Sets", *Data Mining and Knowledge Discovery* **12**(1), 29–45, 2006. DOI: 10.1007/s10618-005-0024-4. (The FAST-LTS "C-step" concentration iteration. An earlier technical-report version circulated from 1999; the exact prior-version citation is `[unverified]`.)

[^groth]: E. J. Groth, "A pattern-matching algorithm for two-dimensional coordinate lists", *The Astronomical Journal* **91**, 1244–1248, 1986. DOI: 10.1086/114099. (Some indexes append a bracketed annotation "[for stellar positions]"; that is not part of the title. The full text is paywalled and was not read — the descriptor parameterisation described in §2 is well attested by secondary sources but is `[unverified]` against the original.)

[^valdes]: F. G. Valdes, L. E. Campusano, J. D. Velasquez and P. B. Stetson, "FOCAS Automatic Catalog Matching Algorithms", *Publications of the Astronomical Society of the Pacific* **107**(717), 1119–1129, 1995. DOI: 10.1086/133667. (IOP gives the end page as 1129; 1119–1128 also circulates.)

[^fischler]: M. A. Fischler and R. C. Bolles, "Random Sample Consensus: A Paradigm for Model Fitting with Applications to Image Analysis and Automated Cartography", *Communications of the ACM* **24**(6), 381–395, 1981. DOI: 10.1145/358669.358692.

[^kuhn]: H. W. Kuhn, "The Hungarian method for the assignment problem", *Naval Research Logistics Quarterly* **2**(1–2), 83–97, 1955. DOI: 10.1002/nav.3800020109.

[^jv]: R. Jonker and A. Volgenant, "A shortest augmenting path algorithm for dense and sparse linear assignment problems", *Computing* **38**(4), 325–340, 1987. DOI: 10.1007/BF02278710.

[^triggs]: B. Triggs, P. F. McLauchlan, R. I. Hartley and A. W. Fitzgibbon, "Bundle Adjustment — A Modern Synthesis", in *Vision Algorithms: Theory and Practice* (International Workshop on Vision Algorithms, ICCV '99, Corfu, September 1999), Lecture Notes in Computer Science **1883**, Springer, 2000, pp. 298–372. DOI: 10.1007/3-540-44480-7_21.

[^whittaker]: E. T. Whittaker, "On a new method of graduation", *Proceedings of the Edinburgh Mathematical Society* **41**, 63–75. **Year `[unverified]`**: the volume is usually cited as 1923 but Cambridge's own record gives publication in 1922; the paper was read 1919 and amended 1925. Extended by R. Henderson (1924) into what is now called Whittaker–Henderson graduation, the penalised-difference smoother of which Sitrec's second-difference rotation prior is an instance. The Henderson citation is `[unverified]`.

[^wahba]: G. Wahba, "A Least Squares Estimate of Satellite Attitude", Problem 65-1, *SIAM Review* **7**(3), 409, 1965. DOI: 10.1137/1007077. **This is a one-page problem statement in SIAM Review's Problems and Solutions department, not a research paper** — Crossref gives the page range as 409–409. Citing it with a multi-page span is wrong.

[^farrell]: J. L. Farrell and J. C. Stuelpnagel, "Solution to Problem 65-1", *SIAM Review* **8**(3), 384–386, 1966. DOI: 10.1137/1008080. (With further solutions in the same item by R. H. Wessner, J. R. Velman and J. E. Brock. This, not Wahba 1965, is the citation for a *solution* to Wahba's problem.)

[^davenport]: P. B. Davenport, "A Vector Approach to the Algebra of Rotations with Applications", NASA Technical Note **TN D-4696**, Goddard Space Flight Center, Greenbelt MD, August 1968. (NTRS accession 19680021122 confirms author, title, report number and date, but offers no preview or abstract, **so it could not be confirmed from the primary source that the K-matrix / dominant-eigenvector construction appears in this specific report** — the attribution rests entirely on secondary sources, universal though it is. The initials are also frequently mistyped as "P. D."; NTRS gives P. B. If a paper leans on this, cite it as "Davenport (1968), as described in Shuster & Oh (1981) and Markley (1988)".)

[^shuster]: M. D. Shuster and S. D. Oh, "Three-Axis Attitude Determination from Vector Observations", *Journal of Guidance and Control* **4**(1), 70–77, January–February 1981. DOI: 10.2514/3.19717. (Introduces both TRIAD and QUEST. **The journal was titled *Journal of Guidance and Control* in 1981** and renamed *Journal of Guidance, Control, and Dynamics* in 1982; ADS and Google Scholar frequently retro-label this paper with the later name.)

[^markley]: F. L. Markley, "Attitude Determination Using Vector Observations and the Singular Value Decomposition", *The Journal of the Astronautical Sciences* **36**(3), 245–258, July–September 1988. (Confirmed against Markley's own selected-publications list. It solves Wahba's problem by SVD of the 3×3 attitude profile matrix, or equivalently by the maximum eigenvector of the 4×4 K matrix, and gives a covariance analysis. It is **not** a star-pattern-recognition paper — do not confuse it with Juang & Kim's SVD method for star pattern recognition in the same journal.)

[^hartley97]: R. I. Hartley, "Self-Calibration of Stationary Cameras", *International Journal of Computer Vision* **22**(1), 5–23, 1997. DOI: 10.1023/A:1007957826135. (Calibration of a camera fixed in location and rotated, from point matches alone.)

[^agapito]: L. de Agapito, E. Hayman and I. D. Reid, "Self-Calibration of Rotating and Zooming Cameras", *International Journal of Computer Vision* **45**(2), 107–127, 2001. DOI: 10.1023/A:1012471930694. Two cautions. (i) **Hartley is not an author of this paper.** He is an author of the related conference version, L. de Agapito, R. I. Hartley and E. Hayman, "Linear calibration of a rotating and zooming camera", *Proc. CVPR '99* — whose page range is `[unverified]`. Citing "de Agapito, Hartley and Hayman, IJCV 2001" conflates the two. (ii) The first author publishes as both "Lourdes de Agapito" (Oxford's own Active Vision page for this paper) and "Lourdes Agapito" (Crossref/Springer metadata for the *same* paper); **the exact form in the published IJCV citation is `[unverified]`**, the publisher page having refused an unauthenticated fetch.

[^hz]: R. Hartley and A. Zisserman, *Multiple View Geometry in Computer Vision*, 2nd edition, Cambridge University Press, 2004.

[^zhang]: Z. Zhang, "A Flexible New Technique for Camera Calibration", *IEEE Transactions on Pattern Analysis and Machine Intelligence* **22**(11), 1330–1334, 2000. DOI: 10.1109/34.888718.

[^conrady]: A. E. Conrady, "Decentred Lens-Systems", *Monthly Notices of the Royal Astronomical Society* **79**(5), 384–390, 1919. DOI: 10.1093/mnras/79.5.384.

[^brown66]: D. C. Brown, "Decentering Distortion of Lenses", *Photogrammetric Engineering* **32**(3), 444–462, 1966. (**This, with Conrady 1919, is the correct citation for the "Brown–Conrady" radial-plus-decentring distortion model.** The bibliographic details are attested by multiple independent citations; the article itself was not read, so its content is `[unverified]` beyond the model attribution.)

[^brown71]: D. C. Brown, "Close-Range Camera Calibration", *Photogrammetric Engineering* **37**(8), 855–866, 1971. (The close-range self-calibrating bundle adjustment / plumb-line paper — frequently but **incorrectly** cited for the distortion model itself, for which see Brown 1966. ASPRS hosts a scan; the PDF returned 403 to an unauthenticated fetch, so the bibliographic data comes from the host's own filename and multiple independent citations.)

[^kb]: J. Kannala and S. S. Brandt, "A Generic Camera Model and Calibration Method for Conventional, Wide-Angle, and Fish-Eye Lenses", *IEEE Transactions on Pattern Analysis and Machine Intelligence* **28**(8), 1335–1340, 2006. DOI: 10.1109/TPAMI.2006.153. (Full text read. Their eq. 6 is r(θ) = k₁θ + k₂θ³ + k₃θ⁵ + k₄θ⁷ + k₅θ⁹ — odd powers only, **five terms, free leading coefficient k₁**. The four-parameter form r(θ) = θ(1 + k₁θ² + k₂θ⁴ + k₃θ⁶ + k₄θ⁸) used by OpenCV's `fisheye`, ORB-SLAM3 and MATLAB's `cameraIntrinsicsKB` is a reparameterisation, **not** Kannala & Brandt's own. The full model adds two seven-parameter separable asymmetric families plus a four-parameter affine sensor map, for 23 parameters; the radially symmetric reduction has 9. Sitrec's `custom` lens is the same odd-polynomial family in the inverse direction, θ(ρ), with three terms, the leading coefficient pinned to 1, and no asymmetric terms.)

[^lang]: D. Lang, D. W. Hogg, K. Mierle, M. Blanton and S. Roweis, "Astrometry.net: Blind Astrometric Calibration of Arbitrary Astronomical Images", *The Astronomical Journal* **139**(5), 1782–1800, 2010. arXiv:0910.2233 [astro-ph.IM]. DOI: 10.1088/0004-6256/139/5/1782. (Full text read; the quad-code description and symmetry-breaking conditions in §8 are quoted from §2.2.)

[^padgett]: C. Padgett and K. Kreutz-Delgado, "A grid algorithm for autonomous star identification", *IEEE Transactions on Aerospace and Electronic Systems* **33**(1), 202–213, January 1997.

[^mortari]: D. Mortari, M. A. Samaan, C. Bruccoleri and J. L. Junkins, "The Pyramid Star Identification Technique", *NAVIGATION: Journal of The Institute of Navigation* **51**(3), 171–183, 2004. DOI: 10.1002/j.2161-4296.2004.tb00349.x. (Crossref gives 171–183; 171–184 also circulates. **It is in NAVIGATION, not the *Journal of the Astronautical Sciences***, which is a common misattribution. Uses the k-vector range-searching technique on the catalogue plus a four-star "pyramid" confirmation structure for the lost-in-space case.)

[^liebe]: C. C. Liebe, "Accuracy performance of star trackers — a tutorial", *IEEE Transactions on Aerospace and Electronic Systems* **38**(2), 587–599, April 2002. DOI: 10.1109/TAES.2002.1008988. (Crossref confirms 587–599; a widely copied "587–589" is a typo. Not to be confused with the same author's earlier C. C. Liebe, "Star trackers for attitude determination", *IEEE Aerospace and Electronic Systems **Magazine*** **10**(6), 10–16, 1995, DOI: 10.1109/62.387971 — a different paper in a different publication.)

[^shen]: Y. Shen and Q. Wang, "Sky Region Detection in a Single Image for Autonomous Ground Robot Navigation", *International Journal of Advanced Robotic Systems* **10**(10), article **362**, 2013. DOI: 10.5772/56884. (Published by InTech, now hosted by SAGE; it has an article number, not a page range. Greyscale conversion then Sobel gradient magnitude for the border; a per-column sky border position function b(x); a gradient threshold t selected by 1-D scan over [5, 600] step 5 maximising J_n = 1/(γ|Σ_s| + |Σ_g| + γ|λ₁ˢ| + |λ₁ᵍ|) with γ = 2 over the **RGB covariance matrices** of the sky and ground regions; k-means/Mahalanobis post-processing for the no-sky and extruding-object cases, with thresholds H/30, H/4, 5 and H/3. The paper explicitly states that it "implicitly assumes that there are sky region pixels in every column". Quoted content verified against the paper text via a reference implementation and secondary descriptions; the SAGE full text refused an unauthenticated fetch, so exact equation numbering is `[unverified]`.)

[^ettinger]: S. M. Ettinger, M. C. Nechyba, P. G. Ifju and M. Waszak, "Vision-guided flight stability and control for micro air vehicles", *Proc. IEEE/RSJ International Conference on Intelligent Robots and Systems (IROS 2002)*, pp. 2134–2140. (The source of the covariance-based sky/ground energy function that Shen & Wang modify; constrains the horizon to a straight line.)

[^sobel]: The Sobel operator has no primary publication, and this should be stated rather than papered over. It originates in an **unpublished 1968 talk** by Irwin Sobel and Gary Feldman at the Stanford Artificial Intelligence Project, "A 3×3 Isotropic Gradient Operator for Image Processing". Its first appearance in print is a footnote credit — "suggested by I. Sobel" — in R. O. Duda and P. E. Hart, *Pattern Classification and Scene Analysis*, Wiley, New York, **1973**, pp. 271–272. (A frequent citation error attaches the 1968 date to the book; the book is 1973 and the 1968 date belongs only to the talk.) Sobel confirmed this history in a 2014 note, "History and Definition of the so-called 'Sobel Operator', more appropriately named the Sobel–Feldman Operator", and published a later formal treatment as I. Sobel, "An Isotropic 3×3 Image Gradient Operator", in H. Freeman (ed.), *Machine Vision for Three-Dimensional Scenes*, Academic Press, 1990. Because Feldman is a co-originator, "Sobel–Feldman operator" is the more accurate name. **Do not invent a journal reference for this.**

[^liba]: O. Liba, L. Cai, Y.-T. Tsai, E. Eban, Y. Movshovitz-Attias, Y. Pritch, H. Chen and J. T. Barron, "Sky Optimization: Semantically aware image processing of skies in low-light photography", *Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR) Workshops*, 2020, pp. 2230–2238. DOI: 10.1109/CVPRW50498.2020.00271. arXiv:2006.10172. **The author order is `[unverified]`**: arXiv, the Google project page and Semantic Scholar give the order above, while IEEE Xplore, Crossref and DBLP permute positions 2–7 (Liba, Movshovitz-Attias, Cai, Pritch, Tsai, Chen, Eban, Barron). Same eight people; first and last agree. The arXiv order is used here because three independent author-controlled sources agree on it, but the CVF proceedings PDF refused an unauthenticated fetch and the conflict is unresolved.

[^hipparcos]: ESA, *The Hipparcos and Tycho Catalogues*, ESA Special Publication **SP-1200** (17 volumes), ESA Publications Division, Noordwijk, 1997. ISBN 978-92-9092-399-2. Summary paper: M. A. C. Perryman, L. Lindegren, J. Kovalevsky et al., "The HIPPARCOS Catalogue", *Astronomy & Astrophysics* **323**, L49–L52, 1997. (The catalogue Sitrec actually ships and identifies against — see §8. For modern astrometric work the relevant reference is instead F. van Leeuwen, "Validation of the new Hipparcos reduction", *Astronomy & Astrophysics* **474**(2), 653–664, 2007; Sitrec's repacked file is not that reduction.)

[^bsc]: D. Hoffleit and W. H. Warren Jr., *The Bright Star Catalogue*, 5th Revised Edition, Yale University Observatory, New Haven, 1991; machine-readable form VizieR catalogue **V/50**, ADS bibcode 1995yCat.5050....0H. 9,110 entries (9,096 stars), nominally complete to V ≈ 6.5. (The 5th edition was distributed as a *preliminary* machine-readable version superseding the 1982 4th edition; there was no conventional printed 5th edition. Cited here for completeness because Sitrec's user documentation and its `BSC5` file-manager key both name this catalogue — but the shipped binary is Hipparcos-derived, not BSC5.)

[^iaucsn]: IAU Division C Working Group on Star Names (WGSN), *IAU Catalog of Star Names (IAU-CSN)*, edition of 2022-04-04, shipped as `data/nightsky/IAU-CSN.txt`. <https://www.iau.org/public/themes/naming_stars/>

---

## Appendix: source-file index

| Concept | File | Anchor |
|---|---|---|
| Background mesh, σ-clipped median, MAD × 1.4826 | `StarDetect.js` | `estimateBackground` :120, :151 |
| Matched filter (detection only) | `StarDetect.js` | `gaussianBlur` :190, use at :292 |
| Flood-fill segmentation | `StarDetect.js` | :413–422 |
| Peak counting / blend rejection | `StarDetect.js` | `countPeaks` :230, `rejectReason` :651 |
| Aperture photometry + sky annulus | `StarDetect.js` | :537–618 |
| PSF-driven parameter self-scaling | `StarDetect.js` | `calibrateDetection` :702 |
| Unit-scale complex similarity, closed form | `StarMatch.js` | `weightedSimilarity` :181, :205 |
| Trimmed LS, annealed, fixed point | `StarMatch.js` | `fitSimilarity` :228, :319 |
| Triangle invariants | `StarMatch.js` | `buildTriangles` :473, `triangleMatch` :518 |
| Offset (pose) voting | `StarMatch.js` | `matchByOffsetVote` :608 |
| Matcher arbitration by inlier count | `StarMatch.js` | :818 |
| Camera-fixed artifact detection | `StarMatch.js` | `findCameraFixed` :701 |
| Exact assignment (Jonker–Volgenant) | `StarSolve.js` | `assignMinCost` :274 |
| Tracklet association in reference frame | `StarSolve.js` | `buildTracklets` :149 |
| Alternating global refinement (planar) | `StarSolve.js` | `refineGlobal` :452, gauge :510 |
| Curvature-weighted 2nd-difference rotation prior | `StarSolve.js` | `applySmoothedTransforms` :578, `solveBanded2` :670 |
| Noise estimation, Rayleigh 1.1774 | `StarSolve.js` | `estimateNoise` :743, :838 |
| Classification thresholds | `StarSolve.js` | `classifyAtNoise` :868, :956–961 |
| Falsifiable track merging | `StarSolve.js` | `mergeSplitStarTracks` :1055, `mergeAndVerify` :1181 |
| Wahba / Davenport q-method | `StarSphere.js` | `fitRotationWahba` :244, convention note :264 |
| Pixel-domain Gauss–Newton on SO(3) | `StarSphere.js` | `refineRotationPixels` :281 |
| Robust rotation, median seed | `StarSphere.js` | `fitRotationRobust` :369, :387 |
| Alternating global refinement (spherical) | `StarSolveSphere.js` | `refineGlobalSpherical` :770, `applyGauge` :637 |
| 2-DOF drift significance | `StarSolveSphere.js` | `classifyTracksSpherical` :878, :971 |
| Gnomonic chart for identification | `StarSolveSphere.js` | `gnomonicChart` :331 |
| Deterministic worker pool | `StarSphereSolvePool.js` | :20–33, `scatter` :169 |
| Lens presets + custom odd polynomial | `CameraLens.js` | `LENS_PRESETS` :41, custom :95 |
| Baseline choice, focal scan, principal search | `StarCalibrate.js` | :111, :190, :259 |
| Free-shape refinement + holdout | `StarCalibrate.js` | `refineCustom` :359 |
| Acceptance gate incl. roll degeneracy | `StarCalibrate.js` | :610–754, roll :619 |
| Radial excitation test | `StarCalibrate.js` | `radialExcitation` :504 |
| Astrometry.net quad code | `StarIdentify.js` | `quadCode` :262 |
| Runtime quad index, tiers | `StarIdentify.js` | `buildQuadIndex` :321, tiers :32 |
| Point-source anchor selection | `StarIdentify.js` | :579–636 |
| Tangent-point re-centring | `StarIdentify.js` | `verifyHypothesis` :922 |
| Consensus acceptance | `StarIdentify.js` | `consensusMet` :887 |
| Fixed-effects shared motion + F-test | `StarCluster.js` | `sharedMotionModel` :132, :200 |
| Cluster gates, light resolution | `StarCluster.js` | :340–342, `sameLight` :385 |
| Pipeline orchestration | `StarTrackerUI.js` | :1167, :1226, :1230, :1274, :1306, :1424; identify :858, :917 |
