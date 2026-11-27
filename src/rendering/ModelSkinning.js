import {AttachedBindMode, Bone, DetachedBindMode, Matrix4, Skeleton} from "three";

// Three sends bone matrices to the GPU as floats. At Earth coordinates their
// translations round to half-metre steps before the shader can subtract the
// mesh position. Animate the original joints, but give each placed mesh a
// detached skeleton expressed in its own bind frame.
export function prepareModelSkinning(model) {
    const skins = [];
    model.traverse(mesh => {
        if (!mesh.isSkinnedMesh || mesh.bindMode !== AttachedBindMode) return;
        const {bones, boneInverses} = mesh.skeleton;
        const localBones = bones.map(() => new Bone());
        mesh.bindMode = DetachedBindMode;
        mesh.bind(new Skeleton(localBones, boneInverses), mesh.bindMatrix);
        skins.push({mesh, bones, localBones});
    });
    if (!skins.length) return;

    const worldToBind = new Matrix4();
    function update() {
        for (const {mesh, bones, localBones} of skins) {
            // Attached skinning ends with inverse(meshWorld). Detached skinning
            // ends with inverse(bindMatrix), so fold bindMatrix * inverse(meshWorld)
            // into each bone in double precision, before the float upload.
            worldToBind.copy(mesh.matrixWorld).invert().premultiply(mesh.bindMatrix);
            for (let i = 0; i < bones.length; i++) {
                localBones[i].matrixWorld.multiplyMatrices(worldToBind, bones[i].matrixWorld);
            }
        }
    }
    model.updateWorldMatrix(true, true);
    update();
    return update;
}
