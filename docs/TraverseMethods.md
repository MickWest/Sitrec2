# Traverse Methods

A **traverse** finds a 3D position for each frame by combining a Line of Sight (LOS) with some physical assumption. Each LOS frame provides a sensor position and a direction vector. The traverse decides *where along* (or near) that ray the target is.

> ## Range and assumptions
>
> - A camera measures **direction**, not distance. Given the sensor positions **S**(t) and the
>   directions **D**(t) it observed, *every* range profile *R*(t) gives a path
>   **S**(t) + *R*(t)·**D**(t) that fits the sightlines exactly.
> - Each traverse method selects one path by adding an assumption. The speeds, sizes,
>   altitudes and accelerations derived from that path depend on the assumption.
> - Range is constrained only when the sensor moves *across* the sightlines (**parallax**).
>   With a stationary camera, or one flying straight at the target, the fits still return a
>   path with a low residual; its range comes from the method's assumption, not from the
>   sightlines. See [Traverse Analysis and the Verdict](TraverseAnalysis.md).

Sitrec offers two families of traverse:

- **Sequential traversals** process frames one at a time, propagating state forward. Each frame's result depends on the previous frame.
- **Global fits** use every LOS ray in the fitted window to determine the whole trajectory, so no start distance is needed. Most solve all frames in one step; the Kalman Smoother still propagates state frame to frame, but its CV seed and backward pass make every output point depend on all frames.

---

## Quick Reference

### Sequential Traverses

| Method | Key Parameters | What It Does | You must assume | It does NOT establish |
|--------|---------------|--------------|-----------------|-----------------------|
| **Target Object** (default) | Target track, Target Smooth Window | Uses the selected target track itself (smoothed), not a traverse along the LOS. The Custom sitch's default. | That the target track is right | Anything the target track does not already contain |
| **Use Range** | Range Source | Applies a loaded MISB range column, in metres, along the current LOS. Appears when range data is loaded. | The selected range belongs to the observed target and has the correct units | Range calibration or target identity. Ground Range is applied directly, without conversion to slant range |
| **Constant Distance** | Start Distance (**Tgt Start Dist**) | Places the target at Tgt Start Dist along every LOS ray. | The range | Anything. The range is 100 % your input, and every speed, size and acceleration scales with it |
| **Constant Ground Speed** | Start Distance, Target Speed | Finds the point on each LOS ray that maintains a fixed ground speed from the previous frame. | The speed, the start range, and that every earlier frame was right | The speed (you supplied it) or the range. Errors compound forward and never self-correct |
| **Constant Air Speed** | Start Distance, Target Speed, Wind | Same as ground speed, but subtracts wind to maintain constant airspeed. | All of the above **plus** that the wind field is right at the target's unknown altitude | The same — and wind error and range error are confounded, so you cannot separate them from sightlines alone |
| **Straight Line** | Start Distance, Heading | Moves in a fixed compass heading. Each frame intersects the LOS ray with a vertical plane aligned to that heading. | Perfectly straight horizontal motion on a heading you supply | The heading. Curvature shows up as residual you cannot attribute between "it wasn't straight" and "your heading is wrong" |
| **Fixed Line** | Start Distance, Heading, Speed | Moves at a fixed speed in a fixed heading, ignoring the LOS after the first frame. Legacy sitches only (not in the Custom sitch menu); works poorly far from the origin. | Speed and heading | Anything — after frame 0 the path does not use the LOS |
| **Constant Altitude** | Start Distance | Intersects each LOS ray with a sphere (or WGS84 ellipsoid) at the constant geodetic altitude where the first LOS reaches Tgt Start Dist. | The altitude (or start range) — **and that your altitude datum is right** | The altitude. Near-tangent sightlines give discontinuous jumps. Ignores terrain |
| **Starting Altitude** | Start Altitude (**Tgt Start Altitude**), Vertical Speed (**Tgt Vert Spd**) | Like Constant Altitude but takes an explicit altitude value from a GUI slider rather than deriving it from start distance. Optional vertical speed for climb/descent. | As above | As above |
| **Windblown Object (on first LOS)** | Start Distance, Wind | Places the target at the start distance on the first LOS, then drifts it by the wind vector each frame. Ignores subsequent LOS rays. | That the object is a passive wind tracer, that the wind is right, and the start range | Anything about the object. This is a forward simulation, not a fit — later sightlines are never consulted. The residual shows how well they agree with it; they do not affect the path |
| **Close to Target** | Target track | Finds the closest point on each LOS ray to a separately defined target position. | That a separately-known target track exists | Anything independent — it is a diagnostic of angular error against a track you already had |
| **Perspective** | Start Distance, 3 keyframes | Derives a depth-velocity model from three screen-space keyframes, then linearly interpolates two 3D endpoints. Models perspective-induced apparent acceleration. | Perfectly linear 3D motion, exactly three keyframes, and a correct FOV | Non-linear motion. Extremely sensitive to where you place the keyframe pixels |
| **Const Air AB** | (derived from Constant Air Speed) | Interpolates a straight line between the first and last frame of the Constant Air Speed traverse. Useful for comparison. | As Constant Air Speed | Anything — it is a comparison aid |

### Global Fits

In the menu most of these appear with a "Global Fit:" prefix (e.g. "Global Fit: Constant
Velocity"); *Horizontal Speed Valley*, *Ground Vehicle*, the *Monte Carlo (GPU)* entries and
*Analysis Snapshot (created by Analyze)* are listed without it.

⚠ = this method belongs to the constant-velocity family and can **collapse onto the sensor**
on narrow-baseline scenes, returning a near-zero residual for a range that is an artifact.
The method's Fit Diagnostics folder (e.g. "Constant Velocity Fit Diagnostics") reports conditioning and whether the track sits on or behind the camera — see "Fit conditioning" below.

| Method | Min Frames | Key Parameters | What It Does | You must assume | It does NOT establish |
|--------|-----------|---------------|--------------|-----------------|-----------------------|
| **Constant Velocity** ⚠ | 2 (3 for a determined fit) | (none) | Fits a straight-line trajectory P(t) = P0 + V*t that minimizes perpendicular distance to all LOS rays. | Straight-line motion at constant velocity, and enough parallax to pin range | **The range.** Below 3 frames the system is underdetermined and fits exactly regardless of the truth |
| **Constant Acceleration** ⚠ | 3 (5 for a determined fit) | (none) | Fits a parabolic trajectory P(t) = P0 + V*t + 0.5*A*t^2: one constant acceleration vector, so a parabolic path: a straight-line speed change, a ballistic arc, or a curve whose heading changes the way a parabola's does. A constant-rate turn at constant speed (a circular arc) rotates its acceleration vector and is not constant acceleration; it fits CA only over a short arc. | Constant acceleration | The range (same collapse family). Below 5 frames the system is underdetermined and fits exactly regardless of the truth |
| **Kalman Smoother** ⚠ | 2 (via the CV seed) | Process Noise, Measurement Noise | Runs a Kalman filter forward then backward (RTS smoother). Every point benefits from all measurements past and future. Tunable noise balance. | A constant-velocity process between frames; the noise settings are *tuning knobs*, not calibrated variances | The range (it is seeded from the CV fit). **Its covariance comes from the tuning settings; it is not a calibrated uncertainty** |
| **Monte Carlo 1** ⚠ | 2 | Num Trials, LOS Uncertainty (deg), Polynomial Order (**MC Num Trials**, **MC LOS Uncertainty (deg)**, **MC Polynomial Order**) | Randomly samples points along perturbed LOS rays (using a CV fit for focused per-frame range estimates), fits polynomials, and keeps the best trial. Robust to outliers. | Polynomial motion of the order you chose, and that your LOS Uncertainty matches the real pointing error | The range (CV-seeded). **This is not a posterior** — it keeps the single best trial, so the spread of trials is a function of your guessed uncertainty, not of the data |
| **Monte Carlo 2** ⚠ | 2 | Num Trials, LOS Uncertainty (deg), Polynomial Order | Least-squares variant: perturbs all frames each trial and fits an overdetermined polynomial, giving more stable results at higher polynomial orders. | As above | As above |
| **Monte Carlo 50k / 100k / 250k / 500k / 1M (GPU)** | 2 | (fixed preset) | Blind Monte Carlo search on the GPU (WebGPU): polynomial order 1, 0.1° LOS uncertainty, and the named number of trials. Ranges are sampled uniformly from zero, not seeded from a CV fit. Runs asynchronously; a Status folder shows progress. | Straight-line motion and 0.1° pointing error | The range when the geometry has no parallax. It keeps the best trial; it is not a posterior |
| **Physics** | 2 | Physics Model, Make/Model, Max Iterations, Wind, Initial Range | RK4 integration of a physical dynamics model — Sky Lantern (wind-drift kinematics with a rise/decay/sink life cycle), Fixed Wing Aircraft, or Quadcopter (hover-capable multirotor), chosen with the Physics Model selector — fit with differential evolution plus Nelder-Mead polish. Fixed-wing and quadcopter offer a make/model sub-selector (AUTO reports the closest match). | That the chosen model's dynamics apply, within the search bounds | **That the object was that thing.** A good residual means the sightlines are *compatible* with that model, not that the object is one. A fit that hits a bound is incomplete, not an exclusion |
| **Horizontal Speed Valley** | 20 | (none) | Intersects the sightlines with candidate level surfaces and finds a persistent interior altitude valley using multi-scale speed consistency and cancellation of the dominant altitude-dependent speed waveform. The target may turn. | Level flight at nearly constant ground speed, a downward view, and enough geometry to form a distinct altitude valley | The altitude when the score has no interior valley. The solver excludes the upper 20% of the ground-to-platform band because solutions collapse toward the platform track there. Its block-bootstrap confidence measures valley stability under temporal resampling, not whether the motion assumption is true |
| **Minimum Acceleration** | 2 | Tgt Start Dist, Target Speed, wind; optional Min/Max Dist limits in *Traverse Analysis Tweaks* | Finds the acceleration-minimizing path that follows the rays. Finds its own range — purely from geometry when the sensor's own motion pins it, falling back to Target Speed as a soft tiebreaker on narrow-baseline scenes. (Formerly "Plausible"; saved sitches still serialize the menu key "Global Fit: Plausible".) See [Traverse Analysis](TraverseAnalysis.md). | A smooth range profile; on flat geometry, a speed prior | The range **whenever the speed prior is doing the work** — the indicator tells you which case you are in. When it is, the range follows from Target Speed |
| **Minimum Speed** | 2 | (none) | Finds the slowest object consistent with the sightlines — the drifting-lantern / near-static reading. See [Traverse Analysis](TraverseAnalysis.md). | Nothing about the object type | That the object *was* slow. This is the **lower bound** of the family by construction, not an estimate |
| **Stationary Point** | 2 | (none) | The single fixed world position that best fits every sightline (closed-form least squares). The object simply does not move — the live method behind the analysis gallery's "Stationary Point in Space" tile. No on-ray traverse can represent this: walking the rays at speed 0 still moves by the rays' closest-approach distance each frame, drifting and flagging over-speed (white) segments. | That the object did not move | That it was stationary — only how well a stationary object would fit |
| **Ground Object** | 2 | (none) | The Stationary Point fit pinned to a curved constant-elevation shell sampled near the local terrain. Live method behind the gallery's "Ground Object" tile. | That the object sits at local ground elevation | That it was on the ground |
| **Wind Tracer** | 8 | Pointing σ, Loose Shear | Fits a passively drifting object — rising, neutrally buoyant or sinking (lantern, balloon, debris) — whose ANCHOR is eliminated in closed form rather than searched as a start distance, and models the camera operator's own boresight motion with a nuisance basis band-limited above the azimuth-sweep frequency. Deterministic; seeded by a wind rose. | That the object is a passive wind tracer in a horizontally uniform wind, and that the operator's pointing error has no power at the azimuth-sweep frequency | **That the object was a lantern** — a low residual says the sightlines are *compatible* with a wind tracer. It does not remove the operator's SLOW pointing drift (nothing can, from a boresight alone), and it establishes wind DIRECTION far better than wind SPEED |
| **Ground Vehicle** | 2 | (none) | The moving point where each sightline meets that curved constant-elevation shell. Live method behind the gallery's "Ground Vehicle" tile; frames whose sightline never reaches it hold the last valid position. This is not a DEM-following trajectory. | As above, while moving | That it was on the ground. Note this follows a smooth shell, not the actual terrain |
| **Analysis Snapshot (created by Analyze)** | — | (none) | The exact track of the gallery result you applied with **Use This**, stored as a snapshot. It is not re-fitted; to change an assumption, run Analyze again. | Whatever that result assumed | Nothing new — it replays an analysis result |

**In/Out (A-B) range.** Every Global Fit method fits the sightlines inside the
In/Out frame range (the I/O keys) when one is set, and holds its endpoint
positions outside it — outside the analyzed window no motion is claimed. The
traverse analysis gallery fits the same range, so a fit applied from the
gallery reproduces the same solution. Setting In/Out re-fits the selected
method immediately. The sequential traverses (Constant Ground/Air Speed,
Constant Altitude, etc.) are not fits — they walk the rays from frame 0 and
always cover the whole clip.

At least ten selected frames are required by **Analyze**. A current live-node
compatibility limitation remains for very short windows: Global Fit methods
given fewer than eight selected frames retain the legacy full-clip fallback.
That fallback fits the full clip, not the A-B range.

---

## In Depth

### Use Range

Load a MISB source with **Slant Range** (tag 21) or **Ground Range** (tag 57), then choose **Use Range** in the LOS Traverse Method menu. **Range Source** lists every populated range field by track name. The source choice is saved with the sitch, and the list updates as tracks are imported or removed. With no populated range column the method is not offered.

The target position is `camera position + unit LOS direction × range in metres`. The current camera/LOS selection supplies the direction; choosing a range source does not switch the camera or its angles. Ranges follow the imported track’s timestamp alignment, including timing offsets and video pairing. Between valid records, values are interpolated linearly without angle wrapping or additional smoothing. Jumps in per-frame range data are retained.

Ground Range is used directly as an along-LOS distance, as selected; no ground-to-slant conversion is inferred. Missing, negative or nonfinite readings hold the previous valid range; leading gaps hold the first valid reading. **Range Data** reports how many scene frames use held values. Endpoints are held rather than extrapolated into negative distances. Range-based placement does not independently validate the sensor return or identify its target.

### How LOS Works

Every LOS node provides per-frame data:
- **position**: the sensor location in ECEF (meters)
- **heading**: a unit vector pointing from the sensor toward the target

A traverse method takes this sequence of rays and produces a sequence of 3D positions, one per frame.

---

### Sequential Traverses

#### Constant Distance

The simplest traversal. For each frame:

    target = sensor_position + heading * distance

The Custom sitch builds it with only `startDist` (**Tgt Start Dist**), so the distance is the same on every frame.

**Limits**: Assumes distance is known or guessable. Produces a physically meaningless trajectory if the true distance varies non-linearly.

#### Constant Ground Speed / Constant Air Speed

For frame 0, places the target at `startDist` along the first LOS. For subsequent frames:

1. Construct a sphere centered on the previous position with radius = desired per-frame motion (speed / fps).
2. Intersect the current LOS ray with this sphere.
3. Pick the intersection that matches the expected direction of travel (toward or away from the camera).

Uses binary search on the sphere radius to handle the discrete geometry. When the sphere doesn't intersect the ray (e.g., the target would need to move faster than the specified speed to stay on the LOS), falls back to the closest point on the ray.

**Air speed** mode subtracts the wind vector from the displacement before comparing to the speed threshold.

**Limits**: Sensitive to start distance. Small errors compound frame-by-frame. Noisy LOS data causes jerky trajectories. Only looks backward (each frame depends on the previous one), so a bad frame poisons all subsequent frames.

**Parameters**:
- *Target Speed*: meters/second (displayed in sitch-appropriate units)
- *Start Distance*: distance along the first LOS ray

#### Straight Line

Constrains the target to move in a fixed compass heading. For each frame:

1. Compute local north and up vectors at the current position.
2. Build a vertical plane aligned to the target heading.
3. Intersect the LOS ray with this plane.

The target's altitude is free to vary (it's wherever the ray hits the heading plane). The heading is controlled by two parameters: `initialHeading` (the base direction, shown as **Initial**) and `targetRelativeHeading` (an offset added to it, **Tgt Relative Heading**).

**Limits**: Assumes perfectly straight horizontal motion. Any curvature in the true path shows up as residual error. Works well for short segments of level flight.

#### Fixed Line

Legacy method. Computes a forward vector from the heading at the first frame's position, then simply adds `speed * dt * forward` each frame. Does not re-intersect with the LOS after frame 0.

**Limits**: Only correct near the coordinate origin. Not geodetically aware. Kept for backward compatibility with old saves.

#### Windblown Object

Shown in the menu as **Windblown Object (on first LOS)**. Places the target at `startDist` along the first LOS ray, then adds the wind vector each frame. The target drifts passively with the wind, completely ignoring subsequent LOS data.

Useful for testing whether an object could be a wind-blown balloon or debris.

**Limits**: Only meaningful if the true object is indeed drifting with the wind. No LOS feedback after frame 0.

#### Constant Altitude

Intersects each LOS ray with a surface of constant geodetic altitude. Two modes:

1. **Start Distance mode**: derives the altitude from where the first LOS ray places the target at `startDist`, then maintains that altitude for all subsequent frames.
2. **Altitude mode**: uses an explicit altitude value (from GUI or sitch data).

On a spherical earth model, this intersects with a sphere of radius `earthRadius + altitude`. On the WGS84 ellipsoid model (when equator and polar radii differ), it scales the ellipsoid semi-axes by `(a + alt) / a` and `(b + alt) / b` and solves the quadratic ray-ellipsoid intersection.

Optional `verticalSpeed` adds a linear altitude change over time (climb or descent). Only Starting Altitude has it wired (**Tgt Vert Spd**).

**Limits**: Picks the nearest intersection, which may jump discontinuously if the LOS is nearly tangent to the altitude surface. Does not account for terrain.

#### Starting Altitude

Same algorithm as Constant Altitude in "altitude mode," but wired to a dedicated GUI slider (`startAltitude`) and vertical speed slider. Provides an easier user interface when you want to directly specify the altitude rather than deriving it from start distance.

#### Close to Target

For each frame, finds the closest point on the LOS ray to a separately specified target position using `Ray.closestPointToPoint()`. This is a diagnostic tool: it shows where the LOS comes nearest to an independently known target, revealing angular error.

**Limits**: Requires a target track to already exist. Not a standalone traverse.

#### Perspective

A specialized model for objects moving linearly in 3D that appear to accelerate or decelerate due to perspective projection. Requires exactly three keyframes with screen-space x-positions. From these it derives:

1. A depth-velocity ratio relating apparent motion to true 3D motion.
2. Two 3D endpoints (at the first and last keyframe).
3. Linear interpolation between them.

**Limits**: Assumes perfectly linear 3D motion. Only works with specific "Perspective" keyframe types. Intended for scenes where perspective effects dominate apparent motion.

---

### Global Fits

All global fits operate in a local East-North-Up (ENU) coordinate system centered on the mean sensor position. The conversion from ECEF to ENU keeps numbers small; the flat-earth approximation is intended for scenes under about 100 km across. Results are converted back to ECEF for display.

#### Horizontal Speed Valley

This speculative fit is intended for a level target that can turn while keeping
roughly the same horizontal ground speed. It tests 161 candidate geodetic
altitudes between the local ground and 80% of the way to the platform. At each
altitude it intersects every sightline with the level surface, averages the
position over 12 seconds on a 120-second clip, and measures horizontal speed
over a 5-second baseline. Short clips scale those durations down.

Altitude selection combines two signals. The first is a consensus of RMS speed
variation, median absolute speed variation, variation among temporal block
medians, and RMS variation at several smoothing scales. The second extracts the
dominant altitude-dependent speed waveform across the complete altitude sweep
and finds where its coefficient approaches zero. This captures the broad speed
waveform reversing phase above and below the correct level. The selected answer
is the lowest **interior** minimum of the combined curve, refined between its
neighboring samples.

The fit also runs a deterministic moving-block bootstrap. It resamples
five-second spans of the speed waveforms and reports how often the best interior
minimum stays inside the selected altitude basin, plus the 10–90% spread of the
selected bootstrap altitudes. That confidence describes the temporal stability
of this particular constant-speed valley. It does not establish that the real
target was level or held constant speed.

The interior-minimum and upper-band rules matter. As the candidate altitude
approaches platform altitude, every intersection collapses toward the usually
smooth platform track and can produce a false low score. A monotonic score with
no interior valley therefore reports failure instead of returning an endpoint.
The altitude depends on the level, constant-speed assumption.

Unlike sequential traversals, global fits have no start distance parameter: every sightline in the window takes part in determining the whole trajectory. CV, CA and the polynomial fits solve all frames in one step; the Kalman Smoother propagates state frame to frame but is seeded from the all-frame CV fit and smoothed backward, so its output also depends on every frame.

BOTBench exposes these same direct CV and CA implementations as **Global Fit:
Constant Velocity** and **Global Fit: Constant Acceleration**. BOT files retain
their observation timestamps and optional per-frame `MaxRange` values, and the
direct fits use both.

#### Range observability and collapse (CV-family conditioning)

Bearings-only data only determines range through **parallax**: the sensor has
to move *around* the sightlines, not just along them. When the sensor flies a
path the constant-velocity model can represent — straight and level cruise
exactly, a gently curving arc over a short clip approximately — the sensor's
own trajectory is a (near-)zero-residual solution to every
perpendicular-distance fit, and the CV family (Constant Velocity, Constant
Acceleration, the Kalman smoother whose process model is CV, and the Monte
Carlo / polynomial fits that are seeded from CV) tends to **collapse onto the
camera**: the "object" lands metres from the sensor, sometimes behind it. The
residual looks fine; the range is an artifact. Measured against known truth
(the BOT Bench synthetic benchmark, `benchmarks/botbench/`), a straight-flying
sensor produced total collapse at every clip length, while a 60-second orbit
recovered range to a fraction of a percent — and the transition between the
regimes is sharp.

Sitrec computes a **CV-family conditioning** diagnostic
(`assessLinearFitConditioning` in `LOSFitting.js`): the reciprocal condition
number of the normalized constant-velocity design system over the sightlines.
In the benchmark's geometry/duration block, the CV collapse rate was 82% in
the log10(rcond) ≈ −3 bin, 72% at ≈ −2.5, and 0% at ≈ −2 and above — a
sharp risk gradient, reported as a risk, not a per-case proof (a formally
derived detection threshold landed at 10^−2.46 with weighted ROC-AUC 0.79).
Each live Global Fit method (CV, Constant
Acceleration, Kalman Smoother, Monte Carlo 1/2) shows it in its own **Fit
Diagnostics** folder in the Traverse menu (e.g. **Constant Velocity Fit Diagnostics**), along with whether the fitted
track actually sits on/behind the camera; the traverse-analysis gallery
attaches the same metadata to its linear-fit tiles and records it in the
report provenance.

Two limits:

- **It speaks for the CV family only.** A stationary-point, ground,
  ray-constrained or physics fit can still be meaningful when CV collapses
  (benchmarked: the stationary-point fit held ~8% error in scenes where CV
  sat at 100%). Poor conditioning is therefore *method-local* metadata — it
  is never folded into the analysis's global "range unobservable" flag,
  which speaks about every method at once.
- **It is a one-way warning.** Pointing noise can inflate apparent
  conditioning, so "good" is never a guarantee that the recovered range is
  right; only "poor" is load-bearing, as a warning that the fit's range is
  unreliable (measured high artifact risk), not a per-case proof that it is
  wrong.

#### Constant Velocity (CV)

**Model**: P(t) = P0 + V * t (6 unknowns: 3 position + 3 velocity)

**Method**: Perpendicular-distance least-squares. For each LOS ray with sensor origin S and unit direction D, the perpendicular projection matrix is:

    P_perp = I - D * D^T

This projects any vector onto the plane perpendicular to the ray. The predicted position P(t) should project to the same point as the sensor origin S:

    P_perp * P(t) = P_perp * S

Substituting the linear model and stacking all frames builds a 6x6 normal equation system `A^T A * x = A^T b`, solved by Gaussian elimination with partial pivoting.

**Soft range constraints**: After solving, the algorithm checks whether any predicted position falls behind its sensor (negative range) or beyond a maximum range. Violated frames add quadratic penalty terms to the normal equations, and the system is re-solved. This *discourages* impossible solutions without hard-clipping — it does not prevent them: on weak geometry the penalized re-solve still lands on or just behind the sensor (see "Range observability and collapse" above), which is why the live method surfaces the conditioning diagnostic instead of silently publishing the track.

**Minimum data**: the code attempts a solve with 2 frames, but each ray contributes at most two independent constraints, so 3 frames are needed before the six unknowns can be determined. Three is necessary, not sufficient: weak geometry stays rank-deficient with any number of frames (see "Fit conditioning").

**When to use**: Fits a straight line at constant speed with no user input. When the Fit Diagnostics folder reads poor conditioning, the benchmark measured a high collapse rate (see "Range observability and collapse" above). The residual measures fit to a straight-line model, not range accuracy.

**Limits**: Cannot capture turns, climbs, or speed changes. With fewer than 3 frames the system is underdetermined, so the fit is exact (zero residuals) regardless of the true trajectory. Prone to collapsing onto the sensor when the sensor's own path is (approximately) CV-representable — check the conditioning diagnostic.

#### Constant Acceleration (CA)

**Model**: P(t) = P0 + V * t + 0.5 * A * t^2 (9 unknowns: 3 position + 3 velocity + 3 acceleration)

**Method**: Same perpendicular-distance least-squares as CV, but with quadratic time terms in the design matrix. The design rows become `[P_perp | P_perp * tau | P_perp * 0.5 * tau^2]` where tau is normalized time.

**Time normalization**: Raw timestamps can span thousands of seconds. Without normalization, the t^2 columns grow to O(T^4) in the normal equations, making the 9x9 system numerically singular. The algorithm normalizes time to tau = (t - t0) / T_span, keeping all columns O(1). After solving, it un-scales: V_physical = V_scaled / T_span, A_physical = A_scaled / T_span^2.

**Minimum data**: the code attempts a solve with 3 frames, but nine unknowns need at least 5 frames (two constraints per ray) before the system can be determined. As with CV, that count is necessary, not sufficient.

**When to use**: When CV residuals are large, suggesting the target is maneuvering. CA captures one constant acceleration vector, which is any parabolic path: a steady speed change along a fixed heading, a ballistic arc, or a curve whose heading changes the way a parabola's does. It does not capture a constant-rate turn at constant speed (a circular arc, in the horizontal or the vertical plane), because that rotates the acceleration vector with the flight path; such a turn fits CA only over a short arc. Compare CV and CA residuals to judge whether the added complexity is justified.

**Limits**: Only captures constant acceleration. Targets that change their acceleration profile (e.g., turn then straighten) will show residuals at the transition. With fewer than 5 frames the system is underdetermined and the fit is exact regardless of the truth.

#### Kalman Smoother (RTS)

**Model**: 6-DOF constant-velocity state [Px, Py, Pz, Vx, Vy, Vz]

**Method**: Three-stage Rauch-Tung-Striebel forward-backward smoother:

1. **Initialization**: Seeds from the CV least-squares fit. This avoids the cold-start problem where the filter would otherwise place the target 1 meter from the first sensor — but the seed is only as good as the CV fit itself: on weak geometry the CV seed is already collapsed onto the sensor, and the smoother then grinds the whole track down to machine-zero range from the camera (measured in the benchmark). The CV conditioning diagnostic applies to the smoother too.

2. **Forward Kalman pass**: For each frame in time order:
   - **Predict**: propagate state forward using constant-velocity model: x_pred = F * x, P_pred = F * P * F^T + Q
   - **Update**: incorporate the LOS measurement using the perpendicular projection measurement model H = [(I - D*D^T) | 0_{3x3}], with innovation z - H*x_pred and Kalman gain K = P*H^T*(H*P*H^T + R)^{-1}

3. **Backward (RTS) smoother pass**: Starting from the last filtered state, runs backward. At each step computes the smoother gain G = P_filtered * F^T * P_predicted^{-1}, then combines the filtered estimate with future information: x_smooth = x_filtered + G * (x_smooth[next] - x_predicted[next]).

The backward pass is what distinguishes this from a plain Kalman filter. Every smoothed point incorporates information from all measurements, both past and future. How much the backward pass changes any given point depends on the covariances, the process and measurement noise settings, the timestep and the geometry; a plain filter with an uninformed start is corrected most near the start, but this filter is seeded from the all-frame CV fit, so no such rule applies here. One thing is exact: at the last frame the smoothed state is identical to the forward-filtered state, so smoothing never improves the end of the track. The forward pass is not a causal estimate either: its CV seed already used every frame in the window.

For excluded frames (gaps in the data), positions are linearly interpolated between the nearest smoothed states.

**Tuning parameters**:
- *Process Noise* (slider **KF Process**, a log10 exponent; default −4, i.e. 1e-4): A tuning scale for how far the state may depart from constant velocity between frames. Higher values let the filter track rapid maneuvers but produce noisier output. Lower values enforce smoother trajectories but may lag behind true motion. The code builds the process-noise block as q·dt² in every sub-block (position, velocity and their coupling), so this is not a physical velocity random-walk variance, it does not rescale consistently with frame rate, and it is not a calibrated variance.
- *Measurement Noise* (slider **KF Noise**, a log10 exponent; default 0, i.e. 1.0): variance on the projected positional pseudo-measurement (not an angular noise in degrees). Higher values tell the filter the LOS data is noisy, producing smoother output. Lower values trust the LOS data more closely.

**Minimum data**: 2 frames.

**When to use**: Smooths frame-to-frame noise *when the geometry supports range recovery at all*. The bidirectional smoothing gives more stable estimates than any of the sequential traversals, except at the final frame, where the smoothed point equals the forward-filtered point. Start with defaults, then adjust if the trajectory looks too smooth (increase process noise) or too noisy (increase measurement noise).

**Noise color matters** (measured, BOT Bench): the benchmark's operator-error
model is *autocorrelated* (drift, notice, re-centre), and at matched noise
power it hurts stiff trackers far more than white noise. In the
benchmark's recoverable regime, CV degraded ~4.7&times; under simulated
operator wobble vs matched-power white noise; the default smoother (1e-4)
~2.8&times;; a soft smoother (process noise 1e-3) was essentially immune
(0.9&times;) — at the price of a several-times-worse clean-data baseline. If
the sightlines come from hand or autotracker pointing rather than surveyed
attitude, results depend on process noise: 1e-4 and 1e-3 behave differently
under autocorrelated error, and neither is better in every case.

**Limits**: The constant-velocity process model means the filter assumes the target is not accelerating between frames. Rapid maneuvers will show as lag in the smoothed trajectory unless process noise is increased. Very large process noise makes the smoother degenerate toward the individual LOS measurements. The 6x6 matrix inversions can become numerically unstable for extremely ill-conditioned covariance matrices, though the implementation falls back to scaled identity in degenerate cases.

#### Monte Carlo

**Model**: Independent polynomial of configurable degree per axis: x(t) = a0 + a1*t + a2*t^2 + ...

**Method**: Random sampling with consensus scoring:

For each trial (default 1000):
1. Randomly select (order + 1) LOS frames without replacement.
2. Perturb each selected LOS direction by a random angle up to `losUncertaintyDeg` using Rodrigues rotation around a random perpendicular axis. The sensor origin is unchanged.
3. Sample a random range along each perturbed ray to get a 3D point.
4. Fit an exact polynomial through these points (Vandermonde system, one polynomial per axis).
5. Evaluate the candidate trajectory at all frames and score by mean angular error between predicted direction and actual LOS direction.

The trial with the lowest mean angular error wins.

**Parameters**:
- *Num Trials* (default 1000): More trials explore more of the solution space but take longer.
- *LOS Uncertainty* (default 2 degrees): The maximum random perturbation applied to each LOS direction. Should match your estimate of the actual LOS measurement error. Too small = the fit follows noise in the LOS data. Too large = the fit is too loose.
- *Polynomial Order* (default 1 = linear): Order 1 fits a straight line (like CV), order 2 fits a parabola (like CA), order 3 fits a cubic, etc. Higher orders need more frames and more trials.

**Minimum data**: (order + 1) frames.

**When to use**: When some LOS measurements may be significantly wrong (outliers, tracking glitches, bad frames). The random sampling means outlier frames are unlikely to be chosen in the winning trial, making this method naturally robust. Also useful as an independent cross-check against the least-squares methods.

**Limits**: Deterministic in production — the random sampling runs from a
fixed seed, so the same inputs give the same answer every time (pass a
different seed to vary it). For clean data, CV or CA will give more precise
results because they use all frames simultaneously rather than sampling
subsets. High polynomial orders (> 3) tend to overfit and produce wild
extrapolation beyond the data range. The scoring uses angular error rather
than perpendicular distance, which weights nearby points more heavily than
distant ones. **Both Monte Carlo variants inherit the CV fit's range
degeneracy**: their sampled ranges are centered on the CV solution, so when
CV collapses they search around a collapsed seed. Note one live/gallery
asymmetry: the analysis gallery's Monte Carlo sweep applies a 500 m floor to
its seed ranges, while the live Monte Carlo methods clamp a collapsed seed to
1 m — the live methods therefore rely on the Fit Diagnostics folder to flag
the collapse rather than a seed floor to mask it.

---

#### Wind Tracer

**Model**: P(t) = P0 + D(t; theta) — an unknown anchor P0 plus a displacement shape D that depends on nine physical parameters. D(0) = 0 by construction.

**What is different about it.** Two things, and both are about what is *not* searched.

*The anchor is eliminated, not guessed.* P0 enters the sightline residual linearly, so for any candidate shape the best anchor is a 3x3 normal-equation solve over every frame at once — variable projection, or separable least squares. There is therefore **no "initial range" parameter at all**: the range is triangulated by the whole clip rather than seeded at frame 0 and refined. Compare the Physics method, which searches `initialRange` inside a 12-parameter differential evolution, where range and wind trade against each other and the pair has to be explored jointly. Because the inner solve is closed form, the global seed can be an exhaustive **wind rose** over speed and bearing instead of a stochastic optimizer, which makes the method deterministic and fast (a few seconds on a 7,000-frame clip, most of it the rose).

*The camera operator is modelled.* A boresight is not a bearing to the object. When the sightlines come from where a human was pointing a turret — Sitrec's "Camera Center" LOS — the object wanders around inside the frame, so the sightline carries an unknown pointing error. The model assumes that error is up to about the frame half-width and correlated over tens of seconds. Every other method in this document treats that error as if it were the object moving.

It cannot simply be estimated away. A world-frame displacement of the target projects into the image as a signal at the **azimuth-sweep frequency** — the rate at which the sensor's bearing to the object rotates. Any nuisance model flexible enough to contain that frequency will absorb the trajectory instead, and a magnitude prior then only decides how the shared signal is split between them. Measured on the Aguadilla clip (291 degrees of sweep, 0.81 cycles over 234 s): a cubic spline with 10-25 s knots, or a Fourier basis reaching down to 1 cycle per clip, moves the fitted wind and altitude while "improving" the residual; a constant image-plane offset is worse still, because an incomplete sweep leaves it partly degenerate with the anchor.

So the nuisance basis is deliberately **high-pass** — Fourier modes from nMin to nMax cycles per clip, with nMin set automatically above the measured sweep. That column space cannot represent the slow trajectory signature. Across nMin = 2 to 4 and nMax = 8 to 60 the fitted wind moved by under 1 m/s and the altitudes by under 5 m, while the residual fell from 0.26 to 0.05 degrees.

**The vertical profile is thermodynamics, not a curve shape.** A lantern's vertical response time is under a second, so drag balances net buoyancy algebraically: w = sign(B-1) * vTerm * sqrt(|B-1|). **This is sign-symmetric — the method is not a descent-only fit.** The buoyancy ratio spans 0 to 2 about neutral, so the vertical rate reaches the terminal speed in *both* directions: 0 is a cold envelope with no lift, 2 is twice the lift. Measured against known truth at +2.0, +0.6, 0.0, -0.6 and -2.0 m/s, every case is recovered to within 0.02 m/s. The buoyancy ratio B moves because climbing into thinner air reduces lift (a restoring force that makes a lit lantern settle toward a neutral level rather than climb away), and because after flame-out the interior superheat decays with a lumped time constant. The parameters therefore have physical meaning and can be bounded: the fit limits the cold terminal fall speed vTerm to 1.6-3.2 m/s. A phenomenological rise/decay/sink curve has no such bound and can return a lantern that went out minutes ago and is still sinking at 0.3 m/s, a tenth of its terminal velocity. With vTerm bounded, the model rejects that solution.

**Parameters**: *Tracer Pointing σ* (degrees) is how far off the object the operator's boresight plausibly wanders — roughly the frame half-width. Larger values let the fit attribute more of the residual to camera motion rather than to the object. *Tracer Loose Shear* widens the wind-shear bound past its default range (-5e-4 to 1.2e-3 per metre, from a power-law wind profile over open sea at a few hundred metres). A fit that needs it has more shear than the default bound allows.

**Two vertical basins, and why the seeding matters.** A steady sink has two representations: still lit with the buoyancy below neutral, or already cooled and falling at terminal. They are separated by the flame-out event, and the cost surface between them is not a ridge but a **dead flat plateau** — once flame-out is past the clip end it has no effect on the trajectory at all, so a simplex sitting there sees exactly zero gradient in it. The global seed therefore sweeps the wind rose first, then crosses the best few winds with a set of *vertical regimes* including one on each side of flame-out, refines each briefly, and compares where they get to rather than where they start. Everything stays deterministic. (Before this, a synthetic 2 m/s sink came back as 0.98 m/s, 71 m from truth; after, -1.99 m/s and 22 m.)

**Reading the result.** The *Wind Tracer Result* folder reports the solved wind, the drift and descent, the range band, both residuals (to the raw boresight and after the operator model), and a caveat naming any pinned bound. **A pinned bound means the search was incomplete in that direction, not that the parameter is excluded beyond it.**

**Limits, stated plainly.**

- It does not correct the operator's SLOW pointing drift, and nothing can from a boresight alone. A pointing error whose correlation time approaches the clip length is absorbed into the fitted trajectory as a bias in range, heading and altitude, and leaves no residual behind. The high-pass basis removes only fast pointing error.
- **A smaller residual after the operator model is not a better answer.** Measured on a synthetic descending tracer with known truth, 12% gusts and a veering upper wind layer: on clean and white-noise sightlines the model roughly halves the distance to truth (12 and 19 m against 29 and 30 m without it), because the basis absorbs model mismatch the shape parameters cannot represent. But on *operator-colored* noise — the case it was built for — it is a wash with high variance: sweeping the upper cutoff gave 11 to 37 m against 29 m without it, scatter rather than a trend, while the reported residual improved every time (0.21 to 0.09 degrees). The injected error lives inside the basis's own band, so how much of it the fit grabs depends on which optimum it lands in. The gallery compares methods on the raw residual.
- The basis can absorb genuine object motion that falls inside its band — gusts, small-scale wind variation. It cannot absorb the operator's slow drift, and it should not be asked to: the low cutoff exists to stop it trying.
- It constrains wind DIRECTION far more tightly than wind SPEED. On the Aguadilla clip the residual is minimised sharply at one bearing for every speed tried, while the speed is only bracketed to roughly a factor of two.
- A good residual means the sightlines are compatible with a wind tracer. It does not identify the object.

---

### Comparing Sequential vs. Global

| Aspect | Sequential | Global Fit |
|--------|-----------|------------|
| User input needed | Start distance, speed, heading, etc. | None (or noise parameters for KF/MC) |
| Noise | Errors compound forward | All frames enter the fit |
| Physical assumption | Explicit (constant speed, altitude, heading) | Kinematic (constant velocity, acceleration, or smooth polynomial) |
| Start/end effects | First frame anchored by start distance; last frames accumulate error | Every point uses all frames; the KF smoother's last point equals the forward filter's, and where it changes the rest depends on the noise settings and geometry |
| Computational cost | O(N) per frame | O(N) for CV/CA and for KF (fixed-size 6x6 recursions per frame), O(N * trials) for MC |
| Maneuvering targets | Some methods allow it (constant altitude, perspective) | CA fits one constant acceleration; MC fits polynomials of the chosen order; KF follows maneuvers only as far as process noise allows |

**Global Fit: Constant Velocity** needs no input, so it gives a quick baseline when its conditioning is not poor. **Constant Acceleration** allows a speed change or curve, the **Kalman Smoother** smooths frame-to-frame noise, and **Monte Carlo** keeps the best of many perturbed trials. Sequential traversals test specific physical assumptions.

---

---

## Where to go next

- **[Traverse Analysis and the Verdict](TraverseAnalysis.md)** — the *Analyze Traverse
  Methods…* button: running every method at once, reading the hypothesis gallery, solution
  families and range bands, and the executive verdict.
