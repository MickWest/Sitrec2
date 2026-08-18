import {Vector3} from "three";

jest.mock("../../src/nodes/CNodeViewUI", () => ({
    CNodeViewUI: class {}
}));

jest.mock("../../src/assert", () => ({
    assert: jest.fn()
}));

jest.mock("../../src/Globals", () => ({
    Globals: {exportTagNumber: 0},
    NodeMan: {},
    Sit: {frames: 0}
}));

jest.mock("../../src/utils", () => ({
    radians: (degrees) => degrees * Math.PI / 180
}));

jest.mock("../../src/nodes/CNodeControllerVarious", () => ({
    extractFOV: (value) => value
}));

// Settable, so a test can produce a real drag delta rather than a zero one. Jest
// permits a mock factory to close over a variable whose name begins with "mock".
let mockMouseCanvas = [0, 0];

jest.mock("../../src/ViewUtils", () => ({
    mouseToCanvas: () => mockMouseCanvas
}));

jest.mock("../../src/nodes/CNodeVideoView", () => ({
    CNodeVideoView: class {}
}));

jest.mock("../../src/CEventManager", () => ({
    EventManager: {
        addEventListener: jest.fn(),
        removeEventListener: jest.fn()
    }
}));

const {Sit} = require("../../src/Globals");
const {CNodeTrackingOverlay, CNodeVideoTrackKeyframeB} = require("../../src/nodes/CNodeTrackingOverlay.js");

describe("CNodeTrackingOverlay no-video guards", () => {
    test("getValueFrame falls back to camera LOS when video geometry is unavailable", () => {
        const baseLOS = {
            position: new Vector3(1, 2, 3),
            heading: new Vector3(0, 0, -1),
            up: new Vector3(0, 1, 0),
            right: new Vector3(1, 0, 0)
        };

        const overlay = {
            in: {
                cameraLOSNode: {
                    getValueFrame: jest.fn(() => baseLOS)
                },
                fovNode: {
                    getValueFrame: jest.fn(() => 30)
                }
            },
            overlayView: {
                videoWidth: 0,
                videoHeight: 0,
                originalVideoWidth: 0,
                originalVideoHeight: 0
            },
            hasVideoGeometry: CNodeTrackingOverlay.prototype.hasVideoGeometry,
            ensureOverlayGeometryReady: CNodeTrackingOverlay.prototype.ensureOverlayGeometryReady
        };

        const result = CNodeTrackingOverlay.prototype.getValueFrame.call(overlay, 0);

        expect(result).toBe(baseLOS);
        expect(overlay.in.cameraLOSNode.getValueFrame).toHaveBeenCalledWith(0);
        expect(result.heading.equals(baseLOS.heading)).toBe(true);
    });

    test("updateCurve keeps placeholder points finite before a video is loaded", () => {
        const originalFrames = Sit.frames;
        Sit.frames = 3;

        const overlay = {
            keyframes: [],
            overlayView: {
                widthPx: 640,
                heightPx: 480,
                videoWidth: 0,
                videoHeight: 0,
                originalVideoWidth: 0,
                originalVideoHeight: 0
            },
            hasVideoGeometry: CNodeTrackingOverlay.prototype.hasVideoGeometry,
            getFallbackTrackPoint: CNodeTrackingOverlay.prototype.getFallbackTrackPoint
        };

        try {
            CNodeTrackingOverlay.prototype.updateCurve.call(overlay);

            expect(overlay.pointsXY).toEqual([
                [320, 240],
                [320, 240],
                [320, 240]
            ]);

            for (const [x, y] of overlay.pointsXY) {
                expect(Number.isFinite(x)).toBe(true);
                expect(Number.isFinite(y)).toBe(true);
            }
        } finally {
            Sit.frames = originalFrames;
        }
    });
});

describe("Point B counts as a measurement only once it has moved", () => {
    // A B handle starts at DEFAULT_B_OFFSET_PIXELS from its A keyframe. That default
    // offset is not a measurement, and must never reach the range, speed or start
    // distance paths. Only the drag bookkeeping is under test, so the view and
    // partner plumbing is stubbed.
    function makeB(x, y) {
        const b = Object.create(CNodeVideoTrackKeyframeB.prototype);
        b.x = x;
        b.y = y;
        b.isB = true;
        b.edited = false;
        b.dragging = false;
        b.partner = {frame: 0};
        return b;
    }

    test("a click that does not move the handle leaves it unmeasured", () => {
        const b = makeB(100, 50);

        b.startDrag(0, 0);
        b.noteDragged();

        expect(b.edited).toBe(false);
    });

    test("a drag that moves the handle promotes it to a measurement", () => {
        const b = makeB(100, 50);

        b.startDrag(0, 0);
        b.x = 118;                  // onMouseDrag writes straight to x and y
        b.noteDragged();

        expect(b.edited).toBe(true);
    });

    test("a B carried along by its A keyframe does not become a measurement", () => {
        const video = {
            videoToCanvasCoordsOriginal: (x, y) => [x, y],
            canvasToVideoCoordsOriginal: (x, y) => [x, y]
        };

        const b = makeB(120, 50);
        b.video = video;

        const a = {
            video,
            x: 100,
            y: 50,
            isB: false,
            dragging: true,
            bPoint: b,
            get cX() { return this.x; },
            get cY() { return this.y; }
        };

        const overlay = {
            draggable: [a, b],
            lastMouseX: 0,
            lastMouseY: 0,
            recalculateCascade: jest.fn()
        };

        mockMouseCanvas = [10, 0];
        try {
            CNodeTrackingOverlay.prototype.onMouseDrag.call(overlay, {}, 0, 0);
        } finally {
            mockMouseCanvas = [0, 0];
        }

        // A moved, and carried B with it, so the AB span is unchanged...
        expect(a.x).toBe(110);
        expect(b.x).toBe(130);
        // ...but the user never touched B, so it is still not a measurement.
        expect(b.edited).toBe(false);
    });
});
