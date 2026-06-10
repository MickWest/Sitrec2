// Render Viewport Video regression: run a short (6 source frames) viewport video export
// on the default (custom) sitch and assert it completes with a non-empty encoded blob.
//
// This locks in the fix for the 0x0-canvas export crash: the fresh custom sitch has an
// annotateOverlay on the HIDDEN "video" view (separateVisibility:true keeps it
// "effectively visible" while its canvas, inside the parent's display:none div, is laid
// out at 0x0). Before the fix, compositing that overlay threw
//   InvalidStateError: drawImage ... canvas element with a width or height of 0
// and the export failed. The capture also records that precondition
// (annotateOverlayPresent / videoViewVisible) so we notice if a default change ever
// stops this scenario from covering the bug.
//
// The blob SIZE is encoder-dependent (hardware vs software H.264, Chrome version), so
// only deterministic values are captured: completion, output frame count, size > 0.
//
// isolated:true — mutates Sit.aFrame/bFrame on a fresh, never-saved page.
export default {
    id: 'export-viewport-video',
    sitch: 'custom',
    builtin: true,
    frame: 0,
    tier: 'value',
    network: 'none',
    isolated: true,
    steps: [
        {
            type: 'eval',
            name: 'viewportExport',
            capture: true,
            fn: `async () => {
                const mgr = window.CustomManager?.videoExportManager;
                if (!mgr) throw new Error('CustomManager.videoExportManager not available');
                const annotateOverlay = window.NodeMan.get('annotateOverlay', false);
                const videoView = window.ViewMan.get('video', false);
                // Keep the export short: 6 source frames of the A-B range.
                window.Sit.aFrame = 0;
                window.Sit.bFrame = 5;
                const res = await mgr.exportViewportVideo({download: false});
                if (!res) throw new Error('export returned no result (aborted or no encodable format)');
                return {
                    completed: true,
                    totalFrames: res.totalFrames,
                    nonEmpty: res.size > 0,
                    annotateOverlayPresent: !!annotateOverlay,
                    videoViewVisible: !!(videoView && videoView._effectivelyVisible),
                };
            }`,
        },
    ],
};
