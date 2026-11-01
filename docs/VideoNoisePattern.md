# Video Noise Pattern Detection

**Noise Pattern Detection** (NPD) finds noise that appears again in later
[frames](Glossary.md#sitrec) of a video. The **lag** is the number of frames between two compared
frames.

The random noise of a camera sensor is new in every frame. If the same noise appears again in
a later frame, it is not this random noise. It can come from a noise layer that loops, from
repeated footage or from compression. NPD also finds the repeat when the layer is cut into
vertical strips that change order between repeats, and when the layer moves sideways. An
optional, slower search also finds noise texture that appears again at a different place in the
picture (see [Search offset patches](#search-offset-patches)).

Use the checkbox on the **Video → Forensics → Noise Pattern Detection** folder to open or close
the results window. Open the folder to change its settings. You can change them only while the
checkbox is on, and the analysis starts when you set it on.

To scan many videos at once, use **NPD Folder Scan** in the same folder. It also works with the
checkbox off. See [NPD Folder Scan](#npd-folder-scan).

## How to use it

1. Load a video. NPD waits until the video has finished downloading.
2. Set **Video → Forensics → Noise Pattern Detection** to on. The results window opens, and the
   analysis starts in background workers. Keep the window open: if you close it, a running
   analysis stops.
3. The progress line shows each stage: decoding frames, finding held frames, preparing
   features, the lag scan, testing every frame, testing long lags, and mapping strips. With
   **Search offset patches** on, three more stages follow: reading offset-search pictures,
   searching 2-D offsets, and checking native-resolution patches.
4. Read the verdict at the top of the window.

NPD keeps features of every analyzed frame in memory. If a video needs more than 384 MB for
them, NPD asks if you want to analyze only the **A-B range** of the timeline, analyze the whole
video, or cancel. A-B in a label means the In/Out range. At 1920 px wide with the default
settings, this limit is about 8,400 frames.

NPD analyzes encoded video. It cannot analyze a still image or an image sequence. It needs at
least 136 usable frames. Held frames (frames that repeat the previous picture) and frames with
too little noise detail are not usable.

## The results window

All the text in the window is selectable, so you can copy any number.

![The Noise Pattern Detection window. A red dot is beside the verdict, The noise repeats every 30 frames. Below it are the Offset texture candidates section, the Repeat score by lag chart with peaks at 30, 60, 90 and 120, the Where the repeat is strip, which is green and then gray, and two Frame pair images with colored boxes around the strips. Added numbers 1 to 4 mark the dot, the shaded lags, the dashed line and a tick.](docimages/noise-pattern-results-window.jpg)

The window after a run on a generated test clip. The clip has a noise layer that loops every 30
frames and ends after frame 359, so the end of the strip in **Where the repeat is** is gray. The
layer is cut into strips, and the strips change order after each loop. The numbers are added to
this picture: **1** the red dot, **2** the shaded lags, which are not scored, **3** the dashed
line at z = 6, **4** a tick at a multiple of the period.

### Verdict

The verdict gives one of these results:

| Result | Meaning |
|---|---|
| **The noise repeats every N frames** | The noise of each frame appears again N frames later |
| **No regular repeat. Isolated repeats at lag …** | Some lags score high (a [z score](#how-the-score-is-calculated) of 6 or more), but no single period fits them. A period needs at least two multiples in the checked range, so a loop with only one multiple in the range shows here as one isolated lag |
| **No column-profile repeat found (lags 17–N frames checked)** | No lag in this range has a z score of 6 or more in any search. A column profile is a strip profile. This result has [limits](#what-it-tells-you) |
| **Cannot analyze** | The video has too few usable frames. Use a longer clip or a less compressed copy |

The dot beside the verdict is red for a repeat, amber for isolated repeats or a repeated
picture, green when no repeat is found, and gray when there is no result. This green is the
opposite of the green in the strip below and in **NPD Folder Scan**, where it marks a repeat.
An **Incomplete** result with no repeat is amber. With **Search offset patches** on, the dot is
amber for any verdict until that search is done. It stays amber if the search fails or finds
any candidate, also an ambiguous one.

For a repeat, the verdict also gives:

- **Strength**: how far the score at the period is above the scores of the other lags (see
  [How the score is calculated](#how-the-score-is-calculated)). The label is **strong** at 12 or
  more, **clear** from 6 to less than 12, and **weak** below 6.
- How many of the 24 reference frames (the frames that NPD compares at every lag) show the
  repeat, and the plane where it was found: luma (Y) or one of the two color-difference planes
  (Cb, Cr).
- **Where**: the frame ranges that match, and how many of the tested frames match.
- The **rule** of the strips, when one fits: the strips change order by an XOR of their numbers
  (each strip number is combined bit by bit with one fixed number), the strips move round by
  whole strips (a cyclic shift), or the noise moves sideways. The strip width is given in pixels.
- The longest time after which the same noise returns.
- A note when the **picture itself** repeats (looped footage or copied frames), not only the
  noise. This note is not always given: see [What it tells you](#what-it-tells-you).

If some frames could not be decoded, the verdict says **Incomplete** and gives how many frames
were left out. The result then covers the other frames only.

### What it tells you

- **A repeat shows that a pattern in the noise recurs.** Random sensor noise does not recur. A
  noise layer that loops does. Repeated footage and compression can also make recurring
  patterns. NPD has no test that separates a compression pattern from a noise layer. A repeat
  does not show who made it, or why.
- **Repeated pictures are different.** If the whole picture repeats (looped footage, copied
  frames), the noise repeats with it. The verdict adds a note when frames one period apart look
  the same and frames one and a half periods apart do not. In a still scene, those frames also
  look the same, so there is no note even if the footage loops.
- **Examine each repeat.** Use **Aligned** and **Blink (2 Hz)** in [Frame pair](#frame-pair) to
  compare the two noise images, and **Show on video** to see where the matching strips are.
- **No repeat found is a limited result.** The search covers only the lags given in the verdict.
  It does not find a noise layer that never repeats, that stays the same in every frame, or that
  loops more slowly than the longest lag. A layer that moves vertically needs **Vertical search**.
  Compression can remove noise. So this result does not show that no noise was added.
- **NPD does not test a light in the picture.** The strip search looks at the noise of whole
  frames, not at objects. A result does not show whether a particular light was added to the
  video. To examine one area of a frame, see [Error Level Analysis](LoadingVideo.md#error-level-analysis)
  and [Noise Analysis](LoadingVideo.md#noise-analysis).
- **Strength is a search score.** It is not a probability, and it does not prove where a video
  came from.

### Offset texture candidates

This section is under the progress line. It shows the results of
[Search offset patches](#search-offset-patches), or says that the search is off.

### Repeat score by lag

The chart shows the robust z score of each lag (see
[How the score is calculated](#how-the-score-is-calculated)). There is one curve for each search:
**S-Y**, **S-Cb** and **S-Cr** are the strip search in each plane, and **A-Yfine** and **A-Cbmid**
compare the same position only. The dashed line is z = 6. Lags shorter than 17 frames are not
scored, and that part of the chart is shaded. The ticks at the top mark multiples of the period.
A number above a peak is its lag. In the legend, **P=** gives the period of that curve.

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
frame whose noise it repeats. The text above them gives the lag, the number of test positions
across the frame that match, the score of the pair with its threshold, and the XOR or shift that
fits the pair. The text calls these test positions strips or probes, but the numbers do not count
the boxes. The score comes from a separate set of test positions (step 3 of
[How the score is calculated](#how-the-score-is-calculated)), so it is not the first number
divided by the second. A box of the same color marks the same strip in both images.

| Button | What it does |
|---|---|
| **◀ Previous**, **Next ▶** | Show the previous or next matching pair |
| **Go to source**, **Go to target** | Move the playhead to that frame |
| **Blink (2 Hz)** | Change between the two images. Each image shows twice a second |
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
Each outline has the color of that strip in the pair images. Its label gives the number of the
source strip: **←9** at the target frame, **9** at the source frame.

![A video frame of a blue sky over brown ground, covered with colored vertical outlines. Each outline has a label such as ←3 at the top. Near the center, a strip labelled ←9 has a white outline. Strips with thin white outlines are beside it: 3 and 33 at its left, and 93, 123, 153 and 183 at its right. The caption at the bottom reads Frame 63 shows noise from frame 33 (lag 30).](docimages/noise-pattern-show-on-video.jpg)

The test clip of the [results window](#the-results-window) at target frame 63, with the strip
**←9** picked. The white numbers 3, 33, 93, 123, 153 and 183 are the frames of the strips beside it.

When the video is paused at another frame, NPD shows the pair it found for that frame. If no
pair matched there, the caption says so.

Click a strip in the video to pick it, as in the pair images. A drag in the video moves the
picture as usual. With a strip picked, the video also shows the same strip from the frames one
period apart, up to four on each side. The picked strip has a white outline, and each of the
other strips shows its frame number in white. These strips are drawn through the Video
Adjustments, so they look like the video.

The outlines are hidden while the video is stabilized or rotated.

## Search offset patches

The strip search finds noise that repeats in the same rows. **Search offset patches** looks
for a patch of noise texture that appears again at a different place in the picture, moved in
any direction. It is off by default, because it can take many times as long as the strip
search. To use it, set the folder checkbox on, which also starts the strip search. Turn on
**Search offset patches**. When the analysis ends, or after you click **Stop**, click **Run**.

The search runs after the strip search, on the CPU workers only, also when the strip search
finds no repeat. If it fails, the strip result stays, and the section gives the error. If you
stop it, the verdict says **Stopped**. To see the strip result again, turn off **Search offset
patches** and click **Run**. This does not decode the video again.

### How the search works

1. **Sample pictures.** NPD takes up to 128 distinct pictures: a continuous run of up to 64
   from the start, and the rest spread through the clip.
2. **Make residuals.** From each sampled picture, NPD subtracts the distinct picture before it
   and applies a band-pass filter (which keeps detail of a middle size), at reduced resolution.
   Pixels near large changes are masked.
3. **Propose offsets.** For each pair of sampled pictures that are at least 2 pictures apart
   and within **Longest lag**, NPD correlates the two residuals and proposes up to 4 offsets.
   It keeps 48 proposals for each plane (Y, Cb and Cr), spread over the range of lags.
4. **Check at full resolution.** NPD checks up to 24 candidates for each plane at the native
   resolution of the plane. A candidate must have a normalized cross-correlation (a value from
   -1 to 1 that shows how well two patterns agree) of 0.6 or more, 0.4 or more in each half of
   the patch, and enough texture in both patches.
5. **Screen.** A candidate is **ambiguous** when the background around it also matches, or
   when a temporal control test (a comparison with the pictures before the two patches) fails.
   These are screening rules, not a significance test.

The search is limited: it does not look for rotated or scaled patches, and it can miss small,
faint or unsampled patches. If it finds nothing, that does not show that there is no moved
noise.

### The candidates

The **Offset texture candidates** section gives a summary: how many candidates pass the
screening, how many were left out as ambiguous, and how many pictures and pairs were tested.
For the selected candidate it gives the two frames, the lag, the plane, the position of each
patch, the offset, the correlation, the screening values, and the two residual patches.

![At the top, a video frame of a blue sky over brown ground. In the sky, a cyan box labelled 26 is beside a yellow box labelled 56, a grainy rectangle starts at the yellow box and extends up and to the right, and the caption reads Original pixels: 26 cyan, 56 yellow, offset 304, 16 px, pasted crop aligned beside match. At the bottom, the Noise Pattern Detection window with an amber dot, the verdict No column-profile repeat found, the text of Candidate 5 / 9, and two gray squares of residual noise with the same texture.](docimages/noise-pattern-offset-candidate.jpg)

A second generated test clip, at target frame 56, with **Show on video** on. The noise of a patch
appears again 30 frames later, 304 px to the right and 16 px down. The yellow box is at the place
of the patch in frame 56. The cyan box is the patch of source frame 26, drawn beside the yellow box,
not at its own place in the picture. The grainy rectangle is the noise block of the test clip, and
the yellow box is at its lower-left corner. The two gray squares are the residual patches, source
at the left and target at the right. The dot is amber because the search found candidates. In the text,
ROI (region of interest) means the patch, NCC means the normalized cross-correlation, and dx and dy
are the offset in pixels.

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
| **Longest lag (frames)** | 256 | The longest lag that NPD compares (32 to 2000). It is also limited to a quarter of the usable frames. A period is reported only up to half of the resulting lag: 128 frames at the default, and only if the video has at least 8 times the period in usable frames. A longer loop shows as one isolated lag, or is not found when it is longer than the lag |
| **Strip detail** | 8 px (fast) | The width of the columns of the strip profiles. **4 px** finds narrower strips, uses twice the memory and takes about four times as long to search |
| **Vertical search** | Off | Also compare the frames moved up and down by **±1** or **±3** bands (a band is 1/45 of the picture height), for a noise layer that moves vertically. Runs on the CPU workers |
| **Search offset patches** | Off | After the strip search, also search for noise texture that appears again at a different place in the picture. Slow. See [Search offset patches](#search-offset-patches) |
| **Held frames** | Leave out | **Leave out**: held frames are not analyzed, and lags are in frames. **Count as one picture**: each run of identical frames is one picture, and lags are in pictures |
| **Frames** | Whole video | Analyze the whole video, or only the In/Out range (**A-B range**) |
| **Search on** | Fastest (measured) | Where the strip search runs: the **GPU**, the **CPU workers**, or **Fastest (measured)**, which runs the first 512 pairs on both and uses the faster one |

| Button | What it does |
|---|---|
| **Run** | Run the analysis again with the current settings. The frame features are kept, so a change of Longest lag, Vertical search or Search on does not decode the video again. **Run** does nothing while an analysis runs: wait for it, or click **Stop** first |
| **Stop** | Stop the analysis. **Run** and **Stop** are also in the results window, beside the progress line |
| **Export CSV** | Save the lag curves, the result of every frame, the refined pairs and any offset candidates as a CSV file |
| **Benchmark CPU and GPU** | Decode the video again on the CPU workers, and run the lag scan and the frame tests on both the CPU workers and the GPU. The times are in Details. Run the analysis to completion first |

The window, its settings and the selected pair are saved with the sitch while the window is
shown. The results are not saved: when the sitch loads, the window opens and the analysis runs
again.

## NPD Folder Scan

**Video → Forensics → Noise Pattern Detection → NPD Folder Scan** opens a window that runs NPD
on many local videos. Click **Choose Folder** to pick a folder and start the scan. The scan
examines the videos in the folder and in every subfolder, one video at a time. The folder
picker needs Chrome or Edge, or the Sitrec desktop app. The scan reads the files on your
computer and does not upload them.

The scan uses the current [settings](#settings), but not **Frames**. Instead, **Limit to
(minutes)** (default 2, range 0.1 to 120) sets how much of the start of each video NPD analyzes.
If NPD leaves out the end of a video, its row shows **limited**. If that part needs more memory
than the [384 MB limit](#how-to-use-it), or has more than 512 MB of encoded video, the scan
shortens it without asking, and the row shows **auto-reduced**.

The rows with repeats come first, then the rows with offset texture candidates, then the others
by strength. A green row is **Repeating noise**. An amber row is **Repeating pictures** or, with
**Search offset patches** on, a video with offset texture candidates that pass the screening.
The table gives the period, the strength (for isolated peaks, the highest z score), the channel
(a curve name from [Repeat score by lag](#repeat-score-by-lag)), the reference coverage, and the
matched, decoded and usable frames.

- **Usable** counts the frames that NPD can use (see [How to use it](#how-to-use-it)). A video
  with too few usable frames gives the usable and held counts, not a decoding error.
- A video that Sitrec cannot read gives an error in its row. It does not count as a video with
  no repeats.
- **Details** gives every value of the row, such as the matched frame ranges, how far the repeat
  reaches, the isolated peaks and the analyzed duration.
- **Folders** gives the counts for every folder, also a folder with no videos.
- **Filter paths** narrows the table by path, and **Repeats only** keeps the green and amber
  rows. **Export CSV** saves all the rows, also the rows that these hide. The file also gives
  the analyzed duration and the offset results of each video.
- Click a video's path to open the file in a new Sitrec tab. The tab sets the In and Out frames
  to the analyzed part, and runs NPD on them with the same settings.

**Stop** ends the scan and keeps the finished rows. **Scan Again** replaces the results with a
new scan of the same folder, with the current settings. If you close the window, the scan stops
and the results are lost.

Each row is an NPD result, so [What it tells you](#what-it-tells-you) applies to it. Examine
each video that a row marks.

## How the score is calculated

NPD decodes the video a second time in a background worker, separately from playback, and
reads the luma (Y) and color-difference (Cb, Cr) planes of every frame.

1. **Make strip profiles.** NPD divides the frame into 45 horizontal bands and into columns 8 px
   wide (4 px with **Strip detail** at 4 px, and wider for video wider than 1920 px). It adds up
   the pixels of each cell and keeps only the fine detail across the columns.
2. **Remove the picture.** From each strip profile, NPD subtracts the mean of the profiles
   within 8 frames on each side, including its own. This removes what stays the same over about
   17 frames, such as burned-in text, a still scene, or a noise layer that does not change. Most
   of the scene changes slowly, so this leaves mostly the noise. This is also why lags shorter
   than 17 frames are not scored: those frames share part of the same mean.
3. **Search for each strip.** For a pair of frames, NPD takes each pair of adjacent columns of
   the later frame and compares it with every position in the earlier frame. So a strip that
   was moved to a different position is still found. The comparison is a normalized
   cross-correlation: a value from -1 to 1 that shows how well two patterns agree. A pair of
   columns is confident when its best correlation is 0.10 or more above its best correlation at
   any other position (2 or more columns away). The score of a frame pair is the fraction of the
   usable pairs of columns that are confident, from 0 to 1. The two same-position searches use
   the correlation itself as the score.
4. **Score each lag.** NPD compares 24 reference frames with the frames at each lag, and
   averages the results to get one score for each lag. From each score it subtracts a local
   baseline: the median score of the lags within 12 on each side. Then it calculates a **robust
   z score** for each lag: how far the lag is above the median of all lags, divided by the
   typical spread (1.4826 × the median absolute deviation, which equals the standard deviation
   for normally distributed values). A few high lags change the median and the median absolute
   deviation very little, so a repeat stands out from the other lags.
5. **Find the period.** NPD does this for each curve. Only the multiples of P (P, 2P, 3P …)
   from lag 17 up to the longest lag count. The period is the smallest P, 2 or more, with at
   least two such multiples, where the z score is 3 or more at 70% or more of them, and where 80%
   or more of the lags with a z score of 6 or more are multiples of P. So the period can be
   shorter than 17 frames. The **strength** is the median z score at those multiples. The verdict
   uses the curve with the highest strength.
6. **Test every frame.** NPD compares each frame with the frame one period later. It also
   compares control pairs, which are one and a half periods apart. A frame matches when its
   score reaches the larger of two values: the 95th percentile of the control scores near it
   plus 0.10, or a floor of 0.25 (0.05 for the two same-position searches). Matches up to one
   period apart form a run, and NPD drops runs shorter than two periods.
7. **Map the strips.** For some matched pairs, NPD finds the strip width and which strip of the
   source frame each strip of the target frame came from. It then tests whether one rule (XOR,
   cyclic shift or sideways movement) fits all of these pairs.

## See also

**Related checks.** [Lens Ghost](LensGhost.md): a second image from a reflection inside the
camera. [Diffraction Glare](DiffractionGlare.md): spikes around a bright point.
[Long Exposure/Stacking](LongExposure.md): what a long exposure of the simulated sky looks like.
[Video QP Graph](VideoQPGraph.md): how hard each frame was compressed.

- [Loading and Adjusting Video](LoadingVideo.md): the **Forensics** tools
- [Video Tonal Range Graph](VideoTonalRange.md)
