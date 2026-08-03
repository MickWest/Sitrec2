# Star Track: where the spherical solve is used, and where the flat 2D model still is

Status: **the overlay circles are FIXED.** Two deliberate 2D holdouts remain, listed at the end.
This file began as section 7 of the worker handoff; the worker migration is done and recorded
below because its measurements are the reason the rest of this is reproducible.

## The overlay circles (fixed)

The symptom: on the cropped clip (`?custom=99999999/Cropped Starlink Timelapse/20260802_212450.js`),
whose fitted optical axis sits at x=941 of 1280, stars on the LEFT drifted out of their green
circles while those on the RIGHT stayed centred. User-reported, and the asymmetry matched the axis
position exactly.

The cause was that `drawStarTrackerOverlay` placed every circle with `applyTransform(T, rx, ry)` —
the per-frame **2D similarity** from the 2D chain. That is four degrees of freedom: one rotation,
one uniform scale, one shift. It moves the whole field of circles rigidly and cannot bend. A wide
lens bends: theta(rho) is nonlinear (this clip fits theta = rho(1 - 0.31 rho^2 + 0.10 rho^4)), so
one sky rotation moves an edge star a different number of PIXELS than a centre star. A similarity
has one scale for the whole image, so it can only be right at one radius and its error grows
outward from the optical axis.

Measured at frame 84 over 231 observed stars, median pixel error against the actual detections:

| distance from optical axis | 0–200 | 200–400 | 400–600 | 600–800 | 800–1000 |
| --- | --- | --- | --- | --- | --- |
| placed by the 2D similarity | 0.30 | 0.39 | 3.10 | 7.42 | 11.35 |
| placed on the sphere | 0.17 | 0.19 | 0.23 | 0.17 | 0.33 |

Worst case 23.7 px against 0.89 px, on circles of radius 6–24 px — so out at the edge the old
placement missed by a full circle width. Adding degrees of freedom does not rescue a planar model:
a homography (8 dof) measured 11.4 px against the similarity's 11.7, because `K R K^-1` models
perspective and radial compression is not a projective map.

**The fix** places stars from their own settled direction through that frame's solved orientation,
`refToFrame(states[i], lens, t.ref, [videoW, videoH])`, whenever the lens was fitted, keeping the
2D chart as the fallback for runs where it was not. Movers hop on the sphere instead —
`framePixelToFrame(states[o.f], states[i], ...)` on the nearest observation — because a mover's
`ref` is one settled direction and using it would pin the marker still, which is exactly the
motion the red circle exists to show. After the fix: all 882 stars placed spherically, none
skipped, median error 0.21 px and worst 1.0 px.

**A note for whoever reads the git history.** An earlier attempt at this was reverted because it
put circles far outside the frame, and the reason was recorded as unknown. It was not the
approach: that exact projection lands sub-pixel on every star. It must have been an
implementation slip — the likely candidates being the wrong `size` (it has to be the ANALYSED
decode size, `result.videoW/H`, not the view or source size, or `lensScaleFor` rescales
everything about the principal point), or passing `lensInfo.chart[i]`, a 2D gnomonic position,
where a 3-vector direction was wanted.

## Still on the 2D model, deliberately

- **Star identification.** `identifyStars` consumes the 2D reference chart and is calibrated
  against the star set that chart produced. Handing it the ~60 recovered edge stars broke its
  match consensus — measured: identify succeeded before and failed after. Migrating it to the
  spherical map is real work, and `gnomonicChart` exists for when someone does it.
- **Light clusters.** A cluster's motion model lives in reference-chart coordinates and there is
  no chart-to-direction map to carry it onto the sphere; the chart is a chain of similarities, not
  a projection of one. The inherited edge error is small against a ring whose radius is the
  formation's own extent (>= 20 px), so it is a real limitation but not a visible one.

## Reference material

- Clips: the cropped one above, and `?custom=99999999/Rotating Starfield issue/20260801_233530.js`
  (uncropped, 118 frames — the regression case that must not change; gives 231 star / 5 moving).
- Fixtures: `tests/fixtures/croppedStarlinkClip.json`, `tests/fixtures/rotatingStarfieldMap.json`,
  `tests/fixtures/rotatingStarfieldPairs.txt`.
- Wider star-track context and the identification work: `docs/dev/star-identify-edge-stars.md`.

## The worker migration

`refineGlobalSpherical` was ~121 s of a ~150 s run on the cropped clip. It now runs across a worker
pool (`StarSphereSolvePool.js`, `src/workers/StarSphereWorker.js`):

| stage | before | after |
| --- | --- | --- |
| `refineGlobalSpherical#1` | 66.0 s | 4.8 s |
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
