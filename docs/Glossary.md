# Glossary

Sitrec's vocabulary, plus the acronyms that turn up in UAP source data. Terms are also defined
where they are first used in the other documents; this is the place to look them up out of
context.

---

## Sitrec

**Sitch** (short for *situation*) — one Sitrec scene: a place, a span of time, and the camera,
tracks, objects and video that recreate an event. You can save and share a sitch, but it is a
sitch before you save it. A *custom* sitch is one you build yourself by dragging data in; a
*legacy* sitch is one built into the app in code.

**Traverse** — a guessed path for the object. A camera gives you a *direction*, not a
*distance*, so infinitely many paths fit any set of sightlines. A traverse picks one by adding
an assumption — constant altitude, constant speed, wind-blown, and so on. **It is a hypothesis,
not a measurement.** See [Traverse Methods](TraverseMethods.md).

**Line of sight (LOS)** — also called a *sightline*: the straight ray from the camera at one
instant. With **LOS Source** on **Camera Center** (the default), it is the camera's centre axis,
so it passes through the object only when the object is at the centre of the frame. A tracked
source, such as **Camera + Point Track**, turns the ray toward the tracked object. A custom sitch
draws these lines in red in the main view.

**Main view / look view** — the two 3D views. The look view shows what the simulated camera
sees. The main view shows the scene from a separate camera that you move.

**Frame** — one step on a sitch's timeline, and one image if the sitch has a video. Sitrec does
its calculations one frame at a time. **FPS** (frames per second) sets how long a frame lasts. To
*scrub* is to drag through the frames, usually on the timeline in the playback bar at the bottom
of the screen.

**Node** — one computation in Sitrec's internal graph. Nodes read other nodes and produce a
value per frame. You mostly do not need to think about them, but the term appears in error
messages and in the AI assistant's replies.

**Track** — a sequence of positions over time: an aircraft's flight path, a drone's log, a
generated path. Tracks can drive the camera, the target, or just be displayed.

**Point Track** — the tool in the Video menu that follows an object through the video and
records its position on each frame. With **LOS Source** on **Camera + Point Track**, those
positions turn each line of sight toward the object. See [Point Tracking](PointTrack.md).

**Keyframe** — a frame where a tool stores a value that you set or that it measured. Some tools,
such as Ground Track and the Horizon Extractor, show theirs as yellow diamonds on the timeline,
and `<` and `>` stop at them.

**Timeline marker** — a named frame that you add with the timeline's right-click menu. It shows
as a cyan flag.

**Start Time vs Now Time** — *Start Time* is when the video's first frame happened. *Now Time*
is the moment currently being displayed. The Time menu shows them as `startTime` and `nowTime`.
Scrubbing on the timeline changes Now Time; syncing a video to the sky means adjusting Start Time
until Now Time lines up with reality. See [Time, Frames and Syncing](TimeAndSync.md).

**UTC** — Coordinated Universal Time: the reference clock, with no time zone or daylight saving.
`startTime` and `nowTime` are in UTC.

**Simulation Speed vs Playback Speed** — *Simulation Speed* is how many seconds of simulated time
pass in one second of frames: 30 for a 30× time-lapse. It does not change how fast the video
plays. *Playback Speed* is how fast the frames advance when you play. It does not change the time
of any frame.

**In and Out frames** — the first and last frames of the interval you are analysing, set with `I`
and `O`. Every global fit and the whole traverse analysis use only the frames in this **In/Out
range**. A-B in a label means the In/Out range.

**Frustum** — the pyramid of space a camera can see. The **Crosses Frustum** option in **Filter
Tracks** keeps a track if a sampled point on it lies inside the look camera's current frustum. It
does not check that the object was there at that moment.

**Moddable** — a sitch whose settings can be changed and saved. Custom sitches are moddable;
some legacy ones are not.

**DTLD** — Date, Time, Location, Direction: the four things you try to pin down for a piece of
footage. See [Getting Started](CustomSitchTool.md#the-four-things-you-need).

**UAP** — Unidentified Anomalous Phenomena: observations that remain unidentified. An older term
is UFO.

---

## Data formats and sources

**ADS-B** — Automatic Dependent Surveillance–Broadcast: the position signal that airliners
broadcast continuously. Flight-tracking sites record it, and you can usually export a track as
KML. Load an aircraft track to compare its position with a sighting. See
[KML Data Sources](KMLDataSources.md).

**KML / KMZ** — Google Earth's file format for geographic data. KMZ is a zipped KML. The usual
way flight tracks leave a tracking website.

**MISB** — Motion Imagery Standards Board: the body that publishes the military standards for
metadata recorded alongside video — where the camera was, where it was pointing, and how far it
was zoomed in. If you have this metadata, Sitrec can reconstruct the geometry directly rather than
you guessing it.

**KLV** — Key-Length-Value: the binary container MISB metadata travels in, usually embedded
inside a `.ts` video file.

**FMV** — Full-Motion Video: footage from a military or police camera pod, generally with MISB
metadata attached.

**STANAG 4676** — a NATO standard for intelligence, surveillance and reconnaissance track data.
Sitrec loads it as XML or as a CSV export.

**TLE** — Two-Line Element set: the traditional text format describing a satellite's orbit.
Being retired because it cannot represent modern catalogue numbers.

**OMM** — Orbit Mean-Elements Message: the CCSDS replacement for TLE, which Sitrec prefers.

**LEO** — Low Earth Orbit: an orbit less than about 2,000 km above the surface.

**SRT** — a subtitle file. DJI drones write their telemetry into one alongside the video, so
dragging in the `.srt` gives you the drone's track.

**DEM** — Digital Elevation Model: a grid of ground heights. **Elevation Type** in the Terrain
menu selects the source. See [Terrain and Elevation](Terrain.md).

**Terrarium** — an elevation-tile encoding that packs a height into the red, green and blue
channels of a PNG. Sitrec's default terrain source on the standard installation.

**Sounding** — one profile of wind, temperature and pressure against height, measured by a
radiosonde, the instrument that a weather balloon carries. See [Wind in Sitrec](Wind.md).

---

## Angles and pointing

**Azimuth** — the compass direction you are looking, in degrees. 0 = north, 90 = east. Always
**true** north in Sitrec; there is no magnetic model.

**Elevation** — how far above the horizon, in degrees. 0 = level, 90 = straight up, negative =
below the horizon. **Elevation Type** in the Terrain menu is different: it selects the source of
ground heights.

**Heading** — the compass direction something is moving or facing. Also true. **Camera Heading**
in the Camera menu is wider: it selects where the camera's whole pointing direction comes from,
including tilt.

**Bearing** — the compass direction from one point to another. Also true.

**FOV (field of view)** — how wide an angle the camera sees. Zoomed in = small FOV. Sitrec's
camera FOV is the vertical angle, across the height of the frame: **VFOV (deg)** in **Camera →
FOV (Zoom)**. For a horizontal value, use **HFOV (deg)** in the same folder, which sets VFOV
through the aspect ratio. Getting this right is what makes the simulated view line up with the
footage, and it scales every angle measured from a tracked pixel, almost in proportion at narrow
FOV. The Star Tracker can measure it from stars in the frame. See [Star Tracker](StarTracker.md).

**PTZ** — Pan, Tilt, Zoom: the three axes of a steerable camera. Sitrec's PTZ controls also
have Roll. **Satellite Mode** replaces Pan, Tilt and Roll with a single Rotation.

**Parallax** — the apparent shift of an object against its background when the *observer*
moves. Without parallax, the lines of sight alone do not fix the range. With parallax, the range
still depends on what you assume about how the object moves.

**Boresight** — the camera's exact centre axis. A boresight line of sight is the only kind
that does not depend on the assumed field of view.

---

## Altitude and position

**LLA** — Latitude, Longitude, Altitude.

**ECEF** — Earth-Centred, Earth-Fixed: a Cartesian (x, y, z) system with its origin at the
Earth's centre, rotating with the Earth. Sitrec's internal world coordinates.

**ENU** — East, North, Up: the local directions at a point on the surface.

**HAE** — Height Above Ellipsoid: height above the smooth WGS84 mathematical Earth. What GPS
natively measures. See [Three Kinds of Height](GIS.md#three-kinds-of-height).

**MSL** — Mean Sea Level: height above the geoid. What a topographic map shows. Also called
*orthometric height* or *AMSL*.

**AGL** — Above Ground Level: height above the terrain directly below.

**Geoid** — the lumpy equipotential surface that mean sea level follows, driven by variations
in the Earth's gravity.

**Geoid undulation (N)** — how far the geoid sits above (+) or below (−) the ellipsoid at a
given point. `HAE = MSL + N`. Over the contiguous US, N is negative everywhere, from about
−8 m (near Yellowstone) to about −40 m (the North Carolina coast); worldwide, EGM96 N is
between about −107 m and +85 m. Confusing MSL and HAE shifts a track by N. See
[GIS Concepts in Sitrec](GIS.md).

**WGS84** — the reference ellipsoid and datum used by GPS and by essentially all mapping.

**QNE** — the standard altimeter setting, 1013.25 hPa / 29.92 inHg. Pressure altitude,
uncorrected for local weather. This is what raw ADS-B barometric altitude is.

**QNH** — the local sea-level pressure setting, which makes an altimeter read approximately
true altitude above sea level.

**Flight Level (FL)** — a pressure surface, not a true altitude. FL350 is where the pressure
equals the standard-atmosphere pressure at 35,000 ft (about 238 hPa). On a cold day that surface
can be a thousand feet or more below 35,000 ft geometrically.

**Pressure altitude** — altitude inferred from air pressure, and therefore wrong by however
much the real atmosphere differs from the standard one. See
[Altitude in the file](KMLDataSources.md#altitude-in-the-file).

---

## Images and brightness

**EV (exposure value)** — a brightness step: +1 EV doubles the brightness. See
[Long Exposure/Stacking](LongExposure.md).

**HDR (high dynamic range)** — image data that keeps values brighter than white, instead of
clipping them to white.

**Magnitude** — the astronomical brightness scale. A lower number is brighter, and 5 magnitudes
is a factor of 100. See [How Sitrec estimates brightness](Satellites.md#how-sitrec-estimates-brightness).

**PSF (point spread function)** — the pattern that a camera makes from a single point of light,
because the optics spread the light. See [Diffraction Glare](DiffractionGlare.md).

**QP (quantization parameter)** — a number from 0 to 51 that sets how coarsely H.264, a video
compression format, rounds the image data of one block. A low QP keeps fine detail, and a high QP
discards it. See [Video QP Graph](VideoQPGraph.md).

**Flare** — a satellite flare: a sun glint from a satellite, when a flat surface on it reflects
sunlight toward the camera. See [Brightness and flares](Satellites.md#brightness-and-flares).

**Lens ghost** — an image formed by light that reflects off surfaces inside the camera's optics,
such as lens faces or a filter. See [Lens Ghost](LensGhost.md).

---

## Analysis

**Residual** — how far a fitted path misses the observed sightlines: the angle at the camera, in
degrees, averaged over the frames. A small residual means the model fits; it does **not** mean
the range is right.

**Conditioning** — a measure of how well the observations constrain a specified fit's
parameters. Poor conditioning makes that fit's answer sensitive or unreliable even with a
small residual; it does not show that every other target model fails.

**Constant velocity (CV)** — a target-motion model with one fixed velocity vector in world
coordinates: both target speed and direction stay constant. A steady straight climb is
allowed. The camera's known motion is a separate input.

**Constant acceleration (CA)** — a target-motion model with one fixed acceleration vector.
The target's velocity may change. A constant-speed circular turn is not CA because its
acceleration vector rotates.

**Jerk** — the rate of change of acceleration. Constant jerk gives a cubic target-position
model whose acceleration vector changes linearly with time.

**Dynamics order** — in the benchmark's conditioning diagnostic, a grade for the target
models whose checks pass, not a measurement of target or camera motion. Grades 1–3 refer
to CV, CA and constant jerk; 0 means the CV check failed. See
[the target-model ladder](TraverseConcepts.md#15-dynamics-order-which-target-motion-models-pass-the-check).

**Collapse** — the failure mode where a fit in the constant-velocity family (Constant Velocity,
Constant Acceleration, Kalman Smoother, Monte Carlo) puts the "object" on the camera: a few metres
away, or behind it. The camera's own path nearly satisfies the fit, so the geometry cannot rule
it out. See [CV-family conditioning](TraverseMethods.md#range-observability-and-collapse-cv-family-conditioning).

**Global fit** — a method in which every frame in the In/Out range helps determine every point of
the trajectory, as opposed to a *sequential traverse* that walks forward frame by frame from a
start distance. (The Kalman Smoother propagates state frame to frame internally, but its
all-frame seed and backward pass make it a global fit in this sense.)

**BOT** — Bearings-Only Traversal: recovering a traverse from pointing directions alone. See
[BOTBench](BOTBench.md).

**Executive verdict** — the strip above the traverse analysis gallery: a bold verdict, then a
short explanation. There are five verdict codes and eight wordings, and each has a different
meaning. See
[The executive verdict](TraverseAnalysis.md#the-executive-verdict).

**Solution family** — the range of distances at which a given model can still explain the
sightlines.

**Coryat curve** — the false turning path that appears in a solved track when the assumed
range is wrong: the observing platform's own manoeuvre, scaled by the range error and reversed
in sign when the guess is too far. See
[Does it fly the camera's path?](TraverseAnalysis.md#does-it-fly-the-cameras-path).

---

## See also

- [Getting Started](CustomSitchTool.md)
- [GIS Concepts in Sitrec](GIS.md)
