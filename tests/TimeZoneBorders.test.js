// Time > Show Time Zones: the build script that extracts the time zone map from
// timezone-boundary-builder (scripts/buildTimeZoneBorders.js), the decoder and the zones at a
// point (src/TimeZoneMapData.js), the fill and the map at an instant (src/TimeZoneFill.js), and
// the shipped data file.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const {borderChains, simplifyChain, encodeBorders, buildBorders, standardOffsetHours, innerPoint} =
    require("../scripts/buildTimeZoneBorders.js");

jest.mock("../src/SceneLines", () => ({SceneLineSegments: class {}}));
jest.mock("../src/SceneLineMaterial", () => ({SceneLineMaterial: class {}, displayPixelScale: () => 1}));
jest.mock("../src/nodes/CNodeDisplaySkyOverlay", () => ({registerLabel3D: () => {}, unregisterLabel3D: () => {}}));
require("../src/TimeZoneBorders");      // loads, with its mocks, beside the modules below
const {decodeTimeZoneBorders, makeZoneLocator} = require("../src/TimeZoneMapData");
const {utcOffsetHoursInZone} = require("../src/TimeZoneLookup");
const {buildTimeZoneFill, densifySegment, faceStyle, fillStyles, paletteIndex, zoneMapAt, FILL_MAX_EDGE_DEG} =
    require("../src/TimeZoneFill");

const byName = feature => feature.properties.tzid;

// Three zones: A and B share the vertical edge x = 1 (0 <= y <= 2); C sits apart. The zone
// names are their groups (byName); the tests of the file format use offsets as names.
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

test("a border is found where one side has a vertex the other side's edge passes through", () => {
    // B has a vertex at (1, 1) on the shared edge; A runs straight from (1, 0) to (1, 2).
    const tJunction = {
        type: "FeatureCollection",
        features: [
            feature("A", [[0, 0], [1, 0], [1, 2], [0, 2], [0, 0]]),
            feature("B", [[1, 0], [2, 0], [2, 2], [1, 2], [1, 1], [1, 0]]),
        ],
    };
    const chains = borderChains(tJunction, byName);
    expect(chains).toHaveLength(1);
    expect(chains[0].points.map(([, y]) => y).sort()).toEqual([0, 1, 2]);
});

// Offsets as zone names, for the faces and the file format: a name that is a number is its own
// standard offset, and no browser knows it, so zoneMapAt uses that.
const byOffset = feature => feature.properties.tzid;

test("the faces: each area between the arcs, with the zones that cover it", () => {
    // "-5" and "-6" side by side; "-6" also covers a strip of "-5" (an overlap); "1" apart, with
    // a "3" island in it (a hole).
    const map = buildBorders({
        type: "FeatureCollection",
        features: [
            feature("-5", square(0, 0, 4, 4)),
            feature("-6", [[3, 0], [8, 0], [8, 4], [3, 4], [3, 0]]),
            {type: "Feature", properties: {tzid: "1"}, geometry: {type: "Polygon",
                coordinates: [square(20, 0, 30, 10), square(24, 4, 26, 6).reverse()]}},
            feature("3", square(24, 4, 26, 6)),
        ],
    }, 0.001, byOffset);
    expect(map.faces.map(face => face.groups).sort()).toEqual(["-5", "-5|-6", "-6", "1", "3"]);
    expect(map.zones).toEqual([{name: "-5", standard: -5}, {name: "-6", standard: -6},
        {name: "1", standard: 1}, {name: "3", standard: 3}]);
    const withHole = map.faces.find(face => face.groups === "1");
    expect(withHole.rings).toHaveLength(2);         // the outer ring and the island
    expect(withHole.zones).toEqual([2]);
    // Each arc knows its faces; outside these shapes there is none.
    for (const arc of map.arcs) {
        expect(arc.leftFace).not.toBe(arc.rightFace);
        expect(Math.max(arc.leftFace, arc.rightFace)).toBeGreaterThanOrEqual(0);
    }
    // The island's coast has the island on one side and the "1" face on the other.
    const island = map.faces.findIndex(face => face.groups === "3");
    const sea = map.faces.indexOf(withHole);
    expect(map.arcs.some(arc => [arc.leftFace, arc.rightFace].sort().join() === [island, sea].sort().join())).toBe(true);
});

test("a face inside another zone's hole gets that zone from a point test, though no edge of it touches the face", () => {
    // "2" covers the square with a hole; "1" covers all of it, so the hole is "1" only. No edge of
    // "1" touches the hole, so its arcs alone say nothing about "1" (the West Bank case).
    const map = buildBorders({
        type: "FeatureCollection",
        features: [
            feature("1", square(0, 0, 10, 10)),
            {type: "Feature", properties: {tzid: "2"}, geometry: {type: "Polygon",
                coordinates: [square(0, 0, 10, 10), square(4, 4, 6, 6).reverse()]}},
        ],
    }, 0.001, byOffset);
    expect(map.faces.map(face => face.groups).sort()).toEqual(["1", "1|2"]);
    expect(map.stats.zonesAdded).toHaveLength(1);
});

test("the point for that test is well inside the face, or there is none", () => {
    // A C shape: the box centre (5, 5) is outside it.
    const c = [[0, 0], [10, 0], [10, 2], [2, 2], [2, 8], [10, 8], [10, 10], [0, 10]];
    const [x, y] = innerPoint([c]);
    const inside = (px, py) => (px > 0 && px < 10 && py > 0 && py < 2) || (px > 0 && px < 2 && py > 0 && py < 10)
        || (px > 0 && px < 10 && py > 8 && py < 10);
    expect(inside(x, y)).toBe(true);
    expect(Math.min(x, y, 10 - x, 10 - y)).toBeGreaterThan(0.5);
    // A hole is outside: a square with a big hole leaves only the frame.
    const [hx, hy] = innerPoint([square(0, 0, 10, 10), square(1, 1, 9, 9).reverse()]);
    expect(hx < 1 || hx > 9 || hy < 1 || hy > 9).toBe(true);
    // A sliver 5 m wide is too thin for a safe test.
    expect(innerPoint([square(0, 0, 1, 0.00005)])).toBeNull();
});

test("a face that holds a pole is closed through it", () => {
    // "12" covers all longitudes south of 86 S, split at the 180-degree meridian like the source.
    // (The points between -180 and 180 matter: those two are one vertex.)
    const band = (lat0, lat1) => [[-180, lat0], [-90, lat0], [0, lat0], [90, lat0], [180, lat0],
        [180, lat1], [90, lat1], [0, lat1], [-90, lat1], [-180, lat1], [-180, lat0]];
    const map = buildBorders({
        type: "FeatureCollection",
        features: [feature("12", band(-90, -86)), feature("0", band(-86, -80))],
    }, 0.001, byOffset);
    const cap = map.faces.find(face => face.groups === "12");
    expect(cap.pole).toBe(-1);
});

test("encode then decode gives the zones, the points, the arc sides and the faces back", () => {
    const zones = [{name: "America/Phoenix", standard: -7}, {name: "Asia/Kathmandu", standard: 5.75},
        {name: "Nowhere/Unknown", standard: NaN}];
    const arcs = [
        {points: [[-179.9999, -89.5], [0.123456, 12.345678], [179.9999, 89.5]], leftFace: 0, rightFace: 1},
        {points: [[10, 20], [10.0001, 20.0002], [9.9, 19.8]], leftFace: 1, rightFace: -1},
    ];
    const faces = [{zones: [0], pole: 0, rings: [[0, 3]]}, {zones: [1, 2], pole: -1, rings: [[1], [2, 3]]}];
    const decoded = decodeTimeZoneBorders(new Uint8Array(encodeBorders({zones, arcs, faces})));
    expect(decoded.zones.slice(0, 2)).toEqual(zones.slice(0, 2));
    expect(decoded.zones[2].name).toBe("Nowhere/Unknown");
    expect(decoded.zones[2].standard).toBeNaN();
    expect(Array.from(decoded.counts)).toEqual([3, 3]);
    expect(Array.from(decoded.leftFace)).toEqual([0, 1]);
    expect(Array.from(decoded.rightFace)).toEqual([1, -1]);
    expect(decoded.faces).toEqual(faces);
    arcs.flatMap(arc => arc.points).forEach(([lon, lat], i) => {
        expect(Math.abs(decoded.lonLat[2 * i] - lon)).toBeLessThanOrEqual(0.5e-4 + 1e-12);
        expect(Math.abs(decoded.lonLat[2 * i + 1] - lat)).toBeLessThanOrEqual(0.5e-4 + 1e-12);
    });
});

test("the decoder refuses a file of the wrong kind or length", () => {
    expect(() => decodeTimeZoneBorders(new Uint8Array(20))).toThrow(/not a time zone border file/);
    const good = new Uint8Array(encodeBorders(buildBorders(THREE_ZONES, 0.001, () => "1")));
    expect(() => decodeTimeZoneBorders(good.slice(0, good.length - 1))).toThrow(/too short|wrong length/);
    const extra = new Uint8Array(good.length + 1);
    extra.set(good);
    expect(() => decodeTimeZoneBorders(extra)).toThrow(/wrong length/);
});

test("fill colors repeat every 6 hours, with stripes for a fraction of an hour and for overlaps", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(paletteIndex)).toEqual([0, 1, 2, 3, 4, 5, 0]);
    expect(paletteIndex(-1)).toBe(5);
    expect(paletteIndex(13)).toBe(paletteIndex(-11));     // the same clock time, a day apart
    expect(faceStyle([-8])).toEqual({a: paletteIndex(-8), b: paletteIndex(-7), fraction: 0});
    expect(faceStyle([5.5])).toEqual({a: 5, b: 0, fraction: 0.5});             // India
    expect(faceStyle([5.75])).toEqual({a: 5, b: 0, fraction: 0.75});           // Nepal
    expect(faceStyle([-3.5])).toEqual({a: paletteIndex(-4), b: paletteIndex(-3), fraction: 0.5});
    expect(faceStyle([8, 6])).toEqual({a: 0, b: 2, fraction: 0.5});            // Xinjiang
    expect(faceStyle([5.5, 5.75])).toEqual({a: 5, b: 0, fraction: 0.5});       // same start: next color
    expect(faceStyle([NaN])).toBeNull();
});

test("the map at an instant: offsets with daylight saving time decide the lines and the colors", () => {
    // Faces 0 and 1 are "Phoenix" and "Denver": the same standard offset, but Denver is an hour
    // later in summer. Face 2 has an unknown zone (its standard offset is used) and face 3 none.
    const borders = {
        zones: [{name: "Phoenix", standard: -7}, {name: "Denver", standard: -7},
            {name: "Unknown", standard: 3}, {name: "Nothing", standard: NaN}],
        faces: [{zones: [0]}, {zones: [1]}, {zones: [2]}, {zones: [3]}, {zones: [0, 1]}],
        leftFace: Int32Array.from([0, 1, 2, -1, 4]),
        rightFace: Int32Array.from([1, 2, 0, 0, 0]),
    };
    const summer = date => date.getUTCMonth() >= 3 && date.getUTCMonth() <= 9;
    const offsetOf = (name, date) => (name === "Phoenix" ? -7 : name === "Denver" ? (summer(date) ? -6 : -7) : null);
    const january = zoneMapAt(borders, new Date(Date.UTC(2026, 0, 15)), offsetOf);
    const july = zoneMapAt(borders, new Date(Date.UTC(2026, 6, 15)), offsetOf);
    expect(january.faceOffsets).toEqual([[-7], [-7], [3], [], [-7]]);
    expect(july.faceOffsets).toEqual([[-7], [-6], [3], [], [-7, -6]]);
    // Phoenix | Denver is a line in July only; an arc with no face beyond it never is.
    expect(Array.from(january.border)).toEqual([0, 1, 1, 0, 0]);
    expect(Array.from(july.border)).toEqual([1, 1, 1, 0, 1]);
    expect([july.left[0], july.right[0]]).toEqual([-7, -6]);
    expect(july.left[4]).toBeNaN();                     // two offsets: an overlap
    expect(january.key).not.toBe(july.key);
    // The colors follow: Denver is the -6 color in July, and the face with no offset is not drawn.
    const fill = {lonLat: new Float64Array(10), faceStart: Uint32Array.from([0, 1, 2, 3, 4, 5])};
    const styles = fillStyles(fill, july.faceOffsets);
    expect(styles[3]).toBe(paletteIndex(-6));
    expect(styles[9]).toBe(-1);
    expect([styles[12], styles[13], styles[14]]).toEqual([paletteIndex(-7), paletteIndex(-6), 0.5]);
});

// The shipped file, decoded once for the tests below.
const shipped = (() => {
    let decoded = null;
    return () => {
        if (!decoded) {
            const file = path.resolve(__dirname, "../data/timezones/timezone-borders.bin.gz");
            decoded = decodeTimeZoneBorders(new Uint8Array(zlib.gunzipSync(fs.readFileSync(file))));
        }
        return decoded;
    };
})();

test("the shipped data file decodes, with the borders of an ordinary time zone map", () => {
    const borders = shipped();
    const {zones, counts, lonLat, faces} = borders;
    expect(zones.length).toBeGreaterThan(250);      // the 1970 set: 304 zones in 2026f
    // A zone has no standard offset only when the Node that built the file did not know it.
    for (const zone of zones.filter(zone => !Number.isFinite(zone.standard))) {
        expect(utcOffsetHoursInZone(zone.name, new Date())).toBeNull();
    }
    expect(counts.length).toBeGreaterThan(300);
    expect(faces.length).toBeGreaterThan(300);
    for (let i = 0; i < lonLat.length; i += 2) {
        expect(Math.abs(lonLat[i])).toBeLessThanOrEqual(180);
        expect(Math.abs(lonLat[i + 1])).toBeLessThanOrEqual(90);
    }
    const january = zoneMapAt(borders, new Date(Date.UTC(2026, 0, 15, 12)));
    const july = zoneMapAt(borders, new Date(Date.UTC(2026, 6, 15, 12)));
    // Every drawn line has two different offsets on its sides, except where zones overlap.
    for (const map of [january, july]) {
        let unknown = 0, drawn = 0;
        for (let i = 0; i < counts.length; i++) {
            if (!map.border[i]) continue;
            drawn++;
            if (Number.isNaN(map.left[i]) || Number.isNaN(map.right[i])) { unknown++; continue; }
            expect(map.left[i]).not.toBe(map.right[i]);
            expect(Math.abs(map.left[i])).toBeLessThanOrEqual(14);
        }
        expect(drawn).toBeGreaterThan(300);
        expect(unknown).toBeLessThan(80);
    }
    // True when some drawn SEGMENT passes within `tolerance` degrees of the point. A straight
    // border keeps only its end points, so testing points is not enough. Longitudes go the short
    // way across the 180-degree meridian, as the renderer draws them.
    const near = (map, lon, lat, tolerance) => {
        const unwrap = (x, reference) => x - 360 * Math.round((x - reference) / 360);
        let k = 0;
        for (let line = 0; line < counts.length; line++) {
            for (let j = 0; j < counts[line]; j++, k += 2) {
                if (j === 0 || !map.border[line]) continue;
                const x0 = lonLat[k - 2], y0 = lonLat[k - 1];
                const x1 = unwrap(lonLat[k], x0), y1 = lonLat[k + 1], px = unwrap(lon, x0);
                const dx = x1 - x0, dy = y1 - y0, lengthSq = dx * dx + dy * dy;
                const f = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x0) * dx + (lat - y0) * dy) / lengthSq));
                if (Math.hypot(px - (x0 + f * dx), lat - (y0 + f * dy)) < tolerance) return true;
            }
        }
        return false;
    };
    for (const map of [january, july]) {
        // Land: Western Australia (UTC+8 / +9:30 or +10:30) along 129 E, and Spain / Portugal.
        expect(near(map, 129, -26, 0.05)).toBe(true);
        expect(near(map, -7.0, 38.9, 0.3)).toBe(true);
        // The same clock since 1980, so no line in 2026: France / Germany.
        expect(near(map, 7.7, 48.6, 0.3)).toBe(false);
        // Sea: the UTC-3 / UTC-4 band edge at 52.5 W in the South Atlantic, and the date line.
        expect(near(map, -52.5, -45, 0.05)).toBe(true);
        expect(near(map, 180, -50, 0.05)).toBe(true);
        // Antarctica: the UTC+1 band meets the UTC+0 Troll sector along 68 S. Before the
        // T-junction repair this line was missing (Troll's edge runs 0-25 E without a vertex).
        // In July Troll is on UTC+2, so the line is there in both months.
        expect(near(map, 15, -68, 0.05)).toBe(true);
    }
    // Arizona / New Mexico: the same in January (UTC-7), an hour apart in July.
    expect(near(january, -109.05, 33.5, 0.05)).toBe(false);
    expect(near(july, -109.05, 33.5, 0.05)).toBe(true);
});

test("the fill covers the whole globe once, in small triangles that end on the border lines", () => {
    const borders = shipped();
    const fill = buildTimeZoneFill(borders);
    const {lonLat, index} = fill;
    expect(fill.faceStart[borders.faces.length]).toBe(lonLat.length / 2);
    // Area on the unit sphere, from each triangle in the longitude/latitude plane times the
    // cosine of its latitude (an approximation that is good for small triangles).
    let area = 0, longest = 0;
    const length = (a, b) => Math.max(Math.abs(lonLat[2 * a] - lonLat[2 * b])
        * Math.cos((lonLat[2 * a + 1] + lonLat[2 * b + 1]) * Math.PI / 360), Math.abs(lonLat[2 * a + 1] - lonLat[2 * b + 1]));
    for (let t = 0; t < index.length; t += 3) {
        const [a, b, c] = [index[t], index[t + 1], index[t + 2]];
        const ax = lonLat[2 * a], ay = lonLat[2 * a + 1], bx = lonLat[2 * b], by = lonLat[2 * b + 1];
        const cx = lonLat[2 * c], cy = lonLat[2 * c + 1];
        area += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2 * Math.cos((ay + by + cy) / 3 * Math.PI / 180);
        longest = Math.max(longest, length(a, b), length(b, c), length(c, a));
    }
    const sphere = 4 * Math.PI * (180 / Math.PI) ** 2;          // square degrees
    expect(Math.abs(area / sphere - 1)).toBeLessThan(0.001);   // no gaps, nothing twice
    expect(longest).toBeLessThanOrEqual(FILL_MAX_EDGE_DEG + 1e-9);
    expect(index.length / 3).toBeLessThan(300000);
    // Every point of every arc that can be a line (a face on each side) is a vertex of the fill,
    // so a color ends on its line. The points are compared to 1e-6 degree: a point can be
    // computed from either end of a segment. A closed loop of 3 points (an islet that simplified
    // to a line there and back) has no fill.
    const grid = value => Math.round(value * 1e6);
    const wrap = lon => ((lon % 360) + 540) % 360 - 180;
    const vertices = new Set();
    for (let i = 0; i < lonLat.length; i += 2) vertices.add(`${grid(wrap(lonLat[i]))},${grid(lonLat[i + 1])}`);
    const isVertex = (lon, lat) => {
        const x = grid(wrap(lon)), y = grid(lat);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) if (vertices.has(`${x + dx},${y + dy}`)) return true;
        }
        return false;
    };
    let k = 0, missing = 0, checked = 0;
    for (let line = 0; line < borders.counts.length; line++) {
        const count = borders.counts[line];
        const islet = count <= 3 && borders.lonLat[k] === borders.lonLat[k + 2 * (count - 1)]
            && borders.lonLat[k + 1] === borders.lonLat[k + 2 * (count - 1) + 1];
        const canBeLine = borders.leftFace[line] >= 0 && borders.rightFace[line] >= 0;
        for (let j = 0; j < count; j++, k += 2) {
            if (j === 0 || !canBeLine || islet) continue;
            densifySegment(borders.lonLat[k - 2], borders.lonLat[k - 1], borders.lonLat[k], borders.lonLat[k + 1], (lon, lat) => {
                checked++;
                if (!isVertex(lon, lat)) missing++;
            });
        }
    }
    expect(checked).toBeGreaterThan(30000);
    expect(missing).toBe(0);
}, 60000);

test("the zones at a point are the true zones, also where a small area has its own clock", () => {
    const locate = makeZoneLocator(shipped());
    const places = [
        [33.448, -112.074, ["America/Phoenix"]],                // Arizona: no DST
        [36.135, -111.240, ["America/Denver"]],                 // Tuba City, Navajo Nation: DST
        [35.875, -110.620, ["America/Phoenix"]],                // Kykotsmovi, Hopi inside Navajo: no DST
        [39.768, -86.158, ["America/Indiana/Indianapolis"]],
        [41.296, -86.625, ["America/Indiana/Knox"]],
        [48.757, -91.621, ["America/Panama"]],                  // Atikokan (IANA links it to Panama)
        [51.427, -57.131, ["America/Puerto_Rico"]],             // Blanc-Sablon (linked to Puerto Rico)
        [76.767, -18.667, ["America/Danmarkshavn"]],            // UTC all year, unlike the rest of Greenland
        [31.690, -106.424, ["America/Ciudad_Juarez"]],
        [-45.571, -72.068, ["America/Coyhaique"]],
        [-31.553, 159.082, ["Australia/Lord_Howe"]],
        [-31.954, 141.465, ["Australia/Broken_Hill"]],
        [27.717, 85.324, ["Asia/Kathmandu"]],
        [43.825, 87.617, ["Asia/Shanghai", "Asia/Urumqi"]],     // Xinjiang: two zones on purpose
        [52.520, 13.405, ["Europe/Berlin"]],
        [50.088, 14.420, ["Europe/Prague"]],                    // Prague and Bratislava had summer
        [48.149, 17.107, ["Europe/Prague"]],                    // time in 1979, Berlin from 1980
    ];
    for (const [lat, lon, zones] of places) {
        expect([lat, lon, locate(lat, lon).sort()]).toEqual([lat, lon, zones]);
    }
    // At sea, the nautical band (merged with an island zone that has the same clock since 1970).
    const sea = locate(0, -140);
    expect(sea).toHaveLength(1);
    expect(utcOffsetHoursInZone(sea[0], new Date(Date.UTC(2025, 0, 15)))).toBe(-9);
    // Wrapped longitudes, and an invalid point.
    expect(locate(33.448, -112.074 + 360)).toEqual(["America/Phoenix"]);
    expect(locate(91, 0)).toEqual([]);
    // The West Bank's Area A pockets (Hebron, Nablus) are holes of Asia/Jerusalem inside the West
    // Bank: before the point test they had no face at all.
    for (const [lat, lon] of [[31.532, 35.095], [32.222, 35.262]]) {
        expect(locate(lat, lon)).toContain("Asia/Hebron");
    }
    // The poles.
    expect(locate(-89.9, 10).length).toBeGreaterThan(0);
    expect(locate(89.9, 10).length).toBeGreaterThan(0);
});

test("every arc of the shipped file has a different face on each side", () => {
    // An arc with the same face on both sides means two areas were wrongly joined into one face.
    // In 2026f a 3 m2 loop on the Germany / Czechia border did that to Germany and Czechia, until
    // the build dropped such tiny loops.
    const {leftFace, rightFace} = shipped();
    const same = [];
    for (let i = 0; i < leftFace.length; i++) {
        if (leftFace[i] >= 0 && leftFace[i] === rightFace[i]) same.push(i);
    }
    expect(same).toEqual([]);
});

test("the map is right for past dates: its zones have one history since 1970", () => {
    // With the "now" set, British Columbia was grouped with Phoenix and showed UTC-7 in January
    // 2025; it was on PST, UTC-8. (Dates before 2026: this Node's tzdata can be older.)
    const borders = shipped();
    const locate = makeZoneLocator(borders);
    const offsetAt = (lat, lon, iso) => {
        const zones = locate(lat, lon);
        const index = zones.map(name => borders.zones.findIndex(zone => zone.name === name));
        const faceOffsets = zoneMapAt({...borders, faces: [{zones: index}], leftFace: new Int32Array(0),
            rightFace: new Int32Array(0)}, new Date(iso)).faceOffsets[0];
        return faceOffsets;
    };
    expect(offsetAt(49.283, -123.121, "2025-01-15T12:00:00Z")).toEqual([-8]);     // Vancouver
    expect(offsetAt(51.045, -114.057, "2025-01-15T12:00:00Z")).toEqual([-7]);     // Calgary
    expect(offsetAt(49.895, -97.138, "2025-01-15T12:00:00Z")).toEqual([-6]);      // Winnipeg
    expect(offsetAt(19.433, -99.133, "2015-07-15T12:00:00Z")).toEqual([-5]);      // Mexico City, DST until 2022
    expect(offsetAt(33.573, -7.590, "2025-07-15T12:00:00Z")).toEqual([1]);        // Casablanca
    expect(offsetAt(55.755, 37.617, "2010-07-15T12:00:00Z")).toEqual([4]);        // Moscow, DST until 2011
});
