/**
 * NightVision — image-intensifier (PVS-14 style) night-vision simulation.
 * P43 phosphor green, auto-gain with a gain-dependent contrast curve,
 * intensifier tube bloom, darkness-weighted scintillation noise, fiber-optic
 * honeycomb, barrel distortion, display scanlines, and a circular tube mask.
 *
 * Ported from "God's Eye View" (https://github.com/bilawalsidhu/gods-eye-view)
 * src/styles/surveillance.js — MIT License, Copyright (c) 2026 Bilawal Sidhu.
 *
 * Sitrec adaptations:
 *  - Three.js ShaderPass conventions (tDiffuse / vUv / resolution vec2).
 *  - Linear <-> sRGB wrapping around the effect math, matching FLIRShader.
 *  - The in-shader HUD (labels, crosshair, timestamp, REC dot) is removed —
 *    Sitrec draws its own overlays.
 *  - The tube mask and out-of-bounds barrel regions darken the styled branch
 *    only (no early-return to black), so partial intensity crossfades at the
 *    edges instead of popping to black. The tube mask is applied once, and is
 *    scaled by the `vignette` uniform (default 1 = full tube look).
 *  - Barrel distortion strength is its own uniform (`distortion`).
 *  - `time` is driven from the frame number (see CNodeEffect.updateUniforms)
 *    so the noise is deterministic per frame.
 */

import {Vector2} from "three";

export const NightVisionShader = {

    name: "NightVisionShader",

    uniforms: {
        'tDiffuse':   { value: null },
        'resolution': { value: new Vector2(1280, 720) },
        'intensity':  { value: 1.0 },  // 0..1 crossfade with the unstyled image
        'time':       { value: 0.0 },  // seconds, frame-derived (deterministic)
        'gain':       { value: 0.55 }, // 0..1 intensifier gain (amplification + noise)
        'bloom':      { value: 0.30 }, // 0..1 halo intensity around bright sources
        'scanlines':  { value: 1.0 },  // 0..1 display scanline strength
        'pixelation': { value: 2.5 },  // 1..6 intensifier resolution grid in pixels
        'distortion': { value: 0.5 },  // 0..1 barrel distortion strength
        'vignette':   { value: 1.0 },  // 0 = no tube mask, 1 = circular NVG tube
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
        uniform float gain;
        uniform float bloom;
        uniform float scanlines;
        uniform float pixelation;
        uniform float distortion;
        uniform float vignette;

        varying vec2 vUv;

        // Scene samples converted to sRGB-visual space; the effect math is
        // calibrated for sRGB values (same convention as FLIRShader).
        vec3 srgbTex(vec2 uv) {
            return sRGBTransferOETF(texture2D(tDiffuse, uv)).rgb;
        }

        // ── Noise functions ───────────────────────────────────
        float hash(vec2 p) {
            vec3 p3 = fract(vec3(p.xyx) * 0.1031);
            p3 += dot(p3, p3.yzx + 33.33);
            return fract((p3.x + p3.y) * p3.z);
        }

        float valueNoise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            float a = hash(i);
            float b = hash(i + vec2(1.0, 0.0));
            float c = hash(i + vec2(0.0, 1.0));
            float d = hash(i + vec2(1.0, 1.0));
            return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }

        // ── Barrel distortion (NVG lens) ──────────────────────
        vec2 barrelDistort(vec2 uv, float strength) {
            vec2 c = uv * 2.0 - 1.0;
            float r2 = dot(c, c);
            float distort = 1.0 + r2 * strength * 0.5 + r2 * r2 * strength * 0.15;
            c *= distort;
            return c * 0.5 + 0.5;
        }

        // ── Honeycomb pattern (fiber optic plate texture) ─────
        float honeycomb(vec2 uv) {
            vec2 dims = resolution;
            float scale = min(dims.x, dims.y) * 0.008;
            vec2 p = uv * dims * scale;
            // Hex grid
            vec2 r = vec2(1.0, 1.732);
            vec2 h = r * 0.5;
            vec2 a = mod(p, r) - h;
            vec2 b = mod(p - h, r) - h;
            vec2 gv = dot(a, a) < dot(b, b) ? a : b;
            float d = max(abs(gv.x), abs(gv.y * 0.577 + abs(gv.x) * 0.5));
            return smoothstep(0.4, 0.45, d);
        }

        void main() {
            vec2 uv = vUv;
            vec2 dims = resolution;
            vec2 texel = 1.0 / dims;

            // Unstyled reference for the intensity crossfade — sampled at the
            // UNDISTORTED UV, so partial intensity fades to the true original
            // rather than to an edge-clamped barrel-distorted lookup.
            vec3 baseColor = srgbTex(uv);

            // ── Barrel distortion (NVG lens distortion) ─────────
            float dist = distortion * intensity;
            vec2 distUV = barrelDistort(uv, dist);

            // Styled branch goes black where the distorted lookup leaves the frame
            float inBounds = step(0.0, distUV.x) * step(distUV.x, 1.0)
                           * step(0.0, distUV.y) * step(distUV.y, 1.0);

            // ── Circular tube mask (optional NVG field of view) ──
            vec2 centered = uv * 2.0 - 1.0;
            float aspect = dims.x / dims.y;
            centered.x *= aspect;
            float radius = length(centered);
            float tubeMask = mix(1.0, pow(1.0 - smoothstep(0.6, 1.05, radius), 0.7), vignette);
            // Tube brightness falloff (center brightest)
            float tubeShading = mix(1.0, max(1.0 - radius * radius * 0.3, 0.0), vignette);

            // ── Intensifier tube resolution pixelation ──────────
            float pixSize = mix(1.0, pixelation, intensity);
            vec2 snappedUV = floor(distUV * dims / pixSize) * pixSize / dims;
            distUV = mix(distUV, snappedUV, intensity);

            vec3 original = srgbTex(distUV);

            // ── Luminance ───────────────────────────────────────
            float luma = dot(original, vec3(0.299, 0.587, 0.114));

            // ── Auto-gain response ──────────────────────────────
            // Higher gain = more amplification, more noise, more bloom
            float gainLevel = mix(0.8, 2.5, gain);
            float amplified = clamp(luma * gainLevel, 0.0, 1.0);

            // Slight contrast curve for gain response
            amplified = pow(amplified, mix(1.2, 0.7, gain));

            // ── Intensifier tube bloom (THE key NVG visual) ─────
            // Bloom around bright sources — wide kernel for realistic halos
            float bloomAccum = 0.0;
            float bloomW = 0.0;
            for (int y = -5; y <= 5; y++) {
                for (int x = -5; x <= 5; x++) {
                    vec2 offset = vec2(float(x), float(y)) * texel * 4.0;
                    float sLuma = dot(srgbTex(distUV + offset), vec3(0.299, 0.587, 0.114));
                    float bright = smoothstep(0.4, 0.9, sLuma * gainLevel);
                    float w = exp(-float(x * x + y * y) / 18.0);
                    bloomAccum += bright * w;
                    bloomW += w;
                }
            }
            bloomAccum /= bloomW;

            // Edge glow / corona on bright objects
            float corona = bloomAccum * bloom * 1.5;

            // ── P43 phosphor green (530nm) ──────────────────────
            vec3 phosphor = vec3(0.16, 1.0, 0.22);
            vec3 nvgColor = phosphor * (amplified + corona);

            // ── Scintillation (image intensifier sparkle noise) ──
            // Base tube grain (slow, coherent)
            vec2 grainCoord = uv * 120.0 + vec2(time * 0.5, time * 0.3);
            float tubeGrain = valueNoise(grainCoord);
            tubeGrain = (tubeGrain - 0.5) * mix(0.06, 0.2, gain) * intensity;
            nvgColor += phosphor * tubeGrain;

            // More noise in dark areas (real gain response)
            float darkNoise = (1.0 - amplified) * hash(uv * dims + vec2(time * 200.0, time * 300.0));
            nvgColor += phosphor * darkNoise * 0.08 * gain * intensity;

            // ── Honeycomb fiber optic plate ─────────────────────
            float hc = honeycomb(distUV);
            nvgColor *= 1.0 - hc * 0.04 * intensity; // very subtle

            // ── Scanlines (subtle, from the display) ────────────
            float scanline = sin(distUV.y * dims.y * 1.2 + time * 2.0) * 0.5 + 0.5;
            scanline = pow(scanline, 2.5);
            nvgColor *= 1.0 - scanline * scanlines * 0.15 * intensity;

            // ── Tube shading, mask, and barrel bounds (styled branch only) ──
            nvgColor *= tubeShading * tubeMask * inBounds;
            nvgColor = clamp(nvgColor, 0.0, 1.0);

            // Crossfade with the unstyled image; the mask, barrel bounds, and
            // distortion live in the styled branch only, so partial intensity
            // blends toward the clean original everywhere — including where
            // the distorted lookup left the frame.
            vec3 finalColor = mix(baseColor, nvgColor, intensity);

            gl_FragColor = vec4(finalColor, 1.0);
            // Convert sRGB-visual output back to linear for the render target
            gl_FragColor = sRGBTransferEOTF(gl_FragColor);
        }`

};
