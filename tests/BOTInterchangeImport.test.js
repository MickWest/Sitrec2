/**
 * BOT interchange CSV import — src/TrackFiles/CTrackFileBOT.js
 *
 * The CSVs are synthesised inline rather than read from
 * benchmarks/botbench/results/interchange, which is generated output and
 * gitignored: a test that read it would pass locally and fail in CI.
 */

import {
    BOT_DEFAULT_ORIGIN,
    botENUToLLA,
    botLOSToAzEl,
    CTrackFileBOT,
    isBOTCSV,
} from "../src/TrackFiles/CTrackFileBOT";
import {CTrackFile} from "../src/TrackFiles/CTrackFile";
import {MISB} from "../src/MISBFields";
import {ECEF2ENU_radii, LLAToECEF} from "../src/LLA-ECEF-ENU";

const DEG = Math.PI / 180;

// The verification geometry, in the ENU metres the format uses:
//   sensor 5 km due SOUTH of the origin at 3000 m
//   target at the origin at 500 m
// so the sightline is due north and 26.57 deg below the horizontal.
const SENSOR = [0, -5000, 3000];
const TRUTH = [0, 0, 500];
const LOS = (() => {
    const d = [TRUTH[0] - SENSOR[0], TRUTH[1] - SENSOR[1], TRUTH[2] - SENSOR[2]];
    const n = Math.hypot(...d);
    return d.map((c) => c / n);
})();

const INPUT_HEADER = "TrackID,TrackSource,Time,SensorPositionX,SensorPositionY,"
    + "SensorPositionZ,LOSUnitVectorX,LOSUnitVectorY,LOSUnitVectorZ,MaxRange,LOSUncertainty";
const TRUTH_HEADER = "TrackID,Time,TruePositionX,TruePositionY,TruePositionZ";
const ALL_HEADER = INPUT_HEADER + ",TruePositionX,TruePositionY,TruePositionZ";

// csv.toArrays() output: a 2-D array of strings, row 0 = headers.
function rows(text) {
    return text.trim().split("\n").map((l) => l.split(","));
}

function inputCsv(n = 3) {
    const out = [INPUT_HEADER];
    for (let t = 0; t < n; t++) {
        out.push(`bot-0001,botbench,${t},${SENSOR.join(",")},${LOS.join(",")},,0.03`);
    }
    return rows(out.join("\n"));
}

function truthCsv(n = 3, blank = false) {
    const out = [TRUTH_HEADER];
    for (let t = 0; t < n; t++) {
        out.push(`bot-0001,${t},${blank ? ",," : TRUTH.join(",")}`);
    }
    return rows(out.join("\n"));
}

function allCsv(n = 3, blankTruth = false) {
    const out = [ALL_HEADER];
    for (let t = 0; t < n; t++) {
        out.push(`bot-0001,botbench,${t},${SENSOR.join(",")},${LOS.join(",")},,0.03,`
            + (blankTruth ? ",," : TRUTH.join(",")));
    }
    return rows(out.join("\n"));
}

describe("BOT interchange detection", () => {
    test("accepts all three shapes", () => {
        expect(isBOTCSV(inputCsv())).toBe(true);
        expect(isBOTCSV(truthCsv())).toBe(true);
        expect(isBOTCSV(allCsv())).toBe(true);
    });

    test("rejects unrelated CSVs and header-only files", () => {
        expect(isBOTCSV(rows("time,lat,lon,alt\n0,35,-125,500"))).toBe(false);
        expect(isBOTCSV(rows(INPUT_HEADER))).toBe(false);   // no data rows
        expect(isBOTCSV([])).toBe(false);
        // A sensor family with no sightlines is not a BOT challenge file.
        expect(isBOTCSV(rows(
            "TrackID,Time,SensorPositionX,SensorPositionY,SensorPositionZ\nx,0,1,2,3")))
            .toBe(false);
    });
});

describe("BOT coordinate conversion", () => {
    test("Z is altitude directly, at any range (flat-plane rule)", () => {
        // The whole point of the flat-plane reading: no curvature term is
        // subtracted, so a 20 km MSL balloon 50 km away is still at 20 km.
        expect(botENUToLLA(0, 0, 500)[2]).toBeCloseTo(500, 9);
        expect(botENUToLLA(0, 50000, 20000)[2]).toBeCloseTo(20000, 9);
        expect(botENUToLLA(30000, 40000, 3000)[2]).toBeCloseTo(3000, 9);
    });

    test("horizontal offsets map to the expected lat/lon", () => {
        const [lat, lon] = botENUToLLA(SENSOR[0], SENSOR[1], SENSOR[2]);
        // 5 km south of 35N: ~0.045 deg of latitude, longitude unchanged.
        expect(lat).toBeLessThan(BOT_DEFAULT_ORIGIN.latDeg);
        expect(lat).toBeCloseTo(34.9549, 3);
        expect(lon).toBeCloseTo(BOT_DEFAULT_ORIGIN.lonDeg, 9);
    });
});

describe("BOT sightline conversion", () => {
    // Both files' directions are in the ENU basis at the ORIGIN; Sitrec applies
    // az/el in the basis at the SENSOR. These two differ by ~d/R_earth, and the
    // conversion has to account for it.
    const [sensorLat, sensorLon] = botENUToLLA(SENSOR[0], SENSOR[1], SENSOR[2]);

    test("azimuth is due north for a due-north sightline", () => {
        const {az} = botLOSToAzEl(LOS, sensorLat, sensorLon);
        // atan2 wraps to [0,360), so due north is 0 or 360.
        expect(Math.min(az, 360 - az)).toBeCloseTo(0, 6);
    });

    test("elevation is re-expressed in the sensor's own frame, not the origin's", () => {
        const {el} = botLOSToAzEl(LOS, sensorLat, sensorLon);
        const naive = Math.asin(LOS[2]) / DEG;   // what reading it as origin-basis gives
        expect(naive).toBeCloseTo(-26.5651, 3);
        // The sensor is 5 km south, so its local horizon is tilted and the target
        // sits ~0.045 deg LOWER than the origin-basis value. Asserting the
        // difference is what proves the basis change actually happened.
        expect(el).toBeLessThan(naive);
        expect(naive - el).toBeCloseTo(5000 / 6371000 / DEG, 2);
    });

    test("the sightline points at the truth track in Sitrec's round-earth world", () => {
        // End-to-end: convert both endpoints to LLA the way the importer does, take
        // the true ECEF direction between them, and compare with the az/el the
        // importer derives from the LOS column. They cannot agree exactly — the
        // source geometry is flat and Sitrec's is an ellipsoid — so this pins the
        // size of that disagreement rather than pretending it is zero.
        const [sLat, sLon, sAlt] = botENUToLLA(...SENSOR);
        const [tLat, tLon, tAlt] = botENUToLLA(...TRUTH);
        const sECEF = LLAToECEF(sLat, sLon, sAlt);
        const tECEF = LLAToECEF(tLat, tLon, tAlt);
        const dir = tECEF.clone().sub(sECEF).normalize();
        const local = ECEF2ENU_radii(dir, sLat * DEG, sLon * DEG, true).normalize();
        let trueAz = Math.atan2(local.x, local.y) / DEG;
        if (trueAz < 0) trueAz += 360;
        const trueEl = Math.asin(Math.max(-1, Math.min(1, local.z))) / DEG;

        const {az, el} = botLOSToAzEl(LOS, sLat, sLon);
        expect(Math.min(Math.abs(az - trueAz), 360 - Math.abs(az - trueAz)))
            .toBeLessThan(0.01);
        // ~0.02 deg at 5.6 km slant range; it grows with range as (d/R).
        expect(Math.abs(el - trueEl)).toBeLessThan(0.05);
    });
});

describe("BOT sub-tracks", () => {
    test("an All file yields a sensor track and a truth track, with roles", () => {
        const f = new CTrackFileBOT(allCsv());
        expect(f.doesContainTrack()).toBe(true);
        expect(f.getTrackCount()).toBe(2);
        expect(f.trackRoleHint(0)).toBe("camera");
        expect(f.trackRoleHint(1)).toBe("target");
        expect(f.getShortName(0, "scene.all.csv")).toBe("scene (Sensor)");
        expect(f.getShortName(1, "scene.all.csv")).toBe("scene (Truth)");
        // Two views of one scenario: they load together, no import picker.
        expect(f.getImportTrackCount()).toBe(1);
    });

    test("an Input file yields only the sensor track", () => {
        const f = new CTrackFileBOT(inputCsv());
        expect(f.getTrackCount()).toBe(1);
        expect(f.trackRoleHint(0)).toBe("camera");
        expect(f.getShortName(0, "scene.input.csv")).toBe("scene (Sensor)");
    });

    test("a Truth file yields only the truth track", () => {
        const f = new CTrackFileBOT(truthCsv());
        expect(f.getTrackCount()).toBe(1);
        expect(f.trackRoleHint(0)).toBe("target");
        expect(f.getShortName(0, "scene.truth.csv")).toBe("scene (Truth)");
    });

    test("blank truth columns produce NO truth track", () => {
        // Direction-only truth (a star or planet) has no finite position. Number("")
        // is 0, so a naive reader would emit a track sitting at the ENU origin.
        const f = new CTrackFileBOT(allCsv(3, true));
        expect(f.getTrackCount()).toBe(1);
        expect(f.trackRoleHint(0)).toBe("camera");
        expect(new CTrackFileBOT(truthCsv(3, true)).doesContainTrack()).toBe(false);
    });

    test("only the Truth sub-track declares itself ground truth", () => {
        // The traverse analysis auto-selects a ground-truth track as its scoring
        // reference, so this must be the sub-track's KEY and not its index: truth is
        // index 1 in an All file and index 0 in a Truth file. The Sensor track is the
        // measurement — scoring the analysis against it would score it against its
        // own input.
        const all = new CTrackFileBOT(allCsv());
        expect(all.isGroundTruthTrack(0)).toBe(false);   // Sensor
        expect(all.isGroundTruthTrack(1)).toBe(true);    // Truth

        expect(new CTrackFileBOT(truthCsv()).isGroundTruthTrack(0)).toBe(true);
        expect(new CTrackFileBOT(inputCsv()).isGroundTruthTrack(0)).toBe(false);

        // Out-of-range indices must be false, not throw — the lookup runs over every
        // loaded track, including ones from other files.
        expect(all.isGroundTruthTrack(2)).toBe(false);
        expect(all.isGroundTruthTrack(-1)).toBe(false);
    });

    test("the default for any other track file is NOT ground truth", () => {
        // A target ROLE is not truth: a STANAG target track is somebody else's
        // estimate, and scoring against it would compare two answers.
        expect(new CTrackFile([]).isGroundTruthTrack(0)).toBe(false);
    });

    test("a concatenated multi-TrackID file keeps the FIRST scenario only", () => {
        // One scenario per file is what the format emits and all this class supports.
        // A concatenation must not become one track that teleports between scenarios,
        // and must not silently drop the extra data without saying so.
        const two = allCsv();
        const extra = two.slice(1).map((r) => { const c = [...r]; c[0] = "bot-0002"; return c; });
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        const f = new CTrackFileBOT([...two, ...extra]);

        expect(f.getTrackCount()).toBe(2);              // not 4
        expect(f.getImportTrackCount()).toBe(1);        // no selection dialog
        expect(f.trackRoleHint(0)).toBe("camera");
        expect(f.trackRoleHint(1)).toBe("target");
        // Every row of the kept track belongs to the first TrackID.
        expect(f.toMISB(0).length).toBe(two.length - 1);
        expect(warn.mock.calls.join(" ")).toContain("2 TrackIDs");
        warn.mockRestore();
    });
});

describe("BOT MISB output", () => {
    test("the sensor track carries position and sightline angles", () => {
        const f = new CTrackFileBOT(allCsv(4));
        const misb = f.toMISB(0);
        expect(misb.length).toBe(4);

        const [sLat, sLon] = botENUToLLA(...SENSOR);
        expect(misb[0][MISB.SensorLatitude]).toBeCloseTo(sLat, 9);
        expect(misb[0][MISB.SensorLongitude]).toBeCloseTo(sLon, 9);
        expect(misb[0][MISB.SensorTrueAltitude]).toBeCloseTo(3000, 9);

        // TrackManager gates the ENTIRE angles pipeline on PlatformPitchAngle being
        // a finite number. If this stops being 0, no "<name> angles" LOS is built
        // and the sightlines silently vanish from the import.
        expect(typeof misb[0][MISB.PlatformPitchAngle]).toBe("number");
        expect(misb[0][MISB.PlatformHeadingAngle]).toBe(0);
        expect(misb[0][MISB.PlatformRollAngle]).toBe(0);
        expect(misb[0][MISB.SensorRelativeRollAngle]).toBe(0);

        const {az, el} = botLOSToAzEl(LOS, sLat, sLon);
        expect(misb[0][MISB.SensorRelativeAzimuthAngle]).toBeCloseTo(az, 9);
        expect(misb[0][MISB.SensorRelativeElevationAngle]).toBeCloseTo(el, 9);
    });

    test("the truth track carries position and NO angles", () => {
        const f = new CTrackFileBOT(allCsv(4));
        const misb = f.toMISB(1);
        expect(misb.length).toBe(4);
        expect(misb[0][MISB.SensorTrueAltitude]).toBeCloseTo(500, 9);
        // Truth is a position, not a sensor: giving it angles would create a second
        // camera-like LOS pointing nowhere in particular.
        expect(misb[0][MISB.PlatformPitchAngle]).toBeNull();
        expect(misb[0][MISB.SensorRelativeAzimuthAngle]).toBeNull();
    });

    test("time is seconds from the default epoch, in epoch milliseconds", () => {
        const f = new CTrackFileBOT(allCsv(3));
        const misb = f.toMISB(0);
        const base = Date.parse("2025-02-01T20:00:00Z");
        expect(misb[0][MISB.UnixTimeStamp]).toBe(base);
        expect(misb[1][MISB.UnixTimeStamp]).toBe(base + 1000);
        expect(misb[2][MISB.UnixTimeStamp]).toBe(base + 2000);
    });

    test("angle smoothing is disabled for these tracks", () => {
        // TrackManager's 120-frame default would collapse the middle of a 16-61
        // frame 1 Hz track to the mean of the whole sweep.
        expect(new CTrackFileBOT(allCsv()).anglesSmoothing(0)).toBe(0);
    });
});

describe("sparse angle keyframes across the 0/360 seam", () => {
    // Regression for the artifact this importer exposed: azimuth is interpolated
    // between keyframes, and without the degrees flag a step from 0.03 deg to
    // 359.3 deg — a 0.7 deg change — was interpolated as a 359 deg sweep the other
    // way, so every frame in between pointed somewhere wrong. Per-frame MISB from a
    // 30 fps video hid it (adjacent keyframes leave nothing to interpolate); a 1 Hz
    // BOT track resampled to 30 fps puts ~30 frames inside each step.
    const {ExpandMISBKeyframes} = require("../src/utils");

    // A track array as CNodeArrayFromMISBColumn sees it: one entry per output
    // frame, with misbRow shared across the run of frames belonging to one sample.
    function track(values, framesPerSample) {
        const out = [];
        for (const v of values) {
            const misbRow = [];
            misbRow[MISB.SensorRelativeAzimuthAngle] = v;
            for (let i = 0; i < framesPerSample; i++) out.push({misbRow});
        }
        return out;
    }

    test("degrees=true takes the short way round", () => {
        const a = ExpandMISBKeyframes(
            track([0.03, 359.3, 358.6], 30), MISB.SensorRelativeAzimuthAngle, true);
        // Every frame must stay near the ~1.4 deg arc the samples span, modulo 360,
        // rather than wandering through 180. The bound is loose enough to allow the
        // extrapolation past the final keyframe (which reaches ~2 deg) and still
        // two orders of magnitude below the bug it guards against.
        for (const v of a) {
            const fromZero = Math.min(Math.abs(v), Math.abs(v - 360), Math.abs(v + 360));
            expect(fromZero).toBeLessThan(5);
        }
    });

    test("degrees=false is the broken sweep the flag exists to prevent", () => {
        const a = ExpandMISBKeyframes(
            track([0.03, 359.3, 358.6], 30), MISB.SensorRelativeAzimuthAngle, false);
        expect(Math.max(...a)).toBeGreaterThan(180);
    });
});

describe("the import must not end up aimed at truth", () => {
    const {shouldPreserveAnglesHeading} = require("../src/trackSourceUtils");

    test("the sensor track declares its angles as the measurement", () => {
        const f = new CTrackFileBOT(allCsv());
        // Sub-track 0 is the sensor, 1 is the truth.
        expect(f.anglesAreMeasurement(0)).toBe(true);
        expect(f.anglesAreMeasurement(1)).toBe(false);
        // A truth-only file has no measured angles to protect.
        expect(new CTrackFileBOT(truthCsv()).anglesAreMeasurement(0)).toBe(false);
        // ...and an input-only file is all measurement.
        expect(new CTrackFileBOT(inputCsv()).anglesAreMeasurement(0)).toBe(true);
    });

    test("the arriving Truth track does not clobber the measured heading", () => {
        // The .all.csv case: camera is the Sensor track showing its own measured
        // angles, and the Truth track arrives as the target. Aiming at it would
        // re-derive every sightline FROM the answer.
        expect(shouldPreserveAnglesHeading({
            headingChoice: "Angles_scene (Sensor)",
            cameraShortName: "scene (Sensor)",
            arrivingShortName: "scene (Truth)",
            sameSourceFile: true,
            isSupplementary: true,
        })).toBe(true);
    });

    test("an unrelated target track still forces To Target", () => {
        // The generalisation must not swallow the ordinary case: a second track
        // from a DIFFERENT file is a real target and should be aimed at.
        expect(shouldPreserveAnglesHeading({
            headingChoice: "Angles_scene (Sensor)",
            cameraShortName: "scene (Sensor)",
            arrivingShortName: "N12345",
            sameSourceFile: false,
            isSupplementary: false,
        })).toBe(false);
        // Same file, but the file does not mark it supplementary (STANAG's
        // role-hinted ground target): still a genuine target.
        expect(shouldPreserveAnglesHeading({
            headingChoice: "Angles_scene (Sensor)",
            cameraShortName: "scene (Sensor)",
            arrivingShortName: "GroundTarget-1",
            sameSourceFile: true,
            isSupplementary: false,
        })).toBe(false);
    });

    test("the truth sub-track is marked supplementary, which is what the guard reads", () => {
        const f = new CTrackFileBOT(allCsv());
        expect(f.isSupplementaryTrack(0)).toBe(false);
        expect(f.isSupplementaryTrack(1)).toBe(true);
    });
});

describe("the STANAG 'target track only' prompt must not apply", () => {
    // That prompt offers to drop a file's non-target tracks because STANAG's
    // platform/ground pair are the two ends of a line of sight already supplied by
    // a loaded camera. A BOT file has no such tracks — its second track is the
    // Sensor, which carries the measured bearings. Taking the prompt's primary
    // option there would keep the answer and discard the evidence.
    const {CTrackFileSTANAGCSV} = require("../src/TrackFiles/CTrackFileSTANAGCSV");

    test("a BOT file declares no redundant LOS reference tracks", () => {
        expect(new CTrackFileBOT(allCsv()).hasRedundantLOSReferenceTracks()).toBe(false);
        expect(new CTrackFileBOT(inputCsv()).hasRedundantLOSReferenceTracks()).toBe(false);
    });

    test("a STANAG file still does, so its prompt is unchanged", () => {
        const stanag = [
            ["UTC", "SLAT", "SLON", "SHAE", "GLAT", "GLON", "HAE", "TPLAT", "TPLON", "TPHAE"],
            ["1700000000000", "35.1", "-125.1", "3000", "35.0", "-125.0", "0", "35.05", "-125.05", "500"],
            ["1700000001000", "35.11", "-125.11", "3000", "35.0", "-125.0", "0", "35.05", "-125.05", "500"],
        ];
        expect(new CTrackFileSTANAGCSV(stanag).hasRedundantLOSReferenceTracks()).toBe(true);
    });
});

describe("camera position and heading come from the same track", () => {
    // Bearings are only meaningful from the platform that recorded them. If the
    // track supplying the measured angles were ever a different track from the one
    // supplying the camera position, the rendered sightlines would start at the
    // wrong place — a composite of two sensors that corresponds to no real
    // observation. TrackManager selects the camera track for exactly the tracks
    // that answer true to anglesAreMeasurement, so these two must agree.
    for (const [label, make] of [
        ["all", () => new CTrackFileBOT(allCsv())],
        ["input-only", () => new CTrackFileBOT(inputCsv())],
        ["truth-only", () => new CTrackFileBOT(truthCsv())],
        ["multi-TrackID", () => {
            const two = allCsv();
            const extra = two.slice(1).map((r) => { const c = [...r]; c[0] = "bot-0002"; return c; });
            return new CTrackFileBOT([...two, ...extra]);
        }],
    ]) {
        test(`measured angles imply the camera role (${label})`, () => {
            const f = make();
            for (let i = 0; i < f.getTrackCount(); i++) {
                if (f.anglesAreMeasurement(i)) {
                    // It must be a sensor track, and never the truth track.
                    expect(f.getShortName(i, "s.csv")).toContain("(Sensor)");
                    expect(f.toMISB(i)[0][MISB.PlatformPitchAngle]).toBe(0);
                } else {
                    // A non-measurement track must not carry angles at all, or it
                    // could be selected as a heading source in its own right.
                    expect(f.toMISB(i)[0][MISB.PlatformPitchAngle]).toBeNull();
                }
            }
        });
    }

    test("exactly ONE track may take over the camera, whatever the file holds", () => {
        // TrackManager takes over the camera position AND heading for tracks
        // satisfying (role === "camera" && anglesAreMeasurement). That pair must
        // identify exactly one track, or the last one processed wins on load order
        // and silently overrides the file's designated camera — position and
        // heading staying consistent with each other the whole time, so nothing
        // looks wrong while you fly the wrong scenario.
        const takesOverCamera = (f) => {
            const out = [];
            for (let i = 0; i < f.getTrackCount(); i++) {
                if (f.trackRoleHint(i) === "camera" && f.anglesAreMeasurement(i)) out.push(i);
            }
            return out;
        };

        expect(takesOverCamera(new CTrackFileBOT(allCsv()))).toEqual([0]);
        expect(takesOverCamera(new CTrackFileBOT(inputCsv()))).toEqual([0]);
        // A truth-only file has no measurement and must never claim the camera.
        expect(takesOverCamera(new CTrackFileBOT(truthCsv()))).toEqual([]);
    });
});

describe("closest-approach re-timing must never fire for BOT tracks", () => {
    // Not about concatenated files, which this importer does not support. Drop two
    // BOT files TOGETHER onto a fresh sitch and both load before the sitch is
    // established, so the second file's Sensor — a primary track, correctly — reaches
    // TrackManager's CPA heuristic, which re-times the whole sitch to the moment the
    // two sensors pass nearest. Two scenarios share only a coordinate frame, so that
    // moment is meaningless, and the re-timing moves the sitch window off data that
    // already carries absolute timestamps.
    const {CTrackFile} = require("../src/TrackFiles/CTrackFile");

    test("no BOT track of any shape is a CPA candidate", () => {
        for (const shape of [allCsv(), inputCsv(), truthCsv()]) {
            const f = new CTrackFileBOT(shape);
            for (let i = 0; i < f.getTrackCount(); i++) expect(f.cpaCandidate(i)).toBe(false);
        }
    });

    test("the Sensor stays a PRIMARY track despite that", () => {
        // cpaCandidate is asked separately precisely so the sensor keeps its platform
        // model: TrackManager gives supplementary tracks an invisible reference
        // sphere instead.
        const f = new CTrackFileBOT(allCsv());
        expect(f.isSupplementaryTrack(0)).toBe(false);   // Sensor
        expect(f.isSupplementaryTrack(1)).toBe(true);    // Truth
    });

    test("the default cpaCandidate still follows isSupplementaryTrack", () => {
        // Formats that do not override it must behave exactly as before.
        const plain = new CTrackFile([]);
        plain.isSupplementaryTrack = (i) => i > 0;
        expect(plain.cpaCandidate(0)).toBe(true);
        expect(plain.cpaCandidate(1)).toBe(false);
    });
});

describe("a fresh sitch is fitted to the scenario's full length", () => {
    // The scenarios are 15 s and 60 s at 1 Hz, while the custom sitch defaults to a
    // 30 s window. Without the duration sync a 60 s scenario loads with its second
    // half off the end of the timeline — the tracks exist but no frame reaches them.
    // TrackManager calls this optionally, so formats that omit it are unaffected.
    test("BOT files ask for the duration sync", () => {
        for (const shape of [allCsv(), inputCsv(), truthCsv()]) {
            expect(new CTrackFileBOT(shape).syncsSitchDuration()).toBe(true);
        }
    });

    test("the span it implies is the scenario's own, from the file's own times", () => {
        const f = new CTrackFileBOT(allCsv(61));      // 61 rows at 1 Hz = 60 s
        const misb = f.toMISB(0);
        const spanMs = misb[misb.length - 1][MISB.UnixTimeStamp] - misb[0][MISB.UnixTimeStamp];
        expect(spanMs).toBe(60 * 1000);
    });
});
