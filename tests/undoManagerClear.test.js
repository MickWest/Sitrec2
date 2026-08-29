// Tests for UndoManager.clear() and, critically, for the fact that a sitch load
// actually CALLS it.
//
// Background: clear() has always existed on UndoManager but nothing in the app ever
// called it, so the undo/redo stacks survived a sitch load. Every action closes over
// nodes, tracks and GUI folders from the sitch being torn down, so Ctrl-Z in a freshly
// loaded sitch ran the PREVIOUS sitch's undo — at best a no-op that logged
// "Tried to unlinkDisposeRemove a node that does not exist", at worst a redo
// re-creating a track from the old sitch inside the new one.
//
// The fix calls undoManager.clear() from disposeEverything() in src/index.js, the single
// chokepoint every teardown passes through.

import fs from 'fs';
import path from 'path';
import {UndoManager, undoManager} from '../src/UndoManager';

function makeAction(description = 'act') {
    return {undo: jest.fn(), redo: jest.fn(), description};
}

describe('UndoManager.clear', () => {

    test('empties both stacks', () => {
        const um = new UndoManager();
        um.add(makeAction('a'));
        um.add(makeAction('b'));
        um.undo();                       // one action now sits on the redo stack
        expect(um.getStatus()).toMatchObject({undoCount: 1, redoCount: 1});

        um.clear();

        expect(um.getStatus()).toMatchObject({undoCount: 0, redoCount: 0});
        expect(um.canUndo()).toBe(false);
        expect(um.canRedo()).toBe(false);
    });

    test('a cleared manager will not run the old actions', () => {
        // The whole point: a stale action must never be invoked against the new sitch.
        const um = new UndoManager();
        const action = makeAction('stale');
        um.add(action);

        um.clear();

        expect(um.undo()).toBe(false);
        expect(um.redo()).toBe(false);
        expect(action.undo).not.toHaveBeenCalled();
        expect(action.redo).not.toHaveBeenCalled();
    });

    test('the manager is reusable after clearing', () => {
        // The next sitch has to be able to record its own undo history.
        const um = new UndoManager();
        um.add(makeAction('old'));
        um.clear();

        const fresh = makeAction('new');
        um.add(fresh);
        expect(um.getUndoDescription()).toBe('new');
        expect(um.undo()).toBe(true);
        expect(fresh.undo).toHaveBeenCalledTimes(1);
    });

    test('clearing an already-empty manager is harmless', () => {
        const um = new UndoManager();
        expect(() => um.clear()).not.toThrow();
        expect(um.getStatus()).toMatchObject({undoCount: 0, redoCount: 0});
    });

    test('the exported singleton has clear()', () => {
        // disposeEverything() calls it on this instance, not a fresh one.
        expect(typeof undoManager.clear).toBe('function');
    });
});

// Wiring guard. disposeEverything() lives in src/index.js, which cannot be imported
// under Jest (it runs the whole app at module scope), so the call is pinned by reading
// the source — the same approach tests/nodeRegistration.test.js uses. The bug here was
// never that clear() misbehaved; it was that nothing invoked it.
describe('sitch teardown clears the undo history', () => {

    const indexSource = fs.readFileSync(
        path.resolve(__dirname, '..', 'src', 'index.js'), 'utf-8');

    function disposeEverythingBody() {
        const start = indexSource.indexOf('function disposeEverything()');
        expect(start).toBeGreaterThan(-1);
        // Ends at the next top-level declaration; the trailing "\n}" of the function.
        const end = indexSource.indexOf('\n}', start);
        expect(end).toBeGreaterThan(start);
        return indexSource.slice(start, end);
    }

    test('disposeEverything() calls undoManager.clear()', () => {
        expect(disposeEverythingBody()).toMatch(/undoManager\.clear\(\)/);
    });

    test('index.js imports the undoManager singleton it clears', () => {
        expect(indexSource).toMatch(/import\s*\{[^}]*\bundoManager\b[^}]*\}\s*from\s*["']\.\/UndoManager["']/);
    });
});
