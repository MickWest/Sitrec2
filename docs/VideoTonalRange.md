# Video Tonal Range Graph

Open **Video → Forensics → Tonal Range Graph** to measure the recorded brightness
distribution of every video frame. Click or drag in the graph to scrub the video,
just as in the [QP Graph](VideoQPGraph.md). The graph fills progressively without
moving the playhead. Its position, theme and settings are saved while it is shown.

The default graph plots the 5th percentile (blue), median (white or black), and
95th percentile (orange). The shaded bands contain the middle 90% and middle 50%
of pixel intensities. These are distribution bands, not uncertainty intervals.
The readout gives the current frame's P5, median, P95, P95–P5 span and sample count.
Min/max and mean can be added under **Tonal Range Settings**.

Set **Display → Histogram over time** to see the full distribution. Each column
represents the intensity distribution at that time, with intensity on the vertical
axis and pixel frequency as color. Dark colors are rare values and bright colors
are common values. The color scale is logarithmic and fixed across time, from
0.001% to 10% of sampled pixels per level. If several frames occupy one screen
column, their histograms are combined for display; measurements and CSV retain
every frame. There is no temporal smoothing of the measurements.

## Masking

When **Video → Masking → Enable Mask** is on, masked pixels are excluded. Use this
to remove borders, timestamps, readouts and reticles. Changing the mask, undoing a
mask edit, or toggling Enable Mask starts a fresh analysis. The graph identifies
whether the mask is applied. Fully excluded frames produce gaps, not zero readings.

**Show Mask** and **Edit Mask** only control the mask overlay. Either shows it;
Enable Mask makes the overlay stronger when on and dimmer when off. Showing or
hiding the overlay does not change graph measurements.

## Comparing an object with the background

First measure the object's positions with **Point Track**. Enable **Tracked object**
in Tonal Range Settings to add its aperture mean (green) and local background median
(pink). **Object radius** is measured in original video pixels. An elliptical
aperture follows each measured position. The surrounding background ring spans
two to four times that radius, leaving a guard gap. The object and guard gap are
also excluded from the global histogram. All regions obey the enabled video mask.
Missing or unmeasured positions remain gaps; the graph does not guess a track.

Two other Display modes show:

- **Object − local background:** the signed intensity difference. Negative means
  that the object is darker than its surroundings.
- **Contrast / local IQR:** that difference divided by the local background's
  75th–25th percentile span. It is unchanged under an ideal shared positive linear
  gain and offset applied to unchanged samples. A zero local span gives no value.

These modes use existing tracking positions even when Tracked object is unticked.
Track changes are picked up while the graph is visible. **Recalculate** also forces
a fresh pass. Choose an aperture small enough to avoid averaging mostly background;
ensure the background ring does not cross a reticle or a different scene object.

## What the values mean

The analysis uses decoded source pixels before Sitrec adjustments, stabilization,
zoom and overlays. When the decoder exposes a Y plane, the graph reads native luma.
Higher bit depths are scaled to 0–255 and binned into 256 levels; the axis labels
that scaling. Decoder outputs without a Y plane use display RGB gray values
(`0.299 R + 0.587 G + 0.114 B`), explicitly labeled **Display gray**. The graph does
not mix these representations during one analysis. It requires an encoded video
and browser decoding support; still images and image sequences are not analyzed.

These are recorded code values, **not temperature or the sensor's dynamic range**.
AGC, scene composition, clipping and compression can all change the distribution.
Constant global percentiles do not rule out AGC. Object and background changes
that coincide suggest a relationship but do not establish a cause. The relative
contrast measure is not calibrated SNR and does not remove nonlinear or spatially
varying image processing. Keep the QP graph alongside it when assessing compression.

**Export CSV** exports the currently available per-frame values, sample counts,
mask-applied flag, representation and source bit depth. Wait for analysis to finish
for a complete export. Frames that cannot be measured have empty numeric fields.
