import fs from "fs";
import path from "path";
import { parseGMNSummary, fireballPeak, nearbyFireballs, validateFireball, isFireballLinkURL } from "../src/FireballData";
import { CTrackFileFireball } from "../src/TrackFiles/CTrackFileFireball";
import { MISB } from "../src/MISBFields";
const source = "https://globalmeteornetwork.org/data/traj_summary_data/traj_summary_yearly_2018.txt";
const text = fs.readFileSync(path.join(__dirname, "fixtures/fireballs/gmn-2018-extract.txt"), "utf8");
const { events } = parseGMNSummary(text, source);
test("real primary extract preserves provenance, UTC, metre ellipsoid heights and quality", () => {
    expect(events).toHaveLength(2);
    const e = events[0],
        track = new CTrackFileFireball(e),
        row = track.toMISB()[0];
    expect(e.source.rawRow).toContain(e.id);
    expect(e.source.url).toBe(source);
    expect(row[MISB.UnixTimeStamp]).toBe(Date.parse(e.source.originalUTC.replace(" ", "T") + "Z"));
    expect(row[MISB.SensorTrueAltitude]).toBe(e.samples[0].altitude);
    expect(track.isAltitudeHAE()).toBe(true);
    expect(e.quality.endpointSigma).toHaveLength(6);
});
test("summary peak is estimated from measured height and duration", () => {
    const e = events.find((e) => fireballPeak(e));
    const p = fireballPeak(e);
    expect(p.label).toMatch(/^Estimated/);
    expect(p.time).toBeGreaterThanOrEqual(Date.parse(e.samples[0].time));
    expect(fireballPeak({ ...e, peakHeightM: null })).toBeNull();
    expect(fireballPeak({ ...e, peakHeightM: 1e9 })).toBeNull();
    expect(fireballPeak({ ...e, samples: e.samples.map((p) => ({ ...p, altitude: 100 })) })).toBeNull();
});
test("recorded peak and brightest observed sample remain distinct from assumed timing", () => {
    const e = { ...events[0], pathMethod: "measured time-tagged samples" };
    expect(fireballPeak(e)).toBeNull();
    e.samples = e.samples.map((p, i) => ({ ...p, absoluteMagnitude: -i - 4 }));
    expect(fireballPeak(e).label).toMatch(/measured sample/);
    e.recordedPeakUTC = e.samples[0].time;
    expect(fireballPeak(e).label).toBe("Recorded peak UTC");
});
test("validation rejects ambiguous altitude, UTC and duplicate samples", () => {
    expect(() => validateFireball({ ...events[0], altitudeReference: "MSL" })).toThrow();
    expect(() => validateFireball({ ...events[0], samples: [events[0].samples[0], events[0].samples[0]] })).toThrow();
    expect(() => validateFireball({ ...events[0], recordedPeakUTC: "2030-01-01T00:00:00Z" })).toThrow();
    expect(() => parseGMNSummary("not GMN")).toThrow();
});
test.each(["http://globalmeteornetwork.org/data/x.txt", "https://user:pw@example.org/report", "not a url", "javascript:alert(1)", ""])(
    "validation refuses the source URL %p",
    (url) => {
        expect(() => validateFireball({ ...events[0], source: { ...events[0].source, url } })).toThrow(/HTTPS source URL/);
    },
);
test("validation accepts an HTTPS source URL on any host, as provenance", () => {
    expect(() => validateFireball({ ...events[0], source: { ...events[0].source, url: "https://example.org/report" } })).not.toThrow();
});
test("only HTTPS URLs on the reviewed hosts become links", () => {
    expect(isFireballLinkURL("https://globalmeteornetwork.org/data/traj_summary_data/")).toBe(true);
    expect(isFireballLinkURL("https://creativecommons.org/licenses/by/4.0/")).toBe(true);
    expect(isFireballLinkURL("https://example.org/report")).toBe(false);
    expect(isFireballLinkURL("https://globalmeteornetwork.org.example.org/")).toBe(false);
    expect(isFireballLinkURL("http://globalmeteornetwork.org/data/")).toBe(false);
    expect(isFireballLinkURL(undefined)).toBe(false);
});
test("search filters actual UTC, location and magnitude including brighter than minus nine", () => {
    const e = events[0],
        p = e.samples[0],
        opts = { utc: Date.parse(p.time), lat: p.lat, lon: p.lon, hours: 0, km: 1, faintest: -3 };
    expect(nearbyFireballs(events, opts)[0].event.id).toBe(e.id);
    expect(nearbyFireballs([{ ...e, peakMagnitude: -12 }], opts)).toHaveLength(1);
    expect(nearbyFireballs(events, { ...opts, utc: opts.utc + 86400000 })).toHaveLength(0);
    expect(nearbyFireballs([{ ...e, peakMagnitude: null }], opts)).toHaveLength(1);
});
test("malformed summary rows are counted, not silently accepted", () => {
    const parsed = parseGMNSummary(text + "bad;row\n", source);
    expect(parsed.rejected).toBe(1);
    expect(parsed.events).toHaveLength(2);
});
test("bright 13-station event uses actual UTC rather than daily filename date", () => {
    const data = fs.readFileSync(path.join(__dirname, "fixtures/fireballs/gmn-2025-extract.txt"), "utf8");
    const { events: records } = parseGMNSummary(
        data,
        "https://globalmeteornetwork.org/data/traj_summary_data/daily/traj_summary_20251226_solrange_275.0-276.0.txt",
    );
    expect(records[0].id).toBe("20251227031631_xiL2Z");
    expect(records[0].samples[0].time).toBe("2025-12-27T03:16:31.844Z");
    expect(records[0].quality.stationCount).toBe(13);
    expect(records[0].peakMagnitude).toBe(-7.45);
    expect(fireballPeak(records[0]).time).toBeCloseTo(Date.parse("2025-12-27T03:16:34.105Z"), 0);
});

test("published GMN LF-CR and CR line endings preserve records and provenance", () => {
    for (const newline of ["\n\r", "\r\n", "\r"]) {
        const result = parseGMNSummary(text.replace(/\r?\n/g, newline), source);
        expect(result.rejected).toBe(0);
        expect(result.events.map(e => e.id)).toEqual(events.map(e => e.id));
        expect(result.events[0].source.rawRow).toBe(events[0].source.rawRow);
    }
});
