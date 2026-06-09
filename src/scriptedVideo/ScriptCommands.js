// ScriptCommands.js — the Scripted Video command registry.
//
// Every script command is ONE entry here, with up to three hooks:
//
//   parse(ctx)        build the event from the line's tokens (all commands).
//                     ctx = {tokens, num, numSpan, error}; return a partial event
//                     ({dur, spans, ...extras}) or null after calling ctx.error().
//   prepare(e, ctx)   capture per-beat params + compute the END pose (camera beats).
//                     ctx = {startPose, sfStart, sfEnd, targetPos, makePose}.
//                     Set e.invalid = true (and return startPose) if the target
//                     can't be resolved.
//   sample(e, ctx)    pose at a fraction localT through the beat (camera beats).
//                     ctx = {sp (startPose), sf, localT, targetPos, makePose}.
//
// The parser (ScriptParser.js) and camera engine (ScriptCameraEngine.js) are
// generic loops over this table — adding a new command means adding one entry
// here, nothing else.

import {clamp, lerp, radians, smooth} from "./ScriptMath";

// map a friendly view name to {viewId, camId}
export const VIEW_MAP = {
    main: {viewId: "mainView", camId: "mainCamera"},
    mainview: {viewId: "mainView", camId: "mainCamera"},
    look: {viewId: "lookView", camId: "lookCamera"},
    lookview: {viewId: "lookView", camId: "lookCamera"},
};

export const COMMANDS = {

    view: {
        cameraBeat: false,
        color: "#888888",
        parse({tokens, error}) {
            const name = (tokens[1] || "").toLowerCase();
            if (!VIEW_MAP[name]) return error(`unknown view "${tokens[1]}"`);
            return {view: name, dur: 0, spans: {}};
        },
    },

    text: {
        cameraBeat: false,
        color: "#d05a8c",
        label: (e) => '"' + (e.text || "") + '"',
        parse({tokens, num, numSpan, error, cmd}) {
            // catch the classic mistake: text hello world 3 (caption needs quotes)
            if (tokens.length > 3 || (tokens[2] !== undefined && num(tokens[2]) === null)) {
                return error(`"${cmd}" takes "caption" <secs> — multi-word captions need quotes`);
            }
            return {text: tokens[1] ?? "", dur: num(tokens[2]) ?? 3, spans: {dur: numSpan(2)}};
        },
    },

    zoom: {
        cameraBeat: true,
        color: "#3a7bd5",
        parse({tokens, num, numSpan, error, cmd}) {
            const target = tokens[1], dur = num(tokens[2]);
            if (!target || dur === null) return error(`"${cmd}" needs <object> <secs>`);
            return {target, dur, endDist: num(tokens[3]), spans: {dur: numSpan(2), dist: numSpan(3)}};
        },
        prepare(e, {startPose, sfStart, sfEnd, targetPos, makePose}) {
            const objStart = targetPos(e.target, sfStart);
            if (!objStart) { e.invalid = true; return startPose; }
            const offset = startPose.position.clone().sub(objStart);
            const d0 = offset.length() || 1;
            const dir0 = offset.clone().multiplyScalar(1 / d0);
            const dEnd = (e.endDist != null && e.endDist > 0)
                ? e.endDist : clamp(d0 * 0.05, 150, 700);
            e._zoom = {dir0, d0, dEnd};
            const objEnd = targetPos(e.target, sfEnd) || objStart;
            return makePose(objEnd.clone().addScaledVector(dir0, dEnd), objEnd, startPose.fov);
        },
        sample(e, {sp, sf, localT, targetPos, makePose}) {
            const obj = targetPos(e.target, sf) || sp.lookTarget;
            const d = lerp(e._zoom.d0, e._zoom.dEnd, smooth(localT));
            return makePose(obj.clone().addScaledVector(e._zoom.dir0, d), obj, sp.fov);
        },
    },

    orbit: {
        cameraBeat: true,
        color: "#5db04a",
        parse({tokens, num, numSpan, error, cmd}) {
            const target = tokens[1], dur = num(tokens[2]);
            if (!target || dur === null) return error(`"${cmd}" needs <object> <secs>`);
            return {target, dur, degrees: num(tokens[3]) ?? 90, spans: {dur: numSpan(2), deg: numSpan(3)}};
        },
        prepare(e, {startPose, sfStart, sfEnd, targetPos, makePose, localUp}) {
            const objStart = targetPos(e.target, sfStart);
            if (!objStart) { e.invalid = true; return startPose; }
            const offset0 = startPose.position.clone().sub(objStart);
            const axis = localUp(objStart);
            e._orbit = {offset0, axis};
            const objEnd = targetPos(e.target, sfEnd) || objStart;
            const offEnd = offset0.clone().applyAxisAngle(axis, radians(e.degrees));
            return makePose(objEnd.clone().add(offEnd), objEnd, startPose.fov);
        },
        sample(e, {sp, sf, localT, targetPos, makePose}) {
            const obj = targetPos(e.target, sf) || sp.lookTarget;
            const off = e._orbit.offset0.clone().applyAxisAngle(e._orbit.axis, radians(e.degrees) * localT);
            return makePose(obj.clone().add(off), obj, sp.fov);
        },
    },

    track: {
        cameraBeat: true,
        color: "#c79a30",
        parse({tokens, num, numSpan, error, cmd}) {
            const target = tokens[1], dur = num(tokens[2]);
            if (!target || dur === null) return error(`"${cmd}" needs <object> <secs>`);
            return {target, dur, spans: {dur: numSpan(2)}};
        },
        prepare(e, {startPose, sfEnd, targetPos, makePose}) {
            const objEnd = targetPos(e.target, sfEnd);
            if (!objEnd) { e.invalid = true; return startPose; }
            return makePose(startPose.position, objEnd, startPose.fov);
        },
        sample(e, {sp, sf, targetPos, makePose}) {
            const obj = targetPos(e.target, sf) || sp.lookTarget;
            return makePose(sp.position, obj, sp.fov);
        },
    },

    fov: {
        cameraBeat: true,
        color: "#9b59b6",
        label: (e) => "fov " + e.fov,
        parse({tokens, num, numSpan, error}) {
            const fov = num(tokens[1]);
            if (fov === null) return error(`"fov" needs <degrees> <secs>`);
            return {fov: clamp(fov, 1, 120), dur: num(tokens[2]) ?? 1,
                spans: {fov: numSpan(1), dur: numSpan(2)}};
        },
        // fov keeps the camera's CURRENT up/lookTarget rather than recomputing the
        // up from the position (which a makePose would do) — it's a pure lens change.
        prepare(e, {startPose}) {
            e._fov = {fov0: startPose.fov, fovEnd: e.fov};
            return {position: startPose.position.clone(), up: startPose.up.clone(),
                lookTarget: startPose.lookTarget.clone(), fov: e.fov};
        },
        sample(e, {sp, localT}) {
            return {position: sp.position.clone(), up: sp.up.clone(), lookTarget: sp.lookTarget.clone(),
                fov: lerp(e._fov.fov0, e._fov.fovEnd, smooth(localT))};
        },
    },

    wait: {
        cameraBeat: true,
        color: "#555a66",
        label: () => "wait",
        parse({tokens, num, numSpan, error}) {
            const dur = num(tokens[1]);
            if (dur === null) return error(`"wait" needs <secs>`);
            return {dur, spans: {dur: numSpan(1)}};
        },
        prepare(e, {startPose}) { return startPose; },
        sample(e, {sp}) { return sp; },
    },
};

// command-name aliases → canonical registry key
const COMMAND_ALIASES = {title: "text"};

// resolve a (lowercased) command word to {type, def}, or null if unknown
export function resolveCommand(cmd) {
    const type = COMMANDS[cmd] ? cmd : COMMAND_ALIASES[cmd];
    return type ? {type, def: COMMANDS[type]} : null;
}

// timeline block colour for an event type
export function commandColor(type) {
    return COMMANDS[type]?.color || "#3a7bd5";
}

// timeline block label for an event
export function eventLabel(e) {
    const custom = COMMANDS[e.type]?.label;
    return custom ? custom(e) : e.type + (e.target ? " " + e.target : "");
}
