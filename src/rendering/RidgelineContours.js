// Marching squares on the resolved terrain coverage. Coordinates are in the
// render target's bottom-up pixel space; never trace the edge of the viewport.
export function ridgelineContours(pixels, width, height) {
    const segments = [];
    const value = (x, y) => pixels[(y * width + x) * 4] / 255;
    for (let y = 0; y < height - 1; y++) for (let x = 0; x < width - 1; x++) {
        const a = value(x, y), b = value(x + 1, y), c = value(x + 1, y + 1), d = value(x, y + 1);
        if ((a < 0.5 && b < 0.5 && c < 0.5 && d < 0.5)
            || (a >= 0.5 && b >= 0.5 && c >= 0.5 && d >= 0.5)) continue;
        const points = [[x + 0.5, y + 0.5], [x + 1.5, y + 0.5],
            [x + 1.5, y + 1.5], [x + 0.5, y + 1.5]];
        const values = [a, b, c, d];
        const crossings = [];
        for (let i = 0; i < 4; i++) {
            const j = (i + 1) % 4;
            if ((values[i] < 0.5) === (values[j] < 0.5)) continue;
            const t = (0.5 - values[i]) / (values[j] - values[i]);
            crossings.push([points[i][0] + t * (points[j][0] - points[i][0]),
                points[i][1] + t * (points[j][1] - points[i][1])]);
        }
        for (let i = 0; i + 1 < crossings.length; i += 2) segments.push([crossings[i], crossings[i + 1]]);
    }
    return segments;
}
