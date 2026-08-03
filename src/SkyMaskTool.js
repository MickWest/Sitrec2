// The "Mask Ground" tool: pick a sky point and a ground point on the video, grow the sky from the
// sky point, and add everything else to the video mask.
//
// The picking is the point of the design, not a convenience. Automatic sky detection has to guess
// which region is sky, and the standard guess - "whatever touches the top border" - inverts on any
// vignetted optic, where the dead black surround is smoother than the sky and occupies most of the
// top row. A click removes the guess entirely. The second click removes the other guess: which
// image feature separates sky from ground, which differs between clips by more than a tuning
// margin. See src/SkyMask.js for the measurements behind both.

import {NodeMan, setRenderOne} from "./Globals";
import {ViewMan} from "./CViewManager";
import {mouseToCanvas} from "./ViewUtils";
import {growSkyFromSeeds, quadTreeGroundMask, SKY_MASK_DEFAULTS} from "./SkyMask";
import {getFlowAlignRotation} from "./FlowAlignment";
import {par} from "./par";

let picking = null;      // the in-progress pick, so a second click of the button cancels it

/**
 * Undo the flow-alignment rotation about the VIEW's centre.
 *
 * Same arithmetic as CNodeMaskOverlay.unrotateCanvasCoords, but measured on the view rather than
 * on the overlay, whose own width/height are the whole window regardless of where its parent sits.
 */
function unrotateForView(view, cx, cy) {
    const rotation = getFlowAlignRotation(par.frame);
    if (!rotation) return [cx, cy];
    const centerX = view.widthPx / 2;
    const centerY = view.heightPx / 2;
    const dx = cx - centerX, dy = cy - centerY;
    const cos = Math.cos(-rotation), sin = Math.sin(-rotation);
    return [dx * cos - dy * sin + centerX, dx * sin + dy * cos + centerY];
}

/** A short instruction shown over the video while picking. */
function showHint(view, text) {
    let hint = view.div.querySelector(".sky-mask-hint");
    if (!hint) {
        hint = document.createElement("div");
        hint.className = "sky-mask-hint";
        hint.style.cssText = "position:absolute;top:8px;left:50%;transform:translateX(-50%);"
            + "background:rgba(0,0,0,0.75);color:#fff;padding:6px 14px;border-radius:4px;"
            + "font:13px sans-serif;pointer-events:none;z-index:600;white-space:nowrap";
        view.div.appendChild(hint);
    }
    hint.textContent = text;
}

function clearHint(view) {
    view?.div?.querySelector(".sky-mask-hint")?.remove();
}

function cancelPick() {
    if (!picking) return;
    const {view, handler, keyHandler} = picking;
    view.div.removeEventListener("pointerdown", handler, true);
    window.removeEventListener("keydown", keyHandler, true);
    clearHint(view);
    picking = null;
}

/**
 * Ask for the seed points, then build the mask.
 *
 * Two clicks: sky first, then ground. Escape cancels. The ground click is what lets the cue be
 * measured rather than assumed, so it is asked for rather than optional - a caller wanting the
 * sky-only path can call applyGroundMask directly with an empty ground list.
 */
export function startMaskGroundPick(onDone) {
    const view = ViewMan.get("video", false);
    const mask = NodeMan.get("videoMask", false);
    if (!view || !view.div) { console.warn("Mask Ground: no video view"); return; }
    if (!mask) { console.warn("Mask Ground: no videoMask node"); return; }

    cancelPick();
    const seeds = {sky: [], ground: []};

    const handler = (e) => {
        // Capture phase and stopped here: a click that is choosing a seed must not also pan the
        // video or paint the mask underneath.
        e.preventDefault();
        e.stopPropagation();
        // Converted through the VIDEO VIEW, not the mask overlay. An overlay shares its parent's
        // div but keeps its own left/top/width/height, which default to the whole window and are
        // never synced to the parent - so on a video view occupying a quadrant, the overlay's
        // leftPx is 0 where the div starts at 950, and a seed converted through it lands outside
        // the frame entirely. The parent's pixel origin is the one that matches the div.
        const [cx, cy] = mouseToCanvas(view, e.clientX, e.clientY);
        const [ucx, ucy] = unrotateForView(view, cx, cy);
        const [vx, vy] = view.canvasToVideoCoords(ucx, ucy);

        if (!seeds.sky.length) {
            seeds.sky.push([vx, vy]);
            showHint(view, "Now click the GROUND (or a rooftop, tree, sea) — Esc to cancel");
            return;
        }
        seeds.ground.push([vx, vy]);
        cancelPick();
        const result = applyGroundMask(seeds.sky, seeds.ground);
        onDone?.(result);
    };

    const keyHandler = (e) => {
        if (e.key === "Escape") { cancelPick(); onDone?.({error: "cancelled"}); }
    };

    view.div.addEventListener("pointerdown", handler, true);
    window.addEventListener("keydown", keyHandler, true);
    showHint(view, "Click the SKY — Esc to cancel");
    picking = {view, handler, keyHandler};
}

/**
 * Segment the current frame from the given seeds and ADD the ground to the video mask.
 *
 * Seeds are in video pixels. The segmentation runs at a fixed working width so scene-scale
 * structure occupies the same number of working pixels whatever the sensor resolution, then the
 * result is scaled up to the mask canvas - which is the size of the video, and not necessarily the
 * size anything else analysed at.
 *
 * @returns {{ok: true, diagnostics: object}|{error: string}}
 */
/**
 * Mask the ground with no seeds at all, classifying by quadtree.
 *
 * Shares every step with the seeded path except which segmenter runs, so the working resolution,
 * the scaling up to the mask canvas, and the undoable additive edit all behave identically.
 */
export function applyQuadTreeGroundMask(opts = {}) {
    return applyGroundMask(null, [], {...opts, method: "quadtree"});
}

export function applyGroundMask(skySeeds, groundSeeds = [], opts = {}) {
    const view = ViewMan.get("video", false);
    const mask = NodeMan.get("videoMask", false);
    if (!view || !mask) return {error: "no video or mask"};

    const img = view.videoData?.getImage(Math.round(par.frame));
    if (!img || !img.width) return {error: "no frame available"};

    const O = {...SKY_MASK_DEFAULTS, ...opts};
    // Never upsample: on footage narrower than the working width the source is already the working
    // resolution, and stretching it would invent detail the segmentation would then measure.
    const W = Math.min(O.workWidth, img.width);
    const H = Math.max(1, Math.round(W * img.height / img.width));

    const work = document.createElement("canvas");
    work.width = W; work.height = H;
    const wctx = work.getContext("2d", {willReadFrequently: true});
    wctx.drawImage(img, 0, 0, W, H);
    const rgba = wctx.getImageData(0, 0, W, H).data;

    const sx = W / img.width, sy = H / img.height;
    const toWork = (pts) => pts.map(([x, y]) => [x * sx, y * sy]);

    const out = O.method === "quadtree"
        ? quadTreeGroundMask(rgba, W, H, O)
        : growSkyFromSeeds(rgba, W, H, toWork(skySeeds), toWork(groundSeeds), O);
    if (out.error) return out;

    // Paint the ground at working resolution into a small canvas, then let the 2D context scale it
    // up. Nearest-neighbour would show the working grid as staircase edges on a 4K frame, so
    // smoothing is left on and the result thresholded by alpha, which the mask reads anyway.
    const gcanvas = document.createElement("canvas");
    gcanvas.width = W; gcanvas.height = H;
    const gctx = gcanvas.getContext("2d");
    const gimg = gctx.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
        if (out.ground[i]) {
            gimg.data[i * 4] = 255;
            gimg.data[i * 4 + 3] = 255;
        }
    }
    gctx.putImageData(gimg, 0, 0);

    mask.ensureMaskInitialized();
    if (!mask.maskCanvas) return {error: "mask canvas unavailable"};

    // Through applyMaskEdit so the operation is undoable, and DRAWN OVER the existing mask rather
    // than replacing it - a detected ground region composes with hand-painted work and with any
    // OSD or redaction masking already there.
    mask.applyMaskEdit("Mask Ground", (ctx, canvas) => {
        ctx.drawImage(gcanvas, 0, 0, canvas.width, canvas.height);
    });
    mask.updateMaskImageData();
    setRenderOne(true);

    return {ok: true, diagnostics: out.diagnostics};
}
