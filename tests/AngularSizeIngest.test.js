import {PerspectiveCamera, Vector3} from "three";
import {CNodeLOSTrackMISB} from "../src/nodes/CNodeLOSTrackMISB";
import {CNodeControllerMatrix} from "../src/nodes/CNodeControllerVarious";
import {CNodeLOSFromCamera} from "../src/nodes/CNodeLOSFromCamera";
import {buildAnalysisDataset} from "../src/TraverseAnalysisData";
import {setSit} from "../src/Globals";
import {ingestBotCSV, ingestMISBRecords, ingestGenericTrackCSV} from "../src/analysis/BotBenchIngest";
import {CTrackFileBOT} from "../src/TrackFiles/CTrackFileBOT";
import {MISB} from "../src/MISBFields";

const rows = () => [
    ["TrackID", "Time", "SensorPositionX", "SensorPositionY", "SensorPositionZ", "LOSUnitVectorX", "LOSUnitVectorY", "LOSUnitVectorZ", "AngularDiameterMinDeg", "AngularDiameterMaxDeg"],
    ...Array.from({length: 30}, (_, f) => ["sample", f / 10, f * 10, 0, 1000, .8, .4, -.2,
        f === 0 ? .1 : f === 29 ? .2 : "", f === 0 ? .2 : f === 29 ? .3 : ""]),
];
beforeAll(() => setSit({name: "test", frames: 1000, fps: 10, simSpeed: 1, lat: 37.244358, lon: -120.738187}));

test("BOT, live-import MISB and generic MISB CSV preserve the same sparse angular observations", () => {
    const data = rows(), csv = data.map(r => r.join(",")).join("\n");
    const bot = ingestBotCSV(csv);
    const live = new CTrackFileBOT(data).toMISB(0);
    const misb = ingestMISBRecords(live, {geoid: false});
    const columns = ["UnixTimeStamp", "SensorLatitude", "SensorLongitude", "SensorTrueAltitude", "PlatformHeadingAngle",
        "PlatformPitchAngle", "PlatformRollAngle", "SensorRelativeAzimuthAngle", "SensorRelativeElevationAngle",
        "SensorRelativeRollAngle", "AngularDiameterMinDeg", "AngularDiameterMaxDeg"];
    const genericCSV = [columns.join(","), ...live.map(r => columns.map(k => r[MISB[k]] ?? "").join(","))].join("\n");
    const generic = ingestGenericTrackCSV(genericCSV, {geoid: false});
    expect(bot.dataset.angularSize.samples).toEqual([{frame: 0, minDeg: .1, maxDeg: .2}, {frame: 29, minDeg: .2, maxDeg: .3}]);
    expect(misb.dataset.angularSize.samples).toEqual(bot.dataset.angularSize.samples);
    expect(generic.dataset.angularSize.samples).toEqual(bot.dataset.angularSize.samples);
    expect(Number.isFinite(live[15][MISB.AngularDiameterMaxDeg])).toBe(false);
});

test("relative-only sidecar evidence needs no absolute diameter or truth", () => {
    const data = rows().map(r => r.slice(0, 8));
    const angularSize = {relativeBound: {referenceFrame: 0, startFrame: 0, endFrame: 29, minRatio: .5, maxRatio: 1.5},
        relative: [{frame: 29, referenceFrame: 0, minRatio: .7, maxRatio: .9}]};
    const record = ingestBotCSV(data.map(r => r.join(",")).join("\n"), {sidecar: {angularSize, frame: {type: "ENU", axisOrder: "X=East, Y=North, Z=Up",
        directionBasis: "originLLA", surfaceModel: "flat-plane", geodeticAltitudeRule: "altitude = U + groundElevationMSL",
        originLLA: [37.244358, -120.738187, 27.6], groundElevationMSL: 27.6}}});
    expect(record.dataset.angularSize.samples).toEqual([]);
    expect(record.dataset.angularSize.relative).toHaveLength(31);
    expect(record.dataset.angularSizeOptions).toBeUndefined();
});

// Exercise the default live route, not just the CSV/MISB parser. Recorded
// 10 Hz observations are held across three scene frames at 30 fps.
test("Camera Center preserves recorded bounds once per observation and clears stale evidence", () => {
    setSit({frames: 90, fps: 30, simSpeed: 1, lat: 37.244358, lon: -120.738187});
    const data = rows();
    data[1][8] = ""; // This file can declare only an upper bound.
    const records = new CTrackFileBOT(data).toMISB(0);
    const cameraTrack = {frames: 90, p: f => new Vector3(6378137, f * 10, 100),
        v: f => ({misbRow: records[Math.floor(f / 3)]})};
    const inputs = Object.fromEntries(["platformHeading", "platformPitch", "platformRoll", "sensorAz", "sensorEl", "sensorRoll"]
        .map(k => [k, {v: () => 0}]));
    const recorded = {in: {cameraTrack, ...inputs}};
    CNodeLOSTrackMISB.prototype.recalculate.call(recorded);
    const matrixController = {in: {source: {v: f => recorded.array[f]}}};
    let manual = false;
    const cameraNode = {_object: new PerspectiveCamera(), applyControllersCount: 0,
        get camera() { return this._object; },
        update(f) {
            this.applyControllersCount++;
            this.camera.position.copy(cameraTrack.p(f));
            if (!manual) CNodeControllerMatrix.prototype.apply.call(matrixController, f, this);
        }};
    const los = {frames: 90, in: {cameraNode}, dummyCamera: new PerspectiveCamera(),
        v(f) { return CNodeLOSFromCamera.prototype.getValueFrame.call(this, f); }};
    const {dataset} = buildAnalysisDataset(los);
    expect(dataset.angularSize.samples).toEqual([
        {frame: 0, minDeg: 0, maxDeg: .2}, {frame: 87, minDeg: .2, maxDeg: .3}]);
    expect(dataset.angularSize.source).toBe("Recorded sensor angular-size bounds");
    expect(los.v(0).heading.distanceTo(recorded.array[0].heading)).toBeLessThan(1e-10);
    expect(los.v(3).angularSize).toBeUndefined(); // Sparse gap must stay empty.
    const crop = buildAnalysisDataset(los, null, 37040, {frame0: 1, frame1: 89}).dataset;
    expect(crop.angularSize.samples).toEqual([{frame: 86, minDeg: .2, maxDeg: .3}]);
    expect(los.v(0).angularSize.maxDeg).toBe(.2);
    manual = true;
    expect(los.v(0).angularSize).toBeUndefined();
    expect(buildAnalysisDataset(los).dataset.angularSize).toBeUndefined();
    manual = false;
    expect(los.v(0).angularSize.maxDeg).toBe(.2);
});
