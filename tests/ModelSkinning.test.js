import {Group, Matrix4, Vector4} from "three";
import {prepareModelSkinning} from "../src/rendering/ModelSkinning";
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
