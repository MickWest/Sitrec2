import {interactionEvent} from "./InteractionRouter";

// CSS pixels throughout. Geometry uses these radii, not a device-pixel ratio.
export const HANDLE_STYLE = Object.freeze({
    pointRadius: 9, moveRadius: 16, altitudeLength: 24, rotationRadius: 30,
    mouseRadius: 14, touchRadius: 24,
    move: 0x00ff80, altitude: 0xffcc00, resize: 0x00ffff, rotate: 0xff8800,
    hover: 0xffffff, dragging: 0xffff00, unavailableOpacity: 0.3,
});

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
