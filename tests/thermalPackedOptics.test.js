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
