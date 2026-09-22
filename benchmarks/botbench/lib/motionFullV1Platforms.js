// Broad same-direction bends for full and single motion sets, plus two straight
// controls. Exact arcs retain their physical timing across all crop lengths.
import {MOTION_V1_PLATFORMS} from "./motionV1Platforms";
import {makeStream} from "./rng";

const MASTER_SECONDS = 300;

function bentPath(id, index, angles) {
    const pathSeed = 90200 + index, rng = makeStream(pathSeed);
    const headingDeg = Math.round(rng.uniform() * 360);
    // Randomize each physical turn rate, not the requested total bend. Paired
    // turns keep enough time for straight legs within the default 120 s clip.
    const rates = angles.map(angle => {
        const min = angles.length > 1 ? 2 : Math.abs(angle) === 60 ? 1.2 : 1.4;
        return Math.round((min + (2.8 - min) * rng.uniform()) * 100) / 100;
    });
    const betweenSeconds = Math.round(6 + 6 * rng.uniform());
    const turnSeconds = angles.reduce((sum, angle, i) => sum + Math.abs(angle) / rates[i], 0);
    const middleSeconds = betweenSeconds * (angles.length - 1);
    const endSeconds = (120 - turnSeconds - middleSeconds) / 2;
    const directionSign = Math.sign(angles[0]);
    // Continue the geometry on either side of the central 120 seconds. Longer
    // crops reveal additional broad turns instead of more straight padding.
    const outerProgram = () => {
        const rate = Math.round((1 + 1.4 * rng.uniform()) * 100) / 100;
        const turning = 60 / rate;
        const straight = (MASTER_SECONDS - 120) / 2 - turning;
        const approach = straight * (0.3 + 0.4 * rng.uniform());
        return [{fraction: approach, turnRateDegS: 0},
            {fraction: turning, turnRateDegS: directionSign * rate},
            {fraction: straight - approach, turnRateDegS: 0}];
    };
    const before = outerProgram(), after = outerProgram();
    const segments = [...before, {fraction: endSeconds, turnRateDegS: 0}];
    for (const [i, angle] of angles.entries()) {
        if (i) segments.push({fraction: betweenSeconds, turnRateDegS: 0});
        segments.push({fraction: Math.abs(angle) / rates[i], turnRateDegS: Math.sign(angle) * rates[i]});
    }
    segments.push({fraction: endSeconds, turnRateDegS: 0});
    segments.push(...after);
    const direction = angles[0] < 0 ? "left" : "right";
    return {id, category: "curved", turnAnglesDeg: angles, turnRatesDegS: rates,
        description: angles.length === 1
            ? `Straight approach, ${Math.abs(angles[0])}-degree ${direction} turn at ${rates[0]} degrees/second, straight departure.`
            : `${Math.abs(angles[0])}-degree ${direction} turn at ${rates[0]} degrees/second, ${betweenSeconds} seconds straight, then ${Math.abs(angles[1])} degrees further ${direction} at ${rates[1]} degrees/second; straight approach and departure.`,
        spec: {kind: "turn-program", variant: id, category: "curved", speedMS: 70, headingDeg, pathSeed, segments}};
}

export const MOTION_FULL_V1_PLATFORMS = [
    MOTION_V1_PLATFORMS[0],
    MOTION_V1_PLATFORMS[1],
    bentPath("bend-60-left", 1, [-60]),
    bentPath("bend-60-right", 2, [60]),
    bentPath("bend-120-left", 3, [-120]),
    bentPath("bend-120-right", 4, [120]),
    bentPath("hairpin-60-120-left", 5, [-60, -120]),
    bentPath("hairpin-60-120-right", 6, [60, 120]),
    bentPath("hairpin-120-60-left", 7, [-120, -60]),
    bentPath("hairpin-120-60-right", 8, [120, 60]),
];

export function motionFullV1PlatformsMarkdown({population = false} = {}) {
    return "## Platform paths\n\n"
        + (population ? "Each class assigns 20 targets to straight controls and 80 to curved paths, with ten targets per program. " : "Each target uses two straight controls and eight curved paths. ")
        + "All turns within a curved path have the same direction; there are no reversing doglegs or full-circle variants. The table describes the central 120-second default: complete 60-degree or 120-degree turns, with straight approaches and departures. Paired turns have a seeded 6-to-12-second straight section between them and a total heading change of 180 degrees. Initial headings and individual turn rates are also seeded. All curved segments are slower than the standard rate of 3 degrees/second.\n\n"
        + "| Platform ID | Path |\n|---|---|\n"
        + MOTION_FULL_V1_PLATFORMS.map(p => `| ${p.id} | ${p.description} |`).join("\n")
        + "\n\nSpeed is 70 m/s and altitude is 7000 m above the local ground plane. Central turn rates are drawn from 1.2 to 2.8 degrees/second for 60-degree single bends, 1.4 to 2.8 for 120-degree single bends, and 2.0 to 2.8 for paired turns. These imply bank angles below 20 degrees. Each curved 300-second master adds a further 60-degree turn before and after the central 120-second window, at seeded rates from 1.0 to 2.4 degrees/second, with straight sections between turns. Total heading change over the entire master is at most 300 degrees, and no individual turn exceeds 120 degrees.\n\n"
        + "Every shorter clip is a centered subset of that same 300-second path. Positions, speeds, turn rates, and timestamps stay fixed; no path is redrawn or retimed for a shorter duration. Short clips can contain partial bends, and every curved variant includes a turn even in the shortest supported 20-second clip. Longer clips reveal the extra outer turns.\n\n";
}
