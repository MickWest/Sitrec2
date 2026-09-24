# Lens Ghost Case Study — the Pr055 Clip

> **Case study.** This page is a worked example of the [Lens Ghost](LensGhost.md) tool
> on one real video. It shows how the tool was set up and what the fit output. It does
> not say what the object in the video is. For the model, the controls and the fit
> method, read [Lens Ghost](LensGhost.md) first.
>
> The Lens Ghost tool is **[BETA]** and admin only.

## The footage

The clip is known as **Pr055**. It is a thermal video from the MTS sensor turret of an
MQ-9, published by Jeremy Corbell. It shows a bright round disc among clouds.

In the clip:

- the disc moves left, stops, and moves back to the right, while it drifts steadily
  down the frame;
- the clouds move in one direction only.

The Lens Ghost tool was developed on this clip, to test the reflection model
described in [Lens Ghost](LensGhost.md) against the disc's motion.

---

## Setup

1. **Custom sitch.** The clip was loaded into a custom sitch with the MQ-9 track, a
   camera line of sight (`JetLOSCameraCenter`) and an FOV. The Lens Ghost overlay is
   created automatically for admin users when these exist.
2. **Camera roll.** **Camera Motion (Background)** was run on the raw, un-stabilized
   clip. This gives the per-frame image rotation (`cameraMotionTrack.imageRot`) that
   the model uses for roll (see
   [Lens Ghost § 6](LensGhost.md#6-image-roll--how-the-ghost-can-reverse-horizontally)).
   A stabilized copy of the clip has almost no roll, and the tool warns about this.
3. **Disc track.** The disc was tracked in X and Y, with the Auto Tracker (or with
   manual keyframes in the tracking overlay).
4. **Source.** Sun.
5. **Window Lean.** Set by hand before each fit. It is not fitted.
6. **Fit.** **Fit to Disc Track** was pressed. It scans Roll Coupling and fits the
   magnification and centre offset for each axis.

---

## Geometry reported by the tool

- The Sun is about **58° off-axis**, **above** the frame, for the whole clip. Its
  direct image (`sunY`) is far off the top of the frame.
- The measured image roll changes by about **14°** over the clip.

Because the Sun is far above the boresight, its offset in the camera basis is mostly
vertical. In the model, a change in roll moves part of that offset into the horizontal
axis and back, which is how the model produces a horizontal reversal.

### Window Lean and the reflected image

The reflected source image moves with Window Lean. At frame 180 (illustrative values):

```
   lean  0° →  reflY ≈ 5232      (far below the frame)
   lean 10° →  reflY ≈ 2834
   lean 20° →  reflY ≈ 1482
   lean 30° →  reflY ≈  407      (near centre)
```

Before Window Lean was added to the model, the disc's vertical position needed a very
large Centre Offset Y. With lean in the model, a normal offset is enough.

---

## Fit results

The fit splits the disc motion into two axes:

```
   ┌─────────────┬──────────────────────────────┬───────────────────────────┐
   │ Axis        │ Driver in the model           │ Fit                       │
   ├─────────────┼──────────────────────────────┼───────────────────────────┤
   │ Y (down)    │ slew/tilt geometry + window   │ steady descent,           │
   │             │ lean — no roll needed         │ R² ≈ 0.998                │
   ├─────────────┼──────────────────────────────┼───────────────────────────┤
   │ X (sweep)   │ image roll acting on the      │ left→right reversal,      │
   │             │ large vertical Sun offset     │ R² ≈ 0.99 (measured roll) │
   └─────────────┴──────────────────────────────┴───────────────────────────┘
```

These R² values are from the tool's own **Fit quality** readout on this clip.

Other outputs:

- **Magnification X and Y** come out positive and small. The earlier mirror-only
  model (no window reflection) needed `magX ≈ −1`, where the centre offset is
  indeterminate.
- **Roll Coupling** comes out at about **0.5**: the fit needs about half of the
  measured cumulative `imageRot`. The cause is not known. A single scale factor gives
  R² ≈ 0.99, which is consistent with a linear factor (for example, rotation that is
  accumulated twice, or a sign or convention difference) and not with a large-angle
  nonlinearity. The value is left as a fitted parameter and is shown on screen.

---

## What the fit does not test

- **Disc size.** The model predicts position only. It does not predict the disc
  diameter against field angle; Disc Diameter is a free, cosmetic value.
- **Window Lean** is chosen by hand, not measured.
- **The optical design.** The model assumes a mirror telescope behind a flat window.
  The actual window material and internal layout of the turret are not inputs.

---

## See also

- [Lens Ghost](LensGhost.md) — the model, every control, and how the fit works.
