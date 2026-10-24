/**
 * @jest-environment jsdom
 */

// A chat-sourced setMenuValue could point an overlay's Image URL control at an external
// address. The control fetches on change, so the request itself carries data out — the
// saveSitch -> getShareLink -> overlay chain that CHAT_DENIED_URL_PARAMS closes for the
// named overlay functions, reopened through the generic setter.

jest.mock('../src/Globals', () => ({
    CustomManager: {},
    FileManager: {list: {}},
    GlobalDateTimeNode: {},
    Globals: {errorDialogSinks: new Set(), errorDialogTarget: null},
    guiMenus: {},
    markSitchDirty: jest.fn(),
    NodeMan: {get: jest.fn(), exists: jest.fn(() => false), list: {}},
    Sit: {},
    SitchMan: {iterate: jest.fn(), exists: jest.fn(() => false), get: jest.fn()},
    TrackManager: {},
    UndoManager: {add: jest.fn()},
    setNewSitchObject: jest.fn(),
    setRenderOne: jest.fn(),
    withTestUser: (url) => url,
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
jest.mock('../src/CViewManager', () => ({ViewMan: {updateViewFromPreset: jest.fn(), iterate: jest.fn(), get: jest.fn()}}));
jest.mock('../src/PageStructure', () => ({areControlsHidden: jest.fn(() => false), toggleControlsVisibility: jest.fn()}));
jest.mock('../src/utils', () => ({closeFullscreen: jest.fn(), isFullscreen: jest.fn(() => false), openFullscreen: jest.fn()}));
jest.mock('../src/nodes/CNodeViewUI', () => ({forceUpdateUIText: jest.fn()}));

import {looksLikeURL, refuseExternalURLParams} from '../src/PromptSafety';
import {sitrecAPI} from '../src/CSitrecAPI.js';

const setMenu = (value, path = 'Overlay: X/Properties/Image URL') =>
    ({fn: 'setMenuValue', args: {menu: 'objects', path, value}});

describe('setMenuValue from a model-driven source', () => {
    test.each([
        'https://evil.example/x.png?d=share-link',
        'http://localhost/x.png',               // same origin is still a URL: no URL at all
        '//evil.example/x.png',
        '\u0000https://evil.example/x',         // the URL parser strips the leading control
        'ht\ttps://evil.example/x',             // and an embedded tab
        '/\\evil.example/x',                    // and folds the backslash
        'javascript:alert(1)',
    ])('refuses the URL %p', (value) => {
        const refusal = refuseExternalURLParams(setMenu(value));
        expect(refusal).toMatchObject({success: false, fn: 'setMenuValue'});
        expect(refusal.error).toMatch(/cannot be a URL/);
    });

    // A non-string reaching the control is coerced at the sink: String(['https://x']) is the URL.
    test.each([
        [['https://evil.example/x']],
        [{toString: () => 'https://evil.example/x'}],
    ])('refuses the non-string %p', (value) => {
        expect(refuseExternalURLParams(setMenu(value))).not.toBeNull();
    });

    test.each([true, false, 0, 2.5, null, 'Satellites', '#ff8800', 'data/images/overlay.png',
        '2026-08-31 22:00'])('allows the ordinary value %p', (value) => {
        expect(refuseExternalURLParams(setMenu(value, 'showStarlink'))).toBeNull();
    });

    test('WebMCP and chat share one URL test', () => {
        expect(looksLikeURL('https://evil.example/x')).toBe(true);
        expect(looksLikeURL('Overlay 1')).toBe(false);
    });
});

describe('looksLikeURL end trim', () => {
    const NUL = String.fromCharCode(0);
    const US = String.fromCharCode(0x1f);
    const NBSP = String.fromCharCode(0xa0);

    // Like the URL parser, the trim drops every code unit up to U+0020 at both ends and nothing
    // else. String.prototype.trim would be wrong both ways: it keeps NUL and drops NBSP.
    test.each([
        ['', false],
        [NUL + ' ' + US, false],
        [' //evil.example/x', true],
        [NUL + US + ' https://evil.example/x ' + NUL, true],
        ['javascript:alert(1)' + NUL + ' ', true],
        ['Overlay 1 ' + NUL, false],
        ['!https://evil.example/x', false],
        [NBSP + 'https://evil.example/x', false],   // new URL() resolves this as a relative path
    ])('looksLikeURL(%j) is %p', (value, expected) => {
        expect(looksLikeURL(value)).toBe(expected);
    });

    // The trim was a regex that took quadratic time on an inner run (100,000 characters: about
    // 4 s), and a chat-sourced value has no length cap.
    test('returns quickly on a 1,000,000-character run of spaces and NULs', () => {
        const run = (' ' + NUL).repeat(500000);
        for (const [value, expected] of [
            ['x' + run + 'x', false],
            [run + 'https://evil.example/x' + run, true],
        ]) {
            const started = performance.now();
            expect(looksLikeURL(value)).toBe(expected);
            expect(performance.now() - started).toBeLessThan(100);
        }
    });
});

describe('handleAPICall setMenuValue URL guard', () => {
    let setter;
    beforeEach(() => {
        setter = jest.spyOn(sitrecAPI, '_setMenuValue').mockReturnValue({success: true});
    });
    afterEach(() => setter.mockRestore());

    test.each(['chat', 'webmcp'])('a %s-sourced overlay URL never reaches the control', async (source) => {
        const result = await sitrecAPI.handleAPICall(setMenu('https://evil.example/?d=secret'), source);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/cannot be a URL/);
        expect(setter).not.toHaveBeenCalled();
    });

    test('a chat-sourced ordinary value still goes through', async () => {
        const result = await sitrecAPI.handleAPICall(setMenu('Overlay 2', 'Overlay: X/Name'), 'chat');
        expect(result.success).toBe(true);
        expect(setter).toHaveBeenCalledWith('objects', 'Overlay: X/Name', 'Overlay 2');
    });

    test('the user setting a URL from the UI is unaffected', async () => {
        const result = await sitrecAPI.handleAPICall(setMenu('https://maps.example/overlay.png'), 'ui');
        expect(result.success).toBe(true);
        expect(setter).toHaveBeenCalledWith('objects', 'Overlay: X/Properties/Image URL', 'https://maps.example/overlay.png');
    });
});
