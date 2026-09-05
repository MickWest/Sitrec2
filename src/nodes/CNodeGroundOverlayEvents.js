/**
 * Pointer event + corner/lock-point solver methods for CNodeGroundOverlay.
 *
 * Split out of CNodeGroundOverlay.js to keep the overlay node focused on
 * material + tile mesh management. Covers:
 * - Pointer drag handling (onPointerDown/Move/Up, onContextMenu).
 * - Hit-testing for overlay handles and lock-point markers.
 * - Corner updates (updateCorner, updateBoundsFromCorners,
 *   updateCornerWithLockPoints).
 * - Lock-point solvers: 1/2/3-point cases, plus the general similarity and
 *   affine solves (solveLinearSystem, solveSimilarityTransform,
 *   solveAffineTransform, uvToWorldFromCorners, handleLockPointDrag).
 * - Handle scaling (updateHandleScales).
 *
 * Installed on CNodeGroundOverlay.prototype via Object.assign.
 */

import {Vector3} from "three";
import {NodeMan, setRenderOne, UndoManager} from "../Globals";
import {degrees, radians} from "../mathUtils";
import {ViewMan} from "../CViewManager";
import {mouseInRenderedView, getInteractiveViewAt, setRaycasterFromView} from "../ViewUtils";
import {ECEFToLLAVD_radii, LLAToECEF} from "../LLA-ECEF-ENU";
import * as LAYER from "../LayerMasks";
import {getPointBelow, pointAbove} from "../threeExt";
import {getLocalUpVector} from "../SphericalMath";

export const eventMethods = {
    onPointerDown(event) {
        if (!this.editMode) return;
        if (event.button !== 0) return;
        
        let target = event.target;
        while (target) {
            if (target.classList && target.classList.contains('lil-gui')) {
                return;
            }
            target = target.parentElement;
        }
        
        const view = ViewMan.get("mainView");
        if (!view || !mouseInRenderedView(view, event.clientX, event.clientY)) return;
        
        let handle = this.getHandleAtMouse(event.clientX, event.clientY);

        if (!handle) {
            const overlayHit = this.getOverlayAtMouse(event.clientX, event.clientY);
            if (overlayHit) {
                handle = {type: 'move'};
            }
        }

        // Lock point constraints disabled for now
        // if (handle && handle.type === 'corner' && this.lockPoints.length >= 3) {
        //     return;
        // }

        if (handle) {
            this.isDragging = true;
            this.draggingHandle = handle;
            this.stateBeforeDrag = this.captureState();

            if (handle.type === 'lockPoint') {
                // Store initial state for lock point dragging
                this.dragInitialLockPoints = this.lockPoints.map(lp => ({
                    uv: {u: lp.uv.u, v: lp.uv.v},
                    worldLLA: {lat: lp.worldLLA.lat, lon: lp.worldLLA.lon}
                }));
                if (this.freeTransform && this.corners) {
                    this.dragInitialCornersECEF = this.corners.map(c => LLAToECEF(c.lat, c.lon, 0));
                }
            }

            if (handle.type === 'corner' && this.lockPoints.length > 0) {
                // Store lock point data for constrained corner dragging
                this.dragInitialLockPoints = this.lockPoints.map(lp => ({
                    uv: {u: lp.uv.u, v: lp.uv.v},
                    worldLLA: {lat: lp.worldLLA.lat, lon: lp.worldLLA.lon},
                    worldECEF: LLAToECEF(lp.worldLLA.lat, lp.worldLLA.lon, 0)
                }));
                if (this.freeTransform && this.corners) {
                    this.dragInitialCornersECEF = this.corners.map(c => LLAToECEF(c.lat, c.lon, 0));
                }
            }

            if (handle.type === 'rotation' || handle.type === 'move') {
                this.dragInitialNorth = this.north;
                this.dragInitialSouth = this.south;
                this.dragInitialEast = this.east;
                this.dragInitialWest = this.west;
                this.dragInitialRotation = this.rotation;
                this.dragInitialLockPoints = this.lockPoints.map(lp => ({
                    uv: {u: lp.uv.u, v: lp.uv.v},
                    worldLLA: {lat: lp.worldLLA.lat, lon: lp.worldLLA.lon},
                    worldECEF: LLAToECEF(lp.worldLLA.lat, lp.worldLLA.lon, 0)
                }));
                if (this.freeTransform && this.corners) {
                    this.dragInitialCorners = this.corners.map(c => ({lat: c.lat, lon: c.lon}));
                    this.dragInitialCornersECEF = this.corners.map(c => LLAToECEF(c.lat, c.lon, 0));
                    this.dragCenterECEF = this.dragInitialCornersECEF.reduce(
                        (acc, p) => acc.add(p), new Vector3()
                    ).multiplyScalar(0.25);
                }

                setRaycasterFromView(this.raycaster, view, event.clientX, event.clientY);

                const savedMask = this.raycaster.layers.mask;
                this.raycaster.layers.mask = LAYER.MASK_MAIN | LAYER.MASK_LOOK;

                if (NodeMan.exists("TerrainModel")) {
                    const terrainNode = NodeMan.get("TerrainModel");
                    const intersect = terrainNode.getClosestIntersect(this.raycaster);
                    if (intersect) {
                        const lla = ECEFToLLAVD_radii(intersect.point);
                        this.dragInitialClickLat = lla.x;
                        this.dragInitialClickLon = lla.y;
                        this.dragInitialClickECEF = intersect.point.clone();
                        
                        if (this.freeTransform && this.dragCenterECEF) {
                            const up = getLocalUpVector(this.dragCenterECEF);
                            const toClick = intersect.point.clone().sub(this.dragCenterECEF);
                            const toClickFlat = toClick.clone().sub(up.clone().multiplyScalar(toClick.dot(up)));
                            this.dragInitialAngleECEF = Math.atan2(toClickFlat.z, toClickFlat.x);
                        } else {
                            const centerLat = (this.north + this.south) / 2;
                            const centerLon = (this.east + this.west) / 2;
                            this.dragInitialAngle = Math.atan2(lla.y - centerLon, lla.x - centerLat);
                        }
                    }
                }

                this.raycaster.layers.mask = savedMask;
            }

            if (view.controls) {
                view.controls.enabled = false;
            }

            event.stopPropagation();
            event.preventDefault();
        }
    },
    
    getOverlayAtMouse(mouseX, mouseY) {
        const view = getInteractiveViewAt(mouseX, mouseY, ["mainView"]);
        if (!view) return null;
        
        const corners = this.getCornerPositions();
        if (corners.length !== 4) return null;
        
        const terrainCorners = corners.map(c => {
            const groundPos = getPointBelow(c);
            return pointAbove(groundPos, 5);
        });
        
        setRaycasterFromView(this.raycaster, view, mouseX, mouseY);
        const ray = this.raycaster.ray;
        
        const target = new Vector3();
        const hit1 = ray.intersectTriangle(terrainCorners[0], terrainCorners[1], terrainCorners[2], false, target);
        if (hit1) {
            return {point: target.clone()};
        }
        
        const hit2 = ray.intersectTriangle(terrainCorners[0], terrainCorners[2], terrainCorners[3], false, target);
        if (hit2) {
            return {point: target.clone()};
        }
        
        return null;
    },
    
    getHandleAtMouse(mouseX, mouseY) {
        const view = getInteractiveViewAt(mouseX, mouseY, ["mainView"]);
        if (!view) return null;
        this.updateHandleScales(view);
        this.group.updateMatrixWorld(true);
        
        setRaycasterFromView(this.raycaster, view, mouseX, mouseY);

        const handles = [];
        this.cornerHandles.forEach((mesh, index) => {
            handles.push({mesh, type: 'corner', index});
        });
        if (this.rotationHandle) {
            handles.push({mesh: this.rotationHandle, type: 'rotation'});
        }
        this.lockPointHandles.forEach((mesh, index) => {
            handles.push({mesh, type: 'lockPoint', index});
        });
        
        let closest = null;
        let closestDist = Infinity;
        
        for (const h of handles) {
            const intersects = this.raycaster.intersectObject(h.mesh, false);
            if (intersects.length > 0 && intersects[0].distance < closestDist) {
                closestDist = intersects[0].distance;
                closest = h;
            }
        }
        
        return closest;
    },
    
    onPointerMove(event) {
        if (!this.editMode) return;

        const view = ViewMan.get("mainView");
        if (!view) return;

        if (this.isDragging && this.draggingHandle) {
            setRaycasterFromView(this.raycaster, view, event.clientX, event.clientY);

            if (NodeMan.exists("TerrainModel")) {
                const terrainNode = NodeMan.get("TerrainModel");

                // Temporarily change raycaster layer mask to intersect terrain
                const savedMask = this.raycaster.layers.mask;
                this.raycaster.layers.mask = LAYER.MASK_MAIN | LAYER.MASK_LOOK;

                const intersect = terrainNode.getClosestIntersect(this.raycaster);

                // Restore raycaster layer mask
                this.raycaster.layers.mask = savedMask;

                if (intersect) {
                    const lla = ECEFToLLAVD_radii(intersect.point);

                    if (this.draggingHandle.type === 'corner') {
                        this.updateCorner(this.draggingHandle.index, lla.x, lla.y);
                    } else if (this.draggingHandle.type === 'rotation') {
                        if (this.freeTransform && this.dragInitialCornersECEF && this.dragCenterECEF) {
                            const up = getLocalUpVector(this.dragCenterECEF);
                            const toMouse = intersect.point.clone().sub(this.dragCenterECEF);
                            const toMouseFlat = toMouse.clone().sub(up.clone().multiplyScalar(toMouse.dot(up)));
                            const currentAngle = Math.atan2(toMouseFlat.z, toMouseFlat.x);
                            const angleDelta = currentAngle - this.dragInitialAngleECEF;

                            this.corners = this.dragInitialCornersECEF.map(pos => {
                                const offset = pos.clone().sub(this.dragCenterECEF);
                                const rotatedOffset = offset.clone().applyAxisAngle(up, -angleDelta);
                                const rotatedPos = this.dragCenterECEF.clone().add(rotatedOffset);
                                const groundPos = getPointBelow(rotatedPos);
                                const finalLLA = ECEFToLLAVD_radii(groundPos);
                                return {lat: finalLLA.x, lon: finalLLA.y};
                            });
                            this._cachedHomography = null;
                            this.updateBoundsFromCorners();

                            // Rotate lock points around the same center
                            this.lockPoints = this.dragInitialLockPoints.map(lp => {
                                const lpWorld = LLAToECEF(lp.worldLLA.lat, lp.worldLLA.lon, 0);
                                const offset = lpWorld.clone().sub(this.dragCenterECEF);
                                const rotatedOffset = offset.clone().applyAxisAngle(up, -angleDelta);
                                const rotatedPos = this.dragCenterECEF.clone().add(rotatedOffset);
                                const groundPos = getPointBelow(rotatedPos);
                                const finalLLA = ECEFToLLAVD_radii(groundPos);
                                return {
                                    uv: {u: lp.uv.u, v: lp.uv.v},
                                    worldLLA: {lat: finalLLA.x, lon: finalLLA.y}
                                };
                            });
                            this.updateLockPointHandles();
                        } else {
                            const centerLat = (this.north + this.south) / 2;
                            const centerLon = (this.east + this.west) / 2;
                            const currentAngle = Math.atan2(lla.y - centerLon, lla.x - centerLat);
                            const angleDelta = currentAngle - this.dragInitialAngle;
                            this.rotation = this.dragInitialRotation - degrees(angleDelta);

                            // Rotate lock points around center
                            const centerECEF = LLAToECEF(centerLat, centerLon, 0);
                            const up = getLocalUpVector(centerECEF);
                            this.lockPoints = this.dragInitialLockPoints.map(lp => {
                                const lpWorld = lp.worldECEF.clone();
                                const offset = lpWorld.clone().sub(centerECEF);
                                const rotatedOffset = offset.clone().applyAxisAngle(up, angleDelta);
                                const rotatedPos = centerECEF.clone().add(rotatedOffset);
                                const groundPos = getPointBelow(rotatedPos);
                                const finalLLA = ECEFToLLAVD_radii(groundPos);
                                return {
                                    uv: {u: lp.uv.u, v: lp.uv.v},
                                    worldLLA: {lat: finalLLA.x, lon: finalLLA.y}
                                };
                            });
                            this.updateLockPointHandles();
                        }
                    } else if (this.draggingHandle.type === 'move') {
                        if (this.freeTransform && this.dragInitialCornersECEF && this.dragInitialClickECEF) {
                            const displacement = intersect.point.clone().sub(this.dragInitialClickECEF);

                            this.corners = this.dragInitialCornersECEF.map(pos => {
                                const movedPos = pos.clone().add(displacement);
                                const groundPos = getPointBelow(movedPos);
                                const finalLLA = ECEFToLLAVD_radii(groundPos);
                                return {lat: finalLLA.x, lon: finalLLA.y};
                            });
                            this._cachedHomography = null;
                            this.updateBoundsFromCorners();

                            // Move lock points by same displacement
                            this.lockPoints = this.dragInitialLockPoints.map(lp => {
                                const movedPos = lp.worldECEF.clone().add(displacement);
                                const groundPos = getPointBelow(movedPos);
                                const finalLLA = ECEFToLLAVD_radii(groundPos);
                                return {
                                    uv: {u: lp.uv.u, v: lp.uv.v},
                                    worldLLA: {lat: finalLLA.x, lon: finalLLA.y}
                                };
                            });
                            this.updateLockPointHandles();
                        } else {
                            const deltaLat = lla.x - this.dragInitialClickLat;
                            const deltaLon = lla.y - this.dragInitialClickLon;
                            this.north = this.dragInitialNorth + deltaLat;
                            this.south = this.dragInitialSouth + deltaLat;
                            this.east = this.dragInitialEast + deltaLon;
                            this.west = this.dragInitialWest + deltaLon;

                            // Move lock points by same delta
                            this.lockPoints = this.dragInitialLockPoints.map(lp => ({
                                uv: {u: lp.uv.u, v: lp.uv.v},
                                worldLLA: {
                                    lat: lp.worldLLA.lat + deltaLat,
                                    lon: lp.worldLLA.lon + deltaLon
                                }
                            }));
                            this.updateLockPointHandles();
                        }
                    } else if (this.draggingHandle.type === 'lockPoint') {
                        this.handleLockPointDrag(this.draggingHandle.index, lla.x, lla.y);
                    }

                    this.updateMesh();
                    this.updateGUIControllers();
                    setRenderOne(true);
                }
            }
        }
    },
    
    updateCorner(cornerIndex, lat, lon) {
        // Lock point constraints disabled for now
        // if (this.lockPoints.length > 0) {
        //     this.updateCornerWithLockPoints(cornerIndex, lat, lon);
        //     return;
        // }

        if (this.freeTransform && this.corners) {
            this.corners[cornerIndex] = {lat, lon};
            this._cachedHomography = null; // Invalidate homography cache
            this.updateBoundsFromCorners();
            return;
        }
        
        const corners = this.getCornerPositions();

        // Corner indices: 0=NW, 1=NE, 2=SE, 3=SW
        // Neighbors and opposite for each corner:
        const adjacency = [
            {prev: 3, next: 1, opposite: 2},  // 0 (NW): neighbors SW, NE; opposite SE
            {prev: 0, next: 2, opposite: 3},  // 1 (NE): neighbors NW, SE; opposite SW
            {prev: 1, next: 3, opposite: 0},  // 2 (SE): neighbors NE, SW; opposite NW
            {prev: 2, next: 0, opposite: 1},  // 3 (SW): neighbors SE, NW; opposite NE
        ];

        const {prev, next, opposite} = adjacency[cornerIndex];

        // The opposite corner stays fixed
        const fixedCorner = corners[opposite].clone();

        // New position for the dragged corner
        const newDraggedCorner = LLAToECEF(lat, lon, 0);

        // Calculate displacement of dragged corner
        const oldDraggedCorner = corners[cornerIndex];
        const displacement = newDraggedCorner.clone().sub(oldDraggedCorner);

        // Get local up vector for horizontal projection
        const centerECEF = fixedCorner.clone().add(newDraggedCorner).multiplyScalar(0.5);
        const localUp = getLocalUpVector(centerECEF);

        // Project displacement to horizontal plane
        const horizontalDisp = displacement.clone().sub(
            localUp.clone().multiplyScalar(displacement.dot(localUp))
        );

        // Move prev neighbor along edge from opposite to prev
        const edgeToPrev = corners[prev].clone().sub(fixedCorner);
        const edgeToPrevHoriz = edgeToPrev.clone().sub(
            localUp.clone().multiplyScalar(edgeToPrev.dot(localUp))
        );
        const edgeDirPrev = edgeToPrevHoriz.clone().normalize();
        const projPrev = horizontalDisp.dot(edgeDirPrev);
        const newPrevCorner = corners[prev].clone().add(edgeDirPrev.multiplyScalar(projPrev));

        // Move next neighbor along edge from opposite to next
        const edgeToNext = corners[next].clone().sub(fixedCorner);
        const edgeToNextHoriz = edgeToNext.clone().sub(
            localUp.clone().multiplyScalar(edgeToNext.dot(localUp))
        );
        const edgeDirNext = edgeToNextHoriz.clone().normalize();
        const projNext = horizontalDisp.dot(edgeDirNext);
        const newNextCorner = corners[next].clone().add(edgeDirNext.multiplyScalar(projNext));

        // Now we have 4 new corner positions in world space
        const newCorners = [];
        newCorners[cornerIndex] = newDraggedCorner;
        newCorners[opposite] = fixedCorner;
        newCorners[prev] = newPrevCorner;
        newCorners[next] = newNextCorner;

        // Calculate new center
        const newCenter = newCorners[0].clone()
            .add(newCorners[1])
            .add(newCorners[2])
            .add(newCorners[3])
            .multiplyScalar(0.25);

        // Unrotate corners around the new center to get the axis-aligned bounds
        const up = getLocalUpVector(newCenter);
        const rotationRad = radians(-this.rotation);

        const unrotatedCorners = newCorners.map(corner => {
            const offset = corner.clone().sub(newCenter);
            const unrotatedOffset = offset.clone().applyAxisAngle(up, rotationRad);
            return newCenter.clone().add(unrotatedOffset);
        });

        // Convert unrotated corners to lat/lon and extract bounds
        const llas = unrotatedCorners.map(c => ECEFToLLAVD_radii(c));

        // Find the bounds from unrotated corners
        const lats = llas.map(lla => lla.x);
        const lons = llas.map(lla => lla.y);

        this.north = Math.max(...lats);
        this.south = Math.min(...lats);
        this.east = Math.max(...lons);
        this.west = Math.min(...lons);
    },
    
    updateBoundsFromCorners() {
        if (!this.corners) return;
        const lats = this.corners.map(c => c.lat);
        const lons = this.corners.map(c => c.lon);
        this.north = Math.max(...lats);
        this.south = Math.min(...lats);
        this.east = Math.max(...lons);
        this.west = Math.min(...lons);
    },

    /**
     * Handle dragging a lock point to a new world position.
     * The lock point's UV stays fixed, but its world position changes.
     * Corners are recomputed to maintain all lock points' UV-to-world mappings.
     */
    handleLockPointDrag(lockPointIndex, newLat, newLon) {
        if (!this.freeTransform || !this.corners) {
            // Convert to free transform mode first
            this.corners = this.getCornerLLAs();
            this.freeTransform = true;
            this.rotation = 0;
        }

        // Update the dragged lock point's world position
        this.lockPoints[lockPointIndex].worldLLA = {lat: newLat, lon: newLon};

        // Recompute corners based on lock points
        this.solveCornersFromLockPoints();
        this.updateLockPointHandles();
    },

    /**
     * Solve for new corners given the current lock points.
     * Uses different strategies based on number of lock points.
     */
    solveCornersFromLockPoints() {
        if (this.lockPoints.length === 0) return;

        if (this.lockPoints.length === 3) {
            this.solveCornersFrom3LockPoints();
        } else if (this.lockPoints.length === 2) {
            this.solveCornersFrom2LockPoints();
        } else if (this.lockPoints.length === 1) {
            this.solveCornersFrom1LockPoint();
        }

        this._cachedHomography = null;
        this.updateBoundsFromCorners();
    },

    /**
     * With 3 lock points, we have 3 UV-to-world correspondences.
     * Combined with the quad constraint (4th corner derivable), this fully determines the corners.
     */
    solveCornersFrom3LockPoints() {
        // Convert lock points to ECEF for computation
        const lockECEF = this.lockPoints.map(lp => ({
            uv: lp.uv,
            world: LLAToECEF(lp.worldLLA.lat, lp.worldLLA.lon, 0)
        }));

        // UV corners: (0,0), (1,0), (1,1), (0,1) for NW, NE, SE, SW
        // We need to find 4 world positions that satisfy the 3 lock point constraints
        // and maintain quad shape (opposite edges parallel in UV space maps to parallelogram-ish in world)

        // Compute the homography from 3 points using a projective approach
        // Since we have 3 points, we can solve for an affine transform (6 DOF)
        // which maps UV to world (lon, lat proxy using local ECEF x, z)

        const uv1 = lockECEF[0].uv, w1 = lockECEF[0].world;
        const uv2 = lockECEF[1].uv, w2 = lockECEF[1].world;
        const uv3 = lockECEF[2].uv, w3 = lockECEF[2].world;

        // Solve affine transform: world = A * uv + b
        // Using 3 points gives us exactly 6 equations for 6 unknowns (a11, a12, a21, a22, bx, bz)
        // w.x = a11 * u + a12 * v + bx
        // w.z = a21 * u + a22 * v + bz

        // Set up matrix equation
        const matrix = [
            [uv1.u, uv1.v, 1, 0, 0, 0],
            [0, 0, 0, uv1.u, uv1.v, 1],
            [uv2.u, uv2.v, 1, 0, 0, 0],
            [0, 0, 0, uv2.u, uv2.v, 1],
            [uv3.u, uv3.v, 1, 0, 0, 0],
            [0, 0, 0, uv3.u, uv3.v, 1]
        ];
        const rhs = [w1.x, w1.z, w2.x, w2.z, w3.x, w3.z];

        const solution = this.solveLinearSystem(matrix, rhs);
        if (!solution) return;

        const [a11, a12, bx, a21, a22, bz] = solution;

        // Calculate corners using the affine transform
        const uvCorners = [
            {u: 0, v: 0},  // NW
            {u: 1, v: 0},  // NE
            {u: 1, v: 1},  // SE
            {u: 0, v: 1}   // SW
        ];

        // Get reference Y from first lock point (assumes flat ground)
        const refY = w1.y;

        this.corners = uvCorners.map(uv => {
            const x = a11 * uv.u + a12 * uv.v + bx;
            const z = a21 * uv.u + a22 * uv.v + bz;
            const worldPos = new Vector3(x, refY, z);
            const groundPos = getPointBelow(worldPos);
            const lla = ECEFToLLAVD_radii(groundPos);
            return {lat: lla.x, lon: lla.y};
        });
    },

    /**
     * With 2 lock points, the overlay can shear parallel to the lock point line
     * and scale perpendicular to it. Corner dragging will be constrained accordingly.
     */
    solveCornersFrom2LockPoints() {
        // Get the two lock points in ECEF
        const lp1 = this.lockPoints[0];
        const lp2 = this.lockPoints[1];
        const w1 = LLAToECEF(lp1.worldLLA.lat, lp1.worldLLA.lon, 0);
        const w2 = LLAToECEF(lp2.worldLLA.lat, lp2.worldLLA.lon, 0);

        // Direction from lock point 1 to 2 in both UV and world space
        const uvDir = {u: lp2.uv.u - lp1.uv.u, v: lp2.uv.v - lp1.uv.v};
        const worldDir = w2.clone().sub(w1);

        // Lengths
        const uvLen = Math.sqrt(uvDir.u * uvDir.u + uvDir.v * uvDir.v);
        const worldLen = worldDir.length();

        if (uvLen < 1e-10 || worldLen < 1e-10) return;

        // Scale factor from UV to world
        const scale = worldLen / uvLen;

        // Rotation: angle from UV direction to world direction (in horizontal plane)
        const uvAngle = Math.atan2(uvDir.v, uvDir.u);
        const worldAngle = Math.atan2(worldDir.z, worldDir.x);
        const rotAngle = worldAngle - uvAngle;

        // Build transformation: scale + rotate around uv1, then translate
        const cos = Math.cos(rotAngle);
        const sin = Math.sin(rotAngle);

        // Apply transform to UV corners
        const uvCorners = [
            {u: 0, v: 0},
            {u: 1, v: 0},
            {u: 1, v: 1},
            {u: 0, v: 1}
        ];

        const refY = w1.y;

        this.corners = uvCorners.map(uv => {
            // Translate to origin at lp1.uv
            const du = uv.u - lp1.uv.u;
            const dv = uv.v - lp1.uv.v;

            // Scale and rotate
            const x = (du * cos - dv * sin) * scale;
            const z = (du * sin + dv * cos) * scale;

            // Translate to world position of lp1
            const worldPos = new Vector3(w1.x + x, refY, w1.z + z);
            const groundPos = getPointBelow(worldPos);
            const lla = ECEFToLLAVD_radii(groundPos);
            return {lat: lla.x, lon: lla.y};
        });
    },

    /**
     * With 1 lock point, it acts as a pivot. Preserve relative positions from current corners.
     */
    solveCornersFrom1LockPoint() {
        const lp = this.lockPoints[0];
        const targetWorld = LLAToECEF(lp.worldLLA.lat, lp.worldLLA.lon, 0);

        // Calculate where the lock point currently maps to based on current corners
        const currentCorners = this.corners.map(c => LLAToECEF(c.lat, c.lon, 0));
        const currentWorld = this.uvToWorldFromCorners(lp.uv, currentCorners);

        // Displacement needed to move current mapping to target
        const displacement = targetWorld.clone().sub(currentWorld);

        // Move all corners by this displacement
        this.corners = currentCorners.map(pos => {
            const movedPos = pos.clone().add(displacement);
            const groundPos = getPointBelow(movedPos);
            const lla = ECEFToLLAVD_radii(groundPos);
            return {lat: lla.x, lon: lla.y};
        });
    },

    /**
     * Convert UV to world position using bilinear interpolation of corners.
     */
    uvToWorldFromCorners(uv, cornersECEF) {
        // Bilinear interpolation
        // corners: 0=NW(0,0), 1=NE(1,0), 2=SE(1,1), 3=SW(0,1)
        const u = uv.u, v = uv.v;
        const top = cornersECEF[0].clone().lerp(cornersECEF[1], u);
        const bottom = cornersECEF[3].clone().lerp(cornersECEF[2], u);
        return top.clone().lerp(bottom, v);
    },

    /**
     * Solve a linear system Ax = b using Gaussian elimination with partial pivoting.
     */
    solveLinearSystem(A, b) {
        const n = b.length;
        const aug = A.map((row, i) => [...row, b[i]]);

        for (let col = 0; col < n; col++) {
            // Find pivot
            let maxRow = col;
            for (let row = col + 1; row < n; row++) {
                if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) {
                    maxRow = row;
                }
            }
            [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

            if (Math.abs(aug[col][col]) < 1e-12) return null; // Singular

            // Eliminate below
            for (let row = col + 1; row < n; row++) {
                const factor = aug[row][col] / aug[col][col];
                for (let j = col; j <= n; j++) {
                    aug[row][j] -= factor * aug[col][j];
                }
            }
        }

        // Back substitution
        const x = new Array(n);
        for (let i = n - 1; i >= 0; i--) {
            x[i] = aug[i][n];
            for (let j = i + 1; j < n; j++) {
                x[i] -= aug[i][j] * x[j];
            }
            x[i] /= aug[i][i];
        }
        return x;
    },

    /**
     * Update a corner position while respecting lock point constraints.
     *
     * TRANSFORMATION-BASED APPROACH:
     * Instead of adjusting individual corners, we compute the transformation
     * that best maps all control points (lock points + dragged corner) from
     * UV space to world space, then apply it to all corner UVs.
     *
     * With 1 lock point + 1 dragged corner = 2 point correspondences:
     *   → Solve for SIMILARITY transform (rotation + uniform scale + translation)
     *
     * With 2 lock points + 1 dragged corner = 3 point correspondences:
     *   → Solve for AFFINE transform (can handle shear, non-uniform scale)
     */
    updateCornerWithLockPoints(cornerIndex, lat, lon) {
        // Ensure we're in free transform mode
        if (!this.freeTransform || !this.corners) {
            this.corners = this.getCornerLLAs();
            this.freeTransform = true;
            this.rotation = 0;
        }

        if (!this.dragInitialCornersECEF || !this.dragInitialLockPoints) {
            this.corners[cornerIndex] = {lat, lon};
            this._cachedHomography = null;
            this.updateBoundsFromCorners();
            return;
        }

        const newCornerWorld = LLAToECEF(lat, lon, 0);

        // Corner UVs: 0=NW(0,0), 1=NE(1,0), 2=SE(1,1), 3=SW(0,1)
        const cornerUVs = [
            {u: 0, v: 0},
            {u: 1, v: 0},
            {u: 1, v: 1},
            {u: 0, v: 1}
        ];

        // Build point correspondences: UV → World (using X-Z plane, Y=0)
        // Each correspondence: {u, v, x, z}
        const correspondences = [];

        // Add lock points as correspondences (these are fixed)
        for (const lp of this.dragInitialLockPoints) {
            const world = LLAToECEF(lp.worldLLA.lat, lp.worldLLA.lon, 0);
            correspondences.push({
                u: lp.uv.u,
                v: lp.uv.v,
                x: world.x,
                z: world.z
            });
        }

        // Add dragged corner as a correspondence
        const draggedUV = cornerUVs[cornerIndex];
        correspondences.push({
            u: draggedUV.u,
            v: draggedUV.v,
            x: newCornerWorld.x,
            z: newCornerWorld.z
        });

        // Solve for transformation based on number of correspondences
        let transform;
        if (correspondences.length === 2) {
            // 2 points → Similarity transform (4 DOF: a, b, tx, tz)
            // x' = a*u - b*v + tx
            // z' = b*u + a*v + tz
            transform = this.solveSimilarityTransform(correspondences);
        } else if (correspondences.length >= 3) {
            // 3+ points → Affine transform (6 DOF)
            // x' = a*u + b*v + tx
            // z' = c*u + d*v + tz
            transform = this.solveAffineTransform(correspondences);
        } else {
            // 1 point - just translation, not useful for corner drag
            this.corners[cornerIndex] = {lat, lon};
            this._cachedHomography = null;
            this.updateBoundsFromCorners();
            return;
        }

        if (!transform) {
            // Fallback if solve fails
            this.corners[cornerIndex] = {lat, lon};
            this._cachedHomography = null;
            this.updateBoundsFromCorners();
            return;
        }

        // Apply transformation to all 4 corner UVs to get new world positions
        const refY = this.dragInitialCornersECEF[0].y;
        this.corners = cornerUVs.map(uv => {
            const world = transform(uv.u, uv.v);
            const pos = new Vector3(world.x, refY, world.z);
            const groundPos = getPointBelow(pos);
            const lla = ECEFToLLAVD_radii(groundPos);
            return {lat: lla.x, lon: lla.y};
        });

        this._cachedHomography = null;
        this.updateBoundsFromCorners();
        this.updateLockPointHandles();
    },

    /**
     * Solve for similarity transform from 2 point correspondences.
     * Similarity = rotation + uniform scale + translation (4 DOF)
     *
     * Transform: x' = a*u - b*v + tx
     *            z' = b*u + a*v + tz
     *
     * Where a = s*cos(θ), b = s*sin(θ), s = scale, θ = rotation
     *
     * @returns {Function} transform(u, v) → {x, z}
     */
    solveSimilarityTransform(correspondences) {
        const p1 = correspondences[0];
        const p2 = correspondences[1];

        // Compute differences
        const du = p2.u - p1.u;
        const dv = p2.v - p1.v;
        const dx = p2.x - p1.x;
        const dz = p2.z - p1.z;

        // Solve 2x2 system:
        // [du  -dv] [a]   [dx]
        // [dv   du] [b] = [dz]
        const det = du * du + dv * dv;
        if (det < 1e-12) return null;

        const a = (du * dx + dv * dz) / det;
        const b = (du * dz - dv * dx) / det;

        // Compute translation using first point
        const tx = p1.x - a * p1.u + b * p1.v;
        const tz = p1.z - b * p1.u - a * p1.v;

        // Return transform function
        return (u, v) => ({
            x: a * u - b * v + tx,
            z: b * u + a * v + tz
        });
    },

    /**
     * Solve for affine transform from 3+ point correspondences.
     * Affine = scale (non-uniform) + rotation + shear + translation (6 DOF)
     *
     * Transform: x' = a*u + b*v + tx
     *            z' = c*u + d*v + tz
     *
     * @returns {Function} transform(u, v) → {x, z}
     */
    solveAffineTransform(correspondences) {
        // With exactly 3 points, we can solve directly
        // With more points, we'd use least squares (not implemented here)
        const p1 = correspondences[0];
        const p2 = correspondences[1];
        const p3 = correspondences[2];

        // Set up system: for each point, x = a*u + b*v + tx
        // Matrix form: [u1 v1 1] [a ]   [x1]
        //              [u2 v2 1] [b ] = [x2]
        //              [u3 v3 1] [tx]   [x3]
        // Same for z with unknowns c, d, tz

        const M = [
            [p1.u, p1.v, 1],
            [p2.u, p2.v, 1],
            [p3.u, p3.v, 1]
        ];

        const det = M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1])
                  - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0])
                  + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);

        if (Math.abs(det) < 1e-12) return null;

        // Compute inverse of M using cofactors
        const invDet = 1 / det;
        const Minv = [
            [
                (M[1][1] * M[2][2] - M[1][2] * M[2][1]) * invDet,
                (M[0][2] * M[2][1] - M[0][1] * M[2][2]) * invDet,
                (M[0][1] * M[1][2] - M[0][2] * M[1][1]) * invDet
            ],
            [
                (M[1][2] * M[2][0] - M[1][0] * M[2][2]) * invDet,
                (M[0][0] * M[2][2] - M[0][2] * M[2][0]) * invDet,
                (M[0][2] * M[1][0] - M[0][0] * M[1][2]) * invDet
            ],
            [
                (M[1][0] * M[2][1] - M[1][1] * M[2][0]) * invDet,
                (M[0][1] * M[2][0] - M[0][0] * M[2][1]) * invDet,
                (M[0][0] * M[1][1] - M[0][1] * M[1][0]) * invDet
            ]
        ];

        // Solve for x coefficients: [a, b, tx] = Minv * [x1, x2, x3]
        const xVec = [p1.x, p2.x, p3.x];
        const a  = Minv[0][0] * xVec[0] + Minv[0][1] * xVec[1] + Minv[0][2] * xVec[2];
        const b  = Minv[1][0] * xVec[0] + Minv[1][1] * xVec[1] + Minv[1][2] * xVec[2];
        const tx = Minv[2][0] * xVec[0] + Minv[2][1] * xVec[1] + Minv[2][2] * xVec[2];

        // Solve for z coefficients: [c, d, tz] = Minv * [z1, z2, z3]
        const zVec = [p1.z, p2.z, p3.z];
        const c  = Minv[0][0] * zVec[0] + Minv[0][1] * zVec[1] + Minv[0][2] * zVec[2];
        const d  = Minv[1][0] * zVec[0] + Minv[1][1] * zVec[1] + Minv[1][2] * zVec[2];
        const tz = Minv[2][0] * zVec[0] + Minv[2][1] * zVec[1] + Minv[2][2] * zVec[2];

        // Return transform function
        return (u, v) => ({
            x: a * u + b * v + tx,
            z: c * u + d * v + tz
        });
    },

    onPointerUp(event) {
        if (this.isDragging) {
            const view = ViewMan.get("mainView");
            if (view && view.controls) {
                view.controls.enabled = true;
            }
            
            if (this.stateBeforeDrag && UndoManager) {
                const stateAfterDrag = this.captureState();
                const stateBefore = this.stateBeforeDrag;
                const stateChanged = JSON.stringify(stateBefore) !== JSON.stringify(stateAfterDrag);
                
                if (stateChanged) {
                    const handleType = this.draggingHandle?.type || 'edit';
                    const actionDescription = handleType === 'rotation'
                        ? `Rotate ${this.kindName} "${this.name}"`
                        : handleType === 'move'
                        ? `Move ${this.kindName} "${this.name}"`
                        : `Resize ${this.kindName} "${this.name}"`;
                    
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
            
            this.stateBeforeDrag = null;
            this.isDragging = false;
            this.draggingHandle = null;
        }
    },
    
    onContextMenu(event) {
        if (!this.editMode) return;
        
        const view = ViewMan.get("mainView");
        if (!view || !mouseInRenderedView(view, event.clientX, event.clientY)) return;
        
        const overlayHit = this.getOverlayAtMouse(event.clientX, event.clientY);
        if (!overlayHit) return;
        
        event.preventDefault();
        event.stopPropagation();
        
        const hitLLA = ECEFToLLAVD_radii(overlayHit.point);
        const hitLat = hitLLA.x;
        const hitLon = hitLLA.y;
        
        if (event.altKey) {
            const lockPointIndex = this.getLockPointAtMouse(event.clientX, event.clientY);
            if (lockPointIndex !== -1) {
                this.lockPoints.splice(lockPointIndex, 1);
                this.updateLockPointHandles();
                setRenderOne(true);
            }
            return;
        }
        
        if (this.lockPoints.length >= 3) return;
        
        const uv = this.latLonToUV(hitLat, hitLon);
        if (!uv || uv.u < 0 || uv.u > 1 || uv.v < 0 || uv.v > 1) return;
        
        this.lockPoints.push({
            uv: {u: uv.u, v: uv.v},
            worldLLA: {lat: hitLat, lon: hitLon}
        });
        
        this.updateLockPointHandles();
        setRenderOne(true);
    },
    
    getLockPointAtMouse(mouseX, mouseY) {
        const view = getInteractiveViewAt(mouseX, mouseY, ["mainView"]);
        if (!view) return -1;
        this.updateHandleScales(view);
        this.group.updateMatrixWorld(true);
        
        setRaycasterFromView(this.raycaster, view, mouseX, mouseY);
        
        for (let i = 0; i < this.lockPointHandles.length; i++) {
            const handle = this.lockPointHandles[i];
            const intersects = this.raycaster.intersectObject(handle, false);
            if (intersects.length > 0) {
                return i;
            }
        }
        return -1;
    },
    
    updateHandleScales(view) {
        if (!this.editMode || !view || !view.pixelsToMeters) return;
        
        const handlePixelSize = 20;
        const worldPos = new Vector3();
        
        this.cornerHandles.forEach(handle => {
            handle.getWorldPosition(worldPos);
            const scale = view.pixelsToMeters(worldPos, handlePixelSize);
            handle.scale.set(scale / 3, scale / 3, scale / 3);
        });
        
        if (this.rotationHandle) {
            this.rotationHandle.getWorldPosition(worldPos);
            const scale = view.pixelsToMeters(worldPos, handlePixelSize);
            this.rotationHandle.scale.set(scale / 3, scale / 3, scale / 3);
        }
        
        this.lockPointHandles.forEach(handle => {
            handle.getWorldPosition(worldPos);
            const scale = view.pixelsToMeters(worldPos, handlePixelSize);
            handle.scale.set(scale / 3, scale / 3, scale / 3);
        });
    },
};
