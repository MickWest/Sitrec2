// ScriptCameraEngine.js — camera pose computation for the Scripted Video system.
//
// Generic over the command registry (ScriptCommands.js): prepareEvents() walks the
// parsed events once to capture per-beat params and start/end poses (per-camera
// continuity), and computeCamera() samples the active beat's pose at any scripted
// time t. Per-command behaviour lives in the registry's prepare/sample hooks.

import {Vector3} from "three";
import {NodeMan} from "../Globals";
import {getLocalUpVector} from "../SphericalMath";
import {LLAToECEF} from "../LLA-ECEF-ENU";
import {COMMANDS, VIEW_MAP} from "./ScriptCommands";

// Resolve a target name to an ECEF Vector3 at fractional sitch-frame sf.
// <target> is a track short-name (e.g. OE-LNC, resolved to node "Track_OE-LNC")
// or a "lat,lon,alt" triple. Returns null if it can't be resolved.
export function targetPos(target, sf) {
    if (!target) return null;

    // "lat,lon,alt" literal
    if (target.includes(",")) {
        const p = target.split(",").map(parseFloat);
        if (p.length >= 2 && !isNaN(p[0]) && !isNaN(p[1])) {
            return LLAToECEF(p[0], p[1], isNaN(p[2]) ? 0 : p[2]);
        }
    }

    // try a few node-id conventions
    const candidates = ["Track_" + target, target, target + "_ob"];
    for (const id of candidates) {
        const node = NodeMan.get(id, false);
        if (!node) continue;
        try {
            if (typeof node.p === "function") {
                const v = node.p(sf);
                if (v) return v.clone ? v.clone() : v;
            }
            if (typeof node.getValueFrame === "function") {
                const v = node.getValueFrame(sf);
                if (v && v.position) return v.position.clone();
            }
        } catch (e) { /* try next */ }
    }
    return null;
}

// the live pose of a camera node, or null
export function poseFromCamNode(camId) {
    const camNode = NodeMan.get(camId, false);
    if (!camNode || !camNode.camera) return null;
    const cam = camNode.camera;
    const fwd = new Vector3();
    cam.getWorldDirection(fwd);
    return {
        position: cam.position.clone(),
        up: cam.up.clone(),
        lookTarget: cam.position.clone().addScaledVector(fwd, 1000),
        fov: cam.fov,
    };
}

// a pose at `position` looking at `lookTarget`, up = local ellipsoid normal
export function makePose(position, lookTarget, fov) {
    return {position: position.clone(), up: getLocalUpVector(position), lookTarget: lookTarget.clone(), fov};
}

export function applyPoseToCam(camNode, pose) {
    const cam = camNode.camera;
    cam.position.copy(pose.position);
    cam.up.copy(pose.up);
    cam.lookAt(pose.lookTarget);
    if (pose.fov) { cam.fov = pose.fov; cam.updateProjectionMatrix(); }
    cam.updateMatrix();
    cam.updateMatrixWorld(true);
}

// Walk the beats once, in script order, computing each beat's captured params and
// start/end poses (per-camera continuity). Must be called after parse and before
// preview/render so the cameras' "current" pose is the start point.
// sitFrameAt maps scripted seconds → fractional sitch frame.
export function prepareEvents(events, defaultView, sitFrameAt) {
    const camPose = {};   // camId -> running pose
    let activeView = defaultView;

    for (const e of events) {
        if (e.type === "view") { activeView = e.view; continue; }
        const def = COMMANDS[e.type];
        if (!def || !def.cameraBeat) continue;

        const camId = VIEW_MAP[activeView].camId;
        if (!camPose[camId]) camPose[camId] = poseFromCamNode(camId);
        const startPose = camPose[camId] || makePose(new Vector3(0, 0, 1), new Vector3(), 30);
        e.camId = camId;
        e.startPose = startPose;

        const endPose = def.prepare(e, {
            startPose,
            sfStart: sitFrameAt(e.start),
            sfEnd: sitFrameAt(e.start + e.dur),
            targetPos, makePose,
            localUp: getLocalUpVector,
        });

        e.endPose = {position: endPose.position.clone(), up: endPose.up.clone(),
            lookTarget: endPose.lookTarget.clone(), fov: endPose.fov};
        camPose[camId] = e.endPose;
    }
}

// Compute {camId, pose} at scripted time t. Returns null if no camera beats.
export function computeCamera(beats, t, sitFrameAt) {
    if (beats.length === 0) return null;

    if (t < beats[0].start) return {camId: beats[0].camId, pose: beats[0].startPose};

    // among camera beats active at t, the latest-starting one takes control
    // (so a concurrent "&" camera move overrides the one it overlaps)
    let beat = null;
    for (const b of beats) {
        if (t >= b.start && t < b.start + b.dur) {
            if (!beat || b.start >= beat.start) beat = b;
        }
    }
    if (!beat) {
        // between/after beats: hold the most recent beat that has started
        let last = beats[0];
        for (const b of beats) if (b.start <= t && b.start >= last.start) last = b;
        return {camId: last.camId, pose: last.endPose};
    }

    if (beat.invalid) return {camId: beat.camId, pose: beat.startPose};

    const pose = COMMANDS[beat.type].sample(beat, {
        sp: beat.startPose,
        sf: sitFrameAt(t),
        localT: beat.dur > 0 ? (t - beat.start) / beat.dur : 1,
        targetPos, makePose,
    });
    return {camId: beat.camId, pose};
}
