import {Vector3} from "three";
import {MQ9TrackingModel} from "./MQ9TrackingModel";
import {getLocalUpVector} from "./SphericalMath";
import {raycastGroundElevationFast} from "./raycastGround";

// A deterministic sensor simulation. Detection is supplied by projected scene
// geometry, before the HUD is composited. It does not analyze loaded video.
export class MQ9TrackingSimulation {
    constructor({camera, fps = 30, startFrame = 0, sensorAt, lensAt, observationAt,
        manualAimAt, wobbleAt, commands = [], options = {}, groundAt = raycastGroundElevationFast}) {
        Object.assign(this, {camera, fps, startFrame, sensorAt, lensAt, observationAt, manualAimAt, wobbleAt, groundAt});
        this.model = new MQ9TrackingModel(options);
        this.commands = commands.map(c => ({...c, frame: c.frame ?? Math.round(c.timeSeconds * fps)}));
        this.initial = {position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), fov: camera.fov};
        this.cache = new Map(); this.lastFrame = startFrame - 1;
        this.offset = [0, 0]; this.manualQuaternion = camera.quaternion.clone();
        this.groundAnchor = null; this.current = null;
        this.confidence = 1;
        this.centering = null;
        this.imageAspect = 4 / 3;
    }

    command(action, frame, extra = {}) {
        this.commands.push({action, frame, ...extra});
        for (const f of this.cache.keys()) if (f >= frame) this.cache.delete(f);
        if (this.lastFrame >= frame) this.lastFrame = frame - 1;
    }

    reset() {
        this.model.reset(); this.offset = [0, 0]; this.groundAnchor = null;
        this.manualQuaternion.fromArray(this.initial.quaternion);
        this.lastFrame = this.startFrame - 1; this.current = null;
        this.confidence = 1;
        this.centering = null;
    }

    project(position, diameterM = 1) {
        const camera = this.camera, point = new Vector3(...position);
        const range = point.distanceTo(camera.position), pixel = point.clone().project(camera);
        const forward = point.clone().sub(camera.position).dot(camera.getWorldDirection(new Vector3()));
        const diameter = 480 * Math.tan(Math.asin(Math.min(1, diameterM / (2 * range)))) / Math.tan(camera.fov * Math.PI / 360);
        return {x: (pixel.x + 1) * 320, y: (1 - pixel.y) * 240, width: diameter, height: diameter,
            visible: forward > 0 && pixel.z >= -1 && pixel.z <= 1
                && pixel.x > -this.imageAspect * .75 - diameter / 640 && pixel.x < this.imageAspect * .75 + diameter / 640
                && pixel.y > -1 - diameter / 480 && pixel.y < 1 + diameter / 480};
    }

    aim(point, offset = [0, 0]) {
        const camera = this.camera;
        camera.up.copy(getLocalUpVector(camera.position));
        camera.lookAt(new Vector3(...point));
        const fy = 240 / Math.tan(camera.fov * Math.PI / 360);
        // Solve both image coordinates together; independent yaw/pitch angles
        // otherwise introduce horizontal drift as vertical offset or FOV changes.
        const pitch = Math.atan(offset[1] / fy);
        camera.rotateY(-Math.atan(offset[0] * Math.cos(pitch) / fy));
        camera.rotateX(-pitch);
        camera.updateMatrixWorld(true);
    }

    captureGround() {
        const point = this.groundAt(this.camera.position, this.camera.getWorldDirection(new Vector3()));
        this.groundAnchor = point?.toArray() ?? null;
        return this.groundAnchor;
    }

    restoreFrame(record) {
        this.model.restore(record.model); this.offset = [...record.offset];
        this.confidence = record.confidence;
        this.centering = record.centering && {...record.centering, from: [...record.centering.from]};
        this.manualQuaternion.fromArray(record.manualQuaternion);
        this.groundAnchor = record.groundAnchor && [...record.groundAnchor];
        this.current = record.display; this.lastFrame = record.frame;
        this.applyPose(record);
    }

    applyPose(record) {
        this.camera.position.fromArray(record.position);
        this.camera.quaternion.fromArray(record.quaternion);
        this.camera.fov = record.fov; this.camera.aspect = 4 / 3;
        this.camera.updateProjectionMatrix(); this.camera.updateMatrixWorld(true);
    }

    applyCachedFrame(frame) {
        const record = this.cache.get(frame);
        if (record) this.applyPose(record);
    }

    applyFrame(frame) {
        if (frame < this.startFrame || this.applying) return;
        if (this.cache.has(frame)) { this.restoreFrame(this.cache.get(frame)); return; }
        this.applying = true;
        try {
            const previous = [...this.cache.keys()].filter(f => f < frame).sort((a, b) => b - a)[0];
            if (previous !== undefined) this.restoreFrame(this.cache.get(previous));
            else this.reset();
            for (let f = this.lastFrame + 1; f <= frame; f++) this.step(f);
        } finally { this.applying = false; }
    }

    step(frame) {
        const camera = this.camera, time = frame / this.fps;
        camera.position.fromArray(this.sensorAt?.(frame) ?? this.initial.position);
        camera.fov = this.lensAt?.(frame) ?? this.initial.fov; camera.aspect = 4 / 3;
        camera.updateProjectionMatrix();
        const beforeMode = this.model.cameraMode;
        const commands = this.commands.filter(c => c.frame === frame);
        for (const command of commands) {
            if (command.action === "confidence") this.confidence = command.value;
            else if (command.action === "offset") { this.offset = [...command.pixels]; this.centering = null; }
            else if (command.action === "center") {
                if (["object", "coast"].includes(this.model.cameraMode)) {
                    this.centering = {startFrame: frame, endFrame: frame + Math.max(1, Math.round((command.durationSeconds ?? 1) * this.fps)),
                        from: [...this.offset]};
                }
            }
            else if (command.action === "slew") {
                this.centering = null;
                if (["object", "coast"].includes(this.model.cameraMode)) {
                    this.offset = this.offset.map((v, i) => v + command.pixels[i]);
                } else {
                    if (this.model.cameraMode === "ground" && this.groundAnchor) this.aim(this.groundAnchor);
                    else camera.quaternion.copy(this.manualQuaternion);
                    const fy = 240 / Math.tan(camera.fov * Math.PI / 360);
                    camera.rotateY(-Math.atan(command.pixels[0] / fy));
                    camera.rotateX(-Math.atan(command.pixels[1] / fy));
                    this.manualQuaternion.copy(camera.quaternion);
                    if (this.model.cameraMode === "ground") this.captureGround();
                }
            } else {
                this.centering = null;
                if (command.action === "manual") this.manualQuaternion.copy(camera.quaternion);
                if (command.action === "ground") this.captureGround();
                this.model.command(command.action, time);
            }
        }
        if (this.centering) {
            const {startFrame, endFrame, from} = this.centering;
            const t = Math.min(1, (frame - startFrame) / (endFrame - startFrame)), p = t*t*(3-2*t);
            this.offset = from.map(v => v * (1-p));
            if (t === 1) this.centering = null;
        }
        const wobble = this.wobbleAt?.(frame) ?? [0, 0];
        const offset = this.offset.map((v, i) => v + wobble[i]);
        const estimate = this.model.estimate(time);
        if (["object", "coast"].includes(this.model.cameraMode) && estimate) this.aim(estimate, this.offset);
        else if (this.model.cameraMode === "ground" && this.groundAnchor) this.aim(this.groundAnchor);
        else {
            const manual = this.manualAimAt?.(frame);
            if (manual) this.aim(manual, offset);
            else { camera.quaternion.copy(this.manualQuaternion); camera.updateMatrixWorld(true); }
        }
        // Only a visible scene-object observation can enter the model. In
        // coast the true position is used solely to test for reacquisition.
        const observation = this.observationAt?.(frame);
        const projected = observation && this.project(observation.position, observation.diameterM);
        const detection = observation && {...observation, ...projected,
            confidence: observation.confidence * this.confidence,
            visible: observation.visible !== false && projected.visible};
        if (detection?.visible) {
            const point = new Vector3(...observation.position);
            const ground = this.groundAt(camera.position, point.clone().sub(camera.position).normalize());
            if (ground && camera.position.distanceTo(ground) < camera.position.distanceTo(point) - observation.diameterM) detection.visible = false;
        }
        const predictedPixel = estimate && this.project(estimate);
        const priorState = this.model.state;
        this.model.step(time, detection ? [detection] : [], predictedPixel);
        if (this.model.cameraMode === "ground" && (priorState !== "ground" || !this.groundAnchor)) this.captureGround();
        const aimPoint = this.model.estimate(time);
        if (["object", "coast"].includes(this.model.cameraMode) && aimPoint) {
            if (priorState === "acquiring" || !estimate) {
                // Hand off at the observed image position. Automatic tracking
                // holds this screen point until the operator slews or centers it.
                const acquired = this.project(aimPoint);
                this.offset = [320 - acquired.x, 240 - acquired.y];
            }
            this.aim(aimPoint, this.offset);
        }
        else if (this.model.cameraMode === "ground" && this.groundAnchor) this.aim(this.groundAnchor);
        if (this.model.cameraMode === "manual") this.manualQuaternion.copy(camera.quaternion);
        const pixel = aimPoint && this.project(aimPoint);
        const box = this.model.box(time, pixel ?? undefined);
        let boxWidthM = null;
        if (box?.style === "square") {
            const ground = this.groundAt(camera.position, camera.getWorldDirection(new Vector3()));
            if (ground) boxWidthM = 2 * camera.position.distanceTo(ground) * Math.tan(camera.fov * Math.PI / 360) * box.width / 480;
        }
        this.current = {frame, time, state: this.model.state, cameraMode: this.model.cameraMode,
            box, boxWidthM, groundAnchor: this.groundAnchor && [...this.groundAnchor],
            estimatedPosition: aimPoint, targetPixel: observation ? this.project(observation.position, observation.diameterM) : null,
            confidence: detection?.visible ? detection.confidence : 0,
            offsetPixels: [...this.offset], centering: !!this.centering,
            transition: priorState !== this.model.state || beforeMode !== this.model.cameraMode};
        this.lastFrame = frame;
        this.cache.set(frame, {frame, position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), fov: camera.fov,
            model: this.model.snapshot(), offset: [...this.offset], confidence: this.confidence, manualQuaternion: this.manualQuaternion.toArray(),
            centering: this.centering && {...this.centering, from: [...this.centering.from]},
            groundAnchor: this.groundAnchor && [...this.groundAnchor], display: JSON.parse(JSON.stringify(this.current))});
    }
}
