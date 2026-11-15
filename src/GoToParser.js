// Shared, side-effect-free grammar for Go To, pasted text, and chat navigation.
import {parseDateTimeString} from "./DateTimeParser";
import {parseLatLonAlt} from "./CoordinateParser";
import {parsePastedTLE} from "./TLEGrammar";

const NUMBER = /^[-+]?\d+(?:\.\d+)?$/;
const NAVIGATION = /^(?:(?:go|move|goto|fly)(?:\s+to)?|set\s+location(?:\s+to)?)\s+(.+)$/i;
const CLOCK = /^(?:set\s+)?(?:date\s*time|date|time)\s+(?:to\s+)?(.+)$/i;
const MOTION = /^(?:on|off|ahead|back|backwards?|forwards?|up|down|left|right|in|out|away|there|here|home|north|south|east|west|northeast|northwest|southeast|southwest|faster|slower|slow|fast|first|last|next|previous|prev|again|ok|okay)$/i;
const NON_PLACE_START = /^(?:set|show|hide|enable|disable|turn|load|get|fetch|zoom|play|pause|stop|start|resume|go|move|point|look|frame|make|change|calculate|evaluate|ambient|how|why|who|what|which|when|where|is|are|was|were|do|does|can|could|should|would|will|may|might|tell|explain|please|I|you|we)\b/i;

function placeText(text) {
    return text && !MOTION.test(text) && !NON_PLACE_START.test(text)
        && !/\b(?:before|after)\b/i.test(text)
        && !/\s(?:and|then)\s+(?:set|show|hide|load|go|move|point|look|zoom|play|pause)\b/i.test(text);
}

/** Chat leaves bare numbers to conversational replies, and bare names to its
 * final fallback so existing commands and small talk get first refusal. */
export function parseGoToString(input, {chat = false, allowBarePlace = !chat} = {}) {
    if (typeof input !== "string" || !input.trim()) return null;
    let text = input.trim();
    // Check before whitespace/prefix handling: TLEs can have multiple lines.
    if (parsePastedTLE(text)) return {kind: "tle", text};
    const navigation = NAVIGATION.exec(text);
    if (navigation) text = navigation[1].trim();
    const frame = /^(?:set\s+)?frame\s+(?:to\s+)?([-+]?\d+(?:\.\d+)?)$/i.exec(text);
    if (frame || (NUMBER.test(text) && (!chat || navigation))) {
        return {kind: "frame", frame: Math.trunc(Number(frame?.[1] ?? text))};
    }
    // In chat a lone "2" is usually an answer to an offered choice.
    if (NUMBER.test(text)) return null;
    const clock = CLOCK.exec(text);
    const time = clock && /^\d{1,2}$/.test(clock[1]) ? `${clock[1]}:00` : (clock?.[1] ?? text);
    if (parseDateTimeString(time)) return {kind: "time", time};
    if (clock || frame) return null;

    const coordinates = parseLatLonAlt(text, {loose: true});
    if (coordinates) return {kind: "location", location: text, coordinates};

    // Recognize date/time on either side of a contiguous place name. This
    // keeps "New York" intact in "June 10 New York 6PM", using the same
    // date/time grammar as the Time menu, without depending on punctuation.
    const prefixes = [{end: 0, time: ""}];
    const suffixes = [{start: text.length, time: ""}];
    const trimPart = part => part.replace(/^[\s,]+|[\s,]+$/g, "");
    for (const separator of text.matchAll(/,\s*|\s+(?:(?:at|on)\s+)?/gi)) {
        const end = separator.index + separator[0].length;
        const prefix = trimPart(text.slice(0, separator.index));
        const suffix = trimPart(text.slice(end));
        if (parseDateTimeString(prefix)) prefixes.push({end, time: prefix});
        if (parseDateTimeString(suffix)) suffixes.push({start: separator.index, time: suffix});
    }
    let best = null;
    for (const prefix of prefixes) {
        for (const suffix of suffixes) {
            const length = prefix.time.length + suffix.time.length;
            if (!length || prefix.end >= suffix.start || length <= (best?.length ?? 0)) continue;
            const location = trimPart(text.slice(prefix.end, suffix.start));
            if (!placeText(location)) continue;
            best = {location, time: [prefix.time, suffix.time].filter(Boolean).join(", "), length};
        }
    }
    if (best) {
        // Two conflicting times/dates must fail, rather than treating one as
        // part of a place name and silently performing only half the request.
        return parseDateTimeString(best.time) ? {kind: "location", location: best.location, time: best.time} : null;
    }
    if (!placeText(text)) return null;
    // Do not geocode an unsupported extra command or an invalid clock as part
    // of the place name. The caller can offer AI instead of doing half a task.
    if (/\b(?:today|tomorrow|yesterday|tonight|now)\b|\s(?:at|on)\s+\d|,\s*\d+\s*(?::|[ap]m\b)/i.test(text)) return null;
    if (!navigation && (!allowBarePlace || (chat && !/^[\p{L}\p{M}][\p{L}\p{M}\d .,'’\-]{0,79}$/u.test(text)))) return null;
    return {kind: "location", location: text};
}
