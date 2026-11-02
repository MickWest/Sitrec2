// Satellite sizes and Starlink designs from GCAT (Jonathan C. McDowell, CC-BY 4.0),
// fetched on demand from data/nightsky/gcat-sizes.csv.gz. The table and the rules
// behind it are made by scripts/buildSatelliteSizes.js.
//
// applySatelliteSizes() copies onto each SatData:
//   areaM2         mean projected area in square metres (brightness of objects that
//                  are not Starlink or Kuiper, see SatelliteBrightness.js)
//   sizeM          {length, diameter, span} in metres, for the satellite's info menu
//   starlinkDesign v1.0, visor, v1.5, v2m, v2mo, v2md or v0.9, for Starlink only
// An object that the table does not have keeps none of these.

import {SITREC_APP} from "./configUtils";

const SIZES_FILE = "data/nightsky/gcat-sizes.csv.gz";

let sizes = null;          // Map: NORAD number -> {areaM2, sizeM, starlinkDesign}
let loadPromise = null;

// The text of the table: "#" comment lines, then
// "norad step,area m2,length m,diameter m,span m,design" per object, where the
// step is the NORAD number minus the previous line's. Trailing empty cells are
// left out.
export function parseSatelliteSizes(text) {
    const table = new Map();
    let norad = 0;
    for (const line of text.split("\n")) {
        if (!line || line.startsWith("#")) continue;
        const [step, area, length, diameter, span, design] = line.split(",");
        norad += Number(step);
        const entry = {};
        if (area) {
            entry.areaM2 = Number(area);
            entry.sizeM = {length: Number(length), diameter: Number(diameter), span: Number(span)};
        }
        if (design) entry.starlinkDesign = design;
        table.set(norad, entry);
    }
    return table;
}

async function gunzipText(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    // A server that sends .gz files with Content-Encoding: gzip has already
    // decompressed it; only a gzip stream starts with 1f 8b.
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);
    const stream = new Response(bytes).body.pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
}

// Fetch and parse the table once. Idempotent and safe to call concurrently. A
// failed load is reported once and leaves the brightness on its fallbacks.
export function ensureSatelliteSizesLoaded() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
        try {
            const response = await fetch(SITREC_APP + SIZES_FILE);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            sizes = parseSatelliteSizes(await gunzipText(await response.arrayBuffer()));
        } catch (error) {
            console.warn(`Satellite sizes not loaded (${SIZES_FILE}): ${error.message}`);
            sizes = new Map();
        }
        return sizes;
    })();
    return loadPromise;
}

// Copy the table's fields onto each SatData that the table has. Returns how many
// it changed.
export function applySatelliteSizes(satDataList, table = sizes) {
    if (!table || !satDataList) return 0;
    let changed = 0;
    for (const satData of satDataList) {
        const entry = table.get(satData.number);
        if (!entry) continue;
        if (entry.areaM2 !== undefined) {
            satData.areaM2 = entry.areaM2;
            satData.sizeM = entry.sizeM;
        }
        if (entry.starlinkDesign) satData.starlinkDesign = entry.starlinkDesign;
        changed++;
    }
    return changed;
}
