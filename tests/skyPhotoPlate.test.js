import {makeSkyPhotoPlate, photoPixelToSky, skyToPhotoPixel} from "../src/starTrack/SkyPhotoPlate";
import {raDecToVec, tangentBasis, unGnomonic} from "../src/starTrack/StarIdentify";
import {applyTransform, invertTransform} from "../src/starTrack/StarMatch";
import {makeLens} from "../src/CameraLens";
import {qFromAxisAngle} from "../src/starTrack/StarSphere";

const center = raDecToVec(52 * Math.PI / 180, 36 * Math.PI / 180);
function solved(mirrored = false) {
    return {frame0: 0, videoW: 1536, videoH: 2048,
        solved: {transforms: [{A: [0.99, 0.02], B: [12, -4]}]},
        identify: {solved: {ok: true, model: {T: {A: [0.0004, 0.0001], B: [-0.2, -0.4]},
            c0: center, b0: tangentBasis(center), mirrored}}}};
}

test.each([false, true])("plate preserves the actual solve, including image parity %s", mirrored => {
    const r = solved(mirrored), plate = makeSkyPhotoPlate(r);
    for (const [x, y] of [[0, 0], [1536, 0], [0, 2048], [1536, 2048], [768, 1024]]) {
        const ref = applyTransform(invertTransform(r.solved.transforms[0]), x, y);
        const m = r.identify.solved.model;
        const p = applyTransform(m.T, ref[0], mirrored ? -ref[1] : ref[1]);
        const expected = unGnomonic(...p, m.c0, m.b0);
        const direction = photoPixelToSky(plate, x, y);
        direction.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 12));
        const pixel = skyToPhotoPixel(plate, direction);
        expect(pixel[0]).toBeCloseTo(x, 8);
        expect(pixel[1]).toBeCloseTo(y, 8);
    }
    expect(skyToPhotoPixel(plate, center.map(v => -v))).toBeNull();
});

test("registration survives JSON and later solves cannot mutate it", () => {
    const r = solved(), plate = makeSkyPhotoPlate(r), before = photoPixelToSky(plate, 768, 1024);
    r.identify.solved.model.T.B[0] = 5;
    r.solved.transforms[0].A[0] = 2;
    const restored = JSON.parse(JSON.stringify(plate));
    expect(photoPixelToSky(restored, 768, 1024)).toEqual(before);
    expect(makeSkyPhotoPlate({...r, identify: {solved: {ok: false}}})).toBeNull();
});

test("fitted wide-angle lens keeps edge pixels registered independently of the render lens", () => {
    const r = solved();
    r.lensInfo = {states: [{q: [0, 0, 0, 1]}]};
    r.lensFit = {lens: makeLens({type: "equidistantFisheye", focalPx: 850,
        principal: [760, 1020], refSize: [1536, 2048]}), q: qFromAxisAngle([0, 1, 0], 0.8)};
    const plate = JSON.parse(JSON.stringify(makeSkyPhotoPlate(r)));
    for (const [x, y] of [[10, 10], [1526, 2038], [760, 1020], [200, 1800]]) {
        const p = skyToPhotoPixel(plate, photoPixelToSky(plate, x, y));
        expect(p[0]).toBeCloseTo(x, 7);
        expect(p[1]).toBeCloseTo(y, 7);
    }
});

test("a known lens with a spherical chart preserves the full composed calibration", () => {
    const r = solved();
    r.identify.chart = {centre: [0, 0, 1], e1: [1, 0, 0], e2: [0, 1, 0], focalPx: 1000, offset: 768};
    r.lensInfo = {states: [{q: [0, 0, 0, 1], s: 1.05}],
        lens: makeLens({type: "stereographic", focalPx: 1500, principal: [768, 1024], refSize: [1536, 2048]})};
    const plate = makeSkyPhotoPlate(r);
    for (const [x, y] of [[5, 5], [1531, 2043], [768, 1024]]) {
        const p = skyToPhotoPixel(plate, photoPixelToSky(plate, x, y));
        expect(p[0]).toBeCloseTo(x, 7);
        expect(p[1]).toBeCloseTo(y, 7);
    }
});
