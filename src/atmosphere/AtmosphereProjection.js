import {Matrix4, Vector2} from "three";

export function atmosphereProjectionUniforms() {
    return {
        atmoInverseProjection: {value: new Matrix4()},
        atmoOrthographic: {value: false},
        atmoFishOn: {value: false},
        atmoFishType: {value: 0},
        atmoFishRho: {value: 1},
        atmoFishScale: {value: 1},
        atmoFishAspect: {value: 1},
        atmoFishCenter: {value: new Vector2()},
        atmoFishRoll: {value: 0},
    };
}

export function setAtmosphereProjection(uniforms, camera, fish) {
    uniforms.atmoInverseProjection.value.copy(camera.projectionMatrix).invert();
    // Sitrec can put an orthographic matrix on a PerspectiveCamera.
    uniforms.atmoOrthographic.value = camera.projectionMatrix.elements[15] === 1;
    uniforms.atmoFishOn.value = !!fish;
    if (fish) {
        uniforms.atmoFishType.value = fish.type;
        uniforms.atmoFishRho.value = fish.rho;
        uniforms.atmoFishScale.value = fish.scale;
        uniforms.atmoFishAspect.value = camera.aspect;
        uniforms.atmoFishCenter.value.set(fish.centerX * 2 / camera.aspect, fish.centerY * 2);
        uniforms.atmoFishRoll.value = fish.roll;
    }
}

// Inverse of the actual displayed projection, including shifted/compressed
// frusta and the five supported fisheye mappings. The latter stores distance
// in clip.w, as documented in FisheyeProjection.
export const ATMOSPHERE_PROJECTION_GLSL = /* glsl */`
    uniform mat4 atmoInverseProjection;
    uniform bool atmoOrthographic;
    uniform bool atmoFishOn;
    uniform float atmoFishType;
    uniform float atmoFishRho;
    uniform float atmoFishScale;
    uniform float atmoFishAspect;
    uniform vec2 atmoFishCenter;
    uniform float atmoFishRoll;

    vec3 atmosphereViewRay(vec2 ndc) {
        if (atmoFishOn) {
            vec2 p = (ndc - atmoFishCenter) * vec2(atmoFishAspect, 1.0);
            float radius = length(p);
            float rho = radius * atmoFishRho / max(atmoFishScale, 1e-6);
            float theta;
            if (atmoFishType < 0.5) theta = atan(rho);
            else if (atmoFishType < 1.5) theta = 2.0 * atan(rho * 0.5);
            else if (atmoFishType < 2.5) theta = min(rho, 3.14159265359);
            else if (atmoFishType < 3.5) theta = 2.0 * asin(min(rho * 0.5, 1.0));
            else theta = asin(min(rho, 1.0));
            vec2 radial = radius > 1e-8 ? p / radius : vec2(0.0);
            float c = cos(atmoFishRoll), s = sin(atmoFishRoll);
            radial = vec2(c * radial.x + s * radial.y, -s * radial.x + c * radial.y);
            return vec3(radial * sin(theta), -cos(theta));
        }
        if (atmoOrthographic) return vec3(0.0, 0.0, -1.0);
        vec4 p = atmoInverseProjection * vec4(ndc, 0.0, 1.0);
        // Oblique reflection clipping can change p.w's sign. The direction
        // still points down camera -Z; homogeneous xyz already gives that ray.
        return normalize(p.xyz);
    }

    vec3 atmosphereViewPosition(vec4 clip) {
        if (atmoFishOn && abs(clip.w) > 1e-8) {
            return atmosphereViewRay(clip.xy / clip.w) * clip.w;
        }
        if (!atmoOrthographic && abs(clip.w) > 1e-8) {
            vec3 ray = atmosphereViewRay(clip.xy / clip.w);
            // Perspective w is -viewZ. Inverting the full clip coordinate
            // instead subtracts almost equal z/w at planetary distances.
            return ray * (clip.w / max(-ray.z, 1e-8));
        }
        vec4 p = atmoInverseProjection * clip;
        return abs(p.w) > 1e-8 ? p.xyz / p.w : vec3(0.0);
    }
`;
