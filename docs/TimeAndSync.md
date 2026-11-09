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
- **[Timing Analysis](#timing-analysis)**: a text report on the timing of a
  [MISB](Glossary.md#data-formats-and-sources) video

---

## How time works

### Frames and fps

A sitch has a number of frames, **Sitch Frames**, numbered from 0 to Sitch Frames − 1. It
also has a frame rate, **Video FPS**. The time of a frame, measured from the start, is:

> frame time = frame number ÷ fps × Simulation Speed

Simulation Speed is normally 1, so frame 300 at 30 fps is 10 seconds after the start.

When you load a video into a new (custom) sitch, Sitrec sets Sitch Frames to the number of
frames in the video, and sets Video FPS from the video file. Without a video, a new sitch
has 900 frames at 30 fps, which is 30 seconds. If the video file records when and where it was
made, as most phone videos do, Sitrec also sets the Start Time and the camera position. See
[Time and location in a video file](LoadingVideo.md#time-and-location-in-a-video-file).

The **Sitch Duration** is Sitch Frames ÷ fps. If you change the fps, the number of frames
stays the same and the duration changes.

### Start Time and Now Time

- **Start Time** is the date and time of frame 0, the first frame.
- **Now Time** is the date and time of the current frame: Start Time plus the frame time.

At frame 0 the two are the same. Both are stored in UTC.

The Time menu's editor opens in **Edit Playhead** mode, showing **Now Time**. The
Year, Month, Day, Hour, Minute, Second and ms sliders also show Now Time.
When you change it, Sitrec keeps the current frame where it is and moves
the Start Time by the same amount. This is the easy way to sync: go to a frame where
something distinctive happens in the video, then set the date and time of that moment. The
Start Time follows.

The look view shows the Now Time in UTC and in the selected time zone. To hide this
readout, turn off **Show → Time Display in Look**. The main view can show the same readout
at its bottom right: turn on **Show → Time Display in Main**, or the clock button on the
main view's header bar. It is off by default, and the setting is saved with the sitch.

### Time zones

Sitrec stores all times in UTC. The time zone only changes how times are **shown**.

- **Time Zone** selects the zone for the look view readout and the playback bar readout.
- **Use Time Zone in UI** also shows the date and time sliders in that zone. When it is on,
  the labels of those sliders are pink. When it is off, the sliders are UTC.

The list has fixed offsets, for example `PST UTC-8` and `PDT UTC-7`. Sitrec does not
change between standard time and daylight time for you, so select the zone that was in
effect on the date. For example, Chile is `CLT UTC-4` in its winter and `CLST UTC-3` in
its summer. China is `BJT UTC+8` (Beijing Time), because `CST UTC-6` is US Central
Standard Time. When Sitrec selects the zone from an offset, the name can be another zone with
the same offset, for example `MDT UTC-6` for US Central Standard Time. Only the offset is used.

Sitrec selects the zone when the sitch loads. If the sitch names a zone, Sitrec uses it. If
not, it uses your computer's zone **on the date of the sitch**, so a sitch with an old date
gets the daylight-saving rules of that time. A new custom sitch starts with a built-in date.
A saved sitch keeps its own zone. Sitrec does not use the sitch location when it loads,
because a new custom sitch has a default location until you set one.

**Set Time Zone from Camera Location** sets the zone at the position of the look camera. Sitrec
finds the zone (for example `Europe/Berlin`) on the same time zone map as **Show Time Zones**
(see [Time zone borders](#time-zone-borders)), which also has the small areas with their own
clock: the Hopi reservation in Arizona stays on UTC-7 in summer, but the Navajo Nation around
it uses daylight saving time. Then Sitrec uses the offset of that zone on the date of the Start
Time, so the daylight saving rule of that date applies. The name is the entry
in the list with the same abbreviation and offset, for example `JST UTC+9` for Tokyo and
`AEDT UTC+11` for Sydney in January. If the list has no such entry, the name is the offset
alone, for example `UTC+8.00` for Hong Kong. The time does not change. Only the zone that
shows it changes. A message at the top of the main view gives the new zone, for example
*Time Zone Set to JST UTC+9 (Asia/Tokyo)*. Time zone borders: © OpenStreetMap contributors, from
[timezone-boundary-builder](https://github.com/evansiroky/timezone-boundary-builder) (ODbL).

A video, photo or track file can also set the zone:

- A video file's date can have a UTC offset (iPhone, Samsung). Then the zone comes from that
  offset.
- If a video file's date is plain UTC, or the file has no date, and the file has a location,
  the zone is the zone at that location. If the date is plain UTC and there is no location,
  the zone becomes `GMT UTC+0`. Sitrec reads the time and location of a video only while the
  sitch is new.
- A photo with a GPS position sets the zone at that position. See
  [Set the date from a photo](#set-the-date-from-a-photo).
- A track (KML, ADS-B, CSV, MISB or another track file) that sets the Start Time of a new
  sitch also sets the zone at the place where the track starts. This is the first track
  that you drop into a new sitch.

A date that you set yourself does not change the zone, and neither does a track that you add
after the sitch has its time. When a saved sitch loads, it keeps its saved zone, also when it
holds a photo, a video or a track.

### Time zone borders

**Show Time Zones** in the Time menu draws the time zones over the globe, in the main view
only: the borders as yellow lines, 1.5 pixels wide, and each zone in a light color. Like the
Lat/Lon grid, the lines and the colors show over the terrain, but not on the far side of the
Earth. The setting is saved with the sitch.

A row of labels runs across the view at the latitude of the centre of the screen. Each zone
on that row has one label, in the middle of the part of the zone that you can see. The label
gives the name and the UTC offset of the zone on the sitch date, on two lines, for example
**PDT** over **UTC-7** in summer and **PST** over **UTC-8** in winter, named as in the
**Time Zone** list. At sea, and where the name is not known, the label gives the offset
alone, for example **UTC-10**. Labels are smaller toward the edge of the globe, and a zone
with too little room on the screen has no label. The labels move with the view.

![The main view looking down on the United States with Show Time Zones on, on a September date. Each zone has a light color: Pacific time and Arizona (UTC-7) pink, Mountain daylight time (UTC-6) orange-brown, Central daylight time (UTC-5) yellow and Eastern daylight time (UTC-4) green. Yellow lines mark where the clocks on the two sides differ. A line runs around Arizona, which stays on UTC-7, but the Navajo Nation in its north-east corner has the Mountain daylight time color, with a small loop inside it around the Hopi reservation, which also stays on UTC-7. A line follows most of the Rio Grande, because most of Mexico does not use daylight saving time. In Canada, Alberta and Saskatchewan have the same color and no line between them. A row of yellow labels across the middle of the view reads MDT UTC-6, CDT UTC-5 and EDT UTC-4, each in the middle of its zone](docimages/time-and-sync-show-time-zones.jpg)

The map shows the time zones at the **Now Time**, with daylight saving time. A line marks a
place where the clocks on the two sides show different times at that moment, and each zone
has the color of its UTC offset then, so the colors agree with the labels. For example, in
July a line runs around Arizona, which stays on UTC-7, inside Mountain daylight time
(UTC-6). In January, Arizona and New Mexico are both on UTC-7, so they have the same color
and no line. France and Germany have had the same clocks since 1980, so after 1980 there is no
line between them; in the summers of 1976 to 1979, when France had summer time and Germany did
not, there is. When the Now Time crosses a
change of daylight saving time, for example when you play the sitch across one, the lines
and the colors change with it. At sea, the zones are the 15-degree bands of nautical time,
so lines run across the oceans, and a country whose time differs from the band around it is
outlined along its coast (the limit of its territorial sea).

Each zone has a color for its UTC offset, at 15% opacity, so the terrain shows through.
The colors repeat every 6 hours: UTC is orange, UTC+1 yellow, UTC+2 green, UTC+3 blue, UTC+4
purple and UTC+5 red, and UTC+6 is orange again. So two zones that are next to each other do
not have the same color, and UTC+13 has the color of UTC-11, which has the same clock time a
day earlier. A zone on a half or quarter hour has diagonal stripes of the colors of the two
hours next to it. India (UTC+5:30) has red and orange stripes of the same width, and Nepal
(UTC+5:45) has orange stripes three times as wide as its red ones. Where two zones cover the
same land, the area has stripes of the two colors. An example is Xinjiang, which has the
UTC+8 of China and also its own UTC+6. The stripes keep the same width on the screen when you
zoom.

The time zone data (about 250 KB) loads the first time you turn **Show Time Zones** on, or
the first time Sitrec finds a zone from a location.

#### Data source and method

**Source.** The map comes from the "1970" set with oceans of the 2026f release of
[timezone-boundary-builder](https://github.com/evansiroky/timezone-boundary-builder), which
makes the borders of the IANA time zones from OpenStreetMap. That set has 304 zones. Each zone
is an area where the clocks have been the same since 1970, named after an IANA zone, for
example `America/Vancouver`. Zones whose clocks differed at any time since 1970 stay apart,
also when they are the same today. At sea, the zones are the 15-degree bands of nautical time,
and a country's territorial sea has the zone of the country. Time zone borders:
© OpenStreetMap contributors (ODbL).

**The data file.** `scripts/buildTimeZoneBorders.js` makes `data/timezones/timezone-borders.bin.gz`
from the source:

1. It repairs the shared borders. Points less than about 1 m apart become one point, and
   where one zone has a long straight edge and its neighbour has points along that edge, the
   edge is split at those points. Then the two sides of each border share the same edges.
2. It keeps the edges that have different zones on their two sides and joins them into
   lines. It drops a closed line that encloses less than about 800 m²: there, the source
   shapes of two zones cross by a few metres.
3. It finds the areas between the lines, and gives each area the zones that cover it: the
   zones of the lines around it, and the zones that a point test well inside it finds. The
   point test is necessary where a zone lies wholly inside another one. The areas of the West
   Bank under the Palestinian clock (Hebron, Nablus, Ramallah) are an example.
4. It simplifies the lines to about 1.1 km and stores the points to 0.0001 degree (about
   11 m).

The file is a database derived from OpenStreetMap data, so it is under the ODbL too (see
`data/timezones/README.md`).

**In Sitrec.** The browser's own time zone rules give the UTC offset of each zone at the Now
Time, with daylight saving time. Sitrec checks the offsets again at the start of each quarter
hour of sitch time. A line shows where the
offsets on its two sides differ, and each area has the color of its offset. The colored areas
are made of triangles, at most 3 degrees long, so that they follow the curve of the Earth.
**Set Time Zone from Camera Location**, a photo with a GPS position, and the labels use the
zone of the area that holds the point. Where two zones cover the same area (Xinjiang, the West
Bank), a smaller table from the same source, from
[@photostructure/tz-lookup](https://github.com/photostructure/tz-lookup), chooses between
them. If the map file does not load, that table gives the zone.

**Limits.** The map is correct for any date since 1970: British Columbia is on UTC-8 in
January 2025, and Mexico City uses daylight saving time in July 2015. Before 1970, an offset
can be wrong, because zones that differed only before 1970 are one zone. A browser with older
time zone rules can show an old offset for a zone whose rules changed recently. Within about
1 km of a border, because of the simplified lines, a position can get the zone on the other
side.

### How tracks line up

A track file (ADS-B, KML, CSV, MISB and others) has a timestamp for each point. For each
frame, Sitrec calculates the frame's date and time, then finds the track position at that
time. Between two points it interpolates. Before the first point or after the last point,
it extends the track in a straight line from the nearest two points, so a track can seem to
continue past the end of its data. A track with the **spline** method, the default for the
first track in a file, holds at its end points instead. See
[Smoothing and Interpolation](Tracks.md#smoothing-and-interpolation).

So a track lines up with the video only when the Start Time is correct. If you change the
Start Time, tracks move along their paths. The exception is a MISB track that is paired with
the video by timestamps (see below).

When you drop the first track into a new sitch, Sitrec sets the Start Time to the track's
first timestamp. If one file holds two separate aircraft that overlap in time, such as a KML
file with each flight in its own folder or a CSV file with a `TRACK_ID` column, Sitrec then
moves the Start Time to the moment they are closest. The Center track of a MISB file (the
frame center point) does not cause this move, and the tracks of a STANAG or BOT file do not
cause it. The move happens only while the sitch is still new.
After you load a video with a date or a location, set the time yourself, load a saved sitch,
or otherwise settle the sitch, new tracks do not move the timeline. Radiosonde (wind) tracks
never move it. To sync to a track by hand, use **[Sync Time to](#sync-controls)**.

Some formats are a whole recording, not a clip (for example
[STANAG](Glossary.md#data-formats-and-sources) and
[BOT](BOTBench.md#the-bot-interchange-format) files). For these, the first track also sets
**Sitch Frames** to the length of the track, if the track is shorter than 24 hours.

**MISB video with timed metadata.** When the [KLV](Glossary.md#data-formats-and-sources)
metadata in a MISB file carries a video timestamp for each record, Sitrec pairs each record
with the video frame that has the same timestamp. It does not use the Start Time for this. The **[Timing
Analysis](#timing-analysis)** report shows which method each track uses.

### How the video lines up

Normally the video is frame for frame: sitch frame 0 shows video frame 0, sitch frame 100
shows video frame 100. The two exceptions are **Dropped frames** and **Variable frame rate**
below. The Start Time is the date and time of the first video frame.

- **Changing Video FPS.** Video FPS comes from the video file. If you change it,
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
- **Variable frame rate.** If the time between frames changes during the video, **VFR Fix**
  is on by default. Each sitch frame then shows the video frame nearest to its real time, and
  Video FPS and Sitch Frames change. See
  [Variable frame rate (VFR Fix)](LoadingVideo.md#variable-frame-rate-vfr-fix).
- **A MISB file with conflicting rates.** Some MISB files have a labeled frame rate that is
  not the real rate. If the KLV timestamps show a different rate, Sitrec shows a **Frame
  Rate Mismatch Detected** dialog once. It recommends the real-time rate from the KLV
  timestamps. **Decide later** keeps the current rate.

---

## The Time menu

The Time menu opens with the date and time editor. The same editor is at the top of
**Satellites → Satellite Controls**. Both use the same scene time and time zone.

### Scrubbing and setting the clock

Choose **Edit Playhead** to date the video frame you are looking at, or **Edit Start**
to date frame 0, the beginning of the recording. Each button's tooltip shows its exact timestamp.
Editing pauses playback and leaves the current frame fixed; the scene's Start Time and
Now Time move together. Use the playback bar to scrub through video frames instead.

- **Drag date or time digits left/right** to scrub time continuously. The clock carries
  across minute, hour and day boundaries. Month/year steps clamp the day to the end of a
  shorter month. Hold **Shift** before dragging for steps ten times larger.
- **Click the left/right half of a number** to subtract/add one unit. There are no separate
  step buttons. Hold **Shift** to step ten units.
- **Tab / Shift+Tab** selects the next/previous date or time number, wrapping between year
  and milliseconds and skipping the other controls. Type a value, then press Enter or Tab.
  Use **↑/↓** for one-unit
  steps, **Shift + ↑/↓** or **Page Up/Down** for ten. The mouse wheel scrolls the panel.
  **Escape** discards an unfinished entry and leaves the editor.
- The calendar icon opens the date picker. The **ms** field keeps precise video timing;
  adjusting larger units preserves its value.
- **Undo** reverses a time edit, including a whole drag. It is shared between
  the menu and panel. Setting time through other controls clears the available editor undo.
- **Time zone** explicitly selects UTC or a named fixed offset for editing. Changing it
  does not move the instant or stop Live mode. **From camera** selects the zone at the
  camera location on the scene date. Fixed offsets do not automatically change with daylight
  saving time; select the offset in effect for the event.
- **Play/Pause** runs or stops playback. **Live** follows the real clock; click it again or
  edit a date/time field to stop following. The speed selector changes Simulation Speed
  and resets the playback multiplier to 1; changing it keeps Now Time fixed.
- **Paste a date & time** accepts an ISO timestamp such as `2026-11-08 21:30:00.125Z` or
  `2026-11-08T13:30:00.125-08:00`. Without a suffix, it uses the zone above. **Now once**
  dates the current frame with the real clock once, then stays paused.

**Date & time sliders** retains the original sliders and UTC reference strings.
**Timeline & synchronization** contains duration, frame rate, frame selection, playback,
track syncing and other timing tools. Their existing menu/API paths are unchanged.
The controls are described below. **Timing Analysis...** has [its own section](#timing-analysis).

### Date and time

| Control | Default | What it does |
|---|---|---|
| **Live Mode** | Off | Keeps the simulation at the real current time. Playback pauses, and the current frame stays at the middle of the timeline while the Now Time follows the clock. It turns off when you scrub or set the time. It is not saved with a sitch. Some sitches start in Live Mode |
| **startTime** | | The Start Time (the time of frame 0), in UTC, read-only. Choose **Edit Start** in the editor to change it |
| **nowTime** | | The Now Time (the time of the current frame), in UTC, for reference |
| **Year**, **Month**, **Day**, **Hour**, **Minute**, **Second**, **ms** | The sitch's date | The Now Time. When you drag one slider past its end, the slider above it changes too (for example, Minute past 59 adds an hour). They are UTC, or the selected time zone if **Use Time Zone in UI** is on. Double-click a label to return that field to the date the sitch was loaded, saved, or set from a file |
| **Note** | Hidden | Shows only for a date that needs care: *Before 1957 - no artificial satellites existed*, or *Outside 1700-2200 - Sun, Moon and planet positions degrade*. See [Historic Skies](HistoricSkies.md) |
| **Use Time Zone in UI** | On (off for older saved sitches) | Shows the date and time sliders in the selected time zone, not UTC |
| **Time Zone** | The sitch's zone, or your computer's zone | The zone for the readouts. See [Time zones](#time-zones) |
| **Set Time Zone from Camera Location** | | Sets **Time Zone** to the zone at the look camera position, with the daylight saving rule of the Start Time date. The time does not change. See [Time zones](#time-zones) |
| **Show Time Zones** | Off | Draws the time zones at the Now Time in the main view: the borders as lines, and each zone in a color for its UTC offset. See [Time zone borders](#time-zone-borders) |
| **Simulation Speed** | 1 | How many seconds of simulated time pass in one second of frames. Use it for a time-lapse video: if the video is 30× faster than real time, set 30. It does not change how fast the video plays. When you change it, the current frame keeps its Now Time and the Start Time moves. Range 0.01 to 1200 |

The Year slider starts at 1947. To go earlier, type the year in the box, or press **G** and
type a full date such as `Apr 15, 1897` (a number alone is a frame number). The slider then
goes back to 1700.

### Sync controls

These two menus do an action and then go back to **-**, so you can select the same entry
again.

| Control | Choices | What it does |
|---|---|---|
| **Sync Time to** | **Start Time** | Sets the Start Time back to the time the sitch had when it was loaded. A date set later by a video, photo or track does not count |
| | **Now Time** | Sets the Now Time (the current frame) to the real current time |
| | *a track name* | Goes to frame 0 and sets the Start Time to the first timestamp of that track. Every loaded track is recalculated |
| **Sync Duration to** | *a track name* | Sets Sitch Frames so that the sitch lasts as long as the track: track duration × fps ÷ Simulation Speed, and at least 2 frames |

Each track shows as `TrackData_` followed by its short name. A track is added to both lists
when you load it, and removed when you delete it.

### Length and frame rate

| Control | Default | What it does |
|---|---|---|
| **Sitch Frames** | The video's frame count, or the sitch's own value | The number of frames in the sitch. The slider extends when you drag it to its end. If the Out frame was on the last frame, it moves with the end |
| **Sitch Duration** | Sitch Frames ÷ fps | The same length as a time. Type `HH:MM:SS.sss`, `MM:SS`, or seconds (`45.5`). Sitrec converts it to frames at the current fps |
| **Video FPS** | From the video, or 30 | The frame rate. It changes how long each frame lasts, so it changes the duration, the playback speed, and the time of every frame after frame 0. A value you set is saved with the sitch and is used again when the sitch reloads its video. Loading a different video clears it. Range 1 to 120 |

### In, Out and playback

| Control | Default | What it does |
|---|---|---|
| **In Frame [I]** | 0 | The first frame of the In/Out range. Press **I** to set it to the current frame |
| **Out Frame [O]** | The last frame | The last frame of the In/Out range. Press **O** to set it to the current frame |
| **In-Out Pingpong** | Off | When on, playback goes forward to Out, then backward to In, and so on. When off, it goes back to In after Out. Video renders do the same, and leave out the audio when this is on |
| **Time (sec)** | | The current frame as video seconds from the start (frame ÷ fps). It does not use Simulation Speed |
| **Frame in Video** | | The current frame number |
| **Paused** | | Pauses playback. Same as **Space** |
| **Playback Speed** | 1 | Multiplies how fast frames advance when you play. 2 is twice as fast, 0.25 is quarter speed. It does not change the time of any frame. Video renders use it too, and leave out the audio when it is not 1 |

**The In and Out frames limit more than playback.** Sitrec keeps the current frame between
In and Out. If you scrub or step outside the range, the frame stops at the In or Out frame.
Video renders use only this range. Every Global Fit and the traverse analysis use only the
sightlines in this range (see [Traverse Methods](TraverseMethods.md)), and Point Track stops
at the Out frame (see [Point Tracking](PointTrack.md)). In and Out are saved with the sitch.

---

## The playback bar

The playback bar is at the bottom of the screen. The buttons are on the left and the
timeline is on the right.

![The playback bar. On the left are eight white buttons. On the right is the timeline with a round thumb at frame 360, a green line near the left end, a red line near the right end, two small cyan flags at the top, and three yellow diamonds at the bottom. A dark box above the thumb reads 360 12.00s and 13:50:38.97. At the lower right of the look view, above the bar, the readout shows 2025-09-19 20:50:38.970 UTC and 2025-09-19 13:50:38 PDT UTC-7](docimages/time-and-sync-playback-bar.jpg)

*The playback bar with the pointer on the timeline. The buttons are in the same order as the
table below. The round thumb is the current frame. The green line is the In frame and the red
line is the Out frame. The two cyan flags are timeline markers, and the three yellow diamonds
are keyframes from a [Ground Track](GroundTrack.md). The box above the thumb shows frame 360,
12.00 seconds from the start, and 13:50:38.97 in the selected time zone. Above the bar at the
right is the look view readout: the Now Time in UTC, then in the selected time zone.*

| Button | What it does |
|---|---|
| **Pin/Unpin** | Pinned (the default): the bar is always visible. Unpinned: the bar fades 2 seconds after the pointer leaves it, and comes back when you move the pointer over it |
| **Play/Pause** | Starts or stops playback |
| **Step Back** / **Step Forward** | Moves one frame and pauses. Hold to repeat |
| **Fast Rewind** / **Fast Forward** | Hold to move 10 frames per screen update. Pauses playback |
| **Jump to Start** / **Jump to End** | Goes to the first or last frame (then limited to the In and Out frames) |
| **Audio/Mute** | Mutes or unmutes the video's sound. Shows only when the video has audio |

**Scrubbing.** Click or drag on the timeline to go to a frame. This pauses playback and
turns off Live Mode. While you drag or hover, a box above the current frame shows its number,
the time in seconds from the start, and the time of day in the selected time zone. Hovering
does not preview another frame.

**In and Out lines.** The **green** line is the In frame and the **red** line is the Out
frame. Each has a small circle at the top. Put the pointer near a line (the cursor becomes a
double arrow), then drag it. In always stays before Out. **Ctrl/Cmd+Z** undoes the drag.

**Resetting In and Out.** Double-click the timeline to the left of the In line to put In
back to frame 0. Double-click to the right of the Out line to put Out back on the last
frame. **Reset In/Out** in the right-click menu does both.

**Timeline markers.** A marker is a named frame. It shows as a **cyan** flag at the top of
the timeline, with a faint line down the bar. Put the pointer on a flag to see its name and
frame. Click a flag to go to that frame. Where a marker is on the In or Out line, the flag
takes the click; drag the line lower down. `<` and `>` (Shift+`,` / Shift+`.`) go to the
previous / next stop on the timeline, which can be a marker (see
[the keys](#keys-for-time-and-frames)). Markers are saved with the sitch. In a sitch with
[chapters](SitchChapters.md), each chapter has its own markers.

**The right-click menu.** Right-click the timeline for:

| Item | What it does |
|---|---|
| **Add Marker at Current Frame** | Adds a marker at the current frame |
| **Add Marker Here** | Adds a marker at the frame under the pointer |
| **Add satellite rise / set markers** | Adds a marker at each rise and set of the satellites shown in the sky (see [Satellite rise and set markers](SitchChapters.md#satellite-rise-and-set-markers)) |
| **Label**, **Go to Marker**, **Delete Marker** | Shown when you right-click a flag: name the marker, go to it, or delete it |
| **Go to Marker** (folder) | Every marker, by name and frame. Click one to go there |
| **Delete All Markers** | Deletes every marker, after you confirm |
| **Reset In/Out** | Puts In on frame 0 and Out on the last frame |

**Ctrl/Cmd+Z** undoes each change to the markers, and Reset In/Out.

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
| `<` / `>` (Shift+`,` / Shift+`.`) | Previous / next stop on the timeline: a timeline marker, the In or Out frame, or a keyframe that a tool has marked. Does nothing if there is no stop in that direction |
| `I` / `O` | Set the In / Out frame to the current frame |
| `G` | **Go To.** Type a frame number to go there and pause. If that frame is outside the In/Out range, the In or Out frame moves to it. Or type a date and/or time (`15:20`, `17:33 UTC`, `Jan 6, 2020`) to set the Now Time. A time with no date keeps the date, and a date with no time keeps the time of day. A time sets the seconds and ms to 0 if you do not type them. A time is read in the zone the Time menu shows, unless you add `UTC` |
| `;` / `'` (hold) | Move the Start Time back / forward by one second for each screen update. Hold `Shift` as well for ×10, or `Alt` for ×1000 |

`;` and `'` move the **Start Time**, so the current frame keeps its place and everything in
the simulation moves in time. Watch stars, the Sun, or a satellite move into position while
you hold the key.

If Point Track is enabled, these keys also drive it: `'` tracks forward, and `;` rewinds and
deletes the tracked points as it goes, user points included. A rewind with `;` also moves the
Start Time back. The Start Time does not move while `'` is tracking, but the first hold of `'`
can move it forward before tracking starts. See [Point Tracking](PointTrack.md).

The full list of keys is in [Keyboard Shortcuts](KeyboardShortcuts.md).

---

## Recipes

### Sync a video to a flight track

1. Load the video. Sitrec sets Sitch Frames and Video FPS from it. If the video file has a
   creation date, and the sitch is still new, Sitrec uses that date as the Start Time.
2. Load the track file. In a new sitch, Sitrec moves the Start Time to the start of the
   track. If the video set the Start Time or the camera position, the track does not move
   the time. Then, if the time is not near the track, select the track in **Time → Sync Time
   to**. The start of the track is only a first estimate: the video usually does not start
   at the same moment as the track.
3. Find a frame in the video where something distinctive happens: the plane passes a
   landmark, turns, or crosses another object.
4. Go to that frame. Then change the **Hour**, **Minute**, **Second** and **ms** sliders
   (or press **G** and type the time) until the simulation shows the same event on that
   frame.
5. To move the time by a large amount, hold `;` or `'` and watch the look view. Each second
   that you hold a key moves the time by tens of seconds. For a finer correction, use the
   **Second** and **ms** sliders.
6. Check a second event near the other end of the video. If the first event lines up and
   the second does not, the fps may be wrong (see the next recipe), or the video may be
   edited.

If a track is much longer than the video and you want the whole track, select it in **Time
→ Sync Duration to**.

### My video is 29.97 fps

For MP4 and MOV files, Sitrec calculates the frame rate from the number of frames and the
duration, so a 29.97 fps file shows **Video FPS** 29.97. If the value is wrong, type the
correct value in **Video FPS**. The box takes two decimal places.

Over 60 seconds, 29.97 and 30 fps differ by about 0.06 seconds. For a fast object or a long
video this can be important.

After you change the fps, the time of frame 0 does not change, but every later frame gets a
different time. So sync on an event near the start of the video, then check an event near
the end.

The rate you set is saved with the sitch.

### Trim to the interesting part

1. Go to the first frame you want, and press **I**.
2. Go to the last frame you want, and press **O**.

Or drag the green and red lines on the playback bar. Playback now loops between the two
frames (turn on **In-Out Pingpong** to go back and forth), and video renders include only
this range. The frames outside the range are still in the sitch. To use them again,
double-click the timeline outside the lines.

To remove frames from the sitch, reduce **Sitch Frames**. This removes frames from the
**end** only.

### Set the date from a photo

Drop a JPEG photo into Sitrec. If its EXIF data has a capture date, Sitrec sets the Start
Time to that date.

EXIF capture times do not always include a time zone:

- If the photo has an EXIF time zone offset (most modern phones write one), Sitrec uses it,
  and the time is correct.
- If there is no offset and the photo has a GPS position, Sitrec reads the time as local time
  at that position, with the daylight saving rule of that date. This assumes that the camera
  clock was set to local time. If it was not (for example, a camera that was not changed after
  travel), set the time yourself.
- If there is no offset and no GPS position, Sitrec reads the time as if the photo was taken
  in your computer's time zone. If the photo was taken in a different zone, set the time
  yourself.

A photo with a GPS position also sets **Time Zone** to the zone at that position, so the
readouts show the local time of the photo. The zone is found a moment after the photo loads.

A video file's date also sets the Start Time, but only while the sitch is new. Its time zone
rules are different: see
[Time and location in a video file](LoadingVideo.md#time-and-location-in-a-video-file).

### Check a video's time against the sky

Use this for a video of the night sky that has no track to sync to, such as a phone video.

1. Load the video, and check the Start Time and the camera position. If the video did not
   set them, set them yourself.
2. Point the look view at the same part of the sky, and match the field of view.
   [Recreating a Starlink Situation](Starlink.md#recreating-a-starlink-situation) shows how.
3. Raise **Vid Overlay Trans %** in the View menu to see the video over the look view.
4. Hold `;` or `'`, or change the **Minute** and **Second** sliders, until the stars in the
   look view match the video.

The sky turns 15° per hour, which is 0.25° per minute, so stars can show an error of minutes,
not of seconds. A wrong direction can look like a wrong time, so compare the stars with
something fixed in the video, such as the horizon. A satellite in low orbit can cross the sky
at about 1° per second, so a match to the second needs a satellite. See
[The Satellites Menu](Satellites.md).

### Time-lapse video

If the video shows 10 minutes of real time in 20 seconds, it is 30× faster than real time.
Set **Simulation Speed** to 30. Each frame then advances the simulation 30 times as far,
and the video still plays at its normal speed. **Sync Duration to** takes Simulation Speed
into account.

---

## Timing Analysis

**Time → Timing Analysis...** makes a text report on the KLV metadata of a video. KLV is the metadata
in a MISB video. It comes from a `.ts` file (an MPEG transport stream, or TS, which is a video
container), a `.klv` file or a MISB CSV file. Load the file first. If the sitch has no MISB data, the
report is a message that says so. The report opens in a dialog, and **Copy Analysis** and
**Download Analysis** give you the text as `sitrec-timing-analysis.txt`.

A **stream** is one series of KLV data in the file, and a **record** is one set of values at one
time. A file can have two KLV streams, for example from two parts of the system on the aircraft, or
because the encoder sends the data in two ways.

The report starts with the name and size of the loaded file, and then has three parts:

- **Streams**: what each KLV stream is and holds.
- **Tracks**: which stream each track uses, and how Sitrec made the name of each track.
- **Analysis**: the timing of one stream in detail. The heading names the stream, and **Analyzed below**
  in the Streams table gives the reason. Sitrec analyzes the stream that the platform track uses. The
  platform track is the track that the camera is on: the **Position** setting in the **Camera** menu. If the camera is
  not on a KLV track, Sitrec uses the first stream with PES timestamps, and then the first stream. The
  choice says nothing about which stream is better. A stream that is not analyzed can have a different
  rate and gap pattern, so use the Streams table to compare them.

The report does not include node names. The file line, the Streams table and the track names can
include a tail number, a mission ID, a call sign or a start time. Clear **Show Filename and Names** in the
dialog to remove these from the text, from **Copy Analysis** and from **Download Analysis**. The file
line goes, and each text value in the table changes to `hidden`, even if the text is all digits. The
first time and the sun height change to `hidden` too. Numbers from 0 to 65535 stay, and so does a raw
value of one byte, or of two bytes that are not text. Counts stay, and so do the keys of KLV packets,
because a key names a format and not a platform. The Analysis part has no names, positions or absolute
times at any time, so the setting does not change it. Where it lists the fields that changed at a gap,
it shows values only for angles, speeds, the field of view, slant range and settings that the standard
defines. Other fields show only `changed`, `appeared` or `gone`.

### Streams

The table has a column for each KLV stream and a row for each field. The column heading names the
stream by its ids in the file, for example `KLV #0:3 [0x1002], sync`:

- `#0:3` is the stream's position in the TS program map. In a file with one program and one version
  of the program map, this is the number that `ffprobe` shows as `Stream #0:3` and that
  `ffmpeg -map 0:3` uses. The first 0 means the first input file, so it is always 0 in Sitrec.
- `[0x1002]` is the TS packet id (PID), in hexadecimal.
- `sync` (stream_type 0x15) or `async` (stream_type 0x06) is how the TS says that the KLV is carried.
  Another stream_type has no word here. This label does not tell you how a record is timed:
  **hasRecordPTS** does.

KLV that did not come from a `.ts` file is `MISB file`. After you reload a saved sitch, the PID is
always shown. The other TS values are shown only if they were saved with the stream's frame timing;
older saves do not have them.

A cell shows the first five different values, and a long value wraps inside its cell. If there are
more, the cell says `+2 more`. If only some records have the value, the cell says, for example,
`(in 371 of 1953)`. Other cell values:

- `none`: the stream has no value for this field.
- `no TS`: the stream did not come from a TS.
- `?`: the value was not saved with the stream. Load the TS file to read it.
- `n/a`: the value cannot be measured here, for example with no video loaded.

`≠` at the start of a row marks a tag where the streams have different values. It compares all the
values, also those that a cell does not show, and not how many records have them. It stays on the row
when both cells say `hidden`. It shows only that the values are different, not that one is wrong. Ids
and measurements have no mark, because they nearly always differ, so read those rows yourself.

Text values are what the file says. Sitrec does not check them, and `Default` and `N/A` can be
fields that nobody set. Derived tracks are not listed, because their records hold only time and
position. A line under the table gives their number. They are Frame Center, Target Location and
Truth (a track that the file labels as truth, which Sitrec does not verify). The Tracks part says
what each one is.

The rows are in these groups:

- **In the TS file**: the `ffprobe` stream number, the PID, the `stream_type`, the PES `stream_id`, and
  the stream's own name in the program map, if the encoder wrote one.
- **In the KLV**: ST 0601 is the main MISB metadata format. Its tags here describe the stream, the
  platform and the sensor.
  - `UASDatalinkLSVersionNumber` (tag 65) is the ST 0601 revision that the encoder states: 7 means
    ST 0601.7. People name a stream by this number and can call it the local set number. That is
    safe only when the numbers differ. Two streams can have the same number, and a stream can have
    none. Use the PID to name a stream.
  - `PlatformCallSign / TrackID` (tag 59) is also the value that Sitrec uses to split one stream into
    tracks.
  - A local set is a group of tagged values. ST 0601 is one, and it can hold others inside it.
    `SecurityLocalSet` (tag 48) is always listed. `RVTLocalSet` and `VMTILocalSet` are listed if a
    stream has them. A nested local set is shown as `name=value` pairs, and it can have its own
    version number. `Geo_RegistrationLocalSet` cannot be read, so a stream that has it shows it under
    **Tags Sitrec does not decode**.
  - **Tags in the stream** counts the tags that have a value, and how many of them only this stream
    has.
- **Decoding**: these rows show that Sitrec read the file. They do not show that the values are true.
  **Records** is the number of records. **Packets not decoded** counts packets that could not be read.
  A damaged packet can cost that one record, and the record after it is kept. **PES with no KLV
  packet** counts PES packets that hold no part of any KLV packet, which can be a record that was lost
  whole. A PES of another standard, such as ST 0903, is not counted, and neither is the rest of a long
  record. It says `n/a` if the stream has no PES timestamps. If the lost TS packet held the start of a
  PES, only **TS continuity errors** shows it. **Bad or missing checksums** counts records that Sitrec
  kept, although their checksum is wrong or absent. **Tag faults** lists tags with a wrong length or a
  decode error: the value is lost, and the rest of the record is kept. `value read` means that the
  length is wrong but the value is good, as with old encoders that send tag 22 in 4 bytes. **TS
  continuity errors** counts places where TS packets of this stream are missing.
- **Timing**: **First valid time** is the UnixTimeStamp (tag 2 in the KLV) of the first record with a
  valid time and position. With two or more streams, **Clock offset from** compares each stream with
  the first one, which the row names and which shows `—`. Being first says nothing about which clock
  is right. The offset is whole hours and a remainder, for example `+7 h -0.82 s`. If both streams have
  PES timestamps, it reads both clocks at the same time, to about 0.03 s. If not, it can only compare
  the first times, which also hold any difference in when the streams start, and the cell says
  `(first times)`. If the offset is more than 1 s, a line under the table says that the clocks differ.
  Tag 2 is UTC, so whole hours can be a time zone that one stream applied, and then at most one clock
  is right. **Sitch time on this clock** shows which stream the sitch start time matches: Sitrec takes
  it from the first track of a file, and **Sync Time to** in the Time menu changes it. Only the
  stream nearest to the start time says `yes`, and only if it is within a minute of it.

  **Sun height at first record** is how far the sun is above the horizon (`+`) or below it (`-`), at
  the sensor position and the stream's first time. It does not use refraction. It is the one check here
  that does not come from the stream's clock alone, so use it to choose between clocks: a clock that
  puts the sun below the horizon is wrong for a video in daylight. The report cannot see the picture,
  so you must make this comparison yourself.

  **Mean interval**, **Max interval**, **Repeated times** and **Gaps** are all on tag 2, not on PES
  timestamps. **Repeated times** counts records with the same time as the record before. An encoder
  can repeat the last record until the metadata next changes, which is not a fault. In that case
  **Mean interval** says `(repeats left out)` and gives the time between new values. A gap is an
  interval longer than 3 times the mean and longer than 100 ms, and the cell shows this limit. Read
  **Max interval** too: a stream with long pauses has a large mean, so its limit is also large. Below
  10 records the cell says `too few records to test`. Between records, Sitrec interpolates the track
  position, so a position in a gap is not a measured one.

  **hasRecordPTS** says whether the stream has a PES presentation timestamp (PTS) for its records. PES
  is the layer of the TS that carries the data, and PTS is the time at which to show or use it. If
  yes, Sitrec can pair records with video frames by PTS. If no, it times the records by tag 2.

  The next rows compare these timestamps with the video, so they need the video to be loaded.
  **First PTS minus first frame PTS** is negative for a record before the video. **PTS equal to a frame
  PTS** counts records stamped with a frame's own time. A low count is not a fault: it means that the
  encoder stamped the record's own time. **Offset to nearest frame** is for records inside the video.
  Up to half a frame is normal, and more can occur next to a dropped frame. **Records outside the
  video** counts the others.
- **Compared with** and the name of the first stream: the median horizontal distance between the
  sensor positions, and between the frame centers, of records within 100 ms of each other. Records pair
  by PES timestamp if both streams have them, and otherwise by tag 2. If the clocks are too far apart
  for records to pair, the cell says `n/a`. A small distance can be only speed × the time between the
  records. A large distance means that the streams disagree, and the report cannot say which one is
  right. A frame center moves far for a small change in camera angle or range, so a large frame center
  distance with a small sensor distance can be only that. Altitude and camera angles are not compared.
  This is the only place where the report compares what two streams say.
- **Tags Sitrec does not decode (raw hex)**: ST 0601 tags that Sitrec cannot read, with the first 32
  bytes of the raw value in hexadecimal. If the bytes are text, the text is shown too.
- **KLV packets that are not ST 0601**: the rows above are read only from inside the ST 0601 records.
  A local set sent as separate KLV packets with its own key (for example ST 0903 VMTI or ST 0806 RVT)
  is not decoded. This group has a row for each key, with the number of packets and their size. If
  the KLV has no such packets, a line under the table says so.

With one stream, the table is a summary of what the stream says about itself.

After the table, **Other streams in the TS** lists the streams that are not KLV, such as the video,
audio and private data. Sitrec does not read private data, so this is the only sign that it is there.

### Tracks

Each line gives a stream, the number of tracks that use it, and how those tracks pair with the video:
by PES PTS, or by UnixTimeStamp at the nominal rate, which is the video's frame rate. A further line
says whether the video frame times are real or synthetic, and whether frame patching is on.

**Track names** then lists the name of each track, as in the Contents menu, with its stream. Below
the list, the report tells how Sitrec made the names. A track from a KLV stream in a TS file is named
`S<n> LS<v>`, then the tail number of the platform track, or the kind of a derived track. For
example, `S1 LS7 AF00371`, `S1 LS7 Frame Center` and `S0 LS5 Platform`:

- `S1` is the stream's number in the TS, the same number as `#0:1` in the stream name.
- `LS7` is tag 65, the UAS Datalink LS Version Number, from the first record that has one.
- `AF00371` is tag 4, the Platform Tail Number. If the stream has none, the platform track has
  `Platform` there.
- A derived track has its kind in place of the tail number:
  - `Frame Center`: tags 23 and 24. It is where the line of sight through the center of the image
    meets the ground. The platform computes this point with its own terrain model. Sitrec reads it
    from the KLV and does not compute it. A record has no frame center when the camera looks above
    the horizon.
  - `Target Location`: tags 40 to 42. It is where the platform says the target is. It is an
    estimate by the platform, not ground truth, and it can be in the air.
  - `Truth`: the truth columns.

The track called `Target Location` is not the same as the **Target Track** setting in the Target
menu. **Target Track** can be any track. Look at that menu to see which track it is.

A track that is not from a TS stream has its tail number, or the name of its file. If a track's name
is not the name that Sitrec made, for example because you renamed it, the report gives Sitrec's name
after it. With **Show Filename and Names** cleared, a tail number and a name that you gave change to
`hidden`.

### Analysis

This part is about one stream only. It covers the video frame timestamps, the KLV record intervals,
gaps, and how the KLV and video spans compare. It flags position jumps that imply an impossible speed.

`✓` is a clean result, `ℹ` is a fact to know, and `⚠` is a problem to check. The first line is
`✓ No gaps or span mismatch found.` if the video has a constant frame rate, the KLV has no gaps or
scatter, and the spans agree. Under it, a stream with PES timestamps shows the same comparison with
the video as the Streams table. A stream without them says that the KLV and video times were not
compared. Scatter is measured by CV, the standard deviation of the intervals divided by their mean,
so 0% is a steady rate. PCR is the clock of the TS, which the PES timestamps are on.

The video has a constant frame rate if no more than 1% of its intervals are over 1 ms from the median.
A dropped frame is such an interval, so one dropped frame gets a `ℹ` line and not a warning. If a
stream repeats records until the metadata changes, the interval figures leave the repeats out and say
so. These checks are about the intervals only: a clock that is wrong by hours can pass all of them.

---

## See also

- [Getting Started](CustomSitchTool.md): building a sitch by dropping in files
- [User Interface](UserInterface.md): menus, views, and the time controls in short
- [Keyboard Shortcuts](KeyboardShortcuts.md): every key
- [Loading and Adjusting Video](LoadingVideo.md): video formats and what Sitrec reads from them
- [Loading and Filtering Tracks](Tracks.md): the track formats and their timestamps
- [Historic Skies](HistoricSkies.md): dates before 1947
- [Rendering and Exporting Video](Video.md): how the In and Out frames and Playback Speed
  affect a render
