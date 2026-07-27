/*
    STANAG 4676 Track File Parser (CSV container)

    A flattened CSV export of the same GXP-InMotion track data as the STANAG 4676 XML, one
    row per track point, with the three collinear positions in parallel column families:

        UTC0   baseTime for the file, epoch milliseconds (constant on every row)
        FRM    source video frame number (unused: the pipeline is time-based)
        UTC    epoch milliseconds for this point
        t      time of this point in seconds relative to UTC0
        GLAT   GLON   HAE     ground   end of the LOS ray  (XML posLow)      -> "(Ground)"
        SLAT   SLON   SHAE    sensor/platform end of the ray (XML posHigh)   -> "(Platform)"
        TPLAT  TPLON  TPHAE   the tracked object (XML dynamics/pos)          -> "(Target)"

    Container-specific parsing only: everything else (track enumeration, ground-locked
    de-duplication, MISB conversion, naming, camera/target role hints, HAE datum) is shared
    with the XML flavour via CTrackFileSTANAGBase, so both load identically.
 */

import {CTrackFileSTANAGBase} from "./CTrackFileSTANAGBase";
import {findColumn} from "../ParseUtils";

// Accepted header spellings per field. Matching is exact-but-case-insensitive and trims
// surrounding whitespace (see findColumn), and extra/unknown columns are ignored, so a
// producer's additional metadata columns do not affect detection or parsing.
const STANAG_CSV_COLUMNS = {
    baseTime:  ["UTC0"],
    utc:       ["UTC"],
    seconds:   ["T"],
    groundLat: ["GLAT"],  groundLon: ["GLON"],  groundAlt: ["HAE"],
    sensorLat: ["SLAT"],  sensorLon: ["SLON"],  sensorAlt: ["SHAE"],
    targetLat: ["TPLAT"], targetLon: ["TPLON"], targetAlt: ["TPHAE"],
};

/**
 * True if these CSV rows are a STANAG 4676 CSV export.
 *
 * Deliberately narrow: it requires the target family AND at least one line-of-sight
 * endpoint family. Several of these headers (UTC, TPLAT, TPLON, TPHAE) are also in the
 * generic Custom1 CSV header lists, so a plain target-only CSV must keep falling through
 * to Custom1 exactly as before — only a file that actually carries the LOS geometry is
 * claimed here. Must therefore be tested BEFORE isCustom1() in detectCSVType().
 */
export function isSTANAGCSV(csv) {
    if (!Array.isArray(csv) || csv.length < 2 || !Array.isArray(csv[0])) return false;

    const has = (names) => findColumn(csv, names, true) !== -1;
    const C = STANAG_CSV_COLUMNS;

    const hasTarget   = has(C.targetLat) && has(C.targetLon) && has(C.targetAlt);
    const hasPlatform = has(C.sensorLat) && has(C.sensorLon) && has(C.sensorAlt);
    const hasGround   = has(C.groundLat) && has(C.groundLon) && has(C.groundAlt);
    // Absolute per-row time, or the baseTime + relative-seconds pair.
    const hasTime     = has(C.utc) || (has(C.baseTime) && has(C.seconds));

    return hasTime && hasTarget && (hasPlatform || hasGround);
}

// Number() maps "" and "   " to 0, which would turn a blank cell into a position at
// 0°N 0°E or a timestamp at the Unix epoch. Empty cells are missing values, so map them
// to NaN and let the callers reject them.
function cellNumber(value) {
    if (value === null || value === undefined) return NaN;
    if (typeof value === "number") return value;
    const s = String(value).trim();
    return s === "" ? NaN : Number(s);
}

export class CTrackFileSTANAGCSV extends CTrackFileSTANAGBase {

    // `data` is the parsed 2-D CSV array (row 0 = headers), as produced by csv.toArrays().
    // Note this class is NOT in CFileManagerParse's trackFileClasses list: that list is
    // probed with the raw file text, whereas the CSV path dispatches on detectCSVType()
    // after the text has been split into rows.
    static canHandle(filename, data) {
        return isSTANAGCSV(data);
    }

    _stanagPoints() {
        const csv = this.data;
        if (!isSTANAGCSV(csv)) {
            console.warn("STANAG CSV: not a STANAG CSV export");
            return [];
        }

        const C = STANAG_CSV_COLUMNS;
        const col = (names) => findColumn(csv, names, true);

        const utcCol      = col(C.utc);
        const baseTimeCol = col(C.baseTime);
        const secondsCol  = col(C.seconds);

        const groundCols   = [col(C.groundLat), col(C.groundLon), col(C.groundAlt)];
        const platformCols = [col(C.sensorLat), col(C.sensorLon), col(C.sensorAlt)];
        const targetCols   = [col(C.targetLat), col(C.targetLon), col(C.targetAlt)];

        // UTC0 is constant across the file; read it from the first data row. Only needed
        // when there is no absolute UTC column.
        const baseTime = baseTimeCol === -1 ? NaN : cellNumber(csv[1][baseTimeCol]);

        console.log("Detected STANAG CSV format with columns: " +
            "utc=" + utcCol + ", baseTime=" + baseTimeCol + ", seconds=" + secondsCol +
            ", target=[" + targetCols + "], platform=[" + platformCols + "], ground=[" + groundCols + "]");

        // [lat, lon, alt] from three columns of a row, or null if any is missing/non-numeric.
        const triple = (row, [latCol, lonCol, altCol]) => {
            if (latCol === -1 || lonCol === -1 || altCol === -1) return null;
            const lat = cellNumber(row[latCol]);
            const lon = cellNumber(row[lonCol]);
            const alt = cellNumber(row[altCol]);
            if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(alt)) return null;
            return [lat, lon, alt];
        };

        const points = [];
        let skipped = 0;
        for (let i = 1; i < csv.length; i++) {
            const row = csv[i];
            if (!Array.isArray(row)) continue;

            let time = utcCol === -1 ? NaN : cellNumber(row[utcCol]);
            if (!Number.isFinite(time) && secondsCol !== -1) {
                // Fall back to baseTime + relative seconds.
                const t = cellNumber(row[secondsCol]);
                if (Number.isFinite(baseTime) && Number.isFinite(t)) {
                    time = baseTime + t * 1000;
                }
            }
            // A point with no usable time can't be placed on the timeline.
            if (!Number.isFinite(time)) {
                skipped++;
                continue;
            }

            const target = triple(row, targetCols);
            const platform = triple(row, platformCols);
            const ground = triple(row, groundCols);
            // A row carrying a timestamp but no position at all is not a track point —
            // it contributes nothing to any of the three tracks. Dropping it here (rather
            // than letting toMISB skip it) keeps _points() honest, so doesContainTrack()
            // does not report a track for a file of position-less rows. Dropping is safe:
            // all three sequences are derived from this same array, so they stay aligned
            // and equal-length for the duplicate check.
            if (!target && !platform && !ground) {
                skipped++;
                continue;
            }

            points.push({time, target, platform, ground});
        }

        if (skipped > 0) {
            console.warn(`STANAG CSV: skipped ${skipped} rows with no usable timestamp or position`);
        }

        return points;
    }
}
