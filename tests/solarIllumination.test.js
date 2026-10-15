import {satelliteIllumination, SOLAR_ILLUMINATION_DEFAULTS} from "../tools/shf/solarIllumination";

const R = 6371000;
const sun = {x: 1, y: 0, z: 0};
const sphere = {equatorRadius: R, polarRadius: R};
const geometric = {atmosphere: false, solarLimbDarkening: 0};

// Independent reference: densely sample a Cartesian solar image, then solve
// each three-dimensional ellipsoid intersection directly. This deliberately
// does not use the production limb-aligned strips or quadrature weights.
function denseDiskReference(pos, toSun, options, resolution = 420) {
    const a = options.equatorRadius ?? SOLAR_ILLUMINATION_DEFAULTS.equatorRadius;
    const b = options.polarRadius ?? SOLAR_ILLUMINATION_DEFAULTS.polarRadius;
    const alpha = options.solarAngularRadius ?? SOLAR_ILLUMINATION_DEFAULTS.solarAngularRadius;
    const limb = options.solarLimbDarkening ?? 0;
    const n = Math.hypot(toSun.x, toSun.y, toSun.z);
    const s = [toSun.x / n, toSun.y / n, toSun.z / n];
    let u = Math.abs(s[2]) < 0.9 ? [-s[1], s[0], 0] : [0, -s[2], s[1]];
    const un = Math.hypot(...u); u = u.map(x => x / un);
    let v = [s[1] * u[2] - s[2] * u[1], s[2] * u[0] - s[0] * u[2], s[0] * u[1] - s[1] * u[0]];
    // Rotate the reference image grid so an axis-aligned eclipse edge does not
    // alias whole rows of pixels into a biased numerical reference.
    const originalU = u, originalV = v, cr = Math.cos(0.37), sr = Math.sin(0.37);
    u = originalU.map((x, i) => cr * x + sr * originalV[i]);
    v = originalV.map((x, i) => cr * x - sr * originalU[i]);
    const p = [pos.x / a, pos.y / a, pos.z / b];
    const c = p[0] ** 2 + p[1] ** 2 + p[2] ** 2 - 1;
    let total = 0, visible = 0;
    for (let ix = 0; ix < resolution; ix++) for (let iy = 0; iy < resolution; iy++) {
        const x = 2 * (ix + 0.5) / resolution - 1, y = 2 * (iy + 0.5) / resolution - 1;
        if (x * x + y * y >= 1) continue;
        const weight = 1 - limb + limb * Math.sqrt(1 - x * x - y * y);
        const d = s.map((q, i) => (q + Math.tan(alpha) * (x * u[i] + y * v[i])) / (i === 2 ? b : a));
        const qa = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
        const qb = 2 * (p[0] * d[0] + p[1] * d[1] + p[2] * d[2]);
        const discriminant = qb * qb - 4 * qa * c;
        total += weight;
        if (!(discriminant > 0 && (-qb + Math.sqrt(discriminant)) / (2 * qa) > 0)) visible += weight;
    }
    return visible / total;
}

describe("satellite sunlight illumination", () => {
    test("invalid propagation or geometry cannot publish nonfinite brightness", () => {
        const pos = {x: R + 550000, y: 0, z: 0};
        expect(satelliteIllumination({...pos, z: NaN}, sun)).toBe(0);
        expect(satelliteIllumination(pos, {x: Infinity, y: 0, z: 0})).toBe(0);
        expect(satelliteIllumination(pos, {x: 0, y: 0, z: 0})).toBe(0);
        expect(satelliteIllumination(pos, sun, {equatorRadius: Infinity})).toBe(0);
        expect(satelliteIllumination(pos, sun, {solarAngularRadius: NaN})).toBe(0);
        expect(Number.isFinite(satelliteIllumination({x: -2704000, y: R, z: 0}, sun, {...sphere, solarLimbDarkening: NaN}))).toBe(true);
    });

    test("fully exposed and deeply eclipsed satellites have exact limiting states", () => {
        for (const atmosphere of [false, true]) {
            expect(satelliteIllumination({x: R + 550000, y: 0, z: 0}, sun, {...sphere, atmosphere})).toBe(1);
            expect(satelliteIllumination({x: -R - 550000, y: 0, z: 0}, sun, {...sphere, atmosphere})).toBe(0);
            expect(satelliteIllumination({x: 0, y: 0, z: R + 550000}, sun, {...sphere, atmosphere})).toBe(1);
        }
    });

    test("a point Sun follows the ellipsoid rather than an inscribed polar sphere", () => {
        const a = 6378137, b = 6356752.314245179;
        const options = {equatorRadius: a, polarRadius: b, atmosphere: false, solarAngularRadius: 0};
        expect(satelliteIllumination({x: -2704000, y: a - 5000, z: 0}, sun, options)).toBe(0);
        expect(satelliteIllumination({x: -2704000, y: a + 1, z: 0}, sun, options)).toBe(1);
        expect(satelliteIllumination({x: -2704000, y: 0, z: b + 1}, sun, options)).toBe(1);
        expect(satelliteIllumination({x: -2704000, y: 0, z: b - 1}, sun, options)).toBe(0);
    });

    test.each([
        [{x: -2704000, y: 6378137 - 7000, z: 0}, sun, 0],
        [{x: -2704000, y: 6378137, z: 0}, sun, 0.69],
        [{x: -2704000, y: 0, z: 6356752.314245179 + 5000}, sun, 0],
        [{x: 2704000, y: 0, z: -6356752.314245179 - 5000}, {x: -1, y: 0, z: 0}, 0.69],
        [{x: 0, y: -2704000, z: 6356752.314245179 - 4000}, {x: 0, y: 1, z: 0}, 0],
    ])("finite-Sun geometry agrees with independent dense rays: %j", (pos, direction, limb) => {
        const options = {...geometric, solarLimbDarkening: limb};
        const expected = denseDiskReference(pos, direction, options);
        expect(Math.abs(satelliteIllumination(pos, direction, options) - expected)).toBeLessThan(0.00045);
    });

    test("a last solar crescent remains fractional inside central-ray shadow", () => {
        const pos = {x: -2295535.3174166093, y: -4586740.558059468, z: 4517156.04981242};
        const direction = {x: -0.3130854229915097, y: 0.9236545282528861, z: 0.22099735371303794};
        const flux = satelliteIllumination(pos, direction, geometric);
        expect(flux).toBeGreaterThan(0.0038);
        expect(flux).toBeLessThan(0.0045);
        expect(Math.abs(flux - denseDiskReference(pos, direction, geometric, 620))).toBeLessThan(0.00018);
        expect(satelliteIllumination(pos, direction, {...geometric, solarAngularRadius: 0})).toBe(0);
    });

    test("V-band atmospheric ingress reproduces published independent eclipse trends", () => {
        // Mallama 2021, Table B.1, https://arxiv.org/abs/2112.08310.
        // These predictions already integrate the solar disk. A 15% allowance
        // covers the documented standard-density transmission versus its fits;
        // no coefficient is adjusted to reproduce an eclipse table or image.
        for (const [heightKm, publishedFlux] of [[-0.30, 0.045], [9.81, 0.166], [20.22, 0.441], [49.95, 0.979]]) {
            const flux = satelliteIllumination({x: -2704000, y: R + heightKm * 1000, z: 0}, sun, sphere);
            expect(Math.abs(flux / publishedFlux - 1)).toBeLessThan(0.15);
        }
    });

    test("the atmospheric model includes refractive light below geometric umbra", () => {
        const pos = {x: -2704000, y: R - 20000, z: 0};
        expect(satelliteIllumination(pos, sun, {...sphere, ...geometric})).toBe(0);
        const refracted = satelliteIllumination(pos, sun, sphere);
        expect(refracted).toBeGreaterThan(0.0001);
        expect(refracted).toBeLessThan(0.01);
    });

    test("flux is bounded and varies continuously through the eclipse", () => {
        for (const atmosphere of [false, true]) {
            let previous = 0;
            for (let height = -100000; height <= 160000; height += 500) {
                const flux = satelliteIllumination({x: -2704000, y: R + height, z: 0}, sun, {...sphere, atmosphere});
                expect(Number.isFinite(flux) && flux >= 0 && flux <= 1).toBe(true);
                expect(flux - previous).toBeGreaterThan(-0.0004);
                expect(flux - previous).toBeLessThan(0.03);
                previous = flux;
            }
        }
    });

    test("illumination is invariant under equatorial rotation and hemisphere reflection", () => {
        const p = {x: -2704000, y: 2700000, z: 5750000};
        for (const atmosphere of [false, true]) {
            const options = {atmosphere};
            const flux = satelliteIllumination(p, sun, options);
            expect(satelliteIllumination({x: -p.y, y: p.x, z: p.z}, {x: 0, y: 1, z: 0}, options)).toBeCloseTo(flux, 10);
            expect(satelliteIllumination({...p, z: -p.z}, sun, options)).toBeCloseTo(flux, 10);
            expect(satelliteIllumination(p, {x: 8, y: 0, z: 0}, options)).toBeCloseTo(flux, 12);
        }
    });

    test("fast clear-state evaluation and near-limb quadrature stay practical", () => {
        satelliteIllumination({x: -2704000, y: R, z: 0}, sun, sphere); // initialize atmosphere once
        let total = 0;
        const farStart = performance.now();
        for (let i = 0; i < 100000; i++) total += satelliteIllumination({x: R + 550000, y: i % 1000, z: 0}, sun);
        expect(total).toBe(100000);
        expect(performance.now() - farStart).toBeLessThan(1500);
        const limbStart = performance.now();
        for (let i = 0; i < 2000; i++) total += satelliteIllumination({x: -2704000, y: R + (i % 100) * 500, z: 0}, sun, sphere);
        expect(performance.now() - limbStart).toBeLessThan(2000);
    });
});
