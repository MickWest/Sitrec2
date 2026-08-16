import {PerspectiveCamera, Vector3} from 'three';

const mockParse = jest.fn();
const mockRotation = jest.fn();
const mockOrientation = jest.fn();
const mockUpdateViewFromPreset = jest.fn();
const mockMeanSeaLevelOffset = jest.fn();
const mockSetStartDateTime = jest.fn();
const mockEstablishDateTimeDefaults = jest.fn();
const mockSetRenderOne = jest.fn();
const mockForceUpdateUIText = jest.fn();
const mockIntersectSurface = jest.fn();
const mockSetLLA = jest.fn();
const mockTargetSetLLA = jest.fn();
const mockGoToPoint = jest.fn();
const mockRefresh = jest.fn();

const mockNodeMap = new Map();

jest.mock('exifr', () => ({
    __esModule: true,
    default: {
        parse: (...args) => mockParse(...args),
        rotation: (...args) => mockRotation(...args),
        orientation: (...args) => mockOrientation(...args),
    },
}));

jest.mock('../src/CViewManager', () => ({
    ViewMan: {
        updateViewFromPreset: (...args) => mockUpdateViewFromPreset(...args),
    },
}));

jest.mock('../src/LLA-ECEF-ENU', () => ({
    ECEFToLLAVD_radii: jest.fn((vector) => ({
        x: vector.x,
        y: vector.y,
        z: vector.z,
    })),
    LLAToECEF: jest.fn((lat, lon, alt) => {
        const {Vector3: ThreeVector3} = require('three');
        return new ThreeVector3(lat, lon, alt);
    }),
}));

jest.mock('../src/EGM96Geoid', () => ({
    meanSeaLevelOffset: (...args) => mockMeanSeaLevelOffset(...args),
    // The geoid grid is now lazily fetched; extractJPEGImportMetadata awaits this
    // before the synchronous meanSeaLevelOffset calls. No grid needed in this mock.
    ensureGeoidLoaded: () => Promise.resolve(),
}));

jest.mock('../src/Globals', () => ({
    GlobalDateTimeNode: {
        setStartDateTime: (...args) => mockSetStartDateTime(...args),
        // EXIFUtils calls this after setStartDateTime so the dropped image's
        // EXIF date becomes the date-slider reset target.
        establishDateTimeDefaults: (...args) => mockEstablishDateTimeDefaults(...args),
    },
    NodeMan: {
        get: jest.fn((id) => mockNodeMap.get(id) ?? false),
    },
    setRenderOne: (...args) => mockSetRenderOne(...args),
}));

jest.mock('../src/nodes/CNodeViewUI', () => ({
    forceUpdateUIText: (...args) => mockForceUpdateUIText(...args),
}));

jest.mock('../src/threeExt', () => ({
    intersectSurface: (...args) => mockIntersectSurface(...args),
}));

jest.mock('../src/SphericalMath', () => ({
    getLocalNorthVector: jest.fn(() => {
        const {Vector3: ThreeVector3} = require('three');
        return new ThreeVector3(0, 1, 0);
    }),
    getLocalUpVector: jest.fn(() => {
        const {Vector3: ThreeVector3} = require('three');
        return new ThreeVector3(0, 0, 1);
    }),
}));

jest.mock('../src/utils', () => ({
    atan: Math.atan,
    tan: Math.tan,
    degrees: (value) => value * 180 / Math.PI,
    m2f: (value) => value * 3.280839895,
    radians: (value) => value * Math.PI / 180,
}));

import {ECEFToLLAVD_radii, LLAToECEF} from '../src/LLA-ECEF-ENU';
import {applyImportedImageMetadata, extractJPEGImportMetadata} from '../src/EXIFUtils.js';

describe('extractJPEGImportMetadata', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('returns null for non-JPEG imports', async () => {
        const result = await extractJPEGImportMetadata(new ArrayBuffer(8), 'example.png');
        expect(result).toBeNull();
        expect(mockParse).not.toHaveBeenCalled();
    });

    test('extracts and normalizes useful EXIF fields from JPEG metadata', async () => {
        mockParse.mockResolvedValue({
            Make: 'DJI',
            Model: 'Mavic 3',
            LensModel: 'Hasselblad',
            DateTimeOriginal: '2024-05-01T12:34:56.000Z',
            GPSLatitude: '34.5',
            GPSLongitude: {numerator: -236, denominator: 2},
            GPSAltitude: {numerator: 301, denominator: 2},
            GPSImgDirection: -10,
            PosePitchDegrees: -12.5,
            PoseRollDegrees: 190,
            FocalLength: {numerator: 24, denominator: 1},
            FocalLengthIn35mmFormat: 50,
            DigitalZoomRatio: 1,
            FNumber: 2.8,
            ISO: 200,
            ExifImageWidth: 4000,
            ExifImageHeight: 3000,
        });
        mockRotation.mockResolvedValue({deg: 90, scaleX: -1, scaleY: 1});
        mockOrientation.mockResolvedValue(6);

        const result = await extractJPEGImportMetadata(new ArrayBuffer(8), 'photo.jpeg');

        expect(result.camera).toEqual(expect.objectContaining({
            make: 'DJI',
            model: 'Mavic 3',
            lensModel: 'Hasselblad',
        }));
        expect(result.capture).toEqual(expect.objectContaining({
            date: '2024-05-01T12:34:56.000Z',
            dateSource: 'DateTimeOriginal',
        }));
        expect(result.image).toEqual(expect.objectContaining({
            orientation: 6,
            rotationDegrees: 90,
            mirroredX: true,
            mirroredY: false,
        }));
        expect(result.placement).toEqual(expect.objectContaining({
            latitude: 34.5,
            longitude: -118,
            altitude: 150.5,
            heading: 350,
            pitch: -12.5,
            // The camera's roll and the EXIF orientation can describe the same physical turn, so
            // the display rotation is subtracted to avoid applying it twice. This fixture rolls
            // -170 and rotates 90, giving -260 -> +100. (Verified against a real DJI Mini 3 Pro
            // vertical shot: GimbalRollDegree -90 with orientation 8 / 270 deg gives exactly 0,
            // a level horizon. Adding instead of subtracting would give 180 - upside down.)
            roll: 100,
            hasLocation: true,
            hasOrientation: true,
        }));
        expect(result.optics.focalLengthMm).toBe(24);
        expect(result.optics.focalLength35mm).toBe(50);
        // A 35mm-equivalent focal length describes the frame's LONG axis against the 36mm long
        // side of the full-frame gate. This fixture is 4000x3000 stored with orientation 6
        // (rotate 90 CW), so it is DISPLAYED as 3000x4000 - portrait, long axis vertical - and
        // the vertical field is the long-axis field directly: 2*atan(18/50) = 39.60 deg.
        // (The old 26.99 was 2*atan(24/50), which assumed every frame was 3:2 landscape.)
        expect(result.optics.verticalFovDeg).toBeCloseTo(39.60, 1);
        expect(result.optics.fNumber).toBe(2.8);
        expect(result.optics.iso).toBe(200);
    });
});

describe('applyImportedImageMetadata', () => {
    let lookCameraNode;
    let mainCameraNode;
    let mainView;
    let targetTrackSwitchSmooth;
    let ptzAngles;
    let fixedCameraPosition;
    let fixedTargetPositionWind;

    beforeEach(() => {
        jest.clearAllMocks();
        mockNodeMap.clear();

        const camera = new PerspectiveCamera(60, 1, 0.1, 10000);
        camera.position.set(0, 0, 0);
        camera.updateMatrixWorld();

        lookCameraNode = {
            id: 'lookCamera',
            camera,
            snapshotCamera: jest.fn(),
        };

        mainCameraNode = {
            id: 'mainCamera',
            camera: new PerspectiveCamera(60, 1, 0.1, 10000),
            goToPoint: (...args) => mockGoToPoint(...args),
        };

        mainView = {
            id: 'mainView',
            camera: mainCameraNode.camera,
            controls: {
                target: new Vector3(),
                targetIsTerrain: true,
                update: jest.fn(),
            },
        };

        targetTrackSwitchSmooth = {id: 'targetTrackSwitchSmooth'};
        ptzAngles = {
            az: 0,
            el: 0,
            roll: 0,
            fov: 60,
            refresh: (...args) => mockRefresh(...args),
        };
        fixedCameraPosition = {
            id: 'fixedCameraPosition',
            setLLA: (...args) => mockSetLLA(...args),
        };
        fixedTargetPositionWind = {
            id: 'fixedTargetPositionWind',
            setLLA: (...args) => mockTargetSetLLA(...args),
        };

        mockNodeMap.set('lookCamera', lookCameraNode);
        mockNodeMap.set('mainCamera', mainCameraNode);
        mockNodeMap.set('mainView', mainView);
        mockNodeMap.set('lookView', {id: 'lookView'});
        mockNodeMap.set('video', {id: 'video'});
        mockNodeMap.set('ptzAngles', ptzAngles);
        mockNodeMap.set('fixedCameraPosition', fixedCameraPosition);
        mockNodeMap.set('fixedTargetPositionWind', fixedTargetPositionWind);
        mockNodeMap.set('targetTrackSwitchSmooth', targetTrackSwitchSmooth);

        mockMeanSeaLevelOffset.mockImplementation((lat, lon) => lat === 11 && lon === 22 ? 30 : 25);
        mockIntersectSurface.mockReturnValue(new Vector3(11, 22, 333));
    });

    test('applies EXIF placement, time, and view layout through repo nodes', () => {
        const metadata = {
            camera: {make: 'DJI'},
            capture: {date: '2024-05-01T12:34:56.000Z'},
            optics: {
                verticalFovDeg: 42.5,
            },
            placement: {
                hasLocation: true,
                latitude: 34.5,
                longitude: -118.25,
                altitude: 100,
                altitudeReference: 'MSL',
                heading: 123.4,
                pitch: -12.3,
                roll: 5.6,
            },
        };

        const applied = applyImportedImageMetadata(metadata, 'photo.jpg');

        expect(mockSetLLA).toHaveBeenCalledWith(34.5, -118.25, 100);
        expect(LLAToECEF).toHaveBeenCalledWith(34.5, -118.25, 125);
        expect(lookCameraNode.camera.position).toEqual(new Vector3(34.5, -118.25, 125));
        expect(mockSetStartDateTime).toHaveBeenCalledWith(new Date('2024-05-01T12:34:56.000Z'));
        expect(mockEstablishDateTimeDefaults).toHaveBeenCalled();
        expect(mockGoToPoint).toHaveBeenCalledWith(new Vector3(34.5, -118.25, 125), 2300000, 100000);
        expect(mockRefresh).toHaveBeenCalled();
        expect(ptzAngles.az).toBe(123.4);
        expect(ptzAngles.el).toBe(-12.3);
        expect(ptzAngles.roll).toBeCloseTo(5.6, 5);
        expect(ptzAngles.fov).toBe(42.5);
        // Importing an image does NOT reposition the views when a video view exists. Laying out
        // views is the view-preset system's job - the same one a dropped video goes through -
        // and it has already run by this point, from the videoLoaded event. This module used to
        // impose its own hardcoded table on top, which is why a dropped image landed bottom-right
        // while a dropped video landed top-right in the same sitch. Note the table was never read
        // from the file: no JPEG ever asked for that layout.
        expect(mockUpdateViewFromPreset).not.toHaveBeenCalled();
        expect(applied.viewLayout).toBeUndefined();
        expect(mockForceUpdateUIText).toHaveBeenCalled();
        expect(lookCameraNode.snapshotCamera).toHaveBeenCalled();
        expect(mockSetRenderOne).toHaveBeenCalled();
        expect(applied).toEqual(expect.objectContaining({
            cameraPositionNode: 'fixedCameraPosition',
            verticalFov: '42.50 deg',
            heading: '123.4 deg',
            pitch: '-12.3 deg',
            roll: '5.6 deg',
            dateTime: '2024-05-01T12:34:56.000Z',
        }));
    });
});