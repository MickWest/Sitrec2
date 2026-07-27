/*
    STANAG 4676 Track File Parser (XML container)

    Container-specific parsing only: <tp> nodes -> the normalised
    {time, target, platform, ground} points consumed by CTrackFileSTANAGBase, which owns
    the shared STANAG semantics (track enumeration, de-duplication, MISB conversion,
    naming, camera/target role hints). The CSV flavour of the same data is
    CTrackFileSTANAGCSV.
 */

import {CTrackFileSTANAGBase, parseSTANAGPositionString} from "./CTrackFileSTANAGBase";
import {timeStrToEpoch} from "../DateTimeUtils";

export class CTrackFileSTANAG extends CTrackFileSTANAGBase {
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

    // Structural check (a well-formed message with a track element) AND the base's
    // requirement that the file actually yields a track. The structural half short-circuits
    // so malformed data is rejected without attempting a parse; the base half keeps the
    // contract that doesContainTrack() agrees with getTrackCount() > 0, so a <track>
    // holding no usable <tp> positions is not imported as an empty track.
    doesContainTrack() {
        if (!this.data || typeof this.data !== 'object') {
            return false;
        }

        try {
            if (!this.data.nitsRoot?.message?.track) {
                return false;
            }
        } catch (e) {
            return false;
        }

        return super.doesContainTrack();
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

    // Point times come from the message baseTime plus each <tp>'s relTime, scaled by
    // <relTimeIncrement> (seconds per relTime unit — typically 1e-6, i.e. microseconds).
    _stanagPoints() {
        if (!this.data || typeof this.data !== 'object') {
            console.warn("STANAG: No valid STANAG data");
            return [];
        }

        try {
            const message = this.data.nitsRoot?.message;
            if (!message || !message.baseTime || !message.track) {
                console.warn("STANAG: Invalid STANAG XML structure");
                return [];
            }

            const baseTime = timeStrToEpoch(message.baseTime["#text"]);
            const relTimeIncrement = message.relTimeIncrement?.["#text"] ? Number(message.relTimeIncrement["#text"]) : 0;

            return this._getTpArray().map((tp, i) => {
                const relTime = tp.relTime?.["#text"] ? Number(tp.relTime["#text"]) : 0;
                return {
                    time: baseTime + (relTime * relTimeIncrement * 1000),
                    target: parseSTANAGPositionString(tp.dynamics?.pos?.["#text"], `dynamics/pos at track point ${i}`),
                    platform: parseSTANAGPositionString(tp.posHigh, `posHigh at track point ${i}`),
                    ground: parseSTANAGPositionString(tp.posLow, `posLow at track point ${i}`),
                };
            });
        } catch (e) {
            console.warn("STANAG: Error parsing STANAG data: " + e.message);
            return [];
        }
    }

    // The import picker gates on independent NATO tracks (numTracks), not the 2-3 derived
    // sub-tracks. The current parser handles a single <track>, so numTracks is effectively
    // 1 and the multi-track picker never fires for a lone STANAG track.
    getImportTrackCount() {
        const n = Number(this.data?.nitsRoot?.message?.numTracks);
        return Number.isFinite(n) && n >= 1 ? n : 1;
    }

    // The <dynamics cs="..."> attribute names the coordinate system; "WGS_84" (the observed
    // value, and the 4676 default) is ellipsoidal, so heights are HAE and the MISB pipeline
    // must skip the MSL->HAE geoid add. posLow/posHigh carry no cs but are WGS-84
    // ellipsoidal too, so the datum applies to every track in the file.
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
}
