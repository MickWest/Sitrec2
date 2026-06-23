// AR Mode - Use device orientation to control camera
// Based on compass/index.html device orientation code
// i.e. point your phone (or other device) North to face the camera North

import {Globals, NodeMan} from "./Globals";
import {Euler, MathUtils} from "three";
import {DeviceOrientationCompass} from "../tools/src/DeviceOrientationCompass";

class ARModeManager {
    constructor() {
        this.cameraNode = null;
        
        // Smoothing for iOS compass heading (to reduce jerkiness from integer values)
        this.smoothedHeading = 0;
        this.smoothingFactor = 0.2; // 0 = no smoothing, 1 = instant (adjust between 0.1-0.3)
        
        // Use shared compass library
        this.compass = new DeviceOrientationCompass();
        
        // Set up compass update callback
        this.compass.onUpdate = (readings) => {
            // Apply smoothing to iOS readings
            if (this.compass.isIOS && readings.raw.webkit !== null) {
                // Handle wraparound at 0/360 boundary
                let diff = readings.heading - this.smoothedHeading;
                if (diff > 180) diff -= 360;
                if (diff < -180) diff += 360;
                
                this.smoothedHeading = (this.smoothedHeading + diff * this.smoothingFactor + 360) % 360;
            } else {
                // Android: use raw heading (already has decimal precision)
                this.smoothedHeading = readings.heading;
            }
        };
        
        // Set up status change callback
        this.compass.onStatusChange = (message, isError) => {
            if (isError) {
                console.warn('AR Mode:', message);
            } else {
                console.log('AR Mode:', message);
            }
        };
    }
    
    async requestPermission() {
        return await this.compass.requestPermission();
    }
    
    startListening() {
        return this.compass.startListening();
    }
    
    stopListening() {
        this.compass.stopListening();
    }
    
    async enableARMode(cameraNode) {
        if (!Globals.isMobile) {
            console.warn('AR Mode: Only available on mobile devices');
            return false;
        }
        
        if (Globals.arMode) {
            console.log('AR Mode: Already enabled');
            return true;
        }
        
        // Request permission if needed
        if (!this.compass.permissionGranted) {
            const granted = await this.requestPermission();
            if (!granted) {
                return false;
            }
        }
        
        // Start listening to device orientation
        const started = this.startListening();
        if (!started) {
            return false;
        }
        
        this.cameraNode = cameraNode;
        Globals.arMode = true;
        
        console.log('AR Mode: Enabled');
        return true;
    }
    
    disableARMode() {
        if (!Globals.arMode) return;
        
        this.stopListening();
        this.cameraNode = null;
        Globals.arMode = false;
        
        console.log('AR Mode: Disabled');
    }
    
    update() {
        if (!Globals.arMode || !this.cameraNode) return;
        
        const camera = this.cameraNode.camera;
        if (!camera) return;
        
        // Get current readings from compass
        const readings = this.compass.getReadings();
        
        // Use smoothed heading for iOS, raw heading for Android
        const compassHeading = this.compass.isIOS ? this.smoothedHeading : readings.heading;
        const elevationAngle = readings.elevation;
        
        // Instead of directly rotating the camera, update the PTZ controller
        // This allows AR mode to work with the "Manual" (ptzAngles) camera-heading system
        const ptzController = NodeMan.get("ptzAngles", false);
        if (ptzController) {
            // Update PTZ controller with device orientation
            // compassHeading: 0-360°, 0 = North (matches PTZ azimuth)
            ptzController.az = compassHeading;
            
            // elevationAngle is already adjusted for screen orientation
            // It represents the tilt of the device:
            // - -90° = flat/face up
            // - 0° = upright (horizon)
            // - 90° = face down
            // PTZ el convention is the same: positive = up, 0 = horizon, negative = down
            ptzController.el = elevationAngle;
            
            // Don't need to call recalculateCascade - the PTZ controller
            // will apply these values in its normal update cycle
        } else {
            // Fallback: if no PTZ controller, directly rotate camera (old behavior)
            // Convert heading (0-360 degrees, 0 = North) to radians
            // In Three.js, rotation around Y axis: 0 = +Z (South), π/2 = -X (West), π = -Z (North), 3π/2 = +X (East)
            // So we need to convert: North (0°) should point to -Z, which is π radians
            const headingRad = MathUtils.degToRad(compassHeading);
            const yaw = Math.PI - headingRad; // Convert compass heading to Three.js Y rotation
            
            // Convert elevation to radians
            // Positive elevation = looking up, negative = looking down
            const pitch = MathUtils.degToRad(-elevationAngle);
            
            // Create rotation: first rotate around Y axis (yaw/heading), then around X axis (pitch/elevation)
            const euler = new Euler(pitch, yaw, 0, 'YXZ');
            camera.quaternion.setFromEuler(euler);
            
            // Update camera matrices
            camera.updateMatrixWorld(true);
        }
    }
}

// Create singleton instance
export const arModeManager = new ARModeManager();