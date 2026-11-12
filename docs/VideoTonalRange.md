# Video Tonal Range Graph

The Tonal Range Graph shows how the brightness levels recorded in a video are spread out in
each frame, and how that spread changes through the clip. Use it to find where the levels
change, and to compare a tracked object with its local background. A **level** is the number
from 0 to 255 that the graph reads for a pixel. A higher level is brighter in the recorded
picture. Levels are not a measurement of the real light, and they do not give the distance,
size or power of an object. See [What the values mean](#what-the-values-mean).

Load a video file in Sitrec (see [Loading and Adjusting Video](LoadingVideo.md)), then enable
the checkbox on **Video → Forensics → Tonal Range Graph**. The graph opens in a window that you
can drag and resize. Click or drag in the graph to move to a frame, as in the
[QP Graph](VideoQPGraph.md).

Sitrec reads the whole video in the background and the graph fills in as it goes. The current
frame does not change. If you hide the graph before the analysis ends, it starts again from the
first frame when you show the graph again. The graph's position, theme and settings are saved
while it is shown.

The **Display** dropdown in the **Tonal Range Graph** folder has four modes:

- **Percentile bands**, the default, plots three lines and two shaded bands.
- **Histogram over time** shows the full distribution.
- **Object − local background** and **Contrast / local IQR** need a Point Track. See
  [Comparing an object with the background](#comparing-an-object-with-the-background).

In **Percentile bands**, the 5th percentile (blue) is the level at or below which 5% of the
pixels fall. The median is the 50% level (white in the dark theme, black in the light theme).
The 95th percentile is orange. The bands run from the 5th to the 95th percentile and from the
25th to the 75th. They show how the levels spread out in the frame. They do not show
measurement error. The readout gives the current frame's P5 and P95 (the 5th and 95th
percentiles), median, P95–P5 span and pixel count. Tick **Show mean** or **Show min/max** in the
folder to add those lines.

![A graph titled Video Tonal Range — Whole frame. The vertical axis is Recorded luma (0–255) and the horizontal axis is Frame. A blue line, a white line and an orange line run level near 36, 76 and 93, rise together between about frames 70 and 100, then run level near 41, 94 and 116. Two shades of blue fill the space between them. A yellow vertical line stands at frame 110. The text above the plot reads Frame 110: P5 41.0, median 94.0, P95 116.0, span 75.0, 921600 pixels.](docimages/video-tonal-range-percentile-bands.jpg)

This is **Percentile bands** on a generated test clip, not real footage. The clip shows a dim sky
over dark ground. From about frame 70 to frame 100, a simulated exposure change raises every level,
so all three lines rise together. The yellow vertical line marks the current frame, and the text
above the plot is the readout for that frame.

These lines describe the whole frame. A small light can cover much less than 5% of the pixels,
so it may not move P95 or the median: a 20 × 20 pixel light is 0.02% of a 1920 × 1080 frame. To
measure one object, see
[Comparing an object with the background](#comparing-an-object-with-the-background).

**Histogram over time** gives each moment one column. A histogram counts how many pixels have
each level. The level is on the vertical axis and pixel frequency is the color. Dark colors are
rare levels and bright colors are common levels. The color scale is logarithmic and fixed
across time, from 0.001% to 10% of the pixels per level. If several frames occupy one screen
column, their histograms are combined for display only. The plotted lines and the CSV keep one
value for each sitch frame, and the measurements have no temporal smoothing.

![The same window, with the plot filled by a heat map: black and dark purple for rare levels, orange and pale yellow for common levels. Two bright horizontal bands, one near level 40 and one near level 80, step up together between about frames 70 and 100, and the upper band moves to near level 100. A dim purple streak runs above them, near level 145 at the left, 180 in the middle and 240 at the right. A white line runs inside the upper band and a blue line inside the lower band. An orange line, at level 116 at frame 110, is almost the same color as the upper band. A yellow vertical line stands at frame 110. The text above the plot reads Histogram density: dark = rare, bright = common (fixed log scale, 0.001%–10% per level).](docimages/video-tonal-range-histogram.jpg)

This is **Histogram over time** on the same clip. The lower bright band is the dark ground and the
upper bright band is the sky, and both rise at the exposure change. The dim streak above them is a
small light in the sky: few pixels have those levels, so the color is dark.

This display also draws the percentile lines over the histogram. The white median line is clear.
The blue 5th percentile line runs near the level 40 grid line. The orange 95th percentile line is
at level 116 at the yellow line. It is almost the same color as the upper band, so it is hard to
see. None of the three lines follows the streak.

## What the values mean

The analysis uses decoded source pixels before Sitrec adjustments, stabilization, zoom and
overlays. It requires an encoded video and browser decoding support. Still images and image
sequences are not analyzed.

The graph reads one of two sources, and does not mix them in one analysis. The axis label of the
first two **Display** modes and the `representation` column of the CSV show which one.

- **Recorded luma:** luma is the brightness part of a video pixel, stored in the Y plane of the
  decoded frame. When the decoder exposes a Y plane, the graph reads it directly. Higher bit
  depths are scaled to 0–255 and binned into 256 levels, and the axis labels that scaling.
- **Display gray:** decoder outputs without a Y plane use display RGB gray values
  (`0.299 R + 0.587 G + 0.114 B`).

The graph does not expand limited-range video. In limited-range **Recorded luma**, black is near
level 16 and white is near level 235, so clipped white can sit near 235 and not at 255. **Display
gray** is already full range, with black at 0 and white at 255. Levels from the two sources are
not directly comparable.

Levels are decoded code values. They are **not calibrated to temperature, radiance or the
sensor's dynamic range**. A doubled level does not show a doubled light. The P95–P5 span is the
spread of levels in that frame, not the range of the sensor.

Several things change levels, and the graph alone does not show which one caused a change:

- **Automatic gain control (AGC) and automatic exposure** change how bright the camera records
  the whole scene. A phone can do this by itself during a video.
- **Scene composition:** a change in the object or in the rest of the scene.
- **Clipping:** a light too bright for the camera reaches the top of the recorded scale, and all
  brighter light records as the same level.
- **Compression** changes levels, including those of small, faint objects. For H.264 video, the
  [QP graph](VideoQPGraph.md) shows the quantization parameter (QP), a measure of compression
  loss, for the same frames.

## Masking

When **Video → Masking → Enable Mask** is on, masked pixels are excluded. See
[Masking](Masking.md). Use this to remove borders, timestamps, readouts and reticles (aiming
marks drawn on the image). Changing the mask, undoing a mask edit, or toggling Enable Mask
starts a fresh analysis. The graph title shows **Mask applied** or **Whole frame**. Ticking
**Show Mask** or **Edit Mask** does not change the graph. A frame with no pixels left gives gaps,
not zero readings.

## Comparing an object with the background

First measure the object's positions with [Point Track](PointTrack.md) (**Video → Point Track**).
Then tick **Tracked object** in the **Tonal Range Graph** folder. This adds two lines: the object
mean (green), which is the mean level inside a measuring circle at the object, and the local
median (pink), which is the median level of a background ring around it. While the graph is
visible, each change to the track starts a fresh analysis.

![The same graph with two more lines, named Object mean and Local median in the legend. The green Object mean line starts near level 122, rises to about 150 between about frames 70 and 100, and rises again to about 190 between about frames 120 and 150. The pink Local median line stays close to the white median line. After frame 100 the blue, white and orange lines run level. A yellow vertical line stands at frame 165. The text above the plot reads Frame 165: P5 41.0, median 94.0, P95 115.0, span 74.0, 921149 pixels.](docimages/video-tonal-range-tracked-object.jpg)

This is **Tracked object** ticked on the same clip, after a Point Track of the small light. At the
exposure change, the object mean and the local median rise with the whole-frame lines. From about
frame 120 to frame 150, only the light brightens: the object mean rises, and the whole-frame lines
and the local median do not. The readout gives 921149 pixels, not the 921600 of the first graph. The
end of this section explains why.

**Object radius (px)** sets the aperture, the measuring circle that follows each tracked
position. It is not the lens aperture of a camera. The radius is in original video pixels, and
the background ring spans two to four times the radius. The space from one to two times the
radius is a guard gap, which neither line uses. It keeps the edge of the object out of the
background. All regions obey the enabled video mask.

Sitrec does not draw this aperture or ring on the video. The circle that
[Frequency Analysis](FrequencyAnalysis.md) draws is a different
aperture, with its own **Object radius (px)**.

Set **Object radius (px)** so that the circle just contains the object. A larger circle averages
in background. If the object reaches past twice the radius, it enters the background ring and
changes the local median. Keep the ring clear of reticles and other scene objects.

The aperture uses the tracked positions before **Output Smoothing**. Frames with no position
remain gaps. A frame that Point Track marks as estimated (amber) is not a gap: the graph measures
at the estimated position, and neither the graph nor the CSV marks it.

The last two **Display** modes show:

- **Object − local background:** the object mean minus the local median. Negative means that the
  object is darker than its surroundings.
- **Contrast / local IQR:** that difference divided by the local background's interquartile
  range (IQR), the span from its 25th to its 75th percentile. A value of +3 means that the object
  mean is three IQRs above the local median.

These modes use existing tracking positions even when **Tracked object** is unticked.

**Contrast / local IQR** stays the same if the camera multiplies every level by one positive
number and adds one number, and the scene does not change. Clipping, nonlinear processing and
spatially varying image processing can change it. It is not a calibrated signal-to-noise ratio
(SNR). If the IQR is 0, which a dark, even sky can give, this mode shows a gap: use **Object −
local background** for those frames.

While **Tracked object** is ticked or one of these two modes is selected, Sitrec leaves the
object and guard gap out of the whole-frame values on each frame that has a position. The max
line then does not show an object that fits inside that area.

## Export and recalculate

**Recalculate** and **Export CSV** are in the **Tonal Range Graph** folder. **Recalculate** starts
a fresh analysis.

**Export CSV** saves `VideoTonalRange.csv` with the values available at that time, so wait for the
analysis to finish for a complete file. There is one row for each sitch frame, so several rows can
share one `sourceFrame`. In a row with no measurement, the statistics fields are empty.

| Columns | Meaning |
|---|---|
| `frame`, `sourceFrame` | The sitch frame, and the video frame that the row measures |
| `representation` | `luma_scaled_0_255` (**Recorded luma**) or `display_gray_0_255` (**Display gray**) |
| `sourceBits` | The decoded luma bit depth, always 8 for **Display gray** |
| `maskEnabled` | `true` when a mask was applied |
| `count` | Pixels in the whole-frame values |
| `min`, `p05`, `p25`, `median`, `p75`, `p95`, `max`, `mean` | The whole-frame values |
| `span` | `p95` minus `p05` |
| `target`, `local` | The object mean and the local median |
| `contrast`, `relativeContrast` | **Object − local background** and **Contrast / local IQR** |
| `targetCount`, `localCount` | Pixels in the aperture and in the background ring |

## See also

- [Video QP Graph](VideoQPGraph.md)
- [Masking](Masking.md)
- [Point Tracking](PointTrack.md)
- [Video Noise Pattern Detection](VideoNoisePattern.md)
- [Loading and Adjusting Video](LoadingVideo.md)
