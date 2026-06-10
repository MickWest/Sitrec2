// ScriptCommands.js — the Scripted Video command registry.
//
// Every script command is ONE entry here. The JS API function for each command
// is generated from its entry by ScriptJSRunner.js, the DSL-flavored sugar lines
// are rewritten against it by ScriptSugar.js, and the timeline/editor derive
// labels, colors and wheel-editable argument roles from it — adding a new
// command means adding one entry here, nothing else. Hooks:
//
//   args              positional argument spec, drives validation + the API:
//                     {name, type: "string"|"number", required?, default?,
//                      field?  event field to store into (default = name),
//                      role?   wheel-edit span key ("dur"|"dist"|"deg"|"fov")}
//   finish(e, error)  optional per-command validation/normalisation of the
//                     built event; return the (possibly replaced) partial
//                     event, or null after calling error(msg).
//   prepare(e, ctx)   capture per-beat params + compute the END pose (camera beats).
//                     ctx = {startPose, sfStart, sfEnd, targetPos, makePose}.
//                     Set e.invalid = true (and return startPose) if the target
//                     can't be resolved.
//   sample(e, ctx)    pose at a fraction localT through the beat (camera beats).
//                     ctx = {sp (startPose), sf, localT, targetPos, makePose}.

import {clamp, lerp, radians, smooth} from "./ScriptMath";

// map a friendly view name to {viewId, camId}
// "video" is the witness-video panel (a 2D view, no scripted camera) — camera
// beats that elapse while it's active still advance the unseen main camera so
// the pose is continuous when the script cuts back.
export const VIEW_MAP = {
    main: {viewId: "mainView", camId: "mainCamera"},
    mainview: {viewId: "mainView", camId: "mainCamera"},
    look: {viewId: "lookView", camId: "lookCamera"},
    lookview: {viewId: "lookView", camId: "lookCamera"},
    video: {viewId: "video", camId: "mainCamera"},
    video2: {viewId: "video2", camId: "mainCamera"},
};

// Normalize the `view` command's argument. Accepts:
//   a single view name   view("main")              → {view: "main"}
//   a view-preset name   view("ThreeWide")         → {preset: "ThreeWide"}  (from CustomManager.viewPresets)
//   an explicit layout   view({main: [0,0,.5,1], video: [.5,0,.5,1]})
//                                                  → {layoutSpec: {mainView: {left,top,width,height}, ...}}
// rects are [left, top, width, height] as fractions of the output frame.
function finishViewCommand(e, error, ctx) {
    const presets = (ctx && ctx.viewPresets) || {};
    const dur = e.dur || 0;
    const v = e.name;
    if (typeof v === "string") {
        const name = v.toLowerCase();
        if (VIEW_MAP[name]) return {view: name, dur};
        const presetKey = Object.keys(presets).find((k) => k.toLowerCase() === name);
        if (presetKey) return {view: presetKey, preset: presetKey, dur};
        return error(`unknown view or preset "${v}"`);
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
        const layout = {};
        for (const [key, rect] of Object.entries(v)) {
            const id = VIEW_MAP[key.toLowerCase()] ? VIEW_MAP[key.toLowerCase()].viewId : key;
            if (!Array.isArray(rect) || rect.length !== 4 || rect.some((n) => typeof n !== "number" || !isFinite(n))) {
                return error(`view layout "${key}" needs [left, top, width, height] (fractions of the frame)`);
            }
            layout[id] = {left: rect[0], top: rect[1], width: rect[2], height: rect[3]};
        }
        if (!Object.keys(layout).length) return error("view layout object is empty");
        return {view: null, layoutSpec: layout, dur};
    }
    return error(`"view" takes a view name, a preset name, or a {view: [l,t,w,h]} object`);
}

// Resolve a `view` event to a concrete layout {viewId: {left,top,width,height}}
// (fractions of the output frame), or null if it can't be resolved (e.g. the
// preset no longer exists). `presets` = CustomManager.viewPresets (or undefined).
// Only preset entries explicitly visible:true place a view — rect-only entries
// (which the preset system uses to position without showing) are skipped.
export function layoutForViewEvent(e, presets) {
    if (!e) return null;
    if (e.layoutSpec) return e.layoutSpec;
    if (e.preset) {
        const p = (presets || {})[e.preset];
        if (!p) return null;
        const layout = {};
        for (const [vid, r] of Object.entries(p)) {
            if (vid === "keypress") continue;
            if (r && r.visible === true && r.left !== undefined) {
                layout[vid] = {left: r.left, top: r.top, width: r.width, height: r.height};
            }
        }
        return layout;
    }
    if (e.view && VIEW_MAP[e.view]) {
        return {[VIEW_MAP[e.view].viewId]: {left: 0, top: 0, width: 1, height: 1}};
    }
    return null;
}

export const COMMANDS = {

    view: {
        cameraBeat: false,
        color: "#888888",
        label: (e) => "view " + (e.preset || e.view || "custom"),
        // no arg type on `name`: the value may be a name string OR a layout
        // object — finishViewCommand does all the validation. An optional
        // <secs> makes the cut an animated layout transition (rects tween from
        // the previous layout; the event occupies that time on the spine).
        args: [
            {name: "name", required: true},
            {name: "secs", type: "number", default: 0, field: "dur", role: "dur"},
        ],
        finish: finishViewCommand,
    },

    text: {
        cameraBeat: false,
        color: "#d05a8c",
        label: (e) => '"' + (e.text || "") + '"',
        args: [
            {name: "caption", type: "string", default: "", field: "text"},
            {name: "secs", type: "number", default: 3, field: "dur", role: "dur"},
        ],
        overflowHint: "multi-word captions need quotes",
    },

    zoom: {
        cameraBeat: true,
        color: "#3a7bd5",
        args: [
            {name: "target", type: "string", required: true, assumeLast: true},
            {name: "secs", type: "number", default: 5, field: "dur", role: "dur"},
            {name: "dist", type: "number", default: null, field: "endDist", role: "dist"},
        ],
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
        args: [
            {name: "target", type: "string", required: true, assumeLast: true},
            {name: "secs", type: "number", default: 8, field: "dur", role: "dur"},
            {name: "degrees", type: "number", default: 90, role: "deg"},
        ],
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
        args: [
            {name: "target", type: "string", required: true, assumeLast: true},
            {name: "secs", type: "number", default: 5, field: "dur", role: "dur"},
        ],
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
        args: [
            {name: "degrees", type: "number", required: true, field: "fov", role: "fov"},
            {name: "secs", type: "number", default: 1, field: "dur", role: "dur"},
        ],
        finish(e) {
            e.fov = clamp(e.fov, 1, 120);
            return e;
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
        args: [{name: "secs", type: "number", default: 1, role: "dur", field: "dur"}],
        prepare(e, {startPose}) { return startPose; },
        sample(e, {sp}) { return sp; },
    },

    // Fly the scripted (main) camera to another camera's live pose — the only
    // target so far is "look" (the witness camera). flyto look 0 snaps (use it
    // right after cutting view look → main for a seamless takeover); flyto
    // look 3 swoops back to the witness pose over 3 s. The pose is captured at
    // prepare time (preview/render start).
    flyto: {
        cameraBeat: true,
        color: "#7f5ac0",
        label: (e) => "flyto " + e.target,
        args: [
            {name: "target", type: "string", default: "look"},
            {name: "secs", type: "number", default: 0, field: "dur", role: "dur"},
        ],
        finish(e, error) {
            if (String(e.target).toLowerCase() !== "look") {
                return error(`"flyto" currently supports only the "look" target`);
            }
            e.target = "look";
            return e;
        },
        prepare(e, {startPose, livePose}) {
            const lp = livePose("lookCamera");
            if (!lp) { e.invalid = true; return startPose; }
            e._fly = {to: lp};
            return lp;
        },
        sample(e, {sp, localT, makePose}) {
            const f = smooth(localT);
            const to = e._fly.to;
            return makePose(
                sp.position.clone().lerp(to.position, f),
                sp.lookTarget.clone().lerp(to.lookTarget, f),
                lerp(sp.fov, to.fov, f));
        },
    },

    // Climb straight up (local vertical) by <meters> while turning to look at
    // the target — the "pull up to a wide shot" move.
    rise: {
        cameraBeat: true,
        color: "#3aa0a8",
        args: [
            {name: "target", type: "string", required: true, assumeLast: true},
            {name: "secs", type: "number", default: 4, field: "dur", role: "dur"},
            {name: "meters", type: "number", default: 500, role: "dist"},
        ],
        prepare(e, {startPose, sfEnd, targetPos, makePose, localUp}) {
            const up = localUp(startPose.position);
            e._rise = {endPos: startPose.position.clone().addScaledVector(up, e.meters)};
            const look = targetPos(e.target, sfEnd) || startPose.lookTarget;
            return makePose(e._rise.endPos, look, startPose.fov);
        },
        sample(e, {sp, sf, localT, targetPos, makePose}) {
            const pos = sp.position.clone().lerp(e._rise.endPos, smooth(localT));
            const look = targetPos(e.target, sf) || sp.lookTarget;
            return makePose(pos, look, sp.fov);
        },
    },

    // Fade a view's opacity to <to> (default 0) over <secs>. Preview drives the
    // view's DOM opacity; the renderer composites with the same alpha.
    fade: {
        cameraBeat: false,
        color: "#b3673a",
        label: (e) => "fade " + (e.viewName || ""),
        args: [
            {name: "view", type: "string", required: true},
            {name: "secs", type: "number", default: 1, field: "dur", role: "dur"},
            {name: "to", type: "number", default: 0},
        ],
        finish(e, error) {
            const name = String(e.view).toLowerCase();
            if (!VIEW_MAP[name]) return error(`unknown view "${e.view}"`);
            return {viewId: VIEW_MAP[name].viewId, viewName: name, to: clamp(e.to, 0, 1), dur: e.dur};
        },
    },

    // Change any GUI menu setting at this point in the script. Two forms:
    //   set("Constellation Lines", false)            scan all menus, first match
    //   set("showhide", "Constellation Lines", false) target a specific menu
    // The manager snapshots every touched setting on preview/render enter and
    // restores it on exit, and resolves "value at time t" so scrubbing
    // backwards works — a scripted set never permanently mutates the sitch.
    set: {
        cameraBeat: false,
        setting: true,
        color: "#2aa198",
        label: (e) => `set ${e.path} ${e.value}`,
        args: [
            {name: "menuOrControl", required: true},
            {name: "controlOrValue", required: true},
            {name: "value"},
        ],
        finish(e, error) {
            const twoArg = e.value === null || e.value === undefined;
            const menu = twoArg ? null : e.menuOrControl;
            const path = twoArg ? e.menuOrControl : e.controlOrValue;
            const value = twoArg ? e.controlOrValue : e.value;
            if (typeof path !== "string" || !path) {
                return error(`"set" takes ("control", value) or ("menu", "control", value)`);
            }
            if (!["boolean", "number", "string"].includes(typeof value)) {
                return error(`set "${path}" — value must be true/false, a number, or an option string`);
            }
            return {menu, path, value, dur: 0};
        },
    },

    // show "Constellation Lines" / hide "Constellation Lines" — sugar over
    // set(control, true/false). "on" and "off" are aliases.
    show: {
        cameraBeat: false,
        setting: true,
        color: "#2aa198",
        label: (e) => (e.value ? "show " : "hide ") + e.path,
        args: [{name: "control", type: "string", required: true}],
        finish(e) { return {menu: null, path: e.control, value: true, dur: 0}; },
    },

    hide: {
        cameraBeat: false,
        setting: true,
        color: "#2aa198",
        label: (e) => (e.value ? "show " : "hide ") + e.path,
        args: [{name: "control", type: "string", required: true}],
        finish(e) { return {menu: null, path: e.control, value: false, dur: 0}; },
    },
};

// command-name aliases → canonical registry key
export const COMMAND_ALIASES = {title: "text", on: "show", off: "hide"};

// is this event a menu-setting change (set/show/hide)?
export function isSettingEvent(e) {
    return !!(e && COMMANDS[e.type] && COMMANDS[e.type].setting);
}

// resolve a (lowercased) command word to {type, def}, or null if unknown
export function resolveCommand(cmd) {
    const type = COMMANDS[cmd] ? cmd : COMMAND_ALIASES[cmd];
    return type ? {type, def: COMMANDS[type]} : null;
}

// human/agent-readable call signature, e.g. "zoom(target, secs, dist?)"
export function commandSignature(type) {
    const def = COMMANDS[type];
    return type + "(" + def.args.map((a) => (a.required ? a.name : a.name + "?")).join(", ") + ")";
}

// Build a partial event ({dur, ...fields}) from positional call arguments using
// the command's args spec, then run its finish hook. On any problem, calls
// error(msg) and returns null. Number-ish strings are coerced (sugar emits real
// numbers; hand-written JS might pass "6"). ctx carries app-provided context
// (e.g. the available view presets) through to the finish hooks.
export function buildEvent(type, def, argv, error, ctx) {
    // A number where a string-typed first argument belongs means it was
    // omitted — shift right so its default fills in: flyto(3) → flyto("look", 3),
    // text(4) → text("", 4). (The runner pre-fills assume-last targets the
    // same way before calling here.)
    const a0 = def.args[0];
    if (a0 && a0.type === "string" && a0.default !== undefined
        && argv.length && typeof argv[0] === "number") {
        argv = [undefined, ...argv];
    }
    if (argv.length > def.args.length) {
        const hint = def.overflowHint ? ` — ${def.overflowHint}` : "";
        return error(`"${type}" takes ${commandSignature(type)}${hint}`);
    }
    const e = {};
    for (let i = 0; i < def.args.length; i++) {
        const a = def.args[i];
        let v = argv[i];
        if (v === undefined || v === null) {
            if (a.required) {
                const why = a.assumeLast ? " (none earlier in the script to assume)" : "";
                return error(`${commandSignature(type)} — missing <${a.name}>${why}`);
            }
            v = a.default !== undefined ? a.default : null;
        } else if (a.type === "number") {
            if (typeof v === "string" && v !== "" && isFinite(+v)) v = +v;
            if (typeof v !== "number" || !isFinite(v)) return error(`${commandSignature(type)} — <${a.name}> must be a number`);
        } else if (a.type === "string" && typeof v !== "string") {
            v = String(v);
        }
        e[a.field || a.name] = v;
    }
    return def.finish ? def.finish(e, error, ctx) : e;
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
