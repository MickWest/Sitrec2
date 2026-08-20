/*
    "What tracks does this file hold?" — answered WITHOUT importing it.

    The track browser has to answer that for every file in a folder, hundreds at a
    time, before the user has picked anything. parseAsset cannot be used for it: it
    registers the file with the FileManager, builds nodes, and in several branches
    reads or writes scene state (CUSTOM_FLL reads the global start time, a BOT file
    would re-time the sitch). This is the READ-ONLY half of that switch — the same
    detectors and the same CTrackFile classes, and nothing that outlives the call.

    It stays in sync with the live importer by going through the same two seams
    rather than re-deriving anything:

      trackFileFromCSVType()      the shared CSV dispatch (see TrackCSV.js, whose
                                  header explains why it exists separately)
      FileManager.detectTrackFile() the trackFileClasses list for XML/KML/SRT/JSON

    Formats needing a demuxer, a GPU or a running scene — video containers, KLV
    inside a transport stream, GeoTIFF — are deliberately not probed. A folder sweep
    that opened every .ts in a results directory would cost more than the browse it
    is meant to serve, and none of those shapes is a multi-track file anyway.
 */

import {FileManager} from "../Globals";
import {MISB} from "../MISBFields";
import {getFileExtension} from "../utils";
import {parseXml} from "../parseXml";
import csv from "../utils/CSVParser";
import {detectCSVType, trackFileFromCSVType} from "./TrackCSV";

// Extensions worth opening during a folder sweep. Everything here is text (or a
// zip of text) and parses in single-digit milliseconds for a typical track.
const PROBE_EXTENSIONS = new Set([
    "csv", "kml", "kmz", "ksv", "xml", "srt", "json", "geojson", "txt",
]);

// Metres per degree of latitude, and of longitude at the equator. The thumbnail
// projection below is a local equirectangular one, so one constant is enough.
const M_PER_DEG = 111319.4907932736;

/**
 * Longitude difference, wrapped into [-180, 180].
 *
 * A plain subtraction is wrong across the ANTIMERIDIAN: a track stepping from
 * 179.99 to -179.99 is moving about 2 km, but the raw difference is -359.98
 * degrees, which projects to roughly 40,000 km. That one sample would then set
 * the whole summary's extent, so a perfectly ordinary Pacific track drew as a
 * line across the entire plot and reported a planet-sized "extent". Wrapping
 * costs one comparison per point and is correct everywhere else.
 */
function lonDeltaDeg(lon, originLon) {
    let delta = lon - originLon;
    if (delta > 180) delta -= 360;
    else if (delta < -180) delta += 360;
    return delta;
}

/** True if a folder sweep should open this file and ask what tracks it has. */
export function isProbeableTrackName(name = "") {
    // A `.pts.txt` is a KLV PES-timing sidecar whose content is JSON. parseAsset
    // has a branch for it precisely so it never reaches the track loaders; the
    // sweep skips it for the same reason.
    if (/\.pts\.txt$/i.test(name)) return false;
    return PROBE_EXTENSIONS.has(getFileExtension(name).toLowerCase());
}

/**
 * Parse `file` far enough to say what tracks it holds, and no further.
 *
 * @param {string} filename
 * @param {File|Blob} file
 * @returns {Promise<CTrackFile|null>} null when the file is not a track file at all
 */
export async function probeTrackFile(filename, file) {
    const ext = getFileExtension(filename).toLowerCase();

    if (ext === "kmz") {
        return probeKMZ(file);
    }

    const text = await file.text();

    switch (ext) {
        case "csv": {
            // Sonde CSVs are content-detected from raw text, exactly as the csv
            // branch of parseAsset does it, and must be asked before the rows are
            // split — the class reads the text itself.
            const sonde = detectTrackFile(filename, text);
            if (sonde) return sonde;
            const rows = csv.toArrays(text);
            if (!rows.length || !Array.isArray(rows[0])) return null;
            // reportUnknown: false — detectCSVType otherwise raises an error
            // DIALOG for an unhandled CSV inside a custom sitch. A sweep hits
            // unrelated CSVs constantly, and one modal per file buries the
            // browser that opened the folder. A try/catch cannot help here:
            // showError displays, it does not throw.
            let type;
            try {
                type = detectCSVType(rows, {reportUnknown: false});
            } catch (e) {
                return null;
            }
            // stripDuplicates is the LIVE import's choice, and it is deliberately
            // not made here: the browser only measures and draws, so it should see
            // the file as written.
            return trackFileFromCSVType(type, rows)?.trackFile ?? null;
        }
        case "kml":
        case "ksv":
        case "xml":
            return detectTrackFile(filename, parseXml(text));
        case "srt":
        case "txt":
            return detectTrackFile(filename, text);
        case "json":
        case "geojson": {
            let parsed;
            try {
                parsed = JSON.parse(text);
            } catch (e) {
                return null;
            }
            // A saved sitch is JSON too, and it is not a track file.
            if (!parsed || typeof parsed !== "object" || parsed.isASitchFile) return null;
            return detectTrackFile(filename, parsed);
        }
        default:
            return null;
    }
}

/**
 * EVERY track-shaped entry inside a .kmz, not just the first.
 *
 * This has to match what importing the archive actually does. parseAsset's zip
 * branch parses every non-image entry — `nonImageFiles.map(... parseAsset ...)` —
 * so a KMZ holding two KMLs imports as two track files. Probing only the first
 * one made the browser disagree with its own Import button in the two ways that
 * matter most: a KMZ of two single-track KMLs was counted as single-track and
 * so never listed at all, and a KMZ whose later entries carry extra tracks drew
 * a thumbnail of strictly less than what the import would produce.
 *
 * The entry filter is parseAsset's (skip directories, __MACOSX and ._ resource
 * forks) narrowed by isProbeableTrackName, which is the same narrowing the folder
 * walk applies — an archive is a folder for these purposes.
 */
async function probeKMZ(file) {
    const {default: JSZip} = await import("jszip");
    const zip = await new JSZip().loadAsync(await file.arrayBuffer());
    const names = Object.keys(zip.files).filter(name =>
        !zip.files[name].dir
        && !name.includes("__MACOSX") && !name.includes("._")
        && isProbeableTrackName(name));

    const found = [];
    for (const name of names) {
        // The basename, so getFileExtension sees the entry's own extension
        // rather than a path, exactly as the unzip path names its files.
        const base = name.split("/").pop();
        try {
            const probed = await probeTrackFile(base, new File([await zip.files[name].async("blob")], base));
            if (Array.isArray(probed)) found.push(...probed);
            else if (probed) found.push(probed);
        } catch (e) {
            // One bad entry must not lose the rest of the archive.
        }
    }
    return found.length ? found : null;
}

/**
 * The app's own handler dispatch, guarded.
 *
 * detectTrackFile asserts when two handlers claim one file, and a handler can
 * throw on malformed input. Either is fatal mid-sweep and neither is worth
 * stopping a browse for, so an unclaimable file is simply not a track file here.
 */
function detectTrackFile(filename, data) {
    try {
        return FileManager?.detectTrackFile?.(filename, data) ?? null;
    } catch (e) {
        return null;
    }
}

/**
 * Every (track file, track index) a probe result yields, flattened in order.
 *
 * A probe returns ONE track file for a plain file and SEVERAL for an archive, so
 * everything downstream works off this rather than off a single file — which is
 * what lets a two-KML KMZ count and draw as the two-track thing it imports as.
 *
 * getTrackCount, NOT getImportTrackCount. The two differ exactly where it matters
 * here: a BOT `.all.csv` and a STANAG file each report ONE importable unit (so the
 * multi-track picker stays out of the way) while carrying two or three distinct
 * tracks — sensor and truth, platform and target. Those are the files the browser
 * exists to show, and getImportTrackCount would report every one of them as single.
 */
function trackRefs(probed) {
    const files = Array.isArray(probed) ? probed : (probed ? [probed] : []);
    const refs = [];
    for (const trackFile of files) {
        let count = 0;
        try {
            if (typeof trackFile.doesContainTrack === "function" && !trackFile.doesContainTrack()) continue;
            count = trackFile.getTrackCount() || 0;
        } catch (e) {
            continue;
        }
        for (let i = 0; i < count; i++) refs.push({trackFile, trackIndex: i});
    }
    return refs;
}

/** How many drawable tracks a probe result yields, across every file in it. */
export function trackFileTrackCount(probed) {
    return trackRefs(probed).length;
}

/**
 * Reduce a parsed track file to what a plan-view thumbnail needs.
 *
 * Positions come back as local metres in an equirectangular frame centred on the
 * file's own first fix — self-contained by design, because the browser draws a
 * SHAPE and must not depend on a scene, a sitch origin, or a georeference the file
 * may not carry (a BOT CSV carries none at all). East is +x, north is +y.
 *
 * @returns {object|null} null when no track in the file has a usable position
 */
export function summarizeTrackFile(probed, filename, {maxPoints = 500} = {}) {
    const refs = trackRefs(probed);
    if (!refs.length) return null;

    // Origin: the first valid fix anywhere in the result, so every track — across
    // every file of an archive — shares one frame and their relative geometry
    // survives the projection.
    let originLat = null, originLon = null;
    const raw = [];
    for (let i = 0; i < refs.length; i++) {
        const {trackFile, trackIndex} = refs[i];
        let misb;
        try {
            misb = trackFile.toMISB(trackIndex);
        } catch (e) {
            continue;
        }
        if (!Array.isArray(misb) || !misb.length) continue;
        if (originLat === null) {
            for (const row of misb) {
                const lat = row[MISB.SensorLatitude], lon = row[MISB.SensorLongitude];
                if (Number.isFinite(lat) && Number.isFinite(lon)) { originLat = lat; originLon = lon; break; }
            }
        }
        // `index` is the position in the FLATTENED list, not the index within its
        // own file, so the browser's roleless color palette still separates two
        // tracks that each sit at index 0 of a different KML in one KMZ.
        raw.push({index: i, trackFile, trackIndex, misb});
    }
    if (originLat === null) return null;

    const cosLat = Math.cos(originLat * Math.PI / 180);
    const tracks = [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let startMS = Infinity, endMS = -Infinity;

    for (const {index, trackFile, trackIndex, misb} of raw) {
        // Sub-sampled by STRIDE rather than by decimation-with-tolerance: a
        // thumbnail is a few hundred pixels wide, so the error a stride can
        // introduce is far below one pixel, and it costs one pass.
        const stride = Math.max(1, Math.ceil(misb.length / maxPoints));
        const xy = [];
        let altMinM = Infinity, altMaxM = -Infinity;
        let trackStart = Infinity, trackEnd = -Infinity;

        for (let r = 0; r < misb.length; r++) {
            // Always keep the LAST row, whatever the stride lands on — a track
            // whose final leg is clipped reads as a different shape.
            if (r % stride !== 0 && r !== misb.length - 1) continue;
            const row = misb[r];
            const lat = row[MISB.SensorLatitude], lon = row[MISB.SensorLongitude];
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
            const x = lonDeltaDeg(lon, originLon) * M_PER_DEG * cosLat;
            const y = (lat - originLat) * M_PER_DEG;
            xy.push(x, y);
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;

            const alt = row[MISB.SensorTrueAltitude];
            if (Number.isFinite(alt)) {
                if (alt < altMinM) altMinM = alt;
                if (alt > altMaxM) altMaxM = alt;
            }
            const t = row[MISB.UnixTimeStamp];
            if (Number.isFinite(t)) {
                if (t < trackStart) trackStart = t;
                if (t > trackEnd) trackEnd = t;
            }
        }
        if (xy.length < 2) continue;

        if (trackStart < startMS) startMS = trackStart;
        if (trackEnd > endMS) endMS = trackEnd;

        tracks.push({
            index,
            name: safeShortName(trackFile, trackIndex, filename),
            role: safeCall(trackFile, "trackRoleHint", trackIndex) ?? null,
            isTruth: safeCall(trackFile, "isGroundTruthTrack", trackIndex) === true,
            points: xy.length / 2,
            samples: misb.length,
            xy: Float32Array.from(xy),
            altMinM: altMinM === Infinity ? null : altMinM,
            altMaxM: altMaxM === -Infinity ? null : altMaxM,
        });
    }
    if (!tracks.length) return null;

    return {
        filename,
        trackCount: tracks.length,
        tracks,
        minX, maxX, minY, maxY,
        spanM: Math.max(maxX - minX, maxY - minY),
        durationS: (endMS > startMS) ? (endMS - startMS) / 1000 : null,
        startMS: Number.isFinite(startMS) ? startMS : null,
        originLat, originLon,
    };
}

function safeShortName(trackFile, index, filename) {
    try {
        return trackFile.getShortName(index, filename) || `Track ${index}`;
    } catch (e) {
        return `Track ${index}`;
    }
}

function safeCall(trackFile, method, index) {
    try {
        return typeof trackFile[method] === "function" ? trackFile[method](index) : undefined;
    } catch (e) {
        return undefined;
    }
}
