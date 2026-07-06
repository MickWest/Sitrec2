/*
    STANAG 4676 Track File Parser
 */

import {CTrackFile} from "./CTrackFile";
import {MISB, MISBFields} from "../MISBFields";
import {timeStrToEpoch} from "../DateTimeUtils";

export class CTrackFileSTANAG extends CTrackFile {
    static canHandle(filename, data) {
        if (!data || typeof data !== 'object') {
            return false;
        }
        try {
            return !!(data.nitsRoot?.message?.track);
        } catch (e) {
            return false;
        }
    }

    doesContainTrack() {
        if (!this.data || typeof this.data !== 'object') {
            return false;
        }

        try {
            if (this.data.nitsRoot?.message?.track) {
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    // Return the array of track-point (<tp>) nodes, normalising the single-vs-array case.
    _getTpArray() {
        try {
            const trackPoints = this.data?.nitsRoot?.message?.track?.segment?.tp;
            if (!trackPoints) return [];
            return Array.isArray(trackPoints) ? trackPoints : [trackPoints];
        } catch (e) {
            return [];
        }
    }

    _hasPosLowHigh() {
        const tpArray = this._getTpArray();
        return tpArray.some(tp => tp.posLow || tp.posHigh);
    }

    // A GXP-InMotion STANAG track point can carry up to three positions:
    //   dynamics/pos  - the standard's authoritative position estimate  -> plain name (PRIMARY)
    //   posHigh       - high-altitude end of the sensor line-of-sight ray -> "(LOS High)"
    //   posLow        - low-altitude / ground end of the LOS ray          -> "(Ground)"
    //
    // Only dynamics/pos is actually part of STANAG 4676: the spec defines it as "the
    // centroid position of the track point, as estimated by the data producer" and its
    // single authoritative position. posLow/posHigh/posImage are BAE/GXP proprietary
    // <tp> attributes (absent from both the Edition A and Edition B standard track-point
    // models). We infer -- from the fact that posLow, dynamics/pos and posHigh are exactly
    // collinear per track point, and posLow's altitude matches local terrain -- that
    // posLow/posHigh are the ground and high-altitude endpoints of the sensor LOS ray
    // through the tracked pixel (posImage), bracketing the target's unknown altitude, with
    // dynamics/pos the producer's chosen estimate on that ray. posHigh is therefore an LOS
    // endpoint, NOT the platform/sensor position -- hence "(LOS High)", not "(Platform)".
    //
    // dynamics/pos is listed FIRST so it becomes track 0: the primary (non-supplementary)
    // track that drives smoothing, time-sync and CPA. The posHigh/posLow LOS endpoints are
    // supplementary reference geometry (base-class isSupplementaryTrack -> index > 0).
    //
    // When the tracker ground-locks the target, dynamics/pos comes out IDENTICAL to posLow
    // (or, rarely, posHigh), so emitting all three would produce duplicate tracks. This
    // returns only the DISTINCT position sources, in priority order, dropping any candidate
    // whose full position sequence duplicates one already kept (first occurrence wins, so
    // the authoritative dynamics/pos survives over a coincident endpoint). The result is
    // memoised (the parsed data never changes).
    _distinctTracks() {
        if (this._distinctTracksCache) return this._distinctTracksCache;

        const candidates = this._hasPosLowHigh()
            ? [
                {get: tp => tp.dynamics?.pos?.["#text"], suffix: ""},
                {get: tp => tp.posHigh,                  suffix: " (LOS High)"},
                {get: tp => tp.posLow,                   suffix: " (Ground)"},
              ]
            : [
                {get: tp => tp.dynamics?.pos?.["#text"], suffix: ""},
              ];

        const tpArray = this._getTpArray();
        const kept = [];
        for (const cand of candidates) {
            // Numeric [lat, lon, alt] per track point (null where this candidate has no position).
            const seq = tpArray.map(tp => {
                const s = cand.get(tp);
                if (!s) return null;
                const c = s.trim().split(/\s+/).map(Number);
                return c.length >= 3 ? [c[0], c[1], c[2]] : null;
            });
            // Skip a candidate with no usable positions at all.
            if (!seq.some(p => p !== null)) continue;
            // Skip a candidate that duplicates one we already kept.
            if (kept.some(k => this._sameSequence(k._seq, seq))) continue;
            cand._seq = seq;
            kept.push(cand);
        }

        this._distinctTracksCache = kept;
        return kept;
    }

    // True if two position sequences are point-for-point equal within a tight tolerance.
    // Distinct STANAG tracks differ by hundreds of metres, so a ~1 cm tolerance only ever
    // collapses genuine duplicates (e.g. a ground-locked dynamics/pos vs posLow), never
    // two real tracks; it also absorbs trailing-digit formatting differences.
    _sameSequence(a, b) {
        if (a.length !== b.length) return false;
        const EPS_DEG = 1e-7; // ~1 cm in latitude/longitude
        const EPS_ALT = 1e-2; // 1 cm in altitude (metres)
        for (let i = 0; i < a.length; i++) {
            const p = a[i], q = b[i];
            if ((p === null) !== (q === null)) return false;
            if (p === null) continue;
            if (Math.abs(p[0] - q[0]) > EPS_DEG) return false;
            if (Math.abs(p[1] - q[1]) > EPS_DEG) return false;
            if (Math.abs(p[2] - q[2]) > EPS_ALT) return false;
        }
        return true;
    }

    toMISB(trackIndex = 0) {
        const distinct = this._distinctTracks();
        if (trackIndex < 0 || trackIndex >= distinct.length) {
            console.warn("STANAGToMISB: Invalid track index " + trackIndex + ", file has " + distinct.length + " tracks");
            return false;
        }

        if (!this.data || typeof this.data !== 'object') {
            console.warn("STANAGToMISB: No valid STANAG data");
            return false;
        }

        try {
            if (!this.doesContainTrack()) {
                console.warn("STANAGToMISB: No track in STANAG file");
                return false;
            }

            const message = this.data.nitsRoot?.message;
            if (!message || !message.baseTime || !message.track) {
                console.warn("STANAGToMISB: Invalid STANAG XML structure");
                return false;
            }

            const baseTime = timeStrToEpoch(message.baseTime["#text"]);
            const relTimeIncrement = message.relTimeIncrement?.["#text"] ? Number(message.relTimeIncrement["#text"]) : 0;
            const tpArray = this._getTpArray();

            if (tpArray.length === 0) {
                console.warn("STANAGToMISB: No track points found");
                return false;
            }

            const getPos = distinct[trackIndex].get;
            const misb = [];

            for (let i = 0; i < tpArray.length; i++) {
                const tp = tpArray[i];
                const relTime = tp.relTime?.["#text"] ? Number(tp.relTime["#text"]) : 0;

                const posStr = getPos(tp);
                if (!posStr) {
                    continue;
                }

                const coords = posStr.trim().split(/\s+/);
                if (coords.length < 3) {
                    console.warn("STANAGToMISB: Track point " + i + " has invalid position format");
                    continue;
                }

                const lat = Number(coords[0]);
                const lon = Number(coords[1]);
                const alt = Number(coords[2]);

                const time = baseTime + (relTime * relTimeIncrement * 1000);

                misb[misb.length] = new Array(MISBFields);
                misb[misb.length - 1][MISB.UnixTimeStamp] = time;
                misb[misb.length - 1][MISB.SensorLatitude] = lat;
                misb[misb.length - 1][MISB.SensorLongitude] = lon;
                misb[misb.length - 1][MISB.SensorTrueAltitude] = alt;
            }

            if (misb.length === 0) {
                console.warn("STANAGToMISB: No valid track points found for track index " + trackIndex);
                return false;
            }

            return misb;
        } catch (e) {
            console.warn("STANAGToMISB: Error parsing STANAG data: " + e.message);
            return false;
        }
    }

    getShortName(trackIndex = 0, trackFileName = "") {
        const baseName = trackFileName ? trackFileName.replace(/\.[^/.]+$/, "") : "STANAG Track";
        const distinct = this._distinctTracks();
        const suffix = distinct[trackIndex]?.suffix ?? "";
        return baseName + suffix;
    }

    hasMoreTracks(trackIndex = 0) {
        return trackIndex < this.getTrackCount() - 1;
    }

    getTrackCount() {
        return this._distinctTracks().length;
    }

    // STANAG 4676 positions are WGS-84 geodetic, so their heights are height-above-
    // ellipsoid (HAE), not MSL. The <dynamics cs="..."> attribute names the coordinate
    // system; "WGS_84" (the observed value, and the 4676 default) is ellipsoidal. Returning
    // true tells the MISB pipeline NOT to re-add the geoid offset (which would sink the
    // track by the geoid undulation N -- ~19 m in Colorado). posLow/posHigh carry no cs but
    // are WGS-84 ellipsoidal too, so the datum applies to every track in the file
    // (trackIndex is accepted for the CTrackFile API but the datum is file-wide).
    // Matching is by substring heuristic to tolerate producer variants: orthometric
    // indicators (EGM/MSL/orthometric/NAVD) win over ellipsoidal ones (WGS/ellipsoid/HAE)
    // so a hybrid label like "WGS84_EGM96" reads as orthometric; unknown or absent
    // defaults to ellipsoidal per the 4676 geodetic convention.
    isAltitudeHAE(trackIndex = 0) {
        for (const tp of this._getTpArray()) {
            const cs = tp.dynamics?.cs;
            if (cs) {
                const s = cs.trim().toLowerCase();
                if (/egm|msl|orthometric|navd/.test(s)) return false;
                if (/wgs|ellipsoid|hae/.test(s)) return true;
                return true; // unrecognised cs: assume the 4676 default (ellipsoidal)
            }
        }
        // No cs attribute present: STANAG 4676 heights are ellipsoidal by default.
        return true;
    }

    extractObjects() {
    }
}
