// Pixel weights for unresolved point sprites. The quadratic B-spline translates
// smoothly and sums to one over the pixel grid at every subpixel position.
export const STABLE_POINT_SAMPLING_GLSL = `
float pointPixelWeight(float offset) {
    float x = abs(offset);
    if (x < 0.5) return 0.75 - x * x;
    float tail = max(1.5 - x, 0.0);
    return 0.5 * tail * tail;
}

float stablePointAlpha(vec2 pixelOffset, float sourceSize, float coreRadius) {
    // Integral of the existing smooth-edged disc, expressed per diameter squared.
    // Carry this light in coverage rather than letting the GPU round a tiny
    // sprite up to a full-brightness pixel (or sample outside its disc entirely).
    float core = clamp(coreRadius, 0.0, 1.0);
    float area = 0.7853981633974483 * (0.3 + 0.4 * core + 0.3 * core * core)
        * sourceSize * sourceSize;
    float unresolved = area * pointPixelWeight(pixelOffset.x) * pointPixelWeight(pixelOffset.y);
    if (sourceSize <= 2.0) return unresolved;

    float dist = length(pixelOffset) * 2.0 / sourceSize;
    float resolved = 1.0 - smoothstep(coreRadius, 1.0, dist);
    // Keep the existing profile for resolved points, with no hard size threshold.
    return mix(unresolved, resolved, smoothstep(2.0, 3.0, sourceSize));
}
`;
