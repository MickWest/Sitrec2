# Doing Defensible Analysis in Sitrec

This is a guide to reaching a conclusion that will survive scrutiny — and to writing it up so
that someone who disagrees with you can check it rather than merely dispute it.

It is written for anyone who intends to *publish*: a forum post, a video, a report. If you
are just exploring, you do not need it. If your result is going to be read by people who
would like it to be wrong, you do.

**The one-paragraph version.** Sitrec is a hypothesis-testing instrument, not a measuring
instrument. It answers *"is this interpretation consistent with these sightlines, and what
would the object have to have been doing?"* It does not answer *"what was it?"* or *"how fast
was it going?"*, because bearings alone cannot answer those. If you publish a single number
without the assumption attached to it, you have almost certainly published the assumption.

---

## 1. The fundamental limitation: bearings do not determine range

A camera measures direction. It does not measure distance.

Write the sensor's position over time as **S**(t) and the direction it observed as **D**(t).
Then for *any* range profile *R*(t) you care to invent, the path

```
P(t) = S(t) + R(t) · D(t)
```

reproduces every observed sightline **exactly**. Not approximately — exactly. There are
infinitely many such paths, and they include a moth 30 cm from the lens and a 300-metre object
50 km away, both fitting the data perfectly.

This has a consequence that catches people out constantly:

> **A traverse that threads every line of sight perfectly is not evidence of anything.**

Screenshotting the blue traverse lying exactly along the red rays and captioning it "the
reconstruction matches the data" is showing your reader an identity, not a result.

### What *does* determine range: parallax

Range becomes observable when the sensor moves **around** the sightlines rather than along
them — when the geometry changes enough that only one distance can explain the whole
sequence. A stationary camera gives no parallax at all. A camera flying straight toward or
alongside the target gives very little. Straight-and-level cruise, which is what most military
pod footage is, is close to the worst case.

On those scenes the fits will still return an answer, with a small residual, and it will be
meaningless. This is not a bug — it is what "underdetermined" looks like from inside an
optimiser.

### The conditioning diagnostic

Sitrec measures this directly. The constant-velocity family reports a **fit conditioning**
number (an `rcond`), and the *Fit Diagnostics* panel tells you when the geometry is too weak
to pin range. Measured against known-truth benchmark data, the constant-velocity fit collapses
onto the sensor in the large majority of cases once conditioning is bad.

Two honest limits on that diagnostic, both worth remembering:

- It speaks for the **constant-velocity family only** — CV, CA, and anything seeded from them
  (the Kalman smoother and both Monte Carlo methods are seeded from CV).
- It is a **one-way** warning. Bad conditioning means the range is not determined. Good
  conditioning does **not** prove the range is right.

> **DO** check Fit Diagnostics before quoting any range from a CV-family method.
> **DON'T** read "conditioning good" as "the range is correct".

---

## 2. Before you fit: auditing your inputs

Every item in this section is a multiplier on everything downstream. Work through them in
order; a mistake here cannot be recovered by a better fit later.

### 2.1 Time

Time is what ties your scene to the sun, the stars, the satellites and the air traffic. State
how you synced it and to what precision. A satellite match that requires the time to be right
to ±2 s is worthless if your time is only good to ±30 s.

See [Getting Started](CustomSitchTool.md) for Start Time vs Now Time, and remember that
Sitrec's clock is UTC even when the UI is showing you local time.

### 2.2 Camera position

Was it a track, or a guess? If a track — which datum (§2.4)? If a guess, how tightly is it
constrained? Say which.

### 2.3 Field of view — the silent scale factor

This is the input most likely to be wrong and least likely to be reported.

When your line of sight comes from a tracked pixel in the video — Point Track, the manual
tracking overlay, or motion tracking — Sitrec converts a pixel offset into an angle using the
assumed vertical field of view. **The FOV is therefore a multiplicative scale factor on every
off-boresight angle you measure.** A 10 % FOV error is roughly a 10 % error in every angular
rate, and it propagates straight into range, speed and acceleration. (Strictly the conversion
runs through a tangent and an arctangent, so the proportionality is a small-angle
approximation — good near the frame centre, less so at the edges.)

Two further traps:

- The conversion assumes a **rectilinear (pinhole) lens**. Real wide lenses bend. A rigid
  model can only be correct at one distance from the optical axis, and the error grows
  outward — so an object near the frame edge is worse than one near the centre.
- A **cropped** video has its optical axis off centre, which the simple model does not know.

Only a plain boresight line of sight — camera-centre pointing with no pixel offset — is
independent of FOV.

**How to do better: measure it instead of guessing it.** If there are stars in the footage,
the [Star Tracker](StarTracker.md) will fit the actual focal length, optical-axis position and
lens curve from the star field, and *Sync Camera to Star Field* will apply it. Failing that,
use a landmark of known angular size, or the manufacturer's specification with a stated
tolerance.

> **DO** state your FOV, where it came from, and a ± on it.
> **DON'T** nudge the FOV until the picture looks right and then derive physics from it.

### 2.4 Altitude datum

Height above the ellipsoid (HAE), height above the geoid (MSL), barometric pressure altitude
and height above ground (AGL) are four different things that all get called "altitude". Mixing
them shifts a track vertically — by 20–40 m in the continental US for a geoid mistake, and by
thousands of feet at cruise for a pressure-altitude mistake.

[GIS, Geodesy and Altitude](GIS.md) has the full treatment, a table of geoid values by city,
and — most usefully — a table for **recognising which mistake you have made from the shape of
the error**. Read that section before you trust any altitude.

Two Sitrec-specific traps:

- The **altitude lock**, with *Alt Lock AGL* off, is **HAE**, not MSL.
- An **Alt offset** applied by eye to make a track "look right" invalidates every
  altitude-derived claim from that track. Diagnose the datum instead.

### 2.5 The bad-data filter is a physical prior

Sitrec's bad-data filter removes points that would require more than *Max G* of acceleration,
on the premise that such accelerations are measurement error. For airliner ADS-B that is a
safe premise. **In a UAP investigation it is the hypothesis under test.**

Sitrec will offer to enable it for you when a track loads with a high maximum g. Accepting
that prompt quietly answers the question you were asking. (Under MCP or regression automation
the same check enables the filter *without* asking — so a scripted run that imports a
high-g track gets filtered silently, with no prompt in the transcript to tell you it
happened.)

> **DO** run with the filter off first, then report the threshold, the number of points
> removed, and what changes.
> **DON'T** accept the prompt in an investigation about acceleration.

### 2.6 Smoothing attenuates the thing you are measuring

Smoothing is a low-pass filter on position, and the first thing it removes is acceleration —
which is usually the quantity in question. Smoothing the *camera* track is worse still,
because it changes the sightlines themselves and therefore every fit downstream.

> **DO** report the smoothing method and window, and show the raw result alongside.
> **DON'T** quote a g-figure from a smoothed track alone. See [Tracks](Tracks.md).

### 2.7 Wind

Which source, at which altitude, measured or manual? In any airspeed-based traverse, wind
error and range error are **confounded** — you cannot separate them from sightlines alone.
Note also that wind data is re-fetched rather than archived, so a sitch reopened months later
may be fitted against different wind.

### 2.8 Is your line of sight circular?

If the camera heading is set to *To Target* and the line of sight is the raw camera centre,
then the sightlines were **constructed from the object you are testing**. Any fit will recover
it, by construction. That is a check of internal consistency, not evidence about the object.
Sitrec detects this and says so — but it is easy to build such a scene by following the
getting-started guide without realising.

---

## 3. Choosing a method

The useful taxonomy is not sequential-versus-global. It is what kind of statement the method
produces:

| If your question is… | Use… | and the answer is a… |
|---|---|---|
| Could the geometry allow this? | the compatibility screens (constant altitude, constant speed, straight line) | **compatibility statement** |
| Would a real physical object of type X do this? | the physics models (balloon, sky lantern, fixed wing, quadcopter) | **compatibility statement about a model** |
| What is the slowest / nearest / most sedate thing this could be? | Minimum Speed, Stationary Point, Ground Object | **bound** |
| What does the geometry alone say, if anything? | Constant Velocity + Fit Diagnostics | **estimate, if and only if conditioning is good** |

Every method's assumptions and its "does not establish" column are in
[Traverse Methods](TraverseMethods.md).

**Never use one method.** The information is in the *disagreement* between methods. If
constant-velocity, minimum-acceleration and a physics fit all land on a similar range, that is
a result. If they scatter across two orders of magnitude, that is also a result — it tells you
the range is not determined, which is a perfectly publishable finding.

---

## 4. Sanity checks to run before believing anything

1. **Fit Diagnostics** — conditioning, and whether the solution sits on or behind the camera.
2. **Degeneracy check** — constant velocity with 2 frames and constant acceleration with 3
   fit *exactly*, whatever the truth. A perfect fit on a short window means nothing.
3. **Does the solution go underground?** Sitrec always checks this; take it seriously.
4. **Does the traverse leave the frame, or cross behind the sensor?**
5. **Did anything hit a search bound?** A result sitting on a bound is a bound, not a result.
6. **Does the answer move when you widen Min/Max Dist?** If yes, the limits are choosing your
   answer.
7. **Does the answer survive the sensitivity sweeps in §6?**
8. **Does an independent object land where it should?** Another aircraft in frame, a star, a
   ridgeline, a building. This is the single strongest external check available and it is
   badly underused.
9. **Do the methods agree?** If not — which is conditioned on what?

---

## 5. What a fit does and does not license

**A good fit is a compatibility statement, not an identification.** When the sky-lantern model
reproduces your sightlines, what you have learned is that the sightlines are compatible with
that particular wind-tracer model. You have not learned the probability that the object was a
lantern.

**Residuals from different models are not comparable.** Different models have different
numbers of free parameters, different priors and different bounds. The one with the smaller
residual is not thereby the more likely explanation.

**Gallery position is a screening order, not a probability.** Sitrec deliberately does not
compute cross-category object probabilities, and says so.

**A good fit describing extraordinary motion is still a good fit.** If the best-fitting
solution requires 12 g, Sitrec badges it as an excellent fit to extraordinary motion rather
than hiding it. This matters in both directions: it is how a genuine anomaly stays visible
instead of being explained away, and it is why "it fits" is not the same as "it is ordinary".

**Ruling OUT is much harder than ruling in, and Sitrec cannot currently do it.** There is no
calibrated sightline noise floor and no exhaustive envelope search, so there is no exclusion
certificate. A physics fit that hits a parameter bound makes that test *incomplete*; it does
not exclude every possible aircraft.

So:

- You may say **"consistent with"**.
- You may say **"requires X g at Y range"**.
- You may **not** say **"ruled out"**.

**What Sitrec has no model for at all.** The analysis discloses this list explicitly, and any
"does not match any tested model" statement is meaningless without it:

- birds and insects
- airborne debris
- helicopters and rockets
- reflections, glare, and bokeh
- video-processing artefacts

---

## 6. Uncertainty: what to do when you cannot compute an error bar

Sitrec **deliberately declines** to quantify uncertainty, and is explicit about why: the
sightline noise floor is not calibrated, the scores are not posterior probabilities, and the
reference residual is a model reference rather than an estimate of sensor noise.

That is honest. It also leaves a gap, and the gap gets filled with the wrong thing. These four
inversions are all tempting and all invalid:

| Do not quote | Why not |
|---|---|
| The **Kalman covariance** as an error bar | Its noise parameters are tuning knobs, not calibrated variances |
| The **spread of Monte Carlo trials** | MC keeps the *best* trial; the spread reflects your guessed LOS uncertainty, not the data |
| The **solution-family band** as "the range uncertainty" | It is conditional on one model, and its edges are where sampling changed answer |
| The **residual** as a goodness-of-truth measure | It tells you how well a model fits, not whether the range is right |

### The sanctioned substitute: documented sensitivity sweeps

Report a **family and its stability**, not a number ± a number. Sitrec already supports every
ingredient:

- **Range** — turn on *Solution families (range bands)* (off by default) and report the
  admitted band, its rung count, any gaps, and whether it hit the bracket edge.
- **Pointing noise** — sweep the Kalman process noise across its useful range. Real operator
  wobble is autocorrelated, not white, and degrades the CV fit substantially more than
  matched-power white noise would; the sweep takes about a minute.
- **Smoothing** — raw versus smoothed (§2.6).
- **Bad-data filter** — on versus off, with counts (§2.5).
- **Field of view** — ±10 %, and a star-measured value if stars are available (§2.3).
- **Altitude datum** — the alternative datum interpretation (§2.4).

Then state it plainly:

> *Under assumptions A, methods M₁…Mₙ admit ranges R₁…Rₙ. The conclusion is stable under
> sweeps S₁…S_k and unstable under S_j. The following were not tested: …*

### Three habits worth stealing

From Sitrec's own benchmark harness, which is stricter about this than the app:

1. **Never report a zero as an exclusion.** "Not calibrated" is honest; "0 %" reads as "ruled
   out" and will be quoted that way.
2. **Never report an optimiser result as a bound.** An optimiser found the best it could find,
   which is not the best that exists.
3. **Always report N alongside a rate.** "3 of 4" and "75 %" are not the same claim.

---

## 7. Reading the executive verdict without over-reading it

The analysis ends with one of five verdicts. Each licenses something different.

**"Insufficient independent evidence to discriminate."** — your sightlines were constructed
from the target being tested (§2.8). The results validate the scene's internal consistency and
cannot identify anything.

**"Insufficient evidence to discriminate."** — range is not determined by this evidence: the
sensor's motion provides no usable parallax, so every model's distance reflects its own priors.

**"Probably a wind-blown balloon."** — the **only** affirmative verdict, and it is gated
hard: the complete free-wind balloon model must fit with ordinary balloon-like motion, its
consistency must clear a threshold, the wind it requires must independently agree with the
loaded winds aloft, *and* no known catalogue object may also be viable. Note what "probably"
means here — **corroborated by an independent measurement**, not "the most likely of the
candidates".

**"Consistent with a {X}, but not identified."** — exactly one interpretation gave a
complete, ordinary, close fit, but nothing independent corroborated it. A sole survivor never
gets promoted to "probably".

**"Consistent with several conventional interpretations."** — several fit, and the evidence
does not distinguish between them. No cross-category probability comparison has been made.

**"Unresolved — no completed tested conventional model passes the current screen."** — the
trap. This is the *safety valve*, not an anomaly claim, and the detail paragraph says so
outright: it is not by itself evidence of anomalous motion, and it always discloses that the
noise floor is uncalibrated and that model envelopes were not exhaustively excluded.

The interface deliberately styles "Unresolved" and "Insufficient" in the same neutral way as
the others, with no alarm colouring — precisely because in a UAP tool that headline is the one
most likely to be screenshotted out of context.

> ### The publication rule
>
> **Never quote a verdict headline without its detail paragraph and the not-modelled list.**
> The headline is a label; the detail is the finding.

---

## 8. Writing it up

A structure you can fill in:

- **Claim** — one sentence, with its conditional clause attached. *"If the object was at the
  altitude reported by the ADS-B track, its speed was …"*
- **Data provenance** — every source, its URL or hash, its datum, its known limitations.
- **Configuration** — Sitrec build version, sitch name and save timestamp, the A-B frame
  range, the methods used, every prior you set (Target Speed, Min/Max Dist, LOS Uncertainty),
  smoothing settings, filter state, and the FOV with its source.
- **Result** — the *family*: the admitted band, rung count, gaps, and any edge flags.
- **Sensitivity** — each sweep from §6 and whether the conclusion survived it.
- **What this does not establish** — a required section, not an optional one.
- **What was not tested** — including the not-modelled list from §5.
- **Attachments** — the exported analysis report, the saved sitch, and the raw data files.

The exported HTML report carries a run-audit manifest with most of the configuration block
already filled in. It also states its own limit, which is worth repeating: it is an audit
summary, not a self-contained archive. The source files, the wind and terrain data, and the
application version have to be retained alongside it.

---

## 9. Two write-ups of the same scene

**Indefensible:**

> Sitrec shows the object was travelling at 480 knots at a range of 30 nautical miles,
> accelerating at 6 g. No conventional aircraft can do this.

Every number is an output of an assumed range; no method is named; no conditioning is checked;
"no conventional aircraft can do this" is an exclusion claim the tool cannot support.

**Defensible:**

> The camera was in straight-and-level flight throughout, so the geometry provides almost no
> parallax and Fit Diagnostics reports the constant-velocity fit as ill-conditioned — the range
> is not determined by this footage. Constrained to the 25–35 nm band implied by the operator's
> stated range, a constant-velocity fit gives 440–520 kt with a mean residual of 0.6 mrad; at 5
> nm the same sightlines are equally well explained by an object doing 70 kt. Both fit. The
> footage does not distinguish them.
>
> The balloon model was not viable (wind disagreed); the fixed-wing fit hit its airspeed
> bound, which makes that test incomplete rather than an exclusion. Sitrec's verdict is
> *Unresolved*, which is a statement that no tested conventional model passed the screen — not
> evidence of anomalous motion. Birds, debris, helicopters, optical artefacts and video
> processing were not modelled at all.
>
> Configuration, sweeps and the exported report are attached.

The second one is harder to argue with, because it has already made the arguments.

---

## Checklist

Before publishing:

- [ ] Time sync stated, with precision
- [ ] FOV measured or sourced, with a ±
- [ ] Altitude datum identified and checked against a known reference
- [ ] Bad-data filter state reported; run with it off
- [ ] Smoothing reported; raw result shown
- [ ] Line of sight confirmed non-circular
- [ ] Fit Diagnostics / conditioning checked
- [ ] More than one method run, and disagreements explained
- [ ] Nothing sitting on a search bound and being quoted as a result
- [ ] Sensitivity sweeps run and reported
- [ ] Verdict quoted with its detail paragraph and the not-modelled list
- [ ] A "what this does not establish" section written
- [ ] Sitch, data files and exported report attached

---

## See also

- [Traverse Methods](TraverseMethods.md) — what each method assumes and does not establish
- [Traverse Analysis and the Verdict](TraverseAnalysis.md) — the gallery, ranking and bands
- [GIS, Geodesy and Altitude](GIS.md) — datums, and how to recognise a datum error
- [Tracks](Tracks.md) — filtering, smoothing, and what they cost
- [Star Tracker](StarTracker.md) — measuring the field of view instead of guessing it
- [Nimitz](Nimitz.md) — a worked example of handling sources that disagree
