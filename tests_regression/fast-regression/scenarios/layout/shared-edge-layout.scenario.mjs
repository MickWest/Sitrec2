// Strategy C — ADJACENCY SHARED-EDGE layout acceptance test (replaces the old guillotine
// split-tree test). Views are free rectangles; wherever two views' edges are flush — even for
// only PART of the length — a draggable seam couples them. Pins:
//   - seam detection: two flush edges form a seam (before=left/top view, after=right/bottom),
//   - partial edges: the seam spans only the overlapping run,
//   - connected-only coupling: two disjoint adjacencies at the same coordinate are SEPARATE
//     seams (so dragging one leaves the other alone),
//   - horizontal seams (bottom-against-top),
//   - drag geometry: the 'before' view grows/shrinks its far edge, the 'after' view moves its
//     near edge — both by the same delta, staying flush,
//   - the drag clamps the shrinking side at the minimum tile size,
//   - View ▸ Reset Layout snaps the views into a clean default grid (Main on the left half).
//
// Detection + drag geometry run on SYNTHETIC rects / snapshots, so they're viewport- and
// render-timing-independent; Reset Layout reads back the fractions it sets (then restores them).
export default {
    id: 'shared-edge-layout',
    sitch: 'Layout Test',
    builtin: false,
    url: '99999999/Layout Test/20260622_163801.js',
    frame: 10,
    tier: 'value',
    network: 'none',
    steps: [
        // A full vertical shared edge: A (left half) flush against B (right half).
        {
            type: 'assert', name: 'fullSharedEdgeFormsSeam',
            fn: `() => {
                const seams = window.LayoutMan._computeSeams([
                    {id:'A', l:0, t:0, r:500, b:1000},
                    {id:'B', l:500, t:0, r:1000, b:1000},
                ]);
                const s = seams[0] || {};
                return {n: seams.length, dir: s.dir, coord: s.coord, start: s.start, end: s.end,
                    before: (s.before||[]).join(','), after: (s.after||[]).join(',')};
            }`,
            equals: {n: 1, dir: 'v', coord: 500, start: 0, end: 1000, before: 'A', after: 'B'},
        },
        // A partial edge: A is shorter, so it shares only its own height with full-height B.
        {
            type: 'assert', name: 'partialEdgeSpansOnlyOverlap',
            fn: `() => {
                const seams = window.LayoutMan._computeSeams([
                    {id:'A', l:0, t:0, r:500, b:600},
                    {id:'B', l:500, t:0, r:1000, b:1000},
                ]);
                const s = seams[0] || {};
                return {n: seams.length, dir: s.dir, start: s.start, end: s.end,
                    before: (s.before||[]).join(','), after: (s.after||[]).join(',')};
            }`,
            equals: {n: 1, dir: 'v', start: 0, end: 600, before: 'A', after: 'B'},
        },
        // Two disjoint adjacencies at the SAME x (top pair A|B, bottom pair C|D, with a gap)
        // must be two separate seams — connected-only coupling.
        {
            type: 'assert', name: 'disjointAdjacenciesAreSeparateSeams',
            fn: `() => {
                const seams = window.LayoutMan._computeSeams([
                    {id:'A', l:0, t:0,   r:500,  b:400},
                    {id:'B', l:500, t:0, r:1000, b:400},
                    {id:'C', l:0, t:600, r:500,  b:1000},
                    {id:'D', l:500, t:600, r:1000, b:1000},
                ]).filter(s => s.dir === 'v');
                return {n: seams.length};
            }`,
            equals: {n: 2},
        },
        // A horizontal shared edge: A (top) flush against B (bottom).
        {
            type: 'assert', name: 'horizontalSharedEdgeFormsSeam',
            fn: `() => {
                const seams = window.LayoutMan._computeSeams([
                    {id:'A', l:0, t:0, r:1000, b:500},
                    {id:'B', l:0, t:500, r:1000, b:1000},
                ]);
                const s = seams[0] || {};
                return {n: seams.length, dir: s.dir, coord: s.coord,
                    before: (s.before||[]).join(','), after: (s.after||[]).join(',')};
            }`,
            equals: {n: 1, dir: 'h', coord: 500, before: 'A', after: 'B'},
        },
        // Drag geometry: move a vertical seam +100px. 'before' (left, width 500) grows to 600;
        // 'after' (right, left 500/width 500) moves its left edge to 600 and shrinks to 400 —
        // so their shared edge stays flush at x=600. (Container 1000 → fractions.)
        {
            type: 'assert', name: 'seamDragMovesBothEdgesTogether',
            fn: `() => {
                const before = [{v:{}, l:0,   t:0, w:500, h:1000, cw:1000, ch:1000, cl:0, ct:0}];
                const after  = [{v:{}, l:500, t:0, w:500, h:1000, cw:1000, ch:1000, cl:0, ct:0}];
                window.LayoutMan._applySeam(before, after, 100, true);
                return {
                    beforeWidth: +before[0].v.width.toFixed(3),
                    afterLeft:   +after[0].v.left.toFixed(3),
                    afterWidth:  +after[0].v.width.toFixed(3),
                };
            }`,
            equals: {beforeWidth: 0.6, afterLeft: 0.6, afterWidth: 0.4},
        },
        // Clamp: dragging +100 toward a 200px-wide 'after' view is clamped so it can't shrink
        // below the 128px MIN_VIEW_PX minimum → only 72px (200-128) is applied.
        {
            type: 'assert', name: 'seamDragClampsAtMinimumSize',
            fn: `() => {
                const d = window.LayoutMan._clampSeamDelta([{w:500,h:0}], [{w:200,h:0}], 100, true);
                return {d};
            }`,
            equals: {d: 72},
        },
        // View ▸ Reset Layout: snap the open views into a default grid — Main takes the left half.
        {
            type: 'assert', name: 'resetLayoutPutsMainOnLeftHalf',
            fn: `() => {
                const V = window.ViewMan, L = window.LayoutMan;
                const ids = ['mainView', 'video', 'lookView'];
                const orig = {};
                ids.forEach(id => { const v = V.get(id, false);
                    if (v) orig[id] = {left:v.left, top:v.top, width:v.width, height:v.height}; });
                L.resetLayout();
                const m = V.get('mainView', false);
                const res = {mainLeft: +m.left.toFixed(3), mainWidth: +m.width.toFixed(3)};
                ids.forEach(id => { const v = V.get(id, false); if (v && orig[id]) Object.assign(v, orig[id]); });
                return res;
            }`,
            equals: {mainLeft: 0, mainWidth: 0.5},
        },
    ],
};
