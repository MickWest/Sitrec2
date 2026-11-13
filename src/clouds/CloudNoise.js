// CloudNoise.js - tileable noise for the volumetric clouds, in plain JavaScript.
//
// Run in Web Workers (src/workers/CloudNoiseWorker.js) once per page, and in
// Jest. Deterministic: the same seed and NOISE_VERSION give the same bytes.
// Every texture tiles in all three axes with period 1 in texture coordinates,
// which the shader relies on (it samples at (offset mod period + p) / period).
//
// Three textures (the Schneider 2015 "Nubis" recipe, plus a weather texture):
//   shape   128^3 RGBA8  R = Perlin-Worley, G/B/A = inverted Worley FBM at 4, 8, 16 cells
//   detail   32^3 RGBA8  R/G/B = inverted Worley FBM at 2, 4, 8 cells, A = Perlin FBM
//   weather  64^3 RGBA8  R = coverage (Perlin-Worley FBM), G = Perlin FBM, B = cells,
//                        A = fine FBM; every channel histogram-equalized to uniform
//                        [0, 1], so a coverage threshold of 1 - c covers a fraction c.
// And one 2D texture:
//   blue noise 64^2 R8   a rank-ordered blue-noise (void-and-cluster) pattern for
//                        the march jitter: no low frequencies, so the grain it leaves
//                        is fine and even, and a blur removes it.

export const NOISE_VERSION = 2;
export const NOISE_SEED = 1;
export const SHAPE_SIZE = 128;
export const DETAIL_SIZE = 32;
export const WEATHER_SIZE = 64;
export const BLUE_NOISE_SIZE = 64;

// Small deterministic PRNG (mulberry32).
export function makeRandom(seed) {
    let state = (seed >>> 0) || 1;
    return function random() {
        state = (state + 0x6D2B79F5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

// A permutation table of 256 entries, doubled to avoid wrapping the index.
export function makePermutation(seed) {
    const random = makeRandom(seed);
    const table = new Uint8Array(256);
    for (let index = 0; index < 256; index++) table[index] = index;
    for (let index = 255; index > 0; index--) {
        const other = Math.floor(random() * (index + 1));
        const swap = table[index]; table[index] = table[other]; table[other] = swap;
    }
    const doubled = new Uint8Array(512);
    for (let index = 0; index < 512; index++) doubled[index] = table[index & 255];
    return doubled;
}

const GRADIENTS = new Float32Array([
    1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
    1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
    0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

function fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
}

function wrap(index, period) {
    const m = index % period;
    return m < 0 ? m + period : m;
}

function gradientDot(perm, ix, iy, iz, x, y, z) {
    const hash = perm[perm[perm[ix & 255] + (iy & 255)] + (iz & 255)] % 12;
    const g = hash * 3;
    return GRADIENTS[g] * x + GRADIENTS[g + 1] * y + GRADIENTS[g + 2] * z;
}

// Improved Perlin gradient noise, tileable: the lattice wraps every `period`
// cells. (x, y, z) in lattice units. Range about [-1, 1].
export function perlin3(perm, x, y, z, period) {
    const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
    const dx = x - fx, dy = y - fy, dz = z - fz;
    const x0 = wrap(fx, period), y0 = wrap(fy, period), z0 = wrap(fz, period);
    const x1 = wrap(fx + 1, period), y1 = wrap(fy + 1, period), z1 = wrap(fz + 1, period);
    const u = fade(dx), v = fade(dy), w = fade(dz);
    const n000 = gradientDot(perm, x0, y0, z0, dx, dy, dz);
    const n100 = gradientDot(perm, x1, y0, z0, dx - 1, dy, dz);
    const n010 = gradientDot(perm, x0, y1, z0, dx, dy - 1, dz);
    const n110 = gradientDot(perm, x1, y1, z0, dx - 1, dy - 1, dz);
    const n001 = gradientDot(perm, x0, y0, z1, dx, dy, dz - 1);
    const n101 = gradientDot(perm, x1, y0, z1, dx - 1, dy, dz - 1);
    const n011 = gradientDot(perm, x0, y1, z1, dx, dy - 1, dz - 1);
    const n111 = gradientDot(perm, x1, y1, z1, dx - 1, dy - 1, dz - 1);
    const nx00 = n000 + u * (n100 - n000), nx10 = n010 + u * (n110 - n010);
    const nx01 = n001 + u * (n101 - n001), nx11 = n011 + u * (n111 - n011);
    const nxy0 = nx00 + v * (nx10 - nx00), nxy1 = nx01 + v * (nx11 - nx01);
    return nxy0 + w * (nxy1 - nxy0);
}

// Perlin FBM over `octaves`, frequency doubling from `frequency` cells per tile.
// (x, y, z) in tile units [0, 1). Range about [-1, 1].
export function perlinFBM(perm, x, y, z, frequency, octaves) {
    let sum = 0, amplitude = 1, total = 0, f = frequency;
    for (let octave = 0; octave < octaves; octave++) {
        sum += amplitude * perlin3(perm, x * f, y * f, z * f, f);
        total += amplitude;
        amplitude *= 0.5;
        f *= 2;
    }
    return sum / total;
}

// One jittered feature point per cell of a frequency^3 grid, cell-local in [0, 1).
export function makeWorleyPoints(frequency, seed) {
    const random = makeRandom(seed * 7919 + frequency * 104729);
    const points = new Float32Array(frequency * frequency * frequency * 3);
    for (let index = 0; index < points.length; index++) points[index] = random();
    return points;
}

// Tileable Worley F1: distance to the nearest feature point, in cell units,
// clamped to [0, 1]. (x, y, z) in tile units [0, 1).
export function worley3(points, frequency, x, y, z) {
    const px = x * frequency, py = y * frequency, pz = z * frequency;
    const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz);
    let best = 9;
    for (let oz = -1; oz <= 1; oz++) {
        const gz = cz + oz, wz = wrap(gz, frequency);
        for (let oy = -1; oy <= 1; oy++) {
            const gy = cy + oy, wy = wrap(gy, frequency);
            const row = (wz * frequency + wy) * frequency;
            for (let ox = -1; ox <= 1; ox++) {
                const gx = cx + ox, wx = wrap(gx, frequency);
                const cell = (row + wx) * 3;
                const ddx = gx + points[cell] - px;
                const ddy = gy + points[cell + 1] - py;
                const ddz = gz + points[cell + 2] - pz;
                const distance = ddx * ddx + ddy * ddy + ddz * ddz;
                if (distance < best) best = distance;
            }
        }
    }
    return Math.min(1, Math.sqrt(best));
}

// Inverted Worley FBM from three precomputed octaves (1 - F1 so cells are bright).
function worleyFBM(w0, w1, w2) {
    return (1 - w0) * 0.625 + (1 - w1) * 0.25 + (1 - w2) * 0.125;
}

function remap(value, low0, high0, low1, high1) {
    return low1 + (value - low0) * (high1 - low1) / (high0 - low0);
}

function toByte(value) {
    const v = Math.round(value * 255);
    return v < 0 ? 0 : v > 255 ? 255 : v;
}

// Perlin FBM's spread is about +-0.35; this maps it to [0, 1] with a mild clip.
const PERLIN_CONTRAST = 1.45;

export function shapeContext(seed = NOISE_SEED) {
    return {
        perm: makePermutation(seed),
        worley: [4, 8, 16, 32, 64].map(frequency => ({frequency, points: makeWorleyPoints(frequency, seed)})),
    };
}

// Slices [z0, z1) of the shape texture as RGBA bytes (size^2 * (z1 - z0) * 4).
export function generateShapeSlices(size, z0, z1, seed = NOISE_SEED, context = shapeContext(seed)) {
    const out = new Uint8Array(size * size * (z1 - z0) * 4);
    const [w4, w8, w16, w32, w64] = context.worley;
    let index = 0;
    for (let z = z0; z < z1; z++) {
        const tz = (z + 0.5) / size;
        for (let y = 0; y < size; y++) {
            const ty = (y + 0.5) / size;
            for (let x = 0; x < size; x++) {
                const tx = (x + 0.5) / size;
                const f4 = worley3(w4.points, 4, tx, ty, tz);
                const f8 = worley3(w8.points, 8, tx, ty, tz);
                const f16 = worley3(w16.points, 16, tx, ty, tz);
                const f32 = worley3(w32.points, 32, tx, ty, tz);
                const f64 = worley3(w64.points, 64, tx, ty, tz);
                const worleyLow = worleyFBM(f4, f8, f16);
                const perlin = Math.min(1, Math.max(0, 0.5 + PERLIN_CONTRAST * perlinFBM(context.perm, tx, ty, tz, 4, 4)));
                // Perlin-Worley: billowy Perlin, with the Worley cells as its floor.
                const perlinWorley = remap(perlin, 0, 1, worleyLow, 1);
                out[index++] = toByte(perlinWorley);
                out[index++] = toByte(worleyLow);
                out[index++] = toByte(worleyFBM(f8, f16, f32));
                out[index++] = toByte(worleyFBM(f16, f32, f64));
            }
        }
    }
    return out;
}

export function generateDetail(size = DETAIL_SIZE, seed = NOISE_SEED) {
    const perm = makePermutation(seed + 11);
    const octaves = [2, 4, 8, 16, 32].map(frequency => makeWorleyPoints(frequency, seed + 11));
    const out = new Uint8Array(size * size * size * 4);
    let index = 0;
    for (let z = 0; z < size; z++) {
        const tz = (z + 0.5) / size;
        for (let y = 0; y < size; y++) {
            const ty = (y + 0.5) / size;
            for (let x = 0; x < size; x++) {
                const tx = (x + 0.5) / size;
                const f2 = worley3(octaves[0], 2, tx, ty, tz);
                const f4 = worley3(octaves[1], 4, tx, ty, tz);
                const f8 = worley3(octaves[2], 8, tx, ty, tz);
                const f16 = worley3(octaves[3], 16, tx, ty, tz);
                const f32 = worley3(octaves[4], 32, tx, ty, tz);
                out[index++] = toByte(worleyFBM(f2, f4, f8));
                out[index++] = toByte(worleyFBM(f4, f8, f16));
                out[index++] = toByte(worleyFBM(f8, f16, f32));
                out[index++] = toByte(0.5 + PERLIN_CONTRAST * perlinFBM(perm, tx, ty, tz, 4, 3));
            }
        }
    }
    return out;
}

// Replace each value by its rank (empirical CDF): a uniform distribution on [0, 1].
export function equalize(values) {
    const bins = 4096;
    let low = Infinity, high = -Infinity;
    for (const value of values) {
        if (value < low) low = value;
        if (value > high) high = value;
    }
    const span = high - low || 1;
    const histogram = new Float64Array(bins);
    for (const value of values) histogram[Math.min(bins - 1, Math.floor((value - low) / span * bins))]++;
    const cdf = new Float64Array(bins);
    let running = 0;
    for (let bin = 0; bin < bins; bin++) {
        // Mid-bin rank, so the result spans (0, 1) symmetrically.
        cdf[bin] = (running + histogram[bin] * 0.5) / values.length;
        running += histogram[bin];
    }
    const out = new Float32Array(values.length);
    for (let index = 0; index < values.length; index++) {
        out[index] = cdf[Math.min(bins - 1, Math.floor((values[index] - low) / span * bins))];
    }
    return out;
}

export function generateWeather(size = WEATHER_SIZE, seed = NOISE_SEED) {
    const permA = makePermutation(seed + 23), permB = makePermutation(seed + 29);
    const cells = [4, 8, 16].map(frequency => makeWorleyPoints(frequency, seed + 23));
    const count = size * size * size;
    const channels = [new Float32Array(count), new Float32Array(count), new Float32Array(count), new Float32Array(count)];
    let index = 0;
    for (let z = 0; z < size; z++) {
        const tz = (z + 0.5) / size;
        for (let y = 0; y < size; y++) {
            const ty = (y + 0.5) / size;
            for (let x = 0; x < size; x++) {
                const tx = (x + 0.5) / size;
                const c4 = worley3(cells[0], 4, tx, ty, tz);
                const c8 = worley3(cells[1], 8, tx, ty, tz);
                const c16 = worley3(cells[2], 16, tx, ty, tz);
                const perlin = 0.5 + PERLIN_CONTRAST * perlinFBM(permA, tx, ty, tz, 4, 4);
                // Coverage: Perlin-Worley, so cloudy patches are rounded cells, not worms.
                channels[0][index] = remap(perlin, 0, 1, worleyFBM(c4, c8, c16), 1);
                channels[1][index] = perlinFBM(permB, tx, ty, tz, 4, 5);
                channels[2][index] = worleyFBM(c4, c8, c16);
                channels[3][index] = perlinFBM(permB, tx + 0.37, ty + 0.11, tz + 0.73, 8, 3);
                index++;
            }
        }
    }
    const equalized = channels.map(equalize);
    const out = new Uint8Array(count * 4);
    for (let voxel = 0; voxel < count; voxel++) {
        for (let channel = 0; channel < 4; channel++) out[voxel * 4 + channel] = toByte(equalized[channel][voxel]);
    }
    return out;
}

// Rank-ordered blue noise by void-and-cluster (Ulichney 1993) on a tileable
// size^2 grid: bytes 0..255, each value used equally often, with neighbouring
// ranks spread apart. Deterministic for a seed.
export function generateBlueNoise(size = BLUE_NOISE_SIZE, seed = NOISE_SEED, sigma = 1.5) {
    const count = size * size;
    const radius = Math.ceil(sigma * 4);
    const width = 2 * radius + 1;
    const kernel = new Float64Array(width * width);
    for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
            kernel[(dy + radius) * width + dx + radius] = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
        }
    }
    const splat = (energy, pixel, sign) => {
        const x = pixel % size, y = (pixel - x) / size;
        for (let dy = -radius; dy <= radius; dy++) {
            const row = ((y + dy + size) % size) * size;
            for (let dx = -radius; dx <= radius; dx++) {
                energy[row + (x + dx + size) % size] += sign * kernel[(dy + radius) * width + dx + radius];
            }
        }
    };
    // The densest point of the pattern (a "cluster"), and the emptiest gap (a "void").
    const tightestCluster = (bits, energy) => {
        let best = -1, bestEnergy = -Infinity;
        for (let pixel = 0; pixel < count; pixel++) {
            if (bits[pixel] && energy[pixel] > bestEnergy) { bestEnergy = energy[pixel]; best = pixel; }
        }
        return best;
    };
    const largestVoid = (bits, energy) => {
        let best = -1, bestEnergy = Infinity;
        for (let pixel = 0; pixel < count; pixel++) {
            if (!bits[pixel] && energy[pixel] < bestEnergy) { bestEnergy = energy[pixel]; best = pixel; }
        }
        return best;
    };

    // A random start pattern of a tenth of the pixels, relaxed until moving its
    // tightest point into its largest void changes nothing.
    const random = makeRandom(seed * 7121 + 41);
    const bits = new Uint8Array(count);
    const energy = new Float64Array(count);
    const initial = Math.max(1, Math.floor(count / 10));
    for (let placed = 0; placed < initial;) {
        const pixel = Math.min(count - 1, Math.floor(random() * count));
        if (bits[pixel]) continue;
        bits[pixel] = 1;
        splat(energy, pixel, 1);
        placed++;
    }
    for (let pass = 0; pass < count; pass++) {
        const cluster = tightestCluster(bits, energy);
        bits[cluster] = 0;
        splat(energy, cluster, -1);
        const gap = largestVoid(bits, energy);
        bits[gap] = 1;
        splat(energy, gap, 1);
        if (gap === cluster) break;
    }

    const rank = new Int32Array(count);
    // Ranks below the start pattern: take its tightest points away one by one.
    const workingBits = Uint8Array.from(bits);
    const workingEnergy = Float64Array.from(energy);
    for (let next = initial - 1; next >= 0; next--) {
        const cluster = tightestCluster(workingBits, workingEnergy);
        workingBits[cluster] = 0;
        splat(workingEnergy, cluster, -1);
        rank[cluster] = next;
    }
    // Ranks above it: fill the largest void one by one.
    for (let next = initial; next < count; next++) {
        const gap = largestVoid(bits, energy);
        bits[gap] = 1;
        splat(energy, gap, 1);
        rank[gap] = next;
    }
    const out = new Uint8Array(count);
    for (let pixel = 0; pixel < count; pixel++) out[pixel] = Math.floor(rank[pixel] * 256 / count);
    return out;
}
