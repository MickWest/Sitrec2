// The frame slider's timeline menu: marker edits and Reset In/Out go on the undo stack and
// mark the sitch as changed, and a rename typed into the menu becomes one undo step when
// the menu closes.

var mockUndo = [];
var mockMarkSitchDirty = jest.fn();
var mockSit = {};
var mockMenuBar = null;
var mockDispatch = jest.fn();

jest.mock('../src/Globals', () => ({
    GlobalDateTimeNode: {liveMode: true},
    Globals: {get menuBar() { return mockMenuBar; }},
    markSitchDirty: (...args) => mockMarkSitchDirty(...args),
    setRenderOne: () => {},
    get Sit() { return mockSit; },
    UndoManager: {add: action => mockUndo.push(action)},
}));
jest.mock('../src/CEventManager', () => ({EventManager: {dispatchEvent: (...args) => mockDispatch(...args)}}));
jest.mock('../src/showError', () => ({showConfirm: jest.fn(async () => true)}));
jest.mock('../src/par', () => ({par: {frame: 5, playbackLocked: false}}));

import {editTimelineMarkers, resetInOut, showTimelineMenu} from '../src/TimelineMenu';
import {TimelineMarkers} from '../src/TimelineMarkers';

// A stand-in for the lil-gui menu that createStandaloneMenu returns: enough to find the
// controllers it adds and to close it.
function fakeMenu() {
    const controllers = [];
    const add = (object, property) => {
        const controller = {
            object, property,
            name(text) { this.label = text; return this; },
            onChange(fn) { this.changed = fn; return this; },
            disable() { this.disabled = true; return this; },
        };
        controllers.push(controller);
        return controller;
    };
    return {
        controllers, add,
        addFolder: () => ({add, close() {}}),
        title: jest.fn(),
        destroy: jest.fn(),
        open: jest.fn(),
    };
}

beforeEach(() => {
    mockUndo.length = 0;
    mockMarkSitchDirty.mockClear();
    mockDispatch.mockClear();
    Object.assign(mockSit, {frames: 100, aFrame: 0, bFrame: 99});
    TimelineMarkers.clear();
});

describe('timeline menu edits', () => {
    test('a marker edit is one undo step and marks the sitch changed, as do undo and redo', () => {
        editTimelineMarkers('Add timeline marker', () => TimelineMarkers.add(10, 'start'));
        expect(TimelineMarkers.list()).toEqual([{frame: 10, label: 'start'}]);
        expect(mockUndo).toHaveLength(1);
        expect(mockUndo[0].description).toBe('Add timeline marker');
        expect(mockMarkSitchDirty).toHaveBeenCalledTimes(1);

        mockUndo[0].undo();
        expect(TimelineMarkers.list()).toEqual([]);
        mockUndo[0].redo();
        expect(TimelineMarkers.list()).toEqual([{frame: 10, label: 'start'}]);
        expect(mockMarkSitchDirty).toHaveBeenCalledTimes(3);
    });

    test('an edit that changes nothing records nothing', () => {
        TimelineMarkers.add(10, 'start');
        const result = editTimelineMarkers('Delete timeline marker', () => TimelineMarkers.remove(20));
        expect(result).toBe(false);
        expect(mockUndo).toHaveLength(0);
        expect(mockMarkSitchDirty).not.toHaveBeenCalled();
    });

    test('Reset In/Out sets the whole sitch, undoably, and marks the sitch changed', () => {
        Object.assign(mockSit, {aFrame: 20, bFrame: 60});
        resetInOut();
        expect([mockSit.aFrame, mockSit.bFrame]).toEqual([0, 99]);
        expect(mockDispatch).toHaveBeenCalledWith('abFrameChanged');
        expect(mockMarkSitchDirty).toHaveBeenCalledTimes(1);
        mockUndo[0].undo();
        expect([mockSit.aFrame, mockSit.bFrame]).toEqual([20, 60]);
        mockUndo[0].redo();
        expect([mockSit.aFrame, mockSit.bFrame]).toEqual([0, 99]);
        // already reset: nothing to do
        resetInOut();
        expect(mockUndo).toHaveLength(1);
    });

    test('a rename applies as it is typed and becomes one undo step when the menu closes', () => {
        TimelineMarkers.add(10, 'old');
        const menu = fakeMenu();
        mockMenuBar = {createStandaloneMenu: () => menu, ensureMenuOnScreen() {}};
        showTimelineMenu({clientX: 0, clientY: 0}, 10, TimelineMarkers.get(10));
        const label = menu.controllers.find(controller => controller.property === 'label');

        label.changed('ne');
        label.changed('new');
        expect(TimelineMarkers.get(10).label).toBe('new');
        expect(mockMarkSitchDirty).toHaveBeenCalled();
        expect(mockUndo).toHaveLength(0);

        // however the menu closes, and however often, one record
        menu.destroy();
        menu.destroy();
        expect(mockUndo).toHaveLength(1);
        mockUndo[0].undo();
        expect(TimelineMarkers.get(10).label).toBe('old');
        mockUndo[0].redo();
        expect(TimelineMarkers.get(10).label).toBe('new');
    });

    test('closing the menu without a rename records nothing', () => {
        TimelineMarkers.add(10, 'same');
        const menu = fakeMenu();
        mockMenuBar = {createStandaloneMenu: () => menu, ensureMenuOnScreen() {}};
        showTimelineMenu({clientX: 0, clientY: 0}, 10, TimelineMarkers.get(10));
        menu.destroy();
        expect(mockUndo).toHaveLength(0);
    });
});
