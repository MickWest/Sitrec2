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

    // Altitude datum of this track's values. Most sources are orthometric (MSL), which
    // Sitrec's MISB pipeline converts to ellipsoidal height (HAE) by adding the geoid
    // undulation N. Return true only when the altitudes are ALREADY HAE (height above the
    // WGS84 ellipsoid), so the pipeline skips that geoid add. Overridden by CTrackFileSTANAG.
    isAltitudeHAE(trackIndex = 0) {
        return false;
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
}
