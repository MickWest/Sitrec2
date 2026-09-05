import {ViewMan} from "./CViewManager";
import {isViewDisplayed, mouseInViewOnly} from "./ViewUtils";
import {getInteractionRouter, INTERACTION, INTERACTION_PRIORITY, interactionEvent} from "./InteractionRouter";
import {paddedHandlePick} from "./HandleStyle";
import {setRenderOne} from "./Globals";

const adapters = new WeakMap();

export function viewInteractionAdapter(view) {
    if (adapters.has(view)) return adapters.get(view);
    let offset;
    const adjusted = e => offset ? interactionEvent(e, {clientX: e.clientX + offset.x, clientY: e.clientY + offset.y}) : e;
    const adapter = {
        id: `view:${view.id}`, model: view,
        enabled: () => isViewDisplayed(view) && view.isInteractionEnabled?.() !== false,
        valid: () => isViewDisplayed(view),
        hitTest: e => {
            if (!mouseInViewOnly(view, e.clientX, e.clientY)) return null;
            const intent = paddedHandlePick(e, at => view.getInteractionIntent?.(at, at.clientX, at.clientY));
            if (intent !== undefined) return intent && {...intent, zIndex: view.zIndex ?? 0};
            // Non-migrated 2D views retain their handler contract, but only one
            // selected handler runs. Pilot editors declare a side-effect-free intent.
            if (!view.onMouseDown || view.controls) return null;
            return {kind: INTERACTION.DRAG, priority: INTERACTION_PRIORITY.TOOL, zIndex: view.zIndex ?? 0};
        },
        begin: (e, hit) => {
            offset = hit.pointerOffset;
            e = adjusted(e);
            const result = view.onMouseDown(e, e.clientX, e.clientY);
            setRenderOne(true);
            // Pending fit clicks intentionally return false to legacy callers.
            return view.pendingAdd ? true : result;
        },
        move: (e, dx, dy) => {
            e = adjusted(e);
            (view.onMouseDrag ?? view.onMouseMove)?.call(view, e, e.clientX, e.clientY, dx, dy);
            setRenderOne(true);
        },
        end: e => { e = adjusted(e); view.onMouseUp?.(e, e.clientX, e.clientY); setRenderOne(true); },
        cancel: (e, reason) => {
            e = adjusted(e);
            if (view.onMouseCancel) view.onMouseCancel(e, e.clientX, e.clientY, reason);
            else view.onMouseUp?.(e, e.clientX, e.clientY);
            setRenderOne(true);
        },
        hover: (e, hit) => {
            const hovered = hit?.handleId ?? null;
            if (view.interactionHover !== hovered) { view.interactionHover = hovered; setRenderOne(true); }
            if (e) view.onMouseMove?.(e, e.clientX, e.clientY, 0, 0);
        },
        capture: () => view.overlayView?.canvas ?? view.host?.canvas ?? view.canvas,
        // One actual surface receives wheel input; overlay forwarding is omitted.
        hitSurface: e => !view.overlayView && !view.host && mouseInViewOnly(view, e.clientX, e.clientY)
            ? {zIndex: view.zIndex ?? 0} : null,
    };
    if (view.onMouseWheel && !view.mouse && !view.controls) adapter.wheel = e => view.onMouseWheel(e, e.clientX, e.clientY, e.deltaX, e.deltaY);
    if (view.onMouseRollback) adapter.rollback = e => view.onMouseRollback(e);
    adapters.set(view, adapter);
    return adapter;
}

export function installViewInteractions(doc = document) {
    const router = getInteractionRouter(doc);
    return router.addProvider(() => {
        const result = [];
        ViewMan.iterateVisibleIncludingOverlays((id, view) => {
            if (view.onMouseDown || view.onMouseWheel) result.push(viewInteractionAdapter(view));
        });
        return result;
    });
}
