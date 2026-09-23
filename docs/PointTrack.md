# Point Tracking

**Video → Point Track**

Point Track follows an object through the video automatically, frame by frame. It turns "there
is something moving in this footage" into a position on every frame, which becomes a line of
sight you can analyse. It can also stabilize the footage on whatever it is following.

This page has four parts:

- **A. [Simple procedures](#a-simple-procedures)** that work for most videos
- **B. [Point tracks in traverse analysis](#b-point-tracks-in-traverse-analysis)**, and how Point Track differs from Manual Tracking and Ground Track
- **C. [Stabilization and stabilized rendering](#c-stabilization-and-stabilized-rendering)**
- **D. [Handling problems](#d-handling-problems)**: what each setting does, and what to change when tracking goes wrong

---

## A. Simple procedures

### The standard procedure

This works for most videos, including small objects over moving terrain, sea or cloud:

1. Open **Video → Point Track** and press **Enable Point Track**. A yellow cursor appears over
   the video.
2. Go to the first frame you want tracked, at a moment where you can see the object.
3. **Drag the yellow cursor onto the object.** The drag places the start point. A bare click
   does nothing unless it lands on the cursor or on an existing point.
4. Check that **Tracking Method** is **Motion (Background)**, the default. See
   [Choosing a tracking method](#choosing-a-tracking-method) for the cases where another method
   is better.
5. Press **Analyse Object**. It measures the object at this frame and sets Feature Size,
   Motion Polarity, Motion Frame Gap and Motion Parallax Slack to suit it. The result shows on
   the button for a few seconds, for example *bright, size 1, gap 3, slack 0 (27 sigma)*.
6. If you only want part of the clip, set the end of the range with the **B** marker on the
   timeline (or the **O** key at that frame). Tracking stops at B.
7. Press **Start Point Track**. It runs as fast as the machine allows, from the current frame
   to B. A long HD clip takes a few minutes.
8. Scrub through the result. The cyan trail is the track. On the timeline, green marks frames
   where the object was detected, amber marks estimated frames, and magenta marks points you
   placed by hand.

Do not skip step 5. With the default settings, Motion (Background) can lose a soft object
over bright ground, or can smooth away a small dot. Analyse Object picks settings for the
object you are actually tracking.

### If the track goes wrong partway through

1. Stop the track, or let it finish.
2. Go to the last frame where the track is still on the object.
3. Press **Clear from Here**. This deletes the tracked points from the current frame to B.
4. Go forward to a frame where you can see the object again, and drag the cursor onto it. This
   is a **user point**: the tracker takes it as fact and restarts from it.
5. Press **Start Point Track** again. Frames that already have points are kept.

If a whole section is hard, press **Analyse Object** at a frame inside that section and track
it again. The best settings can change as the object's size and contrast change.

### Stepping frame by frame

Hold **`'`** to track one frame at a time at about playback speed, which is useful for watching
a difficult stretch. Hold **`;`** to go back. Note that `;` is not "tracking backwards": it
**deletes** the tracked points as it goes, so use it to undo a bad run.

### Lights at night, and stars

For a single light against a dark sky, choose **High Peak** (or **Center on Bright**) instead of
Motion (Background). There is no background texture to register, and a peak fit is more
accurate for a point of light. Set **Feature Size** to about the size of the light in pixels.

### What to expect

On the three reference clips used to test Point Track, the standard procedure tracks the
whole clip:

| Clip | Object | Result |
|---|---|---|
| Simulated aircraft video, 640×480, 900 frames | 6 px object over farmland, with a wobbling camera | every frame, within 1.7 px of the true position |
| Sea and sky with wind turbines, 1920×1080, 2981 frames | 3 px white dot, black redaction boxes | every frame, continuous lock |
| Desert, hand-held long lens, 1920×1080, 1810 frames | soft bright blob among bright rocks | every frame (79 of 1810 estimated, mostly through a saturated stretch) |

---

## B. Point tracks in traverse analysis

### From a point track to a line of sight

Sitrec turns the tracked pixel into a direction. It starts from the camera's centre line and
rotates it by the angle at which the pixel sits off the centre of the frame. To use it:

1. Track the object as in part A.
2. Set **Traverse → LOS Source** to **Camera + Point Track**.
3. Choose a method in **Traverse → LOS Traverse Method**.

Output Smoothing (see [Smoothing the output](#smoothing-the-output)) applies to the line of
sight as well as to the trail.

### Point Track, Manual Tracking and Ground Track

Sitrec has three ways to get a line of sight from a video. They are easy to confuse:

| | **Point Track** | **Manual Tracking** | **Ground Track** |
|---|---|---|---|
| Menu | Video → Point Track | Traverse → Manual Tracking | Traverse → Ground Track |
| LOS Source | Camera + Point Track | Camera + Object Track | Camera + Ground Track |
| Who finds the positions | the computer, on every frame | you, at keyframes; a curve joins them | you, at keyframes |
| What is stored | a pixel in the video | a pixel in the video | a place on the ground |
| Needs the field of view | yes | yes | no |
| Also gives | stabilization | angular size, from a second point (B) on each keyframe | an upper limit on the range |

- Use **Point Track** when the object is visible for most of the clip. It measures every
  frame, so it keeps detail that keyframes would miss.
- Use **Manual Tracking** when you need only a few well-chosen keyframes, or when you want the
  object's angular size from its two ends. Place its points with **Ctrl+click** (**Cmd+click**
  on a Mac) on the video.
- Use **[Ground Track](GroundTrack.md)** when the object passes in front of terrain you can
  identify. It needs no field of view, and it says the object was no further away than the
  ground behind it.

Two things with similar names are not part of this:

- The **Manual Tracking** button in the MQ-9 tracking simulation releases that simulation's
  automatic track. It is not the Traverse menu's Manual Tracking.
- **Video → Motion Analysis → Stabilize Video** removes camera shake from the whole frame.
  It does not follow an object. Point Track's stabilization is described in part C.

### The field of view matters

A point track is only as good as the field of view you give the camera. The conversion from a
pixel offset to an angle uses the FOV, so it scales every off-centre angle. A 10% error in the
FOV gives about a 10% error in every angular rate, and that error goes into range, speed and
acceleration. (This is exact only near the centre of the frame, because the conversion uses a
tangent.) The conversion also assumes a lens without distortion, so accuracy falls toward the
edges, and a cropped video has its optical centre off the frame centre.

If there are stars in the footage, measure the field of view with the
[Star Tracker](StarTracker.md). This is the most valuable single step for making a
pixel-based analysis trustworthy. See [Doing Defensible Analysis](DefensibleAnalysis.md) §2.3.

If you cannot trust the field of view, a [Ground Track](GroundTrack.md) avoids it.

---

## C. Stabilization and stabilized rendering

When you have a track, Sitrec can shift every frame so the tracked point stays still. This
makes shaky or long-lens footage much easier to watch. It also makes it easier to see whether
the object moves relative to the background, or relative to the stars.

1. Track the object (part A).
2. Press **Stabilize**. The video now moves so the tracked point stays fixed.
3. Use **Enable Stabilization / Disable Stabilization** to switch between the stabilized and
   the original view.
4. To save a video, press **Render Stabilized Expanded** or **Render Stabilized Video**.

| Control | What it does |
|---|---|
| **Stabilize** | Applies the current track to the video. Press it again after you change the track |
| **Enable / Disable Stabilization** | Switches the stabilized view on or off without losing it |
| **Stabilize Centers** (on) | Holds the tracked point at the centre of the view. When it is off, the point stays where it was on the first tracked frame |
| **Render Stabilized Expanded** | Exports the stabilized video on a larger canvas, so no part of the picture is cut off. Use this one unless you need the original frame size |
| **Render Stabilized Video** | Exports at the original frame size. Picture that moves outside the frame is lost, and the edges can show black |
| **Include Video Readout** | Adds the Video Readout (frame counter, time code, dates) and any visible OSD Tracker readouts to the rendered video |

Stabilization uses the smoothed output. If the stabilized video still jitters, try an
[Output Smoothing](#smoothing-the-output) of 3–5 frames and press **Stabilize** again. Between
tracked points the shift is interpolated; frames that the tracker marked as lost are shown
without a shift.

---

## D. Handling problems

### Symptoms and fixes

| What you see | Likely cause | What to do |
|---|---|---|
| **Analyse Object** says *object not clear here* | The object does not stand out at this frame, or the cursor is not on it | Move the cursor exactly onto the object, or analyse at a frame where it is clearer |
| The track follows something else nearby | A look-alike (rock, wave, light) is almost as strong as the object | Run **Analyse Object** at the frame where it went wrong. Lower **Search Radius**. Place a user point on the object and track again |
| The track jumps to on-screen text or a reticle | White or grey overlay is not recognized as overlay | Paint a [mask](Masking.md) over it and keep **Use Mask** on |
| The track drops out while the object hovers | Motion (Background) cannot see an object that is still relative to the ground | Expected. Place user points across the stop, or use *Template Match* or a *Center on* method for that section |
| Many amber (estimated) frames | The object was hard to detect, so those frames were joined by a straight line or by the camera motion | Check them. Run **Analyse Object** inside that section, or place user points |
| The track sits on the edge of the object, not its centre | A slow or large object stays in the background samples and is partly subtracted | Raise **Motion Frame Gap** |
| The track is lost during a fast pan or zoom | Background registration fails when frames overlap too little | Lower **Motion Frame Gap**. Analyse again after the zoom |
| Hilly terrain or buildings give false detections | The background cannot be cancelled exactly at an angle | Raise **Motion Parallax Slack** to 2–3 |
| A faint object keeps dropping out | Its detections are below the threshold | Lower **Motion Threshold** a little |
| The track keeps jumping to clutter | Weak peaks in clutter are accepted | Raise **Motion Threshold** |
| The marker jitters between bright parts of one object | Several peaks on the same object | Use **Output Smoothing** 3–5 |
| Dragging the current point moves an older point | Earlier points overlap inside the cursor | Turn on **Edit Head Only** |
| Template Match drifts onto the background | **Track Radius** is too big, so the template contains background | Reduce **Track Radius** |
| The object escapes between frames | **Search Radius** is too small for its speed | Increase **Search Radius** |

When nothing on this list helps, turn on **Show Motion Field**. If you cannot see the object in
the motion field, no change to the Motion settings will find it, and a different method (or
Manual Tracking) is the answer.

### Choosing a tracking method

Choosing the right method matters more than tuning the sliders.

| Method | Use it when |
|---|---|
| **Motion (Background)** | The object is small, or looks like the clutter it crosses: the same brightness, size or texture. The best general choice for aircraft and drone footage over terrain or sea |
| **Template Match** | The object has visible structure, such as an aircraft or vehicle, and the background is plain |
| **Optical Flow** | The object is textured and moves smoothly. Faster than template matching |
| **Center on Bright** | A bright point on a dark background, such as a light at night |
| **Center on Dark** | A dark point on a bright background, such as a distant object against overcast sky |
| **Center on Color** | The object is distinguished by colour rather than brightness |
| **High Peak** | A bright point where you need sub-pixel accuracy. It fits a peak instead of averaging |
| **Low Peak** | The same for dark points |
| **SAM2 (Meta)** | Segmentation-based tracking. Local development builds only |

### How Motion (Background) works

Every other method asks *what does the object look like?* In some videos that question has no
answer. A dot crossing a city of rooftops of the same size and brightness, or a bright object
crossing a desert of equally bright rocks, defeats template matching and the centroid methods.

**Motion (Background)** asks instead: *which pixels move differently from the ground around
them?* The scene behind the object moves as one rigid thing as the camera pans. Sitrec measures
that motion, predicts what the background should look like in this frame, and subtracts it.
What remains shows candidate objects, together with sensor noise and imperfect registration.
The tracker checks how strong and how consistent they are before it accepts one.

It follows that **an object that stops moving relative to the ground disappears**. While it
hovers over fixed terrain it is, as far as this method can tell, part of the background.

A still camera can make registration easier, but the object must move far enough between the
sampled frames. A slow or large object can stay in most of those samples and be partly
subtracted from itself, which leaves an edge instead of its centre. A higher **Motion Frame
Gap** helps then. A fast pan or zoom may need closer samples.

### What Analyse Object measures

**Analyse Object** tries each combination of polarity (bright or dark), parallax slack and
feature size at the cursor, and keeps the one that makes the object stand out most clearly.

The two ends of the range need very different numbers. A 3 px dot on smooth sky wants Feature
Size 1; a soft blob on rough desert wants 4. On one test clip the same footage gives a
confident track at Feature Size 1 and almost no detections at 4.

It also checks for look-alikes. The tracker accepts a detection only when it clearly beats the
next strongest thing within the Search Radius. Analyse Object measures that too. If the
strongest setting leaves nearby clutter almost as strong as the object, and another setting is
nearly as strong but separates the object clearly, it chooses that one. On one test clip,
Feature Size 2 was slightly stronger at the first frame, but it left rocks almost as bright as
the object. Feature Size 4 was as strong and stood out 14 times above them, and it tracks the
whole clip.

**It measures the frame you are on.** An object's size and contrast change through a long
clip. The console report lists close alternatives; if tracking fades later, try one of them, or
analyse again inside the difficult section. If the object is not clear where you analyse, it
says so and changes nothing.

### Show Motion Field

**Show Motion Field** draws what the tracker works from: the current frame with the
background's motion subtracted. Mid-grey means "explained by the background", bright means
"brighter than the background predicts", and black means masked out. It shows at once whether
the object stands out, what else does, and whether something the tracker followed was real.

Coloured symbology (cursors, letters, readouts) and solid black redaction boxes are recognized
and ignored, also when they move across the frame. **Grey or white overlay is not**, because
nothing tells it apart from the picture. Mask it.

### The controls

| Control | Default | Range | What it does |
|---|---|---|---|
| **Tracking Method** | Motion (Background) | — | See [Choosing a tracking method](#choosing-a-tracking-method). Changing it during a run clears the track |
| **Track Radius** | 30 | 10–100 | The inner solid circle: the template size, or the window a centroid is measured over |
| **Search Radius** | 50 | 20–300 | The outer dashed circle: how far from the predicted position the tracker looks |
| **Feature Size** | 4 | 1–20 | The size of the object in pixels. Used by High/Low Peak and Motion (Background). Set by Analyse Object |
| **Motion Polarity** | Either | — | Whether the object is brighter or darker than its background. *Either* works but is noisier; Analyse Object picks one |
| **Motion Frame Gap** | 3 | 1–12 | How many frames apart the background samples are |
| **Motion Parallax Slack** | 0 | 0–5 | Pixels of background shift to forgive: 0 for flat ground seen from above, 2–3 for hills or buildings seen at an angle |
| **Motion Threshold** | 6 | 3–30 | How far above the noise a detection must be before it is accepted |
| **Use Mask** | on | — | Ignore masked parts of the frame (Motion and the *Center on* methods) |
| **Brightness Threshold** | 128 | 0–255 | Cut-off for the *Center on* methods |
| **Color Distance** | 80 | 0–442 | For *Center on Color*: how far a pixel's colour may be from the target colour. 442 matches everything |
| **Output Smoothing** | Off | Off, 2–10 frames | Smooths the output track; see below |
| **Edit Head Only** | off | — | Only the point at the current frame can be dragged; see below |
| **Clear from Here** | — | — | Delete tracked points from the current frame to B |
| **Clear User Points** / **Clear Auto Points** | — | — | Delete only your points (asks first), or only the tracker's |

Track Radius and Search Radius are in **original video** pixels, so they do not change when you
resize the view or when the video plays at a lower resolution. Feature Size and Parallax Slack
are in the pixels actually analysed, so run **Analyse Object** again after you change the
analysis resolution.

### Analysis resolution

**Analysis Resolution** defaults to **Original (no limit)**, so small objects are measured with
every source pixel, even when Settings limits normal playback to 720p. **Use Settings** follows
the playback limit; a smaller size is faster and uses less memory. **Analysis pixels** shows the
size in use and warns when it is smaller than the source.

Changing this, or the Settings video limit, clears the decoded frames. A running analysis
stops, so it cannot mix measurements made at two resolutions; start it again. Existing points
keep their original video coordinates.

### Using a mask

If the object passes in front of trees or a rooftop, or near burned-in on-screen text, mask
those areas and keep **Use Mask** on. See [Masking](Masking.md). Motion (Background) and the
*Center on* methods use the mask; Motion also leaves masked pixels out of the camera
registration and the background model. Template Match, Optical Flow and High/Low Peak do not
use the mask.

### User points and auto points

A track holds two kinds of point:

- **Auto points** are what the tracker found. Detections are green on the timeline; estimated
  points are amber. Both can be recomputed.
- **User points** are the ones you place by dragging the cursor onto the object. They are drawn
  as magenta crosses and marked magenta on the timeline. Tracking never overwrites them, never
  interpolates over them, and restarts from each one.

Where the tracker cannot see the object, place a few user points by eye and track again. It
continues between them, so you do not have to place every frame. A wrong user point is worse
than none, because nothing will correct it.

**Clear User Points** deletes only yours and asks first. **Clear Auto Points** deletes only the
tracked points, so you can track again from the same guidance. User points are saved with the
sitch.

### Leaving the frame and coming back

While Motion (Background) searches for a lost object, the missing frames stay empty. The marker
stays at the last known position, with **target not found** beside the frame number. No guessed
position is added during the loss.

A return needs a second consistent detection, or a user point. Then Sitrec estimates the path
between the two observations, using the measured camera motion. These points are marked
**estimated** (amber). They are reconstructions, not observations: turns, acceleration,
parallax or registration errors can make them wrong. If the camera registration fails, an
off-screen gap stays empty. A return inside the frame is joined with a straight line, also
marked estimated.

The tracker also searches the whole area from time to time. A return found that way needs three
consistent sightings and a matching feature in the raw image. Mask readouts and reticles before
you track a cluttered clip.

**Background: stationary** in the status means the camera is locked on the scenery. The tracker
keeps the object's motion relative to the scenery through a pan–lock–pan change. **Registration
unavailable** is different: it means the camera motion could not be measured, not that the
camera stopped.

### Smoothing the output

**Output Smoothing** is **Off** or **2–10 frames**. Try 3–5 frames when the point jumps between
bright parts of the same object. The centred average reduces that jitter without moving a steady
track forward or back in time. Longer windows also soften real changes in motion.

Smoothing changes the trail, the graphs, the line of sight, stabilization and stabilized
exports. It does not change the raw points; choose **Off** to see them. User points stay exactly
where you placed them, and smoothing does not reach across a user point or an empty gap.

Smoothing gives a steadier reference point. It does not find the object's true centre, and it
does not repair a track that has followed a different object.

### Editing the track

- **Drag the cursor onto the object** to place or replace the point at the current frame.
- **`Delete`** or **`Backspace`** removes the point under the mouse.
- Placing new points partway through a track is normal. It is usually better than fighting the
  settings.

### Edit Head Only

When an object moves slowly, the track doubles back and many earlier points sit inside the
yellow cursor. A drag then grabs whichever point it lands on, which can move a point from two
seconds ago without you noticing.

With **Edit Head Only** on, a drag can move only the point at the current frame. The rest of the
track is still drawn, but faded: the cyan path at 25% and the other points at 10%. Clicks pass
over them. `Delete` / `Backspace` still removes the point under the mouse. Turn it off to adjust
an earlier point directly.

---

## See also

- [Ground Track](GroundTrack.md) — a line of sight from places on the ground, with no field of view needed
- [Masking](Masking.md) — keep the tracker off overlays, trees and buildings
- [Star Tracker](StarTracker.md) — measure the field of view instead of assuming it
- [Traverse Methods](TraverseMethods.md) — what to do with the line of sight
- [Doing Defensible Analysis](DefensibleAnalysis.md)
- [Keyboard Shortcuts](KeyboardShortcuts.md)
