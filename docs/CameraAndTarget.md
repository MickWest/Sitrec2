# The Camera and Target Menus

**Camera** and **Target** (menu bar)

The **Camera** menu controls the look camera: the camera that draws the look view, which
is the view you match against your video. The **Target** menu controls an optional target:
a point or a track that the camera can aim at.

This page is a reference for every control in both menus in a custom sitch. For a first
walk-through, read [Getting Started](CustomSitchTool.md) first.

This page has five parts:

- **A. [How the camera is defined](#a-how-the-camera-is-defined)**: position, heading and field of view
- **B. [The Camera menu, folder by folder](#b-the-camera-menu-folder-by-folder)**
- **C. [The Target menu](#c-the-target-menu)**
- **D. [Recipes](#d-recipes)**
- **E. [See also](#e-see-also)**

---

## A. How the camera is defined

The look camera has three independent parts. Each part has its own folder in the Camera
menu, and each folder starts with a **source** selector: a drop-down that says what drives
that part.

| Part | Folder | Source selector | What it says |
|---|---|---|---|
| Position | **Camera → Location** | **Position** | Where the camera is |
| Heading | **Camera → Heading** | **Camera Heading** | Which way the camera points |
| Field of view | **Camera → FOV (Zoom)** | **Camera FOV** | How much of the scene the camera sees |

The manual controls under each selector (Lat/Lon/Alt, Pan/Tilt, VFOV and so on) only
drive the camera when the source is **Manual**. When another source drives that part, the
manual controls are greyed out but stay visible. Some of them then show the values that
the source is producing. Choose **Manual** again and the camera stays where the other
source left it.

### Position sources (Camera → Location → Position)

| Choice | What it does |
|---|---|
| **Manual** | The camera stays at the fixed point in **Cam [C] Lat / Lon / Alt**. This is the default in a new sitch. |
| **Flight Sim** | The camera flies a simple simulated aircraft path. The path starts at the Manual position and is controlled from **Physics → Simple Flight Sim**. See [Flight Sim](#flight-sim). |
| **Orbit** | The camera circles a chosen track or point at a set radius, altitude and period. The settings are in **Camera → Camera Tweaks**. See [Orbit](#orbit). |
| *An imported track* | Each track you import is added to this list. The first track you import is selected as the camera position. |

Holding **C** with the pointer over a 3D view moves the Manual camera position to the
point under the pointer. If the Position was following an imported track, this switches
it back to **Manual**. **Shift+C** also puts the camera 7 ft above the ground.

### Heading sources (Camera → Heading → Camera Heading)

| Choice | What it does |
|---|---|
| **Manual** | You aim the camera with **Pan (Az)**, **Tilt (El)** and **Roll**. This is the default. Pan 0 is north and Tilt 0 is level, unless **Relative Heading** is on. |
| **To Target** | The camera points at the target, which is set in the [Target menu](#c-the-target-menu). **Roll** still applies. When you import a second track, Sitrec selects **To Target** for you. |
| **Celestial Lock** | The camera follows a sky object, chosen in the **Celestial Object** box that appears under the selector. See [Long Exposure](LongExposure.md). |
| **Horizon Flare Region** | The camera points toward the Sun's azimuth, just above the horizon, where Starlink horizon flares appear. See [Long Exposure](LongExposure.md). |
| **Custom Az/El** | The camera follows azimuth and elevation columns from a CSV file. This choice appears only after you import a file with `az` or `el` columns. See [Camera Angle Tracks in Tracks](Tracks.md). |
| *A track with angles* | A track that carries its own pointing angles (a MISB file, for example) adds its own choice. |
| **Star Track** | Appears after the Star Tracker syncs the camera to a solved star field. See [Star Tracker](StarTracker.md). |

**Pan (Az)**, **Tilt (El)**, **Relative Heading**, **Satellite Mode** and **Rotation** only
work when **Camera Heading** is **Manual**. They are greyed out for every other source.
**Roll** works for **Manual** and **To Target**, and is greyed out for the others.

### Field of view sources (Camera → FOV (Zoom) → Camera FOV)

| Choice | What it does |
|---|---|
| **Manual** | The field of view comes from **VFOV (deg)** (or HFOV, or 35mm Equiv, which edit the same value). This is the default. |
| **FOV Editor** | The field of view comes from the FOV Editor curve (field of view against frame). Open the editor from **Show → Views → FOV Editor**. |
| *A track or file with FOV* | An imported file with an `fov` or `zoom` column, or a track that carries a field of view, adds its own choice. An `fov` or `zoom` column is selected as soon as it loads. |
| **Star Track** | Appears after the Star Tracker syncs the camera. |

Sitrec stores only the **vertical** field of view. The horizontal field of view and the
35mm equivalent are the same angle, read through the aspect ratio of the frame. See
[FOV (Zoom)](#camera--fov-zoom).

### Other camera modes, in short

- **Satellite Mode** (**Camera → Heading**) gives screen-space camera movement that works
  better when the camera looks almost straight up or down, for example at a satellite
  overhead. It hides Pan, Tilt and Roll, and shows **Rotation** instead. It only works
  when **Camera Heading** is **Manual**. See [Camera View Modes](satcam.md).
- **Fisheye** (**Camera → FOV (Zoom) → Fisheye**) renders the look view through a real
  fisheye lens curve, for all-sky and meteor cameras and fields of view of 180° or more.
  See [Fisheye (Allsky) Projection](Fisheye.md).
- **Panoramic Camera** (**Camera → FOV (Zoom) → Panoramic Camera**) renders a swept
  panorama up to 360° wide. See [Panoramic Camera](PanoramicCamera.md).

When Fisheye or Panoramic Camera is on, the normal FOV controls are hidden, because the
lens mode replaces them. Fisheye and Panoramic Camera cannot both be on.

---

## B. The Camera menu, folder by folder

The defaults below are for a new custom sitch. Loading a track, video or photo can change
them.

### Camera → Location

| Control | Default | What it does |
|---|---|---|
| **Position** | Manual | The position source. See [Position sources](#position-sources-camera--location--position). |
| **Cam [C] Lat** | 31.980814 | Latitude of the Manual position, in degrees. You can paste a full "lat, lon" pair in any format (decimal, degrees-minutes-seconds, N/S/E/W, MGRS, or ECEF x,y,z in meters). It fills both boxes. |
| **Cam [C] Lon** | -118.428486 | Longitude of the Manual position, in degrees. |
| **Cam [C] Alt** | 10,000 m | Altitude of the Manual position, above mean sea level. The label shows the current unit. |
| **Above Ground Level** | Off | When on, **Cam [C] Alt** is a height above the ground under the camera, not above sea level. |
| **Lookup** | (empty) | Type a place name or coordinates and press Enter. The camera moves there. For a place name, the altitude is set to the ground height at that place. |
| **Geolocate from browser** | — | Sets the position from your browser's location. |
| **Go To the above position** | — | Moves the terrain and the main view to the entered position. It does not move the look camera. It is always available, whatever the Position source. |
| **Use Relative Altitude (N m)** | Hidden | Appears when you import a photo that records its height above takeoff (usually a drone photo). It puts the camera at the ground height under it plus that recorded height, instead of the absolute altitude in the photo. The absolute altitude in a drone photo can be less accurate than the relative height. |

The Lat, Lon, Alt, Above Ground Level, Lookup and Geolocate controls only work when
**Position** is **Manual**.

#### Flight Sim

Choose **Position → Flight Sim** to put the camera on a simulated aircraft. The aircraft
starts at the Manual position (**Cam [C] Lat/Lon/Alt**) and flies at the settings in
**Physics → Simple Flight Sim**: **TAS** (true airspeed, knots, default 500), **Jet
Heading**, **Turn Rate**, **Turn Rate Source**, **Leg Length** (seconds of straight
flight between 180° turns; 0 turns this off), **Transition Time**, **Climb Rate**
(feet per minute) and **Manual Bank**. The local wind (**Physics → Wind**) blows the
aircraft along.

**Roll View with Bank** (also in **Physics → Simple Flight Sim**, default off) rolls the
look camera by the bank angle of the camera track, so the horizon tilts as a pilot would
see it. The bank angle is calculated from how the camera track turns, assuming a
coordinated turn.

#### Orbit

Choose **Position → Orbit** to fly the camera in a circle. The circle is set in
**Camera → Camera Tweaks** (see [below](#camera--camera-tweaks)). Orbit only moves the
camera. To keep it looking at the center, also set **Camera Heading** to **To Target**
and point the target at the same place.

### Camera → Heading

| Control | Default | What it does |
|---|---|---|
| **Camera Heading** | Manual | The heading source. See [Heading sources](#heading-sources-camera--heading--camera-heading). |
| **Pan (Az)** | 0 | Azimuth in degrees. 0 is north, 90 is east. Manual only. |
| **Tilt (El)** | 0 | Elevation in degrees, from -89 to 89. Positive is up. Manual only. |
| **Roll** | 0 | Roll around the view axis, in degrees. Manual and To Target only. |
| **Relative Heading** | Off | When on, Pan is measured from the direction the camera track is moving, not from north. Pan 0 then looks forward along the track, and -90 looks left. Only the heading is relative; Tilt is still measured from level. Manual only. |
| **Satellite Mode** | Off | Screen-space camera movement for high and low elevation angles. See [Camera View Modes](satcam.md). Manual only. |
| **Rotation** | 0 | Screen-space rotation around the view axis. Shown only in Satellite Mode. Manual only. |
| **Use 0-360 for Pan** | Off | Shows Pan as a 0 to 360 compass bearing instead of -180 to 180. It changes only how the angle is written, not where the camera points. Typing a value above 180 into Pan ticks it for you. |
| **Celestial Object** | Moon | The sky object to follow. Shown only when **Camera Heading** is **Celestial Lock**. |
| **Render Camera Use Traverse Track** | Off | Aims the look view at the traverse object (the yellow cube) for display only. The lines of sight, and every traverse solution, still come from the selected Camera Heading, exactly as if this were off. |
| **Roll From MX-Style Camera** | Off | Rolls the look camera as an azimuth-elevation ball turret (WESCAM MX style) would. The roll combines the aircraft's bank and pitch, taken from the camera track, with where the turret is pointing. Unlike a roll-nod pod, such a turret adds no roll in level flight. It works with every heading source, because it changes only the roll. |
| **MX Roll Amount** | 1 | How much of that roll to apply. 1 is an unstabilized two-axis turret. 0 is a fully roll-stabilized turret with a level horizon. Real turrets can be partly stabilized, so set this by matching the horizon tilt in the video. |

If both **Roll From MX-Style Camera** and **Roll View with Bank** are on, the MX-style roll
wins, because it is applied last.

### Camera → FOV (Zoom)

| Control | Default | What it does |
|---|---|---|
| **Export for FOV Editor** | — | Samples the current FOV source on every frame and saves it as a `.fov.json` file of keyframes. Drop that file on Sitrec to load it into the FOV Editor. See [Tracks](Tracks.md). |
| **Camera FOV** | Manual | The FOV source. See [Field of view sources](#field-of-view-sources-camera--fov-zoom--camera-fov). |
| **VFOV (deg)** | 30 | Vertical field of view, across the full height of the frame. This is the value the camera stores. |
| **HFOV (deg)** | from VFOV | Horizontal field of view, across the full width of the frame. It is VFOV read through the **Aspect Ratio**. Editing it sets VFOV to match. |
| **35mm Equiv (mm)** | from VFOV | The lens that would give this field of view on a 36×24 mm full-frame camera, measured across the long side of the frame. Editing it sets HFOV and VFOV to match. The slider range grows when you push past its right end. |
| **Lens (EXIF)** | Hidden | Read only. The real focal length and lens recorded in an imported photo's EXIF data. This is the true focal length on that camera's sensor, not the 35mm equivalent. On a smaller sensor, the 35mm Equiv above is the larger number. |
| **Aspect Ratio** | from the view | Read only. Width divided by height of the frame that VFOV and HFOV refer to. With a video loaded, it is the video's own pixel dimensions. Otherwise it follows the look view pane, unless **Lock Aspect** is on. |
| **Lock Aspect** | Off | Holds the aspect ratio fixed, so HFOV does not change when you resize the window. Ticking it does not move the camera. While a video is loaded it is always on and cannot be changed, because the video defines the frame. |
| **Fisheye** (folder) | Off | See [Fisheye (Allsky) Projection](Fisheye.md). |
| **Panoramic Camera** (folder) | Off | See [Panoramic Camera](PanoramicCamera.md). |

VFOV, HFOV and 35mm Equiv only work when **Camera FOV** is **Manual**.

**Lock Aspect** is not the same as **Match Video Aspect** (below). Lock Aspect changes what
the FOV numbers mean. Match Video Aspect changes how the look view is drawn.

### Camera → Lens

Hidden until the Star Tracker has fitted a lens. It then shows the fitted lens model. See
[Star Tracker](StarTracker.md).

### Camera → Camera Tweaks

Less common adjustments.

| Control | Default | What it does |
|---|---|---|
| **Free Look Camera** | Off | Fly the look camera by hand, like the main view camera. While it is on, the Location and Heading sources are suspended, but the field of view is not. Where you fly to is written into the Manual position, so turning it off keeps the camera there. Touching a control in Location or Heading turns it off. See [User Interface](UserInterface.md). |
| **Switch to Ground Track at** | 0 | 0 turns this off. At any other frame, Sitrec finds where the camera's center line meets the ground at that frame, and aims at that ground point for every later frame. |
| **Look View Orthographic** | Off | Draws the look view with a parallel (orthographic) projection instead of perspective. The size matches the current framing at the ground and scales as the camera moves. |
| **Main View Orthographic** | Off | The same, for the main view. |
| **Main Near Plane (m)** | 1 | Near clipping distance of the main view camera. Increase it to slice through buildings or terrain in front of the camera. Useful in orthographic mode. |
| **Look Y-comp** | 1 | Stretches the look view's frustum vertically, to fit more into the same height. This distorts the view. 1 is off. |
| **xOffset**, **yOffset** | 0 | Shift the look camera off-center, horizontally or vertically. Useful when the tracked object is not at the center of the video frame. |
| **Near Plane (m)** | 0.1 | Near clipping distance of the look camera. Sometimes useful for very close objects, or to cut out near objects. |
| **Diffraction Glare** (folder) | — | Adds glare from an imported point spread function. See [Diffraction Glare](DiffractionGlare.md). |
| **Orbit Target** | fixedCamera | What the Orbit position circles. **fixedCamera** is the Manual camera position (**Cam [C] Lat/Lon**). Imported tracks are added to the list. |
| **Orbit Radius (m)** | 5000 | Radius of the circle, in meters. |
| **Orbit Altitude (m)** | 1000 | Altitude of the camera while orbiting, in meters above the WGS84 ellipsoid (HAE). This is not sea level; the two differ by the local geoid offset, up to about 100 m. |
| **Start Angle (°)** | 0 | Compass bearing from the center to the camera at frame 0. 0 is north, 90 is east. |
| **Orbit Period (s)** | 120 | Seconds for one full circle, from 60 to 300. The camera moves clockwise as seen from above. |

The orbit settings only have an effect when **Camera → Location → Position** is **Orbit**.
The Orbit Radius, Altitude and Period controls always use meters and seconds, whatever
your unit setting.

### Camera → Smoothing

Smoothing for the camera position track (whatever the **Position** source is). It is
closed by default.

| Control | Default | What it does |
|---|---|---|
| **Smoothing Method** | savgol | none, moving, movingPolyEdge, sliding, savgol or spline. See [Smoothing and Interpolation in Tracks](Tracks.md). |
| **Camera Smooth Window** | 20 | Window size, in frames. Larger is smoother. |
| **Camera SavGol Poly Order** | 3 | Polynomial degree for savgol and spline. |
| **Camera Edge Fit Order** | 2 | Polynomial order of the fit at the ends of the track. |
| **Camera Edge Fit Window** | 100 | Window size of the fit at the ends of the track. |
| **Camera Catmull Tension**, **Camera Catmull Intervals** | 0.5, 20 | Spline settings. Shown only for the methods that use them. |

Only the controls that the selected method uses are shown. Smoothing a noisy track makes
the camera move smoothly, but it also changes the data. Use it only with noisy data.

### Camera → Tracking Wobble

Simulates a person keeping the camera on the target by hand. The aim drifts off center,
and when the drift passes **Amplitude**, the operator reacts and moves the camera back
toward center, not perfectly. It is added on top of the selected Camera Heading. The
wobble is repeatable: the same seed always gives the same pattern.

| Control | Default | What it does |
|---|---|---|
| **Tracking Wobble** | Off | Turns the simulation on. |
| **Amplitude (deg)** | 0.5 | How far off center the aim drifts before the operator reacts. |
| **Drift Speed (deg/s)** | 0.3 | Random drift rate away from the target. |
| **Reaction Time (s)** | 0.4 | Delay between noticing the drift and starting the correction. |
| **Recenter Speed (deg/s)** | 2 | How fast the operator moves the camera back. |
| **Recenter Accuracy** | 0.7 | 1 stops the correction exactly on center. Lower values leave some error. |
| **Random Seed** | 1 | Change it for a different, but still repeatable, pattern. |

### Other items in the Camera menu

| Control | Default | What it does |
|---|---|---|
| **Export Camera as KML (Photo)** | — | Saves the look camera as a Google Earth PhotoOverlay (`.kmz`), with the current video frame as the photo. Open it in Google Earth Pro to check Sitrec's camera against Google's terrain, imagery and 3D buildings. If the sitch has a traverse, its path is included as a yellow line. With no video frame, it saves a plain `.kml` with only the camera viewpoint. |
| **Match Video Aspect** | Off | Crops the look view to the video's aspect ratio, and adjusts the camera frustum to match. |
| **MQ9 Tracking** (folder) | — | Simulates an operator acquiring and tracking a scene object. See [MQ9 Tracking Simulation](MQ9TrackingSimulation.md). |
| **Fit Camera to Points** (folder) | — | Recovers an unknown camera position, heading and field of view from landmarks: points on the video that you match to places in the world. |
| **Help** (folder) | — | Links to the documentation for this menu. |

---

## C. The Target menu

The target is the point or track that **Camera Heading → To Target** aims at. It is also
used by the **Target Object** traverse method, and the target wind (**Physics → Wind**)
is measured at it.

| Control | Default | What it does |
|---|---|---|
| **Target [X] Lat** | 32.5 | Latitude of the fixed target, in degrees. Accepts a pasted "lat, lon" pair, like the camera's. |
| **Target [X] Lon** | -118.428486 | Longitude of the fixed target, in degrees. |
| **Target [X] Alt** | 5,000 m | Altitude of the fixed target, above mean sea level. The label shows the current unit. |
| **Above Ground Level** | Off | When on, **Target [X] Alt** is a height above the ground. |
| **Lookup** | (empty) | Type a place name or coordinates to move the fixed target there. |
| **Geolocate from browser** | — | Sets the fixed target from your browser's location. |
| **Go To the above position** | — | Moves the terrain and the main view to the target position. |
| **Target Track** | fixedTarget | What the target is. See the choices below. |
| **Stop At** | 0 | Appears once **Camera Heading** is **To Target**. After this frame, the camera keeps aiming at where the target was at this frame, even if the target track continues. Use it to simulate losing lock on a moving target. 0 turns it off. |

**Target Track** choices:

| Choice | What it does |
|---|---|
| **fixedTarget** | The target stays at **Target [X] Lat/Lon/Alt** for the whole sitch. |
| **fixedTarget + Wind** | The target starts at **Target [X] Lat/Lon/Alt** and drifts with the target wind (**Physics → Wind**). The target wind is 0 knots by default, so set a wind first. |
| *An imported track* | Each imported track is added here. The second track you import is selected as the target. |

Holding **X** with the pointer over a 3D view moves the fixed target to the point under the
pointer, and keeps its altitude. **Shift+X** puts it 7 ft above the ground. The Target
Lat/Lon/Alt only have an effect when **Target Track** is **fixedTarget** or **fixedTarget +
Wind**.

---

## D. Recipes

### Camera on a plane, looking at another plane

1. Import the camera aircraft's track (drag it in, or **File → Import File**). It becomes
   the camera **Position**.
2. Import the other aircraft's track. It becomes the **Target Track**, and **Camera
   Heading** changes to **To Target**. Sitrec also finds the closest approach of the two
   tracks and moves the start of the sitch there. See [Tracks](Tracks.md).
3. If the video shows a tilted horizon, try **Camera → Heading → Roll From MX-Style
   Camera** for a ball-turret camera, and adjust **MX Roll Amount** until the horizon
   matches. For a view from the cockpit, use **Roll View with Bank** in **Physics → Simple
   Flight Sim**.
4. If the camera shakes because the track is noisy, increase **Camera → Smoothing →
   Camera Smooth Window**.
5. To simulate the operator losing lock, set **Target → Stop At** to the frame where lock
   was lost.

### Camera on the ground at a known spot

1. Set **Camera → Location → Position** to **Manual**.
2. Type the address or coordinates into **Lookup** and press Enter. The camera moves
   there, at ground height. Or hold **Shift+C** with the pointer over the spot in the main
   view, to put the camera 7 ft above the ground there.
3. For a fixed height above the ground, tick **Above Ground Level** and set **Cam [C] Alt**
   to that height, for example 1.7 m for a standing person.
4. Aim the camera in one of two ways:
   - Leave **Camera Heading** on **Manual** and set **Pan (Az)** and **Tilt (El)**.
   - Or set **Target Track** to **fixedTarget**, hold **X** over the thing the camera looks
     at, and set **Camera Heading** to **To Target**.
5. Set the field of view with **VFOV (deg)**, or type the phone's or camera's 35mm
   equivalent focal length into **35mm Equiv (mm)**. With a video loaded, the aspect ratio
   comes from the video.

### Orbit around a point, for a presentation

1. Put the center of the orbit somewhere the camera can circle:
   - To circle a fixed place, set **Position** to **Manual** and hold **C** over the place
     (or type it into **Lookup**). Leave **Camera Tweaks → Orbit Target** on
     **fixedCamera**.
   - To circle a moving object, choose its track in **Orbit Target**.
2. Point the target at the same place: hold **X** over it with **Target Track** on
   **fixedTarget**, or choose the same track in **Target Track**.
3. Set **Orbit Radius (m)**, **Orbit Altitude (m)**, **Start Angle (°)** and **Orbit
   Period (s)** in **Camera → Camera Tweaks**.
4. Set **Camera → Location → Position** to **Orbit**.
5. Set **Camera → Heading → Camera Heading** to **To Target**.
6. Press play. The camera circles clockwise (as seen from above) and keeps the center in
   view.

Remember that **Orbit Altitude (m)** is above the ellipsoid, not above sea level or the
ground. Near the center, check that the camera is not below the terrain.

---

## E. See also

- [Getting Started with Sitrec](CustomSitchTool.md): a first walk-through of Position,
  Heading, FOV and the target
- [Tracks](Tracks.md): importing camera and target tracks, Camera Angle Tracks
  (az/el/fov CSV files), smoothing methods and `.fov.json` files
- [Camera View Modes](satcam.md): Normal and Satellite Mode, and the 0-360 Pan setting
- [Fisheye (Allsky) Projection](Fisheye.md)
- [Panoramic Camera](PanoramicCamera.md)
- [Long Exposure](LongExposure.md): Celestial Lock and Horizon Flare Region
- [Diffraction Glare](DiffractionGlare.md): the Diffraction Glare folder in Camera Tweaks
- [MQ9 Tracking Simulation](MQ9TrackingSimulation.md): the MQ9 Tracking folder
- [Star Tracker](StarTracker.md): the Lens folder, and the Star Track heading and FOV
  sources
- [Keyboard Shortcuts](KeyboardShortcuts.md): C and X, WASD walking, and PageUp/PageDown
  for camera height
- [User Interface](UserInterface.md): Free Look, and the look view's header menu
- [Wind](Wind.md): the local and target winds used by Flight Sim and fixedTarget + Wind
- [Ground Track](GroundTrack.md): lines of sight from points on the ground
