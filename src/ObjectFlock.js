// ObjectFlock.js - draws a CNode3DObject as a flock of birds.
//
// FlockModel.js says where each bird is relative to the flock. This file turns that
// into the world: it takes the path from the object's track, works out which way the
// formation faces, points and banks each bird along its own motion, and draws them
// all as instances of the object's own geometry or model.
//
// THE FLOCK'S GROUP IS A CHILD OF THE OBJECT'S GROUP, WITH THE PARENT'S ROTATION AND
// SCALE CANCELLED. A child, because everything that acts on the object then acts on the
// flock with no code here: show/hide, the per-view hiding in CustomSupport, layer masks,
// shadow flags, the environment map hiding the object from its own reflection, and a
// click on a bird selecting the object. Cancelled, because that group is scaled (size,
// model length, Main View Scale) and rolled (banking, the rotateX/Y/Z fix-ups), and
// both would otherwise be applied to the SPACING of the flock as well as to each bird.
// What is left is the object's position and nothing else: see syncTransform().
//
// WHY THAT MATTERS FOR PRECISION. The world frame is ECEF, some 6.4 million meters from
// the origin, where a 32-bit float moves in steps of half a meter. The group's matrix
// is held in double precision; the instance matrices, which ARE 32-bit, only ever hold
// a bird's offset from it - tens of meters, exact to microns.

import {DynamicDrawUsage, Group, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, Vector3} from "three";
import {Globals, markShadowCastersDirty, setRenderOne, Sit} from "./Globals";
import {getLocalNorthVector, getLocalUpVector} from "./SphericalMath";
import {patchMaterialForLinearOutput} from "./threeExt";
import {FLOCK_FORMATIONS, FLOCK_SPECIES, flockDefaults, FlockModel} from "./FlockModel";
import {t} from "./i18n";

// key, min, max, step. Labels and tooltips are nodes3dObject.flock.<key> in the locale.
const flockSliders = [
    ["count", 1, 500, 1],
    ["vNess", 0, 1, 0.01],
    ["vAngle", 10, 180, 1],
    ["asymmetry", -1, 1, 0.01],
    ["shapeDrift", 0, 1, 0.01],
    ["groupSize", 2, 100, 1],
    ["frontDepth", 0.05, 1, 0.01],
    ["elongation", 1, 5, 0.1],
    ["longAxis", 0, 180, 1],
    ["spacing", 0.2, 50, 0.1],
    ["looseness", 0, 2, 0.01],
    ["snaking", 0, 5, 0.01],
    ["wanderPeriod", 0.5, 30, 0.1],
    ["verticalSpread", 0, 1, 0.01],
    ["placeChange", 0, 300, 1],
    ["wheeling", 0, 500, 0.5],
    ["wheelPeriod", 2, 120, 0.5],
    ["turnLag", 0, 60, 0.5],
    ["seed", 1, 1000, 1],
];

// Which formations each control means anything in. A control not listed here
// applies to them all.
const LINE_FORMATIONS = ["V", "Echelon", "Line Astern", "Line Abreast"];
const sliderFormations = {
    vNess: LINE_FORMATIONS,
    groupSize: LINE_FORMATIONS,
    snaking: LINE_FORMATIONS,
    vAngle: ["V", "Echelon"],
    asymmetry: ["V", "Echelon"],
    shapeDrift: ["V", "Echelon"],
    frontDepth: ["Irregular Front"],
    elongation: ["Cluster"],
    longAxis: ["Cluster"],
};

// Velocity and acceleration come from positions this far either side of now.
// Shorter, and a track sampled once a frame gives a spiky second difference.
const DERIVATIVE_SECONDS = 0.25;
const MAX_BANK = Math.PI / 3;
const GRAVITY = 9.81;
// A bird flies forward. Where the path gives it no speed to speak of (an object at a fixed
// point, or a very slow track), its small wander would otherwise BE its velocity, and its
// nose would swing right round the compass. It is given at least this much airspeed along
// the way the flock is going, so that its nose only ever moves a little off that.
const MIN_AIRSPEED = 3;         // m/s
const MIRROR_X = new Matrix4().makeScale(-1, 1, 1);
const CRUISE_CHORDS = 16;

export class ObjectFlock {
    constructor(owner, savedParams = {}) {
        this.owner = owner;
        this.params = {...flockDefaults, ...savedParams};
        this.model = new FlockModel(this.params);
        this.enabled = false;

        this.group = new Group();
        this.group.name = owner.id + "_flock";
        this.group.visible = false;
        this.group.matrixAutoUpdate = false;        // set by syncTransform(), not from position
        owner.group.add(this.group);

        this.parts = [];            // {mesh, relative, ownsMaterial}, one per mesh of the bird
        this.capacity = 0;
        this.poseCount = 0;
        this.positions = new Float64Array(0);       // meters from this.group, world axes
        this.quaternions = new Float64Array(0);
        this.offsets = [new Float64Array(0), new Float64Array(0), new Float64Array(0)];
        this.writtenScale = undefined;
        this.posesDirty = true;
        this.lastChecksum = undefined;

        // Scratch, so that a frame of 5000 birds allocates nothing.
        this.frames = [0, 1, 2].map(() => ({
            center: new Vector3(), forward: new Vector3(), right: new Vector3(),
        }));
        this.up = new Vector3();
        this.scratch = {
            a: new Vector3(), b: new Vector3(), c: new Vector3(), wheel: [0, 0, 0],
            x: new Vector3(), y: new Vector3(), z: new Vector3(),
            basis: new Matrix4(), bird: new Matrix4(), instance: new Matrix4(), world: new Matrix4(),
            quaternion: new Quaternion(), userRotation: new Quaternion(), axis: new Quaternion(),
            position: new Vector3(), scale: new Vector3(),
        };
    }

    // ---- the parameter folder ------------------------------------------------

    buildGUI(parentGui, afterName) {
        this.folder = parentGui.addFolder(t("nodes3dObject.flock.folder")).close();
        this.folder.moveAfter(afterName);
        this.controllers = {};

        const changed = () => {
            // A species is a starting point. Once a control has been moved off what the
            // species set, the flock is the user's own.
            const species = FLOCK_SPECIES[this.params.species];
            if (species && Object.entries(species.params).some(([key, value]) => this.params[key] !== value)) {
                this.params.species = "Custom";
            }
            this.model.setParams(this.params);
            this.syncControllers();
            if (this.model.count > this.capacity) this.rebuildMeshes();
            setRenderOne(true);
        };

        this.controllers.species = this.folder.add(this.params, "species", ["Custom", ...Object.keys(FLOCK_SPECIES)])
            .name(t("nodes3dObject.flock.species.label"))
            .listen().onChange((name) => {
                if (FLOCK_SPECIES[name]) Object.assign(this.params, FLOCK_SPECIES[name].params);
                changed();
            });

        this.controllers.formation = this.folder.add(this.params, "formation", FLOCK_FORMATIONS)
            .name(t("nodes3dObject.flock.formation.label"))
            .tooltip(t("nodes3dObject.flock.formation.tooltip"))
            .listen().onChange(changed);

        for (const [key, min, max, step] of flockSliders) {
            this.controllers[key] = this.folder.add(this.params, key, min, max, step)
                .name(t(`nodes3dObject.flock.${key}.label`))
                .tooltip(t(`nodes3dObject.flock.${key}.tooltip`))
                .listen().onChange(changed);
        }
        // Push against the top of the slider and the range doubles, so a flock of
        // thousands is reachable without making six birds hard to set.
        this.controllers.count.elastic(100, 100000, true);
        this.controllers.formation.moveToFirst();
        this.controllers.count.moveToFirst();
        this.controllers.species.moveToFirst();

        this.syncControllers();
        this.folder.show(this.enabled);
    }

    syncControllers() {
        if (!this.controllers) return;
        // The species cannot set the size of a bird or the speed of the flock, so its
        // tooltip says what they should be.
        const about = FLOCK_SPECIES[this.params.species]?.about;
        this.controllers.species.tooltip(t("nodes3dObject.flock.species.tooltip") + (about ? " " + about : ""));
        for (const [key, formations] of Object.entries(sliderFormations)) {
            this.controllers[key].show(formations.includes(this.params.formation));
        }
    }

    setEnabled(enabled, openFolder = false) {
        this.enabled = !!enabled;
        this.folder?.show(this.enabled);
        if (this.enabled && openFolder) this.folder?.open();
        this.rebuildMeshes();
        this.posesDirty = true;
    }

    serialize() {
        return {...this.params};
    }

    isDefault() {
        return Object.keys(flockDefaults).every(key => this.params[key] === flockDefaults[key]);
    }

    deserialize(savedParams = {}) {
        Object.assign(this.params, flockDefaults, savedParams);
        this.model.setParams(this.params);
        this.syncControllers();
    }

    // ---- the meshes ------------------------------------------------------------

    // Called whenever the object rebuilds its geometry, material or model: the
    // instanced meshes share those, so they have to be remade with them.
    rebuildMeshes() {
        this.disposeMeshes();
        const owner = this.owner;

        this.group.visible = this.enabled;
        this.showSingleObject(true);
        if (!this.enabled) return;

        const count = this.model.count;
        this.capacity = 1;
        while (this.capacity < count) this.capacity *= 2;

        if (owner.modelOrGeometry === "model") {
            if (owner.model) {
                // Each mesh of the model becomes one instanced mesh, placed where it sits
                // within the model. `relative` takes it from the object's group to there.
                owner.group.updateMatrixWorld(true);
                const groupInverse = new Matrix4().copy(owner.group.matrixWorld).invert();
                owner.model.traverse(child => {
                    if (!child.isMesh || child.userData?.sitrecGaussianSplat) return;
                    const relative = new Matrix4().multiplyMatrices(groupInverse, child.matrixWorld);
                    this.addPart(child.geometry, child.material, relative, false);
                });
            }
        } else if (owner.geometry) {
            let material = owner.material;
            let ownsMaterial = false;
            if (owner.common.wireframe || owner.common.edges) {
                // The single object draws these as thick scene lines, which cannot be
                // instanced. A plain wireframe of the same color is the nearest thing.
                material = patchMaterialForLinearOutput(new MeshBasicMaterial({
                    color: owner.material?.color ?? 0xffffff, wireframe: true,
                }));
                ownsMaterial = true;
            }
            this.addPart(owner.geometry, material, null, ownsMaterial);
        }

        // The flock REPLACES the single object, which stays in the scene, unseen: the
        // bounding box, the export and the ground clamp all still read it. But only when
        // there IS a flock to draw. A point cloud or a splat has no mesh to make instances
        // of, and a model may still be loading: the object must not just vanish.
        this.showSingleObject(this.parts.length === 0);

        this.syncLayers(true);
        this.refreshShadowFlags();
        this.writtenScale = undefined;
        this.posesDirty = true;
    }

    showSingleObject(visible) {
        if (this.owner.object) this.owner.object.visible = visible;
        if (this.owner.model) this.owner.model.visible = visible;
    }

    addPart(geometry, material, relative, ownsMaterial) {
        const mesh = new InstancedMesh(geometry, material, this.capacity);
        mesh.instanceMatrix.setUsage(DynamicDrawUsage);
        mesh.count = 0;
        // A part that is MIRRORED within its model (a wing made as the other wing with a
        // scale of -1) has its faces wound the other way. three.js allows for that from
        // the mesh's own world matrix, and here the mirror is inside the instance matrix,
        // where it cannot see it. So the mesh carries the mirror, and each instance
        // matrix is mirrored back: mirror x (mirror x bird x relative) is what is wanted.
        const mirrored = !!relative && relative.determinant() < 0;
        if (mirrored) mesh.scale.x = -1;
        mesh.updateMatrix();
        // The gradient material shades each bird about the BIRD's center. An instance
        // matrix places a PART of the bird, so the shader is told where, in the part's own
        // frame, the bird's center is: the origin, taken back through `relative`.
        const partOrigin = relative ? new Vector3().setFromMatrixPosition(new Matrix4().copy(relative).invert())
            : new Vector3();
        mesh.onBeforeRender = (renderer, scene, camera, geometryDrawn, materialDrawn) => {
            const uniform = materialDrawn.uniforms?.flockPartOrigin;
            if (!uniform) return;
            uniform.value.copy(partOrigin);
            materialDrawn.uniformsNeedUpdate = true;       // it is one material, shared by every part
        };
        // One draw call for the lot, and the birds move every frame, so a bounding
        // sphere to cull against would cost more to keep up than it could save.
        mesh.frustumCulled = false;
        this.group.add(mesh);
        this.parts.push({mesh, relative, ownsMaterial, mirrored});
    }

    disposeMeshes() {
        for (const part of this.parts) {
            this.group.remove(part.mesh);
            part.mesh.dispose();                    // the instance buffers only
            if (part.ownsMaterial) part.mesh.material.dispose();
        }
        this.parts = [];
    }

    syncLayers(force = false) {
        const mask = this.owner.group.layers.mask;
        if (!force && this.group.layers.mask === mask) return;
        this.group.layers.mask = mask;
        for (const part of this.parts) part.mesh.layers.mask = mask;
    }

    refreshShadowFlags() {
        const want = !!Globals.shadowsEnabled;
        for (const part of this.parts) {
            part.mesh.castShadow = want;
            part.mesh.receiveShadow = want;
        }
    }

    // ---- where the flock is ------------------------------------------------------

    // The path at frame f, relative to the path at frame f0. Zero for an object that
    // is not on a track: its flock then holds station about the one point.
    pathPoint(track, f, reference, out) {
        if (!track) return out.set(0, 0, 0);
        return out.copy(track.p(f)).sub(reference);
    }

    horizontal(v) {
        return v.addScaledVector(this.up, -v.dot(this.up));
    }

    // Center of the flock: the path, plus the wheeling, which is laid out along the
    // direction the PATH is going (north, if it is going nowhere).
    flockCenter(track, f, reference, out) {
        const s = this.scratch;
        this.pathPoint(track, f, reference, out);
        if (!(this.params.wheeling > 0)) return out;

        const halfSpan = this.framesPerSecond * DERIVATIVE_SECONDS;
        const along = this.pathPoint(track, f + halfSpan, reference, s.a)
            .sub(this.pathPoint(track, f - halfSpan, reference, s.b));
        this.horizontal(along);
        if (along.lengthSq() < 1e-6) along.copy(this.north);
        along.normalize();
        const across = s.b.crossVectors(along, this.up);

        const wheel = this.model.wheelOffset(f / this.framesPerSecond, s.wheel);
        return out.addScaledVector(along, wheel[0])
            .addScaledVector(across, wheel[1])
            .addScaledVector(this.up, wheel[2]);
    }

    // Where the flock is and which way the formation faces, at frame f.
    //
    // The heading is the chord of the flock's OWN path (wheeling included, or a flock
    // circling a fixed point would fly sideways) from turnLag seconds ago to now. On a
    // steady turn a chord trails the true heading, which is the lag: at zero the
    // formation swings round with every turn, as a skein of geese does; at tens of
    // seconds it barely turns at all, and the birds that led into a turn come out of it
    // on the flank, as starlings and pigeons do.
    formationFrame(track, f, reference, frame) {
        const s = this.scratch;
        const halfSpan = this.framesPerSecond * DERIVATIVE_SECONDS;
        const lag = this.framesPerSecond * Math.max(0, this.params.turnLag);

        this.flockCenter(track, f, reference, frame.center);
        const forward = this.flockCenter(track, f + halfSpan, reference, frame.forward);
        forward.sub(this.flockCenter(track, f - halfSpan - lag, reference, s.c));
        this.horizontal(forward);
        if (forward.lengthSq() < 1e-6) forward.copy(this.north);
        forward.normalize();
        frame.right.crossVectors(forward, this.up);
    }

    // Leave this group with the object's POSITION and none of its rotation or scale:
    // local = inverse(parent world) x translation(parent's world position).
    //
    // Called whenever the object's group changes: it is rolled and re-scaled for each
    // view in preRender, and put back in postRender.
    syncTransform() {
        const s = this.scratch;
        const parent = this.owner.group;
        parent.updateWorldMatrix(true, false);
        s.world.makeTranslation(s.position.setFromMatrixPosition(parent.matrixWorld));
        this.group.matrix.copy(parent.matrixWorld).invert().multiply(s.world);
        this.group.matrixWorld.copy(s.world);
        for (const part of this.parts) part.mesh.matrixWorld.multiplyMatrices(s.world, part.mesh.matrix);
    }

    // How fast the flock flies on the whole, in m/s: the length of the path over the time
    // it takes, plus what the wheeling adds. The model uses it to keep the birds' own
    // motion to what a bird can do, and needs it to be ONE number for the whole path, so
    // it is measured over all of the track and not at the current frame. A few chords
    // are enough, and cost nothing next to the birds.
    cruiseSpeed(track) {
        let speed = 0;
        const lastFrame = (Sit.frames ?? 1) - 1;
        if (track && lastFrame > 0) {
            let length = 0;
            let from = track.p(0);
            for (let chord = 1; chord <= CRUISE_CHORDS; chord++) {
                const to = track.p(lastFrame * chord / CRUISE_CHORDS);
                length += to.distanceTo(from);
                from = to;
            }
            speed = length / (lastFrame / this.framesPerSecond);
        }
        const wheeling = this.params.wheeling;
        if (wheeling > 0) speed += 0.7 * wheeling * 2 * Math.PI / Math.max(this.params.wheelPeriod, 0.5);
        return speed;
    }

    // Work out every bird's position and attitude for frame f. Writes no matrices:
    // those depend on the view's scale, and are written by preRender().
    update(f) {
        const owner = this.owner;
        if (!this.enabled || this.parts.length === 0) return;
        this.syncLayers();

        const count = this.model.count;
        if (this.poseCount !== count) {
            this.poseCount = count;
            this.positions = new Float64Array(3 * count);
            this.quaternions = new Float64Array(4 * count);
            this.offsets = this.offsets.map(() => new Float64Array(3 * count));
        }

        // Each frame is simSpeed/fps seconds of the world.
        this.framesPerSecond = Sit.fps / (Sit.simSpeed ?? 1);
        const seconds = Math.max(DERIVATIVE_SECONDS, 2 / this.framesPerSecond);
        const span = seconds * this.framesPerSecond;

        // The object's own position, not the track's: the ground clamp may have moved it.
        const origin = owner.group.getWorldPosition(this.scratch.position);
        this.up.copy(getLocalUpVector(origin));
        this.north = getLocalNorthVector(origin);

        const track = owner.getSourceTrack();
        const reference = track ? track.p(f) : null;
        this.model.cruiseSpeed = this.cruiseSpeed(track);
        for (let sample = 0; sample < 3; sample++) {
            this.formationFrame(track, f + (sample - 1) * span, reference, this.frames[sample]);
        }

        const s = this.scratch;
        const [before, now, after] = this.frames;
        // One speed for all three samples: it sets a delay inside the model, and a delay
        // that changed from one sample to the next would show up as motion that is not there.
        const speed = s.a.copy(after.center).sub(before.center).length() / (2 * seconds);
        for (let sample = 0; sample < 3; sample++) {
            const at = f + (sample - 1) * span;
            this.model.evaluate(at / this.framesPerSecond, speed, this.offsets[sample]);
        }
        const world = (frame, offsets, i, out) => out.copy(frame.center)
            .addScaledVector(frame.forward, offsets[3 * i])
            .addScaledVector(frame.right, offsets[3 * i + 1])
            .addScaledVector(this.up, offsets[3 * i + 2]);

        // The way the flock is going: its own velocity, which is NOT the way the formation
        // faces when Turn Lag is large. A flock going nowhere faces the way it is formed up.
        const heading = new Vector3().copy(after.center).sub(before.center);
        if (heading.length() / (2 * seconds) < 0.5) heading.copy(now.forward);
        heading.normalize();

        let checksum = 0;
        for (let i = 0; i < count; i++) {
            const p0 = world(before, this.offsets[0], i, s.a);
            const p1 = world(now, this.offsets[1], i, s.b);
            const p2 = world(after, this.offsets[2], i, s.c);
            this.positions[3 * i] = p1.x;
            this.positions[3 * i + 1] = p1.y;
            this.positions[3 * i + 2] = p1.z;
            checksum += p1.x + p1.y + p1.z;

            // acceleration first, while p0 and p2 are still positions
            const acceleration = s.x.copy(p0).add(p2).addScaledVector(p1, -2)
                .multiplyScalar(1 / (seconds * seconds));
            const velocity = p2.sub(p0).multiplyScalar(1 / (2 * seconds));

            // Nose along the bird's own velocity, with at least MIN_AIRSPEED of it along
            // the way the flock is going.
            const nose = s.z.copy(velocity)
                .addScaledVector(heading, Math.max(0, MIN_AIRSPEED - velocity.dot(heading)));
            nose.normalize();
            // Object3D.lookAt() puts +Z on the target and +X to the LEFT, so a model
            // that flies correctly as a single object flies correctly here too.
            const left = s.y.crossVectors(this.up, nose);
            if (left.lengthSq() < 1e-6) left.copy(now.right).negate();
            left.normalize();
            const top = s.a.crossVectors(nose, left);

            // Bank into the turn: the angle at which lift balances the sideways pull.
            const sideways = -acceleration.dot(left);           // positive = to the right
            const bank = Math.max(-MAX_BANK, Math.min(MAX_BANK, Math.atan2(sideways, GRAVITY)));
            s.basis.makeBasis(left, top, nose);
            s.quaternion.setFromRotationMatrix(s.basis);
            s.axis.setFromAxisAngle(s.b.set(0, 0, 1), bank);   // about the nose; + is right wing down
            s.quaternion.multiply(s.axis);
            s.quaternion.toArray(this.quaternions, 4 * i);
        }

        this.posesDirty = true;
        if (Globals.shadowsEnabled && checksum !== this.lastChecksum) {
            markShadowCastersDirty(`${owner.id}:flock`);
        }
        this.lastChecksum = checksum;
    }

    // Write the instance matrices, at the scale this view draws the object at. Main View
    // Scale makes each BIRD bigger and leaves the spacing true, so it is not a scale on
    // the group. With it at 1, both views want the same matrices and this runs once.
    preRender(scale) {
        if (!this.enabled || this.parts.length === 0) return;
        this.syncTransform();
        if (!this.posesDirty && scale === this.writtenScale) return;
        this.posesDirty = false;
        this.writtenScale = scale;

        const s = this.scratch;
        const common = this.owner.common;
        // The same fix-up rotations the single object gets, in the same order.
        const radians = Math.PI / 180;
        s.userRotation.identity()
            .multiply(s.axis.setFromAxisAngle(s.a.set(0, 1, 0), (common.rotateY ?? 0) * radians))
            .multiply(s.axis.setFromAxisAngle(s.a.set(1, 0, 0), (common.rotateX ?? 0) * radians))
            .multiply(s.axis.setFromAxisAngle(s.a.set(0, 0, 1), (common.rotateZ ?? 0) * radians));
        s.scale.setScalar(scale);

        // (poses can be left over from a bigger flock until the next update())
        const count = Math.min(this.poseCount, this.capacity);
        for (let i = 0; i < count; i++) {
            s.position.fromArray(this.positions, 3 * i);
            s.quaternion.fromArray(this.quaternions, 4 * i).multiply(s.userRotation);
            s.bird.compose(s.position, s.quaternion, s.scale);
            for (const part of this.parts) {
                if (!part.relative) {
                    part.mesh.setMatrixAt(i, s.bird);
                    continue;
                }
                s.instance.multiplyMatrices(s.bird, part.relative);
                if (part.mirrored) s.instance.premultiply(MIRROR_X);
                part.mesh.setMatrixAt(i, s.instance);
            }
        }
        for (const part of this.parts) {
            part.mesh.count = count;
            part.mesh.instanceMatrix.needsUpdate = true;
            // Out of date now. three.js makes them again when a click or a bounds query
            // asks, which is far less often than every frame.
            part.mesh.boundingSphere = null;
            part.mesh.boundingBox = null;
        }
    }

    dispose() {
        this.disposeMeshes();
        this.owner.group.remove(this.group);
        this.folder?.destroy();
    }
}
