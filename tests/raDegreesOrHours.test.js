/**
 * @jest-environment jsdom
 */
// pointCameraAtRaDec / lockCameraOnRaDec: an RA in degrees must not be read as hours.
//
// Forum report: RA/Dec taken from Astrometry.net and given to the assistant pointed the camera
// at the wrong place. Astrometry.net gives RA in degrees; the API read every plain number as
// hours, so RA 258.1 was used as 258.1 h. Now a plain number up to 24 is still hours, above 24
// and up to 360 it is degrees (with a warning), a unit says which explicitly, and anything else
// out of range is an error the caller sees.

var mockNodeGet = jest.fn();

jest.mock('../src/Globals', () => ({
    CustomManager: {},
    FileManager: {list: {}},
    GlobalDateTimeNode: {setStartDateTime: jest.fn()},
    Globals: {errorDialogSinks: new Set(), errorDialogTarget: null},
    guiMenus: {},
    markSitchDirty: jest.fn(),
    NodeMan: {get: (...args) => mockNodeGet(...args), exists: jest.fn(() => false), list: {}},
    Sit: {},
    SitchMan: {iterate: jest.fn(), exists: jest.fn(() => false), get: jest.fn()},
    TrackManager: {exists: jest.fn(() => false)},
    UndoManager: {add: jest.fn()},
    setNewSitchObject: jest.fn(),
    setRenderOne: jest.fn(),
    withTestUser: jest.fn((url) => url),
}));

jest.mock('../src/configUtils', () => ({
    isLocal: false,
    isServerless: false,
    SITREC_SERVER: 'https://example.com/sitrecServer/',
}));
jest.mock('../src/showError', () => ({showError: jest.fn(), showChoice: jest.fn()}));
jest.mock('../src/SitchProvenance', () => ({
    getSitchSourceLabel: jest.fn(() => null),
    isSitchExternal: jest.fn(() => false),
    trustCurrentSitch: jest.fn(),
}));
jest.mock('../src/js/lil-gui.esm', () => jest.fn().mockImplementation(function MockGUI() {}));
jest.mock('../src/nodes/CNode3DObject', () => ({ModelFiles: {}, CNode3DObject: jest.fn()}));
jest.mock('../src/par', () => ({par: {}}));
jest.mock('../src/CViewManager', () => ({
    ViewMan: {updateViewFromPreset: jest.fn(), iterate: jest.fn(), get: jest.fn()},
}));
jest.mock('../src/PageStructure', () => ({
    areControlsHidden: jest.fn(() => false),
    toggleControlsVisibility: jest.fn(),
}));
jest.mock('../src/utils', () => ({
    closeFullscreen: jest.fn(),
    isFullscreen: jest.fn(() => false),
    openFullscreen: jest.fn(),
}));
jest.mock('../src/nodes/CNodeViewUI', () => ({forceUpdateUIText: jest.fn()}));

import {sitrecAPI} from '../src/CSitrecAPI.js';

let camera;
let warn;
beforeEach(() => {
    camera = {setFromRaDec: jest.fn(), lockOnRaDec: jest.fn()};
    mockNodeGet.mockImplementation((id) => (id === 'lookCamera' ? camera : undefined));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

/** The RA, in hours, that pointCameraAtRaDec handed the camera — or the error it returned. */
async function pointRA(ra) {
    const out = await sitrecAPI.call('pointCameraAtRaDec', {ra, dec: 10});
    if (!out.success) return {error: out.error};
    expect(camera.setFromRaDec).toHaveBeenCalledTimes(1);
    expect(camera.setFromRaDec.mock.calls[0][1]).toBe(10);
    return camera.setFromRaDec.mock.calls[0][0];
}

describe('RA in hours, as documented, is unchanged', () => {
    test.each([
        [3.79, 3.79], ['5.92', 5.92], [0, 0], [24, 24],
        // Values the local assistant passes from its own catalogue (already in hours).
        [2.530, 2.530], [16.811, 16.811], [358.8 / 15, 358.8 / 15],
    ])('plain %p is %p h', async (input, hours) => {
        expect(await pointRA(input)).toBe(hours);
        expect(warn).not.toHaveBeenCalled();
    });

    test.each([
        ['3h47m', 3 + 47 / 60], ['03:47:10', 3 + 47 / 60 + 10 / 3600],
        ['3h 47m 10s', 3 + 47 / 60 + 10 / 3600], ['5.92h', 5.92], ['24h', 24],
    ])('sexagesimal or suffixed %p is hours', async (input, hours) => {
        expect(await pointRA(input)).toBeCloseTo(hours, 12);
        expect(warn).not.toHaveBeenCalled();
    });
});

describe('RA in degrees', () => {
    test.each([258.1, '258.1', 24.5, 360])('plain %p above 24 is read as degrees, with a warning', async (input) => {
        expect(await pointRA(input)).toBeCloseTo(Number(input) / 15, 12);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/degrees/);
    });

    test.each([
        ['258.1 deg', 258.1], ['258.1deg', 258.1], ['258.1°', 258.1], ['258.1d', 258.1],
        ['258.1 degrees', 258.1], ['12 deg', 12], ['0 deg', 0], ['360 DEG', 360],
    ])('%p with a unit is degrees, with no warning', async (input, degrees) => {
        expect(await pointRA(input)).toBeCloseTo(degrees / 15, 12);
        expect(warn).not.toHaveBeenCalled();
    });

    test('lockCameraOnRaDec converts the same way and reports hours', async () => {
        const out = await sitrecAPI.call('lockCameraOnRaDec', {ra: '258.1 deg', dec: -12.5});
        expect(out.success).toBe(true);
        expect(camera.lockOnRaDec).toHaveBeenCalledWith(258.1 / 15, -12.5);
        expect(out.result.locked).toEqual({ra: 258.1 / 15, dec: -12.5});
    });
});

describe('RA out of range or unreadable is an error the caller sees', () => {
    test.each([400, -5, '-0.5', '400 deg', '25h', '24:30', 'abc', '12 rad', undefined])('%p', async (input) => {
        const res = await pointRA(input);
        expect(res.error).toMatch(/RA/);
        expect(res.error).toMatch(/deg/);   // the message says how to give degrees
        expect(camera.setFromRaDec).not.toHaveBeenCalled();
    });

    test('lockCameraOnRaDec refuses the same way', async () => {
        const out = await sitrecAPI.call('lockCameraOnRaDec', {ra: 400, dec: 0});
        expect(out.success).toBe(false);
        expect(out.error).toMatch(/out of range/);
        expect(camera.lockOnRaDec).not.toHaveBeenCalled();
    });
});

describe('the API docs tell the model about both forms', () => {
    test.each(['pointCameraAtRaDec', 'lockCameraOnRaDec'])('%s', (fn) => {
        const entry = sitrecAPI.api[fn];
        expect(entry.doc).toMatch(/degrees 0-360 with a unit/);
        expect(entry.params.ra).toMatch(/deg/);
        // The ra description must not make _coerceArgs turn "3h47m" into a number.
        expect(entry.params.ra).not.toMatch(/float|number|\bint(eger)?\b/i);
    });
});
