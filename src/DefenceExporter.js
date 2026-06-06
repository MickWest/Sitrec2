/**
 * "De-fence" — reconstruct the distant scene behind a foreground fence.
 *
 * Input: a video panned past a fence. The fence is close (large parallax → moves
 * fast) and largely opaque with thin gaps; the distant scene is far (small
 * parallax → moves slowly) and is glimpsed through the moving gaps.
 *
 * Two-layer parallax separation:
 *   1. FENCE motion (dominant): whole-image correlation between consecutive
 *      frames — the fence fills most of the frame.
 *   2. GAP mask: align frames to the fence, then per-pixel temporal VARIANCE.
 *      Static fence boards → low variance; gaps (sliding background) → high
 *      variance. This is content-agnostic (no reliance on colour/brightness).
 *   3. BACKGROUND motion: correlate consecutive frames again, but weighted by the
 *      gap mask, so the fit follows the (slower) background layer.
 *   4. Reconstruct: accumulate each frame's gap pixels into a BACKGROUND-aligned
 *      mosaic (weighted by the gap mask). As the gaps sweep across the scene the
 *      slivers tile into a complete, fence-free background; boards get ~zero
 *      weight and wash out.
 *
 * Motion + mask are computed at low resolution (fast; low-res grays for every
 * frame are cached so motion needs only one decode pass); the mosaic is
 * accumulated at higher resolution in a second decode pass.
 */

import {Globals, NodeMan, setRenderOne, Sit} from "./Globals";
import {par} from "./par";
import {getExportPrefix} from "./utils";

const CORR_SCALE = 0.25;    // resolution for motion + variance/mask
const ACC_SCALE = 0.5;      // resolution for the accumulated mosaic
const SEARCH_X = 26;        // ± keyframe search range (corr-res px)
const SEARCH_Y = 16;
// Motion is estimated over KEYFRAME baselines, not per-frame: the per-frame
// fence-vs-background difference is sub-pixel and unresolvable, but over K frames
// it grows to several px and the gap-weighted correlation cleanly separates the
// slower background layer from the dominant fence.
const KEY_STEP = 8;
const FENCE_THRESH = 0.12;  // gapWeight below this = clearly fence-coloured -> removed
const VAR_THRESH = 0.45;    // fence-aligned variance below this = static structure (board) -> removed.
// (Variance is the primary board detector; the brightness/green gate is a light
//  secondary so dark background in shadow isn't dropped while boards stay out.)

async function loadFrame(videoData, frame) {
    par.frame = frame;
    videoData.getImage(frame);
    const ok = await videoData.waitForFrame(frame, 5000);
    if (!ok) return null;
    const image = (videoData.getImageNoPurge?.(frame)) || videoData.getImage(frame);
    if (!image || !image.width) return null;
    return image;
}

// Per-pixel gap/background weight: light through the gaps (green-excess foliage or
// overall brightness) vs the dark weathered boards. Also the unoccluded scene above
// the fence. r,g,b in 0..255 -> 0..1.
function gapWeight(r, g, b) {
    const bright = 0.299*r + 0.587*g + 0.114*b;
    const greenExcess = g - 0.5 * (r + b);
    // Strict: gray weathered boards (~110-140 brightness, near-zero green excess)
    // must score ~0 so they don't milk out the average; only clearly lit gaps
    // (green foliage) or bright sky/scene above the fence accumulate.
    return Math.max(0, Math.min(1, Math.max((greenExcess - 15) / 65, (bright - 175) / 55)));
}

function grayOf(image, W, H, ctx) {
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(image, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    const g = new Float32Array(W * H);
    const gw = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
        g[i] = 0.299*d[i*4] + 0.587*d[i*4+1] + 0.114*d[i*4+2];
        gw[i] = gapWeight(d[i*4], d[i*4+1], d[i*4+2]);
    }
    return {gray: g, gapw: gw};
}

// Best integer shift (dx,dy) mapping B onto A (min mean-abs-diff), optionally
// weighted by wMask sampled at A's coords (so the fit follows that layer).
function bestShift(A, B, W, H, wMask) {
    const bx = SEARCH_X + 2, by = SEARCH_Y + 2;
    let best = {mad: Infinity, dx: 0, dy: 0};
    for (let dy = -SEARCH_Y; dy <= SEARCH_Y; dy += 1) {
        for (let dx = -SEARCH_X; dx <= SEARCH_X; dx += 1) {
            let s = 0, n = 0;
            for (let y = by; y < H - by; y += 2) {
                for (let x = bx; x < W - bx; x += 2) {
                    const w = wMask ? wMask[y*W+x] : 1;
                    if (w < 0.05) continue;
                    s += w * Math.abs(A[y*W+x] - B[(y+dy)*W + (x+dx)]);
                    n += w;
                }
            }
            const mad = n > 50 ? s / n : Infinity;
            if (mad < best.mad) best = {mad, dx, dy};
        }
    }
    return best;
}

// Bilinear sample of a low-res map at (fx,fy), clamped; returns def outside.
function sampleMap(map, W, H, fx, fy, def) {
    if (fx < 0 || fy < 0 || fx >= W-1 || fy >= H-1) return def;
    const x0 = fx|0, y0 = fy|0, ax = fx-x0, ay = fy-y0;
    const i = y0*W + x0;
    return map[i]*(1-ax)*(1-ay) + map[i+1]*ax*(1-ay) + map[i+W]*(1-ax)*ay + map[i+W+1]*ax*ay;
}

// Cumulative per-frame shift, estimated at keyframes (KEY_STEP apart) then
// linearly interpolated. wMaskFn(frameA) optionally returns a per-pixel weight
// (in frameA coords) so the fit follows a chosen layer (e.g. the gap/background).
function estimateMotion(grays, n, W, H, step, wMasks) {
    const kfs = [0];
    for (let k = step; k < n; k += step) kfs.push(k);
    if (kfs[kfs.length-1] !== n-1) kfs.push(n-1);
    const kx = [0], ky = [0];
    let cx = 0, cy = 0;
    for (let j = 1; j < kfs.length; j++) {
        const a = kfs[j-1], b = kfs[j];
        const s = bestShift(grays[a], grays[b], W, H, wMasks ? wMasks[a] : null);
        cx += s.dx; cy += s.dy; kx.push(cx); ky.push(cy);
    }
    const Vx = new Float32Array(n), Vy = new Float32Array(n);
    for (let j = 1; j < kfs.length; j++) {
        const a = kfs[j-1], b = kfs[j], span = b - a || 1;
        for (let f = a; f <= b; f++) {
            const t = (f - a) / span;
            Vx[f] = kx[j-1] + t * (kx[j] - kx[j-1]);
            Vy[f] = ky[j-1] + t * (ky[j] - ky[j-1]);
        }
    }
    return {Vx, Vy};
}

// Shared analysis (one decode pass, low-res). Caches grays + gap weights, then
// estimates fence motion, the fence-aligned variance reference, background motion,
// and the background-aligned mosaic bounds. Used by both the image and video
// exporters so they reconstruct identically. `first` is frame 0 (already decoded
// by the caller for sizing); frames 1..n-1 are decoded here.
async function analyzeDefence({videoData, frames, n, first, cW, cH, aW, aH, bgBaseline, cCtx, onPct, isCancelled}) {
    const grays = new Array(n), gapws = new Array(n);
    { const s0 = grayOf(first, cW, cH, cCtx); grays[0] = s0.gray; gapws[0] = s0.gapw; }
    for (let i = 1; i < n; i++) {
        if (isCancelled && isCancelled()) throw new Error("cancelled");
        const img = await loadFrame(videoData, frames[i]);
        if (img) { const s = grayOf(img, cW, cH, cCtx); grays[i] = s.gray; gapws[i] = s.gapw; }
        else { grays[i] = grays[i-1]; gapws[i] = gapws[i-1]; }
        if (i % 6 === 0 && onPct) { onPct(Math.round(50*i/n)); await new Promise(r=>setTimeout(r,0)); }
    }

    // Fence motion (dominant): short keyframe baselines, whole-image correlation.
    const {Vx: Vfx, Vy: Vfy} = estimateMotion(grays, n, cW, cH, KEY_STEP, null);

    // Fence-aligned temporal variance -> a static-structure map. A board (even a
    // sunlit one, like the diagonal brace) is static once the fence is aligned, so
    // it has LOW variance; real background seen through gaps / above the fence
    // keeps changing -> HIGH variance.
    const sum = new Float32Array(cW*cH), sumsq = new Float32Array(cW*cH), cnt = new Float32Array(cW*cH);
    for (let i = 0; i < n; i++) {
        const gi = grays[i], vfx = Vfx[i], vfy = Vfy[i];
        for (let y = 0; y < cH; y++) for (let x = 0; x < cW; x++) {
            // Bilinear (not nearest) so sub-pixel fence motion doesn't smear the
            // boards' wood-grain into false variance.
            const v = sampleMap(gi, cW, cH, x + vfx, y + vfy, NaN);
            if (v !== v) continue;   // out of bounds
            const k = y*cW + x;
            sum[k] += v; sumsq[k] += v*v; cnt[k]++;
        }
    }
    const stdSorted = [];
    const varRef = new Float32Array(cW*cH);
    for (let k = 0; k < cW*cH; k++) {
        if (cnt[k] < 4) { varRef[k] = 0; continue; }
        const m = sum[k]/cnt[k]; varRef[k] = Math.sqrt(Math.max(0, sumsq[k]/cnt[k] - m*m)); stdSorted.push(varRef[k]);
    }
    stdSorted.sort((a,b)=>a-b);
    const vp80 = stdSorted[Math.floor(stdSorted.length*0.80)] || 1;
    for (let k = 0; k < cW*cH; k++) varRef[k] = Math.min(1, varRef[k] / vp80);

    // Background motion (slower): LONGER baselines so the parallax difference is
    // resolvable, weighted toward the lit gap / above-fence scene.
    if (onPct) { onPct(70); await new Promise(r=>setTimeout(r,0)); }
    const {Vx: Vbx, Vy: Vby} = estimateMotion(grays, n, cW, cH, bgBaseline, gapws);

    const c2a = ACC_SCALE / CORR_SCALE;
    console.log(`De-fence: fence ${(Vfx[n-1]/CORR_SCALE).toFixed(0)},${(Vfy[n-1]/CORR_SCALE).toFixed(0)}px; background ${(Vbx[n-1]/CORR_SCALE).toFixed(0)},${(Vby[n-1]/CORR_SCALE).toFixed(0)}px (full-res)`);

    // Mosaic bounds (background-aligned, acc-res).
    let minx=0,maxx=0,miny=0,maxy=0;
    for (let i=0;i<n;i++){ const bx=-Vbx[i]*c2a, by=-Vby[i]*c2a; if(bx<minx)minx=bx;if(bx>maxx)maxx=bx;if(by<miny)miny=by;if(by>maxy)maxy=by; }
    const offX = Math.ceil(-minx), offY = Math.ceil(-miny);
    const mosW = Math.ceil(aW + maxx - minx), mosH = Math.ceil(aH + maxy - miny);
    console.log(`De-fence: mosaic ${mosW}x${mosH}`);

    return {grays, gapws, Vfx, Vfy, Vbx, Vby, varRef, c2a, corr2acc: CORR_SCALE/ACC_SCALE, offX, offY, mosW, mosH};
}

export async function exportDefence(o) {
    const videoData = o.videoData;
    const startFrame = o.startFrame, endFrame = o.endFrame;
    const t = o.t || ((k) => k);
    const setMenuLabel = o.setMenuLabel || (() => {});
    const doneLabel = o.doneLabel || null;
    // Tunable thresholds (exposed as De-Fence sliders) + classifier technique.
    const varThresh = (o.varThresh != null) ? o.varThresh : VAR_THRESH;
    const gapThresh = (o.gapThresh != null) ? o.gapThresh : FENCE_THRESH;
    const bgBaseline = Math.max(1, Math.round(o.bgBaseline || KEY_STEP * 3));
    // Technique selects which gate(s) decide fence-vs-background:
    //   colour          -> lit-gap colour only
    //   variance        -> fence-aligned temporal variance only (pure motion, colour-agnostic)
    //   colourVariance  -> both (default)
    const technique = o.technique || "colourVariance";
    const useColour = technique === "colour" || technique === "colourVariance";
    const useVariance = technique === "variance" || technique === "colourVariance";

    if (endFrame <= startFrame) { alert("Select a frame range (A-B) for de-fence"); return; }
    const frames = [];
    for (let f = startFrame; f <= endFrame; f++) frames.push(f);
    const n = frames.length;

    const savedPaused = par.paused, savedFrame = par.frame, savedJVA = Globals.justVideoAnalysis;
    Globals.justVideoAnalysis = true;
    par.paused = true;

    let overlay = null, cancelled = false;
    try {
        const first = await loadFrame(videoData, frames[0]);
        if (!first) { alert("Could not load the first video frame"); return; }
        const fullW = first.width, fullH = first.height;

        overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:#000;z-index:9999;display:flex;align-items:center;justify-content:center;flex-direction:column;';
        const prev = document.createElement('canvas');
        prev.style.cssText = 'max-width:95vw;max-height:78vh;border:2px solid #444;background:#111;';
        prev.width = Math.min(fullW, 900); prev.height = Math.round(prev.width * fullH / fullW);
        const pctx = prev.getContext('2d');
        const status = document.createElement('div');
        status.style.cssText = 'color:#fff;font:16px sans-serif;margin-top:12px;';
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel'; cancelBtn.style.cssText = 'margin-top:12px;padding:6px 16px;cursor:pointer;';
        cancelBtn.onclick = () => { cancelled = true; };
        overlay.append(prev, status, cancelBtn);
        document.body.appendChild(overlay);

        const cW = Math.round(fullW * CORR_SCALE), cH = Math.round(fullH * CORR_SCALE);
        const aW = Math.round(fullW * ACC_SCALE), aH = Math.round(fullH * ACC_SCALE);
        const cCanvas = document.createElement('canvas'); cCanvas.width = cW; cCanvas.height = cH;
        const cCtx = cCanvas.getContext('2d', {willReadFrequently: true});
        const aCanvas = document.createElement('canvas'); aCanvas.width = aW; aCanvas.height = aH;
        const aCtx = aCanvas.getContext('2d', {willReadFrequently: true});

        // ===== analysis (one decode pass): motion + variance + mosaic bounds =====
        const {Vfx, Vfy, Vbx, Vby, varRef, c2a, corr2acc, offX, offY, mosW, mosH} = await analyzeDefence({
            videoData, frames, n, first, cW, cH, aW, aH, bgBaseline, cCtx,
            onPct: (pct) => { status.textContent = t("defence.analyzing", {pct}); },
            isCancelled: () => cancelled,
        });
        const sR=new Float32Array(mosW*mosH), sG=new Float32Array(mosW*mosH), sB=new Float32Array(mosW*mosH), sW=new Float32Array(mosW*mosH);
        // Per-pixel sample store for a temporal MEDIAN combine (robust to the odd
        // board pixel that slips through the mask -> kills streaks). Capped to K
        // samples/px; falls back to mean for very large mosaics. Mean (sR..sW) is
        // also kept for the live preview and the median fallback.
        const MED_K = 18;
        const useMedian = mosW*mosH <= 12_000_000;
        const samp = useMedian ? new Uint8Array(mosW*mosH*MED_K*3) : null;
        const cntS = useMedian ? new Uint16Array(mosW*mosH) : null;

        // ===== PASS 2: accumulate gap/background pixels into the mosaic =====
        for (let i = 0; i < n; i++) {
            if (cancelled) throw new Error("cancelled");
            const img = await loadFrame(videoData, frames[i]);
            if (!img) continue;
            aCtx.clearRect(0,0,aW,aH); aCtx.drawImage(img, 0, 0, aW, aH);
            const d = aCtx.getImageData(0,0,aW,aH).data;
            const sx = Math.round(offX - Vbx[i]*c2a), sy = Math.round(offY - Vby[i]*c2a);
            const vfx = Vfx[i], vfy = Vfy[i];
            for (let y = 0; y < aH; y++) {
                const oy = y + sy; if (oy < 0 || oy >= mosH) continue;
                for (let x = 0; x < aW; x++) {
                    const si = (y*aW+x)*4;
                    // Fence pixels removed ENTIRELY. Which gate(s) decide "fence vs
                    // background" depends on the selected technique (colour / variance /
                    // both). Variance = pure motion separation (fence is static once
                    // fence-aligned; background slides -> high variance).
                    if (useColour && gapWeight(d[si], d[si+1], d[si+2]) < gapThresh) continue;
                    if (useVariance && sampleMap(varRef, cW, cH, x*corr2acc - vfx, y*corr2acc - vfy, 0) < varThresh) continue;
                    const ox = x + sx; if (ox < 0 || ox >= mosW) continue;
                    const mi = oy*mosW+ox;
                    sR[mi]+=d[si]; sG[mi]+=d[si+1]; sB[mi]+=d[si+2]; sW[mi]+=1;
                    if (samp) { const c = cntS[mi]; if (c < MED_K) { const b = (mi*MED_K+c)*3; samp[b]=d[si]; samp[b+1]=d[si+1]; samp[b+2]=d[si+2]; cntS[mi]=c+1; } }
                }
            }
            if (i % 4 === 0) {
                status.textContent = t("defence.building", {pct: Math.round(60 + 40*i/n)});
                setMenuLabel("status.renderingPercent", {pct: Math.round(100*i/n)});
                renderPreview(pctx, prev, sR, sG, sB, sW, mosW, mosH);
                await new Promise(r=>setTimeout(r,0));
            }
        }

        const out = combineMosaic(mosW, mosH, sR, sG, sB, sW, samp, cntS, MED_K);
        pctx.fillStyle = '#111'; pctx.fillRect(0, 0, prev.width, prev.height);
        pctx.drawImage(out, 0, 0, prev.width, prev.height);
        status.textContent = t("defence.saving");
        await new Promise((resolve) => {
            out.toBlob((blob) => {
                if (blob) {
                    const filename = `${getExportPrefix()}_defence_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.png`;
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
                    URL.revokeObjectURL(url);
                    console.log(`De-fence exported: ${filename}`);
                }
                resolve();
            }, 'image/png');
        });
    } catch (e) {
        if (e.message !== "cancelled") { console.error('De-fence failed:', e); alert('De-fence failed: ' + e.message); }
    } finally {
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        Globals.justVideoAnalysis = savedJVA;
        par.paused = savedPaused; par.frame = savedFrame;
        if (doneLabel) setMenuLabel(doneLabel);
        setRenderOne(true);
    }
}

function renderPreview(pctx, prev, sR, sG, sB, sW, mosW, mosH) {
    const tmp = document.createElement('canvas'); tmp.width = mosW; tmp.height = mosH;
    const tctx = tmp.getContext('2d'); const id = tctx.createImageData(mosW, mosH);
    for (let i = 0; i < mosW*mosH; i++) {
        const w = sW[i];
        if (w > 0) { id.data[i*4]=sR[i]/w; id.data[i*4+1]=sG[i]/w; id.data[i*4+2]=sB[i]/w; }
        id.data[i*4+3] = 255;
    }
    tctx.putImageData(id, 0, 0);
    pctx.fillStyle = '#111'; pctx.fillRect(0,0,prev.width,prev.height);
    pctx.drawImage(tmp, 0, 0, prev.width, prev.height);
}

// Combine the accumulated mosaic into a finished canvas: per-pixel temporal MEDIAN
// where samples were stored (robust to stray board pixels), else the running mean.
function combineMosaic(mosW, mosH, sR, sG, sB, sW, samp, cntS, MED_K) {
    const out = document.createElement('canvas'); out.width = mosW; out.height = mosH;
    const octx = out.getContext('2d'); const id = octx.createImageData(mosW, mosH);
    const useMedian = !!samp;
    const ch = new Uint8Array(MED_K);
    const medianCh = (mi, off) => {                     // median of one channel over the pixel's samples
        const c = cntS[mi]; const base = mi*MED_K*3 + off;
        for (let j = 0; j < c; j++) ch[j] = samp[base + j*3];
        for (let a = 1; a < c; a++) { const v = ch[a]; let b = a-1; while (b>=0 && ch[b]>v) { ch[b+1]=ch[b]; b--; } ch[b+1]=v; }
        return ch[c>>1];
    };
    for (let i = 0; i < mosW*mosH; i++) {
        if (useMedian && cntS[i] > 0) {
            id.data[i*4] = medianCh(i,0); id.data[i*4+1] = medianCh(i,1); id.data[i*4+2] = medianCh(i,2);
        } else if (sW[i] > 0) {
            id.data[i*4]=sR[i]/sW[i]; id.data[i*4+1]=sG[i]/sW[i]; id.data[i*4+2]=sB[i]/sW[i];
        }
        id.data[i*4+3] = 255;
    }
    octx.putImageData(id, 0, 0);
    return out;
}

/**
 * Export a video that VISUALISES the de-fence process in three phases:
 *   1. a single pass of the original video (the fence as filmed),
 *   2. the fence dissolving as background pixels accumulate through the gaps,
 *   3. a hold on the final reconstructed scene.
 * Shares the exact analysis (analyzeDefence) + combine (combineMosaic) with the
 * still-image exporter, so the held result matches the PNG export.
 */
export async function exportDefenceVideo(o) {
    const videoData = o.videoData;
    const startFrame = o.startFrame, endFrame = o.endFrame;
    const t = o.t || ((k) => k);
    const setMenuLabel = o.setMenuLabel || (() => {});
    const doneLabel = o.doneLabel || null;
    const varThresh = (o.varThresh != null) ? o.varThresh : VAR_THRESH;
    const gapThresh = (o.gapThresh != null) ? o.gapThresh : FENCE_THRESH;
    const bgBaseline = Math.max(1, Math.round(o.bgBaseline || KEY_STEP * 3));
    const technique = o.technique || "colourVariance";
    const useColour = technique === "colour" || technique === "colourVariance";
    const useVariance = technique === "variance" || technique === "colourVariance";

    if (endFrame <= startFrame) { alert("Select a frame range (A-B) for de-fence"); return; }
    const frames = [];
    for (let f = startFrame; f <= endFrame; f++) frames.push(f);
    const n = frames.length;

    const savedPaused = par.paused, savedFrame = par.frame, savedJVA = Globals.justVideoAnalysis;
    Globals.justVideoAnalysis = true;
    par.paused = true;

    let overlay = null, cancelled = false, exporter = null;
    try {
        const first = await loadFrame(videoData, frames[0]);
        if (!first) { alert("Could not load the first video frame"); return; }
        const fullW = first.width, fullH = first.height;

        overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:#000;z-index:9999;display:flex;align-items:center;justify-content:center;flex-direction:column;';
        const prev = document.createElement('canvas');
        prev.style.cssText = 'max-width:95vw;max-height:78vh;border:2px solid #444;background:#111;';
        prev.width = Math.min(fullW, 700); prev.height = Math.round(prev.width * fullH / fullW);
        const pctx = prev.getContext('2d');
        const status = document.createElement('div');
        status.style.cssText = 'color:#fff;font:16px sans-serif;margin-top:12px;';
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel'; cancelBtn.style.cssText = 'margin-top:12px;padding:6px 16px;cursor:pointer;';
        cancelBtn.onclick = () => { cancelled = true; };
        overlay.append(prev, status, cancelBtn);
        document.body.appendChild(overlay);

        const cW = Math.round(fullW * CORR_SCALE), cH = Math.round(fullH * CORR_SCALE);
        const aW = Math.round(fullW * ACC_SCALE), aH = Math.round(fullH * ACC_SCALE);
        const cCanvas = document.createElement('canvas'); cCanvas.width = cW; cCanvas.height = cH;
        const cCtx = cCanvas.getContext('2d', {willReadFrequently: true});

        const {Vfx, Vfy, Vbx, Vby, varRef, c2a, corr2acc, offX, offY, mosW, mosH} = await analyzeDefence({
            videoData, frames, n, first, cW, cH, aW, aH, bgBaseline, cCtx,
            onPct: (pct) => { status.textContent = t("defence.analyzing", {pct}); },
            isCancelled: () => cancelled,
        });

        // ---- video exporter ----
        const {createVideoExporter, getVideoExtension, getBestFormatForResolution, checkVideoEncodingSupport} = await import("./VideoExporter");
        const support = await checkVideoEncodingSupport();
        if (!support.supported) { alert(t("defence.video.unsupported")); return; }
        let outW = mosW, outH = mosH;
        const sc = Math.min(1, 1920 / Math.max(outW, outH));
        outW = Math.max(2, Math.round(outW * sc / 2) * 2);
        outH = Math.max(2, Math.round(outH * sc / 2) * 2);
        const formatId = support.h264 ? 'mp4-h264' : 'webm-vp8';
        const bestFormat = await getBestFormatForResolution(formatId, outW, outH);
        if (!bestFormat.formatId) { alert("De-fence video: " + bestFormat.reason); return; }
        const extension = getVideoExtension(bestFormat.formatId);
        const fps = Sit.fps || 30;
        exporter = await createVideoExporter(bestFormat.formatId, {
            width: outW, height: outH, fps, bitrate: 16_000_000, keyFrameInterval: 30,
            hardwareAcceleration: bestFormat.hardwareAcceleration,
        });
        await exporter.initialize();

        // make the preview match the output aspect
        prev.width = Math.min(outW, 700); prev.height = Math.round(prev.width * outH / outW);

        const outCanvas = document.createElement('canvas'); outCanvas.width = outW; outCanvas.height = outH;
        const octx = outCanvas.getContext('2d');
        const outScaleX = outW / mosW, outScaleY = outH / mosH;
        let outIdx = 0;
        const addOut = async () => { await exporter.addFrame(outCanvas, outIdx++); };
        const showPreview = () => { pctx.fillStyle = '#111'; pctx.fillRect(0,0,prev.width,prev.height); pctx.drawImage(outCanvas, 0,0, prev.width, prev.height); };
        const drawLabel = (text) => {
            const fs = Math.max(14, Math.round(outH * 0.025)), pad = Math.round(fs * 0.5);
            octx.save(); octx.font = `${fs}px sans-serif`; octx.textBaseline = 'top';
            const tw = octx.measureText(text).width;
            octx.fillStyle = 'rgba(0,0,0,0.55)'; octx.fillRect(pad*0.7, pad*0.7, tw + pad*2, fs + pad*1.4);
            octx.fillStyle = '#fff'; octx.fillText(text, pad*1.7, pad*1.4); octx.restore();
        };

        // ===== PHASE A: original video, contain-fit =====
        for (let i = 0; i < n; i++) {
            if (cancelled) throw new Error("cancelled");
            const img = await loadFrame(videoData, frames[i]);
            octx.fillStyle = '#000'; octx.fillRect(0,0,outW,outH);
            if (img) {
                const s = Math.min(outW/img.width, outH/img.height);
                const w = img.width*s, h = img.height*s;
                octx.drawImage(img, (outW-w)/2, (outH-h)/2, w, h);
            }
            drawLabel(t("defence.video.phaseOriginal"));
            await addOut();
            if (i % 4 === 0) {
                status.textContent = `${t("defence.video.phaseOriginal")} ${Math.round(100*i/n)}%`;
                setMenuLabel("status.videoPercent", {pct: Math.round(33*i/n)});
                showPreview(); await new Promise(r=>setTimeout(r,0));
            }
        }

        // ===== PHASE B: accumulate gap pixels; fence dissolves into the revealed scene =====
        const sR=new Float32Array(mosW*mosH), sG=new Float32Array(mosW*mosH), sB=new Float32Array(mosW*mosH), sW=new Float32Array(mosW*mosH);
        const MED_K = 18;
        const useMedian = mosW*mosH <= 12_000_000;
        const samp = useMedian ? new Uint8Array(mosW*mosH*MED_K*3) : null;
        const cntS = useMedian ? new Uint16Array(mosW*mosH) : null;
        const aCanvas = document.createElement('canvas'); aCanvas.width = aW; aCanvas.height = aH;
        const aCtx = aCanvas.getContext('2d', {willReadFrequently: true});
        const revealCanvas = document.createElement('canvas'); revealCanvas.width = mosW; revealCanvas.height = mosH;
        const revealCtx = revealCanvas.getContext('2d');
        const revealID = revealCtx.createImageData(mosW, mosH);

        for (let i = 0; i < n; i++) {
            if (cancelled) throw new Error("cancelled");
            const img = await loadFrame(videoData, frames[i]);
            if (!img) continue;
            aCtx.clearRect(0,0,aW,aH); aCtx.drawImage(img, 0, 0, aW, aH);
            const d = aCtx.getImageData(0,0,aW,aH).data;
            const sx = Math.round(offX - Vbx[i]*c2a), sy = Math.round(offY - Vby[i]*c2a);
            const vfx = Vfx[i], vfy = Vfy[i];
            for (let y = 0; y < aH; y++) {
                const oy = y + sy; if (oy < 0 || oy >= mosH) continue;
                for (let x = 0; x < aW; x++) {
                    const si = (y*aW+x)*4;
                    if (useColour && gapWeight(d[si], d[si+1], d[si+2]) < gapThresh) continue;
                    if (useVariance && sampleMap(varRef, cW, cH, x*corr2acc - vfx, y*corr2acc - vfy, 0) < varThresh) continue;
                    const ox = x + sx; if (ox < 0 || ox >= mosW) continue;
                    const mi = oy*mosW+ox;
                    sR[mi]+=d[si]; sG[mi]+=d[si+1]; sB[mi]+=d[si+2]; sW[mi]+=1;
                    if (samp) { const c = cntS[mi]; if (c < MED_K) { const b = (mi*MED_K+c)*3; samp[b]=d[si]; samp[b+1]=d[si+1]; samp[b+2]=d[si+2]; cntS[mi]=c+1; } }
                }
            }
            // display: the raw frame (fence) at its background-aligned spot, with the
            // accumulated background painted on top -> watch the fence get eaten away.
            octx.fillStyle = '#000'; octx.fillRect(0,0,outW,outH);
            octx.drawImage(aCanvas, sx*outScaleX, sy*outScaleY, aW*outScaleX, aH*outScaleY);
            for (let k = 0; k < mosW*mosH; k++) {
                const w = sW[k];
                if (w > 0) { revealID.data[k*4]=sR[k]/w; revealID.data[k*4+1]=sG[k]/w; revealID.data[k*4+2]=sB[k]/w; revealID.data[k*4+3]=255; }
                else revealID.data[k*4+3]=0;
            }
            revealCtx.putImageData(revealID, 0, 0);
            octx.drawImage(revealCanvas, 0,0, mosW,mosH, 0,0, outW,outH);
            drawLabel(t("defence.video.phaseRemoving"));
            await addOut();
            if (i % 3 === 0) {
                status.textContent = `${t("defence.video.phaseRemoving")} ${Math.round(100*i/n)}%`;
                setMenuLabel("status.videoPercent", {pct: Math.round(33 + 34*i/n)});
                showPreview(); await new Promise(r=>setTimeout(r,0));
            }
        }

        // ===== PHASE C: hold the final reconstructed scene =====
        // (The held image is static by design, so report progress in the status text
        //  and on the canvas — otherwise the unchanging preview looks frozen.)
        const finalCanvas = combineMosaic(mosW, mosH, sR, sG, sB, sW, samp, cntS, MED_K);
        const holdFrames = Math.round((o.holdSeconds || 2.5) * fps);
        for (let h = 0; h < holdFrames; h++) {
            if (cancelled) throw new Error("cancelled");
            octx.fillStyle = '#000'; octx.fillRect(0,0,outW,outH);
            octx.drawImage(finalCanvas, 0,0, mosW,mosH, 0,0, outW,outH);
            drawLabel(t("defence.video.phaseResult"));
            await addOut();
            const pct = Math.round(100 * (h+1) / holdFrames);
            status.textContent = t("defence.video.encodingHold", {pct});
            if (h % 5 === 0) { setMenuLabel("status.videoPercent", {pct: Math.round(67 + 33*h/holdFrames)}); showPreview(); await new Promise(r=>setTimeout(r,0)); }
        }

        status.textContent = t("defence.saving");
        const blob = await exporter.finalize(() => {}, (s) => { status.textContent = s; });
        exporter = null;
        const filename = `${getExportPrefix()}_defence_video_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.${extension}`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
        URL.revokeObjectURL(url);
        console.log(`De-fence video exported: ${filename} (${outW}x${outH}, ${outIdx} frames)`);
    } catch (e) {
        if (e.message !== "cancelled") { console.error('De-fence video failed:', e); alert('De-fence video failed: ' + e.message); }
    } finally {
        if (exporter) { try { await exporter.dispose?.(); } catch (_) {} }
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        Globals.justVideoAnalysis = savedJVA;
        par.paused = savedPaused; par.frame = savedFrame;
        if (doneLabel) setMenuLabel(doneLabel);
        setRenderOne(true);
    }
}
