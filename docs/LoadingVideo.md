# Loading and Adjusting Video

**Video → …**

This page covers everything between dropping a video on Sitrec and starting to analyze it:
getting the file in, checking its frame rate and length, turning it the right way up, finding
your way around the video view, and the adjustment, processing and forensic tools in the
**Video** menu. For making a video *out* of Sitrec, see
[Rendering and Exporting Video](Video.md).

---

## Loading a video

### Drag and drop, or File → Import File

Drag a video file from your computer onto the Sitrec window. **File → Import File** does the
same thing through a file picker.

- **The first video** goes straight into the video view, and the playhead goes back to frame 0.
- **A second video**, dropped while one is already loaded, opens the **Second Video** dialog:

| Choice | What it does |
|---|---|
| **Second Video View** | Show the new video side by side in the second video view. Only offered when the sitch has a second video view |
| **Add to Video View** | Keep both videos in the same view. A **Video → Current Video** selector appears, so you can switch between them |
| **Replace Video** | Remove the current video and use the new one |
| **Cancel** | Do not import the video |

A video in the second view does not define the sitch timeline. Its menu entries have
**(2)** after the name. **Video → Lock to In Frame (2)** plays it relative to the In frame
(set with the **I** key): its first frame is shown when the playhead reaches the In frame.

You can also drop, or paste with Ctrl/Cmd+V, a direct link to a video file. If the other site
does not let other sites read its files, Sitrec cannot read it: save the file to your computer
and drag it in instead.

### What Sitrec can play

Sitrec decodes video with the browser's own **WebCodecs** video decoder, so you need an
up-to-date browser that has it (current Chrome, Edge, Firefox and Safari do). What matters is the *container* (the
file format that holds the video) and the *codec* (how the pictures are compressed inside it).

| File | What happens |
|---|---|
| **MP4, MOV, M4V** (the MP4/MOV family) | Loaded directly. This is the normal case |
| **Transport stream** (`.ts`, `.m2ts`, `.mts`) | Split into its streams. The H.264 video goes to the video view. A KLV metadata stream, if there is one, becomes a track: see [MISB / KLV](Tracks.md#misb--klv-csv-or-binary) |
| **Raw H.264** (`.h264`) | Loaded by the raw-stream loader. The frame rate comes from the stream's timing information, or is 30 fps if the stream has none |
| **Images** (PNG, JPEG, GIF, WebP, BMP, TIFF, HEIC and others) | Can be used as a single-frame video. See [Images as video](#images-as-video) |
| **Audio** (MP3, WAV, OGG, FLAC, AAC, M4A, AIFF, CAF) | Loaded into the video view as audio only |

Sitrec checks the first bytes of a file, not only its name, so a `.mpg` that is really a
transport stream still loads.

**Containers that Sitrec refuses.** An MPEG program stream (most `.mpg`, `.mpeg` and `.vob`
files), MPEG-1/MPEG-2 video, AVI, MKV, FLV and Ogg files are rejected with a message that names the
format and gives an `ffmpeg` command to convert the file to MP4. For example:

```
ffmpeg -i input.avi -c:v libx264 -c:a aac output.mp4
```

WebM video is not supported either. Convert it to MP4 in the same way.

**Files that will not decode.** If the file is an MP4 but its contents cannot be read within
two minutes, Sitrec stops with a message that the file is probably corrupt, truncated or an
unusual MP4 variant, with a re-encode command. If the hardware decoder rejects the video,
Sitrec tries again with the browser's software decoder. If that also fails, the video view
shows **Video Decode Failed** with the codec and resolution. Re-encoding to H.264 with the
command shown can fix it. If only part of a file is damaged, the damaged frames are
skipped and the rest of the video still plays.

### Images as video

When you drop an image, the **Import Image** dialog asks how to use it:

| Choice | What it does |
|---|---|
| **Video Image** | Use it as a static, single-frame video source. The same picture shows on every frame |
| **Ground Overlay** | Place it as an image overlay on the ground or map |
| **Cancel** | Do not import the image |

If a video or image is already loaded, the **Media Already Loaded** dialog then offers
**Replace**, **Add** (keep both and switch with the selector) or **Cancel**.

A photo with EXIF data can position the scene for you. When the image loads, Sitrec applies
what the EXIF provides to the camera: its GPS position, the capture date and time, the heading,
pitch and roll, and the vertical field of view. If the image has a GPS position,
**Video → Set Camera To EXIF GPS** applies the EXIF camera settings again, for example after
you have moved the camera.

### Seeing what you loaded

**Video → Show EXIF/Metadata** opens a panel with the file's size, frame rate, codec and
bitrate, and any EXIF data. It appears for every video and image, even one with no EXIF.

**Video → Video Readout** draws information over the video: the filename, frame number,
timecode, timestamp, and dates and times in UTC or local time. **Show Video Readout** is the
master switch.

### Videos with MISB metadata

Some videos carry a metadata stream in the MISB KLV format, with the sensor position,
pointing angles and field of view for each moment. A transport stream with KLV loads as a
video *and* a track. See [MISB / KLV](Tracks.md#misb--klv-csv-or-binary) and
[MISB Track Data](Tracks.md#misb-track-data).

If the frame rate written in such a file disagrees with the rate implied by the KLV
timestamps, Sitrec shows a dialog once, asking which frame rate to use, with a recommended
choice.

### Remove Video

**Video → Remove Video** removes the video from the view and puts the view back the way it
was before a video was loaded. Sitrec asks first. The file is unloaded, the view is hidden
again, and the sitch's own start time and duration come back. Anything measured from the
footage (a painted mask, tracking, an analysis) is not kept. It cannot be undone.

If the view holds several videos, Remove Video removes all of them.

### Large files and saving

A dropped file is read into memory and decoded in groups of frames as you need them, so a
long video does not have to be decoded in full before you can scrub it. If memory is short,
**Sitrec → Settings → Performance Tweaks → Max Resolution** limits the resolution of video
frames by the longer side (**None**, **1080P**, **720P**, **480P** or **360P**), to reduce GPU
memory use. It applies to frames loaded after you change it.

When you save to the server, Sitrec uploads (rehosts) dropped files, so the saved sitch points
at a stable copy rather than a file on your computer. See
[Saving and Loading Sitches](SavingAndLoading.md). When you open a saved sitch whose MP4 or
MOV video is on a server, playback can start before the whole file has downloaded; the rest
downloads in the background.

---

## Frame rate and length

### How the frame rate is found

- **MP4 / MOV**: the number of video frames divided by the video's duration. If that gives a
  value outside 0–240 fps, Sitrec uses 30 fps.
- **Raw H.264**: the timing information in the stream, or 30 fps if there is none.

### The sitch follows the video

When a video loads into the main video view, the sitch takes its length from the video:
**Time → Sitch Frames** becomes the number of frames in the video, and **Time → Video FPS**
becomes the video's frame rate. One sitch frame is one video frame.

### Changing the frame rate

**Time → Video FPS** (1 to 120) sets the frame rate by hand. Use it when the rate in the file
is wrong, for example footage that was slowed down or sped up before it reached you. It
changes the playback speed, and the duration of the sitch in seconds, because it changes how
long each frame lasts. It does not add or remove frames.

A frame rate you set by hand is **saved with the sitch** and is used again when the sitch
reloads, even though the video file still reports its own rate. It belongs to that video: when
you import a *different* video, the new video starts from its own rate, but only after it has
loaded. If the import is cancelled or fails, your setting stays.

For start times, syncing video to tracks, and the In and Out frames, see
[Time and Sync](TimeAndSync.md).

---

## Rotation and the video view

### Video Rotation

**Video → Video Rotation** turns the picture by **0°**, **90° CW**, **180°** or **90° CCW**.

Phone videos often store their orientation as a flag in the file rather than in the pixels.
Sitrec reads that flag and turns the video upright automatically; Video Rotation is applied on
top of it. Changing the rotation turns off any video stabilization, because the stabilization
offsets no longer fit the turned picture.

### Zooming and panning

| Input | What it does |
|---|---|
| Mouse wheel / pinch | Zoom in or out about the pointer |
| Drag | Pan the zoomed image |
| Middle drag | Zoom |
| Right drag | Scrub back and forward through the frames |
| Right-click | Open **Video Adjustments** as a menu at the pointer |
| Double-click | Reset the zoom to 100% and center the image |

The zoom is also **View → Video Zoom %** (5% to 2000%). You cannot pan past the edge of the
image.

Hold **Q** and drag to move or resize the video view itself. See
[Keyboard Shortcuts](KeyboardShortcuts.md).

### The view header menu

Click the **Video** title in the video view's header for the controls that belong to this view.
They are the same controls as in the main menus, not copies: a change in one place shows in the
other.

| Item | Same as |
|---|---|
| **Zoom %** | View → Video Zoom % |
| **Rotation** | Video → Video Rotation |
| **Readout** | Video → Video Readout → Show Video Readout |
| **Grid** | Video → Grid → Show |
| **Annotations** | Video → Annotate → Show Annotations |
| **EXIF / Metadata** | Video → Show EXIF/Metadata |
| **Remove Video** | Video → Remove Video |
| **Adjustments** → Enable Effects, Brightness, Contrast | Video → Video Adjustments |
| **Masking** → Enable Mask, Show Mask, Edit Mask | See [Masking](Masking.md) |

Items appear only when there is something for them to control, so a view with no video shows
fewer rows.

The header also has icons: a **readout** toggle, a **100%** zoom button (press it again to go
back to the previous zoom), and a **render** button that exports this view on its own
(**Render Single View Video**, see [Rendering and Exporting Video](Video.md)).

---

## Video Adjustments

**Video → Video Adjustments**

These change how the video *looks*, both on screen and in **Render Source Video**. They do not
change the file. **Enable Video Effects** switches all of them off and on together, so you can
compare with the original quickly.

| Control | Default | What it does |
|---|---|---|
| **Brightness** | 1 | Brightness multiplier (0 to 5) |
| **Contrast** | 1 | Contrast multiplier (0 to 5) |
| **Levels** | off | Input and output levels, set in a levels editor |
| **Histogram** | on | Show the live RGB histogram of the video |
| **Histogram On-Screen** | off | Limit the histogram to the pixels visible in the view (useful when zoomed in) |
| **Curves** | off | Apply a tone curve |
| **Show Curves** | on | Show the tone-curve editor while Curves is on |
| **Shadows** | 0 | Raise or lower the darker tones (−100 to 100) |
| **Highlights** | 0 | Raise or lower the brighter tones (−100 to 100) |
| **Dehaze** | 0 | Reduce or add atmospheric haze (−100 to 100) |
| **Blur Src Px** | 0 | Gaussian blur radius, in source pixels |
| **Hue Rotate** | 0 | Rotate the hue, in degrees |
| **Invert** | off | Invert the colors exactly (255 minus each value) |
| **Saturate** | 1 | Saturation multiplier (0 = gray) |
| **Enable Video Effects** | on | Master switch for all adjustments |
| **Convolution Filter** | none | **sharpen**, **edgeDetect** or **emboss**. Each shows its own strength control: **Sharpen Amount**, **Edge Threshold** or **Emboss Depth** |
| **Reset Video Adjustments** | | Put every adjustment back to its default |
| **Render Source Video** | | Export the video from In to Out at its original resolution and frame rate, with the adjustments applied. See [Rendering and Exporting Video](Video.md) |
| **Optimize For Star Tracking** | | Tune the adjustments on this frame for the [Star Tracker](StarTracker.md) |

The histogram, levels editor and curves editor show only while the Video Adjustments folder is
open.

---

## Video Processing

**Video → Video Processing**

These combine several frames into one picture. They are useful for showing the path of a
moving light, or for bringing a faint, steady object out of the noise.

| Control | Default | What it does |
|---|---|---|
| **Echo Dark** | off | Keep the darkest value of each pixel over the last few frames |
| **Echo Light** | off | Keep the brightest value of each pixel over the last few frames |
| **Echo Frames** | 10 | How many frames the echo covers (2 to 100) |
| **Full A-B Echo** | off | The echo over the whole In–Out range. Turns on Echo Light if neither echo is on |
| **Full A-B Blend** | off | The average of all frames in the In–Out range |
| **Full A-B Exposure** | off | A simulated long exposure over the In–Out range |
| **A-B Echo Opacity %** | 100 | Opacity of the A-B result over the video |
| **Show Cache** | off | Show which video frames are decoded and held in memory |
| **Make Video** | | Export the processed video with all current effects applied |

Only one of the three **Full A-B** modes can be on at a time. Changing the In or Out frame
restarts the one that is running.

---

## Grid

**Video → Grid**

A pixel grid drawn over the video, for measuring sizes and positions by eye.

| Control | Default | What it does |
|---|---|---|
| **Show** | off | Show the grid |
| **Size** | 64 | Grid cell size, in pixels (1 to 128) |
| **Subdivisions** | 4 | Subdivisions within each cell (1 to 16) |
| **X Offset** / **Y Offset** | 0 | Move the grid, in pixels |
| **Color** | green | Color of the grid lines |

---

## Annotations

**Video → Annotate**

Draw on the video: arrows to point at an object, boxes, text, or a pasted image. Strokes are
stored in video pixels, so they stay in place when you zoom, pan or resize the view. They are
saved with the sitch, and they are drawn into **Render Source Video** and exported frames.

| Control | Default | What it does |
|---|---|---|
| **Show Annotations** | on | Master switch. When off, the annotations are hidden and the toolbar goes away |
| **Edit Mode** | off | Show the drawing toolbar in the video view, and use the mouse for drawing. Turns Show Annotations on |
| **Fade Frames** | 0 | Frames until a stroke fades out completely. 0 = strokes stay on every frame. Otherwise a stroke shows from the frame it was drawn on and fades after it |
| **Opacity** | 1 | Opacity of the annotations |
| **Line Width** | 3 | Stroke width, in video pixels |
| **Color** | red | Stroke color |
| **Clear All** | | Delete every stroke. It can be undone |

### The toolbar and its keys

While **Edit Mode** is on, these keys pick a tool:

| Key | Tool |
|---|---|
| **S** | Select / Move: drag a stroke to move it, drag a corner to resize it |
| **P** | Pencil |
| **B** | Brush |
| **L** | Line |
| **A** | Arrow |
| **R** | Rectangle |
| **E** | Ellipse |
| **T** | Text: click where the text goes, then type it |
| **I** | Image: click to pick an image file, or drop one on the view |
| **X** | Eraser: drag over strokes to remove them |

With the Select tool, **Delete** or **Backspace** removes the selected stroke. The toolbar also
has **Undo last stroke** (Ctrl+Z) and **Clear all** buttons.

> **These keys also reach Sitrec's normal shortcuts.** While Edit Mode is on, a tool key does
> not stop the global action for the same key. For example, **I** also sets the **In frame**,
> and **E** also toggles extending tracks to the ground. See
> [Keyboard Shortcuts](KeyboardShortcuts.md). Turn Edit Mode off when you have finished
> drawing.

---

## Forensics

**Video → Forensics**

Tools that look for signs of editing or re-compression in a frame. They show a *difference*,
not a verdict: every video that has been compressed shows some pattern, and a camera's own
processing can produce the same patterns as editing.

### Error Level Analysis

**Video → Forensics → Error Level Analysis**

Sitrec compresses the current frame again as a JPEG at a known quality, and shows how much each
pixel changed. Areas that were already compressed in the same way change little. Areas with a
different compression history, such as something pasted in, can stand out.

The overlay is shown **while this folder is open** (and Forensics is open). Close the folder
to hide it.

| Control | Default | What it does |
|---|---|---|
| **JPEG Quality** | 90 | The JPEG quality used for the re-compression (1 to 100) |
| **Error Scale** | 20 | Multiplier that makes small differences visible (0.1 to 80) |
| **Opacity %** | 65 | Opacity of the overlay on the video |
| **Expand Output** | None | Stretch the result to use the full brightness range: **Histogram Equalization**, **Auto Contrast**, or **Auto Contrast Channels** (each color channel separately) |
| **Clip %** | 0.5 | For the two Auto Contrast methods: the percentage of extreme values ignored when stretching |

### Noise Analysis

**Video → Forensics → Noise Analysis**

Sitrec removes the picture content with a high-pass filter (a filter that keeps only fine,
pixel-to-pixel detail), leaving mostly sensor and compression noise. A region with a different
noise level from its surroundings can show that it came from somewhere else, or was smoothed.
Like Error Level Analysis, it is shown while its folder is open.

| Control | Default | What it does |
|---|---|---|
| **Display Mode** | Noise Heatmap | **Noise Heatmap** divides the frame into blocks and colors each by its noise level compared with the median block: blue is quieter, green about the same, yellow and red noisier. **Noise Residual** shows the filtered noise itself, on a mid-gray background |
| **Block Size** | 16 | Block size in pixels for the heatmap (4 to 128) |
| **Noise Scale** | 5 | Multiplier that amplifies the Noise Residual display |
| **Opacity %** | 65 | Opacity of the overlay on the video |

### QP Graph and Tonal Range Graph

Two more tools in the same folder graph the whole video:

- **QP Graph** plots how heavily each frame of an H.264 video was compressed, read from the
  video bitstream. See [Video QP Graph](VideoQPGraph.md).
- **Tonal Range Graph** plots the brightness distribution of every frame. See
  [Video Tonal Range Graph](VideoTonalRange.md).

---

## Where next

Once the video is loaded, set up and the right way up:

- [Point Tracking](PointTrack.md): follow an object through the video automatically, and
  turn it into a line of sight.
- [Motion Analysis](MotionAnalysis.md): measure how the camera and the background move.
- [Masking](Masking.md): keep tracking and analysis off overlays, trees and buildings.
- [Star Tracker](StarTracker.md): measure the camera's field of view from the stars.
- [Rendering and Exporting Video](Video.md): make a video of the result.

---

## See also

- [Time and Sync](TimeAndSync.md): start time, In and Out frames, syncing the video to tracks
- [Loading and Filtering Tracks](Tracks.md)
- [Saving and Loading Sitches](SavingAndLoading.md)
- [Keyboard Shortcuts](KeyboardShortcuts.md)
- [User Interface](UserInterface.md)
