import {HANDLE_STYLE} from "./HandleStyle";
import {Vector2} from "three";
import {clockwiseXY, makeBRight} from "./utils";
import {mouseToCanvas} from "./ViewUtils";

const DRAG_NONE         = 0   // not doing anything
const DRAG_INITIAL      = 1   // initial rectangular selection
const DRAG_RESIZE       = 2   // resize and rota
const DRAG_MOVE         = 3   // just move without resizing
const DRAG_ROTATE       = 4   // rotate by dragging outside
const DRAG_POINT        = 5   // dragging a corner or line

// is a point p inside a quad defined by four points?
// it is if the dot products of vectors perp to the edge with the vector to the point are all negative
// i.e. for any given edge AB, then find AB rotated 90  (y, -x)
// and then get the dot product with A->P
// dot product is x*xp + y*yp
// so if point (x,y) is AB, then we need (y,-x), hence
// dot is y*xp - x*yp

function inside(p, quad) {
    var right = true;
    for (var q=0;q<4;q++) {
        var q1 = q + 1
        if (q1 === 4) q1 = 0;
        var q0toq1 = quad[q1].clone().sub(quad[q])
        var q0top = p.clone().sub(quad[q])
        var dot = q0toq1.y*q0top.x - q0toq1.x*q0top.y
        if (dot > 0 ) right = false;
    }
    return right
}

class CDraggable {
    constructor() {

    }
}

const DRAGLINE_FREE             = 0  // move the line in any direction
const DRAGLINE_PERPENDICULAR    = 1
const DRAGLINE_PARALLEL         = 2

const DRAGPOINT_FREE            = 10

// Used by CRegionSelector which is used by the two image analysis tools (line detector and RGB Profile)
class CDraggablePoint extends CDraggable{
    constructor(point, radius, color, callback, data, type = DRAGPOINT_FREE) {
        super();
        this.point = point
        this.radius = radius
        this.color = color
        this.callback = callback
        this.type = type;
        this.data = data
    }

    near(p) {
        return p.clone().sub(this.point).length() <= this.radius
    }

    render(ctx, mouse) {
    //    if (this.near(mouse)) {
            ctx.strokeStyle = this.color;
            ctx.beginPath();
            ctx.arc(this.point.x, this.point.y, 5, 0, Math.PI * 2);
            ctx.stroke();
    }
}


class CDraggableLine extends CDraggable {
    constructor(point1, point2, radius, callback, type=DRAGLINE_FREE) {
        super();
        this.point1 = point1
        this.point2 = point2
        this.radius = radius
        this.callback = callback
        this.type = type;
    }

}


export class CRegionSelector {
    constructor() {
        this.active = false;

        // four corners 0--1 clockwise from top left
        //              |  |
        //              3--2
        this.rect = [new Vector2(),new Vector2(), new Vector2(), new Vector2()]
        this.rectStart = [new Vector2(),new Vector2(), new Vector2(), new Vector2()]
        this.dragMode = DRAG_NONE;
        this.lastMouse = new Vector2(); // previous mouse position when moving
        this.dragStart = new Vector2(); // canvas point where we started dragging from
        this.center = new Vector2();    // average of the four corners
        this.dragIndex = 0             // corner or line we are dragging

        this.useSkew = false;
        this.centerLine = false;

        const dragRadius = 10;

        this.dragpoints = []
        this.dragpoints.push(new CDraggablePoint(this.rect[0], dragRadius, "#FF0000"))
        this.dragpoints.push(new CDraggablePoint(this.rect[1], dragRadius, "#00FF00"))
        this.dragpoints.push(new CDraggablePoint(this.rect[2], dragRadius, "#0000FF"))
        this.dragpoints.push(new CDraggablePoint(this.rect[3], dragRadius, "#FFFF00"))
    }

    captureState() {
        return {active: this.active, rect: this.rect.map(p => p.toArray()), center: this.center.toArray()};
    }

    restoreState(state) {
        this.active = state.active;
        this.rect.forEach((p, i) => p.fromArray(state.rect[i]));
        this.center.fromArray(state.center);
        this.dragMode = DRAG_NONE;
    }

    dumpCorner(c) {
        return ("("+this.rect[c].x+","+this.rect[c].y+")")
    }

    dumpRect() {
        return (this.dumpCorner(0)+" "+this.dumpCorner(1)+" "+this.dumpCorner(2)+" "+this.dumpCorner(3))
    }

    // Move events are called by the onMouseDown, etc, in CMiageView
    // which in turn is called from onDocumentMouseDown, etc in index.js
    onMouseDown(view, e,mouseX, mouseY) {
        if (e.button !== 0) return false;
        const [x,y] = mouseToCanvas(view, mouseX, mouseY)
        const p = new Vector2(x,y)

        this.dragStart.set(x,y)
        this.pointGrabOffset = new Vector2();
        this.dragpoints.forEach(p => p.radius = e.pointerType === "touch" ? HANDLE_STYLE.touchRadius : 10);

        for (var q = 0; q < 4; q++) {
            this.rectStart[q].copy(this.rect[q])
        }


        if (!this.active) {
            this.rect[0].set(x-1, y-1)
            this.rect[1].set(x, y-1)
            this.rect[2].set(x, y)
            this.rect[3].set(x-1, y)
            this.center.set(x,y)
            this.dragMode = DRAG_INITIAL;
            this.active = true;
        }
        else {
            if (inside(p, this.rect))
                this.dragMode = DRAG_MOVE;
            else {
                if (!this.useSkew)
                    this.dragMode = DRAG_ROTATE;
            }
            for (var d=0;d<this.dragpoints.length;d++) {
                if (this.dragpoints[d].near(p)) {
                    this.dragMode = DRAG_POINT
                    this.dragIndex = d
                    this.pointGrabOffset.copy(p).sub(this.dragpoints[d].point)
                }
            }
        }
        this.lastMouse.set(x,y)
    }

    // move with no button down, just update the mouse position for hover
    onMouseMove(view, e,mouseX,mouseY) {
        const [x, y] = mouseToCanvas(view, mouseX, mouseY)
        this.lastMouse.set(x,y)
        const p = new Vector2(x,y)

        var cursor = 'default'

        if (this.active) {
            if (inside(p, this.rect)) {
                cursor = 'move'
            }

            for (var d=0;d<this.dragpoints.length;d++) {
                if (this.dragpoints[d].near(p)) {
                    cursor='col-resize'
                }
            }
        }
        document.body.style.cursor = cursor
    }

    onMouseDrag(view, e,mouseX,mouseY) {
        const [x,y] = mouseToCanvas(view, mouseX, mouseY)
        const p = new Vector2(x,y)

        this.active=true


        const delta = p.clone().sub(this.lastMouse)

        switch (this.dragMode) {
            case DRAG_INITIAL:
                this.rect[2].set(x, y)
                this.rect[1].x = x
                this.rect[3].y = y
                break;
            case DRAG_MOVE:
                this.rect.forEach(r => {
                    r.add(delta)
                })
                break;
            case DRAG_ROTATE:
                // find angle relative to the start angle
                const startAngle = this.center.clone().sub(this.dragStart).angle()
                const newAngle = this.center.clone().sub(p).angle()
                const angleChange = newAngle - startAngle;

                // then take the original quad, and rotate by this much
                // (this eliminates accumulated error, as we always use the original quad and angle
                for (var q = 0; q < 4; q++) {
                    var corner = this.rectStart[q].clone()
                    corner.rotateAround(this.center,angleChange)
                    this.rect[q].copy(corner)
                }
                break;

            case DRAG_POINT:

                if (!this.useSkew) {
                    //  this.dragpoints[this.dragIndex].point.copy(p)
                    var drag = this.dragpoints[this.dragIndex]
                    var left = this.dragpoints[(this.dragIndex + 1) & 3]
                    var opposite = this.dragpoints[(this.dragIndex + 2) & 3]
                    var right = this.dragpoints[(this.dragIndex + 3) & 3]

                    // get unit vectors from d in left and right directions
                    var dl1 = left.point.clone().sub(drag.point).normalize()
                    var dr1 = right.point.clone().sub(drag.point).normalize()

                    const target = p.clone().sub(this.pointGrabOffset);
                    var dd = target.clone().sub(drag.point) // dd is the amount the point has moved.
                    var dd1 = dd.clone().normalize()

                    left.point.add(dr1.clone().multiplyScalar(dr1.dot(dd)))
                    right.point.add(dl1.clone().multiplyScalar(dl1.dot(dd)))

                    drag.point.copy(target)
                }
                else {
                    const otherIndex = [1,0,3,2]
                    const other = otherIndex[this.dragIndex]
                    this.dragpoints[this.dragIndex].point.add(delta)
                    this.dragpoints[other].point.add(delta)
                }

                break;
        }

        // recalculate the center, unless we are rotating, in which case the center is fixed
        if (this.dragMode !== DRAG_ROTATE) {
            this.center.set(0, 0)
            for (var q = 0; q < 4; q++) {
                this.center.add(this.rect[q])
            }
            // center is the average of the four corners
            this.center.multiplyScalar(0.25)
        }

        //      console.log ("onMouseDrag: "+this.dumpRect())

        // We might have dragged the region inside out
        // so detect this and flip
        // draggable points 0,1,2 should be clock
        if (!clockwiseXY(this.dragpoints[0].point,this.dragpoints[1].point,this.dragpoints[2].point)) {
            var t;
            t = this.dragpoints[0].point.clone()
            this.dragpoints[0].point.copy(this.dragpoints[1].point)
            this.dragpoints[1].point.copy(t)
            t = this.dragpoints[2].point.clone()
            this.dragpoints[2].point.copy(this.dragpoints[3].point)
            this.dragpoints[3].point.copy(t)
            console.log("FLIPPED")
            // also need to flip the dragindex to reflect the change in points
            // 0 <-> 1
            // 2 <-> 3
            // so just flip the last bit
            this.dragIndex ^= 1

        }

        if (!this.useSkew) {
            // the corrections might result in accumulated errors
            // so we adjust the points on either side of the dragindex so they are at right angles
            // so di and di+2 are unchanged, but di+1 and di+3 (aka di-1) are modified
            const di = this.dragIndex
            makeBRight(this.dragpoints[(di)].point, this.dragpoints[(di + 1) & 3].point, this.dragpoints[(di + 2) & 3].point)
            makeBRight(this.dragpoints[(di + 2) & 3].point, this.dragpoints[(di + 3) & 3].point, this.dragpoints[di].point)
        }



        this.lastMouse.set(x,y)
    }




    onMouseUp(view, e,mouseX,mouseY) {
        const [x,y] = mouseToCanvas(view, mouseX, mouseY)
        this.dragMode = DRAG_NONE
        this.lastMouse.set(x,y)



    }

    render (ctx) {

        ctx.strokeStyle = '#FF00FF'
        ctx.lineWidth = 1
        ctx.beginPath();
        ctx.moveTo(this.rect[0].x,this.rect[0].y)
        ctx.lineTo(this.rect[1].x,this.rect[1].y)
        ctx.lineTo(this.rect[2].x,this.rect[2].y)
        ctx.lineTo(this.rect[3].x,this.rect[3].y)
        ctx.lineTo(this.rect[0].x,this.rect[0].y)
        ctx.stroke();

        if (this.centerLine) {
            ctx.lineWidth = 0.5
            ctx.moveTo((this.rect[0].x+this.rect[3].x)/2,(this.rect[0].y+this.rect[3].y)/2)
            ctx.lineTo((this.rect[1].x+this.rect[2].x)/2,(this.rect[1].y+this.rect[2].y)/2)
            ctx.stroke();

        }

        // add an arrow at the top
        const arrowSize = 20;
        var mid = this.rect[0].clone().add(this.rect[1]).multiplyScalar(0.5)
        var left = this.rect[0].clone().sub(this.rect[1]).normalize().multiplyScalar(arrowSize)
        var up = this.rect[0].clone().sub(this.rect[3]).normalize().multiplyScalar(arrowSize)
        var pLeft = mid.clone().add(left)
        var pRight = mid.clone().sub(left)
        var pPeak = mid.clone().add(up)


        ctx.beginPath();
        ctx.moveTo(pLeft.x,pLeft.y)
        ctx.lineTo(pPeak.x,pPeak.y)
        ctx.lineTo(pRight.x,pRight.y)
        ctx.stroke()

        if (this.dragMode === DRAG_ROTATE) {
            ctx.beginPath();
            ctx.moveTo(this.center.x,this.center.y-5)
            ctx.lineTo(this.center.x,this.center.y+5)
            ctx.moveTo(this.center.x-5,this.center.y)
            ctx.lineTo(this.center.x+5,this.center.y)
            ctx.stroke();

        }

        this.dragpoints.forEach(d=>{
            d.render(ctx, this.lastMouse)
        })

    }


}
