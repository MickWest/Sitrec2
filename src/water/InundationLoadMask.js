// A summed-area table restricts detailed tile downloads to potentially flooded
// land. Open ocean and high inland ground do not need building-level meshes.
// A small height margin includes coastal barriers and DEM/mesh disagreement.
export function inundationLoadMask(heights, ocean, size, level, resolved = null, onlyKnown = null, oceanSeeds = null, radiusCells = Infinity) {
    const stride = size + 1, sums = new Uint32Array(stride * stride);
    const center = size / 2, radiusSquared = radiusCells * radiusCells;
    for (let y = 0; y < size; y++) {
        let row = 0;
        for (let x = 0; x < size; x++) {
            const i = y * size + x;
            const candidate = ocean[i] ? oceanSeeds && !oceanSeeds[i] : Number.isFinite(heights[i]) && heights[i] <= level + 5;
            if (candidate && !resolved?.[i] && (!onlyKnown || onlyKnown[i])
                && (x + 0.5 - center) ** 2 + (y + 0.5 - center) ** 2 <= radiusSquared) row++;
            sums[(y + 1) * stride + x + 1] = row + sums[y * stride + x + 1];
        }
    }
    return sums;
}

export function inundationMaskIntersects(sums, size, minX, minY, maxX, maxY) {
    // Include the immediate offshore margin, including seawall geometry.
    const x0 = Math.max(0, Math.min(size, Math.floor(minX) - 2));
    const y0 = Math.max(0, Math.min(size, Math.floor(minY) - 2));
    const x1 = Math.max(0, Math.min(size, Math.ceil(maxX) + 3));
    const y1 = Math.max(0, Math.min(size, Math.ceil(maxY) + 3));
    const stride = size + 1;
    return sums[y1 * stride + x1] - sums[y0 * stride + x1] - sums[y1 * stride + x0] + sums[y0 * stride + x0] > 0;
}
