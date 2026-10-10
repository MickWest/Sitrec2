// The user's "SITREC_ ENV Override" setting: text in shared.env format, saved with the
// user's settings, whose SITREC_* lines replace the installation's values in this browser.

import {parseEnvText, stripEnvComment} from '../tools/src/envText.js';
import {
    allowOverrideList,
    applyEnvOverride,
    envOverrideAvailable,
    parseAllowOverride,
    readEnvOverride,
} from '../src/EnvOverride';
import {envFlag, getEnv, getEnvBool} from '../src/envUtils';
import {Globals} from '../src/Globals';
import {ENV_OVERRIDE_MAX_LENGTH, sanitizeSettings} from '../src/SettingsManager';
import {soundingXMLLayoutsFromEnv} from '../src/ParseSoundingXML';
import {CUSTOM_WIND_KEY, getWindSources} from '../src/nodes/WindSources';

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
        const {accepted, ignored} = readEnvOverride("SITREC_X=1\nMAPBOX_TOKEN=abc\nSAVE_TO_S3=true\nSITREC_Y=two", "SITREC_*");
        expect(accepted).toEqual({SITREC_X: "1", SITREC_Y: "two"});
        expect(ignored).toEqual([
            {key: "MAPBOX_TOKEN", reason: "notSitrec"},
            {key: "SAVE_TO_S3", reason: "notSitrec"},
        ]);
    });

    test('with no ALLOW_OVERRIDE list, or an empty one, it uses nothing', () => {
        const text = "SITREC_X=1\nSITREC_CUSTOM_SOUNDING_WX_LEVEL_TAG=Level";
        for (const list of [undefined, "", " , ,"]) {
            const {accepted, ignored} = readEnvOverride(text, list);
            expect(accepted).toEqual({});
            expect(ignored).toEqual([
                {key: "SITREC_X", reason: "notAllowed"},
                {key: "SITREC_CUSTOM_SOUNDING_WX_LEVEL_TAG", reason: "notAllowed"},
            ]);
        }
    });

    test('uses only the keys an ALLOW_OVERRIDE pattern matches', () => {
        const {accepted, ignored} = readEnvOverride(
            "SITREC_CUSTOM_SOUNDING_WX_LEVEL_TAG=Level\n"
            + "SITREC_CUSTOM_MAP_X_URL=https://tiles.example.net/{z}/{x}/{y}.png\n"
            + "SITREC_USE_CUSTOM_WIND=true\n"
            + "SITREC_FORUM_ORIGIN=https://forum.example.net",
            "SITREC_CUSTOM_SOUNDING_* , SITREC_USE_CUSTOM_WIND");
        expect(accepted).toEqual({SITREC_CUSTOM_SOUNDING_WX_LEVEL_TAG: "Level", SITREC_USE_CUSTOM_WIND: "true"});
        expect(ignored).toEqual([
            {key: "SITREC_CUSTOM_MAP_X_URL", reason: "notAllowed"},
            {key: "SITREC_FORUM_ORIGIN", reason: "notAllowed"},
        ]);
    });
});

describe('parseAllowOverride', () => {
    const allows = (list, key) => parseAllowOverride(list).some(pattern => pattern.test(key));

    test('a pattern must match the whole key', () => {
        expect(allows("SITREC_USE_CUSTOM_WIND", "SITREC_USE_CUSTOM_WIND")).toBe(true);
        expect(allows("SITREC_USE_CUSTOM_WIND", "SITREC_USE_CUSTOM_WIND_X")).toBe(false);
        expect(allows("SITREC_USE_CUSTOM", "SITREC_USE_CUSTOM_WIND")).toBe(false);
        expect(allows("USE_CUSTOM_WIND", "SITREC_USE_CUSTOM_WIND")).toBe(false);
    });

    test('* matches any characters, none included, anywhere in the pattern', () => {
        expect(allows("SITREC_*", "SITREC_ANYTHING_AT_ALL")).toBe(true);
        expect(allows("SITREC_CUSTOM_SOUNDING_*", "SITREC_CUSTOM_SOUNDING_")).toBe(true);
        expect(allows("SITREC_CUSTOM_*_NAME", "SITREC_CUSTOM_MAP_X_NAME")).toBe(true);
        expect(allows("SITREC_CUSTOM_*_NAME", "SITREC_CUSTOM_MAP_X_URL")).toBe(false);
        expect(allows("*", "SITREC_X")).toBe(true);
    });

    test('other characters are literal, and spaces around an entry are ignored', () => {
        expect(allows("SITREC_.X", "SITREC_AX")).toBe(false);
        expect(allows("  SITREC_A ,SITREC_B  ", "SITREC_B")).toBe(true);
        expect(parseAllowOverride("SITREC_A, ,SITREC_B,")).toHaveLength(2);
        expect(parseAllowOverride(undefined)).toEqual([]);
    });
});

describe('applyEnvOverride', () => {
    const savedEnv = Globals.env;
    const INSTALLATION = {
        ALLOW_OVERRIDE: "SITREC_*",
        SITREC_USE_CUSTOM_WIND: "",         // PHP's form of false
        SITREC_CUSTOM_WIND_MENU_NAME: "Site Wind",
        UPLOAD: "/u/",
    };
    beforeEach(() => {
        Globals.env = {...INSTALLATION};
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
        expect(Globals.env.SITREC_USE_CUSTOM_WIND).toBe("");   // the installation's value is back
        expect(Globals.env.SITREC_NEW).toBe("2");
        expect(getEnv("SITREC_USE_CUSTOM_WIND", "false")).toBe("false");

        applyEnvOverride("");
        expect(Globals.env).toEqual(INSTALLATION);
        expect(getEnv("SITREC_NEW", undefined)).toBeUndefined();
    });

    test('a name that is not SITREC_ changes nothing', () => {
        const {ignored} = applyEnvOverride("UPLOAD=/elsewhere/\nCHATBOT_ENABLED=true");
        expect(ignored.map(entry => entry.key)).toEqual(["UPLOAD", "CHATBOT_ENABLED"]);
        expect(Globals.env.UPLOAD).toBe("/u/");
        expect(getEnv("CHATBOT_ENABLED", "false")).toBe("false");
    });

    test('ALLOW_OVERRIDE itself cannot be changed by the user', () => {
        Globals.env.ALLOW_OVERRIDE = "SITREC_CUSTOM_SOUNDING_*";
        const {accepted, ignored} = applyEnvOverride("ALLOW_OVERRIDE=*\nSITREC_USE_CUSTOM_WIND=true");
        expect(ignored).toEqual([
            {key: "ALLOW_OVERRIDE", reason: "notSitrec"},
            {key: "SITREC_USE_CUSTOM_WIND", reason: "notAllowed"},
        ]);
        expect(accepted).toEqual({});
        expect(Globals.env.ALLOW_OVERRIDE).toBe("SITREC_CUSTOM_SOUNDING_*");
        expect(allowOverrideList()).toBe("SITREC_CUSTOM_SOUNDING_*");
        expect(getEnv("ALLOW_OVERRIDE", "SITREC_CUSTOM_SOUNDING_*")).toBe("SITREC_CUSTOM_SOUNDING_*");
        // Even a list that allows every key cannot take it: it is not a SITREC_ key.
        Globals.env.ALLOW_OVERRIDE = "*";
        expect(applyEnvOverride("ALLOW_OVERRIDE=").ignored).toEqual([{key: "ALLOW_OVERRIDE", reason: "notSitrec"}]);
        expect(allowOverrideList()).toBe("*");
    });

    test('with no ALLOW_OVERRIDE the stored text is kept but nothing is used, and the menu entry is not offered', () => {
        delete Globals.env.ALLOW_OVERRIDE;
        expect(envOverrideAvailable()).toBe(false);
        const {accepted, ignored} = applyEnvOverride("SITREC_USE_CUSTOM_WIND=true");
        expect(accepted).toEqual({});
        expect(ignored).toEqual([{key: "SITREC_USE_CUSTOM_WIND", reason: "notAllowed"}]);
        expect(Globals.env.SITREC_USE_CUSTOM_WIND).toBe("");
        expect(getEnv("SITREC_USE_CUSTOM_WIND", "false")).toBe("false");

        Globals.env.ALLOW_OVERRIDE = "";
        expect(envOverrideAvailable()).toBe(false);
        Globals.env.ALLOW_OVERRIDE = "SITREC_CUSTOM_SOUNDING_*";
        expect(envOverrideAvailable()).toBe(true);
    });

    test('an override to "false" turns a Globals.env flag off', () => {
        Globals.env.SITREC_USE_CUSTOM_WIND = "1";    // PHP's form of true
        expect(getWindSources().some(source => source.key === CUSTOM_WIND_KEY)).toBe(true);
        applyEnvOverride("SITREC_USE_CUSTOM_WIND=false");
        expect(Globals.env.SITREC_USE_CUSTOM_WIND).toBe("false");
        expect(envFlag(Globals.env.SITREC_USE_CUSTOM_WIND)).toBe(false);
        expect(getWindSources().some(source => source.key === CUSTOM_WIND_KEY)).toBe(false);
        applyEnvOverride("SITREC_USE_CUSTOM_WIND=true");
        expect(getWindSources().some(source => source.key === CUSTOM_WIND_KEY)).toBe(true);
    });
});

describe('envFlag: a Globals.env flag as a boolean', () => {
    test('off for a missing value, "", "0" and "false" in any case', () => {
        for (const value of [undefined, null, "", "0", " 0\r", "false", "FALSE", "False", " false ", "false\r"]) {
            expect([value, envFlag(value)]).toEqual([value, false]);
        }
    });

    test('on for PHP\'s "1" and for "true"', () => {
        for (const value of ["1", "true", "TRUE", " true\r\n"]) {
            expect([value, envFlag(value)]).toEqual([value, true]);
        }
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

    // Globals.env as PHP sends it: a false flag is "" (putenv of false), and a flag the
    // installation did not set is absent.
    test('it cannot turn on a security flag or supply a credential, whatever the installation sent', () => {
        const {applyEnvOverride: apply, getEnv: get, envFlag: flag, Globals: globals} = loadSecure();
        for (const installation of [
            {SITREC_ENABLE_DEFAULT_MAP_SOURCES: "", SITREC_ENABLE_DEFAULT_TLE_SOURCES: ""},
            {},
        ]) {
            globals.env = {ALLOW_OVERRIDE: "SITREC_*", ...installation};

            const {accepted, ignored} = apply("SITREC_ENABLE_DEFAULT_MAP_SOURCES=true\n"
                + "SITREC_ENABLE_DEFAULT_TLE_SOURCES=true\n"
                + "SITREC_TRACK_STATS=1\n"
                + "SITREC_SOME_API_KEY=secret\n"
                + "SITREC_CUSTOM_SOUNDING_WX_LEVEL_TAG=Level");

            expect(ignored).toEqual([
                {key: "SITREC_ENABLE_DEFAULT_MAP_SOURCES", reason: "secureBuild"},
                {key: "SITREC_ENABLE_DEFAULT_TLE_SOURCES", reason: "secureBuild"},
                {key: "SITREC_TRACK_STATS", reason: "secureBuild"},
                {key: "SITREC_SOME_API_KEY", reason: "secureBuild"},
            ]);
            expect(accepted).toEqual({SITREC_CUSTOM_SOUNDING_WX_LEVEL_TAG: "Level"});

            // The satellite load menus read this flag from Globals.env.
            expect(flag(globals.env.SITREC_ENABLE_DEFAULT_TLE_SOURCES)).toBe(false);
            expect(get("SITREC_ENABLE_DEFAULT_MAP_SOURCES", "false")).toBe("false");
            expect(get("SITREC_SOME_API_KEY", "")).toBe("");
            expect(globals.env.SITREC_CUSTOM_SOUNDING_WX_LEVEL_TAG).toBe("Level");
            apply("");
        }
    });

    test('it can set a security flag to "false"', () => {
        const {applyEnvOverride: apply, getEnv: get, envFlag: flag, Globals: globals} = loadSecure();
        globals.env = {ALLOW_OVERRIDE: "SITREC_*", SITREC_ENABLE_DEFAULT_TLE_SOURCES: "1"};
        const {accepted, ignored} = apply("SITREC_ENABLE_DEFAULT_TLE_SOURCES=false");
        expect(ignored).toEqual([]);
        expect(accepted).toEqual({SITREC_ENABLE_DEFAULT_TLE_SOURCES: "false"});
        expect(flag(globals.env.SITREC_ENABLE_DEFAULT_TLE_SOURCES)).toBe(false);
        expect(get("SITREC_ENABLE_DEFAULT_TLE_SOURCES", "false")).toBe("false");
        apply("");
    });

    test('the ALLOW_OVERRIDE list applies first', () => {
        const {applyEnvOverride: apply, Globals: globals} = loadSecure();
        globals.env = {ALLOW_OVERRIDE: "SITREC_CUSTOM_SOUNDING_*"};
        const {accepted, ignored} = apply("SITREC_CUSTOM_MAP_X_URL=https://tiles.example.net/{z}/{x}/{y}.png\n"
            + "SITREC_ENABLE_DEFAULT_MAP_SOURCES=false\n"
            + "SITREC_CUSTOM_SOUNDING_WX_LEVEL_TAG=Level");
        expect(ignored).toEqual([
            {key: "SITREC_CUSTOM_MAP_X_URL", reason: "notAllowed"},
            {key: "SITREC_ENABLE_DEFAULT_MAP_SOURCES", reason: "notAllowed"},
        ]);
        expect(accepted).toEqual({SITREC_CUSTOM_SOUNDING_WX_LEVEL_TAG: "Level"});
        expect(globals.env.SITREC_CUSTOM_MAP_X_URL).toBeUndefined();
        apply("");
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
