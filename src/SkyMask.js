// Segment sky from ground in a single frame, from user-supplied seed points.
//
// WHY SEEDED, AND NOT AUTOMATIC. The standard automatic methods take "sky is the region connected
// to the top border of the frame" as their starting assumption. Measured on Sitrec footage, that
// assumption does not merely bend, it inverts: an image intensifier images a circular active area
// onto black, and that dead surround is the SMOOTHEST region in the frame - texture 0.00 against
// the sky's 0.63 - while occupying 76% of the top row. A top-seeded fill floods the surround, the
// circle's bright edge then seals the real sky off from the seed, and the star field is classified
// as ground. The failure is not an unusual scene; it is every vignetted optic - image intensifiers,
// telescopes, boresight cameras.
//
// A seed removes the guess. The point is inside the active area because the user put it there, so
// no vignette can hijack it, and the all-sky and all-ground cases need no special handling: the
// region simply grows to cover everything, or nothing.
//
// WHY THE CUE IS MEASURED AND NOT CHOSEN. Two Sitrec clips disagree about which feature separates
// sky from ground, and they disagree by more than a tuning margin:
//
//   twilight photo, sunlit foliage   texture p75 0.82 -> p90 13.55   (sixteenfold; brightness poor)
//   image intensifier, sea horizon   texture 0.63 vs 0.71  (nothing)   brightness 61.4 vs 30.3 (2x)
//
// Fixing on either cue therefore fails half the corpus. Given a sky sample and a ground sample, the
// separation can simply be measured per image and the better cue used - which is what a second seed
// buys, and why it is worth asking for.
//
// Point-source suppression is required whichever cue wins. A star is an outlier at the working
// scale, so it survives downsampling as a small bump and clears any threshold low enough to catch
// foliage; a median removes it while leaving scene structure intact. This is the step the daylight
// literature has no reason to include.

export const SKY_MASK_DEFAULTS = {
    // Everything is measured at a fixed working width, so SCENE-scale structure - a treeline, a
    // horizon - occupies the same number of working pixels whatever the sensor. Point sources are
    // the exception: a star's size is set by the optics, not by how much sky it covers, which is
    // why the median radius is a separate knob rather than folded into this.
    workWidth: 512,
    medianRadius: 1,
    // Closing radius for the ground region, in working pixels. Foliage edges form a lace rather
    // than a wall; without this the sky fill leaks through the gaps and leaves tree interiors
    // unmasked, which measured as 0.52 of the treeline masked instead of 0.96.
    closeRadius: 3,
    // How much a neighbouring cell may differ from the one already in the region and still join
    // it, in units of the sky sample's own spread. Scale-free by construction: a noisy clip earns
    // a wider gate. This is a LOCAL step limit, not a window about the seed - see growSkyFromSeeds.
    localTolerance: 4,
    // Absolute floor on that gate, as a fraction of the sky sample's own value. On a very clean
    // sample the measured spread can approach zero, which would otherwise admit nothing.
    minToleranceFrac: 0.06,
    // Ground blobs smaller than this many working cells are dropped - isolated speckle, not scene.
    minGroundCells: 16,
    // How far apart the two produced regions must be, in units of the SKY REGION's own spatial
    // spread, for the split to be believed. Below this the frame is declined rather than masked.
    requiredSeparation: 1.0,
    // A pixel with no signal at all - outside a vignetted optic's active circle. Both bars must be
    // met: a dim patch of sky is dark but still carries sensor noise, so flatness is what
    // separates "outside the instrument" from "a dark part of the picture".
    deadLuma: 8,
    deadTexture: 0.15,
    // Set internally on the one retry with the cue that was not chosen; also lets a caller pin
    // the cue. Its presence is what stops the retry recursing further.
    forceFeature: null,
    // The grown sky must reach at least this fraction of the live (non-dead) frame to be believed.
    // Below it the gate was too tight and nothing grew, which must read as a failure rather than
    // as "everything is ground".
    minSkyFraction: 0.02,

    // --- quadtree classifier -------------------------------------------------------------------
    // Smallest block that may be called sky, in working pixels. A block smaller than this only
    // became small because its surroundings needed splitting, which is the signature of detail
    // rather than of open sky - and it is how the smooth dark interior of a tree is rejected.
    minSkyLeaf: 16,
    // Largest block accepted without splitting. Without a ceiling a whole quadrant of a dim frame
    // can pass as uniform, taking the treeline with it.
    maxSkyLeaf: 32,
    // A block is uniform when its spread is within this multiple of the frame's own quiet level,
    // taken as the low quartile of the texture field. Read off the image because "how much does a
    // patch vary" has no absolute scale across sensors and exposures.
    splitToleranceFactor: 3,
    minSplitTolerance: 0.5,
    // How much of a block may be dead and still let it count as sky. Keeps blocks straddling a
    // vignette edge out, without rejecting a block clipped by the frame border.
    maxDeadFraction: 0.1,
    // Neighbour voting after classification. A block that disagrees with this fraction of its
    // live neighbours is flipped to match them; two passes let a correction spread one block
    // further without smearing the boundary away.
    adjacencyPasses: 2,
    // Deliberately unequal. Half the live neighbours being ground is enough to pull a block down;
    // promoting one back to sky takes 85%. Missing ground costs hundreds of foliage detections in
    // the solve, losing sky costs a few stars out of thousands.
    toGroundMajority: 0.5,
    toSkyMajority: 0.85,
    // Grow the finished ground by this many blocks. Boundary blocks are mixtures of both classes,
    // and a mixture should be excluded - so the edge is pushed into the sky rather than into the
    // trees, for the same asymmetry.
    groundGrowCells: 1,
    // A seed window this many working pixels across is sampled to characterise each class.
    seedRadius: 6,
};

/**
 * Classify sky by QUADTREE, with no connectivity anywhere in it.
 *
 * Every failure the seeded region-growing route produced was a connectivity failure rather than a
 * classification one: a fill seeded in a vignette's dead surround inverted sky and ground; a fill
 * that could not cross a brightness ramp abandoned a good sky's darker corner; a gate tight enough
 * to seal foliage sealed everything; and a lace of leaf edges let the fill leak into tree
 * interiors. Judging each leaf on its own pixels removes all four at once - nothing has to reach
 * anything.
 *
 * It also suits what the mask is FOR. The mask does not have to be exact; it has to leave enough
 * clean sky to detect stars in, and keep foliage out. Those costs are wildly asymmetric - throwing
 * away good sky costs a few stars out of thousands, keeping a treetop costs false detections that
 * corrupt the solve - so the classifier is free to reject anything it is unsure of. Region growing
 * could not be that liberal, because over-rejecting there severs the sky and cascades.
 *
 * THE HEURISTIC: sky is whatever a LARGE uniform block can describe. A cell is subdivided while it
 * is heterogeneous and still big enough to split; foliage therefore forces subdivision down to the
 * limit while open sky stops early. A leaf's size is then a measure of how busy its neighbourhood
 * was, which is what tells a smooth patch of sky from the smooth dark interior of a tree - the
 * interior only exists as a leaf because everything around it had to be split apart. No fill can
 * make that distinction, because the interior is genuinely smooth and genuinely enclosed.
 *
 * @param {Float32Array} smooth - luma, point sources already suppressed
 * @param {Float32Array} texture - local texture of that image
 * @param {Uint8Array} dead - 1 where the pixel carries no signal at all
 * @param {number} W
 * @param {number} H
 * @param {object} O - resolved options
 * @returns {{ground: Uint8Array, leaves: number, skyLeaves: number, splitTolerance: number}}
 */
export function quadTreeGround(smooth, texture, dead, W, H, O) {
    const ground = new Uint8Array(W * H).fill(1);   // reject by default; sky must be earned

    // The split threshold is read off the image rather than fixed, because "how much does a patch
    // vary" has no absolute scale across sensors and exposures. The low quartile of the texture
    // field is a robust stand-in for the quiet parts of THIS frame - the sky, if there is any.
    const sample = [];
    for (let i = 0; i < W * H; i += 7) if (!dead[i]) sample.push(texture[i]);
    sample.sort((a, b) => a - b);
    const quiet = sample.length ? sample[Math.floor(0.25 * sample.length)] : 0;
    const splitTolerance = Math.max(O.minSplitTolerance, O.splitToleranceFactor * quiet);

    let leaves = 0, skyLeaves = 0;

    // Measured on the TEXTURE field, not on brightness.
    //
    // The spread of absolute brightness across a block is dominated by the scene's smooth
    // gradients - light glow rising toward a horizon, vignetting, airglow - and a block spanning a
    // steep part of a ramp fails a uniformity test while being perfectly clean sky. That produced
    // a checkerboard: sky rejected in bands wherever the glow was changing fastest. Texture is a
    // local 3x3 spread, so a smooth ramp barely registers in it and only real structure does,
    // which is what "can a large uniform block describe this?" is actually asking.
    //
    // The statistic is the block's 90th-percentile texture rather than its mean: a treetop
    // occupying a fifth of an otherwise clear block must condemn the block, and a mean would
    // dilute it away.
    const stats = (x0, y0, size) => {
        const vals = [];
        let deadN = 0;
        const x1 = Math.min(W, x0 + size), y1 = Math.min(H, y0 + size);
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                const i = y * W + x;
                if (dead[i]) { deadN++; continue; }
                vals.push(texture[i]);
            }
        }
        if (!vals.length) return {n: 0, deadN, spread: 0};
        vals.sort((a, b) => a - b);
        return {n: vals.length, deadN, spread: vals[Math.floor(0.9 * (vals.length - 1))]};
    };

    const markSky = (x0, y0, size) => {
        const x1 = Math.min(W, x0 + size), y1 = Math.min(H, y0 + size);
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                const i = y * W + x;
                // A dead pixel is never sky however uniform its block: it is outside the
                // instrument's field, and no star can be recorded there.
                if (!dead[i]) ground[i] = 0;
            }
        }
    };

    const visit = (x0, y0, size) => {
        if (x0 >= W || y0 >= H) return;
        const st = stats(x0, y0, size);
        if (!st.n) { leaves++; return; }              // wholly dead: stays rejected

        const uniform = st.spread <= splitTolerance;
        if (uniform && size <= O.maxSkyLeaf) {
            // Uniform, and small enough that its uniformity is a real measurement rather than an
            // artefact of averaging a whole quadrant. A block that also had to be MOSTLY live
            // counts as sky - a block straddling the edge of a vignette is not.
            leaves++;
            if (size >= O.minSkyLeaf && st.deadN <= O.maxDeadFraction * (size * size)) {
                skyLeaves++;
                markSky(x0, y0, size);
            }
            return;
        }
        if (size <= O.minSkyLeaf) { leaves++; return; }   // detail limit: too busy to be sky

        const h = size >> 1;
        visit(x0, y0, h);
        visit(x0 + h, y0, h);
        visit(x0, y0 + h, h);
        visit(x0 + h, y0 + h, h);
    };

    // Start from a power-of-two block covering the frame, so subdivision is exact halving.
    let root = 1;
    while (root < Math.max(W, H)) root <<= 1;
    visit(0, 0, root);

    // ADJACENCY. Each block has so far been judged entirely on its own pixels, which is what made
    // this robust where a flood fill was not - but it also means a block can disagree with
    // everything around it, and in practice such a block is usually wrong. Sky over a grainier
    // corner of the sensor rejects in isolated specks; a gap between branches passes as sky in the
    // middle of a tree. Neither is plausible as a real region.
    //
    // So neighbours now vote, on a grid at block resolution. Note this is a SOFT prior and not a
    // return to connectivity: a block that genuinely differs from its surroundings survives a
    // clear majority against it, and nothing can be severed from a seed, because there is no seed.
    // That is the distinction that matters - the fill failed because one bad decision could cut
    // off a whole region, whereas here one bad block is simply outvoted.
    const gw = Math.ceil(W / O.minSkyLeaf), gh = Math.ceil(H / O.minSkyLeaf);
    let cell = new Uint8Array(gw * gh);
    const cellDead = new Uint8Array(gw * gh);
    for (let cy = 0; cy < gh; cy++) {
        for (let cx = 0; cx < gw; cx++) {
            let sky = 0, n = 0, deadN = 0;
            for (let y = cy * O.minSkyLeaf; y < Math.min(H, (cy + 1) * O.minSkyLeaf); y++) {
                for (let x = cx * O.minSkyLeaf; x < Math.min(W, (cx + 1) * O.minSkyLeaf); x++) {
                    const i = y * W + x;
                    if (dead[i]) { deadN++; continue; }
                    n++;
                    if (!ground[i]) sky++;
                }
            }
            cell[cy * gw + cx] = n && sky * 2 > n ? 1 : 0;
            cellDead[cy * gw + cx] = n === 0 ? 1 : 0;
        }
    }

    for (let pass = 0; pass < O.adjacencyPasses; pass++) {
        const next = new Uint8Array(cell);
        for (let cy = 0; cy < gh; cy++) {
            for (let cx = 0; cx < gw; cx++) {
                const c = cy * gw + cx;
                if (cellDead[c]) continue;      // dead blocks are not up for a vote
                let sky = 0, tot = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if (!dx && !dy) continue;
                        const nx = cx + dx, ny = cy + dy;
                        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
                        const q = ny * gw + nx;
                        if (cellDead[q]) continue;
                        tot++;
                        if (cell[q]) sky++;
                    }
                }
                if (!tot) continue;
                // ASYMMETRIC on purpose. Missing ground is far more costly than losing sky: a
                // treetop left unmasked puts hundreds of foliage detections into the solve, while
                // an over-masked patch of sky costs a few stars out of thousands. So a block falls
                // to ground on a weak signal and is promoted back to sky only on a strong one.
                if (cell[c] && sky <= (1 - O.toGroundMajority) * tot) next[c] = 0;
                else if (!cell[c] && sky >= O.toSkyMajority * tot) next[c] = 1;
            }
        }
        cell = next;
    }

    // Grow the ground into its boundary blocks, which are mixtures of sky and not-sky. A mixture
    // has to go somewhere, and it goes to ground - the same asymmetry as the voting above.
    for (let g = 0; g < O.groundGrowCells; g++) {
        const next = new Uint8Array(cell);
        for (let cy = 0; cy < gh; cy++) {
            for (let cx = 0; cx < gw; cx++) {
                const c = cy * gw + cx;
                if (!cell[c] || cellDead[c]) continue;      // already ground, or not in play
                let touchesGround = false;
                for (let dy = -1; dy <= 1 && !touchesGround; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = cx + dx, ny = cy + dy;
                        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
                        const q = ny * gw + nx;
                        // A dead neighbour is not ground evidence - the frame edge and a vignette
                        // rim would otherwise eat a ring of good sky.
                        if (!cellDead[q] && !cell[q]) { touchesGround = true; break; }
                    }
                }
                if (touchesGround) next[c] = 0;
            }
        }
        cell = next;
    }

    // Write the voted classification back, leaving dead pixels rejected whatever their block says.
    for (let cy = 0; cy < gh; cy++) {
        for (let cx = 0; cx < gw; cx++) {
            const isSky = cell[cy * gw + cx];
            for (let y = cy * O.minSkyLeaf; y < Math.min(H, (cy + 1) * O.minSkyLeaf); y++) {
                for (let x = cx * O.minSkyLeaf; x < Math.min(W, (cx + 1) * O.minSkyLeaf); x++) {
                    const i = y * W + x;
                    ground[i] = (isSky && !dead[i]) ? 0 : 1;
                }
            }
        }
    }

    return {ground, leaves, skyLeaves, splitTolerance};
}

/** Median of a copy; small arrays, called per pixel, so no allocation cleverness is worth it. */
function medianOf(values) {
    const a = [...values].sort((p, q) => p - q);
    return a[a.length >> 1];
}

/**
 * Luma, median-filtered to remove point sources, plus the local texture of that filtered image.
 *
 * Texture is the standard deviation over a 3x3 neighbourhood, which responds to structure while
 * staying nearly blind to a smooth illumination gradient - a bright twilight horizon glow shifts
 * the local mean without raising the local spread.
 */
export function skyFeatures(rgba, W, H, opts = {}) {
    const O = {...SKY_MASK_DEFAULTS, ...opts};
    const n = W * H;
    const luma = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        luma[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    }

    const r = Math.max(0, O.medianRadius | 0);
    let smooth = luma;
    if (r > 0) {
        smooth = new Float32Array(n);
        const buf = [];
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                buf.length = 0;
                for (let dy = -r; dy <= r; dy++) {
                    const yy = y + dy;
                    if (yy < 0 || yy >= H) continue;
                    for (let dx = -r; dx <= r; dx++) {
                        const xx = x + dx;
                        if (xx < 0 || xx >= W) continue;
                        buf.push(luma[yy * W + xx]);
                    }
                }
                smooth[y * W + x] = medianOf(buf);
            }
        }
    }

    const texture = new Float32Array(n);
    for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
            let s = 0, s2 = 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const v = smooth[(y + dy) * W + (x + dx)];
                    s += v; s2 += v * v;
                }
            }
            const m = s / 9;
            texture[y * W + x] = Math.sqrt(Math.max(0, s2 / 9 - m * m));
        }
    }
    return {luma: smooth, texture};
}

/** Mean and spread of a feature in a square window about a point. */
function sampleAt(field, W, H, x, y, radius) {
    let s = 0, s2 = 0, n = 0;
    for (let dy = -radius; dy <= radius; dy++) {
        const yy = Math.round(y) + dy;
        if (yy < 1 || yy >= H - 1) continue;
        for (let dx = -radius; dx <= radius; dx++) {
            const xx = Math.round(x) + dx;
            if (xx < 1 || xx >= W - 1) continue;
            const v = field[yy * W + xx];
            s += v; s2 += v * v; n++;
        }
    }
    if (!n) return null;
    const mean = s / n;
    return {mean, spread: Math.sqrt(Math.max(0, s2 / n - mean * mean)), n};
}

/**
 * Which feature separates the two samples better, in units of their own pooled spread.
 *
 * This is the whole point of asking for a ground seed. Separation is measured, not assumed, so a
 * clip where the ground is textured foliage and a clip where it is flat dark sea can both be
 * handled without the caller knowing which it has.
 */
function chooseFeature(skyStats, groundStats) {
    const score = (a, b) => {
        if (!a || !b) return -1;
        const pooled = Math.sqrt((a.spread * a.spread + b.spread * b.spread) / 2);
        // A pooled spread of zero with different means is perfect separation, not a divide by zero.
        if (pooled < 1e-6) return Math.abs(a.mean - b.mean) > 1e-6 ? Infinity : 0;
        return Math.abs(a.mean - b.mean) / pooled;
    };
    const t = score(skyStats.texture, groundStats.texture);
    const l = score(skyStats.luma, groundStats.luma);
    return {feature: l > t ? "luma" : "texture", lumaScore: l, textureScore: t};
}

function dilate(src, W, H, r) {
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            let hit = 0;
            for (let dy = -r; dy <= r && !hit; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= H) continue;
                for (let dx = -r; dx <= r; dx++) {
                    const xx = x + dx;
                    if (xx < 0 || xx >= W) continue;
                    if (src[yy * W + xx]) { hit = 1; break; }
                }
            }
            out[y * W + x] = hit;
        }
    }
    return out;
}

function erode(src, W, H, r) {
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            let all = 1;
            for (let dy = -r; dy <= r && all; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= H) continue;
                for (let dx = -r; dx <= r; dx++) {
                    const xx = x + dx;
                    if (xx < 0 || xx >= W) continue;
                    if (!src[yy * W + xx]) { all = 0; break; }
                }
            }
            out[y * W + x] = all;
        }
    }
    return out;
}

/** Drop connected runs of `flag` smaller than minCells, in place. */
function dropSmallComponents(flag, W, H, minCells) {
    const seen = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
        if (!flag[i] || seen[i]) continue;
        const stack = [i], cells = [];
        seen[i] = 1;
        while (stack.length) {
            const p = stack.pop();
            cells.push(p);
            const x = p % W, y = (p / W) | 0;
            if (x > 0 && flag[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
            if (x < W - 1 && flag[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
            if (y > 0 && flag[p - W] && !seen[p - W]) { seen[p - W] = 1; stack.push(p - W); }
            if (y < H - 1 && flag[p + W] && !seen[p + W]) { seen[p + W] = 1; stack.push(p + W); }
        }
        if (cells.length < minCells) for (const c of cells) flag[c] = 0;
    }
}

/**
 * Classify the frame into sky and ground by quadtree, without seeds.
 *
 * The seeded path exists because automatic methods have to guess WHICH region is sky. This one
 * does not need to guess, because it never asks: it judges every block on its own uniformity, and
 * the dead-pixel test keeps a vignette's surround out regardless. Where the seeded path needed the
 * user to break a tie, this one simply rejects whatever it cannot describe with a large uniform
 * block - which is the right default when losing sky is cheap and keeping foliage is not.
 *
 * @param {Uint8ClampedArray} rgba - working-resolution pixels, W*H*4
 * @param {number} W
 * @param {number} H
 * @param {object} [opts] - overrides of SKY_MASK_DEFAULTS
 * @returns {{ground: Uint8Array, diagnostics: object}|{error: string, diagnostics?: object}}
 */
export function quadTreeGroundMask(rgba, W, H, opts = {}) {
    const O = {...SKY_MASK_DEFAULTS, ...opts};
    const {luma, texture} = skyFeatures(rgba, W, H, O);

    const dead = new Uint8Array(W * H);
    let deadCells = 0;
    for (let i = 0; i < W * H; i++) {
        if (luma[i] <= O.deadLuma && texture[i] <= O.deadTexture) { dead[i] = 1; deadCells++; }
    }

    const out = quadTreeGround(luma, texture, dead, W, H, O);

    let groundCells = 0;
    for (let i = 0; i < W * H; i++) if (out.ground[i]) groundCells++;
    const live = W * H - deadCells;
    const skyCells = live - (groundCells - deadCells);

    const diagnostics = {
        method: "quadtree",
        leaves: out.leaves,
        skyLeaves: out.skyLeaves,
        splitTolerance: out.splitTolerance,
        deadFraction: deadCells / (W * H),
        groundFraction: groundCells / (W * H),
        workWidth: W,
        workHeight: H,
    };

    // Finding almost no sky is a failure to report, not a mask of the whole frame.
    if (live > 0 && skyCells < O.minSkyFraction * live) {
        return {
            error: `found almost no sky worth keeping (${(100 * skyCells / live).toFixed(1)}% of `
                + `the live frame). The image may be too busy to segment this way - mask by hand.`,
            diagnostics,
        };
    }
    return {ground: out.ground, diagnostics};
}

/**
 * Grow the sky from one or more seed points and return everything else as ground.
 *
 * @param {Uint8ClampedArray} rgba - working-resolution pixels, W*H*4
 * @param {number} W
 * @param {number} H
 * @param {Array<[number, number]>} skySeeds - sky points, in working pixels
 * @param {Array<[number, number]>} groundSeeds - optional ground points, in working pixels
 * @param {object} [opts] - overrides of SKY_MASK_DEFAULTS
 * @returns {{ground: Uint8Array, diagnostics: object}|{error: string}} `ground` is 1 where the
 *   pixel is NOT sky, at working resolution.
 */
export function growSkyFromSeeds(rgba, W, H, skySeeds, groundSeeds = [], opts = {}) {
    const O = {...SKY_MASK_DEFAULTS, ...opts};
    if (!skySeeds || !skySeeds.length) return {error: "no sky seed"};

    const {luma, texture} = skyFeatures(rgba, W, H, O);
    const statsFor = (seeds) => {
        const l = [], t = [];
        for (const [x, y] of seeds) {
            const ls = sampleAt(luma, W, H, x, y, O.seedRadius);
            const ts = sampleAt(texture, W, H, x, y, O.seedRadius);
            if (ls) l.push(ls);
            if (ts) t.push(ts);
        }
        if (!l.length) return null;
        const avg = (a, k) => a.reduce((s, v) => s + v[k], 0) / a.length;
        return {
            luma: {mean: avg(l, "mean"), spread: avg(l, "spread")},
            texture: {mean: avg(t, "mean"), spread: avg(t, "spread")},
        };
    };

    const skyStats = statsFor(skySeeds);
    if (!skyStats) return {error: "sky seed outside the frame"};
    const groundStats = groundSeeds.length ? statsFor(groundSeeds) : null;

    // DEAD PIXELS FIRST. An image intensifier, a telescope or a boresight camera images a circular
    // active area onto black, and that surround has to be dealt with before anything else looks at
    // the frame. It is not sky - no star can be there - and it is not ground either; it is outside
    // the instrument's field entirely.
    //
    // Left in, it corrupts everything downstream. It is the smoothest region in the frame, so a
    // texture cue calls it the most sky-like thing present; and once the growth has excluded it,
    // its luma of zero drags the "ground" statistics so far from the sky that the separation check
    // below reports a decisive split on a frame that has none. Both were observed.
    //
    // Detected as no signal at all: dark AND flat. A genuinely dark patch of sky still carries
    // sensor noise, so the texture floor is what distinguishes dead pixels from dim ones.
    const dead = new Uint8Array(W * H);
    let deadCells = 0;
    for (let i = 0; i < W * H; i++) {
        if (luma[i] <= O.deadLuma && texture[i] <= O.deadTexture) { dead[i] = 1; deadCells++; }
    }

    // With both classes sampled the cue is measured. With only sky, texture is the default: it is
    // the cue that survives a scene lit differently from the sky, which is the commoner failure.
    const choice = O.forceFeature
        ? {feature: O.forceFeature, lumaScore: null, textureScore: null}
        : groundStats
            ? chooseFeature(skyStats, groundStats)
            : {feature: "texture", lumaScore: null, textureScore: null};
    const field = choice.feature === "luma" ? luma : texture;
    const ref = skyStats[choice.feature];

    // TWO gates, because a real sky is neither uniform nor unbounded.
    //
    // The LOCAL gate is what growth actually tests: a neighbour joins if it differs from the pixel
    // already in the region by less than this. Growing on similarity to the ADVANCING REGION rather
    // than to the seed is the standard seeded-region-growing formulation, and it is what lets the
    // fill follow a smooth ramp - vignetting inside an intensifier circle, airglow toward the
    // horizon - for as far as the ramp goes, while still stopping dead at a step. Gating on
    // distance from the seed instead masked the darker corner of a perfectly good sky.
    //
    // The GLOBAL bound stops the other failure: a gradient-limited fill will happily walk down a
    // gentle slope into the ground if nothing bounds it. Where the user has named a ground sample,
    // that bound is the midpoint between the two classes - growth may not cross into territory
    // that looks more like what they called ground than what they called sky.
    const localGate = Math.max(O.localTolerance * ref.spread,
        O.minToleranceFrac * Math.abs(ref.mean) || 0);
    let globalBound = Infinity;
    if (groundStats) {
        globalBound = Math.abs(groundStats[choice.feature].mean - ref.mean) / 2;
    }

    // Edges are sealed before growing so the fill cannot leak through gaps in a lace of foliage
    // edges. A cell counts as an edge when its neighbourhood spans more than the local gate.
    const edge = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
            let lo = Infinity, hi = -Infinity;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const v = field[(y + dy) * W + (x + dx)];
                    if (v < lo) lo = v;
                    if (v > hi) hi = v;
                }
            }
            edge[y * W + x] = (hi - lo) > localGate ? 1 : 0;
        }
    }
    let blocked = O.closeRadius > 0
        ? erode(dilate(edge, W, H, O.closeRadius), W, H, Math.max(1, O.closeRadius - 1))
        : edge;
    // Dead pixels block growth outright. Without this the fill runs out through the flat black
    // surround - which no edge test stops, because it has no structure to detect - and wraps
    // around the frame.
    for (let i = 0; i < W * H; i++) if (dead[i]) blocked[i] = 1;

    const reached = new Uint8Array(W * H);
    const stack = [];
    for (const [sx, sy] of skySeeds) {
        const x = Math.round(sx), y = Math.round(sy);
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const p = y * W + x;
        // A seed inside the sealed region would grow nothing at all; report that rather than
        // silently returning a full-frame mask.
        if (blocked[p] || reached[p]) continue;
        reached[p] = 1;
        stack.push(p);
    }
    if (!stack.length) return {error: "sky seed did not land on sky-like pixels"};

    // A neighbour joins when it is neither an edge, nor a step away from the cell it is joining
    // from, nor beyond the global bound. The local step is what follows a smooth sky gradient; the
    // global bound is what stops that same tolerance walking all the way down into the ground.
    const canJoin = (from, to) => !reached[to] && !blocked[to]
        && Math.abs(field[to] - field[from]) <= localGate
        && Math.abs(field[to] - ref.mean) <= globalBound;

    while (stack.length) {
        const p = stack.pop();
        const x = p % W, y = (p / W) | 0;
        if (x > 0 && canJoin(p, p - 1)) { reached[p - 1] = 1; stack.push(p - 1); }
        if (x < W - 1 && canJoin(p, p + 1)) { reached[p + 1] = 1; stack.push(p + 1); }
        if (y > 0 && canJoin(p, p - W)) { reached[p - W] = 1; stack.push(p - W); }
        if (y < H - 1 && canJoin(p, p + W)) { reached[p + W] = 1; stack.push(p + W); }
    }

    const ground = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) ground[i] = reached[i] ? 0 : 1;
    dropSmallComponents(ground, W, H, O.minGroundCells);
    // Dead pixels are masked unconditionally, whatever the growth decided, and after the
    // small-component pass so a thin dead rim is never dropped as speckle.
    for (let i = 0; i < W * H; i++) if (dead[i]) ground[i] = 1;

    let groundCells = 0;
    for (let i = 0; i < W * H; i++) if (ground[i]) groundCells++;

    // Does the split the growth produced actually stand up?
    //
    // The cue was chosen on each seed's LOCAL spread - the variation inside a small window - and a
    // cue can look decisive there while being useless across the frame. Measured on an image
    // intensifier clip: brightness scored 15.5 between the two seed windows, but the sky's own
    // vignetting spans 58.7 down to 30.4 from centre to edge, against a ground at 23.7. The
    // classes overlap once the whole frame is considered, and the growth masked most of a good sky.
    //
    // So the separation is re-measured on the regions actually produced, using the SPATIAL spread
    // of the sky rather than a window's. When the two region means are not clearly apart on that
    // scale, this frame does not support the split and saying so beats returning a confident wrong
    // answer. A caller wanting the mask anyway can lower requiredSeparation.
    // Dead pixels are excluded from the statistics as well as from the growth: a surround at zero
    // would otherwise make any split look decisive, which is exactly how a frame with no real
    // separation passed this check.
    let skySum = 0, skySq = 0, skyN = 0, gSum = 0, gN = 0;
    for (let i = 0; i < W * H; i++) {
        if (dead[i]) continue;
        if (ground[i]) { gSum += field[i]; gN++; }
        else { skySum += field[i]; skySq += field[i] * field[i]; skyN++; }
    }
    const skyRegionMean = skyN ? skySum / skyN : 0;
    const skyRegionSpread = skyN
        ? Math.sqrt(Math.max(0, skySq / skyN - skyRegionMean * skyRegionMean)) : 0;
    const groundRegionMean = gN ? gSum / gN : 0;
    const regionSeparation = skyRegionSpread > 1e-6
        ? Math.abs(skyRegionMean - groundRegionMean) / skyRegionSpread
        : Infinity;

    const diagnostics = {
        feature: choice.feature,
        lumaScore: choice.lumaScore,
        textureScore: choice.textureScore,
        skyMean: ref.mean,
        skySpread: ref.spread,
        localGate,
        globalBound,
        skyRegionMean,
        skyRegionSpread,
        groundRegionMean,
        regionSeparation,
        groundFraction: groundCells / (W * H),
        workWidth: W,
        workHeight: H,
    };

    // Growing (almost) nothing is a failure, not a mask of everything. The separation test below
    // needs both regions to exist, so without this an empty sky region skips the test entirely and
    // returns a confident 100%-masked frame - which is how a retry that grew nothing at all
    // reported success. A seed the user placed on sky must yield some sky.
    if (skyN < O.minSkyFraction * (W * H - deadCells)) {
        return {
            error: `grew almost no sky from that seed on ${choice.feature} - the gate is too tight `
                + `for this frame. Try a seed in a more typical patch of sky, or mask by hand.`,
            diagnostics,
        };
    }

    if (gN && skyN && regionSeparation < O.requiredSeparation) {
        // Try the OTHER cue before giving up. The seed windows can only measure separation
        // LOCALLY, and a cue that wins there can still be the wrong one for the whole frame -
        // measured on a wide night landscape with light glow along the horizon, where brightness
        // won between the two seed windows but the glow is brighter than the upper sky, so the
        // classes overlap. Texture is untroubled by that: smooth sky against textured trees.
        // Recursion costs one more pass at the working width, which is cheap whatever the source
        // resolution, and the forced flag makes it terminate after exactly one retry.
        if (!O.forceFeature && groundStats) {
            const other = choice.feature === "luma" ? "texture" : "luma";
            const retry = growSkyFromSeeds(rgba, W, H, skySeeds, groundSeeds,
                {...O, forceFeature: other});
            if (!retry.error) return retry;
        }
        return {
            error: `this frame does not separate on ${choice.feature}: the sky varies as much `
                + `across the frame as it differs from the ground `
                + `(${regionSeparation.toFixed(2)} of its own spread). Mask it by hand, or try `
                + `seeds further apart.`,
            diagnostics,
        };
    }

    return {ground, diagnostics};
}
