jest.mock("../src/raycastGround", () => ({raycastGroundElevationFast: () => null}));
jest.mock("../src/EGM96Geoid", () => ({meanSeaLevelOffset: () => 25, ensureGeoidLoaded: async () => {}}));

import {PerspectiveCamera, Vector3} from "three";
import {execFileSync} from "child_process";
import path from "path";
import {setSit} from "../src/Globals";
import {buildMISBExportRecords} from "../src/MISBExportMetadata";
import {getCameraKMLPose} from "../src/ExportCameraKML";
import {LLAToECEF} from "../src/LLA-ECEF-ENU";
import {getLocalUpVector} from "../src/SphericalMath";
import {misbSensorMatrix} from "../src/MISBSightline";
import {MISB} from "../src/MISBFields";
import {CTrackFileMISB} from "../src/TrackFiles/CTrackFileMISB";
import {getFilteredVideoFormatOptions, getVideoExtension} from "../src/VideoExporter";

// Jest maps .mjs to a stub. Run the application's real decoder in native ESM.
const decode = record => {
    const items = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
        import {readFileSync} from "node:fs";
        import {parse} from "./src/js/misb.js-main/src/st0601.mjs";
        process.stdout.write(JSON.stringify(parse(Uint8Array.from(JSON.parse(readFileSync(0, "utf8"))))));
    `], {cwd: path.resolve(__dirname, ".."), input: JSON.stringify(Array.from(record.klv)), encoding: "utf8"}));
    const row = [];
    for (const item of items) row[item.key] = item.value;
    return [row];
};
function sample(extra = {}) {
    setSit({lat: 37, lon: -120, frames: 30, fps: 30});
    const camera = new PerspectiveCamera(24, 16 / 9);
    camera.position.copy(LLAToECEF(37, -120, 3025));
    camera.up.copy(getLocalUpVector(camera.position));
    camera.lookAt(LLAToECEF(37.02, -119.99, 1025));
    camera.rotateZ(0.17);
    camera.updateMatrixWorld(true);
    const pose = getCameraKMLPose({camera});
    const records = buildMISBExportRecords({
        timestamp: 1700000000123456, pose, vfov: 24, aspect: 16 / 9, cameraName: "Camera",
        ...extra,
    });
    return {records, camera};
}

test("MISB camera position, FOV and full orientation survive binary decoding", () => {
    const {records, camera} = sample();
    const [row] = decode(records.camera);
    expect(row[MISB.UnixTimeStamp]).toBe(1700000000123456);
    expect(row[MISB.SensorLatitude]).toBeCloseTo(37, 6);
    expect(row[MISB.SensorLongitude]).toBeCloseTo(-120, 6);
    expect(Math.abs(row[MISB.SensorTrueAltitude] - 3000)).toBeLessThan(0.16);
    expect(row[MISB.SensorVerticalFieldofView]).toBeCloseTo(24, 2);
    const matrix = misbSensorMatrix(camera.position, {
        platformHeading: row[5], platformPitch: row[6], platformRoll: row[7],
        sensorAz: row[18], sensorEl: row[19], sensorRoll: row[20],
    });
    expect(new Vector3().setFromMatrixColumn(matrix, 2).distanceTo(camera.getWorldDirection(new Vector3())))
        .toBeLessThan(1e-7);
    expect(new Vector3().setFromMatrixColumn(matrix, 1).distanceTo(new Vector3().setFromMatrixColumn(camera.matrixWorld, 1)))
        .toBeLessThan(1e-7);
    expect(records.truth).toBeNull();
    expect(new CTrackFileMISB(decode(records.camera)).getTrackCount()).toBe(1);
});

test("independent target, truth and ground tracks retain their positions and roles", () => {
    const {records} = sample({
        targetPosition: LLAToECEF(37.02, -119.99, 1025),
        truthPosition: LLAToECEF(37.03, -119.98, 2025),
        groundPoint: LLAToECEF(37.04, -119.97, 125), truthName: "Reference é".repeat(30),
    });
    const cameraRows = decode(records.camera), truthRows = decode(records.truth);
    expect(cameraRows[0][MISB.TargetLocationLatitude]).toBeCloseTo(37.02, 6);
    expect(Math.abs(cameraRows[0][MISB.TargetLocationElevation] - 1000)).toBeLessThan(0.16);
    expect(cameraRows[0][MISB.FrameCenterLatitude]).toBeCloseTo(37.04, 6);
    expect(cameraRows[0][MISB.SlantRange]).toBeGreaterThan(1000);
    expect(truthRows[0][MISB.SensorLatitude]).toBeCloseTo(37.03, 6);
    expect(Math.abs(truthRows[0][MISB.SensorTrueAltitude] - 2000)).toBeLessThan(0.16);
    expect(truthRows[0][MISB.PlatformTailNumber]).not.toContain("�");
    const truth = new CTrackFileMISB(truthRows);
    expect(truth.trackIsTruth(0)).toBe(true);
    expect(truth.isSupplementaryTrack(0)).toBe(true);
    expect(truth._hasAngles()).toBe(false);
    const tracks = new CTrackFileMISB(cameraRows);
    expect(tracks.getTrackCount()).toBe(3);
    expect(tracks.trackIsTruth(2)).toBe(false);
    expect(tracks.toMISB(2)[0][MISB.SensorLatitude]).toBeCloseTo(37.02, 6);
});

test("the TS format is offered only with H.264 and has its own extension", () => {
    expect(Object.values(getFilteredVideoFormatOptions({h264: true, vp8: true}))).toContain("misb-ts-h264");
    expect(Object.values(getFilteredVideoFormatOptions({h264: false, vp8: true}))).not.toContain("misb-ts-h264");
    expect(getVideoExtension("misb-ts-h264")).toBe("ts");
});
