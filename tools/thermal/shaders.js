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
    in vec3 vViewPosition; // m
    in vec3 vViewNormal; // unitless
    out vec4 result; // R: scaled photon radiance; G/B unused, A=1
    void main() {
        #include <logdepthbuf_fragment>
        float position = (rangeMaxM > 0.0 ? sqrt(clamp(length(vViewPosition) / rangeMaxM, 0.0, 1.0)) : 0.0) * float(rangeSamples - 1);
        int lower = min(rangeSamples - 2, int(floor(position)));
        vec2 source = mix(texelFetch(rangeTexture, ivec2(lower, 0), 0).rg,
            texelFetch(rangeTexture, ivec2(lower + 1, 0), 0).rg, position - float(lower));
        vec3 normal = normalize(vViewNormal) * (gl_FrontFacing ? 1.0 : -1.0);
        float radiance = source.r + source.g * max(0.0, dot(normal, sunViewDirection));
        result = vec4(radiance, 0.0, 0.0, 1.0);
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
    out vec4 result; // fine-grid signed far contrast
    float readPixel(ivec2 pixel) { return texelFetch(tInput, (pixel + fftSize) % fftSize, 0).r; }
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
    uniform bool useGradient, orthographic, directionalSea, projectedSea;
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
                value=mix(rowRadiance(elevation,lo),rowRadiance(elevation,lo+1),p-float(lo));
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
