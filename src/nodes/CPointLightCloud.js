/**
 * CPointLightCloud - Unified GPU-accelerated point light rendering system
 * 
 * This class provides efficient rendering of large numbers of point lights (stars, satellites,
 * etc.) using a single Three.js Points object with custom shaders. It consolidates functionality
 * that was previously duplicated across CStarField and CSatellite into a reusable component.
 * 
 * ## Architecture
 * 
 * The class uses GPU instancing via Three.js Points, where each point is a single vertex with
 * associated attributes (position, brightness, optional color). The custom shader handles:
 * - Point sizing based on brightness with configurable min/max limits
 * - Alpha compensation for points clamped to minimum size (preserves visual brightness)
 * - Optional per-point colors or a single shared color
 * - Procedural soft circle rendering with configurable falloff
 * - Optional logarithmic depth buffer for proper depth sorting at planetary scales
 * - Sky brightness attenuation to fade points during daylight
 * 
 * ## Usage Modes
 * 
 * **Celestial mode** (`mode: 'celestial'`): For stars and other "infinitely distant" objects.
 * Points are positioned on a sphere of fixed radius. The celestial sphere scene is rendered
 * with the camera at origin, so no position updates are needed per-frame.
 * 
 * **World mode** (`mode: 'world'`): For satellites and other objects with real-world positions.
 * Positions are updated each frame via setPosition(). Supports logarithmic depth buffer for
 * proper rendering alongside terrain at varying distances.
 * 
 * ## Performance Considerations
 * 
 * - Use batch updates: call setPosition/setBrightness in a loop, then markPositionsNeedUpdate()
 *   once at the end, rather than triggering needsUpdate on every individual change
 * - Visibility toggling uses brightness=0 rather than removing geometry, avoiding buffer rebuilds
 * - Single draw call for thousands of points
 * 
 * ## Example Usage
 * 
 * ```javascript
 * // Stars (celestial mode, single white color)
 * const stars = new CPointLightCloud({
 *     id: "StarfieldLightCloud",
 *     mode: 'celestial',
 *     singleColor: 0xffffff,
 *     count: 5000,
 *     scene: celestialSphereGroup
 * });
 * 
 * // Satellites (world mode, per-point colors, logarithmic depth)
 * const satellites = new CPointLightCloud({
 *     id: "SatelliteLightCloud",
 *     mode: 'world',
 *     singleColor: null,  // enables per-point colors
 *     useLogDepth: true,
 *     count: 10000,
 *     scene: mainScene
 * });
 * ```
 * 
 * @extends CNode3D
 */

import {
    BufferAttribute,
    BufferGeometry,
    Color,
    CustomBlending,
    MaxEquation,
    OneFactor,
    Points,
    ShaderMaterial,
} from "three";
import {CNode3D} from "./CNode3D";
import {NodeMan} from "../Globals";
import {sharedUniforms} from "../js/map33/material/SharedUniforms";
import {refractionUniforms, REFRACTION_VERTEX_GLSL} from "../atmosphere/refraction";
import {aberrationUniforms, ABERRATION_VERTEX_GLSL} from "../CelestialMath";

/**
 * GPU-accelerated point light cloud renderer for stars, satellites, and similar objects.
 * @extends CNode3D
 */
export class CPointLightCloud extends CNode3D {
    /**
     * Creates a new point light cloud.
     * @param {Object} v - Configuration object
     * @param {string} v.id - Required unique identifier for the node
     * @param {'world'|'celestial'} [v.mode='world'] - Positioning mode. 'celestial' for stars on a fixed sphere, 'world' for real-world positioned objects
     * @param {number|null} [v.singleColor=null] - Hex color for all points, or null for per-point colors
     * @param {number} [v.sphereRadius=100] - Radius for celestial sphere positioning (meters)
     * @param {boolean} [v.useBoostScale=false] - Enable distance-based size boosting for minimum angular size
     * @param {number} [v.boostAmount=0.01] - Boost factor for distance scaling (fraction of FOV)
     * @param {number} [v.baseScale=1.0] - Base scale multiplier for point sizes
     * @param {number} [v.minPointSize=2.0] - Minimum point size in pixels
     * @param {number} [v.maxPointSize=20.0] - Maximum point size in pixels (used with useSizeRange)
     * @param {number} [v.uRadius=0.4] - Falloff radius for soft edges (0.4=soft, 0.9=hard disk)
     * @param {boolean} [v.useLogDepth=false] - Enable logarithmic depth buffer for planetary-scale rendering
     * @param {boolean} [v.useSkyAttenuation=true] - Fade points based on sky brightness (daylight)
     * @param {boolean} [v.useSizeRange=false] - Map brightness to size range instead of alpha
     * @param {number} [v.count] - Number of points to allocate. If provided, buffers are initialized immediately
     * @param {THREE.Object3D} [v.scene] - Scene/group to add points to
     */
    constructor(v) {
        super(v);

        /** @type {'world'|'celestial'} */
        this.mode = v.mode ?? 'world';
        /** @type {number|null} */
        this.singleColor = v.singleColor ?? null;
        /** @type {number} */
        this.sphereRadius = v.sphereRadius ?? 100;
        /** @type {boolean} */
        this.useBoostScale = v.useBoostScale ?? false;
        /** @type {number} */
        this.boostAmount = v.boostAmount ?? 0.01;
        /** @type {number} */
        this.baseScale = v.baseScale ?? 1.0;
        /** @type {number} */
        this.minPointSize = v.minPointSize ?? 2.0;
        /** @type {number} */
        this.maxPointSize = v.maxPointSize ?? 20.0;
        /** @type {number} */
        this.uRadius = v.uRadius ?? 0.4;
        /** @type {boolean} */
        this.useLogDepth = v.useLogDepth ?? false;
        /** @type {boolean} */
        this.useSkyAttenuation = v.useSkyAttenuation ?? true;
        /** @type {boolean} */
        this.useSizeRange = v.useSizeRange ?? false;
        /** @type {boolean} */
        this.useDistanceAttenuation = v.useDistanceAttenuation ?? false;
        /** @type {number} */
        this.distanceReference = v.distanceReference ?? 3000000;

        /** @type {THREE.Points|null} */
        this.points = null;
        /** @type {THREE.BufferGeometry|null} */
        this.geometry = null;
        /** @type {THREE.ShaderMaterial|null} */
        this.material = null;
        
        /** @type {THREE.Points|null} - Secondary points for main view with different attenuation */
        this.mainViewPoints = null;
        /** @type {THREE.ShaderMaterial|null} */
        this.mainViewMaterial = null;

        /** @type {Float32Array|null} */
        this.positionArray = null;
        /** @type {Float32Array|null} */
        this.colorArray = null;
        /** @type {Float32Array|null} */
        this.brightnessArray = null;
        /** @type {Float32Array|null} */
        this.baseBrightnessArray = null;

        /** @type {number} */
        this.count = 0;
        /** @type {THREE.Object3D|null} */
        this.scene = v.scene ?? null;

        if (v.count !== undefined) {
            this.initializeBuffers(v.count);
            this.createMaterial();
            this.createPoints();
        }
    }

    /**
     * Allocates typed arrays for position, brightness, and optional color data.
     * Called automatically if count is provided to constructor.
     * @param {number} count - Number of points to allocate
     * @private
     */
    initializeBuffers(count) {
        this.count = count;
        this.positionArray = new Float32Array(count * 3);
        this.brightnessArray = new Float32Array(count);
        this.baseBrightnessArray = new Float32Array(count);

        if (this.singleColor === null) {
            this.colorArray = new Float32Array(count * 3);
        }

        for (let i = 0; i < count; i++) {
            this.brightnessArray[i] = 1.0;
            this.baseBrightnessArray[i] = 1.0;
        }
    }

    createMaterial() {
        const usesPerPointColor = this.singleColor === null;

        const distanceAttenuationCalc = this.useDistanceAttenuation
            ? `if (distanceReference > 0.0) {
                   float dist = length(mvPosition.xyz);
                   float distanceScale = distanceReference / max(dist, 1.0);
                   effectiveBrightness *= distanceScale;
               }`
            : '';

        const sizeCalc = this.useSizeRange
            ? `float size = mix(minPointSize, maxPointSize, effectiveBrightness) * baseScale;
               gl_PointSize = size;
               vAlpha = 1.0;`
            : `float desiredSize = effectiveBrightness * baseScale;
               // Clamp to minimum pixel size to prevent sub-pixel flickering
               gl_PointSize = max(desiredSize, minPointSize);
               // Fade alpha for sub-minimum points to conserve energy
               float sizeRatio = clamp(desiredSize / minPointSize, 0.0, 1.0);
               vAlpha = sizeRatio * sizeRatio;`;

        const useRefraction = this.mode === 'celestial';

        const vertexShader = `
            attribute float brightness;
            ${usesPerPointColor ? 'attribute vec3 color;' : ''}

            uniform float baseScale;
            uniform float minPointSize;
            uniform float maxPointSize;
            uniform float cameraFOV;
            ${this.useDistanceAttenuation ? 'uniform float distanceReference;' : ''}
            ${!usesPerPointColor ? 'uniform vec3 uColor;' : ''}

            varying vec3 vColor;
            varying float vAlpha;
            varying float vBrightness;
            ${this.useLogDepth ? 'varying float vDepth;' : ''}

            ${useRefraction ? ABERRATION_VERTEX_GLSL + REFRACTION_VERTEX_GLSL : ''}

            void main() {
                if (brightness <= 0.0) {
                    gl_Position = vec4(0.0);
                    gl_PointSize = 0.0;
                    return;
                }

                ${usesPerPointColor ? 'vColor = color;' : 'vColor = uColor;'}
                vBrightness = brightness;

                ${useRefraction
                    ? 'vec3 refractedPos = applyRefractionECI_chunk(applyAberration_chunk(position));'
                    : 'vec3 refractedPos = position;'}
                vec4 mvPosition = modelViewMatrix * vec4(refractedPos, 1.0);
                gl_Position = projectionMatrix * mvPosition;
                ${this.useLogDepth ? 'vDepth = gl_Position.w;' : ''}

                float effectiveBrightness = brightness;
                ${distanceAttenuationCalc}
                ${sizeCalc}
            }
        `;

        const fragmentShader = `
            uniform float uRadius;
            ${this.useLogDepth ? `
            uniform float nearPlane;
            uniform float farPlane;
            ` : ''}
            
            varying vec3 vColor;
            varying float vAlpha;
            varying float vBrightness;
            ${this.useLogDepth ? 'varying float vDepth;' : ''}
            
            void main() {
                if (vBrightness <= 0.0) {
                    discard;
                }
                
                vec2 centered = gl_PointCoord - 0.5;
                float dist = length(centered) * 2.0;
                float alpha = 1.0 - smoothstep(uRadius, 1.0, dist);
                alpha *= vAlpha;
                gl_FragColor = vec4(vColor * alpha, alpha);
                
                ${this.useLogDepth ? `
                // Orthographic projection makes vDepth a constant 1.0, collapsing the
                // log formula to one value per fragment → z-fighting; use linear depth.
                if (vDepth == 1.0) {
                    gl_FragDepthEXT = gl_FragCoord.z;
                } else {
                    float z = (log2(max(nearPlane, 1.0 + vDepth)) / log2(1.0 + farPlane)) * 2.0 - 1.0;
                    gl_FragDepthEXT = z * 0.5 + 0.5;
                }
                ` : ''}
            }
        `;

        const uniforms = {
            baseScale: { value: this.baseScale },
            minPointSize: { value: this.minPointSize },
            maxPointSize: { value: this.maxPointSize },
            cameraFOV: { value: 45 },
            uRadius: { value: this.uRadius },
        };

        if (useRefraction) {
            uniforms.uAberration = aberrationUniforms.uAberration;
            uniforms.uRefractionEnabled = refractionUniforms.uRefractionEnabled;
            uniforms.uZenithECI = refractionUniforms.uZenithECI;
            uniforms.uZenithECEF = refractionUniforms.uZenithECEF;
            uniforms.uRefractionPress = refractionUniforms.uRefractionPress;
            uniforms.uRefractionTemp = refractionUniforms.uRefractionTemp;
        }

        if (!usesPerPointColor) {
            const color = new Color(this.singleColor);
            uniforms.uColor = { value: [color.r, color.g, color.b] };
        }

        if (this.useLogDepth) {
            Object.assign(uniforms, sharedUniforms);
        }

        if (this.useDistanceAttenuation) {
            uniforms.distanceReference = { value: this.distanceReference };
        }

        this.material = new ShaderMaterial({
            vertexShader,
            fragmentShader,
            uniforms,
            transparent: true,
            depthTest: true,
            depthWrite: false,
            blending: CustomBlending,
            blendEquation: MaxEquation,
            blendSrc: OneFactor,
            blendDst: OneFactor,
        });
    }

    createPoints() {
        this.geometry = new BufferGeometry();

        this.geometry.setAttribute('position', new BufferAttribute(this.positionArray, 3));
        this.geometry.setAttribute('brightness', new BufferAttribute(this.brightnessArray, 1));

        if (this.colorArray) {
            this.geometry.setAttribute('color', new BufferAttribute(this.colorArray, 3));
        }

        this.points = new Points(this.geometry, this.material);
        this.points.frustumCulled = false;

        if (this.scene) {
            this.scene.add(this.points);
        }
    }

    createMainViewMaterial(config = {}) {
        const usesPerPointColor = this.singleColor === null;
        const nearDist = config.nearDist ?? 1000000;
        const farDist = config.farDist ?? 100000000;
        const nearScale = config.nearScale ?? 1.0;
        const farScale = config.farScale ?? 0.1;
        const baseScale = config.baseScale ?? 10;
        this.mainViewBaseScale = baseScale;
        const minPointSize = config.minPointSize ?? this.minPointSize;
        const maxPointSize = config.maxPointSize ?? this.maxPointSize;

        const vertexShader = `
            attribute float brightness;
            ${usesPerPointColor ? 'attribute vec3 color;' : ''}
            
            uniform float baseScale;
            uniform float minPointSize;
            uniform float maxPointSize;
            uniform float nearDist;
            uniform float farDist;
            uniform float nearScale;
            uniform float farScale;
            ${!usesPerPointColor ? 'uniform vec3 uColor;' : ''}
            
            varying vec3 vColor;
            varying float vAlpha;
            varying float vBrightness;
            ${this.useLogDepth ? 'varying float vDepth;' : ''}
            
            void main() {
                if (brightness <= 0.0) {
                    gl_Position = vec4(0.0);
                    gl_PointSize = 0.0;
                    return;
                }
                
                ${usesPerPointColor ? 'vColor = color;' : 'vColor = uColor;'}
                vBrightness = brightness;
                
                vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                gl_Position = projectionMatrix * mvPosition;
                ${this.useLogDepth ? 'vDepth = gl_Position.w;' : ''}
                
                float dist = length(mvPosition.xyz);
                float t = clamp((dist - nearDist) / (farDist - nearDist), 0.0, 1.0);
                float distScale = mix(nearScale, farScale, t);
                
                float brightnessSize = mix(0.0, maxPointSize, brightness) * baseScale;
                float size = minPointSize + brightnessSize * distScale;
                gl_PointSize = size;
                vAlpha = 1.0;
            }
        `;

        const fragmentShader = `
            uniform float uRadius;
            ${this.useLogDepth ? `
            uniform float nearPlane;
            uniform float farPlane;
            ` : ''}
            
            varying vec3 vColor;
            varying float vAlpha;
            varying float vBrightness;
            ${this.useLogDepth ? 'varying float vDepth;' : ''}
            
            void main() {
                if (vBrightness <= 0.0) {
                    discard;
                }
                
                vec2 centered = gl_PointCoord - 0.5;
                float dist = length(centered) * 2.0;
                float alpha = 1.0 - smoothstep(uRadius, 1.0, dist);
                alpha *= vAlpha;
                gl_FragColor = vec4(vColor * alpha, alpha);
                
                ${this.useLogDepth ? `
                // Orthographic projection makes vDepth a constant 1.0, collapsing the
                // log formula to one value per fragment → z-fighting; use linear depth.
                if (vDepth == 1.0) {
                    gl_FragDepthEXT = gl_FragCoord.z;
                } else {
                    float z = (log2(max(nearPlane, 1.0 + vDepth)) / log2(1.0 + farPlane)) * 2.0 - 1.0;
                    gl_FragDepthEXT = z * 0.5 + 0.5;
                }
                ` : ''}
            }
        `;

        const uniforms = {
            baseScale: { value: baseScale },
            minPointSize: { value: minPointSize },
            maxPointSize: { value: maxPointSize },
            nearDist: { value: nearDist },
            farDist: { value: farDist },
            nearScale: { value: nearScale },
            farScale: { value: farScale },
            uRadius: { value: this.uRadius },
        };

        if (!usesPerPointColor) {
            const color = new Color(this.singleColor);
            uniforms.uColor = { value: [color.r, color.g, color.b] };
        }

        if (this.useLogDepth) {
            Object.assign(uniforms, sharedUniforms);
        }

        this.mainViewMaterial = new ShaderMaterial({
            vertexShader,
            fragmentShader,
            uniforms,
            transparent: true,
            depthTest: true,
            depthWrite: false,
            blending: CustomBlending,
            blendEquation: MaxEquation,
            blendSrc: OneFactor,
            blendDst: OneFactor,
        });

        this.mainViewPoints = new Points(this.geometry, this.mainViewMaterial);
        this.mainViewPoints.frustumCulled = false;

        if (this.scene) {
            this.scene.add(this.mainViewPoints);
        }

        return this.mainViewMaterial;
    }

    setLight(index, { position, color, brightness }) {
        if (position !== undefined) {
            this.positionArray[index * 3] = position.x;
            this.positionArray[index * 3 + 1] = position.y;
            this.positionArray[index * 3 + 2] = position.z;
            this.geometry.attributes.position.needsUpdate = true;
        }

        if (color !== undefined && this.colorArray) {
            const c = color instanceof Color ? color : new Color(color);
            this.colorArray[index * 3] = c.r;
            this.colorArray[index * 3 + 1] = c.g;
            this.colorArray[index * 3 + 2] = c.b;
            this.geometry.attributes.color.needsUpdate = true;
        }

        if (brightness !== undefined) {
            this.brightnessArray[index] = brightness;
            this.baseBrightnessArray[index] = brightness;
            this.geometry.attributes.brightness.needsUpdate = true;
        }
    }

    setLightVisible(index, visible) {
        this.brightnessArray[index] = visible ? this.baseBrightnessArray[index] : 0.0;
        this.geometry.attributes.brightness.needsUpdate = true;
    }

    setPosition(index, x, y, z) {
        this.positionArray[index * 3] = x;
        this.positionArray[index * 3 + 1] = y;
        this.positionArray[index * 3 + 2] = z;
    }

    setColor(index, r, g, b) {
        if (this.colorArray) {
            this.colorArray[index * 3] = r;
            this.colorArray[index * 3 + 1] = g;
            this.colorArray[index * 3 + 2] = b;
        }
    }

    setBrightness(index, brightness) {
        this.brightnessArray[index] = brightness;
        this.baseBrightnessArray[index] = brightness;
    }

    markPositionsNeedUpdate() {
        if (this.geometry?.attributes.position) {
            this.geometry.attributes.position.needsUpdate = true;
        }
    }

    markColorsNeedUpdate() {
        if (this.geometry?.attributes.color) {
            this.geometry.attributes.color.needsUpdate = true;
        }
    }

    markBrightnessNeedUpdate() {
        if (this.geometry?.attributes.brightness) {
            this.geometry.attributes.brightness.needsUpdate = true;
        }
    }

    boostScale(baseSize, worldSize, distance, fovRadians, boost = 0.01) {
        const base = (baseSize * worldSize) / (2 * distance);
        const addedAngle = boost * fovRadians / 2;
        const newSize = (2 * distance / worldSize) * Math.tan(Math.atan(base) + addedAngle);
        return newSize;
    }

    preRender(view) {
        if (!this.material || !this.points) return;

        const camera = view.camera;

        let skyFactor = 1;
        if (this.useSkyAttenuation) {
            const sunNode = NodeMan.get("theSun", true);
            if (sunNode) {
                const skyBrightness = sunNode.calculateSkyBrightness(camera.position);
                skyFactor = Math.max(0, 1 - skyBrightness);
            }
        }

        let scale = this.baseScale;

        if (this.useBoostScale) {
            const distance = camera.position.length();
            const fovRadians = camera.fov * (Math.PI / 180);
            scale = this.boostScale(scale, 5, distance, fovRadians, this.boostAmount);
        }

        scale *= skyFactor;
        scale = view.adjustPointScale(scale);

        this.material.uniforms.baseScale.value = scale;
        this.material.uniforms.cameraFOV.value = camera.fov;

        if (this.mainViewMaterial) {
            let mainScale = (this.mainViewBaseScale ?? 10) * skyFactor;
            mainScale = view.adjustPointScale(mainScale);
            this.mainViewMaterial.uniforms.baseScale.value = mainScale;
        }
    }

    addToScene(scene) {
        this.scene = scene;
        if (this.points) {
            scene.add(this.points);
        }
        if (this.mainViewPoints) {
            scene.add(this.mainViewPoints);
        }
    }

    removeFromScene() {
        if (this.points && this.scene) {
            this.scene.remove(this.points);
        }
        if (this.mainViewPoints && this.scene) {
            this.scene.remove(this.mainViewPoints);
        }
    }

    dispose() {
        if (this.points) {
            this.removeFromScene();
        }
        if (this.geometry) {
            this.geometry.dispose();
            this.geometry = null;
        }
        if (this.material) {
            this.material.dispose();
            this.material = null;
        }
        if (this.mainViewMaterial) {
            this.mainViewMaterial.dispose();
            this.mainViewMaterial = null;
        }
        this.positionArray = null;
        this.colorArray = null;
        this.brightnessArray = null;
        this.baseBrightnessArray = null;
        this.points = null;
        this.mainViewPoints = null;

        super.dispose();
    }

    get visible() {
        return this.points?.visible ?? false;
    }

    set visible(v) {
        if (this.points) {
            this.points.visible = v;
        }
    }
}
