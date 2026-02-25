import {PointEditorWidget} from "./PointEditorWidget.js";
import {
    BoxGeometry,
    ConeGeometry,
    Line3,
    Mesh,
    MeshBasicMaterial,
    MeshLambertMaterial,
    Raycaster,
    Vector2,
    Vector3
} from "three";
import {EUSToLLA, legacyEUSToECEF, LLAToEUS} from "./LLA-ECEF-ENU";
import {assert} from "./assert.js";
import {V3} from "./threeUtils";
import {ViewMan} from "./CViewManager";
import {mouseInViewOnly, mouseToViewNormalized} from "./ViewUtils";
import {setRenderOne, Sit} from "./Globals";
import {radians} from "./utils";
import {undoManager as UndoManager} from "./UndoManager";
import * as LAYER from "./LayerMasks";
import {CNodePositionXYZ} from "./nodes/CNodePositionLLA";
import {CNodeMeasureAltitude, setupMeasurementUI} from "./nodes/CNodeLabels3D";

export class PointEditor {
    constructor(_scene, _camera, _renderer, controls, onChange, initialPoints, isLLA=false, legacyEUS=false) {

        this.splineHelperObjects = [];  // the objects that are the control points
        this.frameNumbers = []          // matching frame numbers
        this.positions = [];            // positions of the above
        this.selectedCube = null;       // the currently selected cube (hidden when widget is attached)

        this.scene = _scene
        this.camera = _camera
        this.renderer = _renderer
        this.onChange = onChange   // external callback for when spline is changed

        this.raycaster = new Raycaster();         // for picking
        this.raycaster.layers.mask  |= LAYER.MASK_MAIN | LAYER.MASK_LOOK | LAYER.MASK_HELPERS;
        this.pointer = new Vector2();
        this.onUpPosition = new Vector2();       // mouse position when up
        this.onDownPosition = new Vector2();      // and down

        this.minimumPoints  = 2;
        this.numPoints = 0;

        // this.geometry is the object used as a control point on the curve
        // in this case it's a 1x1x1 cube, scaled via pixelsToMeters to be view-invariant
        // will be 1/10 the diameter of the disk (4px)
        this.geometry = new BoxGeometry( 1, 1, 1 );

        // a PointEditorWidget is an interactive object that you can attach to
        // another object to move it around the world (horizontally or vertically)
        // here it's attached to control points when we mouse over them
        this.transformControl = new PointEditorWidget(this.camera, this.renderer.domElement);
        this.transformControl.addEventListener('change', () => setRenderOne());
        this.transformControl.addEventListener('dragging-changed', (event) => {
            controls.enabled = !event.value;
            
            if (event.value) {
                // Drag started - capture state
                this.stateBeforeDrag = this.captureState();
            } else {
                // Drag ended - create undo action if state changed
                if (this.stateBeforeDrag && UndoManager) {
                    const stateAfterDrag = this.captureState();
                    const stateBefore = this.stateBeforeDrag;
                    const stateChanged = JSON.stringify(stateBefore) !== JSON.stringify(stateAfterDrag);
                    
                    if (stateChanged) {
                        UndoManager.add({
                            undo: () => {
                                this.restoreState(stateBefore);
                            },
                            redo: () => {
                                this.restoreState(stateAfterDrag);
                            },
                            description: "Move track control point"
                        });
                    }
                }
                this.stateBeforeDrag = null;
            }
        });
        const gizmo = this.transformControl.getHelper();
        
        this.scene.add(gizmo);

        // Create position indicator cone (inverted, pointing down)
        // The cone will show the current track position during edit mode
        const coneGeometry = new ConeGeometry(1, 2, 8); // radius, height, segments
        const coneMaterial = new MeshBasicMaterial({ 
            color: 0xffffff,
            transparent: true,
            opacity: 0.8,
            depthTest: true,
            depthWrite: false
        });
        this.positionIndicatorCone = new Mesh(coneGeometry, coneMaterial);
        this.positionIndicatorCone.rotation.x = Math.PI; // Invert the cone (point down)
        this.positionIndicatorCone.layers.mask = LAYER.MASK_HELPERS;
        this.positionIndicatorCone.visible = false; // Hidden by default
        this.scene.add(this.positionIndicatorCone);

        // Create measurement node for altitude above ground
        // Ensure measurement UI is set up
        setupMeasurementUI();
        
        // Generate unique IDs for this editor instance
        const uniqueId = Math.random().toString(36).substr(2, 9);
        
        // Create a position node for the track position
        this.measurePoint = new CNodePositionXYZ({id: `pointEditor_measure_${uniqueId}`, x:0, y:0, z:0});
        
        // Create the altitude measurement display
        // CNodeMeasureAltitude automatically creates the ground point below the position
        // Note: We don't specify groupNode, so it uses the default "MeasurementsGroupNode"
        this.measureAltitude = new CNodeMeasureAltitude({
            id: `pointEditor_measureAlt_${uniqueId}`,
            position: `pointEditor_measure_${uniqueId}`,
            color: "#00FF00",
            text: "AGL",
        });
        
        // Initially hide the measurement
        this.measureAltitude.group.visible = false;

        this._onPointerDown = event => this.onPointerDown(event);
        this._onPointerUp = event => this.onPointerUp(event);
        this._onPointerMove = event => this.onPointerMove(event);
        document.addEventListener('pointerdown', this._onPointerDown);
        document.addEventListener('pointerup', this._onPointerUp);
        document.addEventListener('pointermove', this._onPointerMove);



        this.transformControl.addEventListener('objectChange',  () => {
            this.snapPointByIndex(this.editingIndex)
            this.updatePointEditorGraphics();
            if (this.onChange) this.onChange();
        });


//        this.data = new PointEditorData(initialPoints);
        if (!isLLA && legacyEUS) {
            // legacy EUS points from sitch definitions: convert from old local tangent plane to ECEF
            const latRad = radians(Sit.lat);
            const lonRad = radians(Sit.lon);
            const ecefPoints = [];
            for (let i = 0; i < initialPoints.length; i++) {
                const frame = initialPoints[i][0];
                const eus = V3(initialPoints[i][1], initialPoints[i][2], initialPoints[i][3]);
                const ecef = legacyEUSToECEF(eus, latRad, lonRad);
                ecefPoints.push([frame, ecef.x, ecef.y, ecef.z]);
            }
            this.load(ecefPoints)
        } else if (!isLLA) {
            // points already in current coordinate system (ECEF)
            this.load(initialPoints)
        } else {
            // convert from LLA to EUS, accounting for any new map coordinate system
            const LLAPoints = []
            for (let i = 0; i < initialPoints.length; i++) {
                const frame = initialPoints[i][0]
                const lla = LLAToEUS(initialPoints[i][1],initialPoints[i][2],initialPoints[i][3])
                LLAPoints.push ([frame,lla.x,lla.y,lla.z])
            }
            console.log(LLAPoints)
            this.load(LLAPoints)
        }
        this.setEnable(false)
    }

    // set up a set of points
    load(new_positions, LLA = false) {

        // This first two things just make the this.positions array the same length
        // as the new_positions array
        // this is done so the reference passed to new THREE.CatmullRomCurve3 is unchanged
        // (which would not be the case if we created a new array)
        while (new_positions.length > this.positions.length) {
            this.addPoint();
        }

        while (new_positions.length < this.positions.length) {
            this.removePoint();
        }

        for (let i = 0; i < this.positions.length; i++) {
            //   this.positions[i].copy(new_positions[i]);
            this.frameNumbers[i] = new_positions[i][0]
            this.positions[i].x = new_positions[i][1]
            this.positions[i].y = new_positions[i][2]
            this.positions[i].z = new_positions[i][3]
        }

    }

    snapPointByIndex(i) {
        const editingObject = this.splineHelperObjects[i];
        //      editingObject.position.y = 500;
        if (this.snapCamera !== undefined) {
            // Snap to a LOS between the snapCamera track and the snapTarget Track
            const editingFrame = this.frameNumbers[i]
            const cameraPos = this.snapCamera.p(editingFrame)
            const targetPos = this.snapTarget.p(editingFrame)
            const los = new Line3(cameraPos,targetPos)
            const clamped = V3();
            los.closestPointToPoint(editingObject.position, false, clamped) // false means we can extend the LOS

            // note we need to COPY the position, as the object position is shared by both
            // the helper object, and the Point Editor positions[] array.
            // OR do we? is't it by reference?
            editingObject.position.copy(clamped)
        }
    }

    updateSnapping() {
        for (let i = 0; i < this.numPoints; i++) {
            this.snapPointByIndex(i)
        }
    }


    setEnable(enable) {
        this.enable = enable;
        if (!this.enable) {
            this.transformControl.detach()
            // Hide all control cubes when exiting edit mode
            for (let i = 0; i < this.numPoints; i++) {
                this.splineHelperObjects[i].visible = false;
            }
            // Hide the position indicator cone when edit mode is disabled
            if (this.positionIndicatorCone) {
                this.positionIndicatorCone.visible = false;
            }
            // Hide the measurement when edit mode is disabled
            if (this.measureAltitude) {
                this.measureAltitude.group.visible = false;
            }
        } else {
            // Show all control cubes when entering edit mode
            for (let i = 0; i < this.numPoints; i++) {
                this.splineHelperObjects[i].visible = true;
            }
            // When enabling, attach to the first control point if we have any
            // This hides that point's cube, leaving others visible
            if (this.numPoints > 0) {
                this.editingIndex = 0;
                this.transformControl.attach(this.splineHelperObjects[0]);
            }
            // Show the position indicator cone when edit mode is enabled
            if (this.positionIndicatorCone) {
                this.positionIndicatorCone.visible = true;
            }
            // Show the measurement when edit mode is enabled
            if (this.measureAltitude) {
                this.measureAltitude.group.visible = true;
            }
        }
    }

    /**
     * Update the position indicator cone to show the current track position
     * This should be called from the render loop when the track is in edit mode
     * @param {Vector3} position - The current position on the track
     * @param {CNodeView3D} view - The view to use for screen-space scaling
     */
    updatePositionIndicator(position, view) {
        if (!this.positionIndicatorCone || !this.enable || !position || !view) {
            return;
        }

        // Scale the cone to maintain constant screen size (like transform controls)
        // Use pixelsToMeters to convert a fixed pixel size to world units
        const coneHeightPixels = 40; // Height of cone in screen pixels
        const coneRadiusPixels = 20; // Radius of cone in screen pixels
        
        const heightMeters = view.pixelsToMeters(position, coneHeightPixels);
        const radiusMeters = view.pixelsToMeters(position, coneRadiusPixels);
        
        // The cone geometry has height=2 and radius=1, so scale accordingly
        this.positionIndicatorCone.scale.set(radiusMeters, heightMeters / 2, radiusMeters);

        // Position the cone so its TIP is at the track position
        // The cone is inverted (rotated 180° on X axis), so the tip is at the bottom
        // We need to offset it upward by half the scaled height
        this.positionIndicatorCone.position.copy(position);
        this.positionIndicatorCone.position.y += heightMeters / 2;

        // Update the altitude measurement
        // CNodeMeasureAltitude automatically calculates the ground point below
        if (this.measurePoint && this.measureAltitude) {
            // Update the position node with the current track position
            this.measurePoint.setXYZ(position.x, position.y, position.z);
            
            // Note: We don't call measureAltitude.update() here because it will be
            // called automatically by NodeMan.iterate() in the main loop.
            // Calling it here would cause the arrows to be updated AFTER scaleArrows()
            // has run in the render loop, causing them to not scale until the next frame.
        }
    }

    // Given a hight and a camera track, adjust all the points up vertically by "height"
    // but keep them on the LOS (i.e. move towards the camera)
    adjustUp(height, cameraTrack) {
        for (let i = 0; i < this.positions.length; i++) {
            let frame = this.frameNumbers[i]
            let cameraPos = cameraTrack.p(frame)
            let toCamera = cameraPos.clone().sub(this.positions[i]).normalize()
            let scale = height/toCamera.y;
            toCamera.multiplyScalar(scale)
            this.positions[i].add(toCamera)
        }
    }

    /**
     * Helper function to set up raycaster with view-relative coordinates
     * Returns true if the mouse is in the main view and raycaster is ready, false otherwise
     */
    setupRaycasterForEvent(event) {
        const view = ViewMan.get("mainView");
        
        // Robust check: if mainView doesn't exist, do nothing
        if (!view) {
            return false;
        }

        // Check if mouse is within the main view bounds
        if (!mouseInViewOnly(view, event.clientX, event.clientY)) {
            return false;
        }

        // Convert to view-normalized coordinates
        const [px, py] = mouseToViewNormalized(view, event.clientX, event.clientY);
        this.pointer.x = px;
        this.pointer.y = py;

        // Set up raycaster with the normalized coordinates
        this.raycaster.setFromCamera(this.pointer, this.camera);
        
        return true;
    }

    /**
     * Helper function to find intersected control point objects
     * Returns the first intersected object or null
     */
    getIntersectedControlPoint() {
        const intersects = this.raycaster.intersectObjects(this.splineHelperObjects, false);
        return intersects.length > 0 ? intersects[0].object : null;
    }

    onPointerDown(event) {
        if (!this.enable) return;

        this.onDownPosition.x = event.clientX;
        this.onDownPosition.y = event.clientY;
        this.onDownButton = event.button;
    }

    onPointerUp(event) {
        if (!this.enable) return;

        this.onUpPosition.x = event.clientX;
        this.onUpPosition.y = event.clientY;

        // Only detach on left-click (button 0) when there was no drag
        // Don't detach on right-click (button 2) to keep controls visible during context menu
        if (this.onDownButton === 0 && this.onDownPosition.distanceTo(this.onUpPosition) === 0) {
            this.transformControl.detach();
            
            // Re-attach to first point to keep controls visible in edit mode
            if (this.numPoints > 0) {
                this.editingIndex = 0;
                this.transformControl.attach(this.splineHelperObjects[0]);
            }
        }
        this.exportSpline();
    }

    onPointerMove(event) {
        if (!this.enable) return;

        if (!this.setupRaycasterForEvent(event)) {
            return; // Not in main view or view doesn't exist
        }

        const object = this.getIntersectedControlPoint();
        if (object) {
            // Find the index of the control point we're hovering over
            this.editingIndex = this.splineHelperObjects.findIndex(ob => ob === object);

            // Attach transform control if not already attached to this object
            if (object !== this.transformControl.object) {
                this.transformControl.attach(object);
            }
        }
    }


    addPoint() {
        // here's the crux of this refactoring issue
        // the positions in the curve are stored in a simple array of Vector3s: this.positions
        // but they are references to the position vectors in point editor objects
        // intrinsically tying the data to the UI
        // the UI can modify these positions
        this.numPoints++;
        const newPoint = this.addPointEditorObject();
        this.positions.push(newPoint.position);
        this.frameNumbers.push(-1)
        this.dirty = true;
        
        // Attach transform control to the newly added point
        this.transformControl.attach(newPoint);
    }


    removePoint() {

        if (this.numPoints <= this.minimumPoints) {
            return;
        }

        const point = this.splineHelperObjects.pop();
        this.numPoints--;
        this.positions.pop();
        this.frameNumbers.pop()

        if (this.transformControl.object === point) this.transformControl.detach();
        this.scene.remove(point);

      //  this.updatePointEditorGraphics();
      //  if (this.onChange) this.onChange();

    }


    exportSpline() {

        let strplace = [];

        for (let i = 0; i < this.numPoints; i++) {
            const p = this.splineHelperObjects[i].position;
            strplace.push(`[${this.frameNumbers[i]}, ${p.x}, ${p.y}, ${p.z}]`);
        }
//        console.log(strplace.join(',\n'));
        strplace = [];
        for (let i = 0; i < this.numPoints; i++) {
            const p = EUSToLLA(this.splineHelperObjects[i].position);
            strplace.push(`[${this.frameNumbers[i]}, ${p.x}, ${p.y}, ${p.z}]`);
        }
//        console.log(strplace.join(',\n'));

    }

    makePointEditorObject(position) {

        const material = new MeshLambertMaterial({color: Math.random() * 0xffffff});
        const object = new Mesh(this.geometry, material);

        if (position) {

            object.position.copy(position);

        } else {

            object.position.x = Math.random() * 1000 - 500;
            object.position.y = Math.random() * 600;
            object.position.z = Math.random() * 800 - 400;

        }

        object.castShadow = true;
        object.receiveShadow = true;
        object.layers.mask = LAYER.MASK_HELPERS;
        this.scene.add(object);

        return object;
    }

    addPointEditorObject(position) {
        const object = this.makePointEditorObject(position)
        this.splineHelperObjects.push(object);
        return object;
    }

    getLength(frames) {
        // just add the sum of the linear lengths of the segments. frames is ignored
        let len = 0;
        for (let i=0;i<this.numPoints-1;i++) {
            len += this.positions[i+1].clone().sub(this.positions[i]).length()
        }
        return len
    }


    // get value at t (parametric input, 0..1) into the vector point
    // spline editors will override with a more complex one to get points
    // along a curve, but here we can just interpolate between the points
    getPoint(t,point) {
        if (this.numPoints < 2) {
            if (this.numPoints === 1) {
                point.copy(this.positions[0]);
            }
            return;
        }
        // first find point A and B such that t is between the
        let a = Math.floor(t * (this.numPoints-1))
        if (t >= 1.0) a = this.numPoints - 2; // exception for t =1
        const b = a + 1 // b is always just the bext point
        const f = (t * (this.numPoints-1)-a) // fraction within the segment a-b

    //    console.log("t:"+t+" np-1:" + (this.numPoints-1) +" a:"+a+" b:"+b+" f:"+f)
        //now simply interpolate.
        point.copy(this.positions[b])
        point.sub(this.positions[a])
        point.multiplyScalar(f)
        point.add(this.positions[a])
    }

    // given a frame number, find the matching value for t (i.e how far along the curve
    getPointFrame(f) {
        let point;
        point = new Vector3()
        // frameNumbers is an array of the frame number that each control point is at
        // it's on greater that the number of segments.
        assert(this.frameNumbers.length > 0, "Can't work with zero frame in a spline")
        if (this.frameNumbers.length === 1) {
            point.copy(this.positions[0])
            return point
        }
        // this is the index of the last control point
        // i.e. the last fencepost
        const lastIndex = this.frameNumbers.length - 1
        
        // Check if extrapolation is enabled for this track
        // Default to true if not set or if parentNode is not available
        const shouldExtrapolate = this.parentNode?.extrapolateTrack ?? true;
        
        // Handle frames before the first control point
        if (f < this.frameNumbers[0]) {
            if (shouldExtrapolate) {
                // Linear extrapolation using the first two control points
                const frame0 = this.frameNumbers[0];
                const frame1 = this.frameNumbers[1];
                const pos0 = this.positions[0];
                const pos1 = this.positions[1];
                
                // Calculate the extrapolation factor (negative since we're going backwards)
                const frameDelta = frame1 - frame0;
                const extrapolationFactor = (f - frame0) / frameDelta;
                
                // Linear extrapolation: pos = pos0 + (pos1 - pos0) * factor
                point.copy(pos1).sub(pos0).multiplyScalar(extrapolationFactor).add(pos0);
                return point;
            } else {
                // Clamp to first control point
                f = this.frameNumbers[0];
            }
        }
        
        // Handle frames after the last control point
        if (f > this.frameNumbers[lastIndex]) {
            if (shouldExtrapolate) {
                // Linear extrapolation using the last two control points
                const frame0 = this.frameNumbers[lastIndex - 1];
                const frame1 = this.frameNumbers[lastIndex];
                const pos0 = this.positions[lastIndex - 1];
                const pos1 = this.positions[lastIndex];
                
                // Calculate the extrapolation factor (positive since we're going forward)
                const frameDelta = frame1 - frame0;
                const extrapolationFactor = (f - frame0) / frameDelta;
                
                // Linear extrapolation: pos = pos0 + (pos1 - pos0) * factor
                point.copy(pos1).sub(pos0).multiplyScalar(extrapolationFactor).add(pos0);
                return point;
            } else {
                // Clamp to last control point
                f = this.frameNumbers[lastIndex];
            }
        }

        const numFramesCovered = this.frameNumbers[lastIndex] - this.frameNumbers[0]
        let segment = 0
        let t = 0;
        const tPerSegment = 1/lastIndex;
        while (segment<lastIndex
        && (f < this.frameNumbers[segment] || f > this.frameNumbers[segment+1])) {
            segment++
            t += tPerSegment
        }
        if (segment === lastIndex) {
            t = 1.0;
        } else {
            // t is the value of t at the start of this segment
            // t + tPerSegment will be the value at the end.
            // so need to add the fraction of tPerSegment that we are into this segment.
            t = t + (tPerSegment * (f - this.frameNumbers[segment]) / (this.frameNumbers[segment+1] - this.frameNumbers[segment]))

        }
//        if (f===3015)
//            console.log("f:"+f+", t:"+t)
        this.getPoint(t,point)
        //console.log("f:"+f+", t:"+t+" -> "+vdump(point,2))
        return point;

    }


    // find the first point that has a frame equal to, or less than this frame
    // and either it's the last frame, or the next frame is higher
    // replace it if the same frame,
    // insert after if a lower frame
    // need to update all of:
    // - framesNumbers
    // - positions (Which is an array of REFERENCES to the positions in the splineHelperObjects
    // - splineHelperObjects
    // They are separate arrays as the code needs an array of objects for collision detection
    // and an array of positions for the spline code
    insertPoint(frame, position) {

        assert(this.frameNumbers.length === this.positions.length)
        assert(this.frameNumbers.length === this.splineHelperObjects.length)
        assert(this.frameNumbers.length === this.numPoints)

        // make the helper object we are going to add ahead of time
        // the position are references to this
        const object = this.makePointEditorObject(position)
        let insertedIndex = -1;

        if (this.frameNumbers.length === 0 || this.frameNumbers[0] > frame) {
            // nothing there, or first frame has a higher value than this one
            // so we push to the head of the array
            this.frameNumbers.splice(0,0,frame)
            this.positions.splice(0,0,object.position)
            this.splineHelperObjects.splice(0,0,object)
            this.numPoints++;
            insertedIndex = 0;
        } else {

            // at this point we know that we have:
            // - at least one point
            // - with a frame number less than
            let insertPoint = 0;
            while (!(insertPoint === this.frameNumbers.length - 1)
            && !(this.frameNumbers[insertPoint] <= frame && this.frameNumbers[insertPoint + 1] > frame)) {
                insertPoint++
            }
            console.log("Insert at " + insertPoint)

            // if the SAME frame number, then replace
            if (this.frameNumbers[insertPoint] === frame) {
                this.scene.remove(this.splineHelperObjects[insertPoint])
                this.positions[insertPoint] = object.position
                this.splineHelperObjects[insertPoint] = object;
                insertedIndex = insertPoint;
            } else {
                // otherwise, insert after this position
                this.frameNumbers.splice(insertPoint + 1, 0, frame)
                this.positions.splice(insertPoint + 1, 0, object.position)
                this.splineHelperObjects.splice(insertPoint + 1, 0, object)
                this.numPoints++
                insertedIndex = insertPoint + 1;
            }
        }
        this.updatePointEditorGraphics()
        
        // Attach transform control to the newly inserted point if editor is enabled
        if (this.enable && insertedIndex >= 0) {
            this.editingIndex = insertedIndex;
            this.transformControl.attach(this.splineHelperObjects[insertedIndex]);
        }
    }


    updatePointEditorGraphics() {

        // extend it with something like updating a spline, or set of lines
        // or whatever you are controlling with the points
        // which you can also do with the onChange callBack if you want to
        // construct an object rather than derive a new class.

       // console.log("+++ Set Editor DIRTY here")
        this.dirty = true;
        setRenderOne(true);

    }

    /**
     * Update the scale of all control point cubes to maintain constant screen size
     * This should be called from the render loop to keep cubes at a fixed pixel size
     * @param {CNodeView3D} view - The view to use for screen-space scaling
     */
    updateCubeScales(view) {
        if (!view || !view.pixelsToMeters) {
            return;
        }
        
        if (view.id !== "mainView") {
            return;
        }
        
        const cubePixelSize = 20;
        
        for (let cube of this.splineHelperObjects) {
            const cubeMeters = view.pixelsToMeters(cube.position, cubePixelSize);
            cube.scale.set(cubeMeters, cubeMeters, cubeMeters);
        }
    }

    captureState() {
        return {
            positions: this.positions.map(p => ({x: p.x, y: p.y, z: p.z})),
            frameNumbers: [...this.frameNumbers]
        };
    }
    
    restoreState(state) {
        for (let i = 0; i < state.positions.length && i < this.positions.length; i++) {
            this.positions[i].x = state.positions[i].x;
            this.positions[i].y = state.positions[i].y;
            this.positions[i].z = state.positions[i].z;
            this.frameNumbers[i] = state.frameNumbers[i];
        }
        this.updatePointEditorGraphics();
        if (this.transformControl && this.transformControl.object) {
            const obj = this.transformControl.object;
            this.transformControl.attach(obj);
        }
        if (this.onChange) this.onChange();
    }
    
    /**
     * Clean up resources when the editor is disposed
     */
    dispose() {
        // Remove and dispose the position indicator cone
        if (this.positionIndicatorCone) {
            this.scene.remove(this.positionIndicatorCone);
            this.positionIndicatorCone.geometry.dispose();
            this.positionIndicatorCone.material.dispose();
            this.positionIndicatorCone = null;
        }

        // Clean up measurement nodes
        // Note: measureAltitude.dispose() will also dispose its internal ground point node
        if (this.measureAltitude) {
            this.measureAltitude.dispose();
            this.measureAltitude = null;
        }
        if (this.measurePoint) {
            this.measurePoint.dispose();
            this.measurePoint = null;
        }

        // Clean up transform controls
        if (this.transformControl) {
            this.transformControl.detach();
            this.transformControl.dispose();
        }

        // Remove document event listeners
        document.removeEventListener('pointerdown', this._onPointerDown);
        document.removeEventListener('pointerup', this._onPointerUp);
        document.removeEventListener('pointermove', this._onPointerMove);

        // Remove all control point objects
        for (let i = 0; i < this.splineHelperObjects.length; i++) {
            this.scene.remove(this.splineHelperObjects[i]);
        }
    }

}