// Terrestrial (finite-range) refraction of the solid scene.
//
// The numbers here are the Copenhagen → Turning Torso case that motivated the
// feature: a 20.574 km sight line across the Øresund, measured in Sitrec.

import {
    TERRESTRIAL_REFRACTION_DEFAULTS,
    terrestrialKFromAtmosphere,
    resolveTerrestrialK,
    terrestrialOptsFrom,
    gaussianRadius,
    terrestrialBendAngle,
    terrestrialLift,
    terrestrialRefractionUniforms,
    updateTerrestrialRefractionUniforms,
    patchTerrestrialRefractionVertexShader,
    installTerrestrialRefractionOnMaterial,
} from "../src/atmosphere/terrestrialRefraction";

const R = 6371000;
const RAD2ARCMIN = 180 * 60 / Math.PI;
const WGS84_A = 6378137.0;
const WGS84_B = WGS84_A * (1 - 1 / 298.257223563);

describe("terrestrial refraction magnitude", () => {

    test("the Turning Torso case: 0.72 arcmin at 20.6 km with k=0.13", () => {
        const d = 20600;
        const bend = terrestrialBendAngle(d, 0.13, R);
        expect(bend * RAD2ARCMIN).toBeCloseTo(0.7225, 3);
        // and the equivalent lift at the target
        expect(terrestrialLift(d, 0.13, R)).toBeCloseTo(4.330, 2);
    });

    test("the unrefracted curvature drop is 33.3 m over the same range", () => {
        // sanity anchor for the lift above: lift = k * drop
        const d = 20600;
        const drop = d * d / (2 * R);
        expect(drop).toBeCloseTo(33.304, 2);
        // maxBendRad = 0 turns the saturator off, leaving the bare surveying law
        expect(terrestrialLift(d, 0.13, R, 0)).toBeCloseTo(0.13 * drop, 9);
        // with the saturator on, the answer is the same to within 0.05%
        expect(terrestrialLift(d, 0.13, R) / (0.13 * drop)).toBeGreaterThan(0.9995);
    });

    test("matches the effective-Earth-radius formulation at short range", () => {
        // R_eff = R/(1-k): the drop computed on the enlarged sphere should equal
        // the true drop minus the refraction lift.
        const k = 0.13;
        const Reff = R / (1 - k);
        for (const d of [1000, 5000, 20600, 50000]) {
            const dropTrue = d * d / (2 * R);
            const dropEff = d * d / (2 * Reff);
            expect(terrestrialLift(d, k, R, 0)).toBeCloseTo(dropTrue - dropEff, 9);
        }
    });

    test("scales linearly in k and quadratically in distance", () => {
        expect(terrestrialLift(20600, 0.26, R, 0)).toBeCloseTo(2 * terrestrialLift(20600, 0.13, R, 0), 9);
        // 2x the range is 4x the lift
        expect(terrestrialLift(40000, 0.13, R, 0)).toBeCloseTo(4 * terrestrialLift(20000, 0.13, R, 0), 9);
    });

    test("k = 0 and d = 0 produce no bend at all", () => {
        expect(terrestrialBendAngle(20600, 0, R)).toBe(0);
        expect(terrestrialBendAngle(0, 0.13, R)).toBe(0);
        expect(terrestrialLift(20600, 0, R)).toBe(0);
    });
});

describe("k is derived from the same air the celestial model describes", () => {

    test("k = 503 (P/T^2) (0.0342 + dT/dh) at the standard state", () => {
        // 1010 hPa, 10 C, standard 6.5 K/km lapse
        expect(terrestrialKFromAtmosphere(1010, 10, -6.5)).toBeCloseTo(0.176, 3);
        // dry adiabatic
        expect(terrestrialKFromAtmosphere(1010, 10, -9.8)).toBeCloseTo(0.155, 3);
        // isothermal — matches the value the independent line-integral analysis
        // converged on when it reproduced the astronomical horizon refraction
        expect(terrestrialKFromAtmosphere(1010, 10, 0)).toBeCloseTo(0.217, 3);
        // a strong inversion
        expect(terrestrialKFromAtmosphere(1010, 10, 50)).toBeCloseTo(0.534, 3);
    });

    test("the traditional surveying k=0.13 is a sun-warmed LAND surface, not standard air", () => {
        expect(terrestrialKFromAtmosphere(1010, 10, -13.7)).toBeCloseTo(0.130, 3);
        // i.e. strongly superadiabatic — well below the dry adiabatic rate
        expect(-13.7).toBeLessThan(-9.8);
    });

    test("pressure and temperature move k, which is the whole point", () => {
        const std = terrestrialKFromAtmosphere(1010, 10, -6.5);
        expect(terrestrialKFromAtmosphere(800, 10, -6.5) / std).toBeCloseTo(0.79, 2);
        expect(terrestrialKFromAtmosphere(1100, 10, -6.5) / std).toBeCloseTo(1.09, 2);
        expect(terrestrialKFromAtmosphere(1010, -20, -6.5) / std).toBeCloseTo(1.25, 2);
        expect(terrestrialKFromAtmosphere(1010, 40, -6.5) / std).toBeCloseTo(0.82, 2);
    });

    test("clamps to zero at and below the autoconvective gradient", () => {
        expect(terrestrialKFromAtmosphere(1010, 10, -34.2)).toBeCloseTo(0, 4);
        expect(terrestrialKFromAtmosphere(1010, 10, -60)).toBe(0);
    });

    test("resolveTerrestrialK derives by default and honours the override", () => {
        const sit = {refractionPressure: 1010, refractionTemp: 10, terrestrialLapseRate: -6.5,
                     terrestrialRefractionK: 0.13};
        expect(resolveTerrestrialK(sit)).toBeCloseTo(0.176, 3);
        sit.terrestrialRefractionOverrideK = true;
        expect(resolveTerrestrialK(sit)).toBe(0.13);
    });

    test("resolveTerrestrialK falls back to standard air when nothing is set", () => {
        expect(resolveTerrestrialK({})).toBeCloseTo(
            terrestrialKFromAtmosphere(1010, 10, TERRESTRIAL_REFRACTION_DEFAULTS.lapseRateKPerKm), 10);
    });

    test("terrestrialOptsFrom carries the earth model through", () => {
        const opts = terrestrialOptsFrom(
            {terrestrialRefraction: true, refractionPressure: 1010, refractionTemp: 10,
             terrestrialLapseRate: -6.5},
            {equatorRadius: WGS84_A, polarRadius: WGS84_B});
        expect(opts.enabled).toBe(true);
        expect(opts.k).toBeCloseTo(0.176, 3);
        expect(opts.equatorRadius).toBe(WGS84_A);
        expect(opts.polarRadius).toBe(WGS84_B);
        // default-off when the sitch has never set it
        expect(terrestrialOptsFrom({}, {}).enabled).toBe(false);
    });

    test("the Oresund case: a sea inversion doubles the Turning Torso lift", () => {
        // Mick's sitch settings, 20.574 km, over water at 22:00 local
        const R = 6385895;
        const land = terrestrialKFromAtmosphere(1017, 19, -13.7);
        const inversion = terrestrialKFromAtmosphere(1017, 19, 20);
        expect(land).toBeCloseTo(0.123, 3);
        expect(inversion).toBeCloseTo(0.325, 3);
        const arcmin = k => terrestrialBendAngle(20574, k, R) * RAD2ARCMIN;
        expect(arcmin(land)).toBeCloseTo(0.68, 2);
        expect(arcmin(inversion)).toBeCloseTo(1.80, 2);
    });
});

describe("saturation", () => {

    test("is negligible over the range the model is meant for", () => {
        // under 1% departure from the raw surveying law out to 100 km
        for (const d of [1000, 20600, 50000, 100000]) {
            const raw = 0.13 * d / (2 * R);
            expect(terrestrialBendAngle(d, 0.13, R) / raw).toBeGreaterThan(0.99);
        }
    });

    test("never exceeds the ceiling, however far away the geometry is", () => {
        const cap = TERRESTRIAL_REFRACTION_DEFAULTS.maxBendRad;
        for (const d of [1e6, 1e8, 1e12]) {
            expect(terrestrialBendAngle(d, 0.13, R)).toBeLessThan(cap);
        }
        // and it does approach it
        expect(terrestrialBendAngle(1e12, 0.13, R)).toBeGreaterThan(0.999 * cap);
    });

    test("is monotonic in distance", () => {
        let prev = -1;
        for (let d = 0; d <= 2e6; d += 1e4) {
            const bend = terrestrialBendAngle(d, 0.13, R);
            expect(bend).toBeGreaterThanOrEqual(prev);
            prev = bend;
        }
    });
});

describe("earth model", () => {

    test("a spherical earth returns that sphere's radius exactly", () => {
        // Sit.useEllipsoid = false passes equal radii
        for (const sinLat of [0, 0.5, 0.826, 1]) {
            expect(gaussianRadius(sinLat, R, R)).toBe(R);
        }
    });

    test("WGS84 curvature runs from the equator to the pole in the right order", () => {
        const eq = gaussianRadius(0, WGS84_A, WGS84_B);
        const cph = gaussianRadius(Math.sin(55.6405 * Math.PI / 180), WGS84_A, WGS84_B);
        const pole = gaussianRadius(1, WGS84_A, WGS84_B);
        expect(eq).toBeLessThan(cph);
        expect(cph).toBeLessThan(pole);
        // equator: sqrt(M*N) = a*sqrt(1-e2) = b
        expect(eq).toBeCloseTo(WGS84_B, 3);
        // pole: both radii are a^2/b
        expect(pole).toBeCloseTo(WGS84_A * WGS84_A / WGS84_B, 3);
        // Copenhagen sits close to the 6371 km mean, so using it barely matters
        expect(Math.abs(cph - R) / R).toBeLessThan(0.005);
    });

    test("the earth model changes the answer by well under the uncertainty in k", () => {
        const sphere = terrestrialLift(20600, 0.13, gaussianRadius(0.826, R, R));
        const ellipsoid = terrestrialLift(20600, 0.13, gaussianRadius(0.826, WGS84_A, WGS84_B));
        expect(Math.abs(sphere - ellipsoid) / sphere).toBeLessThan(0.01);
    });
});

describe("uniform update", () => {

    // Minimal stand-in for a Three camera: enough surface for the code under
    // test without dragging the renderer in. matrixWorld carries an identity
    // rotation, so view space and world space coincide and the published zenith
    // can be compared directly against the ECEF one.
    function fakeCamera(x, y, z) {
        const {Vector3, Matrix4} = require("three");
        const m = new Matrix4().makeTranslation(x, y, z);
        return {
            _p: new Vector3(x, y, z),
            matrixWorld: m,
            // Deliberately WRONG, to prove the code does not read it. Three only
            // refreshes this inside renderer.render(), and every caller here runs
            // before that.
            matrixWorldInverse: new Matrix4().makeRotationZ(1.0),
            updateMatrixWorld() {},
        };
    }

    // Copenhagen, on the ellipsoid surface
    const latRad = 55.6405185631 * Math.PI / 180;
    const lonRad = 12.6533004163 * Math.PI / 180;
    const e2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);
    const N = WGS84_A / Math.sqrt(1 - e2 * Math.sin(latRad) ** 2);
    const cph = fakeCamera(
        N * Math.cos(latRad) * Math.cos(lonRad),
        N * Math.cos(latRad) * Math.sin(lonRad),
        N * (1 - e2) * Math.sin(latRad),
    );

    test("disabled leaves k at zero, which is the shader's own off switch", () => {
        updateTerrestrialRefractionUniforms(cph, {enabled: false, k: 0.13});
        expect(terrestrialRefractionUniforms.uTerrK.value).toBe(0);
    });

    test("enabled publishes k, the geodetic zenith and the local curvature", () => {
        updateTerrestrialRefractionUniforms(cph, {
            enabled: true, k: 0.13,
            equatorRadius: WGS84_A, polarRadius: WGS84_B,
        });
        expect(terrestrialRefractionUniforms.uTerrK.value).toBeCloseTo(0.13, 10);
        // identity view matrix, so the published zenith is still the ECEF one
        const z = terrestrialRefractionUniforms.uTerrZenithView.value;
        expect(z.length()).toBeCloseTo(1, 10);
        expect(z.z).toBeCloseTo(Math.sin(latRad), 8);
        expect(1 / terrestrialRefractionUniforms.uTerrInvR.value)
            .toBeCloseTo(gaussianRadius(Math.sin(latRad), WGS84_A, WGS84_B), 3);
    });

    test("the published zenith is geodetic, not the geocentric radial", () => {
        updateTerrestrialRefractionUniforms(cph, {
            enabled: true, k: 0.13, equatorRadius: WGS84_A, polarRadius: WGS84_B,
        });
        const {Vector3} = require("three");
        const radial = new Vector3().copy(cph._p).normalize();
        const z = terrestrialRefractionUniforms.uTerrZenithView.value;
        const sepArcmin = Math.acos(Math.min(1, z.dot(radial))) * RAD2ARCMIN;
        // ~10.8' apart at this latitude — the same separation the celestial
        // path already accounts for
        expect(sepArcmin).toBeGreaterThan(10);
        expect(sepArcmin).toBeLessThan(11.6);
    });

    test("derives the view matrix from matrixWorld, not the cached inverse", () => {
        // Three refreshes camera.matrixWorldInverse inside renderer.render().
        // Every caller updates these uniforms BEFORE that, and the long-exposure
        // occlusion mask re-points the camera first, so reading the cached
        // inverse would bend about a stale — or simply wrong — axis.
        const {Vector3, Matrix4} = require("three");
        updateTerrestrialRefractionUniforms(cph, {
            enabled: true, k: 0.13, equatorRadius: WGS84_A, polarRadius: WGS84_B,
        });
        const fromWorld = terrestrialRefractionUniforms.uTerrZenithView.value.clone();

        // cph.matrixWorld has identity rotation, so the correct answer is the
        // plain ECEF zenith; the bogus cached inverse would rotate it by 1 rad.
        const {zenithECEFFromPosition} = require("../src/atmosphere/refraction");
        const ecefZenith = zenithECEFFromPosition(cph._p, new Vector3(), WGS84_A, WGS84_B);
        expect(fromWorld.dot(ecefZenith)).toBeCloseTo(1, 12);

        const ifItHadUsedTheCache = ecefZenith.clone()
            .transformDirection(new Matrix4().makeRotationZ(1.0));
        expect(fromWorld.dot(ifItHadUsedTheCache)).toBeLessThan(0.9);
    });

    test("a spherical earth collapses the zenith onto the radial", () => {
        updateTerrestrialRefractionUniforms(cph, {
            enabled: true, k: 0.13, equatorRadius: R, polarRadius: R,
        });
        const {Vector3} = require("three");
        const radial = new Vector3().copy(cph._p).normalize();
        const z = terrestrialRefractionUniforms.uTerrZenithView.value;
        expect(z.dot(radial)).toBeCloseTo(1, 12);
        expect(1 / terrestrialRefractionUniforms.uTerrInvR.value).toBeCloseTo(R, 6);
    });

    afterAll(() => {
        // leave the shared uniforms in their default-off state
        terrestrialRefractionUniforms.uTerrK.value = 0;
    });
});

describe("shader patching", () => {

    const STOCK = `
uniform mat4 projectionMatrix;
void main() {
\t#include <begin_vertex>
\t#include <project_vertex>
\tvViewPosition = - mvPosition.xyz;
}`;

    test("rewrites gl_Position and nothing else", () => {
        const out = patchTerrestrialRefractionVertexShader(STOCK);
        expect(out).toContain("applyTerrestrialRefraction_chunk(mvPosition.xyz)");
        expect(out).toContain("uniform float uTerrK;");
        // mvPosition itself is untouched, so view position, normals, world
        // position and shadow coordinates all stay physical
        expect(out).toContain("vViewPosition = - mvPosition.xyz;");
        expect(out).not.toContain("mvPosition.xyz = ");
        expect(out).not.toContain("transformed = ");
    });

    test("is idempotent — a second patch is a no-op", () => {
        const once = patchTerrestrialRefractionVertexShader(STOCK);
        expect(patchTerrestrialRefractionVertexShader(once)).toBe(once);
    });

    test("leaves a shader without <project_vertex> structurally alone", () => {
        const custom = "void main() {\n\tgl_Position = vec4(position, 1.0);\n}";
        const out = patchTerrestrialRefractionVertexShader(custom);
        expect(out).toContain("gl_Position = vec4(position, 1.0);");
        expect(out).not.toContain("applyTerrestrialRefraction_chunk(mvPosition");
    });

    test("installing on a material chains rather than replaces onBeforeCompile", () => {
        const calls = [];
        const material = {
            userData: {},
            onBeforeCompile: () => calls.push("original"),
            needsUpdate: false,
        };
        installTerrestrialRefractionOnMaterial(material);
        const shader = {uniforms: {}, vertexShader: STOCK};
        material.onBeforeCompile(shader, null);
        expect(calls).toEqual(["original"]);
        expect(shader.uniforms.uTerrK).toBe(terrestrialRefractionUniforms.uTerrK);
        expect(shader.vertexShader).toContain("applyTerrestrialRefraction_chunk");
        expect(material.needsUpdate).toBe(true);
    });

    test("installing twice does not double-wrap", () => {
        const calls = [];
        const material = {userData: {}, onBeforeCompile: () => calls.push("original")};
        installTerrestrialRefractionOnMaterial(material);
        const wrapped = material.onBeforeCompile;
        installTerrestrialRefractionOnMaterial(material);
        expect(material.onBeforeCompile).toBe(wrapped);
    });
});
