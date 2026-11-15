const NUMBER_WORDS = {
    a: 1, an: 1, zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
    fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const ones = 'one|two|three|four|five|six|seven|eight|nine';
const tens = 'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety';
const number = `(?:\\d+(?:\\.\\d+)?|\\.\\d+|(?:${tens})(?:[ -](?:${ones}))?|${Object.keys(NUMBER_WORDS).join('|')})`;
const amount = `(?:${number}(?:\\s+and\\s+a\\s+half)?|half(?:\\s+an?)?|(?:a\\s+)?quarter(?:\\s+of)?(?:\\s+an?)?)`;
const component = new RegExp(`^(${amount})(?:\\s+|(?<=\\d))(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s|days?|d)(?=\\b|\\d)(?:\\s+and\\s+a\\s+(half|quarter)\\b)?`);

function amountValue(text) {
    if (text.startsWith('half')) return 0.5;
    if (text.includes('quarter')) return 0.25;
    const half = text.endsWith(' and a half');
    if (half) text = text.slice(0, -11);
    const value = /^\d|^\./.test(text) ? Number(text)
        : text.split(/[ -]/).reduce((sum, word) => sum + NUMBER_WORDS[word], 0);
    return value + (half ? 0.5 : 0);
}

function durationMS(text) {
    let total = 0;
    while (text) {
        const match = component.exec(text);
        if (!match) return null;
        const unit = {h: 3600000, m: 60000, s: 1000, d: 86400000}[match[2][0]];
        const fraction = match[3] === 'half' ? 0.5 : match[3] === 'quarter' ? 0.25 : 0;
        total += (amountValue(match[1]) + fraction) * unit;
        text = text.slice(match[0].length);
        if (!text) break;
        // Components can be adjacent (1h30m), spaced, or joined by "and".
        text = text.replace(/^(?:\s*,\s*|\s+)(?:and\s+)?/, '');
        if (!text) return null;
    }
    return Number.isFinite(total) && Number.isSafeInteger(Math.round(total)) ? Math.round(total) : null;
}

// Remove one complete duration before "before"/"after", leaving the date/time
// anchor for the shared parser. A partial or repeated modifier must fail whole.
export function extractTimeOffset(text) {
    const modifiers = [...text.matchAll(/\b(before|after)\b/g)];
    if (!modifiers.length) return {text};
    if (modifiers.length !== 1) return null;
    const modifier = modifiers[0];
    const anchor = text.slice(modifier.index + modifier[0].length).trim();
    if (!anchor) return null;
    const prefix = text.slice(0, modifier.index).trimEnd();
    for (const boundary of prefix.matchAll(/(?:^|[\s,])(?=\S)/g)) {
        const start = boundary.index + boundary[0].length;
        const duration = durationMS(prefix.slice(start));
        if (duration !== null) {
            return {text: `${prefix.slice(0, start)} ${anchor}`,
                timeShiftMS: duration * (modifier[1] === 'before' ? -1 : 1)};
        }
    }
    return null;
}
