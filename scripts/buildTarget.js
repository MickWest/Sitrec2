/*
 * Which deployment a build is for.
 *
 * A checkout normally builds for one site: it reads config/shared.env and writes the
 * production bundle to prod_path from config/config-install.js. To publish the same code
 * to a second host, both can be overridden with environment variables, so one checkout
 * builds for any number of targets without its own config being touched:
 *
 *   SITREC_SHARED_ENV=config/shared.env.othersite \
 *   SITREC_PROD_PATH=/some/output/dir \
 *   npm run deploy
 *
 * Every build step that reads shared.env or writes to prod_path resolves the path here,
 * so the JS bundle, shared.env.php, the freshness gate, the third-party notices and the
 * secret audit all agree on which file and which directory a build used.
 *
 * An override that names a missing file is an error rather than a fallback: a deployment
 * built with the wrong settings would otherwise carry another site's keys.
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_SHARED_ENV = path.join(ROOT, "config", "shared.env");

// Absolute path of the shared.env this build reads. The default may not exist (fresh
// clone); callers keep their own fallback for that case. An explicit override must exist.
function sharedEnvPath() {
    const override = process.env.SITREC_SHARED_ENV;
    if (!override) return DEFAULT_SHARED_ENV;
    const resolved = path.resolve(ROOT, override);
    if (!fs.existsSync(resolved)) {
        throw new Error(`SITREC_SHARED_ENV=${override} resolves to ${resolved}, which does not exist`);
    }
    return resolved;
}

// A short name for messages: "config/shared.env", or the override as given.
function sharedEnvLabel() {
    return process.env.SITREC_SHARED_ENV || "config/shared.env";
}

// Absolute path the production build is written to, or null when neither the override
// nor a config/config-install.js provides one (a fresh clone has only the .example).
function prodPath() {
    const override = process.env.SITREC_PROD_PATH;
    if (override) return path.resolve(override);
    try {
        const InstallPaths = require("../config/config-install");
        return InstallPaths.prod_path || null;
    } catch {
        return null;
    }
}

module.exports = { sharedEnvPath, sharedEnvLabel, prodPath };
