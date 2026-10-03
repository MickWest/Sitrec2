# Thermal imaging core

These ES modules share one radiometric and sensor implementation between browser tools
and application views. A thermal frame is rendered from surface attributes. Visible
material colors and lights do not define thermal emission.

```js
import {ThermalPipeline} from "./ThermalPipeline.js";
import {settingsForPreset, THERMAL_PARAMETERS} from "./thermalSchema.js";

const pipeline = new ThermalPipeline(renderer);
const settings = settingsForPreset("MX15");
mesh.userData.thermal = {zone: "jet_cavity", temperatureK: 720, emissivity: 0.95};
pipeline.render({scene, camera, settings, target: null, frame: 0});
const counts = pipeline.readDetectorCounts();
const exposureSeconds = pipeline.lastFrame.integrationTimeS;
// Use THERMAL_PARAMETERS to build controls, including labels, units and tooltips.
// Release the pipeline when the owning view closes.
pipeline.dispose();
```

`three` is the only external dependency. The host supplies its existing bare-name
import map; no addons are needed. Local imports have `.js` extensions and work in a
browser or a bundler. The numeric modules do not depend on graphics or server APIs.

## Units and stages

| Stage | Stored quantity |
| --- | --- |
| Surface and atmospheric radiance | In-band photons s⁻¹ m⁻² sr⁻¹, divided by 1e20 |
| Fine-grid optics | The same scaled photon radiance, convolved with a unit-sum PSF |
| Detector integration | Electrons per pixel per exposure |
| ADC | Integer-valued 14-bit counts, 0–16383, including the electronic pedestal, stored in Float32 |
| Temporal filter | Floating-point detector counts before gain |
| Processing | Normalized drive, signed during local enhancement |
| Display | Integer-valued 8-bit codes, 0–255, before enlargement |

Scalar GPU stages use **R32F** and complex FFT stages use **RG32F** render targets (the packed near
convolution of live views uses **RGBA32F**, two complex values per texel). `EXT_color_buffer_float` is required;
rendering throws if unavailable. Float textures use nearest sampling; interpolation
is explicit in shaders, so float-linear-filter support is unnecessary. No tone mapper
or color-space conversion is applied to radiance, counts, or already encoded display
values. Output can use nearest-neighbor, half-pixel linear, or sample-centered linear
enlargement and a centered digital zoom. An output pixel wider than a native sample
uses exact box-area averaging on that axis, independently of the enlargement mode.
Mixed enlargement/minification uses the appropriate rule on each axis. The provided target determines the actual picture size; preset picture dimensions
are presentation metadata.

Images and readbacks are scalar `Float32Array`, row-major, **bottom row first** on the
GPU. CPU functions preserve the caller's row convention. `readDetectorCounts()` returns
a copy of the raw integer ADC counts at the native grid after a successful render.
`readFilteredCounts()` returns the floating-point temporal-filter output at the same grid;
raw counts remain independent of processing history. `readStage(name)` returns
`{image, width, height}` for `radiance`, `optics`, `sampled`, `drive`, or `display`.
The first two use the fine grid; the others use the detector grid. `farScatter` is also
available when the broad skirt is active: it contains signed radiance contrast on the
fine grid before adding the sky. Negative values describe scattering a cold object.
`pipeline.lastFrame` contains `{frame, integrationTimeS, scatter, opticalSampling,
atmosphere, background, backgroundTemperatureK, clouds, blur, gain, psfSpectrum, detectorWindow, temporal}`.
`psfSpectrum` reports normalized photon weights, range in m and mean wavelength in m.
`temporal` reports alpha, the effective previous-frame weight and whether history reset. `opticalSampling` is the derived
sampling report described below. `atmosphere` identifies `standard` or `sounding`,
its content key, and, for a sounding, the station/time metadata and estimated assumptions.
`background` gives its source, kind (`sky`, `sea`, or `manual`), physical photon
radiance, scaled photon radiance, and brightness temperature in K. The same temperature
is available as `backgroundTemperatureK`. `background.elevationRangeDeg` reports the
conservative elevation interval (frame diagonal plus margin), `photonRadianceRange` its
physical photon radiance bounds, `sampleCount` the table size, and `interpolation` the
measured midpoint interpolation error and whether its requested tolerance was met.
`gradient` identifies the active sky policy. `gain` reports the statistics region,
sample count and count-valued window. `blur` reports both residual axes, jitter, diffusion and the
long-exposure turbulence convention. Settings' `presetMetadata` supplies their status
and source. The scatter record
reports the near cutoff, coarse reduction factor, far energy fraction, and FFT sizes. `drive` is the
windowed/equalized image before local enhancement. Diagnostic views map radiance through
the fixed radiometric window and counts through 0–16383; their readbacks retain units.

## Scene contract

Positions, camera clipping distances, and geometry dimensions are meters. Perspective
rendering uses the settings' native field of view and aspect ratio on a camera copy;
an orthographic camera retains its supplied frustum for calibration patches. Digital
zoom follows detection. Neither the caller's camera nor its materials are modified.
Materials and visibility temporarily replaced during radiance rendering are restored
in `finally`, including when a draw callback throws. Renderer target, viewport, scissor,
clear state, automatic clearing, shadow and XR settings are restored as well.

A mesh uses its nearest ancestor's `userData.thermal` record if it has none of its own.
A record may contain a plain temperature/emissivity or a recipe understood by
`resolveSignatures()`. Any ancestor with `thermal === false` excludes that subtree.
Thin lines, fat lines (`isLine2`, `isLineSegments2`, `isWireframe`), points, sprites
and helpers are excluded, including mesh-backed line geometry. Untagged and empty records resolve
to ambient temperature and emissivity 1. Materials are opaque thermal surfaces; visible
alpha maps and decorative transparency do not define physical infrared transmission.
Tag separate surfaces when they have different thermal properties.

`resolveSignatures(recipe, ambientK, mach, power)` returns `zones`, `airframe`, `profile`,
`fallback`, `diagnostics`, and `resolveZone(id)`. Explicit zone overrides are at
`recipe.thermal.zones[id]`. Preset exceptions precede propulsion-family inference.
Unknown zones return the airframe with a fallback explanation. Missing data returns
an ambient blackbody with a diagnostic. Zone defaults, emissivities, and power laws
are **estimates**. The steady wall law uses recovery temperature and a power exponent
of 0.7; it is not an engine deck or a transient cooling calculation. Gas and internal
state rows retain null surface emissivity. They require spectral volume/state models
and are not rendered as opaque hot surfaces.

The environment term is `(1-emissivity) × incident hemispheric radiance`. Optional direct
sunlight uses the diluted 5772 K continuum, Lambertian reflection, surface incidence,
and the explicit solar transmission setting. Terrain/vehicle shadowing of direct sun
is not modeled. `skySource` defaults to `atmosphere`: `clearSky` supplies the background
at each ray's elevation and `sensorAltitudeM`, through the same standard or sounding
atmosphere as the foreground range table. `skyGradient` defaults to **true**; false
retains the uniform center-ray background. Both modes use the selected photon band
and **96 integration segments**, a calculated numerical accuracy choice.

`render({scene, camera, settings, skyUp, ...})` accepts optional local up in **camera
coordinates**, as a three-element array or a `Vector3`; it must be finite and nonzero
and is normalized. Camera forward is **−Z**, image up **+Y**. Each ray's elevation is
`asin(normalize(ray) dot normalize(skyUp))`. Without `skyUp`, up is
`[0, cos(e), -sin(e)]` with `e = pathElevationDeg × pi/180`: image vertical follows the
vertical plane. Explicit `skyUp` also supplies the actual center-ray elevation for
foreground transfer. It does not mutate the caller's camera or settings. Perspective
rays use the inverse projection, including coverage tiles; orthographic rays are
parallel. Digital zoom crops the native field after detection and does not change it.

`createSkyElevationLUT`, `sampleSkyElevationLUT`, `skyViewGeometry` and
`skyRayElevation` in `atmosphere.js` expose the CPU reference. The lookup covers the
frame's angular diagonal plus **max(0.01 degree, 5% of half-diagonal)** margin, clamped
to −90…90 degrees. These are calculated numerical policies. It starts with **65**
uniform elevation nodes and inserts the exact optical axis. Intervals whose midpoint
relative radiance error exceeds **2e-5** are bisected, to at most **2049 nodes** and
**12 refinement levels**. The final midpoint error is reported, including failure to
reach tolerance at those limits. This bounds a checked interpolation error, not
atmospheric model accuracy or an error guarantee between probes.

The narrow **1.5° vertical, 32×24** validation field at **2.23°**, **1382 m** uses
**66 samples**: maximum midpoint relative error **3.589e-6**, independent quarter-point
error **2.697e-6**, both calculated with the standard atmosphere. A **20°** sky/sea
field uses **191 samples**, midpoint error **1.955e-5**. These are numerical test
conditions, not a sensor specification. A cached table is reused while profile
content, altitude, enclosing field geometry, sea temperature and photon band agree.
Manual backgrounds remain uniform. `skySource: "manual"` instead uses the blackbody
brightness temperature `skyTemperatureK`; editing that temperature alone does not change
the source policy. Older saves without a sky source use the new atmosphere default.

Without terrestrial refraction, below the spherical geometric horizon, `seaBackground` supplies thermal emission
plus reflected sky through the foreground atmosphere. The horizon is
`-acos(R/(R+altitude))`, with the atmosphere's **6371000 m** spherical Earth radius;
a negative elevation can still be clear sky at an elevated observer. Separate sky
and sea values at a duplicated horizon coordinate prevent interpolation across the
boundary. Their limiting evaluations are **1e-8 rad** inside each branch, a calculated
roundoff guard. In `seaMode: "smooth"` this is the **estimated** comparison surface at
`surfaceTemperatureK`, with single-facet Fresnel reflection. `"statistical"` uses
independent `seaSkinTemperatureK` and the directional rough-water model below. The foreground range table
ends at the center ray's first surface intersection if it is nearer than the requested maximum.
An intersection at the sensor gives zero-length transfer. The generic pipeline rejects
mesh bounds beyond this **actual table endpoint**, including the zero-length case,
instead of silently applying the final sample to farther geometry. A host's explicit
`allowRangeClamping` terrain policy remains its responsibility; ordinary meshes do not
receive that exception. `background` reports the
surface distance and the assumption. Disabling atmospheric transfer sets its density
scale to zero for both the range table and automatic sky; unobstructed space is then
dark, while the sea still emits. Manual sky is independent of that switch.

## Cloud radiance and statistical sea

`CNodeSynthClouds` registers `grayAbsorbingSheet`; its canonical offsets, dimensions,
mask texture and stable `node:instance` identities feed a dedicated pass. The host
converts physical centers to camera-relative coordinates in double precision, obtains
ellipsoid altitude, and samples the shared atmospheric temperature profile there.
Each physical sheet sample uses its own altitude for the **estimated local-equilibrium
assumption**, including profile inversions; phase remains unknown. `temperaturePolicy:
"isothermal"` is a distinct explicit override using `temperatureK`; merely supplying a
center temperature does not turn off the local-altitude policy.

Thermal participants use the **same terrestrial projection as the visible view**.
Objects and terrain retain physical vertex positions for range and receive the
shared lift only at projection. Cloud sheets receive their anchor's lift, preserving
the visible billboard dimensions. Their temperatures still use local physical altitude.

The analytic mean sea is projected with that same density-dependent, saturated lift.
Its horizon is the maximum apparent elevation of the surface; lifting the old
geometric tangent alone does not find the new limb. Each displayed elevation maps
back to a physical sea endpoint or atmospheric exit. Sea radiance, its directional
angular lookup, foreground depth and cloud visibility share this mapping. Separate
sky/sea table endpoints preserve the boundary. An error-checked apparent-depth table
uses a square-root angular coordinate to resolve the tangent. Analytic sea radiance
and depth are independent of ocean mesh coverage; the mean sea has no geometric crests.

**Atmospheric path integration stays along the straight physical path between the
physical endpoints.** Projection selects visibility; it does not turn this transfer
approximation into curved-ray radiative transport. A visible lifted endpoint can
have a chord below the geometric sea: that chord uses the atmosphere's sea-level
continuation. Such cloud samples receive exact transfer evaluations instead of
extrapolation outside the validated unobstructed cache domain. The atmospheric
and mean-sea geometry remains spherical, using the host lift context's curvature
radius when refraction is active. This is a local spherical approximation on an
ellipsoidal globe. Profile, band and projection changes invalidate affected tables.

The browser self-test includes an estimated **21 m**, **k = 0.13** horizon fixture.
With refraction on and off, the GPU must place the projected curved ocean's edge
on the analytic boundary with **zero mismatched pixels**, exercise both sky and
sea, and retain the same radiance when ocean coverage is full, partial or absent.
The **1e-6 scaled-photon** comparison tolerance is an estimated numerical gate.
An additional distant sheet must be hidden by the sea and visible above it in
both float blending and shader composition, within an estimated **5e-5 relative
photon-radiance** gate. These GPU checks require a browser execution.

The texture alpha is an **estimated normalized column mask** m, independent of RGB,
visible opacity, lighting and display polarity. The default core absorption depth is
`cloudOpticalDepth = ln(100) = 4.605170186`, **calculated** from an **estimated 1% residual
contrast criterion**. `alpha = 1-exp(-q*m)`. The numeric API also distinguishes calibrated
opacity from unresolved coverage. Neither cloud population nor sprite depth is a
measured mass density. Increasing the number of independent overlapping puffs adds
optical depth; retessellation of one physical column must conserve its total depth.

A local segment obeys `L=E+tau*Lbehind`. For a gray sheet, the observer-domain source
is `alpha*C`, where `C=sum(P_front + T_front*B(T_cloud))` in photon units. Blending
`alpha*C + (1-alpha)*L_old` preserves foreground air exactly within the subband
model, including when farther clouds already occupy `L_old`. All layers share one
far-to-near camera-depth order, with deterministic identity ties. Depth testing uses
opaque scene geometry; clouds never write depth. The visible cloud meshes are hidden
within the existing `finally` scope, so their scene-level transparent-camera callback
cannot run lighting updates against thermal materials. No visible cloud material is
replaced. Camera switches, wind, rebuilds, profile and band changes invalidate the
relevant radiance data. The pass is repeated in surface coverage subviews without
sending the cloud field through opaque-triangle coverage refinement.

`radianceAdapter.cloudSheets(camera, settings, atmosphere)` returns
`{sheets, diagnostics}`. A sheet supplies `id`, physical camera-space `center` in m,
`size` in m, optional `temperaturePolicy` and `temperatureK`, `opticalDepth`, `mask`, and
optional `maskSemantics` (`normalizedColumn`, `calibratedOpacity`, or `coverage`).
The host preserves visibility/layers and supplies canonical, unsorted instances.
A shared profile/band function uses observer altitude, range and elevation, plus
an override-temperature coordinate for isothermal sheets. Its sparse cells are
reusable across moving sheets. Tensor half-step probes bound estimated received
interpolation error to **0.001 K**, including a factor-two numerical margin; failed
cells subdivide. Starting domain spans are **100 m altitude, 1000 m range, 0.02 rad
clearance above the visibility limit, and 8 K override temperature**, estimated
numerical search sizes, not quantized physical inputs.

Per-sheet bilinear textures refine **2×2 through 65×65** samples against visible
edge, center and horizon-boundary probes, reserving **0.004 K** for this interpolation
and **0.001 K** for the shared function. The total estimated gate is **0.005 K**;
exhaustion throws. Zero-depth sheets are skipped before table work. Sea-hidden and
opaque-foreground samples are excluded before atmospheric integration. Partly visible
sheets are retained. Hidden texture nodes use linear continuation from visible
samples solely to extend interpolation across the clipped boundary; no Earth-crossing
path is integrated or altitude-clamped. The fragment pass applies physical sea
clipping and opaque depth testing. These probe-based numerical checks compare with
the same atmospheric model, not measured cloud temperatures. `EXT_float_blend`
selects premultiplied float blending. Without it, each sheet copies only its screen
rectangle to a separate scalar Float32 attachment and shader-composites against that
copy. It never reads its active render attachment. `forceCloudShaderComposite` is a
pipeline diagnostic used by the GPU self-test.

`CNodeCloudField` carries fitted display emission, not kelvin or absorption depth.
It is excluded with `unresolvedThermal` in the readout until physical density/optical
metadata and a joint, clipped volume integrator are provided. Sorting sphere hulls
would not solve overlap. The CPU helpers retain local E/tau composition, emission-only
addition and the analytic radial sphere-column relation for validation. Cloud scattering,
including illumination from the Sun and lower atmosphere, is omitted and reported as
`absorptionOnly`; no total physical-accuracy bound is claimed.

The Sitrec host defaults to `seaMode: "statistical"`; the generic pipeline and Designer
retain `"smooth"`. The statistical mode is an explicitly **estimated ensemble mean**,
not moving water or a final texture/clutter model. Defaults are **U10=5 m/s**, skin
**293 K**, and **zero added swell**, with suggested wind **2–10 m/s** and skin
**288–297 K** sensitivity cases. These are unmeasured preview inputs. Air temperature
remains independent. Wind and swell bearings are **toward**, clockwise from local north,
in rad. Optional swell has its own significant height, period and bearing; the
**13 s** default period is an estimated dormant sensitivity setting when height is zero.

`waveSpectrumMoments()` is the shared spectral boundary: components supply
`varianceM2=a²/2`, `kx`, and `ky` in rad/m. It computes `Hs=4*sqrt(sum variance)` and
`C=sum(variance*k*k^T)` plus an explicitly separate unresolved residual covariance.
In this fully unresolved mode all components are statistical. Negative covariance
eigenvalues are rejected. The preview residual uses the named Gaussian Cox–Munk
convention: `C_up=.00316*U12.5`, `C_cross=.003+.00192*U12.5`; it does **not** claim a
unique wind-wave height or period. An **estimated neutral logarithmic profile** with
roughness length **0.0002 m** converts the stored U10. Explicit swell is an estimated
monochromatic deep-water component, `k=(2*pi/period)^2/9.80665`. No wind-development
spectrum or event sea state is recovered from these defaults.

Visible facets are projected-area weighted, excluding back faces, with a finite
normalized grazing limit. Unpolarized complex Fresnel uses the **estimated gray**
index **1.35+0.01i**. Reflection samples directional sky launched at the water, preserving
all **108 correlated atmospheric channels** through the outgoing path. Independent
Smith visibility also hides some above-horizontal reflected rays; blocked reflection
uses an explicitly **estimated black-cavity closure** at skin temperature. This keeps
isothermal balance; it is not geometric crest tracing or validated multiple reflection.
The provider is named `clearSkyThermalOnlyDiagnostic`: clouds and the Sun do not
contribute reflected radiance. Scene-environment reflection is deferred. Foam,
resolved wave motion and occulting crests also remain absent.
The optical point spread function follows radiance composition as before.

The numerical sea default uses **96×96 Gaussian slope quadrature**, splitting at the
visible half-space boundary, and **513 incident-sky elevations**. Doubling to
**192×192 / 1025** changes received brightness temperature by at most **0.000751 K**
in a calculated **540-case** standard-atmosphere, no-swell sweep: wind **2, 3, 5, 7,
10 m/s**, skin **288, 293, 297 K**, observer **21, 7620 m**, incidence **0, 54, 64, 75,
85, 89.99 degrees**, and azimuth **0, pi/4, pi/2 rad**. These are estimated validation
inputs. The **2 m/s, 85-degree crosswind, 293 K** case changes by **0.000168 K**.
This sampled-domain quadrature check is separate from interpolation uncertainty;
arbitrary profiles, added swell and inputs outside this domain have no measured
quadrature bound. `background.sea.quadrature` reports the resolutions, acceptance
budget and a null per-frame error, rather than presenting interpolation error as
quadrature error.

The render table retains both azimuth and elevation, each with an estimated
**0.002 K** interpolation budget, reserving **0.001 K** for altitude reuse. Azimuth refinement stops at
**65 rows** and reports exhaustion. Reusable angular domains include a checked
margin of **one quarter of the field half-cone, at least 0.002 rad**. Motion inside
a validated domain reuses it while sampling the current ray; motion outside it,
environment changes rebuild the relevant table. Small altitude changes use a
separately checked height interval, initially **0.05 m** on either side, halved until
both height endpoints pass the **0.001 K** received-radiance gate. The exact physical
horizon shift is applied before table sampling, so reuse cannot move the sea/sky
boundary. Unchecked height intervals rebuild. Height-domain validation is currently
synchronous when first needed. Every row has separate sea/sky horizon entries;
it interpolates radiance without smearing across that boundary. Thus the horizon ramp
comes from atmospheric range, skin emission and directional reflected sky, not a
contrast control. `radianceAdapter.seaWind(settings)` supplies a unit camera-space
wind direction; generic hosts use projected image-right as zero bearing.

Physical sources: published sea-surface slope measurements and a published
masking-shadowing study. The gray water index, independent
visibility and black-cavity closure are assumptions, not measured water optics.
Cloud transfer is the integrated nonscattering absorption/emission equation; no
published scattering result is presented as validation of this omission.

Cost is exposed, not promised: `lastFrame.clouds` reports CPU preparation/sort/submit
wall time in ms, `hostPrepareMs`, evaluations, upload bytes, draws and a conservative fragment bound,
including coverage subviews. Cached frames do no cloud atmospheric integration or
source upload. Moving sheets resample the shared function and update small source
textures; they do not each reintegrate the same atmospheric rays. Sorting is **O(N log N)**; compatible sheets
currently use one draw each, or two with the bounded-copy fallback. Source textures
cost `4*sum(tableSize²)` bytes; fallback adds one fine-grid R32F target, `4*width*height`
bytes. `background.sea` reports spectrum assumptions, table build time, interpolation
error, azimuth rows and texture bytes. `environmentBuildMs` reports incident-sky setup;
`cacheBuildMs` is zero on reused frames and `lastBuildMs` retains the previous table
build measurement. A stable directional sea uses the existing
background draw with two elevation searches per sample: at most **30 logical texture
fetches** (`2*(1 row count + 12 search + 2 endpoints)`), a calculated bound, above the
four-fetch preintegration target. GPU elapsed time is **unmeasured** (`gpuMs: null`),
not zero.

`node tools/thermal/benchmark.mjs` measures CPU cloud/sea preparation for estimated
**300 frames at 30 Hz**, **20 clouds**, a **60 m/s** camera following a constant-altitude
sphere, **10 m/s** cloud drift and **1e-5 rad/frame** pitch motion. The calculated local
run gave median **0.18 ms**, p95 **0.43 ms**, p99 **0.70 ms**, mean **3.09 ms**, and maximum
**842 ms** (the cold first frame). The warmed maximum was **17.94 ms**; the sea domain
built once and only **2 frames** integrated new cloud cells. This meets the estimated
**5 ms median / 16 ms p95** preparation targets in this fixture, but cold preparation
still blocks synchronously. Timings include canonical records, sort, shared domains,
sheet textures and sea tables; they exclude GPU work, opaque-object range tables,
optics and detector processing. They are not full-frame performance claims.

`tests/thermalPhase3a.test.js` reuses the bounded cloud-transfer checks and reproduces
**0.880/0.497/0.241 K** at **100/130/160 km** with **0.03 K** numerical reproduction
tolerance. The input is a radiosonde archive sounding, CIM00085586, **2014-11-11 12 UTC**, with an
estimated **1382 m**, **1.84 degree** test ray; these are conditional calculations, not
recovered cloud ranges. The source CSV is in `validationFixtures.js`.
The gray rough-facet reference gives **0.326189/0.380718** first-encounter reflectance
along/across wind for **9.8 m/s at 4.1 m**, converted to **10.900350 m/s at 12.5 m**, at
**89.99 degree** incidence. It is distinct from effective reflectance after hiding.

Run `runThermalSelfTest()` in WebGL: the cloud billboard must match CPU transfer to
**0.005 K** for transparent, partial and thick columns against both sky and warm
background, through both available float blending and forced shader composition.
The statistical sea patch must match CPU photon radiance to **1e-5 relative**, and its
reported brightness temperature to **1e-9 K**. Additional perspective cases must keep
unequal-temperature layers in the correct order, preserve an opaque foreground,
leave zero-alpha texture support unchanged, retain visible portions of horizon
crossings, and match per-sample local-temperature transfer on tall sheets to
**0.005 K**. Run both float blending and forced fallback; missing float-blend support
leaves that acceptance check unmet. These are estimated numerical gates. Jest
executes production dispatch and shader alpha arithmetic, but does not rasterize
shaders. An independent midpoint visible-normal/reflection-escape integral and
frozen nonisothermal cases validate the sea source separately from GPU composition. In Sitrec check visible → thermal → visible, multiple
cloud layers, camera motion/roll, cloud disposal/rebuild and atmosphere edits, and
verify unresolved fields show their diagnostic without changing visible rendering.

## Sitrec host contract

The custom look view selects `visible` (the default for old saves) or
`physicalThermal` under **Effects → Physical thermal → Render mode**. The menu is
created during custom setup, not in a serialized situation definition. Selecting
thermal, opening its settings, or opening object zone controls loads the shared
modules on first use. A closed, visible-mode startup does not request thermal code
or assets. The ordinary perspective look view is supported. Fisheye, Flat Earth,
XR, panorama and orthographic views report unavailable; they do not substitute a
visible image under a thermal label.

`src/rendering/ThermalViewAdapter.js` uses this `ThermalPipeline`, the Designer's
`configureSensorCamera` and `withThermalVehicle`, and `createThermalControls` with
its lil-gui widget sink. `THERMAL_PARAMETERS` owns all sensor/environment parameter
descriptions and validation. Its `owner` identifies sensor, environment or derived
geometry. Sitrec translates menu keys through its English resource. Ordinary
lil-gui controllers remain addressable through `setMenuValue` and `getMenuValue`.

Persistent ownership is `CNodeCamera.thermalSensor`, `Sit.thermalEnvironment`,
`CNodeView3D.renderMode`, and `CNode3DObject.thermal`. Derived altitude, ray elevation
and frame rate are not saved as editable sensor values. The environment can carry
an optional parsed `sounding` using the existing sounding contract. Object modes
are `inherit` and `uniform`, with per-property overrides in `thermal.zones[id]`.
Procedural vehicles resolve their generated zones through the same scoped wrapper
as the Designer. Uniform mode replaces surface temperature/emissivity without
changing geometry. Untagged physical models remain ambient blackbodies. Generated
zone estimates retain their signature provenance; a uniform surface is an
explicit user assumption, not a measurement.

For each procedural vehicle in `inherit` mode, the host supplies fresh
`{airTemperatureK, mach, power}` for every draw. Air temperature is calculated by
sampling `thermalSceneAtmosphere` at the object's world-space ellipsoid altitude,
using the same profile construction as `ThermalPipeline._prepareAtmosphere`:
standard atmosphere shifted by `surfaceTemperatureK`, or the supplied sounding
with its existing interpolation/extrapolation assumptions. This retains the
pipeline's altitude convention; wind-field sampling separately converts altitude
to mean sea level with the geoid offset. Turning atmospheric extinction off does
not remove the air temperature. For example, the standard profile at **3200 m**
with its **288.15 K** surface reference gives **267.35 K**, calculated as
`288.15 - 0.0065 * 3200` from `atmosphere.js` (U.S. Standard Atmosphere 1976).

Track velocity is calculated from a central position difference, one-sided at
track endpoints, divided by elapsed scene time (`simSpeed / fps` seconds per
frame). It includes vertical motion. A vehicle without a usable track is assumed
stationary in the ground frame. The host first samples the sitch wind field at
the vehicle's latitude, longitude and altitude. If no altitude-dependent field
is active, its bound object/controller wind can supply a uniform-column wind.
Otherwise a missing altitude sample uses ground speed; no wind is fetched by the
thermal renderer. Mach is calculated as
`|groundVelocity - windVelocity| / sqrt(gamma * R * airTemperatureK)` with the
published ideal dry-air relation and constants already used in `src/AirData.js`.
The readout identifies altitude wind, bound wind, ground-speed fallback, or the
stationary assumption. Power retains `recipe.parameters.thermalPower`; when it
is absent, `TURBOFAN_CLIMB_REFERENCE.powerFraction` supplies the **estimated 0.90**
load coordinate from `signatures.js`, not a measured throttle.

**Object → Thermal surface → Vehicle thermal state** offers **From scene** or
**Override** for air temperature (K), Mach (dimensionless) and power
(dimensionless). Overrides are numeric `thermal.airTemperatureK`, `thermal.mach`
and `thermal.power` values in the object's mods. `null` or absent fields mean
from scene, including old saves. Resetting the source to From scene removes that
override. An air-temperature override also changes the speed-of-sound
calculation; an explicit Mach or power, including zero, takes precedence.
The stored procedural recipe is never edited. Zone overrides still take
precedence over the resolved signature, and uniform mode retains its surface
replacement behavior.

`resolveVehicleThermal(recipe, values)` and
`withThermalVehicle(model, draw, values)` accept these optional per-draw values.
Omitting them preserves the Designer's recipe-driven behavior, including the
burner signature. Mesh attributes and visibility restore after each draw or
exception; no scene-derived values are written into a recipe or saved mods.

The host registers physical model/primitive roots and terrain/building roots.
Only registered subtrees participate. Synthetic cloud nodes register separately
as emitting/absorbing sheets; cloud fields without physical optical-depth data
register as unresolved and produce an explicit readout diagnostic. Grids, labels,
track lines, helpers, celestial bodies and overlays remain excluded. `thermal === false` on an ancestor always excludes
its descendants; layer masks and visibility still apply. Terrain and water tiles
use `groundTemperatureK` and `groundEmissivity`: estimated defaults **288.15 K**
(the U.S. Standard Atmosphere 1976 sea-level reference, not observed ground) and
**1** (the blackbody fallback definition). Distant terrain beyond the configured
atmosphere table uses its endpoint transfer; finite model bounds outside that
range report an error. Terrain retains the host's streamed, view-dependent level
of detail, so changed tile geometry can change native counts independently of the
fixed detector sampling. Compare sampling invariance on a fixed target/sky scene.
This terrain approximation is not a measured sea or land signature. In statistical
sea mode the explicitly registered ocean-surface root is replaced by the analytic
directional sea boundary and its full-frame spherical depth. Mixed terrain tiles retain the ground
fallback; no water classification is inferred from visible colors.

The native detector and optical field never follow pane zoom or export size.
For detector height H, pitch p and focal length f, native vertical field is
`2 atan(H p / (2 f))`. The prepared camera projection maps output coordinates back
to this fixed native detector. A narrower view crops it; a wider view shows its
native field at the camera's scale with black outside its support. Aspect, video
pan and vertical compression affect this presentation mapping only. The schema's
additional digital zoom multiplies the camera-derived crop. The readout reports
native horizontal/vertical field and effective vertical digital zoom. Displayed
region gain uses the actual native sample centers inside that possibly shifted,
rectangular crop, not enlarged output pixels.

The host passes `skyUp` in camera coordinates from geodetic local up, and derives
sensor altitude and center-ray elevation every frame. With `turbulenceMode:
"geometry"` (the Sitrec default), `integrateTurbulence` receives the physical
camera-to-selected-target range and elevation. Its calculated Fried coherence
diameter at **4 um** feeds `turbulenceR0M`; the Hufnagel–Valley profile remains an
estimate, with provenance in `turbulence.js`. `manual` uses the saved override,
including zero to disable turbulence. Jitter and diffusion remain the existing
shared sensor controls. No profile is fitted to a desired image.

`render()` additionally accepts `presentation: {scale: [x,y], offset: [x,y]}` in
normalized native coordinates, before the schema digital zoom, and an optional
`radianceAdapter` with `materialKey`, `attributes(mesh, settings)`,
`prepareMaterial(material)`, `projectPoint(cameraRelativePoint, camera)` and
`allowRangeClamping(mesh)`. These are host callbacks, never serialized settings.
The default presentation is the existing centered Designer field. Material keys
separate host shader variants in a renderer's cache. Sitrec's adapter installs
its existing terrestrial-refraction shader hook, restores shared uniforms after
the draw, and applies the same lift to CPU coverage bounds. Surface shaders
include logarithmic depth. Range uses the unmodified camera-relative vertex
position; model-view transforms and CPU bounds combine matrices in double
precision before projection, preserving ECEF precision without subtracting large
world positions in fragment shaders.

The thermal branch runs after camera preparation and before its restoration. It
bypasses visible sky/haze, RGB reflections, IR lighting, exposure, filmic mapping
and all legacy effect passes. Temporary materials, callbacks, visibility,
frustum flags and renderer state restore on success or exceptions. Visible main
rendering uses its own unchanged path. Context loss/disposal releases pipeline
resources; an asynchronous load cannot attach to a disposed view.

On `localhost` and `local.metabunk.org` only, `window.lookThermal` exposes
`settings`, `mapping`, `geometry`, `turbulence`, `vehicles`, `pipeline`, `set(key,value)`,
`readDetectorCounts()` and `readStage(name)`. For two-renderer verification, open
an embedded Designer IR preview, then call
`lookThermal.compareWith(vehicleThermal.pipeline)`. The next look render sends
its identical prepared scene, physical attributes, camera, frame and settings to
both renderer-local pipelines. `lookThermal.comparison` retains both native arrays
plus maximum/RMS count differences. This checks the shared physical input path;
it does not establish that independently selected preview poses or climates
match the sitch. Debug hooks do not exist on public hosts.

`lookThermal.vehicles` contains the last draw's inherited procedural vehicles,
with `id`, `frame`, `altitudeM`, `airTemperatureK`, `mach`, `power`, `speedMps`,
`groundSpeedMps`, `hasTrackVelocity`, `speedSource`, and per-value `sources`.
The look-view readout displays each vehicle's used air temperature, Mach, power
and speed with the same source choices. A scene-derived Mach above **0.95** for a
transport jet produces an implausibility warning and suggests **Object → Thermal
surface → Vehicle thermal state → Mach → Override**. This threshold is an
**estimated plausibility check**, not a certified aircraft limit. Explicit Mach
overrides are not warned about, other classes have no assigned envelope, and
no Mach is silently capped. These values describe estimated
equilibrium signatures, not measured surface temperatures. For browser
verification, advance frames and change the atmospheric profile, check an
instance override and a save/reload, then reset it to From scene. Confirm the
readout and debug values agree, the two pipelines receive the same values during
`compareWith`, and visible rendering and the Designer recipe remain unchanged.

## Sampling and optics

`opticalSamplingMode` defaults to `nyquist`. The incoherent optical cutoff is
`1 / (lambdaMin × N)`, where `N = focalLengthM / apertureM` and `lambdaMin` is
`bandMinUm × 1e-6` m. The calculated Nyquist condition is a fine sample interval no
greater than `lambdaMin × N / 2`, or a required factor
`2 × pixelPitchM / (lambdaMin × N)`. Normalization chooses the smallest fitting factor
among 2, 4 and 8 using the same padded allocation limits as `scatterPlan`.
The MX-15 values give `3 um × 4.5 / 2 = 6.75 um`; 20 um detector pitch therefore needs
factor 4. The conditional ATFLIR preset also selects 4. These are calculated numerical
requirements, not measured camera sampling specifications.

The read-only `opticalSampling` record contains `{mode, factor, requiredFactor,
nyquistMet, allocationFits}`. `requiredFactor` is continuous, before rounding to an
available factor. If no fitting factor meets Nyquist, normalization uses the largest
one that fits and reports `nyquistMet: false`. If even 2 cannot fit, it retains 2 with
`allocationFits: false`; rendering raises the existing allocation error. The record
is derived, never a menu parameter. Editing `supersample` on normalized settings
selects `manual`; manual mode retains the requested factor and still reports whether
it meets Nyquist and allocation limits. To construct manual settings from scratch,
specify both `opticalSamplingMode: "manual"` and `supersample`. Legacy saves without
the new mode start in Nyquist even if they contain a previously saved factor.

The scene is rasterized finer than the detector. Mesh bounds narrower than two native
pixels trigger additional **128 samples per native pixel side** coverage tiles, independent
of the chosen optical supersample factor (2, 4, or 8). Each tile redraws the whole scene,
including its foreground occluders, and area-averages back into the fine grid. Thus a
quarter-pixel nozzle receives roughly 32 raster samples across its diameter instead
of disappearing between coarse samples. Overlapping tiles replace the same region;
they never add another emitter. Mesh/instance bounds identify these tiles; tiny features
inside a large mesh need separate zone meshes for this refinement. Animated deformation
should keep conservative mesh bounds when using this coverage policy. Meshes wholly
outside the image are skipped in every mode (they draw nothing). Interactive views also
skip ground and sea surfaces, which are extended backgrounds that edge-on near the horizon
would otherwise spawn hundreds of tiles, and refine at most 64 tiles per frame (an
estimated budget); `lastFrame.coverage` and the readout report any overflow. Analysis and
offline renders keep the complete refinement.

There is no after-render brightness renormalization of sources. Sum multiplied by sample
area measures flux. The browser self-test compares a quarter-pixel disc with its analytic
polygon area across four positions and three factors, with a 5% limit, then checks
conservation through optics. Smaller sources require a higher coverage resolution or an
analytic projected-area representation. Detector fill below one intentionally rejects
light falling between active pixel areas; that loss is distinct from raster conservation.

The diffraction kernel ports the circular/annular Airy and complex-pupil defocus formulas.
The complex-pupil FFT chooses `pupilFill = (pixelPitchM/supersample)/(lambda*fNumber)`
per wavelength, so its focal-plane samples coincide with the fine grid. This calculated
sampling avoids bilinear intensity interpolation filling dark rings. At optical Nyquist
that fill is at most one half. Tests compare vanishing defocus with analytic Airy and
halve focal-plane spacing while doubling the pupil grid at finite defocus.
The pipeline uses a circular pupil with seven wavelength bins. `psfTemperatureK`
defines the blackbody source photon spectrum. `psfRangeM: 0` retains the unattenuated
spectrum; a positive range weights it by transmission through the selected atmosphere,
at the sensor altitude and center-ray elevation. Each PSF bin is intersected with all
atmospheric subbands before integrating source photons, preserving their absorption
structure. Path emission is excluded from these source weights. A host can supply
`render({..., psfRangeM: rangeM})` per frame without changing saved settings; a supplied
sounding is used for both the PSF and scene transfer. Range, profile, geometry and band
changes invalidate the optical-spectrum cache. The reported mean is the weighted mean
of the seven bin centers, not a higher-resolution spectral centroid.

For **500 K**, **1382 m** altitude, **2.23°** elevation and **125000 m** range through
the default standard atmosphere, the calculated mean wavelength changes from
**4.245524 um** to **3.950263 um**. These are model consistency numbers for estimated
geometry near IB6830, not measured camera response. A spatially common temperature
and range remain approximations for a scene containing different surfaces. Defocus is longitudinal
sensor displacement in meters and acts through pupil phase, not an arbitrary blur.

### Turbulence, system blur, platform jitter and charge diffusion

`turbulence.js` provides `hufnagelValley(heightM, parameters)`,
`integrateTurbulence(geometry, options)`, `scaleR0` and `turbulenceMTF`. The published
Hufnagel–Valley (HV) profile is

```
Cn²(h) = 0.00594 (v/27)² (1e-5 h)^10 exp(-h/1000)
       + 2.7e-16 exp(-h/1500) + A exp(-h/100)
```

Here height `h` is m above sea level, `v` is m/s, `A` and Cn² are m^(-2/3).
Published HV 5/7 parameters are **v = 21 m/s**, **A = 1.7e-14 m^(-2/3)**.
`windSpeedMS`, `groundCn2` and `multiplier` are exposed; this wind parameter is not
pupil-plane apparent velocity. A caller may instead supply `cn2(heightM, distanceM)`
for an alternative profile or layer. Transferring a statistical profile to an actual
path is **estimated**, independent of the measured weather sounding. Sources:
a published turbulence study and a published open-source implementation.

The straight spherical-Earth ray is integrated from receiver `s=0` to source `s=L`:

```
Js = integral Cn²(h(s)) (1-s/L)^(5/3) ds
Jtheta = integral Cn²(h(s)) s^(5/3) ds
r0 = [0.423 (2 pi/lambda)² Js]^(-3/5)
theta0 = [2.91 (2 pi/lambda)² Jtheta]^(-3/5)
```

The finite-source weighting is retained; no extra secant factor is applied. `r0M`
and `r0ReferenceM` are coherence diameters in m, `isoplanaticAngleRad` is the wavefront
correlation angle in rad (not a blur radius). The default reference is **4e-6 m**;
`r0(lambda)=r0(ref)(lambda/ref)^(6/5)`. Integration uses **20001 samples**, a calculated
trapezoid quadrature choice with an analytic uniform-profile regression. A zero
integral returns infinite coherence diameter. For estimated reference endpoints
**1382 m**, **7479.8611 m**, slant range **124979.1435 m**, the calculation yields
**r0 = 0.572335 m**, **theta0 = 3.030949 µrad** at **4 µm**. These are model outputs,
not measured turbulence. The module returns integrals and provenance with the result. Accepted sea-level endpoint
roundoff is clamped to zero height before sampling Cn²; true surface crossings still throw.

`turbulenceR0M` is r0 at **4 µm**, default **0 (off)** for an unspecified scene. Set it
from `integrateTurbulence(...).r0ReferenceM` for a finite path. Each of the seven
wavelength PSFs is filtered separately by the **long-exposure** Kolmogorov modulation
transfer function (MTF), before photon weighting:
`H(f)=exp[-3.44 (lambda f/r0(lambda))^(5/3)]`, with `f` in cycles/rad.
Source: a published optics study.
This is an ensemble long-exposure approximation. Finite-exposure interpolation,
tilting phase screens, scintillation and spatially varying turbulence are absent;
the scene does not provide layer-relative motion with which to identify them.

`jitterRmsUrad` is **per-axis intra-exposure RMS**, in µrad. Its Gaussian fallback has
MTF `exp(-2 pi² sigmaRad² f²)`. The MX-15 preset's **2.714 µrad** is **estimated**:
`5 × sqrt(1-sinc(pi × 20 × .016)²)` µrad, assuming total 5 µrad axis RMS at 20 Hz and
16 ms exposure, with `sinc(x)=sin(x)/x`. A published manufacturer data sheet gives a typical
stabilization scale below 5 µrad but does not establish that spectrum, RMS convention
or an exposure-time blur. The setting already describes blur about the exposure's
centroid; changing exposure does not rescale it. Frame-to-frame wander and a sampled
motion trajectory are separate effects and are not synthesized.

`systemBlurHorizontalRmsUrad` and `systemBlurVerticalRmsUrad` are independent
Gaussian residual widths in **µrad RMS**, along detector/display **x and y**, before
native sampling and detector noise. Generic sensors, free optics and unmeasured short
steps default to **0**. MX-15 **675 mm and 1012 mm** steps use **0 horizontal / 40 vertical**
with `displayCurve: "measured"`. The nominal horizontal zero is within the measured
**≤8 µrad** bound; it is not a measurement of exactly zero blur. The approximately
40 µrad vertical value is an estimated conversion of the measured **34 ±3 µrad** under
a linear display law. Selecting Linear does not silently change a saved blur value.

Status: **measured from the IB6830 video at both lens steps (seven lobe-shape measures;
34 ±3 µrad under a linear display law, about 40 under the measured curve); horizontal
bound ≤8 µrad; angle-fixed; acts before detector noise; origin unresolved (optical
anisotropy leading, fast elevation vibration still possible; sensor and readout effects
ruled out as ordinary fixed-pixel explanations)**. This empirical response belongs to
one recording, not every unit in the sensor family.

The measurement compares seven lobe-shape measures over **41-frame sequences** around
frames **10450, 11000 and 14200**. Comparing consistent physical lobe estimators removes
the apparent spacing discrepancy. The actual discrepancy is shape: the real lobes are
rounder than an isotropically blurred model. Resolving the axes gives vertical
**34 ±3 µrad at 675 mm** and **34 ±2 µrad at 1012 mm** under the linear law. Their common
angular width, together with the horizontal bound at the longer step, supersedes the
older isotropic inference and the proposed detector-fixed blur. With the measured curve,
calculated native vertical sigmas are `40e-6 × .675 / 20e-6 = 1.35 pixels` and
`40e-6 × 1.012 / 20e-6 = 2.024 pixels`.

Optical anisotropy leads provisionally; it is not an identified focus or astigmatism
coefficient. Resolved clean-frame motion explains only about **2–3 µrad**, calculated
at an assumed **0.01625 s** exposure. Fast elevation vibration can average out of the
recorded centroids and remains possible. Fixed sensor/readout row blur fails angular
scaling; filtering the dominant detector noise would introduce a vertical correlation
absent from the recording. Early sensor effects are not excluded by noise isotropy alone,
but lack the required magnitude and lens-step scaling. A raw point-source exposure sweep
at both steps, with focus state and synchronized two-axis motion telemetry, would
separate these origins. No new focus or vibration mechanism is asserted here.

A legacy saved or preset `systemBlurRmsUrad` maps to both missing axes. An explicit axis
wins, including zero; normalization writes only the two-axis representation. A migrated
scalar is preserved as an explicit value, including when its old provenance called it a
preset default. Reselect the sensor preset to adopt the measured pair.
The residual excludes modeled turbulence, exposure jitter and charge diffusion. Do not
also add a defocus or full motion surrogate for that same measured residual. If explicit
motion or temporal smearing supplies part of it, recalibrate the residual first.

`diffusionSigmaPx` is Gaussian charge-spreading sigma in **native pixels**, after
optics and before the native pixel-area footprint. MX-15 uses **0.2 pixel, estimated**,
with sensitivity **0.1–0.4 pixel**; **0** disables. Sources are detector analogies
from two published detector studies.
They do not establish the installed detector MTF. Other presets leave jitter and
diffusion at **0**, absent a corresponding estimate. `opticsEnabled` disables
pupil diffraction; these independent blur controls retain their own zero bypasses.

MTF filtering uses a CPU FFT padded to at least twice the kernel side, clips negative
numerical residuals, crops to finite support and normalizes the retained flux. Support
uses `opticsRadiusPx` for diffraction/turbulence and at least four combined Gaussian
sigmas of the wider axis. Finite turbulence tails, like diffraction tails, are renormalized; increase
support for stronger turbulence or deep-wing fits. Every core is unit sum; finite
image crop loss is still physical. Spatially invariant jitter, diffusion and scatter
convolutions commute. For each axis, calculate
`sigmaAxis² = (residualAxis × 1e-6)² + (jitter × 1e-6)² + (diffusion × pitch/focalLength)²`
in rad². The transfer is `exp(-2 pi² (sigmaX² fx² + sigmaY² fy²))`, with frequencies
in cycles/radian. It is applied once after the separately calculated turbulence and
spectral diffraction, and feeds both scatter branches. Charge spreading and detector-area
integration each occur once. All-zero blur controls reproduce the prior core exactly.

The scatter kernel is `(1-fraction) × delta + fraction × skirt`, with
`skirt(angle) ∝ [1+(angle/shoulder)²]^(-slope/2)` inside a finite angular cutoff.
`scatterPreset` selects these **estimated sensitivity models**, not measured turret PSFs:

| Preset | Fraction | Shoulder, rad | Slope | Cutoff, rad |
| --- | ---: | ---: | ---: | ---: |
| `clean` (default) | 0.003 | 0.000040 | 2.5 | 0.020 |
| `dirty` | 0.03 | 0.002 | 1.7 | 0.10 |
| `custom` | User value | User value | User value | User value |

The source basis is two published technical reports and a published study. These sources
motivate the family and sensitivity scale, not a specific
camera's four parameters. Estimated ranges are retained in `sensorPresets.js`.
Selecting a preset on normalized settings replaces all four values; editing a numeric
value switches to `custom`. Explicit custom inputs should set `scatterPreset: "custom"`.

A 0.02 rad skirt extends well beyond the native field. The near branch includes the
unscattered delta and uses a fine FFT no larger than **4096 texels per side**, choosing
2048 when it fits. Live views compute the same near convolution by packed overlap-add
(`nearConvolutionPlan`): the image is cut into up to 2 × 2 tiles, each padded by the kernel
support, and two real tiles form one complex image, so four tiles share one RGBA32F
transform; the real kernel keeps each tile's convolution in its own channel, and an
overlap-add pass sums the tiles. This is the same full linear convolution with zero
circular wrap, so only float rounding differs: a 640 × 512 detector at 4× needs one
4096² transform, but four 1280 × 1024 tiles fit one 2048² transform (a quarter of the
texels, half of the bytes). The layout is chosen only when its calculated cost is lower.
Its transforms run two radix-2 stages per pass (radix 4), 6 passes per 2048-point axis
instead of 11, with the same twiddles and scaling as the single transform.
Analysis renders keep the single transform, so reference captures are unchanged, and the
self-test compares the two (L2 difference within the float32 FFT bound, detector counts
within one count) and checks the packed path against the CPU convolution. A power-of-two area reduction keeps the full far branch at **1024
texels per side or less**. The near support aims for at least 0.001 rad and sixteen coarse
samples, subject to the fine allocation limit. A complementary smoothstep over the
outer half of the near radius avoids a discontinuity at the split. Both kernels share
one normalization; their summed weight is one. The far branch integrates 4 × 4 samples
per kernel cell, convolves the area-averaged contrast and a conservatively reduced
unit-sum diffraction core, then reconstructs by bilinear interpolation. It retains a
spatial skirt rather than replacing it with a uniform pedestal. Separate fine and
coarse FFT buffers avoid reallocating between scales each frame.

CPU checks bound integrated absolute profile error against a direct, unsplit sparse
point-source convolution to **1% of redistributed flux**: 0.00003 of total flux for
clean and 0.0003 for dirty. These cases include central and off-center sources, rectangular
fields, and partial coarse cells. Tests also use the actual default MX-15, ATFLIR and
OMAHA plans in both clean and dirty modes, with a source at a coarse-cell corner.
The calculated worst-case profile errors are reported by `thermalCoreIteration6.test.js`. This is a tested
numerical tolerance, not a hardware accuracy claim or a guarantee at all custom extremes.
A fully contained split source conserves total flux within 2e-7; tests separately check
far energy, diffraction normalization, and allocation at native 2× and 4× sampling.

Padding covers the summed supports of the blurred core and scatter on each grid.
The **per-pixel background drawn by the sky pass** is subtracted before padding and
restored once after summing both branches. CPU `applyOptics()` accepts either that
fine-grid background image or a uniform scalar in the same radiance units. The
exterior has zero **object contrast**, so smooth sky gradients no longer acquire
frame-edge lines. This treats the modeled background as a locally continued field;
a symmetric normalized PSF preserves a linear gradient. Curvature and abrupt sky/sea
boundaries are an approximation because this background term is restored without
convolution. Off-frame objects are absent. `runSensorChain()` requires an explicit
`backgroundRadiance` scalar or image unless `effectsOff` is selected.
Finite field loss is not renormalized. The finite diffraction tail is
renormalized at kernel construction; increase support for deep-wing fits. Manual sampling that
cannot fit the fine grid within 4096 is rejected, including a 640-column detector at 8×.
Smaller detectors can still use 8×. Hardware limits may be lower; reduce sampling/support
when the allocation error reports it.

## Atmosphere and sensor assumptions

The atmosphere ports a 12-band, nine-channel-per-band positive transfer model. Its
absorption coefficients are estimated, with one broadband surface-path anchor. The
Omaha comparison stays within 8.3% over the saved ranges; this is not a general accuracy
bound. Photon source terms are integrated spectrally, not obtained by dividing energy
radiance by a single photon energy. `evaluatePath()` retains its `quantity` and `band`;
`cloudBackground()` uses both for the cloud Planck source and requires behind-cloud
radiance in that same unit and band. Legacy paths without those fields default to
energy radiance in 3–5 um. This prevents mixing an energy cloud with photon path emission. A quadratic range table retains each band's source
transmission and path emission. Foreground and background use **96 segments**; sounding
level heights split the quadrature at interpolation changes, including upper standard
atmosphere continuation layers. The shader interpolates by square root of fragment range.
Numeric tests independently compare non-vacuum nodes and midpoints with direct
photon transfer, and reject mutations of path scaling or band pairing. One supplied
altitude and center-ray elevation describes foreground transfer in a narrow field;
per-ray elevation is used for the unobstructed sky/sea background only. Finite-range
object transmission and path emission still use that center-ray range table. Automatic sea backgrounds bound the lookup at the surface;
with manual sky, set the lookup range before an Earth intersection for downward rays.
Plume line correlation and
long-range visibility remain uncalibrated.

`surfaceTemperatureK` is sea-level air temperature for the atmospheric profile, default
**288.15 K**, the U.S. Standard Atmosphere 1976 reference. The default standard layers
shift by its difference from 288.15 K, with a 150 K floor; pressure is recalculated
hydrostatically. Explicit `createAtmosphere()` profiles still take precedence.
`ambientTemperatureK` remains air temperature around the object and the fallback for
untagged surfaces. It no longer changes the sea-level profile. No observation-derived
weather for the 2014 recording is supplied by these defaults.

### Measured soundings

`sounding.js` exports `parseSoundingCSV(text, metadata)`, `parseIGRASounding(text, metadata)`
and `atmosphereFromSounding(sounding, options)`. The latter returns
`{atmosphere, contentKey, assumptions, levels}`. `atmosphere` is a
`createAtmosphere({profile})` object; its key is a stable serialization of effective
numeric profile content and options. Equivalent content reuses the pipeline's range
and sky caches even when it comes from a new parsed object. Changed weather, visibility,
geometry or band invalidates the corresponding cache.

```js
import {parseSoundingCSV, atmosphereFromSounding} from "./sounding.js";
// text is supplied by the host's file loader; units are defined by the CSV header.
const sounding = parseSoundingCSV(text, {stationId, stationElevationM, time});
const {atmosphere, contentKey, assumptions} = atmosphereFromSounding(sounding);
pipeline.render({scene, camera, settings, sounding, target: null, frame: 0});
```

The CSV columns are `level_type, pressure_Pa, geopotential_height_m, temperature_C,
relative_humidity_pct, dewpoint_depression_C, wind_dir_deg, wind_speed_m_s`. Column order
can vary; all eight names are required. Blanks remain null, and wind-only levels are
retained by the parser. This numeric CSV format does not use quoted fields.

The fixed-width parser accepts **one complete sounding**, its header and the declared
number of level records, from radiosonde archive period-of-record files. It follows the
archive's published format description.
It retains level types, flags and raw records; missing or rejected values (`-9999`,
`-8888`) become null. Temperatures, relative humidity, dew-point depression and wind
speed are decoded from tenths. Parsed temperatures are K, pressure Pa, height m,
humidity percent, depression K, wind direction degrees and speed m/s. Station elevation
is supplied separately because the sounding header does not contain it.

The measured profile replaces settings-built temperature, pressure and water vapor
for both foreground transfer and sky. `visibilityM` still sets the aerosol model.
`surfaceTemperatureK` continues to set assumed sea temperature when the ray hits the
surface. Conversion retains the following **estimated assumptions**, with reasons
available in `assumptions` and `lastFrame.atmosphere`:

- Use only levels with pressure and temperature. Anchor an absent lowest height at the
  supplied station elevation; reject a sounding lacking both. Estimate missing heights
  with `deltaZ = 287.05 × mean(T) / 9.80665 × ln(pLower/pUpper)` m. This dry hypsometric
  calculation ignores virtual temperature and treats geopotential height as geometric
  altitude. Repeated or reversed heights are omitted to keep a single-valued profile.
- Use dew-point depression in preference to relative humidity. With temperatures in
  degrees C, `e = 611.2 exp(17.67 Td/(Td+243.5))` Pa; with RH, multiply the same saturation
  expression at air temperature by `RH/100`. Water density is `e/(461.5 T)` kg/m³ with
  **air temperature T in K**. The liquid-water convention extends below freezing.
  Source: a published meteorological study.
- Interpolate temperature and water density linearly in height, pressure logarithmically.
  Hold the lowest available value below its report. Above the last humidity report, decay
  density exponentially with estimated `humidityScaleHeightM: 1000` m, until the highest
  temperature level. No humidity reports is an error, not an assumed dry sounding.
- Above the highest temperature level, use the U.S. Standard Atmosphere 1976 shape with
  temperature shifted and pressure scaled to meet that level, a 150 K temperature floor,
  and zero water vapor. This upper continuation is not a measurement or a newly integrated
  hydrostatic solution for the shifted temperature. Visibility defaults to an estimated
  23000 m and remains independent of the sounding; the profile is horizontally uniform.

The inline public-data regression uses Santo Domingo, station CIM00085586, 2014-11-11
12 UTC, station elevation 77 m, from a radiosonde archive.
For sensor altitude 1382 m, target altitude 7480 m and slant range 124979 m, the spherical
ray and 96-segment calculation give **0.180199** in-band photon transmission of a
750 K blackbody and **279.5836 K** unobstructed sky brightness at the sensor in 3–5 um.
Tests require agreement within 1% of 0.180 and 279.6 K. These are calculated reduced-model
outputs using measured weather levels and estimated interpolation/absorption, not measured
transmission or camera radiometry. The launch's spatial and temporal differences from a
scene remain the caller's uncertainty; the converter does not infer intervening weather.

Exposure multiplies photon radiance by pixel area, pupil solid angle, fill factor,
optical throughput, quantum efficiency and integration time. `exposureMode` defaults to
`wellFill`: `t = wellFillFraction × wellElectrons / (referencePhotonRate + darkRate)`.
The blackbody reference is `wellFillReferenceK`, default **300 K**, evaluated in the same
band and through the same detector exposure factor. `wellFillFraction` defaults to **0.5**.
The target applies before dark subtraction. Signal counts are slightly below half scale
when dark current is nonzero; raw ADC counts additionally contain the pedestal. The reference excludes shading and atmospheric attenuation:
it represents an unshaded blackbody at the detector input. This is an **estimated exposure
policy**, motivated by published detector NETD comparison conditions at 50% well
(manufacturer data sheets), not a recovered camera controller. There is no
extra NETD noise term. Only `manual` uses `integrationTimeS` (default 0.002 s).
The calculated time is reported in `pipeline.lastFrame.integrationTimeS` and the CPU
`runSensorChain()` result. No unknown hardware exposure or frame-period clamp is imposed;
zero photon throughput in well-fill mode throws because the reference cannot be reached.

`shadingK` defaults to **0.30 K equivalent at a fixed 300 K reference**, with estimated
sensitivity range 0.05–0.5 K; zero disables it. `shadingWidth` defaults to **0.9** detector
half-widths (range 0.5–1.5). For native pixel radius divided by detector half-width `q`,
the map is `shadingK × (1-exp(-q²/(2w²))) / (1-exp(-1/(2w²)))`. It is zero at the
geometric center and reaches the named amplitude at `q=1`; corners can exceed that
amplitude. Pixel centers sample the function, so an even grid has no exact center pixel.
The analytic Planck derivative from `radiometry.js`, evaluated at 300 K in the selected
band, converts equivalent kelvins into a signal offset **before exposure and shot noise**.
It scales with exposure, stays fixed across frames, and is cropped with the detector by
digital zoom. It is an estimated residual optical shading field, consistent with two
published studies; its cause is not uniquely identified as narcissus.

`fixedPatternFraction` defaults to **0.0002 of ADC range RMS** (estimated range
0.0001–0.0004, from a published study and published manufacturer comparison data).
It gives 3.2766 counts RMS before ADC rounding/clipping. A separate deterministic stream
of `noiseSeed` generates a native per-pixel offset map. It is fixed across frames, follows
digital crops, and is added after well clipping and dark/read corrections, before ADC
rounding/clipping. It does not scale with exposure. `noiseEnabled` controls temporal
noise only; set `fixedPatternFraction: 0` to disable residual fixed pattern.

Shot noise is Poisson
below 64 electrons and a rounded Gaussian approximation above. Per-pixel integer hashes
combine the seed and frame; repeating a frame repeats its noise. Well clipping precedes
mean dark subtraction and Gaussian read noise. An **estimated 256-count electronic
pedestal** (`adcOffsetCounts`) is added before ADC rounding/clipping. This is
`256/16383` of full scale, more than 70 times the default combined read/fixed-pattern
RMS of about 3.5 counts, calculated from the preset. It is not a measured readout offset.
Raw and temporally filtered readbacks retain it. Manual signal-count windows and fixed
radiometric endpoints add the same offset when indexing raw counts, thereby removing
it from display calibration; automatic windows and plateau CDFs absorb it through
statistics. The ADC ceiling remains 16383, so pedestal headroom reduces maximum
recoverable signal. A 0 setting retains the idealized zero-offset ADC. ADC clipping follows. Charge spill and persistence are not modeled.

`temporalFilterAlpha` applies a recursive filter to the native ADC count image before
gain: `y[t] = (1-alpha) x[t] + alpha y[t-1]`. Alpha zero is off. The MX-15 default is
**0.30, estimated**, with sensitivity **0.15–0.55** from the IB6830 recording's temporal
noise and codec controls. It is a surrogate for pre-encode memory, not an identified
hardware coefficient or stage. Alpha describes memory per delivered frame; the source
recording is **30000/1001 frames/s**. It is not the gain time constant.

Forward frames advance once; a gap of k frames uses `alpha^k`, assuming the current
sample throughout the omitted interval. This is a seek approximation, not synthesis
of unrendered noise. Repeated or backward frames reset to current raw counts, matching
the gain policy and making paused camera/scene edits immediately visible without stale
ghosts. Lens, detector, exposure and gain-mode changes reset history. Continuous PSF
range and turbulence updates preserve it; display zoom and polarity do too. Raw ADC
readback stays untouched. The CPU `temporalFilter()` returns caller-owned state;
`runSensorChain()` accepts `previousTemporal` and returns `temporal` and `filteredCounts`.

For independent dynamic noise the calculated stationary RMS multiplier is
`sqrt((1-alpha)/(1+alpha))`, **0.7338 at alpha 0.30**. Fixed-pattern offsets remain.
Warm up the filter before noise comparisons and recompute a noise-matched display
window with dynamic and static texture treated separately. An old matched window is
not a calibration after changing the temporal filter.

Manual gain/level is a fixed count window. Automatic mode estimates percentile endpoints.
`agcDynamics: "endpoints"` relaxes them with `1-exp(-dt/timeConstant)`. MX-15 instead uses
`"gainOffset"`: form `g = 1/(high-low)` and `b = -low*g`, relax g and b, then recover the
window as `low = -b/g`, `high = (1-b)/g`. Its **0.12 s estimated** constant, sensitivity
**0.10–0.15 s**, describes the recording's displayed affine recovery after lens blanking;
it does not calibrate smoothed percentile endpoints or identify the statistics region.
Both policies use frame differences and frame rate.
Repeated frame numbers recompute the current image window without smoothing, including
camera motion while paused. Backward seeking, mode changes, and grid changes also reset it. `gainRegion` defaults to `detector` (whole native frame). With
`displayed`, both percentile endpoints and the plateau histogram use native sample
centers inside the centered digital-zoom rectangle. Interpolated/enlarged display
samples do not acquire extra histogram weight. Subpixel crops retain the nearest
central sample(s). Selecting a new region, or changing zoom with displayed statistics,
resets the temporal window. Detector-region zoom leaves the window history alone.
Manual and fixed radiometric modes do not use image statistics. The region policy is
**estimated**; the recorded camera's statistics region is unknown.

Plateau equalization builds **16384 bins at one ADC count per bin**, before percentile
clipping. Temporally filtered fractional counts use nearest-level indexing. The cap is
`plateauFactor × statisticsSampleCount / 16384`; excess population is discarded and the
first occupied cumulative count is subtracted. The count-indexed CDF uses a 256 × 64
scalar texture on the GPU. Percentile endpoints affect automatic mode and the constant
plateau fallback, not the populated plateau histogram. Source: a published study of
plateau equalization of digitized detector levels. Constant images retain their drive.
Local enhancement adds signed Gaussian high-pass detail before clipping, allowing a
lighter or darker ring around a clipped source.

### Fixed display curve and recording polarity

The order is count window (or plateau drive), local enhancement, clipping to **0–1**,
optional input gamma, fixed `displayCurve`, **8-bit quantization**, then polarity.
`displayCurve: "linear"` is the generic identity; MX-15 carries and selects a measured
lookup table (LUT). Keep `responseGamma: 1` to reproduce the measured law. Gamma remains
an independent input remapping; a power law alone cannot produce this U-shaped gain.
The curve is fixed and scene-independent; window selection remains separate. It does
not turn automatic mode into histogram equalization.

Status: **measured from the IB6830 video (target-independent noise and fixed-pattern
gain); algorithm unidentified**. Across both lens steps the gain minimum stays near
black-hot code **166**, while the scene histogram changes. Relative slopes at black-hot
codes **58 / 166 / 234** are approximately **5.2 / 1 / 3.2**; the minimum slope is about
**131 codes per unit drive**. The U depth has **±20% uncertainty in ln(gain)**, corresponding
to ratio envelopes **3.7–7.2** and **2.5–4.0** at the warm and cold witnesses. These are
measurement uncertainties, separate from numerical test tolerances.

The **257 measured nodes** have uniform drive `u=i/256`. Store the warm-increasing
response `A=(255-T)/255`, where T is the measured black-hot table, and interpolate
linearly between Float32 nodes on both CPU and GPU. The supplied table's terminal
**−1 black-hot code** is clipped to **0** to stay within the display range; interior
nodes are unchanged. The published interface does not depend on external data files.

`polarityAffine: {gain: 1, offset: 0}` is the default for every preset. Given the
quantized warm-increasing code q, black-hot is exactly `255-q` and white-hot is
`round(clamp(gain*q+offset, 0, 255))`. Thus default polarity inversion remains exact,
including rounding ties. The affine is available as `polarityAffineGain` and
`polarityAffineOffset` menu controls, saved by both hosts. `polarityAffine: {gain, offset}`
is the API input shorthand; normalization expands it into the two saved controls,
without retaining a duplicate object. Gain
is dimensionless and nonnegative, with an estimated sensitivity-control range **0–10**;
offset spans **−255 to +255 codes**, calculated from the full display range. Nonfinite
values are rejected. An explicitly supplied object overrides the scalar controls.
Subsequent menu edits and sensor-preset selections use only the saved controls.

`POLARITY_PROFILES.IB6830` in `sensorPresets.js` documents the optional recording
profile **gain 1.05 / offset +55 codes**, measured from the same sky field across a
polarity switch, with uncertainty approximately **±0.01 / ±1 code**. It may be an
operator setting and is **not a preset default**. Apply it explicitly:

```js
import {POLARITY_PROFILES} from "./sensorPresets.js";
const recordedWhiteHot = {...settings, polarity: "whiteHot",
    polarityAffine: {...POLARITY_PROFILES.IB6830.polarityAffine}};
```

The observed relation is white = `1.05 × (255-black) + 55`, followed by clipping.
A single white-hot sequence has residual gain differences; the recording does not
identify the underlying algorithm or establish transferability to another camera.

Fixed radiometric mode maps the inferred received photon radiance to fixed endpoints
using the exposure factor. Its default upper endpoint is calculated as
`max(0, min(well - meanDark, well × (1-pedestal/16383))) / electronsPerRadiance`.
For the current MX-15 defaults this is **0.8238587042 × 1e20 photons s⁻¹ m⁻² sr⁻¹**;
the well-fill exposure is **0.0131651772 s**, calculated with the 0.150 m pupil.
Derived endpoints follow exposure changes; explicitly edited endpoints remain fixed. It is independent of scene histograms. Clipped detector values
cannot recover lost radiance. Zero optical throughput makes this mode undefined and
throws. The camera presets are conditional models: the selected Omaha optical/electronic
zoom split, pitch and pupil remain estimates. ATFLIR's 640 × 480 array and nominal
3.7–5.0 um band are published in a technical paper; its pitch, pupil and nominal
0.7° field remain estimated. The narrow field's active crop is unresolved, so the model's
rectangular field must not be taken as a verified square display mapping. A published
manufacturer data sheet for the Sea Star SAFIRE III establishes the candidate's 640 × 480
array, 3–5 um band and 25–0.35° total field range, but neither the field axis nor its
optical/electronic allocation.
The conditional 0.7° horizontal optical branch and its calculated vertical field/focal
length remain; 0.35° all-optical is not excluded. Unverified hardware values stay estimated.

The MX-15 model uses a published legacy-family 640 × 512 array and **20 um pitch**.
The module-maker evidence is a published corporate annual report and a published
manufacturer company profile identifying Cincinnati Electronics' MX-Series module.
With the **0.675 m** readout (a published first-person IB6830 integration account),
`2 atan(512 × 20e-6 / (2 × .675))` gives **0.8691815°** vertical field. This agrees within
0.2% with the video's 0.915° scale over 1080 display lines, adjusted to the 1024-line inset:
`0.915 × 1024/1080 = 0.86756°`. The 1280 × 1024 picture is a 2× enlargement, not the
physical array. The nominal **3–5 um** band is **published** in a manufacturer data sheet;
installation attribution and flat response remain estimated. An earlier published
operations manual instead states **3.4–5.2 um** for the MX-15i variant.
The preset retains the later nominal band; the atmospheric model supports only 3–5 um.

### Stepped optics and display mapping

`focalStep` selects **27 / 135 / 675 / 1012 mm**, published in a manufacturer operations
manual.
The default is **675 mm**. The last step uses **1.012 m**, the printed manual value;
**1.0125 m** is the separate calculation `0.675 × 1.5`, not a verified rounding rule.
The 675 and 1012 optical steps are corroborated by fixed-pixel positions, lens-switch
transients and readouts in the IB6830 recording.

| Focal step | Native detector | Displayed central window | Reference picture |
| --- | --- | --- | --- |
| 27 / 135 / 675 mm | 640 × 512 | 640 × 512 | 1280 × 1024 |
| 1012 mm | 640 × 512 | 480 × 384 | 960 × 768 |

The windows are **calculated from measured inset dimensions and 2× fixed-pixel spacing**.
The full array continues to collect counts at every step; only presentation is cropped.
The 1012 window's calculated horizontal field is `2 atan(480 × 20e-6/(2 × 1.012))`,
approximately **0.5435°**; the measured inset mapping is approximately **0.5425°**.
A host-supplied physical presentation mapping sets scale without a second magnification;
the available window still masks outside samples black. Displayed-region gain uses the
intersection of that mapping and the available detector window; whole-detector gain still uses all samples.

`pupilReferenceM` is **0.150 m at 675 mm, estimated**, with working range
**0.120–0.180 m**. It follows comparison f/4–f/5.5 lens classes and a published study,
whose **0.160 m** later MX-15D reconstruction is not a measurement of this legacy pupil.
The old **0.135 m**
control and broader **0.1125–0.225 m** sensitivity envelope remain possible inputs.
`pupilPolicy: "holdFNumber"` is the estimated default: `D = Dref × f/0.675`, giving
**f/4.5** and **0.224889 m** at 1012 mm. `"keepPupil"` holds **0.150 m**, giving
**f/6.7467** there. Neither policy is verified hardware behavior. Holding a 0.150 m pupil at
27 mm would exceed the numerical-aperture limit and is rejected; use Hold f-number
or a reference pupil at most **0.054 m** (`2 × 0.027 m`, calculated) for that step.

The evidence conflicts: source-lobe separation in the model favors holding f-number;
excess noise relative to the source favors keeping the pupil at unchanged exposure.
Exposure at the step is unknown and can change that comparison. Both policies remain
explicit. The measured angular residual is exposed separately on the horizontal and vertical axes;
it does not select a focus mechanism or settle the pupil-policy uncertainty.
`focalStep: "free"` enables `fieldMode` and independent pupil edits. Presets without
steps always use Free. Explicit legacy field/focal settings and edits to linked optics
leave step mode, preserving custom setups. Selecting a step reapplies its mapping.

`sampling: "sampleCentered"` is the MX-15 default, **calculated from measured fixed-pixel
footprints**. At 2×, sample i lands on output pixel 2i from the top left and an impulse reads **0.5/1/0.5**.
`"linear"` retains half-pixel alignment, **0.25/0.75/0.75/0.25**; `"nearest"` retains
sample replication. For native extent N, output extent M and crop scale c, the centered
coordinate adds `0.5 - 0.5*N*c/M` to the half-pixel coordinate measured from the
top left. The GPU reverses the Y correction for its bottom-first buffers. Display interpolation
changes neither detector counts nor histogram weighting.

The preset audit's proposed values/statuses are applied, including array/band
sources, uncertainty ranges, explicit detector analogies, and unverified ATFLIR/SAFIRE
field/pupil assignments. Source text uses published sources and explicit model assumptions.
No numerical audit proposal is omitted. The database's earlier unresolved 1012 mechanism
is superseded by the optical-step evidence above. No signature change was required.

## Settings and verification

`THERMAL_PARAMETERS` is the menu contract: key, group, type, unit, default, min, max,
step, English label/tooltip, choices, and preset status/source metadata.
`defaultSettings()`, `settingsForPreset(name)` and `normalizeSettings(input)` return fresh
objects. A pupil diameter greater than twice the focal length is rejected because
its projected collection solid angle would exceed pi sr. Cold Wien-tail quadrature
uses a calculated absolute convergence floor of **1e-280** in each returned unit,
avoiding subnormal precision failures at allowed near-zero temperatures. Numeric inputs clamp; non-finite values, wrong types and reversed intervals
throw. Steps describe UI increments, not forced rounding of physical measurements.
Linked focal length and field remain consistent. `presetMetadata` survives serialization
and identifies edited preset values. Temperature/emissivity settings provide suggested
values for authoring tags; empty models still use the documented ambient fallback.

Run the core numeric tests and import check:

```sh
npx jest tests/thermalRadiometry.test.js tests/thermalAtmosphere.test.js tests/thermalSensorMath.test.js tests/thermalSchema.test.js tests/thermalCoreIteration2.test.js tests/thermalCoreIteration3.test.js tests/thermalCoreIteration4.test.js tests/thermalCoreIteration5.test.js tests/thermalCoreIteration6.test.js tests/thermalCoreIteration7.test.js tests/thermalSignatures.test.js tests/VehicleThermal.test.js tests/VehicleThermalControls.test.js tests/VehicleThermalRearView.test.js tests/ThermalViewIntegration.test.js tests/ThermalPipelineHost.test.js
npm run check-three-imports
```

In a browser page with the host's `three` import map:

```js
const {runThermalSelfTest} = await import("./selfTest.js");
const report = await runThermalSelfTest();
console.table(report.checks);
```

The self-test creates and disposes its own offscreen renderer. It returns
`{pass, checks: [{name, expected, measured, tolerance, pass}]}` and catches shader/setup
errors as explicit failed checks. It measures uniform radiance and counts, point-source
flux, coverage stability, Fourier convolution, ADC endpoints, all processing modes,
polarity, fixed radiometric scene independence, deterministic noise, and error restoration.
CPU tests cannot substitute for this GPU check.

The optical convergence check uses four equal subpixel sources at the projected
A340-600 lateral engine stations, ±9.37 m and ±19.27 m, viewed from 125000 m with the
MX-15 optics. Stations are published in a manufacturer aircraft planning document.
Range, equal 750 K emission, 0.25-pixel discs and subpixel offsets are estimated test
conditions. A 32 × 32 detector crop, 8-pixel core support and disabled scatter isolate
the diffraction sampling. Integrated absolute sampled-radiance difference between
Nyquist 4× and reference 8× must be at most **5% of the 8× flux**; the CPU result is
**3.3758%**. Nyquist GPU versus independent CPU coverage must agree within **1% of CPU
flux**. These are numerical tolerances, not hardware accuracy claims. Jest runs the
same source case through the CPU optics and detector footprint.

The uniform sky/sea GPU checks use an orthographic camera and compare its sampled background with CPU
`clearSky` or `seaBackground`: maximum relative radiance error at most **1e-5**, and
reported brightness temperature within **1e-9 K** of the CPU value. Jest runs both
background calculations, including the photon-band sea-emission check. WebGL execution
of these checks remains required.

The additional browser checks require: reported well-fill time matching the CPU result
within 1e-12 s and a zero-dark 300 K reference within one ADC count of half well; shading
matching CPU counts within one count; unchanged native shading across frames and 2× zoom;
zoomed output matching the centered native crop within 1e-6 normalized units; fixed pattern
matching CPU within one count and identical between distinct frames; and full padded
far-skirt energy within **0.5%** of incoming flux times the allocated far fraction for both
clean and dirty. Cropped far profiles must also agree with CPU to **0.5% of full far flux**
in integrated absolute error. These GPU checks must be run on WebGL; Jest does not execute
the shaders.

The per-pixel sky checks use a perspective field, with default up and with 90-degree
roll, and compare five fine-grid pixels with the CPU elevation table: **maximum relative
photon-radiance error 1e-5**. The blurred-point test enables **r0 .572 m**, **2.714 µrad
axis jitter**, **.2 native-pixel diffusion**, and full detector fill. Its GPU optics
must match CPU convolution within **0.1% integrated absolute error / source flux**,
conserve contained fine-grid flux within **0.2%**, and match independently rasterized
CPU source coverage plus native sampling within **1% of CPU flux**. Jest executes both
CPU reference cases and separately tests each blur, the MTF, wavelength scaling and
gain statistics regions. These tolerances are numerical acceptance policies, not
hardware accuracy claims. The new GPU checks still require `runThermalSelfTest()` in
a WebGL browser.

The enlargement self-test compares all three shader kernels with `enlargeImage()` to
**1e-6 normalized error**, and checks the exact centered impulse phase. The temporal
self-test compares consecutive, skipped, repeated and backward frames against the CPU
recursion to **0.002 count**, verifies filtering precedes gain to **1 display code**,
and verifies alpha zero preserves raw counts exactly. After **16 warm-up frames**,
**64 frames of independent read noise** must give the variance ratio **0.7/1.3** within
**0.02 absolute**. These are estimated numerical acceptance tolerances; they do not
validate a camera's undocumented firmware. Run `runThermalSelfTest()` on WebGL before
accepting the shader behavior. The GPU also needs the lens-step visual check: 1012 mm
must narrow optical sampling while showing the central 480 × 384 samples, enlarged 2×.


The additional browser comparisons require a surface at both a node and a midpoint
of a non-vacuum range table to match direct CPU photon transfer within **0.1%**.
Unequal-population scenes must separate plateau from automatic by at least **100 display
codes**, and automatic from manual by **50**, before GPU/CPU comparisons within **1 code**.
Advancing, repeated and backward frames must reproduce CPU gain endpoints within
**0.002 count**. A **40 × 24** detector tests nonzero dark current and rectangular
shading, then **16 expected photoelectrons** tests the exact Poisson branch: maximum
GPU/CPU difference **2 counts**, mean absolute difference **0.1 count**. These are
estimated numerical acceptance tolerances. Uniform atmospheric sky is tested with
both gradient settings; clean and dirty scatter with a nonzero sky must match CPU
optics within **0.1% of source-contrast flux**. A sky-only gradient must preserve all
edges within **1e-6 scaled radiance unit**. Minification must match CPU area averaging
and conserve the impulse integral within **1e-6**. R32F/RG32F rendering and portable
RGBA32F readback staging must complete without framebuffer or shader errors.

The default MX-15 resident render-target budget is calculated from allocated dimensions,
formats and 4 bytes per depth sample by `thermalCoreIteration6.test.js`: **532.141 MiB**
with both temporal buffers and a maximum coverage tile, excluding the caller's output,
textures, CPU arrays and driver overhead. The fine FFT trio is **384 MiB**
(`3 × 4096 × 4096 × 2 × 4 bytes`); scalar fine grids including the sky total **100 MiB**.
Temporary RGBA32F readback adds **5 MiB** for native counts, **80 MiB** for a fine-grid
diagnostic, or **256 MiB** if explicitly reading a full fine FFT. Staging is disposed
immediately, so diagnostic readbacks do not retain that allocation. Local enhancement
adds **2.5 MiB** when enabled. These are storage calculations, not a GPU memory survey.

Serialized explicit values remain authoritative. Older records without reliable
provenance cannot distinguish an intentional custom setting from a superseded preset
default; they are not silently rewritten. Reselect the sensor/scatter/optical-step preset
to adopt new defaults. This limitation is separate from the new parameter defaults.

The measured-curve browser checks must show a monotonic **0–1** response, CPU/GPU
normalized error **≤1e-6**, slope at black-hot code **166 = 131 ±3 codes/drive**, and
relative slopes **58/166 = 5.2 ±0.12**, **234/166 = 3.2 ±0.10**. Linear and measured
curves must agree with CPU display codes to **1 code**, including the optional
recording affine; default white-hot plus black-hot must be exactly **255**.
The two-axis blur checks at **0.675 and 1.012 m** must recover horizontal **0** and
vertical **40 µrad RMS** within **0.15 µrad**, preserve contained flux within **0.2%**,
match CPU optics within **0.1% of source flux**, and match native samples within
**1e-5 of source flux**. The native vertical-width ratio must equal `1.012/.675`
within **0.005**. These are calculated test geometries and estimated numerical
acceptance tolerances. Jest checks the numeric references and uploaded shader inputs;
only the browser self-test executes WebGL and establishes GPU parity.

### Moving-camera execution

`ThermalPipeline` defaults to synchronous analysis: optics, foreground transfer,
sky tables and same-render gain are complete before `render()` returns. Live hosts
select `{analysis: false}`; `{synchronous: true}` can retain deterministic CPU
preparation while independently testing fenced gain. Worker URLs resolve against
their owning module, without a document base. Unavailable constructors, evaluated
bundles and worker load/message failures fall back to the same validated
interpolation domain, built on the rendering thread once per optical structure and
turbulence interval and then sampled each frame, so a moving camera does not rebuild
the optical basis every frame. That build blocks its frame, so the self-test's
moving-camera CPU gates apply only where a worker exists; elsewhere the timings are
reported but not gated. Disposing a view terminates its worker and ignores late replies.

Interactive optical construction runs in a module worker. The frame path only
mixes the received photon spectrum with a cached finite response and submits GPU
spectra. The basis key excludes the exact path-derived coherence diameter.
Instead, cubic interpolation in turbulence strength `q = r0^(-5/3)` is checked
against independent finite responses at each interval's quarter points and
midpoint. An estimated factor-two validation margin is included. Interpolation
uses at most one quarter of the estimated `1e-4` kernel L1 reuse allowance.
Clamping and normalization are included in that comparison. Kernel support,
wavelength integration and the atmospheric model are unchanged.

The calculated consequence of a kernel L1 bound is an absolute image error no
greater than that bound times maximum absolute input contrast. Absolute modulation
transfer error has the same bound. A replacement is prefetched inside the validated
domain. Completed kernels and spectra remain active until replacements are ready;
render never waits for the worker. Before the first response it draws a coarse
preview containing residual Gaussian blur and scatter, with diffraction and
turbulence explicitly omitted. This positive, normalized preview has a calculated
universal kernel L1 bound of `2`, displayed in the readout along with the resulting
radiance bound. This deliberately loose bound does not certify optical fidelity.
The worker publishes the exact requested response before constructing the wider
reuse domain. Wavelength diffraction, its forward transform and fixed Gaussian
transfer are reused across validation samples; finite crops remain unchanged.
Subsequent edits keep drawing with the last valid kernel. Changed image dimensions
receive a new preview with matching support. The host's
`onReady` callback requests another frame, including while playback is paused.
Initialization time is reported separately by the benchmark.

A discontinuous turbulence change can leave the validated interval before the
worker completes. Compatible old support continues drawing with an explicitly
reported universal L1 bound of `2`; `outsideValidatedDomain` distinguishes this
transient from certified `1e-4` reuse. This bound is conservative and is **not** a
claim of noise-level agreement. The moving GPU checks require that neither of the
estimated benchmark tracks enters this fallback after initialization.

Foreground transfer uses a separate validated cache. At every range node, quintic
angular interpolation and linear altitude interpolation are compared with direct
photon transfer at interior angles and heights. Estimated numerical allocations are
`1e-4` absolute transmission and the photon radiance equivalent of `0.001 K` at
`300 K` for summed path emission, including a factor-two validation margin. Thus
additional radiance error is bounded by `1e-4 * sum(source bands) + B'(300 K)*0.001 K`
for any nonnegative source spectrum. Existing range interpolation remains unchanged.
Profile content, band, maximum range and ray mapping invalidate the domain. The Earth
radius at the observer changes by centimetres per frame as the camera moves, so it is not
part of the key: each range and sky domain records the radius it was built at and serves
requests within an estimated `100 m` of it, which moves a 200 km path's altitude by at
most about 6 cm. A domain is prefetched when the camera, at its current rate, would leave
it within twice the build lead time. New
tables are constructed in estimated `4 ms` cooperative slices, yielding after each
range node. Outside a valid range domain, the direct synchronous range table supplies
the frame while the reusable domain is constructed. No missing table blanks the output.
These are sampled numerical certificates, not bounds on physical model uncertainty.

The sky cache retains its estimated `0.005 K` budget. Interactive tables begin with
an estimated `17`-node seed and refine to the same `0.002 K` angular tolerance;
reference table generation retains its original `65`-node seed and exact elevation
interval. Unchanged inputs retain the identical table and GPU upload. Analysis
comparisons use that same reference table; interactive comparisons explicitly use
the `0.005 K` brightness bound rather than asserting bit equality with a different
angular approximation. Separate horizon limits and the existing `0.001 K` altitude
validation are preserved.

Automatic and plateau gain retain fenced, one-render-late readback. Polling never
waits. An advancing frame applies the newest unused sample of an earlier frame; each
sample applies once, never across a gain-key change and never from a later frame. A
re-render of the same frame, or a backward seek, recomputes the window from that
frame's own statistics, as analysis mode does. Until a usable sample is ready the
last valid window is held, through re-renders and seeks, and diagnostics report the
miss; the full ADC interval is shown only before the first sample and after a
gain-key change. When the held window did not come from the current frame's
statistics, the pipeline asks its host for one more render once they are ready, so
a view that renders on demand settles on them. Manual and radiometric gain require
no readback. Analysis mode retains the same-render gain used by reference comparisons.
A synchronous WebGL call (a state query, or reading a pixel buffer) waits for all GPU work
queued before it; the readback therefore sets the pack state it needs without querying it,
and a render reads completed samples before it queues its own passes.

GPU pacing: a host that draws again on its next animation frame passes `pace: true`
(Sitrec does so only for the main loop's draws). Such a render starts only after the
previous one has completed on the GPU, as a fence reports; a draw before that shows the
last image, and the pipeline asks the host for a render when the fence signals. Without
pacing a live view queued frames faster than the GPU finished them. Exports, screenshots
and comparisons read the image right after rendering, so they leave pacing off and always
get the frame they request. `framesInFlight` (default 1) allows more paced frames on the
GPU at once. Measured on the testbed with a 30 Hz loop, two raised playback from 14 to 22
new frames per second, but each gain readback then waited about 15 ms behind the other
frame, so the default stays one.

Run `node tools/thermal/benchmark.mjs --moving` for measured CPU preparation on
estimated transverse tracks at `250` and `822 m/s`, `300` frames at `30 Hz`, starting
at `2000` and `125000 m`. Geometry-derived turbulence is recomputed on every frame.
`--analysis --frames=12` reproduces exact-key construction cost without a long
reference run. Reports include median, p95, maximum, initialization, cache misses,
validation errors and worker construction. Timing never includes worker waiting in
a frame's CPU cost. Cooperative work between frames is reported separately and included in
`cpuIncludingCooperative`, which decides the CPU budget gate. GPU
upload, execution, scene traversal and gain are excluded from this CPU harness.

`runThermalSelfTest()` retains independent CPU/GPU radiometry comparisons and runs
both speeds and ranges through the full native renderer. It must complete all
frames, keep optical error at most `1e-4`, and show median CPU preparation at most
`33 ms` with no preparation above `50 ms`. Fenced gain must meet its existing
one-render latency and numerical comparison gates. Existing IB6830 lens-step,
flux, counts and display tests remain required. GPU time comes from asynchronous
`EXT_disjoint_timer_query_webgl2` stage queries when available; disjoint samples are
discarded. CPU submission, wall cadence, worker initialization and GPU execution
are separate quantities. A failed timing gate is reported without reducing sampling.
