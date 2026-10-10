// EnvOverride.js — The user's "SITREC_ ENV Override" setting.
//
// The setting is text in shared.env format (Globals.settings.envOverride). Each
// SITREC_* line in it replaces the value the installation supplied, as if the line
// were at the end of shared.env: for getEnv() callers through envUtils, and for
// Globals.env readers by writing the value there.
//
// What it cannot do, by construction:
//   - It changes only what THIS browser reads. The server never sees it as
//     configuration, so a server-side setting (PHP reads shared.env itself) keeps the
//     installation's value.
//   - It takes only keys that start with SITREC_, and of those only the keys that the
//     installation's ALLOW_OVERRIDE list matches. With no list, it takes nothing and the
//     Settings menu has no entry for it. ALLOW_OVERRIDE itself is not a SITREC_ key, so
//     a user cannot change the list.
//   - In the secure build it is also held to userOverrideAllowed() in envUtils.js: a
//     security flag can be set only to "false", and a credential cannot be supplied.
//   - It is applied when the user's settings load. Code that read a setting before
//     that point keeps the installation's value until the page is reloaded - and on
//     reload the settings load again at the same point, so such a reader never sees
//     the override. In practice the readers are menus and sources built with the
//     sitch, which come later.

import {Globals} from "./Globals";
import {getEnv, setUserEnvOverrides, userOverrideAllowed} from "./envUtils";
import {parseEnvText} from "../tools/src/envText.js";

export const ENV_OVERRIDE_PREFIX = "SITREC_";

// What Globals.env held for each key the last apply changed: [key, hadIt, value].
// Restored first on the next apply, so a line the user removed stops overriding.
let replacedInGlobalsEnv = [];

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The ALLOW_OVERRIDE setting as patterns. It is a comma-separated list; spaces around
 * an entry are ignored, `*` matches any characters (none included), and a pattern must
 * match the whole key. "SITREC_CUSTOM_SOUNDING_*" matches every custom sounding key,
 * "SITREC_*" matches every SITREC_ key.
 *
 * @param {string|undefined} list
 * @returns {RegExp[]} empty when the list is empty or not set
 */
export function parseAllowOverride(list) {
    return String(list ?? "").split(",")
        .map(entry => entry.trim())
        .filter(entry => entry !== "")
        .map(entry => new RegExp("^" + entry.split("*").map(escapeRegExp).join(".*") + "$"));
}

/**
 * This installation's ALLOW_OVERRIDE list: from the container's runtime settings if it
 * has them, else from Globals.env (PHP in server mode, the build in serverless mode).
 * @returns {string|undefined}
 */
export function allowOverrideList() {
    return getEnv("ALLOW_OVERRIDE", Globals.env?.ALLOW_OVERRIDE);
}

/**
 * True when the installation lets a user override at least one setting. Without that,
 * the Settings menu has no "SITREC_ ENV Override" entry.
 * @returns {boolean}
 */
export function envOverrideAvailable() {
    return parseAllowOverride(allowOverrideList()).length > 0;
}

/**
 * Parse override text into the lines that are used and the lines that are not.
 *
 * Reasons for a line that is not used:
 *   "notSitrec"   - the key does not start with SITREC_
 *   "notAllowed"  - no ALLOW_OVERRIDE pattern matches the key
 *   "secureBuild" - the secure build's rule refuses the value
 *
 * @param {string} text - shared.env format
 * @param {string|undefined} allowOverride - the ALLOW_OVERRIDE list
 * @returns {{accepted: Object<string, string>, ignored: Array<{key: string, reason: string}>}}
 */
export function readEnvOverride(text, allowOverride) {
    const patterns = parseAllowOverride(allowOverride);
    const accepted = {};
    const ignored = [];
    for (const [key, value] of Object.entries(parseEnvText(text))) {
        if (!key.startsWith(ENV_OVERRIDE_PREFIX)) {
            ignored.push({key, reason: "notSitrec"});
        } else if (!patterns.some(pattern => pattern.test(key))) {
            ignored.push({key, reason: "notAllowed"});
        } else if (!userOverrideAllowed(key, value)) {
            ignored.push({key, reason: "secureBuild"});
        } else {
            accepted[key] = value;
        }
    }
    return {accepted, ignored};
}

/**
 * Put the override text into force, replacing any earlier one.
 *
 * @param {string} text - shared.env format; "" removes every override
 * @returns {{accepted: Object<string, string>, ignored: Array<{key: string, reason: string}>}}
 */
export function applyEnvOverride(text) {
    // Back to the installation's values first.
    setUserEnvOverrides({});
    if (Globals.env) {
        for (const [key, hadIt, value] of replacedInGlobalsEnv) {
            if (hadIt) Globals.env[key] = value;
            else delete Globals.env[key];
        }
    }
    replacedInGlobalsEnv = [];

    const result = readEnvOverride(text, allowOverrideList());
    setUserEnvOverrides(result.accepted);
    if (Globals.env) {
        for (const [key, value] of Object.entries(result.accepted)) {
            replacedInGlobalsEnv.push([key, Object.prototype.hasOwnProperty.call(Globals.env, key), Globals.env[key]]);
            Globals.env[key] = value;
        }
    }
    return result;
}
