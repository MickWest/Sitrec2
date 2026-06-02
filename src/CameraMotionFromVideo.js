// CameraMotionFromVideo.js
//
// "Camera Motion (Background)" analysis: estimate the camera's motion from the moving
// BACKGROUND of a (near-nadir) video by tracking features across frames, fitting a
// robust per-frame similarity transform (translation + rotation + scale), and integrating
// the result into a plausible camera flight path over the ground/terrain.
//
// Pipeline:
//   video frames -> grayscale -> goodFeaturesToTrack (with a static mask for burned-in
//   redaction blocks + center reticle) -> calcOpticalFlowPyrLK -> RANSAC similarity fit
//   -> per-frame background {dx,dy,theta,scale} -> CNodeCameraMotionTrack (integrate)
//   -> CNodeDisplayTrack (draw path over terrain).
//
// OpenCV.js in this build lacks estimateAffinePartial2D, so the similarity transform is
// fit here directly (complex-number least squares with RANSAC).

import {NodeMan, Sit, guiMenus, setRenderOne, Globals} from "./Globals";
import {par} from "./par";
import {loadOpenCV, getCV} from "./openCVLoader";
import {CNodeCameraMotionTrack} from "./nodes/CNodeCameraMotionTrack";
import {CNodeControllerCameraMotionOrientation} from "./nodes/CNodeControllerCameraMotionOrientation";
import {CNodeDisplayTrack} from "./nodes/CNodeDisplayTrack";
import {altitudeHAE, getLocalUpVector} from "./SphericalMath";
import {V3} from "./threeUtils";
import {Color} from "three";

// The lookCamera's position comes from cameraTrackSwitch -> cameraTrackSwitchSmooth ->
// trackPositionController. We add the recovered path as a selectable option on that switch,
// so choosing it makes the look camera fly the reconstructed path.
const HOOK_SWITCH = "cameraTrackSwitch";
const HOOK_OPTION = "Camera Motion Path";
const HOOK_FALLBACK = "fixedCamera";

const DEFAULTS = {
    maxFeatures: 1000,  // dense, well-distributed features -> robust consensus
    qualityLevel: 0.005,
    minDistance: 6,
    ransacThr: 2.0,     // inlier residual threshold (px) for the robust similarity fit
    lkWin: 21,          // pyramidal Lucas-Kanade window (px)
    pyrLevels: 3,       // LK pyramid levels (handles larger / multi-scale motion)
    fbThreshold: 0.5,   // forward-backward round-trip error (px) — reject unreliable tracks
    minInliers: 40,     // a frame with fewer consensus inliers is interpolated, not trusted
    minInlierFrac: 0.35,// likewise if too small a fraction of tracks agree
    darkThresh: 16,     // luma: a pixel never exceeding this over the clip is treated as redaction
    dilate: 9,          // erode the keep-mask to drop high-contrast redaction-block edges
    reticleHalf: 34,    // half-size of the central box masked out for the reticle
    maxTrackError: 20,
    smoothing: 3,       // light moving-average on per-frame motion (estimates are now cleaner)
    metersPerPixel: 12, // manual ground-sample-distance (used when autoScale is off)
    autoScale: true,    // derive metersPerPixel from FOV + camera altitude + depression
    backgroundAlt: 0,   // altitude (m HAE) of the imaged background plane (e.g. cloud-top); the
                        // one quantity the video can't supply, so it's a user input
    signE: -1,
    signN: -1,
    swapEN: false,
    climbGain: 0,
    driveLookCamera: false,
    lookOrientation: "off",   // "off" | "roll" | "fixed"
    depression: 25,           // degrees below horizon for "fixed" mode (overridden by real LOS)
    rollSign: 1,              // +1 = look-camera roll matches the video; -1 flips it
};

// The sitch's real line-of-sight depression (degrees below horizon), used as the default for
// "Fixed depression" mode. Read from the PTZ controller's elevation (negative = looking down),
// falling back to a direct measurement of the look camera's aim.
function realLOSDepressionDeg() {
    const ptz = NodeMan.get("ptzAngles", false);
    if (ptz && typeof ptz.el === "number") return Math.max(0, Math.min(90, -ptz.el));
    return DEFAULTS.depression;
}

// Look-camera depression below horizontal (degrees), measured from its actual forward vector
// (robust to the LOS mode), falling back to the PTZ elevation.
function lookDepressionDeg() {
    const lc = NodeMan.get("lookCamera", false);
    if (lc && lc.camera) {
        const cam = lc.camera;
        cam.updateMatrixWorld();
        const e = cam.matrixWorld.elements;
        const fwd = V3(-e[8], -e[9], -e[10]);
        const dot = Math.max(-1, Math.min(1, fwd.dot(getLocalUpVector(cam.position))));
        const dep = -Math.asin(dot) * 180 / Math.PI;
        if (Number.isFinite(dep) && dep > 0.5) return Math.min(89.5, dep);
    }
    return realLOSDepressionDeg();
}

// Physically-derived ground-sample-distance (metres per pixel) of the imaged background plane.
// GSD = 2*R*tan(vFOV/2)/pixelHeight, with R = (cameraHAE - backgroundAlt)/sin(depression) the
// slant distance from the camera to where the optical axis meets the background plane. This pins
// the horizontal scale from the sitch's own FOV + altitude; only the background (cloud) altitude
// is a user assumption, since the video alone can't give the plane's distance.
function geometricMetersPerPixel(P) {
    const vv = getVideo();
    const lc = NodeMan.get("lookCamera", false);
    const origin = NodeMan.get("fixedCameraPosition", false)
        ?? NodeMan.get("flightSimCameraPosition", false)
        ?? NodeMan.get("cameraTrack", false);
    if (!vv || !lc || !origin || !origin.p) return null;
    let camHAE;
    try { camHAE = altitudeHAE(origin.p(0)); } catch (e) { return null; }
    const vFOVdeg = lc.camera.renderedFOV ?? lc.camera.fov;
    const Hpx = vv.videoData.videoHeight;
    const depDeg = lookDepressionDeg();
    const dh = camHAE - (P.backgroundAlt ?? 0);
    if (!(dh > 0) || !(depDeg > 0.5) || !(vFOVdeg > 0) || !Hpx) return null;
    const R = dh / Math.sin(depDeg * Math.PI / 180);
    return 2 * R * Math.tan(vFOVdeg * Math.PI / 360) / Hpx;
}

// Shared status object so progress can be polled (e.g. from MCP) and so the menu label updates.
function status() {
    return (Globals.cameraMotion = Globals.cameraMotion || { state: "idle", progress: 0, total: 0 });
}

function getVideo() {
    const videoView = NodeMan.get("video", false);
    if (!videoView || !videoView.videoData) return null;
    return videoView;
}

// Cache the analysed motion so the path survives a page reload and can be re-tuned/rebuilt
// without re-running the (slow) optical-flow pass. Keyed by the video filename.
function cacheKey() {
    const vv = getVideo();
    const fromList = vv?.videos?.[vv.currentVideoIndex]?.fileName;
    const fromData = vv?.videoData?.filename;
    const name = (fromList && fromList !== "Unknown") ? fromList
        : (fromData && fromData !== "Unknown") ? fromData
        : "video";
    return "cameraMotion:" + name;
}

function saveMotionCache(motionData) {
    try {
        const compact = motionData.map(m => m ? [
            +(m.dx ?? 0).toFixed(3), +(m.dy ?? 0).toFixed(3),
            +(m.theta ?? 0).toFixed(5), +(m.scale ?? 1).toFixed(5), +(m.confidence ?? 0).toFixed(3),
        ] : null);
        localStorage.setItem(cacheKey(), JSON.stringify(compact));
    } catch (e) { /* quota / unavailable - non-fatal */ }
}

function loadMotionCache() {
    try {
        const s = localStorage.getItem(cacheKey());
        if (!s) return null;
        return JSON.parse(s).map(a => a ? { dx: a[0], dy: a[1], theta: a[2], scale: a[3], confidence: a[4] } : { dx: 0, dy: 0, theta: 0, scale: 1, confidence: 0 });
    } catch (e) { return null; }
}

function makeGrayHelper(cv, W, H) {
    const cnv = document.createElement("canvas");
    cnv.width = W; cnv.height = H;
    const ctx = cnv.getContext("2d", { willReadFrequently: true });
    return function grayMat(image) {
        ctx.drawImage(image, 0, 0, W, H);
        const id = ctx.getImageData(0, 0, W, H);
        const src = cv.matFromImageData(id);
        const g = new cv.Mat();
        cv.cvtColor(src, g, cv.COLOR_RGBA2GRAY);
        src.delete();
        return g;
    };
}

// Return the decoded image for frame f, WAITING until the decoder has genuinely produced it.
// When paused, getImage() returns the nearest already-decoded frame, so a not-yet-decoded frame
// would masquerade as a duplicate of its predecessor and corrupt the motion estimate. We verify
// the frame is actually cached (isFrameCached, the same check waitForFrame uses) and keep
// requesting/waiting until it is — the frame WILL decode, it just needs time. Returns null only
// if a frame genuinely never decodes (a real error), so the caller skips it rather than treating
// a stale frame as data.
async function frameImage(vd, f) {
    // Drive the whole app to this frame so the render loop and our analysis request the SAME frame
    // (otherwise the render loop keeps re-requesting the stale current frame and the decoder
    // thrashes between the two). This is the app's natural sequential-decode path.
    par.frame = f;
    const cached = () => (typeof vd.isFrameCached === "function") ? vd.isFrameCached(f)
        : (typeof vd.isFrameLoaded === "function") ? vd.isFrameLoaded(f) : false;
    for (let tries = 0; tries < 10 && !cached(); tries++) {
        if (vd.requestFrame) { try { vd.requestFrame(f); } catch (e) { /* request the GOP */ } }
        if (vd.waitForFrame) { try { await vd.waitForFrame(f, 6000); } catch (e) { /* ignore */ } }
    }
    if (!cached()) { console.warn(`[CameraMotion] frame ${f} did not decode after waiting; skipping`); return null; }
    return vd.getImage(f);
}

// Build a static feature mask (255 = usable). Removes burned-in redaction blocks (pixels that
// are never bright across the sampled frames), their high-contrast edges (erosion), and the
// center reticle. Samples a sequential run of early frames (not scattered across the clip) so
// the decoder steps forward frame-by-frame instead of thrashing between distant frames.
async function buildMask(cv, vd, W, H, P, grayMat, total) {
    const N = Math.min(12, total);
    const samples = [];
    for (let i = 0; i < N; i++) samples.push(i);
    let maxMat = null;
    for (const f of samples) {
        const img = await frameImage(vd, f);
        if (!img || !img.width) continue;
        const g = grayMat(img);
        if (!maxMat) { maxMat = g; } else { cv.max(maxMat, g, maxMat); g.delete(); }
    }
    if (!maxMat) return null;
    const mask = new cv.Mat();
    cv.threshold(maxMat, mask, P.darkThresh, 255, cv.THRESH_BINARY); // 255 where ever-bright = real imagery
    maxMat.delete();
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(P.dilate, P.dilate));
    cv.erode(mask, mask, k);
    k.delete();
    const cxp = Math.floor(W / 2), cyp = Math.floor(H / 2), hh = P.reticleHalf;
    cv.rectangle(mask, new cv.Point(cxp - hh, cyp - hh), new cv.Point(cxp + hh, cyp + hh), new cv.Scalar(0), -1);
    return mask;
}

// Weighted complex least-squares fit of a similarity q = a*p + b (a complex => rotation+scale).
function weightedSimilarity(P, Q, w) {
    let sw = 0, pbx = 0, pby = 0, qbx = 0, qby = 0;
    for (let i = 0; i < P.length; i++) {
        const wi = w[i]; if (wi <= 0) continue;
        sw += wi; pbx += wi * P[i][0]; pby += wi * P[i][1]; qbx += wi * Q[i][0]; qby += wi * Q[i][1];
    }
    if (sw < 1e-9) return null;
    pbx /= sw; pby /= sw; qbx /= sw; qby /= sw;
    let nre = 0, nim = 0, dd = 0;
    for (let i = 0; i < P.length; i++) {
        const wi = w[i]; if (wi <= 0) continue;
        const Pcx = P[i][0] - pbx, Pcy = P[i][1] - pby, Qcx = Q[i][0] - qbx, Qcy = Q[i][1] - qby;
        nre += wi * (Qcx * Pcx + Qcy * Pcy);
        nim += wi * (Qcy * Pcx - Qcx * Pcy);
        dd += wi * (Pcx * Pcx + Pcy * Pcy);
    }
    if (dd < 1e-9) return null;
    const Ax = nre / dd, Ay = nim / dd;
    return { Ax, Ay, Bx: qbx - (Ax * pbx - Ay * pby), By: qby - (Ay * pbx + Ax * pby) };
}

// Deterministic robust similarity fit: trimmed/reweighted least squares. The video background
// dominates (~90% of tracked features are inliers), so a few trimming iterations reject the
// moving foreground object + any stray features without the run-to-run variance of RANSAC.
// Returns the translation of the image CENTER (dx,dy), rotation theta, scale, inlier count.
function fitSimilarity(P, Q, W, H, P_) {
    const n = P.length;
    if (n < 3) return null;
    const thr2 = P_.ransacThr * P_.ransacThr;
    let w = new Array(n).fill(1);
    let res = null;
    for (let iter = 0; iter < 5; iter++) {
        const next = weightedSimilarity(P, Q, w);
        if (!next) break;
        res = next;
        const { Ax, Ay, Bx, By } = res;
        let inl = 0;
        for (let i = 0; i < n; i++) {
            const ex = (Ax * P[i][0] - Ay * P[i][1] + Bx) - Q[i][0];
            const ey = (Ay * P[i][0] + Ax * P[i][1] + By) - Q[i][1];
            const keep = (ex * ex + ey * ey) < thr2 ? 1 : 0;
            w[i] = keep; if (keep) inl++;
        }
        if (inl < 2) break;
    }
    if (!res) return null;
    // Recompute the inlier set, count and RMS residual from the FINAL model, so they always agree
    // with the returned transform (the iterative w[] could otherwise lag the last fit).
    const { Ax, Ay, Bx, By } = res;
    let sse = 0, inliers = 0;
    for (let i = 0; i < n; i++) {
        const ex = (Ax * P[i][0] - Ay * P[i][1] + Bx) - Q[i][0];
        const ey = (Ay * P[i][0] + Ax * P[i][1] + By) - Q[i][1];
        const r2 = ex * ex + ey * ey;
        if (r2 < thr2) { sse += r2; inliers++; }
    }
    const meanResidual = inliers ? Math.sqrt(sse / inliers) : Infinity;
    const cxp = W / 2, cyp = H / 2;
    const mx = Ax * cxp - Ay * cyp + Bx, my = Ay * cxp + Ax * cyp + By;
    return { dx: mx - cxp, dy: my - cyp, theta: Math.atan2(Ay, Ax), scale: Math.hypot(Ax, Ay), inliers, n, meanResidual, Ax, Ay, Bx, By };
}

// Track features prev->cur and fit the similarity. Uses pyramidal Lucas-Kanade with a forward-
// backward consistency check (track cur->prev too and keep only features whose round trip lands
// back where it started) — this robustly discards unreliable tracks before the fit. Returns the
// consensus fit, the per-feature flow vectors (flagged inlier/outlier), and a lowQuality flag for
// frames whose consensus is too weak to trust (the caller interpolates those).
function trackAndFit(cv, prevG, curG, mask, P) {
    const corners = new cv.Mat();
    const maskArg = mask || new cv.Mat();
    try {
        cv.goodFeaturesToTrack(prevG, corners, P.maxFeatures, P.qualityLevel, P.minDistance, maskArg);
    } catch (e) { corners.delete(); if (!mask) maskArg.delete(); return null; }
    if (!mask) maskArg.delete();
    if (corners.rows < 8) { corners.delete(); return null; }

    const win = new cv.Size(P.lkWin ?? 21, P.lkWin ?? 21);
    const crit = new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 30, 0.01);
    const maxLevel = P.pyrLevels ?? 3;

    const nextPts = new cv.Mat(), st = new cv.Mat(), err = new cv.Mat();
    try {
        cv.calcOpticalFlowPyrLK(prevG, curG, corners, nextPts, st, err, win, maxLevel, crit);
    } catch (e) { corners.delete(); nextPts.delete(); st.delete(); err.delete(); return null; }

    // Forward-backward: re-track cur->prev; a reliable feature returns near its start.
    const backPts = new cv.Mat(), st2 = new cv.Mat(), err2 = new cv.Mat();
    let haveFB = true;
    try {
        cv.calcOpticalFlowPyrLK(curG, prevG, nextPts, backPts, st2, err2, win, maxLevel, crit);
    } catch (e) { haveFB = false; }

    const fbThr2 = (P.fbThreshold ?? 0.5) * (P.fbThreshold ?? 0.5);
    const Pp = [], Qq = [], quals = [];
    for (let i = 0; i < st.rows; i++) {
        if (st.data[i] !== 1) continue;
        const e = err.floatAt(i, 0);
        if (e > P.maxTrackError) continue;
        const px = corners.floatAt(i, 0), py = corners.floatAt(i, 1);
        const nx = nextPts.floatAt(i, 0), ny = nextPts.floatAt(i, 1);
        if (haveFB) {
            if (st2.data[i] !== 1) continue;
            const fdx = backPts.floatAt(i, 0) - px, fdy = backPts.floatAt(i, 1) - py;
            if (fdx * fdx + fdy * fdy > fbThr2) continue;   // round-trip mismatch -> drop
        }
        Pp.push([px, py]); Qq.push([nx, ny]); quals.push(Math.max(0, 1 - e / P.maxTrackError));
    }
    corners.delete(); nextPts.delete(); st.delete(); err.delete(); backPts.delete(); st2.delete(); err2.delete();

    const fit = fitSimilarity(Pp, Qq, prevG.cols, prevG.rows, P);
    const thr2 = P.ransacThr * P.ransacThr;
    const vectors = [];
    for (let i = 0; i < Pp.length; i++) {
        let isInlier = false;
        if (fit) {
            const ex = (fit.Ax * Pp[i][0] - fit.Ay * Pp[i][1] + fit.Bx) - Qq[i][0];
            const ey = (fit.Ay * Pp[i][0] + fit.Ax * Pp[i][1] + fit.By) - Qq[i][1];
            isInlier = (ex * ex + ey * ey) < thr2;
        }
        vectors.push({ px: Pp[i][0], py: Pp[i][1], dx: Qq[i][0] - Pp[i][0], dy: Qq[i][1] - Pp[i][1], quality: quals[i], isInlier });
    }

    const tracked = Pp.length;
    const lowQuality = !fit
        || fit.inliers < (P.minInliers ?? 40)
        || (tracked > 0 && fit.inliers / tracked < (P.minInlierFrac ?? 0.35));
    return { fit, vectors, tracked, lowQuality };
}

function smoothMotion(motion, win) {
    if (win <= 1) return motion;
    const h = (win - 1) / 2;
    const keys = ["dx", "dy", "theta"];
    const out = motion.map(m => ({ ...m }));
    for (let i = 0; i < motion.length; i++) {
        for (const key of keys) {
            let s = 0, c = 0;
            for (let j = -h; j <= h; j++) {
                const k = i + j;
                if (k >= 0 && k < motion.length && motion[k]) { s += motion[k][key]; c++; }
            }
            if (c) out[i][key] = s / c;
        }
    }
    return out;
}

// Detect a held/duplicate frame: two grayscale frames that are essentially pixel-identical.
// (Same heuristic as the Motion Analysis duplicate detector.)
function isDuplicateGray(gA, gB) {
    if (!gA || !gB || gA.rows !== gB.rows || gA.cols !== gB.cols) return false;
    const a = gA.data, b = gB.data, n = Math.min(a.length, b.length);
    if (!n) return false;
    const stride = Math.max(1, Math.floor(n / 50000));
    let identical = 0, totalDiff = 0, samples = 0;
    for (let i = 0; i < n; i += stride) { const d = Math.abs(a[i] - b[i]); if (d === 0) identical++; totalDiff += d; samples++; }
    return (identical / samples) >= 0.93 && (totalDiff / samples) <= 0.15;
}

// Spread the motion measured to each reliable frame evenly over any run of preceding UNRELIABLE
// frames (duplicates, undecoded gaps, or low-consensus frames), so they don't freeze then jerk
// the recovered camera. Unreliable frames carry no trustworthy motion of their own; it's
// interpolated from the adjacent reliable frames — the way Motion Analysis handles duplicates for
// panorama building. Returns the count of interpolated frames.
function redistributeUnreliable(motion, vizVectors, interp) {
    const total = motion.length;
    let count = 0, i = 1;
    while (i < total) {
        if (!interp[i]) { i++; continue; }
        let k = i;
        while (k < total && interp[k]) k++;       // run [i..k-1] unreliable; frame k reliable
        count += (k - i);
        if (k < total && motion[k]) {
            const span = k - (i - 1);             // distribute the (i-1 -> k) motion across frames i..k
            const m = motion[k];
            const per = { dx: m.dx / span, dy: m.dy / span, theta: m.theta / span, scale: Math.pow(m.scale || 1, 1 / span) };
            for (let kk = i; kk <= k; kk++) {
                // Interpolated frames (i..k-1) carry confidence 0 so they render/report as
                // low-confidence; only the measured frame k keeps its real confidence.
                motion[kk] = { ...per, confidence: kk === k ? m.confidence : 0 };
                // duplicates/gaps have no flow of their own; show the neighbouring frame's.
                if (!vizVectors[kk] || vizVectors[kk].length === 0) vizVectors[kk] = vizVectors[k];
            }
        }
        i = k + 1;
    }
    return count;
}

// Re-entrancy guard: the Analyze button and the Visualize toggle can both trigger a run, and the
// user can double-click. A second call returns the in-flight promise instead of starting a
// concurrent pass (which would corrupt par.frame, the shared vectors array, and churn cv.Mats).
let _cmInflight = null;
export async function runCameraMotionAnalysis(opts = {}) {
    if (_cmInflight) return _cmInflight;
    _cmInflight = _runCameraMotionAnalysis(opts);
    try { return await _cmInflight; }
    finally { _cmInflight = null; }
}

// Run the full analysis and (re)build the camera-motion track + display nodes.
async function _runCameraMotionAnalysis(opts = {}) {
    const P = { ...DEFAULTS, ...opts };
    const S = status();
    const videoView = getVideo();
    if (!videoView) { S.state = "error"; S.error = "No video"; return null; }
    const vd = videoView.videoData;
    const W = vd.videoWidth, H = vd.videoHeight;
    const total = vd.frames || Sit.frames;
    if (!total || total < 2) { S.state = "error"; S.error = "Need at least 2 video frames"; return null; }

    S.state = "loading-opencv"; S.progress = 0; S.total = total; S.error = null;
    await loadOpenCV();
    const cv = getCV();
    if (!cv || !cv.Mat) { S.state = "error"; S.error = "OpenCV not available"; return null; }

    // Pause playback during analysis, and drive par.frame sequentially (in frameImage) so the
    // render loop requests the same frame we're analysing instead of fighting the decoder.
    const wasPaused = par.paused;
    const wasFrame = par.frame;
    par.paused = true;
    const grayMat = makeGrayHelper(cv, W, H);

    let mask = null;
    let prevG = null;   // current grayscale Mat — deleted in finally so it can't leak on error
    try {
        S.state = "masking";
        mask = await buildMask(cv, vd, W, H, P, grayMat, total);

        S.state = "analyzing";
        const motion = new Array(total);
        const vizVectors = new Array(total);
        const interp = new Array(total).fill(false);   // frame's motion must be interpolated
        Globals.cameraMotionVectors = vizVectors;       // publish now so the overlay fills in live
        motion[0] = { dx: 0, dy: 0, theta: 0, scale: 1, confidence: 1 };
        vizVectors[0] = [];
        const ZERO = () => ({ dx: 0, dy: 0, theta: 0, scale: 1, confidence: 0 });
        let dupCount = 0, lowQCount = 0, residSum = 0, inlierSum = 0, goodCount = 0;
        const img0 = await frameImage(vd, 0);
        if (!img0 || !img0.width) { S.state = "error"; S.error = "Could not decode the first frame"; return null; }
        prevG = grayMat(img0);
        let lastYield = performance.now();
        for (let f = 1; f < total; f++) {
            // Yield to the event loop periodically so the page stays responsive. The optical-flow
            // work is synchronous and, for already-decoded frames, waitForFrame() returns without
            // a macrotask yield — so without this the whole pass blocks the UI thread.
            if (performance.now() - lastYield > 40) {
                await new Promise(r => setTimeout(r));
                lastYield = performance.now();
            }
            const img = await frameImage(vd, f);
            if (!img || !img.width) {
                // Undecoded gap: interpolate later, don't advance prevG (keep last good frame).
                motion[f] = ZERO(); vizVectors[f] = []; interp[f] = true; S.progress = f; continue;
            }
            const curG = grayMat(img);
            if (isDuplicateGray(prevG, curG)) {
                // Held/duplicate frame: skip motion detection; motion interpolated after the pass.
                interp[f] = true; dupCount++; motion[f] = ZERO(); vizVectors[f] = [];
            } else {
                const tf = trackAndFit(cv, prevG, curG, mask, P);
                vizVectors[f] = tf ? subsampleVectors(tf.vectors, 150) : [];
                if (!tf || tf.lowQuality) {
                    // Weak consensus (low texture, mostly outliers): don't trust it — interpolate.
                    interp[f] = true; lowQCount++; motion[f] = ZERO();
                } else {
                    const r = tf.fit;
                    motion[f] = { dx: r.dx, dy: r.dy, theta: r.theta, scale: r.scale, confidence: r.n ? r.inliers / r.n : 0 };
                    residSum += r.meanResidual; inlierSum += r.inliers; goodCount++;
                }
            }
            prevG.delete(); prevG = curG;
            S.progress = f;
        }

        S.duplicates = dupCount;
        S.lowQuality = lowQCount;
        S.interpolated = redistributeUnreliable(motion, vizVectors, interp);
        S.meanResidualPx = goodCount ? +(residSum / goodCount).toFixed(3) : null;   // sub-pixel fit accuracy
        S.meanInliers = goodCount ? Math.round(inlierSum / goodCount) : 0;
        const motionData = smoothMotion(motion, P.smoothing);

        S.state = "building";
        buildPathNodes(motionData, P);
        S.state = "done";
        Globals.cameraMotionData = motionData;
        saveMotionCache(motionData);
        console.log(`[CameraMotion] done: ${goodCount} tracked frames, mean ${S.meanInliers} inliers @ ${S.meanResidualPx}px RMS, ${dupCount} duplicates + ${lowQCount} low-quality interpolated; scale ${S.metersPerPixel} m/px [${S.scaleSource}]`);
        return motionData;
    } catch (e) {
        S.state = "error"; S.error = e.message + "\n" + (e.stack || "");
        return null;
    } finally {
        if (mask) mask.delete();
        if (prevG) { try { prevG.delete(); } catch (e) { /* already freed */ } }
        par.frame = wasFrame;   // restore the playhead (analysis scrubbed through every frame)
        par.paused = wasPaused;
    }
}

// Detach the recovered path from the look-camera switch (reverting the camera source if it was
// the one selected). Must run before the track node is removed, so the switch's choice stays valid.
function detachFromLookCamera() {
    const sw = NodeMan.get(HOOK_SWITCH, false);
    if (sw && sw.inputs && sw.inputs[HOOK_OPTION] !== undefined) {
        try { sw.removeOption(HOOK_OPTION); } catch (e) { /* ignore */ }
    }
}

// Add the recovered path as a camera-source option, optionally selecting it so the look camera
// flies the path.
function attachToLookCamera(select) {
    const sw = NodeMan.get(HOOK_SWITCH, false);
    if (!sw) return;
    sw.replaceOption(HOOK_OPTION, "cameraMotionTrack");
    if (select) { try { sw.selectOption(HOOK_OPTION); } catch (e) { /* ignore */ } }
}

// Remove any nodes from a previous run (display, its child constants, the autoSphere, the
// track). unlinkDisposeRemove safely unlinks each node from its inputs/outputs first.
function clearPathNodes() {
    detachFromLookCamera();
    const ids = [];
    NodeMan.iterate((id) => { if (id.indexOf("cameraMotion") === 0) ids.push(id); });
    for (const id of ids) {
        // Removing a parent (e.g. the autoSphere) cascades to its child constants, so re-check
        // existence to avoid "node does not exist" warnings.
        if (NodeMan.exists(id)) { try { NodeMan.unlinkDisposeRemove(id); } catch (e) { /* ignore */ } }
    }
}

function buildPathNodes(motionData, P) {
    const originNode = NodeMan.get("fixedCameraPosition", false)
        ?? NodeMan.get("flightSimCameraPosition", false)
        ?? NodeMan.get("cameraTrack", false);
    if (!originNode) throw new Error("No origin track (fixedCameraPosition) to anchor the path");

    clearPathNodes();

    // Horizontal scale: physically derived from FOV + altitude when autoScale is on, else manual.
    const autoMpp = P.autoScale ? geometricMetersPerPixel(P) : null;
    const metersPerPixel = autoMpp ?? P.metersPerPixel;
    const S = status();
    S.metersPerPixel = +metersPerPixel.toFixed(2);
    S.scaleSource = autoMpp ? `auto (FOV ${(NodeMan.get("lookCamera").camera.renderedFOV ?? NodeMan.get("lookCamera").camera.fov).toFixed(1)}°, bg ${P.backgroundAlt} m)` : "manual";

    new CNodeCameraMotionTrack({
        id: "cameraMotionTrack",
        origin: originNode.id,
        motion: motionData,
        metersPerPixel,
        signE: P.signE,
        signN: P.signN,
        swapEN: P.swapEN,
        climbGain: P.climbGain,
    });

    new CNodeDisplayTrack({
        id: "cameraMotionDisplay",
        track: "cameraMotionTrack",
        color: new Color(1.0, 0.55, 0.0),
        width: 3,
        trackDisplayStep: 1,
        extendToGround: true,   // vertical "curtain" to the terrain shows the camera's altitude
        autoSphere: 120,        // marker at the current frame
    });

    attachToLookCamera(P.driveLookCamera);

    // Orientation controller on the look camera (recovered roll / nadir). Added last so it
    // overrides the camera's other orientation controllers when enabled.
    const lookCam = NodeMan.get("lookCamera", false);
    if (lookCam) {
        const oc = new CNodeControllerCameraMotionOrientation({
            id: "cameraMotionOrientationController",
            motionTrack: "cameraMotionTrack",
            mode: P.lookOrientation,
            depression: P.depression ?? realLOSDepressionDeg(),
            rollSign: P.rollSign,
            enabled: P.lookOrientation !== "off",
        });
        lookCam.addControllerNode(oc);
    }

    setRenderOne(true);
}

// Flow-vector overlay on the video view (like the Motion Analysis visualization). The per-frame
// flow vectors are computed during the analysis pass (where frames are properly decoded) and
// stored in Globals.cameraMotionVectors; this just draws them as arrows for the current frame:
// green = inliers (consensus background motion), red = outliers (e.g. the moving object).
const FlowViz = {
    enabled: false, hooked: false, overlay: null, ctx: null, view: null,
    targetPx: 22,     // desired median arrow length (video px); scale adapts per frame to this

    ensureOverlay() {
        const vv = getVideo();
        if (!vv) return false;
        // If the video view was replaced (sitch reload / video swap), our overlay + render-hook
        // point at the old, now-detached view — reset so we attach to the new one.
        if (this.view && this.view !== vv) {
            this.overlay = null; this.ctx = null; this.hooked = false; this.view = null;
        }
        if (!this.overlay) {
            this.overlay = document.createElement("canvas");
            Object.assign(this.overlay.style, {
                position: "absolute", top: "0", left: "0", width: "100%", height: "100%",
                pointerEvents: "none", zIndex: "100",
            });
            vv.div.appendChild(this.overlay);
            this.ctx = this.overlay.getContext("2d");
        }
        if (!this.hooked) {
            this.hooked = true;
            this.view = vv;
            const orig = vv.renderCanvas.bind(vv);
            vv.renderCanvas = (frame) => { orig(frame); if (FlowViz.enabled && FlowViz.view === vv) FlowViz.draw(frame); };
        }
        return true;
    },

    draw(frame) {
        const vv = getVideo();
        if (!vv || !this.ctx) return;
        const w = vv.widthPx, h = vv.heightPx;
        if (this.overlay.width !== w || this.overlay.height !== h) { this.overlay.width = w; this.overlay.height = h; }
        const ctx = this.ctx;
        ctx.clearRect(0, 0, w, h);
        const vecs = Globals.cameraMotionVectors && Globals.cameraMotionVectors[Math.floor(frame)];
        if (!vecs || !vecs.length) return;
        // Adaptive amplification: scale so the median vector ~= targetPx. Robust to slow frames
        // (tiny motion -> larger scale) and bad/glitch frames (huge motion -> scale floored).
        const mags = vecs.map(v => Math.hypot(v.dx, v.dy)).sort((a, b) => a - b);
        const median = mags[mags.length >> 1] || 0.01;
        const scale = Math.max(6, Math.min(200, this.targetPx / Math.max(median, 0.01)));
        for (const v of vecs) {
            const [cx, cy] = vv.videoToCanvasCoords(v.px, v.py);
            const [ex, ey] = vv.videoToCanvasCoords(v.px + v.dx * scale, v.py + v.dy * scale);
            const dx = ex - cx, dy = ey - cy;
            const mag = Math.hypot(dx, dy);
            if (mag < 0.5) continue;
            ctx.strokeStyle = v.isInlier ? `hsl(120,80%,${(40 + v.quality * 30).toFixed(0)}%)` : "hsl(0,85%,55%)";
            ctx.lineWidth = 1 + v.quality;
            ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.stroke();
            const a = Math.atan2(dy, dx), hl = Math.min(mag * 0.3, 6);
            ctx.beginPath();
            ctx.moveTo(ex, ey); ctx.lineTo(ex - hl * Math.cos(a - Math.PI / 6), ey - hl * Math.sin(a - Math.PI / 6));
            ctx.moveTo(ex, ey); ctx.lineTo(ex - hl * Math.cos(a + Math.PI / 6), ey - hl * Math.sin(a + Math.PI / 6));
            ctx.stroke();
        }
    },

    show(on) {
        this.enabled = on;
        if (!on && this.ctx && this.overlay) this.ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
        setRenderOne(true);
    },
};

// Keep ~maxN evenly-spaced vectors per frame (bounds memory for the overlay).
function subsampleVectors(vectors, maxN) {
    if (!vectors || vectors.length <= maxN) return vectors ? vectors.slice() : [];
    const step = vectors.length / maxN;
    const out = [];
    for (let i = 0; i < maxN; i++) out.push(vectors[Math.floor(i * step)]);
    return out;
}

let folder = null;
let analyzeItem = null;

export function setupCameraMotionMenu() {
    if (!guiMenus.video) return;
    if (folder) return;            // idempotent
    if (!NodeMan.exists("video")) return;

    folder = guiMenus.video.addFolder("Camera Motion (Background)").close();

    const params = {
        metersPerPixel: DEFAULTS.metersPerPixel,
        autoScale: DEFAULTS.autoScale,
        backgroundAlt: DEFAULTS.backgroundAlt,
        smoothing: DEFAULTS.smoothing,
        signE: DEFAULTS.signE,
        signN: DEFAULTS.signN,
        swapEN: DEFAULTS.swapEN,
        climbGain: DEFAULTS.climbGain,
        driveLookCamera: DEFAULTS.driveLookCamera,
        lookOrientation: DEFAULTS.lookOrientation,
        depression: realLOSDepressionDeg(),
        rollSign: DEFAULTS.rollSign,
        visualize: false,
    };

    // Live optical-flow overlay on the video (green = inliers / background, red = outliers).
    folder.add(params, "visualize").name("Visualize motion").listen().onChange(async (v) => {
        if (v) {
            if (!FlowViz.ensureOverlay()) { params.visualize = false; return; }
            FlowViz.show(true);   // enable now; draws vectors as the analysis pass fills them in
            if (!Globals.cameraMotionVectors) {
                // Flow vectors are produced by the analysis pass; run it if we don't have them yet.
                await runCameraMotionAnalysis({ ...params });
            }
        } else {
            FlowViz.show(false);
        }
    });

    // Horizontal scale. Auto: derive m/px from FOV + camera altitude + the background altitude
    // below. Off: use the manual m/px slider. Either way changes only need a rebuild, not re-analyze.
    const rebuildIfData = () => {
        const data = Globals.cameraMotionData ?? loadMotionCache();
        if (data) buildPathNodes(data, { ...DEFAULTS, ...params });
        setRenderOne(true);
    };
    folder.add(params, "autoScale").name("Auto scale (FOV/alt)").listen().onChange(rebuildIfData);
    folder.add(params, "backgroundAlt", 0, 12000, 50).name("Background alt (m)").listen().onChange(rebuildIfData);
    folder.add(params, "metersPerPixel", 1, 100, 0.5).name("Manual m / pixel").listen().onChange(() => { if (!params.autoScale) rebuildIfData(); });
    folder.add(params, "smoothing", 1, 21, 2).name("Smoothing window");
    folder.add(params, "signE", { "East +": 1, "East -": -1 }).name("dx -> East sign");
    folder.add(params, "signN", { "North +": 1, "North -": -1 }).name("dy -> North sign");
    folder.add(params, "swapEN").name("Swap dx/dy");
    folder.add(params, "climbGain", 0, 3, 0.1).name("Altitude from zoom");

    // Toggle: make the look camera fly the recovered path (vs the normal camera source).
    folder.add(params, "driveLookCamera").name("Drive look camera").listen().onChange((v) => {
        const sw = NodeMan.get(HOOK_SWITCH, false);
        if (!sw) return;
        if (v) {
            if (sw.inputs[HOOK_OPTION] === undefined) { params.driveLookCamera = false; return; }
            if (sw.choice !== HOOK_OPTION) {
                Globals.cameraMotionPrevCamChoice = sw.choice;
                sw.selectOption(HOOK_OPTION);
            }
        } else if (sw.choice === HOOK_OPTION) {
            const prev = Globals.cameraMotionPrevCamChoice;
            sw.selectOption(sw.inputs[prev] !== undefined ? prev : HOOK_FALLBACK);
        }
        setRenderOne(true);
    });

    // Drive the look camera's ORIENTATION from the recovered rotation.
    //   Recovered roll: keep the real aim + add measured roll.
    //   Fixed depression: force a chosen look-down angle (slider) + measured roll.
    folder.add(params, "lookOrientation", { "Off": "off", "Recovered roll": "roll", "Fixed depression": "fixed" })
        .name("Look orientation").listen().onChange((v) => {
            const oc = NodeMan.get("cameraMotionOrientationController", false);
            if (oc) { oc.mode = v; oc.enabled = v !== "off"; }
            setRenderOne(true);
        });
    folder.add(params, "depression", 0, 90, 0.5).name("Depression° (fixed)").listen().onChange((v) => {
        const oc = NodeMan.get("cameraMotionOrientationController", false);
        if (oc) oc.depression = v;
        setRenderOne(true);
    });
    folder.add(params, "rollSign", { "Roll: normal": 1, "Roll: flipped": -1 }).name("Roll direction").listen().onChange((v) => {
        const oc = NodeMan.get("cameraMotionOrientationController", false);
        if (oc) oc.rollSign = v;
        setRenderOne(true);
    });

    const actions = {
        analyze: async () => {
            if (analyzeItem) analyzeItem.name("Analyzing… 0%");
            const interval = setInterval(() => {
                const S = status();
                if (analyzeItem && (S.state === "analyzing" || S.state === "masking")) {
                    analyzeItem.name(`${S.state === "masking" ? "Masking" : "Analyzing"}… ${Math.round(100 * S.progress / Math.max(1, S.total))}%`);
                }
            }, 200);
            try {
                await runCameraMotionAnalysis({ ...params });
            } finally {
                clearInterval(interval);
                const S = status();
                if (analyzeItem) analyzeItem.name(S.state === "error" ? "Analyze & Build Path (error)" : "Analyze & Build Path");
            }
        },
    };
    analyzeItem = folder.add(actions, "analyze").name("Analyze & Build Path");

    // Motion data is per-frame; reject data whose length doesn't match the current video so a
    // path from a previous sitch / a re-encoded video can't be anchored to the wrong frames.
    const matchesVideo = (data) => {
        if (!Array.isArray(data)) return false;
        const expected = getVideo()?.videoData?.frames ?? Sit.frames;
        return !expected || data.length === expected;
    };

    // Re-tune signs/scale without re-running the CV, if we already have motion data.
    const rebuild = {
        rebuild: () => {
            const data = Globals.cameraMotionData ?? loadMotionCache();
            if (!data || !matchesVideo(data)) return;
            Globals.cameraMotionData = data;
            buildPathNodes(data, { ...DEFAULTS, ...params });
        },
        clear: () => {
            clearPathNodes();
            setRenderOne(true);
        },
    };
    folder.add(rebuild, "rebuild").name("Rebuild Path (no re-analyze)");
    folder.add(rebuild, "clear").name("Clear Path");

    // If a previous analysis was cached for this video, restore the path automatically.
    // The video filename (used as the cache key) may not be populated at setup time, so retry
    // a few times until it resolves.
    const tryRestore = (attempt) => {
        if (NodeMan.exists("cameraMotionTrack")) return;
        const cached = loadMotionCache();
        if (cached && matchesVideo(cached)) {
            Globals.cameraMotionData = cached;
            try { buildPathNodes(cached, { ...DEFAULTS, ...params }); setRenderOne(true); } catch (e) { /* ignore */ }
        } else if (!cached && attempt < 5) {
            setTimeout(() => tryRestore(attempt + 1), 1500);
        }
    };
    tryRestore(0);
}

// dev convenience for MCP / console
if (typeof window !== "undefined") {
    window.runCameraMotionAnalysis = runCameraMotionAnalysis;
    window.__flowViz = FlowViz;
}
