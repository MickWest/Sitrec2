// Equilibrium inundation from ocean seeds. Four neighbours prevent water
// leaking diagonally through a closed corner. Unknown heights are barriers.
// Recomputed from scratch when the level falls, so disconnected basins drain.
export function connectedInundation(heights, ocean, width, height, level, wet = new Uint8Array(heights.length), barriers = null, trace = null) {
    wet.fill(0);
    const queue = new Uint32Array(heights.length);
    const parent = trace ? new Int32Array(heights.length).fill(-1) : null;
    let head = 0, tail = 0;
    for (let i = 0; i < ocean.length; i++) {
        if (ocean[i]) { wet[i] = 255; queue[tail++] = i; }
    }
    const visit = (i, from) => {
        if (!wet[i] && (!barriers?.coverage || barriers.coverage[i]) && Number.isFinite(heights[i]) && heights[i] <= level) {
            wet[i] = 255;
            queue[tail++] = i;
            if (parent) parent[i] = from;
        }
    };
    while (head < tail) {
        const i = queue[head++], x = i % width;
        if (x > 0 && !barriers?.east[i - 1]) visit(i - 1, i);
        if (x + 1 < width && !barriers?.east[i]) visit(i + 1, i);
        if (i >= width && !barriers?.south[i - width]) visit(i - width, i);
        if (i + width < width * height && !barriers?.south[i]) visit(i + width, i);
    }
    if (trace) { trace.parent = parent; trace.order = queue.subarray(0, tail); }
    return wet;
}

// Rasterize the actual mesh footprint, not its bounding box (which can span
// unloaded holes). Unknown land is never an open route in photogrammetry mode.
export function addInundationCoverageTriangle(vertices, a, b, c, coverage, width, height) {
    const ax = vertices[a * 3], ay = vertices[a * 3 + 1];
    const bx = vertices[b * 3], by = vertices[b * 3 + 1];
    const cx = vertices[c * 3], cy = vertices[c * 3 + 1];
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-10) return;
    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx))), x1 = Math.min(width - 1, Math.floor(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy))), y1 = Math.min(height - 1, Math.floor(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const u = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / area;
        const v = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / area;
        if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6) coverage[y * width + x] = 1;
    }
}

// A mesh/water intersection blocks connections BETWEEN cells. This preserves
// thin walls which a cell-centre height sample could miss, and leaves passages
// beneath raised bridge decks open. Coordinates are in cell-centre units.
export function addInundationBarrier(ax, ay, bx, by, barriers, width, height) {
    const dx = bx - ax, dy = by - ay;
    if (Math.abs(dx) + Math.abs(dy) < 1e-8) return;
    const mark = (array, x, y, horizontal) => {
        if (x >= 0 && y >= 0 && x < width - (horizontal ? 1 : 0) && y < height - (horizontal ? 0 : 1)) {
            array[y * width + x] = 1;
        }
    };
    if (Math.abs(dy) > 1e-10) {
        const start = Math.max(0, Math.ceil(Math.min(ay, by)));
        const end = Math.min(height - 1, Math.floor(Math.max(ay, by)));
        for (let y = start; y <= end; y++) {
            const x = ax + (y - ay) / dy * dx, ix = Math.floor(x);
            mark(barriers.east, ix, y, true);
            // A wall through a cell centre must not leave a one-cell crack.
            if (Math.abs(x - Math.round(x)) < 1e-7) mark(barriers.east, Math.round(x) - 1, y, true);
        }
    }
    if (Math.abs(dx) > 1e-10) {
        const start = Math.max(0, Math.ceil(Math.min(ax, bx)));
        const end = Math.min(width - 1, Math.floor(Math.max(ax, bx)));
        for (let x = start; x <= end; x++) {
            const y = ay + (x - ax) / dx * dy, iy = Math.floor(y);
            mark(barriers.south, x, iy, false);
            if (Math.abs(y - Math.round(y)) < 1e-7) mark(barriers.south, x, Math.round(y) - 1, false);
        }
    }
}

export function addInundationTriangle(vertices, a, b, c, level, barriers, width, height) {
    const aboveA = vertices[a * 3 + 2] > level, aboveB = vertices[b * 3 + 2] > level;
    const aboveC = vertices[c * 3 + 2] > level;
    if (aboveA === aboveB && aboveB === aboveC) return;
    if (Math.max(vertices[a * 3], vertices[b * 3], vertices[c * 3]) < 0
        || Math.min(vertices[a * 3], vertices[b * 3], vertices[c * 3]) > width - 1
        || Math.max(vertices[a * 3 + 1], vertices[b * 3 + 1], vertices[c * 3 + 1]) < 0
        || Math.min(vertices[a * 3 + 1], vertices[b * 3 + 1], vertices[c * 3 + 1]) > height - 1) return;
    const indices = [a * 3, b * 3, c * 3];
    let px, py, count = 0;
    for (let edge = 0; edge < 3; edge++) {
        const i = indices[edge], j = indices[(edge + 1) % 3];
        const hi = vertices[i + 2], hj = vertices[j + 2];
        if ((hi > level) === (hj > level)) continue;
        const t = (level - hi) / (hj - hi);
        const x = vertices[i] + t * (vertices[j] - vertices[i]);
        const y = vertices[i + 1] + t * (vertices[j + 1] - vertices[i + 1]);
        if (count++ === 0) { px = x; py = y; }
        else addInundationBarrier(px, py, x, y, barriers, width, height);
    }
}

export function latitudeAtMercatorY(y) {
    return Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
}
