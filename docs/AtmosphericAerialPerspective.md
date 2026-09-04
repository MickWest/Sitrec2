# Atmospheric Aerial Perspective

Sitrec's look-view atmosphere uses aerial perspective whenever Atmosphere is enabled. Horizon haze is part of the atmosphere model rather than a separate optional effect. The goal is that distant terrain, buildings, and the sky behind them are derived from the same line-of-sight atmosphere model rather than from separate, hand-matched colors.

## Physical Basis

The model follows the standard participating-media form:

```text
pixel = surface_radiance * T(camera -> surface) + L_air(camera -> surface)
```

`T` is transmittance through the air mass along the view ray. `L_air` is path radiance added by scattering along that same ray. For an empty sky pixel, there is no surface hit, so the sky color is the same path-radiance model evaluated to the atmosphere/space background.

This is the important visual invariant:

```text
as T approaches 0, surface pixels converge to the sky radiance for that same view ray
```

That is why a distant hill should fade toward the exact sky color behind it, not toward a single global fog color.

Sitrec currently uses Koschmieder visibility to map the Atmo Visibility control to extinction:

```text
beta_extinction = 3.912 / visibility_meters
T = exp(-beta_extinction * ray_distance_meters)
```

The constant 3.912 corresponds to 2% contrast at the meteorological optical range. This makes the Atmo Visibility value a physical input rather than an arbitrary artistic slider.

The older fallback fog path uses a different density mapping (`getAtmosphereDensity()` uses
`sqrt(ln 2) / visibility`). The control is therefore labelled as a meteorological visibility
control without promising one contrast threshold for both rendering paths. The aerial-perspective
path described here uses the 2%-contrast Koschmieder constant 3.912.

## Current Implementation

The look view renders the sky with a horizon-to-zenith gradient. The aerial-perspective pass then renders a lightweight distance prepass and composites the scene with the same per-ray sky color:

```text
scene_out = scene_in * T + sky_ray_color * (1 - T)
```

The pass is intentionally disabled unless it is needed:

- view is `lookView`
- Atmosphere is enabled
- IR mode is off
- XR mode is off
- the legacy `GlobalDaySkyScene` path is not active

When disabled, no aerial-perspective shader material or distance render target is allocated, and the existing render path is used.

The distance prepass writes normalized view-ray distance into a render target rather than relying on hardware perspective depth. This avoids precision loss from Sitrec's very large camera far planes, which can span Earth-scale and satellite-scale views.

For terrain and 3D tile views near the horizon, the pass also computes an analytic Earth-surface/horizon distance from the camera altitude and view direction. This is used as a conservative lower bound on the air mass when the lightweight distance prepass under-reports terrain distance because production terrain shaders use custom positioning. The intent is physical: a nearly horizontal sightline through tens of kilometers of low-altitude air should accumulate the optical depth implied by the visibility input, even if a render-engine detail fails to provide an exact terrain hit distance.

For high-altitude and near-space views, the aerial-perspective pass separates background sky radiance from finite-path terrain airlight. The sky can become dark because little atmosphere remains above the camera to scatter sunlight into the camera, while the ground remains bright because it is still directly illuminated by the Sun. Terrain haze is therefore based on an approximate height-integrated optical path through an exponential atmosphere, not on raw geometric distance through vacuum and not on the dark space-facing sky color.

The current high-altitude approximation samples density along the view ray using representative Rayleigh and aerosol scale heights:

```text
optical_meters = integral(exp(-height / scale_height) ds)
tau = beta_extinction_surface * optical_meters
```

This keeps nadir-looking ground bright from high altitude, while tangent and limb views still accumulate much more atmosphere and form a hazy blue/white transition.

## How To Use

Enable Lighting -> Atmosphere. Horizon haze is always active with Atmosphere; Sky Gradient remains a separate control for the visible sky gradient presentation.

Use `Atmo Visibility (km)` (in the Lighting -> Atmosphere Tweaks subfolder) as meteorological visibility in kilometers:

- `5 km`: heavy haze or light fog
- `10-20 km`: hazy urban/lowland air
- `50 km`: clear but visibly atmospheric long-distance view
- `100+ km`: very clear air, weak aerial perspective

The skyline and startup-hills tests are useful checks because distant geometry crosses directly in front of sky:

- `https://local.metabunk.org/sitrec/?custom=99999999/Atmos%20vis%20test/20260521_210921.js`
- `https://local.metabunk.org/sitrec/?custom=99999999/startup%20hills%20fog/20260521_222513.js`

## Limits

This is an analytic first step, not a full multiple-scattering atmosphere:

- Rayleigh and Mie scattering are approximated by the existing sky-gradient color model.
- Extinction is currently wavelength-neutral in the aerial-perspective composite.
- Rayleigh/aerosol density integration is a compact screen-space approximation, not a full spectral multiple-scattering solution.
- Clouds, humidity layers, and weather-specific visibility profiles are not yet modeled.
- Transparent objects and overlays may not participate exactly like opaque terrain/buildings.

## Weather Roadmap

Future weather integration should feed the atmosphere model rather than adding separate visual hacks.

Useful inputs:

- surface visibility or meteorological optical range
- aerosol optical depth
- relative humidity
- cloud base and cloud cover
- precipitation/fog reports
- observer altitude and target altitude
- boundary-layer height or aerosol scale height

The next physically better step is to replace simple `beta * distance` with height-aware optical depth:

```text
tau = integral(beta_extinction(h) ds)
beta_extinction(h) = beta_surface * exp(-h / aerosol_scale_height)
T = exp(-tau)
```

That matters for aircraft from ground level to 50,000 ft and for long slanted satellite views, where much of the ray may pass above dense near-surface aerosols.

Longer-term, Sitrec could adopt a sky-view LUT plus aerial-perspective LUT similar to modern engine implementations, while preserving the same input contract: weather and visibility describe extinction/scattering, and both sky and scene haze consume the same model.
