// "Use Relative Altitude" (Camera > Location, added when a drone photo is imported) puts the
// camera at the ground height plus the photo's height above takeoff. When the camera's
// "Above Ground Level" box is on, the position node reads its altitude as metres ABOVE THE
// GROUND, so the relative height must go in as it is. Passing the MSL sum there counted the
// ground twice (Metabunk thread 15147, same fault as "Set Camera on Ground").
//
// applyRelativeAltitude is module-private, so this goes in through the exported import path:
// applyImportedImageCameraPosition offers the button, and the test clicks it. The geoid offset
// is not zero, so a mix-up between MSL and HAE ground heights shows in the result.
import {PerspectiveCamera, Vector3} from 'three';

const GEOID = -33;                      // meanSeaLevelOffset: HAE = MSL + GEOID
const GROUND_MSL = 800;
const GROUND_HAE = GROUND_MSL + GEOID;  // what the terrain mock returns
const LAT = 34.5;
const LON = -118.25;
const RELATIVE_ALTITUDE = 42;
const PHOTO_ALTITUDE_MSL = 900;         // above the ground, so no "underground" dialog

const mockNodeMap = new Map();
const mockShowChoice = jest.fn();
const mockButton = {
    perm() { return this; },
    tooltip() { return this; },
    name() { return this; },
    show() { return this; },
    hide() { return this; },
};
// The module makes the button once and keeps it, so the object it binds is kept here too.
let mockRelativeAltitudeHost = null;

jest.mock('../src/CViewManager', () => ({
    ViewMan: {updateViewFromPreset: jest.fn()},
}));

jest.mock('../src/LLA-ECEF-ENU', () => ({
    // Identity stand-ins: an "ECEF" point is (lat, lon, HAE).
    ECEFToLLAVD_radii: jest.fn((vector) => ({x: vector.x, y: vector.y, z: vector.z})),
    LLAToECEF: jest.fn((lat, lon, alt) => {
        const {Vector3: ThreeVector3} = require('three');
        return new ThreeVector3(lat, lon, alt);
    }),
}));

jest.mock('../src/EGM96Geoid', () => ({
    meanSeaLevelOffset: () => -33,      // = GEOID
    ensureGeoidLoaded: () => Promise.resolve(),
}));

jest.mock('../src/Globals', () => ({
    GlobalDateTimeNode: {},
    guiMenus: {
        cameraLocation: {
            add: (host) => {
                mockRelativeAltitudeHost = host;
                return mockButton;
            },
        },
    },
    NodeMan: {
        get: jest.fn((id) => mockNodeMap.get(id)),
    },
    setRenderOne: jest.fn(),
}));

jest.mock('../src/nodes/CNodeViewUI', () => ({forceUpdateUIText: jest.fn()}));
jest.mock('../src/threeExt', () => ({intersectSurface: jest.fn()}));
jest.mock('../src/SphericalMath', () => ({
    getLocalNorthVector: jest.fn(),
    getLocalUpVector: jest.fn(),
}));
jest.mock('../src/utils', () => ({
    atan: Math.atan,
    tan: Math.tan,
    degrees: (value) => value * 180 / Math.PI,
    m2f: (value) => value * 3.280839895,
    radians: (value) => value * Math.PI / 180,
}));
jest.mock('../src/showError', () => ({
    showChoice: (...args) => mockShowChoice(...args),
}));
jest.mock('../src/CEventManager', () => ({
    EventManager: {addEventListener: jest.fn(), removeEventListener: jest.fn()},
}));

import {applyImportedImageCameraPosition} from '../src/EXIFUtils.js';

describe('Use Relative Altitude with Above Ground Level', () => {
    let fixedCameraPosition;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        mockNodeMap.clear();

        const camera = new PerspectiveCamera(60, 1, 0.1, 10000);
        mockNodeMap.set('lookCamera', {id: 'lookCamera', camera, snapshotCamera: jest.fn()});

        fixedCameraPosition = {
            id: 'fixedCameraPosition',
            agl: false,
            aglController: {updateDisplay: jest.fn()},
            setLLA: jest.fn(),
        };
        mockNodeMap.set('fixedCameraPosition', fixedCameraPosition);

        mockNodeMap.set('TerrainModel', {
            getPointBelowWithTileInfo: jest.fn(() => ({
                point: new Vector3(LAT, LON, GROUND_HAE),
                tileZ: 14,
            })),
        });
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    // Import a drone photo, let the ground wait run out, and return the button's action.
    async function importDronePhoto() {
        const applied = applyImportedImageCameraPosition({
            placement: {
                hasLocation: true,
                latitude: LAT,
                longitude: LON,
                altitude: PHOTO_ALTITUDE_MSL,
                altitudeReference: 'MSL',
                relativeAltitude: RELATIVE_ALTITUDE,
            },
        }, 'drone.jpg');
        expect(applied.cameraPositionNode).toBe('fixedCameraPosition');

        // The import itself places the camera at the photo's MSL altitude.
        expect(fixedCameraPosition.setLLA).toHaveBeenCalledWith(LAT, LON, PHOTO_ALTITUDE_MSL);

        // offerRelativeAltitude waits for the elevation to settle (2 s quiet, 30 s limit).
        await jest.runAllTimersAsync();
        expect(mockShowChoice).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);

        expect(typeof mockRelativeAltitudeHost?.useRelativeAltitude).toBe('function');
        fixedCameraPosition.setLLA.mockClear();
        return mockRelativeAltitudeHost.useRelativeAltitude;
    }

    test('AGL on: the relative altitude goes in as the height above the ground', async () => {
        const useRelativeAltitude = await importDronePhoto();

        // The import turns AGL off for a photo with a real altitude; the user then ticks it.
        fixedCameraPosition.agl = true;
        useRelativeAltitude();

        expect(fixedCameraPosition.setLLA).toHaveBeenCalledTimes(1);
        const [lat, lon, alt] = fixedCameraPosition.setLLA.mock.calls[0];
        expect(lat).toBe(LAT);
        expect(lon).toBe(LON);
        expect(alt).toBe(RELATIVE_ALTITUDE);
    });

    test('AGL off: the altitude is the ground MSL height plus the relative altitude', async () => {
        const useRelativeAltitude = await importDronePhoto();

        expect(fixedCameraPosition.agl).toBe(false);
        useRelativeAltitude();

        expect(fixedCameraPosition.setLLA).toHaveBeenCalledTimes(1);
        const [lat, lon, alt] = fixedCameraPosition.setLLA.mock.calls[0];
        expect(lat).toBe(LAT);
        expect(lon).toBe(LON);
        expect(alt).toBe(GROUND_MSL + RELATIVE_ALTITUDE);
    });
});
