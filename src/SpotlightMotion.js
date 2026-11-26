import {concertPath, CONCERT_SECONDS, DEFAULT_CONCERT} from "./SpotlightConcert";

// Beam directions in projector coordinates (+X east, +Y up, -Z north).
export const PLANAR_PATTERNS = ["Circle", "Sweep", "Figure eight", "Vertical eight", "Diamond", "Leaf", "Concert"];
export const SPOTLIGHT_PATTERNS = [...PLANAR_PATTERNS, "Rotating head", "Flower", "Fixed"];
export const MAX_PROJECTOR_BEAMS = 36;
export const DEFAULT_SPOTLIGHT_LUMENS = 100000;
export const MAX_SPOTLIGHT_LUMENS = 500000;
export const DEFAULT_FLOWER_CODE = "550";
export const DEFAULT_FLOWER_PAN = 90;
const RAD = Math.PI / 180;
const TURN = 2 * Math.PI;

export function isFlowerCode(value) {
    return typeof value === "string" && /^[0-9]{3}$/.test(value);
}

export function defaultSpotlightBeam(index) {
    return {pattern: "Circle", heading: 0, tilt: 0, swing: 24, period: 8,
        phase: (index * 90 + Math.floor(index / 4) * 22.5) % 360, width: 8,
        aspect: 1, reverse: false, pingPong: false};
}

export function spotlightDirection(beam, seconds, out, flowerCode = DEFAULT_FLOWER_CODE, pan = DEFAULT_FLOWER_PAN,
    index = 0, concert = DEFAULT_CONCERT, spread = 1) {
    let cycle = seconds / beam.period;
    if (beam.pattern === "Concert") cycle *= concert.speed;
    if (beam.pingPong) {
        const pair = cycle - 2 * Math.floor(cycle / 2);
        cycle = 1 - Math.abs(pair - 1);
    }
    const drive = (beam.reverse ? -cycle : cycle) * TURN;
    let angle = drive + beam.phase * RAD;
    let heading = beam.heading * RAD;
    const tilt = beam.tilt * RAD;
    let swing = beam.swing * RAD;
    let across = 0, up = 1, forward = Math.tan(tilt);
    if (beam.pattern === "Rotating head" || beam.pattern === "Flower") {
        if (beam.pattern === "Flower") {
            // AUTO dials set opening, rotation and pan speeds. At digit 5
            // each drive makes one cycle per user-selected period.
            swing *= (1 + Math.cos(drive * Number(flowerCode[0]) / 5)) / 2;
            angle = beam.phase * RAD + drive * Number(flowerCode[1]) / 5;
            heading += pan * RAD / 2 * Math.sin(drive * Number(flowerCode[2]) / 5);
        }
        // Rotate around the tilted shaft. When tilt equals swing, the
        // head passes through vertical once per turn.
        const radial = Math.sin(swing) * Math.cos(angle);
        across = Math.sin(swing) * Math.sin(angle);
        up = Math.cos(tilt) * Math.cos(swing) + Math.sin(tilt) * radial;
        forward = Math.sin(tilt) * Math.cos(swing) - Math.cos(tilt) * radial;
    } else if (beam.pattern !== "Fixed") {
        const amplitude = Math.tan(swing);
        across = amplitude * Math.sin(angle);
        switch (beam.pattern) {
            case "Concert":
                concertPath(angle / TURN, index, concert.spacing, out);
                across = amplitude * out.x;
                forward += amplitude * out.z;
                heading += concert.heading * RAD;
                break;
            case "Circle":
                forward += amplitude * Math.cos(angle);
                break;
            case "Figure eight":
                forward += 0.5 * amplitude * Math.sin(2 * angle);
                break;
            case "Vertical eight":
                across = -amplitude * Math.sin(2 * angle);
                forward += amplitude * Math.cos(angle);
                break;
            case "Diamond":
                across = amplitude * Math.sin(angle) ** 3;
                forward += amplitude * Math.cos(angle) ** 3;
                break;
            case "Leaf":
                across = -amplitude * Math.sin(angle) ** 5;
                forward += amplitude * Math.cos(angle);
                break;
        }
        across *= beam.aspect ?? 1;
    }
    out.set(across * Math.cos(heading) + forward * Math.sin(heading), up,
        across * Math.sin(heading) - forward * Math.cos(heading)).normalize();
    if (spread === 1) return out;
    const horizontal = Math.hypot(out.x, out.z);
    if (horizontal === 0) return out;
    const zenithAngle = Math.min(Math.PI, spread * Math.atan2(horizontal, out.y));
    const scale = Math.sin(zenithAngle) / horizontal;
    return out.set(out.x * scale, Math.cos(zenithAngle), out.z * scale);
}

// Approximate the solid angle of a Gaussian beam with the given full width
// at half maximum. Luminous flux divided by solid angle is axial candela.
export function spotlightCandela(lumens, width) {
    const slope = Math.tan(width * Math.PI / 360);
    return lumens * Math.LN2 / (Math.PI * slope * slope);
}

// Older projectors stored output on individual beams. Average the active
// heads, including any at zero, to preserve their combined luminous flux.
export function readSpotlightLumens(saved, count) {
    const clamp = value => Math.min(MAX_SPOTLIGHT_LUMENS, Math.max(0, value));
    if (Number.isFinite(saved.lumens)) return clamp(saved.lumens);
    if (!Array.isArray(saved.beams) || !saved.beams.length) return DEFAULT_SPOTLIGHT_LUMENS;
    let total = 0;
    for (let i = 0; i < count; i++) {
        const beam = saved.beams[i];
        if (Number.isFinite(beam?.lumens)) total += Math.max(0, beam.lumens);
        else if (Number.isFinite(beam?.brightness)) total += Math.max(0, Math.round(beam.brightness * 125000));
        else total += DEFAULT_SPOTLIGHT_LUMENS;
    }
    return clamp(total / count);
}

const PRESETS = {
    concert: Array.from({length: 12}, () => ({
        pattern: "Concert", period: CONCERT_SECONDS, phase: 0, swing: 28, tilt: 5, width: 4.5,
    })),
    stx4: [0, 90, 180, 270].map(heading => ({pattern: "Rotating head", heading, tilt: 22.5, swing: 22.5, phase: 0})),
    stx1: [{pattern: "Rotating head", tilt: 22.5, swing: 22.5, phase: 0}],
    spaceflower: Array.from({length: 36}, (_, i) => ({
        pattern: "Flower", tilt: 15, swing: 9 * (1 + Math.floor(i / 12)), phase: (i % 12) * 30,
        period: 10, width: 3,
    })),
    // Function 26 in the DJs on Wheels workspace uses a pair of moving
    // heads, a 20-second Leaf, opposite directions and PingPong run order.
    twinLeaf: [false, true].map(reverse => ({
        pattern: "Leaf", aspect: 125 / 127, period: 20, phase: 0, reverse, pingPong: true,
    })),
    fourCircle: [0, 90, 180, 270].map(phase => ({phase})),
    twinSweep: [0, 180].map(phase => ({pattern: "Sweep", swing: 34, period: 6, phase})),
    converge: [0, 90, 180, 270].map(heading => ({pattern: "Sweep", heading, phase: 0, period: 10})),
    sixFan: [-75, -45, -15, 15, 45, 75].map(heading => ({
        pattern: "Sweep", heading: (heading + 360) % 360, tilt: 30, swing: 12, period: 7, phase: 0,
    })),
    crossingEights: [0, 120, 240].map(angle => ({pattern: "Figure eight", heading: angle, phase: angle, period: 12})),
    fixed: [{pattern: "Fixed", tilt: 15}],
};

export const SPOTLIGHT_PRESETS = Object.keys(PRESETS);
const PRESET_LUMENS = {concert: 50000, spaceflower: 5000};

export function spotlightPreset(name) {
    const beams = PRESETS[name]?.map((settings, i) => ({...defaultSpotlightBeam(i), ...settings}));
    if (beams) return {beams, count: beams.length, lumens: PRESET_LUMENS[name] ?? DEFAULT_SPOTLIGHT_LUMENS};
}
