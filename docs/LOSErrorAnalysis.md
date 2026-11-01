# LOS Error Analysis

**Traverse → Analyze LOS Error…** measures how far a recorded line of sight (LOS)
was from a known target, fits a small model of that error, and generates new
error sequences from the model. It does not run the
[traverse solvers](TraverseAnalysis.md), and it gives no range or range uncertainty.

Use it when you have a platform track, independently recorded pointing and a
synchronized *truth track* of the known target. Analyze needs a truth track, so
this does not apply to an unknown object. Load that track before you open the
panel, which reads the track list once.

Set the In and Out frames (keys I and O; see
[Time, Frames and Syncing](TimeAndSync.md#keys-for-time-and-frames)) before you
open the panel. A–B in a label means the In/Out range. Select the **Truth track**
and **Pointing LOS**, then press **Analyze**. Every successful analysis fits a
portable model (statistics only) and generates a fresh *realization*, one new
random sequence from the model. All three charts overlay that realization as
**dashed lines at 50% opacity**, while measurements remain solid and opaque.

![The LOS error analysis panel: the Truth track, Pointing LOS, Original Hz override and Noise model controls, a table of Measured and Synthetic rows at Original, 10 Hz and 1 Hz, and three charts titled Angular error, Radial error distribution and Demeaned temporal correlation, each with solid and dashed lines](docimages/los-error-analysis-panel.jpg)

The panel after **Analyze**, on a generated 20 Hz recording of a fixed ground target, with 600 valid samples. The table has a **Measured** row and a **Synthetic** row for each rate. **Plot samples at** selects the rate for the charts. **Angular error** is the error sequence, **Radial error distribution** is the radial cumulative distribution, and **Demeaned temporal correlation** is the autocorrelation, on a logarithmic lag axis. In the first and third charts, blue is H (the horizontal error angle) and orange is V (the vertical error angle). Dashed lines, labeled **Model**, are the realization in the **Synthetic** rows. The **Synthetic** rows are one random realization, not a replay of the measurement. Over this 30-second clip, their mean, tails and correlation differ from the **Measured** rows. The model's bias (mean error) is the measured bias, and the **Bias** column also includes the slow wander of this realization. **Fresh seed** gives different values. This recording was generated with drift and late corrections, so its solid lines slope slowly and then step back sharply.

**Pointing LOS** defaults to **Current traverse LOS**. A camera-based LOS uses
scene frames, even when the camera follows a track with recorded angles. To use
the original record times, choose the track's **Recorded angles:** entry; this
does not change the scene's camera settings. A camera aimed directly at the
truth target supplies constructed pointing, not an independent measurement of
tracking accuracy.

## Measurements and sampling

For each valid sample, the reference bearing is the direction from platform to
truth. The error is split into a horizontal angle (H) and a vertical angle (V)
in a local tangent plane, by the spherical log map. The length of (H, V) is the
exact angular separation, or *radial* error. The horizontal axis is local up ×
the reference bearing, so a positive H error is to the left of the reference
bearing (counter-clockwise seen from above). The vertical axis completes the
frame, so a positive V error is up. Exported models use this basis. The
horizontal axis becomes ambiguous near zenith or nadir.

For each rate, the table shows the sample count, mean H/V bias, H/V standard
deviation with the mean removed (*demeaned*), root mean square (RMS) radial
error, radial p95 and p99 (the values that 95% and 99% of samples fall below),
step RMS between successive samples and H/V excess kurtosis (how heavy the
tails are; 0 for a Gaussian). The radial values include the bias. **H/V 1 s
correlation** compares each axis with itself 1 second later; it does not compare
H with V. Charts show the error sequence, radial cumulative distribution and
autocorrelation, which shows how long an error persists. A note in the panel
gives a stationarity check: the RMS and mean over successive thirds of the
samples. Mean bias includes any persistent pointing, truth, platform or
synchronization error; it is not automatically a camera boresight calibration.
Long-lag estimates and tails need sufficiently long data.

Recorded-angle [MISB](Glossary.md) LOS uses original record times and raw
attitude columns, including the pairing of metadata packet (PES) and video frame
(PTS) timestamps when that is the track's timing mode. Platform and truth
positions use the scene's current track settings. Position smoothing, edits,
time offsets and truth errors therefore affect the residual. The original rate
is estimated from the median positive record interval; gaps are reported. A
record needs all six platform and camera attitude columns and must be inside the
data of both tracks. If fewer than two samples remain, Analyze stops with "Not
enough overlapping valid pointing and truth samples in A–B."

Other LOS sources use scene frames, with an explicit **recording cadence
unverified** label. Enter **Original Hz override** only when you know the
measurement cadence. It must be no higher than the scene rate, and recorded MISB
timing ignores it. An override selects nearest existing scene frames; it cannot
undo an interpolation or filter already applied upstream. The exception is
**Angle Smooth Window (frames)**, which Analyze sets to 0 for the run.

10 Hz and 1 Hz select nearest original samples, anchored at the first valid
sample. They do not average, add noise, interpolate or fill gaps. A requested
rate above the original rate is unavailable. This is decimation, so fast error
may alias (look like slower error). Original, 10 Hz and 1 Hz need not have the
same step RMS or sample autocorrelation even when their radial RMS is similar.

## Operator tracking model

Choose the model in the **Noise model** dropdown before you press **Analyze**.
The default **Operator: drift, reaction, correction** model describes a human
trying to keep an object centered:

1. Smooth wandering velocity accumulates pointing error.
2. Crossing a notice threshold schedules a correction after a reaction delay.
3. The correction slews toward the center, with imperfect centering accuracy.
4. Wandering resumes. Independent jitter and constant bias can be added.

This is the operator model of [Camera → Tracking Wobble](CameraAndTarget.md#camera--tracking-wobble)
and of the benchmark's [pointing-error ladder](TraverseConcepts.md#13-two-ladders-and-two-kinds-of-range).
Here it has no minimum correction speed, so small errors scale properly. It
fixes a wandering-direction interval of 0.4–1.2 s, velocity relaxation around
0.33 s, reaction-time variation of ±30% and correction-speed variation of ±25%.
These are modeling assumptions, not measurements of the person.

The controls expose notice threshold in degrees, wandering and correction
speeds in degrees/second, reaction delay in seconds, centering accuracy and an
effective delay in following a changing target bearing. The parameter JSON also
contains H/V scale, cross-axis coupling, H/V jitter and simulation rate.

The fit tries 54 parameter combinations, each with two independent simulation
seeds, on up to the first 90 seconds of the In/Out range. It rescales each
combination to the demeaned RMS of those seconds, then scores the demeaned
p95/RMS ratio, step RMS and autocorrelation at lags up to 5 seconds. Mean bias,
H/V scale and cross-axis coupling come from all valid samples in the In/Out
range. The table and the generated output cover all of those samples. The fit
does not search for a seed that reproduces the measured trace.

If the H and V correlations between successive samples are both within ±0.12,
the search does not run: the model is jitter only, with notice threshold, wander
and correction 0, and the panel reports 0 combinations. At least 20 original
samples are needed to fit operator behavior or temporal memory. Shorter valid
clips still produce a portable model of bias, amplitude and cross-axis
correlation with independent Gaussian samples, labeled as a short-clip model.

Effective following delay is estimated from how error relates to variations
in the reference bearing's angular velocity. A constant angular velocity cannot
separate fixed bias from lag. The estimate is limited to 0–2 seconds. A delay is
used only when it explains at least 10% of demeaned error variance. Clock skew
can look like following delay, so this must not be interpreted as an identified
human reaction time. The following delay and threshold-triggered correction
delay are different parameters.

Parameter values are descriptive equivalents: several combinations can give
similar statistics. At 1 Hz, subsecond operator behavior is especially weakly
constrained. Neither this model nor the alternative Gaussian autoregression
represents every tracking strategy, overshoot, loss of target or changing regime.
Use the In/Out range to characterize separate regimes and inspect fresh
realizations rather than assuming a fitted model is adequate. Real operator
validation needs a recording or interval that the fit did not use, not just
simulated feedback data.

## Statistical alternative and new realizations

**Statistical: Gaussian autoregression** fits a stationary autoregressive (AR)
process to each axis: each value depends on earlier values plus a random
*innovation*, and the statistics do not change over time. The H and V
innovations are correlated. Burg lattice fitting and the Bayesian information
criterion (BIC) choose how many earlier values each axis uses, from 0 to 20,
with lower limits on short clips and below 10 Hz. The model captures temporal
memory without interpreting the mechanism. Gaussian innovations cannot reproduce
all non-Gaussian tails or operator correction events.

Press **Generate with seed** or **Fresh seed** to replace the realization and
compare synthetic and measured statistics at all three rates. Change the noise
amplitude multiplier, include or exclude mean bias, adjust the operator controls
(operator model only) or edit the JSON under **Edit model parameters
(advanced)**. The amplitude multiplier does not change mean bias or following
delay. Changing parameters does not change the measured sequence or
automatically regenerate the previous output.

Simulation discards a start-up (burn-in) period before output. Lower output rates
sample the same internal realization; they do not redraw noise at a different
cadence. A model cannot generate above its calibration rate, the original rate
of its fit: Sitrec stops with an error if the output rate is more than 1% above
it. The operator simulation grid is at least 10 Hz, even for a 1 Hz calibration,
so a subsecond reaction is simulated between observations.

## Local exports and reuse

**Export parameter model** downloads an allowlisted JSON containing only
aggregate model parameters and rates. It excludes source filenames, dates,
positions, truth tracks, measured samples and original seeds. It holds the
current parameters, multiplier and bias choice, even if you did not generate again.

**Import model** appears after a successful Analyze. To use a saved model on
other tracks, load them and open the panel again, so that it lists them. Select
them, press **Analyze**, then press **Import model**. The new realization uses
the times and positions of that analysis, so its rate must stay within the
calibration rate. **Original Hz override** can lower a scene-frame rate.

**Export synthetic LOS CSV** downloads the last generated realization, with one
row per valid sample of the last analysis: relative time, platform and target
positions from that analysis in [ECEF](Glossary.md) meters, and the new ECEF unit
LOS direction. It has no measured pointing. Sitrec does not load this CSV back.

For scripted use, `src/LOSErrorModel.js` exports `generateErrors(model,
timesSeconds, newSeed, geometry)` and `directionWithError(sensor, target, error,
up)`; the running app does not expose them. Geometry rows contain `{t, sensor,
target, up}`, with `[x, y, z]` arrays in one coordinate frame. `generateErrors`
returns rows `{t, e}`, where `e` is `[H, V]` in degrees; pass it as `error`. A
following-delay model requires synchronized geometry. Use a new seed with new
tracks. Analysis and synthesis run in the browser.
