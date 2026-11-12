import {Vector2, Vector3} from "three";
import {SceneLineMaterial, displayPixelScale} from "./SceneLineMaterial";
import {fisheyeProjectVector, isFisheyeCamera} from "./FisheyeProjection";
import {applyRefractionECI, installRefractionOnMaterial, refractionOptsFromUniforms,
    refractionUniforms} from "./atmosphere/refraction";

// Fade the converging grid strokes by their displayed distance from either
// pole. Fragment-space distance keeps the 10–50 px fade independent of line
// segmentation, field of view, pixel density and the observer's orientation.
export class CelestialGridMaterial extends SceneLineMaterial {
    constructor({sphereRadius = 100, refracted = false, ...parameters} = {}) {
        super(parameters);
        this.sphereRadius = sphereRadius;
        this.refracted = refracted;
        this.uniforms.gridPoleNorth = {value: new Vector3()};
        this.uniforms.gridPoleSouth = {value: new Vector3()};
        this.uniforms.gridPoleFadeRange = {value: new Vector2(10, 50)};
        this._pole = new Vector3();
        this._poleView = new Vector3();
        this.fragmentShader = this.fragmentShader.replace("void main() {", `
            uniform vec3 gridPoleNorth;
            uniform vec3 gridPoleSouth;
            uniform vec2 gridPoleFadeRange;
            void main() {
        `).replace("gl_FragColor = vec4(lineColor, alpha);", `
            float poleDistance = 1e20;
            if (gridPoleNorth.z > 0.5) poleDistance = distance(gl_FragCoord.xy, gridPoleNorth.xy);
            if (gridPoleSouth.z > 0.5) poleDistance = min(poleDistance, distance(gl_FragCoord.xy, gridPoleSouth.xy));
            alpha *= smoothstep(gridPoleFadeRange.x, gridPoleFadeRange.y, poleDistance);
            if (alpha <= 0.0) discard;
            gl_FragColor = vec4(lineColor, alpha);
        `);
        if (refracted) installRefractionOnMaterial(this);
    }

    onBeforeRender(renderer, scene, camera, geometry, object) {
        super.onBeforeRender(renderer);
        this.uniforms.gridPoleFadeRange.value.set(10, 50).multiplyScalar(displayPixelScale(renderer));
        const origin = this.uniforms.lineViewportOrigin.value;
        const refraction = this.refracted ? refractionOptsFromUniforms() : null;
        for (const [sign, uniform] of [[1, this.uniforms.gridPoleNorth], [-1, this.uniforms.gridPoleSouth]]) {
            const point = this._pole.set(0, 0, sign * this.sphereRadius);
            // Equatorial line vertices are refracted in their local EQJ frame.
            // Use that same transform for the pole before projecting it.
            if (refraction) applyRefractionECI(point, refractionUniforms.uZenithECI.value, refraction);
            point.applyMatrix4(object.matrixWorld);
            this._poleView.copy(point).applyMatrix4(camera.matrixWorldInverse);
            const behind = !isFisheyeCamera(camera) && this._poleView.z >= -camera.near;
            if (!fisheyeProjectVector(point, camera)) point.project(camera);
            const visible = !behind && point.z >= -1 && point.z <= 1 && Number.isFinite(point.x) && Number.isFinite(point.y);
            if (visible) uniform.value.set((point.x * 0.5 + 0.5) * this.resolution.x + origin.x,
                (point.y * 0.5 + 0.5) * this.resolution.y + origin.y, 1);
            else uniform.value.set(0, 0, 0);
        }
    }
}
