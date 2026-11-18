import {PerspectiveCamera} from "three";

// Run the camera node's normal pose controllers against a separate camera.
// In particular, NodeMan and every view keep pointing at the displayed camera,
// even inside a nested sample or if a controller throws.
export function createCameraPoseSample(node, camera = new PerspectiveCamera()) {
    const live = node.camera;
    camera.sampleSource = live.sampleSource ?? live;
    camera.position.copy(live.position);
    camera.quaternion.copy(live.quaternion);
    camera.up.copy(live.up);
    camera.fov = live.fov;
    camera.aspect = live.aspect;
    camera.near = live.near;
    camera.far = live.far;
    camera.layers.mask = live.layers.mask;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    camera.userData.geometricAim = null;
    camera.userData.angularSize = null;

    return Object.assign(Object.create(node), {
        _object: camera,
        isCameraSample: true,
        postApplyControllers: null,
        recordedLOS: undefined,
    });
}
