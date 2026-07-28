/**
 * Abstract base class for track file parsers.
 *
 * ## Adding a New Track File Type
 *
 * 1. **Create subclass** in `src/TrackFiles/` (e.g., `CTrackFileMyFormat.js`):
 *    ```js
 *    import {CTrackFile} from "./CTrackFile";
 *    import {MISB, MISBFields} from "../MISBFields";
 *
 *    export class CTrackFileMyFormat extends CTrackFile {
 *        static canHandle(filename, data) { ... }
 *        doesContainTrack() { ... }
 *        toMISB(trackIndex = 0) { ... }
 *        getShortName(trackIndex = 0, trackFileName = "") { ... }
 *        hasMoreTracks(trackIndex = 0) { ... }
 *        getTrackCount() { ... }
 *        extractObjects() { ... }  // optional, for non-track features
 *    }
 *    ```
 *
 * 2. **Register in `CFileManager.js`** - Add to the `trackFileClasses` array:
 *    ```js
 *    import {CTrackFileMyFormat} from "./TrackFiles/CTrackFileMyFormat";
 *    const trackFileClasses = [
 *        CTrackFileKML,
 *        CTrackFileSTANAG,
 *        CTrackFileSRT,
 *        CTrackFileJSON,
 *        CTrackFileMISB,
 *        CTrackFileMyFormat,  // Add here
 *    ];
 *    ```
 *    **ORDER MATTERS**: Classes are checked in order. Place more specific handlers before
 *    generic ones. Only one handler should match any given file.
 *
 * 3. **Implement required methods**:
 *    - `static canHandle(filename, data)` - Return true if this class can parse the data.
 *      Must be deterministic and not overlap with other handlers.
 *    - `doesContainTrack()` - Return true if valid track data exists (lat/lon at minimum).
 *    - `toMISB(trackIndex)` - Convert to MISB array format. Return false on failure.
 *      MISB array format: `[[timestamp, lat, lon, alt, ...], ...]` using MISB field indices.
 *    - `getShortName(trackIndex, trackFileName)` - Return display name for the track.
 *    - `hasMoreTracks(trackIndex)` - Return true if more tracks exist after this index.
 *    - `getTrackCount()` - Return total number of tracks in the file.
 *
 * 4. **Multi-track support**: Some files (KML, MISB) contain multiple tracks.
 *    - `getTrackCount()` returns total tracks
 *    - `hasMoreTracks(i)` returns `i < getTrackCount() - 1`
 *    - `toMISB(trackIndex)` extracts specific track by index
 *    - `getShortName(trackIndex)` differentiates track names (e.g., "Track", "Center_Track")
 *
 * See existing subclasses for examples:
 * - `CTrackFileSRT` - Simple single-track (DJI drone SRT)
 * - `CTrackFileMISB` - Multi-track support (primary + center track)
 * - `CTrackFileKML` - Complex multi-track (ADSB-Exchange format)
 */
export class CTrackFile {
    constructor(data) {
        this.data = data;
        // Per-track altitude-units interpretation for ambiguous sources
        // (see hasAmbiguousAltitudeUnits). Keyed by trackIndex.
        this._sourceAltitudeMeters = {};
    }

    static canHandle(filename, data) {
        throw new Error("static canHandle must be implemented by subclass");
    }

    doesContainTrack() {
        throw new Error("doesContainTrack must be implemented by subclass");
    }

    toMISB(trackIndex = 0) {
        throw new Error("toMISB must be implemented by subclass");
    }

    getShortName(trackIndex = 0, trackFileName = "") {
        throw new Error("getShortName must be implemented by subclass");
    }

    hasMoreTracks(trackIndex = 0) {
        throw new Error("hasMoreTracks must be implemented by subclass");
    }

    getTrackCount() {
        throw new Error("getTrackCount must be implemented by subclass");
    }

    // True when the track at `trackIndex` is a "supplementary" reference track that
    // shares a flight/sensor with track 0 — e.g. a MISB FrameCenter target track
    // co-located with its camera. Such tracks should NOT participate in
    // closest-point-of-approach time selection or other primary-track-only behaviour.
    // Default: any non-first track in a multi-track file is treated as supplementary.
    // Subclasses (e.g. CTrackFileKML, where every track is a distinct aircraft)
    // should override.
    isSupplementaryTrack(trackIndex) {
        return trackIndex > 0;
    }

    // True when the altitude column feeding the track at `trackIndex` carries no units
    // label in the source file (e.g. a client-specific CSV column like truth_alt), so
    // feet-vs-meters is a guess. Such tracks get a per-track "Source Altitude is Meters"
    // GUI switch (default off = feet) that re-derives the track via toMISB() from the
    // retained source values. Subclasses override per track; toMISB() implementations
    // for those tracks must consult getSourceAltitudeMeters(trackIndex).
    hasAmbiguousAltitudeUnits(trackIndex) {
        return false;
    }

    // Current units interpretation for an ambiguous-altitude track:
    // false = feet (the default), true = meters.
    getSourceAltitudeMeters(trackIndex) {
        return this._sourceAltitudeMeters[trackIndex] === true;
    }

    setSourceAltitudeMeters(trackIndex, isMeters) {
        this._sourceAltitudeMeters[trackIndex] = isMeters === true;
    }

    // Altitude datum of this track's values. Most sources are orthometric (MSL), which
    // Sitrec's MISB pipeline converts to ellipsoidal height (HAE) by adding the geoid
    // undulation N. Return true only when the altitudes are ALREADY HAE (height above the
    // WGS84 ellipsoid), so the pipeline skips that geoid add. Overridden by CTrackFileSTANAG.
    isAltitudeHAE(trackIndex = 0) {
        return false;
    }

    // Number of INDEPENDENT tracks for the multi-track import selection dialog. Defaults
    // to getTrackCount(), i.e. every track is separately selectable (KML with many
    // aircraft, MISB TrackIDs). Override when several of getTrackCount()'s tracks form one
    // logical import unit that should load together without a picker (e.g. STANAG's
    // Platform/dynamics/Ground sub-tracks, which all derive from one NATO track).
    getImportTrackCount() {
        return this.getTrackCount();
    }

    // Optional camera/target role hint for the track at `trackIndex`, used when the file
    // is loaded directly into a sitch with camera/target track switches. Return "camera",
    // "target", or null. When ANY track of a file declares a role, the role hints replace
    // the default load-order auto-selection for the camera/target switches (see
    // TrackManager.updateDropTargets) — roleless tracks from such a file are still added
    // as switch options but not auto-selected. Overridden by CTrackFileSTANAG, whose LOS
    // endpoints define the sensor (camera) and ground (target) positions.
    trackRoleHint(trackIndex) {
        return null;
    }

    // Rolling-average window, in frames, applied to the platform/sensor angle columns
    // when TrackManager builds this track's "<name> angles" LOS node. Default 120 is
    // a ~4 second window at the 30 fps of a typical MISB video. Override with 0 when
    // the angles are a measurement that must not be pre-filtered, or when the track
    // is shorter than the window — RollingAverage shrinks its window symmetrically at
    // the ends, so averaging 120 frames over a 61-frame track leaves the endpoints
    // untouched while collapsing the middle to the mean of the entire track.
    anglesSmoothing(trackIndex = 0) {
        return 120;
    }

    // True when this track's angles ARE the measurement the file exists to carry,
    // rather than incidental recorded attitude. Such a file must land with its own
    // sightlines selected as the camera heading, even when dropped into an already
    // established sitch (where the default is to add the option without selecting
    // it). Otherwise the heading stays on whatever was already chosen — typically
    // "To Target", which aims the camera at the target track and REPLACES the
    // measured bearings with ones re-derived from the answer.
    anglesAreMeasurement(trackIndex = 0) {
        return false;
    }

    // True when this file's non-target tracks are line-of-sight ENDPOINTS that a
    // already-loaded camera LOS makes redundant — STANAG's posHigh/posLow pair.
    // Only such a file may offer the "load just the tracked target" prompt, whose
    // whole premise is that the other tracks duplicate geometry already present.
    //
    // Default false: for any other multi-track file the extra tracks are not
    // redundant with anything, and dropping them loses real data. A BOT
    // interchange file is the sharp case — its Sensor track carries the measured
    // bearings, so "target track only" would keep the answer and throw away the
    // evidence.
    hasRedundantLOSReferenceTracks() {
        return false;
    }

    // True when the track at trackIndex is a DISTINCT FLIGHT that the
    // closest-point-of-approach heuristic may re-time the sitch to (it sets the start
    // time to when this track and track 0 are nearest).
    //
    // This is NOT the same question as isSupplementaryTrack, though it usually has
    // the same answer. A file can hold several independent primary tracks that are
    // nonetheless not co-observed flights — separate recordings that merely share a
    // coordinate frame — and computing a closest approach between two of those is
    // meaningless. Such a file returns false here while still reporting its tracks as
    // primary, so they stay visible and keep their platform models.
    cpaCandidate(trackIndex) {
        return !this.isSupplementaryTrack(trackIndex);
    }
}
