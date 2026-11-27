import {bindControllerUndo} from "./ControllerUndo";
// Manager for Synthetic 3D Objects (buildings, structures, etc.)
// Handles creation, editing, deletion, and persistence

import {CManager} from "./CManager";
import {CNodeSynthBuilding} from "./nodes/CNodeSynthBuilding";
import {CNodeSynthClouds} from "./nodes/CNodeSynthClouds";
import {CNodeGroundOverlay} from "./nodes/CNodeGroundOverlay";
import {CNodeGroundRegion} from "./nodes/CNodeGroundRegion";
import {CNodeGroundGrid} from "./nodes/CNodeGroundGrid";
import {CNodeSpotlight} from "./nodes/CNodeSpotlight";
import {SpotlightField} from "./clouds/SpotlightField";
import {Globals, markSitchDirty, NodeMan, setRenderOne, UndoManager, Units} from "./Globals";
import {ViewMan} from "./CViewManager";
import {getInteractiveViewAt, setRaycasterFromView} from "./ViewUtils";
import {V3} from "./threeUtils";
import {earthCenterECEF, getLocalUpVector} from "./SphericalMath";
import {Sphere, Vector3} from "three";
import {ECEFToLLAVD_radii, LLAToECEF} from "./LLA-ECEF-ENU";
import {f2m} from "./utils";
import {raycastLocalGround} from "./raycastGround";

export class C3DSynthManager extends CManager {
    constructor() {
        super();
        this.nextBuildingID = 1;
        this.nextCloudsID = 1;
        this.nextOverlayID = 1;
        this.cloudsList = {};
        this.overlaysList = {};
        this.spotlights = new SpotlightField();
        
//        console.log("C3DSynthManager initialized");
    }
    
    /**
     * Exit all synth editing modes cleanly
     * @param {Object} [except] - Optional object to exclude from exiting (e.g., the one being edited)
     */
    exitAllEditModes(except = null) {
        if (Globals.editingTrack && Globals.editingTrack !== except) {
            Globals.editingTrack.editMode = false;
            if (Globals.editingTrack.splineEditor) {
                Globals.editingTrack.splineEditor.setEnable(false);
            }
            Globals.editingTrack = null;
        }
        if (Globals.editingBuilding && Globals.editingBuilding !== except) {
            Globals.editingBuilding.setEditMode(false);
        }
        if (Globals.editingClouds && Globals.editingClouds !== except) {
            Globals.editingClouds.setEditMode(false);
        }
        if (Globals.editingOverlay && Globals.editingOverlay !== except) {
            Globals.editingOverlay.setEditMode(false);
        }
    }
    
    // The menu, API and bulk commands all use the same saved IDs. A later
    // edit can therefore resolve the live element after a delete/undo cycle.
    bindElementControls(element) {
        const {id} = element;
        for (const control of element.guiFolder?.controllersRecursive() ?? []) {
            const key = control.property;
            if (typeof control.getValue() === "function" || key === "editMode") continue;
            // Height controls can change both roof heights. Free transform can
            // discard all four corners. Replay their geometry as one edit.
            if ((element.buildingID && control._unitType) || key === "freeTransform") {
                bindControllerUndo(control, () => element.captureState(), state => NodeMan.get(id).restoreState(state));
            } else if (element instanceof CNodeGroundGrid) {
                bindControllerUndo(control, () => element.serialize(), state => {
                    const grid = NodeMan.get(id);
                    const {id: savedID, type, ...properties} = state;
                    Object.assign(grid, properties);
                    grid.guiFolder.title("Grid: " + grid.name);
                    grid.applyColorLock();
                    grid.applyLatLonMode();
                    grid.show(grid.visible);
                    grid.updateGUIControllers();
                });
            } else {
                bindControllerUndo(control, () => control._unitType ? control.getSIValue() : control.save(), value => {
                    const live = NodeMan.get(id).guiFolder.controllersRecursive().find(c => c.property === key);
                    if (live._unitType) {
                        live.setSIValue(value);
                        live._callOnChange();
                        live._callOnFinishChange();
                    } else live.load(value);
                });
            }
        }
    }

    recordPresence(element, created) {
        const state = structuredClone(element.serialize());
        let add, remove;
        if (element.buildingID) {
            add = this.addBuilding; remove = this.removeBuilding;
        } else if (element.cloudsID) {
            add = this.addClouds; remove = this.removeClouds;
        } else {
            add = this.addOverlay; remove = this.removeOverlay;
        }
        const insert = () => add.call(this, structuredClone(state));
        const erase = () => remove.call(this, state.id);
        UndoManager?.add({description: (created ? "Create " : "Delete ") + element.name,
            undo: created ? erase : insert, redo: created ? insert : erase});
    }

    /**
     * Add a new building
     */
    addBuilding(buildingData) {
        this.exitAllEditModes();
        const id = buildingData.id || `synthBuilding_${this.nextBuildingID++}`;
        const building = new CNodeSynthBuilding({
            ...buildingData,
            id: id
        });
        
        // Note: CNodeSynthBuilding extends CNode, which automatically adds itself to NodeMan in its constructor
        
        // Add to manager using inherited CManager.add() method
        this.add(id, building);
        this.bindElementControls(building);
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
     * @param {Vector3} centerPoint - The center point on the ground (in ECEF coordinates)
     * @returns {CNodeSynthBuilding} The created building
     */
    createBuildingAtPoint(centerPoint) {
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
        if (!setRaycasterFromView(view.raycaster, view, mouseX, mouseY)) return null;
        return raycastLocalGround(view.raycaster, view.camera)?.point ?? null;
    }
    
    /**
     * Check if mouse is over a building (for context menu)
     */
    getBuildingAtMouse(mouseX, mouseY) {
        const view = getInteractiveViewAt(mouseX, mouseY);
        if (!view) return null;
        
        // Convert screen coordinates to NDC for raycasting
        setRaycasterFromView(view.raycaster, view, mouseX, mouseY);
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
    
    addSpotlight(data) {
        const projector = new CNodeSpotlight(data);
        setRenderOne(true);
        return projector;
    }

    removeSpotlight(id) {
        const projector = this.spotlights.projectors.get(id);
        if (projector) NodeMan.disposeRemove(projector);
        setRenderOne(true);
    }

    createSpotlightAtPoint(point) {
        this.exitAllEditModes();
        const {x: lat, y: lon, z: altitude} = ECEFToLLAVD_radii(point);
        let number = 1;
        while (NodeMan.exists(`spotlight_${number}`)) number++;
        const projector = this.addSpotlight({id: `spotlight_${number}`, name: `Spotlight ${number}`, lat, lon, altitude});
        const state = projector.serialize();
        UndoManager?.add({
            description: `Create ${projector.name}`,
            undo: () => this.removeSpotlight(state.id),
            redo: () => this.addSpotlight(state),
        });
        markSitchDirty();
        return projector;
    }

    deleteSpotlight(projector) {
        const state = projector.serialize();
        this.removeSpotlight(state.id);
        UndoManager?.add({
            description: `Delete ${state.name}`,
            undo: () => this.addSpotlight(state),
            redo: () => this.removeSpotlight(state.id),
        });
        markSitchDirty();
    }

    /**
     * Add a new cloud layer
     */
    addClouds(cloudsData) {
        this.exitAllEditModes();
        const id = cloudsData.id || `synthClouds_${this.nextCloudsID++}`;
        const clouds = new CNodeSynthClouds({
            ...cloudsData,
            id: id
        });
        
        this.cloudsList[id] = clouds;
        this.bindElementControls(clouds);
        console.log(`Added clouds: ${id}`);
        setRenderOne(true);
        return clouds;
    }
    
    /**
     * Remove a cloud layer
     */
    removeClouds(cloudsID) {
        if (this.cloudsList[cloudsID]) {
            const clouds = this.cloudsList[cloudsID];
            
            if (clouds.editMode || Globals.editingClouds === clouds) {
                console.log(`  Exiting edit mode for clouds ${cloudsID} before removal`);
                clouds.setEditMode(false);
            }
            
            NodeMan.disposeRemove(clouds);
            delete this.cloudsList[cloudsID];
            
            console.log(`Removed clouds: ${cloudsID}`);
            setRenderOne(true);
        }
    }
    
    /**
     * Get a cloud layer by ID
     */
    getClouds(cloudsID) {
        return this.cloudsList[cloudsID];
    }
    
    /**
     * Find a cloud layer that contains the given lat/lon point (within radius)
     * @param {number} lat - Latitude
     * @param {number} lon - Longitude
     * @returns {CNodeSynthClouds|null} The clouds at that point, or null if none
     */
    findCloudsAtLatLon(lat, lon) {
        const clickedECEF = LLAToECEF(lat, lon, 0);
        for (const id in this.cloudsList) {
            const clouds = this.cloudsList[id];
            const centerECEF = LLAToECEF(clouds.centerLat, clouds.centerLon, 0);
            const distance = clickedECEF.distanceTo(centerECEF);
            if (distance <= clouds.radius) {
                return clouds;
            }
        }
        return null;
    }
    
    /**
     * Create a cloud disk at the given ground point
     * @param {Vector3} groundPoint - The ground point (in ECEF coordinates)
     * @param {number} altitude - Altitude in meters (default 10,000 ft)
     * @returns {CNodeSynthClouds} The created cloud layer
     */
    createCloudsAtPoint(groundPoint, altitude = f2m(10000)) {
        const lla = ECEFToLLAVD_radii(groundPoint);
        
        const clouds = this.addClouds({
            centerLat: lla.x,
            centerLon: lla.y,
            altitude: altitude,
            radius: 500,
            cloudSize: 200,
            density: 0.5,
            opacity: 0.8,
            name: `Clouds ${this.nextCloudsID}`
        });
        
        console.log(`Created clouds: ${clouds.cloudsID} at ground point`);
        return clouds;
    }
    
    /**
     * Iterate over all cloud layers
     */
    iterateClouds(callback) {
        for (const id in this.cloudsList) {
            callback(id, this.cloudsList[id]);
        }
    }
    
    /**
     * Add an image overlay, ground grid or named region
     * @param {Object} overlayData - Overlay configuration
     * @param {boolean} [overlayData.gotoOnCreate] - If true, camera will go to overlay after creation
     */
    addOverlay(overlayData) {
        this.exitAllEditModes();
        const [Overlay, prefix] = overlayData.type === "grid" ? [CNodeGroundGrid, "groundGrid"]
            : overlayData.type === "region" ? [CNodeGroundRegion, "groundRegion"] : [CNodeGroundOverlay, "groundOverlay"];
        const id = overlayData.id || prefix + "_" + this.nextOverlayID++;
        const {gotoOnCreate} = overlayData;
        const overlay = new Overlay({...overlayData,id});

        this.overlaysList[id] = overlay;
        this.bindElementControls(overlay);
        console.log(`Added overlay: ${id}`);
        setRenderOne(true);
        
        if (gotoOnCreate) {
            overlay.gotoOverlay();
        }
        
        return overlay;
    }
    
    /**
     * Remove a ground overlay
     */
    removeOverlay(overlayID) {
        if (this.overlaysList[overlayID]) {
            const overlay = this.overlaysList[overlayID];
            
            if (overlay.editMode || Globals.editingOverlay === overlay) {
                console.log(`  Exiting edit mode for overlay ${overlayID} before removal`);
                overlay.setEditMode(false);
            }
            
            NodeMan.disposeRemove(overlay);
            delete this.overlaysList[overlayID];
            
            console.log(`Removed overlay: ${overlayID}`);
            setRenderOne(true);
        }
    }
    
    /**
     * Get a ground overlay by ID
     */
    getOverlay(overlayID) {
        return this.overlaysList[overlayID];
    }
    
    /**
     * Find an overlay that contains the given lat/lon point
     * @param {number} lat - Latitude
     * @param {number} lon - Longitude
     * @returns {CNodeGroundOverlay|null} The overlay at that point, or null if none
     */
    findOverlayAtLatLon(lat, lon) {
        for (const id in this.overlaysList) {
            const overlay = this.overlaysList[id];
            const {u, v} = overlay.latLonToUV(lat, lon);
            if (overlay.visible && u >= 0 && u <= 1 && v >= 0 && v <= 1) {
                return overlay;
            }
        }
        return null;
    }
    
    /**
     * Create a ground overlay at the given ground point
     * @param {Vector3} groundPoint - The ground point (in ECEF coordinates)
     * @returns {CNodeGroundOverlay} The created overlay
     */
    createOverlayAtPoint(groundPoint) {
        const lla = ECEFToLLAVD_radii(groundPoint);
        const offset = 0.01;
        
        const overlay = this.addOverlay({
            north: lla.x + offset,
            south: lla.x - offset,
            east: lla.y + offset,
            west: lla.y - offset,
            rotation: 0,
            imageURL: "",
            name: `Overlay ${this.nextOverlayID}`
        });
        
        console.log(`Created overlay: ${overlay.overlayID} at ground point`);
        return overlay;
    }

    createRegionAtPoint(groundPoint) {
        const {x: centerLat, y: centerLon} = ECEFToLLAVD_radii(groundPoint);
        return this.addOverlay({
            type: "region", centerLat, centerLon, width: 2000, height: 2000, name: `Region ${this.nextOverlayID}`,
        });
    }

    /**
     * Create a ground grid at the given ground point.
     * Defaults to 1000×1000 current small units, 100 major / 10 minor steps.
     * @param {Vector3} groundPoint - The ground point (in ECEF coordinates)
     * @returns {CNodeGroundGrid} The created grid
     */
    createGridAtPoint(groundPoint) {
        const lla = ECEFToLLAVD_radii(groundPoint);
        const s2m = Units.small2M;

        const grid = this.addOverlay({
            type: "grid",
            centerLat: lla.x,
            centerLon: lla.y,
            width: 1000 * s2m,
            height: 1000 * s2m,
            majorStep: 100 * s2m,
            minorStep: 10 * s2m,
            rotation: 0,
            name: `Grid ${this.nextOverlayID}`
        });

        console.log(`Created grid: ${grid.overlayID} at ground point`);
        return grid;
    }

    /**
     * Iterate over all ground overlays
     */
    iterateOverlays(callback) {
        for (const id in this.overlaysList) {
            callback(id, this.overlaysList[id]);
        }
    }
    
    /**
     * Serialize all buildings, clouds, and overlays for saving
     */
    serialize() {
        const buildingsArray = [];
        this.iterate((id, building) => {
            buildingsArray.push(building.serialize());
        });
        
        const cloudsArray = [];
        this.iterateClouds((id, clouds) => {
            cloudsArray.push(clouds.serialize());
        });
        
        const overlaysArray = [];
        this.iterateOverlays((id, overlay) => {
            overlaysArray.push(overlay.serialize());
        });
        
        return {
            buildings: buildingsArray,
            spotlights: Array.from(this.spotlights.projectors.values(), projector => projector.serialize()),
            nextBuildingID: this.nextBuildingID,
            clouds: cloudsArray,
            nextCloudsID: this.nextCloudsID,
            overlays: overlaysArray,
            nextOverlayID: this.nextOverlayID
        };
    }
    
    /**
     * Deserialize buildings, clouds, and overlays from save data
     */
    deserialize(data) {
        if (!data) return;
        
        this.clear();
        
        if (data.buildings) {
            data.buildings.forEach(buildingData => {
                const building = CNodeSynthBuilding.deserialize(buildingData);
                this.add(building.buildingID || building.id, building);
            });
            this.nextBuildingID = data.nextBuildingID || this.size() + 1;
            console.log(`Loaded ${this.size()} buildings`);
        }
        
        for (const projector of data.spotlights ?? []) this.addSpotlight(projector);

        if (data.clouds) {
            data.clouds.forEach(cloudsData => {
                const clouds = CNodeSynthClouds.deserialize(cloudsData);
                this.cloudsList[clouds.cloudsID] = clouds;
            });
            this.nextCloudsID = data.nextCloudsID || Object.keys(this.cloudsList).length + 1;
            console.log(`Loaded ${Object.keys(this.cloudsList).length} cloud layers`);
        }
        
        if (data.overlays) {
            data.overlays.forEach(overlayData => {
                this.addOverlay(overlayData);
            });
            this.nextOverlayID = data.nextOverlayID || Object.keys(this.overlaysList).length + 1;
            console.log(`Loaded ${Object.keys(this.overlaysList).length} overlays`);
        }
        
        setRenderOne(true);
    }
    
    /**
     * Remove every building. Snapshots IDs first because removeBuilding
     * mutates this.list, which would otherwise corrupt iteration.
     */
    removeAllBuildings(record = false) {
        const buildingIds = Object.keys(this.list);
        const remove = () => buildingIds.forEach(id => {
            if (record) this.recordPresence(this.getBuilding(id), false);
            this.removeBuilding(id);
        });
        if (record && UndoManager) UndoManager.group("Remove all buildings", remove);
        else remove();
    }

    /**
     * Clear all buildings, clouds, and overlays
     */
    clear() {
        this.removeAllBuildings();
        for (const id of this.spotlights.projectors.keys()) this.removeSpotlight(id);

        const cloudsIds = Object.keys(this.cloudsList);
        cloudsIds.forEach(id => {
            this.removeClouds(id);
        });

        const overlayIds = Object.keys(this.overlaysList);
        overlayIds.forEach(id => {
            this.removeOverlay(id);
        });
    }
    
    /**
     * Dispose of all resources
     */
    dispose() {
        document.removeEventListener('pointerdown', this.onPointerDownBound);
        document.removeEventListener('pointermove', this.onPointerMoveBound);
        document.removeEventListener('pointerup', this.onPointerUpBound);
        
        this.clear();
        
        if (this.creationPreviewBuilding) {
            this.creationPreviewBuilding.dispose();
        }
    }
}
