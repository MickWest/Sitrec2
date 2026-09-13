// CTLEData reading a TLE file whose lines are not on the fixed TLE columns.
//
// Some programs write an element set with single spaces between fields and the
// optional international designator left out, so line 1 has one field fewer than
// the fixed layout. The fixed-column reader cannot place those fields: a file like
// that used to raise two "TLE field N is too long" dialogs and then throw, and no
// satellite loaded. CTLEData now reads such a block field by field, with the same
// reader the paste path uses (TLEGrammar.js).

import { strict as assert } from "assert";
import * as satellite from "satellite.js";

jest.mock("../src/showError", () => ({ showError: jest.fn(), showErrorOnce: jest.fn() }));

import { showError } from "../src/showError";
import { CTLEData } from "../src/TLEUtils";
import { parsePastedTLE } from "../src/TLEGrammar";

// A geostationary-belt rocket body, exactly as the program that wrote it laid it
// out, CRLF line endings included.
const UNALIGNED_23683 =
    "SL-12 RB(2)\r\n" +
    "1 23683U 26241.89445221 +.00000000 +00000-0 +00000-0 0 00005\r\n" +
    "2 23683 15.0066 358.4720 0018278 105.8450 247.5853 1.00173623 07\r\n";

// A correctly formatted TLE, on the fixed columns (CelesTrak Starlink feed).
const ALIGNED_44714 =
    "STARLINK-1008           \n" +
    "1 44714C 19074B   26213.84215278  .00070034  00000+0  87542-3 0  2133\n" +
    "2 44714  53.1482 209.0596 0006193  11.4990 228.7997 15.59139723    19";

const ORBIT_FIELDS = ["epochyr", "epochdays", "inclo", "nodeo", "ecco", "argpo", "mo", "no", "bstar"];

function assertSameOrbit(actual, expected) {
    for (const field of ORBIT_FIELDS) {
        assert.equal(actual[field], expected[field], field);
    }
}

describe("CTLEData — TLE lines off the fixed columns", () => {

    beforeEach(() => showError.mockClear());

    it("reads a 3LE written without its international designator", () => {
        const d = new CTLEData(UNALIGNED_23683);
        assert.equal(d.loadError, undefined);
        assert.equal(d.satData.length, 1);

        const sat = d.satData[0];
        assert.equal(sat.name, "SL-12 RB(2)");
        assert.equal(sat.number, 23683);

        const satrec = sat.satrecs[0];
        assert.equal(satrec.error, 0);
        assert.equal(satrec.epochyr, 26);
        assert.equal(satrec.epochdays, 241.89445221);

        // About 42,200 km from Earth's centre: the geostationary belt.
        const r = satellite.propagate(satrec, new Date("2026-09-12T21:59:31Z")).position;
        const km = Math.hypot(r.x, r.y, r.z);
        assert.ok(km > 42000 && km < 42400, `distance ${km} km`);

        expect(showError).not.toHaveBeenCalled();
    });

    it("reads the same orbit as the paste path", () => {
        const d = new CTLEData(UNALIGNED_23683);
        const pasted = parsePastedTLE(UNALIGNED_23683).records[0];
        assertSameOrbit(d.satData[0].satrecs[0], satellite.twoline2satrec(pasted.line1, pasted.line2));
    });

    it("reads a 2LE (no name line) written without its designator", () => {
        const twoLine = UNALIGNED_23683.split("\r\n").slice(1).join("\r\n");
        const d = new CTLEData(twoLine);
        assert.equal(d.loadError, undefined);
        assert.equal(d.satData.length, 1);
        assert.equal(d.satData[0].number, 23683);
        assert.equal(d.satData[0].satrecs[0].error, 0);
        expect(showError).not.toHaveBeenCalled();
    });

    it("still reads a well-formed TLE by its columns", () => {
        const d = new CTLEData(ALIGNED_44714);
        const [, line1, line2] = ALIGNED_44714.split("\n");
        assert.equal(d.satData[0].name, "STARLINK-1008");
        assertSameOrbit(d.satData[0].satrecs[0], satellite.twoline2satrec(line1, line2));
    });

    it("reads every record of a block that mixes aligned and unaligned ones", () => {
        const d = new CTLEData(ALIGNED_44714 + "\n" + UNALIGNED_23683);
        assert.equal(d.satData.length, 2);

        const byNumber = new Map(d.satData.map(sat => [sat.number, sat]));
        assert.equal(byNumber.get(44714).name, "STARLINK-1008");
        assert.equal(byNumber.get(23683).name, "SL-12 RB(2)");

        const [, line1, line2] = ALIGNED_44714.split("\n");
        assertSameOrbit(byNumber.get(44714).satrecs[0], satellite.twoline2satrec(line1, line2));
        assert.equal(byNumber.get(23683).satrecs[0].error, 0);
    });

    it("reports an element set it cannot read once, without throwing", () => {
        const broken =
            "SL-12 RB(2)\n" +
            "1 23683U NOEPOCH +.00000000 +00000-0 +00000-0 0 00005\n" +
            "2 23683 15.0066 358.4720 0018278 105.8450 247.5853 1.00173623 07\n";
        const d = new CTLEData(broken);
        assert.equal(d.satData.length, 0);
        assert.match(d.loadError, /^Could not read the TLE data: no epoch found/);
        expect(showError).toHaveBeenCalledTimes(1);
    });
});
