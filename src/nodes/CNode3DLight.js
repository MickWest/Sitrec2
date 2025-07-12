import {CNode3D} from "./CNode3D";
import {assert} from "../assert";
import {
    SphereGeometry,
    MeshBasicMaterial,
    PlaneGeometry,
    ShaderMaterial,
    Mesh,
    AdditiveBlending,
    Color
} from 'three';
import {sharedUniforms} from "../js/map33/material/SharedUniforms";

export class CNode3DLight extends CNode3D {
    constructor(v) {
        super(v);
        this.type = 'CNode3DLight';

        this.light = v.light; // the light objectm required for this node
        assert(this.light, "CNode3DLight requires a light object");

        console.log("CNode3DLight created for light: " + this.light.name);

// Create plane geometry
        const geometry = new PlaneGeometry(16, 16); // adjust size as needed

// Shader material with HDR-style disk + falloff
        const material = new ShaderMaterial({
            uniforms: {
                ...sharedUniforms, // shared uniforms for near/far planes
                uColor: { value: new Color(1.0, 1.0, 1.0) },
                uIntensity: { value: 5.0 }, // HDR "strength"
                uRadius: { value: 0.3 },     // core radius (hard center)

            },
            vertexShader: `
        varying vec2 vUv;
        varying float vDepth;
        
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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
            // and vDepth to be passed from the vertex shader from gl_Position.w
            float z = (log2(max(nearPlane, 1.0 + vDepth)) / log2(1.0 + farPlane)) * 2.0 - 1.0;
            gl_FragDepthEXT = z * 0.5 + 0.5;

            gl_FragColor = vec4(uColor * uIntensity, alpha);
        }
    `,
            transparent: true,
            depthWrite: false,
            blending: AdditiveBlending
        });

// Create mesh
        const billboard = new Mesh(geometry, material);
        billboard.name = "LightBillboard";
        billboard.position.copy(this.light.position);

// Add to scene
        v.scene.add(billboard);

// Save reference
        this._object = billboard;




    }

    dispose() {
        if (this._object) {
            this._object.geometry.dispose();
            this._object.material.dispose();
            this._object = null;
        }
    }

    preRender(view) {
        const camera = view.camera;

        // make the billboard face the camera
        if (this._object) {
            this._object.lookAt(camera.position);
        }

        // // maybe sclae the billboard based on distance to camera?
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
        const objPos = this._object.position;

        const distance = camPos.distanceTo(objPos);

// Instead of scale ∝ 1 / distance
        const scaleFactor = 1 / Math.sqrt(distance);

// Adjust base size as needed
        const baseSize = 20; // tweak this
        this._object.scale.setScalar(scaleFactor * baseSize);

    }


    update() {
    }
}