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
 * How much of the camera's frame the screen covers, from the physical setup.
 *
 * The screen's half-width subtends atan((W/2)/D) at the lens; the frame's half-width
 * subtends hfov/2. The ratio of their tangents is the fraction of the frame width the
 * screen occupies - above 1 the screen overflows the frame and the picture is cropped,
 * below 1 the dark room is visible around it.
 *
 * Vertically the screen is (W / screenAspect) tall and the frame's half-height tangent is
 * tan(hfov/2)/cameraAspect, which is where the second factor comes from.
 *
 * @param {object} screen        the screen settings (hfov, cameraAspect, screenWidthM, screenDistanceM)
 * @param {number} screenAspect  aspect of the picture being displayed on that screen
 */
export function screenFill(screen, screenAspect) {
    const hfov = Math.min(Math.max(screen.hfov ?? 65, 1), 170) * Math.PI / 180;
    const cameraAspect = Math.max(screen.cameraAspect ?? 16 / 9, 0.05);
    const width = Math.max(screen.screenWidthM ?? 1.2, 0.001);
    const distance = Math.max(screen.screenDistanceM ?? 0.9, 0.01);

    const fillX = (width / 2 / distance) / Math.tan(hfov / 2);
    return {
        cameraAspect,
        fillX,
        fillY: fillX * cameraAspect / Math.max(screenAspect, 0.05),
    };
}

// How the camera's frame sits inside the output raster when their aspects differ.
function frameFit(cameraAspect, outputAspect) {
    return cameraAspect > outputAspect
        ? {fitX: 1, fitY: outputAspect / cameraAspect}
        : {fitX: cameraAspect / outputAspect, fitY: 1};
}

/**
 * Where an output pixel samples from, in the screen's uv. Output -> screen, matching the
 * shader. Points outside 0..1 fall on the dark room behind the screen, or on the
 * letterbox bar beside the camera's frame.
 *
 * @param {number} u,v           output position, 0-1, v up
 * @param {object} screen        the screen settings
 * @param {number[]} handheld    [offsetX, offsetY, rotation, extra zoom] for this frame
 * @param {number} outputAspect  output raster width / height
 * @param {number} screenAspect  aspect of the picture on the screen
 */
export function forwardScreenUV(u, v, screen, handheld, outputAspect, screenAspect) {
    const {cameraAspect, fillX, fillY} = screenFill(screen, screenAspect);
    const {fitX, fitY} = frameFit(cameraAspect, outputAspect);

    // Output raster -> camera frame.
    const cx = (u - 0.5) / fitX;
    const cy = (v - 0.5) / fitY;

    // Isotropic camera space, so rotation and barrel stay circular.
    let px = cx * cameraAspect;
    let py = cy;

    px -= handheld[0];
    py -= handheld[1];

    const sn = Math.sin(-handheld[2]);
    const cs = Math.cos(-handheld[2]);
    [px, py] = [px * cs - py * sn, px * sn + py * cs];

    const r2 = px * px + py * py;
    const barrel = 1 + screen.barrel * r2 + screen.barrel * 0.35 * r2 * r2;
    px /= barrel;
    py /= barrel;

    px *= 1 + screen.keystone * py;
    py *= 1 + screen.keystone * 0.35 * px;

    // Camera frame -> the screen in it.
    const zoom = Math.max(handheld[3], 0.01);
    const spanX = Math.max(fillX * zoom, 0.001);
    const spanY = Math.max(fillY * zoom, 0.001);
    return [0.5 + (px / cameraAspect) / spanX, 0.5 + py / spanY];
}

/**
 * The inverse: where a point on the screen ends up in the output frame.
 *
 * Solved by iteration rather than algebraically - the forward map composes a rotation, a
 * radial division and two shears. The step is scaled by the forward map's own approximate
 * gain, because without that the iteration diverges as soon as the screen covers much
 * less than the frame: a plain unit step assumes the map is close to the identity, and a
 * camera standing well back makes it anything but.
 *
 * Returns null if it does not settle, which happens only for points far outside the
 * frame, where there is no sensible answer anyway.
 */
export function inverseScreenUV(targetU, targetV, screen, handheld, outputAspect, screenAspect, tolerance = 1e-6) {
    const {cameraAspect, fillX, fillY} = screenFill(screen, screenAspect);
    const {fitX, fitY} = frameFit(cameraAspect, outputAspect);
    const zoom = Math.max(handheld[3], 0.01);
    const gainU = fitX * Math.max(fillX * zoom, 0.001);
    const gainV = fitY * Math.max(fillY * zoom, 0.001);

    let u = targetU;
    let v = targetV;
    for (let i = 0; i < 40; i++) {
        const [fu, fv] = forwardScreenUV(u, v, screen, handheld, outputAspect, screenAspect);
        const du = targetU - fu;
        const dv = targetV - fv;
        if (Math.abs(du) < tolerance && Math.abs(dv) < tolerance) return [u, v];
        u += du * gainU;
        v += dv * gainV;
    }
    const [fu, fv] = forwardScreenUV(u, v, screen, handheld, outputAspect, screenAspect);
    // Accept a loose solution rather than none: a pixel placed to within a thousandth of
    // the frame is still a usable label. Beyond that, say so.
    if (Math.abs(targetU - fu) < 1e-3 && Math.abs(targetV - fv) < 1e-3) return [u, v];
    return null;
}

/**
 * Pixel-space wrapper: where a point in the rendered frame lands in the filtered frame.
 * Both are in the usual image convention, x right and y DOWN from the top left.
 */
export function mapSourceToOutputPixels(x, y, screen, handheld, width, height) {
    const aspect = width / height;
    // The rendered frame IS what the screen is showing, so it sets the screen's aspect.
    const solved = inverseScreenUV(x / width, 1 - y / height, screen, handheld, aspect, aspect);
    if (!solved) return null;
    return {x: solved[0] * width, y: (1 - solved[1]) * height};
}
