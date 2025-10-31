// The compass UI displays the compass rose and the heading
// base on an input camera node

import {CNodeViewUI} from "./CNodeViewUI";
import {getAzElFromPositionAndForward, getCompassHeading} from "../SphericalMath";
import {Globals, NodeMan} from "../Globals";
import {Vector3} from "three";

export class   CNodeCompassUI extends CNodeViewUI {

    constructor(v) {
        super(v);
        this.input("camera");  // a camera node

        // addText(key, text, x, y, size, color, align, font) {
        if(Globals.showCompassElevation === false) {
            this.text = this.addText("heading", "0°", 50, 20, 20, "white", "center", "Arial")
        }
        else {
            this.text = this.addText("heading", "0°", 50, 20, 16, "white", "center", "Arial")
        }

        this.cx = 50;
        this.cy = 60;
        this.doubleClickFullScreen = false;

        // State tracking for optimization
        this.lastHeading = null;
        this.lastElevation = null;
        this.lastTargetWindFrom = null;
        this.lastLocalWindFrom = null;
    }


    onMouseDown(e, mouseX, mouseY) {
        const view = this.in.relativeTo;
        
        // clicking on the compass in the main view should rotate the view to north
        if (view?.id === "mainView") {
            // There's a plane defined by the camera's position and the local up vector and the north pole
            // the camera shoudl end up with it up and forward vectors in that plane
            // and the right vector pointing east
            // so the camera's rotation matrix should be set to that
            view.controls.fixUp(true);
            view.controls.fixHeading(0)
            view.controls.fixHeading(0)
            view.controls.fixHeading(0)
            view.controls.fixHeading(0)
        }
        // clicking on the compass in the look view should toggle "Show Compass Elevation"
        else if (view?.id === "lookView") {
            Globals.showCompassElevation = !Globals.showCompassElevation;
            // Force update of all compass UI nodes by resetting their state
            NodeMan.iterate((id, node) => {
                if (node.constructor.name === "CNodeCompassUI") {
                    node.lastHeading = null;
                }
            });
        }
    }


    renderCanvas(frame) {
        if (this.overlayView && !this.overlayView.visible) return;


        // get the three.js camera from the camera node
        const camera = this.in.camera.camera;
        // get the camera's forward vector, the negative z basis from its matrix
        const forward = new Vector3();
        camera.getWorldDirection(forward);

        // get the heading of the camera, in radians
        const heading = getCompassHeading(camera.position, forward, camera);
        // AZELISSUE: CORRECT - using camera.getWorldDirection() which auto-negates camera's -Z to forward
        const azel =  getAzElFromPositionAndForward(camera.position, forward);
        const elevationRound = Math.round(azel[1] * 10) / 10;

        // convert to 0..360 degrees for display
        const headingDeg = heading * 180 / Math.PI;
        // make sure it's positive
        const headingPos = (headingDeg + 360) % 360;
        // round to the nearest 0.1 degree
        const headingRound = Math.round(headingPos * 10) / 10;

        // Get current wind states for change detection
        const targetWind = NodeMan.get("targetWind", false);
        const localWind = NodeMan.get("localWind", false);
        const currentTargetWindFrom = targetWind?.from;
        const currentLocalWindFrom = localWind?.from;

        // Check if anything has changed
        if (this.lastHeading === headingRound && this.lastElevation === elevationRound &&
            this.lastTargetWindFrom === currentTargetWindFrom &&
            this.lastLocalWindFrom === currentLocalWindFrom) {
            return; // Nothing changed, early out
        }

        // set the text to the rounded heading
        if(Globals.showCompassElevation === false) {
            this.removeText("heading");
            this.text = this.addText("heading", headingRound + "°", 50, 20, 20, "white", "center", "Arial")
        }
        else {
            this.removeText("heading");
            this.text = this.addText("heading", headingRound + "° / " + elevationRound + "°", 50, 20, 16, "white", "center", "Arial")
            this.lastElevation = elevationRound; // only track elevation if we're displaying it
        }

        // after updating the text, render the text
        super.renderCanvas(frame);

        // Update state
        this.lastHeading = headingRound;
        this.lastTargetWindFrom = currentTargetWindFrom;
        this.lastLocalWindFrom = currentLocalWindFrom;

        // now draw a centered arrow rotated by the heading

        // make a 2D point at 50,0 (north)
        // rotate it around 50,50 by the heading
        // draw a line from 50,50 to the rotated point


        const c = this.ctx;


        // draw the letter N in the center
        c.fillStyle = '#FFFFFF';
        c.font = this.px(17)+'px Arial';
        c.textAlign = 'center';
        c.fillText('N', this.px(this.cx), this.py(this.cy+7));


        let length = 35;

        let arrowScale = 0.25;

        if (targetWind) {
            const fromDegrees = targetWind.from;
            const fromRadians = heading + 2*Math.PI - fromDegrees * Math.PI / 180;

            const c = this.ctx;
            c.strokeStyle = '#FFFF40';
            c.lineWidth = 2.5;
            c.beginPath();
            const gap = 10;
            const segment = (length ) / 2
            // rLine draws lines rotated about cx,cy

            this.rLine(this.cx-3,this.cy-length,this.cx,this.cy-length*(1-arrowScale),fromRadians);
            this.rLine(this.cx+3,this.cy-length,this.cx,this.cy-length*(1-arrowScale),fromRadians);
            this.rLine(this.cx+3,this.cy-length,this.cx-3,this.cy-length,fromRadians);
            c.stroke();

        }

        if (localWind) {
            const fromDegrees = localWind.from;
            const fromRadians = heading + 2*Math.PI - fromDegrees * Math.PI / 180;

            const c = this.ctx;
            c.strokeStyle = '#40FF40';
            c.lineWidth = 2.5;
            c.beginPath();
            const gap = 10;
            const segment = (length ) / 2
            // rLine draws lines rotated about cx,cy

            this.rLine(this.cx-3,this.cy-length,this.cx,this.cy-length*(1-arrowScale),fromRadians);
            this.rLine(this.cx+3,this.cy-length,this.cx,this.cy-length*(1-arrowScale),fromRadians);
            this.rLine(this.cx+3,this.cy-length,this.cx-3,this.cy-length,fromRadians);
            c.stroke();

        }


        // finally the compass line (so it's on top of the wind markers)
        c.strokeStyle = '#FFFFFF';
        c.lineWidth = 2.5;
        c.beginPath();
        length = 30;
        const gap = 10;
        const segment = (length ) / 2
        // rLine draws lines rotated about cx,cy
        //this.rLine(this.cx,this.cy+length,this.cx,this.cy-length,heading);

        this.rLine(this.cx,this.cy+length,this.cx,this.cy+gap,heading);
        this.rLine(this.cx,this.cy-length,this.cx,this.cy-gap,heading);


        this.rLine(this.cx,this.cy-length,this.cx-3,this.cy-length*0.5,heading);
        this.rLine(this.cx,this.cy-length,this.cx+3,this.cy-length*0.5,heading);
        c.stroke();

    }



}