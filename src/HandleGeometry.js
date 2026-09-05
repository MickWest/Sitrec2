import {HANDLE_STYLE} from "./HandleStyle";

export function setDragHandleState(handle, state = "idle") {
    if (!handle?.material?.color || !handle.userData.handleRole) return;
    const material = handle.material;
    // Restore the material's own appearance after feedback, including widgets
    // with established colors/opacity and meshes that share one material.
    const base = material.userData.handleBaseStyle ??= {color: material.color.getHex(), opacity: material.opacity};
    handle.material.color.setHex(state === "dragging" ? HANDLE_STYLE.dragging
        : state === "hover" || state === "selected" ? HANDLE_STYLE.hover : base.color);
    handle.material.opacity = state === "unavailable" ? HANDLE_STYLE.unavailableOpacity : base.opacity;
    handle.userData.interactionState = state;
}
