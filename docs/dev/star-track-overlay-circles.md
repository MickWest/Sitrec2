# Star Track: the overlay circles are still placed by the flat 2D model

Status: **open, one attempt made and reverted, and the obvious explanations have been checked and
ruled out.** This was section 7 of the worker handoff, which is otherwise done — see the last
section for what landed there, since it changes what tooling is available for investigating this.

## The symptom

`drawOverlay` (`StarTrackerUI.js`, the `applyTransform(T, rx, ry)` line) places every circle by
mapping the 2D reference-chart position through the per-frame 2D similarity — the very model whose
frame-edge bias the spherical solve exists to correct.

On the cropped clip (`?custom=99999999/Cropped Starlink Timelapse/20260802_212450.js`), whose
optical axis sits at x=953 of 1280, stars on the LEFT (up to 953 px off axis) visibly drift out of
their circles while those on the RIGHT (~330 px off axis) stay centred. User-reported, and the
asymmetry matches the axis position exactly.

## What has been ruled out

An attempt to fix it by projecting `t.ref` through `lensInfo.states[i]` with `refToFrame` put
circles far outside the video frame and was REVERTED. The reason is not yet known, but two
plausible explanations have been checked and are WRONG:

- **"`t.ref` holds pre-refinement directions."** It does not. `refineGlobalSpherical` writes the
  refined directions back, and there is now a test pinning that write-back
  (`tests/StarSphereSolveParallel.test.js`, "including the ref write-back").
- **"The frame indexing is off by the window start."** It is not.
  `i = round(par.frame) - result.frame0` matches both `transforms[i]` and `states[i]`.

## Where to start

Do not re-derive from the whole overlay. Take a SINGLE known track, at a late frame, and compare
three numbers: its detected pixel position, `applyTransform(T, rx, ry)`, and
`refToFrame(states[i], lens, t.ref, size)`. Whichever of the last two is wrong, and by how much and
in what direction, is the answer. That the projection failed "far outside the frame" suggests a
frame-of-reference or gauge difference rather than a small bias, so look there first.

Note the gauge: `refineGlobalSpherical` re-pins the first solved frame to the identity after every
iteration, so the map's coordinates are "frame 0's camera frame" — not the reference chart's, and
not the sky's.

## Reference material

- Clips: the cropped one above, and `?custom=99999999/Rotating Starfield issue/20260801_233530.js`
  (uncropped, 118 frames — the regression case that must not change).
- Fixtures: `tests/fixtures/croppedStarlinkClip.json` (baseline correspondences plus a known
  optical axis), `tests/fixtures/rotatingStarfieldMap.json`,
  `tests/fixtures/rotatingStarfieldPairs.txt`.
- Wider star-track context and the identification work: `docs/dev/star-identify-edge-stars.md`.

## The worker migration, which is done

Recorded here because it changes how this clip behaves under investigation: the analysis no longer
blocks the page, so `sitrec_eval` answers during a run instead of timing out.

`refineGlobalSpherical` was ~121 s of a ~150 s run on the cropped clip. It now runs across a worker
pool (`StarSphereSolvePool.js`, `src/workers/StarSphereWorker.js`):

| stage | before | after |
| --- | --- | --- |
| `refineGlobalSpherical#1` | 66.0 s | 5.0 s |
| `refineGlobalSpherical#2` | 55.0 s | 5.3 s |
| whole analysis, wall clock | 159 s | ~75 s |
| page responsive during the solve | no | yes |

Three things worth knowing before touching it:

- **The measured phase split is why both halves are parallel.** The per-frame orientation fit is
  65–76% of the time and splits across FRAMES; the per-track direction update and residual sum are
  the other ~30% and split across TRACKS. Parallelising only the orientation fit — the obvious
  choice, since it is the single biggest term — caps out at 2.6x on eight cores.
- **The result is bit-identical, and that was verified end to end rather than assumed.** On the
  cropped clip the before and after builds produce the same FNV hash of all 160 per-frame
  quaternions and all 2531 track directions at full double precision (`8286b6bc`), and the same
  classification counts. The one exception is `rms`, which moves by ~1e-15 because the cost is now
  summed as per-track partials in track index order — an order reachable from any worker count,
  which the flat running total was not.
- **Both passes CONVERGE** (8 and 9 iterations of a possible 12), so there is nothing free to save
  by lowering `refineIterations`.

The worker uses `new Worker(new URL(..., import.meta.url))`, which webpack bundles into its own
chunk in all four build modes. The handoff's claim that an inline Blob worker was the only option
was out of date — `ScriptRunnerWorker`, `ELAWorker`, `NoiseWorker` and `AudioSpectrumWorker`
already ship this way, and it is what lets the worker import the real kernels instead of carrying
a second copy of the maths.
