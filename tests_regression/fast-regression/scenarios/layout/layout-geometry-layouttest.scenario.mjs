// Phase 0.1 — LAYOUT GEOMETRY SAFETY NET (the "Layout Test" user custom sitch).
//
// This is the canonical TILING TESTBED: a simple user-created custom sitch with just a
// video — main on the left, video over look on the right. It is exactly the layout the
// snapped split-tree work (Phase 2) targets, so pinning its per-view geometry now means
// the tiling work cannot silently shift it without a readable diff.
//
// Focus rationale: the redesign targets SitCustom + user-created sitches (regression /
// featured), NOT legacy built-ins (those are covered by the run.mjs pixel "loads+renders"
// gate). This + layout-geometry-custom are the SitCustom-tool + user-sitch anchors.
//
// Loaded via ?custom= (builtin:false + url = the custom path the app uses).
// Read-only (no mutation) → no isolation needed.
export default {
    id: 'layout-geometry-layouttest',
    sitch: 'Layout Test',
    builtin: false,
    url: '99999999/Layout Test/20260622_163801.js',
    frame: 10,
    tier: 'value',
    network: 'none',
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
    ],
};
