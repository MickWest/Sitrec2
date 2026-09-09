import {AdditiveBlending, Color, Material, Vector3, Vector4} from "three";
import {atmosphereProjectionUniforms, ATMOSPHERE_PROJECTION_GLSL} from "./AtmosphereProjection";

export const materialAtmosphereUniforms = {
    ...atmosphereProjectionUniforms(),
    atmoEnabled: {value: false},
    atmoBeta: {value: 0},
    atmoAltitude: {value: 0},
    atmoRadius: {value: 6378137},
    atmoUp: {value: new Vector3(0, 1, 0)},
    atmoSun: {value: new Vector3(1, 0, 0)},
    atmoCool: {value: new Color()},
    atmoWarm: {value: new Color()},
    atmoWarmStrength: {value: 0},
    atmoStartPlane: {value: new Vector4()},
};

// Integrate only the part of the ray inside the atmosphere. Quadratic sample
// spacing resolves the dense air near a ground endpoint without spending
// samples on the vacuum between an orbital observer and the atmosphere.
export const MATERIAL_ATMOSPHERE_GLSL = /* glsl */`
    uniform bool atmoEnabled;
    uniform bool atmoOrthographic;
    uniform bool atmoFishOn;
    uniform float atmoBeta;
    uniform float atmoAltitude;
    uniform float atmoRadius;
    uniform vec3 atmoUp;
    uniform vec3 atmoSun;
    uniform vec3 atmoCool;
    uniform vec3 atmoWarm;
    uniform float atmoWarmStrength;
    uniform vec4 atmoStartPlane;
    varying vec3 vAtmospherePosition;

    vec3 applyMaterialAtmosphere(vec3 radiance) {
        if (!atmoEnabled) return radiance;
        vec3 origin = atmoOrthographic && !atmoFishOn ? vec3(vAtmospherePosition.xy, 0.0) : vec3(0.0);
        vec3 path = vAtmospherePosition - origin;
        float distanceM = length(path);
        if (distanceM < 0.001) return radiance;
        vec3 direction = path / distanceM;
        vec3 radialOrigin = atmoUp * (atmoRadius + atmoAltitude) + origin;
        float b = dot(radialOrigin, direction);
        float outerRadius = atmoRadius + 100000.0;
        float discriminant = b * b - dot(radialOrigin, radialOrigin) + outerRadius * outerRadius;
        if (discriminant <= 0.0) return radiance;
        float root = sqrt(discriminant);
        float startM = max(0.0, -b - root);
        float endM = min(distanceM, -b + root);
        // Mirror captures shade only the water-to-object leg. The water
        // material applies the eye-to-water leg during the normal view draw.
        float planeSlope = dot(atmoStartPlane.xyz, direction);
        if (abs(planeSlope) > 1e-8) {
            startM = max(startM, -(dot(atmoStartPlane.xyz, origin) + atmoStartPlane.w) / planeSlope);
        }
        if (endM <= startM) return radiance;
        bool descending = b + 0.5 * (startM + endM) < 0.0;
        float opticalMeters = 0.0;
        for (int i = 0; i < 12; i++) {
            float q0 = float(i) / 12.0;
            float q1 = float(i + 1) / 12.0;
            float t0 = descending ? 1.0 - (1.0 - q0) * (1.0 - q0) : q0 * q0;
            float t1 = descending ? 1.0 - (1.0 - q1) * (1.0 - q1) : q1 * q1;
            float s = mix(startM, endM, 0.5 * (t0 + t1));
            // Rationalized height avoids subtracting two Earth-sized lengths.
            vec3 displacement = atmoUp * atmoAltitude + origin + direction * s;
            vec3 p = atmoUp * atmoRadius + displacement;
            float h = max(0.0, (2.0 * atmoRadius * dot(atmoUp, displacement) + dot(displacement, displacement))
                / (length(p) + atmoRadius));
            float density = mix(exp(-h / 8000.0), exp(-h / 1500.0), 0.45);
            density *= 1.0 - smoothstep(75000.0, 100000.0, h);
            opticalMeters += density * (endM - startM) * (t1 - t0);
        }
        float transmittance = exp(-min(atmoBeta * opticalMeters, 20.0));
        #ifdef ATMOSPHERE_ADDITIVE
            return radiance * transmittance;
        #else
            vec3 horizontal = direction - atmoUp * dot(direction, atmoUp);
            float alignment = max(0.0, dot(horizontal / max(length(horizontal), 1e-5), atmoSun));
            vec3 airlight = mix(atmoCool, atmoWarm, alignment * atmoWarmStrength);
            // HDR highlights are attenuated, never clamped to display white.
            return radiance * transmittance + airlight * (1.0 - transmittance);
        #endif
    }
`;

const installed = new WeakSet();
const defaultCacheKey = Material.prototype.customProgramCacheKey;

function finishMain(source, statement) {
    const main = /void\s+main\s*\(\s*(?:void\s*)?\)\s*\{/.exec(source);
    if (!main) throw new Error("Atmosphere shader has no main function");
    const start = main.index + main[0].length;
    let depth = 1;
    // Ignore braces in comments while locating this function's closing brace.
    const tokens = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|[{}]|\breturn\s*;/g;
    tokens.lastIndex = start;
    const insertions = [];
    let token;
    while ((token = tokens.exec(source))) {
        if (token[0] === "{") depth++;
        if (token[0] === "}" && --depth === 0) {
            insertions.push({index: token.index, length: 0, text: statement + "\n"});
            break;
        }
        if (token[0].startsWith("return")) {
            insertions.push({index: token.index, length: token[0].length, text: `{ ${statement} return; }`});
        }
    }
    for (const {index, length, text} of insertions.reverse()) source = source.slice(0, index) + text + source.slice(index + length);
    return source;
}

export function installMaterialAtmosphere(material) {
    if (!material || installed.has(material) || material.isRawShaderMaterial
        || material.isSceneLineMaterial || material.depthTest === false
        || material.userData?.atmosphere === false) return false;

    const previous = material.onBeforeCompile;
    const previousKey = material.customProgramCacheKey !== defaultCacheKey
        ? material.customProgramCacheKey : null;
    const defaultKey = String(previous);
    material.onBeforeCompile = function(shader, renderer) {
        previous?.call(this, shader, renderer);
        Object.assign(shader.uniforms, materialAtmosphereUniforms);
        // Preserve the complete original vertex shader: morphs, skinning,
        // instancing, displacement, billboards, and projection patches all run
        // first. No guessed replacement geometry or separate depth pass.
        shader.vertexShader = ATMOSPHERE_PROJECTION_GLSL + "\nuniform bool atmoEnabled;\nvarying vec3 vAtmospherePosition;\n"
            + finishMain(shader.vertexShader, "vAtmospherePosition = atmoEnabled ? atmosphereViewPosition(gl_Position) : vec3(0.0);");

        const apply = "gl_FragColor.rgb = applyMaterialAtmosphere(gl_FragColor.rgb);";
        const output = /#include <(?:tonemapping_fragment|colorspace_fragment)>/;
        const prefix = (this.blending === AdditiveBlending ? "#define ATMOSPHERE_ADDITIVE\n" : "")
            + MATERIAL_ATMOSPHERE_GLSL;
        if (output.test(shader.fragmentShader)) {
            shader.fragmentShader = prefix + shader.fragmentShader.replace(output, match => `${apply}\n${match}`);
        } else {
            // Custom shaders in the world scene already output linear color.
            // Handle explicitly premultiplied material output before blending.
            shader.fragmentShader = prefix + finishMain(shader.fragmentShader,
                this.premultipliedAlpha ? "if (gl_FragColor.a > 0.0) { gl_FragColor.rgb = applyMaterialAtmosphere(gl_FragColor.rgb / gl_FragColor.a) * gl_FragColor.a; }" : apply);
        }
    };
    material.customProgramCacheKey = function() {
        return `${previousKey ? previousKey.call(this) : defaultKey}.materialAtmosphere.v1.${this.blending === AdditiveBlending}.${this.premultipliedAlpha}`;
    };
    installed.add(material);
    material.needsUpdate = true;
    return true;
}

export function installSceneAtmosphere(scene) {
    scene.traverse(object => {
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            installMaterialAtmosphere(material);
        }
    });
}

// Shared material programs serve several views and reflection cameras. Scope
// their uniform values to the draw, including error paths and nested renders.
export function withMaterialAtmosphere(scene, uniforms, render) {
    if (!uniforms && !materialAtmosphereUniforms.atmoEnabled.value) return render();
    if (uniforms?.atmoEnabled.value) installSceneAtmosphere(scene);
    const previous = Object.fromEntries(Object.entries(materialAtmosphereUniforms).map(([key, uniform]) => [key, uniform.value]));
    for (const [key, uniform] of Object.entries(materialAtmosphereUniforms)) {
        if (uniforms) uniform.value = uniforms[key].value;
    }
    if (!uniforms) materialAtmosphereUniforms.atmoEnabled.value = false;
    try {
        return render();
    } finally {
        for (const [key, value] of Object.entries(previous)) materialAtmosphereUniforms[key].value = value;
    }
}
