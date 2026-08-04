# Rendering and Exporting Video

**Video → Video Render & Export**

Once you have a sitch that shows what you want, this is how you get it out — as a video file
to post, or as a single still frame.

The folder is closed by default and sits in the Video menu.

---

## The render buttons

They differ in *what* they capture, which matters more than it sounds:

| Button | What it captures |
|---|---|
| **Render Single View Video** | One view only, at that view's own resolution. Pick which one with *Render Video View* |
| **Render Viewport Video** | Everything visible, composited — all views and overlays, laid out as you see them |
| **Render Source Video** | The video alone, at its original resolution, without the 3D scene — but **not** an untouched copy. See the warning below |
| **Render Fullscreen Video** | The same viewport render, but it hides the menu bar and puts the browser into fullscreen first, so you get the layout at full screen resolution with no UI in shot |
| **Record Browser Window** | A screen capture of the tab, via the browser's own screen-sharing prompt. Whatever is on screen is captured, menus included |

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
> This matters for provenance. If you publish this file as "the original video", you may be
> publishing footage whose contrast you stretched an hour earlier to see something faint —
> and someone will eventually notice the discrepancy against the real source and treat it as
> evidence of manipulation.
>
> **If you want the untouched original, distribute the file you started with.** Use this
> export for showing the video the way you have been looking at it — enhancements included,
> and said out loud.

## Choosing the view

*Render Video View* lists every view that can export — by default `lookView`. Overlay views
are not offered on their own; they composite into the viewport render.

## Format

| Option | Container | Codec |
|---|---|---|
| **MP4 (H.264)** | `.mp4` | AVC — the default, and the one to use unless you have a reason not to |
| **WebM (VP8)** | `.webm` | VP8 — the default on Firefox |

The dropdown only appears if your browser supports **both**. If it supports only one, that one
is used and the control is hidden. Support is probed by asking the browser's video encoder
whether it can handle each configuration. If neither works, the folder is replaced by a
disabled *Video Export Not Available* row.

## Settings

| Control | Default | What it does |
|---|---|---|
| **Loops** | 1 | Repeat the clip up to 20 times in one file. Useful for short events you want people to be able to watch repeatedly |
| **Use HD/Retina Export** | off | Renders at your display's device pixel ratio instead of CSS pixels — typically 2× linear, so 4× the pixels. Note the viewport bitrate scales with the square of the factor too, so the file gets roughly four times bigger as well |
| **Include Audio** | **on** | Carries the source video's audio through — but only when the export would stay in sync with it. Audio is silently dropped if playback speed is not 1×, ping-pong is on, Loops is above 1, *Unique frames only* actually skipped a frame, or the audio has not finished decoding |
| **Unique frames only** | off | Skips frames that are nearly identical to the previous one. Shrinks a file where nothing is moving |
| **Unique threshold** | 1.0 | How different a frame has to be to be kept, as mean absolute difference in grey level. Lower keeps more frames |
| **Wait for background loading** | off | Waits for terrain, 3D tiles and video decoding to settle before capturing each frame. Slower, but stops tiles popping in mid-shot |

**Turn on *Wait for background loading* for anything you are going to publish.** Without it,
the exporter captures as fast as it can, and terrain or Google 3D tiles that are still
streaming will appear to pop in during the shot.

## Bitrates

Not exposed in the interface, but worth knowing when judging output quality:

| Render | Bitrate |
|---|---|
| Single view | 5 Mbps |
| Source video | 10 Mbps |
| Viewport | 8 Mbps × (retina scale)² |
| Fullscreen | as viewport — it delegates to the same exporter, so retina scales it too |

## While it is running

A progress panel appears with two buttons:

- **Enough** — stop early and keep what has rendered so far.
- **Abort** — stop and discard the output.

*Record Browser Window* is the exception: it has no progress panel, and uses the keyboard
instead — **`Enter`** to stop early, **`Esc`** to abort.

Odd pixel dimensions are rounded up to even before encoding, since the codecs require it. If
your chosen resolution is not supported, the exporter falls back to another format
automatically; if nothing supports it you will get a `No codec supports W×H` error — resize
the view and try again.

## Exporting a single frame

**Export Video Frame JPG** and **Export Video Frame PNG** write the current frame at the video
view's own resolution, compositing the annotation overlay if you have one. JPEG is written at
quality 0.92. Files are named `<prefix>_frame_00000.jpg` or `.png` to match the button you used.

Use PNG if the image is going into further analysis, JPEG if it is going into a forum post.

These write what is **on screen**, so — exactly as with Render Source Video above — any video
adjustments, rotation and zoom are baked in. That is usually what you want, since it matches
what you were looking at. Just say so when you publish it, rather than presenting it as an
untouched frame.

---

## Getting a good-looking export

A few things that make more difference than the settings do:

1. **Set the layout first.** Use a view preset (`1`–`8`), then hold `Q` to fine-tune. What you
   see is what the viewport render captures.
2. **Set the In/Out range** (`I` and `O`) so you export the part that matters.
3. **Turn on *Wait for background loading*** so the terrain is fully resolved.
4. **Check the frame rate.** At normal speed the output runs at the sitch's own frame rate.
   Speeding playback up past 1× caps the output at 60 fps (dropping frames rather than
   producing an unplayable rate); slowing it down gives you a slow-motion file, which is
   usually what you want for a fast event.
5. **Consider the burned-in readouts.** The Video Info Display and Sim Info Display put
   altitude, range, speed and time into the frame, so the numbers travel with the picture
   instead of living in a caption someone will crop off.

---

## See also

- [Scripted Camera Moves](ScriptedVideo.md) — for scripted, repeatable camera moves rather
  than hand-flown ones
- [Long Exposure Simulation](LongExposure.md) — trails rather than motion
- [Keyboard Shortcuts](KeyboardShortcuts.md)
