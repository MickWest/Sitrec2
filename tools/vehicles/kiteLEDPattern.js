import {Color} from "three";

const turn = value => ((value % 1) + 1) % 1;
const distance = value => Math.abs(turn(value + 0.5) - 0.5);
const clamp = value => Math.max(0, Math.min(1, value));
const SHOW = ["spokes", "bar", "burst", "spiral", "rings", "rainbow", "twinkle", "pulse"];

// Absolute time, with no accumulated state or random numbers: seeking, export,
// the designer and a frozen model all reproduce the same light show.
// `site` describes a fixed bulb, never a moving piece of geometry.
export function sampleKiteLED(site, p, seconds, out = {color: new Color(), level: 0}) {
    if (site.tail) return sampleKiteTailLED(site, p, seconds, out);
    if (p.ledSpeed === 0) seconds = 0;
    const cycles = seconds * p.ledSpeed + p.ledPhase / 360;
    const pattern = p.ledPattern === "sequence"
        ? SHOW[((Math.floor(seconds / p.ledSequenceSeconds) % SHOW.length) + SHOW.length) % SHOW.length] : p.ledPattern;
    const angle = site.angle, radius = site.radius, width = p.ledWidth / 100;
    let level = 1, hue = turn(angle - cycles), colorIndex = Math.floor(hue * 3);
    // A soft edge fades between adjacent fixed strips. No lamps are moved.
    const spoke = (arms, twist = 0) => clamp(1 - distance((angle - cycles + twist) * arms) / Math.max(width / 2, arms / (site.spokes * 2)));
    switch (pattern) {
        case "spokes": level = spoke(p.ledArms); break;
        case "bar": level = spoke(2); break;
        case "spiral": level = spoke(p.ledArms, radius * 0.4); break;
        case "burst": {
            const progress = turn(cycles);
            level = clamp(1 - Math.abs(radius - progress) / (0.06 + width * 0.3)) * (1 - progress * 0.45);
            colorIndex = ((Math.floor(cycles) % 3) + 3) % 3; hue = turn(cycles / 3);
            break;
        }
        case "rings": level = clamp(1 - distance(radius * 2 - cycles) / (0.08 + width * 0.3));
            hue = turn(radius - cycles); colorIndex = Math.floor(hue * 3); break;
        case "twinkle": {
            const tick = Math.floor(cycles * 8), seed = Math.sin(site.index * 127.1 + tick * 311.7) * 43758.5453;
            level = turn(seed) > 0.76 ? Math.pow(Math.sin(Math.PI * turn(cycles * 8)), 2) : 0;
            hue = turn(site.index * 0.618 + tick / 7); colorIndex = Math.floor(hue * 3);
            break;
        }
        case "pulse": level = 0.5 - 0.5 * Math.cos(cycles * Math.PI * 2);
            hue = turn(cycles / 3); colorIndex = ((Math.floor(cycles) % 3) + 3) % 3; break;
        case "steady": hue = angle; colorIndex = Math.floor(angle * 3); break;
        case "rainbow": break;
    }
    if (["spokes", "bar", "spiral"].includes(pattern) && !site.ring) {
        const arms = pattern === "bar" ? 2 : p.ledArms;
        colorIndex = Math.round(turn(angle - cycles + (pattern === "spiral" ? radius * 0.4 : 0)) * arms) % 3;
    }
    // The hub rings chase independently of the spoke masks, as on radial LED kits.
    if (site.ring && ["spokes", "bar", "spiral"].includes(pattern))
        level = 0.3 + 0.7 * clamp(1 - distance(angle + cycles * 2) / 0.25);
    out.level = p.ledEnabled ? p.ledBackground / 100 + (1 - p.ledBackground / 100) * level : 0;
    if (p.ledPalette === "rainbow" || pattern === "rainbow") out.color.setHSL(hue, 1, 0.5);
    else out.color.set(p.ledPalette === "solid" ? p.ledColor1 : [p.ledColor1, p.ledColor2, p.ledColor3][colorIndex]);
    return out;
}

export const kiteLEDIntensity = (site, p) => site.tail ? p.ledTailIntensity : p.ledIntensity;

function sampleKiteTailLED(site, p, seconds, out) {
    const cycles = seconds * p.ledTailSpeed + (p.ledTailPhase + site.tailIndex * p.ledTailStagger) / 360;
    const along = site.fraction * p.ledTailRepeats - cycles;
    const width = Math.max(p.ledTailWidth / 100, p.ledTailRepeats / (p.ledTailCount - 1));
    let level = 1;
    out.color.set(p.ledTailColor);
    switch (p.ledTailPattern) {
        case "chase": level = clamp(1 - distance(along) / (width / 2)); break;
        case "comet": level = clamp(1 - turn(-along) / width) ** 2; break;
        case "alternating": out.color.set(turn(along) < 0.5 ? p.ledTailColor : p.ledTailColor2); break;
        case "rainbow": out.color.setHSL(turn(along), 1, 0.5); break;
        case "pulse": level = 0.5 + 0.5 * Math.cos(cycles * Math.PI * 2); break;
        case "twinkle": {
            const tick = Math.floor(cycles * 8);
            const seed = Math.sin(site.index * 127.1 + tick * 311.7) * 43758.5453;
            level = turn(seed) > 0.6 ? Math.sin(Math.PI * turn(cycles * 8)) ** 2 : 0;
            break;
        }
    }
    out.level = p.ledTailEnabled ? p.ledTailBackground / 100 + (1 - p.ledTailBackground / 100) * level : 0;
    return out;
}
