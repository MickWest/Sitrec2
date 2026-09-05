import {getInteractionRouter, INTERACTION, INTERACTION_PRIORITY} from "./InteractionRouter";
import {setRenderOne, UndoManager} from "./Globals";

const registrations = new WeakMap();
let nextId = 0;

// DOM-backed tools share document ownership with the 3D and video adapters.
// Native controls remain boundaries unless a tool explicitly owns that control.
export function registerSurfaceInteraction(element, options) {
    let before, unregister, disposed = false;
    const visible = () => element.isConnected !== false && element.getBoundingClientRect().width > 0
        && element.getBoundingClientRect().height > 0 && options.enabled?.() !== false;
    const contains = e => options.contains ? options.contains(e) : (e.composedPath?.().includes(element) ?? element.contains(e.target));
    const eligible = e => contains(e) && (options.nativeControl || !e.target?.closest?.("input,textarea,select,button,a,[contenteditable=true]"));
    const finish = (e, reason, info) => {
        const initial = before;
        before = undefined;
        try {
            if (reason === "rollback" && initial !== undefined) options.restore(initial);
            (options.end ?? options.cancel)?.(e, reason);
            if (reason === "released" && info?.click) options.click?.(e);
            if (reason !== "rollback" && initial !== undefined && options.undo) {
                const after = options.snapshot();
                if (JSON.stringify(initial) !== JSON.stringify(after)) UndoManager?.add({
                    description: options.undo,
                    undo: () => { options.restore(initial); setRenderOne(true); },
                    redo: () => { options.restore(after); setRenderOne(true); },
                });
            }
        } finally { setRenderOne(true); }
    };
    const adapter = {
        id: options.id ?? `surface:${options.model?.id ?? ++nextId}`,
        model: options.model, view: options.view, profile: options.profile, allowNative: true, surface: true,
        enabled: visible, valid: () => visible() && options.valid?.() !== false,
        hitTest: e => {
            if (!eligible(e) || !(options.buttons ?? [0]).includes(e.button)) return null;
            const hit = options.hitTest ? options.hitTest(e) : {};
            return hit && {kind: INTERACTION.DRAG, priority: INTERACTION_PRIORITY.TOOL,
                zIndex: options.view?.zIndex ?? 0, ...options.intent, ...hit};
        },
        hitSurface: e => eligible(e) && (!options.hitSurface || options.hitSurface(e)) ? {zIndex: options.view?.zIndex ?? 0, ...options.intent} : null,
        begin: (e, hit) => {
            before = options.snapshot?.();
            return options.begin?.(e, hit);
        },
        move: (e, dx, dy) => { options.move?.(e, dx, dy); setRenderOne(true); },
        end: (e, info) => finish(e, "released", info), cancel: (e, reason) => finish(e, reason),
        hover: options.hover,
        cursor: options.cursor,
        capture: options.capture,
        controls: options.controls,
        navigation: options.navigation,
    };
    if (options.restore) adapter.rollback = e => finish(e, "rollback");
    else if (options.rollback) adapter.rollback = options.rollback;
    if (options.wheel) adapter.wheel = options.wheel;
    if (options.contextMenu) adapter.contextMenu = options.contextMenu;
    const rebind = () => {
        unregister?.();
        if (!disposed) unregister = getInteractionRouter(element.ownerDocument).register(adapter);
    };
    rebind();
    const touchAction = element.style.touchAction;
    element.style.touchAction = options.touchAction ?? "none";
    let entries = registrations.get(element);
    if (!entries) registrations.set(element, entries = new Set());
    entries.add(rebind);
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        unregister?.();
        entries.delete(rebind);
        element.style.touchAction = touchAction;
        options.view?._surfaceInteractions?.delete(dispose);
        options.view?._contentInteractions?.delete(dispose);
    };
    if (options.view) {
        (options.view._surfaceInteractions ??= new Set()).add(dispose);
        if (options.content !== false) (options.view._contentInteractions ??= new Set()).add(dispose);
    }
    dispose.adapter = adapter;
    return dispose;
}

// Moving DOM into another window also moves its providers to that document.
export function rebindSurfaceInteractions(root) {
    for (const element of [root, ...(root.querySelectorAll?.("*") ?? [])]) {
        registrations.get(element)?.forEach(rebind => rebind());
    }
}
