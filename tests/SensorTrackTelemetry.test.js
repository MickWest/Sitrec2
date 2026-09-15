import {Vector3} from "three";
import {closingSpeedKnots, getTrackMISBRow, telemetryNumber, trackAirVelocity} from "../src/SensorTrackTelemetry";

test('reads frame-aligned metadata through a smoother and the selected switch', () => {
    const rows = [[10], [20]];
    const source = {v: f => ({misbRow: rows[f]})};
    const selection = {choice: "recorded", inputs: {recorded: source, other: {v: () => ({misbRow: [99]})}}};
    const smoother = {v: () => ({position: new Vector3()}), inputs: {source: selection}};
    expect(getTrackMISBRow(smoother, 1)).toBe(rows[1]);
    selection.choice = "other";
    expect(getTrackMISBRow(smoother, 1)).toEqual([99]);
});

test('absent metadata stays unknown, including zero-valued angles', () => {
    expect(getTrackMISBRow({v: () => ({position: new Vector3()})}, 0)).toBeNull();
    for (const value of [null, undefined, "", NaN, Infinity]) expect(telemetryNumber(value)).toBeNull();
    expect(telemetryNumber(0)).toBe(0);
    expect(telemetryNumber(-20)).toBe(-20);
});

test('closing speed includes vertical motion and both tracks, with correct endpoint differences', () => {
    const camera = {p: f => {
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(10);
        return new Vector3(0, 0, f);
    }};
    const target = {p: f => new Vector3(0, 0, 1000 - f * 2)};
    for (const frame of [0, 5, 10]) {
        expect(closingSpeedKnots(camera, target, frame, 11, 30)).toBeCloseTo(90 * 3600 / 1852);
        expect(closingSpeedKnots(camera, target, frame, 11, 15)).toBeCloseTo(45 * 3600 / 1852);
        expect(closingSpeedKnots(camera, target, frame, 11, 30, 2)).toBeCloseTo(45 * 3600 / 1852);
    }
});

test('receding is negative, stationary is zero, missing derivative is unknown', () => {
    const fixed = {p: () => new Vector3()};
    const away = {p: f => new Vector3(1000 + f, 0, 0)};
    expect(closingSpeedKnots(fixed, away, 5, 11, 30)).toBeLessThan(0);
    expect(closingSpeedKnots(fixed, fixed, 5, 11, 30)).toBe(0);
    expect(closingSpeedKnots(fixed, fixed, 0, 1, 30)).toBeNull();
    expect(closingSpeedKnots(fixed, null, 0, 11, 30)).toBeNull();
});

test('air velocity subtracts crosswind and vertical wind with the same simulation clock', () => {
    for (const [fps, simSpeed] of [[30, 1], [15, 1], [30, 2]]) {
        const dt = simSpeed / fps;
        const track = {p: f => new Vector3(180, 0, 10).multiplyScalar(f * dt)};
        const wind = {getValueFrame: () => new Vector3(20, 30, 4).multiplyScalar(dt)};
        for (const frame of [0, 5, 10]) {
            expect(trackAirVelocity(track, wind, frame, 11, fps, simSpeed).distanceTo(new Vector3(160, -30, 6)))
                .toBeLessThan(1e-10);
        }
        expect(trackAirVelocity(track, wind, 0, 1, fps, simSpeed)).toBeNull();
    }
});
