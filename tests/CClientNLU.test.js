jest.mock('../src/Globals', () => ({
    guiMenus: {},
}));

jest.mock('../src/CSitrecAPI', () => ({
    sitrecAPI: {
        call: jest.fn(() => ({success: true, result: {}})),
    },
}));

jest.mock('../src/nodes/CNode3DObject', () => ({
    ModelFiles: {
        'Bell 206': {},
        'F-15': {},
        'F-18': {},
        'MQ-9 Reaper': {},
        'Boeing 737': {},
        'Cessna 172': {},
    },
}));

import {clientNLU} from '../src/CClientNLU';

describe('CClientNLU parsing', () => {
    describe('SET_VALUE patterns', () => {
        test('parses "set vFOV to 4"', () => {
            const result = clientNLU.parse('set vFOV to 4');
            expect(result.intent).toBe('SET_VALUE');
            expect(result.slots.path).toBe('vFOV');
            expect(result.slots.value).toBe(4);
            expect(result.confidence).toBeGreaterThan(0.9);
        });

        test('parses "fov 5"', () => {
            const result = clientNLU.parse('fov 5');
            expect(result.intent).toBe('SET_VALUE');
            expect(result.slots.value).toBe(5);
        });

        test('parses "vfov 10.5"', () => {
            const result = clientNLU.parse('vfov 10.5');
            expect(result.intent).toBe('SET_VALUE');
            expect(result.slots.path).toBe('vFOV');
            expect(result.slots.value).toBe(10.5);
        });

        test('parses "set fov 4"', () => {
            const result = clientNLU.parse('set fov 4');
            expect(result.intent).toBe('SET_VALUE');
            expect(result.slots.path).toBe('vFOV');
            expect(result.slots.value).toBe(4);
        });

        test('parses "field of view 20"', () => {
            const result = clientNLU.parse('field of view 20');
            expect(result.intent).toBe('SET_VALUE');
            expect(result.slots.path).toBe('vFOV');
            expect(result.slots.value).toBe(20);
        });

        test('parses "set fov=1"', () => {
            const result = clientNLU.parse('set fov=1');
            expect(result.intent).toBe('SET_VALUE');
            expect(result.slots.path).toBe('fov');
            expect(result.slots.value).toBe(1);
        });

        test('parses "fov=5"', () => {
            const result = clientNLU.parse('fov=5');
            expect(result.intent).toBe('SET_VALUE');
            expect(result.slots.path).toBe('fov');
            expect(result.slots.value).toBe(5);
        });

        test('parses "vFOV=10.5"', () => {
            const result = clientNLU.parse('vFOV=10.5');
            expect(result.intent).toBe('SET_VALUE');
            expect(result.slots.path).toBe('vFOV');
            expect(result.slots.value).toBe(10.5);
        });
    });

    describe('typo correction', () => {
        test('corrects "est fov 5" to "set fov 5"', () => {
            const result = clientNLU.parse('est fov 5');
            expect(result.intent).toBe('SET_VALUE');
            expect(result.correctedText).toBe('set fov 5');
            expect(result.confidence).toBeLessThan(0.95);
        });

        test('corrects "ste fov 5" to "set fov 5"', () => {
            const result = clientNLU.parse('ste fov 5');
            expect(result.intent).toBe('SET_VALUE');
            expect(result.correctedText).toBe('set fov 5');
        });

        test('corrects "shwo labels" to "show labels"', () => {
            const result = clientNLU.parse('shwo labels');
            expect(result.intent).toBe('TOGGLE_ON');
            expect(result.correctedText).toBe('show labels');
        });

        test('corrects "hdie grid" to "hide grid"', () => {
            const result = clientNLU.parse('hdie grid');
            expect(result.intent).toBe('TOGGLE_OFF');
            expect(result.correctedText).toBe('hide grid');
        });

        test('corrects "paly" to "play"', () => {
            const result = clientNLU.parse('paly');
            expect(result.intent).toBe('PLAY');
            expect(result.correctedText).toBe('play');
        });

        test('corrects "zooom in" to "zoom in"', () => {
            const result = clientNLU.parse('zooom in');
            expect(result.intent).toBe('ZOOM_IN');
            expect(result.correctedText).toBe('zoom in');
        });

        test('no correction for exact match', () => {
            const result = clientNLU.parse('set fov 5');
            expect(result.intent).toBe('SET_VALUE');
            expect(result.correctedText).toBeUndefined();
        });
    });

    describe('TOGGLE patterns', () => {
        test('parses "turn off stars"', () => {
            const result = clientNLU.parse('turn off stars');
            expect(result.intent).toBe('TOGGLE_OFF');
            expect(result.slots.target).toBe('stars');
        });

        test('parses "show labels"', () => {
            const result = clientNLU.parse('show labels');
            expect(result.intent).toBe('TOGGLE_ON');
            expect(result.slots.target).toBe('labels');
        });

        test('parses "hide grid"', () => {
            const result = clientNLU.parse('hide grid');
            expect(result.intent).toBe('TOGGLE_OFF');
            expect(result.slots.target).toBe('grid');
        });

        test('parses "stars off"', () => {
            const result = clientNLU.parse('stars off');
            expect(result.intent).toBe('TOGGLE_OFF');
            expect(result.slots.target).toBe('stars');
        });

        test('parses "terrain on"', () => {
            const result = clientNLU.parse('terrain on');
            expect(result.intent).toBe('TOGGLE_ON');
            expect(result.slots.target).toBe('terrain');
        });

        test('parses "enable labels"', () => {
            const result = clientNLU.parse('enable labels');
            expect(result.intent).toBe('TOGGLE_ON');
            expect(result.slots.target).toBe('labels');
        });
    });

    describe('LOAD_SATELLITES patterns', () => {
        test('parses "load satellites"', () => {
            const result = clientNLU.parse('load satellites');
            expect(result.intent).toBe('LOAD_SATELLITES');
            expect(result.slots.type).toBe('leo');
        });

        test('parses "load sats"', () => {
            const result = clientNLU.parse('load sats');
            expect(result.intent).toBe('LOAD_SATELLITES');
            expect(result.slots.type).toBe('leo');
        });

        test('parses "load starlink"', () => {
            const result = clientNLU.parse('load starlink');
            expect(result.intent).toBe('LOAD_SATELLITES');
            expect(result.slots.type).toBe('starlink');
        });

        test('parses "get leo satellites"', () => {
            const result = clientNLU.parse('get leo satellites');
            expect(result.intent).toBe('LOAD_SATELLITES');
            expect(result.slots.type).toBe('leo');
        });
    });

    describe('AMBIENT_ONLY pattern', () => {
        test('parses "ambient only"', () => {
            const result = clientNLU.parse('ambient only');
            expect(result.intent).toBe('AMBIENT_ONLY');
        });

        test('parses "ambient"', () => {
            const result = clientNLU.parse('ambient');
            expect(result.intent).toBe('AMBIENT_ONLY');
        });
    });

    describe('ZOOM patterns', () => {
        test('parses "zoom in"', () => {
            const result = clientNLU.parse('zoom in');
            expect(result.intent).toBe('ZOOM_IN');
            expect(result.slots.camera).toBe('lookCamera');
        });

        test('parses "zoom out"', () => {
            const result = clientNLU.parse('zoom out');
            expect(result.intent).toBe('ZOOM_OUT');
            expect(result.slots.camera).toBe('lookCamera');
        });

        test('parses "zoom in the look camera"', () => {
            const result = clientNLU.parse('zoom in the look camera');
            expect(result.intent).toBe('ZOOM_IN');
            expect(result.slots.camera).toBe('lookCamera');
        });

        test('parses "zoom out main"', () => {
            const result = clientNLU.parse('zoom out main');
            expect(result.intent).toBe('ZOOM_OUT');
            expect(result.slots.camera).toBe('mainCamera');
        });
    });

    describe('MATH patterns', () => {
        test('parses "2+2"', () => {
            const result = clientNLU.parse('2+2');
            expect(result.intent).toBe('MATH');
            expect(result.slots.expression).toBe('2+2');
            expect(result.slots.result).toBe(4);
        });

        test('parses "what is 10 * 5"', () => {
            const result = clientNLU.parse('what is 10 * 5');
            expect(result.intent).toBe('MATH');
            expect(result.slots.expression).toBe('10 * 5');
            expect(result.slots.result).toBe(50);
        });

        test('parses "100 / 4?"', () => {
            const result = clientNLU.parse('100 / 4?');
            expect(result.intent).toBe('MATH');
            expect(result.slots.expression).toBe('100 / 4');
            expect(result.slots.result).toBe(25);
        });

        test('parses "2^8"', () => {
            const result = clientNLU.parse('2^8');
            expect(result.intent).toBe('MATH');
            expect(result.slots.expression).toBe('2^8');
            expect(result.slots.result).toBe(256);
        });

        test('parses decimal math "3.14 * 2"', () => {
            const result = clientNLU.parse('3.14 * 2');
            expect(result.intent).toBe('MATH');
            expect(result.slots.result).toBe(6.28);
        });

        test('parses "sqrt(3)*7"', () => {
            const result = clientNLU.parse('sqrt(3)*7');
            expect(result.intent).toBe('MATH');
            expect(result.slots.expression).toBe('sqrt(3)*7');
            expect(result.slots.result).toBeCloseTo(12.124, 3);
        });

        test('parses "sin(90)" in degrees (calculator-style)', () => {
            const result = clientNLU.parse('sin(90)');
            expect(result.intent).toBe('MATH');
            expect(result.slots.result).toBeCloseTo(1, 10);
        });

        test('parses "log(100, 10)"', () => {
            const result = clientNLU.parse('log(100, 10)');
            expect(result.intent).toBe('MATH');
            expect(result.slots.result).toBeCloseTo(2, 10);
        });
    });

    describe('PLAY/PAUSE patterns', () => {
        test('parses "play"', () => {
            const result = clientNLU.parse('play');
            expect(result.intent).toBe('PLAY');
        });

        test('parses "pause"', () => {
            const result = clientNLU.parse('pause');
            expect(result.intent).toBe('PAUSE');
        });

        test('parses "stop"', () => {
            const result = clientNLU.parse('stop');
            expect(result.intent).toBe('PAUSE');
        });

        test('parses "resume"', () => {
            const result = clientNLU.parse('resume');
            expect(result.intent).toBe('PLAY');
        });
    });

    describe('SET_FRAME patterns', () => {
        test('parses "frame 100"', () => {
            const result = clientNLU.parse('frame 100');
            expect(result.intent).toBe('SET_FRAME');
            expect(result.slots.frame).toBe(100);
        });

        test('parses "go to frame 50"', () => {
            const result = clientNLU.parse('go to frame 50');
            expect(result.intent).toBe('SET_FRAME');
            expect(result.slots.frame).toBe(50);
        });
    });

    describe('SET_TIME patterns', () => {
        test('parses "12:30"', () => {
            const result = clientNLU.parse('12:30');
            expect(result.intent).toBe('SET_TIME_RELATIVE');
            expect(result.slots.hours).toBe(12);
            expect(result.slots.minutes).toBe(30);
        });

        test('parses "3pm"', () => {
            const result = clientNLU.parse('3pm');
            expect(result.intent).toBe('SET_TIME_RELATIVE');
            expect(result.slots.hours).toBe(15);
        });

        test('parses "12am"', () => {
            const result = clientNLU.parse('12am');
            expect(result.intent).toBe('SET_TIME_RELATIVE');
            expect(result.slots.hours).toBe(0);
        });

        test('parses ISO datetime', () => {
            const result = clientNLU.parse('set time to 2023-12-25T18:00:00Z');
            expect(result.intent).toBe('SET_DATETIME');
            expect(result.slots.dateTime).toBe('2023-12-25T18:00:00Z');
        });
    });

    describe('GOTO patterns', () => {
        test('parses "go to 40.7128, -74.0060"', () => {
            const result = clientNLU.parse('go to 40.7128, -74.0060');
            expect(result.intent).toBe('GOTO_LLA');
            expect(result.slots.lat).toBeCloseTo(40.7128);
            expect(result.slots.lon).toBeCloseTo(-74.006);
        });

        test('parses "go to London"', () => {
            const result = clientNLU.parse('go to London');
            expect(result.intent).toBe('GOTO_NAMED_LOCATION');
            expect(result.slots.location).toBe('London');
        });

        test('parses "move to New York City"', () => {
            const result = clientNLU.parse('move to New York City');
            expect(result.intent).toBe('GOTO_NAMED_LOCATION');
            expect(result.slots.location).toBe('New York City');
        });
    });

    describe('POINT_AT patterns', () => {
        test('parses "point at Mars"', () => {
            const result = clientNLU.parse('point at Mars');
            expect(result.intent).toBe('POINT_AT');
            expect(result.slots.target).toBe('Mars');
        });

        test('parses "look at the Moon"', () => {
            const result = clientNLU.parse('look at the Moon');
            expect(result.intent).toBe('POINT_AT');
            expect(result.slots.target).toBe('Moon');
        });
    });

    describe('SET_GEOMETRY patterns', () => {
        test('parses "make them spheres"', () => {
            const result = clientNLU.parse('make them spheres');
            expect(result.intent).toBe('SET_ALL_GEOMETRY');
            expect(result.slots.geometry).toBe('sphere');
        });

        test('parses "change all to boxes"', () => {
            const result = clientNLU.parse('change all to boxes');
            expect(result.intent).toBe('SET_ALL_GEOMETRY');
            expect(result.slots.geometry).toBe('box');
        });

        test('parses "make it a superegg"', () => {
            const result = clientNLU.parse('make it a superegg');
            expect(result.intent).toBe('SET_ALL_GEOMETRY');
            expect(result.slots.geometry).toBe('superegg');
        });
    });

    describe('no match', () => {
        test('returns null intent for unrecognized input', () => {
            const result = clientNLU.parse('what is the meaning of life');
            expect(result.intent).toBeNull();
            expect(result.confidence).toBe(0);
        });

        test('returns null intent for complex queries', () => {
            const result = clientNLU.parse('can you display the satellites visible from london at midnight yesterday');
            expect(result.intent).toBeNull();
            expect(result.confidence).toBe(0);
        });
    });
});

describe('CClientNLU execution', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('MATH execution', () => {
        test('executes addition correctly', async () => {
            const parseResult = clientNLU.parse('2+2');
            const result = await clientNLU.execute(parseResult);
            expect(result.success).toBe(true);
            expect(result.result.answer).toBe(4);
        });

        test('executes multiplication correctly', async () => {
            const parseResult = clientNLU.parse('5 * 3');
            const result = await clientNLU.execute(parseResult);
            expect(result.success).toBe(true);
            expect(result.result.answer).toBe(15);
        });

        test('executes power correctly', async () => {
            const parseResult = clientNLU.parse('2^10');
            const result = await clientNLU.execute(parseResult);
            expect(result.success).toBe(true);
            expect(result.result.answer).toBe(1024);
        });

        test('executes sqrt(3)*7 correctly', async () => {
            const parseResult = clientNLU.parse('sqrt(3)*7');
            const result = await clientNLU.execute(parseResult);
            expect(result.success).toBe(true);
            expect(result.result.answer).toBeCloseTo(12.124, 3);
        });
    });
});

describe('CClientNLU response generation', () => {
    test('generates math response', () => {
        const parseResult = {intent: 'MATH', slots: {expression: '2 + 2', result: 4}};
        const executeResult = {success: true, result: {answer: 4, expression: '2 + 2'}};
        const response = clientNLU.generateResponse(parseResult, executeResult);
        expect(response).toBe('2 + 2 = 4');
    });

    test('generates toggle on response', () => {
        const parseResult = {intent: 'TOGGLE_ON', slots: {target: 'stars'}};
        const executeResult = {success: true};
        const response = clientNLU.generateResponse(parseResult, executeResult);
        expect(response).toBe('Enabled stars');
    });

    test('generates error response', () => {
        const parseResult = {intent: 'SET_VALUE', slots: {path: 'unknown', value: 5}};
        const executeResult = {success: false, error: 'Control not found'};
        const response = clientNLU.generateResponse(parseResult, executeResult);
        expect(response).toBe('Control not found');
    });
});

describe('CClientNLU edge cases', () => {
    test('handles UPPERCASE input "SET FOV TO 5"', () => {
        const result = clientNLU.parse('SET FOV TO 5');
        expect(result.intent).toBe('SET_VALUE');
        expect(result.slots.value).toBe(5);
    });

    test('handles mixed case "Play"', () => {
        const result = clientNLU.parse('Play');
        expect(result.intent).toBe('PLAY');
    });

    test('handles extra whitespace "  set  fov  5  "', () => {
        const result = clientNLU.parse('  set  fov  5  ');
        expect(result.intent).toBe('SET_VALUE');
    });

    test('handles negative numbers "set fov -5"', () => {
        const result = clientNLU.parse('set fov -5');
        expect(result.intent).toBe('SET_VALUE');
        expect(result.slots.value).toBe(-5);
    });

    test('handles negative math "-3 + 5"', () => {
        const result = clientNLU.parse('-3 + 5');
        expect(result.intent).toBe('MATH');
        expect(result.slots.result).toBe(2);
    });

    test('handles contraction "what\'s 2+2"', () => {
        const result = clientNLU.parse("what's 2+2");
        expect(result.intent).toBe('MATH');
        expect(result.slots.result).toBe(4);
    });

    test('handles trailing punctuation "play!"', () => {
        const result = clientNLU.parse('play!');
        expect(result.intent).toBe('PLAY');
    });

    test('handles decimal without leading zero ".5 * 2"', () => {
        const result = clientNLU.parse('.5 * 2');
        expect(result.intent).toBe('MATH');
        expect(result.slots.result).toBe(1);
    });

    test('handles scientific notation "1e3 + 1"', () => {
        const result = clientNLU.parse('1e3 + 1');
        expect(result.intent).toBe('MATH');
        expect(result.slots.result).toBe(1001);
    });

    test('rejects division by zero (returns Infinity)', () => {
        const result = clientNLU.parse('1/0');
        expect(result.intent).toBe(null);
    });

    test('rejects sqrt of negative (returns NaN)', () => {
        const result = clientNLU.parse('sqrt(-1)');
        expect(result.intent).toBe(null);
    });

    test('handles empty input', () => {
        const result = clientNLU.parse('');
        expect(result.intent).toBe(null);
        expect(result.confidence).toBe(0);
    });

    test('handles whitespace-only input', () => {
        const result = clientNLU.parse('   ');
        expect(result.intent).toBe(null);
    });

    test('handles very large numbers "2^50"', () => {
        const result = clientNLU.parse('2^50');
        expect(result.intent).toBe('MATH');
        expect(result.slots.result).toBe(1125899906842624);
    });

    test('handles parentheses "(2+3)*4"', () => {
        const result = clientNLU.parse('(2+3)*4');
        expect(result.intent).toBe('MATH');
        expect(result.slots.result).toBe(20);
    });
});
