/**
 * TrackCSV.js — THE single source of truth for materializing a detected
 * track CSV into a track-file object.
 *
 * CFileManagerParse (the live import path) and BotBenchIngest (bulk
 * analysis) both call trackFileFromCSVType; neither carries its own copy of
 * the type→parser→class dispatch, so a new CSV format added here is
 * loadable in the app AND analysable in BOTBench in the same commit. Type
 * DETECTION (detectCSVType, below) lives beside the dispatch it feeds.
 *
 * The entry for each type also records that format's CONVENTIONS, because
 * they are properties of the importer, not of the consumer:
 *
 *   (Timestamp UNITS are deliberately NOT a per-format convention: the
 *   MISB CSV importer passes the file's numbers through verbatim, so the
 *   unit is a property of the FILE, not the format. Clock consumers
 *   normalize per value — see epochStampSeconds in BotBenchIngest.)
 *
 *   pointing — whether rows carry a camera sightline, and in which
 *     convention:
 *       "gimbal"    SensorRelativeAzimuth/Elevation + platform attitude
 *                   (real MISB columns). May ALSO be stated as a frame-center
 *                   position on files that carry no angles at all — that is a
 *                   per-ROW property, not a per-format one, so it is not a
 *                   separate value here; see BotBenchIngest.misbFrameCenter.
 *       "boresight" the PLATFORM frame is the pointing: Airdata's importer
 *                   builds it from drone heading + gimbal pitch and leaves
 *                   the sensor-relative angles empty on purpose, so a
 *                   sightline consumer treats relative az/el as zero.
 *       "endpoints" the file states the sightline as its two ENDS (STANAG's
 *                   platform and ground positions per track point) rather
 *                   than as angles. Such a file is multiRole for the app —
 *                   it draws two or three tracks — but NOT ambiguous for a
 *                   sightline consumer, which pairs the ends by track point
 *                   via toSightlineMISB().
 *       "none"      position-only track; there are no sightlines to build.
 */
import {CTrackFileMISB} from "./CTrackFileMISB";
import {CTrackFileSTANAGCSV, isSTANAGCSV} from "./CTrackFileSTANAGCSV";
import {CTrackFileBOT, isBOTCSV} from "./CTrackFileBOT";
import {parseAirdataCSV} from "../ParseAirdataCSV";
import {parseMISB1CSV} from "../MISBUtils";
import {isCustom1, isFR24CSV, parseCustom1CSV, parseCustomFLLCSV, parseFR24CSV}
    from "../ParseCustom1CSV";
import {isFeaturesCSV} from "../ParseUtils";
import {stripDuplicateTimes} from "../ParseUtils";
import {Sit} from "../Globals";
import {showError} from "../showError";

/**
 * Detects the type of a CSV file based on header row patterns. Lives here —
 * beside the dispatch that materializes each type — so detection and
 * construction cannot drift apart, and so headless consumers (Jest, the
 * BOTBench bulk ingest) can import it without dragging the scene-heavy
 * CFileManagerParse chain (which re-exports it for its existing importers).
 * Returns "Airdata", "MISB_FULL", "MISB1", "STANAG_CSV", "BOT_CSV",
 * "CUSTOM1", "CUSTOM_FLL", "FR24CSV", "AZIMUTH", "ELEVATION", "HEADING",
 * "FOV", "FEATURES", or "Unknown".
 */
export function detectCSVType(csvRows) {

    if (csvRows[0][0] === "time(millisecond)" && csvRows[0][1] === "datetime(utc)") {
        return "Airdata";
    }

    if (csvRows[0][1] === "Checksum" && csvRows[0][2] === "UnixTimeStamp" && csvRows[0][3] === "MissionID") {
        return "MISB_FULL";
    }

    if (csvRows[0][0] === "DPTS" && csvRows[0][1] === "Security:") {
        return "MISB1";
    }

    if (csvRows[0].includes("Sensor Latitude") || csvRows[0].includes("SensorLatitude")) {
        return "MISB1";
    }

    if (csvRows[0][0].toLowerCase() === "frame" && csvRows[0][1].toLowerCase() === "latitude" && csvRows[0][2].toLowerCase() === "longitude") {
        return "CUSTOM_FLL";
    }

    // Must precede isCustom1: a STANAG CSV's UTC/TPLAT/TPLON headers also satisfy the
    // generic Custom1 header lists, which would import only the target position and
    // silently drop the Platform and Ground line-of-sight tracks.
    if (isSTANAGCSV(csvRows)) {
        return "STANAG_CSV";
    }

    // BOT interchange (bearings-only benchmark): Input, Truth or All shape.
    if (isBOTCSV(csvRows)) {
        return "BOT_CSV";
    }

    if (isCustom1(csvRows)) {
        return "CUSTOM1";
    }

    if (isFR24CSV(csvRows)) {
        return "FR24CSV";
    }

    if ((csvRows[0][0].toLowerCase() === "frame" || csvRows[0][0].toLowerCase() === "time")
        && csvRows[0][1].toLowerCase() === "az") {
        return "AZIMUTH";
    }

    if ((csvRows[0][0].toLowerCase() === "frame" || csvRows[0][0].toLowerCase() === "time")
        && csvRows[0][1].toLowerCase() === "el") {
        return "ELEVATION";
    }

    if ((csvRows[0][0].toLowerCase() === "frame" || csvRows[0][0].toLowerCase() === "time")
        && csvRows[0][1].toLowerCase() === "heading") {
        return "HEADING";
    }

    if ((csvRows[0][0].toLowerCase() === "frame" || csvRows[0][0].toLowerCase() === "time")
        && (csvRows[0][1].toLowerCase() === "fov" || csvRows[0][1].toLowerCase() === "zoom")) {
        return "FOV";
    }

    if (isFeaturesCSV(csvRows)) {
        return "FEATURES";
    }

    if (Sit.isCustom && typeof Sit.setup !== 'function' && !Sit.gimbalSetup) {
        showError("Unhandled CSV type detected.  Please add to detectCSVType() function.");
    }
    return "Unknown";
}

/**
 * The per-format conventions, separated from construction so a consumer can
 * decide whether a type is even usable BEFORE parsing it — several parsers
 * legitimately touch scene state (e.g. CUSTOM_FLL reads the global start
 * time), which a headless consumer must not trigger for a file it is going
 * to refuse anyway.
 */
const CSV_TRACK_TYPES = {
    Airdata:    {pointing: "boresight", multiRole: false},
    MISB_FULL:  {pointing: "gimbal",    multiRole: false},
    MISB1:      {pointing: "gimbal",    multiRole: false},
    STANAG_CSV: {pointing: "endpoints", multiRole: true},
    BOT_CSV:    {pointing: "gimbal",    multiRole: false},
    CUSTOM1:    {pointing: "none",      multiRole: false},
    CUSTOM_FLL: {pointing: "none",      multiRole: false},
    FR24CSV:    {pointing: "none",      multiRole: false},
};

/** Conventions for a detected type, or null when it is not a track CSV. */
export function trackCSVConventions(type) {
    return CSV_TRACK_TYPES[type] ?? null;
}

/**
 * Materialize a detected CSV type (from detectCSVType) into a track file.
 *
 * @param type   the detectCSVType result
 * @param rows   the parsed CSV as a 2-D array
 * @param opts   {stripDuplicates} — drop repeated-timestamp rows (the live
 *               custom-sitch import does this; the bulk path judges
 *               continuity on the timestamps and must see them)
 * @returns {trackFile, pointing, multiRole} or null when the
 *          type is not a track CSV (caller handles AZIMUTH/FOV/features/…).
 */
export function trackFileFromCSVType(type, rows, {stripDuplicates = false} = {}) {
    const conv = trackCSVConventions(type);
    if (!conv) return null;
    const dedup = (misb) => (stripDuplicates ? stripDuplicateTimes(misb) : misb);
    let trackFile = null;
    switch (type) {
        // Airdata and MISB_FULL are never deduped — matching the live import
        // exactly (only the four types below ever were).
        case "Airdata":
            trackFile = new CTrackFileMISB(parseAirdataCSV(rows));
            break;
        case "MISB_FULL":
            trackFile = new CTrackFileMISB(parseMISB1CSV(rows));
            break;
        case "MISB1":
            trackFile = new CTrackFileMISB(dedup(parseMISB1CSV(rows)));
            break;
        case "STANAG_CSV":
            // Yields Target/Platform/Ground sub-tracks with roles and an HAE
            // datum — see CTrackFileSTANAGBase. multiRole: a consumer that
            // needs ONE track must pick a role.
            trackFile = new CTrackFileSTANAGCSV(rows);
            break;
        case "BOT_CSV":
            // Any of the three BOT shapes. The file carries no georeference,
            // so the class applies its default origin and epoch — see
            // CTrackFileBOT for what that costs.
            trackFile = new CTrackFileBOT(rows);
            break;
        case "CUSTOM1":
            trackFile = new CTrackFileMISB(dedup(parseCustom1CSV(rows)));
            break;
        case "CUSTOM_FLL":
            trackFile = new CTrackFileMISB(dedup(parseCustomFLLCSV(rows)));
            break;
        case "FR24CSV":
            trackFile = new CTrackFileMISB(dedup(parseFR24CSV(rows)));
            break;
    }
    return {trackFile, ...conv};
}
