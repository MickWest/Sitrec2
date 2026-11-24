/** @jest-environment jsdom */
import {PerspectiveCamera, Vector3} from "three";
import {eciToGeodetic, gstime, propagate} from "satellite.js";
import {Globals, setGlobalDateTimeNode, setNodeMan, setSit, Sit} from "../src/Globals";
import {CTLEData} from "../src/TLEUtils";
import {LLAToECEF} from "../src/LLA-ECEF-ENU";
import {findLoadedSatellite, getNamedSkyDirection} from "../src/NamedSkyTarget";
import {CNodeControllerCelestial} from "../src/nodes/CNodeControllerVarious";
import {CNodeControllerAzElZoom} from "../src/nodes/CNodeControllerPTZUI";
import {CNodeCamera} from "../src/nodes/CNodeCamera";
import {applyRefractionFromObserver} from "../src/atmosphere/refraction";
import {currentRefractionOpts} from "../src/atmosphere/refractionSettings";

const epoch = new Date("2026-11-20T12:00:00Z");
// Synthetic orbits: test name lookup and pointing without an online catalog.
const header = "OBJECT_NAME,NORAD_CAT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT";
const rows = [
    "ISS (ZARYA),25544,2026-11-20T12:00:00,15.5,0.0005,51.6,30,40,50,0,0,0",
    "STARLINK-38128,100001,2026-11-20T12:00:00,15.5,0.0005,53,60,70,80,0,0,0",
];
let sky, nodes, cameraNode, clock, lock, heading, ptz;
function makeLock() {
    return Object.assign(Object.create(CNodeControllerCelestial.prototype), {
        celestialObject: "Moon", lastValidObject: "Moon", raDec: null, simpleSerials: [],
        recalculateCascade: jest.fn(),
    });
}
function physicalPosition(number, date = clock.dateNow) {
    const record = sky.TLEData.getRecordFromNORAD(number).satrecs[0];
    const lla = eciToGeodetic(propagate(record, date).position, gstime(date));
    return LLAToECEF(lla.latitude * 180 / Math.PI, lla.longitude * 180 / Math.PI, lla.height * 1000);
}
function drawnDirection(number) {
    const position = cameraNode.camera.position;
    return applyRefractionFromObserver(physicalPosition(number), position, currentRefractionOpts()).sub(position).normalize();
}
function expectCentered(number) {
    expect(cameraNode.camera.getWorldDirection(new Vector3()).distanceTo(drawnDirection(number))).toBeLessThan(1e-8);
}

beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    Globals.equatorRadius = 6378137;
    Globals.polarRadius = 6356752.314245;
    setSit({frames: 900, fps: 30, lat: 30, lon: 20, refractionEnabled: true});
    sky = {TLEData: new CTLEData([header, ...rows].join("\n"))};
    clock = {dateNow: new Date(epoch)};
    setGlobalDateTimeNode(clock);
    cameraNode = Object.assign(Object.create(CNodeCamera.prototype), {
        _object: new PerspectiveCamera(), _freeLook: false, celestialLock: null, syncUIPosition() {},
    });
    cameraNode.camera.position.copy(LLAToECEF(30, 20, 100));
    lock = makeLock();
    heading = {choice: "To Target", inputs: {Manual: {}, "Celestial Lock": lock},
        selectOption(value) { this.choice = value; }};
    ptz = {relative: true, satellite: true, fov: 30,
        relativeController: {setValue(value) { ptz.relative = value; }},
        satelliteController: {setValue(value) { ptz.satellite = value; }},
        recalculateCascade() { CNodeControllerAzElZoom.prototype.apply.call(this, 0, cameraNode); }};
    nodes = {NightSkyNode: sky, lookCamera: cameraNode, celestialController: lock, CameraLOSController: heading, ptzAngles: ptz};
    setNodeMan({get: id => nodes[id]});
});
afterEach(() => jest.restoreAllMocks());

test.each(["ISS", "iss (zarya)", "International Space Station", "the ISS", 25544, " norad #25544 "])(
    "%p resolves the ISS from loaded orbital data", name => {
        expect(findLoadedSatellite(name)?.number).toBe(25544);
        const expected = physicalPosition(25544).sub(cameraNode.camera.position).normalize();
        expect(getNamedSkyDirection(name, epoch, cameraNode.camera.position).distanceTo(expected)).toBeLessThan(1e-12);
    });

test("other loaded satellites accept names, prefixes and six-digit numbers even when hidden", () => {
    sky.TLEData.getRecordFromNORAD(100001).visible = false;
    for (const name of ["starlink-38128", "STARLINK-", "100001"]) {
        expect(findLoadedSatellite(name)?.number).toBe(100001);
        expect(getNamedSkyDirection(name, epoch).length()).toBeCloseTo(1, 12);
    }
});

test("Celestial Lock follows the orbit and the observer, and survives serialization", () => {
    expect(cameraNode.lockOnObject("ISS")).toBe(true);
    expect(heading.choice).toBe("Celestial Lock");
    lock.apply(0, cameraNode);
    expectCentered(25544);
    const initial = cameraNode.camera.quaternion.clone();
    const saved = JSON.parse(JSON.stringify(lock.modSerialize()));
    lock = makeLock();
    lock.modDeserialize(saved);
    clock.dateNow = new Date(+epoch + 60000);
    cameraNode.camera.position.copy(LLAToECEF(35, 25, 1000));
    lock.apply(1800, cameraNode);
    expectCentered(25544);
    expect(initial.angleTo(cameraNode.camera.quaternion)).toBeGreaterThan(0.01);
});

test.each([true, false])("one-shot pointing replaces a driven heading and matches sky refraction=%s", enabled => {
    Sit.refractionEnabled = enabled;
    // Place the observer far enough from the sub-satellite point to make refraction measurable.
    const target = physicalPosition(25544);
    cameraNode.camera.position.copy(target).normalize().multiplyScalar(6378137 + 100);
    cameraNode.camera.position.applyAxisAngle(new Vector3(0, 0, 1), 0.3);
    expect(cameraNode.setFromNamedObject("ISS")).toBe(true);
    expect(heading.choice).toBe("Manual");
    expect(cameraNode.celestialLock).toBeNull();
    expect(ptz.relative).toBe(false);
    expect(ptz.satellite).toBe(false);
    expectCentered(25544);
    const aimed = cameraNode.camera.quaternion.clone();
    clock.dateNow = new Date(+epoch + 60000);
    ptz.recalculateCascade();
    expect(cameraNode.camera.quaternion.angleTo(aimed)).toBeLessThan(1e-7);
});

test("missing or unusable orbit data leaves the previous aim and lock intact", () => {
    const before = cameraNode.camera.quaternion.clone();
    sky.TLEData = undefined;
    sky.renderTLEData = {satData: [{name: "ISS", number: 25544}]};
    expect(findLoadedSatellite("ISS")).toBeNull();
    expect(cameraNode.setFromNamedObject("ISS")).toBe(false);
    expect(cameraNode.lockOnObject("ISS")).toBe(false);
    expect(cameraNode.camera.quaternion.equals(before)).toBe(true);
    expect(heading.choice).toBe("To Target");
    sky.TLEData = new CTLEData([header, ...rows].join("\n"));
    clock.dateNow = new Date(+epoch + 91 * 86400000);
    expect(cameraNode.lockOnObject("ISS")).toBe(false);
    clock.dateNow = epoch;
    sky.TLEData.getRecordFromNORAD(25544).satrecs[0].no = NaN;
    expect(cameraNode.setFromNamedObject("ISS")).toBe(false);
});

test("existing body and named-star directions remain available", () => {
    expect(getNamedSkyDirection("Moon", epoch, cameraNode.camera.position).length()).toBeCloseTo(1, 12);
    sky.starField = {findStarByName: name => name === "Sirius" ? {ra: 1.7678, dec: -0.2918} : null};
    expect(cameraNode.lockOnObject("Sirius")).toBe(true);
    expect(lock.lastValidObject).toBe("Sirius");
    expect(getNamedSkyDirection("not a sky object", epoch)).toBeNull();
});
