# Rendering and Exporting Video

**Video → Video Render & Export**

Once you have a sitch that shows what you want, this is how you get it out — as a video file
to post, or as a single still frame. This page also covers video with MISB (Motion Imagery
Standards Board) metadata, and the optional simulations of analog video and of filming a screen.

---

## Quick export

1. Set the In and Out frames (`I` and `O`) around the part you want.
2. In **Video → Video Render & Export**, press **Render Viewport Video**.
3. The render dialog opens. Leave it as it is and press **Render**.

The browser downloads the video file when the render ends. For a better result, see
[Getting a good-looking export](#getting-a-good-looking-export).

---

## The render buttons

They differ in *what* they capture:

| Button | What it captures |
|---|---|
| **Render Single View Video** | One view and the overlays on it, at that view's own resolution. Pick which one with *Render Video View* |
| **Render Viewport Video** | All visible views and their overlays, composited and laid out as you see them |
| **Render Source Video** | The video alone, at its original resolution, without the 3D scene — but **not** an untouched copy. See the warning below |
| **Render Fullscreen Video** | The same viewport render, but it hides the menu bar and puts the browser into fullscreen first, so you get the layout at full screen size with no UI in shot |
| **Record Browser Window** | A screen capture of the tab, via the browser's own screen-sharing prompt. The tab is captured as shown, except that the render menus are closed first |

All of them step through the **In/Out range** frame by frame — including
*Record Browser Window*, which despite the name is not a live recording of you using the app.
It advances the same frame sequence as the others and captures the screen at each step, so
the result is the same clip, not a screencast. A-B in a label or tooltip means the In/Out range.

For a side-by-side of video and simulation, use **Render Viewport Video** and set up the
layout first with the view presets (`1`–`8`).

The renders do not include every mark on screen. Viewport renders and a single-view render of the
video view include the Video Readout, annotations, the Motion Analysis overlay and, while
**Enable Point Track** is on, the Point Track cursor and trail. They leave out the Star Tracker's
marks, which are a separate layer over the video view. To record those, use *Record Browser
Window*, which captures the tab as shown. *Render Source Video* adds annotations only.

Other tools have their own video exports, for example stabilized video in
[Point Tracking](PointTrack.md#c-stabilization-and-stabilized-rendering), panorama videos in
[Motion Analysis](MotionAnalysis.md#d-panoramas) and a widening video in
[Frequency Analysis](FrequencyAnalysis.md#render-a-widening-video). Motion Analysis has no export for its
[background stabilization](MotionAnalysis.md#stabilize-the-video-on-the-background). To save that
stabilization, use *Render Source Video*.

> ### "Render Source Video" is not a pristine copy of your footage
>
> It re-encodes the video at its original resolution without the 3D scene, which makes it
> sound like a passthrough. It is not. Everything you have done to the *picture* is baked in:
>
> - **Video Adjustments** — brightness, contrast, levels, curves, any filter you enabled
> - **Video Rotation**
> - **Stabilization** from Point Track or Motion Analysis, if it is on
> - **Zoom and pan**, if you have zoomed the video view past 100 %
> - **Annotations**, composited on top at full resolution
>
> It is also re-encoded, so it is lossy even if you changed nothing.
>
> For an unchanged copy, use the original file.

## Choosing the view

*Render Video View* lists every view that can export — by default `lookView`. Overlay views
are not offered on their own; they composite into the render of their parent view and into the
viewport render.

The headers of the main view, the look view and the video view each have a render-video icon. It
runs **Render Single View Video** for that view directly, without changing the *Render Video View*
selection.

## The render dialog

Every render button opens a settings dialog first. Nothing is captured until you press
**Render**; **Cancel** or Escape backs out without starting. For a plain export, leave the
dialog as it opens: [Signal format](#signal-format) and
[Recorded off a screen](#recorded-off-a-screen) are optional, and both start off.

The dialog previews a real frame with your settings applied, updating as you change them,
so you can judge a look in a second rather than after a five-minute export. The preview shows one
view, even for a render of the whole viewport: the view in *Render Video View*, the video view for
*Render Source Video*, or the view whose header icon you pressed. Tick
**Colour bars** to preview against a test pattern instead — saturated vertical edges and a
fine grating show the analog artifacts below far better than a photograph does.

![The Render Viewport Video dialog. At the left are the Signal format section with Format set to Pure digital (no filter), the closed Recorded off a screen section, and the Compression section with Container / codec, Bitrate and Keyframe interval. At the right is a preview of a sitch, with a Colour bars checkbox under it. Render and Cancel buttons are along the bottom.](docimages/video-render-dialog.jpg)

The render dialog as it opens. The settings are at the left, and the preview is at the right. The
title names the render.

**An export always starts unfiltered**: *Pure digital (no filter)*, with *Recorded off a screen* off,
however the last one was set up. The filter setting is not remembered between exports. Pressing
**Render** does save your camera settings, *Output resolution*, *Bitrate* and *Keyframe interval*,
so re-ticking *Recorded off a screen* brings the camera settings back. **Cancel** saves nothing.

If the [live video format effects](#live-video-format-effects) are switched on and the
render includes the look view, they are baked into the output. When the dialog previews the
look view, it says so:
*"The scene's Video Format Effects are included. Settings below add further effects."*
The dialog's own signal format and off-a-screen settings are then applied on top, so the
two can stack.

### Signal format

Puts the rendered frames through a simulation of an analog video path on their way to the
encoder. This is not a color grade with grain over it: Sitrec splits the picture into luma
(brightness) and chroma (color), modulates the chroma onto a simulated color subcarrier, adds the
two into one signal, and then demodulates it. Dot crawl (small dots that creep along color edges),
cross-color rainbowing (false colors in fine detail), chroma bleed (color that spreads past its
edge) and luma/chroma crosstalk come from that process, so they change with the picture.

| Format | What it is |
|---|---|
| **Pure digital (no filter)** | No filter. The rendered frames, untouched. This is the default |
| **NTSC (525/60 color)** | US broadcast composite. Dot crawl and cross-color rainbowing |
| **EIA RS-170 (525/60 monochrome)** | The pre-color US studio standard. Luminance only, no subcarrier |
| **PAL (625/50 color)** | European composite. Phase-alternating V axis, softer vertical color |
| **VHS (SP)** | Color-under tape. Smeared color, head-switching tear at the bottom, tape noise |
| **VHS (worn, 3rd generation)** | A copy of a copy on a played-out tape. Dropouts, tracking error, grain |

![The same test pattern of vertical color bars in four formats. Pure digital has clean edges and a sharp patch of fine white lines at the top right. NTSC has a fine dot pattern over the bars, and the patch of lines is a pale blur. VHS (SP) has soft color edges. VHS (worn, 3rd generation) has faded colors, horizontal lines across the picture, and bright white dashes.](docimages/video-signal-formats.jpg)

The dialog's preview of the *Colour bars* test pattern in four formats. In NTSC, a fine dot pattern
covers the bars, and the fine white lines at the top right blur into pale stripes with false color. In
VHS (SP), color spreads past the edges of the bars. In VHS (worn, 3rd generation), the color fades,
horizontal lines cross the picture, and the bright dashes are dropouts.

**Output resolution** chooses between the raster you rendered at and the format's own
active picture — 640×480 for the 525-line formats, 768×576 for PAL. Rendering 16:9 to a 4:3
format letterboxes it.

**Signal detail** opens the individual parameters behind whichever preset is selected:
luma and chroma bandwidth in MHz, chroma timing error, edge pre-emphasis, comb filter
strength, Y/C separation (Y is luma and C is chroma; 0 is composite, 1 is an S-Video or component
feed), chroma gain, hue error, time-base error (line-to-line horizontal instability), head
switching, tape noise, dropouts, interlace combing, ghosting, scan lines, vertical chroma smear,
and the number of tape generations to run.

**Dropouts** are short losses of signal, each a fraction of one scan line. Most are concealed the
way a VCR's dropout compensator does it: the last good line repeats, so you see a short horizontal
smear of repeated picture. The rest show as bright, grainy, monochrome dashes.

**Tape noise** is one level from 0 to 1, starting at 0.05. Its *character* is not a
setting: luma noise is fine grain, and color noise is broader horizontal smears. Their widths come
from the format's luma and chroma bandwidths, so the level only says how much. VHS has narrower
channels than NTSC, so at the same level both its grain and its smears are about 1.5 times wider.

The bandwidths and line timings in the presets are based on the published figures for each
standard. The other values are severity settings. The sliders are there for when you want a
specific look.

### Recorded off a screen

Simulates pointing a phone at a monitor playing the video. Runs after the signal format,
because that is the order it happens in.

![The same test clip filmed off a simulated screen at two distances. At Distance 0.90 m the picture fills the frame. At Distance 2.00 m the picture is smaller, with a gray band around it and black all around that, and its bottom edge is wider than its top edge.](docimages/video-recorded-off-screen.jpg)

The dialog's preview of a test clip with *Recorded off a screen* ticked and the **Phone, handheld**
preset. At the preset's *Distance* of 0.90 m, the screen fills the frame. At 2.00 m, the dark room
shows around the screen, and the gray band is the monitor bezel. **Keystone** makes the bottom edge
of the screen wider than the top edge.

Three **Camera** presets — **Phone, handheld**, **Phone, handheld (unsteady)** and
**Phone, on a tripod** — set everything below, which you can then adjust:

- **Camera and screen** — camera HFOV, aspect ratio, screen width, distance and extra crop:
  the physical setup that decides how much of the frame the screen fills (see
  [Where the camera is standing](#where-the-camera-is-standing)).
- **Handheld** — wobble amount, speed, and *variation*, which modulates the amount over
  time so the shot has steady stretches and unsteady ones instead of a constant buzz.
  Plus slow drift and rotation. Nothing crops in to hide the wobble: if the framing leaves room
  around the screen, you see the screen's edge move. Raise *Extra crop* or reduce *Distance* to
  keep it out of shot.
- **Exposure** — auto exposure meters the frame and chases the target rather than snapping
  to it, so it visibly hunts. Bias, adaptation speed, a highlight knee and a clipping
  control for how hard the highlights blow out, black crush, black lift and bloom.
- **Lens and screen** — keystone, barrel distortion, chromatic aberration, edge
  softness, the screen's own pixel grid and its pitch (the moiré comes from the beat
  between that grid and the output raster, not from a drawn-on pattern), the rolling refresh
  beat, a reflection on the glass, the monitor bezel, vignette and sensor noise.

### Compression

| Control | Default | What it does |
|---|---|---|
| **Container / codec** | MP4 (H.264) | As the *Video Format* control below, and shown only when the browser supports more than one |
| **Bitrate** | 8 Mbit/s | Used for every render started from this menu or a view header. The render type and the HD/Retina setting do not change it, so raise it by hand for HD/Retina exports |
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
| **Use HD/Retina Export** | off | Renders at your display's device pixel ratio instead of CSS pixels (2 on a Retina display, so 4× the pixels). It applies to **Render Viewport Video**, **Render Fullscreen Video**, a whole-viewport **Render Fade**, **Render Widening Video** and a single-view render of the video view. Other renders ignore it. The bitrate does not scale with it, so raise **Bitrate** in the render dialog to keep the same quality |
| **Include Audio** | **on** | Carries the source video's audio through — but only when the export would stay in sync with it. Audio is silently dropped if playback speed is not 1×, ping-pong is on, Loops is above 1, *Unique frames only* actually skipped a frame, or the audio has not finished decoding. **Render Fade** never includes audio |
| **Unique frames only** | off | Scans the In/Out range of the source video first and skips source frames that duplicate the previous one (for example, repeated frames from a frame-rate conversion). The output keeps its frame rate, so the clip becomes shorter. Has no effect without a video |
| **Unique threshold** | 1.0 | How different a frame has to be to be kept, as mean absolute difference in grey level. Lower keeps more frames |
| **Wait for background loading** | off | Waits for terrain, 3D tiles and video decoding to settle before capturing each frame. Slower, but stops tiles popping in mid-shot |

**Turn on *Wait for background loading* for anything you are going to publish.** Without it,
the exporter captures as fast as it can, and terrain or Google 3D tiles that are still
streaming will appear to pop in during the shot.

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

**Export Video Frame (JPG)** and **Export Video Frame (PNG)** write the current frame at the size of
the video view on screen, not at the file's resolution, compositing the annotation overlay if you
have one. Enlarge the view for more pixels. PNG is lossless. JPEG is written at quality 0.92. Files
are named `<prefix>_frame_00000.jpg` or `.png` to match the button you used.

These write what is **on screen**, so — exactly as with Render Source Video above — any video
adjustments, rotation and zoom are baked in.

**Export Look Panorama**, in the same folder, builds a PNG panorama from the look view across the
In/Out range. It places each frame from the point where the look camera's line of sight meets the
terrain or the globe.

## Render Fade

**Video → Video Render & Export → Render Fade**

Renders the chosen view while crossfading between the simulation and the video overlay, as
if the look view's *Vid Overlay Trans %* slider were being moved up and down. Useful for a
direct comparison of the recreation against the footage.

The fade needs a loaded video, and *Render Video View* must be a view with that overlay, normally
`lookView`. A view without it stops with an error, even with *Render Whole Viewport* on.

| Control | Default | What it does |
|---|---|---|
| **Start With** | Look | The view the render opens on. *Look* is the simulation alone, *Video* is the video overlay alone |
| **Initial Delay (s)** | 1 | Seconds on the starting view before the first fade |
| **Fade Time (s)** | 1 | Seconds each crossfade takes |
| **Hold Time (s)** | 2 | Seconds on each view after a fade arrives on it |
| **Fades** | 2 | Number of crossfades. Each goes to the other view, so 2 goes there and back |
| **Hold Current Frame** | on | Freezes on the current frame for a still comparison. Off plays the In/Out range while fading, looping it if the fades outlast the clip |
| **Render Whole Viewport** | off | Renders every visible view as laid out on screen, not just the one view. The fade still runs on the look view's overlay |
| **Render Fade Video** | — | Opens the render dialog, then renders the view chosen in *Render Video View* (or the whole viewport). Length is Initial Delay + Fades × (Fade Time + Hold Time) |

---

## Getting a good-looking export

A few things that make more difference than the settings do:

1. **Set the layout first.** Use a view preset (`1`–`8`), then hold `Q` to fine-tune. The viewport
   render captures that layout. Every render also stamps the Sitrec version at the top right and
   the map and data attribution at the bottom right, except *Render Source Video*.
2. **Set the In/Out range** (`I` and `O`) so you export the part that matters.
3. **Turn on *Wait for background loading*** so the terrain is fully resolved.
4. **Check the frame rate.** At normal speed the output runs at the sitch's own frame rate.
   Speeding playback up past 1× caps the output at 60 fps (dropping frames rather than
   producing an unplayable rate); slowing it down gives you a slow-motion file. Below 1× the output frame rate drops with the
   speed (0.5× of a 30 fps sitch gives 15 fps), so slow motion is also choppier.
   *Render Source Video* uses the frame rate in the video file's own header, not a
   frame rate you set by hand for the video. If ping-pong is on, every render in this menu except
   *Render Fade* plays the In/Out range forward and back.
5. **Consider the burned-in readouts.** The Video Readout puts frame numbers, timecode and dates
   into the frame. The Look View Readout puts the date and time, and the traverse object's speed,
   g-force and altitude, there. The numbers then travel with the picture. *Render Source Video*
   leaves them out.

---

## Live video format effects

**Effects → Video Format Effects**

The same analog simulation, running on screen over the look view instead of only on an
export. Useful for judging a look interactively, and for showing a recreation as it would
appear on a given recording format.

It carries the same *Format* list and the main severity controls — tape noise, time-base
error, head switching, dropouts, interlace combing, scan lines, color smear — plus
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
reflection stays on the glass and does not spill onto it, or into the room. The bezel shows only
when the framing leaves room around the screen. With a 16:9 picture at the camera presets, that
needs *Distance* above about 1 m.

The screen's half-width subtends `atan((width/2) / distance)` at the lens, and the frame's
half-width subtends half the field of view; the ratio of their tangents decides the framing. So
standing back, widening the lens or filming a smaller screen all shrink the picture in frame and
let the dark room in around it, and moving in or narrowing the lens crops into the screen.
**Extra crop** is a manual adjustment on top, for when you want a particular framing without
arguing with the numbers.

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

**It starts switched off in a new session.** It needs a *Format* other than *Pure digital (no
filter)*, or *Recorded off a screen* ticked. With neither, ticking it changes nothing. Its format
and tuning are remembered, so ticking it back on resumes where it was. A saved sitch stores the
format, the tuning and the on/off state, and restores them when it is loaded.

When it is on, renders that include the look view bake it into the output (see
[The render dialog](#the-render-dialog)).

---

## See also

- [Scripted Camera Moves](ScriptedVideo.md) — for scripted, repeatable camera moves rather
  than hand-flown ones
- [Long Exposure/Stacking](LongExposure.md) — trails rather than motion
- [Keyboard Shortcuts](KeyboardShortcuts.md)
