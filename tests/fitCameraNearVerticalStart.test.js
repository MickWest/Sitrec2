/** @jest-environment jsdom */
// Fit Camera to Points: a look camera left pointing near straight down must not stop every fit.
//
// Forum report: after a bad fit the look camera pointed straight down, and every Fit Now then
// stopped with "Camera is within 5 deg of vertical — cannot fit", with nothing the user could
// press to get out. The 85 deg limit protects the solver's az/el/roll parameters, not the
// answer, so runFit now starts the solve from the pose tilted back to the limit. These tests
// drive the real runFit and the real solver on a synthetic camera with a known answer.

window.matchMedia ??= () => ({matches: false, addEventListener() {}, removeEventListener() {}});

jest.mock("../src/Globals", () => {
    const state = {};
    const nodeMan = {get: () => null};
    const inert = new Proxy({}, {get: (_, key) => key === "then" ? undefined : inert});
    return new Proxy({}, {get: (_, key) => key === "Globals" ? state
        : key === "NodeMan" ? nodeMan
        : () => inert});
});

const {CNodeFitCameraPoints} = require("../src/nodes/CNodeFitCameraPoints");
const {
    basisFromAzElRoll, clampStartElevation, MAX_ABS_EL, projectWorldPoint,
} = require("../src/CameraPointFit");
const {lensFromVFOV} = require("../src/CameraLens");

const SIZE = [1920, 1080];
const R_EARTH = 6378137;
const DEG = Math.PI / 180;

// A spherical Earth and its local frame, as in CameraPointFit.test.js: the solver uses whatever
// frame it is handed, so a simple consistent one is enough.
function llaToEcef(latDeg, lonDeg, alt) {
    const lat = latDeg * DEG, lon = lonDeg * DEG;
    const r = R_EARTH + alt;
    return [r * Math.cos(lat) * Math.cos(lon), r * Math.cos(lat) * Math.sin(lon), r * Math.sin(lat)];
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => { const n = Math.hypot(a[0], a[1], a[2]); return [a[0] / n, a[1] / n, a[2] / n]; };
function localFrame(pos) {
    const up = unit(pos);
    const d = dot([0, 0, 1], up);
    return {up, north: unit(sub([0, 0, 1], [up[0] * d, up[1] * d, up[2] * d]))};
}

// An aircraft at 10 km looking out and down at landmarks 28-40 km away: the shape of the
// reported clip, where the camera is nowhere near vertical.
const CAM_LLA = [39.6, 19.9, 10000];
const CAM_POS = llaToEcef(...CAM_LLA);
const TRUTH = {azDeg: 18, elDeg: -17, rollDeg: 0, vfovDeg: 26};

function landmarkLLA(rangeM, bearingDeg, alt) {
    const b = bearingDeg * DEG;
    return {
        lat: CAM_LLA[0] + (rangeM * Math.cos(b)) / R_EARTH / DEG,
        lon: CAM_LLA[1] + (rangeM * Math.sin(b)) / (R_EARTH * Math.cos(CAM_LLA[0] * DEG)) / DEG,
        alt,
    };
}

function makePoints() {
    const fr = localFrame(CAM_POS);
    const camera = {
        position: CAM_POS,
        basis: basisFromAzElRoll(fr.up, fr.north, TRUTH.azDeg, TRUTH.elDeg, TRUTH.rollDeg),
        focalScale: 1,
    };
    const lens = lensFromVFOV(TRUTH.vfovDeg, SIZE);
    return [[30000, 10, 0], [35000, 25, 0], [28000, 20, 50], [40000, 15, 0]].map((l, i) => {
        const p = landmarkLLA(...l);
        const [vx, vy] = projectWorldPoint(camera, llaToEcef(p.lat, p.lon, p.alt), lens, SIZE);
        return {id: `p${i}`, vx, vy, ...p, seeded: false};
    });
}

/** The node with everything a fit touches outside the solve stubbed out. */
function fitHost(startState) {
    return Object.assign(Object.create(CNodeFitCameraPoints.prototype), {
        enabled: true, applyingFit: false, fitMethod: "direct",
        lockPosition: false, lockFOV: false, lockRoll: true, syncLookCamera: true,
        overlayView: {originalVideoWidth: SIZE[0], originalVideoHeight: SIZE[1]},
        points: makePoints(),
        freeLookOn: () => false,
        onCorrectFrame: () => true,
        currentCameraState: () => startState,
        localFrameAt: (pos) => localFrame(pos),
        pointECEF: (p) => {
            const [x, y, z] = llaToEcef(p.lat, p.lon, p.alt);
            return {x, y, z};
        },
        liftFactory: () => null,   // no atmosphere: straight sightlines
        applyResult: jest.fn(() => []),
        setSyncLookCamera: jest.fn(),
        ensureBaseKeyframe: jest.fn(),
        activeKeyframe: () => null,
    });
}

const wrapped = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

describe("Fit Now from a look camera near vertical", () => {
    test.each([-89, -86, 88])("a start at el %d solves to the real camera", (startEl) => {
        const fit = fitHost({position: CAM_POS, azDeg: 300, elDeg: startEl, rollDeg: 0, vfovDeg: 26});

        expect(fit.runFit(true)).toBe(true);

        expect(fit.status).not.toMatch(/vertical/);
        expect(fit.status).toMatch(/^Fitted/);
        expect(fit.applyResult).toHaveBeenCalledTimes(1);
        const result = fit.applyResult.mock.calls[0][0];
        expect(result.ok).toBe(true);
        expect(result.rms).toBeLessThan(0.01);
        expect(wrapped(result.azDeg, TRUTH.azDeg)).toBeLessThan(0.01);
        expect(result.elDeg).toBeCloseTo(TRUTH.elDeg, 2);
        expect(result.vfovDeg).toBeCloseTo(TRUTH.vfovDeg, 2);
        expect(Math.hypot(...sub(result.position, CAM_POS))).toBeLessThan(1);
    });
});

describe("clampStartElevation", () => {
    test("a start inside the limit is passed through as the same object", () => {
        for (const elDeg of [-MAX_ABS_EL, -60, 0, 42.5, MAX_ABS_EL]) {
            const start = {position: CAM_POS, azDeg: 10, elDeg, rollDeg: 3, vfovDeg: 30};
            expect(clampStartElevation(start)).toBe(start);
        }
    });

    test("a start past the limit is tilted back to it, keeping everything else", () => {
        const down = {position: CAM_POS, azDeg: 10, elDeg: -89.5, rollDeg: 3, vfovDeg: 30};
        expect(clampStartElevation(down)).toEqual({...down, elDeg: -MAX_ABS_EL});
        expect(down.elDeg).toBe(-89.5);   // the caller's state is not modified
        const up = {...down, elDeg: 90};
        expect(clampStartElevation(up)).toEqual({...down, elDeg: MAX_ABS_EL});
    });
});
