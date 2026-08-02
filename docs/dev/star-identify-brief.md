# Why the edge stars are circled but not named

## What ships today (all committed, verified live on the reference clip)

Clip: `?custom=99999999/Rotating Starfield issue/20260801_233530.js` - a ~90 deg IR monocular
timelapse, sky rotating 3.28 deg about a pole just past the top-right corner, horizon in frame.

Star Track used to model frame-to-frame sky motion as a 2D similarity in pixel space. On this lens
that is biased at the frame edges, and the bias was reported as motion: 70 real stars called
"moving". Commits ad6e4523 / 854f871a added a lens model (`CameraLens.js`), a spherical solve
(`StarSphere.js`, `StarSolveSphere.js`) and self-calibration (`StarCalibrate.js`).

Live result now: **231 star / 5 moving** (was 169 / 70). Green circles out to the frame edges.
Fitted lens `custom`, f=815, d=[0.0849, -0.0886, 0.2038], 96 deg hFOV, self-consistency rms 0.15 px.

## The remaining problem

Only ~68 stars get NAMES. The ~60 edge stars the fix recovered are circled but unnamed.

That is deliberate, and currently load-bearing. In `StarTrackerUI.identifyStars` the input is:

```js
.filter((c) => (c.klass2D ?? c.klass) === "star" && c.position && ...)
.map((c) => ({x: c.position[0], y: c.position[1], mag: c.magnitude, index: c.index}));
```

- `klass2D` is the ORIGINAL 2D classification, preserved before the spherical pass overwrites
  `klass`. So identify sees the old 169-star set, not the improved 231.
- `c.position` is the 2D similarity reference chart, not the spherical map.

## Why it was decoupled - two measured failures, not a guess

1. **Improved star set + 2D chart** -> identify FAILS outright: "refinement lost the match
   consensus". The ~60 extra stars are exactly the edge ones, whose 2D chart positions carry the
   ~10 px warp that caused the original bug.

2. **Improved star set + gnomonic chart built from the spherical map** -> also fails. And measured
   against catalogue geometry (best-fit similarity from chart positions to true gnomonic positions
   of the 68 identified stars, both parities tried):

   | chart | rms vs catalogue |
   |---|---|
   | existing 2D reference chart | **0.227 deg** |
   | gnomonic chart from spherical map (preset lens) | 0.444 deg |
   | gnomonic chart from spherical map (custom polynomial lens) | 0.423 deg |

   So the spherical chart is ~2x WORSE in absolute terms, and fitting a free lens polynomial
   barely moved it (0.444 -> 0.423) even though it clearly improved self-consistency
   (0.25 -> 0.15 px) and classification (7 -> 5 movers).

## The key distinction this turned up

**Self-consistency is not absolute accuracy.** The spherical solve reproduces its own observations
to 0.15 px while placing recovered sky directions ~0.42 deg out. A slightly wrong lens shape plus
compensating per-frame rotations fits the data. Classification only needs relative consistency,
which is why it works. Identification needs absolute geometry, which is why it does not.

A CI gate for this exists (`tests/StarCalibrate.test.js`, "absolute sky accuracy" block): on
synthetic scenes with a lens that is deliberately not a named preset, the free polynomial DOES
clear it (absolute error < 0.15 deg). It passes synthetically and fails on the real clip, which
says the gap is not lens SHAPE.

## Candidate explanations for the real-clip gap (untested)

- **Atmospheric refraction.** The clip includes the horizon. Refraction is ~0.5 deg at the horizon,
  falling off fast with altitude - the same scale as the 0.42 deg residual, and something no
  radially symmetric lens can absorb. It would also barely hurt self-consistency, since it is a
  smooth field the per-frame rotations partly absorb.
- **Lens decentring / non-radial distortion** - the model is strictly radial about a fitted
  principal point.
- **Rolling shutter or EIS** in the source.

## Identify internals that constrain any fix

- `quadCode` (StarIdentify.js:252) is a planar-similarity quad code: squared Euclidean distances
  plus a complex affine frame `z = (P-A)/(B-A)`.
- `solveField` (StarIdentify.js:446) assumes a gnomonic similarity field.
- Both parities are searched (mirroring is handled).
- On this clip it currently solves: fovDeg 91.6, matchedFraction 0.496, mirrored false, 68 matched.
  0.496 sits right on the documented ~47% cap attributed to "intrinsic gnomonic warp".
- There is a "strong absolute count" acceptance path, with negative controls in the tests (a dense
  random field must still be refused).

## The question

How should the ~60 recovered edge stars get named, in a way that generalises across clips - wide
and narrow lenses, videos and single still images - given that:

- the 2D chart is more accurate in absolute terms but is warped at the edges and breaks consensus
  when the edge stars are added;
- the spherical map covers every star correctly in RELATIVE terms but is 0.42 deg out absolutely
  on this clip;
- identify's matcher and verifier both assume a planar-similarity / gnomonic field.

One idea not yet tried or reviewed: keep the existing identify SOLVE as-is (it succeeds, and yields
`refToSky`), then run a second EXTENSION pass - fit the transform between the spherical map's
directions and celestial coordinates using the already-identified stars, then predict and match the
remaining detections against the catalogue with a tolerance derived from that fit's own residual.
This never re-solves blind, so it cannot lose consensus; the question is whether it can be made
safe against false identifications in dense fields.
