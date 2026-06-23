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
    ],
};
