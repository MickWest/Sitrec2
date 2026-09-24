# Atmospheric Aerial Perspective

Sitrec's look-view atmosphere applies aerial perspective (distance haze) whenever Atmosphere and its **Distance haze** option are both enabled. The goal is that distant terrain, buildings, and the sky behind them are derived from the same line-of-sight atmosphere model rather than from separate, hand-matched colors.

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

That is why a distant hill should fade toward the sky color at the horizon behind it, not toward a single global fog color.

Sitrec currently uses Koschmieder visibility to map the Atmo Visibility control to extinction:

```text
beta_extinction = 3.912 / visibility_meters
T = exp(-beta_extinction * ray_distance_meters)
```

The constant 3.912 corresponds to 2% contrast at the meteorological optical range. This makes the Atmo Visibility value a physical input rather than an arbitrary artistic slider.

Here `beta_extinction` is the value for sea-level air. The renderer scales it by air density along the ray (see below), so the simple distance form above is exact only for a horizontal ray near sea level.

## Current Implementation

The look view renders the sky with a horizon-to-zenith gradient (the **Sky Gradient** option). Distance haze is not a separate pass: it is applied per pixel inside the shader of each material in the scene — terrain, 3D tiles, buildings, the sea and 3D models — as the pixel is drawn:

```text
pixel_out = pixel_in * T + airlight * (1 - T)
```

`airlight` is the horizon color of the sky model for that view direction: the cool horizon color, blended toward the warm color on the side facing the Sun. Because the haze is computed in each material's own shader, it stays aligned with transparency, shader-deformed geometry, HDR highlights and the camera projection actually used (including fisheye and orthographic views). Planar water reflections integrate only their own water-to-object leg.

Haze is applied only when it is needed:

- view is `lookView`
- Atmosphere is enabled
- Distance haze is enabled
- IR mode is off
- XR mode is off

When haze is off, materials render with their original shaders and no extra work is done.

### Height-aware optical depth

The transmittance is not `exp(-beta * distance)`. Each pixel integrates the air density along its own view ray, from the camera to the surface, clipped to an atmosphere that ends at 100 km:

```text
density(h) = 0.55 * exp(-h / 8000 m) + 0.45 * exp(-h / 1500 m)
optical_meters = integral(density(h) ds)
tau = beta_extinction * optical_meters
T = exp(-tau)
```

The two scale heights represent the molecular (Rayleigh) air and the lower aerosol layer. Density fades to zero between 75 and 100 km. The integral uses 12 samples, spaced more closely at the dense (low) end of the ray, so an orbital camera does not waste samples in vacuum.

This keeps nadir-looking ground bright from high altitude, because little air is along the path, while nearly horizontal sightlines through low-altitude air, and limb views, accumulate much more and form a hazy blue/white transition. The sky itself can become dark at high altitude while the ground stays bright, because the terrain haze depends on the finite path to the surface, not on the dark space-facing sky color.

## How To Use

Enable Lighting -> Atmosphere. It is on by default for new custom sitches on desktop, and off on mobile devices. The Lighting -> Atmosphere Tweaks subfolder has two independent options, both on by default:

- `Distance haze`: fade distant surfaces into the atmosphere. Turn it off to keep only the sky gradient.
- `Sky Gradient`: the visible sky fading from zenith blue to horizon haze.

Use `Atmo Visibility (km)` (in the same subfolder, 1-500 km, default 250 km) as meteorological visibility in kilometers. Approximate guide:

- `5 km`: heavy haze or mist (fog is below 1 km)
- `10-20 km`: hazy urban/lowland air
- `50 km`: clear but visibly atmospheric long-distance view
- `100+ km`: very clear air, weak aerial perspective

A useful check is a low camera looking across distant hills or a city skyline, where distant geometry crosses directly in front of the sky: as you lower the visibility, the far ridges should fade into the sky color behind them.

## Limits

This is an analytic first step, not a full multiple-scattering atmosphere:

- Rayleigh and Mie scattering are approximated by the existing sky-gradient color model.
- Extinction is currently wavelength-neutral in the aerial-perspective composite.
- Rayleigh/aerosol density integration uses two fixed scale heights and 12 samples per pixel, not a full spectral multiple-scattering solution.
- Clouds, humidity layers, and weather-specific visibility profiles are not yet modeled.
- Additive-blended materials are only dimmed by the haze, and receive no airlight.
- Scene lines (tracks, line-of-sight lines) and overlays drawn without depth testing are not hazed.
