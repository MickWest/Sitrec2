/**
 * @jest-environment jsdom
 */

var mockNodeGet = jest.fn();
var mockMarkSitchDirty = jest.fn();
var mockSetNewSitchObject = jest.fn();
var mockWithTestUser = jest.fn((url) => url);
var mockSetStartDateTime = jest.fn();

var mockCustomManager;
var mockFileManager;
var mockGlobalsState;
var mockSit;
var mockSitchMan;

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
        guiMenus: {},
        markSitchDirty: (...args) => mockMarkSitchDirty(...args),
        NodeMan: {get: (...args) => mockNodeGet(...args)},
        Sit: mockSit,
        SitchMan: mockSitchMan,
        TrackManager: {},
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
    Object.keys(mockGlobalsState).forEach((key) => {
        if (key !== 'sitchDirty') {
            delete mockGlobalsState[key];
        }
    });
    mockGlobalsState.sitchDirty = false;
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

        expect(result).toEqual({
            success: true,
            fn: 'importMedia',
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
            success: true,
            fn: 'loadSitch',
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
            success: true,
            fn: 'saveSitch',
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