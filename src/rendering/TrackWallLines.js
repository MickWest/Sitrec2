// Screen-spaced vertical lines on a track's extend-to-ground wall.
//
// A wall normally gets one line per wall point, which suits sparse imported
// data. A per-frame track has a point every few meters, so its lines merge
// into a solid sheet. Here the lines are drawn in the wall's fragment shader
// at power-of-two steps of distance along the track. Each pixel uses the finest
// step that is at least `spacing` display pixels wide, and that level fades in
// as its spacing grows from `spacing` to twice that, where the next finer
// level starts. The same idea as the ground grid's line fade.
//
// The wall geometry must carry a `wallU` vec2 attribute:
//   x = distance along the track in meters (positions the lines)
//   y = the same distance, measured from the start of the vertex's own quad
// The screen-space derivative comes from y. At 500 km along a track, float32
// steps x by 0.06 m, which is too coarse to difference between two pixels.

const VERTEX_PARS = `
attribute vec2 wallU;
varying vec2 vWallU;
`;

const FRAGMENT_PARS = `
uniform vec3 wallLineColor;
uniform float wallLineOpacity;
uniform float wallLineSpacing;
uniform float wallLinePixelScale;
uniform float wallLength;
varying vec2 vWallU;

// Coverage of a line at every multiple of stepM, for a pixel mPerPx wide.
float wallLineCoverage(float u, float stepM, float mPerPx, float halfPx) {
    float d = abs(u - stepM * floor(u / stepM + 0.5));
    return 1.0 - smoothstep(halfPx - 0.5, halfPx + 0.5, d / mPerPx);
}
`;

const FRAGMENT_MAIN = `
{
    float wallMPerPx = max(length(vec2(dFdx(vWallU.y), dFdy(vWallU.y))), 1e-9);
    float wallHalfPx = 0.5 * wallLinePixelScale;
    float wallMinStep = wallLineSpacing * wallLinePixelScale * wallMPerPx;
    float wallFineStep = exp2(ceil(log2(wallMinStep)));
    float wallFade = clamp(wallFineStep / wallMinStep - 1.0, 0.0, 1.0);
    float wallLine = max(
        wallLineCoverage(vWallU.x, 2.0 * wallFineStep, wallMPerPx, wallHalfPx),
        wallLineCoverage(vWallU.x, wallFineStep, wallMPerPx, wallHalfPx) * wallFade);
    // Both ends of the wall always have a line, drawn fully inside the wall.
    float wallEndPx = min(vWallU.x, wallLength - vWallU.x) / wallMPerPx;
    wallLine = max(wallLine, 1.0 - smoothstep(2.0 * wallHalfPx - 0.5, 2.0 * wallHalfPx + 0.5, wallEndPx));
    wallLine *= wallLineOpacity;
    float wallAlpha = wallLine + gl_FragColor.a * (1.0 - wallLine);
    gl_FragColor = vec4((wallLineColor * wallLine + gl_FragColor.rgb * gl_FragColor.a * (1.0 - wallLine))
        / max(wallAlpha, 1e-6), wallAlpha);
}
`;

const VERTEX_ANCHOR = "#include <begin_vertex>";
const FRAGMENT_ANCHOR = "#include <dithering_fragment>";

function insertBefore(source, anchor, code) {
    if (!source.includes(anchor)) throw new Error("Unsupported Three.js mesh shader: missing " + anchor);
    return source.replace(anchor, code + anchor);
}

// Returns the shader source with the wall lines added. Split out so a Three.js
// upgrade that renames an anchor chunk fails a unit test, not silently on screen.
export function patchTrackWallLineShader({vertexShader, fragmentShader}) {
    return {
        vertexShader: VERTEX_PARS + insertBefore(vertexShader, VERTEX_ANCHOR, "vWallU = wallU;\n"),
        fragmentShader: FRAGMENT_PARS + insertBefore(fragmentShader, FRAGMENT_ANCHOR, FRAGMENT_MAIN),
    };
}

/**
 * Add the lines to a stock mesh material (MeshBasicMaterial and similar).
 * Call it before any other onBeforeCompile wrapper: the lines must be composited
 * before the output color conversion.
 * @param {Material} material
 * @param {object} options
 * @param {Color} options.color - line color
 * @param {number} options.opacity - line opacity
 * @param {number} options.spacing - minimum distance between lines, in display pixels
 * @param {number} options.length - wall length in meters (the largest wallU.x)
 * @param {function} options.pixelScale - (renderer) => render pixels per display pixel
 */
export function installTrackWallLines(material, {color, opacity, spacing, length, pixelScale}) {
    const uniforms = {
        wallLineColor: {value: color},
        wallLineOpacity: {value: opacity},
        wallLineSpacing: {value: spacing},
        wallLinePixelScale: {value: 1},
        wallLength: {value: length},
    };
    material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        Object.assign(shader, patchTrackWallLineShader(shader));
    };
    // Three's default key is the onBeforeCompile source text. Later wrappers
    // all share one source, so without an own key this material would share a
    // program with every plain wall.
    material.customProgramCacheKey = () => "sitrecTrackWallLines.v1";
    // Each view draws at its own scale (DPR, render scale, export size).
    material.onBeforeRender = (renderer) => {
        uniforms.wallLinePixelScale.value = pixelScale(renderer);
    };
    return material;
}
