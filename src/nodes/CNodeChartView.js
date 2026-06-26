import {CNodeView} from "./CNodeView";
import {setChartDiv, updateChartSize} from "../JetChart";

export class CNodeChartView extends CNodeView {
    constructor(v) {
        // Use the standard consolidated-window chrome from the base CNodeView — CUIBar header
        // (fullscreen/pin/close), a no-modifier header drag-handle, Q-body-drag and edge-resize
        // handles — instead of the old bespoke shift-drag + own makeResizable. Forced here (like
        // CNodeViewDAG) so it's standard regardless of the call site.
        v.draggable = v.draggable ?? true;
        v.resizable = v.resizable ?? true;
        super(v);
        setChartDiv(this.div)
        this.div.style.fontFamily = "Monospace"
        this.div.style.backgroundColor = "black"
        this.div.style.color = "grey";
        this.div.setAttribute("id", "myChartDiv")
        this.div.style.pointerEvents = 'auto'
    }

    // Re-fit the JetChart whenever the view's size changes. The base fires changedSize() on any
    // resize (edge-drag, fullscreen toggle, window resize), which replaces the old per-view
    // makeResizable({onResize}) hook.
    changedSize() {
        super.changedSize();
        updateChartSize();
    }

    // doubleClick toggles fullscreen in the base; re-fit afterwards too.
    doubleClick() {
        super.doubleClick()
        updateChartSize()
    }
}
