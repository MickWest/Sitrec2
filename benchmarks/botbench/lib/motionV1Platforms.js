import {makeStream} from "./rng";

// Standard rate is 3 degrees/second:
// https://www.faasafety.gov/gslac/alc/libview_normal.aspx?id=7097
export const STANDARD_TURN_RATE_DEG_S = 3;
const segment = (fraction, turnRateDegS = 0) => ({fraction, turnRateDegS});
const program = (id, category, headingDeg, description, segments, pathSeed) => ({
    id, category, description,
    spec: {kind: "turn-program", variant: id, category, speedMS: 70, headingDeg, segments,
        ...(pathSeed === undefined ? {} : {pathSeed})},
});

function randomProgram(index) {
    const seed = 90120 + index, rng = makeStream(seed);
    const headingDeg = Math.round(rng.uniform() * 360);
    const turns = 2 + Math.floor(rng.uniform() * 2);
    const segments = [segment(0.5 + rng.uniform())];
    // Construct a mixture, rather than drawing a window from a long random
    // path: no duration can accidentally contain only its opening straight.
    for (let i = 0; i < turns; i++) {
        segments.push(segment(0.5 + rng.uniform(), rng.uniform() < 0.5 ? -3 : 3));
        segments.push(segment(0.5 + rng.uniform()));
    }
    return program(`random-${String(index).padStart(2, "0")}`, "random", headingDeg,
        "Seeded straight/turn mixture with two or three complete turn segments at standard rate.", segments, seed);
}

export const MOTION_V1_PLATFORMS = [
    program("cv-crossing", "constant-velocity", 90, "Constant velocity eastward, across the initial sightline.", [segment(1)]),
    program("cv-inbound", "constant-velocity", 0, "Constant velocity northward, toward the initial target ground point.", [segment(1)]),
    program("rate-left-crossing", "standard-rate", 90, "Continuous left standard-rate turn from an eastward heading.", [segment(1, -3)]),
    program("rate-right-crossing", "standard-rate", 90, "Continuous right standard-rate turn from an eastward heading.", [segment(1, 3)]),
    program("rate-right-inbound", "standard-rate", 0, "Continuous right standard-rate turn from a northward heading.", [segment(1, 3)]),
    program("s-turn", "s-turn", 90, "Straight, left turn, straight, matching right turn, straight; both turn lobes fit every clip.",
        [segment(0.1), segment(0.35, -3), segment(0.1), segment(0.35, 3), segment(0.1)]),
    ...[1, 2, 3, 4].map(randomProgram),
];

export function motionV1PlatformsMarkdown(setName, targetCount) {
    const altitudeDescription = setName === "Extreme_v1"
        ? "Platform altitude is 1000 m above site ground for propeller-drone cases and 7000 m for the other classes."
        : "Platform altitude is 7000 m above site ground, except for the vertical-drop cases, which use 11000 m.";
    return "## Platform variants\n\n"
        + `Each of the ${targetCount} target maneuvers has all 10 platform variants: ${targetCount * MOTION_V1_PLATFORMS.length} scenarios at 10 Hz. The target trajectory, duration, platform speed (70 m/s), and platform altitude for that target stay fixed across this comparison. ${altitudeDescription}\n\n`
        + "| Platform ID | Type | Description |\n|---|---|---|\n"
        + MOTION_V1_PLATFORMS.map(p => `| ${p.id} | ${p.category} | ${p.description} |`).join("\n")
        + "\n\n[Standard rate is 3 degrees/second](https://www.faasafety.gov/gslac/alc/libview_normal.aspx?id=7097). All turning segments use this magnitude. At 70 m/s the coordinated bank is about 20.5 degrees, within the generator's 30-degree limit. Shorter clips cover smaller heading changes at the same rate.\n\n"
        + "Segment times are fractions of the complete duration. Both S-turn lobes and every random straight/turn segment therefore occur within every clip. Each random pattern has two or three turns, with seeded durations, directions, and initial headings. This is a duration-scaled program, not a cropped window that might miss the turns. The exact segment windows, turn counts, rates, banks, and heading changes are recorded in the manifest and truth sidecars. Velocity is continuous through joins; the idealized bank changes are immediate.\n\n";
}
