# Atmospheric Aerial Perspective

Distant hills and buildings look paler because of the air between them and the camera. This is aerial perspective, or distance haze. Sitrec draws it in the look view when Atmosphere and its **Distance haze** option are both on. Distant terrain and buildings fade to the same horizon color that the sky gradient uses, so they do not need a separate fog color. The amount of fade comes from a calculation of the air along each view ray.

## How To Use

Enable Lighting → Atmosphere. It is on by default for new custom sitches on desktop, and off on mobile devices. The Lighting → Atmosphere Tweaks subfolder has two independent options, both on by default:

- `Distance haze`: fade distant surfaces into the atmosphere. Turn it off to keep only the sky gradient.
- `Sky Gradient`: the visible sky fading from zenith blue to horizon haze. It needs Lighting → Daylight Sky on, and daylight.

With Daylight Sky off, or at night, Sitrec draws no sky gradient, and Distance haze fades surfaces to a dim gray.

Use `Atmo Visibility (km)` (in the same subfolder, 1-500 km, default 250 km) to set the haze. It is the range where a dark target keeps 2% contrast in uniform sea-level air. Smaller values give thicker haze. Approximate guide:

- `5 km`: heavy haze or mist. Fog means a surface visibility below 1 km. The 1 km minimum of this control is about 0.77 km [meteorological optical range](#physical-basis), so it cannot reach thicker fog.
- `10-20 km`: hazy urban/lowland air
- `50 km`: clear but visibly atmospheric long-distance view
- `100+ km`: very clear air, weak aerial perspective. The default of 250 km is in this range.

Airport weather reports give a surface visibility for a given date. Their top value is about 10 km or 10 miles, and it means that distance or more. For a reported meteorological optical range, see [Physical Basis](#physical-basis).

A useful check is a low camera looking across distant hills or a city skyline, where distant geometry crosses directly in front of the sky: as you lower the visibility, the far ridges should fade into the sky color behind them. In daylight with Sky Gradient on, this match holds in the pale band at the horizon. That band is about 1 degree high at 50 km visibility and above, and about 3 degrees high at 5 km. A higher peak fades to the horizon color, which is paler than the sky behind it.

![Four strips of the same mountain view, stacked. In each, a floating Atmosphere Tweaks panel shows Distance haze, Atmo Visibility (km) and Sky Gradient. At Atmo Visibility 250 the ridges are sharp under a blue sky. At 50 the far ridges are pale. At 20 only the nearer ridges show, and the far ridges merge into the pale band at the horizon. With Distance haze unticked at 20, the ridges are dark and sharp under the same sky as the strip above](docimages/atmospheric-aerial-perspective-visibility.jpg)

The same look view four times, from a camera just above mountain ridges. In the top three strips, **Atmo Visibility (km)** is 250 (the default), 50 and 20. Far ridges fade first. At 20 the far ridges have the same color as the pale band behind them, so they cannot be seen. In the bottom strip, **Distance haze** is off and Atmo Visibility stays at 20. The sky is the same as in the strip above, and the ridges keep their full contrast. The panel in each strip is the **Atmosphere Tweaks** folder, dragged out of the Lighting menu.

## Limits

This is an analytic model, not a full multiple-scattering atmosphere:

- There is no calculation of Rayleigh (molecular) or Mie (aerosol) scattering. Sky and haze colors are fixed color blends set by Sun elevation, camera altitude and Atmo Visibility.
- Extinction is wavelength-neutral: the haze dims all colors equally.
- The air density profile is fixed, with two scale heights and 12 samples per pixel. It does not change for clouds, humidity layers or weather.
- Additive-blended materials are only dimmed by the haze, and receive no haze color.
- Scene lines (tracks, line-of-sight lines) and overlays drawn without depth testing are not hazed.
- The Sun, the Moon and stars are drawn in separate sky scenes and are not hazed. A Photo Backdrop is not hazed, because the picture already contains the real haze.

## Physical Basis

The model follows the standard participating-media form:

```text
pixel = surface_radiance * T(camera -> surface) + L_air(camera -> surface)
```

`T` is transmittance through the air mass along the view ray. `L_air` is path radiance added by scattering along that same ray. As `T` approaches 0, a surface pixel converges to the horizon color of the sky. Sitrec integrates `T` along the ray. It does not integrate the color.

An empty sky pixel has no surface hit and no ray integral. The sky gradient blends a zenith color and the horizon color by the elevation of the ray. Haze and sky share the horizon color, so a distant hill near the horizon fades toward the sky behind it.

Sitrec uses Koschmieder visibility to map the Atmo Visibility control to extinction. In uniform air:

```text
beta_extinction = 3.912 / visibility_meters
T = exp(-beta_extinction * ray_distance_meters)
```

The constant 3.912 is -ln(0.02): the range at which a dark target keeps 2% contrast (the Koschmieder visual range). The World Meteorological Organization defines meteorological optical range with a 5% threshold, so that range is about 0.77 of the Atmo Visibility value for the same air. To enter a meteorological optical range, multiply it by about 1.3.

This sets extinction from a physical quantity. Atmo Visibility also changes colors through fixed blends: the haze loses saturation as visibility falls from 100 km to 5 km, and below 50 km the zenith gets bluer and the pale horizon band gets wider.

Here `beta_extinction` is the value for sea-level air. The renderer scales it by air density along the ray (see below), so the simple distance form above is exact only for a horizontal ray near sea level.

## Current Implementation

The look view renders the sky with a horizon-to-zenith gradient (the **Sky Gradient** option). Distance haze is not a separate pass: it is applied per pixel inside the shader of each material in the scene — terrain, 3D tiles, buildings, the sea and 3D models — as the pixel is drawn:

```text
pixel_out = pixel_in * T + airlight * (1 - T)
```

`airlight` is the horizon color of the sky model: the cool horizon color. With the Sun between 8 degrees below and 12 degrees above the horizon, or in a deep solar eclipse, it blends toward a warm color on the side facing the Sun. Otherwise one haze color applies to the whole frame. Because the haze is computed in each material's own shader, it stays aligned with transparency, shader-deformed geometry, HDR highlights and the camera projection actually used (including fisheye and orthographic views). Planar water reflections integrate only their own water-to-object leg.

Haze is applied only when it is needed:

- the view is the look view
- Atmosphere is enabled
- Distance haze is enabled
- no FLIR effect is enabled on the look view
- XR mode is off

When haze is off, pixels are unchanged.

### Height-aware optical depth

Air thins with height, so Sitrec does not use the simple distance form. Each pixel integrates the air density along its own view ray, from the camera to the surface, clipped to an atmosphere that ends at 100 km:

```text
density(h) = 0.55 * exp(-h / 8000 m) + 0.45 * exp(-h / 1500 m)
optical_meters = integral(density(h) ds)
tau = beta_extinction * optical_meters
T = exp(-tau)
```

The two scale heights represent the molecular (Rayleigh) air and the lower aerosol layer. Density fades to zero between 75 and 100 km. The integral uses 12 samples, spaced more closely at the dense (low) end of the ray, so an orbital camera does not waste samples in vacuum.

This keeps nadir-looking ground bright from high altitude, because little air is along the path. Looking straight down from orbit, `T` is about 0.92 at the default visibility and about 0.37 at 20 km. So the ground can stay bright at high altitude while the sky goes dark. Nearly horizontal sightlines through low-altitude air accumulate much more, and fade further toward the haze color.
