// All passes use GLSL 3 and explicit outputs. No color-space or tone-map transform
// is allowed on physical textures. Scalar values occupy R; complex FFT values RG.
export const fullscreenVertex = `
    out vec2 vUv; // normalized texture coordinates
    void main() { vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }
`;

export const radianceVertex = `
    #include <common>
    #include <morphtarget_pars_vertex>
    #include <skinning_pars_vertex>
    #include <logdepthbuf_pars_vertex>
    out vec3 vViewPosition; // camera-relative position, m
    out vec3 vProjectedPosition; // apparent camera-relative position, m
    out vec3 vViewNormal; // unitless surface normal in camera coordinates
    void main() {
        #include <beginnormal_vertex>
        #include <morphinstance_vertex>
        #include <morphnormal_vertex>
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <defaultnormal_vertex>
        vViewNormal = transformedNormal;
        #include <begin_vertex>
        #include <morphtarget_vertex>
        #include <skinning_vertex>
        #include <project_vertex>
        vViewPosition = mvPosition.xyz;
        vProjectedPosition = mvPosition.xyz;
        #include <logdepthbuf_vertex>
    }
`;

export const radianceFragment = `
    #include <logdepthbuf_pars_fragment>
    uniform sampler2D rangeTexture; // RG: thermal+environment, reflected normal-incidence sun; scaled photon radiance
    uniform float rangeMaxM; // m, quadratic table endpoint
    uniform int rangeSamples; // texel count, unitless
    uniform vec3 sunViewDirection; // normalized camera-space direction toward sun
    uniform float transmittance; // thin-layer transmittance, unitless; 0 = opaque
    uniform int innerRow; // texture row for back faces: 1 = a thin shell's inner side, 0 = same as front
    uniform vec4 diffuser; // x scattered transmittance, y reflectance, z forward-lobe fraction, w lobe Gaussian sigma (rad)
    uniform vec4 glowSource; // xyz flame center in camera space (m); w in-band intensity at the sensor (scaled photon radiance x m^2); 0 = none
    uniform int environmentRow; // first of five reflected-environment rows by normal elevation (sine -1, -0.5, 0, 0.5, 1); 0 = none
    uniform vec3 upView; // local up in camera space
    in vec3 vViewPosition; // m
    in vec3 vViewNormal; // unitless
    out vec4 result; // R: scaled photon radiance; G/B unused; A = 1 - transmittance (premultiplied blend weight)
    void main() {
        #include <logdepthbuf_fragment>
        float position = (rangeMaxM > 0.0 ? sqrt(clamp(length(vViewPosition) / rangeMaxM, 0.0, 1.0)) : 0.0) * float(rangeSamples - 1);
        int lower = min(rangeSamples - 2, int(floor(position)));
        // Back faces use innerRow. Three.js draws a transparent double-sided material as a BackSide pass (FLIP_SIDED,
        // with the winding reversed, so gl_FrontFacing is true there) and then a FrontSide pass.
        #if defined(FLIP_SIDED)
            int row = innerRow;
        #elif defined(DOUBLE_SIDED)
            int row = gl_FrontFacing ? 0 : innerRow;
        #else
            int row = 0;
        #endif
        vec2 source = mix(texelFetch(rangeTexture, ivec2(lower, row), 0).rg,
            texelFetch(rangeTexture, ivec2(lower + 1, row), 0).rg, position - float(lower));
        vec3 normal = normalize(vViewNormal) * (gl_FrontFacing ? 1.0 : -1.0);
        float radiance = source.r + source.g * max(0.0, dot(normal, sunViewDirection));
        if (environmentRow > 0 && row == 0) {
            // Sky and ground: the outer face reflects the environment for its orientation (linear in the normal's up sine).
            float x = (clamp(dot(normal, upView), -1.0, 1.0) + 1.0) * 2.0;
            int k = min(3, int(floor(x)));
            float fraction = position - float(lower);
            float a = mix(texelFetch(rangeTexture, ivec2(lower, environmentRow + k), 0).r,
                texelFetch(rangeTexture, ivec2(lower + 1, environmentRow + k), 0).r, fraction);
            float b = mix(texelFetch(rangeTexture, ivec2(lower, environmentRow + k + 1), 0).r,
                texelFetch(rangeTexture, ivec2(lower + 1, environmentRow + k + 1), 0).r, fraction);
            radiance += mix(a, b, x - float(k));
        }
        if (glowSource.w > 0.0) {
            // A flame inside a scattering shell lights the inside of each wall: E = I cos(incidence) / d^2. The outer
            // face shows the scattered transmission (a Lambertian part and a forward lobe around the flame direction);
            // the inner face reflects it diffusely. The camera-facing normal is outward on the outer face.
            vec3 toward = vViewPosition - glowSource.xyz;
            float d2 = max(dot(toward, toward), 1e-4);
            vec3 ray = toward * inversesqrt(d2);
            bool inner = innerRow > 0 && row == innerRow;
            vec3 outward = inner ? -normal : normal;
            float irradiance = glowSource.w * max(dot(outward, ray), 0.0) / d2;
            if (inner) radiance += diffuser.y * irradiance / 3.14159265;
            else {
                vec3 view = normalize(-vViewPosition);
                float psi = acos(clamp(dot(ray, view), -1.0, 1.0)), sigma2 = max(diffuser.w * diffuser.w, 1e-6);
                float lobe = exp(-0.5 * psi * psi / sigma2) / (6.28318531 * sigma2) / max(dot(normal, view), 0.05);
                radiance += diffuser.x * irradiance * ((1.0 - diffuser.z) / 3.14159265 + diffuser.z * lobe);
            }
        }
        result = vec4(radiance, 0.0, 0.0, 1.0 - transmittance);
    }
`;

// Terrain colors supply an explicitly estimated temperature, before atmospheric
// transfer, optics and detection. The source map keeps its normal UV transform
// and color-space decoding; lighting, tone mapping and display polarity are absent.
export const terrainRadianceVertex = radianceVertex
    .replace("#include <common>", "#include <common>\n#include <uv_pars_vertex>\n#include <color_pars_vertex>\n#ifdef GROUND_MASK\nout vec3 vWorldPosition; // ECEF, m\n#endif")
    .replace("void main() {", "void main() {\n#include <uv_vertex>\n#include <color_vertex>")
    .replace("vViewPosition = mvPosition.xyz;", "vViewPosition = mvPosition.xyz;\n#ifdef GROUND_MASK\nvWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#endif");
export const terrainRadianceFragment = `
    #include <logdepthbuf_pars_fragment>
    #include <uv_pars_fragment>
    #include <color_pars_fragment>
    uniform sampler2D terrainMap; // unlit terrain RGB, decoded to linear by the renderer
    uniform vec3 terrainColor; // linear material color
    uniform sampler2D rangeTexture; // RG: thermal+environment and reflected sunlight, rows ordered by temperature
    uniform float rangeMaxM; // m
    uniform int rangeSamples; // samples per temperature row
    uniform int temperatureSamples; // temperature rows
    uniform vec3 sunViewDirection; // camera-space direction toward the Sun
    uniform sampler2D groundMask; // R road, G building footprint, B paved path: covered fraction
    uniform vec4 groundMaskRect; // Web Mercator x0, y0 and texels-to-unit scales of the mask square
    uniform vec3 upView; // local up in camera space
    uniform vec2 ellipsoid; // equatorial radius (m), first eccentricity squared
    in vec3 vViewPosition; // m
    in vec3 vViewNormal;
    #ifdef GROUND_MASK
        in vec3 vWorldPosition; // ECEF, m
    #endif
    out vec4 result; // R: scaled photon radiance
    vec2 rangeSource(int lower, float fraction, int row) {
        return mix(texelFetch(rangeTexture, ivec2(lower, row), 0).rg,
            texelFetch(rangeTexture, ivec2(lower + 1, row), 0).rg, fraction);
    }
    void main() {
        #include <logdepthbuf_fragment>
        vec3 color = terrainColor;
        #ifdef USE_MAP
            color *= texture(terrainMap, vMapUv).rgb;
        #endif
        #if defined(USE_COLOR) || defined(USE_COLOR_ALPHA)
            color *= vColor.rgb;
        #endif
        vec3 srgb = sRGBTransferOETF(vec4(clamp(color, 0.0, 1.0), 1.0)).rgb;
        float brightness = clamp(dot(srgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
        float position = (rangeMaxM > 0.0 ? sqrt(clamp(length(vViewPosition) / rangeMaxM, 0.0, 1.0)) : 0.0) * float(rangeSamples - 1);
        int lower = min(rangeSamples - 2, int(floor(position)));
        float fraction = position - float(lower);
        #ifdef MATERIAL_CLASSES
            // Estimated material class weights from the imagery color; rows: grass, trees, asphalt, concrete, roof, soil.
            // Vegetation: the excess-green indices of the 3D-tile tree detector (ExG > 0.10 or ExGR > 0), with soft
            // edges; dark green is tree canopy, lighter green grass. Soil: a red-over-blue cast. The neutral rest by
            // brightness: dark asphalt, mid concrete, bright roof. Shadows and dark roofs read as asphalt, and water as
            // dark or blue; imagery does not measure material.
            vec3 chroma = srgb / (srgb.r + srgb.g + srgb.b + 1e-6);
            float exg = 2.0 * chroma.g - chroma.r - chroma.b;
            float exgr = exg - (1.4 * chroma.r - chroma.g);
            float vegetation = max(smoothstep(-0.03, 0.03, exgr), smoothstep(0.07, 0.13, exg));
            float soil = (1.0 - vegetation) * smoothstep(0.04, 0.10, chroma.r - chroma.b);
            float neutral = 1.0 - vegetation - soil;
            float dark = 1.0 - smoothstep(0.25, 0.45, brightness), bright = smoothstep(0.55, 0.75, brightness);
            float trees = vegetation * (1.0 - smoothstep(0.18, 0.30, brightness));
            float weights[6] = float[6](vegetation - trees, trees, neutral * dark, neutral * (1.0 - dark - bright), neutral * bright, soil);
            #ifdef GROUND_MASK
                // Mapped coverage replaces the color classes where it applies; a road under tree canopy stays trees.
                // Geodetic latitude of a near-surface point, then the Web Mercator square of the mask.
                float lon = atan(vWorldPosition.y, vWorldPosition.x);
                float lat = atan(vWorldPosition.z, length(vWorldPosition.xy) * (1.0 - ellipsoid.y));
                vec2 mercator = vec2(lon * 0.159154943 + 0.5, 0.5 - log(tan(0.785398163 + lat * 0.5)) * 0.159154943);
                vec2 maskUv = vec2(fract(mercator.x - groundMaskRect.x) * groundMaskRect.z, (mercator.y - groundMaskRect.y) * groundMaskRect.w);
                if (all(greaterThanEqual(maskUv, vec2(0.0))) && all(lessThanEqual(maskUv, vec2(1.0)))) {
                    vec3 mapped = texture(groundMask, maskUv).rgb;
                    float road = mapped.r * (1.0 - vegetation), path = mapped.b * (1.0 - vegetation) * (1.0 - road);
                    float roof = mapped.g * (1.0 - road - path), rest = max(0.0, 1.0 - road - path - roof);
                    for (int row = 0; row < 6; row++) weights[row] *= rest;
                    weights[2] += road; weights[3] += path; weights[4] += roof;
                }
            #endif
            #ifdef BUILDING_SURFACES
                // 3D buildings: walls are concrete. Up-facing surfaces keep the color and mapped classes, because
                // photogrammetric tiles carry streets and fields in the same meshes as roofs.
                // The geometric normal from screen-space derivatives: photogrammetric tiles often carry no normals.
                vec3 facet = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
                if (dot(facet, vViewPosition) > 0.0) facet = -facet;
                float up = dot(facet, upView);
                // Steep facets of tree canopy in the same meshes stay vegetation.
                float wall = (1.0 - smoothstep(0.5, 0.8, up)) * (1.0 - vegetation);
                for (int row = 0; row < 6; row++) weights[row] *= 1.0 - wall;
                weights[3] += wall;
            #endif
            vec2 source = vec2(0.0);
            for (int row = 0; row < 6; row++) source += weights[row] * rangeSource(lower, fraction, min(row, temperatureSamples - 1));
        #else
            // Estimated T = reference + span * (0.5 - sRGB luminance).
            float row = (1.0 - brightness) * float(temperatureSamples - 1);
            int lowerRow = min(temperatureSamples - 2, int(floor(row)));
            vec2 source = mix(rangeSource(lower, fraction, lowerRow),
                rangeSource(lower, fraction, lowerRow + 1), row - float(lowerRow));
        #endif
        vec3 normal = normalize(vViewNormal) * (gl_FrontFacing ? 1.0 : -1.0);
        result = vec4(source.r + source.g * max(0.0, dot(normal, sunViewDirection)), 0.0, 0.0, 1.0);
    }
`;

// sourceSize and offset are texels; background has the same units as tInput.
// Box averaging conserves sum × sample area. Used for coverage and diagnostics.
export const averageFragment = `
    uniform sampler2D tInput; // R: scaled photon radiance
    uniform int factor; // fine samples per output side, unitless
    uniform ivec2 outputOrigin; // output viewport lower-left, pixels
    uniform float fillFactor; // active area / geometric area, unitless
    out vec4 result; // R: area-averaged scaled photon radiance
    void main() {
        ivec2 pixel = ivec2(gl_FragCoord.xy) - outputOrigin;
        float halfSide = 0.5 * sqrt(fillFactor) * float(factor);
        float total = 0.0;
        for (int row = 0; row < 128; row++) {
            if (row >= factor) break;
            float rowCenter = float(row) + 0.5 - float(factor) * 0.5;
            float height = max(0.0, min(rowCenter + 0.5, halfSide) - max(rowCenter - 0.5, -halfSide));
            for (int column = 0; column < 128; column++) {
                if (column >= factor) break;
                float center = float(column) + 0.5 - float(factor) * 0.5;
                float width = max(0.0, min(center + 0.5, halfSide) - max(center - 0.5, -halfSide));
                total += texelFetch(tInput, pixel * factor + ivec2(column, row), 0).r * width * height;
            }
        }
        result = vec4(total / (float(factor * factor) * fillFactor), 0.0, 0.0, 1.0);
    }
`;

export const fftPrepareFragment = `
    uniform sampler2D tInput; // scalar radiance or normalized kernel, or complex spectrum for inverse
    uniform ivec2 fftSize; // padded pixels, powers of two
    uniform ivec2 sourceSize; // source pixels
    uniform ivec2 kernelCenter; // kernel origin in pixels
    uniform int mode; // 0=image contrast, 1=centered kernel, 2=complex inverse input
    uniform float background; // scaled photon radiance, subtracted only for mode 0
    out vec4 result; // RG: real/imaginary, same units as tInput
    int reverseBits(int value, int size) {
        int reversed = 0;
        for (int bit = 1; bit < size; bit *= 2) {
            reversed = reversed * 2 + value % 2;
            value /= 2;
        }
        return reversed;
    }
    void main() {
        ivec2 pixel = ivec2(gl_FragCoord.xy);
        ivec2 samplePixel = ivec2(reverseBits(pixel.x, fftSize.x), reverseBits(pixel.y, fftSize.y));
        vec2 value = vec2(0.0);
        if (mode == 2) value = texelFetch(tInput, samplePixel, 0).rg;
        else {
            if (mode == 1) samplePixel = (samplePixel + kernelCenter) % fftSize;
            if (all(lessThan(samplePixel, sourceSize))) {
                value.r = texelFetch(tInput, samplePixel, 0).r - (mode == 0 ? background : 0.0);
            }
        }
        result = vec4(value, 0.0, 1.0);
    }
`;
export const fftButterflyFragment = `
    uniform sampler2D tInput; // RG complex radiance or kernel spectrum
    uniform int axis; // 0=horizontal, 1=vertical
    uniform int span; // samples per butterfly block
    uniform bool inverse; // true: positive phase and divide by two per stage
    out vec4 result; // RG complex spectrum or spatial radiance
    void main() {
        ivec2 pixel = ivec2(gl_FragCoord.xy);
        int coordinate = axis == 0 ? pixel.x : pixel.y;
        int halfSpan = span / 2;
        int offset = coordinate % halfSpan;
        int base = coordinate / span * span;
        ivec2 lower = pixel;
        if (axis == 0) lower.x = base + offset; else lower.y = base + offset;
        ivec2 upper = lower + (axis == 0 ? ivec2(halfSpan, 0) : ivec2(0, halfSpan));
        vec2 even = texelFetch(tInput, lower, 0).rg;
        vec2 odd = texelFetch(tInput, upper, 0).rg;
        float phase = (inverse ? 1.0 : -1.0) * 6.283185307179586 * float(offset) / float(span);
        vec2 rotation = vec2(cos(phase), sin(phase));
        vec2 rotated = vec2(odd.x * rotation.x - odd.y * rotation.y, odd.x * rotation.y + odd.y * rotation.x);
        vec2 value = even + (coordinate % span < halfSpan ? rotated : -rotated);
        result = vec4(value * (inverse ? 0.5 : 1.0), 0.0, 1.0);
    }
`;
export const multiplyFragment = `
    uniform sampler2D tInput; // RG: complex photon-radiance spectrum
    uniform sampler2D tKernel; // RG: dimensionless optical transfer function
    out vec4 result; // RG: filtered complex radiance
    void main() {
        ivec2 pixel = ivec2(gl_FragCoord.xy);
        vec2 source = texelFetch(tInput, pixel, 0).rg;
        vec2 kernel = texelFetch(tKernel, pixel, 0).rg;
        result = vec4(source.x * kernel.x - source.y * kernel.y,
            source.x * kernel.y + source.y * kernel.x, 0.0, 1.0);
    }
`;
// The same two-stage DIT butterfly as the packed variant, specialized to a single RG complex image.
export const fftButterfly4Fragment = `
    uniform sampler2D tInput;
    uniform int axis;
    uniform int span;
    uniform bool inverse;
    out vec4 result;
    vec2 rotate(vec2 value, vec2 rotation) {
        return vec2(value.x * rotation.x - value.y * rotation.y, value.x * rotation.y + value.y * rotation.x);
    }
    void main() {
        ivec2 pixel = ivec2(gl_FragCoord.xy);
        int coordinate = axis == 0 ? pixel.x : pixel.y;
        int quarter = span / 4;
        int base = coordinate / span * span;
        int offset = coordinate - base;
        int r = offset % quarter, t = offset / quarter;
        ivec2 step = axis == 0 ? ivec2(quarter, 0) : ivec2(0, quarter);
        ivec2 first = pixel;
        if (axis == 0) first.x = base + r; else first.y = base + r;
        vec2 a0 = texelFetch(tInput, first, 0).rg, a1 = texelFetch(tInput, first + step, 0).rg;
        vec2 a2 = texelFetch(tInput, first + 2 * step, 0).rg, a3 = texelFetch(tInput, first + 3 * step, 0).rg;
        float direction = inverse ? 1.0 : -1.0;
        float phase1 = direction * 6.283185307179586 * float(r) / float(2 * quarter);
        float phase2 = direction * 6.283185307179586 * float(r) / float(span);
        vec2 w1 = vec2(cos(phase1), sin(phase1)), w2 = vec2(cos(phase2), sin(phase2));
        bool odd = t == 1 || t == 3;
        vec2 b1 = rotate(a1, w1), b3 = rotate(a3, w1);
        vec2 y0 = odd ? a0 - b1 : a0 + b1;
        vec2 y2 = odd ? a2 - b3 : a2 + b3;
        vec2 w = odd ? (inverse ? vec2(-w2.y, w2.x) : vec2(w2.y, -w2.x)) : w2;
        vec2 z = rotate(y2, w);
        result = vec4((t < 2 ? y0 + z : y0 - z) * (inverse ? 0.25 : 1.0), 0.0, 1.0);
    }
`;
// Packed overlap-add near convolution (nearConvolutionPlan in ThermalPipeline.js). Up to four image tiles share one
// RGBA FFT: R and G are the real and imaginary parts of one complex image (tiles (0,0) and (1,0)), B and A of another
// (tiles (0,1) and (1,1)). The optical kernel is real, so each channel of the inverse transform is one tile's linear
// convolution. The reference shaders above are unchanged.
const packedReverseBits = `
    int reverseBits(int value, int size) {
        int reversed = 0;
        for (int bit = 1; bit < size; bit *= 2) {
            reversed = reversed * 2 + value % 2;
            value /= 2;
        }
        return reversed;
    }`;
export const fftPackFragment = `
    uniform sampler2D tInput; // R: radiance contrast, scaled photon radiance
    uniform ivec2 fftSize; // padded pixels, powers of two
    uniform ivec2 sourceSize; // image pixels
    uniform ivec2 sourceOrigin; // cropped contrast origin in the full image, pixels
    uniform ivec2 tileSize; // nominal tile pixels; tile (i, j) starts at (i, j) * tileSize
    uniform ivec2 tiles; // tiles per axis, 1 or 2
    uniform bool naturalOrder;
    out vec4 result; // RGBA: tiles (0,0), (1,0), (0,1), (1,1), zero padded, in bit-reversed order
    ${packedReverseBits}
    float tileValue(ivec2 tile, ivec2 local) {
        ivec2 pixel = tile * tileSize + local;
        if (any(greaterThanEqual(tile, tiles)) || any(greaterThanEqual(local, tileSize)) ||
            any(greaterThanEqual(pixel, sourceSize))) return 0.0;
        return texelFetch(tInput, pixel + sourceOrigin, 0).r;
    }
    void main() {
        ivec2 pixel = ivec2(gl_FragCoord.xy);
        ivec2 local = naturalOrder ? pixel : ivec2(reverseBits(pixel.x, fftSize.x), reverseBits(pixel.y, fftSize.y));
        result = vec4(tileValue(ivec2(0, 0), local), tileValue(ivec2(1, 0), local),
            tileValue(ivec2(0, 1), local), tileValue(ivec2(1, 1), local));
    }
`;
export const fftReversePackedFragment = `
    uniform sampler2D tInput; // RGBA: two complex spectra
    uniform ivec2 fftSize; // padded pixels, powers of two
    out vec4 result; // RGBA: the same spectra in bit-reversed order
    ${packedReverseBits}
    void main() {
        ivec2 pixel = ivec2(gl_FragCoord.xy);
        result = texelFetch(tInput, ivec2(reverseBits(pixel.x, fftSize.x), reverseBits(pixel.y, fftSize.y)), 0);
    }
`;
export const fftButterflyPackedFragment = `
    uniform sampler2D tInput; // RGBA: two complex values that share each butterfly
    uniform int axis; // 0=horizontal, 1=vertical
    uniform int span; // samples per butterfly block
    uniform bool inverse; // true: positive phase and divide by two per stage
    out vec4 result; // RGBA: two complex spectra or tile convolutions
    vec2 rotate(vec2 value, vec2 rotation) {
        return vec2(value.x * rotation.x - value.y * rotation.y, value.x * rotation.y + value.y * rotation.x);
    }
    void main() {
        ivec2 pixel = ivec2(gl_FragCoord.xy);
        int coordinate = axis == 0 ? pixel.x : pixel.y;
        int halfSpan = span / 2;
        int offset = coordinate % halfSpan;
        int base = coordinate / span * span;
        ivec2 lower = pixel;
        if (axis == 0) lower.x = base + offset; else lower.y = base + offset;
        ivec2 upper = lower + (axis == 0 ? ivec2(halfSpan, 0) : ivec2(0, halfSpan));
        vec4 even = texelFetch(tInput, lower, 0);
        vec4 odd = texelFetch(tInput, upper, 0);
        float phase = (inverse ? 1.0 : -1.0) * 6.283185307179586 * float(offset) / float(span);
        vec2 rotation = vec2(cos(phase), sin(phase));
        vec4 rotated = vec4(rotate(odd.xy, rotation), rotate(odd.zw, rotation));
        vec4 value = even + (coordinate % span < halfSpan ? rotated : -rotated);
        result = value * (inverse ? 0.5 : 1.0);
    }
`;
// Two consecutive radix-2 stages of fftButterflyPackedFragment (block sizes span / 2 and span) in one pass. With
// q = span / 4, an output at block offset r + q·t (t = 0..3) reads the four values at r, r + q, r + 2q, r + 3q. The
// first stage pairs them with twiddle W(span / 2)^r; the second with W(span)^r, times ∓i for t = 1 and 3, because
// W(span)^(r + q) = W(span)^r · W(span)^q and W(span)^q = ∓i. Inverse passes divide by 4 (2 per stage).
export const fftButterfly4PackedFragment = `
    uniform sampler2D tInput; // RGBA: two complex values that share each butterfly
    uniform int axis; // 0=horizontal, 1=vertical
    uniform int span; // samples per block after both stages; a power of two >= 4
    uniform bool inverse; // true: positive phase and divide by four
    out vec4 result; // RGBA: two complex spectra or tile convolutions
    vec2 rotate(vec2 value, vec2 rotation) {
        return vec2(value.x * rotation.x - value.y * rotation.y, value.x * rotation.y + value.y * rotation.x);
    }
    vec4 rotatePair(vec4 value, vec2 rotation) { return vec4(rotate(value.xy, rotation), rotate(value.zw, rotation)); }
    void main() {
        ivec2 pixel = ivec2(gl_FragCoord.xy);
        int coordinate = axis == 0 ? pixel.x : pixel.y;
        int quarter = span / 4;
        int base = coordinate / span * span;
        int offset = coordinate - base;
        int r = offset % quarter, t = offset / quarter;
        ivec2 step = axis == 0 ? ivec2(quarter, 0) : ivec2(0, quarter);
        ivec2 first = pixel;
        if (axis == 0) first.x = base + r; else first.y = base + r;
        vec4 a0 = texelFetch(tInput, first, 0), a1 = texelFetch(tInput, first + step, 0);
        vec4 a2 = texelFetch(tInput, first + 2 * step, 0), a3 = texelFetch(tInput, first + 3 * step, 0);
        float direction = inverse ? 1.0 : -1.0;
        float phase1 = direction * 6.283185307179586 * float(r) / float(2 * quarter);
        float phase2 = direction * 6.283185307179586 * float(r) / float(span);
        vec2 w1 = vec2(cos(phase1), sin(phase1)), w2 = vec2(cos(phase2), sin(phase2));
        bool odd = t == 1 || t == 3;
        vec4 b1 = rotatePair(a1, w1), b3 = rotatePair(a3, w1);
        vec4 y0 = odd ? a0 - b1 : a0 + b1;
        vec4 y2 = odd ? a2 - b3 : a2 + b3;
        // w2 times -i (forward) or +i (inverse) for the odd quarters.
        vec2 w = odd ? (inverse ? vec2(-w2.y, w2.x) : vec2(w2.y, -w2.x)) : w2;
        vec4 z = rotatePair(y2, w);
        result = (t < 2 ? y0 + z : y0 - z) * (inverse ? 0.25 : 1.0);
    }
`;
// Two descending decimation-in-frequency stages. Their output is in binary-reversed order, accepted directly
// by the inverse DIT passes after filtering. Horizontal work outside the packed tiles is exactly zero.
export const fftDifPackedFragment = `
    uniform sampler2D tInput;
    uniform int axis;
    uniform int span;
    uniform int sourceRows;
    uniform bool radix4;
    out vec4 result;
    vec2 rotate(vec2 a,vec2 w) {return vec2(a.x*w.x-a.y*w.y,a.x*w.y+a.y*w.x);}
    vec4 pair(vec4 a,vec2 w) {return vec4(rotate(a.xy,w),rotate(a.zw,w));}
    void main() {
        ivec2 pixel=ivec2(gl_FragCoord.xy);
        if(axis==0 && pixel.y>=sourceRows) {result=vec4(0);return;}
        int coordinate=axis==0 ? pixel.x : pixel.y;
        int part=radix4 ? span/4 : span/2;
        int base=coordinate/span*span,offset=(coordinate-base)%part,t=(coordinate-base)/part;
        ivec2 first=pixel,step=axis==0 ? ivec2(part,0) : ivec2(0,part);
        if(axis==0) first.x=base+offset;else first.y=base+offset;
        vec4 a=texelFetch(tInput,first,0),b=texelFetch(tInput,first+step,0);
        float phase=-6.283185307179586*float(offset)/float(span);
        vec2 w=vec2(cos(phase),sin(phase));
        if(!radix4) {result=t==0 ? a+b : pair(a-b,w);return;}
        vec4 c=texelFetch(tInput,first+2*step,0),d=texelFetch(tInput,first+3*step,0);
        vec4 even=a+c,odd=b+d;
        vec2 w2=vec2(cos(2.0*phase),sin(2.0*phase));
        if(t<2) {result=t==0 ? even+odd : pair(even-odd,w2);}
        else {
            vec4 y=pair(a-c,w),z=pair(b-d,vec2(w.y,-w.x));
            result=t==2 ? y+z : pair(y-z,w2);
        }
    }
`;
export const multiplyPackedFragment = `
    uniform sampler2D tInput; // RGBA: two complex photon-radiance spectra
    uniform sampler2D tKernel; // RG: dimensionless optical transfer function
    uniform ivec2 fftSize;
    uniform bool reversedKernel;
    out vec4 result; // RGBA: both spectra filtered
    ${packedReverseBits}
    vec2 product(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
    void main() {
        ivec2 pixel = ivec2(gl_FragCoord.xy);
        vec4 source = texelFetch(tInput, pixel, 0);
        ivec2 kernelPixel = reversedKernel ? ivec2(reverseBits(pixel.x, fftSize.x), reverseBits(pixel.y, fftSize.y)) : pixel;
        vec2 kernel = texelFetch(tKernel, kernelPixel, 0).rg;
        result = vec4(product(source.xy, kernel), product(source.zw, kernel));
    }
`;

// Three descending radix-2 stages. Four sum/difference pairs form the eight-point DFT; its frequency index is
// bit-reversed so the inverse DIT consumes it directly. All storage and arithmetic remain Float32.
export const fftDif8PackedFragment = `
    uniform sampler2D tInput;
    uniform int axis,span,sourceRows;
    out vec4 result;
    vec2 rotate(vec2 a,vec2 w) {return vec2(a.x*w.x-a.y*w.y,a.x*w.y+a.y*w.x);}
    vec4 pair(vec4 a,vec2 w) {return vec4(rotate(a.xy,w),rotate(a.zw,w));}
    vec2 root(int n) {
        n=n%8;
        if(n==0)return vec2(1,0);if(n==1)return vec2(.7071067811865475,-.7071067811865475);
        if(n==2)return vec2(0,-1);if(n==3)return vec2(-.7071067811865475,-.7071067811865475);
        if(n==4)return vec2(-1,0);if(n==5)return vec2(-.7071067811865475,.7071067811865475);
        if(n==6)return vec2(0,1);return vec2(.7071067811865475,.7071067811865475);
    }
    void main() {
        ivec2 pixel=ivec2(gl_FragCoord.xy);
        if(axis==0 && pixel.y>=sourceRows){result=vec4(0);return;}
        int coordinate=axis==0?pixel.x:pixel.y,q=span/8,base=coordinate/span*span;
        int r=(coordinate-base)%q,t=(coordinate-base)/q;
        int k=((t&1)<<2)|(t&2)|((t&4)>>2);
        ivec2 first=pixel,step=axis==0?ivec2(q,0):ivec2(0,q);
        if(axis==0)first.x=base+r;else first.y=base+r;
        vec4 sum=vec4(0);
        for(int j=0;j<4;j++) {
            vec4 a=texelFetch(tInput,first+j*step,0),b=texelFetch(tInput,first+(j+4)*step,0);
            sum+=pair((k&1)==0?a+b:a-b,root(j*k));
        }
        float phase=-6.283185307179586*float(r*k)/float(span);
        result=pair(sum,vec2(cos(phase),sin(phase)));
    }
`;

export const fftInverse8PackedFragment = `
    uniform sampler2D tInput;
    uniform int axis,span;
    out vec4 result;
    vec2 rotate(vec2 a,vec2 w) {return vec2(a.x*w.x-a.y*w.y,a.x*w.y+a.y*w.x);}
    vec4 pair(vec4 a,vec2 w) {return vec4(rotate(a.xy,w),rotate(a.zw,w));}
    vec2 root(int n) {
        n=n%8;
        if(n==0)return vec2(1,0);if(n==1)return vec2(.7071067811865475,.7071067811865475);
        if(n==2)return vec2(0,1);if(n==3)return vec2(-.7071067811865475,.7071067811865475);
        if(n==4)return vec2(-1,0);if(n==5)return vec2(-.7071067811865475,-.7071067811865475);
        if(n==6)return vec2(0,-1);return vec2(.7071067811865475,-.7071067811865475);
    }
    void main() {
        ivec2 pixel=ivec2(gl_FragCoord.xy);
        int coordinate=axis==0?pixel.x:pixel.y,q=span/8,base=coordinate/span*span;
        int r=(coordinate-base)%q,t=(coordinate-base)/q;
        ivec2 first=pixel,step=axis==0?ivec2(q,0):ivec2(0,q);
        if(axis==0)first.x=base+r;else first.y=base+r;
        float phase=6.283185307179586*float(r)/float(span);
        vec2 w=vec2(cos(phase),sin(phase)),power=vec2(1,0);
        vec4 sum=vec4(0);
        for(int k=0;k<8;k++) {
            int j=((k&1)<<2)|(k&2)|((k&4)>>2);
            sum+=pair(texelFetch(tInput,first+j*step,0),rotate(power,root(t*k)));
            power=rotate(power,w);
        }
        result=sum*.125;
    }
`;
export const overlapAddFragment = `
    uniform sampler2D tInput; // RGBA: each channel one tile's linear convolution, wrapped by fftSize
    uniform ivec2 fftSize; // padded pixels
    uniform ivec2 sourceSize; // image pixels
    uniform ivec2 sourceOrigin; // cropped contrast origin in the full image, pixels
    uniform ivec2 tileSize; // nominal tile pixels
    uniform ivec2 tiles; // tiles per axis
    uniform ivec2 reachLow; // kernel support toward lower pixel indices, pixels
    uniform ivec2 reachHigh; // kernel support toward higher pixel indices, pixels
    out vec4 result; // R: radiance contrast after the near optics, scaled photon radiance
    // A tile's convolution is nonzero from reachLow before the tile to reachHigh after it; fftSize >= tile +
    // reachLow + reachHigh, so that range maps to distinct wrapped texels.
    bool covers(ivec2 tile, ivec2 pixel, out ivec2 wrapped) {
        wrapped = ivec2(0);
        if (any(greaterThanEqual(tile, tiles))) return false;
        ivec2 origin = tile * tileSize;
        ivec2 extent = min(tileSize, sourceSize - origin);
        if (any(lessThanEqual(extent, ivec2(0)))) return false;
        ivec2 local = pixel - origin;
        if (any(lessThan(local, -reachLow)) || any(greaterThanEqual(local, extent + reachHigh))) return false;
        wrapped = (local + fftSize) % fftSize;
        return true;
    }
    void main() {
        ivec2 pixel = ivec2(gl_FragCoord.xy) - sourceOrigin, wrapped;
        float sum = 0.0;
        if (covers(ivec2(0, 0), pixel, wrapped)) sum += texelFetch(tInput, wrapped, 0).r;
        if (covers(ivec2(1, 0), pixel, wrapped)) sum += texelFetch(tInput, wrapped, 0).g;
        if (covers(ivec2(0, 1), pixel, wrapped)) sum += texelFetch(tInput, wrapped, 0).b;
        if (covers(ivec2(1, 1), pixel, wrapped)) sum += texelFetch(tInput, wrapped, 0).a;
        result = vec4(sum, 0.0, 0.0, 1.0);
    }
`;
export const cropFragment = `
    uniform sampler2D tInput; // RG: inverse FFT; real part is radiance contrast
    uniform float background; // scaled photon radiance to restore
    out vec4 result; // R: scaled photon radiance
    void main() { result = vec4(max(0.0, texelFetch(tInput, ivec2(gl_FragCoord.xy), 0).r + background), 0.0, 0.0, 1.0); }
`;
export const copyFragment = `
    uniform sampler2D tInput; // RGBA copied without unit conversion
    out vec4 result; // same units and channels as input
    void main() { result = texelFetch(tInput, ivec2(gl_FragCoord.xy), 0); }
`;

export const detectorFragment = `
    uniform sampler2D tInput; // R: native-grid scaled photon radiance
    uniform sampler2D tFixedPattern; // R: fixed offset in ADC counts, no frame dependence
    uniform ivec2 imageSize; // native detector pixels, before digital zoom
    uniform float shadingAmplitude; // dL/dT at 300 K times edge-minus-center K, scaled radiance
    uniform float shadingWidth; // detector half-widths
    uniform float exposureFactor; // electrons/pixel/exposure per scaled photon radiance unit
    uniform float darkCharge; // electrons/pixel/exposure
    uniform float wellElectrons; // electrons/pixel
    uniform float adcOffsetCounts; // electronic pedestal, raw counts retain it
    uniform float readSigma; // electrons RMS
    uniform bool noiseEnabled; // unitless switch
    uniform bool shotEnabled; // unitless switch
    uniform uint frame; // frame index, unitless
    uniform uint noiseSeed; // unitless seed
    uniform int imageWidth; // native pixels
    out vec4 result; // R: integer-valued 14-bit code [0,16383]
    uint pixelSeed(uint pixel, uint seed) {
        return seed ^ ((pixel + 1u) * 0x85ebca6bu) ^ (frame * 0xc2b2ae35u);
    }
    float randomSequence(inout uint state) {
        state += 0x9e3779b9u;
        uint bits = state;
        bits = (bits ^ (bits >> 16u)) * 0x21f0aaadu;
        bits = (bits ^ (bits >> 15u)) * 0x735a2d97u;
        bits ^= bits >> 15u;
        return (float(bits >> 9u) + 0.5) / 8388608.0;
    }
    float normal(inout uint state) {
        float first = randomSequence(state);
        float second = randomSequence(state);
        return sqrt(-2.0 * log(first)) * cos(6.283185307179586 * second);
    }
    float poisson(float mean, inout uint state) {
        if (mean <= 0.0) return 0.0;
        if (mean >= 64.0) return max(0.0, floor(mean + sqrt(mean) * normal(state) + 0.5));
        float limit = exp(-mean), product = 1.0;
        for (int draw = 0; draw < 512; draw++) {
            product *= randomSequence(state);
            if (product <= limit) return float(draw);
        }
        return 511.0;
    }
    float exposureToElectrons(float radiance) { return max(0.0, radiance * exposureFactor) + darkCharge; }
    float wellLimit(float electrons) { return clamp(electrons, 0.0, wellElectrons); }
    float quantizeADC(float electrons) { return floor(clamp(electrons / wellElectrons * 16383.0 + adcOffsetCounts, 0.0, 16383.0) + 0.5); }
    void main() {
        ivec2 pixel = ivec2(gl_FragCoord.xy);
        uint index = uint(pixel.y * imageWidth + pixel.x);
        uint shotState = pixelSeed(index, noiseSeed);
        uint readState = pixelSeed(index, noiseSeed ^ 0xa511e9b3u);
        vec2 radial = (gl_FragCoord.xy - vec2(imageSize) * 0.5) / (float(imageSize.x) * 0.5);
        float shape = (1.0 - exp(-dot(radial, radial) / (2.0 * shadingWidth * shadingWidth))) /
            (1.0 - exp(-1.0 / (2.0 * shadingWidth * shadingWidth)));
        float charge = exposureToElectrons(texelFetch(tInput, pixel, 0).r + shadingAmplitude * shape);
        if (noiseEnabled && shotEnabled) charge = poisson(charge, shotState);
        charge = wellLimit(charge) - darkCharge;
        if (noiseEnabled) charge += readSigma * normal(readState);
        charge += texelFetch(tFixedPattern, pixel, 0).r * wellElectrons / 16383.0;
        result = vec4(quantizeADC(charge), 0.0, 0.0, 1.0);
    }
`;

// Conservative coarse reduction; subtract sky before zero padding partial cells.
export const scatterReduceFragment = `
    uniform sampler2D tInput; // scaled radiance or contrast
    uniform ivec2 sourceSize; // input samples
    uniform float background; // scaled radiance; zero after the first reduction
    out vec4 result;
    void main() {
        ivec2 origin = ivec2(gl_FragCoord.xy) * 2;
        float value = 0.0;
        for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) {
            ivec2 pixel = origin + ivec2(x, y);
            if (all(lessThan(pixel, sourceSize))) value += texelFetch(tInput, pixel, 0).r - background;
        }
        result = vec4(value * 0.25, 0.0, 0.0, 1.0);
    }
`;
export const farUpsampleFragment = `
    uniform sampler2D tInput; // inverse padded FFT, signed far contrast
    uniform ivec2 fftSize; // coarse FFT samples, with negative offsets at the end
    uniform float factor; // fine samples per coarse sample
    uniform bool haloInput; // packed convolution has an explicit one-pixel coarse border
    out vec4 result; // fine-grid signed far contrast
    float readPixel(ivec2 pixel) { return texelFetch(tInput, haloInput ? pixel+ivec2(1) : (pixel + fftSize) % fftSize, 0).r; }
    void main() {
        vec2 source = gl_FragCoord.xy / factor - 0.5;
        ivec2 lower = ivec2(floor(source));
        vec2 f = fract(source);
        float value = mix(mix(readPixel(lower), readPixel(lower + ivec2(1,0)), f.x),
            mix(readPixel(lower + ivec2(0,1)), readPixel(lower + ivec2(1,1)), f.x), f.y);
        result = vec4(value, 0.0, 0.0, 1.0);
    }
`;
export const contrastFragment = `
    uniform sampler2D tInput, tBackground; // scaled photon radiance
    out vec4 result;
    void main() {
        ivec2 pixel = ivec2(gl_FragCoord.xy);
        result = vec4(texelFetch(tInput, pixel, 0).r - texelFetch(tBackground, pixel, 0).r, 0.0, 0.0, 1.0);
    }
`;
export const opticsSumFragment = `
    uniform sampler2D tInput; // signed fine-grid near contrast
    uniform sampler2D tFar; // signed fine-grid far contrast
    uniform bool hasFar;
    uniform sampler2D tBackground; // per-ray sky restored once, after summing both parts
    out vec4 result;
    void main() {
        ivec2 pixel = ivec2(gl_FragCoord.xy);
        float value = texelFetch(tInput, pixel, 0).r + texelFetch(tBackground, pixel, 0).r;
        if (hasFar) value += texelFetch(tFar, pixel, 0).r;
        result = vec4(max(0.0, value), 0.0, 0.0, 1.0);
    }
`;

// Assemble the packed convolution and integrate the SAME fine samples over the active detector area in one
// native-grid pass. No kernel truncation or reduced sampling; only two intermediate float images are omitted.
export const samplePackedOpticsFragment = overlapAddFragment
    .replace("out vec4 result;", "// output is declared by the detector sampler\n//")
    .replace("void main() {\n        ivec2 pixel = ivec2(gl_FragCoord.xy) - sourceOrigin, wrapped;", "float nearAt(ivec2 pixel) {\n        pixel -= sourceOrigin;\n        ivec2 wrapped;")
    .replace("result = vec4(sum, 0.0, 0.0, 1.0);", "return sum;") + `
    uniform sampler2D tBackground, tFar;
    uniform bool hasFar;
    float radianceAt(ivec2 pixel) {
        float value=nearAt(pixel)+texelFetch(tBackground,pixel,0).r;
        if(hasFar) value+=texelFetch(tFar,pixel,0).r;
        return max(0.0,value);
    }
` + averageFragment.replace("uniform sampler2D tInput; // R: scaled photon radiance", "")
    .replace("texelFetch(tInput, pixel * factor + ivec2(column, row), 0).r", "radianceAt(pixel * factor + ivec2(column, row))");
// Counts remain floating point after temporal averaging; no second ADC rounding.
export const temporalFragment = `
    uniform sampler2D tInput;
    uniform sampler2D tPrevious;
    uniform float memory;
    out vec4 result;
    void main() {
        ivec2 pixel = ivec2(gl_FragCoord.xy);
        float current = texelFetch(tInput, pixel, 0).r;
        float value = memory > 0.0 ? mix(current, texelFetch(tPrevious, pixel, 0).r, memory) : current;
        result = vec4(value, 0.0, 0.0, 1.0);
    }
`;

export const processingFragment = `
    uniform sampler2D tInput; // R: 14-bit counts
    uniform sampler2D tPlateau; // R: normalized CDF, 16384 detector levels in a 256 by 64 texture
    uniform vec2 countWindow; // low/high endpoints in 14-bit counts
    uniform bool usePlateau; // unitless switch, false for constant histograms
    out vec4 result; // R: normalized drive [0,1]
    float windowImage(float counts) { return clamp((counts - countWindow.x) / (countWindow.y - countWindow.x), 0.0, 1.0); }
    float plateauEqualization(float counts) {
        int index = int(floor(clamp(counts, 0.0, 16383.0) + 0.5));
        return texelFetch(tPlateau, ivec2(index % 256, index / 256), 0).r;
    }
    void main() {
        float counts = texelFetch(tInput, ivec2(gl_FragCoord.xy), 0).r;
        result = vec4(usePlateau ? plateauEqualization(counts) : windowImage(counts), 0.0, 0.0, 1.0);
    }
`;
// GPU gain statistics for live views (ThermalPipeline._gpuGain). They compute processingParameters' automatic window
// and plateau table from the frame's own counts with no readback: the same order keys and two 16-bit radix passes
// as percentileCounts (exact values), the same minimum span and AGC dynamics, and plateauLUT's capped histogram.
// Histograms are point scatters with additive float blending; a bin b of a histogram is texel (b % width, b / width).
const gainKeyFunctions = `
    uint countKey(float value) {
        uint word = floatBitsToUint(value);
        return (word & 0x80000000u) != 0u ? ~word : word ^ 0x80000000u;
    }
    float keyCount(uint key) { return uintBitsToFloat((key & 0x80000000u) != 0u ? key ^ 0x80000000u : ~key); }
    // Math.round of the clamped count, exactly: x - floor(x) is exact in float32, so the half-way test cannot round
    // (floor(x + 0.5) put 0.49999997 on level 1).
    int countLevel(float value) {
        float x = clamp(value, 0.0, 16383.0), whole = floor(x);
        return int(whole) + int(x - whole >= 0.5);
    }`;
export const gainScatterVertex = `
    uniform sampler2D tCounts; // R: temporally filtered 14-bit counts
    uniform ivec4 region; // statistics rectangle: left, bottom, width, height in native pixels
    uniform int mode; // 0: high 16 order-key bits; 1: low 16 bits inside the two selected high bins; 2: plateau count level
    uniform sampler2D tSelect; // mode 1: R, B = the high bins that hold the low and high ranks
    uniform ivec2 histogramSize; // texels of one histogram copy
    uniform int copies; // copies stacked vertically in the target; sample i adds to copy i % copies
    ${gainKeyFunctions}
    void main() {
        ivec2 pixel = region.xy + ivec2(gl_VertexID % region.z, gl_VertexID / region.z);
        float value = texelFetch(tCounts, pixel, 0).r;
        int bin = -1;
        if (mode == 2) bin = countLevel(value);
        else {
            uint key = countKey(value);
            int high = int(key >> 16u);
            if (mode == 0) bin = high;
            else {
                vec4 chosen = texelFetch(tSelect, ivec2(0), 0);
                int low = int(key & 65535u);
                // As percentileCounts: a value in both selected bins counts toward the low histogram only.
                if (high == int(chosen.x)) bin = low;
                else if (high == int(chosen.z)) bin = 65536 + low;
            }
        }
        gl_PointSize = 1.0;
        // Copies spread the additive blends: samples of a narrow count range share a few bins, and blends into one
        // texel run one after another (measured live: 18 ms per frame for one copy).
        vec2 texel = vec2(bin % histogramSize.x, bin / histogramSize.x + gl_VertexID % copies * histogramSize.y) + 0.5;
        gl_Position = bin < 0 ? vec4(2.0, 2.0, 2.0, 1.0) :
            vec4(texel / vec2(histogramSize.x, histogramSize.y * copies) * 2.0 - 1.0, 0.0, 1.0);
    }
`;
export const gainCopiesFragment = `
    uniform sampler2D tCopies; // R: histogram copies stacked vertically
    uniform int copies; // copy count
    uniform int height; // rows per copy
    out vec4 result; // R: samples per bin, all copies
    void main() {
        ivec2 texel = ivec2(gl_FragCoord.xy);
        float total = 0.0;
        for (int copy = 0; copy < copies; copy++) total += texelFetch(tCopies, texel + ivec2(0, copy * height), 0).r;
        result = vec4(total, 0.0, 0.0, 1.0);
    }
`;
export const gainScatterFragment = `
    out vec4 result; // R: one sample, summed by additive blending
    void main() { result = vec4(1.0, 0.0, 0.0, 1.0); }
`;
export const gainRowsFragment = `
    uniform sampler2D tHistogram; // R: samples per bin
    uniform int width; // bins per row
    uniform float cap; // plateau cap in samples per bin; zero for none
    out vec4 result; // R: row sum after the cap; G: row sum without it
    void main() {
        int row = int(gl_FragCoord.x);
        float capped = 0.0, raw = 0.0;
        for (int x = 0; x < width; x++) {
            float count = texelFetch(tHistogram, ivec2(x, row), 0).r;
            raw += count; capped += cap > 0.0 ? min(count, cap) : count;
        }
        result = vec4(capped, raw, 0.0, 1.0);
    }
`;
// histogramRank of percentileCounts over rows of 256 bins: the first bin whose count exceeds the remaining rank.
const gainLocate = `
    vec2 locate(float rank, int firstRow, int rows) {
        int row = firstRow;
        for (; row < firstRow + rows - 1; row++) {
            float total = texelFetch(tRows, ivec2(row, 0), 0).g;
            if (rank < total) break;
            rank -= total;
        }
        int x = 0;
        for (; x < 255; x++) {
            float count = texelFetch(tHistogram, ivec2(x, row), 0).r;
            if (rank < count) break;
            rank -= count;
        }
        return vec2(float((row - firstRow) * 256 + x), rank);
    }`;
export const gainSelectFragment = `
    uniform sampler2D tHistogram; // R: samples per high 16-bit key, 256 by 256
    uniform sampler2D tRows; // G: samples per row
    uniform vec2 ranks; // zero-based sample ranks of the low and high percentiles
    out vec4 result; // R: high bin of the low rank, G: rank inside it; B, A: the same for the high rank
    ${gainLocate}
    void main() { result = vec4(locate(ranks.x, 0, 256), locate(ranks.y, 0, 256)); }
`;
export const gainWindowFragment = `
    uniform sampler2D tSelect; // gainSelectFragment output
    uniform sampler2D tHistogram; // R: low 16-bit key counts; rows 0-255 for the low rank's bin, 256-511 for the high's
    uniform sampler2D tRows; // G: samples per row
    uniform sampler2D tPrevious; // RGBA: previous window low, high in counts
    uniform sampler2D tPlateauStats; // B: 1 when the plateau histogram is constant
    uniform bool hasPrevious; // false after a reset: the window is this frame's target
    uniform float alpha; // dimensionless AGC step, as automaticWindow
    uniform bool gainOffset; // agcDynamics "gainOffset" instead of "endpoints"
    uniform float minimumSpan; // counts
    uniform bool usePlateauStats; // plateau gain mode
    out vec4 result; // R, G: window low and high in counts; B: 1 for a constant plateau histogram
    ${gainKeyFunctions}
    ${gainLocate}
    void main() {
        vec4 chosen = texelFetch(tSelect, ivec2(0), 0);
        uint lowKey = (uint(chosen.x) << 16u) | uint(locate(chosen.y, 0, 256).x);
        uint highKey = (uint(chosen.z) << 16u) | uint(locate(chosen.w, chosen.z == chosen.x ? 0 : 256, 256).x);
        // A minimum span (a camera's maximum gain) widens a narrower window equally about its middle.
        float low = keyCount(lowKey), high = keyCount(highKey);
        if (high - low < minimumSpan) { float middle = 0.5 * (low + high); low = middle - 0.5 * minimumSpan; high = middle + 0.5 * minimumSpan; }
        if (hasPrevious) {
            vec4 previous = texelFetch(tPrevious, ivec2(0), 0);
            if (gainOffset) {
                float oldGain = 1.0 / (previous.y - previous.x), targetGain = 1.0 / (high - low);
                float gain = oldGain + alpha * (targetGain - oldGain);
                float offset = -previous.x * oldGain + alpha * (-low * targetGain + previous.x * oldGain);
                low = -offset / gain; high = (1.0 - offset) / gain;
            } else {
                low = previous.x + alpha * (low - previous.x);
                high = previous.y + alpha * (high - previous.y);
            }
        }
        result = vec4(low, high, usePlateauStats ? texelFetch(tPlateauStats, ivec2(0), 0).b : 0.0, 1.0);
    }
`;
export const plateauStatsFragment = `
    uniform sampler2D tHistogram; // R: samples per count level, 256 by 64
    uniform sampler2D tRows; // R: capped, G: raw samples per row
    uniform float cap; // samples per level
    out vec4 result; // R: capped total; G: cumulative value at the first occupied level; B: 1 if constant
    void main() {
        float total = 0.0, before = 0.0;
        int firstRow = -1;
        for (int row = 0; row < 64; row++) {
            vec4 sums = texelFetch(tRows, ivec2(row, 0), 0);
            if (firstRow < 0 && sums.g > 0.0) { firstRow = row; before = total; }
            total += sums.r;
        }
        float first = 0.0;
        if (firstRow >= 0) for (int x = 0; x < 256; x++) {
            float count = texelFetch(tHistogram, ivec2(x, firstRow), 0).r;
            before += min(count, cap);
            if (count > 0.0) { first = before; break; }
        }
        result = vec4(total, first, total <= first ? 1.0 : 0.0, 1.0);
    }
`;
export const plateauTableFragment = `
    uniform sampler2D tHistogram; // R: samples per count level, 256 by 64
    uniform sampler2D tRows; // R: capped samples per row
    uniform sampler2D tStats; // plateauStatsFragment output
    uniform float cap; // samples per level
    out vec4 result; // R: normalized capped cumulative histogram at this level, as plateauLUT
    void main() {
        ivec2 texel = ivec2(gl_FragCoord.xy);
        float cumulative = 0.0;
        for (int row = 0; row < texel.y; row++) cumulative += texelFetch(tRows, ivec2(row, 0), 0).r;
        for (int x = 0; x <= texel.x; x++) cumulative += min(texelFetch(tHistogram, ivec2(x, texel.y), 0).r, cap);
        vec4 stats = texelFetch(tStats, ivec2(0), 0);
        float level = float(texel.y * 256 + texel.x);
        result = vec4(stats.x > stats.y ? clamp((cumulative - stats.y) / (stats.x - stats.y), 0.0, 1.0) : level / 16383.0, 0.0, 0.0, 1.0);
    }
`;
export const processingGainStateFragment = `
    uniform sampler2D tInput; // R: 14-bit counts
    uniform sampler2D tPlateau; // R: normalized CDF, 16384 detector levels in a 256 by 64 texture
    uniform sampler2D tGainState; // gainWindowFragment output: window low, high in counts; constant plateau flag
    uniform bool usePlateau; // plateau gain mode
    out vec4 result; // R: normalized drive [0,1], as processingFragment
    ${gainKeyFunctions}
    void main() {
        vec4 state = texelFetch(tGainState, ivec2(0), 0);
        float counts = texelFetch(tInput, ivec2(gl_FragCoord.xy), 0).r;
        float drive;
        if (usePlateau && state.z < 0.5) {
            int index = countLevel(counts);
            drive = texelFetch(tPlateau, ivec2(index % 256, index / 256), 0).r;
        } else drive = clamp((counts - state.x) / (state.y - state.x), 0.0, 1.0);
        result = vec4(drive, 0.0, 0.0, 1.0);
    }
`;
export const localMeanFragment = `
    uniform sampler2D tInput; // R: normalized drive
    uniform sampler2D tWeights; // R: unit-sum Gaussian, dimensionless
    uniform ivec2 imageSize; // native pixels
    uniform int radius; // native pixels, support radius
    uniform int axis; // 0 horizontal, 1 vertical
    out vec4 result; // R: local mean normalized drive
    void main() {
        ivec2 pixel = ivec2(gl_FragCoord.xy);
        float mean = 0.0;
        for (int sampleIndex = 0; sampleIndex <= 160; sampleIndex++) {
            if (sampleIndex > 2 * radius) break;
            int offset = sampleIndex - radius;
            ivec2 neighbor = clamp(pixel + (axis == 0 ? ivec2(offset, 0) : ivec2(0, offset)), ivec2(0), imageSize - 1);
            mean += texelFetch(tInput, neighbor, 0).r * texelFetch(tWeights, ivec2(sampleIndex, 0), 0).r;
        }
        result = vec4(mean, 0.0, 0.0, 1.0);
    }
`;
export const displayFragment = `
    uniform sampler2D tInput; // R: normalized drive
    uniform sampler2D tMean; // R: local mean normalized drive
    uniform float localAmount; // dimensionless enhancement strength
    uniform float responseGamma; // dimensionless positive exponent denominator
    uniform sampler2D tDisplayCurve; // normalized warm-increasing LUT, uniform drive nodes
    uniform bool useDisplayCurve;
    uniform vec2 polarityAffine; // white-hot gain (unitless), offset (8-bit codes)
    uniform bool blackHot; // unitless switch
    out vec4 result; // R: integer-valued 8-bit display codes [0,255]
    float localEnhancement(float drive, float mean) { return drive + localAmount * (drive - mean); }
    float responseCurve(float drive) {
        float response = pow(clamp(drive, 0.0, 1.0), 1.0 / responseGamma);
        if (!useDisplayCurve) return response;
        int last = textureSize(tDisplayCurve, 0).x - 1;
        float coordinate = response * float(last);
        int index = int(floor(coordinate));
        return mix(texelFetch(tDisplayCurve, ivec2(index, 0), 0).r,
            texelFetch(tDisplayCurve, ivec2(min(index + 1, last), 0), 0).r, fract(coordinate));
    }
    float quantize8Bit(float drive) { return floor(drive * 255.0 + 0.5); }
    float polarity(float code) { return blackHot ? 255.0 - code :
        floor(clamp(polarityAffine.x * code + polarityAffine.y, 0.0, 255.0) + 0.5); }
    void main() {
        ivec2 pixel = ivec2(gl_FragCoord.xy);
        float drive = localEnhancement(texelFetch(tInput, pixel, 0).r, texelFetch(tMean, pixel, 0).r);
        result = vec4(polarity(quantize8Bit(responseCurve(drive))), 0.0, 0.0, 1.0);
    }
`;
export const enlargeFragment = `
    uniform sampler2D tInput; // R: radiance, 14-bit counts, or 8-bit display code
    uniform ivec2 imageSize; // native pixels
    uniform float zoom; // dimensionless center-crop magnification
    uniform vec2 fieldScale; // output extent / native extent, before digital zoom
    uniform vec2 fieldOffset; // normalized native-detector offset
    uniform bool linearSampling; // unitless switch
    uniform bool sampleCentered;
    uniform vec2 outputSize; // viewport size in display pixels
    uniform vec2 windowScale; // available central detector window / native array
    uniform vec2 outputWindow; // input-unit endpoints mapped to normalized display
    in vec2 vUv; // normalized output coordinates
    out vec4 result; // RGB: final normalized display codes; no additional gamma
    float readPixel(ivec2 pixel) {
        ivec2 first = ivec2(ceil(vec2(imageSize) * (0.5 - 0.5 * windowScale) - 0.5));
        ivec2 last = ivec2(floor(vec2(imageSize) * (0.5 + 0.5 * windowScale) - 0.5));
        return texelFetch(tInput, clamp(pixel, first, last), 0).r;
    }
    float axisWeight(int index, float source, float span) {
        if (span > 1.0) return max(0.0, min(source + span * 0.5, float(index) + 0.5) -
            max(source - span * 0.5, float(index) - 0.5)) / span;
        return linearSampling ? max(0.0, 1.0 - abs(float(index) - source)) : 1.0;
    }
    void main() {
        vec2 nativeUV = ((vUv - 0.5) * fieldScale + fieldOffset) / zoom + 0.5;
        vec2 span = fieldScale * vec2(imageSize) / (zoom * outputSize);
        bvec2 outside = bvec2(nativeUV.x < 0.5 - 0.5 * windowScale.x || nativeUV.x >= 0.5 + 0.5 * windowScale.x,
            nativeUV.y < 0.5 - 0.5 * windowScale.y || nativeUV.y >= 0.5 + 0.5 * windowScale.y);
        if ((span.x <= 1.0 && outside.x) || (span.y <= 1.0 && outside.y)) {
            result = vec4(0.0, 0.0, 0.0, 1.0); return;
        }
        vec2 source = nativeUV * vec2(imageSize) - 0.5;
        // Sample-centered phase applies only to enlargement, anchored at top left.
        if (sampleCentered) source += vec2(span.x <= 1.0 ? 0.5 - 0.5 * span.x : 0.0,
            span.y <= 1.0 ? -0.5 + 0.5 * span.y : 0.0);
        ivec2 first = ivec2(ceil(vec2(imageSize) * (0.5 - 0.5 * windowScale) - 0.5));
        ivec2 last = ivec2(floor(vec2(imageSize) * (0.5 + 0.5 * windowScale) - 0.5));
        ivec2 lo, hi;
        for (int axis = 0; axis < 2; axis++) {
            if (span[axis] > 1.0) {
                lo[axis] = max(first[axis], int(floor(source[axis] - span[axis] * 0.5 + 0.5)));
                hi[axis] = min(last[axis], int(ceil(source[axis] + span[axis] * 0.5 + 0.5)) - 1);
            } else {
                lo[axis] = int(floor(source[axis] + (linearSampling ? 0.0 : 0.5)));
                hi[axis] = lo[axis] + (linearSampling ? 1 : 0);
            }
        }
        float value = 0.0;
        for (int y = lo.y; y <= hi.y; y++) for (int x = lo.x; x <= hi.x; x++)
            value += readPixel(ivec2(x,y)) * axisWeight(x, source.x, span.x) * axisWeight(y, source.y, span.y);
        value = clamp((value - outputWindow.x) / (outputWindow.y - outputWindow.x), 0.0, 1.0);
        result = vec4(vec3(value), 1.0);
    }
`;

export const skyFragment = `
    uniform float sky;
    uniform float skyElevationOffset; // rad; exact horizon shift within a validated height domain
    uniform bool useGradient, orthographic, directionalSea, projectedSea, cubicSeaAzimuth, packedSeaAzimuth;
    uniform sampler2D tSky; // elevation rad, photon radiance/1e20, row sample count
    uniform int skySamples, azimuthRows;
    uniform vec3 skyUp, seaWind; // unit directions in camera coordinates
    uniform vec2 azimuthRange; // rad, unwrapped about center ray
    uniform mat4 inverseProjection;
    in vec2 vUv;
    out vec4 result;
    float rowRadiance(float elevation, int row) {
        int lo=0, hi=directionalSea ? int(texelFetch(tSky, ivec2(0,row),0).b)-1 : skySamples-1;
        for (int i=0; i<12; i++) {
            if (hi-lo<=1) break;
            int mid=(lo+hi)/2;
            if (texelFetch(tSky,ivec2(mid,row),0).r<=elevation) lo=mid; else hi=mid;
        }
        vec2 a=texelFetch(tSky,ivec2(lo,row),0).rg, b=texelFetch(tSky,ivec2(hi,row),0).rg;
        float t=b.r>a.r ? clamp((elevation-a.r)/(b.r-a.r),0.0,1.0) : 1.0;
        return mix(a.g,b.g,t);
    }
    vec4 packedRadiances(float elevation, int row) {
        int lo=0,hi=int(texelFetch(tSky,ivec2(0,row),0).b)-1;
        for (int i=0;i<12;i++) {
            if (hi-lo<=1) break;
            int mid=(lo+hi)/2;
            if (texelFetch(tSky,ivec2(2*mid,row),0).r<=elevation) lo=mid; else hi=mid;
        }
        float a=texelFetch(tSky,ivec2(2*lo,row),0).r,b=texelFetch(tSky,ivec2(2*hi,row),0).r;
        float t=b>a ? clamp((elevation-a)/(b-a),0.0,1.0) : 1.0;
        return mix(texelFetch(tSky,ivec2(2*lo+1,row),0),texelFetch(tSky,ivec2(2*hi+1,row),0),t);
    }
    void main() {
        float value=sky;
        if (useGradient) {
            vec3 ray=orthographic ? vec3(0.0,0.0,-1.0) : normalize((inverseProjection*vec4(vUv*2.0-1.0,0.0,1.0)).xyz);
            float elevation=asin(clamp(dot(ray,skyUp),-1.0,1.0))-skyElevationOffset;
            if (directionalSea) {
                float azimuth=atan(dot(-ray,cross(seaWind,skyUp)),dot(-ray,seaWind));
                float center=(azimuthRange.x+azimuthRange.y)*0.5;
                azimuth=center+mod(azimuth-center+3.141592653589793,6.283185307179586)-3.141592653589793;
                float span=azimuthRange.y-azimuthRange.x;
                float p=span>0.0 ? clamp((azimuth-azimuthRange.x)/span,0.0,1.0)*float(azimuthRows-1) : 0.0;
                int lo=min(azimuthRows-2,int(floor(p)));
                if (cubicSeaAzimuth) {
                    int first=clamp(lo-1,0,azimuthRows-4);
                    float x=p-float(first);
                    vec4 w=vec4(-(x-1.0)*(x-2.0)*(x-3.0)/6.0,x*(x-2.0)*(x-3.0)/2.0,
                        -x*(x-1.0)*(x-3.0)/2.0,x*(x-1.0)*(x-2.0)/6.0);
                    vec4 source=packedSeaAzimuth ? packedRadiances(elevation,lo) :
                        vec4(rowRadiance(elevation,first),rowRadiance(elevation,first+1),
                            rowRadiance(elevation,first+2),rowRadiance(elevation,first+3));
                    value=max(0.0,dot(w,source));
                } else value=mix(rowRadiance(elevation,lo),rowRadiance(elevation,lo+1),p-float(lo));
            } else value=rowRadiance(elevation,0);
        }
        result=vec4(value,0.0,0.0,1.0);
    }
`;


// Calculated first hit shared by sea depth and cloud clipping. With refraction,
// the CPU inverse supplies apparent range; otherwise solve the straight sphere.
const thermalSeaGeometry = `
    uniform float sensorAltitudeM;
    uniform vec3 skyUp;
    uniform bool mappedSea;
    uniform sampler2D tSeaGeometry; // sqrt(horizon-elevation), apparent range m
    uniform int seaGeometrySamples;
    uniform float apparentHorizon; // rad, maximum of the projected sea surface
    float seaDistance(vec3 ray) {
        if (mappedSea) {
            float e=asin(clamp(dot(ray,skyUp),-1.0,1.0));
            if (e>apparentHorizon) return 1e30;
            float q=sqrt(max(0.0,apparentHorizon-e));
            int lo=0, hi=seaGeometrySamples-1;
            for (int i=0; i<12; i++) {
                if (hi-lo<=1) break;
                int mid=(lo+hi)/2;
                if (texelFetch(tSeaGeometry,ivec2(mid,0),0).r<=q) lo=mid; else hi=mid;
            }
            vec2 a=texelFetch(tSeaGeometry,ivec2(lo,0),0).rg, b=texelFetch(tSeaGeometry,ivec2(hi,0),0).rg;
            return mix(a.g,b.g,b.r>a.r ? clamp((q-a.r)/(b.r-a.r),0.0,1.0) : 0.0);
        }
        float s=dot(ray,skyUp), r=6371000.0+sensorAltitudeM;
        float q=sensorAltitudeM*(12742000.0+sensorAltitudeM);
        float d=r*r*s*s-q;
        if (s>=0.0 || d<0.0) return 1e30;
        return q/(-r*s+sqrt(d));
    }
`;

export const seaDepthFragment = `
    ${thermalSeaGeometry}
    uniform mat4 inverseProjection, cameraProjection;
    uniform float cameraFar;
    uniform bool logarithmicDepth, orthographic;
    in vec2 vUv;
    out vec4 result;
    void main() {
        vec3 ray=orthographic ? vec3(0.0,0.0,-1.0) : normalize((inverseProjection*vec4(vUv*2.0-1.0,0.0,1.0)).xyz);
        float distanceM=seaDistance(ray);
        if (distanceM>=1e30) discard;
        if (distanceM==0.0) {gl_FragDepth=0.0; result=vec4(0.0); return;}
        vec4 clip=cameraProjection*vec4(ray*distanceM,1.0);
        gl_FragDepth=logarithmicDepth && !orthographic ? log2(1.0+clip.w)/log2(cameraFar+1.0) : (clip.z/clip.w+1.0)*0.5;
        result=vec4(0.0);
    }
`;

export const cloudVertex = `
    #include <common>
    #include <logdepthbuf_pars_vertex>
    uniform vec3 center, apparentCenter; // physical and projected anchors, m
    uniform vec2 size; // billboard dimensions, m
    out vec2 cloudUV;
    out vec3 cloudPosition;
    void main() {
        cloudUV = uv;
        vec4 mvPosition = vec4(center + vec3(position.xy * size, 0.0), 1.0);
        mvPosition.xyz += apparentCenter - center;
        cloudPosition = mvPosition.xyz;
        gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
    }
`;
export const cloudFragment = `
    #include <logdepthbuf_pars_fragment>
    ${thermalSeaGeometry}
    uniform sampler2D maskTexture;
    uniform sampler2D radianceTexture; // opaque received photons/(s m² sr)/1e20
    uniform sampler2D behindTexture;
    uniform int tableSize;
    uniform float opticalDepth;
    uniform int semantics; // normalized column, calibrated opacity, coverage
    uniform bool shaderComposite;
    in vec2 cloudUV;
    in vec3 cloudPosition;
    out vec4 result;
    void main() {
        #include <logdepthbuf_fragment>
        float mask = texture(maskTexture, cloudUV).a;
        float alpha = semantics == 1 ? mask : semantics == 2 ? mask * (1.0-exp(-opticalDepth)) : 1.0-exp(-opticalDepth*mask);
        if (alpha <= 0.0) discard;
        if (length(cloudPosition)>seaDistance(normalize(cloudPosition))) discard;
        vec2 p = clamp(cloudUV, 0.0, 1.0)*float(tableSize-1);
        ivec2 lo = min(ivec2(floor(p)), ivec2(tableSize-2));
        vec2 f = p-vec2(lo);
        float C = mix(mix(texelFetch(radianceTexture, lo, 0).r, texelFetch(radianceTexture, lo+ivec2(1,0), 0).r, f.x),
            mix(texelFetch(radianceTexture, lo+ivec2(0,1), 0).r, texelFetch(radianceTexture, lo+ivec2(1,1), 0).r, f.x), f.y);
        float value = alpha*C;
        if (shaderComposite) value += (1.0-alpha)*texelFetch(behindTexture, ivec2(gl_FragCoord.xy), 0).r;
        result = vec4(value, 0.0, 0.0, alpha);
    }
`;
export const cloudCopyFragment = `uniform sampler2D tInput; out vec4 result;
    void main() {result = vec4(texelFetch(tInput, ivec2(gl_FragCoord.xy), 0).r, 0.0, 0.0, 1.0);}`;
