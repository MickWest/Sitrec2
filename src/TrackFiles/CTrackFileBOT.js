/*
    BOT interchange CSV (bearings-only tracking benchmark) — see
    benchmarks/botbench/BOT-Interchange-Format.html for the format itself.

    Three file shapes share one schema, and any of them can be dropped in:

      Input  TrackID,TrackSource,Time,SensorPositionX/Y/Z,LOSUnitVectorX/Y/Z,
             MaxRange,LOSUncertainty
      Truth  TrackID,Time,TruePositionX/Y/Z
      All    the input columns followed by the truth columns

    What you get, depending on which columns are present:

      SensorPosition + LOSUnitVector  ->  a sensor track (role: camera) whose MISB
                                          rows carry the sightline as sensor
                                          azimuth/elevation, so TrackManager builds
                                          the "<name> angles" LOS automatically
      TruePosition                    ->  a truth track (role: target)

    So an Input file gives sensor + angles, a Truth file gives the answer track, and
    an All file gives all three at once.

    NO GEOREFERENCE IN THE FILE
    ---------------------------
    The CSV carries metres in a local ENU frame and nothing else; the origin,
    datum and epoch live in the scenario.json sidecar the format also defines. This
    importer deliberately does NOT require that sidecar — it applies BOT_DEFAULT_ORIGIN
    and BOT_DEFAULT_EPOCH_ISO below, which are the site and epoch the shipped
    benchmark set is actually generated at, so the shipped files land in the right
    place with the right geometry. A file generated at some other site will import
    with correct SHAPE at the wrong place on the globe.

    FLAT PLANE vs ROUND EARTH
    -------------------------
    BOT scenarios are generated on a FLAT plane: the spec's rule is
    "altitude = Z + groundElevationMSL" at any horizontal distance. Sitrec's world is
    the WGS84 ellipsoid. We honour the spec's rule — Z is read as altitude directly,
    and only the horizontal offset is used to derive lat/lon — so altitudes match the
    generator exactly. The cost is that a straight line in the source data bends
    slightly here: the two interpretations differ by the curvature term (X²+Y²)/2R,
    about 2 m at 5 km, 31 m at 20 km and 196 m at 50 km. Sightline directions are
    unaffected, because they come from the LOS column rather than from differencing
    the positions.
 */

import {CTrackFile} from "./CTrackFile";
import {MISB, MISBFields} from "../MISBFields";
import {findColumn} from "../ParseUtils";
import {Vector3} from "three";
import {ECEF2ENU_radii, ECEFToLLA_radii, ENU2ECEF_radii} from "../LLA-ECEF-ENU";

const DEG = Math.PI / 180;

// The DEFAULT_SITE of benchmarks/botbench/lib/generateScenario.js, which every
// scenario in the shipped interchange release uses. It must track that table:
// a file whose sidecar is missing lands here, and a mismatch would import the
// shipped set with correct shape at the wrong place on the globe.
//
// It used to be an over-water site at 35, -125. That was fine for the geometry
// and useless for looking at: a scene opened there has no terrain to judge a
// track against and no imagery to judge scale by.
// groundElevationMSL is MEAN SEA LEVEL: the flat-plane rule adds it to Z, and
// the altitude this importer produces is therefore MSL. The same point is
// -4.9 m on the WGS84 ellipsoid (geoid separation -32.5 m) — worth knowing
// because anything converting these altitudes to HAE has to apply that, and a
// conversion that skips it lands tens of metres out.
export const BOT_DEFAULT_ORIGIN = {
    latDeg: 37.244358, lonDeg: -120.738187, groundElevationMSL: 27.6,
};

// The daytime epoch the shipped set is generated at. A few cells (the celestial
// ones) are generated at a night epoch instead, which only scenario.json records —
// without it there is no way to tell them apart, and a daytime default at least
// makes the geometry visible.
export const BOT_DEFAULT_EPOCH_ISO = "2025-02-01T20:00:00Z";

// Exact-but-case-insensitive header names (findColumn trims and lowercases).
// Unknown extra columns are ignored, so a producer's additional metadata does not
// affect detection or parsing.
const BOT_COLUMNS = {
    trackId:        ["TrackID"],
    trackSource:    ["TrackSource"],
    time:           ["Time"],
    sensorX:        ["SensorPositionX"],
    sensorY:        ["SensorPositionY"],
    sensorZ:        ["SensorPositionZ"],
    losX:           ["LOSUnitVectorX"],
    losY:           ["LOSUnitVectorY"],
    losZ:           ["LOSUnitVectorZ"],
    maxRange:       ["MaxRange"],
    losUncertainty: ["LOSUncertainty"],
    truthX:         ["TruePositionX"],
    truthY:         ["TruePositionY"],
    truthZ:         ["TruePositionZ"],
};

/**
 * True if these CSV rows are a BOT interchange file of any of the three shapes.
 *
 * Requires the TrackID/Time key plus at least one complete data family. The column
 * names are distinctive enough (no other Sitrec CSV has SensorPositionX or
 * TruePositionX) that this cannot collide with the other detectors — in
 * particular a BOT file carries no lat/lon/MGRS column, so it could never have
 * reached isCustom1() anyway.
 */
export function isBOTCSV(csv) {
    if (!Array.isArray(csv) || csv.length < 2 || !Array.isArray(csv[0])) return false;

    const has = (names) => findColumn(csv, names, true) !== -1;
    const C = BOT_COLUMNS;

    if (!has(C.trackId) || !has(C.time)) return false;

    const hasSensor = has(C.sensorX) && has(C.sensorY) && has(C.sensorZ);
    const hasLOS = has(C.losX) && has(C.losY) && has(C.losZ);
    const hasTruth = has(C.truthX) && has(C.truthY) && has(C.truthZ);

    // A sensor family without its sightlines is a position track we could import,
    // but it is not a BOT challenge file — the whole point of the format is the
    // bearings. Requiring both keeps the claim narrow.
    return (hasSensor && hasLOS) || hasTruth;
}

// Number() maps "" and "   " to 0, which would put a track point at the ENU origin
// or the epoch. Empty cells are MISSING VALUES here — the truth columns are
// deliberately blank for a direction-only (effectively infinite) target — so map
// them to NaN and let the callers reject them.
function cellNumber(value) {
    if (value === null || value === undefined) return NaN;
    if (typeof value === "number") return value;
    const s = String(value).trim();
    return s === "" ? NaN : Number(s);
}

/**
 * Local ENU metres -> [latDeg, lonDeg, altitude], under the flat-plane rule.
 *
 * Only the horizontal offset feeds the lat/lon; Z is returned as altitude directly
 * (plus the origin's ground elevation), which is what the format specifies. Using
 * the full 3-D ENU->ECEF conversion instead would silently subtract the curvature
 * term from every altitude — 196 m at the 50 km cell.
 */
export function botENUToLLA(x, y, z, origin = BOT_DEFAULT_ORIGIN) {
    const latRad = origin.latDeg * DEG;
    const lonRad = origin.lonDeg * DEG;
    const ecef = ENU2ECEF_radii(new Vector3(x, y, 0), latRad, lonRad);
    const [lat, lon] = ECEFToLLA_radii(ecef.x, ecef.y, ecef.z);
    return [lat / DEG, lon / DEG, z + origin.groundElevationMSL];
}

/**
 * Sightline unit vector -> {az, el} in degrees, in the SENSOR's own local frame.
 *
 * The format expresses every direction in the ENU basis at the scenario ORIGIN, not
 * at the sensor (scenario.json's directionBasis: "originLLA"). Sitrec's
 * CNodeLOSTrackMISB applies sensor azimuth/elevation against the local East/North/Up
 * AT THE SENSOR, so the vector has to be re-expressed in that basis first: rotate
 * origin-ENU -> ECEF -> sensor-ENU. Skipping that step tilts every sightline by
 * roughly d/R_earth, which is 0.45° at the 50 km cell — fifteen times the 0.03°
 * pointing noise the scenarios declare, so it would dominate the very quantity the
 * benchmark measures.
 *
 * az is the compass bearing (clockwise from north) and el is the angle above the
 * horizon, which is the convention CNodeLOSTrackMISB reads with platform
 * heading/pitch/roll all zero.
 */
export function botLOSToAzEl(los, sensorLatDeg, sensorLonDeg, origin = BOT_DEFAULT_ORIGIN) {
    const ecefDir = ENU2ECEF_radii(
        new Vector3(los[0], los[1], los[2]),
        origin.latDeg * DEG, origin.lonDeg * DEG,
        true);                                   // justRotate: it is a direction
    const local = ECEF2ENU_radii(ecefDir, sensorLatDeg * DEG, sensorLonDeg * DEG, true);
    local.normalize();
    let az = Math.atan2(local.x, local.y) / DEG;  // atan2(East, North)
    if (az < 0) az += 360;
    const el = Math.asin(Math.max(-1, Math.min(1, local.z))) / DEG;
    return {az, el};
}

// One sub-track per (TrackID, family) pair present in the file.
//
// `sensor` is listed first so it becomes track 0 — the primary track that drives
// smoothing and time sync — and because it is the only one that exists in a
// challenge-only (Input) file. suffix = display label; role = which track switch
// this sub-track auto-selects into on a direct load.
const BOT_FAMILIES = [
    {key: "sensor", suffix: " (Sensor)", role: "camera"},
    {key: "truth",  suffix: " (Truth)",  role: "target"},
];

export class CTrackFileBOT extends CTrackFile {

    // `data` is the parsed 2-D CSV array (row 0 = headers) from csv.toArrays().
    // Like CTrackFileSTANAGCSV this is NOT in CFileManagerParse's trackFileClasses
    // list, which is probed with raw text: the CSV path dispatches on
    // detectCSVType() after the text has been split into rows.
    static canHandle(filename, data) {
        return isBOTCSV(data);
    }

    // Origin and epoch are instance state so a future scenario.json reader can
    // override them without touching anything else here.
    constructor(data, origin = BOT_DEFAULT_ORIGIN, epochISO = BOT_DEFAULT_EPOCH_ISO) {
        super(data);
        this.origin = origin;
        this.epochMS = Date.parse(epochISO);
        if (!Number.isFinite(this.epochMS)) this.epochMS = Date.parse(BOT_DEFAULT_EPOCH_ISO);
    }

    // Parsed rows, memoised — the source data never changes.
    _rows() {
        if (this._rowsCache) return this._rowsCache;

        const csv = this.data;
        if (!isBOTCSV(csv)) {
            console.warn("BOT CSV: not a BOT interchange file");
            this._rowsCache = [];
            return this._rowsCache;
        }

        const C = BOT_COLUMNS;
        const col = (names) => findColumn(csv, names, true);

        const idCol = col(C.trackId);
        const srcCol = col(C.trackSource);
        const timeCol = col(C.time);
        const sensorCols = [col(C.sensorX), col(C.sensorY), col(C.sensorZ)];
        const losCols = [col(C.losX), col(C.losY), col(C.losZ)];
        const truthCols = [col(C.truthX), col(C.truthY), col(C.truthZ)];
        const uncertaintyCol = col(C.losUncertainty);

        console.log("Detected BOT interchange CSV with columns: "
            + "time=" + timeCol + ", sensor=[" + sensorCols + "], los=[" + losCols
            + "], truth=[" + truthCols + "]; origin "
            + this.origin.latDeg + "," + this.origin.lonDeg);

        // [a, b, c] from three columns, or null if any is missing or non-numeric.
        // A blank truth triple is the format's representation of "this target has
        // no finite position" (a star or planet), so it must yield null rather
        // than a point at the origin.
        const triple = (row, cols) => {
            if (cols[0] === -1 || cols[1] === -1 || cols[2] === -1) return null;
            const v = [cellNumber(row[cols[0]]), cellNumber(row[cols[1]]), cellNumber(row[cols[2]])];
            if (!v.every(Number.isFinite)) return null;
            return v;
        };

        const rows = [];
        let skipped = 0;
        for (let i = 1; i < csv.length; i++) {
            const row = csv[i];
            if (!Array.isArray(row)) continue;

            const t = cellNumber(row[timeCol]);
            if (!Number.isFinite(t)) { skipped++; continue; }

            const sensor = triple(row, sensorCols);
            const los = triple(row, losCols);
            const truth = triple(row, truthCols);
            // A row with a time but nothing to place contributes to no track.
            if (!sensor && !truth) { skipped++; continue; }

            rows.push({
                trackId: idCol === -1 ? "" : String(row[idCol] ?? "").trim(),
                trackSource: srcCol === -1 ? "" : String(row[srcCol] ?? "").trim(),
                time: this.epochMS + t * 1000,
                sensor, los, truth,
                losUncertainty: uncertaintyCol === -1 ? NaN : cellNumber(row[uncertaintyCol]),
            });
        }

        if (skipped > 0) {
            console.warn(`BOT CSV: skipped ${skipped} rows with no usable time or position`);
        }

        this._rowsCache = rows;
        return rows;
    }

    /**
     * The sub-tracks this file yields: the Sensor track then the Truth track,
     * skipping either if it has no usable points.
     *
     * ONE SCENARIO PER FILE. That is what the format emits — every file the exporter
     * writes carries a single TrackID — and it is all this class supports. A file
     * with several TrackIDs keeps the first and warns; to load several scenarios,
     * drop several files, which goes through this same path once each.
     *
     * ADDING MULTI-SCENARIO SUPPORT LATER. It was built once and removed as
     * unnecessary; if a real multi-TrackID file ever turns up, these are the pieces
     * it needed, and the order they have to be got right in:
     *
     *  1. Group rows by TrackID here and emit Sensor+Truth per group, so sub-track
     *     indices stay stable (TrackManager addresses tracks by index).
     *  2. getImportTrackCount() returns the number of TrackIDs, not 1. At >= 3 that
     *     makes TrackManager show the multi-track selection dialog, which can drop
     *     ANY subset — everything below follows from that.
     *  3. Roles cannot be static once a subset is possible: the file must be told
     *     which indices survive (a setLoadedTrackIndices hook on CTrackFile, called
     *     from TrackManager's per-file loop before any track is built) and resolve
     *     trackRoleHint over the loaded set. Camera = first loaded Sensor; target =
     *     the Truth of THAT SAME scenario, or none. Never another scenario's Truth:
     *     the range readouts and traverse analysis would then measure a sensor
     *     against an object it never saw.
     *  4. TrackManager's camera takeover and forceAngles must key off that resolved
     *     role, not off anglesAreMeasurement (true of every Sensor), or the last
     *     scenario loaded silently wins.
     *  5. isSupplementaryTrack must stay "Sensor is primary" so non-camera sensors
     *     keep their platform models — cpaCandidate already blocks the closest-
     *     approach re-timing separately, which is why the two are distinct methods.
     *  6. Epoch is the unresolved one: with no scenario.json every scenario gets
     *     BOT_DEFAULT_EPOCH_ISO, so concatenated scenarios are overlaid in time
     *     whether or not they were simultaneous. That cannot be fixed from the CSV
     *     alone, and was the strongest argument for not carrying the feature.
     */
    _subTracks() {
        if (this._subTracksCache) return this._subTracksCache;

        let rows = this._rows();

        // One scenario per file. Anything else is a concatenation the format never
        // produces; keep the first and say so, rather than building one track that
        // teleports between scenarios.
        const ids = [];
        for (const r of rows) if (!ids.includes(r.trackId)) ids.push(r.trackId);
        if (ids.length > 1) {
            console.warn(`BOT CSV: file holds ${ids.length} TrackIDs (${ids.join(", ")}); `
                + `only "${ids[0]}" is imported. One scenario per file — drop the files `
                + `separately to load several.`);
            rows = rows.filter((r) => r.trackId === ids[0]);
        }

        const out = [];
        for (const fam of BOT_FAMILIES) {
            const points = rows.filter((r) => r[fam.key] !== null);
            if (points.length === 0) continue;
            out.push({...fam, trackId: ids[0] ?? "", points});
        }

        this._subTracksCache = out;
        return out;
    }

    doesContainTrack() {
        return this._subTracks().length > 0;
    }

    getTrackCount() {
        return this._subTracks().length;
    }

    hasMoreTracks(trackIndex = 0) {
        return trackIndex < this.getTrackCount() - 1;
    }

    // A BOT file is a complete scenario, not an excerpt of one, so a fresh sitch is
    // fitted to its full length — the same operation as the "Sync Duration to" entry
    // in the time menu. Without it a 60 s scenario loads into the custom sitch's
    // default 30 s window and the second half simply is not on the timeline: the
    // tracks are there, but no frame ever reaches them. Only when no sitch is
    // established, so dropping a scenario into an existing setup never resizes the
    // timeline under the user.
    syncsSitchDuration() {
        return true;
    }

    // One scenario, so one logical import: the Sensor and Truth sub-tracks are two
    // views of it and always load together. Returning 1 keeps the multi-track
    // selection dialog from firing on them — the same reasoning as STANAG's
    // Platform/Target/Ground split.
    getImportTrackCount() {
        return 1;
    }

    // Sensor drives the camera, Truth is what it was looking at. The base class's
    // isSupplementaryTrack ("anything after the first") is already right for this
    // shape: the Sensor is sub-track 0 and primary, the Truth is 1 and supplementary
    // reference geometry, which is what shouldPreserveAnglesHeading reads to keep the
    // measured bearings when the Truth track arrives as the target.
    trackRoleHint(trackIndex) {
        const key = this._subTracks()[trackIndex]?.key;
        return key === "sensor" ? "camera" : key === "truth" ? "target" : null;
    }

    /**
     * This sub-track is GROUND TRUTH — what the object actually did, not a
     * reconstruction of it.
     *
     * Distinct from trackRoleHint, which reports "target" here: that answers
     * "which track should the camera point at", and a fitted candidate is a
     * target too. This answers "is this the answer key", which is what earns
     * the track its own marker shape so it cannot be mistaken for one more
     * hypothesis in the scene.
     */
    trackIsTruth(trackIndex) {
        return this._subTracks()[trackIndex]?.key === "truth";
    }

    // The Truth sub-track is the generator's own answer, so it is the traverse
    // analysis's scoring reference. True for it in both shapes that carry one — the
    // Truth file (sub-track 0, the answer key alone) and the All file (sub-track 1,
    // scenario and answer together) — which is why this asks the sub-track's key
    // rather than its index. The Sensor track is the measurement and never truth.
    isGroundTruthTrack(trackIndex) {
        return this._subTracks()[trackIndex]?.key === "truth";
    }

    /**
     * NEVER. No BOT track may re-time the sitch by closest approach.
     *
     * This is NOT redundant with isSupplementaryTrack, and it is not about
     * concatenated files. Drop two BOT files TOGETHER onto a fresh sitch and both
     * load before the sitch is established, so the second file's Sensor — a primary
     * track, correctly — reaches TrackManager's closest-point-of-approach heuristic
     * and re-times the whole sitch to the moment the two sensors pass nearest each
     * other. Two BOT scenarios are separate recordings that share only a coordinate
     * frame, so that moment means nothing, and acting on it moves the sitch window
     * off data that already carries absolute timestamps — wrecking both tracks.
     */
    cpaCandidate(trackIndex) {
        return false;
    }


    // The flat-plane rule makes Z a height above the site's ground, and the shipped
    // set's site is at sea level. Reported as MSL (not HAE) so the MISB pipeline
    // applies the geoid offset like any other orthometric source.
    isAltitudeHAE(trackIndex = 0) {
        return false;
    }

    /**
     * Smoothing window (frames) for the sensor angle columns.
     *
     * ZERO, deliberately. TrackManager's default of 120 frames suits a 30 fps video
     * where it is a 4-second window; these tracks are 1 Hz and 16-61 frames long, so
     * a 120-frame rolling average collapses the middle of the track to the mean of
     * the whole thing and flattens the sightline sweep that IS the measurement.
     * Beyond the length mismatch, pre-filtering the bearings would hand every
     * algorithm a smoothed version of the data it is supposed to fit, and the
     * declared LOSUncertainty would no longer describe what is in the file.
     */
    anglesSmoothing(trackIndex = 0) {
        return 0;
    }

    /**
     * The sensor track's angles are the ONLY evidence in a bearings-only problem.
     *
     * Without this the import lands with the camera heading still on "To Target",
     * aiming at the Truth track — so the sightlines being displayed and analysed
     * are reconstructed from the answer instead of measured. Every bearing then
     * passes exactly through truth, the noise the file declares disappears, and a
     * range fit run from that state is fitting its own input. The failure is
     * invisible: the picture looks better than the real one.
     */
    anglesAreMeasurement(trackIndex = 0) {
        return this._subTracks()[trackIndex]?.key === "sensor";
    }

    getShortName(trackIndex = 0, trackFileName = "") {
        const sub = this._subTracks()[trackIndex];
        // One scenario per file, so the filename (minus its .input/.truth/.all
        // qualifier) already identifies it; the suffix distinguishes Sensor from
        // Truth. The in-file TrackID is only a fallback for a nameless load.
        const base = trackFileName
            ? trackFileName.replace(/\.[^/.]+$/, "").replace(/\.(input|truth|all)$/i, "")
            : (sub?.trackId || "BOT Track");
        return base + (sub?.suffix ?? "");
    }

    toMISB(trackIndex = 0) {
        const subs = this._subTracks();
        if (trackIndex < 0 || trackIndex >= subs.length) {
            console.warn("BOT CSV: invalid track index " + trackIndex
                + ", file has " + subs.length + " tracks");
            return false;
        }

        const sub = subs[trackIndex];
        const misb = [];

        for (const r of sub.points) {
            const pos = r[sub.key];
            const [lat, lon, alt] = botENUToLLA(pos[0], pos[1], pos[2], this.origin);

            const row = new Array(MISBFields).fill(null);
            row[MISB.UnixTimeStamp] = r.time;
            row[MISB.SensorLatitude] = lat;
            row[MISB.SensorLongitude] = lon;
            row[MISB.SensorTrueAltitude] = alt;

            // The sightline rides on the SENSOR track only, as sensor-relative
            // az/el over a level, north-aligned platform. TrackManager keys the
            // whole angles pipeline off PlatformPitchAngle being a finite number,
            // so these three zeros are load-bearing, not padding: without them no
            // "<name> angles" LOS option is created at all.
            if (sub.key === "sensor" && r.los) {
                const {az, el} = botLOSToAzEl(r.los, lat, lon, this.origin);
                row[MISB.PlatformHeadingAngle] = 0;
                row[MISB.PlatformPitchAngle] = 0;
                row[MISB.PlatformRollAngle] = 0;
                row[MISB.SensorRelativeAzimuthAngle] = az;
                row[MISB.SensorRelativeElevationAngle] = el;
                row[MISB.SensorRelativeRollAngle] = 0;
            }

            misb.push(row);
        }

        if (misb.length === 0) {
            console.warn("BOT CSV: no valid track points for track index " + trackIndex);
            return false;
        }

        return misb;
    }

    extractObjects() {
    }
}
