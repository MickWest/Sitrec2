/** @jest-environment jsdom */
import {Vector3} from "three";
import {CNodeDisplayNightSky} from "../src/nodes/CNodeDisplayNightSky";
import {setSit} from "../src/Globals";

function makeSky() {
    setSit({satCutOff: 0.06, flareScale: 0.2});
    const node = Object.create(CNodeDisplayNightSky.prototype);
    node.camera = {position: new Vector3(6378137 + 100, 0, 0)};
    node.globe = {center: new Vector3()};
    node.satelliteMagnitudeLimitEnabled = true;
    node.satelliteMagnitudeLimit = 7.5;
    node.firstRenderTLE = true;
    const satData = [
        {magnitude: 7.5, rangeM: 100000},
        {magnitude: 7.5, rangeM: 35000000},
        {magnitude: 7.51, rangeM: 35000000},
        {magnitude: 2, rangeM: 1000000, illumination: 0},
    ].map((appearance, i) => ({
        number: i, visible: true,
        ecef: node.camera.position.clone().add(new Vector3(appearance.rangeM, 0, 0)),
        appearance: {...appearance, flux: 10 ** (-0.4 * appearance.magnitude)},
    }));
    node.satellites = {
        showSatellites: true,
        brightnessModel: "Photometric estimate",
        toSun: new Vector3(0, 1, 0), flareAngle: 5,
        TLEData: {satData},
        lightCloud: {material: {}, brightnessArray: new Float32Array(4), mainBrightnessArray: new Float32Array(4),
            markBrightnessNeedUpdate: jest.fn()},
        getSatelliteIllumination: p => satData.find(s => s.ecef === p).appearance.illumination ?? 1,
        getSatelliteAppearance: s => s.appearance,
        getSatelliteNormal: () => new Vector3(1, 0, 0),
        removeSatSunArrows: jest.fn(), removeSatelliteArrows: jest.fn(),
    };
    return node;
}

test("the apparent magnitude limit is inclusive and independent of range compensation", () => {
    const sky = makeSky();
    sky.updateSatelliteBrightness();
    const values = sky.satellites.lightCloud.brightnessArray;
    expect(values[0]).toBeGreaterThan(0);
    expect(values[1]).toBeGreaterThan(0);
    expect(values[2]).toBe(0);
    expect(values[3]).toBe(0); // Eclipse stays invisible regardless of the limit.
});

test("disabling the magnitude limit preserves the old cut-off and main overview", () => {
    const sky = makeSky();
    sky.updateSatelliteBrightness();
    const main = [...sky.satellites.lightCloud.mainBrightnessArray];
    sky.satelliteMagnitudeLimitEnabled = false;
    sky.fullBrightnessUpdate = true;
    sky.updateSatelliteBrightness();
    expect(sky.satellites.lightCloud.brightnessArray[0]).toBe(0);
    expect(sky.satellites.lightCloud.brightnessArray[2]).toBeGreaterThan(0);
    expect([...sky.satellites.lightCloud.mainBrightnessArray]).toEqual(main);
});

test("changing a magnitude limit refreshes every satellite in a paused frame", () => {
    const sky = makeSky();
    sky.updateSatelliteBrightness();
    sky.satelliteMagnitudeLimit = 8;
    sky.fullBrightnessUpdate = true;
    sky.updateSatelliteBrightness();
    expect(sky.satellites.lightCloud.brightnessArray[2]).toBeGreaterThan(0);
    expect(sky.fullBrightnessUpdate).toBe(false);
});

test("the legacy cone model ignores the photometric limit", () => {
    const sky = makeSky();
    sky.satellites.brightnessModel = "Legacy cone";
    sky.satelliteMagnitudeLimit = -5;
    sky.updateSatelliteBrightness();
    expect(sky.satellites.lightCloud.brightnessArray[0]).toBeGreaterThan(0);
    expect(sky.satellites.lightCloud.brightnessArray[2]).toBeGreaterThan(0);
});
