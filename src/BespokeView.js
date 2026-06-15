// BespokeView - a generic factory for ad-hoc extra 3D viewports.
//
// Sitrec already has everything needed to render the GlobalScene from an arbitrary
// camera; this just wires the pieces into a one-call helper so we can spin up many
// bespoke 3D views (close-ups, cutaways, diagrams) without repeating boilerplate.
//
// Each bespoke view gets:
//   - its own CNodeCamera (the camera's layer mask decides what the view shows)
//   - a CNodeView3D (auto-registers in ViewMan and the Views show/hide menu)
//   - a preRenderFunction that FRAMES a moving target each frame (distance/az/el
//     offset, look-at), then calls an optional user perFrame(view, frame) hook for
//     bespoke drawing (e.g. DebugArrow light paths).
//
// Example (an MQ-9 close-up showing the sun light path) lives in CustomManagerSetup.js.

import {CNodeView3D} from "./nodes/CNodeView3D";
import {CNodeCamera} from "./nodes/CNodeCamera";
import {NodeMan, Sit} from "./Globals";
import {par} from "./par";
import {getLocalUpVector, getLocalEastVector, getLocalNorthVector} from "./SphericalMath";
import {radians} from "./utils";
import * as LAYER from "./LayerMasks";

// Resolve opts.target (a Vector3, a node/id with .p(frame) or .group.position, or a
// function(frame)->Vector3) to an ECEF Vector3 for the given frame, or null.
function resolveTarget(target, frame) {
    if (!target) return null;
    if (typeof target === "function") return target(frame);
    if (target.isVector3) return target;
    const node = (typeof target === "string") ? NodeMan.get(target, false) : target;
    if (!node) return null;
    if (typeof node.p === "function") { try { return node.p(frame); } catch (e) { return null; } }
    if (node.group?.position) return node.group.position;
    return null;
}

// Create (idempotently) a bespoke 3D view. Returns the CNodeView3D.
//
// opts:
//   id            unique node id (required)
//   menuName      label in the Views menu (default = id)
//   left,top,width,height   fractional layout (default bottom-right quadrant)
//   fov           camera field of view (default 40)
//   near, far     camera clip planes (defaults tuned for a close-up)
//   background    canvas background colour (default a dark diagram grey)
//   layers        camera layer mask = what renders here (default MASK_MAINRENDER,
//                 i.e. world + main + target + helpers, so DebugArrow helpers show)
//   target        what to frame: Vector3 | node | id | function(frame)->Vector3
//   distance      camera distance from the target, metres (default 80)
//   azDeg, elDeg  camera bearing/elevation around the target (default 40/22)
//   visible       initial visibility (default false)
//   perFrame      function(view, frame) for bespoke per-frame drawing
export function makeBespoke3DView(opts) {
    const id = opts.id;
    if (NodeMan.exists(id)) return NodeMan.get(id);

    const layers = opts.layers ?? LAYER.MASK_MAINRENDER;
    const camId = id + "_Camera";
    if (!NodeMan.exists(camId)) {
        new CNodeCamera({
            id: camId,
            fov: opts.fov ?? 40, aspect: 1,
            near: opts.near ?? 0.5, far: opts.far ?? 1e7,
            layers,
        });
    }

    const distance = opts.distance ?? 80;
    const azDeg = opts.azDeg ?? 40, elDeg = opts.elDeg ?? 22;

    const view = new CNodeView3D({
        id,
        menuName: opts.menuName ?? id,
        camera: camId,
        left: opts.left ?? 0.5, top: opts.top ?? 0.5,
        width: opts.width ?? 0.25, height: opts.height ?? 0.5,
        background: opts.background ?? "#0a0a12",
        draggable: true, resizable: true, freeAspect: true,
        visible: opts.visible ?? false,
        preRenderFunction: function () {
            const frame = par.frame;
            const target = resolveTarget(opts.target, frame);
            if (target) {
                const cam = NodeMan.get(camId, false)?.camera;
                if (cam) {
                    const up = getLocalUpVector(target);
                    const east = getLocalEastVector(target);
                    const north = getLocalNorthVector(target);
                    const az = radians(azDeg), el = radians(elDeg);
                    const horiz = east.clone().multiplyScalar(Math.sin(az))
                        .add(north.clone().multiplyScalar(Math.cos(az)));
                    const offset = horiz.multiplyScalar(Math.cos(el))
                        .add(up.clone().multiplyScalar(Math.sin(el)))
                        .multiplyScalar(distance);
                    cam.position.copy(target.clone().add(offset));
                    cam.up.copy(up);
                    cam.lookAt(target);
                    cam.updateMatrixWorld();
                }
            }
            if (opts.perFrame) {
                try { opts.perFrame(this, frame); } catch (e) { console.warn("BespokeView perFrame error (" + id + "):", e); }
            }
        },
    });
    return view;
}
