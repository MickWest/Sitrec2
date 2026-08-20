/**
 * Plan-view summarisation for the Track Browser — src/TrackFiles/TrackFileProbe.js
 *
 * The CSV is synthesised inline for the same reason BOTInterchangeImport.test.js
 * does it: benchmarks/botbench/results is generated output and gitignored, so a
 * test that read a real results folder would pass locally and fail in CI.
 *
 * What is actually being checked is that a browsable summary preserves the
 * GEOMETRY the thumbnail is meant to show — relative positions in metres, which
 * track is the platform and which is the answer key — after a round trip through
 * the importer's ENU -> lat/lon and back out to the local frame.
 */

import {CTrackFileBOT} from "../src/TrackFiles/CTrackFileBOT";
import {summarizeTrackFile, trackFileTrackCount} from "../src/TrackFiles/TrackFileProbe";
import {MISB} from "../src/MISBFields";

// ENU metres, the frame the interchange format states positions in (x east,
// y north, z up):
//   sensor 5 km due SOUTH of the origin at 3000 m, tracking 1000 m EAST
//   truth at the origin at 500 m, drifting 200 m NORTH
// So in the summary's local frame — centred on the sensor's first fix — the
// sensor runs +1000 m in x and the truth sits +5000 m in y.
const STEPS = 11;
const SENSOR_START = [0, -5000, 3000];
const SENSOR_EAST = 1000;
const TRUTH_START = [0, 0, 500];
const TRUTH_NORTH = 200;

const ALL_HEADER = "TrackID,TrackSource,Time,SensorPositionX,SensorPositionY,SensorPositionZ,"
    + "LOSUnitVectorX,LOSUnitVectorY,LOSUnitVectorZ,MaxRange,LOSUncertainty,"
    + "TruePositionX,TruePositionY,TruePositionZ";

function buildAllCSV() {
    const lines = [ALL_HEADER];
    for (let i = 0; i < STEPS; i++) {
        const f = i / (STEPS - 1);
        const sensor = [SENSOR_START[0] + SENSOR_EAST * f, SENSOR_START[1], SENSOR_START[2]];
        const truth = [TRUTH_START[0], TRUTH_START[1] + TRUTH_NORTH * f, TRUTH_START[2]];
        const d = [truth[0] - sensor[0], truth[1] - sensor[1], truth[2] - sensor[2]];
        const n = Math.hypot(...d);
        const los = d.map((c) => c / n);
        lines.push(`scenario-1,test,${i},${sensor.join(",")},${los.join(",")},,0,${truth.join(",")}`);
    }
    return lines.join("\n");
}

// csv.toArrays() output: a 2-D array of strings, row 0 = headers.
function rows(text) {
    return text.split("\n").map((line) => line.split(","));
}

describe("summarizeTrackFile", () => {
    const trackFile = new CTrackFileBOT(rows(buildAllCSV()));
    const summary = summarizeTrackFile(trackFile, "scenario-1.all.csv");

    test("an All-shape BOT file counts as multi-track", () => {
        // getTrackCount, not getImportTrackCount — the browser lists a file that
        // yields two DRAWABLE tracks, and BOT reports one importable unit.
        expect(trackFileTrackCount(trackFile)).toBe(2);
        expect(trackFile.getImportTrackCount()).toBe(1);
        expect(summary.trackCount).toBe(2);
    });

    test("the sensor is the platform and the truth is the answer key", () => {
        const [sensor, truth] = summary.tracks;
        expect(sensor.role).toBe("camera");
        expect(sensor.isTruth).toBe(false);
        expect(truth.isTruth).toBe(true);
    });

    test("local metres reproduce the ENU geometry the file states", () => {
        const [sensor, truth] = summary.tracks;

        // Sensor: starts at the local origin, ends 1000 m east of it.
        expect(sensor.xy[0]).toBeCloseTo(0, 3);
        expect(sensor.xy[1]).toBeCloseTo(0, 3);
        expect(sensor.xy[sensor.xy.length - 2]).toBeCloseTo(SENSOR_EAST, -1);
        expect(sensor.xy[sensor.xy.length - 1]).toBeCloseTo(0, -1);

        // Truth: 5 km north of the sensor's start, drifting a further 200 m north.
        expect(truth.xy[0]).toBeCloseTo(0, -1);
        expect(truth.xy[1]).toBeCloseTo(5000, -1);
        expect(truth.xy[truth.xy.length - 1]).toBeCloseTo(5000 + TRUTH_NORTH, -1);
    });

    test("extent spans both tracks, so a true-geometry fit shows the standoff", () => {
        expect(summary.spanM).toBeCloseTo(5000 + TRUTH_NORTH, -2);
    });

    test("altitudes come through per track, above the scenario ground elevation", () => {
        const [sensor, truth] = summary.tracks;
        expect(sensor.altMinM).toBeGreaterThan(3000);
        expect(sensor.altMinM).toBeLessThan(3050);
        expect(truth.altMinM).toBeGreaterThan(500);
        expect(truth.altMinM).toBeLessThan(550);
    });

    test("a single-track file is not listed as multi-track", () => {
        const truthOnly = "TrackID,Time,TruePositionX,TruePositionY,TruePositionZ\n"
            + "scenario-1,0,0,0,500\nscenario-1,1,0,100,500\nscenario-1,2,0,200,500";
        expect(trackFileTrackCount(new CTrackFileBOT(rows(truthOnly)))).toBe(1);
    });
});

/**
 * An ARCHIVE probes to several track files, because importing one parses every
 * entry it holds (see probeKMZ). Two single-track members must therefore count
 * and summarise as one two-track thing — otherwise the browser hides a file that
 * Import would happily load as two tracks.
 */
describe("a probe result holding several track files", () => {
    const truthOnly = (id, y0) => "TrackID,Time,TruePositionX,TruePositionY,TruePositionZ\n"
        + `${id},0,0,${y0},500\n${id},1,0,${y0 + 100},500\n${id},2,0,${y0 + 200},500`;
    const memberA = new CTrackFileBOT(rows(truthOnly("a", 0)));
    const memberB = new CTrackFileBOT(rows(truthOnly("b", 1000)));

    test("each member alone is single-track", () => {
        expect(trackFileTrackCount(memberA)).toBe(1);
        expect(trackFileTrackCount(memberB)).toBe(1);
    });

    test("together they count as multi-track", () => {
        expect(trackFileTrackCount([memberA, memberB])).toBe(2);
    });

    test("both members are summarised into one shared local frame", () => {
        const summary = summarizeTrackFile([memberA, memberB], "pair.kmz");
        expect(summary.trackCount).toBe(2);
        // Member B starts 1000 m north of member A, and the frame is centred on
        // A's first fix — so the offset has to survive into the drawn points.
        expect(summary.tracks[0].xy[1]).toBeCloseTo(0, -1);
        expect(summary.tracks[1].xy[1]).toBeCloseTo(1000, -1);
        expect(summary.spanM).toBeCloseTo(1200, -2);
    });

    test("flattened indices stay distinct across member files", () => {
        const summary = summarizeTrackFile([memberA, memberB], "pair.kmz");
        // Both are index 0 within their own file; the browser colors roleless
        // tracks by this index, so a collision would draw them identically.
        expect(summary.tracks.map(t => t.index)).toEqual([0, 1]);
    });
});

/**
 * A track crossing the ANTIMERIDIAN.
 *
 * The plan-view projection differences longitudes, and 179.99 -> -179.99 is a
 * two-kilometre step that a plain subtraction reads as -359.98 degrees — about
 * 40,000 km. One such sample sets the whole summary's extent, so an ordinary
 * Pacific track drew as a line across the entire plot.
 *
 * BOT positions are local metres about a stated origin, so the crossing is built
 * by moving the ORIGIN onto the dateline and letting the importer place the
 * points either side of it.
 */
describe("a track crossing the antimeridian", () => {
    const DATELINE = {latDeg: 0, lonDeg: 179.99, groundElevationMSL: 0};

    // +/- 1000 m east of an origin 1.1 km west of the dateline, so the track
    // starts at about 179.99 E and ends across it at about 180.01 E = 179.99 W.
    const HEADER = "TrackID,Time,TruePositionX,TruePositionY,TruePositionZ";
    const csv = [HEADER];
    for (let i = 0; i <= 10; i++) csv.push(`cross,${i},${i * 220},0,500`);
    const sensorHeader = "TrackID,TrackSource,Time,SensorPositionX,SensorPositionY,SensorPositionZ,"
        + "LOSUnitVectorX,LOSUnitVectorY,LOSUnitVectorZ,MaxRange,LOSUncertainty,"
        + "TruePositionX,TruePositionY,TruePositionZ";
    const both = [sensorHeader];
    for (let i = 0; i <= 10; i++) {
        both.push(`cross,test,${i},${i * 220},-2000,300,0,1,0,,0,${i * 220},0,500`);
    }

    test("spans the real distance, not the width of the world", () => {
        const trackFile = new CTrackFileBOT(rows(both.join("\n")), DATELINE);
        const summary = summarizeTrackFile(trackFile, "cross.all.csv");
        // 2200 m of easting and a 2 km sensor offset — a few km, not 40,000.
        expect(summary.spanM).toBeLessThan(10000);
        expect(summary.spanM).toBeGreaterThan(1000);
    });

    test("the crossing itself is continuous", () => {
        const trackFile = new CTrackFileBOT(rows(both.join("\n")), DATELINE);
        const summary = summarizeTrackFile(trackFile, "cross.all.csv");
        // No consecutive pair may jump further than the whole track is long.
        for (const track of summary.tracks) {
            for (let i = 2; i < track.xy.length; i += 2) {
                const step = Math.hypot(track.xy[i] - track.xy[i - 2], track.xy[i + 1] - track.xy[i - 1]);
                expect(step).toBeLessThan(1000);
            }
        }
    });

    test("longitudes really do straddle the dateline", () => {
        // Guards the test itself: if the fixture stopped crossing, the two checks
        // above would pass for the wrong reason.
        const trackFile = new CTrackFileBOT(rows(both.join("\n")), DATELINE);
        const misb = trackFile.toMISB(0);
        const lons = misb.map(r => r[MISB.SensorLongitude]);
        const signs = new Set(lons.filter(Number.isFinite).map(l => Math.sign(l)));
        expect(signs.size).toBe(2);
    });
});
