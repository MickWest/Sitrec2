# Time, Frames and Syncing

Sitrec simulates a fixed stretch of time. It divides that time into **frames**, and every
calculation (camera position, track positions, the Sun, the stars, satellites) is done for
one frame at a time. The **Time** menu sets when that stretch of time starts, how long it
is, and how fast it runs. The **playback bar** at the bottom of the screen moves you
through it.

This page has five parts:

- **[How time works](#how-time-works)**: frames, fps, Start Time and Now Time, time zones,
  and how tracks and videos line up with the timeline
- **[The Time menu](#the-time-menu)**: every control
- **[The playback bar](#the-playback-bar)** and the [keys](#keys-for-time-and-frames)
- **[Recipes](#recipes)** for common jobs
- **[See also](#see-also)**

---

## How time works

### Frames and fps

A sitch has a number of frames, **Sitch Frames**, numbered from 0 to Sitch Frames − 1. It
also has a frame rate, **Video FPS**. The time of a frame, measured from the start, is:

> frame time = frame number ÷ fps × Simulation Speed

Simulation Speed is normally 1, so frame 300 at 30 fps is 10 seconds after the start.

When you load a video into a new (custom) sitch, Sitrec sets Sitch Frames to the number of
frames in the video, and sets Video FPS from the video file. Without a video, a new sitch
has 900 frames at 30 fps, which is 30 seconds.

The **Sitch Duration** is Sitch Frames ÷ fps. If you change the fps, the number of frames
stays the same and the duration changes.

### Start Time and Now Time

- **Start Time** is the date and time of frame 0, the first frame.
- **Now Time** is the date and time of the current frame: Start Time plus the frame time.

At frame 0 the two are the same. Both are stored in UTC.

The Year, Month, Day, Hour, Minute, Second and ms sliders in the Time menu show the **Now
Time**. When you change one of them, Sitrec keeps the current frame where it is and moves
the Start Time by the same amount. This is the easy way to sync: go to a frame where
something distinctive happens in the video, then set the date and time of that moment. The
Start Time follows.

The look view shows the Now Time in UTC and in the selected time zone. To hide this
readout, turn off **Show → Time Display in Look**.

### Time zones

Sitrec stores all times in UTC. The time zone only changes how times are **shown**.

- **Time Zone** selects the zone for the look view readout and the playback bar readout.
- **Use Time Zone in UI** also shows the date and time sliders in that zone. When it is on,
  the labels of those sliders are pink. When it is off, the sliders are UTC.

The list has fixed offsets, for example `PST UTC-8` and `PDT UTC-7`. Sitrec does not
change between standard time and daylight time for you, so select the zone that was in
effect on the date.

For a new sitch, the zone is the one that the sitch names, if it names one. If not, it is
your computer's zone **on the date of the sitch**, so an old date gets the daylight-saving
rules of that time. A saved sitch keeps its own zone.

### How tracks line up

A track file (ADS-B, KML, CSV, MISB and others) has a timestamp for each point. For each
frame, Sitrec calculates the frame's date and time, then finds the track position at that
time. Between two points it interpolates. Before the first point or after the last point,
it extends the track in a straight line from the nearest two points, so a track can seem to
continue past the end of its data.

So a track lines up with the video only when the Start Time is correct. If you change the
Start Time, all tracks move along their paths.

When you drop the first track into a new sitch, Sitrec sets the Start Time to the track's
first timestamp. It does this only while the sitch is still new. After you set the time
yourself, or load a saved sitch, or otherwise settle the sitch, new tracks do not move the
timeline. Radiosonde (wind) tracks never move it. To sync to a track by hand, use
**[Sync Time to](#sync-controls)**.

Some formats are a whole recording, not a clip (for example STANAG and BOT files). For
these, the first track also sets **Sitch Frames** to the length of the track, if the track
is shorter than 24 hours.

**MISB video with timed metadata.** When the KLV metadata in a MISB file carries a video
timestamp for each record, Sitrec pairs each record with the video frame that has the same
timestamp. It does not use the Start Time for this. The **[Timing
Analysis](#timing-analysis)** report shows which method each track uses.

### How the video lines up

The video is always frame for frame: sitch frame 0 shows video frame 0, sitch frame 100
shows video frame 100. The Start Time is the date and time of the first video frame.

- **A video with a different fps.** Video FPS comes from the video file. If you change it,
  the video still shows one video frame per sitch frame, but each frame now lasts a
  different time. So the video plays at a different speed, and the Now Time of each frame
  changes. See the recipe [My video is 29.97 fps](#my-video-is-2997-fps).
- **More Sitch Frames than video frames.** The frames after the end of the video show a
  black frame. The simulation continues.
- **Fewer Sitch Frames than video frames.** The end of the video is not used.
- **Loading a new video** sets Sitch Frames and Video FPS again, from the new video.
- **Dropped frames.** When a video has its own frame timestamps and they show a gap of
  about two frames or more, Sitrec fills each gap with copies of the frame before it. Then
  each sitch frame is one 1 ÷ fps step of real time.
- **A MISB file with conflicting rates.** Some MISB files have a labeled frame rate that is
  not the real rate. If the KLV timestamps show a different rate, Sitrec shows a **Frame
  Rate Mismatch Detected** dialog once. It recommends the real-time rate from the KLV
  timestamps. **Decide later** keeps the current rate.

---

## The Time menu

**Time**

The Time menu has the controls below. They are grouped here by what they do.

### Date and time

| Control | Default | What it does |
|---|---|---|
| **Live Mode** | Off | Keeps the simulation at the real current time. Playback pauses, and the current frame stays at the middle of the timeline while the Now Time follows the clock. It turns off when you scrub, step, or set the time. It is not saved with a sitch. Some sitches start in Live Mode |
| **startTime** | | The Start Time (the time of frame 0), in UTC, for reference. Change the time with the sliders below |
| **nowTime** | | The Now Time (the time of the current frame), in UTC, for reference |
| **Year**, **Month**, **Day**, **Hour**, **Minute**, **Second**, **ms** | The sitch's date | The Now Time. When you drag one slider past its end, the slider above it changes too (for example, Minute past 59 adds an hour). They are UTC, or the selected time zone if **Use Time Zone in UI** is on. Double-click a label to return that field to the date the sitch was loaded, saved, or set from a file |
| **Note** | Hidden | Shows only for a date that needs care: *Before 1957 - no artificial satellites existed*, or *Outside 1700-2200 - Sun, Moon and planet positions degrade*. See [Historic Skies](HistoricSkies.md) |
| **Use Time Zone in UI** | On (off for older saved sitches) | Shows the date and time sliders in the selected time zone, not UTC |
| **Time Zone** | The sitch's zone, or your computer's zone | The zone for the readouts. See [Time zones](#time-zones) |
| **Simulation Speed** | 1 | How many seconds of simulated time pass in one second of frames. Use it for a time-lapse video: if the video is 30× faster than real time, set 30. It does not change how fast the video plays. When you change it, the current frame keeps its Now Time and the Start Time moves. Range 0.01 to 1200 |

The Year slider starts at 1947. To go earlier, type the year in the box, or press **G** and
type a date. The slider then goes back to 1700.

### Sync controls

These two menus do an action and then go back to **-**, so you can select the same entry
again.

| Control | Choices | What it does |
|---|---|---|
| **Sync Time to** | **Start Time** | Sets the Start Time back to the time the sitch had when it was loaded |
| | **Now Time** | Sets the Now Time (the current frame) to the real current time |
| | *a track name* | Goes to frame 0 and sets the Start Time to the first timestamp of that track. Every loaded track is recalculated |
| **Sync Duration to** | *a track name* | Sets Sitch Frames so that the sitch lasts as long as the track: track duration × fps ÷ Simulation Speed, and at least 2 frames |

A track is added to both lists when you load it, and removed when you delete it.

### Length and frame rate

| Control | Default | What it does |
|---|---|---|
| **Sitch Frames** | The video's frame count, or the sitch's own value | The number of frames in the sitch. The slider extends when you drag it to its end. If the Out frame was on the last frame, it moves with the end |
| **Sitch Duration** | Sitch Frames ÷ fps | The same length as a time. Type `HH:MM:SS.sss`, `MM:SS`, or seconds (`45.5`). Sitrec converts it to frames at the current fps |
| **Video FPS** | From the video, or 30 | The frame rate. It changes how long each frame lasts, so it changes the duration, the playback speed, and the time of every frame after frame 0. A value you set is saved with the sitch and is used again when the sitch reloads its video. Loading a different video clears it. Range 1 to 120 |

### In, Out and playback

| Control | Default | What it does |
|---|---|---|
| **In Frame [I]** | 0 | The first frame of the playback range. Press **I** to set it to the current frame |
| **Out Frame [O]** | The last frame | The last frame of the playback range. Press **O** to set it to the current frame |
| **In-Out Pingpong** | Off | When on, playback goes forward to Out, then backward to In, and so on. When off, it goes back to In after Out. Video renders do the same |
| **Time (sec)** | | The current frame as seconds from the start (frame ÷ fps) |
| **Frame in Video** | | The current frame number |
| **Paused** | | Pauses playback. Same as **Space** |
| **Playback Speed** | 1 | Multiplies how fast frames advance when you play. 2 is twice as fast, 0.25 is quarter speed. It does not change the time of any frame. Video renders use it too, and leave out the audio when it is not 1 |

**The In and Out frames limit more than playback.** Sitrec keeps the current frame between
In and Out. If you scrub or step outside the range, the frame stops at the In or Out frame.
Video renders use only this range. Every Global Fit and the traverse analysis use only the
sightlines in this range (see [Traverse Methods](TraverseMethods.md)), and Point Track stops
at the Out frame (see [Point Tracking](PointTrack.md)). In and Out are saved with the sitch.

### Timing Analysis

**Time → Timing Analysis...** makes a text report on the timing of a MISB video: the video
frame timestamps, the KLV record intervals, gaps, drift, and whether the GPS speed agrees
with the positions. If there is more than one KLV stream, it lists all of them and shows
which one each track uses. You can copy the report or download it as
`sitrec-timing-analysis.txt`. The report does not include track or node names.

If the sitch has no MISB data, the button shows a message that says so.

---

## The playback bar

The playback bar is at the bottom of the screen. The buttons are on the left and the
timeline is on the right.

| Button | What it does |
|---|---|
| **Pin/Unpin** | Pinned (the default): the bar is always visible. Unpinned: the bar fades 2 seconds after the pointer leaves it, and comes back when you move the pointer over it |
| **Play/Pause** | Starts or stops playback |
| **Step Back** / **Step Forward** | Moves one frame and pauses. Hold to repeat |
| **Fast Rewind** / **Fast Forward** | Hold to move 10 frames per screen update. Pauses playback |
| **Jump to Start** / **Jump to End** | Goes to the first or last frame (then limited to the In and Out frames) |
| **Audio/Mute** | Mutes or unmutes the video's sound. Shows only when the video has audio |

**Scrubbing.** Click or drag on the timeline to go to a frame. This pauses playback and
turns off Live Mode. While you drag or hover, a box above the bar shows the frame number,
the time in seconds from the start, and the time of day in the selected time zone.

**In and Out markers.** The **green** line is the In frame and the **red** line is the Out
frame. Each has a small circle at the top. Put the pointer near a line (the cursor becomes a
double arrow), then drag it. In always stays before Out. **Ctrl/Cmd+Z** undoes a marker
drag.

**Resetting the markers.** Double-click the timeline to the left of the In marker to put In
back to frame 0. Double-click to the right of the Out marker to put Out back on the last
frame.

**Keyframe markers.** Some tools mark keyframes on the timeline as yellow diamonds. Click a
diamond to go to that frame.

**The video view.** Right-drag in a video view to scrub through the frames. Four pixels of
movement is one frame.

## Keys for time and frames

| Key | What it does |
|---|---|
| `Space` | Play / pause |
| `←` / `→` | Tap: one frame back / forward. Hold: move backward / forward at normal speed, and pause playback |
| `↑` / `↓` | Hold: move **backward** (`↑`) / **forward** (`↓`) at 10× normal speed. Pauses playback |
| `,` / `.` | One frame back / forward, and pause |
| `<` / `>` (Shift+`,` / Shift+`.`) | Previous / next keyframe, where a tool has marked them. Does nothing if there are none |
| `I` / `O` | Set the In / Out frame to the current frame |
| `G` | **Go To.** Type a frame number to go there and pause, or a date and/or time (`15:20`, `17:33 UTC`, `Jan 6, 2020`) to set the Now Time. Fields that you do not type stay the same. A time is read in the zone the Time menu shows, unless you add `UTC` |
| `;` / `'` (hold) | Move the Start Time back / forward by one second for each screen update. Hold `Shift` as well for ×10, or `Alt` for ×1000 |

`;` and `'` move the **Start Time**, so the current frame keeps its place and everything in
the simulation moves in time. Watch stars, the Sun, or a satellite move into position while
you hold the key. If Point Track is open, these keys also drive it.

The full list of keys is in [Keyboard Shortcuts](KeyboardShortcuts.md).

---

## Recipes

### Sync a video to a flight track

1. Load the video. Sitrec sets Sitch Frames and Video FPS from it. If the video file has a
   creation date, and the sitch time is not already set, Sitrec uses that date as the
   Start Time.
2. Load the track file. In a new sitch, Sitrec moves the Start Time to the start of the
   track. If it did not, select the track in **Time → Sync Time to**. This is only a first
   estimate: the video usually does not start at the same moment as the track.
3. Find a frame in the video where something distinctive happens: the plane passes a
   landmark, turns, or crosses another object.
4. Go to that frame. Then change the **Hour**, **Minute**, **Second** and **ms** sliders
   (or press **G** and type the time) until the simulation shows the same event on that
   frame.
5. For small corrections, hold `;` or `'` and watch the look view.
6. Check a second event near the other end of the video. If the first event lines up and
   the second does not, the fps may be wrong (see the next recipe), or the video may be
   edited.

If a track is much longer than the video and you want the whole track, select it in **Time
→ Sync Duration to**.

### My video is 29.97 fps

Most video files state their frame rate, and Sitrec reads it, so a 29.97 fps file usually
shows **Video FPS** 29.97. If a file states a wrong rate, type the correct value in **Video
FPS**. The box takes two decimal places.

Over 60 seconds, 29.97 and 30 fps differ by about 0.06 seconds. For a fast object or a long
video this can be important.

After you change the fps, the time of frame 0 does not change, but every later frame gets a
different time. So sync on an event near the start of the video, then check an event near
the end.

The rate you set is saved with the sitch.

### Trim to the interesting part

1. Go to the first frame you want, and press **I**.
2. Go to the last frame you want, and press **O**.

Or drag the green and red markers on the playback bar. Playback now loops between the two
frames (turn on **In-Out Pingpong** to go back and forth), and video renders include only
this range. The frames outside the range are still in the sitch. To use them again,
double-click the timeline outside the markers.

To remove frames from the sitch, reduce **Sitch Frames**. This removes frames from the
**end** only.

### Set the date from a photo

Drop a JPEG photo into Sitrec. If its EXIF data has a capture date, Sitrec sets the Start
Time to that date.

EXIF capture times do not always include a time zone:

- If the photo has an EXIF time zone offset (most modern phones write one), Sitrec uses it,
  and the time is correct.
- If there is no offset, Sitrec reads the time as if the photo was taken in your computer's
  time zone. If the photo was taken in a different zone, set the time yourself.

A video file's creation date is used the same way, but only when the sitch time is not
already set.

### Time-lapse video

If the video shows 10 minutes of real time in 20 seconds, it is 30× faster than real time.
Set **Simulation Speed** to 30. Each frame then advances the simulation 30 times as far,
and the video still plays at its normal speed. **Sync Duration to** takes Simulation Speed
into account.

---

## See also

- [Custom Sitch Tool](CustomSitchTool.md): building a sitch by dropping in files
- [User Interface Basics](UserInterface.md): menus, views, and the time controls in short
- [Keyboard Shortcuts](KeyboardShortcuts.md): every key
- [Loading Video](LoadingVideo.md): video formats and what Sitrec reads from them
- [Tracks and Data Sources](Tracks.md): the track formats and their timestamps
- [Historic Skies](HistoricSkies.md): dates before 1947
- [Rendering and Exporting Video](Video.md): how the In and Out frames and Playback Speed
  affect a render
