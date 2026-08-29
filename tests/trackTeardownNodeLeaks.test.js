// Tests for the node leaks left behind when a synthetic track is torn down —
// by the "Remove Track" button, and by undoing an "Add Object".
//
// Measured live before the fix: creating one object added 28 nodes and undoing it
// left 8 registered in NodeMan. Two independent causes, one per describe block below.

import fs from 'fs';
import path from 'path';
import {CNode, CNodeConstant} from '../src/nodes/CNode';
import {CNodeManager} from '../src/nodes/CNodeManager';
import {setFileManager, setNodeMan} from '../src/Globals';

class Consumer extends CNode {
    constructor(v) {
        super(v);
        this.input("width");        // a plain number here gets auto-wrapped
    }
    getValueFrame() { return 0; }
}

// Cause 1: CNode.addInput() wraps a scalar input in a CNodeConstant id'ed
// `<nodeId>_<inputKey>` and flags it pruneIfUnused, because (quoting CNode.js)
// "these auto nodes are not managed by their creators". Removing the consumer
// detaches the constant but does not dispose it; something must run the prune.
// CMetaTrack.dispose() always did. disposeSyntheticTrack() never reached it,
// because it this.remove()s the track object instead of disposeRemove()ing it —
// so syntheticTrackDisplay_<ts>_width survived every synthetic-track removal.
describe('auto-wrapped scalar inputs are reaped after their consumer goes', () => {

    let nodeMan;
    beforeEach(() => {
        nodeMan = new CNodeManager();
        setNodeMan(nodeMan);
        // CNode.dispose() calls FileManager.removeExportButton(this); the real manager
        // is not needed here, only that the call resolves.
        setFileManager({removeExportButton: () => {}});
    });

    test('a scalar input is wrapped in a prunable constant under <id>_<key>', () => {
        new Consumer({id: 'display', width: 1});
        expect(nodeMan.exists('display_width')).toBe(true);
        expect(nodeMan.get('display_width').pruneIfUnused).toBe(true);
    });

    test('removing the consumer alone leaves the constant registered', () => {
        // This is the leak itself — pinned so the prune below is shown to be load-bearing.
        new Consumer({id: 'display', width: 1});
        nodeMan.unlinkDisposeRemove('display');
        expect(nodeMan.exists('display')).toBe(false);
        expect(nodeMan.exists('display_width')).toBe(true);
    });

    test('pruneUnusedFlagged() then reaps it', () => {
        new Consumer({id: 'display', width: 1});
        nodeMan.unlinkDisposeRemove('display');
        nodeMan.pruneUnusedFlagged();
        expect(nodeMan.exists('display_width')).toBe(false);
    });

    test('the prune spares a constant that is still connected', () => {
        // Two tracks share the manager; removing one must not strip the other's inputs.
        new Consumer({id: 'displayA', width: 1});
        new Consumer({id: 'displayB', width: 1});
        nodeMan.unlinkDisposeRemove('displayA');
        nodeMan.pruneUnusedFlagged();
        expect(nodeMan.exists('displayA_width')).toBe(false);
        expect(nodeMan.exists('displayB_width')).toBe(true);
        expect(nodeMan.exists('displayB')).toBe(true);
    });

    test('the prune spares an unconnected node that is NOT flagged prunable', () => {
        // The synthetic track's Alt offset / Alt Lock controls are deliberately not
        // prunable: they drive their track through onChange, so they have no edges at
        // all and a blanket sweep would delete controls of a track that still exists.
        const keep = new CNodeConstant({id: 'altOffset', value: 0});
        keep.pruneIfUnused = false;
        nodeMan.pruneUnusedFlagged();
        expect(nodeMan.exists('altOffset')).toBe(true);
    });
});

// Wiring guards. TrackManager.js and PointEditor.js are both awkward to exercise
// directly under Jest (a live scene, view and DOM), so the call sites are pinned by
// reading the source — as tests/nodeRegistration.test.js does. In both cases the bug
// was the absence of a call, not a misbehaving function.
describe('teardown call sites', () => {

    const read = (...p) => fs.readFileSync(path.resolve(__dirname, '..', ...p), 'utf-8');

    function functionBody(source, signature) {
        const start = source.indexOf(signature);
        expect(start).toBeGreaterThan(-1);
        const end = source.indexOf('\n    }', start);
        expect(end).toBeGreaterThan(start);
        return source.slice(start, end);
    }

    test('disposeSyntheticTrack() runs pruneUnusedFlagged()', () => {
        const body = functionBody(read('src', 'TrackManager.js'), '\n    disposeSyntheticTrack(trackID) {');
        expect(body).toMatch(/NodeMan\.pruneUnusedFlagged\(\)/);
    });

    // Cause 2: PointEditor.dispose() called node.dispose() on its two measurement
    // nodes. That frees the node's own resources but leaves it REGISTERED, so each
    // editor teardown leaked pointEditor_measure_<uid> (+ _x/_y/_z) and
    // pointEditor_measureAlt_<uid> (+ _Below, _color_colorInput) — 7 nodes.
    test('PointEditor.dispose() unregisters its measurement nodes from NodeMan', () => {
        const body = functionBody(read('src', 'PointEditor.js'), 'dispose() {');
        expect(body).toMatch(/NodeMan\.unlinkDisposeRemove\(/);
    });

    test('PointEditor.dispose() no longer relies on a bare node.dispose()', () => {
        // A bare dispose() here is what caused the leak; it must not come back.
        const body = functionBody(read('src', 'PointEditor.js'), 'dispose() {');
        expect(body).not.toMatch(/this\.measureAltitude\.dispose\(\)/);
        expect(body).not.toMatch(/this\.measurePoint\.dispose\(\)/);
    });

    test('PointEditor records the ids its measurement nodes created', () => {
        // The sub-nodes are not reachable from the two handles (_color_colorInput is
        // not even an input), so dispose() has to sweep a recorded list.
        const source = read('src', 'PointEditor.js');
        expect(source).toMatch(/_measureNodeIDs/);
    });
});
