import {defaultSpotlightBeam, MAX_PROJECTOR_BEAMS} from "./SpotlightMotion";

const PATTERNS = new Map([["Circle", "Circle"], ["Eight", "Vertical eight"], ["Diamond", "Diamond"], ["Leaf", "Leaf"]]);
const child = (node, name) => Array.from(node.children).find(el => el.localName === name);
const value = (node, name, fallback) => child(node, name)?.textContent.trim() ?? fallback;
const wrap = angle => ((angle % 360) + 360) % 360;

// Project a centered QLC+ position effect onto the sky. Its two control axes
// become offsets on a horizontal cloud plane, with full scale at 24 degrees.
function positionEffect(effect) {
    const pattern = PATTERNS.get(value(effect, "Algorithm"));
    const order = value(effect, "RunOrder", "Loop");
    const speed = child(effect, "Speed");
    const period = Number(speed?.getAttribute("Duration")) / 1000;
    const width = Number(value(effect, "Width", 127));
    const height = Number(value(effect, "Height", 127));
    const fixtures = Array.from(effect.children).filter(el => el.localName === "Fixture");
    const axes = Array.from(effect.children).filter(el => el.localName === "Axis");
    if (!pattern || !["Loop", "PingPong"].includes(order) || value(effect, "PropagationMode", "Parallel") !== "Parallel") return null;
    if (!speed || !(period >= 0.25 && period <= 120) || Number(speed.getAttribute("FadeIn")) !== 0
        || Number(speed.getAttribute("FadeOut")) !== 0) return null;
    if (!(width >= 0 && width <= 127 && height >= 1 && height <= 127) || value(effect, "IsRelative", "0") !== "0"
        || axes.some(axis => ![127, 128].includes(Number(value(axis, "Offset", 127))))) return null;
    if (!fixtures.length || fixtures.length > MAX_PROJECTOR_BEAMS || fixtures.some(f => value(f, "Mode", "0") !== "0")) return null;

    const rotation = Number(value(effect, "Rotation", 0));
    const offset = Number(value(effect, "StartOffset", 0));
    const masterDirection = value(effect, "Direction", "Forward");
    const phases = fixtures.map(f => Number(value(f, "StartOffset", 0)));
    if (![rotation, offset, ...phases].every(Number.isFinite)) return null;
    const swing = Math.atan(Math.tan(24 * Math.PI / 180) * height / 127) * 180 / Math.PI;
    const beams = fixtures.map((fixture, i) => {
        // QLC's circle runs from north toward negative X. The Sitrec circle
        // starts north and turns toward positive X.
        const sign = pattern === "Circle" ? -1 : 1;
        const backwards = value(fixture, "Direction", "Forward") !== masterDirection;
        return {...defaultSpotlightBeam(i), pattern, period, swing, aspect: width / height,
            heading: wrap(rotation), phase: wrap(sign * (offset + phases[i])),
            pingPong: order === "PingPong", reverse: sign < 0 ? !backwards : backwards};
    });
    return {name: effect.getAttribute("Name") || effect.getAttribute("ID") || pattern, beams};
}

export function readQLCSpotlightEffects(xml) {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) return [];
    return Array.from(doc.getElementsByTagName("Function"))
        .filter(el => el.getAttribute("Type") === "EFX")
        .map(positionEffect).filter(Boolean);
}
