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

- **MISB** — Motion Imagery Standards Board, which publishes metadata
  standards for motion imagery.
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
  - `CNodeMISBDataTrack` — wraps a parsed KLV record array.
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

Sitrec touches **a chain of clocks**, four conceptual layers from the stream
on disk up to what physics evaluates against. The point of the chain is that
each layer derives from the one above by a well-defined construction;
conflating layers — or letting a layer get its alignment from the wrong
parent — is the source of essentially every sync bug we've seen.

```
   ┌─────────────────────────────────────────────────────────────────────┐
   │  Layer 0: MPEG-TS stream-level (per file, baked at encode time)     │
   │                                                                     │
   │   ┌──────────┐   ┌────────────┐   ┌──────────────────┐              │
   │   │   PCR    │←──┤ Video PES  │   │  KLV PES         │              │
   │   │ (90 kHz) │   │  PTS       │   │  PES PTS         │              │
   │   │          │←──┴────────────┘   └──────────────────┘              │
   │   │          │←─────── KLV record  ┌──────────────────┐             │
   │   │          │         payload     │  KLV Tag 2:      │             │
   │   │          │         contains──→ │  UnixTimeStamp   │             │
   │   └──────────┘                     └──────────────────┘             │
   └─────────────────────────────────────────────────────────────────────┘
                                  ↓ TSParser captures pesEntries[]
                                  ↓ parseKLVFile shifts by -videoFirstPESus
   ┌─────────────────────────────────────────────────────────────────────┐
   │  Layer 1: PCR-relative microseconds (cross-stream comparison)       │
   │                                                                     │
   │   videoData.framePTSus[i] - videoData.framePTSus[0]                 │
   │   misb.pesPTSus[j]           ← same video-relative axis; negative   │
   │                                  values are valid                   │
   │                                                                     │
   │   Video retains its source origin; the subtraction and the already- │
   │   shifted KLV values produce "PCR-µs since first video frame."      │
   └─────────────────────────────────────────────────────────────────────┘
                                  ↓ Sit.fps re-samples PCR uniformly
   ┌─────────────────────────────────────────────────────────────────────┐
   │  Layer 2: Sitrec timeline (the "real time" physics evaluates at)    │
   │                                                                     │
   │   par.frame ∈ [0 … Sit.frames-1]   ←  the scrubber position         │
   │   physics_seconds  =  par.frame / Sit.fps                           │
   │                                                                     │
   │   par.frame indexes the active video data. For real PTS, KLV lookup │
   │   uses framePTSus[par.frame] - framePTSus[0] and interpolates       │
   │   between bracketing pesPTSus[j]. A patched wrapper inserts held    │
   │   virtual frames when source PTS contains dropped-frame gaps.       │
   └─────────────────────────────────────────────────────────────────────┘
                                  ↓ Sit.startTime adds a UTC label
   ┌─────────────────────────────────────────────────────────────────────┐
   │  Layer 3: Wall-clock display (decorative — does NOT drive sync)     │
   │                                                                     │
   │   displayed_UTC  =  Sit.startTime + par.frame / Sit.fps             │
   │                                                                     │
   │   Used for: scrubber date label, sun position in night-sky scene,   │
   │   ADS-B / TLE / ephemeris correlation — places where the *real*     │
   │   physical world enters. NOT used for KLV-to-video pairing.         │
   └─────────────────────────────────────────────────────────────────────┘
```

The TL;DR: **the PCR clock is the master.** Layer 1 is just PCR with a
chosen origin and unit. Layer 2 is a uniform sampling of Layer 1. Layer 3
is a UTC label glued onto Layer 2; it answers "what was the wall-clock at
this point in the recording?" but doesn't define when video and KLV align —
that's settled at Layer 1 by construction (MISB ST 0604 guarantees the
encoder stamped both PES streams from the same PCR).

`UnixTimeStamp` (KLV Tag 2) is *also* a wall-clock claim, but it lives
inside the record payload rather than on any of these layers. Treat it as
metadata-the-encoder-thought-was-true, not as a sync anchor — it's used
only when Layer 1 timing is unavailable (asynchronous-mode KLV, MP4
sources, flat-file `.klv`).

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
- We have seen real files where UnixTimeStamp runs at clock skews up to
  -100,000 ppm (-10%, i.e., the Tag 2 clock advances 90 s for every 100 s
  of PCR). At that magnitude it's not RTC drift, it's the encoder writing
  Tag 2 from the wrong source (a counter scaled by a wrong rational, a
  different oscillator entirely, etc.). PCR-anchored PTS pairing is
  unaffected; UnixTimeStamp-only pairing on such files is impossible.

### 1e. Sitrec timeline clock (Layer 2 in the chain)
- Not a stream-level construct — Sitrec's own *internal* clock, expressed
  in `par.frame` (an integer) at rate `Sit.fps` (typically 12, 24, 30, or
  60 fps depending on the sitch).
- Defines the rate at which physics, animations, the node graph, and the
  scrubber UI advance.
- `par.frame` indexes the active video data. In PTS-pairing mode, that
  frame's real timestamp supplies the lookup time after subtracting the
  first frame's timestamp; Sitrec does not infer it from `N / Sit.fps`.
- When dropped-frame patching applies, `CVideoPatchedData` exposes a virtual
  active video whose timestamp at frame `N` is
  `T0 + N × 1e6 / Sit.fps`; missing source slots become held frames. This is
  the path that makes the runtime timeline uniform without discarding the
  source frame/PTS mapping.
- When real timing is unavailable, KLV lookup falls back to the nominal
  sitch rate and UnixTimeStamp values as described in §6c.

### 1f. `Sit.startTime` (Layer 3 — wall-clock display label)
- A single UTC value attached to the sitch: "what wall-clock moment is
  par.frame = 0?"
- Usually synchronized to the imported timed track's first usable timestamp
  through `CNodeDateTime.syncToTrack()`. A sitch definition or the user can
  override it; sources without a timed track use their available metadata or
  configured start time. Sitrec does not currently subtract `pesPTSus[0]`
  when choosing this wall-clock label.
- **Decorative for sync purposes.** The displayed scrubber date is
  `Sit.startTime + par.frame / Sit.fps`; if Sit.startTime is wrong by a
  minute, the scrubber's date label is wrong by a minute and the sun's
  azimuth in the night-sky scene is wrong, but video and KLV stay
  perfectly aligned with each other (they're on PCR, not on Sit.startTime).
- Where Sit.startTime *does* matter: anywhere Sitrec talks to the real
  physical world by absolute UTC. That's solar/lunar ephemerides, TLE
  satellite propagation, ADS-B aircraft track timestamps, weather data,
  and any external dataset with its own UTC. Wrong Sit.startTime →
  correct internal sync, wrong external sync.

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
                 (every 3rd frame here: 10 Hz KLV at 30 fps)
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
   framePTSus[] (display order):  [t0, t1, t2, t3, t4, t5, t6, ...]
                                   ↑
                  per-frame value of chunks[i].timestamp,
                  origin depends on the source path
```

### The crucial distinction: real vs. synthetic chunk timestamps

`framePTSus[i]` is whatever `chunks[i].timestamp` was when the chunk was
constructed. There are two construction paths and they produce different
kinds of timestamps:

- **MP4 source (`CVideoMp4Data`)**: timestamps come from mp4box.js, which
  reads them out of the `stts`/`ctts` boxes — *real* per-frame PTS values
  with B-frame reorder already handled. `mp4_demuxer.js` converts each
  sample's CTS and duration from the track's media timescale to integer
  microseconds before constructing `EncodedVideoChunk`; WebCodecs requires
  microseconds, and treating another timescale as if it were 1,000,000 would
  create false interval gaps. These timestamps honor any non-uniform frame
  spacing the encoder produced.
- **H.264 elementary stream from TS demux (`CVideoH264Data`)**: NAL units
  are grouped into frames inside `H264Decoder.createEncodedVideoChunks`,
  which historically stamped `chunk.timestamp = i × frameDuration` —
  **synthetic uniform** timestamps. Those values look real to any
  downstream code, but they pretend every frame is at its nominal slot
  even when the source had dropped frames in mid-recording.

The synthetic path silently corrupts KLV-to-video sync whenever video
frames were lost. The decoder treats N missing frames as a single frame
transition, the synthetic stamp advances by `1 × frameDuration` instead
of `N × frameDuration`, and every frame after the burst inherits the
accumulated shift.

The fix is to thread the per-PES PTS values that `TSParser` already
captures into `createEncodedVideoChunks` so the chunks get *real*
timestamps. The plumbing:

```
   TSParser.extractTSStreams
       ↓ streamPESEntries[pid] = [{offset, ptsUs}, ...]
   parseAsset (TS substream callback)
       ↓ fileManagerEntry.pesEntries = streamMetadata.pesEntries
   FileManager.list[<h264-substream-key>].pesEntries
       ↓ CVideoH264Data.initializeCaching reads it
   H264Decoder.createEncodedVideoChunks(nalUnits, fps, pesPtsUs)
       ↓ when pesPtsUs.length === frames.length, use the real PTS
   chunks[i].timestamp  =  pesPtsUs[i]    (real, gap-honoring)
                       OR  i × frameDuration  (synthetic fallback)
```

Sitrec exposes `videoData.hasRealFramePTS()` so consumers can tell which
mode they're in. When false, `framePTSus[]` is uniform and any
"frame-to-PCR-time" calculation that relies on it is wrong inside dropped-
frame regions.

### Origin / normalization

With real PTS, `framePTSus[0]` is the *absolute* PCR-time of the first
video frame (typically a multi-second PCR-clock value, not zero). Code
that needs "time since first video frame" subtracts `framePTSus[0]`
explicitly (`CNodeTrackFromMISB` does this with `videoFirstPTSus`).
Likewise, `parseKLVFile` shifts `pesPTSus[]` by `-videoFirstPESus` so
KLV PES values land on the same "time since first video PCR" axis.

For sync against KLV, this means: with real PTS, video timing honors
both interval irregularities and the cross-stream PCR origin. With
synthetic PTS, only the interval-equivalent fiction is available.

---

## 5. The pitfalls

### 5a. "framePTSus[] is always real PTS"
The trap that hid for a long time. Anything in the codebase reading
`videoData.framePTSus[i]` or `videoData.getFrameTimeMs(i)` cannot tell
on its own whether the values came from real container PTS (mp4box.js
on MP4, our PES-PTS forwarding on TS-sourced H.264) or from synthetic
uniform `i × frameDuration` stamps. Both shapes are arrays of
monotonically-increasing microsecond values. The synthetic ones look
*especially* convincing because they pass every interval-uniformity
check.

The remedy is to gate any per-frame-time use on `videoData.hasRealFramePTS()`.
Synthetic values are still useful as a fallback (they match the playback
rate, which is what most UI elements actually want), but they are *not*
trustworthy as a "real PCR time" reference for KLV pairing.

### 5b. "KLV UnixTimeStamp = real wall-clock"
Tempting, not always true. Cameras with free-running RTCs drift (50–500
ppm is normal; we've seen 600+ ppm). Cameras with GPS that re-locks
mid-recording can introduce step discontinuities. Sensor-blanking events
typically pause the KLV emitter, and the post-pause record's timestamp
may be honestly later than the pre-pause one *or* may carry buffer-induced
inflation depending on the implementation. UnixTimeStamp is the camera's
opinion of wall-clock at sample time; the encoder PCR is the authoritative
recording-time anchor when both are present.

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

### 5e. "Video span < KLV span = drift"
Often *not* drift. When a TS file has video that stops a few seconds
before KLV stops (the recording was halted while telemetry continued),
the video PES PTS span is shorter than the KLV PES PTS span by exactly
the trailing telemetry duration. PES-PTS pairing handles this correctly:
the trailing KLV records simply have no corresponding video frames. The
"drift" you see in proportional-quartile comparisons (q × records vs.
q × frames at q < 1.0) is a rate-mismatch artifact, not a clock-skew
problem. The drift-decomposition section of the Timing Analysis report
splits the observed end-difference into linear clock skew (regressed
over the gap-free pre-burst region) + cumulative gap time + residual,
which lets you see the contributors clearly.

### 5f. "Decoder failure = whole-stream failure"
A single corrupt group (especially a malformed/truncated trailing
keyframe — a common artifact in TS files trimmed mid-frame) will fail
to decode regardless of hardware vs. software. The previous failure
cascade marked *every remaining group* permanently failed once 3 retries
of one bad group accumulated. If many other groups have already loaded
successfully, the right behavior is to mark only the corrupt group
permanently failed and keep the rest of the stream playable
(`CVideoWebCodecBase._onWorkerError` handles this distinction).

### 5g. "Derived tracks inherit their parent's PES PTS"
A subtle one. When Sitrec splits a single MISB stream into multiple tracks
— the source platform plus derived Center or Truth tracks — a derived path
builds a fresh row array. Array properties such as `pesPTSus` do not follow
those rows automatically.

The result on a healthy file is invisible: KLV UnixTimeStamps and PES
PTS values agree closely, so falling back to UnixTimeStamp pairing on the
Center track produces near-identical results. On files with severe
UnixTimeStamp skew (see §1d), the platform track stays PCR-locked while
the Center track drifts up to several seconds *per minute of recording*
on the broken UTS clock. Camera position is correct; camera look-direction
is up to tens of seconds out of phase. Visually: scrub to anywhere late
in the run, the platform is in the right spot but it's pointing at where
the gimbal was looking many seconds ago.

The fix is centralized in `CTrackFileMISB._buildDerivedTrack()`: it builds a
parallel PES array while applying the same row filter as the derived data,
then attaches that array as `derivedMisb.pesPTSus`. Center and Truth tracks
both use the helper. Any future derived path must do the same or it silently
falls back to UTS pairing.

### 5h. "There's only one KLV stream"
Some MISB-compliant transmitters emit **two** KLV streams in the same TS:
an asynchronous one (no PES PTS, timing carried by Tag 2 UnixTimeStamp
inside the payload) and a synchronous one (PES PTS present, locked to
PCR). The two may be at different rates and have different track
content. Picking the first MISB data node in iteration order can land
on either; the analyzer prefers one with `hasRecordPTS() === true` so
the synchronous-mode timing is used. Track-side, the camera platform
may be locked to whichever PID the user authored, and that determines
which pairing path runs. See §8f.

---

## 6. What Sitrec does

The pipeline preserves the synchronous-mode timing data the MISB ST 0604
standard provides, and falls back gracefully for files where that data
isn't available.

> The pipeline can additionally **invert** the sync
> strategy for files with dropped-frame bursts: instead of advancing the
> sim clock at the gappy decoded-video rate (which makes the sim
> accelerate through bursts), wrap the source `CVideoData` in a
> `CVideoPatchedData` decorator that presents a uniform-cadence virtual
> timeline whose held slots reuse the most recent decoded frame. KLV
> stays unaltered. See **§12** for the full design.

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
   ┌────────────────┐     ┌──────────────┐    ┌────────────────────┐
   │ video substream│     │ audio stream │    │ KLV substream(s)   │
   │ pesEntries[]   │     │ → audio      │    │ pesEntries[]       │
   │ stashed on     │     │   handler    │    │ stashed on         │
   │ FileManager    │     │              │    │ FileManager entry  │
   │ entry          │     │              │    │ → parseKLVFile     │
   └───────┬────────┘     └──────────────┘    └─────────┬──────────┘
           │                                            │
   ┌───────▼─────────────┐                  ┌───────────▼───────────┐
   │ CVideoH264Data      │                  │ pesPTSus[i] shifted   │
   │ initializeCaching:  │                  │ by -videoFirstPESus   │
   │   reads pesEntries  │                  │ → on shared PCR axis  │
   │   from FileManager  │                  └───────────┬───────────┘
   │   → real PTS into   │                              │
   │   createEncoded-    │                  ┌───────────▼─────────┐
   │   VideoChunks       │                  │ CNodeMISBDataTrack  │
   │ → chunks have real  │                  │ exposes             │
   │   PCR timestamps    │                  │   getRecordPTSms()  │
   │ → framePTSus[] real │                  │   hasRecordPTS()    │
   │   framePTSFromPES=t │                  └───────────┬─────────┘
   └─────────┬───────────┘                              │
             │                                          │
             └──────────────────┬───────────────────────┘
                                ▼
                  ┌──────────────────────────────┐
                  │ CNodeTrackFromMISB           │
                  │ recalculate():               │
                  │  PTS     hasRealFramePTS()   │
                  │          AND hasRecordPTS()  │
                  │          → PCR pairing       │
                  │  UTS     else: async-mode    │
                  │          KLV, or synthetic   │
                  │          video PTS           │
                  │          → nominal-Sit.fps   │
                  │            UTS wall-clock    │
                  └──────────────────────────────┘
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
metadata streams (KLV) need this value to express their own PES PTS values
relative to the first video frame.

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
This puts KLV PTS values on the video-relative axis used by
`framePTSus[F] - framePTSus[0]`; the raw video array itself retains its
source origin. Negative KLV values are valid — they represent records emitted
before the first video frame on the PCR clock.

#### Saving and reloading PES timing

Once a TS has been split into substreams, a saved sitch may reload those
substream files without the parent TS. `CFileManagerSave._makePesSidecarBuffer()`
therefore writes a JSON timing sidecar next to every persisted substream that
has PES timing. New saves use `<substream>.pts.txt`; the loader also accepts the
older `.pts.json` form.

The sidecar stores the raw `pesEntries[]` and `videoFirstPESus`, not the derived
`pesPTSus[]`. On reload, `CustomManagerSerialize` fetches the sidecar in
parallel with the substream and passes those canonical inputs back through
`parseKLVFile()`. This lets future pairing fixes apply on reload and avoids
demuxing a parent TS that may no longer be present. A missing or invalid
sidecar does not abort the import: the loader records the failure for Timing
Analysis, and the track falls back to its usable non-PES timing path.

### 6c. Track recalc (`src/nodes/CNodeTrackFromMISB.js`)

Two pairing modes, in priority order. Mode selection is based on
which timing data is real on each side:

```js
// PTS mode — PES-PTS pairing (synchronous)
//   When: KLV side has real PES PTS (hasRecordPTS()) AND video side has
//         real PTS (hasRealFramePTS()). Both clocks are PCR-locked.
//   Why best: per-frame association is what MISB ST 0604 defines;
//             clock skew and dropped frames don't introduce any drift.
pesTimeArray[i] = misb.pesPTSus[i] / 1000   // ms, on shared PCR axis
for each frame F:
    msNow = (framePTSus[F] − framePTSus[0]) / 1000   // ms, shared PCR
    binary_search pesTimeArray for bracketing records
    interpolate position by fraction
```

```js
// UTS mode — wall-clock fallback (asynchronous, UnixTimeStamp lookup)
//   When: anything else — KLV side has no usable PES PTS (asynchronous-
//         mode KLV, flat .klv, MP4), the PES values aren't monotonic, or
//         the video has only synthetic PTS (image source). This is the
//         `else` branch; it does NOT read framePTSus.
//   How: msNow advances at the nominal Sit.fps rate from msStart (the
//        recording-start-equivalence assumption msStart ≈ first KLV UTS
//        handles cross-stream origin); KLV is looked up by UnixTimeStamp.
for each frame F:
    msNow = msStart + F × Sit.simSpeed / Sit.fps × 1000   // simSpeed usually 1
    binary_search timeArray (UnixTimeStamps) for bracketing records
    interpolate position by fraction
```

Both modes are structurally identical — same binary search, same
interpolation. Only the time axis (msNow source) and lookup table
(pesTimeArray vs. UnixTimeStamps) differ. The selector is a single
`usePESPTS` flag: true only when the video has real PTS *and* the KLV
records carry monotonic PES PTS; every other case takes the `else`
branch (the UTS fallback).

**The dropped-frame caveat.** The UTS fallback's nominal-Sit.fps clock
assumes uniform frame timing. A video with real PTS but *dropped-frame
bursts* whose KLV is asynchronous-mode (so PTS pairing can't run) would,
at the nominal rate, pair every post-burst frame to a too-early KLV
record. This is handled not by the pairing mode but by **§12 frame
patching**: the dropped-frame video is wrapped to a uniform-cadence
virtual timeline (on by default — `Globals.useVideoPatching`), so by the
time the UTS fallback runs the timeline really is uniform and `msNow`
tracks true wall-clock. With patching disabled, this is the one
configuration in which the UTS fallback can desync — see §8e and §12.

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
plain-text report on the current sitch's MISB stream. The report is
designed to be the *only* diagnostic surface needed on a system where
interactive console / MCP access isn't available — every signal that
matters lives in the dump itself.

The handler iterates *all* CNodeMISBDataTrack nodes in NodeMan and:
1. Lists every loaded MISB data node with its record count and
   `hasRecordPTS()` flag (matters when the file has multiple KLV
   PIDs — see §5h, §8f).
2. Picks the first one with `hasRecordPTS() === true` for the deep
   analysis, falling back to the first node otherwise.
3. Lists every derived MISB track (`CNodeTrackFromMISB` and subclasses)
   with the loaded stream it bound to and the pairing **mode** it
   resolved to (PTS pairing vs UTS fallback), plus the shared video-PTS /
   frame-patching state — the **"Track Pairing"** prelude block. This
   answers "is the displayed track on the sync or the async KLV stream?"
   for multi-PID files (§5h, §8f). Shown only when there are multiple
   streams or any track falls to the UTS fallback; structural-only
   (positional Stream labels and counts, no node ids). The mode reported
   is the actual `usePESPTS` decision the track's last `recalculate()`
   made, read from its in-memory `pairingInfo` stamp.

Sections of the deep analysis:

- **Summary** — span comparison, fps, sync verdict.
- **Video Timing** — PTS interval mean/stddev, CFR-vs-VFR verdict, plus
  a **"Frame PTS source"** line telling you whether `framePTSus[]` is
  real PES PTS (TSParser pesEntries) or synthetic uniform stamps. Also
  lists every **video PTS jump** (interval > 1.5× mean) — the dropped-
  frame bursts that cause the desync described in §5a.
- **KLV Timing** — interval statistics on UnixTimeStamps, coefficient-
  of-variation, max-gap ratio.
- **KLV Gaps** — every UnixTimeStamp interval > a threshold (typically
  100 ms or 3× mean), with record index, KLV-time, and gap size.
- **KLV PES PTS Availability** — diagnostics for the synchronous-mode
  anchor. Reports `hasRecordPTS()`, `pesPTSus[]` length and non-null
  count, the matching FileManager entry's filename, dataType, parent TS
  filename, and the stashed `pesEntries` / `videoFirstPESus`. When
  hasRecordPTS is false this block tells you exactly which step of
  the chain dropped the data (TSParser captured 0, parseKLVFile
  fallback hit, FileManager entry missing, etc.).
- **KLV PES PTS Timing** — when available, mirror of the UnixTimeStamp
  Timing section but using `pesPTSus[]`. Reveals whether gaps are real
  PCR-clock pauses (visible in PES too) or wall-clock fabrications
  (visible only in UnixTimeStamp).
- **KLV PES PTS Gaps** — same threshold check applied to PES PTS
  intervals.
- **Cumulative Drift** — quartile-by-quartile divergence between video
  PTS and KLV cumulative time, with both `uts-diff` and `pes-diff`
  columns when PES PTS is available. Note this is *proportional-index*
  pairing (q × records vs. q × frames), so it shows rate-mismatch
  artifacts as well as actual drift — see §5e.
- **Drift Decomposition** — splits the observed end-of-run KLV-vs-video
  span difference into linear clock skew (regressed over the gap-free
  pre-burst region only — pairing post-gap samples corrupts the slope
  with cumulative gap shifts) + cumulative gap time + unexplained
  residual. Lets you read the contributors at a glance.
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

### 8e. Dropped-frame video bursts (the desync investigation)
H.264 elementary streams from MISB sources sometimes have clusters of
*missing* frames in the bitstream: the encoder simply didn't emit NAL
units for those frame slots. The container/PES still keeps marching at
real PCR rate, so the next emitted frame's PES PTS is +N×33.367 ms ahead
of the previous one (an 800 ms PES interval is common at burst centers).

When chunk timestamps come from container PES (MP4 via mp4box, or our
post-fix H.264 path), `framePTSus[]` reflects this, so PTS pairing
stays correct and — via §12 patching — so does the UTS fallback.
When chunk timestamps come from synthetic `i × frameDuration` stamps
(the pre-fix H.264 path), the burst gets
swallowed: the next surviving frame just gets the next sequential stamp,
no acknowledgment of the gap. KLV pairing then mis-pairs every frame
after the first burst by the cumulative dropped-frame interval, and
the misalignment grows with each subsequent burst.

This pattern is visible in the Timing Analysis report's "Video PTS jumps"
subsection. A typical late-recording cluster looks like:

```
   frame     pts-time      gap (ms)
   ──────    ──────────    ────────
    26868        896.85 s        384
    26869        897.65 s        801
    26870        898.10 s        450
    27123        907.64 s        384
    29414        984.42 s        367
    ...
```

The jump pattern aligns with sensor-mode cluster boundaries (§8b) — same
underlying camera events that pause the KLV emitter sometimes drop video
frames too. Not all KLV gaps coincide with video-side jumps and vice versa.

### 8f. Multi-PID KLV (asynchronous + synchronous on the same TS)
Some MISB-compliant transmitters emit two parallel KLV streams in one
TS program:

- **Asynchronous-mode KLV**: PES packets without PTS (`PTS_DTS_flags = 0`),
  timing carried only by Tag 2 UnixTimeStamp inside each record's payload.
  Survives any pipeline that strips PES headers.
- **Synchronous-mode KLV**: PES packets with PTS_DTS_flags set, locked to
  PCR. Provides per-record PCR timing (the `pesPTSus[]` we use for
  drift-free pairing).

The two streams may have different content (different TrackIDs,
different rates) or the same content with different timing modes. Both
get extracted as separate substreams, each with its own FileManager
entry. The asynchronous one will have `pesEntries: []` (TSParser
captures zero entries because none of the PES packets carry PTS); the
synchronous one will have one entry per record.

`hasRecordPTS()` is the straightforward way to tell at the data-node
level. The Timing Analysis "MULTIPLE MISB DATA STREAMS LOADED" prelude lists
every loaded one. If the user's camera platform is locked to a track
backed by the async-mode node, only the UTS wall-clock fallback is
available (nominal-rate UTS lookup); PTS pairing needs the sync-mode node on
the KLV side.

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
     pesPTSus[499] = (something close to 99_800_000 + 282_000)

   In CVideoH264Data (via TSParser-supplied pesEntries):
     framePTSus[0]    = 137_545_000     (= original PCR PTS of first frame)
     framePTSus[2999] = 237_511_633     (≈ 100 s after the first)
     framePTSFromPES = true

   In CNodeTrackFromMISB.recalculate (PTS pairing: both sides have PES PTS),
   for each video frame F:
     videoFirstPTSus = framePTSus[0] = 137_545_000
     msNow = (framePTSus[F] − videoFirstPTSus) / 1000   // ms since video start
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
     pesTimeArray reaches ~100_082 ms at record 499.
     Last frame interpolates between bracketing records cleanly.
```

---

## 10. Where to look in the code

| File                                  | Role                                                  |
|---------------------------------------|-------------------------------------------------------|
| `src/TSParser.js`                     | TS demux, per-PES PTS capture (per PID), cross-stream origin |
| `src/H264Decoder.js`                  | `createEncodedVideoChunks(nalUnits, fps, pesPtsUs?)` — uses real PES PTS when supplied |
| `src/MISBUtils.js`                    | `parseKLVFile()` pairs records to PES PTS             |
| `src/TrackFiles/CTrackFileMISB.js`    | Splits a MISB stream into source and derived tracks; `_buildDerivedTrack()` forwards filtered `pesPTSus[]` values — see §5g |
| `src/CFileManagerParse.js`            | Threads pesEntries + videoFirstPESus into parseKLVFile and stashes them on FileManager entries (also for video substreams, used by CVideoH264Data) |
| `src/CFileManagerSave.js`             | Writes `.pts.txt` timing sidecars for local and rehosted TS substreams |
| `src/CustomManagerSerialize.js`       | Saves sidecar references and restores their timing metadata during reload |
| `src/CVideoData.js`                   | `getFrameTimeMs()` and `hasRealFramePTS()` virtuals  |
| `src/CVideoH264Data.js`               | Reads pesEntries off FileManager entry and threads through createEncodedVideoChunks; sets `framePTSFromPES` |
| `src/CVideoWebCodecBase.js`           | `framePTSus[]`, `hasRealFramePTS()` impl, per-group decode failure tolerance |
| `src/nodes/CNodeMISBData.js`          | `getRecordPTSms()`, `hasRecordPTS()`, Timing Analysis |
| `src/nodes/CNodeTrackFromMISB.js`     | `recalculate()` with two-mode pairing (PTS pairing / nominal-rate UTS wall-clock fallback) |
| `src/nodes/CNodeDateTime.js`          | Timing Analysis button handler — picks the MISB node with `hasRecordPTS()` if any |
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

---

## 12. Frame patching: virtualized timeline (`CVideoPatchedData`)

The PTS pairing of §6c is *correct* about KLV-to-video association on
the PCR axis but creates a second-order problem in playback: when the
decoded-video timeline has dropped-frame bursts, the sim advances at the
gappy rate. `Sit.frames` is the count of *decoded* frames and `Sit.fps`
is nominal, so a 100-second PCR span with 300 missing video frames out
of 3,000 plays back in 90 seconds of wall time. KLV (paired correctly
against PCR via PTS pairing) appears to *speed up* through the bursts.

**The inversion.** Don't retime KLV; retime the video. Wrap the source
`CVideoData` in a `CVideoPatchedData` decorator that synthesizes a
uniform-cadence virtual timeline. Held slots reuse the most recent real
decoded frame. KLV/UTS/PES values stay exactly as authored.

```
PCR axis (real)        ──┬──┬──┬──┬───────────┬──┬──┬──→
                         │  │  │  │           │  │  │
source.framePTSus[]      0  1  2  3           7  8  9
                                  └──gap──────┘
                                  (frames 4,5,6 missing)

virtual timeline       ──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──→
                         │  │  │  │  │  │  │  │  │  │
patched.framePTSus[V]    0  1  2  3  4  5  6  7  8  9
                         │  │  │  │  │  │  │  │  │  │
patched.virtualToSource  0  1  2  3  3  3  3  4  5  6
                                  ↑──held run─↑
```

Every virtual frame `V` has `framePTSus[V] = T0 + V × (1e6/Sit.fps)` —
linear, on the *original* PCR origin `T0 = source.framePTSus[0]`. So
`framePTSus[V] − framePTSus[0] = V × frameDuration`, identical to
`V × 1e6/Sit.fps` (µs). PTS pairing in `CNodeTrackFromMISB` continues to
work *without modification*: `msNow` advances at honest wall-clock rate;
KLV's `pesPTSus[]` (already shifted by `videoFirstPESus`) is on the same
axis. Held bursts on the source produce held image runs in the wrapper
while the camera position interpolates smoothly across the gap from the
unaltered KLV.

### 12a. Algorithm

```
T0 = source.framePTSus[0]
TN = source.framePTSus[source.frames - 1]
frameDuration = 1e6 / Sit.fps
halfStep = frameDuration / 2

for V = 0, 1, 2, … (until targetPTS > TN + halfStep):
    targetPTS = T0 + V × frameDuration
    advance S forward while source.framePTSus[S+1] ≤ targetPTS + halfStep
    map[V] = S
    virtualPTSus[V] = targetPTS
```

Accumulator-style — never `round((TN−T0)/frameDuration)`, which drifts
on long clips because intervals aren't exact multiples of nominal
`frameDuration` (PCR jitter, 29.97 vs 30 fps, accumulated skew). Walks
source forward once.

### 12b. Wrap predicate

`shouldWrap(source, fps)` iff:
1. `source.hasRealFramePTS()` is true.
2. There exists at least one interval ≥ **1.9 × nominal frameDuration**.

The 1.9× threshold (not the diagnostic 1.5×) — genuine dropped frames
are ≥ 2× by definition; B-frame reorder and rate-control jitter can
produce 1.3–1.7× legitimately. Sliver below 2× absorbs minor clock skew.

### 12c. Source vs. virtual indexing — the persistence contract

Two distinct frame-index spaces, with a sharp persistence boundary:

| Surface | Index space |
|---|---|
| `par.frame` during playback | virtual |
| `Sit.frames`, `Sit.videoFrames` | virtual count |
| `videoData.framePTSus[V]` consumed by PTS pairing | virtual |
| Scrubber UI position | virtual |
| Saved JSON: manual-tracking keyframes with `frameSpace: "source"` | **source** |
| URL `?frame=N` and frame-control APIs | virtual/runtime |
| Timing Analysis report frame numbers | source |

**Why split.** Source-indexed manual-tracking storage is stable across
re-import, patching toggles, and `Sit.fps` changes — a keyframe authored
against specific pixels follows those pixels rather than a wall-clock slot.
Runtime navigation stays virtual because that is the timeline the user sees
and the node graph evaluates.

The wrapper exposes both directions:

- `wrapper.virtualToSource(V) → S` = `map[V]`
- `wrapper.sourceToVirtual(S) → V` = the *first* virtual slot for source
  frame `S` (the canonical V; held duplicates collapse onto it).

`CNodeTrackingOverlay.modSerialize` calls `virtualToSource` on every
keyframe and emits `frameSpace: "source"`. `modDeserialize` waits on
`videoLoaded`, then translates source→virtual via `sourceToVirtual`.

### 12d. Held-frame keyframe rule

Manual-tracking UI **forbids** placing keyframes on held virtual frames.
Held frames have no unique pixels, so a keyframe authored there would
collapse onto the canonical V at save time and lose information.
Ctrl-click placement on a held frame logs a warning and does nothing.
Existing keyframes interact as usual — interpolation between
canonical-V keyframes that bracket a held burst gives smooth pixel
motion across the gap, paired against KLV at the correct wall-clock
moment for each held V.

### 12e. Stabilization key collapse

`videoData.setStabilizationData(map<frame, xy>, …)` on the wrapper
**canonicalizes** keys: every input frame (including held V's) maps to
its canonical virtual slot, last-write-wins on collisions. This
prevents adjacent held V's from generating different shifts on
identical pixels, which would otherwise produce visible jitter.
`CObjectTracking.runFastTrackingLoop` skips held V's entirely (carrying
the prior tracked position forward) — template matching on identical
pixels is wasted work.

### 12f. Migration

- **Saves with `frameSpace: "source"`** — translate source→virtual on
  load. New format.
- **Saves with no `frameSpace`** — assumed virtual (legacy synthetic-
  uniform space was equivalent). Keyframes load at their saved indices.
  For files that *would* now be wrapped, this is slightly off through
  bursts; resaving the sitch upgrades it to the new format.

### 12g. Diagnostic surfacing

The Timing Analysis report's Video Timing section gains a "Frame
patching" block reporting source frame count, virtual frame count, held
frame count and percent, and longest hold. The PTS pairing log line
prints `[wrapped]` when `videoData.getPatchStats` is available. During
the current build, held frames are returned with a 60-px red square in the
top-right corner because the module constant `DEBUG_HELD_MARKER` is `true` in
`CVideoPatchedData.js`; set that constant to `false` to hide the marker.

### 12h. Where to look in the code

| File | Role |
|---|---|
| `src/CVideoPatchedData.js` | The decorator class: mapping algorithm, source/virtual translation, held detection, stabilization-key canonicalization, held marker, `shouldWrap` predicate, `getPatchStats` |
| `src/Globals.js` | `useVideoPatching` flag (default true) |
| `src/nodes/CNodeVideoView.js` | Wrap decision in `loadedCallback` once `framePTSus[]` is populated; updates `Sit.videoFrames` and runs `updateSitFrames()` inline |
| `src/nodes/CNodeTrackingOverlay.js` | Source/virtual save/load translation; held-frame placement guard |
| `src/CObjectTracking.js` | Held-frame skip in `runFastTrackingLoop` |
| `src/nodes/CNodeMISBData.js` | "Frame patching" block in Timing Analysis report |
| `tests/CVideoPatchedData.test.js` | Unit tests for the mapping algorithm |
