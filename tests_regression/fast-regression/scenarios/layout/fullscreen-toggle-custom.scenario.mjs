// Phase 3 — FULLSCREEN-ICON regression guard.
//
// Guards the real bug: clicking a view's header fullscreen icon set `fullscreenView` and
// resized the view, but did NOT arm a render. The hide/z-order of the other views happens
// in renderMain (computeEffectiveVisibility / updateDOMVisibility / updateZOrder), which
// under render-on-demand only runs when a render is armed (setRenderOne). The native
// double-click path arms it; the icon/API path did not — so fullscreen left every other
// view still visible ("look full-size under the graphs; others never hid"), nondetermin-
// istically depending on whether some other interaction happened to wake a render.
//
// Fix: doubleClick() now calls setRenderOne(true). This scenario asserts the icon click
// ARMS a render on both enter and exit (window.par.renderOne becomes true), plus that the
// fullscreen state is set/cleared. NOTE: do NOT assert via a forced settle/render — that
// would mask the bug, since forcing a frame applies visibility regardless of arming.
//
// isolated:true — mutates fullscreen state; the eval resets at the end.
export default {
    id: 'fullscreen-toggle-custom',
    sitch: 'custom',
    builtin: true,
    frame: 10,
    tier: 'value',
    network: 'none',
    isolated: true,
    steps: [
        {
            type: 'capture', name: 'fullscreenArmsRender',
            read: {
                eval: `() => {
                    const V = window.ViewMan;
                    const fsBtn = (id) => { const v = V.get(id, false); if (!v || !v.uiBar) return null; return v.uiBar.bar.querySelector('[data-uibar-action="fullscreen"]'); };
                    const reset = () => { V.iterate((id, v) => { if (v.doubled) v.doubleClick(); }); };
                    const lb = fsBtn('lookView');
                    if (!lb) return { hasButton: false };
                    reset();
                    // enter fullscreen via the icon
                    if (window.par) window.par.renderOne = false;
                    lb.dispatchEvent(new MouseEvent('click', {bubbles: true}));
                    const fullscreenSet = !!(V.fullscreenView && V.fullscreenView.id === 'lookView');
                    const armsRenderOnFullscreen = window.par ? (window.par.renderOne === true) : null;
                    // exit fullscreen via the icon
                    if (window.par) window.par.renderOne = false;
                    lb.dispatchEvent(new MouseEvent('click', {bubbles: true}));
                    const fullscreenCleared = V.fullscreenView === null;
                    const armsRenderOnExit = window.par ? (window.par.renderOne === true) : null;
                    reset();
                    return { hasButton: true, fullscreenSet, armsRenderOnFullscreen, fullscreenCleared, armsRenderOnExit };
                }`
            }
        },
    ],
};
