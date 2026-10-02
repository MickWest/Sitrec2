import {
    cloudFieldNodeId,
    isCloudFieldJSON,
    localAxesEN,
    localENU,
    normalizeCloudField,
    windVelocityEN,
} from "../src/cloudField/CloudFieldFormat";

function field(overrides = {}) {
    return {
        type: "SitrecCloudField",
        version: 1,
        frame: {origin: {lat: 28.5, lon: -79.5, alt: 7620}, headingDeg: 315},
        wind: {fromDeg: 240, knots: 17, epochFrame: 2},
        spheres: [[1000, 2000, -4000, 20, 0.5], [-3000, 500, -4100, 60, 1.25]],
        ...overrides,
    };
}

describe("CloudFieldFormat", () => {
    test("detects only SitrecCloudField objects", () => {
        expect(isCloudFieldJSON(field())).toBe(true);
        expect(isCloudFieldJSON({type: "Other"})).toBe(false);
        expect(isCloudFieldJSON(null)).toBe(false);
    });

    test("packs spheres and keeps frame and wind", () => {
        const out = normalizeCloudField(field());
        expect(out.count).toBe(2);
        expect(Array.from(out.centers)).toEqual([1000, 2000, -4000, -3000, 500, -4100]);
        expect(Array.from(out.radii)).toEqual([20, 60]);
        expect(Array.from(out.emissions)).toEqual([0.5, 1.25]);
        expect(out.maxEmission).toBe(1.25);
        expect(out.origin).toEqual({lat: 28.5, lon: -79.5, alt: 7620});
        expect(out.headingDeg).toBe(315);
        expect(out.wind).toEqual({fromDeg: 240, knots: 17, epochFrame: 2});
        expect(out.profile).toBe("thinEmission");
        expect(normalizeCloudField(field({display: {gain: 0.25, refraction: false}})).display).toEqual({gain: 0.25, minEmission: 0, refraction: false});
        expect(() => normalizeCloudField(field({display: {refraction: "no"}}))).toThrow(/refraction/);
    });

    test("defaults wind to calm and profile to thinEmission", () => {
        const input = field();
        delete input.wind;
        const out = normalizeCloudField(input);
        expect(out.wind).toEqual({fromDeg: 0, knots: 0, epochFrame: 0});
        expect(out.display).toEqual({gain: 1, minEmission: 0, refraction: true});
    });

    test("rejects bad input with a readable message", () => {
        expect(() => normalizeCloudField(field({spheres: []}))).toThrow(/non-empty/);
        expect(() => normalizeCloudField(field({spheres: [[0, 0, 0, -1, 1]]}))).toThrow(/sphere 0/);
        expect(() => normalizeCloudField(field({spheres: [[0, 0, 0, 1]]}))).toThrow(/sphere 0/);
        expect(() => normalizeCloudField(field({frame: {}}))).toThrow(/origin/);
        expect(() => normalizeCloudField(field({profile: "opaque"}))).toThrow(/profile/);
        expect(() => normalizeCloudField(field({version: 99}))).toThrow(/newer/);
    });

    test("local +y points along the heading, +x is 90 degrees clockwise", () => {
        const north = localAxesEN(0);
        expect(north.y.north).toBeCloseTo(1);
        expect(north.x.east).toBeCloseTo(1);
        const northwest = localAxesEN(315);
        expect(northwest.y.east).toBeCloseTo(-Math.SQRT1_2);
        expect(northwest.y.north).toBeCloseTo(Math.SQRT1_2);
        expect(northwest.x.east).toBeCloseTo(Math.SQRT1_2);
        expect(northwest.x.north).toBeCloseTo(Math.SQRT1_2);
    });

    test("wind is named by where it comes from", () => {
        const westerly = windVelocityEN(270, 100);
        expect(westerly.east).toBeCloseTo(100 * 1852 / 3600);
        expect(westerly.north).toBeCloseTo(0);
    });

    test("matches the Gimbal scene's declared cloud wind in its local frame", () => {
        // scene_joint_airdata_full_ISA: cloudWind from 240 at 17 kt is [8.4476, -2.2635] m/s
        // in the local frame whose +y is at 315 degrees true.
        const w = windVelocityEN(240, 17);
        const axes = localAxesEN(315);
        const x = w.east * axes.x.east + w.north * axes.x.north;
        const y = w.east * axes.y.east + w.north * axes.y.north;
        expect(x).toBeCloseTo(8.447557976356952, 6);
        expect(y).toBeCloseTo(-2.263516337779935, 6);
    });

    test("node ids are stable and never shared by two files", () => {
        expect(cloudFieldNodeId("Clouds.json")).toBe("CloudField_Clouds_2ejson");
        const names = ["a b.json", "a_b.json", "a_20b.json", "a/b.json", "a.b.json", "a\u00e9.json", "a\u{1F600}.json", "a\u{1F60}0.json",
            "Clouds.json", "Clouds.JSON", "Clouds.JSON.json", "Clouds"];
        const ids = names.map(cloudFieldNodeId);
        expect(new Set(ids).size).toBe(names.length);
        expect(cloudFieldNodeId("a b.json")).toBe(cloudFieldNodeId("a b.json"));
    });

    test("accepts any latitude, including the poles, and rejects beyond them", () => {
        for (const lat of [90, -90, 89.95, 0]) {
            expect(normalizeCloudField(field({frame: {origin: {lat, lon: 0, alt: 0}}})).origin.lat).toBe(lat);
        }
        expect(() => normalizeCloudField(field({frame: {origin: {lat: 90.5, lon: 0, alt: 0}}}))).toThrow(/range/);
    });

    test("local ENU is orthonormal and right-handed everywhere, poles included", () => {
        const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        for (const [lat, lon] of [[90, 0], [-90, 45], [89.95, -79.5], [28.5, -79.5], [0, 180]]) {
            const {east, north, up} = localENU(lat, lon);
            for (const v of [east, north, up]) expect(dot(v, v)).toBeCloseTo(1, 12);
            expect(dot(east, north)).toBeCloseTo(0, 12);
            expect(dot(east, up)).toBeCloseTo(0, 12);
            expect(dot(north, up)).toBeCloseTo(0, 12);
            cross(east, north).forEach((c, i) => expect(c).toBeCloseTo(up[i], 12));
        }
        // At 28.5 N the geodetic up has z = sin(lat).
        expect(localENU(28.5, -79.5).up[2]).toBeCloseTo(Math.sin(28.5 * Math.PI / 180), 12);
    });
});
