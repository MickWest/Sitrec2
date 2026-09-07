# MQ9 Tracking Simulation

Use **Camera → MQ9 Tracking** to simulate an operator acquiring and following
a rendered scene object with the MQ9 overlay. Enable **Simulate Tracking**,
select a **Scene Object**, and choose **Acquire / Box Target**. Enable the MQ9
overlay to see the acquisition gate and tracking corners.

The simulator uses the selected object's projected size and visibility.
Crosshairs, text, and other overlay graphics cannot become targets. This mode
does not perform computer vision on a loaded video; use the video tracking
tools for that task.

## Acquisition and lock

Acquisition starts with a small square at the boresight and expands over
0.9 seconds. Its metre label estimates the square's width at the range where
the boresight intersects the terrain elevation model. It is not a measurement
of the object's diameter, and is unavailable when the ray misses the ground.

A detected candidate changes the square to four corners centered on the
target's existing screen position. The camera holds the target at that position
while the corners shrink around it. Manual tracking wobble stops at this handoff.
**Refinement (seconds)** sets the required period of confident observation,
from 0.25–5 seconds, defaulting to about 1.33 seconds. The resulting gate fits the projected object
with a small pixel margin. **Acquisition Box (pixels)** controls the initial
search area, expressed in a 640×480 sensor image.

Drag in the Look View to slew. During object tracking, slewing changes the
camera's screen offset relative to the tracked object. The tracker continues
to follow the object, which can therefore remain off-centre within the image.
The target and gate stay at that screen position until the operator moves them.
**Center Tracked Object** moves both to the image center over one second,
then continues tracking there. Dragging interrupts an in-progress centering move.

## Temporary loss and recovery

If the target leaves the visible gate, disappears behind terrain or outside
the image, or has low confidence, the tracker coasts. Its corners alternate
0.25 seconds off and 0.25 seconds on. During this period the camera follows a
prediction from the last accepted position and velocity. Rejected observations
do not update that prediction.

A confident observation inside the predicted gate resumes tracking and stops
the flashing. Three unsuccessful flashes (1.5 seconds) remove the box and
select ground tracking. The ground point is the DEM intersection of the
boresight at that moment. It remains fixed as the sensor moves, so an airborne
target can quickly leave the image through parallax.

**Simulate Low Confidence** lets you exercise temporary and permanent loss
while the object remains visible. Acquisition can also fail before refinement
finishes; a target leaving the expanding gate invokes the same loss sequence.

## Operator control

- **Manual Tracking** releases the automatic track and removes its corners.
  Dragging now slews the camera directly.
- **Ground Track** holds the current boresight's terrain intersection.
  Dragging selects a new ground point.
- **Acquire / Box Target** starts a fresh acquisition attempt.
- **Reset Simulation** clears the recorded operator actions and begins again
  at the current frame.

Operator actions are frame-based and saved with the simulation. Scrubbing
replays those actions; repeated renders of one frame do not consume flash
cycles or advance refinement. The existing camera sources resume when the
simulation is disabled.

These animations and timings are an observable-behavior simulation based on
reference footage and chosen parameters. They are not a specification of the
original sensor's firmware.

## Demonstration videos

The BotBench video generator's `--set=tracking` option creates six 30-second
scenarios: acquisition with operator offsets, partial acquisition failure,
temporary loss and recovery, loss followed by ground hold, manual takeover,
and an object leaving the acquisition gate followed by a retry. Confidence
losses and manual following are scripted for repeatable demonstrations.
The automatic tracker still decides when the candidate is inside its gate,
when refinement completes, and whether recovery succeeds.

The recording includes the tracking overlay in the MP4 and TS video. Embedded
KLV describes the actual camera after each mode transition. The tracking
corners themselves are burned into the imagery.
