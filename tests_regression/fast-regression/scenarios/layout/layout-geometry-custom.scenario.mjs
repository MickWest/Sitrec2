// Phase 0.1 — LAYOUT GEOMETRY SAFETY NET (custom sitch).
//
// Pins the per-view layout geometry of the default custom sitch so the UI redesign
// (unified interaction → split-tree tiling → per-window headers) cannot silently
// mis-position or mis-serialize any view without a readable value diff. The fast
// pixel suite only sees the COMPOSITED render; this catches the geometry directly.
//
// Three captures:
//   liveGeometry       — what updateWH() actually produces (listViews: left/top/width/height/visible).
//   serializedGeometry — what gets PERSISTED (CNodeView.modSerialize → out.mods[id]); the
//                        backward-compat surface that must keep round-tripping. Holes = a field
//                        equal to its default and dropped by simpleSerialize (that IS the save shape).
//   afterMove          — round-trips a setViewPosition mutation back through updateWH/listViews
//                        (coarse tol: the per-frame setFromDiv re-derives fractions from floored px).
//
// isolated:true — setViewPosition mutates view rects on a fresh, never-saved page.
// tol 1e-3 on geometry: gross mis-positioning (the redesign risk) is >>1e-3; sub-pixel
// px-rounding is <1e-3, so this is tight enough to catch regressions, loose enough not to flake.
export default {
    id: 'layout-geometry-custom',
    sitch: 'custom',
    builtin: true,
    frame: 10,
    tier: 'value',
    network: 'none',
    isolated: true,
    steps: [
        {type: 'capture', name: 'liveGeometry', read: {api: 'listViews'}, tol: 1e-3},
        {
            type: 'capture', name: 'serializedGeometry', tol: 1e-3,
            read: {
                eval: `() => {
                    const out = {};
                    window.ViewMan.iterate((id, v) => {
                        if (v.overlayView) return;
                        let m;
                        try { m = v.modSerialize() || {}; } catch (e) { out[id] = {error: String(e)}; return; }
                        const g = {};
                        for (const k of ['left','top','width','height','visible','doubled','dockedSidebar']) {
                            if (m[k] !== undefined) g[k] = m[k];
                        }
                        out[id] = g;
                    });
                    return out;
                }`
            }
        },
        {type: 'apiCall', fn: 'setViewPosition', args: {view: 'mainView', left: 0.1, top: 0.2, width: 0.4, height: 0.5}},
        {type: 'capture', name: 'afterMove', read: {api: 'listViews'}, tol: 5e-3},
    ],
};
