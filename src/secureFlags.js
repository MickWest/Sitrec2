// The secure build's security flags and its sensitivity rule, for the bundled code.
//
// This is a MIRROR of scripts/secureClientEnv.js (SECURE_SECURITY_FLAGS) and
// scripts/serverlessClientEnv.js (isSensitiveEnvKey). scripts/ is not bundled, so the
// runtime ratchet in envUtils.js cannot import them; tests/secureClientEnv.test.js checks
// that this copy and the build-time copy agree, so a flag added to one and not the other
// fails a test rather than silently going unprotected.
//
// Deliberately imports nothing: envUtils.js is imported by configUtils.js and much else,
// so anything this module pulled in would sit at the very bottom of the import graph.

// Settings the secure build forces to "false" at compile time. In that build a runtime
// override (window.__SITREC_ENV__) may set one of these to "false" but to nothing else.
export const SECURE_SECURITY_FLAGS = [
    "CHATBOT_ENABLED",
    "SITREC_TRACK_STATS",
    "LOG_UI_INTERACTIONS",
    "SITREC_ENABLE_DEFAULT_MAP_SOURCES",
    "SITREC_ENABLE_DEFAULT_ELEVATION_SOURCES",
    "SITREC_ENABLE_DEFAULT_TLE_SOURCES",
    "USE_S3_PRESIGNED_URLS",
];

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

// A key whose value is a credential. Same rule as the build-time env builders: the
// explicit list above, or a TOKEN / SECRET / PASSWORD / ACCESS_KEY / API_KEY / API
// component in the name.
export function isSensitiveEnvKey(key) {
    if (!key) {
        return false;
    }

    if (EXPLICIT_SENSITIVE_KEYS.has(key)) {
        return true;
    }

    return /(^|_)(TOKEN|SECRET|PASSWORD|ACCESS_KEY|API_KEY|API)(_|$)/i.test(key);
}
