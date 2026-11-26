// Two RGBA texels per beam. All cloud materials share the upload, including
// the two views and water reflections. Subtract a nearby origin on the CPU
// before handing positions to the GPU, preserving narrow beams at ECEF scale.
import {DataTexture, FloatType, RGBAFormat, Vector3} from "three";

import {spotlightCandela} from "../SpotlightMotion";

export function spotlightUniforms() {
    return {
        spotlightCount: {value: 0},
        spotlightData: {value: null},
        spotlightOrigin: {value: new Vector3()},
    };
}

export class SpotlightField {
    constructor() {
        this.projectors = new Map();
        this.origin = new Vector3();
        this.count = 0;
        this.texture = null;
        this.dirty = false;
    }

    rebuild() {
        this.dirty = false;
        this.count = 0;
        for (const projector of this.projectors.values()) {
            if (!projector.group.visible) continue;
            if (!this.count) this.origin.copy(projector.group.position);
            this.count += projector.beams.length;
        }
        if (this.texture && (this.texture.image.height < this.count || !this.count)) {
            this.texture.dispose();
            this.texture = null;
        }
        if (!this.count) return;
        if (!this.texture) {
            this.texture = new DataTexture(new Float32Array(this.count * 8), 2, this.count, RGBAFormat, FloatType);
        }
        const data = this.texture.image.data;
        let i = 0;
        for (const projector of this.projectors.values()) {
            if (!projector.group.visible) continue;
            for (const beam of projector.beams) {
                data[i++] = beam.origin.x - this.origin.x;
                data[i++] = beam.origin.y - this.origin.y;
                data[i++] = beam.origin.z - this.origin.z;
                data[i++] = spotlightCandela(projector.lumens, beam.settings.width);
                beam.direction.toArray(data, i);
                i += 3;
                data[i++] = Math.tan(beam.settings.width * Math.PI / 360);
            }
        }
        this.texture.needsUpdate = true;
    }

    // The shader's sample positions are relative to referenceMatrix's origin.
    setUniforms(uniforms, referenceMatrix) {
        if (this.dirty) this.rebuild();
        uniforms.spotlightCount.value = this.count;
        uniforms.spotlightData.value = this.texture;
        uniforms.spotlightOrigin.value.setFromMatrixPosition(referenceMatrix).negate().add(this.origin);
    }
}

export const SPOTLIGHT_GLSL = /* glsl */`
    uniform int spotlightCount;
    uniform highp sampler2D spotlightData;
    uniform vec3 spotlightOrigin;

    float spotlightIrradiance(vec3 samplePosition) {
        float light = 0.0;
        for (int i = 0; i < spotlightCount; i++) {
            vec4 source = texelFetch(spotlightData, ivec2(0, i), 0);
            vec4 beam = texelFetch(spotlightData, ivec2(1, i), 0);
            vec3 delta = (samplePosition - spotlightOrigin) - source.xyz;
            float along = dot(delta, beam.xyz);
            if (along <= 0.0) continue;
            vec3 offset = delta - along * beam.xyz;
            float radius = max(0.1, along * beam.w);
            float r2 = dot(offset, offset) / (radius * radius);
            // Axial candela / distance squared gives lux. The final scale
            // converts illuminance to the cloud shader's scene-linear units.
            if (r2 < 16.0) light += source.w * exp2(-r2) * 0.0443 / max(dot(delta, delta), 100.0);
        }
        return light;
    }
`;
