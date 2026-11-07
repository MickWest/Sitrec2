# Celestial Display

Open **Show → Celestial** to control the sky display. These settings use the current sitch time and each view's camera position. A checkbox on a folder title controls that folder's main feature; expand the folder for its settings.

Grids, constellation lines and names, vectors, and the horizon compass have two boxes: **M** for Main and **L** for Look. The faint letters appear inside unchecked boxes; checked boxes show a checkmark. Each box is independent, and you can drag across boxes to set several at once. The equatorial grid follows right ascension and declination. The azimuthal grid marks azimuth and elevation relative to each camera's local north and level horizon. **Grid Spacing** applies to both grids: default 10°, range 5–45°, in 5° steps. Both grids fade near their poles, from full strength at 100 display pixels to invisible within 10 pixels, to avoid a bright cluster of converging lines.

| Folder | Controls |
|---|---|
| **Stars and Planets** | **Render Stars and Planets** shows or hides stars, planets, the Sun and Moon, and their enabled name labels. Adjust star/planet brightness, the star magnitude limit, linked brightness, or Physical Point Sources. Constellation lines and scene lighting have separate controls. |
| **Lines** | Constellation lines and both grids have independent Main/Look checkboxes. Choose the asterism style, grid spacing and shared line width (default 0.25 pixels, in steps of 0.01). |
| **Labels** | Constellation names have their own Main/Look boxes; **Star/Planet Names** and **Planets Only** also have per-view boxes; **Name Filter** selects object names. |
| **Horizon Compass** | Main/Look visibility on the folder title, **Cardinal Directions** and **Headings (Degrees)** label switches, opacity and text size. Label switches leave the ruler and ticks visible. True bearings follow the sea-level horizon, including its dip at altitude. Numbers stay upright and ticks stay vertical; numbers normally appear every 10 degrees. Hills can rise above the ribbon. |
| **Vectors** | Direction arrows to the Sun, Moon and all modeled planets, including Pluto. Each arrow has Main/Look boxes. The folder's Main/Look master switches hide the selected arrows without changing individual choices. Choose whether arrows start at the camera or traverse object. These choices are saved. |
| **Shadows** | The Earth's shadow in space and the Moon's shadow on Earth, with altitude, penumbra, center and eclipse-path controls. |
| **Eclipses** | **Solar Eclipse** visuals and lighting effects; **Lunar Eclipse** shading, color, exposure and shadow outlines. They take effect only during the corresponding eclipse. |
| **Atmospheric Optics (Halos)** | Sun and Moon halos, arcs, sun dogs, glare and the Brocken spectre. Sun Glare remains independent of the Show Halos switch. |
| **Extra Celestial Views** | Show/hide **Satellite Ephemeris** and **Sky Plot** after loading satellites. **Star Chart** has its own visibility checkbox, color scheme, star magnitude limit and satellite-track switch. |

**Magnitude and brightness are different.** A larger magnitude limit includes fainter stars. Star Brightness changes the size/visibility of the dots already included. The Star Chart has an independent magnitude limit. Physical Point Sources is intended for use with diffraction optics; see [Diffraction Glare](DiffractionGlare.md).

**Labels are independent of constellation lines.** Turn on the appropriate label checkbox first. **Name Filter** accepts comma-separated name prefixes, such as `Moon, Polaris`. It filters enabled star, planet and satellite labels, not constellation names. Empty means no filtering. **Planets Only** is available when the corresponding Star/Planet Names switch is on.

For a clean sky comparison, set the location and camera direction, then set the UTC time. Enable Stars and Planets, choose the star limit, and add constellation lines or the compass as needed. Save the sitch to retain the settings.

Related controls keep their own menus:

- **Time** sets the date, local time zone and playback.
- **Camera** sets position, heading, celestial tracking, zoom and lens projection.
- **Satellites** loads orbital data and controls satellite categories, magnitude limit, brightness, names and flare analysis.
- **Lighting** sets illumination, daylight atmosphere, haze, exposure and terrain/object shadows.
- **View → Atmospheric Refraction** shares atmosphere settings between sky and terrain.
- **Video → Star Tracker** analyzes stars in imported footage. Its markers are analysis overlays.

See [Satellites](Satellites.md) for the extra views, [Lighting](Lighting.md) for atmospheric optics and solar eclipses, and [Lunar Eclipses](LunarEclipse.md) for lunar shading.
