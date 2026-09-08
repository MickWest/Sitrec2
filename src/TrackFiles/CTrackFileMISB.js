import {CTrackFile} from "./CTrackFile";
import {MISB, MISBFields} from "../MISBFields";

export class CTrackFileMISB extends CTrackFile {
    constructor(data) {
        super(data);
        // Store relative-time metadata from parser for trackStartTime GUI feature
        if (data && data.isRelativeTime) {
            this.isRelativeTime = true;
            this.parsingBaseTime = data.parsingBaseTime;
        }
        this._uniqueTrackIDs = null; // lazy-initialized cache
    }

    anglesSmoothing(trackIndex = 0) {
        // TS metadata is timed to the video. Averaging its attitude moves the
        // reconstructed boresight away from the image it describes, including
        // removing real tracking drift and corrections. Keep filtering opt-in.
        if (Array.isArray(this.data?.pesPTSus) && this.data.pesPTSus.some(Number.isFinite)) return 0;
        return super.anglesSmoothing(trackIndex);
    }

    // Returns array of unique TrackID values found in the data, or null if only one/no TrackID
    _getUniqueTrackIDs() {
        if (this._uniqueTrackIDs !== undefined && this._uniqueTrackIDs !== null) {
            return this._uniqueTrackIDs;
        }
        if (!this.data || this.data.length === 0) {
            this._uniqueTrackIDs = null;
            return null;
        }
        const ids = new Set();
        for (const row of this.data) {
            const id = row[MISB.TrackID];
            if (id !== null && id !== undefined && id !== "") {
                ids.add(id);
            }
        }
        // Only use multi-track splitting if there are 2+ distinct IDs
        if (ids.size >= 2) {
            this._uniqueTrackIDs = Array.from(ids);
        } else {
            this._uniqueTrackIDs = null;
        }
        return this._uniqueTrackIDs;
    }

    _isMultiTrack() {
        return this._getUniqueTrackIDs() !== null;
    }

    static canHandle(filename, data) {
        if (!data || !Array.isArray(data)) {
            return false;
        }
        if (data.length === 0) {
            return false;
        }
        const firstRow = data[0];
        if (!Array.isArray(firstRow)) {
            return false;
        }
        if (firstRow[MISB.UnixTimeStamp] !== undefined && firstRow[MISB.UnixTimeStamp] !== null) {
            return true;
        }
        return false;
    }

    doesContainTrack() {
        if (!this.data || !Array.isArray(this.data)) {
            return false;
        }
        if (this.data.length === 0) {
            return false;
        }
        const firstRow = this.data[0];
        if (!Array.isArray(firstRow)) {
            return false;
        }
        const lat = firstRow[MISB.SensorLatitude];
        const lon = firstRow[MISB.SensorLongitude];
        return lat !== undefined && lat !== null && lon !== undefined && lon !== null;
    }

    _hasCenter() {
        if (!this.data || this.data.length === 0) {
            return false;
        }
        // Like _hasTruth: frame-center cells can be sparse (e.g. an exported
        // clip whose first frames look above the horizon leaves them empty),
        // so scan for the first row with a usable lat/lon pair instead of
        // only checking row 0 (early-exit keeps this cheap).
        for (const row of this.data) {
            const lat = row[MISB.FrameCenterLatitude];
            const lon = row[MISB.FrameCenterLongitude];
            if (lat !== undefined && lat !== null && lon !== undefined && lon !== null) {
                return true;
            }
        }
        return false;
    }

    _hasTruth() {
        if (!this.data || this.data.length === 0) {
            return false;
        }
        // Truth columns are a client-specific extension and may be sparsely
        // populated, so scan for the first row with a usable lat/lon pair
        // rather than only checking row 0 (early-exit keeps this cheap).
        for (const row of this.data) {
            const lat = row[MISB.TruthLatitude];
            const lon = row[MISB.TruthLongitude];
            if (lat !== undefined && lat !== null && lon !== undefined && lon !== null) {
                return true;
            }
        }
        return false;
    }

    _hasTarget() {
        if (!this.data || this.data.length === 0) {
            return false;
        }
        // Target Location (tags 40/41) is reported only while the sensor has a
        // target, so scan for the first usable pair like _hasCenter/_hasTruth.
        for (const row of this.data) {
            const lat = row[MISB.TargetLocationLatitude];
            const lon = row[MISB.TargetLocationLongitude];
            const elev = row[MISB.TargetLocationElevation];
            // Elevation included deliberately: _targetTrackMISB skips a row
            // without it, so testing only lat/lon here could advertise a
            // sub-track that builds to nothing.
            if (lat !== undefined && lat !== null && lon !== undefined && lon !== null
                && elev !== undefined && elev !== null) {
                return true;
            }
        }
        return false;
    }

    // Ordered list of derived supplementary sub-tracks present in a
    // single-TrackID file — track index i+1 maps to entry i, and the entry
    // doubles as the short-name prefix ("Center_...", "Truth_..."). Multi-
    // TrackID files (one aircraft per TrackID) have no derived tracks.
    _derivedTrackTypes() {
        if (this._getUniqueTrackIDs()) return [];
        const types = [];
        if (this._hasCenter()) types.push("Center");
        if (this._hasTruth()) types.push("Truth");
        // Appended, never inserted: trackIndex is this list's position + 1, so
        // putting Target anywhere earlier would renumber the sub-tracks of every
        // file that already has a Center or a Truth.
        if (this._hasTarget()) types.push("Target");
        return types;
    }

    _hasAngles() {
        if (!this.data || this.data.length === 0) {
            return false;
        }
        const firstRow = this.data[0];
        const pitch = firstRow[MISB.PlatformPitchAngle];
        return pitch !== undefined && pitch !== null && !isNaN(Number(pitch));
    }

    _hasFOV() {
        if (!this.data || this.data.length === 0) {
            return false;
        }
        const firstRow = this.data[0];
        const fov = firstRow[MISB.SensorVerticalFieldofView];
        return fov !== undefined && fov !== null && !isNaN(Number(fov));
    }

    toMISB(trackIndex = 0) {
        if (!this.data || !Array.isArray(this.data) || this.data.length === 0) {
            console.warn("CTrackFileMISB.toMISB: No valid data");
            return false;
        }

        const trackCount = this.getTrackCount();
        if (trackIndex < 0 || trackIndex >= trackCount) {
            console.warn(`CTrackFileMISB.toMISB: Invalid track index ${trackIndex}, file has ${trackCount} tracks`);
            return false;
        }

        // Multi-track: filter rows by TrackID
        const uniqueIDs = this._getUniqueTrackIDs();
        if (uniqueIDs) {
            const targetID = uniqueIDs[trackIndex];
            return this.data.filter(row => row[MISB.TrackID] === targetID);
        }

        // Single-track: original behavior
        if (trackIndex === 0) {
            return this.data;
        }

        const type = this._derivedTrackTypes()[trackIndex - 1];
        if (type === "Center") return this._centerTrackMISB();
        if (type === "Truth") return this._truthTrackMISB(trackIndex);
        if (type === "Target") return this._targetTrackMISB();

        return false;
    }

    // truth_alt carries no units label in the source CSV, so the Truth track
    // gets the "Source Altitude is Meters" GUI switch (default off = feet).
    hasAmbiguousAltitudeUnits(trackIndex) {
        return this._derivedTrackTypes()[trackIndex - 1] === "Truth";
    }

    /**
     * The derived Truth sub-track IS the answer key — what the object actually
     * did, per the file's truth_lat/truth_long/truth_alt columns.
     *
     * SAY IT STRUCTURALLY, because the name cannot. TrackManager.isTruthTrack
     * tests a whole name of "truth" or a trailing "(Truth)" — the shapes the
     * BOT importer and the traverse handoff produce — and this file names its
     * derived tracks with a PREFIX, "Truth_<base>", which matches neither. So
     * the truth track fell through to the supplementary branch and was given
     * the small INVISIBLE reference sphere meant for a FrameCenter track: the
     * answer key was imported, listed in the menus, and drawn as nothing at
     * all. That is the same failure a BOT scenario's truth had before it was
     * given the lime icosahedron, arriving by a different route.
     *
     * Distinct from isSupplementaryTrack, which stays true: the truth track
     * genuinely shares a flight with track 0 and must keep out of
     * closest-point-of-approach timing. This answers the narrower question of
     * whether it is the reference the scene is judged against.
     */
    trackIsTruth(trackIndex) {
        return this._derivedTrackTypes()[trackIndex - 1] === "Truth";
    }

    // Build a derived supplementary track by mapping each source row to a
    // new MISB row (or null to skip the row). Forwards the source MISB's
    // pesPTSus (PCR-anchored per-record timing) into the derived track,
    // applying the same index filter we apply to the rows. Without this,
    // hasRecordPTS() returns false on the derived node and sync falls back
    // to UnixTimeStamp — which can drift severely from PES PTS on
    // mis-encoded files.
    _buildDerivedTrack(mapRow, label) {
        const sourcePES = Array.isArray(this.data.pesPTSus) ? this.data.pesPTSus : null;
        const derivedPES = sourcePES ? [] : null;
        const derivedMisb = [];
        for (let i = 0; i < this.data.length; i++) {
            const newRow = mapRow(this.data[i]);
            if (newRow === null) continue;
            derivedMisb.push(newRow);
            if (derivedPES) derivedPES.push(sourcePES[i]);
        }
        if (derivedMisb.length === 0) {
            console.warn(`CTrackFileMISB.toMISB: No valid ${label} track points`);
            return false;
        }
        if (derivedPES) derivedMisb.pesPTSus = derivedPES;
        return derivedMisb;
    }

    _centerTrackMISB() {
        return this._buildDerivedTrack((row) => {
            const centerLat = row[MISB.FrameCenterLatitude];
            const centerLon = row[MISB.FrameCenterLongitude];
            const centerElev = row[MISB.FrameCenterElevation];               // tag 25, MSL
            const centerHAE = row[MISB.FrameCenterHeightAboveEllipsoid];     // tag 78, HAE
            if (centerLat === null || centerLat === undefined ||
                centerLon === null || centerLon === undefined) {
                return null;
            }
            const newRow = new Array(MISBFields).fill(null);
            newRow[MISB.UnixTimeStamp] = row[MISB.UnixTimeStamp];
            newRow[MISB.SensorLatitude] = centerLat;
            newRow[MISB.SensorLongitude] = centerLon;
            // Prefer Frame Center Elevation (tag 25, MSL). If it's absent but Frame
            // Center Height Above Ellipsoid (tag 78) is present, keep the HAE value —
            // write it into the ellipsoid-height column so the data track's
            // datum-aware column selection flags it HAE instead of adding the geoid
            // offset to a value that is already ellipsoidal. Only fall back to 0 when
            // neither is available.
            if (centerElev !== null && centerElev !== undefined) {
                newRow[MISB.SensorTrueAltitude] = centerElev;
            } else if (centerHAE !== null && centerHAE !== undefined) {
                newRow[MISB.SensorEllipsoidHeight] = centerHAE;
            } else {
                newRow[MISB.SensorTrueAltitude] = 0;
            }
            return newRow;
        }, "center");
    }

    // Client-specific ground-truth track (truth_lat / truth_long / truth_alt
    // CSV columns). truth_alt carries no units label in the source CSV —
    // observed client data is in feet, so feet is the default interpretation;
    // the per-track "Source Altitude is Meters" GUI switch flips it and
    // re-derives this track from the retained source rows. The (converted-
    // to-meters, MSL) value goes in SensorTrueAltitude and gets the standard
    // geoid handling downstream. truth_heading and truth_speed are parsed
    // into the source rows but not used here yet.
    _truthTrackMISB(trackIndex) {
        const altScale = this.getSourceAltitudeMeters(trackIndex) ? 1 : 0.3048; // ft → m
        return this._buildDerivedTrack((row) => {
            const lat = row[MISB.TruthLatitude];
            const lon = row[MISB.TruthLongitude];
            const alt = row[MISB.TruthAltitude];
            if (lat === null || lat === undefined ||
                lon === null || lon === undefined) {
                return null;
            }
            const newRow = new Array(MISBFields).fill(null);
            newRow[MISB.UnixTimeStamp] = row[MISB.UnixTimeStamp];
            newRow[MISB.SensorLatitude] = lat;
            newRow[MISB.SensorLongitude] = lon;
            newRow[MISB.SensorTrueAltitude] = (alt !== null && alt !== undefined) ? alt * altScale : 0;
            return newRow;
        }, "truth");
    }

    // ST 0601 Target Location (tags 40/41/42) — where the sensor says the
    // tracked object is, as opposed to tag 23/24/25's boresight-on-ground frame
    // centre. Elevation is MSL by the standard, so it takes the same geoid
    // handling downstream as FrameCenterElevation.
    //
    // Deliberately NOT reported by trackIsTruth: on a real capture this is the
    // platform's ESTIMATE, and flagging it as the answer key would put the lime
    // truth marker on a measurement. On the synthetic BotBench clips it happens
    // to be exact, which is a property of those files, not of the tag.
    _targetTrackMISB() {
        return this._buildDerivedTrack((row) => {
            const lat = row[MISB.TargetLocationLatitude];
            const lon = row[MISB.TargetLocationLongitude];
            const elev = row[MISB.TargetLocationElevation];
            // Elevation is required, unlike the Center track's 0 m fallback. A
            // frame centre is on the ground, so 0 m is a poor-but-bounded guess
            // there; a target can be anywhere in the air, and dropping a balloon
            // at 4.6 km to sea level is a materially false position that looks
            // like real data. A row without tag 42 is skipped instead.
            if (lat === null || lat === undefined ||
                lon === null || lon === undefined ||
                elev === null || elev === undefined) {
                return null;
            }
            const newRow = new Array(MISBFields).fill(null);
            newRow[MISB.UnixTimeStamp] = row[MISB.UnixTimeStamp];
            newRow[MISB.SensorLatitude] = lat;
            newRow[MISB.SensorLongitude] = lon;
            newRow[MISB.SensorTrueAltitude] = elev;
            return newRow;
        }, "target");
    }

    // The Target sub-track is an object in the air, so it is drawn, unlike the
    // Center track's ground reference point.
    //
    // This is display only, and that is the whole point. Declaring the target
    // through trackRoleHint instead switched TrackManager into role-based
    // auto-selection for the entire file, and the roleless sensor track then
    // selected into no switch at all: cameraTrackSwitch stayed on fixedCamera
    // while targetTrackSwitch held the imported target, so the view never
    // followed the sensor. Measured on a clean custom-sitch import.
    //
    // The track is still NOT ground truth — on a real capture tags 40/41/42 are
    // the platform's own estimate, so trackIsTruth/isGroundTruthTrack stay false
    // and it gets an ordinary marker, not the answer-key one.
    supplementaryTrackIsObject(trackIndex) {
        if (this._derivedTrackTypes()[trackIndex - 1] === "Target") return true;
        return super.supplementaryTrackIsObject(trackIndex);
    }

    getShortName(trackIndex = 0, trackFileName = "") {
        // Multi-track: use the tail number from the first row of the specific track,
        // falling back to the TrackID
        const uniqueIDs = this._getUniqueTrackIDs();
        if (uniqueIDs) {
            const targetID = uniqueIDs[trackIndex];
            // Find the first row for this track and try to get its tail number
            const firstRow = this.data.find(row => row[MISB.TrackID] === targetID);
            if (firstRow) {
                const tailNumber = firstRow[MISB.PlatformTailNumber];
                if (tailNumber !== null && tailNumber !== undefined && tailNumber !== "") {
                    return tailNumber;
                }
            }
            // Fall back to the TrackID itself
            return targetID;
        }

        // Single-track: original behavior
        let baseName = "";
        if (this.data && this.data.length > 0) {
            const tailNumber = this.data[0][MISB.PlatformTailNumber];
            if (tailNumber !== null && tailNumber !== undefined && tailNumber !== "") {
                baseName = tailNumber;
            }
        }
        if (!baseName && trackFileName) {
            baseName = trackFileName.replace(/\.[^/.]+$/, "");
        }
        if (!baseName) {
            baseName = "MISB Track";
        }
        // Derived supplementary tracks are prefixed by type, e.g.
        // "Center_N12345", "Truth_N12345" (trackIndex 0 maps to undefined here)
        const type = this._derivedTrackTypes()[trackIndex - 1];
        if (type) {
            return type + "_" + baseName;
        }
        return baseName;
    }

    hasMoreTracks(trackIndex = 0) {
        return trackIndex < this.getTrackCount() - 1;
    }

    getTrackCount() {
        const uniqueIDs = this._getUniqueTrackIDs();
        if (uniqueIDs) {
            return uniqueIDs.length;
        }
        return 1 + this._derivedTrackTypes().length;
    }

    // The derived Center/Truth sub-tracks are supplementary views of the same
    // platform's data and always load together with the primary track — they
    // must not trigger the multi-track selection dialog (which gates on 3+
    // independently-selectable tracks). Multi-TrackID files are genuinely
    // independent aircraft, so each remains selectable.
    getImportTrackCount() {
        const uniqueIDs = this._getUniqueTrackIDs();
        if (uniqueIDs) {
            return uniqueIDs.length;
        }
        return 1;
    }

    // Multi-TrackID files (e.g. ASTERIX CAT-048 PCAPs) carry one aircraft
    // per TrackID — none of them is "supplementary" to another. Only a
    // single-aircraft file with a co-located FrameCenter track has a
    // supplementary index-1 entry (which keeps the default behaviour).
    isSupplementaryTrack(trackIndex) {
        if (this._getUniqueTrackIDs()) return false;
        return super.isSupplementaryTrack(trackIndex);
    }

    // A parser can mark the misb array's SensorTrueAltitude values as already-HAE
    // (e.g. Custom1's TPHAE column — Height Above Ellipsoid). The flag describes the
    // Sensor* altitude column, so it applies to every TrackID sub-track, but NOT to a
    // derived Center or Truth track (index ≥ 1), whose altitude comes from
    // FrameCenterElevation / truth_alt (MSL by convention).
    isAltitudeHAE(trackIndex = 0) {
        if (!this.data || !this.data.altitudeIsHAE) return false;
        if (this._getUniqueTrackIDs()) return true;
        return trackIndex === 0;
    }

    extractObjects() {
    }
}
