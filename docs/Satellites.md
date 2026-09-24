# The Satellites Menu

**Satellites**

The Satellites menu loads orbital data for satellites and controls how they are drawn. Sitrec
calculates where every loaded satellite is at the sitch time, whether it is in sunlight, and
whether it is flaring (reflecting the Sun toward the camera). Satellites appear as points of
light in both 3D views.

Satellite orbits are described by **TLEs** (two-line element sets) or by **OMM** records
(Orbit Mean-Elements Messages, the newer format that the same catalogs now publish). Sitrec reads
both. This page says "TLE data" for either.

This page is a reference for every control. For a step-by-step guide to recreating a
Starlink flare sighting, see [Investigating Starlink Flares](Starlink.md).

- [Loading satellite data](#loading-satellite-data)
- [Which satellites are shown](#which-satellites-are-shown)
- [Filter TLEs](#filter-tles)
- [Brightness and flares](#brightness-and-flares)
- [Arrows, lines and labels](#arrows-lines-and-labels)
- [Satellite to Track](#satellite-to-track)
- [Satellite views in the Show menu](#satellite-views-in-the-show-menu)
- [Export TLE](#export-tle)
- [Tips](#tips)

---

## Loading satellite data

No satellites are shown until TLE data is loaded. There are two ways to load it: from the
server with a button in the Satellites menu, or by dragging a file into Sitrec.

### From the server

**Satellites → Load …**

| Button | What it loads |
|---|---|
| **Load LEO Satellites For Date** | Low Earth orbit payloads (satellites, not rocket bodies or debris) for the sitch date. This is the normal choice |
| **Load CURRENT Starlink** | The Starlink satellites as they are **now**, in real time. Not for a past date |
| **Load ACTIVE Satellites** | All active satellites as they are **now**, in real time. Not for a past date |
| **(Experimental) Load SLOW Satellites** | Objects in higher, slower orbits (fewer than about 11.25 orbits per day) for the sitch date. Can time out for recent dates |
| **(Experimental) Load ALL Satellites** | Every object in the catalog for the sitch date. Can time out for recent dates |

The buttons that appear depend on how the server is set up, so some may be missing on a
particular installation.

The dated loads (LEO, SLOW and ALL) ask the server for the elements published around the sitch
date. The server gets them from Space-Track. "LEO" here means objects that go round the Earth
more than 11.25 times per day, in orbits that are nearly circular (eccentricity below 0.25).

- Sitrec asks for the set starting the day before the sitch date.
- If the sitch date is in the last five days, it asks for the set from six days ago instead,
  because very recent sets are not complete. See
  [Wait a few days before analysing a very recent event](Starlink.md#wait-a-few-days-before-analysing-a-very-recent-event).
- If the server has no data for that date, Sitrec tries again up to three times, going back
  three days each time.

A progress window shows the download. It has a button to stop the download.

### From a file

Drag a TLE file onto the Sitrec window. Sitrec accepts `.tle`, `.2le` and `.3le` files,
`.txt` files that contain TLEs, and OMM files in CSV format (`.csv`), such as those from
CelesTrak or Space-Track.

If TLE data is already loaded, Sitrec asks what to do with the new file:

| Choice | Result |
|---|---|
| **Merge (combine satellite data)** | Adds the new satellites to the loaded ones, combined by catalog number |
| **Merge All Files (skip dialog for remaining files)** | Merges this file and every other file in the same drop without asking again |
| **Replace (remove existing data)** | Removes the loaded data and uses the new file |
| **Cancel** | Does not load the file |

The same dialog also compares the two sets against the sitch date, to help you choose.

If none of the satellites you drag in is shown, because they belong to no category that is
turned on, Sitrec turns on **Other Satellites** so that you can see them.

### Is the data good for this time?

When TLE data is loaded, the top right of the main view shows the date range the data covers,
and **In Range**, the percentage of the shown satellites that Sitrec can place at the current
time. A satellite whose elements are more than 90 days from the current time is not drawn. The
text is green at 100%, yellow from 95% up to 100%, and red below 95%. If it is red, load the
data for the sitch date.

When you reopen a sitch of your own that was saved with incomplete data, Sitrec offers to add
the missing satellites. See
[Reopening a saved sitch](Starlink.md#reopening-a-saved-sitch).

---

## Which satellites are shown

**Satellites → (category switches)**

Each satellite belongs to a category by its name or catalog number. A satellite is shown if any
switch that applies to it is on.

| Control | Default | What it does |
|---|---|---|
| **Show Satellites (Global)** | On | Master switch for all satellites. It is also in the header menus of the 3D views |
| **Starlink** | On | SpaceX Starlink satellites (names that start with STARLINK) |
| **ISS** | On | The International Space Station |
| **Celestrack's Brightest** | On | The satellites on CelesTrak's list of brightest satellites |
| **Other Satellites** | Off | Every satellite that is not in one of the categories above |
| **List** | (empty) | A comma-separated list of names or catalog (NORAD) numbers. Name matching ignores case and matches the start of the name, so `starlink-30` matches STARLINK-30xx. `SL-` is short for Starlink, so `SL-1234` matches STARLINK-1234 |

**List adds satellites; it does not hide the others.** To see only the satellites on the list,
turn off **Starlink**, **ISS**, **Celestrack's Brightest** and **Other Satellites**.

Satellites below 100 km altitude are never drawn.

Starlink satellites are drawn pale yellow, or orange for those with a five-digit Starlink
number. Other satellites are white.

---

## Filter TLEs

**Satellites → Filter TLEs** and **Satellites → Clear TLE Filter**

**Filter TLEs** opens a window for narrowing down a large catalog by position, name or orbit.
It works on top of the category switches: a satellite must pass both to be shown. You need TLE
data loaded first.

The window shows the result live, as *N / M satellites match*, while you change it. **Apply**
keeps the filter and closes the window. **Cancel** restores the filter you had before. **Clear
All** unchecks every filter. **Clear TLE Filter** in the menu removes the filter completely.

Each filter has a checkbox. Only the checked filters are used.

**Spatial filters** use the position of the look camera.

| Filter | Default | Passes a satellite that is… |
|---|---|---|
| **Any frame in range** | Off | (A mode, not a filter.) When checked, the spatial filters pass a satellite that meets them at any time during the sitch. This is slower. When unchecked, only the current frame is tested, and the result updates as you move the camera or the time |
| **Above Camera** | Off | higher than the look camera |
| **Below Camera** | Off | lower than the look camera |
| **Altitude Range** | 200 – 2000 km | between the two altitudes |
| **Crosses View Frustum** | Off | inside the look camera's field of view |
| **Close to Centerline** | 10° | within this angle of the look camera's center line |
| **Not Hidden by Earth** | On | not behind the Earth, as seen from the look camera |

**Name filters**

| Filter | What it matches |
|---|---|
| **Name** | A name pattern with `*` as a wildcard, for example `STARLINK*`. Ignores case |
| **Name RE** | A regular expression. Ignores case |

**Orbital parameters**

| Filter | Default range |
|---|---|
| **Eccentricity** | 0 – 0.1 |
| **Inclination** | 0 – 180° |
| **Period** | 80 – 200 min |
| **Speed** | 0 – 10 km/s |

---

## Brightness and flares

**Satellites → (brightness and flare controls)**

| Control | Default | What it does |
|---|---|---|
| **Sat Brightness** | 2 | Scale factor for the brightness of the satellites. 0 is invisible |
| **Flare Brightness** | 0.2 | Scale factor for the extra brightness of a flaring satellite. 0 adds nothing |
| **Sat Cut-Off** | 0.06 | Satellites dimmed to this level or less are not drawn |
| **Flare Angle Spread** | 5 | The largest angle, in degrees, between the reflected view line and the direction to the Sun for which a flare is visible. Sitrec treats the underside of the satellite as a mirror parallel to the ground |
| **Flare Model** | Geocentric Nadir | How "down" is found for that mirror. **Geocentric Nadir** points at the Earth's center. **Geodetic Nadir** is perpendicular to the WGS84 ellipsoid. The two differ by at most about 0.18° |
| **Earth's Penumbra Depth** | 5000 | The vertical depth, in metres, over which a satellite fades out as it goes into the Earth's shadow |

---

## Arrows, lines and labels

**Satellites → (display switches)**

| Control | Default | What it does |
|---|---|---|
| **Sun Angle Arrows** | Off | When a flare is found, draws arrows from the camera to the satellite and from the satellite to the Sun |
| **Satellite Arrows** | Off | Arrows showing the direction each satellite is moving |
| **Flare Lines** | Off | Lines that connect flaring satellites to the camera and to the Sun |
| **Satellite Ground Arrows** | Off | Arrows from each satellite down to the ground below it |
| **Flare Region** | Off | The region of the sky where satellite flares are visible |
| **Flare Region in Look View** | Off | Also draws the flare region in the look view |
| **Flare Band** | Off | The band on the ground from which flares can be seen: between the smaller green circle and the larger yellow circle |
| **Satellite Labels (Look View)** | Off | Name labels in the look view |
| **Satellite Labels (Main View)** | Off | Name labels in the main view |
| **Label Flares Only** | Off | Label only satellites that are flaring |
| **Label Lit Only** | Off | Label only satellites that are in sunlight |
| **Label Look Visible Only** | Off | Label only satellites inside the look camera's field of view |
| **Max Labels Displayed** | 1000 | The largest number of satellite labels drawn at one time (100 to 10,000) |
| **Display Range (km)** | 100000 | Satellites farther away than this get no name labels or arrows |

Labels shorten Starlink names, so STARLINK-1234 is labeled SL-1234.

The Flare Band and Sun Angle Arrows are explained with pictures in
[Flare Band and Sun Angle Arrows](Starlink.md#flare-band-and-sun-angle-arrows).

**Show → Celestial → Label List** further limits which labels are drawn, for satellites and for
stars and planets. It takes a comma-separated list, for example `ISS, SL-1234`. Leave it empty
to label everything.

**Right-click a satellite** in a 3D view to see its name and catalog number. In a custom sitch,
this menu also has **Sat Track 1** and **Sat Track 2**, which set **Satellite to Track** (below)
to that satellite.

---

## Satellite to Track

**Satellites → Satellite to Track** and **Satellites → Satellite to Track 2**

In a custom sitch, these two text fields each turn one satellite's orbit into a track for the
whole sitch, named **Satellite** and **Satellite 2**. Type a name or a catalog number. The start
of a name is enough, for example `ISS`. The default is the ISS (catalog number 25544).

If the satellite is not in the loaded TLE data, the field shows *… not found*. The track is
calculated again when new TLE data is loaded.

---

## Satellite views in the Show menu

**Show → Celestial** and **Show → Star Chart**

### Satellite Ephemeris

**Show → Celestial → Satellite Ephemeris** opens a table of the satellites above the look
camera's horizon. It appears in the menu after TLE data is loaded. It lists up to 100 of the
satellites that are shown, highest first:

| Column | Meaning |
|---|---|
| **Name** | The satellite name |
| **Az** / **El** | Azimuth and elevation, in degrees, from the look camera |
| **Range** | Distance from the camera, in km |
| **Alt** | Altitude, in km |
| **Vis** | **VIS**: sunlit, with the observer in darkness (Sun more than 6° below the horizon). **DAY**: sunlit, but the observer's sky is too bright. **ECL**: in the Earth's shadow |
| **Next Event** | The time until the satellite sets (**LOS**) or rises (**AOS**), searching up to two hours ahead |

The **Only VIS** checkbox, on by default, limits the table to satellites in the VIS state.

Note that **Next Event** is currently counted from your computer's clock, not from the sitch
time. It is only meaningful when the sitch is set to the present.

### Sky Plot

**Show → Celestial → Sky Plot** draws the same satellites as the Satellite Ephemeris table on a
circular map of the sky. The center is straight up (the zenith) and the edge is the horizon,
with rings at 30° and 60° elevation. North is at the top and east is on the right. It follows
the ephemeris table's **Only VIS** setting.

### Star Chart

**Show → Star Chart** has a whole-sky chart of stars, constellations, the planets, the Sun and
the Moon, for the current time and look camera location, in the style of a printed sky chart.

| Control | Default | What it does |
|---|---|---|
| **Show Star Chart** | Off | Shows or hides the chart |
| **Color Scheme** | White | **Lavendar**, **Black**, **Night Vision** or **White** |
| **Satellite Track** | On | Draws the path of **Satellite to Track** across the chart, with times |

Like a paper star chart, it shows the sky as seen looking up, so east is on the **left**.

### Other celestial items

The rest of **Show → Celestial** is about the stars, the planets and the Earth's shadow:
direction vectors to the Sun, Moon and planets, **Equatorial Grid in Main** and **Equatorial Grid
in Look**, **Constellation Lines**, **Asterism Style**, **Render Stars**, **Show Earth's Shadow**
and **Show Moon's Shadow**. The Earth's shadow is useful with satellites: it shows the region of
space where satellites are in darkness.

The brightness of the stars and planets is set in the View menu (**Star Brightness**, **Star
Limit**, **Planet Brightness**), not in the Satellites menu.

---

## Export TLE

**File → Export TLE**

This button appears after TLE data is loaded. It saves the loaded data to a file:
`satellites.tle` for TLE data, or `satellites.csv` for OMM data. After a merge, it saves the
combined data.

---

## Tips

### No satellites appear

- Check that TLE data is loaded: the date range and **In Range** show at the top right of the
  main view.
- Check **Show Satellites (Global)** and the category switches. A satellite that is in no
  category needs **Other Satellites**.
- Check **Sat Brightness** is not 0, and that **Sat Cut-Off** is not too high.
- Check that no TLE filter is active: use **Clear TLE Filter**.
- A satellite in the Earth's shadow is not lit, so it fades out. Check the time of night.

### Too many satellites to see what is going on

Use **Filter TLEs** with **Crosses View Frustum** and **Not Hidden by Earth** to keep only the
satellites the look camera can see. Add **Label Look Visible Only** to label just those.

### Find which satellite made a flare

Turn on **Flare Lines** and **Label Flares Only**, then step through the frames around the
flare. Right-click a satellite for its catalog number. The full procedure is in
[Investigating Starlink Flares](Starlink.md).

---

## See also

- [Investigating Starlink Flares](Starlink.md): a step-by-step guide to horizon flares
- [Long Exposure Simulation](LongExposure.md): star trails and satellite streaks
- [Historic Skies](HistoricSkies.md): the sky for dates before the space age
- [Lighting](Lighting.md): the sun, ambient light and night scenes
- [User Interface](UserInterface.md)
