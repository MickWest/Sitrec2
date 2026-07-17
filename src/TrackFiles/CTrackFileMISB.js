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

    // Ordered list of derived supplementary sub-tracks present in a
    // single-TrackID file — track index i+1 maps to entry i, and the entry
    // doubles as the short-name prefix ("Center_...", "Truth_..."). Multi-
    // TrackID files (one aircraft per TrackID) have no derived tracks.
    _derivedTrackTypes() {
        if (this._getUniqueTrackIDs()) return [];
        const types = [];
        if (this._hasCenter()) types.push("Center");
        if (this._hasTruth()) types.push("Truth");
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

        return false;
    }

    // truth_alt carries no units label in the source CSV, so the Truth track
    // gets the "Source Altitude is Meters" GUI switch (default off = feet).
    hasAmbiguousAltitudeUnits(trackIndex) {
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
