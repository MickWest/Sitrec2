// EGM96 bilinear interpolation without network or application state.
// Grid values are centimetres, row-major, at 15 arc-minute intervals.
const NUM_ROWS = 721;
const NUM_COLS = 1440;
const INTERVAL = (15 / 60) * (Math.PI / 180);
const normalizeRadians = (rads, center = 0) =>
    rads - (2 * Math.PI) * Math.floor((rads + Math.PI - center) / (2 * Math.PI));

export function meanSeaLevelFromGrid(grid, latitude, longitude) {
    const lat = normalizeRadians(latitude * (Math.PI / 180));
    const lon = normalizeRadians(longitude * (Math.PI / 180));

    let topRow = Math.floor(((Math.PI / 2) - lat) / INTERVAL);
    topRow = topRow === NUM_ROWS - 1 ? topRow - 1 : topRow;
    const bottomRow = topRow + 1;
    const leftCol = Math.floor(normalizeRadians(lon, Math.PI) / INTERVAL);
    const rightCol = (leftCol + 1) % NUM_COLS;
    const topLeft = grid[topRow * NUM_COLS + leftCol] / 100;
    const bottomLeft = grid[bottomRow * NUM_COLS + leftCol] / 100;
    const bottomRight = grid[bottomRow * NUM_COLS + rightCol] / 100;
    const topRight = grid[topRow * NUM_COLS + rightCol] / 100;

    const lonLeft = normalizeRadians(leftCol * INTERVAL);
    const latTop = (Math.PI / 2) - (topRow * INTERVAL);
    const leftProp = (lon - lonLeft) / INTERVAL;
    const topProp = (latTop - lat) / INTERVAL;
    const top = topLeft + (topRight - topLeft) * leftProp;
    const bottom = bottomLeft + (bottomRight - bottomLeft) * leftProp;
    return top + (bottom - top) * topProp;
}

export function meanSeaLevelOffsetFromGrid(grid, latitude, longitude) {
    return meanSeaLevelFromGrid(grid, Math.max(-90, Math.min(90, latitude)), longitude);
}
