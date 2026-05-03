# MISB Timing & Sync — How It Works in Sitrec

Synchronizing video frames to KLV telemetry in MISB-compliant files is harder
than it looks. This document explains the time references involved, what they
mean, what gets lost during typical processing, and how Sitrec's import and
recalc pipeline handles the cases that come up in real files.

The intended audience is anyone touching the MISB import path, the video
decoder pipeline, or the track-from-MISB recalculation logic — and anyone
debugging a sync issue in a TS-sourced sitch.

---

## Terminology

### Standards and organizations

- **MISB** — Motion Imagery Standards Board. The authority (under NGA, the
  US National Geospatial-Intelligence Agency) that publishes the metadata
  standards for ISR motion imagery. Its public document catalogue is at
  `gwg.nga.mil/misb`.
- **NGA** — National Geospatial-Intelligence Agency (US). Hosts the MISB
  standards.
- **MISB ST nnnn** — A specific MISB Standard. The standards we cite are:
  - **ST 0601** — UAS Datalink Local Set (the actual KLV metadata structure
    with all the tag definitions like SensorLatitude, SensorTrueAltitude,
    GenericFlagData, etc.).
  - **ST 0603** — Common Time Reference for Digital Motion Imagery (defines
    the Precision Time Stamp / UnixTimeStamp).
  - **ST 0604** — Time Stamping Compressed Motion Imagery (defines the
    PES-PTS-based per-frame metadata-to-video pairing).
  - **ST 1402** — Time Status Indicators (clock-locked / discontinuity
    bits accompanying the timestamp).
  - **ST 1603** — Time Transfer Local Set (extended time-quality metadata).
- **STANAG 4609** — NATO Standardization Agreement that wraps the MISB suite
  for ISR video transport. In practice "STANAG 4609 stream" and "MISB MPEG-TS
  stream" are interchangeable.
- **SMPTE** — Society of Motion Picture and Television Engineers. Owns the
  underlying KLV format spec (SMPTE 336M).
- **ISO/IEC 13818-1** — The MPEG-2 Systems standard, defines the MPEG-TS
  container, PES packets, and the metadata-transport mechanism MISB ST 0604
  builds on.

### Container and stream concepts

- **TS / MPEG-TS** — MPEG-2 Transport Stream. A 188-byte-packet container
  format used for broadcast and ISR transport. The native format for
  MISB-compliant motion imagery.
- **MP4** — ISO Base Media File Format / MPEG-4 Part 14 container. Common
  for stored video. Doesn't natively support KLV codec (a known limitation).
- **PID** — Packet Identifier. Each TS packet has a 13-bit PID identifying
  which elementary stream (video, audio, KLV, …) it belongs to.
- **PES** — Packetized Elementary Stream. The next layer up from TS packets;
  groups TS payload data into self-contained packets with a header that
  carries the per-PES timestamp.
- **PUSI** — Payload Unit Start Indicator. A bit in the TS packet header
  flagging "this packet starts a new PES." Used by the demuxer to find
  PES boundaries.
- **PSI / PAT / PMT** — Program-Specific Information / Program Association
  Table / Program Map Table. The TS-level metadata that lists which PIDs
  carry which streams in which program.
- **Elementary stream / ES** — The raw codec bitstream (e.g., H.264 video,
  AAC audio, SMPTE 336M KLV) before being wrapped in PES packets.
- **Substream** — Sitrec's term for a specific elementary stream extracted
  from a TS file (e.g., the H.264 substream, the KLV substream).

### Time references

- **PCR** — Program Clock Reference. A 90 kHz tick counter embedded in TS
  adaptation fields. The master clock for a TS program; both video PTS
  and KLV PES PTS reference it. Lost when demuxing TS to separate files.
- **PTS** — Presentation Time Stamp. Per-PES (or per-frame) timestamp in
  90 kHz ticks indicating when the packet's content should be displayed.
- **DTS** — Decode Time Stamp. Per-PES timestamp indicating when the
  decoder should consume the packet (relevant for B-frames where decode
  order ≠ display order).
- **UTC** — Coordinated Universal Time. The absolute time standard the
  KLV `UnixTimeStamp` is measured in.
- **Unix epoch** — 1970-01-01 00:00:00 UTC. The reference point for
  `UnixTimeStamp` (microseconds since this moment).
- **UnixTimeStamp / PrecisionTimeStamp** — MISB ST 0601 Tag 2 (and the
  ST 0603 alias). 8-byte microsecond UTC timestamp inside the KLV
  payload — not in the PES header. Survives all demux paths.
- **µs / ms** — microseconds (10⁻⁶ s) / milliseconds (10⁻³ s). Used
  throughout for time values; PCR ticks at 90 kHz are 11.111 µs each.

### Hardware concepts

- **GPS** — Global Positioning System. When a camera has GPS lock, its
  internal clock can be GPS-disciplined (sub-microsecond accurate against
  UTC).
- **RTC** — Real-Time Clock. The local battery-backed clock chip that runs
  when GPS isn't available. Free-running RTCs drift at ppm levels
  (microseconds per second).
- **IMU** — Inertial Measurement Unit. The sensor providing platform/sensor
  attitude (heading, pitch, roll) reported in MISB Tags 5-7.
- **ISR** — Intelligence, Surveillance, and Reconnaissance. The application
  domain MISB serves.

### KLV / metadata structure

- **KLV** — Key-Length-Value. A binary encoding format (SMPTE 336M) where
  each metadata item is a key (identifier), length (BER-encoded), and value
  (the actual data). MISB metadata is transported as KLV.
- **BER** — Basic Encoding Rules (ASN.1). Used for the KLV length field's
  variable-length encoding.
- **LS / Local Set** — A specific KLV structure where keys are 1-byte tag
  numbers (vs. 16-byte universal keys). MISB ST 0601 is a Local Set.
- **Universal Key** — The 16-byte SMPTE 336M key identifying the KLV
  structure (e.g., the wrapper around an ST 0601 LS instance).
- **Tag** — A numbered field in a Local Set. ST 0601 Tag 2 is
  PrecisionTimeStamp; Tag 13 is SensorLatitude; Tag 47 is GenericFlagData;
  etc.
- **Synchronous mode / Asynchronous mode** — MISB ST 0604 carriage modes.
  Synchronous: each KLV PES packet has a PTS on the video timeline.
  Asynchronous: KLV PES packets have no PTS and are associated to video
  by stream-position proximity.
- **Record** — Sitrec's term for one decoded KLV instance — typically one
  ST 0601 LS containing all the metadata fields for a single sample
  moment.

### Video codec concepts

- **H.264 / AVC / MPEG-4 Part 10** — Common video codec used in MISB
  streams. Same standard, three names.
- **H.265 / HEVC** — Successor codec to H.264, less common in MISB to date.
- **WebCodecs** — Browser API for low-level video encode/decode. Sitrec
  uses it via a worker for H.264 playback.
- **mp4box.js** — JavaScript MP4 demuxer used by Sitrec for MP4-container
  files.
- **ffmpeg** — Command-line video processing tool. Often used to demux TS
  files externally; this typically destroys PES-PTS data.
- **NAL / NAL unit** — Network Abstraction Layer unit. The elementary
  building block of an H.264 bitstream (SPS, PPS, IDR slice, P/B slices,
  etc.).
- **SPS / PPS** — Sequence/Picture Parameter Set. NAL unit types carrying
  decoder configuration. Required before any decodable picture.
- **IDR** — Instantaneous Decoder Refresh. A keyframe NAL slice that fully
  resets the decoder; subsequent frames don't reference anything before it.
- **I-frame / P-frame / B-frame** — Intra (self-contained), Predicted
  (references earlier frames), Bidirectional (references both earlier and
  later frames). B-frames mean decode order ≠ display order.
- **GOP / Group of Pictures** — A sequence of frames starting with a
  keyframe and including all dependent inter-frames. In Sitrec's decoder
  pipeline, "group" is the unit of decoding work — one keyframe and its
  associated delta frames.
- **Chunk** — In Sitrec's WebCodec layer, one encoded video chunk = one
  encoded frame as an `EncodedVideoChunk` object. `chunks[i]` corresponds
  to the *i*-th frame in decode order.
- **Keyframe** — A frame that doesn't reference other frames (I-frame /
  IDR). Keyframes mark group boundaries and are required for decoding to
  start (and for seeking).
- **CFR** — Constant Frame Rate. Every frame is at the same nominal
  interval (e.g., 33.367 ms for 29.97 fps).
- **VFR** — Variable Frame Rate. Frames have non-uniform intervals.
- **fps** — Frames per second.

### Sitrec-specific terminology

- **Sitch** — A "situation" — a Sitrec scenario consisting of a video,
  associated tracks/metadata, scene setup, and node graph. The unit of
  saved/loaded state.
- **Sit** — The global object holding sitch-wide state including `Sit.fps`,
  `Sit.frames`, `Sit.startTime`.
- **Node / Node graph** — Sitrec's computation model. Most data and
  rendering is expressed as a graph of `CNode` instances connected by
  inputs/outputs. Specific nodes mentioned here:
  - `CNodeMISBData` — wraps a parsed KLV record array.
  - `CNodeTrackFromMISB` — derives a per-frame position track from a
    MISB data node.
  - `CNodeVideoView` / `CVideoData` / `CVideoWebCodecBase` — the video
    decoder layer.
- **Recalc / recalculate** — The per-node update method that recomputes
  the node's output from its inputs. Triggered by upstream changes.
- **framePTSus[]** — Sitrec's per-frame PTS array (microseconds, display-
  order-indexed). Populated by the WebCodec video pipeline.
- **pesPTSus[]** — Sitrec's per-KLV-record PES PTS array (microseconds,
  shifted to share the video's PCR origin). Populated by `parseKLVFile`
  when called with PES context.

---

## 1. The clocks involved

A MISB MPEG-TS stream has **three** distinct time references. Conflating them
is the source of essentially every sync bug we've seen.

```
   ┌──────────────────────────────────────────────────────────┐
   │  MPEG-TS multiplex                                       │
   │                                                          │
   │   ┌──────────┐   ┌────────────┐   ┌──────────────────┐   │
   │   │   PCR    │←──┤ Video PES  │   │  KLV PES         │   │
   │   │ (90 kHz) │   │  PTS       │   │  PES PTS         │   │
   │   │          │←──┴────────────┘   └──────────────────┘   │
   │   │          │←─────── KLV record  ┌──────────────────┐  │
   │   │          │         payload     │  KLV Tag 2:      │  │
   │   │          │         contains──→ │  UnixTimeStamp   │  │
   │   └──────────┘                     └──────────────────┘  │
   └──────────────────────────────────────────────────────────┘
```

### 1a. PCR (Program Clock Reference)
- 90 kHz tick counter embedded in TS adaptation fields.
- Defines the program's own time axis.
- Both video PES PTS and KLV PES PTS are referenced to this clock.
- **Lost when demuxing TS to separate files.** Only exists at the TS layer.

### 1b. Video PES PTS
- Per-frame presentation timestamp in the PES header (33-bit @ 90 kHz).
- Points at PCR moments — i.e., "this video frame is meant to be shown at
  this PCR tick."
- Survives MP4 remux (rebased to start at 0 by most tools), but typically
  *normalized away from absolute PCR* in any pipeline that hands the video
  to a WebCodec decoder.

### 1c. KLV PES PTS
- Per-PES-packet timestamp in the PES header (33-bit @ 90 kHz).
- *Same axis as video PES PTS.* By construction, the encoder stamps both
  streams against the same PCR.
- **The synchronous-mode anchor MISB ST 0604 defines.**
- Lost when extracting KLV to a flat `.klv` file via tools that strip PES
  headers (most ffmpeg `-f data` invocations do this).

### 1d. KLV UnixTimeStamp (Tag 2 / PrecisionTimeStamp)
- 8-byte microsecond UNIX time *inside* the ST 0601 record payload.
- Defined by MISB ST 0603. Survives every demux because it's data, not
  container metadata.
- Intended to be the absolute UTC moment the metadata was sampled — i.e.,
  the time at which the camera "saw" what this record describes.
- **Honest only when the camera's clock is GPS-disciplined and uninterrupted.**
  Free-running RTCs drift; sensor-blanking events can introduce gaps where
  the timestamp on either side doesn't reflect uniformly elapsed wall-clock.

---

## 2. The synchronous-mode pairing (MISB ST 0604)

In a properly authored MISB MPEG-TS, every KLV PES packet has a PTS in its
PES header that's on **the same timeline as the video frame whose imagery
the metadata describes**. This is the per-frame association mechanism the
standard provides.

```
PCR clock:    ─┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬─→
               │   │   │   │   │   │   │   │   │   │
   Video PES:  V0  V1  V2  V3  V4  V5  V6  V7  V8  V9   ← per-frame
   KLV PES:    K0          K1          K2          K3   ← per N-frames

                 KLV PES PTS values fall on PCR ticks
                 that match specific video PES PTS values
                 (every 6th frame here: 5 Hz KLV at 30 fps)
```

The pairing isn't dependent on the rate — KLV may emit per-frame, at 1 Hz,
or anything in between. What matters is that each KLV PES PTS lands on a
specific video frame's PTS (or interpolates between two), on the shared
PCR clock.

---

## 3. What demuxing destroys

The typical workflow for getting MISB into something a browser can play:

```
   ┌──────────────┐    ffmpeg -map ...    ┌─────────────────┐
   │              │   ──────────────────→ │  *.h264         │
   │  *.ts        │                       │  (video ES)     │
   │              │                       └─────────────────┘
   │  PCR + PES   │                       ┌─────────────────┐
   │  for video,  │   ──────────────────→ │  *.klv          │
   │  audio, KLV  │                       │  (raw KLV bytes,│
   │              │                       │   no PES headers)│
   └──────────────┘                       └─────────────────┘
```

**What survives:**
- Video frame counts and inter-frame intervals (the H.264 elementary stream
  preserves picture timing).
- KLV record contents, including Tag 2 `UnixTimeStamp`.

**What's destroyed:**
- PCR (a TS-only construct).
- KLV PES PTS values (in the stripped PES headers).
- The cross-stream timing relationship — both streams are now anchored
  to *zero* in their own files, with no information about how they
  relate to each other on the original PCR clock.

After this kind of demux, the *only* surviving anchor for KLV-to-video
correspondence is comparing each video frame's offset-from-start to each
KLV record's `UnixTimeStamp` (or comparing UnixTimeStamp to the user-set
sitch start time). This works *if* the camera's clock is honest, but
breaks down for several common pathologies (see §5).

Sitrec demuxes MPEG-TS files internally (`src/TSParser.js`) rather than
relying on an external pre-demux, so we have one chance to capture the
PES-PTS data before it's lost. This is what the import pipeline does
(see §6).

---

## 4. What the WebCodec video pipeline does to PTS

Sitrec's video data layer (`CVideoWebCodecBase` + `CVideoMp4Data` /
`CVideoH264Data`) builds a `framePTSus[]` array — one microsecond
timestamp per decoded frame, in *display order* (B-frames are reordered).

```
   chunks[] (decode order):       [I, P, B, B, P, B, B, ...]
                                     ↓ buildTimestampMap (sorts by PTS)
   framePTSus[] (display order):  [0, 33367, 66733, 100100, 133466, ...]
                                   ↑
                       normalized to start at 0 — original PCR
                       absolute is not preserved past this point
```

Two things to know:

- `framePTSus[F]` is the authoritative "time since first frame" for video,
  in microseconds, on whatever clock the encoder used.
- The values are **normalized to start at 0**, so the original PCR-absolute
  positions are gone unless something captured them earlier.

For sync against KLV, this means: video PTS is honest about *intervals*
and frame-to-frame timing, but doesn't carry the cross-stream PCR origin.
That information has to come from a different place.

---

## 5. The pitfalls

### 5a. "Video PTS = real wall-clock"
Tempting, false. PTS is whatever the encoder labeled. A sensor-blanking
event where the camera emits frozen/duplicate frames at the nominal rate
will produce uniform PTS even though real wall-clock during those frames
isn't uniform. The encoder is honest about *frame indexing* but not always
about *real elapsed time per frame*.

### 5b. "KLV UnixTimeStamp = real wall-clock"
Also tempting, also not always true. Cameras with free-running RTCs drift.
Cameras with GPS that re-locks mid-recording can introduce step
discontinuities. Sensor-blanking events typically pause the KLV emitter,
and the post-pause record's timestamp may be honestly later than the
pre-pause one *or* may carry buffer-induced inflation depending on the
implementation.

### 5c. "Cross-stream offset is zero"
For files where video and KLV happen to start at nearly the same PCR
moment, this works fine. For files where KLV started before video (operator
setting up the shot with telemetry on), or where KLV ends after video
(telemetry kept emitting after video stopped), or the reverse — naive
"normalize each side to its own first record" introduces a constant offset
that shows up as a fixed lead/lag throughout playback.

### 5d. "Linear fps stretch can fix any KLV/video disagreement"
Tempting, dangerous. If KLV span and video span differ because the
camera's clocks ran at slightly different rates, a single fps multiplier
might align endpoints. But if they differ because of *gap-induced
non-uniformity* — e.g., the camera paused KLV emission during multiple
sensor events — a linear stretch smears those localized gaps across the
whole clip, making the well-behaved sections worse to fix the localized
artifacts. We tried this and reverted; **fps correction is not the right
mechanism** for gap-heavy MISB files. (Manual fps adjustment via the
Time menu still works for legitimate clock-rate corrections.)

### 5e. "Encoder always emits a frame per real frame interval"
The encoder may decide to drop garbage frames during sensor blanking,
or freeze a "last good" frame for the blanking duration, or emit
black/error/gain-adjusting frames. PTS labels are typically uniform
regardless. The relationship between "frame index in the file" and
"real wall-clock interval represented" can vary frame-to-frame inside
gap regions even when intervals look uniform.

### 5f. "Decoder failure = whole-stream failure"
A single corrupt group (especially a malformed/truncated trailing
keyframe — a common artifact in TS files trimmed mid-frame) will fail
to decode regardless of hardware vs. software. The previous failure
cascade marked *every remaining group* permanently failed once 3 retries
of one bad group accumulated. If many other groups have already loaded
successfully, the right behavior is to mark only the corrupt group
permanently failed and keep the rest of the stream playable
(`CVideoWebCodecBase._onWorkerError` handles this distinction).

---

## 6. What Sitrec does

The pipeline preserves the synchronous-mode timing data the MISB ST 0604
standard provides, and falls back gracefully for files where that data
isn't available.

```
                ┌─────────────────────────────────┐
                │   .ts file (drag & drop)        │
                └─────────────────┬───────────────┘
                                  │
                  ┌───────────────▼────────────────┐
                  │  TSParser.extractTSStreamsAsync│
                  │  per-PES PTS captured for each │
                  │  PUSI=1 packet on each PID;    │
                  │  video stream's first PES PTS  │
                  │  becomes the cross-stream PCR  │
                  │  origin (videoFirstPESus)      │
                  └───────────────┬────────────────┘
                                  │
            ┌─────────────────────┼─────────────────────┐
            ▼                     ▼                     ▼
    ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
    │ video stream │      │ audio stream │      │ KLV stream   │
    │ → CVideo*    │      │ → audio      │      │ → parseKLVFile│
    │   pipeline   │      │   handler    │      │              │
    │ framePTSus[] │      │              │      │ pesPTSus[]   │
    │ normalized   │      │              │      │ shifted by   │
    │ to start = 0 │      │              │      │ videoFirstPES│
    └──────────────┘      └──────────────┘      └─────┬────────┘
                                                      │
                                              ┌───────▼─────────┐
                                              │ CNodeMISBData   │
                                              │ exposes         │
                                              │ getRecordPTSms()│
                                              │ hasRecordPTS()  │
                                              └───────┬─────────┘
                                                      │
                                              ┌───────▼─────────────┐
                                              │ CNodeTrackFromMISB  │
                                              │ recalculate():      │
                                              │ pairs frame F to    │
                                              │ KLV record by       │
                                              │ binary search on    │
                                              │ pesTimeArray (using │
                                              │ framePTSus[F] as    │
                                              │ the lookup key)     │
                                              └─────────────────────┘
```

### 6a. PES PTS capture (`src/TSParser.js`)

During the per-TS-packet scan, when `PAYLOAD_UNIT_START_INDICATOR` is set:

1. Validate the PES start code (`00 00 01 stream_id`).
2. Read the PES_flags byte. If `PTS_DTS_flags` (bits 7-6) indicates PTS
   present, decode the 33-bit PTS value from bytes 9-13.
3. Convert from 90 kHz ticks to microseconds: `pts_us = pts_ticks * 1000 / 90`.
4. Record `{ offset, ptsUs }` into a per-PID `streamPESEntries` map, where
   `offset` is the running byte count of substream content already
   accumulated (so KLV records lying at-or-after that offset are part of
   this PES).

After scanning, the video stream's first PES PTS is captured as
`videoFirstPESus` and threaded onto every emitted stream's metadata —
metadata streams (KLV) need this value to align their own PES PTS values
to the video's normalized origin.

### 6b. KLV record pairing (`src/MISBUtils.js parseKLVFile`)

Three pairing strategies, in priority order:

```
   if (pesEntries.length === n)
       → 1:1 by index (synchronous-mode, common case)
   else if (validPacketOffsets.length === n)
       → pair by byte offset (each scanned KLV "packet" is a record)
   else
       → best-effort interpolation (n records spread across m packets)
```

Each strategy applies the same shift: `pesPTSus[i] = pesEntries[i].ptsUs - videoFirstPESus`.
This puts KLV PTS values on the same axis as the (normalized-to-zero)
video `framePTSus`. Negative values are valid — they represent KLV
records the camera emitted before the first video frame on the PCR clock.

### 6c. Track recalc (`src/nodes/CNodeTrackFromMISB.js`)

```js
// PES-PTS path (TS-sourced files with synchronous-mode KLV):
pesTimeArray[i] = misb.pesPTSus[i] / 1000   // ms, on shared PCR axis

for each frame F:
    msNow = framePTSus[F] / 1000            // ms, on shared PCR axis
    binary_search pesTimeArray for bracketing records
    interpolate position by fraction
```

```js
// Wall-clock fallback (non-TS sources, KML imports, flat .klv files):
for each frame F:
    msNow = msStart + F / Sit.fps × 1000    // synthesized
    binary_search timeArray (UnixTimeStamps) for bracketing records
    interpolate position by fraction
```

The two paths are structurally identical — only the time axes differ.
The PES path uses encoder-stamped PCR-locked timestamps (exact
synchronous-mode pairing); the wall-clock fallback uses Sit-time
synthesized from the playback frame rate and looks up against
absolute UnixTimeStamp values.

### 6d. Track recalc handles "negative" KLV times correctly

```
Frame index:      0          F1                            FN
                  │          │                             │
PCR-relative:    [0]──────[33ms]──────…──────[videoSpan]──→
                                                            
KLV pesTimeArray: [-1718ms]──[X]──…──[videoSpan + Y]──→
                  │
        records before video frame 0
        are negative; binary search 
        ignores them naturally because 
        msNow ≥ 0 for every frame
```

KLV records emitted before video frame 0 (or after the last video frame)
remain in the array with their honest PES-relative times. The binary
search just doesn't touch them when looking up frames inside the video
range.

---

## 7. Diagnostic infrastructure

The Time menu exposes a **"Timing Analysis..."** button that produces a
plain-text report on the current sitch's MISB stream. Sections:

- **Summary** — span comparison, fps, sync verdict.
- **Video Timing** — PTS interval mean/stddev, CFR-vs-VFR verdict.
- **KLV Timing** — interval statistics, coefficient-of-variation, max-gap ratio.
- **KLV Gaps** — every interval > a threshold (typically 100 ms or 3× mean),
  listed with record index, KLV-time, and gap size.
- **Cumulative Drift** — quartile-by-quartile divergence between video PTS
  and KLV cumulative time.
- **Platform/Sensor GPS Velocity Consistency** — Haversine distance
  between consecutive valid records divided by reported time delta;
  flags samples where velocity exceeds both a relative and absolute
  threshold (catches teleports / bad timestamps).
- **Duplicate / Reversed Timestamps** — records where `getTime(i) ≤ getTime(i-1)`.
- **Event Correlations With KLV Gaps** — for each gap, which other MISB
  fields transitioned at the boundary. Bitfield/enum tags (Tag 47
  GenericFlagData, Tag 63 SensorFieldofViewName, Tag 77 OperationalMode)
  are decoded into human-readable form via `MISBValueDecoders.js`.

The report is observation-only. It surfaces what the data contains; it
does not propose corrections. (Earlier iterations included an automatic
fps-correction dialog; that was removed because it can't reliably
distinguish clock-rate error from gap-induced span differences — see §5d.)

---

## 8. Patterns we've seen in real MISB files

### 8a. Trailing-keyframe artifact (common in trimmed TS files)
The file's last keyframe is dramatically smaller than typical (e.g., a
few hundred bytes vs. 100+ KB for normal keyframes). The decoder
correctly rejects it. We treat this as a per-group corruption — mark the
single bad group permanently failed, leave the rest of the stream
playable, log a warning. See `CVideoWebCodecBase._onWorkerError`.

### 8b. Sensor-mode / image-invalid clusters
Long telemetry streams sometimes contain clusters of KLV gaps (typically
3 gaps of ~1.6 s, ~0.8 s, ~0.4 s — a halving signature) at moments where
the sensor was reconfiguring or recovering from a transient invalid state.
The Event Correlations section of the Timing Analysis report identifies
which MISB tags transitioned at the gap boundaries — common signals are:

- `GenericFlagData` (Tag 47) bit 5 ("Image Invalid") clearing or setting:
  transient sensor blanking, e.g., laser fire saturation.
- `ImageSourceSensor` (Tag 11) string changing: camera/sensor swap (DAY_TV
  ↔ MWIR ↔ SWIR on multi-spectral turrets).
- `SensorFieldofViewName` (Tag 63) enum changing: zoom-level switch.
- `TargetTrackGateWidth/Height` (Tags 43, 44) changing: auto-track
  re-acquisition.

### 8c. Cross-stream PCR offset (KLV started before/after video)
If video first PES PTS ≠ KLV first PES PTS on the original PCR clock,
naive normalization makes the streams look aligned at start-of-file
when they actually have a constant lead/lag throughout. This is what
the `videoFirstPESus` shift in `parseKLVFile` corrects — the resulting
`pesPTSus` values are on the *video's* PCR origin, so any genuine
cross-stream offset shows up as the constant it should be (often a few
hundred ms; sometimes a few seconds).

### 8d. KLV at lower rate than video
Many MISB encoders emit metadata at 1, 2, 5, or 10 Hz with video at 30 or
60 fps. The synchronous-mode pairing still works — KLV records pair to
specific video frames at PCR moments where their PES PTS values match,
and frames between are interpolated from bracketing records.

---

## 9. Worked example: data flow on a typical TS file

```
   File: 30 fps video, 5 Hz KLV, ~100 s recording

   At demux:
     TSParser captures per-PES PTS for all 3 streams.
     video first PES PTS = 137_545_000 µs (PCR-absolute)
     KLV first PES PTS   = 137_827_000 µs
     videoFirstPESus = 137_545_000

   In parseKLVFile (KLV stream, 500 records):
     pesPTSus[0]   = 137_827_000 - 137_545_000 = 282_000 µs
                                              (= +282 ms — KLV started
                                               282 ms after video frame 0)
     pesPTSus[499] = (something close to 100_000_000 + 282_000)

   In CVideoWebCodecBase:
     framePTSus[0]    = 0
     framePTSus[2999] = 99_966_633 (≈ 100 s)

   In CNodeTrackFromMISB.recalculate, for each video frame F:
     msNow = framePTSus[F] / 1000             // ms since video start
     binary search pesTimeArray = pesPTSus / 1000
     find bracketing KLV records, interpolate position

   At frame 0 (msNow = 0):
     KLV record 0 is at pesTimeArray[0] = 282 ms (positive — KLV started
       after video). The binary search returns slot = -1 logically,
       but the code interpolates from records 0 and 1 with a negative
       fraction, which is the "extrapolate before record 0" case.

   At frame 1500 (msNow = 50_000 ms, mid-clip):
     pesTimeArray crosses 50_000 around record 250 (5 Hz × 50 s ≈ 250).
     Direct PCR-locked match.

   At frame 2999 (msNow = 99_966 ms):
     pesTimeArray reaches ~100_282 ms at record 499.
     Last frame interpolates between bracketing records cleanly.
```

---

## 10. Where to look in the code

| File                                  | Role                                                  |
|---------------------------------------|-------------------------------------------------------|
| `src/TSParser.js`                     | TS demux, per-PES PTS capture, cross-stream origin    |
| `src/MISBUtils.js`                    | `parseKLVFile()` pairs records to PES PTS             |
| `src/CFileManagerParse.js`            | Threads pesEntries + videoFirstPESus into parseKLVFile|
| `src/CVideoData.js`                   | `getFrameTimeMs()` virtual                            |
| `src/CVideoWebCodecBase.js`           | `framePTSus[]`, per-group decode failure tolerance    |
| `src/nodes/CNodeMISBData.js`          | `getRecordPTSms()`, `hasRecordPTS()`, Timing Analysis |
| `src/nodes/CNodeTrackFromMISB.js`     | `recalculate()` with PES-PTS or wall-clock lookup     |
| `src/MISBValueDecoders.js`            | Bitfield/enum decoders for ST 0601 tags               |
| `src/showTimingAnalysis.js`           | Modal viewer for the timing-analysis report           |

---

## 11. References

- **MISB ST 0601** — UAS Datalink Local Set (the metadata structure)
- **MISB ST 0603** — Common Time Reference for Digital Motion Imagery
  (Precision Time Stamp definition, Time Status byte)
- **MISB ST 0604** — Time Stamping Compressed Motion Imagery (synchronous
  vs. asynchronous KLV carriage; per-PES PTS as the per-frame anchor)
- **MISB ST 1402** — Time Status Indicators (lock/discontinuity bits)
- **MISB ST 1603** — Time Transfer Local Set (extended time-quality metadata)
- **STANAG 4609** — NATO standard wrapping the MISB suite for ISR video
- **ISO/IEC 13818-1 §2.12.4** — "Use of PES packets to transport metadata"
  (the underlying MPEG-TS mechanism MISB ST 0604 builds on)
