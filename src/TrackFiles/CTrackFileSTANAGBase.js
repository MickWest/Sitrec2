/*
    Shared STANAG 4676 track semantics.

    A STANAG 4676 track point carries up to three positions:

      target   - the standard's authoritative estimate of the tracked object
                 (XML: dynamics/pos, CSV: TPLAT/TPLON/TPHAE)        -> "(Target)"
      platform - the high / sensor end of the sensor line-of-sight ray
                 (XML: posHigh,      CSV: SLAT/SLON/SHAE)           -> "(Platform)"
      ground   - the low / ground end of that ray
                 (XML: posLow,       CSV: GLAT/GLON/HAE)            -> "(Ground)"

    Only `target` is actually part of STANAG 4676: the spec defines it as "the centroid
    position of the track point, as estimated by the data producer" and its single
    authoritative position. The platform/ground endpoints are BAE/GXP proprietary extras
    (absent from both the Edition A and Edition B standard track-point models). We infer --
    from the fact that the three are exactly collinear per track point -- that they lie on
    the sensor's line of sight through the tracked pixel: `ground` is the ray's ground
    intersection (its altitude matches local terrain), and `platform` is the sensor PLATFORM
    (its altitude varies per frame like a real aircraft track and its lat/lon trace a smooth
    flight path), with `target` the producer's chosen estimate on that ray.

    All of that is independent of the container. Subclasses supply only the parsed points via
    _stanagPoints(); everything below (track enumeration, de-duplication, MISB conversion,
    naming, camera/target role hints) is shared, so an XML file and its CSV equivalent load
    identically.
 */

import {CTrackFile} from "./CTrackFile";
import {MISB, MISBFields} from "../MISBFields";

// The three position sources, in load priority order.
//
// `target` is listed FIRST so it becomes track 0: the primary (non-supplementary) track
// that drives smoothing, time-sync and CPA. The platform/ground LOS endpoints are
// supplementary reference geometry (base-class isSupplementaryTrack -> index > 0).
//
// suffix = display label; role = which track switch this sub-track auto-selects into on a
// direct load. `target` is the tracked object itself -> the target track. `platform` is the
// high end of the sensor line of sight; its altitude varies per frame like a real aircraft
// track, so it is the sensor PLATFORM -> camera. `ground` is the LOS ground intersection
// (a reference point); it keeps the "(Ground)" label but no switch role. The three are
// collinear, so the camera (Platform) points identically whether it aims at the target or
// the ground point.
export const STANAG_POSITION_SOURCES = [
    {key: "target",   suffix: " (Target)",   role: "target"},
    {key: "platform", suffix: " (Platform)", role: "camera"},
    {key: "ground",   suffix: " (Ground)",   role: null},
];

// Parse a "lat lon alt" whitespace-separated triple (the STANAG XML position encoding)
// into [lat, lon, alt], or null if absent/malformed. Non-finite components are rejected
// rather than passed through as NaN, which would break the track downstream.
export function parseSTANAGPositionString(s, context = "") {
    if (s === null || s === undefined) return null;
    const trimmed = String(s).trim();
    if (trimmed === "") return null;
    const c = trimmed.split(/\s+/).map(Number);
    if (c.length < 3 || !Number.isFinite(c[0]) || !Number.isFinite(c[1]) || !Number.isFinite(c[2])) {
        console.warn("STANAG: invalid position format " + (context ? context + " " : "") + '"' + trimmed + '"');
        return null;
    }
    return [c[0], c[1], c[2]];
}

export class CTrackFileSTANAGBase extends CTrackFile {

    /**
     * Subclass hook: return the file's track points as a normalised array of
     *   {time, target, platform, ground}
     * where `time` is epoch milliseconds and each position is [lat, lon, alt] (degrees,
     * degrees, metres) or null when that source has no position at this point.
     * Return [] when the data holds no usable track.
     */
    _stanagPoints() {
        throw new Error("_stanagPoints must be implemented by subclass");
    }

    // Memoised _stanagPoints() -- the parsed source data never changes.
    _points() {
        if (!this._pointsCache) {
            this._pointsCache = this._stanagPoints() || [];
        }
        return this._pointsCache;
    }

    doesContainTrack() {
        return this._points().length > 0;
    }

    _hasPlatformOrGround() {
        return this._points().some(p => p.platform || p.ground);
    }

    // The DISTINCT position sources of this file, in priority order.
    //
    // When the tracker ground-locks the target, `target` comes out IDENTICAL to `ground`
    // (or, rarely, `platform`), so emitting all three would produce duplicate tracks. Any
    // candidate whose full position sequence duplicates one already kept is dropped (first
    // occurrence wins, so the authoritative `target` survives over a coincident endpoint),
    // but its role transfers to the surviving twin. A bare target-only file (no LOS
    // endpoints) has nothing to distinguish, so it stays the plain primary track with no
    // suffix and no role. Memoised.
    _distinctTracks() {
        if (this._distinctTracksCache) return this._distinctTracksCache;

        const candidates = this._hasPlatformOrGround()
            ? STANAG_POSITION_SOURCES.map(s => ({...s}))
            : [{key: "target", suffix: "", role: null}];

        const points = this._points();
        const kept = [];
        for (const cand of candidates) {
            // Numeric [lat, lon, alt] per track point (null where this candidate has no position).
            const seq = points.map(p => p[cand.key] ?? null);
            // Skip a candidate with no usable positions at all.
            if (!seq.some(p => p !== null)) continue;
            // Skip a candidate that duplicates one we already kept — but transfer its role
            // to the kept twin, so e.g. a ground-locked file (target == ground) keeps the
            // plain target track AND it inherits the "target" role.
            const dup = kept.find(k => this._sameSequence(k._seq, seq));
            if (dup) {
                if (!dup.role && cand.role) dup.role = cand.role;
                continue;
            }
            cand._seq = seq;
            kept.push(cand);
        }

        this._distinctTracksCache = kept;
        return kept;
    }

    // True if two position sequences are point-for-point equal within a tight tolerance.
    // Distinct STANAG tracks differ by hundreds of metres, so a ~1 cm tolerance only ever
    // collapses genuine duplicates (e.g. a ground-locked target vs ground), never two real
    // tracks; it also absorbs trailing-digit formatting differences.
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

        if (!this.doesContainTrack()) {
            console.warn("STANAGToMISB: No track points found");
            return false;
        }

        const points = this._points();
        const seq = distinct[trackIndex]._seq;
        const misb = [];

        for (let i = 0; i < points.length; i++) {
            const pos = seq[i];
            if (!pos) continue;

            const row = new Array(MISBFields);
            row[MISB.UnixTimeStamp] = points[i].time;
            row[MISB.SensorLatitude] = pos[0];
            row[MISB.SensorLongitude] = pos[1];
            row[MISB.SensorTrueAltitude] = pos[2];
            misb.push(row);
        }

        if (misb.length === 0) {
            console.warn("STANAGToMISB: No valid track points found for track index " + trackIndex);
            return false;
        }

        return misb;
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

    // For the import dialog, a STANAG file counts as its NATO track count, NOT the 2-3
    // derived Target/Platform/Ground sub-tracks, which all belong to one track and always
    // load together. One logical track by default (so the multi-track picker never fires
    // for a lone STANAG track, whereas getTrackCount()'s 3 would otherwise trigger it);
    // the XML subclass overrides this with the message's numTracks attribute.
    getImportTrackCount() {
        return 1;
    }

    // Camera/target auto-selection for direct loads: `target` is the tracked object ->
    // target track; `platform` is the sensor end of the line of sight -> camera track.
    // `ground` is an unroled reference point.
    trackRoleHint(trackIndex) {
        return this._distinctTracks()[trackIndex]?.role ?? null;
    }

    // STANAG 4676 positions are WGS-84 geodetic, so their heights are height-above-
    // ellipsoid (HAE), not MSL. Returning true tells the MISB pipeline NOT to re-add the
    // geoid offset (which would sink the track by the geoid undulation N -- ~19 m in
    // Colorado). The XML subclass refines this from the <dynamics cs="..."> attribute;
    // the datum is file-wide, so trackIndex is accepted only for the CTrackFile API.
    isAltitudeHAE(trackIndex = 0) {
        return true;
    }

    extractObjects() {
    }
}
