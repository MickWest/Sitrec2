// Phase 2 — SPLIT-TREE TILING acceptance test (the "Layout Test" user custom sitch).
//
// Installs the canonical split-tree (main left | video over look right), forces the
// per-view geometry walk, then drags the root vertical divider and the inner horizontal
// divider and re-reads. Pins:
//   - the tree partitions the Content rect into the expected tiles (dividers reserved),
//   - a vertical-divider drag resizes main + the whole right column (coupled), leaving the
//     inner video/look split untouched,
//   - a horizontal-divider drag resizes video/look only.
// This is the LAYOUT-MODEL acceptance behaviour (docs/ui-redesign/LAYOUT-MODEL.md §Interactions).
//
// Deterministic: drives CNodeView.updateWH() directly (no render-loop timing) and captures
// container-relative FRACTIONS (viewport-independent). Restores legacy mode at the end.
export default {
    id: 'split-tree-layouttest',
    sitch: 'Layout Test',
    builtin: false,
    url: '99999999/Layout Test/20260622_163801.js',
    frame: 10,
    tier: 'value',
    network: 'none',
    steps: [
        {
            type: 'eval', name: 'splitTree', capture: true, tol: 1e-3,
            fn: `() => {
                const V = window.ViewMan, L = window.LayoutMan;
                const IDS = ['mainView', 'video', 'lookView'];
                const force = () => IDS.forEach(id => { const v = V.get(id, false); if (v) v.updateWH(); });
                const readFracs = () => {
                    const out = {};
                    for (const id of IDS) {
                        const v = V.get(id, false);
                        if (!v) continue;
                        const W = v.containerWidth(), H = v.containerHeight();
                        out[id] = {
                            left:   +((v.leftPx - v.containerLeft()) / W).toFixed(4),
                            top:    +((v.topPx  - v.containerTop())  / H).toFixed(4),
                            width:  +(v.widthPx  / W).toFixed(4),
                            height: +(v.heightPx / H).toFixed(4),
                        };
                    }
                    return out;
                };

                // Canonical tree: main left | (video over look) right.
                const tree = {type: 'split', dir: 'v', sizes: [0.5, 0.5], children: [
                    {type: 'leaf', viewId: 'mainView'},
                    {type: 'split', dir: 'h', sizes: [0.5, 0.5], children: [
                        {type: 'leaf', viewId: 'video'},
                        {type: 'leaf', viewId: 'lookView'},
                    ]},
                ]};
                L.setLayout(tree);
                force();
                const tiled = readFracs();

                // Drag the root vertical divider +200px → main grows, right column shrinks,
                // inner video/look split unchanged.
                const vDiv = L._dividers.find(d => d.dir === 'v');
                L.dragDivider(vDiv, 200, 0);
                force();
                const afterVertical = readFracs();
                const rootSizes = L.tree.sizes.map(s => +s.toFixed(4));

                // Drag the inner horizontal divider +150px → video grows, look shrinks,
                // both stay in the right column (left/width unchanged).
                const hDiv = L._dividers.find(d => d.dir === 'h');
                L.dragDivider(hDiv, 0, 150);
                force();
                const afterHorizontal = readFracs();
                const innerSizes = L.tree.children[1].sizes.map(s => +s.toFixed(4));

                // Leave the page in legacy mode.
                L.clearLayout();
                force();

                return {
                    leaves: L.leafViewIds === undefined ? null : ['mainView', 'video', 'lookView'],
                    tiled, afterVertical, rootSizes, afterHorizontal, innerSizes,
                    legacyRestored: !L.active,
                };
            }`,
        },
        // Sanity asserts: the coupling relationships hold regardless of exact viewport.
        {
            type: 'assert', name: 'verticalDragCouplesMainAndRightColumn',
            fn: `() => {
                const V = window.ViewMan, L = window.LayoutMan;
                const tree = {type: 'split', dir: 'v', sizes: [0.5, 0.5], children: [
                    {type: 'leaf', viewId: 'mainView'},
                    {type: 'split', dir: 'h', sizes: [0.5, 0.5], children: [
                        {type: 'leaf', viewId: 'video'},
                        {type: 'leaf', viewId: 'lookView'},
                    ]},
                ]};
                L.setLayout(tree);
                const force = () => ['mainView','video','lookView'].forEach(id => { const v = V.get(id,false); if (v) v.updateWH(); });
                force();
                const main0 = V.get('mainView', false).widthPx;
                const vid0  = V.get('video', false).widthPx;
                L.dragDivider(L._dividers.find(d => d.dir === 'v'), 200, 0);
                force();
                const main1 = V.get('mainView', false).widthPx;
                const vid1  = V.get('video', false).widthPx;
                L.clearLayout(); force();
                return {mainGrew: main1 > main0, rightColumnShrank: vid1 < vid0};
            }`,
            equals: {mainGrew: true, rightColumnShrank: true},
        },
        // rect→tree reconstruction (guillotine): the Layout Test rects recover the canonical
        // tree (main left | video over look right).
        {
            type: 'assert', name: 'guillotineRecoversCanonicalTree',
            fn: `() => {
                const L = window.LayoutMan;
                const ok = L.tileFromViews();
                const t = L.serialize();
                L.clearLayout();
                const shape = (n) => n.type === 'leaf'
                    ? n.viewId
                    : n.dir + '[' + n.children.map(shape).join(',') + ']';
                return {ok, shape: t ? shape(t) : null};
            }`,
            equals: {ok: true, shape: 'v[mainView,h[video,lookView]]'},
        },
        // Detach (2.5): removing the video leaf collapses the inner split → main | look.
        {
            type: 'assert', name: 'detachCollapsesTree',
            fn: `() => {
                const L = window.LayoutMan;
                L.tileFromViews();
                const removed = L.removeLeaf('video');
                const shape = (n) => !n ? null : (n.type === 'leaf'
                    ? n.viewId : n.dir + '[' + n.children.map(shape).join(',') + ']');
                const after = shape(L.tree);
                const videoTiled = L.hasLeaf('video');
                L.clearLayout();
                return {removed, after, videoTiled};
            }`,
            equals: {removed: true, after: 'v[mainView,lookView]', videoTiled: false},
        },
        // Serialization roundtrip (2.4): serialize a dragged tree, clear, restore → same sizes.
        {
            type: 'assert', name: 'serializeRoundTripPreservesSeams',
            fn: `() => {
                const L = window.LayoutMan;
                L.tileFromViews();
                L.dragDivider(L._dividers.find(d => d.dir === 'v'), 200, 0);
                const saved = JSON.parse(JSON.stringify(L.serialize()));
                const savedSizes = L.tree.sizes.map(s => +s.toFixed(4));
                L.clearLayout();
                const cleared = L.active;
                L.setLayout(saved);
                const restoredSizes = L.tree.sizes.map(s => +s.toFixed(4));
                L.clearLayout();
                return {cleared, match: JSON.stringify(savedSizes) === JSON.stringify(restoredSizes)};
            }`,
            equals: {cleared: false, match: true},
        },
        // Removing a leaf from a 3+-way split renormalizes the remaining sizes (sum stays 1) so a
        // later seam drag maps pixels correctly (regression: raw sizes used to sum to <1, making
        // the seam over-travel by 1/sum). Drag 100px → boundary moves 100px, not ~143px.
        {
            type: 'assert', name: 'removeLeafRenormalizesSizes',
            fn: `() => {
                const L = window.LayoutMan, V = window.ViewMan;
                L.setLayout({type:'split', dir:'v', sizes:[0.2,0.3,0.5], children:[
                    {type:'leaf', viewId:'mainView'}, {type:'leaf', viewId:'video'}, {type:'leaf', viewId:'lookView'}]});
                L.removeLeaf('video');
                const sum = L.tree.sizes.reduce((a,b)=>a+b,0);
                const force = () => ['mainView','lookView'].forEach(id=>{const v=V.get(id,false); if(v) v.updateWH();});
                force();
                const w0 = V.get('mainView',false).widthPx;
                L.dragDivider(L._dividers.find(d=>d.dir==='v'), 100, 0);
                force();
                const moved = V.get('mainView',false).widthPx - w0;
                L.clearLayout();
                return {sumIsOne: Math.abs(sum-1) < 1e-6, seamMoved100: Math.abs(moved-100) <= 1};
            }`,
            equals: {sumIsOne: true, seamMoved100: true},
        },
        // Reset Layout rebuilds a clean grid from all visible views, ignoring positions — so it
        // recovers even after a detach left a floating view that overlaps the grid.
        {
            type: 'assert', name: 'resetLayoutRebuildsGrid',
            fn: `() => {
                const L = window.LayoutMan;
                const shape = (n) => !n ? null : (n.type === 'leaf' ? n.viewId : n.dir + '[' + n.children.map(shape).join(',') + ']');
                L.setLayout({type:'split', dir:'v', sizes:[0.5,0.5], children:[
                    {type:'leaf', viewId:'mainView'},
                    {type:'split', dir:'h', sizes:[0.5,0.5], children:[
                        {type:'leaf', viewId:'video'}, {type:'leaf', viewId:'lookView'}]}]});
                L.removeLeaf('video');               // video floats, tree collapses
                const collapsed = shape(L.tree);
                L.resetLayout();                     // all views back into a clean grid
                const reset = shape(L.tree);
                const allTiled = ['mainView','video','lookView'].every(id => L.hasLeaf(id));
                L.clearLayout();
                return {collapsed, reset, allTiled};
            }`,
            equals: {collapsed: 'v[mainView,lookView]', reset: 'v[mainView,h[video,lookView]]', allTiled: true},
        },
        // Re-dock: dropping a detached (floating) view over a tile splits that tile to re-insert
        // it — the inverse of detach. Drop on the right of mainView → split with video on the right.
        {
            type: 'assert', name: 'reDockSplitsTargetTile',
            fn: `() => {
                const L = window.LayoutMan, V = window.ViewMan;
                const shape = (n) => !n ? null : (n.type === 'leaf' ? n.viewId : n.dir + '[' + n.children.map(shape).join(',') + ']');
                L.setLayout({type:'split', dir:'v', sizes:[0.5,0.5], children:[
                    {type:'leaf', viewId:'mainView'},
                    {type:'split', dir:'h', sizes:[0.5,0.5], children:[
                        {type:'leaf', viewId:'video'}, {type:'leaf', viewId:'lookView'}]}]});
                L.removeLeaf('video');
                const cont = V.container, cr = cont.getBoundingClientRect();
                const m = L.rectFor('mainView');
                // Drop in the right edge band of mainView → split with video on the right.
                const ok = L.dockViewAt('video', cr.left + m.leftPx + m.widthPx * 0.97, cr.top + m.topPx + m.heightPx * 0.5);
                const tree = shape(L.tree);
                const videoTiled = L.hasLeaf('video');
                L.clearLayout();
                return {ok, tree, videoTiled};
            }`,
            equals: {ok: true, tree: 'v[v[mainView,video],lookView]', videoTiled: true},
        },
        // Edge-gating: a drop in the central region of a tile does NOT dock (the view stays
        // free-floating); only the outer 10% edge band snaps. Pairs with the preview.
        {
            type: 'assert', name: 'centerDropDoesNotDock',
            fn: `() => {
                const L = window.LayoutMan, V = window.ViewMan;
                L.setLayout({type:'split', dir:'v', sizes:[0.5,0.5], children:[
                    {type:'leaf', viewId:'mainView'},
                    {type:'split', dir:'h', sizes:[0.5,0.5], children:[
                        {type:'leaf', viewId:'video'}, {type:'leaf', viewId:'lookView'}]}]});
                L.removeLeaf('video');
                const cont = V.container, cr = cont.getBoundingClientRect();
                const m = L.rectFor('mainView');
                const center = L.dockViewAt('video', cr.left + m.leftPx + m.widthPx * 0.5, cr.top + m.topPx + m.heightPx * 0.5);
                const previewAtCenter = L.updateDropPreview('video', cr.left + m.leftPx + m.widthPx * 0.5, cr.top + m.topPx + m.heightPx * 0.5);
                const previewAtEdge = L.updateDropPreview('video', cr.left + m.leftPx + m.widthPx * 0.03, cr.top + m.topPx + m.heightPx * 0.5);
                L.hideDropPreview();
                L.clearLayout();
                return {centerDocked: center, previewAtCenter, previewAtEdge};
            }`,
            equals: {centerDocked: false, previewAtCenter: false, previewAtEdge: true},
        },
    ],
};
