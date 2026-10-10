# LOS Error Analysis

Use **Traverse → Analyze LOS Error…** when you have a platform track,
independently recorded pointing and a synchronized target truth track. This
measures pointing error; it does not run the traverse solvers.

Select the truth track and pointing source, set the A–B interval, then press
**Analyze**. Every successful analysis fits a portable model and automatically
generates a fresh realization. All three charts overlay that realization as
**dashed lines at 50% opacity**, while measurements remain solid and opaque.
The pointing dropdown also offers loaded recorded-angle LOS nodes,
so you can examine those without changing the scene's camera settings. A camera
aimed directly at the truth target supplies constructed pointing, not an
independent measurement of tracking accuracy.

## Measurements and sampling

For each valid sample, the reference bearing is the direction from platform to
truth. The spherical log map expresses the angular difference in a local
horizontal/vertical tangent plane. Its vector magnitude is the exact angular
separation. The horizontal axis is local up × the reference bearing, so a
positive horizontal (H) error is to the left of the reference bearing
(counter-clockwise seen from above). The vertical axis completes the frame, so a
positive vertical (V) error is up. Exported models use this basis. The horizontal
axis becomes ambiguous near zenith or nadir.

The report shows mean H/V bias, demeaned H/V standard deviation, radial RMS,
radial percentiles, successive-sample step RMS, cross-axis correlation,
skewness/kurtosis in the statistics API, time correlation and a stationarity
check over successive thirds. Charts show the error sequence, radial cumulative
distribution and autocorrelation. Mean bias includes any persistent pointing,
truth, platform or synchronization error; it is not automatically a sensor
boresight calibration. Long-lag estimates and tails need sufficiently long data.

Recorded-angle MISB LOS uses original record times and raw attitude columns,
including PES/video PTS pairing when that is the track's timing mode. Platform
and truth positions use the scene's current track settings. Position smoothing,
edits, time offsets and truth errors therefore affect the residual. The original
rate is estimated from the median positive record interval; gaps are reported.

Other LOS sources use scene frames, with an explicit **recording cadence
unverified** label. Enter **Original Hz override** only when you know the
measurement cadence. An override selects nearest existing scene frames; it
cannot undo an interpolation or filter already applied upstream.

10 Hz and 1 Hz select nearest original samples, anchored at the first valid
sample. They do not average, add noise, interpolate or fill gaps. A requested
rate above the original rate is unavailable. This is decimation, so fast error
may alias. Original, 10 Hz and 1 Hz need not have the same step RMS or sample
autocorrelation even when their angular RMS is similar.

## Operator tracking model

The default **Operator: drift, reaction, correction** model describes a human
trying to keep an object centered:

1. Smooth wandering velocity accumulates pointing error.
2. Crossing a notice threshold schedules a correction after a reaction delay.
3. The correction slews toward the center, with imperfect centering accuracy.
4. Wandering resumes. Independent jitter and constant bias can be added.

The controls expose notice threshold in degrees, wandering and correction
speeds in degrees/second, reaction delay in seconds, centering accuracy and an
effective delay in following a changing target bearing. The parameter JSON also
contains H/V scale, cross-axis coupling, H/V jitter and simulation rate.

The fit compares aggregate amplitude, tails, increments and physical-time
correlations with ensembles of two independent simulation seeds over 54
parameter combinations. Up to the first 90 seconds sets the temporal shape;
the comparison and generated output cover all valid samples in A–B. At least
20 original samples are needed to fit operator behavior or temporal memory.
Shorter valid clips still produce a portable bias/amplitude model with
independent Gaussian samples, explicitly labeled as a short-clip approximation.
It does not search for a seed that reproduces the measured trace.

The feedback analogue inherits a wandering-direction interval of 0.4–1.2 s,
velocity relaxation around 0.33 s, reaction-time variation of ±30% and
correction-speed variation of ±25%. These are modeling assumptions, not
measurements of the person. Operator-model synthesis removes the legacy
controller's minimum correction-speed floor so small angular errors scale
properly; the existing controller's default behavior remains unchanged.

Effective following delay is estimated from how error relates to variations
in the reference bearing's angular velocity. A constant angular velocity cannot
separate fixed bias from lag. A delay is used only when it explains at least 10%
of demeaned error variance. Clock skew can look like following delay, so this
must not be interpreted as an identified human reaction time. The following
delay and threshold-triggered correction delay are different parameters.

Parameter values are descriptive equivalents: several combinations can give
similar statistics. At 1 Hz, subsecond operator behavior is especially weakly
constrained. Neither this model nor the alternative Gaussian autoregression
represents every tracking strategy, overshoot, loss of target or changing regime.
Use A–B to characterize separate regimes and inspect fresh realizations rather
than assuming a fitted model is adequate. Real operator validation needs a
held-out recording or interval, not just simulated feedback data.

## Statistical alternative and new realizations

**Statistical: Gaussian autoregression** fits a stationary AR process to each
axis, with correlated innovations. Burg lattice fitting and BIC choose an order
from 0 to 20, with smaller limits on short clips. It captures temporal memory
without interpreting the mechanism. Gaussian innovations cannot reproduce all
non-Gaussian tails or operator correction events.

The initial model preview is automatic, and importing a model also generates a
fresh preview. Press **Generate with seed** or **Fresh seed** to replace the
preview and compare synthetic and measured statistics at all three rates.
Change the noise amplitude multiplier, include or
exclude mean bias, adjust operator controls or edit the parameter JSON. Mean bias
is controlled separately from the amplitude multiplier. Changing parameters does
not change the measured sequence or automatically regenerate the previous output.

Simulation burns in before producing output. Lower output rates sample the same
internal realization; they do not redraw noise at a different cadence. The model
does not claim support for recording rates above its calibration rate. The
operator simulation grid is at least 10 Hz, even for a 1 Hz calibration, so a
subsecond reaction is simulated between observations.

## Local exports and reuse

**Export parameter model** downloads an allowlisted JSON containing only
aggregate model parameters and rates. It excludes source filenames, dates,
positions, truth tracks, measured samples and original seeds. **Import model**
loads these parameters for use on another chosen platform/target geometry.

**Export synthetic LOS CSV** downloads the last generated realization. Each row
has the relative time, the current platform and target positions in ECEF meters,
and the new ECEF unit LOS direction. It contains no measured pointing sequence.

For scripted use, `generateErrors(model, timesSeconds, newSeed, geometry)` and
`directionWithError(sensor, target, error, up)` are exported by
`src/LOSErrorModel.js`. Geometry rows contain `{t, sensor, target, up}`, with
positions and up vectors in the same coordinate frame. A following-delay model
requires synchronized geometry. Use a new seed with new tracks; do not reuse the
source residuals. Analysis and synthesis run in the browser.
