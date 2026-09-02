// The secure build's runtime-override ratchet in src/envUtils.js.
//
// getEnv() reads window.__SITREC_ENV__ (injected by the container entrypoint) before the
// compile-time value. In the secure build that override may only tighten: a security flag
// the build forced to "false" cannot be set to anything else, and a credential can never
// be put back. In every other build getEnv is unchanged - the last block proves it.
//
// isSecureBuild is read from process.env.IS_SECURE_BUILD when the module loads, so each
// block sets the variable and then imports a fresh copy of the module.

function loadEnvUtils({ secure }) {
    let mod;
    jest.isolateModules(() => {
        if (secure) {
            process.env.IS_SECURE_BUILD = "true";
        } else {
            delete process.env.IS_SECURE_BUILD;
        }
        mod = require("../src/envUtils");
    });
    return mod;
}

const ORIGINAL_FLAG = process.env.IS_SECURE_BUILD;

afterEach(() => {
    delete global.window;
    if (ORIGINAL_FLAG === undefined) {
        delete process.env.IS_SECURE_BUILD;
    } else {
        process.env.IS_SECURE_BUILD = ORIGINAL_FLAG;
    }
});

describe("secure build: runtime overrides can only tighten", () => {
    test("tightening applies: a flag built \"true\" can be set to \"false\" at runtime", () => {
        const { getEnv, getEnvBool } = loadEnvUtils({ secure: true });
        global.window = { __SITREC_ENV__: { CHATBOT_ENABLED: "false" } };
        expect(getEnv("CHATBOT_ENABLED", "true")).toBe("false");
        expect(getEnvBool("CHATBOT_ENABLED", "true")).toBe(false);
    });

    test("loosening is ignored: a flag built \"false\" stays \"false\" whatever the runtime says", () => {
        const { getEnv, getEnvBool } = loadEnvUtils({ secure: true });
        for (const attempt of ["true", "TRUE", "1", "yes", "", "true\r\n"]) {
            global.window = { __SITREC_ENV__: { SITREC_ENABLE_DEFAULT_MAP_SOURCES: attempt } };
            expect([attempt, getEnv("SITREC_ENABLE_DEFAULT_MAP_SOURCES", "false")]).toEqual([attempt, "false"]);
            expect(getEnvBool("SITREC_ENABLE_DEFAULT_MAP_SOURCES", "false")).toBe(false);
        }
    });

    test("every security flag is ratcheted, and \"false\" at runtime is still accepted", () => {
        const { getEnv } = loadEnvUtils({ secure: true });
        const { SECURE_SECURITY_FLAGS } = require("../src/secureFlags");
        for (const flag of SECURE_SECURITY_FLAGS) {
            global.window = { __SITREC_ENV__: { [flag]: "true" } };
            expect([flag, getEnv(flag, "false")]).toEqual([flag, "false"]);
            global.window = { __SITREC_ENV__: { [flag]: "false\r" } };
            expect([flag, getEnv(flag, "false")]).toEqual([flag, "false"]);
        }
    });

    test("the ratchet only holds a \"false\" build value: a flag built undefined is overridable as before", () => {
        // The build forces every flag to "false", so this branch never runs in the real
        // artifact; it documents that the ratchet is about the build value, not the name.
        const { getEnv } = loadEnvUtils({ secure: true });
        global.window = { __SITREC_ENV__: { CHATBOT_ENABLED: "true" } };
        expect(getEnv("CHATBOT_ENABLED", undefined)).toBe("true");
    });

    test("sensitive runtime keys are ignored entirely, whatever the build value", () => {
        const { getEnv } = loadEnvUtils({ secure: true });
        global.window = {
            __SITREC_ENV__: {
                MAPBOX_TOKEN: "pk.eyJ-runtime-token",
                MAPTILER_KEY: "runtimekey",
                SOME_SERVICE_PASSWORD: "hunter2",
                CUSTOM_API_KEY: "abc",
                S3_SECRET_ACCESS_KEY: "def",
            },
        };
        expect(getEnv("MAPBOX_TOKEN", "")).toBe("");
        expect(getEnv("MAPTILER_KEY", "")).toBe("");
        expect(getEnv("SOME_SERVICE_PASSWORD", undefined)).toBeUndefined();
        expect(getEnv("CUSTOM_API_KEY", "")).toBe("");
        expect(getEnv("S3_SECRET_ACCESS_KEY", "build")).toBe("build");
    });

    test("every other key is overridable as before, with the CR stripped", () => {
        const { getEnv } = loadEnvUtils({ secure: true });
        global.window = { __SITREC_ENV__: { DEFAULT_MAP_TYPE: "CustomMap_Mirror\r\n", SITREC_TERRAIN_URL: "./sitrec-terrain/" } };
        expect(getEnv("DEFAULT_MAP_TYPE", "MapBox")).toBe("CustomMap_Mirror");
        expect(getEnv("SITREC_TERRAIN_URL", "../sitrec-terrain/")).toBe("./sitrec-terrain/");
    });

    test("no runtime value: the build value is returned, CR-stripped", () => {
        const { getEnv } = loadEnvUtils({ secure: true });
        expect(getEnv("CHATBOT_ENABLED", "false\r")).toBe("false");
        expect(getEnv("MISSING")).toBeUndefined();
    });
});

describe("every other build: getEnv is unchanged", () => {
    test("loosening applies when the secure flag is unset", () => {
        const { getEnv, getEnvBool } = loadEnvUtils({ secure: false });
        global.window = { __SITREC_ENV__: { CHATBOT_ENABLED: "true", SITREC_ENABLE_DEFAULT_MAP_SOURCES: "true" } };
        expect(getEnv("CHATBOT_ENABLED", "false")).toBe("true");
        expect(getEnvBool("SITREC_ENABLE_DEFAULT_MAP_SOURCES", "false")).toBe(true);
    });

    test("sensitive runtime keys apply when the secure flag is unset (the container use case)", () => {
        const { getEnv } = loadEnvUtils({ secure: false });
        global.window = { __SITREC_ENV__: { MAPBOX_TOKEN: "pk.runtime\r" } };
        expect(getEnv("MAPBOX_TOKEN", "")).toBe("pk.runtime");
    });

    test("a value other than \"true\" does not turn the ratchet on", () => {
        let mod;
        jest.isolateModules(() => {
            process.env.IS_SECURE_BUILD = "false";
            mod = require("../src/envUtils");
        });
        global.window = { __SITREC_ENV__: { CHATBOT_ENABLED: "true" } };
        expect(mod.getEnv("CHATBOT_ENABLED", "false")).toBe("true");
    });
});
