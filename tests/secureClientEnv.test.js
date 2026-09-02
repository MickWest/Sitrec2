const {
    SECURE_FORCED_VALUES,
    SECURE_SECURITY_FLAGS,
    buildSecureClientEnv,
    buildWebpackDefineEnv,
    isClientVisibleKey,
    isSensitiveEnvKey,
    loadClientVarNames,
} = require("../scripts/secureClientEnv");
const serverless = require("../scripts/serverlessClientEnv");
const secureFlags = require("../src/secureFlags");

describe("buildSecureClientEnv", () => {
    test("keeps benign settings but blanks secrets and forces the outbound features off", () => {
        const env = buildSecureClientEnv({
            exampleEnv: {
                BANNER_ACTIVE: "true",
                CHATBOT_ENABLED: "true",
                DEFAULT_MAP_TYPE: "MapBox",
                SITREC_ENABLE_DEFAULT_TLE_SOURCES: "true",
            },
            liveEnv: {
                LOCALHOST: "local.metabunk.org",
                MAPBOX_TOKEN: "pk.1234567890ABCDEFGHIJKLMN",
                MAPTILER_KEY: "abcdefghijklmnopqrstuv",
                S3_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
                SOME_SERVICE_PASSWORD: "hunter2",
                SITREC_TRACK_STATS: "true",
                LOG_UI_INTERACTIONS: "true",
                SITREC_ENABLE_DEFAULT_MAP_SOURCES: "true",
                SITREC_ENABLE_DEFAULT_ELEVATION_SOURCES: "true",
                USE_S3_PRESIGNED_URLS: "true",
                SAVE_TO_SERVER: "true",
                SAVE_TO_S3: "true",
                SETTINGS_SERVER_ENABLED: "true",
            },
        });

        // benign values survive, the live file overriding the example
        expect(env.BANNER_ACTIVE).toBe("true");
        expect(env.DEFAULT_MAP_TYPE).toBe("MapBox");
        expect(env.LOCALHOST).toBe("local.metabunk.org");

        // client-visible secrets are blanked, by the explicit list and by the name rule
        expect(env.MAPBOX_TOKEN).toBe("");
        expect(env.MAPTILER_KEY).toBe("");
        // server-only keys are not embedded at all, blanked or not: they are absent from
        // the entrypoint's CLIENT_VARS, so they never reach the page
        expect(env.S3_SECRET_ACCESS_KEY).toBeUndefined();
        expect(env.SOME_SERVICE_PASSWORD).toBeUndefined();

        // every security flag is forced off, whatever either file said
        for (const flag of SECURE_SECURITY_FLAGS) {
            expect([flag, env[flag]]).toEqual([flag, "false"]);
        }
        expect(env.IS_SECURE_BUILD).toBe("true");

        // the secure deployment saves through its own server: these are NOT forced
        expect(env.SAVE_TO_SERVER).toBe("true");
        expect(env.SAVE_TO_S3).toBe("true");
        expect(env.SETTINGS_SERVER_ENABLED).toBe("true");
    });

    test("forces the flags even when neither file mentions them", () => {
        const env = buildSecureClientEnv({ exampleEnv: {}, liveEnv: {} });
        expect(env).toEqual(SECURE_FORCED_VALUES);
    });

    test("embeds only the settings the container entrypoint forwards to the page", () => {
        const names = loadClientVarNames();
        expect(names.has("DEFAULT_MAP_TYPE")).toBe(true);
        expect(names.has("SAVE_TO_S3")).toBe(true);
        expect(names.has("XENFORO_PATH")).toBe(false);
        expect(names.has("S3_SECRET_ACCESS_KEY")).toBe(false);

        expect(isClientVisibleKey("SITREC_CUSTOM_MAP_INTERNAL_URL", names)).toBe(true);
        expect(isClientVisibleKey("SITREC_CUSTOM_ELEVATION_X_MAX_ZOOM", names)).toBe(true);
        expect(isClientVisibleKey("CUSTOM_WIND_URL", names)).toBe(false);

        const env = buildSecureClientEnv({
            exampleEnv: {
                DEFAULT_MAP_TYPE: "ESRI",
                XENFORO_PATH: "/srv/forum/",
                CUSTOM_WIND_URL: "https://wx.example.com/{date}.grib2",
                SITREC_FORUM_ORIGIN: "https://forum.example.com",
                SITREC_CUSTOM_MAP_INTERNAL_URL: "https://tiles.internal/{z}/{x}/{y}.jpg",
            },
            liveEnv: {},
        });
        expect(env.DEFAULT_MAP_TYPE).toBe("ESRI");
        expect(env.SITREC_CUSTOM_MAP_INTERNAL_URL).toBe("https://tiles.internal/{z}/{x}/{y}.jpg");
        expect(env.XENFORO_PATH).toBeUndefined();
        expect(env.CUSTOM_WIND_URL).toBeUndefined();
        expect(env.SITREC_FORUM_ORIGIN).toBeUndefined();

        // the parser refuses a file without the block, so a renamed block fails the build
        expect(() => loadClientVarNames("#!/bin/bash\nSERVER_VARS=\"\nX\n\"\n")).toThrow(/CLIENT_VARS/);
        expect(loadClientVarNames("CLIENT_VARS=\"\nA\n# comment\nB\n\"\n")).toEqual(new Set(["A", "B"]));
    });

    test("the forced values are exactly the security flags at \"false\" plus IS_SECURE_BUILD", () => {
        const expected = { IS_SECURE_BUILD: "true" };
        for (const flag of SECURE_SECURITY_FLAGS) expected[flag] = "false";
        expect(SECURE_FORCED_VALUES).toEqual(expected);
    });

    test("names the settings the task requires", () => {
        expect(SECURE_SECURITY_FLAGS).toEqual(expect.arrayContaining([
            "CHATBOT_ENABLED",
            "SITREC_TRACK_STATS",
            "LOG_UI_INTERACTIONS",
            "SITREC_ENABLE_DEFAULT_MAP_SOURCES",
            "SITREC_ENABLE_DEFAULT_ELEVATION_SOURCES",
            "SITREC_ENABLE_DEFAULT_TLE_SOURCES",
            "USE_S3_PRESIGNED_URLS",
        ]));
    });

    test("converts env values into DefinePlugin mappings", () => {
        expect(buildWebpackDefineEnv({
            IS_SECURE_BUILD: "true",
            CHATBOT_ENABLED: "false",
        })).toEqual({
            "process.env.IS_SECURE_BUILD": JSON.stringify("true"),
            "process.env.CHATBOT_ENABLED": JSON.stringify("false"),
        });
    });
});

// scripts/ is not bundled, so src/secureFlags.js carries a copy of the flag list and the
// sensitivity rule for the runtime ratchet in src/envUtils.js. These tests are what keeps
// the copy honest: a flag or a sensitive-key rule added on one side and not the other
// fails here instead of shipping half-protected.
describe("src/secureFlags.js mirrors the build-time definitions", () => {
    test("the security flag lists are identical", () => {
        expect(secureFlags.SECURE_SECURITY_FLAGS).toEqual(SECURE_SECURITY_FLAGS);
    });

    test("the sensitivity rule is the serverless one, on both sides", () => {
        expect(isSensitiveEnvKey).toBe(serverless.isSensitiveEnvKey);

        const probes = [
            "MAPBOX_TOKEN", "MAPTILER_KEY", "GOOGLE_MAPS_API_KEY", "CESIUM_ION_TOKEN",
            "OPENAI_API", "ANTHROPIC_API", "GROQ_API", "GROK_API",
            "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY",
            "SOME_PASSWORD", "MY_SECRET", "X_ACCESS_KEY", "FOO_API_KEY", "TOKEN", "API_THING",
            "BANNER_ACTIVE", "DEFAULT_MAP_TYPE", "LOCALHOST", "SITREC_TRACK_STATS",
            "APIARY", "TOKENIZER_MODE", "", undefined,
        ];
        for (const key of probes) {
            expect([key, secureFlags.isSensitiveEnvKey(key)]).toEqual([key, serverless.isSensitiveEnvKey(key)]);
        }
        // and the rule does what the ratchet relies on
        expect(secureFlags.isSensitiveEnvKey("MAPBOX_TOKEN")).toBe(true);
        expect(secureFlags.isSensitiveEnvKey("SOME_PASSWORD")).toBe(true);
        expect(secureFlags.isSensitiveEnvKey("DEFAULT_MAP_TYPE")).toBe(false);
    });
});
