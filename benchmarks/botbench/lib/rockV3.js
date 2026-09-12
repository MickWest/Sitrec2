// rockV3.js — the rock_v3 dataset: a FIXED set of 300 tracks, each written at
// seven clip lengths and nine pointing-error rungs, in the BOT interchange
// layout. "Fixed" means the 300 tracks are defined once (this file, one seed)
// and every batch is the same 300 flights: a longer batch is the same flight
// observed for longer, and a higher rung is the same flight observed through a
// worse operator. Subsets are cut from this master set later; nothing here is
// chosen to make a subset easy.
//
//   results/rock_v3/
//     manifest.json                  the 300 track definitions + the layout
//     timing.json
//     batch_<D>sec/                  D in 20, 40, 60, 120, 180, 240, 300
//       <E>deg/                      E in 0.0 ... 2.0 (lib/botsetErrors.js)
//         Input/  Truth/  All/  meta/  manifest.json
//           balloon_001 ... balloon_100
//           drone_001 ... drone_100
//           weather_balloon_001 ... weather_balloon_100
//
// THE THREE CLASSES, 100 tracks each:
//   balloon           a party balloon of random buoyancy (a vertical rate from
//                     -1.5 to +3.5 m/s) in a random uniform wind (0 to 15 m/s)
//   drone             a small fixed-wing drone flying a racetrack, a circle or
//                     a square as a ground track at constant speed and height
//   weather_balloon   a random segment of a typical sounding-balloon release:
//                     the clip starts at a random height between 300 m and
//                     26 km, rising 4.2 to 6 m/s through a sheared, veering
//                     wind
//
// THE PLATFORM, the same for every class: level flight between 15,000 and
// 20,000 ft above the ground, at 95 to 120 m/s, on a standard holding pattern
// (1.5 minute legs, 25 degree bank, mostly right-hand), entered at a random
// point of the pattern. So a 20 s clip is straight, or a turn, or both, and a
// 300 s clip is close to a whole pattern. The target starts due north of the
// platform at a random horizontal range drawn per class (lib/platforms.js
// "racetrack" for the path; generateScenario.js for the frame convention).
//
// EVERY RANDOM NUMBER IS A FUNCTION OF (class, index) ALONE, drawn from one
// stream seeded by the track's name, so the spec of balloon_017 is identical
// in every batch and every rung except for durationSeconds and the observation
// section. The truth key (generateScenario.js) then differs between batches
// only by duration, and because the flights are deterministic (no gusts:
// every wind has variabilityPct 0) the 20 s truth is the first 20 s of the
// 300 s truth, row for row. tests/botbench/rockV3.test.js pins that.
//
// The draws below are design choices, recorded in results/rock_v3/manifest.json
// so a reader can see the distributions without this file.

import {DEFAULT_SITE} from "./generateScenario";
import {BOTSET_ERROR_LEVELS} from "./botsetErrors";
import {BALLOON_DIAMETER_M} from "./angularSize";
import {fnv1a32, makeStream} from "./rng";
import {racetrackSchedule} from "./platforms";
import {dronePatternGeometry} from "./rockTargets";

const G = 9.80665;
const DEG = Math.PI / 180;
const FT_M = 0.3048;

export const ROCK_V3 = {
    name: "rock_v3",
    dirName: "rock_v3",
    // Not 801-804: those seed the other families, and a shared seed would
    // correlate draws across sets that are meant to be independent.
    seed: 805,
    durations: [20, 40, 60, 120, 180, 240, 300],
    fps: 10,
    // One narrow tracking field for the whole set, widened only where a rung
    // needs it (botsetErrors.js). Not sized per scenario: a field sized from
    // the object's range would publish the range.
    fovFullDeg: 3.0,
    epochISO: "2026-06-15T20:00:00Z",   // daylight at the site
    perClass: 100,
    classes: [
        {key: "balloon", file: "balloon", family: "balloon"},
        {key: "drone", file: "drone", family: "drone"},
        {key: "weather_balloon", file: "weather_balloon", family: "balloon"},
    ],
    platform: {
        altitudeFt: [15000, 20000], speedMS: [95, 120], bankDeg: 25, legSeconds: 90,
        rightHandFraction: 0.7,
    },
    // Horizontal range at frame 0, metres, log-uniform per class.
    rangeM: {balloon: [1500, 25000], drone: [1000, 12000], weather_balloon: [4000, 40000]},
};

export const ROCK_V3_ERROR_LEVELS = BOTSET_ERROR_LEVELS;

export function rockBatchLabel(durationSeconds) {
    return `batch_${durationSeconds}sec`;
}

export function rockBasename(cls, index) {
    return `${cls.file}_${String(index).padStart(3, "0")}`;
}

export function rockClass(key) {
    const c = ROCK_V3.classes.find((x) => x.key === key);
    if (!c) throw new Error(`rockV3: unknown class "${key}"`);
    return c;
}

const round = (x, places) => {
    const k = 10 ** places;
    return Math.round(x * k) / k;
};

/**
 * Every random number for one track, from one stream seeded by its name. The
 * order of the draws is part of the definition: changing it changes the set.
 */
export function rockDraws(clsKey, index) {
    const cls = rockClass(clsKey);
    const s = makeStream(fnv1a32(`${ROCK_V3.name}|${cls.key}|${index}`));
    const uni = (a, b) => a + (b - a) * s.uniform();
    const logUni = (a, b) => Math.exp(uni(Math.log(a), Math.log(b)));

    // Platform first, the same recipe for every class.
    const P = ROCK_V3.platform;
    const altitudeFt = round(uni(...P.altitudeFt), 0);
    const speedMS = round(uni(...P.speedMS), 1);
    const headingDeg = round(uni(0, 360), 1);
    const turnDir = s.uniform() < P.rightHandFraction ? 1 : -1;
    const period = racetrackSchedule({speedMS, bankDeg: P.bankDeg, legSeconds: P.legSeconds}).period;
    const phaseSeconds = round(uni(0, period), 1);
    const platform = {kind: "racetrack", speedMS, altitudeAGL: round(altitudeFt * FT_M, 0),
        bankDeg: P.bankDeg, legSeconds: P.legSeconds, headingDeg, turnDir, phaseSeconds};
    const platformInfo = {altitudeFt, periodSeconds: round(period, 1)};

    const rangeM = round(logUni(...ROCK_V3.rangeM[cls.key]), 0);

    if (cls.key === "balloon") {
        const ascentRate = round(uni(-1.5, 3.5), 2);
        // A sinking balloon must start high enough to stay above ground for
        // the longest clip, with 50 m to spare.
        const sinkDropM = Math.max(0, -ascentRate) * Math.max(...ROCK_V3.durations) + 50;
        const startAGL = round(uni(150 + sinkDropM, 3000), 0);
        const windSpeed = round(uni(0, 15), 2);
        const windToDeg = round(uni(0, 360), 1);   // compass direction the air moves toward
        return {cls: cls.key, index, rangeM, platform, platformInfo,
            target: {kind: "party-rising", family: cls.family, diameterM: BALLOON_DIAMETER_M,
                parameters: {startAGL, ascentRate}},
            wind: {kind: "custom", u: round(windSpeed * Math.sin(windToDeg * DEG), 3),
                v: round(windSpeed * Math.cos(windToDeg * DEG), 3), variabilityPct: 0},
            info: {ascentRate, startAGL, windSpeed, windToDeg}};
    }

    if (cls.key === "drone") {
        const patterns = ["drone-racetrack", "drone-circle", "drone-square"];
        const pattern = patterns[Math.min(2, Math.floor(s.uniform() * 3))];
        const dSpeed = round(uni(15, 30), 1);
        const altitudeAGL = round(uni(80, 1200), 0);
        // Turn radius: no tighter than a 40 degree bank at this speed.
        const rMin = Math.max(70, (dSpeed * dSpeed) / (G * Math.tan(40 * DEG)));
        const radiusM = round(uni(rMin, 400), 0);
        const legDraw = round(uni(200, 1500), 0);
        // A square needs a side that holds two corner arcs and some straight.
        const legM = pattern === "drone-square" ? Math.max(legDraw, 2 * radiusM + 50) : legDraw;
        const dHeading = round(uni(0, 360), 1);
        const phaseFraction = round(uni(0, 1), 4);
        const dTurn = s.uniform() < 0.5 ? 1 : -1;
        const diameterM = round(uni(1.2, 2.5), 2);
        const geom = dronePatternGeometry(pattern, {speedMS: dSpeed, radiusM, legM});
        return {cls: cls.key, index, rangeM, platform, platformInfo,
            target: {kind: pattern, family: cls.family, diameterM,
                // BOTH altitude keys: the track reads altitudeAGL, and
                // generateScenario takes its wind reference from startAGL.
                parameters: {startAGL: altitudeAGL, altitudeAGL, speedMS: dSpeed, radiusM, legM,
                    headingDeg: dHeading, phaseFraction, turnDir: dTurn}},
            wind: {kind: "zero"},   // ground-referenced pattern: wind moves nothing
            info: {pattern, speedMS: dSpeed, altitudeAGL, radiusM, legM, headingDeg: dHeading,
                phaseFraction, turnDir: dTurn, periodSeconds: round(geom.periodSeconds, 1),
                bankDeg: round(geom.bankDeg, 1)}};
    }

    // weather_balloon
    const startAGL = round(uni(300, 26000), 0);
    const ascentRate = round(uni(4.2, 6.0), 2);
    const windSpeed = round(uni(4, 30), 2);
    const windToDeg = round(uni(0, 360), 1);
    const shearPerM = round(uni(-1e-4, 2e-4), 7);   // speed multiplier slope per metre of climb
    const veerDeg = round(uni(-30, 30), 1);         // direction change over the next 1500 m
    // Latex sounding balloon: about 1.8 m across at launch, growing as the
    // pressure falls, about 6 m at 26 km. Constant within a clip.
    const diameterM = round(1.8 * Math.exp(startAGL / 21000), 2);
    return {cls: cls.key, index, rangeM, platform, platformInfo,
        target: {kind: "weather-rising", family: cls.family, diameterM,
            parameters: {startAGL, ascentRate}},
        wind: {kind: "custom", u: round(windSpeed * Math.sin(windToDeg * DEG), 3),
            v: round(windSpeed * Math.cos(windToDeg * DEG), 3), variabilityPct: 0,
            shearPerM, kinkAltM: 0, veerDeg, veerSpanM: 1500},
        info: {ascentRate, startAGL, windSpeed, windToDeg, shearPerM, veerDeg}};
}

/** The spec for one track at one clip length and one rung. */
export function rockSpec(clsKey, index, durationSeconds, errorLevel) {
    const d = rockDraws(clsKey, index);
    const cls = rockClass(clsKey);
    // ONE operator wobble draw per (track, rung), shared by every clip length.
    // generateScenario seeds the observation stream from sharedSeedKey when
    // one is given (and from the scenario id, which includes the duration,
    // when not), and the wobble generator draws frame by frame, so the 20 s
    // clip's observed sightlines are the first 201 rows of the 300 s clip's.
    // The key sits inside spec.observation, outside the truth key, and it
    // carries the rung, so each rung still draws its own wobble.
    const observation = errorLevel.deg > 0
        ? {...errorLevel.observation(ROCK_V3.fovFullDeg),
            sharedSeedKey: `${ROCK_V3.name}|${rockBasename(cls, index)}|${errorLevel.label}`}
        : errorLevel.observation(ROCK_V3.fovFullDeg);
    return {
        draws: d,
        spec: {
            epochISO: ROCK_V3.epochISO,
            durationSeconds, fps: ROCK_V3.fps,
            initialHorizontalRangeM: d.rangeM,
            siteId: DEFAULT_SITE,
            platform: {...d.platform},
            target: {kind: d.target.kind, family: d.target.family, diameterM: d.target.diameterM,
                parameters: {...d.target.parameters}},
            wind: {...d.wind},
            observation,
        },
    };
}

/**
 * A short hash of everything that defines the set: the constants and all 300
 * track definitions. Every folder manifest row carries it, so a folder written
 * by an older definition is recognisable as stale, and the driver flags it
 * instead of letting the master manifest describe files it did not define.
 */
export function rockDefinitionHash() {
    const {classes, ...constants} = ROCK_V3;
    return fnv1a32(JSON.stringify({constants, classes, tracks: rockTrackTable()})).toString(16).padStart(8, "0");
}

/** The 300 track definitions, duration-free, for the master manifest. */
export function rockTrackTable() {
    const rows = [];
    for (const cls of ROCK_V3.classes) {
        for (let i = 1; i <= ROCK_V3.perClass; i++) {
            const d = rockDraws(cls.key, i);
            rows.push({basename: rockBasename(cls, i), class: cls.key, index: i,
                rangeM: d.rangeM, platform: {...d.platform, ...d.platformInfo},
                target: d.target, wind: d.wind, info: d.info});
        }
    }
    return rows;
}
