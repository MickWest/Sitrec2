/**
 * @jest-environment jsdom
 */
/**
 * The STANAG 4676 XML container, which reaches BOTBench through the same
 * CTrackFileSTANAGBase the CSV flavour uses — so the two must produce the
 * same dataset from the same track. Separate file only because parseXml
 * needs a DOMParser, and the rest of the BOTBench suite runs under node.
 */
import {ingestGenericTrackCSV, ingestSTANAGXML}
    from "../../src/analysis/BotBenchIngest";
import {setSit} from "../../src/Globals";

const readFixture = (name) => require("fs").readFileSync(
    require("path").resolve(__dirname, "../../data/test/", name), "utf8");

beforeAll(() => {
    setSit({name: "botbench", frames: 10000, fps: 10, simSpeed: 1, lat: 40.4, lon: -104.9});
});

test("the STANAG XML flavour ingests identically to its CSV flavour", () => {
    const fromXML = ingestSTANAGXML(readFixture("elevated_track.xml"),
        {label: "elevated_track.xml", geoid: false});
    const fromCSV = ingestGenericTrackCSV(readFixture("elevated_track.csv"),
        {label: "elevated_track.csv", geoid: false});
    expect(fromXML.meta.sourceFormat).toBe("STANAG_XML");
    expect(fromCSV.meta.sourceFormat).toBe("STANAG_CSV");
    expect(fromXML.dataset.n).toBe(fromCSV.dataset.n);
    // Same track, same frame origin, so the sightlines must agree — the two
    // containers differ only in how the numbers are spelled.
    for (let i = 0; i < fromCSV.dataset.n * 3; i++) {
        expect(fromXML.dataset.D[i]).toBeCloseTo(fromCSV.dataset.D[i], 6);
    }
});

test("XML that is not a STANAG track message refuses saying so", () => {
    expect(() => ingestSTANAGXML("<foo><bar>1</bar></foo>", {label: "x.xml", geoid: false}))
        .toThrow(/STANAG 4676/);
});

// THE DATUM IS A PROPERTY OF THE FILE, NOT OF THE FORMAT. STANAG heights are
// ellipsoidal by the 4676 default, but <dynamics cs="..."> can name an
// orthometric one (EGM/MSL/NAVD), and isAltitudeHAE() already reads it.
// toSightlineMISB() must pick its altitude TAGS from that answer: the tag is
// how a consumer is told whether to add the geoid offset, so writing an
// orthometric height into the ellipsoid tag makes the conversion get skipped
// and puts the sensor out by N — up to ~100 m, and invisible, because both
// ends of the ray move together and the direction barely changes.
test("an orthometric cs sends the heights to the MSL tags, not the HAE ones", () => {
    const {CTrackFileSTANAG} = require("../../src/TrackFiles/CTrackFileSTANAG");
    const {parseXml} = require("../../src/parseXml");
    const {MISB} = require("../../src/MISBFields");
    const wgs84 = readFixture("elevated_track.xml");
    const egm96 = wgs84.replace(/cs="WGS_84"/g, 'cs="WGS84_EGM96"');

    const hae = new CTrackFileSTANAG(parseXml(wgs84)).toSightlineMISB();
    expect(hae[0][MISB.SensorEllipsoidHeight]).not.toBeNull();
    expect(hae[0][MISB.SensorTrueAltitude]).toBeNull();
    expect(hae[0][MISB.FrameCenterHeightAboveEllipsoid]).not.toBeNull();
    expect(hae[0][MISB.FrameCenterElevation]).toBeNull();

    const msl = new CTrackFileSTANAG(parseXml(egm96));
    expect(msl.isAltitudeHAE(0)).toBe(false);        // the premise of this test
    const rows = msl.toSightlineMISB();
    expect(rows[0][MISB.SensorTrueAltitude]).toBe(hae[0][MISB.SensorEllipsoidHeight]);
    expect(rows[0][MISB.SensorEllipsoidHeight]).toBeNull();
    expect(rows[0][MISB.FrameCenterElevation])
        .toBe(hae[0][MISB.FrameCenterHeightAboveEllipsoid]);
    expect(rows[0][MISB.FrameCenterHeightAboveEllipsoid]).toBeNull();
});
