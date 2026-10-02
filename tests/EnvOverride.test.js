// The user's "SITREC_ ENV Override" setting: text in shared.env format, saved with the
// user's settings, whose SITREC_* lines replace the installation's values in this browser.

import {parseEnvText, stripEnvComment} from '../tools/src/envText.js';
import {applyEnvOverride, readEnvOverride} from '../src/EnvOverride';
import {getEnv, getEnvBool} from '../src/envUtils';
import {Globals} from '../src/Globals';
import {ENV_OVERRIDE_MAX_LENGTH, sanitizeSettings} from '../src/SettingsManager';
import {soundingXMLLayoutsFromEnv} from '../src/ParseSoundingXML';

const {parseEnv, stripComment} = require('../scripts/envFile.js');

// Lines in every form the shared.env rule distinguishes.
const SAMPLE = [
    '# a comment line',
    '',
    'SITREC_A=1  # note',
    'SITREC_COLOR="#FFFFFF"',
    'SITREC_URL=https://host/page#top',
    "SITREC_TEXT=It's ready # note",
    "SITREC_SINGLE='one # two'",
    'SITREC_LINES="a\\nb"',
    'SITREC_EMPTY=',
    '  SITREC_SPACED  =  padded value  ',
    'SITREC_QUOTED_THEN_COMMENT="x y"   # why',
    'not a setting line',
    'SITREC_A=2',
    'SITREC_UNCLOSED="never closed # kept',
    'SITREC_EQUALS=a=b=c',
].join('\r\n');

describe('parseEnvText (the browser reader of shared.env text)', () => {
    test('reads text exactly as the build reads shared.env', () => {
        expect(parseEnvText(SAMPLE)).toEqual(parseEnv(SAMPLE));
        for (const line of SAMPLE.split('\r\n')) {
            expect(stripEnvComment(line)).toBe(stripComment(line));
        }
    });

    test('the values, spelled out', () => {
        expect(parseEnvText(SAMPLE)).toMatchObject({
            SITREC_A: "2",                      // the later line wins
            SITREC_COLOR: "#FFFFFF",
            SITREC_URL: "https://host/page#top",
            SITREC_TEXT: "It's ready",
            SITREC_SINGLE: "one # two",
            SITREC_LINES: "a\nb",
            SITREC_EMPTY: "",
            SITREC_SPACED: "padded value",
            SITREC_QUOTED_THEN_COMMENT: "x y",
            SITREC_EQUALS: "a=b=c",
        });
        expect(parseEnvText("")).toEqual({});
        expect(parseEnvText(undefined)).toEqual({});
    });
});

describe('readEnvOverride', () => {
    test('uses SITREC_ names only, and says which lines it left out', () => {
        const {accepted, ignored} = readEnvOverride("SITREC_X=1\nMAPBOX_TOKEN=abc\nSAVE_TO_S3=true\nSITREC_Y=two");
        expect(accepted).toEqual({SITREC_X: "1", SITREC_Y: "two"});
        expect(ignored).toEqual([
            {key: "MAPBOX_TOKEN", reason: "notSitrec"},
            {key: "SAVE_TO_S3", reason: "notSitrec"},
        ]);
    });
});

describe('applyEnvOverride', () => {
    const savedEnv = Globals.env;
    beforeEach(() => {
        Globals.env = {SITREC_USE_CUSTOM_WIND: "false", SITREC_CUSTOM_WIND_MENU_NAME: "Site Wind", UPLOAD: "/u/"};
    });
    afterEach(() => {
        applyEnvOverride("");
        Globals.env = savedEnv;
    });

    test('replaces a value for both kinds of reader', () => {
        applyEnvOverride('SITREC_USE_CUSTOM_WIND=true\nSITREC_CUSTOM_WIND_MENU_NAME="My Wind"');
        // Globals.env readers
        expect(Globals.env.SITREC_USE_CUSTOM_WIND).toBe("true");
        expect(Globals.env.SITREC_CUSTOM_WIND_MENU_NAME).toBe("My Wind");
        // getEnv readers, whatever build-time value they pass
        expect(getEnvBool("SITREC_USE_CUSTOM_WIND", "false")).toBe(true);
        expect(getEnv("SITREC_CUSTOM_WIND_MENU_NAME", "Site Wind")).toBe("My Wind");
        // nothing else is touched
        expect(Globals.env.UPLOAD).toBe("/u/");
        expect(getEnv("SITREC_OTHER", "built")).toBe("built");
    });

    test('adds a setting the installation did not have', () => {
        applyEnvOverride("SITREC_CUSTOM_SOUNDING_WX_LEVEL_TAG=Level\n"
            + "SITREC_CUSTOM_SOUNDING_WX_ALT_TAG=Altitude\n"
            + "SITREC_CUSTOM_SOUNDING_WX_WIND_DIR_TAG=WindDirection\n"
            + "SITREC_CUSTOM_SOUNDING_WX_WIND_SPEED_TAG=WindSpeed\n"
            + "SITREC_CUSTOM_SOUNDING_WX_ALT_UNITS=ft");
        const layouts = soundingXMLLayoutsFromEnv(Globals.env);
        expect(layouts).toHaveLength(1);
        expect(layouts[0].altToM).toBeCloseTo(0.3048);
    });

    test('an empty value overrides to empty, as it would in shared.env', () => {
        applyEnvOverride("SITREC_CUSTOM_WIND_MENU_NAME=");
        expect(Globals.env.SITREC_CUSTOM_WIND_MENU_NAME).toBe("");
        expect(getEnv("SITREC_CUSTOM_WIND_MENU_NAME", "Site Wind")).toBe("");
    });

    test('a line taken out of the text stops overriding', () => {
        applyEnvOverride("SITREC_USE_CUSTOM_WIND=true\nSITREC_NEW=1");
        applyEnvOverride("SITREC_NEW=2");
        expect(Globals.env.SITREC_USE_CUSTOM_WIND).toBe("false");   // the installation's value is back
        expect(Globals.env.SITREC_NEW).toBe("2");
        expect(getEnv("SITREC_USE_CUSTOM_WIND", "false")).toBe("false");

        applyEnvOverride("");
        expect(Globals.env).toEqual({SITREC_USE_CUSTOM_WIND: "false", SITREC_CUSTOM_WIND_MENU_NAME: "Site Wind", UPLOAD: "/u/"});
        expect(getEnv("SITREC_NEW", undefined)).toBeUndefined();
    });

    test('a name that is not SITREC_ changes nothing', () => {
        const {ignored} = applyEnvOverride("UPLOAD=/elsewhere/\nCHATBOT_ENABLED=true");
        expect(ignored.map(entry => entry.key)).toEqual(["UPLOAD", "CHATBOT_ENABLED"]);
        expect(Globals.env.UPLOAD).toBe("/u/");
        expect(getEnv("CHATBOT_ENABLED", "false")).toBe("false");
    });
});

describe('the secure build holds a user override to the runtime rule', () => {
    const ORIGINAL_FLAG = process.env.IS_SECURE_BUILD;
    afterEach(() => {
        if (ORIGINAL_FLAG === undefined) delete process.env.IS_SECURE_BUILD;
        else process.env.IS_SECURE_BUILD = ORIGINAL_FLAG;
    });

    function loadSecure() {
        let modules;
        jest.isolateModules(() => {
            process.env.IS_SECURE_BUILD = "true";
            modules = {
                ...require("../src/EnvOverride"),
                ...require("../src/envUtils"),
                Globals: require("../src/Globals").Globals,
            };
        });
        return modules;
    }

    test('it cannot loosen a security flag or supply a credential, but can tighten and can set a plain value', () => {
        const {applyEnvOverride: apply, getEnv: get, Globals: globals} = loadSecure();
        globals.env = {SITREC_ENABLE_DEFAULT_MAP_SOURCES: "false", SITREC_ENABLE_DEFAULT_TLE_SOURCES: "true"};

        const {accepted, ignored} = apply("SITREC_ENABLE_DEFAULT_MAP_SOURCES=true\n"
            + "SITREC_ENABLE_DEFAULT_TLE_SOURCES=false\n"
            + "SITREC_SOME_API_KEY=secret\n"
            + "SITREC_CUSTOM_SOUNDING_WX_LEVEL_TAG=Level");

        expect(ignored).toEqual([
            {key: "SITREC_ENABLE_DEFAULT_MAP_SOURCES", reason: "secureBuild"},
            {key: "SITREC_SOME_API_KEY", reason: "secureBuild"},
        ]);
        expect(Object.keys(accepted)).toEqual(["SITREC_ENABLE_DEFAULT_TLE_SOURCES", "SITREC_CUSTOM_SOUNDING_WX_LEVEL_TAG"]);

        expect(globals.env.SITREC_ENABLE_DEFAULT_MAP_SOURCES).toBe("false");
        expect(get("SITREC_ENABLE_DEFAULT_MAP_SOURCES", "false")).toBe("false");
        expect(get("SITREC_SOME_API_KEY", "")).toBe("");
        expect(globals.env.SITREC_ENABLE_DEFAULT_TLE_SOURCES).toBe("false");
        expect(globals.env.SITREC_CUSTOM_SOUNDING_WX_LEVEL_TAG).toBe("Level");
    });
});

describe('sanitizeSettings: envOverride', () => {
    test('keeps the text as typed', () => {
        const text = "# mine\nSITREC_X=1\n";
        expect(sanitizeSettings({envOverride: text}).envOverride).toBe(text);
        expect(sanitizeSettings({envOverride: ""}).envOverride).toBe("");
    });

    test('drops a value that is not text, or is too long', () => {
        expect(sanitizeSettings({envOverride: 5}).envOverride).toBeUndefined();
        expect(sanitizeSettings({envOverride: {a: 1}}).envOverride).toBeUndefined();
        expect(sanitizeSettings({envOverride: "x".repeat(ENV_OVERRIDE_MAX_LENGTH)}).envOverride).toHaveLength(ENV_OVERRIDE_MAX_LENGTH);
        expect(sanitizeSettings({envOverride: "x".repeat(ENV_OVERRIDE_MAX_LENGTH + 1)}).envOverride).toBeUndefined();
    });
});
