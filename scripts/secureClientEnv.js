const {
    SHARED_ENV_EXAMPLE_PATH,
    SHARED_ENV_PATH,
    buildWebpackDefineEnv,
    isSensitiveEnvKey,
    loadDotenvFile,
} = require("./serverlessClientEnv");

// The client environment of the SECURE build (webpack.secure.js): a production server
// build with every outbound feature removed at compile time.
//
// Starts from the same merge the serverless build uses - config/shared.env.example under
// config/shared.env - and blanks every sensitive key by the same rule (isSensitiveEnvKey,
// shared with serverlessClientEnv.js so the two builds can never disagree on what counts
// as a secret). Then it forces the settings below.
//
// What is deliberately NOT forced: SAVE_TO_S3, SAVE_TO_SERVER and SETTINGS_SERVER_ENABLED.
// The secure deployment saves through its own server, and that server is what enforces
// where a file may go. Forcing those off here would only remove the save feature.

// Settings that turn an outbound feature off, and stay off. Every one of these is also a
// "security flag": in the secure build a runtime override (window.__SITREC_ENV__, see
// src/envUtils.js) may set one of them to "false" but can never set it to anything
// else - a runtime value can only tighten. src/secureFlags.js carries the same list for
// the bundled code; tests/secureClientEnv.test.js checks that the two match.
const SECURE_SECURITY_FLAGS = [
    "CHATBOT_ENABLED",                         // the AI assistant relay
    "SITREC_TRACK_STATS",                      // visit counter and tile-usage statistics
    "LOG_UI_INTERACTIONS",                     // menu-click logging
    "SITREC_ENABLE_DEFAULT_MAP_SOURCES",       // the built-in internet map providers
    "SITREC_ENABLE_DEFAULT_ELEVATION_SOURCES", // the built-in internet elevation providers
    "SITREC_ENABLE_DEFAULT_TLE_SOURCES",       // the built-in satellite element-set sources
    "USE_S3_PRESIGNED_URLS",                   // direct browser-to-object-storage transfers
];

const SECURE_FORCED_VALUES = {
    IS_SECURE_BUILD: "true",
    ...Object.fromEntries(SECURE_SECURITY_FLAGS.map((key) => [key, "false"])),
};

// Only settings the browser is meant to see are embedded. The list is the container
// entrypoint's CLIENT_VARS block (docker/entrypoint.sh), read here so there is one source
// of truth: a setting the entrypoint would not forward to the page is not compiled into
// the page either. Server-only values (forum paths, upload directories, custom feed
// addresses) otherwise reach the bundle as string literals, which the egress audit then
// reports and which an assessor would read as disclosure. The entrypoint also forwards
// any SITREC_CUSTOM_MAP_* / SITREC_CUSTOM_ELEVATION_* name, and so does this.
const ENTRYPOINT_PATH = require("path").resolve(__dirname, "..", "docker", "entrypoint.sh");
const CUSTOM_SOURCE_KEY_RE = /^SITREC_CUSTOM_(MAP|ELEVATION)_/;

function loadClientVarNames(entrypointText) {
    const text = entrypointText ?? require("fs").readFileSync(ENTRYPOINT_PATH, "utf8");
    const block = /^CLIENT_VARS="([\s\S]*?)^"/m.exec(text);
    if (!block) {
        throw new Error(`secureClientEnv: CLIENT_VARS block not found in ${ENTRYPOINT_PATH}`);
    }
    const names = block[1].split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
    if (names.length === 0) {
        throw new Error("secureClientEnv: CLIENT_VARS block is empty");
    }
    return new Set(names);
}

function isClientVisibleKey(key, clientVarNames) {
    return clientVarNames.has(key) || CUSTOM_SOURCE_KEY_RE.test(key);
}

function buildSecureClientEnv({ exampleEnv, liveEnv, clientVarNames } = {}) {
    const mergedEnv = {
        ...(exampleEnv ?? loadDotenvFile(SHARED_ENV_EXAMPLE_PATH)),
        ...(liveEnv ?? loadDotenvFile(SHARED_ENV_PATH)),
    };
    const clientKeys = clientVarNames ?? loadClientVarNames();

    const sanitizedEnv = {};

    for (const [key, value] of Object.entries(mergedEnv)) {
        if (!isClientVisibleKey(key, clientKeys)) continue;
        sanitizedEnv[key] = isSensitiveEnvKey(key) ? "" : value;
    }

    return {
        ...sanitizedEnv,
        ...SECURE_FORCED_VALUES,
    };
}

module.exports = {
    SECURE_FORCED_VALUES,
    SECURE_SECURITY_FLAGS,
    buildSecureClientEnv,
    buildWebpackDefineEnv,
    isClientVisibleKey,
    isSensitiveEnvKey,
    loadClientVarNames,
};
