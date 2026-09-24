# Motion Analysis

**Video → Motion Analysis**

Motion Analysis measures how the whole picture moves from one frame to the next. When a camera
pans, tilts or flies over the ground, the background slides across the frame; Motion Analysis
measures that slide on every frame, as a direction and a speed in pixels per frame. From that
measurement it can draw the motion over the video, export it as a CSV file, stabilize the
video, build a ground track, and stitch the frames into a panorama.

This page has seven parts:

- **A. [What Motion Analysis measures](#a-what-motion-analysis-measures)**, and how it differs from Point Track
- **B. [Simple procedures](#b-simple-procedures)**
- **C. [The Motion Analysis controls](#c-the-motion-analysis-controls)**
- **D. [Panoramas](#d-panoramas)**
- **E. [De-Fence](#e-de-fence)**
- **F. [Related Video tools](#f-related-video-tools)**: Camera Motion (Background), Horizon Extractor, OSD Tracker and Text Extraction
- **G. [Masking, the In/Out range and performance](#g-masking-the-inout-range-and-performance)**

---

## A. What Motion Analysis measures

Motion Analysis finds many small features in the frame, follows them for a few frames, and
takes the motion that most of them agree on. That agreed motion is the **background motion**:
the way the scene moves in the frame. In most footage it comes from the camera moving or
turning, not from the scene itself.

For each frame it records:

- a **direction** and a **magnitude** (pixels per frame) of the background motion
- a **confidence**, from how well the features agree
- whether the frame is **good** (enough features and enough agreement) or **bad**

A bad frame keeps the last good value on screen and is marked *BAD FRAME* on the overlay.

### Motion Analysis, Point Track and "Motion (Background)"

These are different tools that answer different questions:

| Tool | Question it answers | Output |
|---|---|---|
| **Video → Motion Analysis** (this page) | How does the whole scene move in the frame? | Per-frame direction and speed, a CSV, a stabilized video, panoramas |
| **Video → Point Track** ([Point Tracking](PointTrack.md)) | Where is *this one object* on each frame? | A pixel position per frame, which becomes a line of sight |
| **Video → Camera Motion (Background)** ([below](#camera-motion-background)) | Where did the camera fly, judged from the moving ground? | A camera path in the 3D view |

**Motion (Background)** is the name of a *tracking method* inside Point Track. It also measures
how the background moves, but only to predict and subtract the background so that the object
shows up. It is its own code: it does not use the Motion Analysis results, and you do not need
to run Motion Analysis before you use it. If you want to follow an object, use Point Track.
Use Motion Analysis when you want the motion of the scene itself.

---

## B. Simple procedures

### See the motion

1. Load a video and open **Video → Motion Analysis**.
2. Press **Analyze Motion**. The first time, the button shows *Loading OpenCV...* while the
   image-processing library loads. The button then changes to **Stop Analysis**.
3. Play or scrub the video. Over the video you see:
   - small arrows on the tracked features: **green** for features that agree with the
     background motion, **red** for features that do not (for example a car driving across
     the scene)
   - a large **yellow arrow** at the center, for the smoothed background direction, labelled
     with its angle and confidence, for example *37.5° (82%)*. The angle is measured
     clockwise from straight up in the frame
   - a line of text with *mag*, *conf* and *vec* (magnitude, confidence and the number of
     vectors), or *BAD FRAME* when the frame fails the quality checks
   - a small **Motion Angle** graph in the bottom-right corner, with the recent history of the
     direction from −180° to +180°
4. Press **Stop Analysis** to hide the overlay.

While Analyze Motion is on, playback waits for each frame to be analyzed before it moves on,
so playback runs at the speed of the analysis until those frames are done.

### Export the motion as a CSV file

1. Set the range with the **In** and **Out** markers (keys `I` and `O`).
2. Press **Export Motion**. If the range is not analyzed yet, Sitrec analyzes it first and shows
   the progress on the button. Then the browser downloads the CSV file.

### Stabilize the video on the background

1. Set the In/Out range.
2. Press **Stabilize Video**. Sitrec analyzes the range if necessary, then shifts every frame to
   cancel the background motion. The button changes to **Disable Stabilization**.
3. Press **Disable Stabilization** to see the original video. Press **Stabilize Video** again to
   switch the same stabilization back on without analyzing again.

### Make a panorama

1. Set the In/Out range to the part of the pan you want.
2. If the video has burned-in text, a reticle or black borders, mask them first
   ([Masking](Masking.md)).
3. Open **Panorama** and press **Export Motion Pano Image**. A full-screen preview shows the
   panorama as it builds, and the browser downloads a PNG file at the end.
4. If the result is badly aligned, try **Export Feature Pano Image**, which registers the frames
   in a different way. See [Panoramas](#d-panoramas).

---

## C. The Motion Analysis controls

### Main controls

| Control | Default | What it does |
|---|---|---|
| **Analysis Resolution** | Original (no limit) | The video resolution used for analysis. Shared with the other video analysis tools. See [Performance](#performance) |
| **Analysis pixels** | — | Shows the size that is analyzed, and warns when it is smaller than the source |
| **Analyze Motion** / **Stop Analysis** | — | Switches the live analysis and its overlay on and off. **Stop Analysis** also stops a running analysis pass or panorama export |
| **Use Local Compute** | on | Runs the full-range analysis in the optional SitrecBridge helper on your own computer, when it is installed and running. See [Local Compute](#local-compute) |
| **Local Compute** | — | Status of the helper: *Not checked*, *Connecting...*, *Done (N frames)* or *Fallback:* and the reason |
| **Create Track from Motion** | — | Analyzes the range and builds a green ground track from the motion. See below |
| **Export Motion** | — | Downloads the per-frame motion as a CSV file. See below |
| **Align with Flow** | off | Rotates the video on screen so that the background motion points to the right. Only has an effect while Analyze Motion is on |
| **Stabilize Video** / **Disable Stabilization** | — | Shifts each frame to cancel the background motion. See below |
| **Speed Overlay** | off | Appears while Analyze Motion is on. Shows a heat map of the feature speeds over the video, averaged in a grid. The color range is set from the slowest and fastest cells in the current frame |

The **De-Fence** and **Panorama** folders are described in parts [D](#d-panoramas) and
[E](#e-de-fence). The mask is in its own folder, **Video → Masking** (see
[Masking](Masking.md)).

### Create Track from Motion

This turns the measured motion into a track on the ground in the 3D view:

- It analyzes the In/Out range first, if that is not done yet.
- It starts from the frame-0 position of the first of these that exists: the selected
  traverse track, the target track, or the camera track. If there is none, it says
  *No origin track found*.
- It converts pixels to meters with one fixed scale:
  `meters per pixel = 2 × distance × tan(FOV / 2) ÷ image width`. The FOV is the sitch's field
  of view at frame 0 (30° if there is none). The distance is the target distance at frame 0
  (1000 m if there is none).
- Horizontal motion in the image moves the track east or west, and vertical motion moves it
  north or south. The track stays 1 m above the terrain, or 1 m above the ellipsoid when there
  is no terrain.
- Frames without a good measurement are filled in from the nearest good frames.

Each press makes a new track (`motionTrack`, `motionTrack_2`, …), drawn in green.

Because the scale is fixed and the image axes are mapped directly onto east/west and
north/south, the result is a rough guide. It is not a camera reconstruction. Check the
direction against something you know before you rely on it. For a camera path, use
[Camera Motion (Background)](#camera-motion-background).

### Export Motion

**Export Motion** downloads a file named `<sitch>_motion_<date-time>.csv` with one row for each
frame from In to Out:

| Column | Meaning |
|---|---|
| `frame` | Frame number |
| `angle_deg` | Direction of the background motion, 0–360°. **0° is to the right in the image, and the angle increases clockwise** (90° is down). This is 90° less than the on-screen label, which counts from straight up |
| `magnitude_px` | Speed of the background motion, in pixels per frame |
| `time_sec` | Frame number ÷ frame rate, counted from frame 0 of the video |
| `utc_time` | The sitch date and time of the frame, in ISO format |

The angle and magnitude are the smoothed values (see **Smoothing** below). A frame with no
result is written as 0.

The same numbers are also available for custom graphs (**Show → Graphs → Add Custom Graph**), in
the *Analyze Motion* group: **Analyze Motion X (raw)**, **Analyze Motion Y (raw)**,
**Analyze Motion X (smoothed)** and **Analyze Motion Y (smoothed)**, all in pixels.

### Stabilize Video

**Stabilize Video** adds up the frame-to-frame motion and shifts each frame back by the total, so
the background stays still on screen. It moves the frame only; it does not rotate or scale it.
Frames that were not analyzed count as no motion.

Point Track can also stabilize a video, but on a tracked object instead of the background. See
[Stabilization and stabilized rendering](PointTrack.md#c-stabilization-and-stabilized-rendering).

### Tracking Parameters

**Video → Motion Analysis → Tracking Parameters** appears only while Analyze Motion is on. Every
change clears the cached results, so the frames are analyzed again.

The analysis method is **Linear Tracklet**: each feature is followed across several frames, and
only paths that are straight and evenly spaced are kept. (A **Technique** list with other
methods is shown only to administrators.)

| Control | Default | Range | What it does |
|---|---|---|---|
| **Tracklet Length** | 3 | 1–10 | Number of frames in each tracklet. Longer is stricter about coherent motion |
| **Skip Duplicates** | on | — | Finds repeated (duplicate) video frames, gives them zero motion, and leaves them out of the measurement |
| **Blur Size** | 5 | 1–15 (odd) | Blur applied before features are found, so larger shapes are tracked instead of noise |
| **Min Motion** | 0.2 | 0–2 | Smallest motion to use, in pixels per frame |
| **Max Motion** | 100 | 10–200 | Largest motion to use |
| **Smoothing** | 0.9 | 0.5–0.99 | How strongly the direction is smoothed from frame to frame. Higher is smoother but slower to react |
| **Min Vector Count** | 5 | 1–50 | A frame with fewer motion vectors is a bad frame |
| **Min Confidence** | 0.1 | 0–0.5 | A frame with less agreement is a bad frame |
| **Max Features** | 300 | 50–500 | Most features tracked in a frame |
| **Min Distance** | 10 | 5–50 | Smallest spacing between features, in pixels |
| **Quality Level** | 0.01 | 0.001–0.1 | How strong a corner must be to count as a feature |
| **Max Track Error** | 15 | 5–50 | Largest tracking error for a feature to be kept |
| **Min Quality** | 0.3 | 0–1 | Smallest quality for a feature's arrow to be drawn |
| **Static Threshold** | 0.3 | 0.1–2 | Motion below this counts as static, as for burned-in text |
| **Static Frames** | 15 | 5–30 | Frames needed to confirm that something is static |
| **Inlier Threshold** | 0.6 | 0.3–0.9 | How closely vectors must agree with the consensus direction |
| **Reject Moving Objects** | on | — | Fits one model of the background motion and leaves out things that move on their own, such as cars, whatever their direction or speed |
| **Object Reject Px** | 3 | 1–10 | How far, in pixels, a vector may be from the background model and still count as background. Lower rejects movers more strictly |
| **Linearity Threshold** | 0.9 | 0.5–1 | How straight a tracklet must be (1 = a perfect line) |
| **Spacing Threshold** | 0.5 | 0–1 | How even the steps of a tracklet must be (1 = perfectly even) |

**Optimize** runs a search for better settings for the current frame. While it runs, the
**Status** line shows its progress, and **Enough (Accept)** keeps the best settings found so
far. **Abort (Reset)** puts the original settings back. When it finishes, **Status** lists what
changed (Tracklet Length, Blur Size, Max Features, Min Quality).

The tracking parameters, and whether Analyze Motion was on, are saved with the sitch. The
panorama and De-Fence options are not.

---

## D. Panoramas

**Video → Motion Analysis → Panorama**

A panorama puts every frame of a pan in its place on one large image. Sitrec has two methods:

- **Motion Pano** uses the Motion Analysis results to place each frame. It analyzes the In/Out
  range first if necessary, and stops without a file if that analysis does not finish.
- **Feature Pano** finds and matches corner features between frames and warps each frame to
  fit. It does its own registration. It needs the Motion Analysis results only when
  **Feature Source** is **Motion Tracklets**.

Both use only the frames from In to Out. Frames are drawn in order, so later frames cover
earlier ones.

### Motion Pano

| Control | Output |
|---|---|
| **Export Motion Pano Image** | A PNG file, `<sitch>_motion_panorama_<date-time>.png`. A full-screen preview updates while it builds |
| **Export Motion Pano Video** | A 3840×2160 video at the sitch frame rate: the finished panorama, fitted and centered, with each live frame drawn over it in its place. MP4 (H.264) when the browser supports it, otherwise WebM. A progress panel has **Enough** and **Abort** buttons |

The image uses **Pano Frame Step**; the video always uses every frame. There is no cancel button
on the image preview: press **Stop Analysis** to stop it.

**Motion Pano Options**

| Control | Default | What it does |
|---|---|---|
| **Projection** | Similarity (2D) | **Similarity (2D)** places frames with a move, a turn and a scale only. It is fast, but for a camera that pans, tilts or zooms the error builds up across the panorama. **Perspective (Homography)** fits a full perspective transform to each frame, which registers pan/tilt/zoom footage correctly from edge to edge. If that fit fails, Sitrec falls back to Similarity |
| **Rotate Frames (SfM)** | on | Turns each frame by its measured rotation as well as moving it, so camera roll is followed. When off, frames are only moved |
| **Allow Frame Scaling** | off | With Rotate Frames: also applies the measured scale of each frame. Off keeps every frame the same size; on can make frames grow or shrink across the panorama |
| **Pano Frame Step** | 1 | 1–60. Use every Nth frame (1 = every frame) |
| **Panorama Crop** | 0 | 0–100 pixels. Makes a border of this width around each frame transparent, so neighboring frames fill it in |
| **Use Mask in Pano** | on | Makes masked pixels transparent, so they are not stitched in. Works only when **Enable Mask** is on in **Video → Masking** |
| **Analyze With Effects** | off | Applies the video adjustments and filters (contrast and so on) to the frames that Motion Analysis measures. This affects all Motion Analysis, not only panoramas. Set it before you analyze |
| **Export With Effects** | off | Applies the video adjustments and filters to the frames drawn into the panorama |
| **Remove Outer Black** | off | Makes near-black pixels at the ends of each row transparent, for frames with black side borders |

**Align with Flow** also rotates the motion panorama so the overall motion is horizontal, but
only when **Rotate Frames (SfM)** is off and **Projection** is **Similarity (2D)**.

### Feature Pano

| Control | Output |
|---|---|
| **Export Feature Pano Image** | A PNG file, `<sitch>_feature_panorama_<date-time>.png` |
| **Export Feature Pano Video** | A video in which each frame is warped into its place on the stitched panorama. Its size fits the panorama inside 3840×2160. MP4 (H.264) when supported, otherwise WebM |

The frames are placed relative to the middle frame of the range. A full-screen overlay shows the
progress and has a **Cancel** button.

**Feature Pano Options**

| Control | Default | What it does |
|---|---|---|
| **Feature Source** | ORB Features | **ORB Features** finds and matches corner features again in each frame. **Motion Tracklets** uses the Motion Analysis tracklets, the same points followed across many frames. This is more consistent on soft or low-contrast content, and runs a Motion Analysis pass over the range first |
| **Frame Step** | 1 | 1–60. Frames between stitched frames. Higher is faster |
| **Crop** | 0 | 0–100 pixels to ignore at each edge of the frame |
| **Use Mask** | on | Leaves masked regions out of feature detection and blending |
| **Projection** | Auto | **Planar** is a perspective mosaic, good for a camera that moves along. **Rigid** is a flat unrolling for a camera that turns. **Auto** picks Planar, and changes to Rigid when the planar mosaic becomes much too large or stretched |
| **Feature Scale** | 1 | 1–8. Find features at 1/N resolution. Higher values track larger, softer shapes, such as clouds, and ignore pixel noise |
| **Feature Contrast** | 20 | 1–60. Smallest corner contrast for a feature. Lower finds fainter features |
| **Feature Count** | 2000 | 500–8000. Most features found in each frame |
| **Optimize Feature Tracking** | — | Tries Feature Scale 1, 2, 4 and 8 with Feature Contrast 20, 10, 5 and 2 on up to five frames around the current frame (spaced by Frame Step), keeps the combination that gives the most stable feature tracks, and sets Feature Count to 3000. A message shows the result |

### Size limits

A panorama larger than 16,384 pixels on a side, or about 134 million pixels in total, is scaled
down to fit. Browsers can fail silently above such sizes and save an all-black image.

---

## E. De-Fence

**Video → Motion Analysis → De-Fence**

De-Fence removes a foreground fence and rebuilds the distant scene that shows through its
gaps. It needs a video that pans past the fence: the near fence then moves faster across the
frame than the distant scene, and the gaps show a different part of the scene on each frame.
Sitrec measures the two motions separately and builds up the scene from the gaps.

It uses the frames from In to Out, and asks you to set a range if Out is not after In. It does
not need Motion Analysis, and it does not use the mask.

| Control | Default | What it does |
|---|---|---|
| **Start De-Fence** | — | Builds the rebuilt scene and downloads it as a PNG file (`<sitch>_defence_<date-time>.png`), at half the video resolution on each axis. A preview shows the progress and has a **Cancel** button |
| **Export De-Fence Video** | — | Downloads a video of the process: the original video, then the fence dissolving as the scene builds up, then the final result held for 2.5 seconds. At most 1920 pixels on the long side |
| **Technique** | Colour + Motion | How fence and background are told apart. **Colour + Motion** uses both the color of the lit gaps and the motion. **Colour only** uses gap brightness and green, best when the fence is a distinct color. **Motion only** uses only the motion, best on fences with little texture |
| **Variance Threshold** | 0.45 | 0–1. How much a pixel must change, once the fence is aligned, to count as background. Lower fills more holes but lets more fence through |
| **Gap Brightness** | 0.12 | 0–1. Smallest gap brightness or green to count as background. Lower keeps darker background; higher rejects more boards |
| **Background Baseline** | 24 | 4–60. Frames between samples when measuring the slower background motion. Larger separates the layers more reliably; too large risks losing the view |

---

## F. Related Video tools

These are separate folders in the **Video** menu. Each has its own **Analysis Resolution**
control, which is shared with the others.

### Camera Motion (Background)

**Video → Camera Motion (Background)**

This estimates the **camera's** path from the moving background. It is made for a camera looking
down at the ground or at a cloud layer from above. It follows features across frames, fits the
background's move, turn and zoom on each frame, and adds these up into a flight path.

It analyzes **every frame of the video**, not only the In/Out range. It masks the video by itself:
areas that stay dark in the first 12 frames (such as redaction blocks) and a small square at the
center (for a reticle). It does not use the **Video → Masking** mask.

| Control | Default | What it does |
|---|---|---|
| **Visualize motion** | off | Draws the flow vectors over the video: green for background, red for outliers. Runs the analysis if there is no result yet |
| **Auto scale (FOV/alt)** | on | Sets meters per pixel from the look camera's field of view, the camera altitude, the look-down angle and **Background alt** |
| **Background alt (m)** | 0 | 0–12,000. Altitude of the surface seen in the video, such as a cloud top. The video cannot show this, so you must supply it |
| **Manual m / pixel** | 12 | 1–100. The scale used when Auto scale is off |
| **Smoothing window** | 4 | 1–21 frames. Moving average of the per-frame motion. An even window cancels a two-frame repeat pattern in the source. Changing it works without a new analysis in the same session |
| **dx -> East sign** / **dy -> North sign** | East - / North - | Which way image motion maps onto east and north |
| **Swap dx/dy** | off | Swaps the two image axes |
| **Altitude from zoom** | 0 | 0–3. When above 0, the altitude changes with the measured zoom: a shrinking background means the camera climbs. 0 keeps a constant altitude |
| **Drive look camera** | off | Makes the look camera fly the recovered path |
| **Look orientation** | Off | **Recovered roll** keeps the real aim and adds the measured roll. **Fixed depression** points the camera down at the **Depression° (fixed)** angle, plus the measured roll |
| **Depression° (fixed)** | the sitch's look-down angle, else 25 | 0–90 |
| **Roll direction** | Roll: normal | Flip the roll if it turns the wrong way |
| **Analyze & Build Path** | — | Runs the analysis and draws the path. The button shows *Masking…* and *Analyzing…* with a percentage |
| **Rebuild Path (no re-analyze)** | — | Rebuilds the path with new signs or scale, from the stored motion |
| **Clear Path** | — | Removes the path |

The path starts at the camera position at frame 0 and is drawn in orange with a line down to the
ground and a marker at the current frame. It is also added as **Camera Motion Path** to the
camera source options. The measured motion is kept in the browser's storage for this video
file, so the path comes back after a page reload.

### Horizon Extractor

**Video → Horizon Extractor**

This is a manual tool for measuring the angle of the horizon in a video.

1. Press **Enable Horizon Extractor**. A cross appears over the video.
2. Drag the magenta center to put the cross on the horizon.
3. Drag one of the four cyan handles to turn the cross until its horizontal arm lies along the
   horizon.
4. Each move or turn writes a **keyframe** at the current frame. Go to other frames and repeat.

Between keyframes the position and angle are interpolated in a straight line. Before the first
and after the last keyframe, the nearest keyframe is held. The angle is shown next to the
cross, positive clockwise.

| Control or key | What it does |
|---|---|
| **Enable / Disable Horizon Extractor** | Shows or hides the cross |
| **Delete Keyframe at Current Frame** | Deletes the keyframe here. `Shift`+click on the cross center does the same |
| **Clear All Keyframes** | Deletes every keyframe |
| **Show Hint** | Shows the on-screen help again |
| `J` / `K` | Go to the previous / next keyframe |

Keyframes are shown as yellow diamonds on the timeline, where `<` and `>` step through them.
They are kept in the browser's storage and saved with the sitch.

The result is used in two places:

- the **Horizon Angle** series for custom graphs (group *Horizon*, degrees)
- the **Turn Rate Source** control of the simple flight sim, when the sitch has one. Its
  **Horizon Extractor** option takes the bank angle as the negative of the horizon angle, and
  the turn rate as g·tan(bank)/speed

### OSD Tracker

**Video → OSD Tracker**

Many videos have numbers burned into the picture: the on-screen display (OSD). The OSD Tracker
is a way to type those numbers in by hand, frame by frame, and turn them into data and tracks.

1. Press **Add New OSD Data Series**. A new series appears over the video as *?????*.
2. Set its **Type**: MGRS Zone, MGRS East, MGRS North, Latitude, Longitude, Altitude (m),
   Altitude (ft) or Slant Range. Give it a **Name**.
3. Click the series on the video, or press `\`, to start editing. Type the value you see.
4. Press `]` or `[` to save the value and go one frame forward or back. Type a new value only
   where the readout changes: each value is a **keyframe**, and it stays until the next one.
5. Press `Enter` or `Esc` to stop editing.

| Control or key | What it does |
|---|---|
| **Add New OSD Data Series** | Adds a series |
| **Make Track** | Makes a position track from the shown, unlocked series: MGRS Zone + East + North, or Latitude + Longitude, with an optional altitude series |
| **Show All** | Shows or hides every series |
| **Export All Data** | Downloads `OSDData.zip` for the In/Out range (see below) |
| **Graph** | **Show**, **X Axis**, **Y1 Axis**, **Y2 Axis**: plot series against the frame or against each other |
| Per series: **Name**, **Type**, **Show**, **Lock**, **Remove Track** | **Lock** stops a series from being edited |
| `\` | Start editing, or go to the next editable series |
| `Tab` | While editing: the next editable series |
| `PageUp` / `PageDown` | Go to the previous / next keyframe of any series |
| `←` `→` `Home` `End` `Backspace` `Delete` | Edit the text while editing |

Frames with keyframes are marked on the timeline. In a track made with **Make Track**, numeric
values are interpolated in a straight line between keyframes, and the MGRS zone is held. An
altitude is taken as above mean sea level. Without an altitude series, the track follows the
ground.

`OSDData.zip` holds one CSV file for each series (its keyframes only), plus `EveryKeyframe.csv`,
`EverySecond.csv` and `EveryFrame.csv` with all the series side by side. Each row has `Frame`,
`Time`, `Epoch` and `DateTime` columns. In the combined files, numeric series are interpolated
between keyframes and other series hold their last value.

### Text Extraction

**Video → [BETA] Text Extraction** is shown only when Sitrec runs on your own computer
(localhost or a local network address). It reads text in the video by optical character
recognition (OCR).

1. Press **Enable Text Extraction**, then **Add Region**, and drag a box around the text.
2. Press **Start Extract**. It reads every region on each frame from the current frame to the
   Out frame, and shows the text next to the region. Press **Stop Extraction** to stop.

**Fixed Width Font** and **Num Characters** (default 10) split a region into equal character
cells. **Learn Templates** lets you click cells and type their characters. With **Use
Templates** on (the default), the learned templates are used to read those cells. The results
stay in the page; there is no export.

---

## G. Masking, the In/Out range and performance

### Masking

Burned-in text, a reticle, a fence or trees can pull the measured motion away from the real
background. Mask them in **Video → Masking** ([Masking](Masking.md)). The mask is shared by the
video tools. With **Enable Mask** on:

- Motion Analysis ignores features inside the mask
- the motion panorama makes masked pixels transparent (**Use Mask in Pano**)
- the feature panorama leaves masked regions out of detection and blending (**Use Mask**)

Camera Motion (Background) and De-Fence do not use this mask. Changing the mask clears the
Motion Analysis results, so the frames are analyzed again.

### The In/Out range

Everything that analyzes a whole range uses the frames from **In** to **Out**: Create Track from
Motion, Export Motion, Stabilize Video, both panoramas and De-Fence. Text Extraction runs from
the current frame to Out. Camera Motion (Background) uses the whole video. When you change In or
Out, the Motion Analysis results are cleared.

### Performance

- **One pass, then cached.** A full-range pass has up to three steps, shown on the button:
  *Detecting duplicate frames*, *Analyzing motion*, and *Filling motion gaps*. Results are kept
  for each frame, so the next export or stabilization uses them without a new pass.
- **What clears the results:** any change in Tracking Parameters, the mask, the In/Out range,
  the video, or the analysis resolution.
- **Analysis Resolution.** **Original (no limit)** analyzes every source pixel. **Use Settings**
  follows the video playback limit in Settings, and 1080p, 720p, 480p and 360p set a limit.
  A smaller size is faster and uses less memory, but can hide small detail. Changing it clears
  the decoded frames and stops a running analysis; start it again.
- **Stopping.** **Stop Analysis** stops a running analysis pass or panorama export cleanly.
- **Large panoramas** are scaled down to fit the browser's canvas limits (see
  [Size limits](#size-limits)).

### Local Compute

With **Use Local Compute** on (the default), Sitrec first tries to send the full-range analysis
to the optional SitrecBridge helper on your own computer, which runs it with native
Python/OpenCV and returns the result. The overlay, graph, panoramas, stabilization, CSV export
and track creation then work as usual. If the helper is not running, or cannot open the video,
Sitrec analyzes in the browser and the **Local Compute** line shows *Fallback:* with the reason.
The helper and its setup are described in the SitrecBridge README (`tools/SitrecBridge`).

### Tips

- Mask on-screen text and reticles before you analyze. They do not move with the background.
- If many frames show *BAD FRAME*, the scene may have too little texture. Try a larger **Blur
  Size** for soft content, or lower **Min Vector Count** and **Min Confidence**.
- For a panorama from a camera that pans, tilts or zooms, try **Projection: Perspective
  (Homography)** before you change anything else.
- For soft, low-contrast content such as clouds, use **Optimize Feature Tracking**, or set
  **Feature Source** to **Motion Tracklets**.

---

## See also

- [Point Tracking](PointTrack.md) — follow one object through the video, and stabilize on it
- [Masking](Masking.md) — keep the analysis off overlays, fences and trees
- [Loading Video](LoadingVideo.md)
- [Star Tracker](StarTracker.md) — measure the field of view from the stars
- [The Ideas Behind the Traverse Analysis](TraverseConcepts.md)
- [Keyboard Shortcuts](KeyboardShortcuts.md)
