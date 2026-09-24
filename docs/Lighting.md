# The Lighting Menu

**Lighting**

The Lighting menu controls how the 3D scene is lit and how the look view turns that light into
a picture. It holds the sun and ambient light, shadows, the sky and distance haze, the look
view's exposure, and a set of optional sky and ground effects: halos, the Brocken spectre, city
lights and eclipses.

The Sun's position is not set here. Sitrec calculates it from the sitch's date, time and camera
location, so the lighting follows the **Time** menu. The controls in this menu set how *strong*
the light is, not where it comes from.

This page lists every control. The defaults given are those of a new custom sitch, the usual
starting point. A built-in sitch can start with different values.

- [Sun, ambient light and exposure](#sun-ambient-light-and-exposure)
- [Shadows](#shadows)
- [Atmosphere](#atmosphere)
- [Look View Output](#look-view-output)
- [Atmospheric Optics (Halos)](#atmospheric-optics-halos)
- [City Lights](#city-lights)
- [Eclipses](#eclipses)
- [Tips](#tips)

---

## How the scene is lit

Three lights illuminate the 3D scene:

- **Direct sunlight.** A light from the Sun's direction. It dims as the Sun nears the horizon
  and is gone once the Sun is more than half a degree below the horizon.
- **Scattered sunlight.** Light from the sky. It is added to the ambient light, in proportion
  to the Sun's intensity, and fades out as the Sun goes down, reaching zero when the Sun is
  about 10° below the horizon.
- **Ambient light.** A fixed amount of light from all directions. It does not change with the
  time of day.

So in daylight all three contribute. At night only the ambient light is left. That is the most
important fact for a night scene: **at night, Ambient Intensity alone sets how bright the
ground is.**

---

## Sun, ambient light and exposure

**Lighting → (top level)**

| Control | Default | What it does |
|---|---|---|
| **Lighting Preset** | Default | Applies a set of illumination and shadow values. **Default** restores the values the sitch started with. **Shadows** sets strong direct sun, low ambient light, no scattering, and turns Shadows on. The menu shows **Custom** when you change any of the values that a preset sets. Atmosphere and exposure are not part of a preset |
| **Ambient Intensity** | 0.3 | The fixed light from all directions. 0 is none, 1 is normal, 2 is double. At night this is the only light on the ground |
| **IR Ambient Intensity** | 0.8 | The ambient light used instead of Ambient Intensity when a view renders in IR mode |
| **Sun Intensity** | 0.55 | The strength of direct sunlight. 0 is none, 1 is normal full sunlight, 2 is double |
| **Sun Scattering** | 0.45 | How much scattered skylight is added to the ambient light, as a fraction of Sun Intensity. It fades out as the Sun sets |
| **Sun Boost (HDR)** | 1 | Multiplies the direct sunlight only (1 to 100). Use it for bright specular highlights, such as sun reflections on water or metal. Lower Scene Exposure to compensate |
| **Scene Exposure** | 1 | A brightness multiplier for the look view (0.01 to 2). It does not change the main view. It combines with **Look Exposure** in [Look View Output](#look-view-output) |
| **Ambient Only** | Off | Turns off direct and scattered sunlight, and keeps only the ambient light |
| **Daylight Sky** | On | Draws the daylight (blue) sky. Turn it off to remove the daylight sky, for example to see the stars in daytime or to examine night-sky objects |
| **No Lighting in Main View** | Off | Lights the main view with flat, even ambient light and no sun. This is for inspecting geometry. It also removes eclipse dimming from the main view. It is not recommended for normal use |
| **No City Lights on Globe** | On | Hides the night-lights image (a world map of city lights) on the night side of the Earth globe. This is different from the [City Lights](#city-lights) folder, which draws on 3D building tiles |
| **Shadows** | Off | The master shadow switch. See [Shadows](#shadows) |

The **Shadows** preset sets Ambient Intensity 0.07, IR Ambient Intensity 0.8, Sun Intensity
1.02, Sun Scattering 0, Sun Boost 1, and Shadows on. With so little ambient light, the shaded
sides of objects become dark and cast shadows are easy to see.

---

## Shadows

**Lighting → Shadows** and **Lighting → Shadow tweaks**

Shadows are off by default. **Shadows** is the master switch: when it is off, no view draws
shadows. When it is on, each 3D view draws shadows only if its own switch in **Shadow tweaks**
is also on. 3D objects, synthetic buildings, 3D building tiles and terrain can cast shadows.

The quickest way to get good shadows is **Lighting Preset → Shadows**.

| Control (in Shadow tweaks) | Default | What it does |
|---|---|---|
| **Shadows in Main View** | On | Draw shadows in the main view when the master switch is on |
| **Shadows in Look View** | On | Draw shadows in the look view when the master switch is on |
| **Terrain receives shadows** | On | Let cast shadows darken the terrain. It adds a shadow calculation for every terrain pixel |
| **Shadow map size** | 2048 | The resolution of the shadow depth texture: 1024, 2048 or 4096. Larger values give sharper shadows and use more GPU memory |
| **Shadow min radius (m)** | 300 | The smallest area, as a half-width in metres, that the shadow calculation covers. Normally the area fits what the view can see. This value is a floor, so a tight close-up view still gets a useful patch of shadow |
| **Shadow bias** | −0.0005 | A depth offset. It prevents "shadow acne" (speckled self-shadowing). If it is too negative, shadows separate from the objects that cast them |
| **Shadow normal bias** | 1 | An offset along the surface normal, in world units, for the same purpose |
| **Shadow update interval (ms)** | 50 | The minimum time between shadow updates. Lower is smoother and uses more GPU time |
| **Shadow update angle (°)** | 0.25 | How far the Sun must move before the shadows are calculated again |

On a phone or tablet, two more switches appear at the top level: **Allow Main View shadows on
mobile** and **Allow Look View shadows on mobile**. Shadows stay off on a mobile device unless
you turn these on.

The defaults suit most scenes.

---

## Atmosphere

**Lighting → Atmosphere** and **Lighting → Atmosphere Tweaks**

**Atmosphere** draws a sky gradient and distance haze in the look view. It is on by default for
a new custom sitch on a desktop computer, and off on a mobile device.

| Control (in Atmosphere Tweaks) | Default | What it does |
|---|---|---|
| **Distance haze** | On | Fades distant surfaces into the color of the air. Turn it off to keep only the sky gradient |
| **Atmo Visibility (km)** | 250 | The meteorological visibility, from 1 to 500 km. Smaller values give thicker haze |
| **Sky Gradient** | On | The sky fades from blue at the zenith to haze at the horizon |

The haze model, and what the visibility numbers mean in practice, are described in
[Atmospheric Aerial Perspective](AtmosphericAerialPerspective.md).

---

## Look View Output

**Lighting → Look View Output**

These controls act on the finished look-view image, the view that you compare with a video or
photo. They do not change the main view, and they do not apply to a look view in IR mode.

| Control | Default | What it does |
|---|---|---|
| **Highlight Rolloff** | On (desktop) | Filmic tone mapping. Bright areas roll off smoothly instead of clipping to flat white. It works with or without the atmosphere. It follows the Atmosphere default, so it is off on a mobile device |
| **Look Exposure** | 1 | A brightness multiplier for the look view (0.1 to 5). The total look-view exposure is **Scene Exposure × Look Exposure** |
| **Optics Before Sensor Effects** | On | Applies focus blur and diffraction glare before highlight rolloff, noise, levels and the other sensor effects, which is the order a real camera applies them. Turn it off for the older order |

Sitches saved by earlier versions stored these settings as **Atmo HDR** and **Atmo Exposure**.
They load as **Highlight Rolloff** and **Look Exposure**, converted so that the saved look is
kept.

---

## Atmospheric Optics (Halos)

**Lighting → Atmospheric Optics (Halos)**

Ice-crystal halos and arcs, drawn on the sky around the Sun by day and around the Moon at night.
**Show Halos** is off by default. Each optic is drawn only when the Sun (or Moon) is at an
elevation where it can form.

| Control | Default | What it does |
|---|---|---|
| **Show Halos** | Off | Master switch for all the halos and arcs below. Sun Glare and the Brocken spectre are separate |
| **Intensity** | 1 | Overall brightness of the halos, arcs and sun dogs (0 to 3) |
| **22° Halo** | On | The common ring 22° from the Sun. Reddish inside, bluish-white outside |
| **Sun Dogs (Parhelia)** | On | Bright spots on each side of the Sun at the same altitude, just outside the 22° halo |
| **Circumzenithal Arc** | On | An "upside-down rainbow" around the zenith. It forms only when the Sun is below about 32° |
| **Circumhorizontal Arc** | On | A colored band parallel to the horizon. It forms only when the Sun is above about 58° |
| **Parhelic Circle** | Off | A white circle parallel to the horizon, through the Sun |
| **46° Halo** | Off | A larger, fainter ring 46° from the Sun |
| **Sun Pillar** | Off | A vertical shaft of light through the Sun |
| **Tangent Arcs / Circumscribed** | Off | Arcs touching the 22° halo. Their shape changes with the Sun's elevation, from a narrow "V" at low Sun to the circumscribed halo |
| **Parry Arc** | Off | An approximate arc just above the upper tangent arc, from rare well-aligned crystals |
| **Sun Glare** | On | A soft glow of scattered light around the Sun. It works independently of Show Halos, and fades out during a solar eclipse |
| **Moon Halo (22°)** | Off | A faint 22° halo around the Moon, on the night sky |
| **Moon Dogs (Paraselenae)** | Off | Faint spots 22° on each side of the Moon |

### Brocken Spectre

**Lighting → Atmospheric Optics (Halos) → Brocken Spectre**

A Brocken spectre is the observer's own shadow cast on fog or cloud below, surrounded by colored
rings (the *glory*). It appears opposite the Sun. Sitrec draws it in the look view only, at a
real distance, so nearer terrain hides it correctly. It needs the Sun above the horizon.

| Control | Default | What it does |
|---|---|---|
| **Show Brocken Spectre** | Off | Master switch |
| **Glory (rings)** | On | The colored diffraction rings around the shadow of the observer's head |
| **Shadow Figure** | On | The observer's magnified shadow at the center |
| **Fog Bank** | On | A soft synthetic patch of fog for the spectre to fall on. Turn it off if the scene already has fog or cloud below |
| **Fog Brightness** | 0.6 | How bright the synthetic fog patch is |
| **Fog Distance (m)** | 350 | The slant distance to the fog (50 to 5,000 m). It sets how large the spectre looks and which terrain hides it |
| **Spectre Size°** | 5 | The angular size of the shadow figure (1° to 15°) |
| **Droplet Size (µm)** | 10 | The fog droplet diameter (3 to 40 µm). Smaller droplets make a larger glory. About 10 µm is typical of hill fog |

---

## City Lights

**Lighting → City Lights**

City Lights adds night-time lights to **3D building tiles**: street lights along roads and lit
windows on buildings. It is off by default.

**The lights are synthetic.** Sitrec does not have data on where real lamps are, or which windows
are lit. It makes a plausible pattern of lights from map data and from the shape of the tiles.
The same view always gets the same pattern, but no individual light corresponds to a real one.
Use City Lights to judge the general look of a lit area at night: where the roads and built-up
areas are, and roughly how bright they are. Do not use it to identify a specific light in a
photo or video.

City lights draw only on 3D building tiles, so turn on **3D Buildings** in the Terrain menu
first (see [Terrain](Terrain.md)). Without the tiles, **Status** shows *Requires 3D map tiles*.
The lights fade in as the Sun sets. They start at about 2° Sun elevation and reach full
strength when the Sun is about 5° below the horizon.

| Control | Default | What it does |
|---|---|---|
| **Show City Lights** | Off | Master switch |
| **Method** | Mapped Roads and Buildings | How the light positions are chosen. See below |
| **Road Lights (%)** | 60 | The percentage of candidate street-light positions that are lit, on roads. 0 turns road lights off |
| **Paths / Parking (%)** | 8 | The same, for service roads, pedestrian ways, footways and cycleways |
| **Lit Windows (%)** | 35 | The percentage of windows that are lit |
| **Light Intensity** | 1 | The brightness of the lights (0 to 3) |
| **Ground Brightness** | 0.22 | At night, the tile surface itself is darkened to this fraction of its daytime color, so that the lights stand out (0 to 1) |
| **Reload Lights** | | Loads the map data again. Use it if loading failed |
| **Status** | | Shows what the feature is doing: *Off*, *Loading city lights…*, *Ready*, or an error |

A higher percentage adds lights at new positions and keeps the existing ones where they are.

### Methods

| Method | Data used | What it draws |
|---|---|---|
| **Mapped Roads and Buildings** (default) | Roads and building outlines from Overture Maps | Street lights along the mapped roads, and lit windows on the walls of mapped buildings |
| **Geometry Windows** | None: only the tile geometry | Lit windows on any wall-like surface of the tiles. No street lights |
| **Texture Regularity** | None: only the tile photo texture | Lights where the tile's image shows strong, regular edges in areas that are not green (not vegetation). No window pattern |
| **Hybrid** | Overture Maps, plus the tile geometry | Mapped Roads and Buildings, plus faint windows on the other walls of the tiles |

**Road Lights** and **Paths / Parking** appear only for the two methods that use map data.
**Lit Windows** is hidden for Texture Regularity.

### Where the map data comes from

The two map-based methods download road and building data from
[Overture Maps](https://docs.overturemaps.org/attribution/), which includes
[OpenStreetMap](https://www.openstreetmap.org/copyright) data. When one of these methods is in
use, this credit appears with the other map attributions while City Lights is on. The data is loaded in the background
the first time the lights are needed. Status shows the progress.

How the data becomes lights:

- **Street lights** are placed along each road at a regular spacing: about 42 m on major roads,
  38 m on other roads and 48 m on paths and service roads. They alternate between the two sides
  of the road. The percentage controls choose which of these positions are lit. Each road has
  one lamp color, either a warm orange or a cool white.
- **Windows** are a regular grid on building walls, spaced about 3 m apart across and 3.5 m
  apart vertically. The grid follows the direction of each mapped building. The Lit Windows percentage chooses which
  windows are lit.
- Roads in tunnels, indoor roads, roads under construction and underground buildings are left
  out.

### Limits

- **The lights are not real lights.** Positions, spacing, colors and lit windows are made up.
  Real street lighting varies a lot from place to place.
- **The coverage is limited.** Sitrec loads the map data for one square area around the point
  where each view looks at the ground: 8 to 32 km across, larger when the camera is higher. It
  loads a new area when the view moves near the edge. There are no lights beyond that area.
- Map data for roads and buildings is only as complete as Overture Maps is for that place.
- Lights are drawn on the tile surface. They do not light the surroundings or cast light onto
  other objects.
- City lights need a network connection to Overture Maps for the map-based methods.

---

## Eclipses

**Lighting → Solar Eclipse** and **Lighting → Lunar Eclipse**

Both folders do nothing unless an eclipse is actually in progress at the sitch time and place.

**Solar Eclipse** draws the Moon's silhouette on the Sun and the effects near totality:

| Control | Default | What it does |
|---|---|---|
| **Eclipse Effects** | On | Master switch for the eclipse visuals |
| **Intensity** | 1 | Brightness of the corona, prominences and the bead and diamond-ring glare |
| **Corona** | On | The white corona and streamers, seen when the Sun is almost fully covered |
| **Prominences** | On | Pink-red loops on the Sun's edge during totality |
| **Baily's Beads / Diamond Ring** | On | The last sunlight through lunar valleys at second and third contact |
| **Affect Lighting** | On | Dims the scene lighting and the sky during the eclipse, down to deep twilight with a glow around the horizon at totality |

**Lunar Eclipse** shades the Moon with the Earth's shadow. Its controls, and why an eclipsed
Moon turns red, are described in [Lunar Eclipses](LunarEclipse.md).

---

## Tips

### The night scene looks too bright

At night only the ambient light is left, and a custom sitch starts with **Ambient Intensity**
0.3. That is much brighter than a real night. For a realistic night,
lower **Ambient Intensity** toward 0. Then make sure the Sun really is below the horizon at
the sitch time: scattered sunlight lasts until the Sun is about 10° below the horizon.

### The night scene looks too dark

- Raise **Ambient Intensity** to see the ground. This is not physically accurate, but it lets
  you check the terrain and objects.
- To brighten only the look view, raise **Scene Exposure** or **Look Exposure** instead.
- For light sources on the ground, turn on 3D Buildings and [City Lights](#city-lights).
- To see stars, check the look view is not showing the daylight sky: turn off **Daylight Sky**
  if you need stars in twilight.

### Match the video's exposure

Set up the look view to match the video, then:

1. Use **Scene Exposure** and **Look Exposure** to match the overall brightness of the video.
   They change only the look view. The main view stays readable.
2. If the sky or bright surfaces clip to flat white in the look view but not in the video, keep
   **Highlight Rolloff** on. If the video's highlights clip hard, try it off.
3. If distant terrain is too sharp or too clear compared with the video, lower **Atmo
   Visibility (km)** in **Atmosphere Tweaks**. See
   [Atmospheric Aerial Perspective](AtmosphericAerialPerspective.md).
4. If the contrast between the sunlit and shaded sides of objects is wrong, change **Sun
   Intensity** and **Ambient Intensity**. A hazy or overcast day has more ambient light and
   less direct sun.

### Sharp shadows for a close-up

Choose **Lighting Preset → Shadows**. If the shadow edges are blocky, increase **Shadow map
size** in Shadow tweaks.

---

## See also

- [Atmospheric Aerial Perspective](AtmosphericAerialPerspective.md): the distance haze model
- [Lunar Eclipses](LunarEclipse.md): the Lunar Eclipse folder
- [Terrain](Terrain.md): 3D Buildings, which City Lights needs
- [Diffraction Glare](DiffractionGlare.md): glare from bright point sources, which Optics Before Sensor Effects orders
- [Long Exposure Simulation](LongExposure.md)
- [User Interface](UserInterface.md)
