import {PerspectiveCamera, Vector3} from 'three';

const mockParse = jest.fn();
const mockRotation = jest.fn();
const mockOrientation = jest.fn();
const mockUpdateViewFromPreset = jest.fn();
const mockMeanSeaLevelOffset = jest.fn();
const mockSetStartDateTime = jest.fn();
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
            roll: -170,
            hasLocation: true,
            hasOrientation: true,
        }));
        expect(result.optics.focalLengthMm).toBe(24);
        expect(result.optics.focalLength35mm).toBe(50);
        expect(result.optics.verticalFovDeg).toBeCloseTo(26.99, 1);
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
        expect(mockGoToPoint).toHaveBeenCalledWith(new Vector3(34.5, -118.25, 125), 2300000, 100000);
        expect(mockRefresh).toHaveBeenCalled();
        expect(ptzAngles.az).toBe(123.4);
        expect(ptzAngles.el).toBe(-12.3);
        expect(ptzAngles.roll).toBeCloseTo(5.6, 5);
        expect(ptzAngles.fov).toBe(42.5);
        expect(mockUpdateViewFromPreset).toHaveBeenCalledTimes(3);
        expect(mockUpdateViewFromPreset).toHaveBeenNthCalledWith(1, 'mainView', expect.objectContaining({name: 'mainView'}));
        expect(mockUpdateViewFromPreset).toHaveBeenNthCalledWith(2, 'lookView', expect.objectContaining({name: 'lookView'}));
        expect(mockUpdateViewFromPreset).toHaveBeenNthCalledWith(3, 'video', expect.objectContaining({name: 'video'}));
        expect(mockForceUpdateUIText).toHaveBeenCalled();
        expect(lookCameraNode.snapshotCamera).toHaveBeenCalled();
        expect(mockSetRenderOne).toHaveBeenCalled();
        expect(applied).toEqual(expect.objectContaining({
            cameraPositionNode: 'fixedCameraPosition',
            viewLayout: 'mainView, lookView, video',
            verticalFov: '42.50 deg',
            heading: '123.4 deg',
            pitch: '-12.3 deg',
            roll: '5.6 deg',
            dateTime: '2024-05-01T12:34:56.000Z',
        }));
    });
});