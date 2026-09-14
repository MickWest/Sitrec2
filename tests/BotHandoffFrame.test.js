/**
 * A handed-off BOT scenario is dated and placed by the receiving window from the
 * BOT defaults, because its sidecar travels as notes. The candidates written for
 * it must use that same frame, and the notes must say when the sidecar's own
 * epoch or origin was not the default.
 */
import {botHandoffFrame} from "../src/TraverseHandoff";
import {BOT_DEFAULT_EPOCH_ISO, BOT_DEFAULT_ORIGIN, botENUToLLA} from "../src/TrackFiles/CTrackFileBOT";

const defaultEpochMs = Date.parse(BOT_DEFAULT_EPOCH_ISO);
const site = {latDeg: BOT_DEFAULT_ORIGIN.latDeg, lonDeg: BOT_DEFAULT_ORIGIN.lonDeg,
    groundElevationMSL: BOT_DEFAULT_ORIGIN.groundElevationMSL};

test("a rock_v3 scenario: the sidecar's later epoch is replaced by the receiver's, and the notes say so", () => {
    const results = {botOrigin: site, clipStartMs: Date.parse("2026-06-15T20:00:00Z")};
    const frame = botHandoffFrame(results);
    expect(frame.startMs).toBe(defaultEpochMs);
    expect(frame.altitudeIsHAE).toBe(false);
    expect(frame.note).toContain("ignores its epoch 2026-06-15T20:00:00.000Z");
    expect(frame.note).toContain(`dated ${BOT_DEFAULT_EPOCH_ISO}`);
    expect(frame.note).not.toContain("origin");
    // The same conversion the scenario gets at the default site.
    expect(frame.toLLA(100, 200, 50)).toEqual(botENUToLLA(100, 200, 50, site));
});

test("a scenario at the default epoch and site needs no note", () => {
    const frame = botHandoffFrame({botOrigin: site, clipStartMs: defaultEpochMs});
    expect(frame.startMs).toBe(defaultEpochMs);
    expect(frame.note).toBeNull();
});

test("another site is converted at the receiver's site, and the note names both", () => {
    const declared = {latDeg: 41.0, lonDeg: -104.8, groundElevationMSL: 1860};
    const frame = botHandoffFrame({botOrigin: declared, clipStartMs: defaultEpochMs});
    expect(frame.toLLA(0, 0, 0)).toEqual(botENUToLLA(0, 0, 0, site));
    expect(frame.note).toContain("ignores its origin 41, -104.8, ground 1860 m");
    expect(frame.note).toContain(`placed at ${site.latDeg}, ${site.lonDeg}`);
});

test("no BOT origin means no frame: an FMV clip carries its own timestamps", () => {
    expect(botHandoffFrame({botOrigin: null, clipStartMs: defaultEpochMs})).toBeNull();
    expect(botHandoffFrame(null)).toBeNull();
});
