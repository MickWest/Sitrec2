// Camera resection from 2D/3D correspondences.
//
// Every test here builds a KNOWN camera, projects known world points through it, and then asks
// the solver to recover the camera it started from. That is the only honest way to test a fitter:
// a low residual proves the optimiser found a minimum, not that the minimum is the truth.
//
// The degeneracy tests are the important ones. A solver that returns a confident wrong camera
// when the geometry cannot support one is worse than a solver that refuses, because the whole
// point of the feature is to establish a camera nobody knew.

import {
    fitCameraToPoints,
    evaluateCamera,
    basisFromAzElRoll,
    azElRollFromBasis,
    jacobiSVD,
    projectWorldPoint,
    MAX_ABS_EL,
} from "../src/CameraPointFit";
import {lensFromVFOV} from "../src/CameraLens";

const SIZE = [1920, 1080];
const R_EARTH = 6378137;
const DEG = Math.PI / 180;

// A spherical Earth is enough here: the solver never assumes an ellipsoid, it just uses whatever
// local frame it is handed, so the tests supply a simple consistent one.
function llaToEcef(latDeg, lonDeg, alt) {
    const lat = latDeg * DEG, lon = lonDeg * DEG;
    const r = R_EARTH + alt;
    return [r * Math.cos(lat) * Math.cos(lon), r * Math.cos(lat) * Math.sin(lon), r * Math.sin(lat)];
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
const nrm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const n = nrm(a); return [a[0] / n, a[1] / n, a[2] / n]; };

// The ECEF Z axis is the north pole direction; north is its horizontal part at this position.
function localFrame(pos) {
    const up = unit(pos);
    const pole = [0, 0, 1];
    const north = unit(sub(pole, [up[0] * dot(pole, up), up[1] * dot(pole, up), up[2] * dot(pole, up)]));
    return {up, north};
}

/** Synthesise the pixel a world point lands on for a given camera. */
function makeState(position, azDeg, elDeg, rollDeg, vfovDeg) {
    const fr = localFrame(position);
    return {
        position,
        basis: basisFromAzElRoll(fr.up, fr.north, azDeg, elDeg, rollDeg),
        focalScale: 1,
        vfovDeg,
    };
}

function synthesise(camera, worldPoints, vfovDeg = camera.vfovDeg) {
    const lens = lensFromVFOV(vfovDeg, SIZE);
    const out = [];
    for (const w of worldPoints) {
        const px = projectWorldPoint(camera, w, lens, SIZE);
        expect(px).not.toBeNull();
        out.push({px, world: w});
    }
    return out;
}

// A camera on a hill near Djibouti, looking out over a spread of landmarks — roughly the
// geometry this feature exists for.
const CAM_LLA = [11.58, 43.14, 420];
const CAM_POS = llaToEcef(...CAM_LLA);

/**
 * Place a landmark by range, compass bearing and altitude from the camera.
 *
 * Stated this way rather than as lat/lon deltas because every property that matters to a
 * resection is a property of THIS geometry: bearing spread against the field of view, range
 * spread against position observability, altitude spread against elevation observability. Raw
 * lat/lon offsets hide all three, and the first version of these tests quietly placed half the
 * landmarks behind the camera because of it.
 */
function landmark(rangeM, bearingDeg, altM) {
    const b = bearingDeg * DEG;
    const dLat = (rangeM * Math.cos(b)) / R_EARTH / DEG;
    const dLon = (rangeM * Math.sin(b)) / (R_EARTH * Math.cos(CAM_LLA[0] * DEG)) / DEG;
    return llaToEcef(CAM_LLA[0] + dLat, CAM_LLA[1] + dLon, altM);
}

// The well-conditioned reference set: bearings over 45-75 deg, ranges over 3-40 km, altitudes
// over 5-1500 m. All seven parameters are observable from it. The camera below looks at bearing
// 62 with a 40 deg vertical field, so everything sits comfortably in frame.
const GOOD_POINTS = [
    landmark(3000, 50, 5),
    landmark(8000, 75, 60),
    landmark(15000, 62, 900),
    landmark(25000, 55, 240),
    landmark(40000, 68, 130),
    landmark(5000, 70, 15),
    landmark(12000, 45, 1500),
];
const VFOV = 40;

describe("orientation basis", () => {
    test("basisFromAzElRoll and azElRollFromBasis are exact inverses", () => {
        const fr = localFrame(CAM_POS);
        for (const az of [-179, -90, -12.5, 0, 37, 123, 180]) {
            for (const el of [-70, -15, 0, 8.25, 60]) {
                for (const roll of [-140, -30, 0, 5.5, 95]) {
                    const b = basisFromAzElRoll(fr.up, fr.north, az, el, roll);
                    const got = azElRollFromBasis(fr.up, fr.north, b);
                    // Azimuth wraps at +/-180, so compare the wrapped difference.
                    const dAz = ((got.azDeg - az + 540) % 360) - 180;
                    const dRoll = ((got.rollDeg - roll + 540) % 360) - 180;
                    expect(Math.abs(dAz)).toBeLessThan(1e-9);
                    expect(got.elDeg).toBeCloseTo(el, 9);
                    expect(Math.abs(dRoll)).toBeLessThan(1e-9);
                }
            }
        }
    });

    test("the basis is right-handed and orthonormal, with az/el meaning what they say", () => {
        const fr = localFrame(CAM_POS);
        const b = basisFromAzElRoll(fr.up, fr.north, 0, 0, 0);
        // az = 0, el = 0 looks north, is level, and has 'down' opposite local up.
        expect(dot(b.fwd, fr.north)).toBeCloseTo(1, 12);
        expect(dot(b.down, fr.up)).toBeCloseTo(-1, 12);
        // right = fwd x down for this convention (x cross y = z is right cross down = fwd).
        const rhs = cross(b.down, b.fwd);
        expect(dot(rhs, b.right)).toBeCloseTo(1, 12);

        // az = 90 looks east.
        const east = cross(fr.north, fr.up);
        const b90 = basisFromAzElRoll(fr.up, fr.north, 90, 0, 0);
        expect(dot(b90.fwd, east)).toBeCloseTo(1, 12);

        // Positive elevation tilts up.
        const bUp = basisFromAzElRoll(fr.up, fr.north, 0, 30, 0);
        expect(dot(bUp.fwd, fr.up)).toBeCloseTo(0.5, 12);
    });
});

describe("jacobiSVD", () => {
    test("reconstructs a known matrix", () => {
        const m = 6, n = 3;
        const A = [];
        for (let i = 0; i < m; i++) {
            for (let j = 0; j < n; j++) A.push(Math.sin(i * 3.1 + j * 1.7) * (j + 1));
        }
        const {u, s, v} = jacobiSVD(A, m, n);
        for (let i = 0; i < m; i++) {
            for (let j = 0; j < n; j++) {
                let acc = 0;
                for (let k = 0; k < n; k++) acc += u[i * n + k] * s[k] * v[j * n + k];
                expect(acc).toBeCloseTo(A[i * n + j], 9);
            }
        }
        // Descending, and V orthonormal.
        expect(s[0]).toBeGreaterThanOrEqual(s[1]);
        expect(s[1]).toBeGreaterThanOrEqual(s[2]);
        for (let a = 0; a < n; a++) {
            for (let b = 0; b < n; b++) {
                let acc = 0;
                for (let k = 0; k < n; k++) acc += v[k * n + a] * v[k * n + b];
                expect(acc).toBeCloseTo(a === b ? 1 : 0, 9);
            }
        }
    });
});

describe("exact recovery", () => {
    test("recovers a known camera from a nearby start", () => {
        const truth = makeState(CAM_POS, 62, -3.5, 0, VFOV);
        const points = synthesise(truth, GOOD_POINTS, VFOV);

        // Start 800 m away, 6 deg off, and at nearly twice the true field of view.
        const startPos = llaToEcef(CAM_LLA[0] + 0.005, CAM_LLA[1] - 0.004, 560);
        const res = fitCameraToPoints({
            points, imageSize: SIZE, localFrame,
            initial: {position: startPos, azDeg: 68, elDeg: 2, rollDeg: 0, vfovDeg: 70},
            free: {position: true, az: true, el: true, roll: false, fov: true},
        });

        expect(res.ok).toBe(true);
        expect(res.rms).toBeLessThan(0.05);
        expect(nrm(sub(res.position, CAM_POS))).toBeLessThan(2);
        expect(res.azDeg).toBeCloseTo(62, 2);
        expect(res.elDeg).toBeCloseTo(-3.5, 2);
        expect(res.vfovDeg).toBeCloseTo(VFOV, 2);
        expect(res.diagnostics.conditioning).toBe("good");
    });

    test("recovers from a start hundreds of km and tens of degrees wrong", () => {
        // This is the case the feature exists for: no platform metadata at all, so the sitch
        // camera is wherever it happened to be left. A warm-started LM alone does not survive
        // this; the focal scan plus Kabsch/ray-intersection initialiser is what does.
        const truth = makeState(CAM_POS, 62, -3.5, 0, VFOV);
        const points = synthesise(truth, GOOD_POINTS, VFOV);

        const startPos = llaToEcef(13.9, 45.6, 12000);
        const res = fitCameraToPoints({
            points, imageSize: SIZE, localFrame,
            initial: {position: startPos, azDeg: -140, elDeg: 20, rollDeg: 0, vfovDeg: 5},
            free: {position: true, az: true, el: true, roll: false, fov: true},
        });

        expect(res.ok).toBe(true);
        expect(res.rms).toBeLessThan(0.5);
        expect(nrm(sub(res.position, CAM_POS))).toBeLessThan(50);
        expect(res.vfovDeg).toBeCloseTo(VFOV, 1);
    });

    test("recovers a rolled, wide-angle camera with off-axis points", () => {
        // Wide FOV is where the rectilinear-versus-rotational projection choice actually bites,
        // and roll is where a sign error in the basis would show up.
        const truth = makeState(CAM_POS, 62, -3.5, 21, 78);
        const points = synthesise(truth, GOOD_POINTS, 78);
        const startPos = llaToEcef(CAM_LLA[0] - 0.01, CAM_LLA[1] + 0.01, 300);

        const res = fitCameraToPoints({
            points, imageSize: SIZE, localFrame,
            initial: {position: startPos, azDeg: 58, elDeg: 0, rollDeg: 10, vfovDeg: 60},
            free: {position: true, az: true, el: true, roll: true, fov: true},
        });

        expect(res.ok).toBe(true);
        expect(res.rms).toBeLessThan(0.1);
        expect(res.rollDeg).toBeCloseTo(21, 1);
        expect(res.vfovDeg).toBeCloseTo(78, 1);
    });
});

describe("locks", () => {
    test("a locked position is not moved, and orientation plus FOV still solve", () => {
        const truth = makeState(CAM_POS, 62, -3.5, 0, VFOV);
        const points = synthesise(truth, GOOD_POINTS, VFOV);

        const res = fitCameraToPoints({
            points, imageSize: SIZE, localFrame,
            initial: {position: CAM_POS, azDeg: 50, elDeg: 6, rollDeg: 0, vfovDeg: 60},
            free: {position: false, az: true, el: true, roll: false, fov: true},
        });

        expect(res.ok).toBe(true);
        expect(nrm(sub(res.position, CAM_POS))).toBeLessThan(1e-6);
        expect(res.azDeg).toBeCloseTo(62, 3);
        expect(res.vfovDeg).toBeCloseTo(VFOV, 3);
        expect(res.freeParams).toEqual(["az", "el", "fov"]);
    });

    test("a locked roll stays exactly where it started", () => {
        const truth = makeState(CAM_POS, 62, -3.5, 12, VFOV);
        const points = synthesise(truth, GOOD_POINTS, VFOV);
        const res = fitCameraToPoints({
            points, imageSize: SIZE, localFrame,
            initial: {position: CAM_POS, azDeg: 62, elDeg: -3.5, rollDeg: 0, vfovDeg: VFOV},
            free: {position: true, az: true, el: true, roll: false, fov: true},
        });
        // Roll is untouched, which necessarily leaves a residual — the point is that the lock is
        // exact rather than approximately honoured.
        expect(res.rollDeg).toBe(0);
        expect(res.rms).toBeGreaterThan(1);
    });

    test("two points are enough when only az and el are free", () => {
        const truth = makeState(CAM_POS, 62, -3.5, 0, VFOV);
        const points = synthesise(truth, GOOD_POINTS.slice(0, 2), VFOV);
        const res = fitCameraToPoints({
            points, imageSize: SIZE, localFrame,
            initial: {position: CAM_POS, azDeg: 58, elDeg: 0, rollDeg: 0, vfovDeg: VFOV},
            free: {position: false, az: true, el: true, roll: false, fov: false},
        });
        expect(res.ok).toBe(true);
        expect(res.azDeg).toBeCloseTo(62, 3);
        expect(res.diagnostics.redundancy).toBe(2);
    });
});

describe("refusals", () => {
    test("refuses when there are fewer equations than free parameters", () => {
        const truth = makeState(CAM_POS, 62, -3.5, 0, VFOV);
        const points = synthesise(truth, GOOD_POINTS.slice(0, 3), VFOV);
        const res = fitCameraToPoints({
            points, imageSize: SIZE, localFrame,
            initial: {position: CAM_POS, azDeg: 62, elDeg: -3.5, rollDeg: 0, vfovDeg: VFOV},
            free: {position: true, az: true, el: true, roll: true, fov: true},
        });
        expect(res.ok).toBe(false);
        expect(res.reason).toMatch(/at least 4 points/);
    });

    test("refuses when everything is locked", () => {
        const truth = makeState(CAM_POS, 62, -3.5, 0, VFOV);
        const points = synthesise(truth, GOOD_POINTS, VFOV);
        const res = fitCameraToPoints({
            points, imageSize: SIZE, localFrame,
            initial: {position: CAM_POS, azDeg: 62, elDeg: -3.5, rollDeg: 0, vfovDeg: VFOV},
            free: {position: false, az: false, el: false, roll: false, fov: false},
        });
        expect(res.ok).toBe(false);
        expect(res.reason).toMatch(/every parameter is locked/i);
    });

    test("refuses near the elevation singularity instead of returning a chart artefact", () => {
        const truth = makeState(CAM_POS, 62, -3.5, 0, VFOV);
        const points = synthesise(truth, GOOD_POINTS, VFOV);
        const res = fitCameraToPoints({
            points, imageSize: SIZE, localFrame,
            initial: {position: CAM_POS, azDeg: 0, elDeg: 89, rollDeg: 0, vfovDeg: VFOV},
            free: {position: true, az: true, el: true, roll: false, fov: true},
        });
        expect(res.ok).toBe(false);
        expect(res.reason).toMatch(new RegExp(`${MAX_ABS_EL}`));
    });

    test("refuses a solution that puts landmarks behind the camera", () => {
        // Three landmarks ahead and one 180 degrees behind. With position, roll and FOV locked
        // there is no pointing that images all four, so the solver must say so rather than
        // returning whichever orientation happens to have the lowest residual.
        const truth = makeState(CAM_POS, 60, -2, 0, VFOV);
        const points = synthesise(truth, [
            landmark(5000, 55, 20), landmark(9000, 65, 40), landmark(14000, 60, 300),
        ], VFOV);
        points.push({px: [960, 540], world: landmark(6000, 240, 30)});

        const res = fitCameraToPoints({
            points, imageSize: SIZE, localFrame,
            initial: {position: CAM_POS, azDeg: 60, elDeg: -2, rollDeg: 0, vfovDeg: VFOV},
            free: {position: false, az: true, el: true, roll: false, fov: false},
        });
        expect(res.ok).toBe(false);
        expect(res.reason).toMatch(/behind the fitted camera/);
    });
});

describe("robustness and degeneracy", () => {
    test("one badly placed point does not wreck the fit", () => {
        const truth = makeState(CAM_POS, 62, -3.5, 0, VFOV);
        const points = synthesise(truth, GOOD_POINTS, VFOV);
        // Drag one 2D point 90 px off — a plainly wrong click, not noise.
        points[3] = {px: [points[3].px[0] + 90, points[3].px[1] - 70], world: points[3].world};

        const res = fitCameraToPoints({
            points, imageSize: SIZE, localFrame,
            initial: {position: CAM_POS, azDeg: 60, elDeg: -2, rollDeg: 0, vfovDeg: 45},
            free: {position: true, az: true, el: true, roll: false, fov: true},
        });

        expect(res.ok).toBe(true);
        // The bad point is clearly the worst, and the others are still tight — which is what lets
        // the UI point at it instead of silently averaging the error across all six.
        const worst = res.perPoint.reduce((a, b) => (a.distance > b.distance ? a : b));
        expect(worst).toBe(res.perPoint[3]);
        const others = res.perPoint.filter((_, i) => i !== 3);
        for (const p of others) expect(p.distance).toBeLessThan(12);
    });

    test("distant landmarks at one range report as unobservable rather than solved", () => {
        // Five points on a far horizon, all at the SAME range and altitude. Bearings are well
        // determined; moving the camera along its own view axis and rescaling the focal length
        // reproduces the identical image, so those two are exactly degenerate with each other.
        // The fit will converge — the question is whether it admits what it could not see.
        const horizon = [0, 1, 2, 3, 4].map((b) => landmark(100000, b, 5));
        const truth = makeState(CAM_POS, 2, -0.7, 0, 9);
        const points = synthesise(truth, horizon, 9);

        const res = fitCameraToPoints({
            points, imageSize: SIZE, localFrame,
            initial: {position: CAM_POS, azDeg: 2, elDeg: -0.7, rollDeg: 0, vfovDeg: 9},
            free: {position: true, az: true, el: true, roll: false, fov: true},
        });

        expect(res.ok).toBe(true);
        expect(res.diagnostics.conditioning).not.toBe("good");
        // The minor axis of the pixel spread collapses, which is the cheap pre-solve tell.
        expect(res.spread.minor).toBeLessThan(res.spread.major / 20);
    });

    test("uncertainty never claims to be better than the pixel noise floor", () => {
        // Four points, six free parameters: the fit passes almost exactly through its own data.
        // Reporting zero uncertainty there would be the most misleading output this could give.
        const truth = makeState(CAM_POS, 62, -3.5, 0, VFOV);
        const points = synthesise(truth, GOOD_POINTS.slice(0, 4), VFOV);
        const res = fitCameraToPoints({
            points, imageSize: SIZE, localFrame,
            initial: {position: CAM_POS, azDeg: 61, elDeg: -3, rollDeg: 0, vfovDeg: 42},
            free: {position: true, az: true, el: true, roll: false, fov: true},
        });
        expect(res.ok).toBe(true);
        expect(res.rms).toBeLessThan(1e-3);
        expect(res.diagnostics.redundancy).toBe(2);
        for (const key of ["east", "north", "up", "az", "el", "fov"]) {
            expect(res.diagnostics.uncertainty[key]).toBeGreaterThan(0);
        }
    });
});

describe("regressions found by testing against the running app", () => {
    // Real geometry captured from the PR043 Djibouti clip: five landmarks 5.5-13.9 km out,
    // spread ~8 km, seen from a 29 deg camera. The camera sits OUTSIDE the landmark cluster and
    // close to it, which is the configuration that broke the initialiser.
    const REAL = {
        size: [1920, 1080],
        truth: {
            position: [4561369.206722315, 4281007.999483868, 1251807.3991537911],
            azDeg: -87.47007686408679, elDeg: -15.774893237946854,
            rollDeg: -0.00024563442675248903, vfovDeg: 29.235715662329504,
        },
        // The state the app was actually in: 27.5 km away, 25 deg off in azimuth, 12 in
        // elevation, three times the true field of view.
        wrong: {
            position: [4570413.465781154, 4267046.515941657, 1273797.295735235],
            azDeg: -62.47007686999509, elDeg: -3.774893207825251,
            rollDeg: -0.00024563442675407934, vfovDeg: 87.7071469869885,
        },
        points: [
            {px: [400, 300],  world: [4569417.468242407, 4270249.103390858, 1248438.1863841568]},
            {px: [1500, 320], world: [4567749.437527097, 4270028.766450306, 1255154.9337258148]},
            {px: [960, 700],  world: [4563875.73972917,  4275073.52673738,  1251629.7799704045]},
            {px: [300, 850],  world: [4563403.094794338, 4276098.2905787965, 1249922.2089204516]},
            {px: [1650, 880], world: [4562696.347098906, 4275846.848042958, 1253263.561439435]},
        ],
    };
    // WGS84 geodetic frame, matching what Sitrec hands the solver.
    const AA = 6378137, BB = 6356752.314245179;
    const wgs84Frame = (p) => {
        const up = unit([p[0] / (AA * AA), p[1] / (AA * AA), p[2] / (BB * BB)]);
        const toPole = unit(sub([0, 0, BB], p));
        const d = dot(toPole, up);
        return {up, north: unit([toPole[0] - up[0] * d, toPole[1] - up[1] * d, toPole[2] - up[2] * d])};
    };
    const FREE = {position: true, az: true, el: true, roll: false, fov: true};

    test("recovers the real camera from the state that used to break it", () => {
        // Regression for the initialiser. This exact input previously returned a "successful"
        // fit 9800 km away with a 169 deg field and a 612 px residual, because the candidate
        // seeds were RANKED by their raw residual — which for these five landmarks was 1288-1365
        // px for every candidate, i.e. pure noise. Ranking by a short LM run instead separates
        // them, and the right seed wins.
        const res = fitCameraToPoints({
            points: REAL.points, imageSize: REAL.size, localFrame: wgs84Frame,
            initial: REAL.wrong, free: FREE,
        });
        expect(res.ok).toBe(true);
        expect(res.rms).toBeLessThan(0.01);
        expect(nrm(sub(res.position, REAL.truth.position))).toBeLessThan(1);
        expect(res.vfovDeg).toBeCloseTo(REAL.truth.vfovDeg, 3);
    });

    test("evaluateCamera scores the true camera at zero and a wrong one high", () => {
        const good = evaluateCamera({
            points: REAL.points, imageSize: REAL.size, state: REAL.truth, localFrame: wgs84Frame,
        });
        expect(good.rms).toBeLessThan(1e-6);
        expect(good.behind).toBe(0);
        expect(good.perPoint).toHaveLength(5);

        const bad = evaluateCamera({
            points: REAL.points, imageSize: REAL.size, state: REAL.wrong, localFrame: wgs84Frame,
        });
        expect(bad.rms).toBeGreaterThan(100);
    });

    test("an implausible field of view is refused, not passed to the camera", () => {
        // The camera nodes assert 0 < fov <= 180, so a runaway solve must be caught here rather
        // than surfacing as an assert inside the render loop. Two points with only FOV free and
        // a contradiction between them drives the focal to nothing.
        const res = fitCameraToPoints({
            points: [
                {px: [960, 540], world: REAL.points[0].world},
                {px: [961, 541], world: REAL.points[4].world},
            ],
            imageSize: REAL.size, localFrame: wgs84Frame, initial: REAL.truth,
            free: {position: false, az: false, el: false, roll: false, fov: true},
        });
        if (res.ok) {
            expect(res.vfovDeg).toBeGreaterThan(0.02);
            expect(res.vfovDeg).toBeLessThan(175);
        } else {
            expect(res.reason).toMatch(/not plausible|converge/);
        }
    });
});
