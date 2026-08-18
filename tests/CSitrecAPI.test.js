/**
 * @jest-environment jsdom
 */

var mockNodeGet = jest.fn();
var mockNodeExists = jest.fn(() => false);
var mockNodeDispose = jest.fn();
var mockNodeList;
var mockTrackManager;
var mockMarkSitchDirty = jest.fn();
var mockSetNewSitchObject = jest.fn();
var mockWithTestUser = jest.fn((url) => url);
var mockSetStartDateTime = jest.fn();

var mockCustomManager;
var mockFileManager;
var mockGlobalsState;
var mockSit;
var mockSitchMan;
var mockGuiMenus;

const originalFetch = global.fetch;

jest.mock('../src/Globals', () => {
    mockCustomManager = {
        getCustomSitchString: jest.fn(() => JSON.stringify({name: 'Serialized'})),
        customLink: null,
    };

    mockFileManager = {
        list: {},
        hasServerBackedSaves: jest.fn(() => false),
        saveLocal: jest.fn(async () => false),
        saveSitch: jest.fn(async () => undefined),
        saveSitchNamed: jest.fn(async () => undefined),
        loadSavedFile: jest.fn(),
        userSaves: undefined,
    };

    mockGlobalsState = {
        sitchDirty: false,
        errorDialogSinks: new Set(),
        errorDialogTarget: null,
    };

    mockSit = {};

    mockSitchMan = {
        iterate: jest.fn(),
        exists: jest.fn(() => false),
        get: jest.fn(),
    };

    return {
        CustomManager: mockCustomManager,
        FileManager: mockFileManager,
        GlobalDateTimeNode: {setStartDateTime: (...args) => mockSetStartDateTime(...args)},
        Globals: mockGlobalsState,
        guiMenus: mockGuiMenus = {},
        markSitchDirty: (...args) => mockMarkSitchDirty(...args),
        NodeMan: {
            get: (...args) => mockNodeGet(...args),
            exists: (...args) => mockNodeExists(...args),
            disposeRemove: (...args) => mockNodeDispose(...args),
            list: mockNodeList = {},
        },
        Sit: mockSit,
        SitchMan: mockSitchMan,
        TrackManager: mockTrackManager = {
            exists: jest.fn(() => false),
            get: jest.fn(() => ({displayTrackID: null})),
            disposeRemove: jest.fn(),
            addSyntheticTrack: jest.fn(() => ({trackID: 'track_test'})),
        },
        UndoManager: {},
        setNewSitchObject: (...args) => mockSetNewSitchObject(...args),
        withTestUser: (...args) => mockWithTestUser(...args),
    };
});

jest.mock('../src/configUtils', () => ({
    isLocal: false,
    isServerless: false,
    SITREC_SERVER: 'https://example.com/sitrecServer/',
}));

jest.mock('../src/showError', () => ({
    showError: jest.fn(),
}));

jest.mock('../src/js/lil-gui.esm', () => {
    return jest.fn().mockImplementation(function MockGUI() {});
});

jest.mock('../src/nodes/CNode3DObject', () => ({
    ModelFiles: {},
    // constructible stand-in so createWalker's success path can complete
    CNode3DObject: jest.fn(function (v) {
        this.props = v;
        this.group = {quaternion: {setFromUnitVectors: jest.fn()}};
        this.addController = jest.fn();
    }),
}));

jest.mock('../src/par', () => ({
    par: {},
}));

jest.mock('../src/CViewManager', () => ({
    ViewMan: {
        updateViewFromPreset: jest.fn(),
        iterate: jest.fn(),
        get: jest.fn(),
    },
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

jest.mock('../src/nodes/CNodeViewUI', () => ({
    forceUpdateUIText: jest.fn(),
}));

import {sitrecAPI} from '../src/CSitrecAPI.js';

beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockSit).forEach((key) => delete mockSit[key]);
    // errorDialogSinks survives alongside sitchDirty: the real Globals creates it once
    // at module load and nothing ever removes it, so deleting it here would only make
    // the harness diverge from production. Emptied rather than dropped.
    Object.keys(mockGlobalsState).forEach((key) => {
        if (key !== 'sitchDirty' && key !== 'errorDialogSinks' && key !== 'errorDialogTarget') {
            delete mockGlobalsState[key];
        }
    });
    mockGlobalsState.sitchDirty = false;
    mockGlobalsState.errorDialogSinks.clear();
    mockGlobalsState.errorDialogTarget = null;
    mockCustomManager.customLink = null;
    mockCustomManager.getCustomSitchString.mockImplementation(() => JSON.stringify({name: 'Serialized'}));
    mockFileManager.userSaves = undefined;
    mockFileManager.hasServerBackedSaves.mockReturnValue(false);
    mockFileManager.saveLocal.mockResolvedValue(false);
    mockFileManager.saveSitch.mockResolvedValue(undefined);
    mockFileManager.saveSitchNamed.mockResolvedValue(undefined);
    mockSitchMan.iterate.mockImplementation(() => {});
    mockSitchMan.exists.mockReturnValue(false);
    mockSitchMan.get.mockReturnValue(undefined);
    global.fetch = originalFetch;
});

afterAll(() => {
    global.fetch = originalFetch;
});

describe('CSitrecAPI importMedia', () => {
    beforeEach(() => {
        mockNodeGet.mockReset();
    });

    test('imports media into the current video node', async () => {
        const videoNode = {
            videos: [
                {fileName: 'photo.jpg', staticURL: undefined, imageFileID: 'photo.jpg'},
                {fileName: 'clip.mp4', staticURL: 'clip.mp4', imageFileID: undefined},
            ],
            currentVideoIndex: 1,
            newVideo: jest.fn(),
        };
        mockNodeGet.mockImplementation((id) => {
            if (id === 'video') return videoNode;
            return false;
        });

        const result = await sitrecAPI.call('importMedia', {file: 'data/photo.jpg'});

        expect(videoNode.newVideo).toHaveBeenCalledWith('photo.jpg', false);
        expect(mockMarkSitchDirty).toHaveBeenCalled();
        expect(result).toEqual({
            success: true,
            fn: 'importMedia',
            result: {
                success: true,
                imported: true,
                pending: true,
                file: 'photo.jpg',
            },
        });
    });

    test('uses clearFrames on the first imported media entry', async () => {
        const videoNode = {
            videos: [],
            newVideo: jest.fn(),
        };
        mockNodeGet.mockImplementation((id) => {
            if (id === 'video') return videoNode;
            return false;
        });

        const result = await sitrecAPI.call('importMedia', {file: '!new.mp4'});

        expect(videoNode.newVideo).toHaveBeenCalledWith('new.mp4', true);
        expect(mockMarkSitchDirty).toHaveBeenCalled();
        expect(result).toEqual({
            success: true,
            fn: 'importMedia',
            result: {
                success: true,
                imported: true,
                pending: true,
                file: 'new.mp4',
            },
        });
    });

    test('returns an error when no media file is provided', async () => {
        const result = await sitrecAPI.call('importMedia', {});

        // A function that returns {success:false} fails the whole call: the outer
        // success flag mirrors it, so an agent reading the wrapper (the MCP bridge
        // hands it over whole) cannot read a failure as "it worked".
        expect(result).toEqual({
            success: false,
            fn: 'importMedia',
            error: 'Media file is required',
            result: {
                success: false,
                error: 'Media file is required',
            },
        });
    });
});

describe('CSitrecAPI notes APIs', () => {
    test('returns notes text from the notes view', async () => {
        mockNodeGet.mockImplementation((id) => id === 'notesView' ? {notesText: 'Existing notes', visible: true} : false);

        const result = await sitrecAPI.call('getNotes');

        expect(result).toEqual({
            success: true,
            fn: 'getNotes',
            result: {
                success: true,
                text: 'Existing notes',
                visible: true,
            },
        });
    });

    test('replaces notes text and marks the sitch dirty', async () => {
        const notesView = {
            notesText: 'Before',
            textArea: {value: 'Before'},
            linkifyContent: jest.fn(),
        };
        mockNodeGet.mockImplementation((id) => id === 'notesView' ? notesView : false);

        const result = await sitrecAPI.call('setNotes', {text: 'After'});

        expect(notesView.notesText).toBe('After');
        expect(notesView.textArea.value).toBe('After');
        expect(notesView.linkifyContent).toHaveBeenCalled();
        expect(mockMarkSitchDirty).toHaveBeenCalled();
        expect(result).toEqual({
            success: true,
            fn: 'setNotes',
            result: {
                success: true,
                text: 'After',
                length: 5,
            },
        });
    });

    test('appends notes text with paragraph separation', async () => {
        const notesView = {
            notesText: 'Alpha',
            textArea: {value: 'Alpha'},
            linkifyContent: jest.fn(),
        };
        mockNodeGet.mockImplementation((id) => id === 'notesView' ? notesView : false);

        const result = await sitrecAPI.call('updateNotes', {mode: 'append', text: 'Beta'});

        expect(notesView.notesText).toBe('Alpha\n\nBeta');
        expect(result).toEqual({
            success: true,
            fn: 'updateNotes',
            result: {
                success: true,
                mode: 'append',
                text: 'Alpha\n\nBeta',
                length: 11,
            },
        });
    });
});

describe('CSitrecAPI sitch APIs', () => {
    test('lists built-in and saved sitches', async () => {
        mockSitchMan.iterate.mockImplementation((callback) => {
            callback('gimbal', {name: 'gimbal', menuName: 'Gimbal'});
            callback('custom', {name: 'custom', hidden: true});
        });
        mockFileManager.hasServerBackedSaves.mockReturnValue(true);
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            text: async () => JSON.stringify([['SavedA', '2026-04-02'], ['SavedB', '2026-04-01']]),
        });

        const result = await sitrecAPI.call('listSitches');

        expect(global.fetch).toHaveBeenCalledWith('https://example.com/sitrecServer/getsitches.php?get=myfiles', {mode: 'cors'});
        expect(result).toEqual({
            success: true,
            fn: 'listSitches',
            result: {
                success: true,
                builtIn: [
                    {key: 'custom', name: 'custom', menuName: null, hidden: true, kind: 'built-in'},
                    {key: 'gimbal', name: 'gimbal', menuName: 'Gimbal', hidden: false, kind: 'built-in'},
                ],
                saved: ['SavedA', 'SavedB'],
                counts: {builtIn: 2, saved: 2},
                current: {name: null, sitchName: null},
                serverBackedSaves: true,
                savedFetchError: undefined,
            },
        });
    });

    test('loads a built-in sitch through the sitch registry', async () => {
        const sitchObject = {name: 'gimbal', menuName: 'Gimbal', nested: {value: 1}};
        mockSitchMan.exists.mockReturnValue(true);
        mockSitchMan.get.mockReturnValue(sitchObject);

        const result = await sitrecAPI.call('loadSitch', {name: 'gimbal'});

        expect(mockSetNewSitchObject).toHaveBeenCalledTimes(1);
        expect(mockSetNewSitchObject.mock.calls[0][0]).toEqual(sitchObject);
        expect(mockSetNewSitchObject.mock.calls[0][0]).not.toBe(sitchObject);
        expect(result).toEqual({
            success: true,
            fn: 'loadSitch',
            result: {
                success: true,
                source: 'built-in',
                key: 'gimbal',
                name: 'gimbal',
                pending: true,
            },
        });
    });

    test('routes saved sitch loads through FileManager', async () => {
        mockFileManager.hasServerBackedSaves.mockReturnValue(true);

        const result = await sitrecAPI.call('loadSitch', {name: 'MySavedSitch', source: 'saved', sourceUserID: 42});

        expect(mockFileManager.loadSavedFile).toHaveBeenCalledWith('MySavedSitch', 42);
        expect(result).toEqual({
            success: true,
            fn: 'loadSitch',
            result: {
                success: true,
                source: 'saved',
                name: 'MySavedSitch',
                sourceUserID: 42,
                pending: true,
            },
        });
    });

    test('uses local save flow when server-backed saves are unavailable', async () => {
        mockSit.sitchName = 'LocalCopy';

        const result = await sitrecAPI.call('saveSitch', {target: 'auto'});

        expect(mockFileManager.saveSitchNamed).toHaveBeenCalledWith('LocalCopy', true, null, null);
        expect(result).toEqual({
            success: true,
            fn: 'saveSitch',
            result: {
                success: true,
                target: 'local',
                name: 'LocalCopy',
                dirty: false,
                shareLink: null,
            },
        });
    });

    test('returns the share link after saving when requested', async () => {
        mockSit.sitchName = 'TestSitch';
        mockFileManager.hasServerBackedSaves.mockReturnValue(true);
        mockFileManager.saveSitchNamed.mockImplementation(async () => {
            mockCustomManager.customLink = 'https://example.com/?custom=abc';
            mockGlobalsState.sitchDirty = false;
        });

        const result = await sitrecAPI.call('getShareLink', {saveIfNeeded: true});

        expect(mockFileManager.saveSitchNamed).toHaveBeenCalledWith('TestSitch', false, null, null);
        expect(result).toEqual({
            success: true,
            fn: 'getShareLink',
            result: {
                success: true,
                url: 'https://example.com/?custom=abc',
                dirty: false,
            },
        });
    });

    test('returns lightweight sitch state', async () => {
        mockSit.name = 'gimbal';
        mockSit.isCustom = false;
        mockSit.canMod = true;
        mockGlobalsState.sitchDirty = true;

        const result = await sitrecAPI.call('getSitchState');

        expect(result).toEqual({
            success: true,
            fn: 'getSitchState',
            result: {
                name: 'gimbal',
                dirty: true,
                isCustom: false,
                canMod: true,
            },
        });
    });

    test('exports full serialized sitch state via exportSitchState', async () => {
        mockSit.name = 'custom';
        mockSit.isCustom = true;
        mockGlobalsState.sitchDirty = true;
        mockCustomManager.getCustomSitchString.mockReturnValue(JSON.stringify({name: 'custom', mods: {notesView: {notesText: 'A'}}}));

        const result = await sitrecAPI.call('exportSitchState');

        expect(result).toEqual({
            success: true,
            fn: 'exportSitchState',
            result: {
                success: true,
                state: {name: 'custom', mods: {notesView: {notesText: 'A'}}},
                name: 'custom',
                dirty: true,
                isCustom: true,
                canMod: false,
            },
        });
    });

    test('rejects built-in sitch with setup hooks', async () => {
        mockSitchMan.exists.mockReturnValue(true);
        mockSitchMan.get.mockReturnValue({name: 'gimbal', setup: function() {}});

        const result = await sitrecAPI.call('loadSitch', {name: 'gimbal'});

        expect(result).toEqual({
            success: false,
            fn: 'loadSitch',
            error: expect.stringContaining('setup hooks'),
            result: {
                success: false,
                error: expect.stringContaining('setup hooks'),
            },
        });
        expect(mockSetNewSitchObject).not.toHaveBeenCalled();
    });

    test('requires name when sitch has not been previously saved', async () => {
        mockFileManager.hasServerBackedSaves.mockReturnValue(true);

        const result = await sitrecAPI.call('saveSitch', {target: 'server'});

        expect(result).toEqual({
            success: false,
            fn: 'saveSitch',
            error: expect.stringContaining('name is required'),
            result: {
                success: false,
                error: expect.stringContaining('name is required'),
            },
        });
    });
});

describe('CSitrecAPI transient state classification', () => {
    test('treats read-only calls as transient and notes writes as state changes', () => {
        expect(sitrecAPI.callChangesSerializedState(
            {fn: 'getSitchState'},
            {success: true, result: {success: true}}
        )).toBe(false);

        expect(sitrecAPI.callChangesSerializedState(
            {fn: 'exportSitchState'},
            {success: true, result: {success: true}}
        )).toBe(false);

        expect(sitrecAPI.callChangesSerializedState(
            {fn: 'getShareLink'},
            {success: true, result: {success: true}}
        )).toBe(false);

        // Reading the real-world clock must not dirty the sitch.
        expect(sitrecAPI.callChangesSerializedState(
            {fn: 'getCurrentDateTime'},
            {success: true, result: {success: true}}
        )).toBe(false);

        expect(sitrecAPI.callChangesSerializedState(
            {fn: 'setNotes'},
            {success: true, result: {success: true}}
        )).toBe(true);
    });

    test('separates result-bearing queries from transient actions', () => {
        // Both are transient for serialization and safe on an external sitch, but only
        // the query needs another paid model turn to interpret its returned data.
        expect(sitrecAPI.callNeedsModelResult('getCameraLLA')).toBe(true);
        expect(sitrecAPI.callNeedsModelResult('getShareLink')).toBe(true);
        expect(sitrecAPI.callNeedsModelResult('play')).toBe(false);
        expect(sitrecAPI.callNeedsModelResult('gotoLLA')).toBe(false);
        expect(sitrecAPI.callNeedsModelResult('setNotes')).toBe(false);
    });
});

describe('CSitrecAPI B1 llmCallable gating', () => {
    // The JS-executing scripted-video functions must be withheld from the LLM and refused
    // when a call is sourced from the chatbot, so indirect prompt injection can't reach ACE.
    const DENIED = ['setScriptedVideoScript', 'previewScriptedVideo'];

    test('getDocumentation() still exposes the scripted-video functions (trusted UI/MCP)', () => {
        const doc = sitrecAPI.getDocumentation();
        for (const fn of DENIED) {
            expect(doc).toHaveProperty(fn);
        }
    });

    test('getLLMDocumentation() omits the JS-executing functions', () => {
        const doc = sitrecAPI.getLLMDocumentation();
        for (const fn of DENIED) {
            expect(doc).not.toHaveProperty(fn);
        }
        // A safe, non-executing entry is still advertised to the LLM.
        expect(doc).toHaveProperty('stopScriptedVideo');
    });

    test('handleAPICall refuses a chat-sourced denied call without executing it', async () => {
        const result = await sitrecAPI.handleAPICall(
            {fn: 'setScriptedVideoScript', args: {script: 'window.__pwned = 1'}},
            'chat'
        );
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/not callable from chat/i);
        // The function body never ran, so it could not have executed the payload.
        expect(window.__pwned).toBeUndefined();
    });

    test('handleAPICall allows the same call from a trusted (default) source', async () => {
        // No scriptedVideo system is mocked, so the fn runs and returns its own guard error
        // ("Scripting system not available") — proving the gate let it through to the body.
        const result = await sitrecAPI.handleAPICall(
            {fn: 'setScriptedVideoScript', args: {script: 'from(object, 3)'}}
        );
        expect(result.error ?? result.result?.error ?? '').not.toMatch(/not callable from chat/i);
    });
});

describe('createWalker input validation (before any destructive teardown)', () => {
    // Every case here must fail BEFORE the existing-walker teardown/creation,
    // so none of them need NodeMan/TrackManager beyond the mocks.
    const walk = async (args) => {
        const r = await sitrecAPI.call('createWalker', {
            name: 'w', waypoints: [[45, -122], [45.01, -122.01]], ...args,
        });
        return r.result;
    };

    beforeEach(() => {
        mockSit.frames = 900;
        mockNodeGet.mockReturnValue(undefined);
        Object.keys(mockNodeList).forEach((k) => delete mockNodeList[k]);
        // LLAToECEF reads the earth model from Globals
        mockGlobalsState.equatorRadius = 6378137;
        mockGlobalsState.polarRadius = 6356752.314245;
    });

    test('fractions containing NaN are rejected', async () => {
        const r = await walk({fractions: [0, NaN]});
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/fractions/i);
    });

    test('fractions must start at 0 (no backward extrapolation before the first knot)', async () => {
        const r = await walk({fractions: [0.3, 1]});
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/starting at 0/i);
    });

    test('non-monotonic fractions are rejected', async () => {
        const r = await walk({
            waypoints: [[45, -122], [45.01, -122.01], [45.02, -122.02]],
            fractions: [0, 0.8, 0.5],
        });
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/non-decreasing/i);
    });

    test('non-numeric per-waypoint altitude is rejected (no string concat into LLAToECEF)', async () => {
        const r = await walk({waypoints: [[45, -122, 'abc'], [45.01, -122.01, 100]]});
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/waypoint 0/i);
    });

    test('null/false/"" waypoint components are rejected, not treated as 0 (Null Island)', async () => {
        for (const bad of [[null, -122], [45, false], [45, -122, '']]) {
            const r = await walk({waypoints: [bad, [45.01, -122.01]]});
            expect(r.success).toBe(false);
            expect(r.error).toMatch(/waypoint 0/i);
        }
    });

    test('numeric-string altitudes coerce to the SAME track knots as numbers', async () => {
        const wpsNum = [[45, -122, 100], [45.01, -122.01, 110]];
        const wpsStr = [[45, -122, '100'], [45.01, -122.01, '110']];
        const a = await walk({name: 'wNum', waypoints: wpsNum});
        const b = await walk({name: 'wStr', waypoints: wpsStr});
        expect(a.success).toBe(true);
        expect(b.success).toBe(true);
        const calls = mockTrackManager.addSyntheticTrack.mock.calls;
        expect(calls).toHaveLength(2);
        const [ptsNum, ptsStr] = [calls[0][0].initialPoints, calls[1][0].initialPoints];
        expect(ptsStr).toEqual(ptsNum);   // byte-identical knots — coerced, never concatenated
        for (const p of ptsStr) for (const c of p) expect(Number.isFinite(c)).toBe(true);
    });

    test('knots are strictly increasing and complete AT endFrame', async () => {
        const r = await walk({
            waypoints: [[45, -122], [45.001, -122], [45.002, -122], [45.01, -122.01]],
            fractions: [0, 0.001, 0.002, 1],   // first three round together → bump
            startFrame: 0, endFrame: 800,
        });
        expect(r.success).toBe(true);
        const pts = mockTrackManager.addSyntheticTrack.mock.calls[0][0].initialPoints;
        const frames = pts.map((p) => p[0]);
        for (let i = 1; i < frames.length; i++) expect(frames[i]).toBeGreaterThan(frames[i - 1]);
        expect(frames[3]).toBe(800);          // last waypoint lands exactly on endFrame
        expect(frames[4]).toBe(899);          // then the hold knot at the sitch end
    });

    test('unknown material is rejected up front', async () => {
        const r = await walk({material: 'shiny'});
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/unknown material/i);
    });

    test('validation failure never tears down an existing walker', async () => {
        mockNodeGet.mockReturnValue({_walkerTrackID: 't0'});
        mockTrackManager.exists.mockReturnValue(true);
        const r = await walk({material: 'shiny'});
        expect(r.success).toBe(false);
        expect(mockTrackManager.disposeRemove).not.toHaveBeenCalled();
    });

    test('collision overflow past endFrame is an error, not a silently late finish', async () => {
        mockSit.frames = 900;
        const wps = Array.from({length: 12}, (_, i) => [45 + i * 0.001, -122]);
        const r = await walk({waypoints: wps, startFrame: 0, endFrame: 4});
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/past endFrame/i);
    });

    test('non-finite or reversed frame ranges are rejected before anything destructive', async () => {
        mockNodeGet.mockReturnValue({_walkerTrackID: 't0'});
        mockTrackManager.exists.mockReturnValue(true);
        for (const range of [{startFrame: 'abc'}, {endFrame: null}, {startFrame: 100, endFrame: 50}]) {
            const r = await walk(range);
            expect(r.success).toBe(false);
            expect(r.error).toMatch(/frame range/i);
        }
        expect(mockTrackManager.disposeRemove).not.toHaveBeenCalled();
    });

    test('fractions must end at 1 (endFrame = frame the last waypoint is reached)', async () => {
        const r = await walk({fractions: [0, 0.5]});
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/ending at 1/i);
    });

    test('sparse fraction arrays are rejected (holes skip .some() but not the index loop)', async () => {
        const fr = [0, , 1];   // eslint-disable-line no-sparse-arrays
        const r = await walk({
            waypoints: [[45, -122], [45.01, -122.01], [45.02, -122.02]],
            fractions: fr,
        });
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/fractions/i);
    });

    test('a successful create records a serializable walker spec (sitch persistence)', async () => {
        const r = await walk({name: 'wSpec', waypoints: [[45, -122, '100'], [45.01, -122.01, 110]], material: 'lambert'});
        expect(r.success).toBe(true);
        const spec = mockGlobalsState.walkerSpecs.wSpec;
        expect(spec).toBeDefined();
        expect(spec.waypoints).toEqual([[45, -122, 100], [45.01, -122.01, 110]]);   // numeric, coerced
        expect(spec.material).toBe('lambert');
        expect(spec.trackID).toBe('track_test');
        expect(JSON.parse(JSON.stringify(spec))).toEqual(spec);   // JSON-safe round trip
    });

    test('a non-array waypoint entry is rejected BEFORE any scene mutation', async () => {
        const {CNode3DObject} = require('../src/nodes/CNode3DObject');
        const r = await walk({waypoints: ['45,-122', [45.01, -122.01]]});
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/waypoint 0 must be an array/i);
        expect(CNode3DObject).not.toHaveBeenCalled();
        expect(mockTrackManager.addSyntheticTrack).not.toHaveBeenCalled();
    });

    test('non-finite numeric options are rejected (specs must stay JSON-clean)', async () => {
        // note: emissiveIntensity:null can't be tested through handleAPICall — the
        // shared _coerceArgs layer launders null to 0 for declared-float params
        // before the function sees it (pre-existing API-wide behavior)
        for (const bad of [{height: NaN}, {radius: Infinity}, {rotateY: 'abc'}, {width: NaN}]) {
            const r = await walk(bad);
            expect(r.success).toBe(false);
            expect(r.error).toMatch(/finite/i);
        }
    });

    test('refuses a first-time name whose prefix collides with existing node ids', async () => {
        const {CNode3DObject} = require('../src/nodes/CNode3DObject');
        mockNodeList['syntheticTrack_123'] = {};   // unrelated node the re-create sweep would erase
        const r = await walk({name: 'syntheticTrack'});
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/collides/i);
        expect(CNode3DObject).not.toHaveBeenCalled();
        expect(mockTrackManager.addSyntheticTrack).not.toHaveBeenCalled();
        expect(mockTrackManager.disposeRemove).not.toHaveBeenCalled();
    });

    test('refuses a name inside an existing walker\'s namespace (sibling protection)', async () => {
        const {CNode3DObject} = require('../src/nodes/CNode3DObject');
        // walker "car" exists; creating "car_dog" would be erased by car's next re-create
        mockNodeGet.mockImplementation((id) => (id === 'car' ? {_walkerTrackID: 't_car'} : undefined));
        const r = await walk({name: 'car_dog'});
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/namespace/i);
        expect(CNode3DObject).not.toHaveBeenCalled();
        expect(mockTrackManager.addSyntheticTrack).not.toHaveBeenCalled();
        expect(mockTrackManager.disposeRemove).not.toHaveBeenCalled();
    });

    test('re-creating a walker sweeps only its OWN derived nodes, sparing interlopers', async () => {
        // walker "car" exists with recorded ownership; "car_annex" was created
        // later by another system (e.g. createSynthBuilding) inside the namespace
        const carNode = {_walkerTrackID: 't_car', _walkerOwnedIds: ['car_size']};
        mockNodeGet.mockImplementation((id) => (id === 'car' ? carNode : undefined));
        mockNodeExists.mockImplementation((id) => ['car', 'car_size', 'car_annex'].includes(id));
        mockTrackManager.exists.mockImplementation((id) => id === 't_car');
        const r = await walk({name: 'car'});
        expect(r.success).toBe(true);
        const disposed = mockNodeDispose.mock.calls.map((c) => c[0]);
        expect(disposed).toEqual(expect.arrayContaining(['car', 'car_size']));
        expect(disposed).not.toContain('car_annex');
    });

    test('refuses to replace a non-walker node that owns the name (no core-node deletion)', async () => {
        mockNodeGet.mockReturnValue({id: 'mainCamera'});   // exists, but no _walkerTrackID
        const r = await walk({name: 'mainCamera'});
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/non-walker/i);
        expect(mockTrackManager.disposeRemove).not.toHaveBeenCalled();
    });

    test('reuseTrackID binds to an existing track instead of creating a duplicate', async () => {
        mockTrackManager.exists.mockImplementation((id) => id === 'restored_track');
        const r = await walk({name: 'wReuse', reuseTrackID: 'restored_track'});
        expect(r.success).toBe(true);
        expect(r.trackID).toBe('restored_track');
        expect(mockTrackManager.addSyntheticTrack).not.toHaveBeenCalled();
    });
});
// An AI agent's mistake is correctable, so every failure has to reach the agent as
// data rather than the user as a modal. These cover both halves: nothing pops a
// dialog on an agent path, and what comes back is enough to retry with.
describe('CSitrecAPI agent-sourced error routing', () => {
    // Mirrors showError's routing rule, since showError itself is mocked out here.
    // Keep in step with src/showError.js.
    function raiseDialog(text) {
        const sinks = mockGlobalsState.errorDialogSinks;
        if (sinks.size === 0) return;
        const target = mockGlobalsState.errorDialogTarget
            ?? (sinks.size === 1 ? sinks.values().next().value : null);
        if (target) target.push(text);
    }

    afterEach(() => {
        delete sitrecAPI.api.__probe;
        delete sitrecAPI.api.__inner;
        delete sitrecAPI.api.__outer;
        delete sitrecAPI.api.__a;
        delete sitrecAPI.api.__b;
        delete sitrecAPI.api.__slow;
    });

    test.each(['chat', 'mcp'])('a %s call diverts error dialogs into the result', async (source) => {
        let armedDuringCall;
        sitrecAPI.api.__probe = {fn: () => {
            armedDuringCall = mockGlobalsState.errorDialogSinks.size;
            raiseDialog('Annotate is not available here');
            return {success: false, error: 'no such control'};
        }};

        const r = await sitrecAPI.handleAPICall({fn: '__probe', args: {}}, source);

        expect(armedDuringCall).toBe(1);
        expect(r.success).toBe(false);                       // not buried under success:true
        expect(r.error).toBe('no such control');
        expect(r.errorDialogs).toEqual(['Annotate is not available here']);
        expect(mockGlobalsState.errorDialogSinks.size).toBe(0);    // released again
    });

    test('a ui call leaves the hook clear, so a person still gets the dialog', async () => {
        let armedDuringCall = -1;
        sitrecAPI.api.__probe = {fn: () => {
            armedDuringCall = mockGlobalsState.errorDialogSinks.size;
            return {success: true};
        }};

        await sitrecAPI.handleAPICall({fn: '__probe', args: {}}, 'ui');

        expect(armedDuringCall).toBe(0);
    });

    test('a call nested inside an agent call is agent-driven too, and bubbles up', async () => {
        sitrecAPI.api.__inner = {fn: () => {
            raiseDialog('inner could not do that');
            return {success: true};
        }};
        // "ui" on purpose: re-entry through call() must not re-expose the dialog.
        sitrecAPI.api.__outer = {fn: async () => {
            await sitrecAPI.handleAPICall({fn: '__inner', args: {}}, 'ui');
            return {success: true};
        }};

        const r = await sitrecAPI.handleAPICall({fn: '__outer', args: {}}, 'chat');

        expect(r.errorDialogs).toEqual(['inner could not do that']);
        expect(mockGlobalsState.errorDialogSinks.size).toBe(0);
    });

    test('one agent call finishing does not disarm another still running', async () => {
        // The two calls interleave and finish out of order, which is what the MCP bridge
        // does: it answers each request independently rather than queueing them. Saving
        // and restoring a single global here disarmed the hook the moment the FIRST call
        // returned - so the second call's dialogs hit the screen, and the restore then
        // left the hook pointing at a dead array, silently eating every later error the
        // user was meant to see.
        let finishA, finishB;
        sitrecAPI.api.__a = {fn: () => new Promise(resolve => { finishA = resolve; })};
        sitrecAPI.api.__b = {fn: () => new Promise(resolve => { finishB = resolve; })};

        const a = sitrecAPI.handleAPICall({fn: '__a', args: {}}, 'mcp');
        const b = sitrecAPI.handleAPICall({fn: '__b', args: {}}, 'mcp');
        expect(mockGlobalsState.errorDialogSinks.size).toBe(2);

        finishA({success: true});
        await a;

        // B is still in flight, so its dialogs must still be captured, not shown
        expect(mockGlobalsState.errorDialogSinks.size).toBe(1);
        raiseDialog('raised while B was still running');

        finishB({success: true});
        expect((await b).errorDialogs).toEqual(['raised while B was still running']);

        // and nothing is left armed to swallow a dialog the user should get
        expect(mockGlobalsState.errorDialogSinks.size).toBe(0);
    });

    test('a dialog raised by one call is not reported to another running beside it', async () => {
        // Broadcasting to every live sink meant an unrelated caller got - and could act
        // on - this call's failure text. A handler's synchronous body is attributed to
        // exactly one call, which covers all but a handful of handlers.
        let finishSlow;
        sitrecAPI.api.__slow = {fn: () => new Promise(resolve => { finishSlow = resolve; })};
        sitrecAPI.api.__probe = {fn: () => {
            raiseDialog('this belongs to __probe');
            return {success: false, error: 'probe failed'};
        }};

        const slow = sitrecAPI.handleAPICall({fn: '__slow', args: {}}, 'mcp');
        const probe = await sitrecAPI.handleAPICall({fn: '__probe', args: {}}, 'mcp');

        expect(probe.errorDialogs).toEqual(['this belongs to __probe']);

        finishSlow({success: true});
        expect((await slow).errorDialogs).toBeUndefined();   // not told about __probe
        expect(mockGlobalsState.errorDialogSinks.size).toBe(0);
        expect(mockGlobalsState.errorDialogTarget).toBeNull();
    });

    test('the attribution window closes when a handler awaits, and does not leak', async () => {
        let released;
        const gate = new Promise(resolve => { released = resolve; });
        let targetAfterAwait = 'unset';
        sitrecAPI.api.__probe = {fn: async () => {
            await gate;
            targetAfterAwait = mockGlobalsState.errorDialogTarget;
            return {success: true};
        }};

        const call = sitrecAPI.handleAPICall({fn: '__probe', args: {}}, 'mcp');
        // The synchronous body has already yielded, so nothing is claiming dialogs...
        expect(mockGlobalsState.errorDialogTarget).toBeNull();
        released();
        await call;
        // ...including after it resumes, so a later overlapping call cannot inherit it
        expect(targetAfterAwait).toBeNull();
    });

    test('an invented function name comes back with the real ones', async () => {
        const r = await sitrecAPI.handleAPICall({fn: 'setMenu', args: {}}, 'chat');

        expect(r.success).toBe(false);
        expect(r.suggestions).toEqual(expect.arrayContaining(['setMenuValue']));
    });

    test('a throw comes back with the parameters the function actually takes', async () => {
        sitrecAPI.api.__probe = {
            params: {lat: 'Latitude in degrees (float)'},
            fn: () => { throw new Error('boom'); },
        };

        const r = await sitrecAPI.handleAPICall({fn: '__probe', args: {}}, 'chat');

        expect(r).toMatchObject({
            success: false,
            error: 'boom',
            expected: {lat: 'Latitude in degrees (float)'},
        });
    });
});

describe('CSitrecAPI menu control resolution', () => {
    const GUI = require('../src/js/lil-gui.esm');

    // lil-gui stand-ins: _resolveControl reads .controllers, and picks folders out of
    // .children with `instanceof GUI`, so the folders must share that prototype.
    function control(name, initial = false) {
        let value = initial;
        return {_name: name, property: name, initialValue: initial,
                getValue: () => value, setValue: (v) => { value = v; }};
    }
    function menu(title, controllers = [], folders = []) {
        const g = Object.create(GUI.prototype);
        g._title = title;
        g.controllers = controllers;
        g.children = [...controllers, ...folders];
        return g;
    }

    let editMode;
    beforeEach(() => {
        editMode = control('Edit Mode');
        mockGuiMenus.view = menu('view', [control('Main FOV')]);
        mockGuiMenus.video = menu('video', [], [
            menu('Annotate', [editMode, control('Show Annotations')]),
        ]);
    });
    afterEach(() => {
        delete mockGuiMenus.view;
        delete mockGuiMenus.video;
    });

    test('a wrong menu id no longer hides a control that exists elsewhere', () => {
        // The exact call the chatbot made: Annotate lives in `video`, not `view`.
        const r = sitrecAPI._setMenuValue('view', 'Annotate/Edit Mode', true);

        expect(r.success).toBe(true);
        expect(editMode.getValue()).toBe(true);
    });

    test('a misspelt control returns the real address to retry with', () => {
        const r = sitrecAPI._setMenuValue('view', 'Annotate/Edt Mode', true);

        expect(r.success).toBe(false);
        expect(r.suggestions[0]).toBe('video:Annotate/Edit Mode');
        expect(r.error).toContain('Did you mean');
    });

    test('a suggested address can be fed straight back in', () => {
        // Otherwise the suggestion is not valid input: retrying it fails and returns the
        // same suggestion, which is a loop rather than a recovery.
        const suggested = sitrecAPI._setMenuValue('view', 'Annotate/Edt Mode', true).suggestions[0];

        const r = sitrecAPI._setMenuValue(null, suggested, true);

        expect(r.success).toBe(true);
        expect(editMode.getValue()).toBe(true);
    });

    test('a control that matches nothing suggests nothing, rather than noise', () => {
        const r = sitrecAPI._setMenuValue('view', 'Xyzzyphlogiston', true);

        expect(r.success).toBe(false);
        expect(r.suggestions).toBeUndefined();
    });

    test('an unknown menu names the menus that do exist', () => {
        const r = sitrecAPI._getMenuValue('vidoe', 'Edit Mode');

        expect(r.success).toBe(false);
        expect(r.error).toContain('view, video');
    });
});
