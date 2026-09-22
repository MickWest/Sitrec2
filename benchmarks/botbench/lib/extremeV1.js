import {makeStream} from "./rng";
import {extremeV1Duration} from "./extremeV1Targets";

export const EXTREME_V1_VERSION = "extreme-v1.2";
export const EXTREME_V1_MARGIN = 1.3;
const reviewed = "2026-09-21";

// A reviewable source snapshot, not a claim of exhaustive worldwide records.
// Each class combines independent references; no single vehicle demonstrated
// this combination. Reported claims and model assumptions remain explicit.
const reference = (value, unit, status, title, url, note) => ({value, unit, status, title, url, note, reviewed});
const propellerSpeed = reference(730, "km/h", "reported-claim",
    "Drone Pro Hub: The Fastest Drone Ever Flown (And It Almost Didn't Survive)",
    "https://www.youtube.com/watch?v=k9n1h0rn9No",
    "Blackbird single downwind telemetry peak; not a certified two-way average. The zero-wind benchmark applies this ground-speed number as a speed magnitude in any direction, including vertical flight. That is an extrapolation, not a measured vertical record.");
const propellerAcceleration = reference(12.58, "g", "measured-flight",
    "Reaching the Limit in Autonomous Racing: Optimal Control versus Reinforcement Learning",
    "https://arxiv.org/html/2310.10943v2",
    "Reported maximum flight acceleration, used as inertial acceleration magnitude. Speed and agility references come from different quadcopters.");
const jetSpeed = reference(2211, "mph", "published-specification",
    "The Museum of Flight: Lockheed D-21B Drone",
    "https://www.museumofflight.org/exhibits-and-events/aircraft/lockheed-d-21b-drone",
    "Published maximum speed of a ramjet reconnaissance drone. The jet class includes turbojet and ramjet drones; hypersonic vehicles are in the fourth class.");
const jetLoad = reference(20, "g", "manufacturer-design-limit",
    "ENATA EFT-J Series specification, V-2022-04, page 2",
    "https://www.frankturbine.com/assets/Enata-Specification-Sheet.pdf",
    "Advertised maneuverability of +/-20 g, interpreted as a specific-force limit. Verified in the indexed manufacturer brochure; the direct PDF URL was unavailable at review. Not a measured D-21 maneuver.");
const aircraftSpeed = reference(3529.56, "km/h", "certified-record",
    "FAI: 50 years of the Lockheed Blackbird records",
    "https://www.fai.org/news/50-years-lockheed-blackbird-records",
    "SR-71 official speed record, not an instantaneous telemetry peak. Fast-aircraft here means conventional air-breathing fixed-wing aircraft, excluding rocket planes and hypersonic research vehicles.");
const aircraftLoad = reference(12, "g", "published-design-limit",
    "Smithsonian National Air and Space Museum: Sukhoi Su-26M",
    "https://airandspace.si.edu/collection-objects/sukhoi-su-26m/nasm_A20040001000",
    "Published positive design load, used as specific-force magnitude. This is an aerobatic airframe reference, not a claim that the SR-71 can maneuver at 12 g. The smaller negative design limit is not used as the positive peak.");
const hypersonicSpeed = reference(27, "Mach", "reported-claim",
    "Yury Borisov interview, Rossiya 24, 28 December 2018",
    "https://xn--2013-93d6b8abf3a0n.xn--p1ai/news/intervyu-yuriya-borisova-telekanalu-rossiya-24-2/",
    "Public Avangard speed claim, not independently verified. For a reproducible synthetic velocity, Mach is converted using a fixed reference temperature of 226.65 K, gamma=1.4 and R=287.05287 J/(kg K); this is not a recovered flight condition.");
const hypersonicAcceleration = reference(40, "g", "simulation-assumption",
    "He et al. (2022): Predictive Differential Game Guidance Approach for Hypersonic Target Interception Based on CQPSO",
    "https://onlinelibrary.wiley.com/doi/10.1155/2022/6050640",
    "Largest target-maneuver case in this simulation study, interpreted as inertial turning acceleration. No reliable measured class peak was established. This provisional reference is not a published flight record.");

function envelope(speed, g, conversionToMS, accelerationMetric) {
    return {margin: EXTREME_V1_MARGIN, speedReference: speed, accelerationReference: g,
        referenceSpeedMS: speed.value * conversionToMS,
        speedLimitMS: speed.value * conversionToMS * EXTREME_V1_MARGIN,
        accelerationMetric, accelerationLimitG: g.value * EXTREME_V1_MARGIN,
        classification: "Synthetic class composite, 30% above selected published references; not a validated vehicle envelope."};
}

export const EXTREME_V1_ENVELOPES = {
    "propeller-drone": envelope(propellerSpeed, propellerAcceleration, 1 / 3.6, "inertial"),
    "jet-drone": envelope(jetSpeed, jetLoad, 0.44704, "specific-force"),
    "fast-aircraft": envelope(aircraftSpeed, aircraftLoad, 1 / 3.6, "specific-force"),
    "hypersonic": envelope(hypersonicSpeed, hypersonicAcceleration,
        Math.sqrt(1.4 * 287.05287 * 226.65), "inertial"),
};

function variant(extremeClass, motion, description, extra = {}, suffix = motion) {
    const e = EXTREME_V1_ENVELOPES[extremeClass];
    const vertical = ["climb", "dive", "weave-3d"].includes(motion);
    const accelerationG = e.accelerationMetric === "inertial" ? e.accelerationLimitG
        : vertical ? e.accelerationLimitG - 1 : Math.sqrt(e.accelerationLimitG ** 2 - 1);
    const parameters = {extremeClass, motion, envelope: e, speedMS: e.speedLimitMS, accelerationG,
        startAGL: extremeClass === "propeller-drone" ? 3000 : extremeClass === "hypersonic" ? 50000 : 20000,
        ...extra};
    return {kind: `${extremeClass}-${suffix}`, description, parameters,
        durationSeconds: extremeV1Duration(parameters),
        diameterM: extremeClass === "propeller-drone" ? 0.5 : extremeClass === "jet-drone" ? 5 : 10,
        rangeM: extremeClass === "propeller-drone" ? 5000 : 20000,
        sensorAGL: extremeClass === "propeller-drone" ? 1000 : 7000};
}

function randomDirections(seed, count) {
    const rng = makeStream(seed);
    return Array.from({length: count}, () => {
        const az = rng.uniform() * 2 * Math.PI, z = rng.uniform() * 1.4 - 0.7;
        return [Math.sqrt(1 - z * z) * Math.cos(az), Math.sqrt(1 - z * z) * Math.sin(az), z];
    });
}

function fixedWingVariants(category, seed) {
    const rng = makeStream(seed);
    const angleStages = [];
    let heading = 0;
    for (let i = 0; i < 3; i++) {
        heading += (i % 2 ? -1 : 1) * (25 + 40 * rng.uniform());
        angleStages.push({headingDeg: heading, phase: `weave-heading-${i + 1}`, hold: 0.2});
        angleStages.push({pitchDeg: (i % 2 ? -1 : 1) * (8 + 12 * rng.uniform()),
            phase: `weave-pitch-${i + 1}`, hold: 0.2});
    }
    angleStages.push({pitchDeg: 0, phase: "level-out"});
    return [
        variant(category, "climb", "Rapid pull-up, 45-degree climb, and level-out at the speed limit.", {pitchDeg: 45}),
        variant(category, "dive", "Rapid push-over, 45-degree descent, and recovery at the speed limit.", {pitchDeg: 45}),
        variant(category, "weave-3d", "Seeded irregular heading and pitch changes at the speed limit and near the load limit.", {pathSeed: seed, angleStages}),
        variant(category, "turn-90", "Maximum-speed 90-degree level turn reaching the specific-force limit."),
        variant(category, "brake-turn-reverse", "Maximum braking to 20% speed, 180-degree turn, and acceleration to maximum speed on the reciprocal heading.", {minimumSpeedFraction: 0.2}),
    ];
}

export const EXTREME_V1_VARIANTS = [
    variant("propeller-drone", "ascent", "Rapid vertical ascent to the class speed limit, then stop; no horizontal travel."),
    variant("propeller-drone", "descent", "Rapid vertical descent to the class speed limit, then stop; no horizontal travel."),
    variant("propeller-drone", "up-down-up", "Rapid ascent, descent, and ascent in place, reaching the speed and acceleration limits on each leg."),
    variant("propeller-drone", "random-3d", "Six seeded irregular high-g velocity changes in three dimensions.",
        {pathSeed: 90111, directions: randomDirections(90111, 6)}),
    variant("propeller-drone", "turn-90", "Maximum-speed 90-degree level turn reaching the inertial acceleration limit."),
    variant("propeller-drone", "stop-reverse", "Maximum speed to a complete stop, then accelerate along the same line in the opposite direction."),
    ...fixedWingVariants("jet-drone", 90112),
    ...fixedWingVariants("fast-aircraft", 90113),
    variant("hypersonic", "straight", "Hypersonic straight and level flight.", {straightSeconds: 8}, "straight-flat"),
    variant("hypersonic", "straight", "Hypersonic straight flight on a 5-degree descending path.", {straightSeconds: 8, initialPitchDeg: -5}, "straight-descending"),
    variant("hypersonic", "shallow-turn", "Hypersonic 10-degree level turn at the provisional acceleration limit.", {turnDeg: 10}, "turn-flat"),
    variant("hypersonic", "shallow-turn", "Hypersonic 10-degree heading change while descending at 5 degrees.", {turnDeg: 10, initialPitchDeg: -5}, "turn-descending"),
];

export function extremeV1ReferencesMarkdown() {
    return "## Reference limits\n\n"
        + "The speed and g limits below are exactly 1.30 times the selected reference values. These are the largest usable values found in this source review, not a proof of global maxima. Some sources publish records or design limits rather than instantaneous peaks. Each class combines independent vehicles and applies the resulting scalar limits across maneuver directions. In particular, the propeller-drone vertical speed is an extrapolation of a horizontal ground-speed claim. Claims are included and labeled.\n\n"
        + "| Class | Speed reference | Generated speed (m/s) | g reference | Generated g limit | g convention |\n|---|---:|---:|---:|---:|---|\n"
        + Object.entries(EXTREME_V1_ENVELOPES).map(([name, e]) => `| ${name} | ${e.speedReference.value} ${e.speedReference.unit} | ${e.speedLimitMS.toFixed(3)} | ${e.accelerationReference.value} | ${e.accelerationLimitG.toFixed(3)} | ${e.accelerationMetric} |`).join("\n")
        + "\n\nThe hypersonic turning limit is **provisional**: 40 g is a published simulation case, not an established flight peak. Mach 27 is a reported claim; its modeled value after the margin is Mach 35.1 at the stated reference temperature. Actual flight conditions are unknown. The measured acceleration and specific-force columns below are derived quantities; only the selected reference convention is scaled by 1.30. Gravity makes those two quantities differ. Straight-flight variants deliberately have no maneuver acceleration.\n\n"
        + Object.entries(EXTREME_V1_ENVELOPES).map(([name, e]) => `### ${name}\n\n`
            + [e.speedReference, e.accelerationReference].map(r => `- [${r.title}](${r.url}) — ${r.value} ${r.unit}; ${r.status}. ${r.note}`).join("\n")).join("\n\n")
        + `\n\nSources reviewed ${reviewed}. Fixed-wing reversals brake and turn while retaining forward motion. Vertical-plane turns use an inertial cap of (specific-force limit minus 1 g) to reserve gravity support; level turns reach the specified load using sqrt(load² - 1). Constant-speed turns assume propulsion can offset losses. Angle, hold-time, and minimum-speed choices define test geometry, not additional claimed performance records.\n\n`;
}
