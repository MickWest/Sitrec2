// Unit tests for the synthetic-object creation undo/redo action
// (src/undoCreateObject.js), the testable seam behind
// CustomManager.createObjectFromInput's undo support.
//
// Background: addObjectAtLLA (API) and the "Add Object" menu both route through
// createObjectFromInput, which previously pushed NO undo action — a created object
// could not be undone. The fix registers makeCreateObjectUndoAction(); these tests
// pin its behaviour. The end-to-end behaviour is also covered by the fast-regression
// scenario tests_regression/fast-regression/scenarios/custom/custom-undo-redo.scenario.mjs.

import {makeCreateObjectUndoAction} from '../src/undoCreateObject';

function makeMocks() {
    const trackManager = {exists: jest.fn(() => true), disposeRemove: jest.fn()};
    const nodeMan = {exists: jest.fn(() => true), unlinkDisposeRemove: jest.fn()};
    return {trackManager, nodeMan};
}

describe('makeCreateObjectUndoAction', () => {
    test('produces a valid UndoManager action (undo, redo, description)', () => {
        const {trackManager, nodeMan} = makeMocks();
        const action = makeCreateObjectUndoAction({
            name: 'TestOb', objectID: 'O1', trackID: 'T1',
            trackManager, nodeMan, recreate: () => ({objectID: 'O2', trackID: 'T2'}),
        });
        expect(typeof action.undo).toBe('function');
        expect(typeof action.redo).toBe('function');
        expect(action.description).toBe('Create object "TestOb"');
    });

    test('undo removes BOTH the track and the object node', () => {
        const {trackManager, nodeMan} = makeMocks();
        const action = makeCreateObjectUndoAction({
            name: 'TestOb', objectID: 'O1', trackID: 'T1',
            trackManager, nodeMan, recreate: () => ({}),
        });
        action.undo();
        expect(trackManager.disposeRemove).toHaveBeenCalledWith('T1');
        expect(nodeMan.unlinkDisposeRemove).toHaveBeenCalledWith('O1');
    });

    test('undo removes the track BEFORE the object node', () => {
        const {trackManager, nodeMan} = makeMocks();
        const order = [];
        trackManager.disposeRemove.mockImplementation(() => order.push('track'));
        nodeMan.unlinkDisposeRemove.mockImplementation(() => order.push('object'));
        const action = makeCreateObjectUndoAction({
            name: 'X', objectID: 'O1', trackID: 'T1', trackManager, nodeMan, recreate: () => ({}),
        });
        action.undo();
        expect(order).toEqual(['track', 'object']);
    });

    test('undo skips removal when the nodes are already gone', () => {
        const {trackManager, nodeMan} = makeMocks();
        trackManager.exists.mockReturnValue(false);
        nodeMan.exists.mockReturnValue(false);
        const action = makeCreateObjectUndoAction({
            name: 'X', objectID: 'O1', trackID: 'T1', trackManager, nodeMan, recreate: () => ({}),
        });
        action.undo();
        expect(trackManager.disposeRemove).not.toHaveBeenCalled();
        expect(nodeMan.unlinkDisposeRemove).not.toHaveBeenCalled();
    });

    test('redo invokes recreate', () => {
        const {trackManager, nodeMan} = makeMocks();
        const recreate = jest.fn(() => ({objectID: 'O2', trackID: 'T2'}));
        const action = makeCreateObjectUndoAction({
            name: 'X', objectID: 'O1', trackID: 'T1', trackManager, nodeMan, recreate,
        });
        action.redo();
        expect(recreate).toHaveBeenCalledTimes(1);
    });

    test('after redo, a subsequent undo targets the RECREATED ids (mutable-id closure)', () => {
        const {trackManager, nodeMan} = makeMocks();
        const action = makeCreateObjectUndoAction({
            name: 'X', objectID: 'O1', trackID: 'T1',
            trackManager, nodeMan, recreate: () => ({objectID: 'O2', trackID: 'T2'}),
        });
        action.undo();                       // removes original O1/T1
        action.redo();                       // recreates -> live ids become O2/T2
        action.undo();                       // must now remove O2/T2, NOT O1/T1
        expect(trackManager.disposeRemove).toHaveBeenLastCalledWith('T2');
        expect(nodeMan.unlinkDisposeRemove).toHaveBeenLastCalledWith('O2');
    });

    test('redo tolerates a recreate that returns nothing', () => {
        const {trackManager, nodeMan} = makeMocks();
        const action = makeCreateObjectUndoAction({
            name: 'X', objectID: 'O1', trackID: 'T1',
            trackManager, nodeMan, recreate: () => undefined,
        });
        expect(() => action.redo()).not.toThrow();
        // live ids cleared -> a following undo removes nothing (guards on falsy id)
        action.undo();
        expect(trackManager.disposeRemove).not.toHaveBeenCalled();
        expect(nodeMan.unlinkDisposeRemove).not.toHaveBeenCalled();
    });
});

// The object leaks its auto-created sub-nodes on undo:
// CNode3DObject registers _size, _color_colorInput, _modelLength and three controllers
// (plus a _window GUI value) under the object id. unlinkDisposeRemove(objectID) severs
// the object's edges but disposes only the object, so those stayed in NodeMan after an
// undo - measured live: 6 orphans left per created object.
describe('makeCreateObjectUndoAction - auto-created sub-node cleanup', () => {

    // The real ids observed from a live createObjectFromInput, minus the object itself.
    const SUB_NODES = [
        'O1_size',
        'O1_color_colorInput',
        'O1_modelLength',
        'O1_ControllerTrackPosition',
        'O1_ControllerObjectTilt',
        'O1_ControllerObjectTiltSmoothed',
        'O1_ControllerObjectTiltSmoothed_window',
    ];

    test('undo removes every owned sub-node as well as the object', () => {
        const {trackManager, nodeMan} = makeMocks();
        const action = makeCreateObjectUndoAction({
            name: 'X', objectID: 'O1', trackID: 'T1', ownedNodeIds: SUB_NODES,
            trackManager, nodeMan, recreate: () => ({}),
        });
        action.undo();
        const removed = nodeMan.unlinkDisposeRemove.mock.calls.map(c => c[0]);
        for (const id of SUB_NODES) {
            expect(removed).toContain(id);
        }
        expect(removed).toContain('O1');
        expect(removed).toHaveLength(SUB_NODES.length + 1);
    });

    test('the object node goes LAST, after its sub-nodes', () => {
        // Its inputs must still be linked while they are removed, so nothing is
        // disposed holding a dangling reference to the object.
        const {trackManager, nodeMan} = makeMocks();
        const action = makeCreateObjectUndoAction({
            name: 'X', objectID: 'O1', trackID: 'T1', ownedNodeIds: SUB_NODES,
            trackManager, nodeMan, recreate: () => ({}),
        });
        action.undo();
        const removed = nodeMan.unlinkDisposeRemove.mock.calls.map(c => c[0]);
        expect(removed[removed.length - 1]).toBe('O1');
    });

    test('the track still goes before any node removal', () => {
        const {trackManager, nodeMan} = makeMocks();
        const order = [];
        trackManager.disposeRemove.mockImplementation(() => order.push('track'));
        nodeMan.unlinkDisposeRemove.mockImplementation(id => order.push(id));
        const action = makeCreateObjectUndoAction({
            name: 'X', objectID: 'O1', trackID: 'T1', ownedNodeIds: ['O1_size'],
            trackManager, nodeMan, recreate: () => ({}),
        });
        action.undo();
        expect(order).toEqual(['track', 'O1_size', 'O1']);
    });

    test('skips sub-nodes the track teardown already removed', () => {
        // disposeSyntheticTrack + pruneUnusedFlagged may have taken some of them.
        const {trackManager, nodeMan} = makeMocks();
        nodeMan.exists.mockImplementation(id => id !== 'O1_size');
        const action = makeCreateObjectUndoAction({
            name: 'X', objectID: 'O1', trackID: 'T1', ownedNodeIds: ['O1_size', 'O1_modelLength'],
            trackManager, nodeMan, recreate: () => ({}),
        });
        action.undo();
        const removed = nodeMan.unlinkDisposeRemove.mock.calls.map(c => c[0]);
        expect(removed).not.toContain('O1_size');
        expect(removed).toEqual(['O1_modelLength', 'O1']);
    });

    test('defaults to no sub-nodes when ownedNodeIds is omitted', () => {
        // Keeps older call sites (and the deserialize path) working unchanged.
        const {trackManager, nodeMan} = makeMocks();
        const action = makeCreateObjectUndoAction({
            name: 'X', objectID: 'O1', trackID: 'T1',
            trackManager, nodeMan, recreate: () => ({}),
        });
        expect(() => action.undo()).not.toThrow();
        expect(nodeMan.unlinkDisposeRemove.mock.calls.map(c => c[0])).toEqual(['O1']);
    });

    test('after redo, undo sweeps the RECREATED sub-nodes, not the stale ones', () => {
        // Redo builds a fresh object under a fresh id, so the old sweep list is dead.
        const {trackManager, nodeMan} = makeMocks();
        const action = makeCreateObjectUndoAction({
            name: 'X', objectID: 'O1', trackID: 'T1', ownedNodeIds: ['O1_size'],
            trackManager, nodeMan, recreate: () => ({
                objectID: 'O2', trackID: 'T2', ownedNodeIds: ['O2_size'],
            }),
        });
        action.undo();
        action.redo();
        nodeMan.unlinkDisposeRemove.mockClear();
        action.undo();
        expect(nodeMan.unlinkDisposeRemove.mock.calls.map(c => c[0])).toEqual(['O2_size', 'O2']);
    });

    test('a recreate that omits ownedNodeIds leaves nothing stale to sweep', () => {
        const {trackManager, nodeMan} = makeMocks();
        const action = makeCreateObjectUndoAction({
            name: 'X', objectID: 'O1', trackID: 'T1', ownedNodeIds: ['O1_size'],
            trackManager, nodeMan, recreate: () => ({objectID: 'O2', trackID: 'T2'}),
        });
        action.redo();
        nodeMan.unlinkDisposeRemove.mockClear();
        action.undo();
        // O1_size must NOT be swept - it belonged to the disposed original
        expect(nodeMan.unlinkDisposeRemove.mock.calls.map(c => c[0])).toEqual(['O2']);
    });
});

