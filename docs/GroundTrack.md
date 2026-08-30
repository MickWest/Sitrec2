# Ground Track

**Traverse → Ground Track**

A Ground Track is a set of points placed **on the ground**, at the spot the object passes in
front of. It gives you a line of sight without needing the field of view, and it puts a hard
ceiling on how far away the object was.

The idea is simple. An object seen against terrain is in front of that terrain. Mark the
hillside it crosses, the field it passes over, the stretch of coast it is silhouetted against,
and you have said two things at once:

* the object was somewhere on the line from the camera to that spot, and
* it was **no further away than that spot**.

The second half is what makes it worth doing. Most lines of sight say only "somewhere along
here"; a ground track says "somewhere along here, and not past *that*".

## How it differs from Point Track and Object Track

Sitrec has three video-derived line-of-sight sources, selected in **Traverse → LOS Source**:

| LOS Source | What is stored | Needs the FOV? |
|---|---|---|
| Camera + Point Track | a video pixel, tracked automatically | yes |
| Camera + Object Track | a video pixel, keyframed by hand | yes |
| **Camera + Ground Track** | **a place on the earth** | **no** |

The first two start from the camera's centreline and rotate it by the angle a tracked *pixel*
sits off centre, so both are only as good as the field of view you have given the camera. A
ground track needs none of that: a place is a place, so the line of sight is simply the line from
the camera to it.

That also means a ground point can be placed **from the map** in the main view, not only from the
camera's own view — useful when the video is too ambiguous to click but you know from other
evidence which road, roof or headland the object went over.

## Placing points

Turn on **Enable Ground Track**. Handles then appear in the main and look views, and:

| Gesture | What it does |
|---|---|
| **Ctrl+click** | place (or move) the point for the **current frame** |
| **click an unselected point** | select it — go to the frame it describes, and move nothing |
| **click and drag the selected point** | move it over the ground |
| **Alt+click a point** | delete it |
| **drag empty space** | orbit the view, exactly as if the editor were off |

**Selecting and moving are two separate presses.** The selected point is the red one, labelled with
its frame — it is the point the playhead is on, and the only one a drag can move. Reaching for a
point almost always means "show me that moment", so the first press only travels there; once you
are on its frame, a second press picks it up. Nothing you click can be nudged by the click that
took you to it.

Ctrl is what lets the editor share a 3D view with the camera. In a 3D view a plain press is the
start of an orbit — the view has already begun one by the time the editor hears about it — so a
plain click cannot also mean "place a point".

The usual workflow is in the **look view**, which shows the same scene the camera sees: scrub to a
frame where the object is clearly in front of something *identifiable* — a headland, a road end, a
building corner — and Ctrl+click on that feature, not on the object. Repeat at a handful of frames.
Everything in between is interpolated.

"Identifiable" is doing real work in that sentence, not just making the click easier. See
[What this is, next to tracking the object itself](#what-this-is-next-to-tracking-the-object-itself):
clicking a recognised *feature* is what makes the result independent of the camera's orientation
and field of view, while clicking the *pixel* the object sits on quietly inherits any error in
both.

Placed points appear as yellow diamonds on the frame slider, and Shift+, / Shift+. step between
them, like every other keyframe set.

## Between and beyond the keyframes

**Interpolation** — *Spline* moves the ground point smoothly through the keyframes; *Linear* goes
straight from one to the next.

**Between Points** decides what happens in the gaps. Your placed points never move either way.

*3D Position* (the default) runs a smooth curve through the placed positions and leaves it there.
Cheap — no terrain is queried at all — and the line of sight it produces is smooth, which is the
property that matters downstream. The cost is that between points the curve is not *on* the ground:
across a bay it flies over at clifftop height, so the range in between is an interpolation rather
than a measurement.

*Ground Intersection* sweeps the **direction** smoothly instead, and finds where each of those
lines of sight actually meets the ground. Every frame is then a real place with a real range. It
costs a terrain ray per frame, which is why it is not the default, and it stands itself down while
you are dragging a point so the drag stays responsive.

There is no third option that snaps the *interpolated* points onto the terrain, and that is
deliberate. It sounds right and it is wrong: because the line of sight is camera-to-point, snapping
feeds the terrain profile straight into the line of sight. A track crossing a clifftop dived down
to the shoreline and climbed back, swinging the line of sight several degrees in a few frames — and
a traversal downstream turns that into speed and acceleration that were never in the data.

A note on *Ground Intersection*. At a point you placed there is nothing to be sensitive to: the
range is the distance to a real place. Between placed points the direction is a guess, and these
rays graze. On a typical clifftop track — 6 km range, 6° of depression — the intersection moves
about a kilometre for every degree of direction, so a fraction of a degree of interpolation error
moves it hundreds of metres, and enough of it lets a ray clear the lip it was aimed at and land far
beyond. Hits that disagree badly with the smooth curve are rejected for that reason. **Read the
ceiling at the points you placed; treat the frames in between as interpolation.**

**Outside the first and last point the track holds still.** It does not carry on in a straight
line. A ground point extrapolated a few thousand frames past the evidence would be somewhere in
the next county, and the traverse downstream would faithfully follow it there. Holding at least
keeps the line of sight aimed at somewhere real — but it is not data, and the honest reading of a
ground track is the span between the points you placed. **Limit A/B to Track** moves the A and B
analysis limits in around that span so the graphs stop describing frames the track knows nothing
about.

## What this is, next to tracking the object itself

Worth being precise about, because a ground track and an object track (Point Track, or the manual
Object Track) are the same measurement written two different ways.

**The line of sight is the same line.** The ground point is on the ray through the object — that is
what "behind it" means — so at every point you place, the ground track's line of sight is *identical*
to the one you would get by tracking the object at that frame. Nothing is gained or lost there.

**But they fail in opposite directions**, and that is the whole reason to have both:

| The line of sight is built from | Object Track | Ground Track |
|---|---|---|
| what is stored | a video pixel | a place on the earth |
| the camera's position | yes | yes |
| the camera's **orientation** | yes | **no** |
| the **field of view** | yes | **no** |
| bounds the range | no | **yes** |

Once the points are placed, a ground track's line of sight is just `camera position → ground point`.
Nothing else enters. Not the field of view, not where the camera was aimed. That is a stronger
statement than it looks, because those two are usually the least certain numbers in the whole
reconstruction, and a ground track's line of sight cannot be corrupted by either of them.

**The catch is that the dependency moves earlier, not away.** Placing a point means deciding *which
piece of ground* is behind the object, and you make that decision by comparing the look view to the
video — a comparison that is only meaningful if the orientation and field of view are roughly right.
So there are two ways to place a point, and they are not equally robust:

* **Match the screen position** — click the look view at the pixel the object occupies in the video.
  Quick, but the ray through that pixel is cast using the model's orientation and field of view, so
  if either is wrong you land on the wrong piece of ground and the error is baked in.
* **Identify the feature** — recognise what the object is actually against ("the tip of that
  headland", "the near end of that runway"), then click that feature wherever the render happens to
  put it. This lands on the real feature whatever the orientation and field of view are doing.

**Pick a feature, not a pixel.** That is what buys the immunity above, and it is why a recognisable
landmark is worth scrubbing to find rather than settling for open ground.

And it is why the two together say more than either alone. An object track's line of sight is a
function of (camera position, orientation, field of view, pixel); a ground track's is a function of
(camera position, ground point). Where the two agree, the orientation and field of view that mapped
that pixel to that direction have been corroborated by geometry that never used them.

**Only the ground track puts a ceiling on the range.** For a slow, drifting object — a balloon, a
lantern — that is usually the decisive number. It converts an angular size into a real size, and it
is often the difference between "could be anything" and "under a metre across".

**Which is why the interpolation question is not cosmetic.** A balloon's signature is that it is
slow and consistent with the wind. Fake acceleration is exactly the artefact that would destroy
that reading, and terrain-snapped interpolation manufactures fake acceleration wherever the ground
is steep. Smooth line of sight first; ground contact second.

**And it tells you where the tool applies.** A ground track only says anything while the object is
*below the skyline*. The moment it rises above the ridge there is no ground behind it, the ceiling
becomes infinite, and there is nothing to place. That is why the track holds still outside the
points you placed rather than carrying on: those frames are not covered. The natural division of
labour is a ground track over the terrain-backed part of the flight and an object track over the
rest, with the ceiling from the first constraining the traversal of the whole.

One thing Sitrec does **not** do yet: nothing downstream consumes the ceiling as a constraint. It is
a readout, not a bound the traversal is held to. Read it yourself and check the traversal against it.

## Placing on buildings and objects

**Place on 3D Tiles** (on by default) puts points against the 3D building geometry — roofs, walls,
trees — rather than the smooth elevation map. This matters at short range, where the recognisable
features are usually things standing *up* off the ground: a rooftop corner placed against the
elevation map instead lands at street level, tens of metres from the thing you were pointing at.
Where no 3D tiles are loaded the pick falls back to the elevation map, which covers the whole
planet.

**Place on Objects** also allows points on the scene's own 3D objects (an aircraft, a balloon). It
is off by default, because a ground track is meant to land on the ground.

## Reading the result

**Ground Range** shows the distance from the camera to the ground point at the current frame. That
is the ceiling: whatever the object was, it was closer than this.

Select **Camera + Ground Track** as the LOS Source and every traverse method works from these
lines of sight instead of the camera centreline. The traverse methods that constrain the object to
the ground — *Ground Vehicle*, *Global Fit: Ground Object* — then put it at the far end of each
line: the answer you would get if the object *were* on the ground rather than in front of it, and
so the largest range the ground track allows.

## Cautions

* A ground track is only as good as the camera **position** and the terrain — those are the two
  things its line of sight is built from. If the camera's own position is uncertain, so is every
  line of sight drawn from it; see *Fit Camera to Points* for recovering an unknown camera.
* Marking ground *near* the object rather than directly behind it is the commonest error, and it
  biases the line of sight by exactly the angle you were off. Zoom in.
* The ceiling is a ceiling, not a measurement. An object can be far in front of the terrain it
  crosses, and nothing in the ground track says how far.

## See also

* [Traverse Methods](TraverseMethods.md) — what happens to these lines of sight next
* [Point Track](PointTrack.md) — the pixel-based tracker, and video stabilization
* [Terrain and Elevation](Terrain.md) — where the ground surface comes from
* [Doing Defensible Analysis](DefensibleAnalysis.md) — what a range ceiling does and does not license you to say
