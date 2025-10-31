// CameraControls

import {Matrix4, Plane, Raycaster, Sphere, Vector2, Vector3} from "three";
import {degrees, radians, vdump} from "../utils";
import {DebugArrowAB, DebugSphere, intersectMSL, pointAbove} from "../threeExt";
import {par} from "../par";
import {ECEFToLLAVD_Sphere, EUSToECEF, wgs84} from "../LLA-ECEF-ENU";
import {
	altitudeAboveSphere,
	getAzElFromPositionAndForward,
	getLocalDownVector,
	getLocalEastVector,
	getLocalNorthVector,
	getLocalUpVector,
	pointOnSphereBelow,
} from "../SphericalMath";
import {NodeFactory, NodeMan, setRenderOne, Sit} from "../Globals";
import {CNodeControllerPTZUI} from "../nodes/CNodeControllerPTZUI";
import {intersectSphere2, V3} from "../threeUtils";
import {onDocumentMouseMove} from "../mouseMoveView";
import {isKeyHeld} from "../KeyBoardHandler";
import {isLocal} from "../configUtils.js"
import {ViewMan} from "../CViewManager";
import {mouseInViewOnly, mouseToView} from "../ViewUtils";
import {CNodeMeasureAB} from "../nodes/CNodeLabels3D";
import {CNodePositionXYZ} from "../nodes/CNodePositionLLA";
import {GlobalScene} from "../LocalFrame";
import * as LAYER from "../LayerMasks";

const STATE = {
	NONE: -1,
	ROTATE: 0,				     // MIDDLE button - rotate the camera around the target
	DOLLY: 1,
	PAN: 2,						 // RIGHT button - pan the world around (also CMD + LEFT button)
	TOUCH_ROTATE: 3,
	TOUCH_PAN: 4,
	TOUCH_DOLLY_PAN: 5,
	TOUCH_DOLLY_ROTATE: 6,
	DRAG: 7,                     // LEFT button - drag the world around
	TOUCH_PINCH_ZOOM: 8,         // Two-finger pinch zoom gesture
	TOUCH_TWO_FINGER_ROTATE: 9,  // Two-finger rotation (one fixed, one moving)
	TOUCH_TILT: 10,              // Two-finger vertical drag for tilt/pitch
	SINGLE_TAP: 11,              // Single-finger tap (potential double-tap)
	DOUBLE_TAP_DRAG_ZOOM: 12,    // Double-tap-and-drag one-hand zoom
};



class CameraMapControls {
	constructor(camera, canvas, view) {
		this.camera = camera;
		this.canvas = canvas;
		this.view = view;
		this.enableZoom = true;
		this.zoomSpeed = 1;
		this.rotateSpeed = 0.5;
		this.target = new Vector3()
		this.targetIsTerrain = false;

		// ===== GESTURE FEATURE FLAGS (Maps/Earth API compatibility) =====
		this.scrollGestures = true;       // Single-finger pan/drag
		this.zoomGestures = true;         // Pinch zoom, double-tap, two-finger tap, double-tap-drag
		this.rotateGestures = true;       // Two-finger rotation
		this.tiltGestures = true;         // Two-finger vertical drag for pitch/tilt

		// ===== ZOOM LIMITS =====
		this.minZoom = 0.01;
		this.maxZoom = 120;

		// ===== TILT LIMITS =====
		this.minTilt = 0;   // Nadir (looking straight down)
		this.maxTilt = 60;  // Maximum tilt angle in degrees

		// ===== DOUBLE-TAP TRACKING =====
		this.lastTapTime = 0;
		this.lastTapPos = new Vector2();
		this.tapThreshold = 300; // milliseconds for double-tap
		this.tapDistanceThreshold = 15; // pixels: max distance for second tap to count as double-tap

		// ===== TWO-FINGER GESTURE TRACKING =====
		this.touch1Start = new Vector2();
		this.touch2Start = new Vector2();
		this.touch1Prev = new Vector2();
		this.touch2Prev = new Vector2();
		this.gestureStartDistance = 0;    // distance between fingers at gesture start
		this.gestureStartAngle = 0;       // angle between fingers at gesture start
		this.gestureStartCentroid = new Vector2(); // center point between fingers
		
		// Active gesture flags (multiple can be true simultaneously)
		this.pinchActive = false;
		this.rotateActive = false;
		this.tiltActive = false;

		// Gesture discrimination thresholds
		this.scaleChangeThreshold = 10;   // pixels: if pinch motion > this, activate pinch
		this.rotationThreshold = 5;       // degrees: if rotation motion > this, activate rotation
		this.tiltThreshold = 15;          // pixels: if tilt motion > this, activate tilt

		this.pinchDistance = 0;
		this.lastPinchDistance = 0;

		this.canvas.addEventListener( 'contextmenu', e => this.onContextMenu(e) );
		this.canvas.addEventListener( 'pointerdown', e => this.handleMouseDown(e) );
		this.canvas.addEventListener( 'pointerup', e => this.handleMouseUp(e) );
		this.canvas.addEventListener( 'pointermove', e => this.handleMouseMove(e) );
		this.canvas.addEventListener( 'wheel', e => this.handleMouseWheel(e) );
		this.canvas.addEventListener( 'touchstart', e => this.handleTouchStart(e), { passive: false } );
		this.canvas.addEventListener( 'touchmove', e => this.handleTouchMove(e), { passive: false } );
		this.canvas.addEventListener( 'touchend', e => this.handleTouchEnd(e), { passive: false } );
		
		// Prevent iOS long-press selection menu
		this.canvas.addEventListener( 'selectstart', e => e.preventDefault(), { passive: false } );
		this.canvas.addEventListener( 'gesturestart', e => e.preventDefault(), { passive: false } );

		this.mouseStart = new Vector2();
		this.mouseEnd = new Vector2();
		this.mouseDelta = new Vector2();

		this.button = 0

		this.state = STATE.NONE
		this.enabled = true;
		
		// Track mouse position for context menu drag detection
		this.contextMenuDownPos = null;
		this.contextMenuDragThreshold = 2; // pixels

		const id = this.view.id;
		this.measureStartPoint = V3()
		this.measureEndPoint = V3()
		this.measureStart = new CNodePositionXYZ({id: id+"measureA", x:0,y:0,z:0});
		this.measureEnd = new CNodePositionXYZ({id: id+"measureB", x:0,y:0,z:0});
		this.measureArrow = new CNodeMeasureAB(
			{
				id: id+"measureArrow",
				A: id+"measureA",
				B: id+"measureB",
				color: "#ffFFFF",
				text: "AB",
				unitType: "flexible"}
		);


		this.justRotate = false; // set to make all three buttons rotate around the target

	}

	update() {

		// Tru just keeping the camera up vector to local up
		// this.fixUp(true);
		// maintained for backwards compatibility with other Three.js controls


		// zooming with the keyboard + and - keys
		const zoomSpeed = 0.03

		if (isKeyHeld("-")) {
			this.zoomBy(zoomSpeed)
		}
		// + key is actually the = key (shifted to +) on main keyboard
		// but the + key on the numeric keypad
		if (isKeyHeld("=") || isKeyHeld("+")) {
			this.zoomBy(-zoomSpeed)
		}

		this.updateMeasureArrow();

	}


	onContextMenu( event ) {

//		console.log("onConrxt")

		// Always prevent the default browser context menu
		// This MUST be done for every contextmenu event, regardless of enabled state
		event.preventDefault();
		event.stopPropagation();
		
		if ( this.enabled === false ) return;
		
		// Don't show our context menu - we'll handle it in handleMouseUp instead
		// This prevents the menu from showing on right-click down

	}



	handleMouseWheel( event ) {

		// bit of patch, as we need to call the document mouse move
		// if the window does not have focus, so we can update the cursor position
		// even if the window does not have focus
		// This is important for the 3D view, where the cursor position is used to
		// calculate the ray from the camera to the mouse position
		// which is used to determine what the mouse is pointing at, for zooming
		if (window.document.hasFocus() === false) {
			onDocumentMouseMove(event);
		}

		if ( this.enabled === false || this.enableZoom === false || this.state !== STATE.NONE ) return;

		event.preventDefault();

		this.zoomBy(Math.sign(event.deltaY));


		setRenderOne(true);
	}

	// ===== HELPER METHODS FOR GESTURE CALCULATION =====

	calculateDistance(p1, p2) {
		const dx = p1.x - p2.x;
		const dy = p1.y - p2.y;
		return Math.sqrt(dx * dx + dy * dy);
	}

	calculateAngle(p1, p2) {
		const dx = p2.x - p1.x;
		const dy = p2.y - p1.y;
		return Math.atan2(dy, dx) * 180 / Math.PI;
	}

	calculateCentroid(p1, p2) {
		return new Vector2().addVectors(p1, p2).multiplyScalar(0.5);
	}

	calculateAngleDelta(angle1, angle2) {
		let delta = angle2 - angle1;
		// Normalize to [-180, 180]
		while (delta > 180) delta -= 360;
		while (delta < -180) delta += 360;
		return delta;
	}

	// ===== DIRECTIONAL MOTION ANALYSIS =====
	
	/**
	 * Analyzes two-finger motions along and perpendicular to the line between them.
	 * Returns an object with:
	 *   - pinchDelta: relative motion along the line (positive = fingers apart, negative = together)
	 *   - rotateDelta: opposing motions perpendicular to line (positive = CCW rotation)
	 *   - tiltDelta: matching motions perpendicular to line (positive = upward tilt)
	 */
	analyzeDirectionalMotion(touch1Curr, touch2Curr, touch1Prev, touch2Prev) {
		// Get line between fingers (from touch1 to touch2)
		const lineVector = touch2Curr.clone().sub(touch1Curr);
		const lineDir = lineVector.clone().normalize();
		
		// Perpendicular direction (rotated 90° counterclockwise)
		const perpDir = new Vector2(-lineDir.y, lineDir.x);
		
		// Current motions of each finger
		const motion1 = touch1Curr.clone().sub(touch1Prev);
		const motion2 = touch2Curr.clone().sub(touch2Prev);
		
		// Project motions onto line and perpendicular directions
		const motion1_parallel = lineDir.dot(motion1);  // Positive = moving away from touch2
		const motion2_parallel = lineDir.dot(motion2);  // Positive = moving toward touch1
		const motion1_perp = perpDir.dot(motion1);      // Perpendicular component
		const motion2_perp = perpDir.dot(motion2);      // Perpendicular component
		
		// PINCH ZOOM: relative motion along the line
		// Positive when fingers move apart, negative when moving together
		const pinchDelta = (motion1_parallel - motion2_parallel) * 0.5;
		
		// ROTATION: opposing motions perpendicular to the line
		// Positive for CCW rotation (touch1 moving CCW, touch2 moving CW relative to line)
		const rotateDelta = (motion1_perp - motion2_perp) * 0.5;
		
		// TILT: matching motions perpendicular to the line
		// Positive when both fingers move in the same perpendicular direction
		const tiltDelta = (motion1_perp + motion2_perp) * 0.5;
		
		return { pinchDelta, rotateDelta, tiltDelta };
	}

	// ===== SINGLE-FINGER TAP DETECTION =====

	handleSingleTap(event) {
		const currentTime = Date.now();
		const [x, y] = mouseToView(this.view, event.clientX, event.clientY);
		const currentPos = new Vector2(x, y);

		// Check if this could be a double-tap
		if (currentTime - this.lastTapTime < this.tapThreshold &&
		    this.calculateDistance(currentPos, this.lastTapPos) < this.tapDistanceThreshold) {
			// It's a DOUBLE-TAP → zoom in
			if (this.zoomGestures && this.enableZoom) {
				this.zoomInAtPoint(event.clientX, event.clientY);
			}
		} else {
			// It's the first tap of a potential double-tap
			this.lastTapTime = currentTime;
			this.lastTapPos.copy(currentPos);
		}
	}

	zoomInAtPoint(clientX, clientY) {
		// Zoom in one level at the tap location (like Maps)
		const zoomFactor = 1.2;
		this.zoomBy(-0.4); // More conservative zoom in
		setRenderOne(true);
	}

	// ===== TWO-FINGER GESTURE HANDLING =====

	handleTouchStart(event) {
		if (!this.enabled) return;

		// Single finger - check for tap
		if (event.touches.length === 1) {
			const [x, y] = mouseToView(this.view, event.clientX, event.clientY);
			this.lastTapPos.set(x, y);
			return;
		}

		// Two-finger gesture start
		if (event.touches.length === 2) {
			event.preventDefault();
			
			const touch1 = new Vector2(event.touches[0].clientX, event.touches[0].clientY);
			const touch2 = new Vector2(event.touches[1].clientX, event.touches[1].clientY);

			this.touch1Start.copy(touch1);
			this.touch2Start.copy(touch2);
			this.touch1Prev.copy(touch1);
			this.touch2Prev.copy(touch2);

			// Store initial gesture parameters
			this.gestureStartDistance = this.calculateDistance(touch1, touch2);
			this.gestureStartAngle = this.calculateAngle(touch1, touch2);
			this.gestureStartCentroid = this.calculateCentroid(touch1, touch2);
			
			// Reset all gesture flags - will be set as thresholds are crossed in handleTouchMove
			this.pinchActive = false;
			this.rotateActive = false;
			this.tiltActive = false;
			this.state = STATE.NONE;

			setRenderOne(true);
		}
	}

	handleTouchMove(event) {
		if (!this.enabled || event.touches.length !== 2) return;

		event.preventDefault();

		const touch1Curr = new Vector2(event.touches[0].clientX, event.touches[0].clientY);
		const touch2Curr = new Vector2(event.touches[1].clientX, event.touches[1].clientY);

		// Analyze incremental motions from previous frame
		const incrementalMotion = this.analyzeDirectionalMotion(
			touch1Curr, touch2Curr, this.touch1Prev, this.touch2Prev
		);

		// DISCRIMINATE gestures using cumulative motion from START (one-time activation)
		// Once a gesture component exceeds its threshold, that gesture becomes active
		const totalMotion = this.analyzeDirectionalMotion(
			touch1Curr, touch2Curr, this.touch1Start, this.touch2Start
		);

		// Activate gestures as their thresholds are crossed
		if (!this.pinchActive && Math.abs(totalMotion.pinchDelta) > this.scaleChangeThreshold && this.zoomGestures) {
			this.pinchActive = true;
			this.state = STATE.TOUCH_PINCH_ZOOM;
		}
		if (!this.rotateActive && Math.abs(totalMotion.rotateDelta) > this.rotationThreshold && this.rotateGestures) {
			this.rotateActive = true;
			this.state = STATE.TOUCH_TWO_FINGER_ROTATE;
		}
		if (!this.tiltActive && Math.abs(totalMotion.tiltDelta) > this.tiltThreshold && this.tiltGestures) {
			this.tiltActive = true;
			this.state = STATE.TOUCH_TILT;
		}

		// APPLY all active gestures using incremental directional deltas from PREVIOUS frame
		if (this.pinchActive) {
			// PINCH ZOOM - relative motion along the finger line
			// Positive pinchDelta = fingers apart (zoom out), negative = together (zoom in)
			const zoomDelta = incrementalMotion.pinchDelta * 0.02;
			this.zoomBy(zoomDelta);
		}

		if (this.rotateActive) {
			// TWO-FINGER ROTATION - opposing perpendicular motions
			// Positive = CCW rotation of fingers
			const rotateAmount = incrementalMotion.rotateDelta * 0.5;
			this.rotateAroundPoint(this.gestureStartCentroid, rotateAmount);
		}

		if (this.tiltActive) {
			// TWO-FINGER VERTICAL DRAG for TILT/PITCH - matching perpendicular motions
			// Positive = both fingers moving upward (or same direction perpendicular to line)
			const tiltDelta = incrementalMotion.tiltDelta * 0.5;
			this.adjustTilt(tiltDelta);
		}

		// Update previous touch positions for next frame
		this.touch1Prev.copy(touch1Curr);
		this.touch2Prev.copy(touch2Curr);

		setRenderOne(true);
	}

	handleTouchEnd(event) {
		if (event.touches.length < 2) {
			// Reset all gesture flags
			this.pinchActive = false;
			this.rotateActive = false;
			this.tiltActive = false;
			this.state = STATE.NONE;
			this.gestureStartDistance = 0;
			this.gestureStartAngle = 0;
		}
	}

	// ===== GESTURE OPERATIONS =====

	rotateAroundPoint(screenPoint, angle) {
		if (!this.rotateGestures) return;
		
		// For now, use the existing rotateLeft which rotates around the target
		// In a full implementation, would rotate around the focal point (ray from camera through screenPoint)
		this.rotateLeft(angle * Math.PI / 180);
	}

	adjustTilt(delta) {
		if (!this.tiltGestures) return;

		// This would adjust camera pitch/tilt
		// For now, simulate with rotateUp
		const tiltAmount = delta * 0.01;
		this.rotateUp(tiltAmount);
	}


	zoomScale(n, delta, speed, fraction) {
		const scale = Math.pow(fraction, speed * Math.abs(delta));
		if (delta < 0) {
			n *= scale;
		} else if (delta > 0) {
			n /= scale;
		}
		return n;
	}

	zoomBy(delta) {
		if (!this.zoomGestures || !this.enableZoom) return;

		const ptzControls = getPTZController(this.view.cameraNode);

		if (ptzControls !== undefined) {

			const fov = ptzControls.fov;

			ptzControls.fov = this.zoomScale(fov, delta, 1.5, 0.95)

			// Apply zoom limits
			if (ptzControls.fov < this.minZoom) ptzControls.fov = this.minZoom;
			if (ptzControls.fov > this.maxZoom) ptzControls.fov = this.maxZoom;

			// the FOV UI node is also updated, It's a hidden UI element that remains for backwards compatibility.
			const fovUINode = NodeMan.get("fovUI", false)
			if (fovUINode) {
				fovUINode.setValue(ptzControls.fov);
			}

		} else {

			var target2Camera = this.camera.position.clone().sub(this.target)
			var length = target2Camera.length()

			length = this.zoomScale(length, delta, this.zoomSpeed, 0.95)

			target2Camera.normalize().multiplyScalar(length)
			this.camera.position.copy(this.target).add(target2Camera)


			var toCamera = this.camera.position.clone().sub(this.target)


			// A bit patchy
			// the max distance to the target assumes the target is in a good position on the ground
			// then it's different for globe vs. terrain
			// globe we assume a large far distance, so we can see it all
			// and we use 2.5 earth radii, so we can see satellites on the other side
			// terrain Sitches just use the far distance, so they still clip out. Could be imporved.

			var maxDistance;
			if (Sit.useGlobe) {
				maxDistance = this.camera.far - 2.5 * wgs84.RADIUS;
			} else {
				maxDistance = this.camera.far / 2;
			}
			if (maxDistance > 0 && toCamera.length() > maxDistance) {
				toCamera.normalize().multiplyScalar(maxDistance).add(this.target)
				this.camera.position.copy(toCamera)
			}


			//this.fixUp() // fixup after zooming
		}
	}



	updateStateFromEvent(event) {
		switch (this.button) {
			case 0:
				// left button  = drag the world around
				this.state = STATE.DRAG;
				break;
			case 1:
				// center button = rotate camera about a point on the ground
				this.state = STATE.ROTATE;
				break;
			case 2:
				// right button = rotate camera without moving it
				this.state = STATE.PAN;
				break;
		}

		if (event.shiftKey) this.state = STATE.ROTATE;

		if (event.metaKey || event.ctrlKey) this.state = STATE.PAN;

		// might also be forced to just rotate, like when focusing on a track
		if (this.justRotate) this.state = STATE.ROTATE;

		// if we have a PTZ UI controller, then all buttons just pan
		if (getPTZController(this.view.cameraNode) !== undefined ) this.state = STATE.PAN;


	}

	handleMouseDown(event) {
		if (!this.enabled) {
			this.state = STATE.NONE
			return;
		}
		if (!mouseInViewOnly(this.view,event.clientX, event.clientY)) return;
//		console.log ("CameraMapControls Mouse DOWN, button = "+event.button)
		this.button = event.button;
		
		// Track right mouse button down position for context menu drag detection
		if (event.button === 2) {
			this.contextMenuDownPos = { x: event.clientX, y: event.clientY };
		}
		
		this.updateStateFromEvent(event)
		const [x, y] = mouseToView(this.view, event.clientX, event.clientY)
		this.mouseStart.set( x, y );
		this.canvas.setPointerCapture(event.pointerId)
		setRenderOne(true);
		if (this.view.showCursor) {
			this.view.cursorSprite.visible = true;
		}
		const mainView = ViewMan.get("mainView")
		const cursorPos = mainView.cursorSprite.position.clone();
		// convert to LLA
		const ecef = EUSToECEF(cursorPos)
		const LLA = ECEFToLLAVD_Sphere(ecef)
//		console.log("Cursor LLA: "+vdump(LLA));
		if (NodeMan.exists("cursorLLA")) {
			NodeMan.get("cursorLLA").changeLLA(LLA.x, LLA.y, LLA.z)
		} else {
			if (this.view.showCursor) {
				NodeFactory.create("LLALabel", {
					id: "cursorLLA", text: "Cursor LLA",
					lat: LLA.x, lon: LLA.y, alt: LLA.z, size: 12, offsetX: 20, offsetY: 25, centerX: 0, centerY: 0
				})
			}
		}



	}



	handleMouseUp(event) {

		// if not paused, then removed the cursor's LLA label
		if (!par.paused) {
			NodeMan.disposeRemove("cursorLLA");
		}
		this.view.cursorSprite.visible = false;

		// Check for tap gesture (left button, minimal movement) before handling context menu
		if (event.button === 0 && this.state === STATE.NONE) {
			// It was a tap gesture - check for double-tap zoom
			this.handleSingleTap(event);
		}
		
		// Check if this was a right-click release without dragging
		if (event.button === 2 && this.contextMenuDownPos) {
			const dx = event.clientX - this.contextMenuDownPos.x;
			const dy = event.clientY - this.contextMenuDownPos.y;
			const distance = Math.sqrt(dx * dx + dy * dy);
			
			// If mouse didn't move much, show the context menu
			if (distance <= this.contextMenuDragThreshold) {
				// Prevent default context menu and stop propagation
				event.preventDefault();
				event.stopPropagation();
				
				if (this.view && this.view.onContextMenu) {
					this.view.onContextMenu(event, event.clientX, event.clientY);
				}
			}
		}
		
		// Reset context menu tracking
		this.contextMenuDownPos = null;
		
		this.state = STATE.NONE
		if (!this.enabled) return;
		this.canvas.releasePointerCapture(event.pointerId)

		// dump a camera location to the console
		var p = this.camera.position.clone()
		const v = new Vector3();
		v.setFromMatrixColumn(this.camera.matrixWorld,2);
		v.multiplyScalar(-1000)
		v.add(p)

		// console.log( "startCameraPosition:"+ vdump(this.camera.position,2,'[',']')+","
		// + "\nstartCameraTarget:"+vdump(v,2,'[',']'))
		//
		// const posLLA = EUSToLLA(this.camera.position)
		// const atLLA = EUSToLLA(v)
		//
		// console.log( "startCameraPositionLLA:"+ vdump(posLLA,6,'[',']')+","
		// 	+ "\nstartCameraTargetLLA:"+vdump(atLLA,6,'[',']')+",")



	}

	handleMouseMove(event) {
		if (!this.enabled) {
			this.state = STATE.NONE
			return;
		}

		// Skip mouse move handling if we're in a touch gesture
		// Touch events trigger pointer events which we need to ignore during touch gestures
		if (this.state === STATE.TOUCH_PINCH_ZOOM || 
		    this.state === STATE.TOUCH_TWO_FINGER_ROTATE ||
		    this.state === STATE.TOUCH_TILT) {
			return;
		}

		// Check if mouse button is no longer pressed (e.g., released outside canvas)
		// event.buttons is a bitmask: 0 = no buttons, 1 = left, 2 = right, 4 = middle
		if (this.state !== STATE.NONE && event.buttons === 0) {
			this.state = STATE.NONE;
			return;
		}

		this.updateMeasureArrow();


		// debug trail of droppings if 'p' key is held
		// cursorSprite is calculated from a colliusion with the terrain model
		if (isKeyHeld('p') && isLocal) {
			const cursorPos = this.view.cursorSprite.position.clone();

			// Green sphere is the cursor position, which comes from a mouse ray intersection with the terrain
			DebugSphere("Mouse"+event.clientX*1000+event.clientY, cursorPos, 5, 0x00FF00)

			// check intersection with the terrain
			// red sphere should be 2.5m above the green sphere
			const groundPoint = pointAbove(cursorPos, 5)


			if (groundPoint !== null) {
				// Red sphere is simply 5 meters above the cursorpos
				DebugSphere("Mouse2"+event.clientX*1000+event.clientY, groundPoint, 5, 0xFF0000)

			// sample get the elevation at that point
			// and do a blue sphere based on that.

				const terrainNode = NodeMan.get("TerrainModel", false);
				if (terrainNode !== undefined) {
					const eus = terrainNode.getPointBelow(cursorPos)
					// Blue sphere is the collision with the terrainmodel
					// allowing you so see differences between the model mesh (blue)
					// and the elevation map (red)
					DebugSphere("Mouse3"+event.clientX*1000+event.clientY, eus, 5, 0x0000FF)
				}
			}


			setRenderOne(true);


		}

		if (this.state === STATE.NONE) return;
	//	console.log ("CameraMapControls Mouse MOVE, with non-zero state, enabled = "+this.enabled)
		this.updateStateFromEvent(event)

		setRenderOne(true);

		const [x, y] = mouseToView(this.view, event.clientX, event.clientY)
		this.mouseEnd.set( x, y );

		if (this.mouseStart.equals(this.mouseEnd)) {
			console.warn("mouse motion with no actual motion. Retina issues? ")
			return;
		}

	//	this.mouseEnd.set( event.clientX, event.clientY );
		this.mouseDelta.subVectors( this.mouseEnd, this.mouseStart ).multiplyScalar( this.rotateSpeed );

//		console.log(x+","+y+","+vdump(this.mouseDelta))

		const ptzControls= getPTZController(this.view.cameraNode);


		var xAxis = new Vector3()
		var yAxis = new Vector3()
		var zAxis = new Vector3()

		var oldMatrix = this.camera.matrix.clone()
		var oldPosition = this.camera.position.clone()
		this.camera.matrix.extractBasis(xAxis,yAxis,zAxis)

		const oldUp = yAxis

		switch (this.state) {

			case STATE.PAN: // Rotate the camera about itself

				const xRotate = 2 * Math.PI * this.mouseDelta.x / this.view.heightPx / 4;
				const yRotate = 2 * Math.PI * this.mouseDelta.y / this.view.heightPx / 4

//				console.log("PAN: "+xRotate+","+yRotate)


				// if we have ptzControls in this view, then update them
				// not this is notdirectly equzalent to the 	this.camera.rotateY(xRotate), etc
				// likely due to the up vector.
				if (ptzControls !== undefined) {


					ptzControls.az -= degrees(xRotate) * ptzControls.fov / 45
					ptzControls.el += degrees(yRotate) * ptzControls.fov / 45

					if (ptzControls.az < -180) ptzControls.az+=360
					if (ptzControls.az >= 180) ptzControls.az-=360
					if (ptzControls.el <= -89) ptzControls.el = -89
					if (ptzControls.el >= 89) ptzControls.el = 89

					//Globals.debugRecalculate = true
					ptzControls.recalculateCascade();
					//Globals.debugRecalculate = false;

				} else {


					this.camera.rotateY(xRotate);
					this.camera.rotateX(yRotate);

				}
				break;

			case STATE.ROTATE: // Rotate the camera about a point on the ground,

				// use this.canvas.heightPx for both to keep it square
				this.rotateLeft( 2 * Math.PI * this.mouseDelta.x / this.view.heightPx);

//				console.log("Rotating up by "+(2 * Math.PI * this.mouseDelta.y / this.view.heightPx))
				this.rotateUp( 2 * Math.PI * this.mouseDelta.y / this.view.heightPx );


				this.camera.updateMatrix()
				this.camera.updateMatrixWorld(true)
				this.camera.matrix.extractBasis(xAxis,yAxis,zAxis)

				if (!Sit.useGlobe && yAxis.y <= 0.01) {
					this.camera.position.copy(oldPosition)
					this.camera.quaternion.setFromRotationMatrix(oldMatrix);
					this.camera.updateMatrix()
					this.camera.updateMatrixWorld()
				}



				this.camera.matrix.extractBasis(xAxis, yAxis, zAxis)
				var pointInFront = this.camera.position.clone().sub(zAxis)
				this.camera.lookAt(pointInFront, oldUp)



				break;



			case STATE.DRAG: // LEFT BUTTON - DRAG THE WORLD AROUND
				// Dragging is done either on a local plane, or on the full globe
				// based on the value of useGlobe
				// if !useGlobe, then use the plane as before
				// if useGlobe then us the sphere, of this radius


				// make a plane at target height
				// Note this is LEGACY code, and should be replaced with a sphere
				// as it will only work when near the origin
				const dragPlane = new Plane(new Vector3(0,-1,0),this.target.y)

				let dragHeight = altitudeAboveSphere(this.target);


				var dragSphere;
			//	if (this.useGlobe) {
					dragSphere = new Sphere(new Vector3(0,-wgs84.RADIUS,0), wgs84.RADIUS + dragHeight)
			//	}


				// find intersection for start and end mouse positions
				const raycaster = new Raycaster();
				raycaster.layers.mask  |= LAYER.MASK_MAIN | LAYER.MASK_LOOK;


				let width = this.view.widthPx
				let height = this.view.heightPx

				var startPointer = new Vector2(
					this.mouseStart.x/ width * 2 - 1,
					- this.mouseStart.y / height * 2 + 1
				)
				var endPointer = new Vector2(
					this.mouseEnd.x/ width * 2 - 1,
					- this.mouseEnd.y / height * 2 + 1
				)

//				console.log(par.frame + ": STATE.DRAG: Start: "+vdump(startPointer)+" End: "+vdump(endPointer))

				if (startPointer.x === endPointer.x && startPointer.y === endPointer.y)
					console.log("Drag with no motion")

				// find the intersection of the start and end rays with the plane
				// then see how much they have moved
				// the positions returned will be relative to the camera

				var start3D = new Vector3();
				var end3D = new Vector3();

				raycaster.setFromCamera(startPointer, this.camera)
				if (this.targetIsTerrain && !this.useGlobe) {
					if (!raycaster.ray.intersectPlane(dragPlane, start3D)) break;
				} else {
					if (!intersectSphere2(raycaster.ray, dragSphere, start3D)) break;
				}
				raycaster.setFromCamera(endPointer, this.camera)
				if (this.targetIsTerrain && !this.useGlobe) {
					if (!raycaster.ray.intersectPlane(dragPlane, end3D)) break;
				} else {
					if (!intersectSphere2(raycaster.ray, dragSphere, end3D)) break;
				}

			//	DebugArrowAB("mouseMovePan",start3D,end3D,0x00ffff,true,GlobalScene)

				// Panning is like dragging the ground in one direction, which means we move the camera in the other direction
				// hence the .sub here

				//var delta3D = end3D.clone().sub(start3D)
				//this.camera.position.sub(delta3D)

				const origin = V3(0, -wgs84.RADIUS, 0)
				const originToStart = start3D.clone().sub(origin)
				const originToEnd   = end3D.clone().sub(origin)

				// we now have three points that define the plane of rotation
				// the origin, and the start and end point

				// calculate a vector perpendicular to the three
				const rotationAxis = new Vector3().crossVectors(originToStart, originToEnd).normalize();
				// find the angle we need to rotate:
				const odot = originToStart.dot(originToEnd)
				const lengthsMultiplied = (originToStart.length() * originToEnd.length())
				const oCos = odot / lengthsMultiplied

				let angle = -Math.acos( oCos);
				if (isNaN(angle)) {
					console.log("ToStart "+vdump(originToStart)+" ToEnd: "+vdump(originToEnd))
					console.log("ots "+originToStart.length() +"," + originToEnd.length())
					console.log("o: "+odot+","+lengthsMultiplied+" / = " + oCos)
					console.warn("NaN angle in Camera controls STATE.DRAG, patching to 0")
					angle = 0;
				};

				 // const rotationAxis = V3(0,1,0)
				 // const angle = radians(1)


				// DebugArrow("rotationAxis", rotationAxis, origin,7000000, "#00FFFF")
				// DebugArrowAB("Start", origin, start3D,"#FF0000", true,GlobalScene)
				// DebugArrowAB("End", origin, end3D,"#00FF00", true,GlobalScene)


				this.camera.position.sub(origin) 						// make position relative to the globe orgin

//				console.log("rotationAxis: "+vdump(rotationAxis)+" angle = "+angle)
				this.camera.rotateOnWorldAxis(rotationAxis,angle) 		// rotate the orientation only
				this.camera.position.applyAxisAngle(rotationAxis,angle) // rotate the position
//				console.log("Camera position "+ vdump(this.camera.position))

				this.camera.position.add(origin) 						// position back to EUS
				this.camera.updateMatrix();
				this.camera.updateMatrixWorld();

				// force up vector to be local up for camera
				//this.fixUp(true); // fixup after dragging

				const localUp = getLocalUpVector(this.camera.position)
				this.camera.up.copy(localUp) // force the up vector to be local up


				break;


		}

		this.fixUp() // fixup on any mouse move

		this.mouseStart.copy( this.mouseEnd );

	}


	updateMeasureArrow() {

		const mainView = ViewMan.get("mainView");
		const cursorPos = mainView.cursorSprite.position.clone();

		let update = false;

		if (isKeyHeld('a')) {
			this.measureStartPoint.set(cursorPos.x, cursorPos.y, cursorPos.z);
			update = true;
		}

		if (isKeyHeld('b')) {
			this.measureEndPoint.set(cursorPos.x, cursorPos.y, cursorPos.z);
			update = true;
		}


		// move the end of the measure arrow
		if (update && this.measureStart !== null) {
			const A = this.measureStartPoint;
			const B = this.measureEndPoint;
			const Center = V3(0, -wgs84.RADIUS, 0)


			// we need to raise up the line, so that it is above the globe


			// for the radisu of the sphere used, use the largest of the two points
			const A_radius = A.clone().sub(Center).length()
			const B_radius = B.clone().sub(Center).length()
			const radius = Math.max(A_radius, B_radius)


			// find the center of the arc AB, centered on O
			const M = A.clone().add(B).multiplyScalar(0.5)
			// find the point on the sphere below AB
			const C = pointOnSphereBelow(M, radius - wgs84.RADIUS); // passing in altitude above the wgst84 sphere
			const C_height = C.clone().sub(Center).length()
			const M_height = M.clone().sub(Center).length()
	//		const A_height = A.clone().sub(Center).length()
	//		const B_height = B.clone().sub(Center).length()
			const scale = C_height / M_height
			const A2 = Center.clone().add(A.clone().sub(Center).multiplyScalar(scale))
			const B2 = Center.clone().add(B.clone().sub(Center).multiplyScalar(scale))

			this.measureStart.setXYZ(A2.x, A2.y, A2.z)
			this.measureEnd.setXYZ(B2.x, B2.y, B2.z)

			this.measureDownA = DebugArrowAB("MeasureDownA", A2, A, 0x00FF00, true, GlobalScene)
			this.measureDownB = DebugArrowAB("MeasureDownB", B2, B, 0xFF0000, true, GlobalScene)
		}
	}

	fixUp(force = false) {
		// if we are close to the ground, and not looking up more than 45 degrees
		// then we want to keep the camera up vector to local up
		var xAxis = new Vector3()
		var yAxis = new Vector3()
		var zAxis = new Vector3()
		this.camera.updateMatrix();
		this.camera.matrix.extractBasis(xAxis, yAxis, zAxis)
		const up = getLocalUpVector(this.camera.position, wgs84.RADIUS)
		const alt = altitudeAboveSphere(this.camera.position);
		if (alt < 100000 || force) {
			const upAngle = degrees(up.angleTo(xAxis))
			if (upAngle > 45) {

				if (force) {
		//			console.log("Forcing up vector to local up")
					this.camera.up.copy(up)
				} else {
		//			console.log("Lerping towards local up")
					this.camera.up.lerp(up, 0.05);
				}
				var pointInFront = this.camera.position.clone().sub(zAxis)
				this.camera.lookAt(pointInFront);
				this.camera.updateMatrix();
				this.camera.updateMatrixWorld();
			}
		}

	}


	// fix the heading of the camera to the given heading
	fixHeading(heading) {

		// from the camera's matrix, calculate pan, tilt, and roll
		// then set the pan to the heading
		// and recalculate the matrix

		// calculate tilt from the camera's matrix
		// FIXED: Use camera.getWorldDirection() which correctly negates Z for cameras
		const camFwdForAzEl = new Vector3();
		this.camera.getWorldDirection(camFwdForAzEl);
		const [az, el] = getAzElFromPositionAndForward(this.camera.position, camFwdForAzEl)


		// decide what tyoe of rotation to do
		// if the camera's forward vector instersect the ground, then we can just rotate the camera
		// about that point

		const camPos = this.camera.position.clone()
		const camFwd = new Vector3();
		this.camera.getWorldDirection(camFwd);

		const ground = intersectMSL(camPos, camFwd);


		if (ground) {

			// console.log("Rotate about ground to " + heading + " from az,el = " + az + "," + el)

			// get the up vector at the ground point
			const groundUp = getLocalUpVector(ground, wgs84.RADIUS)

			// find angle needed to rotate the camera to the heading
			const angle = radians(heading - az);

			// rotate the camera about the ground up vector
			this.camera.position.sub(ground)
			this.camera.position.applyAxisAngle(groundUp, - angle)
			this.camera.position.add(ground)
			this.camera.up.copy(groundUp)
			this.camera.lookAt(ground);

			this.camera.updateMatrix();

		} else {


			// just set pan/az to the heading, roll to zero, and recalculate the matrix

			console.log("Fixing heading to " + heading + " from az,el = " + az + "," + el)


			let fwd = getLocalNorthVector(this.camera.position);
			let right = getLocalEastVector(this.camera.position);
			let up = getLocalUpVector(this.camera.position);
			fwd.applyAxisAngle(right, radians(el))
			fwd.applyAxisAngle(up, -radians(heading))

			fwd.add(this.camera.position);
			this.camera.up = up;
			this.camera.lookAt(fwd)
		}

	}


	// rotate the camera around the target, so we rotate
	rotateLeft(angle) {
		this.camera.position.sub(this.target) // make relative to the target
		//const up = new Vector3(0,1,0)
		const up = getLocalUpVector(this.target, wgs84.RADIUS)
		this.camera.position.applyAxisAngle(up,-angle) // rotate around origin (around target)
		this.camera.position.add(this.target) // back into world space
		this.camera.rotateOnWorldAxis(up,-angle) // rotate the camere as well, so target stays in same spot

	}

	// given the camera position and forward vector, how far is is from vertically down
	getVerticalAngleDegrees() {
		const down = getLocalDownVector(this.camera.position)
		const lookVector = new Vector3();
		this.camera.getWorldDirection(lookVector);
		return degrees(down.angleTo(lookVector))
	}

	// rotate the camera around the target, so we rotate
	rotateUp(angle) {

		const downAngleStart = this.getVerticalAngleDegrees();
		//console.log("angle = "+angle+" Down angle start: "+downAngleStart)

		if (angle > 0 && (downAngleStart - degrees(angle)) < 5) return; // don't go below the horizon


		this.camera.position.sub(this.target) // make relative to the target
		// need to get the local right vector
		var rotationMatrix = new Matrix4().extractRotation(this.camera.matrixWorld);
		var right = new Vector3(1, 0, 0).applyMatrix4(rotationMatrix).normalize();

		this.camera.position.applyAxisAngle(right,-angle) // rotate around origin (around target)
		this.camera.position.add(this.target) // back into world space

		this.camera.rotateOnWorldAxis(right, -angle) // rotate the camere as well, so target stays in same spot

	}



}

export function getPTZController(cameraNode) {

	cameraNode = NodeMan.get(cameraNode);

	// given the camera node, find the PTZ controller in the inputs
	// by inspecting the type of the input
	// then return the controller
	// if not found, return undefined
	//
	for (const key in cameraNode.inputs) {
		const input = cameraNode.inputs[key];
		// is it a CNodeControllerPTZ
		if (input instanceof CNodeControllerPTZUI) {
			return input;
		}
	}
	return undefined;

}



export {  CameraMapControls };
