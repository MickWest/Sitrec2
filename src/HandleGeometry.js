import {BoxGeometry, CircleGeometry, ConeGeometry, Mesh, MeshBasicMaterial, RingGeometry, DoubleSide} from "three";
import {HANDLE_STYLE} from "./HandleStyle";

// A small vocabulary of grips. Pick geometry is deliberately simpler than the
// drawing: the center of a rotation ring is an accessible target too.
export function createDragHandle(role, {radius = 3, depthTest = true} = {}) {
    let geometry;
    if (role === "altitude") geometry = new ConeGeometry(radius, radius * 3, 12);
    else if (role === "resize") geometry = new BoxGeometry(radius * 1.7, radius * 1.7, radius * 1.7);
    else if (role === "rotate") geometry = new RingGeometry(radius * .7, radius, 32);
    else geometry = new CircleGeometry(radius, 32);
    const material = new MeshBasicMaterial({color: HANDLE_STYLE[role], transparent: true,
        opacity: .85, depthTest, depthWrite: false, side: DoubleSide});
    const handle = new Mesh(geometry, material);
    handle.userData.handleRole = role;
    handle.userData.handleRadius = radius;
    if (role === "rotate") {
        const pickGeometry = new CircleGeometry(radius, 32);
        handle.raycast = function(raycaster, intersects) {
            const drawing = this.geometry;
            try {
                this.geometry = pickGeometry;
                Mesh.prototype.raycast.call(this, raycaster, intersects);
            } finally { this.geometry = drawing; }
        };
        geometry.addEventListener("dispose", () => pickGeometry.dispose());
    }
    return handle;
}

export function setDragHandleState(handle, state = "idle") {
    if (!handle?.material?.color || !handle.userData.handleRole) return;
    const role = handle.userData.handleRole;
    handle.material.color.setHex(state === "dragging" ? HANDLE_STYLE.dragging
        : state === "hover" ? HANDLE_STYLE.hover : HANDLE_STYLE[role]);
    handle.userData.interactionState = state;
}
