// AR Mode - Use device orientation to control camera
// Based on compass/index.html device orientation code

import {Globals} from "./Globals";
import {Euler, MathUtils} from "three";

class ARModeManager {
    constructor() {
        this.compassHeading = 0;
        this.elevationAngle = 0;
        this.alpha = 0;  // Store raw alpha value
        this.beta = 0;   // Store raw beta value
        this.gamma = 0;  // Store raw gamma value
        this.isAbsolute = false;
        this.screenOrientation = 0; // 0, 90, 270, 180 (modern standard)
        this.cameraNode = null;
        this.isIOS = false;
        this.permissionGranted = false;
        this.isListening = false;
        
        // Detect iOS
        this.isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
                     (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }
    

    async requestPermission() {
        // Check if we need to request permission (iOS 13+)
        if (typeof DeviceOrientationEvent !== 'undefined' && 
            typeof DeviceOrientationEvent.requestPermission === 'function') {
            try {
                const permission = await DeviceOrientationEvent.requestPermission();
                if (permission === 'granted') {
                    this.permissionGranted = true;
                    return true;
                } else {
                    console.warn('AR Mode: Permission denied for device orientation');
                    return false;
                }
            } catch (error) {
                console.error('AR Mode: Error requesting permission:', error);
                return false;
            }
        } else {
            // Android or older iOS - no permission needed
            this.permissionGranted = true;
            return true;
        }
    }
    
    trackOrientation() {
        const updateOrientation = () => {
            let angle = 0;
            
            if (screen.orientation) {
                // Modern API - returns 0, 90, 180, 270
                angle = screen.orientation.angle;
            } else if (window.orientation !== undefined) {
                // Legacy API - returns 0, 90, -90, 180
                angle = window.orientation;
            }
            
            // Normalize to modern standard: Convert -90 to 270
            // Both represent landscape-right (device rotated clockwise when in portrait)
            if (angle === -90) {
                angle = 270;
            }
            
            this.screenOrientation = angle;
        };
        
        updateOrientation();
        
        // Listen for orientation changes
        if (screen.orientation) {
            screen.orientation.addEventListener('change', updateOrientation);
        } else {
            window.addEventListener('orientationchange', updateOrientation);
        }
    }
    
    handleOrientation = (event) => {
        // Store raw sensor values
        this.alpha = event.alpha !== null ? event.alpha : 0;
        this.beta = event.beta !== null ? event.beta : 0;
        this.gamma = event.gamma !== null ? event.gamma : 0;
        
        // Check if we have absolute orientation
        this.isAbsolute = event.absolute === true || event.type === 'deviceorientationabsolute';
        
        let rawHeading = 0;
        
        // iOS: webkitCompassHeading gives true heading (0-360, 0 = North)
        // Note: webkitCompassHeading already accounts for screen orientation on iOS
        if (event.webkitCompassHeading !== undefined && event.webkitCompassHeading !== null) {
            rawHeading = event.webkitCompassHeading;
            this.isAbsolute = true;
        } 
        // Android with absolute orientation
        else if (event.alpha !== null) {
            // Formula from working examples: Math.abs(alpha - 360)
            // This gives heading where 0 = North
            rawHeading = Math.abs(event.alpha - 360);
        }
        
        // Adjust heading based on screen orientation
        // webkitCompassHeading gives the direction the DEVICE top is pointing
        // We need to adjust it to show the direction the SCREEN top is pointing
        // screenOrientation: 0 (portrait), 90 (landscape-left), 270 (landscape-right), 180 (upside down)
        this.compassHeading = (rawHeading + this.screenOrientation + 360) % 360;
        
        // Calculate elevation using simple gamma correction
        // Gamma goes 0 to -90 then 90 to 0
        let correctedElevation = this.gamma;
        if (this.screenOrientation === 90) {
            // Landscape-left
            if (this.gamma < 0) {
                correctedElevation = -this.gamma;
            } else {
                correctedElevation = 180 - this.gamma;
            }
        } else if (this.screenOrientation === 270) {
            // Landscape-right (inverted)
            if (this.gamma < 0) {
                correctedElevation = 180 - (-this.gamma);
            } else {
                correctedElevation = this.gamma;
            }
        } else {
            // Portrait mode (0° or 180°) - use beta
            correctedElevation = this.beta;
        }
        this.elevationAngle = correctedElevation;
        
        // DEBUG: Log values in landscape mode
        if (this.screenOrientation === 90 || this.screenOrientation === 270) {
            console.log(`Landscape (${this.screenOrientation}°): ` +
                       `alpha=${this.alpha.toFixed(1)}, beta=${this.beta.toFixed(1)}, gamma=${this.gamma.toFixed(1)}, ` +
                       `elevation=${this.elevationAngle.toFixed(1)}°`);
        }
    }
    
    startListening() {
        if (!window.DeviceOrientationEvent) {
            console.warn('AR Mode: Device orientation not supported on this device.');
            return false;
        }
        
        if (this.isListening) return true;
        
        // Track screen orientation changes
        this.trackOrientation();
        
        // iOS: uses deviceorientation with webkitCompassHeading
        // Android: uses deviceorientationabsolute with absolute flag
        if (this.isIOS) {
            window.addEventListener('deviceorientation', this.handleOrientation, true);
        } else {
            // For Android, listen to deviceorientationabsolute
            window.addEventListener('deviceorientationabsolute', this.handleOrientation, true);
        }
        
        // Listen for compass calibration needs
        window.addEventListener('compassneedscalibration', (e) => {
            console.warn('AR Mode: Compass needs calibration - wave phone in figure 8');
            e.preventDefault();
        }, true);
        
        this.isListening = true;
        return true;
    }
    
    stopListening() {
        if (!this.isListening) return;
        
        if (this.isIOS) {
            window.removeEventListener('deviceorientation', this.handleOrientation, true);
        } else {
            window.removeEventListener('deviceorientationabsolute', this.handleOrientation, true);
        }
        
        this.isListening = false;
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
        if (!this.permissionGranted) {
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
        
        // Instead of directly rotating the camera, update the PTZ controller
        // This allows AR mode to work with the Manual PTZ "Use Angles" system
        const ptzController = NodeMan.get("ptzAngles", false);
        if (ptzController) {
            // Update PTZ controller with device orientation
            // compassHeading: 0-360°, 0 = North (matches PTZ azimuth)
            ptzController.az = this.compassHeading;
            
            // elevationAngle is already adjusted for screen orientation in handleOrientation()
            // It represents the tilt of the device:
            // - 0° = flat/face up
            // - 90° = upright (horizon)
            // - 180° = face down
            // PTZ el convention: positive = up, 0 = horizon, negative = down
            // So: PTZ el = elevationAngle - 90
            ptzController.el = this.elevationAngle - 90;
            
            // Don't need to call recalculateCascade - the PTZ controller
            // will apply these values in its normal update cycle
        } else {
            // Fallback: if no PTZ controller, directly rotate camera (old behavior)
            // Convert heading (0-360 degrees, 0 = North) to radians
            // In Three.js, rotation around Y axis: 0 = +Z (South), π/2 = -X (West), π = -Z (North), 3π/2 = +X (East)
            // So we need to convert: North (0°) should point to -Z, which is π radians
            const headingRad = MathUtils.degToRad(this.compassHeading);
            const yaw = Math.PI - headingRad; // Convert compass heading to Three.js Y rotation
            
            // Convert elevation to radians
            // Positive elevation = looking up, negative = looking down
            const pitch = MathUtils.degToRad(-this.elevationAngle);
            
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