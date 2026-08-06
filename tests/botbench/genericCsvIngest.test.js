/**
 * The generic track-CSV path: any Sitrec-loadable CSV with camera pointing
 * ingests through the SAME dispatch the live import uses (TrackCSV.js — the
 * single source of truth for CSV importing), so BOTBench and the app cannot
 * drift. Airdata is the boresight-pointing case: its importer builds the
 * platform frame as the pointing frame (drone heading + gimbal pitch) and
 * carries no sensor-relative angles by design. Position-only tracks and
 * unrecognised CSVs refuse with the reason.
 */
import {ingestGenericTrackCSV} from "../../src/analysis/BotBenchIngest";
import {setSit} from "../../src/Globals";

const AIRDATA_HEADER = "time(millisecond),datetime(utc),latitude,longitude,"
    + "altitude_above_seaLevel(feet),compass_heading(degrees),pitch(degrees),"
    + "roll(degrees),gimbal_heading(degrees),gimbal_pitch(degrees),gimbal_roll(degrees)";

function airdataCSV(n = 30) {
    const lines = [AIRDATA_HEADER];
    for (let i = 0; i < n; i++) {
        lines.push([100 * i, "2024-05-01 18:00:00", (35 + i * 1e-5).toFixed(6),
            (-125 + i * 2e-5).toFixed(6), 400, 90, 0, 0, 90, -10, 0].join(","));
    }
    return lines.join("\n");
}

beforeAll(() => {
    setSit({name: "botbench", frames: 10000, fps: 10, simSpeed: 1, lat: 35, lon: -125});
});

test("an Airdata drone log ingests with boresight pointing and a 10 Hz ms clock", () => {
    const record = ingestGenericTrackCSV(airdataCSV(30), {label: "flight.csv", geoid: false});
    expect(record.meta.sourceFormat).toBe("Airdata");
    const ds = record.dataset;
    expect(ds.n).toBe(30);
    // time(millisecond) steps of 100 — the ms clock convention must yield
    // 10 Hz, not the 10 kHz a silent microsecond assumption would.
    expect(ds.fps).toBeGreaterThan(9);
    expect(ds.fps).toBeLessThan(11);
    // Sightlines exist and are unit vectors (built from the platform frame).
    for (const f of [0, 15, 29]) {
        const l = Math.hypot(ds.D[f * 3], ds.D[f * 3 + 1], ds.D[f * 3 + 2]);
        expect(l).toBeCloseTo(1, 6);
    }
    expect(record.warnings.join("\n")).toContain("BORESIGHT");
});

test("a position-only CSV refuses with the reason", () => {
    const text = "frame,latitude,longitude\n0,35.0,-125.0\n1,35.001,-125.0\n";
    expect(() => ingestGenericTrackCSV(text, {label: "pos.csv", geoid: false}))
        .toThrow(/position-only/);
});

test("an unrecognised CSV refuses naming what BOTBench needs", () => {
    const text = "foo,bar\n1,2\n";
    expect(() => ingestGenericTrackCSV(text, {label: "junk.csv", geoid: false}))
        .toThrow(/camera pointing/);
});

// Epoch stamps arrive as µs (KLV), ms, s, or a Date object depending on the
// producer — and the MISB CSV importer passes file values through VERBATIM,
// so the unit is a property of the file. A number is accepted only when
// exactly one unit reading lands in the 1980-2100 era — the windows are
// ~13x wide but the units 1000x apart, so they cannot overlap, and values
// between them (e.g. any 1971 stamp) REFUSE rather than misread 1000x
// (a static per-format "ms" label turned a real µs-stamped MISB fixture's
// 0.2 s cadence into 200 s; per-magnitude bands then misread 1971 µs as ms).
test("epochStampSeconds normalizes s/ms/us/Date and refuses out-of-era", () => {
    const {epochStampSeconds} = require("../../src/analysis/BotBenchIngest");
    const t = 1714586400;                       // 2024-05-01T18:00 UTC, seconds
    expect(epochStampSeconds(t)).toBe(t);
    expect(epochStampSeconds(t * 1e3)).toBe(t);
    expect(epochStampSeconds(t * 1e6)).toBe(t);
    expect(epochStampSeconds(new Date(t * 1e3))).toBe(t);
    const y1971 = Date.UTC(1971, 5, 1);         // pre-era: refuse in EVERY unit
    expect(epochStampSeconds(y1971 / 1e3)).toBeNaN();   // seconds
    expect(epochStampSeconds(y1971)).toBeNaN();         // milliseconds
    expect(epochStampSeconds(y1971 * 1e3)).toBeNaN();   // microseconds
    expect(epochStampSeconds(12345)).toBeNaN();     // not an epoch stamp
    expect(epochStampSeconds(null)).toBeNaN();
    expect(epochStampSeconds(undefined)).toBeNaN();
});

// The Codex-round-1 BLOCK case, pinned: this real MISB_FULL fixture stamps
// UnixTimeStamp in MICROSECONDS (1348087826484970, 2012) at ~0.2 s steps.
// A static "CSV importers write ms" rule divided by 1e3 and ingested it at
// 0.005 Hz; per-value normalization must recover the true ~5 Hz.
test("a real µs-stamped MISB_FULL CSV ingests at its ~5 Hz cadence", () => {
    const path = require("path");
    const fs = require("fs");
    const text = fs.readFileSync(
        path.resolve(__dirname, "../../data/test/MISB-DATATrackData_N97826.csv"), "utf8");
    const record = ingestGenericTrackCSV(text, {label: "N97826.csv", geoid: false});
    expect(record.meta.sourceFormat).toBe("MISB_FULL");
    const ds = record.dataset;
    expect(ds.n).toBeGreaterThan(600);
    expect(ds.fps).toBeGreaterThan(4);
    expect(ds.fps).toBeLessThan(6);
    // 711 rows at 5 Hz is ~142 s of flight, not ~39 hours.
    const durationS = (ds.n - 1) / ds.fps;
    expect(durationS).toBeGreaterThan(100);
    expect(durationS).toBeLessThan(200);
});
