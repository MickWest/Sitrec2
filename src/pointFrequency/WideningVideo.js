import {CustomManager, NodeMan, setRenderOne, Sit} from '../Globals';
import {ViewMan} from '../CViewManager';
import {EventManager} from '../CEventManager';
import {par} from '../par';
import {getObjectTracker} from '../CObjectTracking';
import {createWideningExportPlan, VideoExportManager} from '../VideoExporter';
import {showError} from '../showError';
import {t} from '../i18n';

// The height of the timeline strip below the views, in CSS pixels: the height
// of the frame slider on screen.
const TIMELINE_HEIGHT = 20;
// The In and Out frame numbers. They show at the two ends of the track, and
// above the In and Out markers of the timeline, in a row of this height. The
// colors are pastel forms of the green and the red of those markers.
const NUMBERS = {height: 30, font: 'bold 26px sans-serif', inColor: '#9be7a2', outColor: '#ffa3a3'};

// Render Widening Video: a viewport video that holds the current frame while
// the In/Out region goes from In 1/Out 1 to In 2/Out 2, and back if pingPong
// is set. For each output frame the graphs are brought up to date with the
// new region first.
// The Point Track overlay shows the track from In to Out with the frame number
// at each end. The timeline is drawn below the views, with the same numbers
// above its In and Out markers.
//
// videoFilter is the result of the render dialog. Pass null to skip the
// dialog (a test does). Returns what exportViewportVideo returns.
export async function renderWideningVideo({in1, in2, out1, out2, pingPong = false}, {videoFilter, download = true} = {}) {
    const last = Math.max(0, Sit.frames - 1);
    const clamp = frame => Math.max(0, Math.min(last, Math.round(frame)));
    [in1, in2, out1, out2] = [in1, in2, out1, out2].map(clamp);
    if (!(in1 < out1 && in2 < out2)) { showError(t('pointFrequency.widening.badRange')); return null; }
    if (in1 === in2 && out1 === out2) { showError(t('pointFrequency.widening.noChange')); return null; }

    const manager = CustomManager?.videoExportManager ?? new VideoExportManager();
    if (videoFilter === undefined) {
        videoFilter = await manager.promptExportSettings(t('pointFrequency.widening.render'), {viewId: 'video'});
        if (!videoFilter) return null;
    }

    const tracker = getObjectTracker();
    const slider = NodeMan.get('FrameSlider', false);
    const frame = Math.floor(par.frame);
    const saved = {a: Sit.aFrame, b: Sit.bFrame};
    const setRegion = ({a, b}) => {
        Sit.aFrame = a;
        Sit.bFrame = b;
        // Every path that changes In/Out dispatches this (see MakeTraverseNodesMenu.js).
        EventManager.dispatchEvent('abFrameChanged');
    };
    // A view whose analysis runs outside the render (a worker job) has
    // settleAnalysis(). Other graphs read In/Out when they are drawn.
    const settle = () => {
        const pending = [];
        ViewMan.iterate((id, view) => { if (view.visible && view.settleAnalysis) pending.push(view.settleAnalysis()); });
        return Promise.all(pending);
    };

    const plan = createWideningExportPlan({fps: Sit.fps, frame, in1, in2, out1, out2, pingPong});
    plan.progressLabel = t('pointFrequency.widening.progress');
    plan.prepareFrame = async index => {
        const region = plan.rangeAt(index);
        setRegion(region);
        if (tracker) tracker.trackSpan = {frame0: region.a, frame1: region.b, ...NUMBERS};
        await settle();
    };
    if (slider) plan.footer = {height: NUMBERS.height + TIMELINE_HEIGHT,
        draw: (ctx, width) => slider.drawForExport(ctx, width, TIMELINE_HEIGHT, frame, NUMBERS)};

    try {
        // Measure the widest region one time. Each output frame is inside it,
        // so the frequency graph then needs no new video decode per frame.
        setRegion({a: Math.min(in1, in2), b: Math.max(out1, out2)});
        await settle();
        return await manager.exportViewportVideo({plan, includeAudio: false, videoFilter, download});
    } finally {
        if (tracker) tracker.trackSpan = null;
        setRegion(saved);
        setRenderOne(true);
    }
}
