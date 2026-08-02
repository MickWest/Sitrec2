// CTLEData format handling: legacy TLE/3LE and OMM CSV.
//
// The TLE format cannot express catalog numbers above 99999, and the catalog
// passed that limit on 2026-07-11. CelesTrak and Space-Track omit those objects
// from TLE feeds entirely, so Sitrec reads OMM CSV to see them. These fixtures
// are real records taken from the CelesTrak Starlink supplemental feed.

import { strict as assert } from "assert";
import * as satellite from "satellite.js";
import { CTLEData } from "../src/TLEUtils";

const CSV_HEADER =
    "OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE," +
    "ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID," +
    "ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT,RMS,DATA_SOURCE";

// STARLINK-1008, 5-digit catalog number — expressible in both formats, so we can
// check the two parsers against each other.
const CSV_44714 =
    "STARLINK-1008,2019-074B,2026-08-01T20:12:42.000019,15.59139723,.0006193,53.1482," +
    "209.0596,11.4990,228.7997,0,C,44714,213,1,.87542E-3,.70034E-3,0,0.206,SpaceX-E";

const TLE_44714 =
    "STARLINK-1008           \n" +
    "1 44714C 19074B   26213.84215278  .00070034  00000+0  87542-3 0  2133\n" +
    "2 44714  53.1482 209.0596 0006193  11.4990 228.7997 15.59139723    19";

// 6-digit catalog number — cannot appear in any TLE file.
const CSV_100001 =
    "STARLINK-38128,2026-160A,2026-08-01T21:58:42.000010,15.78550636,.0003536,69.9997," +
    "335.2935,278.4489,188.6863,0,C,100001,213,1,-.39129E-3,-.68108E-3,0,0.360,SpaceX-E";

// 9-digit catalog number — the range Space-Track has reserved for the expanded
// catalog. Indexing a plain JS array here would give it a length of ~8e8.
const CSV_799501282 =
    "STARLINK-38095,2026-175A,2026-08-01T21:58:42.000010,16.04093186,.0009333,97.2856," +
    "53.6278,245.3456,89.2514,0,C,799501282,213,1,.85444E-3,.56113E-2,0,0.196,SpaceX-E";

describe("CTLEData — OMM CSV", () => {

    it("parses an OMM CSV file and reports the format", () => {
        const d = new CTLEData(`${CSV_HEADER}\n${CSV_44714}\n`);
        assert.equal(d.format, "omm-csv");
        assert.equal(d.loadError, undefined);
        assert.equal(d.satData.length, 1);
        assert.equal(d.satData[0].name, "STARLINK-1008");
        assert.equal(d.satData[0].number, 44714);
    });

    it("still parses legacy 3LE and reports the format", () => {
        const d = new CTLEData(TLE_44714);
        assert.equal(d.format, "tle");
        assert.equal(d.satData.length, 1);
        assert.equal(d.satData[0].name, "STARLINK-1008");
        assert.equal(d.satData[0].number, 44714);
    });

    it("agrees with the TLE parser on propagated position", () => {
        const fromCSV = new CTLEData(`${CSV_HEADER}\n${CSV_44714}\n`);
        const fromTLE = new CTLEData(TLE_44714);
        const when = new Date(Date.UTC(2026, 7, 2, 0, 0, 0));

        const a = satellite.propagate(fromCSV.satData[0].satrecs[0], when);
        const b = satellite.propagate(fromTLE.satData[0].satrecs[0], when);
        assert.ok(a && a.position, "CSV record should propagate");
        assert.ok(b && b.position, "TLE record should propagate");

        // Positions are in km. They differ only by the epoch rounding that the
        // TLE format forces (~1 ms, i.e. metres of along-track travel), so a
        // 100 m tolerance is far tighter than any real disagreement.
        const dist = Math.hypot(
            a.position.x - b.position.x,
            a.position.y - b.position.y,
            a.position.z - b.position.z);
        assert.ok(dist < 0.1, `CSV and TLE should agree, differ by ${dist} km`);
    });

    it("loads 6-digit catalog numbers, which no TLE file can contain", () => {
        const d = new CTLEData(`${CSV_HEADER}\n${CSV_100001}\n`);
        assert.equal(d.satData.length, 1);
        assert.equal(d.satData[0].number, 100001);
        assert.equal(d.getRecordFromNORAD(100001).name, "STARLINK-38128");
    });

    it("loads 9-digit catalog numbers without an oversized index", () => {
        const d = new CTLEData(`${CSV_HEADER}\n${CSV_799501282}\n`);
        assert.equal(d.satData[0].number, 799501282);
        assert.equal(d.getRecordFromNORAD(799501282).name, "STARLINK-38095");
        // A Map keeps the index proportional to the satellite count. The old
        // sparse-array index would have reported a length of 799501283 here.
        assert.ok(d.noradIndex instanceof Map);
        assert.equal(d.noradIndex.size, 1);
    });

    it("resolves names and numbers for high catalog numbers", () => {
        const d = new CTLEData(`${CSV_HEADER}\n${CSV_100001}\n${CSV_799501282}\n`);
        assert.equal(d.satData.length, 2);
        assert.equal(d.getNORAD("STARLINK-38095"), 799501282);
        assert.equal(d.getNORAD(100001), 100001);
        assert.equal(d.getRecordFromName("STARLINK-38128").number, 100001);
        assert.deepEqual(d.getMatchingRecords("STARLINK-380").sort(), [799501282]);
    });

    it("derives the epoch range from the OMM EPOCH column", () => {
        const d = new CTLEData(`${CSV_HEADER}\n${CSV_44714}\n${CSV_100001}\n`);
        assert.equal(d.startDate.toISOString(), "2026-08-01T20:12:42.000Z");
        assert.equal(d.endDate.toISOString(), "2026-08-01T21:58:42.000Z");
    });

    it("merges CSV data into TLE data by catalog number", () => {
        const d = new CTLEData(TLE_44714);
        d.mergeFrom(new CTLEData(`${CSV_HEADER}\n${CSV_44714}\n${CSV_100001}\n`));
        // 44714 already existed, so it gains a second satrec rather than a row.
        assert.equal(d.satData.length, 2);
        assert.equal(d.getRecordFromNORAD(44714).satrecs.length, 2);
        assert.equal(d.getRecordFromNORAD(100001).satrecs.length, 1);
    });

    it("skips truncated rows rather than inventing satellites", () => {
        const d = new CTLEData(`${CSV_HEADER}\n${CSV_44714}\nSTARLINK-BAD,2026-160A\n`);
        assert.equal(d.satData.length, 1);
        assert.equal(d.satData[0].number, 44714);
    });

    it("merges two CSV sets into a single re-parseable CSV", () => {
        const a = new CTLEData(`${CSV_HEADER}\n${CSV_44714}\n`);
        a.mergeFrom(new CTLEData(`${CSV_HEADER}\n${CSV_100001}\n`));
        assert.equal(a.satData.length, 2);

        // The export is a.rawText, so it has to survive a round trip. Before
        // the header of the second file was stripped, that header came back as
        // a satellite with NaN elements.
        const reloaded = new CTLEData(a.rawText);
        assert.equal(reloaded.format, "omm-csv");
        assert.equal(reloaded.satData.length, 2);
        assert.ok(reloaded.getRecordFromNORAD(44714));
        assert.ok(reloaded.getRecordFromNORAD(100001));
    });

    it("ignores a stray repeated header row rather than making a NaN satellite", () => {
        const d = new CTLEData(`${CSV_HEADER}\n${CSV_44714}\n${CSV_HEADER}\n${CSV_100001}\n`);
        assert.equal(d.satData.length, 2);
        for (const sat of d.satData) {
            assert.ok(Number.isFinite(sat.number), `bad catalog number ${sat.number}`);
            assert.ok(Number.isFinite(sat.satrecs[0].no), "mean motion should not be NaN");
        }
    });

    // A user can merge an imported .tle into a downloaded CSV catalogue (or the
    // reverse), and mergeFrom concatenates the raw text it exports. If the
    // parser sniffed only the first line, one block would go to the wrong
    // parser and those satellites would be corrupted or silently dropped on
    // reload — the user would lose data they had merged.
    describe("mixed-format files round-trip", () => {

        it("parses a TLE block followed by a CSV block", () => {
            const d = new CTLEData(`${TLE_44714}\n${CSV_HEADER}\n${CSV_100001}\n`);
            assert.equal(d.format, "mixed");
            assert.equal(d.satData.length, 2);
            assert.equal(d.getRecordFromNORAD(44714).name, "STARLINK-1008");
            assert.equal(d.getRecordFromNORAD(100001).name, "STARLINK-38128");
        });

        it("parses a CSV block followed by a TLE block", () => {
            const d = new CTLEData(`${CSV_HEADER}\n${CSV_100001}\n${TLE_44714}\n`);
            assert.equal(d.format, "mixed");
            assert.equal(d.satData.length, 2);
            assert.equal(d.getRecordFromNORAD(44714).name, "STARLINK-1008");
            assert.equal(d.getRecordFromNORAD(100001).name, "STARLINK-38128");
        });

        it("survives merge -> export -> reload with CSV merged into TLE", () => {
            const d = new CTLEData(TLE_44714);
            d.mergeFrom(new CTLEData(`${CSV_HEADER}\n${CSV_100001}\n${CSV_799501282}\n`));
            assert.equal(d.satData.length, 3);

            const reloaded = new CTLEData(d.rawText);   // d.rawText is the export
            assert.equal(reloaded.satData.length, 3, "no satellite may be lost on reload");
            assert.ok(reloaded.getRecordFromNORAD(44714), "TLE record survived");
            assert.ok(reloaded.getRecordFromNORAD(100001), "6-digit CSV record survived");
            assert.ok(reloaded.getRecordFromNORAD(799501282), "9-digit CSV record survived");
            for (const sat of reloaded.satData) {
                assert.ok(Number.isFinite(sat.satrecs[0].no), `${sat.number} has NaN mean motion`);
                assert.equal(sat.satrecs[0].error, 0, `${sat.number} failed SGP4 init`);
            }
        });

        it("survives merge -> export -> reload with TLE merged into CSV", () => {
            const d = new CTLEData(`${CSV_HEADER}\n${CSV_100001}\n${CSV_799501282}\n`);
            d.mergeFrom(new CTLEData(TLE_44714));
            assert.equal(d.satData.length, 3);

            const reloaded = new CTLEData(d.rawText);
            assert.equal(reloaded.satData.length, 3, "no satellite may be lost on reload");
            assert.ok(reloaded.getRecordFromNORAD(44714), "TLE record survived");
            assert.ok(reloaded.getRecordFromNORAD(799501282), "9-digit CSV record survived");
            for (const sat of reloaded.satData) {
                assert.ok(Number.isFinite(sat.satrecs[0].no), `${sat.number} has NaN mean motion`);
            }
        });

        it("reloads a mixed file identically to the merged original", () => {
            const d = new CTLEData(TLE_44714);
            d.mergeFrom(new CTLEData(`${CSV_HEADER}\n${CSV_100001}\n`));
            const reloaded = new CTLEData(d.rawText);
            // Same satellites, and the propagated states match, so the export is
            // genuinely lossless rather than merely the right record count.
            const before = d.satData.map(s => s.number).sort((a, b) => a - b);
            const after = reloaded.satData.map(s => s.number).sort((a, b) => a - b);
            assert.deepEqual(after, before);
            for (const num of before) {
                assert.equal(reloaded.getRecordFromNORAD(num).satrecs[0].no,
                    d.getRecordFromNORAD(num).satrecs[0].no, `mean motion differs for ${num}`);
            }
        });

        it("keeps a blank line between blocks from breaking 3LE detection", () => {
            const d = new CTLEData(`${CSV_HEADER}\n${CSV_100001}\n\n\n${TLE_44714}\n`);
            assert.equal(d.satData.length, 2);
            // Misread as 2LE, the name would be lost and the number wrong.
            assert.equal(d.getRecordFromNORAD(44714).name, "STARLINK-1008");
        });
    });

    it("reports an error for CSV without the required OMM columns", () => {
        // Has NORAD_CAT_ID so it sniffs as OMM, but no EPOCH to propagate from.
        const d = new CTLEData("NORAD_CAT_ID,SOMETHING\n44714,3\n");
        assert.equal(d.format, "omm-csv");
        assert.equal(d.satData.length, 0);
        assert.ok(d.loadError);
    });
});
