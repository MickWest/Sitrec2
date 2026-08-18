/**
 * WHICH GROUND A BULK RUN GRADES AGAINST.
 *
 * A BOTBench run has no terrain, so "does this candidate pass underground" is
 * decided against one flat level plane (flatTerrainProbes in BotBenchRunner,
 * fed by record.groundZ). Sea level is the only plane available with no other
 * information, and inland it is badly wrong — over Cheyenne it sits ~1,867 m
 * below the real surface, which passes buried candidates through the screen and
 * puts the Ground Vehicle / Fixed Point fits a kilometre under the road.
 *
 * An FMV file usually carries the answer already: FrameCenterElevation (ST 0601
 * tag 25) / FrameCenterHeightAboveEllipsoid (tag 78) is the producer's own
 * terrain height where the optical axis meets the earth. These tests pin that
 * it is read, that it is read INDEPENDENTLY of which convention supplied the
 * pointing, and that the cases where it must not be trusted fall back loudly.
 */
import {ingestMISBRecords} from "../../src/analysis/BotBenchIngest";
import {MISB, MISBFields} from "../../src/MISBFields";
import {setSit} from "../../src/Globals";

// Cheyenne, from truck.misb.csv: the file that motivated this. Sensor at
// ~2933 m, frame center on ground at ~1867 m — a plane at sea level is nearly
// two kilometres out.
const SENSOR_LAT = 41.09574;
const SENSOR_LON = -104.87021;
const SENSOR_ALT = 2933;
const GROUND_ALT = 1867;
const START_US = 1348087826484970;

beforeAll(() => {
    setSit({name: "botbench", frames: 10000, fps: 10, simSpeed: 1,
        lat: SENSOR_LAT, lon: SENSOR_LON});
});

/**
 * A clip in truck.ts's shape: gimbal angles AND frame-center columns.
 *
 * @param n            rows
 * @param opts.centers how many rows carry a frame-center elevation (from row 0)
 * @param opts.tag     "elevation" (tag 25, MSL) or "hae" (tag 78)
 * @param opts.angles  false to drop the gimbal/platform angles, leaving the
 *                     frame center as the only pointing there is
 * @param opts.groundAlt height to state for the frame center
 */
function clip(n = 30, {centers = n, tag = "elevation", angles = true,
    groundAlt = GROUND_ALT} = {}) {
    const misb = [];
    for (let i = 0; i < n; i++) {
        const row = new Array(MISBFields).fill(null);
        row[MISB.UnixTimeStamp] = START_US + i * 200000;      // 5 Hz, in µs
        row[MISB.SensorLatitude] = SENSOR_LAT + i * 1e-5;
        row[MISB.SensorLongitude] = SENSOR_LON + i * 1e-5;
        row[MISB.SensorTrueAltitude] = SENSOR_ALT;
        if (angles) {
            row[MISB.PlatformHeadingAngle] = 157.6;
            row[MISB.PlatformPitchAngle] = 3.4;
            row[MISB.PlatformRollAngle] = -6.5;
            row[MISB.SensorRelativeAzimuthAngle] = 254.25;
            row[MISB.SensorRelativeElevationAngle] = -20.38;
            row[MISB.SensorRelativeRollAngle] = 0;
        }
        if (i < centers) {
            row[MISB.FrameCenterLatitude] = SENSOR_LAT + 0.011 + i * 1e-5;
            row[MISB.FrameCenterLongitude] = SENSOR_LON + 0.019 + i * 1e-5;
            row[tag === "hae" ? MISB.FrameCenterHeightAboveEllipsoid
                : MISB.FrameCenterElevation] = groundAlt;
        }
        misb.push(row);
    }
    return misb;
}

// geoid: false throughout — the EGM96 grid is not loaded under Jest, and this
// suite is about WHICH height is chosen, not about the MSL->HAE step. With the
// geoid off, tag 25 and tag 78 carry the same number, which is what lets the
// datum test below isolate the tag choice.
const ingest = (misb) => ingestMISBRecords(misb, {label: "clip.ts", geoid: false});

test("the ground plane comes from the frame centers, not sea level", () => {
    const record = ingest(clip());
    // ENU z at the aim point, so a few metres of Earth-curvature drop separate
    // it from the stated 1867 m HAE. Nowhere near sea level is the claim.
    expect(record.groundZ).toBeGreaterThan(GROUND_ALT - 50);
    expect(record.groundZ).toBeLessThan(GROUND_ALT + 50);
    expect(record.meta.groundSamples).toBe(30);
    expect(record.meta.surfaceModel).toContain("frame-center");
    expect(record.warnings.join("\n")).toMatch(/MEDIAN of 30 frame-center/);
});

// THE POINT OF READING IT UNCONDITIONALLY. truck.ts points by GIMBAL ANGLES and
// still carries frame-center columns; reading them only on the frame-center
// pointing path (which is what the code did) threw away the one terrain
// measurement in the file for exactly the clips that motivated this.
test("gimbal-pointed clips still contribute their frame centers", () => {
    const record = ingest(clip());
    expect(record.meta.pointing).toBe("gimbal angles");     // pointing UNCHANGED
    expect(record.meta.groundSamples).toBe(30);             // ground still read
    expect(record.groundZ).toBeGreaterThan(GROUND_ALT - 50);
});

test("a frame-center-pointed clip gets the same ground", () => {
    const record = ingest(clip(30, {angles: false}));
    expect(record.meta.pointing).toBe("frame center");
    expect(record.groundZ).toBeGreaterThan(GROUND_ALT - 50);
});

// Tag 78 is already ellipsoidal, tag 25 is MSL. With the geoid off they agree,
// so this pins that tag 78 is READ AT ALL — a file that states its center
// height only in the HAE column must not fall back to sea level.
test("a frame center stated as tag 78 (HAE) is read too", () => {
    const record = ingest(clip(30, {tag: "hae"}));
    expect(record.meta.groundSamples).toBe(30);
    expect(record.groundZ).toBeGreaterThan(GROUND_ALT - 50);
});

test("no frame-center columns at all leaves sea level, as before", () => {
    const record = ingest(clip(30, {centers: 0}));
    expect(record.meta.groundSamples).toBe(0);
    expect(Math.abs(record.groundZ)).toBeLessThan(1);       // geoid off => 0
    expect(record.meta.surfaceModel).not.toContain("frame-center");
});

// A handful of centers in a long clip is as likely to be a producer emitting a
// stray row as a survey of the terrain, so the median is not taken from them.
test("too few frame centers falls back to sea level and says so", () => {
    const record = ingest(clip(30, {centers: 3}));
    expect(record.meta.groundSamples).toBe(3);
    expect(Math.abs(record.groundZ)).toBeLessThan(1);
    expect(record.warnings.join("\n")).toMatch(/Only 3 record\(s\) state a frame-center/);
});

// THE FAILURE THAT MUST NOT BE SILENT. A ground above the aircraft rejects
// every candidate in the file as underground — including the sensor's own
// sightlines — and the row would show an empty result with no cause given.
test("a ground above the sensor is refused, loudly, and sea level kept", () => {
    const record = ingest(clip(30, {groundAlt: SENSOR_ALT + 500}));
    expect(Math.abs(record.groundZ)).toBeLessThan(1);
    expect(record.warnings.join("\n")).toMatch(/above the lowest sensor height/);
    expect(record.meta.surfaceModel).not.toContain("frame-center");
});

// The median, not the mean: one wild center (the axis swinging off the
// producer's terrain model) must not drag the plane with it.
test("one absurd frame center does not move the plane", () => {
    const misb = clip();
    misb[7][MISB.FrameCenterElevation] = -40000;
    const record = ingest(misb);
    expect(record.groundZ).toBeGreaterThan(GROUND_ALT - 50);
    expect(record.groundZ).toBeLessThan(GROUND_ALT + 50);
});
