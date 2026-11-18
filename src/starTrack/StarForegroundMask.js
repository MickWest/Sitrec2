import {quadTreeGroundMask, SKY_MASK_DEFAULTS} from "../SkyMask";
import {detectSources} from "./StarDetect";

function hasDarkSurround(rgba, W, H) {
    const medianLuma = (x0, y0, x1, y1) => {
        const values = [];
        for (let y = Math.floor(y0 * H); y < y1 * H; y += 3) {
            for (let x = Math.floor(x0 * W); x < x1 * W; x += 3) {
                const p = 4 * (y * W + x);
                values.push(.2126 * rgba[p] + .7152 * rgba[p + 1] + .0722 * rgba[p + 2]);
            }
        }
        values.sort((a, b) => a - b);
        return values[values.length >> 1] ?? 0;
    };
    // An optical black surround has dark corners AND a clearly illuminated
    // centre. Near-black open sky lacks that contrast. Keep the surround out of
    // sky training, or its large uniform region can invert the whole mask.
    return medianLuma(.35, .35, .65, .65) > 12
        && [[0, 0], [.9, 0], [0, .9], [.9, .9]]
            .filter(([x, y]) => medianLuma(x, y, x + .1, y + .1) < 2).length >= 3;
}

function boundaryForeground(mask, W, H) {
    const out = new Uint8Array(W * H), queue = new Int32Array(W * H);
    let head = 0, tail = 0;
    const add = i => { if (mask[i] && !out[i]) { out[i] = 1; queue[tail++] = i; } };
    for (let x = 0; x < W; x++) { add(x); add((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { add(y * W); add(y * W + W - 1); }
    while (head < tail) {
        const i = queue[head++], x = i % W;
        if (x > 0) add(i - 1);
        if (x < W - 1) add(i + 1);
        if (i >= W) add(i - W);
        if (i < W * (H - 1)) add(i + W);
    }
    return out;
}

/** Segment this exposure, independently of earlier frames or the camera's motion. */
export function foregroundMaskForFrame(rgba, W, H) {
    // Bound both axes: a portrait clip must not cost several times a landscape
    // clip just because the old limit was applied to its short edge.
    const scale = Math.min(1, SKY_MASK_DEFAULTS.workWidth / Math.max(W, H));
    const width = Math.max(1, Math.round(W * scale));
    const height = Math.max(1, Math.round(H * scale));
    // Area reduction retains scene colour without aliasing stars into texture.
    // This pure implementation also runs in detection workers and test probes.
    const small = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const x0 = Math.floor(x * W / width), x1 = Math.floor((x + 1) * W / width);
        const y0 = Math.floor(y * H / height), y1 = Math.floor((y + 1) * H / height);
        let r = 0, g = 0, b = 0;
        for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
            const p = (sy * W + sx) * 4;
            r += rgba[p]; g += rgba[p + 1]; b += rgba[p + 2];
        }
        const n = (x1 - x0) * (y1 - y0), p = (y * width + x) * 4;
        small[p] = r / n; small[p + 1] = g / n; small[p + 2] = b / n; small[p + 3] = 255;
    }
    // Compressed night video often quantizes open sky to near-black. That is not
    // evidence for an optical surround; texture/colour must justify exclusion.
    const decline = () => ({data: new Uint8Array(width * height), width, height, reliable: false});
    const surround = hasDarkSurround(small, width, height);
    const levels = [];
    for (let p = 0; p < small.length; p += 16) {
        levels.push(.2126 * small[p] + .7152 * small[p + 1] + .0722 * small[p + 2]);
    }
    levels.sort((a, b) => a - b);
    // Near black, quantization and compression blocks dominate colour/texture.
    // A numerically successful model is not evidence of foreground there. An
    // illuminated optical field with a black surround is handled separately.
    if (!surround && levels[Math.floor(levels.length * .75)] < 8) return decline();
    const out = quadTreeGroundMask(small, width, height,
        {deadLuma: surround ? SKY_MASK_DEFAULTS.deadLuma : -1});
    // Segmentation refusal is normal on difficult footage, not a failed video
    // analysis. Retain the user's fixed mask and let source detection continue.
    if (out.error) return decline();
    // Sparse, grainy video can make texture-only blocks surround the very stars
    // we need. If the sky model cannot support the split, keep the fixed user
    // mask and decline an automatic exclusion for this exposure.
    const reliable = out.diagnostics.method === "color-texture";
    // Trees, buildings and wires enter through the image boundary. An isolated
    // bloom in open sky can be a bright star or satellite, not foreground.
    const data = reliable ? boundaryForeground(out.ground, width, height) : new Uint8Array(width * height);
    return {data, width, height, reliable};
}

/** Compose the moving foreground with a fixed user mask, without changing either. */
export function combineForegroundMask(foreground, fixed, W, H) {
    if (!foreground || foreground.reliable === false) return fixed ?? null;
    const out = fixed ? new Uint8Array(fixed) : new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const mx = Math.min(foreground.width - 1, Math.floor((x + .5) * foreground.width / W));
        const my = Math.min(foreground.height - 1, Math.floor((y + .5) * foreground.height / H));
        if (foreground.data[my * foreground.width + mx]) out[y * W + x] = 1;
    }
    return out;
}

/** Shared by the worker and its synchronous/retry paths. */
export function detectFrameSources(rgba, W, H, opts = {}) {
    const foregroundMask = opts.autoMaskForeground ? foregroundMaskForFrame(rgba, W, H) : null;
    const excludeMask = combineForegroundMask(foregroundMask, opts.excludeMask, W, H);
    const {sources} = detectSources(rgba, W, H, {...opts, excludeMask});
    return {sources, foregroundMask};
}

/** Compact, bounded previews keyed by SOURCE frame, never by completion order. */
export class ForegroundMaskSequence {
    constructor(maxBytes = 64 * 1024 * 1024) {
        this.frames = new Map();
        this.bytes = 0;
        this.maxBytes = maxBytes;
        this.last = null;
    }

    set(frame, mask) {
        const bits = new Uint8Array(Math.ceil(mask.data.length / 8));
        for (let i = 0; i < mask.data.length; i++) if (mask.data[i]) bits[i >> 3] |= 1 << (i & 7);
        this.bytes -= this.frames.get(frame)?.bits.length ?? 0;
        this.frames.delete(frame);
        this.frames.set(frame, {bits, width: mask.width, height: mask.height});
        this.bytes += bits.length;
        this.last = null;
        while (this.bytes > this.maxBytes && this.frames.size) {
            const key = this.frames.keys().next().value;
            this.bytes -= this.frames.get(key).bits.length;
            this.frames.delete(key);
        }
    }

    get(frame) {
        if (this.last?.frame === frame) return this.last.mask;
        const entry = this.frames.get(frame);
        // An absent/evicted frame has no preview. Never borrow another exposure's
        // mask: a camera pan can put the same pixel on the other side of a roof.
        if (!entry) return null;
        const {width, height, bits} = entry, data = new Uint8Array(width * height);
        for (let i = 0; i < data.length; i++) data[i] = (bits[i >> 3] >> (i & 7)) & 1;
        const mask = {width, height, data};
        this.last = {frame, mask};
        return mask;
    }
}
