# Traverse Methods

A **traverse** finds a 3D position for each frame by combining a Line of Sight (LOS) with some physical assumption. Each LOS frame provides a sensor position and a direction vector. The traverse decides *where along* (or near) that ray the target is.

> ## Read this before you read the table
>
> A camera measures **direction**, not distance. Given the sensor positions **S**(t) and the
> directions **D**(t) it observed, *every* range profile *R*(t) produces a path
> **S**(t) + *R*(t)·**D**(t) that reproduces the sightlines **exactly**. There are infinitely
> many of them, and they range from a moth a metre from the lens to something enormous far away.
>
> So a traverse that threads every line of sight perfectly is not evidence of anything. It is
> arithmetic. **A traverse is a hypothesis you have chosen, not a measurement you have made** —
> what picks one path out of the infinite family is the assumption you added, and every speed,
> size, altitude and acceleration you read off it inherits that assumption.
>
> The one thing that genuinely constrains range is **parallax**: the sensor has to move
> *around* the sightlines, not just along them. A stationary camera, or one flying straight at
> the target, provides none — and on those scenes the fits below will still return confident,
> low-residual answers that mean nothing. See
> [Doing Defensible Analysis](DefensibleAnalysis.md) for how to tell the difference.

Sitrec offers two families of traverse:

- **Sequential traversals** process frames one at a time, propagating state forward. Each frame's result depends on the previous frame.
- **Global fits** use every LOS ray in the fitted window to determine the whole trajectory, so no start distance is needed. Most solve all frames in one step; the Kalman Smoother still propagates state frame to frame, but its CV seed and backward pass make every output point depend on all frames.

---

## Quick Reference

### Sequential Traverses

| Method | Key Parameters | What It Does | You must assume | It does NOT establish |
|--------|---------------|--------------|-----------------|-----------------------|
| **Constant Distance** | Start Distance | Places the target at a fixed distance along each LOS ray. Distance interpolates linearly from start to end if both are given. | The range | Anything. The range is 100 % your input, and every speed, size and acceleration scales with it |
| **Constant Ground Speed** | Start Distance, Target Speed | Finds the point on each LOS ray that maintains a fixed ground speed from the previous frame. | The speed, the start range, and that every earlier frame was right | The speed (you supplied it) or the range. Errors compound forward and never self-correct |
| **Constant Air Speed** | Start Distance, Target Speed, Wind | Same as ground speed, but subtracts wind to maintain constant airspeed. | All of the above **plus** that the wind field is right at the target's unknown altitude | The same — and wind error and range error are confounded, so you cannot separate them from sightlines alone |
| **Straight Line** | Start Distance, Heading | Moves in a fixed compass heading. Each frame intersects the LOS ray with a vertical plane aligned to that heading. | Perfectly straight horizontal motion on a heading you supply | The heading. Curvature shows up as residual you cannot attribute between "it wasn't straight" and "your heading is wrong" |
| **Fixed Line** | Start Distance, Heading, Speed | Moves at a fixed speed in a fixed heading, ignoring the LOS after the first frame. Legacy; works poorly far from the origin. | Speed and heading | Anything — after frame 0 it is not constrained by the data at all. **Do not use for analysis** |
| **Constant Altitude** | Start Distance *or* Altitude, Vertical Speed | Intersects each LOS ray with a sphere (or WGS84 ellipsoid) at a constant geodetic altitude. Optional vertical speed for climb/descent. | The altitude (or start range) — **and that your altitude datum is right** | The altitude. Near-tangent sightlines give discontinuous jumps. Ignores terrain |
| **Starting Altitude** | Start Altitude, Vertical Speed | Like Constant Altitude but takes an explicit altitude value from a GUI slider rather than deriving it from start distance. | As above | As above |
| **Windblown Object** | Start Distance, Wind | Places the target at the start distance on the first LOS, then drifts it by the wind vector each frame. Ignores subsequent LOS rays. | That the object is a passive wind tracer, that the wind is right, and the start range | Anything about the object. This is a forward simulation, not a fit — later sightlines are never consulted. Their *agreement* with it is the only evidence here |
| **Close to Target** | Target track | Finds the closest point on each LOS ray to a separately defined target position. | That a separately-known target track exists | Anything independent — it is a diagnostic of angular error against a track you already had |
| **Perspective** | Start Distance, 3 keyframes | Derives a depth-velocity model from three screen-space keyframes, then linearly interpolates two 3D endpoints. Models perspective-induced apparent acceleration. | Perfectly linear 3D motion, exactly three keyframes, and a correct FOV | Non-linear motion. Extremely sensitive to where you place the keyframe pixels |
| **Terrain** | Terrain mesh | Intersects each LOS ray with the loaded terrain mesh. Expensive; samples every 60 frames and interpolates. | That the object is on the ground, and that the terrain model is accurate there | Anything above ground level. Limited by the elevation model's resolution in both directions |
| **Const Air AB** | (derived from Constant Air Speed) | Interpolates a straight line between the first and last frame of the Constant Air Speed traverse. Useful for comparison. | As Constant Air Speed | Anything — it is a comparison aid |

### Global Fits

In the menu most of these appear with a "Global Fit:" prefix (e.g. "Global Fit: Constant
Velocity"); *Ground Vehicle* is listed without it.

⚠ = this method belongs to the constant-velocity family and can **collapse onto the sensor**
on narrow-baseline scenes, returning a near-zero residual for a range that is an artifact.
Check Fit Diagnostics before quoting any range from one — see "Fit conditioning" below.

| Method | Min Frames | Key Parameters | What It Does | You must assume | It does NOT establish |
|--------|-----------|---------------|--------------|-----------------|-----------------------|
| **Constant Velocity** ⚠ | 2 (3 for a determined fit) | (none) | Fits a straight-line trajectory P(t) = P0 + V*t that minimizes perpendicular distance to all LOS rays. | Straight-line motion at constant velocity, and enough parallax to pin range | **The range.** Below 3 frames the system is underdetermined and fits exactly regardless of the truth |
| **Constant Acceleration** ⚠ | 3 (5 for a determined fit) | (none) | Fits a parabolic trajectory P(t) = P0 + V*t + 0.5*A*t^2: one constant acceleration vector, so a parabolic path: a straight-line speed change, a ballistic arc, or a curve whose heading changes the way a parabola's does. A constant-rate turn at constant speed (a circular arc) rotates its acceleration vector and is not constant acceleration; it fits CA only over a short arc. | Constant acceleration | The range (same collapse family). Below 5 frames the system is underdetermined and fits exactly regardless of the truth |
| **Kalman Smoother** ⚠ | 2 (via the CV seed) | Process Noise, Measurement Noise | Runs a Kalman filter forward then backward (RTS smoother). Every point benefits from all measurements past and future. Tunable noise balance. | A constant-velocity process between frames; the noise settings are *tuning knobs*, not calibrated variances | The range (it is seeded from the CV fit). **Its covariance is not a real uncertainty and must never be published as an error bar** |
| **Monte Carlo 1** ⚠ | 2 | Num Trials, LOS Uncertainty (deg), Polynomial Order | Randomly samples points along perturbed LOS rays (using a CV fit for focused per-frame range estimates), fits polynomials, and keeps the best trial. Robust to outliers. | Polynomial motion of the order you chose, and that your LOS Uncertainty matches the real pointing error | The range (CV-seeded). **This is not a posterior** — it keeps the single best trial, so the spread of trials is a function of your guessed uncertainty, not of the data |
| **Monte Carlo 2** ⚠ | 2 | Num Trials, LOS Uncertainty (deg), Polynomial Order | Least-squares variant: perturbs all frames each trial and fits an overdetermined polynomial, giving more stable results at higher polynomial orders. | As above | As above |
| **Physics** | 2 | Physics Model, Make/Model, Max Iterations, Wind, Initial Range | RK4 integration of a physical dynamics model — Sky Lantern (wind-drift kinematics with a rise/decay/sink life cycle), Fixed Wing Aircraft, or Quadcopter (hover-capable multirotor), chosen with the Physics Model selector — fit with differential evolution plus Nelder-Mead polish. Fixed-wing and quadcopter offer a make/model sub-selector (AUTO reports the closest match). | That the chosen model's dynamics apply, within the search bounds | **That the object was that thing.** A good residual means the sightlines are *compatible* with that model, not that the object is one. A fit that hits a bound is incomplete, not an exclusion |
| **Minimum Acceleration** | 2 | Target Speed, Min/Max Dist limits | Finds the acceleration-minimizing path that follows the rays. Finds its own range — purely from geometry when the sensor's own motion pins it, falling back to Target Speed as a soft tiebreaker on narrow-baseline scenes. (Formerly "Plausible"; saved sitches still serialize the menu key "Global Fit: Plausible".) See [Traverse Analysis](TraverseAnalysis.md). | A smooth range profile; on flat geometry, a speed prior | The range **whenever the speed prior is doing the work** — the indicator tells you which case you are in. When it is, the range is a consequence of your Target Speed and must be reported that way |
| **Minimum Speed** | 2 | (none) | Finds the slowest object consistent with the sightlines — the drifting-lantern / near-static reading. See [Traverse Analysis](TraverseAnalysis.md). | Nothing about the object type | That the object *was* slow. This is the **lower bound** of the family by construction, not an estimate |
| **Stationary Point** | 2 | (none) | The single fixed world position that best fits every sightline (closed-form least squares). The object simply does not move — the live method behind the analysis gallery's "Stationary Point in Space" tile. No on-ray traverse can represent this: walking the rays at speed 0 still moves by the rays' closest-approach distance each frame, drifting and flagging over-speed (white) segments. | That the object did not move | That it was stationary — only how well a stationary object would fit |
| **Ground Object** | 2 | (none) | The Stationary Point fit pinned to a curved constant-elevation shell sampled near the local terrain. Live method behind the gallery's "Ground Object" tile. | That the object sits at local ground elevation | That it was on the ground |
| **Wind Tracer** | 8 | Pointing σ, Loose Shear | Fits a passively drifting object — rising, neutrally buoyant or sinking (lantern, balloon, debris) — whose ANCHOR is eliminated in closed form rather than searched as a start distance, and models the camera operator's own boresight motion with a nuisance basis band-limited above the azimuth-sweep frequency. Deterministic; seeded by a wind rose. | That the object is a passive wind tracer in a horizontally uniform wind, and that the operator's pointing error has no power at the azimuth-sweep frequency | **That the object was a lantern** — a low residual says the sightlines are *compatible* with a wind tracer. It does not remove the operator's SLOW pointing drift (nothing can, from a boresight alone), and it establishes wind DIRECTION far better than wind SPEED |
| **Ground Vehicle** | 2 | (none) | The moving point where each sightline meets that curved constant-elevation shell. Live method behind the gallery's "Ground Vehicle" tile; frames whose sightline never reaches it hold the last valid position. This is not a DEM-following trajectory. | As above, while moving | That it was on the ground. Note this follows a smooth shell, not the actual terrain |

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
Do not interpret that fallback as an A-B result; widen the interval before
using a live Global Fit.

---

## In Depth

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

If `startDist` and `endDist` are both given, distance interpolates linearly across frames. If `VcMPH` (closing velocity) is given, the end distance is computed from the start distance and the closing rate.

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

The target's altitude is free to vary (it's wherever the ray hits the heading plane). The heading is controlled by two parameters: `initialHeading` (the base direction) and `targetRelativeHeading` (an offset added to it).

**Limits**: Assumes perfectly straight horizontal motion. Any curvature in the true path shows up as residual error. Works well for short segments of level flight.

#### Fixed Line

Legacy method. Computes a forward vector from the heading at the first frame's position, then simply adds `speed * dt * forward` each frame. Does not re-intersect with the LOS after frame 0.

**Limits**: Only correct near the coordinate origin. Not geodetically aware. Kept for backward compatibility with old saves.

#### Windblown Object

Places the target at `startDist` along the first LOS ray, then adds the wind vector each frame. The target drifts passively with the wind, completely ignoring subsequent LOS data.

Useful for testing whether an object could be a wind-blown balloon or debris.

**Limits**: Only meaningful if the true object is indeed drifting with the wind. No LOS feedback after frame 0.

#### Constant Altitude

Intersects each LOS ray with a surface of constant geodetic altitude. Two modes:

1. **Start Distance mode**: derives the altitude from where the first LOS ray places the target at `startDist`, then maintains that altitude for all subsequent frames.
2. **Altitude mode**: uses an explicit altitude value (from GUI or sitch data).

On a spherical earth model, this intersects with a sphere of radius `earthRadius + altitude`. On the WGS84 ellipsoid model (when equator and polar radii differ), it scales the ellipsoid semi-axes by `(a + alt) / a` and `(b + alt) / b` and solves the quadratic ray-ellipsoid intersection.

Optional `verticalSpeed` adds a linear altitude change over time (climb or descent).

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

**Limits**: Assumes perfectly linear 3D motion. Only works with specific "Perspective" keyframe types. Primarily useful for the Aguadilla and similar cases where perspective effects dominate apparent motion.

#### Terrain

Intersects each LOS ray with loaded terrain mesh geometry using Three.js raycasting. Because mesh intersection is expensive, it only samples every 60 frames and linearly interpolates between samples.

**Limits**: Requires a terrain model to be loaded. Resolution limited by terrain mesh density and the 60-frame sampling interval. Not suitable for fast-moving targets above terrain.

---

### Global Fits

All global fits operate in a local East-North-Up (ENU) coordinate system centered on the mean sensor position. The conversion from ECEF to ENU keeps numbers small and the flat-earth approximation valid for typical analysis scenes (< 100 km extent). Results are converted back to ECEF for display.

Unlike sequential traversals, global fits have no start distance parameter: every sightline in the window takes part in determining the whole trajectory. CV, CA and the polynomial fits solve all frames in one step; the Kalman Smoother propagates state frame to frame but is seeded from the all-frame CV fit and smoothed backward, so its output also depends on every frame.

#### Range observability and collapse (CV-family conditioning)

Bearings-only data only determines range through **parallax**: the sensor has
to move *around* the sightlines, not just along them. When the sensor flies a
path the constant-velocity model can represent — straight and level cruise
exactly, a gently curving arc over a short clip approximately — the sensor's
own trajectory is a (near-)zero-residual solution to every
perpendicular-distance fit, and the CV family (Constant Velocity, Constant
Acceleration, the Kalman smoother whose process model is CV, and the Monte
Carlo / polynomial fits that are seeded from CV) tends to **collapse onto the
camera**: the "object" lands metres from the sensor, usually behind it. The
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
Acceleration, Kalman Smoother, Monte Carlo 1/2) shows it in a **Fit
Diagnostics** folder in the Traverse menu, along with whether the fitted
track actually sits on/behind the camera; the traverse-analysis gallery
attaches the same metadata to its linear-fit tiles and records it in the
report provenance.

Two honest limits, both deliberate:

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

**When to use**: First thing to try — *after checking the Fit Diagnostics folder*. If the conditioning reads poor, the geometry gives CV-family fits little to work with: the measured collapse risk is high and the fitted range should be treated as unreliable no matter how clean the residuals look. Otherwise, if the target is moving in a roughly straight line at roughly constant speed, CV will find it with no user input. The residuals tell you how well a straight-line model fits — they do not tell you the range is right.

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

1. **Initialization**: Seeds from the CV least-squares fit. This avoids the cold-start problem where the filter would otherwise place the target 1 meter from the first sensor — but the seed is only as good as the CV fit itself: on weak geometry the CV seed is already collapsed onto the sensor, and the smoother then grinds the whole track down to machine-zero range from the camera (measured in the benchmark). Check the conditioning diagnostic before trusting the smoother's range.

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

**When to use**: Strong on noisy data *when the geometry supports range recovery at all*. The bidirectional smoothing gives more stable estimates than any of the sequential traversals, except at the final frame, where the smoothed point equals the forward-filtered point. Start with defaults, then adjust if the trajectory looks too smooth (increase process noise) or too noisy (increase measurement noise).

**Noise color matters** (measured, BOT Bench): real operator tracking error is
*autocorrelated* — the operator drifts, notices, corrects — and at matched
noise power it hurts stiff trackers far more than white noise. In the
benchmark's recoverable regime, CV degraded ~4.7&times; under simulated
operator wobble vs matched-power white noise; the default smoother (1e-4)
~2.8&times;; a soft smoother (process noise 1e-3) was essentially immune
(0.9&times;) — at the price of a several-times-worse clean-data baseline. If
the sightlines come from hand or autotracker pointing rather than surveyed
attitude, a process-noise sensitivity sweep across 1e-4 to 1e-3 is worth the
minute it takes; neither setting is universally superior.

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
- *Num Trials* (default 1000): More trials explore more of the solution space but take longer. Around 1000 is usually sufficient for linear or quadratic fits.
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

*The camera operator is modelled.* A boresight is not a bearing to the object. When the sightlines come from where a human was pointing a turret — Sitrec's "Camera Center" LOS — the object wanders around inside the frame, so the sightline carries an unknown pointing error bounded roughly by the frame half-width and strongly autocorrelated: the operator drifts off, notices, re-centres, over tens of seconds. Every other method in this document treats that error as if it were the object moving.

It cannot simply be estimated away, and the reason is worth stating because it is a general result about this class of fix. A world-frame displacement of the target projects into the image as a signal at the **azimuth-sweep frequency** — the rate at which the sensor's bearing to the object rotates. Any nuisance model flexible enough to contain that frequency will absorb the trajectory instead, and a magnitude prior then only decides how the shared signal is split between them. Measured on the Aguadilla clip (291 degrees of sweep, 0.81 cycles over 234 s): a cubic spline with 10-25 s knots, or a Fourier basis reaching down to 1 cycle per clip, moves the fitted wind and altitude while "improving" the residual; a constant image-plane offset is worse still, because an incomplete sweep leaves it partly degenerate with the anchor.

So the nuisance basis is deliberately **high-pass** — Fourier modes from nMin to nMax cycles per clip, with nMin set automatically above the measured sweep. That column space cannot represent the slow trajectory signature. Across nMin = 2 to 4 and nMax = 8 to 60 the fitted wind moved by under 1 m/s and the altitudes by under 5 m, while the residual fell from 0.26 to 0.05 degrees.

**The vertical profile is thermodynamics, not a curve shape.** A lantern's vertical response time is under a second, so drag balances net buoyancy algebraically: w = sign(B-1) * vTerm * sqrt(|B-1|). **This is sign-symmetric — the method is not a descent-only fit.** The buoyancy ratio spans 0 to 2 about neutral, so the vertical rate reaches the terminal speed in *both* directions: 0 is a cold envelope with no lift, 2 is twice the lift. Measured against known truth at +2.0, +0.6, 0.0, -0.6 and -2.0 m/s, every case is recovered to within 0.02 m/s. The buoyancy ratio B moves because climbing into thinner air reduces lift (a restoring force that makes a lit lantern settle toward a neutral level rather than climb away), and because after flame-out the interior superheat decays with a lumped time constant. The parameters are then bounded by measurement rather than by taste: static force-balance tests on 38 real sky lanterns give a cold terminal fall speed of 1.6-3.2 m/s and burn times of 100-330 s. That bound is load-bearing. A phenomenological rise/decay/sink curve is free to return a lantern that went out minutes ago and is still sinking at 0.3 m/s — a cold paper bag falling at a tenth of its terminal velocity. That is not a worse fit; it is an impossible object, and only a bounded vTerm makes the model able to say so.

**Parameters**: *Tracer Pointing σ* (degrees) is how far off the object the operator's boresight plausibly wanders — roughly the frame half-width. Larger values let the fit attribute more of the residual to camera motion rather than to the object. *Tracer Loose Shear* widens the wind-shear bound past its physical marine value (about 5e-4 per metre); a fit that needs it is telling you the drift decelerates more than any ordinary wind profile can explain.

**Two vertical basins, and why the seeding matters.** A steady sink has two representations: still lit with the buoyancy below neutral, or already cooled and falling at terminal. They are separated by the flame-out event, and the cost surface between them is not a ridge but a **dead flat plateau** — once flame-out is past the clip end it has no effect on the trajectory at all, so a simplex sitting there sees exactly zero gradient in it. The global seed therefore sweeps the wind rose first, then crosses the best few winds with a set of *vertical regimes* including one on each side of flame-out, refines each briefly, and compares where they get to rather than where they start. Everything stays deterministic. (Before this, a synthetic 2 m/s sink came back as 0.98 m/s, 71 m from truth; after, -1.99 m/s and 22 m.)

**Reading the result.** The *Wind Tracer Result* folder reports the solved wind, the drift and descent, the range band, both residuals (to the raw boresight and after the operator model), and — the line that matters most — a caveat naming any pinned bound. **A pinned bound means the search was incomplete in that direction, not that the parameter is excluded beyond it.**

**Limits, stated plainly.**

- It does not correct the operator's SLOW pointing drift, and nothing can from a boresight alone. A pointing error whose correlation time approaches the clip length is absorbed into the fitted trajectory as a bias in range, heading and altitude, and leaves no residual behind. The honest claim is narrower: the fit declines to let *fast* operator wobble bias the physics.
- **A smaller residual after the operator model is not a better answer.** Measured on a synthetic descending tracer with known truth, 12% gusts and a veering upper wind layer: on clean and white-noise sightlines the model roughly halves the distance to truth (12 and 19 m against 29 and 30 m without it), because the basis absorbs model mismatch the shape parameters cannot represent. But on *operator-colored* noise — the case it was built for — it is a wash with high variance: sweeping the upper cutoff gave 11 to 37 m against 29 m without it, scatter rather than a trend, while the reported residual improved every time (0.21 to 0.09 degrees). The injected error lives inside the basis's own band, so how much of it the fit grabs depends on which optimum it lands in. Quote the *raw* residual when comparing this method against the others.
- The basis can absorb genuine object motion that falls inside its band — gusts, small-scale wind variation. It cannot absorb the operator's slow drift, and it should not be asked to: the low cutoff exists to stop it trying.
- It constrains wind DIRECTION far more tightly than wind SPEED. On the Aguadilla clip the residual is minimised sharply at one bearing for every speed tried, while the speed is only bracketed to roughly a factor of two.
- A good residual means the sightlines are compatible with a wind tracer. It is not evidence that the object was one, and it is certainly not evidence that it was a lantern.

---

### Comparing Sequential vs. Global

| Aspect | Sequential | Global Fit |
|--------|-----------|------------|
| User input needed | Start distance, speed, heading, etc. | None (or noise parameters for KF/MC) |
| Handles noisy data | Poorly; errors compound forward | Well; all data considered at once |
| Physical assumption | Explicit (constant speed, altitude, heading) | Kinematic (constant velocity, acceleration, or smooth polynomial) |
| Start/end effects | First frame anchored by start distance; last frames accumulate error | Every point uses all frames; the KF smoother's last point equals the forward filter's, and where it changes the rest depends on the noise settings and geometry |
| Computational cost | O(N) per frame | O(N) for CV/CA and for KF (fixed-size 6x6 recursions per frame), O(N * trials) for MC |
| Maneuvering targets | Some methods handle (constant altitude, perspective) | CA, KF, MC all handle maneuvering |

In practice, start with **Global Fit: Constant Velocity** to get a baseline. If residuals are large, try **Constant Acceleration**. For noisy data, use the **Kalman Smoother**. Use **Monte Carlo** when you suspect outlier frames. Then compare against sequential traversals with specific physical assumptions to test hypotheses about the target's behavior.

---

---

## Where to go next

- **[Traverse Analysis and the Verdict](TraverseAnalysis.md)** — the *Analyze Traverse
  Methods…* button: running every method at once, reading the hypothesis gallery, solution
  families and range bands, and the executive verdict. What each verdict wording does and
  does not license is in [Doing Defensible Analysis §7](DefensibleAnalysis.md#7-reading-the-executive-verdict-without-over-reading-it).
- **[Doing Defensible Analysis](DefensibleAnalysis.md)** — the method around the methods:
  what to check before you fit, what a residual licenses, what to do about uncertainty, and
  how to write a result up.
