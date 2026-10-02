// envText.js — Read shared.env-format text in the browser.
//
// SHARED by the Sitrec app (src/EnvOverride.js: the user's "SITREC_ ENV Override"
// setting) and the standalone tools (tools/xml-wind/analyze.js). A tool is served
// unbundled, so this file imports nothing.
//
// The rule is the one in scripts/envFile.js, which the build uses for shared.env
// itself, followed by the way dotenv 8 reads a line. tests/EnvOverride.test.js holds
// this module and that one equal, so text a user types into the override is read
// exactly as the same text in shared.env would be.
//
// A "#" starts a comment only outside quotes, and only at the start of a line or
// after whitespace. A quote is special only where the value starts:
//
//     FOO=1  # note             -> 1
//     BANNER_COLOR="#FFFFFF"    -> #FFFFFF
//     URL=https://host/page#top -> https://host/page#top
//     TEXT=It's ready # note    -> It's ready

// Index of the first character of the value in a KEY=value line (after the first
// "=" and any spaces or tabs), or -1 when the line has no "=".
function valueStart(line) {
    const eq = line.indexOf("=");
    if (eq < 0) return -1;
    let i = eq + 1;
    while (line[i] === " " || line[i] === "\t") i++;
    return i;
}

/**
 * One line with its comment removed and its ends trimmed. A value that opens a
 * quote and never closes it is kept whole.
 */
export function stripEnvComment(line) {
    const start = valueStart(line);
    let quote = null;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
            if (ch === "\\" && quote === '"') i++; // skip the escaped character
            else if (ch === quote) quote = null;
        } else if ((ch === '"' || ch === "'") && i === start) {
            quote = ch;
        } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
            return line.slice(0, i).trim();
        }
    }
    return line.trim();
}

// dotenv 8's line pattern: a key of letters, digits, "_", "." and "-".
const KEY_VALUE = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/;

/**
 * shared.env text -> {KEY: value}. Comments and lines that are not KEY=value are
 * skipped. A later line for the same key replaces an earlier one. Surrounding
 * quotes are removed; inside double quotes "\n" is a new line.
 *
 * @param {string} text
 * @returns {Object<string, string>}
 */
export function parseEnvText(text) {
    const env = {};
    for (const rawLine of String(text ?? "").split(/\r\n|\n|\r/)) {
        const match = stripEnvComment(rawLine).match(KEY_VALUE);
        if (!match) continue;
        let value = match[2] ?? "";
        const last = value.length - 1;
        const doubleQuoted = value[0] === '"' && value[last] === '"';
        const singleQuoted = value[0] === "'" && value[last] === "'";
        if (doubleQuoted || singleQuoted) {
            value = value.substring(1, last);
            if (doubleQuoted) value = value.replace(/\\n/g, "\n");
        } else {
            value = value.trim();
        }
        env[match[1]] = value;
    }
    return env;
}
