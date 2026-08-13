import {CNode3D} from "./CNode3D";
import {assert} from "../assert";
import {AdditiveBlending, Mesh, PlaneGeometry, ShaderMaterial, Vector3} from 'three';
import {sharedUniforms} from "../js/map33/material/SharedUniforms";
import {NodeMan} from "../Globals";
import {CNodeGUIValue} from "./CNodeGUIValue";
import {CNodeGUIColor} from "./CNodeGUIColor";
import {par} from "../par";
import {installTerrestrialRefractionOnShaderMaterial} from "../atmosphere/terrestrialRefraction";

export class CNode3DLight extends CNode3D {
    constructor(v) {
        super(v);
        this.type = 'CNode3DLight';

        this.light = v.light; // the light objectm required for this node
        assert(this.light, "CNode3DLight requires a light object");

        // Store the GUI folder if provided
        this.gui = v.gui;

        // Initialize visibility control variables
        this.lightVisible = true;
        this.lightIlluminates = false;

        //const size = v.size || 4; // default size if not specified

        const size = this.light.intensity / 100;

// Create plane geometry
        const geometry = new PlaneGeometry(size, size); // adjust size as needed

// Shader material with HDR-style disk + falloff
        const material = new ShaderMaterial({
            uniforms: {
                ...sharedUniforms, // shared uniforms for near/far planes
                uColor: { value: [this.light.color.r, this.light.color.g, this.light.color.b] },
                uIntensity: { value: this.light.intensity }, // HDR "strength"
                uRadius: { value: 0.1 },     // proportion of core radius (hard center)

            },
            vertexShader: `
        varying vec2 vUv;
        varying float vDepth;
        
        void main() {
            vUv = uv;
            gl_Position = applyTerrestrialRefraction_clip(modelViewMatrix * vec4(position, 1.0));
            vDepth = gl_Position.w;
        }
    `,
            fragmentShader: `
        uniform vec3 uColor;
        uniform float uIntensity;
        uniform float uRadius;
        uniform float nearPlane; // these are set in sharedUniforms
        uniform float farPlane;

        varying vec2 vUv;
        varying float vDepth;

        void main() {
            vec2 centered = vUv - 0.5;
            float dist = length(centered) * 2.0; // fix scaling
            
            // Core disk
            float core = smoothstep(uRadius, uRadius - 0.05, dist);
            
            // Soft outer falloff
            float falloff = pow(clamp(1.0 - dist, 0.0, 1.0), 2.0);
            
            // Combine alpha
            float alpha = core + (1.0 - core) * falloff * 0.5;
            alpha = clamp(alpha, 0.0, 1.0);

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

            // uIntensity should not be used here because it's already applied in the shader
            // but we can still used for color
            // if it's large, then somethng like [1,0,0.01] will come out as magenta
            gl_FragColor = vec4(uColor, alpha);
        
        }
    `,
            transparent: true,
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
            this.addSimpleSerial("strobeOffset");
        }


// Create mesh
        const billboard = new Mesh(geometry, material);
        billboard.name = "LightBillboard";
        billboard.position.copy(this.light.position);
        
        // Disable raycasting on the light billboard so it doesn't interfere with context menu picking
        billboard.raycast = () => {};

// Add to scene
        v.scene.add(billboard);

// Save reference
        this._object = billboard;

        this.scene = v.scene; // save the scene for later use

        // Create GUI controls if GUI folder is provided
        if (this.gui) {
            this.createGUIControls();
        }

    }

    // Set the light's brightness. Intensity also drives the billboard's world size
    // (intensity/100), which is what makes a bright light read as a bigger glow rather
    // than just a whiter pixel. Public so a script can drive it — see
    // _resolveObjectControl, which lets `set <lightNodeId> 6000` reach here.
    setIntensity(value) {
        const v = Number(value);
        if (!isFinite(v) || v < 0) return;
        this.light.intensity = v;
        this._object.material.uniforms.uIntensity.value = v;
        const newSize = v / 100;
        this._object.geometry.dispose();
        this._object.geometry = new PlaneGeometry(newSize, newSize);
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
            onChange: (value) => {
                this.light.color.copy(value);
                this._object.material.uniforms.uColor.value = [this.light.color.r, this.light.color.g, this.light.color.b];
            }
        }, this.gui);

        // Radius control
        this.radiusControl = new CNodeGUIValue({
            id: this.id + "_radius",
            desc: "Radius",
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
        // Billboard visibility is controlled by lightVisible
        // (suppressBillboard hides just the billboard — set by the Long Exposure
        // renderer, which splats the light's true HDR flux instead; the
        // illumination of the scene is unaffected)
         if (this._object) {
            this._object.visible = this.lightVisible && !this.suppressBillboard;
        }
        
        // Light illumination is controlled by both lightVisible and lightIlluminates
        this.light.visible = this.lightVisible && this.lightIlluminates;
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
        const time = par.time;

        let strobeOn = false;

        // only need to check if both are non-zero
        if (this.strobeEvery && this.strobeLength) {
            const offsetTime = time + this.strobeOffset;
            strobeOn = offsetTime % this.strobeEvery < this.strobeLength;



            // if we've gone past the time to strobe then do it regardless of if it's in the flash window
            // this ensures we don't miss any very short flashes
            // (e.g. strobe every 1.01 seconds, but strobe length is 0.01 seconds)
            // since 0.01 is less than a frame, it would not always fall in the window
            if (this.lastStrobeTime !== undefined
                && (offsetTime - this.lastStrobeTime) > this.strobeEvery) {
                strobeOn = true;

            }


            if (strobeOn) {
                // reset time to last time we SHOULD have strobed
                // not the time we actually strobed
                // this maintains more consistent timing
                this.lastStrobeTime = offsetTime - offsetTime % this.strobeEvery
            }


            // Apply strobe to both billboard and light visibility
            if (this._object) {
                this._object.visible = this.lightVisible && strobeOn && !this.suppressBillboard;
            }
            this.light.visible = this.lightVisible && this.lightIlluminates && strobeOn;

        }
        else {
            // No strobe controls - use normal visibility settings
            this.updateVisibility();
        }
    }

    preRender(view) {
        const camera = view.camera;

        // make the billboard face the camera
        if (this._object) {
            this._object.lookAt(camera.position);
        }



        // const distance = this._object.position.distanceTo(view.camera.position);
        //
        // // Scale the billboard up a bit based on distance
        // const fovScale =  (distance ** 1.5)  / 10000 ; // adjust as needed
        //
        //
        // console.log("Scaling billboard for light: " + this.light.name + " with distance: " + distance + " and scale: " + fovScale);
        //
        // this._object.scale.set(fovScale, fovScale, 1); // scale uniformly in X and Y


        const camPos = camera.position;

        // get the world position of the light, which will be a child of some other object like a jet or a ship
        const objPos = this.light.getWorldPosition(new Vector3());

        const distance = camPos.distanceTo(objPos);
        const fovRadians = camera.fov * (Math.PI / 180);


        // boostScale function to adjust the size so that there's a minimum angular size
        function boostScale(S0, W, D, F, boost = 0.01) {
            const base = (S0 * W) / (2 * D);
            const addedAngle = boost * F / 2;
            const newS = (2 * D / W) * Math.tan(Math.atan(base) + addedAngle);
            return newS;
        }

        let newSize = boostScale(0.5, 5, distance, fovRadians, 0.01);

        // how daylight is it? get the sky color from the scene
        const sunNode = NodeMan.get("theSun", true);
        if (sunNode !== undefined) {
            const skyOpacity = sunNode.calculateSkyOpacity(camera.position);
            newSize *= (1.0 - skyOpacity); // scale down the size based on the sky opacity
        }

        // Compensate for parent group's scale (e.g. objectScale * objectSize)
        // so the billboard's world-space size is just newSize * geometrySize,
        // regardless of the parent's scale transform.
        const parentWorldScale = this._object.parent ? this._object.parent.getWorldScale(new Vector3()).x : 1;
        this._object.scale.setScalar(newSize / parentWorldScale);

        // CRITICAL: Force immediate matrix world update after changing scale
        //
        // When rendering multiple views with different cameras, each view's preRender() sets
        // a different scale based on camera distance. However, modifying an object's scale
        // does NOT automatically set the matrixWorldNeedsUpdate flag in Three.js. Without
        // this explicit updateMatrixWorld() call, the object's world matrix remains stale.
        //
        // This causes issues in multi-view rendering where whichever view renders second
        // experiences incorrect billboard behavior (disappearing at wrong distances). The
        // exact mechanism is unclear - it could be related to frustum culling using stale
        // bounding spheres, or other matrix-dependent calculations.
        //
        // Calling updateMatrixWorld() immediately after changing the scale ensures the
        // world matrix is current before the renderer processes this object.
        this._object.updateMatrixWorld();

        // AND - why is moveing camera with C not working right in:
        // - locked mode
        // - when frame > 0

    }

}