/**
 * Thermal — advanced FLIR (forward-looking infrared) sensor simulation.
 * White-Hot / Black-Hot polarity, Ironbow color palette, sensitivity
 * (temperature-range) remap, temperature contour banding, sensor-grid
 * pixelation, soft IR diffusion blur, hot-spot bloom, and slowly drifting
 * coherent sensor noise.
 *
 * Ported from "God's Eye View" (https://github.com/bilawalsidhu/gods-eye-view)
 * src/styles/thermal.js — MIT License, Copyright (c) 2026 Bilawal Sidhu.
 *
 * Sitrec adaptations:
 *  - Three.js ShaderPass conventions (tDiffuse / vUv / resolution vec2).
 *  - Linear <-> sRGB wrapping around the effect math, matching FLIRShader:
 *    every scene sample goes through sRGBTransferOETF, the final color
 *    through sRGBTransferEOTF for the linear render target.
 *  - The in-shader HUD (labels, crosshair, 7-segment readouts, scale bar)
 *    is removed — Sitrec draws its own overlays.
 *  - The circular lens mask is optional via the `vignette` uniform
 *    (default 0 = full-frame sensor; ATFLIR-style video is rectangular).
 *  - The mask is folded into the styled branch of the final intensity mix,
 *    so partial intensity crossfades at the edges instead of popping to black.
 *  - `time` is driven from the frame number (see CNodeEffect.updateUniforms)
 *    so the noise is deterministic per frame.
 */

import {Vector2} from "three";

export const ThermalShader = {

    name: "ThermalShader",

    uniforms: {
        'tDiffuse':    { value: null },
        'resolution':  { value: new Vector2(1280, 720) },
        'intensity':   { value: 1.0 },  // 0..1 crossfade with the unstyled image
        'time':        { value: 0.0 },  // seconds, frame-derived (deterministic)
        'sensitivity': { value: 0.75 }, // 0..1 contrast/range of temperature mapping
        'bloom':       { value: 0.65 }, // 0..1 hot-spot bloom/bleed
        'mode':        { value: 0.0 },  // 0 = White-Hot, 1 = Black-Hot (step at 0.5)
        'pixelation':  { value: 1.5 },  // 1..6 sensor grid size in pixels
        'palette':     { value: 0.0 },  // 0 = monochrome, 1 = Ironbow color ramp
        'vignette':    { value: 0.0 },  // 0 = no lens mask, 1 = circular FLIR optics
    },

    vertexShader: /* glsl */`

		varying vec2 vUv;

		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
		}`,

    fragmentShader: /* glsl */`

        uniform sampler2D tDiffuse;
        uniform vec2 resolution;
        uniform float intensity;
        uniform float time;
        uniform float sensitivity;
        uniform float bloom;
        uniform float mode;
        uniform float pixelation;
        uniform float palette;
        uniform float vignette;

        varying vec2 vUv;

        // Scene samples converted to sRGB-visual space; the effect math is
        // calibrated for sRGB values (same convention as FLIRShader).
        vec3 srgbTex(vec2 uv) {
            return sRGBTransferOETF(texture2D(tDiffuse, uv)).rgb;
        }

        // ── Ironbow thermal palette ───────────────────────────
        // Maps a 0-1 temperature to the classic FLIR ironbow ramp:
        // black -> deep purple -> magenta -> red -> orange -> yellow -> white.
        vec3 ironbow(float t) {
            t = clamp(t, 0.0, 1.0);
            const vec3 c0 = vec3(0.0, 0.0, 0.0);     // cold
            const vec3 c1 = vec3(0.13, 0.0, 0.30);   // deep purple
            const vec3 c2 = vec3(0.49, 0.0, 0.45);   // magenta
            const vec3 c3 = vec3(0.86, 0.10, 0.18);  // red
            const vec3 c4 = vec3(1.0, 0.55, 0.0);    // orange
            const vec3 c5 = vec3(1.0, 0.91, 0.32);   // yellow
            const vec3 c6 = vec3(1.0, 1.0, 1.0);     // hot (white)
            float s = t * 6.0;
            if (s < 1.0) return mix(c0, c1, s);
            if (s < 2.0) return mix(c1, c2, s - 1.0);
            if (s < 3.0) return mix(c2, c3, s - 2.0);
            if (s < 4.0) return mix(c3, c4, s - 3.0);
            if (s < 5.0) return mix(c4, c5, s - 4.0);
            return mix(c5, c6, s - 5.0);
        }

        // ── Value noise (coherent, smooth, drifting) ──────────
        float hash(vec2 p) {
            vec3 p3 = fract(vec3(p.xyx) * 0.1031);
            p3 += dot(p3, p3.yzx + 33.33);
            return fract((p3.x + p3.y) * p3.z);
        }

        float valueNoise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            f = f * f * (3.0 - 2.0 * f); // smoothstep interpolation
            float a = hash(i);
            float b = hash(i + vec2(1.0, 0.0));
            float c = hash(i + vec2(0.0, 1.0));
            float d = hash(i + vec2(1.0, 1.0));
            return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }

        // Fractal Brownian motion for layered coherent noise
        float fbm(vec2 p) {
            float v = 0.0;
            float a = 0.5;
            vec2 shift = vec2(100.0);
            for (int i = 0; i < 4; i++) {
                v += a * valueNoise(p);
                p = p * 2.0 + shift;
                a *= 0.5;
            }
            return v;
        }

        void main() {
            vec2 uv = vUv;
            vec2 dims = resolution;
            vec2 texel = 1.0 / dims;

            // ── Circular lens mask (optional FLIR optics field of view) ──
            vec2 centered = uv * 2.0 - 1.0;
            float aspect = dims.x / dims.y;
            centered.x *= aspect;
            float radius = length(centered);
            float lensMask = mix(1.0, pow(1.0 - smoothstep(0.6, 1.05, radius), 0.7), vignette);
            float lensShading = mix(1.0, max(1.0 - radius * radius * 0.25, 0.0), vignette);

            // ── Sensor resolution pixelation ─────────────────────
            float pixSize = mix(1.0, pixelation, intensity);
            vec2 snappedUV = floor(uv * dims / pixSize) * pixSize / dims;
            uv = mix(uv, snappedUV, intensity);

            // ── Soft IR blur (thermal cameras have lower resolution / diffraction) ──
            vec3 blurred = vec3(0.0);
            float totalWeight = 0.0;
            for (int y = -2; y <= 2; y++) {
                for (int x = -2; x <= 2; x++) {
                    float w = exp(-0.5 * float(x * x + y * y) / 2.0);
                    blurred += srgbTex(uv + vec2(float(x), float(y)) * texel * 1.5) * w;
                    totalWeight += w;
                }
            }
            blurred /= totalWeight;
            vec3 original = srgbTex(uv);

            // Mix between sharp and blurred based on intensity
            vec3 src = mix(original, blurred, 0.6 * intensity);

            // ── Luminance -> temperature mapping ─────────────────
            float luma = dot(src, vec3(0.299, 0.587, 0.114));

            // Sensitivity remaps the luminance range
            float sens = mix(0.25, 1.0, sensitivity);
            float temp = clamp((luma - (0.5 - sens * 0.5)) / sens, 0.0, 1.0);

            // ── Temperature banding (contour lines) ─────────────
            float bands = 12.0;
            float bandLine = abs(fract(temp * bands) - 0.5);
            float contour = smoothstep(0.04, 0.06, bandLine);
            temp *= mix(1.0, contour * 0.85 + 0.15, 0.3 * intensity);

            // ── White-Hot / Black-Hot polarity ──────────────────
            float isBlackHot = step(0.5, mode);
            float thermal = mix(temp, 1.0 - temp, isBlackHot);

            // Monochrome FLIR (white/black-hot) vs Ironbow color ramp.
            // Ironbow maps TRUE temperature (cold->dark, hot->white) so the
            // colors read correctly regardless of the WHOT/BHOT toggle.
            vec3 mono = vec3(thermal);
            vec3 iron = ironbow(temp);
            vec3 thermalColor = mix(mono, iron, palette);

            // ── Hot-spot bloom/bleed ────────────────────────────
            float bloomSample = 0.0;
            float bloomWeight = 0.0;
            for (int y = -4; y <= 4; y++) {
                for (int x = -4; x <= 4; x++) {
                    vec2 offset = vec2(float(x), float(y)) * texel * 3.0;
                    float sLuma = dot(srgbTex(uv + offset), vec3(0.299, 0.587, 0.114));
                    float sMapped = clamp((sLuma - (0.5 - sens * 0.5)) / sens, 0.0, 1.0);
                    float sFinal = mix(sMapped, 1.0 - sMapped, isBlackHot);
                    float w = exp(-0.5 * float(x * x + y * y) / 8.0);
                    // Only bloom the "hot" (post-polarity bright) pixels
                    float hotness = smoothstep(0.6, 1.0, sFinal);
                    bloomSample += hotness * w;
                    bloomWeight += w;
                }
            }
            bloomSample /= bloomWeight;
            thermalColor += bloomSample * bloom * 0.8;

            // ── Coherent temporal noise (slowly drifting, cloud-like) ──
            vec2 noiseCoord = uv * 80.0 + vec2(time * 0.3, time * 0.2);
            float noise = fbm(noiseCoord);
            noise = (noise - 0.5) * 0.08 * intensity;
            thermalColor += noise;

            // ── Lens shading + vignette (styled branch only) ────
            thermalColor *= lensShading * lensMask;
            thermalColor = clamp(thermalColor, 0.0, 1.0);

            // Crossfade with the unstyled image; the mask lives in the styled
            // branch, so partial intensity blends toward the original at the
            // edges rather than toward black.
            vec3 finalColor = mix(original, thermalColor, intensity);

            gl_FragColor = vec4(finalColor, 1.0);
            // Convert sRGB-visual output back to linear for the render target
            gl_FragColor = sRGBTransferEOTF(gl_FragColor);
        }`

};
