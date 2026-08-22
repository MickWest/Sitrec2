# Glossary

Sitrec's vocabulary, plus the acronyms that turn up in UAP source data. Terms are also defined
where they are first used in the other documents; this is the place to look them up out of
context.

---

## Sitrec

**Sitch** — one saved Sitrec scene: a place, a span of time, the tracks and video in it, and
all your settings. Short for "situation". A *custom* sitch is one you build yourself by
dragging data in; a *legacy* sitch is one built into the app in code.

**Traverse** — a guessed path for the object. A camera gives you a *direction*, not a
*distance*, so infinitely many paths fit any set of sightlines. A traverse picks one by adding
an assumption — constant altitude, constant speed, wind-blown, and so on. **It is a hypothesis,
not a measurement.** See [Traverse Methods](TraverseMethods.md).

**Line of sight (LOS)** — the straight ray from the camera through the object at one instant.
Drawn in red in the main view.

**Node** — one computation in Sitrec's internal graph. Nodes read other nodes and produce a
value per frame. You mostly do not need to think about them, but the term appears in error
messages and in the AI assistant's replies.

**Track** — a sequence of positions over time: an aircraft's flight path, a drone's log, a
generated path. Tracks can drive the camera, the target, or just be displayed.

**Start Time vs Now Time** — *Start Time* is when the video's first frame happened. *Now Time*
is the moment currently being displayed. Moving the frame slider changes Now Time; syncing a
video to the sky means adjusting Start Time until Now Time lines up with reality.

**In / Out (A-B range)** — the frame interval you are analysing, set with `I` and `O`. Every
global fit and the whole traverse analysis use only the frames inside it.

**Frustum** — the pyramid of space a camera can see. "Crosses frustum" means an object passed
through the camera's field of view.

**Moddable** — a sitch whose settings can be changed and saved. Custom sitches are moddable;
some legacy ones are not.

---

## Data formats and sources

**ADS-B** — Automatic Dependent Surveillance–Broadcast: the position signal that airliners
broadcast continuously. Flight-tracking sites record it, and you can usually export a track as
KML. This is how you find out whether a light was a plane. See
[Where to Get Flight Data](KMLDataSources.md).

**KML / KMZ** — Google Earth's file format for geographic data. KMZ is a zipped KML. The usual
way flight tracks leave a tracking website.

**MISB** — Motion Imagery Standards Board: the military standard for metadata recorded
alongside video — where the camera was, where it was pointing, and how far it was zoomed in.
If you have this, Sitrec can reconstruct the geometry directly rather than you guessing it.

**KLV** — Key-Length-Value: the binary container MISB metadata travels in, usually embedded
inside a `.ts` video file.

**FMV** — Full-Motion Video: footage from a military or police camera pod, generally with MISB
metadata attached.

**STANAG 4676** — a NATO standard for motion-imagery tracking data.

**TLE** — Two-Line Element set: the traditional text format describing a satellite's orbit.
Being retired because it cannot represent modern catalogue numbers.

**OMM** — Orbit Mean-Elements Message: the CCSDS replacement for TLE, which Sitrec prefers.

**SRT** — a subtitle file. DJI drones write their telemetry into one alongside the video, so
dragging in the `.srt` gives you the drone's track.

**Terrarium** — an elevation-tile encoding that packs a height into the red, green and blue
channels of a PNG. Sitrec's default terrain source.

---

## Angles and pointing

**Azimuth** — the compass direction you are looking, in degrees. 0 = north, 90 = east. Always
**true** north in Sitrec; there is no magnetic model.

**Elevation** — how far above the horizon, in degrees. 0 = level, 90 = straight up, negative =
below the horizon.

**Heading** — the compass direction something is moving or facing. Also true.

**Bearing** — the compass direction from one point to another. Also true.

**FOV (field of view)** — how wide an angle the camera sees. Zoomed in = small FOV. Getting
this right is what makes the simulated view line up with the footage, and it is a
multiplicative scale factor on every angle measured from a tracked pixel — so it deserves
measuring rather than guessing. See [Star Tracker](StarTracker.md).

**PTZ** — Pan, Tilt, Zoom: the three axes of a steerable camera. Sitrec's satellite camera
mode adds Roll as a fourth.

**Parallax** — the apparent shift of an object against its background when the *observer*
moves. It is the only thing that makes range observable from a camera. No parallax, no range.

**Boresight** — the camera's exact centre axis. A boresight line of sight is the only kind
that does not depend on the assumed field of view.

---

## Altitude and position

**LLA** — Latitude, Longitude, Altitude.

**ECEF** — Earth-Centred, Earth-Fixed: a Cartesian (x, y, z) system with its origin at the
Earth's centre, rotating with the Earth. Sitrec's internal world coordinates.

**ENU** — East, North, Up: the local directions at a point on the surface.

**HAE** — Height Above Ellipsoid: height above the smooth WGS84 mathematical Earth. What GPS
natively measures.

**MSL** — Mean Sea Level: height above the geoid. What a topographic map or an altimeter
shows. Also called *orthometric height* or *AMSL*.

**AGL** — Above Ground Level: height above the terrain directly below.

**Geoid** — the lumpy equipotential surface that mean sea level follows, driven by variations
in the Earth's gravity.

**Geoid undulation (N)** — how far the geoid sits above (+) or below (−) the ellipsoid at a
given point. `HAE = MSL + N`. In the continental US, N is between about −36 m and −7 m, so
confusing the two shifts a track by that much. See [GIS](GIS.md).

**WGS84** — the reference ellipsoid and datum used by GPS and by essentially all mapping.

**QNE** — the standard altimeter setting, 1013.25 hPa / 29.92 inHg. Pressure altitude,
uncorrected for local weather. This is what raw ADS-B barometric altitude is.

**QNH** — the local sea-level pressure setting, which makes an altimeter read approximately
true altitude above sea level.

**Flight Level (FL)** — a pressure surface, not a true altitude. FL350 is where the pressure
equals 35,000 ft in the standard atmosphere, which on a cold day is thousands of feet lower
than 35,000 ft geometrically.

**Pressure altitude** — altitude inferred from air pressure, and therefore wrong by however
much the real atmosphere differs from the standard one. See [GIS](GIS.md).

---

## Analysis

**Residual** — how far a fitted path misses the observed sightlines, on average. A small
residual means the model fits; it does **not** mean the range is right.

**Conditioning** — a measure of how well the geometry constrains the fit. Bad conditioning
means the answer is unconstrained regardless of how small the residual is.

**Collapse** — the failure mode where a constant-velocity fit puts the "object" a few metres
from the camera with a near-zero residual, because the geometry cannot tell it otherwise.

**Global fit** — a method that considers all frames at once, as opposed to a *sequential
traverse* that walks forward frame by frame.

**Executive verdict** — the one-line summary at the top of the traverse analysis. There are
five verdict codes (six wordings — *Insufficient* has two) and each licenses something
different. See [Reading the executive verdict](DefensibleAnalysis.md#7-reading-the-executive-verdict-without-over-reading-it)
and [Traverse Analysis](TraverseAnalysis.md#the-executive-verdict).

**Solution family** — the range of distances at which a given model can still explain the
sightlines. Reporting the family rather than a single number is usually the honest answer.

---

## See also

- [Getting Started](CustomSitchTool.md)
- [Doing Defensible Analysis](DefensibleAnalysis.md)
- [GIS, Geodesy and Altitude](GIS.md)
