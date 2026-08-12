// "Optimize For Star Tracking" - a search over the Video Adjustments for the settings that extract
// the best star field from the CURRENT frame.
//
// The same shape as "Optimize" under Motion Analysis's Tracking Parameters: a small population, a
// generation per click of the event loop so the UI stays alive, and Enough / Abort while it runs.
//
// THE ONE IDEA THIS FILE IS BUILT ON
//
// The candidate picture decides WHERE detections are. It is not allowed to say whether those
// places hold anything real.
//
// The first version let it, and the search promptly cheated. The detector thresholds at
// bg + threshSigma * sigma where sigma is the LOCAL noise, measured as max(0.5, 1.4826 * MAD)
// (StarDetect.js estimateBackground) - and its clipping loop discards only the HIGH side. Crush the
// blacks and most of a tile lands on one or two dark codes: MAD goes to zero, sigma sticks at the
// 0.5 floor, and every positive wobble left standing reports a huge peakSNR. A peak five luma codes
// above black scored as a confident star. The search found that in seconds, every time, and the
// picture it produced identified NOTHING against the catalog (measured: 47-72 detections, 0
// identified, against 16 detections and 8 identified for the untouched frame).
//
// So the yardstick is fixed before the search starts: a reference evidence map built from the frame
// with these six controls NEUTRAL. A detection is credited by what the REFERENCE says is at that
// location, which no candidate can alter. Brightness, contrast and black-crushing move detections
// around; they cannot manufacture evidence.
//
// The second half of the same lesson: more detections is not better. The identifier's chance-match
// expectation grows with the number of image stars (StarIdentify.js), so detections with no catalog
// counterpart make identification HARDER - measured, 47 detections identified 0 where the same
// picture at a higher threshold gave 15 detections and 8 identified. The score is therefore capped
// at the identifier's own anchor budget and multiplied by a purity term, so junk costs something
// instead of being free.

import {NodeMan, Sit, setRenderOne} from "../Globals";
import {isLocal} from "../configUtils";
import {par} from "../par";
import {backgroundAt, detectSources, estimateBackground, gaussianBlur, lumaFromRGBA, rejectReason,
    STAR_DETECT_DEFAULTS} from "./StarDetect";
import {STAR_IDENTIFY_DEFAULTS} from "./StarIdentify";
import {captureStarTrackerResult, getStarTrackerTweaks, restoreStarTrackerResult,
    scoreStarTrackerIdentification, setStarOptimizeMenuBuilder, setStarTrackerTweaks,
    starTrackerAppliesAdjustments, starTrackerAutoSigma, starTrackerDetectOptions,
    starTrackerVideoMask} from "./StarTrackerUI";

// The searched genes, in menu order. The bounds are the SEARCH space, not the sliders' range:
// Brightness and Contrast go to 5 on the slider, but a night frame gained past ~3 is mostly clipped
// sky, and Blur goes to 50 where a star is a 1-3 pixel point source - past a few pixels the search
// would be spending its population on settings that erase the very thing being detected. The user
// can still dial any slider anywhere by hand; this only bounds where the search looks.
const GENES = [
    {key: "brightness", id: "videoBrightness", min: 0.2, max: 3, step: 0.01, neutral: 1, dp: 2, label: "Brightness"},
    {key: "contrast", id: "videoContrast", min: 0.2, max: 3, step: 0.01, neutral: 1, dp: 2, label: "Contrast"},
    {key: "shadows", id: "videoShadows", min: -100, max: 100, step: 1, neutral: 0, dp: 0, label: "Shadows"},
    {key: "highlights", id: "videoHighlights", min: -100, max: 100, step: 1, neutral: 0, dp: 0, label: "Highlights"},
    {key: "dehaze", id: "videoDehaze", min: -100, max: 100, step: 1, neutral: 0, dp: 0, label: "Dehaze"},
    // Labels are the ones ON the sliders (i18n nodeLabels), not the node descriptions - the change
    // report names controls the user has to be able to find.
    {key: "blur", id: "videoBlur", min: 0, max: 5, step: 0.05, neutral: 0, dp: 2, label: "Blur Amount"},
];

const POPULATION_SIZE = 10;
const ELITE_COUNT = 3;
// Mutations per child, and the chance that a mutated gene is snapped to its neutral value instead
// of nudged. The snap matters more than it looks: for these adjustments "no adjustment at all" is a
// high-probability optimum, and a walk in 10% steps only ever approaches it asymptotically.
const MUTATION_CHANCE = 0.5;
const NEUTRAL_SNAP_CHANCE = 0.2;
const MAX_NO_IMPROVE = 4;
// How many of stage one's candidates stage two re-scores against catalog identification. Three,
// because each check costs a full analysis, and the fast score is now trustworthy enough that the
// answer is usually its first choice.
const RERANK_COUNT = 3;
// A hard stop, so a landscape that keeps yielding tiny improvements still terminates.
const MAX_GENERATIONS = 30;

const clamp01 = (x) => x < 0 ? 0 : x > 1 ? 1 : x;

function quantize(gene, value) {
    const clamped = Math.max(gene.min, Math.min(gene.max, value));
    const snapped = Math.round(clamped / gene.step) * gene.step;
    // Re-clamp: rounding can push a value a step outside the bound it was just clamped into.
    return Math.max(gene.min, Math.min(gene.max, snapped));
}

function geneNode(gene) {
    return NodeMan.get(gene.id, false);
}

/** Every gene's node, or null when the Video Adjustments have not been built yet. */
function geneNodes() {
    const nodes = {};
    for (const gene of GENES) {
        const node = geneNode(gene);
        if (!node) return null;
        nodes[gene.key] = node;
    }
    return nodes;
}

function readGenome() {
    const genome = {};
    for (const gene of GENES) genome[gene.key] = geneNode(gene)?.value ?? gene.neutral;
    return genome;
}

function neutralGenome() {
    const genome = {};
    for (const gene of GENES) genome[gene.key] = gene.neutral;
    return genome;
}

function randomGenome() {
    const genome = {};
    for (const gene of GENES) {
        genome[gene.key] = quantize(gene, gene.min + Math.random() * (gene.max - gene.min));
    }
    return genome;
}

/**
 * Push a genome into the sliders.
 *
 * commit=false is the inner loop: the value is assigned straight onto the node, which is all the
 * render pipeline reads, and lil-gui's .listen() carries it to the slider so the user can watch the
 * search move. commit=false deliberately does NOT run the change bookkeeping - a cascade and a
 * dirty-flag per candidate, hundreds of times a run, for values that are about to be thrown away.
 *
 * commit=true is the answer: it goes through the controller so the sitch is marked dirty and the
 * cascade runs, exactly as if the user had dragged each slider to that value.
 */
function applyGenome(genome, commit = false) {
    for (const gene of GENES) {
        const node = geneNode(gene);
        if (!node) continue;
        const value = genome[gene.key];
        if (commit && node.guiEntry?.setValue) {
            node.guiEntry.setValue(value);
        } else {
            node.value = value;
            node.guiEntry?.updateDisplay?.();
        }
    }
}

function genomeKey(genome) {
    return GENES.map((g) => genome[g.key].toFixed(4)).join(",");
}

/**
 * The candidates worth spending an identification check on: simply the best few.
 *
 * It was not always simply the best few. Against the old score - which rewarded crushed blacks -
 * the top candidates were all variations of the same cheat, so the pool was padded with "mild"
 * ones to give the honest basin a hearing. That was a workaround for a broken yardstick, and it
 * failed on its own terms: admitting mild candidates only above a fraction of the CHEAT's inflated
 * score excluded exactly the candidates it was meant to rescue. With a fitness the search cannot
 * inflate, its ranking is worth trusting, and this is a plain top-N again.
 */
function rerankPool(entries, originalKey) {
    return entries
        .filter((c) => genomeKey(c.genome) !== originalKey)
        .sort((a, b) => b.result.score - a.result.score)
        .slice(0, RERANK_COUNT);
}

function crossover(a, b) {
    const child = {};
    for (const gene of GENES) child[gene.key] = Math.random() < 0.5 ? a[gene.key] : b[gene.key];
    return child;
}

function mutate(genome) {
    const mutated = {...genome};
    // At least one gene, sometimes two: single-gene steps climb a ridge, pairs get off it.
    const count = Math.random() < 0.3 ? 2 : 1;
    for (let i = 0; i < count; i++) {
        const gene = GENES[Math.floor(Math.random() * GENES.length)];
        if (Math.random() < NEUTRAL_SNAP_CHANCE) {
            mutated[gene.key] = gene.neutral;
            continue;
        }
        // A step up to 20% of the range, either way. Big enough to escape a local bump, small
        // enough that a good individual survives being nudged.
        const span = (gene.max - gene.min) * 0.2;
        mutated[gene.key] = quantize(gene, mutated[gene.key] + (Math.random() * 2 - 1) * span);
    }
    return mutated;
}

// ---------------------------------------------------------------------------------------------
// The fitness
// ---------------------------------------------------------------------------------------------

/** Hermite step: 0 below a, 1 above b, smooth in between. */
function smoothstep(a, b, x) {
    const t = clamp01((x - a) / (b - a || 1e-6));
    return t * t * (3 - 2 * t);
}

/** Detections the analysis would keep: policy-accepted, and outside the mask. */
function acceptedSources(sources, opts, mask, W, H) {
    // The mask is stored at its own resolution, so detections are scaled into it - the same
    // mapping the analysis uses. Without the mask the search optimises for the TREES: on the
    // reference clip the foliage and vignette edge outnumbered the sky ten to one.
    const msx = mask ? mask.maskCanvas.width / W : 1;
    const msy = mask ? mask.maskCanvas.height / H : 1;
    const kept = [];
    for (const s of sources) {
        if (rejectReason(s, opts)) continue;
        if (mask && mask.isPointMasked(s.x * msx, s.y * msy)) continue;
        kept.push(s);
    }
    return kept;
}

const median = (values) => {
    if (!values.length) return null;
    const a = [...values].sort((x, y) => x - y);
    return a[a.length >> 1];
};

/** Fraction of sampled pixels crushed to black / blown to white. Every 4th pixel each way. */
function clipFractions(data, W, H) {
    let black = 0, white = 0, n = 0;
    for (let y = 0; y < H; y += 4) {
        for (let x = 0; x < W; x += 4) {
            const p = (y * W + x) * 4;
            const r = data[p], g = data[p + 1], b = data[p + 2];
            if (0.299 * r + 0.587 * g + 0.114 * b <= 1) black++;
            if (r >= 254 || g >= 254 || b >= 254) white++;
            n++;
        }
    }
    return n ? {black: black / n, white: white / n} : {black: 0, white: 0};
}

/**
 * The fixed yardstick, built ONCE per run from the frame with the six genes neutral.
 *
 * Z0 is the matched-filtered significance of the untouched frame: (smoothed - background) / sigma,
 * in units of the reference's own noise. It measures what is STATISTICALLY there, not what is
 * visible - a star too faint to see on screen still carries evidence here, which is exactly the
 * discrimination the search needs, while noise sits near 1-2 and earns nothing.
 *
 * Built from the NEUTRAL genome rather than the user's current settings: if their starting point is
 * already crushed, a reference inherited from it would bless the crushing.
 */
function buildReference(px, opts, mask) {
    const {data, W, H} = px;
    const L = lumaFromRGBA(data, W, H);
    const model = estimateBackground(L, W, H, opts);
    const smoothSigma = opts.detectSmoothSigma ?? STAR_DETECT_DEFAULTS.detectSmoothSigma;
    const D = smoothSigma > 0 ? gaussianBlur(L, W, H, smoothSigma) : L;

    const Z = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = y * W + x;
            const b = backgroundAt(model, model.bg, x, y);
            const s = backgroundAt(model, model.sigma, x, y);
            Z[i] = (D[i] - b) / Math.max(0.5, s);
        }
    }

    // The reference PSF width, from the untouched frame's own accepted detections. This is what
    // stops Blur from broadening everything and calling the result perfectly star-shaped: the
    // candidate cannot move this number. Refused when too few detections measured it, rather than
    // inventing a scale from two blobs.
    const {sources} = detectSources(data, W, H, opts);
    const accepted = acceptedSources(sources, opts, mask, W, H);
    const extents = accepted.map((s) => Math.max(s.width, s.height)).filter(Number.isFinite);
    const psf = extents.length >= 5 ? median(extents) : null;

    return {Z, W, H, psf, clip: clipFractions(data, W, H), model, peaks: accepted.length,
        // How deep this field can carry, filled in once the baseline identification is known. The
        // floor is the quad budget and the ceiling keeps one enormous frame from flattening the
        // score into a rounding error.
        K: Math.max(STAR_IDENTIFY_DEFAULTS.imageQuadStars, accepted.length),
        matchRadius: Math.max(2, Math.min(4, Math.round(0.5 * (psf ?? 4))))};
}

/** The reference's best significance within matchRadius of a candidate detection. */
function referenceEvidence(ref, x, y) {
    const r = ref.matchRadius;
    const x0 = Math.max(0, Math.round(x) - r), x1 = Math.min(ref.W - 1, Math.round(x) + r);
    const y0 = Math.max(0, Math.round(y) - r), y1 = Math.min(ref.H - 1, Math.round(y) + r);
    let best = -Infinity;
    for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
            const v = ref.Z[yy * ref.W + xx];
            if (v > best) best = v;
        }
    }
    return best === -Infinity ? 0 : best;
}

/**
 * How much of the reference's noise floor this candidate has collapsed, 0..1.
 *
 * The exploit made visible and priced. Comparing the candidate's per-tile sigma against the
 * reference's catches black-crushing at its source, and costs nothing: detectSources already
 * measured and returned the candidate's background model.
 */
function sigmaCollapse(candidateModel, ref) {
    const a = candidateModel.sigma, b = ref.model.sigma;
    if (!a || !b || a.length !== b.length) return 0;
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        const ratio = a[i] / Math.max(0.5, b[i]);
        const t = clamp01((0.30 - ratio) / 0.20);
        sum += t * t;
    }
    return sum / a.length;
}

/**
 * How good a star field this frame yields, as one number.
 *
 * Three factors, each answering a question the previous fitness could not:
 *
 *   A - ANCHOR quality, over the 25 detections the identifier will actually build its quads from.
 *       Not the best 25 by this score's own reckoning: the identifier gates on isolation and shape
 *       and then ranks by BRIGHTNESS, and picking a different 25 grades a set nobody will use.
 *       Measured on the reference frame, the two sets overlapped by only 14 of 25 - and the old
 *       score's 25 omitted the brightest star in the image (SNR 81) while its median anchor was
 *       SNR 23 against the identifier's 34. It preferred small round average blobs because its
 *       size terms penalise a bright star for being big.
 *   D - DEPTH. The same credit over the best K detections, where K follows how deep the field
 *       actually is. Twenty-five is only the QUAD budget: the identifier verifies and rematches the
 *       whole star set against a deeper catalog pool, so a 26th or 80th real star still raises the
 *       true objective. Capping at 25 made a frame with 80 identifiable stars score no better than
 *       one with 25.
 *   J - the cost of junk. Only UNSUPPORTED detections are charged for. The purity term this
 *       replaces divided by every detection, so a real star with weak reference evidence LOWERED
 *       the score - it taxed exactly the depth D exists to reward.
 *   T - tonal integrity. Clipping and noise-floor collapse relative to the reference, the specific
 *       damage the search was previously rewarded for doing.
 *
 * The gates and constants are READ from the identifier's own policy rather than chosen here, so the
 * fitness keeps describing what the consumer will do with these detections if that policy changes.
 */
function scoreStarField(px, opts, mask, ref) {
    const {sources, background: model} = detectSources(px.data, px.W, px.H, opts);
    const accepted = acceptedSources(sources, opts, mask, px.W, px.H);
    const n = accepted.length;

    const nAnchor = STAR_IDENTIFY_DEFAULTS.imageQuadStars;
    const extents = accepted.map((s) => Math.max(s.width, s.height));
    const extentMedian = median(extents) ?? 1;

    // Per-detection credit: how much the fixed reference says is really there, times how much the
    // blob looks like the reference's own stars. Roundness and relative size are NOT factors here -
    // they are hard gates below, exactly as the identifier applies them.
    const credit = new Array(n);
    let unsupported = 0;
    for (let i = 0; i < n; i++) {
        const s = accepted[i];
        const evidence = smoothstep(2, 5, referenceEvidence(ref, s.x, s.y));
        // Absolute PSF scale, soft: a factor of two either way still keeps ~61%. Skipped when the
        // reference had too few detections to measure a width worth trusting.
        const absSize = ref.psf
            ? Math.exp(-0.5 * (Math.log(extents[i] / ref.psf) / Math.LN2) ** 2)
            : 1;
        // Only a quarter penalty: the detector deliberately KEEPS round saturated stars, which are
        // the most recognisable anchors in the frame. Wiping them out would fight it.
        const unsaturated = 1 - 0.25 * clamp01(s.saturatedFrac ?? 0);
        credit[i] = evidence * Math.sqrt(absSize) * unsaturated;
        unsupported += 1 - evidence;
    }

    // The identifier's anchor selection, reproduced: isolation, then shape, then brightness order.
    // (StarIdentify.js - clutterR2/clutterMax, pointLike, rankOf by -snr, slice to imageQuadStars.)
    const clutterR2 = (0.04 * px.W) ** 2;
    const neighbours = accepted.map((s) => {
        let c = 0;
        for (const t of accepted) {
            if (t === s) continue;
            if ((t.x - s.x) ** 2 + (t.y - s.y) ** 2 < clutterR2) c++;
        }
        return c;
    });
    const clutterMax = Math.max(4, 4 * (median(neighbours) ?? 0));
    const anchorIdx = [];
    for (let i = 0; i < n; i++) {
        if (neighbours[i] > clutterMax) continue;
        if (extents[i] > STAR_IDENTIFY_DEFAULTS.quadMaxExtentMedians * extentMedian) continue;
        if (accepted[i].elongation > STAR_IDENTIFY_DEFAULTS.quadMaxElongation) continue;
        anchorIdx.push(i);
    }
    anchorIdx.sort((a, b) => accepted[b].peakSNR - accepted[a].peakSNR);
    let anchorSum = 0;
    for (let k = 0; k < Math.min(nAnchor, anchorIdx.length); k++) anchorSum += credit[anchorIdx[k]];
    const A = anchorSum / nAnchor;

    // Depth, over however many stars this field can actually carry.
    const K = ref.K;
    const bestCredit = [...credit].sort((a, b) => b - a);
    let depthSum = 0;
    for (let k = 0; k < Math.min(K, bestCredit.length); k++) depthSum += bestCredit[k];
    const D = depthSum / K;

    const J = Math.exp(-unsupported / K);

    const clip = clipFractions(px.data, px.W, px.H);
    const blackExcess = Math.max(0, clip.black - ref.clip.black - 0.005);
    const whiteExcess = Math.max(0, clip.white - ref.clip.white - 0.002);
    const collapse = sigmaCollapse(model, ref);
    const T = Math.exp(-6 * blackExcess - 8 * whiteExcess - 2 * collapse);

    const score = 100 * T * (0.5 * A + 0.5 * D) * J;
    return {score, kept: n, detected: sources.length, A, D, J, T, K,
        anchors: Math.min(nAnchor, anchorIdx.length), unsupported: +unsupported.toFixed(1),
        blackExcess, whiteExcess, collapse};
}

// ---------------------------------------------------------------------------------------------
// Stage two: the detection tweaks, scored on identification
// ---------------------------------------------------------------------------------------------
//
// Why this is a separate stage rather than six more genes in the search above:
//
// The fast score measures each detection's significance in units of the detection THRESHOLD, so
// making that threshold a gene would let the search lower its own yardstick - a lower threshold
// admits more blobs and inflates every blob's credit at the same time, and the search would drive
// it to the floor and call that an improvement.
//
// So the threshold is searched against the only thing it cannot game: how many stars the catalog
// actually identifies. That costs seconds per candidate instead of milliseconds, which is why it is
// a short sweep of a handful of values rather than a population search - and why it runs second, on
// a frame the first stage has already made as legible as it can.

// Ordered outward from the detector's default, so the sweep spends its early (and most likely to be
// kept) evaluations near settings known to be sane, and reaches the extremes only if it survives
// that long.
//
// Every value is one the Detect threshold SLIDER can represent (2-10). It is tempting to go higher,
// because a high threshold is what cuts clutter - an early test found 12 rescued an identification
// that failed at 5 - and setStarTrackerTweaks writes the parameter directly, so nothing stops it.
// But the slider would then sit at 10 displaying a value that is really 12, and a setting the user
// cannot see, reproduce or drag back is worse than a slightly blunter sweep.
const THRESH_SWEEP = [5, 7, 9, 6, 4, 8, 10, 3, 5.5, 2.5];
const MIN_AREA_SWEEP = [2, 3, 4, 6];

/**
 * Sweep the detection threshold, then the blob-size floor, scoring each on catalog identification.
 *
 * A coordinate sweep, not a population: with an evaluation this expensive, ten honest measurements
 * of the parameter that decides everything beat a hundred guesses spread across two.
 */
async function runTweakSweep(onProgress, seed = null) {
    const original = getStarTrackerTweaks();
    // The chosen candidate has ALREADY been measured at the user's own threshold, during the
    // rerank. Seeding that result means the sweep can return "your threshold was best" - without
    // it, a starting value the sweep does not happen to list (it moves in quarter steps) could
    // never win, and a run that had genuinely improved things could be vetoed for want of it.
    // Only the two searched values travel through the sweep. The provenance flag deliberately does
    // NOT: a value this sweep chose is a measurement and should be marked as one, while the user's
    // original flag is restored only by the paths that restore their original value.
    const base = {threshSigma: original.threshSigma, minArea: original.minArea};
    let best = seed ? {tweaks: {...base}, result: seed} : null;

    const evaluate = async (tweaks, label) => {
        if (aborted || stopEarly) return null;
        setStarTrackerTweaks(tweaks);
        const result = await scoreStarTrackerIdentification();
        onProgress(label, result);
        if (!best || result.score > best.result.score) best = {tweaks: {...tweaks}, result};
        return result;
    };

    // With "Auto detect threshold" on, the next Full Analysis measures its own threshold before it
    // runs, so anything found here would be discarded on the way to being used. Sweeping it would
    // spend ten evaluations to report a number that is not going to survive.
    const sweepThreshold = !starTrackerAutoSigma();
    for (const threshSigma of sweepThreshold ? THRESH_SWEEP : []) {
        if (aborted || stopEarly) break;
        if (seed && threshSigma === base.threshSigma) continue;
        await evaluate({...base, threshSigma}, `threshold ${threshSigma}`);
    }
    // The blob floor is only worth sweeping around the threshold that won - the two interact, and
    // pairing every area with every threshold is the cost of the whole feature over again.
    const winner = best ? best.tweaks : base;
    for (const minArea of MIN_AREA_SWEEP) {
        if (aborted || stopEarly) break;
        if (minArea === winner.minArea) continue;
        await evaluate({...winner, minArea}, `min area ${minArea}`);
    }

    // A sweep that identified nothing anywhere says nothing about which settings are better, so it
    // leaves the user's own alone rather than picking a winner out of a row of zeros.
    const finalTweaks = best && best.result.matched > 0 && !aborted ? best.tweaks : original;
    setStarTrackerTweaks(finalTweaks);
    return {original, best, finalTweaks};
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

let running = false;
let aborted = false;
let stopEarly = false;
let statusText = {value: "Ready"};
// One entry per menu the controls were added to. The same optimization is reachable from Video
// Adjustments (beside the sliders it searches) and from the Star Tracker folder (beside the
// analysis it serves), and whichever one you started it from, BOTH have to swap to Enough/Abort -
// a run you cannot stop from the menu you are looking at is worse than not offering it there.
const controlSets = [];

function setStatus(text) {
    statusText.value = text;
    for (const set of controlSets) {
        set.status?.show(true);
        set.status?.updateDisplay();
    }
}

function showRunningButtons(show) {
    for (const set of controlSets) {
        set.optimize?.show(!show);
        set.enough?.show(show);
        set.abort?.show(show);
    }
}

/** The video node whose adjustments these are, and the frame on screen right now. */
function currentTarget() {
    const view = NodeMan.exists("video") ? NodeMan.get("video") : null;
    if (!view || !view.videoData) return {error: "no video loaded"};
    if (view.in.enableVideoEffects && !view.in.enableVideoEffects.v0) {
        return {error: "turn on Enable Video Effects first"};
    }
    // Refused up front rather than warned about afterwards: with this off the Star Tracker measures
    // the raw decode, so every setting this searches for would be tuned for a picture the analysis
    // is never going to look at.
    if (!starTrackerAppliesAdjustments()) {
        return {error: "turn on Star Tracker > Apply adjustments first"};
    }
    const globalFrame = Math.floor(par.frame);
    const frame = view.lockToInFrame ? Math.max(0, globalFrame - (Sit.aFrame ?? 0)) : globalFrame;
    const image = view.videoData.getImage(frame);
    if (!image || !image.width) return {error: "current frame is not decoded yet"};
    return {view, frame, image};
}

/**
 * The result, as a one-line headline for the menu and a full report for the console.
 *
 * The headline carries the STARTING score as well as the final one, because "score 95.2" alone
 * says nothing about whether the search achieved anything - the settings on screen when the button
 * was pressed are the only baseline the number means anything against.
 */
function buildReport(original, best, stats, baseline, kept) {
    const changes = [];
    for (const gene of GENES) {
        const from = original[gene.key];
        const to = best[gene.key];
        if (Math.abs(from - to) > gene.step / 2) {
            changes.push(`${gene.label}: ${from.toFixed(gene.dp)} → ${to.toFixed(gene.dp)}`);
        }
    }
    const was = baseline && baseline.score > -Infinity
        ? `, was ${baseline.score.toFixed(1)} (${baseline.kept})` : "";
    const score = `score ${stats.score.toFixed(1)} (${stats.kept} stars)${was}`;
    // An abort restores the original, which leaves nothing to list - but "already optimal" would
    // be a lie about a search that was stopped rather than finished.
    if (!kept) {
        return {headline: "Aborted - settings restored", detail: "Aborted. Settings restored."};
    }
    if (!changes.length) {
        return {headline: `Already optimal - ${score}`, detail: `No change. ${score}`};
    }
    return {
        headline: `${kept ? "Applied" : "Restored"} - ${score}`,
        detail: (kept ? "Applied:\n" : "Restored:\n") + changes.join("\n") + `\n\n${score}`,
    };
}

/**
 * One generation: evaluate, rank, breed. Returns false when the search has converged.
 *
 * Evaluation is memoised on the quantised genome, which matters more here than it would in a
 * general GA - the elites are carried forward unchanged every generation, and detection on a
 * megapixel frame is far too expensive to repeat for an answer already known.
 */
async function runGeneration(state) {
    for (const member of state.population) {
        if (aborted || stopEarly) return false;
        const key = genomeKey(member.genome);
        const cached = state.cache.get(key);
        if (cached !== undefined) {
            member.result = cached.result;
            continue;
        }
        applyGenome(member.genome);
        // Read back through the video view, so this measures the same adjusted pixels the Star
        // Tracker will measure - and so the user watches the frame being searched.
        const px = state.view.getFramePixels(state.image, state.frame, true);
        member.result = px ? scoreStarField(px, state.opts, state.mask, state.ref)
            : {score: 0, kept: 0, detected: 0};
        // The genome is kept alongside its score, not just the score: stage two reranks the best
        // few candidates against catalog identification, and it needs the settings to re-apply.
        state.cache.set(key, {genome: {...member.genome}, result: member.result});
        setRenderOne(true);
        // Yield so the frame paints and the Enough / Abort buttons stay clickable.
        await new Promise((r) => setTimeout(r, 0));
    }

    state.population.sort((a, b) => b.result.score - a.result.score);
    const best = state.population[0];
    if (best.result.score > state.bestResult.score) {
        state.bestResult = best.result;
        state.bestGenome = {...best.genome};
        state.noImprove = 0;
    } else {
        state.noImprove++;
    }

    setStatus(`Gen ${state.generation}: score ${state.bestResult.score.toFixed(1)}`
        + ` (${state.bestResult.kept} stars)`);

    state.generation++;
    if (state.noImprove >= MAX_NO_IMPROVE) return false;
    if (state.generation >= MAX_GENERATIONS) return false;

    const next = state.population.slice(0, ELITE_COUNT);
    while (next.length < POPULATION_SIZE) {
        const a = state.population[Math.floor(Math.random() * ELITE_COUNT)].genome;
        const b = state.population[Math.floor(Math.random() * state.population.length)].genome;
        let child = crossover(a, b);
        if (Math.random() < MUTATION_CHANCE) child = mutate(child);
        next.push({genome: child, result: null});
    }
    state.population = next;
    return true;
}

async function runOptimization() {
    if (running) return;
    const target = currentTarget();
    if (target.error) { setStatus(target.error); return; }
    if (!geneNodes()) { setStatus("video adjustments are not available"); return; }

    running = true;
    aborted = false;
    stopEarly = false;
    showRunningButtons(true);
    setStatus("Optimizing...");

    const original = readGenome();
    // Captured here, not in the sweep: Abort promises the settings the user STARTED with, and by
    // the time the sweep runs it has already moved them itself.
    const originalTweaks = getStarTrackerTweaks();
    // This button changes SETTINGS. Stage two's scoring runs each publish an analysis of their own,
    // which would otherwise demote a completed whole-clip analysis to whichever one-frame candidate
    // happened to be measured last - so the user's analysis is put back on every exit path, and
    // whether they then re-run it with the new settings is their decision, not this button's.
    const originalResult = captureStarTrackerResult();
    const {view, frame, image} = target;
    const opts = starTrackerDetectOptions(image.width, image.height);
    // Resolved ONCE for the run, as the analysis resolves it: a mask is a user artefact that should
    // not change mid-search, and re-reading its pixels per candidate would cost a full getImageData
    // on every one.
    const mask = starTrackerVideoMask();

    // The yardstick, measured before any candidate exists. Everything the search is allowed to
    // believe about whether a detection is real comes from here.
    setStatus("Measuring the untouched frame...");
    applyGenome(neutralGenome());
    const refPx = view.getFramePixels(image, frame, true);
    if (!refPx) {
        applyGenome(original, true);
        setStatus("could not read the frame");
        running = false;
        showRunningButtons(false);
        return;
    }
    const ref = buildReference(refPx, opts, mask);

    // What the settings you ARRIVED with identify. Measured FIRST, before any searching, for two
    // reasons: it is the number the whole run has to beat, and it sets how deep this field can go.
    // A frame whose own settings identify 80 stars is a frame where the eightieth star still
    // matters, and a score that stopped counting at 25 could not see that.
    setStatus("Measuring your current settings...");
    applyGenome(original);
    setStarTrackerTweaks(originalTweaks);
    let reference = null;
    try {
        reference = await scoreStarTrackerIdentification();
    } catch (e) {
        console.warn("[StarTrack] baseline identification failed", e);
    }
    if (reference?.matched) {
        ref.K = Math.min(100, Math.max(ref.K, reference.matched));
    }
    setStatus(`Your settings identify ${reference?.matched ?? 0} - searching...`);

    // Generation zero holds the two genomes worth knowing about before any search: what the user
    // has set now, and no adjustment at all. Seeding the current settings is what makes the button
    // safe to press - the search can return "you were already right", and can never do worse.
    const state = {
        view, frame, image, opts, mask, ref,
        cache: new Map(),
        generation: 0,
        noImprove: 0,
        bestResult: {score: -Infinity, kept: 0, detected: 0},
        bestGenome: {...original},
        population: [
            {genome: {...original}, result: null},
            {genome: neutralGenome(), result: null},
        ],
    };
    while (state.population.length < POPULATION_SIZE) {
        state.population.push({genome: randomGenome(), result: null});
    }

    try {
        while (await runGeneration(state)) { /* until converged, Enough, or Abort */ }
    } catch (e) {
        console.warn("[StarTrack] adjustment optimization failed", e);
        applyGenome(original, true);
        setStatus(`failed: ${e?.message ?? e}`);
        running = false;
        showRunningButtons(false);
        return;
    }

    const keep = !aborted;
    // Applied but NOT committed: stage two may prefer a different candidate, and committing here
    // would mark the sitch dirty for settings that are about to be replaced or rejected outright.
    const finalGenome = keep && state.bestResult.score > -Infinity ? state.bestGenome : original;
    applyGenome(finalGenome);

    // The starting settings were generation zero's first individual, so their score is already in
    // the cache - no extra evaluation to say what the search was measured against.
    const baseline = state.cache.get(genomeKey(original))?.result;

    // Stage two. Skipped only on Abort, which has already thrown the answer away.
    //
    // "Enough" does NOT skip it. Enough means "stop searching and keep the best so far", and the
    // only thing that can say whether the best so far is worth keeping is the identification check
    // below - so Enough shortens stage two (the loops below all test it) rather than bypassing the
    // verdict. Skipping it entirely would let Enough apply a candidate that a completed run would
    // have rejected, which is the opposite of what a user pressing Accept is asking for.
    let tweaks = null;
    let stageTwoFailed = false;
    let chosenGenome = finalGenome;
    if (keep) {
        // Enough stops the SEARCH, and stage two is not the search - it is the verification that
        // decides whether the search found anything worth keeping. So the flag is cleared on the
        // way in: an Enough pressed during stage one has done its job, while a SECOND press, now,
        // shortens the verification and keeps the best verdict reached so far. Without this,
        // pressing Accept guaranteed a rejection, because every stage-two loop would exit before
        // measuring a single candidate.
        stopEarly = false;
        try {
            // The baseline was measured before the search - it set K as well as the bar to beat.

            // Rerank stage one's best few against identification before committing to any of them.
            // Even with a trustworthy fast score, the fast score measures a PICTURE and this
            // measures the answer; where they disagree, this one is right.
            const ranked = rerankPool([...state.cache.values()], genomeKey(original));
            let bestIdent = null;
            for (let i = 0; i < ranked.length; i++) {
                if (aborted || stopEarly) break;
                setStatus(`Checking candidate ${i + 1} of ${ranked.length}...`);
                applyGenome(ranked[i].genome);
                const ident = await scoreStarTrackerIdentification();
                setStatus(`Candidate ${i + 1}: ${ident.matched} identified`);
                // ident.score is matched count minus a small rms term, so an equal number of stars
                // is broken in favour of the tighter fit - which is what asking for that score was
                // for. Comparing bare counts threw it away.
                if (!bestIdent || ident.score > bestIdent.ident.score) {
                    bestIdent = {genome: ranked[i].genome, ident};
                }
            }
            if (bestIdent) chosenGenome = bestIdent.genome;
            applyGenome(chosenGenome);

            tweaks = await runTweakSweep((label, r) => {
                setStatus(`Tuning detection: ${label} - ${r.matched} identified`);
            }, bestIdent?.ident ?? null);
        } catch (e) {
            // Stage two IS the safety boundary. If it could not run, nothing has been checked
            // against the catalog, and applying stage one's unverified winner is precisely the
            // failure this stage exists to prevent - so a failure here restores rather than
            // commits.
            console.warn("[StarTrack] identification check failed", e);
            stageTwoFailed = true;
        }
    }

    if (stageTwoFailed) {
        applyGenome(original, true);
        setStarTrackerTweaks(originalTweaks);
        restoreStarTrackerResult(originalResult);
        setStatus("Could not check against the catalog - settings restored");
        running = false;
        showRunningButtons(false);
        setRenderOne(true);
        return;
    }

    // Abort means the settings you started with, whichever stage it lands in - so an abort during
    // the sweep also gives back the adjustments stage one had already committed. Anything less
    // makes the button's promise conditional on timing the click right. Tested before the veto
    // below: an interrupted sweep has no verdict to give, and must not be read as one.
    if (aborted) {
        applyGenome(original, true);
        setStarTrackerTweaks(originalTweaks);
        restoreStarTrackerResult(originalResult);
        setStatus("Aborted - settings restored");
        console.log("[StarTrack] Optimize For Star Tracking: aborted, settings restored");
        running = false;
        showRunningButtons(false);
        setRenderOne(true);
        return;
    }

    // The veto: when the tuned picture cannot beat the settings the user arrived with at the only
    // thing that matters downstream, theirs win and nothing changes. Ties go to the user - an equal
    // result is not worth moving six sliders for.
    //
    // This applies after Enough too. Enough asks to stop searching, not to accept something that
    // has been shown not to work.
    const vetoed = reference && tweaks
        && !(tweaks.best && tweaks.best.result.matched > reference.matched);
    if (vetoed) {
        applyGenome(original, true);
        setStarTrackerTweaks(originalTweaks);
        restoreStarTrackerResult(originalResult);
        const best = tweaks.best?.result.matched ?? 0;
        setStatus(`Kept your settings - tuned picture identified ${best}, yours ${reference.matched}`);
        console.log("[StarTrack] Optimize For Star Tracking: no improvement in identification "
            + `(tuned ${best} stars vs your ${reference.matched}) - settings left unchanged.`);
        running = false;
        showRunningButtons(false);
        setRenderOne(true);
        return;
    }

    // Committed only now, once it has survived both the rerank and the veto - and it is the genome
    // stage two CHOSE, which is not always the one stage one ranked first.
    applyGenome(chosenGenome, true);
    const chosenStats = state.cache.get(genomeKey(chosenGenome))?.result ?? state.bestResult;
    const report = buildReport(original, chosenGenome, keep ? chosenStats : (baseline ?? chosenStats),
        baseline, keep);
    setStatus(report.headline);

    // The analysis left on screen must describe the settings now in force. Since this path APPLIED
    // new ones, the winning candidate's own analysis is what belongs there - names on the stars,
    // circles where they were found - rather than an older one measured through settings nobody has
    // any more. The abort and veto paths above restore instead, for the same reason read the other
    // way round: they changed nothing, so the previous analysis is still the true one.
    //
    // The cost is honest and worth stating: on a video, this leaves a SINGLE-FRAME analysis where a
    // whole-clip one may have been. Run Full Analysis to get the clip back - and it will now
    // reproduce these numbers, because the settings it uses are the ones just verified.
    await showWinningAnalysis();

    let tweakLine = "";
    if (tweaks) {
        const {original: t0, best, finalTweaks} = tweaks;
        const changed = finalTweaks.threshSigma !== t0.threshSigma || finalTweaks.minArea !== t0.minArea;
        const was = reference ? `, was ${reference.matched}` : "";
        tweakLine = best
            ? `\n\nDetection: threshold ${finalTweaks.threshSigma}, min area ${finalTweaks.minArea}`
                + ` - ${best.result.matched} stars identified${was}` + (changed ? "" : " (unchanged)")
            : "\n\nDetection: not tuned";
        if (best) setStatus(`${report.headline} | ${best.result.matched} identified${was}`);
    }

    const warning = keep && !starTrackerAppliesAdjustments()
        ? "\n\nNote: Star Tracker's \"Apply adjustments\" is off, so the analysis will ignore these."
        : "";
    console.log("[StarTrack] Optimize For Star Tracking:\n" + report.detail + tweakLine + warning);

    running = false;
    showRunningButtons(false);
    setRenderOne(true);
}

/**
 * Re-run the chosen settings so their own analysis, with its stars named, is what stays on screen.
 *
 * The sweep leaves whichever candidate it measured LAST in place, and that is almost never the
 * winner - so without this the overlay quietly describes settings nobody has. One more
 * identification is a fair price for the run ending with the names visible instead of the user
 * having to press Full Analysis to find out what was found.
 *
 * Deliberately still a scoring run: it names the stars but does not re-point a camera the user
 * synced from a whole clip.
 */
async function showWinningAnalysis() {
    setStatus("Identifying stars for the chosen settings...");
    try {
        await scoreStarTrackerIdentification();
    } catch (e) {
        // The settings are already applied and reported; failing to draw them is not worth
        // losing the answer over.
        console.warn("[StarTrack] could not display the chosen settings' analysis", e);
    }
}

function acceptNow() {
    if (!running) return;
    stopEarly = true;
}

function abortNow() {
    if (!running) return;
    aborted = true;
}

// ---------------------------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------------------------

/**
 * Measure the fast score against the truth it is a proxy for, and report the correlation.
 *
 * The fitness above is an argument about what makes a good star field. This is the experiment that
 * says whether the argument is right: every genome the search evaluated, scored BOTH ways - the
 * cheap picture score and the actual number of stars the catalog identifies - so the two can be
 * ranked against each other.
 *
 * The number that matters is the separation: no candidate that identifies nothing may outscore one
 * that identifies well. A proxy that gets that wrong is not a slightly worse proxy, it is a
 * generator of confidently bad settings, which is exactly what the first version was.
 *
 * Not wired to a button - it costs an identification per candidate. On a local build, call it from
 * the console:
 *     window.__starOptimizeCalibrate(12)
 */
export async function calibrateFitness(limit = 12) {
    const target = currentTarget();
    if (target.error) { console.warn("[StarTrack] calibrate:", target.error); return null; }
    const {view, frame, image} = target;
    const opts = starTrackerDetectOptions(image.width, image.height);
    const mask = starTrackerVideoMask();
    const original = readGenome();
    const originalResult = captureStarTrackerResult();

    applyGenome(neutralGenome());
    const refPx = view.getFramePixels(image, frame, true);
    const ref = buildReference(refPx, opts, mask);

    // A spread of genomes rather than a search: the point is to cover the space the search moves
    // through, INCLUDING the crushed corner that used to win, not to find the best one.
    const genomes = [{...original}, neutralGenome()];
    while (genomes.length < limit) genomes.push(randomGenome());

    const rows = [];
    for (let i = 0; i < genomes.length; i++) {
        applyGenome(genomes[i]);
        const px = view.getFramePixels(image, frame, true);
        const fast = scoreStarField(px, opts, mask, ref);
        const ident = await scoreStarTrackerIdentification();
        rows.push({i, genome: genomes[i], ...fast, matched: ident.matched});
        console.log(`[StarTrack] calibrate ${i + 1}/${genomes.length}: `
            + `score ${fast.score.toFixed(1)} (A ${fast.A.toFixed(3)} D ${fast.D.toFixed(3)} `
            + `J ${fast.J.toFixed(3)} T ${fast.T.toFixed(3)} K ${fast.K} kept ${fast.kept}) `
            + `-> ${ident.matched} identified`);
    }

    applyGenome(original, true);
    restoreStarTrackerResult(originalResult);

    // Spearman: rank correlation, because the fitness only ever has to ORDER candidates correctly.
    // Its absolute scale is meaningless and fitting a line to it would measure nothing.
    const rank = (values) => {
        const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
        const r = new Array(values.length);
        order.forEach(([, i], k) => { r[i] = k; });
        return r;
    };
    const rs = rank(rows.map((r) => r.score));
    const rm = rank(rows.map((r) => r.matched));
    const n = rows.length;
    let d2 = 0;
    for (let i = 0; i < n; i++) d2 += (rs[i] - rm[i]) ** 2;
    const spearman = n > 1 ? 1 - (6 * d2) / (n * (n * n - 1)) : 0;

    const dead = rows.filter((r) => r.matched === 0);
    const alive = rows.filter((r) => r.matched > 0);
    const worstAlive = alive.length ? Math.min(...alive.map((r) => r.score)) : Infinity;
    const bestDead = dead.length ? Math.max(...dead.map((r) => r.score)) : -Infinity;
    const separated = bestDead < worstAlive;

    console.log(`[StarTrack] calibrate: spearman ${spearman.toFixed(3)}, `
        + `${alive.length} identified / ${dead.length} dead, `
        + `best dead ${bestDead === -Infinity ? "-" : bestDead.toFixed(1)} vs `
        + `worst alive ${worstAlive === Infinity ? "-" : worstAlive.toFixed(1)} - `
        + (separated ? "SEPARATED" : "OVERLAP (fitness still misleads)"));
    return {rows, spearman, separated, bestDead, worstAlive};
}

// ---------------------------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------------------------

const addedFolders = new Set();

/**
 * Add the optimizer's controls to a menu.
 *
 * Called for the Video Adjustments folder (from addFiltersToVideoNode, which runs once per video
 * node while the folder itself is shared - hence the guard) and for the Star Tracker folder, which
 * rebuilds with the menu bar and so may legitimately register a NEW folder object later. The guard
 * is therefore per folder, not a single flag.
 *
 * The status row starts hidden: these folders are used by everyone, and a permanent readout is
 * noise until somebody presses the button.
 */
export function addStarOptimizeControls(folder, name = "Optimize For Star Tracking") {
    if (!folder || addedFolders.has(folder)) return;
    addedFolders.add(folder);
    // A rebuilt menu leaves its old controls detached; keeping them would mean show()/status
    // updates writing to rows that are no longer on screen.
    for (let i = controlSets.length - 1; i >= 0; i--) {
        const el = controlSets[i].folder?.domElement;
        if (el && !el.isConnected) controlSets.splice(i, 1);
    }

    // The calibration hook is a development tool - it spends a catalog identification per candidate
    // to check that the fast score still ranks candidates the way identification does. Installed
    // HERE rather than at module scope because isLocal is resolved by checkLocal() during startup,
    // after this file is evaluated but long before any video menu is built: gating at module scope
    // would read `false` on every host, including this one.
    if (isLocal && typeof window !== "undefined") {
        window.__starOptimizeCalibrate = calibrateFitness;
    }

    const controls = {
        optimize: () => { runOptimization(); },
        enough: acceptNow,
        abort: abortNow,
    };

    const optimizeBtn = folder.add(controls, "optimize").name(name)
        .tooltip("Tune this frame for the Star Tracker, in two stages.\n\n"
            + "First a genetic search over Brightness, Contrast, Shadows, Highlights, Dehaze and "
            + "Blur. Each candidate is judged against a fixed measurement of the UNTOUCHED frame, "
            + "so it is scored on how much real evidence it brings out - not on how many blobs it "
            + "produces. It counts the best 25 detections (the catalog matcher's own budget), what "
            + "share of them the evidence supports, and how much tone it destroyed.\n\n"
            + "Then everything is re-judged on how many stars the CATALOG identifies: the best few "
            + "candidates are re-scored, the Star Tracker Tweaks (Detect threshold and Min blob "
            + "area) are swept for the winner, and if none of it beats the settings you already "
            + "had, they all go back. More detections is NOT better past the catalog's depth - the "
            + "extras are clutter that makes identification harder, and only this score sees it.\n\n"
            + "Your current settings are tried first, so it can answer \"already optimal\". "
            + "Enough stops searching but still checks the result; Abort puts everything back.");

    const enoughBtn = folder.add(controls, "enough").name("Enough (Accept)")
        .tooltip("Stop searching and keep the best settings found so far");
    enoughBtn.show(false);

    const abortBtn = folder.add(controls, "abort").name("Abort (Reset)")
        .tooltip("Stop searching and restore the settings you started with");
    abortBtn.show(false);

    const statusCtrl = folder.add(statusText, "value").name("Star Tracking").listen().disable();
    statusCtrl.show(false);

    controlSets.push({folder, optimize: optimizeBtn, enough: enoughBtn,
        abort: abortBtn, status: statusCtrl});
    // A set added while a run is in progress must join it mid-flight, or the new menu would offer
    // an Optimize button that starts a second run on top of the first.
    if (running) showRunningButtons(true);
}

// Handed to the Star Tracker menu so it can offer the same optimization without importing this
// module - see setStarOptimizeMenuBuilder for why the dependency only runs one way.
setStarOptimizeMenuBuilder(addStarOptimizeControls);
