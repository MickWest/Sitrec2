// Time > Show Time Zones: the build script that extracts borders from timezone-boundary-builder
// (scripts/buildTimeZoneBorders.js), the decoder in src/TimeZoneBorders.js, and the shipped
// data file.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const {borderChains, simplifyChain, encodeBorders, buildBorders, standardOffsetHours, UNKNOWN_SIDE} =
    require("../scripts/buildTimeZoneBorders.js");

jest.mock("../src/SceneLines", () => ({SceneLineSegments: class {}}));
jest.mock("../src/SceneLineMaterial", () => ({SceneLineMaterial: class {}}));
jest.mock("../src/nodes/CNodeDisplaySkyOverlay", () => ({registerLabel3D: () => {}, unregisterLabel3D: () => {}}));
const {decodeTimeZoneBorders} = require("../src/TimeZoneBorders");

const byName = feature => feature.properties.tzid;

// Three zones: A and B share the vertical edge x = 1 (0 <= y <= 2); C sits apart.
const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const feature = (tzid, ring) => ({type: "Feature", properties: {tzid}, geometry: {type: "Polygon", coordinates: [ring]}});
const THREE_ZONES = {
    type: "FeatureCollection",
    features: [
        feature("A", [[0, 0], [1, 0], [1, 1], [1, 2], [0, 2], [0, 0]]),
        feature("B", [[1, 0], [2, 0], [2, 2], [1, 2], [1, 1], [1, 0]]),
        feature("C", square(5, 5, 6, 6)),
    ],
};

test("only edges between two groups are borders; outer edges are dropped", () => {
    const chains = borderChains(THREE_ZONES, byName);
    expect(chains).toHaveLength(1);
    expect(new Set(chains[0].points.map(([x]) => x))).toEqual(new Set([1]));
    expect(chains[0].points.map(([, y]) => y).sort()).toEqual([0, 1, 2]);
});

test("each border knows which zone is on its left and its right, facing along it", () => {
    // A is west of B. Walking north along x = 1, A is on the left; walking south, on the right.
    // Both ring directions must give the same answer (A runs counterclockwise, B clockwise here).
    const [chain] = borderChains(THREE_ZONES, byName);
    const north = chain.points[chain.points.length - 1][1] > chain.points[0][1];
    expect([chain.left, chain.right]).toEqual(north ? ["A", "B"] : ["B", "A"]);
    const flipped = {...THREE_ZONES, features: THREE_ZONES.features.map(f =>
        feature(f.properties.tzid, [...f.geometry.coordinates[0]].reverse()))};
    const [again] = borderChains(flipped, byName);
    const againNorth = again.points[again.points.length - 1][1] > again.points[0][1];
    expect([again.left, again.right]).toEqual(againNorth ? ["A", "B"] : ["B", "A"]);
});

test("zones in the same group (same standard offset) have no border between them", () => {
    expect(borderChains(THREE_ZONES, () => "same")).toHaveLength(0);
});

test("the standard offset ignores daylight saving time", () => {
    expect(standardOffsetHours("America/Denver")).toBe(-7);
    expect(standardOffsetHours("America/Phoenix")).toBe(-7);    // so no Arizona / New Mexico line
    expect(standardOffsetHours("Europe/London")).toBe(0);
    expect(standardOffsetHours("Australia/Sydney")).toBe(10);   // southern summer is in January
    expect(standardOffsetHours("Asia/Kathmandu")).toBe(5.75);
});

test("a border along the 180-degree meridian is found, though its two sides say +180 and -180", () => {
    const dateLine = {
        type: "FeatureCollection",
        features: [
            feature("East", [[170, -10], [180, -10], [180, 10], [170, 10], [170, -10]]),
            feature("West", [[-180, -10], [-170, -10], [-170, 10], [-180, 10], [-180, -10]]),
        ],
    };
    const chains = borderChains(dateLine, byName);
    expect(chains).toHaveLength(1);
    expect(chains[0].points.every(([lon]) => Math.abs(lon) === 180)).toBe(true);
});

test("the 180-degree border is found when the two sides put their points at different latitudes", () => {
    // East has points at 10 S, 0 and 10 N on the meridian; West only at 10 S, 5 N and 10 N.
    const mismatched = {
        type: "FeatureCollection",
        features: [
            feature("East", [[170, -10], [180, -10], [180, 0], [180, 10], [170, 10], [170, -10]]),
            feature("West", [[-180, -10], [-170, -10], [-170, 10], [-180, 10], [-180, 5], [-180, -10]]),
        ],
    };
    const chains = borderChains(mismatched, byName);
    expect(chains).toHaveLength(1);
    const lats = chains[0].points.map(([, lat]) => lat).sort((a, b) => a - b);
    expect(lats).toEqual([-10, 0, 5, 10]);
});

test("a border loop with no junction (an enclave) is kept as a closed line", () => {
    const enclave = {
        type: "FeatureCollection",
        features: [
            {type: "Feature", properties: {tzid: "Outer"}, geometry: {type: "Polygon",
                coordinates: [square(0, 0, 10, 10), square(4, 4, 6, 6).reverse()]}},
            feature("Inner", square(4, 4, 6, 6)),
        ],
    };
    const chains = borderChains(enclave, byName);
    expect(chains).toHaveLength(1);
    expect(chains[0].points).toHaveLength(5);
    expect(chains[0].points[0]).toEqual(chains[0].points[4]);
    // Simplifying a closed loop must not collapse it to its start point.
    expect(simplifyChain(chains[0].points, 0.5).length).toBeGreaterThanOrEqual(3);
});

test("simplification keeps the end points and the corners, and drops near-straight points", () => {
    const chain = [[0, 0], [1, 0.0001], [2, 0], [2, 1], [2, 2]];
    expect(simplifyChain(chain, 0.001)).toEqual([[0, 0], [2, 0], [2, 2]]);
    expect(simplifyChain(chain, 0.00001)).toEqual([[0, 0], [1, 0.0001], [2, 0], [2, 2]]);
});

test("simplification works across the 180-degree meridian", () => {
    // A straight line from 179.5 E to 179.5 W: the middle points go, and nothing is 360 degrees long.
    const chain = [[179.5, 0], [179.9, 0.00001], [-179.9, 0], [-179.5, 0]];
    expect(simplifyChain(chain, 0.001)).toEqual([[179.5, 0], [-179.5, 0]]);
    // A real bend near the meridian stays.
    expect(simplifyChain([[179.5, 0], [179.99, 1], [-179.5, 0]], 0.001)).toHaveLength(3);
});

test("encode then decode gives the points back to 1e-4 degree, and the sides", () => {
    const lines = [
        {points: [[-179.9999, -89.5], [0.123456, 12.345678], [179.9999, 89.5]], left: "-7", right: "5.75"},
        {points: [[10, 20], [10.0001, 20.0002], [9.9, 19.8]], left: "-3.5", right: undefined},
    ];
    const decoded = decodeTimeZoneBorders(new Uint8Array(encodeBorders(lines)));
    expect(Array.from(decoded.counts)).toEqual([3, 3]);
    expect(Array.from(decoded.left)).toEqual([-7, -3.5]);
    expect(decoded.right[0]).toBe(5.75);
    expect(decoded.right[1]).toBeNaN();         // an unknown side (overlapping zones)
    expect(UNKNOWN_SIDE).toBe(127);
    lines.flatMap(line => line.points).forEach(([lon, lat], i) => {
        expect(Math.abs(decoded.lonLat[2 * i] - lon)).toBeLessThanOrEqual(0.5e-4 + 1e-12);
        expect(Math.abs(decoded.lonLat[2 * i + 1] - lat)).toBeLessThanOrEqual(0.5e-4 + 1e-12);
    });
});

test("the decoder refuses a file of the wrong kind or length", () => {
    expect(() => decodeTimeZoneBorders(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0]))).toThrow(/not a time zone border file/);
    const good = new Uint8Array(encodeBorders(buildBorders(THREE_ZONES, 0.001, () => "1")
        .concat([{points: [[0, 0], [1, 1]], left: "1", right: "2"}])));
    expect(() => decodeTimeZoneBorders(good.slice(0, good.length - 1))).toThrow(/too short|wrong length/);
    const extra = new Uint8Array(good.length + 1);
    extra.set(good);
    expect(() => decodeTimeZoneBorders(extra)).toThrow(/wrong length/);
});

test("the shipped data file decodes, with the borders of an ordinary time zone map", () => {
    const file = path.resolve(__dirname, "../data/timezones/timezone-borders.bin.gz");
    const {counts, lonLat, left, right} = decodeTimeZoneBorders(new Uint8Array(zlib.gunzipSync(fs.readFileSync(file))));
    expect(counts.length).toBeGreaterThan(300);
    // Every line has two different standard offsets on its sides, except where zones overlap.
    let unknown = 0;
    for (let i = 0; i < counts.length; i++) {
        if (Number.isNaN(left[i]) || Number.isNaN(right[i])) { unknown++; continue; }
        expect(left[i]).not.toBe(right[i]);
        expect(Math.abs(left[i])).toBeLessThanOrEqual(14);
    }
    expect(unknown).toBeLessThan(20);
    for (let i = 0; i < lonLat.length; i += 2) {
        expect(Math.abs(lonLat[i])).toBeLessThanOrEqual(180);
        expect(Math.abs(lonLat[i + 1])).toBeLessThanOrEqual(90);
    }
    // True when some SEGMENT passes within `tolerance` degrees of the point. A straight border
    // keeps only its end points, so testing points is not enough. Longitudes go the short
    // way across the 180-degree meridian, as the renderer draws them.
    const near = (lon, lat, tolerance) => {
        const unwrap = (x, reference) => x - 360 * Math.round((x - reference) / 360);
        let k = 0;
        for (const count of counts) {
            for (let j = 0; j < count; j++, k += 2) {
                if (j === 0) continue;
                const x0 = lonLat[k - 2], y0 = lonLat[k - 1];
                const x1 = unwrap(lonLat[k], x0), y1 = lonLat[k + 1], px = unwrap(lon, x0);
                const dx = x1 - x0, dy = y1 - y0, lengthSq = dx * dx + dy * dy;
                const f = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x0) * dx + (lat - y0) * dy) / lengthSq));
                if (Math.hypot(px - (x0 + f * dx), lat - (y0 + f * dy)) < tolerance) return true;
            }
        }
        return false;
    };
    // Land: Western Australia (UTC+8 / +9.5) along 129 E, and Spain / Portugal (UTC+1 / 0).
    expect(near(129, -26, 0.05)).toBe(true);
    expect(near(-7.0, 38.9, 0.3)).toBe(true);
    // Same standard time, so no line: France / Germany, and Arizona / New Mexico (both UTC-7).
    expect(near(7.7, 48.6, 0.3)).toBe(false);
    expect(near(-109.05, 33.5, 0.05)).toBe(false);
    // Sea: the UTC-3 / UTC-4 band edge at 52.5 W in the South Atlantic, and the date line.
    expect(near(-52.5, -45, 0.05)).toBe(true);
    expect(near(180, -50, 0.05)).toBe(true);
});
