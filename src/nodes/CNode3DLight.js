import {CNode3D} from "./CNode3D";
import {assert} from "../assert";
import {AdditiveBlending, Color, DoubleSide, MathUtils, Matrix4, Mesh, PlaneGeometry, ShaderMaterial, Vector2, Vector3} from 'three';
import {sharedUniforms} from "../js/map33/material/SharedUniforms";
import {NodeMan} from "../Globals";
import {CNodeGUIValue} from "./CNodeGUIValue";
import {CNodeGUIColor} from "./CNodeGUIColor";
import {flashFraction, memberStrobeOffset, modelLightAdaptationLux, modelLightVertexShader, peakCandela} from "../ModelLightDisplay";
import {Sit} from "../Globals";
import {installTerrestrialRefractionOnShaderMaterial} from "../atmosphere/terrestrialRefraction";
import {kiteLEDIntensity, sampleKiteLED} from "../../tools/vehicles/kiteLEDPattern.js";

export class CNode3DLight extends CNode3D {
    constructor(v) {
        super(v);
        this.type = 'CNode3DLight';

        this.light = v.light;
        assert(this.light, "CNode3DLight requires a light object");

        this.gui = v.gui;

        // Initialize visibility control variables
        this.lightVisible = true;
        this.lightIlluminates = false;
        this.deterministicStrobe = this.light.userData?.vehicleLight === true;

        this.relativeMatrix = new Matrix4();
        this.lampMatrix = new Matrix4();
        this.targetPosition = new Vector3();
        this.beamDirection = new Vector3();
        this.illuminators = [];

        const geometry = new PlaneGeometry(1, 1);
        const material = new ShaderMaterial({
            uniforms: {
                ...sharedUniforms,
                uColor: {value: this.light.color},
                uCandela: {value: this.peakCandela},
                uAdaptationLux: {value: 1e-8},
                uViewHeight: {value: 1},
                uFlash: {value: new Vector3(0, 1, 0)},
                uDirection: {value: new Vector3(0, 0, -1)},
                uCone: {value: new Vector2(-2, -2)},
                uRadius: {value: 0.1},
            },
            vertexShader: modelLightVertexShader,
            fragmentShader: `
        uniform vec3 uColor;
        varying float vGain;
        uniform float uRadius;
        uniform float nearPlane; // these are set in sharedUniforms
        uniform float farPlane;

        varying vec2 vUv;
        varying float vDepth;

        void main() {
            vec2 centered = vUv - 0.5;
            float dist = length(centered) * 2.0; // fix scaling
            
            if (dist > 1.0 || vGain <= 0.0) discard;
            float r = max(0.0, dist - uRadius);
            float alpha = exp(-8.0 * r * r);

            // Logarithmic depth calculation
            // requires the near and far planes to be set in the material (shared uniforms)
            // and vDepth to be passed from the vertex shader from gl_Position.w.
            // Orthographic projection makes vDepth a constant 1.0, collapsing the log
            // formula to one value per fragment → z-fighting; use linear depth there.
            if (vDepth == 1.0) {
                gl_FragDepthEXT = gl_FragCoord.z;
            } else {
                float z = (log2(max(nearPlane, 1.0 + vDepth)) / log2(1.0 + farPlane)) * 2.0 - 1.0;
                gl_FragDepthEXT = z * 0.5 + 0.5;
            }

            gl_FragColor = vec4(uColor, vGain * alpha);
        }
    `,
            transparent: true,
            side: DoubleSide,
            forceSinglePass: true,
            depthWrite: false,
            blending: AdditiveBlending
        });
        installTerrestrialRefractionOnShaderMaterial(material);

        // check for strobes
        if (this.light.userData !== undefined && this.light.userData.strobeEvery) {
            this.strobeEvery = this.light.userData.strobeEvery
            this.strobeLength = this.light.userData.strobeLength || 0.1;
            let hash = 0;
            for (let i = 0; i < this.id.length; i++) {
                hash = ((hash << 5) - hash) + this.id.charCodeAt(i);
                hash |= 0;
            }
            this.strobeOffset = (((hash >>> 0) % 50000) / 10000) ;
            if (this.light.userData.vehicleLight && Number.isFinite(this.light.userData.strobeOffset)) this.strobeOffset = this.light.userData.strobeOffset;
            this.addSimpleSerial("strobeOffset");
        }


        const billboard = new Mesh(geometry, material);
        billboard.name = "LightBillboard";
        billboard.position.copy(this.light.position);
        billboard.frustumCulled = false; // the halo expands to screen pixels in the vertex shader
        
        // Disable raycasting on the light billboard so it doesn't interfere with context menu picking
        billboard.raycast = () => {};

        v.scene.add(billboard);

        this._object = billboard;

        this.scene = v.scene; // save the scene for later use

        // Create GUI controls if GUI folder is provided
        if (this.gui) {
            this.createGUIControls();
        }

    }

    setIntensity(value) {
        const v = Number(value);
        if (!isFinite(v) || v < 0) return;
        this.light.intensity = v;
        this._object.material.uniforms.uCandela.value = this.peakCandela;
        if (this.intensityControl) this.intensityControl.value = v;
    }

    // Show/hide the light (billboard + illumination), as `show`/`hide` do from a script.
    setLightVisible(visible) {
        this.lightVisible = !!visible;
        this.updateVisibility();
    }

    createGUIControls() {
        // Light Visible control (controls both light and billboard visibility)
        this.lightVisibleControl = new CNodeGUIValue({
            id: this.id + "_lightVisible",
            desc: "Light Visible",
            tooltip: "1 shows this light: its glow, and its light on the scene when Light Illuminates is 1. 0 hides both.",
            value: this.lightVisible ? 1 : 0,
            start: 0,
            end: 1,
            step: 1,
            onChange: (value) => {
                this.lightVisible = value === 1;
                this.updateVisibility();
            }
        }, this.gui);

        // Light Illuminates control (controls only light illumination)
        this.lightIlluminatesControl = new CNodeGUIValue({
            id: this.id + "_lightIlluminates",
            desc: "Light Illuminates",
            tooltip: "1 makes this light also light up the scene around it. 0 shows only its glow.\nUsed only when Light Visible is 1.",
            value: this.lightIlluminates ? 1 : 0,
            start: 0,
            end: 1,
            step: 1,
            onChange: (value) => {
                this.lightIlluminates = value === 1;
                this.updateVisibility();
            }
        }, this.gui);

        // Intensity control
        this.intensityControl = new CNodeGUIValue({
            id: this.id + "_intensity",
            desc: "Intensity",
            tooltip: "Brightness of the lamp. Brighter lamps remain visible farther away and have a larger glow.",
            value: this.light.intensity,
            start: 0,
            end: 10000,
            step: 1,
            onChange: (value) => this.setIntensity(value),
        }, this.gui);

        // Color control
        this.colorControl = new CNodeGUIColor({
            id: this.id + "_color",
            desc: "Color",
            value: this.light.color,
            onChange: (value) => this.light.color.copy(value),
        }, this.gui);
        // CNodeGUIColor takes no tooltip option, so set it on its controller.
        this.colorControl.guiEntry?.tooltip("Color of the light and of its glow.");

        // Radius control
        this.radiusControl = new CNodeGUIValue({
            id: this.id + "_radius",
            desc: "Radius",
            tooltip: "Size of the solid bright center of the glow, as a fraction of the glow's radius.",
            value: this._object.material.uniforms.uRadius.value,
            start: 0.1,
            end: 1.0,
            step: 0.01,
            onChange: (value) => {
                this._object.material.uniforms.uRadius.value = value;
            }
        }, this.gui);

        // Strobe controls if strobe data exists
        if (this.strobeEvery !== undefined) {
            this.strobeEveryControl = new CNodeGUIValue({
                id: this.id + "_strobeEvery",
                desc: "Strobe Every (s)",
                tooltip: "Time from the start of one flash to the start of the next, in seconds. 0 = no strobe: the light stays on.",
                value: this.strobeEvery,
                start: 0,
                end: 20.0,
                step: 0.01,
                onChange: (value) => {
                    this.strobeEvery = value;
                }
            }, this.gui);

            this.strobeLengthControl = new CNodeGUIValue({
                id: this.id + "_strobeLength",
                desc: "Strobe Length (s)",
                tooltip: "How long each flash lasts, in seconds.",
                value: this.strobeLength,
                start: 0.01,
                end: 1.0,
                step: 0.01,
                onChange: (value) => {
                    this.strobeLength = value;
                }
            }, this.gui);

            this.strobeOffsetControl = new CNodeGUIValue({
                id: this.id + "_strobeOffset",
                desc: "Strobe Offset (s)",
                tooltip: "Time shift of the flashes, in seconds. Lights with different offsets flash at different times.",
                value: this.strobeOffset,
                start: 0,
                end: 20.0,
                step: 0.01,
                onChange: (value) => {
                    this.strobeOffset = value;
                }
            }, this.gui);
        }
    }

    // Method to update visibility based on control variables and strobe state
    updateVisibility() {
        const on = this.lightVisible && this.light.intensity > 0;
        const singleOn = on && !this.flockBillboard && this.flashAt(0) > 1e-6;
        if (this._object) this._object.visible = singleOn && !this.suppressBillboard;
        this.light.visible = singleOn && this.lightIlluminates;
        if (this.flockBillboard) this.flockBillboard.visible = on && !this.suppressBillboard;
    }

    setFlockBillboard(mesh) {
        this.flockBillboard = mesh;
        this.clearIlluminators();
        if (this._object) this.updateVisibility();
    }

    clearIlluminators() {
        for (const lamp of this.illuminators) {
            lamp.removeFromParent();
            lamp.target?.removeFromParent();
            lamp.dispose?.();
        }
        this.illuminators.length = 0;
    }

    get peakCandela() {
        return peakCandela(this.light.intensity, this.strobeEvery, this.strobeLength);
    }

    get memberCount() {
        return this.flockBillboard ? this.flockBillboard.count : 1;
    }

    memberPosition(member, out) {
        if (!this.flockBillboard) return this.light.getWorldPosition(out);
        this.flockBillboard.getMatrixAt(member, this.lampMatrix);
        return out.setFromMatrixPosition(this.lampMatrix).applyMatrix4(this.flockBillboard.matrixWorld);
    }

    candelaToward(member, observer, position) {
        if (!this.light.isSpotLight) return this.peakCandela;
        const mesh = this.flockBillboard;
        if (mesh) {
            mesh.getMatrixAt(member, this.lampMatrix);
            this.lampMatrix.premultiply(mesh.matrixWorld);
        } else {
            this.lampMatrix.copy(this.light.matrixWorld);
        }
        const uniforms = this._object.material.uniforms;
        this.beamDirection.copy(uniforms.uDirection.value).transformDirection(this.lampMatrix);
        const cosine = this.beamDirection.dot(this.targetPosition.subVectors(observer, position).normalize());
        const cone = uniforms.uCone.value;
        return this.peakCandela * MathUtils.smoothstep(cosine, cone.x, cone.y);
    }

    memberOffset(member) {
        return (this.strobeOffset ?? 0) + memberStrobeOffset(member, this.strobeEvery || 0);
    }

    flashAt(member) {
        const flash = this._object.material.uniforms.uFlash.value;
        return flashFraction(flash.x + memberStrobeOffset(member, 1), flash.y, flash.z);
    }

    dispose() {
        NodeMan.disposeRemove(this.lightVisibleControl, true);
        NodeMan.disposeRemove(this.lightIlluminatesControl, true);
        NodeMan.disposeRemove(this.intensityControl, true);
        NodeMan.disposeRemove(this.colorControl, true);
        NodeMan.disposeRemove(this.radiusControl, true);
        NodeMan.disposeRemove(this.strobeEveryControl, true);
        NodeMan.disposeRemove(this.strobeLengthControl, true);
        NodeMan.disposeRemove(this.strobeOffsetControl, true);


        this.clearIlluminators();
        if (this._object) {
            this.scene.remove(this._object);
            this._object.geometry.dispose();
            this._object.material.dispose();
            this._object = null;
        }
        super.dispose();
    }

    // we do the strobing in update(), not preRender(view)
    // as it's only once per frame, not once per view render call
    update(f) {
        super.update(f);
        const frameSeconds = (this.deterministicStrobe ? (Sit.simSpeed ?? 1) : 1) / (Sit.fps || 30);
        const time = f * frameSeconds;
        const uniforms = this._object.material.uniforms;
        uniforms.uCandela.value = this.peakCandela;
        const period = this.strobeEvery;
        if (period > 0 && this.strobeLength > 0) {
            // Each displayed frame integrates the preceding frame interval. Compute
            // directly from f, so pausing, skipping or seeking gives the same flash.
            const end = (time + Math.max(0, -frameSeconds) + (this.strobeOffset ?? 0)) / period;
            uniforms.uFlash.value.set(end - Math.floor(end), Math.min(1, this.strobeLength / period),
                Math.abs(frameSeconds) / period);
        } else {
            uniforms.uFlash.value.set(0, 1, 0);
        }

        const led = this.light.userData.kiteLED;
        if (led) {
            const state = sampleKiteLED(led.site, led.settings, time,
                this._ledState ??= {color: new Color(), level: 0});
            const intensity = kiteLEDIntensity(led.site, led.settings);
            this.light.intensity = intensity * (led.settings.overallScale ?? 1) ** 2 * state.level;
            this.light.color.copy(state.color);
            uniforms.uCandela.value = this.peakCandela;
            this.updateVisibility();
            if (this.vehicleLens?.material?.userData.vehicleLightLens === this.light.name) {
                this.vehicleLens.material.emissive.copy(state.color);
                this.vehicleLens.material.emissiveIntensity = this.lightVisible ? state.level * intensity / 35 * 1.8 : 0;
            }
            return;
        }

        this.updateVisibility();
        const lensMaterial = this.vehicleLens?.material;
        if (lensMaterial?.userData.vehicleLightLens === this.light.name) {
            const on = this.lightVisible && (!this.flockBillboard || !this.strobeEvery) && this.flashAt(0) > 1e-6;
            lensMaterial.emissiveIntensity = on ? 1.8 : 0;
            lensMaterial.emissive.copy(this.light.color);
        }
    }

    // Three.js scene illumination is optional and considerably more expensive than
    // drawing glows. All members have visible lamps; the nearest eight of each
    // type can also cast light on surrounding geometry when that control is on.
    updateFlockIllumination(camera) {
        const mesh = this.flockBillboard;
        if (!mesh || !this.lightVisible || !this.lightIlluminates || this.light.intensity <= 0) {
            if (this.illuminators.length) this.clearIlluminators();
            return;
        }
        const maxIlluminators = 8;
        const nearest = [];
        for (let i = 0; i < mesh.count; i++) {
            const d = this.memberPosition(i, this.targetPosition).distanceToSquared(camera.position);
            if (nearest.length === maxIlluminators && d >= nearest[maxIlluminators - 1].d) continue;
            nearest.push({i, d});
            nearest.sort((a, b) => a.d - b.d);
            if (nearest.length > maxIlluminators) nearest.pop();
        }
        const uniforms = this._object.material.uniforms;
        for (let slot = 0; slot < nearest.length; slot++) {
            const member = nearest[slot].i;
            let lamp = this.illuminators[slot];
            if (!lamp) {
                lamp = this.light.clone(false);
                this.illuminators.push(lamp);
                mesh.parent.add(lamp);
                if (lamp.target) mesh.parent.add(lamp.target);
            }
            mesh.getMatrixAt(member, this.lampMatrix);
            this.lampMatrix.premultiply(mesh.matrix);
            lamp.position.setFromMatrixPosition(this.lampMatrix);
            lamp.color.copy(this.light.color);
            lamp.layers.mask = mesh.layers.mask;
            lamp.intensity = this.light.intensity * this.flashAt(member);
            lamp.visible = lamp.intensity > 1e-6;
            if (lamp.target) {
                lamp.target.position.copy(uniforms.uDirection.value).applyMatrix4(this.lampMatrix);
                lamp.target.updateMatrixWorld();
            }
            lamp.updateMatrixWorld();
        }
        for (let i = nearest.length; i < this.illuminators.length; i++) this.illuminators[i].visible = false;
    }

    preRender(view) {
        const billboard = this._object;
        const uniforms = billboard.material.uniforms;
        const camera = view.camera;
        // Include the entire glTF transform chain (and animated joints).
        this.light.updateWorldMatrix(true, false);
        this.scene.updateWorldMatrix(true, false);
        this.relativeMatrix.copy(this.scene.matrixWorld).invert().multiply(this.light.matrixWorld);
        this.relativeMatrix.decompose(billboard.position, billboard.quaternion, billboard.scale);
        billboard.updateMatrixWorld();
        if (this.light.isSpotLight) {
            this.light.target.getWorldPosition(this.targetPosition);
            this.light.worldToLocal(this.targetPosition);
            uniforms.uDirection.value.copy(this.targetPosition).normalize();
            const outer = Math.cos(this.light.angle);
            uniforms.uCone.value.set(outer, Math.max(outer + 1e-5, Math.cos(this.light.angle * (1 - this.light.penumbra))));
        }
        const sky = NodeMan.get("theSun", true)?.calculateSkyBrightness(camera.position) ?? 0;
        // Display adaptation, not a measured camera response. At full daylight a
        // source needs much more illuminance for the same contrast than at dusk.
        uniforms.uAdaptationLux.value = modelLightAdaptationLux(sky);
        uniforms.uViewHeight.value = Math.max(1, view.heightPx || 1);
        this.updateVisibility();
        this.updateFlockIllumination(camera);
    }
}
