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

There are eight (nine on a local development build), and picking the right one matters far
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
| **Motion (Background)** | The object is *indistinguishable* from the clutter it crosses — the same brightness, the same size, the same texture. See below |
| **SAM2 (Meta)** | Segmentation-based tracking. Local builds only |

For a light in the night sky, **High Peak** or **Center on Bright** will hold on far longer
than template matching, because there is no template to match — just a blob that changes shape
frame to frame.

### Motion (Background)

Every other method asks *what does the object look like?* — and there are videos where that
question has no answer. A dot crossing a city of rooftops the same size and brightness as
itself, or a bright object crossing a desert full of equally bright rocks, defeats template
matching and the centroid methods alike, because there is nothing to lock onto.

**Motion (Background)** asks a different question: *which pixels are moving differently from
the ground around them?* The scene behind the object moves as one rigid thing as the camera
pans, so Sitrec measures that motion, predicts what the background should look like this
frame, and subtracts it. Whatever is left over is not part of the background — and that is
the object. Detection then depends on the object's motion relative to the scene rather than
on its contrast against it.

One consequence follows directly, and it is the thing to know before you reach for it:

* **An object that stops moving relative to the ground disappears.** At that moment it *is*
  part of the background as far as this method can tell. Expect it to drop out while an
  object hovers over fixed terrain, and to pick up again when it moves off. This is the one
  case where *Template Match* or a *Center on* method will do better.

A still camera is not a problem — if anything it is the easy case, because the background is
then perfectly predictable and anything moving stands out.

### Start with Analyse Object

Put the cursor on the object, pick a frame where it is clearly visible, and press
**Analyse Object**. It measures the object and sets Motion Polarity, Feature Size and Parallax
Slack to suit it, then reports how strongly the object stands out with those settings.

This matters more than it sounds, because the two ends of the range need genuinely different
numbers. A 3 px dot on a smooth sky wants Feature Size 1; a soft blob on rough desert wants 4.
Get that wrong and the object is either smoothed away before it can be found or buried in its
own noise — measured on one clip, the same footage gives a confident track at Feature Size 1
and **almost no detections** at 4. There is no single setting that serves both, which is why
this measures rather than guesses.

**It measures the frame you are on.** A target's apparent size and contrast change over a long
clip, so the best settings at the start are not always the best throughout — on one test clip
Feature Size 2 wins at frame 0 but Feature Size 4 tracks far better over the whole video. The
result therefore also lists any close alternatives. If tracking fades partway through, try one
of those, or move to a frame in the difficult stretch and analyse again.

If the object is not clearly visible where you analyse, it says so and changes nothing, rather
than committing settings measured from noise.

### Show Motion Field

Draws what the tracker actually works from: the current frame with the background's own motion
subtracted away. Mid-grey means "explained by the background", bright means "brighter than the
background predicts", and black means masked out.

It answers in one glance what the resulting track never can — whether the object stands out at
all, what else in the frame does, and whether something the tracker chased was a real feature
or an artefact. If the object is not visible in the motion field, no amount of tuning the other
settings will find it, and a different method is the answer.

**Overlay:** coloured symbology — cursors, cardinal letters, readouts — and solid black
redaction boxes are recognised and ignored, including when they drift across the frame as the
aircraft turns. **Grey or white overlay is not**, because there is nothing to tell it apart
from the picture. A white burned-in arrow or reticle that drifts across the object can
therefore capture the track; move the object's start point away from it, or use another
method for that stretch.

Changing the method **while a track is actively running clears it**. Changing it while stopped
leaves the existing track alone. Either way, choose before you invest in a long run.

---

## The controls

| Control | Default | Range | What it does |
|---|---|---|---|
| **Track Radius** | 30 | 10–100 | The inner solid circle: the template size, or the window the centroid is computed over |
| **Search Radius** | 50 | 20–300 | The outer dashed circle: how far from the last position the tracker will look |
| **Feature Size** | 4 | 1–20 | How big the thing you are tracking is, in pixels. Used by High/Low Peak and by *Motion (Background)* — see the note below |
| **Motion Polarity** | Either | — | Whether the object is brighter or darker than the background. *Either* works but is slightly noisier |
| **Motion Frame Gap** | 3 | 1–12 | How far back the background samples are taken. Raise it when the object moves slowly against the scene, so it separates from where it used to be |
| **Motion Parallax Slack** | 0 | 0–5 | Pixels of background shift to forgive. 0 for flat ground seen from above; 2–3 for hills or buildings seen at an angle, where the background cannot be cancelled exactly |
| **Motion Threshold** | 6 | 3–30 | How far above the noise a detection must be before it is believed. Lower it to hold a faint object, raise it if the track jumps to clutter |
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
*Center on Color*. Template Match, Optical Flow, Motion (Background) and High/Low Peak do not
consult it, so
masking will not stop those from latching onto foliage. If masking is important to your clip,
use one of the centroid methods.

## User points and auto points

A track holds two kinds of point, and the difference matters.

* **Auto points** are what the tracker worked out. They are drawn as the track line, marked
  green on the timeline, and can always be recomputed.
* **User points** are the ones you placed by hand, by dragging the cursor onto the object.
  They are drawn as magenta crosses, marked magenta on the timeline, and are **inviolable** —
  tracking never overwrites one, never interpolates over one, and treats each as a fresh
  starting point for what follows.

That is what makes a difficult clip workable. Where the tracker cannot see the object — a
stretch of saturated terrain, say, where a bright object is indistinguishable from bright
rocks — you place a few points by eye and track again. The tracker uses them to correct itself
and carries on between them, so you do not have to place every frame.

**Clear User Points** deletes only yours, and asks first, because nothing can recompute them.
**Clear Auto Points** deletes only the tracked ones and keeps yours, so you can re-track from
the same guidance. User points are saved with the sitch.

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
