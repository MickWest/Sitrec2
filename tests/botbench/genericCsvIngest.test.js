/**
 * The generic track-CSV path: any Sitrec-loadable CSV with camera pointing
 * ingests through the SAME dispatch the live import uses (TrackCSV.js — the
 * single source of truth for CSV importing), so BOTBench and the app cannot
 * drift. Airdata is the boresight-pointing case: its importer builds the
 * platform frame as the pointing frame (drone heading + gimbal pitch) and
 * carries no sensor-relative angles by design. Position-only tracks and
 * unrecognised CSVs refuse with the reason.
 */
import {ingestGenericTrackCSV, ingestSRT, ingestSTANAGXML, srtHasPointing}
    from "../../src/analysis/BotBenchIngest";
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

// The "UNIC Time Stamp" client family (sanitized template: data/misb/misb2.csv):
// MISB1-detected, tag-name headers, the epoch stamp under a TYPO header
// ("UNIC Time Stamp", microseconds), a spreadsheet DAY-SERIAL date column
// ("UNIX Time Stamp date"), and truth columns (truth_lat/truth_long/truth_alt).
// Before the alias + date fallback, NEITHER time column mapped, every record
// imported with a null stamp, and the folder failed with the no-timeline error.
const FAMILY_HEADER = "DPTS,Security:,UNIX Time Stamp date,UNIC Time Stamp,"
    + "Platform Heading Angle,Platform Pitch Angle,Platform Roll Angle,"
    + "Sensor Latitude,Sensor Longitude,Sensor True Altitude,"
    + "Sensor Relative Azimuth Angle,Sensor Relative Elevation Angle,"
    + "truth_lat,truth_long,truth_alt";

function familyCSV({n = 30, unic = true, dateSerial = true} = {}) {
    const lines = [FAMILY_HEADER];
    for (let i = 0; i < n; i++) {
        lines.push([
            "", "",                                              // DPTS, Security:
            dateSerial ? String(45000 + (0.5 * i) / 86400) : "", // day serial, 0.5 s steps
            unic ? String(1700000000000000 + 500000 * i) : "",   // µs, 0.5 s steps
            90, 0, 0,
            (35 + i * 1e-5).toFixed(6), "-125.000000", 1000,
            10, -5,
            (35.01 + i * 1e-5).toFixed(6), "-124.990000", 800,
        ].join(","));
    }
    return lines.join("\n");
}

test("the UNIC Time Stamp family ingests: typo stamp header, truth columns", () => {
    const record = ingestGenericTrackCSV(familyCSV(), {label: "family.csv", geoid: false});
    expect(record.meta.sourceFormat).toBe("MISB1");
    const ds = record.dataset;
    expect(ds.n).toBe(30);
    expect(ds.fps).toBeGreaterThan(1.9);        // 0.5 s µs steps -> 2 Hz
    expect(ds.fps).toBeLessThan(2.1);
    expect(record.truth).not.toBeNull();
    expect(record.truth.usable).toBe(true);
    expect(record.truth.validCount).toBe(30);
    // truth_alt is unit-UNLABELED and the app's default reading is FEET
    // (CTrackFileMISB), so 800 in the column is ~244 m up in ENU — reading it
    // as meters put client truth 3.28x too high and scored fake vertical
    // error. Sensor sits at 1000 m HAE, so ENU z is truth-vs-ellipsoid here.
    expect(record.truth.track[2]).toBeGreaterThan(230);
    expect(record.truth.track[2]).toBeLessThan(250);
    expect(record.warnings.join("\n")).toContain("FEET");
});

test("truth starting mid-clip back-fills its opening frames, never scored", () => {
    // Truth only from row 10 on: frames 0-9 must HOLD frame 10's position
    // (zero would be the ENU origin, drawing a sweep in from kilometres away)
    // while tValid keeps them out of scoring.
    const lines = [FAMILY_HEADER];
    for (let i = 0; i < 30; i++) {
        const hasTruth = i >= 10;
        lines.push(["", "", "", String(1700000000000000 + 500000 * i), 90, 0, 0,
            (35 + i * 1e-5).toFixed(6), "-125.000000", 1000, 10, -5,
            hasTruth ? (35.01 + i * 1e-5).toFixed(6) : "",
            hasTruth ? "-124.990000" : "",
            hasTruth ? "800" : ""].join(","));
    }
    const record = ingestGenericTrackCSV(lines.join("\n"),
        {label: "sparse-truth.csv", geoid: false});
    const {track, valid, validCount} = record.truth;
    expect(validCount).toBe(20);
    expect(valid[0]).toBe(0);
    expect(track[0]).toBe(track[10 * 3]);
    expect(track[1]).toBe(track[10 * 3 + 1]);
    expect(track[2]).toBe(track[10 * 3 + 2]);
});

test("with no stamp column, the day-serial date column supplies the timeline", () => {
    const record = ingestGenericTrackCSV(familyCSV({unic: false}),
        {label: "family-dateonly.csv", geoid: false});
    const ds = record.dataset;
    expect(ds.fps).toBeGreaterThan(1.9);        // 0.5 s serial steps -> 2 Hz
    expect(ds.fps).toBeLessThan(2.1);
    // (45000 - 25569) days = 2023; the epoch must land there, not 1970.
    expect(new Date(record.clipStartMs).getUTCFullYear()).toBe(2023);
});

// FRAME-CENTER POINTING. A large family of MISB CSV exports carries no
// platform attitude and no gimbal angles at all — the pointing is the FRAME
// CENTER, the geodetic point the optical axis lands on. Sitrec imports these
// happily (CTrackFileMISB derives a "Center" track and the camera looks at
// it), so BOTBench must too: sensor -> frame center IS the boresight.
const CENTER_HEADER = ",TIME,PTS,UAS LS Version,PrecisionTimeStamp,UNIX Time Stamp,"
    + "Sensor True Altitude,Sensor Latitude,Sensor Longitude,"
    + "Sensor Horizontal Field of View,Sensor Vertical Field of View,"
    + "Frame Center Latitude,Frame Center Longitude,Frame Center Elevation,"
    + "truth_lat,truth_lon,truth_alt,truth_heading,truth_speed";

function centerPointingCSV({n = 30, center = true, elevation = true} = {}) {
    const lines = [CENTER_HEADER];
    for (let i = 0; i < n; i++) {
        const t = 1700000000000 + 100 * i;               // ms, 0.1 s steps
        lines.push([
            i, (0.1 * i).toFixed(1), 3000 * i, "16",
            new Date(t).toISOString(),
            String(t * 1000),                            // µs stamp
            3000,                                        // Sensor True Altitude
            (35 + i * 1e-5).toFixed(6), "-125.000000",
            4.5, 2.5,
            center ? (35.05 + i * 2e-5).toFixed(6) : "",
            center ? "-124.950000" : "",
            center && elevation ? "0" : "",
            (35.04 + i * 2e-5).toFixed(6), "-124.960000", 4000, 45, 120,
        ].join(","));
    }
    return lines.join("\n");
}

test("a frame-center-pointing MISB CSV ingests, sightlines aimed at the center", () => {
    const record = ingestGenericTrackCSV(centerPointingCSV(), {label: "fc.csv", geoid: false});
    expect(record.meta.sourceFormat).toBe("MISB1");
    const ds = record.dataset;
    expect(ds.n).toBe(30);
    expect(ds.fps).toBeGreaterThan(9);
    expect(ds.fps).toBeLessThan(11);
    for (const f of [0, 15, 29]) {
        const l = Math.hypot(ds.D[f * 3], ds.D[f * 3 + 1], ds.D[f * 3 + 2]);
        expect(l).toBeCloseTo(1, 6);
        // Center is NORTH-EAST of and BELOW the sensor: E>0, N>0, U<0 in ENU.
        expect(ds.D[f * 3]).toBeGreaterThan(0);
        expect(ds.D[f * 3 + 1]).toBeGreaterThan(0);
        expect(ds.D[f * 3 + 2]).toBeLessThan(0);
    }
    expect(record.warnings.join("\n")).toContain("FRAME CENTER");
});

// "UNHANDLED MISB DATA" exists to surface a tag nobody has mapped yet. This
// export fires it four times on columns that are all accounted for — the
// pandas row index (blank header), UAS LS Version (ST 0601 tag 65, just
// abbreviated), and TIME/PTS (looked at and deliberately not used as clocks) —
// which teaches the reader to ignore the one warning that matters.
test("a pandas-exported MISB CSV warns about no column it already accounts for", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
        ingestGenericTrackCSV(centerPointingCSV(), {label: "fc.csv", geoid: false});
        const unhandled = warn.mock.calls.map(String).filter((m) => m.includes("UNHANDLED"));
        expect(unhandled).toEqual([]);
    } finally {
        warn.mockRestore();
    }
});

test("UAS LS Version maps to ST 0601 tag 65 rather than falling through", () => {
    const {parseMISB1CSV} = require("../../src/MISBUtils");
    const {MISB} = require("../../src/MISBFields");
    const rows = require("../../src/utils/CSVParser").default.toArrays(centerPointingCSV(2));
    // Verbatim, not coerced: misbTagInfo does not mark tag 65 numeric, and the
    // column loop honours each tag's declared type. What matters here is that
    // the value reached its tag at all.
    expect(parseMISB1CSV(rows)[0][MISB.UASDatalinkLSVersionNumber]).toBe("16");
});

// A center with no height leaves the ELEVATION angle unknown, which is the
// one component a bearings-only analysis most needs measured. Refuse, and
// say which column is missing rather than blaming the clock.
test("frame-center rows with no center elevation refuse, naming the height", () => {
    expect(() => ingestGenericTrackCSV(centerPointingCSV({elevation: false}),
        {label: "fc-noelev.csv", geoid: false}))
        .toThrow(/frame center with no height/);
});

// The no-pointing refusal must NAME POINTING. Every row here has a good
// clock and a good position and nothing to aim, and the old code reported
// "this clip carries no timing" — sending the reader after the one column
// that was fine.
test("a CSV with position and time but no pointing refuses about pointing", () => {
    expect(() => ingestGenericTrackCSV(centerPointingCSV({center: false}),
        {label: "nopoint.csv", geoid: false}))
        .toThrow(/no camera pointing/);
});

test("a stamp column holding a relative clock refuses AND says what it saw", () => {
    // UnixTimeStamp holding 0, 0.5, 1.0... — a relative clock. No unit reading
    // lands in the 1980-2100 era, and the refusal must say the values were
    // PRESENT but unclassifiable, not imply the column was missing.
    const header = FAMILY_HEADER.replace("UNIC Time Stamp", "UnixTimeStamp");
    const lines = [header];
    for (let i = 0; i < 15; i++) {
        lines.push(["", "", "", String(0.5 * i), 90, 0, 0,
            (35 + i * 1e-5).toFixed(6), "-125.000000", 1000, 10, -5,
            "", "", ""].join(","));
    }
    expect(() => ingestGenericTrackCSV(lines.join("\n"), {label: "rel.csv", geoid: false}))
        .toThrow(/not recognizable as an epoch stamp/);
});

// ---------------------------------------------------------------------------
// The non-CSV track containers that also carry pointing.
// ---------------------------------------------------------------------------

const readFixture = (name) => require("fs").readFileSync(
    require("path").resolve(__dirname, "../../data/test/", name), "utf8");

// STANAG 4676 states the sightline as its two ENDS — the platform and ground
// positions of each track point — so BOTBench used to refuse it as
// "multi-role, cannot choose one" while the app loaded it happily. The ends
// are not competing candidates for "the sensor"; which is which is stated by
// the format, and pairing them per track point IS the sightline.
test("a STANAG 4676 CSV ingests, aiming from the platform down to the ground point", () => {
    const record = ingestGenericTrackCSV(readFixture("elevated_track.csv"),
        {label: "elevated_track.csv", geoid: false});
    expect(record.meta.sourceFormat).toBe("STANAG_CSV");
    const ds = record.dataset;
    expect(ds.n).toBeGreaterThanOrEqual(10);
    for (let f = 0; f < ds.n; f++) {
        expect(Math.hypot(ds.D[f * 3], ds.D[f * 3 + 1], ds.D[f * 3 + 2])).toBeCloseTo(1, 6);
        // Sensor ~3305 m HAE looking at ground ~1430 m: every sightline points DOWN.
        expect(ds.D[f * 3 + 2]).toBeLessThan(0);
    }
    // The third STANAG position (the producer's target estimate) lies ON this
    // same ray, so it is a solution, not an observation, and must not be
    // scored as truth.
    expect(record.truth).toBeNull();
    expect(record.warnings.join("\n")).toContain("not scored here as truth");
});

// (The XML flavour needs a DOMParser, so it lives in stanagXmlIngest.test.js,
// which runs under jsdom.)

// A DJI SRT sidecar. This real fixture carries position but NO gimbal or
// platform angles, so it is position-only and must refuse ABOUT POINTING —
// the same honest refusal a position-only CSV gets.
test("an SRT with no gimbal angles refuses about pointing, not about time", () => {
    expect(() => ingestSRT(readFixture("DJI_20231217152755_0007_D.SRT"),
        {label: "dji.srt", geoid: false})).toThrow(/no camera pointing/);
});

// The same format WITH attitude and gimbal angles. This also pins the SRT
// parser's value TYPE: it used to store every field as a string, which every
// consumer coerced in arithmetic and so nobody noticed — until a consumer
// type-checked with Number.isFinite and saw a whole file of unusable rows.
function gimbalSRT(n = 30) {
    const lines = [];
    for (let i = 0; i < n; i++) {
        const ms = String(i * 40).padStart(3, "0");
        lines.push(String(i + 1));
        lines.push(`00:00:0${Math.floor(i * 0.04)},${ms} --> 00:00:0${Math.floor(i * 0.04)},${ms}`);
        lines.push(`<font size="28">FrameCnt: ${i + 1}, DiffTime: 40ms`);
        lines.push(`2023-12-17 15:27:${String(55 + Math.floor(i * 0.04)).padStart(2, "0")}`
            + `.${ms}`);
        lines.push(`[latitude: ${(36.0657 + i * 1e-5).toFixed(6)}] `
            + `[longitude: -119.019380] [abs_alt: 500.000] `
            + `[heading: 90.0] [pitch: 0.0] [roll: 0.0] `
            + `[gHeading: 10.0] [gPitch: -30.0] [gRoll: 0.0]`);
        lines.push("");
    }
    return lines.join("\n");
}

// A folder walk queues by FILENAME, which is right for every other format
// here — but ".srt" names both drone telemetry and ordinary subtitles, and
// even a real DJI sidecar often logs position with no gimbal angles. Queuing
// those would put a guaranteed error row in every bulk run, which is the same
// noise the .xml exclusion exists to prevent, so this one extension is judged
// on content.
test("srtHasPointing separates a pointing SRT from a position-only one", () => {
    expect(srtHasPointing(readFixture("DJI_20231217152755_0007_D.SRT"))).toBe(false);
    expect(srtHasPointing(gimbalSRT())).toBe(true);
    expect(srtHasPointing("1\n00:00:00,000 --> 00:00:01,000\nHello.\n\n")).toBe(false);
    expect(srtHasPointing("")).toBe(false);
});

test("an SRT with gimbal angles ingests, and its MISB values are NUMBERS", () => {
    const {CTrackFileSRT} = require("../../src/TrackFiles/CTrackFileSRT");
    const {MISB} = require("../../src/MISBFields");
    const rows = new CTrackFileSRT(gimbalSRT()).toMISB(0);
    expect(typeof rows[0][MISB.SensorLatitude]).toBe("number");
    expect(typeof rows[0][MISB.SensorRelativeElevationAngle]).toBe("number");

    const record = ingestSRT(gimbalSRT(), {label: "gimbal.srt", geoid: false});
    expect(record.meta.sourceFormat).toBe("SRT");
    const ds = record.dataset;
    expect(ds.n).toBeGreaterThanOrEqual(10);
    for (let f = 0; f < ds.n; f++) {
        expect(Math.hypot(ds.D[f * 3], ds.D[f * 3 + 1], ds.D[f * 3 + 2])).toBeCloseTo(1, 6);
        expect(ds.D[f * 3 + 2]).toBeLessThan(0);        // gimbal pitched 30 deg down
    }
});
