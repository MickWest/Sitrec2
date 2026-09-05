import {registerSurfaceInteraction} from "../SurfaceInteraction";
import {mouseInViewOnly} from "../ViewUtils";
import {CNodeViewUI} from "./CNodeViewUI";
import {Vector2} from "three";
import {setRenderOne} from "../Globals";

// A DDI is a screen in a fighter jet, F/A-18 or similar
// it's square and has five buttons on each edge (10 horizontal, 10 vertical)
// These are physical buttons, but here are toggled by clicking on
// the on-screen text next to a button
// Some buttons can be "boxed"
//
// Buttons are numbered clockwise from bottom left
/*


               6      7        8       9       10
         +----------------------------------------------+
     5   |                                              |  11
         |                                              |
         |          v                   ^               |
    4    |                                              |
         |                                              |  12
         |                                              |
         |                      |                       |
    3    |                      |                       |  13
         |                     -|-                      |
         |                                              |
         |                                              |
    2    |                                              |  14
         |                                              |
         |                                              |
    1    |                               0              |  15
         |                                              |
         +----------------------------------------------+
              20      19      18       17       16

 */

function spreadButtons(centerRelativeNumber, spacing) {
    return 50 + centerRelativeNumber * spacing;
}

const sideOffset = 5;
const topOffset = 5;
const spacing = 15

export class CDDIButton {
    constructor(number, text, toggle, callback) {
        this.number = number
        this.text = text
        this.toggle = toggle
        this.callback = callback

        // the position is the CENTER of the text/button
        this.position = new Vector2(0,0)
        if (this.number <= 5) {
            // left side
            this.position.x = sideOffset
            this.position.y = spreadButtons( -(this.number-3),spacing)
        } else if (this.number <= 10 ) {
            // top
            this.position.x = spreadButtons(this.number-8,spacing)
            this.position.y = topOffset
        } else if (this.number <= 15 ) {
            // right side
            this.position.x = 100-sideOffset
            this.position.y = spreadButtons(this.number-13,spacing)
        }
        else {
            // bottom
            this.position.x = spreadButtons(-(this.number-18),spacing)
            this.position.y = 100-topOffset

        }


    }
}

function inside(x,y,left,top,right,bot) {
    return x>=left && x<=right && y>=top && y<=bot
}

export class CNodeDDI extends CNodeViewUI {
    constructor(v) {
        // DDI is always square aspect
        if (v.freeAspect === undefined) v.freeAspect = false;

        super(v);
        this.buttons = new Array(20)

        this.autoFill = true;
        this.autoFillColor = v.autoFillColor ?? "#000000";

        this.canvas.style.pointerEvents = 'none';
        this.unregisterButtonInteraction = registerSurfaceInteraction(this.canvas, {
            model: this, view: this, profile: "buttons", intent: {kind: "click", priority: 85},
            contains: e => (e.target === this.div || e.target?.tagName === "CANVAS") && mouseInViewOnly(this, e.clientX, e.clientY),
            hitTest: e => {
                const r = this.canvas.getBoundingClientRect();
                return this._hitTestButton(e.clientX - r.left, e.clientY - r.top) ? {} : null;
            },
            click: e => this._handleCanvasPointerDown(e),
            cursor: "pointer",
        });

        this._boundCanvasDblClick = (e) => { e.stopPropagation(); e.preventDefault(); };
        this.canvas.addEventListener('dblclick', this._boundCanvasDblClick);
    }

    // Check if canvas-relative coordinates are over a DDI button
    _hitTestButton(canvasX, canvasY) {
        for (const b of this.buttons) {
            if (!b) continue;
            const bb = b.textObject.bbox;
            if (!bb) continue;
            const cx = this.px(b.position.x);
            const cy = this.py(b.position.y);
            if (inside(canvasX, canvasY, cx + bb.left, cy + bb.top, cx + bb.right, cy + bb.bottom)) {
                return b;
            }
        }
        return null;
    }

    _handleCanvasPointerDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const b = this._hitTestButton(x, y);
        if (b) {
            if (b.toggle) {
                b.textObject.boxed = !b.textObject.boxed;
            }
            if (b.callback) {
                b.callback(b);
            }
            // Stop the event from reaching makeDraggable on the parent div
            e.stopPropagation();
            e.preventDefault();
            setRenderOne(true);
        }
    }

    setButton(number, text="BTN", toggle=false, callback=null) {
        this.buttons[number] = new CDDIButton(number,text, toggle, callback)
        this.buttons[number].textObject = this.addText(number,text,this.buttons[number].position.x, this.buttons[number].position.y, 3.5)
    }

    setButtonText(n, text) {
        this.buttons[n].textObject.text = text
    }

    update() {
    }

    dispose() {
        this.unregisterButtonInteraction?.();
        this.canvas.removeEventListener('dblclick', this._boundCanvasDblClick);
        super.dispose();
    }
}
