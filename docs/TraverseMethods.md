# Traverse Methods

A **traverse** finds a 3D position for each frame by combining a Line of Sight (LOS) with some physical assumption. Each LOS frame provides a sensor position and a direction vector. The traverse decides *where along* (or near) that ray the target is.

Sitrec offers two families of traverse:

- **Sequential traversals** process frames one at a time, propagating state forward. Each frame's result depends on the previous frame.
- **Global fits** (new) consider all LOS rays at once, finding the trajectory that best explains the entire dataset. No per-frame state propagation.

---

## Quick Reference

### Sequential Traverses

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
| **Constant Acceleration** | 3 | (none) | Fits a parabolic trajectory P(t) = P0 + V*t + 0.5*A*t^2. Captures turns, climbs, decelerations. |
| **Kalman Smoother** | 2 | Process Noise, Measurement Noise | Runs a Kalman filter forward then backward (RTS smoother). Every point benefits from all measurements past and future. Tunable noise balance. |
| **Monte Carlo 1** | 2 | Num Trials, LOS Uncertainty (deg), Polynomial Order | Randomly samples points along perturbed LOS rays (using a CV fit for focused per-frame range estimates), fits polynomials, and keeps the best trial. Robust to outliers. |
| **Monte Carlo 2** | 2 | Num Trials, LOS Uncertainty (deg), Polynomial Order | Least-squares variant: perturbs all frames each trial and fits an overdetermined polynomial, giving more stable results at higher polynomial orders. |
| **Physics** | 2 | Physics Model, Make/Model, Max Iterations, Wind, Initial Range | RK4 integration of a physical dynamics model — Sky Lantern (wind-drift kinematics with a rise/decay/sink life cycle), Fixed Wing Aircraft, or Quadcopter (hover-capable multirotor), chosen with the Physics Model selector — fit with differential evolution plus Nelder-Mead polish. Fixed-wing and quadcopter offer a make/model sub-selector (AUTO reports the closest match). |
| **Minimum Acceleration** | 2 | Target Speed, Min/Max Dist limits | Finds the acceleration-minimizing path that follows the rays. Finds its own range — purely from geometry when the sensor's own motion pins it, falling back to Target Speed as a soft tiebreaker on narrow-baseline scenes. (Formerly "Plausible"; saved sitches still serialize the menu key "Global Fit: Plausible".) See "Physically Plausible Analysis" below. |
| **Minimum Speed** | 2 | (none) | Finds the slowest object consistent with the sightlines — the drifting-lantern / near-static reading. See "Physically Plausible Analysis" below. |
| **Stationary Point** | 2 | (none) | The single fixed world position that best fits every sightline (closed-form least squares). The object simply does not move — the live method behind the analysis gallery's "Stationary Point in Space" tile. No on-ray traverse can represent this: walking the rays at speed 0 still moves by the rays' closest-approach distance each frame, drifting and flagging over-speed (white) segments. |
| **Ground Object** | 2 | (none) | The Stationary Point fit pinned to a curved constant-elevation shell sampled near the local terrain. Live method behind the gallery's "Ground Object" tile. |
| **Ground Vehicle** | 2 | (none) | The moving point where each sightline meets that curved constant-elevation shell. Live method behind the gallery's "Ground Vehicle" tile; frames whose sightline never reaches it hold the last valid position. This is not a DEM-following trajectory. |

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
kinematic acceleration) rather than exact constraints. The interesting output is the
family of plausible solutions — and how much maneuvering every *other*
interpretation would require.

### Global Fit: Minimum Acceleration

(Formerly "Global Fit: Plausible" — the display name now describes the
algorithm's objective rather than a claimed result; saved sitches still
serialize the original menu key.)

**Model**: the range along each LOS ray is a smooth cubic B-spline λ(f)
(25 control points). The trajectory follows the rays, with a soft range floor
(so it can never end up behind the camera) and a light output smoothing that
sheds frame-scale pointing jitter; the acceleration objective is measured
over ~half-second strides so that jitter cannot dominate it.

**Method**: two-stage. Stage 1 solves a pure-smoothness (no speed target)
coarse sweep over range: when the sensor itself maneuvers (an orbit, a hard
turn), geometry alone pins the range — the smoothness-vs-range valley is
decisive and the speed target is *not used* (the Minimum Acceleration Fit
Results folder shows "not needed (geometry)"). Only when that valley is flat — the classic
narrow-baseline case like Gimbal, where range is unobservable from geometry —
does Stage 2 fall back to the soft air-speed target
`((airspeed − Target Speed)/σ)²` with σ ≈ 60 kt (IRLS), which is then what
gives the plausibility-vs-range curve a real minimum. The winner is refined
and re-solved at full quality (the result appears as **Found Range**; the
**Min Dist** / **Max Dist** limits in Traverse Analysis Tweaks bound the
search). Where Constant Air Speed holds a speed *exactly*, Minimum
Acceleration treats speed (when used at all) as a loose target and finds the
smoothest path consistent with the rays.

**When to use**: as the "best fit" interpretation of a hypothesis like
"a ~350 kt aircraft at ~30 NM" — it shows what the *smoothest* version of that
hypothesis looks like, and its acceleration/turn metrics quantify how demanding the
hypothesis is at that distance.

### Global Fit: Minimum Speed

**Model**: the same on-the-rays B-spline range profile as Minimum
Acceleration, but the
objective is inverted: instead of the least-maneuvering path near a target
speed, it finds the **slowest** object consistent with the sightlines, then
applies a curvature-penalized smoothing pass that sheds sensor pointing
jitter (which would otherwise read as enormous kinematic acceleration on a slow object).

**When to use**: this is the drifting-lantern / near-static reading. When the
sensor orbits or passes a slow, close object, most of the apparent motion is
the sensor's own parallax — the slowest consistent object is then a
near-static drifter (the classic Aguadilla answer, ~12 kt). It takes no
parameters; the range follows from where the sightlines let an object move
least. A final few IRLS passes level the air speed over the first/last 15%
of the clip (the spline endpoints are data-starved, so without this the
speed graph of an exactly-constant-speed object read as a ±5 kt end wobble).
The Analyze gallery's **Minimum Speed** candidate uses this same fit, so
applying it reproduces exactly the previewed path.

### Global Fit: Physics — the dynamics models

The Physics fit integrates a real dynamics model forward with RK4 and fits
its parameters to the sightlines with **differential evolution** (a
genetic-style global search) followed by Nelder-Mead polish. Three models are
available via the **Physics Model** dropdown in the Traverse menu:

**Sky Lantern** — pure wind-drift kinematics. A sky lantern is a
near-perfect wind tracer (grams of mass, large drag area), so its horizontal
velocity *is* the wind at its current altitude: a solved wind vector with a
linear altitude shear (clamped so it can never reverse or blow up — the wind
aloft is allowed to be stronger, e.g. "wind from the east, increasing with
altitude"). The wind may also **vary smoothly across the clip** (a duration-
invariant linear + quadratic drift, priced by a variability prior so it cannot
wander without support), letting the balloon follow a gently curving drift as
real wind veers over minutes — a constant wind can only produce a straight
ground track. Vertical motion follows the lantern life cycle — rise while the
flame burns, exponential buoyancy decay after flame-out, terminal sink — and
the solved flame-out time can fall before the clip (a lantern already in its
cooling descent, the Aguadilla case), inside it, or after it (still climbing
throughout). The base-wind components are bounded to ±20 m/s, the shear
multiplier to 0.25–3, and rise/sink parameters to 4 m/s. Those are broad search
constraints, not a certified lantern envelope. Its residual measures
compatibility with this particular wind-tracer/life-cycle model, not the
probability that the object is a lantern. Bound-pinned and shear-clamped
solutions therefore need explicit scrutiny.

**Fixed Wing Aircraft** — constant horizontal airspeed, a linearly-varying turn rate,
constant climb rate, and wind advection. Parameters (initial range, heading,
horizontal airspeed, turn rate, turn acceleration, climb, wind E/N) share the same DE +
polish recipe; the cost combines LOS angular error with explicit soft targets
for speed, turn, climb, and (when supplied) wind. The generic conventional
prior searches 25–360 m/s horizontal airspeed and ±40 m/s climb. It does not
cover every fighter in the catalog, and a result on a bound makes this test
incomplete rather than excluding every possible fixed-wing aircraft.

**Quadcopter** — a hover-capable multirotor drone. Unlike a fixed-wing, it
needs no forward airspeed to stay aloft, so ground speed is free to fall to
zero (hover) or rise, the heading can swing on a wide turn budget, and it can
climb or descend far more steeply than a plane. Parameters (initial range,
heading, speed, along-track acceleration, turn rate/acceleration, climb, wind
E/N) fit with the same DE + polish recipe. A selected make/model bounds initial
speed and vertical rate and penalizes full-clip overspeed. The generic fit
permits initial ranges from 50 m to 20 km and air-relative horizontal speed up
to 60 m/s. This is a broad kinematic compatibility test: acceleration can push
the trajectory beyond nominal speed during the clip, so it is not a hard
flight-envelope certification.

**Make / model (Fixed-Wing and Quadcopter).** When Fixed Wing or Quadcopter is
selected, a second dropdown chooses a specific airframe/drone whose approximate
performance envelope tightens the fit bounds — Cessna 172, Boeing 737-800,
MQ-9 Reaper, F/A-18E/F, F-35, F-16; DJI Mini 4 Pro, Air 3, Mavic 3, Phantom 4
Pro, DJI FPV, Racing FPV. Both default to **AUTO**, which fits a generic
envelope and can report the closest compatible catalog envelope from speed,
climb, g, and altitude where available. Quadcopter climb capability is
direction-aware: a solved descent is checked against the drone's maximum
descent rate (usually the smaller number), not its climb rate. Catalog
figures are approximate values used to bracket and describe the search, not
exact specifications or IDs.

Solved parameters (wind, rates, fit error, and any selected/compatible catalog
envelope) appear in the Physics Fit Results folder. Residuals from different
models are not directly comparable object-type probabilities: the models have
different parameter counts, priors, bounds, and wind freedom. Use them as
model-conditioned diagnostics and inspect bound hits and sensitivity.

**Drone (flown inputs)** — a gallery-only companion to the free Quadcopter that
asks a different question. The free Quadcopter asks "is there *any* path inside
the envelope that fits?" — almost always yes, which is how it can produce a
many-revolution corkscrew that buys a tiny residual. The flown-inputs fit instead
models a drone as a *few held control inputs* (forward speed, yaw, climb, changed
occasionally): it seeds from the best geometric path, inverts it into the control
history needed to fly it, and refines while paying for control **effort** — how
much the inputs must move — rather than for path shape. Holding an input is free,
a steady orbit is cheap, and an aggressive-but-deliberate manoeuvre stays
reachable; only motion that buys no residual (the corkscrew) is priced out.
Reading the gap between its residual and the free Quadcopter's is the point: a
small gap means an ordinary flight explains the sightlines as well as any
contortion.

### Ground contact and underground rejection

LOS-only geometry can produce trajectories that pass **underground**. The
analysis samples each candidate against loaded terrain (falling back to the
reference surface) and demotes sustained penetration below the configured
tolerance. This is a rejection check, not a terrain-following solve.

Beyond that always-on check, the **Ground contact** selector in *Traverse
Analysis Tweaks* constrains the solution space to how the object touches the
ground:

- **Airborne (any)** — the default; no ground contact required (underground
  is still rejected).
- **On the ground** — adds a dedicated **Ground Vehicle** candidate: the point
  where each sightline meets a curved, constant-elevation shell near the local
  terrain height (distinct from the stationary *Ground Object*), then checks
  samples against the actual terrain. It does not follow changing DEM height
  over slopes or ridges.
- **Starts on ground** — takeoff, or a released balloon: the trajectory begins
  on the surface, then a portion is airborne.
- **Ends on ground** — landing, or a descending balloon: the trajectory ends on
  the surface.

The non-airborne modes also add a soft **ground prior** to the fixed-wing,
lantern and quadcopter fits, pulling the relevant endpoint(s) toward the
surface so the physics fits find takeoff/landing/release/descent solutions
rather than purely mid-air ones. This is gated: in the default Airborne mode
the fits are byte-identical to before.

### Analysis integrity

The analysis is engineered to be honest about what LOS-only data can and
cannot determine:

- **Deterministic global search**: the analysis injects seeds derived from the
  input/run into its stochastic searches and records optimizer metadata. This
  makes supported runs repeatable for the same code and inputs; it does not
  prove that a retained basin is the global optimum.
- **Physical fits are seeded from the smoother**: the balloon (with its wind free
  to vary over the clip) and the drone control-input candidate start from the
  best geometric approximation — the Kalman-smoother path — and refine from
  there, rather than searching their high-dimensional parameter spaces blind.
  The smoother is regularised, and its constant-velocity start is given an
  explicit 500 m range floor because regularisation alone cannot remove an LOS
  fit's degeneracy along range. The seed carries no truth and no object
  assumptions, but it can still affect convergence and which local basin is
  retained; the free
  Quadcopter is deliberately left unseeded as the unconstrained, anomaly-reachable
  fit. Because the drone fit then starts on a good path it needs only local
  refinement (Nelder-Mead from the seed), which is why it now solves in about a
  second where it once took tens.
- **Circular-LOS detection**: when the sightlines are *constructed* from the
  target being tested (Camera Heading = "To Target" with LOS Source = raw
  Camera Center), the gallery and verdict carry a prominent
  "Constructed LOS — validation only" banner. Fits recovering the target then
  confirm internal consistency, not an independent discovery.
- **No global object winner**: every tile carries a coloured **category label**
  — *Physically based* (balloon, drone, aircraft), *LOS Constrained* (constant
  air speed / altitude / minimum acceleration), *Geometric* (stationary, ground,
  at-infinity), *Geometric Approximations* (the curve/Kalman/least-squares fits),
  and *Known Object* (star, planet, satellite). The gallery is shown in one flat,
  best-first order, but that order is decided by keys which ARE comparable across
  categories (with a usable truth track — at least five overlapping frames:
  completeness, then closeness to that track; otherwise broad-screen pass,
  eligibility, completeness, tier, and
  bound-pin count) *before* it ever reaches
  a within-category score that is not — so a trajectory construction cannot
  outrank a balloon or satellite as though those were comparable object
  probabilities, and category order only breaks what would otherwise be an
  unsound tie. Each tile still reports its standing within its own category
  ("#1 of 4 physically based").
- **Fit quality and ordinariness are separate judgements**: a tile's tier is
  the worse of how well the model reproduces the sightlines and how ordinary the
  motion it requires is, but the **badge names whichever one is binding**. When
  the fit is the limit the labels read `Passes broad screen` / `Fair fit` /
  `Weak fit` / `Poor fit`; when the motion is the limit they read `Passes broad
  screen` / `Moderate` / `Low` / `Kinematically extreme`. This stops a slow,
  ordinary object with a middling residual being called "Implausible" (that word
  is about the object; the evidence was about the fit), and stops a 12 g solution
  that threads the rays exactly being hidden as merely a good fit. Search-edge,
  active-model-limit, inactive-bound, internal-clamp, and optimizer-incomplete
  badges remain independently visible; a tier is never relabelled upward, and an
  incomplete result cannot receive an affirmative global winner badge.
- **Balloon-consistency tie-break**: a *Physically based* balloon whose fitted
  motion is genuinely balloon-like — a steady climb, level, or descent drifting
  in one direction — earns a small ranking boost, and one that had to yo-yo
  vertically or curve back on itself is nudged down. It is bounded and only ever
  reorders otherwise equally-well-fitting candidates (it can never lift a balloon
  over a clearly better-fitting drone), so a "looks like a balloon" reading
  surfaces first when the motion supports it without foreclosing a genuine
  better-fitting energetic or maneuvering solution.
- **Family bands**: flat solution valleys are reported as bands ("50–650 kt at
  19–41 NM fit about equally") with a deterministic representative (nearest
  the Target Speed prior), instead of a knife-edge argmin that flips with
  last-bit input changes. The range bracket self-expands when the winner
  touches a grid edge, and a result still on the edge is flagged
  boundary-limited.
- **Bounds are sensitivity-checked**: a parameter merely landing within 1% of
  a numerical bound is not treated as a capability failure. The fitter probes
  it inward and demotes only locally load-bearing constraints. Flat/inactive
  parameters are reported as unconstrained; an inward improvement is reported
  as optimizer-incomplete. Duplicate manifestations of the same constraint
  (such as a speed parameter and derived overspeed) count once. This prevents a
  pre-burn lantern's unused terminal-sink parameter from being counted against
  it.
- **Curved-Earth geometry**: displayed altitudes/climb are geodetic, and the
  constant-altitude and ground candidates include Earth curvature. Dynamics
  still use one fixed-origin ENU frame, so headings and wind axes are
  origin-frame approximations over large/high-latitude scenes.
- **Physical time**: dataset speeds/accelerations honor `simSpeed`, and
  track-driven winds are sampled historically per frame (not the playhead
  value repeated; frames in a wind-data gap use the nearest row with data).
  Velocity/acceleration differentiation uses an approximately 0.5-second
  physical window rather than 15 frames, so changing source frame rate does
  not change the screen. For A-B windows too short to hold that window, the
  differentiation window clamps to the selection length — short analyses
  report real (noisier) metrics; a window too short for any statistics reads
  as invalid, never as zeros.
- **Make/model labels are envelopes, not identifications**: "Closest envelope:
  Boeing 737-800 (not an ID)" means the solved speed/climb sits nearest that
  catalog entry's performance envelope — nothing more.

### The Analyze button

**Traverse ▸ Analyze Traverse Methods...** runs the full battery against the current
LOS data and opens a single flat, best-first hypothesis gallery — each tile
carrying a coloured category label rather than being buried under a section
heading, so the best-screening candidates an analyst wants to inspect (for
example, "looks like a balloon") surface early when the evidence supports them.
This is a screening order, not an object verdict. The standalone HTML report is
built on demand. **Use This** installs the analyzed trajectory as a frozen
Analysis Snapshot; it does not silently rewrite the speed/range assumptions
used by the next run.

1. **Constant-air-speed sweep** — a grid over (start distance × air speed,
   15–650 kt log-spaced so slow drifters are representable alongside jets).
   Each combo is solved as the smoothest ray-following path that holds that
   air speed (a spline solve — the old frame-by-frame ray walk was a shooting
   method that exploded into corkscrews whenever the sensor maneuvered), then
   scored for smoothness (kinematic acceleration, turn-rate variability, climb) plus how well
   the requested speed could actually be held. Surfaces the valley of
   straight-flight solutions (for Gimbal: ~30–32 NM, speed loosely
   400–550 kt).
2. **Range profile** — for each assumed start range, the least-maneuvering
   spline solution with a fast-object (cruise speed) and a slow-object
   (drifting) speed target. Quantifies what an object at any given distance
   would *have* to do — e.g. at 6–8 NM the Gimbal object must nearly stop and
   whip through a rapid heading reversal, or sustain a continuous banked turn.
3. **Aircraft fit** — the differential-evolution fixed-wing fit, reported as
   interpretable parameters (range, origin-ENU heading, horizontal airspeed,
   turn, climb).

The report contains provenance, a run-audit manifest, an executive summary, sweep
and range-profile plots, common-axis track comparisons, selected time series,
and candidate tables/details. Criteria are deliberately loose checks; scores
order model-conditioned hypotheses and are not posterior probabilities.

Unchanged analyses are cached by their LOS, A-B range, timing, wind, model
options, priors, and stable terrain-data configuration. Choosing **Use exact**
or orbiting a render camera does not change those inputs and reopens the prior
gallery immediately. Render-camera terrain LOD (active tiles/revision) is kept
out of the scientific key; the cached result retains the terrain samples used
when it was graded. Adjacent terrain LODs that reconstruct the same surface
within 0.1 m are treated as equivalent; a larger change from an equal- or
higher-resolution authoritative sample, explicit terrain reload, or source
change invalidates normally. A lower-resolution fallback never overrides the
cached authoritative sample. If terrain tiles merely finish loading
*while* an analysis is running, the run is **not** discarded — it completes using
the ground samples consumed while building and grading the candidates (a late
sub-decimetre refinement is unlikely to be material) and
the gallery shows a small note that terrain finished loading, which you can act
on by re-running once it settles if you need the ground samples exact. Starting
an analysis while terrain is still doing its initial load is still blocked, since
a half-loaded start could be genuinely wrong rather than marginally off.

Notes on the gallery tiles:

- The ray-following tiles (Constant Air Speed, Constant Altitude, Minimum
  Acceleration) show their analyzed, lightly smoothed paths. **Use This**
  installs that exact sampled path as a snapshot, so preview, metrics, and
  applied output refer to the same result.
- Tiles are shown in one flat, best-first order, each labelled with its
  **category** and its rank within that category ("#1 of 4 physically based").
  The order is decided first by keys comparable across categories — screen pass,
  eligibility, completeness, broad-screen tier, unique active model constraints —
  and only then by a within-category secondary score (which is not comparable
  across categories), with category priority breaking otherwise-equal ties. The
  0.05 display-tie threshold is a formatting convention, not a statistical claim.
- The **raw LOS residual is always shown**. A flexible constant-acceleration
  reference is displayed separately as context and never substituted for the
  raw value or used as a noise estimate. Ray-constrained smoothing residuals
  receive one fixed 0.05° solver-fidelity allowance; changing the generic
  reference cannot change rank.
- `Max kinematic acceleration (g)` is the change in smoothed air-relative
  velocity divided by gravitational acceleration. It is not aircraft load
  factor and does not include the ordinary 1 g supporting level flight.
- **Constant Altitude** searches the altitude band and scores each candidate
  on the smoothed path plus its LOS residual; if the sightlines are
  near-horizontal (they never cross a constant-altitude plane) the tile
  reports "fit failed" instead of a meaningless track.
- **Minimum Speed**'s family note has two modes: with a genuine low-motion
  window (the classic saddle) it reports the range band that fits equally
  well over that window; on a continuously rotating LOS (the sensor's own
  motion triangulates the range) it reports how sharply the full-clip cost
  valley pins the range instead.
- The flexible constant-acceleration residual shown for scale is a
  **model-reference residual**, not an estimate of sensor noise. It must not be
  used to make statistical confidence or likelihood claims.
