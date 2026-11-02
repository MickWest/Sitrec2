// Build-time extraction of satellite sizes and Starlink designs from GCAT into a
// compact table that Sitrec loads on demand (data/nightsky/gcat-sizes.csv.gz).
//
// Source: GCAT, the General Catalog of Artificial Space Objects, by Jonathan C.
// McDowell, licensed CC-BY 4.0. Download its satcat.tsv by hand (the "cat/satcat"
// file of the GCAT TSV tables) and pass the path:
//
//     node scripts/buildSatelliteSizes.js path/to/satcat.tsv
//
// The script reads the file only; it does not download anything.
//
// WHAT IS KEPT, per object with a catalog number:
//   - Length, Diameter and Span in metres, as GCAT gives them. GCAT records 0 for
//     an unknown size (most debris); those objects are left out, so Sitrec falls
//     back to its radar-size or default estimate for them. An object whose Status
//     is GRP (the first module of a station, such as Zarya for the ISS) is left
//     out too: its size is one module, not the station.
//   - The mean projected area in square metres, from those sizes (rule below).
//   - The Starlink design, for Starlink objects only (rule below).
//
// MEAN PROJECTED AREA. For a convex body seen from a random direction, the mean
// area of its shadow is a quarter of its surface area (Cauchy's surface-area
// formula). Sitrec does not know the attitude of most objects, so this mean is
// the area it uses. The body is a cylinder of length L and diameter D, a box of
// length L and a square D x D cross-section when GCAT's Shape starts with "Box",
// or a sphere of diameter D when it starts with "Sphere". When the Shape lists
// solar panels ("pan"), they add one flat panel of (Span - D) by D, both faces
// counted; the true panel width is not in GCAT, so the body width is used. The
// rule is approximate: a factor of two either way is normal.
//
// STARLINK DESIGN. GCAT's Bus column separates the V2 Mini family:
//   "Starlink V2M" -> v2m (V2 Mini), "Starlink V2MO" -> v2mo (V2 Mini Optimized),
//   "Starlink V2MD" -> v2md (Direct to Cell). The older "Starlink" bus covers
//   V0.9, V1.0, VisorSat and V1.5, and the payload name (PLName) splits them:
//   "Starlink V0.9-..." -> v0.9; "Starlink V1.0-Lnn-..." -> v1.0 before launch L9
//   and visor from L9 on (plus Starlink-1436, the single VisorSat flown on L7);
//   "Starlink Group ..." -> v1.5. Anything else (rideshare test flights) is left
//   without a design, so Sitrec treats it as unknown.
//
// OUTPUT FORMAT (gzip of text, decoded by src/SatelliteSizes.js):
//   "#" comment lines, then one line per object:
//   norad step,area m2,length m,diameter m,span m,design
//   where "norad step" is the catalog number minus the previous line's number
//   (the first line's is the number itself), so most steps are a single digit.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.resolve(__dirname, "../data/nightsky/gcat-sizes.csv.gz");
const FIRST_VISOR_LAUNCH = 9;
const VISOR_PROTOTYPE_NAME = "Starlink 1436";

function readTable(file) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const header = lines[0].replace(/^#/, "").split("\t").map(cell => cell.trim());
    const updated = lines.find(line => /^# Updated/.test(line))?.replace(/^#\s*/, "").trim() ?? "unknown date";
    const rows = [];
    for (const line of lines.slice(1)) {
        if (!line.trim() || line.startsWith("#")) continue;
        const cells = line.split("\t").map(cell => cell.trim());
        rows.push(Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ""])));
    }
    return {rows, updated};
}

function sizeOf(value) {
    const n = parseFloat(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

function meanProjectedArea(length, diameter, span, shape) {
    const s = shape.toLowerCase();
    let surface;
    if (s.startsWith("sphere")) {
        surface = Math.PI * diameter * diameter;
    } else if (s.startsWith("box")) {
        surface = 2 * diameter * diameter + 4 * length * diameter;
    } else {
        surface = Math.PI * diameter * diameter / 2 + Math.PI * diameter * length;
    }
    if (/pan/.test(s) && span > diameter) surface += 2 * (span - diameter) * diameter;
    return surface / 4;
}

function starlinkDesign(row) {
    const bus = row.Bus;
    if (bus === "Starlink V2M") return "v2m";
    if (bus === "Starlink V2MO") return "v2mo";
    if (bus === "Starlink V2MD") return "v2md";
    if (bus !== "Starlink") return "";
    const plName = row.PLName;
    if (/^Starlink V0\.9-/.test(plName)) return "v0.9";
    const v1 = /^Starlink V1\.0-L(\d+)-/.exec(plName);
    if (v1) {
        if (Number(v1[1]) >= FIRST_VISOR_LAUNCH || row.Name === VISOR_PROTOTYPE_NAME) return "visor";
        return "v1.0";
    }
    if (/^Starlink Group /.test(plName)) return "v1.5";
    return "";
}

// Two significant figures, written without an exponent.
function round2(value) {
    return String(Number(value.toPrecision(2)));
}

function main() {
    const input = process.argv[2];
    if (!input) {
        console.error("Usage: node scripts/buildSatelliteSizes.js path/to/satcat.tsv");
        process.exit(1);
    }
    const {rows, updated} = readTable(input);
    const entries = [];
    for (const row of rows) {
        if (!/^\d+$/.test(row.Satcat)) continue;
        const norad = Number(row.Satcat);
        const length = sizeOf(row.Length), diameter = sizeOf(row.Diameter), span = sizeOf(row.Span);
        const design = starlinkDesign(row);
        const hasSize = length > 0 && diameter > 0 && row.Status !== "GRP";
        if (!hasSize && !design) continue;
        const area = hasSize ? round2(meanProjectedArea(length, diameter, span, row.Shape)) : "";
        entries.push({norad, area, length, diameter, span, design});
    }
    entries.sort((a, b) => a.norad - b.norad);

    const lines = [
        "# Satellite sizes and Starlink designs derived from GCAT (J. McDowell, planet4589.org/space/gcat), CC-BY 4.0.",
        "# McDowell, Jonathan C., 2020. General Catalog of Artificial Space Objects.",
        `# GCAT satcat ${updated}. Built by scripts/buildSatelliteSizes.js; the rules are described there.`,
        "# norad step,area m2,length m,diameter m,span m,design",
    ];
    let previous = 0;
    for (const e of entries) {
        if (e.norad === previous) continue;
        const dims = e.area ? [e.length, e.diameter, e.span].map(v => String(v)) : ["", "", ""];
        lines.push([e.norad - previous, e.area, ...dims, e.design].join(",").replace(/,+$/, ""));
        previous = e.norad;
    }
    const text = lines.join("\n") + "\n";
    fs.mkdirSync(path.dirname(OUT), {recursive: true});
    fs.writeFileSync(OUT, zlib.gzipSync(Buffer.from(text, "utf8"), {level: 9}));
    const designs = {};
    for (const e of entries) if (e.design) designs[e.design] = (designs[e.design] ?? 0) + 1;
    console.log(`Wrote ${entries.length} objects to ${path.relative(process.cwd(), OUT)} ` +
        `(${fs.statSync(OUT).size} bytes; text ${text.length} bytes). Starlink designs:`, designs);
}

if (require.main === module) main();

module.exports = {meanProjectedArea, starlinkDesign};
