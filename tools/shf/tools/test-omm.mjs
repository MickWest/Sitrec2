// Execute-test for OMM CSV parsing in flareEngine.js.
//
// The TLE format cannot express catalog numbers above 99999, and the catalog
// passed that limit on 2026-07-11. CelesTrak leaves those objects out of its
// TLE feeds entirely, so a Starlink flare tool reading TLE cannot see the
// newest satellites at all. Both the Sitrec proxy and the CelesTrak fallback
// now request FORMAT=csv, so parseTLE has to accept OMM CSV as well as TLE.
//
// Fixtures are real records from the CelesTrak Starlink supplemental feed.
import * as satellite from "../lib/satellite.es.js";
import { createFlareEngine } from "../flareEngine.js";

let fails = 0;
function ok(name, cond, extra = "") {
    console.log((cond ? "  ok   " : "  FAIL ") + name + (extra ? "  " + extra : ""));
    if (!cond) fails++;
}

const engine = createFlareEngine(satellite);

const CSV_HEADER =
    "OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE," +
    "ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID," +
    "ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT,RMS,DATA_SOURCE";

// 5-digit catalog number — expressible in both formats, so the two parsers can
// be checked against each other.
const CSV_44714 =
    "STARLINK-1008,2019-074B,2026-08-01T20:12:42.000019,15.59139723,.0006193,53.1482," +
    "209.0596,11.4990,228.7997,0,C,44714,213,1,.87542E-3,.70034E-3,0,0.206,SpaceX-E";
const TLE_44714 =
    "STARLINK-1008           \n" +
    "1 44714C 19074B   26213.84215278  .00070034  00000+0  87542-3 0  2133\n" +
    "2 44714  53.1482 209.0596 0006193  11.4990 228.7997 15.59139723    19";

// 6- and 9-digit catalog numbers — impossible in any TLE file.
const CSV_100001 =
    "STARLINK-38128,2026-160A,2026-08-01T21:58:42.000010,15.78550636,.0003536,69.9997," +
    "335.2935,278.4489,188.6863,0,C,100001,213,1,-.39129E-3,-.68108E-3,0,0.360,SpaceX-E";
const CSV_799501282 =
    "STARLINK-38095,2026-175A,2026-08-01T21:58:42.000010,16.04093186,.0009333,97.2856," +
    "53.6278,245.3456,89.2514,0,C,799501282,213,1,.85444E-3,.56113E-2,0,0.196,SpaceX-E";

console.log("== OMM CSV: parsing ==");

const csvSats = engine.parseTLE(`${CSV_HEADER}\n${CSV_44714}\n${CSV_100001}\n${CSV_799501282}\n`);
ok("parsed all three OMM CSV records", csvSats.length === 3, `n=${csvSats.length}`);
ok("names come from OBJECT_NAME", csvSats[0].name === "STARLINK-1008", csvSats[0].name);
ok("6-digit catalog number survives",
    csvSats.some((s) => s.noradId === 100001));
ok("9-digit catalog number survives",
    csvSats.some((s) => s.noradId === 799501282));
ok("no NaN elements", csvSats.every((s) => Number.isFinite(s.satrec.no)));
ok("no satrec errors", csvSats.every((s) => s.satrec.error === 0));

console.log("== OMM CSV: still parses legacy TLE ==");

const tleSats = engine.parseTLE(TLE_44714);
ok("legacy 3LE still parses", tleSats.length === 1, `n=${tleSats.length}`);
ok("legacy name is trimmed", tleSats[0].name === "STARLINK-1008", `"${tleSats[0].name}"`);

console.log("== OMM CSV: agrees with TLE on propagated position ==");

const when = new Date(Date.UTC(2026, 7, 2, 0, 0, 0));
const a = satellite.propagate(csvSats[0].satrec, when);
const b = satellite.propagate(tleSats[0].satrec, when);
ok("both records propagate", !!(a && a.position && b && b.position));
if (a && a.position && b && b.position) {
    // km. They differ only by the epoch rounding the TLE format forces
    // (~1 ms, i.e. metres of along-track travel).
    const dist = Math.hypot(
        a.position.x - b.position.x,
        a.position.y - b.position.y,
        a.position.z - b.position.z);
    ok("CSV and TLE agree within 100 m", dist < 0.1, `${(dist * 1000).toFixed(1)} m`);
}

console.log("== OMM CSV: mixed-format files (Sitrec exports these) ==");

// Sitrec's "export TLE" writes whatever is loaded, and merging an imported
// .tle into a downloaded CSV catalogue produces a file holding both formats.
// Sniffing only the first line would drop one block on the floor.
const MIXED_TLE_FIRST = `${TLE_44714}\n${CSV_HEADER}\n${CSV_100001}\n${CSV_799501282}\n`;
const MIXED_CSV_FIRST = `${CSV_HEADER}\n${CSV_100001}\n${CSV_799501282}\n${TLE_44714}\n`;

for (const [label, text] of [["TLE first", MIXED_TLE_FIRST], ["CSV first", MIXED_CSV_FIRST]]) {
    const sats = engine.parseTLE(text);
    ok(`${label}: all three records parsed`, sats.length === 3, `n=${sats.length}`);
    ok(`${label}: the TLE record survived`, sats.some((s) => s.noradId === 44714));
    ok(`${label}: the 6-digit CSV record survived`, sats.some((s) => s.noradId === 100001));
    ok(`${label}: the 9-digit CSV record survived`, sats.some((s) => s.noradId === 799501282));
    ok(`${label}: no NaN elements`, sats.every((s) => Number.isFinite(s.satrec.no)));
}

console.log("== OMM CSV: malformed input ==");

ok("a repeated header row does not become a NaN satellite",
    engine.parseTLE(`${CSV_HEADER}\n${CSV_44714}\n${CSV_HEADER}\n${CSV_100001}\n`).length === 2);
ok("truncated rows are skipped",
    engine.parseTLE(`${CSV_HEADER}\n${CSV_44714}\nSTARLINK-BAD,2026-160A\n`).length === 1);
ok("CSV without the required OMM columns yields nothing",
    engine.parseTLE("NORAD_CAT_ID,SOMETHING\n44714,3\n").length === 0);

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
