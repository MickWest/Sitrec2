# Wind in Sitrec

The **Wind** folder in the **Physics** menu sets the wind at the camera platform and at the target, pulls atmospheric data from real-world sources, and draws streamlines and arrows in the main view. **Flight Sim** cameras, **Manual + Wind** targets and traverse methods that work in air speed use this wind.

![Streamlines from a manual wind source](wind-images/streamlines-manual.jpg)

*Animated wind streamlines (green) flowing across the Pacific. The cyan view-frustum and red LOS belong to the camera tracking a target offshore.*

> **Just here for the controls?** Jump to [GUI reference](#gui-reference). For data-flow internals see [Wind: data flow, formats, and sources](Wind-Internals.md).

## Quickstart

1. Set the sitch date, time and camera position first. Sitrec fetches wind for that date, and soundings near that position.
2. Open the **Physics** menu in the top menubar, then expand the **Wind** folder.
3. From **Wind Source**, pick **GFS (NOAA)** for any date from 22 March 2021 to today, or **UWYO Soundings** / **IGRA2 Soundings** for earlier dates.
4. Set **Altitude** to the height where you want to see the wind. It sets the level of the streamlines and arrows. Target Wind and Local Wind do not use this slider: they read the source on every frame, at the position and height of the target and the camera.
5. **Show Wind Lines** is auto-toggled on the first time you pick one of the sources in step 3 — the streamlines appear once the data has loaded (allow up to a minute the first time; after that it's cached). [**Status**](#status) then says where the wind comes from, for example `GFS 2023-06-15 18Z, 1° grid. Heights 33 ft above the ground to 101,000 ft.`
6. To read the wind at the target or the camera, use [**Show Wind at**](#show-wind-at). The first change that you make to the wind in a sitch turns it on, if it was never on in that sitch. **Target Wind From** and **Target Wind Speed** show the same value at the target.

That's the common path. The rest of this doc fills in everything around it.

## Glossary

A few terms used throughout. If you've used Sitrec before some of these will be obvious; defining them up front saves having to guess.

- A **sitch** (short for *situation*) is one Sitrec scene: a place, a span of time, and the camera, tracks, objects and video that recreate an event. You can save and share a sitch, but it is a sitch before you save it.
- **target** — the object the user is tracking (a UFO, an aircraft, a satellite).
- **camera platform / local** — the observer's vantage point (the jet, ship, balloon, or fixed station the camera lives on).
- **From** — meteorological convention. "Wind from 270°" means the wind is *blowing from the west*. Sitrec follows this everywhere.
- **wind field** — a global 2D grid of wind vectors, sampled by the streamlines and the arrow overlay.
- **sounding** — one profile of wind, temperature and pressure against height, measured by a radiosonde, the instrument that a weather balloon carries.
- **MISB track** — a track file containing per-frame metadata in the MISB ST 0601 standard, optionally including wind direction and wind speed (tags 35 and 36).
- **IDW** — inverse-distance weighting; how Sitrec turns scattered sounding samples into a continuous grid.

## Concepts

Sitrec keeps two kinds of wind state side by side:

- **Target Wind** — the wind acting on the *target* (the thing you are tracking). Used by traverse methods that compute target motion through the air (e.g. **Constant Air Speed**) and by **Manual + Wind** targets. In [Traverse Analysis and the Verdict](TraverseAnalysis.md#analysis-integrity), Target Wind is the **supplied wind**: each wind-dependent fit runs once with it and once with a wind of its own.
- **Local Wind** — the wind acting on the *camera platform* (the jet, ship, balloon you are looking from). Used by the **Flight Sim** camera, which it blows along.

Each has a direction (true degrees, north = 0, blowing **from** that direction) and a speed. The Wind folder shows every wind speed in the speed unit of **Units** (knots, mph or km/h), or in knots when [**Wind in Knots**](#wind-in-knots) is on, and every height in the height unit of **Units** (feet, or metres for **Metric**). By default both come from the same **Wind Source**; [Separate Wind Sources](#separate-wind-sources) can give them different inputs, within limits.

![Target and Local wind concept](wind-images/target-local-concept.svg)

Behind the controls is a third object: the **wind field**, a coarse global 2D grid of wind vectors. This is what the streamlines and arrow overlay sample. Every source fills the wind field.

An **atmospheric source** is any source except **Manual** or a telemetry **Track:** entry. Under any source except **Manual**, Target Wind and Local Wind *read* the source. On every frame, each thing that uses the wind (a traverse, the **Flight Sim** camera, the traverse analysis) gets the wind at its own position, height and time. As the clip plays and the target climbs, the wind it gets changes with it. The sliders then show the value at the target (or the camera) on the current frame, and you cannot change them: to set your own value, turn on **Override Target Wind** or **Override Local Wind**. A telemetry **Track:** entry gives the track's wind at the time of each frame, the same at every position. With **Manual**, you set the wind with the sliders.

![Atmospheric sources fill the wind field, and Target and Local Wind read them on every frame. The wind field feeds streamlines and arrows. A telemetry Track entry gives Target and Local Wind one track row on each frame. With Manual, the Target value fills the wind field.](wind-images/sources-overview.svg)

*Target and Local Wind read an atmospheric source directly on every frame, at the position and height where the wind is used, not through the wind field's grid. With **Manual**, the Target Wind sliders fill the field. A telemetry **Track:** entry gives Target and Local Wind the track's wind at each frame's time, and fills the field from the same track.*

### What the wind data is

**GFS** is a weather-model result on a 1° grid, about 110 km. GFS has one analysis every 6 hours (a cycle). For a time between two cycles, Sitrec blends the two cycles on each side of it, in proportion to the time, and **Status** shows both (for example `2025-09-19 18Z–2025-09-20 00Z, blended in time for 21Z`). A **sounding** is one balloon flight, launched near 00Z or 12Z (00:00 or 12:00 UTC), and the station can be far from your scene. Neither is a measurement at your object, and local effects such as valley or coastal winds can be missing. To see how much a result depends on the wind, run it again with a second source.

## GUI reference

The Wind folder lives under **Physics**. Controls below appear in roughly the order they are shown: Target and Local Wind, **Show Wind at**, the source rows with **Status** under them, **Wind in Knots**, the altitude and line rows, the **Wind Line Style** folder, then the buttons and the sounding rows.

![The Wind GUI panel under Physics](wind-images/wind-gui-panel.jpg)

*The Wind folder in the **Physics** menu, expanded, with a **Manual** wind. The **Show Wind at** folder is open and turned on.*

### Target and Local Wind

The four sliders show Target Wind and Local Wind. What you can do with them depends on the source:

- **Manual**: you set them, and they stay. **Target Wind From** and **Target Wind Speed** also define the wind field; the Local sliders do not change the field. See [Manual source vs. Override](#manual-source-vs-override) below.
- **Any other source**: they are gray and read-only. They show the wind that the source gives at the target (or the camera) on the current frame, so they change as the clip plays, as the target changes height, and when new data loads. The things that use the wind do not read the sliders: each reads the source at its own position, height and time, on every frame.
- **Override Target Wind** / **Override Local Wind** (shown under any source except **Manual**): turn it on to use your own value. The sliders then start at the live value, and you can change them. The same wind is then used at every place, height and time, and no load changes it. Turn it off to follow the source again. Override is saved with the sitch.

| Control | What it does |
|---|---|
| **Target Wind From** | Direction (true degrees) the *target's* wind is blowing **from**. North = 0, east = 90. |
| **Target Wind Speed** | Speed at the target, in the unit in brackets: the speed unit of **Units**, or knots with **Wind in Knots**. The row was **Target Wind Knots**, always in knots, before November 2026. |
| **Override Target Wind** | Use the Target Wind sliders in place of the source. |
| **Local Wind From** | Same as above, for the camera platform. |
| **Local Wind Speed** | Same as above, for the camera platform. |
| **Override Local Wind** | Use the Local Wind sliders in place of the source. |
| **Lock Target Wind to Local** | Makes Target Wind the same as Local Wind: the target gets the Local Wind source (or the Local Wind values, with **Manual** or **Override**), read at the target. It hides the Target sliders until you turn it off. |

> **"Lock Target Wind to Local" vs. "Separate Wind Sources" — they sound similar; they aren't.**
>
> | | Same source | Separate source |
> |---|---|---|
> | Values free | default | turn on **Separate Wind Sources** |
> | Values locked | turn on **Lock Target Wind to Local** | rarely useful (Lock would override Separate) |
>
> "Lock" ties the *numbers* together. "Separate" gives each side its own *source dropdown*, within the limits in [Separate Wind Sources](#separate-wind-sources).

### Show Wind at

A folder of places where Sitrec shows the wind. At each place there is a readout, with the speed, the direction that the wind blows from and the altitude used, and an arrow in the main view that points the way the wind blows. The folder is directly under the Target and Local Wind rows.

The checkbox at the right of the folder title turns all the readouts on or off. It is off in a new sitch, and the rows in the folder are gray while it is off. The first time that you change the wind in a sitch (you pick a source, import a profile, turn on an Override, or set a Target or Local Wind value), Sitrec turns it on and says so in the main view, if it was never on in that sitch. After that it stays as you set it. Each row turns one place on or off:

| Row | Shows the wind at | Default |
|---|---|---|
| **Camera** | The camera, at the altitude of the camera track. | On |
| **Target** | The target, at the altitude of the target track. | On |
| **Mouse Cursor** | The point under the mouse cursor in the main view, at **Altitude**. **Shift-click** adds a point that stays, with a labelled vertical stalk to the surface. **Alt-click** removes the nearest one. The added points show only while Mouse Cursor is on, and they are saved with the sitch. | Off |
| *Each object* | A 3D object, at the altitude of the object. There is one row for each object in the **Objects** menu. The target and camera objects have no row when the **Target** and **Camera** rows already show the wind there. The row follows a rename, and goes when the object is deleted. | Off |

To set several rows at once, press one checkbox and drag over the others.

The **Camera** readout shows Local Wind there and the **Target** readout shows Target Wind there, so they always agree with the sliders, with **Override** and with **Lock Target Wind to Local**. The other readouts show the **Wind Source**. Each readout gives, from the top:

- the speed, in the unit of the Wind folder (see [Wind in Knots](#wind-in-knots));
- **FROM** and the direction that the wind blows from;
- the height used, above mean sea level, and the height above the ground where the ground there is above sea level, in the height unit of **Units** (feet, or metres for **Metric**);
- the source and the time of its data, for example `UWYO 2025-09-19 12Z · 128 km` (the launch of the nearest sounding, and the distance to it), `GFS 2025-09-19 18Z–2025-09-20 00Z` (the two cycles that are blended), **Manual** or **Override**.

A last line tells you when the value is not a plain reading of the data:

| Line | Meaning |
|---|---|
| **above the top of the data (30,000 ft): top value held** | The point is above the highest data of the source; the wind at that height is held. |
| **below the bottom of the data (1,640 ft): lowest value held** | The point is below the lowest data (for GFS, under the 10 m wind); the lowest wind is held. |
| **below the ground** | The point is under the terrain. |
| **loading…** | Data for that height is on its way. |
| **no data** | The source has no wind there. |

The readouts move so that they do not cover each other or an open menu, and a menu is always in front of a readout.

A sitch saved with the older **Inspect Wind** checkbox turned on opens with this folder on, and with **Camera**, **Target** and **Mouse Cursor** on.

![Show Wind at readouts for the cursor, a dropped point, the camera and the target](wind-images/inspect-wind.jpg)

*Readouts from **Show Wind at**, with **Camera**, **Target** and **Mouse Cursor** on, and generated test soundings. The large yellow readout follows the cursor. **#1** is a dropped point, with its green stalk. The **Camera** and **Target** readouts show the altitude of each track. The cursor and **#1** show the **Altitude** value, 18,000 ft. Each arrow points the way the wind blows. Each readout gives the direction that the wind blows from, and the source with the launch time of the nearest sounding and the distance to it.*

### The compass

The compass in a view has two small triangles. The yellow triangle shows the direction that Target Wind comes from, and the green triangle the direction that Local Wind comes from, on the current frame. The text under the compass names the Wind Source as the menu does (with Separate Wind Sources and two different sources, both: target / local). Hold the pointer on the compass to see this as a tooltip.

### Wind Source

Single dropdown when **Separate Wind Sources** is off. The label changes to **Target Wind Source** when the toggle is on, and a second dropdown (**Local Wind Source**) appears below it.

Available sources:

| Source | What it is | When to use it |
|---|---|---|
| **GFS (NOAA)** | Global atmospheric grid from the NOAA Global Forecast System. Whole-Earth coverage, 6-hour cycles. | Any date from 22 March 2021 to today. Good when you need wind at altitudes other than the ground. |
| **UWYO Soundings** | Radiosonde profiles from University of Wyoming. Auto-fetches the nearest stations and IDW-blends them. | Historical dates, good vertical resolution near launch sites. |
| **IGRA2 Soundings** | NOAA NCEI's Integrated Global Radiosonde Archive. Same idea as UWYO but a different upstream archive. | A different archive from UWYO. Can have dates or stations that UWYO does not. |
| **Manual Soundings** | Every loaded sounding, blended together: files you dragged in (a UWYO `.csv`/`.txt`, an IGRA2 `.txt`, or an XML wind profile) and any fetched earlier. | When you want curated profiles instead of automatic nearest-station fetches. |
| **open-meteo** | Per-track-point fetches from the Open-Meteo public API (no key, rate-limited). | Useful for one-off lookups; not great for filling a whole grid. |
| **Manual** | A single uniform wind defined by **Target Wind From / Speed**. | Quick experiments, sitches without specific weather, or when the real data is missing/wrong. |
| **Track: \<name\>** | If your sitch has a track file with embedded wind columns (MISB-formatted WindDirection / WindSpeed), each loaded track shows up as its own option. For a telemetry track the wind value comes straight from the track row at the current frame. For a sounding track (IGRA2, UWYO, or an XML wind profile) the entry reads that one profile at the altitude of the target, and of the camera for Local Wind, with no blend with other soundings. WindSpeed is read as metres per second, the MISB standard unit, and shown in the speed unit of the Wind folder. In the menu, the Track entries are in two groups: **Profiles (read by height)** for sounding and profile tracks, and **Telemetry tracks (read by time)** for the others. | Aircraft data files (e.g. military pod metadata) that already contain wind telemetry; or one particular sounding, used alone. If no track carries wind, no Track: entry appears. |

**Selecting GFS, UWYO, IGRA2, Manual Soundings or a Track: source for the first time** auto-toggles **Show Wind Lines** on once and triggers the data load — both happen in one step, so the streamlines appear as soon as the data arrives. If you turn the lines off explicitly, that auto-show won't fire again for that source in the same session.

#### Manual source vs. Override

These are easy to confuse — they share the Target sliders.

- **Override** (a checkbox for Target Wind and one for Local Wind) uses a value that you type in place of the source, for what-ifs. It lasts until you turn it off. See [Target and Local Wind](#target-and-local-wind).
- **Manual source** (the dropdown choice **Manual**) tells the wind field "there is no atmospheric data — synthesize one wind from the Target sliders." The value is the same everywhere, but the lines fade with distance from the target and camera. With **Target Wind Speed** = 0, the default in a new custom sitch, the field is all zero and the streamlines are invisible, even if **Local Wind Speed** is not zero.

#### Manual Soundings

A pass-through. Drag a UWYO `.csv`/`.txt` or an IGRA2 `.txt` (a zipped `.txt.zip` is auto-extracted) onto the page; Sitrec parses it and adds it to the loaded-soundings pool. An IGRA2 file with more than 10 soundings imports only the first one in the file, whatever its date: to get a specific launch, use **Import Sounding…**. An installation can also read its own XML weather files: see [XML wind profiles](#xml-wind-profiles).

Picking **Manual Soundings** blends every sounding that is loaded, including any that **UWYO Soundings** or **IGRA2 Soundings** fetched earlier. It starts no fetch of its own. To use one sounding alone, pick its **Track:** entry.

### Separate Wind Sources

Off (default): a single Wind Source feeds both target and local. Toggling it on reveals **Local Wind Source** so the two can use different inputs.

A common reason to turn this on: a sitch where the camera platform has a track-file wind (MISB-derived) and you want the target to use real GFS data instead of inheriting from the platform.

Each side reads its own source on every frame. GFS levels and open-meteo data load when a side needs them, and a sounding source loads its soundings when you pick it. The streamlines and the arrows show the Target Wind Source only. When the two sources are different, **Status** describes each one ("Target: … Local: …"). With **Manual** as Local Wind Source, you set Local Wind with its sliders.

When you turn **Separate** off again, Local Wind Source snaps back to whatever Target is set to, so the two pipelines don't quietly drift out of sync.

### Status

Says where the wind comes from, on as many lines as it needs: the source, the time of the data, the distance from the target to the nearest data, and the heights that the data covers. It changes when data loads, when the GFS cycle changes, and as the target moves. For example:

- `GFS 2025-09-19 18Z–2025-09-20 00Z, blended in time for 21Z, 1° grid. Heights 33 ft above the ground to 101,000 ft.` The times are the cycles of the data that Sitrec has, which can be an earlier cycle than the one asked for. At a cycle time exactly, or when the later cycle is not published yet, there is one cycle.
- `UWYO: 3 soundings, nearest launched 2025-09-19 12Z. 128 km from the target. Wind data 397 ft to 107,090 ft.`
- `Track: wx-probe: one profile, 2025-09-19 20:50Z (no time in the file: the sitch start). 24 km from the target. Wind data 0 ft to 30,000 ft.`
- `Manual: 270° at 15 kt, the same at every place, height and time.`

Heights are in the height unit of **Units** (feet, or metres for **Metric**), and speeds in the unit of the Wind folder.
- `Track: N12345: the wind in the track, at the time of each frame.`

`Loading more data…` at the end means that data for a point is on its way (a GFS level or an open-meteo column). With [Separate Wind Sources](#separate-wind-sources) and two different sources, it describes each one. While data loads, or after an error, it shows a message such as `Fetching 700 hPa...` or `Error: ...` in place of this. You can select and copy the text, but you cannot edit it.

### Wind in Knots

Shows every wind speed in the Wind folder and in the Show Wind at readouts in knots. When it is off (the default), they use the speed unit of **Physics → Units**: knots for **Nautical**, mph for **Imperial/US**, km/h for **Metric**. With **Feet only**, wind speeds are in knots. The names of the speed rows give the unit, for example **Target Wind Speed (mph)**. The setting is saved with the sitch.

It changes speeds only. Heights on the Wind folder (**Altitude**, **Status**, the readouts and messages) always use the height unit of **Units**: feet for **Nautical**, **Imperial/US** and **Feet only**, metres for **Metric**.

### Altitude

The altitude [above mean sea level (MSL)](GIS.md#three-kinds-of-height) that the streamlines and arrows show. The row gives its unit: **Altitude (ft)**, or **Altitude (m)** with **Metric** units. The slider ranges from 0 to 60,000 ft (18,288 m), in steps of 10 ft or 5 m. Target Wind and Local Wind do not use it: they are read at the height where the wind is used.

For GFS, Sitrec blends the two pressure levels above and below this altitude, and the two cycles around the time of the current frame. For the lines and arrows it places each level at its standard-atmosphere height, so the match to the real pressure surface is approximate. When you release the slider, Sitrec fetches any levels that are not cached and rebuilds the streamlines.

For the wind at one point (Target Wind, Local Wind, a **Show Wind at** readout), GFS also takes the ground into account. It puts the GFS 10 m wind 10 m above the terrain at that point, places each pressure level at its real height there (the height of that pressure in the model), leaves out each level that is under the terrain, and blends the two levels around the point. The model's values under the ground are not wind, so they are not used. A level that the point needs and that is not loaded yet loads then; until it arrives, the readout says **loading…**.

![Altitude maps to GFS pressure levels](wind-images/altitude-stack.svg)

*GFS pressure levels. hPa (hectopascal) is a unit of air pressure, which falls as altitude rises.*

### Lock Altitude to

| Value | Effect |
|---|---|
| **None** | Altitude is whatever you typed in the slider. |
| **Camera** | Slider tracks the camera's current altitude every frame. |
| **Target** | Slider tracks the target's current altitude every frame. |

Lock-to-Camera/Target is useful when you want the streamlines to always be at the altitude of the camera or target as the scene plays. Setting it back to None freezes the slider at whatever value it last had.

### Nearby Wind Only / Nearby Radius (km)

Sitrec's wind grid is global, with 1° cells. For the sounding and open-meteo sources, each cell is the same blend of the nearest data that the readouts and Target and Local Wind use. So where the lines are at the height of a readout (for example with **Lock Altitude to** the camera), they point the same way as its arrow, within a degree or two; in a very light wind close to a station the difference can be larger. **Nearby Wind Only** is on by default (**Nearby Radius (km)** = 250): it restricts streamline seeding to a lat/lon box of that radius around the camera position, which is faster to compute and easier to read when you're zoomed in close. Turn it off to seed streamlines everywhere that the source has coverage: the whole globe for GFS. For the sounding, open-meteo, Manual and Track sources, the lines fade with distance from the data points and stop about 2,200 km away.

The arrows overlay (see below) is unaffected.

### Show Wind Lines

The animated streamline mesh in the main view. First toggle-on triggers the data load (slight delay if the network is involved); subsequent toggles just flip visibility.

If the first load failed (no network, no soundings nearby, etc.), toggling Show off and on again retries the load instead of showing an empty mesh forever. If older wind data is still in place, this does not retry: pick another source, then pick the failed source again.

### Show Wind Arrows

A screen-space grid of arrows in the main view, ray-cast onto the ellipsoid at the current wind altitude. Independent of the streamlines — either or both can be on. Arrows are usually clearer at low zoom; streamlines tell you more about flow structure when you're up close.

![Arrows on, lines off](wind-images/arrows-only.jpg)

*Wind arrows alone, from a Manual wind. Each arrow points the way the wind blows.*

![Both layers on](wind-images/lines-and-arrows.jpg)

*Streamlines and arrows together, from the same Manual wind.*

**Sounding arrows.** While the wind field shows, each loaded sounding has one arrow at the wind altitude. The arrow is at the balloon's position at that altitude and points in the direction that the wind blows to. A pink arrow is a sounding that the current **Wind Source** uses. A gray arrow is a sounding that it does not use: for example, an XML file or an IGRA2 sounding when the source is **UWYO Soundings**, or every sounding when the source is **GFS**. **Manual Soundings** uses every loaded sounding.

![Streamlines colored by speed over North America, with pink and gray sounding arrows](wind-images/sounding-arrows-speed-colors.jpg)

*Generated test soundings, with **Wind Source** set to **IGRA2 Soundings**. The pink arrows are IGRA2 soundings. The gray arrow is a UWYO sounding, which this source does not use. Each label gives the station and the launch. The color of a streamline shows the wind speed: see **Max Speed** in [Wind Line Style](#wind-line-style) below.*

### Wind Line Style

A folder with the rows that set how the streamlines look:

- **Opacity** — overall alpha (0–1).
- **Spacing (°)** — seed density in degrees of latitude/longitude. Higher value = fewer, more spread-out streamlines.
- **Max Speed** — the speed at the top of the color ramp, in the unit of the Wind folder. The ramp runs from blue (slow) through cyan, green and yellow to red. Wind faster than this paints at the high end of the gradient.

### Refresh Wind Data

Re-runs the current source's load. Useful if:
- You moved the scene (different camera lat/lon) and want the fetcher to pick new nearby soundings;
- A GFS or open-meteo load failed and you want to retry. After a failed UWYO or IGRA2 fetch, this does not fetch again: pick another source, then pick the sounding source again.

### Local from Constant Camera

Estimates the wind at the camera platform from the camera track, on the assumption that the platform flew at a constant airspeed. It finds the single horizontal wind that makes the airspeed along the track most nearly constant, writes it into **Local Wind From** / **Local Wind Speed**, and turns on **Override Local Wind**, so the result stays. The Wind Source and Target Wind do not change. **Status** then shows the result, e.g. `Local wind: 270° / 45 kt (σ=3.2 kt, …)`, where σ is the remaining spread in airspeed. The speeds are in the unit of the Wind folder.

### Sounding Count

How many of the nearest soundings to fetch when an auto-loading sounding source (UWYO / IGRA2) is picked. Default 3, max 10. At each point Sitrec blends the three nearest soundings, so a higher count widens the area covered. It does not add stations to the blend at one point. It also makes more network requests.

### Import Sounding…

Opens a dialog to fetch a *specific* sounding by station + date + launch. Four steps:

1. **Station picker** — type to filter, pick from the list (sorted by distance to your camera).
2. **Source** — UWYO (fastest) or IGRA2 (NCEI archive).
3. **Date** — defaults to the date of the 00Z or 12Z launch closest to the sitch start.
4. **Launch** — UWYO asks for 00Z or 12Z. IGRA2 shows a list of the launches nearest that date.

After fetching, Sitrec auto-switches your Wind Source to **Manual Soundings** so you can keep dropping more in without each one being clobbered by an auto-fetch.

If UWYO has nothing for that station and date, Sitrec tries the next 4 nearest stations, and a message names the station it used. If all five fail, a message gives the last error.

## Workflows

### Quick wind for a synthetic sitch
1. Leave Wind Source on **Manual**.
2. Type the wind you want into **Target Wind From / Speed**.
3. (Optional) Toggle **Show Wind Lines** to see the uniform field.

### Real wind for a known date/place
1. Set the sitch date, time and camera position.
2. Pick **GFS (NOAA)** (any date from 22 March 2021 to today).
3. Set **Altitude** to the height where you want to see the wind.
4. Optionally lock altitude to the camera or target track.
5. Turn on **Show Wind at** to read the wind at the target and the camera. To try a different wind at the target, turn on **Override Target Wind** and set the sliders.

### Real wind for a sounding-friendly date
1. Set the sitch date, time and camera position.
2. Pick **UWYO Soundings** or **IGRA2 Soundings**.
3. Sitrec fetches the 00Z or 12Z launch nearest to the sitch start, before or after it, from the nearest *N* stations that have usable wind (*N* is **Sounding Count**). If a UWYO station has no sounding for that launch, Sitrec tries the launch on the other side of the sitch start. A launch that has not happened yet is not used.
4. **Refresh Wind Data** if you move the scene a long way.

### One specific sounding
1. **Import Sounding…**
2. Pick the station and date.
3. Sitrec auto-switches you to **Manual Soundings**; you can now import more, and it blends them all.

### Camera and target on different inputs
1. Turn on **Separate Wind Sources**.
2. Pick the **Target Wind Source** (e.g. GFS).
3. Pick the **Local Wind Source** (e.g. a Track:* option from a MISB-equipped track).

## XML wind profiles

An installation can also teach Sitrec to read its own XML weather files. The file must hold a position (latitude, longitude, elevation) and a vertical profile: one element for each reporting altitude, with the altitude, wind direction and wind speed inside it. Air pressure and temperature are read too if they are there; everything else in the file is ignored.

The person who runs the installation describes the file layout once, with `SITREC_CUSTOM_SOUNDING_<NAME>_*` settings: the element names for the level and for each field, and the units. An altitude can be in metres, feet, kilometres or flight levels; a flight level is read as the standard-atmosphere height for its pressure (FL100 is 3,048 m). The settings and an example are in `config/shared.env.example`, under **Custom Sounding Files**. With a container, put them in the env file that the container starts with. A namespace prefix on an element name (`<xyz:Value>`) does not matter.

Sitrec identifies the format of a dropped file by itself. A layout has a list of substrings (`_XMLNS_CONTAINS`); if any one of them is in a namespace declaration in the file (`xmlns="..."` or `xmlns:prefix="..."`), the file is that format. An optional second list (`_FILE_CONTAINS`) is looked for anywhere in the file text, and one match there is also enough.

To find the settings for a file, open **Sitrec → Extra Tools → XML Wind Profile Analyzer** and load the file. The tool finds the position and the levels, proposes the settings, and shows what Sitrec reads with them. It reads the file in the browser and uploads nothing. It can also make a report of the file structure (tag names, namespace addresses and unit names, with no measurements, positions or times) to send to the person who sets up Sitrec.

To try settings without a change to the installation, paste them into **Sitrec → Settings → SITREC_ ENV Override…** and save. They then apply to you only, and you can import the file at once. This works only if the installation allows it: its `ALLOW_OVERRIDE` setting must list these names. The example configuration allows `SITREC_CUSTOM_SOUNDING_*`; when the installation allows no setting, the menu entry is not shown.

To use a file, drag the `.xml` file onto the page, or use **File → Import File**. It appears as a sounding track at the position in the file, named after the file. Sitrec also sets **Wind Source** to the file's own entry, **Track: \<filename\>**, so Target Wind comes from that profile at once, at the target's altitude. You can select a different source afterwards. When you open a saved sitch, its saved wind source is kept.

After the import, a message in the main view says what the import did: the number of wind levels and the heights they cover, the distance from the target, the time of the data, the new Wind Source, and the Target Wind and Local Wind that it gives now. The message starts with a warning when the profile is more than 200 km from the target, or more than 3 hours from the time of the current frame: its wind may not be the wind at the target.

A value that the file marks as missing (the layout's `_MISSING_VALUES` setting, for example `-9999,999`) is taken as missing. So is a value that cannot be real: a wind direction outside 0–360°, a wind speed over 200 m/s, or an altitude outside −500 to 50,000 m. The browser console says how many values were ignored. A level with no wind gets the wind interpolated from the levels above and below it, by its east and north parts. Above the highest wind level and below the lowest, the profile gives that level's wind.

Sitrec draws the profile as a balloon path: a climb from the file's position at 5 m/s, which starts at the profile's time and drifts with the profile's own winds. This path is reconstructed, not measured, and the track's folder in the **Contents** menu says so (**Path: Reconstructed ascent**). Before the climb starts and after it ends, the track stays at its first or last point.

Sitrec reads one position and one profile from a file. Wind direction is taken as degrees true. If the file has no time (or no time setting), the profile takes the start time of the sitch, and it keeps to it: when you change the start time, the drawn path moves to the new start. If a file does nothing when you drop it, open the browser console. A layout with an unknown unit or a missing setting is reported there by name, and so is a file that was identified as a layout but has no position and levels where the settings say they are. If the console has neither message, no layout identified the file: check the two lists against the file.

## Notes, gotchas, and troubleshooting

### Date-related

- **GFS dates.** Sitrec reads GFS for any date from 22 March 2021 to today: NOMADS keeps about the last 10 days, and older dates come from the AWS archive. For an earlier date, **Status** shows `Error: HTTP 400 for level ...`. Use soundings for those dates.
- **Cycle latency.** A GFS cycle (00Z, 06Z, 12Z, 18Z) takes ~3.5–4 hours to publish. If you ask for an hour that hasn't been processed yet, Sitrec falls back to the previous cycle on the same day, and for a time after the last published cycle it uses that cycle alone.
- **Wind and the sitch's date/time.** GFS follows the sitch time: each frame blends the two cycles around its time, and Sitrec loads the cycles that it needs by itself. UWYO and IGRA2 soundings do not, and **Refresh Wind Data** keeps the old launches. Set the date (Time menu) before you load soundings. After a date change, delete the old sounding tracks in the **Contents** menu, pick another source, then pick the sounding source again.

### Display issues

- **"Show Wind Lines" doesn't show anything.** Check **Status**. Common causes: Manual source with **Target Wind Speed** = 0; sounding fetch returned nothing for that location/date; GFS not yet published for that hour; network blocked.
- **Wind direction looks 180° off.** "From" is the meteorological convention — a north wind blows *from* the north. Sitrec reads imported directions as "from". For an XML wind profile that gives the direction the wind blows to, the layout must set `SITREC_CUSTOM_SOUNDING_<NAME>_WIND_DIR_CONVENTION=to`. If you're typing values, check the convention.
- **Lock Altitude isn't tracking.** The slider follows the track in steps of 50 ft (15 m), and it updates while the sitch is paused too. While a lock is on you cannot set the altitude by hand: the next update puts it back.
- **Arrows do not show.** Check the **Wind Field** entry in the **Show** menu. It hides all wind drawing.

### Sources

- **Sounding rate limits.** Sitrec's server allows 20 UWYO fetches a minute; if you hit the limit, Sitrec waits ~66 s and retries, showing the countdown in the loading-progress overlay.
- **No PHP server?** GFS and UWYO both need the Sitrec server, and GFS also needs Python on that server. In serverless / static-build deployments, the main Wind Source dropdown still lists both, but they won't load. Use **IGRA2 Soundings** (fetched directly from NCEI), open-meteo or **Manual**. The **Import Sounding…** dialog's Source step skips the UWYO/IGRA2 prompt and silently defaults to IGRA2.
- **Sounding count slider doesn't seem to change anything.** Sounding Count only takes effect on the *next* fetch — change it, then press **Refresh Wind Data**. Changing the source fetches again only if no sounding of that source is loaded.
- **Track: \<name\> isn't there.** That entry only appears for tracks that carry wind: telemetry files with MISB-format WindDirection / WindSpeed columns, and soundings (IGRA2, UWYO or an XML wind profile). Most generic GPS / KML tracks don't.

### Save / load

- **The chosen source persists with the sitch.** Saving a sitch with `Wind Source = GFS` and `Altitude = 18,000 ft` saves those settings; reloading restores them and re-fetches the data (cache-served if available).
- **Override is saved, with its values.** Under a source other than **Manual**, Target Wind and Local Wind without Override are read from the source again when the sitch opens; the numbers on the sliders at the save are not used.
