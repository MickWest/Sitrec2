import {kernelReach, nearConvolutionPlan} from "../tools/thermal/ThermalPipeline.js";

// CPU model of the packed near convolution with the shaders' index rules: each tile's circular convolution on the
// plan's FFT grid (what the FFT computes; fftPackFragment places the tile at the origin and fftPrepareFragment places
// the kernel centre at index 0), then the overlap-add assembly of overlapAddFragment.
function packedConvolution(image, width, height, kernel, plan) {
    const nw = plan.fftWidth, nh = plan.fftHeight, cx = Math.floor(kernel.width / 2), cy = Math.floor(kernel.height / 2);
    const tiles = [];
    for (let ty = 0; ty < plan.tilesY; ty++) for (let tx = 0; tx < plan.tilesX; tx++) {
        const ox = tx * plan.tileWidth, oy = ty * plan.tileHeight;
        const ex = Math.min(plan.tileWidth, width - ox), ey = Math.min(plan.tileHeight, height - oy);
        const buffer = new Float64Array(nw * nh);
        for (let y = 0; y < ey; y++) for (let x = 0; x < ex; x++) {
            const value = image[(oy + y) * width + ox + x];
            for (let ky = 0; ky < kernel.height; ky++) for (let kx = 0; kx < kernel.width; kx++) {
                const u = ((x + kx - cx) % nw + nw) % nw, v = ((y + ky - cy) % nh + nh) % nh;
                buffer[v * nw + u] += value * kernel.data[ky * kernel.width + kx];
            }
        }
        tiles.push({ox, oy, ex, ey, buffer});
    }
    const result = new Float64Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        let sum = 0;
        for (const tile of tiles) {
            if (tile.ex <= 0 || tile.ey <= 0) continue;
            const lx = x - tile.ox, ly = y - tile.oy;
            if (lx < -plan.reach.low[0] || ly < -plan.reach.low[1] ||
                lx >= tile.ex + plan.reach.high[0] || ly >= tile.ey + plan.reach.high[1]) continue;
            sum += tile.buffer[((ly + nh) % nh) * nw + (lx + nw) % nw];
        }
        result[y * width + x] = sum;
    }
    return result;
}

function directConvolution(image, width, height, kernel) {
    const cx = Math.floor(kernel.width / 2), cy = Math.floor(kernel.height / 2), result = new Float64Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
        for (let ky = 0; ky < kernel.height; ky++) for (let kx = 0; kx < kernel.width; kx++) {
            const u = x + kx - cx, v = y + ky - cy;
            if (u >= 0 && u < width && v >= 0 && v < height) result[v * width + u] += image[y * width + x] * kernel.data[ky * kernel.width + kx];
        }
    return result;
}

const random = seed => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

test.each([[23, 17, 7, 5], [16, 16, 4, 6], [31, 9, 9, 3], [5, 3, 6, 4]])(
    "packed overlap-add equals the direct linear convolution (%i × %i image, %i × %i kernel)", (width, height, kw, kh) => {
        // Odd sizes leave a short last tile; even kernel widths make the support asymmetric about the centre.
        const next = random(width * 31 + kw);
        const image = Float64Array.from({length: width * height}, () => next() - .3);
        const kernel = {width: kw, height: kh, data: Float64Array.from({length: kw * kh}, () => next())};
        const reach = kernelReach([kernel]), expected = directConvolution(image, width, height, kernel);
        for (const tiles of [[2, 2], [2, 1], [1, 2]]) {
            const plan = nearConvolutionPlan(width, height, reach, {fftWidth: 0, fftHeight: 0}, {tiles});
            expect(plan.packed).toBe(true);
            // Zero circular wrap: each tile's convolution fits its FFT grid.
            expect(plan.fftWidth).toBeGreaterThanOrEqual(plan.tileWidth + reach.low[0] + reach.high[0]);
            expect(plan.fftHeight).toBeGreaterThanOrEqual(plan.tileHeight + reach.low[1] + reach.high[1]);
            const actual = packedConvolution(image, width, height, kernel, plan);
            const scale = Math.max(...expected.map(Math.abs));
            expect(Math.max(...actual.map((value, i) => Math.abs(value - expected[i])))).toBeLessThan(1e-12 * scale);
        }
    });

test("kernel support adds the core and scatter reaches, centred at floor(width / 2)", () => {
    expect(kernelReach([{width: 5, height: 3}, {width: 4, height: 7}])).toEqual({low: [4, 4], high: [3, 4]});
    expect(kernelReach([{width: 257, height: 257}, {width: 513, height: 513}])).toEqual({low: [384, 384], high: [384, 384]});
});

test("the live 640 × 512 detector at 4× packs four tiles into one 2048² transform; analysis keeps the reference", () => {
    // Measured live: the single 4096² transform took about 200 ms of GPU time per frame.
    const reach = kernelReach([{width: 257, height: 257}, {width: 513, height: 513}]);
    const reference = {fftWidth: 4096, fftHeight: 4096};
    expect(nearConvolutionPlan(2560, 2048, reach, reference, true)).toMatchObject(
        {packed: true, tilesX: 2, tilesY: 2, tileWidth: 1280, tileHeight: 1024, fftWidth: 2048, fftHeight: 2048});
    expect(nearConvolutionPlan(2560, 2048, reach, reference, false)).toMatchObject(
        {packed: false, tilesX: 1, tilesY: 1, fftWidth: 4096, fftHeight: 4096});
    // A layout is chosen only when its calculated cost is lower: an image whose padded size fills its power of two
    // (1000 + 24 = 1024) keeps the single RG transform, since four tiles would still need 1024² at twice the bytes.
    expect(nearConvolutionPlan(1000, 1000, {low: [12, 12], high: [12, 12]}, {fftWidth: 1024, fftHeight: 1024}, true).packed).toBe(false);
});

// Mirror of _fftPacked's passes along one axis, with the index and twiddle rules of fftButterflyPackedFragment (radix 2,
// first pass when the stage count is odd) and fftButterfly4PackedFragment (radix 4: two radix-2 stages per pass).
function packedAxisPasses(values, inverse) {
    const size = values.length, sign = inverse ? 1 : -1;
    const rotate = ([a, b], [c, s]) => [a * c - b * s, a * s + b * c];
    const twiddle = phase => [Math.cos(phase), Math.sin(phase)];
    let x = values;
    const radix2 = span => x.map((_, coordinate) => {
        const half = span / 2, offset = coordinate % half, base = Math.floor(coordinate / span) * span;
        const rotated = rotate(x[base + offset + half], twiddle(sign * 2 * Math.PI * offset / span));
        const s = coordinate % span < half ? 1 : -1, scale = inverse ? .5 : 1, even = x[base + offset];
        return [(even[0] + s * rotated[0]) * scale, (even[1] + s * rotated[1]) * scale];
    });
    const radix4 = span => x.map((_, coordinate) => {
        const quarter = span / 4, base = Math.floor(coordinate / span) * span, offset = coordinate - base;
        const r = offset % quarter, t = Math.floor(offset / quarter), odd = t === 1 || t === 3;
        const [a0, a1, a2, a3] = [0, 1, 2, 3].map(k => x[base + r + k * quarter]);
        const w1 = twiddle(sign * 2 * Math.PI * r / (2 * quarter)), w2 = twiddle(sign * 2 * Math.PI * r / span);
        const b1 = rotate(a1, w1), b3 = rotate(a3, w1), d = odd ? -1 : 1;
        const y0 = [a0[0] + d * b1[0], a0[1] + d * b1[1]], y2 = [a2[0] + d * b3[0], a2[1] + d * b3[1]];
        const z = rotate(y2, odd ? (inverse ? [-w2[1], w2[0]] : [w2[1], -w2[0]]) : w2);
        const s = t < 2 ? 1 : -1, scale = inverse ? .25 : 1;
        return [(y0[0] + s * z[0]) * scale, (y0[1] + s * z[1]) * scale];
    });
    let span = 1;
    if (Math.log2(size) % 2 === 1) x = radix2(span = 2);
    for (span *= 4; span <= size; span *= 4) x = radix4(span);
    return x;
}

test.each([2, 4, 8, 16, 32, 64, 2048])("the radix-4 pass sequence equals the DFT (%i points, forward and inverse)", size => {
    const next = random(size + 7), reverse = value => {
        let reversed = 0;
        for (let bit = 1; bit < size; bit *= 2) { reversed = reversed * 2 + value % 2; value = Math.floor(value / 2); }
        return reversed;
    };
    const input = Array.from({length: size}, () => [next() - .5, next() - .5]);
    for (const inverse of [false, true]) {
        // fftPackFragment and fftReversePackedFragment place element reverseBits(i) at index i.
        const actual = packedAxisPasses(input.map((_, i) => input[reverse(i)]), inverse);
        const sign = inverse ? 1 : -1, scale = inverse ? 1 / size : 1;
        let error = 0, peak = 0;
        for (let k = 0; k < size; k++) {
            let re = 0, im = 0;
            for (let n = 0; n < size; n++) {
                const c = Math.cos(sign * 2 * Math.PI * k * n / size), s = Math.sin(sign * 2 * Math.PI * k * n / size);
                re += input[n][0] * c - input[n][1] * s; im += input[n][0] * s + input[n][1] * c;
            }
            error = Math.max(error, Math.hypot(actual[k][0] - re * scale, actual[k][1] - im * scale));
            peak = Math.max(peak, Math.hypot(re * scale, im * scale));
        }
        expect(error).toBeLessThan(1e-10 * peak);
    }
});
