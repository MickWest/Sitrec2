# Point Track and Stabilization

**Video → Point Track**

Point Track follows an object through the video automatically, frame by frame. It is how you
turn "there is a light moving in this footage" into a line of sight you can actually analyse —
and it can also stabilize the footage on whatever it is following.

---

## Quick start

1. Open **Video → Point Track** and switch it on. A yellow cursor appears over the video.
2. Scrub to a frame where the object is clearly visible, then **drag the yellow cursor onto
   it**. Dragging is what creates the keyframe — a bare click on the object does nothing
   unless it lands on the cursor or an existing keyframe.
3. Hold **`'`** to advance frame by frame, tracking as it goes. The cursor turns green while
   tracking, and a cyan trail shows the path.
4. Watch it. When it loses the object — and on hard footage it will — release, scrub back to
   the last good frame, drag the cursor back onto the object, and continue.

Hold **`;`** to go back the other way. Note this is not "tracking backwards": it **rewinds and
deletes** the tracked positions as it goes, so use it to undo a bad run rather than to extend
the track behind your starting frame.

The hold loop advances at the sitch's frame rate, so it runs at roughly playback speed. The
separate **Start Point Track** button runs its own loop as fast as the machine allows, which
is much quicker over a long clip.

---

## Choosing a tracking method

There are seven (eight on a local development build), and picking the right one matters far
more than tuning the sliders.

| Method | Use it when |
|---|---|
| **Template Match** | The object has visible structure — an aircraft, a vehicle, anything with a recognisable shape. The default, and the right choice most of the time |
| **Optical Flow** | The object is textured and moves smoothly. Cheaper than template matching |
| **Center on Bright** | A bright point on a dark background — a light at night, a star, a flare |
| **Center on Dark** | A dark point on a bright background — a distant object against overcast sky |
| **Center on Color** | The object is distinguished by colour rather than brightness |
| **High Peak** | A sub-pixel-accurate bright point. Better than *Center on Bright* for point sources, since it fits a peak rather than averaging |
| **Low Peak** | The same for dark points |
| **SAM2 (Meta)** | Segmentation-based tracking. Local builds only |

For a light in the night sky, **High Peak** or **Center on Bright** will hold on far longer
than template matching, because there is no template to match — just a blob that changes shape
frame to frame.

Changing the method **while a track is actively running clears it**. Changing it while stopped
leaves the existing track alone. Either way, choose before you invest in a long run.

---

## The controls

| Control | Default | Range | What it does |
|---|---|---|---|
| **Track Radius** | 30 | 10–100 | The inner solid circle: the template size, or the window the centroid is computed over |
| **Search Radius** | 50 | 20–300 | The outer dashed circle: how far from the last position the tracker will look |
| **Feature Size** | 4 | 2–20 | Gaussian sigma in pixels, for High/Low Peak only |
| **Use Mask** | on | — | Ignore masked-out parts of the frame — for the centroid methods only, see below |
| **Brightness Threshold** | 128 | 0–255 | Cutoff for the centroid methods |
| **Color Distance** | 80 | 0–442 | How far a pixel may be from the target colour and still count, for *Center on Color*. 442 is "everything matches" |
| **Edit Head Only** | off | — | Only the point at the current frame can be dragged; the rest of the track fades back. See [Edit Head Only](#edit-head-only) |
| **Stabilize Centers** | on | — | See below |
| **Include Video Info Display** | off | — | Burn the readouts into a stabilized render |

All radii are in **video** pixels, not screen pixels — so they do not change when you resize
the view.

### Getting the radii right

The two circles are the whole game:

- **Track Radius too large** and the template picks up background, so the tracker starts
  following the background instead of the object. This is the usual failure on a small target
  against textured terrain.
- **Track Radius too small** and there is not enough structure to match.
- **Search Radius too small** and a fast-moving object escapes between frames.
- **Search Radius too large** and the tracker finds something else that looks similar —
  another star, another light — and jumps to it.

Start with the defaults, and if the track jumps, reduce the *search* radius first.

## Using a mask

If the object passes in front of trees, a rooftop, or a burned-in on-screen display, mask
those regions out first and leave *Use Mask* on. See [Masking](Masking.md).

**The mask only protects the centroid methods** — *Center on Bright*, *Center on Dark* and
*Center on Color*. Template Match, Optical Flow and High/Low Peak do not consult it, so
masking will not stop those from latching onto foliage. If masking is important to your clip,
use one of the centroid methods.

## Editing the track

- **Drag the cursor onto the object** to place or replace a keyframe at the current frame.
  A bare click does nothing unless it lands on the cursor or an existing keyframe — the
  keyframe is created by the drag, not the click.
- **`Delete`** or **`Backspace`** removes the keyframe under the mouse.
- Re-seeding mid-track is normal and expected — it is better than fighting the parameters.

### Edit Head Only

On a slow-moving object the track doubles back on itself, and a dozen earlier keyframes end
up sitting inside the yellow cursor. A click anywhere in that pile grabs whichever keyframe
it lands on — so trying to nudge the current point silently drags a keyframe from two seconds
ago instead, and the mistake is invisible until you scrub back.

**Edit Head Only** fixes that. With it on, the only thing a drag can move is the *head* — the
point at the current frame, inside the yellow cursor. The rest of the track still draws, so
you keep the context, but faded back: the cyan path at 25% and the other keyframes at 10%.
Clicks pass straight over them. What is bright is what you can move.

Turn it off again to go back and adjust an earlier keyframe directly.

`Delete` / `Backspace` is unaffected — it still removes the keyframe under the mouse,
whichever frame that belongs to.

---

## Stabilization

Once you have a track, Sitrec can shift every frame so the tracked point stays put. This makes
otherwise unwatchable handheld or long-lens footage legible, and makes it far easier to see
whether the object is moving relative to the background — or relative to the stars.

| Option | Effect |
|---|---|
| **Stabilize** | Shift frames so the tracked point holds still |
| **Stabilize Centers** (on) | Hold the point at the centre of the frame. With it **off**, the point holds at wherever it was on its first frame |
| **Render Stabilized** | Export the stabilized video at the original frame size — shifted content moves out of frame and is lost |
| **Render Stabilized Expanded** | Export with the canvas grown so nothing is cropped away. Use this one unless you specifically need the original dimensions |

---

## Using the result

The tracked pixel becomes a line of sight, and this is where care is needed.

The conversion from pixel offset to angle uses the **assumed field of view**, which makes the
FOV a scale factor on every off-boresight angle you measure. A 10 % FOV error is roughly a
10 % error in every angular rate, and it propagates into range, speed and acceleration.
(The scaling is exact only near the centre of frame — the conversion goes through a tangent
and an arctangent, so the relationship departs from simple proportionality toward the edges.)
The conversion also assumes a rectilinear lens, so accuracy degrades toward the frame edges,
and a cropped video has its optical axis off centre.

If there are stars in the footage, measure the field of view with the
[Star Tracker](StarTracker.md) rather than guessing it. This is the single highest-value thing
you can do to make a pixel-derived analysis trustworthy.

See [Doing Defensible Analysis](DefensibleAnalysis.md) §2.3.

---

## See also

- [Masking](Masking.md) — keep the tracker off the trees
- [Star Tracker](StarTracker.md) — measure the field of view instead of assuming it
- [Traverse Methods](TraverseMethods.md) — what to do with the line of sight once you have it
- [Keyboard Shortcuts](KeyboardShortcuts.md)
