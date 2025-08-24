import {CNodeView} from "./CNodeView";
import {setChartDiv, updateChartSize} from "../JetChart";
import {makeDraggable, makeResizable} from "../DragResizeUtils";

export class CNodeChartView extends CNodeView {
    constructor(v) {
        super(v);
        setChartDiv(this.div)
        this.div.style.fontFamily = "Monospace"
        this.div.style.backgroundColor = "black"
        this.div.style.color = "grey";
        this.div.setAttribute("id", "myChartDiv")
        this.div.style.pointerEvents = 'auto'
        
        // Make the div draggable with shift key requirement
        makeDraggable(this.div, {
            viewInstance: this,
            shiftKey: true,
            onDrag: (event, data) => {
                return event.shiftKey;
            }
        });
        
        // Make the div resizable
        makeResizable(this.div, {
            viewInstance: this,
            onResize: (event, data) => {
                updateChartSize();
                return true;
            }
        });
    }

    // if the doubleclick has updated the size, we need to pass that on
    // to the chart object
    doubleClick() {
        super.doubleClick()
        updateChartSize()
    }
}