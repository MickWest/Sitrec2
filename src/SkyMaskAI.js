// "Mask Ground with AI": a vision model traces a rough outline of the sky (or of the ground),
// and everything on the ground side of it is added to the video mask.
//
// This asks the model for the ANSWER, not for a hint towards one. The earlier version asked it
// for seed points and let growSkyFromSeeds do the pixels, which failed for a reason no seed can
// fix: on a wide night landscape the sky's own variation - dark zenith to bright light-pollution
// glow at the horizon - is as large as the difference between sky and ground, so a region grown
// on a single cue cannot separate the two classes. Measured on the treeline test frame, three
// sources of visually correct seeds all fell below the segmenter's separation gate of 1.0:
// gpt-5-mini 0.69, a hand-placed human pair 0.63, claude-opus-4-8 0.08. Forcing the gate open
// produced a nearly INVERTED mask. The seeds were never the problem.
//
// An outline sidesteps all of it. Where the sky ends is a semantic question - it is the thing a
// vision model is actually good at - and once the boundary is stated, no cue has to be measured
// and no region has to reach anywhere. The cost is precision: this is a ROUGH mask, several
// pixels off the true edge, to be cleaned up with Edit Mask where that matters.
//
// ADMIN ONLY and EXPERIMENTAL. The real gate is server-side in sitrecServer/aimask.php - this
// costs money per press, and a hidden menu item is not a permission check.

import {Globals, NodeMan, setRenderOne, withTestUser} from "./Globals";
import {ViewMan} from "./CViewManager";
import {SITREC_SERVER} from "./configUtils";
import {refineGroundByLocalDarkness, SKY_MASK_DEFAULTS} from "./SkyMask";
import {par} from "./par";

// What the frame is scaled to before it is sent. Vision models resize large images down to
// roughly this anyway and bill for the resized token count, so sending more costs money without
// buying detail the outline could express.
const AI_IMAGE_WIDTH = 1024;
const AI_IMAGE_QUALITY = 0.85;

// How far outside the frame a returned coordinate may stray and still be treated as a
// normalised value that overshot, rather than as a different unit entirely. A model that
// answers in PIXELS produces values in the hundreds; clamping those would collapse the whole
// outline into one corner and mask the frame almost at random, so they are rejected instead.
const COORD_TOLERANCE = 0.05;

/**
 * Read one polygon out of the model's JSON, in normalised coordinates.
 *
 * The response is untrusted text from a language model. A polygon only survives if it has at
 * least three points that are all finite and all plausibly normalised; anything else is
 * dropped, because a NaN vertex does not throw - it silently deforms the filled region.
 *
 * @returns {Array<[number, number]>|null}
 */
function readPolygon(raw) {
    if (!Array.isArray(raw) || raw.length < 3) return null;
    const points = [];
    for (const point of raw) {
        if (!Array.isArray(point) || point.length < 2) return null;
        const [x, y] = point;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        if (x < -COORD_TOLERANCE || x > 1 + COORD_TOLERANCE) return null;
        if (y < -COORD_TOLERANCE || y > 1 + COORD_TOLERANCE) return null;
        points.push([Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))]);
    }
    return points.length >= 3 ? points : null;
}

/** The current frame, scaled down and JPEG-encoded, as bare base64 (no data: prefix). */
function frameToBase64(img) {
    const W = Math.min(AI_IMAGE_WIDTH, img.width);
    const H = Math.max(1, Math.round(W * img.height / img.width));
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    canvas.getContext("2d").drawImage(img, 0, 0, W, H);
    const dataURL = canvas.toDataURL("image/jpeg", AI_IMAGE_QUALITY);
    return dataURL.slice(dataURL.indexOf(",") + 1);
}

/**
 * Ask the server's vision endpoint to outline the sky, and mask the other side of that outline.
 *
 * @returns {Promise<{ok: true, region: string, polygons: Array, notes: string}|{error: string}>}
 */
export async function maskGroundWithAI(margin = 0) {
    const view = ViewMan.get("video", false);
    if (!view) return {error: "no video view"};

    // Captured BEFORE the request, and identity-checked after it. The call takes seconds, and
    // in that time the video can be closed (making this null) or replaced by a different clip -
    // in which case an outline traced on the old footage would be painted over the new.
    const video = view.videoData;
    if (!video) return {error: "no video loaded"};

    const frame = Math.round(par.frame);
    const img = video.getImage(frame);
    if (!img || !img.width) return {error: "no frame available"};

    const chatModel = Globals.settings?.chatModel || "";
    if (!chatModel.includes(":")) {
        return {error: "No AI model selected - pick one in Settings > AI Model"};
    }
    const [provider, model] = chatModel.split(":");

    let response;
    try {
        const res = await fetch(withTestUser(SITREC_SERVER + "aimask.php"), {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            credentials: "include",
            body: JSON.stringify({
                provider,
                model,
                image: frameToBase64(img),
            }),
        });
        response = await res.json();
    } catch (e) {
        return {error: "could not reach the server: " + (e?.message ?? e)};
    }

    if (!response || response.error) {
        return {error: response?.error ?? "no response from the server"};
    }

    if (ViewMan.get("video", false)?.videoData !== video) {
        return {error: "the video changed while the AI was working - nothing was masked"};
    }

    const outline = response.outline ?? {};
    const notes = outline.notes ?? "";
    if (outline.groundVisible === false) {
        return {error: "the AI sees no ground in this frame - nothing to mask", notes};
    }

    const region = outline.region === "ground" ? "ground" : "sky";
    const polygons = (Array.isArray(outline.polygons) ? outline.polygons : [])
        .map(readPolygon)
        .filter(Boolean);
    if (!polygons.length) {
        return {error: "the AI did not return a usable outline", notes};
    }

    const mask = NodeMan.get("videoMask", false);
    if (!mask) return {error: "no videoMask node", notes};
    mask.ensureMaskInitialized();
    if (!mask.maskCanvas) return {error: "mask canvas unavailable", notes};

    // Everything below happens at a fixed WORKING resolution rather than at the video's own,
    // so the refinement's window sizes and thresholds mean the same thing on a phone clip and
    // on a 5472-pixel-wide photograph. Never upsample: on footage narrower than the working
    // width the source is already it, and stretching would invent detail to then measure.
    const W = Math.min(SKY_MASK_DEFAULTS.workWidth, img.width);
    const H = Math.max(1, Math.round(W * img.height / img.width));

    const work = document.createElement("canvas");
    work.width = W; work.height = H;
    const wctx = work.getContext("2d", {willReadFrequently: true});
    wctx.drawImage(img, 0, 0, W, H);
    const rgba = wctx.getImageData(0, 0, W, H).data;

    // Rasterise the outline to the same grid. A SKY outline means "mask everything OUTSIDE
    // this", which the even-odd fill rule states in one path: the whole frame as the outer
    // ring, each sky polygon as a hole punched through it.
    const poly = document.createElement("canvas");
    poly.width = W; poly.height = H;
    const pctx = poly.getContext("2d", {willReadFrequently: true});
    pctx.fillStyle = "#fff";
    pctx.strokeStyle = "#fff";
    pctx.beginPath();
    if (region === "sky") pctx.rect(0, 0, W, H);
    for (const polygon of polygons) {
        polygon.forEach(([x, y], i) => {
            const px = x * W, py = y * H;
            if (i === 0) pctx.moveTo(px, py); else pctx.lineTo(px, py);
        });
        pctx.closePath();
    }
    pctx.fill(region === "sky" ? "evenodd" : "nonzero");
    // The safety margin, as a band laid ALONG the outline. Stroking the same path widens the
    // masked side across the boundary by half the line width, whichever side that is - it eats
    // into the sky for a "sky" ring and grows outwards for a "ground" ring - so one stroke
    // serves both without a separate inset/outset pass.
    if (margin > 0) {
        pctx.lineWidth = 2 * margin * Math.min(W, H);
        pctx.lineJoin = "round";
        pctx.lineCap = "round";
        pctx.stroke();
    }

    const polyData = pctx.getImageData(0, 0, W, H).data;
    const claimed = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) claimed[i] = polyData[i * 4 + 3] > 128 ? 1 : 0;

    // The model said which side is ground; the image says where its edge actually is.
    const refinement = refineGroundByLocalDarkness(rgba, W, H, claimed);
    const finalGround = refinement.ground;

    // Paint at working resolution, then let the 2D context scale it up. Nearest-neighbour
    // would show the working grid as staircase edges on a 4K frame, so smoothing is left on
    // and the result thresholded by alpha, which the mask reads anyway.
    const gcanvas = document.createElement("canvas");
    gcanvas.width = W; gcanvas.height = H;
    const gctx = gcanvas.getContext("2d");
    const gimg = gctx.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
        if (finalGround[i]) {
            gimg.data[i * 4] = 255;
            gimg.data[i * 4 + 3] = 255;
        }
    }
    gctx.putImageData(gimg, 0, 0);

    // Through applyMaskEdit so the operation is undoable, and DRAWN OVER whatever is already
    // there rather than replacing it - this composes with hand-painted work and with any OSD
    // or redaction masking, exactly as the other Mask Ground buttons do.
    mask.applyMaskEdit("Mask Ground (AI)", (ctx, canvas) => {
        ctx.drawImage(gcanvas, 0, 0, canvas.width, canvas.height);
    });
    mask.updateMaskImageData();
    setRenderOne(true);

    let claimedCells = 0, finalCells = 0;
    for (let i = 0; i < W * H; i++) { claimedCells += claimed[i]; finalCells += finalGround[i]; }

    return {
        ok: true, region, polygons, notes, frame,
        outlineGroundFraction: claimedCells / (W * H),
        groundFraction: finalCells / (W * H),
        diagnostics: refinement.diagnostics,
    };
}
