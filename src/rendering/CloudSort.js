import {BufferAttribute, DynamicDrawUsage, Matrix4} from "three";

const preparedScenes = new WeakMap();

// Runs after Three updates the displayed camera and before attribute uploads.
// Covers cube captures as well as normal views and planar reflections.
export function registerTransparentCamera(mesh) {
    let scene = mesh;
    while (scene.parent) scene = scene.parent;
    if (!scene.isScene) return;
    let objects = preparedScenes.get(scene);
    if (!objects) {
        objects = new Set();
        preparedScenes.set(scene, objects);
        const previous = scene.onBeforeRender;
        scene.onBeforeRender = function(renderer, sceneArg, camera, target) {
            previous.call(this, renderer, sceneArg, camera, target);
            for (const object of objects) {
                if (!object.layers.test(camera.layers)) continue;
                let ancestor = object;
                while (ancestor && ancestor.visible && ancestor !== this) ancestor = ancestor.parent;
                if (ancestor === this) object.userData.prepareTransparentCamera(camera);
            }
        };
    }
    objects.add(mesh);
    const geometry = mesh.geometry;
    const remove = () => { objects.delete(mesh); geometry.removeEventListener("dispose", remove); };
    geometry.addEventListener("dispose", remove);
}

// Preserve canonical particle data. Each camera has a cached permutation, and
// switching views only uploads that view's order; it never changes the cloud.
export class CloudSort {
    constructor(offsets, sizes, count) {
        this.offsets = offsets;
        this.sizes = sizes;
        this.count = count;
        this.views = new WeakMap();
        this.modelView = new Matrix4();
    }

    prepare(camera, mesh) {
        this.modelView.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld);
        const e = this.modelView.elements;
        // A common camera translation cannot change plane-depth ordering.
        const axis = [e[2], e[6], e[10]];
        let view = this.views.get(camera);
        if (!view) {
            view = {axis: [], offsets: new Float32Array(this.count * 3), sizes: new Float32Array(this.count * 2),
                depths: new Float64Array(this.count), order: Array.from({length: this.count}, (_, i) => i)};
            this.views.set(camera, view);
        }
        const changed = axis.some((v, i) => v !== view.axis[i]);
        if (changed) {
            for (let i = 0; i < this.count; i++) {
                view.depths[i] = axis[0] * this.offsets[3 * i] + axis[1] * this.offsets[3 * i + 1] + axis[2] * this.offsets[3 * i + 2];
            }
            view.order.sort((a, b) => view.depths[a] - view.depths[b] || a - b);
            view.order.forEach((source, dest) => {
                view.offsets.set(this.offsets.subarray(3 * source, 3 * source + 3), 3 * dest);
                view.sizes.set(this.sizes.subarray(2 * source, 2 * source + 2), 2 * dest);
            });
            view.axis = axis;
        }
        if (changed || this.current !== view) {
            mesh.geometry.getAttribute("instanceOffset").array.set(view.offsets);
            mesh.geometry.getAttribute("instanceSize").array.set(view.sizes);
            mesh.geometry.getAttribute("instanceOffset").needsUpdate = true;
            mesh.geometry.getAttribute("instanceSize").needsUpdate = true;
            this.current = view;
        }
    }
}

// The legacy cloud mesh stores four vertices per puff instead of instances.
// Keep its original positions/UVs and reorder only the six indices per quad.
export function installCloudQuadSort(mesh) {
    const geometry = mesh.geometry;
    const positions = geometry.getAttribute("position");
    const count = positions.count / 4;
    const offsets = new Float32Array(count * 3), sizes = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
        for (let j = 0; j < 4; j++) {
            offsets[3 * i] += positions.getX(4 * i + j) / 4;
            offsets[3 * i + 1] += positions.getY(4 * i + j) / 4;
            offsets[3 * i + 2] += positions.getZ(4 * i + j) / 4;
        }
    }
    const source = geometry.index.array.slice();
    const index = new BufferAttribute(source.slice(), 1).setUsage(DynamicDrawUsage);
    geometry.setIndex(index);
    const sorter = new CloudSort(offsets, sizes, count);
    // A lightweight destination lets both representations share depth ordering.
    const attributes = {instanceOffset: {array: new Float32Array(count * 3)}, instanceSize: {array: new Float32Array(count * 2)}};
    const destination = {matrixWorld: mesh.matrixWorld, geometry: {getAttribute: name => attributes[name]}};
    mesh.userData.prepareTransparentCamera = camera => {
        attributes.instanceOffset.needsUpdate = false;
        sorter.prepare(camera, destination);
        if (attributes.instanceOffset.needsUpdate) {
            sorter.current.order.forEach((sourceQuad, dest) => {
                index.array.set(source.subarray(6 * sourceQuad, 6 * sourceQuad + 6), 6 * dest);
            });
            index.needsUpdate = true;
        }
    };
}
