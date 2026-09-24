# Lens Ghost — Simulating a Sun Reflection in a Mirror Telescope

> **[BETA] — admin only.** The Lens Ghost overlay and the companion "MQ-9 Light Path"
> 3D view are experimental and currently created only for admin users. In the live UI
> both carry a "[BETA]" prefix: the overlay folder is **Video → [BETA] Lens Ghost**, and
> the 3D view is **[BETA] MQ-9 Light Path** in the Views menu.

## What this is

A **lens ghost** is an image formed by light that reflects off internal optical
surfaces — lens faces, a window, a filter — before it reaches the sensor. The main
image of a source is formed by light that passes straight through the optics; a ghost
is formed by the small fraction that is reflected an even number of times on the way.
Because the reflected light takes a different path, a ghost is usually out of focus
(a disc or blob rather than a point), much fainter than the source, and placed in the
frame according to the **direction of the bright source relative to the camera**,
not according to the scene. In a rotationally symmetric optic, a ghost lies on the
line through the source's image position and the optical centre. A ghost can appear
when the source itself is outside the frame.

The **Lens Ghost** tool (`CNodeLensGhost`) draws a *simulated* sun (or moon)
reflection — a "ghost" disc — as an overlay on a video, and can fit that model to a
tracked disc in the footage. The overlay is labelled **"PREDICTED sun ghost"** so it
is not mistaken for anything in the video.

This document explains how the ghost position is computed, what each control does,
and what the fit outputs. For a worked example on a real clip, see
[Lens Ghost Case Study](LensGhostCaseStudy.md).

The tool is created in custom sitches that have a video, a camera line of sight and
an FOV.

---

## 1. The optical model

The model assumes a **catadioptric** (mirror, Cassegrain-type) telescope with a long
focal length and a narrow field of view, behind a **flat protective window**. Window
materials differ in refractive index, and a higher index gives a higher surface
reflectance (for example, germanium, n ≈ 4.0, reflects much more than glass). In
daytime scenes the Sun is by far the brightest source, so even a faint internal
reflection of it can show as a bright disc.

![Sun ghost in a catadioptric telescope](docimages/lensghost-optics.png)

In the model:

- The ghost is a **defocused disc** — the reflected cone refocuses at the wrong
  plane, so it is an out-of-focus image of the circular aperture. The tool draws a
  round disc. A central dark spot (a "donut") can be added for the secondary-mirror
  obstruction.
- The ghost's position on the sensor is set by the **Sun direction relative to the
  camera**, not by the scene. As the camera slews, the ghost follows the Sun's
  position relative to the boresight, so it can move *against* the background.

---

## 2. Coordinate conventions

Everything is computed in **original-video pixels**, with the principal point at the
frame centre, matching `CNodeTrackingOverlay`'s pixel↔angle convention (including the
`fovCoverage` letterbox correction) so the ghost and the disc track share one scale.

```
   (0,0) ┌───────────────────────────┐
         │                           │      x → right   (increasing)
         │            • (cx,cy)      │      y → down    (increasing)
         │         frame centre      │      cx = origW/2,  cy = origH/2
         │                           │
         └───────────────────────────┘ (origW, origH)
```

The camera basis per frame comes from the line-of-sight node
(`JetLOSCameraCenter.getValueFrame(f)`):

```
   heading  — the boresight (optical axis), points where the camera looks
   right    — image +x axis  (already includes the camera's roll)
   up       — image +y axis  (already includes the camera's roll)
```

The focal length in pixels:

```
   fpx = origH / ( 2 · tan(vFOV_adjusted / 2) )
   vFOV_adjusted = 2 · atan( tan(vFOV/2) / fovCoverage )
```

---

## 3. Where the Sun *would* image (the gnomonic projection)

Let **s** be the unit vector toward the Sun (ECEF, from `getCelestialDirection`).
Decompose it in the camera basis:

```
   sf = s · heading     (component along the boresight; sf > 0 means in front)
   sr = s · right       (horizontal component)
   su = s · up          (vertical component)
```

The Sun's *direct* image (where it would appear if it were in frame) is the standard
pinhole/gnomonic projection:

```
   sunX = cx + fpx · (sr / sf)
   sunY = cy − fpx · (su / sf)      ( − because image y is down, world up is +su )
```

![Gnomonic projection of the off-axis Sun](docimages/lensghost-frame.png)

When the Sun is far off-axis, `sunX`/`sunY` lie outside the frame. The ghost can
still be inside it.

---

## 4. The flat-window reflection (with adjustable lean)

The ghost is formed by reflecting the Sun off the **flat front window**. The window
normal **n** is the boresight tilted forward by the **Window Lean** angle (θ, 0–30°)
about the camera's *right* axis. In camera-basis components:

```
   n = (0, sin θ, cos θ)        in (right, up, heading)
```

![Window lean and the 2-theta reflection rule](docimages/lensghost-window-lean.png)

Reflect the Sun direction across the window plane (mirror through the plane whose
normal is **n**):

```
   r = s − 2 (s · n) n
```

and project **r** the same way to get the **reflected source image**:

```
   reflX = cx + fpx · (r·right / r·heading)
   reflY = cy − fpx · (r·up    / r·heading)
```

- At **θ = 0** (window perpendicular to the boresight) this is simply the **mirror of
  the Sun image through the frame centre**.
- A tilted flat mirror obeys the **2θ rule**: tilting the window by θ rotates the
  reflected ray by **2θ**, so increasing the lean shifts the reflected image — and
  hence the ghost — mostly **vertically** (because the lean is in the vertical plane).
  In the model, the lean angle produces a vertical offset of the ghost. Before lean
  was added, a large principal-point offset was needed instead. Window Lean is set by
  hand; it is not measured or fitted.

---

## 5. The ghost: magnify the reflection about the principal point

The curved telescope mirror(s) give the reflection optical power (a magnification),
and the principal point may be offset from the frame centre:

```
   pX = cx + centerOffsetX        (principal point)
   pY = cy + centerOffsetY

   ghostX = pX − magX · (reflX − pX)
   ghostY = pY − magY · (reflY − pY)
```

![Building the ghost in pixel space](docimages/lensghost-construction.png)

`magX` and `magY` are **anisotropic** — they can differ because a tilting flat window
introduces direction-dependent (keystone-like) stretching. With the reflection now
modeled explicitly (Section 4), the fitted magnifications can come out **positive and
small**, instead of the `magX ≈ −1` that the earlier "mirror-through-centre only" model
needed.

A defocused disc of diameter `diameter` (px) is drawn at `(ghostX, ghostY)`, with an
optional central obstruction (`obstruction`, the secondary-mirror donut) and a soft
edge (`softness`).

---

## 6. Image roll — how the ghost can reverse horizontally

As the camera slews, the boresight can sweep **monotonically** past the Sun, so the
background only moves one way. The ghost can still move one way, stop, and come back.
In the model, this comes from image roll.

The camera's **image roll** φ (rotation about the boresight, measured from the
video's optical flow — `cameraMotionTrack.imageRot`) rotates the basis, which rotates
the Sun's large *off-axis* offset between the horizontal and vertical axes:

```
   sr' =  sr·cos φ + su·sin φ
   su' =  su·cos φ − sr·sin φ
```

When the Sun is far above (or below) the boresight, `su` is large. As φ changes, part
of that large vertical offset moves into the horizontal channel and back again. This
can produce a horizontal reversal even though the boresight never reverses.

![Image roll makes the disc reverse horizontally](docimages/lensghost-roll.png)

The amount applied is `rollScale × imageRot`. If the recreation's camera already
carries the measured roll (via the **Camera Motion (Background) → Recovered roll**
option) the LOS basis includes it and `rollScale` can stay 0; otherwise `rollScale`
supplies it from the motion track.

---

## 7. Fitting to a tracked disc

`Fit to Disc Track` does a least-squares fit of the model to a manual/auto disc
track. The track source is, in priority order:

1. the **Auto Tracker** (`CObjectTracking`, the "Camera + Point Track" cursor) —
   gives both X and Y;
2. a manual **`CNodeTrackingOverlay`** track.

Because the ghost is **linear** in the reflected source image position `(reflX,reflY)`
for a fixed lean and roll, the fit is cheap:

```
   for each candidate rollScale k:
       compute reflX, reflY per frame  (apply roll k·imageRot, then reflect off the window)
       linear-fit  trackX = A + B·reflX   →  magX = −B,  pX = A/(1−B)
       linear-fit  trackY = A'+ B'·reflY  →  magY = −B', pY = A'/(1−B')
   keep the k with the lowest combined RMSE
```

The scan runs `k` from −3 to 3 in steps of 0.1, then refines in steps of 0.01 around
the best value. Frames where the source is behind the camera, or within 5° of the
focal plane, are skipped.

`Window Lean` is a **manual** parameter (set it, then fit). An axis whose track has no
variance (e.g. an X-only track) is skipped and left unchanged.

The fit writes its results into the controls: **Roll Coupling**, **Magnification X/Y**
and **Centre Offset X/Y**. It then turns on **Show Ghost** and **Show Geometry**. The
**Fit quality** row shows the X-axis R² and RMSE (in pixels), the number of frames
and the frame range, and the Y-axis R² (or "X only"). It also flags:

- **rollScale hit the scan edge** (no real roll signal to fit);
- **magX ≈ −1 degeneracy** (principal point indeterminate — see below).

The **⚠ Warning** row and the HUD show one warning at a time, most severe first: the
Sun is behind the camera; the video looks **stabilized** (Roll Coupling is non-zero
but the camera roll span is under 0.5°); roll is applied twice (camera-motion
orientation is on and Roll Coupling is non-zero); or `magX ≈ −1`.

---

## 8. Parameters

```
   Source           celestial body (Sun / Moon)                 — MEASURED direction
   Window Lean°     0–30°, forward tilt of the flat window       — physical / set by hand
   Roll Coupling    rollScale × imageRot applied to the basis    — FITTED (or 0 if LOS rolls)
   Magnification X  horizontal magnification (curved mirror)     — FITTED
   Magnification Y  vertical magnification (anisotropy)          — FITTED
   Centre Offset X  principal-point offset, px                   — FITTED (n/a near magX=−1)
   Centre Offset Y  principal-point offset, px                   — FITTED
   Disc Diameter    defocus disc size, px                        — ASSUMED (cosmetic)
   Obstruction      central donut ratio (secondary mirror)       — ASSUMED (cosmetic)
   Edge Softness    disc edge softness                           — cosmetic
   Opacity, Colour  appearance                                   — cosmetic
```

The overlay also shows an on-video **HUD** (Sun az/el + off-axis angle, roll
provenance, fit R²/RMSE, warnings), a **reflection line** (source → optical centre →
ghost), an off-frame **Sun arrow**, and a **"PREDICTED sun ghost"** label so the
modelled disc is never mistaken for the tracked object.

The display toggles in the folder:

```
   Show Ghost       draw the modelled ghost (off by default; Fit to Disc Track turns it on)
   Show Geometry    the reflection line and optical-centre marker (on by default)
   Mark Source      mark where the source itself images, or an edge arrow (off by default)
   Show HUD         the on-video readout block (on by default)
```

Below **Fit to Disc Track** are four read-only rows: **Sun geometry**, **Roll source**,
**Fit quality** and **⚠ Warning** — the same information as the HUD.

---

## 9. The MQ-9 light-path 3D view

A companion bespoke 3D view ("[BETA] MQ-9 Light Path", in the Views menu — see
`BespokeView.js`) shows a close-up of the MQ-9 with the **boresight** (where the MTS
looks) and the **incoming sun ray** drawn from the turret, so the angle between
them is visible in 3D and animates over the clip.

---

## 10. Limitations & open questions

- **Stabilized footage has no roll.** If the loaded video was stabilized (camera
  motion removed), `imageRot ≈ 0` and the horizontal reversal cannot be reproduced
  from that clip — fit the **raw** clip instead. The tool detects and warns about this.
- **Roll Coupling is fitted, not derived.** The amount of measured roll the model
  applies is a free scale factor. Its value is shown on screen.
- **magX ≈ −1 degeneracy.** With the older mirror-only model the principal-point
  offset blew up near `magX = −1`; modeling the window reflection explicitly removes
  the need for that regime, but the guard/label remains.
- **Disc size is not predicted.** The model predicts position only. The disc
  **diameter** vs field angle is not modelled; the current model treats it as a free
  constant.
