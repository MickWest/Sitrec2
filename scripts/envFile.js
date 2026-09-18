/**
 * Reading shared.env-format files with comments handled one way everywhere.
 *
 * A "#" starts a comment only outside quotes, and only at the start of a line
 * or after whitespace. A quote is special only where the value starts:
 *
 *     FOO=1  # note             -> 1
 *     BANNER_COLOR="#FFFFFF"    -> #FFFFFF
 *     URL=https://host/page#top -> https://host/page#top
 *     TEXT=It's ready # note    -> It's ready
 *
 * docker compose reads .env files by the same rule. dotenv 8 (used by the build
 * and by dotenv-webpack) does not remove trailing comments at all, so every JS
 * reader of shared.env goes through this module instead. The same rule is
 * repeated in sitrecServer/injectEnv.php and in the bake parsers of install.sh
 * and sitrec.sh; the pre-commit version stamp (sharedEnvVersion.js) uses it to
 * decide whether a change to the example affects any setting.
 */

"use strict";

const fs = require("node:fs");

// Index of the first character of the value in a KEY=value line (after the
// first "=" and any spaces or tabs), or -1 when the line has no "=".
function valueStart(line) {
    const eq = line.indexOf("=");
    if (eq < 0) return -1;
    let i = eq + 1;
    while (line[i] === " " || line[i] === "\t") i++;
    return i;
}

// One line with its comment removed and its ends trimmed. A quote opens only
// at the start of the value, so the apostrophe in It's is plain text. A value
// that opens a quote and never closes it is kept whole, never silently cut.
function stripComment(line) {
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

// The whole text with every comment removed. Line count is kept.
function stripComments(text) {
    return String(text).split(/\r\n|\n|\r/).map(stripComment).join("\n");
}

// KEY -> value, exactly as dotenv 8 reads the text once its comments are gone.
function parseEnv(text) {
    return require("dotenv").parse(stripComments(text));
}

// Replaces dotenv.config({ path }): values already in process.env win.
// Throws when the file cannot be read.
function loadEnvIntoProcess(filePath) {
    const parsed = parseEnv(fs.readFileSync(filePath, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
        if (!Object.prototype.hasOwnProperty.call(process.env, key)) process.env[key] = value;
    }
    return parsed;
}

// dotenv-webpack reads the file itself, through its own copy of dotenv 8.
// This subclass gives it the text with the comments already removed.
function commentAwareDotenvPlugin(options) {
    const DotenvWebpack = require("dotenv-webpack");
    if (typeof DotenvWebpack.prototype.loadFile !== "function") {
        // Without this check a dotenv-webpack upgrade that renames loadFile
        // would silently put trailing comments back into the bundle.
        throw new Error("dotenv-webpack has no loadFile() to override; update scripts/envFile.js");
    }
    // The class name MUST stay "Dotenv": webpack.serverless.js and
    // webpack.secure.js drop this plugin by constructor.name, and a plugin they
    // failed to drop would put every shared.env value into a public bundle.
    class Dotenv extends DotenvWebpack {
        loadFile(opts) {
            const text = super.loadFile(opts);
            return typeof text === "string" ? stripComments(text) : text;
        }
    }
    return new Dotenv(options);
}

module.exports = {
    stripComment,
    stripComments,
    parseEnv,
    loadEnvIntoProcess,
    commentAwareDotenvPlugin,
};
