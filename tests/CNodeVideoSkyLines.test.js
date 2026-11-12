import {Matrix4} from "three";

// The look view and its camera: at the origin, looking along -z, with +x right and +y up.
const mockLookView = {camera: null};

jest.mock("../src/nodes/CNodeViewUI", () => ({CNodeViewUI: class {
    constructor(v) {
        this.overlayView = v.overlayView;
        this.widthPx = 800;
        this.heightPx = 600;
    }
    renderCanvas() {}
}}));
jest.mock("../src/Globals", () => ({
    Globals: {equatorRadius: 6378137, polarRadius: 6356752.314245},
    NodeMan: {get: () => mockLookView},
    Sit: {refractionEnabled: false},
}));
jest.mock("../src/ViewUtils", () => ({withDisplayedCamera: (view, fn) => fn(view.camera)}));
jest.mock("../src/FisheyeProjection", () => ({fisheyeViewToNDC: jest.fn(), isFisheyeCamera: () => false}));
jest.mock("../src/PanoramicCamera", () => ({isPanoramicCamera: () => false, panoramic: {hfov: 180}}));
jest.mock("../src/rendering/PanoramaMath", () => ({panoramaFrame: () => ({vfov: 90}), panoramaProject: jest.fn()}));
jest.mock("../src/FlowAlignment", () => ({getFlowAlignRotation: () => 0}));
// The local horizon frame is the same as the sky's frame here: east +x, north +y, up +z.
jest.mock("../src/HorizonCompassRibbon", () => ({horizonCompassFrame: () => ({
    east: {x: 1, y: 0, z: 0}, north: {x: 0, y: 1, z: 0}, up: {x: 0, y: 0, z: 1},
})}));

const {CNodeVideoSkyLines} = require("../src/nodes/CNodeVideoSkyLines");

const WIDTH = 800, HEIGHT = 600, VFOV = 30;
const FOCAL = HEIGHT / (2 * Math.tan(VFOV * Math.PI / 360));   // pixels
const DEG = Math.PI / 180;

// A direction that is `right` degrees to the right of the camera's axis and `up` degrees above it.
const toward = (right, up = 0) => [Math.sin(right * DEG) * Math.cos(up * DEG), Math.sin(up * DEG),
    -Math.cos(right * DEG) * Math.cos(up * DEG)];

function line(points, topology) {
    const attribute = {count: points.length, getX: i => points[i][0], getY: i => points[i][1], getZ: i => points[i][2]};
    return {topology, sourceGeometry: {getAttribute: () => attribute}};
}

// Draw the given lines and return the segments that reached the canvas.
function draw({constellations = [], equatorial = [], azimuthal = []}) {
    mockLookView.camera = {fov: VFOV, matrixWorld: new Matrix4(), matrixWorldInverse: new Matrix4()};
    const segments = [];
    let pen = null;
    const ctx = {
        save() {}, restore() {}, translate() {}, rotate() {}, beginPath() {}, rect() {}, clip() {}, stroke() {},
        moveTo(x, y) { pen = [x, y]; },
        lineTo(x, y) { segments.push([...pen, x, y]); pen = [x, y]; },
    };
    const video = {videoWidth: WIDTH, videoHeight: HEIGHT, getSourceAndDestCoords() {},
        sx: 0, sy: 0, sWidth: WIDTH, sHeight: HEIGHT, dx: 0, dy: 0, dWidth: WIDTH, dHeight: HEIGHT};
    const overlay = new CNodeVideoSkyLines({overlayView: video, nightSky: {
        celestialSphere: {matrix: new Matrix4()},
        celestialLineWidth: 0.25,
        showConstellationsVideo: constellations.length > 0,
        showEquatorialGridVideo: equatorial.length > 0,
        showAzimuthalGridVideo: azimuthal.length > 0,
        celestialElements: {constellationLines: constellations, celestialGridLines: equatorial, azimuthalGridLines: azimuthal},
    }});
    overlay.ctx = ctx;
    overlay.renderCanvas(0);
    return segments;
}

test("the overlay asks the view manager to hide its canvas when it is switched off", () => {
    // Without this the lines drawn last stay on the video after the last V box is cleared:
    // a view that is off is not drawn again, so nothing clears its canvas.
    const overlay = new CNodeVideoSkyLines({overlayView: {}, nightSky: {}});
    expect(overlay.separateVisibility).toBe(true);
    expect(overlay.skipModSerialize).toBe(true);
});

describe("constellation lines, which are long segments from star to star", () => {
    test("a line to a star far outside the picture is drawn to the edge", () => {
        // One star at the centre of the picture, the other 40 degrees to the right. The
        // corner of the picture is 24 degrees from the centre.
        const [segment] = draw({constellations: [line([toward(0), toward(40)], "segments")]});
        expect(segment[0]).toBeCloseTo(WIDTH / 2, 6);
        expect(segment[1]).toBeCloseTo(HEIGHT / 2, 6);
        expect(segment[2]).toBeCloseTo(WIDTH / 2 + FOCAL * Math.tan(40 * DEG), 6);
        expect(segment[2]).toBeGreaterThan(WIDTH);
        expect(segment[3]).toBeCloseTo(HEIGHT / 2, 6);
    });

    test("a line to a star behind the camera is cut, and the part in front is drawn", () => {
        const [segment] = draw({constellations: [line([toward(0, 5), toward(120, 5)], "segments")]});
        expect(segment[0]).toBeCloseTo(WIDTH / 2, 6);
        expect(segment[1]).toBeCloseTo(HEIGHT / 2 - FOCAL * Math.tan(5 * DEG), 6);
        expect(segment[2]).toBeGreaterThan(WIDTH);
        expect(Number.isFinite(segment[2])).toBe(true);
    });

    test("a line with both stars behind the camera, or wholly to one side, is not drawn", () => {
        expect(draw({constellations: [line([toward(120), toward(150)], "segments")]})).toEqual([]);
        expect(draw({constellations: [line([toward(40), toward(60)], "segments")]})).toEqual([]);
    });

    test("separate segments are not joined to each other", () => {
        const segments = draw({constellations: [line([toward(-5), toward(-2), toward(2), toward(5)], "segments")]});
        expect(segments).toHaveLength(2);
        expect(segments[0][2]).toBeLessThan(WIDTH / 2);
        expect(segments[1][0]).toBeGreaterThan(WIDTH / 2);
    });
});

describe("grid lines, which are strips of short steps", () => {
    const meridian = right => line(Array.from({length: 21}, (unused, i) => toward(right, -18 + i * 1.8)), "strip");

    test("a strip across the picture is one joined line", () => {
        const segments = draw({equatorial: [meridian(3)]});
        expect(segments.length).toBeGreaterThan(10);
        for (let i = 1; i < segments.length; i++) {
            expect(segments[i].slice(0, 2)).toEqual(segments[i - 1].slice(2));
        }
    });

    test("a strip that is far from the picture is not drawn", () => {
        expect(draw({equatorial: [meridian(60)]})).toEqual([]);
        expect(draw({azimuthal: [meridian(150)]})).toEqual([]);
    });
});
