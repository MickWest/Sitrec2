// Terrestrial (finite-range) refraction of the solid scene.
//
// The numbers here are the Copenhagen → Turning Torso case that motivated the
// feature: a 20.574 km sight line across the Øresund, measured in Sitrec.
//
// ---------------------------------------------------------------------------
// REGRESSION MATRIX for this feature, from an adversarial review. Several of
// these cannot be unit tests — they are here because this is the file anyone
// changing the feature will open, and because the ones NOT yet covered are the
// ones most likely to break quietly.
//
// Covered here:
//   [x] Two otherwise-identical stock materials, one carrying another
//       onBeforeCompile patch (patchMaterialForLinearOutput), keep DISTINCT
//       program cache keys after installation. Three's default key is
//       onBeforeCompile.toString(), so wrapping it collapses that distinction
//       and materials silently share a program.
//   [x] A CLONE of a patched material installs independently. Material.copy()
//       JSON-copies userData but not onBeforeCompile, so install state must not
//       live in userData.
//   [x] A chained callback still receives the material as `this`.
//   [x] A shader that CALLS the chunk still gets the DEFINITION injected —
//       guard on the marker, never on the function name.
//   [x] Three's real sprite and LineMaterial sources still contain the anchors
//       the patcher matches, so a Three upgrade fails here rather than silently
//       leaving every LOS line geometric.
//
// Covered by `npm run test-fast` (pixel baselines, refraction default-off):
//   [x] Every baseline stays at 0 px with the feature disabled, including
//       scenes with sprites, Line2, glTF models and helpers. This is the check
//       that caught a shader failing to LINK — invisible to unit tests and to a
//       green build, because it breaks before uTerrK == 0 can matter.
//
// NOT yet covered — check these by hand until they are:
//   [ ] Stable-shadow receiver installed BEFORE and AFTER terrestrial
//       installation: both orders must compile with both patches present.
//   [ ] Serialize/restore a patched material; verify it ends up installed
//       exactly once.
//   [ ] Two simultaneous views with different cameras, plus a CubeCamera
//       environment map, all get camera-correct bend axes. Structurally handled
//       by the GlobalScene.onBeforeRender hook, but unverified.
//   [ ] Shadows, groundBelow, AGL, LOS traversal and terrain raycasts stay
//       geometric. True by construction (the warp is clip-position only) but
//       not asserted anywhere.
//   [ ] Line2 screen width and dash phase unchanged at 0.7 render scale, with
//       MSAA, and through viewport / scripted-video supersampled export.
//   [ ] Edge-of-frustum sprites, models and tiles do not pop. Culling and
//       transparent sorting both happen BEFORE the vertex shader, so a bent
//       object can be culled while visibly inside the frame.
//
// Blocked on work not done (see the commit log for why):
//   [ ] The long-exposure mask and aerial-distance prepass should exclude
//       CPU-apparent satellites and helpers, and match the silhouettes of every
//       geometry type they include. Both still render the whole scene through a
//       single override material that cannot reproduce Line2, sprite or
//       instanced transforms.
//   [ ] Labels, feature markers, track selection, picking and edit handles stay
//       attached at k=0.13, k=0.5 and at the 34' cap. Needs the CPU apparent-
//       projection helper and an iterative inverse for picking.
//
// Moot: the fallback globe is deliberately geometric — see the comment in
// Globe.js for the tessellation arithmetic.
// ---------------------------------------------------------------------------

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
    isTerrestrialRefractionInstalled,
    injectTerrestrialRefractionChunk,
    atmosphericDensityFactor,
    pathDensityFactor,
    saturateLift,
    ellipsoidAltitude,
} from "../src/atmosphere/terrestrialRefraction";
import {MeshBasicMaterial, PerspectiveCamera, ShaderLib, Vector3} from "three";
import {readFileSync} from "fs";
import path from "path";

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

// A ray only curves where there is air. Without this the surveying law charged
// the full surface k over a sight line that is almost entirely vacuum, and a
// camera at 237 km lofted the visible limb of the Earth by 15 km.
describe("altitude: only the air along the path bends the ray", () => {

    const H = TERRESTRIAL_REFRACTION_DEFAULTS.scaleHeightM;

    test("density is 1 at sea level and 1/e one scale height up", () => {
        expect(atmosphericDensityFactor(0, H)).toBe(1);
        expect(atmosphericDensityFactor(H, H)).toBeCloseTo(Math.E ** -1, 12);
    });

    test("below sea level counts as sea level, never as denser-than-surface", () => {
        expect(atmosphericDensityFactor(-500, H)).toBe(1);
        expect(pathDensityFactor(-500, -200, H)).toBe(1);
    });

    // THE load-bearing case. Everything Sitrec is actually used for — an
    // observer on the deck looking at terrain on the deck — must come out of
    // this layer completely untouched, or the change is a regression dressed
    // up as a fix.
    test("a ground observer looking at the ground is EXACTLY unchanged", () => {
        expect(pathDensityFactor(0, 0, H)).toBe(1);
    });

    test("equal heights give the density at that height, not 0/0", () => {
        for (const h of [0, 1, 500, 8500, 40000]) {
            expect(pathDensityFactor(h, h, H)).toBeCloseTo(atmosphericDensityFactor(h, H), 12);
        }
        // and approaching equality is continuous, not a cliff
        expect(pathDensityFactor(5000 + 1e-9, 5000, H))
            .toBeCloseTo(atmosphericDensityFactor(5000, H), 9);
    });

    test("the path is the same path in either direction", () => {
        expect(pathDensityFactor(9000, 0, H)).toBeCloseTo(pathDensityFactor(0, 9000, H), 12);
    });

    test("a higher observer always crosses thinner air", () => {
        let prev = Infinity;
        for (const h of [0, 1000, 4000, 10000, 30000, 100000, 237300]) {
            const f = pathDensityFactor(h, 0, H);
            expect(f).toBeLessThan(prev);
            expect(f).toBeGreaterThan(0);
            expect(f).toBeLessThanOrEqual(1);
            prev = f;
        }
    });

    test("far above the atmosphere the factor is H/h — the fraction in air", () => {
        // e^-h/H has died, so the integral is all of H over all of h
        expect(pathDensityFactor(237300, 0, H)).toBeCloseTo(H / 237300, 9);
        expect(pathDensityFactor(237300, 0, H)).toBeCloseTo(0.03582, 5);
    });

    test("a 4 km observer keeps most of it — this is the look view", () => {
        expect(pathDensityFactor(4000, 0, H)).toBeCloseTo(0.79765, 5);
    });

    test("a path entirely above the air bends essentially nothing", () => {
        expect(pathDensityFactor(200000, 100000, H)).toBeLessThan(1e-4);
    });
});

describe("the lift is bounded, not just the angle", () => {

    const maxLift = TERRESTRIAL_REFRACTION_DEFAULTS.maxLiftM;

    test("real geometry is untouched by the ceiling", () => {
        // a ground observer at its 300 km horizon lifts by ~1.2 km, far below
        const lift = terrestrialLift(300000, 0.1755, R);
        expect(lift).toBeGreaterThan(1000);
        expect(saturateLift(lift, maxLift) / lift).toBeGreaterThan(0.998);
    });

    test("never exceeds the ceiling however absurd the range", () => {
        for (const d of [1e6, 1e7, 1e9, 1e12]) {
            expect(saturateLift(terrestrialLift(d, 0.1755, R), maxLift)).toBeLessThan(maxLift);
        }
    });

    test("is monotonic and smooth — a hard clamp would crease the terrain", () => {
        let prev = -1;
        for (let d = 1e5; d <= 1e7; d *= 1.5) {
            const l = saturateLift(terrestrialLift(d, 0.1755, R), maxLift);
            expect(l).toBeGreaterThan(prev);
            prev = l;
        }
    });

    test("a saturated ANGLE still lifts linearly — which is why this exists", () => {
        // the bug: bend has flattened at maxBendRad, yet lift = d*bend keeps climbing
        const near = terrestrialLift(3e6, 0.1755, R);
        const far = terrestrialLift(6e6, 0.1755, R);
        expect(far / near).toBeGreaterThan(1.9);
        expect(far).toBeGreaterThan(50000);
    });
});

describe("the regression this fixes: a camera in space", () => {

    const H = TERRESTRIAL_REFRACTION_DEFAULTS.scaleHeightM;
    const maxLift = TERRESTRIAL_REFRACTION_DEFAULTS.maxLiftM;
    const k = 0.17552;              // standard air, -6.5 K/km
    const obsAlt = 237300;          // the default sitch's main camera
    const limb = 1693000;           // horizontal range to the visible limb from there

    // Reproduces applyTerrestrialRefraction_chunk on the CPU.
    const liftWithAltitude = (d, hObs, hTgt) =>
        saturateLift(terrestrialLift(d, k * pathDensityFactor(hObs, hTgt, H), R), maxLift);

    test("the bare law lofted the visible limb by 15 km", () => {
        expect(terrestrialLift(limb, k, R)).toBeGreaterThan(15000);
    });

    test("accounting for the air drops that by more than 10x", () => {
        const fixed = liftWithAltitude(limb, obsAlt, 0);
        expect(fixed).toBeLessThan(1500);
        expect(terrestrialLift(limb, k, R) / fixed).toBeGreaterThan(10);
    });

    test("the deck is not paying for it — the density layer is exactly transparent", () => {
        // A ground-to-ground path crosses full-density air by definition, so the
        // attenuation is identically 1 and k is handed through untouched.
        expect(k * pathDensityFactor(0, 0, H)).toBe(k);
    });

    test("...and the lift ceiling perturbs a ground sight line negligibly", () => {
        // The ceiling is a guard, not free: it does shave a little even well
        // below itself. At the far end of what a ground observer can see it is
        // ~0.1% — 1.3 m in 1200 — which is orders of magnitude under the spread
        // in k itself (0 to >0.5 across the lapse rates this file describes).
        for (const d of [1000, 20600, 100000, 300000]) {
            const rel = 1 - liftWithAltitude(d, 0, 0) / terrestrialLift(d, k, R);
            expect(rel).toBeGreaterThanOrEqual(0);
            expect(rel).toBeLessThan(2e-3);
        }
        expect(1 - liftWithAltitude(20600, 0, 0) / terrestrialLift(20600, k, R)).toBeLessThan(1e-7);
    });
});

describe("observer altitude reaches the shader", () => {

    test("ellipsoidAltitude is zero on the surface at both extremes", () => {
        expect(ellipsoidAltitude(new Vector3(WGS84_A, 0, 0), WGS84_A, WGS84_B)).toBeCloseTo(0, 6);
        expect(ellipsoidAltitude(new Vector3(0, 0, WGS84_B), WGS84_A, WGS84_B)).toBeCloseTo(0, 6);
    });

    test("and reads back a height put in", () => {
        expect(ellipsoidAltitude(new Vector3(WGS84_A + 237300, 0, 0), WGS84_A, WGS84_B))
            .toBeCloseTo(237300, 6);
    });

    test("a sphere makes it exactly the radial height", () => {
        expect(ellipsoidAltitude(new Vector3(0, R + 1234, 0), R, R)).toBeCloseTo(1234, 6);
    });

    // The radial altitude is not the geodetic one, so pin how far apart they are
    // rather than leaving it to a comment. Reference: Bowring's closed-form
    // inverse. Metres, at altitudes spanning a cockpit to low orbit.
    test("agrees with a geodetic solution to within a metre", () => {
        const a = WGS84_A, b = WGS84_B;
        const e2 = (a * a - b * b) / (a * a), ep2 = (a * a - b * b) / (b * b);
        const geodeticHeight = (p) => {
            const P = Math.hypot(p.x, p.y);
            const th = Math.atan2(p.z * a, P * b);
            const lat = Math.atan2(p.z + ep2 * b * Math.sin(th) ** 3,
                                   P - e2 * a * Math.cos(th) ** 3);
            const N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
            return Math.abs(Math.cos(lat)) > 0.3
                ? P / Math.cos(lat) - N
                : p.z / Math.sin(lat) - N * (1 - e2);
        };
        for (const latDeg of [0, 29, 32, 55.6, 80, 89.9]) {
            for (const h of [0, 4000, 10000, 242000]) {
                const lat = latDeg * Math.PI / 180;
                const N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
                const p = new Vector3(
                    (N + h) * Math.cos(lat), 0, (N * (1 - e2) + h) * Math.sin(lat));
                expect(Math.abs(ellipsoidAltitude(p, a, b) - geodeticHeight(p))).toBeLessThan(1.5);
            }
        }
    });

    test("the uniform update publishes it, per camera", () => {
        const cam = new PerspectiveCamera(30, 1, 1, 1e9);
        cam.position.set(WGS84_A + 237300, 0, 0);
        cam.updateMatrixWorld();
        updateTerrestrialRefractionUniforms(cam, {
            enabled: true, k: 0.1755, equatorRadius: WGS84_A, polarRadius: WGS84_B,
        });
        expect(terrestrialRefractionUniforms.uTerrObsAlt.value).toBeCloseTo(237300, 3);

        cam.position.set(WGS84_A + 4000, 0, 0);
        cam.updateMatrixWorld();
        updateTerrestrialRefractionUniforms(cam, {
            enabled: true, k: 0.1755, equatorRadius: WGS84_A, polarRadius: WGS84_B,
        });
        expect(terrestrialRefractionUniforms.uTerrObsAlt.value).toBeCloseTo(4000, 3);
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
        const {vertexShader: out, matched} = patchTerrestrialRefractionVertexShader(STOCK);
        expect(matched).toBe(true);
        expect(out).toContain("applyTerrestrialRefraction_chunk(mvPosition.xyz)");
        expect(out).toContain("uniform float uTerrK;");
        // mvPosition itself is untouched, so view position, normals, world
        // position and shadow coordinates all stay physical
        expect(out).toContain("vViewPosition = - mvPosition.xyz;");
        expect(out).not.toContain("mvPosition.xyz = ");
        expect(out).not.toContain("transformed = ");
    });

    test("is idempotent — a second patch is a no-op", () => {
        const once = patchTerrestrialRefractionVertexShader(STOCK).vertexShader;
        expect(patchTerrestrialRefractionVertexShader(once).vertexShader).toBe(once);
    });

    test("reports no match rather than silently leaving a custom shader geometric", () => {
        const custom = "void main() {\n\tgl_Position = vec4(position, 1.0);\n}";
        const {vertexShader: out, matched} = patchTerrestrialRefractionVertexShader(custom);
        expect(matched).toBe(false);
        expect(out).toBe(custom);
    });

    test("installing on a material chains rather than replaces onBeforeCompile", () => {
        const calls = [];
        const material = new MeshBasicMaterial();
        material.onBeforeCompile = () => calls.push("original");
        const versionBefore = material.version;
        installTerrestrialRefractionOnMaterial(material);
        const shader = {uniforms: {}, vertexShader: STOCK};
        material.onBeforeCompile(shader, null);
        expect(calls).toEqual(["original"]);
        expect(shader.uniforms.uTerrK).toBe(terrestrialRefractionUniforms.uTerrK);
        expect(shader.vertexShader).toContain("applyTerrestrialRefraction_chunk");
        // needsUpdate is write-only in Three; it bumps version, which is what
        // actually triggers the recompile
        expect(material.version).toBe(versionBefore + 1);
    });

    test("installing twice does not double-wrap", () => {
        const material = new MeshBasicMaterial();
        installTerrestrialRefractionOnMaterial(material);
        const wrapped = material.onBeforeCompile;
        installTerrestrialRefractionOnMaterial(material);
        expect(material.onBeforeCompile).toBe(wrapped);
    });

    // --- the four defects the Codex review found in the shipped installer ---

    test("chained callbacks keep `this` — Three calls onBeforeCompile on the material", () => {
        // StableShadowReceiver's callback reads this.userData; an arrow-function
        // wrapper calling prev(shader) unbound would throw or silently misbehave
        // while compiling a shadow-receiving model.
        let seenThis = null;
        const material = new MeshBasicMaterial();
        material.userData.marker = "mine";
        material.onBeforeCompile = function () { seenThis = this; };
        installTerrestrialRefractionOnMaterial(material);
        material.onBeforeCompile.call(material, {uniforms: {}, vertexShader: STOCK}, null);
        expect(seenThis).toBe(material);
        expect(seenThis.userData.marker).toBe("mine");
    });

    test("two materials differing only in a prior patch keep DIFFERENT program keys", () => {
        // Three's default cache key is onBeforeCompile.toString(). Wrapping it
        // would make every patched material report the same key, so a material
        // carrying patchMaterialForLinearOutput could share a program with one
        // that does not — a silent, unrelated rendering regression.
        const plain = new MeshBasicMaterial();
        const patched = new MeshBasicMaterial();
        patched.onBeforeCompile = function (shader) { shader.fragmentShader += "// linear"; };
        const beforePlain = plain.customProgramCacheKey();
        const beforePatched = patched.customProgramCacheKey();
        expect(beforePlain).not.toBe(beforePatched);

        installTerrestrialRefractionOnMaterial(plain);
        installTerrestrialRefractionOnMaterial(patched);
        expect(plain.customProgramCacheKey()).not.toBe(patched.customProgramCacheKey());
        // and both are distinct from their un-installed selves
        expect(plain.customProgramCacheKey()).not.toBe(beforePlain);
    });

    test("a material defining its own cache key still has it called through", () => {
        const material = new MeshBasicMaterial();
        let calls = 0;
        material.customProgramCacheKey = function () { calls++; return "mine.v3"; };
        installTerrestrialRefractionOnMaterial(material);
        const key = material.customProgramCacheKey();
        expect(calls).toBe(1);
        expect(key).toContain("mine.v3");
    });

    test("a CLONE of a patched material is installed independently", () => {
        // Material.copy() JSON-copies userData but not onBeforeCompile, so
        // storing install state in userData would leave clones marked-but-
        // unpatched forever. CNode3DObject and CNodeDisplayATFLIR clone materials.
        const material = new MeshBasicMaterial();
        installTerrestrialRefractionOnMaterial(material);
        const clone = material.clone();
        expect(isTerrestrialRefractionInstalled(material)).toBe(true);
        expect(isTerrestrialRefractionInstalled(clone)).toBe(false);

        installTerrestrialRefractionOnMaterial(clone);
        expect(isTerrestrialRefractionInstalled(clone)).toBe(true);
        const shader = {uniforms: {}, vertexShader: STOCK};
        clone.onBeforeCompile.call(clone, shader, null);
        expect(shader.vertexShader).toContain("applyTerrestrialRefraction_chunk");
    });

    // --- the chunk must be DEFINED, not merely referenced ---

    test("a shader that CALLS the chunk still gets the definition injected", () => {
        // The guard used to test for the function NAME, so a shader calling
        // applyTerrestrialRefraction_chunk (synth-cloud billboards, Gaussian
        // splats) looked like it already had the definition. Injection skipped,
        // and the shader died with "no matching overloaded function found" —
        // which took the synthetic clouds out of the Beaver regression sitch.
        const callsChunk = "void main() {\n"
            + "\tvec4 mv = modelViewMatrix * vec4(position, 1.0);\n"
            + "\tmv.xyz = applyTerrestrialRefraction_chunk(mv.xyz);\n"
            + "\tgl_Position = projectionMatrix * mv;\n}";
        const out = injectTerrestrialRefractionChunk(callsChunk);
        expect(out).toContain("vec3 applyTerrestrialRefraction_chunk(vec3 viewPos)");
        expect(out).toContain("uniform float uTerrK;");
        // and injecting again is still a no-op
        expect(injectTerrestrialRefractionChunk(out)).toBe(out);
    });

    test("Three's real sprite shader gets both the patch and the definition", () => {
        const {vertexShader: out, matched} =
            patchTerrestrialRefractionVertexShader(ShaderLib.sprite.vertexShader);
        expect(matched).toBe(true);
        expect(out).toContain("vec3 applyTerrestrialRefraction_chunk(vec3 viewPos)");
        // anchor lofted...
        expect(out).toContain("mvPosition.xyz = applyTerrestrialRefraction_chunk(mvPosition.xyz);");
        // ...then restored, so clipping planes and fog stay geometric
        expect(out).toContain("mvPosition = sitrecPhysicalMV;");
        expect(out.indexOf("mvPosition = sitrecPhysicalMV;"))
            .toBeLessThan(out.indexOf("#include <fog_vertex>"));
    });

    test("Three's real fat-line shader lofts both endpoints", () => {
        // Read the addon source rather than importing it: three/addons is ESM
        // and breaks this Jest runner. Reading still pins the anchors, so a
        // Three upgrade that rewrites those lines fails here rather than
        // silently leaving every LOS line and track geometric.
        const src = readFileSync(path.resolve(__dirname,
            "../node_modules/three/examples/jsm/lines/LineMaterial.js"), "utf8");
        expect(src).toContain("vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );");
        expect(src).toContain("vec4 mvPosition = ( position.y < 0.5 ) ? start : end; // this is an approximation");

        const vert = "void main() {\n"
            + "\t\t\tvec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );\n"
            + "\t\t\tvec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );\n"
            + "\t\t\tvec4 clipStart = projectionMatrix * start;\n"
            + "\t\t\tgl_Position = clipStart;\n"
            + "\t\t\tvec4 mvPosition = ( position.y < 0.5 ) ? start : end; // this is an approximation\n}";
        const {vertexShader: out, matched} = patchTerrestrialRefractionVertexShader(vert);
        expect(matched).toBe(true);
        expect(out).toContain("vec3 applyTerrestrialRefraction_chunk(vec3 viewPos)");
        expect(out).toContain("start.xyz = applyTerrestrialRefraction_chunk(start.xyz);");
        expect(out).toContain("end.xyz = applyTerrestrialRefraction_chunk(end.xyz);");
        // endpoints warped BEFORE anything derives from them
        expect(out.indexOf("start.xyz = applyTerrestrialRefraction_chunk"))
            .toBeLessThan(out.indexOf("vec4 clipStart = projectionMatrix * start;"));
        // and the approximate mvPosition handed to clipping/fog stays physical
        expect(out).toContain("? sitrecPhysicalStart : sitrecPhysicalEnd;");
    });

    test("an unsupported custom shader warns instead of failing silently", () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        const material = new MeshBasicMaterial();
        installTerrestrialRefractionOnMaterial(material);
        const shader = {uniforms: {}, vertexShader: "void main() {\n\tgl_Position = vec4(0.0);\n}"};
        material.onBeforeCompile.call(material, shader, null);
        material.onBeforeCompile.call(material, shader, null);   // once per material
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain("geometric position");
        warn.mockRestore();
    });
});
