// Phase 1 — UNIFIED VIEW INTERACTION safety net.
//
// Pins the interaction config of EVERY movable view so the "one gesture for all views"
// guarantee can't silently regress. After Phase 1, every movable CNodeView must use the
// single edit modifier (dragKey = "Q") and NOT the legacy Shift (shiftDrag:false) — the
// three divergent gestures (Q / Shift / bare-drag) are collapsed to one.
//
// The custom sitch is ideal: it instantiates 3D views (mainView/lookView, historically
// dragKey:"Q"), video views, AND graph views (JetGraphs, historically shiftDrag:false /
// bare-drag) — so this capture proves the graphs were migrated onto Q too.
//
// If a new view (or a refactor) reintroduces shiftDrag:true or a bare-drag view, this diffs.
export default {
    id: 'interaction-uniformity-custom',
    sitch: 'custom',
    builtin: true,
    frame: 10,
    tier: 'value',
    network: 'none',
    steps: [
        {
            type: 'capture', name: 'movableViewInteraction',
            read: {
                eval: `() => {
                    const out = {};
                    window.ViewMan.iterate((id, v) => {
                        if (v.overlayView) return;
                        if (!(v.draggable || v.resizable)) return;
                        out[id] = {
                            draggable: !!v.draggable,
                            resizable: !!v.resizable,
                            dragKey: v.dragKey ?? null,
                            shiftDrag: !!v.shiftDrag,
                        };
                    });
                    return out;
                }`
            }
        },
    ],
};
