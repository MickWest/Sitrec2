import {Bone, Box3, InstancedMesh, Matrix4, Skeleton, SkinnedMesh, Sphere} from "three";

const instance = new Matrix4();
const box = new Box3();
const sphere = new Sphere();

// Three can apply skinning and then instancing in the same draw. Instances in
// this batch share a pose. Its private skeleton holds that pose in mesh space.
export class InstancedSkinnedMesh extends InstancedMesh {
    constructor(source, count) {
        super(source.geometry, source.material, count);
        this.isSkinnedMesh = true;
        this.skeleton = new Skeleton(source.skeleton.bones.map(() => new Bone()));
        // The ordinary skinned mesh supplies the same posed surface for picking.
        this.pose = new SkinnedMesh(source.geometry, source.material);
        this.pose.bind(this.skeleton, new Matrix4());
        this.bindMatrix = this.pose.bindMatrix;
        this.bindMatrixInverse = this.pose.bindMatrixInverse;
        this.capturePose(source);
    }

    capturePose(source) {
        const {bones, boneInverses} = source.skeleton;
        for (let i = 0; i < bones.length; i++) {
            // Combine in double precision before Three uploads the float palette.
            // Attached source bones can be millions of metres from the origin.
            this.skeleton.bones[i].matrixWorld.multiplyMatrices(source.bindMatrixInverse, bones[i].matrixWorld)
                .multiply(boneInverses[i]).multiply(source.bindMatrix);
        }
        this.pose.boundingBox = this.pose.boundingSphere = null;
        this.boundingBox = this.boundingSphere = null;
    }

    computeBoundingBox() {
        if (!this.pose.boundingBox) this.pose.computeBoundingBox();
        this.boundingBox ??= new Box3();
        this.boundingBox.makeEmpty();
        for (let i = 0; i < this.count; i++) {
            this.getMatrixAt(i, instance);
            this.boundingBox.union(box.copy(this.pose.boundingBox).applyMatrix4(instance));
        }
    }

    computeBoundingSphere() {
        if (!this.boundingBox) this.computeBoundingBox();
        this.boundingBox.getBoundingSphere(this.boundingSphere ??= new Sphere());
    }

    raycast(raycaster, hits) {
        if (!this.count) return;
        if (!this.boundingSphere) this.computeBoundingSphere();
        if (!raycaster.ray.intersectsSphere(sphere.copy(this.boundingSphere).applyMatrix4(this.matrixWorld))) return;
        this.pose.material = this.material;
        for (let i = 0; i < this.count; i++) {
            this.getMatrixAt(i, instance);
            this.pose.matrixWorld.multiplyMatrices(this.matrixWorld, instance);
            const first = hits.length;
            this.pose.raycast(raycaster, hits);
            for (let j = first; j < hits.length; j++) {
                hits[j].object = this;
                hits[j].instanceId = i;
            }
        }
    }

    dispose() {
        this.skeleton.dispose();
        super.dispose();
    }
}
