// Tests for the fisheye (allsky) projection — src/FisheyeProjection.js.
//
// The CPU twin (fisheyeProjectView) is the single JS source of the projection
// math (it reads its curves straight from CameraLens.js LENS_PRESETS), so the
// behavioural tests below pin the twin, and string pins hold the GLSL copy of
// the curves in agreement with it.

import {PerspectiveCamera, Vector3} from "three";
import {LENS_PRESETS} from "../src/CameraLens";
import {
    fisheye,
    fisheyeProjectView,
    fisheyeEquivalentFOVDegRaw,
    clampFisheyeFov,
    patchFisheyeVertexShader,
    FISHEYE_VERTEX_GLSL,
    FISHEYE_TYPE_INDEX,
} from "../src/FisheyeProjection";

function resetState(overrides = {}) {
    Object.assign(fisheye, {
        enabled: false,
        lensType: "equisolidFisheye",
        fov: 180,
        circlePct: 100,
        centerX: 0,
        centerY: 0,
        roll: 0,
        showCircle: true,
    }, overrides);
}

// A view-space direction at field angle theta (deg) from the view axis (-z),
// rotated az (deg) from the +y (screen up) image direction, at distance d.
function viewDir(thetaDeg, azDeg, d = 100) {
    const t = thetaDeg * Math.PI / 180;
    const a = azDeg * Math.PI / 180;
    return new Vector3(
        d * Math.sin(t) * Math.sin(a),
        d * Math.sin(t) * Math.cos(a),
        -d * Math.cos(t),
    );
}

afterEach(() => resetState());

describe("fisheyeProjectView", () => {

    test("rectilinear fisheye reproduces the pinhole projection exactly", () => {
        // A rectilinear LENS (r = f tan θ) is the pinhole: x,y must agree with
        // Vector3.project through a PerspectiveCamera at the same FOV/aspect.
        resetState({lensType: "rectilinear", fov: 60, circlePct: 100});
        const camera = new PerspectiveCamera(60, 1, 1, 1e6);
        camera.updateMatrixWorld(true);
        for (const [theta, az, d] of [[0, 0, 50], [10, 30, 500], [25, 200, 20], [29, 275, 3000]]) {
            const v = viewDir(theta, az, d);
            const pin = v.clone().applyMatrix4(camera.matrixWorld).project(camera);
            const fish = fisheyeProjectView(v.clone(), 1, 1, 1e6);
            expect(fish.x).toBeCloseTo(pin.x, 10);
            expect(fish.y).toBeCloseTo(pin.y, 10);
        }
    });

    test("on-axis depth matches the pinhole near/far mapping", () => {
        resetState({lensType: "equidistantFisheye", fov: 180});
        const near = 2, far = 5e5;
        const camera = new PerspectiveCamera(90, 1, near, far);
        camera.updateMatrixWorld(true);
        for (const d of [near, 10, 1234, far]) {
            const pin = new Vector3(0, 0, -d).applyMatrix4(camera.matrixWorld).project(camera);
            const fish = fisheyeProjectView(new Vector3(0, 0, -d), 1, near, far);
            expect(fish.z).toBeCloseTo(pin.z, 8);
        }
    });

    test("the configured FOV lands on the image circle's edge for every lens", () => {
        // (equidistant tested short of 360: at exactly 360 the half-FOV is the
        // antipode, whose image is the whole rim — azimuth is undefined there.)
        for (const [type, fov] of [
            ["rectilinear", 140],
            ["stereographic", 300],
            ["equidistantFisheye", 350],
            ["equisolidFisheye", 220],
            ["orthographicFisheye", 180],
        ]) {
            resetState({lensType: type, fov, circlePct: 155});
            const v = fisheyeProjectView(viewDir(fov / 2, 0), 1);
            expect(v.x).toBeCloseTo(0, 10);
            expect(v.y).toBeCloseTo(1.55, 10);       // circle radius in NDC half-heights
        }
    });

    test("a 220° equidistant field images points BEHIND the camera inside the circle", () => {
        resetState({lensType: "equidistantFisheye", fov: 220});
        // 100° off-axis is behind the image plane — unrepresentable for a
        // pinhole, at radius (100/110)·scale for the linear-angle lens.
        const v = fisheyeProjectView(viewDir(100, 90), 1);
        expect(v.x).toBeCloseTo(100 / 110, 10);
        expect(v.y).toBeCloseTo(0, 10);
    });

    test("a full 360° field renders right up to the antipode (no silent 2° crop)", () => {
        // The antipode smear guard must never eat into the REQUESTED field:
        // at FOV 360 a point 179° off-axis is inside the selected field and
        // must image near the rim, not be culled/parked.
        resetState({lensType: "equidistantFisheye", fov: 360, showCircle: false});
        const v = fisheyeProjectView(viewDir(179, 0), 1);
        expect(v.y).toBeCloseTo(179 / 180, 10);
        expect(v.z).toBeLessThan(1);   // not parked outside the z window
    });

    test("aspect squeezes NDC x only; centre offsets are in height units", () => {
        resetState({lensType: "equidistantFisheye", fov: 180, centerX: 10, centerY: -5});
        const aspect = 16 / 9;
        const v = fisheyeProjectView(viewDir(45, 90), aspect);
        expect(v.x).toBeCloseTo((0.10 * 2 + 0.5) / aspect, 10);
        expect(v.y).toBeCloseTo(-0.05 * 2, 10);
    });

    test("positive roll rotates the image counterclockwise", () => {
        resetState({lensType: "equidistantFisheye", fov: 180, roll: 90});
        // Screen-right direction (az=90°) rolls to screen-up.
        const v = fisheyeProjectView(viewDir(45, 90), 1);
        expect(v.x).toBeCloseTo(0, 10);
        expect(v.y).toBeCloseTo(0.5, 10);
    });

    test("wheel/gesture zoom is held to the slider's range for the current projection", () => {
        // The look-view wheel scales the fisheye FOV through clampFisheyeFov:
        // floor 10 (the slider's), ceiling the per-projection cap.
        resetState({lensType: "equidistantFisheye"});
        expect(clampFisheyeFov(5)).toBe(10);
        expect(clampFisheyeFov(200)).toBe(200);
        expect(clampFisheyeFov(400)).toBe(360);
        resetState({lensType: "orthographicFisheye"});
        expect(clampFisheyeFov(190)).toBe(180);
        resetState({lensType: "rectilinear"});
        expect(clampFisheyeFov(170)).toBe(160);
    });

    test("equivalent pinhole FOV matches at the plate-scale gauge", () => {
        // Rectilinear at circle=100%: same lens as a pinhole at the same FOV.
        resetState({lensType: "rectilinear", fov: 90, circlePct: 100});
        expect(fisheyeEquivalentFOVDegRaw()).toBeCloseTo(90, 10);
    });
});

describe("GLSL / JS lens curve agreement", () => {
    // The GLSL branch ladder duplicates LENS_PRESETS' closed forms (GLSL can't
    // import them). Pin each curve's expression and its branch order so an
    // edit to either side has to visit this test.
    test("the shader chunk carries the closed forms in FISHEYE_TYPE_INDEX order", () => {
        expect(FISHEYE_TYPE_INDEX).toEqual({
            rectilinear: 0, stereographic: 1, equidistantFisheye: 2,
            equisolidFisheye: 3, orthographicFisheye: 4,
        });
        const glsl = FISHEYE_VERTEX_GLSL;
        const ladder = glsl.slice(glsl.indexOf("float fisheyeRho"), glsl.indexOf("vec4 fisheyeClip"));
        expect(ladder).toContain("if (uFishType < 0.5) return tan(theta);");
        expect(ladder).toContain("if (uFishType < 1.5) return 2.0 * tan(theta * 0.5);");
        expect(ladder).toContain("if (uFishType < 2.5) return theta;");
        expect(ladder).toContain("if (uFishType < 3.5) return 2.0 * sin(theta * 0.5);");
        expect(ladder).toContain("return sin(theta);");
        // And the JS side really is LENS_PRESETS: spot-check one value per curve.
        expect(LENS_PRESETS.stereographic.rho(1)).toBeCloseTo(2 * Math.tan(0.5), 12);
        expect(LENS_PRESETS.equisolidFisheye.rho(1)).toBeCloseTo(2 * Math.sin(0.5), 12);
        expect(LENS_PRESETS.orthographicFisheye.rho(1)).toBeCloseTo(Math.sin(1), 12);
    });
});

describe("patchFisheyeVertexShader", () => {
    test("patches the stock project_vertex family and is idempotent", () => {
        const src = "void main() {\n\t#include <project_vertex>\n}";
        const once = patchFisheyeVertexShader(src);
        expect(once.matched).toBe(true);
        expect(once.vertexShader).toContain("fisheyeClip(mvPosition)");
        expect(once.vertexShader).toContain("SITREC_FISHEYE_CHUNK");
        const twice = patchFisheyeVertexShader(once.vertexShader);
        expect(twice.vertexShader).toBe(once.vertexShader);
    });

    test("anchors after terrestrial refraction's overwrite and composes with its bend", () => {
        const src = "void main() {\n\t#include <project_vertex>\n"
            + "\tgl_Position = applyTerrestrialRefraction_clip(mvPosition);\n}";
        const out = patchFisheyeVertexShader(src).vertexShader;
        const refrAt = out.indexOf("applyTerrestrialRefraction_clip");
        const fishAt = out.indexOf("fisheyeClip(vec4(applyTerrestrialRefraction_chunk");
        expect(refrAt).toBeGreaterThan(-1);
        expect(fishAt).toBeGreaterThan(refrAt);
    });

    test("reports unmatched shaders instead of pretending", () => {
        const out = patchFisheyeVertexShader("void main() { gl_Position = vec4(0.0); }");
        expect(out.matched).toBe(false);
    });

    test("patches ShaderMaterials that opted into terrestrial refraction", () => {
        // The ground-grid / sprite-group idiom: gl_Position built directly
        // through applyTerrestrialRefraction_clip with a view-space expression.
        const src = "void main() {\n"
            + "\tgl_Position = applyTerrestrialRefraction_clip(modelViewMatrix * vec4(position, 1.0));\n}";
        const out = patchFisheyeVertexShader(src);
        expect(out.matched).toBe(true);
        expect(out.vertexShader).toContain(
            "fisheyeClip(vec4(applyTerrestrialRefraction_chunk((modelViewMatrix * vec4(position, 1.0)).xyz), 1.0))");
    });

    test("patches world-position projections (CPlanets Sun/Moon)", () => {
        const src = "void main() {\n\tgl_Position = projectionMatrix * viewMatrix * worldPos;\n}";
        const out = patchFisheyeVertexShader(src);
        expect(out.matched).toBe(true);
        expect(out.vertexShader).toContain("fisheyeClip(viewMatrix * worldPos)");
    });

    test("patches fat-line endpoint projections", () => {
        const src = "void main() {\n"
            + "\tvec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );\n"
            + "\tvec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );\n"
            + "\tvec4 clipStart = projectionMatrix * start;\n"
            + "\tvec4 clipEnd = projectionMatrix * end;\n}";
        const out = patchFisheyeVertexShader(src);
        expect(out.matched).toBe(true);
        expect(out.vertexShader).toContain("fisheyeClip( start )");
        expect(out.vertexShader).toContain("fisheyeClip( end )");
    });
});
