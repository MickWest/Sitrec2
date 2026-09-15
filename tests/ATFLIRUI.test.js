/** @jest-environment jsdom */
import {PerspectiveCamera, Vector3} from "three";
import {CNodeATFLIRUI} from "../src/nodes/CNodeATFLIRUI";
import {setNodeMan, setSit} from "../src/Globals";
import {RLLAToECEF_radii} from "../src/LLA-ECEF-ENU";
import {getLocalNorthVector, getLocalUpVector} from "../src/SphericalMath";
import {radians} from "../src/utils";
import {MISB} from "../src/MISBUtils";
import {par} from "../src/par";

jest.mock("../src/EGM96Geoid", () => ({meanSeaLevelOffset: () => 20}));

function hud() {
    setSit({frames: 100, fps: 30, simSpeed: 1, lat: 34, lon: -118});
    setNodeMan({exists: () => false, get: () => undefined});
    const camera = new PerspectiveCamera(.527, 1);
    camera.position.copy(RLLAToECEF_radii(radians(34), radians(-118), 7620));
    const north = getLocalNorthVector(camera.position), up = getLocalUpVector(camera.position);
    const east = north.clone().cross(up);
    const forward = north.clone().add(east).normalize().multiplyScalar(Math.cos(radians(30)))
        .addScaledVector(up, -Math.sin(radians(30)));
    camera.up.copy(up);
    camera.lookAt(camera.position.clone().addScaledVector(forward, 1000));
    const row = [];
    row[MISB.PlatformHeadingAngle] = 10;
    row[MISB.PlatformRollAngle] = -20;
    row[MISB.SensorRelativeRollAngle] = 123;
    const track = {v: () => ({misbRow: row}), p: () => camera.position.clone()};
    const target = {p: f => camera.position.clone().addScaledVector(forward, 10000 - f)};
    const ui = Object.create(CNodeATFLIRUI.prototype);
    Object.assign(ui, {inputs: {camera: {camera}, cameraTrack: track, target}, trackDriven: true,
        readouts: {}, textAlt1000s: {}, textAlt000: {}, textElements: {fov: {}, zoom: {}}});
    return {ui, camera, row, track};
}

test('custom HUD uses current geometry, platform bank and local state', () => {
    const {ui, camera} = hud();
    const original = {...par};
    ui.updateTrackReadouts(30);
    expect(ui.readouts.az).toBeCloseTo(35, 5);
    expect(ui.readouts.el).toBeCloseTo(-30, 5);
    expect(ui.readouts.rng).toBeCloseTo(9970 / 1852, 6);
    expect(ui.readouts.Vc).toBeCloseTo(30 * 3600 / 1852, 6);
    expect(ui.readouts.time).toBe(1);
    expect(ui.bank).toBe(-20);
    expect(ui.textAlt1000s.text + ui.textAlt000.text).toBe(String(Math.round(7600 / .3048)));
    // Rolling the image does not rotate the aircraft's artificial horizon.
    camera.rotateZ(radians(60));
    ui.updateTrackReadouts(30);
    expect(ui.bank).toBe(-20);
    expect(ui.readouts.az).toBeCloseTo(35, 5);
    expect(par).toEqual(original);
});

test('fixed camera with no attitude leaves azimuth and bank unknown', () => {
    const {ui, track} = hud();
    track.v = () => ({position: new Vector3()});
    ui.updateTrackReadouts(30);
    expect(ui.readouts.az).toBeNull();
    expect(ui.bank).toBeNull();
    expect(ui.readouts.el).toBeCloseTo(-30, 5);
});

test('legacy altitude update still uses the supplied jet altitude', () => {
    const {ui} = hud();
    ui.trackDriven = false;
    ui.in.jetAltitude = {v0: 25000 * .3048};
    ui.update();
    expect(ui.textAlt1000s.text).toBe("25");
    expect(ui.textAlt000.text).toBe("000");
});

test('HUD air data responds to wind and uses recorded static pressure and temperature', () => {
    const {ui, row, track, camera} = hud();
    row[MISB.StaticPressure] = 376.0089; // hPa
    row[MISB.OutsideAirTemperature] = -34.53; // static degrees Celsius
    track.p = f => camera.position.clone().add(new Vector3(f * 200 / 30, 0, 0));
    const wind = {getValueFrame: () => new Vector3(20 / 30, 0, 0)};
    setNodeMan({exists: () => false, get: id => id === 'localWind' ? wind : undefined});
    ui.updateTrackReadouts(30);
    expect(ui.airData.tasMPS).toBeCloseTo(180, 6);
    expect(ui.airData.pressurePa).toBeCloseTo(37600.89);
    expect(ui.airData.temperatureK).toBeCloseTo(238.62);
    const withWind = ui.airData.casKnots;
    wind.getValueFrame = () => new Vector3();
    ui.updateTrackReadouts(30);
    expect(ui.airData.casKnots).toBeGreaterThan(withWind);
    delete row[MISB.StaticPressure];
    delete row[MISB.OutsideAirTemperature];
    ui.updateTrackReadouts(30);
    expect(ui.airData.pressureSource).toBe('standard atmosphere');
    expect(ui.airData.temperatureSource).toBe('standard atmosphere');
});

test('legacy configured TAS is not wind-corrected a second time', () => {
    const {ui} = hud();
    ui.trackDriven = false;
    ui.in.jetTAS = {v: () => 369};
    ui.updateAirData(30, null, null, 25000 * .3048);
    expect(ui.airData.tasMPS).toBeCloseTo(369 * 1852 / 3600);
    expect(ui.airData.casKnots).toBeCloseTo(254, 0);
    expect(ui.airData.mach).toBeCloseTo(.61, 2);
});
