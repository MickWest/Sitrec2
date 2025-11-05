// The compass UI displays the compass rose and the heading
// base on an input camera node

import {CNodeViewUI} from "./CNodeViewUI";
import {getAzElFromPositionAndForward, getCompassHeading} from "../SphericalMath";
import {Globals, NodeMan} from "../Globals";
import {Vector3} from "three";
import {arModeManager} from "../ARMode";

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
        this.lastARMode = false;
        
        // Long-press detection for AR mode
        this.longPressTimer = null;
        this.longPressDelay = 800; // milliseconds
        this.isLongPress = false;
        
        // Enable pointer events for compass interactions (overrides parent's ignoreMouseEvents)
        this.canvas.style.pointerEvents = 'auto';
        
        // Add touch event listeners for mobile support
        if (Globals.isMobile) {
            this.canvas.addEventListener('touchstart', this.handleTouchStart.bind(this), { passive: false });
            this.canvas.addEventListener('touchend', this.handleTouchEnd.bind(this), { passive: false });
            this.canvas.addEventListener('touchmove', this.handleTouchMove.bind(this), { passive: false });
        }
    }


    onMouseDown(e, mouseX, mouseY) {
        const view = this.in.relativeTo;
        
        console.log("Compass onMouseDown - view:", view?.id, "isMobile:", Globals.isMobile);
        
        // For lookView on mobile, start long-press detection for AR mode
        if (view?.id === "lookView" && Globals.isMobile) {
            console.log("Starting long-press timer for AR mode");
            this.isLongPress = false;
            this.longPressTimer = setTimeout(() => {
                console.log("Long-press detected! Toggling AR mode");
                this.isLongPress = true;
                this.toggleARMode();
            }, this.longPressDelay);
            return;
        }
        
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
    
    onMouseUp(e, mouseX, mouseY) {
        const view = this.in.relativeTo;
        
        // Cancel long-press timer if released early
        if (this.longPressTimer) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }
        
        // If this wasn't a long press on lookView mobile, handle as regular click
        if (view?.id === "lookView" && Globals.isMobile && !this.isLongPress) {
            Globals.showCompassElevation = !Globals.showCompassElevation;
            // Force update of all compass UI nodes by resetting their state
            NodeMan.iterate((id, node) => {
                if (node.constructor.name === "CNodeCompassUI") {
                    node.lastHeading = null;
                }
            });
        }
        
        // Reset long-press state
        this.isLongPress = false;
    }
    
    onMouseMove(e, mouseX, mouseY) {
        // Cancel long-press if user moves finger (helps prevent accidental activation)
        if (this.longPressTimer) {
            console.log("Movement detected - canceling long-press timer");
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }
    }
    
    handleTouchStart(e) {
        const view = this.in.relativeTo;
        
        console.log("Compass touchStart - view:", view?.id, "isMobile:", Globals.isMobile);
        
        // Prevent default to avoid triggering mouse events afterward
        e.preventDefault();
        
        // For lookView on mobile, start long-press detection for AR mode
        if (view?.id === "lookView" && Globals.isMobile) {
            console.log("Starting long-press timer for AR mode (touch)");
            this.isLongPress = false;
            this.touchStartTime = Date.now();
            this.longPressTimer = setTimeout(() => {
                console.log("Long-press detected! Toggling AR mode (touch)");
                this.isLongPress = true;
                this.toggleARMode();
            }, this.longPressDelay);
        }
    }
    
    handleTouchEnd(e) {
        const view = this.in.relativeTo;
        
        console.log("Compass touchEnd - view:", view?.id, "isLongPress:", this.isLongPress);
        
        // Prevent default to avoid triggering mouse events
        e.preventDefault();
        
        // Cancel long-press timer if released early
        if (this.longPressTimer) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }
        
        // If this wasn't a long press on lookView mobile, handle as regular tap (toggle elevation)
        if (view?.id === "lookView" && Globals.isMobile && !this.isLongPress) {
            console.log("Short tap detected - toggling compass elevation");
            Globals.showCompassElevation = !Globals.showCompassElevation;
            // Force update of all compass UI nodes by resetting their state
            NodeMan.iterate((id, node) => {
                if (node.constructor.name === "CNodeCompassUI") {
                    node.lastHeading = null;
                }
            });
        }
        
        // Reset long-press state
        this.isLongPress = false;
    }
    
    handleTouchMove(e) {
        // Cancel long-press if user moves finger significantly
        // Allow small movements (< 10px) to account for natural finger wobble
        if (this.longPressTimer && e.touches.length > 0) {
            const touch = e.touches[0];
            const rect = this.canvas.getBoundingClientRect();
            const moveDistance = Math.sqrt(
                Math.pow(touch.clientX - rect.left - rect.width/2, 2) +
                Math.pow(touch.clientY - rect.top - rect.height/2, 2)
            );
            
            // Only cancel if moved more than 10 pixels
            if (moveDistance > 10) {
                console.log("Significant movement detected - canceling long-press timer");
                e.preventDefault();
                clearTimeout(this.longPressTimer);
                this.longPressTimer = null;
            }
        }
    }
    
    async toggleARMode() {
        if (Globals.arMode) {
            arModeManager.disableARMode();
            alert('AR Mode disabled');
        } else {
            const view = this.in.relativeTo;
            if (view?.id === "lookView") {
                // If permission not yet granted, show a button that user must click
                // (iOS requires permission request in a direct user gesture, not setTimeout)
                if (!arModeManager.permissionGranted) {
                    this.showARPermissionButton();
                } else {
                    // Permission already granted, activate directly
                    const success = await arModeManager.enableARMode(this.in.camera);
                    if (success) {
                        alert('AR Mode enabled! Point your device to look around.');
                    } else {
                        alert('Failed to enable AR Mode. Please check permissions.');
                    }
                }
            }
        }
    }
    
    showARPermissionButton() {
        // Create overlay with button
        const overlay = document.createElement('div');
        overlay.style.position = 'fixed';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
        overlay.style.display = 'flex';
        overlay.style.flexDirection = 'column';
        overlay.style.justifyContent = 'center';
        overlay.style.alignItems = 'center';
        overlay.style.zIndex = '10000';
        
        const message = document.createElement('div');
        message.textContent = 'Enable AR Mode to use device orientation';
        message.style.color = 'white';
        message.style.fontSize = '18px';
        message.style.marginBottom = '20px';
        message.style.textAlign = 'center';
        message.style.padding = '0 20px';
        
        const button = document.createElement('button');
        button.textContent = 'Allow AR Mode';
        button.style.padding = '15px 30px';
        button.style.fontSize = '18px';
        button.style.backgroundColor = '#4CAF50';
        button.style.color = 'white';
        button.style.border = 'none';
        button.style.borderRadius = '8px';
        button.style.cursor = 'pointer';
        button.style.marginBottom = '10px';
        
        const cancelButton = document.createElement('button');
        cancelButton.textContent = 'Cancel';
        cancelButton.style.padding = '10px 20px';
        cancelButton.style.fontSize = '16px';
        cancelButton.style.backgroundColor = '#666';
        cancelButton.style.color = 'white';
        cancelButton.style.border = 'none';
        cancelButton.style.borderRadius = '8px';
        cancelButton.style.cursor = 'pointer';
        
        // Button click handler - this is a direct user gesture!
        button.onclick = async () => {
            console.log("AR permission button clicked - requesting permission");
            const granted = await arModeManager.requestPermission();
            document.body.removeChild(overlay);
            
            if (granted) {
                console.log("Permission granted, enabling AR mode");
                const success = await arModeManager.enableARMode(this.in.camera);
                if (success) {
                    alert('AR Mode enabled! Point your device to look around.');
                } else {
                    alert('Failed to enable AR Mode.');
                }
            } else {
                console.log("Permission denied");
                alert('AR Mode requires device orientation permission.');
            }
        };
        
        cancelButton.onclick = () => {
            console.log("AR permission request cancelled");
            document.body.removeChild(overlay);
        };
        
        overlay.appendChild(message);
        overlay.appendChild(button);
        overlay.appendChild(cancelButton);
        document.body.appendChild(overlay);
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

        // Check if anything has changed (including AR mode status)
        if (this.lastHeading === headingRound && this.lastElevation === elevationRound &&
            this.lastTargetWindFrom === currentTargetWindFrom &&
            this.lastLocalWindFrom === currentLocalWindFrom &&
            this.lastARMode === Globals.arMode) {
            return; // Nothing changed, early out
        }

        // set the text to the rounded heading
        let headingText = "";
        if(Globals.showCompassElevation === false) {
            headingText = headingRound + "°";
        }
        else {
            headingText = headingRound + "° / " + elevationRound + "°";
            this.lastElevation = elevationRound; // only track elevation if we're displaying it
        }
        
        // Add AR mode indicator if active
        const view = this.in.relativeTo;
        if (Globals.arMode && view?.id === "lookView") {
            headingText = "🎯 " + headingText + " AR";
        }
        
        this.removeText("heading");
        this.text = this.addText("heading", headingText, 50, 20, 
            Globals.showCompassElevation ? 16 : 20, "white", "center", "Arial");

        // after updating the text, render the text
        super.renderCanvas(frame);

        // Update state
        this.lastHeading = headingRound;
        this.lastTargetWindFrom = currentTargetWindFrom;
        this.lastLocalWindFrom = currentLocalWindFrom;
        this.lastARMode = Globals.arMode;

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
    
    dispose() {
        // Clean up touch event listeners
        if (Globals.isMobile) {
            this.canvas.removeEventListener('touchstart', this.handleTouchStart.bind(this));
            this.canvas.removeEventListener('touchend', this.handleTouchEnd.bind(this));
            this.canvas.removeEventListener('touchmove', this.handleTouchMove.bind(this));
        }
        
        // Clear any pending timers
        if (this.longPressTimer) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }
        
        // Call parent dispose
        super.dispose();
    }



}