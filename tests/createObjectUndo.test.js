// Unit tests for the synthetic-object creation undo/redo action
// (src/undoCreateObject.js), the testable seam behind
// CustomManager.createObjectFromInput's undo support.
//
// Background: addObjectAtLLA (API) and the "Add Object" menu both route through
// createObjectFromInput, which previously pushed NO undo action — a created object
// could not be undone. The fix registers makeCreateObjectUndoAction(); these tests
// pin its behaviour. The end-to-end behaviour is also covered by the fast-regression
// scenario tests_regression/fast-regression/scenarios/custom/custom-undo-redo.scenario.mjs.
//
// The action removes the object through the injected deleteObject, which in the app is
// CustomManager.deleteObject: the one function that removes a user-made object and every
// node it made. What that function removes is tested in deleteObjectAndTrack.test.js.

import {makeCreateObjectUndoAction} from '../src/undoCreateObject';

function makeMocks() {
    const trackManager = {exists: jest.fn(() => true), disposeRemove: jest.fn()};
    const deleteObject = jest.fn();
    return {trackManager, deleteObject};
}

describe('makeCreateObjectUndoAction', () => {
    test('produces a valid UndoManager action (undo, redo, description)', () => {
        const {trackManager, deleteObject} = makeMocks();
        const action = makeCreateObjectUndoAction({
            name: 'TestOb', objectID: 'O1', trackID: 'T1',
            trackManager, deleteObject, recreate: () => ({objectID: 'O2', trackID: 'T2'}),
        });
        expect(typeof action.undo).toBe('function');
        expect(typeof action.redo).toBe('function');
        expect(action.description).toBe('Create object "TestOb"');
    });

    test('undo removes BOTH the object and the track', () => {
        const {trackManager, deleteObject} = makeMocks();
        const action = makeCreateObjectUndoAction({
            name: 'TestOb', objectID: 'O1', trackID: 'T1',
            trackManager, deleteObject, recreate: () => ({}),
        });
        action.undo();
        expect(deleteObject).toHaveBeenCalledWith('O1');
        expect(trackManager.disposeRemove).toHaveBeenCalledWith('T1');
    });

    test('undo removes the object through deleteObject, once, and nothing else of it', () => {
        // The action has no list of the nodes of the object, and no node manager: only
        // deleteObject knows what an object is made of.
        const {trackManager, deleteObject} = makeMocks();
        const action = makeCreateObjectUndoAction({
            name: 'X', objectID: 'O1', trackID: 'T1', trackManager, deleteObject, recreate: () => ({}),
        });
        action.undo();
        expect(deleteObject.mock.calls).toEqual([['O1']]);
        expect(trackManager.disposeRemove.mock.calls).toEqual([['T1']]);
    });

    test('undo removes the object BEFORE the track', () => {
        // The order of "Delete Track and Object". The other order puts the object on its
        // manual position, and into the track selectors, a moment before it is deleted.
        const {trackManager, deleteObject} = makeMocks();
        const order = [];
        trackManager.disposeRemove.mockImplementation(() => order.push('track'));
        deleteObject.mockImplementation(() => order.push('object'));
        const action = makeCreateObjectUndoAction({
            name: 'X', objectID: 'O1', trackID: 'T1', trackManager, deleteObject, recreate: () => ({}),
        });
        action.undo();
        expect(order).toEqual(['object', 'track']);
    });

    test('undo does not dispose a track that is already gone', () => {
        const {trackManager, deleteObject} = makeMocks();
        trackManager.exists.mockReturnValue(false);
        const action = makeCreateObjectUndoAction({
            name: 'X', objectID: 'O1', trackID: 'T1', trackManager, deleteObject, recreate: () => ({}),
        });
        action.undo();
        expect(trackManager.disposeRemove).not.toHaveBeenCalled();
        // deleteObject does nothing itself for an object that is gone
        expect(deleteObject).toHaveBeenCalledWith('O1');
    });

    test('redo invokes recreate', () => {
        const {trackManager, deleteObject} = makeMocks();
        const recreate = jest.fn(() => ({objectID: 'O2', trackID: 'T2'}));
        const action = makeCreateObjectUndoAction({
            name: 'X', objectID: 'O1', trackID: 'T1', trackManager, deleteObject, recreate,
        });
        action.redo();
        expect(recreate).toHaveBeenCalledTimes(1);
    });

    test('after redo, a subsequent undo targets the RECREATED ids (mutable-id closure)', () => {
        const {trackManager, deleteObject} = makeMocks();
        const action = makeCreateObjectUndoAction({
            name: 'X', objectID: 'O1', trackID: 'T1',
            trackManager, deleteObject, recreate: () => ({objectID: 'O2', trackID: 'T2'}),
        });
        action.undo();                       // removes original O1/T1
        action.redo();                       // recreates -> live ids become O2/T2
        action.undo();                       // must now remove O2/T2, NOT O1/T1
        expect(trackManager.disposeRemove).toHaveBeenLastCalledWith('T2');
        expect(deleteObject).toHaveBeenLastCalledWith('O2');
    });

    test('redo tolerates a recreate that returns nothing', () => {
        const {trackManager, deleteObject} = makeMocks();
        const action = makeCreateObjectUndoAction({
            name: 'X', objectID: 'O1', trackID: 'T1',
            trackManager, deleteObject, recreate: () => undefined,
        });
        expect(() => action.redo()).not.toThrow();
        // live ids cleared -> a following undo removes nothing (guards on falsy id)
        action.undo();
        expect(trackManager.disposeRemove).not.toHaveBeenCalled();
        expect(deleteObject).not.toHaveBeenCalled();
    });
});
