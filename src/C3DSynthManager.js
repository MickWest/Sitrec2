// Manager for Synthetic 3D Objects (buildings, structures, etc.)
// Handles creation, editing, deletion, and persistence

import {CManager} from "./CManager";
import {CNodeSynthBuilding} from "./nodes/CNodeSynthBuilding";
import {Globals, NodeMan, setRenderOne} from "./Globals";
import {ViewMan} from "./CViewManager";
import {makeMouseRay} from "./mouseMoveView";
import {V3} from "./threeUtils";
import {getLocalUpVector} from "./SphericalMath";
import {Sphere, Vector3} from "three";
import {wgs84} from "./LLA-ECEF-ENU";

export class C3DSynthManager extends CManager {
    constructor() {
        super();
        this.nextBuildingID = 1;
        
        console.log("C3DSynthManager initialized");
    }
    
    /**
     * Add a new building
     */
    addBuilding(buildingData) {
        const id = buildingData.id || `synthBuilding_${this.nextBuildingID++}`;
        const building = new CNodeSynthBuilding({
            ...buildingData,
            id: id
        });
        
        // Note: CNodeSynthBuilding extends CNode, which automatically adds itself to NodeMan in its constructor
        
        // Add to manager using inherited CManager.add() method
        this.add(id, building);
        console.log(`Added building: ${id}`);
        setRenderOne(true);
        return building;
    }
    
    /**
     * Remove a building
     */
    removeBuilding(buildingID) {
        if (this.exists(buildingID)) {
            const building = this.get(buildingID);
            
            // First, exit edit mode if this building is being edited
            // This will clean up control points, handles, menu, and Globals.editingBuilding
            if (building.editMode || Globals.editingBuilding === building) {
                console.log(`  Exiting edit mode for building ${buildingID} before removal`);
                building.setEditMode(false);
            }
            
            // Use NodeMan.disposeRemove which handles both disposal and removal from NodeMan
            NodeMan.disposeRemove(building);
            
            // Remove from this manager using inherited method
            this.remove(buildingID);
            
            console.log(`Removed building: ${buildingID}`);
            setRenderOne(true);
        }
    }
    
    /**
     * Get a building by ID
     */
    getBuilding(buildingID) {
        return this.exists(buildingID) ? this.get(buildingID) : undefined;
    }
    
    /**
     * Create a 15x15x4 meter building centered at the given point
     * @param {Vector3} centerPoint - The center point on the ground (in EUS coordinates)
     * @returns {CNodeSynthBuilding} The created building
     */
    createBuildingAtPoint(centerPoint) {
        if (Globals.editingBuilding) {
            alert("Please exit edit mode before creating a new building");
            return null;
        }
        
        // Get local coordinate system at the center point
        const localUp = getLocalUpVector(centerPoint);
        
        // Create local north and east directions
        // East is perpendicular to up and points roughly eastward
        const east = new Vector3(1, 0, 0).cross(localUp).normalize();
        const north = new Vector3().crossVectors(localUp, east).normalize();
        
        // Apply saved rotation from last building (if any)
        const savedRotation = Globals.settings?.lastBuildingRotation || 0;
        if (savedRotation !== 0) {
            // Rotate the north and east vectors by the saved rotation
            // Note: Negated to match Three.js applyAxisAngle convention
            const angle = -savedRotation;
            const rotatedNorth = north.clone().multiplyScalar(Math.cos(angle))
                                     .add(east.clone().multiplyScalar(Math.sin(angle)));
            const rotatedEast = east.clone().multiplyScalar(Math.cos(angle))
                                    .sub(north.clone().multiplyScalar(Math.sin(angle)));
            
            north.copy(rotatedNorth.normalize());
            east.copy(rotatedEast.normalize());
            
            console.log(`Applied saved rotation to new building: ${(savedRotation * 180 / Math.PI).toFixed(1)}°`);
        }
        
        // Create a 15x15 meter footprint centered at the point
        const halfSize = 7.5; // Half of 15 meters
        const corners = [
            centerPoint.clone().add(north.clone().multiplyScalar(-halfSize))
                                .add(east.clone().multiplyScalar(-halfSize)),
            centerPoint.clone().add(north.clone().multiplyScalar(halfSize))
                                .add(east.clone().multiplyScalar(-halfSize)),
            centerPoint.clone().add(north.clone().multiplyScalar(halfSize))
                                .add(east.clone().multiplyScalar(halfSize)),
            centerPoint.clone().add(north.clone().multiplyScalar(-halfSize))
                                .add(east.clone().multiplyScalar(halfSize))
        ];
        
        // Create building with 4 meter height
        const building = this.addBuilding({
            footprint: corners,
            height: 4,
            name: `Building ${this.nextBuildingID}`
        });
        
        console.log(`Created building: ${building.buildingID} at center point`);
        return building;
    }
    
    /**
     * Get ground intersection point from mouse position
     */
    getGroundPoint(view, mouseX, mouseY) {
        const mouseYUp = view.heightPx - (mouseY - view.topPx);
        const mouseRay = makeMouseRay(view, mouseX, mouseYUp);
        
        view.raycaster.setFromCamera(mouseRay, view.camera);
        
        // Try to intersect with terrain first
        let closestPoint = V3();
        let found = false;
        
        if (NodeMan.exists("TerrainModel")) {
            const terrainNode = NodeMan.get("TerrainModel");
            const firstIntersect = terrainNode.getClosestIntersect(view.raycaster);
            if (firstIntersect) {
                closestPoint.copy(firstIntersect.point);
                found = true;
            }
        }
        
        // If terrain intersection found, return it
        if (found) {
            return closestPoint.clone();
        }
        
        // Fallback: intersect with spherical ground
        const groundSphere = new Sphere(new Vector3(0, -wgs84.RADIUS, 0), wgs84.RADIUS);
        const intersectPoint = new Vector3();
        
        if (view.raycaster.ray.intersectSphere(groundSphere, intersectPoint)) {
            return intersectPoint;
        }
        
        return null;
    }
    
    /**
     * Check if mouse is over a building (for context menu)
     */
    getBuildingAtMouse(mouseX, mouseY) {
        const view = ViewMan.get("mainView");
        if (!view) return null;
        
        const mouseYUp = view.heightPx - (mouseY - view.topPx);
        const mouseRay = makeMouseRay(view, mouseX, mouseYUp);
        
        view.raycaster.setFromCamera(mouseRay, view.camera);
        view.raycaster.layers.mask = view.camera.layers.mask; // Use camera's layer mask
        
        // Check intersection with building meshes
        let closestBuilding = null;
        let closestDistance = Infinity;
        
        this.iterate((id, building) => {
            if (building.solidMesh) {
                const intersects = view.raycaster.intersectObject(building.solidMesh, false);
                if (intersects.length > 0 && intersects[0].distance < closestDistance) {
                    closestDistance = intersects[0].distance;
                    closestBuilding = building;
                }
            }
        });
        
        return closestBuilding;
    }
    
    /**
     * Serialize all buildings for saving
     */
    serialize() {
        const buildingsArray = [];
        this.iterate((id, building) => {
            buildingsArray.push(building.serialize());
        });
        
        return {
            buildings: buildingsArray,
            nextBuildingID: this.nextBuildingID
        };
    }
    
    /**
     * Deserialize buildings from save data
     */
    deserialize(data) {
        if (!data || !data.buildings) return;
        
        // Clear existing buildings
        this.clear();
        
        // Load buildings
        data.buildings.forEach(buildingData => {
            const building = CNodeSynthBuilding.deserialize(buildingData);
            
            // Note: CNodeSynthBuilding's constructor automatically adds itself to NodeMan
            
            // Add to manager using inherited CManager.add() method
            this.add(building.buildingID || building.id, building);
        });
        
        this.nextBuildingID = data.nextBuildingID || this.size() + 1;
        
        console.log(`Loaded ${this.size()} buildings`);
        setRenderOne(true);
    }
    
    /**
     * Clear all buildings
     */
    clear() {
        const ids = Object.keys(this.list);
        ids.forEach(id => {
            this.removeBuilding(id);
        });
    }
    
    /**
     * Dispose of all resources
     */
    dispose() {
        // Remove event listeners
        document.removeEventListener('pointerdown', this.onPointerDownBound);
        document.removeEventListener('pointermove', this.onPointerMoveBound);
        document.removeEventListener('pointerup', this.onPointerUpBound);
        
        // Dispose all buildings
        this.clear();
        
        if (this.creationPreviewBuilding) {
            this.creationPreviewBuilding.dispose();
        }
    }
}