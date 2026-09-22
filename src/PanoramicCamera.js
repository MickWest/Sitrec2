import {HalfFloatType, LinearFilter, LinearSRGBColorSpace, ShaderMaterial, Vector2, Vector4, WebGLRenderTarget} from "three";
import {Globals, guiMenus, NodeMan, setRenderOne} from "./Globals";
import {CNode} from "./nodes/CNode";
import {applyFisheyeState, fisheye} from "./FisheyeProjection";
import {panoramaFaces, panoramaFaceCamera, panoramaFrame, panoramaProject} from "./rendering/PanoramaMath";
import {updateCameraFOVControls} from "./CameraFOVControls";

const defaults = {enabled: false, hfov: 180};
export const panoramic = {...defaults, get vfov() { return getPanoramaFrame().vfov; }};
const clamp = (value, max, fallback) => Number.isFinite(value) ? Math.max(1, Math.min(max, value)) : fallback;

export function getPanoramaFrame(view = NodeMan.get("lookView", false)) {
    return panoramaFrame(panoramic.hfov, view?.widthPx, view?.heightPx);
}

export function isPanoramicCamera(camera) {
    return panoramic.enabled && !!camera && (camera._panoramaProxyFor ?? camera) === NodeMan.get("lookCamera", false)?.camera;
}

export function applyPanoramicState() {
    panoramic.hfov = clamp(panoramic.hfov, 360, defaults.hfov);
    if (panoramic.enabled && fisheye.enabled) {
        fisheye.enabled = false;
        applyFisheyeState();
    }
    updateCameraFOVControls();
    setRenderOne(true);
}

export function zoomPanorama(factor) {
    panoramic.hfov *= factor;
    applyPanoramicState();
}

export function panoramicProjectVector(v, camera) {
    if (!isPanoramicCamera(camera)) return false;
    v.applyMatrix4(camera.matrixWorldInverse);
    panoramaProject(v, panoramic.hfov, panoramic.vfov);
    const distance = v.z;
    v.z = distance < camera.near || distance > camera.far ? 2 : 0;
    return true;
}

class CNodePanoramicCamera extends CNode {
    constructor(v) {
        super(v);
        // Older saves may contain panoVFOV. Ignore it: the view now determines VFOV.
        this.addSimpleSerials(["panoEnabled", "panoHFOV"]);
    }
    get panoEnabled() { return panoramic.enabled; }
    set panoEnabled(v) { panoramic.enabled = !!v; }
    get panoHFOV() { return panoramic.hfov; }
    set panoHFOV(v) { panoramic.hfov = v; }
    get panoVFOV() { return panoramic.vfov; }
    modDeserialize(v) { super.modDeserialize(v); applyPanoramicState(); }
    dispose() { Object.assign(panoramic, defaults); super.dispose(); }
}

export function setupPanoramicCamera() {
    if (!NodeMan.exists("PanoramicCamera")) new CNodePanoramicCamera({id: "PanoramicCamera"});
    const parent = guiMenus.cameraFOV;
    if (!parent) return;
    parent.folders.find(f => f._title === "Panoramic Camera")?.destroy();
    const folder = parent.addFolder("Panoramic Camera").close();
    folder.add(panoramic, "enabled").listen().name("Panoramic Camera").onChange(applyPanoramicState)
        .tooltip("Render a swept panorama with equal horizontal and vertical angular scale. VFOV follows the view's shape, with letterboxing at 180°. The look-view scroll wheel adjusts HFOV.");
    folder.add(panoramic, "hfov", 1, 360, 0.1).listen().name("Panorama HFOV °").onChange(applyPanoramicState)
        .tooltip("Horizontal angular span of the panorama. 360° wraps all the way around the camera.");
    folder.add(panoramic, "vfov", 0, 180, 0.1).listen().decimals(1).disable().name("Panorama VFOV °")
        .tooltip("Derived from HFOV and the view's aspect ratio to keep the same pixels per degree on both axes. At 180°, black bars fill any extra height.");
    Globals.panoramic = panoramic;
    updateCameraFOVControls();
}

// Cache the targets for up to six cropped perspective faces, avoiding GPU
// reallocations between faces. Reproject in linear colour, then apply exposure
// and sensor effects once to the assembled image.
export class PanoramicRenderer {
    constructor() {
        this.size = new Vector2();
        this.target = new WebGLRenderTarget(1, 1, {type: HalfFloatType, colorSpace: LinearSRGBColorSpace, depthBuffer: false});
        this.captures = [];
        this.material = new ShaderMaterial({
            uniforms: {
                tDiffuse: {value: null}, angularFov: {value: new Vector2()},
                forward: {value: null}, right: {value: null}, up: {value: null},
                bounds: {value: new Vector4()},
            },
            vertexShader: `varying vec2 vUv;
                void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
            fragmentShader: `
                varying vec2 vUv;
                uniform sampler2D tDiffuse;
                uniform vec2 angularFov;
                uniform vec3 forward, right, up;
                uniform vec4 bounds;
                void main() {
                    vec2 a = (vUv - 0.5) * angularFov;
                    vec3 d = vec3(sin(a.x)*cos(a.y), sin(a.y), -cos(a.x)*cos(a.y));
                    float z = dot(d, forward);
                    // Choose the cube face owning this ray, independently of
                    // its cropped capture rectangle. No rear seam triangles.
                    if (z <= 0.0 || z + 0.000001 < max(max(abs(d.x), abs(d.y)), abs(d.z))) discard;
                    vec2 p = vec2(dot(d, right), dot(d, up)) / z;
                    vec2 uv = (p - bounds.xz) / (bounds.yw - bounds.xz);
                    gl_FragColor = texture2D(tDiffuse, uv);
                }`,
            depthTest: false, depthWrite: false,
        });
    }

    render(view) {
        if (!view.visible || view.widthPx <= 0 || view.heightPx <= 0) return;
        const renderer = view.renderer;
        // Use the normal output sizing/letterbox path once, without drawing.
        view.renderTargetAndEffectsInternal(null, {setupOnly: true});
        renderer.getDrawingBufferSize(this.size);
        const width = this.size.x, height = this.size.y;
        const {vfov} = getPanoramaFrame(view);
        this.target.texture.type = view.renderTargetA.texture.type;
        this.target.setSize(width, height);
        renderer.setRenderTarget(this.target);
        renderer.clear(true, true, true);
        const camera = view.camera;
        const savedOffset = view.applyCameraOffset();
        camera.updateMatrixWorld(true);
        view._panoramaBaseCamera = camera;
        const density = Math.max(width / (panoramic.hfov * Math.PI / 180), height / (vfov * Math.PI / 180));
        const limit = Math.min(renderer.capabilities.maxTextureSize, Math.max(width, height) * 2);
        const faces = panoramaFaces(panoramic.hfov, vfov);
        const names = ["renderTargetAntiAliased", "renderTargetA", "renderTargetB"];
        const savedTargets = names.map(name => view[name]);
        try {
            for (let i = 0; i < faces.length; i++) {
                const face = {...faces[i], bounds: [...faces[i].bounds]};
                // Keep internal cube edges away from the mirror's texture-edge
                // fade and give ripple lookups a guard band. This changes only
                // capture coverage, never terrain selection or download LOD.
                const padX = (face.bounds[1] - face.bounds[0]) * 0.08;
                const padY = (face.bounds[3] - face.bounds[2]) * 0.08;
                face.bounds[0] -= padX; face.bounds[1] += padX;
                face.bounds[2] -= padY; face.bounds[3] += padY;
                const targets = this.captures[i] ??= savedTargets.map(target => {
                    const clone = target.clone();
                    clone.texture.minFilter = clone.texture.magFilter = LinearFilter;
                    return clone;
                });
                names.forEach((name, j) => { view[name] = targets[j]; });
                this.camera = panoramaFaceCamera(face, camera, this.camera);
                const [left, right, bottom, top] = face.bounds;
                const w = Math.max(2, Math.min(limit, Math.ceil((right - left) * density)));
                const h = Math.max(2, Math.min(limit, Math.ceil((top - bottom) * density)));
                view._panoramaCamera = this.camera;
                view._panoramaFace = {width: w, height: h};
                const source = view.renderTargetAndEffectsInternal(null, view._panoramaFace);
                const u = this.material.uniforms;
                u.tDiffuse.value = source.texture;
                u.angularFov.value.set(panoramic.hfov * Math.PI / 180, vfov * Math.PI / 180);
                u.forward.value = face.forward; u.right.value = face.right; u.up.value = face.up;
                u.bounds.value.set(...face.bounds);
                renderer.setRenderTarget(this.target);
                view.fullscreenQuad.material = this.material;
                renderer.render(view.fullscreenQuad, view.fullscreenQuadCamera);
            }
        } finally {
            view._panoramaCamera = null;
            view._panoramaFace = null;
            view._panoramaBaseCamera = null;
            names.forEach((name, j) => { view[name] = savedTargets[j]; });
            view.removeCameraOffset(savedOffset);
            camera.updateMatrixWorld(true);
        }
        // Release faces which disappear when the angular window narrows.
        for (const targets of this.captures.splice(faces.length)) targets.forEach(target => target.dispose());
        view.renderEffectsAndOutput(this.target, view.getColorPolicy());
    }

    dispose() {
        this.target.dispose(); this.material.dispose();
        this.captures.forEach(targets => targets.forEach(target => target.dispose()));
    }
}
