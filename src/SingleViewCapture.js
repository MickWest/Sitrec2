import {GlobalDateTimeNode, NodeMan, Sit} from "./Globals";
import {ViewMan} from "./CViewManager";
import {GlobalScene, LocalFrame} from "./LocalFrame";
import {par} from "./par";
import {getCanvasDisplayRect} from "./VideoExporter";
import {createVideoFormatExportLayer, getVideoFormatExportSettings} from "./videoFilters/VideoFormatLayer";
import {drawVideoWatermark} from "./utils";
import {drawAttributionOnCanvas} from "./AttributionOverlay";

export function singleViewCaptureSize(view, retina = false) {
    if (view.exportVideo) {
        const width = view.canvas.width;
        return {width, height: getVideoFormatExportSettings(view)
            ? Math.max(2, Math.round(width * view.heightPx / view.widthPx / 2) * 2) : view.canvas.height};
    }
    const scale = retina ? window.devicePixelRatio || 1 : 1;
    return {width: Math.round(view.widthPx * scale), height: Math.round(view.heightPx * scale)};
}

// One compositor for the dialog, still images, and single-view video frames.
// Copy WebGL pixels immediately after rendering, before yielding to the browser.
export async function createSingleViewCapture(view, {fps = Sit.fps, retina = false, ...size} = {}) {
    const {width, height} = {...singleViewCaptureSize(view, retina), ...size};
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const formatLayer = await createVideoFormatExportLayer(view, {width, height, fps});
    const {getPointTrackOverlays} = await import("./CObjectTracking");
    const {getMotionAnalysisOverlays} = await import("./CMotionAnalysisUI");
    const jet = Sit.azSlider ? await import("./JetStuff") : null;
    const angles = Sit.azSlider ? await import("./JetUtils") : null;

    return {canvas, width, height, sceneEffectsIncluded: !!formatLayer,
        async render(frame) {
            par.frame = frame;
            GlobalDateTimeNode.update(frame);
            if (jet) {
                par.az = angles.Frame2Az(frame);
                par.el = angles.Frame2El(frame);
                jet.UpdatePRFromEA();
            }
            for (const {data: node} of Object.values(NodeMan.list)) {
                if (node.isController && !node.allowUpdate) continue;
                node.update?.(frame);
                if (node.videoData?.waitForFrame) await node.videoData.waitForFrame(frame);
            }
            GlobalScene.updateMatrixWorld(true);
            LocalFrame?.updateMatrixWorld(true);
            ViewMan.updateZOrder();
            ViewMan.computeEffectiveVisibility();
            ctx.globalAlpha = 1;
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, width, height);
            if (view.camera) {
                view.camera.updateMatrix();
                view.camera.updateMatrixWorld();
                NodeMan.preRenderAll(view);
            }
            view.renderCanvas(frame);
            for (const node of NodeMan.getPostRenderNodes()) node.postRender(view);
            ctx.drawImage(view.canvas, 0, 0, width, height);

            const rect = view.exportVideo && !formatLayer ? getCanvasDisplayRect(view)
                : {x: 0, y: 0, width: view.widthPx, height: view.heightPx};
            const sx = width / rect.width, sy = height / rect.height;
            const children = [];
            ViewMan.iterate((id, child) => {
                if (child !== view && child._effectivelyVisible
                    && (child.overlayView === view || child.in?.relativeTo === view)) children.push(child);
            });
            children.sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
            for (const child of children) {
                if (!child.canvas || child.canvas.style.display === "none" || child.canvas.style.visibility === "hidden") continue;
                child.renderCanvas(frame);
                for (const node of NodeMan.getPostRenderNodes()) node.postRender(child);
                if (!child.canvas.width || !child.canvas.height) continue;
                ctx.globalAlpha = child.transparency ?? 1;
                ctx.drawImage(child.canvas, (child.leftPx - view.leftPx - rect.x) * sx,
                    (child.topPx - view.topPx - rect.y) * sy, child.widthPx * sx, child.heightPx * sy);
            }
            ctx.globalAlpha = 1;
            for (const overlay of getPointTrackOverlays()) {
                if (overlay.view === view && overlay.canvas.width && overlay.canvas.height) {
                    ctx.drawImage(overlay.canvas, -rect.x * sx, -rect.y * sy, view.widthPx * sx, view.heightPx * sy);
                }
            }
            const motion = getMotionAnalysisOverlays();
            if (motion?.videoView === view) {
                if (motion.overlay) ctx.drawImage(motion.overlay, 0, 0, width, height);
                if (motion.graphCanvas) ctx.drawImage(motion.graphCanvas, width - 210 * sx, height - 90 * sy, 200 * sx, 80 * sy);
            }
            formatLayer?.capture([view, ...children]);
        },
        finish() {
            formatLayer?.draw(ctx, 0, 0, width, height);
            drawVideoWatermark(ctx, width);
            drawAttributionOnCanvas(ctx, width, height);
            return canvas;
        },
        dispose() { formatLayer?.dispose(); },
    };
}
