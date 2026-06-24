const { getEnv, getEnvBool, getEnvNumber } = require("../src/envUtils");

// Regression tests for the CRLF env-file bug: a Windows (CRLF) env file passed
// via docker-compose `env_file:` (or read at build time by dotenv-webpack) can
// leave a trailing \r on a value. getEnv() must strip that trailing line-ending,
// otherwise exact-string checks downstream silently break (getEnvBool("true\r")
// !== true, map/elevation-type key lookups miss and fall back to defaults).

describe("getEnv trailing CR/newline stripping", () => {
    afterEach(() => {
        delete global.window;
    });

    test("strips a trailing CR from the build-time fallback value", () => {
        expect(getEnv("DOCKER_MAP_TYPE", "CustomMap_OSM\r")).toBe("CustomMap_OSM");
    });

    test("strips a trailing CRLF from a runtime window.__SITREC_ENV__ value", () => {
        global.window = { __SITREC_ENV__: { DEFAULT_MAP_TYPE: "MapBox\r\n" } };
        expect(getEnv("DEFAULT_MAP_TYPE")).toBe("MapBox");
    });

    test("runtime value still wins over the fallback (and is CR-stripped)", () => {
        global.window = { __SITREC_ENV__: { X: "runtime\r" } };
        expect(getEnv("X", "buildtime")).toBe("runtime");
    });

    test("preserves interior characters and legitimate trailing spaces", () => {
        // Only the trailing line-ending is removed — not interior whitespace,
        // not a deliberately trailing space.
        expect(getEnv("NAME", "Custom Map (OSM) ")).toBe("Custom Map (OSM) ");
        expect(getEnv("URL", "https://x/{z}/{x}/{y}.png")).toBe("https://x/{z}/{x}/{y}.png");
    });

    test("leaves a clean value untouched", () => {
        expect(getEnv("DOCKER_MAP_TYPE", "CustomMap_OSM")).toBe("CustomMap_OSM");
    });

    test("returns undefined / non-string fallbacks unchanged", () => {
        expect(getEnv("MISSING")).toBeUndefined();
        expect(getEnv("MISSING", undefined)).toBeUndefined();
    });
});

describe("getEnvBool tolerates a trailing CR (the silent-disable bug)", () => {
    afterEach(() => {
        delete global.window;
    });

    test('"true\\r" is true, not silently false', () => {
        expect(getEnvBool("FLAG", "true\r")).toBe(true);
    });

    test('"false\\r" is false', () => {
        expect(getEnvBool("FLAG", "false\r")).toBe(false);
    });

    test("empty / undefined is false", () => {
        expect(getEnvBool("FLAG", "")).toBe(false);
        expect(getEnvBool("FLAG", undefined)).toBe(false);
    });
});

describe("getEnvNumber tolerates a trailing CR", () => {
    test('"8080\\r" parses as 8080', () => {
        expect(getEnvNumber("PORT", "8080\r", 0)).toBe(8080);
    });
});
