// One turn of the beam's Cycle runs this 30-second score. The two banks
// share a clock, so a parked formation stays still even when seeking backward.
export const CONCERT_SECONDS = 30;
export const DEFAULT_CONCERT = Object.freeze({speed: 1, heading: 0, spacing: 18});
const TURN = 2 * Math.PI;

// Seconds from the start of the show, fade time, then the cue for each bank.
const CUES = [
    {at: 0, fade: 0, banks: ["chase", "chase"]},
    {at: 3.5, fade: 1, banks: ["chase", "wander"]},
    {at: 6.5, fade: 1, banks: ["wander", "chase"]},
    {at: 9, fade: 1, banks: ["wander", "wander"]},
    {at: 11.5, fade: 1.5, banks: ["arc", "arc"]},
    {at: 20.5, fade: 1.5, banks: ["arc", "chase"]},
    {at: 22.5, fade: 1, banks: ["wander", "chase"]},
    {at: 24.5, fade: 1, banks: ["fan", "fan"]},
    {at: 27.5, fade: 1.5, banks: ["chase", "chase"]},
];

function samplePath(cue, t, bank, slot, spacing, out) {
    const side = bank === 0 ? -1 : 1;
    let x, z;
    switch (cue) {
        case "chase": {
            // Each follower reaches exactly the leader's earlier position.
            const a = TURN * t / 6 - slot * spacing * Math.PI / 180 + bank * 0.65;
            x = side * (0.79 * Math.sin(a) + 0.17 * Math.sin(2 * a));
            z = side * (0.44 * Math.sin(2 * a - 0.3) + 0.12 * Math.cos(a));
            break;
        }
        case "wander": {
            const beat = TURN * t / CONCERT_SECONDS;
            const seed = (6 * bank + slot + 1) * 2.39996; // golden angle separates starting phases
            x = 0.72 * Math.sin((3 + slot % 3) * beat + seed) + 0.25 * Math.sin(7 * beat - 1.3 * seed);
            z = 0.46 * Math.cos((4 + slot % 2) * beat - seed) + 0.22 * Math.sin(6 * beat + 1.7 * seed);
            break;
        }
        case "arc": {
            const a = (slot - 2.5) * 0.47;
            x = 0.84 * Math.sin(a);
            z = side * (1.05 * Math.cos(a) - 0.72) + 0.12 * x;
            break;
        }
        case "fan":
            x = (slot - 2.5) * 0.31;
            z = side * x * 0.55;
            break;
    }
    return out.set(x + side * 0.22, 0, z + side * 0.50);
}

export function concertPath(cycle, index, spacing, out) {
    const t = (cycle - Math.floor(cycle)) * CONCERT_SECONDS;
    const bank = Math.floor(index / 6) % 2;
    const slot = index % 6;
    let i = CUES.length - 1;
    while (CUES[i].at > t) i--;
    const cue = CUES[i];
    samplePath(cue.banks[bank], t, bank, slot, spacing, out);
    const elapsed = t - cue.at;
    if (elapsed < cue.fade && CUES[i - 1].banks[bank] !== cue.banks[bank]) {
        const targetX = out.x, targetZ = out.z;
        samplePath(CUES[i - 1].banks[bank], t, bank, slot, spacing, out);
        const f = elapsed / cue.fade;
        const weight = f * f * (3 - 2 * f);
        out.x += weight * (targetX - out.x);
        out.z += weight * (targetZ - out.z);
    }
    return out;
}
