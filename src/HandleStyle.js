import {interactionEvent} from "./InteractionRouter";

// Shared feedback and touch padding. Tools retain their established shapes,
// identity colors and mouse targets; sizes are in CSS pixels.
export const HANDLE_STYLE = Object.freeze({
    pointRadius: 9, touchRadius: 24,
    hover: 0xffffff, dragging: 0xffff00, unavailableOpacity: 0.3,
});

// Preserve each tool's established mouse target; touch expansion is decided
// during probing, before a gesture begins, and never depends on prior input.
export const pointerHitRadius = (event, mouseRadius) => event?.pointerType === "touch"
    ? Math.max(mouseRadius, HANDLE_STYLE.touchRadius) : mouseRadius;

export function handleCursor(role, dragging = false) {
    if (role === "axis" || role === "altitude") return "ns-resize";
    if (role === "resize") return "nwse-resize";
    if (role === "rotate") return "crosshair";
    return dragging ? "grabbing" : "grab";
}

export function drawHandleHalo(ctx, x, y, radius, state) {
    if (!["hover", "selected", "dragging"].includes(state)) return;
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, radius + 3, 0, Math.PI * 2);
    ctx.lineWidth = 3.5; ctx.strokeStyle = "rgba(0,0,0,0.7)"; ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = state === "dragging" ? "#ffff00" : "#ffffff";
    ctx.stroke(); ctx.restore();
}

// Expand the pick target without expanding the drawing. Keep the same offset
// throughout the drag so a finger grabbing the padding never snaps the object.
export function paddedHandlePick(event, pick) {
    const direct = pick(event);
    if (event.pointerType !== "touch" || (direct && (direct.priority ?? 60) >= 60)) return direct;
    let best = direct;
    for (const radius of [8, HANDLE_STYLE.touchRadius - HANDLE_STYLE.pointRadius]) {
        for (let i = 0; i < 12; i++) {
            const x = Math.cos(i * Math.PI / 6) * radius, y = Math.sin(i * Math.PI / 6) * radius;
            const hit = pick(interactionEvent(event, {clientX: event.clientX + x, clientY: event.clientY + y}));
            if (hit && (!best || (hit.priority ?? 60) > (best.priority ?? 60))) best = {...hit, pointerOffset: {x, y}};
        }
        if (best && (best.priority ?? 60) >= 60) break;
    }
    return best;
}
