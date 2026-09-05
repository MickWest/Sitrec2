// One mutation owner per gesture. Adapters probe without changing model data,
// then expose begin/move/end/cancel and an optional rollback operation.
export const INTERACTION = Object.freeze({PASS: "pass", CLICK: "click", PENDING: "pending", DRAG: "drag"});
export const INTERACTION_PRIORITY = Object.freeze({LAYOUT: 100, TOOL: 80, HANDLE: 60, OBJECT: 40, PENDING: 20, NAVIGATION: 0});
export const CLICK_SLOP_PX = 5;

const leases = new WeakMap();
export function interactionEvent(event, values) {
    return new Proxy(event, {get(target, key) {
        if (key in values) return values[key];
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
    }});
}
export function acquireControlLease(controls) {
    const unique = [...new Set(controls.filter(Boolean))];
    for (const control of unique) {
        let lease = leases.get(control);
        if (!lease) {
            lease = {count: 0, enabled: control.enabled};
            leases.set(control, lease);
        }
        lease.count++;
        control.enabled = false;
    }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        for (const control of unique) {
            const lease = leases.get(control);
            if (--lease.count === 0) {
                control.enabled = lease.enabled;
                leases.delete(control);
            }
        }
    };
}

function nativeTarget(e) {
    return e.target?.closest?.("input,textarea,select,button,a,dialog,[contenteditable=true],#menuBar,.lil-gui,.view-uibar,.resize-handle,[data-interaction-native]");
}

export class InteractionRouter {
    constructor(doc) {
        this.document = doc;
        this.providers = new Set();
        this.session = null;
        this.lastContextGesture = null;
        this.listeners = [];
        this.hovered = null;
    }

    install() {
        if (this.listeners.length || !this.document) return;
        const listen = (target, type, fn, options = false) => {
            target.addEventListener(type, fn, options);
            this.listeners.push(() => target.removeEventListener(type, fn, options));
        };
        // Bubble lets native UI and unmigrated capture-phase tools decline routing.
        listen(this.document, "pointerdown", e => this.down(e));
        listen(this.document, "pointermove", e => this.move(e));
        listen(this.document, "pointerup", e => this.up(e));
        listen(this.document, "pointercancel", e => this.cancelPointer(e), true);
        listen(this.document, "lostpointercapture", e => this.cancelPointer(e), true);
        listen(this.document, "wheel", e => this.wheel(e), {passive: false});
        // Floating panels stop wheel bubbling at their UI boundary. Registered
        // canvas tools inside them still receive one wheel action.
        listen(this.document, "wheel", e => {
            if (this.candidates(e, "wheel").some(c => c.surface)) this.wheel(e);
        }, {capture: true, passive: false});
        listen(this.document, "contextmenu", e => this.contextMenu(e));
        listen(this.document.defaultView, "blur", e => this.finish(e, "interrupted"));
        listen(this.document.defaultView, "resize", e => this.finish(e, "interrupted"));
        listen(this.document, "visibilitychange", e => {
            if (this.document.hidden) this.finish(e, "interrupted");
        });
        listen(this.document, "keydown", e => {
            if (e.key === "Escape" && this.session) {
                this.finish(e, "rollback");
                this.consume(e);
            }
        }, true);
    }

    addProvider(provider) {
        this.providers.add(provider);
        this.install();
        return () => {
            this.cancelOwner(provider);
            this.providers.delete(provider);
        };
    }

    register(adapter) {
        const provider = () => [adapter];
        adapter.provider = provider;
        return this.addProvider(provider);
    }

    updateCursor(owner, event, dragging = false) {
        this.clearCursor();
        const cursor = typeof owner?.cursor === "function" ? owner.cursor(event, owner, dragging) : owner?.cursor;
        const target = event?.target;
        if (!cursor || !target?.style) return;
        this.cursor = {target, previous: target.style.cursor, value: cursor};
        target.style.cursor = cursor;
    }

    clearCursor() {
        const c = this.cursor;
        if (c && c.target.style.cursor === c.value) c.target.style.cursor = c.previous;
        this.cursor = null;
    }

    candidates(e, action = "pointer") {
        const result = [];
        for (const provider of this.providers) {
            for (const adapter of provider(e) ?? []) {
                if (adapter.enabled?.() === false) continue;
                const hit = action === "pointer" ? adapter.hitTest?.(e) : adapter.hitSurface?.(e);
                if (!hit || hit.kind === INTERACTION.PASS) continue;
                if (action !== "pointer" && !adapter[action]) continue;
                result.push({...adapter, ...hit, adapter, provider});
            }
        }
        return result.sort((a, b) => (b.zIndex ?? 0) - (a.zIndex ?? 0)
            || (b.priority ?? 0) - (a.priority ?? 0)
            || (a.distance ?? Infinity) - (b.distance ?? Infinity)
            || String(a.id).localeCompare(String(b.id)));
    }

    consume(e) {
        e.preventDefault?.();
        e.stopImmediatePropagation?.();
    }

    down(e) {
        if (this.session) {
            try { this.addTouch(e); }
            catch (error) { this.finish(e, "interrupted"); throw error; }
            this.consume(e);
            return;
        }
        this.lastContextGesture = null;
        if (e.defaultPrevented || e.button > 2) return;
        const candidates = this.candidates(e).filter(c => !nativeTarget(e) || c.allowNative);
        for (let i = 0; i < candidates.length; i++) {
            let owner = candidates[i];
            this.hovered?.hover?.(null);
            this.hovered = null;
            this.clearCursor();
            // A selected duplication command can replace its target before a
            // session starts; all subsequent events belong to the copy.
            if (owner.redirect) owner = owner.redirect(e, owner) ?? owner;
            const session = {
                owner, pointerId: e.pointerId, button: e.button, start: e,
                x: e.clientX, y: e.clientY, last: e, maxTravel: 0, navigation: owner.navigation,
                touches: new Map(e.pointerType === "touch" ? [[e.pointerId, e]] : []), capturedIds: new Set(),
                fallback: candidates.slice(i + 1).find(c => c.navigation),
            };
            session.contextOwner = owner.navigation ? (this.candidates(e, "contextMenu")[0] ?? owner) : owner;
            this.session = session;
            session.release = acquireControlLease(owner.controls?.() ?? []);
            try {
                if (owner.begin?.(e, owner) === false) {
                    session.release();
                    owner.hover?.(null);
                    this.session = null;
                    continue;
                }
                this.updateCursor(owner, e, true);
                const capture = owner.capture?.() ?? e.target;
                if (capture?.setPointerCapture && e.pointerId !== undefined) {
                    try { capture.setPointerCapture(e.pointerId); session.capture = capture; session.capturedIds.add(e.pointerId); } catch (_) { /* document listeners remain active */ }
                }
                this.watch();
                if (e.pointerType === "touch" && session.contextOwner.contextMenu) {
                    session.longPress = setTimeout(() => {
                        if (this.session !== session) return;
                        this.finish(e, "interrupted");
                        this.lastContextGesture = {target: e.target};
                        session.contextOwner.contextMenu(e);
                    }, 500);
                }
                this.consume(e);
                return owner;
            } catch (error) {
                this.finish(e, "interrupted");
                throw error;
            }
        }
    }

    touchEvent(e, s = this.session) {
        return interactionEvent(e, {touches: [...s.touches.values()]});
    }

    addTouch(e) {
        const s = this.session;
        if (e.pointerType !== "touch" || !s.touches.size || s.touches.has(e.pointerId) || nativeTarget(e)) return;
        if (!s.owner.hitSurface?.(e) && !s.fallback?.hitSurface?.(e)) return;
        clearTimeout(s.longPress);
        if (s.owner.kind === INTERACTION.CLICK) s.maxTravel = Infinity;
        if (s.owner.kind === INTERACTION.PENDING) {
            if (!s.fallback?.beginTouches) { this.finish(s.last, "interrupted"); return; }
            s.owner.cancel?.(s.last, "superseded");
            s.release();
            s.owner = s.fallback;
            s.navigation = true;
            s.release = acquireControlLease(s.owner.controls?.() ?? []);
        } else if (!s.navigation || !s.owner.beginTouches) return;
        if (s.multi) s.owner.endTouches?.(interactionEvent(e, {touches: []}));
        else s.owner.cancel?.(s.last, "multitouch");
        s.touches.set(e.pointerId, e);
        try { s.capture?.setPointerCapture(e.pointerId); s.capturedIds.add(e.pointerId); } catch (_) { /* document fallback */ }
        s.multi = true;
        s.maxTravel = Infinity; // A multi-contact gesture never becomes a click.
        s.owner.beginTouches(this.touchEvent(e));
    }

    valid() {
        const s = this.session;
        return !s || (s.owner.enabled?.() !== false && s.owner.valid?.() !== false);
    }

    watch() {
        const win = this.document?.defaultView;
        if (!win?.requestAnimationFrame || this.frame) return;
        this.frame = win.requestAnimationFrame(() => {
            this.frame = null;
            if (!this.valid()) this.finish(this.session.start, "interrupted");
            if (this.session) this.watch();
        });
    }

    move(e) {
        const s = this.session;
        if (!s) {
            const hit = this.candidates(interactionEvent(e, {button: 0})).find(c => !nativeTarget(e) || c.allowNative);
            if (this.hovered?.adapter !== hit?.adapter) this.hovered?.hover?.(null);
            this.hovered = hit;
            hit?.hover?.(e, hit);
            this.updateCursor(hit, e);
            return;
        }
        if (s.multi) {
            if (!s.touches.has(e.pointerId)) return;
            if (!this.valid()) { this.finish(s.last, "interrupted"); return; }
            s.touches.set(e.pointerId, e);
            try { s.owner.moveTouches?.(this.touchEvent(e)); }
            catch (error) { this.finish(e, "interrupted"); throw error; }
            this.consume(e);
            return;
        }
        if (e.pointerId !== s.pointerId) return;
        if (!this.valid() || e.buttons === 0) {
            this.finish(e, "interrupted");
            return;
        }
        this.applyMove(e);
        this.consume(e);
    }

    applyMove(e) {
        try { this.applyDelta(e); }
        catch (error) { this.finish(e, "interrupted"); throw error; }
    }

    applyDelta(e) {
        const s = this.session;
        s.last = e;
        if (s.touches.has(e.pointerId)) s.touches.set(e.pointerId, e);
        s.maxTravel = Math.max(s.maxTravel, Math.hypot(e.clientX - s.start.clientX, e.clientY - s.start.clientY));
        if (s.maxTravel > CLICK_SLOP_PX) clearTimeout(s.longPress);
        if (s.owner.kind === INTERACTION.PENDING && s.maxTravel > CLICK_SLOP_PX) {
            s.owner.cancel?.(e, "superseded");
            s.release();
            if (!s.fallback) {
                // Cancellation above already completed this owner.
                s.owner = {};
                this.finish(e, "interrupted");
                return;
            }
            s.owner = s.fallback;
            s.navigation = true;
            s.release = acquireControlLease(s.owner.controls?.() ?? []);
            s.owner.begin?.(s.start, s.owner);
            s.x = s.start.clientX; s.y = s.start.clientY;
        }
        const dx = e.clientX - s.x, dy = e.clientY - s.y;
        s.x = e.clientX; s.y = e.clientY;
        if ((dx || dy) && s.owner.kind !== INTERACTION.CLICK && s.owner.kind !== INTERACTION.PENDING) {
            // Release coordinates can be newer than the last move. Preserve the
            // initiating button while adapters apply that final movement.
            const moveEvent = e.type === "pointerup" ? interactionEvent(e, {
                buttons: [1, 4, 2][s.button], type: "pointermove",
            }) : e;
            s.owner.move?.(moveEvent, dx, dy);
        }
    }

    up(e) {
        try { this.completePointer(e); }
        catch (error) { this.finish(e, "interrupted"); throw error; }
    }

    completePointer(e) {
        const s = this.session;
        if (s?.multi && s.touches.has(e.pointerId)) {
            s.touches.delete(e.pointerId);
            s.owner.endTouches?.(this.touchEvent(e));
            if (s.touches.size === 1) {
                const remaining = [...s.touches.values()][0];
                s.multi = false;
                s.pointerId = remaining.pointerId;
                s.start = s.last = interactionEvent(remaining, {button: 0, buttons: 1, resumed: true});
                s.x = remaining.clientX; s.y = remaining.clientY;
                s.owner.begin?.(s.start, s.owner);
            } else if (s.touches.size > 1) s.owner.beginTouches?.(this.touchEvent(e));
            else this.finish(e, "interrupted");
            this.consume(e);
            return;
        }
        if (!s || s.pointerId !== e.pointerId || s.button !== e.button) return;
        if (!this.valid()) { this.finish(e, "interrupted"); return; }
        this.applyMove(e);
        this.finish(e, "released");
        this.consume(e);
    }

    releaseCapture(s) {
        for (const id of s.capturedIds) {
            try {
                if (s.capture?.hasPointerCapture?.(id)) s.capture.releasePointerCapture(id);
            } catch (_) { /* The browser may already have cancelled this contact. */ }
        }
    }

    finish(e, reason) {
        const s = this.session;
        if (!s) return;
        this.session = null;
        clearTimeout(s.longPress);
        if (this.frame) this.document.defaultView.cancelAnimationFrame(this.frame);
        this.frame = null;
        const event = reason === "released" ? e : s.last;
        try {
            if (s.multi) s.owner.endTouches?.(interactionEvent(event, {touches: []}));
            if (reason === "rollback" && s.owner.rollback) s.owner.rollback(event);
            else if (reason !== "released") (s.owner.cancel ?? s.owner.end)?.(event, reason);
            else s.owner.end?.(event, {click: s.maxTravel <= CLICK_SLOP_PX, maxTravel: s.maxTravel});
            if (s.button === 2) {
                this.lastContextGesture = {target: s.start.target, x: s.start.clientX, y: s.start.clientY};
                if (reason === "released" && s.maxTravel <= CLICK_SLOP_PX) s.contextOwner.contextMenu?.(e);
            }
        } finally {
            s.release();
            this.releaseCapture(s);
            s.owner.hover?.(null);
            this.clearCursor();
        }
    }

    cancelPointer(e) {
        if (this.session?.pointerId === e.pointerId || this.session?.touches.has(e.pointerId)) this.finish(e, "interrupted");
    }

    cancelOwner(owner, reason = "interrupted") {
        const s = this.session;
        if (s && (s.owner.provider === owner || s.owner.adapter === owner || s.owner.model === owner
            || s.owner.view === owner || s.owner.model?.overlayView === owner || s.owner.model?.host === owner
            || s.owner.relatedModels?.includes(owner))) this.finish(s.start, reason);
        const h = this.hovered;
        if (h && (h.provider === owner || h.adapter === owner || h.model === owner || h.view === owner)) {
            h.hover?.(null);
            this.hovered = null;
            this.clearCursor();
        }
    }

    wheel(e) {
        if (e.defaultPrevented) return;
        // Authoring locks navigation until completion; a navigation session may wheel.
        if (this.session && !this.session.navigation) { this.consume(e); return; }
        const owner = this.session?.owner ?? this.candidates(e, "wheel").find(c => !nativeTarget(e) || c.allowNative);
        if (owner?.wheel) { owner.wheel(e); this.consume(e); }
    }

    contextMenu(e) {
        if (nativeTarget(e) && !this.candidates(e, "contextMenu").some(c => c.allowNative)) return;
        if (this.session || (e.button === 2 && this.lastContextGesture?.target === e.target)) {
            this.consume(e);
            return;
        }
        const owner = this.candidates(e, "contextMenu")[0];
        if (owner) { owner.contextMenu(e); this.consume(e); }
    }

    dispose() {
        this.finish(this.session?.start, "interrupted");
        this.hovered?.hover?.(null);
        this.hovered = null;
        this.clearCursor();
        this.listeners.splice(0).forEach(remove => remove());
        this.providers.clear();
    }
}

const routers = new WeakMap();
export function getInteractionRouter(doc = globalThis.document) {
    if (!doc) return null;
    if (!routers.has(doc)) routers.set(doc, new InteractionRouter(doc));
    return routers.get(doc);
}
