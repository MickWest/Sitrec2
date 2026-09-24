# Rendering and Exporting Video

**Video → Video Render & Export**

Once you have a sitch that shows what you want, this is how you get it out — as a video file
to post, or as a single still frame.

The folder is closed by default and sits in the Video menu.

---

## The render buttons

They differ in *what* they capture:

| Button | What it captures |
|---|---|
| **Render Single View Video** | One view only, at that view's own resolution. Pick which one with *Render Video View* |
| **Render Viewport Video** | Everything visible, composited — all views and overlays, laid out as you see them |
| **Render Source Video** | The video alone, at its original resolution, without the 3D scene — but **not** an untouched copy. See the warning below |
| **Render Fullscreen Video** | The same viewport render, but it hides the menu bar and puts the browser into fullscreen first, so you get the layout at full screen resolution with no UI in shot |
| **Record Browser Window** | A screen capture of the tab, via the browser's own screen-sharing prompt. The tab is captured as shown, except that the render menus are closed first |

All of them step through the **In/Out (A-B) range** frame by frame — including
*Record Browser Window*, which despite the name is not a live recording of you using the app.
It advances the same frame sequence as the others and captures the screen at each step, so
the result is the same clip, not a screencast.

For a side-by-side of video and simulation, use **Render Viewport Video** and set up the
layout first with the view presets (`1`–`8`).

> ### "Render Source Video" is not a pristine copy of your footage
>
> It re-encodes the video at its original resolution without the 3D scene, which makes it
> sound like a passthrough. It is not. Everything you have done to the *picture* is baked in:
>
> - **Video Adjustments** — brightness, contrast, levels, curves, any filter you enabled
> - **Video Rotation**
> - **Zoom and pan**, if you have zoomed the video view past 100 %
> - **Annotations**, composited on top at full resolution
>
> It is also re-encoded, so it is lossy even if you changed nothing.
>
> For an unchanged copy, use the original file.

## Choosing the view

*Render Video View* lists every view that can export — by default `lookView`. Overlay views
are not offered on their own; they composite into the viewport render.

Each view's header also has a render-video icon. It runs **Render Single View Video** for
that view directly, without changing the *Render Video View* selection.

## The render dialog

Every render button opens a settings dialog first. Nothing is captured until you press
**Render**; **Cancel** or Escape backs out without starting.

The dialog previews a real frame with your settings applied, updating as you change them,
so you can judge a look in a second rather than after a five-minute export. Tick
**Colour bars** to preview against a test pattern instead — saturated vertical edges and a
fine grating make chroma bleed, dot crawl and rainbowing far easier to see than a
photograph does.

**An export always starts unfiltered**: *Pure digital (no filter)*, with *Recorded off a screen* off,
however the last one was set up. The filter setting is not remembered between exports. What each stage was
tuned to *is* remembered, so re-selecting a format or re-ticking the camera brings your
settings back, and the compression settings persist as the preferences they are.

If the [live video format effects](#live-video-format-effects) are switched on and the
render includes the look view, they are baked into the output, and the dialog says so:
*"The scene's Video Format Effects are included. Settings below add further effects."*
The dialog's own signal format and off-a-screen settings are then applied on top, so the
two can stack.

### Signal format

Puts the rendered frames through a simulation of an analog video path on their way to the
encoder. This is not a colour grade with grain over it: the picture is genuinely modulated
onto a colour subcarrier and demodulated back off it, so dot crawl, cross-colour
rainbowing, chroma bleed and luma/chroma crosstalk arise the way they do on real hardware,
and respond to picture content accordingly.

| Format | What it is |
|---|---|
| **Pure digital (no filter)** | No filter. The rendered frames, untouched — the previous behaviour, and still the default |
| **NTSC (525/60 colour)** | US broadcast composite. Dot crawl and cross-colour rainbowing |
| **EIA RS-170 (525/60 monochrome)** | The pre-colour US studio standard. Luminance only, no subcarrier |
| **PAL (625/50 colour)** | European composite. Phase-alternating V axis, softer vertical colour |
| **VHS (SP)** | Colour-under tape. Smeared colour, head-switching tear at the bottom, tape noise |
| **VHS (worn, 3rd generation)** | A copy of a copy on a played-out tape. Dropouts, tracking error, grain |

**Output resolution** chooses between the raster you rendered at and the format's own
active picture — 640×480 for the 525-line formats, 768×576 for PAL. Rendering 16:9 to a 4:3
format letterboxes it, exactly as putting widescreen footage on tape would.

**Signal detail** opens the individual parameters behind whichever preset is selected:
luma and chroma bandwidth in MHz, chroma timing error, edge pre-emphasis, comb filter
strength, Y/C separation (0 is composite, 1 is an S-Video or component feed), chroma gain, hue error,
time-base error, head switching, tape noise, dropouts, interlace combing, ghosting, scan
lines, vertical chroma smear, and the number of tape generations to run.

**Dropouts** are the head losing contact with the tape — a missing patch of oxide, a
crease, debris. Each costs a fraction of one scan line, not a whole one. Most are hidden
by the *dropout compensator*, which VCRs normally have: it detects the signal collapsing and
repeats the previous line from a one-line delay, so a concealed dropout shows as a short
horizontal smear of repeated picture rather than as anything bright, and a defect
spanning several lines keeps repeating that same last good line. The minority the
compensator misses are the classic bright dash — the demodulator running with no carrier,
so grainy and monochrome rather than a flat white bar.

**Tape noise** is one level from 0 to 1, starting at 0.05. Its *character* is not a
setting: luma noise is grain the width of the format's luma channel, colour noise is broad
horizontal smears the width of its colour channel — about ten times wider on VHS, which
records colour on a far narrower band than luminance. So VHS and NTSC at the same level
still look quite different, and the level only says how much.
The presets are derived from the published figures for each standard; the sliders are there
for when you want a specific look.

### Recorded off a screen

Simulates pointing a phone at a monitor playing the video. Runs after the signal format,
because that is the order it happens in.

Three **Camera** presets — **Phone, handheld**, **Phone, handheld (unsteady)** and
**Phone, on a tripod** — set everything below, which you can then adjust:

- **Camera and screen** — camera HFOV, aspect ratio, screen width, distance and extra crop:
  the physical setup that decides how much of the frame the screen fills (see
  [Where the camera is standing](#where-the-camera-is-standing)).
- **Handheld** — wobble amount, speed, and *variation*, which modulates the amount over
  time so the shot has steady stretches and unsteady ones instead of a constant buzz.
  Plus slow drift and rotation. The crop tightens automatically as far as it must to keep
  a frame edge from swinging into view.
- **Exposure** — auto exposure meters the frame and chases the target rather than snapping
  to it, so it visibly hunts. Bias, adaptation speed, a highlight knee and a clipping
  control for how hard the highlights blow out, black crush, black lift and bloom.
- **Lens and screen** — keystone, barrel distortion, chromatic aberration, edge
  softness, the screen's own pixel grid and its pitch (the moiré is the genuine beat
  between that grid and the output raster, not a drawn-on pattern), the rolling refresh
  beat, a reflection on the glass, the monitor bezel, vignette and sensor noise.

### Compression

| Control | Default | What it does |
|---|---|---|
| **Container / codec** | MP4 (H.264) | As the *Video Format* control below, and shown only when the browser supports more than one |
| **Bitrate** | 8 Mbit/s | Used for every render started from the menu. Raise it by hand for HD/Retina exports |
| **Keyframe interval** | 30 frames | Frames between keyframes. Lower seeks better and compresses worse |

**Defaults** puts the three back where they started, without touching the signal format or
the off-a-screen settings. If your browser cannot encode MP4 it restores the container it
can encode instead.

---

## Format

| Option | Container | Codec |
|---|---|---|
| **MP4 (H.264)** | `.mp4` | AVC — the default, and the one to use unless you have a reason not to |
| **MISB TS (H.264)** | `.ts` | AVC video with frame-synchronized MISB camera and track metadata |
| **WebM (VP8)** | `.webm` | VP8 — the default on Firefox, when Firefox can encode VP8. Sitrec cannot load WebM files back in |

The dropdown appears when your browser supports more than one option. If it supports only one, that one
is used and the control is hidden. Support is probed by asking the browser's video encoder
whether it can handle each configuration. If none work, the folder is replaced by a
disabled *Video Export Not Available* row.

Choose **MISB TS (H.264)** in **Video → Video Render & Export → Video Format**, or in the
render dialog's **Container / codec** selector. The file includes camera position, orientation,
field of view, and the source frame's UTC time. The selected target track is included when
available. A selected **Truth Track** in the traverse analysis controls is included as a separate
metadata stream and is recognized as truth when the file is opened in Sitrec.

MISB TS does not fall back to another format: if the browser cannot encode it at the
render's resolution, the export stops with an error rather than silently dropping the
metadata.

For **Render Single View Video**, metadata describes that view's camera. Source-video and
combined-view exports use the look camera. A combined-view export therefore describes the
look camera, rather than every panel in the image.
Metadata describes the camera before image cropping, rotation, and simulated lens or screen effects.

## Settings

| Control | Default | What it does |
|---|---|---|
| **Loops** | 1 | Repeat the clip up to 20 times in one file. Useful for short events you want people to be able to watch repeatedly |
| **Use HD/Retina Export** | off | Renders at your display's device pixel ratio instead of CSS pixels — typically 2× linear, so 4× the pixels. The bitrate does not scale with it, so raise **Bitrate** in the render dialog to keep the same quality |
| **Include Audio** | **on** | Carries the source video's audio through — but only when the export would stay in sync with it. Audio is silently dropped if playback speed is not 1×, ping-pong is on, Loops is above 1, *Unique frames only* actually skipped a frame, or the audio has not finished decoding |
| **Unique frames only** | off | Scans the A-B range of the source video first and skips source frames that duplicate the previous one (for example, repeated frames from a frame-rate conversion). The output keeps its frame rate, so the clip becomes shorter. Has no effect without a video |
| **Unique threshold** | 1.0 | How different a frame has to be to be kept, as mean absolute difference in grey level. Lower keeps more frames |
| **Wait for background loading** | off | Waits for terrain, 3D tiles and video decoding to settle before capturing each frame. Slower, but stops tiles popping in mid-shot |

**Turn on *Wait for background loading* for anything you are going to publish.** Without it,
the exporter captures as fast as it can, and terrain or Google 3D tiles that are still
streaming will appear to pop in during the shot.

## Bitrate

Every render button opens the render dialog, and the dialog's **Bitrate** (default
8 Mbit/s) and **Keyframe interval** (default 30) are used for the render. The render type
and the HD/Retina setting do not change them.

## While it is running

A progress panel appears with two buttons:

- **Enough** — stop early and keep what has rendered so far.
- **Abort** — stop and discard the output.

*Record Browser Window* is the exception: it has no progress panel, and uses the keyboard
instead — **`Enter`** to stop early, **`Esc`** to abort.

Odd pixel dimensions are rounded up to even before encoding, since the codecs require it. If
your chosen resolution is not supported, the exporter falls back to another format
automatically (except for MISB TS, which fails rather than drop its metadata); if nothing supports it you will get a `No codec supports W×H` error — resize
the view and try again.

## Exporting a single frame

**Export Video Frame (JPG)** and **Export Video Frame (PNG)** write the current frame at the video
view's own resolution, compositing the annotation overlay if you have one. JPEG is written at
quality 0.92. Files are named `<prefix>_frame_00000.jpg` or `.png` to match the button you used.

PNG is lossless. JPEG is written at quality 0.92.

These write what is **on screen**, so — exactly as with Render Source Video above — any video
adjustments, rotation and zoom are baked in.

**Export Look Panorama**, in the same folder, builds a panorama image from the look view
across all frames, placed by the background position.

## Render Fade

**Video → Video Render & Export → Render Fade**

Renders the chosen view while crossfading between the simulation and the video overlay, as
if the look view's *Vid Overlay Trans %* slider were being moved up and down. Useful for a
direct comparison of the recreation against the footage.

| Control | Default | What it does |
|---|---|---|
| **Start With** | Look | The view the render opens on. *Look* is the simulation alone, *Video* is the video overlay alone |
| **Initial Delay (s)** | 1 | Seconds on the starting view before the first fade |
| **Fade Time (s)** | 1 | Seconds each crossfade takes |
| **Hold Time (s)** | 2 | Seconds on each view after a fade arrives on it |
| **Fades** | 2 | Number of crossfades. Each goes to the other view, so 2 goes there and back |
| **Hold Current Frame** | on | Freezes on the current frame for a still comparison. Off plays the A-B range while fading, looping it if the fades outlast the clip |
| **Render Whole Viewport** | off | Renders every visible view as laid out on screen, not just the one view. The fade still runs on the look view's overlay |
| **Render Fade Video** | — | Opens the render dialog, then renders the view chosen in *Render Video View* (or the whole viewport). Length is Initial Delay + Fades × (Fade Time + Hold Time) |

---

## Getting a good-looking export

A few things that make more difference than the settings do:

1. **Set the layout first.** Use a view preset (`1`–`8`), then hold `Q` to fine-tune. What you
   see is what the viewport render captures.
2. **Set the In/Out range** (`I` and `O`) so you export the part that matters.
3. **Turn on *Wait for background loading*** so the terrain is fully resolved.
4. **Check the frame rate.** At normal speed the output runs at the sitch's own frame rate.
   Speeding playback up past 1× caps the output at 60 fps (dropping frames rather than
   producing an unplayable rate); slowing it down gives you a slow-motion file. Below 1× the output frame rate drops with the
   speed (0.5× of a 30 fps sitch gives 15 fps), so slow motion is also choppier.
   *Render Source Video* uses the frame rate in the video file's own header, not a
   frame rate you set by hand for the video. If ping-pong is on, every export plays the
   A-B range forward and back.
5. **Consider the burned-in readouts.** The Video Readout and Look View Readout put
   altitude, range, speed and time into the frame, so the numbers travel with the picture.

---

## Live video format effects

**Effects → Video Format Effects**

The same analog simulation, running on screen over the look view instead of only on an
export. Useful for judging a look interactively, and for showing a recreation as it would
appear on a given recording format.

It carries the same *Format* list and the main severity controls — tape noise, time-base
error, head switching, dropouts, interlace combing, scan lines, colour smear — plus
*Recorded off a screen* and, under it, a **Camera Tweaks** folder holding every camera
parameter. The two keep their settings separately, so tuning one does not disturb the other.

### Where the camera is standing

The first four entries in Camera Tweaks describe the physical setup rather than a look, and
between them they decide how much of the frame the screen fills:

| Control | What it is |
|---|---|
| **Camera HFOV** | Horizontal field of view of the lens, in degrees. Default 65 |
| **Aspect ratio** | Shape of the camera's own frame, width over height — 1.78 is 16:9. Letterboxed into the view when it differs, because that is what watching phone footage in a wider window looks like |
| **Screen width** | Physical width of the screen being filmed, in metres |
| **Distance** | How far the camera is from it, in metres |

**Bezel width** and **Bezel brightness** draw the monitor's frame around the screen — the
width as a fraction of the screen's width, so it stays the same all the way round. It is a
real object in the room rather than a border drawn on the picture, so it is metered,
vignetted and grained with everything else: a dark bezel gets brighter as the auto exposure
opens up, and a hard enough *Black crush* will take it to black entirely. The glass
reflection stays on the glass and does not spill onto it, or into the room.

The screen's half-width subtends `atan((width/2) / distance)` at the lens, and the frame's
half-width subtends half the field of view; the ratio decides the framing. So standing back,
narrowing the lens or filming a smaller screen all shrink the picture in frame and let the
dark room in around it, and moving in crops into the screen. **Extra crop** is a manual
adjustment on top, for when you want a particular framing without arguing with the numbers.

**It includes the on-screen display.** The HUD, the compass and the annotation layer are
composited into the picture before the effect runs, so they are degraded along with it
rather than sitting crisp on top. That is the difference between this and the other
entries in the Effects menu: those are shader passes inside the 3D render and can only
ever see the 3D scene, so this one runs after every view has drawn.

Two consequences of that:

- It costs two full-frame copies per frame that the other effects do not pay.
- The effect animates while the sitch is playing. Paused, the picture holds still — which
  is what a paused tape looks like — and any setting you change still takes effect
  immediately.

**It starts switched off in a new session.** Its format and tuning are remembered, so
ticking it back on resumes where it was. A saved sitch stores the format, the tuning and
the on/off state, and restores them when it is loaded.

When it is on, renders that include the look view bake it into the output (see
[The render dialog](#the-render-dialog)).

---

## See also

- [Scripting](ScriptedVideo.md) — for scripted, repeatable camera moves rather
  than hand-flown ones
- [Long Exposure Simulation](LongExposure.md) — trails rather than motion
- [Keyboard Shortcuts](KeyboardShortcuts.md)
