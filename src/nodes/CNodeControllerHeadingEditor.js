import {CNodeController} from "./CNodeController";
import {HeadingEditorView} from "../HeadingEditorView";
import {Globals, markSitchDirty, setRenderOne, Sit, UndoManager} from "../Globals";
import {radians} from "../utils";
import {par} from "../par";

export class CNodeControllerHeadingEditor extends CNodeController {
    constructor(v) {
        super(v);
        this.useEditor = v.useEditor ?? false;
        this.controllerOrder = 100;
        this.isEditorWindow = true;
        this.simpleSerials.push("useEditor");
        this.basePoses = new WeakMap();
        this.editorView = new HeadingEditorView({
            id: `${this.id}View`, menuName: "Heading Editor", visible: false,
            left: 0.05, top: 0.5, width: 0.45, height: 0.45,
            draggable: true, resizable: true, freeAspect: true, shiftDrag: false,
        });
        this.editorView.hintWarning = () => !this.isActive() ? "Not in use: enable Use Heading Editor in Camera → Heading" : null;
        this.editorView.onChange = () => {
            this.recalculateCascade();
            if (!Globals.deserializing) markSitchDirty();
            setRenderOne(true);
        };
    }

    isActive() {
        return this.useEditor;
    }

    show(visible = true) {
        super.show(visible);
        this.editorView?.show(visible);
    }

    apply(f, objectNode) {
        const camera = objectNode.camera;
        const previous = this.basePoses.get(camera) ?? this.basePoses.get(camera.sampleSource);
        if (previous && camera.quaternion.equals(previous.after)) camera.quaternion.copy(previous.before);
        this.basePoses.delete(camera);
        if (!this.useEditor) { camera.updateMatrix(); return; }
        const before = camera.quaternion.clone();
        camera.rotateY(-radians(this.editorView.valueAt("pan", f)));
        camera.rotateX(radians(this.editorView.valueAt("tilt", f)));
        camera.updateMatrix();
        this.basePoses.set(camera, {before, after: camera.quaternion.clone()});
    }

    getBaseQuaternion(camera) {
        return this.useEditor ? this.basePoses.get(camera)?.before : undefined;
    }

    beginViewDrag() {
        this.viewDrag = {before: this.editorView.captureState(), frame: Math.round(par.frame)};
        par.paused = true;
    }

    dragView(panDelta, tiltDelta) {
        if (!this.viewDrag) this.beginViewDrag();
        const frame = Math.max(0, Math.min(Sit.frames - 1, this.viewDrag.frame));
        const view = this.editorView;
        for (const [key, delta] of [["pan", panDelta], ["tilt", tiltDelta]]) {
            const channel = view.channels[key];
            if (!channel.enabled || Math.abs(delta) < 1e-10) continue;
            const value = view.valueAt(key, frame) + delta;
            // A graph point can be dragged to a fractional frame. Treat a point
            // in this frame as the same key, rather than stacking duplicate keys.
            const existing = channel.points.find(p => Math.round(p.x) === frame);
            if (existing) { existing.x = frame; existing.y = value; }
            else channel.points.push({x: frame, y: value});
            channel.points.sort((a, b) => a.x - b.x);
            view.syncEditedChannel(key);
            if (Math.abs(value) > channel.range) {
                channel.range = Math.min(180, Math.abs(value) * 1.1);
                view.controls[key].slider.value = Math.log10(channel.range);
            }
        }
        view.selectChannel(view.activeChannel);
        markSitchDirty();
        setRenderOne(true);
    }

    endViewDrag(cancel = false) {
        const drag = this.viewDrag;
        this.viewDrag = null;
        if (!drag) return;
        const view = this.editorView, after = view.captureState();
        if (JSON.stringify(drag.before) === JSON.stringify(after)) return;
        if (cancel) {
            view.restoreState(drag.before);
        } else {
            UndoManager?.add({description: "Edit heading from look view",
                undo: () => view.restoreState(drag.before), redo: () => view.restoreState(after)});
            view.onChange?.();
        }
    }

    modSerialize() {
        return {...super.modSerialize(), curves: this.editorView.captureState(), defaultSnap: this.editorView.defaultSnap};
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        if (v.curves) this.editorView.restoreState(v.curves);
        if (v.defaultSnap !== undefined) this.editorView.defaultSnap = v.defaultSnap;
    }

}
