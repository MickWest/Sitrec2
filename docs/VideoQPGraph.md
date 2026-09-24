# Video QP Graph

The **QP Graph** shows how hard each frame of an H.264 video was compressed. It plots the
**maximum**, **mean** and **minimum** quantization parameter (QP) of every frame, against the
frame number.

You'll find it under **Video → Forensics → QP Graph**.

## What QP is

An H.264 encoder divides each picture into 16×16-pixel areas called **macroblocks**. For each
macroblock it selects a **quantization parameter** (QP) from 0 to 51. QP sets how coarsely the
encoder rounds the image data of that block:

- A **low QP** keeps fine detail and uses more bits.
- A **high QP** discards detail and uses fewer bits. Small text and thin lines become blurred or
  blocky.

An increase of 6 in QP doubles the rounding step.

The encoder does not use one QP for a whole video, and frequently not for a whole frame. It can
change QP from block to block. So each frame has a *range* of QP values, and the graph shows that
range:

| Line | Meaning |
|---|---|
| **Maximum** (orange) | The highest QP of any macroblock in the frame: the most heavily compressed area |
| **Mean** (white, or black in a light theme) | The average QP of all macroblocks in the frame. Every block has the same weight |
| **Minimum** (blue) | The lowest QP of any macroblock in the frame: the best preserved area |

There is one value for each frame and no smoothing.

## How to use it

1. Load an H.264 video (most `.mp4` and `.mov` files, and raw `.h264` files).
2. Set **Video → Forensics → QP Graph** to on.
3. Sitrec reads the whole video in the background. The graph fills in as the data arrives. A
   7,000-frame standard-definition video takes approximately 10 seconds.

The yellow line is the current frame. **Click or drag in the graph** to move to a frame. The
text above the graph gives the values of the current frame: the picture type (I, P or B), the
three QP values, and the **slice start** QP.

Double-click the graph to make it fill the window. Drag its edges to change its size.

The **◐** button in the header of the graph, to the left of the fullscreen button, changes
between a **dark** theme (white on black) and a **light** theme (black on white). The light
theme is better for a printed document: the mean line becomes black, and the maximum and
minimum lines become a darker orange and a darker blue. All graphs and 2D panels have this
button, and **Sitrec ▸ Settings ▸ Theme** sets all of them together: see
[Dark and light themes](UserInterface.md#dark-and-light-themes).

The graph and its position are saved with the sitch while the graph is shown. Its theme is
saved when you set it with the ◐ button, or when it is different from your Theme setting.

## Where the numbers come from

The values are **read from the video bitstream**. They are not an estimate made from how the
picture looks.

A browser's video decoder does not give access to QP, so Sitrec has its own reader for this
part of the H.264 format. For each slice (a coded part of a picture), the bitstream gives a
**slice start** QP. Then each macroblock can carry a change to that value (`mb_qp_delta`), and
the new value carries forward to the next block. Sitrec follows these changes through every
block of every frame. It does not rebuild any pixels, which is why it is fast.

These are the same values that FFmpeg's decoder prints with its `-debug qp` option. The Sitrec
reader was checked against FFmpeg for every macroblock of several test videos, and the results
were the same.

Three details:

- A **skipped** macroblock (one that the encoder copied from the previous picture) has no QP
  data of its own. It is reported with the QP that was in effect at that point. So its QP does
  not mean that new detail was saved there at that quality.
- A macroblock stored as raw samples (`I_PCM`, which is rare) is reported as QP 0, as FFmpeg
  does.
- For video with more than 8 bits per sample, the values include the bit-depth offset, as in
  FFmpeg (for 10-bit video the range is 0 to 63).

## What it cannot read

The graph shows a message when it cannot read a video:

- **Codecs other than H.264** (HEVC / H.265, AV1, VP9, ProRes). The QP data of these formats is
  different, and Sitrec does not read it.
- H.264 streams that use **CAVLC** entropy coding (the Baseline profile, used by some older
  phones and cameras). Sitrec reads the more common **CABAC** coding (Main and High profiles).
- **Interlaced** H.264 (field pictures or MBAFF).
- 4:2:2 and 4:4:4 chroma formats, and some rare stream features (slice groups, data
  partitioning, SP / SI slices).
- Still images and image sequences, which have no encoded video frames.

## What it tells you

- **Re-encoded video.** The graph shows the QP of the file you loaded. If a video was
  compressed more than once (for example, a download from a video-sharing site), the graph shows
  only the last encode. Damage from an earlier, heavier encode does not show in it.
- **Changes in quality through a clip.** A step up in all three lines for a range of frames
  means that the encoder had fewer bits for those frames. A higher QP means coarser
  quantization, so fine detail such as small on-screen text is reproduced less accurately.
- **QP changes within a video.** QP varies between frames and between macroblocks in a frame.
  The spread between the minimum and maximum lines shows that range inside each frame.

## See also

- [Rendering and Exporting Video](Video.md): the **Compression** section adds H.264 compression
  to an export.
- [Masking](Masking.md)
