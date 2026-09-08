// Pasted-TLE parsing: the whitespace robustness that lets a TLE be pasted into
// the Go To box (a single-line input, so newlines arrive as spaces) or dropped
// in as text out of a forum post.
//
// The parser reads no columns at all — it matches tokens against the TLE field
// grammar and rebuilds canonical 69-character lines — so the test that matters
// most is that a real, correctly formatted TLE comes back byte-identical however
// its whitespace was mangled on the way in.

import { strict as assert } from "assert";
import * as satellite from "satellite.js";
import { parsePastedTLE, tleChecksum } from "../src/TLEPaste";

// A real Starlink TLE, correctly formatted, checksums valid.
const NAME_44713 = "STARLINK-1007";
const L1_44713 = "1 44713U 19074A   23216.03168702  .00031895  00000-0  21481-2 0  9995";
const L2_44713 = "2 44713  53.0546 125.3135 0001151  98.9698 261.1421 15.06441263205939";
const TLE_44713 = `${NAME_44713}\n${L1_44713}\n${L2_44713}`;

// A hand-made TLE for a satellite that does not exist: catalog number 00000,
// zero drag, and a zero-padded (rather than space-padded) argument of perigee
// and mean anomaly. Both spellings are legal.
const TLE_SYNTHETIC =
    "STARLINK GROUP 17-35\n" +
    "1 00000U 26001A   26097.12475694 -.00000000  00000-0 -00000-0 0    17\n" +
    "2 00000  96.4079 293.8508 0064598 094.4955 064.2540 16.19406394    04";

const ok = (result) => {
    assert.notEqual(result, null, "expected TLE text to be recognised");
    assert.equal(result.error, undefined, `unexpected parse error: ${result.error}`);
    return result;
};

describe("parsePastedTLE — whitespace", () => {

    it("round-trips a correctly formatted TLE byte for byte", () => {
        const r = ok(parsePastedTLE(TLE_44713));
        assert.equal(r.records.length, 1);
        assert.equal(r.records[0].name, NAME_44713);
        assert.equal(r.records[0].line1, L1_44713);
        assert.equal(r.records[0].line2, L2_44713);
    });

    it("ignores indentation, tabs, blank lines, CRLF and trailing spaces", () => {
        const mangled =
            "\r\n" +
            "\t   STARLINK-1007   \r\n" +
            "\r\n" +
            "      1 44713U 19074A   23216.03168702  .00031895  00000-0  21481-2 0  9995   \r\n" +
            "\t2 44713  53.0546 125.3135 0001151  98.9698 261.1421 15.06441263205939\r\n" +
            "\r\n";
        const r = ok(parsePastedTLE(mangled));
        assert.equal(r.records[0].name, NAME_44713);
        assert.equal(r.records[0].line1, L1_44713);
        assert.equal(r.records[0].line2, L2_44713);
    });

    it("reads a TLE whose runs of spaces have been collapsed to one", () => {
        const collapsed = TLE_44713.split("\n").map(l => l.replace(/ +/g, " ")).join("\n");
        const r = ok(parsePastedTLE(collapsed));
        assert.equal(r.records[0].line1, L1_44713);
        assert.equal(r.records[0].line2, L2_44713);
    });

    it("reads a TLE flattened onto one line, as a single-line input gives it", () => {
        // What a browser does with a multi-line paste into <input type=text>.
        const flattened = TLE_44713.replace(/\n/g, " ");
        const r = ok(parsePastedTLE(flattened));
        assert.equal(r.records[0].name, NAME_44713);
        assert.equal(r.records[0].line1, L1_44713);
        assert.equal(r.records[0].line2, L2_44713);
    });

    it("reads a TLE flattened with its newlines removed rather than replaced", () => {
        // What a single-line <input> actually does: its value sanitization
        // algorithm is "strip newlines", so the lines are joined with nothing at
        // all and the name runs into line 1, line 1 into line 2.
        const flattened = TLE_44713.split("\n").map(l => l.trimEnd()).join("");
        const r = ok(parsePastedTLE(flattened));
        assert.equal(r.records[0].name, NAME_44713);
        assert.equal(r.records[0].line1, L1_44713);
        assert.equal(r.records[0].line2, L2_44713);
    });

    it("splits a stripped-newline paste whose name does not end in a digit", () => {
        // The join leaves no token boundary at all, so the split has to be found
        // from what FOLLOWS it. A name ending in a letter or a bracket is the
        // common case — "ISS (ZARYA)1 25544U ..." — and reading the boundary off
        // the name's last character would miss every one of them.
        for (const name of ["ISS (ZARYA)", "STARLINK-1007", "COSMOS 2251 DEB", "TBA"]) {
            const flattened = [name, L1_44713, L2_44713].join("");
            const r = ok(parsePastedTLE(flattened));
            assert.equal(r.records[0].name, name, `name "${name}"`);
            assert.equal(r.records[0].line1, L1_44713, `line 1 after "${name}"`);
            assert.equal(r.records[0].line2, L2_44713, `line 2 after "${name}"`);
        }
    });

    it("leaves text that still has its line breaks exactly as it found it", () => {
        // No pattern can tell a name shaped like an element line start from the
        // real thing, so a text that has already said where its lines are must
        // not have that answer second-guessed. Each of these names would match
        // the repair patterns if they were applied to multi-line text.
        // (A name is rebuilt from its tokens, so a run of spaces inside one
        // collapses to a single space — hence single spaces here.)
        for (const name of ["DELTA-2 12345 R/B", "DELTA-2 12345 51.6 DEG",
                            "MISSION-1 25544U TEST", "COSMOS-2 44713 53.0546"]) {
            const r = ok(parsePastedTLE(`${name}\n${L1_44713}\n${L2_44713}`));
            assert.equal(r.records.length, 1, `name "${name}"`);
            assert.equal(r.records[0].name, name);
            assert.equal(r.records[0].line1, L1_44713);
            assert.equal(r.records[0].line2, L2_44713);
        }
    });

    it("still finds the record when a flattened name is misread as an element line", () => {
        // Flattened, the guess is unavoidable and this name loses it. What must
        // not happen is losing the TLE with it: the tokens that failed to parse
        // as a record become name text, and the scan carries on to the real one.
        const r = ok(parsePastedTLE(["MISSION-1 25544U TEST", L1_44713, L2_44713].join("")));
        assert.equal(r.records.length, 1);
        assert.equal(r.records[0].line1, L1_44713);
        assert.equal(r.records[0].line2, L2_44713);
        assert.ok(r.warning, "expected a warning about the misread name");
    });

    it("reads a space inside the epoch field", () => {
        // The day of year occupies its own columns, so a file that writes it
        // space-padded rather than zero-padded splits the epoch in two.
        const spaced = TLE_44713.replace("23216.03168702", "23 216.03168702");
        const r = ok(parsePastedTLE(spaced));
        assert.equal(r.records[0].line1, L1_44713);
    });
});

describe("parsePastedTLE — content", () => {

    it("parses the pasted elements to the same orbit as the original file", () => {
        const r = ok(parsePastedTLE(TLE_SYNTHETIC));
        const satrec = satellite.twoline2satrec(r.records[0].line1, r.records[0].line2);
        assert.equal(satrec.error, 0);
        assert.equal(satrec.satnum, "00000");
        assert.equal(satrec.epochyr, 26);
        assert.ok(Math.abs(satrec.epochdays - 97.12475694) < 1e-8);
        assert.ok(Math.abs(satrec.ecco - 0.0064598) < 1e-10);
        assert.ok(Math.abs(satrec.inclo * 180 / Math.PI - 96.4079) < 1e-6);
        assert.ok(Math.abs(satrec.nodeo * 180 / Math.PI - 293.8508) < 1e-6);
        assert.ok(Math.abs(satrec.argpo * 180 / Math.PI - 94.4955) < 1e-6);
        assert.ok(Math.abs(satrec.mo * 180 / Math.PI - 64.2540) < 1e-6);
        // The pasted BSTAR is "-00000-0", a signed zero, and stays one.
        assert.ok(Math.abs(satrec.bstar) < 1e-12);
    });

    it("rebuilds every line at exactly 69 characters", () => {
        for (const text of [TLE_44713, TLE_SYNTHETIC]) {
            const r = ok(parsePastedTLE(text));
            assert.equal(r.records[0].line1.length, 69);
            assert.equal(r.records[0].line2.length, 69);
        }
    });

    it("recomputes the checksums, correcting a wrong one", () => {
        // A widely copied fabricated ISS element set; both checksums are wrong.
        const bad =
            "1 25544U 98067A   21274.58668981  .00001303  00000-0  29669-4 0  9991\n" +
            "2 25544  51.6441 179.2338 0008176  49.9505 310.1752 15.48903444320729";
        const r = ok(parsePastedTLE(bad));
        const {line1, line2} = r.records[0];
        assert.equal(line1.slice(-1), "0");
        assert.equal(line2.slice(-1), "5");
        assert.equal(Number(line1.slice(-1)), tleChecksum(line1));
        assert.equal(Number(line2.slice(-1)), tleChecksum(line2));
    });

    it("names a two-line set after its catalog number", () => {
        const r = ok(parsePastedTLE(`${L1_44713}\n${L2_44713}`));
        assert.equal(r.records[0].name, "SAT 44713");
    });

    it("takes the name from the last line before the elements, not the prose above it", () => {
        const r = ok(parsePastedTLE(
            "Here is the element set I was talking about earlier:\n" + TLE_44713));
        assert.equal(r.records[0].name, NAME_44713);
    });

    it("strips the leading '0 ' of a Space-Track style name line", () => {
        const r = ok(parsePastedTLE(`0 ${NAME_44713}\n${L1_44713}\n${L2_44713}`));
        assert.equal(r.records[0].name, NAME_44713);
    });

    it("reads several records, named and unnamed together", () => {
        const r = ok(parsePastedTLE(TLE_44713 + "\n" + L1_44713 + "\n" + L2_44713));
        assert.equal(r.records.length, 2);
        assert.equal(r.records[0].name, NAME_44713);
        assert.equal(r.records[1].name, "SAT 44713");
    });

    it("emits a file of three lines per record, which is what the TLE loader reads", () => {
        const r = ok(parsePastedTLE(TLE_44713));
        assert.equal(r.text, `${NAME_44713}\n${L1_44713}\n${L2_44713}\n`);
    });

    it("converts a hand-written decimal BSTAR to the assumed-decimal form", () => {
        const r = ok(parsePastedTLE(
            "1 44713U 19074A   23216.03168702  .00031895  00000-0 0.0021481 0  9995\n" +
            L2_44713));
        const satrec = satellite.twoline2satrec(r.records[0].line1, r.records[0].line2);
        assert.ok(Math.abs(satrec.bstar - 0.0021481) < 1e-9);
    });
});

describe("parsePastedTLE — rejection", () => {

    it("returns null for text that holds no element lines", () => {
        for (const text of ["", "  ", "38.73,-120.56", "2025-09-15 21:30", "1200",
                            "Los Angeles", "1 2 3 4 5"]) {
            assert.equal(parsePastedTLE(text), null, `should not be TLE: "${text}"`);
        }
    });

    it("does not take a name line that starts with a number for an element line", () => {
        const r = ok(parsePastedTLE(`2 STARLINK SATS\n${L1_44713}\n${L2_44713}`));
        assert.equal(r.records[0].name, "2 STARLINK SATS");
    });

    it("reports a line 1 with no line 2", () => {
        const r = parsePastedTLE(L1_44713);
        assert.ok(r.error, "expected an error");
        assert.match(r.error, /no line 2/);
    });

    it("reports a line 2 with no line 1", () => {
        const r = parsePastedTLE(L2_44713);
        assert.ok(r.error, "expected an error");
        assert.match(r.error, /no line 1/);
    });

    it("reports elements that do not describe a usable orbit", () => {
        // Eccentricity 0.9999999 with this mean motion puts perigee underground.
        const r = parsePastedTLE(`${L1_44713}\n` +
            "2 44713  53.0546 125.3135 9999999  98.9698 261.1421 15.06441263205939");
        assert.ok(r.error, "expected an error");
        assert.match(r.error, /usable orbit/);
    });
});
