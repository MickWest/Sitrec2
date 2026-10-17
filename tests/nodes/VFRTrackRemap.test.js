import {CNodeTrack} from "../../src/nodes/CNodeTrack";
import {CNodeSplineEditor} from "../../src/nodes/CNodeSplineEdit";

// VFR Fix converters (src/VFRTimeline.js) on tracks, called on stand-ins: the conversion
// only touches the fields shown here.

test("cached ground elevations move with their frames", () => {
    const a = {lat: 1}, b = {lat: 2}, c = {lat: 3};
    const track = {elevationCache: [a, null, b, c]};
    // Frames 2 and 3 land on one frame: the first entry is kept.
    CNodeTrack.prototype.remapFrames.call(track, f => [0, 2, 4, 4][f]);
    expect(track.elevationCache[0]).toBe(a);
    expect(track.elevationCache[2]).toBeUndefined();
    expect(track.elevationCache[4]).toBe(b);
    expect(track.elevationCache.filter(Boolean)).toHaveLength(2);
});

test("a spline track's control points move to the new frames through the undo path", () => {
    let restored = null;
    const editor = {
        frameNumbers: [0, 117, 914],
        captureState() { return {positions: [{x: 1}, {x: 2}, {x: 3}], frameNumbers: [...this.frameNumbers]}; },
        restoreState(state) { restored = state; },
    };
    const node = {elevationCache: null, splineEditor: editor, recalculateCascade: jest.fn()};
    CNodeSplineEditor.prototype.remapFrames.call(node, f => (f === 914 ? 1110 : f === 117 ? 131 : f), {});
    expect(restored.frameNumbers).toEqual([0, 131, 1110]);
    expect(restored.positions).toEqual([{x: 1}, {x: 2}, {x: 3}]);
    expect(node.recalculateCascade).toHaveBeenCalled();
});
