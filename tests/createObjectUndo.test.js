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
