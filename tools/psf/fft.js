// Radix-2 complex FFT — enough for the square pupil transforms this tool needs, and nothing
// more. Written out rather than pulled from npm because tools/ pages are served as raw ES
// modules: no bundler ever sees them, so every import has to resolve over plain HTTP.
//
// A split-radix or real-input transform would be roughly twice as fast, but a 512^2 forward
// transform runs in ~25 ms here and the in-focus polychromatic path needs exactly ONE of
// them (see psf.js), so clarity wins over cleverness.

/** One power-of-two complex transform length, with its twiddle and bit-reversal tables. */
export class FFT {
    /** @param {number} n transform length; must be a power of two. */
    constructor(n) {
        if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`FFT length ${n} is not a power of two`);
        this.n = n;
        this.levels = Math.round(Math.log2(n));

        // Twiddles for the largest butterfly. Smaller stages index this same table with a
        // stride, which is why it only needs n/2 entries rather than one table per stage.
        const half = n >> 1;
        this.cos = new Float64Array(half);
        this.sin = new Float64Array(half);
        for (let i = 0; i < half; i++) {
            this.cos[i] = Math.cos((2 * Math.PI * i) / n);
            this.sin[i] = Math.sin((2 * Math.PI * i) / n);
        }

        // Bit-reversal permutation, precomputed. The reversal runs n times per transform and
        // 2n times per 2D transform; recomputing it per element measurably dominates.
        this.rev = new Uint32Array(n);
        for (let i = 0; i < n; i++) {
            let r = 0;
            for (let b = 0; b < this.levels; b++) r |= ((i >>> b) & 1) << (this.levels - 1 - b);
            this.rev[i] = r;
        }
    }

    /** In-place decimation-in-time transform of one length-n complex vector. Unnormalised:
     *  the 1/n belongs to whoever asked for the inverse, and FFT2D applies it once. */
    transform(re, im, inverse = false) {
        const n = this.n, rev = this.rev, cos = this.cos, sin = this.sin;
        const sign = inverse ? 1 : -1;

        for (let i = 0; i < n; i++) {
            const j = rev[i];
            if (j > i) {
                let t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }

        for (let size = 2; size <= n; size <<= 1) {
            const half = size >> 1;
            const stride = n / size;
            for (let base = 0; base < n; base += size) {
                for (let j = base, k = 0; j < base + half; j++, k += stride) {
                    const wr = cos[k], wi = sign * sin[k];
                    const l = j + half;
                    const tr = re[l] * wr - im[l] * wi;
                    const ti = re[l] * wi + im[l] * wr;
                    re[l] = re[j] - tr;
                    im[l] = im[j] - ti;
                    re[j] += tr;
                    im[j] += ti;
                }
            }
        }
    }
}

/** Square 2D transform by the row-column method. */
export class FFT2D {
    constructor(n) {
        this.n = n;
        this.fft = new FFT(n);
        // Column scratch. Rows are contiguous so they transform through a subarray view with
        // no copy at all; columns are strided and have to be gathered.
        this.colRe = new Float64Array(n);
        this.colIm = new Float64Array(n);
    }

    /** In-place on two n*n arrays laid out row-major. */
    transform(re, im, inverse = false) {
        const n = this.n, fft = this.fft, cr = this.colRe, ci = this.colIm;

        for (let y = 0; y < n; y++) {
            const o = y * n;
            fft.transform(re.subarray(o, o + n), im.subarray(o, o + n), inverse);
        }

        for (let x = 0; x < n; x++) {
            for (let y = 0; y < n; y++) { const i = y * n + x; cr[y] = re[i]; ci[y] = im[i]; }
            fft.transform(cr, ci, inverse);
            for (let y = 0; y < n; y++) { const i = y * n + x; re[i] = cr[y]; im[i] = ci[y]; }
        }

        if (inverse) {
            const k = 1 / (n * n);
            for (let i = 0, e = n * n; i < e; i++) { re[i] *= k; im[i] *= k; }
        }
    }
}

/** Move the zero frequency from the corner to the centre, in place, by swapping quadrants.
 *  n must be even, which it is: it is a power of two. */
export function fftshift(a, n) {
    const h = n >> 1;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < h; x++) {
            const tl = y * n + x, tr = y * n + x + h, bl = (y + h) * n + x, br = (y + h) * n + x + h;
            let t = a[tl]; a[tl] = a[br]; a[br] = t;
            t = a[tr]; a[tr] = a[bl]; a[bl] = t;
        }
    }
}
