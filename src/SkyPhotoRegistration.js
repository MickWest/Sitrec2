import {BufferGeometry, CanvasTexture, DoubleSide, Float32BufferAttribute, Mesh, MeshBasicMaterial, Scene, SRGBColorSpace, Vector3} from "three";
import {GlobalDateTimeNode, NodeMan} from "./Globals";
import {par} from "./par";
import {applyAnnualAberration, getAberrationVOverC, getECEFToEQJMatrix, getEQJToECEFMatrix} from "./CelestialMath";
import {installFisheyeOnMaterial} from "./FisheyeProjection";
import {photoPixelToSky, skyToPhotoPixel} from "./starTrack/SkyPhotoPlate";

export function activeSkyPhoto(video = NodeMan.get("video", false)) {
    const controller = NodeMan.get("starTrackCameraController", false);
    const plate = controller?.registerPhotoInSky && controller.photoRegistration;
    if (!plate || plate.version !== 1 || !video?.videoData?.img || plate.source !== (video.imageFileID || video.fileName)
        || plate.width !== video.videoWidth || plate.height !== video.videoHeight) return null;
    return plate;
}

// The input is an apparent ECEF direction. Invert the same aberration used to
// draw the stars, then project through the saved plate, never through Look.
export function skyPhotoProjector(plate, date) {
    const inverse = getECEFToEQJMatrix(date);
    const velocity = getAberrationVOverC(date).clone();
    const v = new Vector3();
    return direction => {
        v.copy(direction).transformDirection(inverse);
        const dot = v.dot(velocity);
        v.multiplyScalar(dot + Math.sqrt(1 - velocity.lengthSq() + dot * dot)).sub(velocity);
        return skyToPhotoPixel(plate, [v.x, v.y, v.z]);
    };
}

export function registeredPhotoCamera(plate, sourceCamera, date) {
    const camera = sourceCamera.clone();
    const matrix = getEQJToECEFMatrix(date);
    const direction = (x, y) => applyAnnualAberration(new Vector3(...photoPixelToSky(plate, x, y)), date)
        .transformDirection(matrix);
    const center = direction(plate.width / 2, plate.height / 2);
    const above = direction(plate.width / 2, plate.height * 0.4);
    // Used for compass tick spacing; it must not inherit Look's current zoom.
    camera.fov = Math.min(179, center.angleTo(above) * 180 / Math.PI * 10);
    camera.up.copy(above.addScaledVector(center, -above.dot(center)).normalize());
    camera.lookAt(camera.position.clone().add(center));
    camera.updateMatrixWorld(true);
    camera._skyPhotoProject = skyPhotoProjector(plate, date);
    camera._skyPhotoPlate = plate;
    return camera;
}

const renderers = new WeakMap();
export function disposeSkyPhoto(controller) {
    const state = renderers.get(controller);
    if (state) {
        state.mesh.geometry.dispose();
        state.mesh.material.dispose();
        state.texture.dispose();
        renderers.delete(controller);
    }
}

function createRenderer(controller, plate) {
    disposeSkyPhoto(controller);
    const canvas = document.createElement("canvas");
    canvas.width = plate.width;
    canvas.height = plate.height;
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const material = new MeshBasicMaterial({map: texture, transparent: true, depthTest: false,
        depthWrite: false, side: DoubleSide, toneMapped: false});
    installFisheyeOnMaterial(material);
    const positions = [], uv = [], indices = [], directions = [], valid = [];
    const steps = 128, row = steps + 1;
    for (let y = 0; y <= steps; y++) for (let x = 0; x <= steps; x++) {
        const ray = photoPixelToSky(plate, plate.width * x / steps, plate.height * y / steps);
        valid.push(!!ray);
        directions.push(...(ray ?? [0, 0, 1]));
        positions.push(0, 0, 0);
        uv.push(x / steps, 1 - y / steps);
    }
    for (let y = 0; y < steps; y++) for (let x = 0; x < steps; x++) {
        const a = y * row + x, b = a + 1, c = a + row, d = c + 1;
        if (valid[a] && valid[b] && valid[c]) indices.push(a, c, b);
        if (valid[b] && valid[c] && valid[d]) indices.push(b, c, d);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new Float32BufferAttribute(uv, 2));
    geometry.setIndex(indices);
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    const scene = new Scene();
    scene.add(mesh);
    const state = {plate, canvas, texture, mesh, scene, directions};
    renderers.set(controller, state);
    return state;
}

// Draw inside the 3D projection, including panorama faces and the fisheye lens.
// Depth is intentionally ignored, like the existing photo overlay.
export function renderSkyPhoto(view) {
    if (view.id !== "lookView") return;
    const video = NodeMan.get("video", false), plate = activeSkyPhoto(video);
    const mirror = NodeMan.get("mirrorVideo", false);
    if (!plate || !mirror?.visible || mirror.transparency <= 0) return;
    const controller = NodeMan.get("starTrackCameraController");
    let state = renderers.get(controller);
    if (state?.plate !== plate) state = createRenderer(controller, plate);
    const image = video.videoData.rotatedImage ?? video.videoData.img;
    const adjusted = video.getAdjustedVideoFrameSource(image, par.frame);
    if (state.image !== adjusted.sourceImage || state.filter !== adjusted.filter) {
        const ctx = state.canvas.getContext("2d");
        ctx.clearRect(0, 0, plate.width, plate.height);
        ctx.filter = adjusted.filter || "none";
        ctx.drawImage(adjusted.sourceImage, 0, 0, plate.width, plate.height);
        state.texture.needsUpdate = true;
        state.image = adjusted.sourceImage;
        state.filter = adjusted.filter;
    }
    const date = GlobalDateTimeNode.frameToDate(par.frame);
    const radius = Math.min(view.camera.far * 0.5, 1e7);
    if (state.time !== +date || state.radius !== radius) {
        const matrix = getEQJToECEFMatrix(date), v = new Vector3();
        const position = state.mesh.geometry.getAttribute("position");
        for (let i = 0; i < position.count; i++) {
            v.fromArray(state.directions, i * 3);
            applyAnnualAberration(v, date).transformDirection(matrix).multiplyScalar(radius);
            position.setXYZ(i, v.x, v.y, v.z);
        }
        position.needsUpdate = true;
        state.time = +date;
        state.radius = radius;
    }
    state.mesh.material.opacity = mirror.transparency;
    const camera = view.camera.clone();
    camera.layers.enableAll();
    camera.position.set(0, 0, 0);
    camera.updateMatrixWorld(true);
    // Keep the exact render-scoped projection (panorama face, zoom, lens).
    const autoClear = view.renderer.autoClear;
    view.renderer.autoClear = false;
    try { view.renderer.render(state.scene, camera); }
    finally { view.renderer.autoClear = autoClear; }
}
