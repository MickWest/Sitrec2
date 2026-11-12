import {PerspectiveCamera, Vector3} from "three";
import {drawHorizonCompassRibbon, horizonCompassFrame} from "../src/HorizonCompassRibbon";

const a = 6378137;
const b = 6356752.314245;

test("sea-level bearings run clockwise from north and wrap at 360 degrees", () => {
    const frame = horizonCompassFrame(new Vector3(a, 0, 0), a, b);
    expect(frame.direction(0).distanceTo(new Vector3(0, 0, 1))).toBeLessThan(1e-12);
    expect(frame.direction(90).distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-12);
    expect(frame.direction(180).distanceTo(new Vector3(0, 0, -1))).toBeLessThan(1e-12);
    expect(frame.direction(270).distanceTo(new Vector3(0, -1, 0))).toBeLessThan(1e-12);
    expect(frame.direction(360).distanceTo(frame.direction(0))).toBeLessThan(1e-12);
});

test.each([10, 10000, 400000])("spherical horizon dip at %s meters matches the analytic angle", height => {
    const frame = horizonCompassFrame(new Vector3(a + height, 0, 0), a, a);
    const expected = -Math.acos(a / (a + height));
    for (const az of [0, 45, 90, 180, 275]) {
        const direction = frame.direction(az);
        expect(Math.asin(direction.dot(frame.up))).toBeCloseTo(expected, 10);
        expect(direction.length()).toBeCloseTo(1, 12);
    }
});

test.each([0, 37, 70, 90, -45])("horizon rays are tangent to the ellipsoid at latitude %s", latitude => {
    const lat = latitude * Math.PI / 180;
    const lon = -122 * Math.PI / 180;
    const e2 = 1 - b * b / (a * a);
    const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    const height = 11000;
    const observer = new Vector3((n + height) * Math.cos(lat) * Math.cos(lon),
        (n + height) * Math.cos(lat) * Math.sin(lon), (n * (1 - e2) + height) * Math.sin(lat));
    const frame = horizonCompassFrame(observer, a, b);
    const metricDot = (v, w) => (v.x * w.x + v.y * w.y) / (a * a) + v.z * w.z / (b * b);
    for (let az = 0; az < 360; az += 15) {
        const d = frame.direction(az);
        const distance = -metricDot(observer, d) / metricDot(d, d);
        expect(distance).toBeGreaterThan(0);
        const tangent = observer.clone().addScaledVector(d, distance);
        expect(metricDot(tangent, tangent)).toBeCloseTo(1, 12);
        expect(metricDot(tangent, d)).toBeCloseTo(0, 12);
        const bearing = Math.atan2(d.dot(frame.east), d.dot(frame.north)) * 180 / Math.PI;
        expect((bearing - az + 540) % 360 - 180).toBeCloseTo(0, 10);
    }
});

test.each([[86.47, 14], [86.47, 32], [120, 32]])("dragging at FOV %s and text size %s keeps ten-degree labels stable", (fov, textSize) => {
    const frame = horizonCompassFrame(new Vector3(a + 10, 0, 0), a, b);
    const rect = {x: 0, y: 0, w: 1670, h: 871};
    const camera = new PerspectiveCamera(fov, rect.w / rect.h, 0.1, 1000);
    camera.up.copy(frame.up);
    const pixelsPerDegree = camera.projectionMatrix.elements[5] * rect.h * Math.PI / 360;
    const cardinalBearings = {N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315};
    const snapshots = [];
    for (let heading = -25; heading <= 25; heading += 0.5) {
        camera.lookAt(frame.direction(heading));
        camera.updateMatrixWorld(true);
        const forward = camera.getWorldDirection(new Vector3());
        const project = direction => {
            if (direction.dot(forward) <= 0) return null;
            const p = direction.clone().multiplyScalar(100).project(camera);
            return {x: (p.x + 1) * rect.w / 2, y: (1 - p.y) * rect.h / 2};
        };
        const labels = new Set();
        const ctx = {
            globalAlpha: 1, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
            moveTo() {}, lineTo() {}, stroke() {}, translate() {}, rotate() {},
            fillText(text) { labels.add(text); },
        };
        drawHorizonCompassRibbon(ctx, frame, project, rect, {textSize, pixelsPerDegree});
        // Store positions now: the camera will turn again for the next sample.
        const positions = new Map();
        for (let az = 0; az < 360; az++) positions.set(az, project(frame.direction(az)));
        snapshots.push({labels, positions});
    }
    const seen = new Set(snapshots.flatMap(s => [...s.labels]));
    expect(seen.size).toBeGreaterThan(4);
    for (const label of ["10°", "20°", "30°", "40°", "50°"]) expect(seen.has(label)).toBe(true);
    expect(seen.has("N")).toBe(true);
    expect(seen.has("0°")).toBe(true);
    for (const label of seen) {
        const bearing = cardinalBearings[label] ?? Number.parseFloat(label);
        for (const {labels, positions} of snapshots) {
            const p = positions.get(bearing);
            if (p && p.x > 60 && p.x < rect.w - 60 && p.y > 60 && p.y < rect.h - 60) {
                expect({label, visible: labels.has(label)}).toEqual({label, visible: true});
            }
        }
    }
});

test("a sloped horizon keeps compass text upright and ticks vertical", () => {
    const frame = horizonCompassFrame(new Vector3(a + 1700, 0, 0), a, b);
    const rect = {x: 0, y: 0, w: 1600, h: 900};
    const ctx = {
        globalAlpha: 1, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, stroke() {},
        moveTo: jest.fn(), lineTo: jest.fn(), translate: jest.fn(), rotate: jest.fn(), fillText: jest.fn(),
    };
    const project = d => ({x: 800 + 600 * d.y, y: 450 + 200 * d.y + 100 * d.z});
    drawHorizonCompassRibbon(ctx, frame, project, rect, {pixelsPerDegree: 5});
    expect(ctx.rotate).not.toHaveBeenCalled();
    expect(ctx.fillText).toHaveBeenCalledWith("N", 0, expect.any(Number));
    for (const bearing of [0, 90, 180, 270]) {
        expect(ctx.fillText).toHaveBeenCalledWith(`${bearing}°`, 0, expect.any(Number));
    }
    // The first 360 segments draw the horizon; every subsequent segment is a tick.
    const ticks = ctx.lineTo.mock.calls.slice(360);
    expect(ticks.length).toBeGreaterThan(30);
    expect(ticks.every(([x, y]) => x === 0 && y < 0)).toBe(true);
});

test.each([[true, true], [true, false], [false, true], [false, false]])(
    "cardinal=%s and degree=%s switches are independent and retain the ruler", (showCardinals, showDegrees) => {
        const frame = horizonCompassFrame(new Vector3(a, 0, 0), a, b);
        const ctx = {
            globalAlpha: 1, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, translate() {},
            moveTo() {}, lineTo: jest.fn(), stroke: jest.fn(), fillText: jest.fn(),
        };
        drawHorizonCompassRibbon(ctx, frame, d => ({x: 800 + 600 * d.y, y: 450 + 100 * d.z}),
            {x: 0, y: 0, w: 1600, h: 900}, {pixelsPerDegree: 5, showCardinals, showDegrees});
        const texts = ctx.fillText.mock.calls.map(([text]) => text);
        expect(texts.includes("N")).toBe(showCardinals);
        expect(texts.includes("0°")).toBe(showDegrees);
        if (!showCardinals) expect(texts.every(text => text.endsWith("°"))).toBe(true);
        if (!showDegrees) expect(texts.every(text => !text.endsWith("°"))).toBe(true);
        expect(ctx.lineTo.mock.calls.length).toBeGreaterThan(390);
    });
