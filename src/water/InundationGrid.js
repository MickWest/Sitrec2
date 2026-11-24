// Equilibrium inundation from ocean seeds. Four neighbours prevent water
// leaking diagonally through a closed corner. Unknown heights are barriers.
// Recomputed from scratch when the level falls, so disconnected basins drain.
export function connectedInundation(heights, ocean, width, height, level, wet = new Uint8Array(heights.length)) {
    wet.fill(0);
    const queue = new Uint32Array(heights.length);
    let head = 0, tail = 0;
    for (let i = 0; i < ocean.length; i++) {
        if (ocean[i]) { wet[i] = 255; queue[tail++] = i; }
    }
    const visit = i => {
        if (!wet[i] && Number.isFinite(heights[i]) && heights[i] <= level) {
            wet[i] = 255;
            queue[tail++] = i;
        }
    };
    while (head < tail) {
        const i = queue[head++], x = i % width;
        if (x > 0) visit(i - 1);
        if (x + 1 < width) visit(i + 1);
        if (i >= width) visit(i - width);
        if (i + width < width * height) visit(i + width);
    }
    return wet;
}

export function latitudeAtMercatorY(y) {
    return Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
}
