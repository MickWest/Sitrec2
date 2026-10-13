# Video Noise Pattern Detection

**Noise Pattern Detection** (NPD) finds noise that appears again in later frames of a video.

A camera sensor makes new noise in every frame. If the same noise appears again in a later
frame, it was added to the video, for example as a noise layer that loops. NPD also finds the
repeat when the layer is cut into vertical strips that change order between repeats, and when
the layer moves sideways. An optional, slower search also finds noise texture that appears again
at a different place in the picture (see [Search offset patches](#search-offset-patches)).

Use the checkbox on the **Video → Forensics → Noise Pattern Detection** folder to show or hide
it. Open the folder to change its settings.

To scan many videos at once, use **NPD Folder Scan** in the same folder. See
[NPD Folder Scan](LoadingVideo.md#npd-folder-scan).

## How to use it

1. Load a video. NPD waits until the video has finished downloading.
2. Set **Video → Forensics → Noise Pattern Detection** to on. The results window opens, and the
   analysis starts in background workers.
3. The progress line shows each stage: decoding frames, finding held frames, preparing
   features, the lag scan, testing every frame, testing long lags, and mapping strips. With
   **Search offset patches** on, three more stages follow: reading offset-search pictures,
   searching 2-D offsets, and checking native-resolution patches.
4. Read the verdict at the top of the window.

NPD keeps features of every analyzed frame in memory. If a video needs more than 384 MB for
them, NPD asks if you want to analyze only the **A-B range** of the timeline instead.

NPD analyzes encoded video. It cannot analyze a still image or an image sequence. It needs at
least 136 usable frames. Held frames (frames that repeat the previous picture) and frames with
too little noise detail are not usable.

## The results window

All the text in the window is selectable, so you can copy any number.

### Verdict

The verdict gives one of these results:

| Result | Meaning |
|---|---|
| **The noise repeats every N frames** | The noise of each frame appears again N frames later |
| **No regular repeat. Isolated repeats at lag …** | Some lags score high, but they are not multiples of one period |
| **No repeating noise found** | No lag in the checked range scored high |
| **Cannot analyze** | The video has too few usable frames |

For a repeat, the verdict also gives:

- **Strength**: how far the score at the period is above the scores of the other lags (see
  [How the score is calculated](#how-the-score-is-calculated)). A strength above 6 is unlikely
  without a repeat. The label is **strong**, **clear** or **weak**.
- The fraction of reference frames that show the repeat, and the plane where it was found:
  luma (Y) or one of the two color-difference planes (Cb, Cr).
- **Where**: the frame ranges that match, and how many of the tested frames match.
- The **rule** of the strips, when one fits: the strips change order by an XOR of their numbers,
  the strips move round by whole strips (a cyclic shift), or the noise moves sideways. The strip
  width is given in pixels.
- The longest time after which the same noise returns.
- A note when the **picture itself** repeats (looped footage or copied frames), not only the
  noise.

If some frames could not be decoded, the verdict says **Incomplete** and gives how many frames
were left out. The result then covers the other frames only.

### Offset texture candidates

This section is under the progress line. It shows the results of
[Search offset patches](#search-offset-patches), or says that the search is off.

### Repeat score by lag

The chart shows the score of each **lag** (the number of frames between the two compared
frames). There is one curve for each search: the strip search in Y, Cb and Cr, and two searches
that compare the same position only. Lags shorter than 17 frames are not scored.

Move the pointer over the chart to read the values at a lag. Click a lag to show the best pair
of frames at that lag.

### Where the repeat is

A strip along the timeline:

| Color | Meaning |
|---|---|
| Green | The noise repeats. Brighter green means more strips match |
| Gray | Tested, no repeat |
| Hatched | Not tested |
| Yellow | The current frame |

Click or drag in the strip to move to a frame. When you release, NPD shows the pair of that
frame.

### Frame pair

Two images of the noise of a pair of frames: the **target** frame, and the earlier **source**
frame whose noise it repeats. The text above them gives the lag, how many strips match, and the
XOR or shift that fits the pair.

| Button | What it does |
|---|---|
| **◀ Previous**, **Next ▶** | Show the previous or next matching pair |
| **Go to source**, **Go to target** | Move the playhead to that frame |
| **Blink (2 Hz)** | Change between the two images twice a second |
| **Aligned** | Move the columns of the source image so that they line up with the target |
| **Show on video** | Draw the matching strips on the video (see below) |
| **Max contrast** | Set the Video Adjustments contrast to 5. Click again, or close the window, to restore the previous values |

Click a column in either image to pick that strip. Click it again to let it go.

### Details

Every number of the analysis: the video and decode mode, frame counts, the lag scan, the
matches, the strip lattice and rule, the selected pair with its strip map, and the timings of
each stage.

## Show on video

With **Show on video** on, the video view outlines the matching strips when the video is at
the target or source frame of the shown pair. A caption names the two frames and the lag.

When the video is paused at another frame, NPD shows the pair it found for that frame. If no
pair matched there, the caption says so.

Click a strip in the video to pick it, as in the pair images. A drag in the video moves the
picture as usual. With a strip picked, the video also shows the same strip from the frames one
period apart, up to four on each side. These strips are drawn through the Video Adjustments,
so they look like the video.

The outlines are hidden while the video is stabilized or rotated.

## Search offset patches

The strip search finds noise that repeats in the same rows. **Search offset patches** looks
for a patch of noise texture that appears again at a different place in the picture, moved in
any direction. It is off by default, because on a long video it can take about twenty times as
long as the strip search. Turn it on in the Noise Pattern Detection folder, then click **Run**.

The search runs after the strip search, on the CPU workers only, also when the strip search
finds no repeat. You can stop it. If it fails, the strip result stays, and the section gives
the error.

### How the search works

1. **Sample pictures.** NPD takes up to 128 distinct pictures: a continuous run of up to 64
   from the start, and the rest spread through the clip.
2. **Make residuals.** From each sampled picture, NPD subtracts the distinct picture before it
   and applies a band-pass filter, at reduced resolution. Pixels near large changes are masked.
3. **Propose offsets.** For each pair of sampled pictures that are at least 2 pictures apart
   and within **Longest lag**, NPD correlates the two residuals and proposes up to 4 offsets.
   It keeps 48 proposals for each plane (Y, Cb and Cr), spread over the range of lags.
4. **Check at full resolution.** NPD checks up to 24 candidates for each plane at the native
   resolution of the plane. A candidate must have a normalized cross-correlation of 0.6 or more,
   0.4 or more in each half of the patch, and enough texture in both patches.
5. **Screen.** A candidate is **ambiguous** when the background around it also matches, or
   when a temporal control test fails. These are screening rules, not a significance test.

The search is limited: it does not look for rotated or scaled patches, and it can miss small,
faint or unsampled patches. If it finds nothing, that does not show that there is no moved
noise.

### The candidates

The **Offset texture candidates** section gives a summary: how many candidates pass the
screening, how many were left out as ambiguous, and how many pictures and pairs were tested.
For the selected candidate it gives the two frames, the lag, the plane, the position of each
patch, the offset, the correlation, the screening values, and the two residual patches.

| Button | What it does |
|---|---|
| **◀ Previous offset candidate**, **Next offset candidate ▶** | Show the previous or next candidate |
| **Go to source**, **Go to target** | Move the playhead to that frame |
| **Show on video** | Draw the patch of the other frame next to the match on the video. The source is cyan and the target is yellow |
| **Original positions** | Draw each patch at its own position in the picture |
| **Max contrast** | As in the frame pair |
| **Residuals on video** | Draw the residuals on the video, not the original pixels |
| **Include ambiguous matches** | Also list the candidates that the screening marked as ambiguous |
| **Export overlap fade** | Save an MP4 video in which the two frames fade into each other (see below) |

The video shows one comparison at a time: the strip outlines or the offset patches. Original
pixels are drawn through the Video Adjustments.

**Export overlap fade** saves a 4-second MP4 (30 fps) of the two original frames. Each frame is
moved so that its patch is at the center, with black padding and no Video Adjustments. The
video shows the source for 0.5 s, fades to the target in 1 s, shows the target for 0.5 s, and
then does the same in reverse. While it runs, the button changes to **Cancel export**.

A candidate is a local similarity of two image patches. It does not prove that the noise was
added: scene motion and compression can also make such similarities. Examine each candidate.

## Settings

| Setting | Default | What it does |
|---|---|---|
| **Longest lag (frames)** | 256 | The longest time between two compared frames (32 to 2000). It is also limited to a quarter of the analyzed frames |
| **Strip detail** | 8 px (fast) | The width of the columns of the strip profiles. **4 px** finds narrower strips, uses twice the memory and takes about four times as long to search |
| **Vertical search** | Off | Also compare the frames moved up and down by **±1** or **±3** bands (a band is 1/45 of the picture height), for a noise layer that moves vertically. Runs on the CPU workers |
| **Search offset patches** | Off | After the strip search, also search for noise texture that appears again at a different place in the picture. Slow on a long video. See [Search offset patches](#search-offset-patches) |
| **Held frames** | Leave out | **Leave out**: held frames are not analyzed, and lags are in frames. **Count as one picture**: each run of identical frames is one picture, and lags are in pictures |
| **Frames** | Whole video | Analyze the whole video, or only the frames between the A and B markers |
| **Search on** | Fastest (measured) | Where the strip search runs: the **GPU**, the **CPU workers**, or **Fastest (measured)**, which runs the first 512 pairs on both and uses the faster one |

| Button | What it does |
|---|---|
| **Run** | Run the analysis again with the current settings. The frame features are kept, so a change of Longest lag, Vertical search or Search on does not decode the video again |
| **Stop** | Stop the analysis |
| **Export CSV** | Save the lag curves, the result of every frame, the refined pairs and any offset candidates as a CSV file |
| **Benchmark CPU and GPU** | Decode the video again on the CPU workers, and run the lag scan and the frame tests on both the CPU workers and the GPU. The times are in Details. Run the analysis to completion first |

The window, its settings and the selected pair are saved with the sitch while the window is
shown. The results are not saved: when the sitch loads, the window opens and the analysis runs
again.

## How the score is calculated

NPD decodes the video a second time in a background worker, separately from playback, and
reads the luma (Y) and color-difference (Cb, Cr) planes of every frame.

1. **Remove the picture.** From each frame, NPD subtracts the mean of the frames within 8
   frames on each side. Most of the scene changes slowly, so this leaves mostly the noise. This
   is also why lags shorter than 17 frames are not scored: those frames share part of the
   same mean.
2. **Make strip profiles.** NPD divides the frame into 45 horizontal bands and into columns 8 px
   wide (4 px with the fine setting). It adds up the pixels of each cell and keeps only the
   fine detail across the columns.
3. **Search for each strip.** For a pair of frames, NPD takes each pair of adjacent columns of
   the later frame and compares it with every position in the earlier frame. So a strip that
   was moved to a different position is still found. The comparison is a normalized
   cross-correlation: a value from -1 to 1 that shows how well two patterns agree.
4. **Score each lag.** NPD compares many reference frames with the frames at each lag, and
   averages the results to get one score for each lag. From each score it subtracts a local
   baseline: the median score of the lags within 12 on each side. Then it calculates a **robust
   z score** for each lag: how far the lag is above the median of all lags, divided by the
   typical spread (1.4826 × the median absolute deviation, which equals the standard deviation
   for normally distributed values). A few high lags change the median and the median absolute
   deviation very little, so a repeat stands out from the other lags.
5. **Find the period.** The period is the smallest lag P where the z score is 3 or more at 70%
   or more of the multiples of P (P, 2P, 3P …), and where 80% or more of the lags with a z score
   of 6 or more are multiples of P. The **strength** is the median z score at the multiples of P.
6. **Test every frame.** NPD compares each frame with the frame one period later. It also
   compares control pairs, which are one and a half periods apart. A frame matches when its
   score is more than the 95th percentile of the control scores near it, plus 0.10.
7. **Map the strips.** For some matched pairs, NPD finds the strip width and which strip of the
   source frame each strip of the target frame came from. It then tests whether one rule (XOR,
   cyclic shift or sideways movement) fits all of these pairs.

## What it tells you

- **A repeat of the noise means the noise was added.** A camera does not make the same noise
  twice. But a repeat does not show who added the noise, or why.
- **Repeated pictures are different.** If the whole picture repeats (looped footage, copied
  frames), the noise repeats with it. The verdict reports this separately.
- **Compression can make patterns.** Repeated footage and compression can also make recurring
  patterns. Examine each repeat that NPD reports.
- **Strength is a search score.** It is not a probability, and it does not prove where a video
  came from.

## See also

- [Loading and Using Video](LoadingVideo.md): the **Forensics** tools and **NPD Folder Scan**
- [Video QP Graph](VideoQPGraph.md)
- [Video Tonal Range Graph](VideoTonalRange.md)
