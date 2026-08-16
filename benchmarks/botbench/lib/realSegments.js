// realSegments.js — target truth derived from SEGMENTS OF REAL GPS TRACKS
// (benchmarks/botbench/real-tracks/*.csv: time,lat,lon,alt_m). First pass of
// the real-track arm: real MOTION under controlled synthetic observation.
//
// Frame: the segment is re-sited into the scenario ENU — origin at the
// segment's first sample, z = startAGL + (alt - alt[0]) — so the SHAPE and
// the timing are real while the placement is declared. Horizontal conversion
// is a local flat approximation about the segment start (windows span km,
// where the curvature term is centimetres).
//
// Determinism and provenance: a window is selected by a DECLARED RULE
// (altitude crossing, burst, peak speed, or plain offset), never by hand-typed
// row numbers, and the loaded file's sha256 travels in the segment provenance
// so the spec commits to the exact bytes it was cut from. Amateur balloon
// tracks (1 point per 1-17 min) cannot support the 15-360 s windows used here
// and are deliberately not offered.
//
// generateScenario stays synchronous and fs-free: the BENCH loads segments
// with loadSegment() and registers them; the target dispatcher only reads the
// registry (targets.js, family "real"). The registry key embeds the file hash
// and the window, so a stale registration cannot satisfy a newer spec.

const R_EARTH = 6378137;
const DEG = Math.PI / 180;

// ---- CSV -------------------------------------------------------------------

function parseTrackCsv(text) {
    const lines = text.trim().split("\n");
    const t = [], lat = [], lon = [], alt = [];
    for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split(",");
        const ms = Date.parse(c[0]);
        const la = Number(c[1]), lo = Number(c[2]), al = Number(c[3]);
        // Reject unparseable rows and non-monotonic timestamps rather than
        // letting them poison the interpolation (audit F11).
        if (!Number.isFinite(ms) || !Number.isFinite(la)
            || !Number.isFinite(lo) || !Number.isFinite(al)) continue;
        if (t.length && ms / 1000 <= t[t.length - 1]) continue;
        t.push(ms / 1000);
        lat.push(la);
        lon.push(lo);
        alt.push(al);
    }
    return {t, lat, lon, alt, n: t.length};
}

// ---- despike ---------------------------------------------------------------
// The drone tracks carry single-sample position excursions up to ~200 m/s
// (estimator/GPS output; the source set's >200 m/s filter covered only the
// amateur tracks). In an anomaly benchmark a truth spike is a fake impulse,
// so excursions are removed by a declared, deterministic rule: a sample is a
// spike when the implied speed to BOTH neighbours exceeds twice the speed of
// the path that skips it (with a 2 m/s floor so hover jitter is not eaten).
// Up to three passes; the removed count travels in provenance.

function despike(track) {
    const FLOOR = 2;
    let removed = 0;
    for (let pass = 0; pass < 3; pass++) {
        const drop = new Set();
        for (let i = 1; i < track.n - 1; i++) {
            const dtP = track.t[i] - track.t[i - 1];
            const dtN = track.t[i + 1] - track.t[i];
            const dtS = track.t[i + 1] - track.t[i - 1];
            if (dtP <= 0 || dtN <= 0 || dtS <= 0) continue;
            const c = Math.cos(track.lat[i] * DEG);
            const d = (a, b) => Math.hypot(
                (track.lon[b] - track.lon[a]) * DEG * R_EARTH * c,
                (track.lat[b] - track.lat[a]) * DEG * R_EARTH);
            const vP = d(i - 1, i) / dtP;
            const vN = d(i, i + 1) / dtN;
            const vSkip = Math.max(d(i - 1, i + 1) / dtS, FLOOR);
            // Speed test alone could delete a real sharply-sampled hairpin;
            // require the point to also sit well off its neighbours' midpoint
            // (audit F6).
            const c2 = Math.cos(track.lat[i] * DEG);
            const devE = (track.lon[i] - (track.lon[i - 1] + track.lon[i + 1]) / 2) * DEG * R_EARTH * c2;
            const devN = (track.lat[i] - (track.lat[i - 1] + track.lat[i + 1]) / 2) * DEG * R_EARTH;
            if (Math.min(vP, vN) > 2 * vSkip && Math.hypot(devE, devN) > 10) drop.add(i);
        }
        if (!drop.size) break;
        removed += drop.size;
        for (const key of ["t", "lat", "lon", "alt"]) {
            track[key] = track[key].filter((_, i) => !drop.has(i));
        }
        track.n = track.t.length;
    }
    return removed;
}

// The second artifact class is a position STEP across a telemetry gap: the
// track jumps tens of metres in one (often lengthened) interval and continues
// smoothly from the new place — an estimator datum shift, not motion (the
// fixed-wing circuits log has eight of them). A step cannot be despiked; it
// is BRIDGED: when the implied speed across one interval exceeds the declared
// per-file cap (cleanMaxSpeedMS — set above the file's real dynamics), the
// step displacement is subtracted from every later sample. Altitude bridges
// with it (same event). Count travels in provenance.

function bridgeSteps(track, cleanMaxSpeedMS, cleanMaxVSpeedMS) {
    let bridged = 0;
    let offE = 0, offN = 0, offA = 0;
    const outLat = new Array(track.n), outLon = new Array(track.n), outAlt = new Array(track.n);
    outLat[0] = track.lat[0]; outLon[0] = track.lon[0]; outAlt[0] = track.alt[0];
    for (let i = 1; i < track.n; i++) {
        const dt = track.t[i] - track.t[i - 1];
        const c = Math.cos(track.lat[i] * DEG);
        const dE = (track.lon[i] - track.lon[i - 1]) * DEG * R_EARTH * c;
        const dN = (track.lat[i] - track.lat[i - 1]) * DEG * R_EARTH;
        if (dt > 0 && Math.hypot(dE, dN) / dt > cleanMaxSpeedMS) {
            offE += dE;
            offN += dN;
            // Altitude bridges only on its own evidence: the horizontal
            // trigger says nothing about whether the climb was real (audit F5).
            const dA = track.alt[i] - track.alt[i - 1];
            if (Math.abs(dA) / dt > cleanMaxVSpeedMS) offA += dA;
            bridged++;
        }
        outLon[i] = track.lon[i] - offE / (DEG * R_EARTH * c);
        outLat[i] = track.lat[i] - offN / (DEG * R_EARTH);
        outAlt[i] = track.alt[i] - offA;
    }
    track.lat = outLat; track.lon = outLon; track.alt = outAlt;
    return bridged;
}

// ---- window rules ----------------------------------------------------------
// Each returns the window START in track-relative seconds. The rule + its
// arguments are recorded in provenance, so the window is reproducible from
// the file alone.

function relSeconds(track) {
    return track.t.map((s) => s - track.t[0]);
}

function startByOffset(track, {offsetSeconds}) {
    return offsetSeconds;
}

// First crossing of an altitude (metres, as reported by the source).
function startByAltitude(track, {altitudeM}) {
    for (let i = 1; i < track.n; i++) {
        if (track.alt[i - 1] < altitudeM && track.alt[i] >= altitudeM) {
            return track.t[i] - track.t[0];
        }
    }
    throw new Error(`realSegments: track never crosses ${altitudeM} m`);
}

// Centred on the altitude maximum (a radiosonde's burst).
function startByBurst(track, {beforeSeconds}) {
    let k = 0;
    for (let i = 1; i < track.n; i++) if (track.alt[i] > track.alt[k]) k = i;
    return Math.max(0, track.t[k] - track.t[0] - beforeSeconds);
}

// Start of the fastest horizontal run of the requested duration.
function startByPeakSpeed(track, {durationSeconds}) {
    const rel = relSeconds(track);
    const e = [], n_ = [];
    const lat0 = track.lat[0] * DEG;
    for (let i = 0; i < track.n; i++) {
        e.push((track.lon[i] - track.lon[0]) * DEG * R_EARTH * Math.cos(lat0));
        n_.push((track.lat[i] - track.lat[0]) * DEG * R_EARTH);
    }
    let best = 0, bestD = -1;
    for (let i = 0; i < track.n; i++) {
        let j = i;
        while (j < track.n && rel[j] - rel[i] < durationSeconds) j++;
        if (j >= track.n) break;
        // Normalize by the actual elapsed interval: irregular sampling makes
        // raw displacement compare unequal durations (audit F9).
        const v = Math.hypot(e[j] - e[i], n_[j] - n_[i]) / (rel[j] - rel[i]);
        if (v > bestD) { bestD = v; best = i; }
    }
    return rel[best];
}

const RULES = {
    "offset": startByOffset,
    "altitude": startByAltitude,
    "burst": startByBurst,
    "peak-speed": startByPeakSpeed,
};

// ---- loading ---------------------------------------------------------------

// Linear interpolation of the raw samples onto the scenario grid. Real tracks
// are irregular (radiosondes ~1.0-1.4 s, drones 0.03-0.5 s), so interpolation
// is unavoidable; sampling AT roughly the native rate keeps its artifacts
// below the declared pointing noise.
function sampleAt(track, rel, tSec, get) {
    let i = 1;
    while (i < track.n - 1 && rel[i] < tSec) i++;
    const a = i - 1, b = i;
    const span = rel[b] - rel[a] || 1;
    const f = Math.min(1, Math.max(0, (tSec - rel[a]) / span));
    return get(a) + (get(b) - get(a)) * f;
}

export function segmentKeyOf(seg) {
    // Every input that changes the loaded truth is in the key — including the
    // cleaning caps (audit F1: two caps on one window must not collide).
    return `${seg.provenance.sourceSha256}:${seg.provenance.rule}`
        + `:${JSON.stringify(seg.provenance.ruleArgs)}`
        + `:${seg.provenance.windowStartSeconds.toFixed(3)}`
        + `:${seg.provenance.durationSeconds}:${seg.provenance.fps}`
        + `:${seg.provenance.startAGL}`
        + `:${seg.provenance.cleanMaxSpeedMS}:${seg.provenance.cleanMaxVSpeedMS}`;
}

// Load one windowed, resampled segment. Node-only (bench side).
export function loadSegment({file, rule, ruleArgs = {}, durationSeconds, fps, startAGL,
                             cleanMaxSpeedMS = 100, cleanMaxVSpeedMS = 20}) {
    // eslint-disable-next-line global-require
    const fs = require("fs");
    // eslint-disable-next-line global-require
    const path = require("path");
    // eslint-disable-next-line global-require
    const crypto = require("crypto");
    const full = path.resolve(__dirname, "..", "real-tracks", file);
    const text = fs.readFileSync(full, "utf8");
    const sha = crypto.createHash("sha256").update(text).digest("hex");
    const track = parseTrackCsv(text);
    const despikedSamples = despike(track);
    const stepsBridged = bridgeSteps(track, cleanMaxSpeedMS, cleanMaxVSpeedMS);
    const rel = relSeconds(track);

    const ruleFn = RULES[rule];
    if (!ruleFn) throw new Error(`realSegments: unknown window rule "${rule}"`);
    const start = ruleFn(track, {...ruleArgs, durationSeconds});
    if (!Number.isFinite(start) || start < 0) {
        throw new Error(`realSegments: rule "${rule}" produced an invalid window start ${start}`);
    }
    const trackDur = rel[track.n - 1];
    if (start + durationSeconds > trackDur) {
        throw new Error(`realSegments: window ${start.toFixed(1)}+${durationSeconds}s `
            + `exceeds track duration ${trackDur.toFixed(1)}s (${file})`);
    }

    const n = Math.round(durationSeconds * fps) + 1;
    const lat0 = sampleAt(track, rel, start, (i) => track.lat[i]) * DEG;
    const lon0 = sampleAt(track, rel, start, (i) => track.lon[i]);
    const latS = sampleAt(track, rel, start, (i) => track.lat[i]);
    const alt0 = sampleAt(track, rel, start, (i) => track.alt[i]);
    const cosLat = Math.cos(lat0);

    const positionENU = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        const tSec = start + f / fps;
        const la = sampleAt(track, rel, tSec, (i) => track.lat[i]);
        const lo = sampleAt(track, rel, tSec, (i) => track.lon[i]);
        const al = sampleAt(track, rel, tSec, (i) => track.alt[i]);
        positionENU[f * 3] = (lo - lon0) * DEG * R_EARTH * cosLat;
        positionENU[f * 3 + 1] = (la - latS) * DEG * R_EARTH;
        positionENU[f * 3 + 2] = startAGL + (al - alt0);
    }

    // Native sampling stats over the window, for the record.
    let k0 = 0, k1 = track.n - 1;
    while (k0 < track.n && rel[k0] < start) k0++;
    while (k1 > 0 && rel[k1] > start + durationSeconds) k1--;
    const nativeDt = k1 > k0 ? (rel[k1] - rel[k0]) / (k1 - k0) : NaN;

    const seg = {
        positionENU, n, fps,
        provenance: {
            sourceFile: file, sourceSha256: sha,
            rule, ruleArgs, windowStartSeconds: start,
            durationSeconds, fps, startAGL,
            nativeMeanDtSeconds: Number(nativeDt.toFixed(3)),
            nativeSamplesInWindow: Math.max(0, k1 - k0 + 1),
            despikedSamples, stepsBridged, cleanMaxSpeedMS, cleanMaxVSpeedMS,
        },
    };
    return seg;
}

// ---- registry (bench -> generator hand-off) --------------------------------

const registry = new Map();

export function registerSegment(seg) {
    const key = segmentKeyOf(seg);
    registry.set(key, seg);
    return key;
}

export function getRegisteredSegment(key) {
    const seg = registry.get(key);
    if (!seg) {
        throw new Error("realSegments: segment not registered — the bench must "
            + "loadSegment()+registerSegment() before generateScenario "
            + `(missing key ${key})`);
    }
    return seg;
}

// ---- truth (generator side, registry only) ---------------------------------

// spec.target = {kind: "real-segment", family: "real", parameters: {
//   segmentKey, label, anomalous, paired?, impulse?: {onsetSeconds, deltaVENU}}}
//
// The optional impulse SPLICE adds a constant delta-v to the real motion from
// onset onward: pos'(t) = pos(t) + dv * (t - onset). Real texture everywhere,
// synthetic event only — the anomaly/control pair differs by nothing else,
// which is the seam-free pairing the real-track arm is for.
export function generateRealSegmentTruth(targetSpec, {n, fps}) {
    const p = targetSpec.parameters ?? {};
    const seg = getRegisteredSegment(p.segmentKey);
    if (seg.n !== n || seg.fps !== fps) {
        throw new Error(`realSegments: registered segment is ${seg.n}@${seg.fps}fps, `
            + `scenario wants ${n}@${fps}fps`);
    }
    let pos = seg.positionENU;
    const events = [];
    if (!p.impulse && p.pairOnsetSeconds != null) {
        // The control member of a pair carries the SAME event window as its
        // spliced twin (zero delta-v, anomalous:false), so event-local scoring
        // can compare the two windows (audit F4; same rule as ANOMALY-CONTROL).
        events.push({eventId: `${p.label ?? "real"}-impulse-control`, family: "impulse",
            anomalous: false, onsetSeconds: p.pairOnsetSeconds,
            endSeconds: p.pairOnsetSeconds + 1 / fps,
            directionENU: [0, 0, 0],
            parameters: {deltaVENU: [0, 0, 0], spliced: false}});
    }
    if (p.impulse) {
        const {onsetSeconds, deltaVENU} = p.impulse;
        pos = new Float64Array(pos);   // never mutate the registered copy
        for (let f = 0; f < n; f++) {
            const dt = f / fps - onsetSeconds;
            if (dt > 0) {
                pos[f * 3] += deltaVENU[0] * dt;
                pos[f * 3 + 1] += deltaVENU[1] * dt;
                pos[f * 3 + 2] += (deltaVENU[2] ?? 0) * dt;
            }
        }
        const m = Math.hypot(deltaVENU[0], deltaVENU[1], deltaVENU[2] ?? 0) || 1;
        events.push({eventId: `${p.label ?? "real"}-impulse`, family: "impulse",
            anomalous: p.anomalous === true,
            onsetSeconds, endSeconds: onsetSeconds + 1 / fps,
            directionENU: [deltaVENU[0] / m, deltaVENU[1] / m, (deltaVENU[2] ?? 0) / m],
            parameters: {deltaVENU, spliced: true}});
    }
    const valid = new Uint8Array(n).fill(1);
    return {
        target: {kind: "track", family: "real", positionENU: pos, valid,
            profile: {kind: "real-segment", label: p.label,
                anomalous: p.anomalous === true, provenance: seg.provenance}},
        events,
    };
}
