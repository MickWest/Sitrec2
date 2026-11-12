import {Sphere, Vector3} from "three";
import {projectWorldToView, viewToClient, worldUnitsPerPixel} from "./ViewUtils";

const sphere = new Sphere();
const position = new Vector3();

// A UI overlay rather than scene geometry: always round and 100 CSS pixels across,
// unaffected by scene lighting, and transparent to the existing move handles.
export function updateObjectLocatorRings(view, nodes) {
    if (view.id !== "mainView" || !view.div || !view.canvas) return;
    const pane = view.div.getBoundingClientRect();
    const canvas = view.canvas.getBoundingClientRect();
    const visible = new Map();
    if (canvas.width > 0 && canvas.height > 0) {
        for (const node of nodes) {
            if (!node.cachedBoundingSphere || !node.group) continue;
            node.group.updateWorldMatrix(true, false);
            sphere.copy(node.cachedBoundingSphere).applyMatrix4(node.group.matrixWorld);
            const units = worldUnitsPerPixel(view, sphere.center);
            if (!(units > 0)) continue;
            const diameter = 2 * sphere.radius / units;
            if (!Number.isFinite(diameter) || diameter >= 75) continue;

            // Mark the object's origin, where the move widget is attached. Use its
            // bounding sphere (including model offsets and scale) only for the fade.
            position.setFromMatrixPosition(node.group.matrixWorld);
            const projected = projectWorldToView(view, position);
            if (!projected) continue;
            const [x, y] = viewToClient(view, ...projected);
            if (x < canvas.left || x > canvas.right || y < canvas.top || y > canvas.bottom) continue;
            visible.set(node.id, {x: x - canvas.left, y: y - canvas.top,
                opacity: Math.min(1, (75 - diameter) / 25)});
        }
    }

    let overlay = view._objectLocatorOverlay;
    if (!overlay && visible.size === 0) return;
    if (!overlay) {
        overlay = view.div.ownerDocument.createElement("div");
        overlay.className = "object-locator-overlay";
        overlay.setAttribute("aria-hidden", "true");
        Object.assign(overlay.style, {
            position: "absolute", overflow: "hidden", pointerEvents: "none", zIndex: "15",
        });
        view.div.appendChild(overlay);
        view._objectLocatorOverlay = overlay;
    }
    Object.assign(overlay.style, {
        left: `${canvas.left - pane.left}px`, top: `${canvas.top - pane.top}px`,
        width: `${canvas.width}px`, height: `${canvas.height}px`,
    });
    const rings = new Map([...overlay.children].map(ring => [ring.dataset.objectId, ring]));
    for (const [id, ring] of rings) {
        if (!visible.has(id)) ring.remove();
    }
    for (const [id, state] of visible) {
        let ring = rings.get(id);
        if (!ring) {
            ring = overlay.ownerDocument.createElement("div");
            ring.className = "object-locator-ring";
            ring.dataset.objectId = id;
            Object.assign(ring.style, {
                position: "absolute", width: "100px", height: "100px", boxSizing: "border-box",
                border: "2px solid #ffe000", borderRadius: "50%", pointerEvents: "none",
                boxShadow: "0 0 2px 1px #000, inset 0 0 2px #000", transform: "translate(-50%, -50%)",
            });
            overlay.appendChild(ring);
        }
        Object.assign(ring.style, {left: `${state.x}px`, top: `${state.y}px`, opacity: String(state.opacity)});
    }
}
