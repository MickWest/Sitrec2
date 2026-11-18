// Shared model-light calibration used by the interactive and long-exposure views.
// The imported aircraft lamps are authored in display units (e.g. 543 for a nav lamp).
const LIGHT_CANDELA_PER_INTENSITY = 0.2;

// Model strobe ratings use effective candela. For a rectangular flash, the
// Blondel-Rey relation (14 CFR 23.1401, 2013 edition) gives its peak intensity.
// Multiplying by the actual fraction of an exposure then gives its mean intensity.
export function peakCandela(intensity, period, duration) {
    const effective = intensity * LIGHT_CANDELA_PER_INTENSITY;
    return period > duration && duration > 0 ? effective * (0.2 + duration) / duration : effective;
}

// ICAO AMOFSG/10-SN/11 quotes illuminance thresholds of 8e-7 lux at night
// and 1e-4 lux by day. Smoothly interpolate in log illuminance using Sitrec's
// twilight sky brightness as a proxy for observer adaptation.
export function modelLightAdaptationLux(sky) {
    return 8e-7 * 125 ** (Math.max(0, Math.min(1, sky)) ** 2.5);
}

// Keep the timing between lamps on the same aircraft. Give each successive aircraft
// another phase of its own clock, even when more members are added to the formation.
const MEMBER_PHASE_STEP = 0.61803398875;
export function memberStrobeOffset(member, period) {
    return ((member * MEMBER_PHASE_STEP) % 1) * period;
}

// Integral of a rectangular pulse train, to catch flashes shorter than a frame.
// Times and pulse width are in cycles. Works across period boundaries and backwards seeks.
export function flashFraction(phase, width, span) {
    const onTime = t => Math.floor(t) * width + Math.min(t - Math.floor(t), width);
    if (span === 0) return phase - Math.floor(phase) < width ? 1 : 0;
    return Math.max(0, Math.min(1, (onTime(phase) - onTime(phase - span)) / span));
}

export const modelLightVertexShader = `
    uniform float uCandela;
    uniform float uAdaptationLux;
    uniform float uViewHeight;
    uniform vec3 uFlash;  // end phase, pulse width and frame duration, in cycles
    uniform vec3 uDirection;
    uniform vec2 uCone;   // outer/inner cosines, or -2 for an omnidirectional light
    varying vec2 vUv;
    varying float vDepth;
    varying float vGain;

    float onTime(float t) {
        return floor(t) * uFlash.y + min(fract(t), uFlash.y);
    }

    void main() {
        mat4 lampToView = modelViewMatrix;
        float phase = uFlash.x;
        #ifdef USE_INSTANCING
            lampToView *= instanceMatrix;
            phase += fract(float(gl_InstanceID) * ${MEMBER_PHASE_STEP});
        #endif
        vec4 center = lampToView[3];
        float duty = uFlash.z > 0.0
            ? clamp((onTime(phase) - onTime(phase - uFlash.z)) / uFlash.z, 0.0, 1.0)
            : float(fract(phase) < uFlash.y);
        float beam = 1.0;
        if (uCone.x > -1.0) {
            float cosine = dot(normalize(mat3(lampToView) * uDirection), normalize(-center.xyz));
            beam = smoothstep(uCone.x, uCone.y, cosine);
        }
        float lux = duty * beam * uCandela / max(1.0, dot(center.xyz, center.xyz));
        float contrast = lux / uAdaptationLux;
        vGain = contrast / (1.0 + contrast);

        // An unresolved lamp has a compact image even when its lens is sub-pixel.
        // Grow the halo logarithmically, with a physical aperture for close-ups.
        float haloPx = min(18.0, 3.0 + 2.0 * log2(1.0 + contrast));
        gl_Position = applyTerrestrialRefraction_clip(center);
        float pixelSpan = 2.0 * gl_Position.w / (projectionMatrix[1][1] * uViewHeight);
        float diameter = max(0.10, haloPx * pixelSpan);
        gl_Position.xy += position.xy * diameter * vec2(projectionMatrix[0][0], projectionMatrix[1][1]);
        vUv = uv;
        vDepth = gl_Position.w;
    }
`;
