# Lens Ghost Case Study — the Pr055 Clip

> **Case study.** This page is a worked example of the [Lens Ghost](LensGhost.md) tool
> on one real video. It shows how the tool was set up and what the fit output. It does
> not say what the object in the video is. For the model, the controls and the fit
> method, read [Lens Ghost](LensGhost.md) first.
>
> The Lens Ghost tool is **[BETA]** and admin only.

## The footage

The clip is known as **Pr055**. It is a thermal video from a camera turret on an
aircraft, published by Jeremy Corbell. It shows a dark round disc among clouds.

This setup assumes an MQ-9 uncrewed aircraft with an MTS (Multi-Spectral Targeting
System) turret. That platform is an assumption, not a result of the fit. The model has
no turret input.

In the clip:

- the disc moves left, stops, and moves back to the right, while it drifts steadily
  down the frame;
- the clouds move in one direction only.

The Lens Ghost tool was developed on this clip, to test the reflection model
described in [Lens Ghost](LensGhost.md) against the disc's motion.

---

## Setup

1. **Custom sitch.** The clip was loaded into a custom sitch with the aircraft track, a
   camera line of sight (**Camera Center**), a field of view (FOV) and a start date and
   time. The date and time set the Sun direction on each frame. The Lens Ghost overlay
   is created automatically for admin users in a custom sitch.
2. **Camera roll.** **Video → Camera Motion (Background) → Analyze & Build Path** was run
   on the raw, un-stabilized clip. This gives the cumulative image rotation on each
   frame (`cameraMotionTrack.imageRot`) that the model uses for roll (see
   [Lens Ghost § 6](LensGhost.md#6-image-roll--how-the-ghost-can-reverse-horizontally)).
   A stabilized copy of the clip has almost no roll, and the tool warns about this.
3. **Disc track.** The disc was tracked in X and Y. The fit can use
   **Video → Point Track** or manual keyframes in **Traverse → Manual Tracking**.
4. **Turn on the tool.** Open **Video → [BETA] Lens Ghost** and tick the checkbox on the
   folder title (Show Ghost). The rows in the folder do not respond until it is on.
   Only **Fit to Disc Track** works with it off.
5. **Source.** Sun.
6. **Window Lean.** Set by hand before each fit. It is not fitted.
7. **Fit.** **Fit to Disc Track** was pressed. It scans Roll Coupling and fits the
   magnification and center offset for each axis.

---

## Geometry

- The Sun stays above the frame for the whole clip. The **Source geometry** row gives the
  value for the current frame, and in this sitch it read about **58° off-axis** and
  "above frame".
- The measured image roll spans about **14°** from minimum to maximum. The **Roll
  source** row shows this span while Roll Coupling is 0. After a fit, it shows the span
  multiplied by Roll Coupling, so about 7° here.

Because the Sun is far above the boresight, its offset in the camera basis is mostly
vertical. In the model, a change in roll moves part of that offset into the horizontal
axis and back, which is how the model produces a horizontal reversal.

### Window Lean and the reflected image

The reflected source image moves with Window Lean. The model computes the `reflY` values
below, and no readout shows them. The frame is 1080 pixels high, so its center is at
y = 540. At frame 180 (illustrative values):

```
   lean  0° →  reflY ≈ 5232      (far below the frame)
   lean 10° →  reflY ≈ 2834      (below the frame)
   lean 20° →  reflY ≈ 1482      (below the frame)
   lean 30° →  reflY ≈  407      (near center)
```

Before Window Lean was added to the model, the disc's vertical position needed a very
large Center Offset Y. With lean in the model, a normal offset is enough.

---

## Fit results

The fit splits the disc motion into two axes:

```
   ┌─────────────┬───────────────────────────────┬───────────────────────────┐
   │ Axis        │ Driver in the model           │ Fit                       │
   ├─────────────┼───────────────────────────────┼───────────────────────────┤
   │ Y (down)    │ slew/tilt geometry + window   │ steady descent,           │
   │             │ lean                          │ R² ≈ 0.998                │
   ├─────────────┼───────────────────────────────┼───────────────────────────┤
   │ X (sweep)   │ image roll acting on the      │ left→right reversal,      │
   │             │ large vertical Sun offset     │ R² ≈ 0.99 at Roll         │
   │             │                               │ Coupling ≈ 0.5            │
   └─────────────┴───────────────────────────────┴───────────────────────────┘
```

These R² values are from the tool's own **Fit quality** readout on this clip. Both axes
use the same Roll Coupling, so the Y figure also includes roll.

The readout also gives the X-axis RMSE (root mean square error, in pixels) and the frame
range. These values were not recorded for this fit. Neither were the Window Lean, the
tracker, or the numbers for the magnifications and center offsets, so this page cannot
give them.

Other outputs:

- **Magnification X and Y** come out positive and small.
- **Roll Coupling** comes out at about **0.5**. A value of 1 applies the measured
  cumulative `imageRot` as it is, so the fit uses about half of it. The cause is not
  known. The value is left as a fitted parameter and is shown on screen.

---

## What the fit does not test

- **Disc size.** The model predicts position only. It does not predict the disc
  diameter against field angle; Disc Diameter is a free, cosmetic value.
- **Brightness.** The model does not predict how bright the disc is, or whether it
  looks bright or dark on the display.
- **Window Lean** is chosen by hand, not measured.
- **Date, time, camera pointing and FOV** are inputs. The fit takes them as given.
- **Fit freedom.** The fit sets five numbers: Roll Coupling, and a magnification and a
  center offset for each axis. Window Lean is a sixth, set by hand. R² is measured on
  the same frames that set these numbers, and the tool was developed on this clip. The
  fit does not compare the model with another explanation of the motion.
- **Smooth tracks.** A simple curve can also reach a high R² on a track of this shape.
  On a separate track of this disc, a straight line against frame number gives
  R² ≈ 0.98 on Y and 0.36 on X. A parabola gives R² ≈ 0.997 on Y and 0.98 on X.
- **The optical design.** The model assumes a mirror telescope behind a flat window.
  The actual window material and internal layout of the turret are not inputs. The
  model has no housing, baffles or ray path, so it does not test whether sunlight at
  this angle can reach the sensor.

---

## See also

- [Lens Ghost](LensGhost.md) — the model, every control, and how the fit works.
