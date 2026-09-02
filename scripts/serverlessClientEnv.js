const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const PROJECT_ROOT = path.resolve(__dirname, "..");
// config/shared.env, or the file SITREC_SHARED_ENV names when building for another
// deployment - the same file webpack.common.js reads, so a serverless bundle never mixes
// one site's settings with another's (see buildTarget.js).
const SHARED_ENV_PATH = require("./buildTarget").sharedEnvPath();
const SHARED_ENV_EXAMPLE_PATH = path.join(PROJECT_ROOT, "config", "shared.env.example");

const EXPLICIT_SENSITIVE_KEYS = new Set([
    "MAPBOX_TOKEN",
    "MAPTILER_KEY",
    "GOOGLE_MAPS_API_KEY",
    "CESIUM_ION_TOKEN",
    "OPENAI_API",
    "ANTHROPIC_API",
    "GROQ_API",
    "GROK_API",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
]);

const SERVERLESS_FORCED_VALUES = {
    CHATBOT_ENABLED: "false",
    IS_SERVERLESS_BUILD: "true",
    SAVE_TO_S3: "false",
    SAVE_TO_SERVER: "false",
    SETTINGS_DB_ENABLED: "false",
    SETTINGS_SERVER_ENABLED: "false",
};

function loadDotenvFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return {};
    }

    return dotenv.parse(fs.readFileSync(filePath));
}

function isSensitiveEnvKey(key) {
    if (!key) {
        return false;
    }

    if (EXPLICIT_SENSITIVE_KEYS.has(key)) {
        return true;
    }

    return /(^|_)(TOKEN|SECRET|PASSWORD|ACCESS_KEY|API_KEY|API)(_|$)/i.test(key);
}

function buildServerlessClientEnv({ exampleEnv, liveEnv } = {}) {
    const mergedEnv = {
        ...(exampleEnv ?? loadDotenvFile(SHARED_ENV_EXAMPLE_PATH)),
        ...(liveEnv ?? loadDotenvFile(SHARED_ENV_PATH)),
    };

    const sanitizedEnv = {};

    for (const [key, value] of Object.entries(mergedEnv)) {
        sanitizedEnv[key] = isSensitiveEnvKey(key) ? "" : value;
    }

    return {
        ...sanitizedEnv,
        ...SERVERLESS_FORCED_VALUES,
    };
}

function buildWebpackDefineEnv(envValues) {
    return Object.fromEntries(
        Object.entries(envValues).map(([key, value]) => [
            `process.env.${key}`,
            JSON.stringify(value),
        ]),
    );
}

module.exports = {
    SHARED_ENV_EXAMPLE_PATH,
    SHARED_ENV_PATH,
    SERVERLESS_FORCED_VALUES,
    buildServerlessClientEnv,
    buildWebpackDefineEnv,
    isSensitiveEnvKey,
    loadDotenvFile,
};
