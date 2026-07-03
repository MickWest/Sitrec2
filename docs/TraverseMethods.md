# Traverse Methods

A **traverse** finds a 3D position for each frame by combining a Line of Sight (LOS) with some physical assumption. Each LOS frame provides a sensor position and a direction vector. The traverse decides *where along* (or near) that ray the target is.

Sitrec offers two families of traverse:

- **Sequential traversals** process frames one at a time, propagating state forward. Each frame's result depends on the previous frame.
- **Global fits** (new) consider all LOS rays at once, finding the trajectory that best explains the entire dataset. No per-frame state propagation.

---

## Quick Reference

### Sequential Traversals

| Method | Key Parameters | What It Does |
|--------|---------------|--------------|
| **Constant Distance** | Start Distance | Places the target at a fixed distance along each LOS ray. Distance interpolates linearly from start to end if both are given. |
| **Constant Ground Speed** | Start Distance, Target Speed | Finds the point on each LOS ray that maintains a fixed ground speed from the previous frame. |
| **Constant Air Speed** | Start Distance, Target Speed, Wind | Same as ground speed, but subtracts wind to maintain constant airspeed. |
| **Straight Line** | Start Distance, Heading | Moves in a fixed compass heading. Each frame intersects the LOS ray with a vertical plane aligned to that heading. |
| **Fixed Line** | Start Distance, Heading, Speed | Moves at a fixed speed in a fixed heading, ignoring the LOS after the first frame. Legacy; works poorly far from the origin. |
| **Constant Altitude** | Start Distance *or* Altitude, Vertical Speed | Intersects each LOS ray with a sphere (or WGS84 ellipsoid) at a constant geodetic altitude. Optional vertical speed for climb/descent. |
| **Starting Altitude** | Start Altitude, Vertical Speed | Like Constant Altitude but takes an explicit altitude value from a GUI slider rather than deriving it from start distance. |
| **Windblown Object** | Start Distance, Wind | Places the target at the start distance on the first LOS, then drifts it by the wind vector each frame. Ignores subsequent LOS rays. |
| **Close to Target** | Target track | Finds the closest point on each LOS ray to a separately defined target position. |
| **Perspective** | Start Distance, 3 keyframes | Derives a depth-velocity model from three screen-space keyframes, then linearly interpolates two 3D endpoints. Models perspective-induced apparent acceleration. |
| **Terrain** | Terrain mesh | Intersects each LOS ray with the loaded terrain mesh. Expensive; samples every 60 frames and interpolates. |
| **Const Air AB** | (derived from Constant Air Speed) | Interpolates a straight line between the first and last frame of the Constant Air Speed traverse. Useful for comparison. |

### Global Fits

In the menu these appear with a "Global Fit:" prefix (e.g. "Global Fit: Constant Velocity").

| Method | Min Frames | Key Parameters | What It Does |
|--------|-----------|---------------|--------------|
| **Constant Velocity** | 2 | (none) | Fits a straight-line trajectory P(t) = P0 + V*t that minimizes perpendicular distance to all LOS rays. |
| **Const Acceleration** | 3 | (none) | Fits a parabolic trajectory P(t) = P0 + V*t + 0.5*A*t^2. Captures turns, climbs, decelerations. |
| **Kalman Smoother** | 2 | Process Noise, Measurement Noise | Runs a Kalman filter forward then backward (RTS smoother). Every point benefits from all measurements past and future. Tunable noise balance. |
| **Monte Carlo 1** | 2 | Num Trials, LOS Uncertainty (deg), Polynomial Order | Randomly samples points along perturbed LOS rays (using a CV fit for focused per-frame range estimates), fits polynomials, and keeps the best trial. Robust to outliers. |
| **Monte Carlo 2** | 2 | Num Trials, LOS Uncertainty (deg), Polynomial Order | Least-squares variant: perturbs all frames each trial and fits an overdetermined polynomial, giving more stable results at higher polynomial orders. |
| **Physics** | 2 | Physics Model, Max Iterations, Wind, Initial Range | Nelder-Mead optimisation with RK4 integration of a physical dynamics model (currently a "Chinese Lantern" buoyancy/drag model) to fit a physically-plausible trajectory. |

---

## In Depth

### How LOS Works

Every LOS node provides per-frame data:
- **position**: the sensor location in ECEF (meters)
- **heading**: a unit vector pointing from the sensor toward the target

A traverse method takes this sequence of rays and produces a sequence of 3D positions, one per frame.

---

### Sequential Traversals

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

Unlike sequential traversals, global fits have no start distance parameter and no frame-to-frame state propagation. They see all the data at once and find the trajectory that best explains it.

#### Constant Velocity (CV)

**Model**: P(t) = P0 + V * t (6 unknowns: 3 position + 3 velocity)

**Method**: Perpendicular-distance least-squares. For each LOS ray with sensor origin S and unit direction D, the perpendicular projection matrix is:

    P_perp = I - D * D^T

This projects any vector onto the plane perpendicular to the ray. The predicted position P(t) should project to the same point as the sensor origin S:

    P_perp * P(t) = P_perp * S

Substituting the linear model and stacking all frames builds a 6x6 normal equation system `A^T A * x = A^T b`, solved by Gaussian elimination with partial pivoting.

**Soft range constraints**: After solving, the algorithm checks whether any predicted position falls behind its sensor (negative range) or beyond a maximum range. Violated frames add quadratic penalty terms to the normal equations, and the system is re-solved. This prevents physically impossible solutions without hard-clipping.

**Minimum data**: 2 frames (the system is exactly determined with 2 rays in general position, overdetermined with more).

**When to use**: First thing to try. If the target is moving in a roughly straight line at roughly constant speed, CV will find it with no user input. The residuals tell you how well a straight-line model fits.

**Limits**: Cannot capture turns, climbs, or speed changes. With only 2 frames the fit is exact (zero residuals) regardless of the true trajectory.

#### Constant Acceleration (CA)

**Model**: P(t) = P0 + V * t + 0.5 * A * t^2 (9 unknowns: 3 position + 3 velocity + 3 acceleration)

**Method**: Same perpendicular-distance least-squares as CV, but with quadratic time terms in the design matrix. The design rows become `[P_perp | P_perp * tau | P_perp * 0.5 * tau^2]` where tau is normalized time.

**Time normalization**: Raw timestamps can span thousands of seconds. Without normalization, the t^2 columns grow to O(T^4) in the normal equations, making the 9x9 system numerically singular. The algorithm normalizes time to tau = (t - t0) / T_span, keeping all columns O(1). After solving, it un-scales: V_physical = V_scaled / T_span, A_physical = A_scaled / T_span^2.

**Minimum data**: 3 frames (underdetermined below that).

**When to use**: When CV residuals are large, suggesting the target is maneuvering. CA captures constant turns, climbs, or decelerations. Compare CV and CA residuals to judge whether the added complexity is justified.

**Limits**: Only captures constant acceleration. Targets that change their acceleration profile (e.g., turn then straighten) will show residuals at the transition. With exactly 3 frames, the fit is exact.

#### Kalman Smoother (RTS)

**Model**: 6-DOF constant-velocity state [Px, Py, Pz, Vx, Vy, Vz]

**Method**: Three-stage Rauch-Tung-Striebel forward-backward smoother:

1. **Initialization**: Seeds from the CV least-squares fit to get a physically reasonable starting state. This avoids the cold-start problem where the filter would otherwise place the target 1 meter from the first sensor.

2. **Forward Kalman pass**: For each frame in time order:
   - **Predict**: propagate state forward using constant-velocity model: x_pred = F * x, P_pred = F * P * F^T + Q
   - **Update**: incorporate the LOS measurement using the perpendicular projection measurement model H = [(I - D*D^T) | 0_{3x3}], with innovation z - H*x_pred and Kalman gain K = P*H^T*(H*P*H^T + R)^{-1}

3. **Backward (RTS) smoother pass**: Starting from the last filtered state, runs backward. At each step computes the smoother gain G = P_filtered * F^T * P_predicted^{-1}, then combines the filtered estimate with future information: x_smooth = x_filtered + G * (x_smooth[next] - x_predicted[next]).

The backward pass is what distinguishes this from a plain Kalman filter. Every smoothed point incorporates information from all measurements, both past and future. This is especially valuable near the ends of the track where a forward-only filter has the least data.

For excluded frames (gaps in the data), positions are linearly interpolated between the nearest smoothed states.

**Tuning parameters**:
- *Process Noise* (default 1e-4): Velocity random walk variance per unit time. Higher values let the filter track rapid maneuvers but produce noisier output. Lower values enforce smoother trajectories but may lag behind true motion.
- *Measurement Noise* (default 1.0): LOS measurement component variance. Higher values tell the filter the LOS data is noisy, producing smoother output. Lower values trust the LOS data more closely.

**Minimum data**: 2 frames.

**When to use**: Best results on noisy data. The bidirectional smoothing gives more stable estimates than any of the sequential traversals, especially near the start and end of the track. The tunable noise parameters let you balance responsiveness vs. smoothness. Start with defaults, then adjust if the trajectory looks too smooth (increase process noise) or too noisy (increase measurement noise).

**Limits**: The constant-velocity process model means the filter assumes the target is not accelerating between frames. Rapid maneuvers will show as lag in the smoothed trajectory unless process noise is increased. Very large process noise makes the smoother degenerate toward the individual LOS measurements. The 6x6 matrix inversions can become numerically unstable for extremely ill-conditioned covariance matrices, though the implementation falls back to scaled identity in degenerate cases.

#### Monte Carlo

**Model**: Independent polynomial of configurable degree per axis: x(t) = a0 + a1*t + a2*t^2 + ...

**Method**: Random sampling with consensus scoring:

For each trial (default 500):
1. Randomly select (order + 1) LOS frames without replacement.
2. Perturb each selected LOS direction by a random angle up to `losUncertaintyDeg` using Rodrigues rotation around a random perpendicular axis. The sensor origin is unchanged.
3. Sample a random range along each perturbed ray to get a 3D point.
4. Fit an exact polynomial through these points (Vandermonde system, one polynomial per axis).
5. Evaluate the candidate trajectory at all frames and score by mean angular error between predicted direction and actual LOS direction.

The trial with the lowest mean angular error wins.

**Parameters**:
- *Num Trials* (default 500): More trials explore more of the solution space but take longer. 500 is usually sufficient for linear or quadratic fits.
- *LOS Uncertainty* (default 2 degrees): The maximum random perturbation applied to each LOS direction. Should match your estimate of the actual LOS measurement error. Too small = the fit follows noise in the LOS data. Too large = the fit is too loose.
- *Polynomial Order* (default 1 = linear): Order 1 fits a straight line (like CV), order 2 fits a parabola (like CA), order 3 fits a cubic, etc. Higher orders need more frames and more trials.

**Minimum data**: (order + 1) frames.

**When to use**: When some LOS measurements may be significantly wrong (outliers, tracking glitches, bad frames). The random sampling means outlier frames are unlikely to be chosen in the winning trial, making this method naturally robust. Also useful as an independent cross-check against the least-squares methods.

**Limits**: Non-deterministic (different runs give slightly different results). For clean data, CV or CA will give more precise results because they use all frames simultaneously rather than sampling subsets. High polynomial orders (> 3) tend to overfit and produce wild extrapolation beyond the data range. The scoring uses angular error rather than perpendicular distance, which weights nearby points more heavily than distant ones.

---

### Comparing Sequential vs. Global

| Aspect | Sequential | Global Fit |
|--------|-----------|------------|
| User input needed | Start distance, speed, heading, etc. | None (or noise parameters for KF/MC) |
| Handles noisy data | Poorly; errors compound forward | Well; all data considered at once |
| Physical assumption | Explicit (constant speed, altitude, heading) | Kinematic (constant velocity, acceleration, or smooth polynomial) |
| Start/end effects | First frame anchored by start distance; last frames accumulate error | Symmetric; all frames treated equally (KF smoother) |
| Computational cost | O(N) per frame | O(N) for CV/CA, O(N^2) for KF, O(N * trials) for MC |
| Maneuvering targets | Some methods handle (constant altitude, perspective) | CA, KF, MC all handle maneuvering |

In practice, start with **Global Fit: Constant Velocity** to get a baseline. If residuals are large, try **Constant Acceleration**. For noisy data, use the **Kalman Smoother**. Use **Monte Carlo** when you suspect outlier frames. Then compare against sequential traversals with specific physical assumptions to test hypotheses about the target's behavior.

---

## Physically Plausible Analysis (Analyze button & new fits)

LOS-only data never uniquely determines a trajectory: near-perfect fits exist
at many ranges, provided the object is allowed to maneuver. The tools in this
section make that ambiguity explicit, and resolve it with *soft physical
targets* (a preferred speed, roughly straight and level flight, low
maneuvering g) rather than exact constraints. The interesting output is the
family of plausible solutions — and how much maneuvering every *other*
interpretation would require.

### Global Fit: Plausible

**Model**: the range along each LOS ray is a smooth cubic B-spline λ(f)
(25 control points). The trajectory is always exactly on the rays.

**Method**: solves a small least-squares system minimizing

- maneuvering acceleration (in g), plus
- a soft air-speed target: `((airspeed − Target Speed)/σ)²` with σ ≈ 60 kt,
  linearized around the current estimate and re-solved a few times (IRLS),

anchored (softly) to the "Tgt Start Dist" slider at frame 0. It reads the same
**Tgt Start Dist** and **Target Speed** sliders as Const Air Spd — but where
Const Air Spd integrates forward *exactly* at that speed (compounding LOS
noise into the track), Plausible treats the speed as a loose target and finds
the least-maneuvering smooth path consistent with the rays.

**When to use**: as the "best fit" interpretation of a hypothesis like
"a ~350 kt aircraft at ~30 NM" — it shows what the *smoothest* version of that
hypothesis looks like, and its g-load/turn metrics quantify how plausible the
hypothesis is at that distance.

### Global Fit: Physics — Fixed Wing Aircraft model

The Physics fit now has a second dynamics model besides the Chinese Lantern:
a **fixed-wing aircraft** with constant TAS, a linearly-varying turn rate,
constant climb rate, and wind advection. Parameters (initial range, heading,
TAS, turn rate, turn acceleration, climb, wind E/N) are found with
**differential evolution** (a genetic-style global search) followed by
Nelder-Mead polish. The cost combines LOS angular error with the same soft
plausibility targets, so repeated runs converge to the same interpretable
answer instead of wandering across the ambiguous solution family.

Select the model with the **Physics Model** dropdown in the Traverse menu.
Solved parameters (range, heading, TAS, turn rate, climb, fit error) appear
in the Physics Fit Results folder.

### The Analyze button

**Traverse ▸ Analyze Traversals...** runs the full battery against the current
LOS data and generates a standalone HTML report (with charts) plus an option
to apply the best solution to the sliders:

1. **Constant-air-speed sweep** — a grid over (start distance × air speed),
   each combo scored for smoothness (g-load, turn-rate variability, climb).
   Surfaces the valley of straight-flight solutions (for Gimbal: ~30–32 NM,
   speed loosely 400–550 kt).
2. **Range profile** — for each assumed start range, the least-maneuvering
   spline solution with a fast-object (cruise speed) and a slow-object
   (drifting) speed target. Quantifies what an object at any given distance
   would *have* to do — e.g. at 6–8 NM the Gimbal object must nearly stop and
   whip through a rapid heading reversal, or sustain a continuous banked turn.
3. **Aircraft fit** — the differential-evolution fixed-wing fit, reported as
   interpretable parameters (range, heading, TAS, turn, climb).

The report contains an executive summary, a sweep heatmap, range-profile
curves, per-solution time series (speed / g / turn rate), a plan view of the
candidate tracks, and top-solution tables. Criteria are deliberately loose
targets; scores compare hypotheses, they are not hard physical limits.
