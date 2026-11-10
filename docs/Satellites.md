# The Satellites Menu

**Satellites**

The Satellites menu loads orbital data for satellites and controls how they are drawn. Sitrec
calculates where every loaded satellite is at the sitch time, whether it is in sunlight, and
whether it is flaring (reflecting the Sun toward the camera). Satellites appear as points of
light in the 3D views. The main view shows the whole constellation. The look view shows only what
the brightness model and **Sat Cut-Off** allow: see [Brightness and flares](#brightness-and-flares).

Satellite orbits are described by **TLEs** (two-line element sets) or by **OMM** records
(Orbit Mean-Elements Messages, the newer format that the same catalogs now publish). Sitrec reads
both. This page says "TLE data" for either. The numbers in these records that describe an orbit
are called **elements**. They apply at a known date, and they get less accurate as time passes
from that date.

This page is a reference for every control. For a step-by-step guide to recreating a
Starlink flare sighting, see [Investigating Starlink Flares With Sitrec](Starlink.md).

The top of the menu starts with current active-satellite and dated LEO downloads, then
name/NORAD search, **Filter TLEs**, and the category folder. **Sun Angle Arrows**, **Flare Band**,
**Look towards flare region**, the independent M/L **Flare Region** switches, and master
visibility follow. Other controls are grouped:

| Submenu | Controls |
|---|---|
| **Selection & Filters** | Satellite categories, the additive List, and Clear TLE Filter |
| **Labels** | Independent **M** (Main) and **L** (Look) switches on the folder header, plus label restrictions and maximum count |
| **Tracks & Guides** | Satellites to track, satellite and ground arrows, flare lines, and display range |
| **Orbit Data** | Other catalogs, experimental downloads, and the loaded element-date range |
| **Brightness** | Look-view brightness and magnitude limit; **Lighting & Flare Models** inside it holds the brightness model, Starlink design, sunlight model, flare geometry, and legacy appearance settings |

The master **Show Satellites (Global)** switch applies to both views. M/L switches control only
their own view. The separate [satellite viewing panel](Starlink.md#satellite-controls)
is available from **Satellite Controls** at the top of this menu.
It starts enabled in the Starlink Horizon Flares (LIVE) preset.

New custom sitches automatically use **light-blue simulated Starlink satellites** when no orbit
data is loaded, or no loaded element set is within seven days of the viewing time. The stats
and viewing panel say **Simulated Starlink**. Loaded catalogs remain intact and return
automatically when the time is in range. **Orbit Data → Simulate unavailable satellites**
turns this fallback on and off and is saved with the sitch. A sitch that was saved before the
fallback existed loads with it off, so the sitch looks as it did when it was saved.

The fallback shares the SHF app's deterministic constellation generator. Its population
follows monthly estimates from [Jonathan McDowell's Starlink history](https://www.planet4589.org/space/con/star/starindex.html),
with the latest SHF shell measurement as the final anchor. There are no simulated Starlinks
before May 24, 2019; future dates hold the latest measured count. Positions and historical
shell proportions are approximate. Category, search, brightness, flare, and label controls
still apply. Loaded-data TLE filters, exports, and satellite tracking retain their real catalog
and do not treat simulation IDs as NORAD numbers.

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

No satellites are shown until TLE data is loaded. There are three ways to load it: from the
server with a button in the Satellites menu, by dragging a file into Sitrec, or by pasting the
lines of a TLE into the Sitrec window.

### From the server

**Satellites → Load CURRENT Active Satellites / Load LEO Satellites For Date**. Other downloads, including the current Starlink-only feed, are in **Satellites → Orbit Data**.

The live Starlink preset loads the current active catalog by default, including Starlink and
other active satellites. This excludes inactive objects and debris; the dated ALL download
below has a different purpose. If the installation has no active-catalog source configured,
the preset uses its existing Starlink source. Saved sitches retain their saved orbital data.

| Button | What it loads |
|---|---|
| **Load LEO Satellites For Date** | Low Earth orbit payloads (satellites, not rocket bodies or debris) for the sitch date. This is the normal choice |
| **Load CURRENT Starlink** | The Starlink satellites as they are **now**, in real time. Not for a past date, except an event in the last day or two, where it is the closest set available (see [Investigating Starlink Flares With Sitrec](Starlink.md#wait-a-few-days-before-analysing-a-very-recent-event)) |
| **Add CURRENT OneWeb, Kuiper, AST, Iridium** | The orbits that the operators of these four constellations supply, as they are **now**, from CelesTrak's supplemental data. For these satellites they are usually more accurate than the general catalog, and a new launch appears within hours. They are always added to the satellites already loaded, never in place of them. Not for a past date |
| **Load CURRENT Active Satellites** | All active satellites, including Starlink, as they are **now**, in real time. Not for a past date |
| **(Experimental) Load SLOW Satellites** | Objects in higher, slower orbits (fewer than about 11.25 orbits per day) for the sitch date. Can time out for recent dates |
| **(Experimental) Load ALL Satellites** | Every object in the catalog for the sitch date. Can time out for recent dates |

The buttons that appear depend on how the server is set up, so some may be missing on a
particular installation.

The dated loads (LEO, SLOW and ALL) ask the server for the elements published around the sitch
date. The server gets them from Space-Track. "LEO" here means objects that go round the Earth
more than 11.25 times per day, in orbits that are nearly circular (eccentricity below 0.25).

- Sitrec asks for the elements from the day before the sitch date to the day after it.
- For a sitch date before 2018 it asks for three days before to three days after. Elements were
  published less often then, and a satellite with no elements in the request is not shown at
  all. With the narrower request, about 0.3% of the satellites were missing on old dates.
- If the sitch date is in the last five days, it asks for the set from six days ago instead,
  because very recent sets are not complete. See
  [Wait a few days before analysing a very recent event](Starlink.md#wait-a-few-days-before-analysing-a-very-recent-event).
- If the server has no data for that date, Sitrec tries again up to three times, going back
  three days each time.

A progress window shows the download. It has a button to stop the download.

### From a file

Drag a TLE file onto the Sitrec window. Sitrec accepts `.tle`, `.2le` and `.3le` files,
`.txt` files that contain TLEs, and OMM files in CSV format (`.csv`), such as those from
CelesTrak or Space-Track. A pasted TLE follows the same steps as a dragged file.

If TLE data is already loaded, Sitrec asks what to do with the new file:

| Choice | Result |
|---|---|
| **Merge (combine satellite data)** | Adds the new satellites to the loaded ones, combined by catalog number |
| **Merge All Files (skip dialog for remaining files)** | Merges this file and every other file in the same drop without asking again |
| **Replace (remove existing data)** | Removes the loaded data and uses the new file |
| **Cancel** | Does not load the file |

The same dialog also compares the two sets against the sitch date, to help you choose.

If none of the new satellites is shown, Sitrec turns on **Other Satellites**, if that shows them.
It does not turn on **Starlink** or **ISS** for you.

### Is the data good for this time?

When TLE data is loaded, the top right of the main view shows the date range the data covers,
and **In Range**, the percentage of the shown satellites that Sitrec can place at the sitch
time. The date range is the oldest and newest element dates in the data (UTC), not the date
you asked for. **Satellites → Orbit Data → TLEs From** and **TLEs To** show the
same two dates, or *None loaded*.

A satellite whose elements are more than 90 days from the sitch time is not drawn. A satellite
that was not launched yet at the sitch time is not drawn either. Sitrec knows the launch day of
each satellite in a dated load from Space-Track. An older saved set, or one the server stored
before launch days were added, does not have them, and Sitrec then draws every satellite as
before. Because only the day is known, a
satellite is still drawn earlier on its launch day. The
text at the top right of the main view is green when **In Range** is 100%, yellow from 95% up
to 100%, and red below 95%. If it is red, load the data for the sitch date.

**In Range** does not measure accuracy. Elements age, and Starlink satellites change their
orbits, so data that is weeks from the sitch time can show 100% and still place satellites away
from where they were. Compare **TLEs From** and **TLEs To** with the sitch time.

**Right-click a satellite** to see how good its data is. The menu shows its catalog details
when the data has them (international designator, object type, radar size and launch day). From
the [GCAT catalog](https://planet4589.org/space/gcat) it shows **Size (GCAT)** (length, diameter
and span) and, for a Starlink, **Starlink Design (GCAT)**. **Standard Magnitude** is Sitrec's
estimate of the satellite fully lit, 1000 km away, at 90° phase and away from a flare: the
reference that satellite catalogs list (see
[How Sitrec estimates brightness](#how-sitrec-estimates-brightness)). It then shows
**Element Set Age**: how far the elements in use are from the current time, and whether they
are from before or after it. **Position Error** gives a rough range for how far the satellite
can be from its drawn place, in kilometers and as an angle seen from the look camera. It uses a
rule of thumb: about 1 km at the element date, and 1 to 3 km more for each day away from it.
It cannot know about a maneuver. Use it to judge how close a match must be, not as a measured
error.

When you reopen a sitch of your own that was saved with incomplete data, Sitrec offers to add
the missing satellites. See
[Reopening a saved sitch](Starlink.md#reopening-a-saved-sitch).

---

## Which satellites are shown

**Satellites → Selection & Filters**. The master switch and search stay at the top level.

Each satellite belongs to a category by its name or catalog number. A satellite is shown if any
switch that applies to it is on.

| Control | Default | What it does |
|---|---|---|
| **Show Satellites (Global)** | On | Master switch for all satellites. It is also in the header menus of the 3D views, as **Satellites** |
| **Starlink** | On | SpaceX Starlink satellites (names that start with STARLINK) |
| **ISS** | On | The International Space Station |
| **CelesTrak's Brightest** | On | The satellites on CelesTrak's list of brightest satellites |
| **Other Satellites** | On in new custom scenes | Every satellite that is not in one of the categories above. Saved scenes retain their choice |
| **List** | (empty) | A comma-separated list of names or catalog (NORAD) numbers. Name matching ignores case and matches the start of the name, so `starlink-30` matches STARLINK-30xx. `SL-` is short for Starlink, so `SL-1234` matches STARLINK-1234 |

**List adds satellites; it does not hide the others.** To see only the satellites on the list,
turn off **Starlink**, **ISS**, **CelesTrak's Brightest** and **Other Satellites**.

**Search Loaded Satellites** narrows the enabled categories by a name substring or exact NORAD
number. Separate alternatives with commas; clear the search to restore the category matches.

Satellites below 100 km or above 40,000 km altitude are never drawn.

Starlink satellites are drawn pale yellow, or orange for those with a five-digit Starlink
number. Other satellites are white.

---

## Filter TLEs

**Satellites → Filter TLEs**; **Clear TLE Filter** is in **Selection & Filters**.

**Filter TLEs** opens a window for narrowing down a large catalog by position, name or orbit.
It works on top of the category switches: a satellite must pass both to be shown. You need TLE
data loaded first.

The window shows the result live, as *N / M satellites match*, while you change it. **Apply**
keeps the filter and closes the window. **Cancel** restores the filter you had before. **Clear
All** unchecks every filter. **Clear TLE Filter** in the menu removes the filter completely.

Each filter has a checkbox. Only the checked filters are used. The window opens with only **Not
Hidden by Earth** checked, and that filter acts at once: satellites below the look camera's
horizon disappear from the views. **Cancel** brings them back. Each time the window opens, it
starts from these defaults, not from the filter you applied last.

**Spatial filters** use the position of the look camera.

| Filter | Default | Passes a satellite that is… |
|---|---|---|
| **Any frame in range** | Off | (A mode, not a filter.) When checked, the spatial filters test each satellite at up to 60 moments across the sitch. A satellite passes if it meets them at any of these moments, and it shows only around those moments. This is slower. When unchecked, only the current frame is tested. The result updates as you move the camera or the time while the window is open. **Apply** keeps the result of that moment, and it does not update after that |
| **Above Camera** | Off | higher than the look camera |
| **Below Camera** | Off | lower than the look camera |
| **Altitude Range** | 200 – 2000 km | between the two altitudes |
| **Crosses View Frustum** | Off | inside the look camera's field of view |
| **Close to Centerline** | 10° | within this angle of the look camera's center line |
| **Not Hidden by Earth** | On | not behind the Earth, as seen from the look camera |

**Name filters**

| Filter | What it matches |
|---|---|
| **Name** | A pattern for the whole name, with `*` as a wildcard, for example `STARLINK*`. `STARLINK` alone finds nothing. Ignores case |
| **Name RE** | A regular expression. Ignores case |

**Orbital parameters**

| Filter | Default range |
|---|---|
| **Eccentricity** | 0 – 0.1 |
| **Inclination** | 0 – 180° |
| **Period** | 80 – 200 min |
| **Speed** | 0 – 10 km/s |

**Catalog**

These filters use catalog details that only a dated load from Space-Track gives. If some loaded
satellites do not have them, the window says how many have them. A satellite without the
detail fails a checked filter.

| Filter | What it matches |
|---|---|
| **Object type** | Payload, rocket body, debris, or unknown (TBA) |
| **Radar size** | Large (over 1 m²), medium (0.1 to 1 m²) or small (under 0.1 m²) radar cross-section |
| **Launch year** | Launched in this range of years |
| **Intl. designator** | International designators that start with this text. `2024-123` gives every object from that launch |

---

## Brightness and flares

**Satellites → Brightness** for **Sat Brightness** and the magnitude limit. Its **Lighting & Flare Models** submenu holds the model settings.

A flare is sunlight reflected from a flat surface on the satellite, as from a mirror. The flare
calculation assumes that this surface faces straight down. The **off-specular angle** is how many
degrees the reflected ray misses the camera.

| Control | Default | What it does |
|---|---|---|
| **Satellite Brightness Model** | Photometric estimate | Continuous Starlink flare curves, an estimated flare curve for Kuiper satellites, estimated diffuse light, range and phase. **Legacy cone** adds a set flare brightness only inside **Flare Angle Spread** |
| **Limit by Magnitude** | Off | Use estimated apparent magnitude to filter satellite dots in the look view, instead of **Sat Cut-Off**. Requires **Photometric estimate** |
| **Satellite Magnitude Limit** | 7.5 | Faintest estimated apparent magnitude to draw when **Limit by Magnitude** is on. Higher values include fainter satellites. The limit is independent of dot size, zoom and **Sat Brightness**; it does not limit separately enabled labels or arrows |
| **Starlink Design** | Unknown design (estimated mixture) | The Starlink version, if another source tells you: **Original V1.0**, **VisorSat**, **V1.5**, **V2 Mini** or **V2 Mini Direct to Cell**. **Per satellite (GCAT catalog)** uses each satellite's own version from the GCAT catalog (see below). **Unknown design** averages the first four. It does not work out a satellite's version |
| **Satellite Sunlight** | Finite Sun + atmosphere | Integrates the solar disk through a clear standard atmosphere at Earth's limb (the edge of the Earth, as seen from the satellite). **Finite Sun** omits atmosphere; **Legacy fade** uses the adjustable shadow depth |
| **Sat Brightness** | 2 | Scale factor for the brightness of the satellites in the look view. 0 is invisible. It does not change the main view |
| **Flare Brightness** | 0.2 | Scale factor for extra flare brightness in the Legacy cone calculation. 0 adds nothing |
| **Sat Cut-Off** | 0.06 | Cut-off in rendering scale units, not apparent magnitude. With **Photometric estimate**, the default hides each satellite that would be fainter than about magnitude 6.2 at 1000 km. Set 0 to draw every sunlit satellite above the horizon. **Limit by Magnitude** replaces this cut-off in the look view; the main view still uses it |
| **Flare Angle Spread** | 5 | A satellite counts as flaring when its off-specular angle is less than this many degrees. This sets **Sun Angle Arrows**, **Flare Lines**, **Label Flares Only** and the Legacy cone model. Photometric estimates include continuous light outside this angle |
| **Flare Model** | Geocentric Nadir | How "down" is found for the flat surface. **Geocentric Nadir** points at the Earth's center. **Geodetic Nadir** is perpendicular to the WGS84 ellipsoid. The two differ by at most about 0.18° |
| **Earth's Penumbra Depth** | 5000 | In Legacy fade mode, shadow depth in metres over which illumination fades |

**Flare Brightness** appears only with **Legacy cone**, **Starlink Design** only with **Photometric
estimate**, and **Earth's Penumbra Depth** only with **Legacy fade**.

The brightness model sets what the look view and long exposures show. The main view always
draws satellites at the Legacy cone brightness, wherever they are, so it shows the whole
constellation and not only the satellites above the look camera's horizon.

### How Sitrec estimates brightness

These numbers are estimates, with an uncertainty of at least about 1 magnitude. Individual
design, attitude and flight state can change brightness by several magnitudes. A larger magnitude
is dimmer, and 5 magnitudes is a factor of 100. Phase is the angle at the satellite between the
Sun and the camera.

**Starlink.** The photometric model uses approximate digitizations of the fitted horizon-flare
curves in [Mallama and Cole (2024)](https://arxiv.org/abs/2405.13091), with explicit estimated
continuations outside their range of roughly 2–20° off-specular. The authors do not state a
correction for dimming near the Earth's shadow; applying the calculated sunlight fraction to
those curves is an assumption.

Away from a flare, each design has its own brightness. It is the design's published phase curve
(brightness against phase angle) at 90° phase, with a Lambert phase shape for other angles:

| Design | Magnitude at 1000 km, 90° phase | Source |
|---|---|---|
| Original V1.0 | 6.19 | [Mallama et al. (2022)](https://arxiv.org/abs/2210.17268), Table 1 |
| VisorSat | 7.64 | the same table |
| V1.5 | 6.84 | the same table ("Post-VisorSat") |
| V2 Mini | 7.50 | [Mallama et al. (2024)](https://arxiv.org/abs/2401.01546), Table 1, after brightness mitigation |
| V2 Mini Direct to Cell | 6.88 | [Mallama et al. (2025)](https://arxiv.org/abs/2502.03651), Table 1, observed after 2024 June 30 |
| Unknown design | 6.88 | the average light of the first four |

No horizon-flare curve is published for Direct to Cell satellites, so Sitrec uses the V2 Mini
curve for them. That is an assumption.

**Per satellite (GCAT catalog).** The [GCAT catalog](https://planet4589.org/space/gcat) by
Jonathan McDowell lists the bus of each Starlink: V2 Mini, V2 Mini Optimized, V2 Mini Direct to
Cell, or the earlier bus. For the earlier bus, the payload name gives V1.0 launches before L9 as
V1.0, and from L9 on as VisorSat (all satellites have had visors since that launch, said
[Mallama (2021)](https://arxiv.org/abs/2101.00374), and Starlink-1436 on L7 had one too), and the
"Group" launches that followed as V1.5. No measurements are published for V2 Mini Optimized
satellites under that name, so they use the V2 Mini values. A Starlink that GCAT does not list,
or lists as V0.9 or a test flight, uses the unknown design. Starlinks launched after the
catalog in Sitrec was made are also unknown.

**Kuiper.** Kuiper (Amazon Leo) satellites, named `KUIPER-` in the catalog, also flare in this
model, but as an estimate. No horizon-flare curve is published for them.
[Mallama et al. (2026)](https://arxiv.org/abs/2601.07708) report a partly mirror-faced nadir
panel and reflective characteristics similar to Version 1 Starlink spacecraft, so Sitrec uses
the V1.0 curve, whatever **Starlink Design** is set to. The curve is not scaled for panel size.
It assumes the operational attitude, which is not the attitude during orbit raising. The
diffuse reference is magnitude 7.1 at 1000 km and 90° phase, read from that paper's Figure 8.
These satellites are in the **Other Satellites** category.

**The ISS.** The ISS retains an estimated magnitude −2 reference at 1000 km and 90° phase, with
range and phase scaling.

**All other satellites** use a generic estimate: a Lambert sphere with a diffuse reflectance of
0.2 and the satellite's mean projected area (the average area of its shadow, seen from all
directions). Orbital records do not give attitude, so this average is used. The area comes from
the satellite's size in the GCAT catalog:

- The body is a cylinder of the listed length and diameter, a box when GCAT calls the shape a
  box, or a sphere when it calls it a sphere.
- When GCAT lists solar panels, they add one flat panel of (span − diameter) × diameter.
- The mean projected area is a quarter of the total surface, with both faces of the panels
  counted (Cauchy's formula for a convex body).

For example, a 11.1 m by 3.9 m Zenit-2 second stage gets 40 m², which gives a standard magnitude
of about 3.9. When GCAT has no size (most debris), the Space-Track radar size gives the area:
0.03 m² for small, 0.3 m² for medium and 3 m² for large. With neither, the area is 1 m². These
areas can be wrong by a factor of 2 or more, and the reflectance is assumed, so the result is
only a rough guide.

**Sunlight.** The sunlight model follows the finite solar disk, limb darkening, atmospheric
transmission and refraction described by [Mallama (2021)](https://arxiv.org/abs/2112.08310). It
uses a smooth clear atmosphere; local weather and terrain at the remote limb are unknown.
This sunlight path is separate from the atmosphere between the satellite and the camera.

**Display and exposure.** The look view uses the calculated brightness as a display aid.
With **HDR Point Sources** on, [long exposures](LongExposure.md) add up the estimated flux (the
light received) on the same scale as the stars. Display brightness and cut-off sliders do not
calibrate a photograph's camera response. The Starlink Flare Predictor (**Sitrec → Extra Tools**) keeps a geometric cone test. Its
event counts do not predict the number of detectable trails in a photograph. It estimates the
peak magnitude of each flare with this model, for an unknown design.

---

## Arrows, lines and labels

**Sun Angle Arrows**, **Flare Band**, and **Flare Region** are at the top level.
Other arrows and lines are in **Satellites → Tracks & Guides**; labels are in **Satellites → Labels**.

In custom sitches, **Look towards flare region** aims the look camera once at the calculated
550 km reflection region, even if the region marker is hidden. It selects Manual heading and
absolute azimuth/elevation. The **Flare Band** is a guide to observing locations on Earth;
the **Flare Region** is a target in the sky. Aiming at it does not establish that flares are
visible: the region calculation has the limits stated below.

| Control | Default | What it does |
|---|---|---|
| **Sun Angle Arrows** | Off | When a flare is found, draws arrows in the main view from the camera to the satellite and from the satellite to the Sun |
| **Satellite Arrows** | Off | Arrows showing the direction each satellite is moving |
| **Flare Lines** | Off | A yellow arrow, 100 km long, on each flaring satellite, along its direction of travel. For lines to the camera and the Sun, use **Sun Angle Arrows** |
| **Satellite Ground Arrows** | Off | Arrows from each satellite down to the ground below it |
| **Flare Region** | Off | Independent M/L switches show the region in Main and Look. The region is where satellite flares are visible from the look camera. It assumes Starlink geometry: a flat surface that faces the Earth, at one altitude of 550 km. It does not check the Flare Band and marks the best match even when no reflection is close, so it is valid only when the camera is inside the Flare Band |
| **Flare Band** | Off | A fixed guide: two circles about 38° (green) and 62° (yellow) from the point opposite the Sun, between which horizon flares can be seen. It is not computed from the loaded satellites. See [Flare Band and Sun Angle Arrows](Starlink.md#flare-band-and-sun-angle-arrows) |
| **Labels — M / L** | Off | Name labels in Main and Look, independently. The switches sit on the Labels folder header |
| **Label Flares Only** | Off | Label only satellites that are flaring |
| **Label Lit Only** | Off | Label only satellites that are in sunlight |
| **Label Look Visible Only** | Off | In the main view, label only satellites inside the look camera's field of view. **Satellite Labels (Look View)** must also be on, or no main view label appears |
| **Max Labels Displayed** | 1000 | The largest number of satellite labels drawn at one time (100 to 10,000) |
| **Display Range (km)** | 100000 | Satellites farther away than this get no name labels or arrows |

Labels shorten Starlink names, so STARLINK-1234 is labeled SL-1234.

The Flare Band and Sun Angle Arrows are explained with pictures in
[Flare Band and Sun Angle Arrows](Starlink.md#flare-band-and-sun-angle-arrows).

**Show → Celestial → Labels → Name Filter** further limits which labels are drawn, for satellites and for
stars and planets. It takes a comma-separated list, for example `ISS, SL-1234`. Leave it empty
to label everything.

**Right-click a satellite** in a 3D view to see its name and catalog number. In a custom sitch,
this menu also has **Sat Track 1** and **Sat Track 2**, which set **Satellite to Track** (below)
to that satellite.

---

## Satellite to Track

**Satellites → Tracks & Guides → Satellite to Track / Satellite to Track 2**

In a custom sitch, these two text fields each turn one satellite's orbit into a track for the
whole sitch, named **Satellite** and **Satellite 2**. Type a name or a catalog number. The start
of a name is enough, for example `ISS`. The default is the ISS (catalog number 25544).

If the satellite is not in the loaded TLE data, the field shows *… not found*. The track is
calculated again when new TLE data is loaded.

Each satellite track has a **Show in look view** checkbox, off by default, in its folder in the
Contents menu, as other tracks do. The folders are named **satelliteDisplayTrack** and
**satelliteDisplayTrack2**, and they appear when the satellite is in the loaded data. The look
view's **Show Tracks** button and **Show → All Tracks in Look** include the satellite tracks too.

---

## Satellite views in the Show menu

**Show → Celestial** and **Show → Celestial → Extra Celestial Views → Star Chart**

### Satellite Ephemeris

**Show → Celestial → Extra Celestial Views → Satellite Ephemeris** opens a table of the satellites above the look
camera's horizon. It appears in the menu after TLE data is loaded. It lists up to 100 of the
satellites that are shown, highest first:

| Column | Meaning |
|---|---|
| **Name** | The satellite name |
| **Az** / **El** | Azimuth and elevation, in degrees, from the look camera |
| **Range** | Distance from the camera, in km |
| **Alt** | Altitude, in km |
| **Vis** | **VIS**: sunlit, with the observer in darkness (Sun more than 6° below the horizon). **DAY**: sunlit, but the observer's sky is too bright. **ECL**: in the Earth's shadow |
| **Next Event** | The time until the satellite sets (**LOS**, loss of signal), searching up to two hours ahead. **>2h** means that it stays up longer |

The **Only VIS** checkbox, on by default, limits the table to satellites in the VIS state.

### Sky Plot

**Show → Celestial → Extra Celestial Views → Sky Plot** draws the same satellites as the Satellite Ephemeris table on a
circular map of the sky. The center is straight up (the zenith) and the edge is the horizon,
with rings at 30° and 60° elevation. Like a map, it has north at the top and east on the right,
so it is the mirror image of the [Star Chart](#star-chart). It follows the ephemeris table's
**Only VIS** setting. Each green dot is a satellite, with its name beside it.

![Two windows side by side. On the left, the Ephemeris table lists 13 Starlink satellites, highest first, with Only VIS unchecked. On the right, the Sky Plot shows the same 13 satellites as green dots on a circular green grid, with rings labeled 30° and 60°, 90° at the center and north at the top](docimages/satellites-ephemeris-sky-plot.jpg)

The **Ephemeris** window and the **Sky Plot** window at the same moment, with a small sample of
Starlink data. **Only VIS** is off, so the table has VIS and ECL rows. The first row,
STARLINK-4489, has the highest **El**, 53.6, so it is the dot nearest the center.

### Star Chart

**Show → Celestial → Extra Celestial Views → Star Chart** has a whole-sky chart of stars, constellations, the planets, the Sun and
the Moon, for the current time and look camera location, in the style of a printed sky chart.

| Control | Default | What it does |
|---|---|---|
| **Show Star Chart** (title checkbox) | Off | Shows or hides the chart |
| **Color Scheme** | White | **Lavender**, **Black**, **Night Vision** or **White** |
| **Star Magnitude Limit** | 5.5 | Faintest star included in this chart, independent of the 3D view; larger magnitudes include fainter stars |
| **Satellite Track** | On | Draws the path of **Satellite to Track** across the chart, with times |

Like a paper star chart, it shows the sky as seen looking up, so east is on the **left**.

![The Star Chart window: a white disk with black star dots, gray constellation lines and names, and the planets Venus, Mars and Mercury labeled, with the Mercury label cut off at the rim. North is at the top and east is on the left. A straight black line crosses the disk from the southwest to the northeast, with boxed times from 20:06 to 20:14 and an arrowhead at the northeast end](docimages/satellites-star-chart.jpg)

The **Star Chart** in the **White** color scheme. **Satellite to Track** is a Starlink satellite
that passes nearly overhead, and the black line is its path over the whole sitch. Each box gives
the local time at that point on the path, here from 20:06 to 20:14. The arrowhead shows the
direction of travel. A larger black dot is a brighter star. A label that reaches the rim of the
disk is cut off, as Mercury and Corona Borealis are here. The numbers around the edge are
azimuth, in degrees.

### Other celestial items

The rest of **Show → Celestial** is about the stars, the planets and the Earth's shadow:
direction vectors to the Sun, Moon and planets, **Equatorial Grid in Main** and **Equatorial Grid
in Look**, **Constellation Lines**, **Asterism Style**, **Render Stars and Planets**, **Show Earth's Shadow**
and **Show Moon's Shadow**. The Earth's shadow is useful with satellites: it shows the region of
space where satellites are in darkness.

The brightness of the stars and planets is set in **Show → Celestial → Stars and Planets** (**Star Brightness**, **Star
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
  main view, and the date range shows in **Satellites → TLEs From** and **TLEs To**.
- Check **Show Satellites (Global)** and the category switches. A satellite that is in no
  category needs **Other Satellites**.
- Check **Sat Brightness** is not 0. If the look view shows few satellites, lower **Sat Cut-Off**:
  at the default, most satellites do not pass it there. Set it to 0 to draw every sunlit satellite.
  If **Limit by Magnitude** is on, increase **Satellite Magnitude Limit** instead.
- Check that no TLE filter is active: use **Clear TLE Filter**.
- Check the time of day. With **Photometric estimate**, the look view does not draw a satellite
  in the Earth's shadow, though the main view still draws it, dimly. Satellites also fade in the
  look view as the sky brightens at the camera, and in daylight they are nearly invisible or gone.

### Too many satellites to see what is going on

Use **Filter TLEs** with **Crosses View Frustum** and **Not Hidden by Earth** to keep only the
satellites the look camera can see. **Apply** keeps the satellites in view at that moment, so
leave the window open while the time or the camera changes. To label just those satellites in
the main view, also turn on both **Satellite Labels** switches and **Label Look Visible Only**.

### Find which satellite made a flare

Turn on **Satellite Labels (Look View)** or **Satellite Labels (Main View)**, then **Label Flares
Only**. Turn on **Sun Angle Arrows** to see the lines to the camera and the Sun in the main view.
Then step through the frames around the flare. Right-click a satellite for its catalog number.
The full procedure is in [Investigating Starlink Flares With Sitrec](Starlink.md).

---

## See also

- [Investigating Starlink Flares With Sitrec](Starlink.md): a step-by-step guide to horizon flares
- [Long Exposure/Stacking](LongExposure.md): star trails and satellite streaks
- [Historic Skies](HistoricSkies.md): the sky for dates before the space age
- [The Lighting Menu](Lighting.md): the sun, ambient light and night scenes
- [User Interface](UserInterface.md)
