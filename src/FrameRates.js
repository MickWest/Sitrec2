// Round to a "clean" fps value if very close to an integer / NTSC
// rate: the NEAREST standard rate within 1 % (30.02 → 30, 29.96 → 29.97,
// 23.97 → 23.976). Avoids showing "29.9603 fps" when the video is really 29.97.
export function snapFps(fps) {
    const candidates = [12, 15, 23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
    let nearest = null;
    for (const c of candidates) {
        const error = Math.abs(fps - c) / c;
        if (error < 0.01 && (nearest === null || error < nearest.error)) nearest = {c, error};
    }
    if (nearest) return nearest.c;
    // Fall back to integer when within 0.5 %; otherwise keep the
    // computed value but trim to 3 decimals.
    const rounded = Math.round(fps);
    if (Math.abs(fps - rounded) / rounded < 0.005) return rounded;
    return Math.round(fps * 1000) / 1000;
}
