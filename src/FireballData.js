// GMN summary columns are documented at https://globalmeteornetwork.org/data/media/GMN_orbit_data_columns.pdf
import {t} from "./i18n";

export const GMN_SOURCE = "https://globalmeteornetwork.org/data/traj_summary_data/";
const number = (value) => (value?.trim() && Number.isFinite(Number(value)) ? Number(value) : null);
export function parseGMNSummary(text, sourceURL = GMN_SOURCE) {
    const lines = text.split(/\r\n|\n\r|[\r\n]/);
    const generated = lines[0];
    const header = lines.find((l) => /^#\s*Unique trajectory;/.test(l));
    if (!header) throw new Error(t("fireballs.errors.notGMN"));
    const names = header
        .slice(1)
        .split(";")
        .map((s) => s.trim());
    const at = (name) => {
        const i = names.indexOf(name);
        if (i < 0) throw new Error(t("fireballs.errors.missingColumn", {column: name}));
        return i;
    };
    const idx = Object.fromEntries(
        ["Beginning", "LatBeg", "LonBeg", "HtBeg", "LatEnd", "LonEnd", "HtEnd", "Duration", "Peak", "Peak Ht"].map(
            (n) => [n, at(n)],
        ),
    );
    // "Beginning" occurs twice: Julian date, then UTC. Use the documented UTC column.
    if (names[2] !== "Beginning") throw new Error(t("fireballs.errors.utcLayout"));
    const events = [];
    let rejected = 0;
    for (const line of lines) {
        if (!line.trim() || line.startsWith("#")) continue;
        const row = line.split(";").map((s) => s.trim());
        try {
            const utc = row[2]?.replace(" ", "T") + "Z";
            const start = Date.parse(utc),
                duration = number(row[idx.Duration]);
            const samples = ["Beg", "End"].map((suffix, i) => ({
                time: new Date(start + (i ? duration * 1000 : 0)).toISOString(),
                lat: number(row[idx["Lat" + suffix]]),
                lon: number(row[idx["Lon" + suffix]]),
                altitude: number(row[idx["Ht" + suffix]]) * 1000,
            }));
            for (const suffix of ["Beg", "End"])
                if (number(row[idx["Ht" + suffix]]) === null) throw new Error("Missing height");
            if (!(duration > 0)) throw new Error("Missing duration");
            const event = {
                kind: "sitrec-fireball-v1",
                id: row[0],
                source: {
                    network: "Global Meteor Network",
                    url: sourceURL,
                    license: "CC BY 4.0",
                    importedUTC: new Date().toISOString(),
                    originalUTC: row[2],
                    rawRow: line,
                    generated,
                },
                altitudeReference: "WGS84 ellipsoid",
                pathMethod: "measured endpoints; constant-speed interpolation",
                samples,
                peakMagnitude: number(row[idx.Peak]),
                peakHeightM: number(row[idx["Peak Ht"]]) === null ? null : number(row[idx["Peak Ht"]]) * 1000,
                quality: {
                    stations: row[names.indexOf("Participating")],
                    stationCount: number(row[names.indexOf("Num")]),
                    convergenceDeg: number(row[names.indexOf("Qc")]),
                    medianFitArcsec: number(row[names.indexOf("MedianFitErr")]),
                    beginInFOV: row[names.indexOf("Beg in")],
                    endInFOV: row[names.indexOf("End in")],
                    endpointSigma: ["LatBeg", "LonBeg", "HtBeg", "LatEnd", "LonEnd", "HtEnd"].map((n) => ({
                        field: n,
                        sigma: number(row[idx[n] + 1]),
                    })),
                },
            };
            validateFireball(event);
            events.push(event);
        } catch {
            rejected++;
        }
    }
    return { events, rejected };
}
// The only hosts a fireball panel links to; each has an entry in scripts/egress-allowlist.json.
// A fireball file may name any source URL as provenance, so a source URL becomes a link only
// on GMN_HOST and is otherwise shown as text: a link to it would send a request to a host that
// only the file chose. The license host is for the panel's own fixed license link.
export const GMN_HOST = "globalmeteornetwork.org";
export const FIREBALL_LINK_HOSTS = [GMN_HOST, "creativecommons.org"];
function parseURL(url) {
    try {
        return new URL(url);
    } catch {
        return null;
    }
}
export function isFireballLinkURL(url, hosts = FIREBALL_LINK_HOSTS) {
    const parsed = parseURL(url);
    return parsed?.protocol === "https:" && hosts.includes(parsed.hostname);
}
function validSourceURL(url) {
    const parsed = parseURL(url);
    return parsed?.protocol === "https:" && !parsed.username && !parsed.password;
}
export function validateFireball(event) {
    if (
        event?.kind !== "sitrec-fireball-v1" ||
        !event.id ||
        !event.source?.network ||
        !validSourceURL(event.source?.url) ||
        !event.source?.license
    )
        throw new Error(t("fireballs.errors.provenance"));
    if (event.altitudeReference !== "WGS84 ellipsoid")
        throw new Error(t("fireballs.errors.altitudeReference"));
    if (
        !["measured time-tagged samples", "measured endpoints; constant-speed interpolation"].includes(event.pathMethod)
    )
        throw new Error(t("fireballs.errors.pathMethod"));
    if (!Array.isArray(event.samples) || event.samples.length < 2) throw new Error(t("fireballs.errors.twoSamples"));
    if (event.pathMethod.includes("endpoints") && event.samples.length !== 2)
        throw new Error(t("fireballs.errors.endpointSamples"));
    let previous = -Infinity;
    for (const p of event.samples) {
        const t = Date.parse(p.time);
        if (
            !/Z$/.test(p.time) ||
            !Number.isFinite(t) ||
            t <= previous ||
            !Number.isFinite(p.lat) ||
            Math.abs(p.lat) > 90 ||
            !Number.isFinite(p.lon) ||
            Math.abs(p.lon) > 180 ||
            !Number.isFinite(p.altitude) ||
            p.altitude < 0
        )
            throw new Error(t("fireballs.errors.invalidSample"));
        previous = t;
    }
    if (!Number.isFinite(event.peakMagnitude)) {
        const magnitudes = event.samples.map((p) => p.absoluteMagnitude).filter(Number.isFinite);
        if (magnitudes.length) event.peakMagnitude = magnitudes.reduce((a, b) => Math.min(a, b), Infinity);
    }
    if (
        event.recordedPeakUTC &&
        (!/Z$/.test(event.recordedPeakUTC) ||
            !Number.isFinite(Date.parse(event.recordedPeakUTC)) ||
            Date.parse(event.recordedPeakUTC) < Date.parse(event.samples[0].time) ||
            Date.parse(event.recordedPeakUTC) > previous)
    )
        throw new Error(t("fireballs.errors.recordedPeak"));
    return event;
}
// The peak time of a fireball, or null: {time, kind, label}. `kind` is "recorded", "brightest"
// or "estimated"; `label` is its user-visible description.
function peak(time, kind) {
    return { time, kind, label: t(`fireballs.peak.${kind}`) };
}
export function fireballPeak(event) {
    if (event.recordedPeakUTC) return peak(Date.parse(event.recordedPeakUTC), "recorded");
    if (event.pathMethod === "measured time-tagged samples") {
        const values = event.samples.filter((p) => Number.isFinite(p.absoluteMagnitude));
        if (values.length) {
            const p = values.reduce((a, b) => (b.absoluteMagnitude < a.absoluteMagnitude ? b : a));
            return peak(Date.parse(p.time), "brightest");
        }
    }
    const a = event.samples[0],
        b = event.samples.at(-1);
    const f = (a.altitude - event.peakHeightM) / (a.altitude - b.altitude);
    if (
        event.pathMethod.includes("endpoints") &&
        Number.isFinite(event.peakHeightM) &&
        Number.isFinite(f) &&
        f >= 0 &&
        f <= 1 &&
        a.altitude !== b.altitude
    )
        return peak(Date.parse(a.time) + f * (Date.parse(b.time) - Date.parse(a.time)), "estimated");
    return null;
}
export function nearbyFireballs(events, { utc, lat, lon, hours = 24, km = 1000, faintest = -3 }) {
    const distance = (p) => {
        const r = Math.PI / 180,
            dlat = (p.lat - lat) * r,
            dlon = (p.lon - lon) * r;
        return (
            6371 *
            2 *
            Math.asin(
                Math.sqrt(
                    Math.min(
                        1,
                        Math.sin(dlat / 2) ** 2 + Math.cos(lat * r) * Math.cos(p.lat * r) * Math.sin(dlon / 2) ** 2,
                    ),
                ),
            )
        );
    };
    return events
        .map((event) => ({
            event,
            distanceKm: event.samples.reduce((minimum, p) => Math.min(minimum, distance(p)), Infinity),
            deltaHours: Math.abs(Date.parse(event.samples[0].time) - utc) / 3600000,
        }))
        .filter(
            (x) =>
                x.deltaHours <= hours &&
                x.distanceKm <= km &&
                (!Number.isFinite(x.event.peakMagnitude) || x.event.peakMagnitude <= faintest),
        )
        .sort((a, b) => a.deltaHours - b.deltaHours || a.distanceKm - b.distanceKm);
}
