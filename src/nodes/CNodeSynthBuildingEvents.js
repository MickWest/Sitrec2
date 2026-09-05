import {registerEditorInteraction} from "../EditorInteraction";
/**
 * Pointer / event-handling methods for CNodeSynthBuilding.
 *
 * Split out of CNodeSynthBuilding.js to keep that file focused on geometry,
 * roof math, and GUI wiring. Covers:
 * - Document-level pointer listener setup (setupEventListeners).
 * - Handle + mesh hover detection (checkHandleHover, isOutsideHandleInPlane,
 *   checkBuildingMeshHover).
 * - Drag state machine: onPointerDown / onPointerMove / onPointerUp + the
 *   mode-specific rotation handler (handleRotation).
 *
 * Installed on CNodeSynthBuilding.prototype via Object.assign.
 */

import {Plane, Vector3} from "three";
import {CustomManager, Globals, NodeMan, setRenderOne, Synth3DManager, UndoManager} from "../Globals";
import {getLocalUpVector} from "../SphericalMath";
import {getVisiblePointBelow} from "../threeExt";
import {EventManager} from "../CEventManager";
import {ViewMan} from "../CViewManager";
import {assert} from "../assert";
import * as LAYER from "../LayerMasks";
import {getInteractiveViewAt, isViewDisplayed, setRaycasterFromView, withDisplayedCamera} from "../ViewUtils";

export const eventMethods = {
    // A drag stays with the camera it started in, even when the pointer leaves
    // that pane. Hover and new presses can use either of the editing views.
    setupRaycasterForEvent(event) {
        let view = (this.isDragging || this.isRotating) ? this.activeView : null;
        if (!view) {
            view = getInteractiveViewAt(event.clientX, event.clientY);
        }
        if (!view || !isViewDisplayed(view)) return null;

        this.activeView = view;
        withDisplayedCamera(view, () => {
            // The shared handles were last scaled by whichever view rendered last.
            // Pick against this view's scale and displayed projection, including
            // video zoom/pan and letterboxing in the look view.
            this.updateHandleScales(view);
            this.group.updateMatrixWorld(true);
            setRaycasterFromView(this.raycaster, view, event.clientX, event.clientY);
        });
        return view;
    },

    setupEventListeners() {
        this.unregisterInteraction = registerEditorInteraction(this, {
            pick: e => {
                if (!this.setupRaycasterForEvent(e)) return null;
                const handles = [...this.controlPoints, ...this.rotationHandles,
                    this.roofCenterHandle, this.rooflineHandle].filter(Boolean);
                const hit = this.raycaster.intersectObjects(handles, false)[0];
                if (hit) return {distance: hit.distance, handle: hit.object};
                const mask = this.raycaster.layers.mask;
                this.raycaster.layers.mask = LAYER.MASK_MAIN | LAYER.MASK_LOOK;
                const body = this.solidMesh && this.raycaster.intersectObject(this.solidMesh, false)[0];
                this.raycaster.layers.mask = mask;
                return body ? {distance: body.distance, priority: 40} : null;
            },
            rollback: e => {
                if (this.duplicationSource) {
                    const source = this.duplicationSource;
                    this.duplicationSource = null;
                    this.stateBeforeDrag = null;
                    this.isDragging = this.isRotating = false;
                    Synth3DManager.removeBuilding(this.buildingID);
                    source.setEditMode(true);
                } else {
                    const before = this.stateBeforeDrag;
                    this.stateBeforeDrag = null;
                    if (before) this.restoreState(before);
                    this.isRotating = false;
                    this.onPointerUp(e);
                }
            },
            redirect: e => {
                if (!e.altKey) return null;
                const copy = this.duplicate(false);
                if (copy) copy.duplicationSource = this;
                copy?.setEditMode(true);
                copy?.group.updateMatrixWorld(true);
                return copy;
            },
        });

        // EITHER ground a building can stand on can move underneath it, and the
        // answer to both is the same: put the building back on it.
        //  - "elevationChanged" is the elevation map (flat-elevation toggle,
        //    resolution change, quality preset).
        //  - "visibleGroundChanged" is the Google 3D tile surface, which is the
        //    VISIBLE ground whenever those tiles are what's rendered. Raised when a
        //    tileset settles and when the tiles are toggled on or off. Both matter:
        //    not one tile has streamed in at the moment a saved sitch deserializes,
        //    so the first snap can only reach the elevation map — 1.7-2.3 m away in
        //    the Arizona test sitch, most of a small building's height.
        const onGroundMoved = () => {
            // Stale listener belonging to a disposed building. Returning true is how
            // CEventManager unregisters a callback; an id check alone would not do,
            // because a later building can be created under the same id and would
            // then keep every dead predecessor's listener alive and working.
            if (NodeMan.get(this.id, false) !== this) return true;
            // Don't fight a drag — it snaps each vertex as it moves. But a ground
            // move is a one-shot edge, so remember it: releasing the mouse without a
            // further move would otherwise leave the building on the old surface.
            if (this.isDragging || this.isRotating) {
                this.groundMovedDuringDrag = true;
                return;
            }
            this.resnapToGround();
        };
        EventManager.addEventListener("elevationChanged", onGroundMoved);
        EventManager.addEventListener("visibleGroundChanged", onGroundMoved);
    },

    /**
     * Put the building back on the ground after the ground itself moved, keeping its
     * footprint lat/lons and its heights.
     *
     * Refreshes in the same order as restoreState(), and for the same reason: the
     * editing handles are built FROM the vertices, so rebuilding the mesh without
     * rebuilding them would leave them metres from the building — and the next drag
     * picks its target by raycasting those handles, so it would edit the wrong thing.
     */
    resnapToGround() {
        this.recalculateVerticesFromTerrain();
        this.buildMesh();
        this.updateGUIControllers();
        if (this.editMode) this.createControlPoints();
        setRenderOne();
    },
    
    /**
     * Check if mouse is hovering over a handle and update cursor
     */
    checkHandleHover(event) {
        const view = this.setupRaycasterForEvent(event);
        if (!view) {
            // Not in view, reset cursor
            if (this.hoveredHandle) {
                document.body.style.cursor = 'default';
                this.hoveredHandle = null;
            }
            return;
        }
        
        // Check intersection with actual handles (control points + roof center handle + roofline handle)
        const allHandles = [...this.controlPoints];
        if (this.roofCenterHandle) {
            allHandles.push(this.roofCenterHandle);
        }
        if (this.rooflineHandle) {
            allHandles.push(this.rooflineHandle);
        }
        
        const intersects = this.raycaster.intersectObjects(allHandles, false);
        
        // Check intersection with rotation handles
        const rotationIntersects = this.rotationHandles.length > 0 
            ? this.raycaster.intersectObjects(this.rotationHandles, false) 
            : [];
        
        // If both sphere handle and disk intersect, prioritize the closest one to camera
        if (intersects.length > 0 && rotationIntersects.length > 0) {
            // Compare distances - use the closest
            if (intersects[0].distance < rotationIntersects[0].distance) {
                // Handle is closer - use it
                if (!this.hoveredHandle || this.hoveredHandle !== intersects[0].object) {
                    if (intersects[0].object.userData.isRoofCenter || intersects[0].object.userData.isRoofline) {
                        document.body.style.cursor = 'row-resize';
                    } else {
                        document.body.style.cursor = 'move';
                    }
                    this.hoveredHandle = intersects[0].object;
                }
            } else {
                // Rotation handle is closer - use it
                const rotationHandle = rotationIntersects[0].object;
                const intersectionPoint = rotationIntersects[0].point;
                const cornerVertexIndex = rotationHandle.userData.cornerVertexIndex;
                
                if (this.isOutsideHandleInPlane(cornerVertexIndex, intersectionPoint)) {
                    if (!this.hoveredHandle || !this.hoveredHandle.userData || !this.hoveredHandle.userData.isRotationRing) {
                        document.body.style.cursor = 'grab';
                        this.hoveredHandle = {userData: {isRotationRing: true, cornerVertexIndex: cornerVertexIndex}};
                    }
                } else {
                    this.checkBuildingMeshHover();
                }
            }
        } else if (intersects.length > 0) {
            // Only handle intersect
            if (!this.hoveredHandle || this.hoveredHandle !== intersects[0].object) {
                if (intersects[0].object.userData.isRoofCenter || intersects[0].object.userData.isRoofline) {
                    document.body.style.cursor = 'row-resize';
                } else {
                    document.body.style.cursor = 'move';
                }
                this.hoveredHandle = intersects[0].object;
            }
        } else if (rotationIntersects.length > 0) {
            // Only rotation handle intersect
            const rotationHandle = rotationIntersects[0].object;
            const intersectionPoint = rotationIntersects[0].point;
            const cornerVertexIndex = rotationHandle.userData.cornerVertexIndex;
            
            if (this.isOutsideHandleInPlane(cornerVertexIndex, intersectionPoint)) {
                if (!this.hoveredHandle || !this.hoveredHandle.userData || !this.hoveredHandle.userData.isRotationRing) {
                    document.body.style.cursor = 'grab';
                    this.hoveredHandle = {userData: {isRotationRing: true, cornerVertexIndex: cornerVertexIndex}};
                }
            } else {
                this.checkBuildingMeshHover();
            }
        } else {
            // No intersections - check building mesh
            this.checkBuildingMeshHover();
        }
    },
    
    /**
     * Project intersection point onto the plane defined by corner and its neighbors,
     * then check if projected distance exceeds the visible handle radius
     * AND if the intersection is on the outward side (away from building center)
     */
    isOutsideHandleInPlane(cornerVertexIndex, intersectionPoint) {
        const cornerVertex = this.vertices[cornerVertexIndex];
        const cornerPosition = cornerVertex.position;
        
        // Get the two neighbor vertices (prev and next in the ring)
        const prevVertex = this.vertices[cornerVertex.prev];
        const nextVertex = this.vertices[cornerVertex.next];
        
        // Define a plane using corner and its two neighbors
        // Calculate two edge vectors
        const toPrev = prevVertex.position.clone().sub(cornerPosition);
        const toNext = nextVertex.position.clone().sub(cornerPosition);
        
        // Plane normal is the cross product of the two edges
        const planeNormal = new Vector3().crossVectors(toPrev, toNext).normalize();
        
        // Project intersection point onto this plane
        const toIntersection = intersectionPoint.clone().sub(cornerPosition);
        const distanceToPlane = toIntersection.dot(planeNormal);
        const projectedPoint = intersectionPoint.clone().sub(planeNormal.multiplyScalar(distanceToPlane));
        
        // Calculate distance from corner to projected point
        const projectedDistance = projectedPoint.distanceTo(cornerPosition);
        
        // setupRaycasterForEvent has already scaled the sphere for the active
        // view. Use that radius so rotation starts outside the visible handle.
        const handle = this.controlPoints.find(point => point.userData.vertexIndex === cornerVertexIndex);
        const handleRadius = handle ? (handle.userData.handleRadius ?? handle.geometry.parameters.radius) * handle.scale.x : 3;
        if (projectedDistance <= handleRadius) return false;
        
        // Additional check: only detect rotation if clicking on the "outward" side
        // X = projectedPoint (collision point on disk)
        // A = cornerPosition (center of disk)
        // F = buildingCentroid (center of floor)
        // Only allow rotation if F->A is within 45° of A->X
        if (this.buildingCentroid) {
            const fromCenterToCorner = cornerPosition.clone().sub(this.buildingCentroid).normalize(); // F->A
            const fromCornerToClick = projectedPoint.clone().sub(cornerPosition).normalize(); // A->X
            
            // Dot product > cos(45°) means angle < 45°
            // cos(45°) = √2/2 ≈ 0.707
            const dotProduct = fromCenterToCorner.dot(fromCornerToClick);
            if (dotProduct <= Math.SQRT1_2) { // Math.SQRT1_2 = 1/√2 = cos(45°)
                return false; // Click is not aligned enough with outward direction
            }
        }
        
        return true;
    },
    
    /**
     * Check if hovering over the building mesh for translation
     */
    checkBuildingMeshHover() {
        if (this.solidMesh) {
            // Temporarily change raycaster layer mask to include mesh layers
            const savedMask = this.raycaster.layers.mask;
            this.raycaster.layers.mask = LAYER.MASK_MAIN | LAYER.MASK_LOOK;
            
            const intersects = this.raycaster.intersectObject(this.solidMesh, false);
            
            // Restore raycaster layer mask
            this.raycaster.layers.mask = savedMask;
            
            if (intersects.length > 0) {
                // Hovering over building mesh - show move cursor
                if (!this.hoveredHandle || !this.hoveredHandle.userData || !this.hoveredHandle.userData.isBuildingMesh) {
                    document.body.style.cursor = 'move';
                    this.hoveredHandle = {userData: {isBuildingMesh: true}};
                }
            } else {
                // Not hovering over anything
                if (this.hoveredHandle) {
                    document.body.style.cursor = 'default';
                    this.hoveredHandle = null;
                }
            }
        } else {
            // Not hovering over anything
            if (this.hoveredHandle) {
                document.body.style.cursor = 'default';
                this.hoveredHandle = null;
            }
        }
    },
    
    /**
     * Handle pointer down - start dragging a control point
     */
    onPointerDown(event) {
        if (!this.editMode) {
            return;
        }
        if (event.button !== 0) return; // Only left mouse button
        
        // Check if clicking on a GUI element - menus should have priority
        let target = event.target;
        while (target) {
            if (target.classList && target.classList.contains('lil-gui')) {
                return; // Click is on GUI, don't handle it
            }
            target = target.parentElement;
        }
        
        const view = this.setupRaycasterForEvent(event);
        if (!view) {
            return;
        }
        
        // Capture state before any drag operation begins (for undo/redo)
        this.stateBeforeDrag = this.captureState();
        
        // Check intersection with actual handles (control points + roof center handle + roofline handle)
        const allHandles = [...this.controlPoints];
        if (this.roofCenterHandle) {
            allHandles.push(this.roofCenterHandle);
        }
        if (this.rooflineHandle) {
            allHandles.push(this.rooflineHandle);
        }
        const intersects = this.raycaster.intersectObjects(allHandles, false);
        
        // Check for rotation ring intersections
        const rotationIntersects = this.rotationHandles.length > 0 
            ? this.raycaster.intersectObjects(this.rotationHandles, false)
            : [];

        // If both sphere handle and disk intersect, prioritize the closest one to camera
        let useHandle = false;
        let useRotation = false;
        
        if (intersects.length > 0 && rotationIntersects.length > 0) {
            // Compare distances - use the closest
            if (intersects[0].distance < rotationIntersects[0].distance) {
                useHandle = true;
            } else {
                useRotation = true;
            }
        } else if (intersects.length > 0) {
            useHandle = true;
        } else if (rotationIntersects.length > 0) {
            useRotation = true;
        }

        if (useHandle) {
            // Hit an actual handle
            this.draggingPoint = intersects[0].object;
            this.draggingVertexIndex = this.draggingPoint.userData.vertexIndex;
            this.isDragging = true;
            this.isRotating = false;
            

            // Store the initial position of the handle for relative dragging
            this.dragInitialHandlePosition = this.draggingPoint.position.clone();
            
            // Store the local up vector at this position
            this.dragLocalUp = getLocalUpVector(this.draggingPoint.position);
            
            // Calculate and store the initial intersection point on the appropriate plane
            const isRoofCenter = this.draggingPoint.userData.isRoofCenter;
            const isRoofline = this.draggingPoint.userData.isRoofline;
            const draggedVertex = (isRoofCenter || isRoofline) ? null : this.vertices[this.draggingVertexIndex];
            const isTopVertex = !isRoofCenter && !isRoofline && (draggedVertex && draggedVertex.type === 'top');
            
            let plane = new Plane();
            if (isRoofCenter || isTopVertex || isRoofline) {
                // Create a vertical plane facing the camera for height adjustment
                const cameraPos = this.raycaster.ray.origin;
                const toCamera = cameraPos.clone().sub(this.draggingPoint.position).normalize();
                const tangent = new Vector3().crossVectors(this.dragLocalUp, toCamera).normalize();
                const planeNormal = new Vector3().crossVectors(tangent, this.dragLocalUp).normalize();
                plane.setFromNormalAndCoplanarPoint(planeNormal, this.draggingPoint.position);
            } else {
                // Create a horizontal plane for bottom vertices
                plane.setFromNormalAndCoplanarPoint(this.dragLocalUp, this.draggingPoint.position);
            }
            
            // Store the initial intersection point
            this.dragInitialIntersection = new Vector3();
            this.raycaster.ray.intersectPlane(plane, this.dragInitialIntersection);

            event.stopPropagation();
            event.preventDefault();
            return; // Don't check rotation rings
        }
        
        // Check for rotation ring click
        if (useRotation) {
            
            if (rotationIntersects.length > 0) {
                // Get the closest rotation ring
                const rotationHandle = rotationIntersects[0].object;
                const intersectionPoint = rotationIntersects[0].point;
                
                if (rotationHandle.userData.cornerVertexIndex !== undefined && this.buildingCentroid) {
                    // Corner rotation ring (for building rotation)
                    const cornerVertexIndex = rotationHandle.userData.cornerVertexIndex;
                    
                    // Project intersection onto plane and check if outside handle radius
                    if (this.isOutsideHandleInPlane(cornerVertexIndex, intersectionPoint)) {
                        this.isRotating = true;
                        this.isDragging = false;
                        // Start from the previously saved rotation (absolute angle from initial orientation)
                        this.totalRotationThisSession = Globals.settings?.lastBuildingRotation || 0;
                        
                        // Calculate initial angle in ground plane around building centroid
                        const localUp = getLocalUpVector(this.buildingCentroid);
                        const toIntersection = intersectionPoint.clone().sub(this.buildingCentroid);
                        const verticalComponent = toIntersection.dot(localUp);
                        const groundPoint = intersectionPoint.clone().sub(localUp.clone().multiplyScalar(verticalComponent));
                        
                        const toPoint = groundPoint.clone().sub(this.buildingCentroid);
                        // Use a reference axis perpendicular to localUp for angle calculation
                        const referenceAxis = new Vector3(1, 0, 0);
                        if (Math.abs(localUp.dot(referenceAxis)) > 0.9) {
                            referenceAxis.set(0, 1, 0); // Use Y if X is parallel to up
                        }
                        const tangent = new Vector3().crossVectors(localUp, referenceAxis).normalize();
                        this.rotationStartAngle = Math.atan2(
                            toPoint.dot(new Vector3().crossVectors(localUp, tangent)),
                            toPoint.dot(tangent)
                        );
                        
                        document.body.style.cursor = 'grabbing';

                        event.stopPropagation();
                        event.preventDefault();
                        return; // Don't check building mesh
                    }
                }
            }
        }
        
        // THIRD: Check for click on building mesh (for building translation)
        if (this.solidMesh) {
            // Temporarily change raycaster layer mask to include mesh layers
            const savedMask = this.raycaster.layers.mask;
            this.raycaster.layers.mask = LAYER.MASK_MAIN | LAYER.MASK_LOOK;
            
            const meshIntersects = this.raycaster.intersectObject(this.solidMesh, false);
            
            // Restore raycaster layer mask
            this.raycaster.layers.mask = savedMask;
            
            if (meshIntersects.length > 0) {
                this.isDragging = true;
                this.isRotating = false;
                this.draggingPoint = {userData: {isBuildingMesh: true}};
                this.draggingVertexIndex = -1;
                
                // Store the initial intersection point for translation
                this.dragStartPoint = meshIntersects[0].point.clone();
                
                document.body.style.cursor = 'move';

                event.stopPropagation();
                event.preventDefault();
            }
        }
    },
    
    /**
     * Handle rotation while dragging
     */
    handleRotation(event) {
        const view = this.setupRaycasterForEvent(event);
        if (!view || !this.buildingCentroid) return;
        
        // Create a ground plane at the building centroid
        const localUp = getLocalUpVector(this.buildingCentroid);
        const groundPlane = new Plane();
        groundPlane.setFromNormalAndCoplanarPoint(localUp, this.buildingCentroid);
        
        // Intersect ray with ground plane
        const intersectionPoint = new Vector3();
        if (this.raycaster.ray.intersectPlane(groundPlane, intersectionPoint)) {
            // Calculate current angle
            const toPoint = intersectionPoint.clone().sub(this.buildingCentroid);
            
            // Use same reference axis as in onPointerDown
            const referenceAxis = new Vector3(1, 0, 0);
            if (Math.abs(localUp.dot(referenceAxis)) > 0.9) {
                referenceAxis.set(0, 1, 0);
            }
            const tangent = new Vector3().crossVectors(localUp, referenceAxis).normalize();
            const currentAngle = Math.atan2(
                toPoint.dot(new Vector3().crossVectors(localUp, tangent)),
                toPoint.dot(tangent)
            );
            
            // Calculate rotation delta
            const rotationDelta = currentAngle - this.rotationStartAngle;
            
            // Accumulate total rotation for this session
            this.totalRotationThisSession += rotationDelta;
            
            // Rotate all vertices around the centroid
            this.vertices.forEach(vertex => {
                // Get vector from centroid to vertex
                const toVertex = vertex.position.clone().sub(this.buildingCentroid);
                
                // Decompose into vertical and horizontal components
                const verticalComponent = toVertex.dot(localUp);
                const horizontalVector = toVertex.clone().sub(localUp.clone().multiplyScalar(verticalComponent));
                
                // Rotate horizontal component around localUp axis
                const rotatedHorizontal = horizontalVector.clone().applyAxisAngle(localUp, rotationDelta);
                
                // Reconstruct position
                vertex.position.copy(
                    this.buildingCentroid.clone()
                        .add(rotatedHorizontal)
                        .add(localUp.clone().multiplyScalar(verticalComponent))
                );
            });
            
            // Update the start angle for next frame (incremental rotation)
            this.rotationStartAngle = currentAngle;
            
            // Snap ground vertices to terrain after rotation
            this.snapGroundVerticesToTerrain();
            
            // Reapply ridgeline inset to roofline vertices after rotation
            this.updateRooflineVertices();
            
            // Rebuild mesh
            this.buildMesh();
            
            // Sync parameters from the modified vertices
            this.syncParametersFromVertices();
            
            // Recreate control points
            this.createControlPoints();
            
            setRenderOne(true);
        }
        
        event.stopPropagation();
        event.preventDefault();
    },
    
    /**
     * Handle pointer move - drag the control point, rotate, or handle hover
     */
    onPointerMove(event) {
        if (!this.editMode) return;
        
        // Handle rotation
        if (this.isRotating) {
            this.handleRotation(event);
            return;
        }
        
        // Handle hover detection when not dragging
        if (!this.isDragging) {
            this.checkHandleHover(event);
            return;
        }
        
        if (!this.draggingPoint) return;
        
        const view = this.setupRaycasterForEvent(event);
        if (!view) return;
        
        // Check if dragging the roof center handle, roofline handle, or building mesh
        const isRoofCenter = this.draggingPoint.userData.isRoofCenter;
        const isRoofline = this.draggingPoint.userData.isRoofline;
        const isBuildingMesh = this.draggingPoint.userData.isBuildingMesh;
        
        // Get the vertex being dragged (if not roof center, roofline, or building mesh)
        const draggedVertex = (isRoofCenter || isRoofline || isBuildingMesh) ? null : this.vertices[this.draggingVertexIndex];
        const isTopVertex = !isRoofCenter && !isRoofline && !isBuildingMesh && (draggedVertex && draggedVertex.type === 'top');
        
        let plane = new Plane();
        
        if (isBuildingMesh) {
            // For building mesh, create a horizontal plane for moving entire building
            const localUp = getLocalUpVector(this.buildingCentroid);
            plane.setFromNormalAndCoplanarPoint(localUp, this.dragStartPoint);
        } else if (isRoofCenter || isTopVertex || isRoofline) {
            // For roof center handle and top vertices, create a vertical plane facing the camera
            // This allows height adjustment while keeping horizontal position locked
            // Use the INITIAL handle position to create the plane for consistent relative dragging
            const cameraPos = this.raycaster.ray.origin;
            const toCamera = cameraPos.clone().sub(this.dragInitialHandlePosition).normalize();
            
            // Make plane perpendicular to camera view but parallel to localUp
            const tangent = new Vector3().crossVectors(this.dragLocalUp, toCamera).normalize();
            const planeNormal = new Vector3().crossVectors(tangent, this.dragLocalUp).normalize();
            
            plane.setFromNormalAndCoplanarPoint(planeNormal, this.dragInitialHandlePosition);
        } else {
            // For bottom vertices, create a horizontal plane (perpendicular to localUp)
            // Use the INITIAL handle position to create the plane for consistent relative dragging
            plane.setFromNormalAndCoplanarPoint(
                this.dragLocalUp,
                this.dragInitialHandlePosition
            );
        }
        
        // Intersect ray with plane to get current mouse position
        const currentIntersection = new Vector3();
        if (this.raycaster.ray.intersectPlane(plane, currentIntersection)) {
            let newPosition;
            
            if (isBuildingMesh) {
                // For building mesh: use incremental movement (already working correctly)
                // The plane is created at dragStartPoint and updated each frame
                newPosition = currentIntersection.clone();
                const displacement = newPosition.clone().sub(this.dragStartPoint);
                
                // Move all vertices by the same displacement
                this.vertices.forEach(vertex => {
                    vertex.position.add(displacement.clone());
                });
                
                // Update building centroid
                this.buildingCentroid.add(displacement);
                
                // Update drag start point for next frame (incremental translation)
                this.dragStartPoint.copy(newPosition);
                
                // Snap ground vertices to terrain after translation
                this.snapGroundVerticesToTerrain();
                
            } else {
                // For vertex/roof/roofline dragging: use relative displacement from initial click point
                const displacement = currentIntersection.clone().sub(this.dragInitialIntersection);
                newPosition = this.dragInitialHandlePosition.clone().add(displacement);
                
                if (isRoofline) {
                    // For roofline handle, calculate height ABOVE the roof edge (top vertices)
                    // Get the roof edge positions (midpoints between top vertices)
                    const top4 = this.vertices[4];
                    const top5 = this.vertices[5];
                    const top6 = this.vertices[6];
                    const top7 = this.vertices[7];
                    
                    const roof1EdgePos = top4.position.clone().add(top5.position).multiplyScalar(0.5);
                    const roof2EdgePos = top6.position.clone().add(top7.position).multiplyScalar(0.5);
                    
                    const localUp = getLocalUpVector(roof1EdgePos);
                    
                    // Calculate what the new height ABOVE THE ROOF EDGE would be
                    const toRoofline = newPosition.clone().sub(roof1EdgePos);
                    let newHeightAboveRoof = toRoofline.dot(localUp);
                    
                    // Don't let roofline go below the roof edge (minimum 0)
                    if (newHeightAboveRoof < 0) {
                        newHeightAboveRoof = 0;
                    }
                    
                    // Apply this HEIGHT ABOVE ROOF to both roofline vertices (roof1 and roof2)
                    const roof1 = this.vertices[8];
                    const roof2 = this.vertices[9];
                    
                    if (roof1 && roof1.type === 'roofline') {
                        const upVector1 = getLocalUpVector(roof1EdgePos);
                        roof1.position.copy(roof1EdgePos.clone().add(upVector1.multiplyScalar(newHeightAboveRoof)));
                    }
                    
                    if (roof2 && roof2.type === 'roofline') {
                        const upVector2 = getLocalUpVector(roof2EdgePos);
                        roof2.position.copy(roof2EdgePos.clone().add(upVector2.multiplyScalar(newHeightAboveRoof)));
                    }
                    
                } else if (isRoofCenter) {
                // For roof center handle, calculate the HEIGHT CHANGE from initial drag position
                // This maintains the height difference between roofline and top vertices
                
                // Get a reference bottom vertex
                const referenceBottomVertex = this.vertices.find(v => v.type === 'bottom');
                const bottomPos = referenceBottomVertex.position;
                const localUp = getLocalUpVector(bottomPos);
                
                // Calculate the initial height (where drag started)
                const toInitial = this.dragInitialHandlePosition.clone().sub(bottomPos);
                const initialHeight = toInitial.dot(localUp);
                
                // Calculate the new height (where handle is now)
                const toNew = newPosition.clone().sub(bottomPos);
                const newHeight = toNew.dot(localUp);
                
                // Calculate the HEIGHT CHANGE (delta) - only the movement from initial position
                const heightDelta = newHeight - initialHeight;
                
                // Minimum height of 0.01 meter for top vertices
                const minHeight = 0.01;
                
                // Get all top vertices
                const topVertices = this.vertices.filter(v => v.type === 'top');
                
                // Apply this HEIGHT CHANGE to all top vertices
                topVertices.forEach(topVertex => {
                    const linkedBottom = this.vertices[topVertex.linkedVertex];
                    const upVector = getLocalUpVector(linkedBottom.position);
                    
                    // Get current height
                    const currentHeight = topVertex.position.clone().sub(linkedBottom.position).dot(upVector);
                    let adjustedHeight = currentHeight + heightDelta;
                    
                    // Don't go below minimum
                    if (adjustedHeight < minHeight) {
                        adjustedHeight = minHeight;
                    }
                    
                    // Position this top vertex directly above its bottom at adjusted height
                    topVertex.position.copy(linkedBottom.position.clone().add(upVector.multiplyScalar(adjustedHeight)));
                });
                
                // Apply the same HEIGHT CHANGE to roofline vertices (roof1 and roof2)
                // Roofline is relative to roof edge (top vertices), not ground
                const roof1 = this.vertices[8];
                const roof2 = this.vertices[9];
                
                if (roof1 && roof1.type === 'roofline') {
                    // roof1 is at midpoint between top vertices 4 and 5
                    const roof1EdgePos = this.vertices[4].position.clone().add(this.vertices[5].position).multiplyScalar(0.5);
                    const upVector1 = getLocalUpVector(roof1EdgePos);
                    
                    // Get current roofline height ABOVE roof edge
                    const currentRoofHeightAboveEdge = roof1.position.clone().sub(roof1EdgePos).dot(upVector1);
                    const adjustedRoofHeight = currentRoofHeightAboveEdge + heightDelta;
                    
                    roof1.position.copy(roof1EdgePos.clone().add(upVector1.multiplyScalar(adjustedRoofHeight)));
                }
                
                if (roof2 && roof2.type === 'roofline') {
                    // roof2 is at midpoint between top vertices 6 and 7
                    const roof2EdgePos = this.vertices[6].position.clone().add(this.vertices[7].position).multiplyScalar(0.5);
                    const upVector2 = getLocalUpVector(roof2EdgePos);
                    
                    // Get current roofline height ABOVE roof edge
                    const currentRoofHeightAboveEdge = roof2.position.clone().sub(roof2EdgePos).dot(upVector2);
                    const adjustedRoofHeight = currentRoofHeightAboveEdge + heightDelta;
                    
                    roof2.position.copy(roof2EdgePos.clone().add(upVector2.multiplyScalar(adjustedRoofHeight)));
                }
                
            } else if (isTopVertex) {
                // For top vertices, calculate the new HEIGHT and apply to that top only
                // NOT USED?

                    assert(0, "Top vertex dragging is currently disabled in favor of roof center handle.");
                // Get the linked bottom vertex
                // const referenceBottomVertex = this.vertices[draggedVertex.linkedVertex];
                // const bottomPos = referenceBottomVertex.position;
                // const localUp = getLocalUpVector(bottomPos);
                //
                // // Calculate what the new height would be
                // const toTop = newPosition.clone().sub(bottomPos);
                // let newHeight = toTop.dot(localUp);
                //
                // // Minimum height of 0.01 meter
                // const minHeight = 0.01;
                // if (newHeight < minHeight) {
                //     newHeight = minHeight;
                // }
                //
                // // Apply this HEIGHT to this top vertex only
                // const upVector = getLocalUpVector(bottomPos);
                // draggedVertex.position.copy(bottomPos.clone().add(upVector.multiplyScalar(newHeight)));
                
            } else {
                // For bottom vertices, move the vertex and its two neighbors horizontally only
                // (no vertical movement), then snap to terrain
                
                // Store the original position before moving
                const oldPosition = draggedVertex.position.clone();
                
                // Calculate the horizontal displacement vector (project onto horizontal plane)
                // Remove any component parallel to localUp
                const localUp = getLocalUpVector(oldPosition);
                const rawDisplacement = newPosition.clone().sub(oldPosition);
                const verticalComponent = rawDisplacement.dot(localUp);
                const horizontalDisplacement = rawDisplacement.clone().sub(localUp.clone().multiplyScalar(verticalComponent));
                
                // Calculate new horizontal position
                const newHorizontalPos = oldPosition.clone().add(horizontalDisplacement);
                
                // Snap to the visible ground (the 3D tile surface when those tiles
                // are what's rendered) — pass directly without lifting to avoid
                // lat/lon drift on ellipsoid (non-raycast path only needs lat/lon)
                const terrainPoint = getVisiblePointBelow(newHorizontalPos);
                
                // Move the dragged vertex to the terrain position
                draggedVertex.position.copy(terrainPoint);
                
                // Calculate the horizontal displacement (for neighbors)
                const displacement = terrainPoint.clone().sub(oldPosition);
                const horizontalDisp = displacement.clone().sub(localUp.clone().multiplyScalar(displacement.dot(localUp)));
                
                // Find the two neighbors using the ring structure
                const neighbor1Idx = draggedVertex.next;
                const neighbor2Idx = draggedVertex.prev;
                const neighbor1 = this.vertices[neighbor1Idx];
                const neighbor2 = this.vertices[neighbor2Idx];
                
                // Find the opposite corner (the vertex that's not this one or the neighbors)
                // For a rectangle, bottom vertices are indices 0-3
                let oppositeIdx = -1;
                for (let i = 0; i < 4; i++) {
                    if (i !== this.draggingVertexIndex && i !== neighbor1Idx && i !== neighbor2Idx) {
                        oppositeIdx = i;
                        break;
                    }
                }
                
                if (oppositeIdx !== -1) {
                    const opposite = this.vertices[oppositeIdx];
                    
                    // Move neighbor1: project A's displacement onto the HORIZONTAL edge connecting opposite to neighbor1
                    // First, project the 3D edge onto the horizontal plane
                    const edgeToNeighbor1_3D = neighbor1.position.clone().sub(opposite.position);
                    const verticalComp1 = edgeToNeighbor1_3D.dot(localUp);
                    const edgeToNeighbor1_Horizontal = edgeToNeighbor1_3D.clone().sub(localUp.clone().multiplyScalar(verticalComp1));
                    const edgeDir1 = edgeToNeighbor1_Horizontal.clone().normalize();
                    
                    // Now project the horizontal displacement onto the horizontal edge direction
                    const projectedMovement1 = horizontalDisp.dot(edgeDir1);
                    const neighbor1NewPos = neighbor1.position.clone().add(edgeDir1.multiplyScalar(projectedMovement1));
                    
                    // Snap neighbor1 to the visible ground (no lift — avoids ellipsoid lat/lon drift)
                    neighbor1.position.copy(getVisiblePointBelow(neighbor1NewPos));
                    
                    // Update the linked top vertex for neighbor1
                    const linkedTop1 = this.vertices[neighbor1.linkedVertex];
                    const localUp1 = getLocalUpVector(neighbor1.position);
                    const toTop1 = linkedTop1.position.clone().sub(neighbor1.position);
                    const currentHeight1 = toTop1.dot(localUp1);
                    linkedTop1.position.copy(neighbor1.position.clone().add(localUp1.multiplyScalar(currentHeight1)));
                    
                    // Move neighbor2: project A's displacement onto the HORIZONTAL edge connecting opposite to neighbor2
                    // First, project the 3D edge onto the horizontal plane
                    const edgeToNeighbor2_3D = neighbor2.position.clone().sub(opposite.position);
                    const verticalComp2 = edgeToNeighbor2_3D.dot(localUp);
                    const edgeToNeighbor2_Horizontal = edgeToNeighbor2_3D.clone().sub(localUp.clone().multiplyScalar(verticalComp2));
                    const edgeDir2 = edgeToNeighbor2_Horizontal.clone().normalize();
                    
                    // Now project the horizontal displacement onto the horizontal edge direction
                    const projectedMovement2 = horizontalDisp.dot(edgeDir2);
                    const neighbor2NewPos = neighbor2.position.clone().add(edgeDir2.multiplyScalar(projectedMovement2));
                    
                    // Snap neighbor2 to the visible ground (no lift — avoids ellipsoid lat/lon drift)
                    neighbor2.position.copy(getVisiblePointBelow(neighbor2NewPos));
                    
                    // Update the linked top vertex for neighbor2
                    const linkedTop2 = this.vertices[neighbor2.linkedVertex];
                    const localUp2 = getLocalUpVector(neighbor2.position);
                    const toTop2 = linkedTop2.position.clone().sub(neighbor2.position);
                    const currentHeight2 = toTop2.dot(localUp2);
                    linkedTop2.position.copy(neighbor2.position.clone().add(localUp2.multiplyScalar(currentHeight2)));
                }
                
                // Move the linked top vertex for the dragged vertex to stay directly above
                const linkedTop = this.vertices[draggedVertex.linkedVertex];
                const dragLocalUp = getLocalUpVector(draggedVertex.position);
                
                // Calculate current height of the linked top
                const toTop = linkedTop.position.clone().sub(draggedVertex.position);
                const currentHeight = toTop.dot(dragLocalUp);
                
                // Reposition top to maintain its height above the new bottom position
                linkedTop.position.copy(draggedVertex.position.clone().add(dragLocalUp.multiplyScalar(currentHeight)));
                
                // Update roofline vertices to stay at midpoint between TOP vertices (roof edge)
                const roof1 = this.vertices[8];
                const roof2 = this.vertices[9];
                
                if (roof1 && roof1.type === 'roofline' && roof2 && roof2.type === 'roofline') {
                    // Get current roofline height ABOVE the roof edge (top vertices)
                    const currentRoof1EdgePos = this.vertices[4].position.clone().add(this.vertices[5].position).multiplyScalar(0.5);
                    const currentRoof1HeightAboveRoof = roof1.position.clone().sub(currentRoof1EdgePos).dot(getLocalUpVector(currentRoof1EdgePos));
                    
                    // Update roof1 position (at midpoint between top vertices 4 and 5)
                    const newRoof1EdgePos = this.vertices[4].position.clone().add(this.vertices[5].position).multiplyScalar(0.5);
                    const newRoof2EdgePos = this.vertices[6].position.clone().add(this.vertices[7].position).multiplyScalar(0.5);
                    const upVector1 = getLocalUpVector(newRoof1EdgePos);
                    roof1.position.copy(newRoof1EdgePos.clone().add(upVector1.multiplyScalar(currentRoof1HeightAboveRoof)));
                    
                    // Update roof2 position (at midpoint between top vertices 6 and 7)
                    const upVector2 = getLocalUpVector(newRoof2EdgePos);
                    roof2.position.copy(newRoof2EdgePos.clone().add(upVector2.multiplyScalar(currentRoof1HeightAboveRoof)));
                }
                }
            }
            
            // Rebuild mesh (for all drag types)
            this.buildMesh();
            
            // Sync parameters from the modified vertices
            this.syncParametersFromVertices();
            
            // Update GUI controllers to reflect new values
            this.updateGUIControllers();
            
            // Recreate control points to update their positions
            this.createControlPoints();
            
            // Re-identify the dragging point and update initial positions for next frame
            if (isBuildingMesh) {
                // Keep the fake dragging point for building mesh
                this.draggingPoint = {userData: {isBuildingMesh: true}};
            } else if (isRoofCenter) {
                this.draggingPoint = this.roofCenterHandle;
                // Update the initial position, intersection, and local up for next frame (incremental dragging)
                this.dragInitialHandlePosition.copy(this.roofCenterHandle.position);
                this.dragInitialIntersection.copy(currentIntersection);
                this.dragLocalUp = getLocalUpVector(this.dragInitialHandlePosition);
            } else if (isRoofline) {
                this.draggingPoint = this.rooflineHandle;
                // Update the initial position, intersection, and local up for next frame (incremental dragging)
                this.dragInitialHandlePosition.copy(this.rooflineHandle.position);
                this.dragInitialIntersection.copy(currentIntersection);
                this.dragLocalUp = getLocalUpVector(this.dragInitialHandlePosition);
            } else {
                this.draggingPoint = this.controlPoints[this.draggingVertexIndex];
                // Update the initial position, intersection, and local up for next frame (incremental dragging)
                this.dragInitialHandlePosition.copy(this.draggingPoint.position);
                this.dragInitialIntersection.copy(currentIntersection);
                this.dragLocalUp = getLocalUpVector(this.dragInitialHandlePosition);
            }
            
            setRenderOne(true);
        }
        
        event.stopPropagation();
        event.preventDefault();
    },
    
    /**
     * Handle pointer up - stop dragging or rotating
     */
    onPointerUp(event) {
        if (this.isDragging || this.isRotating) {
            
            // Create undo action if we have a state before drag and UndoManager is available
            if (!this.duplicationSource && this.stateBeforeDrag && UndoManager) {
                const stateAfterDrag = this.captureState();
                const stateBefore = this.stateBeforeDrag;
                
                // Only create undo if state actually changed
                const stateChanged = JSON.stringify(stateBefore) !== JSON.stringify(stateAfterDrag);
                
                if (stateChanged) {
                    const actionDescription = this.isRotating 
                        ? `Rotate building "${this.name}"` 
                        : `Edit building "${this.name}"`;
                    
                    UndoManager.add({
                        undo: () => {
                            this.restoreState(stateBefore);
                        },
                        redo: () => {
                            this.restoreState(stateAfterDrag);
                        },
                        description: actionDescription
                    });
                }
            }
            
            // Clear the stored state
            this.stateBeforeDrag = null;
        }
        
        if (this.duplicationSource) {
            const state = this.serialize();
            let id = this.buildingID;
            const name = this.duplicationSource.name;
            this.duplicationSource = null;
            UndoManager?.add({
                description: `Duplicate building "${name}"`,
                undo: () => Synth3DManager.removeBuilding(id),
                redo: () => { id = Synth3DManager.addBuilding(state).buildingID; },
            });
        }

        // If rotation just ended, save the absolute rotation angle to settings
        if (this.isRotating) {
            // Normalize rotation to 0-2π range
            let normalizedRotation = this.totalRotationThisSession % (2 * Math.PI);
            if (normalizedRotation < 0) {
                normalizedRotation += 2 * Math.PI;
            }
            
            // Update settings with the absolute rotation angle (invisibly persisted)
            Globals.settings.lastBuildingRotation = normalizedRotation;
            
            CustomManager.saveGlobalSettings();
            
            console.log(`Saved absolute building rotation: ${(normalizedRotation * 180 / Math.PI).toFixed(1)}°`);
        }
        
        this.isDragging = false;
        this.isRotating = false;
        this.draggingPoint = null;
        this.draggingVertexIndex = -1;
        this.dragLocalUp = null;
        this.activeView = null;

        // The ground moved while the drag was running, so the snap the drag was doing
        // was against a surface that no longer exists. Apply it now. Safe after the
        // undo capture above: that stores the footprint lat/lons and the heights, and
        // re-snapping only recomputes vertex positions from those.
        if (this.groundMovedDuringDrag) {
            this.groundMovedDuringDrag = false;
            this.resnapToGround();
        }

        // Check hover after releasing to update cursor appropriately
        if (this.editMode) {
            this.checkHandleHover(event);
        }
    },
};
