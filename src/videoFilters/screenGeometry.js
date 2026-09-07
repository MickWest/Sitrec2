// The geometry of the recorded-off-a-screen stage, as pure functions.
//
// Kept out of AnalogVideoFilter because it needs no GPU: it is the same mapping the
// screen shader does, and callers holding ground truth measured against the rendered
// frame - the benchmark recorder's target pixel - have to push it through the same
// transform or their labels stop matching their video.
//
// forwardScreenUV MUST stay in step with screenUV() in SCREEN_SHADER. If one changes,
// the other has to change with it, or the recorded truth silently drifts off the
// picture it is supposed to describe.

/**
 * Where an output pixel samples from, in source uv. Output -> source, matching the shader.
 *
 * @param {number} u,v          output position, 0-1, v up
 * @param {object} screen       the screen settings (barrel, keystone)
 * @param {number[]} handheld   [offsetX, offsetY, rotation, zoom] for this frame
 * @param {number} aspect       output width / height
 * @returns {number[]} [u, v] in the source
 */
export function forwardScreenUV(u, v, screen, handheld, aspect) {
    let px = (u - 0.5) * aspect;
    let py = v - 0.5;

    px -= handheld[0];
    py -= handheld[1];

    const sn = Math.sin(-handheld[2]);
    const cs = Math.cos(-handheld[2]);
    [px, py] = [px * cs - py * sn, px * sn + py * cs];

    const zoom = Math.max(handheld[3], 0.01);
    px /= zoom;
    py /= zoom;

    const r2 = px * px + py * py;
    const barrel = 1 + screen.barrel * r2 + screen.barrel * 0.35 * r2 * r2;
    px /= barrel;
    py /= barrel;

    px *= 1 + screen.keystone * py;
    py *= 1 + screen.keystone * 0.35 * px;

    return [px / aspect + 0.5, py + 0.5];
}

/**
 * The inverse: where a point in the source ends up in the output.
 *
 * Solved by fixed-point iteration rather than algebraically - the forward map composes
 * a rotation, a radial division and two shears, and it is close enough to a contraction
 * (the zoom and barrel terms both shrink) that the iteration settles in a handful of
 * passes. Returns null if it does not converge, which happens only for points pushed
 * far outside the frame, where there is no sensible answer anyway.
 */
export function inverseScreenUV(targetU, targetV, screen, handheld, aspect, tolerance = 1e-6) {
    let u = targetU;
    let v = targetV;
    for (let i = 0; i < 24; i++) {
        const [fu, fv] = forwardScreenUV(u, v, screen, handheld, aspect);
        const du = targetU - fu;
        const dv = targetV - fv;
        if (Math.abs(du) < tolerance && Math.abs(dv) < tolerance) return [u, v];
        u += du;
        v += dv;
    }
    const [fu, fv] = forwardScreenUV(u, v, screen, handheld, aspect);
    // Accept a loose solution rather than none: a pixel placed to within a thousandth
    // of the frame is still a usable label. Beyond that, say so.
    if (Math.abs(targetU - fu) < 1e-3 && Math.abs(targetV - fv) < 1e-3) return [u, v];
    return null;
}

/**
 * Pixel-space wrapper: where a point in the rendered frame lands in the filtered frame.
 * Both are in the usual image convention, x right and y DOWN from the top left.
 */
export function mapSourceToOutputPixels(x, y, screen, handheld, width, height) {
    const solved = inverseScreenUV(x / width, 1 - y / height, screen, handheld, width / height);
    if (!solved) return null;
    return {x: solved[0] * width, y: (1 - solved[1]) * height};
}
