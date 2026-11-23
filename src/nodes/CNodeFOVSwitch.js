import {CNodeSwitch} from "./CNodeSwitch";
import {NodeMan} from "../Globals";
import {extractFOV} from "../FOVUtils";

// Every consumer (camera, LOS, exports and fitting) reads the same composed FOV.
// The source choice remains the recorded/manual source when the editor is used.
export class CNodeFOVSwitch extends CNodeSwitch {
    getBaseValue(frame) {
        return super.getValue(frame);
    }

    getEditorOffset(frame) {
        const editor = NodeMan.get("fovEditor", false);
        return editor?.useEditor ? editor.getValue(frame) : 0;
    }

    getValue(frame) {
        const base = this.getBaseValue(frame);
        const offset = this.getEditorOffset(frame);
        if (!offset) return base;
        const fov = Math.min(179, Math.max(0.0001, extractFOV(base) + offset));
        return fov;
    }

    getValueFrame(frame) {
        return this.getValue(frame);
    }
}
