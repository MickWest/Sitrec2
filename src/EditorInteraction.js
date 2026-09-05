import {ViewMan} from "./CViewManager";
import {getInteractiveViewAt, isViewDisplayed} from "./ViewUtils";
import {getInteractionRouter, INTERACTION, interactionEvent} from "./InteractionRouter";
import {setRenderOne} from "./Globals";
import {handleCursor, paddedHandlePick} from "./HandleStyle";
import {setDragHandleState} from "./HandleGeometry";

export function editingControls() {
    const result = [];
    ViewMan.iterate((id, view) => { if (view.controls) result.push(view.controls); });
    return result;
}

// 3D editors keep their geometry/constraint calculations; the router owns the
// pointer, view, control lease, cancellation and completion around those methods.
export function registerEditorInteraction(model, options) {
    let view;
    let offset;
    let feedbackHandle;
    const feedback = (handle, state) => {
        if (handle !== feedbackHandle) setDragHandleState(feedbackHandle);
        feedbackHandle = handle;
        setDragHandleState(handle, state);
    };
    const activeHandle = () => model.draggingPoint?.isMesh ? model.draggingPoint
        : model.draggingHandle?.mesh ?? (typeof model.draggingHandle === "string" ? model[model.draggingHandle + "Handle"] : null)
        ?? model.cornerHandles?.[model.draggingCorner] ?? feedbackHandle;
    const adjusted = e => offset ? interactionEvent(e, {clientX: e.clientX + offset.x, clientY: e.clientY + offset.y}) : e;
    const finish = e => {
        try { (options.end ?? (e => model.onPointerUp(e)))(adjusted(e)); }
        finally { feedback(null); setRenderOne(true); }
    };
    const adapter = {
        id: options.id ?? `editor:${model.id}`, model, profile: options.profile ?? "handles",
        relatedModels: options.relatedModels,
        cursor: (e, hit, dragging) => handleCursor((hit.handle ?? activeHandle())?.userData?.handleRole, dragging),
        enabled: options.enabled ?? (() => model.editMode && model.visible !== false),
        valid: () => isViewDisplayed(view),
        hitTest: e => {
            if (e.button !== 0) return null;
            const candidateView = getInteractiveViewAt(e.clientX, e.clientY);
            if (!candidateView) return null;
            const hit = paddedHandlePick(e, at => options.pick(at, candidateView));
            return hit ? {kind: INTERACTION.DRAG, priority: 60, ...hit,
                view: candidateView, zIndex: candidateView.zIndex ?? 0} : null;
        },
        begin: (e, hit) => {
            view = hit.view;
            offset = hit.pointerOffset;
            model.activeView = view;
            document.body.style.cursor = "grabbing";
            const result = (options.begin ?? (e => model.onPointerDown(e)))(adjusted(e), hit);
            feedback(activeHandle() ?? hit.handle, "dragging");
            return result;
        },
        move: e => {
            (options.move ?? (e => model.onPointerMove(e)))(adjusted(e));
            feedback(activeHandle(), "dragging");
            setRenderOne(true);
        },
        end: finish, cancel: finish,
        controls: editingControls,
        capture: () => view?.canvas,
        hover: (e, hit) => {
            if (e) {
                document.body.style.cursor = "grab";
                (options.hover ?? (e => model.onPointerMove(e)))(e);
                feedback(hit?.handle, "hover");
            } else {
                feedback(null);
                document.body.style.cursor = "";
                model.hoveredHandle = null;
                model.updateHandleColors?.();
                options.leave?.();
            }
            setRenderOne(true);
        },
    };
    if (options.contextMenu) {
        adapter.hitSurface = e => {
            const candidateView = getInteractiveViewAt(e.clientX, e.clientY);
            return candidateView && options.pick(e, candidateView)
                ? {zIndex: candidateView.zIndex ?? 0, priority: 60} : null;
        };
        adapter.contextMenu = options.contextMenu;
    }
    if (options.redirect) adapter.redirect = (e, hit) => {
        const target = options.redirect(e);
        const next = target?.unregisterInteraction?.adapter;
        return next ? {...next, adapter: next, view: hit.view, kind: hit.kind} : hit;
    };
    if (options.rollback) adapter.rollback = e => { options.rollback(e); setRenderOne(true); };
    else if (model.restoreState) adapter.rollback = e => {
        const before = model.stateBeforeDrag;
        model.stateBeforeDrag = null;
        // Restore before completion so no intermediate geometry is committed.
        if (before) model.restoreState(before);
        finish(e);
    };
    const unregister = getInteractionRouter().register(adapter);
    unregister.adapter = adapter;
    return unregister;
}
