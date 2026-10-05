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
//   - It takes only keys that start with SITREC_.
//   - In the secure build it is held to the runtime ratchet in envUtils.js: it can
//     tighten a security flag, never loosen one, and cannot supply a credential.
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

/**
 * Parse override text into the lines that are used and the lines that are not.
 *
 * @param {string} text - shared.env format
 * @param {function(string): (string|undefined)} [baseValueOf] - the value in force
 *        for a key without the override (for the secure-build rule)
 * @returns {{accepted: Object<string, string>, ignored: Array<{key: string, reason: string}>}}
 */
export function readEnvOverride(text, baseValueOf = () => undefined) {
    const accepted = {};
    const ignored = [];
    for (const [key, value] of Object.entries(parseEnvText(text))) {
        if (!key.startsWith(ENV_OVERRIDE_PREFIX)) {
            ignored.push({key, reason: "notSitrec"});
        } else if (!userOverrideAllowed(key, value, baseValueOf(key))) {
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

    const result = readEnvOverride(text, key => getEnv(key, Globals.env?.[key]));
    setUserEnvOverrides(result.accepted);
    if (Globals.env) {
        for (const [key, value] of Object.entries(result.accepted)) {
            replacedInGlobalsEnv.push([key, Object.prototype.hasOwnProperty.call(Globals.env, key), Globals.env[key]]);
            Globals.env[key] = value;
        }
    }
    return result;
}
