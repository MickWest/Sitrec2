# Camera View Modes: Normal and Satellite

Sitrec's look camera supports two orientation modes for the PTZ (Pan-Tilt-Zoom) controller: **Normal** mode and **Satellite** mode. They serve different viewing scenarios and solve different geometric problems.

---

## Normal Mode (default)

Normal mode uses conventional **Azimuth/Elevation** angles to point the camera. Drag left/right to pan horizontally, drag up/down to tilt vertically.

**Visible sliders:**
- **Pan (Az)**: Horizontal heading in degrees (0 = north, 90 = east)
- **Tilt (El)**: Vertical tilt from the horizon (-89 to +89 degrees)
- **Roll**: Camera roll around the viewing axis
- **Zoom (fov)**: Field of view in degrees

This is the natural choice when the camera is looking roughly toward the horizon, as in aircraft-based scenarios.

![Normal mode: looking toward the horizon over terrain](images/satcam-normal-page.jpg)
*Normal mode over Los Angeles at 30,000 ft. The left panel shows the overview; the right panel shows the look camera view toward the horizon.*

### When Normal Mode Breaks Down

Normal mode suffers from **gimbal lock** when the camera points straight down (nadir) or straight up (zenith). At elevation -90 or +90, azimuth and roll become indistinguishable — small mouse drags produce wild, unpredictable rotations. This is a fundamental limitation of Euler angle representation, not a bug.

---

## Satellite Mode

Satellite mode uses a **quaternion-based** orientation system referenced to the local nadir (straight down). It is designed for overhead viewing where normal mode's gimbal lock makes the camera unusable.

When satellite mode is enabled, the Pan/Tilt/Roll sliders are hidden and replaced with:

- **Rotation**: Screen-space spin around the camera's look axis (like rotating a photograph). This is baked into the internal quaternion, so mouse drags remain screen-aligned at any rotation angle.
- **Zoom (fov)**: Field of view (always visible in both modes)

Mouse dragging pans the view in screen space — left/right and up/down always match the screen directions regardless of orientation.

![Satellite mode: nadir view looking straight down](images/satcam-satellite-page.jpg)
*Satellite mode over Los Angeles. The look camera (right panel) points straight down at nadir with no gimbal lock. Mouse dragging pans smoothly in screen space.*

---

## Switching Between Modes

### Seamless Transitions

Toggling the Satellite checkbox preserves the camera orientation as closely as possible. The current camera quaternion is captured and decomposed into the target mode's parameters.

Internally the two modes use different parameterizations of the same rotation:
- **Normal → Satellite**: The camera quaternion is factored into a nadir reference frame and a satellite quaternion, from which the internal roll/elevation/azimuth are extracted.
- **Satellite → Normal**: Azimuth, elevation, and roll are extracted from the camera's world-space direction and up vector.

**Note**: Normal mode clamps elevation to -89 to +89 degrees, so a pure nadir or zenith view cannot be exactly preserved when switching from satellite to normal mode. In practice the difference is imperceptible except at the extreme poles.

### Automatic Switching

When another controller (such as a track) is driving the camera and it reaches a near-vertical orientation (within ~0.08 degrees of nadir or zenith), Sitrec **automatically enables satellite mode** to prevent gimbal lock. This only occurs while the Manual PTZ controller is inactive — it does not trigger during manual mouse dragging.

### Manual Toggle

The **Satellite Mode** checkbox appears in the **Camera > Heading** folder, alongside the Pan, Tilt, Roll, and Rotation controls. Check it to enter satellite mode; uncheck to return to normal mode.

---

## Mouse Interaction

| | Normal Mode | Satellite Mode |
|---|---|---|
| **Horizontal drag** | Changes azimuth (world-space pan) | Rotates around camera Y axis (screen-space pan) |
| **Vertical drag** | Changes elevation (world-space tilt) | Rotates around camera X axis (screen-space tilt) |
| **Reference frame** | World north/up | Camera-local axes |
| **Rotation control** | Roll slider | Rotation slider |

In normal mode, dragging left always pans toward west regardless of camera roll. In satellite mode, dragging left always moves the view left on screen — the rotation is applied in camera-local space. The Rotation slider spins the view without affecting drag behavior, because it is part of the same quaternion.

---

## Technical Details

### Nadir Reference Frame

Satellite mode constructs a local reference frame at the camera position:
- **X axis** = local east
- **Y axis** = local north
- **Z axis** = local up (away from Earth center)

### Quaternion Composition

The camera orientation is: `nadirFrame * satQuat`

`satQuat` encodes all satellite-mode state in a single quaternion built from intrinsic ZXY Euler angles (heading, tilt, pan) with the Rotation value composed as an additional Z rotation around the look axis. Because Rotation is baked into `satQuat`, incremental mouse drags (which also modify `satQuat` directly) naturally operate in the screen-aligned frame.

### When to Use Each Mode

| Scenario | Recommended Mode |
|---|---|
| Aircraft FLIR video analysis | Normal |
| Satellite imagery comparison | Satellite |
| Drone nadir footage | Satellite |
| Horizontal scene reconstruction | Normal |
| Near-vertical viewing angles | Satellite (auto-activates when track-driven) |
| General-purpose 3D navigation | Normal |

### Serialization

The satellite mode state (on/off, internal angles, rotation) is saved and restored with custom sitches. Switching modes does not lose any orientation information — the camera direction is preserved across mode changes.
