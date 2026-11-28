import {Group, Matrix4, Raycaster, Vector4} from "three";
import {prepareModelSkinning} from "../src/rendering/ModelSkinning";
import {InstancedSkinnedMesh} from "../src/rendering/InstancedSkinnedMesh";
import {PRESETS} from "../tools/vehicles/vehicleParameters.js";
import {buildVehicle, disposeVehicle} from "../tools/vehicles/vehicle.js";
import {poseVehicleSpinners} from "../tools/vehicles/motion.js";

const preset = PRESETS.find(item => item.id === "bird-pterodactyl").parameters;

// Inspect the actual float palette and bind uniforms used by the vertex shader.
// A CPU-only comparison of getVertexPosition on two meshes misses GPU rounding.
function shaderVertex(mesh, index) {
    const {position, skinIndex, skinWeight} = mesh.geometry.attributes;
    const bind = new Matrix4().fromArray(Float32Array.from(mesh.bindMatrix.elements));
    const vertex = new Vector4(position.getX(index), position.getY(index), position.getZ(index), 1).applyMatrix4(bind);
    const sum = new Vector4(0, 0, 0, 0), bone = new Matrix4();
    for (let j = 0; j < 4; j++) {
        bone.fromArray(mesh.skeleton.boneMatrices, 16 * skinIndex.getComponent(index, j));
        sum.addScaledVector(vertex.clone().applyMatrix4(bone), skinWeight.getComponent(index, j));
    }
    return sum.applyMatrix4(bind.fromArray(Float32Array.from(mesh.bindMatrixInverse.elements)));
}

test.each([[6, 2.65], [1.04, .46]])("a placed %s m wingspan reproduces the preview at Earth coordinates", (wingspan, length) => {
    const parameters = {...preset, wingspan, length};
    const preview = buildVehicle(parameters), placed = buildVehicle(parameters), parent = new Group();
    const update = prepareModelSkinning(placed.root);
    parent.add(placed.root);
    parent.position.set(-2565332, -4738849, 3409989);
    parent.rotation.set(.65, -.78, 1.13);
    try {
        for (const scale of [1, .1, 3]) {
            parent.scale.setScalar(scale);
            for (const beats of [0, .25, .5]) {
                for (const model of [preview, placed]) poseVehicleSpinners(model.waves, 0, true, {beats});
                preview.root.updateMatrixWorld(true);
                parent.updateMatrixWorld(true);
                update();
                for (const side of ["Left", "Right"]) {
                    const name = side + " flight membrane", reference = preview.root.getObjectByName(name), mesh = placed.root.getObjectByName(name);
                    mesh.skeleton.update();
                    for (let i = 0; i < mesh.geometry.attributes.position.count; i += 19) {
                        const expected = reference.getVertexPosition(i, parent.position.clone()), actual = shaderVertex(mesh, i);
                        expect(Math.hypot(actual.x - expected.x, actual.y - expected.y, actual.z - expected.z)).toBeLessThan(1e-5);
                    }
                }
            }
        }
    } finally {
        disposeVehicle(preview.root);
        disposeVehicle(placed.root);
    }
});

test("flock batches keep independent membrane poses in the same local coordinates as a single bird", () => {
    const model = buildVehicle(preset), parent = new Group();
    parent.add(model.root);
    parent.position.set(-2565332, -4738849, 3409989);
    parent.rotation.set(.65, -.78, 1.13);
    const update = prepareModelSkinning(model.root);
    const source = model.root.getObjectByName("Left flight membrane");
    const batches = [new InstancedSkinnedMesh(source, 3), new InstancedSkinnedMesh(source, 2)];
    try {
        const snapshots = batches.map((batch, i) => {
            poseVehicleSpinners(model.waves, 0, true, {beats: i * .5});
            parent.updateMatrixWorld(true);
            update();
            batch.capturePose(source);
            batch.skeleton.update();
            return Array.from({length: source.geometry.attributes.position.count}, (_, v) =>
                source.getVertexPosition(v, source.position.clone()));
        });
        const movement = snapshots[0].map((v, i) => v.distanceTo(snapshots[1][i]));
        expect(Math.max(...movement)).toBeGreaterThan(preset.wingspan * .2);
        for (const [i, batch] of batches.entries()) {
            expect(batch.geometry).toBe(source.geometry);
            for (let v = 0; v < snapshots[i].length; v += 9) {
                const expected = snapshots[i][v], actual = shaderVertex(batch, v);
                expect(Math.hypot(actual.x - expected.x, actual.y - expected.y, actual.z - expected.z)).toBeLessThan(1e-5);
                expect(batch.pose.getVertexPosition(v, source.position.clone()).distanceTo(expected)).toBeLessThan(1e-7);
            }
        }
        // Pick a triangle on the downstroke of the second instance. The
        // visible membrane extends beyond the unposed geometry's bounds.
        const batch = batches[1], points = snapshots[1], indices = source.geometry.index;
        const triangle = Math.floor(indices.count / 3 * .45) * 3;
        const [a, b, c] = [0, 1, 2].map(j => points[indices.getX(triangle + j)]);
        const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
        const center = a.clone().add(b).add(c).multiplyScalar(1 / 3);
        center.x += 50;
        batch.setMatrixAt(1, new Matrix4().makeTranslation(50, 0, 0));
        const hits = new Raycaster(center.clone().addScaledVector(normal, .001), normal.negate(), 0, .002)
            .intersectObject(batch);
        expect(hits[0]?.object).toBe(batch);
        expect(hits[0]?.instanceId).toBe(1);
        expect(hits[0].point.distanceTo(center)).toBeLessThan(1e-6);
    } finally {
        for (const batch of batches) batch.dispose();
        disposeVehicle(model.root);
    }
});
