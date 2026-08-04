# Masking

A **mask** marks parts of the video frame that Sitrec should ignore. Anything you paint over
is excluded from analysis: the trees along the bottom of a night-sky shot, the burned-in text
of a camera's on-screen display, a bright streetlight, the black surround inside a night-vision
tube.

You'll find it under **Video → Masking**.

The mask is **shared**. One mask per sitch, used by everything that looks at the video —
[the Star Tracker](StarTracker.md), Point Track, Motion Analysis and the panorama exporters —
so you paint the ground out once and every tool respects it. It is saved with the sitch and
comes back when you reload.

## Why it matters

The usual reason to mask is that something in the frame is *bright and stationary* — which is
exactly what most of Sitrec's video analysis is looking for.

A worked example: a wide night photograph with a treeline along the bottom detected about a
thousand "stars", roughly 40% of which were lit foliage. The star identification could not hold
a consensus against that and failed outright. With the ground masked it kept 423 detections,
none of them in the trees, and named **221 stars**. The picture had not changed — only what the
analysis was allowed to look at.

## Quick start

1. Open **Video → Masking**.
2. Click **Mask Ground (auto)**. Everything Sitrec judges to be ground, foliage or buildings is
   added to the mask, shown as a red overlay.
3. Check the result. If some ground was missed, tick **Edit Mask** and paint over it — click and
   drag to add, hold **Alt/Option** to erase. `[` and `]` resize the brush.
4. Leave **Enable Mask** ticked. That's it — every tool now skips those pixels.

If the automatic result is wrong rather than merely imperfect, **Clear Mask** and start again
with one of the other methods below.

## Ways to build a mask

All of these **add** to the mask rather than replacing it, so you can combine them — a detected
ground region, an auto-masked OSD and some hand-painted touch-ups coexist. **Clear Mask** is the
only thing that removes everything.

| Control | What it does |
| --- | --- |
| **Edit Mask** | Paint by hand. Drag to add, **Alt/Option**-drag to erase, `[` and `]` for brush size. |
| **Mask Ground (auto)** | No clicks. Splits the frame into blocks and keeps as sky only what a large, uniform block can describe — so foliage, which forces the blocks to keep subdividing, is picked out. Best first thing to try. |
| **Mask Ground (click sky, then ground)** | Click a patch of sky, then a patch of ground. The second click lets Sitrec *measure* which of brightness or texture separates them in your particular clip rather than assuming. Declines honestly if neither works. |
| **Auto Mask OSD** | Finds pixels that never change over a window of frames and are close to a target colour — burned-in text, timestamps, reticles. |
| **Auto Mask Redactions** | Finds flat, featureless rectangles — blanked-out regions in released footage. |
| **[ADMIN] Mask Ground with AI** | Sends the frame to an AI model and asks it to outline the sky, then follows the real foliage edge from the picture itself. Experimental, admin only. |

**Brush size** is measured in the video's own pixels, and the maximum scales with the
resolution — so the largest brush covers the same fraction of the picture on a 720p clip as on
a 4000-pixel-wide photograph.

### Which ground method should I use?

Try **Mask Ground (auto)** first. It needs no input and it is the one that copes with a bright
glow along the horizon, which is common in real night photographs and defeats the two-click
method.

Use **Mask Ground (click sky, then ground)** when the automatic version misjudges the scene and
you can point at unambiguous examples of each. Be aware that footage through a vignetted optic —
a night-vision tube, a telescope — can over-mask, because the sky's own brightness falls off
across the frame by more than the sky differs from the ground.

Either way, **check the result before relying on it**. Both err deliberately towards masking too
much: losing a little sky costs a few stars out of thousands, while leaving a treetop unmasked
costs hundreds of false detections.

## What uses the mask

Each tool has its own switch, so you can mask the frame once and still choose which analyses
obey it.

| Tool | Control | Effect |
| --- | --- | --- |
| [**Star Tracker**](StarTracker.md) | **Video → Star Tracker → Use mask** | Detections inside the mask are discarded before they can be mistaken for stars. They are counted under the other rejection reasons, so you can still tell why something was not circled. |
| **Point Track** | **Video → Point Track → Use Mask** | Masked pixels are left out of the centring calculation. The centring methods take a weighted average of the pixels inside the cursor, so bright masked ground drifting into the cursor would otherwise *pull* the tracked point towards it. |
| **Motion Analysis** | On whenever the mask is enabled | Motion measurements skip masked points, so a fence, a treeline or an OSD does not contribute to the estimated camera motion. |
| **Panorama / stabilized export** | **Use Mask in Pano** | Masked pixels are written transparent instead of being stitched into the output. |

A tool's mask switch does nothing if there is no mask painted, so leaving them on is harmless.

## Saving

The mask is saved inside the sitch and restored when you load it, at whatever resolution the
video turns out to be. It is stored at a reduced resolution — a mask is a coarse region map, not
picture detail, so this keeps a saved sitch small without any visible difference to what gets
excluded.

**Importing a new video or image clears the mask.** A mask belongs to the picture it was painted
on, and stretching one onto different footage — whose horizon is somewhere else entirely — is
worse than having none. Reloading a saved sitch keeps the mask that was saved with it.

## Notes

- **Enable Mask** turns the whole mask on and off without destroying it, which is the quick way
  to check what difference it is making.
- Masking is undoable like any other edit, including the automatic methods — so trying
  **Mask Ground (auto)** on a mask you have already hand-painted costs nothing.
- The red overlay is only drawn while **Edit Mask** is on. The mask still applies when it is off.
